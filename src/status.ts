import type {
  PoolSnapshot,
  ProviderDisplayState,
  ValidationRow,
} from "./pool.js";

/**
 * An external (non-pool) agent a caller also wants listed in the status block,
 * e.g. a CLI coding agent with its own availability flag.
 */
export interface AgentStatusInput {
  name: string;
  available: boolean;
  unavailable_reason: string | null;
}

/**
 * Maps an external agent's availability flag onto the pool's vocabulary. A
 * reason that mentions a quota/rate limit/cooldown becomes QUOTA_EXHAUSTED;
 * anything else (manual disable, missing binary) is a plain UNAVAILABLE.
 */
export function agentDisplayState(
  agent: AgentStatusInput,
): ProviderDisplayState {
  if (agent.available) return "AVAILABLE";
  return /quota|rate[\s-]?limit|usage limit|cooling down/i.test(
    agent.unavailable_reason ?? "",
  )
    ? "QUOTA_EXHAUSTED"
    : "UNAVAILABLE";
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function pad(text: string, width: number): string {
  return text.padEnd(width, " ");
}

export interface FormatStatusOptions {
  /**
   * Names of external agents to list, in display order (before the pool's
   * providers). Agents not named here are skipped. Default: all, as given.
   */
  agentOrder?: readonly string[];
  /** Hint shown for providers whose models were never discovered. */
  refreshHint?: string;
}

/**
 * The `Providers:` status block. Names and normalized states only -- nothing
 * here is derived from a credential.
 */
export function formatProviderStatus(
  snapshot: PoolSnapshot,
  agents: readonly AgentStatusInput[] = [],
  options: FormatStatusOptions = {},
): string {
  const rows: Array<{
    name: string;
    state: ProviderDisplayState;
    detail: string;
  }> = [];
  const order = options.agentOrder;
  const cli = order
    ? [...agents]
        .filter((agent) => order.includes(agent.name))
        .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))
    : [...agents];
  for (const agent of cli) {
    const state = agentDisplayState(agent);
    rows.push({
      name: capitalize(agent.name),
      state,
      detail: state === "AVAILABLE" ? "" : (agent.unavailable_reason ?? ""),
    });
  }
  for (const provider of snapshot.providers) {
    let detail = "";
    if (provider.state === "AVAILABLE") {
      detail = `${provider.usableModels} usable model${provider.usableModels === 1 ? "" : "s"}`;
    } else if (provider.state === "UNVERIFIED") {
      detail = `models not discovered yet; ${options.refreshHint ?? "call pool.refresh()"}`;
    } else if (provider.retryAfter) {
      detail = `retry after ${provider.retryAfter}`;
    } else if (provider.state === "AUTH_ERROR") {
      detail = "authentication rejected; check the configured credential";
    }
    rows.push({ name: provider.displayName, state: provider.state, detail });
  }

  const nameWidth = Math.max(0, ...rows.map((row) => row.name.length)) + 2;
  const stateWidth = Math.max(0, ...rows.map((row) => row.state.length)) + 2;
  const lines = ["Providers:"];
  for (const row of rows) {
    lines.push(
      `  ${pad(row.name, nameWidth)}${row.detail ? pad(row.state, stateWidth) : row.state}${row.detail}`.trimEnd(),
    );
  }
  const list = (ids: string[]) => (ids.length > 0 ? ids.join(", ") : "none");
  lines.push(
    "",
    `Configured providers: ${list(snapshot.configured)}`,
    `Available providers: ${list(snapshot.available)}`,
    `Temporarily unavailable providers: ${list(snapshot.temporarilyUnavailable)}`,
    `Usable pool models: ${snapshot.usableModels}`,
    `Selected: ${snapshot.selected ? `${snapshot.selected.provider}/${snapshot.selected.model}` : "none"}`,
    `Last fallback: ${
      snapshot.lastFallback
        ? `${snapshot.lastFallback.from} -> ${snapshot.lastFallback.to} (${snapshot.lastFallback.reason}) at ${snapshot.lastFallback.at}`
        : "none"
    }`,
  );
  return `${lines.join("\n")}\n`;
}

const yesNo = (value: boolean) => (value ? "yes" : "no");

/** The smoke-test table: Provider | Configured | Auth OK | Free model reachable | Status | Notes. */
export function formatValidationTable(rows: readonly ValidationRow[]): string {
  const header = [
    "Provider",
    "Configured",
    "Auth OK",
    "Free model reachable",
    "Status",
    "Notes",
  ];
  const body = rows.map((row) => [
    row.displayName,
    yesNo(row.configured),
    yesNo(row.authOk),
    yesNo(row.freeModelReachable),
    row.status,
    row.model ? `${row.model}: ${row.notes}` : row.notes,
  ]);
  const widths = header.map((title, column) =>
    Math.max(
      title.length,
      ...body.map((cells) => (cells[column] ?? "").length),
    ),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, column) => pad(cell, widths[column] ?? 0))
      .join(" | ")
      .trimEnd();
  return [
    render(header),
    widths.map((width) => "-".repeat(width)).join("-|-"),
    ...body.map(render),
  ].join("\n");
}
