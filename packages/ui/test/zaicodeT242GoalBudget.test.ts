import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// T-242 (CORE-002): the Auto Goal continuation budget is the operator's protection
// against a goal being continued for ever, so it is the one piece of supervision
// state a renderer reload may not reset. The intent table stays process-local on
// purpose (a reload must not resurrect an intent or its turn-end evidence); only
// the SPENT count has a durable home.
//
// No module that holds goal state is imported statically here: this file plays the
// part of a renderer that has just started, so every import below is a new module
// instance hydrating from the record the previous one left on disk.

const KEY = "zaicode-goal-budget-v1";
const raw = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => raw.get(key) ?? null,
  setItem: (key: string, value: string) => void raw.set(key, value),
  removeItem: (key: string) => void raw.delete(key),
};

type Supervisor = typeof import("../src/zaicode/zaicodeGoalSupervisor.js");

/** One renderer instance. The query string makes Node load a fresh module, memory and all. */
function startRenderer(n: number): Promise<Supervisor> {
  return import(`../src/zaicode/zaicodeGoalSupervisor.js?reload=${n}`) as Promise<Supervisor>;
}

const BRIEF = {
  sessionId: "s1",
  projectKey: "p1",
  running: false,
  waiting: false,
  manuallyStopped: false,
  goalStatus: "active" as const,
  goalObjective: "cc all",
};

/** One automatic continuation: claim it (the only way a continuation is spent), then let the send land. */
function spendOne(supervisor: Supervisor, intentId: string): void {
  const claim = supervisor.claimZaicodeGoalContinuation(intentId);
  assert.equal(claim.claimed, true, "the continuation may be claimed");
  supervisor.settleZaicodeGoalContinuation(intentId);
}

function ledger(): Record<string, number> {
  const stored = raw.get(KEY);
  return stored ? (JSON.parse(stored) as Record<string, number>) : {};
}

test("T-242: the spent count is on disk before the intent table learns about it", async () => {
  const supervisor = await startRenderer(1);
  const { intent } = supervisor.registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  assert.equal(intent.continuations, 0, "a new user submission starts at zero");
  for (let i = 0; i < 19; i += 1) spendOne(supervisor, intent.intentId);
  assert.equal(intent.intentId, "p1::s1::cc all", "the deterministic id a reload re-derives");
  assert.equal(ledger()[intent.intentId], 19, "every claim is on disk, not only in memory");

  // The durable spend happens before the in-memory budget moves: a crash between
  // claim and send may only ever leave a MORE expensive state behind, never a cheaper one.
  const source = readFileSync(new URL("../src/zaicode/zaicodeGoalSupervisor.ts", import.meta.url), "utf8");
  const recordBody = source.slice(
    source.indexOf("export function recordZaicodeGoalContinuation"),
    source.indexOf("export function claimZaicodeGoalContinuation"),
  );
  assert.ok(
    recordBody.indexOf("writeZaicodeGoalContinuationLedger(intentId, spent)") < recordBody.indexOf("intents.set(intentId, next)"),
    "the ledger is written before the table is updated",
  );
  assert.match(
    source.slice(source.indexOf("export function claimZaicodeGoalContinuation"), source.indexOf("export function settleZaicodeGoalContinuation")),
    /recordZaicodeGoalContinuation\(intentId, now\)/,
    "every claim spends the budget durably -- there is no second path that sends",
  );
});

test("T-242: a reloaded renderer resumes at 19, is refused at 21, and the count never resets", async () => {
  const first = await startRenderer(2);
  const { intent } = first.registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  for (let i = 0; i < 19; i += 1) spendOne(first, intent.intentId);
  const spent = ledger()[intent.intentId];
  assert.equal(spent, 19);

  // The window reloads: the intent table and the turn-end evidence are gone, the ledger is not.
  const reloaded = await startRenderer(3);
  assert.equal(reloaded.zaicodeGoalAllIntents().length, 0, "the intent table is process-local, on purpose");
  const resumed = reloaded.observeZaicodeGoalFromBrief(BRIEF, true);
  assert.ok(resumed, "the feed re-presents the still-open goal");
  assert.equal(resumed.intentId, intent.intentId, "same deterministic id");
  assert.equal(resumed.continuations, 19, "the reload does not hand the goal a second budget");

  spendOne(reloaded, resumed.intentId);
  assert.equal(ledger()[intent.intentId], 20, "the last continuation is spent");
  const exhausted = reloaded.mayContinueZaicodeGoal(resumed.intentId);
  assert.equal(exhausted.send, false, "20 continuations are spent, so no 21st may escape");
  assert.equal(exhausted.reason, "continuation budget exhausted");
  assert.equal(reloaded.claimZaicodeGoalContinuation(resumed.intentId).claimed, false, "the claim is refused, not merely advised against");

  // Reloading again -- three times -- must not restore a cheaper budget.
  let expected = 20;
  for (let round = 4; round <= 6; round += 1) {
    const again = await startRenderer(round);
    const hydrated = again.observeZaicodeGoalFromBrief(BRIEF, true);
    assert.ok(hydrated, `reload ${round} re-presents the goal`);
    assert.equal(hydrated.continuations, expected, `reload ${round} keeps the cumulative count`);
    assert.equal(again.mayContinueZaicodeGoal(hydrated.intentId).send, false, `reload ${round} still refuses`);
    assert.equal(again.claimZaicodeGoalContinuation(hydrated.intentId).claimed, false, `reload ${round} claims nothing`);
    expected = ledger()[intent.intentId];
  }
});

test("T-242: a fresh user submission is a new lifecycle and may start a new budget", async () => {
  const renderer = await startRenderer(7);
  const { intent } = renderer.registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  assert.equal(intent.continuations, 0, "the composer's new submission never inherits the old run's spent count");
  assert.equal(renderer.spentZaicodeGoalContinuations(intent.intentId), 0, "and it clears the old ledger entry");
  spendOne(renderer, intent.intentId);
  assert.equal(ledger()[intent.intentId], 1, "the new lifecycle spends from zero");
});

test("T-242: the in-flight mark and the turn-end evidence stay process-local; only the count crosses", async () => {
  const renderer = await startRenderer(8);
  const { intent } = renderer.registerZaicodeGoalIntent({ projectKey: "p1", sessionId: "s1", objective: "cc all", fresh: true });
  renderer.noteZaicodeGoalSawRunning(intent.intentId);
  const claim = renderer.claimZaicodeGoalContinuation(intent.intentId);
  assert.equal(claim.claimed, true);
  assert.equal(renderer.zaicodeGoalIntentById(intent.intentId)?.pending, true, "the send is in flight");

  const reloaded = await startRenderer(9);
  const hydrated = reloaded.observeZaicodeGoalFromBrief({ ...BRIEF, running: true }, true);
  assert.ok(hydrated);
  assert.equal(hydrated.continuations, 1, "the spent continuation survives");
  assert.equal(hydrated.pending, undefined, "the in-flight mark does not come back with it");
  assert.equal(reloaded.zaicodeGoalSawRunning(hydrated.intentId), false, "nor does the turn-end evidence");
  // Which is exactly why a reload cannot replay the send: no turn of this goal has been
  // observed running in this renderer, so the owner gate refuses until a real turn ends.
  assert.equal(
    reloaded.zaicodeGoalContinuationAllowed({
      autoGoalOn: true, halted: false, projectDisabled: false, running: false, waiting: false,
      failed: false, goalOpen: true, sawRunning: reloaded.zaicodeGoalSawRunning(hydrated.intentId), pending: false,
    }).allowed,
    false,
    "a reloaded renderer cannot send a continuation it never watched run",
  );
});

test("T-242: a stopped or complete goal is decided by the session's own brief, not by a local ledger", async () => {
  const renderer = await startRenderer(10);
  const stopped = { ...BRIEF, manuallyStopped: true };
  assert.equal(renderer.observeZaicodeGoalFromBrief(stopped, true), null, "stopped sessions manufacture no intent");
  const budgeted = { ...BRIEF, goalStatus: "budget_limited" as const };
  const blocked = renderer.observeZaicodeGoalFromBrief(budgeted, true);
  assert.equal(blocked?.outcome, "blocked");
  assert.equal(renderer.mayContinueZaicodeGoal(blocked!.intentId).send, false, "a blocked goal exposes its state instead of hammering on");
});

test("T-242: an unreadable ledger degrades to a fresh count, never to a crash", async () => {
  raw.set(KEY, "{not json");
  const broken = await startRenderer(11);
  const resumed = broken.observeZaicodeGoalFromBrief(BRIEF, true);
  assert.ok(resumed, "a corrupt record does not stop the feed from registering");
  assert.equal(resumed.continuations, 0, "corrupt is read as 'nothing spent', never as 'everything spent'");
  assert.equal(broken.mayContinueZaicodeGoal(resumed.intentId).send, true, "and it costs the goal no budget");

  for (const junk of ["[]", '{"p1::s1::cc all": "many"}', '{"p1::s1::cc all": -3}', "null"]) {
    raw.set(KEY, junk);
    const next = await startRenderer(12 + junk.length);
    const again = next.observeZaicodeGoalFromBrief(BRIEF, true);
    assert.ok(again, `the feed survives ${junk}`);
    assert.equal(again.continuations, 0, `${junk} holds no spend this app could have written`);
  }
  raw.delete(KEY);
});
