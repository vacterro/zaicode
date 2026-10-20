// T-296 packaged subscription acceptance.
//
//   node packages/desktop/scripts/verify-zaicode-subscription-acceptance.cjs [ZAICODE.exe] [--receipt FILE] [--against DIR]
//
// Two things the previous ticket could not show:
//   1. PACKAGE PARITY — which build the process under test really is. A successful
//      build command proves nothing about the process the operator runs, so this
//      reads the running package's own resources/build-meta.json (sourceRevision,
//      runtimePackageIdentity, buildTime) and compares it with the workspace HEAD
//      and, when given, with another build (--against).
//   2. That the SHIPPED renderer really reports a subscription fault. The incident
//      left no trace anywhere because production builds suppress logger.warn; the
//      T-296 lifecycle events are the fix. This runs the packaged app and reads the
//      app's own log file, then fails if a fail-closed subscription terminal was
//      written to it.
//
// It never touches the operator's profile: own throw-away profile, own data dir,
// and it kills only the process tree it started (by PID).
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
const executablePath = path.resolve(
  positional[0] ?? path.resolve(__dirname, "../dist-next/win-unpacked/ZAICODE.exe"),
);
const againstDir = option("--against");
const queueAttempts = Number(option("--attempts") ?? 10);
// A throw-away profile has no open folder, so the conversation pane never mounts
// and there is nothing to admit a Queue item against. --workspace opens a
// disposable folder of our own so the real packaged composer can be driven.
const workspaceArg = option("--workspace");
const receiptPath = option("--receipt") ?? path.join(path.dirname(executablePath), "subscription-acceptance.json");
const workspace = path.resolve(__dirname, "../../..");
const outDir = option("--out") ?? path.join(path.dirname(executablePath), "subscription-acceptance-shots");

const FATAL_CONSOLE = /before initialization|is not defined|Cannot read properties of (undefined|null)|is not a function|Maximum update depth/i;

function readIdentity(exePath) {
  const meta = path.join(path.dirname(exePath), "resources", "build-meta.json");
  if (!fs.existsSync(meta)) return { executable: exePath, metadata: null };
  return { executable: exePath, metadata: JSON.parse(fs.readFileSync(meta, "utf8")) };
}

function gitHead(source) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  } catch (error) {
    return `unavailable: ${error.message}`;
  }
}

/** Kills only the process tree this script started, never by image name. */
function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // already gone
  }
}

function readAppLogs(profile) {
  const logsDir = path.join(profile, ".zaicode", "v2", "logs");
  if (!fs.existsSync(logsDir)) return { dir: logsDir, files: [], text: "" };
  const files = fs.readdirSync(logsDir).filter((name) => name.endsWith(".log"));
  const text = files.map((name) => fs.readFileSync(path.join(logsDir, name), "utf8")).join("\n");
  return { dir: logsDir, files, text };
}

/**
 * The operator's incident lived in the Queue: an admitted item whose subscription
 * then failed. This drives the real packaged composer and reads the queue back.
 * It reports what it saw instead of asserting a shape the profile may not have:
 * an empty throw-away profile legitimately has no conversation pane, and saying so
 * is more useful than a green check that proved nothing.
 */
/**
 * Opens the first session of an already-open disposable workspace. A fresh
 * profile has no session yet, so the conversation pane is absent until the
 * app's own new-session affordance is used. Purely best-effort: it reports
 * what it clicked and never asserts a layout it may not find.
 */
async function openSession(page) {
  const result = { composerBefore: 0, clicks: [] };
  result.composerBefore = await page.locator('[data-testid="v4-composer"]').count();
  const candidates = [
    '[data-testid="v4-new-session"]',
    '[data-testid="v4-session-new"]',
    '[data-testid="v4-new-task"]',
    'button:has-text("New session")',
    'button:has-text("New chat")',
    'button:has-text("New task")',
    'button:has-text("新会话")',
    'button:has-text("新对话")',
    '[data-testid^="v4-session-item"]',
  ];
  for (const selector of candidates) {
    const target = page.locator(selector).first();
    if ((await target.count()) === 0) continue;
    try {
      await target.click({ timeout: 5_000 });
    } catch (error) {
      result.clicks.push(`${selector}: click failed ${String(error?.message ?? error).slice(0, 120)}`);
      continue;
    }
    result.clicks.push(`${selector}: clicked`);
    await sleep(2_500);
    if ((await page.locator('[data-testid="v4-composer"]').count()) > 0) {
      result.openedWith = selector;
      return result;
    }
  }
  return result;
}

/** What the page actually offers, so an undrivable profile names its own blocker. */
async function probePage(page) {
  return page
    .evaluate(() => {
      const testIds = {};
      for (const node of document.querySelectorAll("[data-testid]")) {
        const id = node.getAttribute("data-testid");
        testIds[id] = (testIds[id] ?? 0) + 1;
      }
      const control = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        return {
          tag: node.tagName,
          disabled: node.disabled ?? null,
          ariaDisabled: node.getAttribute("aria-disabled"),
          text: (node.textContent ?? "").trim().slice(0, 60) || null,
          value: (node.value ?? "").slice(0, 60) || null,
          editable: node.isContentEditable,
        };
      };
      return {
        text: document.body.innerText.replace(/\s+/g, " ").slice(0, 2_500),
        testIds,
        controls: {
          input: control('[data-testid="v4-composer-input"]'),
          send: control('[data-testid="v4-composer-send"]'),
          model: control('[data-testid="chat-model-select-trigger"]'),
          mode: control('[data-testid="chat-mode-select-trigger"]'),
        },
        buttons: [...document.querySelectorAll("button, [role=button], [role=menuitem]")]
          .map((node) => (node.textContent ?? "").trim().slice(0, 40))
          .filter(Boolean)
          .slice(0, 60),
      };
    })
    .catch((error) => ({ error: String(error?.message ?? error) }));
}

async function driveQueue(page, result, attempts) {
  const queue = { attempts: 0, admittedVisible: 0, faultSurfaces: 0, driven: false, reason: null, opened: [] };
  result.queue = queue;
  const composer = page.locator('[data-testid="v4-composer"]');
  if ((await composer.count()) === 0) {
    queue.opened.push(await openSession(page));
  }
  if ((await composer.count()) === 0) {
    queue.reason = "no conversation composer on this profile: nothing to admit a Queue item against";
    queue.probe = await probePage(page);
    return;
  }
  const editable = page
    .locator('[data-testid="v4-composer-input"], [data-testid="v4-composer"] textarea, [data-testid="v4-composer"] [contenteditable="true"]')
    .first();
  if ((await editable.count()) === 0) {
    queue.reason = "the composer rendered without an editable input";
    queue.probe = await probePage(page);
    return;
  }
  // The send control is disabled while the composer is empty, so text goes in
  // first and the control is judged only after that.
  const send = page.locator('[data-testid="v4-composer-send"]').first();
  const sendState = async () => {
    if ((await send.count()) === 0) return "absent";
    return (await send.isEnabled().catch(() => false)) ? "enabled" : "disabled";
  };
  queue.sendBeforeFill = await sendState();
  queue.fillError = await editable
    .fill("T-296 packaged queue probe 0")
    .then(() => null)
    .catch((error) => String(error?.message ?? error).slice(0, 200));
  await sleep(500);
  queue.sendAfterFill = await sendState();
  if (queue.sendAfterFill !== "enabled") {
    queue.reason = "the composer kept its send control absent or disabled after text was entered (no model is selected on a throw-away profile, or no session is open)";
    queue.probe = await probePage(page);
    return;
  }
  queue.driven = true;
  for (let index = 0; index < attempts; index += 1) {
    queue.attempts += 1;
    try {
      await editable.first().fill(`T-296 packaged queue probe ${index + 1}`, { timeout: 10_000 });
      await send.click({ timeout: 10_000 });
    } catch (error) {
      queue.reason = `the composer stopped accepting input after ${index} admission(s): ${String(error?.message ?? error).slice(0, 200)}`;
      break;
    }
    await sleep(700);
    const seen = await page
      .evaluate(() => ({
        queueItems: document.querySelectorAll('[data-testid="v4-queue-item"]').length,
        panel: Boolean(document.querySelector('[data-testid="v4-subscription-fault-banner"]')) || /fault\.subscription\./.test(document.body.innerText),
      }))
      .catch(() => ({ queueItems: 0, panel: false }));
    if (seen.queueItems > 0) queue.admittedVisible += 1;
    if (seen.panel) queue.faultSurfaces += 1;
    if (seen.panel) break;
  }
  await page.screenshot({ path: path.join(outDir, `queue-after-${queue.attempts}.png`) }).catch(() => undefined);
  if (queue.admittedVisible === 0 && queue.faultSurfaces === 0) {
    queue.reason = "the composer accepted the text but no queue item became visible (a turn may have started instead of queueing)";
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const result = {
    schema: "zaicode-subscription-acceptance/1",
    at: new Date().toISOString(),
    identity: {},
    checks: {},
    telemetry: {},
    logs: {},
    limits: [],
  };

  // ---- 1. package identity -------------------------------------------------
  const underTest = readIdentity(executablePath);
  result.identity.package = underTest;
  result.identity.workspaceHead = gitHead(workspace);
  if (againstDir) result.identity.against = readIdentity(path.resolve(againstDir, "win-unpacked", "ZAICODE.exe"));
  const revision = underTest.metadata?.sourceRevision ?? null;
  result.checks.packageIdentityReadable = Boolean(revision && underTest.metadata?.runtimePackageIdentity);
  assert.ok(result.checks.packageIdentityReadable, `the package under test carries immutable identity metadata: ${executablePath}`);
  result.checks.revisionMatchesWorkspaceHead = revision === result.identity.workspaceHead;
  if (againstDir) {
    result.checks.differsFromLiveBuild = underTest.metadata?.runtimePackageIdentity !== result.identity.against.metadata?.runtimePackageIdentity;
  }

  // ---- 2. the packaged app on a throw-away profile -------------------------
  const tempBase = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "Temp");
  fs.mkdirSync(tempBase, { recursive: true });
  const profile = fs.mkdtempSync(path.join(tempBase, "zaicode-subscription-"));
  fs.writeFileSync(path.join(profile, "zaicode-engines.json"), JSON.stringify({ keepWindowsRolling: false }));
  // Disposable folder, never a real project: the packaged app is asked to open
  // its own throw-away workspace so a session pane can mount.
  let disposableWorkspace = null;
  if (workspaceArg !== undefined) {
    disposableWorkspace = path.resolve(workspaceArg);
    fs.mkdirSync(disposableWorkspace, { recursive: true });
    fs.writeFileSync(path.join(disposableWorkspace, "README.md"), "T-296 disposable acceptance workspace\n");
  }
  const env = {
    ...process.env,
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE subscription ${path.basename(profile)}`,
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"),
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(profile, "AppData", "Local"),
    ZCODE_ZAICODE_MODE: process.env.ZCODE_ZAICODE_MODE ?? "1",
    ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization"),
    ZAICODE_UPDATES: "off",
  };
  delete env.TZ;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SAIMAIL_WORKSPACE;
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
  let pid = 0;
  try {
    app = await _electron.launch({
      executablePath,
      args: [
        `--user-data-dir=${profile}`,
        ...(disposableWorkspace ? ["--open-workspace", disposableWorkspace] : []),
      ],
      env,
      timeout: 90_000,
    });
    pid = app.process().pid;
    const actualUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    assert.equal(path.resolve(actualUserData), path.resolve(profile), "the run uses its own throw-away profile");
    app.on("window", watch);
    for (const window of app.windows()) watch(window);

    const deadline = Date.now() + 60_000;
    let page;
    while (!page && Date.now() < deadline) {
      page = app.windows().find((window) => !window.isClosed() && window.url().includes("/out/renderer/index.html"));
      if (!page) await sleep(500);
    }
    assert.ok(page, "the packaged app opens its main window");
    result.checks.window = true;

    await page.waitForFunction(
      () => {
        const body = document.body.innerText.trim();
        return body.length > 100 && !body.includes("ZAICODE will open when preparation finishes");
      },
      null,
      { timeout: 120_000 },
    );
    result.checks.contentReady = true;

    // The incident surface: an error boundary card over the conversation, or the
    // subscription fault panel where the transcript belongs.
    await page
      .waitForFunction(
        () =>
          document.querySelector('[data-workspace-shell="true"]') ||
          [...document.querySelectorAll('[role="alert"]')].some((node) => /ran into a problem|出了点问题/i.test(node.textContent ?? "")),
        null,
        { timeout: 90_000 },
      )
      .catch(() => undefined);
    const surface = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        shell: Boolean(document.querySelector('[data-workspace-shell="true"]')),
        boundary: [...document.querySelectorAll('[role="alert"]')].some((node) => /ran into a problem|出了点问题/i.test(node.textContent ?? "")),
        subscriptionPanel: Boolean(document.querySelector('[data-testid="v4-subscription-fault-banner"]')) || /fault\.subscription\./.test(text),
        retriesStopped: /retries stopped|重试已停止/i.test(text),
      };
    });
    result.surface = surface;
    result.checks.workspaceShell = surface.shell;
    result.checks.noErrorCard = !surface.boundary;
    result.checks.noSubscriptionFaultPanel = !surface.subscriptionPanel && !surface.retriesStopped;
    await page.screenshot({ path: path.join(outDir, "surface.png") }).catch(() => undefined);

    // ---- 3. the Queue path in the real packaged app ------------------------
    await driveQueue(page, result, queueAttempts);
    result.checks.noFaultWhileQueueing = (result.queue?.faultSurfaces ?? 0) === 0;

    // ---- 4. the app's own lifecycle log ------------------------------------
    await sleep(3_000);
    const logs = readAppLogs(profile);
    result.logs = { dir: logs.dir, files: logs.files };
    const counts = (pattern) => (logs.text.match(pattern) ?? []).length;
    result.telemetry = {
      conversationStoreConnectStarted: counts(/v4\.conversation\.store\.connect\.started/g),
      conversationStoreConnectCompleted: counts(/v4\.conversation\.store\.connect\.completed/g),
      conversationStoreConnectFailed: counts(/v4\.conversation\.store\.connect\.failed/g),
      firstLogicalFrame: counts(/v4\.conversation\.store\.frame\.first/g),
      sessionDataAcquire: counts(/v4\.session_data\.acquire/g),
      assemblyRejected: counts(/v4\.topic_wire\.assembly_rejected/g),
      recoveryRequested: counts(/v4\.conversation\.store\.recovery\.requested/g),
      recoveryFailClosed: counts(/v4\.conversation\.store\.recovery\.fail_closed/g),
      lifecycleLogLines: counts(/\[(?:ui|renderer)\]/g),
    };
    result.checks.subscriptionTelemetryPresent = result.telemetry.lifecycleLogLines > 0;
    result.checks.noRecoveryFailClosed = result.telemetry.recoveryFailClosed === 0;
    // Only meaningful once a session really subscribed: that is the packaged build
    // telling us its own decoder handed an authoritative frame to the store.
    if (result.queue?.driven && (result.queue?.admittedVisible ?? 0) > 0) {
      result.checks.conversationSubscribedInPackage = result.telemetry.conversationStoreConnectCompleted > 0;
    }
    result.checks.noFatalConsoleErrors = consoleErrors.filter((text) => FATAL_CONSOLE.test(text)).length === 0;
    result.checks.noPageErrors = pageErrors.length === 0;

    if (result.telemetry.conversationStoreConnectStarted === 0) {
      result.limits.push(
        "no conversation subscription started in this run: a disposable profile only mounts the conversation pane once a workspace is open, so pass --workspace <dir> to drive the Queue against a throw-away folder; see the run procedure in the ticket report",
      );
    }
    result.pageErrors = pageErrors.slice(0, 5);
    result.consoleErrors = consoleErrors.slice(0, 5);
  } finally {
    try {
      if (app) await app.close();
    } catch {
      // fall through to the PID kill
    }
    killTree(pid);
  }

  result.passed = Object.entries(result.checks).every(([, value]) => value === true);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, checks: result.checks, telemetry: result.telemetry, receipt: receiptPath, limits: result.limits }, null, 2));
  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[subscription-acceptance] ${error?.stack ?? error}`);
  process.exitCode = 1;
});
