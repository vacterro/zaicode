import type { ZCodeTaskMeta } from "@zcode/shared";
import { executionLivenessFresh, executionLivenessRunning } from "@zcode/shared";
import {
  getTaskListRowActivity,
  isTaskListRowActive,
  type TaskListRowActivity,
} from "@/v4/taskListRowActivity.js";

/**
 * SRC-081: "I left AUDAPACK for the night; it says it is still working, but it is not."
 *
 * T-240: runtime-owned executionLiveness is authoritative whenever present. Quiet work can
 * run for hours without transcript progress. Only a fresh positive worker/foreground lease
 * keeps it working; an expired, orphaned or unconfirmed owner remains recoverable.
 * lastActivityAt and the age windows below serve older hosts without that wire contract.
 */

/** Legacy hosts only: maximum unsupported foreground silence. */
export const ZAICODE_STALL_MS = 45 * 60 * 1000;

/**
 * Legacy hosts only: bounded background silence preserves their existing compatibility.
 * Current runtime leases bypass this heuristic; neither mounting a view nor a UI timer can
 * renew them. Do not treat this five-hour fallback as proof that a worker exited.
 */
export const ZAICODE_BACKGROUND_STALL_MS = 5 * 60 * 60 * 1000;

/** When the feed last heard from the session (ms), 0 when it never did. */
export function zaicodeSessionLastHeard(task: ZCodeTaskMeta): number {
  const activityAt = getTaskListRowActivity(task)?.lastActivityAt;
  if (typeof activityAt === "number" && activityAt > 0) return activityAt;
  return typeof task.updatedAt === "number" ? task.updatedAt : 0;
}

/** How much silence a session is allowed, given what it claims to be doing. */
export function zaicodeSessionStallWindowMs(
  activity: TaskListRowActivity | null,
  baseMs: number = ZAICODE_STALL_MS,
): number {
  return activity?.hasBackgroundWork === true
    ? Math.max(baseMs, ZAICODE_BACKGROUND_STALL_MS)
    : baseMs;
}

/**
 * Stalled from explicit activity + last-heard time. The sidecar-free form, for callers that
 * already hold the row activity (the sidebar leading indicator) instead of the task meta.
 */
export function zaicodeActivityStalled(
  activity: TaskListRowActivity | null,
  lastHeardAt: number,
  now: number,
  stallMs: number = ZAICODE_STALL_MS,
): boolean {
  if (activity?.executionLiveness) {
    const proof = activity.executionLiveness;
    return (
      !executionLivenessRunning(proof) ||
      !executionLivenessFresh(proof, activity.livenessReceivedAt, now)
    );
  }
  if (!(lastHeardAt > 0)) return false;
  // 证据是「runtime 明确说这个会话已经收口」，不是「载荷里带 sessionEnded 字段」——
  // sessions-index 的 schema 里它是必填布尔，每个真实摘要都带，所以拿「字段存在」当豁免
  // 等于这条判断永远成立：SRC-081 的 stall 从上线起就没有为任何真实会话触发过，
  // 「早就干完了却还显示 Working」正是这么来的（SRC-151:R005/R040）。
  //
  // 而且「这一轮收口了」只说明前台不再有回合：分离的后台工作本来就会活过收口的那一轮
  // （快照注释：成功轮收口后 sessionEnded 即 true）。所以豁免只在没有任何后台工作声明时
  // 成立；带后台声明的行仍按后台窗口判定，否则「已收口 + 无人收尾的后台记录」又是一条
  // 永不失效的豁免。
  if (activity?.hasBackgroundWork !== true && activity?.sessionEnded === true) return false;
  return now - lastHeardAt > zaicodeSessionStallWindowMs(activity, stallMs);
}

export function zaicodeSessionStalled(
  task: ZCodeTaskMeta,
  now: number,
  stallMs: number = ZAICODE_STALL_MS,
): boolean {
  const activity = getTaskListRowActivity(task);
  const proof = activity?.executionLiveness;
  if (proof) {
    const claimed =
      activity.phase === "running" ||
      activity.phase === "prewarming" ||
      activity.hasBackgroundWork ||
      proof.orphaned ||
      proof.unconfirmed;
    return claimed && zaicodeActivityStalled(activity, zaicodeSessionLastHeard(task), now, stallMs);
  }
  if (!isTaskListRowActive(task)) return false;
  return zaicodeActivityStalled(
    getTaskListRowActivity(task),
    zaicodeSessionLastHeard(task),
    now,
    stallMs,
  );
}

/** Working for real: active in the feed AND heard from lately. */
export function zaicodeSessionWorking(task: ZCodeTaskMeta, now: number): boolean {
  return isTaskListRowActive(task, now) && !zaicodeSessionStalled(task, now);
}
