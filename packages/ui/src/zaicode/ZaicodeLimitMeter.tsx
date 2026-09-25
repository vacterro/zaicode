import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  effectiveZaicodeWindows,
  zaicodeBottleneck,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import {
  readZaicodeEngine,
  readZaicodeEnginesState,
  refreshZaicodeEngineLimits,
  useZaicodeEngines,
  visibleZaicodeAccounts,
  zaicodeRemainingColor,
} from "./zaicodeEngines.js";
import { ZaicodeLimitsPanel, useZaicodeClock, zaicodeReadingTitle, zaicodeVendorColor } from "./ZaicodeLimitViews.js";
import {
  ZAICODE_LIMIT_METER_STYLES,
  isZaicodeEngineShown,
  setZaicodeLimitMeterStyle,
  useZaicodeLimitMeterStyle,
  useZaicodeMeterPrefs,
  zaicodeMeterFillPercent,
  zaicodeTintedLevelColor,
  type ZaicodeLimitMeterStyle,
  type ZaicodeMeterFill,
} from "./zaicodeMeterPrefs.js";
import { ZaicodeMeterSettingsPanel } from "./ZaicodeMeterSettings.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { detectZaicodeWindowRefills, type ZaicodeRefillMemory } from "./zaicodeLimitRefills.js";
import { notifyZaicode, useZaicodeFresh, useZaicodeNotifySettings } from "./zaicodeNotifications.js";
import { endZaicodeGlowsInUse, zaicodeGlowHandlers, zaicodeGlowStyle } from "./zaicodeGlow.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { useZaicodePreparedMeters } from "./ZaicodeSchedulerBits.js";
import { withZaicodeHighlight } from "./zaicodeHighlights.js";

/**
 * AI Limit meter in the title bar (FastPrompter's header meter): one reading
 * per engine, hover for the full breakdown, click for Engines settings,
 * Ctrl+Click cycles Bars / Dots / Stacked, Shift+Click re-reads every quota,
 * right-click: which engines show and how (hide 0% used, only engines that
 * can work now, fill direction, vendor tint, names).
 */

export { setZaicodeLimitMeterStyle, useZaicodeLimitMeterStyle, type ZaicodeLimitMeterStyle };

const MAX_SHOWN = 9;

/** The short and the long window of an account (5h over weekly), for the stacked style. */
function stackedPair(snapshot: ZaicodeLimitSnapshot | undefined, now: number): [number | null, number | null] {
  if (!snapshot) return [null, null];
  const effective = effectiveZaicodeWindows(snapshot.windows, now).filter((window) => !window.key.startsWith("weekly_"));
  const bottleneck = zaicodeBottleneck(snapshot.windows, now);
  const group = bottleneck?.group ?? "";
  const pool = effective.filter((window) => window.group === group);
  const sorted = [...pool].sort((left, right) => (left.durationMinutes ?? 0) - (right.durationMinutes ?? 0));
  const short = sorted[0]?.remainingPercent ?? null;
  const long = sorted.length > 1 ? (sorted[sorted.length - 1]?.remainingPercent ?? null) : short;
  return [short, long];
}

interface CellLook {
  fill: ZaicodeMeterFill;
  vendorTint: boolean;
  showLabels: boolean;
}

function MeterCell({
  account,
  snapshot,
  style,
  now,
  look,
}: {
  account: ZaicodeEngineAccount;
  snapshot: ZaicodeLimitSnapshot | undefined;
  style: ZaicodeLimitMeterStyle;
  now: number;
  look: CellLook;
}) {
  const reading = readZaicodeEngine(account, snapshot, now);
  const fresh = useZaicodeFresh(`engine:${account.id}`);
  // SRC-038: a schedule waits for this engine's reset -> the cell shows "prompt ready".
  const prepared = useZaicodePreparedMeters()(account.id);
  const glow = useZaicodeNotifySettings().glow;
  const offline = reading.tone === "offline";
  const vendor = zaicodeVendorColor(account.vendor);
  const color = (remaining: number | null) => zaicodeTintedLevelColor(zaicodeRemainingColor(remaining), vendor, look.vendorTint);
  const label =
    style === "stacked" || look.showLabels ? (
      <span className="text-[9px] leading-none" style={{ color: offline ? undefined : vendor }}>
        {account.short}
      </span>
    ) : null;
  let body: React.ReactNode;
  if (style === "dots") {
    body = (
      <span
        className={cn("inline-block size-2.5 border border-black/70", offline && "border-dashed")}
        style={{ background: offline ? "transparent" : color(reading.remaining) }}
      />
    );
  } else if (style === "bars") {
    body = (
      <span className="relative inline-block h-4 w-1.5 border border-black/70 bg-black/35">
        <span
          className="absolute inset-x-0 bottom-0"
          style={{
            height: `${zaicodeMeterFillPercent(reading.remaining, look.fill)}%`,
            background: color(reading.remaining),
            opacity: reading.stale ? 0.55 : 1,
          }}
        />
      </span>
    );
  } else {
    body = stackedPair(snapshot, now).map((value, index) => (
      <span key={index} className="relative block h-[3px] w-5 bg-black/45">
        <span
          className="absolute inset-y-0 left-0"
          style={{
            width: `${zaicodeMeterFillPercent(value, look.fill)}%`,
            background: color(value),
            opacity: reading.stale ? 0.55 : 1,
          }}
        />
      </span>
    ));
  }
  return (
    <span
      {...withZaicodeHighlight(
        {
          className: "flex flex-col items-center gap-px",
          style: fresh ? zaicodeGlowStyle(fresh, now, glow) : undefined,
          ...(prepared.hint ? { title: prepared.hint } : {}),
        },
        fresh ? null : prepared.lights,
      )}
      data-zaicode-meter-cell={account.short}
      data-zaicode-fresh={fresh ? "true" : undefined}
      data-zaicode-prepared={prepared.hint ? "true" : undefined}
      {...zaicodeGlowHandlers([`engine:${account.id}`], Boolean(fresh))}
    >
      {label}
      {body}
    </span>
  );
}

export function ZaicodeLimitMeter({ useWindowsCaptionSpacing = false }: { useWindowsCaptionSpacing?: boolean }) {
  const engines = useZaicodeEngines();
  const style = useZaicodeLimitMeterStyle();
  const prefs = useZaicodeMeterPrefs();
  const now = useZaicodeClock(30_000);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const all = visibleZaicodeAccounts(engines);
  if (all.length === 0) return null;
  const accounts = all.filter((account) => isZaicodeEngineShown(account, engines.limits[account.id], prefs, "meter", now));
  const shown = accounts.slice(0, MAX_SHOWN);
  const overflow = accounts.length - shown.length;
  const filtered = all.length - accounts.length;
  const look: CellLook = { fill: prefs.fill, vendorTint: prefs.vendorTint, showLabels: prefs.showLabels };

  return (
    <ZaicodeRightClickSettings
      title="AI limit meter"
      hint="Which engines the meter shows and how. Per-engine hide here affects the meter only."
      panel={<ZaicodeMeterSettingsPanel />}
      align="end"
    >
      <button
        ref={buttonRef}
        type="button"
        data-zaicode-limit-meter={style}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1 px-1.5 text-foreground-subtle hover:bg-hover",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        )}
        aria-label={`AI limits: ${accounts
          .map((account) => zaicodeReadingTitle(account, engines.limits[account.id], now).split("\n")[1])
          .join("; ")}`}
        onMouseEnter={() => setRect(buttonRef.current?.getBoundingClientRect() ?? null)}
        onMouseLeave={() => setRect(null)}
        onContextMenu={() => setRect(null)}
        onClick={(event) => {
          if (event.ctrlKey || event.metaKey) {
            const next = ZAICODE_LIMIT_METER_STYLES[(ZAICODE_LIMIT_METER_STYLES.indexOf(style) + 1) % ZAICODE_LIMIT_METER_STYLES.length]!;
            setZaicodeLimitMeterStyle(next);
            playZaicodeSound("ui.toggle");
            return;
          }
          if (event.shiftKey) {
            toast("Reading every quota…");
            void refreshZaicodeEngineLimits().then(() => playZaicodeSound("limits.refresh"));
            return;
          }
          setPendingSettingsSection("zaicodeEngines");
          openSettingsTab();
        }}
      >
        {shown.length === 0 ? (
          <span className="text-[9px] text-foreground-subtlest" title="Every engine is hidden by the meter rules">
            AI —
          </span>
        ) : (
          <span className={cn("flex items-end", style === "stacked" || look.showLabels ? "gap-1" : "gap-[3px]")}>
            {shown.map((account) => (
              <MeterCell key={account.id} account={account} snapshot={engines.limits[account.id]} style={style} now={now} look={look} />
            ))}
          </span>
        )}
        {overflow > 0 ? <span className="text-[9px] text-foreground-subtlest">+{overflow}</span> : null}
        {engines.sweeping ? <span className="size-1 animate-pulse bg-[#c9a227]" aria-hidden="true" /> : null}
      </button>
      {rect
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[200] border border-[var(--zaicode-highlight,var(--color-border))] bg-tooltip p-2 text-tooltip-foreground shadow-md"
              style={{ top: rect.bottom + 4, left: Math.max(8, Math.min(rect.right - 436, window.innerWidth - 444)) }}
            >
              <ZaicodeLimitsPanel
                accounts={all}
                limits={engines.limits}
                probing={engines.probing}
                now={now}
                footer={
                  <>
                    Click: Engines settings · Ctrl+Click: Bars / Dots / Stacked · Shift+Click: read all now · Right-click:
                    what the meter shows
                    {filtered > 0 ? ` · ${filtered} hidden from the meter` : ""}
                    {overflow > 0 ? ` · +${overflow} more than fit in the header` : ""}
                  </>
                }
              />
            </div>,
            document.body,
          )
        : null}
    </ZaicodeRightClickSettings>
  );
}

// ---------------------------------------------------------------------------
// Refill / low alerts (once per window per reset cycle, like LIMISAW)
// ---------------------------------------------------------------------------

/**
 * Watches every engine: a window that really reset (its quota climbed back
 * near full) is announced by name ("C2 weekly reset") and glows on the meter
 * and the sidebar tile for the scenario's minutes; a drop under 20% or out of
 * quota is announced once per reset cycle. Mount once.
 */
export function useZaicodeLimitAlerts(): void {
  const seenRef = useRef<Map<string, { blocked: boolean; low: boolean }>>(new Map());
  const alertedLowRef = useRef<Set<string>>(new Set());
  const refillMemoryRef = useRef<Map<string, ZaicodeRefillMemory>>(new Map());
  const engines = useZaicodeEngines();
  const now = useZaicodeClock(60_000);

  useEffect(() => {
    const state = readZaicodeEnginesState();
    // Quota levels now, for the "glow ends when the quota is used" rule.
    const remainingByKey = new Map<string, number>();
    for (const account of visibleZaicodeAccounts(state)) {
      const snapshot = state.limits[account.id];
      if (!snapshot || snapshot.windows.length === 0) continue;
      const reading = readZaicodeEngine(account, snapshot, now);
      if (reading.remaining === null) continue;
      remainingByKey.set(`engine:${account.id}`, reading.remaining);
      // SRC-035 fix: the effective windows, so a window whose reset time has passed is announced (and
      // glows) at once, like the limits panel already shows it "refilled"; before, only windows re-read
      // after their reset were announced, late or never, so a run of resets glowed only in part. The
      // latch keeps the later measured reading of the same reset from announcing it twice.
      const effective = effectiveZaicodeWindows(snapshot.windows, now).map((window) => ({
        key: window.key,
        label: window.label,
        remainingPercent: window.remainingPercent,
      }));
      for (const window of effective) {
        if (window.remainingPercent !== null) remainingByKey.set(`window:${account.id}|${window.key}`, window.remainingPercent);
      }
      const refills = detectZaicodeWindowRefills(account.id, effective, refillMemoryRef.current);
      const blocked = reading.availability === "blocked";
      const low = reading.availability === "low";
      const previous = seenRef.current.get(account.id);
      seenRef.current.set(account.id, { blocked, low });
      if (refills.length > 0) {
        const names = refills.map((refill) => refill.label).join(" + ");
        playZaicodeSound("limits.refill");
        notifyZaicode("limits.refill", {
          header: "Limits",
          title: `${account.short} ${names} reset`,
          body: `${account.label}: ${refills
            .map((refill) => `${refill.label} ${Math.round(refill.from)}% → ${Math.round(refill.to)}%`)
            .join(", ")}`,
          status: "Fresh quota",
          key: `refill:${account.id}`,
          highlight: [`engine:${account.id}`, ...refills.map((refill) => `window:${account.id}|${refill.key}`)],
          highlightLabel: `${names} reset`,
          highlightPeaks: {
            [`engine:${account.id}`]: reading.remaining,
            ...Object.fromEntries(refills.map((refill) => [`window:${account.id}|${refill.key}`, refill.to])),
          },
        });
        continue;
      }
      // The first observation only records what is already true.
      if (!previous) {
        if (low || blocked) alertedLowRef.current.add(lowKey(account.id, snapshot, now));
        continue;
      }
      if (previous.blocked && !blocked) {
        playZaicodeSound("limits.refill");
        notifyZaicode("limits.refill", {
          header: "Limits",
          title: `${account.short} has quota again`,
          body: `${account.label}: ${Math.round(reading.remaining)}% left`,
          status: "Back to work",
          key: `refill:${account.id}`,
          highlight: [`engine:${account.id}`],
          highlightLabel: "quota back",
          highlightPeaks: { [`engine:${account.id}`]: reading.remaining },
        });
      } else if ((low || blocked) && !previous.low && !previous.blocked) {
        const key = lowKey(account.id, snapshot, now);
        if (!alertedLowRef.current.has(key)) {
          alertedLowRef.current.add(key);
          playZaicodeSound("limits.low");
          notifyZaicode("limits.low", {
            header: "Limits",
            title: `${account.short} ${blocked ? "is out of quota" : `is low: ${Math.round(reading.remaining)}%`}`,
            body: `${account.label}${reading.bottleneckLabel ? ` · ${reading.bottleneckLabel}` : ""}`,
            status: blocked ? "Out of quota" : "Low quota",
            key: `low:${account.id}`,
            highlight: [`engine:${account.id}`],
            highlightLabel: blocked ? "out of quota" : "low",
          });
        }
      }
    }
    endZaicodeGlowsInUse(remainingByKey);
  }, [engines, now]);
}

function lowKey(accountId: string, snapshot: ZaicodeLimitSnapshot, now: number): string {
  const bottleneck = zaicodeBottleneck(snapshot.windows, now);
  return `${accountId}|${bottleneck?.key ?? ""}|${bottleneck?.resetsAt ?? ""}`;
}
