import { useState, type ReactNode } from "react";
import { ZaicodeSidebarNavToggle } from "./ZaicodeSidebarHeaderTools.js";
import { ZaicodeHeaderToolsEditor } from "./ZaicodeLayoutListEditor.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { isZaicodeLayoutEntryShown, useZaicodeLayout, type ZaicodeHeaderToolId } from "./zaicodeLayoutPrefs.js";
import { useZaicodeRunningSessions } from "./zaicodeSidebarPrefs.js";
import { openZaicodeSettings } from "./zaicodeActions.js";
import { isZaicodeCommonTool, useZaicodeCommonTools, ZaicodeTopButton } from "./ZaicodeCommonTools.js";
import { ZaicodeOverflowRow } from "./ZaicodeOverflowRow.js";
import { ZaicodeIcon } from "./zaicodeIconSlots.js";

/**
 * The sidebar header row in ZAICODE: the operator decides which buttons sit
 * here and in which order (right-click the row, or Settings -> Layout). The
 * buttons it shares with the footer live in ZaicodeCommonTools.
 */

export { ZaicodeTopButton };

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

export function ZaicodeHeaderToolbar(props: ZaicodeHeaderToolbarProps) {
  const tools = useZaicodeLayout((state) => state.headerTools);
  const common = useZaicodeCommonTools("bottom");
  // T-134: a button can show only while sessions work, only while idle, or only on hover.
  const working = useZaicodeRunningSessions((state) => state.sessions.length);
  const [hover, setHover] = useState(false);

  const render = (id: ZaicodeHeaderToolId): ReactNode => {
    if (isZaicodeCommonTool(id)) return common(id);
    switch (id) {
      case "back":
        return (
          <ZaicodeTopButton key={id} title={props.backTitle} shortcut={props.backShortcut} disabled={!props.canBack} onClick={props.onBack} testId="desktop-top-nav-back">
            <ZaicodeIcon slot="tool.back" />
          </ZaicodeTopButton>
        );
      case "forward":
        return (
          <ZaicodeTopButton key={id} title={props.forwardTitle} shortcut={props.forwardShortcut} disabled={!props.canForward} onClick={props.onForward}>
            <ZaicodeIcon slot="tool.forward" />
          </ZaicodeTopButton>
        );
      case "menu":
        return <ZaicodeSidebarNavToggle key={id} />;
      case "search":
        return props.onOpenCommandCenter ? (
          <ZaicodeTopButton key={id} title="Search sessions, files and commands" shortcut="Ctrl+K" onClick={props.onOpenCommandCenter}>
            <ZaicodeIcon slot="tool.search" />
          </ZaicodeTopButton>
        ) : null;
      case "newTask":
        return (
          <ZaicodeTopButton key={id} title={props.newTaskDisabledReason ?? "New task"} shortcut={props.newTaskShortcut} disabled={Boolean(props.newTaskDisabledReason)} onClick={props.onCreateTask}>
            <ZaicodeIcon slot="tool.newTask" />
          </ZaicodeTopButton>
        );
      case "settings":
        return (
          <ZaicodeTopButton key={id} title="Settings" shortcut="Ctrl+," onClick={() => void openZaicodeSettings()}>
            <ZaicodeIcon slot="tool.settings" />
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
      <div className="flex min-w-0 flex-1" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
        <ZaicodeOverflowRow
          className="flex-1"
          items={tools
            .filter((tool) => tool.id !== "meter" && isZaicodeLayoutEntryShown(tool, { working, hover }))
            .map((tool) => ({ key: tool.id, node: render(tool.id) }))
            .filter((item) => item.node !== null)}
        />
      </div>
    </ZaicodeRightClickSettings>
  );
}
