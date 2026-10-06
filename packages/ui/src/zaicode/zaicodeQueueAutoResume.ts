import { useEffect } from "react";
import type { SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useZaicodeAutoContinue, type ZaicodeAutoContinueMode } from "./zaicodeAutoContinue.js";
import { useZaicodeAuditStore } from "./zaicodeAuditStore.js";
import {
  useZaicodeRetryLedger,
  zaicodeEffectiveAutoRetry,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
  type ZaicodeAutoRetryPrefs,
} from "./zaicodeRetryPolicy.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/**
 * SRC-081: "The queue was paused because the response failed: none of the promised
 * autonomy, no auto-continue in that case." A queued message (/goal cc all) sat behind
 * "Continue" until a person pressed it, even with Auto ON.
 *
 * An error-paused queue resumes by itself once the session is idle, under the SAME
 * effective retry projection as every other automatic send (zaicodeEffectiveAutoRetry:
 * the sidebar's Auto, the session's own mode and the project/session/global retry
 * preference): waits double, at most ZAICODE_AUTO_RETRY_HARD_CAP resumes in a row, never
 * after a usage-limit wall, visible in the sidebar ledger, and one click there stops it.
 * A queue the operator paused by pressing Stop is never resumed here, and an operator who
 * turned retry off for this project or session is never resumed behind their back.
 */

/** Resumes per session in a row; a queue that drains (or a clean finish) starts the count again. */
const resumesBySession = new Map<string, number>();

export function zaicodeQueueResumeAttempts(sessionId: string): number {
  return resumesBySession.get(sessionId) ?? 0;
}

export interface ZaicodeQueueResumeFacts {
  hasSession: boolean;
  queueItems: number;
  autoDrain: boolean;
  pauseReason: string | null | undefined;
  phase: SessionPhase | null;
  /** The last error is a usage-limit wall. */
  quotaWall: boolean;
  mayAutoSend: boolean;
  attempts: number;
  maxAttempts: number;
}

/** Pure: should an error-paused queue resume by itself now? */
export function zaicodeQueueMayAutoResume(facts: ZaicodeQueueResumeFacts): boolean {
  if (!facts.hasSession || facts.queueItems === 0 || facts.autoDrain) return false;
  if (facts.pauseReason !== "error") return false;
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
  masterOn: boolean;
  sessionMode: ZaicodeAutoContinueMode | undefined;
}): boolean {
  if (!input.enabled || input.halted) return false;
  return zaicodeEffectiveAutoRetry(input.prefs, input.projectKey, input.sessionId, {
    masterOn: input.masterOn,
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
  phase: SessionPhase | null;
  quotaWall: boolean;
  resume: () => Promise<unknown> | void;
}): void {
  const { enabled, sessionId, projectKey, queueItems, autoDrain, pauseReason, phase, quotaWall, resume } = params;
  const autoRetry = useZaicodeUiPrefs((state) => state.autoRetry);
  const autoRetryScope = useZaicodeUiPrefs((state) => state.autoRetryScope);
  const autoRetryProjects = useZaicodeUiPrefs((state) => state.autoRetryProjects);
  const autoRetrySessions = useZaicodeUiPrefs((state) => state.autoRetrySessions);
  const intervalSec = useZaicodeUiPrefs((state) => state.autoRetryIntervalSec);
  const maxAttempts = zaicodeRetryLimit(useZaicodeUiPrefs((state) => state.autoRetryMaxAttempts));
  const masterOn = useZaicodeAuditStore((state) => state.smartMode);
  const sessionMode = useZaicodeAutoContinue((state) => (sessionId ? state.modes[sessionId] : undefined));
  const halted = useZaicodeRetryLedger((state) => state.halted);

  // A drained queue or a clean finish starts the count again.
  useEffect(() => {
    if (sessionId && (autoDrain || queueItems === 0)) resumesBySession.delete(sessionId);
  }, [autoDrain, queueItems, sessionId]);

  const attempts = sessionId ? zaicodeQueueResumeAttempts(sessionId) : 0;
  const allowed = zaicodeQueueMayAutoResume({
    hasSession: Boolean(sessionId),
    queueItems,
    autoDrain,
    pauseReason,
    phase,
    quotaWall,
    mayAutoSend: zaicodeQueueAutoSendAllowed({
      enabled,
      halted,
      projectKey,
      sessionId,
      prefs: { autoRetry, autoRetryScope, autoRetryProjects, autoRetrySessions },
      masterOn,
      sessionMode,
    }),
    attempts,
    maxAttempts,
  });

  useEffect(() => {
    if (!allowed || !sessionId) return undefined;
    // The first resume is quick (the failed turn was already retried or dismissed); later ones back off.
    const delay = zaicodeRetryDelayMs(Math.min(intervalSec, 20), attempts);
    const at = Date.now() + delay;
    useZaicodeRetryLedger.getState().set({ sessionId, title: "queued message", nextAt: at, attempt: attempts + 1, source: "chat" });
    const timer = window.setTimeout(() => {
      resumesBySession.set(sessionId, (resumesBySession.get(sessionId) ?? 0) + 1);
      useZaicodeRetryLedger.getState().clear(sessionId);
      logger.info("[zaicode] queue auto-resume", { sessionId, attempt: attempts + 1 });
      void Promise.resolve(resume()).catch((error: unknown) =>
        logger.warn("[zaicode] queue auto-resume failed", { error: error instanceof Error ? error.message : String(error) }),
      );
    }, delay);
    return () => {
      window.clearTimeout(timer);
      useZaicodeRetryLedger.getState().clear(sessionId);
    };
  }, [allowed, attempts, intervalSec, resume, sessionId]);
}
