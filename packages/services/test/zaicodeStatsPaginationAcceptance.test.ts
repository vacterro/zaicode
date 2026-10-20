import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ZaicodeStatsRepo } from "../src/zaicode/zaicodeStatsRepo.js";
import { zaicodeJobStatsEvent } from "../src/zaicode/zaicodeStatsSources.js";
import { readZaicodeUsagePage } from "../src/zaicode/zaicodeStatsAgentPages.js";
import type { ZaicodeStatsPage, ZaicodeStatsScan } from "../src/zaicode/zaicodeStatsScan.js";

const NOW = 1_800_000_000_000;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-scan-acceptance-"));
  const path = join(dir, "tasks.sqlite");
  const a = new ZaicodeStatsRepo(path), b = new ZaicodeStatsRepo(path);
  await a.ensureReady(); await b.ensureReady();
  const db = new DatabaseSync(path);
  const insert = db.prepare(`INSERT INTO zaicode_jobs(job_id,workspace_key,workspace_path,agent_id,
    instructions,status,created_at,updated_at,started_at,finished_at,attempt)
    VALUES(?,'w','fixture/project','a','test','completed',0,0,?,?,1)`);
  const seed = (count: number, at = NOW) => {
    db.exec("BEGIN IMMEDIATE");
    for (let n = 0; n < count; n++) insert.run(String(n).padStart(8, "0"), at - 1, at);
    db.exec("COMMIT");
  };
  const page = (repo: ZaicodeStatsRepo): ZaicodeStatsPage => {
    const scan = repo.scan("queue");
    const read = repo.finishedJobsPage(scan), last = read.rows.at(-1);
    return { scan, until: read.until, rows: read.rows.map(zaicodeJobStatsEvent).filter(row => row !== null),
      at: last ? Number(last.finished_at) : scan.at, id: last ? String(last.job_id) : scan.id,
      key: "", complete: read.rows.length < 5000 };
  };
  return { dir, path, a, b, db, seed, page, async close() {
    a.close(); b.close(); db.close(); assert.equal(dirname(dir), tmpdir());
    await rm(dir, { recursive: true, force: true });
  } };
}

test("scan acceptance: concurrent prepared pages cannot regress another writer's durable progress", async () => {
  const h = await fixture();
  try {
    h.seed(10_001);
    const first = h.page(h.a), stale = h.page(h.b);
    assert.equal(h.a.commitScan(first, NOW), true);
    assert.equal(h.a.commitScan(h.page(h.a), NOW), true);
    assert.equal(h.b.commitScan(stale, NOW), false);
    assert.equal(h.a.meta().eventCount, 10_000);
    assert.equal(h.a.commitScan(h.page(h.a), NOW), true);
    assert.equal(h.b.meta().eventCount, 10_001);
    assert.equal(h.b.getCursor("queue"), NOW);
  } finally { await h.close(); }
});

test("scan acceptance: same-time Clear still invalidates a prepared page and its cursor", async () => {
  const h = await fixture();
  try {
    h.seed(1, NOW + 10);
    const stale = h.page(h.a);
    h.b.clear(NOW); h.b.clear(NOW);
    assert.equal(h.a.commitScan(stale, NOW), false);
    assert.equal(h.a.meta().eventCount, 0);
    assert.equal(h.a.getCursor("queue"), 0);
    assert.equal(h.a.commitScan(h.page(h.a), NOW), true);
    assert.equal(h.a.meta().eventCount, 1, "new event is still eligible after admission retries");
  } finally { await h.close(); }
});

test("scan acceptance: failure writing partial progression rolls back accepted events", async () => {
  const h = await fixture();
  try {
    h.seed(5001);
    h.db.exec(`CREATE TRIGGER reject_progress BEFORE INSERT ON zaicode_stats_progress
      BEGIN SELECT RAISE(ABORT,'injected progression failure'); END;`);
    assert.throws(() => h.a.commitScan(h.page(h.a), NOW), /injected progression failure/);
    assert.equal(h.a.meta().eventCount, 0);
    assert.equal(h.a.scan("queue").revision, 0);
    h.db.exec("DROP TRIGGER reject_progress");
    assert.equal(h.a.commitScan(h.page(h.a), NOW), true);
    assert.equal(h.a.commitScan(h.page(h.a), NOW), true);
    assert.equal(h.a.meta().eventCount, 5001);
  } finally { await h.close(); }
});

test("scan acceptance: v9 upgrade retains historical checksums, events, jobs and cursors", async () => {
  const h = await fixture();
  try {
    h.seed(1);
    h.a.commitScan(h.page(h.a), NOW);
    const ledger = h.db.prepare("SELECT id,checksum FROM tasks_schema_migration WHERE id<'0010' ORDER BY id").all();
    h.a.close(); h.b.close();
    h.db.exec(`DROP TABLE zaicode_stats_progress; DROP INDEX idx_zaicode_jobs_stats_completion;
      DELETE FROM tasks_schema_migration WHERE id='0010_zaicode_stats_progress'`);
    await h.a.ensureReady();
    assert.deepEqual(h.db.prepare("SELECT id,checksum FROM tasks_schema_migration WHERE id<'0010' ORDER BY id").all(), ledger);
    assert.equal(ledger.length, 9);
    assert.equal(h.a.meta().eventCount, 1);
    assert.equal(h.a.getCursor("queue"), NOW);
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM zaicode_jobs").get()?.n, 1);
    h.a.close(); await h.a.ensureReady();
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM tasks_schema_migration").get()?.n, 11);
    assert.equal(h.a.meta().eventCount, 1);
  } finally { await h.close(); }
});

function usageFixture(db: DatabaseSync, indexed = true) {
  db.exec(`CREATE TABLE model_usage(id TEXT PRIMARY KEY,started_at INTEGER,completed_at INTEGER,status TEXT);
    CREATE TABLE turn_usage(session_id TEXT,turn_id TEXT,started_at INTEGER,completed_at INTEGER,status TEXT);
    WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
    INSERT INTO model_usage SELECT printf('%08d',x),${NOW - 1},${NOW},'completed' FROM n;
    INSERT INTO turn_usage SELECT 's',id,started_at,completed_at,status FROM model_usage;`);
  if (indexed) db.exec(`CREATE INDEX model_usage_stats_completion_idx
    ON model_usage(COALESCE(completed_at,started_at),id) WHERE status!='running';
    CREATE INDEX turn_usage_stats_completion_idx
    ON turn_usage(COALESCE(completed_at,started_at),session_id,turn_id) WHERE status!='running';`);
}

test("scan acceptance: final tied pages seek stable keys, avoid sorting and keep latency/memory bounded", t => {
  const db = new DatabaseSync(":memory:");
  try {
    usageFixture(db);
    const statements: string[] = [];
    const trace = new Proxy(db, { get(target, property) {
      if (property === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const base: ZaicodeStatsScan = { source: "agent-model", generation: 0, revision: 0, floor: 0,
      since: 0, until: NOW, at: NOW, id: "00095000", key: "" };
    const rssBefore = process.memoryUsage().rss, begin = performance.now();
    const model = readZaicodeUsagePage(trace, "model_usage", base, false);
    const turn = readZaicodeUsagePage(trace, "turn_usage", { ...base, source: "agent-turn", id: "s", key: "00095000" }, false);
    const elapsed = performance.now() - begin, delta = Math.max(0, process.memoryUsage().rss - rssBefore);
    assert.equal(model.batch.length, 5000); assert.equal(turn.batch.length, 5000);
    assert.equal(model.batch[0]?.id, "00095001"); assert.equal(turn.batch[0]?.turn_id, "00095001");
    for (const [table, args, width] of [["model_usage", [NOW, "00095000", 5000], "2"], ["turn_usage", [NOW, "s", "00095000", 5000], "3"]] as const) {
      const sql = statements.find(sql => sql.startsWith("SELECT u.*") && sql.includes(`FROM ${table}`) && sql.includes("AS ended") && sql.includes("=?"))!;
      assert.ok(sql, "trace observes the actual adapter statement");
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
      assert.ok(plan.some(row => String(row.detail).includes("SEARCH u USING INDEX")));
      assert.ok(plan.every(row => !String(row.detail).includes("TEMP B-TREE")));
      assert.ok(db.prepare(`EXPLAIN ${sql}`).all(...args).some(row => String(row.opcode).startsWith('Seek') && String(row.p4) === width), "seek includes stable ID, not only timestamp");
    }
    assert.ok(elapsed < 3000, `two 5000-row pages took ${elapsed}ms`);
    assert.ok(delta < 64 * 1024 * 1024, `two bounded pages grew RSS by ${delta}`);
    t.diagnostic(JSON.stringify({ sourceRows: 200_000, returnedRows: 10_000, elapsedMs: elapsed, rssGrowthBytes: delta }));
  } finally { db.close(); }
});

test("scan acceptance: large legacy usage store cannot start an unbounded refresh sort", () => {
  const db = new DatabaseSync(":memory:");
  try {
    usageFixture(db, false);
    const scan: ZaicodeStatsScan = { source: "agent-model", generation: 0, revision: 0, floor: 0,
      since: 0, until: null, at: -1, id: "", key: "" };
    assert.throws(() => readZaicodeUsagePage(db, "model_usage", scan, false), /index upgrade required/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM model_usage").get()?.n, 100_000);
  } finally { db.close(); }
});
