import { useRef, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  ZAICODE_USAGE_PANEL_KEYBOARD_STEP, ZAICODE_USAGE_PANEL_MIN_WIDTH,
  clampZaicodeUsagePanelWidth, snapZaicodeUsagePanelWidth, useZaicodeUsagePanelWidth,
} from "./zaicodeUsagePanelWidth.js";

/** One resize contract for chat and draft inspectors. */
export function ZaicodeResizableInspector({ children, label, side = "right", fixed = false, fullPage = false }: {
  children: ReactNode; label: string; side?: "left" | "right"; fixed?: boolean; fullPage?: boolean;
}) {
  const [width, setWidth] = useZaicodeUsagePanelWidth();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const direction = side === "left" ? 1 : -1;
  const resize = (next: number) => setWidth(clampZaicodeUsagePanelWidth(snapZaicodeUsagePanelWidth(next), window.innerWidth));
  return (
    <aside aria-label={label} className={cn("relative flex min-h-0 min-w-0 shrink-0 flex-col border-border bg-background text-foreground",
      side === "left" ? "border-r" : "border-l", fixed && "fixed top-10 bottom-0 z-40 shadow-lg", fixed && (side === "left" ? "left-0" : "right-0"))}
      style={{ width: fullPage ? "100%" : `min(${width}px, 50vw)` }}>
      {!fullPage ? <div role="separator" aria-orientation="vertical" aria-label="Resize panel" tabIndex={0}
        aria-valuenow={Math.round(width)} aria-valuemin={ZAICODE_USAGE_PANEL_MIN_WIDTH}
        title="Drag to resize · double-click for the default width"
        className={cn("absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none", side === "left" ? "-right-1" : "-left-1")}
        onDoubleClick={() => setWidth(null)}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, width }; }}
        onPointerMove={(event) => { if (drag.current) resize(drag.current.width + (event.clientX - drag.current.x) * direction); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          resize(width + (event.key === "ArrowRight" ? 1 : -1) * direction * ZAICODE_USAGE_PANEL_KEYBOARD_STEP);
        }} /> : null}
      {children}
    </aside>
  );
}
