import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  observeZaicodeGoalFromBrief, registerZaicodeGoalIntent, resetZaicodeGoalIntentsForTest,
  spendZaicodeGoalSawRunning, zaicodeGoalAllIntents, zaicodeGoalRestoredOpportunity,
  zaicodeGoalContinuationAllowed, stopZaicodeGoalIntents,
} from "../src/zaicode/zaicodeGoalSupervisor.js";

const brief = { sessionId: "hidden-session", projectKey: "hidden-project", running: false,
  waiting: false, manuallyStopped: false, goalStatus: "active" as const, goalObjective: "finish authorized work" };
beforeEach(resetZaicodeGoalIntentsForTest);

test("an authoritative restored goal gets one opportunity without inventing a new turn", () => {
  const intent = observeZaicodeGoalFromBrief(brief, true)!;
  assert.equal(zaicodeGoalRestoredOpportunity(intent.intentId), true);
  spendZaicodeGoalSawRunning(intent.intentId);
  observeZaicodeGoalFromBrief({ ...brief }, true);
  assert.equal(zaicodeGoalRestoredOpportunity(intent.intentId), false, "publishing the same idle brief cannot re-arm it");
});

test("fresh submissions, including a draft acquiring its real session, are never restored sends", () => {
  registerZaicodeGoalIntent({ projectKey: brief.projectKey, objective: brief.goalObjective, fresh: true });
  const intent = observeZaicodeGoalFromBrief(brief, true)!;
  assert.equal(intent.sessionId, brief.sessionId);
  assert.equal(zaicodeGoalAllIntents().length, 1, "draft promotion retains one owner");
  assert.equal(zaicodeGoalRestoredOpportunity(intent.intentId), false);
});

test("OFF and explicit STOP cannot be resurrected by restoration", () => {
  assert.equal(observeZaicodeGoalFromBrief(brief, false), null);
  assert.equal(observeZaicodeGoalFromBrief({ ...brief, manuallyStopped: true }, true), null);
  const intent = observeZaicodeGoalFromBrief(brief, true)!;
  stopZaicodeGoalIntents(brief.projectKey, brief.sessionId);
  assert.equal(observeZaicodeGoalFromBrief(brief, true)?.stopped, true);
  assert.equal(zaicodeGoalAllIntents().length, 1);
  assert.equal(intent.continuations, 0);
});

test("restored opportunity never overrides waiting, failure, STOP-all or a disabled project", () => {
  const facts = { autoGoalOn: true, halted: false, projectDisabled: false, running: false, waiting: false,
    failed: false, goalOpen: true, handbackStands: false, sawRunning: false, restored: true, pending: false };
  assert.equal(zaicodeGoalContinuationAllowed(facts).allowed, true);
  for (const patch of [{ autoGoalOn: false }, { halted: true }, { projectDisabled: true }, { running: true },
    { waiting: true }, { failed: true }, { goalOpen: false }, { pending: true }, { restored: false }]) {
    assert.equal(zaicodeGoalContinuationAllowed({ ...facts, ...patch }).allowed, false);
  }
});
