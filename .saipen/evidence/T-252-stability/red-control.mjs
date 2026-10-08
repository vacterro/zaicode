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
const files = ["zaicodeAgentRepo.ts", "zaicodeJobRepo.ts", "zaicodeStatsRepo.ts", "zaicodeJobService.ts"];
const snapshots = await Promise.all(files.map(async (name) => {
  const file = `packages/services/src/zaicode/${name}`;
  const original = await run("git", ["show", `HEAD:${file}`], { cwd: repo, encoding: "buffer" });
  return { file, target: join(repo, file), original: original.stdout, repaired: await readFile(join(repo, file)) };
}));
const verifier = await readFile(join(repo, "packages/services/test/zaicodeT252Recovery.test.ts"));
const results = [];
for (const name of ["all", ...files]) {
  const subject = name === "all" ? snapshots : snapshots.filter((item) => item.file.endsWith(`/${name}`));
  let output;
  try {
    for (const item of subject) await writeFile(item.target, item.original);
    try {
      await run(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", "test/zaicodeT252Recovery.test.ts"], { cwd: join(repo, "packages/services"), maxBuffer: 1024 * 1024 });
      throw new Error(`${name} control did not discriminate`);
    } catch (error) {
      assert.equal(error.code, 1);
      output = `${error.stdout}${error.stderr}`;
      assert.match(output, /AssertionError/);
      const failures = Number(output.match(/fail (\d+)/)?.[1]);
      assert.ok(failures > 0);
      results.push({ name, failures });
    }
  } finally {
    for (const item of subject) { await writeFile(item.target, item.repaired); assert.equal(hash(await readFile(item.target)), hash(item.repaired)); }
    assert.equal(hash(await readFile(join(repo, "packages/services/test/zaicodeT252Recovery.test.ts"))), hash(verifier));
  }
  await writeFile(join(evidence, `red-${name}.log`), output);
}
await writeFile(join(evidence, "red-controls.json"), `${JSON.stringify({ verifierSha256: hash(verifier), controls: results, sources: snapshots.map(({ file, original, repaired }) => ({ file, originalSha256: hash(original), repairedSha256: hash(repaired) })), restored: true }, null, 2)}\n`);
for (const item of results) process.stdout.write(`${item.name}: ${item.failures} red assertions; exact bytes restored\n`);
