import { useEffect, useState } from "react";
import { effectiveZaicodeWindows, formatZaicodeTimeOfDay, type ZaicodeEngineAccount, type ZaicodeLimitSnapshot } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { openZaicodeSettings } from "./zaicodeActions.js";
import { useZaicodeEngines, visibleZaicodeAccounts } from "./zaicodeEngines.js";
import { zaicodeVendorColor } from "./ZaicodeLimitViews.js";
import { formatZaicodeRemaining } from "./zaicodeTimers.js";
import { useZaicodeTimers } from "./zaicodeTimerStore.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/**
 * The nearest subscription reset as its own title-bar timer (SRC-046), with
 * FastPrompter's "Nearest resets" column on hover: every coming reset, soonest
 * first -- account, pool, window, how much is left and in how long. It used to
 * be the last part of the clock; now the clock and this timer each have their
 * own hover and click. Click pins the list open; right-click opens Engines &
 * limits.
 */

export interface ZaicodeResetRow {
  accountId: string;
  accountShort: string;
  accountLabel: string;
  vendor: string;
  /** The window's own pool (Antigravity: Gemini vs Claude/GPT), empty = the account's only one. */
  pool: string;
  window: string;
  remainingPercent: number | null;
  at: number;
}

const WINDOW_NAMES: Record<string, string> = { five_hour: "Session", weekly: "Weekly", monthly: "Monthly", daily: "1d" };
const MAX_ROWS = 16;

/** Pure: every reset still ahead, soonest first (FastPrompter's order). */
export function zaicodeResetRows(
  accounts: readonly Pick<ZaicodeEngineAccount, "id" | "short" | "label" | "vendor">[],
  limits: Readonly<Record<string, ZaicodeLimitSnapshot | undefined>>,
  now: number,
): ZaicodeResetRow[] {
  const rows: ZaicodeResetRow[] = [];
  for (const account of accounts) {
    const snapshot = limits[account.id];
    if (!snapshot) continue;
    for (const window of effectiveZaicodeWindows(snapshot.windows, now)) {
      if (window.resetsAt === null || window.resetsAt <= now) continue;
      rows.push({
        accountId: account.id,
        accountShort: account.short,
        accountLabel: account.label,
        vendor: account.vendor,
        pool: window.groupLabel,
        window: WINDOW_NAMES[window.key] ?? window.label,
        remainingPercent: window.remainingPercent,
        at: window.resetsAt,
      });
    }
  }
  return rows.sort((left, right) => left.at - right.at).slice(0, MAX_ROWS);
}

/** The one the timer shows: the soonest reset of a window that is not full. */
export function zaicodeNextUsefulReset(rows: readonly ZaicodeResetRow[]): ZaicodeResetRow | null {
  return rows.find((row) => row.remainingPercent === null || row.remainingPercent < 100) ?? null;
}

function ResetTable({ rows, now, format, hour12 }: { rows: ZaicodeResetRow[]; now: number; format: (seconds: number) => string; hour12: boolean }) {
  return (
    <div className="min-w-[400px] text-ui-xs text-foreground" data-zaicode-reset-table="">
      <div className="mb-1 font-semibold">Nearest resets</div>
      {rows.length === 0 ? (
        <div className="text-foreground-subtle">No reset read yet: Engines & limits reads the subscriptions.</div>
      ) : (
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr className="text-foreground-subtlest">
              <th className="pr-2 text-left font-normal">#</th>
              <th className="pr-2 text-left font-normal">Account</th>
              <th className="pr-2 text-left font-normal">Pool</th>
              <th className="pr-2 text-left font-normal">Window</th>
              <th className="pr-2 text-right font-normal">Left</th>
              <th className="pr-2 text-right font-normal">At</th>
              <th className="text-right font-normal">In</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const full = row.remainingPercent !== null && row.remainingPercent >= 100;
              return (
                <tr key={`${row.accountId}:${row.pool}:${row.window}:${row.at}`} className={cn(full && "opacity-50")}>
                  <td className="pr-2 text-foreground-subtlest">{index + 1}.</td>
                  <td className="pr-2" style={{ color: zaicodeVendorColor(row.vendor) }} title={row.accountLabel}>
                    {row.accountLabel}
                  </td>
                  <td className="max-w-[160px] truncate pr-2 text-foreground-subtle">{row.pool}</td>
                  <td className="pr-2">{row.window}</td>
                  <td className="pr-2 text-right">{row.remainingPercent === null ? "?" : `${Math.round(row.remainingPercent)}%`}</td>
                  <td className="pr-2 text-right text-foreground-subtle">{formatZaicodeTimeOfDay(new Date(row.at), { seconds: false, hour12 })}</td>
                  <td className="text-right font-semibold">{format((row.at - now) / 1000)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function ZaicodeResetTimer({ useWindowsCaptionSpacing = false }: { useWindowsCaptionSpacing?: boolean }) {
  const engines = useZaicodeEngines();
  const clock = useZaicodeTimers((state) => state.clock);
  const noHoverPopups = useZaicodeUiPrefs((state) => state.noHoverPopups);
  const [now, setNow] = useState(() => Date.now());
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!clock.enabled || !clock.showNextReset) return null;
  const rows = zaicodeResetRows(visibleZaicodeAccounts(engines), engines.limits, now);
  const next = zaicodeNextUsefulReset(rows);
  if (!next && rows.length === 0) return null;
  const format = (seconds: number) => formatZaicodeRemaining(seconds, { minutes: clock.longMinutes });
  const open = pinned || (hover && !noHoverPopups);
  // The title bar clips its children (overflow hidden): the list is a portal popover under the timer.
  const closeList = () => {
    setPinned(false);
    setHover(false);
  };
  return (
    <Popover open={open} onOpenChange={(next) => (next ? undefined : closeList())}>
      <PopoverAnchor asChild>
        <div className="relative flex shrink-0 items-center" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
          <button
            type="button"
            className={cn(
              "flex h-8 items-center gap-1 px-1.5 text-ui-xs font-semibold tabular-nums hover:bg-hover",
              pinned && "bg-selected",
              useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
            )}
            style={next ? { color: zaicodeVendorColor(next.vendor) } : undefined}
            title={noHoverPopups ? "Click: nearest resets · right-click: Engines & limits" : undefined}
            onClick={() => setPinned((value) => !value)}
            onContextMenu={(event) => {
              event.preventDefault();
              void openZaicodeSettings("zaicodeEngines");
            }}
            data-zaicode-reset-timer={next?.vendor ?? ""}
          >
            {next ? `${next.accountShort} ↺ ${format((next.at - now) / 1000)}` : "↺ full"}
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="end"
        className="w-auto border border-[var(--zaicode-highlight,var(--color-border))] p-2"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <ResetTable rows={rows} now={now} format={format} hour12={clock.hour12} />
      </PopoverContent>
    </Popover>
  );
}
