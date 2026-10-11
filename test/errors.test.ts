import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "../src/errors.js";
import { createRedactor } from "../src/secrets.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const redact = createRedactor(["secret-key-value-1"]);

function classify(input: {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  networkError?: Error;
}) {
  return classifyProviderFailure(
    {
      status: input.status ?? null,
      headers: new Headers(input.headers ?? {}),
      body: input.body ?? "",
      ...(input.networkError ? { networkError: input.networkError } : {}),
    },
    { now: NOW, redact },
  );
}

describe("classifyProviderFailure", () => {
  it("classifies 401 as an auth error, not a quota problem", () => {
    const failure = classify({
      status: 401,
      body: '{"error":"Invalid API key"}',
    });
    expect(failure.category).toBe("auth_error");
    expect(failure.retryAfterMs).toBeNull();
  });

  it("treats a plan restriction on one model as an unsupported model, not a provider-wide auth failure", () => {
    for (const body of [
      '{"errors":[{"message":"AiError: Model @cf/x/y is not available on the Workers Free plan"}]}',
      '{"error":"This model requires a paid plan"}',
      '{"error":"Please upgrade your plan to use this model"}',
    ]) {
      expect(classify({ status: 403, body }).category).toBe(
        "model_unsupported",
      );
    }
    expect(
      classify({ status: 403, body: '{"error":"Forbidden"}' }).category,
    ).toBe("auth_error");
  });

  it("classifies 403 permission failures as auth errors", () => {
    expect(
      classify({ status: 403, body: '{"error":{"message":"Forbidden"}}' })
        .category,
    ).toBe("auth_error");
  });

  it("classifies a plain 429 as rate limited and honours Retry-After seconds", () => {
    const failure = classify({
      status: 429,
      headers: { "retry-after": "30" },
      body: '{"error":{"message":"Too many requests"}}',
    });
    expect(failure.category).toBe("rate_limited");
    expect(failure.retryAfterMs).toBe(30_000);
  });

  it("honours a Retry-After HTTP date relative to now", () => {
    const failure = classify({
      status: 429,
      headers: { "retry-after": "Mon, 21 Sep 2026 12:01:00 GMT" },
    });
    expect(failure.retryAfterMs).toBe(60_000);
  });

  it("falls back to provider reset headers written as durations", () => {
    const failure = classify({
      status: 429,
      headers: { "x-ratelimit-reset-requests": "2m59.5s" },
    });
    expect(failure.retryAfterMs).toBe(179_500);
  });

  it("reads a Gemini-style retryDelay from the error body", () => {
    const failure = classify({
      status: 429,
      body: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"27s"}]}}',
    });
    expect(failure.category).toBe("rate_limited");
    expect(failure.retryAfterMs).toBe(27_000);
  });

  it("separates an exhausted quota or credit balance from a transient rate limit", () => {
    for (const body of [
      '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
      '{"error":"Daily request limit reached"}',
      '{"error":"You have run out of credits"}',
    ]) {
      expect(classify({ status: 429, body }).category).toBe("quota_exhausted");
    }
  });

  it("treats 402 payment required as quota exhausted, never as something to buy", () => {
    const failure = classify({ status: 402, body: "payment required" });
    expect(failure.category).toBe("quota_exhausted");
  });

  it("classifies an unknown or retired model separately from an outage", () => {
    for (const [status, body] of [
      [404, '{"error":{"message":"The model `foo` does not exist"}}'],
      [400, '{"error":{"message":"model_not_found: foo is not supported"}}'],
      [400, '{"error":{"message":"The model has been decommissioned"}}'],
    ] as const) {
      expect(classify({ status, body }).category).toBe("model_unsupported");
    }
  });

  it("classifies 5xx and overload as temporary", () => {
    for (const status of [500, 502, 503, 504, 529]) {
      expect(classify({ status, body: "upstream" }).category).toBe(
        "temporary_error",
      );
    }
  });

  it("classifies network failures and timeouts as temporary", () => {
    expect(
      classify({ networkError: new Error("fetch failed: ECONNRESET") })
        .category,
    ).toBe("temporary_error");
    const timeout = Object.assign(new Error("timed out"), {
      name: "TimeoutError",
    });
    expect(classify({ networkError: timeout }).category).toBe(
      "temporary_error",
    );
  });

  it("classifies other 4xx as a bad request that says nothing about provider health", () => {
    expect(
      classify({ status: 400, body: "messages must not be empty" }).category,
    ).toBe("bad_request");
    expect(classify({ status: 422, body: "unprocessable" }).category).toBe(
      "bad_request",
    );
  });

  it("redacts secrets and bounds the persisted message", () => {
    const failure = classify({
      status: 401,
      body: `Invalid key secret-key-value-1 ${"x".repeat(2000)}`,
    });
    expect(failure.message).not.toContain("secret-key-value-1");
    expect(failure.message.length).toBeLessThanOrEqual(240);
  });

  it("caps an absurd Retry-After so one header cannot park a provider for days", () => {
    const failure = classify({
      status: 429,
      headers: { "retry-after": "99999999" },
    });
    expect(failure.retryAfterMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
});
