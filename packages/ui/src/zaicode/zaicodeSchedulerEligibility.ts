import type { ZaicodeEngineAccount } from "@zcode/shared";
import type { ZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/**
 * Scheduler eligibility per account (SRC-132, T-198).
 *
 * Ctrl+Click on a subscription tile takes that account out of the Scheduler's
 * route candidates -- nothing else. The account keeps working: the operator can
 * still pick it by hand, still read its quota, still run a worker from the
 * project row. It is a "do not schedule me" answer, not a "disable my account"
 * answer, and the two must never be confused (the Wave 2 brief is explicit).
 *
 * Keyed by the account id, which is the engine id the scheduler already stores
 * on the job, so persistence needs no new identity concept.
 */

type EligibilityPrefs = Pick<ZaicodeUiPrefs, "schedulerIneligible">;

/** Is this account allowed to be picked as a scheduled runner? */
export function zaicodeSchedulerEligible(prefs: EligibilityPrefs, accountId: string): boolean {
  return prefs.schedulerIneligible[accountId] !== true;
}

/** Pure: the accounts the scheduler may offer, in the order it already had them. */
export function pickZaicodeSchedulerEligibleAccounts<T extends Pick<ZaicodeEngineAccount, "id">>(
  accounts: readonly T[],
  prefs: EligibilityPrefs,
): T[] {
  return accounts.filter((account) => zaicodeSchedulerEligible(prefs, account.id));
}

/** The patch one Ctrl+Click writes; other accounts' answers are left alone. */
export function zaicodeSchedulerEligibilityPatch(
  prefs: EligibilityPrefs,
  accountId: string,
): { schedulerIneligible: Record<string, boolean> } {
  const next = { ...prefs.schedulerIneligible };
  if (next[accountId] === true) delete next[accountId];
  else next[accountId] = true;
  return { schedulerIneligible: next };
}