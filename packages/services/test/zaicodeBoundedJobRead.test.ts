/**
 * T-248 / SRC-160:R012 — 活跃轮询的有界读取。
 *
 * 契约：limit 是"取最新的 N 行"，且结果仍是升序的原序列尾部；窗口之外未终结的
 * 任务必须照常返回（活跃计数不能因为历史被截断而失真）；省略 limit 与改动前逐字等价。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ZaicodeJob, ZaicodeJobStatus } from "@zcode/shared";
import { zaicodeJobBoundedReadSql, ZaicodeJobRepo } from "../src/zaicode/zaicodeJobRepo.js";
import { ZAICODE_JOB_QUERY_MIGRATION_SQL } from "../src/session/tasksDatabase/zaicode-job-query-v7.js";

interface Harness {
  dir: string;
  dbPath: string;
  repo: ZaicodeJobRepo;
  dispose: () => Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-bounded-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const repo = new ZaicodeJobRepo(dbPath, 500);
  await repo.ensureReady();
  return {
    dir,
    dbPath,
    repo,
    dispose: async () => {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const WORKSPACE_KEY = "ws-key-1";

function makeJob(index: number, status: ZaicodeJobStatus, createdAt: number): ZaicodeJob {
  return {
    id: `job-${index}`,
    workspaceKey: WORKSPACE_KEY,
    workspacePath: "C:\\zaicode\\workspace",
    agentId: "agent-1",
    title: `Job ${index}`,
    instructions: "Perform the test job.",
    status,
    priority: 0,
    sortOrder: 0,
    createdAt,
    updatedAt: createdAt,
    attempt: 0,
  };
}

/** 直接落库：可控的 created_at/status，与命令行耗时无关。 */
async function seed(harness: Harness, jobs: ZaicodeJob[]): Promise<void> {
  for (const job of jobs) await harness.repo.create(job);
}

const ids = (result: { jobs: ZaicodeJob[] }) => result.jobs.map((job) => job.id);

test("有界读取：未达上限的行数与全量读取完全一致", async () => {
  const harness = await createHarness();
  try {
    await seed(
      harness,
      [0, 1, 2].map((index) => makeJob(index, "completed", 1_000 + index)),
    );
    const full = await harness.repo.list({ workspaceKey: WORKSPACE_KEY });
    const bounded = await harness.repo.list({ workspaceKey: WORKSPACE_KEY, limit: 5 });
    assert.deepEqual(bounded, full);
    assert.deepEqual(ids(bounded), ["job-0", "job-1", "job-2"]);
    assert.equal(bounded.diagnostics.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("有界读取：终结历史只留下最新的 limit 行，仍是升序尾部", async () => {
  const harness = await createHarness();
  try {
    // 12 行全为终态历史，limit 5 只能拿到最后 5 行。
    await seed(
      harness,
      Array.from({ length: 12 }, (_, index) => makeJob(index, "completed", 1_000 + index)),
    );
    const full = await harness.repo.list({ workspaceKey: WORKSPACE_KEY });
    assert.equal(full.jobs.length, 12);
    const bounded = await harness.repo.list({ workspaceKey: WORKSPACE_KEY, limit: 5 });
    assert.deepEqual(ids(bounded), ids(full).slice(-5));
    assert.deepEqual(ids(bounded), ["job-7", "job-8", "job-9", "job-10", "job-11"]);
    assert.equal(bounded.diagnostics.length, 0);
  } finally {
    await harness.dispose();
  }
});

test("有界读取：窗口之外仍在跑的任务一条都不能被截掉", async () => {
  const harness = await createHarness();
  try {
    await seed(
      harness,
      [
        makeJob(0, "running", 1_000),
        makeJob(1, "failed", 1_100),
        makeJob(2, "queued", 1_200),
        makeJob(3, "completed", 1_300),
        makeJob(4, "completed", 1_400),
        makeJob(5, "completed", 1_500),
        makeJob(6, "completed", 1_600),
        makeJob(7, "completed", 1_700),
        makeJob(8, "completed", 1_800),
        makeJob(9, "completed", 1_900),
      ],
    );
    const bounded = await harness.repo.list({ workspaceKey: WORKSPACE_KEY, limit: 4 });
    // 窗口 = 最新 4 行（job-6..9）；更老但未终结的 job-0(running)/job-2(queued)
    // 必须补回，job-1 是终态历史不能泄漏。
    assert.deepEqual(ids(bounded), ["job-0", "job-2", "job-6", "job-7", "job-8", "job-9"]);
    assert.equal(bounded.diagnostics.length, 0);
    assert.deepEqual(
      bounded.jobs.map((job) => job.status),
      ["running", "queued", "completed", "completed", "completed", "completed"],
    );
  } finally {
    await harness.dispose();
  }
});

test("有界读取：created_at 相同的行按 sort_order 划窗口边界", async () => {
  const harness = await createHarness();
  try {
    const base = 1_000;
    await seed(harness, [
      { ...makeJob(0, "running", base), sortOrder: 10 },
      { ...makeJob(1, "queued", base), sortOrder: 20 },
      { ...makeJob(2, "completed", base), sortOrder: 30 },
      { ...makeJob(3, "completed", base), sortOrder: 40 },
      { ...makeJob(4, "completed", base), sortOrder: 50 },
    ]);
    // 窗口边界 (base, 30)：同时间戳但更小的 sort_order 仍算"窗口之外"，未终结的要补回。
    const bounded = await harness.repo.list({ workspaceKey: WORKSPACE_KEY, limit: 2 });
    assert.deepEqual(ids(bounded), ["job-0", "job-1", "job-3", "job-4"]);
    const wider = await harness.repo.list({ workspaceKey: WORKSPACE_KEY, limit: 3 });
    assert.deepEqual(ids(wider), ["job-0", "job-1", "job-2", "job-3", "job-4"]);
  } finally {
    await harness.dispose();
  }
});

test("有界读取的两条生产语句都由 0007 的索引满足，无 TEMP B-TREE", async () => {
  const harness = await createHarness();
  const db = new DatabaseSync(harness.dbPath);
  try {
    await seed(
      harness,
      Array.from({ length: 40 }, (_, index) => makeJob(index, "completed", 1_000 + index)),
    );
    const sql = zaicodeJobBoundedReadSql(["workspace_key = @workspaceKey"]);
    const planOf = (statement: string, params: Record<string, string | number>) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(params) as unknown as { detail: string }[])
        .map((row) => row.detail)
        .join(" | ");

    // 窗口读取：按 created_at DESC, sort_order DESC 走索引并提前 LIMIT 结束。
    const recent = planOf(sql.recent, { workspaceKey: WORKSPACE_KEY, limit: 5 });
    assert.match(recent, /idx_zaicode_jobs_recent/);
    assert.doesNotMatch(recent, /TEMP B-TREE/);

    // 补取窗口之外仍未终结的行：必须命中部分索引，否则每个 3 秒 tick 都要扫全史
    // （500k 终结行实测 167ms）。两份 status 列表一旦漂移，这里会退化成表扫描。
    const olderActive = planOf(sql.olderActive, {
      workspaceKey: WORKSPACE_KEY,
      windowStart: 1_050,
      windowSort: 50,
    });
    assert.match(olderActive, /idx_zaicode_jobs_open/);
    assert.doesNotMatch(olderActive, /TEMP B-TREE/);

    // migration 0007 的两条语句必须与落库的索引文本一致（SQLite 会去掉 IF NOT EXISTS）。
    const normalize = (text: string) =>
      text
        .replace(/\bIF NOT EXISTS\b/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/;$/, "")
        .trim();
    const statements = ZAICODE_JOB_QUERY_MIGRATION_SQL.trim()
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    assert.equal(statements.length, 2);
    for (const statement of statements) {
      const name = statement.match(/idx_zaicode_jobs_\w+/)?.[0] ?? "";
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
        .get(name) as { sql: string } | undefined;
      assert.ok(row, `migration 0007 建了索引 ${name}`);
      assert.equal(normalize(row.sql), normalize(statement));
    }
  } finally {
    db.close();
    await harness.dispose();
  }
});
