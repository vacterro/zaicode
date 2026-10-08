// T-220 Phase 1 acceptance: the exact normal launcher path, on an isolated scratch
// workspace. Proves staged promotion by build metadata (not the executable wrapper
// timestamp) and the visible source/package skew warning, plus a known-good control
// where a clean matching source must NOT warn and must NOT promote.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const launcherSource = path.join(root, 'tools/launcher/ZaicodeLauncher.cs');
const csc = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(__dirname, `launcher-acceptance-${runId}`);
fs.mkdirSync(out, { recursive: true });
const scratch = fs.mkdtempSync('V:/_TEMP_/t220-launcher-');
const stubSource = path.join(__dirname, 'launcher-stub-app.cs');
const stubApp = path.join(scratch, 'StubApp.exe');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = {};

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
}
function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function stamp(file, iso) {
  fs.utimesSync(file, new Date(iso), new Date(iso));
}
function meta(dir, identity) {
  write(
    path.join(dir, 'resources/build-meta.json'),
    JSON.stringify({
      appVersion: '3.14.0',
      sourceRevision: identity.revision,
      runtimePackageIdentity: identity.identity,
      buildTime: identity.at,
      workingTreeDirty: identity.dirty === true,
      updateChannel: 'test',
    }),
  );
}
function makeWorkspace(name) {
  const ws = path.join(scratch, name);
  const source = path.join(ws, 'zcode');
  const live = path.join(source, 'packages/desktop/dist/win-unpacked');
  const staged = path.join(source, 'packages/desktop/dist-next/win-unpacked');
  fs.mkdirSync(source, { recursive: true });
  execFileSync('git', ['-C', source, 'init', '--quiet'], { encoding: 'utf8' });
  write(path.join(source, 'package.json'), '{"name":"fixture"}');
  // dist churn is build output, exactly as the real repository treats it
  write(path.join(source, '.gitignore'), 'packages/desktop/dist/\npackages/desktop/dist-next/\n');
  write(path.join(source, 'packages/desktop/src/app.ts'), 'export const version = "3.14.0";\n');
  for (const dir of [live, staged]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(stubApp, path.join(dir, 'ZAICODE.exe'));
    write(path.join(dir, 'resources/app.asar'), 'fixture-asar');
  }
  git(source, 'add', '-A');
  git(source, '-c', 'user.name=Gate', '-c', 'user.email=gate@example.invalid', 'commit', '--quiet', '-m', 'fixture');
  const head = git(source, 'rev-parse', 'HEAD');
  assert.equal(git(source, 'status', '--porcelain'), '', 'the control fixture starts clean');
  return { ws, source, live, staged, head };
}

async function launchLauncher(ws, label, liveDir) {
  const appData = path.join(ws, 'AppData/Roaming');
  const localAppData = path.join(ws, 'AppData/Local');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const log = fs.openSync(path.join(out, `${label}-stdout.txt`), 'a');
  const proc = spawn(path.join(ws, 'ZAICODE.exe'), [], {
    cwd: ws,
    env: {
      ...process.env,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      USERPROFILE: ws,
      HOME: ws,
    },
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  fs.closeSync(log);
  const dialogs = [];
  const appWindows = [];
  const startedFile = path.join(liveDir, 'started.txt');
  const stopFlag = path.join(liveDir, 'stop.flag');
  const deadline = Date.now() + 120000;
  let exited = null;
  let started = null;
  proc.once('exit', code => { exited = code; });
  let dismissed = 0;
  while (Date.now() < deadline && exited === null) {
    const titles = ps(
      `Get-Process | Where-Object { $_.MainWindowTitle -and ($_.MainWindowTitle -like 'ZAICODE*' -or $_.MainWindowTitle -like 'T220 STUB*') } | ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)" }`,
    );
    for (const line of titles.split(/\r?\n/).filter(Boolean)) {
      const [pidText, title] = line.split('|');
      if (title.includes('source/runtime mismatch')) {
        dialogs.push({ pid: Number(pidText), title });
        ps(`Get-Process -Id ${Number(pidText)} | ForEach-Object { $null = $_.CloseMainWindow() }`);
        dismissed += 1;
      } else if (title.includes('T220 STUB')) {
        appWindows.push({ pid: Number(pidText), title });
      }
    }
    if (!started && fs.existsSync(startedFile)) {
      started = fs.readFileSync(startedFile, 'utf8');
      await wait(1500); // let the stand-in app own its window before the stop flag lands
      fs.writeFileSync(stopFlag, 'stop');
    }
    await wait(700);
  }
  if (exited === null) {
    execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    throw new Error(`${label}: launcher did not exit inside the acceptance window`);
  }
  const launcherLog = fs.readFileSync(path.join(appData, 'ZAICODE/launcher.log'), 'utf8');
  fs.writeFileSync(path.join(out, `${label}-launcher.log`), launcherLog);
  return { code: exited, dialogs, dismissed, launcherLog, appWindows, started };
}

function compileLauncher() {
  const binary = path.join(scratch, 'ZaicodeLauncher-gate.exe');
  execFileSync(csc, [
    '/nologo',
    '/target:winexe',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.Web.Extensions.dll',
    `/out:${binary}`,
    launcherSource,
  ], { encoding: 'utf8' });
  return binary;
}

async function main() {
  stage = 'compile';
  const binary = compileLauncher();
  checks.launcherBytes = fs.statSync(binary).size;
  execFileSync(csc, [
    '/nologo',
    '/target:winexe',
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    `/out:${stubApp}`,
    stubSource,
  ], { encoding: 'utf8' });

  // ---- run 1: the acceptance. Dirty source, older package, newer staged metadata ----
  stage = 'acceptance-run';
  const one = makeWorkspace('acceptance');
  fs.copyFileSync(binary, path.join(one.ws, 'ZAICODE.exe'));
  meta(one.live, { identity: 'live-package', revision: 'a'.repeat(40), at: '2026-10-04T10:00:00Z', dirty: false });
  meta(one.staged, { identity: 'staged-package', revision: 'b'.repeat(40), at: '2026-10-05T01:00:00Z', dirty: true });
  // an uncommitted local source edit: the real reason a user must be warned
  write(path.join(one.source, 'packages/desktop/src/app.ts'), 'export const version = "3.14.1-local";\n');
  const installer = path.join(one.source, 'packages/desktop/dist-next/ZAICODE-3.14.0-win-x64_TEST.exe');
  const blockmap = `${installer}.blockmap`;
  write(installer, 'fixture-installer');
  write(blockmap, 'fixture-blockmap');
  // the staged package wrapper is OLDER than the live one on disk: only metadata can promote it
  stamp(path.join(one.live, 'ZAICODE.exe'), '2027-01-01T00:00:00Z');
  stamp(path.join(one.live, 'resources/app.asar'), '2020-01-01T00:00:00Z');
  stamp(path.join(one.staged, 'ZAICODE.exe'), '2020-01-01T00:00:00Z');
  stamp(path.join(one.staged, 'resources/app.asar'), '2020-01-01T00:00:00Z');
  stamp(installer, '2026-10-05T02:00:00Z');
  stamp(blockmap, '2026-10-05T02:00:00Z');
  const acceptance = await launchLauncher(one.ws, 'acceptance', one.live);
  checks.acceptance = acceptance;
  assert.ok(acceptance.launcherLog.includes('Applied staged build from dist-next'), `metadata-newer staged build must be promoted:\n${acceptance.launcherLog}`);
  checks.promoted = fs.readFileSync(path.join(one.live, 'resources/build-meta.json'), 'utf8');
  assert.equal(JSON.parse(checks.promoted).runtimePackageIdentity, 'staged-package', 'the live package is now the metadata-newer staged build');
  assert.ok(!fs.existsSync(one.staged), 'the staged build directory was consumed by the promotion');
  assert.ok(fs.existsSync(`${one.live}.previous`), 'the replaced live build was kept aside');
  assert.ok(acceptance.launcherLog.includes('SOURCE_RUNTIME_SKEW'), `the launcher logged the skew:\n${acceptance.launcherLog}`);
  assert.equal(acceptance.dialogs.length, 1, `exactly one visible skew warning: ${JSON.stringify(acceptance.dialogs)}`);
  assert.equal(acceptance.dialogs[0].title, 'ZAICODE source/runtime mismatch');
  assert.ok(acceptance.launcherLog.includes('Local source: ' + one.head), 'the warning names the real local source revision');

  // ---- run 2: the known-good control. Clean source matching the package must be silent ----
  stage = 'control-run';
  const two = makeWorkspace('control');
  fs.copyFileSync(binary, path.join(two.ws, 'ZAICODE.exe'));
  meta(two.live, { identity: 'live-package', revision: two.head, at: '2026-10-05T01:00:00Z', dirty: false });
  meta(two.staged, { identity: 'staged-package', revision: 'c'.repeat(40), at: '2026-10-05T00:30:00Z', dirty: false });
  stamp(path.join(two.live, 'ZAICODE.exe'), '2020-01-01T00:00:00Z');
  stamp(path.join(two.live, 'resources/app.asar'), '2020-01-01T00:00:00Z');
  stamp(path.join(two.staged, 'ZAICODE.exe'), '2026-10-06T00:00:00Z');
  stamp(path.join(two.staged, 'resources/app.asar'), '2026-10-06T00:00:00Z');
  // the staged build is READY, so the control exercises the metadata comparison itself
  const controlInstaller = path.join(two.source, 'packages/desktop/dist-next/ZAICODE-3.14.0-win-x64_TEST.exe');
  const controlBlockmap = `${controlInstaller}.blockmap`;
  write(controlInstaller, 'fixture-installer');
  write(controlBlockmap, 'fixture-blockmap');
  stamp(controlInstaller, '2026-10-06T01:00:00Z');
  stamp(controlBlockmap, '2026-10-06T01:00:00Z');
  const control = await launchLauncher(two.ws, 'control', two.live);
  checks.control = control;
  assert.ok(!control.launcherLog.includes('SOURCE_RUNTIME_SKEW'), `a clean matching source must not report skew:\n${control.launcherLog}`);
  assert.equal(control.dialogs.length, 0, `no warning dialog for a clean matching source: ${JSON.stringify(control.dialogs)}`);
  assert.ok(control.launcherLog.includes('Staged build is not newer than live build'), `older staged metadata must not be promoted:\n${control.launcherLog}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(two.live, 'resources/build-meta.json'), 'utf8')).runtimePackageIdentity, 'live-package');

  stage = 'done';
  fs.writeFileSync(
    path.join(out, 'receipt.json'),
    JSON.stringify({ ok: true, stage, scratch, out, checks, paidVendorRequests: 0 }, null, 2),
  );
  console.log(
    'PASS normal launcher promotes by build metadata, warns on source/package skew, and stays silent on a clean match',
    JSON.stringify({
      promoted: JSON.parse(checks.promoted).runtimePackageIdentity,
      skewDialogs: acceptance.dialogs.length,
      controlDialogs: control.dialogs.length,
    }),
  );
}

let stage = 'setup';
main()
  .catch(error => {
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ stage, error: String(error.stack || error), checks }, null, 2));
    console.error(stage, error);
    process.exitCode = 1;
  });