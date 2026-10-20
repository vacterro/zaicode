import type { ZaicodeEngineAccount, ZaicodeSubscriptionAccount } from "@zcode/shared";
import type { ZaicodePoolGroup } from "./zaicodeRoutingModel.js";

/** Local CLI homes and router logins are separate identities. Multiple logins need an exact label match. */
export function resolveZaicodeSubscriptionGroup(
  engine: Pick<ZaicodeEngineAccount, "vendor" | "label">,
  accounts: readonly ZaicodeSubscriptionAccount[],
  providerAccount: Record<string, string>,
  groups: readonly ZaicodePoolGroup[],
): ZaicodePoolGroup | null {
  const candidates = accounts.filter((account) => account.provider === engine.vendor && account.active);
  const account = candidates.find((candidate) => candidate.label.toLowerCase() === engine.label.toLowerCase()) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!account) return null;
  return groups.find((group) => providerAccount[group.providerId] === account.connectionId) ?? null;
}

/** Which subscription a pool runner bills, for scheduler identity (REQ-005). */
export interface ZaicodeRunnerSubscription {
  label: string;
  vendor: string;
  /**
   * Engine account id quota/reset reads come from, or null when no engine row
   * matches (a router-only login has no CLI engine, so no reset trigger can
   * watch it -- the row must say so instead of silently watching another).
   */
  engineId: string | null;
}

/**
 * The subscription behind a `pool:` provider, or null when the provider is
 * not a subscription account's. Engine linkage uses the same exact
 * vendor+label rule as the composer path: never a guess across accounts.
 */
export function zaicodePoolSubscription(
  providerId: string,
  accounts: readonly ZaicodeSubscriptionAccount[],
  providerAccount: Record<string, string>,
  engines: readonly Pick<ZaicodeEngineAccount, "id" | "vendor" | "label">[],
): ZaicodeRunnerSubscription | null {
  const connectionId = providerAccount[providerId];
  if (!connectionId) return null;
  const account = accounts.find((entry) => entry.connectionId === connectionId);
  if (!account) return null;
  const engine =
    engines.find(
      (candidate) => candidate.vendor === account.provider && candidate.label.toLowerCase() === account.label.toLowerCase(),
    ) ?? null;
  return { label: account.label, vendor: account.provider, engineId: engine?.id ?? null };
}

export interface ZaicodeSchedulerWatchNote {
  tone: "same" | "missing" | "unwatchable" | "mismatch";
  text: string;
}

/**
 * What the schedule row says about Watch for a subscription-backed pool run.
 * Null = not a subscription-backed run, the row's existing copy applies.
 */
export function zaicodeSchedulerWatchNote(
  backing: ZaicodeRunnerSubscription | null,
  watchEngineId: string,
  watchLabel: (id: string) => string | null,
): ZaicodeSchedulerWatchNote | null {
  if (!backing) return null;
  if (!backing.engineId) {
    return {
      tone: "unwatchable",
      text: `Runs on the ${backing.label} subscription, which has no engine row: reset triggers cannot watch its quota, Watch below follows another account.`,
    };
  }
  if (!watchEngineId) {
    return { tone: "missing", text: `Runs on the ${backing.label} subscription: pick it under Watch.` };
  }
  if (watchEngineId === backing.engineId) {
    return { tone: "same", text: `Watch follows the same subscription (${backing.label}).` };
  }
  return {
    tone: "mismatch",
    text: `Watch follows ${watchLabel(watchEngineId) ?? watchEngineId}, but this run bills the ${backing.label} subscription.`,
  };
}
