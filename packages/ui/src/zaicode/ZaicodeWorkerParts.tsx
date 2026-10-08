import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  AppWindow,
  ChevronDown,
  ChevronUp,
  Copy,
  Maximize2,
  Minimize2,
  Minus,
  PanelBottom,
  RefreshCw,
  RotateCcw,
  Scan,
  Settings2,
  TerminalSquare,
  X,
} from "lucide-react";
import type { IServiceAccessor } from "@zcode/services";
import { formatZaicodeDuration } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { TerminalSession } from "@/terminal/TerminalSession.js";
import { zaicodeWorkerElapsedMs } from "./zaicodeElapsed.js";
import { zaicodeWorkerCloseRequest } from "./zaicodeWorkerClose.js";
import { openZaicodeSettings } from "./zaicodeActions.js";
import {
  dockZaicodeWorker,
  duplicateZaicodeWorker,
  floatZaicodeWorker,
  focusZaicodeWorker,
  markZaicodeWorkerExited,
  minimizeZaicodeWorker,
  raiseZaicodeWorker,
  removeZaicodeWorker,
  readZaicodeWorkers,
  zaicodeWorkerTitle,
  type ZaicodeWorker,
} from "./zaicodeWorkers.js";
import { useZaicodeWorkerPrefs, zaicodeWorkerFontFamily } from "./zaicodeWorkerPrefs.js";
import { zaicodeVendorColor } from "./ZaicodeLimitViews.js";
import { terminalControl, onTerminalControlChange } from "@/terminal/terminalOutputTap.js";
import { extractZaicodeWorker } from "./zaicodeWorkerExtraction.js";
import { ZaicodeWorkerQuotaMeters } from "./ZaicodeWorkerQuotaMeters.js";

/** Shared pieces of the WORKERS panel, worker windows, the tray and the sidebar list. */

export function zaicodeWorkerTone(worker: Pick<ZaicodeWorker, "exitCode">): string {
  if (worker.exitCode === null) return "#4f9a2f";
  return worker.exitCode === 0 ? "#6d6a5c" : "#c8502a";
}

export function zaicodeWorkerStatus(worker: ZaicodeWorker, now: number): string {
  const age = formatZaicodeDuration(zaicodeWorkerElapsedMs(worker, now));
  return worker.exitCode === null ? `running ${age}` : `exited ${worker.exitCode} after ${age}`;
}

/**
 * A clock for the elapsed labels. It only runs while something still counts:
 * a component that stays mounted after the last worker finished must not keep
 * a render interval alive.
 */
export function useZaicodeNow(intervalMs = 30_000, live = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, live]);
  return now;
}

/** Dot + engine short (vendor colour) + project name: one label everywhere. */
export function ZaicodeWorkerLabel({
  worker,
  now,
  showAge = true,
  className,
}: {
  worker: ZaicodeWorker;
  now: number;
  showAge?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 overflow-hidden", className)}>
      <span
        className="inline-block size-2 shrink-0 border border-black/60"
        style={{ background: zaicodeWorkerTone(worker) }}
      />
      <span
        className="shrink-0 font-semibold"
        style={{ color: worker.vendor ? zaicodeVendorColor(worker.vendor) : undefined }}
      >
        {worker.short}
      </span>
      <span className="truncate text-foreground">{worker.projectName}</span>
      {worker.kind === "worker" ? <ZaicodeWorkerQuotaMeters accountId={worker.accountId} now={now} /> : null}
      {showAge ? (
        <span className="min-w-0 shrink truncate text-foreground-subtlest">
          {formatZaicodeDuration(zaicodeWorkerElapsedMs(worker, now))}
          {worker.exitCode !== null
            ? ` · ${worker.exitCode === 0 ? "done" : `exit ${worker.exitCode}`}`
            : ""}
        </span>
      ) : null}
    </span>
  );
}

/** Stops (if running) and closes a worker; a running one asks first when the setting says so. */
export async function closeZaicodeWorkerWithConfirm(worker: ZaicodeWorker): Promise<void> {
  const request = zaicodeWorkerCloseRequest(worker, useZaicodeWorkerPrefs.getState().confirmClose);
  // The app's own confirmation (T-128): the operating system's dialog froze the whole window and beeped.
  if (request && !(await useConfirmDialogStore.getState().requestConfirmation(request))) return;
  removeZaicodeWorker(worker.id);
}

/** Starts the same command again as a new worker (same project, same place). */
export function runZaicodeWorkerAgain(worker: ZaicodeWorker): void {
  const copy = duplicateZaicodeWorker(worker.id);
  if (copy) focusZaicodeWorker(copy.id);
}

const iconButton =
  "flex size-5 shrink-0 items-center justify-center text-foreground-subtle hover:bg-hover hover:text-foreground";

export function ZaicodeWorkerIconButton({
  title,
  onClick,
  children,
  pressed,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      className={cn(iconButton, pressed && "bg-selected text-foreground")}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

/** 面板收起按钮只发出布局命令；不能复用单个 worker 的最小化或关闭命令。 */
export function ZaicodeWorkersPanelCollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <ZaicodeWorkerIconButton
      title={collapsed ? "Expand the panel (same workers)" : "Collapse the panel (workers keep running)"}
      pressed={collapsed}
      onClick={onToggle}
    >
      {collapsed ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
    </ZaicodeWorkerIconButton>
  );
}

/** The buttons every worker header carries: move, minimize, (solo / maximize), close. */
export function ZaicodeWorkerHeaderButtons({
  worker,
  solo,
  onSolo,
  maximized,
  onMaximize,
}: {
  worker: ZaicodeWorker;
  solo?: boolean;
  onSolo?: () => void;
  maximized?: boolean;
  onMaximize?: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center">
      {worker.placement === "panel" ? (
        <ZaicodeWorkerIconButton
          title="Own window (snappable; drag it to the bottom edge to dock back)"
          onClick={() => floatZaicodeWorker(worker.id)}
        >
          <AppWindow className="size-3.5" />
        </ZaicodeWorkerIconButton>
      ) : (
        <ZaicodeWorkerIconButton
          title="Dock into the WORKERS panel"
          onClick={() => dockZaicodeWorker(worker.id)}
        >
          <PanelBottom className="size-3.5" />
        </ZaicodeWorkerIconButton>
      )}
      {onSolo ? (
        <ZaicodeWorkerIconButton
          title={solo ? "Back to the split" : "Fill the panel with this one"}
          pressed={solo}
          onClick={onSolo}
        >
          <Scan className="size-3.5" />
        </ZaicodeWorkerIconButton>
      ) : null}
      <ZaicodeWorkerIconButton
        title="Minimize to a chip (keeps running)"
        onClick={() => minimizeZaicodeWorker(worker.id)}
      >
        <Minus className="size-3.5" />
      </ZaicodeWorkerIconButton>
      {onMaximize ? (
        <ZaicodeWorkerIconButton title={maximized ? "Restore" : "Maximize"} onClick={onMaximize}>
          {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </ZaicodeWorkerIconButton>
      ) : null}
      <ZaicodeWorkerIconButton
        title={worker.exitCode === null ? "Stop this worker and close it" : "Close"}
        onClick={() => void closeZaicodeWorkerWithConfirm(worker)}
      >
        <X className="size-3.5" />
      </ZaicodeWorkerIconButton>
    </span>
  );
}

/** Right-click menu of a worker (tab, pane, window title, chip, sidebar row). */
export function ZaicodeWorkerMenuItems({ worker }: { worker: ZaicodeWorker }) {
  const control = useSyncExternalStore(
    onTerminalControlChange,
    () => terminalControl(worker.id),
    () => null,
  );
  const [extracting, setExtracting] = useState(false);
  const moveToPowerShell = () => {
    setExtracting(true);
    void extractZaicodeWorker(worker, {
      read: () => readZaicodeWorkers().workers,
      remove: removeZaicodeWorker,
    })
      .then(() => toast("Worker moved to PowerShell"))
      .catch((error: unknown) =>
        toast(error instanceof Error ? error.message : "Could not move worker"),
      )
      .finally(() => setExtracting(false));
  };
  return (
    <>
      <ContextMenuItem onSelect={() => focusZaicodeWorker(worker.id)}>
        Show {zaicodeWorkerTitle(worker)}
      </ContextMenuItem>
      {worker.placement === "panel" ? (
        <ContextMenuItem onSelect={() => floatZaicodeWorker(worker.id)}>
          <AppWindow className="size-4" />
          Move to its own window
        </ContextMenuItem>
      ) : (
        <ContextMenuItem onSelect={() => dockZaicodeWorker(worker.id)}>
          <PanelBottom className="size-4" />
          Dock into the WORKERS panel
        </ContextMenuItem>
      )}
      {!worker.minimized ? (
        <ContextMenuItem onSelect={() => minimizeZaicodeWorker(worker.id)}>
          <Minus className="size-4" />
          Minimize to a chip
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        onSelect={() => terminalControl(worker.id)?.redraw()}
        disabled={worker.exitCode !== null}
      >
        <RefreshCw className="size-4" />
        Redraw its screen (a garbled picture)
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => runZaicodeWorkerAgain(worker)}>
        <RotateCcw className="size-4" />
        Start the same again (new worker)
      </ContextMenuItem>
      <ContextMenuItem
        disabled={worker.exitCode !== null || !control?.extractToPowerShell || extracting}
        onSelect={moveToPowerShell}
      >
        <TerminalSquare className="size-4" />
        Move to PowerShell
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!worker.command}
        onSelect={() =>
          void navigator.clipboard
            ?.writeText(worker.command)
            .then(() => toast("Command copied"))
            .catch(() => toast("Could not copy"))
        }
      >
        <Copy className="size-4" />
        Copy its start command
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void openZaicodeSettings("zaicodeWorkers")}>
        <Settings2 className="size-4" />
        Workers settings…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => void closeZaicodeWorkerWithConfirm(worker)}>
        <X className="size-4" />
        {worker.exitCode === null ? `Stop ${worker.short} and close` : "Close"}
      </ContextMenuItem>
    </>
  );
}

// 工时是界面元数据，不写入 CLI 输入；退出后继续读取原 worker 的结束时间。
function ZaicodeWorkerDurationFooter({ worker }: { worker: ZaicodeWorker }) {
  const now = useZaicodeNow(30_000, worker.exitCode === null);
  return (
    <footer
      data-zaicode-worker-duration="end"
      className="shrink-0 truncate border-t border-border px-1 py-0.5 text-ui-xs text-foreground-subtlest"
    >
      {zaicodeWorkerStatus(worker, now)}
    </footer>
  );
}

/** The worker's terminal: its own face (Terminus by default), focus follows the pointer press. */
export function ZaicodeWorkerTerminal({
  worker,
  services,
  visible,
  resizing = false,
}: {
  worker: ZaicodeWorker;
  services: IServiceAccessor;
  visible: boolean;
  resizing?: boolean;
}) {
  const prefs = useZaicodeWorkerPrefs();
  const fontFamily = zaicodeWorkerFontFamily(prefs);
  const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background px-1 pt-0.5"
      data-zaicode-worker-terminal={worker.short}
      // SRC-038: split panes sit at percentages; the snapper keeps each terminal on whole pixels.
      data-zaicode-pixel-snap
      onPointerDownCapture={() => raiseZaicodeWorker(worker.id)}
    >
      <div className="min-h-0 flex-1">
        <TerminalSession
          sessionId={worker.id}
          persistentKey={worker.id}
          // An empty key keeps workers out of the per-workspace recycling.
          workspaceKey=""
          services={services}
          cwd={worker.projectPath}
          isVisible={visible}
          isPanelResizing={resizing}
          isWindowsDesktop={isWindows}
          initialInput={worker.command || undefined}
          externalizable={worker.kind === "worker"}
          onShellLabelChange={() => undefined}
          onExit={(_sessionId, exitCode) => markZaicodeWorkerExited(worker.id, exitCode)}
          onOpenBrowserUrl={(url) => window.open(url, "_blank", "noopener")}
          {...(fontFamily ? { fontFamilyOverride: fontFamily } : {})}
          {...(prefs.font !== "profile" ? { fontSizeOverride: prefs.fontSize } : {})}
        />
      </div>
      <ZaicodeWorkerDurationFooter worker={worker} />
    </section>
  );
}
