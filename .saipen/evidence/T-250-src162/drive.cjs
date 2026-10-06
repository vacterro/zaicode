// T-250 / SRC-162 packaged-app check. Drives the staged dist-next build against a throw-away
// profile (the operator's live profile is never touched) and records what the UI actually does
// for the SRC-162 complaints that can be driven without a model: Auto retry click/right-click,
// the composer `+` row, tooltip anchoring, the side-pane double-click and the limits card.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const root = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE";
const { _electron } = createRequire(path.join(root, "zcode/packages/desktop/package.json"))("playwright-core");
const exe = path.resolve(process.env.T250_EXE || path.join(root, "zcode/packages/desktop/dist-next/win-unpacked/ZAICODE.exe"));
const out = process.env.T250_OUT || path.join(root, ".saipen/evidence/T-250-src162/packaged");
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zaicode-t250-"));
const project = path.join(profile, "t250-project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(profile, "zaicode-engines.json"), JSON.stringify({ keepWindowsRolling: false }));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [], check = (name, pass, detail) => checks.push({ name, pass: pass === null ? null : !!pass, ...(detail === undefined ? {} : { detail }) });
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".png") });

(async () => {
  let app, page, stage = "boot";
  const errors = [];
  const env = { ...process.env, ZCODE_ZAICODE_MODE: "1", ZAICODE_UPDATES: "off", ZCODE_DESKTOP_APPLICATION_NAME: "ZAICODE T250 " + path.basename(profile), ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DESKTOP_USER_DATA_DIR: profile, ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"), ZCODE_DATA_BASE_DIR: profile, ZCODE_HOME: path.join(profile, ".zcode"), USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"), ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization") };
  delete env.TZ; delete env.SAIMAIL_WORKSPACE; delete env.ZAICODE_INSTALL_ROOT;
  for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
  try {
    app = await _electron.launch({ executablePath: exe, args: ["--user-data-dir=" + profile], env, timeout: 120000 });
    page = await (async () => { const end = Date.now() + 90000; while (Date.now() < end) { const hit = app.windows().find((w) => w.url().includes("/out/renderer/index.html")); if (hit) return hit; await pause(100); } throw new Error("no renderer"); })();
    page.on("pageerror", (e) => errors.push({ stage, message: String(e).split("\n")[0] }));
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90000 });
    await page.evaluate(() => localStorage.setItem("zcode-locale-preference", "en-US"));
    await page.reload(); await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90000 });
    await page.setViewportSize({ width: 959, height: 1060 });

    stage = "open project";
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, project);
    await page.getByTestId("project-add").click();
    await page.getByRole("menuitem", { name: "Open folder", exact: true }).click();
    const row = page.locator('[data-testid^="workspace-item"]').filter({ hasText: "t250-project" }).first();
    await row.waitFor({ state: "visible", timeout: 30000 }); await row.click();

    stage = "auto retry click";
    const retry = page.locator('[data-testid="zaicode-auto-retry"]').first();
    await retry.waitFor({ state: "visible", timeout: 60000 });
    const states = [await retry.getAttribute("data-zaicode-auto-retry")];
    const labels = [await retry.getAttribute("aria-label")];
    for (let i = 0; i < 4; i += 1) { await retry.click(); await pause(400); states.push(await retry.getAttribute("data-zaicode-auto-retry")); labels.push(await retry.getAttribute("aria-label")); }
    check("every click flips the Auto retry button", states.every((s, i) => i === 0 || s !== states[i - 1]), { states, labels });

    stage = "auto retry right-click";
    await retry.click({ button: "right" }); await pause(400);
    const panel = page.getByText("Open retry settings");
    check("right-click opens the Auto retry panel", await panel.isVisible().catch(() => false));
    check("the panel offers no app-menu mode that could kill the right button", (await page.getByText("Opens the app menu").count()) === 0);
    await shot(page, "retry-panel");
    await page.keyboard.press("Escape"); await pause(300);
    await retry.click({ button: "right" }); await pause(400);
    check("right-click still opens the panel the second time", await panel.isVisible().catch(() => false));
    await page.keyboard.press("Escape"); await pause(300);

    stage = "composer plus row";
    for (const width of [959, 820, 700, 600]) {
      await page.setViewportSize({ width, height: 1060 }); await pause(700);
      const geometry = await page.evaluate(() => {
        const toolbar = document.querySelector("[data-composer-leading-actions]")?.parentElement;
        const leading = document.querySelector("[data-composer-leading-actions]");
        const trailing = document.querySelector("[data-composer-trailing-actions]");
        if (!toolbar || !leading || !trailing) return null;
        const l = leading.getBoundingClientRect(), t = trailing.getBoundingClientRect(), r = toolbar.getBoundingClientRect();
        const kids = Array.from(trailing.children).map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0);
        const firstTop = kids.length ? Math.min(...kids.map((b) => b.top)) : t.top;
        return { toolbar: { top: r.top, height: r.height, width: r.width }, leading: { top: l.top, bottom: l.bottom, width: l.width }, trailing: { top: t.top, bottom: t.bottom, width: t.width }, firstTrailingTop: firstTop };
      });
      const alone = geometry && geometry.firstTrailingTop >= geometry.leading.bottom - 1;
      check(`composer + shares its row with trailing controls at ${width}px`, Boolean(geometry) && !alone, geometry);
      await shot(page, `composer-${width}`);
    }
    await page.setViewportSize({ width: 959, height: 1060 }); await pause(500);

    stage = "tooltip anchoring";
    // Hover a hover-only sidebar action, then leave the row: no tooltip may survive in a corner.
    await row.hover(); await pause(300);
    const main = row.locator("[data-zaicode-main-button]").first();
    if (await main.count()) {
      await main.hover(); await pause(500);
      await page.mouse.move(700, 600); await pause(600);
      const corner = await page.evaluate(() => Array.from(document.querySelectorAll('[data-slot="tooltip-content"]')).map((el) => { const b = el.getBoundingClientRect(); const v = getComputedStyle(el.parentElement || el).visibility; return { x: b.x, y: b.y, w: b.width, h: b.height, visibility: v, text: el.textContent?.slice(0, 40) }; }).filter((t) => t.w > 0 && t.visibility !== "hidden"));
      check("no row tooltip lingers after the pointer leaves the row", corner.length === 0, corner);
    } else check("sidebar MAIN button present for the tooltip probe", false);

    stage = "limits card";
    const meter = page.locator("[data-zaicode-limit-meter]").first();
    if (await meter.count()) {
      await meter.hover(); await pause(1500);
      const card = await page.evaluate(() => { const p = document.querySelector("[data-zaicode-limits-panel]"); if (!p) return null; const b = p.getBoundingClientRect(); const labels = Array.from(p.querySelectorAll("[data-zaicode-account-limits]")).map((a) => ({ id: a.getAttribute("data-zaicode-account-limits"), rows: Array.from(a.querySelectorAll(":scope > div.grid > span:first-child")).map((s) => s.textContent) })); return { height: b.height, width: b.width, accounts: labels }; });
      check("limits card renders", Boolean(card), card);
      if (card) {
        const dupes = card.accounts.filter((a) => new Set(a.rows).size !== a.rows.length);
        check("no account shows two rows with the same label", dupes.length === 0, dupes);
        const numbers = await page.evaluate(() => Array.from(document.querySelectorAll("[data-zaicode-limits-panel] [data-zaicode-account-limits]")).map((a) => ({ id: a.getAttribute("data-zaicode-account-limits"), sig: Array.from(a.querySelectorAll(":scope > div.grid")).map((r) => r.textContent).join("|") })).filter((a) => a.sig));
        const seen = new Map(); const twins = [];
        for (const a of numbers) { if (seen.has(a.sig)) twins.push([seen.get(a.sig), a.id]); else seen.set(a.sig, a.id); }
        check("no two accounts show the identical quota block (one subscription, two rows)", twins.length === 0, twins);
        const clipped = await page.evaluate(() => Array.from(document.querySelectorAll("[data-zaicode-limits-panel] div.grid > span:first-child")).filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent));
        check("no window label is cut off", clipped.length === 0, clipped);
      }
      await shot(page, "limits-card");
      await page.mouse.move(400, 600); await pause(400);
    } else check("limit meter present", false);

    stage = "side pane double-click";
    const handle = page.locator('[data-workspace-side-pane-resize-handle="true"]').first();
    if (await handle.count() && await handle.isVisible()) {
      const box = await handle.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x - 80, box.y + box.height / 2, { steps: 8 }); await page.mouse.up(); await pause(400);
      const before = (await handle.boundingBox()).x;
      await handle.dblclick(); await pause(600);
      const after = (await handle.boundingBox()).x;
      check("double-click on the side pane edge keeps the dragged width", Math.abs(after - before) < 2, { before, after });
    } else check("side pane handle visible (pane open) for the double-click probe", null, "pane closed in a fresh profile: not driven");

    await pause(300);
    check("zero renderer exceptions", errors.length === 0, errors);
    const receipt = { at: new Date().toISOString(), executablePath: exe, profile, checks, errors, pass: checks.filter((c) => c.pass !== null).every((c) => c.pass), asarSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(path.dirname(exe), "resources/app.asar"))).digest("hex") };
    fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ pass: receipt.pass, checks: checks.map((c) => `${c.pass ? "PASS" : c.pass === null ? "SKIP" : "FAIL"} ${c.name}`) }, null, 1));
  } catch (error) {
    if (page) await shot(page, "error").catch(() => {});
    fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify({ pass: false, stage, checks, errors, error: String(error.stack || error) }, null, 2));
    console.error(stage, String(error)); console.log(JSON.stringify(checks.map((c) => `${c.pass ? "PASS" : "FAIL"} ${c.name}`), null, 1));
    process.exitCode = 1;
  } finally { if (app) try { await app.close(); } catch {} }
})();
