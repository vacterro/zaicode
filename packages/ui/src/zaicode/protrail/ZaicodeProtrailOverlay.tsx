import { useEffect, useRef } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import { useZaicodeUiPrefs } from "../zaicodeUiPrefs.js";
import { ProtrailRuntime } from "./protrailRuntime.js";
import { useZaicodeProtrailForced } from "./zaicodeProtrailForce.js";
import { useZaicodeProtrailGlobalSync } from "./zaicodeProtrailGlobal.js";
import { useZaicodeProtrail } from "./zaicodeProtrailStore.js";

/**
 * ProTrail in ZAICODE (SRC-062). "Everywhere" (the default) hands the config
 * to the desktop app, which draws over every monitor and every app; this
 * window's canvas then stays idle. "Only inside ZAICODE" (or a build without
 * the desktop app) draws here: one click-through canvas (pointer-events:
 * none) that never receives, delays or swallows a click, fed by passive
 * capture listeners (coalesced pointer events for a smooth trail).
 *
 * A game-local force (SAIASUI, T-105) overrides the saved config while a game
 * runs: the trail is drawn in-window, on, regardless of the user's saved
 * preference, and reverts to that saved preference the instant the game exits.
 * The forced config never touches the store, so nothing is mutated or leaked.
 */

export function ZaicodeProtrailOverlay() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<ProtrailRuntime | null>(null);
  const saved = useZaicodeProtrail((state) => state.config);
  const forced = useZaicodeProtrailForced();
  const config = forced ?? saved;
  const noMotion = useZaicodeUiPrefs((state) => state.noMotion);
  const product = isZaicodeProductMode();
  const running = product && config.enabled && !(config.followCalm && noMotion);
  // A forced game trail always draws in this window; it never goes desktop-wide.
  const global = useZaicodeProtrailGlobalSync(config, running && config.everywhere && !forced);
  const local = running && !global;
  const localRef = useRef(local);
  localRef.current = local;
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    runtimeRef.current?.setConfig(local ? config : null);
  }, [config, local]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!product || !canvas) return;
    const runtime = new ProtrailRuntime(
      canvas,
      () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
      () => document.visibilityState === "visible",
    );
    runtimeRef.current = runtime;
    runtime.setConfig(localRef.current ? configRef.current : null);

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !runtime.active()) return;
      const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      for (const item of events.length > 0 ? events : [event]) {
        runtime.move(item.clientX, item.clientY, item.timeStamp || performance.now());
      }
      runtime.reconcile(event.buttons, event.clientX, event.clientY, performance.now());
    };
    const onDown = (event: PointerEvent) => runtime.down(event.button, event.clientX, event.clientY, performance.now());
    const onUp = (event: PointerEvent) => runtime.up(event.button, event.clientX, event.clientY, performance.now());
    const onLeave = () => runtime.leave();
    const onResize = () => runtime.kick();
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("pointerdown", onDown, opts);
    window.addEventListener("pointerup", onUp, opts);
    window.addEventListener("pointercancel", onLeave, opts);
    window.addEventListener("blur", onLeave);
    window.addEventListener("resize", onResize);
    return () => {
      runtimeRef.current = null;
      runtime.dispose();
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("pointerdown", onDown, opts);
      window.removeEventListener("pointerup", onUp, opts);
      window.removeEventListener("pointercancel", onLeave, opts);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("resize", onResize);
    };
  }, [product]);

  if (!product) return null;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-zaicode-protrail
      className="pointer-events-none fixed inset-0 h-screen w-screen"
      style={{ zIndex: 2147482000 }}
    />
  );
}
