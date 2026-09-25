/**
 * SAIHOME local statistics (T-56), additive to tasks-index.sqlite.
 *
 * zaicode_stats_events owns the durable history: one row per event with a
 * source-scoped stable id ("model:<model_usage.id>", "turn:<session>:<turn>",
 * "job:<job>:<attempt>", "worker:<worker>"), so replays and restarts insert
 * nothing twice (INSERT OR IGNORE). Token columns are NULL where the source
 * did not measure them. zaicode_stats_cursor remembers how far each source
 * was read. Existing job/agent tables are not touched.
 *
 * Frozen once released: later changes add a new migration.
 */
export const ZAICODE_STATS_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS zaicode_stats_events (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    started_at INTEGER,
    duration_ms INTEGER,
    project TEXT,
    session_id TEXT,
    job_id TEXT,
    agent TEXT,
    engine TEXT,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    reasoning_tokens INTEGER,
    total_tokens INTEGER,
    result TEXT,
    failure TEXT,
    retry_of TEXT,
    recorded_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_zaicode_stats_events_at ON zaicode_stats_events (at);
  CREATE INDEX IF NOT EXISTS idx_zaicode_stats_events_kind_at ON zaicode_stats_events (kind, at);

  CREATE TABLE IF NOT EXISTS zaicode_stats_cursor (
    source TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;
