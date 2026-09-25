import type { MouseEvent, ReactNode } from "react";
import {
  AlarmClock,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Crosshair,
  House,
  MessageCirclePlus,
  Search,
  Settings,
  SquareTerminal,
  Volume2,
  VolumeX,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ZaicodeSidebarNavToggle } from "./ZaicodeSidebarHeaderTools.js";
import { ZaicodeHeaderToolsEditor } from "./ZaicodeLayoutListEditor.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { useZaicodeLayout, type ZaicodeHeaderToolId } from "./zaicodeLayoutPrefs.js";
import { cycleZaicodeSession } from "./zaicodeSessionNav.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";
import { useZaicodeTimers } from "./zaicodeTimerStore.js";
import { openZaicodeHelp, openZaicodeHomeView, openZaicodeSettings } from "./zaicodeActions.js";
import { setZaicodeSoundSettings, useZaicodeSoundSettings } from "./zaicodeSoundEvents.js";
import { toggleZaicodeWorkersDock, useZaicodeWorkers } from "./zaicodeWorkers.js";
import { useZaicodeHotkeySettings, zaicodeHotkeyLabel } from "./zaicodeHotkeys.js";
import { ZaicodeDispatchButton } from "./ZaicodeDispatchPanel.js";
import { ZaicodeOverflowRow } from "./ZaicodeOverflowRow.js";

/**
 * The sidebar header row in ZAICODE: the operator decides which buttons sit
 * here and in which order (right-click the row, or Settings -> Layout).
 */

export function ZaicodeTopButton({
  title,
  shortcut,
  onClick,
  onContextMenu,
  disabled,
  pressed,
  children,
  testId,
}: {
  title: string;
  shortcut?: string;
  onClick: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <ControlHintTooltip title={title} {...(shortcut ? { shortcut } : {})} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        className={cn("[app-region:no-drag] transition-colors", pressed && "bg-selected text-foreground")}
        aria-label={title}
        aria-pressed={pressed}
        disabled={disabled}
        data-testid={testId}
        onClick={() => onClick()}
        onContextMenu={onContextMenu}
      >
        {children}
      </Button>
    </ControlHintTooltip>
  );
}

export interface ZaicodeHeaderToolbarProps {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  backTitle: string;
  forwardTitle: string;
  backShortcut: string;
  forwardShortcut: string;
  onOpenCommandCenter?: () => void;
  onCreateTask: () => void;
  newTaskDisabledReason?: string;
  newTaskShortcut: string;
}

function useCycle() {
  return (direction: 1 | -1) => cycleZaicodeSession(direction, useZaicodeRunningSessions.getState().sessions);
}

export function ZaicodeHeaderToolbar(props: ZaicodeHeaderToolbarProps) {
  const tools = useZaicodeLayout((state) => state.headerTools);
  const cycle = useCycle();
  const hotkeys = useZaicodeHotkeySettings();
  const sound = useZaicodeSoundSettings();
  const workers = useZaicodeWorkers();
  const openTimers = useZaicodeTimers((state) => state.openDialog);
  const hint = (id: string) => zaicodeHotkeyLabel(id, hotkeys);

  const render = (id: ZaicodeHeaderToolId): ReactNode => {
    switch (id) {
      case "back":
        return (
          <ZaicodeTopButton key={id} title={props.backTitle} shortcut={props.backShortcut} disabled={!props.canBack} onClick={props.onBack} testId="desktop-top-nav-back">
            <ArrowLeftIcon className="size-4" />
          </ZaicodeTopButton>
        );
      case "forward":
        return (
          <ZaicodeTopButton key={id} title={props.forwardTitle} shortcut={props.forwardShortcut} disabled={!props.canForward} onClick={props.onForward}>
            <ArrowRightIcon className="size-4" />
          </ZaicodeTopButton>
        );
      case "focusCycle":
        return (
          <ZaicodeTopButton
            key={id}
            title="Focus next session (click) · previous (right-click)"
            shortcut={hint("session.next")}
            onClick={() => cycle(1)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              cycle(-1);
            }}
            testId="zaicode-focus-cycle"
          >
            <Crosshair className="size-4" />
          </ZaicodeTopButton>
        );
      case "cycleArrows":
        return (
          <span key={id} className="flex">
            <ZaicodeTopButton title="Previous session" shortcut={hint("session.prev")} onClick={() => cycle(-1)}>
              <ChevronLeft className="size-4" />
            </ZaicodeTopButton>
            <ZaicodeTopButton title="Next session" shortcut={hint("session.next")} onClick={() => cycle(1)}>
              <ChevronRight className="size-4" />
            </ZaicodeTopButton>
          </span>
        );
      case "menu":
        return <ZaicodeSidebarNavToggle key={id} />;
      case "search":
        return props.onOpenCommandCenter ? (
          <ZaicodeTopButton key={id} title="Search sessions, files and commands" shortcut="Ctrl+K" onClick={props.onOpenCommandCenter}>
            <Search className="size-4" />
          </ZaicodeTopButton>
        ) : null;
      case "newTask":
        return (
          <ZaicodeTopButton key={id} title={props.newTaskDisabledReason ?? "New task"} shortcut={props.newTaskShortcut} disabled={Boolean(props.newTaskDisabledReason)} onClick={props.onCreateTask}>
            <MessageCirclePlus className="size-4" />
          </ZaicodeTopButton>
        );
      case "home":
        return (
          <ZaicodeTopButton key={id} title="SAIHOME" shortcut={hint("ui.home")} onClick={() => void openZaicodeHomeView()}>
            <House className="size-4" />
          </ZaicodeTopButton>
        );
      case "timers":
        return (
          <ZaicodeTopButton key={id} title="Timers" shortcut={hint("timers.open")} onClick={() => openTimers("alarms")}>
            <AlarmClock className="size-4" />
          </ZaicodeTopButton>
        );
      case "help":
        return (
          <ZaicodeTopButton key={id} title="Help" shortcut={hint("ui.help")} onClick={() => void openZaicodeHelp()}>
            <CircleHelp className="size-4" />
          </ZaicodeTopButton>
        );
      case "mute":
        return (
          <ZaicodeTopButton key={id} title={sound.muted ? "Sounds are muted: click to unmute" : "Mute every ZAICODE sound"} shortcut={hint("sounds.mute")} pressed={sound.muted} onClick={() => setZaicodeSoundSettings({ muted: !sound.muted })}>
            {sound.muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
          </ZaicodeTopButton>
        );
      case "workers":
        return (
          <ZaicodeTopButton key={id} title="WORKERS panel (workers keep running while hidden)" shortcut={hint("ui.workers")} pressed={workers.open} onClick={toggleZaicodeWorkersDock}>
            <SquareTerminal className="size-4" />
          </ZaicodeTopButton>
        );
      case "dispatch":
        return <ZaicodeDispatchButton key={id} />;
      case "settings":
        return (
          <ZaicodeTopButton key={id} title="Settings" shortcut="Ctrl+," onClick={() => void openZaicodeSettings()}>
            <Settings className="size-4" />
          </ZaicodeTopButton>
        );
      default:
        return null;
    }
  };

  return (
    <ZaicodeRightClickSettings
      title="Header buttons"
      hint="Pick the buttons for this row and their order. The working meter sits on the right. Buttons that do not fit move into ⋯."
      panel={<ZaicodeHeaderToolsEditor />}
      className="flex min-w-0 flex-1"
    >
      {/* SRC-035: a narrow sidebar used to cut the last icons off; they now move into ⋯ instead. */}
      <ZaicodeOverflowRow
        className="flex-1"
        items={tools
          .filter((tool) => tool.visible && tool.id !== "meter")
          .map((tool) => ({ key: tool.id, node: render(tool.id) }))
          .filter((item) => item.node !== null)}
      />
    </ZaicodeRightClickSettings>
  );
}
