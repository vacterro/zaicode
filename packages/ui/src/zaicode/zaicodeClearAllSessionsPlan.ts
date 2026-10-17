import type { IZCodeTaskService } from "@zcode/services";
import { logger } from "@/logger.js";
import { type ZaicodeSessionBrief } from "./zaicodeContinue.js";
import { zaicodeGoalLiveIntent } from "./zaicodeGoalSupervisor.js";
import { useZaicodeRetryLedger } from "./zaicodeRetryPolicy.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

export type ZaicodeClearPolicy = "IDLE_ONLY" | "ALL_SESSIONS";

export interface SessionIdleCheckContext {
  hasPendingCommands?: (sessionId: string) => boolean;
  hasActiveRetry?: (sessionId: string) => boolean;
  hasActiveGoal?: (projectKey: string, sessionId: string) => boolean;
  isStreamingOrActive?: (sessionId: string) => boolean;
}

/**
 * Authoritative predicate to determine whether a session is safely idle (PART 1).
 *
 * Eligible examples:
 * - Completed sessions.
 * - Failed sessions without active execution.
 * - Stopped sessions without pending commands.
 * - Interrupted sessions with no active runtime.
 * - Inactive historical sessions.
 * - Archived inactive sessions.
 *
 * Must NOT remove:
 * - Running sessions.
 * - Streaming sessions.
 * - Sessions executing commands.
 * - Sessions containing pending executable commands.
 * - Sessions awaiting user interaction / response (waiting).
 * - Sessions with active goal intent or auto-retry scheduled.
 * - Sessions whose activity state is unknown.
 */
export function isSessionSafelyIdle(
  session: ZaicodeSessionBrief,
  context?: SessionIdleCheckContext,
): boolean {
  if (!session || typeof session.running !== "boolean") {
    return false;
  }
  if (session.running) {
    return false;
  }
  const sessionAny = session as unknown as { activityState?: string; isStreaming?: boolean };
  if (
    sessionAny.activityState === "unknown" ||
    sessionAny.activityState === "running" ||
    sessionAny.activityState === "streaming" ||
    sessionAny.activityState === "executing"
  ) {
    return false;
  }
  if (sessionAny.isStreaming) {
    return false;
  }
  if (context?.isStreamingOrActive && context.isStreamingOrActive(session.sessionId)) {
    return false;
  }
  if (session.waiting) {
    return false;
  }
  if (session.goalStatus === "active") {
    return false;
  }
  if (
    context?.hasActiveGoal
      ? context.hasActiveGoal(session.projectKey, session.sessionId)
      : (typeof session.projectKey === "string" && typeof session.sessionId === "string"
          ? zaicodeGoalLiveIntent(session.projectKey, session.sessionId) !== null
          : false)
  ) {
    return false;
  }
  if (
    context?.hasActiveRetry
      ? context.hasActiveRetry(session.sessionId)
      : (typeof session.sessionId === "string"
          ? Boolean(useZaicodeRetryLedger.getState().pending[session.sessionId])
          : false)
  ) {
    return false;
  }
  const hasPending = context?.hasPendingCommands
    ? context.hasPendingCommands(session.sessionId)
    : (typeof session.sessionId === "string"
        ? pendingCommandRegistry.list(session.sessionId).length > 0
        : false);
  if (hasPending) {
    return false;
  }

  return true;
}

export interface ZaicodeClearAllSessionsPlan {
  totalCount: number;
  runningCount: number;
  stoppedCount: number;
  waitingCount: number;
  failedCount: number;
  completedCount: number;
  idleCount: number;
  policy?: ZaicodeClearPolicy;
  sessions: readonly ZaicodeSessionBrief[];
  workspaces: readonly { workspacePath: string; workspaceIdentity?: string; projectKey: string }[];
}

export interface ZaicodeClearAllSessionsRun {
  policy: ZaicodeClearPolicy;
  totalFound: number;
  stopped: number;
  cancelledCommands: number;
  cleared: number;
  preservedActive: number;
  stillActive: number;
  failedOrUnreachable: string[];
  problems: string[];
}

export function planZaicodeClearAllSessions(
  sessions: readonly ZaicodeSessionBrief[],
  policy: ZaicodeClearPolicy = "ALL_SESSIONS",
  context?: SessionIdleCheckContext,
): ZaicodeClearAllSessionsPlan {
  let runningCount = 0;
  let waitingCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  let stoppedCount = 0;
  let idleCount = 0;

  const workspaceMap = new Map<string, { workspacePath: string; workspaceIdentity?: string; projectKey: string }>();

  for (const session of sessions) {
    if (session.running) runningCount++;
    else if (session.waiting) waitingCount++;
    else if (session.failed) failedCount++;
    else if (session.manuallyStopped || session.interrupted || session.crashCut) stoppedCount++;
    else completedCount++;

    if (isSessionSafelyIdle(session, context)) {
      idleCount++;
    }

    const key = session.projectKey;
    if (!workspaceMap.has(key)) {
      workspaceMap.set(key, {
        workspacePath: session.workspacePath,
        workspaceIdentity: session.workspaceIdentity,
        projectKey: session.projectKey,
      });
    }
  }

  return {
    totalCount: sessions.length,
    runningCount,
    stoppedCount,
    waitingCount,
    failedCount,
    completedCount,
    idleCount,
    policy,
    sessions,
    workspaces: [...workspaceMap.values()],
  };
}

export interface AuthoritativeClearPlanOptions {
  workspaces: readonly { workspacePath: string; workspaceIdentity?: string; projectKey?: string }[];
  taskService?: Pick<IZCodeTaskService, "listTasks" | "listArchivedTasks">;
  fallbackSessions?: readonly ZaicodeSessionBrief[];
  policy?: ZaicodeClearPolicy;
  context?: SessionIdleCheckContext;
}

export async function collectAuthoritativeClearAllSessionsPlan(
  options: AuthoritativeClearPlanOptions,
): Promise<ZaicodeClearAllSessionsPlan> {
  const { workspaces, taskService, fallbackSessions = [], policy = "ALL_SESSIONS", context } = options;
  const sessionsMap = new Map<string, ZaicodeSessionBrief>();

  // 1. Seed with fallback sessions (e.g. from UI state)
  for (const session of fallbackSessions) {
    sessionsMap.set(session.sessionId, session);
  }

  // 2. Discover authoritatively from taskService across all workspaces
  for (const ws of workspaces) {
    const projectKey = ws.projectKey || ws.workspaceIdentity || ws.workspacePath;
    if (taskService?.listTasks) {
      try {
        const activeMetas = await taskService.listTasks({
          workspacePath: ws.workspacePath,
          workspaceIdentity: ws.workspaceIdentity,
        });
        for (const meta of activeMetas ?? []) {
          const existing = sessionsMap.get(meta.taskId);
          if (existing) continue;
          sessionsMap.set(meta.taskId, {
            sessionId: meta.taskId,
            title: meta.title || meta.taskId,
            projectKey,
            workspacePath: ws.workspacePath,
            workspaceIdentity: ws.workspaceIdentity,
            running: meta.status === "running",
            waiting: Boolean(meta.pendingInteraction),
            failed: meta.status === "error",
            interrupted: false,
            manuallyStopped: false,
            crashCut: false,
            updatedAt: meta.updatedAt ?? Date.now(),
            model: (meta as { model?: string }).model ?? "default",
            unreadAt: null,
            goalStatus: null,
            goalObjective: null,
          });
        }
      } catch (error) {
        logger.warn("[ClearAllSessions] listTasks error for workspace", { ws, error });
      }
    }

    if (taskService?.listArchivedTasks) {
      try {
        const archivedMetas = await taskService.listArchivedTasks({
          workspacePath: ws.workspacePath,
          workspaceIdentity: ws.workspaceIdentity,
        });
        for (const meta of archivedMetas ?? []) {
          const existing = sessionsMap.get(meta.taskId);
          if (existing) continue;
          sessionsMap.set(meta.taskId, {
            sessionId: meta.taskId,
            title: meta.title || meta.taskId,
            projectKey,
            workspacePath: ws.workspacePath,
            workspaceIdentity: ws.workspaceIdentity,
            running: false,
            waiting: false,
            failed: false,
            interrupted: false,
            manuallyStopped: false,
            crashCut: false,
            updatedAt: meta.updatedAt ?? Date.now(),
            model: (meta as { model?: string }).model ?? "default",
            unreadAt: null,
            goalStatus: null,
            goalObjective: null,
          });
        }
      } catch (error) {
        logger.warn("[ClearAllSessions] listArchivedTasks error for workspace", { ws, error });
      }
    }
  }

  return planZaicodeClearAllSessions([...sessionsMap.values()], policy, context);
}

export function describeZaicodeClearAllSessions(plan: ZaicodeClearAllSessionsPlan): string {
  if (plan.totalCount === 0) {
    return "No active, queued, or completed sessions to clear.";
  }
  const lines = [
    `Found ${plan.totalCount} session(s) across ${plan.workspaces.length} project(s):`,
    `  • ${plan.idleCount} safely idle (cleared on left-click)`,
  ];
  if (plan.runningCount > 0) lines.push(`  • ${plan.runningCount} currently running (stopped on right-click)`);
  if (plan.waitingCount > 0) lines.push(`  • ${plan.waitingCount} waiting for user response (preserved on left-click)`);
  if (plan.stoppedCount > 0) lines.push(`  • ${plan.stoppedCount} interrupted or stopped`);
  if (plan.failedCount > 0) lines.push(`  • ${plan.failedCount} failed turns`);
  if (plan.completedCount > 0) lines.push(`  • ${plan.completedCount} completed sessions`);
  lines.push("Left-click: Clear idle sessions");
  lines.push("Right-click: Clear all sessions, including running");
  lines.push("Does not delete project source files or SAIPEN tasks.");
  lines.push("Does not continue old sessions.");
  return lines.join("\n");
}

export function formatZaicodeClearAllSessionsRun(run: ZaicodeClearAllSessionsRun): string {
  if (run.policy === "IDLE_ONLY") {
    const lines = [
      `Cleared: ${run.cleared} idle session${run.cleared === 1 ? "" : "s"}`,
      `Preserved: ${run.preservedActive} active session${run.preservedActive === 1 ? "" : "s"}`,
    ];
    if (run.failedOrUnreachable.length > 0) {
      lines.push(`Failed: ${run.failedOrUnreachable.length} session${run.failedOrUnreachable.length === 1 ? "" : "s"}`);
    }
    for (const problem of run.problems) {
      lines.push(problem);
    }
    return lines.join("\n");
  }

  const lines = [
    "CLEAR ALL SESSIONS",
    `Total found: ${run.totalFound}`,
    `Sessions stopped: ${run.stopped}`,
    `Sessions cleared: ${run.cleared}`,
  ];
  if (run.cancelledCommands > 0) {
    lines.push(`Cancelled commands: ${run.cancelledCommands}`);
  }
  if (run.stillActive > 0) {
    lines.push(`Still active: ${run.stillActive}`);
  }
  if (run.failedOrUnreachable.length > 0) {
    lines.push(`Failed or unreachable: ${run.failedOrUnreachable.length}`);
  }
  for (const problem of run.problems) {
    lines.push(problem);
  }
  return lines.join("\n");
}
