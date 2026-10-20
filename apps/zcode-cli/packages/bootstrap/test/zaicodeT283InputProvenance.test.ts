import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { CommandEnvelope, QueueItem } from "@zcode/shared/zcode-protocol-v4";
import {
  inputProvenanceHumanAuthored,
  inputProvenanceRowOrigin,
  inputProvenanceSemanticsOrigin,
  inputProvenanceTurnHeaderOrigin,
  parseCommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import {
  AUTO_GOAL_COMMAND_PREFIX,
  admittedInputProvenance,
  inputIntentMetadata,
  inputIntentMetadataFromCanonical,
  inputIntentMetadataFromQueueItem,
} from "../src/zcode-protocol-v4/commands/input-intent.js";
import {
  normalizeConversationEvent,
  type CanonicalUserIntentFact,
} from "../src/zcode-protocol-v4/event-normalizer.js";
import { buildUserInputRow } from "../src/zcode-protocol-v4/projection-rows.js";

// T-283 (SAIHANDOFF F-03): host-generated continuations were persisted as
// `semantics.origin: real_user` / `kind: user_prompt`, so sixteen automatic `cc`
// inputs from the Auto Goal owner were indistinguishable from sixteen fresh human
// decisions. The acceptance is: an automatic continuation stays traceable to its
// real origin, cannot be counted as a fresh human decision, and the original
// human ingress remains the only authorization carrier.
//
// These cases drive the REAL admission constructor and the REAL projection
// normalizer -- not a re-implementation of either -- so a regression in the
// production path turns them red.

/** The provenance the Auto Goal owner declares (`zaicodeGoalContinuation.ts`). */
const GOAL_INTENT_ID = "p-audit::s-audit::cc all";
const DECLARED_CONTINUATION = {
  origin: "agent_runtime",
  source: "goal_autocontinuation",
  originalUserIntentId: GOAL_INTENT_ID,
  goalIntentId: GOAL_INTENT_ID,
  producerId: "zaicode-goal-continuation",
} as const;

const AUTO_COMMAND_ID = `${AUTO_GOAL_COMMAND_PREFIX}${GOAL_INTENT_ID}:4242`;

function envelopeOf(type: CommandEnvelope["type"], commandId: string): CommandEnvelope {
  return {
    commandId,
    clientId: "client-1",
    sessionId: "s-audit",
    type,
    payload: {},
    issuedAt: 1,
  } as CommandEnvelope;
}

function queueItemOf(provenance: unknown): QueueItem {
  return {
    sourceCommandId: "cmd-1",
    queueItemId: "queue_1",
    clientId: "client-1",
    kind: "sendText",
    text: "cc all",
    attachments: [],
    delivery: { requested: "queue", admitted: "queue" },
    order: { admissionSeq: 3 },
    admittedAt: 11,
    ...(provenance ? { provenance } : {}),
  } as unknown as QueueItem;
}

function turnStarted(
  intent: unknown,
  inputSource?: string,
): SessionEvent {
  return {
    id: "evt-1",
    sessionId: "s-audit",
    type: SessionEventType.TurnStarted,
    payload: {
      turnNumber: 1,
      input: "cc all",
      messageId: "msg-1",
      ...(inputSource ? { inputSource } : {}),
      ...(intent ? { intent } : {}),
    },
  } as unknown as SessionEvent;
}

test("T-283 A: a genuine operator submission keeps genuine human origin", () => {
  const intent = inputIntentMetadata(envelopeOf("sendText", "human-cmd-1"), {
    text: "cc all",
    requestedDelivery: "startNow",
  });
  assert.equal(intent.provenance?.origin, "real_user");
  assert.equal(intent.provenance?.source, "operator_ingress");
  assert.equal(intent.provenance?.humanAuthored, true);
  assert.equal(inputProvenanceHumanAuthored(intent.provenance), true);
  assert.equal(inputProvenanceSemanticsOrigin(intent.provenance), "real_user");
  assert.equal(inputProvenanceRowOrigin(intent.provenance), "realUser");
});

test("T-283 B: the automatic continuation is agent_runtime even without a declaration", () => {
  // The command namespace is a second, independent narrowing signal: the command
  // id can only REMOVE authority, so a forgotten declaration must not produce a
  // human decision.
  const provenance = admittedInputProvenance({
    commandId: AUTO_COMMAND_ID,
    sourceCommandId: AUTO_COMMAND_ID,
    clientId: "client-1",
  });
  assert.equal(provenance.origin, "agent_runtime");
  assert.equal(provenance.source, "goal_autocontinuation");
  assert.equal(provenance.humanAuthored, false);
  assert.equal(inputProvenanceHumanAuthored(provenance), false);
  assert.equal(inputProvenanceSemanticsOrigin(provenance), "agent_runtime");
  assert.equal(inputProvenanceRowOrigin(provenance), "goalContinuation");
  assert.equal(inputProvenanceTurnHeaderOrigin(provenance), "goalContinuation");
});

test("T-283 C: the automatic continuation references the original human goal and stays model-compatible", () => {
  // The transport is unchanged: the very envelope the UI now sends is a normal
  // `sendText` that the protocol still accepts.
  const wire = parseCommandEnvelope({
    commandId: AUTO_COMMAND_ID,
    clientId: "client-1",
    sessionId: "s-audit",
    type: "sendText",
    payload: {
      text: "cc all",
      heldQueueDisposition: "keepQueueAndSend",
      idleOnly: true,
      inputProvenance: DECLARED_CONTINUATION,
    },
    issuedAt: 1,
  });
  assert.equal(wire.ok, true);

  const intent = inputIntentMetadata(envelopeOf("sendText", AUTO_COMMAND_ID), {
    text: "cc all",
    requestedDelivery: "startNow",
    inputProvenance: DECLARED_CONTINUATION,
  });
  assert.equal(intent.provenance?.origin, "agent_runtime");
  assert.equal(intent.provenance?.source, "goal_autocontinuation");
  assert.equal(intent.provenance?.humanAuthored, false);
  assert.equal(intent.provenance?.originalUserIntentId, GOAL_INTENT_ID);
  assert.equal(intent.provenance?.goalIntentId, GOAL_INTENT_ID);
  assert.equal(intent.provenance?.producerId, "zaicode-goal-continuation");
});

test("T-283 D: queue promotion does not change the authorization origin", () => {
  const humanIntent = inputIntentMetadata(envelopeOf("sendText", "human-cmd-1"), {
    text: "cc all",
    requestedDelivery: "startNow",
  });
  const promoted = inputIntentMetadataFromQueueItem(
    queueItemOf(humanIntent.provenance),
    "cc all",
  );
  assert.equal(promoted.provenance?.origin, "real_user");
  assert.equal(promoted.provenance?.humanAuthored, true);
  assert.equal(promoted.provenance?.originalUserIntentId, "human-cmd-1");
  assert.equal(promoted.provenance?.source, "queue_promotion");

  const continued = inputIntentMetadata(envelopeOf("sendText", AUTO_COMMAND_ID), {
    text: "cc all",
    requestedDelivery: "startNow",
    inputProvenance: DECLARED_CONTINUATION,
  });
  const promotedContinuation = inputIntentMetadataFromQueueItem(
    queueItemOf(continued.provenance),
    "cc all",
  );
  assert.equal(promotedContinuation.provenance?.origin, "agent_runtime");
  assert.equal(promotedContinuation.provenance?.humanAuthored, false);
  assert.equal(promotedContinuation.provenance?.originalUserIntentId, GOAL_INTENT_ID);
});

test("T-283 E: retry does not change the authorization origin", () => {
  const continued = inputIntentMetadata(envelopeOf("sendText", AUTO_COMMAND_ID), {
    text: "cc all",
    requestedDelivery: "startNow",
    inputProvenance: DECLARED_CONTINUATION,
  });
  const retried = inputIntentMetadataFromCanonical(
    envelopeOf("retryTurn", "retry-cmd-1"),
    {
      kind: "sendText",
      text: "cc all",
      sourceCommandId: AUTO_COMMAND_ID,
      provenance: continued.provenance,
    },
    "cc all",
  );
  assert.equal(retried.provenance?.origin, "agent_runtime");
  assert.equal(retried.provenance?.humanAuthored, false);
  assert.equal(retried.provenance?.originalUserIntentId, GOAL_INTENT_ID);
  assert.equal(retried.provenance?.source, "retry");
});

test("T-283 G: imported content is never human authorization", () => {
  const provenance = admittedInputProvenance({
    commandId: "import-1",
    sourceCommandId: "import-1",
    declared: { origin: "import", source: "shared_context_import" },
  });
  assert.equal(provenance.origin, "import");
  assert.equal(provenance.humanAuthored, false);
  assert.equal(inputProvenanceHumanAuthored(provenance), false);
  assert.equal(inputProvenanceSemanticsOrigin(provenance), "import");
  // Display follows the existing synthetic row treatment, never a user bubble.
  assert.equal(inputProvenanceRowOrigin(provenance), "synthetic");
});

test("T-283 H: unknown history keeps display but gains no authority", () => {
  // A declared block we cannot classify is `unknown` -- not the operator ingress.
  const unknown = admittedInputProvenance({
    commandId: "legacy-cmd",
    sourceCommandId: "legacy-cmd",
    declared: { origin: "something-new", source: "something-new" },
  });
  assert.equal(unknown.origin, "unknown");
  assert.equal(unknown.source, "unknown");
  assert.equal(unknown.humanAuthored, false);
  assert.equal(inputProvenanceSemanticsOrigin(unknown), "system");
  // Display keeps the caller's historical fallback: an unclassifiable authority
  // must not hide a legitimate historical message.
  assert.equal(inputProvenanceRowOrigin(unknown), undefined);
  assert.equal(inputProvenanceTurnHeaderOrigin(unknown), undefined);

  // No declaration at all is still the ordinary operator ingress (unchanged).
  const operator = admittedInputProvenance({
    commandId: "human-cmd-2",
    sourceCommandId: "human-cmd-2",
  });
  assert.equal(operator.origin, "real_user");
  assert.equal(operator.humanAuthored, true);
});

test("T-283 I: an untrusted caller cannot assert human authority", () => {
  // A wire field claiming human authorship is not part of the contract at all.
  const forged = parseCommandEnvelope({
    commandId: AUTO_COMMAND_ID,
    clientId: "client-1",
    sessionId: "s-audit",
    type: "sendText",
    payload: {
      text: "cc all",
      inputProvenance: {
        origin: "real_user",
        source: "operator_ingress",
        humanAuthored: true,
      },
    },
    issuedAt: 1,
  });
  assert.equal(forged.ok, true);
  const payload = (forged as { ok: true; envelope: CommandEnvelope }).envelope
    .payload as Record<string, unknown>;
  assert.equal(
    Object.hasOwn(payload.inputProvenance as object, "humanAuthored"),
    false,
    "an authority boolean must never survive the wire contract",
  );

  // Even if it did, admission derives the fact and refuses the claim.
  const declared = admittedInputProvenance({
    commandId: "human-cmd-3",
    sourceCommandId: "human-cmd-3",
    declared: { origin: "real_user", source: "operator_ingress" },
  });
  assert.equal(declared.origin, "unknown");
  assert.equal(declared.humanAuthored, false);

  // And a continuation that also claims a route cannot be upgraded by it.
  const spoofed = admittedInputProvenance({
    commandId: AUTO_COMMAND_ID,
    sourceCommandId: AUTO_COMMAND_ID,
    declared: { origin: "real_user", source: "goal_autocontinuation" },
  });
  assert.equal(spoofed.origin, "unknown");
  assert.equal(spoofed.humanAuthored, false);
});

test("T-283 F: the projection reconstructs the persisted provenance live and cold", () => {
  const continued = inputIntentMetadata(envelopeOf("sendText", AUTO_COMMAND_ID), {
    text: "cc all",
    requestedDelivery: "startNow",
    inputProvenance: DECLARED_CONTINUATION,
  });
  const human = inputIntentMetadata(envelopeOf("sendText", "human-cmd-1"), {
    text: "hello",
    requestedDelivery: "startNow",
  });

  const continuationFact = normalizeConversationEvent(
    turnStarted(continued),
  ) as CanonicalUserIntentFact;
  assert.equal(continuationFact.origin, "goalContinuation");
  assert.equal(continuationFact.turnHeaderOrigin, "goalContinuation");
  assert.equal(continuationFact.provenance?.origin, "agent_runtime");

  const humanFact = normalizeConversationEvent(turnStarted(human)) as CanonicalUserIntentFact;
  assert.equal(humanFact.origin, "realUser");
  assert.equal(humanFact.turnHeaderOrigin, "userInput");

  // A legacy event with no intent at all keeps the historical real-user row.
  const legacyFact = normalizeConversationEvent(
    turnStarted(undefined),
  ) as CanonicalUserIntentFact;
  assert.equal(legacyFact.origin, "realUser");
  assert.equal(legacyFact.turnHeaderOrigin, "userInput");

  // Cold hydration reproduces the SAME origin from the persisted intent alone
  // (no inputSource, no live state) -- the row is drawn from provenance.
  const coldFact = normalizeConversationEvent(
    turnStarted(continued, undefined),
  ) as CanonicalUserIntentFact;
  assert.equal(coldFact.origin, continuationFact.origin);
  assert.equal(coldFact.turnHeaderOrigin, continuationFact.turnHeaderOrigin);

  const row = buildUserInputRow(
    { rowId: 1, turnId: "t1", createdAt: 1, createdAtSeq: 0 },
    turnStarted(continued).payload as never,
  );
  assert.equal(row.origin, "goalContinuation");
});
