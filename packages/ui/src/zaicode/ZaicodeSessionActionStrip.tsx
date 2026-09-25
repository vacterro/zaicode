import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, FastForward } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import {
  ZaicodeHomeProjectProbes,
  useZaicodeHomeProjectInputs,
  useZaicodeHomeProjects,
} from "./home/ZaicodeHomeFleet.js";
import {
  describeZaicodeContinueStep,
  nextZaicodeDoneSession,
  planZaicodeContinueAll,
  runZaicodeContinuePlan,
  useZaicodeSessionBriefs,
  zaicodeDoneUnseen,
  type ZaicodeContinuePlan,
  type ZaicodeSessionBrief,
} from "./zaicodeContinue.js";
import { registerZaicodeHotkeyHandler } from "./zaicodeHotkeys.js";
import { useZaicodeMainSessions, zaicodeMainSessionKey } from "./zaicodeMainSession.js";
import { ZaicodeRightClickSettings } from "./ZaicodePrefControls.js";
import { openZaicodeSession, useZaicodeSessionNav } from "./zaicodeSessionNav.js";
import { playZaicodeSound } from "./zaicodeSoundBus.js";

/**
 * Two big sidebar buttons (SRC-043):
 * - CONTINUE ALL: the smart plan of zaicodeContinue.ts -- interrupted goals,
 *   failed turns, SAIPEN projects with open tickets; never a finished
 *   session, a running one, a switched-off project or a waiting question.
 * - DONE: the oldest finished session you have not looked at yet; opening it
 *   marks it seen, so the next press lands on the next one.
 * Right-click either one for the full list behind it.
 */

function planTooltip(plan: ZaicodeContinuePlan): string {
  const lines = plan.steps.length
    ? plan.steps.map(describeZaicodeContinueStep)
    : ["Nothing to continue: no stopped goal, no failed turn, no SAIPEN project with open tickets."];
  if (plan.skipped.length > 0) lines.push("", "Left alone:", ...plan.skipped.map((entry) => `${entry.name}: ${entry.why}`));
  return lines.join("\n");
}

function sessionLine(session: ZaicodeSessionBrief): string {
  const project = session.workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? session.workspacePath;
  return `${project} · ${session.title}`;
}

export function ZaicodeSessionActionStrip() {
  const projects = useZaicodeHomeProjectInputs();
  const rows = useZaicodeHomeProjects((state) => state.rows);
  const sessions = useZaicodeSessionBriefs((state) => state.sessions);
  const activeTaskId = useZaicodeSessionNav((state) => state.activeTaskId);
  const [running, setRunning] = useState(false);

  const plan = useMemo(
    () =>
      planZaicodeContinueAll(
        projects.map((project) => {
          const row = rows[project.key];
          return {
            key: project.key,
            name: project.name,
            disabled: row?.disabled ?? false,
            hasSaipen: row?.hasSaipen ?? false,
            state: row?.state ?? null,
            mainSessionId: row?.mainSessionId ?? null,
          };
        }),
        sessions,
      ),
    [projects, rows, sessions],
  );
  const done = useMemo(() => zaicodeDoneUnseen(sessions), [sessions]);
  // SRC-044: cut off mid-turn is never DONE; listed apart so it is not lost either.
  const interrupted = useMemo(() => sessions.filter((session) => session.interrupted), [sessions]);

  const continueAll = async () => {
    if (running || plan.steps.length === 0) return;
    setRunning(true);
    playZaicodeSound("ui.toggle");
    try {
      const outcome = await runZaicodeContinuePlan(plan);
      for (const started of outcome.started) {
        const project = projects.find((candidate) => candidate.key === started.projectKey);
        if (project) {
          useZaicodeMainSessions.getState().setMain(zaicodeMainSessionKey(project.path, project.identity), started.sessionId);
        }
      }
      const head = `CONTINUE ALL: ${outcome.sent.length} continued${outcome.failed.length ? `, ${outcome.failed.length} failed` : ""}`;
      toast([head, ...outcome.sent, ...outcome.failed].join("\n"), {
        durationMs: 10_000,
        ...(outcome.failed.length ? { variant: "warning" as const } : {}),
      });
    } finally {
      setRunning(false);
    }
  };

  const openNextDone = () => {
    const next = nextZaicodeDoneSession(done, activeTaskId);
    if (!next) return false;
    return openZaicodeSession({
      sessionId: next.sessionId,
      title: next.title,
      workspacePath: next.workspacePath,
      ...(next.workspaceIdentity ? { workspaceIdentity: next.workspaceIdentity } : {}),
    });
  };

  // Hotkeys read the latest plan / list through refs (the handlers register once).
  const actionsRef = useRef({ continueAll, openNextDone });
  actionsRef.current = { continueAll, openNextDone };
  useEffect(() => {
    const offs = [
      registerZaicodeHotkeyHandler("session.nextDone", () => void actionsRef.current.openNextDone()),
      registerZaicodeHotkeyHandler("session.continueAll", () => void actionsRef.current.continueAll()),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const big =
    "flex h-8 min-w-0 items-center justify-center gap-1.5 border px-2 text-ui-sm font-semibold disabled:cursor-default disabled:opacity-45";
  const count = (value: number) => <span className="tabular-nums">{value}</span>;

  return (
    <>
      {/* The verdicts CONTINUE ALL needs (SAIPEN open tickets, MAIN, switched off), shared with SAIHOME. */}
      <ZaicodeHomeProjectProbes projects={projects} />
      <div className="grid grid-cols-[1fr_auto] gap-1 px-2 pb-1.5" data-zaicode-session-actions="">
        <ZaicodeRightClickSettings
          title="CONTINUE ALL — what it will do"
          panel={<pre className="whitespace-pre-wrap text-foreground">{planTooltip(plan)}</pre>}
          className="flex w-full min-w-0"
        >
          <button
            type="button"
            className={cn(
              big,
              "w-full",
              plan.steps.length > 0
                ? "border-[var(--zaicode-highlight,var(--color-border-hover))] bg-selected text-foreground hover:bg-hover"
                : "border-border text-foreground-subtle",
            )}
            disabled={running || plan.steps.length === 0}
            title={`${planTooltip(plan)}\n\nRight-click: the same list · Alt+Click a session: continue just that one`}
            onClick={() => void continueAll()}
            data-zaicode-continue-all={plan.steps.length}
          >
            <FastForward className="size-4 shrink-0" />
            <span className="truncate">{running ? "CONTINUING…" : "CONTINUE ALL"}</span>
            {plan.steps.length > 0 ? count(plan.steps.length) : null}
          </button>
        </ZaicodeRightClickSettings>
        <ZaicodeRightClickSettings
          title="Finished, not seen yet"
          align="end"
          panel={
            done.length === 0 && interrupted.length === 0 ? (
              <span className="text-foreground-subtle">Nothing new: every finished session has been seen.</span>
            ) : (
              <div className="flex flex-col">
                {done.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    className="truncate px-1 py-0.5 text-left text-foreground hover:bg-hover"
                    onClick={() =>
                      openZaicodeSession({
                        sessionId: session.sessionId,
                        title: session.title,
                        workspacePath: session.workspacePath,
                        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
                      })
                    }
                  >
                    {sessionLine(session)}
                  </button>
                ))}
                {interrupted.length > 0 ? (
                  <>
                    <span className="mt-1 border-t border-border px-1 pt-1 text-[#e0a03c]">
                      INTERRUPTED — cut off mid-turn, not DONE (CONTINUE ALL / ▶ continues them)
                    </span>
                    {interrupted.map((session) => (
                      <button
                        key={session.sessionId}
                        type="button"
                        className="truncate px-1 py-0.5 text-left text-foreground hover:bg-hover"
                        onClick={() =>
                          openZaicodeSession({
                            sessionId: session.sessionId,
                            title: session.title,
                            workspacePath: session.workspacePath,
                            ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
                          })
                        }
                      >
                        ‖ {sessionLine(session)}
                      </button>
                    ))}
                  </>
                ) : null}
              </div>
            )
          }
        >
          <button
            type="button"
            className={cn(
              big,
              done.length > 0
                ? "border-[var(--color-success)] text-[var(--color-success)] hover:bg-hover"
                : "border-border text-foreground-subtle",
            )}
            disabled={done.length === 0}
            title={
              done.length > 0
                ? `Open the next finished session you have not seen (oldest first):\n${done.map(sessionLine).join("\n")}\n\nRight-click: pick one`
                : "Nothing new: every finished session has been seen."
            }
            onClick={() => void openNextDone()}
            data-zaicode-next-done={done.length}
          >
            <CheckCheck className="size-4 shrink-0" />
            DONE
            {count(done.length)}
            {interrupted.length > 0 ? (
              <span className="text-ui-xs font-normal text-[#e0a03c]" title={`${interrupted.length} interrupted (not DONE)`}>
                ‖{interrupted.length}
              </span>
            ) : null}
          </button>
        </ZaicodeRightClickSettings>
      </div>
    </>
  );
}
