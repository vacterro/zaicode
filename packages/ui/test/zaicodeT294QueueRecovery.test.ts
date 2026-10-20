// T-294 (SRC-207): a Queue-driven conversation subscription failure must end in a
// truthful, bounded terminal state with the last-good transcript preserved -- not in
// an unbounded reconnect ladder that never reports anything.
//
// The store is the real ConversationProjectionStore; only the transport is scripted, so
// every assertion is about observable store state reached through the store's own code
// paths (connect / handleFrame / resync ACK / reconnect fallback).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  conversationTopic,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationProjectionStore } from "../src/v4/conversationProjectionStore.js";
import {
  hasTrustworthyConversationProjection,
  resolveConversationSubscriptionSurface,
  SessionSubscriptionErrorPanel,
} from "../src/v4/SessionSubscriptionErrorPanel.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import type { ConversationTransport } from "../src/v4/transport.js";

const RECOVERY_FAILED = "fault.subscription.recoveryFailed";

interface Frame {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  payload: { kind: "snapshot"; snapshot: ConversationSnapshot } | { kind: "deltas"; deltas: unknown[] };
}

const row = (rowId: number): ConversationRow =>
  ({
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    text: `row-${rowId}`,
    entityId: `e-${rowId}`,
    createdAtSeq: rowId,
    status: "completed",
  }) as ConversationRow;

function snapshotAt(sessionId: string, seq: number, rowIds: number[]): ConversationSnapshot {
  return {
    sessionId,
    seq,
    revision: 1,
    logEpoch: "epoch",
    rows: {
      window: rowIds.map((id) => row(id)),
      firstRowId: rowIds[0] ?? 1,
      totalCount: rowIds.length,
    },
    pendingCommands: [],
    queue: { items: [], autoDrain: true },
    backgroundWorks: [],
  } as unknown as ConversationSnapshot;
}

function snapshotFrame(topic: string, subscriptionId: string, snapshot: ConversationSnapshot): Frame {
  return {
    topic,
    subscriptionId,
    fromSeq: 0,
    toSeq: snapshot.seq,
    payload: { kind: "snapshot", snapshot },
  };
}

/** A recovery frame whose window does not continue the local watermark. */
function gapFrame(topic: string, subscriptionId: string, fromSeq: number, toSeq: number): Frame {
  return {
    topic,
    subscriptionId,
    fromSeq,
    toSeq,
    payload: { kind: "deltas", deltas: [{ op: "row.appended", row: row(toSeq) }] },
  };
}

class ScriptedConversationTransport {
  subscribeCount = 0;
  resyncCount = 0;
  sendCommandCount = 0;
  queryCommandsCount = 0;
  unsubscribeCount = 0;
  readonly resyncRequests: Array<{ subscriptionId: string; forceSnapshot: boolean }> = [];
  /** ACK mode the scripted server returns for every resync. */
  resyncMode: "snapshot" | "resume" = "snapshot";
  autoResync = true;

  private subSeq = 0;
  private readonly pendingResync: Array<() => void> = [];
  private readonly faultListeners = new Set<
    (fault: { topic: string; subscriptionId: string; deliveryKind?: string }) => void
  >();
  private readonly restartListeners = new Set<(reason?: string) => void>();

  readonly transport = {
    onFrame: () => () => {},
    onAssemblyFault: (listener: (fault: { topic: string; subscriptionId: string; deliveryKind?: string }) => void) => {
      this.faultListeners.add(listener);
      return () => this.faultListeners.delete(listener);
    },
    onRuntimeRestart: (listener: (reason?: string) => void) => {
      this.restartListeners.add(listener);
      return () => this.restartListeners.delete(listener);
    },
    subscribe: () => {
      this.subscribeCount += 1;
      const subscriptionId = `sub-${(this.subSeq += 1)}`;
      return Promise.resolve({
        ack: { subscriptionId, mode: "snapshot", logEpoch: "epoch" },
      }) as never;
    },
    activate: () => {},
    resync: (params: { subscriptionId: string; forceSnapshot?: boolean }) => {
      this.resyncCount += 1;
      this.resyncRequests.push({
        subscriptionId: params.subscriptionId,
        forceSnapshot: params.forceSnapshot === true,
      });
      const result = {
        ack: { subscriptionId: params.subscriptionId, mode: this.resyncMode, logEpoch: "epoch" },
      };
      return new Promise((resolve) => {
        const settle = () => resolve(result as never);
        if (this.autoResync) settle();
        else this.pendingResync.push(settle);
      }) as never;
    },
    unsubscribe: () => {
      this.unsubscribeCount += 1;
      return Promise.resolve();
    },
    sendCommand: () => {
      this.sendCommandCount += 1;
      return Promise.reject(new Error("sendCommand is not scripted"));
    },
    queryCommands: () => {
      this.queryCommandsCount += 1;
      return Promise.reject(new Error("queryCommands is not scripted"));
    },
  } as unknown as ConversationTransport;

  resolveNextResync(): void {
    const settle = this.pendingResync.shift();
    assert.ok(settle, "no resync was pending");
    settle();
  }

  emitAssemblyFault(subscriptionId: string, deliveryKind?: string): void {
    for (const listener of this.faultListeners) {
      listener({ topic: this.topic, subscriptionId, ...(deliveryKind ? { deliveryKind } : {}) });
    }
  }

  emitRuntimeRestart(reason?: string): void {
    for (const listener of this.restartListeners) listener(reason);
  }

  constructor(readonly topic: string) {}
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fixture(sessionId = "t294") {
  const topic = conversationTopic(sessionId);
  const scripted = new ScriptedConversationTransport(topic);
  const store = new ConversationProjectionStore(topic, scripted.transport);
  return { topic, sessionId, scripted, store };
}

async function connectWithInitial(
  f: ReturnType<typeof fixture>,
  seq = 10,
): Promise<string> {
  await f.store.connect();
  const subscriptionId = f.store.getState().subscriptionId;
  assert.ok(subscriptionId, "connect must record its subscriptionId");
  f.store.handleFrame(
    snapshotFrame(f.topic, subscriptionId, snapshotAt(f.sessionId, seq, [1, 2, 3])) as never,
    { deliveryKind: "initial" },
  );
  return subscriptionId;
}

/**
 * One complete ACK-success/frame-failure recovery episode:
 * same-sub resync ACKs, its frame never continues the watermark, so the store falls back
 * to a fresh forced-snapshot subscribe whose ACK also succeeds -- and whose frame never
 * arrives either.
 */
async function failedRecoveryEpisode(f: ReturnType<typeof fixture>): Promise<void> {
  const before = f.store.getState().subscriptionId;
  assert.ok(before);
  f.store.recoverFromStaleAuthority();
  await tick();
  assert.equal(f.store.getState().subscriptionId, before, "recovery must stay on the same subscription");
  f.store.handleFrame(gapFrame(f.topic, before, 999, 1000) as never, { deliveryKind: "recovery" });
  await tick();
}

test("T-294 A: three ACK-success/frame-failure episodes exhaust one bounded budget -- an ACK is not a healthy recovery", async () => {
  const f = fixture();
  await connectWithInitial(f);
  for (let episode = 0; episode < 4; episode += 1) await failedRecoveryEpisode(f);

  const state = f.store.getState();
  assert.equal(
    f.scripted.subscribeCount,
    4,
    "one initial subscribe plus exactly three bounded recovery reconnects",
  );
  assert.equal(state.status, "error", "the exhausted budget must be observable, not silent");
  assert.equal(state.lastError, RECOVERY_FAILED);
  await f.store.close();
});

test("T-294 B: a terminal recovery failure is one stable transition that keeps the last-good projection", async () => {
  const f = fixture();
  await connectWithInitial(f);
  for (let episode = 0; episode < 4; episode += 1) await failedRecoveryEpisode(f);

  const terminal = f.store.getState();
  assert.equal(terminal.status, "error");
  assert.equal(terminal.lastError, RECOVERY_FAILED);
  assert.equal(terminal.snapshot?.seq, 10, "the last-good projection is preserved, not dropped");
  assert.equal(terminal.snapshot?.rows.window.length, 3);
  assert.equal(f.scripted.subscribeCount, 4);

  // Stable: further automatic faults neither reconnect nor change the reported reason.
  await failedRecoveryEpisode(f);
  f.scripted.emitAssemblyFault(f.store.getState().subscriptionId!, "recovery");
  await tick();
  const again = f.store.getState();
  assert.equal(again.status, "error");
  assert.equal(again.lastError, RECOVERY_FAILED);
  assert.equal(f.scripted.subscribeCount, 4, "a fourth failure must not buy another reconnect");

  // The store never resends a command just because its projection was lost.
  assert.equal(f.scripted.sendCommandCount, 0);
  assert.equal(f.scripted.queryCommandsCount, 0);

  await f.store.close();
});

test("T-294 C: a recovery frame with a sequence gap escalates without touching the projection", async () => {
  const f = fixture();
  const subscriptionId = await connectWithInitial(f);
  f.store.recoverFromStaleAuthority();
  await tick();
  f.store.handleFrame(gapFrame(f.topic, subscriptionId, 999, 1000) as never, {
    deliveryKind: "recovery",
  });
  await tick();
  const state = f.store.getState();
  assert.equal(state.snapshot?.seq, 10, "a gap is never guessed into the projection");
  assert.equal(state.snapshot?.rows.window.length, 3);
  await f.store.close();
});

test("T-294 D: a recovery frame arriving before the resync ACK continuation is not lost", async () => {
  const f = fixture();
  const subscriptionId = await connectWithInitial(f);
  f.scripted.autoResync = false;
  f.scripted.resyncMode = "resume";
  f.store.recoverFromStaleAuthority();
  await tick();
  assert.equal(f.scripted.resyncCount, 1);
  // The gap is observed while the resync request is still in flight.
  f.store.handleFrame(gapFrame(f.topic, subscriptionId, 999, 1000) as never, {
    deliveryKind: "recovery",
  });
  f.scripted.resolveNextResync();
  await tick();
  assert.equal(
    f.scripted.resyncCount,
    2,
    "a resume ACK after an observed gap must upgrade to a forced snapshot",
  );
  assert.equal(f.scripted.resyncRequests[1]?.forceSnapshot, true);
  await f.store.close();
});

test("T-294 E: a late frame from a replaced subscription is ignored", async () => {
  const f = fixture();
  const stale = await connectWithInitial(f);
  await failedRecoveryEpisode(f);
  const current = f.store.getState().subscriptionId;
  assert.ok(current && current !== stale, "the fallback must have replaced the subscription");
  f.store.handleFrame(snapshotFrame(f.topic, stale, snapshotAt(f.sessionId, 500, [1, 2, 3, 4])) as never, {
    deliveryKind: "online",
  });
  assert.equal(f.store.getState().snapshot?.seq, 10, "a stale generation cannot move the projection");
  await f.store.close();
});

test("T-294 I: a Queue mutation during an active recovery is preserved and never replayed", async () => {
  const f = fixture();
  const subscriptionId = await connectWithInitial(f);
  f.scripted.autoResync = false;
  f.store.markCommandPending({ commandId: "cmd-queue-1", type: "sendText", issuedAt: 1 });
  f.store.expectAcceptedInputProjection("cmd-queue-1");
  f.store.recoverFromStaleAuthority();
  await tick();
  f.store.handleFrame(gapFrame(f.topic, subscriptionId, 999, 1000) as never, {
    deliveryKind: "recovery",
  });
  f.scripted.resolveNextResync();
  await tick();
  assert.deepEqual(
    f.store.getState().optimisticCommands.map((command) => command.commandId),
    ["cmd-queue-1"],
    "the pending Queue fact survives recovery untouched",
  );
  assert.equal(f.scripted.sendCommandCount, 0, "recovery never resends the command");

  // The authoritative projection for that command settles the overlay (no fabrication).
  f.store.handleFrame(
    snapshotFrame(f.topic, f.store.getState().subscriptionId!, {
      ...snapshotAt(f.sessionId, 1000, [1, 2, 3]),
      queue: {
        items: [{ sourceCommandId: "cmd-queue-1" } as never],
        autoDrain: true,
      },
    } as ConversationSnapshot) as never,
    { deliveryKind: "recovery" },
  );
  assert.deepEqual(f.store.getState().optimisticCommands, [], "an authoritative projection settles it");
  await f.store.close();
});

test("T-294 K: a manual reconnect after a terminal failure returns to live", async () => {
  const f = fixture();
  await connectWithInitial(f);
  for (let episode = 0; episode < 4; episode += 1) await failedRecoveryEpisode(f);
  assert.equal(f.store.getState().status, "error");

  await f.store.retry();
  const subscriptionId = f.store.getState().subscriptionId;
  assert.ok(subscriptionId);
  assert.equal(f.store.getState().status, "live");
  f.store.handleFrame(
    snapshotFrame(f.topic, subscriptionId, snapshotAt(f.sessionId, 20, [1, 2, 3])) as never,
    { deliveryKind: "initial" },
  );
  assert.equal(f.store.getState().status, "live");
  assert.equal(f.store.getState().snapshot?.seq, 20);
  assert.equal(f.store.getState().lastError, null);
  // H: a successful reconnect restores live behaviour without replaying Queue work.
  assert.equal(f.scripted.sendCommandCount, 0, "reconnect must not resend the lost Queue command");
  assert.equal(f.scripted.queryCommandsCount, 0);
  assert.equal(f.scripted.subscribeCount, 5, "one initial + three recovery + the manual retry");

  // ...and the recovered subscription keeps working: a real Queue delta is applied.
  f.store.handleFrame(
    {
      topic: f.topic,
      subscriptionId,
      fromSeq: 20,
      toSeq: 21,
      payload: {
        kind: "deltas",
        deltas: [{ op: "state.updated", patch: { queue: { items: [], autoDrain: false } } }],
      },
    } as never,
    { deliveryKind: "online" },
  );
  assert.equal(f.store.getState().status, "live");
  assert.equal(f.store.getState().snapshot?.seq, 21, "the live subscription still advances");
  await f.store.close();
});

test("T-294 L: a permanently invalid projection cannot be hidden by a larger budget", async () => {
  const f = fixture();
  await connectWithInitial(f);
  for (let episode = 0; episode < 12; episode += 1) await failedRecoveryEpisode(f);
  assert.equal(
    f.scripted.subscribeCount,
    4,
    "the budget is fixed: twelve failures buy exactly three reconnects",
  );
  assert.equal(f.store.getState().status, "error");
  assert.equal(f.store.getState().lastError, RECOVERY_FAILED);
  await f.store.close();
});

test("T-294 J: a runtime restart overlapping an in-flight recovery reconnects once and keeps the Queue fact", async () => {
  const f = fixture();
  await connectWithInitial(f);
  f.scripted.autoResync = false;
  f.store.markCommandPending({ commandId: "cmd-queue-restart", type: "sendText", issuedAt: 1 });
  f.store.expectAcceptedInputProjection("cmd-queue-restart");
  f.store.recoverFromStaleAuthority();
  await tick();
  assert.equal(f.scripted.resyncCount, 1, "the recovery is in flight");

  // The runtime is replaced while its resync is still unanswered: the dead recovery
  // generation must be discarded, never completed against the new subscription.
  f.scripted.emitRuntimeRestart("runtimeRestart");
  await tick();
  const state = f.store.getState();
  assert.equal(f.scripted.subscribeCount, 2, "one restart buys exactly one fresh subscribe");
  assert.ok(state.subscriptionId, "the restart reconnected");
  assert.equal(state.snapshot?.seq, 10, "the last-good projection survives the restart");
  assert.deepEqual(
    state.optimisticCommands.map((command) => command.commandId),
    ["cmd-queue-restart"],
    "the pending Queue fact is not lost to a provider-side restart",
  );
  assert.equal(f.scripted.sendCommandCount, 0, "a restart never replays the lost command");

  // The late resync acknowledgement of the dead generation must not resurrect it.
  f.scripted.resolveNextResync();
  await tick();
  assert.equal(f.store.getState().subscriptionId, state.subscriptionId);
  assert.equal(f.store.getState().status, "live");

  // The fresh forced snapshot converges the pane on real authority.
  f.store.handleFrame(
    snapshotFrame(f.topic, state.subscriptionId!, snapshotAt(f.sessionId, 11, [1, 2, 3])) as never,
    { deliveryKind: "initial" },
  );
  assert.equal(f.store.getState().status, "live");
  assert.equal(f.store.getState().snapshot?.seq, 11);
  await f.store.close();
});

test("T-294 C1: a subscription failure with a valid old snapshot keeps the transcript on screen", async () => {
  const f = fixture();
  await connectWithInitial(f);
  for (let episode = 0; episode < 4; episode += 1) await failedRecoveryEpisode(f);

  const state = f.store.getState();
  assert.equal(state.status, "error");
  assert.equal(
    hasTrustworthyConversationProjection(state.snapshot),
    true,
    "an applied projection stays usable history after the subscription dies",
  );
  assert.equal(
    resolveConversationSubscriptionSurface({ status: state.status, snapshot: state.snapshot }),
    "fault-banner",
    "the pane must keep the timeline and add a disconnected banner, not blank the screen",
  );
  await f.store.close();
});

test("T-294 C2: no trustworthy projection keeps the explicit whole-screen error state", () => {
  assert.equal(
    resolveConversationSubscriptionSurface({ status: "error", snapshot: null }),
    "fault-panel",
  );
  assert.equal(
    resolveConversationSubscriptionSurface({
      status: "error",
      snapshot: snapshotAt("t294", 0, []),
    }),
    "fault-panel",
    "an empty projection has nothing to preserve, so the error state stays explicit",
  );
  assert.equal(
    resolveConversationSubscriptionSurface({ status: "live", snapshot: snapshotAt("t294", 5, [1]) }),
    "live",
  );
  assert.equal(
    resolveConversationSubscriptionSurface({ status: "connecting", snapshot: null }),
    "live",
    "a first connect is not a fault surface",
  );
});

test("T-294 C3: the disconnected banner states the reason, marks the view read-only and offers reconnect", () => {
  const html = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(SessionSubscriptionErrorPanel, {
        variant: "banner",
        error: RECOVERY_FAILED,
        sessionId: "t294",
        workspacePath: "V:/tmp",
        onReconnect: () => {},
      }),
    }),
  );
  assert.ok(html.includes("v4-subscription-fault-banner"));
  assert.ok(html.includes(RECOVERY_FAILED), "the exact reason is visible");
  assert.ok(html.includes("Read-only"), "stale content is marked, never sold as live truth");
  assert.ok(html.includes('data-testid="v4-retry-subscribe"'), "a reconnect action is offered");

  const panel = renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "en-US",
      children: createElement(SessionSubscriptionErrorPanel, {
        error: RECOVERY_FAILED,
        sessionId: "t294",
        workspacePath: "V:/tmp",
        onReconnect: () => {},
      }),
    }),
  );
  assert.ok(!panel.includes("v4-subscription-fault-banner"));
  assert.ok(panel.includes(RECOVERY_FAILED));
});
