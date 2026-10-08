import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { ZaicodeJobRepo } from "../../../zcode/packages/services/src/zaicode/zaicodeJobRepo.js";
import { ZAICODE_HOME_QUERY_MIGRATION_SQL } from "../../../zcode/packages/services/src/session/tasksDatabase/zaicode-home-query-v9.js";

const DAY = 86_400_000;
const now = Date.now();
const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
const dayStart = midnight.getTime();
const round = (n: number) => Math.round(n * 100) / 100;
const measurements = [];
for (const terminalRows of [100_000, 500_000]) {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-t254-scale-"));
  const path = join(dir, "tasks-index.sqlite");
  const repo = new ZaicodeJobRepo(path);
  await repo.ensureReady();
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(`INSERT INTO zaicode_jobs
      (job_id, workspace_key, workspace_path, agent_id, title, instructions, status,
       priority, sort_order, created_at, updated_at, attempt, finished_at)
      VALUES (?, ?, 'C:/scale', 'agent', 'Scale job', 'Work', ?, 0, 0, ?, ?, 0, ?)`);
    db.exec("BEGIN");
    for (let i = 0; i < terminalRows; i++) insert.run(`history-${i}`, `ws-${i % 5}`, "completed", 1_000 + i, 1_000 + i, now - 2 * DAY);
    for (const status of ["draft", "queued", "ready", "running", "waiting", "blocked"])
      insert.run(`old-${status}`, `ws-${status}`, status, 1, 1, null);
    // Today's outcomes are older than the window: truncation cannot accidentally satisfy these counts.
    for (let i = 0; i < 15; i++) insert.run(`today-${i}`, "today", i < 12 ? "completed" : "failed", 2, 2, now);
    db.exec("COMMIT");
    db.exec("DROP INDEX idx_zaicode_jobs_home_recent; DROP INDEX idx_zaicode_jobs_home_finished");
    const indexStart = performance.now(); db.exec(ZAICODE_HOME_QUERY_MIGRATION_SQL);
    const indexBuildMs = round(performance.now() - indexStart);
    const fullStart = performance.now(); const full = await repo.list(); const fullMs = round(performance.now() - fullStart);
    const prototype = Object.getPrototypeOf(db.prepare("SELECT 1")) as StatementSync;
    const all = prototype.all, get = prototype.get;
    const reads: { sql: string; args: unknown[]; rows: number }[] = [];
    prototype.all = function (...args: unknown[]) {
      const rows = Reflect.apply(all, this, args) as ReturnType<StatementSync["all"]>;
      if (/FROM zaicode_jobs\b/i.test(this.sourceSQL)) reads.push({ sql: this.sourceSQL, args, rows: rows.length });
      return rows;
    };
    prototype.get = function (...args: unknown[]) {
      const row = Reflect.apply(get, this, args) as ReturnType<StatementSync["get"]>;
      if (/FROM zaicode_jobs\b/i.test(this.sourceSQL)) reads.push({ sql: this.sourceSQL, args, rows: row ? 1 : 0 });
      return row;
    };
    let overview, overviewMs;
    try {
      const start = performance.now(); overview = await repo.getHomeOverview({ dayStart, now, recentLimit: 20 });
      overviewMs = round(performance.now() - start);
    } finally { prototype.all = all; prototype.get = get; }
    const plans = reads.map((read) => {
      const statement = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`);
      return (Reflect.apply(statement.all, statement, read.args) as { detail: string }[]).map((row) => row.detail).join(" | ");
    });
    const expectedCounts = { running: 1, ready: 2, waiting: 2, blocked: 1, doneToday: 12, failedToday: 3 };
    assert.deepEqual(overview.counts, expectedCounts);
    assert.equal(overview.doneLast24h, 12);
    assert.equal(overview.jobs.length, 26);
    assert.equal(full.jobs.length, terminalRows + 21);
    assert.equal(reads.filter((read) => /SELECT\s+\*/i.test(read.sql)).reduce((n, read) => n + read.rows, 0), 26);
    assert.equal(overview.jobs.filter((job) => job.id.startsWith("old-")).length, 6);
    assert.ok(overview.jobs.filter((job) => job.status === "completed").every((job) => Number(job.id.split("-")[1]) >= terminalRows - 20));
    assert.match(plans.join("\n"), /idx_zaicode_jobs_home_recent/);
    assert.match(plans.join("\n"), /idx_zaicode_jobs_open/);
    assert.match(plans.join("\n"), /COVERING INDEX idx_zaicode_jobs_home_finished/);
    assert.doesNotMatch(plans.join("\n"), /TEMP B-TREE/);
    const oldJobFetchable = (await repo.get(`history-${Math.floor(terminalRows / 2)}`)) !== null;
    assert.ok(oldJobFetchable);
    const measurement = { terminalRows, fullRows: full.jobs.length, fullMs, overviewRows: overview.jobs.length,
      overviewMs, indexBuildMs, counts: overview.counts, doneLast24h: overview.doneLast24h, oldJobFetchable,
      actualReads: reads.map(({ sql, rows }) => ({ sql, rows })), plans };
    measurements.push(measurement);
    process.stdout.write(JSON.stringify({ terminalRows, fullMs, overviewMs, overviewRows: overview.jobs.length }) + "\n");
  } finally {
    db.close(); repo.close(); await rm(dir, { recursive: true, force: true });
  }
}
await writeFile(join(import.meta.dirname, "scale-probe.json"), JSON.stringify({ ticket: "T-254", at: new Date().toISOString(), dayStart, now, measurements }, null, 2) + "\n");
