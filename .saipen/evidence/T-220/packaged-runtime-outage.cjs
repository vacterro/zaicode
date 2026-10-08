const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const repo = path.join(root, 'zcode');
const requireRepo = require('module').createRequire(path.join(repo, 'package.json'));
const { _electron } = requireRepo('playwright-core');
const distName = process.env.T220_DIST_NAME || 'dist-t220';
const exe = path.join(repo, 'packages/desktop', distName, 'win-unpacked/ZAICODE.exe');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(__dirname, `packaged-outage-${runId}`);
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync('V:/_TEMP_/t220-outage-');
const preferredPort = 29220, fallbackPort = 29221;
const packageDir = path.join(path.dirname(exe), 'resources/router/9router');
const sharedData = path.join(profile, 'AppData/Roaming/9router');
const fallbackData = path.join(profile, 'router');
const checks = {}, observations = [], errors = [], inference = [];
const objectiveMarker = 'T220_KEEP_THIS_PROJECT_SESSION_CONTINUOUS';
let app, page, preferred, unavailable, stage = 'setup', keySequence = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const vendor = http.createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  const body = text ? JSON.parse(text) : {};
  const messages = JSON.stringify(body.messages || body.input || []);
  const marker = [...messages.matchAll(/CONTINUITY_[ABC]/g)].at(-1)?.[0] || 'BOOT';
  inference.push({ at: new Date().toISOString(), marker, stream: !!body.stream, model: body.model, hasObjective: messages.includes(objectiveMarker), messageMarkers: [...new Set([...messages.matchAll(/CONTINUITY_[ABC]/g)].map(match => match[0]))] });
  const answer = `LOCAL_${marker}_ANSWER`;
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'local', object: 'chat.completion', created: 1, model: body.model || 'local', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
  }
});
const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), ZCODE_DESKTOP_APPLICATION_NAME: `T220 ${path.basename(profile)}`, ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DESKTOP_USER_DATA_DIR: profile, ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, 'session'), ZCODE_DATA_BASE_DIR: profile, ZCODE_HOME: path.join(profile, '.zcode'), ZCODE_ZAICODE_MODE: '1', ZCODE_ZAICODE_IDENTITY: '1', ZAICODE_UPDATES: 'off', ZAICODE_ROUTER_URL: `http://127.0.0.1:${preferredPort}`, ZAICODE_ROUTER_PACKAGE: packageDir, ZAICODE_INSTALL_ROOT: root, SAIPEN_HOME: '', ZAICODE_CUSTOMIZATION_DIR: path.join(profile, 'customization') };
for (const name of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ELECTRON_RUN_AS_NODE|SAIMAIL_WORKSPACE|TZ)/i.test(name)) delete env[name];
function credentials(dir) {
  fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'machine-id'), 't220-isolated-machine');
  fs.writeFileSync(path.join(dir, 'auth/cli-secret'), 't220-isolated-secret');
}
const token = require('node:crypto').createHash('sha256').update('t220-isolated-machine9r-cli-autht220-isolated-secret').digest('hex').slice(0, 16);
async function call(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'x-9r-cli-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
function startRouter(port, dataDir) {
  credentials(dataDir);
  const log = fs.openSync(path.join(out, `router-${port}.log`), 'a');
  const child = spawn(exe, [path.join(packageDir, 'app/custom-server.js')], { cwd: path.join(packageDir, 'app'), env: { ...env, ELECTRON_RUN_AS_NODE: '1', DATA_DIR: dataDir, PORT: String(port), HOSTNAME: '127.0.0.1' }, stdio: ['ignore', log, log], windowsHide: true });
  fs.closeSync(log);
  return child;
}
async function ready(port) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) return;
    await wait(500);
  }
  throw new Error(`Router ${port} did not become ready`);
}
async function seed(port) {
  // Prefixes satisfy the real free-pool setup contract, but every upstream is our loopback vendor.
  const models = [];
  for (const prefix of ['local', 'kilo', 'pol', 'llm7']) {
    const made = await call(port, 'POST', '/api/provider-nodes', { type: 'openai-compatible', name: `Local ${prefix}`, prefix, apiType: 'chat', baseUrl: `http://127.0.0.1:${vendor.address().port}/v1` });
    const id = made.node?.id || made.id;
    assert.ok(id, JSON.stringify(made));
    await call(port, 'POST', '/api/providers', { provider: id, apiKey: 'local-fixture-only', name: `Local ${prefix}` });
    if (prefix === 'local') models.push('local/fixture');
  }
  await call(port, 'POST', '/api/combos', { name: 'SAIFREN', models });
  await call(port, 'POST', '/api/combos', { name: 'SAIOPP', models: [] });
  await call(port, 'POST', '/api/keys', { name: `T220-${++keySequence}` });
}
function inferenceFor(marker) {
  const request = [...inference].reverse().find(item => item.marker === marker);
  assert.ok(request, `the real app inference request ${marker} reached the isolated loopback vendor`);
  return request;
}
async function stopRouterTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32') {
    execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else child.kill('SIGTERM');
  await Promise.race([exited, wait(10000)]);
}
async function listenUnavailable(port) {
  const server = http.createServer((request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"isolated outage sentinel"}');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
async function activeTaskId() {
  const item = page.locator('#sidebar li[data-testid^="task-item-"]').first();
  if (await item.count()) return (await item.getAttribute('data-testid')).replace(/^task-item-/, '');
  return null;
}
async function sendUiPrompt(marker) {
  const objectiveText = marker === 'CONTINUITY_A'
    ? `Project objective: ${objectiveMarker}.`
    : 'Continue the established project objective from earlier in this same task.';
  const prompt = `${objectiveText} Reply only with LOCAL_${marker}_ANSWER. ${marker}`;
  const input = page.getByTestId('v4-composer-input');
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.evaluate((element, value) => {
    const bridge = element.__zcodeLexicalInputE2E;
    if (!bridge || element.getAttribute('data-e2e-lexical-bridge') !== 'ready') throw new Error('real Lexical E2E input bridge is unavailable');
    bridge.setText(value);
  }, prompt);
  const sendButton = page.getByTestId('v4-composer-send');
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="v4-composer-send"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  }, null, { timeout: 30000 });
  await sendButton.click();
  await page.getByText(`LOCAL_${marker}_ANSWER`, { exact: true }).waitFor({ state: 'visible', timeout: 180000 });
  await page.waitForFunction(() => Boolean(document.querySelector('#sidebar li[data-testid^="task-item-"]')),
    null, { timeout: 30000 });
  const task = await activeTaskId();
  assert.ok(task, `${marker}: submitted app prompt did not create a visible real task row`);
  const request = inferenceFor(marker);
  assert.equal(request.model, 'fixture', `${marker}: app request used the isolated local fixture route`);
  return { task, host: await page.evaluate(() => window.zcode.getZaicodeRouterHost()), request };
}
async function record(label) {
  const host = await page.evaluate(() => window.zcode.getZaicodeRouterHost());
  const ui = await page.locator('[data-zaicode-router-supervisor]').evaluateAll(nodes => nodes.map(node => ({ status: node.getAttribute('data-zaicode-router-supervisor'), text: node.textContent })));
  const task = await activeTaskId();
  observations.push({ at: new Date().toISOString(), label, task, host, ui });
  return { task, host, ui };
}
async function main() {
  const busy = execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in ${preferredPort},${fallbackPort} }).Count`], { encoding: 'utf8' }).trim();
  assert.equal(busy, '0', 'isolated router ports are unused');
  for (const dir of [profile, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(profile, 'zaicode-engines.json'), JSON.stringify({ keepWindowsRolling: false }));
  fs.writeFileSync(path.join(profile, 'zaicode-router-host.json'), JSON.stringify({ mode: 'shared', port: fallbackPort }));
  await new Promise(resolve => vendor.listen(0, '127.0.0.1', resolve));
  let seedFallback;
  try {
    stage = 'real-router-seed';
    preferred = startRouter(preferredPort, sharedData); await ready(preferredPort); await seed(preferredPort);
    seedFallback = startRouter(fallbackPort, fallbackData); await ready(fallbackPort); await seed(fallbackPort);
    seedFallback.kill(); await new Promise(resolve => seedFallback.once('exit', resolve)); seedFallback = null;
    stage = 'packaged-launch';
    app = await _electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`], env, timeout: 90000 });
    assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(profile));
    for (let n = 0; n < 180 && !page; n++) { page = app.windows().find(p => p.url().includes('/out/renderer/index.html')); if (!page) await wait(500); }
    assert.ok(page); page.on('pageerror', error => errors.push(String(error)));
    await page.locator('[data-workspace-shell=true]').waitFor({ timeout: 90000 });
    const identity = await page.evaluate(async () => { const proxy = await window.zcode.getZaicodeSubscriptionProxy(); const response = await fetch(`${proxy.url}/runtime-identity`, { headers: { authorization: `Bearer ${proxy.token}` } }); return response.json(); });
    const sidecar = JSON.parse(fs.readFileSync(path.join(path.dirname(exe), 'resources/build-meta.json'), 'utf8'));
    assert.equal(identity.sourceRevision, sidecar.sourceRevision); assert.equal(identity.runtimePackageIdentity, sidecar.runtimePackageIdentity); assert.equal(identity.updateChannel, 'test');
    checks.packagedIdentity = identity;
    stage = 'project';
    const project = path.join(profile, 'continuity-project'); fs.mkdirSync(project, { recursive: true });
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await page.getByTestId('project-add').click(); await page.getByRole('menuitem', { name: 'Open folder', exact: true }).click();
    const projectRow = page.getByTestId(`workspace-item-${project}`);
    await projectRow.waitFor({ state: 'visible', timeout: 30000 });
    await projectRow.click();
    await page.getByTestId('v4-composer-input').waitFor({ state: 'visible', timeout: 30000 });
    const autoGoal = page.getByTestId('zaicode-auto-goal');
    if (await autoGoal.getAttribute('data-zaicode-auto-goal') === 'on') await autoGoal.click();
    stage = 'preferred-inference';
    const firstSend = await sendUiPrompt('CONTINUITY_A');
    const before = await record('before-outage');
    assert.equal(before.task, firstSend.task);
    assert.equal(firstSend.request.hasObjective, true);
    checks.preferredInference = { task: before.task, host: firstSend.host, request: firstSend.request };
    stage = 'actual-refusal'; await stopRouterTree(preferred); preferred = null;
    checks.endpointRefused = await fetch(`http://127.0.0.1:${preferredPort}/api/health`, { signal: AbortSignal.timeout(1000) }).then(() => false).catch(error => /ECONNREFUSED/.test(String(error.cause)));
    assert.equal(checks.endpointRefused, true);
    const recoverySamples = [];
    let sampling = false;
    const sampler = setInterval(async () => {
      if (sampling || !page) return;
      sampling = true;
      try { recoverySamples.push(await page.evaluate(() => window.zcode.getZaicodeRouterHost())); } catch {} finally { sampling = false; }
    }, 500);
    stage = 'bounded-recovery-and-fallback';
    let fallbackSend;
    try { fallbackSend = await sendUiPrompt('CONTINUITY_B'); } finally { clearInterval(sampler); }
    checks.recoveryAttempts = recoverySamples.map(sample => sample.supervisor?.attempts ?? 0).filter(Boolean);
    checks.intermediateRecoveryObserved = recoverySamples.some(sample => sample.supervisor?.status === 'recovering' && sample.supervisor.attempts > 0);
    const recovered = await record('after-fallback-inference');
    assert.equal(fallbackSend.task, before.task, 'fallback response stays in the same actual app task');
    assert.equal(recovered.task, before.task);
    assert.equal(fallbackSend.request.hasObjective, true, 'the original objective remains in the app inference context');
    assert.ok(fallbackSend.request.messageMarkers.includes('CONTINUITY_A'), 'prior user turn remains in the app inference context');
    assert.equal(fallbackSend.host.supervisor.attempts, 10);
    assert.equal(fallbackSend.host.supervisor.status, 'fallback-active');
    assert.equal(fallbackSend.host.supervisor.route, 'fallback');
    checks.recoveredSameSession = fallbackSend.host;
    assert.equal(checks.intermediateRecoveryObserved, true);
    await page.locator('[data-zaicode-router-supervisor=fallback-active]').first().waitFor({ timeout: 20000 });
    checks.fallbackUI = (await page.locator('body').innerText()).includes('Preferred router unavailable · internal fallback active');
    assert.equal(checks.fallbackUI, true);
    checks.fallbackInference = fallbackSend.request;
    assert.equal(checks.fallbackInference.marker, 'CONTINUITY_B');

    stage = 'restore-preferred';
    preferred = startRouter(preferredPort, sharedData); await ready(preferredPort);
    const deadline = Date.now() + 150000;
    let healthy;
    while (Date.now() < deadline) {
      healthy = await page.evaluate(() => window.zcode.getZaicodeRouterHost());
      if (healthy.supervisor.healthyProbes >= 2 && Date.now() >= healthy.supervisor.cooldownUntil) break;
      await wait(2000);
    }
    assert.ok(healthy.supervisor.healthyProbes >= 2, 'two actual healthy recovery probes');
    assert.equal(healthy.supervisor.route, 'fallback', 'health polling cannot silently change an active route');
    const restoredSend = await sendUiPrompt('CONTINUITY_C');
    const restored = await record('after-continuation-boundary');
    assert.equal(restoredSend.task, before.task); assert.equal(restored.task, before.task); assert.equal(restoredSend.host.supervisor.route, 'preferred');
    assert.equal(restoredSend.request.hasObjective, true, 'objective survives return to the preferred route');
    assert.ok(restoredSend.request.messageMarkers.includes('CONTINUITY_A'), 'original user turn remains in the app inference context after recovery');
    checks.safeReturn = restoredSend.host;
    checks.sameSessionAndObjective = ['CONTINUITY_A', 'CONTINUITY_B', 'CONTINUITY_C'].every(marker => inferenceFor(marker).hasObjective);
    assert.equal(checks.sameSessionAndObjective, true);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify({ ok: true, stage, profile, exe, checks, observations, inference, paidVendorRequests: 0, limitations: ['The original screenshot runtime remains unattributed; runtime skew is proven, but it is not evidence that the captured screenshot came from that process.'] }, null, 2));
    console.log('PASS packaged identity, bounded router recovery, fallback and same-session continuity', JSON.stringify(checks));
  } catch (error) {
    if (page) { await page.screenshot({ path: path.join(out, `fail-${stage}.png`) }).catch(() => {}); fs.writeFileSync(path.join(out, `fail-${stage}.txt`), await page.locator('body').innerText().catch(() => '')); }
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ stage, error: String(error.stack || error), profile, checks, observations, inference, errors }, null, 2));
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    if (unavailable?.listening) await new Promise(resolve => unavailable.close(resolve));
    await stopRouterTree(preferred).catch(() => {});
    await stopRouterTree(seedFallback).catch(() => {});
    vendor.closeAllConnections(); vendor.close();
  }
}
main().catch(error => { console.error(stage, error); process.exitCode = 1; });
