import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Columns3,
  Grid2x2,
  Maximize2,
  Minimize2,
  Plus,
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
} from "./zaicodeWorkerLayout.js";
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
import { ZAICODE_WORKERS_PANEL_MIN, useZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";
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
 * The bottom WORKERS panel: subscription CLIs docked like a normal terminal
 * under the chat, never floating over it. Shown / hidden from the header,
 * the sidebar or its hotkey; resized from its top edge (double-click:
 * maximize). Split = every docked worker side by side (or stacked, or a
 * grid), dividers drag, "Even" re-shares; Tabs = one at a time. Any worker
 * pops out into its own window and back. Workers keep running while hidden.
 */
export function ZaicodeWorkersPanel({ services }: { services: IServiceAccessor }) {
  const state = useZaicodeWorkers();
  const prefs = useZaicodeWorkerPrefs();
  const now = useZaicodeNow(30_000);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(prefs.panelHeight);
  const [liveSizes, setLiveSizes] = useState<number[] | null>(null);
  const [resizing, setResizing] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const panelWorkers = zaicodePanelWorkers(state);
  const layout = prefs.panelLayout;
  const solo = layout === "split" && state.soloId ? panelWorkers.find((worker) => worker.id === state.soloId) ?? null : null;
  const active = panelWorkers.find((worker) => worker.id === state.activeId) ?? panelWorkers[0] ?? null;

  useEffect(() => setHeight(prefs.panelHeight), [prefs.panelHeight]);

  const sizes = useMemo(
    () => normalizeZaicodeSplitSizes(liveSizes ?? prefs.splitSizes, panelWorkers.length),
    [liveSizes, prefs.splitSizes, panelWorkers.length],
  );
  const rects = useMemo(
    () => layoutZaicodeSplit(panelWorkers.length, prefs.splitDirection, sizes),
    [panelWorkers.length, prefs.splitDirection, sizes],
  );

  const beginHeightDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      // Measured, not the stored value: a maximized panel is taller than its setting.
      const startHeight = (event.currentTarget as HTMLElement).parentElement?.clientHeight ?? height;
      const max = Math.max(ZAICODE_WORKERS_PANEL_MIN, (bodyRef.current?.closest("#content")?.clientHeight ?? window.innerHeight) - 90);
      setResizing(true);
      let latest = startHeight;
      const onMove = (moveEvent: PointerEvent) => {
        // Whole pixels (SRC-038): pointer coordinates are fractional on a scaled display.
        latest = Math.round(Math.min(max, Math.max(ZAICODE_WORKERS_PANEL_MIN, startHeight + (startY - moveEvent.clientY))));
        setHeight(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setResizing(false);
        useZaicodeWorkerPrefs.getState().update({ panelHeight: latest });
        if (state.panelMaximized) setZaicodeWorkersPanelMaximized(false);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [height, state.panelMaximized],
  );

  const beginDividerDrag = (index: number) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const body = bodyRef.current;
    if (!body) return;
    const horizontal = prefs.splitDirection === "row";
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

  return (
    <div
      className="relative flex shrink-0 flex-col border-t border-[var(--zaicode-highlight,var(--color-border-hover))] bg-background"
      style={
        state.panelMaximized
          ? { height: "calc(100% - 72px)" }
          : { height, maxHeight: "calc(100% - 72px)", minHeight: ZAICODE_WORKERS_PANEL_MIN }
      }
      data-zaicode-workers-panel={layout}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the WORKERS panel (double-click: maximize)"
        title="Drag to resize · double-click: maximize / restore"
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize hover:bg-[var(--zaicode-highlight,var(--color-border-hover))]/40"
        onPointerDown={beginHeightDrag}
        onDoubleClick={() => setZaicodeWorkersPanelMaximized(!state.panelMaximized)}
      />
      <div className="flex h-6 shrink-0 items-center gap-1 border-b border-border bg-card px-1.5 text-ui-xs">
        <SquareTerminal className="size-3.5 shrink-0 text-foreground-subtle" />
        <span className="shrink-0 font-semibold tracking-wide text-foreground">WORKERS</span>
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
                title={`Split direction: ${prefs.splitDirection === "row" ? "side by side" : prefs.splitDirection === "column" ? "stacked" : "grid"} (click to change)`}
                onClick={() =>
                  useZaicodeWorkerPrefs.getState().update({
                    splitDirection: prefs.splitDirection === "row" ? "column" : prefs.splitDirection === "column" ? "grid" : "row",
                  })
                }
              >
                {prefs.splitDirection === "grid" ? (
                  <Grid2x2 className="size-3.5" />
                ) : (
                  <Rows3 className={cn("size-3.5", prefs.splitDirection === "row" && "rotate-90")} />
                )}
              </ZaicodeWorkerIconButton>
              <ZaicodeWorkerIconButton title="Even: share the panel equally" onClick={even}>
                <Equal className="size-3.5" />
              </ZaicodeWorkerIconButton>
            </>
          ) : null}
          <ZaicodeWorkerIconButton title="New shell in this project" onClick={newShell}>
            <Plus className="size-3.5" />
          </ZaicodeWorkerIconButton>
          <ZaicodeWorkerIconButton title="Workers settings" onClick={() => void openZaicodeSettings("zaicodeWorkers")}>
            <Settings2 className="size-3.5" />
          </ZaicodeWorkerIconButton>
          <ZaicodeWorkerIconButton
            title={state.panelMaximized ? "Restore the panel height" : "Maximize the panel"}
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
          const visible =
            layout === "tabs" ? worker.id === active?.id : solo ? worker.id === solo.id : true;
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
        {layout === "split" && !solo && prefs.splitDirection !== "grid"
          ? rects.slice(0, -1).map((rect, index) => {
              const horizontal = prefs.splitDirection === "row";
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
