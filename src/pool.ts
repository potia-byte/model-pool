import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "./atomic-file.js";
import {
  extractDiscoveredModels,
  type ModelCatalog,
  type ProviderConfig,
  resolveProviderModels,
} from "./catalog.js";
import {
  chatCompletion,
  type FetchLike,
  getJson,
  type TransportFailure,
} from "./client.js";
import { type Effort, poolEffortBody } from "./effort.js";
import { classifyProviderFailure } from "./errors.js";
import { HealthBook } from "./health.js";
import {
  DEFAULT_POOL_POLICY,
  type PoolCandidate,
  type PoolPolicy,
  type PoolRequirements,
  type PoolRoutingDecision,
  requirementsForRole,
  routePool,
} from "./router.js";
import { createRedactor, type Redactor } from "./secrets.js";
import {
  type FailureCategory,
  type PoolHealthState,
  type PoolModel,
  type PoolRole,
  type ProviderFailure,
  poolModelKey,
} from "./types.js";

export const MODEL_POOL_FILE = "model-pool.json";
/** Default directory (under the pool root) that holds the persisted state. */
export const DEFAULT_STATE_DIRECTORY = ".model-pool";

/** Total provider calls one request may spend walking the pool. */
const MAX_ATTEMPTS = 16;
/** A malformed request fails identically everywhere; stop rather than fan out. */
const MAX_REJECTED_REQUESTS = 3;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const VALIDATION_TIMEOUT_MS = 30_000;
const VALIDATION_MAX_TOKENS = 16;
const CHARS_PER_TOKEN = 3;
/** "max tokens must be less than or equal to 4096", "supports at most 8192 ...". */
const OUTPUT_LIMIT =
  /(?:less than or equal to|at most|maximum(?: output)?(?: length| tokens)?(?: of| is)?|limit(?:ed)? (?:of|to))\s*(\d{3,6})/i;

export interface PoolStore {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

export function createFileStore(
  root: string,
  directory: string = DEFAULT_STATE_DIRECTORY,
): PoolStore {
  const path = join(root, directory, MODEL_POOL_FILE);
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    async save(value) {
      await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

const tier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const persistedModel = z.object({
  provider: z.string(),
  model: z.string(),
  pricing: z.enum(["free", "free_tier", "paid", "unknown"]),
  effortControl: z
    .enum(["reasoning_effort", "openrouter_reasoning"])
    .optional(),
  source: z.enum(["discovered", "configured"]),
  capabilities: z.object({
    contextWindow: z.number().nullable(),
    toolCalling: z.boolean().nullable(),
    structuredOutput: z.boolean().nullable(),
    coding: tier,
    reasoning: tier,
  }),
});
const validationRowSchema = z.object({
  provider: z.string(),
  displayName: z.string(),
  configured: z.boolean(),
  authOk: z.boolean(),
  freeModelReachable: z.boolean(),
  status: z.string(),
  model: z.string().nullable(),
  notes: z.string(),
  at: z.string(),
});
const persistedSchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  health: z.unknown(),
  models: z.array(persistedModel),
  unclassified: z.record(z.string(), z.number()),
  selected: z
    .object({ provider: z.string(), model: z.string(), at: z.string() })
    .nullable(),
  lastFallback: z
    .object({
      at: z.string(),
      from: z.string(),
      to: z.string(),
      reason: z.string(),
    })
    .nullable(),
  validation: z.record(z.string(), validationRowSchema),
});

export type ValidationRow = z.infer<typeof validationRowSchema>;

export type ProviderDisplayState =
  | PoolHealthState
  | "NOT_CONFIGURED"
  | "UNVERIFIED";

export interface ProviderSnapshot {
  id: string;
  displayName: string;
  configured: boolean;
  state: ProviderDisplayState;
  totalModels: number;
  /** Allowed by policy and graded, regardless of current health. */
  eligibleModels: number;
  /** Eligible and currently AVAILABLE. */
  usableModels: number;
  retryAfter: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCategory: string | null;
  consecutiveFailures: number;
}

export interface PoolSnapshot {
  updatedAt: string | null;
  providers: ProviderSnapshot[];
  configured: string[];
  available: string[];
  temporarilyUnavailable: string[];
  usableModels: number;
  selected: { provider: string; model: string } | null;
  lastFallback: { at: string; from: string; to: string; reason: string } | null;
}

export interface PoolCapacity {
  usable: number;
  exhaustedByCapacity: boolean;
  earliestRetryAt: string | null;
  reason: string;
}

export interface PoolCompletionRequest {
  role: PoolRole;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  requirements?: Partial<Omit<PoolRequirements, "role">>;
  /**
   * `provider/model` routes to prefer not to use (e.g. the models that wrote
   * the code under review). Soft: used only if nothing else is compatible.
   */
  avoid?: readonly string[];
  signal?: AbortSignal;
}

export interface PoolAttempt {
  provider: string;
  model: string;
  outcome: "success" | FailureCategory;
  message: string | null;
  retryAfter: string | null;
}

export type PoolCompletion =
  | {
      ok: true;
      text: string;
      provider: string;
      model: string;
      /** The model an aggregator says actually answered, when reported. */
      actualModel: string | null;
      upstreamProvider: string | null;
      usage: { inputTokens: number; outputTokens: number } | null;
      attempts: PoolAttempt[];
    }
  | {
      ok: false;
      reason:
        | "no_compatible_provider"
        | "all_exhausted"
        | "request_rejected"
        | "attempt_limit"
        | "aborted";
      message: string;
      earliestRetryAt: string | null;
      attempts: PoolAttempt[];
    };

export type PoolCallResult =
  | {
      ok: true;
      text: string;
      provider: string;
      model: string;
      actualModel: string | null;
      upstreamProvider: string | null;
      usage: { inputTokens: number; outputTokens: number } | null;
      /** False when the provider has no effort control or rejected the setting. */
      effortApplied: boolean;
    }
  | { ok: false; failure: ProviderFailure; retryAfter: string | null };

export interface ModelPoolOptions {
  /** Directory under which the state file is kept (see `stateDirectory`). */
  root: string;
  /** State directory relative to `root`. Default `.model-pool`. */
  stateDirectory?: string;
  catalog: ModelCatalog;
  /** Key values live here only; nothing derived from them is persisted. */
  env: Readonly<Record<string, string>>;
  fetch?: FetchLike;
  now?: () => Date;
  policy?: Partial<PoolPolicy>;
  store?: PoolStore;
  log?: (line: string) => void | Promise<void>;
}

const BLOCKING_PRIORITY: PoolHealthState[] = [
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "TEMPORARY_ERROR",
  "UNAVAILABLE",
];

export class ModelPool {
  private readonly catalog: ModelCatalog;
  private readonly env: Readonly<Record<string, string>>;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly policy: PoolPolicy;
  private readonly store: PoolStore | null;
  private readonly logSink:
    | ((line: string) => void | Promise<void>)
    | undefined;
  private readonly redact: Redactor;

  private health = new HealthBook();
  private models = new Map<string, PoolModel[]>();
  private unclassified = new Map<string, number>();
  private selected: PoolSnapshotSelected | null = null;
  private lastFallback: PoolSnapshot["lastFallback"] = null;
  private validation = new Map<string, ValidationRow>();
  private quotaFraction = new Map<string, number>();
  /** Models whose provider rejected the effort setting; not sent again. */
  private noEffort = new Set<string>();
  /** Per-model maximum output tokens learned from a provider's rejection. */
  private maxOutputTokens = new Map<string, number>();
  private accountIds = new Map<string, string>();
  private updatedAt: string | null = null;

  constructor(options: ModelPoolOptions) {
    this.catalog = options.catalog;
    this.env = options.env;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.policy = { ...DEFAULT_POOL_POLICY, ...options.policy };
    this.store =
      options.store ??
      createFileStore(options.root, options.stateDirectory);
    this.logSink = options.log;
    const secrets: string[] = [];
    for (const config of Object.values(options.catalog.providers)) {
      for (const name of config.envKeys) {
        const value = options.env[name];
        if (value) secrets.push(value);
      }
    }
    for (const [name, value] of Object.entries(options.env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) secrets.push(value);
    }
    this.redact = createRedactor(secrets);
  }

  // ---- configuration ------------------------------------------------------

  private keyFor(id: string): string | null {
    const config = this.catalog.providers[id];
    if (!config) return null;
    for (const name of config.envKeys) {
      const value = this.env[name];
      if (value && value.trim() !== "") return value.trim();
    }
    return null;
  }

  isConfigured(id: string): boolean {
    return (
      this.catalog.providers[id]?.enabled !== false && this.keyFor(id) !== null
    );
  }

  private providerIds(): string[] {
    return Object.keys(this.catalog.providers).sort();
  }

  private async note(line: string): Promise<void> {
    try {
      await this.logSink?.(this.redact(line));
    } catch {
      // Logging must never break routing.
    }
  }

  // ---- persistence --------------------------------------------------------

  async load(): Promise<void> {
    let raw: unknown = null;
    try {
      raw = await this.store?.load();
    } catch {
      raw = null;
    }
    const parsed = persistedSchema.safeParse(raw);
    if (!parsed.success) return;
    const data = parsed.data;
    this.health = HealthBook.fromJSON(data.health);
    this.models = new Map();
    for (const { effortControl, ...model } of data.models) {
      const list = this.models.get(model.provider) ?? [];
      list.push(effortControl ? { ...model, effortControl } : model);
      this.models.set(model.provider, list);
    }
    this.unclassified = new Map(Object.entries(data.unclassified));
    this.selected = data.selected;
    this.lastFallback = data.lastFallback;
    this.validation = new Map(Object.entries(data.validation));
    this.updatedAt = data.updated_at;
  }

  private async persist(): Promise<void> {
    this.updatedAt = this.now().toISOString();
    try {
      await this.store?.save({
        version: 1,
        updated_at: this.updatedAt,
        health: this.health.toJSON(),
        models: [...this.models.values()].flat(),
        unclassified: Object.fromEntries(this.unclassified),
        selected: this.selected,
        lastFallback: this.lastFallback,
        validation: Object.fromEntries(this.validation),
      });
    } catch (error) {
      await this.note(
        `model-pool: state persistence failed: ${this.redact(error)}`,
      );
    }
  }

  // ---- endpoints ----------------------------------------------------------

  private async baseUrlFor(
    id: string,
    config: ProviderConfig,
    key: string,
  ): Promise<
    { ok: true; baseUrl: string } | { ok: false; failure: ProviderFailure }
  > {
    let url = config.baseUrl;
    for (const match of config.baseUrl.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      const name = match[1] ?? "";
      let value: string | undefined = this.env[name] || this.accountIds.get(id);
      if (!value && config.accountLookupUrl) {
        const lookup = await getJson({
          url: config.accountLookupUrl,
          apiKey: key,
          timeoutMs: DISCOVERY_TIMEOUT_MS,
          fetch: this.fetchImpl,
        });
        if (!lookup.ok) {
          return { ok: false, failure: this.classify(lookup) };
        }
        const result = (lookup.body as { result?: Array<{ id?: unknown }> })
          .result;
        const ids = (result ?? [])
          .map((account) => account.id)
          .filter(
            (accountId): accountId is string => typeof accountId === "string",
          );
        if (ids.length !== 1 || !ids[0]) {
          return {
            ok: false,
            failure: {
              category: "unknown_error",
              retryAfterMs: null,
              status: null,
              message: `Could not pick an account automatically (${ids.length} found); set ${name}.`,
            },
          };
        }
        value = ids[0];
        this.accountIds.set(id, value);
      }
      if (!value) {
        return {
          ok: false,
          failure: {
            category: "unknown_error",
            retryAfterMs: null,
            status: null,
            message: `Missing ${name}.`,
          },
        };
      }
      url = url.replace(match[0], value);
    }
    return { ok: true, baseUrl: url };
  }

  private classify(failure: TransportFailure): ProviderFailure {
    return classifyProviderFailure(failure.raw, {
      now: this.now(),
      redact: this.redact,
    });
  }

  // ---- discovery ----------------------------------------------------------

  /** Refreshes model lists for every configured provider (or one). A listing
   * costs no tokens. Failures update health and never throw. */
  async refresh(only?: string): Promise<void> {
    for (const id of this.providerIds()) {
      if (only && id !== only) continue;
      if (this.isConfigured(id)) await this.refreshProvider(id);
    }
    await this.persist();
  }

  /** Returns whether the provider answered at all (i.e. authenticated or at
   * least reachable) and the classified failure, if any. */
  private async refreshProvider(
    id: string,
  ): Promise<{ responded: boolean; failure: ProviderFailure | null }> {
    const config = this.catalog.providers[id];
    const key = this.keyFor(id);
    if (!config || !key) return { responded: false, failure: null };
    const now = this.now();

    const base = await this.baseUrlFor(id, config, key);
    if (!base.ok) {
      this.health.recordFailure(id, "(config)", base.failure, now);
      await this.note(`model-pool: ${id} unavailable: ${base.failure.message}`);
      this.useStaticModelsIfEmpty(id, config);
      return { responded: false, failure: base.failure };
    }

    if (config.discovery === "none") {
      this.applyModels(id, config, []);
      return { responded: true, failure: null };
    }

    const listing = await getJson({
      url: new URL(
        config.discoveryPath.replace(/^\/+/, ""),
        `${base.baseUrl.replace(/\/+$/, "")}/`,
      ).toString(),
      apiKey: key,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      fetch: this.fetchImpl,
    });
    if (!listing.ok) {
      const failure = this.classify(listing);
      this.health.recordFailure(id, "(discovery)", failure, now);
      await this.note(
        `model-pool: ${id} model discovery failed (${failure.category}): ${failure.message}`,
      );
      this.useStaticModelsIfEmpty(id, config);
      return { responded: listing.raw.status !== null, failure };
    }

    this.health.clearAuthError(id);
    this.applyModels(
      id,
      config,
      extractDiscoveredModels(
        listing.body,
        config.stripPrefix ? { stripPrefix: config.stripPrefix } : {},
      ),
    );
    return { responded: true, failure: null };
  }

  private applyModels(
    id: string,
    config: ProviderConfig,
    discovered: Parameters<typeof resolveProviderModels>[2],
  ): void {
    const { models, unclassified } = resolveProviderModels(
      id,
      config,
      discovered,
    );
    this.models.set(id, models);
    this.unclassified.set(id, unclassified);
  }

  private useStaticModelsIfEmpty(id: string, config: ProviderConfig): void {
    if (
      (this.models.get(id)?.length ?? 0) === 0 &&
      config.staticModels.length > 0
    ) {
      this.applyModels(id, config, []);
    }
  }

  // ---- routing ------------------------------------------------------------

  private policyEligible(model: PoolModel): boolean {
    const paidLike = model.pricing === "paid" || model.pricing === "unknown";
    if (
      paidLike ? !this.policy.allowPaidApiSpend : !this.policy.allowFreeModels
    ) {
      return false;
    }
    return model.capabilities.coding > 0 || model.capabilities.reasoning > 0;
  }

  /** Every configured model with its live health, for external routers. */
  routingCandidates(now: Date): PoolCandidate[] {
    return this.candidates(now);
  }

  private candidates(now: Date): PoolCandidate[] {
    const result: PoolCandidate[] = [];
    for (const [id, models] of this.models) {
      if (!this.isConfigured(id)) continue;
      for (const model of models) {
        const record = this.health.record(id, model.model);
        const providerRecord = this.health.record(id);
        const stateOptions = this.policy.disabledProviders
          ? { disabledProviders: this.policy.disabledProviders }
          : {};
        const { effortControl: _effort, ...withoutEffort } = model;
        result.push({
          model: this.noEffort.has(poolModelKey(model)) ? withoutEffort : model,
          state: this.health.stateOf(id, model.model, now, stateOptions),
          retryAfter: this.health.retryAfterOf(id, model.model, now),
          avgLatencyMs:
            record?.avgLatencyMs ?? providerRecord?.avgLatencyMs ?? null,
          proven: (record?.lastSuccessAt ?? null) !== null,
          quotaRemainingFraction:
            this.quotaFraction.get(poolModelKey(model)) ?? null,
        });
      }
    }
    return result;
  }

  private decide(
    requirements: PoolRequirements,
    now: Date,
    exclude?: ReadonlySet<string>,
  ): PoolRoutingDecision {
    return routePool(
      requirements,
      this.candidates(now),
      this.policy,
      now,
      exclude ? { exclude } : {},
    );
  }

  /** What the pool could serve right now, for the quota-wait decision. */
  capacity(
    role: PoolRole,
    overrides: Partial<Omit<PoolRequirements, "role">> = {},
  ): PoolCapacity {
    const decision = this.decide(
      requirementsForRole(role, overrides),
      this.now(),
    );
    return {
      usable: decision.ranked.length,
      exhaustedByCapacity: decision.exhaustedByCapacity,
      earliestRetryAt: decision.earliestRetryAt,
      reason: decision.reason,
    };
  }

  async complete(request: PoolCompletionRequest): Promise<PoolCompletion> {
    if (request.avoid && request.avoid.length > 0) {
      const preferred = await this.completeInner(
        request,
        new Set(request.avoid),
      );
      if (preferred.ok || preferred.reason !== "no_compatible_provider")
        return preferred;
    }
    return this.completeInner(request, new Set());
  }

  private async completeInner(
    request: PoolCompletionRequest,
    avoided: ReadonlySet<string>,
  ): Promise<PoolCompletion> {
    if (
      this.models.size === 0 &&
      this.providerIds().some((id) => this.isConfigured(id))
    ) {
      await this.refresh();
    }
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const requirements = requirementsForRole(request.role, {
      minContextTokens:
        Math.ceil(request.prompt.length / CHARS_PER_TOKEN) + maxTokens,
      ...request.requirements,
    });
    const attempts: PoolAttempt[] = [];
    const tried = new Set<string>(avoided);
    let rejectedRequests = 0;
    let lastFailed: { key: string; category: FailureCategory } | null = null;

    for (let step = 0; step < MAX_ATTEMPTS; step += 1) {
      if (request.signal?.aborted) {
        return this.failed("aborted", "Aborted by the caller.", null, attempts);
      }
      const now = this.now();
      const decision = this.decide(requirements, now, tried);
      const candidate = decision.selected;
      if (!candidate) {
        return this.failed(
          decision.exhaustedByCapacity
            ? "all_exhausted"
            : "no_compatible_provider",
          decision.reason,
          decision.earliestRetryAt,
          attempts,
        );
      }
      const { provider, model } = candidate.model;
      const key = poolModelKey(candidate.model);
      tried.add(key);

      const config = this.catalog.providers[provider];
      const apiKey = this.keyFor(provider);
      if (!config || !apiKey) continue;
      const base = await this.baseUrlFor(provider, config, apiKey);
      if (!base.ok) {
        this.health.recordFailure(provider, "(config)", base.failure, now);
        attempts.push(this.attemptOf(provider, model, base.failure));
        lastFailed = { key, category: base.failure.category };
        continue;
      }

      const started = this.now().getTime();
      const outcome = await chatCompletion({
        baseUrl: base.baseUrl,
        apiKey,
        model,
        prompt: request.prompt,
        maxTokens,
        timeoutMs: request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        signal: request.signal,
        fetch: this.fetchImpl,
      });

      if (outcome.ok && outcome.text.trim() !== "") {
        const finished = this.now();
        this.health.recordSuccess(
          provider,
          model,
          finished.getTime() - started,
          finished,
        );
        if (outcome.quotaRemainingFraction !== null) {
          this.quotaFraction.set(key, outcome.quotaRemainingFraction);
        }
        attempts.push({
          provider,
          model,
          outcome: "success",
          message: null,
          retryAfter: null,
        });
        this.selected = { provider, model, at: finished.toISOString() };
        if (lastFailed) {
          this.lastFallback = {
            at: finished.toISOString(),
            from: lastFailed.key,
            to: key,
            reason: lastFailed.category,
          };
          await this.note(
            `model-pool: fell back ${lastFailed.key} -> ${key} (${lastFailed.category}).`,
          );
        }
        await this.persist();
        return {
          ok: true,
          text: outcome.text,
          provider,
          model,
          actualModel: outcome.actualModel,
          upstreamProvider: outcome.upstreamProvider,
          usage: outcome.usage,
          attempts,
        };
      }

      const failure: ProviderFailure = outcome.ok
        ? {
            category: "temporary_error",
            retryAfterMs: null,
            status: 200,
            message: "Provider returned an empty completion.",
          }
        : this.classify(outcome);
      this.health.recordFailure(provider, model, failure, this.now());
      attempts.push(this.attemptOf(provider, model, failure));
      await this.note(
        `model-pool: ${key} failed (${failure.category}): ${failure.message}`,
      );
      if (failure.category === "bad_request") {
        rejectedRequests += 1;
        if (rejectedRequests >= MAX_REJECTED_REQUESTS) {
          await this.persist();
          return this.failed(
            "request_rejected",
            `${rejectedRequests} providers rejected the request itself; not trying the rest of the pool.`,
            null,
            attempts,
          );
        }
      } else {
        lastFailed = { key, category: failure.category };
      }
      await this.persist();
    }
    return this.failed(
      "attempt_limit",
      `Gave up after ${MAX_ATTEMPTS} provider calls.`,
      null,
      attempts,
    );
  }

  /**
   * One call to one specific model, for callers (e.g. an external orchestrator)
   * that choose the model themselves and handle rerouting themselves. Health
   * is updated exactly as in `complete`; there is no fallback here.
   */
  async completeOn(
    target: { provider: string; model: string },
    request: {
      prompt: string;
      maxTokens?: number;
      timeoutMs?: number;
      effort?: Effort;
      signal?: AbortSignal | undefined;
    },
  ): Promise<PoolCallResult> {
    const { provider, model: modelId } = target;
    const key = `${provider}/${modelId}`;
    const refuse = (message: string): PoolCallResult => ({
      ok: false,
      failure: {
        category: "model_unsupported",
        retryAfterMs: null,
        status: null,
        message,
      },
      retryAfter: null,
    });
    const model = (this.models.get(provider) ?? []).find(
      (item) => item.model === modelId,
    );
    const config = this.catalog.providers[provider];
    const apiKey = this.keyFor(provider);
    if (!model || !config || !apiKey || !this.isConfigured(provider)) {
      return refuse(`${key} is not in the pool`);
    }
    if (
      !this.policyEligible(model) ||
      this.policy.disabledProviders?.has(provider)
    ) {
      return refuse(
        `${key} is not permitted by policy (paid spend is disabled)`,
      );
    }
    const base = await this.baseUrlFor(provider, config, apiKey);
    if (!base.ok) {
      this.health.recordFailure(provider, "(config)", base.failure, this.now());
      return {
        ok: false,
        failure: base.failure,
        retryAfter: this.health.retryAfterOf(provider, modelId, this.now()),
      };
    }

    const control = this.noEffort.has(key) ? undefined : model.effortControl;
    const call = (
      extraBody: Record<string, unknown> | undefined,
      maxTokens: number,
    ) =>
      chatCompletion({
        baseUrl: base.baseUrl,
        apiKey,
        model: modelId,
        prompt: request.prompt,
        maxTokens,
        timeoutMs: request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        extraBody,
        signal: request.signal,
        fetch: this.fetchImpl,
      });

    const started = this.now().getTime();
    let extraBody =
      request.effort && control
        ? poolEffortBody(control, request.effort)
        : undefined;
    let maxTokens = Math.min(
      request.maxTokens ?? DEFAULT_MAX_TOKENS,
      this.maxOutputTokens.get(key) ?? Number.POSITIVE_INFINITY,
    );
    let outcome = await call(extraBody, maxTokens);
    // A malformed-request rejection can often be fixed once: drop an effort
    // setting the provider does not know, or lower max_tokens to its limit.
    for (let fixes = 0; !outcome.ok && fixes < 2; fixes += 1) {
      const failure = this.classify(outcome);
      if (failure.category !== "bad_request") break;
      const limit = OUTPUT_LIMIT.exec(failure.message)?.[1];
      if (limit && Number(limit) < maxTokens) {
        maxTokens = Number(limit);
        this.maxOutputTokens.set(key, maxTokens);
        await this.note(
          `model-pool: ${key} allows at most ${maxTokens} output tokens; retrying within that.`,
        );
        outcome = await call(extraBody, maxTokens);
      } else if (
        extraBody &&
        /reason|effort|unknown|unsupported|not permitted|extra|parameter|field/i.test(
          failure.message,
        )
      ) {
        // The provider does not accept the setting: remember, report honestly, retry plainly.
        this.noEffort.add(key);
        await this.note(
          `model-pool: ${key} rejected the effort setting; continuing without it.`,
        );
        extraBody = undefined;
        outcome = await call(undefined, maxTokens);
      } else {
        break;
      }
    }

    if (outcome.ok) {
      const finished = this.now();
      this.health.recordSuccess(
        provider,
        modelId,
        finished.getTime() - started,
        finished,
      );
      if (outcome.quotaRemainingFraction !== null)
        this.quotaFraction.set(key, outcome.quotaRemainingFraction);
      await this.persist();
      return {
        ok: true,
        text: outcome.text,
        provider,
        model: modelId,
        actualModel: outcome.actualModel,
        upstreamProvider: outcome.upstreamProvider,
        usage: outcome.usage,
        effortApplied: extraBody !== undefined,
      };
    }
    const failure = this.classify(outcome);
    this.health.recordFailure(provider, modelId, failure, this.now());
    await this.persist();
    return {
      ok: false,
      failure,
      retryAfter: this.health.retryAfterOf(provider, modelId, this.now()),
    };
  }

  private attemptOf(
    provider: string,
    model: string,
    failure: ProviderFailure,
  ): PoolAttempt {
    const retryAfter = this.health.retryAfterOf(provider, model, this.now());
    return {
      provider,
      model,
      outcome: failure.category,
      message: failure.message,
      retryAfter,
    };
  }

  private failed(
    reason: Extract<PoolCompletion, { ok: false }>["reason"],
    message: string,
    earliestRetryAt: string | null,
    attempts: PoolAttempt[],
  ): PoolCompletion {
    return {
      ok: false,
      reason,
      message: this.redact(message),
      earliestRetryAt,
      attempts,
    };
  }

  // ---- validation ---------------------------------------------------------

  /**
   * The smallest possible live check per provider: a free model listing to
   * prove the key, then one 16-token completion against a free model. Never
   * sends a request to a model that could be metered.
   */
  async validate(): Promise<ValidationRow[]> {
    const rows: ValidationRow[] = [];
    for (const id of this.providerIds()) {
      const config = this.catalog.providers[id];
      if (!config) continue;
      const at = this.now().toISOString();
      const base = { provider: id, displayName: config.displayName, at };
      if (!this.isConfigured(id)) {
        rows.push({
          ...base,
          configured: false,
          authOk: false,
          freeModelReachable: false,
          status: "NOT_CONFIGURED",
          model: null,
          notes: "no API key configured",
        });
        continue;
      }
      const row = await this.validateProvider(id, config, base);
      this.validation.set(id, row);
      rows.push(row);
    }
    await this.persist();
    return rows;
  }

  private async validateProvider(
    id: string,
    config: ProviderConfig,
    base: { provider: string; displayName: string; at: string },
  ): Promise<ValidationRow> {
    const listed = await this.refreshProvider(id);
    const authFailed = listed.failure?.category === "auth_error";
    const now = this.now();
    if (authFailed || (!listed.responded && listed.failure)) {
      return {
        ...base,
        configured: true,
        authOk: false,
        freeModelReachable: false,
        status: authFailed ? "AUTH_ERROR" : this.providerState(id, now),
        model: null,
        notes: listed.failure?.message ?? "provider unreachable",
      };
    }

    const eligible = (this.models.get(id) ?? []).filter(
      (model) =>
        (model.pricing === "free" || model.pricing === "free_tier") &&
        this.policyEligible(model),
    );
    if (eligible.length === 0) {
      return {
        ...base,
        configured: true,
        authOk: true,
        freeModelReachable: false,
        status: "UNAVAILABLE",
        model: null,
        notes:
          "no free model available; every model is paid or ungraded, so the paid request was skipped (billing required)",
      };
    }
    const target =
      eligible.find((model) => model.model === config.validationModel) ??
      [...eligible].sort(
        (left, right) =>
          left.capabilities.coding +
            left.capabilities.reasoning -
            (right.capabilities.coding + right.capabilities.reasoning) ||
          left.model.localeCompare(right.model),
      )[0];
    if (!target) {
      return {
        ...base,
        configured: true,
        authOk: true,
        freeModelReachable: false,
        status: "UNAVAILABLE",
        model: null,
        notes: "no free model available",
      };
    }

    const apiKey = this.keyFor(id) ?? "";
    const endpoint = await this.baseUrlFor(id, config, apiKey);
    if (!endpoint.ok) {
      return {
        ...base,
        configured: true,
        authOk: true,
        freeModelReachable: false,
        status: "UNAVAILABLE",
        model: target.model,
        notes: endpoint.failure.message,
      };
    }
    const started = this.now().getTime();
    const outcome = await chatCompletion({
      baseUrl: endpoint.baseUrl,
      apiKey,
      model: target.model,
      prompt: "Reply with the single word OK.",
      maxTokens: VALIDATION_MAX_TOKENS,
      timeoutMs: VALIDATION_TIMEOUT_MS,
      fetch: this.fetchImpl,
    });
    if (outcome.ok) {
      const finished = this.now();
      this.health.recordSuccess(
        id,
        target.model,
        finished.getTime() - started,
        finished,
      );
      return {
        ...base,
        configured: true,
        authOk: true,
        freeModelReachable: true,
        status: "AVAILABLE",
        model: target.model,
        notes: `${target.pricing} model answered a ${VALIDATION_MAX_TOKENS}-token request`,
      };
    }
    const failure = this.classify(outcome);
    this.health.recordFailure(id, target.model, failure, this.now());
    return {
      ...base,
      configured: true,
      authOk: failure.category !== "auth_error",
      freeModelReachable: false,
      status: this.providerState(id, this.now()),
      model: target.model,
      notes: `${failure.category}: ${failure.message}`,
    };
  }

  // ---- status -------------------------------------------------------------

  private providerState(id: string, now: Date): ProviderDisplayState {
    if (!this.isConfigured(id)) return "NOT_CONFIGURED";
    if (this.policy.disabledProviders?.has(id)) return "DISABLED";
    const stateOptions = this.policy.disabledProviders
      ? { disabledProviders: this.policy.disabledProviders }
      : {};
    if (this.health.stateOf(id, "", now, stateOptions) === "AUTH_ERROR") {
      return "AUTH_ERROR";
    }
    const models = this.models.get(id) ?? [];
    if (models.length === 0) {
      const provider = this.health.stateOf(id, "", now, stateOptions);
      return provider === "AVAILABLE" ? "UNVERIFIED" : provider;
    }
    const eligible = models.filter((model) => this.policyEligible(model));
    if (eligible.length === 0) return "UNAVAILABLE";
    const states = eligible.map((model) =>
      this.health.stateOf(id, model.model, now, stateOptions),
    );
    if (states.includes("AVAILABLE")) return "AVAILABLE";
    return (
      BLOCKING_PRIORITY.find((state) => states.includes(state)) ?? "UNAVAILABLE"
    );
  }

  snapshot(): PoolSnapshot {
    const now = this.now();
    const stateOptions = this.policy.disabledProviders
      ? { disabledProviders: this.policy.disabledProviders }
      : {};
    const providers: ProviderSnapshot[] = this.providerIds().map((id) => {
      const config = this.catalog.providers[id] as ProviderConfig;
      const configured = this.isConfigured(id);
      const models = configured ? (this.models.get(id) ?? []) : [];
      const eligible = models.filter((model) => this.policyEligible(model));
      const usable = eligible.filter(
        (model) =>
          this.health.stateOf(id, model.model, now, stateOptions) ===
          "AVAILABLE",
      );
      const state = this.providerState(id, now);
      const record = this.health.record(id);
      const blocked = eligible
        .map((model) => this.health.retryAfterOf(id, model.model, now))
        .filter((value): value is string => value !== null)
        .sort();
      const modelRecords = eligible
        .map((model) => this.health.record(id, model.model))
        .filter((value) => value !== undefined);
      const lastSuccess = [
        record?.lastSuccessAt,
        ...modelRecords.map((r) => r?.lastSuccessAt),
      ]
        .filter((value): value is string => typeof value === "string")
        .sort()
        .at(-1);
      const lastFailure = [
        record?.lastFailureAt,
        ...modelRecords.map((r) => r?.lastFailureAt),
      ]
        .filter((value): value is string => typeof value === "string")
        .sort()
        .at(-1);
      const failing = modelRecords.find((r) => r?.failureCategory) ?? record;
      return {
        id,
        displayName: config.displayName,
        configured,
        state,
        totalModels: models.length,
        eligibleModels: eligible.length,
        usableModels: usable.length,
        retryAfter:
          state === "AVAILABLE" || state === "NOT_CONFIGURED"
            ? null
            : (this.health.retryAfterOf(id, "", now) ?? blocked[0] ?? null),
        lastSuccessAt: lastSuccess ?? null,
        lastFailureAt: lastFailure ?? null,
        failureCategory: failing?.failureCategory ?? null,
        consecutiveFailures: Math.max(
          record?.consecutiveFailures ?? 0,
          ...modelRecords.map((r) => r?.consecutiveFailures ?? 0),
        ),
      };
    });
    const configured = providers.filter((p) => p.configured);
    return {
      updatedAt: this.updatedAt,
      providers,
      configured: configured.map((p) => p.id),
      available: configured
        .filter((p) => p.state === "AVAILABLE")
        .map((p) => p.id),
      temporarilyUnavailable: configured
        .filter((p) => (BLOCKING_PRIORITY as string[]).includes(p.state))
        .map((p) => p.id),
      usableModels: providers.reduce((sum, p) => sum + p.usableModels, 0),
      selected: this.selected
        ? { provider: this.selected.provider, model: this.selected.model }
        : null,
      lastFallback: this.lastFallback,
    };
  }

  /** Last validation results, for status output without a network call. */
  validationRows(): ValidationRow[] {
    return [...this.validation.values()];
  }
}

interface PoolSnapshotSelected {
  provider: string;
  model: string;
  at: string;
}

export function createModelPool(options: ModelPoolOptions): ModelPool {
  return new ModelPool(options);
}
