const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const executablePath = process.env.T166_EXE || path.join(root, 'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe');
const out = process.env.T166_OUT || path.join(root, '.saipen/evidence/T-166-live/before');
const profile = fs.mkdtempSync(path.join(process.env.TEMP, 'zaicode-t166-'));
const cliDir = path.join(process.env.LOCALAPPDATA, 'agy/bin');
const checks = {};
const observations = [];
const errors = [];
const config = { intervalMinutes: 0, readZcodeConfig: false, readFreebuff: false, hiddenAccounts: ['claude:default', 'codex:default', 'zcode:plan', 'freebuff:default'], workerPrompt: '', workerYolo: false, keepWindowsRolling: true };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(profile, 'zaicode-engines.json'), JSON.stringify(config));
let app, child;
const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), PATH: cliDir + path.delimiter + process.env.PATH, ZCODE_DESKTOP_APPLICATION_NAME: 'ZAICODE T166 ' + path.basename(profile), ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DESKTOP_USER_DATA_DIR: profile, ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, 'session'), ZCODE_DATA_BASE_DIR: profile, ZCODE_HOME: path.join(profile, '.zcode'), ZCODE_ZAICODE_MODE: '1', ZAICODE_CUSTOMIZATION_DIR: path.join(profile, 'customization'), ZAICODE_UPDATES: 'off', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
delete env.TZ;
delete env.SAIMAIL_WORKSPACE;
delete env.ZAICODE_INSTALL_ROOT;
for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
async function launch() {
  app = await _electron.launch({ executablePath, args: ['--user-data-dir=' + profile], env, timeout: 90000 });
  child = app.process();
  let page;
  for (let round = 0; round < 120 && !page; round++) {
    page = app.windows().find(p => !p.isClosed() && p.url().includes('/out/renderer/index.html'));
    if (!page) await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(page, 'main renderer exists');
  page.on('pageerror', error => errors.push(error.name));
  await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 120000 });
  await page.setViewportSize({ width: 1300, height: 850 });
  await page.evaluate(async () => {
    window.__t166LiveState = await window.zcode.getZaicodeEngines();
    window.zcode.onZaicodeEnginesChanged(state => { window.__t166LiveState = state; });
  });
  await page.waitForFunction(() => window.__t166LiveState.accounts.some(a => a.id === 'antigravity:default' && a.status === 'ready'), null, { timeout: 30000 });
  return page;
}
async function stop() {
  if (app) await app.close().catch(() => undefined);
  if (child?.pid) { try { execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  app = child = null;
}
async function observe(page, label, refresh = true) {
  if (refresh) await page.evaluate(() => window.zcode.refreshZaicodeEngines('antigravity:default'));
  const data = await page.evaluate(async () => {
    const state = await window.zcode.getZaicodeEngines();
    const s = state.limits['antigravity:default'];
    return { at: Date.now(), snapshot: s ? { fetchedAt: s.fetchedAt, error: s.error, windows: s.windows.map(w => ({ key: w.key, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt, rollingFrom: w.rollingFrom, startsOnUse: w.startsOnUse, durationMinutes: w.durationMinutes })), windowStart: s.windowStart ? { at: s.windowStart.at, ok: s.windowStart.ok, windowKey: s.windowStart.windowKey } : null, windowStarts: Object.fromEntries(Object.entries(s.windowStarts || {}).map(([key, r]) => [key, { at: r.at, ok: r.ok, windowKey: r.windowKey }])) } : null, topbar: document.querySelector('button[data-zaicode-clock]')?.getAttribute('title') || '', tile: document.querySelector('[data-zaicode-engine-tile="AG"]')?.getAttribute('title') || '' };
  });
  observations.push({ label, ...data });
  return data;
}
const key = 'five_hour@claude_and_gpt_models';
function assertStable(sample, expected) {
  assert.equal(sample.snapshot.windowStarts[key]?.at, expected.startAt, 'real start admission survives sweeps/restart');
  assert.equal(sample.snapshot.windowStarts[key]?.ok, true, 'real successful vendor completion remains recorded');
  const window = sample.snapshot.windows.find(w => w.key === key);
  assert.equal(window.resetsAt, expected.resetAt, 'vendor reset remains fixed');
  assert.ok(!(window.startsOnUse && window.rollingFrom === undefined), 'the successfully started window does not wait for first use');
}
async function uiReading(page) {
  const card = page.locator('[data-zaicode-home-engine="antigravity:default"]');
  const home = await card.getByText('Claude & GPT 5h', { exact: true }).locator('..').innerText();
  const topbar = await page.locator('button[data-zaicode-clock]').getAttribute('title');
  const topLabel = topbar.match(/Next reset: Antigravity (.+) in /)?.[1];
  const topHome = topLabel ? await card.getByText(topLabel, { exact: true }).locator('..').innerText() : '';
  return { home, topbar, topHome };
}
function minutes(text) {
  const hours = text.match(/(\d+)h/);
  const mins = text.match(/(\d+)m/);
  return Number(hours?.[1] || 0) * 60 + Number(mins?.[1] || 0);
}
(async () => {
  try {
    let page = await launch();
    checks.isolatedPackagedShell = true;
    const first = await observe(page, 'first-live-sweep');
    assert.ok(first.snapshot?.windows.length > 0 && first.snapshot.error === null, 'vendor returns live quota inside the package');
    checks.liveQuota = true;
    const candidate = first.snapshot.windows.find(w => w.key === key);
    assert.ok(candidate && candidate.remainingPercent === 100 && candidate.startsOnUse, 'the selected pool has an actual idle window to start');
    checks.idlePoolAvailable = true;
    try {
      await page.waitForFunction(target => window.__t166LiveState.limits['antigravity:default']?.windowStarts?.[target]?.ok === true, key, { timeout: 60000 });
    } catch {
      await observe(page, 'starter-not-successful', false);
      throw new Error('supported idle Antigravity window needs a real successful starter, not only a local countdown');
    }
    checks.autoStartSucceeded = true;
    await page.waitForFunction(target => {
      const snapshot = window.__t166LiveState.limits['antigravity:default'];
      return snapshot.fetchedAt >= snapshot.windowStarts[target].at + 10000;
    }, key, { timeout: 45000 });
    const started = await observe(page, 'live-reread-after-real-starter');
    const expected = { startAt: started.snapshot.windowStarts[key].at, resetAt: started.snapshot.windows.find(w => w.key === key).resetsAt };
    assert.ok(expected.resetAt > Date.now());
    assertStable(started, expected);
    const homeButton = page.getByRole('button', { name: 'SAIHOME', exact: true });
    if (await homeButton.count()) await homeButton.first().click();
    await page.locator('[data-zaicode-home-widget="limits"]').waitFor({ timeout: 15000 });
    const showAll = page.getByRole('button', { name: /show all/i });
    if (await showAll.count()) await showAll.first().click();
    await page.waitForFunction(() => /Next reset: Antigravity /.test(document.querySelector('button[data-zaicode-clock]')?.getAttribute('title') || ''), null, { timeout: 35000 });
    const initialUi = await uiReading(page);
    observations.push({ label: 'first-live-ui', ...initialUi });
    assert.doesNotMatch(initialUi.home, /starts on first use/);
    const homeReset = initialUi.home.match(/resets in ([^\n]+)/)?.[1];
    const topReset = initialUi.topbar.match(/Next reset: Antigravity .+ in ([^\n]+)/)?.[1];
    const topHomeReset = initialUi.topHome.match(/resets in ([^\n]+)/)?.[1];
    assert.ok(homeReset && topReset, 'both surfaces expose the same live vendor window');
    assert.ok(topHomeReset && Math.abs(minutes(topHomeReset) - minutes(topReset)) <= 1, 'SAIHOME/topbar countdowns agree for the window the clock selects within their render cadence');
    assert.ok(Math.abs(minutes(homeReset) - Math.floor((expected.resetAt - Date.now()) / 60000)) <= 1, 'UI countdown agrees with the authoritative reset');
    checks.uiAgreement = true;
    await page.screenshot({ path: path.join(out, 'first.png') });
    const second = await observe(page, 'second-live-sweep');
    const third = await observe(page, 'third-live-sweep');
    for (const sample of [second, third]) assertStable(sample, expected);
    checks.sweepAnchors = true;
    const cache = JSON.parse(fs.readFileSync(path.join(profile, 'zaicode-engines-cache.json'), 'utf8'));
    assert.equal(cache.limits['antigravity:default'].windowStarts[key].at, expected.startAt, 'actual start admission reaches real on-disk cache');
    checks.persisted = true;
    const bad = structuredClone(third);
    bad.snapshot.windowStarts[key].at += 60000;
    assert.throws(() => assertStable(bad, expected), /real start admission/, 'the stability oracle rejects a changed start');
    checks.negativeControl = true;
    await page.waitForTimeout(65000);
    const laterUi = await uiReading(page);
    observations.push({ label: 'countdown-after-65-real-seconds', ...laterUi });
    const laterReset = laterUi.home.match(/resets in ([^\n]+)/)?.[1];
    assert.ok(laterReset && minutes(laterReset) < minutes(homeReset), 'visible countdown advances with real time');
    checks.countdownAdvances = true;
    await stop();
    page = await launch();
    const restarted = await observe(page, 'restart-before-refresh', false);
    const after = await observe(page, 'restart-live-sweep');
    for (const sample of [restarted, after]) assertStable(sample, expected);
    checks.restartAnchors = true;
    checks.pageErrors = errors.length === 0;
    assert.deepEqual(errors, []);
  } catch (error) {
    observations.push({ failure: error.message.split('\n')[0] });
    process.exitCode = 1;
  } finally {
    await stop();
    const receipt = { schema: 'zaicode-t166-live/1', executablePath, targetKey: key, profile, playwrightVersion: require('playwright/package.json').version, at: new Date().toISOString(), checks, observations, errors, ok: !process.exitCode };
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify({ ok: receipt.ok, checks, failure: observations.find(o => o.failure)?.failure, receipt: path.join(out, 'receipt.json') }));
  }
})();
