import type { ZaicodeGoalOutcome } from "./zaicodeGoalSupervisor.js";

/**
 * T-282 (SAIHANDOFF F-02) / T-242 (SRC-160 R002): the durable half of goal supervision.
 *
 * The intent table is process-local on purpose -- a reload must not resurrect an
 * intent or its turn-end evidence. Two facts are different, and both live here:
 * the SPENT continuation budget (the operator's protection against a goal being
 * continued for ever) and the HAND-BACK state record (the breaker that keeps a goal
 * already handed back from being dispatched again). Same home, same shape, same
 * cap, and outside the supervisor so that file keeps its frozen line budget.
 *
 * ponytail: localStorage + JSON, capped with the intent table. Upgrade path when a
 * second process has to share either record: move it beside the session state on
 * the host.
 */

/** Both records keep at most this many entries, mirroring the intent table's cap. */
const MAX_LEDGER_ENTRIES = 200;

/**
 * T-242 (SRC-160 R002): the SPENT continuations are the one fact that has to
 * survive a renderer reload.
 *
 * The intent table is process-local: restoration derives open objectives from
 * authoritative briefs and never restores the previous process's turn-end evidence.
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
export function writeZaicodeGoalContinuationLedger(intentId: string, spent: number): void {
  const store = goalBudgetStore();
  if (!store || !intentId) return;
  try {
    const ledger = readGoalBudgetLedger();
    if (spent > 0) ledger[intentId] = spent;
    else delete ledger[intentId];
    const ids = Object.keys(ledger);
    for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_LEDGER_ENTRIES))) delete ledger[stale];
    store.setItem(GOAL_BUDGET_STORAGE_KEY, JSON.stringify(ledger));
  } catch {
    // A full or disabled store costs durability, never the continuation in hand.
  }
}

/**
 * T-282 (SAIHANDOFF F-02): the blocker handback.
 *
 * The audit watched the host dispatch sixteen automatic `cc` inputs after SAIPEN
 * had already answered a goal-blocked RESTATE_AND_STOP, and the intent table
 * cannot remember that across a reload: a restored goal is handed an opportunity
 * from a brief that has not caught up with the park yet.
 *
 * What may be dispatched is therefore gated on the state a handback was delivered
 * at. While the authority publishes the same objective at the same revision --
 * whatever the goal row says in the meantime -- the wall stands and nothing goes
 * out. Reactivation is a QUALIFYING CHANGE, never time: a new revision, a
 * different objective, a fresh instruction or the operator's stop, each of which
 * changes or clears the record.
 *
 * ponytail: same durable home as the budget (localStorage + JSON, capped with the
 * intent table). Move it beside the session state on the host when a second
 * process has to share it.
 */
const GOAL_HANDBACK_STORAGE_KEY = "zaicode-goal-handback-v1";

export interface ZaicodeGoalHandback {
  /** The disposition the handback delivered: a parked goal, or a finished one. */
  kind: "blocked" | "complete";
  /** The objective the wall was hit on. A different objective is different work. */
  objective: string;
  /** The authority's state revision at delivery (`brief.updatedAt` as text). */
  revision: string;
}

function readGoalHandbackLedger(): Record<string, ZaicodeGoalHandback> {
  const store = goalBudgetStore();
  if (!store) return {};
  try {
    const raw = store.getItem(GOAL_HANDBACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const ledger: Record<string, ZaicodeGoalHandback> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const row = value as Partial<ZaicodeGoalHandback> | null;
      if (!row || (row.kind !== "blocked" && row.kind !== "complete")) continue;
      // A revision is text over the wire, but a legacy writer may have stored a
      // number: coerce rather than drop, or the wall would silently disappear.
      if (typeof row.objective !== "string") continue;
      if (typeof row.revision !== "string" && typeof row.revision !== "number") continue;
      ledger[id] = { kind: row.kind, objective: row.objective, revision: String(row.revision) };
    }
    return ledger;
  } catch {
    return {};
  }
}

function writeGoalHandbackLedger(intentId: string, record: ZaicodeGoalHandback | null): void {
  const store = goalBudgetStore();
  if (!store || !intentId) return;
  try {
    const ledger = readGoalHandbackLedger();
    if (record) ledger[intentId] = record;
    else delete ledger[intentId];
    const ids = Object.keys(ledger);
    for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_LEDGER_ENTRIES))) delete ledger[stale];
    store.setItem(GOAL_HANDBACK_STORAGE_KEY, JSON.stringify(ledger));
  } catch {
    // A disabled or full store costs the memory of one handback, never a send.
  }
}

/** The handback this intent last delivered, or null when it never handed one back. */
export function zaicodeGoalHandback(intentId: string): ZaicodeGoalHandback | null {
  return readGoalHandbackLedger()[intentId] ?? null;
}

/** Remember the exact state a blocker or finished handback was delivered at. */
export function noteZaicodeGoalHandback(intentId: string, record: ZaicodeGoalHandback): void {
  writeGoalHandbackLedger(intentId, record);
}

/** A qualifying change re-arms: the wall is forgotten. */
export function clearZaicodeGoalHandback(intentId: string): void {
  writeGoalHandbackLedger(intentId, null);
}

/**
 * Does the delivered handback still stand? Yes while the authority publishes the
 * same objective at the same revision: a reload, a re-render or a brief that has
 * not caught up with the park yet must not re-arm a goal the authority already
 * answered. A new revision, a different objective or a cleared record means the
 * wall is gone.
 */
export function zaicodeGoalHandbackStands(
  intentId: string,
  state: { objective: string; revision: string | number | null | undefined },
): boolean {
  const record = zaicodeGoalHandback(intentId);
  if (!record) return false;
  const revision = state.revision === null || state.revision === undefined ? "" : String(state.revision);
  return record.objective === state.objective && record.revision === revision;
}

/**
 * What a state hands back, if anything: `complete` for a finished goal, `blocked`
 * for the authority's parked or budget-limited goal, or for an intent whose own
 * fold says blocked. An unknown status is NOT a handback: "nothing proved it
 * blocked" must never freeze a working goal.
 */
export function zaicodeGoalHandbackKind(input: {
  goalStatus: "active" | "paused" | "budget_limited" | "complete" | null;
  outcome?: ZaicodeGoalOutcome;
}): "blocked" | "complete" | null {
  if (input.goalStatus === "complete") return "complete";
  if (input.goalStatus === "paused" || input.goalStatus === "budget_limited") return "blocked";
  if (input.outcome === "blocked") return "blocked";
  return null;
}

/** The whole handback ledger goes: the test seam, and nothing else. */
export function clearZaicodeGoalHandbacks(): void {
  const store = goalBudgetStore();
  if (!store) return;
  try {
    store.removeItem(GOAL_HANDBACK_STORAGE_KEY);
  } catch {
    // A disabled store has nothing to clear.
  }
}

/** Test seam: both records are durable, so a test must be able to forget them. */
export function resetZaicodeGoalLedgersForTest(): void {
  const store = goalBudgetStore();
  if (!store) return;
  try {
    store.removeItem(GOAL_BUDGET_STORAGE_KEY);
  } catch {
    // storage may be disabled
  }
  clearZaicodeGoalHandbacks();
}
