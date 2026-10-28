// node packages/desktop/scripts/verify-zaicode-usage.cjs [packaged executable]
// Uses real UI controls and GET-only router data; never dispatches work or edits the operator profile.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { _electron } = require("playwright-core");

const root = path.resolve(__dirname, "../../..");
const out = path.join(root, ".e2e-cache", "usage-t181");
const opaque = /[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i;

async function main() {
  await fs.mkdir(out, { recursive: true });
  const profile = await fs.mkdtemp(path.join(out, "profile-"));
  const env = {
    ...process.env,
    ZCODE_ZAICODE_MODE: "1",
    ZCODE_ZAICODE_IDENTITY: "1",
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE Usage ${path.basename(profile)}`,
    ZCODE_DESKTOP_HOME_DIR: profile,
    ZCODE_DESKTOP_USER_DATA_DIR: profile,
    ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"),
    ZCODE_DATA_BASE_DIR: profile,
    ZCODE_HOME: path.join(profile, ".zcode"),
    HOME: profile,
    USERPROFILE: profile,
    ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization"),
    ZAICODE_UPDATES: "off",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SAIMAIL_WORKSPACE;
  delete env.ZAICODE_INSTALL_ROOT;
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
  }
  // APPDATA remains unchanged solely so the existing main-process transport can
  // authenticate GET requests to the operator's 9router. Credentials never enter this report.
  const executablePath = process.argv[2] ? path.resolve(process.argv[2]) : require("electron");
  const args = process.argv[2] ? [] : [path.join(root, "packages/desktop")];
  const checks = [];
  const errors = [];
  let app;
  let page;
  const report = { profile, checks, errors, verdict: "FAIL" };
  try {
    app = await _electron.launch({ executablePath, args: [...args, `--user-data-dir=${profile}`], env, timeout: 90_000 });
    page = await app.waitForEvent("window", { predicate: (window) => window.url().includes("renderer/index.html"), timeout: 60_000 })
      .catch(() => app.windows().find((window) => window.url().includes("renderer/index.html")));
    assert.ok(page, "main renderer opens");
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90_000 });
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.keyboard.press("Control+Alt+b");
    const usage = page.locator("[data-zaicode-usage]");
    await usage.waitFor({ timeout: 15_000 });
    await usage.getByRole("button", { name: "Full page", exact: true }).click();
    await page.locator('[data-zaicode-usage="page"]').waitFor();
    await usage.getByText(/^Updated /).waitFor({ timeout: 25_000 });
    assert.equal(await usage.getByRole("alert").count(), 0, "live 9router data loads");
    await usage.getByRole("checkbox").uncheck();
    checks.push("Usage reads live router through the existing desktop bridge");

    async function noOpaque() {
      assert.doesNotMatch(await usage.innerText(), opaque);
      const titles = await usage.locator("[title]").evaluateAll((nodes) => nodes.map((node) => node.title).join("\n"));
      assert.doesNotMatch(titles, opaque);
    }
    async function numericLayout() {
      const oversized = await usage.locator("tbody td").evaluateAll((cells) => cells.filter((cell) => {
        if (!cell.firstChild || cell.firstChild.nodeType !== Node.TEXT_NODE) return false;
        const range = document.createRange();
        range.selectNodeContents(cell);
        const box = cell.getBoundingClientRect();
        return [...range.getClientRects()].some((rect) => rect.left < box.left - 1 || rect.right > box.right + 1);
      }).map((cell) => cell.textContent));
      assert.deepEqual(oversized, [], "numeric text stays in its own cells");
    }
    for (const tab of ["Recent requests", "Models", "Providers", "Accounts"]) {
      const control = usage.getByRole("tab", { name: tab, exact: true });
      await control.click();
      assert.equal(await control.getAttribute("aria-selected"), "true");
      assert.equal(await usage.locator('[role="tab"][aria-selected="true"]').count(), 1);
      await noOpaque();
      await numericLayout();
    }
    checks.push("All breakdowns show readable names, one selection and no UUIDs, including tooltips");
    for (const period of ["24H", "7D", "30D", "60D", "All", "Today"]) {
      const control = usage.getByRole("button", { name: period, exact: true });
      await control.click();
      await usage.getByRole("button", { name: "Refresh", exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('[data-zaicode-usage] button:disabled'), null, { timeout: 25_000 });
      assert.equal(await control.getAttribute("aria-pressed"), "true");
      assert.equal(await usage.getByRole("alert").count(), 0);
    }
    await usage.getByRole("button", { name: "Cost", exact: true }).click();
    assert.equal(await usage.getByRole("button", { name: "Cost", exact: true }).getAttribute("aria-pressed"), "true");
    checks.push("All periods and metric controls work with live GET responses");
    assert.equal(await usage.locator('button[data-variant="default"]').count(), 0, "no bright default button fills");
    await page.screenshot({ path: path.join(out, "full-page.png") });
    await page.setViewportSize({ width: 640, height: 540 });
    await noOpaque();
    await numericLayout();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "page has no horizontal overflow");
    await page.screenshot({ path: path.join(out, "compact-page.png") });
    await usage.getByRole("button", { name: "Sidebar", exact: true }).click();
    await page.locator('[data-zaicode-usage="sidebar"]').waitFor();
    await usage.getByText(/^Updated /).waitFor({ timeout: 25_000 });
    for (const tab of ["Recent requests", "Providers", "Accounts"]) {
      await usage.getByRole("tab", { name: tab, exact: true }).click();
      await noOpaque();
      await numericLayout();
    }
    await page.screenshot({ path: path.join(out, "compact-sidebar.png") });
    await usage.getByRole("button", { name: "Close", exact: true }).click();
    await usage.waitFor({ state: "detached" });
    await page.keyboard.press("Control+Alt+b");
    await usage.waitFor();
    await page.keyboard.press("Control+Alt+b");
    await usage.waitFor({ state: "detached" });
    checks.push("640x540 page/sidebar, numeric layout, close/reopen and shortcut pass");
    assert.deepEqual(errors, []);
    report.verdict = "PASS";
  } catch (error) {
    report.failure = String(error.stack || error);
    if (page) await page.screenshot({ path: path.join(out, "failure.png") }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await fs.writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
    if (app) await app.close();
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
