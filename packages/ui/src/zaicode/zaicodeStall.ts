import type { ZCodeTaskMeta } from "@zcode/shared";
import { getTaskListRowActivity, isTaskListRowActive } from "@/v4/taskListRowActivity.js";

/**
 * SRC-081: "I left AUDAPACK for the night; it says it is still working, but it is not."
 *
 * A session the feed calls active (a turn in flight, or background work attached) whose last
 * activity is hours old is not working: its provider stream hung, its background job forgot to
 * report, or its process died without a word. It kept counting as working, with a clock
 * running all night, and every "is anything still going" answer (the row's working badge,
 * the header meter, the ambience) said yes.
 *
 * Such a session is STALLED: still listed, still one click from opening, but no longer counted
 * as working, and the row says so instead of showing a clock that lies.
 */

/** No activity for this long while "running" is a stall, not a long tool call. */
export const ZAICODE_STALL_MS = 45 * 60 * 1000;

/** When the feed last heard from the session (ms), 0 when it never did. */
export function zaicodeSessionLastHeard(task: ZCodeTaskMeta): number {
  const activityAt = getTaskListRowActivity(task)?.lastActivityAt;
  if (typeof activityAt === "number" && activityAt > 0) return activityAt;
  return typeof task.updatedAt === "number" ? task.updatedAt : 0;
}

export function zaicodeSessionStalled(task: ZCodeTaskMeta, now: number, stallMs: number = ZAICODE_STALL_MS): boolean {
  if (!isTaskListRowActive(task)) return false;
  // 安静的长工具/测试仍有 runtime 活性证明；时间本身不能推翻执行事实。
  const activity = getTaskListRowActivity(task);
  if (activity?.sessionEnded !== undefined || activity?.hasBackgroundWork) return false;
  const last = zaicodeSessionLastHeard(task);
  return last > 0 && now - last > stallMs;
}

/** Working for real: active in the feed AND heard from lately. */
export function zaicodeSessionWorking(task: ZCodeTaskMeta, now: number): boolean {
  return isTaskListRowActive(task) && !zaicodeSessionStalled(task, now);
}
