import type { RawProviderFailure } from "./errors.js";

/**
 * The single HTTP transport for every pool provider. All supported providers
 * expose an OpenAI-compatible `/chat/completions`, so there is one client and
 * provider differences live in `provider-models.json`, not in code.
 *
 * This module handles credentials in memory only. It never logs, and it never
 * puts a key in anything it returns: failures are returned raw (status,
 * headers, body) for `classifyProviderFailure` to sanitize.
 */

export type FetchLike = typeof fetch;

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  /** Extra request-body fields, e.g. a reasoning-effort setting. */
  extraBody?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
  fetch: FetchLike;
}

export interface ChatSuccess {
  ok: true;
  text: string;
  /** What the provider says actually served the call (aggregators). */
  actualModel: string | null;
  upstreamProvider: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** 0..1 from rate-limit headers when the provider reports them. */
  quotaRemainingFraction: number | null;
}

export interface TransportFailure {
  ok: false;
  raw: RawProviderFailure;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function withTimeout(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

async function send(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; body: string } | TransportFailure> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    return {
      ok: false,
      raw: {
        status: null,
        headers: new Headers(),
        body: "",
        networkError: error instanceof Error ? error : new Error(String(error)),
      },
    };
  }
  let body = "";
  try {
    body = await response.text();
  } catch (error) {
    return {
      ok: false,
      raw: {
        status: null,
        headers: response.headers,
        body: "",
        networkError: error instanceof Error ? error : new Error(String(error)),
      },
    };
  }
  return { response, body };
}

function failureOf(response: Response, body: string): TransportFailure {
  return {
    ok: false,
    raw: { status: response.status, headers: response.headers, body },
  };
}

function headerFraction(headers: Headers): number | null {
  const fractions: number[] = [];
  for (const kind of ["requests", "tokens"]) {
    const limit = Number(headers.get(`x-ratelimit-limit-${kind}`));
    const remaining = Number(headers.get(`x-ratelimit-remaining-${kind}`));
    if (
      headers.has(`x-ratelimit-limit-${kind}`) &&
      headers.has(`x-ratelimit-remaining-${kind}`) &&
      Number.isFinite(limit) &&
      limit > 0 &&
      Number.isFinite(remaining)
    ) {
      fractions.push(Math.min(1, Math.max(0, remaining / limit)));
    }
  }
  return fractions.length === 0 ? null : Math.min(...fractions);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
}

export async function chatCompletion(
  request: ChatRequest,
): Promise<ChatSuccess | TransportFailure> {
  const sent = await send(
    request.fetch,
    joinUrl(request.baseUrl, "chat/completions"),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...request.extraBody,
        model: request.model,
        max_tokens: request.maxTokens,
        messages: [{ role: "user", content: request.prompt }],
      }),
      signal: withTimeout(request.timeoutMs, request.signal),
    },
  );
  if ("ok" in sent) return sent;
  if (!sent.response.ok) return failureOf(sent.response, sent.body);

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(sent.body) as Record<string, unknown>;
  } catch {
    // A 200 with a non-JSON body is treated as an empty completion below.
  }
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const usage = parsed.usage as
    | { prompt_tokens?: unknown; completion_tokens?: unknown }
    | undefined;
  return {
    ok: true,
    text: messageText(first?.message?.content),
    actualModel: typeof parsed.model === "string" ? parsed.model : null,
    upstreamProvider:
      typeof parsed.provider === "string" ? parsed.provider : null,
    usage:
      typeof usage?.prompt_tokens === "number" &&
      typeof usage?.completion_tokens === "number"
        ? {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
          }
        : null,
    quotaRemainingFraction: headerFraction(sent.response.headers),
  };
}

export interface GetJsonRequest {
  url: string;
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  fetch: FetchLike;
}

/** Authenticated GET returning the parsed JSON body (model lists, account
 * lookup). Costs no tokens. */
export async function getJson(
  request: GetJsonRequest,
): Promise<{ ok: true; body: unknown } | TransportFailure> {
  const sent = await send(request.fetch, request.url, {
    method: "GET",
    headers: { authorization: `Bearer ${request.apiKey}` },
    signal: withTimeout(request.timeoutMs, request.signal),
  });
  if ("ok" in sent) return sent;
  if (!sent.response.ok) return failureOf(sent.response, sent.body);
  try {
    return { ok: true, body: JSON.parse(sent.body) as unknown };
  } catch {
    return {
      ok: false,
      raw: {
        status: sent.response.status,
        headers: sent.response.headers,
        body: "non-JSON response",
      },
    };
  }
}
