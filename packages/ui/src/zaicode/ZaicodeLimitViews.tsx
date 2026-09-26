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
  const windows = snapshot ? effectiveZaicodeWindows(snapshot.windows, now) : [];
  const updated = snapshot?.fetchedAt ? `${formatZaicodeDuration(now - snapshot.fetchedAt)} ago` : null;
  return (
    <div className="flex flex-col gap-0.5" data-zaicode-account-limits={account.id}>
      <div className="flex items-baseline gap-1.5">
        <span className="font-semibold" style={{ color: zaicodeVendorColor(account.vendor) }}>
          {account.label}
        </span>
        {snapshot?.plan ? <span className="text-foreground-subtle">({snapshot.plan})</span> : null}
        <span className="text-foreground-subtlest">
          [{probing ? "reading…" : updated ? `updated ${updated}` : account.short}]
        </span>
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
            className={cn("grid items-center gap-2 pl-2", compact ? "grid-cols-[88px_60px_34px_1fr]" : "grid-cols-[120px_80px_40px_1fr]")}
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
      {snapshot?.error && windows.length > 0 ? (
        <div className="pl-2 text-foreground-subtlest">last read failed: {snapshot.error}</div>
      ) : null}
    </div>
  );
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
    <div className="flex w-[420px] flex-col gap-2 text-ui-xs" data-zaicode-limits-panel>
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-foreground">AI Usage Limits</span>
        <span className="text-foreground-subtlest">
          {accounts.length} engines · reading quota never spends quota
        </span>
      </div>
      {accounts.length === 0 ? (
        <div className="text-foreground-subtle">No Claude / Codex / Antigravity / ZCode account found yet.</div>
      ) : null}
      {accounts.map((account) => (
        <div key={account.id} className="border-t border-border/60 pt-1.5">
          <ZaicodeAccountLimits
            account={account}
            snapshot={limits[account.id]}
            now={now}
            probing={probing.includes(account.id)}
          />
        </div>
      ))}
      {footer ? <div className="border-t border-border/60 pt-1.5 text-foreground-subtlest">{footer}</div> : null}
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
  if (account.status !== "ready" && account.statusDetail) lines.push(account.statusDetail);
  return lines.join("\n");
}

export { ZAICODE_TONE_COLORS };
