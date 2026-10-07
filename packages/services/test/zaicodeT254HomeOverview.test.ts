// T-254 — 首页只反序列化近期窗口和全部未终结任务，历史计数仍由同一 SQLite 快照给出。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { type ZaicodeJob } from "@zcode/shared";
import { ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZaicodeJobService } from "../src/zaicode/zaicodeJobService.js";

const DAY = 86_400_000;
const NOW = 10 * DAY + 12 * 3_600_000;
const DAY_START = 10 * DAY;
const params = { dayStart: DAY_START, now: NOW, recentLimit: 20 };
const job = (id: string, patch: Partial<ZaicodeJob> = {}): ZaicodeJob => ({
  id,
  workspaceKey: "one",
  workspacePath: "C:/test/one",
  agentId: "agent",
  title: id,
  instructions: "Work",
  status: "completed",
  priority: 0,
  sortOrder: 0,
  createdAt: 100,
  updatedAt: 100,
  attempt: 0,
  finishedAt: DAY_START - 1,
  ...patch,
});

async function withRepo(run: (repo: ZaicodeJobRepo, db: DatabaseSync) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-t254-"));
  const path = join(dir, "tasks-index.sqlite");
  const repo = new ZaicodeJobRepo(path);
  let db: DatabaseSync | undefined;
  try {
    await repo.ensureReady();
    db = new DatabaseSync(path);
    await run(repo, db);
  } finally {
    db?.close();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function history(db: DatabaseSync, count = 300): void {
  const insert = db.prepare(`INSERT INTO zaicode_jobs
    (job_id, workspace_key, workspace_path, agent_id, title, instructions, status,
     priority, sort_order, created_at, updated_at, attempt, finished_at)
    VALUES (?, 'history', 'C:/test/history', 'agent', 'Old job', 'Work', 'completed',
            0, 0, ?, ?, 0, ?)`);
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) insert.run(`history-${i}`, 1_000 + i, 1_000 + i, NOW - 2 * DAY);
  db.exec("COMMIT");
}

interface ReadTrace {
  sql: string;
  args: unknown[];
  rows: number;
}
async function traceReads<T>(t: TestContext, run: () => Promise<T>) {
  const probe = new DatabaseSync(":memory:");
  const prototype = Object.getPrototypeOf(probe.prepare("SELECT 1")) as StatementSync;
  probe.close();
  const reads: ReadTrace[] = [];
  const all = prototype.all;
  const get = prototype.get;
  const allMock = t.mock.method(
    prototype,
    "all",
    function (this: StatementSync, ...args: unknown[]) {
      const rows = Reflect.apply(all, this, args) as ReturnType<StatementSync["all"]>;
      if (/FROM zaicode_jobs\b/i.test(this.sourceSQL))
        reads.push({ sql: this.sourceSQL, args, rows: rows.length });
      return rows;
    },
  );
  const getMock = t.mock.method(
    prototype,
    "get",
    function (this: StatementSync, ...args: unknown[]) {
      const row = Reflect.apply(get, this, args) as ReturnType<StatementSync["get"]>;
      if (/FROM zaicode_jobs\b/i.test(this.sourceSQL))
        reads.push({ sql: this.sourceSQL, args, rows: row ? 1 : 0 });
      return row;
    },
  );
  try {
    return { result: await run(), reads };
  } finally {
    allMock.mock.restore();
    getMock.mock.restore();
  }
}

test("T-254: exact live, midnight and rolling counts do not depend on the recent window", async () => {
  await withRepo(async (repo, db) => {
    history(db);
    const fixtures = [
      job("running", { status: "running" }),
      job("queued", { status: "queued" }),
      job("ready", { status: "ready", workspaceKey: "two" }),
      job("draft", { status: "draft" }),
      job("waiting", { status: "waiting" }),
      job("blocked", { status: "blocked" }),
      job("midnight", { finishedAt: DAY_START }),
      job("last24", { finishedAt: NOW - DAY + 1 }),
      job("boundary", { finishedAt: NOW - DAY }),
      job("failure", { status: "failed", finishedAt: NOW }),
      job("cancelled", { status: "cancelled", finishedAt: NOW }),
      job("missing", { finishedAt: undefined }),
    ];
    for (const row of fixtures) await repo.create(row);
    const overview = await repo.getHomeOverview(params);
    assert.deepEqual(overview.counts, {
      running: 1,
      ready: 2,
      waiting: 2,
      blocked: 1,
      doneToday: 1,
      failedToday: 1,
    });
    assert.equal(overview.doneLast24h, 2, "strict 24h boundary, inclusive local midnight");
    assert.equal(overview.dayStart, DAY_START);
    assert.equal(overview.capturedAt, NOW);
    assert.equal(overview.jobs.length, 26, "20 newest + 6 open jobs older than the window");
    assert.deepEqual(
      overview.jobs.filter((row) => row.createdAt === 100).map((row) => row.id),
      ["blocked", "draft", "queued", "ready", "running", "waiting"],
    );
    assert.ok(await repo.get("midnight"), "old history remains directly accessible");
  });
});

test("T-254: actual hot statements read bounded rows and use covering/order indexes", async (t) => {
  await withRepo(async (repo, db) => {
    history(db, 2_000);
    await repo.create(job("old-active", { status: "running" }));
    const { result, reads } = await traceReads(t, () => repo.getHomeOverview(params));
    const jobReads = reads.filter((read) => /SELECT\s+\*/i.test(read.sql));
    assert.ok(jobReads.length > 0);
    assert.ok(
      jobReads.reduce((sum, read) => sum + read.rows, 0) <= 21,
      "never fetch the old terminal rows",
    );
    assert.equal(result.jobs.length, 21);
    const plans = reads
      .map((read) => {
        const statement = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`);
        const rows = Reflect.apply(statement.all, statement, read.args) as { detail: string }[];
        return rows.map((row) => row.detail).join(" | ");
      })
      .join("\n");
    assert.match(plans, /idx_zaicode_jobs_home_recent/);
    assert.match(plans, /idx_zaicode_jobs_open/);
    assert.match(plans, /COVERING INDEX idx_zaicode_jobs_home_finished/);
    assert.doesNotMatch(plans, /TEMP B-TREE|SCAN zaicode_jobs(?! USING (?:COVERING )?INDEX)\b/);
  });
});

test("T-254: recent ties have deterministic binary id order and open rows are not duplicated", async () => {
  await withRepo(async (repo) => {
    for (const id of ["b", "a", "c"]) await repo.create(job(id, { createdAt: 500, sortOrder: 9 }));
    await repo.create(job("old-running", { status: "running" }));
    await repo.create(job("z", { createdAt: 500, sortOrder: 9, status: "queued" }));
    const result = await repo.getHomeOverview({ ...params, recentLimit: 2 });
    assert.deepEqual(
      result.jobs.map((row) => row.id),
      ["old-running", "c", "z"],
    );
    assert.equal(result.counts.ready, 1);
  });
});

test("T-254: corrupt selected metadata stays diagnostic; durable status counts remain exact", async () => {
  await withRepo(async (repo, db) => {
    history(db);
    await repo.create(job("bad-open", { status: "running" }));
    await repo.create(job("bad-recent", { createdAt: 5_000, finishedAt: NOW }));
    db.prepare(
      "UPDATE zaicode_jobs SET delegation_json='{' WHERE job_id IN ('bad-open','bad-recent','history-0')",
    ).run();
    const result = await repo.getHomeOverview(params);
    assert.deepEqual(
      result.diagnostics.map((row) => row.jobId),
      ["bad-open", "bad-recent"],
    );
    assert.equal(result.counts.running, 1);
    assert.equal(result.counts.doneToday, 1);
    assert.equal(result.doneLast24h, 1);
    assert.equal(result.jobs.length, 19);
    assert.equal(
      db.prepare("SELECT delegation_json FROM zaicode_jobs WHERE job_id='bad-open'").get()
        ?.delegation_json,
      "{",
    );
  });
});

test("T-254: concurrent writer cannot mix recent rows, open rows and outcome counts", async (t) => {
  await withRepo(async (repo, db) => {
    await repo.create(job("running", { status: "running" }));
    await repo.create(job("recent", { createdAt: 2_000, finishedAt: NOW }));
    const probe = db.prepare("SELECT 1");
    const prototype = Object.getPrototypeOf(probe) as StatementSync;
    const original = prototype.all;
    let changed = false;
    const mock = t.mock.method(
      prototype,
      "all",
      function (this: StatementSync, ...args: unknown[]) {
        const rows = Reflect.apply(original, this, args) as ReturnType<StatementSync["all"]>;
        if (!changed && /SELECT\s+\*\s+FROM zaicode_jobs/i.test(this.sourceSQL)) {
          changed = true;
          db.prepare(
            "UPDATE zaicode_jobs SET status='completed', finished_at=? WHERE job_id='running'",
          ).run(NOW);
        }
        return rows;
      },
    );
    let result;
    try {
      result = await repo.getHomeOverview({ ...params, recentLimit: 1 });
    } finally {
      mock.mock.restore();
    }
    assert.ok(changed, "writer ran between overview reads");
    assert.equal(result.counts.running, 1);
    assert.equal(result.counts.doneToday, 1);
    assert.equal(result.jobs.find((row) => row.id === "running")?.status, "running");
    const next = await repo.getHomeOverview(params);
    assert.equal(next.counts.running, 0);
    assert.equal(next.counts.doneToday, 2);
  });
});

test("T-254: failed read releases its transaction for a later successful refresh", async (t) => {
  await withRepo(async (repo, db) => {
    history(db);
    const original = DatabaseSync.prototype.prepare;
    let failed = false;
    const mock = t.mock.method(
      DatabaseSync.prototype,
      "prepare",
      function (this: DatabaseSync, sql: string) {
        if (!failed && /FROM zaicode_jobs/i.test(sql)) {
          failed = true;
          throw new Error("probe read failure");
        }
        return original.call(this, sql);
      },
    );
    try {
      await assert.rejects(repo.getHomeOverview(params), /probe read failure/);
    } finally {
      mock.mock.restore();
    }
    assert.equal((await repo.getHomeOverview(params)).jobs.length, 20);
    assert.equal((await repo.get("history-0"))?.id, "history-0");
  });
});

test("T-254: service uses host time, clamps history window and rejects stale/invalid midnight", async () => {
  await withRepo(async (repo, db) => {
    history(db);
    const service = new ZaicodeJobService({
      repo,
      getAgent: async () => null,
      getExecutor: () => null,
      now: () => NOW,
    });
    try {
      for (const [limit, size] of [
        [undefined, 20],
        [0, 1],
        [-10, 1],
        [2.8, 2],
        [999, 200],
        [NaN, 20],
      ] as const) {
        const result = await service.getHomeOverview(DAY_START, limit);
        assert.equal(result.jobs.length, size);
        assert.equal(result.capturedAt, NOW);
      }
      for (const start of [NaN, Infinity, -1, NOW + 1, NOW - 26 * 3_600_000 - 1])
        await assert.rejects(service.getHomeOverview(start), /Invalid home dayStart/);
      assert.equal(
        (await service.getHomeOverview(NOW - 25 * 3_600_000)).dayStart,
        NOW - 25 * 3_600_000,
      );
    } finally {
      service.dispose();
    }
    await assert.rejects(service.getHomeOverview(DAY_START), /service_disposed/);
  });
});

test("T-254: empty durable queue has known zero counts and no rows or diagnostics", async () => {
  await withRepo(async (repo) => {
    assert.deepEqual(await repo.getHomeOverview(params), {
      jobs: [],
      diagnostics: [],
      counts: { running: 0, ready: 0, waiting: 0, blocked: 0, doneToday: 0, failedToday: 0 },
      doneLast24h: 0,
      dayStart: DAY_START,
      capturedAt: NOW,
    });
  });
});

test("T-254: SQLite text, blob and infinite finish corruption cannot inflate native outcome counts", async () => {
  await withRepo(async (repo, db) => {
    await repo.create(job("valid", { finishedAt: NOW }));
    const damaged = ["not-a-time", "", new Uint8Array([1, 2]), Infinity];
    for (const [i, value] of damaged.entries()) {
      await repo.create(job(`damaged-${i}`, { finishedAt: NOW }));
      db.prepare("UPDATE zaicode_jobs SET finished_at=? WHERE job_id=?").run(value, `damaged-${i}`);
    }
    const result = await repo.getHomeOverview(params);
    assert.equal(result.counts.doneToday, 1);
    assert.equal(result.doneLast24h, 1);
    assert.equal(result.jobs.length, 1);
    assert.equal(result.diagnostics.length, damaged.length);
  });
});

test("T-254: v8 upgrade preserves released checksums and existing rows; reopening is idempotent", async () => {
  await withRepo(async (repo, db) => {
    await repo.create(job("existing"));
    const released = db
      .prepare("SELECT id, checksum FROM tasks_schema_migration WHERE id<'0009' ORDER BY id")
      .all();
    assert.equal(released.length, 8);
    db.exec(`DROP INDEX IF EXISTS idx_zaicode_jobs_home_recent; DROP INDEX IF EXISTS idx_zaicode_jobs_home_finished;
      DELETE FROM tasks_schema_migration WHERE id='0009_zaicode_home_query'`);
    repo.close();
    await repo.ensureReady();
    assert.deepEqual(
      db
        .prepare("SELECT id, checksum FROM tasks_schema_migration WHERE id<'0009' ORDER BY id")
        .all(),
      released,
    );
    assert.ok(
      db.prepare("SELECT id FROM tasks_schema_migration WHERE id='0009_zaicode_home_query'").get(),
    );
    assert.equal((await repo.getHomeOverview(params)).jobs[0]?.id, "existing");
    repo.close();
    await repo.ensureReady();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks_schema_migration").get()?.n, 9);
    assert.equal((await repo.get("existing"))?.id, "existing");
  });
});
