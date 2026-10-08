const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../zcode');
const files = [
  'packages/shared/src/zaicode-engines.ts',
  'packages/shared/src/zaicode-schedule-continuation.ts',
  'packages/ui/src/zaicode/zaicodeAutostartContinuation.ts',
  'packages/ui/src/zaicode/zaicodeScheduler.ts',
  'packages/ui/src/zaicode/ZaicodeSchedulerPanel.tsx',
  'packages/ui/src/zaicode/ZaicodeScheduleContinuation.tsx',
];
const tests = ['packages/ui/test/zaicodeSchedulerIdentity.test.ts', 'packages/ui/test/zaicodeContinuationEffects.test.ts'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = values => hash(Buffer.concat(values.flatMap(([name, bytes]) => [Buffer.from(name + '\0'), bytes, Buffer.from('\0')])));
const read = name => fs.readFileSync(path.join(root, name));
const oracle = digest(tests.map(name => [name, read(name)]));
const fixed = files.map(name => [name, read(name)]);
const original = files.map(name => {
  const result = spawnSync('git', ['show', 'e5389320:' + name], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot read original ' + name);
  return [name, result.stdout];
});
const write = values => values.forEach(([name, bytes]) => fs.writeFileSync(path.join(root, name), bytes));
const build = () => {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-b', 'packages/shared'], { cwd: root, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) throw new Error('Shared build failed: ' + result.stdout + result.stderr);
};
const run = name => {
  build();
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/zaicodeSchedulerIdentity.test.ts', 'test/zaicodeContinuationEffects.test.ts'], { cwd: path.join(root, 'packages/ui'), encoding: 'utf8', timeout: 60000 });
  fs.writeFileSync(path.join(__dirname, 'T-267-' + name + '.log'), (result.stdout || '') + (result.stderr || ''));
  return result.status;
};
if (process.argv.includes('--freeze')) {
  const receipt = { oracle, originalSubject: digest(original), scope: files, baseline: 'e5389320' };
  fs.writeFileSync(path.join(__dirname, 'T-267-oracle.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} else {
  const frozen = JSON.parse(fs.readFileSync(path.join(__dirname, 'T-267-oracle.json'), 'utf8'));
  if (oracle !== frozen.oracle) throw new Error('Frozen oracle changed');
  let red;
  try { write(original); red = run('original-repeat'); } finally { write(fixed); build(); }
  const green = run('fixed-repeat');
  if (digest(tests.map(name => [name, read(name)])) !== oracle) throw new Error('Oracle changed during comparison');
  const receipt = { ...frozen, fixedSubject: digest(fixed), originalExit: red, fixedExit: green, scope: files, unchangedDependencies: true };
  fs.writeFileSync(path.join(__dirname, 'T-267-comparison.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
  if (red === 0 || red === null || green !== 0) process.exitCode = 1;
}
