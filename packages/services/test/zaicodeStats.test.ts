import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ZaicodeStatsRepo } from "../src/zaicode/zaicodeStatsRepo.js";
import { ZaicodeStatsService } from "../src/zaicode/zaicodeStatsService.js";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";

const DAY = 86_400_000;
const ZONE = "Europe/Tallinn";

/** A minimal agent usage store with the real column names (subset the reader needs). */
function createAgentDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, provider_id TEXT NOT NULL, model_id TEXT NOT NULL,
      agent TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, duration_ms INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0, cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      computed_total_tokens INTEGER NOT NULL DEFAULT 0, error_type TEXT
    );
    CREATE TABLE turn_usage (
      session_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL, started_at INTEGER NOT NULL,
      completed_at INTEGER, duration_ms INTEGER
    );
  `);
  db.prepare("INSERT INTO session VALUES (?, ?)").run("s1", "V:\\work\\_ZAICODE");
  return db;
}

function addRequest(db: DatabaseSync, id: string, at: number, tokens: number, status = "completed"): void {
  db.prepare(
    `INSERT INTO model_usage (id, session_id, turn_id, provider_id, model_id, status, started_at, completed_at, duration_ms,
       input_tokens, output_tokens, cache_read_input_tokens, computed_total_tokens)
     VALUES (?, 's1', ?, 'new-provider', 'SAIFREN', ?, ?, ?, 1000, ?, ?, ?, ?)`,
  ).run(id, `t-${id}`, status, at, at + 1000, Math.round(tokens * 0.6), Math.round(tokens * 0.3), Math.round(tokens * 0.1), tokens);
  db.prepare("INSERT INTO turn_usage VALUES ('s1', ?, ?, ?, ?, 1000)").run(`t-${id}`, status, at, at + 1000);
}

async function harness(now: () => number) {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-stats-"));
  const tasksPath = join(dir, "tasks-index.sqlite");
  const agentPath = join(dir, "db.sqlite");
  const agentDb = createAgentDb(agentPath);
  const make = () => new ZaicodeStatsService({ repo: new ZaicodeStatsRepo(tasksPath), agentDbPath: () => agentPath, now });
  return {
    dir,
    tasksPath,
    agentDb,
    make,
    dispose: async () => {
      agentDb.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("stats: today / yesterday / week / month / all from the agent store, local days", async () => {
  // Thursday 2026-09-24 14:00 in Tallinn (UTC+3).
  const now = Date.UTC(2026, 8, 24, 11, 0);
  const h = await harness(() => now);
  try {
    addRequest(h.agentDb, "a", now - 60_000, 1000); // today
    addRequest(h.agentDb, "b", Date.UTC(2026, 8, 22, 21, 30), 500); // 00:30 local on the 23rd = yesterday
    addRequest(h.agentDb, "c", Date.UTC(2026, 8, 22, 20, 30), 250); // 23:30 local on the 22nd
    addRequest(h.agentDb, "d", Date.UTC(2026, 7, 31, 12, 0), 100); // last month
    addRequest(h.agentDb, "e", now - 5 * 60_000, 0, "error"); // failed request: counted, no tokens
    const service = h.make();
    const stats = await service.getHomeStats({ timeZone: ZONE, now });
    assert.equal(stats.today, "2026-09-24");
    assert.equal(stats.periods.today.tokens, 1000);
    assert.equal(stats.periods.today.requests, 2);
    assert.equal(stats.periods.today.failedRequests, 1);
    assert.equal(stats.periods.yesterday.tokens, 500);
    assert.equal(stats.periods.week.tokens, 1750); // Mon 21st .. Thu 24th
    assert.equal(stats.periods.month.tokens, 1750);
    assert.equal(stats.periods.all.tokens, 1850);
    assert.equal(stats.periods.all.turns, 5);
    assert.equal(stats.derived.tokensTodayVsYesterday, 2);
    assert.equal(stats.derived.mostUsedModel?.key, "new-provider / SAIFREN");
    assert.equal(stats.derived.mostActiveProject?.key, "V:\\work\\_ZAICODE");
    assert.equal(stats.streak.current, 3); // 22nd, 23rd, 24th
    assert.equal(stats.sources.find((source) => source.source === "agent-db")?.state, "fresh");
    service.dispose();
  } finally {
    await h.dispose();
  }
});

test("stats: restart and replay never count twice; late rows are still picked up", async () => {
  let now = Date.UTC(2026, 8, 24, 11, 0);
  const h = await harness(() => now);
  try {
    addRequest(h.agentDb, "a", now - 60_000, 1000);
    const first = h.make();
    await first.getHomeStats({ timeZone: ZONE, now });
    first.dispose();
    // "Restart": a new service on the same database; the source still holds the same row.
    now += 30_000;
    addRequest(h.agentDb, "late", now - 3 * 60_000, 40); // committed late: completed before the cursor, inside the overlap
    const second = h.make();
    const stats = await second.getHomeStats({ timeZone: ZONE, now }).finally(() => second.dispose());
    assert.deepEqual([stats.periods.all.tokens, stats.eventCount], [1040, 4]); // 2 requests + 2 turns
  } finally {
    await h.dispose();
  }
});

test("stats: clear removes history and does not read it back", async () => {
  const now = Date.UTC(2026, 8, 24, 11, 0);
  const h = await harness(() => now);
  try {
    addRequest(h.agentDb, "a", now - 60_000, 1000);
    const service = h.make();
    await service.getHomeStats({ timeZone: ZONE, now });
    await service.clear();
    const stats = await service.getHomeStats({ timeZone: ZONE, now });
    assert.equal(stats.periods.all.tokens, 0);
    assert.equal(stats.eventCount, 0);
    service.dispose();
  } finally {
    await h.dispose();
  }
});

test("stats: queue runs and worker sessions; workers stay unmeasured, not zero-token work", async () => {
  const now = Date.UTC(2026, 8, 24, 11, 0);
  const h = await harness(() => now);
  try {
    const jobRepo = new ZaicodeJobRepo(h.tasksPath, 500);
    await jobRepo.ensureReady();
    jobRepo.close();
    const db = new DatabaseSync(h.tasksPath);
    const insertJob = db.prepare(
      `INSERT INTO zaicode_jobs (job_id, workspace_key, workspace_path, agent_id, instructions, status, created_at, updated_at,
         started_at, finished_at, attempt, retry_of_job_id, error)
       VALUES (?, 'w', 'V:\\work\\_ZAICODE', 'agent', 'x', ?, 0, 0, ?, ?, 1, ?, ?)`,
    );
    insertJob.run("j1", "failed", now - 3_600_000, now - 3_000_000, null, "dispatch_failed: boom at C:\\secret");
    insertJob.run("j2", "completed", now - 2_000_000, now - 1_000_000, "j1", null);
    db.close();
    const service = h.make();
    await service.recordWorkerSessions([
      { id: "w1", startedAt: now - 7_200_000, endedAt: now - 3_600_000, project: "V:\\work\\_ZAICODE", engine: "A1", exitCode: 0 },
    ]);
    await service.recordWorkerSessions([
      { id: "w1", startedAt: now - 7_200_000, endedAt: now - 3_600_000, project: "V:\\work\\_ZAICODE", engine: "A1", exitCode: 0 },
    ]);
    const stats = await service.getHomeStats({ timeZone: ZONE, now });
    assert.equal(stats.periods.today.jobsDone, 1);
    assert.equal(stats.periods.today.jobsFailed, 1);
    assert.equal(stats.derived.recoveredRuns, 1);
    assert.equal(stats.derived.jobSuccessRate, 0.5);
    assert.equal(stats.periods.today.workerSessions, 1);
    assert.equal(stats.periods.today.agentMs, 600_000 + 1_000_000 + 3_600_000);
    assert.equal(stats.coverage.share, 0); // only unmeasured worker time, no model time
    assert.equal(stats.periods.today.tokens, 0);
    const activity = await service.getRecentActivity();
    assert.equal(activity.length, 3);
    const failed = activity.find((entry) => entry.jobId === "j1");
    assert.equal(failed?.failure, "dispatch_failed"); // the category, never the message with its paths
    assert.equal(activity.find((entry) => entry.jobId === "j2")?.recovered, true);
    service.dispose();
  } finally {
    await h.dispose();
  }
});

test("stats: an empty profile answers honestly (no data, missing store = unavailable)", async () => {
  const now = Date.UTC(2026, 8, 24, 11, 0);
  const dir = await mkdtemp(join(tmpdir(), "zaicode-stats-empty-"));
  try {
    const service = new ZaicodeStatsService({
      repo: new ZaicodeStatsRepo(join(dir, "tasks-index.sqlite")),
      agentDbPath: () => join(dir, "missing.sqlite"),
      now: () => now,
    });
    const stats = await service.getHomeStats({ timeZone: ZONE, now });
    assert.equal(stats.eventCount, 0);
    assert.equal(stats.derived.jobSuccessRate, null);
    assert.equal(stats.derived.tokensTodayVsYesterday, null);
    assert.equal(stats.coverage.share, null);
    assert.equal(stats.streak.current, 0);
    assert.equal(stats.days.length, 182);
    assert.equal(stats.sources.find((source) => source.source === "agent-db")?.state, "unavailable");
    service.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stats: DST end (Tallinn 2026-10-25) keeps events on their own local day", async () => {
  const now = Date.UTC(2026, 9, 26, 10, 0);
  const h = await harness(() => now);
  try {
    // 03:30 local on the 25th happens twice; 00:30 UTC is 03:30 EEST, 01:30 UTC is 03:30 EET.
    addRequest(h.agentDb, "x1", Date.UTC(2026, 9, 25, 0, 30), 10);
    addRequest(h.agentDb, "x2", Date.UTC(2026, 9, 25, 1, 30), 20);
    addRequest(h.agentDb, "x3", Date.UTC(2026, 9, 25, 21, 59), 40); // 23:59 EET on the 25th
    addRequest(h.agentDb, "x4", Date.UTC(2026, 9, 25, 22, 1), 80); // 00:01 on the 26th
    const service = h.make();
    const stats = await service.getHomeStats({ timeZone: ZONE, now });
    assert.equal(stats.periods.yesterday.tokens, 70);
    assert.equal(stats.periods.today.tokens, 80);
    assert.equal(now - DAY < now, true);
    service.dispose();
  } finally {
    await h.dispose();
  }
});
