import assert from "node:assert/strict";
import test from "node:test";
import {
  bumpZaicodeAutoRetryAttempt,
  clearZaicodeAutoRetryStoppedForSession,
  isZaicodeAutoRetryStopped,
  isZaicodeAutoRetryStoppedForSession,
  resetZaicodeAutoRetryAttempt,
  stopZaicodeAutoRetryForError,
  zaicodeAutoRetryAttempts,
} from "../src/zaicode/zaicodeAutoRetry.js";
import {
  clearZaicodeQuotaWall,
  isZaicodeQuotaWall,
  markZaicodeQuotaWall,
  useZaicodeRetryLedger,
} from "../src/zaicode/zaicodeRetryPolicy.js";
import {
  ZAICODE_RETRY_SAFETY_STORAGE_KEY,
  clearZaicodeRetrySafety,
  readZaicodeRetrySafety,
} from "../src/zaicode/zaicodeRetrySafety.js";
import { pickZaicodeBackgroundRetrySessions } from "../src/zaicode/zaicodeTurnRetryWatch.js";
import type { ZaicodeSessionBrief } from "../src/zaicode/zaicodeContinue.js";

// SRC-161:W2-002 — every way the operator stops the automatic senders must reach the durable
// record, not just module memory. These cases watch the record the way the next renderer will.

const raw = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => raw.get(key) ?? null,
  setItem: (key: string, value: string) => void raw.set(key, value),
  removeItem: (key: string) => void raw.delete(key),
};

test.beforeEach(() => {
  clearZaicodeRetrySafety();
  raw.clear();
  useZaicodeRetryLedger.setState({ pending: {}, halted: false });
});

test("W2-002: stop-all is written before it is shown, so a reload cannot undo it", () => {
  assert.equal(raw.has(ZAICODE_RETRY_SAFETY_STORAGE_KEY), false);
  useZaicodeRetryLedger.getState().halt();
  assert.equal(readZaicodeRetrySafety().halted, true, "the record already says stopped");

  useZaicodeRetryLedger.getState().resume();
  assert.equal(readZaicodeRetrySafety().halted, false, "allowing again is recorded too");
});

test("W2-002: the attempt budget and the closed errors are recorded as they happen", () => {
  bumpZaicodeAutoRetryAttempt("s1");
  bumpZaicodeAutoRetryAttempt("s1");
  bumpZaicodeAutoRetryAttempt("s2");
  assert.equal(zaicodeAutoRetryAttempts("s1"), 2);
  assert.deepEqual(readZaicodeRetrySafety().attempts, { s1: 2, s2: 1 });

  // A clean turn clears the budget for that session only.
  resetZaicodeAutoRetryAttempt("s1");
  assert.deepEqual(readZaicodeRetrySafety().attempts, { s2: 1 });
  assert.equal(zaicodeAutoRetryAttempts("s1"), 0);

  stopZaicodeAutoRetryForError("err-1");
  assert.equal(isZaicodeAutoRetryStopped("err-1"), true);
  assert.deepEqual(readZaicodeRetrySafety().stoppedErrors, ["err-1"]);
  // No error key means nothing to record; an empty key must never enter the record.
  stopZaicodeAutoRetryForError(null);
  assert.deepEqual(readZaicodeRetrySafety().stoppedErrors, ["err-1"]);
});

test("T-240: a persisted stopped failure denies background work without blocking another session or a new accepted attempt", () => {
  const a = "stop-episode-a", b = "stop-episode-b";
  const key = `${a}:LOCAL_TRANSIENT:100:failed`;
  stopZaicodeAutoRetryForError(key);
  assert.equal(isZaicodeAutoRetryStoppedForSession(a), true);
  assert.equal(isZaicodeAutoRetryStoppedForSession(b), false);
  const briefs = [a, b].map((sessionId) => ({
    sessionId, projectKey: "p", failed: true, running: false, waiting: false,
  })) as ZaicodeSessionBrief[];
  const options = {
    isLocal: () => false, isProjectDisabled: () => false, attemptsOf: () => 0,
    maxAttempts: 2, isStopped: isZaicodeAutoRetryStoppedForSession,
  };
  assert.deepEqual(pickZaicodeBackgroundRetrySessions(briefs, options).map((brief) => brief.sessionId), [b]);
  clearZaicodeAutoRetryStoppedForSession(a);
  assert.equal(isZaicodeAutoRetryStopped(key), false);
  assert.equal(readZaicodeRetrySafety().stoppedErrors.includes(key), false);
  assert.deepEqual(pickZaicodeBackgroundRetrySessions(briefs, options).map((brief) => brief.sessionId), [a, b]);
  stopZaicodeAutoRetryForError(`${a}:LOCAL_TRANSIENT:200:next failure`);
  resetZaicodeAutoRetryAttempt(b);
  assert.equal(isZaicodeAutoRetryStoppedForSession(a), true, "another session finishing cannot authorize this one");
  resetZaicodeAutoRetryAttempt(a);
  assert.equal(isZaicodeAutoRetryStoppedForSession(a), false, "a clean finish retires the previous failed episode");
});

test("W2-002: a quota wall is recorded and lifted in the same record", () => {
  markZaicodeQuotaWall("s1", 1_000);
  assert.deepEqual(readZaicodeRetrySafety().quotaWalls, { s1: 1_000 });
  assert.equal(isZaicodeQuotaWall("s1", 1_100), true);

  clearZaicodeQuotaWall("s1");
  assert.deepEqual(readZaicodeRetrySafety().quotaWalls, {});
  assert.equal(isZaicodeQuotaWall("s1", 1_100), false);
  // Lifting a wall nobody set must not write a pointless record.
  assert.equal(raw.has(ZAICODE_RETRY_SAFETY_STORAGE_KEY), true);
});

test("W2-002: the record is bounded, so a long-lived profile cannot grow without limit", async () => {
  const { writeZaicodeRetrySafety } = await import("../src/zaicode/zaicodeRetrySafety.js");
  const attempts: Record<string, number> = {};
  for (let index = 0; index < 60; index += 1) attempts[`s${index}`] = 1;
  writeZaicodeRetrySafety({ attempts });
  const kept = Object.keys(readZaicodeRetrySafety().attempts);
  assert.equal(kept.length, 50);
  assert.equal(kept[kept.length - 1], "s59", "the newest sessions are the ones kept");

  const stopped = Array.from({ length: 60 }, (_, index) => `e${index}`);
  writeZaicodeRetrySafety({ stoppedErrors: stopped });
  assert.equal(readZaicodeRetrySafety().stoppedErrors.length, 40);
});
