import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { readZaicodeCurrentWorkspace } from "./zaicodeEngines.js";
import {
  focusZaicodeWorker,
  openZaicodeShellWorker,
  toggleZaicodeWorkersPanel,
  useZaicodeWorkers,
  zaicodeWorkerTitle,
} from "./zaicodeWorkers.js";
import { useZaicodeWorkerPrefs } from "./zaicodeWorkerPrefs.js";
import { zaicodeAnyWorkerRunning } from "./zaicodeElapsed.js";
import {
  ZaicodeWorkerHeaderButtons,
  ZaicodeWorkerIconButton,
  ZaicodeWorkerLabel,
  ZaicodeWorkerMenuItems,
  useZaicodeNow,
  zaicodeWorkerStatus,
} from "./ZaicodeWorkerParts.js";

/**
 * Every worker in the sidebar under the engine tiles: where it runs, for how
 * long, one click to show it, the same move / minimize / close buttons as its
 * header. For people who live in the CLIs and want them one glance away.
 */
export function ZaicodeSidebarWorkers() {
  const state = useZaicodeWorkers();
  const enabled = useZaicodeWorkerPrefs((prefs) => prefs.sidebarList);
  const now = useZaicodeNow(30_000, zaicodeAnyWorkerRunning(state.workers));
  if (!enabled || state.workers.length === 0) return null;
  const running = state.workers.filter((worker) => worker.exitCode === null).length;
  return (
    <div className="flex min-w-0 flex-col px-2 pb-1 text-ui-xs" data-zaicode-sidebar-workers={state.workers.length}>
      <div className="flex items-center gap-1 text-foreground-subtlest">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
          title={state.open ? "Hide the WORKERS panel (workers keep running)" : "Show the WORKERS panel"}
          onClick={toggleZaicodeWorkersPanel}
        >
          {state.open ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          <span className="tracking-wide">WORKERS</span>
          <span>
            {running}/{state.workers.length}
          </span>
        </button>
        <ZaicodeWorkerIconButton
          title="New shell in this project"
          onClick={() => {
            const cwd = readZaicodeCurrentWorkspace()?.path;
            if (cwd) openZaicodeShellWorker(cwd);
          }}
        >
          <Plus className="size-3" />
        </ZaicodeWorkerIconButton>
      </div>
      {state.workers.map((worker) => {
        const shown =
          !worker.minimized && (worker.placement === "window" || (state.open && worker.placement === "panel"));
        return (
          <ContextMenu key={worker.id}>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "group relative flex min-w-0 items-center gap-1 overflow-hidden border px-1",
                  worker.id === state.focusedId && shown
                    ? "border-[var(--zaicode-highlight,var(--color-border-hover))]"
                    : "border-transparent hover:border-border",
                )}
                title={`${zaicodeWorkerTitle(worker)} · ${worker.projectPath}\n${zaicodeWorkerStatus(worker, now)}\n${
                  worker.minimized ? "minimized" : worker.placement === "window" ? "own window" : "WORKERS panel"
                }`}
              >
                <button type="button" className="flex min-w-0 flex-1 text-left" onClick={() => focusZaicodeWorker(worker.id)}>
                  <ZaicodeWorkerLabel worker={worker} now={now} className={cn(!shown && "opacity-70")} />
                </button>
                {/* Shown on hover / keyboard focus over the row's right end. Laid over the label,
                    not beside it: a reserved strip took the room the meters and the age need, so
                    the narrow sidebar painted them past the row's frame. Neither the row's height
                    nor the label's width changes when the buttons appear. */}
                <span className="invisible absolute inset-y-0 right-0 flex items-center bg-[var(--color-sidebar,var(--color-background))] group-focus-within:visible group-hover:visible">
                  <ZaicodeWorkerHeaderButtons worker={worker} />
                </span>
              </div>
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
