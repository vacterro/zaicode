import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { cn } from "@/components/lib/utils.js";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import {
  clampZaicodeWindowRect,
  magnetZaicodeRect,
  magnetZaicodeResize,
  zaicodeSnapZoneAt,
  zaicodeSnapZoneRect,
  ZAICODE_WORKER_WINDOW_MIN,
  type ZaicodeRect,
  type ZaicodeSnapZone,
} from "./zaicodeWorkerLayout.js";
import {
  dockZaicodeWorker,
  focusZaicodeWorker,
  onZaicodeWorkerRemoved,
  raiseZaicodeWorker,
  setZaicodeWorkerWindow,
  useZaicodeWorkers,
  zaicodeTrayWorkers,
  zaicodeWindowWorkers,
  zaicodeWorkerTitle,
  type ZaicodeWorker,
  type ZaicodeWorkerWindowState,
} from "./zaicodeWorkers.js";
import { useZaicodeWorkerPrefs, type ZaicodeWorkersTrayAnchor } from "./zaicodeWorkerPrefs.js";
import {
  ZaicodeWorkerHeaderButtons,
  ZaicodeWorkerLabel,
  ZaicodeWorkerMenuItems,
  ZaicodeWorkerTerminal,
  useZaicodeNow,
  zaicodeWorkerStatus,
} from "./ZaicodeWorkerParts.js";

/**
 * Worker windows and the minimized-worker tray, above the whole app. A worker
 * window moves by its title bar and snaps: side edges = halves, their corners
 * = quarters, the top edge maximizes, the bottom edge docks it back into the
 * WORKERS panel; its edges stick to the work area and to other worker
 * windows. Minimized workers stack as chips named "engine · project" at the
 * anchor chosen in Settings -> Workers (bottom left / centre / right, or the
 * middle of the left / right edge).
 */

/** The area worker windows live in: below the title bar. */
function workArea(): ZaicodeRect {
  return { x: 0, y: 44, width: window.innerWidth, height: Math.max(ZAICODE_WORKER_WINDOW_MIN.height, window.innerHeight - 44) };
}

type Edges = { left: boolean; right: boolean; top: boolean; bottom: boolean };

const HANDLES: readonly { edges: Edges; className: string; cursor: string }[] = [
  { edges: { left: false, right: true, top: false, bottom: false }, className: "right-0 top-2 bottom-2 w-1", cursor: "ew-resize" },
  { edges: { left: true, right: false, top: false, bottom: false }, className: "left-0 top-2 bottom-2 w-1", cursor: "ew-resize" },
  { edges: { left: false, right: false, top: false, bottom: true }, className: "bottom-0 left-2 right-2 h-1", cursor: "ns-resize" },
  { edges: { left: false, right: false, top: true, bottom: false }, className: "top-0 left-2 right-2 h-1", cursor: "ns-resize" },
  { edges: { left: false, right: true, top: false, bottom: true }, className: "bottom-0 right-0 size-3", cursor: "nwse-resize" },
  { edges: { left: true, right: false, top: false, bottom: true }, className: "bottom-0 left-0 size-3", cursor: "nesw-resize" },
  { edges: { left: false, right: true, top: true, bottom: false }, className: "top-0 right-0 size-3", cursor: "nesw-resize" },
  { edges: { left: true, right: false, top: true, bottom: false }, className: "top-0 left-0 size-3", cursor: "nwse-resize" },
];

function resizeRect(origin: ZaicodeRect, edges: Edges, dx: number, dy: number): ZaicodeRect {
  let { x, y, width, height } = origin;
  if (edges.right) width = Math.max(ZAICODE_WORKER_WINDOW_MIN.width, origin.width + dx);
  if (edges.bottom) height = Math.max(ZAICODE_WORKER_WINDOW_MIN.height, origin.height + dy);
  if (edges.left) {
    width = Math.max(ZAICODE_WORKER_WINDOW_MIN.width, origin.width - dx);
    x = origin.x + origin.width - width;
  }
  if (edges.top) {
    height = Math.max(ZAICODE_WORKER_WINDOW_MIN.height, origin.height - dy);
    y = origin.y + origin.height - height;
  }
  return { x, y, width, height };
}

function WorkerWindow({
  worker,
  services,
  rank,
  others,
  now,
  onSnapPreview,
}: {
  worker: ZaicodeWorker;
  services: IServiceAccessor;
  rank: number;
  others: readonly ZaicodeRect[];
  now: number;
  onSnapPreview: (zone: ZaicodeSnapZone | null) => void;
}) {
  const prefs = useZaicodeWorkerPrefs();
  const state = worker.window ?? { ...clampZaicodeWindowRect({ x: 80, y: 80, width: 640, height: 360 }, workArea()), maximized: false };
  const [live, setLive] = useState<ZaicodeWorkerWindowState | null>(null);
  const [resizing, setResizing] = useState(false);
  const current = live ?? state;
  const bounds = workArea();
  const frame: ZaicodeRect = current.maximized ? bounds : clampZaicodeWindowRect(current, bounds);
  const focused = useZaicodeWorkers().focusedId === worker.id;

  const beginMove = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    raiseZaicodeWorker(worker.id);
    const startX = event.clientX;
    const startY = event.clientY;
    // Dragging a maximized window restores it under the pointer (like Windows).
    const origin: ZaicodeRect = current.maximized
      ? {
          width: state.width,
          height: state.height,
          x: Math.round(event.clientX - state.width * ((event.clientX - bounds.x) / Math.max(1, bounds.width))),
          y: bounds.y,
        }
      : frame;
    let latest: ZaicodeWorkerWindowState = { ...origin, maximized: false };
    let zone: ZaicodeSnapZone | null = null;
    // A press without a real move (a click, the first half of a double-click) changes nothing.
    let moved = false;
    const onMove = (moveEvent: PointerEvent) => {
      if (!moved && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 4) return;
      moved = true;
      const area = workArea();
      let rect: ZaicodeRect = { ...origin, x: origin.x + moveEvent.clientX - startX, y: origin.y + moveEvent.clientY - startY };
      if (prefs.snapWindows) {
        rect = magnetZaicodeRect(rect, others, area, prefs.snapDistance);
        zone = zaicodeSnapZoneAt({ x: moveEvent.clientX, y: moveEvent.clientY }, area);
        onSnapPreview(zone);
      }
      latest = { ...clampZaicodeWindowRect(rect, area), maximized: false };
      setLive(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onSnapPreview(null);
      setLive(null);
      if (!moved) return;
      const area = workArea();
      if (zone === "dock") {
        setZaicodeWorkerWindow(worker.id, { ...origin, maximized: false });
        dockZaicodeWorker(worker.id);
        return;
      }
      if (zone === "maximize") {
        setZaicodeWorkerWindow(worker.id, { ...latest, maximized: true });
        return;
      }
      const snapped = zone ? zaicodeSnapZoneRect(zone, area) : null;
      setZaicodeWorkerWindow(worker.id, snapped ? { ...snapped, maximized: false } : latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const beginResize = (edges: Edges) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    raiseZaicodeWorker(worker.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = frame;
    let latest: ZaicodeWorkerWindowState = { ...origin, maximized: false };
    setResizing(true);
    const onMove = (moveEvent: PointerEvent) => {
      const area = workArea();
      let rect = resizeRect(origin, edges, moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (prefs.snapWindows && (edges.right || edges.bottom) && !edges.left && !edges.top) {
        rect = magnetZaicodeResize(rect, others, area, prefs.snapDistance);
      }
      latest = { ...clampZaicodeWindowRect(rect, area), maximized: false };
      setLive(latest);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setResizing(false);
      setLive(null);
      setZaicodeWorkerWindow(worker.id, latest);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const toggleMaximize = () => setZaicodeWorkerWindow(worker.id, { ...state, maximized: !state.maximized });

  return (
    <div
      className={cn(
        "fixed flex flex-col border bg-background",
        focused ? "border-[var(--zaicode-highlight,var(--color-border-hover))]" : "border-border",
      )}
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, zIndex: 41 + rank }}
      data-zaicode-worker-window={worker.short}
      onPointerDownCapture={() => raiseZaicodeWorker(worker.id)}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "flex h-6 shrink-0 cursor-move select-none items-center gap-1 border-b border-border px-1.5 text-ui-xs",
              focused ? "bg-selected" : "bg-card",
            )}
            title={`${zaicodeWorkerTitle(worker)} · ${worker.projectPath}\n${zaicodeWorkerStatus(worker, now)}\nDrag: move (edges snap, bottom edge docks) · double-click: maximize`}
            onPointerDown={beginMove}
            onDoubleClick={toggleMaximize}
          >
            <ZaicodeWorkerLabel worker={worker} now={now} className="flex-1" />
            <ZaicodeWorkerHeaderButtons worker={worker} maximized={current.maximized} onMaximize={toggleMaximize} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-64">
          <ZaicodeWorkerMenuItems worker={worker} />
        </ContextMenuContent>
      </ContextMenu>
      <div className="relative min-h-0 flex-1">
        <ZaicodeWorkerTerminal worker={worker} services={services} visible resizing={resizing} />
      </div>
      {!current.maximized
        ? HANDLES.map((handle, index) => (
            <div
              key={index}
              className={cn("absolute z-10", handle.className)}
              style={{ cursor: handle.cursor }}
              onPointerDown={beginResize(handle.edges)}
            />
          ))
        : null}
    </div>
  );
}

const TRAY_POSITION: Record<ZaicodeWorkersTrayAnchor, string> = {
  "bottom-left": "bottom-2 left-2 flex-row flex-wrap-reverse",
  "bottom-center": "bottom-2 left-1/2 -translate-x-1/2 flex-row flex-wrap-reverse justify-center",
  "bottom-right": "bottom-2 right-2 flex-row-reverse flex-wrap-reverse",
  left: "left-1 top-1/2 -translate-y-1/2 flex-col",
  right: "right-1 top-1/2 -translate-y-1/2 flex-col items-end",
};

function WorkerTray({ workers, now }: { workers: readonly ZaicodeWorker[]; now: number }) {
  const anchor = useZaicodeWorkerPrefs((state) => state.trayAnchor);
  const panelOpen = useZaicodeWorkers().open;
  if (workers.length === 0) return null;
  const vertical = anchor === "left" || anchor === "right";
  return (
    <div
      className={cn("fixed z-40 flex max-w-[70vw] gap-1", TRAY_POSITION[anchor], vertical && "max-h-[70vh] overflow-y-auto")}
      data-zaicode-workers-tray={anchor}
    >
      {workers.map((worker) => {
        const inHiddenPanel = worker.placement === "panel" && !worker.minimized && !panelOpen;
        return (
          <ContextMenu key={worker.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex max-w-[220px] items-center border bg-card px-1.5 py-0.5 text-ui-xs hover:bg-hover",
                  inHiddenPanel ? "border-border" : "border-[var(--zaicode-highlight,var(--color-border-hover))]",
                )}
                title={`${zaicodeWorkerTitle(worker)} · ${worker.projectPath}\n${zaicodeWorkerStatus(worker, now)}\n${
                  inHiddenPanel ? "In the hidden WORKERS panel" : "Minimized"
                } — click to show · right-click: more`}
                data-zaicode-worker-chip={worker.short}
                onClick={() => focusZaicodeWorker(worker.id)}
              >
                <ZaicodeWorkerLabel worker={worker} now={now} showAge={!vertical} />
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-64">
              <ZaicodeWorkerMenuItems worker={worker} />
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}

/** Mount once (App): worker windows, the snap preview and the tray. */
export function ZaicodeWorkersDock({ services }: { services: IServiceAccessor }) {
  const state = useZaicodeWorkers();
  const showHiddenPanel = useZaicodeWorkerPrefs((prefs) => prefs.trayShowsHiddenPanel);
  const now = useZaicodeNow(30_000);
  const [zone, setZone] = useState<ZaicodeSnapZone | null>(null);
  const [, setViewport] = useState(0);
  const releaseRef = useRef<(id: string) => void>((id) => sidePaneTerminalSessionRegistry.release(id));

  // A closed worker's PTY + xterm go with it, wherever it was shown.
  useEffect(() => onZaicodeWorkerRemoved((id) => releaseRef.current(id)), []);

  const onResize = useCallback(() => setViewport((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [onResize]);

  const windows = zaicodeWindowWorkers(state);
  const order = [...windows].sort((left, right) => left.z - right.z);
  const tray = zaicodeTrayWorkers(state, showHiddenPanel);
  const area = typeof window === "undefined" ? null : workArea();
  const preview = zone && area ? (zone === "dock" ? { x: area.x, y: area.y + area.height - 160, width: area.width, height: 160 } : zaicodeSnapZoneRect(zone, area)) : null;

  return (
    <>
      {order.map((worker, rank) => (
        <WorkerWindow
          key={worker.id}
          worker={worker}
          services={services}
          rank={Math.min(rank, 6)}
          others={windows.filter((other) => other.id !== worker.id && other.window && !other.window.maximized).map((other) => other.window!)}
          now={now}
          onSnapPreview={setZone}
        />
      ))}
      {preview ? (
        <div
          className="pointer-events-none fixed z-[48] border-2 border-[var(--zaicode-highlight,var(--color-border-hover))] bg-[var(--zaicode-highlight,var(--color-border-hover))]/15"
          style={{ left: preview.x, top: preview.y, width: preview.width, height: preview.height }}
          data-zaicode-snap-preview={zone ?? undefined}
        >
          <span className="m-1 inline-block bg-card px-1 text-ui-xs text-foreground">
            {zone === "dock" ? "Dock into the WORKERS panel" : zone === "maximize" ? "Maximize" : `Snap ${zone}`}
          </span>
        </div>
      ) : null}
      <WorkerTray workers={tray} now={now} />
    </>
  );
}
