// T-188 packaged acceptance harness.
//
// Launches the PACKAGED desktop app from dist-t188 with its own --user-data-dir, so
// userData (and therefore zaicode-engines-cache.json + zaicode-engines-config.json)
// is a private profile and the running dist/ instance is untouched. It then records
// a differential: before / across the vendor roll / SAIHOME / topbar / sweeps /
// restart. Nothing here fabricates a number: every reading is read back out of the
// isolated cache or out of the live renderer DOM.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import playwright from "file:///V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode/node_modules/playwright-core/index.js";
const { _electron: electron } = playwright;

const REPO = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE";
const EXE = `${REPO}/zcode/packages/desktop/dist-t188/win-unpacked/ZAICODE.exe`;
const PROFILE = process.argv[2] ?? `V:/_TEMP_/zaicode-t188-${Date.now()}`;
const ROLL_AT = Number(process.argv[3] ?? 0); // ms epoch of the vendor reset we are proving
const DEADLINE = Number(process.argv[4] ?? Date.now() + 3 * 3600_000);
const OUT = `${REPO}/.saipen/evidence/T-188-packaged-acceptance.json`;

const CACHE = join(PROFILE, "zaicode-engines-cache.json");
const CONFIG = join(PROFILE, "zaicode-engines-config.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const log = (...a) => console.log(`${new Date().toISOString()} ${a.join(" ")}`);

function cache() {
  if (!existsSync(CACHE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return null;
  }
}

function readConfig() {
  if (!existsSync(CONFIG)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return null;
  }
}

/** Everything the proof needs from the isolated cache, as plain numbers. */
function snapshotOf(label) {
  const c = cache();
  const accounts = c?.limits ?? {};
  const out = { label, at: iso(Date.now()), profile: PROFILE, config: readConfig(), lastSweepAt: iso(c?.lastSweepAt ?? null), accounts: {} };
  for (const [id, s] of Object.entries(accounts)) {
    out.accounts[id] = {
      source: s.source,
      error: s.error,
      fetchedAt: iso(s.fetchedAt),
      checkedAt: iso(s.checkedAt),
      windowStart: s.windowStart ?? null,
      windowStarts: s.windowStarts ?? null,
      windows: (s.windows ?? []).map((w) => ({
        key: w.key,
        remainingPercent: w.remainingPercent,
        renderedPercent: w.remainingPercent === null ? null : Math.round(w.remainingPercent),
        resetsAt: iso(w.resetsAt),
        startsOnUse: w.startsOnUse,
        rollingFrom: w.rollingFrom === null || w.rollingFrom === undefined ? null : iso(w.rollingFrom),
        waiting: w.startsOnUse,
      })),
    };
  }
  return out;
}

/** Topbar tiles + the limits panel text, read out of the live renderer. */
async function surfaces(app) {
  const page = app.windows()[0] ?? (await app.firstWindow());
  await page.waitForLoadState("domcontentloaded");
  const read = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll("[data-zaicode-engine-tile]")].map((el) => ({
      tile: el.getAttribute("data-zaicode-engine-tile"),
      title: el.getAttribute("title") ?? "",
      text: (el.textContent ?? "").trim(),
      fresh: el.getAttribute("data-zaicode-fresh"),
    }));
    const panel = document.querySelector("[data-zaicode-limits-panel]");
    const bar = document.querySelector("[data-zaicode-engine-bar]");
    // Fill widths are the same Math.round the admission fix now uses.
    const bars = [...document.querySelectorAll("[data-zaicode-limits-panel] span span")].slice(0, 8).map((el) => el.style.width);
    return {
      url: location.href,
      barPresent: Boolean(bar),
      barText: (bar?.textContent ?? "").trim(),
      tiles,
      panelPresent: Boolean(panel),
      panelText: (panel?.textContent ?? "").trim(),
      barWidths: bars,
    };
  });
  return read;
}

async function launch(tag) {
  mkdirSync(PROFILE, { recursive: true });
  const app = await electron.launch({
    executablePath: EXE,
    // NOT --user-data-dir: desktopRuntimeEnv.ts:85 overrides userData from this
    // env var and app.setPath("userData", ...) at index.ts:294 wins over the
    // Chromium switch. Without it the instance shares the operator's live cache.
    args: [],
    env: {
      ...process.env,
      ZCODE_DESKTOP_USER_DATA_DIR: PROFILE,
      ZCODE_DESKTOP_SESSION_DATA_DIR: join(PROFILE, "session"),
    },
    timeout: 180_000,
  });
  log(`launched(${tag}) pid=${app.process().pid} profile=${PROFILE}`);
  return app;
}

async function closeOwn(app, tag = "?") {
  if (!app) return null;
  const pid = app.process().pid;
  try {
    await app.close();
  } catch {
    // Nothing to do: this PID belongs to an instance this harness started, and
    // stopping it by PID is the only kill path here. Never a name, never a list.
  }
  await sleep(3000);
  log(`closed(${tag}) pid=${pid}`);
  return pid;
}

const evidence = { schema: "zaicode-t188-packaged-acceptance/1", startedAt: iso(Date.now()), rollAt: iso(ROLL_AT), profile: PROFILE, exe: EXE, steps: [], pids: [] };
const push = (name, value) => {
  evidence.steps.push({ name, at: iso(Date.now()), ...value });
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
};

async function main() {
  if (!existsSync(EXE)) throw new Error(`packaged exe missing: ${EXE}`);
  const preRoll = ROLL_AT > 0 && Date.now() < ROLL_AT;

  // ---- before ----------------------------------------------------------------
  let app = await launch("before");
  evidence.pids.push(app.process().pid);
  log("waiting for the first sweep (8s delay + probe)");
  await sleep(45_000);
  const before = { cache: snapshotOf("before") };
  try {
    before.surfaces = await surfaces(app);
  } catch (error) {
    before.surfacesError = String(error);
  }
  push("before", before);
  log(`before: lastSweepAt=${before.cache.lastSweepAt}`);

  // ---- across the roll --------------------------------------------------------
  if (preRoll) {
    log(`roll is at ${iso(ROLL_AT)}; holding the instance open and polling the cache`);
  }
  let observed = null;
  let sweeps = 0;
  let lastChecked = 0;
  const pollStarted = Date.now();
  while (Date.now() < DEADLINE) {
    await sleep(30_000);
    const c = cache();
    for (const [accId, acc] of Object.entries(c?.limits ?? {})) {
      const checked = acc.checkedAt ?? 0;
      if (checked && checked !== lastChecked) {
        lastChecked = checked;
        sweeps += 1;
        push("sweep", { index: sweeps, cache: snapshotOf(`sweep-${sweeps}`) });
        log(`sweep ${sweeps} ${accId} checkedAt=${iso(checked)}`);
      }
      for (const [key, rec] of Object.entries(acc.windowStarts ?? {})) {
        const mine = ROLL_AT === 0 ? rec.at >= pollStarted : rec.at >= ROLL_AT;
        if (rec.ok === true && mine && key.includes("gemini")) {
          observed = { accId, key, rec };
          break;
        }
      }
      if (observed) break;
    }
    if (observed) break;
  }

  const start = observed
    ? { found: true, account: observed.accId, key: observed.key, record: { ...observed.rec, at: iso(observed.rec.at) }, sweeps, cache: snapshotOf("start") }
    : { found: false, sweeps, cache: snapshotOf("start-missing"), reason: `no ok:true windowStart for a gemini pool at/after ${iso(ROLL_AT)} by ${iso(DEADLINE)}` };
  try {
    start.surfaces = await surfaces(app);
  } catch (error) {
    start.surfacesError = String(error);
  }
  push("start", start);
  log(`start: found=${start.found} sweeps=${sweeps}`);

  // ---- SAIHOME ----------------------------------------------------------------
  try {
    const page = app.windows()[0] ?? (await app.firstWindow());
    await page.goto("zaicode://home", { timeout: 30_000 }).catch(() => {});
    await sleep(4000);
    push("saihome", { text: (await page.evaluate(() => document.body.innerText)).slice(0, 4000), tiles: await surfaces(app) });
  } catch (error) {
    push("saihome", { error: String(error) });
  }

  // ---- restart (our own PID only) ---------------------------------------------
  const pidBefore = app.process().pid;
  await closeOwn(app, "before");
  await sleep(5000);
  const afterClose = snapshotOf("after-close");
  push("after-close", { cache: afterClose, pidBefore });

  app = await launch("restart");
  evidence.pids.push(app.process().pid);
  await sleep(45_000);
  const restart = { cache: snapshotOf("restart") };
  try {
    restart.surfaces = await surfaces(app);
  } catch (error) {
    restart.surfacesError = String(error);
  }
  push("restart", restart);
  log(`restart: lastSweepAt=${restart.cache.lastSweepAt}`);

  await closeOwn(app, "restart");
  evidence.finishedAt = iso(Date.now());
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  log(`done -> ${OUT}`);
  console.log(JSON.stringify({ startFound: start.found, sweeps, profile: PROFILE, out: OUT, profileFiles: readdirSync(PROFILE) }, null, 2));
}

main().catch(async (error) => {
  evidence.error = String(error);
  evidence.finishedAt = iso(Date.now());
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.error(error);
  process.exit(1);
});