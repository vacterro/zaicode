const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = 'V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE';
const { _electron } = createRequire(path.join(root, 'zcode/package.json'))('playwright-core');
const executablePath = process.env.T258_EXE || path.join(root, 'zcode/packages/desktop/dist-t258/win-unpacked/ZAICODE.exe');
const out = process.env.T258_OUT || path.join(root, '.saipen/evidence/T-258-transcript/fixed');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'zaicode-t258-profile-'));
fs.mkdirSync(out, { recursive: true });
let app, page, stage = 'launch', inferenceCount = 0;
const checks = [], errors = [], requests = [];
let nodes = [], connections = [], combos = [{ id: 'free', name: 'SAIFREN', models: ['fixture/model'] }, { id: 'own', name: 'SAIOPP', models: [] }];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (name, pass, detail) => { checks.push({ name, pass: Boolean(pass), detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`); };
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url;
    let data = {};
    if (url === '/api/health') data = { status: 'ok' };
    else if (url === '/api/keys') data = req.method === 'POST' ? { key: 'fixture-router-key' } : { keys: [{ key: 'fixture-router-key', isActive: true }] };
    else if (url === '/api/provider-nodes') { if (req.method === 'POST') { const node = { ...body, id: 'node-' + nodes.length }; nodes.push(node); data = { node }; } else data = { nodes }; }
    else if (url === '/api/providers') { if (req.method === 'POST') { const connection = { ...body, id: 'connection-' + connections.length, isActive: true }; connections.push(connection); data = { connection }; } else data = { connections }; }
    else if (url === '/api/combos') { if (req.method === 'POST') { const combo = { ...body, id: 'combo-' + combos.length }; combos.push(combo); data = { combo }; } else data = { combos }; }
    else if (url.startsWith('/api/combos/') && req.method === 'PUT') { const id = url.split('/').pop(); combos = combos.map(c => c.id === id ? { ...c, ...body } : c); data = { combo: combos.find(c => c.id === id) }; }
    else if (/\/v1\/(chat\/completions|responses)/.test(url)) {
      // Router discovery sends token probes before the real CLI task. Serve
      // those independently so they cannot advance the conversation fixture.
      if (!body.stream || !body.tools?.length) {
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: 'Fixture ready.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        } else {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ id: 'probe', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture ready.' }, finish_reason: 'stop' }] }));
        }
        return;
      }
      const n = ++inferenceCount;
      const toolNames = (body.tools || []).map(tool => tool.function?.name || tool.name);
      requests.push({ url, n, model: body.model, stream: body.stream, toolNames });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const write = (delta, finish = null) => res.write('data: ' + JSON.stringify({ id: 't258-' + n, object: 'chat.completion.chunk', created: 1, model: 'SAIFREN', choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
      write({ role: 'assistant', reasoning_content: 'T258 thought detail marker.' });
      if (n === 1) {
        const name = toolNames.find(value => /^(bash|shell)$/i.test(value)) || toolNames.find(value => /bash|shell/i.test(value));
        if (!name) throw new Error('No shell tool in fixture request: ' + JSON.stringify(toolNames));
        write({ content: 'T258 before tool narrative.' });
        const command = 'printf ' + JSON.stringify('T258 tool detail marker'.split('').map(c => '\\x' + c.charCodeAt(0).toString(16)).join('')) + '; exit 17';
        write({ tool_calls: [
          { index: 0, id: 't258-shell', type: 'function', function: { name, arguments: JSON.stringify({ command, description: 'Transcript fixture output', timeout: 10000 }) } },
          // A nonzero shell exit is a successful tool invocation in the CLI
          // protocol. Missing-file Read supplies an actual status=error row.
          { index: 1, id: 't258-read', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: path.join(profile, 'missing-transcript-file.txt') }) } },
        ] });
        write({}, 'tool_calls');
      } else if (n === 2) {
        write({ content: 'T258 final narrative.' }); write({}, 'stop');
      } else {
        write({ content: 'T258 streamed start. ' });
        await pause(900);
        write({ content: 'T258 streamed end.' }); write({}, 'stop');
      }
      res.end('data: [DONE]\n\n'); return;
    } else if (url === '/v1/models') data = { data: [{ id: 'SAIFREN', object: 'model' }] };
    else if (url === '/api/settings') data = { settings: {} };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
  } catch (error) { errors.push('fixture: ' + error); if (!res.headersSent) res.writeHead(500); res.end(); }
});
const launch = async env => {
  app = await _electron.launch({ executablePath, args: ['--user-data-dir=' + profile], env, timeout: 90000 });
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'));
  check('app owns isolated profile', path.resolve(actualProfile) === path.resolve(profile), actualProfile);
  const deadline = Date.now() + 90000;
  while (!page && Date.now() < deadline) { page = app.windows().find(w => w.url().includes('/out/renderer/index.html')); if (!page) await pause(150); }
  if (!page) throw new Error('No renderer');
  page.on('pageerror', error => errors.push(String(error)));
  await page.locator('[data-workspace-shell=true]').waitFor({ timeout: 90000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/out/renderer/index.html')).setContentSize(1200, 850));
  await page.setViewportSize({ width: 1200, height: 850 });
};
const modeButton = mode => page.locator(`[data-transcript-choice="${mode}"]:visible`).first();
const selectMode = async mode => {
  await modeButton(mode).click();
  await page.waitForFunction(mode => document.querySelector(`[data-transcript-choice="${mode}"]`)?.getAttribute('aria-pressed') === 'true', mode);
};
const layer = () => page.locator('[data-v4-timeline-message-layer=true]:visible').first();
const readText = () => layer().innerText();
const send = async text => {
  const editor = page.locator('[contenteditable=true]:visible').first();
  await editor.focus(); await editor.press('Control+A'); await editor.press('Backspace'); await page.keyboard.insertText(text);
  await page.locator('[data-testid="chat-send-button"]:visible,[data-testid="v4-composer-send"]:visible').first().click();
};
(async () => {
  const receipt = { ticket: 'T-258', executablePath, profile, checks };
  try {
    server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const TARGET_URL = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(profile, 'zaicode-engines.json'), JSON.stringify({ keepWindowsRolling: false }));
    fs.writeFileSync(path.join(profile, 'zaicode-router-host.json'), JSON.stringify({ mode: 'shared', port: 20148 }));
    const credential = path.join(profile, 'AppData/Roaming/9router'); fs.mkdirSync(path.join(credential, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(credential, 'machine-id'), 'isolated-fixture-machine'); fs.writeFileSync(path.join(credential, 'auth/cli-secret'), 'isolated-fixture-secret');
    const env = { ...process.env, ZCODE_DESKTOP_APPLICATION_NAME: 'T258 fixture ' + path.basename(profile), ZCODE_DESKTOP_HOME_DIR: profile,
      ZCODE_DESKTOP_USER_DATA_DIR: profile, ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, 'session'), ZCODE_DATA_BASE_DIR: profile,
      ZCODE_HOME: path.join(profile, '.zcode'), HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'),
      LOCALAPPDATA: path.join(profile, 'AppData/Local'), ZCODE_ZAICODE_MODE: '1', ZAICODE_UPDATES: 'off', ZAICODE_ROUTER_URL: TARGET_URL, SAIPEN_HOME: '' };
    for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW|ELECTRON_RUN_AS_NODE|SAIMAIL_WORKSPACE|ZAICODE_INSTALL_ROOT)/i.test(key)) delete env[key];
    delete env.TZ;
    await launch(env);
    await page.evaluate(() => {
      localStorage.setItem('zcode-locale-preference', 'en-US');
      localStorage.setItem('zaicode-ui-prefs-v1', JSON.stringify({ transcriptView: 'compact', autoRetry: false, saimailOnHome: false, saimailRev: 1, homeRev: 2 }));
    });
    await page.reload(); await page.locator('[data-workspace-shell=true]').waitFor();
    stage = 'open-project';
    const project = path.join(profile, 'transcript-fixture'); fs.mkdirSync(project, { recursive: true });
    await app.evaluate(({ dialog }, folder) => { dialog.__original = dialog.showOpenDialog; dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await page.getByTestId('project-add').click(); await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click();
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = dialog.__original; delete dialog.__original; });
    const projectRow = page.locator('[data-testid^="workspace-item"]').filter({ hasText: 'transcript-fixture' }).first();
    await projectRow.waitFor({ state: 'visible' }); await projectRow.click();
    await page.locator('[contenteditable=true]:visible').first().waitFor();
    const autoGoal = page.getByRole('button', { name: /Auto-Goal on/ }).filter({ visible: true }).first(); if (await autoGoal.count()) await autoGoal.click();
    check('composer remains reachable', await page.locator('[contenteditable=true]:visible').first().isVisible());
    const hasControl = await page.locator('[data-transcript-control=true]:visible').count() > 0;
    check('visible named three-choice Transcript control', hasControl && await page.locator('[data-transcript-choice]:visible').count() === 3);
    stage = 'fixture-run';
    await send('T258 user narrative.');
    await page.getByText('T258 final narrative.', { exact: false }).first().waitFor({ timeout: 60000 });
    check('actual fixture run reaches final narrative', inferenceCount >= 2 && await page.getByText('T258 final narrative.', { exact: false }).first().isVisible(), requests);
    if (hasControl) {
      stage = 'full'; await selectMode('full');
      await page.waitForFunction(() => document.querySelector('[data-v4-timeline-message-layer=true]')?.innerText.includes('T258 before tool narrative.'));
      let text = await readText();
      check('Full reveals intermediate and final narrative in order', text.indexOf('T258 before tool narrative.') >= 0 && text.indexOf('T258 before tool narrative.') < text.indexOf('T258 final narrative.'), text);
      check('Full exposes actual shell output', text.includes('T258 tool detail marker'), text);
      check('Full exposes actual reasoning detail', text.includes('T258 thought detail marker.'), text);
      await page.screenshot({ path: path.join(out, 'full.png') });
      stage = 'text'; await selectMode('only-text');
      await page.waitForFunction(() => !document.querySelector('[data-v4-timeline-message-layer=true]')?.innerText.includes('T258 thought detail marker.'));
      text = await readText();
      check('Only text retains all narrative in original order', text.includes('T258 user narrative.') && text.indexOf('T258 before tool narrative.') >= 0 && text.indexOf('T258 before tool narrative.') < text.indexOf('T258 final narrative.'), text);
      check('Only text hides thoughts and shell detail', !text.includes('T258 thought detail marker.') && !text.includes('T258 tool detail marker'), text);
      check('Only text retains essential failed-tool alert', await page.getByRole('alert').filter({ hasText: 'Tool failed:' }).count() === 1);
      check('mode is written by preference owner', await page.evaluate(() => JSON.parse(localStorage.getItem('zaicode-ui-prefs-v1')).transcriptView) === 'only-text');
      stage = 'stream'; await send('T258 streaming user.');
      await page.getByText('T258 streamed end.', { exact: false }).first().waitFor({ timeout: 45000 });
      text = await readText();
      check('Only text applies to new streamed rows', text.includes('T258 streamed start.') && text.includes('T258 streamed end.') && !text.includes('T258 thought detail marker.'), text);
      await page.screenshot({ path: path.join(out, 'only-text.png') });
      stage = 'keyboard'; await modeButton('compact').focus(); await modeButton('compact').press('Enter');
      check('Compact is keyboard selectable', await modeButton('compact').getAttribute('aria-pressed') === 'true');
      stage = 'compact'; text = await readText();
      check('Compact restores closed disclosure after Full', !text.includes('T258 tool detail marker'), text);
      stage = 'narrow';
      const dismiss = page.getByRole('button', { name: 'Dismiss all', exact: true }).filter({ visible: true });
      if (await dismiss.count()) await dismiss.first().click();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('/out/renderer/index.html')).setContentSize(640, 540));
      await page.setViewportSize({ width: 640, height: 540 });
      await page.waitForFunction(() => {
        const node = document.querySelector('[data-transcript-choice="compact"]');
        if (!node) return false;
        const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return (hit === node || node.contains(hit)) && r.right <= innerWidth;
      });
      for (const mode of ['compact', 'full', 'only-text']) {
        const reach = await modeButton(mode).evaluate(node => { const r = node.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { hit: hit === node || node.contains(hit), x: r.x, right: r.right, viewport: innerWidth }; });
        check('640px button reachable: ' + mode, reach.hit && reach.x >= 0 && reach.right <= reach.viewport, reach);
      }
      await selectMode('only-text'); await page.screenshot({ path: path.join(out, 'narrow.png') });
      stage = 'reload'; await page.reload(); await modeButton('only-text').waitFor({ state: 'visible', timeout: 45000 });
      check('preference survives actual renderer reload', await modeButton('only-text').getAttribute('aria-pressed') === 'true');
    }
    check('zero renderer and fixture errors', errors.length === 0, errors);
    receipt.pass = checks.every(c => c.pass);
  } catch (error) {
    receipt.pass = false; receipt.error = String(error.stack || error); receipt.stage = stage;
    if (page) { await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(out, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  } finally {
    receipt.errors = errors; receipt.requests = requests; receipt.paidVendorRequests = 0;
    const asar = path.join(path.dirname(executablePath), 'resources/app.asar'); if (fs.existsSync(asar)) receipt.asarSha256 = crypto.createHash('sha256').update(fs.readFileSync(asar)).digest('hex');
    receipt.verifierSha256 = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
    if (app) await app.close().catch(() => {}); server.closeAllConnections(); server.close();
  }
  console.log(JSON.stringify({ pass: receipt.pass, checks: checks.length, stage: receipt.stage, error: receipt.error }));
  if (!receipt.pass) process.exitCode = 1;
})();
