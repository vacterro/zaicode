import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ZaicodeStatsRepo } from "../src/zaicode/zaicodeStatsRepo.js";
import { ZaicodeStatsService } from "../src/zaicode/zaicodeStatsService.js";

const NOW = Date.UTC(2026, 9, 8, 12);
const OLD = NOW - 120_000;
const PAGE = 5000;
const key = (n: number) => String(n).padStart(8, "0");

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-pagination-"));
  const tasksPath = join(dir, "tasks.sqlite");
  const agentPath = join(dir, "agent.sqlite");
  const repo = new ZaicodeStatsRepo(tasksPath);
  await repo.ensureReady();
  const jobs = new DatabaseSync(tasksPath);
  jobs.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  const agent = new DatabaseSync(agentPath);
  agent.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT);
    INSERT INTO session VALUES('s','fixture/project');
    CREATE TABLE model_usage(id TEXT PRIMARY KEY,session_id TEXT,turn_id TEXT,
      provider_id TEXT,model_id TEXT,agent TEXT,status TEXT,started_at INTEGER,
      completed_at INTEGER,duration_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,
      reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,cache_read_input_tokens INTEGER,
      computed_total_tokens INTEGER,error_type TEXT);
    CREATE TABLE turn_usage(session_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,
      completed_at INTEGER,duration_ms INTEGER,PRIMARY KEY(session_id,turn_id));
    CREATE INDEX model_usage_stats_completion_idx
      ON model_usage(COALESCE(completed_at,started_at),id) WHERE status != 'running';
    CREATE INDEX turn_usage_stats_completion_idx
      ON turn_usage(COALESCE(completed_at,started_at),session_id,turn_id) WHERE status != 'running';`);
  const jobInsert = jobs.prepare(`INSERT INTO zaicode_jobs(job_id,workspace_key,workspace_path,
    agent_id,instructions,status,created_at,updated_at,started_at,finished_at,attempt)
    VALUES(?,'w','fixture/project','a','test','completed',0,0,?,?,1)`);
  const modelInsert = agent.prepare(`INSERT INTO model_usage VALUES(?,'s',?,'p','m',NULL,
    'completed',?,?,10,2,3,0,0,0,5,NULL)`);
  const turnInsert = agent.prepare("INSERT INTO turn_usage VALUES('s',?,'completed',?,?,10)");
  const seed = (stream: "queue" | "model" | "turn", n: number, at = OLD, prefix = "") => {
    const db = stream === "queue" ? jobs : agent;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < n; i++) {
        const id = prefix + key(i);
        if (stream === "queue") jobInsert.run(id, at - 10, at);
        else if (stream === "model") modelInsert.run(id, id, at - 10, at);
        else turnInsert.run(id, at - 10, at);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  let currentRepo = repo;
  let service = new ZaicodeStatsService({ repo, agentDbPath: () => agentPath, now: () => NOW });
  const restart = () => {
    service.dispose();
    currentRepo = new ZaicodeStatsRepo(tasksPath);
    service = new ZaicodeStatsService({ repo: currentRepo, agentDbPath: () => agentPath, now: () => NOW });
  };
  const drain = async (passes: number) => {
    for (let i = 0; i < passes; i++) await service.ingest(true);
  };
  return {
    dir, tasksPath, agentPath, jobs, agent, seed, restart, drain,
    get repo() { return currentRepo; }, get service() { return service; },
    async close() {
      service.dispose(); jobs.close(); agent.close();
      assert.equal(dirname(dir), tmpdir());
      await rm(dir, { recursive: true, force: true });
    },
  };
}

for (const count of [5001, 10_000, 100_000]) {
  for (const stream of ["queue", "model"] as const) {
    test(`pagination: ${stream} drains ${count} equal timestamps and a newer outcome across restart`, async () => {
      const h = await fixture();
      try {
        h.seed(stream, count);
        h.seed(stream, 1, NOW - 1000, "recent-");
        await h.drain(1);
        h.restart();
        await h.drain(Math.ceil((count + 1) / PAGE) + 2);
        const stats = await h.service.getHomeStats({ now: NOW, timeZone: "UTC" });
        assert.equal(stats.eventCount, count + 1);
        if (stream === "queue") assert.equal(stats.periods.all.jobsDone, count + 1);
        else {
          assert.equal(stats.periods.all.requests, count + 1);
          assert.equal(stats.periods.all.tokens, 5 * (count + 1));
          assert.equal(stats.models[0]?.requests, count + 1);
        }
        assert.equal(stats.periods.today[stream === "queue" ? "jobsDone" : "requests"], count + 1);
        const before = h.repo.meta().eventCount;
        await h.drain(Math.ceil((count + 1) / PAGE) + 1);
        assert.equal(h.repo.meta().eventCount, before, "overlap replay remains idempotent");
      } finally { await h.close(); }
    });
  }
}

test("pagination: 200001 tied turns cannot be truncated behind an independent newer model watermark", async () => {
  const h = await fixture();
  try {
    h.seed("turn", 200_001, NOW - 86_400_000);
    h.seed("model", 1, NOW - 1000, "newer-");
    await h.drain(1);
    h.restart();
    await h.drain(42);
    const stats = await h.service.getHomeStats({ now: NOW, timeZone: "UTC" });
    assert.equal(stats.periods.all.turns, 200_001);
    assert.equal(stats.periods.all.requests, 1);
    assert.equal(stats.periods.yesterday.turns, 200_001);
    assert.equal(stats.eventCount, 200_002);
  } finally { await h.close(); }
});

test("pagination: concurrent source inserts behind the active key are recovered by inclusive overlap", async () => {
  const h = await fixture();
  try {
    h.seed("queue", 10_000);
    h.seed("model", 10_000);
    h.seed("turn", 10_000);
    await h.drain(1);
    const otherAgent = new DatabaseSync(h.agentPath);
    const otherJobs = new DatabaseSync(h.tasksPath);
    try {
      otherAgent.prepare("INSERT INTO model_usage SELECT '00000000-late',session_id,turn_id,provider_id,model_id,agent,status,started_at,completed_at,duration_ms,input_tokens,output_tokens,reasoning_tokens,cache_creation_input_tokens,cache_read_input_tokens,computed_total_tokens,error_type FROM model_usage LIMIT 1").run();
      otherAgent.prepare("INSERT INTO turn_usage VALUES('s','00000000-late','completed',?,?,10)").run(OLD - 10, OLD);
      otherJobs.prepare(`INSERT INTO zaicode_jobs(job_id,workspace_key,workspace_path,agent_id,instructions,status,
        created_at,updated_at,started_at,finished_at,attempt) VALUES('00000000-late','w','fixture/project','a','test','completed',0,0,?,?,1)`).run(OLD - 10, OLD);
    } finally { otherAgent.close(); otherJobs.close(); }
    h.restart();
    await h.drain(9);
    assert.equal(h.repo.meta().eventCount, 30_003);
    assert.equal(h.repo.breakdown().models[0]?.requests, 10_001);
  } finally { await h.close(); }
});

test("pagination: a failed partial insertion does not spend its page; replay and restart recover exact totals", async () => {
  const h = await fixture();
  try {
    h.seed("queue", 5001);
    h.jobs.exec(`CREATE TRIGGER reject_batch BEFORE INSERT ON zaicode_stats_events
      WHEN NEW.id='job:00002500:1' BEGIN SELECT RAISE(ABORT,'injected insert failure'); END;`);
    await h.service.ingest(true).catch(() => undefined);
    assert.equal(h.repo.meta().eventCount, 0, "page transaction rolls back");
    assert.equal(h.repo.getCursor("queue"), 0, "durable watermark cannot skip a failed page");
    h.jobs.exec("DROP TRIGGER reject_batch");
    h.restart();
    await h.drain(4);
    assert.equal(h.repo.meta().eventCount, 5001);
  } finally { await h.close(); }
});

test("pagination: Clear during an incomplete scan resets progression without resurrecting history", async () => {
  const h = await fixture();
  try {
    h.seed("queue", 10_000);
    h.seed("model", 10_000);
    h.seed("turn", 10_000);
    await h.drain(1);
    const clear = new ZaicodeStatsRepo(h.tasksPath);
    await clear.ensureReady();
    clear.clear(NOW);
    clear.close();
    h.seed("queue", 1, NOW, "new-");
    h.seed("model", 1, NOW + 10, "new-");
    h.seed("turn", 1, NOW + 10, "new-");
    h.restart();
    await h.drain(4);
    assert.deepEqual(h.repo.all().map(row => row.kind).sort(), ["job.finished", "model.request", "turn"]);
    assert.equal(h.repo.meta().eventCount, 3);
  } finally { await h.close(); }
});

test("pagination: each refresh accepts at most one bounded page per independent stream", async () => {
  const h = await fixture();
  try {
    h.seed("queue", 10_000);
    h.seed("model", 10_000);
    h.seed("turn", 10_000);
    await h.drain(1);
    const rows = h.repo.all();
    assert.equal(rows.filter(row => row.kind === "job.finished").length, PAGE);
    assert.equal(rows.filter(row => row.kind === "model.request").length, PAGE);
    assert.equal(rows.filter(row => row.kind === "turn").length, PAGE);
    assert.equal(h.repo.getCursor("queue"), 0, "partial page is not a completed watermark");
  } finally { await h.close(); }
});
