import { useMemo, useRef, useState } from "react";
import { BrushCleaning } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZaicodeSessionBriefs } from "./zaicodeContinue.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { readZaicodeLocalServices } from "./home/zaicodeHomeFeed.js";
import {
  planZaicodeClearAllSessions,
  collectAuthoritativeClearAllSessionsPlan,
  describeZaicodeClearAllSessions,
  runZaicodeClearAllSessions,
  formatZaicodeClearAllSessionsRun,
} from "./zaicodeClearAllSessions.js";
import {
  invalidateSessionAcrossWorkspaceConnections,
  clearWarmPoolAcrossWorkspaceConnections,
} from "@/v4/workspaceConnectionRegistry.js";

/**
 * CLEAR ALL SESSIONS Button (PART 2, 3, 6).
 *
 * Dual-action cleanup control:
 * - LEFT CLICK: Clear idle sessions without interrupting running agents.
 * - RIGHT CLICK (or Shift+Click / ContextMenu key): Open confirmed full cleanup.
 *
 * Tooltip:
 *   Left-click: Clear idle sessions
 *   Right-click: Clear all sessions, including running
 */
export function ZaicodeClearAllSessionsButton() {
  const sessions = useZaicodeSessionBriefs((state) => state.sessions);
  const confirmDialog = useConfirmDialog();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => planZaicodeClearAllSessions(sessions), [sessions]);
  const count = plan.totalCount;

  const executeCleanup = async (policy: "IDLE_ONLY" | "ALL_SESSIONS") => {
    if (inFlight.current || busy || count === 0) return;

    inFlight.current = true;
    setBusy(true);
    playZaicodeSound("ui.toggle");

    try {
      const localServices = readZaicodeLocalServices();
      const authoritativePlan = await collectAuthoritativeClearAllSessionsPlan({
        workspaces: plan.workspaces,
        taskService: localServices?.zcodeTaskService,
        fallbackSessions: sessions,
        policy,
      });

      const result = await runZaicodeClearAllSessions({
        plan: authoritativePlan,
        policy,
        taskService: localServices?.zcodeTaskService,
        sessionDataLayer: {
          invalidateSession: (sessionId: string) => {
            invalidateSessionAcrossWorkspaceConnections(sessionId);
          },
          clearWarmPool: () => {
            clearWarmPoolAcrossWorkspaceConnections();
          },
        },
        remaining: () => useZaicodeSessionBriefs.getState().sessions,
      });

      toast(formatZaicodeClearAllSessionsRun(result), { durationMs: 8000 });
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };

  const handleFullCleanPrompt = async () => {
    if (inFlight.current || busy || count === 0) return;

    const confirmed = await confirmDialog({
      title: "Clear All Sessions",
      description:
        `Clears all sessions, including running sessions and their queued commands.\n\n` +
        `• Total sessions: ${plan.totalCount}\n` +
        `• Running sessions: ${plan.runningCount}\n` +
        `• Queued/waiting sessions: ${plan.waitingCount}\n` +
        `• Idle sessions: ${plan.idleCount}\n\n` +
        `Running work will be stopped. Project source files and SAIPEN tasks will be preserved.`,
      confirmLabel: "Clear Everything",
      confirmVariant: "destructive",
    });

    if (!confirmed) return;
    await executeCleanup("ALL_SESSIONS");
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey || e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      void handleFullCleanPrompt();
      return;
    }
    void executeCleanup("IDLE_ONLY");
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void handleFullCleanPrompt();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ContextMenu" || (e.shiftKey && (e.key === "Enter" || e.key === " "))) {
      e.preventDefault();
      e.stopPropagation();
      void handleFullCleanPrompt();
    }
  };

  return (
    <button
      type="button"
      className={cn(
        "flex h-6 items-center gap-1 border px-1.5 text-ui-xs font-medium tracking-tight",
        count > 0
          ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground hover:bg-hover active:bg-hover/80"
          : "border-border text-foreground-subtlest",
      )}
      disabled={busy || count === 0}
      title={
        `CLEAR ALL SESSIONS\n` +
        `Left-click: Clear idle sessions (${plan.idleCount})\n` +
        `Right-click: Clear all sessions, including running (${plan.totalCount})\n\n` +
        describeZaicodeClearAllSessions(plan)
      }
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onKeyDown={handleKeyDown}
      data-zaicode-clear-all-sessions={count}
      data-zaicode-clear-all-running={plan.runningCount}
      data-zaicode-clear-all-idle={plan.idleCount}
      data-zaicode-clear-all-busy={busy ? 1 : 0}
    >
      <BrushCleaning className="size-3.5" />
      <span>CLEAR ALL</span>
      {count > 0 ? <span className="tabular-nums font-semibold text-[11px]">({count})</span> : null}
    </button>
  );
}
