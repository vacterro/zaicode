import type { ZaicodeRouterConnection, ZaicodeRouterNode } from "@zcode/shared";
import type { UsageCount } from "./zaicodeUsage.js";

export interface ZaicodeUsageLabels {
  providers: ReadonlyMap<string, string>;
  accounts: ReadonlyMap<string, string>;
}

function readableName(value: string): string | null {
  const name = value.trim();
  // 先检查完整标识再截断；否则长名称末尾的 UUID 会绕过展示过滤。
  return !name ||
    /[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i.test(name) ||
    /^[a-f\d]{24,}$/i.test(name)
    ? null
    : name.slice(0, 256);
}

/** Keep display names only; credentials and technical route IDs never reach the table. */
export function buildZaicodeUsageLabels(
  nodes: readonly Pick<ZaicodeRouterNode, "id" | "name" | "prefix">[],
  connections: readonly Pick<ZaicodeRouterConnection, "id" | "provider" | "name" | "email">[],
): ZaicodeUsageLabels {
  const providers = new Map<string, string>();
  const accounts = new Map<string, string>();
  for (const node of nodes.slice(0, 200)) {
    const name = readableName(node.name) ?? readableName(node.prefix);
    if (name) providers.set(node.id, name);
  }
  for (const connection of connections.slice(0, 200)) {
    const provider = providers.get(connection.provider) ?? readableName(connection.provider);
    const account = readableName(connection.email ?? "") ?? readableName(connection.name);
    if (account)
      accounts.set(
        connection.id,
        provider && provider !== account ? `${provider} · ${account}` : account,
      );
  }
  return { providers, accounts };
}

export function zaicodeUsageDisplayName(
  name: string,
  kind: "models" | "providers" | "accounts",
  labels: ZaicodeUsageLabels,
): string {
  const mapped = kind === "models" ? null : labels[kind].get(name);
  return (
    mapped ??
    readableName(name) ??
    (kind === "models"
      ? "Unknown model"
      : kind === "providers"
        ? "Other providers"
        : "Other accounts")
  );
}

/** Missing catalog entries still contribute metrics without a wall of opaque IDs. */
export function displayZaicodeUsageBreakdown(
  rows: readonly UsageCount[],
  kind: "models" | "providers" | "accounts",
  labels: ZaicodeUsageLabels,
): UsageCount[] {
  const groups = new Map<string, UsageCount>();
  for (const row of rows) {
    const name = zaicodeUsageDisplayName(row.name, kind, labels);
    const group = groups.get(name);
    if (!group) groups.set(name, { ...row, name });
    else {
      group.requests += row.requests;
      group.input += row.input;
      group.output += row.output;
      group.cached += row.cached;
      group.cost += row.cost;
    }
  }
  return [...groups.values()].sort((a, b) => b.requests - a.requests);
}

export function zaicodeUsageStatus(status: string): string {
  switch (status.toLowerCase()) {
    case "ok":
    case "success":
    case "completed":
      return "Done";
    case "error":
    case "failed":
      return "Failed";
    case "running":
    case "pending":
    case "streaming":
      return "Running";
    default:
      return "Unknown";
  }
}
