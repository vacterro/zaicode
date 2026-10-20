import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZaicodeStatsWorkerSession } from "@zcode/shared";
import type { ZaicodeStatsEventRow } from "./zaicodeStatsRepo.js";
import { readZaicodeUsagePage } from "./zaicodeStatsAgentPages.js";
import { ZAICODE_STATS_PAGE_SIZE, type ZaicodeStatsPage, type ZaicodeStatsScan } from "./zaicodeStatsScan.js";

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
export { ZAICODE_STATS_OVERLAP_MS } from "./zaicodeStatsScan.js";

/** The agent CLI's session store (same rule as the CLI: ZCODE_SESSION_DB_PATH, else ~/.zcode/cli/db/db.sqlite). */
export function resolveZaicodeAgentDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ZCODE_SESSION_DB_PATH?.trim() || env.ZCODE_SESSION_DB?.trim();
  return configured || join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

export interface ZaicodeAgentDbRead {
  pages: ZaicodeStatsPage[];
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
 * One independent, bounded completion/key page per terminal usage stream.
 * A missing or unsupported source is unavailable; its durable scan stays put.
 */
export function readZaicodeAgentDb(path: string, scans: { model: ZaicodeStatsScan; turn: ZaicodeStatsScan }): ZaicodeAgentDbRead {
  if (!existsSync(path)) return { pages: [], state: "unavailable", detail: "agent usage store not found" };
  let db: DatabaseSyncInstance | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    db.exec("BEGIN");
    if (!hasColumns(db, "model_usage", MODEL_COLUMNS)) {
      return { pages: [], state: "unavailable", detail: "agent usage store has no model_usage table this build understands" };
    }
    const hasSession = hasColumns(db, "session", ["id", "directory"]);
    const pages: ZaicodeStatsPage[] = [];
    for (const [table, scan] of [["model_usage", scans.model], ["turn_usage", scans.turn]] as const) {
      if (table === "turn_usage" && !hasColumns(db, table, TURN_COLUMNS)) continue;
      const { batch, until } = readZaicodeUsagePage(db, table, scan, hasSession);
      const rows: ZaicodeStatsEventRow[] = batch.map(row => {
        const model = table === "model_usage";
        const measured = model && row.status === "completed";
        return {
          id: model ? `model:${String(row.id)}` : `turn:${String(row.session_id)}:${String(row.turn_id)}`,
          source: "agent-db",
          kind: model ? "model.request" : "turn",
          at: Number(row.started_at),
          startedAt: Number(row.started_at),
          durationMs: num(row.duration_ms),
          project: text(row.project_dir),
          sessionId: text(row.session_id),
          jobId: null,
          agent: model ? text(row.agent) : null,
          engine: null,
          provider: model ? text(row.provider_id) : null,
          model: model ? text(row.model_id) : null,
          // A request that failed or was cancelled reports no usage: 0 is what the provider billed as far as ZAICODE can know.
          inputTokens: !model ? null : measured ? num(row.input_tokens) : 0,
          outputTokens: !model ? null : measured ? num(row.output_tokens) : 0,
          cacheReadTokens: !model ? null : measured ? num(row.cache_read_input_tokens) : 0,
          cacheWriteTokens: !model ? null : measured ? num(row.cache_creation_input_tokens) : 0,
          reasoningTokens: !model ? null : measured ? num(row.reasoning_tokens) : 0,
          totalTokens: !model ? null : measured ? num(row.computed_total_tokens) : 0,
          result: text(row.status),
          failure: model ? text(row.error_type) : null,
          retryOf: null,
        };
      });
      const last = batch.at(-1);
      pages.push({ scan, until, rows, complete: batch.length < ZAICODE_STATS_PAGE_SIZE,
        at: last ? Number(last.ended) : scan.at,
        id: last ? String(table === "model_usage" ? last.id : last.session_id) : scan.id,
        key: last && table === "turn_usage" ? String(last.turn_id) : scan.key });
    }
    return { pages, state: "fresh", detail: `${pages.reduce((n, page) => n + page.rows.length, 0)} record(s) read${pages.some(page => !page.complete) ? "; scan in progress" : ""}` };
  } catch (error) {
    return { pages: [], state: "unavailable", detail: error instanceof Error ? error.message : String(error) };
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
