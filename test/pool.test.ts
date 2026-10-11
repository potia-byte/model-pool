import { describe, expect, it } from "vitest";
import { createModelPool, type PoolStore } from "../src/pool.js";
import { catalogSchema } from "../src/catalog.js";

const START = new Date("2026-09-21T12:00:00.000Z");

const KEYS = {
  A_KEY: "key-alpha-1111111111",
  B_KEY: "key-bravo-2222222222",
  C_KEY: "key-charlie-3333333333",
};

function catalog(extra: Record<string, unknown> = {}) {
  const rules = (coding: number, reasoning: number, pricing?: string) => [
    {
      match: "^good",
      coding,
      reasoning,
      toolCalling: true,
      structuredOutput: true,
      contextWindow: 100000,
      ...(pricing ? { pricing } : {}),
    },
  ];
  return catalogSchema.parse({
    version: 1,
    providers: {
      alpha: {
        displayName: "Alpha",
        envKeys: ["A_KEY"],
        baseUrl: "https://alpha.test/v1",
        defaultPricing: "free_tier",
        rules: rules(3, 3),
        validationModel: "good-a",
      },
      bravo: {
        displayName: "Bravo",
        envKeys: ["B_KEY"],
        baseUrl: "https://bravo.test/v1",
        defaultPricing: "free_tier",
        rules: rules(2, 2),
      },
      charlie: {
        displayName: "Charlie",
        envKeys: ["C_KEY"],
        baseUrl: "https://charlie.test/v1",
        defaultPricing: "free_tier",
        rules: rules(2, 2),
      },
      ...extra,
    },
  });
}

interface Call {
  host: string;
  path: string;
  method: string;
  auth: string | null;
  body: Record<string, unknown> | null;
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  throws?: Error;
}

type Handler = (call: Call) => Reply;

function fakeFetch(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers);
    const call: Call = {
      host: url.hostname,
      path: url.pathname,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null,
    };
    calls.push(call);
    const handler = handlers[url.hostname];
    if (!handler) throw new Error(`unexpected host ${url.hostname}`);
    const reply = handler(call);
    if (reply.throws) throw reply.throws;
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...(reply.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const models = (...ids: string[]) => ({ data: ids.map((id) => ({ id })) });
const chatOk = (text: string, model = "good-a") => ({
  model,
  choices: [{ message: { role: "assistant", content: text } }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
});

/** A provider whose /models works and whose chat completions run `chat`. */
function provider(ids: string[], chat: Handler): Handler {
  return (call) =>
    call.path.endsWith("/models") ? { body: models(...ids) } : chat(call);
}

function memoryStore(initial: unknown = null): PoolStore & { data: unknown } {
  const store = {
    data: initial,
    load: async () => store.data,
    save: async (value: unknown) => {
      store.data = JSON.parse(JSON.stringify(value));
    },
  };
  return store;
}

function harness(
  handlers: Record<string, Handler>,
  options: {
    env?: Record<string, string>;
    store?: ReturnType<typeof memoryStore>;
    catalogExtra?: Record<string, unknown>;
  } = {},
) {
  const net = fakeFetch(handlers);
  const clock = { now: START.getTime() };
  const logs: string[] = [];
  const store = options.store ?? memoryStore();
  const pool = createModelPool({
    root: "unused",
    catalog: catalog(options.catalogExtra),
    env: options.env ?? KEYS,
    fetch: net.fetch,
    now: () => new Date(clock.now),
    store,
    log: (line) => {
      logs.push(line);
    },
  });
  return { pool, calls: net.calls, clock, logs, store };
}

const qaRequest = { role: "qa_review", prompt: "review this diff" } as const;

describe("ModelPool.refresh", () => {
  it("skips providers whose key is absent without failing the pool", async () => {
    const { pool, calls } = harness(
      { "alpha.test": provider(["good-a"], () => ({ body: chatOk("x") })) },
      { env: { A_KEY: KEYS.A_KEY } },
    );
    await pool.refresh();
    expect(calls.map((call) => call.host)).toEqual(["alpha.test"]);
    const snapshot = pool.snapshot();
    expect(snapshot.providers.find((p) => p.id === "bravo")?.state).toBe(
      "NOT_CONFIGURED",
    );
    expect(snapshot.configured).toEqual(["alpha"]);
  });

  it("discovers models, grades them, and counts ungraded ones as unusable", async () => {
    const { pool } = harness(
      {
        "alpha.test": provider(["good-a", "mystery"], () => ({
          body: chatOk("x"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY } },
    );
    await pool.refresh();
    const alpha = pool.snapshot().providers.find((p) => p.id === "alpha");
    expect(alpha?.totalModels).toBe(2);
    expect(alpha?.usableModels).toBe(1);
    expect(alpha?.state).toBe("AVAILABLE");
  });

  it("isolates an auth failure found during discovery to that provider", async () => {
    const { pool } = harness({
      "alpha.test": () => ({ status: 401, body: { error: "Invalid API key" } }),
      "bravo.test": provider(["good-b"], () => ({
        body: chatOk("x", "good-b"),
      })),
      "charlie.test": provider(["good-c"], () => ({
        body: chatOk("x", "good-c"),
      })),
    });
    await pool.refresh();
    const states = Object.fromEntries(
      pool.snapshot().providers.map((p) => [p.id, p.state]),
    );
    expect(states.alpha).toBe("AUTH_ERROR");
    expect(states.bravo).toBe("AVAILABLE");
    expect(states.charlie).toBe("AVAILABLE");
  });

  it("looks up the Cloudflare-style account id from the token when the env does not supply it", async () => {
    const { pool, calls } = harness(
      {
        "cf.test": (call) =>
          call.path === "/client/v4/accounts"
            ? { body: { success: true, result: [{ id: "acct123" }] } }
            : call.path.endsWith("/models/search")
              ? { body: { result: [{ name: "good-cf" }] } }
              : { body: chatOk("x", "good-cf") },
      },
      {
        env: { CF_TOKEN: "cf-token-value-123456" },
        catalogExtra: {
          cf: {
            displayName: "CF",
            envKeys: ["CF_TOKEN"],
            baseUrl: "https://cf.test/client/v4/accounts/{CF_ACCOUNT}/ai/v1",
            accountLookupUrl: "https://cf.test/client/v4/accounts",
            discovery: "cloudflare-search",
            discoveryPath: "/../models/search?per_page=100",
            defaultPricing: "free_tier",
            rules: [
              {
                match: "^good",
                coding: 2,
                reasoning: 2,
                contextWindow: 100000,
              },
            ],
          },
        },
      },
    );
    await pool.refresh();
    expect(
      calls.some(
        (call) => call.path === "/client/v4/accounts/acct123/ai/models/search",
      ),
    ).toBe(true);
    expect(
      pool.snapshot().providers.find((p) => p.id === "cf")?.usableModels,
    ).toBe(1);
  });

  it("falls back to configured static models when discovery yields nothing", async () => {
    const { pool } = harness(
      { "static.test": () => ({ body: { data: [] } }) },
      {
        env: { S_KEY: "static-key-value-1" },
        catalogExtra: {
          statik: {
            displayName: "Static",
            envKeys: ["S_KEY"],
            baseUrl: "https://static.test/v1",
            defaultPricing: "free_tier",
            staticModels: ["good-static"],
            rules: [
              {
                match: "^good",
                coding: 2,
                reasoning: 2,
                contextWindow: 100000,
              },
            ],
          },
        },
      },
    );
    await pool.refresh();
    expect(
      pool.snapshot().providers.find((p) => p.id === "statik")?.usableModels,
    ).toBe(1);
  });
});

describe("ModelPool.complete fallback", () => {
  it("falls through to another provider when the best one is quota exhausted", async () => {
    const { pool, calls } = harness({
      "alpha.test": provider(["good-a"], () => ({
        status: 429,
        body: {
          error: {
            code: "insufficient_quota",
            message: "You exceeded your current quota",
          },
        },
      })),
      "bravo.test": provider(["good-b"], () => ({
        body: chatOk("VERDICT", "good-b"),
      })),
      "charlie.test": provider(["good-c"], () => ({
        body: chatOk("VERDICT", "good-c"),
      })),
    });
    await pool.refresh();
    const result = await pool.complete(qaRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("bravo");
    expect(result.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual([
      "alpha:quota_exhausted",
      "bravo:success",
    ]);
    const snapshot = pool.snapshot();
    expect(snapshot.providers.find((p) => p.id === "alpha")?.state).toBe(
      "QUOTA_EXHAUSTED",
    );
    expect(snapshot.lastFallback?.reason).toMatch(/quota_exhausted/);
    expect(snapshot.lastFallback?.from).toBe("alpha/good-a");
    expect(snapshot.lastFallback?.to).toBe("bravo/good-b");
    expect(snapshot.selected).toEqual({ provider: "bravo", model: "good-b" });
    // The exhausted model must not be hit again by the next request.
    calls.length = 0;
    await pool.complete(qaRequest);
    expect(
      calls.filter((c) => c.host === "alpha.test" && c.path.includes("chat")),
    ).toHaveLength(0);
  });

  it("classifies 429 with Retry-After and returns the model once the reset has passed", async () => {
    let alphaCalls = 0;
    const { pool, clock } = harness(
      {
        "alpha.test": provider(["good-a"], () => {
          alphaCalls += 1;
          return alphaCalls === 1
            ? {
                status: 429,
                headers: { "retry-after": "120" },
                body: { error: "slow down" },
              }
            : { body: chatOk("BACK", "good-a") };
        }),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY } },
    );
    await pool.refresh();

    const first = await pool.complete(qaRequest);
    expect(first.ok && first.provider).toBe("bravo");
    const limited = pool.snapshot().providers.find((p) => p.id === "alpha");
    expect(limited?.state).toBe("RATE_LIMITED");
    expect(limited?.retryAfter).toBe(
      new Date(START.getTime() + 120_000).toISOString(),
    );

    clock.now += 119_000;
    expect((await pool.complete(qaRequest)).ok && "bravo").toBe("bravo");

    clock.now += 2_000;
    const back = await pool.complete(qaRequest);
    expect(back.ok && back.provider).toBe("alpha");
    expect(pool.snapshot().providers.find((p) => p.id === "alpha")?.state).toBe(
      "AVAILABLE",
    );
  });

  it("isolates an auth failure: the bad provider is skipped and never retried", async () => {
    const { pool, calls } = harness(
      {
        "alpha.test": provider(["good-a"], () => ({
          status: 401,
          body: { error: "Invalid API key" },
        })),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY } },
    );
    await pool.refresh();
    const first = await pool.complete(qaRequest);
    expect(first.ok && first.provider).toBe("bravo");
    expect(pool.snapshot().providers.find((p) => p.id === "alpha")?.state).toBe(
      "AUTH_ERROR",
    );
    calls.length = 0;
    await pool.complete(qaRequest);
    expect(calls.filter((c) => c.host === "alpha.test")).toHaveLength(0);
  });

  it("treats a 5xx as temporary and continues with another provider", async () => {
    const { pool } = harness(
      {
        "alpha.test": provider(["good-a"], () => ({
          status: 503,
          body: { error: "overloaded" },
        })),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY } },
    );
    await pool.refresh();
    const result = await pool.complete(qaRequest);
    expect(result.ok && result.provider).toBe("bravo");
    expect(pool.snapshot().providers.find((p) => p.id === "alpha")?.state).toBe(
      "TEMPORARY_ERROR",
    );
  });

  it("keeps going when one provider is unreachable (network error)", async () => {
    const { pool } = harness(
      {
        "alpha.test": provider(["good-a"], () => ({
          throws: new Error("fetch failed: ECONNREFUSED"),
        })),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY } },
    );
    await pool.refresh();
    const result = await pool.complete(qaRequest);
    expect(result.ok && result.provider).toBe("bravo");
  });

  it("does not crash when ten providers are all unavailable, and reports the earliest reset", async () => {
    const extra: Record<string, unknown> = {};
    const handlers: Record<string, Handler> = {};
    const env: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) {
      extra[`p${i}`] = {
        displayName: `P${i}`,
        envKeys: [`P${i}_KEY`],
        baseUrl: `https://p${i}.test/v1`,
        defaultPricing: "free_tier",
        rules: [
          { match: "^good", coding: 2, reasoning: 2, contextWindow: 100000 },
        ],
      };
      env[`P${i}_KEY`] = `p-key-value-${i}-xxxxxxxx`;
      handlers[`p${i}.test`] = provider(["good-x"], () => ({
        status: 429,
        headers: { "retry-after": String(60 * (i + 1)) },
        body: { error: "rate limited" },
      }));
    }
    const { pool } = harness(handlers, { env, catalogExtra: extra });
    await pool.refresh();
    const result = await pool.complete(qaRequest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("all_exhausted");
    expect(result.earliestRetryAt).toBe(
      new Date(START.getTime() + 60_000).toISOString(),
    );
    expect(pool.capacity("qa_review").exhaustedByCapacity).toBe(true);
  });

  it("enters exhausted state only when every compatible model is blocked, then recovers", async () => {
    const { pool, clock } = harness(
      {
        "alpha.test": provider(["good-a"], () =>
          clock.now < START.getTime() + 600_000
            ? {
                status: 429,
                headers: { "retry-after": "300" },
                body: { error: "limit" },
              }
            : { body: chatOk("OK", "good-a") },
        ),
      },
      { env: { A_KEY: KEYS.A_KEY } },
    );
    await pool.refresh();
    const blocked = await pool.complete(qaRequest);
    expect(blocked.ok).toBe(false);
    expect(pool.capacity("qa_review")).toMatchObject({
      usable: 0,
      exhaustedByCapacity: true,
    });
    clock.now += 301_000;
    expect(pool.capacity("qa_review").usable).toBe(1);
    clock.now += 400_000;
    const recovered = await pool.complete(qaRequest);
    expect(recovered.ok).toBe(true);
  });

  it("refuses to route a task no pool model is capable of, without calling anything", async () => {
    const { pool, calls } = harness(
      {
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      { env: { B_KEY: KEYS.B_KEY } },
    );
    await pool.refresh();
    calls.length = 0;
    const result = await pool.complete({
      role: "qa_review",
      prompt: "x",
      requirements: { minCoding: 3, minReasoning: 3 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_compatible_provider");
    expect(calls).toHaveLength(0);
  });

  it("never calls a paid model while paid API spend is disabled", async () => {
    const { pool, calls } = harness(
      {
        "paid.test": provider(["good-paid"], () => ({
          body: chatOk("$$$", "good-paid"),
        })),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      {
        env: { B_KEY: KEYS.B_KEY, PAID_KEY: "paid-key-value-123456" },
        catalogExtra: {
          paid: {
            displayName: "Paid",
            envKeys: ["PAID_KEY"],
            baseUrl: "https://paid.test/v1",
            defaultPricing: "paid",
            rules: [{ match: "^good", coding: 3, reasoning: 3 }],
          },
        },
      },
    );
    await pool.refresh();
    const result = await pool.complete(qaRequest);
    expect(result.ok && result.provider).toBe("bravo");
    expect(
      calls.filter((c) => c.host === "paid.test" && c.path.includes("chat")),
    ).toHaveLength(0);
    expect(
      pool.snapshot().providers.find((p) => p.id === "paid")?.usableModels,
    ).toBe(0);
  });

  it("stops early when providers keep rejecting the request itself, instead of burning quota across the pool", async () => {
    const extra: Record<string, unknown> = {};
    const handlers: Record<string, Handler> = {};
    const env: Record<string, string> = {};
    for (let i = 0; i < 12; i += 1) {
      extra[`q${i}`] = {
        displayName: `Q${i}`,
        envKeys: [`Q${i}_KEY`],
        baseUrl: `https://q${i}.test/v1`,
        defaultPricing: "free_tier",
        rules: [
          { match: "^good", coding: 2, reasoning: 2, contextWindow: 100000 },
        ],
      };
      env[`Q${i}_KEY`] = `q-key-value-${i}-xxxxxxxx`;
      handlers[`q${i}.test`] = provider(["good-x"], () => ({
        status: 400,
        body: "messages must not be empty",
      }));
    }
    const { pool, calls } = harness(handlers, { env, catalogExtra: extra });
    await pool.refresh();
    calls.length = 0;
    const result = await pool.complete(qaRequest);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("request_rejected");
    expect(calls).toHaveLength(3);
    // A malformed request says nothing about provider health.
    expect(
      pool
        .snapshot()
        .providers.filter((p) => p.configured)
        .every((p) => p.state === "AVAILABLE"),
    ).toBe(true);
  });

  it("records the actual model and upstream provider an aggregator served, without credentials", async () => {
    const { pool } = harness(
      {
        "router.test": provider(["router/free"], () => ({
          body: {
            model: "vendor/actual-model:free",
            provider: "SomeHost",
            choices: [{ message: { content: "hi" } }],
          },
        })),
      },
      {
        env: { R_KEY: "router-key-value-12345" },
        catalogExtra: {
          router: {
            displayName: "Router",
            envKeys: ["R_KEY"],
            baseUrl: "https://router.test/v1",
            defaultPricing: "free_tier",
            rules: [
              {
                match: "^router/free$",
                coding: 2,
                reasoning: 2,
                contextWindow: 100000,
              },
            ],
          },
        },
      },
    );
    await pool.refresh();
    const result = await pool.complete(qaRequest);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model).toBe("router/free");
    expect(result.actualModel).toBe("vendor/actual-model:free");
    expect(result.upstreamProvider).toBe("SomeHost");
  });

  it("sends the prompt as one user message with a bounded token budget and the bearer key", async () => {
    const { pool, calls } = harness(
      { "alpha.test": provider(["good-a"], () => ({ body: chatOk("ok") })) },
      { env: { A_KEY: KEYS.A_KEY } },
    );
    await pool.refresh();
    await pool.complete({ ...qaRequest, maxTokens: 512 });
    const chat = calls.find((c) => c.path.endsWith("/chat/completions"));
    expect(chat?.auth).toBe(`Bearer ${KEYS.A_KEY}`);
    expect(chat?.body).toMatchObject({
      model: "good-a",
      max_tokens: 512,
      messages: [{ role: "user", content: "review this diff" }],
    });
  });
});

describe("ModelPool.validate", () => {
  it("makes one tiny request per provider and reports auth and free-model reachability", async () => {
    const { pool, calls } = harness({
      "alpha.test": provider(["good-a"], () => ({ body: chatOk("OK") })),
      "bravo.test": () => ({ status: 401, body: { error: "Invalid API key" } }),
      "charlie.test": provider(["good-c"], () => ({
        status: 429,
        body: { error: { code: "insufficient_quota" } },
      })),
    });
    const report = await pool.validate();
    const by = Object.fromEntries(report.map((row) => [row.provider, row]));
    expect(by.alpha).toMatchObject({
      configured: true,
      authOk: true,
      freeModelReachable: true,
      status: "AVAILABLE",
    });
    expect(by.bravo).toMatchObject({
      configured: true,
      authOk: false,
      freeModelReachable: false,
      status: "AUTH_ERROR",
    });
    expect(by.charlie).toMatchObject({
      authOk: true,
      freeModelReachable: false,
      status: "QUOTA_EXHAUSTED",
    });
    const chats = calls.filter((c) => c.path.endsWith("/chat/completions"));
    expect(chats).toHaveLength(2); // bravo failed auth at discovery: no chat request at all
    for (const chat of chats) {
      expect(Number(chat.body?.max_tokens)).toBeLessThanOrEqual(16);
    }
  });

  it("skips the request and says so when a provider has no free model", async () => {
    const { pool, calls } = harness(
      { "paid.test": provider(["good-paid"], () => ({ body: chatOk("$$$") })) },
      {
        env: { PAID_KEY: "paid-key-value-123456" },
        catalogExtra: {
          paid: {
            displayName: "Paid",
            envKeys: ["PAID_KEY"],
            baseUrl: "https://paid.test/v1",
            defaultPricing: "paid",
            rules: [{ match: "^good", coding: 3, reasoning: 3 }],
          },
        },
      },
    );
    const report = await pool.validate();
    const row = report.find((r) => r.provider === "paid");
    expect(row).toMatchObject({
      configured: true,
      authOk: true,
      freeModelReachable: false,
    });
    expect(row?.notes).toMatch(/paid|billing/i);
    expect(
      calls.filter((c) => c.path.endsWith("/chat/completions")),
    ).toHaveLength(0);
  });

  it("reports unconfigured providers without contacting them", async () => {
    const { pool, calls } = harness({}, { env: {} });
    const report = await pool.validate();
    expect(report.every((row) => !row.configured)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("ModelPool secrecy and persistence", () => {
  it("never lets a key value reach logs, persisted state, results or snapshots", async () => {
    const echoing: Handler = (call) => ({
      status: 401,
      body: { error: { message: `Invalid key ${call.auth}` } },
    });
    const { pool, logs, store } = harness({
      "alpha.test": provider(["good-a"], echoing),
      "bravo.test": provider(["good-b"], () => ({
        status: 500,
        body: `upstream said key=${KEYS.B_KEY} broke`,
      })),
      "charlie.test": provider(["good-c"], () => ({
        throws: new Error(`connect failed for ${KEYS.C_KEY}`),
      })),
    });
    await pool.refresh();
    const result = await pool.complete(qaRequest);
    await pool.validate();
    const blob = JSON.stringify({
      result,
      logs,
      state: store.data,
      snapshot: pool.snapshot(),
      report: await pool.validate(),
    });
    for (const secret of Object.values(KEYS)) {
      expect(blob).not.toContain(secret);
    }
    expect(blob).not.toMatch(/Bearer\s+key-/);
  });

  it("persists health and the model list, and a fresh pool resumes from them", async () => {
    const store = memoryStore();
    const first = harness(
      {
        "alpha.test": provider(["good-a"], () => ({
          status: 429,
          headers: { "retry-after": "600" },
          body: {},
        })),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY }, store },
    );
    await first.pool.refresh();
    await first.pool.complete(qaRequest);

    const second = harness(
      {},
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY }, store },
    );
    await second.pool.load();
    const snapshot = second.pool.snapshot();
    expect(snapshot.providers.find((p) => p.id === "alpha")?.state).toBe(
      "RATE_LIMITED",
    );
    expect(snapshot.providers.find((p) => p.id === "bravo")?.usableModels).toBe(
      1,
    );
    expect(snapshot.selected).toEqual({ provider: "bravo", model: "good-b" });
  });

  it("starts empty instead of failing when the persisted state is corrupt", async () => {
    const { pool } = harness(
      {},
      { store: memoryStore({ garbage: [1, 2, 3] }) },
    );
    await pool.load();
    expect(pool.snapshot().providers.every((p) => p.usableModels === 0)).toBe(
      true,
    );
  });
});

describe("ModelPool.completeOn (single-model call for the orchestrator)", () => {
  const withEffort = (extra: Record<string, unknown> = {}) => ({
    alpha: {
      displayName: "Alpha",
      envKeys: ["A_KEY"],
      baseUrl: "https://alpha.test/v1",
      defaultPricing: "free_tier",
      effort: { kind: "reasoning_effort" },
      rules: [
        { match: "^good", coding: 3, reasoning: 3, contextWindow: 100000 },
      ],
      ...extra,
    },
  });

  function alphaOnly(chat: Handler, catalogExtra = withEffort()) {
    return harness(
      { "alpha.test": provider(["good-a"], chat) },
      { env: { A_KEY: KEYS.A_KEY }, catalogExtra },
    );
  }

  it("calls exactly the requested model, sends the effort setting and reports it applied", async () => {
    const { pool, calls } = alphaOnly(() => ({ body: chatOk("done") }));
    await pool.refresh();
    const result = await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p", effort: "HIGH" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.effortApplied).toBe(true);
    const chat = calls.find((c) => c.path.endsWith("/chat/completions"));
    expect(chat?.body).toMatchObject({
      model: "good-a",
      reasoning_effort: "high",
    });
  });

  it("omits the effort setting for a provider without an effort control", async () => {
    const { pool, calls } = alphaOnly(
      () => ({ body: chatOk("done") }),
      withEffort({ effort: undefined }),
    );
    await pool.refresh();
    const result = await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p", effort: "HIGH" },
    );
    expect(result.ok && result.effortApplied).toBe(false);
    expect(
      calls.find((c) => c.path.endsWith("/chat/completions"))?.body,
    ).not.toHaveProperty("reasoning_effort");
  });

  it("retries once without effort when the provider rejects it, and remembers that", async () => {
    let attempts = 0;
    const { pool, calls } = alphaOnly((call) => {
      attempts += 1;
      return call.body && "reasoning_effort" in call.body
        ? {
            status: 400,
            body: { error: { message: "Unknown parameter: reasoning_effort" } },
          }
        : { body: chatOk("done") };
    });
    await pool.refresh();
    const first = await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p", effort: "LOW" },
    );
    expect(first.ok && first.effortApplied).toBe(false);
    expect(attempts).toBe(2);
    await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p", effort: "LOW" },
    );
    expect(attempts).toBe(3); // no second rejected attempt
    expect(
      calls.filter((c) => c.body && "reasoning_effort" in c.body),
    ).toHaveLength(1);
    expect(
      pool.routingCandidates(new Date(START))[0]?.model.effortControl,
    ).toBeUndefined();
  });

  it("returns a classified failure and updates health without falling back to another model", async () => {
    const { pool, calls } = harness(
      {
        "alpha.test": provider(["good-a"], () => ({
          status: 429,
          headers: { "retry-after": "90" },
          body: { error: "slow" },
        })),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY } },
    );
    await pool.refresh();
    const result = await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.category).toBe("rate_limited");
    expect(result.retryAfter).toBe(
      new Date(START.getTime() + 90_000).toISOString(),
    );
    expect(
      calls.filter((c) => c.host === "bravo.test" && c.path.includes("chat")),
    ).toHaveLength(0);
    expect(pool.snapshot().providers.find((p) => p.id === "alpha")?.state).toBe(
      "RATE_LIMITED",
    );
  });

  it("refuses a model that is not in the pool or is not permitted by policy", async () => {
    const { pool, calls } = harness(
      { "paid.test": provider(["good-paid"], () => ({ body: chatOk("$") })) },
      {
        env: { PAID_KEY: "paid-key-value-123456" },
        catalogExtra: {
          paid: {
            displayName: "Paid",
            envKeys: ["PAID_KEY"],
            baseUrl: "https://paid.test/v1",
            defaultPricing: "paid",
            rules: [
              {
                match: "^good",
                coding: 3,
                reasoning: 3,
                contextWindow: 100000,
              },
            ],
          },
        },
      },
    );
    await pool.refresh();
    const unknown = await pool.completeOn(
      { provider: "paid", model: "nope" },
      { prompt: "p" },
    );
    expect(unknown.ok).toBe(false);
    const paid = await pool.completeOn(
      { provider: "paid", model: "good-paid" },
      { prompt: "p" },
    );
    expect(paid.ok).toBe(false);
    expect(calls.filter((c) => c.path.includes("chat"))).toHaveLength(0);
  });
});

describe("ModelPool.routingCandidates", () => {
  it("exposes every configured model with its live health for external routers", async () => {
    const { pool } = harness(
      {
        "alpha.test": provider(["good-a"], () => ({
          status: 429,
          headers: { "retry-after": "60" },
          body: {},
        })),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("B", "good-b"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY } },
    );
    await pool.refresh();
    await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p" },
    );
    const states = Object.fromEntries(
      pool
        .routingCandidates(new Date(START))
        .map((c) => [c.model.provider, c.state]),
    );
    expect(states).toEqual({ alpha: "RATE_LIMITED", bravo: "AVAILABLE" });
  });
});

describe("ModelPool.complete avoid list (independent reviewers)", () => {
  const two = () =>
    harness(
      {
        "alpha.test": provider(["good-a"], () => ({
          body: chatOk("from alpha", "good-a"),
        })),
        "bravo.test": provider(["good-b"], () => ({
          body: chatOk("from bravo", "good-b"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY, B_KEY: KEYS.B_KEY } },
    );

  it("prefers a model that is not on the avoid list", async () => {
    const { pool } = two();
    await pool.refresh();
    const plain = await pool.complete(qaRequest);
    expect(plain.ok && plain.provider).toBe("alpha"); // the stronger model by default
    const independent = await pool.complete({
      ...qaRequest,
      avoid: ["alpha/good-a"],
    });
    expect(independent.ok && independent.provider).toBe("bravo");
  });

  it("falls back to an avoided model rather than failing when it is the only one", async () => {
    const { pool } = harness(
      {
        "alpha.test": provider(["good-a"], () => ({
          body: chatOk("from alpha", "good-a"),
        })),
      },
      { env: { A_KEY: KEYS.A_KEY } },
    );
    await pool.refresh();
    const result = await pool.complete({
      ...qaRequest,
      avoid: ["alpha/good-a"],
    });
    expect(result.ok && result.provider).toBe("alpha");
  });
});

describe("ModelPool.completeOn output-token limits", () => {
  it("learns a model's maximum output tokens from its rejection, retries once and remembers", async () => {
    const seen: number[] = [];
    const { pool } = harness(
      {
        "alpha.test": provider(["good-a"], (call) => {
          const requested = Number(call.body?.max_tokens);
          seen.push(requested);
          return requested > 4096
            ? {
                status: 400,
                body: {
                  message:
                    "too many tokens: max tokens must be less than or equal to 4096",
                },
              }
            : { body: chatOk("ok") };
        }),
      },
      { env: { A_KEY: KEYS.A_KEY } },
    );
    await pool.refresh();
    const first = await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p", maxTokens: 8000 },
    );
    expect(first.ok).toBe(true);
    expect(seen).toEqual([8000, 4096]);
    const second = await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p", maxTokens: 8000 },
    );
    expect(second.ok).toBe(true);
    expect(seen).toEqual([8000, 4096, 4096]);
  });

  it("does not loop when the stated limit is not smaller than what was requested", async () => {
    let calls = 0;
    const { pool } = harness(
      {
        "alpha.test": provider(["good-a"], () => {
          calls += 1;
          return {
            status: 400,
            body: { message: "max tokens must be less than or equal to 9999" },
          };
        }),
      },
      { env: { A_KEY: KEYS.A_KEY } },
    );
    await pool.refresh();
    calls = 0;
    const result = await pool.completeOn(
      { provider: "alpha", model: "good-a" },
      { prompt: "p", maxTokens: 4096 },
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });
});
