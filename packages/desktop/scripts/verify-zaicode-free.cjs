// FREE on a fresh machine: the zero-setup gate (T-134).
//
//   node packages/desktop/scripts/verify-zaicode-free.cjs [ZAICODE.exe] [--out DIR] [--prompt TEXT] [--router-package DIR]
//
// Starts the PACKAGED app the way a first install does -- a throw-away profile
// whose home, APPDATA and LOCALAPPDATA are empty folders, so there is no 9router
// of the operator's, no provider, no key and no login -- and passes only when,
// with no click in any setting:
//   1. ZAICODE starts its own router (isolated mode) and SAIFREN answers its
//      first-token probe (the main process's zero-setup chain),
//   2. the SAIRoute provider exists with SAIFREN as the default model,
//   3. a task typed into New task gets an answer from the free pool.
// It never touches the operator's profile, router or running ZAICODE: every
// path is inside the throw-away profile and only the process tree it started
// is stopped. The free providers are real internet services, so a FAIL can be
// the network or a provider's day; the report says which step stopped.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function option(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const positional = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && !all[index - 1]?.startsWith("--"));
const executablePath = path.resolve(positional[0] ?? path.resolve(__dirname, "../dist-next/win-unpacked/ZAICODE.exe"));
const outDir = option("--out");
const prompt = option("--prompt") ?? "Reply with one short sentence that contains the word PONG.";
const routerPackage = option("--router-package");
const tempBase = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "Temp");
fs.mkdirSync(tempBase, { recursive: true });
const profile = fs.mkdtempSync(path.join(tempBase, "zaicode-free-"));
const project = path.join(profile, "first-project");
if (outDir) fs.mkdirSync(outDir, { recursive: true });

function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

async function shot(page, name) {
  if (outDir && page) await page.screenshot({ path: path.join(outDir, name) }).catch(() => undefined);
}

async function main() {
  assert.ok(fs.existsSync(executablePath), `packaged executable exists: ${executablePath}`);
  const roaming = path.join(profile, "AppData", "Roaming");
  const local = path.join(profile, "AppData", "Local");
  for (const dir of [roaming, local, project]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, "README.md"), "# first project\n");
  const env = {
    ...process.env,
    // A machine that has never seen ZAICODE, 9router, Claude or Codex.
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE free ${path.basename(profile)}`,
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"),
    ZCODE_ZAICODE_MODE: "1",
    ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization"),
    ZAICODE_UPDATES: "off",
  };
  delete env.TZ;
  delete env.SAIMAIL_WORKSPACE;
  // Whatever this machine's own agents export (a Claude / Codex login home, API keys) does not exist on a fresh one.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
  }
  delete env.ZAICODE_INSTALL_ROOT;
  if (routerPackage) env.ZAICODE_ROUTER_PACKAGE = path.resolve(routerPackage);
  else delete env.ZAICODE_ROUTER_PACKAGE;

  const steps = {};
  const started = Date.now();
  const pageErrors = [];
  let app;
  let child = null;
  let pid = 0;
  let page;
  try {
    app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 90_000 });
    child = app.process();
    pid = child.pid;
    // The folder picker answers with the throw-away project (a real person picks one in the dialog).
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      dialog.showOpenDialogSync = () => [folder];
    }, project);
    const deadline = Date.now() + 60_000;
    while (!page && Date.now() < deadline) {
      page = app.windows().find((window) => !window.isClosed() && window.url().includes("/out/renderer/index.html"));
      if (!page) await sleep(500);
    }
    assert.ok(page, "the app opens its main window");
    page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    await page.waitForSelector('[data-workspace-shell="true"]', { timeout: 120_000 });
    steps.shell = Math.round((Date.now() - started) / 1000);

    // 1. The main process's zero-setup chain, as the renderer's own call sees it.
    const bootstrap = await page.evaluate(async () => {
      const bridge = window.zcode;
      for (let attempt = 0; attempt < 90; attempt++) {
        const result = await bridge.bootstrapZaicodeRouter({ needKey: true }).catch((error) => ({ ok: false, steps: [{ id: "call", status: "failed", detail: String(error) }] }));
        if (result?.firstToken?.ok) return result;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (attempt === 89) return result;
      }
      return null;
    });
    steps.router = { mode: bootstrap?.host?.mode, url: bootstrap?.host?.url, package: bootstrap?.host?.packageDir, firstToken: bootstrap?.firstToken };
    assert.equal(bootstrap?.host?.mode, "isolated", `a fresh machine gets ZAICODE's own router (got ${bootstrap?.host?.mode})`);
    assert.ok(bootstrap?.firstToken?.ok, `SAIFREN answers its first-token probe: ${JSON.stringify(bootstrap?.firstToken ?? bootstrap?.steps)}`);
    steps.routerReady = Math.round((Date.now() - started) / 1000);

    // 2. The app-side link: the SAIRoute provider with SAIFREN (useZaicodeRouterAutoSetup does it by itself and says
    //    "SAIFREN is ready"). The default for new tasks is SAIFREN: stored here, or the release default when it resolves.
    await page.waitForFunction(() => /SAIFREN (is )?ready/i.test(document.body.innerText), null, { timeout: 120_000 });
    steps.defaultModel = await page.evaluate(() => localStorage.getItem("zaicode-default-model") ?? "(release default)");
    steps.appReady = Math.round((Date.now() - started) / 1000);
    // A first start must not keep a stale "no SAIFREN pool" (red HEALTH) once the pool exists.
    await page.locator('button:has-text("SAIHOME")').first().click({ timeout: 10_000 }).catch(() => undefined);
    const stale = await page
      .waitForFunction(() => !/no SAIFREN pool/i.test(document.body.innerText), null, { timeout: 30_000 })
      .then(() => false)
      .catch(() => true);
    assert.equal(stale, false, "SAIHOME still says 'no SAIFREN pool' 30 s after SAIFREN was ready");

    // 3. First use as a new person does it: New task, write, Enter (a project is added if the app asks for one).
    await shot(page, "free-1-ready.png");
    const newTask = page.locator('button[title^="NEW TASK"]').first();
    if (await newTask.count()) {
      await newTask.click({ timeout: 10_000 }).catch(() => undefined);
      await sleep(1500);
    }
    const INPUT = '[data-testid="v4-composer-input"], [data-testid="chat-input"]';
    if (!(await page.locator(INPUT).count())) {
      const addProject = page.locator('button:has-text("Open folder"), button:has-text("Open project"), button:has-text("Add project"), button[aria-label*="folder" i]').first();
      if (await addProject.count()) {
        await addProject.click({ timeout: 10_000 }).catch(() => undefined);
        await sleep(2500);
      }
      if (await newTask.count()) await newTask.click({ timeout: 10_000 }).catch(() => undefined);
      await sleep(1500);
    }
    // A first task needs a folder to work in: pick one the way the composer offers it.
    const selectProject = page.locator('button:has-text("Select project")').first();
    if (await selectProject.count()) {
      await selectProject.click({ timeout: 10_000 }).catch(() => undefined);
      await sleep(800);
      await shot(page, "free-1c-projects.png");
      const open = page.locator('[role="menuitem"]:has-text("Open"), [role="menuitem"]:has-text("folder"), [role="option"]:has-text("folder"), button:has-text("Open folder")').first();
      if (await open.count()) await open.click({ timeout: 10_000 }).catch(() => undefined);
      await sleep(2500);
    }
    await shot(page, "free-1b-composer.png");
    const input = page.locator(INPUT).first();
    await input.waitFor({ timeout: 60_000 });
    await input.click();
    await page.keyboard.type(prompt, { delay: 5 });
    await page.keyboard.press("Enter");
    steps.sentAt = Math.round((Date.now() - started) / 1000);
    const answered = await page
      .waitForFunction(
        // The answer: PONG anywhere on screen once every copy of the question itself is taken out.
        (asked) => document.body.innerText.split(asked).join(" ").split(asked.replace(/\.$/, "")).join(" ").includes("PONG"),
        prompt,
        { timeout: 240_000 },
      )
      .then(() => true)
      .catch(() => false);
    await shot(page, "free-2-answer.png");
    assert.ok(answered, "the free pool answered the first task in New task");
    steps.answered = Math.round((Date.now() - started) / 1000);
    assert.deepEqual(pageErrors, [], `uncaught renderer exceptions: ${pageErrors.join(" || ")}`);
    console.log(`PASS free on a fresh profile: router ${steps.router.mode} ${steps.router.url} (${steps.router.package}), first token ${steps.router.firstToken?.detail ?? ""}, default ${steps.defaultModel}, answer after ${steps.answered - steps.sentAt} s (total ${steps.answered} s)`);
    if (outDir) fs.writeFileSync(path.join(outDir, "free-receipt.json"), `${JSON.stringify({ ok: true, at: new Date().toISOString(), executable: executablePath, steps }, null, 2)}\n`);
  } catch (error) {
    await shot(page, "free-failed.png");
    console.error(`FAIL free on a fresh profile: ${error?.message ?? error}`);
    console.error(`steps: ${JSON.stringify(steps)}`);
    if (pageErrors.length) console.error(`uncaught exceptions:\n  ${pageErrors.slice(0, 5).join("\n  ")}`);
    process.exitCode = 1;
  } finally {
    if (app) {
      await Promise.race([app.close().catch(() => undefined), sleep(15_000)]);
      if (child && child.exitCode === null) killTree(pid);
    }
    const resolvedBase = path.resolve(tempBase);
    if (path.resolve(profile).startsWith(`${resolvedBase}${path.sep}`)) {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
