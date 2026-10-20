import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
import {
  planZaicodeClearAllSessions,
  runZaicodeClearAllSessions,
} from "../src/zaicode/zaicodeClearAllSessions.js";
import {
  resetZaicodeCleanupFenceForTest,
} from "../src/zaicode/zaicodeCleanupFence.js";
import {
  recordSessionClick,
  getSessionClickStartedAt,
  clearSessionClick,
} from "../src/lib/sessionOpenArmsTelemetry.js";
import {
  useZaicodePendingCommand,
  useZaicodeFreshSession,
} from "../src/zaicode/zaicodeSaipen.js";
import { useZaicodeActionIntents } from "../src/zaicode/zaicodeActionIntent.js";
import { pendingCommandRegistry } from "../src/v4/pendingCommandRegistry.js";
import { useZaicodeMainSessions, zaicodeMainSessionIdOf } from "../src/zaicode/zaicodeMainSession.js";
import type {
  ConversationTransport,
  CommandEnvelope,
  CommandAck,
} from "@zcode/shared";

function createControllableTransport() {
  const subscribeCalls: Array<{ topic: string; resolve: (val: any) => void; reject: (err: any) => void }> = [];
  const unsubscribeCalls: string[] = [];

  const transport: ConversationTransport = {
    subscribe: async ({ topic }) => {
      return new Promise((resolve, reject) => {
        subscribeCalls.push({ topic, resolve, reject });
      });
    },
    activate: () => {},
    resync: async () => ({} as any),
    unsubscribe: async (subscriptionId) => {
      unsubscribeCalls.push(subscriptionId);
    },
    sendCommand: async (_envelope: CommandEnvelope): Promise<CommandAck> => {
      return { status: "accepted", commandId: _envelope.commandId };
    },
    onFrame: () => () => {},
    attachmentPut: async () => ({ attachmentId: "att-1" }),
    attachmentRead: async () => new Uint8Array(),
    attachmentReadRange: async () => new Uint8Array(),
    fileChanges: async () => ({ changes: [] }),
    fileRewindPreview: async () => ({ patches: [] }),
    workflowRunEvents: async () => ({ events: [], totalCount: 0 }),
    workflowRuns: async () => ({ runs: [] }),
    workflowRunArtifacts: async () => ({ artifacts: [] }),
    workflowRunArtifactData: async () => ({ entries: [] }),
    workflowRunArtifactRead: async () => ({ chunk: new Uint8Array(), eof: true }),
    workflowRunWorkspace: async () => ({ nodes: [] }),
    workflowRunNodeResult: async () => ({ result: "" }),
    onRuntimeRestart: () => () => {},
    onAssemblyFault: () => () => {},
  };

  return { transport, subscribeCalls, unsubscribeCalls };
}

test("RED-01 & RED-02: Strictly bounded in-flight cold prefetch and async settlement slot release", async () => {
  const { transport, subscribeCalls } = createControllableTransport();
  const layer = new SessionDataLayer({ transport, maxWarmCapacity: 5 });

  // 1. Prefetch s1, s2, s3
  layer.prefetch("s1");
  layer.prefetch("s2");
  layer.prefetch("s3");

  // Only s1 should have started cold subscribe since limit is 1 in-flight
  assert.equal(subscribeCalls.length, 1);
  assert.equal(subscribeCalls[0].topic, "conversation/s1");

  // 2. Resolve s1 subscribe
  subscribeCalls[0].resolve({ ack: { subscriptionId: "sub-s1", openTiming: {} } });
  await new Promise((r) => setTimeout(r, 10));

  // Now s2 should start
  assert.equal(subscribeCalls.length, 2);
  assert.equal(subscribeCalls[1].topic, "conversation/s2");

  // 3. Resolve s2 subscribe
  subscribeCalls[1].resolve({ ack: { subscriptionId: "sub-s2", openTiming: {} } });
  await new Promise((r) => setTimeout(r, 10));

  // Now s3 should start
  assert.equal(subscribeCalls.length, 3);
  assert.equal(subscribeCalls[2].topic, "conversation/s3");

  // Resolve s3
  subscribeCalls[2].resolve({ ack: { subscriptionId: "sub-s3", openTiming: {} } });
  await new Promise((r) => setTimeout(r, 10));

  layer.dispose();
});

test("RED-03: Cold prefetch failure does not strand the concurrency slot", async () => {
  const { transport, subscribeCalls } = createControllableTransport();
  const layer = new SessionDataLayer({ transport, maxWarmCapacity: 5 });

  layer.prefetch("fail-1");
  layer.prefetch("next-1");

  assert.equal(subscribeCalls.length, 1);
  assert.equal(subscribeCalls[0].topic, "conversation/fail-1");

  // Reject fail-1
  subscribeCalls[0].reject(new Error("Network drop"));
  await new Promise((r) => setTimeout(r, 10));

  // next-1 must proceed despite fail-1 error
  assert.equal(subscribeCalls.length, 2);
  assert.equal(subscribeCalls[1].topic, "conversation/next-1");

  subscribeCalls[1].resolve({ ack: { subscriptionId: "sub-next-1", openTiming: {} } });
  await new Promise((r) => setTimeout(r, 10));

  layer.dispose();
});

test("RED-04: Zero-ref keep-warm takeover by prefetch maintains bounded lease and eventually closes", async () => {
  const { transport, subscribeCalls, unsubscribeCalls } = createControllableTransport();
  const layer = new SessionDataLayer({ transport, keepWarmMs: 50, maxWarmCapacity: 5 });

  // 1. Acquire normal session and resolve
  const pane = layer.acquire("kw-session");
  assert.equal(subscribeCalls.length, 1);
  subscribeCalls[0].resolve({ ack: { subscriptionId: "sub-kw", openTiming: {} } });
  await new Promise((r) => setTimeout(r, 10));

  // 2. Release it -> enters keep-warm
  pane.release();
  assert.equal(layer.size, 1);

  // 3. Prefetch before keep-warm expires (at 20ms)
  await new Promise((r) => setTimeout(r, 20));
  layer.prefetch("kw-session");

  // 4. Cancel or release prefetch lease
  layer.cancelPrefetch("kw-session");

  // 5. Wait for keepWarmMs (60ms)
  await new Promise((r) => setTimeout(r, 70));

  // Must not remain as an orphan entry!
  assert.equal(layer.size, 0);

  layer.dispose();
});

test("RED-05: Active pane survives LRU eviction while unheld prefetches are evicted", async () => {
  const { transport, subscribeCalls } = createControllableTransport();
  const layer = new SessionDataLayer({ transport, maxWarmCapacity: 2 });

  // Cold prefetch s1
  layer.prefetch("p1");
  subscribeCalls[0].resolve({ ack: { subscriptionId: "sub-p1", openTiming: {} } });
  await new Promise((r) => setTimeout(r, 10));

  // Foreground pane acquires s2
  const pane = layer.acquire("p2");
  subscribeCalls[1].resolve({ ack: { subscriptionId: "sub-p2", openTiming: {} } });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(layer.size, 2);

  // Prefetch s3 -> should evict p1, NOT p2 (because p2 is held by pane)
  layer.prefetch("p3");
  subscribeCalls[2].resolve({ ack: { subscriptionId: "sub-p3", openTiming: {} } });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(layer.size, 2);
  assert.equal(layer.isWarm("p2"), true);
  assert.equal(layer.isWarm("p1"), false);

  pane.release();
  layer.dispose();
});

test("RED-06: Helper timeout removes residue from useZaicodePendingCommand and isolates subsequent intents", async () => {
  useZaicodeFreshSession.getState().reset();
  useZaicodeActionIntents.getState().reset();

  const wsPath = "/test/workspace/helper-timeout";

  // 1. Create helper intent SAIWIKI
  const intentWiki = useZaicodeActionIntents.getState().createIntent({
    workspacePath: wsPath,
    destination: "helper",
    action: { command: "wiki", role: "WIKI" },
    command: "saipen sub saiwiki",
  });

  useZaicodeFreshSession.getState().open(
    wsPath,
    undefined,
    "saipen sub saiwiki",
    { command: "wiki", role: "WIKI" },
    null,
    intentWiki.id,
  );

  assert.equal(useZaicodeFreshSession.getState().currentId, 1);
  assert.equal(useZaicodePendingCommand.getState().peek(wsPath)?.command, "saipen sub saiwiki");

  // 2. Queue SAIHUNT before timeout
  const intentHunt = useZaicodeActionIntents.getState().createIntent({
    workspacePath: wsPath,
    destination: "helper",
    action: { command: "hunt", role: "HUNT" },
    command: "saipen sub saihunt",
  });

  useZaicodeFreshSession.getState().open(
    wsPath,
    undefined,
    "saipen sub saihunt",
    { command: "hunt", role: "HUNT" },
    null,
    intentHunt.id,
  );

  // 3. Trigger timeout on current fresh session (SAIWIKI)
  useZaicodeFreshSession.getState().advance();

  // SAIWIKI intent must be rejected
  const wikiAfter = useZaicodeActionIntents.getState().intents[intentWiki.id];
  assert.equal(wikiAfter.state, "REJECTED");

  // Next session (SAIHUNT) should be current
  assert.equal(useZaicodeFreshSession.getState().currentId, 2);

  // CRITICAL: The pending command for SAIWIKI must NOT be handed out to SAIHUNT!
  const huntCommand = useZaicodePendingCommand.getState().peek(wsPath);
  assert.notEqual(huntCommand?.command, "saipen sub saiwiki");
  assert.equal(huntCommand?.command, "saipen sub saihunt");
});

test("RED-07: Clean slate correctness: already_running is not counted as cancelledCommands", async () => {
  resetZaicodeCleanupFenceForTest();

  pendingCommandRegistry.record({
    protocolVersion: 1,
    commandId: "cmd-running-1",
    sessionId: "sess-running",
    clientId: "desktop-continuous",
    issuedAt: Date.now(),
    type: "sendText",
    payload: { text: "Running Task" },
  } as any);
  assert.equal(pendingCommandRegistry.list("sess-running").length, 1);

  const plan = planZaicodeClearAllSessions([
    {
      sessionId: "sess-running",
      projectKey: "proj-1",
      workspacePath: "/ws1",
      title: "Running Task",
      running: true,
      waiting: false,
      failed: false,
      manuallyStopped: false,
      interrupted: false,
      crashCut: false,
      done: false,
      foregroundExecutionId: "run-1",
    },
  ]);

  const run = await runZaicodeClearAllSessions({
    plan,
    resolveHandle: () => ({
      stop: async () => {},
      continueSession: async () => ({ outcome: "CONTINUED" as const }),
    }),
    taskService: {
      cancelTaskCommand: async () => {
        // Host returns already_running
        return { canceled: false, reason: "already_running" };
      },
      deleteTasks: async () => {
        return { deletedTaskIds: ["sess-running"], skippedTaskIds: [], failedTaskIds: [] };
      },
    },
  });

  // Authoritative: canceled is FALSE, so cancelledCommands must be 0!
  assert.equal(run.cancelledCommands, 0);
  assert.ok(run.problems.some((p) => p.includes("already_running") || p.includes("already running")));
});

test("RED-08: Clean slate does not clear MAIN pointer when session deletion fails", async () => {
  resetZaicodeCleanupFenceForTest();
  useZaicodeMainSessions.getState().setMain("proj-fail", "sess-main-fail");
  assert.equal(zaicodeMainSessionIdOf(useZaicodeMainSessions.getState().byWorkspace, "proj-fail"), "sess-main-fail");

  const plan = planZaicodeClearAllSessions([
    {
      sessionId: "sess-main-fail",
      projectKey: "proj-fail",
      workspacePath: "/ws-fail",
      title: "Failing Main Task",
      running: false,
      waiting: false,
      failed: false,
      manuallyStopped: false,
      interrupted: false,
      crashCut: false,
      done: true,
    },
  ]);

  await runZaicodeClearAllSessions({
    plan,
    taskService: {
      deleteTasks: async () => {
        // Deletion fails!
        return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: ["sess-main-fail"] };
      },
    },
  });

  // MAIN session must NOT be wiped when deletion failed!
  assert.equal(zaicodeMainSessionIdOf(useZaicodeMainSessions.getState().byWorkspace, "proj-fail"), "sess-main-fail");
});

test("RED-09: Telemetry click registry bounds and prunes timestamps", () => {
  recordSessionClick("sess-click-1");
  const t1 = getSessionClickStartedAt("sess-click-1");
  assert.ok(typeof t1 === "number" && t1 > 0);

  clearSessionClick("sess-click-1");
  assert.equal(getSessionClickStartedAt("sess-click-1"), undefined);
});
