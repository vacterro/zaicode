// Actual packaged regression: a drawn rail button must receive its own clicks.
const fs = require("node:fs/promises");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
const assert = require("node:assert/strict");

async function run({ electron, executablePath, out }) {
  await fs.mkdir(out, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "zaicode-rail-header-"));
  const project = path.join(profile, "rail-header-project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(profile, "zaicode-engines.json"), JSON.stringify({ keepWindowsRolling: false, intervalMinutes: 0 }));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
  await fs.writeFile(path.join(profile, "zaicode-router-host.json"), JSON.stringify({ mode: "isolated", port }));
  const env = {
    ...process.env, ZCODE_ZAICODE_MODE: "1", ZCODE_ZAICODE_IDENTITY: "1", ZAICODE_UPDATES: "off",
    ZCODE_DESKTOP_APPLICATION_NAME: "ZAICODE rail regression " + path.basename(profile),
    ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"), ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"), HOME: profile, USERPROFILE: profile,
    APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"),
    ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization"),
  };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW|ELECTRON_RUN_AS_NODE|SAIMAIL_WORKSPACE|ZAICODE_INSTALL_ROOT)/i.test(key)) delete env[key];
  }
  const report = { at: new Date().toISOString(), executablePath, profile, project, privateRouterPort: port, fixtureOnly: true, inferenceRequested: false, instrumentReady: false, checks: [], errors: [] };
  let app, page;
  try {
    app = await electron.launch({ executablePath, args: ["--user-data-dir=" + profile], env, timeout: 90000 });
    page = app.windows().find((window) => window.url().includes("renderer/index.html")) || await app.waitForEvent("window", { predicate: (window) => window.url().includes("renderer/index.html"), timeout: 60000 });
    page.on("pageerror", (error) => report.errors.push(String(error)));
    await page.locator("[data-workspace-shell=true]").waitFor({ timeout: 90000 });
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await page.getByTestId("project-add").click();
    await page.getByRole("menuitem", { name: "Open folder", exact: true }).click();
    await page.locator('[data-testid^="workspace-item-"]').filter({ hasText: "rail-header-project" }).first().waitFor();
    const home = page.locator("[data-zaicode-saihome]");
    if (await home.isVisible()) {
      await home.getByText("rail-header-project", { exact: true }).first().click();
      await home.getByRole("button", { name: "Go to project", exact: true }).click();
      await home.waitFor({ state: "hidden" });
    }
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes("renderer/index.html"));
      window.unmaximize(); window.setMinimumSize(280, 280); window.setContentSize(1280, 360);
    });
    await page.setViewportSize({ width: 1280, height: 360 });
    const handle = page.locator("[role=separator][aria-controls=sidebar]");
    await handle.focus(); await handle.press("Home");
    await page.locator("[data-zaicode-project-rail]").waitFor();
    await page.mouse.move(1200, 150); await page.keyboard.press("Escape");
    await page.getByRole("tooltip").waitFor({ state: "hidden", timeout: 5000 });
    const geometry = await page.evaluate(() => {
      const box = (element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const caption = [...document.querySelectorAll("[data-zaicode-sidebar-controls] button")].filter((button) => button.getBoundingClientRect().width > 0).map(box);
      const controls = [...document.querySelectorAll("[data-zaicode-project-rail] button")].map((button) => {
        const r = box(button), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { label: button.getAttribute("aria-label"), ...r, hit: hit === button || button.contains(hit), overlapsCaption: caption.some((c) => Math.min(r.x + r.width, c.x + c.width) - Math.max(r.x, c.x) > 1 && Math.min(r.y + r.height, c.y + c.height) - Math.max(r.y, c.y) > 1) };
      });
      return { caption, controls, width: innerWidth, height: innerHeight };
    });
    assert.ok(geometry.controls.length >= 4, "real rail includes project and three pinned controls");
    report.instrumentReady = true;
    report.checks.push({ name: "compact rail and caption actions remain independently reachable in a short native window", pass: geometry.controls.every((c) => c.hit && !c.overlapsCaption && c.x >= 0 && c.y >= 0 && c.x + c.width <= geometry.width && c.y + c.height <= geometry.height), detail: geometry });
    await page.screenshot({ path: path.join(out, "rail-header.png") });
  } catch (error) {
    report.error = String(error);
    if (page) await page.screenshot({ path: path.join(out, "instrument-failure.png") }).catch(() => {});
  } finally {
    if (app) await app.close().catch(() => {});
    report.pass = report.instrumentReady && !report.error && report.errors.length === 0 && report.checks.length === 1 && report.checks.every((check) => check.pass);
    await fs.writeFile(path.join(out, "receipt.json"), JSON.stringify(report, null, 2));
  }
  return report;
}

module.exports = { run };
