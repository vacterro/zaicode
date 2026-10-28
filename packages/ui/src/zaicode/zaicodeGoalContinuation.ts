import { useEffect } from "react";
import { logger } from "@/logger.js";
import {
  decideZaicodeSessionContinue,
  useZaicodeSessionBriefs,
  type ZaicodeSessionBrief,
} from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import { useZaicodeAutoGoal, zaicodeAutoGoalEnabled } from "./zaicodeAutoGoal.js";
import {
  claimZaicodeGoalContinuation,
  failZaicodeGoalContinuation,
  isZaicodeGoalTerminal,
  noteZaicodeGoalSawRunning,
  observeZaicodeGoalFromBrief,
  settleZaicodeGoalContinuation,
  spendZaicodeGoalSawRunning,
  useZaicodeGoalVersion,
  zaicodeGoalAllIntents,
  zaicodeGoalContinuationAllowed,
  zaicodeGoalSawRunning,
} from "./zaicodeGoalSupervisor.js";
import { useZaicodeHomeProjects } from "./home/ZaicodeHomeFleet.js";
import { useZaicodeRetryLedger } from "./zaicodeRetryPolicy.js";

/**
 * T-234: the production continuation OWNER for Auto Goal.
 *
 * T-222 built the supervision state (zaicodeGoalSupervisor: one intent per submitted
 * prompt, the outcome fold, mayContinueZaicodeGoal, recordZaicodeGoalContinuation) and
 * the composer registers an intent on submit -- but nothing ever asked whether an
 * open goal should be taken up again. `mayContinueZaicodeGoal` had no caller in
 * production, so Auto Goal only ever appended "/goal cc all" to the outgoing prompt:
 * a false-green architecture that promised an end-to-end continuation it never did.
 *
 * This is that owner, and there is exactly one. It sits outside React's render path
 * (mounted once by ZaicodeAppRuntime beside the crash resume and the retry watch),
 * observes the end of the agent turn, and sends through the SAME canonical path as
 * every other ZAICODE send -- zaicodeContinueHandleFor(...).send(sessionId, command),
 * which is what the crash resume, CONTINUE ALL and the row's START use: resumeTask
 * then one v4 envelope with heldQueueDisposition "keepQueueAndSend", so a held queue
 * is kept, exactly like the composer.
 *
 * What it will not do, stated so it cannot drift:
 *   - it invents no evidence. A brief that was never seen running here arms nothing,
 *     and a goal SAIPEN reports as paused, budget-limited or complete is exposed (the
 *     Auto-Goal tooltip), never continued.
 *   - it does not retry on a timer: a rejected send releases its claim and waits for
 *     the next real turn end, so nothing polls a host that keeps saying no.
 *   - it does not fight the other automatic owners: a running or waiting session is
 *     left alone, an error-failed turn belongs to the retry watch, an error-paused
 *     queue belongs to the queue resume, a crash-cut session belongs to the crash
 *     resume, and the sidebar's stop-all stops this too.
 *   - it does not double-send: the claim is synchronous, and the evidence it spends
 *     is re-armed only by a new observed turn (or a window reload, which also drops
 *     the claim -- so a restart cannot replay a continuation).
 */

function briefFor(
  intentProjectKey: string,
  sessionId: string | null,
  sessions: readonly ZaicodeSessionBrief[],
): ZaicodeSessionBrief | null {
  if (sessionId) return sessions.find((session) => session.sessionId === sessionId) ?? null;
  return sessions.find((session) => session.projectKey === intentProjectKey) ?? null;
}

/**
 * Mount once (ZaicodeAppRuntime, beside the crash resume and the retry watch).
 * Runs on every published brief, switch or intent change; the claim makes a re-run
 * harmless, which is why no polling loop is needed -- the briefs ARE the clock.
 */
export function useZaicodeGoalContinuation(): void {
  const sessions = useZaicodeSessionBriefs((state) => state.sessions);
  const autoGoalOff = useZaicodeAutoGoal((state) => state.off);
  const halted = useZaicodeRetryLedger((state) => state.halted);
  const goalVersion = useZaicodeGoalVersion();

  useEffect(() => {
    void goalVersion;
    const autoGoalState = useZaicodeAutoGoal.getState();
    for (const intent of zaicodeGoalAllIntents()) {
      if (isZaicodeGoalTerminal(intent.outcome)) continue;
      const brief = briefFor(intent.projectKey, intent.sessionId, sessions);
      if (!brief) continue;
      const autoGoalOn = zaicodeAutoGoalEnabled(autoGoalState, intent.projectKey);
      // Fold the authoritative SAIPEN facts first: the outcome (active / waiting /
      // blocked / complete) comes from the brief's goalStatus, never from chat text.
      const current =
        observeZaicodeGoalFromBrief(
          {
            sessionId: brief.sessionId,
            projectKey: brief.projectKey,
            running: brief.running,
            waiting: brief.waiting,
            manuallyStopped: brief.manuallyStopped,
            goalStatus: brief.goalStatus,
            goalObjective: brief.goalObjective,
          },
          autoGoalOn,
        ) ?? intent;
      if (isZaicodeGoalTerminal(current.outcome)) continue;
      // Evidence: this session has worked since the goal was submitted. Every real
      // turn end re-arms the next one, so two ends of one turn cannot send twice.
      if (brief.running) {
        noteZaicodeGoalSawRunning(current.intentId);
        continue;
      }
      const projectRow = useZaicodeHomeProjects.getState().rows[intent.projectKey] ?? null;
      const decision = zaicodeGoalContinuationAllowed({
        autoGoalOn,
        halted,
        projectDisabled: projectRow?.disabled === true,
        running: brief.running,
        waiting: brief.waiting,
        failed: brief.failed,
        // SAIPEN's own goal, still open. A session whose goal is missing from
        // tasks-index is not continued: "nothing proved it open" is not "it is open".
        goalOpen: brief.goalStatus === "active",
        sawRunning: zaicodeGoalSawRunning(current.intentId),
        pending: current.pending === true,
      });
      if (!decision.allowed) continue;
      const claim = claimZaicodeGoalContinuation(current.intentId);
      if (!claim.claimed) continue;
      // One turn end = one continuation: spend the evidence here.
      spendZaicodeGoalSawRunning(current.intentId);
      // The SAME decision vocabulary and the SAME send path the operator's ▶ uses.
      const send = decideZaicodeSessionContinue(
        {
          running: brief.running,
          waiting: brief.waiting,
          goalStatus: brief.goalStatus,
          goalObjective: brief.goalObjective,
        },
        projectRow?.hasSaipen ?? true,
      );
      if (send.action !== "send") {
        // The planner disagreed with the owner's gate: fold back, spend nothing.
        failZaicodeGoalContinuation(current.intentId);
        continue;
      }
      const handle = zaicodeContinueHandleFor({
        key: intent.projectKey,
        path: brief.workspacePath,
        ...(brief.workspaceIdentity ? { identity: brief.workspaceIdentity } : {}),
      });
      if (!handle) {
        failZaicodeGoalContinuation(current.intentId);
        logger.warn("[zaicode] Auto Goal continuation: project not connected", {
          sessionId: brief.sessionId,
          projectKey: intent.projectKey,
        });
        continue;
      }
      const intentId = current.intentId;
      logger.info("[zaicode] Auto Goal continuation", {
        sessionId: brief.sessionId,
        projectKey: intent.projectKey,
        attempt: claim.intent.continuations,
        why: decision.reason,
      });
      void handle
        .send(brief.sessionId, send.command)
        .then(() => {
          settleZaicodeGoalContinuation(intentId);
        })
        .catch((error: unknown) => {
          failZaicodeGoalContinuation(intentId);
          logger.warn("[zaicode] Auto Goal continuation failed", {
            sessionId: brief.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }, [sessions, autoGoalOff, halted, goalVersion]);
}
