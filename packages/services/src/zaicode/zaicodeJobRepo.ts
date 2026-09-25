/* eslint-disable max-lines -- 与 automationRepo/offPeakTaskRepo 同理：ZAICODE 队列仓库集中维护
   zaicode_jobs 的 sqlite schema、原子认领、陈旧完成拒绝与执行租约心跳，稳定后再按读写职责拆分。 */
/* ZAICODE 任务队列仓库：zaicode_jobs 的 sqlite schema、原子认领与状态迁移。
   守卫：单任务认领 single-flight、终态不可逆出、陈旧完成写入被拒绝、
   执行租约心跳用于跨进程重启回收。并发上限与排序语义在服务层，仓库只做存储事实。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
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
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

const TERMINAL_SQL = "'completed','failed','cancelled'";

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
  delegation_json: string | null;
  actual_model_selection: string | null;
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function rowToJob(row: ZaicodeJobRow): { job: ZaicodeJob } | { diagnostic: ZaicodeJobDiagnostic } {
  const delegation = zaicodeJobDelegationSchema.safeParse(parseJson(row.delegation_json));
  const actual = modelSelectionSchema.safeParse(parseJson(row.actual_model_selection));
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
    delegation: delegation.success ? delegation.data : undefined,
    actualModelSelection: actual.success ? actual.data : undefined,
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
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
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

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
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
    const params: Record<string, string> = {};
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
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM zaicode_jobs${where}
         ORDER BY created_at ASC, sort_order ASC`,
      )
      .all(params) as unknown as ZaicodeJobRow[];
    const jobs: ZaicodeJob[] = [];
    const diagnostics: ZaicodeJobDiagnostic[] = [];
    for (const row of rows) {
      const result = rowToJob(row);
      if ("job" in result) jobs.push(result.job);
      else diagnostics.push(result.diagnostic);
    }
    return { jobs, diagnostics };
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
    const validated = zaicodeJobSchema.parse(job);
    this.getDatabase()
      .prepare(
        `INSERT INTO zaicode_jobs (
          job_id, workspace_key, workspace_path, workspace_identity, agent_id, title,
          instructions, status, priority, sort_order, created_at, updated_at, queued_at,
          started_at, finished_at, result_summary, error, session_id, run_id, attempt,
          host_id, heartbeat_at, parent_job_id, retry_of_job_id, delegation_json,
          actual_model_selection
        ) VALUES (
          @id, @workspaceKey, @workspacePath, @workspaceIdentity, @agentId, @title,
          @instructions, @status, @priority, @sortOrder, @createdAt, @updatedAt, @queuedAt,
          @startedAt, @finishedAt, @resultSummary, @error, @sessionId, @runId, @attempt,
          @hostId, @heartbeatAt, @parentJobId, @retryOfJobId, @delegationJson,
          @actualModelSelection
        )`,
      )
      .run({
        id: validated.id,
        workspaceKey: validated.workspaceKey,
        workspacePath: validated.workspacePath,
        workspaceIdentity: validated.workspaceIdentity ?? null,
        agentId: validated.agentId,
        title: validated.title,
        instructions: validated.instructions,
        status: validated.status,
        priority: validated.priority,
        sortOrder: validated.sortOrder,
        createdAt: validated.createdAt,
        updatedAt: validated.updatedAt,
        queuedAt: validated.queuedAt ?? null,
        startedAt: validated.startedAt ?? null,
        finishedAt: validated.finishedAt ?? null,
        resultSummary: validated.resultSummary ?? null,
        error: validated.error ?? null,
        sessionId: validated.sessionId ?? null,
        runId: validated.runId ?? null,
        attempt: validated.attempt,
        hostId: validated.hostId ?? null,
        heartbeatAt: validated.heartbeatAt ?? null,
        parentJobId: validated.parentJobId ?? null,
        retryOfJobId: validated.retryOfJobId ?? null,
        delegationJson: validated.delegation ? JSON.stringify(validated.delegation) : null,
        actualModelSelection: serializeModelSelection(validated.actualModelSelection),
      });
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

  /** 原子认领并进入 running：queued/ready/blocked 之外的状态一律拒绝（single-flight）。 */
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
          attempt = attempt + 1,
          error = NULL,
          updated_at = @now
         WHERE job_id = @jobId AND status IN ('queued','ready','blocked')`,
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
         WHERE job_id = @jobId AND status = 'running'
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
         WHERE job_id = @jobId AND status IN ('queued','ready')`,
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
         WHERE job_id = @jobId AND status = 'running'
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
         WHERE job_id = @jobId AND status NOT IN (${TERMINAL_SQL})`,
      )
      .run({ jobId, now });
    return { job: await this.get(jobId), applied: Number(result.changes) > 0 };
  }

  /** 恢复 blocked 任务到队列（不重置 attempt/run 历史，供审计）。 */
  async resumeBlocked(jobId: string, now: number): Promise<ZaicodeJob | null> {
    this.getDatabase()
      .prepare(
        `UPDATE zaicode_jobs SET
          status = 'queued', updated_at = @now, host_id = NULL, heartbeat_at = NULL
         WHERE job_id = @jobId AND status = 'blocked'`,
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
         WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at <= @threshold)`,
      )
      .run({ now, threshold: now - staleMs });
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
