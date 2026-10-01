const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');
const ROOT = process.env.ZAICODE_TEST_ROOT || 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode';
const OUT = process.env.ZAICODE_TEST_OUTPUT || path.resolve(ROOT, '../.saipen/evidence/T-142-browser');
const desktop = path.join(ROOT, 'packages/desktop');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zaicode-t142-'));
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'roaming'), LOCALAPPDATA: path.join(profile, 'local'), ZCODE_DESKTOP_APPLICATION_NAME: 'ZAICODE T142 test', ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DESKTOP_USER_DATA_DIR: profile, ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, 'session'), ZCODE_DATA_BASE_DIR: profile, ZCODE_HOME: path.join(profile, '.zcode'), ZCODE_ZAICODE_MODE: '1', ZAICODE_CUSTOMIZATION_DIR: path.join(profile, 'customization'), ZAICODE_UPDATES: 'off' };
for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW|SAIMAIL_WORKSPACE|ZAICODE_INSTALL_ROOT|ELECTRON_RUN_AS_NODE)/i.test(key)) delete env[key];
const checks = {};
let app, page;
(async () => {
  try {
    app = await _electron.launch({ executablePath: process.env.ZAICODE_TEST_EXECUTABLE || require(require.resolve('electron', { paths: [desktop] })), args: [...(process.env.ZAICODE_TEST_EXECUTABLE ? [] : [desktop]), `--user-data-dir=${profile}`], env, timeout: 90000 });
    const errors = [];
    app.on('window', p => p.on('pageerror', e => errors.push(String(e))));
    for (let i = 0; i < 120; i++) {
      page = app.windows().find(p => p.url().includes('/out/renderer/index.html'));
      if (page) break;
      await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(page);
    page.on('pageerror', e => errors.push(String(e)));
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 60000 });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.locator('button[aria-label="Settings"]:visible').first().click();
    const nav = page.locator('nav').filter({ hasText: 'Keyboard Shortcuts' }).first();
    await nav.getByRole('button', { name: /Highlights.*motion/i }).click();
    await page.getByRole('tab', { name: 'SAIFREN', exact: true }).waitFor({ timeout: 60000 });
    const editor = page.locator('#zaicode-model-appearance-editor');
    await editor.getByRole('checkbox', { name: 'Cog', exact: true }).click();
    await page.getByRole('tab', { name: 'SAIFREN', exact: true }).click();
    await editor.getByRole('checkbox', { name: 'Fan', exact: true }).click();
    await editor.getByRole('checkbox', { name: 'Swing', exact: true }).click();
    await editor.getByRole('radio', { name: 'Own', exact: true }).click();
    await editor.locator('input[type="color"]').fill('#00ffff');
    const workingHighlight = page.locator('[data-zaicode-highlight-row="sessionWorking"]');
    await workingHighlight.getByRole('radio', { name: 'Own', exact: true }).click();
    await workingHighlight.locator('input[type="color"]').fill('#ff00ff');
    await workingHighlight.getByRole('checkbox', { name: 'Blink', exact: true }).click();
    const pref = await page.evaluate(() => JSON.parse(localStorage.getItem('zaicode-model-appearance-v1')));
    const [key, own] = Object.entries(pref.models).find(([key]) => key.endsWith('::saifren'));
    assert.deepEqual(own.working.images, ['fan']);
    assert.deepEqual(own.working.motions, ['swing']);
    assert.equal(own.working.custom, '#00ffff');
    assert.equal(own.highlight.sessionWorking.custom, '#ff00ff');
    assert.deepEqual(own.highlight.sessionWorking.effects, ['blink']);
    assert.ok(await editor.locator('svg.lucide-fan[data-zaicode-working-icon]').count());
    await page.getByRole('tab', { name: 'Default', exact: true }).click();
    assert.ok(await editor.locator('svg.lucide-cog[data-zaicode-working-icon]').count());
    await page.reload();
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 60000 });
    await page.locator('button[aria-label="Settings"]:visible').first().click();
    await nav.getByRole('button', { name: /Highlights.*motion/i }).click();
    await page.getByRole('tab', { name: 'SAIFREN', exact: true }).click();
    assert.ok(await editor.locator('svg.lucide-fan[data-zaicode-working-icon]').count());
    assert.equal(await editor.locator('input[type="color"]').inputValue(), '#00ffff');
    assert.equal(await workingHighlight.locator('input[type="color"]').inputValue(), '#ff00ff');
    checks.appearance = { key, persisted: true, defaultImage: 'cog', modelImage: 'fan', motion: 'swing', iconColour: '#00ffff', highlightColour: '#ff00ff', highlightEffect: 'blink' };
    await page.screenshot({ path: path.join(OUT, 'model-tabs.png') });
    await page.getByRole('button', { name: 'Use Default', exact: true }).click();
    assert.ok(await editor.locator('svg.lucide-cog[data-zaicode-working-icon]').count());
    await nav.getByRole('button', { name: 'Sidebar', exact: true }).click();
    await page.getByLabel('Priority slots: group projects as MAIN0 / MAIN1 / SIDE0 … SIDE3', { exact: true }).check();
    await page.getByLabel('Show project counts', { exact: true }).uncheck();
    await page.getByTestId('settings-back-button').click();
    for (const name of ['project-one', 'project-two']) {
      const folder = path.join(profile, name); fs.mkdirSync(folder);
      await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
      await page.getByTestId('project-add').click();
      await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click();
      await page.locator('[data-testid^="workspace-item-"]').filter({ hasText: name }).waitFor({ timeout: 30000 });
    }
    const active = page.locator('[data-zaicode-project-selected]');
    assert.equal(await active.count(), 1);
    const selected = await active.evaluate(e => ({ width: getComputedStyle(e).outlineWidth, color: getComputedStyle(e).outlineColor, opacity: getComputedStyle(e.closest('li')).opacity, text: e.textContent }));
    assert.equal(selected.width, '2px'); assert.equal(selected.opacity, '1'); assert.match(selected.text, /project-two/);
    checks.selectedProject = selected;
    const slot = page.locator('[data-zaicode-slot-group="MAIN0"]');
    const count = Number(await slot.getAttribute('data-zaicode-slot-count')); assert.ok(count >= 2);
    await slot.click(); assert.equal(await slot.getAttribute('data-zaicode-slot-count'), String(count));
    assert.match(await slot.innerText(), new RegExp(`·${count}`));
    assert.equal(await page.locator('[data-testid^="workspace-item-"]:visible').count(), 0);
    await page.screenshot({ path: path.join(OUT, 'collapsed-slots.png') });
    await slot.click();
    checks.collapsedCount = count;
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Visible folder');
    await page.getByRole('textbox', { name: 'Folder name', exact: true }).press('Enter');
    const header = page.locator('[data-zaicode-folder-header]').filter({ hasText: 'Visible folder' });
    await header.waitFor(); assert.equal(await header.getAttribute('data-zaicode-folder-count'), '0');
    const row = page.locator('[data-testid^="workspace-item-"]').filter({ hasText: 'project-two' });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to folder', exact: true }).hover();
    await page.getByRole('menuitemradio', { name: 'Move into Visible folder', exact: true }).click();
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('[data-zaicode-folder-header]')?.getAttribute('data-zaicode-folder-count') === '1');
    await header.getByRole('button', { name: 'Collapse Visible folder', exact: true }).click();
    assert.equal(await row.count(), 0);
    await header.getByRole('button', { name: 'Expand Visible folder', exact: true }).click();
    await row.waitFor();
    checks.folder = { immediatelyVisible: true, membership: 1, collapse: true, expand: true };
    const positions = [];
    for (let width = 1000; width < 1010; width++) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(100);
      const values = await page.locator('[data-v4-composer-dock-content="true"]').evaluateAll(elements => elements.map(e => ({ x: e.getBoundingClientRect().left * devicePixelRatio, translate: getComputedStyle(e).translate })));
      for (const value of values) { assert.ok(Math.abs(value.x - Math.round(value.x)) < .02, JSON.stringify({ width, value })); assert.equal(value.translate, 'none'); }
      positions.push({ width, values });
    }
    checks.pixelPositions = positions;
    assert.equal(await row.locator('[data-zaicode-project-folder]').innerText(), 'Visible folder');
    await page.screenshot({ path: path.join(OUT, 'sidebar.png') });
    assert.deepEqual(errors, []);
    checks.noPageErrors = true;
    fs.writeFileSync(path.join(OUT, 'receipt.json'), JSON.stringify({ ok: true, checks }, null, 2));
    console.log(JSON.stringify({ ok: true, checks }));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(OUT, 'failure.txt'), await page.locator('body').innerText().catch(() => '') ); }
    fs.writeFileSync(path.join(OUT, 'receipt.json'), JSON.stringify({ ok: false, checks, error: String(error.stack || error) }, null, 2));
    throw error;
  } finally { if (app) await app.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
