import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, FolderPlus, MoreHorizontal, Pin, PinOff } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { ZaicodeNameField } from "./ZaicodeNameField.js";
import {
  ZAICODE_UNFILED,
  useZaicodeProjectFolders,
  type ZaicodeProjectFolder,
} from "./zaicodeProjectFolders.js";
import { ZAICODE_PROJECT_DESTRUCTIVE_LABELS, moveTargetsFor } from "./zaicodeProjectOrganization.js";

/**
 * The folder and pin controls (Wave 4, parts A, B and D).
 *
 * Three rules this component exists to keep honest. The folder menu says
 * "Delete folder (projects are kept)" in those words, because the operator
 * has a real reason to fear the line next to it. Every destructive action has
 * its own distinct name -- remove from folder, unpin, delete folder -- so no
 * menu item can be read as "delete my project". And the move is offered as a
 * menu of folders, not only as a drag: dragging is the fast path, the menu is
 * the reachable one.
 */

export function ZaicodeNewFolderButton({ className }: { className?: string }) {
  const createFolder = useZaicodeProjectFolders((state) => state.createFolder);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-zaicode-new-folder
          className={cn(
            // Icon only (SRC-083): a square that reads as a button (a frame, the plus on the folder,
            // the highlight colour on hover) and takes a third of the room the word did.
            "flex size-6 shrink-0 items-center justify-center border border-border bg-surface text-foreground hover:border-[var(--zaicode-highlight,var(--color-border-hover))] hover:bg-hover",
            className,
          )}
          aria-label="New folder"
          title="New folder: group projects into it. Nothing on disk moves."
        >
          <FolderPlus className="size-4" />
        </button>
      </PopoverTrigger>
      {/* The name is asked for right here (T-128): window.prompt does not exist in the desktop app, so the old button did nothing. */}
      <PopoverContent align="start" className="w-64 rounded-none p-2" data-zaicode-new-folder-popover>
        <ZaicodeNameField
          initial="New folder"
          label="Folder name"
          confirmLabel="Create"
          onSubmit={(name) => {
            // A blank name still creates a folder ("New folder"), so the button always does something; the name is editable afterwards.
            createFolder(name);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The folder's own menu. The header decides when it exists (T-128): it used to hold a second `open` flag of its own that
 * started false and returned nothing, so the menu could never be seen and Rename / Delete folder were unreachable.
 */
export function ZaicodeFolderMenu({ folder, onClose }: { folder: ZaicodeProjectFolder; onClose: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const renameFolder = useZaicodeProjectFolders((state) => state.renameFolder);
  const deleteFolder = useZaicodeProjectFolders((state) => state.deleteFolder);
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }} />
      <div
        role="menu"
        data-zaicode-folder-menu={folder.id}
        className="absolute z-40 mt-1 w-60 border border-border bg-popover p-1 text-foreground shadow-md"
      >
        {renaming ? (
          <ZaicodeNameField
            initial={folder.name}
            label="Folder name"
            confirmLabel="Rename"
            className="p-0.5"
            onSubmit={(name) => {
              renameFolder(folder.id, name);
              onClose();
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <>
            <button type="button" role="menuitem" className="block w-full px-1.5 py-0.5 text-left hover:bg-hover" onClick={() => setRenaming(true)}>
              Rename folder
            </button>
            <button
              type="button"
              role="menuitem"
              className="block w-full px-1.5 py-0.5 text-left text-destructive hover:bg-hover"
              title="The projects inside move to No folder. Nothing is deleted."
              onClick={() => {
                // Two steps for the one destructive act here, because the wording in the menu is the operator's only warning.
                onClose();
                void useConfirmDialogStore
                  .getState()
                  .requestConfirmation({
                    title: `${ZAICODE_PROJECT_DESTRUCTIVE_LABELS.deleteFolder}?`,
                    description: `"${folder.name}": the projects inside move out of it. Nothing on disk is deleted.`,
                    confirmLabel: ZAICODE_PROJECT_DESTRUCTIVE_LABELS.deleteFolder,
                    confirmVariant: "destructive",
                  })
                  .then((confirmed) => {
                    if (confirmed) deleteFolder(folder.id);
                  });
              }}
            >
              {ZAICODE_PROJECT_DESTRUCTIVE_LABELS.deleteFolder}
            </button>
          </>
        )}
      </div>
    </>
  );
}

export function ZaicodeProjectFolderHeader({
  folder,
  count,
  collapsed,
  className,
}: {
  folder: ZaicodeProjectFolder | null;
  count: number;
  collapsed: boolean;
  className?: string;
}) {
  const folders = useZaicodeProjectFolders((state) => state.folders);
  const setCollapsed = useZaicodeProjectFolders((state) => state.setCollapsed);
  const [menuOpen, setMenuOpen] = useState(false);
  const unfiled = folder === null;
  const label = unfiled ? "No folder" : folder.name;
  // Unfiled holds whatever is not filed, so folding it away would hide live
  // projects; only real folders can collapse.
  const collapsible = !unfiled;
  return (
    <div
      data-zaicode-folder-header={unfiled ? ZAICODE_UNFILED : folder.id}
      data-zaicode-folder-count={count}
      className={cn("group/folder relative flex items-center gap-1 px-1 py-0.5", className)}
    >
      {collapsible ? (
        <button
          type="button"
          className="flex size-4 items-center justify-center text-foreground-subtlest hover:text-foreground"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          title={`${collapsed ? "Expand" : "Collapse"} ${label}`}
          onClick={() => setCollapsed(folder!.id, !collapsed)}
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      ) : (
        <span className="inline-block size-4" />
      )}
      <Folder className="size-3 shrink-0 text-foreground-subtlest" />
      <span className="truncate text-ui-sm text-foreground-subtle" title={label}>
        {label}
      </span>
      <span className="text-ui-sm tabular-nums text-foreground-subtlest">{count}</span>
      {!unfiled ? (
        <button
          type="button"
          className="ml-auto opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/folder:opacity-100"
          aria-label={`Folder options for ${folder.name}`}
          title={`Folder options for ${folder.name}`}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <MoreHorizontal className="size-3" />
        </button>
      ) : null}
      {menuOpen && folder ? <ZaicodeFolderMenu folder={folder} onClose={() => setMenuOpen(false)} /> : null}
      {unfiled ? <span className="sr-only">{folders.length} folder(s)</span> : null}
    </div>
  );
}

export function ZaicodeProjectPinButton({ projectId, pinned }: { projectId: string; pinned: boolean }) {
  const togglePinned = useZaicodeProjectFolders((state) => state.togglePinned);
  return (
    <button
      type="button"
      data-zaicode-pin={projectId}
      data-zaicode-pin-state={pinned ? "pinned" : "unpinned"}
      // Not hover-revealed: the row carries no `group/row`, so a
      // `group-hover/row:opacity-100` would never fire and the button would sit
      // at opacity 0 forever. The caller already mounts it only with the rest
      // of the row's actions, so it is visible exactly when it is reachable.
      className={cn(
        "flex size-4 shrink-0 items-center justify-center",
        pinned
          ? "text-[var(--zaicode-highlight,var(--color-warning))]"
          : "text-foreground-subtlest hover:bg-hover hover:text-foreground",
      )}
      aria-pressed={pinned}
      aria-label={pinned ? ZAICODE_PROJECT_DESTRUCTIVE_LABELS.unpin : `Pin project to the top of the list`}
      title={
        pinned
          ? ZAICODE_PROJECT_DESTRUCTIVE_LABELS.unpin
          : "Pin this project to the top of the list. Its folder is not changed."
      }
      onClick={(event) => {
        event.stopPropagation();
        togglePinned(projectId);
      }}
    >
      {pinned ? <Pin className="size-3" /> : <PinOff className="size-3" />}
    </button>
  );
}

/** The keyboard-reachable alternative to dragging a project into a folder. */
export function ZaicodeProjectMoveMenu({ projectId, folderId }: { projectId: string; folderId: string }) {
  const folders = useZaicodeProjectFolders((state) => state.folders);
  const moveProject = useZaicodeProjectFolders((state) => state.moveProject);
  const targets = moveTargetsFor({ folders } as never);
  return (
    <div role="group" data-zaicode-project-move={projectId} className="flex flex-col gap-px">
      {targets.map((target) => (
        <button
          key={target.id}
          type="button"
          role="menuitemradio"
          aria-checked={folderId === target.id}
          className={cn(
            "block w-full px-1.5 py-0.5 text-left hover:bg-hover",
            folderId === target.id && "bg-selected text-foreground",
          )}
          title={
            target.id === ZAICODE_UNFILED ? ZAICODE_PROJECT_DESTRUCTIVE_LABELS.unfile : `Move into ${target.label}`
          }
          onClick={() => moveProject(projectId, target.id === ZAICODE_UNFILED ? null : target.id)}
        >
          {target.id === ZAICODE_UNFILED ? ZAICODE_PROJECT_DESTRUCTIVE_LABELS.unfile : `Move into ${target.label}`}
        </button>
      ))}
    </div>
  );
}
