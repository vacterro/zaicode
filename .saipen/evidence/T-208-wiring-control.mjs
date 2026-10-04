import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const manifest = JSON.parse(readFileSync(join(root, '.saipen/evidence/T-208-wiring-before.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const testPath = join(product, 'packages/ui/test/zaicodeT208PresetWiring.test.ts');
const verifier = hash(readFileSync(testPath));
const backups = manifest.map(item => ({ ...item, live: readFileSync(join(product, item.path)), old: readFileSync(join(root, item.copy)) }));
if (backups.some(item => hash(item.old) !== item.sha256)) throw new Error('Before subject changed');
const backup = mkdtempSync(join(tmpdir(), 'zaicode-t208-wiring-'));
for (const item of backups) writeFileSync(join(backup, item.path.split('/').at(-1)), item.live);
const subject = () => hash(Buffer.concat(backups.map(item => Buffer.concat([Buffer.from(item.path), readFileSync(join(product, item.path))]))));
const run = name => {
  if (hash(readFileSync(testPath)) !== verifier) throw new Error('Verifier changed');
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/zaicodeT208PresetWiring.test.ts'], { cwd: join(product, 'packages/ui'), encoding: 'utf8' });
  writeFileSync(join(root, `.saipen/evidence/T-208-wiring-${name}.txt`), result.stdout + result.stderr);
  return { subject: subject(), exit: result.status, collected: /tests 2/.test(result.stdout) };
};
let red;
try {
  for (const item of backups) writeFileSync(join(product, item.path), item.old);
  red = run('red');
} finally {
  for (const item of backups) {
    if (hash(readFileSync(join(product, item.path))) !== hash(item.old)) throw new Error(`Concurrent edit: ${item.path}; backup ${backup}`);
    writeFileSync(join(product, item.path), item.live);
  }
}
const green = run('green');
const receipt = { verifier, backup, red, green, restored: backups.every(item => hash(readFileSync(join(product, item.path))) === hash(item.live)) };
writeFileSync(join(root, '.saipen/evidence/T-208-wiring-pair.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
process.exitCode = red?.exit === 1 && green.exit === 0 && red.collected && green.collected && receipt.restored ? 0 : 1;
