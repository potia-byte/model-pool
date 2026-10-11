import type { Redactor } from "./secrets.js";
import type { FailureCategory, ProviderFailure } from "./types.js";

/** One provider's failure could otherwise park it for days on a bogus header. */
export const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 240;

export interface RawProviderFailure {
  /** null when no HTTP response was received. */
  status: number | null;
  headers: Headers;
  body: string;
  networkError?: Error;
}

export interface ClassifyOptions {
  now: Date;
  redact: Redactor;
}

// Word-bounded so "quotation" or "credit card form" in an unrelated body
// cannot flip a plain rate limit into an exhausted quota.
const QUOTA_BODY =
  /insufficient[_\s-]?quota|exceeded your current quota|out of credits|insufficient credits?|credit balance|run out of (?:credits|quota)|daily (?:request |token )?(?:limit|quota)|per[-\s]day|monthly (?:limit|quota)|quota (?:exhausted|exceeded for .*per day)|billing/i;
const MODEL_BODY =
  /model[_\s-]?not[_\s-]?found|does not exist|not supported|decommission|deprecated|unknown model|no such model|invalid model|has been (?:removed|retired)/i;
/** "Not available on the Free plan" restricts one model, not the credential. */
const PLAN_BODY =
  /not available on the .{0,40}plan|requires? (?:a |an )?(?:paid|pro|upgraded)|upgrade (?:your )?plan|plan (?:does not|doesn't) (?:include|support)/i;
const AUTH_BODY =
  /invalid[_\s-]?api[_\s-]?key|unauthori[sz]ed|authentication|forbidden|permission denied|invalid[_\s-]?token/i;

/** "2m59.5s", "1h", "300ms", "27s", or bare seconds ("30"). */
export function parseDurationMs(value: string): number | null {
  const text = value.trim();
  if (text === "") return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let consumed = 0;
  for (const match of text.matchAll(pattern)) {
    matched = true;
    consumed += match[0].length;
    const amount = Number(match[1]);
    switch (match[2]) {
      case "h":
        total += amount * 3_600_000;
        break;
      case "m":
        total += amount * 60_000;
        break;
      case "s":
        total += amount * 1000;
        break;
      case "ms":
        total += amount;
        break;
    }
  }
  return matched && consumed === text.length ? Math.round(total) : null;
}

function retryAfterMs(
  headers: Headers,
  body: string,
  now: Date,
): number | null {
  const candidates: number[] = [];
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseDurationMs(retryAfter);
    if (seconds !== null) candidates.push(seconds);
    else {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date))
        candidates.push(Math.max(0, date - now.getTime()));
    }
  }
  for (const name of [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset",
  ]) {
    const raw = headers.get(name);
    const parsed = raw ? parseDurationMs(raw) : null;
    if (parsed !== null) candidates.push(parsed);
  }
  const bodyDelay = body.match(/"retryDelay"\s*:\s*"([^"]+)"/i);
  if (bodyDelay?.[1]) {
    const parsed = parseDurationMs(bodyDelay[1]);
    if (parsed !== null) candidates.push(parsed);
  }
  if (candidates.length === 0) return null;
  return Math.min(Math.max(...candidates), MAX_RETRY_AFTER_MS);
}

function categorize(status: number | null, body: string): FailureCategory {
  if (status === null) return "temporary_error";
  if (status === 401) return "auth_error";
  if (status === 402) return "quota_exhausted";
  if (status === 403) {
    if (QUOTA_BODY.test(body)) return "quota_exhausted";
    return PLAN_BODY.test(body) ? "model_unsupported" : "auth_error";
  }
  if (status === 429) {
    return QUOTA_BODY.test(body) ? "quota_exhausted" : "rate_limited";
  }
  if (status === 404) return "model_unsupported";
  if (status === 408) return "temporary_error";
  if (status >= 500) return "temporary_error";
  if (status >= 400) {
    if (MODEL_BODY.test(body)) return "model_unsupported";
    if (AUTH_BODY.test(body) && /\b(?:api[_\s-]?key|token)\b/i.test(body)) {
      return "auth_error";
    }
    return "bad_request";
  }
  return "unknown_error";
}

/**
 * Turns one failed provider call into a normalized, secret-free failure.
 * Auth, quota, rate limit, unsupported model and outage are kept distinct
 * because each drives different pool behaviour (isolate the provider, wait
 * for a reset, skip one model, back off, ...).
 */
export function classifyProviderFailure(
  raw: RawProviderFailure,
  options: ClassifyOptions,
): ProviderFailure {
  const category = raw.networkError
    ? "temporary_error"
    : categorize(raw.status, raw.body);
  const text = raw.networkError
    ? `${raw.networkError.name}: ${raw.networkError.message}`
    : raw.body.replace(/\s+/g, " ").trim();
  const prefix = raw.status === null ? "" : `HTTP ${raw.status}: `;
  const message = `${prefix}${options.redact(text)}`.slice(
    0,
    MAX_MESSAGE_CHARS,
  );
  return {
    category,
    retryAfterMs:
      category === "rate_limited" ||
      category === "quota_exhausted" ||
      category === "temporary_error"
        ? retryAfterMs(raw.headers, raw.body, options.now)
        : null,
    message,
    status: raw.status,
  };
}
