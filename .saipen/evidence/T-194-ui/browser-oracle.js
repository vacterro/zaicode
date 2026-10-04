const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const URL = process.env.T194_UI_URL || 'http://127.0.0.1:4194';
const PREFIX = process.env.T194_EVIDENCE_PREFIX || 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/.saipen/evidence/T-194-ui-green';
(async () => {
  const browser = await chromium.launch({ headless: false });
  const results = [], errors = [];
  const check = async (name, run) => {
    try { await run(); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, message: error.message }); }
  };
  try {
    for (const config of [
      { compact: true, folder: false, width: 1280 },
      { compact: false, folder: false, width: 1280 },
      { compact: true, folder: true, width: 480 },
      { compact: false, folder: true, width: 480 },
    ]) {
      const context = await browser.newContext({ viewport: { width: config.width, height: 950 } });
      const page = await context.newPage();
      page.setDefaultTimeout(1800);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(`${URL}/?compact=${config.compact ? 'yes' : 'no'}&folder=${config.folder ? 'yes' : 'no'}`);
      await page.waitForFunction(() => globalThis.fixture?.ready);
      const name = `${config.compact ? 'compact' : 'normal'}/${config.folder ? 'folder' : 'MAIN'}/${config.width}`;
      await check(`${name}: positive actual renderer`, async () => {
        assert.match(await page.locator('#sidebar').innerText(), /Fixture project/);
        assert.match(await page.locator('#conversation').innerText(), /helper conversation content/);
      });
      await check(`${name}: idle named MAIN survives working-only filter`, async () => {
        assert.match(await page.locator('#sidebar').innerText(), /Project main conversation/);
        assert.match(await page.locator('#sidebar').innerText(), /MAIN/);
      });
      await check(`${name}: project label opens MAIN repeatedly without folding`, async () => {
        const row = page.locator('#sidebar [data-zaicode-sound="sidebar.project"]');
        for (let i = 0; i < 3; i++) {
          await row.click();
          assert.equal(await page.locator('#conversation').getAttribute('data-selected'), 'main');
          assert.equal(await page.evaluate(() => fixture.expanded), true);
        }
      });
      await check(`${name}: helper remains reachable and MAIN click returns`, async () => {
        await page.locator('#sidebar').getByText('Helper test conversation', { exact: true }).click();
        assert.equal(await page.locator('#conversation').getAttribute('data-selected'), 'helper');
        await page.locator('#sidebar [data-zaicode-sound="sidebar.project"]').click();
        assert.equal(await page.locator('#conversation').getAttribute('data-selected'), 'main');
      });
      await check(`${name}: separate folding control preserves selected conversation`, async () => {
        const fold = page.locator('[data-zaicode-project-fold]');
        assert.equal(await fold.count(), 1);
        const selected = await page.locator('#conversation').getAttribute('data-selected');
        await fold.click();
        assert.equal(await page.evaluate(() => fixture.expanded), false);
        assert.equal(await page.locator('#conversation').getAttribute('data-selected'), selected);
        await fold.press('Enter');
        assert.equal(await page.evaluate(() => fixture.expanded), true);
        assert.equal(await page.locator('#conversation').getAttribute('data-selected'), selected);
      });
      await check(`${name}: actual project, session and timeline test indicators`, async () => {
        assert.equal(await page.locator('#sidebar [data-zaicode-tests="project"]').count(), 1);
        assert.equal(await page.locator('#sidebar [data-zaicode-tests="session"]').count(), 1);
        assert.equal(await page.locator('#timeline [data-zaicode-tests="session"]').count(), 1);
        assert.match(await page.locator('#timeline [data-zaicode-tests="session"]').getAttribute('title'), /pnpm test/);
      });
      await check(`${name}: test motion preferences are independent`, async () => {
        const session = page.locator('#timeline [data-zaicode-tests="session"]');
        const before = await session.getAttribute('style');
        await page.locator('#project-effect').click();
        const project = page.locator('#sidebar [data-zaicode-tests="project"]');
        assert.match(await project.getAttribute('style'), /zh-blink/);
        assert.equal(await session.getAttribute('style'), before);
      });
      await check(`${name}: ending actual activity clears test and working indicators`, async () => {
        await page.locator('#end-tests').click();
        assert.equal(await page.locator('[data-zaicode-tests]').count(), 0);
        assert.equal(await page.locator('[data-zaicode-project-working]').count(), 0);
        assert.equal(await page.locator('[data-zh="sessionWorking"]').count(), 0);
        assert.equal(await page.locator('[data-zaicode-project-stalled]').count(), 0);
      });
      await check(`${name}: empty project click creates a usable draft`, async () => {
        await page.locator('#empty-project').click();
        await page.locator('#sidebar [data-zaicode-sound="sidebar.project"]').click();
        assert.equal(await page.locator('#conversation').getAttribute('data-selected'), 'draft');
        assert.match(await page.locator('#conversation').innerText(), /New conversation ready/);
      });
      await check(`${name}: persisted job callback accepts exact SAIFREN runner and ordering`, async () => {
        await page.getByRole('combobox', { name: 'Add fallback runner' }).selectOption('pool:route/SAIFREN');
        assert.deepEqual(await page.evaluate(() => fixture.job.continuation.runnerIds), ['C2', 'pool:route/SAIFREN']);
        await page.getByRole('button', { name: 'Move pool:route/SAIFREN earlier', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => fixture.job.continuation.runnerIds), ['pool:route/SAIFREN', 'C2']);
        await page.getByRole('spinbutton', { name: 'Handoff delay in minutes' }).fill('3');
        await page.getByRole('spinbutton', { name: 'Return delay in minutes' }).fill('2');
        assert.equal(await page.evaluate(() => fixture.job.continuation.delayMinutes), 3);
        assert.equal(await page.evaluate(() => fixture.job.continuation.recoveryDelayMinutes), 2);
        await page.getByRole('button', { name: 'Remove fallback C2', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => fixture.job.continuation.runnerIds), ['pool:route/SAIFREN']);
      });
      await check(`${name}: job continuation toggle really changes the existing policy`, async () => {
        const toggle = page.locator('#schedule [role="switch"]').first();
        await toggle.click();
        assert.equal(await page.evaluate(() => fixture.job.continuation.enabled), false);
        assert.equal(await page.getByRole('combobox', { name: 'Add fallback runner' }).count(), 0);
        await toggle.click();
        assert.equal(await page.evaluate(() => fixture.job.continuation.enabled), true);
      });
      await page.screenshot({ path: `${PREFIX}-${name.replaceAll('/', '-')}.png`, fullPage: true });
      await context.close();
    }
    await check('no browser runtime or console errors', async () => assert.deepEqual(errors, []));
    const report = { at: new Date().toISOString(), url: URL, passed: results.filter(r => r.pass).length, failed: results.filter(r => !r.pass).length, errors, results };
    fs.writeFileSync(`${PREFIX}.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
    if (report.failed) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 2; });
