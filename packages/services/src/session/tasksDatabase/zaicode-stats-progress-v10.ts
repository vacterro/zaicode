// T-256：整数水位无法记录同一时间的字符串键；仅新增统计进度与队列索引，不改历史迁移。
export const ZAICODE_STATS_PROGRESS_MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS zaicode_stats_progress (
    source TEXT PRIMARY KEY,
    since_at INTEGER NOT NULL,
    until_at INTEGER NOT NULL,
    after_at INTEGER NOT NULL,
    after_id TEXT NOT NULL,
    after_key TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_stats_completion
  ON zaicode_jobs(finished_at, job_id)
  WHERE status IN ('completed','failed','cancelled') AND finished_at IS NOT NULL;
`;
