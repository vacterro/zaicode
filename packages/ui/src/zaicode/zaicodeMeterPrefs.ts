import { useSyncExternalStore } from "react";
import { create } from "zustand";
import {
  effectiveZaicodeWindows,
  isScopedZaicodeWindow,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * How the AI limit meters look and which engines they show (FastPrompter's
 * "Gauges & accounts"): hide engines nobody touched (0% used), show only
 * engines whose 5h window can work right now, per-engine hide for the meter,
 * fill direction, vendor tint, badges, and the availability tint of the
 * sidebar engine tiles. One store for the title bar meter, the sidebar tiles
 * and Settings -> Engines & limits, so every surface agrees.
 */

export type ZaicodeMeterFill = "remaining" | "used";

export interface ZaicodeMeterPrefs {
  /** Hide engines whose every window still reads 0% used. */
  hideZeroUsage: boolean;
  /** Show only engines that can work now: the 5h window (or the only window) has quota. */
  onlyUsable5h: boolean;
  /** The two rules above apply to the title bar meter ... */
  filterMeter: boolean;
  /** ... and to the sidebar engine tiles. */
  filterTiles: boolean;
  /** Bars show quota left (drains like fuel) or quota used (grows like progress). */
  fill: ZaicodeMeterFill;
  /** Nudge each bar toward its vendor's colour; the level colour still reads first. */
  vendorTint: boolean;
  /** Short names (A1, C2, ...) above the Bars / Dots cells. Stacked always shows them. */
  showLabels: boolean;
  /** Engines hidden from the title bar meter only (still on the sidebar). */
  meterHidden: string[];
  /** Background tint of the sidebar tiles by availability, 0..60 (% of the level colour). */
  availabilityTint: number;
}

export const ZAICODE_METER_DEFAULT_PREFS: ZaicodeMeterPrefs = {
  hideZeroUsage: false,
  onlyUsable5h: false,
  filterMeter: true,
  filterTiles: false,
  fill: "remaining",
  vendorTint: false,
  showLabels: false,
  meterHidden: [],
  availabilityTint: 18,
};

export const ZAICODE_METER_TINT_MAX = 60;

const STORAGE_KEY = "zaicode-meter-prefs-v1";

export function normalizeZaicodeMeterPrefs(raw: unknown): ZaicodeMeterPrefs {
  const d = ZAICODE_METER_DEFAULT_PREFS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeMeterPrefs, unknown>>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const tint = typeof r.availabilityTint === "number" && Number.isFinite(r.availabilityTint)
    ? Math.max(0, Math.min(ZAICODE_METER_TINT_MAX, Math.round(r.availabilityTint)))
    : d.availabilityTint;
  return {
    hideZeroUsage: flag(r.hideZeroUsage, d.hideZeroUsage),
    onlyUsable5h: flag(r.onlyUsable5h, d.onlyUsable5h),
    filterMeter: flag(r.filterMeter, d.filterMeter),
    filterTiles: flag(r.filterTiles, d.filterTiles),
    fill: r.fill === "used" ? "used" : "remaining",
    vendorTint: flag(r.vendorTint, d.vendorTint),
    showLabels: flag(r.showLabels, d.showLabels),
    meterHidden: Array.isArray(r.meterHidden)
      ? [...new Set(r.meterHidden.filter((id): id is string => typeof id === "string"))].slice(0, 64)
      : [],
    availabilityTint: tint,
  };
}

function load(): ZaicodeMeterPrefs {
  try {
    return normalizeZaicodeMeterPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeMeterPrefs(null);
  }
}

interface ZaicodeMeterPrefsState extends ZaicodeMeterPrefs {
  update: (patch: Partial<ZaicodeMeterPrefs>) => void;
  toggleMeterHidden: (accountId: string) => void;
}

export const useZaicodeMeterPrefs = create<ZaicodeMeterPrefsState>((set, get) => ({
  ...load(),
  update: (patch) => {
    const next = normalizeZaicodeMeterPrefs({ ...get(), ...patch });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // preference only; the in-memory copy still applies
    }
    set(next);
  },
  toggleMeterHidden: (accountId) => {
    const hidden = get().meterHidden;
    get().update({
      meterHidden: hidden.includes(accountId) ? hidden.filter((id) => id !== accountId) : [...hidden, accountId],
    });
  },
}));

// ---------------------------------------------------------------------------
// Title bar meter style (its own key since T-34; Ctrl+Click on the meter cycles it)
// ---------------------------------------------------------------------------

export type ZaicodeLimitMeterStyle = "bars" | "dots" | "stacked";
export const ZAICODE_LIMIT_METER_STYLES: readonly ZaicodeLimitMeterStyle[] = ["bars", "dots", "stacked"];
const STYLE_KEY = "zaicode-limit-meter-style";
const STYLE_EVENT = "zaicode-limit-meter-style-changed";
let styleCache: ZaicodeLimitMeterStyle | null = null;

function readMeterStyle(): ZaicodeLimitMeterStyle {
  if (styleCache) return styleCache;
  const raw = (readZaicodeSetting(STYLE_KEY) ?? "").replace(/"/g, "");
  styleCache = (ZAICODE_LIMIT_METER_STYLES as readonly string[]).includes(raw) ? (raw as ZaicodeLimitMeterStyle) : "stacked";
  return styleCache;
}

export function setZaicodeLimitMeterStyle(style: ZaicodeLimitMeterStyle): void {
  styleCache = style;
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch {
    // session only
  }
  window.dispatchEvent(new Event(STYLE_EVENT));
}

export function useZaicodeLimitMeterStyle(): ZaicodeLimitMeterStyle {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(STYLE_EVENT, listener);
      return () => window.removeEventListener(STYLE_EVENT, listener);
    },
    readMeterStyle,
    readMeterStyle,
  );
}

// ---------------------------------------------------------------------------
// Rules (FastPrompter usage_limits/model.py, on ZAICODE windows)
// ---------------------------------------------------------------------------

/**
 * True when some window was used (> 0% spent), false when every window still
 * reads untouched, null when there is no reading to judge (never read,
 * sign-in needed): an unknown engine is not "0% used".
 */
export function zaicodeEngineHasUsage(
  snapshot: ZaicodeLimitSnapshot | undefined,
  now: number = Date.now(),
): boolean | null {
  if (!snapshot) return null;
  const windows = effectiveZaicodeWindows(snapshot.windows, now).filter((window) => window.remainingPercent !== null);
  if (windows.length === 0) return null;
  return windows.some((window) => !window.assumedFull && (window.remainingPercent ?? 100) < 100);
}

/**
 * True when the engine can do work right now. The 5h window is the short gate
 * (a spent 5h refuses work while the weekly pool sits full); a pool without a
 * 5h window is judged by its own windows. Independent pools (Antigravity's
 * Gemini vs Claude/GPT) only need one usable pool. No reading = not usable.
 */
export function zaicodeEngineUsableNow(
  snapshot: ZaicodeLimitSnapshot | undefined,
  now: number = Date.now(),
): boolean {
  if (!snapshot) return false;
  const windows = effectiveZaicodeWindows(snapshot.windows, now).filter(
    (window) => window.remainingPercent !== null && !isScopedZaicodeWindow(window),
  );
  if (windows.length === 0) return false;
  // effectiveZaicodeWindows already zeroes a pool's short windows when its
  // long window is spent, so the 5h reading alone answers "can it work now".
  const groups = new Set(windows.map((window) => window.group));
  for (const group of groups) {
    const pool = windows.filter((window) => window.group === group);
    const five = pool.filter((window) => window.key === "five_hour");
    const gate = five.length > 0 ? five : pool;
    if (gate.some((window) => (window.remainingPercent ?? 0) > 0)) return true;
  }
  return false;
}

export type ZaicodeMeterSurface = "meter" | "tiles";

/** Whether `account` shows on `surface` under `prefs` (per-engine hide is applied by the caller's list). */
export function isZaicodeEngineShown(
  account: ZaicodeEngineAccount,
  snapshot: ZaicodeLimitSnapshot | undefined,
  prefs: Pick<ZaicodeMeterPrefs, "hideZeroUsage" | "onlyUsable5h" | "filterMeter" | "filterTiles" | "meterHidden">,
  surface: ZaicodeMeterSurface,
  now: number = Date.now(),
): boolean {
  if (surface === "meter" && prefs.meterHidden.includes(account.id)) return false;
  const filtered = surface === "meter" ? prefs.filterMeter : prefs.filterTiles;
  if (!filtered) return true;
  if (prefs.hideZeroUsage && zaicodeEngineHasUsage(snapshot, now) === false) return false;
  if (prefs.onlyUsable5h && !zaicodeEngineUsableNow(snapshot, now)) return false;
  return true;
}

/** Bar width for a remaining percent under the fill direction (a spent bar keeps a sliver). */
export function zaicodeMeterFillPercent(remaining: number | null, fill: ZaicodeMeterFill): number {
  if (remaining === null) return 0;
  const value = Math.max(0, Math.min(100, remaining));
  if (fill === "used") return 100 - value;
  return Math.max(value > 0 ? 6 : 0, value);
}

/** Level colour, optionally nudged toward the vendor hue (level still dominates). */
export function zaicodeTintedLevelColor(levelColor: string, vendorColor: string, vendorTint: boolean): string {
  return vendorTint ? `color-mix(in srgb, ${levelColor} 65%, ${vendorColor})` : levelColor;
}

/** Tile background: the level colour at `strength` % over whatever is behind it; none when unknown. */
export function zaicodeAvailabilityTint(levelColor: string | null, strength: number): string | undefined {
  if (!levelColor || strength <= 0) return undefined;
  return `color-mix(in srgb, ${levelColor} ${Math.min(ZAICODE_METER_TINT_MAX, strength)}%, transparent)`;
}
