/* eslint-disable max-lines -- 与 automationRepo/offPeakTaskRepo 同理：ZAICODE 队列仓库集中维护
   zaicode_jobs 的 sqlite schema、原子认领、陈旧完成拒绝与执行租约心跳，稳定后再按读写职责拆分。 */
/* ZAICODE 任务队列仓库：zaicode_jobs 的 sqlite schema、原子认领与状态迁移。
   守卫：单任务认领 single-flight、终态不可逆出、陈旧完成写入被拒绝、
   执行租约心跳用于跨进程重启回收。并发上限与排序语义在服务层，仓库只做存储事实。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  canTransitionZaicodeJob,
  ZAICODE_JOB_STATUSES,
  isZaicodeJobTerminal,
  modelSelectionSchema,
  zaicodeJobDelegationSchema,
  zaicodeJobSchema,
  type ModelSelection,
  type ZaicodeJob,
  type ZaicodeJobDiagnostic,
  type ZaicodeJobListFilter,
  type ZaicodeJobListResult,
  type ZaicodeJobTerminalStatus,
  type ZaicodeJobStatus,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { readZaicodePersistedJson } from "./zaicodePersistedJson.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const TERMINAL_SQL = "'completed','failed','cancelled'";
// T-252 / CORE-006 — SQL 原子写入也必须读取 shared 迁移表；waiting 的恢复属于原运行，不能认领新 attempt。
function transitionSourcesSql(
  to: ZaicodeJobStatus,
  candidates: readonly ZaicodeJobStatus[] = ZAICODE_JOB_STATUSES,
): string {
  const sources = candidates.filter((from) => canTransitionZaicodeJob(from, to));
  return sources.length ? sources.map((status) => `'${status}'`).join(",") : "NULL";
}
const CLAIM_SQL = transitionSourcesSql("running", ["queued", "ready"]);
const BLOCK_BEFORE_DISPATCH_SQL = transitionSourcesSql("blocked", ["queued", "ready"]);
const BLOCK_RUN_SQL = transitionSourcesSql("blocked", ["running"]);
const RESUME_SQL = transitionSourcesSql("queued", ["blocked"]);
const CANCEL_SQL = transitionSourcesSql("cancelled");
// T-248 / SRC-160:R012 — 与 migration 0007 的 idx_zaicode_jobs_open 部分索引逐字一致：
// 有界读取补取"窗口之外仍未终结"的行，必须命中该索引，否则每个 3 秒 tick 都要扫全史。
// 两份列表漂移不会被静默忽略：用例断言这条语句的查询计划命中该索引。
const OPEN_STATUS_SQL = "'draft','queued','ready','running','waiting','blocked'";

// T-243 / SRC-160:R003 — 普通创建与委托子任务共用同一份列/参数清单：原子保留只是给
// 同一个 INSERT 加一个 WHERE，两条写路径不可能在列上悄悄漂移。
const JOB_INSERT_COLUMNS = `job_id, workspace_key, workspace_path, workspace_identity, agent_id, title,
          instructions, status, priority, sort_order, created_at, updated_at, queued_at,
          started_at, finished_at, result_summary, error, session_id, run_id, attempt,
          host_id, heartbeat_at, parent_job_id, retry_of_job_id, delegated_from_run_id,
          delegation_json, actual_model_selection`;
const JOB_INSERT_VALUES = `@id, @workspaceKey, @workspacePath, @workspaceIdentity, @agentId, @title,
          @instructions, @status, @priority, @sortOrder, @createdAt, @updatedAt, @queuedAt,
          @startedAt, @finishedAt, @resultSummary, @error, @sessionId, @runId, @attempt,
          @hostId, @heartbeatAt, @parentJobId, @retryOfJobId, @delegatedFromRunId,
          @delegationJson, @actualModelSelection`;

interface ZaicodeJobRow {
  job_id: string;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  agent_id: string;
  title: string;
  instructions: string;
  status: string;
  priority: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
  queued_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  result_summary: string | null;
  error: string | null;
  session_id: string | null;
  run_id: string | null;
  attempt: number;
  host_id: string | null;
  heartbeat_at: number | null;
  parent_job_id: string | null;
  retry_of_job_id: string | null;
  delegated_from_run_id: string | null;
  delegation_json: string | null;
  actual_model_selection: string | null;
}

function rowToJob(row: ZaicodeJobRow): { job: ZaicodeJob } | { diagnostic: ZaicodeJobDiagnostic } {
  const delegation = readZaicodePersistedJson(
    "delegation_json",
    row.delegation_json,
    zaicodeJobDelegationSchema,
  );
  if ("malformed" in delegation) {
    return {
      diagnostic: { jobId: row.job_id, code: "invalid-job", message: delegation.malformed },
    };
  }
  const actual = readZaicodePersistedJson(
    "actual_model_selection",
    row.actual_model_selection,
    modelSelectionSchema,
  );
  if ("malformed" in actual) {
    return { diagnostic: { jobId: row.job_id, code: "invalid-job", message: actual.malformed } };
  }
  const candidate = {
    id: row.job_id,
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    agentId: row.agent_id,
    title: row.title,
    instructions: row.instructions,
    status: row.status,
    priority: row.priority,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    queuedAt: row.queued_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    resultSummary: row.result_summary ?? undefined,
    error: row.error ?? undefined,
    sessionId: row.session_id ?? undefined,
    runId: row.run_id ?? undefined,
    attempt: row.attempt,
    hostId: row.host_id ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    parentJobId: row.parent_job_id ?? undefined,
    retryOfJobId: row.retry_of_job_id ?? undefined,
    delegatedFromRunId: row.delegated_from_run_id ?? undefined,
    delegation: delegation.value,
    actualModelSelection: actual.value,
  };
  const parsed = zaicodeJobSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      diagnostic: {
        jobId: row.job_id,
        code: "invalid-job",
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      },
    };
  }
  return { job: parsed.data };
}

/** 行序由调用方给出（有界读取是按同一次排序取出的），这里只做反序列化分流。 */
function toListResult(rows: ZaicodeJobRow[]): ZaicodeJobListResult {
  const jobs: ZaicodeJob[] = [];
  const diagnostics: ZaicodeJobDiagnostic[] = [];
  for (const row of rows) {
    const result = rowToJob(row);
    if ("job" in result) jobs.push(result.job);
    else diagnostics.push(result.diagnostic);
  }
  return { jobs, diagnostics };
}

/**
 * T-248 / SRC-160:R010 — 有界读取的两条语句本身是性能契约（第一条必须由
 * idx_zaicode_jobs_recent 满足，不允许 TEMP B-TREE）。导出它们，让用例直接对
 * 生产执行的同一段 SQL 做 EXPLAIN QUERY PLAN，而不是另抄一份各自漂移。
 */
export function zaicodeJobBoundedReadSql(conditions: string[]): {
  recent: string;
  olderActive: string;
} {
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  return {
    recent: `SELECT * FROM zaicode_jobs${where}
         ORDER BY created_at DESC, sort_order DESC
         LIMIT @limit`,
    olderActive: `SELECT * FROM zaicode_jobs WHERE ${[
      ...conditions,
      "(created_at < @windowStart OR (created_at = @windowStart AND sort_order < @windowSort))",
      `status IN (${OPEN_STATUS_SQL})`,
    ].join(" AND ")}
         ORDER BY created_at DESC, sort_order DESC`,
  };
}

function serializeModelSelection(selection: ModelSelection | undefined): string | null {
  return selection ? JSON.stringify(modelSelectionSchema.parse(selection)) : null;
}

export interface ZaicodeJobTerminalWrite {
  job: ZaicodeJob | null;
  applied: boolean;
  /** 写入被拒绝且原因是 run/attempt 与当前行不符：陈旧完成。 */
  stale: boolean;
}

export class ZaicodeJobRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private initializationGeneration = 0;
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) this.close();
    if (!this.initializePromise) {
      const generation = this.initializationGeneration;
      this.initializePromise = this.initialize(path, generation).catch((error) => {
        if (generation === this.initializationGeneration) this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    this.initializationGeneration += 1;
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string, generation: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // T-252 / W2-005 — close 是代际屏障；旧 mkdir 续体不能打开数据库，也不能清理新一代初始化。
    if (generation !== this.initializationGeneration)
      throw new Error("ZaicodeJobRepo initialization_cancelled: closed during startup");
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) throw new Error("ZaicodeJobRepo 未初始化：请先 await ensureReady()");
    return this.db;
  }

  // ---- 读取 ----

  async list(filter: ZaicodeJobListFilter = {}): Promise<ZaicodeJobListResult> {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};
    if (filter.workspaceKey) {
      conditions.push("workspace_key = @workspaceKey");
      params.workspaceKey = filter.workspaceKey;
    }
    if (filter.status) {
      conditions.push("status = @status");
      params.status = filter.status;
    }
    if (filter.agentId) {
      conditions.push("agent_id = @agentId");
      params.agentId = filter.agentId;
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const database = this.getDatabase();
    const limit = filter.limit;

    // T-248 / SRC-160:R010 — 活跃轮询必须有界：先取最新的 limit 行，idx_zaicode_jobs_recent
    // 直接满足这条排序，LIMIT 让扫描提前结束。窗口填满时再补一次窗口之外仍未终结的行，
    // 仍在跑的任务无论多旧都留在队列里，被截断的只是终结历史。省略 limit 的调用全量读取，
    // 语义与从前逐字一致。
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
      const rows = database
        .prepare(
          `SELECT * FROM zaicode_jobs${where}
           ORDER BY created_at ASC, sort_order ASC`,
        )
        .all(params) as unknown as ZaicodeJobRow[];
      return toListResult(rows);
    }

    const bounded = Math.floor(limit);
    const boundedSql = zaicodeJobBoundedReadSql(conditions);
    const recentRows = database
      .prepare(boundedSql.recent)
      .all({ ...params, limit: bounded }) as unknown as ZaicodeJobRow[];
    // 窗口没填满就是全部匹配行：反过来即原先的升序结果。
    if (recentRows.length < bounded) return toListResult([...recentRows].reverse());

    const edge = recentRows[recentRows.length - 1];
    if (!edge) return toListResult([...recentRows].reverse());
    const olderRows = database.prepare(boundedSql.olderActive).all({
      ...params,
      windowStart: edge.created_at,
      windowSort: edge.sort_order,
    }) as unknown as ZaicodeJobRow[];

    const merged = new Map<string, ZaicodeJobRow>();
    for (const row of [...recentRows, ...olderRows]) merged.set(row.job_id, row);
    const ordered = [...merged.values()].sort(
      (a, b) => a.created_at - b.created_at || a.sort_order - b.sort_order,
    );
    return toListResult(ordered);
  }

  async get(jobId: string): Promise<ZaicodeJob | null> {
    const row = this.getDatabase()
      .prepare("SELECT * FROM zaicode_jobs WHERE job_id = ?")
      .get(jobId) as ZaicodeJobRow | undefined;
    if (!row) return null;
    const result = rowToJob(row);
    return "job" in result ? result.job : null;
  }

  async listChildren(parentJobId: string): Promise<ZaicodeJob[]> {
    const rows = this.getDatabase()
      .prepare("SELECT * FROM zaicode_jobs WHERE parent_job_id = ? ORDER BY created_at ASC")
      .all(parentJobId) as unknown as ZaicodeJobRow[];
    return rows.flatMap((row) => {
      const result = rowToJob(row);
      return "job" in result ? [result.job] : [];
    });
  }

  /**
   * T-243 / SRC-160:R003 — 一次父运行已经创建了多少 helper。配额按委托运行计，
   * 不按父任务行计：同一条行换成新 runId 重跑时从零起算，编排探针子任务
   * （只有 parent_job_id、没有委托运行）永不计入。命中 idx_zaicode_jobs_delegation。
   */
  countDelegatedChildren(parentJobId: string, delegatingRunId: string): number {
    const row = this.getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count FROM zaicode_jobs
         WHERE parent_job_id = ? AND delegated_from_run_id = ?`,
      )
      .get(parentJobId, delegatingRunId) as { count: number };
    return row.count;
  }

  nextSortOrder(workspaceKey: string): number {
    const row = this.getDatabase()
      .prepare(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM zaicode_jobs WHERE workspace_key = ?",
      )
      .get(workspaceKey) as { next: number };
    return row.next;
  }

  countRunning(workspaceKey?: string): number {
    const row = workspaceKey
      ? (this.getDatabase()
          .prepare(
            `SELECT COUNT(*) AS count FROM zaicode_jobs WHERE status = 'running' AND workspace_key = ?`,
          )
          .get(workspaceKey) as { count: number })
      : (this.getDatabase()
          .prepare(`SELECT COUNT(*) AS count FROM zaicode_jobs WHERE status = 'running'`)
          .get() as { count: number });
    return row.count;
  }

  listEligible(workspaceKey: string, limit: number): ZaicodeJob[] {
    if (limit <= 0) return [];
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM zaicode_jobs
         WHERE workspace_key = @workspaceKey AND status IN ('queued','ready')
         ORDER BY priority DESC, sort_order ASC, created_at ASC
         LIMIT @limit`,
      )
      .all({ workspaceKey, limit }) as unknown as ZaicodeJobRow[];
    return rows.flatMap((row) => {
      const result = rowToJob(row);
      return "job" in result ? [result.job] : [];
    });
  }

  // ---- 写入 ----

  async create(job: ZaicodeJob): Promise<void> {
    this.insertJob(zaicodeJobSchema.parse(job));
  }

  /**
   * T-243 / SRC-160:R003 — 委托子任务的"配额保留 + 落库"是**一条语句**：配额判定
   * 写进 INSERT ... SELECT 的 WHERE，所以两个并发请求不可能都看到 count = max - 1。
   * 返回 false 表示该运行的配额已满，且没有行被写入；调用方按 budget_exhausted 上报，
   * 绝不静默超发，也不需要另开事务。
   */
  async createDelegatedChild(job: ZaicodeJob, maxPerRun: number): Promise<boolean> {
    return this.insertJob(zaicodeJobSchema.parse(job), maxPerRun) > 0;
  }

  private insertJob(job: ZaicodeJob, maxPerRun?: number): number {
    const params = {
      id: job.id,
      workspaceKey: job.workspaceKey,
      workspacePath: job.workspacePath,
      workspaceIdentity: job.workspaceIdentity ?? null,
      agentId: job.agentId,
      title: job.title,
      instructions: job.instructions,
      status: job.status,
      priority: job.priority,
      sortOrder: job.sortOrder,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      queuedAt: job.queuedAt ?? null,
      startedAt: job.startedAt ?? null,
      finishedAt: job.finishedAt ?? null,
      resultSummary: job.resultSummary ?? null,
      error: job.error ?? null,
      sessionId: job.sessionId ?? null,
      runId: job.runId ?? null,
      attempt: job.attempt,
      hostId: job.hostId ?? null,
      heartbeatAt: job.heartbeatAt ?? null,
      parentJobId: job.parentJobId ?? null,
      retryOfJobId: job.retryOfJobId ?? null,
      delegatedFromRunId: job.delegatedFromRunId ?? null,
      delegationJson: job.delegation ? JSON.stringify(job.delegation) : null,
      actualModelSelection: serializeModelSelection(job.actualModelSelection),
    };
    const db = this.getDatabase();
    const info =
      maxPerRun === undefined
        ? db
            .prepare(
              `INSERT INTO zaicode_jobs (${JOB_INSERT_COLUMNS}) VALUES (${JOB_INSERT_VALUES})`,
            )
            .run(params)
        : db
            .prepare(
              `INSERT INTO zaicode_jobs (${JOB_INSERT_COLUMNS})
               SELECT ${JOB_INSERT_VALUES}
               WHERE (SELECT COUNT(*) FROM zaicode_jobs
                      WHERE parent_job_id = @parentJobId AND delegated_from_run_id = @delegatedFromRunId) < @maxPerRun`,
            )
            .run({ ...params, maxPerRun });
    return Number(info.changes);
  }

  /** 只允许编辑未执行的可见字段；running/终态行拒绝改写。 */
  async updateEditable(
    jobId: string,
    patch: { title?: string; instructions?: string; priority?: number },
    now: number,
  ): Promise<ZaicodeJob | null> {
    const current = await this.get(jobId);
    if (!current) return null;
    if (current.status === "running" || isZaicodeJobTerminal(current.status)) return current;
    this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          title = @title, instructions = @instructions, priority = @priority, updated_at = @now
         WHERE job_id = @jobId AND status NOT IN ('running', ${TERMINAL_SQL})`,
      )
      .run({
        jobId,
        title: patch.title ?? current.title,
        instructions: patch.instructions ?? current.instructions,
        priority: patch.priority ?? current.priority,
        now,
      });
    return this.get(jobId);
  }

  /** 原子认领新运行：仅 shared 允许的 queued/ready；blocked 必须先 Resume（single-flight）。 */
  async claimForDispatch(params: {
    jobId: string;
    runId: string;
    hostId: string;
    now: number;
  }): Promise<ZaicodeJob | null> {
    const result = this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          status = 'running',
          run_id = @runId,
          host_id = @hostId,
          heartbeat_at = @now,
          started_at = @now,
          finished_at = NULL,
          session_id = NULL,
          actual_model_selection = NULL,
          result_summary = NULL,
          attempt = attempt + 1,
          error = NULL,
          updated_at = @now
         WHERE job_id = @jobId AND status IN (${CLAIM_SQL})`,
      )
      .run(params);
    if (Number(result.changes) === 0) return null;
    return this.get(params.jobId);
  }

  async attachSession(params: {
    jobId: string;
    runId: string;
    sessionId: string;
    actualModelSelection?: ModelSelection;
    now: number;
  }): Promise<void> {
    this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          session_id = @sessionId,
          actual_model_selection = @actualModelSelection,
          updated_at = @now
         WHERE job_id = @jobId AND run_id = @runId AND status = 'running'`,
      )
      .run({
        jobId: params.jobId,
        runId: params.runId,
        sessionId: params.sessionId,
        actualModelSelection: serializeModelSelection(params.actualModelSelection),
        now: params.now,
      });
  }

  /**
   * 终态写入：条件匹配 run_id + attempt，保证陈旧完成（旧 run 在新 retry 之后到达）
   * 无法覆盖新状态；已是终态行则幂等空转。
   */
  async markTerminal(params: {
    jobId: string;
    runId: string;
    attempt: number;
    status: ZaicodeJobTerminalStatus;
    resultSummary?: string;
    error?: string;
    actualModelSelection?: ModelSelection;
    now: number;
  }): Promise<ZaicodeJobTerminalWrite> {
    const result = this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          status = @status,
          result_summary = @resultSummary,
          error = @error,
          actual_model_selection = COALESCE(@actualModelSelection, actual_model_selection),
          finished_at = @now,
          updated_at = @now,
          host_id = NULL,
          heartbeat_at = NULL
         WHERE job_id = @jobId AND status IN (${transitionSourcesSql(params.status, ["running"])})
           AND run_id = @runId AND attempt = @attempt`,
      )
      .run({
        jobId: params.jobId,
        runId: params.runId,
        attempt: params.attempt,
        status: params.status,
        resultSummary: params.resultSummary ?? null,
        error: params.error ?? null,
        actualModelSelection: serializeModelSelection(params.actualModelSelection),
        now: params.now,
      });
    const job = await this.get(params.jobId);
    const applied = Number(result.changes) > 0;
    const stale =
      !applied && job !== null && (job.runId !== params.runId || job.attempt !== params.attempt);
    return { job, applied, stale };
  }

  /** 派发前拒绝（agent 缺失/禁用等）：非破坏地把可派发行落到 blocked，保留人工恢复入口。 */
  async blockForDispatch(jobId: string, error: string, now: number): Promise<ZaicodeJob | null> {
    this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET status = 'blocked', error = @error, updated_at = @now
         WHERE job_id = @jobId AND status IN (${BLOCK_BEFORE_DISPATCH_SQL})`,
      )
      .run({ jobId, error, now });
    return this.get(jobId);
  }

  async markBlocked(params: {
    jobId: string;
    runId: string;
    attempt: number;
    error: string;
    now: number;
  }): Promise<ZaicodeJob | null> {
    this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          status = 'blocked', error = @error, finished_at = @now, updated_at = @now,
          host_id = NULL, heartbeat_at = NULL
         WHERE job_id = @jobId AND status IN (${BLOCK_RUN_SQL})
           AND run_id = @runId AND attempt = @attempt`,
      )
      .run(params);
    return this.get(params.jobId);
  }

  /** 取消幂等：非终态行转 cancelled；已终态行原样返回（applied=false）。 */
  async cancel(jobId: string, now: number): Promise<{ job: ZaicodeJob | null; applied: boolean }> {
    const result = this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          status = 'cancelled', finished_at = @now, updated_at = @now,
          host_id = NULL, heartbeat_at = NULL
         WHERE job_id = @jobId AND status IN (${CANCEL_SQL})`,
      )
      .run({ jobId, now });
    return { job: await this.get(jobId), applied: Number(result.changes) > 0 };
  }

  /** A cancelled intent can still have a runtime whose stop failed; retain that failure for UI retry. */
  async setCancellationStopError(jobId: string, error: string | null, now: number): Promise<void> {
    this.getDatabase()
      .prepare(
        "UPDATE zaicode_jobs SET error = @error, updated_at = @now WHERE job_id = @jobId AND status = 'cancelled'",
      )
      .run({ jobId, error, now });
  }

  /** 恢复后只投影本次队列事实；保留 attempt/run 标识供陈旧写入判定，旧会话仍由上游历史持有。 */
  async resumeBlocked(jobId: string, now: number): Promise<ZaicodeJob | null> {
    this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          status = 'queued', queued_at = @now, updated_at = @now,
          started_at = NULL, finished_at = NULL, session_id = NULL,
          actual_model_selection = NULL, result_summary = NULL, error = NULL,
          host_id = NULL, heartbeat_at = NULL
         WHERE job_id = @jobId AND status IN (${RESUME_SQL})`,
      )
      .run({ jobId, now });
    return this.get(jobId);
  }

  heartbeat(hostId: string, now: number): number {
    const result = this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET heartbeat_at = @now
         WHERE status = 'running' AND host_id = @hostId`,
      )
      .run({ hostId, now });
    return Number(result.changes);
  }

  /** 回收无心跳/过期心跳的 running 行：进程崩溃或重启后不得静默变成 completed。 */
  reclaimStaleRunning(now: number, staleMs: number): number {
    const result = this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          status = 'blocked',
          error = CASE WHEN error IS NULL THEN 'interrupted_by_restart' ELSE error END,
          updated_at = @now, host_id = NULL, heartbeat_at = NULL
         WHERE status IN (${BLOCK_RUN_SQL}) AND (heartbeat_at IS NULL OR heartbeat_at <= @threshold)`,
      )
      .run({ now, threshold: now - staleMs });
    return Number(result.changes);
  }

  /**
   * 主动释放本 host 的 running 租约（优雅退出）：进程知道自己要走了，就不该把一个
   * 新鲜心跳留给下一次启动去信任——2 分钟过期窗口内重启的经典漏洞（SRC-161:W2-001）。
   * 只碰自己的 host_id，不碰别人的行；结果未知时不伪造 success/failure，统一 blocked。
   */
  releaseRunningForHost(hostId: string, now: number, reason: string): number {
    const result = this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          status = 'blocked',
          error = CASE WHEN error IS NULL THEN @reason ELSE error END,
          updated_at = @now, host_id = NULL, heartbeat_at = NULL
         WHERE status IN (${BLOCK_RUN_SQL}) AND host_id = @hostId`,
      )
      .run({ hostId, now, reason });
    return Number(result.changes);
  }

  /** 安全重排：仅在草稿/排队/就绪/阻塞集合内与相邻任务交换 sort_order。 */
  async swapOrder(jobId: string, direction: "up" | "down", now: number): Promise<boolean> {
    const current = await this.get(jobId);
    if (!current) return false;
    if (!["draft", "queued", "ready", "blocked"].includes(current.status)) return false;
    const siblings = this.getDatabase()
      .prepare(
        `SELECT job_id, sort_order FROM zaicode_jobs
         WHERE workspace_key = @workspaceKey AND status IN ('draft','queued','ready','blocked')
         ORDER BY priority DESC, sort_order ASC, created_at ASC`,
      )
      .all({ workspaceKey: current.workspaceKey }) as unknown as {
      job_id: string;
      sort_order: number;
    }[];
    const index = siblings.findIndex((row) => row.job_id === jobId);
    const neighborIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || neighborIndex < 0 || neighborIndex >= siblings.length) return false;
    const other = siblings[neighborIndex];
    if (!other) return false;
    const update = this.getDatabase().prepare(
      "UPDATE zaicode_jobs SET sort_order = @sortOrder, updated_at = @now WHERE job_id = @jobId",
    );
    update.run({ jobId, sortOrder: other.sort_order, now });
    update.run({ jobId: other.job_id, sortOrder: current.sortOrder, now });
    return true;
  }

  async remove(jobId: string): Promise<boolean> {
    const result = this.getDatabase()
      .prepare(
        `DELETE FROM zaicode_jobs
         WHERE job_id = ? AND status IN ('draft','completed','failed','cancelled')`,
      )
      .run(jobId);
    return Number(result.changes) > 0;
  }

  getSetting(key: string): string | null {
    const row = this.getDatabase()
      .prepare("SELECT value FROM zaicode_settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string, now: number): void {
    this.getDatabase()
      .prepare(
        `INSERT INTO zaicode_settings (key, value, updated_at) VALUES (@key, @value, @now)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @now`,
      )
      .run({ key, value, now });
  }
}
