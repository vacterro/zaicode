import { ContextMenuItem } from "@/components/ui/context-menu.js";
import { PanelBottom, PanelLeft, PanelRight, PanelTop } from "lucide-react";
import { create } from "zustand";
import { terminalControl } from "@/terminal/terminalOutputTap.js";
import { zaicodeDockForPoint, type ZaicodeDockEdge } from "./zaicodeWorkerLayout.js";
import { useZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";

/**
 * Docking the WORKERS panel to an edge of the workspace body (SRC-046): the
 * edge names, icons and handle classes, the title-drag that snaps the panel to
 * the nearest edge, and "Redraw" for a garbled worker screen.
 */

/** Edge a WORKERS title drag would dock to right now; the dock frame draws the preview. */
export const useZaicodeDockDrag = create<{ target: ZaicodeDockEdge | null }>(() => ({ target: null }));

export const ZAICODE_DOCK_ICON: Record<ZaicodeDockEdge, typeof PanelBottom> = {
  bottom: PanelBottom,
  right: PanelRight,
  left: PanelLeft,
  top: PanelTop,
};
export const ZAICODE_DOCK_NEXT: Record<ZaicodeDockEdge, ZaicodeDockEdge> = { bottom: "right", right: "left", left: "top", top: "bottom" };
export const ZAICODE_DOCK_LABEL: Record<ZaicodeDockEdge, string> = {
  bottom: "Bottom",
  right: "Right side (vertical)",
  left: "Left side (vertical)",
  top: "Top",
};
export const ZAICODE_DOCK_BORDER: Record<ZaicodeDockEdge, string> = { bottom: "border-t", top: "border-b", left: "border-r", right: "border-l" };
export const ZAICODE_DOCK_HANDLE: Record<ZaicodeDockEdge, string> = {
  bottom: "inset-x-0 -top-1 h-2 cursor-ns-resize",
  top: "inset-x-0 -bottom-1 h-2 cursor-ns-resize",
  right: "inset-y-0 -left-1 w-2 cursor-ew-resize",
  left: "inset-y-0 -right-1 w-2 cursor-ew-resize",
};
/** Pixels the panel grows by per pixel of pointer travel, by dock edge. */
export const ZAICODE_DOCK_GROWTH: Record<ZaicodeDockEdge, { axis: "x" | "y"; sign: 1 | -1 }> = {
  bottom: { axis: "y", sign: -1 },
  top: { axis: "y", sign: 1 },
  right: { axis: "x", sign: -1 },
  left: { axis: "x", sign: 1 },
};
const DRAG_THRESHOLD_PX = 6;

export function setZaicodeWorkersDock(dock: ZaicodeDockEdge): void {
  useZaicodeWorkerPrefs.getState().update({ panelDock: dock });
}

/** Makes worker programs repaint their screen (a garbled Claude Code side panel, SRC-046). */
export function redrawZaicodeWorkers(ids: readonly string[]): void {
  for (const id of ids) terminalControl(id)?.redraw();
}

export function ZaicodeWorkersDockMenuItems() {
  return (
    <>
      {(Object.keys(ZAICODE_DOCK_LABEL) as ZaicodeDockEdge[]).map((edge) => {
        const Icon = ZAICODE_DOCK_ICON[edge];
        return (
          <ContextMenuItem key={edge} onSelect={() => setZaicodeWorkersDock(edge)}>
            <Icon className="size-4" />
            Dock: {ZAICODE_DOCK_LABEL[edge]}
          </ContextMenuItem>
        );
      })}
    </>
  );
}

/** Starts a title drag: the frame previews the nearest edge, release docks there. */
export function startZaicodeDockDrag(event: React.PointerEvent, inside: Element | null, dock: ZaicodeDockEdge): void {
  if (event.button !== 0) return;
  const frame = inside?.closest("[data-zaicode-workers-dock]");
  if (!frame) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;
  const onMove = (moveEvent: PointerEvent) => {
    if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return;
    moved = true;
    const box = frame.getBoundingClientRect();
    const target = zaicodeDockForPoint({ x: box.left, y: box.top, width: box.width, height: box.height }, moveEvent.clientX, moveEvent.clientY);
    if (useZaicodeDockDrag.getState().target !== target) useZaicodeDockDrag.setState({ target });
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    const target = useZaicodeDockDrag.getState().target;
    useZaicodeDockDrag.setState({ target: null });
    if (moved && target && target !== dock) setZaicodeWorkersDock(target);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
