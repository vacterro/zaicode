import { useEffect } from "react";
import type { SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useZaicodeAutoContinue, zaicodeAutoContinueModeFor, type ZaicodeAutoContinueMode } from "./zaicodeAutoContinue.js";
import {
  useZaicodeRetryLedger,
  zaicodeEffectiveAutoRetry,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
  type ZaicodeAutoRetryPrefs,
} from "./zaicodeRetryPolicy.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";
import { isZaicodeAutoRetryStoppedForSession } from "./zaicodeAutoRetry.js";
import { currentZaicodeRetrySafety, writeZaicodeRetrySafety } from "./zaicodeRetrySafety.js";

/**
 * SRC-081: "The queue was paused because the response failed: none of the promised
 * autonomy, no auto-continue in that case." A queued message (/goal cc all) sat behind
 * "Continue" until a person pressed it, even with Auto ON.
 *
 * An error-paused queue resumes by itself once the session is idle, under the SAME
 * effective retry projection as every other automatic send (zaicodeEffectiveAutoRetry:
 * the session's own mode, stop-all and the project/session/global retry
 * preference): one nominal interval per resume, at most ZAICODE_AUTO_RETRY_HARD_CAP resumes in a row, never
 * after a usage-limit wall, visible in the sidebar ledger, and one click there stops it.
 * A queue the operator paused by pressing Stop is never resumed here, and an operator who
 * turned retry off for this project or session is never resumed behind their back.
 */

/** Resumes per session in a row; a queue that drains (or a clean finish) starts the count again. */
const resumesBySession = new Map<string, number>(Object.entries(currentZaicodeRetrySafety().queueResumes));

export function zaicodeQueueResumeAttempts(sessionId: string): number {
  return resumesBySession.get(sessionId) ?? 0;
}

export interface ZaicodeQueueResumeFacts {
  hasSession: boolean;
  queueItems: number;
  autoDrain: boolean;
  pauseReason: string | null | undefined;
  pauseOrigin?: "user" | "system" | string | null;
  pauseReasonCode?: string | null;
  queueItemId?: string | null;
  originatingCommand?: string | null;
  phase: SessionPhase | null;
  /** The last error is a usage-limit wall. */
  quotaWall: boolean;
  mayAutoSend: boolean;
  attempts: number;
  maxAttempts: number;
}

import { isZaicodeCleanupInProgress } from "./zaicodeCleanupFence.js";

export const NON_RECOVERABLE_QUEUE_REASONS = new Set([
  "stopped",
  "manual",
]);

export const NON_RECOVERABLE_REASON_CODES = new Set([
  "operator_paused",
  "operator_stopped",
  "guard.recognizedContinueSaipenOperator",
  "guard.recognizedContinueSaipenValve",
  "guard.recognizedContinueAuthorizationExpired",
  "guard.recognizedContinuePlanMode",
  "guard.recognizedContinueBudgetExhausted",
  "guard.recognizedContinueWithoutGoal",
  "guard.recognizedContinueGoalComplete",
]);

export function isQueuePauseRecoverable(facts: {
  pauseReason?: string | null;
  pauseOrigin?: "user" | "system" | string | null;
  pauseReasonCode?: string | null;
}): boolean {
  if (facts.pauseOrigin === "user") return false;
  if (facts.pauseReason && NON_RECOVERABLE_QUEUE_REASONS.has(facts.pauseReason)) return false;
  if (facts.pauseReasonCode && NON_RECOVERABLE_REASON_CODES.has(facts.pauseReasonCode)) return false;
  return facts.pauseReason === "error" || facts.pauseReason === "system_error" || facts.pauseOrigin === "system";
}

/** Pure: should an error-paused queue resume by itself now? */
export function zaicodeQueueMayAutoResume(facts: ZaicodeQueueResumeFacts): boolean {
  if (isZaicodeCleanupInProgress()) return false;
  if (!facts.hasSession || facts.queueItems === 0 || facts.autoDrain) return false;
  if (!isQueuePauseRecoverable(facts)) return false;
  if (facts.pauseReason !== "error" && facts.pauseReason !== "system_error" && facts.pauseOrigin !== "system") return false;
  if (facts.phase === "running" || facts.phase === "prewarming") return false;
  if (facts.quotaWall || !facts.mayAutoSend) return false;
  return facts.attempts < facts.maxAttempts;
}

/**
 * The one gate this owner asks before it resumes an error-paused queue.
 *
 * SRC-081 put the queue under "the same leash as every automatic retry
 * (zaicodeRetryPolicy)". The other three automatic-send owners -- the open chat's
 * countdown, the background retry host and the crash resume -- ask
 * zaicodeEffectiveAutoRetry. This owner asked zaicodeMayAutoSend instead, which
 * answers a different question: a session whose own auto-continue is explicitly On
 * was allowed to resume the queue while the Auto Retry surface reported "off" from
 * the project/session/global retry preference, and an explicit per-project retry ON
 * was ignored because that gate only saw the global flag. Two answers to one
 * question is the defect; this is the single answer, and it is the conservative one
 * -- the operator's explicit OFF wins.
 */
export function zaicodeQueueAutoSendAllowed(input: {
  enabled: boolean;
  halted: boolean;
  projectKey: string;
  sessionId: string | null;
  prefs: ZaicodeAutoRetryPrefs;
  sessionMode: ZaicodeAutoContinueMode | undefined;
}): boolean {
  if (!input.enabled || input.halted) return false;
  return zaicodeEffectiveAutoRetry(input.prefs, input.projectKey, input.sessionId, {
    sessionMode: input.sessionMode,
    halted: input.halted,
  }).enabled;
}

export function useZaicodeQueueAutoResume(params: {
  enabled: boolean;
  sessionId: string | null;
  /** The project that owns the session: the retry preference is scoped to it. */
  projectKey: string;
  queueItems: number;
  autoDrain: boolean;
  pauseReason: string | null | undefined;
  pauseOrigin?: "user" | "system" | string | null;
  pauseReasonCode?: string | null;
  queueItemId?: string | null;
  originatingCommand?: string | null;
  phase: SessionPhase | null;
  quotaWall: boolean;
  resume: () => Promise<unknown> | void;
}): void {
  const {
    enabled,
    sessionId,
    projectKey,
    queueItems,
    autoDrain,
    pauseReason,
    pauseOrigin,
    pauseReasonCode,
    queueItemId,
    originatingCommand,
    phase,
    quotaWall,
    resume,
  } = params;
  const autoRetry = useZaicodeUiPrefs((state) => state.autoRetry);
  const autoRetryScope = useZaicodeUiPrefs((state) => state.autoRetryScope);
  const autoRetryProjects = useZaicodeUiPrefs((state) => state.autoRetryProjects);
  const autoRetrySessions = useZaicodeUiPrefs((state) => state.autoRetrySessions);
  const intervalSec = useZaicodeUiPrefs((state) => state.autoRetryIntervalSec);
  const maxAttempts = zaicodeRetryLimit(useZaicodeUiPrefs((state) => state.autoRetryMaxAttempts));
  const sessionMode = useZaicodeAutoContinue((state) => (sessionId ? state.modes[sessionId] : undefined));
  const halted = useZaicodeRetryLedger((state) => state.halted);

  // A drained queue or a clean finish starts the count again.
  useEffect(() => {
    // T-240：首帧到达前的默认空队列不是事实，不能清掉刚恢复的持久预算。
    if (sessionId && phase !== null && (autoDrain || queueItems === 0) && resumesBySession.delete(sessionId)) {
      writeZaicodeRetrySafety({ queueResumes: Object.fromEntries(resumesBySession) });
    }
  }, [autoDrain, phase, queueItems, sessionId]);

  const attempts = sessionId ? zaicodeQueueResumeAttempts(sessionId) : 0;
  const allowed = zaicodeQueueMayAutoResume({
    hasSession: Boolean(sessionId),
    queueItems,
    autoDrain,
    pauseReason,
    pauseOrigin,
    pauseReasonCode,
    queueItemId,
    originatingCommand,
    phase,
    quotaWall,
    mayAutoSend: !(sessionId && isZaicodeAutoRetryStoppedForSession(sessionId)) && zaicodeQueueAutoSendAllowed({
      enabled,
      halted,
      projectKey,
      sessionId,
      prefs: { autoRetry, autoRetryScope, autoRetryProjects, autoRetrySessions },
      sessionMode,
    }),
    attempts,
    maxAttempts,
  });

  useEffect(() => {
    if (!allowed || !sessionId) return undefined;
    // T-302: one nominal interval, no 2^attempts ladder (a queued resume waited as long
    // as a turn retry's sixth attempt).
    const delay = zaicodeRetryDelayMs(Math.min(intervalSec, 20));
    const at = Date.now() + delay;
    useZaicodeRetryLedger.getState().set({ sessionId, title: "queued message", nextAt: at, attempt: attempts + 1, source: "chat" });
    const timer = window.setTimeout(() => {
      // T-240：停止错误或 stop-all 可能晚于排队；发送前必须重新读取同一个权限所有者。
      if (isZaicodeAutoRetryStoppedForSession(sessionId) || !zaicodeQueueAutoSendAllowed({
        enabled, halted: useZaicodeRetryLedger.getState().halted, projectKey, sessionId,
        prefs: useZaicodeUiPrefs.getState(), sessionMode: zaicodeAutoContinueModeFor(sessionId),
      })) return;
      resumesBySession.set(sessionId, (resumesBySession.get(sessionId) ?? 0) + 1);
      writeZaicodeRetrySafety({ queueResumes: Object.fromEntries(resumesBySession) });
      useZaicodeRetryLedger.getState().clear(sessionId);
      logger.info("[zaicode] queue auto-resume", {
        sessionId,
        queueItemId: queueItemId ?? null,
        pauseOrigin: pauseOrigin ?? "system",
        reasonCode: pauseReasonCode ?? null,
        originatingCommand: originatingCommand ?? null,
        hostAcknowledgement: "pending_resume",
        recoveryEligibility: true,
        attempt: attempts + 1,
      });
      void Promise.resolve(resume()).catch((error: unknown) =>
        logger.warn("[zaicode] queue auto-resume failed", { error: error instanceof Error ? error.message : String(error) }),
      );
    }, delay);
    return () => {
      window.clearTimeout(timer);
      useZaicodeRetryLedger.getState().clear(sessionId);
    };
  }, [allowed, attempts, enabled, intervalSec, originatingCommand, pauseOrigin, pauseReasonCode, projectKey, queueItemId, resume, sessionId]);
}
