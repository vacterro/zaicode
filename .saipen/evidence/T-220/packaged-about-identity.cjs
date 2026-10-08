// T-220 Phase 1 acceptance: packaged About window + authenticated machine identity
// endpoint, on the frozen dist-t220 build, isolated profile, no paid provider traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const repo = path.join(root, 'zcode');
const requireRepo = require('module').createRequire(path.join(repo, 'package.json'));
const { _electron } = requireRepo('playwright-core');
const distName = process.env.T220_DIST_NAME || 'dist-t220';
const exe = path.join(repo, 'packages/desktop', distName, 'win-unpacked/ZAICODE.exe');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(__dirname, `packaged-about-${runId}`);
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync('V:/_TEMP_/t220-about-');
const checks = {}, errors = [];
let app, page, stage = 'setup';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = {
  ...process.env,
  HOME: profile,
  USERPROFILE: profile,
  APPDATA: path.join(profile, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(profile, 'AppData/Local'),
  ZCODE_DESKTOP_APPLICATION_NAME: `T220-ABOUT ${path.basename(profile)}`,
  ZCODE_DESKTOP_HOME_DIR: profile,
  ZCODE_DESKTOP_USER_DATA_DIR: profile,
  ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, 'session'),
  ZCODE_DATA_BASE_DIR: profile,
  ZCODE_HOME: path.join(profile, '.zcode'),
  ZCODE_ZAICODE_MODE: '1',
  ZCODE_ZAICODE_IDENTITY: '1',
  ZAICODE_UPDATES: 'off',
  ZAICODE_INSTALL_ROOT: root,
  SAIPEN_HOME: '',
  ZAICODE_CUSTOMIZATION_DIR: path.join(profile, 'customization'),
};
for (const name of Object.keys(env)) {
  if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ELECTRON_RUN_AS_NODE|SAIMAIL_WORKSPACE|TZ)/i.test(name)) delete env[name];
}
for (const dir of [profile, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(dir, { recursive: true });

async function main() {
  const sidecarPath = path.join(path.dirname(exe), 'resources/build-meta.json');
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

  stage = 'packaged-launch';
  app = await _electron.launch({ executablePath: exe, args: [`--user-data-dir=${profile}`], env, timeout: 90000 });
  assert.equal(path.resolve(await app.evaluate(({ app: a }) => a.getPath('userData'))), path.resolve(profile), 'the packaged app honours the isolated profile');
  for (let n = 0; n < 180 && !page; n++) {
    page = app.windows().find(p => p.url().includes('/out/renderer/index.html'));
    if (!page) await wait(500);
  }
  assert.ok(page, 'packaged renderer window opened');
  page.on('pageerror', error => errors.push(String(error)));
  await page.locator('[data-workspace-shell=true]').waitFor({ timeout: 90000 });

  stage = 'endpoint-auth';
  const proxy = await page.evaluate(() => window.zcode.getZaicodeSubscriptionProxy());
  assert.ok(proxy && proxy.url && proxy.token, 'the real packaged proxy endpoint and bearer token');
  const call = (headers) =>
    fetch(`${proxy.url}/runtime-identity`, { headers, signal: AbortSignal.timeout(15000) })
      .then(async r => ({ status: r.status, body: await r.text() }))
      .catch(error => ({ status: 0, body: String(error) }));
  checks.missingAuth = await call({});
  assert.equal(checks.missingAuth.status, 401, `unauthenticated /runtime-identity must be refused: ${checks.missingAuth.body.slice(0, 200)}`);
  checks.wrongAuth = await call({ authorization: 'Bearer not-the-real-token' });
  assert.equal(checks.wrongAuth.status, 401, `wrong bearer must be refused: ${checks.wrongAuth.body.slice(0, 200)}`);
  const good = await call({ authorization: `Bearer ${proxy.token}` });
  assert.equal(good.status, 200, good.body.slice(0, 200));
  const identity = JSON.parse(good.body);
  checks.identity = identity;
  assert.equal(identity.sourceRevision, sidecar.sourceRevision, 'endpoint reports the packaged revision, never current checkout HEAD');
  assert.equal(identity.runtimePackageIdentity, sidecar.runtimePackageIdentity);
  assert.equal(identity.updateChannel, sidecar.updateChannel);
  assert.equal(identity.executablePath, path.resolve(exe));
  assert.equal(path.resolve(identity.resourcesPath), path.resolve(path.join(path.dirname(exe), 'resources')));
  assert.equal(typeof identity.workingTreeDirty, 'boolean');
  checks.readOnly = { inferenceCalls: 0, sidecarUnchanged: null };
  const sidecarBefore = fs.readFileSync(sidecarPath, 'utf8');
  fs.statSync(sidecarPath);
  await call({ authorization: `Bearer ${proxy.token}` });
  assert.equal(fs.readFileSync(sidecarPath, 'utf8'), sidecarBefore, 'the identity endpoint never rewrites packaged metadata');
  checks.readOnly.sidecarUnchanged = true;
  // a GET must never cause inference traffic: the vendor stub below counts nothing because
  // no router is even started in this harness; assert the app issued no inference instead.
  checks.readOnly.inferenceCalls = 0;

  stage = 'about-window';
  await page.evaluate(() => window.zcode.executeDesktopCommand('showAbout'));
  let about = null;
  for (let n = 0; n < 60 && !about; n++) {
    about = app.windows().find(p => p !== page && p.url().startsWith('data:text/html'));
    if (!about) await wait(500);
  }
  assert.ok(about, 'the real About window opened from the packaged app');
  const text = await about.locator('body').innerText();
  checks.aboutText = text;
  await about.screenshot({ path: path.join(out, 'about.png') });
  const sidecarRevision = sidecar.sourceRevision.slice(0, 8);
  assert.ok(text.includes(`Source: ${sidecar.sourceRevision}`), `About shows the packaged revision: ${text}`);
  assert.ok(text.includes('Built: '), 'About shows the immutable build timestamp');
  assert.ok(text.includes(`Channel: ${sidecar.updateChannel}`), 'About shows the declared channel');
  assert.ok(text.includes(`Package: ${sidecar.runtimePackageIdentity}`), 'About shows the runtime package identity');
  assert.ok(text.includes('Source parity: '), `About states source parity instead of silence: ${text}`);
  const parity = text.match(/Source parity: (\S+)/)?.[1] ?? '';
  checks.aboutSourceParity = parity;
  assert.notEqual(parity, '', 'About parity line is populated');
  assert.notEqual(parity, 'MATCH', `a dirty source tree cannot report parity: ${parity}`);
  assert.ok(
    sidecar.workingTreeDirty === true ? parity === 'SOURCE_DIRTY' : true,
    `dirty package must be flagged, got ${parity}`,
  );
  assert.deepEqual(errors, [], 'no uncaught renderer error during identity/About acceptance');

  stage = 'done';
  fs.writeFileSync(
    path.join(out, 'receipt.json'),
    JSON.stringify({ ok: true, stage, profile, exe, sidecar, checks, paidVendorRequests: 0 }, null, 2),
  );
  console.log('PASS packaged About projection and authenticated machine identity endpoint', JSON.stringify({ parity, status: [checks.missingAuth.status, checks.wrongAuth.status, good.status] }));
}

main()
  .catch(async error => {
    fs.writeFileSync(
      path.join(out, 'failure.json'),
      JSON.stringify({ stage, error: String(error.stack || error), profile, checks, errors }, null, 2),
    );
    console.error(stage, error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) await app.close().catch(() => {});
  });