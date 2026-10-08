import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../../zcode/", import.meta.url));
const evidence = fileURLToPath(new URL("./", import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = ["zaicodeHomeFeed.ts", "zaicodeWorkerStatsRecorder.ts"];
const command = "node --import tsx --test --test-reporter=spec packages/ui/test/zaicodeT253WorkerStatsRecorder.test.ts";
const verifier = hash(Buffer.concat([await readFile(join(repo, "packages/ui/test/zaicodeT253WorkerStatsRecorder.test.ts")), Buffer.from(command)]));
const snapshots = await Promise.all(files.map(async (name) => ({ name, target: join(repo, "packages/ui/src/zaicode/home", name), original: await readFile(join(evidence, "pre-fix", name)), repaired: await readFile(join(repo, "packages/ui/src/zaicode/home", name)) })));
const subject = (field) => hash(Buffer.concat(snapshots.flatMap((item) => [Buffer.from(item.name), item[field]])));
let output;
try {
  for (const item of snapshots) await writeFile(item.target, item.original);
  try {
    await run(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", "packages/ui/test/zaicodeT253WorkerStatsRecorder.test.ts"], { cwd: repo, maxBuffer: 1024 * 1024 });
    throw new Error("Original extracted algorithm did not discriminate");
  } catch (error) {
    assert.equal(error.code, 1);
    output = `${error.stdout}${error.stderr}`;
    assert.match(output, /AssertionError/);
    assert.match(output, /fail 8/);
    assert.match(output, /pass 4/);
  }
} finally {
  for (const item of snapshots) { await writeFile(item.target, item.repaired); assert.equal(hash(await readFile(item.target)), hash(item.repaired)); }
}
const result = { command, verifierSha256: verifier, preSubjectSha256: subject("original"), postSubjectSha256: subject("repaired"), failures: 8, knownGood: 4, restored: true, sources: snapshots.map((item) => ({ name: item.name, preSha256: hash(item.original), postSha256: hash(item.repaired) })) };
await writeFile(join(evidence, "red.log"), output);
await writeFile(join(evidence, "regression.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(JSON.stringify(result));
