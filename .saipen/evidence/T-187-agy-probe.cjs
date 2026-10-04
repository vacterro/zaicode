const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const requireProduct = createRequire(path.join(root, 'zcode/packages/services/package.json'));
const shared = requireProduct('@zcode/shared');
const cli = path.join(process.env.LOCALAPPDATA, 'agy/bin/agy.exe');
async function probe(extra) {
  const startedAt = Date.now();
  const args = ['-p', '/usage', '--output-format', 'json', ...extra];
  const env = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', BROWSER: 'C:/Windows/System32/where.exe' };
  delete env.SSH_CONNECTION;
  delete env.SSH_TTY;
  delete env.AGY_CLI_INTERACTIVE_HEADLESS;
  const child = spawn(cli, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { if (stdout.length < 1024 * 1024) stdout += data; });
  child.stderr.on('data', data => { if (stderr.length < 1024 * 1024) stderr += data; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  let payload;
  try { payload = JSON.parse(stdout); } catch { payload = null; }
  const readAt = Date.now();
  const windows = shared.parseAntigravityUsage(payload);
  return {
    args, startedAt, readAt, exitCode, timedOut,
    json: Boolean(payload), stderrPresent: Boolean(stderr),
    deniedActionCount: Array.isArray(payload?.denied_actions) ? payload.denied_actions.length : null,
    commandPresent: Boolean(payload?.command),
    windows: windows.map(w => ({ key: w.key, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt, durationMinutes: w.durationMinutes })),
    rollingWindows: shared.markZaicodeWindowsStartingOnUse(windows, readAt).filter(w => typeof w.rollingFrom === 'number').map(w => ({ key: w.key, rollingFrom: w.rollingFrom, resetsAt: w.resetsAt }))
  };
}
(async () => {
  const probes = [await probe([]), await probe(['--dangerously-skip-permissions'])];
  const receipt = { kind: 'live-read-only-antigravity-probe', cliVersion: '1.2.14', capturedAt: new Date().toISOString(), probes };
  fs.writeFileSync(path.join(__dirname, 'T-187-agy-probe.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
})().catch(error => { console.error(error.code || error.name); process.exitCode = 1; });
