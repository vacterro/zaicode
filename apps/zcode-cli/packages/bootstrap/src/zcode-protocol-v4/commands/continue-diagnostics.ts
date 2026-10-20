import type { SaipenContinueAnswer } from "./continue-owner.js";
import type { V4SessionRecordView } from "./types.js";

/** Refusal receipts for recognized commands (the gateway maps reasonCode into the ACK). */
export class V4RecognizedContinueRejectedError extends Error {
  constructor(
    readonly reasonCode:
      | "guard.recognizedContinueAuthorizationExpired"
      | "guard.recognizedContinueSessionBusy"
      | "guard.recognizedContinuePlanMode"
      | "guard.recognizedContinueWithoutGoal"
      | "guard.recognizedContinueGoalComplete"
      | "guard.recognizedContinueBudgetExhausted"
      | "guard.recognizedContinueResumeFailed"
      | "guard.recognizedContinueRouterUnavailable"
      | "guard.recognizedContinueNoOwner"
      | "guard.recognizedContinueSaipenRefused"
      | "guard.recognizedContinueSaipenValve"
      | "guard.recognizedContinueSaipenOperator"
      | "guard.recognizedContinueSaipenUnavailable",
    message: string,
  ) {
    super(message);
    this.name = "V4RecognizedContinueRejectedError";
  }
}

/**
 * T-315: the guard code for a SAIPEN refusal, chosen from the launcher's OWN
 * structured fields instead of from the rendered sentence.
 *
 * T-295 classified the refusal in the UI by matching the human message, so the
 * classification lived one parsing bug away from the truth: any rewording of
 * `describeSaipenRefusal` silently changed what the operator was told. The
 * launcher already answered with `safety_valve_tripped` / `operator_action_due`
 * / `remediation` (continue-owner.ts), so the discriminator travels as the guard
 * code itself and the message is decoration again.
 */
export function saipenRefusalCode(answer: SaipenContinueAnswer): "guard.recognizedContinueSaipenValve" | "guard.recognizedContinueSaipenOperator" | "guard.recognizedContinueSaipenRefused" {
  if (answer.safetyValveTripped || answer.remediation === "SAFETY_VALVE_TRIPPED") {
    return "guard.recognizedContinueSaipenValve";
  }
  if (answer.operatorActionDue || answer.remediation === "OPERATOR_DECISION") {
    return "guard.recognizedContinueSaipenOperator";
  }
  return "guard.recognizedContinueSaipenRefused";
}

/**
 * The launcher's refusal rendered as the operator's real next step.
 *
 * T-295 (SRC-208): the incident was a continuation answered with
 * `guard.recognizedContinueSaipenUnavailable` while SAIPEN had actually REFUSED
 * (`RECONCILE_REAUTH_REQUIRED`, the goal safety valve). One refusal receipt can be
 * a goal that cannot be continued at all, or only one where SAIPEN itself asks for
 * the operator. Keeping the launcher's own message principal is what lets the
 * side panel say "safety valve reached (0 waves / 20 tickets) -- run cc to
 * continue" instead of "launcher unavailable", and the canonical command is kept
 * only when SAIPEN named one.
 */
export function describeSaipenRefusal(answer: SaipenContinueAnswer): string {
  const detail = answer.detail || answer.action || "the SAIPEN launcher refused without a reason";
  // The launcher's own diagnostic code travels verbatim beside the reason; the
  // code alone never replaces it, and the reason never hides the code either.
  const codeHint = answer.code ? ` (${answer.code})` : "";
  if (answer.safetyValveTripped) {
    return `the SAIPEN safety valve is reached: ${detail}${codeHint}`;
  }
  if (answer.operatorActionDue) {
    const command = answer.canonicalNextCommand;
    return `SAIPEN refuses this continuation and only the operator can clear it: ${detail}${codeHint}` +
      (command ? ` (canonical next command: ${command})` : "");
  }
  return `the SAIPEN launcher refused this continuation: ${detail}${codeHint}`;
}


/** A turn already holds the session: a continuation admitted now would overlap it. */
export function isSessionBusyForContinue(record: V4SessionRecordView): boolean {
  return (
    record.activeAbortController !== undefined ||
    record.app.runtime?.getActiveForegroundExecutionId?.() !== undefined
  );
}
