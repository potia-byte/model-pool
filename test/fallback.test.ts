import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "../src/fallback.js";
import type { PoolCompletion } from "../src/pool.js";
import {
  type FallbackPool,
  poolCompletionToAgentResult,
  runPlanningWithFallback,
  runReviewWithFallback,
} from "../src/fallback.js";

class ReviewFail extends Error {
  constructor(
    readonly agent: string,
    message: string,
    readonly quotaWait = false,
  ) {
    super(message);
  }
}

const agentResult = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => ({
  exitCode: 0,
  stdout: '{"decision":"PASS"}',
  stderr: "",
  timedOut: false,
  finalMessage: '{"decision":"PASS"}',
  ...overrides,
});

const okCompletion = (text: string): PoolCompletion => ({
  ok: true,
  text,
  provider: "groq",
  model: "gpt-oss-120b",
  actualModel: null,
  upstreamProvider: null,
  usage: { inputTokens: 10, outputTokens: 5 },
  attempts: [],
});

function fakePool(
  completions: PoolCompletion[],
): FallbackPool & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (request) => {
      prompts.push(request.prompt);
      const next = completions.shift();
      if (!next) throw new Error("unexpected pool call");
      return next;
    },
  };
}

function reviewDeps(over: {
  available?: string[];
  agentResults?: AgentRunResult[];
  pool?: FallbackPool | null;
}) {
  const invoked: string[] = [];
  const cooled: string[] = [];
  const logs: string[] = [];
  const results = [...(over.agentResults ?? [])];
  return {
    invoked,
    cooled,
    logs,
    deps: {
      agents: ["agent-a", "agent-b"] as const,
      isAvailable: (name: string) => (over.available ?? []).includes(name),
      invokeAgent: async (agent: string) => {
        invoked.push(agent);
        const next = results.shift();
        if (!next) throw new Error("unexpected agent call");
        return next;
      },
      onQuota: async (agent: string) => {
        cooled.push(agent);
      },
      log: async (line: string) => {
        logs.push(line);
      },
      pool: over.pool ?? null,
      fail: (agent: string, message: string, quotaWait?: boolean) =>
        new ReviewFail(agent, message, quotaWait),
    },
  };
}

describe("runReviewWithFallback", () => {
  it("uses the preferred external reviewer when it is available, never touching the pool", async () => {
    const pool = fakePool([]);
    const { deps, invoked } = reviewDeps({
      available: ["agent-a", "agent-b"],
      agentResults: [agentResult()],
      pool,
    });
    const result = await runReviewWithFallback(deps, "prompt");
    expect(result.response).toEqual({ decision: "PASS" });
    expect(invoked).toEqual(["agent-a"]);
    expect(pool.prompts).toHaveLength(0);
  });

  it("keeps the legacy behaviour with no pool: an unavailable agent is still tried, quota still throws", async () => {
    const { deps, invoked, cooled } = reviewDeps({
      available: [],
      agentResults: [
        agentResult({ exitCode: 1, stdout: "", stderr: "429 rate limit exceeded" }),
      ],
      pool: null,
    });
    await expect(runReviewWithFallback(deps, "p")).rejects.toBeInstanceOf(
      ReviewFail,
    );
    expect(invoked).toEqual(["agent-a"]);
    expect(cooled).toEqual(["agent-a"]);
  });

  it("goes straight to the pool when no external reviewer is available", async () => {
    const pool = fakePool([okCompletion('{"decision":"PASS","notes":"ok"}')]);
    const { deps, invoked, logs } = reviewDeps({ available: [], pool });
    const result = await runReviewWithFallback(deps, "review me");
    expect(invoked).toEqual([]);
    expect(pool.prompts).toEqual(["review me"]);
    expect(result.response).toEqual({ decision: "PASS", notes: "ok" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(logs.join("\n")).toMatch(/groq\/gpt-oss-120b/);
  });

  it("continues the same review on the pool when the external reviewer hits quota mid-call", async () => {
    const pool = fakePool([okCompletion('{"decision":"PASS"}')]);
    const { deps, invoked, cooled } = reviewDeps({
      available: ["agent-a"],
      agentResults: [
        agentResult({ exitCode: 1, stdout: "", stderr: "You've hit your usage limit" }),
      ],
      pool,
    });
    const result = await runReviewWithFallback(deps, "p");
    expect(invoked).toEqual(["agent-a"]);
    expect(cooled).toEqual(["agent-a"]);
    expect(result.response).toEqual({ decision: "PASS" });
  });

  it("does not invoke an agent at all while everything is exhausted; it waits with zero model use", async () => {
    const pool = fakePool([
      {
        ok: false,
        reason: "all_exhausted",
        message: "all cooling",
        earliestRetryAt: "2026-09-21T13:00:00.000Z",
        attempts: [],
      },
    ]);
    const { deps, invoked } = reviewDeps({ available: [], pool });
    const error = await runReviewWithFallback(deps, "p").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ReviewFail);
    expect((error as ReviewFail).quotaWait).toBe(true);
    expect((error as ReviewFail).message).toContain("2026-09-21T13:00:00.000Z");
    expect(invoked).toEqual([]);
  });

  it("reports quota wait only when the whole pool is out of capacity, not for a capability gap", async () => {
    const pool = fakePool([
      {
        ok: false,
        reason: "no_compatible_provider",
        message: "no model is capable",
        earliestRetryAt: null,
        attempts: [],
      },
    ]);
    const { deps } = reviewDeps({ available: [], pool });
    const error = (await runReviewWithFallback(deps, "p").catch(
      (e: unknown) => e,
    )) as ReviewFail;
    expect(error.quotaWait).toBe(false);
  });

  it("treats an ordinary agent failure as infrastructure, not a reason to switch providers", async () => {
    const pool = fakePool([]);
    const { deps } = reviewDeps({
      available: ["agent-a"],
      agentResults: [agentResult({ exitCode: 2, stdout: "", stderr: "segfault" })],
      pool,
    });
    await expect(runReviewWithFallback(deps, "p")).rejects.toBeInstanceOf(
      ReviewFail,
    );
    expect(pool.prompts).toHaveLength(0);
  });

  it("raises an infrastructure error when a pool model returns unparseable output", async () => {
    const pool = fakePool([okCompletion("I think it is fine!")]);
    const { deps } = reviewDeps({ available: [], pool });
    const error = (await runReviewWithFallback(deps, "p").catch(
      (e: unknown) => e,
    )) as ReviewFail;
    expect(error).toBeInstanceOf(ReviewFail);
    expect(error.agent).toBe("pool:groq/gpt-oss-120b");
    expect(error.message).toMatch(/JSON/);
  });

  it("reads JSON wrapped in a code fence", async () => {
    const pool = fakePool([okCompletion('```json\n{"decision":"RETRY"}\n```')]);
    const { deps } = reviewDeps({ available: [], pool });
    expect((await runReviewWithFallback(deps, "p")).response).toEqual({
      decision: "RETRY",
    });
  });
});

describe("runPlanningWithFallback", () => {
  it("uses the external planner result when it works", async () => {
    const pool = fakePool([]);
    const result = await runPlanningWithFallback(
      {
        runAgent: async () => agentResult({ stdout: "{}", finalMessage: "{}" }),
        agentAvailable: true,
        pool,
      },
      "prompt",
    );
    expect(result.finalMessage).toBe("{}");
    expect(pool.prompts).toHaveLength(0);
  });

  it("falls back to the pool when the external planner is unavailable", async () => {
    const pool = fakePool([okCompletion('{"tasks":[]}')]);
    const result = await runPlanningWithFallback(
      {
        runAgent: async () => {
          throw new Error("must not run");
        },
        agentAvailable: false,
        pool,
      },
      "prompt",
    );
    expect(result.exitCode).toBe(0);
    expect(result.finalMessage).toBe('{"tasks":[]}');
    expect(result.telemetry).toMatchObject({
      provider: "pool:groq",
      model: "gpt-oss-120b",
    });
  });

  it("falls back to the pool when the external planner hits quota", async () => {
    const pool = fakePool([okCompletion('{"tasks":[]}')]);
    const result = await runPlanningWithFallback(
      {
        runAgent: async () =>
          agentResult({ exitCode: 1, stdout: "", stderr: "429 rate limit exceeded" }),
        agentAvailable: true,
        pool,
      },
      "prompt",
    );
    expect(result.finalMessage).toBe('{"tasks":[]}');
  });

  it("returns the original quota-shaped result when the pool cannot help either", async () => {
    const pool = fakePool([
      {
        ok: false,
        reason: "all_exhausted",
        message: "all cooling",
        earliestRetryAt: null,
        attempts: [],
      },
    ]);
    const result = await runPlanningWithFallback(
      {
        runAgent: async () =>
          agentResult({ exitCode: 1, stdout: "", stderr: "429 rate limit exceeded" }),
        agentAvailable: true,
        pool,
      },
      "prompt",
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/429/);
  });
});

describe("poolCompletionToAgentResult", () => {
  it("maps a completion onto an external agent's result shape with usage and telemetry", () => {
    const result = poolCompletionToAgentResult({
      ...okCompletion("hello"),
      actualModel: "vendor/real:free",
    } as Extract<PoolCompletion, { ok: true }>);
    expect(result).toMatchObject({
      exitCode: 0,
      finalMessage: "hello",
      stdout: "hello",
      timedOut: false,
      usage: { inputTokens: 10, outputTokens: 5 },
      telemetry: { provider: "pool:groq", model: "vendor/real:free" },
    });
  });
});
