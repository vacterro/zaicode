import { useEffect, useSyncExternalStore } from "react";
import { notifyZaicode } from "./zaicodeNotifications.js";
import {
  createUuid,
  evaluateZaicodeAutostartJob,
  normalizeZaicodeAutostartJobs,
  resolveWorkspaceKey,
  zaicodeAutostartWatchedEngine,
  zaicodeJobTaskText,
  zaicodeScheduleStopAt,
  type ZaicodeAgentDefinition,
  type ZaicodeAutostartDecision,
  type ZaicodeAutostartJob,
  type ZaicodeScheduledRun,
} from "@zcode/shared";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { projectNameOf, readZaicodeEnginesState } from "./zaicodeEngines.js";
import { launchZaicodeWorker } from "./zaicodeWorkers.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";
import { ZAICODE_SAIPEN_START_COMMAND, useZaicodeFreshSession } from "./zaicodeSaipen.js";
import { readZaicodeKnownProjects, zaicodeRunsToStop, zaicodeScheduleTargets, type ZaicodeKnownProject } from "./zaicodeScheduler.js";
import { useZaicodeSidebarPrefs } from "./zaicodeSidebarPrefs.js";
import { readZaicodeDefaultModel } from "./zaicodeDefaultModel.js";
import type { ZaicodeServices } from "./zaicodeServices.js";
import { isZaicodeProjectDisabled, syncZaicodeDisabledProjects } from "./zaicodeProjectSwitch.js";
import {
  ZAICODE_INAPP_RUNNER_RANK,
  clearZaicodeBeforeRun,
  continueZaicodeMarked,
  orderZaicodeScheduleTargets,
  startZaicodeInMain,
  stopZaicodeSessionRun,
  zaicodeEngineRank,
  zaicodeHomeRows,
  zaicodeTargetIdle,
} from "./zaicodeScheduleRun.js";

/**
 * ZAICODE autostart = the SCHEDULER engine (AUDAPACK "prepared launches"): a
 * schedule starts work in one project or in every project of a sidebar
 * section, at a time, every day, every N minutes, or when an engine's quota
 * window refills. The decision is a pure function of the schedule, the
 * watched engine's quota and the clock; firing is exactly-once per occurrence
 * (event ids are persisted), a moment older than the catch-up window is
 * MISSED instead of launched late, and a schedule whose engine is out of
 * quota waits instead of launching into a wall. Runs started through the
 * queue are stopped at the schedule's stop time.
 */

const STORAGE_KEY = "zaicode-autostart-v1";
const CHANGE_EVENT = "zaicode-autostart-changed";
const TICK_MS = 15_000;

let cached: ZaicodeAutostartJob[] | null = null;

export function readZaicodeAutostartJobs(): ZaicodeAutostartJob[] {
  if (cached) return cached;
  try {
    cached = normalizeZaicodeAutostartJobs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "[]"));
  } catch {
    cached = [];
  }
  return cached;
}

function write(next: ZaicodeAutostartJob[]): void {
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // lasts for this run
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useZaicodeAutostartJobs(): ZaicodeAutostartJob[] {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(CHANGE_EVENT, listener);
      return () => window.removeEventListener(CHANGE_EVENT, listener);
    },
    readZaicodeAutostartJobs,
    readZaicodeAutostartJobs,
  );
}

export function addZaicodeAutostartJob(partial: Partial<ZaicodeAutostartJob> & { projectPath: string; engineId: string }): ZaicodeAutostartJob {
  const job = normalizeZaicodeAutostartJobs([{ ...partial, id: createUuid(), createdAt: Date.now() }])[0]!;
  write([...readZaicodeAutostartJobs(), job]);
  return job;
}

export function updateZaicodeAutostartJob(id: string, patch: Partial<ZaicodeAutostartJob>): void {
  write(
    normalizeZaicodeAutostartJobs(
      readZaicodeAutostartJobs().map((job) => (job.id === id ? { ...job, ...patch, id: job.id } : job)),
    ),
  );
}

export function removeZaicodeAutostartJob(id: string): void {
  write(readZaicodeAutostartJobs().filter((job) => job.id !== id));
}

export function decideZaicodeAutostartJob(job: ZaicodeAutostartJob, now: number = Date.now()): ZaicodeAutostartDecision {
  const engine = zaicodeAutostartWatchedEngine(job);
  return evaluateZaicodeAutostartJob(job, engine ? readZaicodeEnginesState().limits[engine] : undefined, now);
}

/** Engine id of the in-app agent: START (`/goal cc all`) in the project's MAIN session (a fresh one only without MAIN). */
export const ZAICODE_AUTOSTART_INAPP_ENGINE = "pool:start";
/** Runner prefix of a ZAICODE agent (work goes through the queue). */
export const ZAICODE_AUTOSTART_AGENT_PREFIX = "agent:";

// The queue services are published by ZaicodeAppRuntime (they live in React context).
let queueServices: ZaicodeServices | null = null;

export function publishZaicodeQueueServices(services: ZaicodeServices | null): void {
  queueServices = services;
  syncZaicodeDisabledProjects(services);
}

/** The agent hit-and-go work runs on: an enabled one made from a hit-and-go template, created when missing. */
export async function ensureZaicodeHitAndGoAgent(services: ZaicodeServices): Promise<ZaicodeAgentDefinition> {
  const templates = (await services.agents.listTemplates()).filter((template) => template.hitAndGo);
  const templateIds = new Set(templates.map((template) => template.id));
  const existing = (await services.agents.list()).agents.find(
    (agent) => agent.enabled && agent.templateId !== undefined && templateIds.has(agent.templateId),
  );
  if (existing) return existing;
  const template = templates[0];
  if (!template) throw new Error("no hit-and-go agent template");
  const pool = readZaicodeDefaultModel();
  return services.agents.create({
    name: template.name,
    role: template.role,
    instructions: template.instructions,
    toolPolicy: template.toolPolicy,
    templateId: template.id,
    ...(pool ? { modelSelection: { providerId: pool.providerId, modelId: pool.modelId } } : {}),
  });
}

/** Queues one run of `agentId` in `target` and starts the queue there. */
async function queueRun(
  services: ZaicodeServices,
  agentId: string,
  target: ZaicodeKnownProject,
  job: ZaicodeAutostartJob,
): Promise<{ jobId: string; workspaceKey: string }> {
  const workspaceKey = resolveWorkspaceKey({ workspacePath: target.path, workspaceIdentity: target.identity });
  const task = zaicodeJobTaskText(job.prompt);
  const created = await services.jobs.create({
    workspaceKey,
    workspacePath: target.path,
    ...(target.identity ? { workspaceIdentity: target.identity } : {}),
    agentId,
    title: `Scheduled · ${job.name || "schedule"} · ${task.split("\n")[0]!.slice(0, 60)}`,
    instructions: task,
    priority: 0,
  });
  await services.jobs.pump(workspaceKey);
  return { jobId: created.id, workspaceKey };
}

async function fire(job: ZaicodeAutostartJob, decision: ZaicodeAutostartDecision, manual: boolean): Promise<void> {
  const now = Date.now();
  // Record the occurrence BEFORE anything runs: a crash mid-launch must not double-fire.
  const firedEvents = decision.eventId && !manual ? [...job.firedEvents, decision.eventId].slice(-40) : job.firedEvents;
  const onceDone = job.trigger === "at" && !manual ? { enabled: false } : {};
  const prefs = useZaicodeSidebarPrefs.getState();
  const resolved = zaicodeScheduleTargets(job, readZaicodeKnownProjects(), prefs.groups, prefs.defaultSlot);
  // Projects switched off (Shift+Click) are invisible to automatic work.
  const targets = resolved.filter(
    (target) => !isZaicodeProjectDisabled(resolveWorkspaceKey({ workspacePath: target.path, workspaceIdentity: target.identity })),
  );
  const where = job.targetKind === "section" ? `${job.section} (${targets.length})` : projectNameOf(job.projectPath);
  if (targets.length === 0) {
    const reason = resolved.length > 0 ? "project switched off" : `no project in ${job.section}`;
    updateZaicodeAutostartJob(job.id, { firedEvents, lastRunAt: now, lastResult: reason, ...onceDone });
    return;
  }
  updateZaicodeAutostartJob(job.id, { firedEvents, lastRunAt: now, lastResult: "starting…", ...onceDone });
  const announce = (title: string, body: string) => {
    playZaicodeSound("autostart.fire");
    notifyZaicode("autostart.fire", { header: "Scheduler", title, body, key: `autostart:${job.id}` });
  };
  const finish = (lastResult: string, runs: ZaicodeScheduledRun[] = []) => {
    const current = readZaicodeAutostartJobs().find((candidate) => candidate.id === job.id);
    updateZaicodeAutostartJob(job.id, {
      lastResult: `${new Date(now).toLocaleString()} · ${lastResult}`,
      ...(runs.length > 0 ? { runs: [...(current?.runs ?? []), ...runs].slice(-20) } : {}),
    });
  };

  const isAgent = job.engineId.startsWith(ZAICODE_AUTOSTART_AGENT_PREFIX);
  const isPool = job.engineId.startsWith("pool:");
  const account = isAgent || isPool ? undefined : readZaicodeEnginesState().accounts.find((candidate) => candidate.id === job.engineId);
  if (!isAgent && !isPool && !account) {
    finish("engine not found");
    return;
  }

  // Conditions (SRC-046): the worst projects first, stopgap work out of the way, busy ones skipped.
  const ordered = orderZaicodeScheduleTargets(targets, zaicodeHomeRows(), job.targetKind === "section" ? job.order : "list");
  const runnerRank = account ? zaicodeEngineRank(account.vendor) : ZAICODE_INAPP_RUNNER_RANK;
  const cleared = job.beforeRun !== "none" ? await clearZaicodeBeforeRun(job, ordered, runnerRank) : [];
  const ready = job.onlyWhenIdle ? ordered.filter(zaicodeTargetIdle) : ordered;
  const clearedText = cleared.length > 0 ? ` · before: ${cleared.join(", ")}` : "";
  if (ready.length === 0) {
    finish(`nothing idle to start in${clearedText}`);
    return;
  }

  if ((isPool || isAgent) && job.onlyMarked) {
    const outcome = await continueZaicodeMarked(job, ready, now);
    finish(`${outcome.runs.length} marked session(s) continued${clearedText}`, outcome.runs);
    if (outcome.runs.length > 0) announce(`Marked sessions continued in ${where}`, outcome.lines.join("\n"));
    return;
  }
  // START goes into MAIN (SRC-044): never a new session next to an existing MAIN.
  if (job.engineId === ZAICODE_AUTOSTART_INAPP_ENGINE) {
    const outcome = await startZaicodeInMain(job, ready, now);
    finish(`${outcome.runs.length}/${ready.length} START in MAIN${clearedText}`, outcome.runs);
    if (outcome.runs.length > 0) announce(`START in ${where}`, outcome.lines.join("\n"));
    return;
  }
  // An in-app model in one project opens a fresh session with it; a section (or an agent) goes through the queue.
  if (isPool && ready.length === 1) {
    finish(`START in ZAICODE${clearedText}`);
    useZaicodeFreshSession.getState().open(ready[0]!.path, ready[0]!.identity, job.prompt.trim() || ZAICODE_SAIPEN_START_COMMAND);
    announce(`START in ${where}`, ready[0]!.path);
    return;
  }
  if (isPool || isAgent) {
    const services = queueServices;
    if (!services) {
      finish("the agent queue is not available here");
      return;
    }
    try {
      const agentId = isAgent
        ? job.engineId.slice(ZAICODE_AUTOSTART_AGENT_PREFIX.length)
        : (await ensureZaicodeHitAndGoAgent(services)).id;
      const runs: ZaicodeScheduledRun[] = [];
      for (const target of ready) runs.push({ ...(await queueRun(services, agentId, target, job)), at: now });
      finish(`queued in ${runs.length} project(s)${clearedText}`, runs);
      announce(`Queued in ${where}`, zaicodeJobTaskText(job.prompt));
    } catch (error) {
      finish(`queue failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  const results = [];
  for (const target of ready) {
    results.push(
      await launchZaicodeWorker({ account: account!, projectPath: target.path, ...(job.prompt.trim() ? { prompt: job.prompt } : {}) }),
    );
  }
  const ok = results.filter((result) => result.ok).length;
  finish(`${results.length === 1 ? results[0]!.message : `${ok}/${results.length} workers started`}${clearedText}`);
  if (ok > 0) announce(`${account!.short} started in ${where}`, `${account!.label} · ${ready.map((target) => target.name).join(", ")}`);
}

export function runZaicodeAutostartNow(id: string): void {
  const job = readZaicodeAutostartJobs().find((candidate) => candidate.id === id);
  if (job) void fire(job, decideZaicodeAutostartJob(job), true);
}

/** Stop rules: runs a schedule started (queue jobs, MAIN / marked sessions) end once its stop time has come. */
async function applyStopRules(now: number): Promise<void> {
  const services = queueServices;
  for (const job of readZaicodeAutostartJobs()) {
    const due = zaicodeRunsToStop(job, now, zaicodeScheduleStopAt);
    if (due.length === 0) continue;
    // Forget first: one stop per run, even if a cancel below fails.
    updateZaicodeAutostartJob(job.id, { runs: job.runs.filter((run) => !due.includes(run.jobId)) });
    for (const jobId of due) {
      const run = job.runs.find((candidate) => candidate.jobId === jobId);
      if (run && (await stopZaicodeSessionRun(run))) continue;
      // Cancel is idempotent; a run that already finished stays finished.
      await services?.jobs.cancel(jobId).catch(() => undefined);
    }
    notifyZaicode("autostart.fire", {
      header: "Scheduler",
      title: `Stopped at ${job.stopAt}: ${job.name || "schedule"}`,
      body: `${due.length} run(s) ended by the stop time`,
      key: `autostart-stop:${job.id}`,
    });
  }
}

let running = false;

/** One scheduler for the whole app (mount once, in App). */
export function useZaicodeAutostartRunner(): void {
  useEffect(() => {
    if (running) return;
    running = true;
    const announcedMissed = new Set<string>();
    const tick = () => {
      const now = Date.now();
      for (const job of readZaicodeAutostartJobs()) {
        if (!job.enabled) continue;
        const decision = decideZaicodeAutostartJob(job, now);
        if (decision.state === "due") {
          void fire(job, decision, false);
        } else if (decision.state === "missed" && decision.eventId && !job.firedEvents.includes(decision.eventId)) {
          // A missed moment is recorded once so it never fires late.
          const key = `${job.id}|${decision.eventId}`;
          if (!announcedMissed.has(key)) {
            announcedMissed.add(key);
            updateZaicodeAutostartJob(job.id, {
              firedEvents: [...job.firedEvents, decision.eventId].slice(-40),
              lastResult: `missed ${decision.dueAt ? new Date(decision.dueAt).toLocaleString() : ""}`.trim(),
              ...(job.trigger === "at" ? { enabled: false } : {}),
            });
            playZaicodeSound("autostart.missed");
            notifyZaicode("autostart.missed", {
              header: "Scheduler",
              title: `Missed: ${job.name || projectNameOf(job.projectPath)}`,
              body: `Due ${decision.dueAt ? new Date(decision.dueAt).toLocaleString() : "earlier"} while ZAICODE was closed or the engine was busy — not started late.`,
              key: `autostart-missed:${job.id}`,
            });
          }
        }
      }
      void applyStopRules(now);
    };
    const first = window.setTimeout(tick, 5000);
    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      running = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
}
