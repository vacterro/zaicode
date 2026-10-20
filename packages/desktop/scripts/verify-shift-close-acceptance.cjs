// Windows live acceptance test for Shift+Click full exit and normal close-to-tray.
const assert = require("node:assert/strict");
const { execSync, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");

function getChildren(parentPid) {
  try {
    const output = execSync(
      `powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | Select-Object -ExpandProperty ProcessId"`,
      { encoding: "utf8" },
    );
    return output
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    execFileSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore" },
    );
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForWorkspaceWindow(app, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let page = null;
  while (!page && Date.now() < deadline) {
    page = app.windows().find((w) => !w.isClosed() && w.url().includes("/out/renderer/index.html"));
    if (!page) await sleep(500);
  }
  assert.ok(page, "Packaged app opens workspace renderer window");

  await page.waitForFunction(
    () => {
      const body = document.body.innerText.trim();
      return body.length > 50 && !body.includes("ZAICODE will open when preparation finishes");
    },
    null,
    { timeout: timeoutMs },
  );

  await page.waitForSelector('[data-workspace-shell="true"]', { timeout: timeoutMs });
  await page.waitForSelector('[data-testid="window-control-close"]', { timeout: timeoutMs });
  return page;
}

function createTestEnv(profile) {
  const env = {
    ...process.env,
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE test ${path.basename(profile)}`,
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"),
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: path.join(profile, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(profile, "AppData", "Local"),
    ZCODE_PRODUCT_FLAVOR: "zaicode",
    ZCODE_ZAICODE_MODE: "1",
    ZAICODE_UPDATES: "off",
    NODE_ENV: "production",
  };
  delete env.TZ;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SAIMAIL_WORKSPACE;
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) {
      delete env[key];
    }
  }
  return env;
}

async function runNormalCloseTest(executablePath) {
  console.log("\n=======================================================");
  console.log("==> Test Case 1: Normal Close (Preserve Close-to-Tray)");
  console.log("=======================================================");
  const tempBase = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "Temp");
  const profile = fs.mkdtempSync(path.join(tempBase, "zaicode-normal-close-"));
  fs.writeFileSync(
    path.join(profile, "zaicode-engines.json"),
    JSON.stringify({ keepWindowsRolling: false }),
  );

  const env = createTestEnv(profile);
  const app = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`, "--no-sandbox"],
    env,
  });

  const mainPid = app.process().pid;
  console.log(`[acceptance] Session 1 Main Electron PID: ${mainPid}`);
  assert.ok(mainPid > 0, "Valid main PID");

  try {
    const page = await waitForWorkspaceWindow(app);
    console.log("[acceptance] Workspace shell and titlebar controls mounted.");

    console.log("[acceptance] Clicking Close button WITHOUT modifier (normal close)...");
    await page.click('[data-testid="window-control-close"]');

    // Wait 2 seconds to let the window close event process
    await sleep(2000);

    // Verify main process remains alive
    const alive = isPidAlive(mainPid);
    console.log(`[acceptance] Process ${mainPid} alive status after normal close: ${alive}`);
    assert.equal(alive, true, "Main Electron process MUST remain alive on normal close (close-to-tray preserved)");
    console.log("[PASS] Test Case 1 passed: Normal Close preserves close-to-tray behavior.");
  } finally {
    killTree(mainPid);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

async function runShiftCloseTest(executablePath) {
  console.log("\n=======================================================");
  console.log("==> Test Case 2: Shift+Click Close (Full Orderly Exit)");
  console.log("=======================================================");
  const tempBase = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "Temp");
  const profile = fs.mkdtempSync(path.join(tempBase, "zaicode-shift-close-"));
  fs.writeFileSync(
    path.join(profile, "zaicode-engines.json"),
    JSON.stringify({ keepWindowsRolling: false }),
  );

  const env = createTestEnv(profile);
  const app = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`, "--no-sandbox"],
    env,
  });

  const mainPid = app.process().pid;
  console.log(`[acceptance] Session 2 Main Electron PID: ${mainPid}`);
  assert.ok(mainPid > 0, "Valid main PID");

  try {
    const page = await waitForWorkspaceWindow(app);
    console.log("[acceptance] Workspace shell and titlebar controls mounted.");

    // Settle background initializations and collect child processes
    await sleep(2000);
    const initialChildren = getChildren(mainPid);
    console.log(`[acceptance] Initial child processes (${initialChildren.length}): ${initialChildren.join(", ")}`);

    console.log("[acceptance] Clicking Close button WITH Shift modifier (Shift+Click)...");
    await page.click('[data-testid="window-control-close"]', { modifiers: ["Shift"] });

    console.log("[acceptance] Awaiting orderly application quit and process termination...");
    let exited = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (!isPidAlive(mainPid)) {
        exited = true;
        break;
      }
    }

    assert.equal(exited, true, "Main Electron process terminated within shutdown deadline");
    console.log(`[acceptance] Main Electron PID ${mainPid} exited cleanly.`);

    // Check all initial children
    await sleep(1000);
    const survivedChildren = initialChildren.filter((p) => isPidAlive(p));
    console.log(`[acceptance] Surviving child processes: ${survivedChildren.length}`);
    assert.equal(survivedChildren.length, 0, `All owned child processes terminated; no orphans: ${survivedChildren.join(", ")}`);
    console.log("[PASS] Test Case 2 passed: Shift+Click cleanly terminated entire owned process tree.");
  } finally {
    if (isPidAlive(mainPid)) {
      killTree(mainPid);
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
  }
}

async function main() {
  const executablePath = path.resolve(
    __dirname,
    "../dist-next/win-unpacked/ZAICODE.exe",
  );
  assert.ok(fs.existsSync(executablePath), `staged executable exists: ${executablePath}`);

  await runNormalCloseTest(executablePath);
  await runShiftCloseTest(executablePath);

  console.log("\n=======================================================");
  console.log("ALL ACCEPTANCE CHECKS PASSED: Normal and Shift+Close OK!");
  console.log("=======================================================\n");
}

main().catch((err) => {
  console.error("FAIL acceptance test:", err);
  process.exit(1);
});
