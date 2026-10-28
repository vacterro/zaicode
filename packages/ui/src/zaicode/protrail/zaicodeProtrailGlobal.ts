import { useEffect, useState, useSyncExternalStore } from "react";
import { ZAICODE_PROTRAIL_GLOBAL_OFF, type ZaicodeProtrailGlobalStatus } from "@zcode/shared";
import { runZaicodeProtrailGlobalConverge, zaicodeProtrailDesktopDraws } from "./protrailGlobalConverge.js";
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
 * Keeps the desktop overlays in step with `wanted` and the config, and does not
 * stop until the desktop confirms it is drawing. Returns true only while the
 * desktop is CONFIRMED to draw (the window's own canvas then stays idle, so
 * nothing is drawn twice). Until then -- a start still settling, an overlay that
 * exists but did not take its settings -- the window draws its own trail, so the
 * operator never sits with ProTrail "on" and nothing on screen (T-129).
 */
export function useZaicodeProtrailGlobalSync(config: ProtrailConfig, wanted: boolean): boolean {
  const [broken, setBroken] = useState(failed);
  const supported = !broken && !!bridge()?.setZaicodeProtrailGlobal;
  const active = wanted && supported;
  const current = useSyncExternalStore(subscribe, () => status, () => status);

  useEffect(() => {
    const api = bridge();
    if (!supported || !api?.setZaicodeProtrailGlobal) return;
    return runZaicodeProtrailGlobalConverge(
      {
        set: (next) => api.setZaicodeProtrailGlobal!(next as ProtrailConfig | null),
        status: () => api.getZaicodeProtrailGlobalStatus!(),
      },
      {
        wanted: active,
        config,
        onStatus: publish,
        onRecovered: () => {
          if (!failed) return;
          failed = false;
          setBroken(false);
        },
        onUnavailable: () => {
          markFailed();
          setBroken(true);
        },
      },
    );
  }, [config, active, supported]);

  useEffect(
    () => () => {
      void bridge()
        ?.setZaicodeProtrailGlobal?.(null)
        .then(publish, () => undefined);
    },
    [],
  );

  return active && zaicodeProtrailDesktopDraws(current);
}
