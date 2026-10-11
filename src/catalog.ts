import { readFile } from "node:fs/promises";
import { z } from "zod";
import type {
  CapabilityTier,
  ModelCapabilities,
  PoolModel,
  PricingClass,
} from "./types.js";

/**
 * Static, maintainable provider/model metadata for the pool. Model NAMES are
 * never hard-coded into router logic: providers publish live model lists and
 * this catalog only holds regex rules that grade whatever is discovered, so a
 * renamed or retired model is a one-line JSON edit, and a brand-new model that
 * matches no rule stays `unknown` (= unroutable) instead of being trusted.
 */

const tier = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const pricing = z.enum(["free", "free_tier", "paid", "unknown"]);

const regexSource = z.string().refine(
  (source) => {
    try {
      new RegExp(source, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid regular expression" },
);

const ruleSchema = z.object({
  match: regexSource,
  coding: tier,
  reasoning: tier,
  toolCalling: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  pricing: pricing.optional(),
});

const providerSchema = z.object({
  displayName: z.string().min(1),
  /** Environment variable NAMES only; the first one present is used. */
  envKeys: z.array(z.string()).min(1),
  /** May contain `{ENV_NAME}` placeholders filled from the environment. */
  baseUrl: z.string().min(1),
  discovery: z
    .enum(["openai-models", "cloudflare-search", "none"])
    .default("openai-models"),
  /** Path resolved against `baseUrl` to list models (`..` is allowed). */
  discoveryPath: z.string().default("/models"),
  /** Lists the token's accounts when `baseUrl` needs an account id that the
   * environment does not supply (Cloudflare). */
  accountLookupUrl: z.string().optional(),
  stripPrefix: z.string().optional(),
  defaultPricing: pricing.default("unknown"),
  /**
   * Whether a per-token price in the provider's model list means the model is
   * metered for this key. True for catalogs that mark free vs. paid per model
   * (OpenRouter, Vercel); false for providers that publish list prices next to
   * a genuine free plan (Groq, SambaNova), where the listing says nothing
   * about what this key is charged. A listed price of zero is always honoured.
   */
  trustListingPrice: z.boolean().default(true),
  /**
   * How this provider accepts a reasoning-effort setting. Absent means the
   * provider has no control the pool knows how to drive, and effort is
   * reported as unsupported rather than faked.
   */
  effort: z
    .object({
      kind: z.enum(["reasoning_effort", "openrouter_reasoning"]),
      /** Only models whose id matches support it (default: all). */
      models: regexSource.optional(),
      /** Also require the provider's own listing to advertise reasoning. */
      requireDiscoveredSupport: z.boolean().optional(),
    })
    .optional(),
  exclude: z.array(regexSource).default([]),
  rules: z.array(ruleSchema).default([]),
  /** Grade for provider-verified free models that match no rule. */
  freeFallback: z.object({ coding: tier, reasoning: tier }).optional(),
  /** Used only when live discovery returns nothing usable. */
  staticModels: z.array(z.string()).default([]),
  /** Preferred model for the one-token validation request. */
  validationModel: z.string().optional(),
  enabled: z.boolean().default(true),
  note: z.string().optional(),
});

export const catalogSchema = z.object({
  version: z.literal(1),
  providers: z.record(z.string(), providerSchema),
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type ProviderRule = z.infer<typeof ruleSchema>;
export type ModelCatalog = z.infer<typeof catalogSchema>;

export async function loadCatalog(path: string): Promise<ModelCatalog> {
  return catalogSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** One model as a provider reports it, before the catalog grades it. */
export interface DiscoveredModel {
  id: string;
  contextWindow?: number;
  toolCalling?: boolean;
  structuredOutput?: boolean;
  /** The listing advertises a reasoning parameter for this model. */
  reasoning?: boolean;
  /** Only set when the provider itself states the price. */
  pricing?: "free" | "paid";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function priceNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function providerPricing(
  item: Record<string, unknown>,
): "free" | "paid" | undefined {
  const price = asRecord(item.pricing);
  if (price) {
    const prompt = priceNumber(price.prompt ?? price.input);
    const completion = priceNumber(price.completion ?? price.output);
    if (prompt !== null && completion !== null) {
      return prompt === 0 && completion === 0 ? "free" : "paid";
    }
  }
  const providers = item.providers;
  if (Array.isArray(providers)) {
    const live = providers.map(asRecord).filter((p) => p !== null);
    if (live.some((p) => p.is_free === true)) return "free";
  }
  return undefined;
}

/**
 * Generic extractor for the list shapes the supported providers return
 * (OpenAI `data[]`, OpenRouter pricing/supported_parameters, Vercel
 * input/output pricing, Hugging Face `providers[]`, Cloudflare `result[]`).
 * Never throws: a malformed body yields an empty list.
 */
export function extractDiscoveredModels(
  body: unknown,
  options: { stripPrefix?: string } = {},
): DiscoveredModel[] {
  const root = asRecord(body);
  const list = root?.data ?? root?.result ?? root?.models;
  if (!Array.isArray(list)) return [];
  // Cloudflare-style `result[]` records carry an opaque UUID `id` alongside
  // the model `name` ("@cf/..."), and the name is what a request must use.
  const nameFirst = root?.data === undefined && root?.result !== undefined;
  const models: DiscoveredModel[] = [];
  for (const entry of list) {
    const item = asRecord(entry);
    const rawId = nameFirst
      ? (item?.name ?? item?.id)
      : (item?.id ?? item?.name);
    if (!item || typeof rawId !== "string" || rawId === "") continue;
    const id =
      options.stripPrefix && rawId.startsWith(options.stripPrefix)
        ? rawId.slice(options.stripPrefix.length)
        : rawId;
    const model: DiscoveredModel = { id };

    let contextWindow: number | undefined;
    for (const field of [
      "context_length",
      "context_window",
      "max_context_length",
    ]) {
      const value = item[field];
      if (typeof value === "number" && value > 0) contextWindow = value;
    }
    const params = item.supported_parameters;
    if (Array.isArray(params)) {
      model.toolCalling = params.includes("tools");
      model.structuredOutput =
        params.includes("structured_outputs") ||
        params.includes("response_format");
      model.reasoning =
        params.includes("reasoning") ||
        params.includes("reasoning_effort") ||
        params.includes("include_reasoning");
    }
    if (Array.isArray(item.providers)) {
      const live = item.providers
        .map(asRecord)
        .filter(
          (p): p is Record<string, unknown> =>
            p !== null && p.status === "live",
        );
      for (const p of live) {
        if (typeof p.context_length === "number") {
          contextWindow = Math.max(contextWindow ?? 0, p.context_length);
        }
      }
      if (live.length > 0) {
        model.toolCalling = live.some((p) => p.supports_tools === true);
        model.structuredOutput = live.some(
          (p) => p.supports_structured_output === true,
        );
      }
    }
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    const price = providerPricing(item);
    if (price) model.pricing = price;
    models.push(model);
  }
  return models;
}

export interface ResolvedProviderModels {
  models: PoolModel[];
  /** Discovered chat models no rule graded; visible but never routable. */
  unclassified: number;
}

/** A full rule, or just the grade from `freeFallback`. Fields a rule leaves
 * out fall through to what the provider reported, then to unknown (null). */
type Grade = Pick<ProviderRule, "coding" | "reasoning"> &
  Partial<
    Pick<ProviderRule, "toolCalling" | "structuredOutput" | "contextWindow">
  >;

function capabilities(
  rule: Grade | null,
  discovered: DiscoveredModel,
): ModelCapabilities {
  return {
    contextWindow: rule?.contextWindow ?? discovered.contextWindow ?? null,
    toolCalling: rule?.toolCalling ?? discovered.toolCalling ?? null,
    structuredOutput:
      rule?.structuredOutput ?? discovered.structuredOutput ?? null,
    coding: (rule?.coding ?? 0) as CapabilityTier,
    reasoning: (rule?.reasoning ?? 0) as CapabilityTier,
  };
}

function effortFor(
  config: ProviderConfig,
  entry: DiscoveredModel,
): PoolModel["effortControl"] | undefined {
  const effort = config.effort;
  if (!effort) return undefined;
  if (effort.models && !new RegExp(effort.models, "i").test(entry.id))
    return undefined;
  if (effort.requireDiscoveredSupport && entry.reasoning !== true)
    return undefined;
  return effort.kind;
}

export function resolveProviderModels(
  providerId: string,
  config: ProviderConfig,
  discovered: readonly DiscoveredModel[],
): ResolvedProviderModels {
  const excluded = config.exclude.map((source) => new RegExp(source, "i"));
  const rules = config.rules.map((rule) => ({
    rule,
    pattern: new RegExp(rule.match, "i"),
  }));
  const fromDiscovery = discovered.length > 0;
  const input: Array<{ entry: DiscoveredModel; source: PoolModel["source"] }> =
    fromDiscovery
      ? discovered.map((entry) => ({ entry, source: "discovered" as const }))
      : config.staticModels.map((id) => ({
          entry: { id },
          source: "configured" as const,
        }));

  const models: PoolModel[] = [];
  let unclassified = 0;
  for (const { entry, source } of input) {
    if (excluded.some((pattern) => pattern.test(entry.id))) continue;
    const matched = rules.find(({ pattern }) => pattern.test(entry.id))?.rule;
    let model: { pricing: PricingClass; caps: ModelCapabilities };
    if (matched) {
      let priced: PricingClass = matched.pricing ?? config.defaultPricing;
      // Safety first: a curated `paid` rule, or a provider whose listing we
      // trust stating a price, always beats an optimistic free-tier default.
      if (
        matched.pricing === "paid" ||
        (entry.pricing === "paid" && config.trustListingPrice)
      ) {
        priced = "paid";
      } else if (entry.pricing === "free") priced = "free";
      model = { pricing: priced, caps: capabilities(matched, entry) };
    } else if (entry.pricing === "free") {
      model = {
        pricing: "free",
        caps: capabilities(config.freeFallback ?? null, entry),
      };
    } else {
      unclassified += 1;
      model = {
        pricing:
          entry.pricing === "paid" && config.trustListingPrice
            ? "paid"
            : "unknown",
        caps: capabilities(null, entry),
      };
    }
    const effortControl = effortFor(config, entry);
    models.push({
      provider: providerId,
      model: entry.id,
      capabilities: model.caps,
      pricing: model.pricing,
      ...(effortControl ? { effortControl } : {}),
      source,
    });
  }
  return { models, unclassified };
}
