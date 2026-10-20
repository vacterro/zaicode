import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GoalCompletionDisposition,
  GoalCompletionVerificationOutputSchema,
  goalCompletionDispositionOf,
  isGoalCompletionBlockedDisposition,
  isGoalCompletionComplete,
} from "@zcode/contracts";

// SAIHANDOFF F-01 (Q1): the goal runtime may mark a goal complete ONLY through
// isGoalCompletionComplete. Before the repair a single boolean carried both "no
// human-free work is left" and "the objective is complete", so a board whose only
// remainder was blocked on a human closed the goal. These are the contract-level
// controls for the gate.

test("only a COMPLETE disposition completes the goal", () => {
  assert.equal(
    isGoalCompletionComplete({ disposition: "complete", passed: true, reason: "board clear" }),
    true,
  );
  for (const disposition of ["blocked_human", "blocked_external", "invalid_or_unverified"] as const) {
    assert.equal(
      isGoalCompletionComplete({ disposition, passed: false, reason: "blocked" }),
      false,
      disposition,
    );
    // A contradictory producer cannot smuggle completion past the gate.
    assert.equal(
      isGoalCompletionComplete({ disposition, passed: true, reason: "blocked" }),
      false,
      disposition,
    );
  }
  assert.equal(
    isGoalCompletionComplete({ disposition: "continue", nextAction: "cc", passed: false, reason: "work left" }),
    false,
  );
});

test("a legacy verdict without a disposition keeps the meaning passed used to carry", () => {
  assert.equal(
    goalCompletionDispositionOf({ passed: true, reason: "done" }),
    GoalCompletionDisposition.Complete,
  );
  assert.equal(
    goalCompletionDispositionOf({ nextAction: "cc", passed: false, reason: "more work" }),
    GoalCompletionDisposition.Continue,
  );
  assert.equal(
    goalCompletionDispositionOf({ passed: false, reason: "verifier failed" }),
    GoalCompletionDisposition.InvalidOrUnverified,
  );
  // The legacy producer (and the model verifier) still completes when it passes,
  // which is what keeps this a compatible wire change rather than a breaking one.
  assert.equal(isGoalCompletionComplete({ passed: true, reason: "done" }), true);
});

test("blocked dispositions are the ones that park the goal", () => {
  assert.equal(isGoalCompletionBlockedDisposition(GoalCompletionDisposition.BlockedHuman), true);
  assert.equal(isGoalCompletionBlockedDisposition(GoalCompletionDisposition.BlockedExternal), true);
  for (const disposition of ["complete", "continue", "invalid_or_unverified"] as const) {
    assert.equal(isGoalCompletionBlockedDisposition(disposition), false, disposition);
  }
});

test("the verdict schema accepts the disposition and still rejects junk", () => {
  const withDisposition = GoalCompletionVerificationOutputSchema.safeParse({
    disposition: "blocked_human",
    passed: false,
    reason: "T-9 needs a human",
  });
  assert.equal(withDisposition.success, true);
  // A verdict that omits the field is still valid: older producers must not break.
  assert.equal(
    GoalCompletionVerificationOutputSchema.safeParse({ passed: true, reason: "done" }).success,
    true,
  );
  assert.equal(
    GoalCompletionVerificationOutputSchema.safeParse({
      disposition: "finished_somehow",
      passed: true,
      reason: "done",
    }).success,
    false,
  );
});
