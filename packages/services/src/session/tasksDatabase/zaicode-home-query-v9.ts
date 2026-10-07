// T-254 — workspace 前缀索引无法满足全局首页的 LIMIT 排序；日计数只走状态/结束时间范围。
// 只新增索引，历史迁移及其 checksum 保持冻结，现存任务不改写、不删除。
export const ZAICODE_HOME_QUERY_MIGRATION_SQL = `
  CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_home_recent
  ON zaicode_jobs (created_at DESC, sort_order DESC, job_id DESC);

  CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_home_finished
  ON zaicode_jobs (status, finished_at);
`;
