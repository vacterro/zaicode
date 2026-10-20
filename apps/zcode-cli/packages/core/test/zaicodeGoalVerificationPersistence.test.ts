import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GoalCompletionDisposition,
  GoalCompletionEvidenceReceiptSchema,
  GoalCompletionVerificationOutputSchema,
  type GoalCompletionVerificationOutput,
} from "@zcode/contracts";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeMessageWithPartsSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeTimelineVerificationSchema,
} from "@zcode/shared";

// T-304 (P1): CLEAR MAIN refuses to hydrate a session whose stored goal verifier
// record carries the SAIHANDOFF receipt, because the persisting reader is stricter
// than the producer. This is the whole producer -> store -> reader chain, in one
// place: the verdict the runtime writes (F-01 disposition, F-05 evidence) must
// survive the snapshot schema that the session/resume response is parsed with --
// that parse is what `clear()` runs before it may send clearConversation.

const WORKSPACE = { workspacePath: "C:/work/protrail", workspaceKey: "protrail" };

/**
 * The keys a schema declares, unwrapping an optional first. Written against the
 * shape both zod generations expose, because the producer schema (contracts, zod 3)
 * and the reader schema (shared, zod 4) are two copies of one contract.
 */
function declaredKeys(schema: unknown): string[] {
  const current = unwrap(schema);
  const shape = (current as { shape?: unknown }).shape;
  return Object.keys((shape ?? {}) as Record<string, unknown>).sort();
}

function unwrap(schema: unknown): unknown {
  const holder = schema as { def?: { innerType?: unknown }; _def?: { innerType?: unknown } };
  const inner = holder?.def?.innerType ?? holder?._def?.innerType;
  return inner ? unwrap(inner) : schema;
}

/** A verdict exactly as `saipenGoalVerdict` hands one back: three legacy fields plus the receipt. */
function producerVerdict(overrides: Partial<GoalCompletionVerificationOutput> = {}): unknown {
  return GoalCompletionVerificationOutputSchema.parse({
    disposition: GoalCompletionDisposition.Complete,
    evidence: {
      ruleVersion: "zcode.saipen-goal-evidence/1",
      projectIdentity: "protrail",
      goal: { id: "goal-1", objectiveDigest: "d41d8cd98f00b204e9800998ecf8427e" },
      protocolVersion: "8.1.0",
      authority: "saipen_projection",
      projection: {
        phase: "DONE",
        claimedTicket: null,
        topWorkableTicket: null,
        closureComplete: true,
      },
      board: {
        path: ".saipen/BOARD.md",
        hash: "5f70bf18a086007016e948b04cdc3b14368b5bdcf1f4b4e5f2c7a1d0e0b9c8a7",
        revision: "E-42",
        done: 43,
        actionable: 0,
        blocked: 0,
        blockedIds: [],
      },
      log: {
        path: ".saipen/LOG.md",
        hash: "9c1185a5c5e9fc54612808977ee8f548b2258d31be7b4f6d1d4e0f1a2b3c4d5e",
        boundary: "E-42",
      },
      evidenceLocations: [".saipen/BOARD.md", ".saipen/LOG.md"],
      disposition: "complete",
      reason: "board clear: 43 done, nothing actionable",
    },
    passed: true,
    reason: "board clear: 43 done, nothing actionable",
    ...overrides,
  });
}

/** The timeline part exactly as `events.ts` persists it for the verifier event. */
function persistedPart(verification: unknown): Record<string, unknown> {
  return {
    partId: "goal_verify_goal-1_1_timeline",
    sessionId: "s1",
    messageId: "goal_verify_goal-1_1",
    type: "timeline",
    timelineType: "goal_verification",
    display: "separator",
    status: "completed",
    anchorMessageId: "a1",
    targetId: "goal-1",
    verificationId: "verif-1",
    goalIteration: 1,
    verification,
    time: { start: 100, end: 200 },
  };
}

function assistantMessage(parts: unknown[]): Record<string, unknown> {
  return {
    info: {
      messageId: "a1",
      sessionId: "s1",
      role: "assistant",
      time: { created: 100, completed: 200 },
      parentMessageId: "u1",
      agent: "zcode",
      path: { cwd: "C:/work/protrail", root: "C:/work/protrail" },
      cost: 0,
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 0, write: 0 },
        total: 15,
      },
    },
    parts,
  };
}

/** The snapshot envelope `client.request` parses a session/resume response with. */
function snapshot(messages: unknown[]): unknown {
  return {
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId: "s1",
      workspace: WORKSPACE,
      sessionKind: "interactive",
      title: "ProTrail",
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: { model: { available: [] }, thoughtLevel: { enabled: false, available: [] }, mode: { current: "build" } },
    projection: {
      sessionId: "s1",
      status: "idle",
      mode: "build",
      turnCount: 1,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 4, stateRevision: 3, pendingRequestIds: [] },
    messages,
  };
}

test("the CLEAR MAIN hydration gate accepts the persisted verdict that carries its evidence", () => {
  const parsed = zcodeSessionStateSnapshotSchema.parse(
    snapshot([assistantMessage([persistedPart(producerVerdict())])]),
  );
  const part = parsed.messages[0]!.parts[0]!;
  assert.equal(part.type, "timeline");
  if (part.type !== "timeline") return;
  // Evidence is preserved, not merely tolerated: the whole point of the record is
  // that a reader can still check what the verdict read.
  assert.equal(part.verification?.passed, true);
  assert.equal(
    (part.verification as { disposition?: unknown }).disposition,
    GoalCompletionDisposition.Complete,
  );
  assert.deepEqual(
    (part.verification as { evidence?: unknown }).evidence,
    (producerVerdict() as { evidence: unknown }).evidence,
  );
});

test("producer and reader agree: a verdict round-trips back through the producer contract", () => {
  const verdict = producerVerdict();
  const parsed = zcodeMessageWithPartsSchema.parse(assistantMessage([persistedPart(verdict)]));
  const part = parsed.parts[0]!;
  assert.equal(part.type, "timeline");
  if (part.type !== "timeline") return;
  // Reading the record back yields the exact verdict the runtime wrote, so a
  // forensic reader never sees a field the schema stripped.
  assert.deepEqual(
    GoalCompletionVerificationOutputSchema.parse(part.verification),
    verdict,
  );
});

test("a legacy three-field verification record still parses unchanged", () => {
  const parsed = zcodeMessageWithPartsSchema.parse(
    assistantMessage([
      persistedPart({ passed: false, reason: "work left", nextAction: "T-7 ship the thing" }),
    ]),
  );
  const part = parsed.parts[0]!;
  assert.equal(part.type, "timeline");
  if (part.type !== "timeline") return;
  assert.deepEqual(part.verification, {
    passed: false,
    reason: "work left",
    nextAction: "T-7 ship the thing",
  });
});

test("the reader still rejects an unknown key inside the verification object", () => {
  const result = zcodeMessageWithPartsSchema.safeParse(
    assistantMessage([
      persistedPart({ passed: true, reason: "ok", smuggled: "value" }),
    ]),
  );
  assert.equal(result.success, false);
  const issues = result.success ? [] : result.error.issues;
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.code, "unrecognized_keys");
  assert.deepEqual(issues[0]?.keys, ["smuggled"]);
});

test("the reader still rejects an unknown key on the timeline part itself", () => {
  const result = zcodeMessageWithPartsSchema.safeParse(
    assistantMessage([
      { ...persistedPart(producerVerdict()), unexpectedPartField: 1 },
    ]),
  );
  assert.equal(result.success, false);
  const issues = result.success ? [] : result.error.issues;
  assert.equal(issues[0]?.code, "unrecognized_keys");
  assert.deepEqual(issues[0]?.keys, ["unexpectedPartField"]);
});

test("producer and reader declare the same verdict contract", () => {
  // The producer runs on contracts' zod, the persisting reader on shared's, so no
  // shared type keeps them aligned. What keeps them aligned is this: the reader
  // declares exactly the fields the producer declares, so a verdict the runtime
  // can write can never again be a record the CLEAR MAIN path refuses to read.
  assert.deepEqual(declaredKeys(zcodeTimelineVerificationSchema), [
    "disposition",
    "evidence",
    "nextAction",
    "passed",
    "reason",
  ]);
  const evidence = zcodeTimelineVerificationSchema.shape.evidence;
  assert.deepEqual(declaredKeys(evidence), declaredKeys(GoalCompletionEvidenceReceiptSchema));
  assert.deepEqual(
    declaredKeys(GoalCompletionVerificationOutputSchema),
    declaredKeys(zcodeTimelineVerificationSchema),
  );
  // The disposition word list is part of the record: a new disposition that the
  // reader does not know would be persisted and then refused.
  assert.deepEqual((unwrap(zcodeTimelineVerificationSchema.shape.disposition) as { options?: unknown }).options, [
    "complete",
    "blocked_human",
    "blocked_external",
    "continue",
    "invalid_or_unverified",
  ]);
});

test("the evidence receipt keeps its own strict contract", () => {
  const missing = producerVerdict() as { evidence: Record<string, unknown> };
  const { board: _board, ...withoutBoard } = missing.evidence;
  assert.equal(GoalCompletionVerificationOutputSchema.safeParse({
    passed: true,
    reason: "ok",
    evidence: withoutBoard,
  }).success, false, "a receipt without the board it claims to have read cannot validate");
  const junk = { ...missing.evidence, inventedField: 1 };
  assert.equal(GoalCompletionVerificationOutputSchema.safeParse({
    passed: true,
    reason: "ok",
    evidence: junk,
  }).success, false, "an unrecognised key on the receipt stays rejected");
});
