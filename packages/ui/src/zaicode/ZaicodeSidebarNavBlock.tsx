import type { ReactNode } from "react";
import { AlarmClock, Blocks, CircleHelp, House, Search, Settings, SquareTerminal } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ZaicodeIcon } from "./zaicodeIconSlots.js";
import { ZaicodeNavItemsEditor } from "./ZaicodeLayoutListEditor.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { useZaicodeLayout, type ZaicodeNavItemId } from "./zaicodeLayoutPrefs.js";
import { useZaicodeTimers } from "./zaicodeTimerStore.js";
import { openZaicodeHelp, openZaicodeHomeView, openZaicodeSettings, useZaicodeActions } from "./zaicodeActions.js";
import { toggleZaicodeWorkersDock, useZaicodeWorkersSelector } from "./zaicodeWorkers.js";
import { ZaicodeSchedulerNavButton } from "./ZaicodeSchedulerBits.js";
import { useZaicodeWorkspaceTab } from "./zaicodeScheduler.js";

/**
 * The sidebar menu block in ZAICODE: only the lines the operator picked
 * (New task + ZAICODE by default), in their order. Right-click it to edit.
 */
export function ZaicodeSidebarNavBlock({
  className,
  newTask,
  onOpenCommandCenter,
  searchLabel,
  searchShortcut,
  // SRC-038: the upstream Automations line is replaced by SCHEDULER (props kept for the caller).
  onOpenAutomations: _onOpenAutomations,
  automationsActive: _automationsActive,
  automationsLabel: _automationsLabel,
  onOpenPluginStore,
  pluginStoreActive,
  pluginsLabel,
  onOpenZaicode,
  zaicodeActive,
  zaicodeLabel,
}: {
  className?: string;
  newTask: ReactNode;
  onOpenCommandCenter: () => void;
  searchLabel: string;
  searchShortcut: string;
  onOpenAutomations: () => void;
  automationsActive: boolean;
  automationsLabel: string;
  onOpenPluginStore: () => void;
  pluginStoreActive: boolean;
  pluginsLabel: string;
  onOpenZaicode?: () => void;
  zaicodeActive: boolean;
  zaicodeLabel: string;
}) {
  const items = useZaicodeLayout((state) => state.navItems);
  const openTimers = useZaicodeTimers((state) => state.openDialog);
  // Only the dock flag: the menu must not re-render when a worker window moves (SRC-043).
  const workersOpen = useZaicodeWorkersSelector((state) => state.open);
  const homeActive = useZaicodeActions((state) => state.mainView === "saihome");
  const line = (active: boolean) =>
    cn("w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground", active && "bg-selected text-foreground");

  const render = (id: ZaicodeNavItemId): ReactNode => {
    switch (id) {
      case "saihome":
        return (
          <Button
            key={id}
            variant="ghost"
            size="lg"
            data-icon="inline-start"
            data-testid="zaicode-sidebar-saihome"
            aria-pressed={homeActive}
            className={line(homeActive)}
            title="SAIHOME: what is happening (clock, limits, projects, agents, statistics). Opening it starts nothing."
            onClick={() => void openZaicodeHomeView()}
          >
            <House className="size-4" />
            SAIHOME
          </Button>
        );
      case "newTask":
        return <div key={id}>{newTask}</div>;
      case "zaicode":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" data-testid="zaicode-sidebar-open" aria-pressed={zaicodeActive} className={line(zaicodeActive)} onClick={() => { useZaicodeWorkspaceTab.getState().setTab("agents"); onOpenZaicode?.(); }}>
            <ZaicodeIcon slot="nav.zaicode" />
            {zaicodeLabel}
          </Button>
        );
      case "search":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" className={line(false)} onClick={onOpenCommandCenter}>
            <Search className="size-4" />
            <span className="min-w-0 flex-1 truncate text-left">{searchLabel}</span>
            <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">{searchShortcut}</span>
          </Button>
        );
      case "scheduler":
        return <ZaicodeSchedulerNavButton key={id} className={line(false)} {...(onOpenZaicode ? { onOpenZaicode } : {})} />;
      case "plugins":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" data-testid="plugin-store-sidebar-open" aria-pressed={pluginStoreActive} className={line(pluginStoreActive)} onClick={onOpenPluginStore}>
            <Blocks className="size-4" />
            {pluginsLabel}
          </Button>
        );
      case "timers":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" className={line(false)} onClick={() => openTimers("alarms")}>
            <AlarmClock className="size-4" />
            Timers
          </Button>
        );
      case "help":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" className={line(false)} onClick={() => void openZaicodeHelp()}>
            <CircleHelp className="size-4" />
            Help
          </Button>
        );
      case "workers":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" aria-pressed={workersOpen} className={line(workersOpen)} onClick={toggleZaicodeWorkersDock}>
            <SquareTerminal className="size-4" />
            WORKERS
          </Button>
        );
      case "settings":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" className={line(false)} onClick={() => void openZaicodeSettings()}>
            <Settings className="size-4" />
            Settings
          </Button>
        );
      default:
        return null;
    }
  };

  const visible = items.filter((item) => item.visible);
  return (
    <ZaicodeRightClickSettings
      title="Menu lines"
      hint="Which lines this menu shows and in what order. Search also lives in the header as an icon."
      panel={<ZaicodeNavItemsEditor />}
      className="flex w-full"
    >
      <div className={cn("flex w-full flex-col gap-1", className)} data-zaicode-nav-block>
        {visible.length > 0 ? visible.map((item) => render(item.id)) : (
          <span className="px-2 text-ui-xs text-foreground-subtlest">Empty menu — right-click to add lines.</span>
        )}
      </div>
    </ZaicodeRightClickSettings>
  );
}
