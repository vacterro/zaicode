import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = p => readFileSync(join(root, p));
const json = p => JSON.parse(read(p));
const git = (repo, args) => execFileSync("git", args, { cwd: join(root, repo), encoding: "utf8" }).trim();
// Porcelain v1 is "XY <path>": an unstaged modification starts with a space, so trimming the
// whole output eats row one's status column and shifts its path by one character.
const gitRows = (repo) => execFileSync("git", ["status", "--porcelain"], { cwd: join(root, repo), encoding: "utf8" })
  .split("\n").filter(row => row.trim());

// T-213 asks for two things: the current state brought to a checkpoint, and a
// bundle built from it that actually works. Both are asserted against live git
// and live artefacts -- a clean tree is the checkpoint, a launching app is the
// bundle. Neither is accepted on the bundler's exit code alone.
const zcodeHead = git("zcode", ["rev-parse", "HEAD"]);
const wsHead = git(".", ["rev-parse", "HEAD"]);
// The product tree must be exactly the committed checkpoint. The workspace is
// allowed to be dirty only by evidence this ticket produced after its commit --
// anything else would mean the checkpoint captured a moving tree.
assert.deepEqual(gitRows("zcode"), [], "zcode must be clean at the checkpoint");
const outsideMemory = gitRows(".")
  .map(row => row.slice(3).replace(/^"|"$/g, ""))
  .filter(path => !path.startsWith(".saipen/"));
assert.deepEqual(outsideMemory, [], "nothing outside .saipen/ may sit outside the checkpoint");

// The bundler writes here; if this directory is not ignored, the next `git add -A`
// publishes 6.7 GB of build output.
// check-ignore -q says yes by exiting 0 and writing nothing; its stdout carries no verdict.
const ignored = spawnSync("git", ["check-ignore", "-q", "packages/desktop/.release-work/x"], { cwd: join(root, "zcode") });
assert.equal(ignored.status, 0, "release-work must be ignored by zcode/.gitignore");

const runs = ["green1", "green2", "green3"].map(p => json(`.saipen/evidence/T-213-packaged-${p}.json`));
for (const run of runs) {
  assert.equal(run.pass, true, "packaged run");
  assert.equal(run.checks.length, 10, "all ten packaged checks ran");
  assert.deepEqual(run.errors, [], "renderer exceptions must be empty");
}
assert.equal(new Set(runs.map(r => r.verifier)).size, 1, "one verifier across runs");
assert.equal(new Set(runs.map(r => r.asarSha256)).size, 1, "one subject bundle across runs");

const exe = "zcode/packages/desktop/.release-work/t213-20261004/win-unpacked/ZAICODE.exe";
assert.ok(statSync(join(root, exe)).size > 0, "the test bundle exists on disk");

for (const kind of ["build", "bundle", "typecheck", "lint", "architecture", "tests"]) {
  const receipt = json(`.saipen/evidence/T-213-${kind}-final.json`);
  assert.equal(receipt.exit, 0, kind);
  assert.deepEqual(receipt.sourceChanges, [], `${kind} must not change the subject`);
}

// The \d below is doubled on purpose: inside a JS string literal a single \d collapses to a
// literal 'd', the regex then matches nothing and every total reads 0 -- which would make these
// assertions fail for the wrong reason instead of measuring the suite.
const text = read(".saipen/evidence/T-213-tests-final.txt").toString();
const total = name => [...text.matchAll(new RegExp("ℹ " + name + " (\\d+)", "g"))].reduce((s, m) => s + Number(m[1]), 0);
const totals = { tests: total("tests"), passed: total("pass"), failed: total("fail"), skipped: total("skipped") };
assert.equal(totals.failed, 0);
assert.equal(totals.tests, totals.passed + totals.skipped);
assert.ok(totals.passed >= 1489, JSON.stringify(totals));

const report = {
  at: new Date().toISOString(),
  zcodeHead,
  wsHead,
  testBundle: exe,
  runs: runs.length,
  packagedChecks: runs[0].checks.length,
  rendererExceptions: runs.reduce((s, r) => s + r.errors.length, 0),
  asar: runs[0].asarSha256,
  totals,
};
writeFileSync(join(root, ".saipen/evidence/T-213-verification.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));