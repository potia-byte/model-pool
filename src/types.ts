/**
 * Normalized vocabulary for the model pool. Everything provider-specific stays
 * behind `catalog.ts` (static metadata) and `client.ts` (transport); the
 * router and the callers only ever see these types.
 */

/**
 * What a model costs to call:
 * - `free`      -- zero-priced by the provider's own catalog (e.g. OpenRouter `:free`).
 * - `free_tier` -- covered by the provider's free plan; rate/credit limited, no charge.
 * - `paid`      -- metered; never selected unless paid spend is explicitly allowed.
 * - `unknown`   -- not classified; treated exactly like `paid`.
 */
export type PricingClass = "free" | "free_tier" | "paid" | "unknown";

export type PoolHealthState =
  | "AVAILABLE"
  | "RATE_LIMITED"
  | "QUOTA_EXHAUSTED"
  | "AUTH_ERROR"
  | "TEMPORARY_ERROR"
  | "UNAVAILABLE"
  | "DISABLED";

export type FailureCategory =
  | "rate_limited"
  | "quota_exhausted"
  | "auth_error"
  | "model_unsupported"
  | "temporary_error"
  | "bad_request"
  | "unknown_error";

/**
 * Work the pool can serve. All are text-in / text-out: an API model cannot
 * edit a working tree the way a coding-agent CLI does, so file-editing
 * roles are deliberately absent -- the router can never send them here.
 */
export type PoolRole = "qa_review" | "planning" | "research" | "summarization";

/** 0 = unsuitable, 1 = basic, 2 = solid, 3 = strong. */
export type CapabilityTier = 0 | 1 | 2 | 3;

export interface ModelCapabilities {
  /** Tokens; null when neither the provider nor config states it. */
  contextWindow: number | null;
  /** null = unknown. Unknown is never treated as supported. */
  toolCalling: boolean | null;
  structuredOutput: boolean | null;
  coding: CapabilityTier;
  reasoning: CapabilityTier;
}

export interface PoolModel {
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  pricing: PricingClass;
  /** How this model accepts a reasoning-effort setting; absent = unsupported. */
  effortControl?: "reasoning_effort" | "openrouter_reasoning";
  /** Where the model entry came from, for diagnostics. */
  source: "discovered" | "configured";
}

export function poolModelKey(model: {
  provider: string;
  model: string;
}): string {
  return `${model.provider}/${model.model}`;
}

export interface ProviderFailure {
  category: FailureCategory;
  /** Milliseconds until the provider says a retry is sensible, when stated. */
  retryAfterMs: number | null;
  /** Redacted and length-bounded; safe to log and persist. */
  message: string;
  status: number | null;
}
