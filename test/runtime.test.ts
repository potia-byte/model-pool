import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openModelPool } from "../src/runtime.js";

describe("openModelPool", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pool-runtime-"));
    await mkdir(join(root, ".model-pool"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("detects configured providers from the local env file without any network call", async () => {
    await writeFile(
      join(root, ".env"),
      "GROQ_API_KEY=groq-test-value-123\nMISTRAL_API_KEY=mistral-test-value-123\n",
    );
    const opened = await openModelPool(root, {
      env: {},
      fetch: (async () => {
        throw new Error("network must not be touched when opening the pool");
      }) as typeof fetch,
    });
    expect(opened.pool.snapshot().configured).toEqual(["groq", "mistral"]);
    expect(opened.enabled).toBe(true);
  });

  it("reports the env variable NAMES it found and never a value", async () => {
    await writeFile(
      join(root, ".env"),
      "GROQ_API_KEY=groq-test-value-123\n",
    );
    const opened = await openModelPool(root, { env: {} });
    const names = opened.envSummary.names;
    expect(names).toContain("GROQ_API_KEY");
    expect(JSON.stringify(opened.envSummary)).not.toContain(
      "groq-test-value-123",
    );
  });

  it("is disabled entirely by MODEL_POOL=off", async () => {
    await writeFile(
      join(root, ".env"),
      "GROQ_API_KEY=groq-test-value-123\n",
    );
    const opened = await openModelPool(root, {
      env: { MODEL_POOL: "off" },
    });
    expect(opened.enabled).toBe(false);
  });

  it("disables individual providers named in MODEL_POOL_DISABLED", async () => {
    await writeFile(
      join(root, ".env"),
      "GROQ_API_KEY=groq-test-value-123\nMISTRAL_API_KEY=mistral-test-value-123\n",
    );
    const opened = await openModelPool(root, {
      env: { MODEL_POOL_DISABLED: "groq" },
    });
    const states = Object.fromEntries(
      opened.pool.snapshot().providers.map((p) => [p.id, p.state]),
    );
    expect(states.groq).toBe("DISABLED");
    expect(states.mistral).toBe("UNVERIFIED");
  });

  it("cannot be switched into paid spending from the environment", async () => {
    await writeFile(
      join(root, ".env"),
      "VERCEL_AI_GATEWAY_API_KEY=vercel-test-value-123\n",
    );
    const opened = await openModelPool(root, {
      env: {
        ALLOW_PAID_API_SPEND: "true",
        MODEL_POOL_ALLOW_PAID: "1",
      },
    });
    expect(opened.policy.allowPaidApiSpend).toBe(false);
    expect(opened.policy.allowFreeModels).toBe(true);
  });

  it("works with no env file and no configured providers", async () => {
    const opened = await openModelPool(root, { env: {} });
    expect(opened.pool.snapshot().configured).toEqual([]);
    expect(opened.enabled).toBe(true);
  });
});
