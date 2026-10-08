const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const requireProject = createRequire(path.join(root, 'zcode/package.json'));
const { chromium } = requireProject('playwright-core');
const original = process.argv.includes('--original');
const out = path.join(root, '.saipen/evidence/T-274-ui-' + (original ? 'original' : 'fixed'));
fs.mkdirSync(out, { recursive: true });
(async () => {
  const { createServer } = await import(pathToFileURL(requireProject.resolve('vite')).href);
  const react = (await import(pathToFileURL(requireProject.resolve('@vitejs/plugin-react')).href)).default;
  const tailwind = (await import(pathToFileURL(requireProject.resolve('@tailwindcss/vite')).href)).default;
  const subject = path.join(root, 'zcode/packages/ui/src');
  const server = await createServer({ configFile: false, root: path.join(root, '.saipen/evidence/t274-ui'),
    plugins: [react(), tailwind(), ...(original ? [{ name: 'original-subject', enforce: 'pre', load(id) {
      const clean = id.split('?')[0]; const relative = path.relative(root, clean);
      const before = path.join(root, '.saipen/evidence/T-274-original', relative);
      if (clean.includes('packages/ui/src') && fs.existsSync(before)) return fs.readFileSync(before, 'utf8');
    }}] : [])],
    resolve: { alias: { '@': subject, 'react': path.join(root, 'zcode/node_modules/react'), 'react-dom': path.join(root, 'zcode/node_modules/react-dom') }, dedupe: ['react', 'react-dom'] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    define: { __ZCODE_VERSION__: '"0.0.3"', __ZCODE_COMMIT__: '"fixture"', __ZCODE_ENV__: '"test"', __ZCODE_PRODUCT_FLAVOR__: '"zaicode"', 'process.env': '{}' },
    optimizeDeps: { include: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
  });
  let browser; const checks = [], errors = [];
  async function check(name, action) { try { await action(); checks.push({ name, pass: true }); } catch (error) { checks.push({ name, pass: false, error: error.message }); } }
  try {
    await server.listen();
    browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    page.setDefaultTimeout(7000);
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle', timeout: 90000 });
    await page.locator('[data-zaicode-router-pools]').waitFor();
    await page.locator('[data-zaicode-router-pool="SAIFREN"]').getByRole('button', { name: /SAIFREN$/, exact: false }).first().click();
    const rows = (scope) => page.locator(scope + ' [data-model-provider-model-id]');
    async function drag(scope, from, to) {
      const a = rows(scope).nth(from), b = rows(scope).nth(to); await a.evaluate((el) => el.closest('section, [data-zaicode-router-pools], [data-zaicode-dispatch-settings]').scrollIntoView({ block: 'center' }));
      const ab = await a.boundingBox(), bb = await b.boundingBox();
      await page.mouse.move(ab.x + (scope.includes('dispatch') ? 7 : Math.min(160, ab.width / 3)), ab.y + ab.height / 2);
      await page.mouse.down(); await page.mouse.move(ab.x + 10, ab.y + ab.height / 2 + 9, { steps: 3 });
      await page.mouse.move(bb.x + (scope.includes('dispatch') ? 7 : 100), bb.y + bb.height / 2, { steps: 12 }); await page.waitForTimeout(150); await page.mouse.up(); await page.waitForTimeout(350);
    }
    await check('pool pointer reorder persisted through router write and readback', async () => { assert.equal(await rows('[data-zaicode-router-pools]').count(), 3); await drag('[data-zaicode-router-pools]', 2, 0); assert.equal(await rows('[data-zaicode-router-pools]').first().getAttribute('data-model-provider-model-id'), 'free/third'); assert.deepEqual(await page.evaluate(() => window.writes[0].body.models), ['free/third','free/first','free/second']); });
    await check('pool font is at least the UI base size', async () => { const size = await page.locator('[data-zaicode-router-pools]').evaluate((el) => parseFloat(getComputedStyle(el).fontSize)); assert.ok(size >= 14, `font ${size}`); });
    await check('pool keyboard reorder', async () => { const first = rows('[data-zaicode-router-pools]').first(); await first.focus(); await page.keyboard.press('Space'); await page.waitForTimeout(120); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(120); await page.keyboard.press('Space'); await page.waitForTimeout(350); assert.equal(await rows('[data-zaicode-router-pools]').nth(1).getAttribute('data-model-provider-model-id'), 'free/third'); });
    await check('fallback pointer reorder', async () => { assert.equal(await rows('#fallback').count(), 3); await drag('#fallback', 2, 0); assert.equal(await rows('#fallback').first().getAttribute('data-model-provider-model-id'), 'c2'); });
    await check('Dispatch pointer reorder keeps launcher edits interactive', async () => { const before = await rows('[data-zaicode-dispatch-settings]').first().getAttribute('data-model-provider-model-id'); await drag('[data-zaicode-dispatch-settings]', 1, 0); assert.notEqual(await rows('[data-zaicode-dispatch-settings]').first().getAttribute('data-model-provider-model-id'), before); const input = page.locator('[data-zaicode-dispatch-settings] input[aria-label="Name"]').first(); await input.fill('Edited without dragging'); assert.equal(await input.inputValue(), 'Edited without dragging'); });
    await check('queue drag uses the existing adjacent reorder owner', async () => { assert.equal(await rows('#queue').count(), 3); await drag('#queue', 2, 0); assert.equal(await rows('#queue').first().getAttribute('data-model-provider-model-id'), 'job-3'); });
    const viewport = page.getByTestId('bash-output-scroll');
    await check('Full retains real inner scrolling without fading output', async () => { const result = await viewport.evaluate((el) => ({ overflow: el.scrollHeight > el.clientHeight, mask: getComputedStyle(el).maskImage })); assert.equal(result.overflow, true); assert.equal(result.mask, 'none'); });
    await check('Full without scroll exposes the entire real output height', async () => { await page.locator('[data-transcript-choice="full-unbounded"]').click(); await page.waitForTimeout(400); const height = await viewport.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, max: getComputedStyle(el).maxHeight })); assert.equal(height.scroll, height.client); assert.equal(height.max, 'none'); assert.ok(height.client > 1900); });
    await check('unbounded streaming keeps the latest output', async () => { await page.locator('#stream').click(); assert.ok((await viewport.textContent()).includes('stream-1')); });
    await check('transparent modal preserves input blocking', async () => { const under = await page.locator('#underlying').boundingBox(); await page.locator('#modal').click(); const overlay = page.locator('[data-slot="dialog-overlay"]'); await overlay.waitFor(); assert.equal(await overlay.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)'); await page.mouse.click(under.x + 5, under.y + 5); assert.equal(await page.locator('#underlying').textContent(), 'Underlying 0'); });
    await page.screenshot({ path: path.join(out, 'final.png'), fullPage: true });
  } finally { if (browser) await browser.close(); await server.close(); }
  fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ original, checks, errors }, null, 2));
  console.log(JSON.stringify({ original, checks, errors }, null, 2));
  if (checks.some((c) => !c.pass) || errors.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
