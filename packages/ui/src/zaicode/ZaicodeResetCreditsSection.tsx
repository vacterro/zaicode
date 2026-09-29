import { cn } from "@/components/lib/utils.js";
import { zaicodeVendorColor } from "./ZaicodeLimitViews.js";
import { formatZaicodeRemaining } from "./zaicodeTimers.js";
import { spendZaicodeResetCredit, useZaicodeResetCreditsBusy, zaicodeResetCreditsTotal, type ZaicodeResetCreditRow } from "./zaicodeResetCredits.js";

/**
 * Reset credits where the person looks for resets (T-130): the reset timer's list, under the ZCode Coding Plan's own. One row per
 * account that has some -- how many, what a click refills, when the first runs out -- and the button that uses one (after asking).
 */

export function expiryLabel(expiresAt: number | null, now: number): string {
  return expiresAt === null ? "does not expire" : `expires in ${formatZaicodeRemaining(Math.max(0, (expiresAt - now) / 1000))}`;
}

export function ZaicodeResetCreditButton({ row, className }: { row: ZaicodeResetCreditRow; className?: string }) {
  const busy = useZaicodeResetCreditsBusy().has(row.accountId);
  return (
    <button
      type="button"
      className={cn("border border-border px-1.5 hover:bg-hover", busy && "cursor-default opacity-50 hover:bg-transparent", className)}
      disabled={busy}
      title="Use one reset credit now (asks first)"
      onClick={() => void spendZaicodeResetCredit(row)}
      data-zaicode-reset-credit-button={row.accountId}
    >
      {busy ? "resetting…" : "Reset now"}
    </button>
  );
}

export function ZaicodeResetCreditsSection({ rows, now, hasClaude }: { rows: readonly ZaicodeResetCreditRow[]; now: number; hasClaude: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-2 border-t border-border pt-1.5 text-ui-xs text-foreground" data-zaicode-reset-credits={zaicodeResetCreditsTotal(rows)}>
      <div className="mb-1 font-semibold">Reset credits you can use</div>
      <table className="w-full border-collapse tabular-nums">
        <tbody>
          {rows.map((row) => (
            <tr key={row.accountId} data-zaicode-reset-credit-row={row.accountId}>
              <td className="pr-2 font-semibold" style={{ color: zaicodeVendorColor(row.vendor) }}>
                {row.label}
              </td>
              <td className="pr-2 text-right font-semibold">×{row.usable}</td>
              <td className="max-w-[220px] truncate pr-2 text-foreground-subtle" title={row.credit?.description ?? undefined}>
                {row.credit?.title ?? "Reset"}
                {row.spentWindows.length > 0 ? ` · ${row.spentWindows.join(" + ")} spent` : ""}
              </td>
              <td className="pr-2 text-right text-foreground-subtle">{expiryLabel(row.nextExpiresAt, now)}</td>
              <td className="text-right">
                <ZaicodeResetCreditButton row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasClaude ? <div className="mt-1 text-foreground-subtlest">Claude Code has no reset credits to read.</div> : null}
    </div>
  );
}
