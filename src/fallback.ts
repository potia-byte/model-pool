import { parseJsonResult } from "./json.js";
import type { PoolCompletion, PoolCompletionRequest } from "./pool.js";
import { classifyProcessOutcome } from "./quota.js";

/**
 * Glue between an existing external agent (typically a CLI coding agent) and
 * the pool. The pool only ever adds capacity: with no pool configured every
 * function here behaves exactly as without one, and a pool model is only
 * consulted once the external agent is unavailable or has just reported a
 * quota/rate-limit. It serves text-in/JSON-out roles (independent review,
 * planning); code-editing runs stay with the external agent because an API
 * completion cannot change a working tree.
 */

/** What an external agent run returns; the minimum the fallback glue reads. */
export interface AgentRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  finalMessage: string;
  /** True when the caller asked the child to stop. */
  aborted?: boolean;
  /** Exact provider-reported counts only. */
  usage?: { inputTokens: number; outputTokens: number };
  telemetry?: { provider: string; model?: string };
}

export interface FallbackPool {
  complete(request: PoolCompletionRequest): Promise<PoolCompletion>;
}

/** Pool completion -> the shape an external agent runner returns, so callers
 * need no pool-specific branches. */
export function poolCompletionToAgentResult(
  completion: Extract<PoolCompletion, { ok: true }>,
): AgentRunResult {
  return {
    exitCode: 0,
    stdout: completion.text,
    stderr: "",
    timedOut: false,
    finalMessage: completion.text,
    ...(completion.usage ? { usage: completion.usage } : {}),
    telemetry: {
      provider: `pool:${completion.provider}`,
      // Prefer what an aggregator says actually answered (e.g. a free-model
      // router), falling back to the model that was requested.
      model: completion.actualModel ?? completion.model,
    },
  };
}

function servedBy(completion: Extract<PoolCompletion, { ok: true }>): string {
  const actual =
    completion.actualModel && completion.actualModel !== completion.model
      ? ` (served by ${completion.actualModel}${completion.upstreamProvider ? ` via ${completion.upstreamProvider}` : ""})`
      : "";
  return `${completion.provider}/${completion.model}${actual}`;
}

export interface ReviewFallbackDeps {
  /**
   * External agents in order of preference. The first one for which
   * `isAvailable` is true is used.
   */
  agents: readonly string[];
  isAvailable: (agent: string) => boolean;
  invokeAgent: (agent: string, prompt: string) => Promise<AgentRunResult>;
  /** Records the quota cooldown for an external agent. */
  onQuota: (agent: string) => Promise<void>;
  log: (line: string) => Promise<void> | void;
  pool: FallbackPool | null;
  /** Builds the caller's error. `quotaWait` marks a failure caused purely by
   * exhausted capacity, which must not spend a retry budget. */
  fail: (agent: string, message: string, quotaWait?: boolean) => Error;
}

export interface ReviewFallbackResult {
  response: unknown;
  usage?: AgentRunResult["usage"];
}

export async function runReviewWithFallback(
  deps: ReviewFallbackDeps,
  prompt: string,
): Promise<ReviewFallbackResult> {
  const preferred = deps.agents[0] ?? "agent";
  const available = deps.agents.find((agent) => deps.isAvailable(agent));
  // Without a pool: dispatch to the preferred agent even if it is cooling
  // down, exactly as if the pool did not exist.
  const chosen = available ?? (deps.pool ? null : preferred);

  if (chosen) {
    const run = await deps.invokeAgent(chosen, prompt);
    if (run.exitCode === 0 && !run.timedOut) {
      return {
        response: parseJsonResult(run.finalMessage || run.stdout),
        ...(run.usage ? { usage: run.usage } : {}),
      };
    }
    const quota = classifyProcessOutcome(run) === "quota";
    if (quota) await deps.onQuota(chosen);
    if (!quota || !deps.pool) {
      throw deps.fail(
        chosen,
        `Review agent (${chosen}) failed: ${run.stderr || run.stdout}`,
      );
    }
    await deps.log(
      `${chosen} hit a quota/rate limit during review; continuing the same review on the model pool.`,
    );
  }

  if (!deps.pool) throw deps.fail(preferred, "No review provider available.");
  const completion = await deps.pool.complete({ role: "qa_review", prompt });
  if (!completion.ok) {
    const retry = completion.earliestRetryAt
      ? ` Earliest pool recovery: ${completion.earliestRetryAt}.`
      : "";
    throw deps.fail(
      "model-pool",
      `No review provider can serve this review (${completion.reason}): ${completion.message}${retry}`,
      completion.reason === "all_exhausted",
    );
  }
  await deps.log(`Review served by pool model ${servedBy(completion)}.`);
  try {
    return {
      response: parseJsonResult(completion.text),
      ...(completion.usage ? { usage: completion.usage } : {}),
    };
  } catch (error) {
    throw deps.fail(
      `pool:${completion.provider}/${completion.model}`,
      `Review response was not parseable JSON (${(error as Error).message})`,
    );
  }
}

export interface PlannerFallbackDeps {
  runAgent: () => Promise<AgentRunResult>;
  /** False when the external planner agent is unavailable (e.g. cooling down). */
  agentAvailable: boolean;
  pool: FallbackPool | null;
}

export async function runPlanningWithFallback(
  deps: PlannerFallbackDeps,
  prompt: string,
): Promise<AgentRunResult> {
  let original: AgentRunResult | null = null;
  if (deps.agentAvailable || !deps.pool) {
    original = await deps.runAgent();
    if (
      !deps.pool ||
      original.aborted ||
      classifyProcessOutcome(original) !== "quota"
    ) {
      return original;
    }
  }
  if (!deps.pool) return original as AgentRunResult;
  const completion = await deps.pool.complete({
    role: "planning",
    prompt,
    maxTokens: 8192,
  });
  if (completion.ok) return poolCompletionToAgentResult(completion);
  return (
    original ?? {
      exitCode: 1,
      stdout: "",
      // "quota exhausted" is deliberate: classifyProcessOutcome treats that
      // phrase as a provider limit (wait) rather than a planner bug.
      stderr:
        completion.reason === "all_exhausted"
          ? `Model pool quota exhausted (${completion.reason}): ${completion.message}`
          : `Model pool cannot plan (${completion.reason}): ${completion.message}`,
      timedOut: false,
      finalMessage: "",
    }
  );
}
