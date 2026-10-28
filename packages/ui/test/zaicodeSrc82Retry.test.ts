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
  zaicodeAutoRetryAllowedFor,
  zaicodeEffectiveAutoRetry,
  zaicodeRetryClassOf,
  zaicodeRetryDelayMs,
  zaicodeRetryLimit,
  type ZaicodeAutoRetryPrefs,
} from "../src/zaicode/zaicodeRetryPolicy.js";
import { useZaicodeAuditStore } from "../src/zaicode/zaicodeAuditStore.js";
import { planZaicodeCrashResume } from "../src/zaicode/zaicodeCrashResume.js";
import { useZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
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

test("who may send by itself: one effective projection, and the operator's explicit OFF wins", () => {
  // T-231/T-234: the two-gate split brain (zaicodeMayAutoSend let a session's On win even with
  // the feature off, and ignored per-project retry OFF) is gone. There is one answer, and every
  // autonomous-send owner asks it.
  const prefs: ZaicodeAutoRetryPrefs = {
    autoRetry: true,
    autoRetryScope: "global",
    autoRetryProjects: {},
    autoRetrySessions: {},
  };
  const at = (
    patch: Partial<ZaicodeAutoRetryPrefs>,
    gate: { masterOn?: boolean; sessionMode?: "on" | "off" | "default"; halted?: boolean } = {},
  ) =>
    zaicodeEffectiveAutoRetry({ ...prefs, ...patch }, "p", "s", {
      masterOn: true,
      halted: false,
      ...gate,
    });
  assert.equal(at({}, { sessionMode: "off" }).enabled, false, "a session's own Off wins over everything");
  assert.equal(at({}, { sessionMode: "on" }).enabled, true, "an explicit On skips the Auto master");
  assert.equal(at({}, { masterOn: false, sessionMode: "on" }).enabled, true);
  assert.equal(at({}, { masterOn: false }).enabled, false, "nobody says On and Auto is off");
  assert.equal(at({ autoRetry: false }).enabled, false, "the retry preference is off");
  assert.equal(
    at({ autoRetry: false, autoRetryProjects: { p: true } }, { masterOn: false, sessionMode: "on" }).enabled,
    true,
    "an explicit per-project retry ON is honoured even when the global flag is off",
  );
  assert.equal(at({ autoRetry: true, autoRetrySessions: { s: false } }).enabled, false, "a session override wins over the project/global");
  assert.equal(at({}, { halted: true }).enabled, false, "the stop-all button stops every automatic send");
  // Nothing is loaded in this process: the sidebar Auto reads OFF, so nothing goes out.
  assert.equal(zaicodeAutoRetryAllowedFor("p", "s-1", true), false);
  assert.equal(zaicodeAutoRetryAllowedFor("p", "s-1", false), false, "the feature's own switch still gates");
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
  // This case is about the ledger, so pin the retry gates it is not about: the preference store
  // hydrates from the shipped snapshot, and a red here would say nothing about the halt.
  useZaicodeUiPrefs.setState({ autoRetry: true, autoRetryScope: "global", autoRetryProjects: {}, autoRetrySessions: {} });
  ledger.set({ sessionId: "x", title: "PHASE SCOUT", nextAt: 10, attempt: 2, source: "background" });
  assert.equal(Object.keys(useZaicodeRetryLedger.getState().pending).length, 1);
  useZaicodeRetryLedger.getState().halt();
  assert.deepEqual(useZaicodeRetryLedger.getState().pending, {});
  assert.equal(useZaicodeRetryLedger.getState().halted, true);
  // A session whose own auto-continue is On, with the Auto master already on: the halt still
  // stops it, because the halt is part of the one effective projection, not a separate gate.
  useZaicodeAuditStore.setState({ smartMode: true });
  assert.equal(
    zaicodeAutoRetryAllowedFor("p", "x", true),
    false,
    "halted: not even a session set to On sends",
  );
  useZaicodeRetryLedger.getState().resume();
  assert.equal(useZaicodeRetryLedger.getState().halted, false);
  assert.equal(zaicodeAutoRetryAllowedFor("p", "x", true), true, "resuming the ledger lets automatic sends through again");
  useZaicodeAuditStore.setState({ smartMode: false });
});

test("wiring: the chat countdown, the background host and the crash resume all ask the policy; the sidebar shows the ledger", () => {
  const retry = source("zaicode/zaicodeAutoRetry.ts");
  assert.match(retry, /zaicodeEffectiveAutoRetry\(/);
  assert.match(retry, /zaicodeRetryDelayMs\(/);
  assert.match(retry, /zaicodeRetryLimit\(/);
  assert.match(retry, /blockedBy === null/);
  const watch = source("zaicode/zaicodeTurnRetryWatch.ts");
  assert.match(watch, /zaicodeEffectiveAutoRetryFor\(brief\.projectKey, brief\.sessionId\)/, "the same effective policy is asked again at the moment of sending");
  assert.match(watch, /isZaicodeQuotaWall\(brief\.sessionId\)/);
  assert.doesNotMatch(watch, /if \(!prefs\.autoRetry\) return;/, "the old switch-only early out is gone");
  const crash = source("zaicode/zaicodeCrashResume.ts");
  assert.match(
    crash,
    /zaicodeAutoRetryAllowedFor\(session\.projectKey, sessionId, prefs\.resumeAfterCrash\)/,
    "the crash resume asks the same effective policy as the queue and the countdown",
  );
  assert.doesNotMatch(crash, /zaicodeMayAutoSend\(/, "the old second gate is gone");
  assert.doesNotMatch(crash, /zaicodeAutoContinueAllowed\(/);
  assert.doesNotMatch(source("zaicode/zaicodeRetryPolicy.ts"), /export function zaicodeMayAutoSend/, "one authority, not two");
  assert.match(source("zaicode/ZaicodeSessionActionStrip.tsx"), /<ZaicodeRetryLedgerChip \/>/);
  assert.match(source("zaicode/ZaicodeAutoRetryNotice.tsx"), /data-zaicode-retry-blocked="quota"/);
});

test("the crash resume is gated by the same effective policy: global OFF, project ON, and the stop-all", () => {
  const now = 1_700_000_000_000;
  const cut = brief({ sessionId: "a", projectKey: "p", crashCut: true, updatedAt: now - 60_000 });
  const sessions = [cut];
  // What the hook passes: the canonical gate, feature switch = resumeAfterCrash.
  const allowed = (sessionId: string, session: typeof cut) =>
    zaicodeAutoRetryAllowedFor(session.projectKey, sessionId, true);
  const plan = () => planZaicodeCrashResume(sessions, () => null, now, 12, allowed).map((step) => step.sessionId);
  const savedPrefs = useZaicodeUiPrefs.getState();
  const savedMaster = useZaicodeAuditStore.getState().smartMode;
  try {
    useZaicodeAuditStore.setState({ smartMode: true });
    // Auto Retry turned off globally: a crash resume is an automatic send, so it does not go.
    useZaicodeUiPrefs.setState({ autoRetry: false, autoRetryScope: "global", autoRetryProjects: {}, autoRetrySessions: {} });
    assert.deepEqual(plan(), [], "a global retry OFF stops the crash resume");
    // The project's own explicit ON wins over the global flag (the same inheritance the UI shows).
    useZaicodeUiPrefs.setState({ autoRetryScope: "project", autoRetryProjects: { p: true } });
    assert.deepEqual(plan(), ["a"], "an explicit per-project retry ON is honoured");
    // A session-level OFF still wins over it, and the sidebar's stop-all stops everything.
    useZaicodeUiPrefs.setState({ autoRetrySessions: { a: false } });
    assert.deepEqual(plan(), [], "a session-level OFF is honoured");
    useZaicodeUiPrefs.setState({ autoRetrySessions: {} });
    useZaicodeRetryLedger.getState().halt();
    assert.deepEqual(plan(), [], "the stop-all button stops a crash resume too");
    useZaicodeRetryLedger.getState().resume();
    assert.deepEqual(plan(), ["a"], "and resuming lets it through again");
    // The feature's own switch still gates it.
    assert.deepEqual(
      planZaicodeCrashResume(sessions, () => null, now, 12, (id, session) =>
        zaicodeAutoRetryAllowedFor(session.projectKey, id, false),
      ),
      [],
      "resumeAfterCrash off means no crash resume",
    );
  } finally {
    useZaicodeUiPrefs.setState({
      autoRetry: savedPrefs.autoRetry,
      autoRetryScope: savedPrefs.autoRetryScope,
      autoRetryProjects: savedPrefs.autoRetryProjects,
      autoRetrySessions: savedPrefs.autoRetrySessions,
    });
    useZaicodeAuditStore.setState({ smartMode: savedMaster });
    useZaicodeRetryLedger.getState().resume();
  }
});
