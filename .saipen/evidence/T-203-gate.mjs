import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, createWriteStream, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const kind = process.argv[2];
const pass = process.env.T203_GATE_PASS || 'verify';
if (!/^[a-z0-9-]+$/.test(pass)) throw new Error('Invalid gate pass');
const commands = {
  typecheck: ['typecheck'], lint: ['lint'], architecture: ['architecture:check', '--changed'],
  tests: ['test'], build: ['build:zaicode'], bundle: ['bundle:zaicode', '--', '--skip-build', '--skip-prepare'],
};
if (!commands[kind]) throw new Error('Unknown gate');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const changed = () => execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: product, encoding: 'utf8' })
  .split('\0').filter(Boolean).map(row => row.slice(3)).filter(path => !path.endsWith('/') && existsSync(join(product, path)) && statSync(join(product, path)).isFile());
const subject = () => Object.fromEntries(changed().sort().map(path => [path, hash(readFileSync(join(product, path)))]));
const before = subject();
const file = join(root, `.saipen/evidence/T-203-${kind}-${pass}.txt`);
const stream = createWriteStream(file);
const env = { ...process.env, ZCODE_DESKTOP_DIST_DIR: process.env.T203_DIST_DIR || 'dist-next' };
const child = spawn('pnpm.cmd', commands[kind], { cwd: product, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stream, { end: false });
child.stderr.pipe(stream, { end: false });
child.once('error', error => { stream.write(String(error)); });
child.once('close', code => {
  stream.end(() => {
    const after = subject();
    const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]);
    const receipt = { kind, at: new Date().toISOString(), command: ['pnpm', ...commands[kind]], exit: code, sourceChanges: changes, subject: before, log: file, logSha256: hash(readFileSync(file)) };
    writeFileSync(join(root, `.saipen/evidence/T-203-${kind}-${pass}.json`), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ kind, exit: code, sourceChanges: changes, log: file }));
    process.exitCode = code === 0 && changes.length === 0 ? 0 : 1;
  });
});
