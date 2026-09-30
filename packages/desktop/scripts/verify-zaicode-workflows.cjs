const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chooseLocale(page, locale, nativeName) {
  const trigger = page.locator('[data-testid="settings-locale-select-trigger"]:visible');
  await trigger.click();
  await page.getByRole("option").filter({ hasText: nativeName }).click();
  await page.waitForFunction((tag) => document.documentElement.lang === tag, locale);
  assert.equal(await page.evaluate(() => localStorage.getItem("zcode-locale-preference")), locale);
  assert.equal(await page.evaluate(() => document.documentElement.dir), /^(ar|he)-/.test(locale) ? "rtl" : "ltr");
}

/** Uses visible controls on the boot gate's throw-away profile, without changing app stores directly. */
async function checkWorkflowControls(page, app, profile) {
  const nav = page.locator("nav").filter({ hasText: "Keyboard Shortcuts" }).first();
  assert.equal(await nav.getByRole("button", { name: "Hotkeys", exact: true }).count(), 0);
  await nav.getByRole("button", { name: "Keyboard Shortcuts", exact: true }).click();
  await page.locator('[data-zaicode-hotkeys-settings]').waitFor({ state: "visible" });
  await nav.getByRole("button", { name: "Sidebar", exact: true }).click();
  const swap = page.getByLabel("Swap left and right sidebars", { exact: true });
  await swap.check();
  await page.getByTestId("settings-back-button").click();
  await page.locator('[data-workspace-shell="true"]').waitFor();
  await sleep(400);
  const sidebar = page.locator('[data-workspace-sidebar-panel="true"]');
  const box = await sidebar.boundingBox();
  assert.ok(box && box.x > (await page.viewportSize()).width / 2, "swapped project sidebar is on the right");
  const separator = page.locator('[role="separator"][aria-controls="sidebar"]');
  await separator.focus();
  await separator.press("Home");
  await page.locator('[data-zaicode-project-rail]').waitFor({ state: "visible" });
  await sleep(300);
  assert.ok(Math.abs((await sidebar.boundingBox()).width - 52) <= 1, "compact project rail is 52px wide");
  await separator.press("ArrowLeft");
  await page.locator('[data-zaicode-project-rail]').waitFor({ state: "detached" });
  await sleep(300);
  assert.ok((await sidebar.boundingBox()).width >= 199, "swapped rail expands with the correct keyboard direction");
  const hitTargets = await checkProjectHitTargets(page, app, profile);
  await page.locator('button[aria-label="Settings"]:visible').first().click();
  await nav.getByRole("button", { name: "Sidebar", exact: true }).click();
  await swap.uncheck();
  await nav.getByRole("button", { name: "General", exact: true }).click();
  for (const [tag, nativeName] of [["ru-RU", "Русский"], ["et-EE", "Eesti"], ["ar-SA", "العربية"], ["en-US", "English"]]) {
    await chooseLocale(page, tag, nativeName);
  }
  return { mergedShortcuts: true, swappedSidebar: true, compactRail: true, keyboardExpansion: true, hitTargets, locales: ["ru-RU", "et-EE", "ar-SA", "en-US"] };
}

async function assertSeparateTargets(locator, minimum) {
  const targets = await locator.evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, label: button.getAttribute("aria-label") || button.textContent, reachable: button.disabled || hit === button || button.contains(hit) };
  }).filter((rect) => rect.width > 0 && rect.height > 0));
  assert.ok(targets.length >= minimum, `expected ${minimum} live hit targets, found ${targets.length}`);
  for (const [index, target] of targets.entries()) {
    assert.ok(target.reachable, `hit target is unobstructed: ${target.label}`);
    for (const other of targets.slice(index + 1)) {
      assert.ok(Math.min(target.x + target.width, other.x + other.width) <= Math.max(target.x, other.x) || Math.min(target.y + target.height, other.y + other.height) <= Math.max(target.y, other.y), `hit targets overlap: ${target.label} / ${other.label}`);
    }
  }
  return targets.length;
}

async function checkProjectHitTargets(page, app, profile) {
  const project = path.join(profile, "workflow-project");
  fs.mkdirSync(project, { recursive: true });
  // Only the native folder selection is supplied; project creation uses the visible UI and its real command.
  await app.evaluate(({ dialog }, folder) => {
    dialog.__zaicodeSmokeOriginal = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  try {
    await page.getByTestId("project-add").click();
    await page.getByRole("menuitem", { name: "Open folder", exact: true }).click();
    const row = page.locator('[data-testid^="workspace-item"]').filter({ hasText: "workflow-project" }).first();
    await row.waitFor({ state: "visible" });
    await row.hover();
    const actions = row.locator("xpath=ancestor::li").locator('[data-zaicode-row-zone] button');
    await page.locator('[data-zaicode-pin]').first().waitFor({ state: "visible" });
    const projectActions = await assertSeparateTargets(actions, 2);
    await page.getByTestId("zaicode-sidebar-open").click();
    await page.setViewportSize({ width: 640, height: 540 });
    await sleep(500);
    const tabs = page.locator('[data-zaicode-workspace-tab]');
    await tabs.first().waitFor({ state: "visible" });
    const headerActions = await assertSeparateTargets(tabs.locator("xpath=ancestor::header").locator("button"), 5);
    await page.setViewportSize({ width: 1200, height: 800 });
    return { projectActions, headerActions, narrowWidth: 640 };
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = dialog.__zaicodeSmokeOriginal; delete dialog.__zaicodeSmokeOriginal; });
  }
}

module.exports = { checkWorkflowControls, chooseLocale };
