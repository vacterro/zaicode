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
import {
  currentZaicodeRetrySafety,
  writeZaicodeRetrySafety,
  type ZaicodeQueueRetryEpisode,
} from "./zaicodeRetrySafety.js";
import { isZaicodeCleanupInProgress } from "./zaicodeCleanupFence.js";

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
 *
 * T-360: Retry episodes are tracked explicitly per (sessionId, queueHeadId).
 * setAutoDrain(true) is only permission to drain, not proof that promotion succeeded;
 * therefore autoDrain === true does NOT clear the retry budget. An episode is only
 * cleared when the queue truly drains (queueItems === 0), when the queue head item
 * changes, or when the operator explicitly resumes.
 */

const episodesBySession = new Map<string, ZaicodeQueueRetryEpisode>(
  Object.entries(currentZaicodeRetrySafety().queueEpisodes ?? {}),
);

/** Resumes per session in a row; a queue that drains (or a clean finish) starts the count again. */
const resumesBySession = new Map<string, number>(
  Object.entries(currentZaicodeRetrySafety().queueResumes),
);

export function zaicodeQueueResumeAttempts(sessionId: string): number {
  const fromEpisode = episodesBySession.get(sessionId)?.attempts;
  if (fromEpisode !== undefined) return fromEpisode;
  const fromResumes = resumesBySession.get(sessionId);
  if (fromResumes !== undefined) return fromResumes;
  const safety = currentZaicodeRetrySafety();
  return safety.queueEpisodes?.[sessionId]?.attempts ?? safety.queueResumes[sessionId] ?? 0;
}

export function recordZaicodeQueueResumeAttempt(
  sessionId: string,
  params: {
    projectKey?: string;
    queueHeadId?: string;
    attempts?: number;
    pauseReasonCode?: string | null;
  } = {},
): number {
  const currentAttempts = zaicodeQueueResumeAttempts(sessionId);
  const nextAttempts = params.attempts ?? currentAttempts + 1;
  const episode: ZaicodeQueueRetryEpisode = {
    sessionId,
    projectKey: params.projectKey,
    queueHeadId: params.queueHeadId ?? "unknown",
    attempts: nextAttempts,
    lastReasonCode: params.pauseReasonCode ?? null,
    lastAttemptAt: Date.now(),
  };
  episodesBySession.set(sessionId, episode);
  resumesBySession.set(sessionId, nextAttempts);
  writeZaicodeRetrySafety({
    queueResumes: Object.fromEntries(resumesBySession),
    queueEpisodes: Object.fromEntries(episodesBySession),
  });
  return nextAttempts;
}

export function resetZaicodeQueueResume(sessionId: string): void {
  episodesBySession.delete(sessionId);
  resumesBySession.delete(sessionId);
  writeZaicodeRetrySafety({
    queueResumes: Object.fromEntries(resumesBySession),
    queueEpisodes: Object.fromEntries(episodesBySession),
  });
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

export type QueuePauseClassification =
  | "transient"
  | "wait_for_condition"
  | "permanent"
  | "operator_required"
  | "unknown";

export const PERMANENT_REASON_CODES = new Set([
  "operator_stopped",
  "guard.recognizedContinueSaipenValve",
  "guard.recognizedContinueAuthorizationExpired",
  "guard.recognizedContinuePlanMode",
  "guard.recognizedContinueWithoutGoal",
  "guard.recognizedContinueGoalComplete",
  "guard.recognizedContinueBudgetExhausted",
  "guard.recognizedContinueNoOwner",
  "guard.recognizedContinueSaipenRefused",
  "emptyObjective",
]);

export const OPERATOR_REQUIRED_REASON_CODES = new Set([
  "operator_paused",
  "guard.recognizedContinueSaipenOperator",
]);

export const WAIT_FOR_CONDITION_REASON_CODES = new Set([
  "quota_wall",
  "quota_exceeded",
  "rate_limit",
  "resource_exhausted",
  "host_reconnecting",
]);

export const TRANSIENT_REASON_CODES = new Set([
  "promotion_failed",
  "guard.recognizedContinueSessionBusy",
  "guard.recognizedContinueResumeFailed",
  "guard.recognizedContinueRouterUnavailable",
  "transport_disconnect",
  "network_error",
  "temporary_unavailable",
]);

export const NON_RECOVERABLE_QUEUE_REASONS = new Set([
  "stopped",
  "manual",
]);

export const NON_RECOVERABLE_REASON_CODES = new Set([
  ...PERMANENT_REASON_CODES,
  ...OPERATOR_REQUIRED_REASON_CODES,
]);

export function classifyQueuePause(facts: {
  pauseReason?: string | null;
  pauseOrigin?: "user" | "system" | string | null;
  pauseReasonCode?: string | null;
  quotaWall?: boolean;
}): QueuePauseClassification {
  if (facts.quotaWall) return "wait_for_condition";
  if (facts.pauseReason === "stopped" || facts.pauseReasonCode === "operator_stopped") return "permanent";
  if (facts.pauseOrigin === "user" || facts.pauseReason === "manual" || facts.pauseReasonCode === "operator_paused") return "operator_required";

  const code = facts.pauseReasonCode;
  if (!code) {
    if (facts.pauseReason === "error" || facts.pauseReason === "system_error" || facts.pauseOrigin === "system") {
      return "transient";
    }
    return "unknown";
  }

  if (OPERATOR_REQUIRED_REASON_CODES.has(code)) return "operator_required";
  if (PERMANENT_REASON_CODES.has(code)) return "permanent";
  if (WAIT_FOR_CONDITION_REASON_CODES.has(code)) return "wait_for_condition";
  if (TRANSIENT_REASON_CODES.has(code)) return "transient";

  if (code.startsWith("validation.") || code.startsWith("auth.") || code.startsWith("security.")) {
    return "permanent";
  }
  if (code.startsWith("guard.")) {
    return "permanent";
  }

  if (facts.pauseReason === "error" || facts.pauseReason === "system_error" || facts.pauseOrigin === "system") {
    return "transient";
  }

  return "unknown";
}

export function isQueuePauseRecoverable(facts: {
  pauseReason?: string | null;
  pauseOrigin?: "user" | "system" | string | null;
  pauseReasonCode?: string | null;
  quotaWall?: boolean;
}): boolean {
  if (facts.pauseReason !== "error" && facts.pauseReason !== "system_error") {
    if (facts.pauseReason === "stopped" || facts.pauseReason === "manual") {
      return false;
    }
  }
  return classifyQueuePause(facts) === "transient";
}

/** Pure: should an error-paused queue resume by itself now? */
export function zaicodeQueueMayAutoResume(facts: ZaicodeQueueResumeFacts): boolean {
  if (isZaicodeCleanupInProgress()) return false;
  if (!facts.hasSession || facts.queueItems === 0 || facts.autoDrain) return false;
  if (!isQueuePauseRecoverable(facts)) return false;
  if (facts.phase === "running" || facts.phase === "prewarming") return false;
  if (facts.quotaWall || !facts.mayAutoSend) return false;
  return facts.attempts < facts.maxAttempts;
}

/**
 * The one gate this owner asks before it resumes an error-paused queue.
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

  // Episode lifecycle management:
  // A truly drained queue (queueItems === 0 && phase !== null) clears the episode.
  // A queue head item replacement (queueItemId !== episode.queueHeadId) resets the episode for the new item.
  // CRITICAL: autoDrain === true does NOT clear the episode; setAutoDrain(true) is only permission to drain.
  useEffect(() => {
    if (!sessionId || phase === null) return;
    if (queueItems === 0) {
      if (episodesBySession.has(sessionId) || resumesBySession.has(sessionId)) {
        episodesBySession.delete(sessionId);
        resumesBySession.delete(sessionId);
        writeZaicodeRetrySafety({
          queueResumes: Object.fromEntries(resumesBySession),
          queueEpisodes: Object.fromEntries(episodesBySession),
        });
      }
    } else if (queueItemId) {
      const current = episodesBySession.get(sessionId);
      if (current && current.queueHeadId !== queueItemId) {
        episodesBySession.delete(sessionId);
        resumesBySession.delete(sessionId);
        writeZaicodeRetrySafety({
          queueResumes: Object.fromEntries(resumesBySession),
          queueEpisodes: Object.fromEntries(episodesBySession),
        });
      }
    }
  }, [phase, queueItemId, queueItems, sessionId]);

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
    const delay = zaicodeRetryDelayMs(Math.min(intervalSec, 20));
    const at = Date.now() + delay;
    useZaicodeRetryLedger.getState().set({ sessionId, title: "queued message", nextAt: at, attempt: attempts + 1, source: "chat" });
    const timer = window.setTimeout(() => {
      if (isZaicodeAutoRetryStoppedForSession(sessionId) || !zaicodeQueueAutoSendAllowed({
        enabled, halted: useZaicodeRetryLedger.getState().halted, projectKey, sessionId,
        prefs: useZaicodeUiPrefs.getState(), sessionMode: zaicodeAutoContinueModeFor(sessionId),
      })) return;

      const nextAttempts = recordZaicodeQueueResumeAttempt(sessionId, {
        projectKey,
        queueHeadId: queueItemId ?? "unknown",
        attempts: attempts + 1,
        pauseReasonCode,
      });

      useZaicodeRetryLedger.getState().clear(sessionId);
      logger.info("[zaicode] queue auto-resume", {
        sessionId,
        queueItemId: queueItemId ?? null,
        pauseOrigin: pauseOrigin ?? "system",
        reasonCode: pauseReasonCode ?? null,
        originatingCommand: originatingCommand ?? null,
        hostAcknowledgement: "pending_resume",
        recoveryEligibility: true,
        attempt: nextAttempts,
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
