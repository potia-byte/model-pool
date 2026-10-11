import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/**
 * Local provider credentials for the model pool.
 *
 * Values live only in memory here. Nothing in this module -- or anything that
 * consumes its output -- may log, persist or serialize a value; `summary()`
 * exposes variable NAMES only, and `createRedactor` is applied to every
 * string that can leave the process boundary (errors, logs, persisted state).
 */

/** Default credential file names, checked in order under the pool root. */
export const PROVIDER_ENV_FILE_NAMES = [".env", ".env.local"] as const;

/** Environment variable that may point at a credentials file kept elsewhere. */
export const ENV_FILE_VARIABLE = "MODEL_POOL_ENV_FILE";

const REDACTED = "[REDACTED]";
/** Shorter values are ordinary words, not credentials; replacing them would
 * corrupt unrelated text. */
const MIN_SECRET_LENGTH = 8;

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(
      /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/,
    );
    if (!match?.[1]) continue;
    let value = (match[2] ?? "").trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "") values[match[1]] = value;
  }
  return values;
}

export interface ProviderEnvSummary {
  /** Variable names that are present with a non-empty value. */
  names: string[];
  /** Source labels only (file basenames or "process.env"). */
  sources: string[];
}

export interface LoadedProviderEnv {
  values: Readonly<Record<string, string>>;
  sources: string[];
  summary(): ProviderEnvSummary;
}

export interface LoadProviderEnvOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the default file names looked up under the root. */
  fileNames?: readonly string[];
  readFile?: (path: string) => Promise<string>;
}

export async function loadProviderEnv(
  root: string,
  options: LoadProviderEnvOptions = {},
): Promise<LoadedProviderEnv> {
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const env = options.env ?? process.env;
  const values: Record<string, string> = {};
  const sources: string[] = [];
  // An explicit MODEL_POOL_ENV_FILE wins over the default names, so a
  // credentials file kept outside this checkout can be used in place.
  const candidates: Array<{ path: string; label: string }> = [];
  const explicit = env[ENV_FILE_VARIABLE]?.trim();
  if (explicit) {
    candidates.push({
      path: resolve(root, explicit),
      label: basename(explicit),
    });
  }
  for (const name of options.fileNames ?? PROVIDER_ENV_FILE_NAMES) {
    candidates.push({ path: join(root, name), label: name });
  }
  for (const candidate of candidates) {
    let text: string;
    try {
      text = await read(candidate.path);
    } catch {
      continue;
    }
    // The first file that exists wins for a given variable, mirroring the
    // candidate order above.
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (!(key in values)) values[key] = value;
    }
    sources.push(candidate.label);
  }
  let usedProcessEnv = false;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") {
      values[key] = value;
      usedProcessEnv = true;
    }
  }
  if (usedProcessEnv) sources.push("process.env");
  return {
    values,
    sources,
    summary: () => ({
      names: Object.keys(values).sort(),
      sources: [...sources],
    }),
  };
}

// Prefixes of API keys the configured providers are known to issue, so an
// error body that echoes a key we never loaded (rotated, typo'd, pasted into
// the wrong variable) is still scrubbed.
const KEY_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bgsk_[A-Za-z0-9]{12,}/g,
  /\bcsk-[A-Za-z0-9]{12,}/g,
  /\bhf_[A-Za-z0-9]{12,}/g,
  /\bnvapi-[A-Za-z0-9_-]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
];

export type Redactor = (value: unknown) => string;

export function createRedactor(secretValues: Iterable<string>): Redactor {
  const secrets = [...new Set(secretValues)]
    .map((value) => value.trim())
    .filter((value) => value.length >= MIN_SECRET_LENGTH)
    // Longest first so a secret containing another as a substring is fully
    // replaced.
    .sort((left, right) => right.length - left.length);
  return (value) => {
    let text =
      value instanceof Error
        ? value.message
        : typeof value === "string"
          ? value
          : String(value);
    for (const secret of secrets) text = text.split(secret).join(REDACTED);
    text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`);
    for (const shape of KEY_SHAPES) text = text.replace(shape, REDACTED);
    text = text.replace(
      /([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi,
      `$1${REDACTED}`,
    );
    text = text.replace(
      /("(?:api[_-]?key|authorization|token|access_token)"\s*:\s*")[^"]+(")/gi,
      `$1${REDACTED}$2`,
    );
    return text;
  };
}
