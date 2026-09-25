import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Mail } from "lucide-react";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { ZAICODE_SAIPEN_SHORTCUTS, useZaicodeSaipen } from "@/zaicode/zaicodeSaipen.js";
import { useZaicodeSaimailDesk } from "@/zaicode/zaicodeSaimail.js";
import { saimailBriefPrompt } from "@/zaicode/zaicodeSaimailModel.js";

/**
 * Replaces the upstream Plugins preview in ZAICODE: the chip shows the
 * project's SAIPEN position (ticket · phase) and opens the shortcut table.
 * Picking a shortcut puts it into the composer; the user sends it with Enter.
 */
export function ZaicodeSaipenMenu({
  workspacePath,
  workspaceIdentity,
  onInsertCommand,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  onInsertCommand: (command: string) => void;
}) {
  const saipen = useZaicodeSaipen(workspacePath, workspaceIdentity);
  const { mailbox, desk } = useZaicodeSaimailDesk(saipen?.task ?? null);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const position = saipen
    ? [saipen.task, saipen.phase].filter(Boolean).join(" · ") || "IDLE"
    : "not initialized";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="shrink-0 gap-1.5 bg-transparent pl-3 pr-2 text-ui-base/relaxed text-foreground hover:bg-surface-hover focus-visible:bg-surface-hover"
          data-zaicode-saipen-menu=""
          title={saipen?.nextAction ? `NEXT: ${saipen.nextAction}` : "SAIPEN shortcuts"}
        >
          <span className="whitespace-nowrap">SAIPEN</span>
          <span className="whitespace-nowrap text-ui-xs text-foreground-subtle">{position}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-72 max-w-[calc(100vw-2rem)]">
        {saipen ? (
          <>
            <DropdownMenuLabel className="truncate text-ui-xs font-normal text-foreground-subtle">
              NEXT: {saipen.nextAction ?? "—"}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {ZAICODE_SAIPEN_SHORTCUTS.map((shortcut) => (
              <DropdownMenuItem
                key={shortcut.command}
                title={shortcut.hint}
                onSelect={() => onInsertCommand(shortcut.command)}
              >
                <span className="min-w-0 flex-1 truncate">{shortcut.label}</span>
                <DropdownMenuShortcut className="font-mono">
                  {shortcut.command.trim()}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            ))}
            {mailbox && desk ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  title="Draft a request for the agent to read the SAIMAIL desk (headers first)"
                  onSelect={() =>
                    onInsertCommand(
                      saimailBriefPrompt({
                        projectRoot: workspacePath,
                        workspace: mailbox,
                        seat: desk.seat,
                      }),
                    )
                  }
                >
                  <Mail className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">Read SAIMAIL desk</span>
                  <DropdownMenuShortcut className="tabular-nums">
                    {desk.unread.length} unread
                  </DropdownMenuShortcut>
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  title="SAIMAIL is the local agent post office. Pick or create your mailbox folder."
                  onSelect={() => {
                    setPendingSettingsSection("zaicode");
                    openSettingsTab();
                  }}
                >
                  <Mail className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">Set up SAIMAIL…</span>
                  <DropdownMenuShortcut>{mailbox ? "not a mailbox" : "off"}</DropdownMenuShortcut>
                </DropdownMenuItem>
              </>
            )}
          </>
        ) : (
          <DropdownMenuItem
            title="Create .saipen/ memory for this project"
            onSelect={() => onInsertCommand("saipen set")}
          >
            <span className="min-w-0 flex-1 truncate">Initialize SAIPEN</span>
            <DropdownMenuShortcut className="font-mono">saipen set</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
