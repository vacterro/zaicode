// Observes the production MessagePort protocol and React commit hook. No app source or RPC results are replaced.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const root = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE";
const { _electron } = createRequire(path.join(root, "zcode/packages/desktop/package.json"))("playwright-core");
const exe = process.env.T254_EXE || path.join(root, "zcode/packages/desktop/dist-t254/win-unpacked/ZAICODE.exe");
const out = process.env.T254_OUT || path.join(root, ".saipen/evidence/T-254-home-overview/packaged");
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "zaicode-t254-profile-"));
fs.writeFileSync(path.join(profile, "zaicode-engines.json"), JSON.stringify({ keepWindowsRolling: false }));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function dismissToasts(page) {
  const host = page.locator('[data-zaicode-toast-host]');
  if (!(await host.count())) return;
  const all = host.getByRole("button", { name: "Dismiss all", exact: true });
  if (await all.count()) await all.click();
  else await host.getByRole("button", { name: "Dismiss", exact: true }).first().click();
}

function installObservers() {
  const metrics = window.__t254 = { calls: {}, jobLists: [], overviews: [], errors: [], rootCommits: 0, homeRootCommits: 0, manualRefreshes: 0 };
  const decoder = new TextDecoder();
  function reader(bytes) {
    let offset = 0;
    const vql = () => { let n = 0, shift = 0, b; do { b = bytes[offset++]; n |= (b & 127) << shift; shift += 7; } while (b & 128); return n; };
    const read = () => {
      const tag = bytes[offset++];
      if (tag === 0) return undefined;
      if (tag === 6) return vql();
      if (tag === 4) { const n = vql(), array = []; for (let i = 0; i < n; i++) array.push(read()); return array; }
      const n = vql(), slice = bytes.subarray(offset, offset + n); offset += n;
      if (tag === 1) return decoder.decode(slice);
      if (tag === 5) return JSON.parse(decoder.decode(slice));
      if (tag === 2 || tag === 3) return slice;
      throw new Error("Unknown RPC type " + tag);
    };
    return read;
  }
  const pendingByPort = new WeakMap();
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (...args) {
    let pending = pendingByPort.get(this);
    if (!pending) {
      pending = new Map(); pendingByPort.set(this, pending);
      this.addEventListener("message", (event) => {
        if (!(event.data instanceof Uint8Array)) return;
        try {
          const read = reader(event.data), header = read();
          const request = Array.isArray(header) && pending.get(header[1]);
          if (!request) return;
          pending.delete(header[1]);
          if (header[0] === 201) {
            const body = read();
            metrics.overviews.push({ channel: request.channel, elapsedMs: performance.now() - request.at,
              responseBytes: event.data.length, rows: body.jobs.length, diagnostics: body.diagnostics.length,
              counts: body.counts, doneLast24h: body.doneLast24h, dayStart: body.dayStart, capturedAt: body.capturedAt,
              openIds: body.jobs.filter((job) => !["completed","failed","cancelled"].includes(job.status)).map((job) => job.id).sort() });
          } else metrics.errors.push({ type: header[0], method: "getHomeOverview" });
        } catch (error) { metrics.errors.push({ observer: String(error) }); }
      });
    }
    if (args[0] instanceof Uint8Array) {
      try {
        const read = reader(args[0]), header = read();
        if (Array.isArray(header) && header[0] === 100) {
          const key = header[2] + "." + header[3]; metrics.calls[key] = (metrics.calls[key] || 0) + 1;
          if (header[3] === "getHomeOverview") pending.set(header[1], { at: performance.now(), channel: header[2] });
          if (header[3] === "list") {
            const filter = read()?.[0];
            metrics.jobLists.push({ channel: header[2], workspaceFilter: Boolean(filter?.workspaceKey), bounded: Number.isFinite(filter?.limit) && filter.limit > 0 });
          }
        }
      } catch { /* The connection context packet is not an RPC request. */ }
    }
    return Reflect.apply(post, this, args);
  };
  const renderers = new Map();
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers,
    inject(renderer) { const id = renderers.size + 1; renderers.set(id, renderer); return id; },
    onCommitFiberRoot() { metrics.rootCommits++; if (document.querySelector("[data-zaicode-saihome]")) metrics.homeRootCommits++; },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
  };
}

(async () => {
  const receipt = { ticket: "T-254", executablePath: exe, profile, fixtureRows: 500_021, checks: [] };
  const check = (name, pass, detail) => { receipt.checks.push({ name, pass: Boolean(pass), detail }); console.error(`${pass ? "PASS" : "FAIL"} ${name}`); };
  const validOverview = (value) => value.rows === 26 && value.diagnostics === 0
    && JSON.stringify(value.counts) === JSON.stringify({ running: 1, ready: 2, waiting: 2, blocked: 1, doneToday: 12, failedToday: 3 }) && value.doneLast24h === 12;
  let app, page, stage = "seed";
  const pageErrors = [];
  try {
    const seed = spawnSync(process.execPath, ["--import", "tsx", path.join(root, ".saipen/evidence/T-254-home-overview/seed-packaged.mts"), path.join(profile, ".zaicode/v2/tasks-index.sqlite")], { cwd: path.join(root, "zcode"), encoding: "utf8", timeout: 120_000 });
    if (seed.status !== 0) throw new Error("Fixture seed failed: " + seed.stderr);
    receipt.seed = JSON.parse(seed.stdout);
    stage = "boot";
    const env = { ...process.env, ZCODE_ZAICODE_MODE: "1", ZAICODE_UPDATES: "off",
      ZCODE_DESKTOP_APPLICATION_NAME: "ZAICODE T254 " + path.basename(profile),
      ZCODE_DESKTOP_HOME_DIR: profile, ZCODE_DESKTOP_USER_DATA_DIR: profile,
      ZCODE_DESKTOP_SESSION_DATA_DIR: path.join(profile, "session"), ZCODE_DATA_BASE_DIR: profile,
      USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, "AppData/Roaming"), LOCALAPPDATA: path.join(profile, "AppData/Local"),
      ZAICODE_CUSTOMIZATION_DIR: path.join(profile, "customization") };
    for (const key of Object.keys(env)) if (/^(CLAUDE|CODEX|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|AI_AGENT|ZCODE_ZAICODE_PREVIEW)/i.test(key)) delete env[key];
    delete env.TZ; delete env.SAIMAIL_WORKSPACE; delete env.ZAICODE_INSTALL_ROOT;
    app = await _electron.launch({ executablePath: exe, args: ["--user-data-dir=" + profile], env, timeout: 120_000 });
    app.process().on("exit", (code, signal) => { receipt.childExit = { code, signal }; });
    const startupErrors = [];
    app.process().stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) if (/uncaught|fatal|exception|startup.*fail|checksum.*mismatch/i.test(line)) startupErrors.push(line.slice(0, 600));
      receipt.startupErrors = startupErrors.slice(-15);
    });
    await app.context().addInitScript(installObservers);
    const end = Date.now() + 90_000;
    while (!page && Date.now() < end) { page = app.windows().find((window) => window.url().includes("/out/renderer/index.html")); if (!page) await pause(150); }
    if (!page) throw new Error("No renderer window");
    page.on("pageerror", (error) => pageErrors.push({ stage, error: String(error) }));
    await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 90_000 });
    await page.evaluate(() => {
      localStorage.setItem("zcode-locale-preference", "en-US");
      localStorage.setItem("zaicode-home-v1", JSON.stringify({ startup: "home", lastView: "home", preset: "everything", refreshSeconds: 15 }));
    });
    await page.reload();
    await page.locator('[data-zaicode-saihome]').waitFor({ timeout: 90_000 });
    await page.waitForFunction(() => window.__t254?.overviews.length > 0, null, { timeout: 60_000 });
    stage = "known-bad fixture control";
    const { DatabaseSync } = require("node:sqlite");
    const control = new DatabaseSync(path.join(profile, ".zaicode/v2/tasks-index.sqlite"));
    try {
      control.prepare("UPDATE zaicode_jobs SET status='blocked' WHERE job_id='old-running'").run();
      let before = await page.evaluate(() => window.__t254.overviews.length);
      await dismissToasts(page);
      await page.locator('[data-zaicode-saihome]').getByRole("button", { name: "Refresh", exact: true }).click();
      await page.waitForFunction((count) => window.__t254.overviews.length > count, before, { timeout: 60_000 });
      const bad = await page.evaluate(() => window.__t254.overviews.at(-1));
      check("same packaged count oracle rejects a real wrong fixture", !validOverview(bad) && bad.counts.running === 0 && bad.counts.blocked === 2, bad);
      control.prepare("UPDATE zaicode_jobs SET status='running' WHERE job_id='old-running'").run();
      before = await page.evaluate(() => window.__t254.overviews.length);
      await dismissToasts(page);
      await page.locator('[data-zaicode-saihome]').getByRole("button", { name: "Refresh", exact: true }).click();
      await page.waitForFunction((count) => window.__t254.overviews.length > count, before, { timeout: 60_000 });
      check("same packaged count oracle accepts restored good fixture", validOverview(await page.evaluate(() => window.__t254.overviews.at(-1))));
    } finally { control.prepare("UPDATE zaicode_jobs SET status='running' WHERE job_id='old-running'").run(); control.close(); }
    const initialDom = await page.locator('[data-zaicode-home-slot="now"]').innerText();
    check("Now displays all 12 durable completions today despite ingestion backlog", /12 done/.test(initialDom), initialDom);
    if (!/12 done/.test(initialDom)) throw new Error("HOME_TODAY_MISMATCH: authoritative overview has 12 doneToday but Now does not display it");
    stage = "60s observation";
    await page.evaluate(() => { window.__t254.calls = {}; window.__t254.jobLists = []; window.__t254.overviews = []; window.__t254.errors = []; window.__t254.rootCommits = 0; window.__t254.homeRootCommits = 0; });
    const start = Date.now();
    for (let part = 0; part < 4; part++) {
      await pause(15_000);
      if (part === 1) {
        await dismissToasts(page);
        await page.locator('[data-zaicode-saihome]').getByRole("button", { name: "Refresh", exact: true }).click();
        await page.evaluate(() => window.__t254.manualRefreshes++);
      }
    }
    receipt.observationMs = Date.now() - start;
    receipt.metrics = await page.evaluate(() => window.__t254);
    receipt.dom = await page.locator('[data-zaicode-saihome]').innerText();
    receipt.nowDom = await page.locator('[data-zaicode-home-slot="now"]').innerText();
    receipt.pageErrors = pageErrors;
    const m = receipt.metrics;
    check("actual observation lasted at least 60 seconds", receipt.observationMs >= 60_000, receipt.observationMs);
    check("existing automatic refreshes reached native overview RPC", m.overviews.length >= 3, m.overviews.length);
    check("every 500k overview returns 26 rows and exact day/live facts", m.overviews.length > 0 && m.overviews.every(validOverview), m.overviews);
    check("every oldest active job survives RPC transfer", m.overviews.every((value) => value.openIds.length === 6), m.overviews.map((value) => value.openIds));
    const channel = m.overviews[0]?.channel;
    check("home makes no full job-list RPC", Boolean(channel) && !m.jobLists.some((value) => value.channel === channel && (!value.workspaceFilter || !value.bounded)), { calls: m.calls, jobLists: m.jobLists });
    check("production React root commits are observed with home mounted", m.homeRootCommits > 0, { root: m.rootCommits, home: m.homeRootCommits });
    check("core home queue/today/fleet projections are visible", /1 run · 2 ready/.test(receipt.nowDom) && /12 done/.test(receipt.nowDom) && /Fixture running/.test(receipt.dom), { now: receipt.nowDom, home: receipt.dom });
    check("manual refresh remains usable", m.manualRefreshes === 1, m.manualRefreshes);
    check("zero renderer and observer/RPC errors", pageErrors.length === 0 && m.errors.length === 0, { pageErrors, observer: m.errors });
    await page.screenshot({ path: path.join(out, "home-500k.png") });
    receipt.pass = receipt.checks.every((value) => value.pass);
  } catch (error) {
    receipt.pass = false; receipt.stage = stage; receipt.error = String(error); receipt.pageErrors = pageErrors;
    if (page) { receipt.metrics = await page.evaluate(() => window.__t254 || null).catch(() => null); await page.screenshot({ path: path.join(out, "error.png") }).catch(() => {}); }
  } finally {
    const asar = path.join(path.dirname(exe), "resources/app.asar");
    if (fs.existsSync(asar)) receipt.asarSha256 = crypto.createHash("sha256").update(fs.readFileSync(asar)).digest("hex");
    fs.writeFileSync(path.join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
    if (app) await app.close().catch(() => {});
  }
  console.log(JSON.stringify({ pass: receipt.pass, checks: receipt.checks.length, stage: receipt.stage, error: receipt.error }));
  if (!receipt.pass) process.exitCode = 1;
})();
