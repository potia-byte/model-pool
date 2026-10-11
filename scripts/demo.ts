/**
 * Offline demo: routing, quota/error fallback and health states on a mocked
 * transport. No network, no API keys, nothing is written to disk.
 *
 *   npm run demo
 */
import { catalogSchema } from "../src/catalog.js";
import { runReviewWithFallback } from "../src/fallback.js";
import { createModelPool, type PoolStore } from "../src/pool.js";
import {
  DEFAULT_POOL_POLICY,
  requirementsForRole,
  routePool,
} from "../src/router.js";
import { formatProviderStatus } from "../src/status.js";

// ---- fictional providers (names, hosts and keys are made up) ---------------
const rule = (coding: number, reasoning: number) => [
  {
    match: "^m-",
    coding,
    reasoning,
    toolCalling: true,
    structuredOutput: true,
    contextWindow: 128000,
  },
];
const catalog = catalogSchema.parse({
  version: 1,
  providers: {
    alpha: {
      displayName: "Alpha (strong, free tier)",
      envKeys: ["ALPHA_KEY"],
      baseUrl: "https://alpha.example.test/v1",
      defaultPricing: "free_tier",
      rules: rule(3, 3),
    },
    bravo: {
      displayName: "Bravo (solid, free tier)",
      envKeys: ["BRAVO_KEY"],
      baseUrl: "https://bravo.example.test/v1",
      defaultPricing: "free_tier",
      rules: rule(2, 2),
    },
    charlie: {
      displayName: "Charlie (solid, free tier)",
      envKeys: ["CHARLIE_KEY"],
      baseUrl: "https://charlie.example.test/v1",
      defaultPricing: "free_tier",
      rules: rule(2, 2),
    },
    delta: {
      displayName: "Delta (metered)",
      envKeys: ["DELTA_KEY"],
      baseUrl: "https://delta.example.test/v1",
      defaultPricing: "paid",
      rules: rule(3, 3),
    },
    echo: {
      displayName: "Echo (no key)",
      envKeys: ["ECHO_KEY"],
      baseUrl: "https://echo.example.test/v1",
      defaultPricing: "free_tier",
      rules: rule(2, 2),
    },
  },
});
const env = {
  ALPHA_KEY: "demo-not-a-real-key-alpha",
  BRAVO_KEY: "demo-not-a-real-key-bravo",
  CHARLIE_KEY: "demo-not-a-real-key-charlie",
  DELTA_KEY: "demo-not-a-real-key-delta",
};

// ---- mocked transport: scripted replies per host ---------------------------
type Reply = { status: number; headers?: Record<string, string>; body: unknown };
const script = new Map<string, Reply[]>();
const wire: string[] = [];
const ok = (text: string, model: string): Reply => ({
  status: 200,
  body: {
    model,
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 20, completion_tokens: 6 },
  },
});
const rateLimited = (seconds: number): Reply => ({
  status: 429,
  headers: { "retry-after": String(seconds) },
  body: { error: { message: "Rate limit reached, slow down." } },
});
const quota = (): Reply => ({
  status: 429,
  body: { error: { message: "You exceeded your current quota (daily limit)." } },
});
const unauthorized = (): Reply => ({
  status: 401,
  body: { error: { message: "Invalid API key." } },
});
const queue = (host: string, ...replies: Reply[]) => {
  script.set(`${host}.example.test`, replies);
};

const mockFetch = (async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input.toString());
  const host = url.hostname;
  const name = host.split(".")[0] ?? host;
  if (url.pathname.endsWith("/models")) {
    return json(200, { data: [{ id: `m-${name}` }] });
  }
  const next = script.get(host)?.shift() ?? ok(`answer from ${name}`, `m-${name}`);
  wire.push(`${name} -> HTTP ${next.status}`);
  return json(next.status, next.body, next.headers);
}) as typeof fetch;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// ---- pool with an in-memory store and a controllable clock -----------------
let clock = new Date("2026-01-15T10:00:00.000Z");
const store: PoolStore & { data: unknown } = {
  data: null,
  load: async () => store.data,
  save: async (value) => {
    store.data = JSON.parse(JSON.stringify(value));
  },
};
const pool = createModelPool({
  root: ".",
  catalog,
  env,
  fetch: mockFetch,
  now: () => clock,
  store,
});
const policy = { ...DEFAULT_POOL_POLICY };

const heading = (title: string) => console.log(`\n=== ${title} ===`);
const show = (label: string, value: string) =>
  console.log(`${label.padEnd(12)}${value}`);

function printAttempts(result: Awaited<ReturnType<typeof pool.complete>>) {
  for (const attempt of result.attempts) {
    console.log(
      `  attempt: ${attempt.provider}/${attempt.model} -> ${attempt.outcome}` +
        (attempt.retryAfter ? ` (retry after ${attempt.retryAfter})` : ""),
    );
  }
  if (result.ok) {
    show("served by", `${result.provider}/${result.model}: "${result.text}"`);
  } else {
    show("failed", `${result.reason} -- earliest retry ${result.earliestRetryAt}`);
  }
}

heading("1. Discovery and routing decision (no tokens spent)");
await pool.refresh();
const decision = routePool(
  requirementsForRole("planning"),
  pool.routingCandidates(clock),
  policy,
  clock,
);
for (const item of decision.ranked) {
  const m = item.candidate.model;
  console.log(
    `  rank: ${m.provider}/${m.model}  score=${item.score.toFixed(1)}  pricing=${m.pricing}`,
  );
}
for (const item of decision.rejected) {
  const m = item.candidate.model;
  console.log(`  rejected: ${m.provider}/${m.model}  reason: ${item.reason}`);
}
console.log(`  not configured (no key): echo`);

heading("2. Normal request -> best-scoring free model");
printAttempts(await pool.complete({ role: "planning", prompt: "Plan the work." }));

heading("3. Provider rate-limits (HTTP 429, retry-after 90s) -> fallback");
queue("alpha", rateLimited(90));
printAttempts(await pool.complete({ role: "planning", prompt: "Plan again." }));
console.log(`  last fallback: ${JSON.stringify(pool.snapshot().lastFallback)}`);

heading("4. Quota exhausted on the fallback too -> next provider");
queue("bravo", quota());
printAttempts(await pool.complete({ role: "planning", prompt: "And again." }));

heading("5. Everything blocked -> all_exhausted with a recovery time");
queue("charlie", unauthorized());
printAttempts(await pool.complete({ role: "planning", prompt: "Still there?" }));
console.log(
  formatProviderStatus(pool.snapshot(), [], {}).split("\n").slice(0, 8).join("\n"),
);

heading("6. Time passes (+2h): rate limit and quota expire, auth error stays");
clock = new Date(clock.getTime() + 2 * 3_600_000);
printAttempts(await pool.complete({ role: "planning", prompt: "Back online?" }));
console.log(
  formatProviderStatus(pool.snapshot(), [], {}).split("\n").slice(0, 8).join("\n"),
);

heading("7. Fallback glue: external agent hits quota mid-review -> pool");
queue("alpha", ok('{"decision":"PASS","notes":"mock review"}', "m-alpha"));
let agentCalls = 0;
const review = await runReviewWithFallback(
  {
    agents: ["external-agent"],
    isAvailable: () => true,
    invokeAgent: async () => {
      agentCalls += 1;
      return {
        exitCode: 1,
        stdout: "",
        stderr: "You've hit your usage limit",
        timedOut: false,
        finalMessage: "",
      };
    },
    onQuota: async (agent) => console.log(`  cooling down ${agent}`),
    log: (line) => console.log(`  log: ${line}`),
    pool,
    fail: (agent, message) => new Error(`${agent}: ${message}`),
  },
  "Review this diff and answer in JSON.",
).catch((error: Error) => ({ response: `error: ${error.message}` }));
show("agent calls", String(agentCalls));
show("response", JSON.stringify(review.response));

heading("Wire log (mocked HTTP completions, in order)");
for (const line of wire) console.log(`  ${line}`);
console.log("\nDone. Everything above ran against a mock; no network was used.");
