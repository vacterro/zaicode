import type { IZCodeTaskService } from "@zcode/services";
import { logger } from "@/logger.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  startZaicodeCleanupEpoch,
  releaseZaicodeCleanupEpoch,
  retireSessions,
} from "./zaicodeCleanupFence.js";
import { type ZaicodeSessionBrief, type ZaicodeProjectContinueHandle } from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import { stopZaicodeGoalIntents } from "./zaicodeGoalSupervisor.js";
import { useZaicodeRetryLedger, clearZaicodeQuotaWall } from "./zaicodeRetryPolicy.js";
import { useZaicodeMainSessions } from "./zaicodeMainSession.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

/**
 * CLEAR ALL SESSIONS Coordinator (PART 2, 3, 4, 5, 6).
 *
 * Replaces the old misleading cleanup behavior with a genuine operator-controlled
 * Clean Slate. Discards all existing ZAICODE sessions (finished, failed, blocked,
 * waiting, interrupted, running, helper, and MAIN) across all selected workspaces.
 *
 * Ordered operation:
 * 1. Establish an operator-requested cleanup epoch & fence background continuation.
 * 2. Enumerate authoritative sessions without status-based exclusions.
 * 3. Stop foreground execution and await termination acknowledgement.
 * 4. Stop background continuation / retry / goal ownership.
 * 5. Apply persistent removal and tombstones without O(N) event storms.
 * 6. Retire stored MAIN pointers so fresh work gets new session identity.
 * 7. Reconcile subscriptions, navigation, and release cleanup fence.
 */

export interface ZaicodeClearAllSessionsPlan {
  totalCount: number;
  runningCount: number;
  stoppedCount: number;
  waitingCount: number;
  failedCount: number;
  completedCount: number;
  sessions: readonly ZaicodeSessionBrief[];
  workspaces: readonly { workspacePath: string; workspaceIdentity?: string; projectKey: string }[];
}

export interface ZaicodeClearAllSessionsRun {
  totalFound: number;
  stopped: number;
  cancelledCommands: number;
  cleared: number;
  stillActive: number;
  failedOrUnreachable: string[];
  problems: string[];
}

export function planZaicodeClearAllSessions(
  sessions: readonly ZaicodeSessionBrief[],
): ZaicodeClearAllSessionsPlan {
  let runningCount = 0;
  let waitingCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  let stoppedCount = 0;

  const workspaceMap = new Map<string, { workspacePath: string; workspaceIdentity?: string; projectKey: string }>();

  for (const session of sessions) {
    if (session.running) runningCount++;
    else if (session.waiting) waitingCount++;
    else if (session.failed) failedCount++;
    else if (session.manuallyStopped || session.interrupted || session.crashCut) stoppedCount++;
    else completedCount++;

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
    sessions,
    workspaces: [...workspaceMap.values()],
  };
}

export interface AuthoritativeClearPlanOptions {
  workspaces: readonly { workspacePath: string; workspaceIdentity?: string; projectKey?: string }[];
  taskService?: Pick<IZCodeTaskService, "listTasks" | "listArchivedTasks">;
  fallbackSessions?: readonly ZaicodeSessionBrief[];
}

export async function collectAuthoritativeClearAllSessionsPlan(
  options: AuthoritativeClearPlanOptions,
): Promise<ZaicodeClearAllSessionsPlan> {
  const { workspaces, taskService, fallbackSessions = [] } = options;
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

  return planZaicodeClearAllSessions([...sessionsMap.values()]);
}

export function describeZaicodeClearAllSessions(plan: ZaicodeClearAllSessionsPlan): string {
  if (plan.totalCount === 0) {
    return "No active, queued, or completed sessions to clear.";
  }
  const lines = [
    `Found ${plan.totalCount} session(s) across ${plan.workspaces.length} project(s):`,
  ];
  if (plan.runningCount > 0) lines.push(`  • ${plan.runningCount} currently running (will be stopped)`);
  if (plan.waitingCount > 0) lines.push(`  • ${plan.waitingCount} waiting for user response`);
  if (plan.stoppedCount > 0) lines.push(`  • ${plan.stoppedCount} interrupted or stopped`);
  if (plan.failedCount > 0) lines.push(`  • ${plan.failedCount} failed turns`);
  if (plan.completedCount > 0) lines.push(`  • ${plan.completedCount} completed sessions`);
  lines.push("Clears completed and unfinished sessions.");
  lines.push("Running work will be stopped.");
  lines.push("Does not delete project source files or SAIPEN tasks.");
  lines.push("Does not continue old sessions.");
  return lines.join("\n");
}

export interface ZaicodeClearAllSessionsDeps {
  plan: ZaicodeClearAllSessionsPlan;
  resolveHandle?: (projectKey: string, workspacePath: string, workspaceIdentity?: string) => ZaicodeProjectContinueHandle | null;
  taskService?: Pick<IZCodeTaskService, "deleteTask" | "deleteTasks" | "deleteArchivedTasks" | "listArchivedTasks" | "cancelTaskCommand" | "listTasks">;
  sessionDataLayer?: { clearWarmPool?: () => void; invalidateSession?: (sessionId: string) => void };
  remaining?: () => readonly ZaicodeSessionBrief[];
  onDeselectActiveSession?: () => void;
}

export async function runZaicodeClearAllSessions(
  deps: ZaicodeClearAllSessionsDeps,
): Promise<ZaicodeClearAllSessionsRun> {
  const { plan } = deps;
  const epoch = startZaicodeCleanupEpoch();

  let stopped = 0;
  let cancelledCommands = 0;
  let cleared = 0;
  const failedOrUnreachable: string[] = [];
  const problems: string[] = [];

  try {
    // 1. Terminate running executions and clear background ownership
    for (const session of plan.sessions) {
      try {
        stopZaicodeGoalIntents(session.projectKey, session.sessionId);
      } catch (error) {
        logger.warn("[ClearAllSessions] stopZaicodeGoalIntents error", { sessionId: session.sessionId, error });
      }

      try {
        useZaicodeRetryLedger.getState().clear(session.sessionId);
        clearZaicodeQuotaWall(session.sessionId);
      } catch (error) {
        logger.warn("[ClearAllSessions] retry ledger clear error", { sessionId: session.sessionId, error });
      }

      try {
        const pendingCommands = pendingCommandRegistry.list(session.sessionId);
        for (const cmd of pendingCommands) {
          if (deps.taskService?.cancelTaskCommand) {
            try {
              const res = await deps.taskService.cancelTaskCommand({
                workspacePath: session.workspacePath,
                workspaceIdentity: session.workspaceIdentity,
                taskId: session.sessionId,
                commandId: cmd.commandId,
                clientMode: "desktop-continuous",
              });
              if (res?.canceled) {
                pendingCommandRegistry.settle(session.sessionId, cmd.commandId);
                cancelledCommands++;
              } else if (res?.reason === "already_running") {
                problems.push(`Command ${cmd.commandId} in session ${session.sessionId} is already running; cancellation not accepted`);
              } else {
                problems.push(`Command ${cmd.commandId} in session ${session.sessionId} cancellation unconfirmed: ${res?.reason ?? "unknown"}`);
              }
            } catch (error) {
              const msg = error instanceof Error ? error.message : String(error);
              problems.push(`Host cancel failed for command ${cmd.commandId}: ${msg}`);
            }
          } else {
            pendingCommandRegistry.settle(session.sessionId, cmd.commandId);
            cancelledCommands++;
          }
        }
      } catch (error) {
        logger.warn("[ClearAllSessions] pendingCommandRegistry settle error", { sessionId: session.sessionId, error });
      }

      if (session.running) {
        const handle = deps.resolveHandle
          ? deps.resolveHandle(session.projectKey, session.workspacePath, session.workspaceIdentity)
          : zaicodeContinueHandleFor({
              key: session.projectKey,
              path: session.workspacePath,
              identity: session.workspaceIdentity,
            });

        if (!handle) {
          problems.push(`No host connection for ${session.title} (${session.sessionId}); termination unacknowledged`);
          failedOrUnreachable.push(session.sessionId);
          continue;
        }

        try {
          await handle.stop(session.sessionId, session.foregroundExecutionId);
          stopped++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          problems.push(`Failed to stop ${session.title}: ${msg}`);
          failedOrUnreachable.push(session.sessionId);
        }
      }
    }

    // 2. Batch delete tasks by workspace, avoiding O(N) event storms
    const byWorkspace = new Map<
      string,
      { workspacePath: string; workspaceIdentity?: string; projectKey: string; taskIds: string[] }
    >();

    for (const session of plan.sessions) {
      if (failedOrUnreachable.includes(session.sessionId)) continue;
      const key = buildTaskWorkspaceKey(session.workspacePath, session.workspaceIdentity);
      const entry = byWorkspace.get(key) ?? {
        workspacePath: session.workspacePath,
        workspaceIdentity: session.workspaceIdentity,
        projectKey: session.projectKey,
        taskIds: [],
      };
      entry.taskIds.push(session.sessionId);
      byWorkspace.set(key, entry);
    }

    for (const [workspaceKey, group] of byWorkspace) {
      if (group.taskIds.length === 0) continue;

      if (deps.taskService?.deleteTasks) {
        try {
          const res = await deps.taskService.deleteTasks({
            workspacePath: group.workspacePath,
            workspaceIdentity: group.workspaceIdentity,
            taskIds: group.taskIds,
          });
          cleared += res.deletedTaskIds.length;
          retireSessions(res.deletedTaskIds);
          if (deps.sessionDataLayer?.invalidateSession) {
            for (const id of res.deletedTaskIds) {
              deps.sessionDataLayer.invalidateSession(id);
            }
          }
          for (const failedId of res.failedTaskIds) {
            failedOrUnreachable.push(failedId);
            problems.push(`Deletion failed for session ${failedId}`);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          problems.push(`Batch deletion failed in ${group.workspacePath}: ${msg}`);
          failedOrUnreachable.push(...group.taskIds);
        }
      } else if (deps.taskService?.deleteTask) {
        for (const taskId of group.taskIds) {
          try {
            await deps.taskService.deleteTask({
              workspacePath: group.workspacePath,
              workspaceIdentity: group.workspaceIdentity,
              taskId,
            });
            cleared++;
            retireSessions([taskId]);
            deps.sessionDataLayer?.invalidateSession?.(taskId);
          } catch (error) {
            logger.warn("Deletion failed for session", { taskId, error });
            failedOrUnreachable.push(taskId);
            problems.push(`Deletion failed for session ${taskId}`);
          }
        }
      } else {
        for (const taskId of group.taskIds) {
          failedOrUnreachable.push(taskId);
        }
        problems.push(
          `Deletion capability unavailable for workspace ${group.workspacePath}: taskService has neither deleteTasks nor deleteTask`,
        );
      }

      if (deps.taskService?.deleteArchivedTasks && deps.taskService?.listArchivedTasks) {
        try {
          const archived = await deps.taskService.listArchivedTasks({
            workspacePath: group.workspacePath,
            workspaceIdentity: group.workspaceIdentity,
          });
          const archivedIds = (archived ?? []).map((t: { taskId: string }) => t.taskId);
          if (archivedIds.length > 0) {
            const archRes = await deps.taskService.deleteArchivedTasks({
              workspacePath: group.workspacePath,
              workspaceIdentity: group.workspaceIdentity,
              taskIds: archivedIds,
            });
            if (archRes?.deletedTaskIds?.length) {
              retireSessions(archRes.deletedTaskIds);
              if (deps.sessionDataLayer?.invalidateSession) {
                for (const id of archRes.deletedTaskIds) {
                  deps.sessionDataLayer.invalidateSession(id);
                }
              }
            }
          }
        } catch (error) {
          logger.warn("[ClearAllSessions] deleteArchivedTasks error", { workspaceKey, error });
        }
      }

      // Retire MAIN session pointer ONLY when the workspace's sessions succeeded deletion
      const anyFailedInGroup = group.taskIds.some((id) => failedOrUnreachable.includes(id));
      if (!anyFailedInGroup && group.taskIds.length > 0) {
        try {
          useZaicodeMainSessions.getState().clearMain(group.projectKey);
          useZaicodeMainSessions.getState().clearMain(workspaceKey);
        } catch (error) {
          logger.warn("[ClearAllSessions] clearMain error", { workspaceKey, error });
        }
      } else {
        problems.push(`MAIN session pointer preserved for ${group.projectKey} because one or more sessions failed deletion`);
      }
    }

    if (cleared > 0) {
      deps.sessionDataLayer?.clearWarmPool?.();
      deps.onDeselectActiveSession?.();
    }
  } finally {
    releaseZaicodeCleanupEpoch(epoch);
  }

  const remainingBriefs = deps.remaining ? deps.remaining() : [];

  return {
    totalFound: plan.totalCount,
    stopped,
    cancelledCommands,
    cleared,
    stillActive: remainingBriefs.length,
    failedOrUnreachable,
    problems,
  };
}

export function formatZaicodeClearAllSessionsRun(run: ZaicodeClearAllSessionsRun): string {
  const lines = [
    "CLEAR ALL SESSIONS",
    `Total found: ${run.totalFound}`,
    `Sessions stopped: ${run.stopped}`,
    `Sessions cleared: ${run.cleared}`,
  ];
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
