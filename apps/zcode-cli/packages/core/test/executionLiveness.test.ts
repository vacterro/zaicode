import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settled } from "node:timers/promises";
import { SessionEventType } from "@zcode/contracts";
import { EXECUTION_LIVENESS_TTL_MS } from "@zcode/shared";
import { InMemoryRuntimeTaskRegistry, type RuntimeTaskSnapshot } from "../src/runtime-task/registry.js";
import { getExecutionLiveness } from "../src/runtime/methods/execution-liveness.js";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";
import { updateRuntimeBackgroundTask, registerRuntimeBackgroundTask } from "../src/tool/executor/background-task-registry.js";

const call = { id: "tool", name: "Bash", input: { command: "quiet-worker" } } as any;
const trace = { traceId: "trace-liveness" } as any;
const work = (patch: Partial<RuntimeTaskSnapshot> = {}): RuntimeTaskSnapshot => ({
  taskId: "worker", agentId: "worker", agentType: "local_bash", type: "local_bash",
  status: "running", startedAt: new Date(1), isBackgrounded: true, ...patch,
} as RuntimeTaskSnapshot);
function runtime() {
  let clock = 1000;
  const events: any[] = [];
  const owner: any = {
    runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(), now: () => new Date(clock),
    getActiveForegroundExecutionId: () => undefined, rootTraceContext: trace,
    createEvent: (type: string, payload: any) => ({ type, payload }),
    appendEvent: async (event: any) => { events.push(event); }, shuttingDown: false,
  };
  return { owner, events, at: (value: number) => { clock = value; }, read: (ids = ["worker"]) => getExecutionLiveness.call(owner, ids) };
}

test("quiet six-hour worker renews through the existing poll without transcript progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const s = runtime();
  const events: any[] = [];
  let snapshots = 0;
  let status = "running";
  const deps: any = {
    sessionId: "session", runtimeTaskRegistry: s.owner.runtimeTaskRegistry,
    executionPort: { getBackgroundTask: async () => { snapshots += 1; return { status, pid: 123, startedAt: new Date(1) }; } },
    emitEvent: async (event: any) => { events.push(event); },
  };
  await new BackgroundTaskTracker(deps).trackBackgroundTask(call, { status: "backgrounded", backgroundTaskId: "worker" }, trace, undefined);
  assert.equal(snapshots, 1);
  const progressEvents = events.length;
  const sixHours = 6 * 60 * 60 * 1000;
  t.mock.timers.setTime(sixHours);
  t.mock.timers.tick(1000);
  await settled();
  s.at(sixHours + 1000);
  const proof = await s.read();
  assert.equal(proof.background[0]?.status, "running");
  assert.equal(proof.background[0]?.confirmedAt, sixHours + 1000);
  assert.equal(events.length, progressEvents, "unchanged snapshot is liveness, not progress");
  assert.equal(proof.background[0]?.pid, 123);
  const count = snapshots;
  await s.read();
  assert.equal(snapshots, count, "index observation must not start a second worker poll");
  status = "completed";
  t.mock.timers.tick(1000);
  await settled();
  assert.equal((await s.read()).background[0]?.status, "completed");
  assert.equal(events.at(-1)?.type, SessionEventType.BackgroundTaskCompleted);
});

test("a paused or failing poll cannot renew a cached running claim", async () => {
  const s = runtime();
  s.owner.runtimeTaskRegistry.register(work({ livenessSource: "poll", lastConfirmedAt: 1000 }));
  s.at(1001 + EXECUTION_LIVENESS_TTL_MS);
  assert.equal((await s.read()).background[0]?.status, "unconfirmed");
});

test("fresh persisted claim after fast restart is orphaned and owner generation changes", async () => {
  const first = runtime();
  first.owner.runtimeTaskRegistry.register(work({ lastConfirmedAt: 1000, livenessSource: "poll" }));
  const before = await first.read();
  const restarted = runtime();
  const after = await restarted.read();
  assert.notEqual(after.ownerId, before.ownerId);
  assert.equal(after.background[0]?.status, "orphaned");
  assert.equal(after.orphaned, true);
  assert.equal((await restarted.read()).ownerId, after.ownerId);
});

test("graceful release withdraws foreground and background without navigation", async () => {
  const s = runtime();
  s.owner.getActiveForegroundExecutionId = () => "foreground";
  s.owner.runtimeTaskRegistry.register(work({ lastConfirmedAt: 1000, livenessSource: "poll" }));
  assert.equal((await s.read()).foregroundExecutionId, "foreground");
  s.owner.shuttingDown = true;
  const released = await s.read();
  assert.equal(released.released, true);
  assert.equal(released.foregroundExecutionId, undefined);
  assert.equal(released.background[0]?.status, "orphaned");
});

test("resumed missing worker reconciles once; uncertain read is not a terminal fact", async () => {
  const s = runtime();
  s.owner.runtimeTaskRegistry.register(work());
  s.owner.executionPort = { getBackgroundTask: async () => { throw new Error("temporarily unavailable"); } };
  assert.equal((await s.read()).background[0]?.status, "unconfirmed");
  assert.equal(s.events.length, 0);
  s.owner.executionPort.getBackgroundTask = async () => undefined;
  assert.equal((await s.read()).background[0]?.status, "orphaned");
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].type, SessionEventType.BackgroundTaskCompleted);
  await s.read();
  assert.equal(s.events.length, 1);
});

test("late observations cannot revive completion or a replacement lifecycle", async () => {
  const s = runtime();
  s.owner.runtimeTaskRegistry.register(work({ livenessTrackingId: "original" }));
  let finish!: (value: any) => void;
  s.owner.executionPort = { getBackgroundTask: () => new Promise((resolve) => { finish = resolve; }) };
  const pending = s.read();
  s.owner.runtimeTaskRegistry.update("worker", (current: RuntimeTaskSnapshot) => ({ ...current, status: "completed" }));
  finish({ status: "running" });
  assert.equal((await pending).background[0]?.status, "completed");
  assert.equal(updateRuntimeBackgroundTask({ runtimeTaskRegistry: s.owner.runtimeTaskRegistry } as any, call, "worker", "running", undefined, "original"), false);
  registerRuntimeBackgroundTask({ runtimeTaskRegistry: s.owner.runtimeTaskRegistry } as any, call, "worker", {});
  assert.equal(s.owner.runtimeTaskRegistry.get("worker")?.status, "completed", "late tracker registration is not a new Bash lifetime");
  s.owner.runtimeTaskRegistry.register(work({ livenessTrackingId: "replacement" }));
  assert.equal(updateRuntimeBackgroundTask({ runtimeTaskRegistry: s.owner.runtimeTaskRegistry } as any, call, "worker", "completed", undefined, "original"), false);
  assert.equal(s.owner.runtimeTaskRegistry.get("worker")?.status, "running");
});

test("resumed worker completion uses its existing terminal event and is idempotent", async () => {
  const s = runtime();
  s.owner.runtimeTaskRegistry.register(work());
  s.owner.executionPort = { getBackgroundTask: async () => ({ status: "completed", pid: 123, completedAt: new Date(999) }) };
  assert.equal((await s.read()).background[0]?.status, "completed");
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].payload.status, "completed");
  await s.read();
  assert.equal(s.events.length, 1);
});

test("Agent background tracking confirms its existing task without dropping progress", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
  const s = runtime();
  s.owner.runtimeTaskRegistry.register(work({ type: "local_agent", agentType: "local_agent" }));
  let status = "running";
  const events: any[] = [];
  const deps: any = {
    sessionId: "session", runtimeTaskRegistry: s.owner.runtimeTaskRegistry,
    subagentPort: { getTask: async () => ({ ...work({ type: "local_agent" }), status }) },
    emitEvent: async (event: any) => { events.push(event); },
  };
  await new BackgroundTaskTracker(deps).trackBackgroundTask({ ...call, name: "Agent" }, { status: "async_launched", agentId: "worker" }, trace, undefined);
  t.mock.timers.tick(1000);
  await settled();
  assert.equal(s.owner.runtimeTaskRegistry.get("worker")?.lastConfirmedAt, 2000);
  assert.ok(events.some((event) => event.type === SessionEventType.BackgroundTaskUpdated));
  status = "completed";
  t.mock.timers.tick(1000);
  await settled();
});
