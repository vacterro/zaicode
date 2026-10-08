const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../zcode');
const relative = 'packages/desktop/src/main/zaicodeRouterSetup.ts';
const file = path.join(root, relative);
const test = path.join(root, 'packages/desktop/test/zaicodeRouterMaintainer.test.ts');
const fixed = fs.readFileSync(file);
const original = spawnSync('git', ['show', '5775a068:' + relative], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
if (original.status !== 0) throw new Error('Cannot read frozen original scanner');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const oracle = hash(fs.readFileSync(test));
const run = name => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/zaicodeRouterMaintainer.test.ts'], { cwd: path.join(root, 'packages/desktop'), encoding: 'utf8', timeout: 60000 });
  fs.writeFileSync(path.join(__dirname, 'T-262-' + name + '.log'), (r.stdout || '') + (r.stderr || ''));
  return r.status;
};
let red;
try {
  fs.writeFileSync(file, original.stdout);
  red = run('original-repeat');
} finally {
  fs.writeFileSync(file, fixed);
}
const green = run('fixed-repeat');
if (hash(fs.readFileSync(test)) !== oracle) throw new Error('Oracle changed during comparison');
const receipt = { oracle, originalSubject: hash(original.stdout), fixedSubject: hash(fixed), originalExit: red, fixedExit: green, scope: relative, unchangedDependencies: true };
fs.writeFileSync(path.join(__dirname, 'T-262-comparison.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
if (red === 0 || red === null || green !== 0) process.exitCode = 1;
