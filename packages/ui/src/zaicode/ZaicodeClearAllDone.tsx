import { useMemo, useState } from "react";
import { BrushCleaning } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useZaicodeHomeProjects } from "./home/ZaicodeHomeFleet.js";
import { archiveZaicodeSessions } from "./zaicodeArchiveUndo.js";
import {
  ZAICODE_CONTINUE_PLAIN_TEXT,
  ZAICODE_CONTINUE_SAIPEN_TEXT,
  useZaicodeSessionBriefs,
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

function describe(plan: ZaicodeClearDonePlan): string {
  if (plan.archive.length === 0 && plan.resume.length === 0) return "Nothing to clear: no finished or cut-off helper session.";
  return [
    `Archive ${plan.archive.length} finished helper session(s) (Ctrl+Z restores):`,
    ...plan.archive.map((entry) => `  ${entry.title}`),
    `Continue ${plan.resume.length} cut-off one(s) with cc / their goal:`,
    ...plan.resume.map((entry) => `  ${entry.title}`),
    "MAIN sessions, running ones and ones waiting for you stay as they are.",
  ].join("\n");
}

export function ZaicodeClearAllDoneButton() {
  const sessions = useZaicodeSessionBriefs((state) => state.sessions);
  const mains = useZaicodeMainSessions((state) => state.byWorkspace);
  const rows = useZaicodeHomeProjects((state) => state.rows);
  const [busy, setBusy] = useState(false);
  const plan = useMemo(
    () => planZaicodeClearAllDone(sessions, new Set(Object.values(mains)), (key) => rows[key]?.hasSaipen ?? true),
    [mains, rows, sessions],
  );
  const count = plan.archive.length + plan.resume.length;

  const run = async () => {
    if (busy || count === 0) return;
    if (!window.confirm(`CLEAR ALL DONE\n\n${describe(plan)}`)) return;
    setBusy(true);
    playZaicodeSound("ui.toggle");
    try {
      const byProject = new Map<string, string[]>();
      for (const entry of plan.archive) byProject.set(entry.projectKey, [...(byProject.get(entry.projectKey) ?? []), entry.sessionId]);
      const archived = await archiveZaicodeSessions(byProject);
      let resumed = 0;
      for (const entry of plan.resume) {
        const handle = zaicodeProjectContinueHandle(entry.projectKey);
        if (!handle) continue;
        await handle.send(entry.sessionId, entry.command).then(
          () => (resumed += 1),
          () => undefined,
        );
      }
      toast(`CLEAR ALL DONE: ${archived} archived (Ctrl+Z restores), ${resumed} continued`, { durationMs: 8000 });
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
      title={`CLEAR ALL DONE\n${describe(plan)}`}
      onClick={() => void run()}
      data-zaicode-clear-all-done={count}
    >
      <BrushCleaning className="size-3.5" />
      {count > 0 ? <span className="tabular-nums">{count}</span> : null}
    </button>
  );
}
