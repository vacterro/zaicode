// T-256：按结束时间与稳定键续页；读者不修改 Agent 库，索引由原存储迁移所有者建立。
export const STATISTICS_COMPLETION_INDEXES_MIGRATION_SQL = `
  CREATE INDEX IF NOT EXISTS model_usage_stats_completion_idx
  ON model_usage(COALESCE(completed_at, started_at), id) WHERE status != 'running';
  CREATE INDEX IF NOT EXISTS turn_usage_stats_completion_idx
  ON turn_usage(COALESCE(completed_at, started_at), session_id, turn_id) WHERE status != 'running';
`;
