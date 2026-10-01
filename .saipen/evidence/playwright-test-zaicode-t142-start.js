const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const ROOT = process.env.ZAICODE_TEST_ROOT || 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode';
const ui = path.join(ROOT, 'packages/ui/src');
const OUT = path.resolve(ROOT, '../.saipen/evidence/T-142-start-browser');
const esbuild = require(require.resolve('esbuild', { paths: [ROOT] }));
const importPath = p => JSON.stringify(path.join(ui, p).replace(/\\/g, '/'));
(async () => {
  const result = await esbuild.build({ absWorkingDir: ROOT, write: false, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"', 'process.platform': '"win32"' }, alias: { '@': ui }, plugins: [{ name: 'owner-fixture', setup(build) {
    if (process.env.ZAICODE_START_SUBJECT) build.onLoad({ filter: /ZaicodeSaipenControls\.tsx$/ }, () => ({ contents: fs.readFileSync(process.env.ZAICODE_START_SUBJECT, 'utf8'), loader: 'tsx' }));
    build.onLoad({ filter: /useWorkspaceServices\.tsx$/ }, () => ({ contents: `const services = {fileService:{readTextFile:async ({path}) => ({content:path.endsWith('STATE.md') ? '---\\nphase: DONE\\ntask: none\\nnext_action: saipen status\\nblocker: none\\n---' : path.endsWith('BOARD.md') ? '## DOING\\n## TODO\\n## DONE\\n## BLOCKED' : ''})}}; export function useWorkspaceServices(){return services}`, loader: 'js' }));
  } }], stdin: { resolveDir: ROOT, loader: 'tsx', contents: `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { ZaicodeSaipenControls } from ${importPath('prompt-editor/ZaicodeSaipenControls.tsx')};
import { useZaicodeMainSessions } from ${importPath('zaicode/zaicodeMainSession.ts')};
import { useZaicodeFreshSession } from ${importPath('zaicode/zaicodeSaipen.ts')};
import { useZaicodeComposerPrefs } from ${importPath('zaicode/zaicodeComposerPrefs.ts')};
window.calls = [];
useZaicodeMainSessions.getState().setMain('fixture', 'original-main');
useZaicodeFreshSession.setState({open: (...args) => window.calls.push(['fresh', ...args])});
window.mainOf = () => useZaicodeMainSessions.getState().byWorkspace['fixture'];
window.setLayout = compact => useZaicodeComposerPrefs.getState().update({compact});
createRoot(document.getElementById('root')).render(<ZaicodeSaipenControls workspacePath="fixture" sessionId="current-session" disabled={false} onCommand={command => window.calls.push(['current', command])}/>);
` } });
  const browser = await chromium.launch({ headless: false });
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  try {
    const page = await browser.newPage();
    await page.route('http://zaicode-test.local/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://zaicode-test.local/');
    const errors = []; page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.addScriptTag({ content: result.outputFiles[0].text });
    await page.locator('[data-zaicode-saipen-strip]').waitFor();
    for (const compact of [true, false]) {
      await page.evaluate(compact => window.setLayout(compact), compact);
      const button = page.locator('[data-zaicode-sound="saipen.start"]');
      await button.click({ modifiers: ['Shift'] });
      assert.deepEqual(await page.evaluate(() => window.calls), [['current', '/goal cc all']]);
      assert.equal(await page.evaluate(() => window.mainOf()), 'original-main');
      assert.match(await button.getAttribute('title'), /Shift\+click.*current session/);
      await page.evaluate(() => { window.calls = []; });
      await button.click();
      assert.deepEqual(await page.evaluate(() => window.calls), [['fresh', 'fixture', undefined, '/goal cc all']]);
      await page.evaluate(() => { window.calls = []; });
      results.push({ compact, shiftedCurrent: true, mainPreserved: true, plainFresh: true });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(OUT, 'receipt.json'), JSON.stringify({ ok: true, results }, null, 2));
    console.log(JSON.stringify({ ok: true, results }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
