/**
 * T-301: what a Queue control's click actually produced, read from the ack.
 *
 * A command ACK is admission, not execution — `accepted` says the CLI took
 * the command and nothing about the queued message having run. The Queue bug
 * this owner fixes lived on the other end of that same asymmetry: the refusal
 * DID come back, as `status` + `reasonCode`, and every Queue handler answered
 * it with `logger.warn` and a button that looked like it had worked. These two
 * readings of one ack are the fix; the operator never sees a guess.
 */
export type QueueActionOutcome =
  /** The CLI took the command. Execution is still unproven by the ack. */
  | { kind: "admitted" }
  /** The authoritative state already resolved it (noop/duplicate). */
  | { kind: "already-resolved" }
  /** The SAIPEN authority gate or a goal precondition refused it. */
  | { kind: "refused-authority"; reasonCode: string; detail: string }
  /** Another guard refused it. */
  | { kind: "refused"; reasonCode: string; detail: string };

/**
 * T-295: what a refused continuation actually was, in the operator's words.
 *
 * The incident: a bare `cc` whose launcher answered an authoritative
 * `RECONCILE_REAUTH_REQUIRED` (the goal safety valve) reported
 * `guard.recognizedContinueSaipenUnavailable`, so the side panel said "launcher
 * unavailable". T-315: the launcher boundary now answers with its own guard code
 * per refusal flavor (`SaipenValve` / `SaipenOperator` / `SaipenRefused`), so the
 * refusal is classified on the code; matching the launcher's own message stays
 * only as a legacy fallback, and that message stays visible as the explanation.
 */
export type SaipenContinueOutcome =
  | "accepted"
  | "saipen-launcher-unavailable"
  | "saipen-continuation-refused"
  | "operator-authorization-required"
  | "safety-valve-limit-reached"
  | "guard-refused";

/** The operator-facing sentence for one of those outcomes. */
export function saipenContinueOutcomeLabel(outcome: SaipenContinueOutcome): string {
  switch (outcome) {
    case "accepted":
      return "continuation accepted";
    case "saipen-launcher-unavailable":
      return "SAIPEN launcher unavailable";
    case "saipen-continuation-refused":
      return "SAIPEN continuation refused";
    case "operator-authorization-required":
      return "operator authorization required";
    case "safety-valve-limit-reached":
      return "safety-valve limit reached";
    default:
      return "refused";
  }
}

/**
 * One line of the launcher's own diagnostic, safe for a toast: control characters
 * are dropped, runs of whitespace collapse, and the result is bounded so a runaway
 * detail cannot bury the status line.
 */
export function sanitizeRefusalDetail(detail?: string | null): string {
  if (typeof detail !== "string") return "";
  const text = detail.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

/**
 * Classify a refused continuation's real outcome. Order matters: an unreachable
 * launcher is a transport failure, while a safety valve and an operator decision
 * are authoritative refusals only the operator can clear.
 *
 * T-315: the guard CODE now carries the distinction (a T-295 ACK had one code for
 * all three refusals and was classified from its sentence here, so rewording the
 * message rewrote the diagnosis). The code is read first; the sentence match stays
 * only for one of those older single-code ACKs still in flight.
 */
export function saipenContinueOutcome(
  reasonCode: string | null | undefined,
  detail?: string | null,
): SaipenContinueOutcome {
  const code = reasonCode ?? "";
  const message = sanitizeRefusalDetail(detail);
  if (code === "guard.recognizedContinueSaipenUnavailable") return "saipen-launcher-unavailable";
  if (code === "guard.recognizedContinueSaipenValve") return "safety-valve-limit-reached";
  if (code === "guard.recognizedContinueSaipenOperator") return "operator-authorization-required";
  if (code !== "guard.recognizedContinueSaipenRefused") return "guard-refused";
  if (/\bsafety valve\b/i.test(message)) return "safety-valve-limit-reached";
  if (/\bonly the operator can clear it\b|\bOPERATOR_REQUIRED\b/i.test(message)) {
    return "operator-authorization-required";
  }
  return "saipen-continuation-refused";
}

/**
 * The goal/authority preconditions `cc` promotion checks (T-284). A queued
 * bare continuation routed through `admitRecognizedContinue` is refused with
 * one of these and MUST stay queued; showing it is how the operator learns a
 * resume needs their authorization instead of clicking a dead button again.
 */
const QUEUE_AUTHORITY_REFUSALS: ReadonlySet<string> = new Set([
  "guard.recognizedContinueAuthorizationExpired",
  "guard.recognizedContinueWithoutGoal",
  "guard.recognizedContinueGoalComplete",
  "guard.recognizedContinueResumeFailed",
  "guard.recognizedContinuePlanMode",
  "guard.recognizedContinueBudgetExhausted",
  // T-295: the SAIPEN project domain. These are the project boundary's own
  // verdicts, not this session's goal state -- a queued `cc` in a SAIPEN project
  // is refused by SAIPEN (or by a host with no boundary) and stays queued.
  "guard.recognizedContinueNoOwner",
  "guard.recognizedContinueSaipenRefused",
  "guard.recognizedContinueSaipenValve",
  "guard.recognizedContinueSaipenOperator",
  "guard.recognizedContinueSaipenUnavailable",
  "sendQueuedNowRequiresRunning",
]);

export function classifyQueueActionAck(ack: {
  status: string;
  reasonCode?: string | null;
  message?: string | null;
}): QueueActionOutcome {
  switch (ack.status) {
    case "accepted":
      return { kind: "admitted" };
    case "noop":
    case "duplicate":
      return { kind: "already-resolved" };
    default: {
      const reasonCode = ack.reasonCode ?? ack.status;
      // T-295: the guard code alone said "SAIPEN launcher unavailable" while the
      // launcher's own message said the safety valve was reached. Both travel to
      // the operator now, sanitized, so the explanation is never just a code.
      const detail = sanitizeRefusalDetail(ack.message);
      return {
        kind: QUEUE_AUTHORITY_REFUSALS.has(reasonCode) ? "refused-authority" : "refused",
        reasonCode,
        detail,
      };
    }
  }
}

/**
 * T-295: the operator-facing one line of a refused Queue action.
 *
 * A recognized continuation is translated into its real outcome and the
 * launcher's own diagnostic is appended, so the operator never sees only the
 * opaque guard code that used to replace the real reason.
 */
export function describeQueueRefusal(
  outcome: { kind: "refused" | "refused-authority"; reasonCode: string; detail: string },
): string {
  const label = outcome.reasonCode.startsWith("guard.recognizedContinue")
    ? saipenContinueOutcomeLabel(saipenContinueOutcome(outcome.reasonCode, outcome.detail))
    : outcome.kind === "refused-authority"
      ? `authorization required (${outcome.reasonCode})`
      : outcome.reasonCode;
  return outcome.detail ? `${label}: ${outcome.detail}` : label;
}

/** Only a refusal is an action failure the operator must be told about. */
export function queueActionNeedsReport(
  outcome: QueueActionOutcome,
): outcome is { kind: "refused" | "refused-authority"; reasonCode: string; detail: string } {
  return outcome.kind === "refused" || outcome.kind === "refused-authority";
}

export interface QueuePauseFacts {
  /** Queue scheduling: the CLI-side pause between items. */
  autoDrain: boolean;
  /** The goal's own status from the projection (`paused` = SAIPEN-paused). */
  goalStatus: string | null | undefined;
}

export interface QueuePauseKinds {
  /** The queue is not draining (its own pause: stopped / error / manual). */
  queuePaused: boolean;
  /** The SESSION is paused: queue autonomy is not the session's authority. */
  sessionPaused: boolean;
}

/**
 * Two independent pauses the old banner collapsed into one. "Continue" flips
 * queue scheduling; it never grants the session's authorization, and a queued
 * message behind a paused session is refused by the authority gate no matter
 * how many times the operator clicks. Keeping the facts separate is what lets
 * the UI say which one it is looking at.
 */
export function queuePauseKinds(facts: QueuePauseFacts): QueuePauseKinds {
  return {
    queuePaused: !facts.autoDrain,
    sessionPaused: facts.goalStatus === "paused",
  };
}
