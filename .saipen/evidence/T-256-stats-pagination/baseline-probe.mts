import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ZaicodeStatsRepo } from "../../../zcode/packages/services/src/zaicode/zaicodeStatsRepo.js";
import { ZaicodeStatsService } from "../../../zcode/packages/services/src/zaicode/zaicodeStatsService.js";
const dir = await mkdtemp(join(tmpdir(), "zaicode-t256-baseline-"));
const path = join(dir, "tasks-index.sqlite");
const repo = new ZaicodeStatsRepo(path);
const service = new ZaicodeStatsService({ repo, agentDbPath: () => join(dir, "absent.sqlite"), now: () => 30_000 });
await repo.ensureReady();
const db = new DatabaseSync(path);
const report = [];
try {
  const insert = db.prepare(`INSERT INTO zaicode_jobs
    (job_id, workspace_key, workspace_path, agent_id, title, instructions, status, priority,
     sort_order, created_at, updated_at, attempt, finished_at)
    VALUES (?, 'probe', 'C:/probe', 'agent', 'Fixture', 'Work', 'completed', 0, 0, 1, 1, 0, ?)`);
  db.exec("BEGIN");
  for (let i = 0; i < 10_001; i++) insert.run(`equal-${i}`, 10_000);
  insert.run("newest", 20_000);
  db.exec("COMMIT");
  for (let pass = 1; pass <= 4; pass++) {
    await service.ingest(true);
    report.push({ pass, events: repo.meta().eventCount, cursor: repo.getCursor("queue"), newestStored: Boolean(db.prepare("SELECT id FROM zaicode_stats_events WHERE job_id='newest'").get()) });
  }
} finally { db.close(); service.dispose(); await rm(dir, { recursive: true, force: true }); }
await writeFile(join(import.meta.dirname, "baseline-probe.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report));
