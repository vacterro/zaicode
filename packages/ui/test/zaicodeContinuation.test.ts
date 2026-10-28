import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZaicodeContinuingJobs, decideZaicodeContinuation, markZaicodeContinuationLimit, zaicodeContinuationHasQuota, type ZaicodeContinuationRun, type ZaicodeEngineAccount, type ZaicodeLimitSnapshot } from "@zcode/shared";

const now = 10_000_000;
const account = (id: string): ZaicodeEngineAccount => ({ id, short: id, label: id, vendor: "codex", source: "fixture", home: null, isDefaultHome: true, cli: "codex", status: "ready", statusDetail: "", fixCommand: null });
const quota = (id: string, percent = 90, fetchedAt = now): ZaicodeLimitSnapshot => ({ accountId: id, source: "vendor", plan: "fixture", fetchedAt, checkedAt: fetchedAt, error: null, windows: [{ key: "five_hour", label: "5h", group: "", groupLabel: "", remainingPercent: percent, resetsAt: now - 1, durationSeconds: 18_000, assumedFull: false }] });
const job = () => normalizeZaicodeContinuingJobs([{ id: "j", engineId: "C1", projectPath: "C:/fixture", continuation: { enabled: true, runnerIds: ["C2", "pool:route/SAIFREN"], delayMinutes: 2, returnToPreferred: true, recoveryDelayMinutes: 1 } }])[0]!;
const run = (): ZaicodeContinuationRun => ({ projectPath: "C:/fixture", workspaceKey: "w", occurrence: "interval:one", runnerId: "C1", lease: "lease", state: "running", workerId: "worker:one", generation: 1, blocked: [], nextAt: now, launchedAt: now - 1000, result: "" });
const input = () => ({ job: job(), run: run(), accounts: [account("C1"), account("C2")], limits: { C1: quota("C1"), C2: quota("C2") }, availablePools: new Set(["pool:route/SAIFREN"]), now, autopilot: true, enabled: true, projectDisabled: false, stopDue: false });

test("ordered fallback waits the chosen delay, and unknown quota cannot clear the observed limit", () => {
  const i = input();
  i.run = markZaicodeContinuationLimit(i.run, { window: "five_hour", resetText: "in 1 hour" }, now, 2);
  assert.equal(decideZaicodeContinuation(i).action, "wait");
  i.now += 120_000;
  assert.deepEqual(decideZaicodeContinuation(i), { action: "switch", runnerId: "C2" });
  i.limits.C2 = quota("C2", 0);
  assert.deepEqual(decideZaicodeContinuation(i), { action: "switch", runnerId: "pool:route/SAIFREN" });
  i.availablePools.clear();
  assert.equal(decideZaicodeContinuation(i).action, "wait");
});

test("a passed reset, stale, failed, assumed, and unknown windows prove no recovery", () => {
  const good = quota("C1");
  assert.equal(zaicodeContinuationHasQuota(good, now), true);
  for (const q of [quota("C1", 0), quota("C1", 90, now - 600_000), { ...good, error: "offline" }, { ...good, windows: [] }, { ...good, windows: [{ ...good.windows[0]!, assumedFull: true }] }, { ...good, windows: [{ ...good.windows[0]!, remainingPercent: null }] }]) assert.equal(zaicodeContinuationHasQuota(q, now), false);
  assert.equal(zaicodeContinuationHasQuota(good, now, now), false);
});

test("fresh recovery arms once, waits, then returns; failed refresh cancels the pending return", () => {
  const i = input();
  i.run = { ...run(), runnerId: "pool:route/SAIFREN", workerId: undefined, sessionId: "s", blocked: [{ runnerId: "C1", observedAt: now - 1000, window: "five_hour", resetText: null }] };
  assert.deepEqual(decideZaicodeContinuation(i), { action: "arm-return", at: now + 60_000 });
  i.run.preferredReadyAt = now + 60_000;
  assert.equal(decideZaicodeContinuation(i).action, "wait");
  i.now += 60_000;
  assert.deepEqual(decideZaicodeContinuation(i), { action: "switch", runnerId: "C1" });
  i.limits.C1 = { ...quota("C1"), error: "offline" };
  assert.deepEqual(decideZaicodeContinuation(i), { action: "cancel-return" });
});

test("pause, disable, cancellation and completion prevent automatic launch; stop time remains effective", () => {
  for (const patch of [{ autopilot: false }, { enabled: false }, { projectDisabled: true }]) assert.equal(decideZaicodeContinuation({ ...input(), ...patch, run: { ...run(), state: "pending" } }).action, "wait");
  for (const state of ["complete", "stopped"] as const) assert.equal(decideZaicodeContinuation({ ...input(), run: { ...run(), state } }).action, "none");
  assert.equal(decideZaicodeContinuation({ ...input(), autopilot: false, stopDue: true }).action, "stop");
});

test("continuation survives restart in the existing job, deduplicates runner order and rejects malformed storage", () => {
  const persisted = { ...job(), continuationRuns: [markZaicodeContinuationLimit(run(), { window: "weekly", resetText: "Monday" }, now, 2)] };
  assert.deepEqual(normalizeZaicodeContinuingJobs(JSON.parse(JSON.stringify([persisted])))[0], JSON.parse(JSON.stringify(persisted)));
  const malformed = normalizeZaicodeContinuingJobs([{ ...persisted, continuationRuns: [{ lease: "missing ownership" }] }])[0]!;
  assert.equal(malformed.continuation.enabled, false);
  assert.match(malformed.lastResult, /invalid/);
});
