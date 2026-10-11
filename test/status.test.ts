import { describe, expect, it } from "vitest";
import type { PoolSnapshot, ProviderSnapshot } from "../src/pool.js";
import {
  agentDisplayState,
  formatProviderStatus,
  formatValidationTable,
} from "../src/status.js";

function provider(
  over: Partial<ProviderSnapshot> & { id: string },
): ProviderSnapshot {
  return {
    displayName: over.id,
    configured: true,
    state: "AVAILABLE",
    totalModels: 3,
    eligibleModels: 3,
    usableModels: 3,
    retryAfter: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    failureCategory: null,
    consecutiveFailures: 0,
    ...over,
  };
}

const snapshot: PoolSnapshot = {
  updatedAt: "2026-09-21T12:00:00.000Z",
  providers: [
    provider({ id: "gemini", displayName: "Gemini", usableModels: 4 }),
    provider({
      id: "groq",
      displayName: "Groq",
      state: "RATE_LIMITED",
      usableModels: 0,
      retryAfter: "2026-09-21T12:30:00.000Z",
    }),
    provider({
      id: "vercel",
      displayName: "Vercel AI Gateway",
      state: "AUTH_ERROR",
      usableModels: 0,
    }),
    provider({
      id: "zai",
      displayName: "Z.ai",
      configured: false,
      state: "NOT_CONFIGURED",
      totalModels: 0,
      eligibleModels: 0,
      usableModels: 0,
    }),
  ],
  configured: ["gemini", "groq", "vercel"],
  available: ["gemini"],
  temporarilyUnavailable: ["groq"],
  usableModels: 4,
  selected: { provider: "gemini", model: "gemini-flash-latest" },
  lastFallback: {
    at: "2026-09-21T11:59:00.000Z",
    from: "groq/openai/gpt-oss-120b",
    to: "gemini/gemini-flash-latest",
    reason: "rate_limited",
  },
};

describe("agentDisplayState", () => {
  it("maps an external agent's availability onto pool vocabulary", () => {
    expect(
      agentDisplayState({
        name: "alpha-cli",
        available: true,
        unavailable_reason: null,
      }),
    ).toBe("AVAILABLE");
    expect(
      agentDisplayState({
        name: "beta-cli",
        available: false,
        unavailable_reason:
          "Scheduler: quota/rate limit detected, cooling down until 2026-09-21T13:00:00.000Z",
      }),
    ).toBe("QUOTA_EXHAUSTED");
    expect(
      agentDisplayState({
        name: "beta-cli",
        available: false,
        unavailable_reason: "disabled by operator",
      }),
    ).toBe("UNAVAILABLE");
  });
});

describe("formatProviderStatus", () => {
  const text = formatProviderStatus(snapshot, [
    { name: "alpha-cli", available: true, unavailable_reason: null },
    {
      name: "beta-cli",
      available: false,
      unavailable_reason:
        "Scheduler: quota/rate limit detected, cooling down until 2026-09-21T13:00:00.000Z",
    },
  ]);

  it("lists every provider with a normalized state, external agents first", () => {
    const lines = text.split("\n");
    const at = (name: string) =>
      lines.findIndex((line) => line.trimStart().startsWith(name));
    expect(at("Alpha-cli")).toBeGreaterThan(-1);
    expect(at("Alpha-cli")).toBeLessThan(at("Gemini"));
    expect(text).toMatch(/Alpha-cli\s+AVAILABLE/);
    expect(text).toMatch(/Beta-cli\s+QUOTA_EXHAUSTED/);
    expect(text).toMatch(/Gemini\s+AVAILABLE/);
    expect(text).toMatch(/Groq\s+RATE_LIMITED/);
    expect(text).toMatch(/Vercel AI Gateway\s+AUTH_ERROR/);
    expect(text).toMatch(/Z\.ai\s+NOT_CONFIGURED/);
  });

  it("shows when a blocked provider returns and how many models are usable", () => {
    expect(text).toContain("2026-09-21T12:30:00.000Z");
    expect(text).toMatch(/Gemini.*4 usable model/);
  });

  it("summarizes configured, available and temporarily unavailable providers", () => {
    expect(text).toMatch(/Configured providers:\s*gemini, groq, vercel/);
    expect(text).toMatch(/Available providers:\s*gemini/);
    expect(text).toMatch(/Temporarily unavailable providers:\s*groq/);
    expect(text).toMatch(/Usable pool models:\s*4/);
  });

  it("shows the selected model and the last fallback reason", () => {
    expect(text).toMatch(/Selected:\s*gemini\/gemini-flash-latest/);
    expect(text).toMatch(
      /Last fallback:.*groq\/openai\/gpt-oss-120b.*gemini\/gemini-flash-latest.*rate_limited/,
    );
  });

  it("says so plainly when nothing has been selected or fallen back yet", () => {
    const empty = formatProviderStatus(
      { ...snapshot, selected: null, lastFallback: null },
      [],
    );
    expect(empty).toMatch(/Selected:\s*none/);
    expect(empty).toMatch(/Last fallback:\s*none/);
  });

  it("never prints anything that looks like a credential", () => {
    expect(text).not.toMatch(/key|token|secret/i);
  });
});

describe("formatValidationTable", () => {
  it("renders the smoke-test table with the requested columns", () => {
    const table = formatValidationTable([
      {
        provider: "groq",
        displayName: "Groq",
        configured: true,
        authOk: true,
        freeModelReachable: true,
        status: "AVAILABLE",
        model: "openai/gpt-oss-20b",
        notes: "free_tier model answered",
        at: "x",
      },
      {
        provider: "zai",
        displayName: "Z.ai",
        configured: false,
        authOk: false,
        freeModelReachable: false,
        status: "NOT_CONFIGURED",
        model: null,
        notes: "no API key configured",
        at: "x",
      },
    ]);
    const [header, , groq, zai] = table.split("\n");
    expect(header).toMatch(
      /Provider\s*\|\s*Configured\s*\|\s*Auth OK\s*\|\s*Free model reachable\s*\|\s*Status\s*\|\s*Notes/,
    );
    expect(groq).toMatch(
      /Groq\s*\|\s*yes\s*\|\s*yes\s*\|\s*yes\s*\|\s*AVAILABLE/,
    );
    expect(zai).toMatch(
      /Z\.ai\s*\|\s*no\s*\|\s*no\s*\|\s*no\s*\|\s*NOT_CONFIGURED/,
    );
  });
});
