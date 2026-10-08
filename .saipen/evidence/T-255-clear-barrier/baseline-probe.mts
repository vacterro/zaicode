import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ZaicodeStatsRepo, type ZaicodeStatsEventRow } from "../../../zcode/packages/services/src/zaicode/zaicodeStatsRepo.js";
const row: ZaicodeStatsEventRow = {
  id: "old", source: "workers", kind: "worker.session", at: 100, startedAt: 50, durationMs: 50,
  project: null, sessionId: null, jobId: null, agent: null, engine: "fixture", provider: null, model: null,
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
  totalTokens: null, result: "completed", failure: null, retryOf: null,
};
const report = [];
for (const scenario of ["stale-batch", "floor-write-failure", "post-commit-writer"]) {
  const dir = await mkdtemp(join(tmpdir(), "zaicode-t255-baseline-"));
  const path = join(dir, "tasks-index.sqlite");
  const repo = new ZaicodeStatsRepo(path), writer = new ZaicodeStatsRepo(path);
  await repo.ensureReady(); await writer.ensureReady();
  try {
    repo.insertEvents([row], 100); repo.setCursor("queue", 100, 100);
    if (scenario === "stale-batch") {
      repo.clear(200);
      const inserted = repo.insertEvents([row], 201);
      report.push({ scenario, inserted, floor: repo.getCursor("cleared"), rows: repo.meta().eventCount, bugConfirmed: inserted === 1 });
    } else if (scenario === "floor-write-failure") {
      const setCursor = repo.setCursor;
      repo.setCursor = function (source, ...args) { if (source === "cleared") throw new Error("fixture floor failure"); return setCursor.call(this, source, ...args); };
      let error;
      try { repo.clear(200); } catch (caught) { error = String(caught); }
      finally { repo.setCursor = setCursor; }
      report.push({ scenario, error, rows: repo.meta().eventCount, cursor: repo.getCursor("queue"), bugConfirmed: repo.meta().eventCount === 0 });
    } else {
      const exec = DatabaseSync.prototype.exec;
      let armed = true, writerFloor = -1, inserted = -1;
      DatabaseSync.prototype.exec = function (sql) {
        const result = exec.call(this, sql);
        if (armed && sql === "COMMIT") {
          armed = false; writerFloor = writer.getCursor("cleared"); inserted = writer.insertEvents([row], 201);
        }
        return result;
      };
      try { repo.clear(200); } finally { DatabaseSync.prototype.exec = exec; }
      report.push({ scenario, writerFloor, inserted, rows: repo.meta().eventCount, floor: repo.getCursor("cleared"), bugConfirmed: writerFloor === 0 && inserted === 1 });
    }
  } finally { repo.close(); writer.close(); await rm(dir, { recursive: true, force: true }); }
}
await writeFile(join(import.meta.dirname, "baseline-probe.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report));
