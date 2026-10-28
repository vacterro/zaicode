import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZaicodeStatsWorkerSession } from "@zcode/shared";
import type { ZaicodeStatsEventRow } from "./zaicodeStatsRepo.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/**
 * The statistics sources (T-56), each read read-only and turned into
 * zaicode_stats_events rows with stable ids:
 *
 * agent-db  the agent's own usage store (model_usage per model request with
 *           measured tokens, turn_usage per turn). It belongs to the agent
 *           CLI; ZAICODE only reads it. It is shared by ZCode and ZAICODE.
 * queue     finished ZAICODE queue runs (zaicode_jobs, same database).
 * workers   CLI worker sessions the renderer reports (no token counts).
 */

/** Re-read this far behind the cursor: a row completed a moment late is still picked up. */
export const ZAICODE_STATS_OVERLAP_MS = 5 * 60_000;
const PAGE = 5000;
const MAX_PAGES = 40;

/** The agent CLI's session store (same rule as the CLI: ZCODE_SESSION_DB_PATH, else ~/.zcode/cli/db/db.sqlite). */
export function resolveZaicodeAgentDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ZCODE_SESSION_DB_PATH?.trim() || env.ZCODE_SESSION_DB?.trim();
  return configured || join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

export interface ZaicodeAgentDbRead {
  rows: ZaicodeStatsEventRow[];
  /** Highest completion time read (the next cursor). */
  cursor: number;
  state: "fresh" | "unavailable";
  detail: string;
}

function hasColumns(db: DatabaseSyncInstance, table: string, columns: readonly string[]): boolean {
  const found = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
  return columns.every((column) => found.has(column));
}

const MODEL_COLUMNS = [
  "id", "session_id", "turn_id", "provider_id", "model_id", "agent", "status", "started_at", "completed_at",
  "duration_ms", "input_tokens", "output_tokens", "reasoning_tokens", "cache_creation_input_tokens",
  "cache_read_input_tokens", "computed_total_tokens", "error_type",
] as const;
const TURN_COLUMNS = ["session_id", "turn_id", "status", "started_at", "completed_at", "duration_ms"] as const;

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * Model requests and turns that ended after `since` (terminal rows only: a
 * running request has no final token count yet). A missing file or a schema
 * without the expected columns is "unavailable", never an error.
 */
export function readZaicodeAgentDb(path: string, since: number): ZaicodeAgentDbRead {
  if (!existsSync(path)) return { rows: [], cursor: since, state: "unavailable", detail: "agent usage store not found" };
  let db: DatabaseSyncInstance | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    if (!hasColumns(db, "model_usage", MODEL_COLUMNS)) {
      return { rows: [], cursor: since, state: "unavailable", detail: "agent usage store has no model_usage table this build understands" };
    }
    const hasSession = hasColumns(db, "session", ["id", "directory"]);
    const rows: ZaicodeStatsEventRow[] = [];
    let cursor = since;
    const models = db.prepare(
      `SELECT m.*, ${hasSession ? "s.directory" : "NULL"} AS project_dir,
         COALESCE(m.completed_at, m.started_at) AS ended
       FROM model_usage m ${hasSession ? "LEFT JOIN session s ON s.id = m.session_id" : ""}
       WHERE m.status != 'running' AND COALESCE(m.completed_at, m.started_at) > ?
       ORDER BY ended ASC LIMIT ${PAGE}`,
    );
    for (let page = 0, from = since; page < MAX_PAGES; page += 1) {
      const batch = models.all(from);
      for (const row of batch) {
        const ended = Number(row.ended);
        cursor = Math.max(cursor, ended);
        const measured = row.status === "completed";
        rows.push({
          id: `model:${String(row.id)}`,
          source: "agent-db",
          kind: "model.request",
          at: Number(row.started_at),
          startedAt: Number(row.started_at),
          durationMs: num(row.duration_ms),
          project: text(row.project_dir),
          sessionId: text(row.session_id),
          jobId: null,
          agent: text(row.agent),
          engine: null,
          provider: text(row.provider_id),
          model: text(row.model_id),
          // A request that failed or was cancelled reports no usage: 0 is what the provider billed as far as ZAICODE can know.
          inputTokens: measured ? num(row.input_tokens) : 0,
          outputTokens: measured ? num(row.output_tokens) : 0,
          cacheReadTokens: measured ? num(row.cache_read_input_tokens) : 0,
          cacheWriteTokens: measured ? num(row.cache_creation_input_tokens) : 0,
          reasoningTokens: measured ? num(row.reasoning_tokens) : 0,
          totalTokens: measured ? num(row.computed_total_tokens) : 0,
          result: text(row.status),
          failure: text(row.error_type),
          retryOf: null,
        });
      }
      if (batch.length < PAGE) break;
      from = Number(batch[batch.length - 1]!.ended);
    }
    if (hasColumns(db, "turn_usage", TURN_COLUMNS)) {
      const turns = db
        .prepare(
          `SELECT t.session_id, t.turn_id, t.status, t.started_at, t.duration_ms,
             ${hasSession ? "s.directory" : "NULL"} AS project_dir,
             COALESCE(t.completed_at, t.started_at) AS ended
           FROM turn_usage t ${hasSession ? "LEFT JOIN session s ON s.id = t.session_id" : ""}
           WHERE t.status != 'running' AND COALESCE(t.completed_at, t.started_at) > ?
           ORDER BY ended ASC LIMIT ${PAGE * MAX_PAGES}`,
        )
        .all(since);
      for (const row of turns) {
        cursor = Math.max(cursor, Number(row.ended));
        rows.push({
          id: `turn:${String(row.session_id)}:${String(row.turn_id)}`,
          source: "agent-db",
          kind: "turn",
          at: Number(row.started_at),
          startedAt: Number(row.started_at),
          durationMs: num(row.duration_ms),
          project: text(row.project_dir),
          sessionId: text(row.session_id),
          jobId: null,
          agent: null,
          engine: null,
          provider: null,
          model: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          result: text(row.status),
          failure: null,
          retryOf: null,
        });
      }
    }
    return { rows, cursor, state: "fresh", detail: `${rows.length} new record(s)` };
  } catch (error) {
    return { rows: [], cursor: since, state: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // read-only handle
    }
  }
}

/** A finished queue job row (zaicode_jobs) as a statistics event. */
export function zaicodeJobStatsEvent(row: Record<string, unknown>): ZaicodeStatsEventRow | null {
  const finished = num(row.finished_at);
  if (finished === null) return null;
  const started = num(row.started_at);
  let engine: string | null = null;
  try {
    const selection = typeof row.actual_model_selection === "string" ? (JSON.parse(row.actual_model_selection) as { providerId?: string; modelId?: string }) : null;
    if (selection?.modelId) engine = selection.providerId ? `${selection.providerId} / ${selection.modelId}` : selection.modelId;
  } catch {
    engine = null;
  }
  const error = text(row.error);
  return {
    id: `job:${String(row.job_id)}:${String(row.attempt ?? 0)}`,
    source: "queue",
    kind: "job.finished",
    at: finished,
    startedAt: started,
    durationMs: started !== null && finished >= started ? finished - started : null,
    project: text(row.workspace_path),
    sessionId: text(row.session_id),
    jobId: text(row.job_id),
    agent: text(row.agent_id),
    engine,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    result: text(row.status),
    // The failure category, not the whole message (paths and prompts stay out of statistics).
    failure: error ? error.split(":")[0]!.slice(0, 60) : null,
    retryOf: text(row.retry_of_job_id),
  };
}

/** A worker session reported by the renderer; malformed input is dropped. */
export function zaicodeWorkerStatsEvent(session: ZaicodeStatsWorkerSession): ZaicodeStatsEventRow | null {
  if (!session || typeof session.id !== "string" || !session.id) return null;
  const started = Number(session.startedAt);
  const ended = Number(session.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return {
    id: `worker:${session.id}`,
    source: "workers",
    kind: "worker.session",
    at: ended,
    startedAt: started,
    durationMs: ended - started,
    project: typeof session.project === "string" ? session.project : null,
    sessionId: null,
    jobId: null,
    agent: null,
    engine: typeof session.engine === "string" ? session.engine.slice(0, 40) : null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    result: session.exitCode === null ? "stopped" : session.exitCode === 0 ? "completed" : "failed",
    failure: session.exitCode !== null && session.exitCode !== 0 ? `exit ${session.exitCode}` : null,
    retryOf: null,
  };
}
