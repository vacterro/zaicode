import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  getTaskListRowActivity,
  isTaskListRowActive,
  type TaskListRowActivity,
} from "@/v4/taskListRowActivity.js";

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
 *
 * Liveness is evidence, never a recorded claim. The one piece of evidence the client has is
 * `lastActivityAt` (= the runtime's `record.updatedAt`): every real progress event of the turn
 * *or* of an attached background job advances it, because background bash output, subagent
 * progress and dynamic-workflow run events all ride the session event stream
 * (see server-operations.ts: a non-configuration SessionEvent bumps record.updatedAt).
 * So "hasBackgroundWork === true" is a claim the session made in the past, and the clock since
 * the last real event is what decides whether that claim is still supported. Silence longer
 * than the window means the claim is no longer supported — the session did not necessarily
 * die, but nothing on the wire proves it is alive, and pretending otherwise is the bug.
 */

/** No activity for this long while a turn is in flight is a stall, not a long tool call. */
export const ZAICODE_STALL_MS = 45 * 60 * 1000;

/**
 * Same judgement for a session whose only claim is attached background work. A detached job
 * is legitimately quieter than a foreground tool call (a compile, a test run, a workflow can
 * go a long time between progress events), so it gets a longer window — but a *bounded* one.
 * A session that keeps working keeps advancing lastActivityAt and never reaches this window,
 * however many hours it runs; only a job that has said nothing at all is treated as unproven.
 * This is deliberately not a "running for > N minutes => dead" rule: total runtime is
 * irrelevant here, only the gap since the last proved-alive moment.
 *
 * Why five hours and not two: the accepted operator contract is that a quiet background test
 * still counts as working after five hours (zaicodeEfficientAutomation.test.ts, "quiet live
 * background tests are working after five hours"), and the real zombie this repair was opened
 * for read "TEST 5h 16m" in the sidebar. The window therefore has to sit inside that gap: a
 * silent job stays live through the fifth hour and stops being counted as working after it.
 * A shorter window would reap the legitimate case the operator already accepted; an unbounded
 * one is the defect ("attached background work" was permanent immunity).
 *
 * Ceiling: with no heartbeat field in backgroundWorkSummarySchema this is the best available
 * evidence. Upgrading the protocol with a runtime-emitted per-work heartbeat would replace the
 * window with a live signal; a UI-side fake heartbeat must not be invented instead.
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
  return activity?.hasBackgroundWork === true ? Math.max(baseMs, ZAICODE_BACKGROUND_STALL_MS) : baseMs;
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

export function zaicodeSessionStalled(task: ZCodeTaskMeta, now: number, stallMs: number = ZAICODE_STALL_MS): boolean {
  if (!isTaskListRowActive(task)) return false;
  return zaicodeActivityStalled(getTaskListRowActivity(task), zaicodeSessionLastHeard(task), now, stallMs);
}

/** Working for real: active in the feed AND heard from lately. */
export function zaicodeSessionWorking(task: ZCodeTaskMeta, now: number): boolean {
  return isTaskListRowActive(task) && !zaicodeSessionStalled(task, now);
}
