import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settled } from "node:timers/promises";
import { SessionEventType } from "@zcode/contracts";
import { EXECUTION_LIVENESS_INTERVAL_MS, type ExecutionLivenessSnapshot } from "@zcode/shared";
import { sessionsIndexTopic, sessionsIndexTopicFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { SessionsIndexProjection } from "../src/zcode-protocol-v4/sessions-index-projection.js";

function fixture() {
  let now = 1000;
  let sequence = 0;
  let calls = 0;
  let connection = 0;
  let status: "running" | "completed" = "running";
  const wires: any[] = [];
  const errors: any[] = [];
  const requested: string[][] = [];
  let read: (id: string, ids: readonly string[]) => Promise<ExecutionLivenessSnapshot | null> = async (_id, ids) => ({
    ownerId: "runtime", released: false, observedAt: now, validUntil: now + 120_000,
    background: ids.map((workId) => ({ workId, status, confirmedAt: now, pid: 123 })), orphaned: false, unconfirmed: false,
  });
  const gateway = new ConversationV4Gateway({
    sessionExists: () => true, emitWireFrame: (wire: any) => { wires.push(wire); },
    getSessionWorkspaceId: () => "workspace", listWorkspaceSessionIds: () => ["session"],
    getSessionIndexMeta: () => ({ createdAt: 1, lastActivityAt: 1 }),
    getStoredSessionSummaries: async () => [],
    getSessionExecutionLiveness: async (id, ids) => { calls += 1; requested.push([...ids]); return read(id, ids); },
    onError: (scope, error) => { errors.push({ scope, error }); },
  } as any, { now: () => now, createLogEpoch: (id) => `epoch:${id}` });
  const event = (type: SessionEventType, payload: any) => {
    sequence += 1;
    gateway.ingest("session", { id: `event-${sequence}`, sessionId: "session", traceId: "trace", sequenceNumber: sequence, timestamp: new Date(1), type, payload } as any);
  };
  const snapshot = async (deliveryProfile: "continuous" | "replayable" = "continuous") => {
    const result = await gateway.subscribeSessionsIndex({ connectionId: `client-${++connection}`, topic: sessionsIndexTopic("workspace"), clientMode: deliveryProfile === "continuous" ? "desktop-continuous" : "web-remote-replayable" });
    const frame = sessionsIndexTopicFrameSchema.parse(result.initialFrame);
    assert.equal(frame.payload.kind, "snapshot");
    return (frame.payload as any).snapshot.sessions[0];
  };
  return { gateway, event, snapshot, errors, wires, requested, calls: () => calls,
    at: (value: number) => { now = value; }, status: (value: typeof status) => { status = value; },
    observe: (value: typeof read) => { read = value; } };
}

test("mandatory gateway tick refreshes quiet off-screen work without conversation subscribers or progress", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = fixture();
  try {
    s.event(SessionEventType.BackgroundTaskStarted, { taskId: "worker", taskKind: "bash", status: "running", toolCallId: "tool", command: "quiet-worker" });
    await settled();
    const first = await s.snapshot();
    assert.equal(first.hasBackgroundWork, true);
    const before = s.calls();
    s.at(6 * 60 * 60 * 1000);
    t.mock.timers.tick(EXECUTION_LIVENESS_INTERVAL_MS);
    await settled();
    assert.ok(s.calls() > before, "actual maintenance timer must run with no mounted conversation");
    const renewed = await s.snapshot("replayable");
    assert.equal(renewed.executionLiveness.observedAt, 6 * 60 * 60 * 1000);
    assert.equal(renewed.hasBackgroundWork, true);
    assert.equal(renewed.lastActivityAt, 1);
    assert.deepEqual(s.requested.at(-1), ["worker"]);
    s.status("completed");
    t.mock.timers.tick(EXECUTION_LIVENESS_INTERVAL_MS);
    await settled();
    const beforeOpening = await s.snapshot();
    assert.equal(beforeOpening.hasBackgroundWork, false);
    assert.equal((await s.snapshot("replayable")).hasBackgroundWork, false);
    assert.deepEqual(s.errors, []);
  } finally { s.gateway.dispose(); }
});

test("gateway observations are single-flight and a late running sample cannot overwrite terminal work", async () => {
  const s = fixture();
  try {
    s.event(SessionEventType.BackgroundTaskStarted, { taskId: "worker", taskKind: "bash", status: "running", toolCallId: "tool" });
    await settled();
    await s.snapshot();
    let complete!: (value: ExecutionLivenessSnapshot) => void;
    const observed = new Promise<ExecutionLivenessSnapshot>((resolve) => { complete = resolve; });
    s.observe(async () => observed);
    const before = s.calls();
    const pending = (s.gateway as any).executionLiveness.refreshActive();
    const duplicate = (s.gateway as any).executionLiveness.refreshActive();
    await settled();
    assert.equal(s.calls(), before + 1);
    s.event(SessionEventType.BackgroundTaskCompleted, { taskId: "worker", status: "completed", taskKind: "bash", toolCallId: "tool" });
    s.observe(async () => ({ ownerId: "new-owner", released: false, observedAt: 2000, validUntil: 122000, background: [], orphaned: false, unconfirmed: false }));
    complete({ ownerId: "old-owner", released: false, observedAt: 1000, validUntil: 121000, background: [{ workId: "worker", status: "running", confirmedAt: 1000 }], orphaned: false, unconfirmed: false });
    await Promise.all([pending, duplicate]);
    await settled();
    const result = await s.snapshot();
    assert.equal(result.hasBackgroundWork, false);
    assert.equal(result.executionLiveness.ownerId, "new-owner");
    assert.deepEqual(s.errors, []);
  } finally { s.gateway.dispose(); }
});

test("disposing the gateway fences a pending sample and clears its mandatory timer", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const s = fixture();
  let complete!: (value: ExecutionLivenessSnapshot) => void;
  s.observe(async () => new Promise((resolve) => { complete = resolve; }));
  s.event(SessionEventType.BackgroundTaskStarted, { taskId: "worker", taskKind: "bash", status: "running", toolCallId: "tool" });
  await settled();
  const calls = s.calls();
  s.gateway.dispose();
  complete({ ownerId: "old-owner", released: false, observedAt: 1000, validUntil: 121000, background: [], orphaned: false, unconfirmed: false });
  await settled();
  t.mock.timers.tick(2 * EXECUTION_LIVENESS_INTERVAL_MS);
  await settled();
  assert.equal(s.calls(), calls);
  assert.equal(s.wires.length, 0);
  assert.deepEqual(s.errors, []);
});

test("index distinguishes a fresh live foreground from an equally fresh orphan after restart", () => {
  const source: any = {
    sessionId: "session", meta: { title: "Worker" },
    control: { phase: "running", sessionEnded: false, activeWorks: [{ foregroundExecutionId: "actual", startedAt: 1 }] },
    rows: { window: [] }, plan: { items: [] }, backgroundWorks: [], workflowRuns: [], pendingInteractions: [],
  };
  const index = new SessionsIndexProjection("workspace", "epoch");
  const observedAt = 6 * 60 * 60 * 1000;
  const extra = { createdAt: 1, lastActivityAt: 1, executionLiveness: {
    ownerId: "actual-runtime", foregroundExecutionId: "actual", released: false,
    observedAt, validUntil: observedAt + 120000, background: [], orphaned: false, unconfirmed: false,
  } };
  index.upsertFromConversation(source, extra);
  assert.equal(index.getSnapshot().sessions[0]?.phase, "running");
  delete (extra.executionLiveness as Partial<ExecutionLivenessSnapshot>).foregroundExecutionId;
  extra.executionLiveness.ownerId = "new-runtime";
  index.upsertFromConversation(source, extra);
  const orphan = index.getSnapshot().sessions[0]!;
  assert.equal(orphan.phase, "completedInterrupted");
  assert.equal(orphan.executionLiveness?.orphaned, true);
  assert.equal(orphan.lastActivityAt, 1);
  assert.equal(index.upsertFromConversation(source, extra).length, 0, "reconciliation is idempotent");
});
