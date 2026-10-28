/**
 * T-222 (SRC-153 R002/R003): Auto Goal as a completion SUPERVISOR.
 *
 * Old T-204 contract: Auto Goal invisibly appended the goal suffix to a prompt.
 * That is a one-shot text transform -- it says nothing about whether the goal
 * ever finished, and a retry, a compaction, a provider switch or a restart could
 * append it again, or stop appending it while the goal was still open.
 *
 * New contract: Auto Goal ON means "for user work submitted under this project,
 * keep the associated goal intent progressing until SAIPEN says the goal is
 * complete, blocked on a real operator/external dependency, explicitly
 * stopped, or otherwise terminal."
 *
 * This module is the authoritative intent/supervision state. It does NOT
 * schedule anything: SAIPEN owns execution, and the existing continuation paths
 * (zaicodeContinue, zaicodeAutostart) remain the only senders. What is owned
 * here is one logical intent per project prompt, which intents are still worth
 * continuing, a truthful compact state for the composer, and the send/no-send
 * rules an external owner asks before it re-sends.
 *
 * Non-goal, stated so it cannot drift: no second scheduler.
 */

/** Terminal and non-terminal supervision outcomes, in the operator words. */
export type ZaicodeGoalOutcome = "active" | "recovering" | "waiting" | "blocked" | "complete" | "stopped";

export interface ZaicodeGoalIntent {
  /** Stable identity: one prompt under one project yields one intent. */
  intentId: string;
  projectKey: string;
  sessionId: string | null;
  /** SAIPEN objective text. */
  objective: string;
  /** Monotonic creation order; serialisation uses it, never wall clock. */
  seq: number;
  outcome: ZaicodeGoalOutcome;
  /** How many automatic continuations this intent has already spent. */
  continuations: number;
  /** Set once the operator stopped it: no owner may resurrect this intent. */
  stopped: boolean;
  /**
   * T-234: one continuation send is in flight. The claim that sets it is
   * synchronous, so two observers, a re-render or a wake-up can never both send.
   */
  pending?: boolean;
  /** Epoch ms of the last claimed continuation (evidence for "did the turn end since?"). */
  lastContinuationAt?: number;
  /** Consecutive failed continuation sends; an intent that cannot send is not hammered. */
  failures?: number;
}

/** What an external observation reports back about an intent. */
export interface ZaicodeGoalObservation {
  /** The host/SAIPEN still reports the goal as active (not merely "session is running"). */
  goalActive?: boolean;
  /** A recoverable continuation condition exists (retry armed, router fallback, restart residue). */
  recoverable?: boolean;
  /** A real blocker requiring operator input or an external dependency. */
  operatorBlocked?: boolean;
  /** The session is running right now. */
  running?: boolean;
  /** The session waits for an operator answer (its own waiting flag). */
  waiting?: boolean;
}

/** One intent may spend at most this many automatic continuations. */
export const ZAICODE_GOAL_MAX_CONTINUATIONS = 20;
/** Bounded intent table: one short entry per live project goal. */
const MAX_INTENTS = 200;

const intents = new Map<string, ZaicodeGoalIntent>();
let seq = 0;

/**
 * T-242 (SRC-160 R002): the SPENT continuations are the one fact that has to
 * survive a renderer reload.
 *
 * The intent table above is process-local on purpose: a reload must not
 * resurrect an intent, and the turn-end evidence must not come back with it.
 * The BUDGET is different. It is the operator's protection against a goal being
 * continued for ever, and it used to live only in the table -- so a reload of
 * the same window handed the same objective a brand-new 20, and the goal could
 * be continued again indefinitely, one reload at a time.
 *
 * The ledger below is that budget's durable home: deterministic intent id ->
 * continuations already spent. It is deliberately NOT in the release-snapshot
 * allowlist (zaicodeSettingsSnapshot): this is runtime bookkeeping, not an
 * operator preference, so a profile restore legitimately starts from a fresh
 * budget.
 *
 * ponytail: localStorage + JSON, capped with the intent table. Upgrade path when
 * a second process has to share the budget: move it beside the session state on
 * the host.
 */
const GOAL_BUDGET_STORAGE_KEY = "zaicode-goal-budget-v1";

function goalBudgetStore(): Storage | null {
  // Storage can be disabled by policy: a read or a write that throws must never
  // decide a continuation.
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readGoalBudgetLedger(): Record<string, number> {
  const store = goalBudgetStore();
  if (!store) return {};
  try {
    const raw = store.getItem(GOAL_BUDGET_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const ledger: Record<string, number> = {};
    for (const [id, spent] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof spent === "number" && Number.isFinite(spent) && spent > 0) ledger[id] = spent;
    }
    return ledger;
  } catch {
    return {};
  }
}

/** Spent continuations recorded on disk for this intent (0 when nothing is known). */
export function spentZaicodeGoalContinuations(intentId: string): number {
  return readGoalBudgetLedger()[intentId] ?? 0;
}

/** Persist one intent's spent budget; 0 clears the entry. */
function writeZaicodeGoalContinuationLedger(intentId: string, spent: number): void {
  const store = goalBudgetStore();
  if (!store || !intentId) return;
  try {
    const ledger = readGoalBudgetLedger();
    if (spent > 0) ledger[intentId] = spent;
    else delete ledger[intentId];
    const ids = Object.keys(ledger);
    for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_INTENTS))) delete ledger[stale];
    store.setItem(GOAL_BUDGET_STORAGE_KEY, JSON.stringify(ledger));
  } catch {
    // A full or disabled store costs durability, never the continuation in hand.
  }
}

/** Deterministic id: project + session + objective, so a resubmit cannot fork one. */
export function zaicodeGoalIntentId(projectKey: string, sessionId: string | null, objective: string): string {
  return projectKey.trim() + "::" + (sessionId ?? "-") + "::" + objective.trim();
}

/**
 * Idempotent registration. A retry, a compaction, a provider switch, an app
 * restart or a worker replacement that re-presents the same logical prompt
 * returns the SAME intent (created: false) instead of forking a second goal.
 * A different objective under the same session is genuinely different work and
 * gets its own intent (serial, per existing queue rules).
 */
export function registerZaicodeGoalIntent(input: {
  projectKey: string;
  sessionId?: string | null;
  objective: string;
  /**
   * True when this call is a NEW user submission (composer submit), not a
   * re-presentation (retry, compaction, feed). A new submission after a
   * TERMINAL lifecycle -- explicitly stopped, or already completed -- is the
   * intentional reset-and-resume sequence: the finished lifecycle is replaced
   * by a fresh one under the same deterministic id, so two competing goal
   * owners can never exist and a new user action never inherits the previous
   * goal's terminal outcome or its spent continuation budget. A *live*
   * lifecycle is never replaced: a re-presentation, and a resubmit while the
   * goal is still open, both return the same intent. Re-presentations never
   * resurrect.
   */
  fresh?: boolean;
}): { intent: ZaicodeGoalIntent; created: boolean } {
  const projectKey = input.projectKey.trim();
  const objective = input.objective.trim();
  const sessionId = input.sessionId ?? null;
  if (!projectKey || !objective) {
    return {
      intent: { intentId: "", projectKey, sessionId, objective, seq: 0, outcome: "waiting", continuations: 0, stopped: false },
      created: false,
    };
  }
  const intentId = zaicodeGoalIntentId(projectKey, sessionId, objective);
  const existing = intents.get(intentId);
  // A fresh submission replaces ANY terminal lifecycle, not only a stopped one:
  // after a completed goal the same prompt is genuinely new work, and hiding it
  // behind the finished intent would report the new run as complete and inherit
  // the old run's spent continuation budget.
  if (existing && !(isZaicodeGoalTerminal(existing.outcome) && input.fresh)) {
    return { intent: existing, created: false };
  }
  seq += 1;
  // T-242: the budget is durable, so where a lifecycle STARTS is a decision, not
  // an accident. A genuine new submission (fresh -- the composer path) starts
  // from zero and clears its old ledger entry: "a new user action never inherits
  // ... its spent continuation budget" still holds, now across a reload. Every
  // other creation -- the observation feed re-registering a goal it finds in a
  // brief after a reload, a restored session -- resumes what that goal already
  // spent, so a reload can never hand the same objective a second full budget.
  const continuations = input.fresh ? 0 : spentZaicodeGoalContinuations(intentId);
  if (input.fresh) writeZaicodeGoalContinuationLedger(intentId, 0);
  const intent: ZaicodeGoalIntent = { intentId, projectKey, sessionId, objective, seq, outcome: "active", continuations, stopped: false };
  intents.set(intentId, intent);
  bumpGoalVersion();
  for (const key of intents.keys()) {
    if (intents.size <= MAX_INTENTS) break;
    intents.delete(key);
  }
  return { intent, created: true };
}

/** The live (non-terminal) intent of a session or project, newest first. */
export function zaicodeGoalLiveIntent(projectKey: string, sessionId?: string | null): ZaicodeGoalIntent | null {
  const key = projectKey.trim();
  const candidates = [...intents.values()]
    .filter((intent) => intent.projectKey === key)
    .filter((intent) => (sessionId ? intent.sessionId === sessionId || intent.sessionId === null : true))
    .filter((intent) => !isZaicodeGoalTerminal(intent.outcome))
    .sort((a, b) => b.seq - a.seq);
  return candidates[0] ?? null;
}

export function zaicodeGoalIntentById(intentId: string): ZaicodeGoalIntent | null {
  return intents.get(intentId) ?? null;
}

export function isZaicodeGoalTerminal(outcome: ZaicodeGoalOutcome): boolean {
  return outcome === "complete" || outcome === "stopped";
}

/**
 * Fold one authoritative observation into the intent outcome. SAIPEN state,
 * never chat text, decides completion: goal reported inactive with no blocker
 * and no pending recovery is terminal.
 */
export function observeZaicodeGoalIntent(intentId: string, observation: ZaicodeGoalObservation): ZaicodeGoalIntent | null {
  const intent = intents.get(intentId);
  if (!intent) return null;
  if (intent.stopped) return intent;
  let outcome: ZaicodeGoalOutcome = intent.outcome;
  if (observation.operatorBlocked) {
    outcome = "blocked";
  } else if (observation.goalActive === true) {
    if (observation.recoverable) outcome = "recovering";
    else if (observation.waiting && !observation.running) outcome = "waiting";
    else if (observation.waiting || observation.running) outcome = "active";
    else outcome = "waiting";
  } else if (observation.goalActive === false && !observation.recoverable) {
    outcome = "complete";
  } else if (observation.recoverable) {
    outcome = "recovering";
  }
  // A fold that changes nothing must not publish a new version: the observation feed
  // runs on every published brief, and an unconditional bump would make every consumer
  // re-run for a state that did not move (an observer that folds on change would then
  // fold forever).
  if (outcome === intent.outcome) return intent;
  const next: ZaicodeGoalIntent = { ...intent, outcome };
  intents.set(intentId, next);
  bumpGoalVersion();
  return next;
}

/**
 * May an owner send a continuation for this intent? Terminal intents, blocked ones
 * and an intent whose previous send has not settled answer no: a blocked state is
 * exposed, not hammered, and a pending send is not sent twice.
 */
export function mayContinueZaicodeGoal(intentId: string): { send: boolean; reason: string } {
  const intent = intents.get(intentId);
  if (!intent) return { send: false, reason: "no such goal intent" };
  if (intent.stopped) return { send: false, reason: "the operator stopped this goal" };
  if (intent.outcome === "complete") return { send: false, reason: "the goal is complete" };
  if (intent.outcome === "blocked") return { send: false, reason: "the goal is blocked on a real dependency" };
  // The budget is asked before the in-flight mark: when both hold, "exhausted" is the
  // durable truth and "in flight" is only what the last claim left behind.
  if (intent.continuations >= ZAICODE_GOAL_MAX_CONTINUATIONS) return { send: false, reason: "continuation budget exhausted" };
  if (intent.pending) return { send: false, reason: "a continuation is already in flight" };
  return { send: true, reason: "the goal is still open" };
}

/** Record that one automatic continuation went out; sets the in-flight mark. */
export function recordZaicodeGoalContinuation(intentId: string, now: number = Date.now()): ZaicodeGoalIntent | null {
  const intent = intents.get(intentId);
  if (!intent) return null;
  // T-242: this is the durable count that a reload has to preserve.
  const spent = intent.continuations + 1;
  writeZaicodeGoalContinuationLedger(intentId, spent);
  const next: ZaicodeGoalIntent = {
    ...intent,
    continuations: spent,
    outcome: "recovering",
    pending: true,
    lastContinuationAt: now,
    failures: 0,
  };
  intents.set(intentId, next);
  bumpGoalVersion();
  return next;
}

/**
 * The atomic claim, and the only way a continuation is spent. The check and the
 * record happen in one synchronous step, so two observers (a re-render, a queue
 * wake-up, a background completion, two owners) cannot both win the same
 * opportunity: the loser's `mayContinueZaicodeGoal` already sees `pending`.
 */
export function claimZaicodeGoalContinuation(
  intentId: string,
  now: number = Date.now(),
): { claimed: true; intent: ZaicodeGoalIntent } | { claimed: false; reason: string } {
  const gate = mayContinueZaicodeGoal(intentId);
  if (!gate.send) return { claimed: false, reason: gate.reason };
  const intent = recordZaicodeGoalContinuation(intentId, now);
  if (!intent) return { claimed: false, reason: "no such goal intent" };
  return { claimed: true, intent };
}

/** The send was accepted: the in-flight mark comes off and the intent keeps its budget. */
export function settleZaicodeGoalContinuation(intentId: string): ZaicodeGoalIntent | null {
  const intent = intents.get(intentId);
  if (!intent) return null;
  if (!intent.pending && (intent.failures ?? 0) === 0) return intent;
  const next: ZaicodeGoalIntent = { ...intent, pending: false, failures: 0 };
  intents.set(intentId, next);
  bumpGoalVersion();
  return next;
}

/**
 * The send was rejected. The claim is released so a later turn can try again, but the
 * failure is counted: an owner reads it to back off instead of hammering a host that
 * keeps saying no. A failed send is never retried on a timer -- the next real turn
 * end (or the operator's click) is the next opportunity.
 */
export function failZaicodeGoalContinuation(intentId: string): ZaicodeGoalIntent | null {
  const intent = intents.get(intentId);
  if (!intent) return null;
  const next: ZaicodeGoalIntent = { ...intent, pending: false, failures: (intent.failures ?? 0) + 1 };
  intents.set(intentId, next);
  bumpGoalVersion();
  return next;
}

/**
 * The operator explicit stop has higher priority than Auto Goal. It stops
 * every live intent of the session and marks them so no owner resurrects them.
 */
export function stopZaicodeGoalIntents(projectKey: string, sessionId?: string | null): number {
  let stoppedCount = 0;
  for (const [id, intent] of intents) {
    if (intent.projectKey !== projectKey.trim()) continue;
    if (sessionId && intent.sessionId !== sessionId && intent.sessionId !== null) continue;
    if (isZaicodeGoalTerminal(intent.outcome)) continue;
    intents.set(id, { ...intent, outcome: "stopped", stopped: true });
    bumpGoalVersion();
    stoppedCount += 1;
  }
  return stoppedCount;
}

/** Auto Goal turned off mid-run: nothing new is registered, live goals are not killed. */
export function detachZaicodeGoalSupervision(projectKey: string): number {
  let detached = 0;
  for (const [id, intent] of intents) {
    if (intent.projectKey !== projectKey.trim()) continue;
    if (isZaicodeGoalTerminal(intent.outcome)) continue;
    intents.set(id, { ...intent, outcome: "waiting" });
    bumpGoalVersion();
    detached += 1;
  }
  return detached;
}

/**
 * The compact truthful readout. One short line, the operator words, never a
 * cockpit: Auto Goal ON/OFF is the switch business; this is the goal.
 */
export function describeZaicodeGoalState(autoGoalEnabled: boolean, intent: ZaicodeGoalIntent | null): string {
  if (!intent) return autoGoalEnabled ? "Auto Goal ON" : "Auto Goal OFF";
  const prefix = autoGoalEnabled ? "Auto Goal ON" : "Auto Goal OFF";
  let state = "Goal stopped";
  if (intent.outcome === "active") state = "Goal active";
  else if (intent.outcome === "recovering") state = "Goal recovering";
  else if (intent.outcome === "waiting") state = "Goal waiting";
  else if (intent.outcome === "blocked") state = "Goal blocked";
  else if (intent.outcome === "complete") state = "Goal complete";
  return prefix + " - " + state;
}

import { useSyncExternalStore } from "react";

/** Extract the goal objective the outgoing prompt actually carries. */
export function zaicodeGoalObjectiveOf(text: string, fallback = "cc all"): string | null {
  const hit = /(^|\s)\/goal\s+([^\n]+)/.exec(text);
  const objective = (hit?.[2] ?? "").trim();
  if (objective) return objective;
  return text.trim() ? fallback : null;
}

// -- live subscription -------------------------------------------------------
// The intent table is a plain Map; owners that render (the composer readout)
// subscribe to a version counter bumped by every mutation below.

let version = 0;
const listeners = new Set<() => void>();
function bumpGoalVersion(): void {
  version += 1;
  for (const notify of listeners) {
    try {
      notify();
    } catch {
      // One deaf listener never blocks the rest.
    }
  }
}

function subscribeGoalVersion(notify: () => void): () => void {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** Re-render the caller whenever any intent mutates. Returns the version. */
export function useZaicodeGoalVersion(): number {
  return useSyncExternalStore(subscribeGoalVersion, () => version, () => version);
}

/** Every intent in the table, newest first. The observation feed walks these. */
export function zaicodeGoalAllIntents(): ZaicodeGoalIntent[] {
  return [...intents.values()].sort((a, b) => b.seq - a.seq);
}

/** The session facts the feed reads. Mirrors ZaicodeSessionBrief, never imports UI. */
export interface ZaicodeGoalBriefFacts {
  sessionId: string;
  projectKey: string;
  running: boolean;
  waiting: boolean;
  manuallyStopped: boolean;
  goalStatus: "active" | "paused" | "budget_limited" | "complete" | null;
  goalObjective: string | null;
}

/**
 * Map one live session brief onto an observation. SAIPEN's goalStatus decides:
 * active = still open; complete = terminal; budget_limited = a real dependency
 * (plan/quota action only the operator can take); paused = parked, resumable
 * through the normal path, never terminal on its own. A session waiting for an
 * answer without running reads as waiting, not working.
 */
export function mapBriefToGoalObservation(brief: ZaicodeGoalBriefFacts): ZaicodeGoalObservation {
  if (brief.manuallyStopped) return { goalActive: false, recoverable: false };
  if (brief.goalStatus === "complete") return { goalActive: false, recoverable: false };
  if (brief.goalStatus === "budget_limited") return { goalActive: true, operatorBlocked: true };
  if (brief.goalStatus === "active") {
    return { goalActive: true, running: brief.running, waiting: brief.waiting };
  }
  return { goalActive: undefined, running: brief.running, waiting: brief.waiting };
}

/**
 * Fold one brief into supervision. Returns the intent after folding, or null
 * when this session carries no goal. Restart/session-restoration path: when
 * Auto Goal is on and the brief still names an objective but the table lost
 * the intent (fresh boot), the intent is re-registered rather than forked --
 * the id is deterministic, so re-registration IS the same intent.
 */
export function observeZaicodeGoalFromBrief(
  brief: ZaicodeGoalBriefFacts,
  autoGoalOn: boolean,
): ZaicodeGoalIntent | null {
  if (!brief.goalObjective || !brief.goalObjective.trim()) return null;
  const objective = brief.goalObjective.trim();
  const intentId = zaicodeGoalIntentId(brief.projectKey, brief.sessionId, objective);
  let intent = zaicodeGoalIntentById(intentId);
  if (!intent && autoGoalOn && !brief.manuallyStopped) {
    intent = registerZaicodeGoalIntent({
      projectKey: brief.projectKey,
      sessionId: brief.sessionId,
      objective,
    }).intent;
  }
  if (!intent) return null;
  return observeZaicodeGoalIntent(intentId, mapBriefToGoalObservation(brief));
}

import { useEffect } from "react";
import { useZaicodeSessionBriefs } from "./zaicodeContinue.js";

/**
 * Live observation feed. Mounted once per composer: every published session
 * brief of this project is folded into supervision, so the intent tracks
 * SAIPEN's goalStatus (active/paused/budget_limited/complete), running and
 * waiting -- across compaction, provider switches, router fallback, worker
 * replacement and session restoration -- without any owner guessing from chat
 * text. Re-runs only when the published briefs actually change.
 */
export function useZaicodeGoalObservationFeed(projectKey: string, autoGoalOn: boolean): void {
  const sessions = useZaicodeSessionBriefs((state) => state.sessions);
  useEffect(() => {
    const key = projectKey.trim();
    if (!key) return;
    for (const brief of sessions) {
      if (brief.projectKey !== key) continue;
      if (!brief.goalObjective) continue;
      observeZaicodeGoalFromBrief(
        {
          sessionId: brief.sessionId,
          projectKey: brief.projectKey,
          running: brief.running,
          waiting: brief.waiting,
          manuallyStopped: brief.manuallyStopped,
          goalStatus: brief.goalStatus,
          goalObjective: brief.goalObjective,
        },
        autoGoalOn,
      );
    }
  }, [sessions, projectKey, autoGoalOn]);
}

/** Test seam: the bounded table is process-local. */
export function resetZaicodeGoalIntentsForTest(): void {
  intents.clear();
  sawRunning.clear();
  seq = 0;
  // T-242: tests assert on spent budget, so reset the ledger too -- otherwise one
  // test's spent continuations bleed into the next through the durable store.
  const store = goalBudgetStore();
  if (store) {
    try { store.removeItem(GOAL_BUDGET_STORAGE_KEY); } catch { /* storage may be disabled */ }
  }
  bumpGoalVersion();
}

// ---------------------------------------------------------- T-234: the owner gate

/**
 * Intents this process has watched running. A goal is only continued after a real
 * turn of its own ended: a fresh boot, a folded brief that was never observed
 * working, or an idle session nobody started is not a turn end, so nothing is sent.
 * Process-local on purpose -- a window reload drops it, which is what keeps a
 * restart from continuing every idle session (the crash resume owns that path, and
 * it only takes what it can prove was cut off).
 */
const sawRunning = new Set<string>();

/** The session brief was seen working: arm (or re-arm) its next continuation. */
export function noteZaicodeGoalSawRunning(intentId: string): void {
  sawRunning.add(intentId);
}

/** Has this intent paid for a turn end since its goal was submitted? */
export function zaicodeGoalSawRunning(intentId: string): boolean {
  return sawRunning.has(intentId);
}

/** Spend the evidence at the claim: one turn end buys exactly one continuation. */
export function spendZaicodeGoalSawRunning(intentId: string): void {
  sawRunning.delete(intentId);
}

/** What the owner asks before it spends one continuation. */
export interface ZaicodeGoalContinuationFacts {
  /** The project's Auto Goal switch (the one next to the composer send control). */
  autoGoalOn: boolean;
  /** The sidebar's stop-all ("no automatic send goes out"). */
  halted: boolean;
  /** The project row is switched off: automatic work never touches it. */
  projectDisabled: boolean;
  /** The session is working right now: the turn has not ended. */
  running: boolean;
  /** The session waits for an operator answer or permission: open it, never continue past it. */
  waiting: boolean;
  /** The last turn ended on an error: the retry watch owns that, not this owner. */
  failed: boolean;
  /** SAIPEN still reports this session's goal as active. */
  goalOpen: boolean;
  /** This owner watched the session run since the goal was submitted. */
  sawRunning: boolean;
  /** A previous continuation send is still unaccounted for. */
  pending: boolean;
}

/**
 * T-234: may ONE continuation go out for this goal right now? Pure, so the
 * whole gate is a truth table the tests can read. Ordered from the operator's
 * authority outwards: their switch, their stop-all, their disabled project, then
 * the session's own state, then the goal's, then our own bookkeeping.
 *
 * Note what is NOT here: a timer, a counter of idle minutes, or a clock. Every
 * reason below is a fact about the world, and anything absent means "no send".
 */
export function zaicodeGoalContinuationAllowed(facts: ZaicodeGoalContinuationFacts): {
  allowed: boolean;
  reason: string;
} {
  if (!facts.autoGoalOn) return { allowed: false, reason: "Auto Goal is off for this project" };
  if (facts.halted) return { allowed: false, reason: "every automatic send is stopped" };
  if (facts.projectDisabled) return { allowed: false, reason: "the project is switched off" };
  if (facts.running) return { allowed: false, reason: "the turn is still running" };
  if (facts.waiting) return { allowed: false, reason: "the session waits for your answer" };
  if (facts.failed) return { allowed: false, reason: "the last turn failed: the retry watch owns it" };
  if (!facts.goalOpen) return { allowed: false, reason: "the goal is not open" };
  if (facts.pending) return { allowed: false, reason: "a continuation is already in flight" };
  if (!facts.sawRunning) return { allowed: false, reason: "no turn has ended since this goal was submitted" };
  return { allowed: true, reason: "the goal is open and its turn has ended" };
}

/** Re-export the preserved text contract so one import covers both halves. */
export { ZAICODE_AUTO_GOAL_SUFFIX, withZaicodeAutoGoal } from "./zaicodeAutoGoal.js";
