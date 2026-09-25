import { useState } from "react";
import { CalendarClock, Users, Zap } from "lucide-react";
import { ZAICODE_HIT_AND_GO_PROMPT } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { ensureZaicodeHitAndGoAgent } from "./zaicodeAutostart.js";
import { useZaicodeWorkspaceTab } from "./zaicodeScheduler.js";
import type { ZaicodeServices, ZaicodeWorkspaceContext } from "./zaicodeServices.js";
import { useZaicodeStore } from "./zaicodeStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { projectNameOf } from "./zaicodeEngines.js";
import { useZaicodeMainSessions, zaicodeMainSessionKey } from "./zaicodeMainSession.js";
import { startZaicodeInMain } from "./zaicodeScheduleRun.js";

/** The two pages of the ZAICODE workspace: agents + queue, and the SCHEDULER (SRC-038). */
export function ZaicodeWorkspaceTabs() {
  const tab = useZaicodeWorkspaceTab((state) => state.tab);
  const setTab = useZaicodeWorkspaceTab((state) => state.setTab);
  return (
    <div className="flex shrink-0 gap-px" role="tablist" aria-label="ZAICODE pages">
      {(
        [
          ["agents", "Agents & tasks", "Agents, their queue and results"],
          ["scheduler", "Scheduler", "Prompts that start by themselves: times, intervals, quota resets"],
        ] as const
      ).map(([id, label, hint]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          title={hint}
          className={cn(
            "flex items-center gap-1 border px-1.5 py-0.5 text-ui-xs",
            tab === id
              ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground"
              : "border-border text-foreground-subtle hover:bg-hover hover:text-foreground",
          )}
          onClick={() => setTab(id)}
          data-zaicode-workspace-tab={id}
        >
          {id === "scheduler" ? <CalendarClock className="size-3" /> : <Users className="size-3" />}
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * SRC-038 hit and go: one click, `/goal cc all` in this project. SAIPEN guards
 * the work. A project that already has a MAIN session continues there
 * (SRC-044: never a second session next to MAIN); only a project without MAIN
 * gets the hit-and-go agent (made on first use) through the queue.
 */
export function ZaicodeHitAndGoButton({
  services,
  workspace,
  disabled,
}: {
  services: ZaicodeServices;
  workspace: ZaicodeWorkspaceContext;
  disabled?: boolean;
}) {
  const store = useZaicodeStore();
  const [running, setRunning] = useState(false);
  const go = async () => {
    setRunning(true);
    try {
      const mainKey = zaicodeMainSessionKey(workspace.workspacePath, workspace.workspaceIdentity);
      if (useZaicodeMainSessions.getState().byWorkspace[mainKey]) {
        const outcome = await startZaicodeInMain({ prompt: "" }, [
          {
            path: workspace.workspacePath,
            ...(workspace.workspaceIdentity ? { identity: workspace.workspaceIdentity } : {}),
            key: buildTaskWorkspaceKey(workspace.workspacePath, workspace.workspaceIdentity),
            name: projectNameOf(workspace.workspacePath),
          },
        ], Date.now());
        toast(`Hit & go: ${outcome.lines.join("; ") || "nothing to do"}`);
        return;
      }
      const agent = await ensureZaicodeHitAndGoAgent(services);
      await store.refresh(services, workspace);
      const created = await store.createJob(services, workspace, {
        agentId: agent.id,
        title: ZAICODE_HIT_AND_GO_PROMPT,
        instructions: ZAICODE_HIT_AND_GO_PROMPT,
        priority: 0,
      });
      if (created) await store.pumpQueue(services, workspace);
      toast(`${agent.name}: ${ZAICODE_HIT_AND_GO_PROMPT} queued in this project`);
    } catch (error) {
      toast(`Hit & go failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={disabled || running}
      title={`Hit & go: ${ZAICODE_HIT_AND_GO_PROMPT} in this project now -- in its MAIN session when it has one, else an Autopilot agent through the queue (made on first use). SAIPEN keeps it safe and calls you when needed.`}
      onClick={() => void go()}
      data-zaicode-hit-and-go
    >
      <Zap className="size-3" />
      Hit & go
    </Button>
  );
}
