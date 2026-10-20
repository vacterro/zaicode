import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType, type SessionEvent, type TurnSteerQueuedPayload } from "@zcode/contracts";
import { conversationTopicFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";

// T-294 / Investigation D (conversation Queue recovery).
//
// Why a producer frame test exists at all: `queueItemSchema` is
// `conversationInputIntentSchema.extend(...)` and the intent schema is `.strict()`,
// so ONE unknown key on a QueueItem rejects the WHOLE logical frame. This repo
// already paid for that class of fault twice (workflow actor/phase names,
// workflow display error object): producer adds a field -> every snapshot/delta/
// recovery frame carrying it is refused -> renderer escalates to
// `fault.subscription.recoveryFailed`. A larger retry budget cannot fix it.
//
// So the Queue path is only proven safe end-to-end by pushing the REAL producer's
// frames through the REAL strict schema. This drives the gateway's frame
// authority (`ConversationTopicPublisher`, which also owns the frame envelope and
// the logEpoch/seq watermarks) and parses each delivery kind with
// `conversationTopicFrameSchema` -- the same schema instance the renderer feeds to
// `TopicWireFrameAssembler` in packages/ui/src/v4/agentConversationTransport.ts.
// A SECOND, INTENT-LESS event exercises the legacy-runtime fallback in
// `ProductProjection.onTurnSteerQueued`, where `admittedAt` comes from
// `event.timestamp.getTime()` instead of the payload -- exactly where a `Date`
// could leak into a `timestampSchema = z.number()` field.
//
// Result (2026-10-10, T-294): the Queue producer's frames are schema-clean on
// initial, online-delta and recovery delivery. This CLEARS the strict-schema
// hypothesis for the Queue producer and leaves the operator's first transport
// event unproven, not explained away -- see the T-294 report item 3.

const NOW = 1_700_000_000_000;
const SESSION = "sess-t294-conformance";

function publisher(): ConversationTopicPublisher {
  return new ConversationTopicPublisher(SESSION, "log-1", { now: () => NOW });
}

/** The fields admission writes through `inputIntentMetadata` (see T-283 test). */
function fullPayload(overrides: Partial<TurnSteerQueuedPayload> = {}): TurnSteerQueuedPayload {
  return {
    pendingInputId: "pi-1",
    inputId: "input-1",
    queryId: "query-1",
    input: "rerun the queue recovery gate",
    inputPreview: "rerun the queue recovery gate",
    inputSize: 28,
    commandKind: "sendText",
    source: "real_user",
    delivery: "queue",
    targetTurnId: "turn-1",
    queueLength: 1,
    intent: {
      sourceCommandId: "cmd-1",
      queueItemId: "qi-1",
      clientId: "cli",
      kind: "sendText",
      admittedDelivery: "queue",
      requestedDelivery: "queue",
      admissionSeq: 1,
      queuePosition: 0,
      admittedAt: NOW,
      attachmentRefs: [],
      provenance: { sourceCommandId: "cmd-1", queueItemId: "qi-1", clientId: "cli" },
    } as TurnSteerQueuedPayload["intent"],
    ...overrides,
  };
}

function steerEvent(sequenceNumber: number, payload: TurnSteerQueuedPayload): SessionEvent {
  return {
    id: `ev-${sequenceNumber}`,
    sessionId: SESSION,
    type: SessionEventType.TurnSteerQueued,
    timestamp: new Date(NOW),
    traceId: `tr-${sequenceNumber}`,
    sequenceNumber,
    payload,
  } as SessionEvent;
}

test("T-294-D: the real Queue producer's frames pass the renderer's strict schema on every delivery kind", () => {
  const p = publisher();

  // 1. A queued input while running (intent present -> admittedAt from the payload).
  p.ingest(steerEvent(1, fullPayload()));

  const subscribed = p.subscribe({ connectionId: "c1" });
  const subscriptionId = subscribed.ack.subscriptionId;
  assert.ok(subscribed.frame, "subscribe must deliver an initial frame");

  // parse() throws on any unknown key anywhere in the strict QueueItem -> the
  // assertion below is the schema conformance proof, not a smoke test.
  const initial = conversationTopicFrameSchema.parse(subscribed.frame);
  assert.equal(initial.payload.kind, "snapshot");
  const initialSnapshot = initial.payload.kind === "snapshot" ? initial.payload.snapshot : null;
  assert.ok(initialSnapshot);
  assert.equal(initialSnapshot.queue.items.length, 1);
  assert.equal(initialSnapshot.queue.items[0].queueItemId, "qi-1");
  assert.equal(initialSnapshot.queue.items[0].text, "rerun the queue recovery gate");
  assert.equal(initialSnapshot.queue.items[0].dispatch.state, "queued");
  assert.equal(typeof initialSnapshot.queue.items[0].admittedAt, "number");

  // 2. A legacy-runtime event without `intent`/`delivery` (a pre-T-283 CLI):
  //    queueItemId falls back to pendingInputId, admittedAt falls back to
  //    event.timestamp.getTime(), and no field may leak a `Date`.
  p.ingest(
    steerEvent(2, {
      pendingInputId: "pi-2",
      inputId: "input-2",
      input: "second",
      inputPreview: "second",
      inputSize: 6,
      targetTurnId: "turn-1",
      queueLength: 2,
    }),
  );
  const queued = p.flush(subscriptionId);
  assert.ok(queued, "flush must deliver the queue delta of the second item");
  const online = conversationTopicFrameSchema.parse(queued);
  assert.equal(online.payload.kind, "deltas");

  // 3. Recovery under the SAME subscription id (the operator's failing path):
  //    a resync frame must be schema-valid too, or the renderer never recovers.
  const recoveryFrame = p.resync(subscriptionId);
  assert.ok(recoveryFrame, "resync must deliver a recovery frame");
  const recovery = conversationTopicFrameSchema.parse(recoveryFrame);
  assert.equal(recovery.payload.kind, "snapshot");
  const recoverySnapshot = recovery.payload.kind === "snapshot" ? recovery.payload.snapshot : null;
  assert.ok(recoverySnapshot);
  assert.equal(recoverySnapshot.queue.items.length, 2);
  for (const item of recoverySnapshot.queue.items) {
    assert.equal(typeof item.admittedAt, "number", `${item.queueItemId} admittedAt must be a number`);
  }
});

test("T-294-D negative control: one unknown QueueItem key rejects the whole frame (why the test above is load-bearing)", () => {
  const p = publisher();
  p.ingest(steerEvent(1, fullPayload()));
  const frame = p.subscribe({ connectionId: "c1" }).frame;
  assert.ok(frame);

  // Sanity: the untouched frame is accepted.
  assert.equal(conversationTopicFrameSchema.safeParse(frame).success, true);

  // A producer-side additive field the renderer schema does not know about.
  const withUnknownKey = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>;
  const snapshot = withUnknownKey.payload as {
    snapshot: { queue: { items: Record<string, unknown>[] } };
  };
  snapshot.snapshot.queue.items[0].queueSteerDeadline = NOW;

  const rejected = conversationTopicFrameSchema.safeParse(withUnknownKey);
  assert.equal(rejected.success, false, "strict QueueItem must refuse the unknown key");
  if (!rejected.success) {
    assert.ok(
      rejected.error.issues.some((issue) => issue.code === "unrecognized_keys"),
      `expected unrecognized_keys, got ${rejected.error.issues.map((i) => i.code).join(",")}`,
    );
  }
});
