import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve(import.meta.dirname, '../..');
const product = join(root, 'zcode');
const evidence = join(root, '.saipen/evidence');
const subject = JSON.parse(readFileSync(join(evidence, 'T-208-subject-final.json'), 'utf8'));
const paths = Object.keys(subject.owned).sort();
const git = args => execFileSync('git', ['-c', 'core.safecrlf=false', ...args], { cwd: product, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const names = () => git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean).sort();
const stable = () => {
  for (const [path, expected] of Object.entries({ ...subject.owned, ...subject.foreign })) {
    assert.equal(createHash('sha256').update(readFileSync(join(product, path))).digest('hex'), expected, path);
  }
};
const mode = process.argv[2];
stable();
if (mode === 'plan') {
  assert.deepEqual(names(), [], 'Preserve a foreign pre-staged index');
  assert.equal(git(['rev-parse', 'HEAD']), subject.base);
  const plan = { base: subject.base, paths, preShipIndex: git(['write-tree']), origin: git(['remote', 'get-url', 'origin']), branch: git(['branch', '--show-current']) };
  writeFileSync(join(evidence, 'T-208-ship-plan.json'), JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({ mode, paths: paths.length, base: plan.base, preShipIndex: plan.preShipIndex }));
} else if (mode === 'stage') {
  assert.deepEqual(names(), []);
  git(['add', '--', ...paths]);
  assert.deepEqual(names(), paths);
  git(['diff', '--cached', '--check']);
  console.log(JSON.stringify({ mode, reviewedPaths: paths.length, exactScope: true }));
} else if (mode === 'commit') {
  assert.deepEqual(names(), paths);
  git(['diff', '--cached', '--check']);
  console.log(git(['commit', '-m', 'fix(ui): apply presets without restarting workers', '-m', 'Keep live timers and drafts attached across preset changes.\n\nRefs T-208, SRC-142']));
  console.log(JSON.stringify({ mode, commit: git(['rev-parse', 'HEAD']) }));
} else if (mode === 'push') {
  const plan = JSON.parse(readFileSync(join(evidence, 'T-208-ship-plan.json'), 'utf8'));
  const remote = git(['ls-remote', '--heads', '--tags', 'origin']);
  assert.ok(remote, 'First publication requires separate authority');
  const priorHead = remote.split('\n').find(line => line.endsWith(`refs/heads/${plan.branch}`))?.split(/\s+/)[0];
  assert.equal(priorHead, plan.base, 'Inspect incoming remote changes before pushing');
  const commit = git(['rev-parse', 'HEAD']);
  git(['push', 'origin', `HEAD:refs/heads/${plan.branch}`]);
  const landed = git(['ls-remote', 'origin', `refs/heads/${plan.branch}`]).split(/\s+/)[0];
  assert.equal(landed, commit);
  stable();
  const receipt = { at: new Date().toISOString(), repository: product, branch: plan.branch, origin: plan.origin, base: plan.base, commit, reviewedPaths: paths, foreignPreserved: Object.keys(subject.foreign).length, remoteMatches: true, workspaceVersionTag: 'none: publication is in the separate product branch' };
  writeFileSync(join(evidence, 'T-208-publish.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ mode, commit, reviewedPaths: paths.length, foreignPreserved: receipt.foreignPreserved, remoteMatches: true }));
} else throw new Error('Unknown publish mode');
