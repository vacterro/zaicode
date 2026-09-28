import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationRow,
  ConversationRowTarget,
  SessionErrorInfo,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useZaicodeUiPrefs } from "./zaicodeUiPrefs.js";

/**
 * ZAICODE auto-retry: when a turn ends in an error (e.g. "The model returned
 * no content", a provider limit, a dropped connection), the session retries
 * on its own every N seconds (default 60) so the work does not stall, and
 * gives up after M attempts (default 100). The composer banner shows the
 * countdown with "Retry now" and "Stop auto-retry".
 */

export type ZaicodeAutoRetryAction =
  | { kind: "retry"; target: ConversationRowTarget }
  | { kind: "edit"; target: ConversationRowTarget; text: string };

/** Error codes that retrying cannot fix (no model configured, session gone, user stop). */
const NOT_RETRYABLE_CODE = /MODEL_CONFIG_MISSING|ModelConfigMissing|sessionNotFound|SESSION_NOT_FOUND|CANCEL|ABORT|INTERRUPT/i;

export function isZaicodeAutoRetryableError(error: Pick<SessionErrorInfo, "code" | "message">): boolean {
  return !NOT_RETRYABLE_CODE.test(error.code) && !/Model config is missing/i.test(error.message);
}

type RowLike = Pick<ConversationRow, "rowId" | "kind"> & {
  entityId?: string;
  actions?: { canRetry?: true; canEdit?: true };
  text?: string;
};

/**
 * What to re-run: the latest row the CLI marks retryable (retryTurn), else the
 * latest editable user input re-sent with its own text (editUserQuery).
 */
export function pickZaicodeAutoRetryAction(rows: readonly RowLike[]): ZaicodeAutoRetryAction | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.actions?.canRetry && row.entityId) {
      return { kind: "retry", target: { rowId: row.rowId, entityId: row.entityId } };
    }
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "userInput" && row.actions?.canEdit && row.entityId && row.text?.trim()) {
      return {
        kind: "edit",
        target: { rowId: row.rowId, entityId: row.entityId },
        text: row.text,
      };
    }
  }
  return null;
}

/** Attempts per session survive pane remounts; reset when a turn completes cleanly. */
const attemptsBySession = new Map<string, number>();

/** Sessions whose open pane is in charge of the retry; the background host stands down for them. */
const localPanes = new Set<string>();

export function zaicodeAutoRetryAttempts(sessionId: string): number {
  return attemptsBySession.get(sessionId) ?? 0;
}

export function bumpZaicodeAutoRetryAttempt(sessionId: string): void {
  attemptsBySession.set(sessionId, (attemptsBySession.get(sessionId) ?? 0) + 1);
}

export function resetZaicodeAutoRetryAttempt(sessionId: string): void {
  attemptsBySession.delete(sessionId);
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
const stoppedErrorKeys = new Set<string>();
const STOPPED_KEY_LIMIT = 40;

/** Stops the background retry for one error, from anywhere in the app. */
export function stopZaicodeAutoRetryForError(errorKey: string | null | undefined): void {
  if (!errorKey) return;
  stoppedErrorKeys.add(errorKey);
  for (const key of stoppedErrorKeys) {
    if (stoppedErrorKeys.size <= STOPPED_KEY_LIMIT) break;
    stoppedErrorKeys.delete(key);
  }
}

export function isZaicodeAutoRetryStopped(errorKey: string | null | undefined): boolean {
  return Boolean(errorKey) && stoppedErrorKeys.has(errorKey!);
}

export function useZaicodeAutoRetry(params: {
  enabled: boolean;
  sessionId: string | null;
  error: SessionErrorInfo | null;
  errorKey: string | null;
  phase: SessionPhase | null;
  rows: readonly ConversationRow[];
  retry: (target: ConversationRowTarget) => Promise<unknown>;
  edit: (target: ConversationRowTarget, text: string) => Promise<unknown>;
}): ZaicodeAutoRetryState {
  const { enabled, sessionId, error, errorKey, phase, rows } = params;
  const autoRetry = useZaicodeUiPrefs((state) => state.autoRetry);
  const intervalSec = useZaicodeUiPrefs((state) => state.autoRetryIntervalSec);
  const maxAttempts = useZaicodeUiPrefs((state) => state.autoRetryMaxAttempts);
  const [nextAt, setNextAt] = useState<number | null>(null);
  const [stoppedKey, setStoppedKey] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const runRef = useRef(params);
  runRef.current = params;

  const action = useMemo(
    () => (error && isZaicodeAutoRetryableError(error) ? pickZaicodeAutoRetryAction(rows as readonly RowLike[]) : null),
    [error, rows],
  );
  const actionRef = useRef(action);
  actionRef.current = action;
  const actionKey = action ? `${action.kind}:${action.target.rowId}:${action.target.entityId}` : null;
  const busy = phase === "running" || phase === "prewarming";
  const attempts = sessionId ? zaicodeAutoRetryAttempts(sessionId) : 0;

  // A clean finish resets the budget.
  useEffect(() => {
    if (sessionId && !error && phase === "completedSuccess") resetZaicodeAutoRetryAttempt(sessionId);
  }, [error, phase, sessionId]);

  const run = useCallback(
    (counted: boolean) => {
      const current = actionRef.current;
      const id = runRef.current.sessionId;
      if (!current || !id) return;
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
    autoRetry &&
    Boolean(sessionId && error && errorKey && actionKey) &&
    !busy &&
    !exhausted &&
    stoppedKey !== errorKey;

  // The pane claims the session only while it is really in charge of it
  // (zaicodeAutoRetryPaneClaims); otherwise the background retry host (SRC-051)
  // keeps covering it even though a pane is mounted.
  const claims = zaicodeAutoRetryPaneClaims({
    hasSession: Boolean(sessionId),
    enabled,
    hasError: Boolean(error),
    retryable: Boolean(error && isZaicodeAutoRetryableError(error)),
    armed,
    stoppedThisError: Boolean(errorKey) && stoppedKey === errorKey,
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
    const delay = intervalSec * 1000;
    setNextAt(Date.now() + delay);
    const timer = window.setTimeout(() => run(true), delay);
    return () => window.clearTimeout(timer);
    // errorKey/actionKey：同一个错误只排一次；新的失败（新 at）重新计时。
  }, [armed, actionKey, errorKey, intervalSec, run]);

  return {
    nextAt,
    attempts,
    maxAttempts,
    exhausted,
    available: Boolean(action && sessionId && !busy),
    armed,
    retryNow: () => run(false),
    stop: () => {
      stopZaicodeAutoRetryForError(errorKey);
      setStoppedKey(errorKey);
    },
  };
}
