import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * ZAICODE interface preferences that are not layout or audio: the home
 * screen greeting and "Empty" marker, the SAIMAIL envelope, and automatic
 * retry after a failed model turn. Renderer-local (per machine), applied live.
 */

export type ZaicodeGreetingMode = "time" | "custom";
export type ZaicodeSaimailClick = "brief" | "settings";
/** CLEAR: empty this session in place (default) or open a new empty one. */
export type ZaicodeClearMode = "session" | "new";

export interface ZaicodeUiPrefs {
  // Home (empty draft) screen
  showGreeting: boolean;
  greetingMode: ZaicodeGreetingMode;
  /** Custom greeting; `{name}` = active profile name, `{time}` = the time-of-day greeting. */
  greetingText: string;
  /** Show the greeting only from this hour (0..23) ... */
  greetingFromHour: number;
  /** ... until this hour (1..24, exclusive). 0..24 = always. */
  greetingToHour: number;
  showEmptyMarker: boolean;
  // SAIMAIL envelope (right-click it for these)
  saimailOnHome: boolean;
  saimailHomeShowEmpty: boolean;
  saimailShowCount: boolean;
  saimailUnreadRing: boolean;
  saimailHoverPreview: boolean;
  saimailPreviewRows: number;
  saimailClick: ZaicodeSaimailClick;
  // Auto-retry after a failed turn ("the model returned no content", provider errors, ...)
  autoRetry: boolean;
  autoRetryIntervalSec: number;
  autoRetryMaxAttempts: number;
  clearMode: ZaicodeClearMode;
  // Calm interface: less visual noise, nothing moves
  /** No animations or transitions anywhere (fades, slides, spinners). */
  noMotion: boolean;
  /** No dimmed backdrops, blur or see-through panels. */
  noDim: boolean;
  /** No pop-ups on hover (tooltips, hover cards, hover previews). */
  noHoverPopups: boolean;
  /**
   * Home-screen defaults revision. 2 (T-36): the "Empty" marker and the
   * empty SAIMAIL line are off by default; older stored prefs had them on
   * only because every save wrote the old defaults, so they move once.
   */
  homeRev: number;
}

const HOME_REV = 2;

export const ZAICODE_UI_DEFAULT_PREFS: ZaicodeUiPrefs = {
  showGreeting: true,
  greetingMode: "time",
  greetingText: "{time}, {name}",
  greetingFromHour: 0,
  greetingToHour: 24,
  showEmptyMarker: false,
  saimailOnHome: true,
  saimailHomeShowEmpty: false,
  saimailShowCount: true,
  saimailUnreadRing: true,
  saimailHoverPreview: true,
  saimailPreviewRows: 8,
  saimailClick: "brief",
  autoRetry: true,
  autoRetryIntervalSec: 60,
  autoRetryMaxAttempts: 100,
  clearMode: "session",
  noMotion: false,
  noDim: false,
  noHoverPopups: false,
  homeRev: HOME_REV,
};

const STORAGE_KEY = "zaicode-ui-prefs-v1";

function int(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

export function normalizeZaicodeUiPrefs(raw: unknown): ZaicodeUiPrefs {
  const d = ZAICODE_UI_DEFAULT_PREFS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeUiPrefs, unknown>>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const from = int(r.greetingFromHour, 0, 23, d.greetingFromHour);
  const to = int(r.greetingToHour, 1, 24, d.greetingToHour);
  const homeCurrent = typeof r.homeRev === "number" && r.homeRev >= HOME_REV;
  return {
    showGreeting: flag(r.showGreeting, d.showGreeting),
    greetingMode: r.greetingMode === "custom" ? "custom" : "time",
    greetingText:
      typeof r.greetingText === "string" ? r.greetingText.slice(0, 200) : d.greetingText,
    greetingFromHour: from,
    greetingToHour: to,
    showEmptyMarker: homeCurrent ? flag(r.showEmptyMarker, d.showEmptyMarker) : d.showEmptyMarker,
    saimailOnHome: flag(r.saimailOnHome, d.saimailOnHome),
    saimailHomeShowEmpty: homeCurrent ? flag(r.saimailHomeShowEmpty, d.saimailHomeShowEmpty) : d.saimailHomeShowEmpty,
    saimailShowCount: flag(r.saimailShowCount, d.saimailShowCount),
    saimailUnreadRing: flag(r.saimailUnreadRing, d.saimailUnreadRing),
    saimailHoverPreview: flag(r.saimailHoverPreview, d.saimailHoverPreview),
    saimailPreviewRows: int(r.saimailPreviewRows, 1, 30, d.saimailPreviewRows),
    saimailClick: r.saimailClick === "settings" ? "settings" : "brief",
    autoRetry: flag(r.autoRetry, d.autoRetry),
    autoRetryIntervalSec: int(r.autoRetryIntervalSec, 10, 3600, d.autoRetryIntervalSec),
    autoRetryMaxAttempts: int(r.autoRetryMaxAttempts, 1, 1000, d.autoRetryMaxAttempts),
    clearMode: r.clearMode === "new" ? "new" : "session",
    noMotion: flag(r.noMotion, d.noMotion),
    noDim: flag(r.noDim, d.noDim),
    noHoverPopups: flag(r.noHoverPopups, d.noHoverPopups),
    homeRev: HOME_REV,
  };
}

function load(): ZaicodeUiPrefs {
  try {
    return normalizeZaicodeUiPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeUiPrefs(null);
  }
}

interface ZaicodeUiPrefsState extends ZaicodeUiPrefs {
  update: (patch: Partial<ZaicodeUiPrefs>) => void;
}

export const useZaicodeUiPrefs = create<ZaicodeUiPrefsState>((set, get) => ({
  ...load(),
  update: (patch) => {
    const current = get();
    const next = normalizeZaicodeUiPrefs({ ...current, ...patch });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Preference only; the in-memory copy still applies.
    }
    set(next);
  },
}));

/** Whether the greeting shows at `hour` (0..23) for a [from, to) window; from >= to wraps midnight. */
export function isZaicodeGreetingHour(hour: number, from: number, to: number): boolean {
  if (from === 0 && to === 24) return true;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/** Fills `{name}` and `{time}` in a custom greeting. */
export function formatZaicodeGreeting(template: string, values: { name: string; time: string }): string {
  return template.replace(/\{name\}/g, values.name).replace(/\{time\}/g, values.time).trim();
}

/** The <html> classes the calm-interface switches map to (CSS in zaicodePalettes.ts). */
export function zaicodeCalmClasses(prefs: Pick<ZaicodeUiPrefs, "noMotion" | "noDim" | "noHoverPopups">): Record<string, boolean> {
  return {
    "zaicode-no-motion": prefs.noMotion,
    "zaicode-no-dim": prefs.noDim,
    "zaicode-no-popups": prefs.noHoverPopups,
  };
}

/** One switch for all three (the hotkey and the master checkbox). */
export function isZaicodeCalm(prefs: Pick<ZaicodeUiPrefs, "noMotion" | "noDim" | "noHoverPopups">): boolean {
  return prefs.noMotion && prefs.noDim && prefs.noHoverPopups;
}
