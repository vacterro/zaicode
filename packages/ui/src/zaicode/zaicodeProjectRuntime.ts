import {
  zaicodeProjectRuntimeState,
  ZAICODE_RUNTIME_STATE_COLOR,
  type ZaicodeProjectRuntimeSnapshot,
  type ZaicodeProjectRuntimeVerdict,
  type ZaicodeSaipenProjection,
} from "@zcode/shared";
import type { ZaicodeSaipenSnapshot } from "./zaicodeSaipenModel.js";
import { useZaicodeSessionNav, type ZaicodeSessionRef } from "./zaicodeSessionNav.js";
import { useZaicodeRunningSessions, type ZaicodeRunningSession } from "./zaicodeSidebarPrefs.js";
import { useZaicodeWorkersSelector, type ZaicodeWorker } from "./zaicodeWorkers.js";

/**
 * Renderer half of the System Read Model (T-41): one ProjectRuntimeSnapshot
 * per project, assembled from the owners' facts (SAIPEN projection, running
 * and waiting sessions, workers), and the one verdict every surface shows.
 */

/** Windows paths compare case-insensitively and without a trailing separator. */
export function sameZaicodeProjectPath(left: string | undefined | null, right: string | undefined | null): boolean {
  if (!left || !right) return false;
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(left) === norm(right);
}

/** SAIPEN's projection when it answered, else a file-derived stand-in marked `source: "files"`. */
export function zaicodeProtocolOf(saipen: ZaicodeSaipenSnapshot | null): ZaicodeSaipenProjection | null {
  if (!saipen) return null;
  if (saipen.projection) return saipen.projection;
  return {
    source: "files",
    protocolVersion: null,
    phase: saipen.phase,
    task: saipen.task,
    nextAction: saipen.nextAction,
    blocker: saipen.blocker,
    claimedTicket: saipen.doing?.id ?? null,
    topWorkableTicket: saipen.nextTicket?.id ?? null,
    closureComplete: null,
    recoveryPending: false,
    boardErrors: 0,
    parkedWork: [],
    unreadTelegrams: null,
    readAt: 0,
    error: null,
  };
}

/** Sessions of `projectPath` in a published list (running / waiting). */
function countZaicodeSessionsIn(list: readonly Pick<ZaicodeSessionRef, "workspacePath">[], projectPath: string): number {
  return list.filter((session) => sameZaicodeProjectPath(session.workspacePath, projectPath)).length;
}

/** Live workers (any kind) of `projectPath`. */
function countZaicodeWorkersIn(workers: readonly Pick<ZaicodeWorker, "projectPath" | "exitCode">[], projectPath: string): number {
  return workers.filter((worker) => worker.exitCode === null && sameZaicodeProjectPath(worker.projectPath, projectPath)).length;
}

function zaicodeProjectRuntimeSnapshot(input: {
  projectPath: string;
  projectIdentity?: string;
  saipen: ZaicodeSaipenSnapshot | null;
  running: number;
  waiting: number;
  workers: number;
}): ZaicodeProjectRuntimeSnapshot {
  const { saipen } = input;
  return {
    project: { path: input.projectPath, ...(input.projectIdentity ? { identity: input.projectIdentity } : {}) },
    protocol: zaicodeProtocolOf(saipen),
    board: saipen ? { ...saipen.counts } : null,
    owner: saipen?.owner ?? null,
    generation: saipen?.generation ?? null,
    sessions: { running: input.running, waiting: input.waiting },
    workers: { running: input.workers },
    engines: null,
    messages: null,
  };
}

export function assembleZaicodeProjectRuntime(input: {
  projectPath: string;
  projectIdentity?: string;
  saipen: ZaicodeSaipenSnapshot | null;
  running: readonly Pick<ZaicodeRunningSession, "workspacePath">[];
  waiting: readonly Pick<ZaicodeSessionRef, "workspacePath">[];
  workers: readonly Pick<ZaicodeWorker, "projectPath" | "exitCode">[];
}): ZaicodeProjectRuntimeSnapshot {
  return zaicodeProjectRuntimeSnapshot({
    projectPath: input.projectPath,
    ...(input.projectIdentity ? { projectIdentity: input.projectIdentity } : {}),
    saipen: input.saipen,
    running: countZaicodeSessionsIn(input.running, input.projectPath),
    waiting: countZaicodeSessionsIn(input.waiting, input.projectPath),
    workers: countZaicodeWorkersIn(input.workers, input.projectPath),
  });
}

export interface ZaicodeSaipenHeadline {
  phase: string | null;
  task: string | null;
  nextAction: string | null;
  blocker: string | null;
  nextTicket: { id: string; title: string } | null;
}

/**
 * What the SAIPEN lines of a surface print: SAIPEN's projection when it
 * answered (its computed next action, its blocker, its top workable ticket),
 * else the STATE/BOARD parse. Titles still come from BOARD (display only).
 */
export function zaicodeSaipenHeadline(saipen: ZaicodeSaipenSnapshot | null): ZaicodeSaipenHeadline | null {
  if (!saipen) return null;
  const projection = saipen.projection;
  if (!projection || projection.source !== "saipen") {
    return {
      phase: saipen.phase,
      task: saipen.task,
      nextAction: saipen.nextAction,
      blocker: saipen.blocker,
      nextTicket: saipen.nextTicket ? { id: saipen.nextTicket.id, title: saipen.nextTicket.title } : null,
    };
  }
  const titleOf = (id: string) =>
    saipen.detail?.tickets.find((ticket) => ticket.id === id)?.title ??
    [saipen.doing, saipen.nextTicket].find((ticket) => ticket?.id === id)?.title ??
    "";
  const next = projection.topWorkableTicket && projection.topWorkableTicket !== projection.claimedTicket ? projection.topWorkableTicket : null;
  return {
    phase: projection.phase,
    task: projection.task,
    nextAction: projection.nextAction,
    blocker: projection.blocker,
    nextTicket: next ? { id: next, title: titleOf(next) } : null,
  };
}

export interface ZaicodeProjectRuntimeView {
  snapshot: ZaicodeProjectRuntimeSnapshot;
  verdict: ZaicodeProjectRuntimeVerdict;
  color: string | null;
}

export function viewZaicodeProjectRuntime(snapshot: ZaicodeProjectRuntimeSnapshot): ZaicodeProjectRuntimeView {
  const verdict = zaicodeProjectRuntimeState(snapshot);
  return { snapshot, verdict, color: ZAICODE_RUNTIME_STATE_COLOR[verdict.state] };
}

/** The read model of one project for a component that already has its SAIPEN snapshot. */
export function useZaicodeProjectRuntime(
  projectPath: string,
  projectIdentity: string | undefined,
  saipen: ZaicodeSaipenSnapshot | null,
): ZaicodeProjectRuntimeView | null {
  // Counts, not lists: every project row runs this hook, and a new list from any project
  // (streaming activity, a worker window drag) used to re-render all of them (SRC-043).
  const running = useZaicodeRunningSessions((state) => countZaicodeSessionsIn(state.sessions, projectPath));
  const waiting = useZaicodeSessionNav((state) => countZaicodeSessionsIn(state.waiting, projectPath));
  const workers = useZaicodeWorkersSelector((state) => countZaicodeWorkersIn(state.workers, projectPath));
  if (!projectPath) return null;
  return viewZaicodeProjectRuntime(
    zaicodeProjectRuntimeSnapshot({
      projectPath,
      ...(projectIdentity ? { projectIdentity } : {}),
      saipen,
      running,
      waiting,
      workers,
    }),
  );
}
