import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGoalCompletionVerdict } from "../src/runtime/methods/target-completion-application.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { SessionGoal } from "../src/runtime/deps.js";

// SAIHANDOFF F-01 (Q1): the acceptance is "43 DONE and one human-blocked ticket
// stays resumable and never reports complete". These are the runtime-level controls
// for that claim: the goal is only ever written COMPLETE by a COMPLETE verdict, and a
// blocked verdict parks it instead.

const activeGoal: SessionGoal = {
  sessionID: "sess_t281",
  targetID: "goal_t281",
  objective: "cc all",
  summaryTitle: null,
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  time: { created: 1, updated: 2 },
};

interface Recorded {
  status?: string;
  changes: { action?: string; target?: SessionGoal }[];
  writes: number;
}

function runtimeStub(current: SessionGoal | null, recording: Recorded): AgentRuntimeInternal {
  const store = {
    updateTargetStatus: async (input: { sessionID: string; status: string }) => {
      recording.writes += 1;
      recording.status = input.status;
      return { ...activeGoal, status: input.status } as SessionGoal;
    },
  };
  const stub = {
    logger: { info: () => {}, warn: () => {} },
    readSessionTargetForContext: async () => current,
    recordTargetChanged: async (payload: { action?: string; target?: SessionGoal }) => {
      recording.changes.push(payload);
    },
    sessionId: "sess_t281",
    sessionStore: store,
  };
  return stub as unknown as AgentRuntimeInternal;
}

function recording(): Recorded {
  return { changes: [], writes: 0 };
}

test("a COMPLETE verdict marks the goal complete", async () => {
  const calls = recording();
  const result = await applyGoalCompletionVerdict.call(
    runtimeStub(activeGoal, calls),
    {
      target: activeGoal,
      traceContext: {} as never,
      verification: { disposition: "complete", passed: true, reason: "board clear: 43 done" },
    },
  );
  assert.equal(calls.status, "complete");
  assert.equal(result.target.status, "complete");
  assert.equal(calls.changes.length, 1);
  assert.equal(calls.changes[0]?.action, "status_updated");
});

test("a human-blocked verdict parks the goal and never writes complete", async () => {
  const calls = recording();
  const result = await applyGoalCompletionVerdict.call(
    runtimeStub(activeGoal, calls),
    {
      target: activeGoal,
      traceContext: {} as never,
      verification: {
        disposition: "blocked_human",
        passed: false,
        reason: "SAIPEN still needs a human for 1 ticket(s) (T-1402) after 43 done",
      },
    },
  );
  assert.equal(calls.status, "paused");
  assert.notEqual(calls.status, "complete");
  assert.equal(result.target.status, "active");
  assert.equal(result.verification.disposition, "blocked_human");
});

test("an external-blocked verdict parks the goal too", async () => {
  const calls = recording();
  await applyGoalCompletionVerdict.call(runtimeStub(activeGoal, calls), {
    target: activeGoal,
    traceContext: {} as never,
    verification: { disposition: "blocked_external", passed: false, reason: "outside the session" },
  });
  assert.equal(calls.status, "paused");
});

test("a contradictory verdict cannot smuggle completion past the gate", async () => {
  const calls = recording();
  await applyGoalCompletionVerdict.call(runtimeStub(activeGoal, calls), {
    target: activeGoal,
    traceContext: {} as never,
    verification: { disposition: "blocked_human", passed: true, reason: "43 done; 1 blocked on a human" },
  });
  assert.equal(calls.status, "paused");
  assert.equal(calls.changes.length, 1);
});

test("a verifier that failed without a next action does not touch the goal", async () => {
  const calls = recording();
  const result = await applyGoalCompletionVerdict.call(runtimeStub(activeGoal, calls), {
    target: activeGoal,
    traceContext: {} as never,
    verification: { passed: false, reason: "the completion verifier did not return valid JSON" },
  });
  assert.equal(calls.writes, 0);
  assert.equal(result.target.status, "active");
});

test("a continue verdict leaves the goal active", async () => {
  const calls = recording();
  await applyGoalCompletionVerdict.call(runtimeStub(activeGoal, calls), {
    target: activeGoal,
    traceContext: {} as never,
    verification: { nextAction: "cc — continue SAIPEN: T-7", passed: false, reason: "actionable work" },
  });
  assert.equal(calls.writes, 0);
});

test("the park never rewrites a goal that is no longer the verified active one", async () => {
  const calls = recording();
  const replaced: SessionGoal = { ...activeGoal, status: "complete", targetID: "goal_other" };
  await applyGoalCompletionVerdict.call(runtimeStub(replaced, calls), {
    target: activeGoal,
    traceContext: {} as never,
    verification: { disposition: "blocked_human", passed: false, reason: "blocked" },
  });
  assert.equal(calls.writes, 0);
});
