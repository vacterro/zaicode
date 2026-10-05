// T-166 live acceptance harness.
//
// Launches the PACKAGED desktop app from dist-t166 against its own private profile
// (ZCODE_DESKTOP_USER_DATA_DIR, never --user-data-dir: packages/desktop/src/main/index.ts
// calls app.setPath("userData", ...) at line 294, which overrides the Chromium switch and
// would otherwise write into the operator's live %APPDATA%\ZAICODE profile).
//
// The clause under test, against a real signed-in Antigravity account:
//   1. SAIHOME and the topbar clock show the SAME live countdown for a supported
//      auto-rolled plan.
//   2. The anchor survives a sweep and a restart.
//   3. The window never sits on "starts at first use" after a supported plan has been
//      rolled.
//
// It arms itself across the real vendor roll, so the plan it observes is one the vendor
// itself rolled. Nothing here fabricates a number: every reading is read back out of the
// isolated cache or out of the live renderer DOM, and the receipt records the profile, the
// executable and every observation it made.

import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { execFileSync } from "node:child_process";
import playwright from "file:///V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE/zcode/node_modules/playwright-core/index.js";

const { _electron: electron } = playwright;

const REPO = "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_ZAICODE";
const EXE = `${REPO}/zcode/packages/desktop/dist-t166/win-unpacked/ZAICODE.exe`;
const PROFILE = process.env.T166_PROFILE ?? "V:/_TEMP_/zaicode-t166";
const OUT_DIR = `${REPO}/.saipen/evidence/T-166-live/20261005`;
const OUT = join(OUT_DIR, "receipt.json");

/** The pool whose 5 h window the vendor rolls during this run. */
const KEY = "five_hour@gemini_models";
/** ms epoch of that roll, and when to give up. */
const ROLL_AT = Number(process.env.T166_ROLL_AT ?? 1791169267000); // 2026-10-05T03:01:07Z
const DEADLINE = Number(process.env.T166_DEADLINE ?? ROLL_AT + 40 * 60_000);
const POLL_MS = 20_000;

const CACHE = join(PROFILE, "zaicode-engines-cache.json");
const CONFIG = join(PROFILE, "zaicode-engines.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const log = (...a) => console.log(`${new Date().toISOString()} ${a.join(" ")}`);
const failures = [];
const checks = {};
const observations = [];

function check(name, condition, detail) {
  checks[name] = Boolean(condition);
  if (!condition) failures.push(`${name}: ${detail ?? "assertion failed"}`);
  log(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
  return Boolean(condition);
}

function cache() {
  if (!existsSync(CACHE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return null;
  }
}

function snapshotOf() {
  const c = cache();
  const state = c?.limits?.["antigravity:default"];
  const out = {
    at: iso(Date.now()),
    lastSweepAt: iso(c?.lastSweepAt ?? null),
    source: state?.source ?? null,
    error: state?.error ?? null,
    fetchedAt: iso(state?.fetchedAt ?? null),
    windowStart: state?.windowStart ?? null,
    windowStarts: state?.windowStarts ?? null,
    // Raw ms, not ISO: the anchor oracle compares these numbers to the start record,
    // and a formatted timestamp would hide a one-millisecond lie.
    windows: (state?.windows ?? []).map((w) => ({
      key: w.key,
      remainingPercent: w.remainingPercent,
      resetsAt: w.resetsAt ?? null,
      rollingFrom: w.rollingFrom ?? null,
      startsOnUse: w.startsOnUse ?? null,
      durationMinutes: w.durationMinutes ?? null,
      group: w.group ?? null,
      gatedBy: w.gatedBy ?? null,
      resetsAtIso: iso(w.resetsAt ?? null),
      rollingFromIso: iso(w.rollingFrom ?? null),
    })),
  };
  return out;
}

let app = null;
let child = null;

async function launch() {
  const env = {
    ...process.env,
    HOME: PROFILE,
    USERPROFILE: PROFILE,
    APPDATA: join(PROFILE, "AppData", "Roaming"),
    LOCALAPPDATA: join(PROFILE, "AppData", "Local"),
    PATH: `${process.env.LOCALAPPDATA}\\agy\\bin${delimiter}${process.env.PATH}`,
    ZCODE_DESKTOP_APPLICATION_NAME: `ZAICODE T166 ${PROFILE}`,
    ZCODE_DESKTOP_HOME_DIR: PROFILE,
    ZCODE_DESKTOP_USER_DATA_DIR: PROFILE,
    ZCODE_DESKTOP_SESSION_DATA_DIR: join(PROFILE, "session"),
    ZCODE_DATA_BASE_DIR: PROFILE,
    ZCODE_HOME: join(PROFILE, ".zcode"),
    ZCODE_ZAICODE_MODE: "1",
    ZAICODE_CUSTOMIZATION_DIR: join(PROFILE, "customization"),
    ZAICODE_UPDATES: "off",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };
  delete env.ZAICODE_LIVE_CACHE;
  app = await electron.launch({ executablePath: EXE, args: [], env, timeout: 180_000 });
  child = app.process();
  let page = null;
  for (let round = 0; round < 240 && !page; round += 1) {
    page = app.windows().find((p) => !p.isClosed() && p.url().includes("/out/renderer/index.html"));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("the packaged app exposed no renderer window");
  page.on("pageerror", (error) => observations.push({ label: "pageerror", at: iso(Date.now()), message: String(error).split("\n")[0] }));
  await page.locator('[data-workspace-shell="true"]').waitFor({ timeout: 180_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    window.__t166 = await window.zcode.getZaicodeEngines();
    window.zcode.onZaicodeEnginesChanged((state) => {
      window.__t166 = state;
    });
  });
  return page;
}

async function stop() {
  if (app) await app.close().catch(() => undefined);
  if (child?.pid) {
    try {
      execFileSync("C:/Windows/System32/taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  app = null;
  child = null;
}

/** Every number and every rendered string this clause is about, read from the live app. */
async function observe(page, label, refresh) {
  if (refresh) await page.evaluate(() => window.zcode.refreshZaicodeEngines("antigravity:default"));
  const live = await page.evaluate(() => {
    const state = window.__t166;
    const s = state?.limits?.["antigravity:default"];
    const topbar = [...document.querySelectorAll("button[data-zaicode-clock]")]
      .map((b) => b.getAttribute("title") ?? "")
      .find((t) => /Next reset: /.test(t)) ?? "";
    const tile = document.querySelector('[data-zaicode-engine-tile="AG"]')?.getAttribute("title") ?? "";
    const text = (selector) => document.querySelector(selector)?.innerText ?? "";
    const surfaces = {
      home: text('[data-zaicode-home-widget="limits"]'),
      engineBar: text("[data-zaicode-engine-bar]"),
      limitsPanel: text("[data-zaicode-limits-panel]"),
    };
    return {
      at: Date.now(),
      topbar,
      tile,
      surfaces,
      windowStarts: s?.windowStarts ?? null,
      windows: (s?.windows ?? []).map((w) => ({
        key: w.key,
        label: w.label ?? null,
        remainingPercent: w.remainingPercent,
        resetsAt: w.resetsAt,
        rollingFrom: w.rollingFrom ?? null,
        startsOnUse: w.startsOnUse ?? null,
      })),
    };
  });
  const cacheSample = snapshotOf();
  const out = { ...cacheSample, label, rendered: { ...live, rendered_: joined(live.surfaces) } };
  observations.push(out);
  log(`observed ${label}: target=${JSON.stringify(live.windows.find((w) => w.key === KEY))}`);
  return out;
}

/** "1h 38m" / "42m" / "2h" -> minutes. */
function minutes(text) {
  const h = /(\d+)\s*h/.exec(text ?? "");
  const m = /(\d+)\s*m/.exec(text ?? "");
  return Number(h?.[1] ?? 0) * 60 + Number(m?.[1] ?? 0);
}

/** The SAIHOME row for one window label, or null when the surface does not render it. */
function homeRow(panel, windowLabel) {
  return (panel ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${windowLabel}:`) || line.startsWith(`${windowLabel} `)) ?? null;
}

/** The window key behind each label both surfaces print. */
function windowByLabel(windows, label) {
  return windows.find((w) => w.label === label) ?? null;
}

/** Every surface that renders a window row, joined, so a row is found wherever it lives. */
function joined(surfaces) {
  return Object.values(surfaces).filter(Boolean).join(String.fromCharCode(10));
}

async function openHome(page) {
  const button = page.getByRole("button", { name: "SAIHOME", exact: true });
  if (await button.count()) await button.first().click();
  await page.locator('[data-zaicode-home-widget="limits"]').waitFor({ timeout: 30_000 });
  const showAll = page.getByRole("button", { name: /show all/i });
  if (await showAll.count()) await showAll.first().click();
  await page.waitForFunction(
    () => /Next reset: /.test([...document.querySelectorAll("button[data-zaicode-clock]")].map((b) => b.getAttribute("title") ?? "").find((t) => /Next reset: /.test(t)) ?? ""),
    null,
    { timeout: 60_000 },
  );
}

/**
 * The anchor the clause names: the real successful start, still ours, still vendor-backed,
 * never back on starts-on-use.
 *
 * `resetsAt` is NOT pinned to a snapshot taken at start time. Measured on the live account:
 * for roughly 300 s after the roll the vendor keeps reporting the OLD reset, which is already
 * in the past, and only then publishes the new one. Pinning the first value would fail the
 * sweep and restart checks for a vendor that behaved correctly, so the clause is checked
 * (anchor held, startsOnUse false, a real reset still ahead) and any movement of the reset
 * since the start is reported as drift rather than treated as a lost anchor.
 */
function anchored(sample, expected) {
  const record = sample.windowStarts?.[KEY];
  const window = sample.windows.find((w) => w.key === KEY);
  const resetDriftMs = window?.resetsAt != null && expected.resetAt != null ? window.resetsAt - expected.resetAt : null;
  const stable =
    record?.at === expected.startAt &&
    record?.ok === true &&
    window?.rollingFrom === expected.startAt &&
    window?.startsOnUse === false &&
    typeof window?.resetsAt === "number" &&
    window.resetsAt > Date.now();
  return { stable, record, window, resetDriftMs };
}

(async () => {
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });
  writeFileSync(
    CONFIG,
    JSON.stringify(
      {
        intervalMinutes: 0,
        readZcodeConfig: false,
        readFreebuff: false,
        keepWindowsRolling: true,
        hiddenAccounts: ["claude:default", "codex:default", "zcode:plan", "freebuff:default"],
      },
      null,
      2,
    ),
  );
  mkdirSync(OUT_DIR, { recursive: true });

  let exit = 0;
  try {
    let page = await launch();
    check("isolatedPackagedShell", true, EXE);

    const first = await observe(page, "first-live-sweep", true);
    check("liveVendorQuota", Boolean(first.windows.length > 0 && first.error === null && String(first.source).startsWith("agy")), `source=${first.source} error=${first.error}`);
    check("noStartBeforeRoll", first.windowStarts === null || Object.keys(first.windowStarts).length === 0, "a start existed before the roll");

    log(`armed for the ${iso(ROLL_AT)} roll of ${KEY}; deadline ${iso(DEADLINE)}`);
    let started = null;
    while (Date.now() < DEADLINE) {
      await sleep(POLL_MS);
      const sample = await observe(page, "poll", true);
      const record = sample.windowStarts?.[KEY];
      if (record?.ok === true) {
        started = sample;
        break;
      }
    }
    if (!started) throw new Error(`no successful starter on ${KEY} by ${iso(DEADLINE)}`);

    const expected = {
      startAt: started.windowStarts[KEY].at,
      // The reset the vendor was still reporting when the starter succeeded -- normally the
      // pre-roll value, already in the past. Kept so "the vendor moved it" is a real claim.
      resetAtStart: started.windows.find((w) => w.key === KEY)?.resetsAt ?? null,
      resetAt: null,
    };
    check("realStarterSucceeded", true, `${iso(expected.startAt)} ${JSON.stringify(started.windowStarts[KEY].detail ?? "")}`);

    // The re-read the app schedules after a start must be the one that fixes the anchor.
    await page.waitForFunction(
      (target) => {
        const s = window.__t166?.limits?.["antigravity:default"];
        const record = s?.windowStarts?.[target];
        return Boolean(record) && s.fetchedAt >= record.at + 10_000;
      },
      KEY,
      { timeout: 90_000 },
    );
    const reread = await observe(page, "live-reread-after-real-starter", true);
    expected.resetAt = reread.windows.find((w) => w.key === KEY)?.resetsAt ?? null;
    const afterStart = anchored(reread, expected);
    check(
      "anchorFixedByTheVendor",
      afterStart.stable && expected.resetAt !== expected.resetAtStart,
      `was ${iso(expected.resetAtStart)} now ${iso(expected.resetAt)} window ${JSON.stringify(afterStart.window)}`,
    );
    check("resetIsAhead", expected.resetAt > Date.now(), `resetAt=${iso(expected.resetAt)}`);

    await openHome(page);
    const ui = await observe(page, "first-live-ui", false);
    const topbarReset = /Next reset: .+ in ([^\n]+)/.exec(ui.rendered.topbar)?.[1] ?? null;
    // "Next reset: <accountLabel> <windowLabel> in <duration>" -- the account label also
    // contains spaces, so the window is identified by the longest suffix that a live
    // window actually carries, never by a hard-coded spelling.
    const topbarHead = /Next reset: (.+) in [^\n]+/.exec(ui.rendered.topbar)?.[1] ?? null;
    const targetLabel = reread.windows.find((w) => w.key === KEY)?.label ?? null;
    const label = ui.rendered.windows
      .filter((w) => w.label && topbarHead && topbarHead.endsWith(w.label))
      .sort((a, b) => b.label.length - a.label.length)[0]?.label ?? null;
    check("topbarNamesAReset", Boolean(topbarReset && label), `head=${topbarHead} duration=${topbarReset} label=${label}`);

    if (label) {
      const row = homeRow(ui.rendered.rendered_, label);
      check("homeRendersTheClockWindow", Boolean(row), `${label} -> ${row ?? "<missing from SAIHOME>"}`);
      const homeMinutes = /resets in ([^\n]+)/.exec(row ?? "")?.[1] ?? null;
      check(
        "homeAndTopbarAgree",
        Boolean(homeMinutes) && Math.abs(minutes(homeMinutes) - minutes(topbarReset)) <= 1,
        `home=${homeMinutes} topbar=${topbarReset}`,
      );
      const clockWindow = windowByLabel(reread.windows, label);
      const authoritative = clockWindow ? (clockWindow.resetsAt - Date.now()) / 60_000 : null;
      check(
        "homeAgreesWithTheVendorReset",
        authoritative !== null && Math.abs(minutes(homeMinutes ?? "") - Math.floor(authoritative)) <= 1,
        `window=${clockWindow?.key ?? label} home=${homeMinutes} vendor=${authoritative === null ? null : Math.floor(authoritative)} min`,
      );
    }

    const targetRow = targetLabel ? homeRow(ui.rendered.rendered_, targetLabel) : null;
    check("targetRowRendered", Boolean(targetRow), targetRow ?? `<no ${targetLabel} row in any surface>`);
    // The clause names SAIHOME specifically, so the row must be in the home widget itself,
    // not merely somewhere in the app.
    const homeRowOnly = targetLabel ? homeRow(ui.rendered.surfaces.home, targetLabel) : null;
    check("homeWidgetRendersTheTargetRow", Boolean(homeRowOnly), homeRowOnly ?? `<SAIHOME shows no ${targetLabel} row>`);
    check(
      "neverStartsAtFirstUse",
      Boolean(targetRow) && !/starts on first use/.test(targetRow) && reread.windows.find((w) => w.key === KEY)?.startsOnUse === false,
      `${targetRow ?? "<missing>"} startsOnUse=${reread.windows.find((w) => w.key === KEY)?.startsOnUse}`,
    );
    check("countdownRendered", Boolean(targetRow) && /resets in /.test(targetRow), targetRow ?? "<missing>");
    await page.screenshot({ path: join(OUT_DIR, "first-live-ui.png") });

    const firstMinutes = minutes(/resets in ([^\n]+)/.exec(targetRow ?? "")?.[1] ?? "");
    await sleep(70_000);
    const later = await observe(page, "countdown-after-70-real-seconds", false);
    const laterRow = targetLabel ? homeRow(later.rendered.rendered_, targetLabel) : null;
    const laterMinutes = minutes(/resets in ([^\n]+)/.exec(laterRow ?? "")?.[1] ?? "");
    check("countdownAdvances", laterMinutes < firstMinutes, `${firstMinutes}m -> ${laterMinutes}m over 70 real seconds`);

    const swept = await observe(page, "second-live-sweep", true);
    const afterSweep = anchored(swept, expected);
    check(
      "anchorSurvivesASweep",
      afterSweep.stable,
      `window ${JSON.stringify(afterSweep.window)} resetDriftMs=${afterSweep.resetDriftMs}`,
    );
    check(
      "noDuplicatePaidRequest",
      Object.keys(swept.windowStarts ?? {}).length === 1,
      JSON.stringify(swept.windowStarts),
    );

    await stop();
    page = await launch();
    const restarted = await observe(page, "restart-live-sweep", true);
    const afterRestartSweep = anchored(restarted, expected);
    check(
      "anchorSurvivesARestart",
      afterRestartSweep.stable,
      `window ${JSON.stringify(afterRestartSweep.window)} resetDriftMs=${afterRestartSweep.resetDriftMs}`,
    );
    check(
      "stillOneStartAfterRestart",
      Object.keys(restarted.windowStarts ?? {}).length === 1,
      JSON.stringify(restarted.windowStarts),
    );
    await openHome(page);
    const afterRestart = await observe(page, "restart-ui", false);
    check(
      "noStartsAtFirstUseAfterRestart",
      !/starts on first use/.test(targetLabel ? homeRow(afterRestart.rendered.rendered_, targetLabel) ?? "" : "x"),
      targetLabel ? homeRow(afterRestart.rendered.rendered_, targetLabel) ?? "<missing>" : "<no label>",
    );

    // Negative control: the oracle must reject a doctored anchor rather than pass anything.
    const doctored = JSON.parse(JSON.stringify(restarted));
    doctored.windows.find((w) => w.key === KEY).startsOnUse = true;
    check("negativeControlRejectsADoctoredWindow", anchored(doctored, expected).stable === false, "a window forced back to starts-on-use was accepted");

    const pageErrors = observations.filter((o) => o.label === "pageerror");
    check("zeroPageErrors", pageErrors.length === 0, JSON.stringify(pageErrors.map((e) => e.message)));
  } catch (error) {
    failures.push(`harness: ${String(error.message ?? error).split("\n")[0]}`);
    log(`ERROR ${String(error.message ?? error).split("\n")[0]}`);
    exit = 1;
  } finally {
    await stop();
    const receipt = {
      schema: "zaicode-t166-live/2",
      at: new Date().toISOString(),
      executablePath: EXE,
      profile: PROFILE,
      targetKey: KEY,
      rollAt: iso(ROLL_AT),
      playwrightVersion: playwright.version ?? "playwright-core",
      checks,
      failures,
      observations,
      ok: exit === 0 && failures.length === 0,
    };
    writeFileSync(OUT, `${JSON.stringify(receipt, null, 2)}\n`);
    log(`receipt ${OUT} ok=${receipt.ok} checks=${JSON.stringify(checks)}`);
    if (failures.length) log(`FAILURES ${JSON.stringify(failures, null, 2)}`);
  }
  process.exitCode = failures.length ? 1 : 0;
})();