import { useCallback, useMemo, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useZaicodeDisabledProjects } from "./zaicodeProjectSwitch.js";
import { useZaicodeSessionRoles, zaicodeRoleFromTitle } from "./zaicodeSessionRoles.js";
import { useZaicodeMainSessions } from "./zaicodeMainSession.js";
import { applyZaicodeMainBulkAssign, type ZaicodeMainBulkProject } from "./zaicodeMainBulkAssign.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

interface SessionGroupLike {
  workspacePath: string;
  workspaceIdentity?: string;
  items: readonly ZCodeTaskMeta[];
}

/**
 * Right-click on "Project = MAIN": assign MAIN across every registered project
 * in one command (SRC-290). SET ALL, never TOGGLE ALL — a valid MAIN is left
 * exactly as it is, and nothing is created, started or stopped here.
 *
 * The command enumerates the tabs the sidebar already loaded, so projects
 * hidden by filtering, a collapsed group, a folded slot or virtualization are
 * all included; a switched-off project is counted and left off.
 */
export function ZaicodeMainBulkAssignMenu({
  open,
  onOpenChange,
  tabs,
  sessionGroups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: readonly WorkspaceTabState[];
  sessionGroups: ReadonlyMap<string, SessionGroupLike>;
}) {
  const disabledKeys = useZaicodeDisabledProjects((state) => state.keys);
  const [busy, setBusy] = useState(false);
  const disabledSet = useMemo(() => new Set(disabledKeys), [disabledKeys]);

  const projects = useMemo<ZaicodeMainBulkProject[]>(
    () =>
      tabs.map((tab) => {
        const key = tab.workspaceIdentity?.trim() || tab.workspacePath;
        const group = sessionGroups.get(key);
        const items = group?.items ?? [];
        return {
          key,
          name: tab.label?.trim() || tab.workspacePath,
          disabled: disabledSet.has(key),
          // Archived rows live in their own section and are not offered here.
          sessions: items.map((item) => ({
            sessionId: item.taskId,
            title: item.title || "Untitled session",
            updatedAt: item.updatedAt,
            role: resolveSessionRole(item),
          })),
        };
      }),
    [tabs, sessionGroups, disabledSet],
  );

  const run = useCallback(() => {
    if (busy || projects.length === 0) return;
    setBusy(true);
    try {
      const store = useZaicodeMainSessions.getState();
      const result = applyZaicodeMainBulkAssign(projects, store);
      const { plan } = result;
      const total = plan.assigned + plan.unchanged + plan.pending + plan.skipped;
      const head = !result.persisted
        ? "MAIN assignment NOT saved"
        : plan.assigned === 0 && plan.pending === 0
          ? "MAIN assignment: nothing to do"
          : "MAIN assignment complete";
      const counts =
        `${total} project(s) checked, ${plan.unchanged} already MAIN, ` +
        `${plan.assigned} newly assigned, ${plan.pending} pending, ${plan.skipped} switched off`;
      const pendingNames = plan.outcomes
        .filter((outcome) => outcome.kind === "pending")
        .map((outcome) => outcome.name)
        .join(", ");
      const message = pendingNames
        ? `${head}\n${counts}\nPending (next session becomes MAIN, this window only): ${pendingNames}`
        : `${head}\n${counts}`;
      onOpenChange(false);
      toast(message, {
        ...(result.persisted ? {} : { variant: "warning" as const }),
        ...(plan.assigned + plan.pending > 0
          ? { actionLabel: "Undo", onAction: () => result.undo() }
          : {}),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, projects, onOpenChange]);

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      {/* The visible tab keeps its plain left-click; this is its keyboard path. */}
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="sr-only"
          data-zaicode-main-bulk-trigger=""
          title="Project = MAIN actions: assign MAIN in every project"
        >
          Project = MAIN actions
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuLabel>Project = MAIN</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={busy || projects.length === 0}
          data-zaicode-main-bulk-assign=""
          title="Assign an existing eligible session as MAIN for every registered project. A project that already has a valid MAIN keeps it; a project with no eligible session becomes pending."
          onSelect={run}
        >
          <span className="w-4 text-center text-[var(--zaicode-highlight,var(--color-warning))]">
            ◆
          </span>
          Make ALL Projects MAIN
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-ui-caption text-foreground-subtle">
          Set all, never toggle: an existing MAIN is never replaced. Nothing is
          started, stopped or created.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A persistent subSaipen role recorded for the session, else the one its title was born with. */
function resolveSessionRole(item: ZCodeTaskMeta) {
  const stored = useZaicodeSessionRoles.getState().bySession[item.taskId];
  return stored ?? zaicodeRoleFromTitle(item.title);
}
