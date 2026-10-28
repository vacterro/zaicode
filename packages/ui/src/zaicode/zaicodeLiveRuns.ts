import { useEffect, useMemo } from "react";
import { create } from "zustand";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { getTaskListRowActivity, isTaskListRowActive } from "../v4/taskListRowActivity.js";

/**
 * "This session is working right now", straight from the open chat (SRC-048).
 *
 * The sidebar learns that a session runs from the sessions-index list, a
 * conflated low-frequency projection. The operator saw a project whose open
 * session was plainly working (Stop button, streaming output) while its
 * sidebar row stayed still, and could not tell whether anything ran. The open
 * chat knows for certain (its composer can stop the turn), so it publishes
 * that fact here, and the sidebar lights a row when EITHER source says so.
 * A view disappearing does not stop execution. Keep its last running report
 * until the conversation or a newer authoritative index reports completion.
 */

interface ZaicodeLiveRun {
  /** Folder key (see zaicodeLiveRunFolderKey). */
  folder: string;
  since: number;
}

interface ZaicodeLiveRunsState {
  runs: Record<string, ZaicodeLiveRun>;
}

export const useZaicodeLiveRuns = create<ZaicodeLiveRunsState>(() => ({ runs: {} }));

/** Windows paths compare without case and slash style. */
export function zaicodeLiveRunFolderKey(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function setZaicodeLiveRun(
  sessionId: string,
  workspacePath: string,
  running: boolean,
): void {
  const { runs } = useZaicodeLiveRuns.getState();
  if (running) {
    const folder = zaicodeLiveRunFolderKey(workspacePath);
    if (runs[sessionId]?.folder === folder) return;
    useZaicodeLiveRuns.setState({ runs: { ...runs, [sessionId]: { folder, since: Date.now() } } });
    return;
  }
  if (!runs[sessionId]) return;
  const next = { ...runs };
  delete next[sessionId];
  useZaicodeLiveRuns.setState({ runs: next });
}

/** Runtime death/replacement invalidates view reports; view unmount does not. */
export function clearZaicodeLiveRunsIn(workspacePath: string): void {
  const { runs } = useZaicodeLiveRuns.getState();
  const folder = zaicodeLiveRunFolderKey(workspacePath);
  const next = Object.fromEntries(Object.entries(runs).filter(([, run]) => run.folder !== folder));
  if (Object.keys(next).length !== Object.keys(runs).length) useZaicodeLiveRuns.setState({ runs: next });
}

/**
 * The sessions-index is a conflated low-frequency projection, so a claim can briefly sit
 * ahead of it — that is the entire reason this hint exists (SRC-048). But it is a *hint*,
 * never a claim that outlives the evidence: while the index has not been heard from at or
 * after the claim, the hint is trusted only for this long, and then it expires. A dead
 * runtime that never advances the session again therefore cannot pin the row as working
 * until the next app restart (SRC-161:REQ-006).
 */
export const ZAICODE_LIVE_RUN_INDEX_GRACE_MS = 60 * 1000;

/** How often the sidebar re-asks reconcileZaicodeLiveRuns while any hint is held (SRC-162). */
export const ZAICODE_LIVE_RUN_RECONCILE_MS = 15 * 1000;

export function reconcileZaicodeLiveRuns(
  tasks: readonly ZCodeTaskMeta[],
  now: number = Date.now(),
): void {
  const { runs } = useZaicodeLiveRuns.getState();
  if (Object.keys(runs).length === 0) return;
  // An empty projection is "nothing observed", not "observed absent": never let a transient
  // empty list wipe every hint.
  if (tasks.length === 0) return;
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  let next: Record<string, ZaicodeLiveRun> | null = null;
  for (const [sessionId, run] of Object.entries(runs)) {
    const task = byId.get(sessionId);
    const activity = task ? getTaskListRowActivity(task) : null;
    // Once the index has been heard from for this session (lastActivityAt at or after the
    // claim) it decides alone — agreement keeps the row working on the index's own evidence,
    // disagreement clears the hint at once. Requiring `lastActivityAt < run.since` to *keep*
    // the hint, as this did before, made "the runtime died right after the chat claimed a
    // run" an unbounded exemption: nothing ever moved that timestamp again.
    const keep =
      activity && activity.lastActivityAt >= run.since
        ? task !== undefined && isTaskListRowActive(task)
        : now - run.since <= ZAICODE_LIVE_RUN_INDEX_GRACE_MS;
    if (keep) continue;
    next ??= { ...runs };
    delete next[sessionId];
  }
  if (next) useZaicodeLiveRuns.setState({ runs: next });
}

/** Releasing a view lease must not publish a false stop. */
export function useZaicodePublishLiveRun(
  sessionId: string | null | undefined,
  workspacePath: string,
  running: boolean,
): void {
  useEffect(() => {
    if (!sessionId) return undefined;
    setZaicodeLiveRun(sessionId, workspacePath, running);
  }, [sessionId, workspacePath, running]);
}

/** True while the open chat says this session runs. */
export function useZaicodeLiveRun(sessionId: string | null | undefined): boolean {
  return useZaicodeLiveRuns((state) => Boolean(sessionId && state.runs[sessionId]));
}

/** Sessions of one project folder the open chat reports as running (stable string for the selector). */
export function zaicodeLiveRunIdsIn(
  runs: Readonly<Record<string, ZaicodeLiveRun>>,
  workspacePath: string,
): string[] {
  const folder = zaicodeLiveRunFolderKey(workspacePath);
  return Object.keys(runs)
    .filter((id) => runs[id]!.folder === folder)
    .sort();
}

export function useZaicodeLiveRunIds(workspacePath: string): string[] {
  const joined = useZaicodeLiveRuns((state) =>
    zaicodeLiveRunIdsIn(state.runs, workspacePath).join("\n"),
  );
  return useMemo(() => (joined ? joined.split("\n") : []), [joined]);
}
