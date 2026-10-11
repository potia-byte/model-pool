import type {
  CapabilityTier,
  PoolHealthState,
  PoolModel,
  PoolRole,
  PricingClass,
} from "./types.js";
import { poolModelKey } from "./types.js";

/**
 * Model selection for the pool. Deliberately not round-robin: a request is
 * filtered by policy, price and capability, then by live health, and the
 * survivors are ranked by expected verified output per unit of free quota.
 * Pure and deterministic -- same inputs, same decision; no clock (except the
 * `now` it is handed), no I/O.
 */

export interface PoolPolicy {
  /** Free and free-tier models may be selected. */
  allowFreeModels: boolean;
  /** Metered/unknown-priced models may be selected. Off unless a human turns
   * it on; nothing in this library flips this automatically. */
  allowPaidApiSpend: boolean;
  disabledProviders?: ReadonlySet<string>;
}

export const DEFAULT_POOL_POLICY: PoolPolicy = {
  allowFreeModels: true,
  allowPaidApiSpend: false,
};

export interface PoolRequirements {
  role: PoolRole;
  minCoding: CapabilityTier;
  minReasoning: CapabilityTier;
  /** Prompt + expected output, in tokens; null when not estimated. */
  minContextTokens: number | null;
  needsTools: boolean;
  needsStructuredOutput: boolean;
  /** How much each capability matters to this role's expected quality. */
  qualityWeights: { coding: number; reasoning: number };
}

const ROLE_DEFAULTS: Record<PoolRole, PoolRequirements> = {
  // Independent code review must be able to read a diff AND judge it.
  qa_review: {
    role: "qa_review",
    minCoding: 2,
    minReasoning: 2,
    minContextTokens: null,
    needsTools: false,
    needsStructuredOutput: false,
    qualityWeights: { coding: 0.5, reasoning: 0.5 },
  },
  planning: {
    role: "planning",
    minCoding: 1,
    minReasoning: 2,
    minContextTokens: null,
    needsTools: false,
    needsStructuredOutput: false,
    qualityWeights: { coding: 0.3, reasoning: 0.7 },
  },
  research: {
    role: "research",
    minCoding: 0,
    minReasoning: 1,
    minContextTokens: null,
    needsTools: false,
    needsStructuredOutput: false,
    qualityWeights: { coding: 0.2, reasoning: 0.8 },
  },
  summarization: {
    role: "summarization",
    minCoding: 1,
    minReasoning: 1,
    minContextTokens: null,
    needsTools: false,
    needsStructuredOutput: false,
    qualityWeights: { coding: 0.5, reasoning: 0.5 },
  },
};

export function requirementsForRole(
  role: PoolRole,
  overrides: Partial<Omit<PoolRequirements, "role">> = {},
): PoolRequirements {
  return { ...ROLE_DEFAULTS[role], ...overrides };
}

/** One model plus everything the router needs to know about it right now. */
export interface PoolCandidate {
  model: PoolModel;
  state: PoolHealthState;
  /** When a non-AVAILABLE state is expected to lift; null when unknown. */
  retryAfter: string | null;
  avgLatencyMs: number | null;
  /** Has answered a real request successfully at least once. */
  proven: boolean;
  /** 0..1 from provider rate-limit headers when reported; null if unknown. */
  quotaRemainingFraction: number | null;
}

export const QUALITY_WEIGHT = 60;
export const COST_WEIGHT = 20;
export const LATENCY_WEIGHT = 8;
export const HEADROOM_WEIGHT = 7;
export const PROVEN_WEIGHT = 5;

const COST_SCORE: Record<PricingClass, number> = {
  free: 1,
  free_tier: 0.8,
  paid: 0,
  unknown: 0,
};
const NEUTRAL = 0.5;
const LATENCY_HALF_SCORE_MS = 2000;

export interface RejectedCandidate {
  candidate: PoolCandidate;
  reason: string;
}

export interface ScoredPoolCandidate {
  candidate: PoolCandidate;
  score: number;
}

export interface PoolRoutingDecision {
  selected: PoolCandidate | null;
  /** Usable candidates, best first. */
  ranked: ScoredPoolCandidate[];
  rejected: RejectedCandidate[];
  reason: string;
  /** True when at least one model would be usable but is only waiting on a
   * rate-limit/quota/outage reset. This -- and only this -- is the condition
   * for entering quota wait; a pure capability mismatch is not. */
  exhaustedByCapacity: boolean;
  /** Earliest time any capacity-blocked, otherwise-compatible model returns. */
  earliestRetryAt: string | null;
}

export interface RoutePoolOptions {
  /** `provider/model` keys already tried for this request. */
  exclude?: ReadonlySet<string>;
}

function compatibilityRejection(
  candidate: PoolCandidate,
  requirements: PoolRequirements,
  policy: PoolPolicy,
): string | null {
  const { model } = candidate;
  if (policy.disabledProviders?.has(model.provider)) {
    return `provider ${model.provider} is disabled by policy`;
  }
  const paidLike = model.pricing === "paid" || model.pricing === "unknown";
  if (paidLike && !policy.allowPaidApiSpend) {
    return `${model.pricing} model; paid API spend is disabled`;
  }
  if (!paidLike && !policy.allowFreeModels) {
    return "free models are disallowed by policy";
  }
  const caps = model.capabilities;
  if (caps.coding < requirements.minCoding) {
    return `coding tier ${caps.coding} below required ${requirements.minCoding}`;
  }
  if (caps.reasoning < requirements.minReasoning) {
    return `reasoning tier ${caps.reasoning} below required ${requirements.minReasoning}`;
  }
  if (requirements.minContextTokens !== null) {
    if (caps.contextWindow === null) {
      return `context window unknown; ${requirements.minContextTokens} tokens required`;
    }
    if (caps.contextWindow < requirements.minContextTokens) {
      return `context window ${caps.contextWindow} below required ${requirements.minContextTokens}`;
    }
  }
  if (requirements.needsTools && caps.toolCalling !== true) {
    return `tool calling ${caps.toolCalling === null ? "unknown" : "unsupported"}`;
  }
  if (requirements.needsStructuredOutput && caps.structuredOutput !== true) {
    return `structured output ${caps.structuredOutput === null ? "unknown" : "unsupported"}`;
  }
  return null;
}

function score(
  candidate: PoolCandidate,
  requirements: PoolRequirements,
): number {
  const { coding, reasoning } = candidate.model.capabilities;
  const weights = requirements.qualityWeights;
  const quality =
    (coding * weights.coding + reasoning * weights.reasoning) /
    (3 * (weights.coding + weights.reasoning));
  const latency =
    candidate.avgLatencyMs === null
      ? NEUTRAL
      : 1 / (1 + candidate.avgLatencyMs / LATENCY_HALF_SCORE_MS);
  return (
    quality * QUALITY_WEIGHT +
    COST_SCORE[candidate.model.pricing] * COST_WEIGHT +
    latency * LATENCY_WEIGHT +
    (candidate.quotaRemainingFraction ?? NEUTRAL) * HEADROOM_WEIGHT +
    (candidate.proven ? 1 : 0) * PROVEN_WEIGHT
  );
}

const RECOVERABLE: ReadonlySet<PoolHealthState> = new Set([
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "TEMPORARY_ERROR",
  "UNAVAILABLE",
]);

export function routePool(
  requirements: PoolRequirements,
  candidates: readonly PoolCandidate[],
  policy: PoolPolicy,
  now: Date,
  options: RoutePoolOptions = {},
): PoolRoutingDecision {
  const rejected: RejectedCandidate[] = [];
  const usable: ScoredPoolCandidate[] = [];
  const waiting: PoolCandidate[] = [];

  // Sorting the input first makes every downstream list order-independent.
  const ordered = [...candidates].sort((left, right) =>
    poolModelKey(left.model).localeCompare(poolModelKey(right.model)),
  );
  for (const candidate of ordered) {
    const incompatible = compatibilityRejection(
      candidate,
      requirements,
      policy,
    );
    if (incompatible) {
      rejected.push({ candidate, reason: incompatible });
      continue;
    }
    // A reset that has already passed no longer blocks the model even if the
    // caller handed us a stale state label.
    const stillBlocked =
      candidate.state !== "AVAILABLE" &&
      (candidate.retryAfter === null ||
        Date.parse(candidate.retryAfter) > now.getTime() ||
        candidate.state === "AUTH_ERROR" ||
        candidate.state === "DISABLED");
    if (stillBlocked) {
      const until = candidate.retryAfter
        ? ` until ${candidate.retryAfter}`
        : "";
      rejected.push({ candidate, reason: `${candidate.state}${until}` });
      if (RECOVERABLE.has(candidate.state)) waiting.push(candidate);
      continue;
    }
    // Checked after health on purpose: a model tried moments ago that is now
    // cooling down is still capacity we are waiting on, not a settled miss.
    if (options.exclude?.has(poolModelKey(candidate.model))) {
      rejected.push({ candidate, reason: "already tried for this request" });
      continue;
    }
    usable.push({ candidate, score: score(candidate, requirements) });
  }

  usable.sort(
    (left, right) =>
      right.score - left.score ||
      poolModelKey(left.candidate.model).localeCompare(
        poolModelKey(right.candidate.model),
      ),
  );

  const retryTimes = waiting
    .map((candidate) => candidate.retryAfter)
    .filter((value): value is string => value !== null)
    .sort();
  const selected = usable[0]?.candidate ?? null;
  return {
    selected,
    ranked: usable,
    rejected,
    reason: selected
      ? `Selected ${poolModelKey(selected.model)} (${selected.model.pricing}, score ${usable[0]?.score.toFixed(2)}) for ${requirements.role}; ${rejected.length} candidate(s) rejected.`
      : `No usable pool model for ${requirements.role}: ${
          rejected.length === 0
            ? "the pool is empty"
            : rejected
                .slice(0, 12)
                .map(
                  (item) =>
                    `${poolModelKey(item.candidate.model)} (${item.reason})`,
                )
                .join("; ")
        }`,
    exhaustedByCapacity: selected === null && waiting.length > 0,
    earliestRetryAt: selected === null ? (retryTimes[0] ?? null) : null,
  };
}
