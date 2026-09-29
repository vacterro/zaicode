import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  isZaicodeAutoRetryableError,
  isZaicodeManualRetryableError,
} from "../src/zaicode/zaicodeAutoRetry.js";
import {
  ZAICODE_AUTO_RETRY_HARD_CAP,
  clearZaicodeQuotaWall,
  isZaicodeQuotaWall,
  markZaicodeQuotaWall,
  useZaicodeRetryLedger,
  zaicodeAutoSendAllowed,
  zaicodeMayAutoSend,
  zaicodeRetryClassOf,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
} from "../src/zaicode/zaicodeRetryPolicy.js";
import { pickZaicodeBackgroundRetrySessions } from "../src/zaicode/zaicodeTurnRetryWatch.js";
import { normalizeZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import type { ZaicodeSessionBrief } from "../src/zaicode/zaicodeContinue.js";

// SRC-082: "it knocks on an empty door with no limits, nowhere to turn it off or watch it,
// even with auto continue off. That is a hole."

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

test("a usage limit is a wall, an empty answer is a hiccup", () => {
  assert.equal(zaicodeRetryClassOf({ code: "1308", message: "anything" }), "quota");
  assert.equal(zaicodeRetryClassOf({ code: "PROVIDER_BUSINESS_ERROR", message: "[1308][Usage limit reached for 5 hour. Your limit will reset at 20:12]" }), "quota");
  assert.equal(zaicodeRetryClassOf({ code: "x", message: "insufficient balance" }), "quota");
  assert.equal(zaicodeRetryClassOf({ code: "MODEL_EMPTY", message: "The model returned no content" }), "transient");
  assert.equal(zaicodeRetryClassOf({ code: "NETWORK", message: "socket hang up" }), "transient");
  // A quota error is never retried by itself, and is still retryable by hand.
  const quota = { code: "1308", message: "Usage limit reached for 5 hour" };
  assert.equal(isZaicodeAutoRetryableError(quota), false);
  assert.equal(isZaicodeManualRetryableError(quota), true);
  const empty = { code: "MODEL_EMPTY", message: "The model returned no content" };
  assert.equal(isZaicodeAutoRetryableError(empty), true);
  // Errors no retry can fix stay unfixable both ways.
  assert.equal(isZaicodeManualRetryableError({ code: "MODEL_CONFIG_MISSING", message: "" }), false);
});

test("the count is capped no matter what the setting says, and the wait doubles", () => {
  assert.equal(ZAICODE_AUTO_RETRY_HARD_CAP, 8);
  assert.equal(zaicodeRetryLimit(1000), 8);
  assert.equal(zaicodeRetryLimit(100), 8);
  assert.equal(zaicodeRetryLimit(3), 3);
  assert.equal(zaicodeRetryLimit(0), 1);
  assert.deepEqual([0, 1, 2, 3].map((attempts) => zaicodeRetryDelayMs(60, attempts) / 1000), [60, 120, 240, 480]);
  assert.equal(zaicodeRetryDelayMs(60, 40) / 1000, 1800, "never longer than half an hour between two attempts");
  // A saved 100 (the old default) is clamped on load, and the new default is small.
  assert.equal(normalizeZaicodeUiPrefs({ autoRetryMaxAttempts: 100 }).autoRetryMaxAttempts, 8);
  assert.equal(normalizeZaicodeUiPrefs({}).autoRetryMaxAttempts, 5);
});

test("who may send by itself: a session's Off wins, On lets it, otherwise Auto AND the switch", () => {
  const cases: [Parameters<typeof zaicodeMayAutoSend>[0], boolean][] = [
    [{ mode: "off", masterOn: true, featureOn: true }, false],
    [{ mode: "on", masterOn: false, featureOn: false }, true],
    [{ mode: "default", masterOn: false, featureOn: true }, false],
    [{ mode: "default", masterOn: true, featureOn: false }, false],
    [{ mode: "default", masterOn: true, featureOn: true }, true],
    [{ mode: undefined, masterOn: false, featureOn: true }, false],
  ];
  for (const [input, expected] of cases) assert.equal(zaicodeMayAutoSend(input), expected, JSON.stringify(input));
  // Nothing is loaded in this process: the sidebar Auto reads OFF, so nothing goes out.
  assert.equal(zaicodeAutoSendAllowed("s-1", true), false);
});

const brief = (patch: Partial<ZaicodeSessionBrief>): ZaicodeSessionBrief => ({
  sessionId: "s", title: "t", projectKey: "p", workspacePath: "V:/p", running: false, waiting: false, failed: true,
  interrupted: false, manuallyStopped: false, crashCut: false, updatedAt: 1, model: null, unreadAt: null, goalStatus: null, goalObjective: null,
  ...patch,
});

test("the background host picks nothing that the switches forbid or that hit a quota wall", () => {
  const base = { isLocal: () => false, isProjectDisabled: () => false, attemptsOf: () => 0, maxAttempts: 5 };
  const briefs = [brief({ sessionId: "a" }), brief({ sessionId: "b" }), brief({ sessionId: "c" })];
  assert.equal(pickZaicodeBackgroundRetrySessions(briefs, base).length, 3, "no gate given: unchanged behaviour");
  const gated = pickZaicodeBackgroundRetrySessions(briefs, { ...base, mayAutoSend: (id) => id !== "a", isQuotaWall: (id) => id === "b" });
  assert.deepEqual(gated.map((item) => item.sessionId), ["c"]);
  assert.equal(pickZaicodeBackgroundRetrySessions(briefs, { ...base, attemptsOf: () => 5 }).length, 0, "the budget is spent");
});

test("a quota wall is remembered for half an hour, then one probe may go out", () => {
  markZaicodeQuotaWall("q", 1_000);
  assert.equal(isZaicodeQuotaWall("q", 1_000 + 29 * 60_000), true);
  assert.equal(isZaicodeQuotaWall("q", 1_000 + 31 * 60_000), false);
  markZaicodeQuotaWall("q2", 5);
  clearZaicodeQuotaWall("q2");
  assert.equal(isZaicodeQuotaWall("q2", 6), false);
});

test("the ledger shows what is scheduled and one halt stops every automatic send", () => {
  const ledger = useZaicodeRetryLedger.getState();
  ledger.clearAll();
  ledger.resume();
  ledger.set({ sessionId: "x", title: "PHASE SCOUT", nextAt: 10, attempt: 2, source: "background" });
  assert.equal(Object.keys(useZaicodeRetryLedger.getState().pending).length, 1);
  useZaicodeRetryLedger.getState().halt();
  assert.deepEqual(useZaicodeRetryLedger.getState().pending, {});
  assert.equal(useZaicodeRetryLedger.getState().halted, true);
  assert.equal(zaicodeAutoSendAllowed("x", true), false, "halted: not even a session set to On sends");
  useZaicodeRetryLedger.getState().resume();
  assert.equal(useZaicodeRetryLedger.getState().halted, false);
});

test("wiring: the chat countdown, the background host and the crash resume all ask the policy; the sidebar shows the ledger", () => {
  const retry = source("zaicode/zaicodeAutoRetry.ts");
  assert.match(retry, /zaicodeMayAutoSend\(/);
  assert.match(retry, /zaicodeRetryDelayMs\(/);
  assert.match(retry, /zaicodeRetryLimit\(/);
  assert.match(retry, /blockedBy === null/);
  const watch = source("zaicode/zaicodeTurnRetryWatch.ts");
  assert.match(watch, /zaicodeAutoSendAllowed\(brief\.sessionId/, "asked again at the moment of sending");
  assert.match(watch, /isZaicodeQuotaWall\(brief\.sessionId\)/);
  assert.doesNotMatch(watch, /if \(!prefs\.autoRetry\) return;/, "the old switch-only early out is gone");
  const crash = source("zaicode/zaicodeCrashResume.ts");
  assert.match(crash, /masterOn: zaicodeMasterAutoOn\(\)/);
  assert.doesNotMatch(crash, /zaicodeAutoContinueAllowed\(/);
  assert.match(source("zaicode/ZaicodeSessionActionStrip.tsx"), /<ZaicodeRetryLedgerChip \/>/);
  assert.match(source("zaicode/ZaicodeAutoRetryNotice.tsx"), /data-zaicode-retry-blocked="quota"/);
});
