/**
 * T-248 / SRC-160:R012 — indexes for the bounded active-poll read.
 *
 * The 3 s workspace poll reads the newest jobs for one workspace ordered by
 * (created_at DESC, sort_order DESC). `idx_zaicode_jobs_workspace` starts
 * (workspace_key, status, …), so it can serve the workspace filter but never
 * that ORDER BY — SQLite had to sort the whole history before applying a limit,
 * and before T-248 there was no limit at all. `idx_zaicode_jobs_recent` carries
 * exactly the poll's ordering, so the bounded query walks the index in order and
 * stops at the LIMIT.
 *
 * The poll then adds back the jobs older than that window that are still open,
 * and without an index of its own that follow-up read walks the whole history on
 * every tick (measured: 31 ms at 100k terminal jobs, 167 ms at 500k — bounded in
 * rows, unbounded in work). `idx_zaicode_jobs_open` is a partial index over just
 * the non-terminal rows, so that read costs the number of open jobs rather than
 * the number of finished ones. Its status list is written out here literally and
 * is deliberately not derived from shared code: this text is the migration's
 * checksum identity. `zaicodeJobRepo.list` must use the same list, which the
 * services suite enforces by asserting the follow-up read is satisfied by this
 * index (a drifted list would fall back to a table scan).
 *
 * Only indexes: `zaicode-v4` is frozen once released, later changes add a new
 * migration (checksum identity is the SQL text, so edit nowhere but here).
 */
export const ZAICODE_JOB_QUERY_MIGRATION_SQL = `
  CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_recent
  ON zaicode_jobs (workspace_key, created_at DESC, sort_order DESC);

  CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_open
  ON zaicode_jobs (workspace_key, created_at DESC, sort_order DESC)
  WHERE status IN ('draft','queued','ready','running','waiting','blocked');
`;
