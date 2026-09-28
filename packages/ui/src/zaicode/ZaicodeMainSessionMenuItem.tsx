import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu.js";
import {
  useZaicodeMainSessionId,
  useZaicodeMainSessions,
  zaicodeMainSessionKey,
} from "./zaicodeMainSession.js";
import { useZaicodeSchedulerMarked, useZaicodeSchedulerMarks } from "./zaicodeSchedulerMarks.js";
import {
  ZAICODE_AUTO_CONTINUE_MODES,
  ZAICODE_AUTO_CONTINUE_SHORT,
  useZaicodeAutoContinue,
  type ZaicodeAutoContinueMode,
} from "./zaicodeAutoContinue.js";

const AUTO_CONTINUE_HINT: Record<ZaicodeAutoContinueMode, string> = {
  default: "Follow the global auto-continue switch in Settings",
  on: "This session continues itself after a crash, even with the global switch off",
  off: "This session never continues itself, whatever the global switch says",
};

/** Session context menu entry: make this the project's MAIN session, or unset it. */
export function ZaicodeMainSessionMenuItem({
  workspacePath,
  workspaceIdentity,
  sessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}) {
  const key = zaicodeMainSessionKey(workspacePath, workspaceIdentity);
  const mainId = useZaicodeMainSessionId(key);
  const setMain = useZaicodeMainSessions((state) => state.setMain);
  const clearMain = useZaicodeMainSessions((state) => state.clearMain);
  const isMain = mainId === sessionId;
  const marked = useZaicodeSchedulerMarked(sessionId);
  const toggleMark = useZaicodeSchedulerMarks((state) => state.toggle);
  const autoContinue = useZaicodeAutoContinue((state) => state.modeFor(sessionId));
  const setAutoContinue = useZaicodeAutoContinue((state) => state.setMode);
  return (
    <>
      <ContextMenuItem
        onSelect={() => (isMain ? clearMain(key) : setMain(key, sessionId))}
        data-zaicode-main-menu-item={isMain ? "unset" : "set"}
      >
        <span className="w-4 text-center text-[var(--zaicode-highlight,var(--color-warning))]">
          {isMain ? "◇" : "◆"}
        </span>
        {isMain ? "Unset MAIN session" : "Make this the MAIN session"}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => toggleMark({ sessionId, workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) })}
        data-zaicode-scheduler-mark-item={marked ? "unmark" : "mark"}
      >
        <span className="w-4 text-center text-[var(--zaicode-highlight,var(--color-warning))]">⚑</span>
        {marked ? "Unmark for the SCHEDULER" : "Mark for the SCHEDULER (only-marked schedules continue it)"}
      </ContextMenuItem>
      <ContextMenuSub>
        <ContextMenuSubTrigger title="Auto-continue for THIS session only. The global switch in Settings still decides every session left on Default." data-zaicode-auto-continue-item={autoContinue}>
          Auto-continue this session: {ZAICODE_AUTO_CONTINUE_SHORT[autoContinue]}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {ZAICODE_AUTO_CONTINUE_MODES.map((mode) => (
            <ContextMenuItem
              key={mode}
              onSelect={() => setAutoContinue(sessionId, mode)}
              title={AUTO_CONTINUE_HINT[mode]}
              data-zaicode-auto-continue={mode}
              aria-checked={autoContinue === mode}
              className={autoContinue === mode ? "bg-selected" : undefined}
            >
              <span className="w-4 text-center text-[var(--zaicode-highlight,var(--color-warning))]">{autoContinue === mode ? "◆" : "◇"}</span>
              {ZAICODE_AUTO_CONTINUE_SHORT[mode]}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
    </>
  );
}
