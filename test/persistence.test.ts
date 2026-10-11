import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogSchema } from "../src/catalog.js";
import { parseJsonResult } from "../src/json.js";
import { MODEL_POOL_FILE, createModelPool } from "../src/pool.js";

const NOW = new Date("2026-01-15T10:00:00.000Z");
const FIXTURE = new URL("./fixtures/pool-state.json", import.meta.url);

const catalog = catalogSchema.parse({
  version: 1,
  providers: {
    alpha: {
      displayName: "Alpha",
      envKeys: ["ALPHA_KEY"],
      baseUrl: "https://alpha.test/v1",
      defaultPricing: "free_tier",
    },
    bravo: {
      displayName: "Bravo",
      envKeys: ["BRAVO_KEY"],
      baseUrl: "https://bravo.test/v1",
      defaultPricing: "free",
    },
  },
});
const env = { ALPHA_KEY: "fixture-key-alpha-0001", BRAVO_KEY: "fixture-key-bravo-0002" };

function chatFetch(hosts: string[]) {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    hosts.push(url.hostname);
    return new Response(
      JSON.stringify({
        model: "model-small",
        choices: [{ message: { content: "pong" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("file-backed state", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pool-state-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("restores health from a persisted state file and routes around the blocked model", async () => {
    await mkdir(join(root, ".model-pool"), { recursive: true });
    await copyFile(FIXTURE, join(root, ".model-pool", MODEL_POOL_FILE));
    const hosts: string[] = [];
    const pool = createModelPool({
      root,
      catalog,
      env,
      now: () => NOW,
      fetch: chatFetch(hosts),
    });
    await pool.load();

    const snapshot = pool.snapshot();
    const states = Object.fromEntries(
      snapshot.providers.map((p) => [p.id, p.state]),
    );
    expect(states).toEqual({ alpha: "RATE_LIMITED", bravo: "AVAILABLE" });
    expect(snapshot.temporarilyUnavailable).toEqual(["alpha"]);

    const result = await pool.complete({ role: "planning", prompt: "ping" });
    expect(result.ok).toBe(true);
    expect(hosts).toEqual(["bravo.test"]);
  });

  it("writes state to a configurable directory and reloads it", async () => {
    const first = createModelPool({
      root,
      stateDirectory: "custom-state",
      catalog,
      env,
      now: () => NOW,
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string" ? input : input.toString(),
        );
        if (url.pathname.endsWith("/models")) {
          return new Response(
            JSON.stringify({ data: [{ id: "free-model" }] }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    await first.refresh();
    const raw = JSON.parse(
      await readFile(join(root, "custom-state", MODEL_POOL_FILE), "utf8"),
    ) as { version: number; models: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.models.length).toBeGreaterThan(0);

    const second = createModelPool({
      root,
      stateDirectory: "custom-state",
      catalog,
      env,
      now: () => NOW,
    });
    await second.load();
    expect(
      second.snapshot().providers.find((p) => p.id === "alpha"),
    ).toMatchObject({ totalModels: 1 });
  });

  it("ignores a corrupt state file instead of throwing", async () => {
    await mkdir(join(root, ".model-pool"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, ".model-pool", MODEL_POOL_FILE), "{ not json");
    const pool = createModelPool({ root, catalog, env, now: () => NOW });
    await expect(pool.load()).resolves.toBeUndefined();
    expect(pool.snapshot().updatedAt).toBeNull();
  });
});

describe("parseJsonResult", () => {
  it("parses plain and fenced JSON and throws on prose", () => {
    expect(parseJsonResult('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonResult('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(() => parseJsonResult("looks fine to me")).toThrow(SyntaxError);
  });
});
