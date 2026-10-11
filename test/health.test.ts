import { describe, expect, it } from "vitest";
import { HealthBook } from "../src/health.js";
import type { ProviderFailure } from "../src/types.js";

const T0 = new Date("2026-09-21T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function failure(
  category: ProviderFailure["category"],
  extra: Partial<ProviderFailure> = {},
): ProviderFailure {
  return {
    category,
    retryAfterMs: null,
    message: "boom",
    status: null,
    ...extra,
  };
}

describe("HealthBook", () => {
  it("starts AVAILABLE for anything it has never seen", () => {
    expect(new HealthBook().stateOf("groq", "m", T0)).toBe("AVAILABLE");
  });

  it("rate limits one model and leaves its sibling and provider available", () => {
    const book = new HealthBook();
    book.recordFailure(
      "groq",
      "m1",
      failure("rate_limited", { retryAfterMs: 30_000 }),
      T0,
    );
    expect(book.stateOf("groq", "m1", at(1000))).toBe("RATE_LIMITED");
    expect(book.stateOf("groq", "m2", at(1000))).toBe("AVAILABLE");
    expect(book.retryAfterOf("groq", "m1", at(1000))).toBe(
      at(30_000).toISOString(),
    );
  });

  it("returns a rate-limited model to the pool once the reset passes", () => {
    const book = new HealthBook();
    book.recordFailure(
      "groq",
      "m1",
      failure("rate_limited", { retryAfterMs: 30_000 }),
      T0,
    );
    expect(book.stateOf("groq", "m1", at(29_999))).toBe("RATE_LIMITED");
    expect(book.stateOf("groq", "m1", at(30_000))).toBe("AVAILABLE");
  });

  it("uses exponential backoff for rate limits that state no reset", () => {
    const book = new HealthBook();
    book.recordFailure("groq", "m1", failure("rate_limited"), T0);
    const first = Date.parse(book.retryAfterOf("groq", "m1", T0) ?? "");
    book.recordFailure("groq", "m1", failure("rate_limited"), T0);
    const second = Date.parse(book.retryAfterOf("groq", "m1", T0) ?? "");
    expect(second - T0.getTime()).toBe(2 * (first - T0.getTime()));
  });

  it("exhausts a quota with the provider's stated reset time", () => {
    const book = new HealthBook();
    book.recordFailure(
      "gemini",
      "m1",
      failure("quota_exhausted", { retryAfterMs: 3_600_000, status: 429 }),
      T0,
    );
    expect(book.stateOf("gemini", "m1", at(1000))).toBe("QUOTA_EXHAUSTED");
    expect(book.record("gemini", "m1")?.quotaResetAt).toBe(
      at(3_600_000).toISOString(),
    );
    expect(book.stateOf("gemini", "m1", at(3_600_000))).toBe("AVAILABLE");
  });

  it("treats 402 payment required as provider-wide exhaustion", () => {
    const book = new HealthBook();
    book.recordFailure(
      "huggingface",
      "m1",
      failure("quota_exhausted", { status: 402 }),
      T0,
    );
    expect(book.stateOf("huggingface", "other-model", at(1000))).toBe(
      "QUOTA_EXHAUSTED",
    );
  });

  it("isolates an auth failure to its provider and never expires it on a timer", () => {
    const book = new HealthBook();
    book.recordFailure(
      "vercel",
      "m1",
      failure("auth_error", { status: 401 }),
      T0,
    );
    expect(book.stateOf("vercel", "any", at(1000))).toBe("AUTH_ERROR");
    expect(book.stateOf("vercel", "any", at(30 * 24 * 3600 * 1000))).toBe(
      "AUTH_ERROR",
    );
    expect(book.stateOf("groq", "any", at(1000))).toBe("AVAILABLE");
  });

  it("clears an auth failure only through a successful call", () => {
    const book = new HealthBook();
    book.recordFailure(
      "vercel",
      "m1",
      failure("auth_error", { status: 401 }),
      T0,
    );
    book.recordSuccess("vercel", "m1", 120, at(5000));
    expect(book.stateOf("vercel", "m1", at(6000))).toBe("AVAILABLE");
    expect(book.record("vercel")?.consecutiveFailures).toBe(0);
  });

  it("clears only an auth failure on request, leaving provider-wide quota state alone", () => {
    const book = new HealthBook();
    book.recordFailure("a", "m", failure("auth_error", { status: 401 }), T0);
    book.clearAuthError("a");
    expect(book.stateOf("a", "m", at(1000))).toBe("AVAILABLE");

    book.recordFailure(
      "b",
      "m",
      failure("quota_exhausted", { status: 402 }),
      T0,
    );
    book.clearAuthError("b");
    expect(book.stateOf("b", "m", at(1000))).toBe("QUOTA_EXHAUSTED");
  });

  it("backs off temporary errors and escalates to UNAVAILABLE after repeated failures", () => {
    const book = new HealthBook();
    book.recordFailure(
      "mistral",
      "m1",
      failure("temporary_error", { status: 503 }),
      T0,
    );
    expect(book.stateOf("mistral", "m1", at(1000))).toBe("TEMPORARY_ERROR");
    for (let i = 0; i < 4; i += 1) {
      book.recordFailure(
        "mistral",
        "m1",
        failure("temporary_error", { status: 503 }),
        T0,
      );
    }
    expect(book.record("mistral")?.consecutiveFailures).toBe(5);
    expect(book.stateOf("mistral", "m1", at(1000))).toBe("UNAVAILABLE");
  });

  it("marks an unsupported model unavailable without touching the provider", () => {
    const book = new HealthBook();
    book.recordFailure(
      "groq",
      "gone",
      failure("model_unsupported", { status: 404 }),
      T0,
    );
    expect(book.stateOf("groq", "gone", at(1000))).toBe("UNAVAILABLE");
    expect(book.stateOf("groq", "alive", at(1000))).toBe("AVAILABLE");
  });

  it("ignores bad requests: they say nothing about provider health", () => {
    const book = new HealthBook();
    book.recordFailure(
      "groq",
      "m1",
      failure("bad_request", { status: 400 }),
      T0,
    );
    expect(book.stateOf("groq", "m1", at(1000))).toBe("AVAILABLE");
    expect(book.record("groq", "m1")).toBeUndefined();
  });

  it("reports DISABLED for policy-disabled providers regardless of health", () => {
    const book = new HealthBook();
    expect(
      book.stateOf("groq", "m1", T0, { disabledProviders: new Set(["groq"]) }),
    ).toBe("DISABLED");
  });

  it("tracks last success/failure and a smoothed latency", () => {
    const book = new HealthBook();
    book.recordSuccess("groq", "m1", 100, T0);
    book.recordSuccess("groq", "m1", 300, at(1000));
    const record = book.record("groq", "m1");
    expect(record?.lastSuccessAt).toBe(at(1000).toISOString());
    expect(record?.avgLatencyMs).toBeGreaterThan(100);
    expect(record?.avgLatencyMs).toBeLessThan(300);
    book.recordFailure("groq", "m1", failure("temporary_error"), at(2000));
    // Temporary errors are provider-wide, so the failure lands on the provider record.
    expect(book.record("groq")?.lastFailureAt).toBe(at(2000).toISOString());
  });

  it("round-trips through JSON without unknown fields or secrets", () => {
    const book = new HealthBook();
    book.recordFailure(
      "groq",
      "m1",
      failure("rate_limited", { retryAfterMs: 5000 }),
      T0,
    );
    const restored = HealthBook.fromJSON(
      JSON.parse(JSON.stringify(book.toJSON())),
    );
    expect(restored.stateOf("groq", "m1", at(1000))).toBe("RATE_LIMITED");
    expect(restored.toJSON()).toEqual(book.toJSON());
  });

  it("tolerates corrupt persisted state by starting empty", () => {
    expect(HealthBook.fromJSON({ nonsense: true }).stateOf("a", "b", T0)).toBe(
      "AVAILABLE",
    );
    expect(HealthBook.fromJSON(null).stateOf("a", "b", T0)).toBe("AVAILABLE");
  });
});
