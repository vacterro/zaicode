import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = p => readFileSync(join(root, p));
const json = p => JSON.parse(read(p));
const evidence = join(root, ".saipen/evidence");

// T-214: the T-212 teardown deferral is gone. There is no pre-fix FAIL to pair against,
// because the race it worked around is no longer reachable through the packaged oracle once
// T-212's other fixes are in place -- so this asserts three same-verifier, same-bundle green
// runs instead of an inadmissible pair. If that ever stops holding, the receipts below fail.
const runs = ["green1", "green", "green2"].map(p => json(`.saipen/evidence/T-214-packaged-${p}.json`));
for (const run of runs) {
  assert.equal(run.pass, true, "packaged run");
  assert.equal(run.checks.length, 10, "all ten packaged checks ran");
  assert.deepEqual(run.errors, [], "renderer exceptions must be empty");
}
assert.equal(new Set(runs.map(r => r.verifier)).size, 1, "one verifier across all runs");
assert.equal(new Set(runs.map(r => r.asarSha256)).size, 1, "one subject bundle across all runs");
const verifier = runs[0].verifier;
assert.equal(verifier, "8eb7dcca361dd9497336e1554056607bd66c1c1ad28a6924c42ad0c147ffdc2f");

for (const kind of ["build", "bundle", "typecheck", "lint", "architecture", "tests"]) {
  const receipt = json(`.saipen/evidence/T-214-${kind}-final.json`);
  assert.equal(receipt.exit, 0, kind);
  assert.deepEqual(receipt.sourceChanges, [], `${kind} must not change the subject`);
}

// The \d below is doubled on purpose: inside a JS string literal a single \d collapses to a
// literal 'd', the regex then matches nothing and every total reads 0 -- which would make these
// assertions fail for the wrong reason instead of measuring the suite.
const text = read(".saipen/evidence/T-214-tests-final.txt").toString();
const total = name => [...text.matchAll(new RegExp("ℹ " + name + " (\\d+)", "g"))].reduce((s, m) => s + Number(m[1]), 0);
const totals = { tests: total("tests"), passed: total("pass"), failed: total("fail"), skipped: total("skipped") };
assert.equal(totals.failed, 0);
assert.equal(totals.tests, totals.passed + totals.skipped);
assert.ok(totals.passed >= 1487, JSON.stringify(totals));

// The deferral itself must be gone from the product source, not merely bypassed at runtime.
const source = read("zcode/packages/ui/src/terminal/TerminalSession.tsx").toString();
assert.doesNotMatch(source, /persistent term\.dispose failed[\s\S]{0,400}setTimeout/);
assert.doesNotMatch(source, /ponytail: 上游 xterm Viewport/);
assert.match(source, /term\.dispose\(\);/);

const report = {
  at: new Date().toISOString(),
  verifier,
  runs: runs.length,
  packagedChecks: runs[0].checks.length,
  rendererExceptions: runs.reduce((s, r) => s + r.errors.length, 0),
  asar: runs[0].asarSha256,
  totals,
};
writeFileSync(join(evidence, "T-214-verification.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));