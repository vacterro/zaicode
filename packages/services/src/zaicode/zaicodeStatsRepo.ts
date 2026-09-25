import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { ZAICODE_STATS_BUCKET_MS, type ZaicodeStatsBreakdownInput, type ZaicodeStatsBucket } from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { isTasksStorageMigrated, isTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";

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

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0);

/**
 * SAIHOME statistics storage (T-56): its own tables in tasks-index.sqlite,
 * its own connection (like the job repo), migrations through the shared
 * ledger. Reads are sums; nothing here knows about local time zones.
 */
export class ZaicodeStatsRepo {
  private db: DatabaseSyncInstance | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly resolvedDbPath: string | null;

  constructor(dbPath?: string) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  async ensureReady(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(this.resolvedDbPath ?? getTasksIndexDatabasePath()).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
    this.initializePromise = null;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
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
    if (rows.length === 0) return 0;
    const db = this.database;
    const insert = db.prepare(`INSERT OR IGNORE INTO zaicode_stats_events (
      id, source, kind, at, started_at, duration_ms, project, session_id, job_id, agent, engine, provider, model,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
      result, failure, retry_of, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let inserted = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
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
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return inserted;
  }

  getCursor(source: string): number {
    const row = this.database.prepare("SELECT cursor FROM zaicode_stats_cursor WHERE source = ?").get(source);
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
      .map((row) => ({ provider: String(row.provider), model: String(row.model), tokens: num(row.tokens), requests: num(row.requests) }));
    const projects = db
      .prepare(
        `SELECT project, COALESCE(SUM(total_tokens), 0) AS tokens,
           SUM(kind = 'model.request') AS requests, COUNT(*) AS events
         FROM zaicode_stats_events WHERE project IS NOT NULL AND project != ''
         GROUP BY project ORDER BY tokens DESC, events DESC LIMIT 30`,
      )
      .all()
      .map((row) => ({ project: String(row.project), tokens: num(row.tokens), requests: num(row.requests), events: num(row.events) }));
    const longest = db
      .prepare(`SELECT MAX(duration_ms) AS longest FROM zaicode_stats_events WHERE kind IN ('job.finished', 'worker.session')`)
      .get();
    const longestRunMs = longest && longest.longest !== null ? num(longest.longest) : null;
    return { models, projects, longestRunMs };
  }

  meta(): { eventCount: number; firstEventAt: number | null; lastEventAt: number | null; lastRecordedAt: number | null } {
    const row = this.database
      .prepare("SELECT COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last, MAX(recorded_at) AS recorded FROM zaicode_stats_events")
      .get();
    return {
      eventCount: num(row?.n),
      firstEventAt: row?.first === null || row?.first === undefined ? null : num(row.first),
      lastEventAt: row?.last === null || row?.last === undefined ? null : num(row.last),
      lastRecordedAt: row?.recorded === null || row?.recorded === undefined ? null : num(row.recorded),
    };
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

  /** Finished queue runs (zaicode_jobs, read only) that ended after `since`. */
  finishedJobsSince(since: number, limit = 5000): Record<string, unknown>[] {
    return this.database
      .prepare(
        `SELECT job_id, attempt, workspace_path, agent_id, status, started_at, finished_at, error, session_id,
           retry_of_job_id, actual_model_selection
         FROM zaicode_jobs
         WHERE status IN ('completed', 'failed', 'cancelled') AND finished_at IS NOT NULL AND finished_at > ?
         ORDER BY finished_at ASC LIMIT ?`,
      )
      .all(since, limit);
  }

  /** Deletes every event and sets the floor below which no source is read again. */
  clear(now: number): void {
    const db = this.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM zaicode_stats_events");
      db.prepare("DELETE FROM zaicode_stats_cursor").run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.setCursor(ZAICODE_STATS_CLEARED_CURSOR, now, now);
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
