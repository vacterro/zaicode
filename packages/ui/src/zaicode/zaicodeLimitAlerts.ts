import { useEffect, useRef } from "react";
import {
  effectiveZaicodeWindows,
  zaicodeBottleneck,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import {
  readZaicodeEngine,
  readZaicodeEnginesState,
  useZaicodeEngines,
  visibleZaicodeAccounts,
} from "./zaicodeEngines.js";
import { useZaicodeClock } from "./ZaicodeLimitViews.js";
import { detectZaicodeWindowRefills, type ZaicodeRefillMemory } from "./zaicodeLimitRefills.js";
import { notifyZaicode } from "./zaicodeNotifications.js";
import { endZaicodeGlowsInUse } from "./zaicodeGlow.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * T-278: the meter's refill / low-quota watcher, extracted from
 * ZaicodeLimitMeter so the meter module keeps to the 400-line budget. Mounted
 * once by App; every owner it touches is imported, none is re-owned here.
 */

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
        if (window.remainingPercent !== null)
          remainingByKey.set(`window:${account.id}|${window.key}`, window.remainingPercent);
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
            .map(
              (refill) => `${refill.label} ${Math.round(refill.from)}% → ${Math.round(refill.to)}%`,
            )
            .join(", ")}`,
          status: "Fresh quota",
          key: `refill:${account.id}`,
          highlight: [
            `engine:${account.id}`,
            ...refills.map((refill) => `window:${account.id}|${refill.key}`),
          ],
          highlightLabel: `${names} reset`,
          highlightPeaks: {
            [`engine:${account.id}`]: reading.remaining,
            ...Object.fromEntries(
              refills.map((refill) => [`window:${account.id}|${refill.key}`, refill.to]),
            ),
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
