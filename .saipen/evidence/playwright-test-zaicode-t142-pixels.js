const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = process.env.ZAICODE_TEST_ROOT || 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode';
const ts = require(require.resolve('typescript', { paths: [ROOT] }));
const source = fs.readFileSync(process.env.ZAICODE_PIXEL_SUBJECT || path.join(ROOT, 'packages/ui/src/zaicode/zaicodePixelSnap.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const OUT = path.resolve(ROOT, '../.saipen/evidence/T-142-pixels');
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: false });
  const results = [];
  try {
    for (const ratio of [1, 1.25, 1.5, 2]) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: ratio });
      const page = await context.newPage();
      await page.setContent('<style>body{margin:0}#outer{width:301px;margin:auto;background:#332e22;color:#d4c89a}#inner{width:100px;margin:auto}</style><div data-workspace-shell="true"><div id="outer" data-zaicode-pixel-snap><div id="inner" data-zaicode-pixel-snap>Pixel text</div></div></div>');
      await page.evaluate(code => { const exports = {}; new Function('exports', code)(exports); window.stopSnap = exports.installZaicodePixelSnap(); }, code);
      const measure = () => page.locator('[data-zaicode-pixel-snap]').evaluateAll(elements => elements.map(e => ({ x: e.getBoundingClientRect().left * devicePixelRatio, translate: getComputedStyle(e).translate })));
      await page.bringToFront();
      await page.waitForFunction(() => [...document.querySelectorAll('[data-zaicode-pixel-snap]')].every(e => Math.abs(e.getBoundingClientRect().left * devicePixelRatio - Math.round(e.getBoundingClientRect().left * devicePixelRatio)) < .03 && getComputedStyle(e).translate === 'none'), null, { timeout: 1000 });
      for (const v of await measure()) { assert.ok(Math.abs(v.x - Math.round(v.x)) < .03, `${ratio}: ${JSON.stringify(v)}`); assert.equal(v.translate, 'none', 'text correction must not composite a translated bitmap'); }
      // The shell remains unchanged in size: the inner layout update must still snap promptly.
      await page.evaluate(() => { document.querySelector('#outer').style.width = '303px'; const late = document.createElement('div'); late.id = 'late'; late.style.cssText = 'width:99px;margin:auto'; late.dataset.zaicodePixelSnap = ''; late.textContent = 'Late column'; document.querySelector('#outer').append(late); });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-zaicode-pixel-snap]')].every(e => Math.abs(e.getBoundingClientRect().left * devicePixelRatio - Math.round(e.getBoundingClientRect().left * devicePixelRatio)) < .03), null, { timeout: 500 });
      for (const v of await measure()) assert.ok(Math.abs(v.x - Math.round(v.x)) < .03, `late ${ratio}: ${JSON.stringify(v)}`);
      await page.evaluate(() => window.stopSnap());
      const restored = await page.locator('[data-zaicode-pixel-snap]').evaluateAll(elements => elements.map(e => [e.style.left, e.style.top, e.style.position]));
      assert.deepEqual(restored, [['', '', ''], ['', '', ''], ['', '', '']]);
      results.push({ ratio, mountedAndResized: true, lateMount: true, cleanup: true });
      await context.close();
    }
    fs.writeFileSync(path.join(OUT, 'receipt.json'), JSON.stringify({ ok: true, results }, null, 2));
    console.log(JSON.stringify({ ok: true, results }));
  } finally { await browser.close(); }
})().catch(error => { fs.writeFileSync(path.join(OUT, 'failure.txt'), String(error.stack || error)); console.error(error); process.exitCode = 1; });
