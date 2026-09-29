import assert from "node:assert/strict";
import test from "node:test";
import { createProtrailHarness, fakeClock, THREE_DISPLAYS } from "./support/protrailHarness.js";
import { healthPort } from "./support/protrailPorts.js";

/**
 * T-129: "ProTrail does not start with the session: it is on, and I have to switch it off and on for it
 * to work." Startup convergence (T-108) made the main process keep asking until IT believed the overlays
 * were up. What it could not see is an overlay that exists and counts as ready but does not draw: it never
 * finished loading, never took its config, sits off its monitor, makes no frames, or the click reader gave
 * up for good. The overlays now answer a health probe and the main process repairs what the answer shows.
 * Every scenario below is red against the module it replaced (PROTRAIL_MAIN_SOURCE points the harness at
 * the old source for that control).
 */

const health = healthPort() as {
  judgeOverlay: (o: any) => { verified: boolean; repair: { action: string; why?: string } };
  createOverlayHealth: (deps: any) => { start(): void; stop(): void; verified(): number; tick(): Promise<void> };
  OVERLAY_LOAD_DEADLINE_MS: number;
  OVERLAY_STRIKE_LIMIT: number;
  OVERLAY_RESEND_LIMIT: number;
  OVERLAY_REBUILDS_PER_MINUTE: number;
};

const probeOk = { configured: true, enabled: true, width: 1920, height: 1080, frames: true };
const judged = (patch: Record<string, unknown> = {}) =>
  health.judgeOverlay({
    now: 100_000,
    createdAt: 99_000,
    ready: true,
    visible: true,
    placed: true,
    expected: { width: 1920, height: 1080 },
    probe: probeOk,
    strikes: 0,
    resends: 0,
    ...patch,
  });

// ------------------------------------------------------------------ the rules, alone

test("H1 a page that has not loaded is waited for, then dropped and built again", () => {
  assert.equal(judged({ ready: false, probe: null, now: 100_000, createdAt: 99_000 }).repair.action, "wait");
  const late = judged({ ready: false, probe: null, now: 100_000, createdAt: 100_000 - health.OVERLAY_LOAD_DEADLINE_MS - 1 });
  assert.equal(late.repair.action, "rebuild");
  assert.equal(late.verified, false);
});

test("H2 a loaded overlay that is hidden is shown, one that is off its monitor is put back", () => {
  assert.equal(judged({ visible: false }).repair.action, "reveal");
  assert.equal(judged({ placed: false }).repair.action, "place");
});

test("H3 a page that does not answer, or draws no frames, is rebuilt only after repeated strikes", () => {
  for (const probe of [null, { ...probeOk, frames: false }]) {
    assert.equal(judged({ probe, strikes: 1 }).repair.action, "wait");
    assert.equal(judged({ probe, strikes: health.OVERLAY_STRIKE_LIMIT }).repair.action, "rebuild");
  }
});

test("H4 a page that never took the config is sent it again, then rebuilt", () => {
  const empty = { ...probeOk, configured: false };
  assert.equal(judged({ probe: empty, resends: 0 }).repair.action, "resend");
  assert.equal(judged({ probe: empty, resends: health.OVERLAY_RESEND_LIMIT - 1 }).repair.action, "resend");
  assert.equal(judged({ probe: empty, resends: health.OVERLAY_RESEND_LIMIT }).repair.action, "rebuild");
  assert.equal(judged({ probe: { ...probeOk, enabled: false }, resends: 0 }).repair.action, "resend", "a switched-off config in the page counts too");
});

test("H5 a page at the wrong size is not confirmed, and a rebuild is not the answer to a zoom", () => {
  const verdict = judged({ probe: { ...probeOk, width: 1536, height: 864 } });
  assert.equal(verdict.verified, false);
  assert.equal(verdict.repair.action, "wait");
  assert.match(String(verdict.repair.why), /1536x864/);
  assert.equal(judged({ probe: { ...probeOk, width: 1921 } }).verified, true, "a pixel of rounding is not a fault");
});

test("H6 everything in order is confirmed and asks for nothing", () => {
  // The rules run in their own realm: compare plain data, not prototypes.
  assert.deepEqual(JSON.parse(JSON.stringify(judged())), { verified: true, repair: { action: "ok" } });
});

// ------------------------------------------------------------------ the orchestrator, alone

function orchestrated(views: () => any[], onRebuild: () => void = () => {}) {
  const time = fakeClock();
  const calls: string[] = [];
  const logs: string[] = [];
  let changes = 0;
  const overlay = health.createOverlayHealth({
    now: time.now,
    setTimer: time.setTimeout,
    clearTimer: time.clearTimeout,
    wanted: () => true,
    views,
    repairs: {
      reveal: (view: any) => calls.push(`reveal ${view.displayId}`),
      place: (view: any) => calls.push(`place ${view.displayId}`),
      resend: (view: any) => calls.push(`resend ${view.displayId}`),
      rebuild: (view: any) => {
        calls.push(`rebuild ${view.displayId}`);
        onRebuild();
      },
    },
    onChange: () => (changes += 1),
    log: (message: string) => logs.push(message),
  });
  return { time, calls, logs, overlay, changes: () => changes };
}

const view = (patch: Record<string, unknown> = {}) => ({
  displayId: 7,
  serial: 1,
  createdAt: 1_000_000,
  ready: true,
  visible: true,
  placed: true,
  expected: { width: 1920, height: 1080 },
  probe: async () => probeOk,
  ...patch,
});

test("H7 the orchestrator counts confirmed overlays and says when the count changes", async () => {
  const h = orchestrated(() => [view(), view({ displayId: 8, probe: async () => null })]);
  h.overlay.start();
  await h.time.advance(600);
  assert.equal(h.overlay.verified(), 1);
  assert.equal(h.changes(), 1);
  assert.match(h.logs.join("\n"), /1 of 2 overlays confirmed/);
  h.overlay.stop();
  assert.equal(h.time.pending(), 0, "stopping leaves no timer behind");
});

test("H8 a monitor that cannot be fixed is rebuilt a few times a minute, then left alone with one log line", async () => {
  // A rebuilt overlay is a new window, so its serial moves on: its record starts clean, and still fails.
  let serial = 1;
  const h = orchestrated(
    () => [view({ serial, probe: async () => null })],
    () => (serial += 1),
  );
  h.overlay.start();
  await h.time.advance(60_000);
  const rebuilds = h.calls.filter((call) => call.startsWith("rebuild")).length;
  assert.ok(rebuilds >= 1 && rebuilds <= health.OVERLAY_REBUILDS_PER_MINUTE, `rebuilt ${rebuilds} times in a minute`);
  assert.equal(h.logs.filter((line) => /keeps failing/.test(line)).length, 1, "the give-up is said once");
  h.overlay.stop();
});

test("H9 a confirmed set is watched slowly and costs no repair", async () => {
  let probes = 0;
  const h = orchestrated(() => [view({ probe: async () => (probes += 1, probeOk) })]);
  h.overlay.start();
  await h.time.advance(60_000);
  assert.deepEqual(h.calls, []);
  assert.ok(probes >= 8 && probes <= 14, `one probe every few seconds, not every tick: ${probes} in a minute`);
  h.overlay.stop();
});

// ------------------------------------------------------------------ the real module

test("M1 an overlay whose page never finishes loading is dropped and built again, with no toggle", async () => {
  const h = createProtrailHarness();
  h.configure({ color: "red" });
  assert.equal(h.windows.length, 3);
  // No document ever loads: the old module waited on them forever.
  await h.clock.advance(health.OVERLAY_LOAD_DEADLINE_MS + 2000);
  assert.ok(h.windows.length >= 6, `every stuck overlay was replaced (built ${h.windows.length})`);
  assert.equal(h.windows.slice(0, 3).every((win) => win.destroyed), true, "the stuck ones are gone");
  assert.match(h.logs.join("\n"), /did not finish loading/);
  h.configure(null);
});

test("M2 an overlay page that missed the config is sent it again, then replaced", async () => {
  const h = createProtrailHarness();
  h.configure({ color: "red" });
  // The document of the middle monitor has no listener yet when the first feed arrives.
  h.windows[1]!.webContents.page.deaf = true;
  await h.loadAll();
  await h.clock.advance(6000);
  const deaf = h.windows[1]!;
  const configFeeds = deaf.webContents.feeds.filter((feed) => "config" in feed).length;
  assert.ok(configFeeds >= 3, `the deaf page got the config at load and again (${configFeeds} feeds)`);
  assert.equal(deaf.destroyed, true, "and was replaced when it still did not take it");
  assert.equal(h.windows.length, 4, "with exactly one new overlay");
  await h.loadAll();
  await h.clock.advance(1500);
  assert.equal(h.status().verified, 3, "the replacement took the config: every monitor is confirmed");
  h.configure(null);
});

test("M3 an overlay moved by another program is put back on its monitor", async () => {
  const h = createProtrailHarness();
  h.configure({ color: "red" });
  await h.loadAll();
  await h.clock.advance(1500);
  assert.equal(h.status().verified, 3);
  const [left] = h.windows;
  left!.bounds = { ...left!.bounds, x: left!.bounds.x + 400 };
  await h.clock.advance(6000);
  assert.deepEqual(left!.bounds, THREE_DISPLAYS[0]!.bounds, "the window is back where its monitor is");
  assert.deepEqual(left!.webContents.feeds.at(-1), { origin: { x: -1920, y: 0 } }, "and told its origin again");
  h.configure(null);
});

test("M4 a monitor that settles on its real size keeps its origin: the overlay still follows the size", async () => {
  const h = createProtrailHarness();
  h.configure({ color: "red" });
  await h.loadAll();
  const displays = THREE_DISPLAYS.map((display) => ({ id: display.id, bounds: { ...display.bounds } }));
  displays[1]!.bounds = { x: 0, y: 0, width: 2560, height: 1440 };
  h.setDisplays(displays);
  h.screen.emit("display-metrics-changed");
  const primary = h.windows[1]!;
  assert.deepEqual(primary.boundsSet.at(-1), { x: 0, y: 0, width: 2560, height: 1440 }, "the window is resized, not left at 1920x1080");
  h.configure(null);
});

test("M5 the status counts what the overlays confirm, and how many monitors there are", async () => {
  const h = createProtrailHarness();
  h.configure({ color: "red" });
  await h.loadAll();
  assert.equal(h.status().displays, 3, "loaded documents");
  assert.equal(h.status().monitors, 3);
  assert.equal(h.status().verified, 0, "nothing is confirmed before a page has answered");
  await h.clock.advance(1500);
  assert.equal(h.status().verified, 3);
  h.windows[2]!.webContents.page.noFrames = true;
  await h.clock.advance(20_000);
  assert.ok((h.status().verified ?? 0) < 3 || h.windows.length > 3, "a page without frames is no longer confirmed, and is being replaced");
  h.configure(null);
});

test("M6 a frozen page is replaced after it stops answering", async () => {
  const h = createProtrailHarness();
  h.configure({ color: "red" });
  await h.loadAll();
  await h.clock.advance(1500);
  h.windows[0]!.webContents.page.frozen = true;
  await h.clock.advance(20_000);
  assert.equal(h.windows[0]!.destroyed, true);
  assert.match(h.logs.join("\n"), /its page does not answer/);
  h.configure(null);
});

test("M7 a click reader that keeps failing is tried again later, so clicks return without a toggle", async () => {
  // Four failed starts use up the quick restarts; the fifth, half a minute later, works.
  const h = createProtrailHarness({ platform: "win32", readerPlan: ["fail", "fail", "fail", "fail", "ready"] });
  h.configure({ color: "red" });
  await h.clock.advance(20_000);
  assert.equal(h.status().input, "cursor-poll", "meanwhile the trail follows the cursor");
  assert.equal(h.readers.length, 4);
  await h.clock.advance(40_000);
  assert.equal(h.readers.length, 5, "the reader was started again on its own");
  assert.equal(h.status().input, "raw-input");
  assert.equal(h.status().state, "running");
  h.configure(null);
});

test("M8 a healthy set is watched but never rebuilt, and switching the mode off leaves no timer", async () => {
  const h = createProtrailHarness();
  h.configure({ color: "red" });
  await h.loadAll();
  await h.clock.advance(120_000);
  assert.equal(h.windows.length, 3, "no overlay was rebuilt in two minutes");
  assert.equal(h.status().verified, 3);
  h.configure(null);
  assert.equal(h.clock.pending(), 0, "the health pass and every retry stop with the mode");
  assert.equal(h.status().state, "off");
});

test("M9 the desktop-wide mode leaves a trail in the log: start, each overlay, each repair", async () => {
  const h = createProtrailHarness();
  h.configure({ color: "red" });
  await h.loadAll();
  await h.clock.advance(1500);
  h.configure(null);
  const log = h.logs.join("\n");
  assert.match(log, /starting the desktop-wide mode for 1 window, 3 display\(s\)/);
  assert.equal((log.match(/overlay \d created/g) ?? []).length, 3);
  assert.equal((log.match(/overlay \d loaded after/g) ?? []).length, 3);
  assert.match(log, /3 of 3 overlays confirmed/);
  assert.match(log, /the desktop-wide mode is off/);
});
