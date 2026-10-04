import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const evidence = join(root, '.saipen/evidence');
const read = path => readFileSync(join(root, path));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(read(path).toString('utf8'));
const before = json('.saipen/evidence/T-210-ui/before.json');
for (const [path, expected] of Object.entries(before.instruments)) assert.equal(hash(read(path)), expected, path);
for (const [path, expected] of Object.entries(before.foreign)) assert.equal(hash(read(`zcode/${path}`)), expected, path);
const old = json('.saipen/evidence/T-191-ui/manifest.json');
for (const entry of old.instrument) assert.equal(hash(read(`.saipen/evidence/T-191-ui/${entry.path}`)), entry.sha256);
const paths = [...Object.keys(before.subject), 'packages/ui/test/zaicodeT210KnownDuration.test.ts', 'specs/zaicode-t210-known-work-duration.md'].sort();
const owned = Object.fromEntries(paths.map(path => [path, hash(read(`zcode/${path}`))]));
const redSources = Object.fromEntries(Object.keys(before.subject).sort().map(path => [path, hash(execFileSync('git', ['show', `${before.base}:${path}`], { cwd: product }))]));
const instruments = Object.fromEntries(Object.entries(before.instruments).sort());
const regression = { verifier: hash(JSON.stringify(instruments)), redSubject: hash(JSON.stringify(redSources)), greenSubject: hash(JSON.stringify(Object.fromEntries(Object.keys(before.subject).sort().map(path => [path, owned[path]])))) };
if (process.argv[2] === 'freeze') {
  writeFileSync(join(evidence, 'T-210-subject-final.json'), JSON.stringify({ base: before.base, owned, foreign: before.foreign, regression, instruments }, null, 2));
  console.log(JSON.stringify({ owned: paths.length, foreign: Object.keys(before.foreign).length, ...regression }));
} else {
  assert.deepEqual(owned, json('.saipen/evidence/T-210-subject-final.json').owned);
  const red = json('.saipen/evidence/T-210-ui/red/report.json');
  const green = json('.saipen/evidence/T-210-ui/green/report.json');
  assert.equal(red.pass, false); assert.equal(red.checks.length, 32); assert.equal(red.checks.filter(c=>!c.pass).length, 16);
  assert.equal(green.pass, true); assert.equal(green.checks.length, 32);
  assert.equal(red.verifierSha256, green.verifierSha256);
  assert.equal(green.verifierSha256, instruments['.saipen/evidence/T-210-ui/verifier.cjs']);
  const legacy = json('.saipen/evidence/T-210-ui/t191-final/report.json');
  assert.equal(legacy.pass, true); assert.equal(legacy.checks.length, 31);
  const total = name => [...read('.saipen/evidence/T-210-tests-final.txt').toString().matchAll(new RegExp(`ℹ ${name} (\\d+)`, 'g'))].reduce((sum, match)=>sum+Number(match[1]), 0);
  const totals = { tests: total('tests'), passed: total('pass'), failed: total('fail'), skipped: total('skipped') };
  assert.equal(totals.failed, 0); assert.equal(totals.tests, totals.passed + totals.skipped); assert.ok(totals.passed >= 1483);
  for (const kind of ['typecheck','lint','architecture','tests']) {
    const receipt = json(`.saipen/evidence/T-210-${kind}-final.json`);
    assert.equal(receipt.exit, 0); assert.deepEqual(receipt.sourceChanges, []);
  }
  const receipt = { at: new Date().toISOString(), ...regression, totals, browser: 32, inheritedT191: 31, owned: paths, foreignPreserved: Object.keys(before.foreign).length };
  writeFileSync(join(evidence, 'T-210-verification.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
