import type { ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { isZaicodeProductMode } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ZaicodeWorkersPanel } from "./ZaicodeWorkersPanel.js";
import { ZAICODE_DOCK_LABEL, useZaicodeDockDrag } from "./zaicodePanelDock.js";
import type { ZaicodeDockEdge } from "./zaicodeWorkerLayout.js";
import { useZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";

/** Flex direction that puts the panel on its edge (the body stays the first child). */
const DOCK_FLEX: Record<ZaicodeDockEdge, string> = {
  bottom: "flex-col",
  top: "flex-col-reverse",
  right: "flex-row",
  left: "flex-row-reverse",
};

const PREVIEW: Record<ZaicodeDockEdge, string> = {
  bottom: "inset-x-0 bottom-0 h-1/3",
  top: "inset-x-0 top-0 h-1/3",
  right: "inset-y-0 right-0 w-1/3",
  left: "inset-y-0 left-0 w-1/3",
};

/**
 * The workspace body plus the WORKERS panel on its edge (SRC-046). Upstream
 * (not ZAICODE) it renders the body alone, unchanged.
 */
export function ZaicodeWorkersDockFrame({ services, children }: { services: IServiceAccessor; children: ReactNode }) {
  if (!isZaicodeProductMode()) return <>{children}</>;
  return <DockFrame services={services}>{children}</DockFrame>;
}

function DockFrame({ services, children }: { services: IServiceAccessor; children: ReactNode }) {
  const dock = useZaicodeWorkerPrefs((state) => state.panelDock);
  const target = useZaicodeDockDrag((state) => state.target);
  return (
    <div className={cn("relative flex min-h-0 min-w-0 flex-1", DOCK_FLEX[dock])} data-zaicode-workers-dock={dock}>
      {children}
      <ZaicodeWorkersPanel services={services} />
      {target ? (
        <div
          className={cn(
            "pointer-events-none absolute z-50 flex items-center justify-center border-2 border-[var(--zaicode-highlight,var(--color-border-hover))] bg-[var(--zaicode-highlight,var(--color-border-hover))]/15 text-ui-sm font-semibold text-foreground",
            PREVIEW[target],
          )}
          data-zaicode-dock-preview={target}
        >
          WORKERS → {ZAICODE_DOCK_LABEL[target]}
        </div>
      ) : null}
    </div>
  );
}
