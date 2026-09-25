import { Archive, ArchiveRestore, FolderArchive, Layers } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu.js";
import {
  archiveAllZaicodeSessionsEverywhere,
  useZaicodeArchiveUndo,
} from "./zaicodeArchiveUndo.js";

/**
 * Right-click on a session's Archive button: archive just this one, every
 * idle session of the project, or every idle session of every project. All
 * of them are one Ctrl+Z (or the Undo button in the notice) away from coming
 * back; sessions that are working right now are never archived.
 */
export function ZaicodeArchiveContextMenuContent({
  taskTitle,
  projectLabel,
  onArchiveOne,
  onArchiveProject,
}: {
  taskTitle: string;
  projectLabel: string;
  onArchiveOne: () => void;
  onArchiveProject?: () => void;
}) {
  const canUndo = useZaicodeArchiveUndo((state) => state.entries.length > 0);
  const undo = useZaicodeArchiveUndo((state) => state.undo);
  return (
    <ContextMenuContent className="w-72" data-zaicode-archive-menu>
      <ContextMenuItem onSelect={onArchiveOne}>
        <Archive className="size-4" />
        <span className="min-w-0 truncate">Archive “{taskTitle}”</span>
      </ContextMenuItem>
      {onArchiveProject ? (
        <ContextMenuItem onSelect={onArchiveProject}>
          <FolderArchive className="size-4" />
          <span className="min-w-0 truncate">Archive all idle in {projectLabel}</span>
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onSelect={() => void archiveAllZaicodeSessionsEverywhere()}>
        <Layers className="size-4" />
        Archive all idle in every project
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!canUndo} onSelect={() => void undo()}>
        <ArchiveRestore className="size-4" />
        Undo last archive (Ctrl+Z)
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
