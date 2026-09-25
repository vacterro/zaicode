import { create } from "zustand";
import type { ZCodeTaskGoalStatus, ZCodeTaskMeta, ZaicodeProjectRuntimeState } from "@zcode/shared";
import { getTaskListAttention, getTaskListRowActivity, isTaskListRowActive } from "@/v4/taskListRowActivity.js";

/**
 * Continue without opening (SRC-043): one decision for a single session
 * (the row's ▶ button, Alt+Click) and one smart plan for CONTINUE ALL, plus
 * the "next finished, not yet seen" queue behind the DONE button.
 *
 * Pure rules live here; the sidebar publishes the facts (session briefs),
 * each project row registers how to reach its own host (local or remote),
 * and nothing is sent that the plan did not list.
 */

// ---------------------------------------------------------------- facts

/** What the sidebar knows about one session: enough to decide, never the transcript. */
export interface ZaicodeSessionBrief {
  sessionId: string;
  title: string;
  projectKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  running: boolean;
  /** A question or permission waits for the operator. */
  waiting: boolean;
  /** The last turn ended on an error (limit, network, provider). */
  failed: boolean;
  /** When it finished while the operator looked elsewhere; null = seen. */
  unreadAt: number | null;
  goalStatus: ZCodeTaskGoalStatus | null;
  goalObjective: string | null;
}

export function zaicodeSessionBriefOf(
  task: ZCodeTaskMeta,
  projectKey: string,
  location: { workspacePath: string; workspaceIdentity?: string },
): ZaicodeSessionBrief {
  const activity = getTaskListRowActivity(task);
  const goal = task.target ?? null;
  return {
    sessionId: task.taskId,
    title: task.title || task.taskId,
    projectKey,
    workspacePath: location.workspacePath,
    ...(location.workspaceIdentity ? { workspaceIdentity: location.workspaceIdentity } : {}),
    running: isTaskListRowActive(task),
    waiting: getTaskListAttention(task) !== null || Boolean(task.pendingInteraction),
    // Same authority order as the row's leading dot: live phase first, persisted status without one.
    failed: activity ? activity.phase === "error" : task.status === "error",
    unreadAt: typeof task.unreadAt === "number" ? task.unreadAt : null,
    goalStatus: goal?.status ?? null,
    goalObjective: goal?.objective?.trim() || null,
  };
}

function briefSignature(brief: ZaicodeSessionBrief): string {
  return [
    brief.sessionId,
    brief.title,
    brief.projectKey,
    brief.running ? 1 : 0,
    brief.waiting ? 1 : 0,
    brief.failed ? 1 : 0,
    brief.unreadAt ?? "",
    brief.goalStatus ?? "",
    brief.goalObjective ?? "",
  ].join("\u0001");
}

interface ZaicodeSessionBriefState {
  sessions: ZaicodeSessionBrief[];
  signature: string;
  publish: (sessions: ZaicodeSessionBrief[]) => void;
}

/** Published by the sidebar on every task-list change; unchanged facts keep their identity. */
export const useZaicodeSessionBriefs = create<ZaicodeSessionBriefState>((set, get) => ({
  sessions: [],
  signature: "",
  publish: (sessions) => {
    const signature = sessions.map(briefSignature).join("\u0002");
    if (signature !== get().signature) set({ sessions, signature });
  },
}));

// ---------------------------------------------------------------- next finished

/**
 * Finished sessions the operator has not looked at, oldest first: the DONE
 * button walks them like an inbox. Opening one marks it seen, so the next
 * click always lands on the next one -- the same order every time.
 */
export function zaicodeDoneUnseen(sessions: readonly ZaicodeSessionBrief[]): ZaicodeSessionBrief[] {
  return sessions
    .filter((session) => session.unreadAt !== null && !session.running && !session.waiting && !session.failed)
    .sort((left, right) => left.unreadAt! - right.unreadAt! || left.title.localeCompare(right.title));
}

/** The next unseen finished session, skipping the one already open. */
export function nextZaicodeDoneSession(
  done: readonly ZaicodeSessionBrief[],
  activeSessionId: string | null,
): ZaicodeSessionBrief | null {
  return done.find((session) => session.sessionId !== activeSessionId) ?? null;
}

// ---------------------------------------------------------------- one session

/** SAIPEN's continue shortcut; a project without SAIPEN gets the plain word. */
export const ZAICODE_CONTINUE_SAIPEN_TEXT = "cc";
export const ZAICODE_CONTINUE_PLAIN_TEXT = "continue";
/** START's goal (`/goal cc all`): continue and close every ticket a human is not needed for. */
export const ZAICODE_CONTINUE_START_OBJECTIVE = "cc all";

export type ZaicodeContinueCommand =
  | { kind: "goal"; objective: string }
  | { kind: "text"; text: string };

export function describeZaicodeContinueCommand(command: ZaicodeContinueCommand): string {
  return command.kind === "goal" ? `/goal ${command.objective}` : command.text;
}

export type ZaicodeSessionContinueDecision =
  | { action: "send"; command: ZaicodeContinueCommand; why: string }
  /** A human answer is what it needs: open it instead. */
  | { action: "open"; why: string }
  | { action: "none"; why: string };

/**
 * Explicit continue of one session (▶ on the row, Alt+Click): a goal it was
 * pursuing is taken up again with the same objective; otherwise SAIPEN's `cc`
 * (or "continue" outside SAIPEN).
 */
export function decideZaicodeSessionContinue(
  session: Pick<ZaicodeSessionBrief, "running" | "waiting" | "goalStatus" | "goalObjective">,
  hasSaipen: boolean,
): ZaicodeSessionContinueDecision {
  if (session.running) return { action: "none", why: "already working" };
  if (session.waiting) return { action: "open", why: "it waits for your answer" };
  if (session.goalObjective && session.goalStatus && session.goalStatus !== "complete") {
    return {
      action: "send",
      command: { kind: "goal", objective: session.goalObjective },
      why: session.goalStatus === "paused" ? "its goal was stopped" : "its goal is not finished",
    };
  }
  return {
    action: "send",
    command: { kind: "text", text: hasSaipen ? ZAICODE_CONTINUE_SAIPEN_TEXT : ZAICODE_CONTINUE_PLAIN_TEXT },
    why: "continue where it stopped",
  };
}

// ---------------------------------------------------------------- continue all

export interface ZaicodeContinueProject {
  key: string;
  name: string;
  /** Switched off (Shift+Click): automatic work never touches it. */
  disabled: boolean;
  hasSaipen: boolean;
  /** T-41 read-model verdict; null while not read yet. */
  state: ZaicodeProjectRuntimeState | null;
  mainSessionId: string | null;
}

export type ZaicodeContinueStep =
  | { kind: "session"; projectKey: string; projectName: string; sessionId: string; title: string; command: ZaicodeContinueCommand; why: string }
  /** No MAIN session yet: a fresh one becomes MAIN and gets the command. */
  | { kind: "start"; projectKey: string; projectName: string; command: ZaicodeContinueCommand; why: string };

export interface ZaicodeContinuePlan {
  steps: ZaicodeContinueStep[];
  /** What was left alone and why (shown in the button's tooltip and the result). */
  skipped: { name: string; why: string }[];
}

/**
 * The smart CONTINUE ALL: only work that was interrupted or is still open.
 *
 * - a session whose goal stopped or never finished takes that goal up again;
 * - a session whose last turn failed (limit, network) continues;
 * - a SAIPEN project with open tickets and nothing running continues its MAIN
 *   session (`/goal cc all`), or starts one when it has none;
 * - finished sessions, running ones, switched-off projects and anything that
 *   waits for a human answer are left alone.
 */
export function planZaicodeContinueAll(
  projects: readonly ZaicodeContinueProject[],
  sessions: readonly ZaicodeSessionBrief[],
): ZaicodeContinuePlan {
  const steps: ZaicodeContinueStep[] = [];
  const skipped: ZaicodeContinuePlan["skipped"] = [];
  for (const project of projects) {
    const own = sessions.filter((session) => session.projectKey === project.key);
    if (project.disabled) {
      skipped.push({ name: project.name, why: "switched off" });
      continue;
    }
    const waiting = own.filter((session) => session.waiting);
    if (waiting.length > 0) {
      skipped.push({ name: project.name, why: `${waiting.length} session(s) wait for your answer` });
    }
    let continued = false;
    for (const session of own) {
      if (session.running || session.waiting) continue;
      const unfinishedGoal =
        session.goalObjective !== null && (session.goalStatus === "active" || session.goalStatus === "paused");
      if (unfinishedGoal) {
        steps.push({
          kind: "session",
          projectKey: project.key,
          projectName: project.name,
          sessionId: session.sessionId,
          title: session.title,
          command: { kind: "goal", objective: session.goalObjective! },
          why: session.goalStatus === "paused" ? "goal was stopped" : "goal not finished",
        });
        continued = true;
      } else if (session.failed) {
        steps.push({
          kind: "session",
          projectKey: project.key,
          projectName: project.name,
          sessionId: session.sessionId,
          title: session.title,
          command: { kind: "text", text: project.hasSaipen ? ZAICODE_CONTINUE_SAIPEN_TEXT : ZAICODE_CONTINUE_PLAIN_TEXT },
          why: "stopped on an error",
        });
        continued = true;
      }
    }
    if (continued || !project.hasSaipen || project.state !== "pending") continue;
    const start: ZaicodeContinueCommand = { kind: "goal", objective: ZAICODE_CONTINUE_START_OBJECTIVE };
    const main = project.mainSessionId ? own.find((session) => session.sessionId === project.mainSessionId) : undefined;
    if (main && (main.running || main.waiting)) continue;
    if (project.mainSessionId) {
      steps.push({
        kind: "session",
        projectKey: project.key,
        projectName: project.name,
        sessionId: project.mainSessionId,
        title: main?.title ?? "MAIN",
        command: start,
        why: "SAIPEN has open tickets",
      });
    } else {
      steps.push({ kind: "start", projectKey: project.key, projectName: project.name, command: start, why: "SAIPEN has open tickets, no MAIN yet" });
    }
  }
  return { steps, skipped };
}

/** One line per step for the button's tooltip and the result notice. */
export function describeZaicodeContinueStep(step: ZaicodeContinueStep): string {
  const where = step.kind === "start" ? `${step.projectName} · new MAIN` : `${step.projectName} · ${step.title}`;
  return `${where} → ${describeZaicodeContinueCommand(step.command)} (${step.why})`;
}

// ---------------------------------------------------------------- reaching a host

/** How a project row sends to its own host (local or remote workspace). */
export interface ZaicodeProjectContinueHandle {
  send: (sessionId: string, command: ZaicodeContinueCommand) => Promise<void>;
  /** Creates a fresh session, sends the command, returns its id. */
  start: (command: ZaicodeContinueCommand) => Promise<string>;
}

const handles = new Map<string, ZaicodeProjectContinueHandle>();

export function registerZaicodeProjectContinue(projectKey: string, handle: ZaicodeProjectContinueHandle): () => void {
  handles.set(projectKey, handle);
  return () => {
    if (handles.get(projectKey) === handle) handles.delete(projectKey);
  };
}

export function zaicodeProjectContinueHandle(projectKey: string): ZaicodeProjectContinueHandle | null {
  return handles.get(projectKey) ?? null;
}

export interface ZaicodeContinueOutcome {
  sent: string[];
  failed: string[];
  /** Fresh MAIN sessions created, by project key. */
  started: { projectKey: string; sessionId: string }[];
}

/** Runs a plan step by step (one host round trip at a time, so a slow host never floods). */
export async function runZaicodeContinuePlan(plan: ZaicodeContinuePlan): Promise<ZaicodeContinueOutcome> {
  const outcome: ZaicodeContinueOutcome = { sent: [], failed: [], started: [] };
  for (const step of plan.steps) {
    const handle = handles.get(step.projectKey);
    const line = describeZaicodeContinueStep(step);
    if (!handle) {
      outcome.failed.push(`${line}: project not connected`);
      continue;
    }
    try {
      if (step.kind === "start") {
        const sessionId = await handle.start(step.command);
        outcome.started.push({ projectKey: step.projectKey, sessionId });
      } else {
        await handle.send(step.sessionId, step.command);
      }
      outcome.sent.push(line);
    } catch (error) {
      outcome.failed.push(`${line}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return outcome;
}
