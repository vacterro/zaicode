import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * How ZAICODE workers (subscription CLIs running in terminals) sit on screen:
 * docked in the bottom WORKERS panel like a normal terminal (default) or in
 * their own snappable windows; the panel as tabs or an even split; where
 * minimized workers stack; the terminal face. Per machine, applied live.
 */

export type ZaicodeWorkerPlacement = "panel" | "window";
export type ZaicodeWorkersPanelLayout = "split" | "tabs";
export type ZaicodeWorkersSplit = "row" | "column" | "grid";
export type ZaicodeWorkersTrayAnchor = "bottom-left" | "bottom-center" | "bottom-right" | "left" | "right";
export type ZaicodeWorkerFont = "terminus" | "profile" | "custom";
/** Which edge of the workspace body the WORKERS panel docks to (SRC-046). */
export type ZaicodeWorkersPanelDock = "bottom" | "left" | "right" | "top";
/** What happens when a worker hits its subscription limit (SRC-046). */
export type ZaicodeWorkerLimitAction = "keep" | "close" | "closeAndResume";

export interface ZaicodeWorkerPrefs {
  /** Where a newly started worker opens. */
  defaultPlacement: ZaicodeWorkerPlacement;
  panelLayout: ZaicodeWorkersPanelLayout;
  splitDirection: ZaicodeWorkersSplit;
  /** Bottom panel height in CSS pixels. */
  panelHeight: number;
  /** Split pane sizes (fractions) in pane order; reset to even when the pane count changes. */
  splitSizes: number[];
  /** Where minimized workers stack as chips. */
  trayAnchor: ZaicodeWorkersTrayAnchor;
  /** While the panel is hidden, its workers show as chips too. */
  trayShowsHiddenPanel: boolean;
  /** Starting a worker shows the panel. */
  openPanelOnLaunch: boolean;
  /** Windows snap to screen halves / quarters and to each other's edges. */
  snapWindows: boolean;
  snapDistance: number;
  font: ZaicodeWorkerFont;
  customFont: string;
  /** Terminus is a bitmap face: crisp at 12/14/16/18/20/22/24/28/32 px. */
  fontSize: number;
  /** Closing a running worker asks first (it stops the CLI). */
  confirmClose: boolean;
  /** Running workers listed in the sidebar under the engine tiles. */
  sidebarList: boolean;
  /** Edge the panel docks to; left / right make it a vertical column. */
  panelDock: ZaicodeWorkersPanelDock;
  /** Panel width in CSS pixels when docked left or right. */
  panelWidth: number;
  /**
   * A CLI that stops at its first-run "Trust this folder?" question is answered
   * "yes" (Enter) so a scheduled worker never waits for hours on it.
   */
  autoTrust: boolean;
  /** "You've hit your session limit": keep the worker, close it, or close it and start it again after the reset. */
  onLimit: ZaicodeWorkerLimitAction;
}

export const ZAICODE_WORKER_DEFAULT_PREFS: ZaicodeWorkerPrefs = {
  defaultPlacement: "panel",
  panelLayout: "split",
  splitDirection: "row",
  panelHeight: 300,
  splitSizes: [],
  trayAnchor: "bottom-right",
  trayShowsHiddenPanel: true,
  openPanelOnLaunch: true,
  snapWindows: true,
  snapDistance: 14,
  font: "terminus",
  customFont: "",
  fontSize: 14,
  confirmClose: true,
  sidebarList: true,
  panelDock: "bottom",
  panelWidth: 520,
  autoTrust: true,
  onLimit: "keep",
};

export const ZAICODE_TERMINUS_SIZES = [12, 14, 16, 18, 20, 22, 24, 28, 32] as const;
export const ZAICODE_WORKERS_PANEL_MIN = 120;
export const ZAICODE_WORKERS_PANEL_MIN_WIDTH = 240;
const TERMINUS_FAMILY = '"Terminus (TTF) for Windows", "ZAICODE Terminus", Consolas, monospace';

const STORAGE_KEY = "zaicode-workers-prefs-v1";

const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;

export function normalizeZaicodeWorkerPrefs(raw: unknown): ZaicodeWorkerPrefs {
  const d = ZAICODE_WORKER_DEFAULT_PREFS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeWorkerPrefs, unknown>>;
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const int = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  const sizes = Array.isArray(r.splitSizes)
    ? r.splitSizes.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0).slice(0, 16)
    : [];
  return {
    defaultPlacement: oneOf(r.defaultPlacement, ["panel", "window"] as const, d.defaultPlacement),
    panelLayout: oneOf(r.panelLayout, ["split", "tabs"] as const, d.panelLayout),
    splitDirection: oneOf(r.splitDirection, ["row", "column", "grid"] as const, d.splitDirection),
    panelHeight: int(r.panelHeight, ZAICODE_WORKERS_PANEL_MIN, 4000, d.panelHeight),
    splitSizes: sizes,
    trayAnchor: oneOf(
      r.trayAnchor,
      ["bottom-left", "bottom-center", "bottom-right", "left", "right"] as const,
      d.trayAnchor,
    ),
    trayShowsHiddenPanel: flag(r.trayShowsHiddenPanel, d.trayShowsHiddenPanel),
    openPanelOnLaunch: flag(r.openPanelOnLaunch, d.openPanelOnLaunch),
    snapWindows: flag(r.snapWindows, d.snapWindows),
    snapDistance: int(r.snapDistance, 4, 48, d.snapDistance),
    font: oneOf(r.font, ["terminus", "profile", "custom"] as const, d.font),
    customFont: typeof r.customFont === "string" ? r.customFont.slice(0, 200) : d.customFont,
    fontSize: int(r.fontSize, 8, 40, d.fontSize),
    confirmClose: flag(r.confirmClose, d.confirmClose),
    sidebarList: flag(r.sidebarList, d.sidebarList),
    panelDock: oneOf(r.panelDock, ["bottom", "left", "right", "top"] as const, d.panelDock),
    panelWidth: int(r.panelWidth, ZAICODE_WORKERS_PANEL_MIN_WIDTH, 4000, d.panelWidth),
    autoTrust: flag(r.autoTrust, d.autoTrust),
    onLimit: oneOf(r.onLimit, ["keep", "close", "closeAndResume"] as const, d.onLimit),
  };
}

function load(): ZaicodeWorkerPrefs {
  try {
    return normalizeZaicodeWorkerPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeWorkerPrefs(null);
  }
}

interface ZaicodeWorkerPrefsState extends ZaicodeWorkerPrefs {
  update: (patch: Partial<ZaicodeWorkerPrefs>) => void;
  reset: () => void;
}

export const useZaicodeWorkerPrefs = create<ZaicodeWorkerPrefsState>((set, get) => {
  const persist = (next: ZaicodeWorkerPrefs) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // preference only
    }
    set(next);
  };
  return {
    ...load(),
    update: (patch) => persist(normalizeZaicodeWorkerPrefs({ ...get(), ...patch })),
    reset: () => persist(normalizeZaicodeWorkerPrefs(null)),
  };
});

export function readZaicodeWorkerPrefs(): ZaicodeWorkerPrefs {
  return useZaicodeWorkerPrefs.getState();
}

/** The CSS font-family workers use, or undefined = the terminal profile's own font. */
export function zaicodeWorkerFontFamily(prefs: Pick<ZaicodeWorkerPrefs, "font" | "customFont">): string | undefined {
  if (prefs.font === "terminus") return TERMINUS_FAMILY;
  if (prefs.font === "custom" && prefs.customFont.trim()) return `${prefs.customFont.trim()}, monospace`;
  return undefined;
}
