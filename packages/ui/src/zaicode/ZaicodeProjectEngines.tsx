import { Clock } from "lucide-react";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { readZaicodeEngine, useZaicodeEngines, launchableZaicodeAccounts, zaicodeRemainingColor } from "./zaicodeEngines.js";
import {
  activateZaicodeWorker,
  launchZaicodeWorker,
  useZaicodeWorkersSelector,
  zaicodeProjectWorkers,
} from "./zaicodeWorkers.js";
import { addZaicodeAutostartJob } from "./zaicodeAutostart.js";
import { zaicodeVendorColor } from "./ZaicodeLimitViews.js";

/**
 * AUDAPACK's per-project launcher row (C1 C2 A1 A2 AG ZC), inside the
 * project's ⋯ menu: one click starts that subscription as a worker in this
 * project, the fill under each short shows the quota it has left.
 */
export function ZaicodeProjectEngineMenuItems({ projectPath }: { projectPath: string }) {
  const engines = useZaicodeEngines();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const accounts = launchableZaicodeAccounts(engines).filter((account) => account.status !== "cli-missing");
  if (accounts.length === 0) return null;
  const now = Date.now();
  return (
    <>
      <DropdownMenuLabel className="text-ui-xs text-foreground-subtle">Start worker here</DropdownMenuLabel>
      <div className="grid grid-cols-4 gap-0.5 px-1 pb-1" data-zaicode-project-engines>
        {accounts.map((account) => {
          const reading = readZaicodeEngine(account, engines.limits[account.id], now);
          const fill = reading.remaining === null ? 0 : Math.max(reading.remaining > 0 ? 6 : 0, reading.remaining);
          return (
            <DropdownMenuItem
              key={account.id}
              className="relative min-h-6 justify-center overflow-hidden border border-border px-1 pb-[5px] pt-0.5 text-ui-xs font-semibold"
              title={`${account.label}${reading.remaining === null ? "" : ` · ${Math.round(reading.remaining)}% left`}`}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onSelect={() =>
                void launchZaicodeWorker({ account, projectPath }).then((result) => toast(result.message))
              }
            >
              <span style={{ color: zaicodeVendorColor(account.vendor) }}>{account.short}</span>
              <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40">
                <span
                  className="absolute inset-y-0 left-0"
                  style={{ width: `${fill}%`, background: zaicodeRemainingColor(reading.remaining) }}
                />
              </span>
            </DropdownMenuItem>
          );
        })}
      </div>
      <DropdownMenuItem
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onSelect={() => {
          addZaicodeAutostartJob({
            projectPath,
            engineId: accounts.find((account) => account.status === "ready")?.id ?? accounts[0]!.id,
            trigger: "reset",
          });
          setPendingSettingsSection("zaicodeEngines");
          openSettingsTab();
        }}
      >
        <Clock className="h-3.5 w-3.5" />
        Autostart for this project…
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

/** Running workers of a project as small chips on its row (click = show that worker). */
export function ZaicodeProjectWorkerChips({ projectPath }: { projectPath: string }) {
  // One string per row: the chips re-render only when this project's live workers change,
  // not on every window drag / focus change of any worker.
  const signature = useZaicodeWorkersSelector((state) =>
    zaicodeProjectWorkers(state, projectPath)
      .slice(0, 4)
      .map((worker) => [worker.id, worker.short, worker.label].join(""))
      .join(""),
  );
  if (!signature) return null;
  const workers = signature.split("").map((entry) => {
    const [id = "", short = "", label = ""] = entry.split("");
    return { id, short, label };
  });
  return (
    <span className="flex shrink-0 items-center gap-0.5" data-zaicode-project-workers={workers.length}>
      {workers.map((worker) => (
        <button
          key={worker.id}
          type="button"
          className="border border-[#4f9a2f] px-0.5 text-[10px] leading-3 text-[#7fc35a] hover:bg-hover"
          title={`${worker.label} worker running here — click to show it`}
          onClick={(event) => {
            event.stopPropagation();
            activateZaicodeWorker(worker.id);
          }}
        >
          {worker.short}
        </button>
      ))}
    </span>
  );
}
