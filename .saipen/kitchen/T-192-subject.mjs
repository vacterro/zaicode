import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const output = join(root, '.saipen/evidence/T-192-subject.json');
const own = [
  'packages/desktop/tsup.config.ts',
  'packages/desktop/scripts/verify-zaicode-boot.cjs',
  'packages/services/src/terminal/terminal.ts',
  'packages/services/src/terminal/terminalService.ts',
  'packages/services/src/terminal/workerTerminalBroker.ts',
  'packages/services/src/terminal/workerTerminalProcess.ts',
  'packages/services/src/terminal/workerTerminalProtocol.ts',
  'packages/services/src/terminal/workerTerminalConsole.ts',
  'packages/services/test/workerTerminalHandoff.test.ts',
  'packages/ui/src/terminal/TerminalSession.tsx',
  'packages/ui/src/terminal/terminalOutputTap.ts',
  'packages/ui/src/zaicode/ZaicodeWorkerParts.tsx',
  'packages/ui/src/zaicode/zaicodeWorkerExtraction.ts',
  'packages/ui/test/zaicodeWorkerExtraction.test.ts',
  'specs/zaicode-worker-powershell-handoff.md',
];
const digest = value => createHash('sha256').update(value).digest('hex');
const file = async path => ({ path, sha256: digest(await readFile(join(product, path))) });
if (process.argv[2] === 'check') {
  const frozen = JSON.parse(await readFile(output, 'utf8'));
  const changes = [];
  for (const entry of [...frozen.own, ...frozen.foreign]) {
    if ((await file(entry.path)).sha256 !== entry.sha256) changes.push(entry.path);
  }
  if (changes.length) throw new Error(`Frozen subject changed: ${changes.join(', ')}`);
  console.log(JSON.stringify({ pass: true, own: frozen.own.length, foreign: frozen.foreign.length, fingerprint: frozen.fingerprint }));
} else {
  const prior = JSON.parse(await readFile(join(root, '.saipen/evidence/T-188-subject-final.json'), 'utf8'));
  for (const entry of prior.files) {
    if ((await file(entry.path)).sha256 !== entry.sha256) throw new Error(`T-188 subject changed: ${entry.path}`);
  }
  const paths = execFileSync('git', ['-C', product, 'ls-files', '-m', '-o', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const ownFiles = await Promise.all(own.map(file));
  const foreign = await Promise.all(paths.filter(path => !own.includes(path)).map(file));
  const manifest = { schema: 't192-subject/1', at: new Date().toISOString(), head: execFileSync('git', ['-C', product, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), own: ownFiles, foreign, fingerprint: digest(JSON.stringify(ownFiles)), t188: prior.files.length };
  await writeFile(output, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ own: ownFiles.length, foreign: foreign.length, t188: prior.files.length, fingerprint: manifest.fingerprint }));
}
