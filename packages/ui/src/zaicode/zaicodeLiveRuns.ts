import { useEffect, useMemo } from "react";
import { create } from "zustand";

/**
 * "This session is working right now", straight from the open chat (SRC-048).
 *
 * The sidebar learns that a session runs from the sessions-index list, a
 * conflated low-frequency projection. The operator saw a project whose open
 * session was plainly working (Stop button, streaming output) while its
 * sidebar row stayed still, and could not tell whether anything ran. The open
 * chat knows for certain (its composer can stop the turn), so it publishes
 * that fact here, and the sidebar lights a row when EITHER source says so.
 * An entry lives only while the chat is mounted and running; the list stays
 * the owner for every session nobody has open.
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

export function setZaicodeLiveRun(sessionId: string, workspacePath: string, running: boolean): void {
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

/** The open chat reports whether its turn runs; unmounting takes the report back. */
export function useZaicodePublishLiveRun(sessionId: string | null | undefined, workspacePath: string, running: boolean): void {
  useEffect(() => {
    if (!sessionId) return undefined;
    setZaicodeLiveRun(sessionId, workspacePath, running);
    return () => setZaicodeLiveRun(sessionId, workspacePath, false);
  }, [sessionId, workspacePath, running]);
}

/** True while the open chat says this session runs. */
export function useZaicodeLiveRun(sessionId: string | null | undefined): boolean {
  return useZaicodeLiveRuns((state) => Boolean(sessionId && state.runs[sessionId]));
}

/** Sessions of one project folder the open chat reports as running (stable string for the selector). */
export function zaicodeLiveRunIdsIn(runs: Readonly<Record<string, ZaicodeLiveRun>>, workspacePath: string): string[] {
  const folder = zaicodeLiveRunFolderKey(workspacePath);
  return Object.keys(runs)
    .filter((id) => runs[id]!.folder === folder)
    .sort();
}

export function useZaicodeLiveRunIds(workspacePath: string): string[] {
  const joined = useZaicodeLiveRuns((state) => zaicodeLiveRunIdsIn(state.runs, workspacePath).join("\n"));
  return useMemo(() => (joined ? joined.split("\n") : []), [joined]);
}
