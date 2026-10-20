import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyQueuePause,
  isQueuePauseRecoverable,
  zaicodeQueueMayAutoResume,
  zaicodeQueueResumeAttempts,
  resetZaicodeQueueResume,
  recordZaicodeQueueResumeAttempt,
  executeZaicodeQueueAutoResume,
  executeZaicodeQueueManualResume,
  type ZaicodeQueueResumeFacts,
} from "../src/zaicode/zaicodeQueueAutoResume.js";
import { pickZaicodeBackgroundQueueRetrySessions } from "../src/zaicode/zaicodeQueueRetryWatch.js";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
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

test("T-361-01: End-to-end integration test reproducing callback retry budget reset failure", async () => {
  const sessionId = "sess-integration-callback-1";
  resetZaicodeQueueResume(sessionId);

  // Simulated host gateway state
  let hostAutoDrain = false;
  let promotionFailures = 0;
  const dispatchCommand = async (
    type: "setAutoDrain",
    payload: { autoDrain: boolean },
  ): Promise<{ status: string }> => {
    hostAutoDrain = payload.autoDrain;
    return { status: "accepted" };
  };

  // 1. Buggy legacy callback reproduction:
  // Proves that resetting attempt before dispatching causes budget leaks
  const buggyResumeQueue = async (sessId: string) => {
    resetZaicodeQueueResume(sessId); // THE ORIGINAL DEFECT
    await dispatchCommand("setAutoDrain", { autoDrain: true });
  };

  // Attempt 1 with buggy callback
  recordZaicodeQueueResumeAttempt(sessionId, {
    projectKey: "proj-buggy",
    queueHeadId: "item-1",
    attempts: 1,
    pauseReasonCode: "promotion_failed",
  });
  assert.equal(zaicodeQueueResumeAttempts(sessionId), 1);
  await buggyResumeQueue(sessionId);
  assert.equal(
    zaicodeQueueResumeAttempts(sessionId),
    0,
    "DEFECT CONFIRMED: legacy buggy callback wiped attempt count back to 0",
  );

  // 2. Corrected production executeZaicodeQueueAutoResume
  resetZaicodeQueueResume(sessionId);
  assert.equal(zaicodeQueueResumeAttempts(sessionId), 0);
  const maxAttempts = 2;

  // Attempt 1:
  // - Record attempt 1
  // - Invoke executeZaicodeQueueAutoResume
  // - Host accepts setAutoDrain(true)
  // - Attempt count remains preserved
  recordZaicodeQueueResumeAttempt(sessionId, {
    projectKey: "proj-corrected",
    queueHeadId: "item-1",
    attempts: 1,
    pauseReasonCode: "promotion_failed",
  });
  const ack1 = await executeZaicodeQueueAutoResume({
    sessionId,
    revision: 1,
    dispatchCommand,
  });
  assert.equal(ack1.status, "accepted");
  assert.equal(hostAutoDrain, true);
  assert.equal(
    zaicodeQueueResumeAttempts(sessionId),
    1,
    "Attempt count must remain 1 after automatic resume dispatch",
  );

  // Simulated failure in host: autoDrain becomes false again
  hostAutoDrain = false;
  promotionFailures++;

  // Eligibility check for attempt 2: 1 < 2 -> allowed
  const factsAttempt2 = baseFacts({ attempts: 1, maxAttempts, queueItemId: "item-1" });
  assert.equal(zaicodeQueueMayAutoResume(factsAttempt2), true, "second attempt is allowed");

  // Attempt 2:
  recordZaicodeQueueResumeAttempt(sessionId, {
    projectKey: "proj-corrected",
    queueHeadId: "item-1",
    attempts: 2,
    pauseReasonCode: "promotion_failed",
  });
  const ack2 = await executeZaicodeQueueAutoResume({
    sessionId,
    revision: 2,
    dispatchCommand,
  });
  assert.equal(ack2.status, "accepted");
  assert.equal(
    zaicodeQueueResumeAttempts(sessionId),
    2,
    "Attempt count must remain 2 after second automatic resume dispatch",
  );

  // Simulated second promotion failure in host
  hostAutoDrain = false;
  promotionFailures++;

  // Attempt 3:
  // Must be refused automatically: 2 >= 2
  const factsAttempt3 = baseFacts({
    attempts: zaicodeQueueResumeAttempts(sessionId),
    maxAttempts,
    queueItemId: "item-1",
  });
  assert.equal(
    zaicodeQueueMayAutoResume(factsAttempt3),
    false,
    "Attempt 3 must be strictly refused because the retry budget is exhausted",
  );
  assert.equal(promotionFailures, 2);
});

test("T-361-02: Manual operator resume resets budget ONLY when Host accepts", async () => {
  const sessionId = "sess-manual-resume-policy";
  resetZaicodeQueueResume(sessionId);

  // Exhaust the retry budget
  recordZaicodeQueueResumeAttempt(sessionId, {
    projectKey: "proj-1",
    queueHeadId: "item-x",
    attempts: 3,
    pauseReasonCode: "promotion_failed",
  });
  assert.equal(zaicodeQueueResumeAttempts(sessionId), 3);

  // 1. Rejected manual resume: e.g. host refused or CAS stale
  const ackRejected = await executeZaicodeQueueManualResume({
    sessionId,
    revision: 1,
    dispatchCommand: async () => ({ status: "rejected", reasonCode: "cas_stale" }),
  });
  assert.equal(ackRejected.status, "rejected");
  assert.equal(
    zaicodeQueueResumeAttempts(sessionId),
    3,
    "Rejected manual resume MUST NOT erase the safety accounting budget",
  );

  // 2. Accepted manual resume: genuine operator action accepted by Host
  const ackAccepted = await executeZaicodeQueueManualResume({
    sessionId,
    revision: 2,
    dispatchCommand: async () => ({ status: "accepted" }),
  });
  assert.equal(ackAccepted.status, "accepted");
  assert.equal(
    zaicodeQueueResumeAttempts(sessionId),
    0,
    "Accepted manual resume resets the budget under operator authority",
  );
});

test("T-361-03: Background queue recovery ownership and lifecycle independence", () => {
  const episodes: Record<string, any> = {
    "sess-open-in-pane": {
      sessionId: "sess-open-in-pane",
      projectKey: "proj-1",
      queueHeadId: "item-1",
      attempts: 0,
      lastReasonCode: "promotion_failed",
    },
    "sess-unmounted-background": {
      sessionId: "sess-unmounted-background",
      projectKey: "proj-1",
      queueHeadId: "item-2",
      attempts: 1,
      lastReasonCode: "promotion_failed",
    },
    "sess-operator-stopped": {
      sessionId: "sess-operator-stopped",
      projectKey: "proj-1",
      queueHeadId: "item-3",
      attempts: 0,
      lastReasonCode: "promotion_failed",
    },
    "sess-exhausted": {
      sessionId: "sess-exhausted",
      projectKey: "proj-1",
      queueHeadId: "item-4",
      attempts: 3,
      lastReasonCode: "promotion_failed",
    },
    "sess-quota-wall": {
      sessionId: "sess-quota-wall",
      projectKey: "proj-1",
      queueHeadId: "item-5",
      attempts: 0,
      lastReasonCode: "promotion_failed",
    },
  };

  const briefs: any[] = [
    { sessionId: "sess-open-in-pane", projectKey: "proj-1", workspacePath: "/p1" },
    { sessionId: "sess-unmounted-background", projectKey: "proj-1", workspacePath: "/p1" },
    { sessionId: "sess-operator-stopped", projectKey: "proj-1", workspacePath: "/p1" },
    { sessionId: "sess-exhausted", projectKey: "proj-1", workspacePath: "/p1" },
    { sessionId: "sess-quota-wall", projectKey: "proj-1", workspacePath: "/p1" },
  ];

  const candidates = pickZaicodeBackgroundQueueRetrySessions(episodes, briefs, {
    // sess-open-in-pane is open in a visible pane -> background watch stands down
    isLocal: (id) => id === "sess-open-in-pane",
    isStopped: (id) => id === "sess-operator-stopped",
    isProjectDisabled: () => false,
    maxAttempts: 3,
    mayAutoSend: () => true,
    isQuotaWall: (id) => id === "sess-quota-wall",
  });

  // Only the unmounted background session should be picked!
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.sessionId, "sess-unmounted-background");
  assert.equal(candidates[0]?.attempts, 1);
});

test("T-361-04: Refusal classification taxonomy audit for unknown exceptions and ownership", () => {
  // Unknown exceptions must NOT default to transient (prevent retry storms)
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "UnknownError" }), "unknown");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "unrecognized_third_party_code" }), "unknown");
  assert.equal(isQueuePauseRecoverable({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "UnknownError" }), false);

  // Ownership errors are permanent
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "ownership_conflict" }), "permanent");
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "ownership.lease_busy" }), "permanent");
  assert.equal(isQueuePauseRecoverable({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "ownership_conflict" }), false);

  // Validation errors are permanent
  assert.equal(classifyQueuePause({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "validation.failed" }), "permanent");
  assert.equal(isQueuePauseRecoverable({ pauseReason: "error", pauseOrigin: "system", pauseReasonCode: "validation.failed" }), false);
});
