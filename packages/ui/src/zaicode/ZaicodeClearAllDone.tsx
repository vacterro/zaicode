import { useMemo, useState } from "react";
import { BrushCleaning } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useZaicodeHomeProjects } from "./home/ZaicodeHomeFleet.js";
import {
  archiveZaicodeSessions,
  hasZaicodeArchiveSomeHandler,
  useZaicodeArchiveHandlesVersion,
  type ZaicodeArchiveOutcome,
} from "./zaicodeArchiveUndo.js";
import {
  ZAICODE_CONTINUE_PLAIN_TEXT,
  ZAICODE_CONTINUE_SAIPEN_TEXT,
  useZaicodeSessionBriefs,
  useZaicodeContinueHandlesVersion,
  zaicodeProjectContinueHandle,
  type ZaicodeContinueCommand,
  type ZaicodeSessionBrief,
} from "./zaicodeContinue.js";
import { useZaicodeMainSessions } from "./zaicodeMainSession.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * CLEAR ALL DONE (SRC-044, the "project = MAIN" view): the helper sessions
 * under each project are tidied in one press -- the finished ones are archived
 * (one Ctrl+Z brings them all back), the ones a crash or Stop cut off get `cc`
 * (or their goal again). MAIN sessions, running ones and ones waiting for an
 * answer are never touched.
 *
 * The number on the button is what CAN run right now, never what ran: work
 * whose project row has no mounted handler (collapsed, unmounted, read-only)
 * is not counted, and after the run the counter follows the reconciled
 * session list instead of being forced to zero (T-299).
 */

export interface ZaicodeClearDonePlan {
  archive: { projectKey: string; sessionId: string; title: string }[];
  resume: { projectKey: string; sessionId: string; title: string; command: ZaicodeContinueCommand }[];
}

/** Pure: which helper sessions go to the archive and which continue. */
export function planZaicodeClearAllDone(
  sessions: readonly ZaicodeSessionBrief[],
  mainSessionIds: ReadonlySet<string>,
  hasSaipen: (projectKey: string) => boolean,
): ZaicodeClearDonePlan {
  const plan: ZaicodeClearDonePlan = { archive: [], resume: [] };
  for (const session of sessions) {
    if (mainSessionIds.has(session.sessionId) || session.running || session.waiting) continue;
    const entry = { projectKey: session.projectKey, sessionId: session.sessionId, title: session.title };
    if (session.interrupted || session.failed) {
      const goal = session.goalObjective && (session.goalStatus === "active" || session.goalStatus === "paused");
      plan.resume.push({
        ...entry,
        command: goal
          ? { kind: "goal", objective: session.goalObjective! }
          : { kind: "text", text: hasSaipen(session.projectKey) ? ZAICODE_CONTINUE_SAIPEN_TEXT : ZAICODE_CONTINUE_PLAIN_TEXT },
      });
    } else {
      plan.archive.push(entry);
    }
  }
  return plan;
}

/**
 * What a mounted handler can execute right now vs what no row can do.
 *
 * A session whose project row is unmounted (a collapsed group, a project that
 * has not mounted its handlers) is NOT counted as work the button will do:
 * advertising it and then silently skipping it is exactly the old lie. It stays
 * visible in the tooltip as not executable right now.
 */
export interface ZaicodeClearDoneSplit {
  runnable: ZaicodeClearDonePlan;
  blocked: ZaicodeClearDonePlan;
  /** One explanation line per blocked session. */
  why: string[];
}

export function splitZaicodeClearDonePlan(
  plan: ZaicodeClearDonePlan,
  canArchive: (projectKey: string) => boolean,
  canResume: (projectKey: string) => boolean,
): ZaicodeClearDoneSplit {
  const runnable: ZaicodeClearDonePlan = { archive: [], resume: [] };
  const blocked: ZaicodeClearDonePlan = { archive: [], resume: [] };
  const why: string[] = [];
  for (const entry of plan.archive) {
    if (canArchive(entry.projectKey)) {
      runnable.archive.push(entry);
    } else {
      blocked.archive.push(entry);
      why.push(`  ${entry.title}: its project row has no connection right now (unmounted, collapsed or read-only)`);
    }
  }
  for (const entry of plan.resume) {
    if (canResume(entry.projectKey)) {
      runnable.resume.push(entry);
    } else {
      blocked.resume.push(entry);
      why.push(`  ${entry.title}: its project row has no connection right now (unmounted, collapsed or read-only)`);
    }
  }
  return { runnable, blocked, why };
}

/** What one CLEAR ALL DONE run actually did (requested vs completed, never conflated). */
export interface ZaicodeClearDoneRun {
  requestedArchive: number;
  requestedResume: number;
  /** Copies written by the archive handlers (restorable with Ctrl+Z). */
  archived: number;
  /** Continuation commands the host ACCEPTED -- the session is not finished by this. */
  accepted: number;
  /** Sessions a handler deliberately left alone (still running under it, etc.). */
  skipped: number;
  /** Sessions whose operation failed or had no handler at execution time. */
  failed: number;
  /** What is still actionable after reconciling the authoritative session list. */
  remainingArchive: number;
  remainingResume: number;
  /** Human lines naming what did not complete, so nothing is invented. */
  problems: string[];
}

export interface ZaicodeClearDoneDeps {
  plan: ZaicodeClearDonePlan;
  archive: (byProject: ReadonlyMap<string, readonly string[]>) => Promise<ZaicodeArchiveOutcome>;
  send: (entry: ZaicodeClearDonePlan["resume"][number]) => Promise<void>;
  /** Re-plans against the reconciled session list AFTER the operations. */
  remaining: () => ZaicodeClearDonePlan;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes the runnable plan and accounts for every entry:
 * archived, accepted, skipped, failed or never sent (no handler). Sends one
 * continuation per entry, once -- a second dispatch of the same command never
 * happens here, and the caller's busy lock prevents concurrent runs.
 */
export async function runZaicodeClearAllDone(deps: ZaicodeClearDoneDeps): Promise<ZaicodeClearDoneRun> {
  const { plan } = deps;
  const problems: string[] = [];
  const byProject = new Map<string, string[]>();
  for (const entry of plan.archive) {
    byProject.set(entry.projectKey, [...(byProject.get(entry.projectKey) ?? []), entry.sessionId]);
  }
  const outcome = await deps.archive(byProject);
  const archived = outcome.archived.length;
  for (const group of outcome.skipped) {
    problems.push(`Skipped ${group.sessionIds.length} in ${group.projectKey} (the handler declined them)`);
  }
  for (const group of outcome.unregistered) {
    problems.push(`Skipped ${group.sessionIds.length} in ${group.projectKey}: no archive handler was connected`);
  }
  for (const group of outcome.failed) {
    problems.push(`Archive failed for ${group.sessionIds.join(", ")} in ${group.projectKey}: ${group.reason}`);
  }
  let accepted = 0;
  for (const entry of plan.resume) {
    try {
      await deps.send(entry);
      accepted += 1;
    } catch (error) {
      problems.push(`Continuation failed for ${entry.title}: ${message(error)}`);
    }
  }
  const after = deps.remaining();
  const skipped =
    outcome.skipped.reduce((sum, group) => sum + group.sessionIds.length, 0) +
    outcome.unregistered.reduce((sum, group) => sum + group.sessionIds.length, 0);
  const failed =
    outcome.failed.reduce((sum, group) => sum + group.sessionIds.length, 0) +
    (plan.resume.length - accepted);
  return {
    requestedArchive: plan.archive.length,
    requestedResume: plan.resume.length,
    archived,
    accepted,
    skipped,
    failed,
    remainingArchive: after.archive.length,
    remainingResume: after.resume.length,
    problems,
  };
}

/** The toast: requested work, completed work and what is left, as separate numbers. */
export function formatZaicodeClearDoneRun(run: ZaicodeClearDoneRun): string {
  const lines = [
    "CLEAR ALL DONE",
    `Archived: ${run.archived} (Ctrl+Z restores)`,
    `Continuation accepted: ${run.accepted}`,
    `Skipped: ${run.skipped}`,
    `Failed: ${run.failed}`,
  ];
  const left = run.remainingArchive + run.remainingResume;
  lines.push(
    left > 0
      ? `Still actionable: ${left} (finished ${run.remainingArchive}, cut-off ${run.remainingResume})`
      : "Nothing left to clear.",
  );
  for (const problem of run.problems) lines.push(problem);
  return lines.join("\n");
}

function describe(plan: ZaicodeClearDoneSplit): string {
  const { runnable, blocked } = plan;
  const runCount = runnable.archive.length + runnable.resume.length;
  const blockedCount = blocked.archive.length + blocked.resume.length;
  if (runCount === 0 && blockedCount === 0) return "Nothing to clear: no finished or cut-off helper session.";
  const lines = [`${runCount} actionable session(s):`];
  if (runnable.archive.length > 0) {
    lines.push(`Archive ${runnable.archive.length} finished helper session(s) (Ctrl+Z restores):`);
    for (const entry of runnable.archive) lines.push(`  ${entry.title}`);
  }
  if (runnable.resume.length > 0) {
    lines.push(`Continue ${runnable.resume.length} cut-off one(s) with cc / their goal:`);
    for (const entry of runnable.resume) lines.push(`  ${entry.title}`);
  }
  if (blockedCount > 0) {
    lines.push(`NOT executable right now, NOT counted (${blockedCount}):`);
    lines.push(...plan.why);
  }
  lines.push("MAIN sessions, running ones and ones waiting for you stay as they are.");
  return lines.join("\n");
}

export function ZaicodeClearAllDoneButton() {
  const sessions = useZaicodeSessionBriefs((state) => state.sessions);
  const mains = useZaicodeMainSessions((state) => state.byWorkspace);
  const rows = useZaicodeHomeProjects((state) => state.rows);
  const archiveHandles = useZaicodeArchiveHandlesVersion();
  const continueHandles = useZaicodeContinueHandlesVersion();
  const [busy, setBusy] = useState(false);
  const plan = useMemo(
    () =>
      splitZaicodeClearDonePlan(
        planZaicodeClearAllDone(sessions, new Set(Object.values(mains)), (key) => rows[key]?.hasSaipen ?? true),
        (key) => hasZaicodeArchiveSomeHandler(key),
        (key) => zaicodeProjectContinueHandle(key) !== null,
      ),
    [archiveHandles, continueHandles, mains, rows, sessions],
  );
  const count = plan.runnable.archive.length + plan.runnable.resume.length;
  const blockedCount = plan.blocked.archive.length + plan.blocked.resume.length;

  const run = async () => {
    if (busy || count === 0) return;
    // SRC-161:REQ-005 (T-240): this one action runs on the first click. What it will
    // do is already on the button's own tooltip, and one Ctrl+Z brings the archive
    // back, so a dialog here was a second gate on a reversible tidy-up. Every other
    // confirmation in the app is untouched.
    setBusy(true);
    playZaicodeSound("ui.toggle");
    try {
      const result = await runZaicodeClearAllDone({
        plan: plan.runnable,
        archive: (byProject) => archiveZaicodeSessions(byProject),
        send: async (entry) => {
          const handle = zaicodeProjectContinueHandle(entry.projectKey);
          if (!handle) throw new Error("its project row disconnected before the send");
          // send() resolving means the host accepted the command; it is not a
          // claim that the session finished (T-299).
          await handle.send(entry.sessionId, entry.command);
        },
        remaining: () =>
          planZaicodeClearAllDone(
            useZaicodeSessionBriefs.getState().sessions,
            new Set(Object.values(useZaicodeMainSessions.getState().byWorkspace)),
            (key) => useZaicodeHomeProjects.getState().rows[key]?.hasSaipen ?? true,
          ),
      });
      toast(formatZaicodeClearDoneRun(result), { durationMs: 8000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={cn(
        "flex h-6 items-center gap-0.5 border px-1 text-ui-xs",
        count > 0 ? "border-[var(--zaicode-highlight,var(--color-border-hover))] text-foreground hover:bg-hover" : "border-border text-foreground-subtlest",
      )}
      disabled={busy || count === 0}
      title={`CLEAR ALL DONE — actionable sessions that CAN run now (not completed work)\n${describe(plan)}`}
      onClick={() => void run()}
      data-zaicode-clear-all-done={count}
      data-zaicode-clear-all-blocked={blockedCount}
      data-zaicode-clear-all-busy={busy ? 1 : 0}
    >
      <BrushCleaning className="size-3.5" />
      {count > 0 ? <span className="tabular-nums">{count}</span> : null}
    </button>
  );
}
