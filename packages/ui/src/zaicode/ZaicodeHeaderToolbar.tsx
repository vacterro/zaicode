import type { ReactNode } from "react";
import { ArrowLeftIcon, ArrowRightIcon, MessageCirclePlus, Search, Settings } from "lucide-react";
import { ZaicodeSidebarNavToggle } from "./ZaicodeSidebarHeaderTools.js";
import { ZaicodeHeaderToolsEditor } from "./ZaicodeLayoutListEditor.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { useZaicodeLayout, type ZaicodeHeaderToolId } from "./zaicodeLayoutPrefs.js";
import { openZaicodeSettings } from "./zaicodeActions.js";
import { isZaicodeCommonTool, useZaicodeCommonTools, ZaicodeTopButton } from "./ZaicodeCommonTools.js";
import { ZaicodeOverflowRow } from "./ZaicodeOverflowRow.js";

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

  const render = (id: ZaicodeHeaderToolId): ReactNode => {
    if (isZaicodeCommonTool(id)) return common(id);
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
