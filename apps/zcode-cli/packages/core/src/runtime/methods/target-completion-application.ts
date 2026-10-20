import {
  goalCompletionDispositionOf,
  isGoalCompletionBlockedDisposition,
  isGoalCompletionComplete,
  traceContextToLogContext,
} from "../deps.js";
import type { GoalCompletionVerificationOutput, SessionGoal, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * SAIHANDOFF F-01 (Q1): applying a completion verdict to the active goal.
 *
 * The drift was one line: the completion path read `passed` as "the objective is
 * complete", so a board whose only remainder was blocked on a human closed the
 * goal. The decision is one owner now -- complete the goal ONLY on a COMPLETE
 * disposition, park it on a blocked one, and otherwise leave it open -- with one
 * reader and one place to test, instead of a boolean interpreted at three
 * call sites.
 */
export interface GoalCompletionApplication {
  target: SessionGoal;
  verification: GoalCompletionVerificationOutput;
}

/** Apply a verifier verdict to the active goal; the verdict itself is never rewritten. */
export async function applyGoalCompletionVerdict(
  this: AgentRuntimeInternal,
  input: {
    target: SessionGoal;
    traceContext: TraceContext;
    verification: GoalCompletionVerificationOutput;
  },
): Promise<GoalCompletionApplication> {
  const { target, traceContext, verification } = input;
  const unchanged: GoalCompletionApplication = { target, verification };
  const store = this.sessionStore;
  if (!store) return unchanged;

  if (!isGoalCompletionComplete(verification)) {
    if (isGoalCompletionBlockedDisposition(goalCompletionDispositionOf(verification))) {
      await parkBlockedActiveGoal.call(this, { reason: verification.reason, target, traceContext });
    }
    return unchanged;
  }

  const previousTarget = await this.readSessionTargetForContext(traceContext);
  const completedTarget =
    (await store.updateTargetStatus({
      sessionID: this.sessionId,
      status: "complete",
    })) ?? target;
  await this.recordTargetChanged({
    action: "status_updated",
    previousTarget,
    source: "runtime",
    target: completedTarget,
    traceContext,
  });

  return {
    target: completedTarget,
    verification,
  };
}

/**
 * Park an active goal whose verdict is blocked on a human or an external
 * resource. Paused is this product's resumable, non-terminal goal state: it stops
 * autonomous continuation, it is never reported complete, and the operator's
 * explicit resumeGoal (/goal resume) takes the goal up again once the dependency
 * is gone. Best-effort by design -- the verdict is already truthful and already
 * published, so a failed status write is logged, never promoted to a failed turn.
 */
async function parkBlockedActiveGoal(
  this: AgentRuntimeInternal,
  input: { reason: string; target: SessionGoal; traceContext: TraceContext },
): Promise<void> {
  const store = this.sessionStore;
  if (!store) return;
  try {
    // Re-read before mutating: the verifier request is asynchronous, and the
    // operator may have stopped or replaced the goal while it was in flight.
    const latest = await this.readSessionTargetForContext(input.traceContext);
    if (!latest || latest.status !== "active" || latest.targetID !== input.target.targetID) return;
    const pausedTarget = await store.updateTargetStatus({
      sessionID: this.sessionId,
      status: "paused",
    });
    if (!pausedTarget) return;
    await this.recordTargetChanged({
      action: "status_updated",
      previousTarget: latest,
      source: "runtime",
      target: pausedTarget,
      traceContext: input.traceContext,
    });
  } catch (error) {
    this.logger?.warn("Goal park after a blocked verdict failed", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.completion_verification.blocked_park_failed",
      module: "core.runtime",
      reason: input.reason,
      status: "failed",
      targetId: input.target.targetID,
    });
  }
}
