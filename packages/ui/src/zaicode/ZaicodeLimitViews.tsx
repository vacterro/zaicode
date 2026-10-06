import { useEffect, useState } from "react";
import {
  ZAICODE_ENGINE_VENDOR_LABELS,
  effectiveZaicodeWindows,
  formatZaicodeDuration,
  formatZaicodeWindowReset,
  zaicodeNextRefillAt,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  ZAICODE_TONE_COLORS,
  readZaicodeEngine,
  zaicodeRemainingColor,
  zaicodeRemainingTextColor,
  type ZaicodeEngineReading,
} from "./zaicodeEngines.js";
import { readZaicodeFresh, useZaicodeFreshVersion, useZaicodeNotifySettings } from "./zaicodeNotifications.js";
import { zaicodeGlowHandlers, zaicodeGlowStyle } from "./zaicodeGlow.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { zaicodeSchedulerEligible, zaicodeSchedulerEligibilityPatch } from "./zaicodeSchedulerEligibility.js";
import { ZaicodeResetCreditButton, expiryLabel } from "./ZaicodeResetCreditsSection.js";
import { zaicodeResetCreditRows } from "./zaicodeResetCredits.js";

/** Re-render every `intervalMs` so countdowns and elapsed resets stay true. */
export function useZaicodeClock(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const VENDOR_COLORS: Record<string, string> = {
  claude: "#d9774b",
  codex: "#58a6d8",
  antigravity: "#a78bda",
  zcode: "#d7b54a",
  // Freebuff's own brand accent (FastPrompter measured it from Freebuff's UI assets).
  freebuff: "#50ecb3",
};

export function zaicodeVendorColor(vendor: string): string {
  return VENDOR_COLORS[vendor] ?? "#b8b09a";
}

/** One flat meter, pixel edges, fill = remaining. */
export function ZaicodeLimitBar({
  remaining,
  className,
  stale = false,
}: {
  remaining: number | null;
  className?: string;
  stale?: boolean;
}) {
  const width = remaining === null ? 0 : Math.max(remaining > 0 ? 3 : 0, Math.round(remaining));
  return (
    <span
      className={cn("relative inline-block h-2 overflow-hidden border border-black/60 bg-black/35", className)}
      aria-hidden="true"
    >
      <span
        className="absolute inset-y-0 left-0"
        style={{ width: `${width}%`, background: zaicodeRemainingColor(remaining), opacity: stale ? 0.55 : 1 }}
      />
    </span>
  );
}

export function describeZaicodeReading(
  account: ZaicodeEngineAccount,
  reading: ZaicodeEngineReading,
  snapshot: ZaicodeLimitSnapshot | undefined,
  now: number,
): string {
  if (account.optional) return `${account.label}: optional, sign in any time`;
  if (account.status === "cli-missing") return `${account.label}: CLI missing`;
  if (account.status === "login-required") return `${account.label}: sign-in required`;
  if (reading.availability === "blocked") {
    const back = zaicodeNextRefillAt(snapshot, now);
    return `${account.label}: blocked${back ? ` · back in ${formatZaicodeDuration(back - now)}` : ""}`;
  }
  if (reading.remaining === null) return `${account.label}: no reading yet`;
  return `${account.label}: ${Math.round(reading.remaining)}% ${reading.bottleneckLabel ?? ""}`.trim();
}

/** Account section: vendor-colored title, then one row per window. */
export function ZaicodeAccountLimits({
  account,
  snapshot,
  now,
  probing = false,
  compact = false,
}: {
  account: ZaicodeEngineAccount;
  snapshot: ZaicodeLimitSnapshot | undefined;
  now: number;
  probing?: boolean;
  compact?: boolean;
}) {
  useZaicodeFreshVersion();
  const glow = useZaicodeNotifySettings().glow;
  // SRC-132: Ctrl+Click answers "may the Scheduler route work here?" -- never "is
  // this account usable?". The quota rows below stay exactly as they are.
  const answers = useZaicodeUiPrefs((state) => state.schedulerIneligible);
  const eligible = zaicodeSchedulerEligible({ schedulerIneligible: answers }, account.id);
  const windows = snapshot ? effectiveZaicodeWindows(snapshot.windows, now) : [];
  const updated = snapshot?.fetchedAt ? `${formatZaicodeDuration(now - snapshot.fetchedAt)} ago` : null;
  // T-130: a Codex account with reset credits says so here, with the button, right under the windows they would refill.
  const credits = zaicodeResetCreditRows([account], { [account.id]: snapshot }, now)[0] ?? null;
  return (
    <div
      className={cn("flex flex-col", compact ? "gap-0 leading-[1.2]" : "gap-0.5")}
      data-zaicode-account-limits={account.id}
      data-zaicode-scheduler-eligible={eligible ? "yes" : "no"}
      title={
        eligible
          ? "Ctrl+Click: do not schedule work here (the account stays usable by hand)"
          : "Ctrl+Click: let the Scheduler route work here again"
      }
      onClick={(event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        const store = useZaicodeUiPrefs.getState();
        store.update(zaicodeSchedulerEligibilityPatch({ schedulerIneligible: answers }, account.id));
      }}
    >
      <div className="flex items-baseline gap-1.5">
        <span className={cn("font-semibold", !eligible && "opacity-50 line-through")} style={{ color: zaicodeVendorColor(account.vendor) }}>
          {account.label}
        </span>
        {snapshot?.plan ? <span className="text-foreground-subtle">({snapshot.plan})</span> : null}
        <span className="text-foreground-subtlest">
          [{probing ? "reading…" : updated ? `updated ${updated}` : account.short}]
        </span>
        {!eligible ? <span className="text-foreground-subtlest">· not scheduled</span> : null}
      </div>
      {account.status !== "ready" && account.status !== "no-plan" ? (
        <div className="pl-2 text-[color:var(--zaicode-warn,#c9a227)]">{account.statusDetail}</div>
      ) : null}
      {windows.length === 0 && account.status === "ready" ? (
        <div className="pl-2 text-foreground-subtlest">{snapshot?.error ?? "not read yet"}</div>
      ) : null}
      {windows.map((window) => {
        const remaining = window.remainingPercent;
        const fresh = readZaicodeFresh(`window:${account.id}|${window.key}`);
        const reset = fresh
          ? fresh.label
          : formatZaicodeWindowReset(window, now);
        return (
          <div
            key={window.key}
            className={cn("grid items-center pl-2", compact ? "grid-cols-[124px_52px_34px_1fr] gap-x-1.5" : "grid-cols-[120px_80px_40px_1fr] gap-2")}
            style={fresh ? zaicodeGlowStyle(fresh, now, glow) : undefined}
            data-zaicode-fresh={fresh ? "true" : undefined}
            title={fresh ? `${fresh.label}: click to mark it seen` : undefined}
            {...zaicodeGlowHandlers([`window:${account.id}|${window.key}`], Boolean(fresh))}
          >
            <span className="truncate text-foreground-subtle">{window.label}</span>
            <ZaicodeLimitBar remaining={remaining} className="w-full" stale={Boolean(snapshot?.error)} />
            <span className="text-right tabular-nums" style={{ color: zaicodeRemainingTextColor(remaining) }}>
              {remaining === null ? "--" : `${Math.round(remaining)}%`}
            </span>
            <span
              className={cn("truncate", window.gatedBy ? "text-[color:#c8502a]" : "text-foreground-subtlest")}
            >
              — {reset}
            </span>
          </div>
        );
      })}
      {credits ? (
        <div className="flex items-center gap-2 pl-2" data-zaicode-account-reset-credits={account.id}>
          <span className="shrink-0 font-semibold text-[var(--zaicode-highlight,var(--color-warning))]">
            ⟲ {credits.usable} reset credit{credits.usable === 1 ? "" : "s"}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground-subtlest" title={credits.credit?.description ?? undefined}>
            {credits.credit?.title ? `${credits.credit.title} · ` : ""}
            {expiryLabel(credits.nextExpiresAt, now)}
          </span>
          <ZaicodeResetCreditButton row={credits} />
        </div>
      ) : null}
      {snapshot?.error && windows.length > 0 ? (
        <div className="pl-2 text-foreground-subtlest">last read failed: {snapshot.error}</div>
      ) : null}
      {snapshot?.windowStart ? (
        <div className="pl-2 text-foreground-subtlest" title={snapshot.windowStart.detail}>
          {describeZaicodeWindowStart(snapshot.windowStart, now)}
        </div>
      ) : null}
    </div>
  );
}

/** Request completion is separate from the vendor-backed countdown above it. */
export function describeZaicodeWindowStart(
  record: { at: number; ok: boolean; detail: string },
  now: number,
): string {
  const ago = `${formatZaicodeDuration(Math.max(0, now - record.at))} ago`;
  // CLI 完成只证明请求被接受；是否真的运行由供应商 quota/reset 决定。
  return record.ok ? `window start request accepted ${ago}` : `window start failed ${ago}: ${record.detail}`;
}

/** FastPrompter "AI Usage Limits" panel: every visible account, grouped. */
export function ZaicodeLimitsPanel({
  accounts,
  limits,
  probing,
  now,
  footer,
}: {
  accounts: readonly ZaicodeEngineAccount[];
  limits: Record<string, ZaicodeLimitSnapshot>;
  probing: readonly string[];
  now: number;
  footer?: React.ReactNode;
}) {
  return (
    // SRC-161:REQ-007: the panel used to be a fixed 420px column with 8px gaps
    // and default line-height, inside a card whose height ceiling it could not
    // see. It now fills the card (which is itself clamped to the window), uses
    // 4px section gaps and tight leading, and inherits the card's max-height and
    // internal scrolling, so a long account list scrolls instead of towering.
    // SRC-162: tighter still -- the operator asked for the minimum line height and no voids.
    <div className="flex w-full min-w-0 flex-col gap-0.5 text-ui-xs leading-[1.2]" data-zaicode-limits-panel>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-semibold text-foreground">AI Usage Limits</span>
        <span className="min-w-0 truncate text-foreground-subtlest">
          {accounts.length} engines · reading quota never spends quota
        </span>
      </div>
      {accounts.length === 0 ? (
        <div className="text-foreground-subtle">No Claude / Codex / Antigravity / ZCode account found yet.</div>
      ) : null}
      {accounts.map((account) => (
        <div key={account.id} className="border-t border-border/60 pt-0.5">
          <ZaicodeAccountLimits
            account={account}
            snapshot={limits[account.id]}
            now={now}
            probing={probing.includes(account.id)}
            compact
          />
        </div>
      ))}
      {footer ? <div className="border-t border-border/60 pt-1 text-foreground-subtlest">{footer}</div> : null}
    </div>
  );
}

export function zaicodeReadingTitle(
  account: ZaicodeEngineAccount,
  snapshot: ZaicodeLimitSnapshot | undefined,
  now: number,
): string {
  const reading = readZaicodeEngine(account, snapshot, now);
  const lines = [
    `${account.label} (${ZAICODE_ENGINE_VENDOR_LABELS[account.vendor]}) · ${account.source}`,
    describeZaicodeReading(account, reading, snapshot, now),
  ];
  for (const window of snapshot ? effectiveZaicodeWindows(snapshot.windows, now) : []) {
    lines.push(
      `  ${window.label}: ${window.remainingPercent === null ? "--" : `${Math.round(window.remainingPercent)}%`} ${
        window.gatedBy ? `(blocked by ${window.gatedBy})` : formatZaicodeWindowReset(window, now)
      }`,
    );
  }
  if (snapshot?.error) lines.push(`  last read: ${snapshot.error}`);
  if (snapshot?.windowStart) lines.push(`  ${describeZaicodeWindowStart(snapshot.windowStart, now)}`);
  if (account.status !== "ready" && account.statusDetail) lines.push(account.statusDetail);
  return lines.join("\n");
}

export { ZAICODE_TONE_COLORS };
