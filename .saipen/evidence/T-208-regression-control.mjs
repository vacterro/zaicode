import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const ui = join(product, 'packages/ui');
const verifier = join(ui, 'test/zaicodeT208LivePresets.test.ts');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = [
  'packages/ui/src/zaicode/zaicodePresetApply.ts',
  'packages/ui/src/zaicode/zaicodePresetEnv.ts',
  'packages/ui/src/zaicode/zaicodePresetSections.ts',
  'packages/ui/src/zaicode/zaicodeTimerStore.ts',
];
const saved = paths.map(path => ({ path, bytes: readFileSync(join(product, path)) }));
const backup = mkdtempSync(join(tmpdir(), 'zaicode-t208-regression-'));
saved.forEach((file, index) => writeFileSync(join(backup, `${index}.before`), file.bytes));
const originals = paths.map(path => ({ path, bytes: execFileSync('git', ['show', `HEAD:${path}`], { cwd: product }) }));
// This is the captured incoming pre-fix refresh, whose startup loader reset live timers.
originals.at(-1).bytes = Buffer.concat([originals.at(-1).bytes, Buffer.from(
  '\n/** Live preset apply (T-208): take the stored timer prefs without reloading the window. */\n' +
  'export function reloadZaicodeTimerPrefs(): void {\n  useZaicodeTimers.setState(load());\n}\n',
)]);
const subject = files => digest(Buffer.concat(files.flatMap(file => [Buffer.from(file.path + '\0'), file.bytes])));
const verifierHash = digest(readFileSync(verifier));
const args = ['--import', 'tsx', '--test', 'test/zaicodeT208LivePresets.test.ts'];
const run = () => spawnSync(process.execPath, args, { cwd: ui, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
let red;
try {
  for (const file of originals) writeFileSync(join(product, file.path), file.bytes);
  red = run();
  writeFileSync(join(root, '.saipen/evidence/T-208-regression-red.txt'), `${red.stdout}\n${red.stderr}`);
} finally {
  // Never overwrite concurrent changes while restoring this explicitly bounded control.
  for (const file of originals) assert.equal(digest(readFileSync(join(product, file.path))), digest(file.bytes), `concurrent mutation: ${file.path}; original backup ${backup}`);
  for (const file of saved) writeFileSync(join(product, file.path), file.bytes);
}
assert.equal(digest(readFileSync(verifier)), verifierHash, 'the frozen verifier changed');
const green = run();
writeFileSync(join(root, '.saipen/evidence/T-208-regression-green.txt'), `${green.stdout}\n${green.stderr}`);
const receipt = {
  schema: 't208-regression/1', at: new Date().toISOString(), command: [process.execPath, ...args],
  verifier: verifierHash, backup, base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: product, encoding: 'utf8' }).trim(),
  red: { subject: subject(originals), exit: red.status, collected: /tests 4/.test(red.stdout), failures: /fail 4\b/.test(red.stdout) },
  green: { subject: subject(saved), exit: green.status, collected: /tests 4/.test(green.stdout), passes: /pass 4\b/.test(green.stdout) },
  restored: saved.every(file => digest(readFileSync(join(product, file.path))) === digest(file.bytes)),
};
writeFileSync(join(root, '.saipen/evidence/T-208-regression-pair.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
assert.equal(receipt.red.exit, 1);
assert.equal(receipt.red.collected && receipt.red.failures, true);
assert.equal(receipt.green.exit, 0);
assert.equal(receipt.green.collected && receipt.green.passes && receipt.restored, true);
