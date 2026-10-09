import { useCallback, useSyncExternalStore } from "react";
import { ZAICODE_SIDEBAR_SNAP_DISTANCE } from "./zaicodeSidebarWidth.js";

/**
 * REQ-008: the global usage/SAIPEN inspector width. Renderer-local
 * preference (this machine), persisted in localStorage, clamped to a usable
 * range against the live viewport so the composer keeps its room. The panel
 * never exceeds half the viewport; reads outside this machine do not exist.
 */
export const ZAICODE_USAGE_PANEL_DEFAULT_WIDTH = 480;
export const ZAICODE_USAGE_PANEL_MIN_WIDTH = 280;
export const ZAICODE_USAGE_PANEL_STORAGE_KEY = "zaicode-usage-panel-width-px";
export const ZAICODE_USAGE_PANEL_KEYBOARD_STEP = 16;

/** Clamp a persisted width into [min, viewport/2]; garbage means default. */
export function clampZaicodeUsagePanelWidth(width: number, viewportWidth: number): number {
  const max = Math.max(ZAICODE_USAGE_PANEL_MIN_WIDTH, Math.floor(viewportWidth / 2));
  if (!Number.isFinite(width)) width = ZAICODE_USAGE_PANEL_DEFAULT_WIDTH;
  return Math.min(Math.max(Math.round(width), ZAICODE_USAGE_PANEL_MIN_WIDTH), max);
}

/** Parse one stored value; null/blank/garbage means default at this viewport. */
export function parseZaicodeUsagePanelWidth(raw: string | null, viewportWidth: number): number {
  if (raw === null || raw.trim() === "") return clampZaicodeUsagePanelWidth(ZAICODE_USAGE_PANEL_DEFAULT_WIDTH, viewportWidth);
  return clampZaicodeUsagePanelWidth(Number(raw), viewportWidth);
}

/** Snap near the default while dragging; a saved custom width is never rewritten on read. */
export function snapZaicodeUsagePanelWidth(width: number): number {
  return Math.abs(width - ZAICODE_USAGE_PANEL_DEFAULT_WIDTH) <= ZAICODE_SIDEBAR_SNAP_DISTANCE
    ? ZAICODE_USAGE_PANEL_DEFAULT_WIDTH
    : Math.round(width);
}

function readStored(viewportWidth: number): number {
  try {
    return parseZaicodeUsagePanelWidth(window.localStorage.getItem(ZAICODE_USAGE_PANEL_STORAGE_KEY), viewportWidth);
  } catch {
    return ZAICODE_USAGE_PANEL_DEFAULT_WIDTH;
  }
}

let memoryWidth: number | null | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const readWidth = () => {
  if (typeof window === "undefined") return ZAICODE_USAGE_PANEL_DEFAULT_WIDTH;
  const saved = memoryWidth === undefined ? readStored(window.innerWidth) : memoryWidth ?? ZAICODE_USAGE_PANEL_DEFAULT_WIDTH;
  return clampZaicodeUsagePanelWidth(saved, window.innerWidth);
};
function subscribeWidth(listener: () => void) {
  listeners.add(listener);
  const changed = () => { memoryWidth = undefined; notify(); };
  window.addEventListener("storage", changed);
  window.addEventListener("resize", listener);
  return () => { listeners.delete(listener); window.removeEventListener("storage", changed); window.removeEventListener("resize", listener); };
}

export function useZaicodeUsagePanelWidth(): [number, (width: number | null) => void] {
  const width = useSyncExternalStore(subscribeWidth, readWidth, () => ZAICODE_USAGE_PANEL_DEFAULT_WIDTH);
  const store = useCallback((next: number | null) => {
    try {
      if (next === null) window.localStorage.removeItem(ZAICODE_USAGE_PANEL_STORAGE_KEY);
      else window.localStorage.setItem(ZAICODE_USAGE_PANEL_STORAGE_KEY, String(Math.round(next)));
    } catch {
      // Preference lasts for this window only when storage is unavailable.
    }
    memoryWidth = next;
    notify();
  }, []);
  return [width, store];
}
