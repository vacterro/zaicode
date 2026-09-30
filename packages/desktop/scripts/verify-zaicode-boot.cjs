// Packaged ZAICODE boot gate.
//
//   node packages/desktop/scripts/verify-zaicode-boot.cjs [ZAICODE.exe] [--out DIR] [--receipt FILE]
//
// Starts the PACKAGED app on a throw-away profile and passes only when the
// window really reaches a mounted workspace shell: no error card on screen, no
// uncaught renderer exception, no "before initialization" / "is not defined".
// It then opens Settings and visits every section of its navigation: a section
// is a lazily rendered screen that no unit test renders, and one that throws
// takes only its own card down, so the boot alone would not notice it.
// Wave 3 shipped a window that opened on "This section ran into a problem"
// (a const read before its declaration); 765 unit tests and tsc were green
// because nothing rendered the shell. This script renders it. It then makes sure the desktop-wide
// ProTrail (on by default) comes up on every monitor by itself and really draws (verify-zaicode-protrail.cjs).
//
// On success it writes a receipt beside the build (default: next to
// win-unpacked). bundle-zaicode.mjs refuses to leave a staged build that has
// not passed, so the launcher can never swap a window that cannot start.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");
const { checkProtrail } = require("./verify-zaicode-protrail.cjs");
const { checkCustomization } = require("./verify-zaicode-customization.cjs");
const { checkWorkflowControls, chooseLocale } = require("./verify-zaicode-workflows.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function option(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const positional = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && !all[index - 1]?.startsWith("--"));
const executablePath = path.resolve(
  positional[0] ?? path.resolve(__dirname, "../dist-next/win-unpacked/ZAICODE.exe"),
);
const outDir = option("--out") ?? process.env.ZAICODE_BOOT_OUT_DIR;
const receiptPath = option("--receipt") ?? path.join(path.dirname(path.dirname(executablePath)), "boot-receipt.json");
const tempBase = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "Temp");
fs.mkdirSync(tempBase, { recursive: true });
const profile = fs.mkdtempSync(path.join(tempBase, "zaicode-boot-"));
const customizationDir = path.join(profile, "customization");
if (outDir) fs.mkdirSync(outDir, { recursive: true });

/** Text the two error boundaries render (en-US and zh-CN locale files). */
const BOUNDARY_TEXT = /ran into a problem|出了点问题/i;
/** Console errors that mean the code itself is broken, not the environment. */
const FATAL_CONSOLE = /before initialization|is not defined|Cannot read properties of (undefined|null)|is not a function|Maximum update depth/i;

/** Kills only the process tree this script started, never by image name. */
function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } catch {
    // already gone
  }
}

async function main() {
  assert.ok(fs.existsSync(executablePath), `packaged executable exists: ${executablePath}`);
  const env = {
    ...process.env,
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE boot ${path.basename(profile)}`,
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"),
    // CLI discovery and host services use OS home variables, independently of Electron's home path.
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(profile, "AppData", "Local"),
    // What the root launcher sets for the real app: the ZAICODE runtime (ProTrail among it) exists only in this mode.
    ZCODE_ZAICODE_MODE: process.env.ZCODE_ZAICODE_MODE ?? "1",
    // The customization folder (T-126) inside the throw-away profile: a gate run must never create or list the operator's own.
    ZAICODE_CUSTOMIZATION_DIR: customizationDir,
    ZAICODE_UPDATES: "off",
  };
  delete env.TZ;
  // A boot gate must not inherit the operator's mailbox, router or agent state.
  delete env.SAIMAIL_WORKSPACE;
  // Vendor-specific home/auth variables override HOME and would leak real accounts into this profile.
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
  }
  delete env.ZAICODE_INSTALL_ROOT;

  const pageErrors = [];
  const consoleErrors = [];
  const watch = (page) => {
    page.on("pageerror", (error) => pageErrors.push(String(error?.stack ?? error).slice(0, 600)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 600));
    });
  };

  let app;
  let child = null;
  let pid = 0;
  const checks = {};
  try {
    app = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${profile}`],
      env,
      timeout: 90_000,
    });
    // Kept now: after close() the Playwright handle no longer answers process().
    child = app.process();
    pid = child.pid;
    app.on("window", watch);
    for (const window of app.windows()) watch(window);

    const deadline = Date.now() + 60_000;
    let page;
    while (!page && Date.now() < deadline) {
      page = app.windows().find((window) => !window.isClosed() && window.url().includes("/out/renderer/index.html"));
      if (!page) await sleep(500);
    }
    assert.ok(page, "the packaged app opens its main window");
    checks.window = true;

    await page.waitForFunction(
      () => {
        const body = document.body.innerText.trim();
        return body.length > 100 && !body.includes("ZAICODE will open when preparation finishes");
      },
      null,
      { timeout: 120_000 },
    );
    checks.contentReady = true;

    // Either the shell mounts or an error card takes its place; wait for one of them.
    await page
      .waitForFunction(
        () =>
          document.querySelector('[data-workspace-shell="true"]') ||
          [...document.querySelectorAll('[role="alert"]')].some((node) => /ran into a problem|出了点问题/i.test(node.textContent ?? "")),
        null,
        { timeout: 60_000 },
      )
      .catch(() => undefined);
    // Later renders (data arriving, effects) can still throw; look again after they settle.
    await sleep(3000);

    const boundaries = await page.$$eval('[role="alert"]', (nodes) => nodes.map((node) => (node.textContent ?? "").trim().slice(0, 400)));
    const shown = boundaries.filter((text) => BOUNDARY_TEXT.test(text));
    assert.deepEqual(shown, [], `an error card is on screen: ${shown.join(" | ")}`);
    checks.noErrorCard = true;

    assert.equal(await page.locator('[data-workspace-shell="true"]').count(), 1, "the workspace shell is mounted");
    checks.workspaceShell = true;
    assert.ok((await page.locator("#sidebar").count()) >= 1, "the sidebar panel is mounted");
    checks.sidebar = true;

    assert.deepEqual(pageErrors, [], `uncaught renderer exceptions: ${pageErrors.join(" || ")}`);
    checks.noPageErrors = true;
    const fatal = consoleErrors.filter((text) => FATAL_CONSOLE.test(text));
    assert.deepEqual(fatal, [], `fatal renderer console errors: ${fatal.join(" || ")}`);
    checks.noFatalConsoleErrors = true;

    // A narrow window must still hold the shell (the Wave 1 overlap class).
    await page.setViewportSize({ width: 640, height: 540 });
    await sleep(500);
    assert.equal(await page.locator('[data-workspace-shell="true"]').count(), 1, "the shell survives a 640x540 window");
    const narrowBoundaries = (await page.$$eval('[role="alert"]', (nodes) => nodes.map((node) => node.textContent ?? ""))).filter((text) => BOUNDARY_TEXT.test(text));
    assert.deepEqual(narrowBoundaries, [], "no error card after resizing");
    checks.narrowWindow = true;

    // Settings: every navigation entry that opens inside the app.
    await page.setViewportSize({ width: 1200, height: 800 });
    await sleep(300);
    await page.locator("button[aria-label='Settings']").first().click({ timeout: 10_000 });
    const nav = page.locator("nav").filter({ hasText: "Keyboard Shortcuts" }).first();
    await nav.waitFor({ timeout: 15_000 });
    const entries = await nav.locator("button").evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim().replace(/\s+/g, " ")));
    // Links that leave the app (the browser must never open from a gate) and the way back.
    const skip = /back to workspace|on github|support developer|discord saipen community/i;
    const visited = [];
    const broken = [];
    for (const [index, name] of entries.entries()) {
      if (!name || skip.test(name)) continue;
      try {
        await nav.locator("button").nth(index).click({ timeout: 8000 });
      } catch (error) {
        console.log(`note: could not open Settings > ${name} (${String(error.message ?? error).split("\n")[0]})`);
        continue;
      }
      await sleep(600);
      visited.push(name);
      const cards = (await page.$$eval('[role="alert"]', (nodes) => nodes.map((node) => (node.textContent ?? "").trim().slice(0, 300)))).filter((text) => BOUNDARY_TEXT.test(text));
      if (cards.length) broken.push(`${name}: ${cards[0]}`);
    }
    assert.deepEqual(broken, [], `Settings sections that render an error card: ${broken.join(" || ")}`);
    assert.ok(visited.length >= 15, `the Settings walk reached its sections (visited ${visited.length}: ${visited.join(", ")})`);
    checks.settingsSections = visited.length;
    assert.deepEqual(pageErrors, [], `uncaught renderer exceptions while walking Settings: ${pageErrors.join(" || ")}`);
    const fatalWalk = consoleErrors.filter((text) => FATAL_CONSOLE.test(text));
    assert.deepEqual(fatalWalk, [], `fatal renderer console errors while walking Settings: ${fatalWalk.join(" || ")}`);
    if (outDir) await page.screenshot({ path: path.join(outDir, "boot.png") });

    // ProTrail (T-129): on by default, it must come up on every monitor by itself and really draw.
    const protrail = await checkProtrail(app);
    checks.protrail = protrail;
    assert.deepEqual(pageErrors, [], `uncaught renderer exceptions after ProTrail came up: ${pageErrors.join(" || ")}`);

    // The customization folder (T-126): a file dropped in from outside shows up on the Sounds page by itself.
    checks.customization = await checkCustomization(page, customizationDir);
    assert.deepEqual(pageErrors, [], `uncaught renderer exceptions after the customization check: ${pageErrors.join(" || ")}`);
    const fatalCustomization = consoleErrors.filter((text) => FATAL_CONSOLE.test(text));
    assert.deepEqual(fatalCustomization, [], `fatal renderer console errors after the customization check: ${fatalCustomization.join(" || ")}`);

    checks.workflowControls = await checkWorkflowControls(page, app, profile);
    await chooseLocale(page, "ru-RU", "Русский");
    await app.close();
    app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env, timeout: 90_000 });
    child = app.process(); pid = child.pid;
    app.on("window", watch);
    let restarted;
    const restartDeadline = Date.now() + 60_000;
    while (!restarted && Date.now() < restartDeadline) {
      restarted = app.windows().find((window) => !window.isClosed() && window.url().includes("/out/renderer/index.html"));
      if (!restarted) await sleep(500);
    }
    assert.ok(restarted, "the same isolated profile restarts");
    watch(restarted);
    await restarted.waitForFunction(() => document.documentElement.lang === "ru-RU" && document.querySelector('[data-workspace-shell="true"]'), null, { timeout: 90_000 });
    // Settings is the durable owner; a fresh renderer may hydrate from it before its local cache exists.
    await restarted.getByTestId("task-settings-button").filter({ visible: true }).click();
    await restarted.getByTestId("settings-section-nav-general").click();
    assert.match(await restarted.getByTestId("settings-locale-select-trigger").innerText(), /Русский/, "the explicit Russian preference, rather than System, persists across an application restart");
    checks.localeRestart = "ru-RU";
    assert.deepEqual(pageErrors, [], "no renderer errors during workflow checks or restart");
    assert.deepEqual(consoleErrors.filter((text) => FATAL_CONSOLE.test(text)), [], "no fatal console errors during workflow checks or restart");

    const asar = path.join(path.dirname(executablePath), "resources", "app.asar");
    const receipt = {
      schema: "zaicode-boot-receipt/1",
      ok: true,
      at: new Date().toISOString(),
      executable: executablePath,
      executableMtimeMs: fs.statSync(executablePath).mtimeMs,
      appAsarBytes: fs.existsSync(asar) ? fs.statSync(asar).size : null,
      appAsarMtimeMs: fs.existsSync(asar) ? fs.statSync(asar).mtimeMs : null,
      checks,
      consoleErrorCount: consoleErrors.length,
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const trail = checks.protrail?.skipped ? `ProTrail skipped (${checks.protrail.skipped})` : `ProTrail drawing on ${checks.protrail?.monitors} monitor(s)`;
    console.log(`PASS packaged boot: shell mounted, ${checks.settingsSections} Settings sections opened, ${trail}, customization list live (${checks.customization.count.join("->")}), no error card, ${pageErrors.length} uncaught exceptions, ${consoleErrors.length} console errors -> ${receiptPath}`);
    if (consoleErrors.length) console.log(`console errors (informational):\n  ${consoleErrors.slice(0, 8).join("\n  ")}`);
  } catch (error) {
    if (outDir && app) {
      const page = app.windows().find((window) => !window.isClosed());
      if (page) await page.screenshot({ path: path.join(outDir, "boot-failed.png") }).catch(() => undefined);
    }
    try {
      fs.rmSync(receiptPath, { force: true });
    } catch {
      // nothing to remove
    }
    console.error(`FAIL packaged boot: ${error?.message ?? error}`);
    if (pageErrors.length) console.error(`uncaught exceptions:\n  ${pageErrors.slice(0, 5).join("\n  ")}`);
    if (consoleErrors.length) console.error(`console errors:\n  ${consoleErrors.slice(0, 8).join("\n  ")}`);
    process.exitCode = 1;
  } finally {
    if (app) {
      await Promise.race([app.close().catch(() => undefined), sleep(15_000)]);
      // Only a process this script started and that is still alive: a pid that
      // already exited may have been handed to someone else.
      if (child && child.exitCode === null) killTree(pid);
    }
    const resolvedBase = path.resolve(tempBase);
    const resolvedProfile = path.resolve(profile);
    if (resolvedProfile.startsWith(`${resolvedBase}${path.sep}`)) {
      fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
