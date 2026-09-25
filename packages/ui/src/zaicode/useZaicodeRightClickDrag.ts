import { useEffect } from "react";
import { isZaicodeProductMode } from "@zcode/shared";
import { getZaicodeDesktopBridge } from "./zaicodeDesktopBridge.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

interface WindowDragBridge {
  zaicodeWindowDrag?(phase: "start" | "move" | "end"): void;
  moveWindowBy?(delta: { dx: number; dy: number }): Promise<{ success: boolean }>;
}

/** Past this many pixels a right-button press is a window drag, not a context menu. */
export const ZAICODE_RIGHT_DRAG_THRESHOLD = 3;

/**
 * Right mouse button + drag anywhere moves the whole window (LIMISAW /
 * FastPrompter "right-hold move"). The pointer is captured once the drag
 * starts, so the window keeps following even when a fast move leaves it, and
 * the main process places the window at the real cursor position — nothing
 * accumulates, nothing drifts. A right click without movement still opens the
 * normal context menu.
 */
export function useZaicodeRightClickDrag(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !isZaicodeProductMode()) return;
    const bridge = getZaicodeDesktopBridge() as WindowDragBridge | undefined;
    if (!bridge?.zaicodeWindowDrag && !bridge?.moveWindowBy) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let dragging = false;
    let suppressContextMenu = false;
    let resetTimer: number | null = null;
    const root = document.documentElement;

    const send = (phase: "start" | "move" | "end", event?: PointerEvent) => {
      if (bridge.zaicodeWindowDrag) {
        bridge.zaicodeWindowDrag(phase);
        return;
      }
      // Older desktop builds: relative moves.
      if (phase === "move" && event) {
        void bridge.moveWindowBy?.({ dx: event.screenX - lastX, dy: event.screenY - lastY });
      }
    };

    const finish = () => {
      if (pointerId === null) return;
      if (dragging) {
        send("end");
        suppressContextMenu = true;
        if (resetTimer !== null) window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          suppressContextMenu = false;
        }, 250);
        try {
          if (root.hasPointerCapture(pointerId)) root.releasePointerCapture(pointerId);
        } catch {
          // capture already gone
        }
      }
      pointerId = null;
      dragging = false;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 2 || event.pointerType !== "mouse") return;
      pointerId = event.pointerId;
      startX = lastX = event.screenX;
      startY = lastY = event.screenY;
      dragging = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      if ((event.buttons & 2) === 0) {
        finish();
        return;
      }
      if (!dragging) {
        if (Math.hypot(event.screenX - startX, event.screenY - startY) <= ZAICODE_RIGHT_DRAG_THRESHOLD) return;
        dragging = true;
        try {
          root.setPointerCapture(event.pointerId);
        } catch {
          // capture is a nicety: the drag still works inside the window
        }
        send("start", event);
        playZaicodeSound("window.drag");
      }
      send("move", event);
      lastX = event.screenX;
      lastY = event.screenY;
      event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 2 && event.pointerId !== pointerId) return;
      finish();
    };

    const onContextMenu = (event: MouseEvent) => {
      if (dragging || suppressContextMenu) {
        event.preventDefault();
        event.stopPropagation();
        suppressContextMenu = false;
      }
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", finish, true);
    window.addEventListener("blur", finish);
    window.addEventListener("contextmenu", onContextMenu, true);

    return () => {
      finish();
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", finish, true);
      window.removeEventListener("blur", finish);
      window.removeEventListener("contextmenu", onContextMenu, true);
      if (resetTimer !== null) window.clearTimeout(resetTimer);
    };
  }, []);
}
