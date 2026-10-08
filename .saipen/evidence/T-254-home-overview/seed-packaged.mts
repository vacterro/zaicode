import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ZaicodeJobRepo } from "../../../zcode/packages/services/src/zaicode/zaicodeJobRepo.js";
const path = resolve(process.argv[2]);
const repo = new ZaicodeJobRepo(path);
await repo.ensureReady();
const db = new DatabaseSync(path);
try {
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO zaicode_jobs
    (job_id, workspace_key, workspace_path, agent_id, title, instructions, status, priority,
     sort_order, created_at, updated_at, attempt, finished_at, run_id, host_id, heartbeat_at)
    VALUES (?, 'probe', 'C:/t254-probe', 'probe-agent', ?, 'Fixture only', ?, 0, 0, ?, ?, 0, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  for (let i = 0; i < 500_000; i++) insert.run(`history-${i}`, "Old completed job", "completed", 1_000 + i, 1_000 + i, now - 2 * 86_400_000, null, null, null);
  for (const status of ["draft", "queued", "ready", "running", "waiting", "blocked"])
    insert.run(`old-${status}`, `Fixture ${status}`, status, 1, 1, null, status === "running" ? "fixture-run" : null, "fixture-host", now + 600_000);
  for (let i = 0; i < 15; i++) insert.run(`today-${i}`, "Old created, finished today", i < 12 ? "completed" : "failed", 2, 2, now, null, null, null);
  db.exec("COMMIT");
  repo.setSetting("auto_run", "0", now);
  process.stdout.write(JSON.stringify({ rows: 500_021, path }));
} finally { db.close(); repo.close(); }
