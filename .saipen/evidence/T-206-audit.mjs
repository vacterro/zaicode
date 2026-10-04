import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = p => readFileSync(join(root, p));
const json = p => JSON.parse(read(p));
const evidence = ".saipen/evidence";

// T-206 asks for two things: irrelevant settings sections moved to the bottom, and
// every one of them collapsible and collapsed by default. Both are asserted against a
// real packaged app -- a unit test can only say the code says so.
const red = json(`${evidence}/T-206-packaged-red.json`);
const greens = ["green1", "green2"].map(p => json(`${evidence}/T-206-packaged-${p}.json`));

assert.equal(red.pass, false, "the pre-fix bundle must fail this oracle");
assert.equal(red.verifier, greens[0].verifier, "one verifier across red and green");
assert.ok(red.asarSha256 !== greens[0].asarSha256, "red and green must be different bundles");

for (const run of greens) {
  assert.equal(run.pass, true, "packaged run");
  assert.equal(run.checks.length, 13, "all thirteen packaged checks ran");
  assert.deepEqual(run.errors, [], "renderer exceptions must be empty");
}
assert.equal(new Set(greens.map(r => r.verifier)).size, 1, "one verifier across green runs");
assert.equal(new Set(greens.map(r => r.asarSha256)).size, 1, "one subject bundle across green runs");

// The unit oracle is the same shape: red against the pre-fix tree, green after.
const redUnit = read(`${evidence}/T-206-unit-red.txt`).toString();
const greenUnit = read(`${evidence}/T-206-unit-green.txt`).toString();
const total = (text, name) =>
  [...text.matchAll(new RegExp("ℹ " + name + " (\\d+)", "g"))].reduce((s, m) => s + Number(m[1]), 0);
// The \d above is doubled on purpose: inside a JS string literal a single \d collapses to a
// literal 'd', the regex then matches nothing and every total reads 0 -- which would make
// these assertions pass for the wrong reason instead of measuring the suite.
assert.equal(total(redUnit, "pass"), 0, "the pre-fix tree fails the three T-206 tests");
assert.equal(total(redUnit, "fail"), 3);
assert.equal(total(greenUnit, "pass"), 3);
assert.equal(total(greenUnit, "fail"), 0);

for (const kind of ["build", "bundle", "typecheck", "lint", "architecture", "tests"]) {
  const receipt = json(`${evidence}/T-206-${kind}-verify.json`);
  assert.equal(receipt.exit, 0, kind);
  assert.deepEqual(receipt.sourceChanges, [], `${kind} must not change the subject`);
}

const tests = read(`${evidence}/T-206-tests-verify.txt`).toString();
const totals = {
  tests: total(tests, "tests"),
  passed: total(tests, "pass"),
  failed: total(tests, "fail"),
  skipped: total(tests, "skipped"),
};
assert.equal(totals.failed, 0);
assert.equal(totals.tests, totals.passed + totals.skipped);
assert.ok(totals.passed >= 1492, JSON.stringify(totals));

const exe = "zcode/packages/desktop/.release-work/t206-20261004/win-unpacked/ZAICODE.exe";
assert.ok(statSync(join(root, exe)).size > 0, "the test bundle exists on disk");

const report = {
  at: new Date().toISOString(),
  packagedRed: { checks: red.checks.length, error: String(red.error ?? "").split("\n")[0] },
  packagedGreen: { runs: greens.length, checks: greens[0].checks.length, rendererExceptions: greens.reduce((s, r) => s + r.errors.length, 0) },
  asar: greens[0].asarSha256,
  verifier: greens[0].verifier,
  bundle: exe,
  totals,
};
writeFileSync(join(root, `${evidence}/T-206-verification.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));