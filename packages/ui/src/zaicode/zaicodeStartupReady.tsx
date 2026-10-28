import { useEffect } from "react";
import { ZAICODE_APP_INTERACTIVE_EVENT } from "@zcode/shared";

/**
 * SRC-060: tells the boot shell (desktop renderer index.html) that the
 * interface is usable, so the start-up picture can give way to the ready app
 * instead of to the grey start-up screen. Once per window; the listener is
 * registered before React mounts.
 */
let announced = false;

export function announceZaicodeAppInteractive(): void {
  if (announced || typeof window === "undefined") return;
  announced = true;
  // Two frames: the first real frame paints before the window is revealed.
  const dispatch = () => window.dispatchEvent(new Event(ZAICODE_APP_INTERACTIVE_EVENT));
  if (typeof window.requestAnimationFrame !== "function") {
    dispatch();
    return;
  }
  window.requestAnimationFrame(() => window.requestAnimationFrame(dispatch));
}

/** Whether a start-up screen must be shown to the operator right away. */
export function zaicodeStartupNeedsOperator(
  state: { phase?: string; migration?: { kind: string } } | null | undefined,
): boolean {
  return state?.phase === "failed" || (state?.migration !== undefined && state.migration.kind !== "none");
}

/** Mount to announce: a start-up error or migration screen the operator must see. */
export function ZaicodeAnnounceInteractive() {
  useEffect(() => announceZaicodeAppInteractive(), []);
  return null;
}
