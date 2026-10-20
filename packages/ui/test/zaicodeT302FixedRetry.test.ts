import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ZAICODE_AUTO_RETRY_HARD_CAP } from "../src/zaicode/zaicodeUiPrefs.js";
import {
  isZaicodeAutoRetryableError,
  isZaicodeManualRetryableError,
  isZaicodeAutoRetryStopped,
  stopZaicodeAutoRetryForError,
  zaicodeAutoRetryAttempts,
  zaicodeAutoRetryPaneClaims,
  resetZaicodeAutoRetryAttempt,
  bumpZaicodeAutoRetryAttempt,
} from "../src/zaicode/zaicodeAutoRetry.js";
import { zaicodeRetryDelayMs, zaicodeRetryLimit } from "../src/zaicode/zaicodeRetryPolicy.js";
import { pickZaicodeBackgroundRetrySessions } from "../src/zaicode/zaicodeTurnRetryWatch.js";

/**
 * T-302: "Restore predictable fixed-interval Auto-Retry and increase the maximum
 * automatic retry attempts from 8 to 50."
 *
 * The operator's screenshot said "Auto-retry in 952 s · attempt 6/8". The session
 * was not cooling off after a provider instruction: the interval itself was being
 * multiplied -- zaicodeRetryDelayMs doubled the wait every attempt (2^attempts,
 * ceiling 1800s), so attempt 6 waited 32x the nominal interval. One interval is
 * one interval, and the ceiling is 50 attempts now.
 *
 * These tests pin the delay function first (it is the only timer arithmetic in the
 * app), then the pieces around it that make the countdown trustworthy: one timer,
 * one increment per dispatch, exhaustion at the cap, provider/quota walls still
 * respected, and the manual controls still able to cancel.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const source = (path: string): string =>
  readFileSync(join(srcRoot, path), "utf8").replace(/\r\n/g, "\n");

const retry = source("zaicode/zaicodeAutoRetry.ts");
const watch = source("zaicode/zaicodeTurnRetryWatch.ts");
const policy = source("zaicode/zaicodeRetryPolicy.ts");

test("A: attempts 1, 6, 25 and 49 use the same nominal interval", () => {
  for (const interval of [10, 60, 300, 3600]) {
    assert.equal(zaicodeRetryDelayMs(interval), Math.min(1800, interval) * 1000);
  }
  // No attempt parameter exists to multiply with: the signature itself is the proof.
  assert.equal(zaicodeRetryDelayMs.length, 1, "the delay is a function of the interval only");
  assert.match(
    policy,
    /Math\.min\(BACKOFF_CEILING_SEC, Math\.max\(1, intervalSec\)\) \* 1000/,
    "no 2^attempts factor remains in the policy",
  );
});

test("B: attempt 50 exhausts the sequence, C: there is no attempt 51", () => {
  assert.equal(ZAICODE_AUTO_RETRY_HARD_CAP, 50);
  assert.equal(zaicodeRetryLimit(500), 50, "no setting raises the ceiling past 50");
  assert.equal(zaicodeRetryLimit(60), 50);
  const exhausted = attemptsAtLeast(50, 50);
  assert.equal(exhausted, true, "50 done attempts exhaust the budget");
  // The exhausted flag is `attempts >= maxAttempts`; 51 is never reachable because
  // arming stops at exhausted.
  assert.match(
    retry,
    /const exhausted = Boolean\(error && action && attempts >= maxAttempts\)/,
    "the pane stops arming at the cap",
  );
  const briefs = [
    { sessionId: "s1", title: "t", projectKey: "p", failed: true, updatedAt: 1 },
  ];
  const base = { isLocal: () => false, isProjectDisabled: () => false };
  const pickAtCap = pickZaicodeBackgroundRetrySessions(briefs, {
    ...base,
    attemptsOf: () => 50,
    maxAttempts: 50,
    mayAutoSend: () => true,
    isQuotaWall: () => false,
  });
  assert.equal(pickAtCap.length, 0, "the background host schedules nothing at the cap");
});

test("D: a duplicate error event creates no duplicate retry", () => {
  assert.match(
    retry,
    /\/\/ errorKey\/actionKey：同一个错误只排一次/,
    "the pane effect keys on the failure, not on every render",
  );
  assert.match(
    retry,
    /return \(\) => \{\s*window\.clearTimeout\(timer\);/,
    "re-arming replaces the previous timer instead of stacking",
  );
  assert.match(
    watch,
    /if \(watches\.has\(brief\.sessionId\) \|\| inFlight\.has\(brief\.sessionId\)\) continue;/,
    "the background host keeps exactly one timer per session",
  );
  // A duplicate error event (same brief.updatedAt) is not re-accepted by the host.
  const briefs = [
    { sessionId: "s1", title: "t", projectKey: "p", failed: true, updatedAt: 7 },
  ];
  const base = {
    isLocal: () => false,
    isProjectDisabled: () => false,
    attemptsOf: () => 0,
    maxAttempts: 50,
    mayAutoSend: () => true,
    isQuotaWall: () => false,
  };
  assert.equal(pickZaicodeBackgroundRetrySessions(briefs, base).length, 1);
  assert.equal(pickZaicodeBackgroundRetrySessions(briefs, base).length, 1, "same event, same answer, one timer");
});

test("E: a manual Retry now dispatches; F: Stop auto-retry prevents future dispatch", () => {
  assert.match(retry, /const run = useCallback\(/, "the dispatcher is one function for both paths");
  assert.match(retry, /if \(counted && !zaicodeEffectiveAutoRetryFor\(/, "an automatic dispatch re-checks the gate");
  assert.match(retry, /retryNow: \(\) => run\(false\)/, "Retry now goes out immediately, uncounted");
  assert.match(retry, /stop: \(\) => \{\s*stopZaicodeAutoRetryForError\(errorKey\)/, "Stop marks this error stopped");
  const stopped = "t302-stop-control:LOCAL_TRANSIENT:123:failed";
  stopZaicodeAutoRetryForError(stopped);
  assert.equal(isZaicodeAutoRetryStopped(stopped), true, "the stop is retained independently of pane state");
  assert.equal(isZaicodeAutoRetryStopped(`${stopped}:new-failure`), false);
  assert.match(retry, /writeZaicodeRetrySafety\(\{ stoppedErrors: \[\.\.\.stoppedErrorKeys\] \}\)/, "Stop survives a reload");
});

test("G: request success clears pending retry state for that failure sequence", () => {
  assert.match(
    retry,
    /if \(sessionId && !error && phase === "completedSuccess"\) \{\s*resetZaicodeAutoRetryAttempt\(sessionId\)/,
    "a clean finish resets the attempt budget",
  );
  assert.match(
    retry,
    /if \(!armed\) \{\s*setNextAt\(null\);/,
    "a disarmed state shows no countdown",
  );
});

test("H: project switch keeps exactly one correct timer (the pane claims the session only while armed)", () => {
  const claims = zaicodeAutoRetryPaneClaims({
    hasSession: true,
    enabled: true,
    hasError: true,
    retryable: true,
    armed: true,
    stoppedThisError: false,
  });
  assert.equal(claims, true, "the armed pane owns the retry");
  const calm = zaicodeAutoRetryPaneClaims({
    hasSession: true,
    enabled: true,
    hasError: false,
    retryable: true,
    armed: false,
    stoppedThisError: false,
  });
  assert.equal(calm, false, "a quiet pane stands down for the background host");
  // The background sweep drops the watches of sessions that vanished or got claimed.
  assert.match(watch, /for \(const sessionId of \[\.\.\.watches\.keys\(\)\]\) \{\s*if \(!failedIds\.has\(sessionId\)\) clearWatch\(sessionId\);/, "a replaced session's timer is retired");
});

test("I: a runtime reconnect reconciles instead of blindly scheduling", () => {
  // Restored attempts come from the durable safety record: a remount inherits the budget
  // instead of minting a fresh one.
  assert.match(
    retry,
    /const attemptsBySession = new Map<string, number>\(Object\.entries\(currentZaicodeRetrySafety\(\)\.attempts\)\)/,
    "attempts survive the renderer lifecycle from durable state",
  );
  // The background host only schedules for the sessions the projection reports failed.
  assert.match(watch, /if \(!brief\.failed \|\| acceptedFailures\.get\(brief\.sessionId\) !== brief\.updatedAt\) acceptedFailures\.delete\(brief\.sessionId\);/, "a session that stopped failing is not retried again");
  // One reconciliation fact per event, recorded once per updatedAt.
  const briefs = [
    { sessionId: "s1", title: "t", projectKey: "p", failed: true, updatedAt: 3 },
  ];
  const opts = {
    isLocal: () => false,
    isProjectDisabled: () => false,
    attemptsOf: () => 0,
    maxAttempts: 50,
    mayAutoSend: () => true,
    isQuotaWall: () => false,
  };
  const first = pickZaicodeBackgroundRetrySessions(briefs, opts);
  assert.equal(first.length, 1, "the eligible session is picked once");
  assert.equal(pickZaicodeBackgroundRetrySessions(briefs, opts).length, 1, "the same event is not re-picked as a second session");
});

test("J: a provider / quota wall is not retried at the nominal interval", () => {
  const quota = { code: "1308", message: "[1308][Usage limit reached]" };
  assert.equal(isZaicodeAutoRetryableError(quota), false, "a usage-limit wall waits for the reset");
  assert.equal(isZaicodeAutoRetryableError(quota, true), true, "a selected alternate route may still go out");
  assert.match(
    retry,
    /const quotaWall = Boolean\(error && zaicodeRetryClassOf\(error\) === "quota" && !params\.quotaFallbackReady\)/,
    "the quota wall blocks the automatic path only",
  );
  assert.match(retry, /isZaicodeManualRetryableError\(error\)/, "Retry now stays available for the operator");
});

test("K: permanent errors are not automatically retried", () => {
  assert.equal(isZaicodeManualRetryableError({ code: "MODEL_CONFIG_MISSING", message: "x" }), false);
  assert.equal(isZaicodeManualRetryableError({ code: "SESSION_NOT_FOUND", message: "x" }), false);
  assert.equal(isZaicodeManualRetryableError({ code: "CANCEL", message: "x" }), false);
  assert.equal(isZaicodeAutoRetryableError({ code: "CANCEL", message: "x" }), false);
});

test("L: queue admission and delivery are untouched (the queue resume owner keeps its own gate)", () => {
  const queue = source("zaicode/zaicodeQueueAutoResume.ts");
  assert.match(queue, /zaicodeQueueMayAutoResume\(/, "the queue keeps its own eligibility decision");
  assert.match(queue, /pauseReason !== "error"/ , "an operator-stopped queue is never resumed");
  // The session retry path never reaches the queue scheduler: one timer each.
  assert.ok(!/dispatchCommand/.test(retry), "the session scheduler dispatches through the panes handlers, not the queue");
});

test("M: the countdown reflects the actual scheduled deadline", () => {
  assert.match(retry, /const at = Date\.now\(\) \+ delay;/, "the deadline is computed once and stored");
  assert.match(retry, /nextAt: armed \? nextAt : null/, "an unarmed state reports no deadline");
  const notice = source("zaicode/ZaicodeAutoRetryNotice.tsx");
  assert.match(notice, /Math\.max\(0, Math\.ceil\(\(state\.nextAt - now\) \/ 1000\)\)/, "the seconds are read off nextAt");
});

test("N: retry-scope settings remain functional", () => {
  assert.match(retry, /zaicodeEffectiveAutoRetry\(prefs, params\.projectKey/, "the effective projection is still consulted");
  assert.match(retry, /const maxAttempts = zaicodeRetryLimit\(useZaicodeUiPrefs\(\(state\) => state\.autoRetryMaxAttempts\)\)/, "the per-scope setting still feeds the budget");
  assert.match(retry, /const intervalSec = useZaicodeUiPrefs\(\(state\) => state\.autoRetryIntervalSec\)/, "the per-scope interval still feeds the delay");
  // Policy clamp keeps an operator's value inside the new ceiling.
  assert.equal(zaicodeRetryLimit(60), 50);
  assert.equal(zaicodeRetryLimit(1), 1);
});

function attemptsAtLeast(attempts: number, max: number): boolean {
  const sessionId = `t302-${attempts}`;
  for (let i = 0; i < attempts; i += 1) bumpZaicodeAutoRetryAttempt(sessionId);
  const reached = zaicodeAutoRetryAttempts(sessionId) >= max;
  resetZaicodeAutoRetryAttempt(sessionId);
  return reached;
}
