import {
  assembleZaicodeHomeStats,
  type ZaicodeHomeStats,
  type ZaicodeHomeStatsRequest,
  type ZaicodeStatsActivity,
  type ZaicodeStatsSourceState,
  type ZaicodeStatsWorkerSession,
} from "@zcode/shared";
import type { IZaicodeStatsService } from "./zaicodeStats.js";
import { ZAICODE_STATS_CLEARED_CURSOR, type ZaicodeStatsRepo } from "./zaicodeStatsRepo.js";
import {
  ZAICODE_STATS_OVERLAP_MS,
  readZaicodeAgentDb,
  resolveZaicodeAgentDbPath,
  zaicodeJobStatsEvent,
  zaicodeWorkerStatsEvent,
} from "./zaicodeStatsSources.js";

/** Sources are read at most this often (SAIHOME asks on open and every minute). */
const INGEST_EVERY_MS = 20_000;
/** A source not read successfully for this long is shown as stale. */
const STALE_AFTER_MS = 10 * 60_000;

interface ZaicodeStatsServiceDeps {
  repo: ZaicodeStatsRepo;
  /** Test hook: where the agent usage store lives. */
  agentDbPath?: () => string;
  now?: () => number;
  logger?: { warn(message: string, error?: unknown): void };
}

interface SourceMemory {
  readAt: number | null;
  okAt: number | null;
  state: ZaicodeStatsSourceState["state"];
  detail: string;
}

/**
 * SAIHOME statistics (T-56). Ingestion is idempotent (stable ids, INSERT OR
 * IGNORE) and resumable (per-source cursor, re-read with an overlap), so a
 * restart, a replay or two windows asking at once never count twice.
 */
export class ZaicodeStatsService implements IZaicodeStatsService {
  private lastIngestAt = 0;
  private ingesting: Promise<void> | null = null;
  private readonly memory = new Map<"agent-db" | "queue" | "workers", SourceMemory>();

  constructor(private readonly deps: ZaicodeStatsServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private remember(source: "agent-db" | "queue" | "workers", ok: boolean, detail: string): void {
    const now = this.now();
    const previous = this.memory.get(source);
    this.memory.set(source, {
      readAt: now,
      okAt: ok ? now : (previous?.okAt ?? null),
      state: ok ? "fresh" : "unavailable",
      detail,
    });
  }

  private floor(source: string): number {
    const { repo } = this.deps;
    return Math.max(repo.getCursor(source), repo.getCursor(ZAICODE_STATS_CLEARED_CURSOR));
  }

  /** Reads every source once (serialised; concurrent callers share the same pass). */
  async ingest(force = false): Promise<void> {
    if (this.ingesting) return this.ingesting;
    if (!force && this.now() - this.lastIngestAt < INGEST_EVERY_MS) return;
    this.ingesting = this.runIngest().finally(() => {
      this.ingesting = null;
    });
    return this.ingesting;
  }

  private async runIngest(): Promise<void> {
    const { repo } = this.deps;
    await repo.ensureReady();
    const now = this.now();
    this.lastIngestAt = now;

    const agentFloor = this.floor("agent-db");
    const agentPath = this.deps.agentDbPath?.() ?? resolveZaicodeAgentDbPath();
    const agent = readZaicodeAgentDb(agentPath, Math.max(0, agentFloor - ZAICODE_STATS_OVERLAP_MS));
    if (agent.state === "fresh") {
      const cleared = repo.getCursor(ZAICODE_STATS_CLEARED_CURSOR);
      repo.insertEvents(agent.rows.filter((row) => row.at >= cleared), now);
      repo.setCursor("agent-db", Math.max(agentFloor, agent.cursor), now);
    }
    this.remember("agent-db", agent.state === "fresh", agent.detail);

    try {
      const jobFloor = this.floor("queue");
      const jobs = repo.finishedJobsSince(Math.max(0, jobFloor - ZAICODE_STATS_OVERLAP_MS));
      const rows = jobs.map(zaicodeJobStatsEvent).filter((row) => row !== null);
      const cleared = repo.getCursor(ZAICODE_STATS_CLEARED_CURSOR);
      repo.insertEvents(rows.filter((row) => row.at >= cleared), now);
      const last = rows.reduce((max, row) => Math.max(max, row.at), jobFloor);
      repo.setCursor("queue", last, now);
      this.remember("queue", true, `${rows.length} finished run(s) read`);
    } catch (error) {
      this.deps.logger?.warn("ZAICODE stats: queue read failed", error);
      this.remember("queue", false, error instanceof Error ? error.message : String(error));
    }
  }

  private sourceStates(): ZaicodeStatsSourceState[] {
    const now = this.now();
    const labels = {
      "agent-db": "In-app model requests (agent usage store, shared with ZCode)",
      queue: "ZAICODE queue runs",
      workers: "CLI worker sessions (subscriptions: no token counts)",
    } as const;
    return (["agent-db", "queue", "workers"] as const).map((source) => {
      const memory = this.memory.get(source);
      if (source === "workers") {
        return { source, label: labels[source], state: "fresh", readAt: memory?.readAt ?? null, detail: memory?.detail ?? "recorded when a worker ends" };
      }
      if (!memory) return { source, label: labels[source], state: "unavailable", readAt: null, detail: "not read yet" };
      const state =
        memory.state === "fresh" ? "fresh" : memory.okAt !== null && now - memory.okAt < STALE_AFTER_MS ? "stale" : "unavailable";
      return { source, label: labels[source], state, readAt: memory.okAt, detail: memory.detail };
    });
  }

  async getHomeStats(request: ZaicodeHomeStatsRequest): Promise<ZaicodeHomeStats> {
    await this.ingest().catch((error: unknown) => this.deps.logger?.warn("ZAICODE stats ingest failed", error));
    const { repo } = this.deps;
    await repo.ensureReady();
    const meta = repo.meta();
    return assembleZaicodeHomeStats({
      buckets: repo.buckets(),
      breakdown: repo.breakdown(),
      request,
      eventCount: meta.eventCount,
      firstEventAt: meta.firstEventAt,
      lastEventAt: meta.lastEventAt,
      sources: this.sourceStates(),
      now: request.now ?? this.now(),
    });
  }

  async getRecentActivity(limit = 12): Promise<ZaicodeStatsActivity[]> {
    const { repo } = this.deps;
    await repo.ensureReady();
    return repo.recent(limit).map((row) => ({
      id: row.id,
      kind: row.kind === "worker.session" ? "worker.session" : "job.finished",
      at: row.at,
      durationMs: row.durationMs,
      project: row.project,
      jobId: row.jobId,
      engine: row.engine,
      result: row.result,
      failure: row.failure,
      recovered: row.kind === "job.finished" && row.result === "completed" && row.retryOf !== null,
    }));
  }

  async recordWorkerSessions(sessions: ZaicodeStatsWorkerSession[]): Promise<number> {
    const { repo } = this.deps;
    await repo.ensureReady();
    const cleared = repo.getCursor(ZAICODE_STATS_CLEARED_CURSOR);
    const rows = (Array.isArray(sessions) ? sessions.slice(0, 200) : [])
      .map(zaicodeWorkerStatsEvent)
      .filter((row) => row !== null && row.at >= cleared) as NonNullable<ReturnType<typeof zaicodeWorkerStatsEvent>>[];
    const inserted = repo.insertEvents(rows, this.now());
    this.remember("workers", true, `${inserted} session(s) recorded`);
    return inserted;
  }

  async clear(): Promise<{ clearedAt: number }> {
    const { repo } = this.deps;
    await repo.ensureReady();
    const clearedAt = this.now();
    repo.clear(clearedAt);
    this.lastIngestAt = 0;
    return { clearedAt };
  }

  async exportEvents(): Promise<string> {
    const { repo } = this.deps;
    await repo.ensureReady();
    return JSON.stringify({ format: "zaicode-stats-events", version: 1, exportedAt: this.now(), events: repo.all() }, null, 2);
  }

  dispose(): void {
    this.deps.repo.close();
  }
}
