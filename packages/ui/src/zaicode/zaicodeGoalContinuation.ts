import { useEffect } from "react";
import { logger } from "@/logger.js";
import {
  decideZaicodeSessionContinue,
  useZaicodeSessionBriefs,
  useZaicodeContinueHandlesVersion,
  type ZaicodeSessionBrief,
} from "./zaicodeContinue.js";
import { zaicodeContinueHandleFor } from "./zaicodeContinueHost.js";
import { useZaicodeAutoGoal, zaicodeAutoGoalEnabled } from "./zaicodeAutoGoal.js";
import {
  claimZaicodeGoalContinuation,
  failZaicodeGoalContinuation,
  isZaicodeGoalTerminal,
  noteZaicodeGoalSawRunning,
  noteZaicodeGoalHandback,
  observeZaicodeGoalFromBrief,
  settleZaicodeGoalContinuation,
  spendZaicodeGoalSawRunning,
  useZaicodeGoalVersion,
  zaicodeGoalAllIntents,
  zaicodeGoalContinuationAllowed,
  zaicodeGoalHandbackKind,
  zaicodeGoalHandbackStands,
  zaicodeGoalIntentById,
  zaicodeGoalRestoredOpportunity,
  zaicodeGoalSawRunning,
} from "./zaicodeGoalSupervisor.js";
import { useZaicodeHomeProjects } from "./home/ZaicodeHomeFleet.js";
import { useZaicodeRetryLedger } from "./zaicodeRetryPolicy.js";
import { isZaicodeCleanupInProgress, isSessionRetired } from "./zaicodeCleanupFence.js";

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
 * Restored idle active goals receive one opportunity from the persisted brief.
 * New submissions wait for their observed turn to end. The synchronous claim,
 * stable command id and final idle admission prevent duplicate sends; STOP,
 * waiting, terminal/budget states and disabled projects remain authoritative.
 * Error recovery stays with the retry watch; non-goal crashes with crash resume.
 */

/**
 * T-283 (SAIHANDOFF F-03): the producer identity stamped on every automatic
 * continuation. The persisted classification then names WHO sent the input, not
 * only what it was, so a capture can attribute it without text sniffing.
 */
export const AUTO_GOAL_CONTINUATION_PRODUCER_ID = "zaicode-goal-continuation";

function briefFor(
  intentProjectKey: string,
  sessionId: string | null,
  objective: string,
  sessions: readonly ZaicodeSessionBrief[],
): ZaicodeSessionBrief | null {
  return sessions.find((session) => session.projectKey === intentProjectKey &&
    (!sessionId || session.sessionId === sessionId) && session.goalObjective?.trim() === objective) ?? null;
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
  const projectRows = useZaicodeHomeProjects((state) => state.rows);
  const handlesVersion = useZaicodeContinueHandlesVersion();

  useEffect(() => {
    void goalVersion;
    if (isZaicodeCleanupInProgress()) return;
    const autoGoalState = useZaicodeAutoGoal.getState();
    // 全局监督器必须恢复隐藏项目；只遍历 composer 已注册的 intent 会让重开项目永远停住。
    for (const brief of sessions) {
      if (isSessionRetired(brief.sessionId)) continue;
      observeZaicodeGoalFromBrief(brief, zaicodeAutoGoalEnabled(autoGoalState, brief.projectKey));
    }
    for (const intent of zaicodeGoalAllIntents()) {
      if (isSessionRetired(intent.sessionId)) continue;
      if (isZaicodeGoalTerminal(intent.outcome)) continue;
      const brief = briefFor(intent.projectKey, intent.sessionId, intent.objective, sessions);
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
      const projectRow = projectRows[intent.projectKey] ?? null;
      // T-282 (SAIHANDOFF F-02): the authoritative state this decision is taken at.
      // A handback already delivered at this exact state (objective + revision) is a
      // wall: the audit's blocked goal row stayed active while SAIPEN had already
      // answered RESTATE_AND_STOP, and every reload re-armed the same goal.
      const handbackState = { objective: current.objective, revision: String(brief.updatedAt) };
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
        handbackStands: zaicodeGoalHandbackStands(current.intentId, handbackState),
        sawRunning: zaicodeGoalSawRunning(current.intentId),
        restored: zaicodeGoalRestoredOpportunity(current.intentId),
        pending: current.pending === true,
      });
      if (!decision.allowed) {
        // One blocker handback, then silence: remember the state it was delivered
        // at. Recorded only when the GOAL's own disposition is what stopped the
        // send -- an operator switch (Auto Goal off, stop-all, disabled project) is
        // their own decision and must not pretend a handback was handed back.
        const handback = zaicodeGoalHandbackKind({ goalStatus: brief.goalStatus, outcome: current.outcome });
        const goalStoppedTheSend = autoGoalOn && !halted && projectRow?.disabled !== true &&
          !brief.running && !brief.waiting && !brief.failed;
        if (handback && goalStoppedTheSend) {
          noteZaicodeGoalHandback(current.intentId, { kind: handback, ...handbackState });
        }
        continue;
      }
      const handle = zaicodeContinueHandleFor({
        key: intent.projectKey,
        path: brief.workspacePath,
        ...(brief.workspaceIdentity ? { identity: brief.workspaceIdentity } : {}),
      });
      // 启动时连接可能晚于 brief；等待连接通知，不能先消耗恢复机会和预算。
      if (!handle) continue;
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
      const intentId = current.intentId;
      logger.info("[zaicode] Auto Goal continuation", {
        sessionId: brief.sessionId,
        projectKey: intent.projectKey,
        attempt: claim.intent.continuations,
        why: decision.reason,
      });
      void handle
        .send(brief.sessionId, send.command, {
          idleOnly: true,
          commandId: `auto-goal:${current.intentId}:${brief.updatedAt}`,
          // T-283 (SAIHANDOFF F-03): the audit saw this same send arrive as
          // `semantics.origin: real_user` / `kind: user_prompt`, i.e. an
          // automatic continuation indistinguishable from a fresh human
          // decision. The transport stays model-compatible; the origin is now
          // declared, and `originalUserIntentId` keeps the human goal this
          // continuation belongs to traceable. This is not a new human intent.
          inputProvenance: {
            origin: "agent_runtime",
            source: "goal_autocontinuation",
            originalUserIntentId: current.intentId,
            goalIntentId: current.intentId,
            producerId: AUTO_GOAL_CONTINUATION_PRODUCER_ID,
          },
          canDispatch: () => {
            const liveIntent = zaicodeGoalIntentById(intentId);
            const liveBrief = useZaicodeSessionBriefs.getState().sessions.find((row) => row.sessionId === brief.sessionId && row.projectKey === intent.projectKey);
            if (!liveIntent?.pending || liveIntent.stopped || isZaicodeGoalTerminal(liveIntent.outcome) ||
              liveIntent.lastContinuationAt !== claim.intent.lastContinuationAt || !liveBrief ||
              liveBrief.goalObjective?.trim() !== current.objective || liveBrief.manuallyStopped) return false;
            return zaicodeGoalContinuationAllowed({
              autoGoalOn: zaicodeAutoGoalEnabled(useZaicodeAutoGoal.getState(), intent.projectKey),
              halted: useZaicodeRetryLedger.getState().halted,
              projectDisabled: useZaicodeHomeProjects.getState().rows[intent.projectKey]?.disabled === true,
              running: liveBrief.running,
              waiting: liveBrief.waiting,
              failed: liveBrief.failed,
              goalOpen: liveBrief.goalStatus === "active",
              handbackStands: zaicodeGoalHandbackStands(intentId, {
                objective: current.objective,
                revision: String(liveBrief.updatedAt),
              }),
              sawRunning: true,
              pending: false,
            }).allowed;
          },
        })
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
  }, [sessions, autoGoalOff, halted, goalVersion, projectRows, handlesVersion]);
}
