import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { ZAICODE_STATS_CLEARED_CURSOR, ZaicodeStatsRepo, type ZaicodeStatsEventRow } from "../src/zaicode/zaicodeStatsRepo.js";
import { ZaicodeStatsService } from "../src/zaicode/zaicodeStatsService.js";

function event(id: string, at: number): ZaicodeStatsEventRow {
  return { id, at, source: "workers", kind: "worker.session", startedAt: at - 10, durationMs: 10,
    project: "fixture", sessionId: null, jobId: null, agent: null, engine: "fixture", provider: null, model: null,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
    totalTokens: null, result: "completed", failure: null, retryOf: null };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-clear-barrier-"));
  const path = join(dir, "tasks-index.sqlite");
  const first = new ZaicodeStatsRepo(path), second = new ZaicodeStatsRepo(path);
  await first.ensureReady();
  await second.ensureReady();
  return { dir, path, first, second, async dispose() {
    first.close(); second.close();
    assert.equal(resolve(dirname(dir)), resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true });
  } };
}

test("Clear rolls back history and cursor deletion when persisting its floor fails", async () => {
  const h = await fixture();
  const control = new DatabaseSync(h.path);
  try {
    h.first.insertEvents([event("kept", 90)], 100);
    h.first.setCursor("queue", 90, 100);
    h.first.setCursor(ZAICODE_STATS_CLEARED_CURSOR, 10, 100);
    control.exec(`CREATE TRIGGER fail_clear_floor BEFORE INSERT ON zaicode_stats_cursor
      WHEN NEW.source = 'cleared' BEGIN SELECT RAISE(ABORT, 'injected floor write failure'); END`);
    assert.throws(() => h.first.clear(200), /injected floor write failure/);
    assert.deepEqual(h.second.all().map(row => row.id), ["kept"]);
    assert.equal(h.second.getCursor("queue"), 90);
    assert.equal(h.second.getCursor(ZAICODE_STATS_CLEARED_CURSOR), 10);
    control.exec("DROP TRIGGER fail_clear_floor");
    h.first.clear(200);
    assert.equal(h.second.meta().eventCount, 0, "the repaired instrument also recognizes a valid Clear");
    assert.equal(h.second.getCursor(ZAICODE_STATS_CLEARED_CURSOR), 200);
  } finally { control.close(); await h.dispose(); }
});

test("a connection opened before Clear cannot reinsert a stale batch; the floor is inclusive", async () => {
  const h = await fixture();
  try {
    const prepared = [event("old", 199), event("boundary", 200), event("new", 201)];
    assert.equal(h.first.getCursor(ZAICODE_STATS_CLEARED_CURSOR), 0);
    h.second.clear(200);
    assert.equal(h.first.insertEvents(prepared, 210), 2);
    assert.deepEqual(h.second.all().map(row => row.id), ["boundary", "new"]);
    assert.equal(h.first.insertEvents(prepared, 220), 0, "stable IDs retain replay idempotency");
    h.first.close(); await h.first.ensureReady();
    assert.equal(h.first.getCursor(ZAICODE_STATS_CLEARED_CURSOR), 200);
    assert.equal(h.first.insertEvents(prepared, 230), 0, "the barrier and IDs survive restart");
    assert.equal(h.first.insertEvents([event("later", 240)], 240), 1);
  } finally { await h.dispose(); }
});

test("Clear between worker-batch preparation and insertion is enforced by the durable writer", async () => {
  const h = await fixture();
  const service = new ZaicodeStatsService({ repo: h.first, now: () => 210 });
  try {
    const insert = h.first.insertEvents.bind(h.first);
    let crossed = false;
    h.first.insertEvents = (rows, now) => {
      if (!crossed) { crossed = true; h.second.clear(200); }
      return insert(rows, now);
    };
    const inserted = await service.recordWorkerSessions([
      { id: "stale", startedAt: 150, endedAt: 199, project: "fixture", engine: "A1", exitCode: 0 },
      { id: "new", startedAt: 190, endedAt: 201, project: "fixture", engine: "A2", exitCode: 0 },
    ]);
    assert.equal(crossed, true);
    assert.equal(inserted, 1);
    assert.deepEqual(h.second.all().map(row => row.id), ["worker:new"]);
  } finally { service.dispose(); await h.dispose(); }
});

test("a stale insertion waits for another SQLite writer then reads its committed Clear floor", async () => {
  const h = await fixture();
  const signal = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const signal = new Int32Array(workerData.signal);
    const db = new DatabaseSync(workerData.path);
    db.exec('PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE; DELETE FROM zaicode_stats_events; DELETE FROM zaicode_stats_cursor');
    db.prepare('INSERT INTO zaicode_stats_cursor VALUES (?, ?, ?)').run('cleared', 200, 200);
    Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
    setTimeout(() => { db.exec('COMMIT'); Atomics.store(signal, 1, 1); db.close(); }, 300);
  `, { eval: true, workerData: { path: h.path, signal: signal.buffer } });
  const exited = new Promise<void>((resolveExit, reject) => {
    worker.once("error", reject);
    worker.once("exit", code => code === 0 ? resolveExit() : reject(new Error(`fixture writer exited ${code}`)));
  });
  try {
    assert.equal(Atomics.wait(signal, 0, 0, 5000) === "timed-out", false, "fixture acquired the write lock");
    assert.equal(Atomics.load(signal, 0), 1);
    assert.equal(Atomics.load(signal, 1), 0, "competing writer is still inside its Clear transaction");
    assert.equal(h.first.insertEvents([event("old", 199), event("boundary", 200), event("new", 201)], 210), 2);
    assert.equal(Atomics.load(signal, 1), 1, "insertion completed after Clear committed");
    await exited;
    assert.deepEqual(h.first.all().map(row => row.id), ["boundary", "new"]);
  } finally { await worker.terminate(); await h.dispose(); }
});

test("Clear changes only statistics tables and accepts genuinely new post-clear events", async () => {
  const h = await fixture();
  const control = new DatabaseSync(h.path);
  try {
    control.prepare(`INSERT INTO zaicode_jobs
      (job_id,workspace_key,workspace_path,agent_id,instructions,status,created_at,updated_at)
      VALUES ('preserved-job','fixture','fixture','agent','fixture','queued',0,0)`).run();
    h.first.insertEvents([event("old", 100)], 100);
    h.first.setCursor("agent-db", 100, 100);
    h.first.clear(200);
    assert.equal(h.second.meta().eventCount, 0);
    assert.equal(h.second.getCursor("agent-db"), 0);
    assert.equal(h.second.getCursor(ZAICODE_STATS_CLEARED_CURSOR), 200);
    assert.equal(control.prepare("SELECT COUNT(*) AS n FROM zaicode_jobs WHERE job_id='preserved-job'").get()?.n, 1);
    assert.equal(h.second.insertEvents([event("new", 201)], 220), 1);
    assert.deepEqual(h.first.all().map(row => row.id), ["new"]);
  } finally { control.close(); await h.dispose(); }
});
