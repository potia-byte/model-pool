import { describe, expect, it } from "vitest";
import {
  DEFAULT_POOL_POLICY,
  type PoolCandidate,
  requirementsForRole,
  routePool,
} from "../src/router.js";
import type {
  ModelCapabilities,
  PoolHealthState,
  PricingClass,
} from "../src/types.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");

function candidate(
  provider: string,
  model: string,
  overrides: {
    state?: PoolHealthState;
    pricing?: PricingClass;
    caps?: Partial<ModelCapabilities>;
    retryAfter?: string | null;
    avgLatencyMs?: number | null;
    proven?: boolean;
    quotaRemainingFraction?: number | null;
  } = {},
): PoolCandidate {
  return {
    model: {
      provider,
      model,
      pricing: overrides.pricing ?? "free_tier",
      source: "discovered",
      capabilities: {
        contextWindow: 131072,
        toolCalling: true,
        structuredOutput: true,
        coding: 2,
        reasoning: 2,
        ...overrides.caps,
      },
    },
    state: overrides.state ?? "AVAILABLE",
    retryAfter: overrides.retryAfter ?? null,
    avgLatencyMs: overrides.avgLatencyMs ?? null,
    proven: overrides.proven ?? false,
    quotaRemainingFraction: overrides.quotaRemainingFraction ?? null,
  };
}

const qa = requirementsForRole("qa_review");

describe("routePool", () => {
  it("selects the best-quality usable free model, not just the first one", () => {
    const decision = routePool(
      qa,
      [
        candidate("groq", "small", { caps: { coding: 2, reasoning: 2 } }),
        candidate("cerebras", "big", { caps: { coding: 3, reasoning: 3 } }),
      ],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(decision.selected?.model.model).toBe("big");
  });

  it("does not round-robin: identical inputs keep choosing the same model", () => {
    const pool = [
      candidate("a", "m", { caps: { coding: 3, reasoning: 3 } }),
      candidate("b", "m", { caps: { coding: 2, reasoning: 2 } }),
    ];
    const picks = Array.from(
      { length: 5 },
      () =>
        routePool(qa, pool, DEFAULT_POOL_POLICY, NOW).selected?.model.provider,
    );
    expect(new Set(picks)).toEqual(new Set(["a"]));
  });

  it("is independent of candidate input order", () => {
    const pool = [
      candidate("b", "m"),
      candidate("a", "m"),
      candidate("c", "m"),
    ];
    const forward = routePool(qa, pool, DEFAULT_POOL_POLICY, NOW);
    const reversed = routePool(
      qa,
      [...pool].reverse(),
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(forward.selected?.model.provider).toBe("a");
    expect(reversed.ranked.map((r) => r.candidate.model.provider)).toEqual(
      forward.ranked.map((r) => r.candidate.model.provider),
    );
  });

  it("never selects a paid model while paid spend is disabled, even when it is the best", () => {
    const decision = routePool(
      qa,
      [
        candidate("vercel", "frontier", {
          pricing: "paid",
          caps: { coding: 3, reasoning: 3 },
        }),
        candidate("groq", "free-ok"),
      ],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(decision.selected?.model.model).toBe("free-ok");
    expect(
      decision.rejected.find((r) => r.candidate.model.model === "frontier")
        ?.reason,
    ).toMatch(/paid/i);
  });

  it("treats unknown pricing exactly like paid", () => {
    const decision = routePool(
      qa,
      [candidate("x", "mystery", { pricing: "unknown" })],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(decision.selected).toBeNull();
    expect(decision.rejected[0]?.reason).toMatch(/paid|unknown/i);
  });

  it("allows a paid model only when paid spend is explicitly enabled", () => {
    const decision = routePool(
      qa,
      [candidate("vercel", "frontier", { pricing: "paid" })],
      { ...DEFAULT_POOL_POLICY, allowPaidApiSpend: true },
      NOW,
    );
    expect(decision.selected?.model.model).toBe("frontier");
  });

  it("selects nothing when free models are disallowed and paid spend is off", () => {
    const decision = routePool(
      qa,
      [candidate("groq", "m")],
      { ...DEFAULT_POOL_POLICY, allowFreeModels: false },
      NOW,
    );
    expect(decision.selected).toBeNull();
  });

  it("prefers a provider-verified free model over a free-tier one at equal quality", () => {
    const decision = routePool(
      qa,
      [
        candidate("a", "tier", { pricing: "free_tier" }),
        candidate("b", "free", { pricing: "free" }),
      ],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(decision.selected?.model.model).toBe("free");
  });

  it("prefers a proven model and one with quota headroom at equal quality", () => {
    const proven = routePool(
      qa,
      [candidate("a", "m"), candidate("b", "m", { proven: true })],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(proven.selected?.model.provider).toBe("b");
    const headroom = routePool(
      qa,
      [
        candidate("a", "m", { quotaRemainingFraction: 0.05 }),
        candidate("b", "m", { quotaRemainingFraction: 0.9 }),
      ],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(headroom.selected?.model.provider).toBe("b");
  });

  it("excludes rate-limited, quota-exhausted, auth-failed and unavailable models and says why", () => {
    const reset = "2026-09-21T12:30:00.000Z";
    const decision = routePool(
      qa,
      [
        candidate("a", "m", { state: "RATE_LIMITED", retryAfter: reset }),
        candidate("b", "m", {
          state: "QUOTA_EXHAUSTED",
          retryAfter: "2026-09-21T18:00:00.000Z",
        }),
        candidate("c", "m", { state: "AUTH_ERROR" }),
        candidate("d", "m", {
          state: "TEMPORARY_ERROR",
          retryAfter: "2026-09-21T12:01:00.000Z",
        }),
        candidate("e", "m", {
          state: "UNAVAILABLE",
          retryAfter: "2026-09-21T12:15:00.000Z",
        }),
        candidate("f", "m", { state: "DISABLED" }),
        candidate("ok", "m"),
      ],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(decision.selected?.model.provider).toBe("ok");
    expect(decision.rejected).toHaveLength(6);
    const reasons = Object.fromEntries(
      decision.rejected.map((r) => [r.candidate.model.provider, r.reason]),
    );
    expect(reasons.a).toContain("RATE_LIMITED");
    expect(reasons.c).toContain("AUTH_ERROR");
  });

  it("reports the earliest recovery time when nothing is usable", () => {
    const decision = routePool(
      qa,
      [
        candidate("a", "m", {
          state: "RATE_LIMITED",
          retryAfter: "2026-09-21T12:30:00.000Z",
        }),
        candidate("b", "m", {
          state: "QUOTA_EXHAUSTED",
          retryAfter: "2026-09-21T12:10:00.000Z",
        }),
        candidate("c", "m", { state: "AUTH_ERROR" }),
      ],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(decision.selected).toBeNull();
    expect(decision.earliestRetryAt).toBe("2026-09-21T12:10:00.000Z");
    expect(decision.exhaustedByCapacity).toBe(true);
  });

  it("does not mistake a capability mismatch for exhausted capacity", () => {
    const decision = routePool(
      requirementsForRole("qa_review", { minCoding: 3, minReasoning: 3 }),
      [candidate("a", "weak", { caps: { coding: 1, reasoning: 1 } })],
      DEFAULT_POOL_POLICY,
      NOW,
    );
    expect(decision.selected).toBeNull();
    expect(decision.exhaustedByCapacity).toBe(false);
    expect(decision.rejected[0]?.reason).toMatch(/coding/i);
  });

  it("prevents bad routing on every capability axis", () => {
    const cases: Array<{
      name: string;
      reqs: ReturnType<typeof requirementsForRole>;
      caps: Partial<ModelCapabilities>;
      reason: RegExp;
    }> = [
      {
        name: "coding",
        reqs: requirementsForRole("qa_review", { minCoding: 3 }),
        caps: { coding: 2 },
        reason: /coding/i,
      },
      {
        name: "reasoning",
        reqs: requirementsForRole("qa_review", { minReasoning: 3 }),
        caps: { reasoning: 2 },
        reason: /reasoning/i,
      },
      {
        name: "context",
        reqs: requirementsForRole("qa_review", { minContextTokens: 200000 }),
        caps: { contextWindow: 65536 },
        reason: /context/i,
      },
      {
        name: "unknown context",
        reqs: requirementsForRole("qa_review", { minContextTokens: 1000 }),
        caps: { contextWindow: null },
        reason: /context/i,
      },
      {
        name: "tools false",
        reqs: requirementsForRole("qa_review", { needsTools: true }),
        caps: { toolCalling: false },
        reason: /tool/i,
      },
      {
        name: "tools unknown",
        reqs: requirementsForRole("qa_review", { needsTools: true }),
        caps: { toolCalling: null },
        reason: /tool/i,
      },
      {
        name: "structured false",
        reqs: requirementsForRole("qa_review", { needsStructuredOutput: true }),
        caps: { structuredOutput: false },
        reason: /structured/i,
      },
      {
        name: "structured unknown",
        reqs: requirementsForRole("qa_review", { needsStructuredOutput: true }),
        caps: { structuredOutput: null },
        reason: /structured/i,
      },
    ];
    for (const item of cases) {
      const decision = routePool(
        item.reqs,
        [candidate("a", "m", { caps: item.caps })],
        DEFAULT_POOL_POLICY,
        NOW,
      );
      expect(decision.selected, item.name).toBeNull();
      expect(decision.rejected[0]?.reason, item.name).toMatch(item.reason);
    }
  });

  it("survives ten unavailable providers and an empty pool without throwing", () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      candidate(`p${i}`, "m", {
        state: i % 2 === 0 ? "QUOTA_EXHAUSTED" : "TEMPORARY_ERROR",
        retryAfter: `2026-09-21T13:0${i}:00.000Z`,
      }),
    );
    const decision = routePool(qa, pool, DEFAULT_POOL_POLICY, NOW);
    expect(decision.selected).toBeNull();
    expect(decision.rejected).toHaveLength(10);
    expect(routePool(qa, [], DEFAULT_POOL_POLICY, NOW).selected).toBeNull();
  });

  it("skips models already tried for this request", () => {
    const decision = routePool(
      qa,
      [candidate("a", "m"), candidate("b", "m")],
      DEFAULT_POOL_POLICY,
      NOW,
      { exclude: new Set(["a/m"]) },
    );
    expect(decision.selected?.model.provider).toBe("b");
  });
});
