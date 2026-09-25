import type { ZCodeTaskMeta } from "@zcode/shared";
import { getTaskListAttention, getTaskListRowActivity, isTaskListRowActive } from "@/v4/taskListRowActivity.js";

/**
 * One word for where a session stands (SRC-044): the DONE inbox, CONTINUE ALL,
 * the rows and the crash auto-continue all read this, so a session cut off in
 * the middle is never offered as "finished".
 *
 * - running: the live phase says a turn (or background work) runs now;
 * - waiting: a question or permission waits for the operator;
 * - failed: the last turn ended on an error (limit, network, provider);
 * - interrupted: cut off mid-turn -- the live phase says completedInterrupted
 *   (Stop), or there is no live phase while tasks-index still says running
 *   (the agent process died: crash, kill, restart), or its goal is still open
 *   while nothing runs;
 * - done: finished and not looked at yet;
 * - idle: everything else.
 */
export type ZaicodeSessionState = "running" | "waiting" | "failed" | "interrupted" | "done" | "idle";

export function zaicodeSessionStateOf(task: ZCodeTaskMeta): ZaicodeSessionState {
  if (isTaskListRowActive(task)) return "running";
  if (getTaskListAttention(task) !== null || task.pendingInteraction) return "waiting";
  const activity = getTaskListRowActivity(task);
  if (activity ? activity.phase === "error" : task.status === "error") return "failed";
  if (zaicodeWasCutOff(task)) return "interrupted";
  return typeof task.unreadAt === "number" ? "done" : "idle";
}

/** Cut off mid-turn (see above); a finished goal or a clean last turn is not. */
export function zaicodeWasCutOff(task: ZCodeTaskMeta): boolean {
  const phase = getTaskListRowActivity(task)?.phase;
  if (phase === "running" || phase === "prewarming") return false;
  if (phase === "completedInterrupted") return true;
  // tasks-index is written when a turn starts and when it ends (a Stop ends as "completed");
  // a process that died in between leaves "running" behind, whatever the reloaded projection says.
  if (task.status === "running") return true;
  const goal = task.target?.status;
  return goal === "active" || goal === "paused";
}

export const ZAICODE_SESSION_STATE_LABEL: Record<ZaicodeSessionState, string> = {
  running: "RUNNING",
  waiting: "WAITING",
  failed: "FAILED",
  interrupted: "INTERRUPTED",
  done: "DONE",
  idle: "IDLE",
};

export const ZAICODE_INTERRUPTED_HINT =
  "INTERRUPTED: cut off mid-turn (crash, restart or Stop), not finished. ▶ continues it where it stopped.";
