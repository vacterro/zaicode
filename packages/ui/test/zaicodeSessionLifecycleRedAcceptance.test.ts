import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planZaicodeClearAllSessions,
  collectAuthoritativeClearAllSessionsPlan,
  runZaicodeClearAllSessions,
  type ZaicodeClearAllSessionsPlan,
} from "../src/zaicode/zaicodeClearAllSessions.js";
import {
  type ZaicodeSessionBrief,
  useZaicodeSessionBriefs,
} from "../src/zaicode/zaicodeContinue.js";
import { useZaicodeMainSessions } from "../src/zaicode/zaicodeMainSession.js";
import {
  useZaicodeFreshSession,
  useZaicodePendingCommand,
} from "../src/zaicode/zaicodeSaipen.js";
import { useZaicodeActionIntents } from "../src/zaicode/zaicodeActionIntent.js";
import {
  acquireWorkspaceConnection,
  invalidateSessionAcrossWorkspaceConnections,
  clearWarmPoolAcrossWorkspaceConnections,
} from "../src/v4/workspaceConnectionRegistry.js";
import { SessionDataLayer } from "../src/v4/sessionDataLayer.js";
import { adaptivePrefetchCoordinator } from "../src/v4/adaptivePrefetchCoordinator.js";
import { isSessionRetired, retireSessions } from "../src/zaicode/zaicodeCleanupFence.js";
import type {
  ConversationTransport,
  ConversationFrame,
  TransportFrameContext,
  CommandEnvelope,
  CommandAck,
} from "@zcode/shared";

function makeBrief(partial: Partial<ZaicodeSessionBrief> & { sessionId: string; projectKey: string }): ZaicodeSessionBrief {
  return {
    sessionId: partial.sessionId,
    title: partial.title ?? partial.sessionId,
    projectKey: partial.projectKey,
    workspacePath: partial.workspacePath ?? "V:/code/proj",
    workspaceIdentity: partial.workspaceIdentity,
    running: partial.running ?? false,
    waiting: partial.waiting ?? false,
    failed: partial.failed ?? false,
    interrupted: partial.interrupted ?? false,
    manuallyStopped: partial.manuallyStopped ?? false,
    crashCut: partial.crashCut ?? false,
    updatedAt: partial.updatedAt ?? Date.now(),
    model: partial.model ?? "gpt-4o",
    unreadAt: partial.unreadAt ?? null,
    goalStatus: partial.goalStatus ?? null,
    goalObjective: partial.goalObjective ?? null,
  };
}

function createMockTransport(failOnTopic?: string): ConversationTransport {
  const listeners = new Set<(frame: ConversationFrame, context: TransportFrameContext) => void>();
  return {
    subscribe: async ({ topic }) => {
      if (failOnTopic && topic.includes(failOnTopic)) {
        throw new Error(`Simulated subscription failure on ${topic}`);
      }
      return { ack: { subscriptionId: `sub-${topic}`, openTiming: {} } } as any;
    },
    activate: () => {},
    resync: async () => ({} as any),
    unsubscribe: async () => {},
    sendCommand: async (_envelope: CommandEnvelope): Promise<CommandAck> => {
      return { status: "accepted", commandId: _envelope.commandId };
    },
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
}

// =========================================================================
// 1. AUTHORITATIVE CLEAN SLATE INVENTORY
// =========================================================================
test("RED-1: Authoritative Clean Slate discovers all host sessions even when only a subset is in sidebar briefs", async () => {
  // Host inventory has 5 sessions:
  // s1 (main), s2 (helper), s3 (unmounted/hidden), s4 (archived), s5 (collapsed)
  const hostActiveMetas = [
    { taskId: "s1-main", title: "Main Session", status: "running" as const },
    { taskId: "s2-helper", title: "Helper Session", status: "completed" as const },
    { taskId: "s3-unmounted", title: "Unmounted Session", status: "completed" as const },
    { taskId: "s5-collapsed", title: "Collapsed Session", status: "error" as const },
  ];
  const hostArchivedMetas = [
    { taskId: "s4-archived", title: "Archived Session", status: "completed" as const },
  ];

  // Sidebar UI briefs only has 2 visible rows: s1 and s2
  const sidebarBriefs: ZaicodeSessionBrief[] = [
    makeBrief({ sessionId: "s1-main", projectKey: "proj-1", running: true }),
    makeBrief({ sessionId: "s2-helper", projectKey: "proj-1" }),
  ];

  const plan = await collectAuthoritativeClearAllSessionsPlan({
    workspaces: [{ workspacePath: "V:/code/proj-1", projectKey: "proj-1" }],
    taskService: {
      listTasks: async () => hostActiveMetas as any,
      listArchivedTasks: async () => hostArchivedMetas as any,
    },
    fallbackSessions: sidebarBriefs,
  });

  // Verify all 5 are discovered authoritatively
  assert.equal(plan.totalCount, 5);
  const sessionIds = plan.sessions.map((s) => s.sessionId).sort();
  assert.deepEqual(sessionIds, ["s1-main", "s2-helper", "s3-unmounted", "s4-archived", "s5-collapsed"]);
  assert.equal(plan.runningCount, 1);
  assert.equal(plan.failedCount, 1);
});

// =========================================================================
// 2. CLEANUP SERVICE AVAILABILITY
// =========================================================================
test("RED-2: Cleanup without available delete service preserves MAIN pointer, reports failure, cleared = 0", async () => {
  useZaicodeMainSessions.getState().setMain("P-TEST-AVAIL", "main-to-preserve");
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["P-TEST-AVAIL"], "main-to-preserve");

  const plan = planZaicodeClearAllSessions([
    makeBrief({ sessionId: "main-to-preserve", projectKey: "P-TEST-AVAIL", workspacePath: "V:/code/p-avail" }),
  ]);

  // Execute with taskService undefined (deletion capability unavailable)
  const result = await runZaicodeClearAllSessions({
    plan,
    taskService: undefined,
  });

  assert.equal(result.cleared, 0);
  assert.ok(result.failedOrUnreachable.includes("main-to-preserve"));
  assert.ok(result.problems.some((p) => p.includes("Deletion capability unavailable")));
  assert.ok(result.problems.some((p) => p.includes("MAIN session pointer preserved for P-TEST-AVAIL")));

  // Verify MAIN pointer was strictly preserved
  assert.equal(useZaicodeMainSessions.getState().byWorkspace["P-TEST-AVAIL"], "main-to-preserve");
});

// =========================================================================
// 3. CLEANUP CACHE INVALIDATION
// =========================================================================
test("RED-3: Successful cleanup invalidates warm cache and blocks resurrection while preserving unrelated sessions", async () => {
  const transport = createMockTransport();
  const layer = new SessionDataLayer({ transport });

  // Open two live sessions
  const lease1 = layer.acquire("sess-live-1");
  const lease2 = layer.acquire("sess-live-2");
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(layer.isWarm("sess-live-1"), true);
  assert.equal(layer.isWarm("sess-live-2"), true);

  // Clear session 1
  lease1.release();
  layer.invalidateSession("sess-live-1");
  retireSessions(["sess-live-1"]);

  // sess-live-1 warm projection must be gone
  assert.equal(layer.isWarm("sess-live-1"), false);

  // Attempting to re-acquire retired session must throw
  assert.throws(() => {
    layer.acquire("sess-live-1");
  }, /Cannot acquire retired session/);

  // Unrelated live session 2 must remain fully warm and usable
  assert.equal(layer.isWarm("sess-live-2"), true);
  assert.equal(layer.getWarmStore("sess-live-2") !== null, true);

  lease2.release();
  layer.dispose();
});

// =========================================================================
// 4. HELPER SESSION IDENTITY CONFIRMATION
// =========================================================================
test("RED-4: Helper session creation binds strictly to matching creation ACK; unrelated mounts rejected", () => {
  useZaicodeFreshSession.getState().reset();
  useZaicodeActionIntents.setState({ intents: {}, helperQueue: [], mainQueue: [] });

  // A. Start SAIHUNT helper creation
  const intent1 = useZaicodeActionIntents.getState().createIntent({
    workspacePath: "V:/code/hunt-ws",
    workspaceIdentity: "ws-hunt",
    destination: "helper",
    command: "saihunt",
  });
  useZaicodeActionIntents.getState().transitionState(intent1.id, "ADMISSION_PENDING");

  useZaicodeFreshSession.getState().open(
    "V:/code/hunt-ws",
    "ws-hunt",
    "saihunt",
    { kind: "subSaipen", role: "HUNT", ownership: "helper", command: "saihunt" },
    "origin-sess-1",
    intent1.id,
  );

  const req = useZaicodeFreshSession.getState().request;
  assert.ok(req);
  assert.equal(req.intentId, intent1.id);

  // B & C. Mount existing session from same project -> must NOT confirm and must NOT advance FIFO
  const confirmedSameProjectMount = useZaicodeFreshSession.getState().confirmSession("existing-sess-1");
  assert.equal(confirmedSameProjectMount, false);
  assert.equal(useZaicodeFreshSession.getState().currentId, req.id);
  assert.equal(useZaicodeActionIntents.getState().intents[intent1.id]?.state, "ADMISSION_PENDING");

  // D & E. Mount session from another workspace -> must NOT confirm
  const confirmedOtherWsMount = useZaicodeFreshSession.getState().confirmSession({
    sessionId: "other-sess",
    workspaceIdentity: "other-ws",
    intentId: "unrelated-intent",
  });
  assert.equal(confirmedOtherWsMount, false);
  assert.equal(useZaicodeFreshSession.getState().currentId, req.id);

  // F & G. Deliver matching creation ACK -> must confirm and transition to RUNNING with exact session ID
  const confirmedMatching = useZaicodeFreshSession.getState().confirmSession({
    sessionId: "created-hunt-session-42",
    requestId: req.id,
    intentId: intent1.id,
    workspaceIdentity: "ws-hunt",
  });
  assert.equal(confirmedMatching, true);
  assert.equal(useZaicodeActionIntents.getState().intents[intent1.id]?.state, "RUNNING");
  assert.equal(useZaicodeActionIntents.getState().intents[intent1.id]?.targetSessionId, "created-hunt-session-42");

  // H, I, J. Rapid helper queueing and delayed late ACK handling
  useZaicodeFreshSession.getState().reset();
  const intent2 = useZaicodeActionIntents.getState().createIntent({
    workspacePath: "V:/code/hunt-ws",
    destination: "helper",
    command: "saiwiki",
  });
  useZaicodeFreshSession.getState().open("V:/code/hunt-ws", undefined, "saiwiki", undefined, null, intent2.id);
  const req2 = useZaicodeFreshSession.getState().request!;

  const intent3 = useZaicodeActionIntents.getState().createIntent({
    workspacePath: "V:/code/hunt-ws",
    destination: "helper",
    command: "saitest",
  });
  useZaicodeFreshSession.getState().open("V:/code/hunt-ws", undefined, "saitest", undefined, null, intent3.id);

  // Advance req2 by timeout
  useZaicodeFreshSession.getState().advance(true);
  assert.equal(useZaicodeActionIntents.getState().intents[intent2.id]?.state, "REJECTED");

  // Current active request is now req3 (saitest)
  const currentReq = useZaicodeFreshSession.getState().queue.find((r) => r.id === useZaicodeFreshSession.getState().currentId);
  assert.equal(currentReq?.intentId, intent3.id);

  // A delayed late ACK for req2 (saiwiki) must NOT hijack req3
  const lateAckResult = useZaicodeFreshSession.getState().confirmSession({
    sessionId: "late-wiki-session",
    requestId: req2.id,
    intentId: intent2.id,
  });
  assert.equal(lateAckResult, false);
  assert.equal(useZaicodeActionIntents.getState().intents[intent3.id]?.state, "CREATED");

  // Deliver correct ACK for req3 -> confirms cleanly
  const correctReq3Ack = useZaicodeFreshSession.getState().confirmSession({
    sessionId: "saitest-session-88",
    requestId: currentReq!.id,
    intentId: intent3.id,
  });
  assert.equal(correctReq3Ack, true);
  assert.equal(useZaicodeActionIntents.getState().intents[intent3.id]?.state, "RUNNING");
  assert.equal(useZaicodeActionIntents.getState().intents[intent3.id]?.targetSessionId, "saitest-session-88");
});

// =========================================================================
// 5. PREFETCH FAILURE COOLDOWN
// =========================================================================
test("RED-5: Prefetch failure marks cooldown, prevents hover storm, allows bounded retry and foreground bypass", async () => {
  const transport = createMockTransport("failing-sess");
  const layer = new SessionDataLayer({ transport });

  // 1. Initial prefetch of failing session
  layer.prefetch("failing-sess");
  await new Promise((r) => setTimeout(r, 20));

  // Verify cooldown is established
  assert.equal(adaptivePrefetchCoordinator.isCooldown("failing-sess"), true);

  // 2. Rapid hover on the cooled-down session does NOT schedule a new prefetch
  const initialPrefetchSize = layer.size;
  adaptivePrefetchCoordinator.onCandidateHover(layer, "failing-sess");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(layer.size, initialPrefetchSize);

  // 3. A healthy session still prefetches without interference
  layer.prefetch("healthy-sess");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(layer.isWarm("healthy-sess"), true);

  // 4. Foreground explicit opening bypasses speculative cooldown and clears it on success
  const foregroundLease = layer.acquire("failing-sess");
  // Cooldown is cleared on explicit foreground acquire
  assert.equal(adaptivePrefetchCoordinator.isCooldown("failing-sess"), false);

  foregroundLease.release();
  layer.dispose();
});
