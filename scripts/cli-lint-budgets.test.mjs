import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(join(root, 'apps/zcode-cli/package.json'));
const bin = join(dirname(require.resolve('oxlint/package.json')), 'bin/oxlint');
const budgets = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/cli-lint-legacy-lengths.json'), 'utf8'));
const typescript = createRequire(join(root, 'package.json'))('typescript');

function readPolicy(file) {
  const parsed = typescript.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'));
  assert.equal(parsed.error, undefined, 'configuration must parse before the instrument can run');
  let policy = {};
  for (const parent of parsed.config.extends ?? []) policy = { ...policy, ...readPolicy(resolve(dirname(file), parent)) };
  const { extends: _parents, ...child } = parsed.config;
  return { ...policy, ...child, rules: { ...policy.rules, ...child.rules }, overrides: [...(policy.overrides ?? []), ...(child.overrides ?? [])] };
}

function inspect(path, count, module = 'apps/zcode-cli') {
  const scratch = mkdtempSync(join(tmpdir(), 'zaicode-cli-lint-'));
  try {
    const subject = join(scratch, path);
    const controlConfig = join(scratch, 'control.json');
    const candidate = join(root, module, '.oxlintrc.json');
    const config = process.env.ZAICODE_LINT_SUBJECT || (existsSync(candidate) ? candidate : join(root, '.oxlintrc.json'));
    const policy = readPolicy(config);
    mkdirSync(dirname(subject), { recursive: true });
    // Only fixture discovery changes: production rule severities, options and overrides stay exact.
    writeFileSync(controlConfig, JSON.stringify({ ...policy, ignorePatterns: [] }));
    writeFileSync(subject, Array.from({ length: count }, (_, i) => `export const line${i} = ${i};`).join('\n'));
    const result = spawnSync(process.execPath, [bin, '--config', controlConfig, '--no-ignore', '--format', 'json', subject], { cwd: scratch, encoding: 'utf8' });
    assert.match(result.stdout, /^\s*\{/, `verifier unavailable: ${result.stderr || result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.number_of_files, 1, 'zero collected files is an unavailable verifier');
    const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    return { status: result.status, errors };
  } finally {
    // Windows cleanup stays in the verified task-specific directory created above.
    if (dirname(scratch) === resolve(tmpdir()) && basename(scratch).startsWith('zaicode-cli-lint-')) rmSync(scratch, { recursive: true });
  }
}

test('a new 400-line module passes and a 401-line module fails the actual CLI linter', () => {
  assert.equal(inspect('new-module.ts', 400).status, 0);
  const bad = inspect('new-module.ts', 401);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.errors[0]?.code, 'eslint(max-lines)');
});

for (const budget of budgets) {
  test(`the frozen inherited ceiling passes but growth fails: ${budget.path}`, () => {
    const module = budget.path.split('/').slice(0, 4).join('/');
    const path = budget.path.slice(module.length + 1);
    const good = inspect(path, budget.max, module);
    assert.equal(good.status, 0, JSON.stringify(good.errors));
    const bad = inspect(path, budget.max + 1, module);
    assert.notEqual(bad.status, 0);
    assert.equal(bad.errors[0]?.code, 'eslint(max-lines)');
  });
}
