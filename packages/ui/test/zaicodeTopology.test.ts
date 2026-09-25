import assert from "node:assert/strict";
import test from "node:test";
import {
  applyZaicodePlacementPatch,
  freezeZaicodeRuntimeIdentity,
  transitionZaicodeRuntime,
  zaicodeProjectTopology,
  ZAICODE_RUNTIME_IDENTITY_KEYS,
  type ZaicodeRuntimeIdentity,
  type ZaicodeSubchatConversation,
} from "@zcode/shared";
import {
  cycleZaicodeWorker,
  dockZaicodeWorker,
  duplicateZaicodeWorker,
  floatZaicodeWorker,
  focusZaicodeWorker,
  hideZaicodeWorkersPanel,
  minimizeZaicodeWorker,
  moveZaicodeWorker,
  openZaicodeShellWorker,
  openZaicodeWorkersPanel,
  raiseZaicodeWorker,
  readZaicodeWorkers,
  removeZaicodeWorker,
  setZaicodeWorkerWindow,
  setZaicodeWorkersPanelMaximized,
  soloZaicodeWorker,
} from "../src/zaicode/zaicodeWorkers.js";
import {
  exitZaicodeWorkerRecord,
  readZaicodeWorkerIdentities,
  readZaicodeWorkerRecords,
  ZAICODE_WORKER_PLACE_KEYS,
} from "../src/zaicode/zaicodeWorkerRecords.js";
import { normalizeZaicodeAliveWorkers } from "../src/zaicode/zaicodeWorkerRecovery.js";
import {
  readZaicodeRuntimeRegistry,
  zaicodeSubchatRuntimeIdentities,
  zaicodeWorkerRuntimeIdentity,
} from "../src/zaicode/zaicodeRuntimeRegistry.js";
import { useZaicodeMainSessions } from "../src/zaicode/zaicodeMainSession.js";
import { useZaicodeSidebarPrefs } from "../src/zaicode/zaicodeSidebarPrefs.js";

// T-42 (SRC-033 analysis 3): location != ownership, window != worker identity, slot != execution authority.

function clearWorkers(): void {
  // Removal publishes a new array; this loop walks the one read before it.
  for (const worker of readZaicodeWorkers().workers) removeZaicodeWorker(worker.id);
}

function identityOf(id: string) {
  return readZaicodeWorkerIdentities().find((identity) => identity.id === id)!;
}

test("a worker's identity survives every placement change as the same frozen record", () => {
  clearWorkers();
  const first = openZaicodeShellWorker("C:/work/alpha", "panel");
  const second = openZaicodeShellWorker("C:/work/beta", "panel");
  const before = identityOf(first.id);
  const snapshot = JSON.stringify(before);
  assert.ok(Object.isFrozen(before));

  const moves: [string, () => void, (worker: ReturnType<typeof readZaicodeWorkers>["workers"][number]) => boolean][] = [
    ["float into a window", () => floatZaicodeWorker(first.id, { x: 10, y: 20, width: 400, height: 300 }), (w) => w.placement === "window"],
    ["resize the window", () => setZaicodeWorkerWindow(first.id, { x: 50, y: 60, width: 500, height: 320, maximized: true }), (w) => w.window?.maximized === true],
    ["raise", () => raiseZaicodeWorker(first.id), () => true],
    ["minimize to a chip", () => minimizeZaicodeWorker(first.id), (w) => w.minimized],
    ["restore", () => focusZaicodeWorker(first.id), (w) => !w.minimized],
    ["dock into the panel", () => dockZaicodeWorker(first.id), (w) => w.placement === "panel"],
    ["reorder the panel", () => moveZaicodeWorker(first.id, 1), () => readZaicodeWorkers().workers[1]?.id === first.id],
    ["solo", () => soloZaicodeWorker(first.id), () => readZaicodeWorkers().soloId === first.id],
    ["panel maximized", () => setZaicodeWorkersPanelMaximized(true), () => readZaicodeWorkers().panelMaximized],
    ["panel hidden", () => hideZaicodeWorkersPanel(), () => !readZaicodeWorkers().open],
    ["panel shown", () => openZaicodeWorkersPanel(second.id), () => readZaicodeWorkers().open],
    ["cycle focus", () => cycleZaicodeWorker(1), () => true],
  ];
  for (const [name, move, placed] of moves) {
    move();
    const view = readZaicodeWorkers().workers.find((worker) => worker.id === first.id)!;
    assert.ok(placed(view), `${name}: the placement changed`);
    assert.equal(identityOf(first.id), before, `${name}: identity is the same record`);
    assert.equal(JSON.stringify(identityOf(first.id)), snapshot, `${name}: identity fields unchanged`);
  }
  assert.equal(identityOf(second.id).projectPath, "C:/work/beta", "the other worker kept its own identity");
  clearWorkers();
});

test("placement code cannot write an identity field; identity records cannot be mutated", () => {
  clearWorkers();
  const worker = openZaicodeShellWorker("C:/work/alpha", "panel");
  const record = readZaicodeWorkerRecords()[0]!;
  for (const key of ["projectPath", "accountId", "exitCode", "generation", "id", "command"]) {
    assert.throws(
      () => applyZaicodePlacementPatch(record.place, { [key]: "moved" } as never, ZAICODE_WORKER_PLACE_KEYS),
      /placement cannot change/,
      key,
    );
  }
  assert.throws(() => {
    (identityOf(worker.id) as { projectPath: string }).projectPath = "C:/elsewhere";
  }, TypeError);
  assert.equal(identityOf(worker.id).projectPath, "C:/work/alpha");
  for (const key of ZAICODE_WORKER_PLACE_KEYS) assert.ok(!(ZAICODE_RUNTIME_IDENTITY_KEYS as readonly string[]).includes(key), `${key} is layout only`);
  clearWorkers();
});

test("only the runtime changes identity: an exit replaces it, the place stays", () => {
  clearWorkers();
  const worker = openZaicodeShellWorker("C:/work/alpha", "window");
  const before = readZaicodeWorkerRecords()[0]!;
  exitZaicodeWorkerRecord(worker.id, 2, 1234);
  const after = readZaicodeWorkerRecords()[0]!;
  assert.notEqual(after.identity, before.identity);
  assert.equal(after.identity.exitCode, 2);
  assert.equal(after.identity.endedAt, 1234);
  assert.ok(Object.isFrozen(after.identity));
  assert.equal(after.place, before.place, "an exit does not move the worker");
  const runtime = zaicodeWorkerRuntimeIdentity(after.identity);
  assert.equal(runtime.health, "failed");
  assert.equal(runtime.lease, null);
  clearWorkers();
});

test("generations: the same engine in the same project counts up; a crash restart continues the count", () => {
  clearWorkers();
  const one = openZaicodeShellWorker("C:/work/alpha", "panel");
  const two = openZaicodeShellWorker("c:/WORK/alpha", "panel");
  const other = openZaicodeShellWorker("C:/work/beta", "panel");
  const copy = duplicateZaicodeWorker(one.id)!;
  assert.deepEqual(
    [one, two, other, copy].map((worker) => identityOf(worker.id).generation),
    [1, 2, 1, 3],
  );
  const alive = normalizeZaicodeAliveWorkers([
    { accountId: "codex:a", projectPath: "C:/p", prompt: "cc", placement: "panel", generation: 4 },
    { accountId: "codex:b", projectPath: "C:/p", prompt: null, placement: "window" },
  ]);
  assert.deepEqual(
    alive.map((entry) => entry.generation),
    [4, 1],
  );
  clearWorkers();
});

test("runtime transitions: exit ends the lease; restart is the next generation with a new runtime id", () => {
  const start: ZaicodeRuntimeIdentity = freezeZaicodeRuntimeIdentity({
    runtimeId: "r1",
    workId: "chat-1",
    owner: "codex:home2",
    role: "worker",
    generation: 1,
    engine: "codex",
    projectPath: "C:/p",
    lease: { holder: "zaicode-window", since: 1 },
    health: "running",
  });
  const exited = transitionZaicodeRuntime(start, { type: "exited", code: 0, at: 5 });
  assert.equal(exited.health, "exited");
  assert.equal(exited.lease, null);
  assert.equal(exited.owner, "codex:home2");
  const again = transitionZaicodeRuntime(exited, { type: "restarted", runtimeId: "r2", at: 9, holder: "zaicode-window" });
  assert.deepEqual([again.runtimeId, again.generation, again.health, again.lease?.since], ["r2", 2, "running", 9]);
  assert.equal(again.workId, "chat-1", "the work and its owner carry over");
  assert.ok(Object.isFrozen(again) && Object.isFrozen(again.lease));
});

test("topology per project from identities only: workers and chat turns, path spelling ignored", () => {
  const chat: ZaicodeSubchatConversation = {
    id: "chat-1",
    accountId: "claude:home2",
    vendor: "claude",
    short: "A2",
    label: "Claude 2",
    projectPath: "V:\\work\\Alpha\\",
    sessionId: "s",
    model: null,
    title: "t",
    createdAt: 1,
    updatedAt: 3,
    status: "running",
    usage: { input: 0, output: 0, cached: 0 },
    messages: [
      { id: "m1", role: "user", text: "a", at: 1 },
      { id: "m2", role: "assistant", text: "b", at: 2 },
      { id: "m3", role: "user", text: "c", at: 3 },
    ],
  };
  const turns = zaicodeSubchatRuntimeIdentities([chat], { "turn-9": "chat-1", "turn-x": "gone" });
  assert.equal(turns.length, 1);
  assert.deepEqual([turns[0]!.role, turns[0]!.workId, turns[0]!.generation, turns[0]!.lease?.since], ["subchat", "chat-1", 2, 3]);
  const worker = freezeZaicodeRuntimeIdentity({ ...turns[0]!, runtimeId: "w1", role: "worker", workId: null, projectPath: "v:/work/alpha" });
  const elsewhere = freezeZaicodeRuntimeIdentity({ ...worker, runtimeId: "w2", projectPath: "v:/work/beta" });
  const topology = zaicodeProjectTopology([...turns, worker, elsewhere], "V:/work/alpha");
  assert.deepEqual(
    topology.workers.map((identity) => identity.runtimeId),
    ["w1"],
  );
  assert.deepEqual(
    topology.subchats.map((identity) => identity.runtimeId),
    ["turn-9"],
  );
  assert.equal(topology.primary, null);
});

test("slots and MAIN are pointers: moving a project or re-pointing MAIN leaves the registry as it was", () => {
  clearWorkers();
  openZaicodeShellWorker("C:/work/alpha", "panel");
  const before = JSON.stringify(readZaicodeRuntimeRegistry());
  useZaicodeSidebarPrefs.getState().setGroup("C:/work/alpha", "SIDE1");
  useZaicodeMainSessions.getState().setMain("C:/work/alpha", "session-42");
  assert.equal(JSON.stringify(readZaicodeRuntimeRegistry()), before);
  clearWorkers();
});
