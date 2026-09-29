import { useSyncExternalStore } from "react";
import {
  describeZaicodeResetOutcome,
  effectiveZaicodeWindows,
  zaicodeNextResetCreditExpiry,
  zaicodePickResetCredit,
  zaicodeResetCreditsUsable,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
  type ZaicodeResetConsumeResult,
  type ZaicodeResetCredit,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialogStore, type ConfirmDialogRequest } from "@/store/confirmDialogStore.js";
import { getZaicodeEnginesBridge } from "./zaicodeEngines.js";

/**
 * Reset credits in the window (T-130): which accounts have some to spend, and spending one from where the person is looking.
 * Codex hands them out (a full reset of the week and the 5 hours); the main process reads them with the quota and spends one on
 * request. Here: the rows, the question that is asked before a credit is used up, and the answer in a toast. Claude Code has no
 * reset credits, so there is nothing for it to list; ZCode's Coding Plan resets keep their own section (ZaicodeCodingPlanResets).
 */

export interface ZaicodeResetCreditRow {
  accountId: string;
  short: string;
  label: string;
  vendor: string;
  /** Credits that can be spent right now. */
  usable: number;
  /** Soonest expiry among them (epoch ms), null = none expires or the vendor sent no detail. */
  nextExpiresAt: number | null;
  /** Names of the windows that are spent (0% left): what a reset would refill. */
  spentWindows: string[];
  /** The credit a click uses (the one that runs out first), null when only the count is known. */
  credit: ZaicodeResetCredit | null;
}

/** Pure: the accounts with something to spend, the ones that are blocked right now first. */
export function zaicodeResetCreditRows(
  accounts: readonly Pick<ZaicodeEngineAccount, "id" | "short" | "label" | "vendor">[],
  limits: Readonly<Record<string, ZaicodeLimitSnapshot | undefined>>,
  now: number,
): ZaicodeResetCreditRow[] {
  const rows: ZaicodeResetCreditRow[] = [];
  for (const account of accounts) {
    const snapshot = limits[account.id];
    const usable = zaicodeResetCreditsUsable(snapshot?.resetCredits, now);
    if (!snapshot || usable <= 0) continue;
    const spent = effectiveZaicodeWindows(snapshot.windows, now).filter((window) => window.remainingPercent !== null && window.remainingPercent <= 0);
    rows.push({
      accountId: account.id,
      short: account.short,
      label: account.label,
      vendor: account.vendor,
      usable,
      nextExpiresAt: zaicodeNextResetCreditExpiry(snapshot.resetCredits, now),
      spentWindows: [...new Set(spent.map((window) => window.label))],
      credit: zaicodePickResetCredit(snapshot.resetCredits, now),
    });
  }
  return rows.sort(
    (left, right) =>
      Number(right.spentWindows.length > 0) - Number(left.spentWindows.length > 0) ||
      (left.nextExpiresAt ?? Number.MAX_SAFE_INTEGER) - (right.nextExpiresAt ?? Number.MAX_SAFE_INTEGER) ||
      left.label.localeCompare(right.label),
  );
}

export function zaicodeResetCreditsTotal(rows: readonly ZaicodeResetCreditRow[]): number {
  return rows.reduce((sum, row) => sum + row.usable, 0);
}

/** The question asked before a credit is used up, in words: what refills, and that it is gone afterwards. */
export function zaicodeResetCreditRequest(row: ZaicodeResetCreditRow): ConfirmDialogRequest {
  const what = row.spentWindows.length > 0 ? `${row.spentWindows.join(" and ")} ${row.spentWindows.length > 1 ? "are" : "is"} spent: they refill now.` : "No window is spent right now, so a reset may gain nothing.";
  const after = row.usable > 1 ? ` ${row.usable - 1} more stay available.` : " It was the last one.";
  return {
    title: `Use one ${row.label} reset?`,
    description: `${row.credit?.title ? `${row.credit.title}. ` : ""}${what} The credit is used up.${after}`,
    confirmLabel: "Use the reset",
    confirmVariant: "destructive",
  };
}

// ---------------------------------------------------------------- spending

const busy = new Set<string>();
const listeners = new Set<() => void>();
let busySnapshot: ReadonlySet<string> = new Set();

function setBusy(accountId: string, on: boolean): void {
  if (on) busy.add(accountId);
  else busy.delete(accountId);
  busySnapshot = new Set(busy);
  for (const listener of listeners) listener();
}

/** The accounts whose reset is being used right now (their buttons say so and stay off). */
export function useZaicodeResetCreditsBusy(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => busySnapshot,
    () => busySnapshot,
  );
}

/**
 * Asks, then spends one credit of the row's account and says what came of it. Nothing happens without the "Use the reset" click,
 * and a second click on the same account while one is in flight is ignored.
 */
export async function spendZaicodeResetCredit(
  row: ZaicodeResetCreditRow,
  /** Says the answer on screen; a warning when nothing was refilled. Tests hand in their own. */
  notify: (message: string, options: { durationMs: number; variant?: "warning" }) => void = toast,
): Promise<ZaicodeResetConsumeResult | null> {
  const bridge = getZaicodeEnginesBridge();
  if (!bridge?.consumeZaicodeResetCredit || busy.has(row.accountId)) return null;
  const confirmed = await useConfirmDialogStore.getState().requestConfirmation(zaicodeResetCreditRequest(row));
  if (!confirmed) return null;
  setBusy(row.accountId, true);
  try {
    const result = await bridge.consumeZaicodeResetCredit({ accountId: row.accountId, creditId: row.credit?.id ?? null });
    notify(result.message, { durationMs: result.outcome === "reset" ? 6000 : 9000, ...(result.outcome === "reset" ? {} : { variant: "warning" as const }) });
    return result;
  } catch (error) {
    const failed: ZaicodeResetConsumeResult = { outcome: "unavailable", message: describeZaicodeResetOutcome(row.label, "unavailable", error instanceof Error ? error.message : String(error)) };
    notify(failed.message, { durationMs: 9000, variant: "warning" });
    return failed;
  } finally {
    setBusy(row.accountId, false);
  }
}
