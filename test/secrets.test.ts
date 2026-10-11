import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRedactor,
  loadProviderEnv,
  parseEnvFile,
} from "../src/secrets.js";

describe("parseEnvFile", () => {
  it("parses assignments, quotes, export prefixes and CRLF, and skips comments", () => {
    const parsed = parseEnvFile(
      [
        "# comment",
        "",
        "GROQ_API_KEY=plain-value-123",
        'GEMINI_API_KEY="quoted value"',
        "export MISTRAL_API_KEY='single'",
        "  SPACED_KEY  =  padded  ",
        "EMPTY_KEY=",
        "not an assignment",
      ].join("\r\n"),
    );
    expect(parsed).toEqual({
      GROQ_API_KEY: "plain-value-123",
      GEMINI_API_KEY: "quoted value",
      MISTRAL_API_KEY: "single",
      SPACED_KEY: "padded",
    });
  });
});

describe("loadProviderEnv", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pool-env-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads .env and lets the process environment win", async () => {
    await writeFile(
      join(dir, ".env"),
      "GROQ_API_KEY=from-file-value\nMISTRAL_API_KEY=file-mistral\n",
    );
    const loaded = await loadProviderEnv(dir, {
      env: { GROQ_API_KEY: "from-process-value" },
    });
    expect(loaded.values.GROQ_API_KEY).toBe("from-process-value");
    expect(loaded.values.MISTRAL_API_KEY).toBe("file-mistral");
    expect(loaded.sources).toEqual([".env", "process.env"]);
  });

  it("also reads the secondary .env.local file name", async () => {
    await writeFile(
      join(dir, ".env.local"),
      "CEREBRAS_API_KEY=local-file-value\n",
    );
    const loaded = await loadProviderEnv(dir, { env: {} });
    expect(loaded.values.CEREBRAS_API_KEY).toBe("local-file-value");
    expect(loaded.sources).toContain(".env.local");
  });

  it("reads an explicit MODEL_POOL_ENV_FILE from another directory, ahead of the default names", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "pool-env-else-"));
    try {
      await writeFile(
        join(elsewhere, "creds.txt"),
        "GROQ_API_KEY=explicit-file-value\n",
      );
      await writeFile(
        join(dir, ".env"),
        "GROQ_API_KEY=default-file-value\nMISTRAL_API_KEY=default-mistral\n",
      );
      const loaded = await loadProviderEnv(dir, {
        env: { MODEL_POOL_ENV_FILE: join(elsewhere, "creds.txt") },
      });
      expect(loaded.values.GROQ_API_KEY).toBe("explicit-file-value");
      expect(loaded.values.MISTRAL_API_KEY).toBe("default-mistral");
      // Labels are basenames only, never full paths.
      expect(loaded.sources.join(",")).not.toContain(elsewhere);
      expect(loaded.sources).toContain("creds.txt");
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("returns only process env when no file exists", async () => {
    const loaded = await loadProviderEnv(dir, {
      env: { COHERE_API_KEY: "only-process" },
    });
    expect(loaded.values).toEqual({ COHERE_API_KEY: "only-process" });
  });

  it("never exposes values through its serializable summary", async () => {
    await writeFile(
      join(dir, ".env"),
      "GROQ_API_KEY=topsecret-1234\n",
    );
    const loaded = await loadProviderEnv(dir, { env: {} });
    expect(JSON.stringify(loaded.summary())).not.toContain("topsecret-1234");
    expect(loaded.summary().names).toContain("GROQ_API_KEY");
  });
});

describe("createRedactor", () => {
  it("replaces exact secret values wherever they appear", () => {
    const redact = createRedactor(["supersecretvalue-42"]);
    expect(redact("boom supersecretvalue-42 boom supersecretvalue-42")).toBe(
      "boom [REDACTED] boom [REDACTED]",
    );
  });

  it("redacts bearer tokens and well-known key prefixes it was never told about", () => {
    const redact = createRedactor([]);
    expect(redact("Authorization: Bearer abcDEF1234567890xyz")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    for (const token of [
      "gsk_abcdefghijklmnop1234",
      "csk-abcdefghijklmnop1234",
      "hf_abcdefghijklmnop1234",
      "nvapi-abcdefghijklmnop1234",
      "sk-or-v1-abcdefghijklmnop1234",
      "AIzaSyAbcdefghijklmnop1234567",
    ]) {
      expect(redact(`key ${token} leaked`)).toBe("key [REDACTED] leaked");
    }
  });

  it("redacts api key query parameters and JSON fields", () => {
    const redact = createRedactor([]);
    expect(redact("GET /v1?key=AbCdEf123456&x=1")).toBe(
      "GET /v1?key=[REDACTED]&x=1",
    );
    expect(redact('{"api_key":"abcd1234efgh"}')).toBe(
      '{"api_key":"[REDACTED]"}',
    );
  });

  it("ignores very short values so ordinary words are not mangled", () => {
    const redact = createRedactor(["abc", "", "   "]);
    expect(redact("abc is fine")).toBe("abc is fine");
  });

  it("redacts secrets embedded inside Error objects", () => {
    const redact = createRedactor(["hunter2-hunter2"]);
    expect(redact(new Error("failed with hunter2-hunter2"))).toBe(
      "failed with [REDACTED]",
    );
  });
});
