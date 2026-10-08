import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZaicodeStatsRepo } from "../../../zcode/packages/services/src/zaicode/zaicodeStatsRepo.ts";
import { ZaicodeStatsService } from "../../../zcode/packages/services/src/zaicode/zaicodeStatsService.ts";
import { ZaicodeWorkerStatsRecorder } from "../../../zcode/packages/ui/src/zaicode/home/zaicodeWorkerStatsRecorder.ts";
import { ZaicodeWorkerStatsRecorder as UnfixedRecorder } from "./pre-fix/zaicodeWorkerStatsRecorder.ts";

const dir = await mkdtemp(join(tmpdir(), "zaicode-t253-durable-"));
const worker = (id, patch = {}) => ({ id, kind: "worker", short: "A1", projectPath: "C:/test/project", startedAt: 100, endedAt: 500, exitCode: 0, ...patch });
const repositories = [];
const service = (name) => {
  const repo = new ZaicodeStatsRepo(join(dir, `${name}.sqlite`));
  repositories.push(repo);
  return { repo, service: new ZaicodeStatsService({ repo, now: () => 1_000_000 }) };
};
try {
  const main = service("burst");
  const recorder = new ZaicodeWorkerStatsRecorder();
  const sizes = [];
  const write = async (sessions) => { sizes.push(sessions.length); return main.service.recordWorkerSessions(sessions); };
  const burst = Array.from({ length: 450 }, (_, index) => worker(`burst-${index}`));
  recorder.observe(burst, 500);
  await recorder.flush(write);
  assert.deepEqual(sizes, [200, 200, 50]);
  assert.equal(main.repo.all().length, 450);
  recorder.observe([], 900);
  await recorder.flush(write);
  assert.equal(recorder.retainedWorkerCount, 0);
  const beforeReplay = JSON.stringify(main.repo.all());
  recorder.observe(burst, 500);
  await recorder.flush(write);
  assert.equal(main.repo.all().length, 450);
  assert.equal(JSON.stringify(main.repo.all()), beforeReplay);

  const runNormal = async (Recorder, name) => {
    const current = service(name);
    const instance = new Recorder();
    const finished = Array.from({ length: 10 }, (_, index) => worker(`normal-${index}`));
    const running = Array.from({ length: 2 }, (_, index) => worker(`running-${index}`, { endedAt: null, exitCode: null }));
    const deliver = (sessions) => current.service.recordWorkerSessions(sessions);
    instance.observe([...finished, ...running], 500);
    await instance.flush(deliver);
    instance.observe([], 900);
    await instance.flush(deliver);
    return JSON.stringify(current.repo.all());
  };
  const oldRows = await runNormal(UnfixedRecorder, "unfixed");
  const newRows = await runNormal(ZaicodeWorkerStatsRecorder, "repaired");
  assert.equal(newRows, oldRows, "normal SAIHOME statistics must remain byte-equivalent");
  const result = { ok: true, backend: "real ZaicodeStatsService and SQLite", firstBatchSizes: sizes.slice(0, 3), durableBurstRows: 450, replayRows: 450, replayBytesUnchanged: true, normalRows: 12, normalBytesEquivalent: true, normalSha256: createHash("sha256").update(newRows).digest("hex"), acknowledgedHistoryAfterDisappearance: 0 };
  await writeFile(fileURLToPath(new URL("durable-replay.json", import.meta.url)), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(JSON.stringify(result));
} finally {
  for (const repo of repositories) repo.close();
  await rm(dir, { recursive: true, force: true });
}
