import { useEffect, useState, type ReactNode } from "react";
import {
  AppWindow,
  Copy,
  Maximize2,
  Minimize2,
  Minus,
  PanelBottom,
  RotateCcw,
  Scan,
  Settings2,
  X,
} from "lucide-react";
import type { IServiceAccessor } from "@zcode/services";
import { formatZaicodeDuration } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { TerminalSession } from "@/terminal/TerminalSession.js";
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
  zaicodeWorkerTitle,
  type ZaicodeWorker,
} from "./zaicodeWorkers.js";
import { useZaicodeWorkerPrefs, zaicodeWorkerFontFamily } from "./zaicodeWorkerPrefs.js";
import { zaicodeVendorColor } from "./ZaicodeLimitViews.js";

/** Shared pieces of the WORKERS panel, worker windows, the tray and the sidebar list. */

export function zaicodeWorkerTone(worker: Pick<ZaicodeWorker, "exitCode">): string {
  if (worker.exitCode === null) return "#4f9a2f";
  return worker.exitCode === 0 ? "#6d6a5c" : "#c8502a";
}

export function zaicodeWorkerStatus(worker: ZaicodeWorker, now: number): string {
  const age = formatZaicodeDuration((worker.endedAt ?? now) - worker.startedAt);
  return worker.exitCode === null ? `running ${age}` : `exited ${worker.exitCode} after ${age}`;
}

export function useZaicodeNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
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
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <span className="inline-block size-2 shrink-0 border border-black/60" style={{ background: zaicodeWorkerTone(worker) }} />
      <span className="shrink-0 font-semibold" style={{ color: worker.vendor ? zaicodeVendorColor(worker.vendor) : undefined }}>
        {worker.short}
      </span>
      <span className="truncate text-foreground">{worker.projectName}</span>
      {showAge ? (
        <span className="shrink-0 text-foreground-subtlest">
          {formatZaicodeDuration((worker.endedAt ?? now) - worker.startedAt)}
          {worker.exitCode !== null ? ` · ${worker.exitCode === 0 ? "done" : `exit ${worker.exitCode}`}` : ""}
        </span>
      ) : null}
    </span>
  );
}

/** Stops (if running) and closes a worker; a running one asks first when the setting says so. */
export function closeZaicodeWorkerWithConfirm(worker: ZaicodeWorker): void {
  const { confirmClose } = useZaicodeWorkerPrefs.getState();
  if (worker.exitCode === null && confirmClose) {
    const ok = window.confirm(
      `Stop ${zaicodeWorkerTitle(worker)}?\n\nThe ${worker.label} process in ${worker.projectPath} ends and its terminal closes.`,
    );
    if (!ok) return;
  }
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
        <ZaicodeWorkerIconButton title="Own window (snappable; drag it to the bottom edge to dock back)" onClick={() => floatZaicodeWorker(worker.id)}>
          <AppWindow className="size-3.5" />
        </ZaicodeWorkerIconButton>
      ) : (
        <ZaicodeWorkerIconButton title="Dock into the WORKERS panel" onClick={() => dockZaicodeWorker(worker.id)}>
          <PanelBottom className="size-3.5" />
        </ZaicodeWorkerIconButton>
      )}
      {onSolo ? (
        <ZaicodeWorkerIconButton title={solo ? "Back to the split" : "Fill the panel with this one"} pressed={solo} onClick={onSolo}>
          <Scan className="size-3.5" />
        </ZaicodeWorkerIconButton>
      ) : null}
      <ZaicodeWorkerIconButton title="Minimize to a chip (keeps running)" onClick={() => minimizeZaicodeWorker(worker.id)}>
        <Minus className="size-3.5" />
      </ZaicodeWorkerIconButton>
      {onMaximize ? (
        <ZaicodeWorkerIconButton title={maximized ? "Restore" : "Maximize"} onClick={onMaximize}>
          {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </ZaicodeWorkerIconButton>
      ) : null}
      <ZaicodeWorkerIconButton
        title={worker.exitCode === null ? "Stop this worker and close it" : "Close"}
        onClick={() => closeZaicodeWorkerWithConfirm(worker)}
      >
        <X className="size-3.5" />
      </ZaicodeWorkerIconButton>
    </span>
  );
}

/** Right-click menu of a worker (tab, pane, window title, chip, sidebar row). */
export function ZaicodeWorkerMenuItems({ worker }: { worker: ZaicodeWorker }) {
  return (
    <>
      <ContextMenuItem onSelect={() => focusZaicodeWorker(worker.id)}>Show {zaicodeWorkerTitle(worker)}</ContextMenuItem>
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
      <ContextMenuItem onSelect={() => runZaicodeWorkerAgain(worker)}>
        <RotateCcw className="size-4" />
        Start the same again (new worker)
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
      <ContextMenuItem onSelect={() => closeZaicodeWorkerWithConfirm(worker)}>
        <X className="size-4" />
        {worker.exitCode === null ? `Stop ${worker.short} and close` : "Close"}
      </ContextMenuItem>
    </>
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
      className="h-full min-h-0 overflow-hidden bg-background px-1 pt-0.5"
      data-zaicode-worker-terminal={worker.short}
      // SRC-038: split panes sit at percentages; the snapper keeps each terminal on whole pixels.
      data-zaicode-pixel-snap
      onPointerDownCapture={() => raiseZaicodeWorker(worker.id)}
    >
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
        onShellLabelChange={() => undefined}
        onExit={(_sessionId, exitCode) => markZaicodeWorkerExited(worker.id, exitCode)}
        onOpenBrowserUrl={(url) => window.open(url, "_blank", "noopener")}
        {...(fontFamily ? { fontFamilyOverride: fontFamily } : {})}
        {...(prefs.font !== "profile" ? { fontSizeOverride: prefs.fontSize } : {})}
      />
    </section>
  );
}
