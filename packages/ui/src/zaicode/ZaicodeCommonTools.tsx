import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { ZaicodeDispatchButton } from "./ZaicodeDispatchPanel.js";
import { ZaicodePaletteMenuContent } from "./ZaicodeFooterMenus.js";
import { openZaicodeHelp, openZaicodeHomeView } from "./zaicodeActions.js";
import { useZaicodeHotkeySettings, zaicodeHotkeyLabel } from "./zaicodeHotkeys.js";
import { cycleZaicodeSession } from "./zaicodeSessionNav.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";
import { setZaicodeSoundSettings, useZaicodeSoundSettings } from "./zaicodeSoundEvents.js";
import { useZaicodeTimers } from "./zaicodeTimerStore.js";
import { toggleZaicodeWorkersDock, useZaicodeWorkers } from "./zaicodeWorkers.js";
import { ZaicodeIcon } from "./zaicodeIconSlots.js";
import { openZaicodeUsage, toggleZaicodeUsageSidebar, useZaicodeUsage } from "./zaicodeUsage.js";

/**
 * The icon buttons the sidebar header and the sidebar footer share (SRC-062:
 * the footer is as configurable as the header). Each row picks its own ids
 * and order; a button behaves the same wherever it sits.
 */

export type ZaicodeCommonToolId =
  | "usage"
  | "home"
  | "focusCycle"
  | "cycleArrows"
  | "timers"
  | "help"
  | "mute"
  | "palette"
  | "workers"
  | "dispatch";

const COMMON = new Set<string>([
  "usage",
  "home",
  "focusCycle",
  "cycleArrows",
  "timers",
  "help",
  "mute",
  "palette",
  "workers",
  "dispatch",
]);

export function isZaicodeCommonTool(id: string): id is ZaicodeCommonToolId {
  return COMMON.has(id);
}

export function ZaicodeTopButton({
  title,
  shortcut,
  onClick,
  onContextMenu,
  disabled,
  pressed,
  children,
  testId,
  side = "bottom",
}: {
  title: string;
  shortcut?: string;
  onClick: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  disabled?: boolean;
  pressed?: boolean;
  children: ReactNode;
  testId?: string;
  /** Where the hint opens: below in the header, above in the footer. */
  side?: "top" | "bottom";
}) {
  return (
    <ControlHintTooltip title={title} {...(shortcut ? { shortcut } : {})} side={side}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        className={cn(
          "[app-region:no-drag] transition-colors",
          pressed && "bg-selected text-foreground",
        )}
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

/** Renders a shared tool by id; `side` is where its hint opens. */
export function useZaicodeCommonTools(
  side: "top" | "bottom",
): (id: ZaicodeCommonToolId) => ReactNode {
  const hotkeys = useZaicodeHotkeySettings();
  const sound = useZaicodeSoundSettings();
  const workers = useZaicodeWorkers();
  const openTimers = useZaicodeTimers((state) => state.openDialog);
  const usageMode = useZaicodeUsage((state) => state.mode);
  const hint = (id: string) => zaicodeHotkeyLabel(id, hotkeys);
  const cycle = (direction: 1 | -1) =>
    cycleZaicodeSession(direction, useZaicodeRunningSessions.getState().sessions);

  return (id) => {
    switch (id) {
      case "usage":
        return (
          <ZaicodeTopButton
            key={id}
            side={side}
            title="9router Usage · right-click: sidebar"
            shortcut={hint("ui.usageSidebar")}
            pressed={usageMode !== "closed"}
            onClick={() => openZaicodeUsage(usageMode === "page" ? "closed" : "page")}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              toggleZaicodeUsageSidebar();
            }}
          >
            <ZaicodeIcon slot="tool.usage" />
          </ZaicodeTopButton>
        );
      case "home":
        return (
          <ZaicodeTopButton
            key={id}
            side={side}
            title="SAIHOME"
            shortcut={hint("ui.home")}
            onClick={() => void openZaicodeHomeView()}
          >
            <ZaicodeIcon slot="tool.home" />
          </ZaicodeTopButton>
        );
      case "focusCycle":
        return (
          <ZaicodeTopButton
            key={id}
            side={side}
            title="Focus next session (click) · previous (right-click)"
            shortcut={hint("session.next")}
            onClick={() => cycle(1)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              cycle(-1);
            }}
            {...(side === "bottom" ? { testId: "zaicode-focus-cycle" } : {})}
          >
            <ZaicodeIcon slot="tool.focusCycle" />
          </ZaicodeTopButton>
        );
      case "cycleArrows":
        return (
          <span key={id} className="flex">
            <ZaicodeTopButton
              side={side}
              title="Previous session"
              shortcut={hint("session.prev")}
              onClick={() => cycle(-1)}
            >
              <ZaicodeIcon slot="tool.prev" />
            </ZaicodeTopButton>
            <ZaicodeTopButton
              side={side}
              title="Next session"
              shortcut={hint("session.next")}
              onClick={() => cycle(1)}
            >
              <ZaicodeIcon slot="tool.next" />
            </ZaicodeTopButton>
          </span>
        );
      case "timers":
        return (
          <ZaicodeTopButton
            key={id}
            side={side}
            title="Timers"
            shortcut={hint("timers.open")}
            onClick={() => openTimers("alarms")}
          >
            <ZaicodeIcon slot="tool.timers" />
          </ZaicodeTopButton>
        );
      case "help":
        return (
          <ZaicodeTopButton
            key={id}
            side={side}
            title="Help"
            shortcut={hint("ui.help")}
            onClick={() => void openZaicodeHelp()}
          >
            <ZaicodeIcon slot="tool.help" />
          </ZaicodeTopButton>
        );
      case "mute":
        return (
          <ZaicodeTopButton
            key={id}
            side={side}
            title={sound.muted ? "Sounds are muted: click to unmute" : "Mute every ZAICODE sound"}
            shortcut={hint("sounds.mute")}
            pressed={sound.muted}
            onClick={() => setZaicodeSoundSettings({ muted: !sound.muted })}
          >
            <ZaicodeIcon slot={sound.muted ? "tool.muted" : "tool.mute"} />
          </ZaicodeTopButton>
        );
      case "palette":
        // SRC-051: the theme menu one click away, not two menus deep in the footer account dropdown.
        return (
          <DropdownMenu key={id}>
            <ControlHintTooltip title="Theme: switch the ZAICODE palette" side={side}>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-md"
                  className="[app-region:no-drag] transition-colors"
                  aria-label="Theme"
                  data-testid={side === "bottom" ? "zaicode-header-palette" : undefined}
                >
                  <ZaicodeIcon slot="tool.palette" />
                </Button>
              </DropdownMenuTrigger>
            </ControlHintTooltip>
            <DropdownMenuContent align="start" className="max-h-[70vh] w-56 overflow-y-auto">
              <ZaicodePaletteMenuContent />
            </DropdownMenuContent>
          </DropdownMenu>
        );
      case "workers":
        return (
          <ZaicodeTopButton
            key={id}
            side={side}
            title="WORKERS panel (workers keep running while hidden)"
            shortcut={hint("ui.workers")}
            pressed={workers.open}
            onClick={toggleZaicodeWorkersDock}
          >
            <ZaicodeIcon slot="tool.workers" />
          </ZaicodeTopButton>
        );
      case "dispatch":
        return <ZaicodeDispatchButton key={id} />;
      default:
        return null;
    }
  };
}
