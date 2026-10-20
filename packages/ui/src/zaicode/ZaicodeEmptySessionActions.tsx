import { useState } from "react";
import { FileText, Play, RotateCcw } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import {
  ZaicodePrefCheck,
  ZaicodePrefHeading,
  ZaicodeRightClickSettings,
} from "./ZaicodePrefControls.js";

import { useZaicodeSessionNav } from "./zaicodeSessionNav.js";

export interface ZaicodeEmptySessionActionsProps {
  className?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  paneId?: string;
}

export interface QuickActionDescriptor {
  id: string;
  label: string;
  description: string;
  template: string;
  defaultTemplate: string;
  visible: boolean;
  preferenceKey: "newHandoffAction" | "goalCcAllAction";
}

const DEFAULT_NEW_HANDOFF_TEMPLATE = "SAIHANDOFF - \n\nMISSION:\n\n";
const DEFAULT_GOAL_CC_ALL_TEMPLATE = "/goal cc all";

/**
 * Entry points offered on empty session state after cleanup:
 * - NEW HANDOFF (pre-fills handoff structure for operator)
 * - GOAL CC ALL (pre-fills /goal cc all for operator review)
 * Both use authoritative composer draft API and neither auto-submits.
 */
export function ZaicodeEmptySessionActions({
  className,
  workspacePath,
  workspaceIdentity,
  paneId: _paneId,
}: ZaicodeEmptySessionActionsProps) {
  const prefs = useZaicodeUiPrefs();
  const [inserting, setInserting] = useState<string | null>(null);

  const resolveTarget = () => {
    const navPath = useZaicodeSessionNav.getState().activeWorkspacePath ?? "";
    const targetPath = workspacePath || navPath;
    const targetIdentity = workspaceIdentity;
    return { targetPath, targetIdentity };
  };

  const handleInsert = (id: string, text: string, successMessage: string) => {
    const { targetPath, targetIdentity } = resolveTarget();
    if (!targetPath) {
      toast("Could not insert draft: no active workspace selected.");
      return;
    }

    try {
      setInserting(id);
      const requestId = useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          targetPath,
          text,
          targetIdentity,
          undefined,
          "prepend-if-missing",
        );

      if (requestId > 0) {
        toast(successMessage);
      } else {
        toast("Could not insert draft: composer request was not accepted.");
      }
    } catch (error) {
      toast(`Failed to insert draft: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setInserting(null);
    }
  };

  const handleNewHandoff = () => {
    const template = prefs.newHandoffTemplate || DEFAULT_NEW_HANDOFF_TEMPLATE;
    handleInsert(
      "new-handoff",
      template,
      "Draft prefilled with SAIHANDOFF template. Review and submit.",
    );
  };

  const handleGoalCcAll = () => {
    const template = prefs.goalCcAllTemplate || DEFAULT_GOAL_CC_ALL_TEMPLATE;
    handleInsert(
      "goal-cc-all",
      template,
      "Draft prefilled with /goal cc all. Review and submit to start fresh MAIN.",
    );
  };

  if (!prefs.showNewHandoffAction && !prefs.showGoalCcAllAction) {
    return null;
  }

  return (
    <div
      className={cn("flex flex-wrap items-center gap-2 pt-2", className)}
      data-zaicode-empty-session-actions
    >
      {prefs.showNewHandoffAction ? (
        <ZaicodeRightClickSettings
          title="NEW HANDOFF action"
          preferenceKey="newHandoffAction"
          hint="Configure NEW HANDOFF button and draft template"
          panel={
            <div className="flex max-w-[340px] flex-col gap-2 text-ui-xs">
              <ZaicodePrefCheck
                checked={prefs.showNewHandoffAction}
                onChange={(showNewHandoffAction) => prefs.update({ showNewHandoffAction })}
                label="Show NEW HANDOFF button"
              />
              <p className="text-foreground-subtle">
                Prepares a new task for SAIPEN with a visible, editable template. Does not submit automatically.
              </p>
              <ZaicodePrefHeading>TEMPLATE</ZaicodePrefHeading>
              <textarea
                aria-label="NEW HANDOFF draft template"
                className="h-20 w-full resize-y border border-border bg-background p-1 font-mono text-ui-xs text-foreground"
                value={prefs.newHandoffTemplate}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => prefs.update({ newHandoffTemplate: e.target.value })}
              />
              <button
                type="button"
                className="flex items-center gap-1 self-start border border-border px-2 py-0.5 text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground"
                onClick={() => prefs.update({ newHandoffTemplate: DEFAULT_NEW_HANDOFF_TEMPLATE })}
              >
                <RotateCcw className="size-3" />
                Restore default template
              </button>
            </div>
          }
        >
          <button
            type="button"
            className="flex items-center gap-1.5 border border-border bg-background px-2.5 py-1 text-ui-xs font-medium text-foreground shadow-sm hover:border-[var(--zaicode-highlight,var(--color-border-hover))] hover:bg-hover active:bg-hover/80"
            onClick={handleNewHandoff}
            disabled={inserting === "new-handoff"}
            title="Start a new handoff in this project (right-click to configure template)"
            data-testid="zaicode-new-handoff-action"
          >
            <FileText className="size-3.5 text-foreground-subtle" />
            <span>NEW HANDOFF</span>
          </button>
        </ZaicodeRightClickSettings>
      ) : null}

      {prefs.showGoalCcAllAction ? (
        <ZaicodeRightClickSettings
          title="GOAL CC ALL action"
          preferenceKey="goalCcAllAction"
          hint="Configure GOAL CC ALL button and draft behavior"
          panel={
            <div className="flex max-w-[340px] flex-col gap-2 text-ui-xs">
              <ZaicodePrefCheck
                checked={prefs.showGoalCcAllAction}
                onChange={(showGoalCcAllAction) => prefs.update({ showGoalCcAllAction })}
                label="Show GOAL CC ALL button"
              />
              <p className="text-foreground-subtle">
                Prepares the existing SAIPEN continuation goal (/goal cc all) for operator review. Does not auto-submit.
              </p>
              <ZaicodePrefHeading>COMMAND</ZaicodePrefHeading>
              <input
                aria-label="GOAL CC ALL command text"
                className="w-full border border-border bg-background p-1 font-mono text-ui-xs text-foreground"
                value={prefs.goalCcAllTemplate}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => prefs.update({ goalCcAllTemplate: e.target.value })}
              />
              <button
                type="button"
                className="flex items-center gap-1 self-start border border-border px-2 py-0.5 text-ui-xs text-foreground-subtle hover:bg-hover hover:text-foreground"
                onClick={() => prefs.update({ goalCcAllTemplate: DEFAULT_GOAL_CC_ALL_TEMPLATE })}
              >
                <RotateCcw className="size-3" />
                Restore default command
              </button>
            </div>
          }
        >
          <button
            type="button"
            className="flex items-center gap-1.5 border border-border bg-background px-2.5 py-1 text-ui-xs font-medium text-foreground shadow-sm hover:border-[var(--zaicode-highlight,var(--color-border-hover))] hover:bg-hover active:bg-hover/80"
            onClick={handleGoalCcAll}
            disabled={inserting === "goal-cc-all"}
            title="Prepare /goal cc all for a fresh MAIN execution (right-click to configure)"
            data-testid="zaicode-goal-cc-all-action"
          >
            <Play className="size-3.5 text-foreground-subtle" />
            <span>GOAL CC ALL</span>
          </button>
        </ZaicodeRightClickSettings>
      ) : null}
    </div>
  );
}
