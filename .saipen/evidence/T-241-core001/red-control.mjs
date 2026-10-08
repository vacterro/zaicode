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
const results = [];
for (const [name, file] of [
  ["agent", "packages/services/src/zaicode/zaicodeAgentRepo.ts"],
  ["job", "packages/services/src/zaicode/zaicodeJobRepo.ts"],
]) {
  const target = join(repo, file);
  const repaired = await readFile(target);
  const original = await run("git", ["show", `HEAD:${file}`], { cwd: repo, encoding: "buffer" });
  let output;
  try {
    await writeFile(target, original.stdout);
    try {
      await run(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", "test/zaicodeT241NestedPersistence.test.ts"], {
        cwd: join(repo, "packages/services"), maxBuffer: 1024 * 1024,
      });
      throw new Error(`${name} control did not discriminate`);
    } catch (error) {
      assert.equal(error.code, 1, "control must fail assertions, not fail to launch");
      output = `${error.stdout}${error.stderr}`;
      assert.match(output, /AssertionError/);
      const failures = Number(output.match(/fail (\d+)/)?.[1]);
      assert.ok(failures > 0);
      results.push({ name, file, failures, repairedSha256: hash(repaired), originalSha256: hash(original.stdout) });
    }
  } finally {
    await writeFile(target, repaired);
    assert.equal(hash(await readFile(target)), hash(repaired), "exact decoder bytes must be restored");
  }
  await writeFile(join(evidence, `red-${name}.log`), output);
}
await writeFile(join(evidence, "red-controls.json"), `${JSON.stringify({ controls: results, restored: true }, null, 2)}\n`);
for (const result of results) process.stdout.write(`${result.name}: ${result.failures} red assertions; exact SHA256 restored\n`);
