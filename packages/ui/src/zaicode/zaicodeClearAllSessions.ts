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
import {
  type ZaicodeClearPolicy,
  type SessionIdleCheckContext,
  type ZaicodeClearAllSessionsPlan,
  type ZaicodeClearAllSessionsRun,
  isSessionSafelyIdle,
} from "./zaicodeClearAllSessionsPlan.js";

export * from "./zaicodeClearAllSessionsPlan.js";

/**
 * CLEAR ALL SESSIONS Coordinator (PART 2, 3, 4, 5, 6).
 *
 * Ordered operation supporting dual-mode cleanup:
 * - IDLE_ONLY: Filter authoritatively idle sessions, leaving active work uninterrupted.
 * - ALL_SESSIONS: Complete clean slate with confirmed stop and command cancellation.
 */
export interface ZaicodeClearAllSessionsDeps {
  plan: ZaicodeClearAllSessionsPlan;
  policy?: ZaicodeClearPolicy;
  context?: SessionIdleCheckContext;
  resolveHandle?: (projectKey: string, workspacePath: string, workspaceIdentity?: string) => ZaicodeProjectContinueHandle | null;
  taskService?: Pick<IZCodeTaskService, "deleteTask" | "deleteTasks" | "deleteArchivedTasks" | "listArchivedTasks" | "cancelTaskCommand" | "listTasks">;
  sessionDataLayer?: { clearWarmPool?: () => void; invalidateSession?: (sessionId: string) => void };
  remaining?: () => readonly ZaicodeSessionBrief[];
  onDeselectActiveSession?: () => void;
  revalidateSafelyIdle?: (session: ZaicodeSessionBrief) => boolean;
}

export async function runZaicodeClearAllSessions(
  deps: ZaicodeClearAllSessionsDeps,
): Promise<ZaicodeClearAllSessionsRun> {
  const { plan } = deps;
  const policy: ZaicodeClearPolicy = deps.policy ?? plan.policy ?? "ALL_SESSIONS";
  const idleContext = deps.context;
  const epoch = startZaicodeCleanupEpoch();

  let stopped = 0;
  let cancelledCommands = 0;
  let cleared = 0;
  let preservedActive = 0;
  const failedOrUnreachable: string[] = [];
  const problems: string[] = [];

  try {
    if (policy === "IDLE_ONLY") {
      // 1. LEFT CLICK — CLEAR IDLE
      // Filter authoritatively idle sessions only; live agents are never stopped or interrupted
      const targetSessions: ZaicodeSessionBrief[] = [];
      for (const session of plan.sessions) {
        if (isSessionSafelyIdle(session, idleContext)) {
          targetSessions.push(session);
        } else {
          preservedActive++;
        }
      }

      // Clear retry/goal state for idle sessions without touching active sessions
      for (const session of targetSessions) {
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
      }

      // Group targets by workspace with immediate revalidation before deletion (TOCTOU safety)
      const byWorkspace = new Map<
        string,
        { workspacePath: string; workspaceIdentity?: string; projectKey: string; taskIds: string[] }
      >();

      for (const session of targetSessions) {
        const isStillIdle = deps.revalidateSafelyIdle
          ? deps.revalidateSafelyIdle(session)
          : isSessionSafelyIdle(session, idleContext);
        if (!isStillIdle) {
          preservedActive++;
          continue;
        }

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

            // In IDLE_ONLY mode, retire MAIN pointer ONLY if the MAIN session itself was deleted!
            const mainSessionId = useZaicodeMainSessions.getState().byWorkspace[group.projectKey] ??
                                  useZaicodeMainSessions.getState().byWorkspace[workspaceKey];
            if (mainSessionId && res.deletedTaskIds.includes(mainSessionId)) {
              useZaicodeMainSessions.getState().clearMain(group.projectKey);
              useZaicodeMainSessions.getState().clearMain(workspaceKey);
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
              const mainSessionId = useZaicodeMainSessions.getState().byWorkspace[group.projectKey] ??
                                    useZaicodeMainSessions.getState().byWorkspace[workspaceKey];
              if (mainSessionId === taskId) {
                useZaicodeMainSessions.getState().clearMain(group.projectKey);
                useZaicodeMainSessions.getState().clearMain(workspaceKey);
              }
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
      }

      if (cleared > 0) {
        deps.sessionDataLayer?.clearWarmPool?.();
        deps.onDeselectActiveSession?.();
      }
    } else {
      // 2. RIGHT CLICK — CLEAR EVERYTHING (ALL_SESSIONS)
      // Terminate running executions and clear background ownership
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

      // Batch delete tasks by workspace
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
    }
  } finally {
    releaseZaicodeCleanupEpoch(epoch);
  }

  const remainingBriefs = deps.remaining ? deps.remaining() : [];

  return {
    policy,
    totalFound: plan.totalCount,
    stopped,
    cancelledCommands,
    cleared,
    preservedActive,
    stillActive: remainingBriefs.length,
    failedOrUnreachable,
    problems,
  };
}
