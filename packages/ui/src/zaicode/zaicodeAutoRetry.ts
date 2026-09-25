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

export interface ZaicodeAutoRetryState {
  /** Epoch ms of the next automatic attempt, null when none is scheduled. */
  nextAt: number | null;
  attempts: number;
  maxAttempts: number;
  /** Auto-retry reached its limit for this error. */
  exhausted: boolean;
  /** An action exists for the current error (a manual retry is possible). */
  available: boolean;
  retryNow: () => void;
  stop: () => void;
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
  const attempts = sessionId ? (attemptsBySession.get(sessionId) ?? 0) : 0;

  // A clean finish resets the budget.
  useEffect(() => {
    if (sessionId && !error && phase === "completedSuccess") attemptsBySession.delete(sessionId);
  }, [error, phase, sessionId]);

  const run = useCallback(
    (counted: boolean) => {
      const current = actionRef.current;
      const id = runRef.current.sessionId;
      if (!current || !id) return;
      if (counted) attemptsBySession.set(id, (attemptsBySession.get(id) ?? 0) + 1);
      setNextAt(null);
      forceRender((value) => value + 1);
      logger.info("[zaicode] auto-retry", {
        sessionId: id,
        kind: current.kind,
        attempt: attemptsBySession.get(id) ?? 0,
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
    retryNow: () => run(false),
    stop: () => setStoppedKey(errorKey),
  };
}
