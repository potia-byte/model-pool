import { fileURLToPath } from "node:url";
import { createModelPool, type ModelPool } from "./pool.js";
import { loadCatalog } from "./catalog.js";
import type { FetchLike } from "./client.js";
import { DEFAULT_POOL_POLICY, type PoolPolicy } from "./router.js";
import {
  loadProviderEnv,
  type ProviderEnvSummary,
} from "./secrets.js";

/** Catalog shipped with the package (`config/provider-models.json`); edit it
 * to change model grading, or pass `catalogPath`. */
export const DEFAULT_CATALOG_PATH = fileURLToPath(
  new URL("../config/provider-models.json", import.meta.url),
);

/** Environment switches read by `openModelPool`. */
export const POOL_OFF_VARIABLE = "MODEL_POOL";
export const POOL_DISABLED_VARIABLE = "MODEL_POOL_DISABLED";

export interface OpenModelPoolOptions {
  /** Process environment override (tests). */
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  catalogPath?: string;
  /** Credential file names under the root (default `.env`, `.env.local`). */
  envFileNames?: readonly string[];
  /** State directory relative to the root (default `.model-pool`). */
  stateDirectory?: string;
  now?: () => Date;
  log?: (line: string) => void | Promise<void>;
}

export interface OpenedModelPool {
  pool: ModelPool;
  /** False when `MODEL_POOL=off`: callers must not use the pool. */
  enabled: boolean;
  policy: PoolPolicy;
  /** Variable NAMES and source labels only. */
  envSummary: ProviderEnvSummary;
  /** Names of the credential variables the catalog reads (never values). */
  secretNames: readonly string[];
  /**
   * The credential values themselves, in memory only, for scrubbing child
   * environments and refusing prompts that contain one. Never log, persist or
   * serialize this.
   */
  secretValues: readonly string[];
}

/**
 * Builds the pool for a root directory: credentials from `.env` / `.env.local`
 * (and the process environment), grading rules from the catalog, and the last
 * persisted health/model state. Opening does no network I/O.
 *
 * Paid API spend is not configurable here. `allowPaidApiSpend` stays false;
 * no environment variable can turn it on (covered by a test).
 */
export async function openModelPool(
  root: string,
  options: OpenModelPoolOptions = {},
): Promise<OpenedModelPool> {
  const env = options.env ?? process.env;
  const loaded = await loadProviderEnv(root, {
    env,
    ...(options.envFileNames ? { fileNames: options.envFileNames } : {}),
  });
  const catalog = await loadCatalog(
    options.catalogPath ?? DEFAULT_CATALOG_PATH,
  );
  const disabled = new Set(
    (env[POOL_DISABLED_VARIABLE] ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ""),
  );
  const policy: PoolPolicy = {
    ...DEFAULT_POOL_POLICY,
    ...(disabled.size > 0 ? { disabledProviders: disabled } : {}),
  };
  const pool = createModelPool({
    root,
    ...(options.stateDirectory ? { stateDirectory: options.stateDirectory } : {}),
    catalog,
    env: loaded.values,
    policy,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  await pool.load();
  const secretNames = [
    ...new Set(
      Object.values(catalog.providers).flatMap((provider) => provider.envKeys),
    ),
  ];
  const secretValues = secretNames
    .map((name) => loaded.values[name])
    .filter(
      (value): value is string => typeof value === "string" && value !== "",
    );
  return {
    secretNames,
    secretValues,
    pool,
    enabled: (env[POOL_OFF_VARIABLE] ?? "").toLowerCase() !== "off",
    policy,
    envSummary: loaded.summary(),
  };
}
