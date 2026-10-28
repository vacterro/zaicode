import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  describeZaicodeGoalState,
  detachZaicodeGoalSupervision,
  isZaicodeGoalTerminal,
  mayContinueZaicodeGoal,
  observeZaicodeGoalIntent,
  recordZaicodeGoalContinuation,
  registerZaicodeGoalIntent,
  resetZaicodeGoalIntentsForTest,
  stopZaicodeGoalIntents,
  withZaicodeAutoGoal,
  zaicodeGoalIntentById,
  mapBriefToGoalObservation,
  observeZaicodeGoalFromBrief,
  zaicodeGoalObjectiveOf,
  zaicodeGoalLiveIntent,
  ZAICODE_GOAL_MAX_CONTINUATIONS,
} from "../src/zaicode/zaicodeGoalSupervisor.js";

// T-222: one prompt under Auto Goal creates ONE logical goal intent.

test("T-222: one prompt creates one intent; resubmits do not fork", () => {
  resetZaicodeGoalIntentsForTest();
  const first = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  assert.equal(first.created, true);
  // Retry, compaction, provider fallback, restart, worker replacement: same
  // logical prompt re-presented five times, still one intent.
  for (let i = 0; i < 5; i += 1) {
    const again = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
    assert.equal(again.created, false, "resubmit must not fork a second goal");
    assert.equal(again.intent.intentId, first.intent.intentId);
  }
  assert.equal(zaicodeGoalIntentById(first.intent.intentId)?.continuations, 0);
});

test("T-222: provider retry, router fallback and compaction re-present one intent", () => {
  resetZaicodeGoalIntentsForTest();
  const first = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  assert.equal(first.created, true);
  // Same logical prompt re-presented by three different owners: no fork,
  // no continuation spent, still the same live intent.
  for (const owner of ["provider-retry", "router-fallback", "compaction"]) {
    const again = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
    assert.equal(again.created, false, owner + " must not fork a second goal");
    assert.equal(again.intent.intentId, first.intent.intentId);
  }
  assert.equal(zaicodeGoalIntentById(first.intent.intentId)?.continuations, 0);
  assert.equal(zaicodeGoalLiveIntent("p1", "s1")?.intentId, first.intent.intentId);
});

test("T-222: a different objective is different work, kept serial", () => {
  resetZaicodeGoalIntentsForTest();
  const a = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  const b = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "translate" });
  assert.equal(b.created, true);
  assert.notEqual(a.intent.intentId, b.intent.intentId);
  assert.equal(zaicodeGoalLiveIntent("p1", "s1")?.intentId, b.intent.intentId, "newest live intent wins");
});

test("T-222: completion comes from authoritative state, never chat text", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  // SAIPEN still working: do nothing observable.
  assert.equal(observeZaicodeGoalIntent(intent.intentId, { goalActive: true, running: true })?.outcome, "active");
  assert.deepEqual(mayContinueZaicodeGoal(intent.intentId), { send: true, reason: "the goal is still open" });
  // Recoverable condition: normal continuation path stays open.
  assert.equal(
    observeZaicodeGoalIntent(intent.intentId, { goalActive: true, recoverable: true })?.outcome,
    "recovering",
  );
  // Terminal: goal inactive, no blocker, no recovery pending.
  assert.equal(observeZaicodeGoalIntent(intent.intentId, { goalActive: false })?.outcome, "complete");
  assert.deepEqual(mayContinueZaicodeGoal(intent.intentId), { send: false, reason: "the goal is complete" });
  assert.equal(zaicodeGoalLiveIntent("p1", "s1"), null, "completed goals leave supervision");
});

test("T-222: a real blocker is exposed, never spammed", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  assert.equal(observeZaicodeGoalIntent(intent.intentId, { goalActive: true, operatorBlocked: true })?.outcome, "blocked");
  assert.deepEqual(mayContinueZaicodeGoal(intent.intentId), {
    send: false,
    reason: "the goal is blocked on a real dependency",
  });
  assert.equal(describeZaicodeGoalState(true, zaicodeGoalIntentById(intent.intentId)), "Auto Goal ON - Goal blocked");
});

test("T-222: explicit stop wins and is never resurrected", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  assert.equal(stopZaicodeGoalIntents("p1", "s1"), 1);
  const stopped = zaicodeGoalIntentById(intent.intentId)!;
  assert.equal(stopped.outcome, "stopped");
  assert.equal(isZaicodeGoalTerminal("stopped"), true);
  assert.deepEqual(mayContinueZaicodeGoal(intent.intentId), { send: false, reason: "the operator stopped this goal" });
  // An identical re-presentation after the stop does not resurrect it.
  const again = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  assert.equal(again.created, false);
  assert.equal(again.intent.outcome, "stopped");
  // A fresh user submission after the stop replaces the stopped lifecycle
  // under the same deterministic id, so stop-then-resubmit resumes cleanly.
  const fresh = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  assert.equal(fresh.created, true);
  assert.equal(fresh.intent.outcome, "active");
  assert.equal(fresh.intent.stopped, false);
  assert.deepEqual(mayContinueZaicodeGoal(fresh.intent.intentId).send, true);
  // The observation feed is a re-presentation path: it never resurrects.
  stopZaicodeGoalIntents("p1", "s1");
  assert.equal(observeZaicodeGoalFromBrief({ sessionId: "s1", projectKey: "p1", running: true, waiting: false, manuallyStopped: false, goalStatus: "active", goalObjective: "cc all" }, true)?.outcome, "stopped");
  // Another session's goal is untouched by this session's stop.
  const other = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s2", objective: "cc all" });
  assert.equal(other.created, true);
});

test("T-222: continuation budget is bounded; detach parks without killing", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  for (let i = 0; i < ZAICODE_GOAL_MAX_CONTINUATIONS; i += 1) recordZaicodeGoalContinuation(intent.intentId);
  assert.deepEqual(mayContinueZaicodeGoal(intent.intentId), { send: false, reason: "continuation budget exhausted" });

  const live = registerZaicodeGoalIntent({ projectKey: "p2", sessionId: "s9", objective: "cc all" });
  assert.equal(detachZaicodeGoalSupervision("p2"), 1, "Auto Goal off mid-run parks the live goal");
  assert.equal(zaicodeGoalIntentById(live.intent.intentId)?.outcome, "waiting");
  assert.deepEqual(mayContinueZaicodeGoal(live.intent.intentId).send, true, "re-enable may resume it");
});

test("T-222: compact readout never becomes a cockpit", () => {
  resetZaicodeGoalIntentsForTest();
  assert.equal(describeZaicodeGoalState(true, null), "Auto Goal ON");
  assert.equal(describeZaicodeGoalState(false, null), "Auto Goal OFF");
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", objective: "cc all" });
  assert.equal(describeZaicodeGoalState(true, intent), "Auto Goal ON - Goal active");
});

test("T-222: the old text contract is preserved, and no scheduler is introduced", () => {
  resetZaicodeGoalIntentsForTest();
  assert.equal(withZaicodeAutoGoal("do the thing", true).endsWith("/goal cc all"), true);
  assert.equal(withZaicodeAutoGoal("/goal cc all", true), "/goal cc all", "no duplicate suffix");
  const source = readFileSync(new URL("../src/zaicode/zaicodeGoalSupervisor.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setInterval\s*\(/, "no timers: SAIPEN schedules");
  assert.doesNotMatch(source, /setTimeout\s*\(/, "no timers: SAIPEN schedules");
  assert.doesNotMatch(source, /\.schedule\s*\(/i, "no scheduler calls");
});
test("T-222: the composer registers one intent on submit and stops on STOP", () => {
  const composer = readFileSync(new URL("../src/v4/ConversationComposer.tsx", import.meta.url), "utf8");
  assert.match(composer, /registerZaicodeGoalIntent\(\{ projectKey: workspaceKey, sessionId: sessionId[^}]*fresh: true/);
  assert.match(composer, /zaicodeGoalObjectiveOf\(goalText\)/);
  assert.match(composer, /stopZaicodeGoalIntents\(workspaceKey, sessionId/);
  assert.match(composer, /ZaicodeAutoGoalButton workspaceKey=\{workspaceKey\} sessionId=\{sessionId\}/);
});

test("T-222: the button shows the live supervised state", () => {
  const button = readFileSync(new URL("../src/zaicode/ZaicodeAutoGoalButton.tsx", import.meta.url), "utf8");
  assert.match(button, /zaicodeGoalLiveIntent\(workspaceKey, sessionId/);
  assert.match(button, /describeZaicodeGoalState\(enabled, live\)/);
  assert.match(button, /data-zaicode-goal-state=\{live \? live\.outcome : "none"\}/);
  assert.match(button, /useZaicodeGoalVersion\(\)/);
});

test("T-222: objective extraction reads what the prompt carries", () => {
  resetZaicodeGoalIntentsForTest();
  assert.equal(zaicodeGoalObjectiveOf("do the thing\n/goal cc all"), "cc all");
  assert.equal(zaicodeGoalObjectiveOf("/goal cc all"), "cc all");
  assert.equal(zaicodeGoalObjectiveOf("do the thing"), "cc all", "Auto Goal appends the suffix, so the default rides");
  assert.equal(zaicodeGoalObjectiveOf("   "), null, "empty drafts manufacture no intent");
});
test("T-222: brief mapping reads SAIPEN goalStatus, never chat text", () => {
  resetZaicodeGoalIntentsForTest();
  const base = { sessionId: "s1", projectKey: "p1", running: false, waiting: false, manuallyStopped: false, goalObjective: "cc all" as string | null };
  assert.deepEqual(mapBriefToGoalObservation({ ...base, goalStatus: "active", running: true }), {
    goalActive: true, running: true, waiting: false,
  });
  assert.deepEqual(mapBriefToGoalObservation({ ...base, goalStatus: "complete" }), {
    goalActive: false, recoverable: false,
  });
  assert.deepEqual(mapBriefToGoalObservation({ ...base, goalStatus: "budget_limited" }), {
    goalActive: true, operatorBlocked: true,
  });
  assert.deepEqual(mapBriefToGoalObservation({ ...base, goalStatus: "paused" }), {
    goalActive: undefined, running: false, waiting: false,
  });
  assert.deepEqual(mapBriefToGoalObservation({ ...base, goalStatus: null, waiting: true }), {
    goalActive: undefined, running: false, waiting: true,
  });
});

test("T-222: waiting without running reads Goal waiting, not Goal active", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  const folded = observeZaicodeGoalFromBrief(
    { sessionId: "s1", projectKey: "p1", running: false, waiting: true, manuallyStopped: false, goalStatus: "active", goalObjective: "cc all" },
    true,
  );
  assert.equal(folded?.outcome, "waiting");
  assert.equal(folded?.intentId, intent.intentId, "the feed folds into the registered intent");
  assert.equal(describeZaicodeGoalState(true, folded), "Auto Goal ON - Goal waiting");
});

test("T-222: restart re-derives the same intent instead of forking", () => {
  resetZaicodeGoalIntentsForTest();
  const brief = { sessionId: "s1", projectKey: "p1", running: false, waiting: false, manuallyStopped: false, goalStatus: "active" as const, goalObjective: "cc all" };
  const first = observeZaicodeGoalFromBrief(brief, true);
  assert.ok(first, "fresh boot with a named objective re-registers");
  const second = observeZaicodeGoalFromBrief({ ...brief, running: true }, true);
  assert.equal(second?.intentId, first?.intentId, "same deterministic id, no fork");
  // A manually stopped goal is never re-registered by the feed.
  stopZaicodeGoalIntents("p1", "s1");
  assert.equal(observeZaicodeGoalFromBrief(brief, true)?.outcome, "stopped");
  resetZaicodeGoalIntentsForTest();
  assert.equal(
    observeZaicodeGoalFromBrief({ ...brief, manuallyStopped: true }, true),
    null,
    "stopped sessions manufacture no intent",
  );
});

test("T-222: budget exhaustion surfaces as blocked, never spammed", () => {
  resetZaicodeGoalIntentsForTest();
  const folded = observeZaicodeGoalFromBrief(
    { sessionId: "s1", projectKey: "p1", running: true, waiting: false, manuallyStopped: false, goalStatus: "budget_limited", goalObjective: "cc all" },
    true,
  );
  assert.equal(folded?.outcome, "blocked");
  assert.equal(mayContinueZaicodeGoal(folded!.intentId).send, false);
});

test("T-222: the feed is mounted once per composer", () => {
  const composer = readFileSync(new URL("../src/v4/ConversationComposer.tsx", import.meta.url), "utf8");
  assert.match(composer, /useZaicodeGoalObservationFeed\(workspaceKey, autoGoalOn\)/);
  const supervisor = readFileSync(new URL("../src/zaicode/zaicodeGoalSupervisor.ts", import.meta.url), "utf8");
  assert.match(supervisor, /useZaicodeSessionBriefs\(\(state\) => state\.sessions\)/);
});

// ---- audit regression: a fresh submission after a COMPLETED goal ------------
// Regression for a defect the T-222 suite did not cover: the terminal-replacement
// clause tested only `existing.stopped`, so a new user action after the previous
// goal *completed* re-registered the SAME intent -- created false, outcome already
// "complete", and the previous run's spent continuation budget inherited. Work that
// was just starting read as finished and could never be continued.
test("audit: a new user submission after a completed goal starts a fresh lifecycle", () => {
  resetZaicodeGoalIntentsForTest();
  const first = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  assert.equal(first.created, true);
  for (let i = 0; i < ZAICODE_GOAL_MAX_CONTINUATIONS; i += 1) recordZaicodeGoalContinuation(first.intent.intentId);
  observeZaicodeGoalIntent(first.intent.intentId, { goalActive: false });
  assert.equal(zaicodeGoalIntentById(first.intent.intentId)?.outcome, "complete");
  assert.equal(zaicodeGoalLiveIntent("p1", "s1"), null, "a completed goal leaves supervision");

  const second = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  assert.equal(second.created, true, "a new user action after a completed goal is new work");
  assert.equal(second.intent.outcome, "active", "the new lifecycle is not born terminal");
  assert.equal(second.intent.continuations, 0, "the previous run's spent budget is not inherited");
  assert.equal(second.intent.stopped, false);
  assert.deepEqual(mayContinueZaicodeGoal(second.intent.intentId), { send: true, reason: "the goal is still open" });
  assert.equal(zaicodeGoalLiveIntent("p1", "s1")?.intentId, second.intent.intentId, "supervision follows the new run");

  // The live contract is untouched: while the new goal is open, a re-presentation
  // (retry, compaction, feed) is still the same intent, never a fork.
  const again = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  assert.equal(again.created, false);
  assert.equal(again.intent.intentId, second.intent.intentId);

  // And the replacement is repeatable: complete -> submit -> complete -> submit.
  observeZaicodeGoalIntent(second.intent.intentId, { goalActive: false });
  const third = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  assert.equal(third.created, true);
  assert.equal(third.intent.continuations, 0);
});
