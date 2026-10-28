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
