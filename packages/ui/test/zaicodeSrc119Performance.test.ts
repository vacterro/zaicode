import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  conversationTopic,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationProjectionStore,
  hasOlderRows,
  shouldAutoLoadIncompleteLeadingTurn,
} from "../src/v4/conversationProjectionStore.js";
import { ZAICODE_LIVE_CONVERSATION_ROWS } from "../src/v4/conversationRetention.js";
import type { ConversationTransport } from "../src/v4/transport.js";
import { buildConversationTurnWorkSegments } from "../src/v4/conversationTurnWorkSegments.js";

const mode = process.env.ZCODE_ZAICODE_MODE;
afterEach(() => {
  if (mode === undefined) delete process.env.ZCODE_ZAICODE_MODE;
  else process.env.ZCODE_ZAICODE_MODE = mode;
});
const row = (rowId: number): ConversationRow =>
  ({
    kind: "assistantText",
    rowId,
    turnId: "long-turn",
    text: `row-${rowId}`,
    entityId: `e-${rowId}`,
    createdAtSeq: rowId,
    status: "completed",
  }) as ConversationRow;

test("only an active elapsed label gets a clock; reordered guided facts and completed history keep their timestamps", () => {
  const rows = [
    { kind: "userInput", rowId: 1, turnId: "t", entityId: "main", text: "go" },
    { ...row(2), turnId: "t" },
    { kind: "userInput", rowId: 3, turnId: "t", entityId: "guide", guided: true, text: "next" },
    { ...row(4), turnId: "t" },
  ] as ConversationRow[];
  const header = {
    kind: "turnHeader", rowId: 0, turnId: "t", startedAt: 0, executionKind: "agent",
    workSegments: [{ triggerEntityId: "guide", startedAt: 400 }, { triggerEntityId: "main", startedAt: 0, endedAt: 300 }],
  };
  const segments = buildConversationTurnWorkSegments({
    key: "t", header: header as never, orderedRows: rows, assistantTailRows: [],
    isRunning: true, isLastTurn: true, isInterrupted: false, forceOpenHistory: false, timelineOnly: false, nowMs: 1000,
  });
  assert.equal(segments[0]?.workStatus?.clockStartedAt, undefined);
  assert.equal(segments[1]?.workStatus?.clockStartedAt, 400);
  header.workSegments[0] = { triggerEntityId: "guide", startedAt: 400, endedAt: 900 };
  const finished = buildConversationTurnWorkSegments({
    key: "t", header: header as never, orderedRows: rows, assistantTailRows: [],
    isRunning: false, isLastTurn: true, isInterrupted: false, forceOpenHistory: false, timelineOnly: false, nowMs: 20_000,
  });
  assert.equal(finished[1]?.workStatus?.durationMs, 500);
  assert.equal(finished[1]?.workStatus?.clockStartedAt, undefined);
});

async function fixture() {
  process.env.ZCODE_ZAICODE_MODE = "1";
  const topic = conversationTopic("stress");
  let reads = 0;
  let unsubscribed = 0;
  const transport = {
    onAssemblyFault: () => () => {},
    onRuntimeRestart: () => () => {},
    subscribe: async () => ({
      ack: { subscriptionId: "sub", mode: "snapshot", logEpoch: "epoch" },
    }),
    activate: () => {},
    unsubscribe: async () => {
      unsubscribed += 1;
    },
    rowsRange: async ({ beforeRowId, limit }: { beforeRowId: number; limit: number }) => {
      reads += 1;
      return {
        atLogEpoch: "epoch",
        rows: Array.from({ length: Math.min(limit, beforeRowId - 1) }, (_, i) =>
          row(Math.max(1, beforeRowId - limit) + i),
        ),
      };
    },
  } as unknown as ConversationTransport;
  const store = new ConversationProjectionStore(topic, transport);
  await store.connect();
  const snapshot = {
    sessionId: "stress",
    seq: 1000,
    revision: 1,
    logEpoch: "epoch",
    rows: {
      window: Array.from({ length: 60 }, (_, i) => row(941 + i)),
      firstRowId: 1,
      totalCount: 1000,
    },
    pendingCommands: [],
    queue: { items: [] },
    backgroundWorks: [],
  } as unknown as ConversationSnapshot;
  store.handleFrame(
    {
      topic,
      subscriptionId: "sub",
      fromSeq: 0,
      toSeq: 1000,
      payload: { kind: "snapshot", snapshot },
    } as never,
    { deliveryKind: "initial" },
  );
  const append = (seq: number) =>
    store.handleFrame({
      topic,
      subscriptionId: "sub",
      fromSeq: seq - 1,
      toSeq: seq,
      payload: { kind: "deltas", deltas: [{ op: "row.appended", row: row(seq) }] },
    } as never);
  return { store, append, reads: () => reads, unsubscribed: () => unsubscribed };
}

test("a 100,000-row autonomous turn retains a bounded live tail and the correct log watermarks", async () => {
  const f = await fixture();
  try {
    for (let seq = 1001; seq <= 100_000; seq += 1) f.append(seq);
    const snapshot = f.store.getState().snapshot!;
    assert.equal(snapshot.seq, 100_000);
    assert.equal(snapshot.rows.totalCount, 100_000);
    assert.equal(snapshot.rows.window.length, ZAICODE_LIVE_CONVERSATION_ROWS);
    assert.equal(snapshot.rows.window[0]?.rowId, 100_000 - ZAICODE_LIVE_CONVERSATION_ROWS + 1);
    assert.equal(snapshot.rows.window.at(-1)?.rowId, 100_000);
    assert.equal(hasOlderRows(snapshot), true, "saved history remains pageable");
    assert.equal(f.reads(), 0, "incoming work never pulls historical pages");
    assert.equal(shouldAutoLoadIncompleteLeadingTurn(snapshot, false), false);
  } finally {
    await f.store.close();
  }
  assert.equal(f.store.getState().snapshot, null, "released projections retain no row payloads");
  assert.equal(f.unsubscribed(), 1);
});

test("automatic leading-turn hydration stops after a few pages instead of reading the entire turn", async () => {
  const f = await fixture();
  try {
    while (shouldAutoLoadIncompleteLeadingTurn(f.store.getState().snapshot, false))
      await f.store.loadOlder(undefined, true);
    assert.equal(f.reads(), 3);
    assert.equal(f.store.getState().snapshot?.rows.window.length, 240);
    assert.equal(hasOlderRows(f.store.getState().snapshot), true);
  } finally {
    await f.store.close();
  }
});

test("explicit history reading survives incoming rows and returning to latest releases it", async () => {
  const f = await fixture();
  try {
    await f.store.loadOlder(200);
    for (let seq = 1001; seq <= 1800; seq += 1) f.append(seq);
    assert.equal(
      f.store.getState().snapshot?.rows.window[0]?.rowId,
      741,
      "reading position is not discarded",
    );
    assert.ok(f.store.getState().snapshot!.rows.window.length > ZAICODE_LIVE_CONVERSATION_ROWS);
    f.store.releaseHistory();
    assert.equal(f.store.getState().snapshot?.rows.window.length, ZAICODE_LIVE_CONVERSATION_ROWS);
    assert.equal(f.store.getState().snapshot?.rows.totalCount, 1800);
    await f.store.loadOlder(200);
    assert.equal(
      f.store.getState().snapshot?.rows.window.length,
      ZAICODE_LIVE_CONVERSATION_ROWS + 200,
      "released rows can be retrieved again",
    );
  } finally {
    await f.store.close();
  }
});
