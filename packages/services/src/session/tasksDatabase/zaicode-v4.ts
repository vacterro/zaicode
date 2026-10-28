/**
 * ZAICODE 产品层表结构（handoff M5/M7）。
 *
 * 与 tasks-index.sqlite 同库同属主：agent 定义与任务队列都是操作员可见的持久事实。
 * 发布后不可修改本文件中的既有声明，后续变更一律新增 migration。
 */
export const ZAICODE_SCHEMA = `
      CREATE TABLE IF NOT EXISTS zaicode_agents (
        agent_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        model_selection TEXT,
        provider_ref TEXT,
        model_ref TEXT,
        reasoning_effort TEXT,
        tool_policy_json TEXT NOT NULL DEFAULT '{}',
        template_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS zaicode_jobs (
        job_id TEXT PRIMARY KEY,
        workspace_key TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_identity TEXT,
        agent_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        queued_at INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        result_summary TEXT,
        error TEXT,
        session_id TEXT,
        run_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        host_id TEXT,
        heartbeat_at INTEGER,
        parent_job_id TEXT,
        retry_of_job_id TEXT,
        delegation_json TEXT,
        actual_model_selection TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_workspace
      ON zaicode_jobs (workspace_key, status, priority DESC, sort_order, created_at);

      CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_eligible
      ON zaicode_jobs (status, priority DESC, sort_order, created_at);

      CREATE INDEX IF NOT EXISTS idx_zaicode_jobs_parent
      ON zaicode_jobs (parent_job_id, created_at)
      WHERE parent_job_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS zaicode_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `;
