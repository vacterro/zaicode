import {
  ZAICODE_HIT_AND_GO_PROMPT,
  zaicodeAutostartWatchedEngine,
  type ZaicodeAutostartDecision,
  type ZaicodeAutostartJob,
} from "@zcode/shared";
import { create } from "zustand";

/**
 * SCHEDULER (SRC-038): prompts that start by themselves -- at a time, every
 * day, every N minutes, or the moment a subscription's quota window refills --
 * in one project or in every project of a sidebar section, run by START, an
 * in-app pool, a ZAICODE agent through the queue, or a subscription CLI.
 * The engine is the T-34 autostart (exactly-once moments, catch-up window,
 * wait for quota); this module adds what the operator sees: targets, presets,
 * "what fires next", and which limit meter has a prompt waiting for its reset.
 */

export type ZaicodeWorkspaceTab = "agents" | "scheduler";

/** Which page of the ZAICODE workspace is open (the sidebar SCHEDULER line opens the second). */
export const useZaicodeWorkspaceTab = create<{ tab: ZaicodeWorkspaceTab; setTab: (tab: ZaicodeWorkspaceTab) => void }>(
  (set) => ({ tab: "agents", setTab: (tab) => set({ tab }) }),
);

export interface ZaicodeKnownProject {
  path: string;
  identity?: string;
  /** Sidebar slot-group key (buildTaskWorkspaceKey). */
  key: string;
  name: string;
}

/** Projects a schedule starts in: its own project, or every project in its section. */
export function zaicodeScheduleTargets(
  job: Pick<ZaicodeAutostartJob, "targetKind" | "section" | "projectPath">,
  projects: readonly ZaicodeKnownProject[],
  groups: Readonly<Record<string, string>>,
  defaultSlot: string,
): ZaicodeKnownProject[] {
  if (job.targetKind !== "section") {
    const known = projects.find((project) => project.path.toLowerCase() === job.projectPath.toLowerCase());
    return [known ?? { path: job.projectPath, key: job.projectPath, name: job.projectPath }];
  }
  return projects.filter((project) => (groups[project.key] ?? defaultSlot) === job.section);
}

/** The words a schedule is summed up with in lists and tooltips. */
export function describeZaicodeSchedule(
  job: Pick<ZaicodeAutostartJob, "trigger" | "dailyTime" | "intervalMinutes" | "window" | "at" | "prompt" | "targetKind" | "section" | "projectPath">,
  engineLabel: string,
): string {
  const when =
    job.trigger === "at"
      ? `once at ${job.at ? new Date(job.at).toLocaleString() : "?"}`
      : job.trigger === "daily"
        ? `every day at ${job.dailyTime}`
        : job.trigger === "interval"
          ? `every ${job.intervalMinutes} min`
          : job.trigger === "reset"
            ? `after the next ${job.window === "five_hour" ? "5h" : job.window} reset`
            : `after every ${job.window === "five_hour" ? "5h" : job.window} reset`;
  const where = job.targetKind === "section" ? `every ${job.section} project` : shortProject(job.projectPath);
  return `${job.prompt.trim() || ZAICODE_HIT_AND_GO_PROMPT} · ${where} · ${engineLabel} · ${when}`;
}

function shortProject(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

export interface ZaicodeScheduleNext {
  job: ZaicodeAutostartJob;
  decision: ZaicodeAutostartDecision;
}

/** The armed schedules in firing order (known moments first, soonest first). */
export function zaicodeUpcomingSchedules(
  jobs: readonly ZaicodeAutostartJob[],
  decide: (job: ZaicodeAutostartJob) => ZaicodeAutostartDecision,
): ZaicodeScheduleNext[] {
  const armed = jobs
    .filter((job) => job.enabled)
    .map((job) => ({ job, decision: decide(job) }))
    .filter(({ decision }) => decision.state !== "done" && decision.state !== "disabled" && decision.state !== "invalid");
  return armed.sort((left, right) => {
    const a = left.decision.dueAt ?? Number.POSITIVE_INFINITY;
    const b = right.decision.dueAt ?? Number.POSITIVE_INFINITY;
    return a - b;
  });
}

/**
 * Limit meters with a prompt waiting for their reset: engine id -> the
 * schedules that fire when it refills. Drives the "prompt ready" glow.
 */
export function zaicodePreparedEngines(
  jobs: readonly ZaicodeAutostartJob[],
  decide: (job: ZaicodeAutostartJob) => ZaicodeAutostartDecision,
): Map<string, ZaicodeScheduleNext[]> {
  const prepared = new Map<string, ZaicodeScheduleNext[]>();
  for (const job of jobs) {
    if (!job.enabled || (job.trigger !== "reset" && job.trigger !== "everyReset")) continue;
    const engine = zaicodeAutostartWatchedEngine(job);
    if (!engine) continue;
    const decision = decide(job);
    if (decision.state !== "waiting-reset" && decision.state !== "waiting-quota" && decision.state !== "due") continue;
    prepared.set(engine, [...(prepared.get(engine) ?? []), { job, decision }]);
  }
  return prepared;
}

/** Runs a stop rule ends now: started before its stop moment, which has passed. */
export function zaicodeRunsToStop(
  job: Pick<ZaicodeAutostartJob, "stopAt" | "runs">,
  now: number,
  stopMoment: (stopAt: string, startedAt: number) => number | null,
): string[] {
  if (!job.stopAt) return [];
  return job.runs
    .filter((run) => {
      const stop = stopMoment(job.stopAt, run.at);
      return stop !== null && now >= stop;
    })
    .map((run) => run.jobId);
}

export interface ZaicodeSchedulePreset {
  id: string;
  label: string;
  hint: string;
  patch: Partial<ZaicodeAutostartJob>;
  /** The preset needs a subscription engine to watch. */
  needsEngine?: boolean;
}

/** One click, then adjust: the usual ways to keep subscriptions busy (SRC-038). */
export const ZAICODE_SCHEDULE_PRESETS: readonly ZaicodeSchedulePreset[] = [
  {
    id: "every-reset",
    label: "Every 5h reset → /goal cc all here",
    hint: "The moment the subscription's 5-hour window refills, work continues in this project until the board is clear. No window wasted.",
    patch: { name: "Every 5h reset", trigger: "everyReset", window: "five_hour", prompt: "", targetKind: "project" },
    needsEngine: true,
  },
  {
    id: "main0-reset",
    label: "Every 5h reset → /goal cc all in MAIN0",
    hint: "Each refill continues every MAIN0 project's MAIN session (a new MAIN only where there is none), the most blocked / open projects first.",
    patch: { name: "MAIN0 after each reset", trigger: "everyReset", window: "five_hour", prompt: "", targetKind: "section", section: "MAIN0" },
    needsEngine: true,
  },
  {
    id: "night",
    label: "Every night 02:00 → /goal cc all in MAIN0, stop 07:00",
    hint: "Night shift: the MAIN0 projects' MAIN sessions work while you sleep and are stopped before morning.",
    patch: { name: "Night shift", trigger: "daily", dailyTime: "02:00", prompt: "", targetKind: "section", section: "MAIN0", stopAt: "07:00" },
  },
  {
    id: "every-2h",
    label: "Every 2 hours → cc here",
    hint: "One SAIPEN step every two hours: small, steady progress.",
    patch: { name: "Steady steps", trigger: "interval", intervalMinutes: 120, prompt: "cc", targetKind: "project" },
  },
  {
    id: "docs-morning",
    label: "Every morning 08:00 → saiwiki",
    hint: "Documentation refreshed before you start the day.",
    patch: { name: "Morning docs", trigger: "daily", dailyTime: "08:00", prompt: "saiwiki", targetKind: "project" },
  },
  {
    id: "weekly-hunt",
    label: "Weekly reset → saihunt",
    hint: "When the weekly window refills, one bug hunt over the project.",
    patch: { name: "Weekly hunt", trigger: "everyReset", window: "weekly", prompt: "saihunt", targetKind: "project" },
    needsEngine: true,
  },
];

// ---------------------------------------------------------------------------
// What the runner needs from React land, published by ZaicodeAppRuntime.
// ---------------------------------------------------------------------------

let knownProjects: ZaicodeKnownProject[] = [];

export function publishZaicodeKnownProjects(projects: ZaicodeKnownProject[]): void {
  knownProjects = projects;
}

export function readZaicodeKnownProjects(): ZaicodeKnownProject[] {
  return knownProjects;
}
