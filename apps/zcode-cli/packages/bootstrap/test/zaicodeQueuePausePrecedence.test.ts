import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

function makeQueueAutoDrainEvent(
  sessionId: string,
  seq: number,
  payload: Record<string, unknown>,
): SessionEvent {
  return {
    id: `evt-${seq}`,
    sessionId,
    type: SessionEventType.QueueAutoDrainChanged,
    timestamp: Date.now() + seq,
    sequenceNumber: seq,
    payload,
  } as SessionEvent;
}

test("T-360: ProductProjection onQueueAutoDrainChanged 4-tuple comparison & idempotence", () => {
  const sessionId = "sess-pause-proj-1";
  const projection = new ProductProjection(sessionId, "epoch-1");

  // Initial state: autoDrain is true
  assert.equal(projection.getSnapshot().queue.autoDrain, true);

  // 1. First pause event: error/system/codeA
  const deltas1 = projection.applyEvent(
    makeQueueAutoDrainEvent(sessionId, 1, {
      autoDrain: false,
      pauseReason: "error",
      pauseOrigin: "system",
      pauseReasonCode: "codeA",
    }),
  );
  assert.equal(deltas1.length, 1, "first pause publishes a delta");
  const q1 = projection.getSnapshot().queue;
  assert.equal(q1.autoDrain, false);
  assert.equal(q1.pauseReason, "error");
  assert.equal(q1.pauseOrigin, "system");
  assert.equal(q1.pauseReasonCode, "codeA");

  // 2. Identical event repeated: must be completely idempotent (0 deltas)
  const deltas2 = projection.applyEvent(
    makeQueueAutoDrainEvent(sessionId, 2, {
      autoDrain: false,
      pauseReason: "error",
      pauseOrigin: "system",
      pauseReasonCode: "codeA",
    }),
  );
  assert.equal(deltas2.length, 0, "identical pause event produces no deltas (idempotent)");

  // 3. Reason code changed: codeA -> codeB
  const deltas3 = projection.applyEvent(
    makeQueueAutoDrainEvent(sessionId, 3, {
      autoDrain: false,
      pauseReason: "error",
      pauseOrigin: "system",
      pauseReasonCode: "codeB",
    }),
  );
  assert.equal(deltas3.length, 1, "reason code change publishes an update delta");
  assert.equal(projection.getSnapshot().queue.pauseReasonCode, "codeB");

  // 4. Operator manual pause overrides system pause
  const deltas4 = projection.applyEvent(
    makeQueueAutoDrainEvent(sessionId, 4, {
      autoDrain: false,
      pauseReason: "manual",
      pauseOrigin: "user",
      pauseReasonCode: "operator_pause",
    }),
  );
  assert.equal(deltas4.length, 1, "operator pause publishes an update delta");
  const q4 = projection.getSnapshot().queue;
  assert.equal(q4.pauseReason, "manual");
  assert.equal(q4.pauseOrigin, "user");

  // 5. Subsequent system error CANNOT silently overwrite operator pause (precedence rule)
  const deltas5 = projection.applyEvent(
    makeQueueAutoDrainEvent(sessionId, 5, {
      autoDrain: false,
      pauseReason: "error",
      pauseOrigin: "system",
      pauseReasonCode: "promotion_failed",
    }),
  );
  assert.equal(deltas5.length, 0, "system error cannot overwrite operator manual pause");
  const q5 = projection.getSnapshot().queue;
  assert.equal(q5.pauseReason, "manual");
  assert.equal(q5.pauseOrigin, "user");

  // 6. Enabling autoDrain clears all pause metadata atomically
  const deltas6 = projection.applyEvent(
    makeQueueAutoDrainEvent(sessionId, 6, {
      autoDrain: true,
    }),
  );
  assert.equal(deltas6.length, 1, "autoDrain=true publishes an update delta");
  const q6 = projection.getSnapshot().queue;
  assert.equal(q6.autoDrain, true);
  assert.equal(q6.pauseReason, undefined);
  assert.equal(q6.pauseOrigin, undefined);
  assert.equal(q6.pauseReasonCode, undefined);
});

test("T-360: ProductProjection preserves SAIPEN guard pause over generic system errors", () => {
  const sessionId = "sess-pause-proj-2";
  const projection = new ProductProjection(sessionId, "epoch-1");

  // Pause with SAIPEN refusal code
  projection.applyEvent(
    makeQueueAutoDrainEvent(sessionId, 1, {
      autoDrain: false,
      pauseReason: "error",
      pauseOrigin: "system",
      pauseReasonCode: "guard.recognizedContinueSaipenPreconditionUnmet",
    }),
  );
  const q1 = projection.getSnapshot().queue;
  assert.equal(q1.pauseReasonCode, "guard.recognizedContinueSaipenPreconditionUnmet");

  // Generic incoming system error
  const deltas = projection.applyEvent(
    makeQueueAutoDrainEvent(sessionId, 2, {
      autoDrain: false,
      pauseReason: "error",
      pauseOrigin: "system",
      pauseReasonCode: "network_timeout",
    }),
  );
  assert.equal(deltas.length, 0, "generic system error cannot overwrite SAIPEN refusal code");
  assert.equal(projection.getSnapshot().queue.pauseReasonCode, "guard.recognizedContinueSaipenPreconditionUnmet");
});
