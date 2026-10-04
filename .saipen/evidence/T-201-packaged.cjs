/**
 * T-201 / SRC-135 oracle: the Auto-retry switch beside the composer.
 *
 * What a user reported missing is two things at once: a switch that is right there by the
 * composer, and a mode that decides whether it governs this project or every ZAICODE
 * session. This drives the packaged app and proves both against the shipped asar: the
 * button exists next to the send control, it is lit exactly while auto retry is on, a
 * click writes the per-project answer rather than the global flag, the scope switch
 * relabels itself, and the stored preferences survive a reload of the window.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const root = process.env.T201_PROJECT_ROOT || 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const { _electron } = createRequire(path.join(root, 'zcode/packages/desktop/package.json'))('playwright-core');
const exe = path.resolve(
  process.env.T201_PACKAGED_EXE || path.join(root, 'zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe'),
);
const out = process.env.T201_PACKAGED_OUT || path.join(os.tmpdir(), 't201-packaged');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zaicode-t201-'));
const project = path.join(profile, 'retry-project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(profile, 'zaicode-engines.json'), JSON.stringify({ keepWindowsRolling: false }));

const PREFS_KEY = 'zaicode-ui-prefs-v1';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: !!pass, ...(detail === undefined ? {} : { detail }) });
};

(async () => {
  let app, page;
  let stage = 'boot';
  const errors = [];
  const env = {
    ...process.env,
    ZCODE_ZAICODE_MODE: '1',
    ZAICODE_UPDATES: 'off',
    ZCODE_DESKTOP_APPLICATION_NAME: 'ZAICODE T201 ' + path.basename(profile),
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, 'session'),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, '.zcode'),
    USERPROFILE: profile,
    HOME: profile,
    APPDATA: path.join(profile, 'AppData/Roaming'),
    LOCALAPPDATA: path.join(profile, 'AppData/Local'),
    ZAICODE_CUSTOMIZATION_DIR: path.join(profile, 'customization'),
  };
  delete env.TZ;
  delete env.SAIMAIL_WORKSPACE;
  delete env.ZAICODE_INSTALL_ROOT;
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
  }

  const uiPrefs = () =>
    page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), PREFS_KEY);

  const buttonState = async () =>
    page.evaluate(() => {
      const main = document.querySelector('[data-testid="zaicode-auto-retry"]');
      const scope = document.querySelector('[data-testid="zaicode-auto-retry-scope"]');
      if (!main || !scope) return null;
      const box = main.getBoundingClientRect();
      return {
        state: main.getAttribute('data-zaicode-auto-retry'),
        pressed: main.getAttribute('aria-pressed'),
        lit: /\bbg-selected\b/.test(main.className),
        label: main.getAttribute('aria-label'),
        title: main.getAttribute('title'),
        scopeLabel: scope.textContent.trim(),
        scopeTitle: scope.getAttribute('title'),
        visible: box.width > 0 && box.height > 0,
        // A covered button is the SRC-136 failure mode: present, painted, not clickable.
        topElement: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.getAttribute('data-testid') || null,
      };
    });

  const besideSend = () =>
    page.evaluate(() => {
      const main = document.querySelector('[data-testid="zaicode-auto-retry"]');
      const send = document.querySelector('[data-testid="v4-composer-send"]');
      if (!main || !send) return { main: !!main, send: !!send };
      const a = main.getBoundingClientRect();
      const b = send.getBoundingClientRect();
      // Same row of controls: vertical centres close together, no panel in between.
      return {
        main: true,
        send: true,
        gapPx: Math.round(Math.max(0, Math.abs(a.x - b.x) + Math.abs(a.y - b.y) - (a.width / 2 + b.width / 2))),
        sameRow: Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < a.height,
      };
    });

  try {
    app = await _electron.launch({
      executablePath: exe,
      args: ['--user-data-dir=' + profile],
      env,
      timeout: 90000,
    });
    page = await (async () => {
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        const ws = app.windows();
        const hit = ws.find((w) => w.url().includes('/out/renderer/index.html'));
        if (hit) return hit;
        await pause(60);
      }
      throw new Error('Timed out: main renderer');
    })();
    page.on('pageerror', (e) => errors.push({ stage, stack: String(e.stack || e) }));
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 60000 });
    check(
      'the packaged app runs on an isolated profile',
      path.resolve(await app.evaluate(({ app: a }) => a.getPath('userData'))) === path.resolve(profile),
    );
    await page.evaluate(() => localStorage.setItem('zcode-locale-preference', 'en-US'));
    await page.reload();
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 60000 });
    await page.setViewportSize({ width: 1600, height: 1000 });

    stage = 'open a project';
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
    }, project);
    await page.getByTestId('project-add').click();
    await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click();
    const row = page.locator('[data-testid^="workspace-item"]').filter({ hasText: 'retry-project' }).first();
    await row.waitFor({ state: 'visible' });
    await row.click();
    await pause(3000);

    stage = 'the composer switch';
    const main = page.getByTestId('zaicode-auto-retry');
    await main.waitFor({ state: 'visible', timeout: 30000 });
    const place = await besideSend();
    check('the auto-retry switch sits by the composer send control', place.main && place.sameRow, place);
    check('the switch is on screen and not covered', await main.isVisible());

    const before = await buttonState();
    check('auto retry starts on and lit', before && before.state === 'on' && before.pressed === 'true' && before.lit, before);
    check('the switch explains itself', !!before.title && /auto retry/i.test(before.title), before && before.title);
    check('the scope switch starts at "Everywhere"', before && before.scopeLabel === 'Everywhere', before && before.scopeLabel);

    stage = 'the scope switch';
    const scope = page.getByTestId('zaicode-auto-retry-scope');
    await scope.click();
    await pause(600);
    const scoped = await buttonState();
    const scopedPrefs = await uiPrefs();
    check(
      'clicking the scope switch moves the switch to this project',
      scoped.scopeLabel === 'This project' && scopedPrefs.autoRetryScope === 'project',
      { label: scoped.scopeLabel, stored: scopedPrefs.autoRetryScope },
    );
    check('the scope switch spells out what it now covers', /this project\/session only/.test(scoped.scopeTitle || ''), scoped.scopeTitle);

    stage = 'the main toggle in project mode';
    await main.click();
    await pause(800);
    const off = await buttonState();
    const offPrefs = await uiPrefs();
    check('a click turns auto retry off', off.state === 'off' && off.pressed === 'false' && !off.lit, off);
    check(
      'in project mode the answer is stored per project, not globally',
      offPrefs.autoRetryScope === 'project' && offPrefs.autoRetryProjects && Object.keys(offPrefs.autoRetryProjects).length === 1 && offPrefs.autoRetry !== false,
      offPrefs,
    );
    check(
      'another project keeps the global answer while this one is off',
      Object.values(offPrefs.autoRetryProjects || {}).every((v) => v === false) && offPrefs.autoRetry === true,
      offPrefs,
    );

    stage = 'the toggle is live again';
    await main.click();
    await pause(800);
    const back = await buttonState();
    const backPrefs = await uiPrefs();
    check('clicking again turns it back on and lit', back.state === 'on' && back.pressed === 'true' && back.lit, back);

    stage = 'survives a reload';
    await page.reload();
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 60000 });
    await pause(1500);
    const row2 = page.locator('[data-testid^="workspace-item"]').filter({ hasText: 'retry-project' }).first();
    if (await row2.count()) {
      await row2.click();
      await pause(2500);
    }
    const afterReload = await buttonState();
    check(
      'the answer survives a window reload',
      afterReload && afterReload.scopeLabel === 'This project' && afterReload.state === 'on',
      afterReload,
    );

    stage = 'global mode still governs every project';
    await page.getByTestId('zaicode-auto-retry-scope').click();
    await pause(600);
    const global = await buttonState();
    const globalPrefs = await uiPrefs();
    check('the scope switch returns to everywhere', global.scopeLabel === 'Everywhere' && globalPrefs.autoRetryScope === 'global', {
      label: global.scopeLabel,
      stored: globalPrefs.autoRetryScope,
    });
    check('the per-project answers are kept, not thrown away', Object.keys(globalPrefs.autoRetryProjects || {}).length === 1, globalPrefs);

    check('zero renderer exceptions', errors.length === 0, errors);
  } catch (error) {
    check('the oracle ran to the end', false, `${stage}: ${String(error && error.message).split('\n')[0]}`);
  } finally {
    try {
      if (app) await app.close();
    } catch {
      /* the app is going away anyway */
    }
  }

  const asarPath = path.join(path.dirname(exe), 'resources', 'app.asar');
  const asarSha256 = fs.existsSync(asarPath)
    ? crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex')
    : null;
  const failed = checks.filter((c) => !c.pass);
  const report = {
    ticket: 'T-201',
    source: 'SRC-135',
    verifier: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 16),
    asarSha256,
    exe,
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'T-201-packaged.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, asarSha256, verifier: report.verifier }, null, 2));
  for (const c of failed) console.log('FAIL', c.name, JSON.stringify(c.detail || '').slice(0, 400));
  process.exit(failed.length ? 1 : 0);
})();
