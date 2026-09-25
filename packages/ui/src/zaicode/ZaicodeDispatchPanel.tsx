import { Send } from "lucide-react";
import { create } from "zustand";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { toast } from "@/components/ui/toast.js";
import { ZaicodeTopButton } from "./ZaicodeHeaderToolbar.js";
import { ZaicodePrefSegment } from "./ZaicodePrefControls.js";
import { zaicodeVendorColor } from "./ZaicodeLimitViews.js";
import {
  pickZaicodeDispatchProject,
  useZaicodeDispatch,
  zaicodeDispatchTitle,
  type ZaicodeDispatchLauncher,
  type ZaicodeDispatchProject,
  type ZaicodeDispatchWhere,
} from "./zaicodeDispatch.js";
import {
  getZaicodeEnginesBridge,
  readZaicodeEngine,
  useZaicodeEngines,
  launchableZaicodeAccounts,
  zaicodeRemainingColor,
} from "./zaicodeEngines.js";
import type { ZaicodeEngineAccount } from "@zcode/shared";
import { useZaicodeHotkeySettings, zaicodeHotkeyLabel } from "./zaicodeHotkeys.js";
import { useZaicodeSessionNav } from "./zaicodeSessionNav.js";
import { launchZaicodeWorker, openZaicodeShellWorker } from "./zaicodeWorkers.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { openZaicodeSettings } from "./zaicodeActions.js";

/** Open state, so the hotkey and the header button drive the same panel. */
export const useZaicodeDispatchPanel = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function toggleZaicodeDispatchPanel(): void {
  const panel = useZaicodeDispatchPanel.getState();
  panel.setOpen(!panel.open);
}

async function runLauncher(
  launcher: ZaicodeDispatchLauncher,
  project: ZaicodeDispatchProject,
  where: ZaicodeDispatchWhere,
): Promise<{ ok: boolean; message: string }> {
  if (where === "external") {
    const bridge = getZaicodeEnginesBridge();
    if (!bridge?.launchZaicodeExternalWorker) return { ok: false, message: "Own windows need the desktop app." };
    const result = await bridge.launchZaicodeExternalWorker({
      cwd: project.path,
      command: launcher.command,
      title: zaicodeDispatchTitle(launcher.short, project.name),
    });
    if (result.ok) playZaicodeSound("worker.launch");
    return result;
  }
  openZaicodeShellWorker(project.path, where, launcher);
  return { ok: true, message: `${launcher.label} opened in ${project.name}` };
}

async function runEngine(
  account: ZaicodeEngineAccount,
  project: ZaicodeDispatchProject,
  where: ZaicodeDispatchWhere,
): Promise<{ ok: boolean; message: string }> {
  return launchZaicodeWorker({
    account,
    projectPath: project.path,
    where: where === "panel" ? "dock" : where,
  });
}

/**
 * The Dispatch panel: pick a project, pick where it opens, click a tile.
 * Every click is one more independent instance; nothing here is bound to the
 * session on screen.
 */
export function ZaicodeDispatchPanel({ onDone }: { onDone?: () => void }) {
  const prefs = useZaicodeDispatch();
  const projects = useZaicodeSessionNav((state) => state.projectList);
  const activePath = useZaicodeSessionNav((state) => state.activeWorkspacePath);
  const engines = useZaicodeEngines();
  const accounts = launchableZaicodeAccounts(engines).filter((account) => account.status !== "cli-missing");
  const project = pickZaicodeDispatchProject(projects, prefs.lastProject, activePath);
  const now = Date.now();

  const report = (result: { ok: boolean; message: string }) => {
    toast(result.message);
    if (result.ok) onDone?.();
  };

  return (
    <div className="flex flex-col gap-2 text-ui-xs" data-zaicode-dispatch>
      <label className="flex flex-col gap-0.5">
        <span className="text-foreground-subtle">Project</span>
        <select
          className="h-6 border border-border bg-card px-1 text-foreground"
          value={project?.path ?? ""}
          onChange={(event) => prefs.update({ lastProject: event.target.value || null })}
          data-zaicode-dispatch-project
        >
          {projects.length === 0 ? <option value="">No projects in the sidebar</option> : null}
          {projects.map((item) => (
            <option key={`${item.path}|${item.identity ?? ""}`} value={item.path} title={item.path}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <ZaicodePrefSegment<ZaicodeDispatchWhere>
        label="Opens in"
        value={prefs.where}
        onChange={(where) => prefs.update({ where })}
        options={[
          { value: "external", label: "Own window", hint: "A separate PowerShell console, like AUDAPACK; it keeps running when ZAICODE closes" },
          { value: "panel", label: "WORKERS panel", hint: "A worker terminal docked under the chat" },
          { value: "window", label: "In-app window", hint: "A floating worker window inside ZAICODE" },
        ]}
      />
      {accounts.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground-subtle">Engines (subscription CLIs)</span>
          <div className="grid grid-cols-4 gap-0.5">
            {accounts.map((account) => {
              const reading = readZaicodeEngine(account, engines.limits[account.id], now);
              const fill = reading.remaining === null ? 0 : Math.max(reading.remaining > 0 ? 6 : 0, reading.remaining);
              return (
                <button
                  key={account.id}
                  type="button"
                  disabled={!project}
                  className="relative min-h-6 overflow-hidden border border-border px-1 pb-[5px] pt-0.5 font-semibold hover:bg-hover disabled:opacity-40"
                  title={`${account.label}${reading.remaining === null ? "" : ` · ${Math.round(reading.remaining)}% left`}${project ? ` → ${project.name}` : ""}`}
                  onClick={() => project && void runEngine(account, project, prefs.where).then(report)}
                  data-zaicode-dispatch-engine={account.short}
                >
                  <span style={{ color: zaicodeVendorColor(account.vendor) }}>{account.short}</span>
                  <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40">
                    <span
                      className="absolute inset-y-0 left-0"
                      style={{ width: `${fill}%`, background: zaicodeRemainingColor(reading.remaining) }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-0.5">
        <span className="text-foreground-subtle">Terminals and your launchers</span>
        <div className="grid grid-cols-4 gap-0.5">
          {prefs.launchers.map((launcher) => (
            <button
              key={launcher.id}
              type="button"
              disabled={!project}
              className="min-h-6 truncate border border-border px-1 font-semibold text-foreground hover:bg-hover disabled:opacity-40"
              title={`${launcher.label}: ${launcher.command || "plain PowerShell"}${project ? ` → ${project.name}` : ""}`}
              onClick={() => project && void runLauncher(launcher, project, prefs.where).then(report)}
              data-zaicode-dispatch-launcher={launcher.id}
            >
              {launcher.short}
            </button>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="self-start text-foreground-subtlest underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => {
          onDone?.();
          openZaicodeSettings("zaicodeWorkers");
        }}
      >
        Edit launchers…
      </button>
      {project ? (
        <span className="truncate text-foreground-subtlest" title={project.path}>
          {project.path}
        </span>
      ) : null}
    </div>
  );
}

/** Header button: opens the Dispatch panel under itself. */
export function ZaicodeDispatchButton() {
  const open = useZaicodeDispatchPanel((state) => state.open);
  const setOpen = useZaicodeDispatchPanel((state) => state.setOpen);
  const hotkeys = useZaicodeHotkeySettings();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <ZaicodeTopButton
            title="Dispatch: open a terminal or a CLI in any project"
            shortcut={zaicodeHotkeyLabel("ui.dispatch", hotkeys)}
            pressed={open}
            onClick={() => setOpen(!open)}
            testId="zaicode-dispatch"
          >
            <Send className="size-4" />
          </ZaicodeTopButton>
        </span>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        className={cn("w-80 gap-2 border border-[var(--zaicode-highlight,var(--color-border))] p-2")}
      >
        <div className="flex items-baseline justify-between gap-2 border-b border-border pb-1 text-ui-xs">
          <strong className="text-ui-sm font-normal text-foreground">Dispatch</strong>
          <span className="text-foreground-subtlest">each click = one more instance</span>
        </div>
        <ZaicodeDispatchPanel onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
