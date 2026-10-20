import assert from "node:assert/strict";
import test from "node:test";
import { useZaicodeAuditStore } from "../src/zaicode/zaicodeAuditStore.js";
import { useZaicodeAutoContinue } from "../src/zaicode/zaicodeAutoContinue.js";
import { useZaicodeUiPrefs } from "../src/zaicode/zaicodeUiPrefs.js";
import { useZaicodeRetryLedger, zaicodeEffectiveAutoRetryFor } from "../src/zaicode/zaicodeRetryPolicy.js";
import { zaicodeQueueAutoSendAllowed } from "../src/zaicode/zaicodeQueueAutoResume.js";
import { pickZaicodeBackgroundRetrySessions } from "../src/zaicode/zaicodeTurnRetryWatch.js";
import type { ZaicodeSessionBrief } from "../src/zaicode/zaicodeContinue.js";

function reset() {
  useZaicodeAuditStore.setState({ smartMode: false });
  useZaicodeAutoContinue.setState({ modes: {} });
  useZaicodeUiPrefs.setState({ autoRetry: true, autoRetryScope: "global", autoRetryProjects: {}, autoRetrySessions: {} });
  useZaicodeRetryLedger.getState().resume();
  useZaicodeRetryLedger.getState().clearAll();
}

test("SRC-183: inherited Global ON admits a failed turn while Audits Auto is OFF", () => {
  reset();
  assert.equal(zaicodeEffectiveAutoRetryFor("p", "s").enabled, true);
  assert.equal(zaicodeEffectiveAutoRetryFor("p", "s").reason, null);
  useZaicodeAuditStore.setState({ smartMode: true });
  assert.equal(zaicodeEffectiveAutoRetryFor("p", "s").enabled, true);
});

test("SRC-183: an error-paused queue inherits the same ON without an Audits input", () => {
  reset();
  assert.equal(zaicodeQueueAutoSendAllowed({ enabled: true, halted: false, projectKey: "p", sessionId: "s", prefs: useZaicodeUiPrefs.getState(), sessionMode: undefined }), true);
});

test("SRC-183: a closed failed session is eligible without walking into the project", () => {
  reset();
  const brief: ZaicodeSessionBrief = { sessionId: "s", title: "t", projectKey: "p", workspacePath: "V:/p", running: false, waiting: false, failed: true, interrupted: false, manuallyStopped: false, crashCut: false, updatedAt: 1, model: null, unreadAt: null, goalStatus: null, goalObjective: null };
  const selected = pickZaicodeBackgroundRetrySessions([brief], { isLocal: () => false, isProjectDisabled: () => false, attemptsOf: () => 0, maxAttempts: 5, mayAutoSend: (id) => zaicodeEffectiveAutoRetryFor("p", id).enabled });
  assert.deepEqual(selected.map((item) => item.sessionId), ["s"]);
});

test("SRC-183: explicit OFF and durable stop-all still defeat Global ON", () => {
  reset();
  useZaicodeUiPrefs.setState({ autoRetryProjects: { p: false } });
  assert.equal(zaicodeEffectiveAutoRetryFor("p", "s").block, "preference-off");
  useZaicodeUiPrefs.setState({ autoRetryProjects: {}, autoRetrySessions: { s: false } });
  assert.equal(zaicodeEffectiveAutoRetryFor("p", "s").block, "preference-off");
  useZaicodeUiPrefs.setState({ autoRetrySessions: {} });
  useZaicodeAutoContinue.setState({ modes: { s: "off" } });
  assert.equal(zaicodeEffectiveAutoRetryFor("p", "s").block, "session-off");
  useZaicodeAutoContinue.setState({ modes: {} });
  useZaicodeRetryLedger.getState().halt();
  assert.equal(zaicodeEffectiveAutoRetryFor("p", "s").block, "halted");
  useZaicodeRetryLedger.getState().resume();
});
