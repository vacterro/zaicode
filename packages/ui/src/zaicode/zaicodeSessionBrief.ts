import type { ZCodeTaskGoalStatus, ZCodeTaskMeta } from "@zcode/shared";
import { getTaskListAttention, getTaskListRowActivity, isTaskListRowActive } from "@/v4/taskListRowActivity.js";
import { zaicodeWasCutOff } from "./zaicodeSessionState.js";

/** What the sidebar knows about one session: enough to decide, never the transcript. */
export interface ZaicodeSessionBrief {
  sessionId: string;
  title: string;
  projectKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  running: boolean;
  foregroundExecutionId?: string;
  foregroundStartedAt?: number;
  /** A question or permission waits for the operator. */
  waiting: boolean;
  /** The last turn ended on an error (limit, network, provider). */
  failed: boolean;
  /** Cut off mid-turn: crash, restart or Stop (SRC-044) -- never counted as DONE. */
  interrupted: boolean;
  /** The renderer observed completedInterrupted: the operator deliberately pressed Stop. */
  manuallyStopped: boolean;
  /**
   * Cut off by the process dying, not by the operator: tasks-index still says
   * "running" with nothing live, or a goal is still active with nothing running.
   * Only these continue by themselves after a crash (a Stop is deliberate).
   */
  crashCut: boolean;
  /** Last activity (tasks-index `updatedAt`). */
  updatedAt: number;
  /** The session's model (tasks-index), to tell stopgap work from the real thing. */
  model: string | null;
  /** When it finished while the operator looked elsewhere; null = seen. */
  unreadAt: number | null;
  goalStatus: ZCodeTaskGoalStatus | null;
  goalObjective: string | null;
}

export function zaicodeSessionBriefOf(
  task: ZCodeTaskMeta,
  projectKey: string,
  location: { workspacePath: string; workspaceIdentity?: string },
): ZaicodeSessionBrief {
  const activity = getTaskListRowActivity(task);
  const goal = task.target ?? null;
  const running = isTaskListRowActive(task);
  const waiting = getTaskListAttention(task) !== null || Boolean(task.pendingInteraction);
  // Same authority order as the row's leading dot: live phase first, persisted status without one.
  const failed = activity ? activity.phase === "error" : task.status === "error";
  // A real Stop is persisted as completed. After a process crash the CLI can replay the dead
  // turn as completedInterrupted while tasks-index still says running; that is crash recovery.
  const manuallyStopped =
    activity?.phase === "completedInterrupted" &&
    task.status !== "running" &&
    !activity.executionLiveness?.orphaned;
  return {
    sessionId: task.taskId,
    title: task.title || task.taskId,
    projectKey,
    workspacePath: location.workspacePath,
    ...(location.workspaceIdentity ? { workspaceIdentity: location.workspaceIdentity } : {}),
    running,
    foregroundExecutionId: activity?.foregroundExecutionId,
    foregroundStartedAt: activity?.foregroundStartedAt,
    waiting,
    failed,
    interrupted: !running && !waiting && !failed && zaicodeWasCutOff(task),
    manuallyStopped,
    // The process died: tasks-index never got the turn's end (a Stop ends as "completed"), or a goal was still active.
    crashCut:
      !manuallyStopped &&
      !running &&
      !waiting &&
      (task.status === "running" ||
        goal?.status === "active" ||
        Boolean(activity?.executionLiveness && zaicodeWasCutOff(task))),
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : 0,
    model: task.model?.trim() || null,
    unreadAt: typeof task.unreadAt === "number" ? task.unreadAt : null,
    goalStatus: goal?.status ?? null,
    goalObjective: goal?.objective?.trim() || null,
  };
}

