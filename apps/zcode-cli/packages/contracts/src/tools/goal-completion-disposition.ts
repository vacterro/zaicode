import { z } from "zod";

/**
 * ZAICODE (SAIHANDOFF F-01 / Q1): the goal verifier's typed disposition.
 *
 * One boolean could not carry the difference between "no ticket is left that a
 * human is not required for" and "the objective is complete". A board whose only
 * remaining ticket was blocked on a human still produced `passed: true`, and the
 * host then set the goal COMPLETE while the blocker stood. The disposition keeps
 * autonomous exhaustion (continue / blocked_*) apart from objective completion
 * (complete), so a remaining required human dependency is never reported as a
 * finished goal.
 */
export const GoalCompletionDisposition = {
  Complete: "complete",
  BlockedHuman: "blocked_human",
  BlockedExternal: "blocked_external",
  Continue: "continue",
  InvalidOrUnverified: "invalid_or_unverified",
} as const;

export type GoalCompletionDisposition =
  (typeof GoalCompletionDisposition)[keyof typeof GoalCompletionDisposition];

export const GoalCompletionDispositionSchema = z.enum([
  "complete",
  "blocked_human",
  "blocked_external",
  "continue",
  "invalid_or_unverified",
]);

/**
 * The verdict fields the disposition helpers read. A full verification output
 * satisfies it structurally; the helpers take the narrow shape so a producer can
 * ask the question without carrying a reason.
 */
export interface GoalCompletionVerdict {
  disposition?: GoalCompletionDisposition;
  nextAction?: string;
  passed: boolean;
}

/**
 * The disposition a verdict carries. A verdict without one keeps the legacy
 * meaning: `passed` WAS the disposition, so true read as complete while a failed
 * verdict with a next action read as continue and a failed verdict without one as
 * an unverifiable check.
 */
export function goalCompletionDispositionOf(
  verification: GoalCompletionVerdict,
): GoalCompletionDisposition {
  if (verification.disposition) return verification.disposition;
  if (verification.passed === true) return GoalCompletionDisposition.Complete;
  return verification.nextAction?.trim()
    ? GoalCompletionDisposition.Continue
    : GoalCompletionDisposition.InvalidOrUnverified;
}

/**
 * The ONE verdict shape that may mark the goal complete. Every other disposition
 * -- including a `passed: true` payload that names a blocked disposition -- leaves
 * the goal open, so completion can never be inferred from autonomous exhaustion.
 */
export function isGoalCompletionComplete(verification: GoalCompletionVerdict): boolean {
  return (
    verification.passed === true &&
    goalCompletionDispositionOf(verification) === GoalCompletionDisposition.Complete
  );
}

/** The dispositions that park an open goal on a dependency instead of completing it. */
export function isGoalCompletionBlockedDisposition(
  disposition: GoalCompletionDisposition,
): boolean {
  return (
    disposition === GoalCompletionDisposition.BlockedHuman ||
    disposition === GoalCompletionDisposition.BlockedExternal
  );
}
