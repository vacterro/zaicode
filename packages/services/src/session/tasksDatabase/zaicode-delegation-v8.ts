/**
 * T-243 / SRC-160:R003 — the run a helper was delegated for, and the index the
 * per-run budget count reads.
 *
 * The budget the operator sees ("at most N helpers for this run") was counted per
 * parent ROW: `delegateZaicodeJobFromRun` asked `listChildren(parentJobId)` and
 * compared its length with `maxChildrenPerParent`. Two things were wrong with that.
 * The count is not the run's: a parent row that runs again under a new run id —
 * crash recovery re-claims the same row — inherited the previous run's children, so
 * the new run silently got fewer helpers than promised, and nothing durable recorded
 * which run a helper belonged to. And the read and the insert were two statements,
 * so two delegations arriving together both saw `count = max - 1` and both created.
 *
 * `delegated_from_run_id` is that missing fact: it is written by the delegation path
 * only (never by the ordinary create path, and never by an orchestration-probe child,
 * which carries a parent link and no run), it is what the count groups by, and it is
 * what makes the atomic reservation below expressible as one statement. The index
 * carries both columns of that count, so the reservation does not scan the parent's
 * history on every request.
 *
 * `zaicode-v4` is frozen once released, so the column arrives as its own migration;
 * a fresh database gets the table from `0004` and this `ALTER` over it, and a legacy
 * one gets it the same way. DDL is transactional in SQLite, so a process that dies
 * mid-migration rolls the column back with the ledger row and re-runs cleanly.
 */
export const ZAICODE_DELEGATION_MIGRATION_SQL = `
  ALTER TABLE zaicode_jobs ADD COLUMN delegated_from_run_id TEXT;

  CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_delegation
  ON zaicode_jobs (parent_job_id, delegated_from_run_id);
`;
