/* eslint-disable max-lines -- one owner module: every zaicode_stats_events query (global buckets, scope slices, breakdown, activity) lives with its schema so a query and its columns never drift apart. */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  ZAICODE_STATS_BUCKET_MS,
  type ZaicodeStatsBreakdownInput,
  type ZaicodeStatsBucket,
  type ZaicodeRouterUsageScopeRequest, type ZaicodeRouterScopedUsage, type ZaicodeRouterUsageCount,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import {
  ZAICODE_STATS_CLEAR_GENERATION, ZAICODE_STATS_PAGE_SIZE,
  isCurrentZaicodeStatsScan, readZaicodeStatsScan, saveZaicodeStatsPage,
  type ZaicodeStatsPage, type ZaicodeStatsScan, type ZaicodeStatsStream,
} from "./zaicodeStatsScan.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";

// Same loading as the job repo: node:sqlite through require survives the desktop bundler.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** One stored statistics event (NULL token columns = not measured by the source). */
export interface ZaicodeStatsEventRow {
  id: string;
  source: "agent-db" | "queue" | "workers";
  kind: "model.request" | "turn" | "job.finished" | "worker.session";
  at: number;
  startedAt: number | null;
  durationMs: number | null;
  project: string | null;
  sessionId: string | null;
  jobId: string | null;
  agent: string | null;
  engine: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  result: string | null;
  failure: string | null;
  retryOf: string | null;
}

/** Cursor row that marks "Clear local statistics": nothing older is read again. */
export const ZAICODE_STATS_CLEARED_CURSOR = "cleared";

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;

/**
 * SAIHOME statistics storage (T-56): its own tables in tasks-index.sqlite,
 * its own connection (like the job repo), migrations through the shared
 * ledger. Reads are sums; nothing here knows about local time zones.
 */
export class ZaicodeStatsRepo {
  private db: DatabaseSyncInstance | null = null;
  private initializePromise: Promise<void> | null = null;
  private initializationGeneration = 0;
  private readonly resolvedDbPath: string | null;
  private cachedMeta: {
    eventCount: number;
    firstEventAt: number | null;
    lastEventAt: number | null;
    lastRecordedAt: number | null;
  } | null = null;

  constructor(dbPath?: string) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  async ensureReady(): Promise<void> {
    if (!this.initializePromise) {
      const generation = this.initializationGeneration;
      this.initializePromise = this.initialize(
        this.resolvedDbPath ?? getTasksIndexDatabasePath(),
        generation,
      ).catch((error) => {
        if (generation === this.initializationGeneration) this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(): void {
    this.initializationGeneration += 1;
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
    this.initializePromise = null;
  }

  private async initialize(path: string, generation: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // T-252 / W2-005 — 与 agent/job 同一屏障，已取消的初始化不能在退出后恢复 SQLite。
    if (generation !== this.initializationGeneration)
      throw new Error("ZaicodeStatsRepo initialization_cancelled: closed during startup");
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
  }

  private get database(): DatabaseSyncInstance {
    if (!this.db) throw new Error("ZaicodeStatsRepo is not ready: await ensureReady() first");
    return this.db;
  }

  /** Inserts new events in one transaction; an id seen before is ignored (replay-safe). */
  insertEvents(rows: readonly ZaicodeStatsEventRow[], now: number): number {
    return this.writeEvents(rows, now).inserted;
  }

  scan(source: ZaicodeStatsStream): ZaicodeStatsScan {
    return readZaicodeStatsScan(this.database, source);
  }

  commitScan(page: ZaicodeStatsPage, now: number): boolean {
    return this.writeEvents(page.rows, now, page).accepted;
  }

  private writeEvents(rows: readonly ZaicodeStatsEventRow[], now: number, page?: ZaicodeStatsPage): { inserted: number; accepted: boolean } {
    if (rows.length === 0 && !page) return { inserted: 0, accepted: true };
    const db = this.database;
    const insert = db.prepare(`INSERT OR IGNORE INTO zaicode_stats_events (
      id, source, kind, at, started_at, duration_ms, project, session_id, job_id, agent, engine, provider, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
      result, failure, retry_of, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let inserted = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      // 页凭据在写锁内裁决；另一个写者或 Clear 获胜后，旧批次不能推进新一轮水位。
      if (page && !isCurrentZaicodeStatsScan(db, page.scan)) {
        db.exec("COMMIT");
        return { inserted: 0, accepted: false };
      }
      // Clear 的屏障必须在同一写锁内读取，旧批次不能用准备时的快照恢复已清除历史。
      const cleared = this.getCursor(ZAICODE_STATS_CLEARED_CURSOR);
      for (const row of rows) {
        if (row.at < cleared) continue;
        const result = insert.run(
          row.id,
          row.source,
          row.kind,
          row.at,
          row.startedAt,
          row.durationMs,
          row.project,
          row.sessionId,
          row.jobId,
          row.agent,
          row.engine,
          row.provider,
          row.model,
          row.inputTokens,
          row.outputTokens,
          row.cacheReadTokens,
          row.cacheWriteTokens,
          row.reasoningTokens,
          row.totalTokens,
          row.result,
          row.failure,
          row.retryOf,
          now,
        );
        inserted += Number(result.changes);
      }
      if (page) saveZaicodeStatsPage(db, page, now);
      db.exec("COMMIT");
      if (inserted > 0) this.cachedMeta = null;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { inserted, accepted: true };
  }

  getCursor(source: string): number {
    const row = this.database
      .prepare("SELECT cursor FROM zaicode_stats_cursor WHERE source = ?")
      .get(source);
    return row ? num(row.cursor) : 0;
  }

  setCursor(source: string, cursor: number, now: number): void {
    this.database
      .prepare(
        `INSERT INTO zaicode_stats_cursor (source, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(source, cursor, now);
  }

  /** Quarter-hour sums of everything stored. */
  buckets(): ZaicodeStatsBucket[] {
    const rows = this.database
      .prepare(
        `SELECT at / ${ZAICODE_STATS_BUCKET_MS} AS q,
           SUM(kind = 'model.request') AS requests,
           SUM(kind = 'model.request' AND result = 'error') AS failedRequests,
           COALESCE(SUM(total_tokens), 0) AS tokens,
           COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
           COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
           COALESCE(SUM(CASE WHEN kind = 'model.request' THEN duration_ms END), 0) AS modelMs,
           SUM(kind = 'turn') AS turns,
           SUM(kind = 'job.finished' AND result = 'completed') AS jobsDone,
           SUM(kind = 'job.finished' AND result = 'failed') AS jobsFailed,
           SUM(kind = 'job.finished' AND result = 'cancelled') AS jobsCancelled,
           SUM(kind = 'job.finished' AND result = 'completed' AND retry_of IS NOT NULL) AS jobsRecovered,
           COALESCE(SUM(CASE WHEN kind = 'job.finished' THEN duration_ms END), 0) AS jobMs,
           SUM(kind = 'worker.session') AS workerSessions,
           COALESCE(SUM(CASE WHEN kind = 'worker.session' THEN duration_ms END), 0) AS workerMs
         FROM zaicode_stats_events
         GROUP BY q
         ORDER BY q`,
      )
      .all();
    return rows.map((row) => ({
      q: num(row.q),
      requests: num(row.requests),
      failedRequests: num(row.failedRequests),
      tokens: num(row.tokens),
      input: num(row.input),
      output: num(row.output),
      cacheRead: num(row.cacheRead),
      cacheWrite: num(row.cacheWrite),
      reasoning: num(row.reasoning),
      modelMs: num(row.modelMs),
      turns: num(row.turns),
      jobsDone: num(row.jobsDone),
      jobsFailed: num(row.jobsFailed),
      jobsCancelled: num(row.jobsCancelled),
      jobsRecovered: num(row.jobsRecovered),
      jobMs: num(row.jobMs),
      workerSessions: num(row.workerSessions),
      workerMs: num(row.workerMs),
    }));
  }

  /**
   * REQ-012: quarter-hour sums for one recorded slice (bound parameters, no
   * string-built filters). Both filters null = everything stored. Straight
   * sums like buckets(): every recorded attempt cost what it cost, so tokens
   * are never divided or guessed; ingest already dedups replays (T-255).
   */
  scopeBuckets(project?: string | null, sessionId?: string | null): ZaicodeStatsBucket[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (project) {
      where.push("project = ?");
      params.push(project);
    }
    if (sessionId) {
      where.push("session_id = ?");
      params.push(sessionId);
    }
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.database
      .prepare(
        `SELECT at / ${ZAICODE_STATS_BUCKET_MS} AS q,
           SUM(kind = 'model.request') AS requests,
           SUM(kind = 'model.request' AND result = 'error') AS failedRequests,
           COALESCE(SUM(total_tokens), 0) AS tokens,
           COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
           COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
           COALESCE(SUM(CASE WHEN kind = 'model.request' THEN duration_ms END), 0) AS modelMs,
           SUM(kind = 'turn') AS turns,
           SUM(kind = 'job.finished' AND result = 'completed') AS jobsDone,
           SUM(kind = 'job.finished' AND result = 'failed') AS jobsFailed,
           SUM(kind = 'job.finished' AND result = 'cancelled') AS jobsCancelled,
           SUM(kind = 'job.finished' AND result = 'completed' AND retry_of IS NOT NULL) AS jobsRecovered,
           COALESCE(SUM(CASE WHEN kind = 'job.finished' THEN duration_ms END), 0) AS jobMs,
           SUM(kind = 'worker.session') AS workerSessions,
           COALESCE(SUM(CASE WHEN kind = 'worker.session' THEN duration_ms END), 0) AS workerMs
         FROM zaicode_stats_events
         ${filter}
         GROUP BY q
         ORDER BY q`,
      )
      .all(...params);
    return rows.map((row) => ({
      q: num(row.q),
      requests: num(row.requests),
      failedRequests: num(row.failedRequests),
      tokens: num(row.tokens),
      input: num(row.input),
      output: num(row.output),
      cacheRead: num(row.cacheRead),
      cacheWrite: num(row.cacheWrite),
      reasoning: num(row.reasoning),
      modelMs: num(row.modelMs),
      turns: num(row.turns),
      jobsDone: num(row.jobsDone),
      jobsFailed: num(row.jobsFailed),
      jobsCancelled: num(row.jobsCancelled),
      jobsRecovered: num(row.jobsRecovered),
      jobMs: num(row.jobMs),
      workerSessions: num(row.workerSessions),
      workerMs: num(row.workerMs),
    }));
  }

  /**
   * REQ-012: recorded project keys for the scope picker, newest first. Only
   * keys that actually appear in storage are listed; nothing is guessed.
   */
  scopeProjects(): { project: string; events: number; lastAt: number }[] {
    const rows = this.database
      .prepare(
        `SELECT project, COUNT(*) AS events, MAX(at) AS lastAt
         FROM zaicode_stats_events
         WHERE project IS NOT NULL AND project != ''
         GROUP BY project
         ORDER BY lastAt DESC
         LIMIT 50`,
      )
      .all();
    return rows.map((row) => ({ project: String(row.project), events: num(row.events), lastAt: num(row.lastAt) }));
  }

  /**
   * REQ-012: recorded session keys, optionally inside one project. Sessions
   * are per-recording keys, not a global registry: a session with no stored
   * events simply does not appear.
   */
  scopeSessions(project?: string | null): { sessionId: string; project: string | null; events: number; lastAt: number }[] {
    const where = ["session_id IS NOT NULL", "session_id != ''"];
    const params: string[] = [];
    if (project) {
      where.push("project = ?");
      params.push(project);
    }
    const rows = this.database
      .prepare(
        `SELECT session_id AS sid, project, COUNT(*) AS events, MAX(at) AS lastAt
         FROM zaicode_stats_events
         WHERE ${where.join(" AND ")}
         GROUP BY session_id
         ORDER BY lastAt DESC
         LIMIT 50`,
      )
      .all(...params);
    return rows.map((row) => ({
      sessionId: String(row.sid),
      project: row.project == null ? null : String(row.project),
      events: num(row.events),
      lastAt: num(row.lastAt),
    }));
  }

  breakdown(): ZaicodeStatsBreakdownInput {
    const db = this.database;
    const models = db
      .prepare(
        `SELECT COALESCE(provider, '') AS provider, COALESCE(model, '') AS model,
           COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS requests
         FROM zaicode_stats_events WHERE kind = 'model.request'
         GROUP BY provider, model ORDER BY tokens DESC LIMIT 20`,
      )
      .all()
      .map((row) => ({
        provider: String(row.provider),
        model: String(row.model),
        tokens: num(row.tokens),
        requests: num(row.requests),
      }));
    const projects = db
      .prepare(
        `SELECT project, COALESCE(SUM(total_tokens), 0) AS tokens,
           SUM(kind = 'model.request') AS requests, COUNT(*) AS events
         FROM zaicode_stats_events WHERE project IS NOT NULL AND project != ''
         GROUP BY project ORDER BY tokens DESC, events DESC LIMIT 30`,
      )
      .all()
      .map((row) => ({
        project: String(row.project),
        tokens: num(row.tokens),
        requests: num(row.requests),
        events: num(row.events),
      }));
    const longest = db
      .prepare(
        `SELECT MAX(duration_ms) AS longest FROM zaicode_stats_events WHERE kind IN ('job.finished', 'worker.session')`,
      )
      .get();
    const longestRunMs = longest && longest.longest !== null ? num(longest.longest) : null;
    return { models, projects, longestRunMs };
  }

  /** Scoped router sums stay in SQL: no full history export or guessed shares. */
  routerUsage(request: ZaicodeRouterUsageScopeRequest, now: number): ZaicodeRouterScopedUsage {
    const providerIds = [...new Set(request.providerIds)].slice(0, 500);
    const since = Number.isFinite(request.since) ? Math.max(0, request.since) : 0;
    const where = `kind = 'model.request' AND project = ? AND at >= ? AND at <= ? AND ${
      providerIds.length ? `provider IN (${providerIds.map(() => "?").join(",")})` : "0"}${request.sessionId ? " AND session_id = ?" : ""}`;
    const args = [request.project, since, now, ...providerIds,
      ...(request.sessionId ? [request.sessionId] : [])];
    const sums = "COUNT(*) AS requests, SUM(input_tokens) AS promptTokens, SUM(output_tokens) AS completionTokens, SUM(cache_read_tokens + cache_write_tokens) AS cachedTokens";
    const count = (row: Record<string, unknown> | undefined): ZaicodeRouterUsageCount => ({ requests: num(row?.requests),
      promptTokens: num(row?.promptTokens), completionTokens: num(row?.completionTokens), cachedTokens: num(row?.cachedTokens) });
    const db = this.database;
    const totals = count(db.prepare(`SELECT ${sums} FROM zaicode_stats_events WHERE ${where}`).get(...args));
    const grouped = (column: "model" | "provider") => Object.fromEntries(db.prepare(
      `SELECT ${column} AS name, ${sums} FROM zaicode_stats_events WHERE ${where} GROUP BY ${column} ORDER BY requests DESC LIMIT 200`,
    ).all(...args).map((row) => [String(row.name ?? "Unknown"), count(row)]));
    const byProvider = grouped("provider");
    const recentRequests = db.prepare(`SELECT * FROM zaicode_stats_events WHERE ${where} ORDER BY at DESC, id DESC LIMIT 100`)
      .all(...args).map((row) => ({
        id: String(row.id ?? ""),
        sessionId: row.session_id ? String(row.session_id) : undefined,
        requests: 1,
        promptTokens: num(row.input_tokens),
        completionTokens: num(row.output_tokens),
        cachedTokens: num(row.cache_read_tokens) + num(row.cache_write_tokens),
        model: String(row.model ?? "Unknown"),
        provider: String(row.provider ?? "Unknown"),
        timestamp: new Date(num(row.at)).toISOString(),
        status: String(row.result ?? ""),
        startedAt: row.started_at !== null && row.started_at !== undefined ? new Date(num(row.started_at)).toISOString() : undefined,
        completedAt: new Date(num(row.at)).toISOString(),
        durationMs: row.duration_ms !== null && row.duration_ms !== undefined ? num(row.duration_ms) : undefined,
        failure: row.failure ? String(row.failure) : null,
      }));
    const chartSince = Math.max(since, now - 60 * 86_400_000);
    const step = Math.max(ZAICODE_STATS_BUCKET_MS, Math.ceil((now - chartSince) / 120 / ZAICODE_STATS_BUCKET_MS) * ZAICODE_STATS_BUCKET_MS);
    const chart = db.prepare(`SELECT CAST(at / ? AS INTEGER) * ? AS bucket, SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens
      FROM zaicode_stats_events WHERE ${where} AND at >= ? GROUP BY bucket ORDER BY bucket DESC LIMIT 120`)
      .all(step, step, ...args, chartSince).reverse().map((row) => ({ label: new Date(num(row.bucket)).toISOString(), tokens: num(row.tokens) }));
    return { stats: { totalRequests: totals.requests, totalPromptTokens: totals.promptTokens, totalCompletionTokens: totals.completionTokens,
      totalCachedTokens: totals.cachedTokens, byModel: grouped("model"), byProvider, byAccount: byProvider, recentRequests }, chart, costMeasured: false };
  }

  invalidateMeta(): void {
    this.cachedMeta = null;
  }

  meta(): {
    eventCount: number;
    firstEventAt: number | null;
    lastEventAt: number | null;
    lastRecordedAt: number | null;
  } {
    if (this.cachedMeta !== null) {
      return this.cachedMeta;
    }
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last, MAX(recorded_at) AS recorded FROM zaicode_stats_events",
      )
      .get();
    this.cachedMeta = {
      eventCount: num(row?.n),
      firstEventAt: row?.first === null || row?.first === undefined ? null : num(row.first),
      lastEventAt: row?.last === null || row?.last === undefined ? null : num(row.last),
      lastRecordedAt:
        row?.recorded === null || row?.recorded === undefined ? null : num(row.recorded),
    };
    return this.cachedMeta;
  }

  /** Newest queue runs and worker sessions (model requests and turns are too fine for a timeline). */
  recent(limit: number): ZaicodeStatsEventRow[] {
    return this.database
      .prepare(
        `SELECT * FROM zaicode_stats_events WHERE kind IN ('job.finished', 'worker.session')
         ORDER BY at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(100, Math.trunc(limit))))
      .map(toRow);
  }

  all(): ZaicodeStatsEventRow[] {
    return this.database.prepare("SELECT * FROM zaicode_stats_events ORDER BY at").all().map(toRow);
  }

  /** One keyset page from a fixed completion horizon; terminal jobs remain unchanged. */
  finishedJobsPage(scan: ZaicodeStatsScan): { rows: Record<string, unknown>[]; until: number } {
    const terminal = "status IN ('completed', 'failed', 'cancelled') AND finished_at IS NOT NULL";
    const max = scan.until ?? Number(this.database.prepare(
      `SELECT finished_at FROM zaicode_jobs WHERE ${terminal} ORDER BY finished_at DESC,job_id DESC LIMIT 1`,
    ).get()?.finished_at ?? scan.since);
    const until = Math.max(scan.since, max);
    const rows = this.database
      .prepare(
        `SELECT job_id, attempt, workspace_path, agent_id, status, started_at, finished_at, error, session_id,
           retry_of_job_id, actual_model_selection
         FROM zaicode_jobs
         WHERE ${terminal} AND finished_at <= ? AND (finished_at,job_id) > (?,?)
         ORDER BY finished_at ASC,job_id ASC LIMIT ?`,
      )
      .all(until, scan.at, scan.id, ZAICODE_STATS_PAGE_SIZE);
    return { rows, until };
  }

  /** Deletes every event and sets the floor below which no source is read again. */
  clear(now: number): void {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const generation = this.getCursor(ZAICODE_STATS_CLEAR_GENERATION) + 1;
      db.exec("DELETE FROM zaicode_stats_events");
      db.prepare("DELETE FROM zaicode_stats_cursor").run();
      db.exec("DELETE FROM zaicode_stats_progress");
      // 删除历史与写入清除时间是一个原子操作；屏障写入失败时必须全部回滚。
      this.setCursor(ZAICODE_STATS_CLEARED_CURSOR, now, now);
      this.setCursor(ZAICODE_STATS_CLEAR_GENERATION, generation, now);
      this.cachedMeta = {
        eventCount: 0,
        firstEventAt: null,
        lastEventAt: null,
        lastRecordedAt: null,
      };
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function toRow(row: Record<string, unknown>): ZaicodeStatsEventRow {
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const maybe = (value: unknown) => (value === null || value === undefined ? null : num(value));
  return {
    id: String(row.id),
    source: String(row.source) as ZaicodeStatsEventRow["source"],
    kind: String(row.kind) as ZaicodeStatsEventRow["kind"],
    at: num(row.at),
    startedAt: maybe(row.started_at),
    durationMs: maybe(row.duration_ms),
    project: text(row.project),
    sessionId: text(row.session_id),
    jobId: text(row.job_id),
    agent: text(row.agent),
    engine: text(row.engine),
    provider: text(row.provider),
    model: text(row.model),
    inputTokens: maybe(row.input_tokens),
    outputTokens: maybe(row.output_tokens),
    cacheReadTokens: maybe(row.cache_read_tokens),
    cacheWriteTokens: maybe(row.cache_write_tokens),
    reasoningTokens: maybe(row.reasoning_tokens),
    totalTokens: maybe(row.total_tokens),
    result: text(row.result),
    failure: text(row.failure),
    retryOf: text(row.retry_of),
  };
}
