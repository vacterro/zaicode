import assert from "node:assert/strict";
import test from "node:test";
import {
  detectZaicodeVendorLimit,
  type ZaicodeWorkerLimitSignal,
} from "../src/zaicode/zaicodeWorkerSignals.js";
import {
  normalizeZaicodeContinuingJobs,
  normalizeZaicodeEnginesConfig,
  providerQuotaCircuit,
  resetProviderQuotaCircuits,
  type ZaicodeContinuingJob,
  type ZaicodeEngineAccount,
  type ZaicodeLimitSnapshot,
} from "@zcode/shared";
import {
  beginZaicodeContinuation,
  recordZaicodeContinuationWorkerLimit,
  tickZaicodeContinuations,
  type ZaicodeContinuationRuntime,
  type ZaicodeContinuationStore,
} from "../src/zaicode/zaicodeAutostartContinuation.js";
import type { ZaicodeWorker } from "../src/zaicode/zaicodeWorkers.js";
import type { ZaicodeSessionBrief, ZaicodeContinueOptions } from "../src/zaicode/zaicodeContinue.js";
import type { ZaicodeServices } from "../src/zaicode/zaicodeServices.js";
import {
  composerQuotaFailureKind,
  noteComposerQuotaExhaustion,
  routeComposerSelection,
  vendorResetAtForProvider,
} from "../src/zaicode/zaicodeQuotaRoute.js";

/**
 * T-190 ORACLE -- the whole SRC-125 recovery path on one clock.
 *
 * The ticket asked to "prove the delayed handoff continues via the selected route and resumes
 * after the real vendor reset". Both halves used to fail that sentence for different reasons:
 *
 *  - the SCHEDULER half had no proof at all, because nothing tied the resume to the vendor's own
 *    reset time -- it waited a configured delay and then believed whatever it read next;
 *  - the COMPOSER half read no `resetAt` at any call site, so its hold was always the local
 *    15-minute doubling estimate, capped at six hours: a three-hour Claude window was retried
 *    on a guess, and a weekly plan was hammered every six hours.
 *
 * This file runs both halves against the SAME vendor clock: the reset the vendor states in its
 * own terminal line is the reset the snapshot carries, and it is the moment the work resumes.
 * Nothing here is a stub of the thing under test -- the detection, the continuation state
 * machine, the persistence, the ordered fallback and the circuit are all the production ones.
 *
 * What this is NOT: a live paid-vendor observation. The vendor bytes below are real vendor
 * wording, but they were typed by this test, not sent by Anthropic/OpenAI during a real
 * exhaustion. That observation stays a separate, tracked ticket; fabricating it here is exactly
 * what T-190's own acceptance forbids.
 */

const HOUR = 60 * 60_000;
const MINUTE = 60_000;
/** 2023-11-14T22:13:20Z -- an arbitrary but fixed instant, so no assertion drifts with the clock. */
const NOW = 1_700_000_000_000;
/** The vendor's own words: a three-hour session window, and the hour it opens again. */
const VENDOR_RESET_AT = NOW + 3 * HOUR;
/** Exactly what Claude Code prints on a hit session limit, in the vendor's own phrasing. */
const VENDOR_LINE = "You've hit your session limit · resets 7:40pm (Europe/Tallinn)";

const target = { key: "fixture", path: "C:/fixture", name: "fixture" };

const account = (id: string, vendor = "claude"): ZaicodeEngineAccount => ({
  id,
  short: id,
  label: id,
  vendor,
  source: "fixture",
  home: null,
  isDefaultHome: true,
  cli: vendor,
  status: "ready",
  statusDetail: "",
  fixCommand: null,
});

/** A real read: `remainingPercent` is what the vendor stated, `resetsAt` is the vendor's reset. */
const read = (
  id: string,
  fetchedAt: number,
  remainingPercent: number,
  resetsAt: number | null = VENDOR_RESET_AT,
): ZaicodeLimitSnapshot => ({
  accountId: id,
  windows: [{
    key: "five_hour",
    label: "5h",
    group: "",
    groupLabel: "",
    remainingPercent,
    resetsAt,
    durationMinutes: 300,
    gatedBy: null,
    assumedFull: false,
  }],
  plan: null,
  fetchedAt,
  checkedAt: fetchedAt,
  error: null,
  source: "fixture",
});

const modelView = {
  revision: 1,
  providers: [
    { providerId: "route", config: {}, models: [{ modelId: "SAIFREN", config: { optionSpecs: { reasoningLevel: { values: ["high"] } } } }] },
  ],
};

/**
 * A healthy selected subscription, then the vendor spends it mid-run -- the real order of
 * events. `limits` is mutated by the caller to move the vendor's clock.
 */
function fixture(limits: Record<string, ZaicodeLimitSnapshot> = {}) {
  let jobs = normalizeZaicodeContinuingJobs([{
    id: "j",
    projectPath: target.path,
    engineId: "C1",
    prompt: "/goal cc all",
    // C1 is the subscription the operator selected; C2 is the next selected one; the in-app
    // pool is last. The order IS the contract, so it is written out rather than implied.
    continuation: { enabled: true, runnerIds: ["C2", "pool:route/SAIFREN"], delayMinutes: 1, recoveryDelayMinutes: 1 },
  }]);
  jobs[0]!.continuationRuns = beginZaicodeContinuation(jobs[0]!, [target], "one", NOW);
  let workers: ZaicodeWorker[] = [];
  let sessions: ZaicodeSessionBrief[] = [];
  const launches: string[] = [];
  const stops: string[] = [];
  const pool: ZaicodeContinueOptions[] = [];
  const store: ZaicodeContinuationStore = {
    read: () => jobs,
    update: (id, patch) => { jobs = jobs.map((job) => job.id === id ? { ...job, ...patch } : job); },
    services: () => ({ modelSelection: { getView: async () => modelView } }) as unknown as ZaicodeServices,
  };
  const runtime: ZaicodeContinuationRuntime = {
    engines: () => ({
      accounts: [account("C1"), account("C2")],
      limits,
      config: normalizeZaicodeEnginesConfig(null),
      sweeping: false,
      probing: [],
      lastSweepAt: null,
      nextSweepAt: null,
    }),
    // A refresh that invents quota is the one thing this whole ticket exists to prevent.
    refresh: async () => { throw new Error("offline fixture; refresh never manufactures quota"); },
    workers: () => ({ workers, activeId: null, focusedId: null, soloId: null, open: false, panelMaximized: false }),
    launch: async (params) => {
      const worker: ZaicodeWorker = {
        id: params.workerId!,
        generation: params.generation ?? 1,
        accountId: params.account.id,
        vendor: params.account.vendor,
        short: params.account.short,
        label: params.account.label,
        projectPath: params.projectPath,
        projectName: "fixture",
        command: "fixture",
        prompt: params.prompt,
        startedAt: NOW,
        kind: "worker",
        exitCode: null,
        endedAt: null,
        placement: "panel",
        minimized: false,
        window: null,
        z: 0,
      };
      launches.push(worker.id);
      workers.push(worker);
      return { ok: true, worker, message: "launched" };
    },
    remove: (id, reason) => {
      assert.equal(reason, "schedule", "a continuation stop owns only its own replaced run");
      stops.push(id);
      workers = workers.filter((worker) => worker.id !== id);
    },
    sessions: () => sessions,
    handle: () => ({
      start: async (command, options) => {
        assert.deepEqual(command, { kind: "goal", objective: "cc all" });
        options?.onCreated?.("owned-session");
        pool.push(options!);
        // The in-app pool runs as a real session, so the brief has to exist: a run the
        // scheduler cannot see is a run it must leave alone.
        sessions = [{
          sessionId: "owned-session",
          projectKey: target.key,
          workspacePath: target.path,
          title: "owned",
          running: true,
          waiting: false,
          failed: false,
          interrupted: false,
          manuallyStopped: false,
          crashCut: false,
          updatedAt: NOW,
          model: "SAIFREN",
          unreadAt: null,
          goalStatus: "active",
          goalObjective: "cc all",
          foregroundExecutionId: "execution-one",
          foregroundStartedAt: NOW + MINUTE,
        }];
        return "owned-session";
      },
      send: async () => { throw new Error("Unexpected second input"); },
      stop: async (id, execution) => {
        assert.equal(id, "owned-session");
        assert.equal(execution, "execution-one", "only the schedule's own execution is stopped");
        stops.push(id);
        sessions = [];
      },
      clear: async () => undefined,
    }),
    disabled: () => false,
    terminal: () => null,
    main: () => null,
    setMain: () => undefined,
  };
  return {
    store,
    runtime,
    limits,
    launches,
    stops,
    pool,
    job: () => jobs[0]!,
    run: () => jobs[0]!.continuationRuns[0]!,
    worker: () => workers[0]!,
    /** Start on the healthy subscription, then let the vendor spend it -- the real order. */
    async hitLimit(alsoSpendNext = false): Promise<void> {
      const run = () => jobs[0]!.continuationRuns[0]!;
      await tickZaicodeContinuations(store, true, NOW, runtime);
      assert.equal(run().runnerId, "C1", "the selected subscription takes the work first");
      assert.equal(run().state, "running");
      limits.C1 = read("C1", NOW, 0);
      if (alsoSpendNext) limits.C2 = read("C2", NOW, 0);
      assert.equal(
        recordZaicodeContinuationWorkerLimit(store, workers[0]!, detectZaicodeVendorLimit("claude", VENDOR_LINE)!, NOW),
        true,
      );
      assert.equal(run().state, "waiting");
    },
  };
}

test("T-190 oracle: real vendor bytes are recognized as that vendor's limit, and nobody else's", () => {
  const signal = detectZaicodeVendorLimit("claude", VENDOR_LINE) as ZaicodeWorkerLimitSignal;
  assert.ok(signal, "the vendor's own limit line must be detected");
  assert.equal(signal.window, "five_hour");
  assert.equal(signal.resetText, "7:40pm (Europe/Tallinn)", "the vendor's reset wording is carried, not discarded");
  // The same words under another vendor's detector are not that vendor's limit.
  assert.equal(detectZaicodeVendorLimit("codex", VENDOR_LINE), null, "another vendor's wording is not evidence");
  // And prose that merely mentions a limit is still not evidence.
  assert.equal(detectZaicodeVendorLimit("claude", "The agent reports: you've hit your session limit"), null);
});

test("T-190 oracle: the detected signal blocks only the exact owned lease and is persisted first", async () => {
  const f = fixture({ C1: read("C1", NOW, 90), C2: read("C2", NOW, 90) });
  await tickZaicodeContinuations(f.store, true, NOW, f.runtime);
  assert.equal(f.run().runnerId, "C1", "the selected subscription takes the work");
  const signal = detectZaicodeVendorLimit("claude", VENDOR_LINE)!;
  // A worker that is not the run's own -- wrong generation -- must not touch it.
  assert.equal(
    recordZaicodeContinuationWorkerLimit(f.store, { ...f.worker(), generation: 99 }, signal, NOW),
    false,
    "a generation that is not the persisted one is not this run's worker",
  );
  assert.equal(f.run().state, "running", "the unowned observation changed nothing");

  f.limits.C1 = read("C1", NOW, 0);
  assert.equal(recordZaicodeContinuationWorkerLimit(f.store, f.worker(), signal, NOW), true);
  const run = f.run();
  assert.equal(run.state, "waiting", "the limit is persisted before anything is stopped");
  assert.deepEqual(run.blocked, [{
    runnerId: "C1",
    observedAt: NOW,
    window: "five_hour",
    resetText: "7:40pm (Europe/Tallinn)",
    line: VENDOR_LINE,
  }], "the vendor's own line and reset wording are kept, not reduced to a boolean");
  assert.equal(run.workerId, f.worker().id, "the blocked record still names the run it interrupted");
});

test("T-190 oracle: the handoff waits the delay, prefers the next selected subscription, and never claims a recovery it did not read", async () => {
  const f = fixture({ C1: read("C1", NOW, 90), C2: read("C2", NOW, 90) });
  await f.hitLimit();

  // Before the configured delay expires, nothing goes out.
  await tickZaicodeContinuations(f.store, true, NOW + MINUTE - 1, f.runtime);
  assert.deepEqual(f.launches.slice(1), [], "the handoff delay is real, not a rounding error");
  assert.equal(f.run().state, "waiting");

  // At the delay: C1 is blocked and C2 has fresh quota, so C2 is the ordered answer.
  await tickZaicodeContinuations(f.store, true, NOW + MINUTE, f.runtime);
  assert.equal(f.run().runnerId, "C2", "the next SELECTED subscription is tried before the free pool");
  assert.equal(f.run().state, "running");
});

test("T-190 oracle: with every subscription spent the chain reaches the in-app pool on the same lease", async () => {
  const f = fixture({ C1: read("C1", NOW, 90), C2: read("C2", NOW, 90) });
  await f.hitLimit(true); // C2 is spent too.
  const workerId = f.run().workerId;
  await tickZaicodeContinuations(f.store, true, NOW + MINUTE - 1, f.runtime);
  assert.deepEqual(f.launches.slice(1), []);
  await tickZaicodeContinuations(f.store, true, NOW + MINUTE, f.runtime);
  assert.equal(f.run().runnerId, "pool:route/SAIFREN", "the chain is walked in the configured order");
  assert.equal(f.pool.length, 1);
  assert.deepEqual(f.pool[0]!.modelSelection, { providerId: "route", modelId: "SAIFREN", options: { reasoningLevel: "high" } });
  assert.equal(f.pool[0]!.commandId, f.run().lease, "the same lease continues the project; no second MAIN is minted");
  assert.deepEqual(f.stops, [workerId], "only the schedule's own replaced run is stopped");
});

test("T-190 oracle: an unchanged reading is not a recovery -- the work waits for the vendor's reset", async () => {
  const f = fixture({ C1: read("C1", NOW, 90), C2: read("C2", NOW, 90) });
  await f.hitLimit(true);
  await tickZaicodeContinuations(f.store, true, NOW + MINUTE, f.runtime);
  assert.equal(f.run().runnerId, "pool:route/SAIFREN");

  // Polling all the way to the vendor's reset changes nothing: the reading is still 0%.
  for (const at of [NOW + 2 * HOUR, VENDOR_RESET_AT - MINUTE]) {
    f.limits.C1 = read("C1", at - MINUTE, 0);
    await tickZaicodeContinuations(f.store, true, at, f.runtime);
    assert.equal(f.run().runnerId, "pool:route/SAIFREN", `the fallback keeps the work at ${at - NOW}ms after the limit`);
  }
  assert.equal(f.launches.length, 1, "no churn: an unavailable subscription is not retried on every poll");
});

test("T-190 oracle: the work resumes on the vendor's reset, after the recovery delay, and only then", async () => {
  const f = fixture({ C1: read("C1", NOW, 90), C2: read("C2", NOW, 90) });
  await f.hitLimit(true);
  const workerId = f.run().workerId;
  await tickZaicodeContinuations(f.store, true, NOW + MINUTE, f.runtime);
  assert.equal(f.run().runnerId, "pool:route/SAIFREN");

  // A fresh read AT the vendor's reset is the first thing that can prove the refill.
  f.limits.C1 = read("C1", VENDOR_RESET_AT, 95);
  await tickZaicodeContinuations(f.store, true, VENDOR_RESET_AT, f.runtime);
  assert.equal(f.run().preferredReadyAt, VENDOR_RESET_AT + MINUTE, "recovery waits the configured recovery delay");

  await tickZaicodeContinuations(f.store, true, VENDOR_RESET_AT + MINUTE - 1, f.runtime);
  assert.equal(f.run().runnerId, "pool:route/SAIFREN", "not one millisecond early");

  await tickZaicodeContinuations(f.store, true, VENDOR_RESET_AT + MINUTE, f.runtime);
  assert.equal(f.run().runnerId, "C1", "the work returns to the subscription the operator selected");
  assert.equal(f.run().state, "running");
  assert.deepEqual(f.stops, [workerId, "owned-session"], "the exhausted worker and then the in-app fallback, each stopped once");
  assert.equal(f.launches.length, 2, "exactly one C1 worker is launched, and only at the vendor's reset");
  assert.equal(f.pool.length, 1, "the free pool is entered once and left once");
});

test("T-190 oracle: the composer half holds the SAME route to the SAME vendor clock, and says so", async () => {
  resetProviderQuotaCircuits();
  const limits = { C1: read("C1", NOW, 0), C2: read("C2", NOW, 90) };
  const accounts = [account("C1"), account("C2", "codex")];

  // The renderer proves the wall from the vendor's own error, and reads the same snapshot.
  assert.equal(composerQuotaFailureKind({ source: "provider", code: "1308", message: "[1308]Usage limit reached" }, null), "provider-limited");
  assert.equal(composerQuotaFailureKind({ source: "network", code: "429", message: "Too many requests" }, null), null, "a 429 is transport, not a spent plan");
  const resetAt = vendorResetAtForProvider({ providerId: "claude", accounts, limits, now: NOW });
  assert.equal(resetAt, VENDOR_RESET_AT, "the hold is the vendor's own reset, taken from the operator's own reading");
  assert.equal(
    noteComposerQuotaExhaustion({ providerId: "claude", kind: "provider-limited", now: NOW, failureId: "oracle", resetAt }),
    true,
  );

  // One hour in, a three-hour window is still in force -- a 15-minute estimate would be over.
  const held = providerQuotaCircuit("claude", NOW + HOUR);
  assert.ok(held, "a three-hour vendor window must not be retried after the 15-minute estimate");
  assert.equal(held.until, VENDOR_RESET_AT);
  assert.equal(held.resetSource, "vendor");

  // A hand-sent turn goes to the fallback and is told the hold is the vendor's, not a guess.
  const view = {
    revision: 1,
    preferredSelection: { providerId: "claude", modelId: "opus" },
    providers: [
      { providerId: "claude", models: [{ modelId: "opus" }] },
      { providerId: "route", providerName: "SAIRoute", models: [{ modelId: "SAIFREN" }] },
    ],
  };
  const routed = routeComposerSelection({ providerId: "claude", modelId: "opus" }, view, NOW + HOUR);
  assert.equal(routed.fallback, true);
  assert.deepEqual(routed.selection, { providerId: "route", modelId: "SAIFREN" });

  // At the vendor's reset the hold lapses and the requested route is used again, unasked.
  assert.equal(providerQuotaCircuit("claude", VENDOR_RESET_AT), null, "the hold ends on the vendor's clock");
  const restored = routeComposerSelection({ providerId: "claude", modelId: "opus" }, view, VENDOR_RESET_AT);
  assert.equal(restored.fallback, false);
  assert.deepEqual(restored.selection, { providerId: "claude", modelId: "opus" });
  resetProviderQuotaCircuits();
});

test("T-190 oracle: without a vendor reset the hold stays an estimate, and is labelled one", async () => {
  resetProviderQuotaCircuits();
  // Nothing read: the vendor stated no reset, so nothing may be claimed for it.
  assert.equal(vendorResetAtForProvider({ providerId: "claude", accounts: [account("C1")], limits: {}, now: NOW }), null);
  noteComposerQuotaExhaustion({ providerId: "claude", kind: "provider-limited", now: NOW, failureId: "no-read", resetAt: null });
  const estimated = providerQuotaCircuit("claude", NOW);
  assert.ok(estimated);
  assert.equal(estimated.resetSource, "estimated", "an unproven reset is never presented as a vendor one");
  assert.ok(estimated.until < VENDOR_RESET_AT, "the estimate is shorter than a real three-hour window would be");
  resetProviderQuotaCircuits();
});