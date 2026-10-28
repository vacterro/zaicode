import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  claimZaicodeGoalContinuation,
  failZaicodeGoalContinuation,
  isZaicodeGoalTerminal,
  noteZaicodeGoalSawRunning,
  observeZaicodeGoalIntent,
  recordZaicodeGoalContinuation,
  registerZaicodeGoalIntent,
  resetZaicodeGoalIntentsForTest,
  settleZaicodeGoalContinuation,
  spendZaicodeGoalSawRunning,
  stopZaicodeGoalIntents,
  zaicodeGoalAllIntents,
  zaicodeGoalContinuationAllowed,
  zaicodeGoalIntentById,
  zaicodeGoalSawRunning,
  ZAICODE_GOAL_MAX_CONTINUATIONS,
  type ZaicodeGoalContinuationFacts,
} from "../src/zaicode/zaicodeGoalSupervisor.js";
import { decideZaicodeSessionContinue } from "../src/zaicode/zaicodeContinue.js";

// T-234 (FINDING 2): Auto Goal has exactly ONE production continuation owner.
// Before this ticket `mayContinueZaicodeGoal` / `recordZaicodeGoalContinuation` had
// no caller outside tests: the feature appended "/goal cc all" and then never took
// the goal up again -- a false-green end-to-end promise.

const source = (relative: string) => readFileSync(new URL("../src/" + relative, import.meta.url), "utf8");

const OK: ZaicodeGoalContinuationFacts = {
  autoGoalOn: true,
  halted: false,
  projectDisabled: false,
  running: false,
  waiting: false,
  failed: false,
  goalOpen: true,
  sawRunning: true,
  pending: false,
};

test("T-234: the owner's gate is one truth table, ordered by authority", () => {
  assert.deepEqual(zaicodeGoalContinuationAllowed(OK), {
    allowed: true,
    reason: "the goal is open and its turn has ended",
  });
  // Each blocker refuses on its own, with its own reason (no single blanket "no").
  const refusals: Array<[Partial<ZaicodeGoalContinuationFacts>, string]> = [
    [{ autoGoalOn: false }, "Auto Goal is off for this project"],
    [{ halted: true }, "every automatic send is stopped"],
    [{ projectDisabled: true }, "the project is switched off"],
    [{ running: true }, "the turn is still running"],
    [{ waiting: true }, "the session waits for your answer"],
    [{ failed: true }, "the last turn failed: the retry watch owns it"],
    [{ goalOpen: false }, "the goal is not open"],
    [{ pending: true }, "a continuation is already in flight"],
    [{ sawRunning: false }, "no turn has ended since this goal was submitted"],
  ];
  for (const [patch, reason] of refusals) {
    const verdict = zaicodeGoalContinuationAllowed({ ...OK, ...patch });
    assert.equal(verdict.allowed, false, JSON.stringify(patch));
    assert.equal(verdict.reason, reason, JSON.stringify(patch));
  }
  // Several blockers at once: the outermost authority names the reason.
  assert.equal(
    zaicodeGoalContinuationAllowed({ ...OK, autoGoalOn: false, halted: true, running: true }).reason,
    "Auto Goal is off for this project",
  );
});

test("T-234: OFF, disabled project and stop-all refuse before anything is spent", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  noteZaicodeGoalSawRunning(intent.intentId);
  // OFF => no continuation, and the evidence is not consumed (turning it back on
  // does not have to wait for another whole turn).
  assert.equal(zaicodeGoalContinuationAllowed({ ...OK, autoGoalOn: false }).allowed, false);
  assert.equal(zaicodeGoalSawRunning(intent.intentId), true);
  assert.equal(zaicodeGoalContinuationAllowed({ ...OK, projectDisabled: true }).allowed, false);
  assert.equal(zaicodeGoalContinuationAllowed({ ...OK, halted: true }).allowed, false);
  assert.equal(zaicodeGoalIntentById(intent.intentId)?.continuations, 0, "a refusal spends no budget");
});

test("T-234: a completed goal is never continued", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  noteZaicodeGoalSawRunning(intent.intentId);
  observeZaicodeGoalIntent(intent.intentId, { goalActive: false });
  const outcome = zaicodeGoalIntentById(intent.intentId)!.outcome;
  assert.equal(outcome, "complete");
  assert.equal(isZaicodeGoalTerminal(outcome), true, "the owner skips terminal intents entirely");
  const claim = claimZaicodeGoalContinuation(intent.intentId);
  assert.deepEqual(claim, { claimed: false, reason: "the goal is complete" });
});

test("T-234: an explicit STOP is never resurrected by the owner", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  noteZaicodeGoalSawRunning(intent.intentId);
  stopZaicodeGoalIntents("p1", "s1");
  assert.deepEqual(claimZaicodeGoalContinuation(intent.intentId), {
    claimed: false,
    reason: "the operator stopped this goal",
  });
});

test("T-234: a blocker and an exhausted budget stop the owner", () => {
  resetZaicodeGoalIntentsForTest();
  const blocked = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" }).intent;
  observeZaicodeGoalIntent(blocked.intentId, { goalActive: true, operatorBlocked: true });
  assert.deepEqual(claimZaicodeGoalContinuation(blocked.intentId), {
    claimed: false,
    reason: "the goal is blocked on a real dependency",
  });

  const spent = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s2", objective: "cc all" }).intent;
  for (let i = 0; i < ZAICODE_GOAL_MAX_CONTINUATIONS; i += 1) recordZaicodeGoalContinuation(spent.intentId);
  assert.deepEqual(claimZaicodeGoalContinuation(spent.intentId), {
    claimed: false,
    reason: "continuation budget exhausted",
  });
});

test("T-234: one claim per turn end -- two observers cannot both send", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  noteZaicodeGoalSawRunning(intent.intentId);
  // Two effects (a re-render, a queue wake-up, a second observer) race for the same
  // opportunity: the check and the record are one synchronous step.
  const first = claimZaicodeGoalContinuation(intent.intentId);
  const second = claimZaicodeGoalContinuation(intent.intentId);
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(
    second.claimed === false ? second.reason : "",
    "a continuation is already in flight",
    "the loser reads the winner's in-flight mark",
  );
  assert.equal(zaicodeGoalIntentById(intent.intentId)?.continuations, 1, "exactly one continuation was spent");
  // Repeated ticks of the same turn end: still no duplicate.
  for (let tick = 0; tick < 5; tick += 1) {
    assert.equal(claimZaicodeGoalContinuation(intent.intentId).claimed, false);
  }
  assert.equal(zaicodeGoalIntentById(intent.intentId)?.continuations, 1);
});

test("T-234: one turn end = one continuation; the evidence re-arms only on a new turn", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  noteZaicodeGoalSawRunning(intent.intentId);
  const claim = claimZaicodeGoalContinuation(intent.intentId);
  assert.equal(claim.claimed, true);
  spendZaicodeGoalSawRunning(intent.intentId);
  assert.equal(zaicodeGoalSawRunning(intent.intentId), false);
  settleZaicodeGoalContinuation(intent.intentId);
  // The send went out and settled: the intent is open again, but the turn that
  // produced this continuation is over -- another send must wait for a new turn.
  assert.equal(zaicodeGoalSawRunning(intent.intentId), false);
  assert.equal(zaicodeGoalContinuationAllowed({ ...OK, sawRunning: zaicodeGoalSawRunning(intent.intentId) }).allowed, false);
  // The next real turn re-arms it, and SAIPEN's still-active goal is continued again.
  noteZaicodeGoalSawRunning(intent.intentId);
  assert.equal(claimZaicodeGoalContinuation(intent.intentId).claimed, true);
  assert.equal(zaicodeGoalIntentById(intent.intentId)?.continuations, 2);
});

test("T-234: a rejected send releases the claim without spending the next turn", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  noteZaicodeGoalSawRunning(intent.intentId);
  assert.equal(claimZaicodeGoalContinuation(intent.intentId).claimed, true);
  failZaicodeGoalContinuation(intent.intentId);
  const failed = zaicodeGoalIntentById(intent.intentId)!;
  assert.equal(failed.pending, false, "the in-flight mark comes off");
  assert.equal(failed.failures, 1, "the failure is counted for the owner to read");
  assert.equal(failed.continuations, 1, "a failed send does not pretend to have continued the goal");
  // A settle after a fail is a no-op, not a silent second continuation.
  assert.equal(settleZaicodeGoalContinuation(intent.intentId)?.pending, false);
});

test("T-234: a restart/reload cannot replay a continuation", () => {
  resetZaicodeGoalIntentsForTest();
  const { intent } = registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all" });
  noteZaicodeGoalSawRunning(intent.intentId);
  assert.equal(claimZaicodeGoalContinuation(intent.intentId).claimed, true);
  // The window reloads: the intent table was never on disk, and neither was the
  // evidence -- so a fresh boot has nothing to send (the crash resume owns that,
  // and it only takes sessions it can prove were cut off).
  assert.equal(zaicodeGoalSawRunning(intent.intentId), true, "no reload happened in this test");
  resetZaicodeGoalIntentsForTest();
  assert.equal(zaicodeGoalSawRunning(intent.intentId), false, "the evidence set is dropped with the table");
  assert.deepEqual(zaicodeGoalAllIntents(), [], "no intent survives a reload");
});

test("T-234: a waiting session is opened, never continued past its question", () => {
  const decision = decideZaicodeSessionContinue(
    { running: false, waiting: true, goalStatus: "active", goalObjective: "cc all" },
    true,
  );
  assert.equal(decision.action, "open");
  assert.equal(zaicodeGoalContinuationAllowed({ ...OK, waiting: true }).allowed, false);
});

test("T-234: the owner sends through the canonical continue path, not its own", () => {
  const owner = source("zaicode/zaicodeGoalContinuation.ts");
  assert.match(owner, /import \{ zaicodeContinueHandleFor \} from "\.\/zaicodeContinueHost\.js"/);
  assert.match(owner, /zaicodeContinueHandleFor\(\{/);
  assert.match(owner, /decideZaicodeSessionContinue\(/);
  assert.match(owner, /claimZaicodeGoalContinuation\(current\.intentId\)/);
  assert.match(owner, /settleZaicodeGoalContinuation\(intentId\)/);
  assert.match(owner, /failZaicodeGoalContinuation\(intentId\)/);
  assert.match(owner, /zaicodeGoalContinuationAllowed\(\{/);
  // Mounted exactly once, outside the render path, beside the other automatic owners.
  const runtime = source("zaicode/ZaicodeAppRuntime.tsx");
  assert.match(runtime, /useZaicodeGoalContinuation\(\)/);
  assert.equal(runtime.match(/useZaicodeGoalContinuation\(\)/g)?.length, 1, "one mount");
  // No timer, no polling: the published briefs are the clock.
  assert.doesNotMatch(owner, /setInterval\s*\(/);
  assert.doesNotMatch(owner, /setTimeout\s*\(/);
  // And no second owner anywhere: only this module claims a continuation.
  const claimers = ["zaicodeGoalContinuation.ts", "zaicodeGoalSupervisor.ts", "zaicodeCrashResume.ts", "zaicodeTurnRetryWatch.ts"]
    .map((file) => source("zaicode/" + file))
    .filter((text) => /claimZaicodeGoalContinuation\(|recordZaicodeGoalContinuation\(/.test(text));
  assert.deepEqual(claimers.length, 2, "the supervisor defines it; the owner is its only caller");
});
