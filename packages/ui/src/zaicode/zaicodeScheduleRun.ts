import type { ZaicodeAutostartJob, ZaicodeScheduleBeforeRun, ZaicodeScheduleOrder, ZaicodeScheduledRun } from "@zcode/shared";
import { useZaicodeHomeProjects, type ZaicodeHomeProjectRow } from "./home/ZaicodeHomeFleet.js";
import {
  ZAICODE_CONTINUE_START_OBJECTIVE,
  decideZaicodeProjectStart,
  decideZaicodeSessionContinue,
  describeZaicodeContinueCommand,
  useZaicodeSessionBriefs,
  type ZaicodeContinueCommand,
  type ZaicodeSessionBrief,
} from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import { useZaicodeMainSessions, zaicodeMainSessionKey } from "./zaicodeMainSession.js";
import { readZaicodeKnownProjects, type ZaicodeKnownProject } from "./zaicodeScheduler.js";
import { zaicodeMarkedSessionsIn } from "./zaicodeSchedulerMarks.js";
import { readZaicodeWorkers, removeZaicodeWorker, type ZaicodeWorker } from "./zaicodeWorkers.js";

/**
 * What a SCHEDULER run does in its projects (SRC-044 / SRC-046):
 * - conditions: first stop the stopgap work there (sessions on the free pool,
 *   workers of a weaker engine) or everything, and skip a project where
 *   something still runs;
 * - order: a section's projects with the most blocked / open tickets first;
 * - START (`/goal cc all`) goes into the project's MAIN session -- never a new
 *   session next to a MAIN that already exists;
 * - "only marked sessions": continue exactly the sessions the operator marked.
 */

// ---------------------------------------------------------------- pure rules

/** Blocked tickets weigh triple: they need the most attention. Unknown = -1 (last). */
export function zaicodeProblemScore(row: Pick<ZaicodeHomeProjectRow, "openTickets" | "blockedTickets"> | null | undefined): number {
  if (!row || row.openTickets === null || row.blockedTickets === null) return -1;
  return row.blockedTickets * 3 + row.openTickets;
}

export function orderZaicodeScheduleTargets(
  targets: readonly ZaicodeKnownProject[],
  rows: Readonly<Record<string, Pick<ZaicodeHomeProjectRow, "openTickets" | "blockedTickets"> | undefined>>,
  order: ZaicodeScheduleOrder,
): ZaicodeKnownProject[] {
  if (order === "list") return [...targets];
  // Equal scores: more blocked first, then the sidebar order.
  return targets
    .map((target, index) => ({
      target,
      index,
      score: zaicodeProblemScore(rows[target.key]),
      blocked: rows[target.key]?.blockedTickets ?? -1,
    }))
    .sort((left, right) => right.score - left.score || right.blocked - left.blocked || left.index - right.index)
    .map((entry) => entry.target);
}

/** The free pool (SAIFREN) and free-tier models are the stopgap; SAIOPP and subscriptions are not. */
export function zaicodeIsStopgapModel(model: string | null | undefined): boolean {
  return Boolean(model && /saifren|[:/]free\b|\bfree[-/]/i.test(model));
}

/** Rough strength of who runs the work: subscriptions > in-app > other CLIs > shells. */
export function zaicodeEngineRank(vendor: string | null | undefined): number {
  switch (vendor) {
    case "claude":
    case "codex":
      return 3;
    case "antigravity":
      return 2;
    case "zcode":
      return 1;
    default:
      return 0;
  }
}

export const ZAICODE_INAPP_RUNNER_RANK = 2;

export interface ZaicodeBeforeRunPlan {
  sessions: { projectKey: string; sessionId: string; title: string }[];
  workers: { id: string; title: string }[];
}

/** Pure: what "before it starts" stops in the target projects. */
export function planZaicodeBeforeRun(input: {
  mode: ZaicodeScheduleBeforeRun;
  runnerRank: number;
  targets: readonly Pick<ZaicodeKnownProject, "key" | "path">[];
  sessions: readonly Pick<ZaicodeSessionBrief, "sessionId" | "title" | "projectKey" | "running" | "model">[];
  workers: readonly Pick<ZaicodeWorker, "id" | "kind" | "vendor" | "exitCode" | "projectPath" | "short" | "projectName">[];
}): ZaicodeBeforeRunPlan {
  if (input.mode === "none") return { sessions: [], workers: [] };
  const keys = new Set(input.targets.map((target) => target.key));
  const paths = new Set(input.targets.map((target) => target.path.toLowerCase()));
  const all = input.mode === "stopAll";
  return {
    sessions: input.sessions
      .filter((session) => session.running && keys.has(session.projectKey) && (all || zaicodeIsStopgapModel(session.model)))
      .map((session) => ({ projectKey: session.projectKey, sessionId: session.sessionId, title: session.title })),
    workers: input.workers
      .filter(
        (worker) =>
          worker.kind === "worker" &&
          worker.exitCode === null &&
          paths.has(worker.projectPath.toLowerCase()) &&
          (all || zaicodeEngineRank(worker.vendor) < input.runnerRank),
      )
      .map((worker) => ({ id: worker.id, title: `${worker.short} · ${worker.projectName}` })),
  };
}

/** A schedule's prompt as a continue command: `/goal X` = goal X, empty = START's goal, else text. */
export function zaicodeCommandForPrompt(prompt: string): ZaicodeContinueCommand {
  const text = prompt.trim();
  if (!text) return { kind: "goal", objective: ZAICODE_CONTINUE_START_OBJECTIVE };
  const goal = /^\/goal\s+([\s\S]+)$/i.exec(text);
  return goal ? { kind: "goal", objective: goal[1]!.trim() } : { kind: "text", text };
}

// ---------------------------------------------------------------- effects

const SETTLE_AFTER_STOP_MS = 3000;

function briefs(): ZaicodeSessionBrief[] {
  return useZaicodeSessionBriefs.getState().sessions;
}

/** Stops what the condition names; returns one line per stop for the result text. */
export async function clearZaicodeBeforeRun(
  job: Pick<ZaicodeAutostartJob, "beforeRun">,
  targets: readonly ZaicodeKnownProject[],
  runnerRank: number,
): Promise<string[]> {
  const plan = planZaicodeBeforeRun({
    mode: job.beforeRun,
    runnerRank,
    targets,
    sessions: briefs(),
    workers: readZaicodeWorkers().workers,
  });
  const lines: string[] = [];
  for (const session of plan.sessions) {
    const target = targets.find((candidate) => candidate.key === session.projectKey);
    const handle = target ? zaicodeContinueHandleFor(target) : null;
    if (!handle) continue;
    await handle.stop(session.sessionId).then(
      () => lines.push(`stopped ${session.title}`),
      () => lines.push(`could not stop ${session.title}`),
    );
  }
  for (const worker of plan.workers) {
    removeZaicodeWorker(worker.id);
    lines.push(`closed ${worker.title}`);
  }
  if (lines.length > 0) await new Promise((resolve) => window.setTimeout(resolve, SETTLE_AFTER_STOP_MS));
  return lines;
}

/** Nothing runs in the project: no running session, no live CLI worker. */
export function zaicodeTargetIdle(target: ZaicodeKnownProject): boolean {
  const path = target.path.toLowerCase();
  const sessionBusy = briefs().some((session) => session.projectKey === target.key && session.running);
  const workerBusy = readZaicodeWorkers().workers.some(
    (worker) => worker.kind === "worker" && worker.exitCode === null && worker.projectPath.toLowerCase() === path,
  );
  return !sessionBusy && !workerBusy;
}

export function zaicodeHomeRows(): Record<string, ZaicodeHomeProjectRow | undefined> {
  return useZaicodeHomeProjects.getState().rows;
}

export interface ZaicodeScheduleSessionOutcome {
  lines: string[];
  runs: ZaicodeScheduledRun[];
}

/** START in MAIN: continue MAIN (or a cut-off session), a fresh MAIN only when nothing can continue. */
export async function startZaicodeInMain(job: Pick<ZaicodeAutostartJob, "prompt">, targets: readonly ZaicodeKnownProject[], now: number): Promise<ZaicodeScheduleSessionOutcome> {
  const outcome: ZaicodeScheduleSessionOutcome = { lines: [], runs: [] };
  const command = zaicodeCommandForPrompt(job.prompt);
  for (const target of targets) {
    const handle = zaicodeContinueHandleFor(target);
    if (!handle) {
      outcome.lines.push(`${target.name}: project not connected`);
      continue;
    }
    const mainKey = zaicodeMainSessionKey(target.path, target.identity);
    const mainId = useZaicodeMainSessions.getState().byWorkspace[mainKey] ?? null;
    const decision = decideZaicodeProjectStart(mainId, briefs().filter((session) => session.projectKey === target.key));
    try {
      if (decision.action === "open") {
        outcome.lines.push(`${target.name}: skipped, ${decision.why}`);
        continue;
      }
      if (decision.action === "fresh") {
        const sessionId = await handle.start(command);
        useZaicodeMainSessions.getState().setMain(mainKey, sessionId);
        outcome.runs.push({ jobId: `session:${sessionId}`, workspaceKey: target.key, at: now });
        outcome.lines.push(`${target.name}: new MAIN → ${describeZaicodeContinueCommand(command)}`);
        continue;
      }
      // A schedule's own prompt wins over the session's old goal; empty prompt = what START decided.
      const send = job.prompt.trim() ? command : decision.command;
      const sent = await handle.send(decision.sessionId, send).then(
        () => true,
        () => false,
      );
      if (!sent && !decision.makeMain) {
        // MAIN was deleted or archived: forget it and give the project a fresh MAIN instead.
        useZaicodeMainSessions.getState().clearMain(mainKey);
        const sessionId = await handle.start(command);
        useZaicodeMainSessions.getState().setMain(mainKey, sessionId);
        outcome.runs.push({ jobId: `session:${sessionId}`, workspaceKey: target.key, at: now });
        outcome.lines.push(`${target.name}: MAIN gone, new MAIN → ${describeZaicodeContinueCommand(command)}`);
        continue;
      }
      if (!sent) throw new Error(`could not continue ${decision.sessionId}`);
      if (decision.makeMain) useZaicodeMainSessions.getState().setMain(mainKey, decision.sessionId);
      outcome.runs.push({ jobId: `session:${decision.sessionId}`, workspaceKey: target.key, at: now });
      outcome.lines.push(`${target.name}: ${decision.why} → ${describeZaicodeContinueCommand(send)}`);
    } catch (error) {
      outcome.lines.push(`${target.name}: failed, ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return outcome;
}

/** "Only marked sessions": continue exactly the marked ones in the targets, nothing new. */
export async function continueZaicodeMarked(job: Pick<ZaicodeAutostartJob, "prompt">, targets: readonly ZaicodeKnownProject[], now: number): Promise<ZaicodeScheduleSessionOutcome> {
  const outcome: ZaicodeScheduleSessionOutcome = { lines: [], runs: [] };
  const known = briefs();
  for (const target of targets) {
    const handle = zaicodeContinueHandleFor(target);
    for (const mark of zaicodeMarkedSessionsIn(target.path)) {
      const brief = known.find((session) => session.sessionId === mark.sessionId);
      if (!handle) {
        outcome.lines.push(`${target.name}: project not connected`);
        break;
      }
      const decision = brief ? decideZaicodeSessionContinue(brief, zaicodeHomeRows()[target.key]?.hasSaipen ?? true) : null;
      if (decision && decision.action !== "send") {
        outcome.lines.push(`${brief?.title ?? mark.sessionId}: skipped, ${decision.why}`);
        continue;
      }
      const command = job.prompt.trim() ? zaicodeCommandForPrompt(job.prompt) : decision?.command ?? zaicodeCommandForPrompt("");
      try {
        await handle.send(mark.sessionId, command);
        outcome.runs.push({ jobId: `session:${mark.sessionId}`, workspaceKey: target.key, at: now });
        outcome.lines.push(`${brief?.title ?? mark.sessionId} → ${describeZaicodeContinueCommand(command)}`);
      } catch (error) {
        outcome.lines.push(`${brief?.title ?? mark.sessionId}: failed, ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return outcome;
}

/** Stop time for a run that is a session (not a queue job). Returns false when it is a queue job. */
export async function stopZaicodeSessionRun(run: ZaicodeScheduledRun): Promise<boolean> {
  if (!run.jobId.startsWith("session:")) return false;
  const project = readZaicodeKnownProjects().find((candidate) => candidate.key === run.workspaceKey);
  const handle = project ? zaicodeContinueHandleFor(project) : null;
  await handle?.stop(run.jobId.slice("session:".length)).catch(() => undefined);
  return true;
}
