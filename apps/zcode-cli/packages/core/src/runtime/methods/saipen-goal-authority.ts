/**
 * ZAICODE: the continuation authority of a SAIPEN workspace, as SAIPEN itself
 * publishes it (SRC-021 R2/R3, the `automation` block of `saipen status --json`).
 *
 * Split out of saipen-goal-verdict.ts by T-309 (SRC-221): that file hit the lint
 * line cap, and this half is the part a reader can check against the protocol's
 * own closed vocabulary without reading the verdict branches.
 */
import { GoalCompletionDisposition } from "../deps.js";
import type { GoalCompletionVerificationOutput } from "../deps.js";

/** The part of a projection this decision reads; the verdict's own shape fits it. */
export interface SaipenAuthorityProjection {
  phase?: string;
  claimedTicket?: string | null;
  topWorkableTicket?: string | null;
  automation?: SaipenAutomation;
}


/** SRC-021 R2: the closed disposition vocabulary `automation.disposition` uses. */
export const SAIPEN_AUTOMATION_DISPOSITIONS = [
  "CONTINUE",
  "COMPLETE",
  "WAIT_USER",
  "WAIT_EXTERNAL",
  "BLOCKED",
  "INVALID",
] as const;

export type SaipenAutomationDisposition = (typeof SAIPEN_AUTOMATION_DISPOSITIONS)[number];

export interface SaipenAutomation {
  disposition: SaipenAutomationDisposition;
  /** `"cc"` exactly when the disposition is CONTINUE, `null` for every other one (R3). */
  nextCommand: string | null;
  /** SAIPEN says a human has to act before this run may continue. */
  operatorActionDue: boolean;
  reasonCode: string | null;
}

export function projectionText(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "none" ? value.trim() : null;
}

/**
 * The `automation` block, or nothing. The admission test is SAIPEN's own
 * (`response_surface`): schema version 1, a disposition from the closed set and a
 * boolean `operator_action_due`. An answer failing any part of it is authority
 * ZAICODE does not have, so it reads as absent instead of being guessed at.
 */
export function parseSaipenAutomation(raw: unknown): SaipenAutomation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const block = raw as Record<string, unknown>;
  const disposition = block.disposition;
  if (
    block.schema_version !== 1 ||
    typeof block.operator_action_due !== "boolean" ||
    typeof disposition !== "string" ||
    !(SAIPEN_AUTOMATION_DISPOSITIONS as readonly string[]).includes(disposition)
  ) {
    return undefined;
  }
  return {
    disposition: disposition as SaipenAutomationDisposition,
    nextCommand: projectionText(block.next_command),
    operatorActionDue: block.operator_action_due,
    reasonCode: projectionText(block.reason_code),
  };
}

/** The disposition a suspension carries: the product's own "why the goal did not continue". */
type SuspensionDisposition = NonNullable<GoalCompletionVerificationOutput["disposition"]>;

export type SaipenContinuationDecision =
  | { kind: "continue" }
  | { kind: "suspend"; disposition: SuspensionDisposition; reason: string };

/**
 * T-309: whether SAIPEN authorizes this continuation at all, or is waiting for a
 * human. "A ticket is open" is not "the run may continue".
 *
 * ZAICODE holds no continuation authority of its own and `.saipen/` on disk grants
 * none (GOAL-01: "an invocation, a remembered request or a convenient counter value
 * proves none"). SAIPEN publishes the answer inside the closed `automation`
 * vocabulary of the same status answer this verdict already reads: CONTINUE means a
 * mechanical next action exists that no human owns, WAIT_USER/WAIT_EXTERNAL/BLOCKED
 * mean the run cannot move without an operator decision or an external event, and
 * INVALID means SAIPEN cannot safely interpret its own state (a hard stop).
 *
 * Measured drift (SRC-221, 2026-10-12): a bounded safety valve
 * (`continuation_authority: operator_required`, `safety_valve_mode: hard_wait`,
 * `next_action: WAIT: ...`) reached goal iteration 35, because this verdict read
 * only the claimed / top-workable tickets -- so every iteration dispatched another
 * synthetic `goal-continuation` against the same blocked decision, and the runtime
 * scheduled another model turn without any executable next action.
 *
 * The suspension names no `nextAction`, which is what stops the dispatch: the
 * continuation loop ends on a verdict without one (`target.ts`,
 * `skipped_no_next_action`), and the caller parks the goal `paused` -- active,
 * resumable, never complete, and not replayed by a restarted or restored session
 * (`activatePausedTargetAfterResume` activates nothing; only an explicit
 * `/goal resume` or an operator `cc` does). Nothing in the blocked work is marked
 * DONE and no operator decision is manufactured here.
 */
export function saipenContinuationAuthority(
  projection: SaipenAuthorityProjection | null,
  nextAction: string,
): SaipenContinuationDecision {
  const automation = projection?.automation;
  if (!automation) {
    // No authority was read: an older answer, or no projection at all. Nothing here
    // suspends -- the board work below is still this session's own, and a
    // human-shaped WAIT keeps the guard at the end of this verdict.
    return { kind: "continue" };
  }
  const named = projection?.claimedTicket ?? projection?.topWorkableTicket ?? null;
  const context = [
    `automation ${automation.disposition}${automation.reasonCode ? `/${automation.reasonCode}` : ""}`,
    projection?.phase ? `phase ${projection.phase}` : "",
    named ? `ticket ${named}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const suspend = (
    disposition: SuspensionDisposition,
    what: string,
  ): SaipenContinuationDecision => ({
    kind: "suspend",
    disposition,
    reason:
      `SAIPEN reports ${context}: ${what}` +
      (nextAction ? ` SAIPEN's own next action is "${nextAction.trim().slice(0, 120)}".` : "") +
      " The goal stays open and no ticket is marked done; automatic continuation is suspended, because repeating this attempt cannot change the condition that blocks it.",
  });
  switch (automation.disposition) {
    case "WAIT_USER":
      return suspend(
        GoalCompletionDisposition.BlockedHuman,
        "the run needs an operator decision or action before it may continue.",
      );
    case "WAIT_EXTERNAL":
      return suspend(
        GoalCompletionDisposition.BlockedExternal,
        "the run needs an external event before it may continue.",
      );
    case "BLOCKED":
      return suspend(
        automation.operatorActionDue ? GoalCompletionDisposition.BlockedHuman : GoalCompletionDisposition.BlockedExternal,
        automation.operatorActionDue
          ? "the route is blocked on an operator action."
          : "the route is blocked outside this session.",
      );
    case "INVALID":
      // No next action either, so no turn is dispatched -- but the goal is NOT parked:
      // an uninterpretable state can be transient (a validator that could not run), and
      // the answer that fits it is F-05's fail-safe: unverified, open, retried when
      // something real changes.
      return {
        kind: "suspend",
        disposition: GoalCompletionDisposition.InvalidOrUnverified,
        reason: `SAIPEN reports ${context}: it cannot safely interpret its own state (a hard stop). Nothing may continue from here, and the goal is not marked complete.`,
      };
    default:
      // CONTINUE (mechanical work no human owns) and COMPLETE (the closure gate, which
      // the branches below answer) are not operator waits.
      return { kind: "continue" };
  }
}
