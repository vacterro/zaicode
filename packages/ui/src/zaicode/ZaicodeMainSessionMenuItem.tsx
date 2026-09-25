import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu.js";
import {
  useZaicodeMainSessionId,
  useZaicodeMainSessions,
  zaicodeMainSessionKey,
} from "./zaicodeMainSession.js";

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
      <ContextMenuSeparator />
    </>
  );
}
