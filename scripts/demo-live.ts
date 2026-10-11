/**
 * Live smoke run with YOUR keys from .env (see .env.example). Not part of the
 * tests and not verified in CI: it talks to real providers.
 *
 *   npm run demo:live            # model listing only (costs no tokens)
 *   npm run demo:live -- --ask   # also one small completion through the pool
 *
 * Paid models are never selected (allowPaidApiSpend is fixed to false).
 */
import { formatProviderStatus } from "../src/status.js";
import { openModelPool } from "../src/runtime.js";

const opened = await openModelPool(process.cwd(), {
  log: (line) => console.log(`  log: ${line}`),
});
if (!opened.enabled) {
  console.log("Pool is switched off (MODEL_POOL=off).");
  process.exit(0);
}
const found = opened.envSummary.names.filter((name) =>
  opened.secretNames.includes(name),
);
console.log(`Provider credential variables set (names only): ${found.join(", ") || "none"}`);
console.log(`Sources: ${opened.envSummary.sources.join(", ") || "none"}`);

await opened.pool.refresh();
console.log(formatProviderStatus(opened.pool.snapshot()));

if (process.argv.includes("--ask")) {
  const result = await opened.pool.complete({
    role: "summarization",
    prompt: "Reply with one short sentence confirming you are reachable.",
    maxTokens: 64,
  });
  console.log(
    result.ok
      ? `Served by ${result.provider}/${result.model}: ${result.text.trim()}`
      : `No answer (${result.reason}): ${result.message}`,
  );
}
