import { z } from "zod";
import type {
  FailureCategory,
  PoolHealthState,
  ProviderFailure,
} from "./types.js";

const RATE_LIMIT_BASE_MS = 30_000;
const RATE_LIMIT_MAX_MS = 15 * 60_000;
const TEMPORARY_BASE_MS = 10_000;
const TEMPORARY_MAX_MS = 10 * 60_000;
const UNAVAILABLE_AFTER_FAILURES = 5;
const UNAVAILABLE_RETRY_MS = 15 * 60_000;
/** Free-tier resets are usually daily; a re-check is one cheap failed call. */
const QUOTA_DEFAULT_RESET_MS = 60 * 60_000;
const UNSUPPORTED_MODEL_RETRY_MS = 24 * 60 * 60_000;
const LATENCY_SMOOTHING = 0.3;

const stateSchema = z.enum([
  "AVAILABLE",
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "AUTH_ERROR",
  "TEMPORARY_ERROR",
  "UNAVAILABLE",
  "DISABLED",
]);

const recordSchema = z.object({
  state: stateSchema,
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  failureCategory: z.string().nullable(),
  lastError: z.string().nullable(),
  retryAfter: z.string().nullable(),
  quotaResetAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  avgLatencyMs: z.number().nullable(),
});

const persistedSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), recordSchema),
  models: z.record(z.string(), recordSchema),
});

/** Runtime health for one provider or one provider/model pair. Contains no
 * credentials: `lastError` is the already-redacted, length-bounded message. */
export type HealthRecord = z.infer<typeof recordSchema>;
export type PersistedHealth = z.infer<typeof persistedSchema>;

export interface StateOfOptions {
  disabledProviders?: ReadonlySet<string>;
}

function emptyRecord(): HealthRecord {
  return {
    state: "AVAILABLE",
    lastSuccessAt: null,
    lastFailureAt: null,
    failureCategory: null,
    lastError: null,
    retryAfter: null,
    quotaResetAt: null,
    consecutiveFailures: 0,
    avgLatencyMs: null,
  };
}

function backoff(base: number, cap: number, failures: number): number {
  return Math.min(base * 2 ** Math.max(0, failures - 1), cap);
}

export class HealthBook {
  private providers = new Map<string, HealthRecord>();
  private models = new Map<string, HealthRecord>();

  static fromJSON(value: unknown): HealthBook {
    const book = new HealthBook();
    const parsed = persistedSchema.safeParse(value);
    if (!parsed.success) return book;
    for (const [key, record] of Object.entries(parsed.data.providers)) {
      book.providers.set(key, record);
    }
    for (const [key, record] of Object.entries(parsed.data.models)) {
      book.models.set(key, record);
    }
    return book;
  }

  toJSON(): PersistedHealth {
    return {
      version: 1,
      providers: Object.fromEntries(
        [...this.providers].sort(([a], [b]) => a.localeCompare(b)),
      ),
      models: Object.fromEntries(
        [...this.models].sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }

  record(provider: string, model?: string): HealthRecord | undefined {
    return model === undefined
      ? this.providers.get(provider)
      : this.models.get(`${provider}/${model}`);
  }

  /** Current state, folding in any reset that has already passed: a record
   * whose retry time is behind `now` no longer blocks routing. */
  stateOf(
    provider: string,
    model: string,
    now: Date,
    options: StateOfOptions = {},
  ): PoolHealthState {
    if (options.disabledProviders?.has(provider)) return "DISABLED";
    const nowMs = now.getTime();
    const providerRecord = this.providers.get(provider);
    if (providerRecord?.state === "AUTH_ERROR") return "AUTH_ERROR";
    for (const record of [
      providerRecord,
      this.models.get(`${provider}/${model}`),
    ]) {
      if (!record || record.state === "AVAILABLE") continue;
      if (record.retryAfter !== null && Date.parse(record.retryAfter) > nowMs) {
        return record.state;
      }
    }
    return "AVAILABLE";
  }

  retryAfterOf(provider: string, model: string, now: Date): string | null {
    const nowMs = now.getTime();
    const candidates = [
      this.providers.get(provider),
      this.models.get(`${provider}/${model}`),
    ]
      .filter(
        (record): record is HealthRecord =>
          record !== undefined &&
          record.state !== "AVAILABLE" &&
          record.state !== "AUTH_ERROR" &&
          record.retryAfter !== null &&
          Date.parse(record.retryAfter) > nowMs,
      )
      .map((record) => record.retryAfter as string);
    return candidates.sort().at(-1) ?? null;
  }

  recordSuccess(
    provider: string,
    model: string,
    latencyMs: number,
    now: Date,
  ): void {
    for (const [map, key] of [
      [this.providers, provider],
      [this.models, `${provider}/${model}`],
    ] as const) {
      const previous = map.get(key) ?? emptyRecord();
      map.set(key, {
        ...previous,
        state: "AVAILABLE",
        lastSuccessAt: now.toISOString(),
        failureCategory: null,
        lastError: null,
        retryAfter: null,
        quotaResetAt: null,
        consecutiveFailures: 0,
        avgLatencyMs:
          previous.avgLatencyMs === null
            ? latencyMs
            : previous.avgLatencyMs * (1 - LATENCY_SMOOTHING) +
              latencyMs * LATENCY_SMOOTHING,
      });
    }
  }

  recordFailure(
    provider: string,
    model: string,
    failure: ProviderFailure,
    now: Date,
  ): void {
    // A malformed request is our bug, not evidence about the provider.
    if (failure.category === "bad_request") return;

    const providerWide =
      failure.category === "auth_error" ||
      failure.category === "temporary_error" ||
      (failure.category === "quota_exhausted" &&
        (failure.status === 402 || failure.status === 403));
    const map = providerWide ? this.providers : this.models;
    const key = providerWide ? provider : `${provider}/${model}`;
    const previous = map.get(key) ?? emptyRecord();
    const consecutiveFailures = previous.consecutiveFailures + 1;
    const nowMs = now.getTime();
    const at = (ms: number) => new Date(nowMs + ms).toISOString();

    let state: PoolHealthState;
    let retryAfter: string | null;
    let quotaResetAt: string | null = null;
    const category: FailureCategory = failure.category;
    switch (category) {
      case "auth_error":
        // Sticky: a timer cannot fix a wrong key. Only a real success or a
        // fresh validation clears it.
        state = "AUTH_ERROR";
        retryAfter = null;
        break;
      case "quota_exhausted":
        state = "QUOTA_EXHAUSTED";
        retryAfter = at(failure.retryAfterMs ?? QUOTA_DEFAULT_RESET_MS);
        quotaResetAt = retryAfter;
        break;
      case "rate_limited":
        state = "RATE_LIMITED";
        retryAfter = at(
          failure.retryAfterMs ??
            backoff(RATE_LIMIT_BASE_MS, RATE_LIMIT_MAX_MS, consecutiveFailures),
        );
        break;
      case "model_unsupported":
        state = "UNAVAILABLE";
        retryAfter = at(UNSUPPORTED_MODEL_RETRY_MS);
        break;
      default:
        if (consecutiveFailures >= UNAVAILABLE_AFTER_FAILURES) {
          state = "UNAVAILABLE";
          retryAfter = at(failure.retryAfterMs ?? UNAVAILABLE_RETRY_MS);
        } else {
          state = "TEMPORARY_ERROR";
          retryAfter = at(
            failure.retryAfterMs ??
              backoff(TEMPORARY_BASE_MS, TEMPORARY_MAX_MS, consecutiveFailures),
          );
        }
    }
    map.set(key, {
      ...previous,
      state,
      lastFailureAt: now.toISOString(),
      failureCategory: category,
      lastError: failure.message,
      retryAfter,
      quotaResetAt,
      consecutiveFailures,
    });
  }

  /** A successful authenticated read (e.g. a model listing) proves the key
   * works again. Clears an AUTH_ERROR and nothing else -- quota and outage
   * state must survive a call that costs nothing. */
  clearAuthError(provider: string): void {
    const record = this.providers.get(provider);
    if (record?.state !== "AUTH_ERROR") return;
    this.providers.set(provider, {
      ...record,
      state: "AVAILABLE",
      failureCategory: null,
      lastError: null,
      retryAfter: null,
      consecutiveFailures: 0,
    });
  }

  /** Forgets a provider's models' failures, e.g. after a fresh discovery
   * proves the catalog changed. Auth state is deliberately kept. */
  clearModelHealth(provider: string): void {
    for (const key of [...this.models.keys()]) {
      if (key.startsWith(`${provider}/`)) this.models.delete(key);
    }
  }
}
