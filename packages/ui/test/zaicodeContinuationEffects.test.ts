import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZaicodeContinuingJobs, normalizeZaicodeEnginesConfig, type ZaicodeContinuingJob, type ZaicodeEngineAccount, type ZaicodeLimitSnapshot } from "@zcode/shared";
import { beginZaicodeContinuation, recordZaicodeContinuationWorkerLimit, tickZaicodeContinuations, type ZaicodeContinuationRuntime, type ZaicodeContinuationStore } from "../src/zaicode/zaicodeAutostartContinuation.js";
import type { ZaicodeWorker } from "../src/zaicode/zaicodeWorkers.js";
import type { ZaicodeSessionBrief, ZaicodeContinueOptions } from "../src/zaicode/zaicodeContinue.js";
import type { ZaicodeServices } from "../src/zaicode/zaicodeServices.js";

const START = 1_000_000_000;
const target = { key: "fixture", path: "C:/fixture", name: "fixture" };
const account = (id: string): ZaicodeEngineAccount => ({ id, short: id, label: id, vendor: "codex", source: "fixture", home: null, isDefaultHome: true, cli: "codex", status: "ready", statusDetail: "", fixCommand: null });
const quota = (id: string, now: number, percent = 90): ZaicodeLimitSnapshot => ({ accountId: id, source: "fixture", plan: null, fetchedAt: now, checkedAt: now, error: null, windows: [{ key: "five_hour", label: "5h", group: "", groupLabel: "", remainingPercent: percent, resetsAt: now - 1, durationSeconds: 18_000 }] });
const modelView = { revision: 1, providers: [{ providerId: "route", config: {}, models: [{ modelId: "SAIFREN", config: { optionSpecs: { reasoningLevel: { values: ["high"] } } } }] }] };

function fixture() {
  let jobs = normalizeZaicodeContinuingJobs([{ id: "j", projectPath: target.path, engineId: "C1", prompt: "/goal cc all", continuation: { enabled: true, runnerIds: ["C2", "pool:route/SAIFREN"], delayMinutes: 1, recoveryDelayMinutes: 1 } }]);
  jobs[0]!.continuationRuns = beginZaicodeContinuation(jobs[0]!, [target], "one", START);
  let workers: ZaicodeWorker[] = [];
  let sessions: ZaicodeSessionBrief[] = [];
  let dispatch = true;
  let blocked = false;
  const launches: string[] = [], stops: string[] = [], pool: ZaicodeContinueOptions[] = [];
  const limits: Record<string, ZaicodeLimitSnapshot> = { C1: quota("C1", START), C2: quota("C2", START, 0) };
  const store: ZaicodeContinuationStore = {
    read: () => jobs,
    update: (id, patch) => { jobs = jobs.map((job) => job.id === id ? { ...job, ...patch } : job); },
    services: () => ({ modelSelection: { getView: async () => modelView } }) as unknown as ZaicodeServices,
    canDispatch: () => dispatch,
  };
  const runtime: ZaicodeContinuationRuntime = {
    engines: () => ({ accounts: [account("C1"), account("C2")], limits, config: normalizeZaicodeEnginesConfig(null), sweeping: false, probing: [], lastSweepAt: null, nextSweepAt: null }),
    refresh: async () => { throw new Error("offline fixture; refresh never manufactures quota"); },
    workers: () => ({ workers, activeId: null, focusedId: null, soloId: null, open: false, panelMaximized: false }),
    launch: async (params) => {
      assert.equal(jobs[0]!.continuationRuns[0]!.state, "launching", "persist before effect");
      assert.equal(params.canDispatch?.(), true);
      const existing = workers.find((worker) => worker.id === params.workerId);
      if (existing) return { ok: true, worker: existing, message: "same lease" };
      const worker: ZaicodeWorker = { id: params.workerId!, generation: params.generation ?? 1, accountId: params.account.id, vendor: params.account.vendor, short: params.account.short, label: params.account.label, projectPath: params.projectPath, projectName: "fixture", command: "fixture", prompt: params.prompt, startedAt: START, kind: "worker", exitCode: null, endedAt: null, placement: "panel", minimized: false, window: null, z: 0 };
      launches.push(worker.id); workers.push(worker);
      return { ok: true, worker, message: "launched" };
    },
    remove: (id, reason) => { assert.equal(reason, "schedule"); stops.push(id); workers = workers.filter((worker) => worker.id !== id); },
    sessions: () => sessions,
    handle: () => ({
      start: async (command, options) => {
        assert.deepEqual(command, { kind: "goal", objective: "cc all" });
        assert.equal(options?.canDispatch?.(), true);
        options?.onCreated?.("owned-session");
        assert.equal(jobs[0]!.continuationRuns[0]!.sessionId, "owned-session", "session persisted before first input");
        pool.push(options!);
        sessions = [{ sessionId: "owned-session", projectKey: target.key, workspacePath: target.path, title: "owned", running: true, waiting: false, failed: false, interrupted: false, manuallyStopped: false, crashCut: false, updatedAt: START, model: "SAIFREN", unreadAt: null, goalStatus: "active", goalObjective: "cc all", foregroundExecutionId: "execution-one", foregroundStartedAt: START + 61_000 }];
        return "owned-session";
      },
      send: async (sessionId, _command, options) => {
        assert.equal(sessionId, "owned-session", "continuation must reuse canonical MAIN");
        assert.equal(options?.canDispatch?.(), true);
        pool.push(options!);
        sessions = [{ sessionId, projectKey: target.key, workspacePath: target.path, title: "owned", running: true, waiting: false, failed: false, interrupted: false, manuallyStopped: false, crashCut: false, updatedAt: START, model: "SAIFREN", unreadAt: null, goalStatus: "active", goalObjective: "cc all", foregroundExecutionId: "execution-one", foregroundStartedAt: jobs[0]!.continuationRuns[0]!.launchedAt }];
      },
      stop: async (id, execution) => { assert.equal(id, "owned-session"); assert.equal(execution, "execution-one"); stops.push(id); sessions = []; },
      clear: async () => undefined,
    }),
    disabled: () => blocked,
    terminal: () => null,
    main: () => null,
    setMain: (_target, id) => assert.equal(id, "owned-session"),
  };
  return { store, runtime, launches, stops, pool, limits, job: () => jobs[0]!, run: () => jobs[0]!.continuationRuns[0]!, worker: () => workers[0]!, pause: () => { dispatch = false; }, disableProject: () => { blocked = true; }, crash: () => { jobs = JSON.parse(JSON.stringify(jobs)); workers = []; }, takeover: () => { sessions = sessions.map((session) => ({ ...session, foregroundExecutionId: "operator-execution" })); }, finish: () => { workers = workers.map((worker) => ({ ...worker, exitCode: 0 })); }, patch: (patch: Partial<ZaicodeContinuingJob>) => store.update("j", patch) };
}

test("actual continuation executor persists one dispatch, delays vendor limit handoff and routes the exact SAIFREN model", async () => {
  const f = fixture();
  await tickZaicodeContinuations(f.store, true, START, f.runtime);
  await tickZaicodeContinuations(f.store, true, START + 1000, f.runtime);
  assert.equal(f.launches.length, 1);
  assert.equal(recordZaicodeContinuationWorkerLimit(f.store, { ...f.worker(), generation: 99 }, { line: "Usage limit reached", window: "five_hour", resetText: null }, START + 1000), false);
  assert.equal(recordZaicodeContinuationWorkerLimit(f.store, f.worker(), { line: "Usage limit reached", window: "five_hour", resetText: null }, START + 1000), true);
  await tickZaicodeContinuations(f.store, true, START + 60_999, f.runtime);
  assert.equal(f.pool.length, 0);
  await tickZaicodeContinuations(f.store, true, START + 61_000, f.runtime);
  assert.equal(f.run().state, "running");
  assert.deepEqual(f.pool[0]!.modelSelection, { providerId: "route", modelId: "SAIFREN", options: { reasoningLevel: "high" } });
  assert.equal(f.pool[0]!.commandId, f.run().lease);
  assert.equal(f.stops.length, 1);
  f.limits.C1 = quota("C1", START + 62_000);
  await tickZaicodeContinuations(f.store, true, START + 62_000, f.runtime);
  assert.equal(f.run().preferredReadyAt, START + 122_000);
  await tickZaicodeContinuations(f.store, true, START + 121_999, f.runtime);
  assert.equal(f.launches.length, 1);
  await tickZaicodeContinuations(f.store, true, START + 122_000, f.runtime);
  assert.equal(f.launches.length, 2);
  assert.equal(f.run().runnerId, "C1");
  assert.deepEqual(f.stops.slice(-1), ["owned-session"]);
});

test("restart reuses the persisted worker lease and terminal identity; completion consumes no later runner", async () => {
  const f = fixture();
  await tickZaicodeContinuations(f.store, true, START, f.runtime);
  const lease = f.run().lease, workerId = f.run().workerId;
  f.crash();
  await tickZaicodeContinuations(f.store, true, START + 1000, f.runtime);
  assert.equal(f.run().lease, lease);
  assert.equal(f.run().workerId, workerId);
  assert.equal(f.run().generation, 2);
  assert.deepEqual(f.launches, [workerId, workerId]);
  f.finish();
  await tickZaicodeContinuations(f.store, true, START + 2000, f.runtime);
  await tickZaicodeContinuations(f.store, true, START + 3000, f.runtime);
  assert.equal(f.run().state, "complete");
  assert.equal(f.launches.length, 2);
});

test("MAIN survives repeated pool/worker replacement, missing old briefs, restart and recovery without a second session", async () => {
  const f = fixture();
  await tickZaicodeContinuations(f.store, true, START, f.runtime);
  recordZaicodeContinuationWorkerLimit(f.store, f.worker(), { line: "Usage limit reached", window: "five_hour", resetText: null }, START + 1000);
  await tickZaicodeContinuations(f.store, true, START + 61_000, f.runtime);
  assert.equal(f.run().sessionId, "owned-session");
  f.limits.C1 = quota("C1", START + 62_000);
  await tickZaicodeContinuations(f.store, true, START + 62_000, f.runtime);
  await tickZaicodeContinuations(f.store, true, START + 122_000, f.runtime);
  assert.equal(f.run().runnerId, "C1");
  assert.equal(f.run().sessionId, "owned-session");
  const lease = f.run().lease;
  f.crash();
  await tickZaicodeContinuations(f.store, true, START + 123_000, f.runtime);
  assert.equal(f.run().workerId, `zaicode-worker:${lease}`);
  assert.equal(f.run().generation, 2);
  assert.equal(f.launches.length, 3, "missing historical session cannot suppress owned worker recovery");
  for (let round = 0; round < 3; round++) {
    const now = START + 124_000 + round * 180_000;
    recordZaicodeContinuationWorkerLimit(f.store, f.worker(), { line: "Usage limit reached", window: "five_hour", resetText: null }, now);
    await tickZaicodeContinuations(f.store, true, now + 60_000, f.runtime);
    assert.equal(f.run().sessionId, "owned-session");
    assert.equal(f.run().runnerId, "pool:route/SAIFREN");
    f.limits.C1 = quota("C1", now + 61_000);
    await tickZaicodeContinuations(f.store, true, now + 61_000, f.runtime);
    await tickZaicodeContinuations(f.store, true, now + 121_000, f.runtime);
    assert.equal(f.run().runnerId, "C1");
    assert.equal(f.run().sessionId, "owned-session");
    f.crash();
    await tickZaicodeContinuations(f.store, true, now + 122_000, f.runtime);
    assert.equal(f.run().generation, 2);
  }
  assert.equal(f.pool.length, 4);
});

test("pause and project disable block real effects; active occurrences are never evicted or duplicated", async () => {
  for (const gate of ["pause", "disableProject"] as const) {
    const f = fixture(); f[gate]();
    await tickZaicodeContinuations(f.store, true, START, f.runtime);
    assert.equal(f.launches.length, 0);
  }
  const f = fixture();
  const active = Array.from({ length: 128 }, (_, i) => ({ ...f.run(), workspaceKey: `workspace-${i}` }));
  f.patch({ continuationRuns: active });
  assert.deepEqual(beginZaicodeContinuation(f.job(), [target], "two", START + 1000), active);
  f.patch({ continuationRuns: [f.run()] });
  assert.equal(beginZaicodeContinuation(f.job(), [{ ...target, key: f.run().workspaceKey }], "two", START + 1000).length, 1);
});

test("a later operator execution prevents the scheduled return from stopping or relaunching it", async () => {
  const f = fixture();
  await tickZaicodeContinuations(f.store, true, START, f.runtime);
  recordZaicodeContinuationWorkerLimit(f.store, f.worker(), { line: "Usage limit reached", window: "five_hour", resetText: null }, START + 1000);
  await tickZaicodeContinuations(f.store, true, START + 61_000, f.runtime);
  f.limits.C1 = quota("C1", START + 62_000);
  await tickZaicodeContinuations(f.store, true, START + 62_000, f.runtime);
  f.takeover();
  await tickZaicodeContinuations(f.store, true, START + 122_000, f.runtime);
  assert.equal(f.run().state, "stopped");
  assert.equal(f.launches.length, 1);
  assert.equal(f.stops.length, 1);
});

test("overlapping ticks cannot launch two workers while the first effect is pending", async () => {
  const f = fixture();
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const original = f.runtime.launch;
  f.runtime.launch = async (params) => { await deferred; return original(params); };
  const first = tickZaicodeContinuations(f.store, true, START, f.runtime);
  while (f.run().state !== "launching") await new Promise((resolve) => setImmediate(resolve));
  await tickZaicodeContinuations(f.store, true, START, f.runtime);
  release(); await first;
  assert.equal(f.launches.length, 1);
});

test("slow preparation cannot launch beyond the configured schedule stop time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  t.after(() => t.mock.timers.reset());
  const f = fixture();
  const deadline = new Date(START);
  deadline.setSeconds(0, 0);
  deadline.setMinutes(deadline.getMinutes() + 1);
  f.patch({ stopAt: `${String(deadline.getHours()).padStart(2, "0")}:${String(deadline.getMinutes()).padStart(2, "0")}` });
  const original = f.runtime.launch;
  f.runtime.launch = async (params) => {
    t.mock.timers.tick(deadline.getTime() - START + 1);
    if (!params.canDispatch?.()) return { ok: false, message: "Scheduled dispatch was cancelled" };
    return original(params);
  };
  await tickZaicodeContinuations(f.store, true, START, f.runtime);
  assert.equal(f.launches.length, 0, "the configured deadline still applies after asynchronous preparation");
  assert.equal(f.worker(), undefined);
  await tickZaicodeContinuations(f.store, true, deadline.getTime() + 1, f.runtime);
  assert.equal(f.run().state, "stopped");
});

test("changing runner and prompt during preparation cancels old admission and the next attempt uses the new account", async () => {
  const f = fixture();
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const original = f.runtime.launch;
  f.runtime.launch = async (params) => {
    await deferred;
    if (!params.canDispatch?.()) return { ok: false, message: "Configuration changed" };
    return original(params);
  };
  const first = tickZaicodeContinuations(f.store, true, START, f.runtime);
  while (f.run().state !== "launching") await new Promise((resolve) => setImmediate(resolve));
  f.patch({ engineId: "C2", prompt: "new objective" });
  f.limits.C2 = quota("C2", START);
  release();
  await first;
  assert.equal(f.launches.length, 0, "stale account must never be admitted");
  await tickZaicodeContinuations(f.store, true, START + 16_000, f.runtime);
  assert.equal(f.worker().accountId, "C2");
  assert.equal(f.worker().prompt, "new objective");
  assert.equal(f.run().result, "Continuing on C2");
});

test("a stop while launch acknowledgement is pending cannot be overwritten back to running", async () => {
  const f = fixture();
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const original = f.runtime.launch;
  f.runtime.launch = async (params) => { const launched = await original(params); await deferred; return launched; };
  const first = tickZaicodeContinuations(f.store, true, START, f.runtime);
  while (!f.worker()) await new Promise((resolve) => setImmediate(resolve));
  f.patch({ continuationRuns: [{ ...f.run(), state: "stopped", result: "Operator stopped" }] });
  release();
  await first;
  assert.equal(f.run().state, "stopped");
  assert.equal(f.run().result, "Operator stopped");
  assert.equal(f.worker(), undefined, "cancelled lease cannot leave an orphan worker");
});

test("retargeting during preparation cancels the old project and cannot restart it on the next tick", async () => {
  const f = fixture();
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const original = f.runtime.launch;
  f.runtime.launch = async (params) => {
    await deferred;
    if (!params.canDispatch?.()) return { ok: false, message: "Target changed" };
    return original(params);
  };
  const first = tickZaicodeContinuations(f.store, true, START, f.runtime);
  while (f.run().state !== "launching") await new Promise((resolve) => setImmediate(resolve));
  f.patch({ projectPath: "C:/new-project" });
  release(); await first;
  await tickZaicodeContinuations(f.store, true, START + 16_000, f.runtime);
  assert.equal(f.launches.length, 0, "the old project is no longer an admitted target");
  assert.equal(f.run().state, "stopped");
});

test("an account excluded while preparation is pending cannot dispatch and an eligible fallback can take over", async () => {
  const f = fixture();
  let release!: () => void;
  const deferred = new Promise<void>((resolve) => { release = resolve; });
  const originalLaunch = f.runtime.launch, originalEngines = f.runtime.engines;
  let excluded = false;
  f.runtime.engines = () => { const state = originalEngines(); return { ...state, accounts: state.accounts.filter((value) => !excluded || value.id !== "C1") }; };
  f.runtime.launch = async (params) => {
    await deferred;
    if (!params.canDispatch?.()) return { ok: false, message: "Account excluded" };
    return originalLaunch(params);
  };
  const first = tickZaicodeContinuations(f.store, true, START, f.runtime);
  while (f.run().state !== "launching") await new Promise((resolve) => setImmediate(resolve));
  excluded = true;
  f.limits.C2 = quota("C2", START);
  release(); await first;
  assert.equal(f.launches.length, 0);
  await tickZaicodeContinuations(f.store, true, START + 16_000, f.runtime);
  assert.equal(f.worker().accountId, "C2");
});
