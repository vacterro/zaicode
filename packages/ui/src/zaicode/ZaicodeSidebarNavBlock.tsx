import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ZaicodeIcon } from "./zaicodeIconSlots.js";
import { ZaicodeNavItemsEditor } from "./ZaicodeLayoutListEditor.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { isZaicodeLayoutEntryShown, useZaicodeLayout, type ZaicodeNavItemId } from "./zaicodeLayoutPrefs.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";
import { ZAICODE_HELP_ATTRIBUTE, isZaicodeHelpTopicId, ZAICODE_NAV_HELP_TOPICS } from "./zaicodeHelpTopics.js";
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
  const working = useZaicodeRunningSessions((state) => state.sessions.length);
  // SRC-113: Full view shows every ticked menu line, ignoring the moment-based conditions.
  const actionView = useZaicodeUiPrefs((state) => state.actionView);
  const [hover, setHover] = useState(false);
  const openTimers = useZaicodeTimers((state) => state.openDialog);
  // Only the dock flag: the menu must not re-render when a worker window moves (SRC-043).
  const workersOpen = useZaicodeWorkersSelector((state) => state.open);
  const homeActive = useZaicodeActions((state) => state.mainView === "saihome");
  const label = useZaicodeNavLabels();
  const line = (active: boolean) =>
    cn("w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground", active && "bg-selected text-foreground");

  const renderItem = (id: ZaicodeNavItemId): ReactNode => {
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
            <ZaicodeIcon slot="nav.saihome" />
            {label("saihome", "SAIHOME")}
          </Button>
        );
      case "newTask":
        return <div key={id}>{newTask}</div>;
      case "zaicode":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" data-testid="zaicode-sidebar-open" aria-pressed={zaicodeActive} className={line(zaicodeActive)} onClick={() => { useZaicodeWorkspaceTab.getState().setTab("agents"); onOpenZaicode?.(); }}>
            <ZaicodeIcon slot="nav.zaicode" />
            {label("zaicode", zaicodeLabel)}
          </Button>
        );
      case "search":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" className={line(false)} onClick={onOpenCommandCenter}>
            <ZaicodeIcon slot="nav.search" />
            <span className="min-w-0 flex-1 truncate text-left">{label("search", searchLabel)}</span>
            <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">{searchShortcut}</span>
          </Button>
        );
      case "scheduler":
        return <ZaicodeSchedulerNavButton key={id} className={line(false)} {...(onOpenZaicode ? { onOpenZaicode } : {})} />;
      case "plugins":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" data-testid="plugin-store-sidebar-open" aria-pressed={pluginStoreActive} className={line(pluginStoreActive)} onClick={onOpenPluginStore}>
            <ZaicodeIcon slot="nav.plugins" />
            {label("plugins", pluginsLabel)}
          </Button>
        );
      case "timers":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" className={line(false)} onClick={() => openTimers("alarms")}>
            <ZaicodeIcon slot="nav.timers" />
            {label("timers", "Timers")}
          </Button>
        );
      case "help":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" className={line(false)} onClick={() => void openZaicodeHelp()}>
            <ZaicodeIcon slot="nav.help" />
            {label("help", "Help")}
          </Button>
        );
      case "workers":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" aria-pressed={workersOpen} className={line(workersOpen)} onClick={toggleZaicodeWorkersDock}>
            <ZaicodeIcon slot="nav.workers" />
            {label("workers", "WORKERS")}
          </Button>
        );
      case "settings":
        return (
          <Button key={id} variant="ghost" size="lg" data-icon="inline-start" className={line(false)} onClick={() => void openZaicodeSettings()}>
            <ZaicodeIcon slot="nav.settings" />
            {label("settings", "Settings")}
          </Button>
        );
      default:
        return null;
    }
  };

  // SRC-060: every menu line carries the help topic that explains it, so
  // Shift+F1 anywhere on the line lands on the right card. The attribute goes
  // on the element each case already returns rather than on a wrapper, because
  // these are laid out as direct flex children and a wrapper div would change
  // the column.
  const render = (id: ZaicodeNavItemId): ReactNode => {
    const element = renderItem(id);
    const topic = ZAICODE_NAV_HELP_TOPICS[id];
    if (!isValidElement(element) || !isZaicodeHelpTopicId(topic)) return element;
    // A data-* attribute, so it goes on props rather than as an attribute name:
    // the element's own prop type is narrow and does not know the key.
    return cloneElement(element as ReactElement<Record<string, unknown>>, {
      [ZAICODE_HELP_ATTRIBUTE]: topic,
    });
  };

  const visible = items.filter((item) => isZaicodeLayoutEntryShown(item, { working, hover, view: actionView }));
  return (
    <ZaicodeRightClickSettings
      title="Menu lines"
      hint="Which lines this menu shows and in what order. Search also lives in the header as an icon."
      panel={<ZaicodeNavItemsEditor />}
      className="flex w-full"
    >
      <div
        className={cn("flex w-full flex-col gap-1", className)}
        data-zaicode-nav-block
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
      >
        {visible.length > 0 ? visible.map((item) => render(item.id)) : items.some((item) => item.visible) ? (
          // T-134: every ticked line waits for a moment (hover / working / idle): keep a strip to point at.
          <span className="px-2 text-ui-xs text-foreground-subtlest" title="The menu lines show on hover or while agents work / idle (right-click: when)">⋯</span>
        ) : (
          <span className="px-2 text-ui-xs text-foreground-subtlest">Empty menu — right-click to add lines.</span>
        )}
      </div>
    </ZaicodeRightClickSettings>
  );
}

/** The operator's names for the menu lines (SRC-044), read once per render. */
function useZaicodeNavLabels(): (id: ZaicodeNavItemId, fallback: string) => string {
  const items = useZaicodeLayout((state) => state.navItems);
  return (id, fallback) => items.find((item) => item.id === id)?.label || fallback;
}
