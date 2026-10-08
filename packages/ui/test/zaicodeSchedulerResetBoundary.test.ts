import assert from "node:assert/strict";
import test from "node:test";
import {
  createZaicodeAutostartJob, evaluateZaicodeAutostartJob,
  markZaicodeWindowsStartingOnUse, zaicodeIdleWindowToStart,
  type ZaicodeLimitSnapshot, type ZaicodeLimitWindow,
} from "../../shared/src/zaicode-engines.js";

const reset = 1_800_000_000_000;
const accountId = "codex:fixture";
const window = (patch: Partial<ZaicodeLimitWindow> = {}): ZaicodeLimitWindow => ({
  key: "five_hour", label: "5h", group: "", groupLabel: "", remainingPercent: 25,
  resetsAt: reset, durationMinutes: 300, gatedBy: null, assumedFull: false, startsOnUse: false, ...patch,
});
const snapshot = (windows: ZaicodeLimitWindow[]): ZaicodeLimitSnapshot => ({
  accountId, windows, fetchedAt: reset + 5_000, plan: null, error: null,
});
const job = createZaicodeAutostartJob({ id: "boundary", projectPath: "C:/fixture", engineId: accountId, trigger: "everyReset" }, reset - 60_000);
const refreshed = () => markZaicodeWindowsStartingOnUse(
  [window({ resetsAt: reset + 300 * 60_000, remainingPercent: 99 })], reset + 5_000, null, [window()],
);

test("a quota read advancing the vendor reset before safety delay preserves one actual refill", () => {
  const next = snapshot(refreshed());
  const before = evaluateZaicodeAutostartJob(job, next, reset + 30_000);
  assert.equal(before.dueAt, reset + 60_000);
  assert.equal(before.state, "waiting-reset");
  const due = evaluateZaicodeAutostartJob(job, next, reset + 61_000);
  assert.equal(due.state, "due");
  assert.ok(due.eventId.endsWith(`:${reset}`));
  const consumed = evaluateZaicodeAutostartJob({ ...job, firedEvents: [due.eventId] }, next, reset + 62_000);
  assert.equal(consumed.state, "waiting-reset");
  assert.equal(consumed.dueAt, reset + 300 * 60_000 + 60_000);
});

test("an untouched new cycle does not erase the real previous cycle's refill", () => {
  const windows = markZaicodeWindowsStartingOnUse([window({ remainingPercent: 100 })], reset + 5_000, null, [window()]);
  assert.equal(windows[0]!.startsOnUse, true);
  assert.equal(evaluateZaicodeAutostartJob(job, snapshot(windows), reset + 61_000).state, "due");
});

test("the observed boundary survives another quota read and cache serialization, with catch-up expiry", () => {
  const cached = JSON.parse(JSON.stringify(refreshed())) as ZaicodeLimitWindow[];
  const reread = markZaicodeWindowsStartingOnUse([window({ resetsAt: reset + 300 * 60_000, remainingPercent: 98 })], reset + 40_000, null, cached);
  const due = evaluateZaicodeAutostartJob(job, snapshot(reread), reset + 61_000);
  assert.equal(due.state, "due");
  const missed = evaluateZaicodeAutostartJob(job, snapshot(reread), reset + 961_000);
  assert.equal(missed.state, "missed");
  assert.equal(missed.eventId, due.eventId);
  assert.equal(evaluateZaicodeAutostartJob(job, { ...snapshot(reread), accountId: "codex:other" }, reset + 61_000).state, "waiting-reset");
});

test("idle sliding timers and another quota pool cannot manufacture a reset occurrence", () => {
  const idle = markZaicodeWindowsStartingOnUse(
    [window({ remainingPercent: 100, resetsAt: reset + 5_000 + 300 * 60_000 })], reset + 5_000,
    null, [window({ remainingPercent: 100, startsOnUse: true })],
  );
  assert.equal(evaluateZaicodeAutostartJob(job, snapshot(idle), reset + 61_000).state, "waiting-reset");
  const otherPool = markZaicodeWindowsStartingOnUse(
    [window({ resetsAt: reset + 300 * 60_000 })], reset + 5_000, null, [window({ group: "other" })],
  );
  assert.equal(evaluateZaicodeAutostartJob(job, snapshot(otherPool), reset + 61_000).dueAt, reset + 300 * 60_000 + 60_000);
});

test("a metrics-only Antigravity identity never starts the local login under another account name", () => {
  const params = {
    account: { id: "agy:plane", vendor: "antigravity" as const, status: "ready" as const, planeOnly: true },
    snapshot: { ...snapshot([window({ startsOnUse: true, remainingPercent: 100 })]), accountId: "agy:plane" },
    config: { keepWindowsRolling: true, hiddenAccounts: [] }, now: reset + 5_000,
  };
  assert.equal(zaicodeIdleWindowToStart(params), null);
  assert.equal(zaicodeIdleWindowToStart({ ...params, account: { ...params.account, planeOnly: false } })?.key, "five_hour");
});
