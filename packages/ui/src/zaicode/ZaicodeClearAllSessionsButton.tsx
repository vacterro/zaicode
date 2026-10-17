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
 * CLEAR ALL SESSIONS Button (PART 2 & 6).
 *
 * Compact label: CLEAR ALL.
 * Tooltip:
 *   Clears completed and unfinished sessions.
 *   Running work will be stopped.
 *   Does not delete project source files or SAIPEN tasks.
 *   Does not continue old sessions.
 */
export function ZaicodeClearAllSessionsButton() {
  const sessions = useZaicodeSessionBriefs((state) => state.sessions);
  const confirmDialog = useConfirmDialog();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const plan = useMemo(() => planZaicodeClearAllSessions(sessions), [sessions]);
  const count = plan.totalCount;

  const run = async () => {
    if (inFlight.current || busy || count === 0) return;

    if (plan.runningCount > 0 || count > 0) {
      const confirmed = await confirmDialog({
        title: "Clear All Sessions",
        description:
          "Clears completed and unfinished sessions. Running work will be stopped. Does not delete project source files or SAIPEN tasks. Does not continue old sessions.",
        confirmLabel: "Clear All Sessions",
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
    }

    inFlight.current = true;
    setBusy(true);
    playZaicodeSound("ui.toggle");

    try {
      const localServices = readZaicodeLocalServices();
      const authoritativePlan = await collectAuthoritativeClearAllSessionsPlan({
        workspaces: plan.workspaces,
        taskService: localServices?.zcodeTaskService,
        fallbackSessions: sessions,
      });

      const result = await runZaicodeClearAllSessions({
        plan: authoritativePlan,
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
      title={`CLEAR ALL SESSIONS — Clears completed and unfinished sessions.\n${describeZaicodeClearAllSessions(plan)}`}
      onClick={() => void run()}
      data-zaicode-clear-all-sessions={count}
      data-zaicode-clear-all-running={plan.runningCount}
      data-zaicode-clear-all-busy={busy ? 1 : 0}
    >
      <BrushCleaning className="size-3.5" />
      <span>CLEAR ALL</span>
      {count > 0 ? <span className="tabular-nums font-semibold text-[11px]">({count})</span> : null}
    </button>
  );
}
