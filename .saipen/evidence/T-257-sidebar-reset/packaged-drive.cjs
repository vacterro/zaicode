const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const root = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE";
const { _electron } = createRequire(path.join(root, "zcode/packages/desktop/package.json"))("playwright-core");
const exe = process.env.T257_EXE || path.join(root, "zcode/packages/desktop/dist-t254/win-unpacked/ZAICODE.exe");
const out = process.env.T257_OUT || path.join(root, ".saipen/evidence/T-257-sidebar-reset/packaged");
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zaicode-t257-profile-"));
fs.writeFileSync(path.join(profile, "zaicode-engines.json"), JSON.stringify({ keepWindowsRolling: false }));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const receipt = { ticket: "T-257", profile, executable: exe, checks: [] };
  const errors = [];
  const check = (name, pass, detail) => { receipt.checks.push({ name, pass: Boolean(pass), detail }); console.error(`${pass ? "PASS" : "FAIL"} ${name}`); };
  let app, page;
  try {
    const env = { ...process.env, ZCODE_ZAICODE_MODE: "1", ZAICODE_UPDATES: "off",
      ZCODE_DESKTOP_APPLICATION_NAME: "ZAICODE T257 " + path.basename(profile),
      ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DESKTOP_USER_DATA_DIR: profile,
      ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"), ZCODE_DATA_BASE_DIR: profile,
      USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"),
      ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization") };
    for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
    delete env.TZ; delete env.SAIMAIL_WORKSPACE; delete env.ZAICODE_INSTALL_ROOT;
    app = await _electron.launch({ executablePath: exe, args: ["--user-data-dir=" + profile], env, timeout: 120_000 });
    const end = Date.now() + 90_000;
    while (!page && Date.now() < end) { page = app.windows().find((w) => w.url().includes("/out/renderer/index.html")); if (!page) await pause(150); }
    if (!page) throw new Error("No renderer");
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90_000 });
    await page.setViewportSize({ width: 1280, height: 960 });
    const handle = () => page.locator('[role="separator"][aria-controls="sidebar"]');
    const prepare = async (width, swapped) => {
      await page.evaluate(({ width, swapped }) => {
        localStorage.setItem("zcode-locale-preference", "en-US");
        localStorage.setItem("zcode:workspace-shell:sidebar-width-px", String(width));
        localStorage.setItem("zaicode-sidebar-prefs-v1", JSON.stringify({ sidebarsSwapped: swapped, navOpen: true }));
        localStorage.setItem("zaicode-home-v1", JSON.stringify({ startup: "home", lastView: "home" }));
      }, { width, swapped });
      await page.reload();
      await handle().waitFor({ state: "visible", timeout: 60_000 });
      await page.waitForFunction((expected) => Number(document.querySelector('[role="separator"][aria-controls="sidebar"]')?.getAttribute("aria-valuenow")) === expected, width, { timeout: 30_000 });
    };
    const widthOf = () => page.locator("#sidebar").evaluate((element) => element.getBoundingClientRect().width);
    for (const swapped of [false, true]) {
      const side = swapped ? "right" : "left";
      await prepare(420, swapped);
      const box = await handle().boundingBox();
      if (!box) throw new Error("No resize target");
      check(`${side}: separator follows stored placement`, swapped ? box.x > 640 : box.x < 640, box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + (swapped ? -80 : 80), box.y + box.height / 2, { steps: 4 });
      await page.mouse.up();
      const dragged = await widthOf();
      check(`${side}: normal drag still widens the sidebar`, dragged === 500, dragged);
      await handle().dblclick({ timeout: 15_000 });
      await pause(100);
      const reset = await widthOf();
      const aria = await handle().getAttribute("aria-valuenow");
      const saved = await page.evaluate(() => localStorage.getItem("zcode:workspace-shell:sidebar-width-px"));
      check(`${side}: double-click restores actual width and aria to default 264`, reset === 264 && aria === "264", { reset, aria });
      check(`${side}: reset persists the existing pixel preference`, saved === "264", saved);
      await page.reload();
      await handle().waitFor({ state: "visible", timeout: 60_000 });
      check(`${side}: reset survives reload`, (await widthOf()) === 264, await widthOf());
      await prepare(52, swapped);
      await handle().dblclick({ timeout: 15_000 });
      await pause(100);
      check(`${side}: rail double-click restores default 264`, (await widthOf()) === 264, await widthOf());
      await page.screenshot({ path: path.join(out, side + "-reset.png") });
    }
    check("zero renderer exceptions", errors.length === 0, errors);
    receipt.pass = receipt.checks.every((value) => value.pass);
  } catch (error) { receipt.pass = false; receipt.error = String(error); if (page) await page.screenshot({ path: path.join(out, "error.png") }).catch(() => {}); }
  finally {
    receipt.errors = errors;
    const asar = path.join(path.dirname(exe), "resources/app.asar");
    if (fs.existsSync(asar)) receipt.asarSha256 = crypto.createHash("sha256").update(fs.readFileSync(asar)).digest("hex");
    fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
    if (app) await app.close().catch(() => {});
  }
  console.log(JSON.stringify({ pass: receipt.pass, checks: receipt.checks.length, error: receipt.error }));
  if (!receipt.pass) process.exitCode = 1;
})();
