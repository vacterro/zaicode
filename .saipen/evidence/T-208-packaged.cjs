const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = process.env.T208_PROJECT_ROOT || 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const product = path.join(root, 'zcode');
const { _electron } = createRequire(path.join(product, 'packages/desktop/package.json'))('playwright-core');
const executablePath = path.resolve(process.env.T208_PACKAGED_EXE);
const output = process.env.T208_PACKAGED_OUT || path.join(root, '.saipen/evidence/T-208-packaged');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zaicode-t208-ui-'));
const project = path.join(profile, 'preset-project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(profile, 'zaicode-engines.json'), JSON.stringify({ keepWindowsRolling: false }));
const log = path.join(profile, 'counter.jsonl');
const stop = path.join(profile, 'stop-counter');
const counter = path.join(profile, 'counter.cjs');
fs.writeFileSync(counter, `const fs=require('node:fs'),marker=require('node:crypto').randomUUID();let count=0;const startedAt=Date.now();
const tick=()=>{const final=fs.existsSync(process.argv[3]);const record={pid:process.pid,marker,startedAt,count:++count,final};fs.appendFileSync(process.argv[2],JSON.stringify(record)+'\\n');console.log((final?'T208-FINAL:':'T208-COUNTER:')+JSON.stringify(record));if(final||count>1200)process.exit(0)};tick();setInterval(tick,250);`);
const sections = [
  ['zaicodeSounds', { 'zaicode-sound-events-v1': null }],
  ['zaicodeNotifications', { 'zaicode-notifications-v1': null, 'zcode-notification-enabled': 'false', 'zcode-notification-sound-enabled': 'false' }],
  ['zaicodeColors', { 'zaicode-bevels': '1' }],
  ['zaicodeProtrail', { 'zaicode-protrail-v1': { trail: { enabled: false }, click: { enabled: false } } }],
  ['zaicodeTimers', { 'zaicode-timer-prefs-v1': { clock: { showSeconds: true }, productivity: { workSeconds: 600, breakSeconds: 120, completedCycles: 999 }, intervalRules: [] } }],
  ['zaicodeHotkeys', { 'zaicode-hotkeys-v1': null }],
  ['zaicodeSidebar', { 'zaicode-sidebar-prefs-v1': null }],
  ['zaicodeLayout', { 'zaicode-composer-prefs-v1': null }],
  ['zaicodeWorkers', { 'zaicode-workers-prefs-v1': { font: 'terminus', fontSize: 16, layout: 'split', visibleCount: 4 } }],
  ['zaicodeEngines', { 'zaicode-limit-meter-style': null }],
];
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
  assert.ok(pass, name);
};
const records = () => {
  try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, good, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (good(value)) return value;
    await sleep(40);
  }
  throw new Error(`Timed out: ${description}`);
}
const quote = value => `'${value.replaceAll("'", "''")}'`;
const kill = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { execFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
};

(async () => {
  const env = {
    ...process.env, ZCODE_ZAICODE_MODE: '1', ZAICODE_UPDATES: 'off',
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE T208 ${path.basename(profile)}`,
    ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, 'session'),
    ZCODE_DATA_BASE_DIR: profile, ZCODE_HOME: path.join(profile, '.zcode'),
    USERPROFILE: profile, HOME: profile,
    APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'),
    ZAICODE_CUSTOMIZATION_DIR: path.join(profile, 'customization'),
  };
  delete env.TZ;
  delete env.SAIMAIL_WORKSPACE;
  delete env.ZAICODE_INSTALL_ROOT;
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
  }
  let app, page, appPid, workerPid;
  const errors = [];
  let mainNavigations = 0;
  let before;
  const timerTarget = Date.now() + 10 * 60_000;
  try {
    app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 90000 });
    appPid = app.process().pid;
    page = await until(() => app.windows(), windows => windows.some(window => window.url().includes('/out/renderer/index.html')), 'main renderer', 60000)
      .then(windows => windows.find(window => window.url().includes('/out/renderer/index.html')));
    page.on('pageerror', error => errors.push(String(error).slice(0, 800)));
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 60000 });
    check('the packaged application uses a throw-away profile', path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))) === path.resolve(profile));
    const workerCommand = `& ${quote(process.execPath)} ${quote(counter)} ${quote(log)} ${quote(stop)}; exit $LASTEXITCODE`;
    await page.evaluate(({ sections, timerTarget, workerCommand }) => {
      localStorage.setItem('zcode-locale-preference', 'en-US');
      localStorage.setItem('zaicode-protrail-v1', JSON.stringify({ trail: { enabled: false }, click: { enabled: false } }));
      localStorage.setItem('zaicode-dispatch-prefs-v1', JSON.stringify({ where: 'panel', lastProject: null, launchers: [{ id: 'terminal', label: 'Terminal', short: 'PS', command: workerCommand }] }));
      localStorage.setItem('zaicode-layout-v1', JSON.stringify({ footerTools: [{ id: 'dispatch', visible: true }, { id: 'settings', visible: true }] }));
      localStorage.setItem('zaicode-bevels', '0');
      localStorage.setItem('zaicode-timers-v1', JSON.stringify([{ id: 't208-live-timer', name: 'T208 live timer', description: '', target: timerTarget, repeat: 'once', enabled: true, fired: false, volume: 0, showNotification: false, showInTopBar: true, deleteAfterFire: false }]));
      localStorage.setItem('zaicode-timer-prefs-v1', JSON.stringify({ clock: { showSeconds: false }, productivity: { completedCycles: 4 } }));
      localStorage.setItem('zcode-notification-enabled', 'true');
      localStorage.setItem('zcode-notification-sound-enabled', 'true');
      localStorage.setItem('zaicode-presets-v1', JSON.stringify(sections.map(([section, settings]) => ({ id: `t208-${section}`, section, name: `T208 ${section}`, createdAt: '2026-10-04T00:00:00.000Z', settings, assets: [] }))));
    }, { sections, timerTarget, workerCommand });
    // Fixture setup precedes the lifetime measurement and the worker launch.
    await page.reload();
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 60000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await page.getByTestId('project-add').click();
    await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click();
    const row = page.locator('[data-testid^="workspace-item"]').filter({ hasText: 'preset-project' }).first();
    await row.waitFor({ state: 'visible' });
    await row.click();
    const composer = page.locator('[contenteditable="true"]:visible').last();
    await composer.waitFor({ state: 'visible', timeout: 30000 });
    const draft = 'T208 unsent composer text stays attached';
    await composer.fill(draft);
    await page.getByTestId('zaicode-dispatch').last().click();
    const dispatch = page.locator('[data-zaicode-dispatch]');
    await dispatch.getByRole('radio', { name: 'WORKERS panel', exact: true }).click();
    await dispatch.locator('[data-zaicode-dispatch-launcher="terminal"]').click();
    const terminal = page.locator('[data-zaicode-worker-terminal="PS"]');
    await terminal.locator('.xterm').waitFor({ state: 'visible', timeout: 30000 });
    const initial = await until(records, values => values.length >= 3, 'real native worker output');
    workerPid = initial[0].pid;
    check('positive control: the real native worker advances with one run identity', initial.every(value => value.pid === workerPid && value.marker === initial[0].marker && value.startedAt === initial[0].startedAt));
    const nonce = crypto.randomUUID();
    await page.evaluate(value => { window.__t208LifetimeNonce = value; }, nonce);
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) mainNavigations += 1; });
    const metrics = () => app.evaluate(({ app, BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('/out/renderer/index.html'));
      return { rendererPid: main.webContents.getOSProcessId(), utilityPids: app.getAppMetrics().filter(metric => metric.type === 'Utility').map(metric => metric.pid).sort((a, b) => a - b) };
    });
    before = { appPid, ...await metrics(), worker: initial[0] };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await page.screenshot({ path: `${output}-before.png` });
    await page.locator('button[aria-label="Settings"]:visible').first().click();
    const notificationControl = label => page.getByText(label, { exact: true }).locator('..').locator('..').getByRole('switch');
    await page.locator('nav button[data-testid$="general"]').click();
    check('positive control: both cached task notification preferences initially show enabled',
      await notificationControl('Task notifications').getAttribute('aria-checked') === 'true' &&
      await notificationControl('Notification sound').getAttribute('aria-checked') === 'true');
    for (const [section] of sections) {
      const settingsSection = section === 'zaicodeHotkeys' ? 'shortcuts' : section;
      await page.locator(`nav button[data-testid$="${settingsSection}"]`).click();
      await page.locator(`[data-zaicode-presets-menu="${section}"]`).click();
      const panel = page.locator(`[data-zaicode-presets-panel="${section}"]`);
      await panel.locator(`[data-zaicode-preset="t208-${section}"]`).getByRole('button', { name: 'Apply', exact: true }).click();
      await page.waitForFunction(({ nonce, section }) => {
        const text = document.querySelector(`[data-zaicode-presets-panel="${section}"] [role="status"]`)?.textContent || '';
        return window.__t208LifetimeNonce !== nonce || /Applied|did not work/.test(text);
      }, { nonce, section }, { timeout: 15000 });
      const now = await metrics();
      check(`${section}: application, renderer and runtime stay attached`,
        app.process().pid === before.appPid && now.rendererPid === before.rendererPid &&
        JSON.stringify(now.utilityPids) === JSON.stringify(before.utilityPids) && mainNavigations === 0 &&
        await page.evaluate(value => window.__t208LifetimeNonce === value, nonce), now);
      assert.match(await panel.getByRole('status').innerText(), /Applied/);
      if (section === 'zaicodeNotifications') {
        check('the notification fixture uses accepted serialized preference values', await page.evaluate(() =>
          localStorage.getItem('zcode-notification-enabled') === 'false' && localStorage.getItem('zcode-notification-sound-enabled') === 'false'));
      }
      const previous = records().at(-1);
      const advanced = await until(records, values => values.at(-1)?.count > previous.count, `${section}: worker continues`, 5000);
      check(`${section}: worker PID, run marker and start identity survive`, advanced.every(value => value.pid === before.worker.pid && value.marker === before.worker.marker && value.startedAt === before.worker.startedAt));
      await page.keyboard.press('Escape');
    }
    const timer = await page.evaluate(() => JSON.parse(localStorage.getItem('zaicode-timers-v1')).find(timer => timer.id === 't208-live-timer'));
    check('the active timer retains its identity and deadline after all preset families', timer?.target === timerTarget && timer.enabled && !timer.fired, timer);
    const prefs = await page.evaluate(() => JSON.parse(localStorage.getItem('zaicode-timer-prefs-v1')));
    check('timer preferences update live without importing another run counter', prefs.clock.showSeconds === true && prefs.productivity.completedCycles === 4);
    await page.locator('nav button[data-testid$="general"]').click();
    check('notification presets update the existing application store and General controls',
      await notificationControl('Task notifications').getAttribute('aria-checked') === 'false' &&
      await notificationControl('Notification sound').getAttribute('aria-checked') === 'false');
    await page.getByTestId('settings-back-button').click();
    await composer.waitFor({ state: 'visible' });
    check('the unsent composer text survives Settings preset application', (await composer.innerText()).includes(draft));
    check('the selected project remains the fixture project', await row.isVisible() && /\bbg-selected\b/.test(await row.getAttribute('class')));
    fs.writeFileSync(stop, 'finish the same worker');
    const ended = await until(records, values => values.at(-1)?.final, 'worker final result');
    check('the final result belongs to the original worker run', ended.at(-1).pid === before.worker.pid && ended.at(-1).marker === before.worker.marker);
    await until(() => terminal.locator('[data-zaicode-worker-duration="end"]').innerText(), value => /exit|ended|finished/i.test(value), 'worker final status attached');
    check('the same worker terminal displays its final status', await terminal.isVisible());
    await page.screenshot({ path: `${output}-after.png` });
    check('no renderer exception occurred', errors.length === 0, errors);
  } catch (error) {
    checks.push({ name: 'packaged acceptance completed', pass: false, detail: String(error?.stack || error).slice(0, 1600) });
    if (page && !page.isClosed()) await page.screenshot({ path: `${output}-failure.png` }).catch(() => {});
  } finally {
    fs.writeFileSync(stop, 'cleanup fixture worker');
    if (app) await app.close().catch(() => {});
    kill(appPid); kill(workerPid);
  }
  const asar = path.join(path.dirname(executablePath), 'resources/app.asar');
  const receipt = { schema: 't208-packaged/1', at: new Date().toISOString(), executablePath, profile,
    verifier: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, '.saipen/evidence/T-208-packaged.cjs'))).digest('hex'),
    appAsarSha256: crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex'),
    before, mainNavigations, checks, pass: checks.every(check => check.pass) };
  fs.writeFileSync(`${output}.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ pass: receipt.pass, checks: checks.length, failed: checks.filter(check => !check.pass).map(check => check.name), receipt: `${output}.json` }));
  process.exitCode = receipt.pass ? 0 : 1;
})();
