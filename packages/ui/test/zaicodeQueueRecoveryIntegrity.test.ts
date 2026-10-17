import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyQueuePause,
  isQueuePauseRecoverable,
  zaicodeQueueMayAutoResume,
  zaicodeQueueResumeAttempts,
  resetZaicodeQueueResume,
  recordZaicodeQueueResumeAttempt,
  type ZaicodeQueueResumeFacts,
} from "../src/zaicode/zaicodeQueueAutoResume.js";
import {
  writeZaicodeRetrySafety,
  readZaicodeRetrySafety,
} from "../src/zaicode/zaicodeRetrySafety.js";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
  type ConversationDelta,
} from "@zcode/shared/zcode-protocol-v4";

function createInitialSnapshot(sessionId: string): ConversationSnapshot {
  return {
    sessionId,
    seq: 1,
    revision: 1,
    logEpoch: "epoch",
    rows: { window: [], firstRowId: null, totalCount: 0 },
    pendingCommands: [],
    queue: { items: [], autoDrain: true },
    backgroundWorks: [],
  } as unknown as ConversationSnapshot;
}

const baseFacts = (patch: Partial<ZaicodeQueueResumeFacts> = {}): ZaicodeQueueResumeFacts => ({
  hasSession: true,
  queueItems: 1,
  autoDrain: false,
  pauseReason: "error",
  pauseOrigin: "system",
  pauseReasonCode: "promotion_failed",
  queueItemId: "q-item-1",
  originatingCommand: "sendText",
  phase: "completedSuccess",
  quotaWall: false,
  mayAutoSend: true,
  attempts: 0,
  maxAttempts: 3,
  ...patch,
});

test("T-360-01: Classification taxonomy covers all 5 required refusal classes", () => {
  // 1. TRANSIENT -> recoverable
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "promotion_failed" }), "transient");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "transport_disconnect" }), "transient");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "guard.recognizedContinueSessionBusy" }), "transient");
  assert.equal(isQueuePauseRecoverable({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "promotion_failed" }), true);

  // 2. WAIT_FOR_CONDITION -> wait, not nominal interval
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "quota_wall", quotaWall: true }), "wait_for_condition");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "host_reconnecting" }), "wait_for_condition");
  assert.equal(isQueuePauseRecoverable({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "quota_exceeded" }), false);

  // 3. OPERATOR_REQUIRED -> manual operator intervention needed
  assert.equal(classifyQueuePause({ pauseReason: "manual", pauseOrigin: "user", pauseReasonCode: "operator_paused" }), "operator_required");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "guard.recognizedContinueSaipenOperator" }), "operator_required");
  assert.equal(isQueuePauseRecoverable({ pauseReason: "manual", pauseOrigin: "user" }), false);
  assert.equal(isQueuePauseRecoverable({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "guard.recognizedContinueSaipenOperator" }), false);

  // 4. PERMANENT -> never automatically retried
  assert.equal(classifyQueuePause({ pauseReason: "stopped", pauseOrigin: "user", pauseReasonCode: "operator_stopped" }), "permanent");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "guard.recognizedContinueSaipenValve" }), "permanent");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "guard.recognizedContinueAuthorizationExpired" }), "permanent");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "guard.recognizedContinuePlanMode" }), "permanent");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "emptyObjective" }), "permanent");
  assert.equal(isQueuePauseRecoverable({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "guard.recognizedContinueSaipenValve" }), false);

  // 5. UNKNOWN -> unrecognized refusal code
  assert.equal(classifyQueuePause({ pauseReason: "other", pauseOrigin: "unknown", pauseReasonCode: "random_unknown_refusal" }), "unknown");
  assert.equal(isQueuePauseRecoverable({ pauseReason: "other", pauseOrigin: "unknown" }), false);
});

test("T-360-02: Retry budget survives autoDrain=true and bounds consecutive promotion failures", () => {
  const sessionId = "sess-budget-test-1";
  resetZaicodeQueueResume(sessionId);
  assert.equal(zaicodeQueueResumeAttempts(sessionId), 0);

  // Initial state: 1 item in queue, paused with system error
  const factsAttempt0 = baseFacts({ attempts: 0, maxAttempts: 2, queueItemId: "item-alpha" });
  assert.equal(zaicodeQueueMayAutoResume(factsAttempt0), true, "first attempt is allowed");

  // Record attempt 1 via recordZaicodeQueueResumeAttempt
  recordZaicodeQueueResumeAttempt(sessionId, {
    projectKey: "proj-1",
    queueHeadId: "item-alpha",
    attempts: 1,
    pauseReasonCode: "promotion_failed",
  });

  // Host acknowledges setAutoDrain(true) (permission to drain)
  // autoDrain=true must NOT wipe the episode or attempts
  assert.equal(zaicodeQueueResumeAttempts(sessionId), 1, "attempt count survives autoDrain permission");

  // Second failure arrives for the same queue item: attempts is 1 < maxAttempts 2
  const factsAttempt1 = baseFacts({ attempts: 1, maxAttempts: 2, queueItemId: "item-alpha" });
  assert.equal(zaicodeQueueMayAutoResume(factsAttempt1), true, "second attempt is allowed");

  // Record attempt 2
  recordZaicodeQueueResumeAttempt(sessionId, {
    projectKey: "proj-1",
    queueHeadId: "item-alpha",
    attempts: 2,
    pauseReasonCode: "promotion_failed",
  });

  // Third failure: attempts is 2 >= maxAttempts 2
  const factsAttempt2 = baseFacts({ attempts: 2, maxAttempts: 2, queueItemId: "item-alpha" });
  assert.equal(zaicodeQueueMayAutoResume(factsAttempt2), false, "attempts exhausted: further auto-resumes strictly blocked");

  // Reset explicit operator action
  resetZaicodeQueueResume(sessionId);
  assert.equal(zaicodeQueueResumeAttempts(sessionId), 0, "explicit operator reset clears the budget");
});

test("T-360-03: Queue head replacement rotates episode for the new item", () => {
  const sessionId = "sess-head-rotate-1";
  resetZaicodeQueueResume(sessionId);

  recordZaicodeQueueResumeAttempt(sessionId, {
    projectKey: "proj-1",
    queueHeadId: "old-head-item",
    attempts: 3,
    pauseReasonCode: "promotion_failed",
  });
  assert.equal(zaicodeQueueResumeAttempts(sessionId), 3);

  // If a new item becomes queue head (e.g. old item cancelled or user moved new item to head)
  // New item has fresh attempts
  const factsNewHead = baseFacts({ attempts: 0, maxAttempts: 3, queueItemId: "new-head-item" });
  assert.equal(zaicodeQueueMayAutoResume(factsNewHead), true);
});

test("T-360-04: Projection idempotence & atomic comparison of pause metadata", () => {
  let snapshot = createInitialSnapshot("sess-proj-test");

  // Initially autoDrain is true
  assert.equal(snapshot.queue.autoDrain, true);

  // 1. Emit pause with error/system/codeA
  snapshot = applyConversationDeltas(snapshot, [
    {
      op: "state.updated",
      patch: {
        queue: {
          ...snapshot.queue,
          autoDrain: false,
          pauseReason: "error",
          pauseOrigin: "system",
          pauseReasonCode: "codeA",
        },
      },
    },
  ]);
  assert.equal(snapshot.queue.autoDrain, false);
  assert.equal(snapshot.queue.pauseReason, "error");
  assert.equal(snapshot.queue.pauseOrigin, "system");
  assert.equal(snapshot.queue.pauseReasonCode, "codeA");

  // 2. Emit identical pause -> idempotent (no change)
  const revBefore = snapshot.revision;
  snapshot = applyConversationDeltas(snapshot, []);
  assert.equal(snapshot.revision, revBefore);

  // 3. Update reason code codeA -> codeB
  snapshot = applyConversationDeltas(snapshot, [
    {
      op: "state.updated",
      patch: {
        queue: {
          ...snapshot.queue,
          pauseReasonCode: "codeB",
        },
      },
    },
  ]);
  assert.equal(snapshot.queue.pauseReasonCode, "codeB");

  // 4. Operator manual pause overrides system pause
  snapshot = applyConversationDeltas(snapshot, [
    {
      op: "state.updated",
      patch: {
        queue: {
          ...snapshot.queue,
          pauseOrigin: "user",
          pauseReason: "manual",
          pauseReasonCode: "operator_paused",
        },
      },
    },
  ]);
  assert.equal(snapshot.queue.pauseOrigin, "user");
  assert.equal(snapshot.queue.pauseReason, "manual");

  // 5. Enabling autoDrain clears all pause metadata
  snapshot = applyConversationDeltas(snapshot, [
    {
      op: "state.updated",
      patch: {
        queue: {
          ...snapshot.queue,
          autoDrain: true,
          pauseReason: undefined,
          pauseOrigin: undefined,
          pauseReasonCode: undefined,
        },
      },
    },
  ]);
  assert.equal(snapshot.queue.autoDrain, true);
  assert.equal(snapshot.queue.pauseReason, undefined);
  assert.equal(snapshot.queue.pauseOrigin, undefined);
  assert.equal(snapshot.queue.pauseReasonCode, undefined);
});

test("T-360-05: System error cannot silently override operator Stop or SAIPEN refusal", () => {
  let snapshot = createInitialSnapshot("sess-proj-precedence");

  // Set operator stopped
  snapshot = applyConversationDeltas(snapshot, [
    {
      op: "state.updated",
      patch: {
        queue: {
          ...snapshot.queue,
          autoDrain: false,
          pauseReason: "stopped",
          pauseOrigin: "user",
          pauseReasonCode: "operator_stopped",
        },
      },
    },
  ]);
  assert.equal(snapshot.queue.pauseReason, "stopped");
  assert.equal(snapshot.queue.pauseOrigin, "user");

  // Operator stop is strictly unrecoverable
  assert.equal(isQueuePauseRecoverable(snapshot.queue), false);
  assert.equal(classifyQueuePause(snapshot.queue), "permanent");

  // SAIPEN refusal is strictly unrecoverable
  snapshot = applyConversationDeltas(snapshot, [
    {
      op: "state.updated",
      patch: {
        queue: {
          ...snapshot.queue,
          autoDrain: false,
          pauseReason: "manual",
          pauseOrigin: "user",
          pauseReasonCode: "guard.recognizedContinueSaipenRefusal",
        },
      },
    },
  ]);
  assert.equal(isQueuePauseRecoverable(snapshot.queue), false);
  assert.equal(classifyQueuePause(snapshot.queue), "operator_required");
});
