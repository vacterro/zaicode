import { useEffect } from "react";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { useZaicodeHomeProjects } from "./home/ZaicodeHomeFleet.js";
import {
  ZAICODE_CONTINUE_PLAIN_TEXT,
  ZAICODE_CONTINUE_SAIPEN_TEXT,
  describeZaicodeContinueCommand,
  useZaicodeSessionBriefs,
  type ZaicodeContinueCommand,
  type ZaicodeSessionBrief,
} from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { relaunchZaicodeWorkersAfterCrash } from "./zaicodeWorkerRecovery.js";

/**
 * Auto-continue after a crash (SRC-044): "between crashes the state must be
 * kept, and with auto-continue on, work continues by itself".
 *
 * The state already survives: tasks-index (SQLite, WAL) is written when a
 * turn starts and when it ends, so a process that died mid-turn leaves its
 * sessions "running" with nothing live behind them, and an unfinished goal
 * stays "active". Once ZAICODE is back, those sessions are continued -- their
 * goal again, else SAIPEN's `cc` -- one at a time. A Stop is the operator's
 * decision and is never undone; a reload of the window is not a crash.
 */

/** First look after start: the host, the sidebar lists and sessions-index settle first. */
const FIRST_LOOK_MS = 25_000;
/** Second look: a session must still be cut off (live phase can arrive late). */
const CONFIRM_MS = 10_000;
/** Gap between two continued sessions, so a restart never floods the host. */
const STAGGER_MS = 4_000;
const DONE_MARK = "zaicode-crash-resume-done";

export interface ZaicodeCrashResumeStep {
  sessionId: string;
  projectKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  title: string;
  command: ZaicodeContinueCommand;
}

/** Pure: what to continue after a crash, oldest cut first. */
export function planZaicodeCrashResume(
  sessions: readonly ZaicodeSessionBrief[],
  project: (projectKey: string) => { hasSaipen: boolean; disabled: boolean } | null,
  now: number,
  maxAgeHours: number,
): ZaicodeCrashResumeStep[] {
  const oldest = now - maxAgeHours * 3_600_000;
  return sessions
    .filter((session) => session.crashCut && !session.running && !session.waiting && session.updatedAt >= oldest)
    .filter((session) => !project(session.projectKey)?.disabled)
    .sort((left, right) => left.updatedAt - right.updatedAt)
    .map((session) => {
      const unfinishedGoal = session.goalObjective && (session.goalStatus === "active" || session.goalStatus === "paused");
      const hasSaipen = project(session.projectKey)?.hasSaipen ?? true;
      return {
        sessionId: session.sessionId,
        projectKey: session.projectKey,
        workspacePath: session.workspacePath,
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        title: session.title,
        command: unfinishedGoal
          ? { kind: "goal" as const, objective: session.goalObjective! }
          : { kind: "text" as const, text: hasSaipen ? ZAICODE_CONTINUE_SAIPEN_TEXT : ZAICODE_CONTINUE_PLAIN_TEXT },
      };
    });
}

function isWindowReload(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type === "reload";
  } catch {
    return false;
  }
}

function alreadyDone(): boolean {
  try {
    return sessionStorage.getItem(DONE_MARK) === "1";
  } catch {
    return false;
  }
}

function markDone(): void {
  try {
    sessionStorage.setItem(DONE_MARK, "1");
  } catch {
    // one run per mount still holds
  }
}

function projectFacts(projectKey: string): { hasSaipen: boolean; disabled: boolean } | null {
  const row = useZaicodeHomeProjects.getState().rows[projectKey];
  return row ? { hasSaipen: row.hasSaipen, disabled: row.disabled } : null;
}

async function runSteps(steps: readonly ZaicodeCrashResumeStep[]): Promise<{ sent: string[]; failed: string[] }> {
  const sent: string[] = [];
  const failed: string[] = [];
  for (const [index, step] of steps.entries()) {
    if (index > 0) await new Promise((resolve) => window.setTimeout(resolve, STAGGER_MS));
    const line = `${step.title} → ${describeZaicodeContinueCommand(step.command)}`;
    const handle = zaicodeContinueHandleFor({
      key: step.projectKey,
      path: step.workspacePath,
      ...(step.workspaceIdentity ? { identity: step.workspaceIdentity } : {}),
    });
    if (!handle) {
      failed.push(`${line}: project not connected`);
      continue;
    }
    try {
      await handle.send(step.sessionId, step.command);
      sent.push(line);
    } catch (error) {
      failed.push(`${line}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { sent, failed };
}

/** Mount once (ZaicodeAppRuntime): one look per app start, never after a window reload. */
export function useZaicodeCrashResume(): void {
  useEffect(() => {
    if (alreadyDone() || isWindowReload()) return;
    let cancelled = false;
    const look = () => {
      const prefs = useZaicodeUiPrefs.getState();
      return planZaicodeCrashResume(
        useZaicodeSessionBriefs.getState().sessions,
        projectFacts,
        Date.now(),
        prefs.resumeAfterCrashHours,
      );
    };
    const first = window.setTimeout(() => {
      if (cancelled || alreadyDone()) return;
      // Marked when the look happens (not at mount): a StrictMode remount must not skip it.
      markDone();
      const prefs = useZaicodeUiPrefs.getState();
      if (prefs.relaunchWorkersAfterCrash) relaunchZaicodeWorkersAfterCrash();
      if (!prefs.resumeAfterCrash) return;
      const candidates = new Set(look().map((step) => step.sessionId));
      if (candidates.size === 0) return;
      window.setTimeout(() => {
        if (cancelled) return;
        const steps = look().filter((step) => candidates.has(step.sessionId));
        if (steps.length === 0) return;
        logger.info("[zaicode] auto-continue after a crash", { sessions: steps.map((step) => step.sessionId) });
        toast(`Auto-continue after a crash: ${steps.length} session(s) cut off mid-turn…`, { durationMs: 6000 });
        void runSteps(steps).then(({ sent, failed }) => {
          toast(
            [`Auto-continue after a crash: ${sent.length} continued${failed.length ? `, ${failed.length} failed` : ""}`, ...sent, ...failed].join("\n"),
            { durationMs: 12_000, ...(failed.length ? { variant: "warning" as const } : {}) },
          );
        });
      }, CONFIRM_MS);
    }, FIRST_LOOK_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
    };
  }, []);
}
