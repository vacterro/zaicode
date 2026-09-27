import { useEffect, useState, useSyncExternalStore } from "react";
import { ZAICODE_PROTRAIL_GLOBAL_OFF, type ZaicodeProtrailGlobalStatus } from "@zcode/shared";
import type { ProtrailConfig } from "./protrailModel.js";

/**
 * The ZAICODE window's side of the desktop-wide ProTrail (SRC-062): it hands
 * the desktop app the config to draw with (or null) and reads back where the
 * overlays stand. Without the desktop app (web build, an older main process)
 * everything here reports "not supported" and ProTrail stays in the window.
 */

interface ProtrailGlobalBridge {
  setZaicodeProtrailGlobal?(config: ProtrailConfig | null): Promise<ZaicodeProtrailGlobalStatus>;
  getZaicodeProtrailGlobalStatus?(): Promise<ZaicodeProtrailGlobalStatus>;
}

function bridge(): ProtrailGlobalBridge | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { zcode?: ProtrailGlobalBridge }).zcode;
}

let failed = false;
let status: ZaicodeProtrailGlobalStatus = ZAICODE_PROTRAIL_GLOBAL_OFF;
const listeners = new Set<() => void>();

function publish(next: ZaicodeProtrailGlobalStatus): void {
  status = next;
  listeners.forEach((listener) => listener());
}

function markFailed(): void {
  failed = true;
  publish({ ...ZAICODE_PROTRAIL_GLOBAL_OFF, state: "unavailable", note: "This ZAICODE build cannot draw outside its window." });
}

/** True when this ZAICODE can draw ProTrail over the whole desktop. */
export function zaicodeProtrailGlobalSupported(): boolean {
  return !failed && !!bridge()?.setZaicodeProtrailGlobal;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Settings -> ProTrail: the overlays' state, refreshed while the page is open (the helper starts asynchronously). */
export function useZaicodeProtrailGlobalStatus(): ZaicodeProtrailGlobalStatus {
  useEffect(() => {
    const api = bridge();
    if (!api?.getZaicodeProtrailGlobalStatus) return;
    const read = () => void api.getZaicodeProtrailGlobalStatus!().then(publish, () => undefined);
    read();
    const timer = setInterval(read, 1500);
    return () => clearInterval(timer);
  }, []);
  return useSyncExternalStore(subscribe, () => status, () => status);
}

/**
 * Keeps the desktop overlays in step with `wanted` and the config. Returns
 * true while the desktop draws (the window's own canvas then stays idle, so
 * nothing is drawn twice).
 */
export function useZaicodeProtrailGlobalSync(config: ProtrailConfig, wanted: boolean): boolean {
  const [broken, setBroken] = useState(failed);
  const supported = !broken && !!bridge()?.setZaicodeProtrailGlobal;
  const active = wanted && supported;

  useEffect(() => {
    const api = bridge();
    if (!supported || !api?.setZaicodeProtrailGlobal) return;
    // Slider drags change the config many times a second; the overlays need the last one.
    const timer = setTimeout(() => {
      api.setZaicodeProtrailGlobal!(active ? config : null).then(publish, () => {
        markFailed();
        setBroken(true);
      });
    }, 40);
    return () => clearTimeout(timer);
  }, [config, active, supported]);

  useEffect(
    () => () => {
      void bridge()
        ?.setZaicodeProtrailGlobal?.(null)
        .then(publish, () => undefined);
    },
    [],
  );

  return active;
}
