// T-248 / SRC-160:R012 (PERF-001) scale probe -- one-off evidence run, not a committed test.
//
// Answers the audit's own VERIFY bullets that the unit suite deliberately keeps small:
//   * seed 100,000 and 500,000 terminal jobs plus a small fixed active set
//   * one visible active-workspace poll stays bounded as terminal history grows
//   * the hot query needs no temp B-tree over the whole history
//   * an arbitrary old job stays directly fetchable
//
// Run: node --import tsx .saipen/evidence/T-248-src160/scale-probe.mts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { ZaicodeJobRepo, zaicodeJobBoundedReadSql } from "../../../zcode/packages/services/src/zaicode/zaicodeJobRepo.js";
import { ZAICODE_JOB_QUERY_MIGRATION_SQL } from "../../../zcode/packages/services/src/session/tasksDatabase/zaicode-job-query-v7.js";

const WORKSPACE_KEY = "ws-scale";
const LIMIT = 200;
const ACTIVE_ID = "job-active-oldest";

interface Measurement {
  jobs: number;
  fullRows: number;
  fullMs: number;
  boundedRows: number;
  boundedMs: number;
  boundedPlan: string;
  fullPlan: string;
  oldJobFetchable: boolean;
  activeJobPresent: boolean;
  indexBuildMs: number;
  // Correctness invariants at scale, not just row counts.
  boundedSubsetOfFull: boolean;
  everyOpenJobKept: boolean;
  windowOnlyRowsAreNewest: boolean;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

async function seed(db: DatabaseSync, count: number, startAt: number): Promise<void> {
  const insert = db.prepare(
    `INSERT INTO zaicode_jobs (
       job_id, workspace_key, workspace_path, agent_id, title, instructions, status,
       priority, sort_order, created_at, updated_at, attempt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)`,
  );
  db.exec("BEGIN");
  for (let index = 0; index < count; index += 1) {
    const createdAt = startAt + index;
    insert.run(
      `job-${createdAt}`,
      WORKSPACE_KEY,
      "C:\\scale",
      "agent-1",
      `Job ${createdAt}`,
      "Perform the test job.",
      "completed",
      index,
      createdAt,
      createdAt,
    );
  }
  db.exec("COMMIT");
}

async function measure(jobCount: number): Promise<Measurement> {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-scale-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const repo = new ZaicodeJobRepo(dbPath, 500);
  await repo.ensureReady();
  const db = new DatabaseSync(dbPath);
  try {
    // The oldest row is the fixed active set: a running job older than any window.
    db.prepare(
      `INSERT INTO zaicode_jobs (
         job_id, workspace_key, workspace_path, agent_id, title, instructions, status,
         priority, sort_order, created_at, updated_at, attempt
       ) VALUES (?, ?, ?, ?, ?, ?, 'running', 0, 0, 1, 1, 0)`,
    ).run(ACTIVE_ID, WORKSPACE_KEY, "C:\\scale", "agent-1", "Oldest active", "Stay visible.");
    await seed(db, jobCount, 1_000);

    // Migration 0007's one-time cost on an already-full database: drop the indexes
    // (as a pre-0007 store would look) and time the exact migration SQL the runner execs.
    db.exec("DROP INDEX IF EXISTS idx_zaicode_jobs_recent");
    db.exec("DROP INDEX IF EXISTS idx_zaicode_jobs_open");
    const buildStart = performance.now();
    db.exec(ZAICODE_JOB_QUERY_MIGRATION_SQL);
    const indexBuildMs = Math.round((performance.now() - buildStart) * 100) / 100;

    const fullStart = performance.now();
    const full = await repo.list({ workspaceKey: WORKSPACE_KEY });
    const fullMs = performance.now() - fullStart;

    const boundedStart = performance.now();
    const bounded = await repo.list({ workspaceKey: WORKSPACE_KEY, limit: LIMIT });
    const boundedMs = performance.now() - boundedStart;

    const sql = zaicodeJobBoundedReadSql(["workspace_key = @workspaceKey"]);
    const planOf = (statement: string, params: Record<string, string | number>) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(params) as unknown as { detail: string }[])
        .map((row) => row.detail)
        .join(" | ");

    const boundedPlan = planOf(sql.recent, { workspaceKey: WORKSPACE_KEY, limit: LIMIT });
    const fullPlan = planOf(
      `SELECT * FROM zaicode_jobs WHERE workspace_key = @workspaceKey ORDER BY created_at ASC, sort_order ASC`,
      { workspaceKey: WORKSPACE_KEY },
    );

    const oldJob = await repo.get(`job-${1000 + Math.floor(jobCount / 2)}`);

    // Invariants a bounded poll must hold at any history size: it never invents a row,
    // it never drops a job that is still open, and the rows it returns beyond the open
    // set are exactly the newest window of the full ordering.
    const fullIds = new Set(full.jobs.map((job) => job.id));
    const openIds = new Set(full.jobs.filter((job) => !TERMINAL.has(job.status)).map((job) => job.id));
    const newestWindow = new Set(full.jobs.slice(-LIMIT).map((job) => job.id));
    const boundedIds = bounded.jobs.map((job) => job.id);
    const boundedIdSet = new Set(boundedIds);

    return {
      jobs: jobCount,
      fullRows: full.jobs.length + full.diagnostics.length,
      fullMs: Math.round(fullMs * 100) / 100,
      boundedRows: bounded.jobs.length + bounded.diagnostics.length,
      boundedMs: Math.round(boundedMs * 100) / 100,
      boundedPlan,
      fullPlan,
      oldJobFetchable: oldJob !== null,
      activeJobPresent: bounded.jobs.some((job) => job.id === ACTIVE_ID),
      indexBuildMs,
      boundedSubsetOfFull: boundedIds.every((id) => fullIds.has(id)),
      everyOpenJobKept: [...openIds].every((id) => boundedIdSet.has(id)),
      windowOnlyRowsAreNewest: boundedIds
        .filter((id) => !openIds.has(id))
        .every((id) => newestWindow.has(id)),
    };
  } finally {
    db.close();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const measurements: Measurement[] = [];
for (const count of [100_000, 500_000]) measurements.push(await measure(count));

const report = {
  ticket: "T-248",
  requirement: "SRC-160:R012",
  audit: "PERF-001",
  date: new Date().toISOString(),
  windowLimit: LIMIT,
  measurements,
};
await writeFile(
  join(import.meta.dirname, "scale-probe.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
for (const measurement of measurements) {
  console.log(
    `${measurement.jobs} terminal jobs: full=${measurement.fullRows} rows/${measurement.fullMs}ms ` +
      `bounded=${measurement.boundedRows} rows/${measurement.boundedMs}ms ` +
      `indexBuild=${measurement.indexBuildMs}ms ` +
      `oldestActiveKept=${measurement.activeJobPresent} oldJobFetchable=${measurement.oldJobFetchable}`,
  );
  console.log(
    `  invariants: subsetOfFull=${measurement.boundedSubsetOfFull} ` +
      `everyOpenJobKept=${measurement.everyOpenJobKept} ` +
      `windowOnlyRowsAreNewest=${measurement.windowOnlyRowsAreNewest}`,
  );
  console.log(`  bounded plan: ${measurement.boundedPlan}`);
  console.log(`  full plan:    ${measurement.fullPlan}`);
}
