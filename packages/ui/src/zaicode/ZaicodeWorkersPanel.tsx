import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Columns3,
  Grid2x2,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Rows3,
  Settings2,
  SquareTerminal,
  Equal,
} from "lucide-react";
import type { IServiceAccessor } from "@zcode/services";
import { cn } from "@/components/lib/utils.js";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { openZaicodeSettings } from "./zaicodeActions.js";
import { readZaicodeCurrentWorkspace } from "./zaicodeEngines.js";
import {
  evenZaicodeSplitSizes,
  layoutZaicodeSplit,
  normalizeZaicodeSplitSizes,
  resizeZaicodeSplit,
  zaicodeEffectiveSplit,
} from "./zaicodeWorkerLayout.js";
import {
  ZAICODE_DOCK_BORDER,
  ZAICODE_DOCK_GROWTH,
  ZAICODE_DOCK_HANDLE,
  ZAICODE_DOCK_ICON,
  ZAICODE_DOCK_LABEL,
  ZAICODE_DOCK_NEXT,
  ZaicodeWorkersDockMenuItems,
  redrawZaicodeWorkers,
  setZaicodeWorkersDock,
  startZaicodeDockDrag,
} from "./zaicodePanelDock.js";
import {
  hideZaicodeWorkersPanel,
  moveZaicodeWorker,
  openZaicodeShellWorker,
  raiseZaicodeWorker,
  setZaicodeWorkersPanelMaximized,
  soloZaicodeWorker,
  useZaicodeWorkers,
  zaicodePanelWorkers,
  zaicodeWorkerTitle,
} from "./zaicodeWorkers.js";
import { ZAICODE_WORKERS_PANEL_MIN, ZAICODE_WORKERS_PANEL_MIN_WIDTH, useZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";
import {
  ZaicodeWorkerHeaderButtons,
  ZaicodeWorkerIconButton,
  ZaicodeWorkerLabel,
  ZaicodeWorkerMenuItems,
  ZaicodeWorkerTerminal,
  useZaicodeNow,
  zaicodeWorkerStatus,
} from "./ZaicodeWorkerParts.js";

/**
 * The WORKERS panel: subscription CLIs docked like a normal terminal next to
 * the chat, never floating over it. It docks to the bottom (default), the
 * right, the left or the top of the workspace body (SRC-046): the dock button
 * cycles, a right-click on WORKERS picks, and dragging the WORKERS title snaps
 * it to the edge nearest the pointer. Resized from its inner edge (double-
 * click: maximize). Split = every docked worker side by side (a side column
 * stacks them), dividers drag, "Even" re-shares; Tabs = one at a time. Any
 * worker pops out into its own window and back. Workers keep running hidden.
 */

export function ZaicodeWorkersPanel({ services }: { services: IServiceAccessor }) {
  const state = useZaicodeWorkers();
  const prefs = useZaicodeWorkerPrefs();
  const now = useZaicodeNow(30_000);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dock = prefs.panelDock;
  const vertical = dock === "left" || dock === "right";
  const storedSize = vertical ? prefs.panelWidth : prefs.panelHeight;
  const minSize = vertical ? ZAICODE_WORKERS_PANEL_MIN_WIDTH : ZAICODE_WORKERS_PANEL_MIN;
  const [size, setSize] = useState(storedSize);
  const [liveSizes, setLiveSizes] = useState<number[] | null>(null);
  const [resizing, setResizing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const panelWorkers = zaicodePanelWorkers(state);
  const layout = prefs.panelLayout;
  const direction = zaicodeEffectiveSplit(prefs.splitDirection, dock);
  const solo = layout === "split" && state.soloId ? panelWorkers.find((worker) => worker.id === state.soloId) ?? null : null;
  const active = panelWorkers.find((worker) => worker.id === state.activeId) ?? panelWorkers[0] ?? null;

  useEffect(() => setSize(storedSize), [storedSize]);

  const sizes = useMemo(
    () => normalizeZaicodeSplitSizes(liveSizes ?? prefs.splitSizes, panelWorkers.length),
    [liveSizes, prefs.splitSizes, panelWorkers.length],
  );
  const rects = useMemo(() => layoutZaicodeSplit(panelWorkers.length, direction, sizes), [panelWorkers.length, direction, sizes]);

  const beginSizeDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const growth = ZAICODE_DOCK_GROWTH[dock];
      const start = growth.axis === "x" ? event.clientX : event.clientY;
      const panel = (event.currentTarget as HTMLElement).parentElement;
      // Measured, not the stored value: a maximized panel is bigger than its setting.
      const startSize = (vertical ? panel?.clientWidth : panel?.clientHeight) ?? size;
      const frame = bodyRef.current?.closest("#content");
      const max = Math.max(minSize, (vertical ? frame?.clientWidth ?? window.innerWidth : frame?.clientHeight ?? window.innerHeight) - 90);
      setResizing(true);
      let latest = startSize;
      const onMove = (moveEvent: PointerEvent) => {
        const travel = (growth.axis === "x" ? moveEvent.clientX : moveEvent.clientY) - start;
        // Whole pixels (SRC-038): pointer coordinates are fractional on a scaled display.
        latest = Math.round(Math.min(max, Math.max(minSize, startSize + growth.sign * travel)));
        setSize(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setResizing(false);
        useZaicodeWorkerPrefs.getState().update(vertical ? { panelWidth: latest } : { panelHeight: latest });
        if (state.panelMaximized) setZaicodeWorkersPanelMaximized(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [dock, minSize, size, state.panelMaximized, vertical],
  );

  const beginDockDrag = (event: React.PointerEvent) => startZaicodeDockDrag(event, bodyRef.current, dock);

  const beginDividerDrag = (index: number) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const horizontal = direction === "row";
    const extent = horizontal ? body.clientWidth : body.clientHeight;
    const start = horizontal ? event.clientX : event.clientY;
    const origin = sizes;
    let latest = origin;
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      const delta = ((horizontal ? moveEvent.clientX : moveEvent.clientY) - start) / Math.max(1, extent);
      latest = resizeZaicodeSplit(origin, index, delta);
      setLiveSizes(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
      setLiveSizes(null);
      useZaicodeWorkerPrefs.getState().update({ splitSizes: latest });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const even = () => {
    setLiveSizes(null);
    useZaicodeWorkerPrefs.getState().update({ splitSizes: evenZaicodeSplitSizes(panelWorkers.length) });
  };

  if (!state.open) return null;

  const newShell = () => {
    const cwd = readZaicodeCurrentWorkspace()?.path;
    if (cwd) openZaicodeShellWorker(cwd, "panel");
  };
  const running = state.workers.filter((worker) => worker.exitCode === null).length;
  const elsewhere = state.workers.length - panelWorkers.length;
  const DockIcon = ZAICODE_DOCK_ICON[dock];
  const visibleIds = panelWorkers
    .filter((worker) => (layout === "tabs" ? worker.id === active?.id : solo ? worker.id === solo.id : true))
    .map((worker) => worker.id);
  const frameStyle = vertical
    ? state.panelMaximized
      ? { width: "calc(100% - 160px)" }
      : { width: size, maxWidth: "calc(100% - 160px)", minWidth: minSize }
    : state.panelMaximized
      ? { height: "calc(100% - 72px)" }
      : { height: size, maxHeight: "calc(100% - 72px)", minHeight: minSize };

  return (
    <div
      className={cn(
        "relative flex shrink-0 flex-col border-[var(--zaicode-highlight,var(--color-border-hover))] bg-background",
        ZAICODE_DOCK_BORDER[dock],
      )}
      style={frameStyle}
      data-zaicode-workers-panel={layout}
      data-zaicode-workers-panel-dock={dock}
    >
      <div
        role="separator"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-label="Resize the WORKERS panel (double-click: maximize)"
        title="Drag to resize · double-click: maximize / restore"
        className={cn("absolute z-10 hover:bg-[var(--zaicode-highlight,var(--color-border-hover))]/40", ZAICODE_DOCK_HANDLE[dock])}
        onPointerDown={beginSizeDrag}
        onDoubleClick={() => setZaicodeWorkersPanelMaximized(!state.panelMaximized)}
      />
      <div className="flex h-6 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5 text-ui-xs">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <span
              className="flex shrink-0 cursor-move items-center gap-1"
              title="Drag to dock the panel to another edge · right-click: dock"
              onPointerDown={beginDockDrag}
            >
              <SquareTerminal className="size-3.5 shrink-0 text-foreground-subtle" />
              <span className="font-semibold tracking-wide text-foreground">WORKERS</span>
            </span>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56">
            <ZaicodeWorkersDockMenuItems />
          </ContextMenuContent>
        </ContextMenu>
        <span className="shrink-0 text-foreground-subtlest" title={elsewhere > 0 ? `${elsewhere} in own windows or minimized` : undefined}>
          {running} running{elsewhere > 0 ? ` · ${elsewhere} elsewhere` : ""}
        </span>
        <div className="flex min-w-0 flex-1 items-stretch gap-px overflow-x-auto !scrollbar-hide" role="tablist">
          {panelWorkers.map((worker, index) => {
            const selected = layout === "tabs" ? worker.id === active?.id : worker.id === state.focusedId;
            return (
              <ContextMenu key={worker.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    draggable
                    title={`${zaicodeWorkerTitle(worker)}\n${worker.projectPath}\n${zaicodeWorkerStatus(worker, now)}\nDrag to reorder · right-click: more`}
                    className={cn(
                      "flex max-w-[200px] shrink-0 items-center border px-1.5",
                      selected
                        ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-background"
                        : "border-transparent hover:border-border",
                      dragId && dragId !== worker.id && "border-dashed",
                    )}
                    onClick={() => (layout === "split" && state.soloId ? soloZaicodeWorker(worker.id) : raiseZaicodeWorker(worker.id))}
                    onDragStart={(event) => {
                      setDragId(worker.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(event) => {
                      if (dragId) event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (!dragId || dragId === worker.id) return;
                      const to = state.workers.findIndex((item) => item.id === panelWorkers[index]!.id);
                      moveZaicodeWorker(dragId, to);
                      setDragId(null);
                      setLiveSizes(null);
                    }}
                  >
                    <ZaicodeWorkerLabel worker={worker} now={now} />
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-64">
                  <ZaicodeWorkerMenuItems worker={worker} />
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
        <span className="flex shrink-0 items-center">
          <ZaicodeWorkerIconButton
            title="Split: all docked workers side by side"
            pressed={layout === "split"}
            onClick={() => useZaicodeWorkerPrefs.getState().update({ panelLayout: "split" })}
          >
            <Columns3 className="size-3.5" />
          </ZaicodeWorkerIconButton>
          <ZaicodeWorkerIconButton
            title="Tabs: one worker at a time"
            pressed={layout === "tabs"}
            onClick={() => useZaicodeWorkerPrefs.getState().update({ panelLayout: "tabs" })}
          >
            <Rows3 className="size-3.5 rotate-90" />
          </ZaicodeWorkerIconButton>
          {layout === "split" ? (
            <>
              <ZaicodeWorkerIconButton
                title={`Split direction: ${direction === "row" ? "side by side" : direction === "column" ? "stacked" : "grid"} (click to change)`}
                onClick={() =>
                  useZaicodeWorkerPrefs.getState().update({
                    splitDirection: direction === "row" ? "column" : direction === "column" ? "grid" : "row",
                  })
                }
              >
                {direction === "grid" ? (
                  <Grid2x2 className="size-3.5" />
                ) : (
                  <Rows3 className={cn("size-3.5", direction === "row" && "rotate-90")} />
                )}
              </ZaicodeWorkerIconButton>
              <ZaicodeWorkerIconButton title="Even: share the panel equally" onClick={even}>
                <Equal className="size-3.5" />
              </ZaicodeWorkerIconButton>
            </>
          ) : null}
          <ZaicodeWorkerIconButton
            title={`Docked: ${ZAICODE_DOCK_LABEL[dock]} · click: ${ZAICODE_DOCK_LABEL[ZAICODE_DOCK_NEXT[dock]]} · or drag the WORKERS title to an edge`}
            onClick={() => setZaicodeWorkersDock(ZAICODE_DOCK_NEXT[dock])}
          >
            <DockIcon className="size-3.5" />
          </ZaicodeWorkerIconButton>
          <ZaicodeWorkerIconButton title="Redraw: repaint the workers' screens (fixes a garbled picture)" onClick={() => redrawZaicodeWorkers(visibleIds)}>
            <RefreshCw className="size-3.5" />
          </ZaicodeWorkerIconButton>
          <ZaicodeWorkerIconButton title="New shell in this project" onClick={newShell}>
            <Plus className="size-3.5" />
          </ZaicodeWorkerIconButton>
          <ZaicodeWorkerIconButton title="Workers settings" onClick={() => void openZaicodeSettings("zaicodeWorkers")}>
            <Settings2 className="size-3.5" />
          </ZaicodeWorkerIconButton>
          <ZaicodeWorkerIconButton
            title={state.panelMaximized ? "Restore the panel size" : "Maximize the panel"}
            onClick={() => setZaicodeWorkersPanelMaximized(!state.panelMaximized)}
          >
            {state.panelMaximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </ZaicodeWorkerIconButton>
          <ZaicodeWorkerIconButton title="Hide the panel (workers keep running)" onClick={hideZaicodeWorkersPanel}>
            <ChevronDown className="size-3.5" />
          </ZaicodeWorkerIconButton>
        </span>
      </div>
      <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-hidden" data-zaicode-workers-body>
        {panelWorkers.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-ui-xs text-foreground-subtle">
            <span>No worker is docked here.</span>
            <span className="text-foreground-subtlest">
              Double-click an engine tile in the sidebar, use a project&apos;s ⋯ menu, or
            </span>
            <button type="button" className="border border-border px-2 hover:bg-hover" onClick={newShell}>
              open a shell in this project
            </button>
          </div>
        ) : null}
        {panelWorkers.map((worker, index) => {
          const rect = rects[index]!;
          const visible = visibleIds.includes(worker.id);
          const frame = layout === "tabs" || solo ? { left: "0%", top: "0%", width: "100%", height: "100%" } : {
            left: `${rect.x}%`,
            top: `${rect.y}%`,
            width: `${rect.width}%`,
            height: `${rect.height}%`,
          };
          const focused = worker.id === state.focusedId;
          return (
            <div
              key={worker.id}
              className={cn(
                "absolute flex-col overflow-hidden",
                visible ? "flex" : "hidden",
                layout === "split" && !solo && "border border-border",
                layout === "split" && !solo && focused && "border-[var(--zaicode-highlight,var(--color-border-hover))]",
              )}
              style={frame}
            >
              {layout === "split" ? (
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <div
                      className="flex h-5 shrink-0 items-center gap-1 border-b border-border bg-card/70 px-1 text-ui-xs"
                      onDoubleClick={() => soloZaicodeWorker(solo ? null : worker.id)}
                      title="Double-click: fill the panel / back to the split"
                    >
                      <ZaicodeWorkerLabel worker={worker} now={now} className="flex-1" />
                      <ZaicodeWorkerHeaderButtons
                        worker={worker}
                        solo={Boolean(solo)}
                        onSolo={() => soloZaicodeWorker(solo ? null : worker.id)}
                      />
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-64">
                    <ZaicodeWorkerMenuItems worker={worker} />
                  </ContextMenuContent>
                </ContextMenu>
              ) : null}
              <div className="min-h-0 flex-1">
                <ZaicodeWorkerTerminal worker={worker} services={services} visible={visible} resizing={resizing} />
              </div>
            </div>
          );
        })}
        {layout === "split" && !solo && direction !== "grid"
          ? rects.slice(0, -1).map((rect, index) => {
              const horizontal = direction === "row";
              const at = horizontal ? rect.x + rect.width : rect.y + rect.height;
              return (
                <div
                  key={`divider-${index}`}
                  role="separator"
                  aria-orientation={horizontal ? "vertical" : "horizontal"}
                  title="Drag to resize · double-click: even"
                  className={cn(
                    "absolute z-10 hover:bg-[var(--zaicode-highlight,var(--color-border-hover))]/50",
                    horizontal ? "inset-y-0 w-1.5 -translate-x-1/2 cursor-ew-resize" : "inset-x-0 h-1.5 -translate-y-1/2 cursor-ns-resize",
                  )}
                  style={horizontal ? { left: `${at}%` } : { top: `${at}%` }}
                  onPointerDown={beginDividerDrag(index)}
                  onDoubleClick={even}
                />
              );
            })
          : null}
      </div>
    </div>
  );
}
