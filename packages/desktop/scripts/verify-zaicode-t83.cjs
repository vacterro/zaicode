// Packaged ZAICODE smoke test. Run after REBUILD.cmd on Windows:
//   node packages/desktop/scripts/verify-zaicode-t83.cjs
// Set ZAICODE_T83_OUT_DIR to keep screenshots of the game and narrow layout.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const executablePath =
  process.argv[2] ?? path.resolve(__dirname, "../dist-next/win-unpacked/ZAICODE.exe");
const tempBase = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "Temp");
fs.mkdirSync(tempBase, { recursive: true });
const profile = fs.mkdtempSync(path.join(tempBase, "zaicode-t83-"));
const outDir = process.env.ZAICODE_T83_OUT_DIR;
if (outDir) fs.mkdirSync(outDir, { recursive: true });

async function main() {
  const env = {
    ...process.env,
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE T83 ${path.basename(profile)}`,
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"),
  };
  delete env.TZ;
  let app;
  try {
    app = await _electron.launch({
      executablePath,
      args: [`--user-data-dir=${profile}`],
      env,
      timeout: 90_000,
    });
    const deadline = Date.now() + 60_000;
    let page;
    while (!page && Date.now() < deadline) {
      page = app
        .windows()
        .find((window) => !window.isClosed() && window.url().includes("/out/renderer/index.html"));
      if (!page) await sleep(500);
    }
    assert.ok(page, "packaged app opens its main window");
    await page.waitForFunction(
      () => {
        const body = document.body.innerText.trim();
        return body.length > 100 && !body.includes("ZAICODE will open when preparation finishes");
      },
      null,
      { timeout: 120_000 },
    );
    assert.equal(await page.title(), "ZAICODE");

    await page.evaluate(() => window.dispatchEvent(new Event("zaicode-pebble-open")));
    const game = page.locator("[data-zaicode-pebble-game]");
    await game.waitFor({ timeout: 10_000 });
    assert.equal(await game.count(), 1);
    if (outDir) await page.screenshot({ path: path.join(outDir, "pebble-title.png") });

    await game.getByTitle("Fullscreen").click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement), null, {
      timeout: 10_000,
    });
    await page.evaluate(() => document.exitFullscreen());
    const popup = app.waitForEvent("window", { timeout: 10_000 });
    await game.getByTitle("Detach into its own window").click();
    const child = await popup;
    await child.locator("[data-zaicode-pebble-game]").waitFor({ timeout: 10_000 });
    const closed = child.waitForEvent("close", { timeout: 10_000 });
    await child.getByTitle("Close").click();
    await closed;

    await page.evaluate(() => window.dispatchEvent(new Event("zaicode-pebble-open")));
    await game.waitFor({ timeout: 10_000 });
    await page.keyboard.press("Space");
    await page.keyboard.press("KeyP");
    await page.keyboard.press("KeyR");
    await page.keyboard.press("Escape");
    await game.waitFor({ state: "detached", timeout: 10_000 });

    await page.setViewportSize({ width: 640, height: 540 });
    const strip = page.locator("[data-zaicode-session-actions]");
    assert.equal(await strip.count(), 1);
    assert.equal(await strip.evaluate((node) => node.scrollWidth > node.clientWidth), false);
    assert.equal(
      await page.locator('[data-testid="desktop-window-controls"] button:visible').count(),
      3,
    );
    if (outDir) await page.screenshot({ path: path.join(outDir, "narrow-home.png") });
    console.log(
      "PASS packaged startup, game controls/fullscreen/detach, 640x540 action strip and caption buttons",
    );
  } finally {
    if (app) await app.close();
    const resolvedBase = path.resolve(tempBase);
    const resolvedProfile = path.resolve(profile);
    if (resolvedProfile.startsWith(`${resolvedBase}${path.sep}`)) {
      fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
