import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dirname, "../../../zcode");
const targets = ["packages/services/src/zaicode/zaicodeJobRepo.ts", "packages/services/src/session/tasksDatabase/migrations.ts"];
const schema = "packages/services/src/session/tasksDatabase/zaicode-home-query-v9.ts";
const verifier = "packages/services/test/zaicodeT254HomeOverview.test.ts";
const saved = targets.map((path) => readFileSync(resolve(root, path)));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const subject = () => hash(Buffer.concat([...targets, schema].flatMap((path) => [Buffer.from(path + "\0"), readFileSync(resolve(root, path))])));
const report = { ticket: "T-254", verifier: hash(readFileSync(resolve(root, verifier))), fixedSubject: subject(), controls: [] };
const run = (label) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", verifier], { cwd: root, encoding: "utf8", timeout: 60_000 });
  writeFileSync(resolve(import.meta.dirname, label + ".log"), result.stdout + result.stderr);
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  return { exit: result.status, pass: Number(output.match(/ℹ pass (\d+)/)?.[1]), fail: Number(output.match(/ℹ fail (\d+)/)?.[1]), subject: subject() };
};
try {
  for (let i = 0; i < targets.length; i++) writeFileSync(resolve(root, targets[i]), readFileSync(resolve(import.meta.dirname, "pre-fix", i === 0 ? "zaicodeJobRepo.ts" : "migrations.ts")));
  const red = run("controlled-red");
  assert.equal(red.exit, 1); assert.equal(red.fail, 7); assert.equal(red.pass, 3);
  report.controls.push({ label: "unfixed-full-read-and-v8-registry", ...red });
} finally {
  for (let i = 0; i < targets.length; i++) writeFileSync(resolve(root, targets[i]), saved[i]);
  for (let i = 0; i < targets.length; i++) assert.equal(hash(readFileSync(resolve(root, targets[i]))), hash(saved[i]), "exact source restoration");
}
const green = run("controlled-green");
assert.equal(green.exit, 0); assert.equal(green.fail, 0); assert.equal(green.pass, 10);
assert.equal(green.subject, report.fixedSubject);
report.controls.push({ label: "fixed", ...green });
report.restoration = targets.map((path, i) => ({ path, sha256: hash(saved[i]) }));
writeFileSync(resolve(import.meta.dirname, "regression.json"), JSON.stringify(report, null, 2) + "\n");
process.stdout.write(JSON.stringify(report));
