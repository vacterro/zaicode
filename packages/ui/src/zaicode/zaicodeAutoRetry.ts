import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationRow,
  ConversationRowTarget,
  SessionErrorInfo,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useZaicodeAutoContinue } from "./zaicodeAutoContinue.js";
import {
  clearZaicodeQuotaWall,
  markZaicodeQuotaWall,
  useZaicodeRetryLedger,
  zaicodeEffectiveAutoRetry,
  zaicodeEffectiveAutoRetryFor,
  zaicodeRetryClassOf,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
} from "./zaicodeRetryPolicy.js";
import { currentZaicodeRetrySafety, writeZaicodeRetrySafety } from "./zaicodeRetrySafety.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/**
 * ZAICODE auto-retry: when a turn ends in an error (e.g. "The model returned
 * no content", a dropped connection), the session retries on its own after N
 * seconds (default 60, the same every attempt since T-302), and gives up after
 * M attempts (at most ZAICODE_AUTO_RETRY_HARD_CAP). It follows the effective retry
 * preference and session/stop-all controls, and never retries a quota wall blindly
 * (SRC-082). The composer banner shows the countdown with "Retry now" and
 * "Stop auto-retry".
 */

export type ZaicodeAutoRetryAction =
  | { kind: "retry"; target: ConversationRowTarget }
  | { kind: "edit"; target: ConversationRowTarget; text: string };

/** Error codes that retrying cannot fix (no model configured, session gone, user stop). */
const NOT_RETRYABLE_CODE = /MODEL_CONFIG_MISSING|ModelConfigMissing|sessionNotFound|SESSION_NOT_FOUND|CANCEL|ABORT|INTERRUPT/i;

/** A retry by hand can help (Retry now): everything except the errors above. */
export function isZaicodeManualRetryableError(error: Pick<SessionErrorInfo, "code" | "message">): boolean {
  return !NOT_RETRYABLE_CODE.test(error.code) && !/Model config is missing/i.test(error.message);
}

/**
 * A retry by itself can help. A quota / usage-limit error is a wall: asking again
 * every minute does not lift it, so it is left to Retry now and to the reset
 * (SRC-082, zaicodeRetryPolicy).
 */
export function isZaicodeAutoRetryableError(
  error: Pick<SessionErrorInfo, "code" | "message">,
  quotaFallbackReady = false,
): boolean {
  return isZaicodeManualRetryableError(error) &&
    (zaicodeRetryClassOf(error) === "transient" || quotaFallbackReady);
}

type RowLike = Pick<ConversationRow, "rowId" | "kind"> & {
  entityId?: string;
  origin?: string;
  actions?: { canRetry?: true; canEdit?: true };
  text?: string;
};

/**
 * Retry the current user input: its admitted answer, else the editable input.
 * A previous answered input is never a substitute for the latest failed one.
 */
export function pickZaicodeAutoRetryAction(rows: readonly RowLike[]): ZaicodeAutoRetryAction | null {
  const latestUser = rows.findLastIndex((row) => row.kind === "userInput" &&
    (row.origin === undefined || row.origin === "realUser"));
  // T-240：旧答案仍可手动 Retry，但自动重试不能跨过更新的失败请求回放旧问题。
  for (let index = rows.length - 1; index >= Math.max(0, latestUser); index -= 1) {
    const row = rows[index]!;
    if (row.actions?.canRetry && row.entityId) {
      return { kind: "retry", target: { rowId: row.rowId, entityId: row.entityId } };
    }
  }
  const row = rows[latestUser];
  if (row?.actions?.canEdit && row.entityId && row.text?.trim()) {
    return {
      kind: "edit",
      target: { rowId: row.rowId, entityId: row.entityId },
      text: row.text,
    };
  }
  return null;
}

/**
 * Attempts per session survive pane remounts, and survive a renderer reload too (SRC-161:W2-002:
 * a reload used to hand out a fresh budget, so a crash loop could retry for ever in blocks of
 * eight). Reset when a turn completes cleanly.
 */
const attemptsBySession = new Map<string, number>(Object.entries(currentZaicodeRetrySafety().attempts));

/** Sessions whose open pane is in charge of the retry; the background host stands down for them. */
const localPanes = new Set<string>();

export function zaicodeAutoRetryAttempts(sessionId: string): number {
  return attemptsBySession.get(sessionId) ?? 0;
}

export function bumpZaicodeAutoRetryAttempt(sessionId: string): void {
  attemptsBySession.set(sessionId, (attemptsBySession.get(sessionId) ?? 0) + 1);
  writeZaicodeRetrySafety({ attempts: Object.fromEntries(attemptsBySession) });
}

export function resetZaicodeAutoRetryAttempt(sessionId: string): void {
  if (attemptsBySession.delete(sessionId)) {
    writeZaicodeRetrySafety({ attempts: Object.fromEntries(attemptsBySession) });
  }
  clearZaicodeAutoRetryStoppedForSession(sessionId);
}

/** True while an open pane is in charge of the session's retry (zaicodeAutoRetryPaneClaims). */
export function isZaicodeAutoRetryLocal(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId) && localPanes.has(sessionId!);
}

/**
 * Does an open pane own this session's retry, so the background host stands down?
 *
 * SRC-058 (the retry that only started once the operator walked into the
 * project): the pane used to claim the session just by being mounted. A
 * mounted pane that could not act kept the background host away, and neither
 * side retried. Examples: a hidden tab with no projected error, a snapshot
 * without a retryable row, a disabled surface. The countdown then appeared only
 * when the operator opened the project.
 *
 * The pane owns the retry only while it is really in charge:
 * - its own countdown is armed; or
 * - the operator pressed Stop for this very error; or
 * - the error is one that retrying cannot fix.
 * In the last two cases nobody should retry at all.
 */
export function zaicodeAutoRetryPaneClaims(state: {
  hasSession: boolean;
  enabled: boolean;
  hasError: boolean;
  retryable: boolean;
  armed: boolean;
  stoppedThisError: boolean;
}): boolean {
  if (!state.hasSession || !state.enabled || !state.hasError) return false;
  return state.armed || state.stoppedThisError || !state.retryable;
}

export interface ZaicodeAutoRetryState {
  projectKey?: string;
  sessionId?: string | null;
  effectiveEnabled?: boolean;
  /** Epoch ms of the next automatic attempt, null when none is scheduled. */
  nextAt: number | null;
  attempts: number;
  maxAttempts: number;
  /** Auto-retry reached its limit for this error. */
  exhausted: boolean;
  /** An action exists for the current error (a manual retry is possible). */
  available: boolean;
  /** The retry for this error is running and can be stopped. */
  armed: boolean;
  /**
   * Why nothing is scheduled although a retry by hand is possible: this session's
   * auto-continue is Off, the retry switch/stop-all is off, or the error is a
   * quota wall that only the reset lifts. null = nothing blocks it.
   */
  blockedBy: "auto-off" | "switch-off" | "quota" | null;
  retryNow: () => void;
  stop: () => void;
}

/**
 * Errors the operator has closed (SRC-070 item D). The auto-retry for one of
 * these stays off even after the pane is remounted: a notice that is closed
 * and then keeps firing behind the operator's back is the same as a notice
 * that cannot be closed. The set is bounded and per error key, never global --
 * the next genuinely new error arms the retry again, and the source event
 * itself is not suppressed.
 */
const stoppedErrorKeys = new Set<string>(currentZaicodeRetrySafety().stoppedErrors);
const STOPPED_KEY_LIMIT = 40;

/** Stops the background retry for one error, from anywhere in the app. */
export function stopZaicodeAutoRetryForError(errorKey: string | null | undefined): void {
  if (!errorKey) return;
  stoppedErrorKeys.add(errorKey);
  for (const key of stoppedErrorKeys) {
    if (stoppedErrorKeys.size <= STOPPED_KEY_LIMIT) break;
    stoppedErrorKeys.delete(key);
  }
  // The operator closed this error; a reload must not reopen it.
  writeZaicodeRetrySafety({ stoppedErrors: [...stoppedErrorKeys] });
}

export function isZaicodeAutoRetryStopped(errorKey: string | null | undefined): boolean {
  return Boolean(errorKey) && stoppedErrorKeys.has(errorKey!);
}

/** Background summaries omit error details, but the session still owns the stopped failure. */
export function isZaicodeAutoRetryStoppedForSession(sessionId: string): boolean {
  const prefix = `${sessionId}:`;
  return [...stoppedErrorKeys].some((key) => key.startsWith(prefix));
}

/** A new accepted attempt or clean finish retires this session's previous failure. */
export function clearZaicodeAutoRetryStoppedForSession(sessionId: string): void {
  let changed = false;
  for (const key of stoppedErrorKeys) {
    if (key.startsWith(`${sessionId}:`)) {
      stoppedErrorKeys.delete(key);
      changed = true;
    }
  }
  if (changed) writeZaicodeRetrySafety({ stoppedErrors: [...stoppedErrorKeys] });
}

export function useZaicodeAutoRetry(params: {
  projectKey?: string;
  enabled: boolean;
  /** A different usable route is selected; Retry aligns it before sending. */
  quotaFallbackReady?: boolean;
  sessionId: string | null;
  error: SessionErrorInfo | null;
  errorKey: string | null;
  phase: SessionPhase | null;
  rows: readonly ConversationRow[];
  retry: (target: ConversationRowTarget) => Promise<unknown>;
  edit: (target: ConversationRowTarget, text: string) => Promise<unknown>;
}): ZaicodeAutoRetryState {
  const { enabled, sessionId, error, errorKey, phase, rows } = params;
  const prefs = useZaicodeUiPrefs();
  const intervalSec = useZaicodeUiPrefs((state) => state.autoRetryIntervalSec);
  const maxAttempts = zaicodeRetryLimit(useZaicodeUiPrefs((state) => state.autoRetryMaxAttempts));
  const sessionMode = useZaicodeAutoContinue((state) => (sessionId ? state.modes[sessionId] : undefined));
  const halted = useZaicodeRetryLedger((state) => state.halted);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [stoppedKey, setStoppedKey] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const runRef = useRef(params);
  runRef.current = params;

  // What a retry by hand may re-run; whether the retry goes out by itself is decided below.
  const action = useMemo(
    () => (error && isZaicodeManualRetryableError(error) ? pickZaicodeAutoRetryAction(rows as readonly RowLike[]) : null),
    [error, rows],
  );
  const quotaWall = Boolean(error && zaicodeRetryClassOf(error) === "quota" && !params.quotaFallbackReady);
  useEffect(() => {
    if (sessionId && quotaWall) markZaicodeQuotaWall(sessionId, error?.at);
    else if (sessionId && params.quotaFallbackReady) clearZaicodeQuotaWall(sessionId);
  }, [quotaWall, sessionId, errorKey, error?.at, params.quotaFallbackReady]);
  const effective = zaicodeEffectiveAutoRetry(prefs, params.projectKey ?? "", sessionId, { sessionMode, halted });
  const mayAutoSend = effective.enabled;
  // The banner reads the same block the button shows (SRC-162): one projection, one answer.
  const blockedBy: ZaicodeAutoRetryState["blockedBy"] = quotaWall
    ? "quota"
    : effective.block === "session-off"
      ? "auto-off"
      : effective.block !== null
        ? "switch-off"
        : null;
  const actionRef = useRef(action);
  actionRef.current = action;
  const actionKey = action ? `${action.kind}:${action.target.rowId}:${action.target.entityId}` : null;
  const busy = phase === "running" || phase === "prewarming";
  const attempts = sessionId ? zaicodeAutoRetryAttempts(sessionId) : 0;
  // T-240/W2-002：reload 不能用空的 React state 覆盖已落盘的「停止本次错误」。
  const stoppedThisError = Boolean(errorKey) &&
    (stoppedKey === errorKey || isZaicodeAutoRetryStopped(errorKey) ||
      Boolean(sessionId && isZaicodeAutoRetryStoppedForSession(sessionId)));

  useEffect(() => {
    if (sessionId && busy) clearZaicodeAutoRetryStoppedForSession(sessionId);
  }, [busy, sessionId]);

  // A clean finish resets the budget.
  useEffect(() => {
    if (sessionId && !error && phase === "completedSuccess") {
      resetZaicodeAutoRetryAttempt(sessionId);
      clearZaicodeQuotaWall(sessionId);
    }
  }, [error, phase, sessionId]);

  const run = useCallback(
    (counted: boolean) => {
      const current = actionRef.current;
      const id = runRef.current.sessionId;
      if (!current || !id) return;
      if (counted && !zaicodeEffectiveAutoRetryFor(runRef.current.projectKey ?? "", id).enabled) return;
      if (counted && isZaicodeAutoRetryStoppedForSession(id)) return;
      if (counted) bumpZaicodeAutoRetryAttempt(id);
      setNextAt(null);
      forceRender((value) => value + 1);
      logger.info("[zaicode] auto-retry", {
        sessionId: id,
        kind: current.kind,
        attempt: zaicodeAutoRetryAttempts(id),
      });
      const promise =
        current.kind === "retry"
          ? runRef.current.retry(current.target)
          : runRef.current.edit(current.target, current.text);
      void Promise.resolve(promise).catch((caught: unknown) =>
        logger.warn("[zaicode] auto-retry failed to submit", {
          error: caught instanceof Error ? caught.message : String(caught),
        }),
      );
    },
    [],
  );

  const exhausted = Boolean(error && action && attempts >= maxAttempts);
  const armed =
    enabled &&
    blockedBy === null &&
    Boolean(sessionId && error && errorKey && actionKey) &&
    !busy &&
    !exhausted &&
    !stoppedThisError;

  // The pane claims the session only while it is really in charge of it
  // (zaicodeAutoRetryPaneClaims); otherwise the background retry host (SRC-051)
  // keeps covering it even though a pane is mounted.
  const claims = zaicodeAutoRetryPaneClaims({
    hasSession: Boolean(sessionId),
    enabled,
    hasError: Boolean(error),
    retryable: Boolean(error && blockedBy === null && isZaicodeAutoRetryableError(error, params.quotaFallbackReady)),
    armed,
    stoppedThisError,
  });
  useEffect(() => {
    if (!sessionId || !claims) return undefined;
    localPanes.add(sessionId);
    return () => {
      localPanes.delete(sessionId);
    };
  }, [claims, sessionId]);

  useEffect(() => {
    if (!armed) {
      setNextAt(null);
      return;
    }
    // T-302: the same nominal interval at attempt 1 and at attempt 49 -- no 2^attempts ladder.
    // SRC-269: honor trustworthy Retry-After over local nominal estimates when supplied.
    const retryAfter = error?.attribution?.retryAfterMs;
    const delay = typeof retryAfter === "number" && retryAfter > 0
      ? Math.min(retryAfter, 3_600_000)
      : zaicodeRetryDelayMs(intervalSec);
    const at = Date.now() + delay;
    setNextAt(at);
    // Every scheduled knock is in the ledger the sidebar shows (and can stop).
    if (sessionId) {
      useZaicodeRetryLedger.getState().set({
        sessionId,
        title: "this chat",
        nextAt: at,
        attempt: zaicodeAutoRetryAttempts(sessionId) + 1,
        source: "chat",
      });
    }
    const timer = window.setTimeout(() => run(true), delay);
    return () => {
      window.clearTimeout(timer);
      if (sessionId) useZaicodeRetryLedger.getState().clear(sessionId);
    };
    // errorKey/actionKey：同一个错误只排一次；新的失败（新 at）重新计时。
  }, [armed, actionKey, errorKey, intervalSec, run, sessionId]);

  return {
    projectKey: params.projectKey,
    sessionId,
    effectiveEnabled: mayAutoSend,
    nextAt: armed ? nextAt : null,
    attempts,
    maxAttempts,
    exhausted,
    available: Boolean(action && sessionId && !busy),
    armed,
    blockedBy,
    retryNow: () => run(false),
    stop: () => {
      stopZaicodeAutoRetryForError(errorKey);
      setStoppedKey(errorKey);
    },
  };
}
