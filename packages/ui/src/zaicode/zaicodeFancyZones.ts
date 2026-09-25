import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { getZaicodeDesktopBridge, type ZaicodeWindowZone } from "./zaicodeDesktopBridge.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * Ctrl+Q zone picker, cloned from FastPrompter's fancy_zones.py:
 *
 *   Quarters  the classic four-corner snap
 *   Columns   Left 640 / Mid 800 / Right 640 as fractions (a 1920 screen's figures)
 *   Presets   your saved window positions (S saves, Delete removes, up to 10)
 *
 * Tab / arrows switch pages and the last page is remembered; 1-9 and 0 pick a
 * zone; Enter takes the hovered one; Esc or Q closes. Fast mode skips the
 * picker and walks the zones of the remembered page on every Ctrl+Q. Zones
 * are fractions of the display work area, so a layout behaves the same on a
 * laptop panel and a 4K monitor and never covers the taskbar.
 */

export type FancyZoneRect = ZaicodeWindowZone;

export interface FancyZoneLayout {
  id: string;
  name: string;
  zones: readonly FancyZoneRect[];
}

export const BUILTIN_FANCYZONE_LAYOUTS: readonly FancyZoneLayout[] = [
  {
    id: "Quarters",
    name: "Quarters",
    zones: [
      { fx: 0.0, fy: 0.0, fw: 0.5, fh: 0.5 },
      { fx: 0.5, fy: 0.0, fw: 0.5, fh: 0.5 },
      { fx: 0.0, fy: 0.5, fw: 0.5, fh: 0.5 },
      { fx: 0.5, fy: 0.5, fw: 0.5, fh: 0.5 },
    ],
  },
  {
    id: "Columns",
    name: "Columns",
    zones: [
      { fx: 0.0, fy: 0.0, fw: 1 / 3, fh: 1.0 },
      { fx: 7 / 24, fy: 0.0, fw: 5 / 12, fh: 1.0 },
      { fx: 2 / 3, fy: 0.0, fw: 1 / 3, fh: 1.0 },
    ],
  },
];

export const FANCYZONE_MAX_PRESETS = 10;

export interface ZaicodeFancyZonesSettings {
  /** Ctrl+Q is ZAICODE's (off: the key passes through). */
  enabled: boolean;
  layoutId: string;
  fastMode: boolean;
  soundEnabled: boolean;
  fastIndex: number;
  /** The Presets page is opt-in, like every added surface in FastPrompter (on by default there too). */
  presetsEnabled: boolean;
  presets: FancyZoneRect[];
}

const STORAGE_KEY = "zaicode-fancyzones-settings";
const CHANGE_EVENT = "zaicode-fancyzones-changed";

const DEFAULT_SETTINGS: ZaicodeFancyZonesSettings = {
  enabled: true,
  layoutId: "Quarters",
  fastMode: false,
  soundEnabled: true,
  fastIndex: -1,
  presetsEnabled: true,
  presets: [],
};

function healFraction(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

/** A corrupt preset can never place the window off-screen or collapse it (FastPrompter T-1025). */
export function healFancyZone(raw: unknown): FancyZoneRect | null {
  if (!raw || typeof raw !== "object") return null;
  const zone = raw as Partial<FancyZoneRect>;
  const size = (value: unknown) => {
    const fraction = healFraction(value, 0.1);
    return fraction > 0.02 ? fraction : 0.1;
  };
  return {
    fx: healFraction(zone.fx, 0),
    fy: healFraction(zone.fy, 0),
    fw: size(zone.fw),
    fh: size(zone.fh),
    state: zone.state === "maximized" ? "maximized" : "normal",
  };
}

export function normalizeZaicodeFancyZonesSettings(raw: unknown): ZaicodeFancyZonesSettings {
  const parsed = (raw && typeof raw === "object" ? raw : {}) as Partial<ZaicodeFancyZonesSettings>;
  const presets = Array.isArray(parsed.presets)
    ? parsed.presets.map(healFancyZone).filter((zone): zone is FancyZoneRect => zone !== null).slice(0, FANCYZONE_MAX_PRESETS)
    : [];
  const layoutIds = ["Presets", ...BUILTIN_FANCYZONE_LAYOUTS.map((layout) => layout.id)];
  return {
    enabled: parsed.enabled !== false,
    layoutId: typeof parsed.layoutId === "string" && layoutIds.includes(parsed.layoutId) ? parsed.layoutId : DEFAULT_SETTINGS.layoutId,
    fastMode: Boolean(parsed.fastMode),
    soundEnabled: parsed.soundEnabled !== false,
    fastIndex: typeof parsed.fastIndex === "number" && Number.isFinite(parsed.fastIndex) ? Math.max(-1, Math.round(parsed.fastIndex)) : -1,
    presetsEnabled: parsed.presetsEnabled !== false,
    presets,
  };
}

let cachedSettings: ZaicodeFancyZonesSettings | null = null;

export function readZaicodeFancyZonesSettings(): ZaicodeFancyZonesSettings {
  if (cachedSettings) return cachedSettings;
  try {
    cachedSettings = normalizeZaicodeFancyZonesSettings(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    cachedSettings = normalizeZaicodeFancyZonesSettings(null);
  }
  return cachedSettings;
}

export function writeZaicodeFancyZonesSettings(patch: Partial<ZaicodeFancyZonesSettings>): void {
  cachedSettings = normalizeZaicodeFancyZonesSettings({ ...readZaicodeFancyZonesSettings(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedSettings));
  } catch {
    // Session-only fallback
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Builtin pages + the Presets page (when enabled and not empty). */
export function fancyZoneLayouts(settings: ZaicodeFancyZonesSettings = readZaicodeFancyZonesSettings()): FancyZoneLayout[] {
  const layouts: FancyZoneLayout[] = [...BUILTIN_FANCYZONE_LAYOUTS];
  if (settings.presetsEnabled) layouts.push({ id: "Presets", name: "Presets", zones: settings.presets });
  return layouts;
}

export function fancyZoneLayoutById(id: string, settings?: ZaicodeFancyZonesSettings): FancyZoneLayout {
  const layouts = fancyZoneLayouts(settings);
  return layouts.find((layout) => layout.id === id) ?? layouts[0]!;
}

export async function applyFancyZone(zone: FancyZoneRect): Promise<boolean> {
  const bridge = getZaicodeDesktopBridge();
  if (!bridge?.snapWindowZone) return false;
  try {
    const res = await bridge.snapWindowZone(zone);
    if (res?.success) {
      if (readZaicodeFancyZonesSettings().soundEnabled) playZaicodeSound("window.snap");
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Fast mode: no picker, just the next zone of the remembered page. */
export async function cycleFastFancyZone(step = 1): Promise<boolean> {
  const settings = readZaicodeFancyZonesSettings();
  const layout = fancyZoneLayoutById(settings.layoutId, settings);
  if (!layout.zones.length) return false;
  const nextIdx = (((settings.fastIndex + step) % layout.zones.length) + layout.zones.length) % layout.zones.length;
  writeZaicodeFancyZonesSettings({ fastIndex: nextIdx });
  const targetZone = layout.zones[nextIdx];
  return targetZone ? applyFancyZone(targetZone) : false;
}

/** Saves the window's current rectangle (and maximized state) as a preset; oldest drops past 10. */
export async function saveCurrentWindowAsFancyPreset(): Promise<number | null> {
  const bridge = getZaicodeDesktopBridge();
  const zone = await bridge?.getWindowZone?.().catch(() => null);
  const healed = healFancyZone(zone);
  if (!healed) return null;
  const presets = [...readZaicodeFancyZonesSettings().presets, healed].slice(-FANCYZONE_MAX_PRESETS);
  writeZaicodeFancyZonesSettings({ presets, presetsEnabled: true });
  playZaicodeSound("window.preset");
  return presets.length - 1;
}

export function deleteFancyPreset(index: number): void {
  const presets = readZaicodeFancyZonesSettings().presets.filter((_, position) => position !== index);
  writeZaicodeFancyZonesSettings({ presets });
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export function useZaicodeFancyZones(): ZaicodeFancyZonesSettings {
  return useSyncExternalStore(subscribe, readZaicodeFancyZonesSettings, readZaicodeFancyZonesSettings);
}
