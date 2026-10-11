/** Reasoning-effort level a caller may request for a pool call. */
export const efforts = ["LOW", "MEDIUM", "HIGH", "EXTRA_HIGH"] as const;
export type Effort = (typeof efforts)[number];

export type EffortControl = "reasoning_effort" | "openrouter_reasoning";

/**
 * Request-body fields for an OpenAI-compatible provider that supports an
 * effort setting. The top level maps to "high": the highest value these
 * providers accept.
 */
export function poolEffortBody(
  control: EffortControl,
  effort: Effort,
): Record<string, unknown> {
  const level = {
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
    EXTRA_HIGH: "high",
  }[effort];
  return control === "reasoning_effort"
    ? { reasoning_effort: level }
    : { reasoning: { effort: level } };
}
