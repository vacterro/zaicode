import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ZaicodeGoalContinuationFacts } from "../src/zaicode/zaicodeGoalSupervisor.js";

// T-282 (SAIHANDOFF F-02): the blocker handback and its durable breaker.
//
// The audit watched the host dispatch sixteen automatic `cc` inputs after SAIPEN
// had already answered a goal-blocked RESTATE_AND_STOP, and the goal row stayed
// `active` throughout. The acceptance is three sentences: the supplied blocked
// scenario yields ONE blocker handback and zero further automatic `cc`; an
// identical fingerprint suppresses redispatch; a completed goal dispatches
// nothing.
//
// The intent table is process-local on purpose (a reload must not resurrect turn
// evidence), so the fingerprint of the state a handback was delivered at is the
// one piece that has to survive it. This file therefore plays renderer instances
// that share one localStorage and nothing else: a fresh `?t282=n` import IS a
// reload, table and memory and all.

const KEY = "zaicode-goal-handback-v1";
const raw = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => raw.get(key) ?? null,
  setItem: (key: string, value: string) => void raw.set(key, value),
  removeItem: (key: string) => void raw.delete(key),
};

type Supervisor = typeof import("../src/zaicode/zaicodeGoalSupervisor.js");

/** One renderer instance. The query string makes Node load a fresh module. */
function startRenderer(n: number): Promise<Supervisor> {
  return import(`../src/zaicode/zaicodeGoalSupervisor.js?t282=${n}`) as Promise<Supervisor>;
}

/** Every non-operator fact satisfied: only the goal's own state can refuse. */
function openFacts(overrides: Partial<ZaicodeGoalContinuationFacts> = {}): ZaicodeGoalContinuationFacts {
  return {
    autoGoalOn: true,
    halted: false,
    projectDisabled: false,
    running: false,
    waiting: false,
    failed: false,
    goalOpen: true,
    handbackStands: false,
    sawRunning: true,
    pending: false,
    ...overrides,
  };
}

const AUDIT_OBJECTIVE = "cc all";
const AUDIT_SESSION = "s-audit";
const AUDIT_PROJECT = "p-audit";
/** One authoritative state: the objective and the revision SAIPEN published. */
const AUDIT_STATE = { objective: AUDIT_OBJECTIVE, revision: "4242" };

/** The audit's brief: SAIPEN parked the goal on a human blocker. */
function parkedBrief() {
  return {
    sessionId: AUDIT_SESSION,
    projectKey: AUDIT_PROJECT,
    running: false,
    waiting: false,
    manuallyStopped: false,
    goalStatus: "paused" as const,
    goalObjective: AUDIT_OBJECTIVE,
  };
}

const owner = readFileSync(new URL("../src/zaicode/zaicodeGoalContinuation.ts", import.meta.url), "utf8");
const supervisorSource = readFileSync(new URL("../src/zaicode/zaicodeGoalSupervisor.ts", import.meta.url), "utf8");

test("T-282: the vocabulary names what a state hands back, and only a real blocker does", async () => {
  const { zaicodeGoalHandbackKind } = await startRenderer(1);
  assert.equal(zaicodeGoalHandbackKind({ goalStatus: "complete" }), "complete");
  assert.equal(zaicodeGoalHandbackKind({ goalStatus: "paused" }), "blocked");
  assert.equal(zaicodeGoalHandbackKind({ goalStatus: "budget_limited" }), "blocked");
  assert.equal(zaicodeGoalHandbackKind({ goalStatus: "active", outcome: "blocked" }), "blocked");
  // A finished goal outranks a stale fold: it is complete, never "blocked".
  assert.equal(zaicodeGoalHandbackKind({ goalStatus: "complete", outcome: "blocked" }), "complete");
  // Nothing that was not proved blocked may freeze a working goal.
  assert.equal(zaicodeGoalHandbackKind({ goalStatus: "active", outcome: "waiting" }), null);
  assert.equal(zaicodeGoalHandbackKind({ goalStatus: "active" }), null);
  assert.equal(zaicodeGoalHandbackKind({ goalStatus: null, outcome: "active" }), null);
});

test("T-282: the gate refuses while a delivered handback stands, and says why", async () => {
  const { zaicodeGoalContinuationAllowed } = await startRenderer(2);
  assert.deepEqual(zaicodeGoalContinuationAllowed(openFacts()), {
    allowed: true,
    reason: "the goal is open and its turn has ended",
  });
  assert.deepEqual(zaicodeGoalContinuationAllowed(openFacts({ handbackStands: true })), {
    allowed: false,
    reason: "the handback for this objective still stands: nothing new was published",
  });
  // The wall is consulted after the operator's own switches, so their reasons win.
  assert.equal(
    zaicodeGoalContinuationAllowed(openFacts({ autoGoalOn: false, handbackStands: true })).reason,
    "Auto Goal is off for this project",
  );
});

test("T-282: the audit's blocked scenario hands back once and never again, across a reload", async () => {
  const first = await startRenderer(3);
  const { intent } = first.registerZaicodeGoalIntent({
    projectKey: AUDIT_PROJECT,
    sessionId: AUDIT_SESSION,
    objective: AUDIT_OBJECTIVE,
  });
  // SAIPEN's own disposition is folded first, exactly as the owner does it.
  const folded = first.observeZaicodeGoalFromBrief(parkedBrief(), true);
  assert.ok(folded, "the parked goal is still the same intent");

  // The owner's decision at this state: goalOpen is false for a parked goal.
  const refused = first.zaicodeGoalContinuationAllowed(
    openFacts({
      goalOpen: parkedBrief().goalStatus === "active",
      handbackStands: first.zaicodeGoalHandbackStands(intent.intentId, AUDIT_STATE),
    }),
  );
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "the goal is not open");

  // One blocker handback: the owner records the state it was delivered at.
  const kind = first.zaicodeGoalHandbackKind({ goalStatus: parkedBrief().goalStatus, outcome: folded.outcome });
  assert.equal(kind, "blocked");
  first.noteZaicodeGoalHandback(intent.intentId, { kind: "blocked", ...AUDIT_STATE });
  assert.deepEqual(first.zaicodeGoalHandback(intent.intentId), {
    kind: "blocked",
    objective: AUDIT_OBJECTIVE,
    revision: "4242",
  });
  // A second delivery of the SAME state is the same handback, not a second one.
  first.noteZaicodeGoalHandback(intent.intentId, { kind: "blocked", ...AUDIT_STATE });
  assert.equal(Object.keys(JSON.parse(raw.get(KEY) ?? "{}")).length, 1);

  // RELOAD. New module, empty intent table, same durable record -- and a brief that
  // still claims an OPEN goal at the same revision, which is the shape the audit
  // found (the executor answered "Leaving goal active"). The record is what stops
  // the send; the restored opportunity cannot hand it another one.
  const reloaded = await startRenderer(4);
  assert.equal(reloaded.zaicodeGoalHandbackStands(intent.intentId, AUDIT_STATE), true);
  assert.deepEqual(
    reloaded.zaicodeGoalContinuationAllowed(
      openFacts({
        goalOpen: true,
        restored: true,
        sawRunning: false,
        handbackStands: reloaded.zaicodeGoalHandbackStands(intent.intentId, AUDIT_STATE),
      }),
    ),
    { allowed: false, reason: "the handback for this objective still stands: nothing new was published" },
  );

  // A qualifying change reactivates: SAIPEN published a NEW revision.
  const nextState = { objective: AUDIT_OBJECTIVE, revision: "4243" };
  assert.equal(reloaded.zaicodeGoalHandbackStands(intent.intentId, nextState), false);
  assert.equal(
    reloaded.zaicodeGoalContinuationAllowed(
      openFacts({ handbackStands: reloaded.zaicodeGoalHandbackStands(intent.intentId, nextState) }),
    ).allowed,
    true,
  );

  // A valid new human instruction reactivates too, and it forgets the wall.
  const { intent: resumed } = reloaded.registerZaicodeGoalIntent({
    projectKey: AUDIT_PROJECT,
    sessionId: AUDIT_SESSION,
    objective: AUDIT_OBJECTIVE,
    fresh: true,
  });
  assert.equal(resumed.intentId, intent.intentId);
  assert.equal(reloaded.zaicodeGoalHandback(resumed.intentId), null);
  assert.equal(reloaded.zaicodeGoalHandbackStands(resumed.intentId, AUDIT_STATE), false);
});

test("T-282: the operator's stop is a qualifying change; a completed goal dispatches nothing", async () => {
  const engine = await startRenderer(5);
  const { intent } = engine.registerZaicodeGoalIntent({
    projectKey: "p-stop",
    sessionId: "s-stop",
    objective: "cc all",
  });
  engine.noteZaicodeGoalHandback(intent.intentId, { kind: "blocked", objective: "cc all", revision: "7" });
  assert.equal(engine.zaicodeGoalHandbackStands(intent.intentId, { objective: "cc all", revision: 7 }), true);
  // A number revision is accepted too: the same state written by a legacy store.
  engine.noteZaicodeGoalHandback(intent.intentId, { kind: "blocked", objective: "cc all", revision: "7" });
  assert.equal(engine.stopZaicodeGoalIntents("p-stop", "s-stop"), 1);
  assert.equal(engine.zaicodeGoalHandback(intent.intentId), null);

  // A completed goal is terminal in the fold, so the owner's loop skips it before
  // the gate: no dispatch, and the completion is not a "blocked" handback either.
  const { intent: done } = engine.registerZaicodeGoalIntent({
    projectKey: "p-done",
    sessionId: "s-done",
    objective: "cc all",
  });
  const folded = engine.observeZaicodeGoalFromBrief(
    {
      sessionId: "s-done",
      projectKey: "p-done",
      running: false,
      waiting: false,
      manuallyStopped: false,
      goalStatus: "complete",
      goalObjective: "cc all",
    },
    true,
  );
  assert.ok(folded);
  assert.equal(folded.outcome, "complete");
  assert.equal(engine.isZaicodeGoalTerminal(folded.outcome), true);
  assert.equal(engine.zaicodeGoalHandbackKind({ goalStatus: "complete", outcome: folded.outcome }), "complete");
  assert.equal(done.intentId, folded.intentId);
  assert.equal(
    engine.zaicodeGoalContinuationAllowed(openFacts({ goalOpen: false, handbackStands: true })).allowed,
    false,
  );
});

test("T-282: the owner consults the handback in BOTH gates and records it on the refusal", () => {
  // Wiring oracle: the mechanism above only protects a goal if the one production
  // owner asks it. Both the pre-claim decision and the final live admission must
  // carry the fact, or a send can still slip past a recorded handback.
  const consultations = owner.split("handbackStands: zaicodeGoalHandbackStands(").length - 1;
  assert.equal(consultations, 2, "the pre-claim gate and the live canDispatch gate both ask");
  assert.match(owner, /noteZaicodeGoalHandback\(current\.intentId, \{ kind: handback, \.\.\.handbackState \}\)/);
  assert.match(owner, /const handback = zaicodeGoalHandbackKind\(\{ goalStatus: brief\.goalStatus, outcome: current\.outcome \}\)/);
  // The owner skips a terminal intent before the gate: a completed goal cannot send.
  assert.match(owner, /if \(isZaicodeGoalTerminal\(current\.outcome\)\) continue;/);
  // A new instruction and the operator's stop clear the record -- the two qualifying
  // changes the operator owns directly.
  assert.match(supervisorSource, /if \(input\.fresh\) clearZaicodeGoalHandback\(intentId\);/);
  assert.match(supervisorSource, /clearZaicodeGoalHandback\(id\);/);
});
