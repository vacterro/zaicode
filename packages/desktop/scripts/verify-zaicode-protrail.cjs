// ProTrail end-to-end check for the packaged boot gate (T-129).
//
// The operator's report -- "ProTrail is on at the start of the session, but I have to switch it off and on
// for it to work" -- is a state the unit suites could not see: overlay windows that exist and count as ready
// but draw nothing. Startup convergence (T-108) was proven against a fake Electron; this runs the PACKAGED
// app on isolated explicitly configured profiles, and asks the enabled overlays themselves:
//
//   1. one overlay page per monitor comes up on its own (no toggle, no Settings visit);
//   2. each of them lights pixels when the main process feeds it a synthetic mouse sweep, which proves the
//      page holds the config, sits at a size that can draw, and makes frames -- the things "loaded" does not.
//
// The sweep goes through the very channel the real mouse events use (zaicode:protrail-overlay-feed), so the
// operator's cursor is never touched and no click is ever sent.
const assert = require("node:assert/strict");
const { require: requireTs } = require("tsx/cjs/api");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Use the product's settings precedence and normalizer, never a gate-owned default. */
function readExpectedProtrail(profileValue) {
  const { readZaicodeSetting } = requireTs(
    "../../ui/src/zaicode/zaicodeSettingsSnapshot.ts",
    __filename,
  );
  const { normalizeProtrailConfig } = requireTs(
    "../../ui/src/zaicode/protrail/protrailNormalize.ts",
    __filename,
  );
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => profileValue ?? null },
  });
  let raw;
  try {
    raw = readZaicodeSetting("zaicode-protrail-v1");
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  try {
    return normalizeProtrailConfig(JSON.parse(raw ?? "null"));
  } catch {
    return normalizeProtrailConfig(null);
  }
}

/** The most lit pixels an overlay canvas shows in the sweep's strip while `ms` milliseconds pass. */
function watchCanvas(page, ms) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const canvas = document.getElementById("protrail");
        const ctx = canvas.getContext("2d");
        let max = 0;
        const t0 = performance.now();
        const tick = () => {
          try {
            const y = Math.floor(canvas.height * 0.35);
            const data = ctx.getImageData(
              0,
              y,
              canvas.width,
              Math.max(1, Math.ceil(canvas.height * 0.3)),
            ).data;
            let lit = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit += 1;
            if (lit > max) max = lit;
          } catch {
            max = -1;
          }
          if (performance.now() - t0 < duration) requestAnimationFrame(tick);
          else resolve(max);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/**
 * @param {import("playwright-core").ElectronApplication} app
 * Off is accepted only from an explicit expectation plus an idle global owner;
 * On retains the real per-monitor rendering requirement.
 */
async function checkProtrail(
  app,
  { page, expectedConfig, timeoutMs = 45_000, settleMs = 1500 } = {},
) {
  assert.ok(
    expectedConfig &&
      typeof expectedConfig.enabled === "boolean" &&
      typeof expectedConfig.everywhere === "boolean",
    "an explicit expected ProTrail configuration is required",
  );
  const displays = await app.evaluate(({ screen }) =>
    screen.getAllDisplays().map(({ id, bounds, scaleFactor }) => ({ id, bounds, scaleFactor })),
  );
  const monitors = displays.length;
  const expectedEnabled = expectedConfig.enabled;
  const expectedEverywhere = expectedConfig.everywhere;
  const wanted = expectedEnabled && expectedEverywhere;
  const overlayPages = () =>
    app
      .windows()
      .filter((window) => !window.isClosed() && /zaicode-protrail\.html/.test(window.url()));
  const readStatus = () => page.evaluate(() => window.zcode?.getZaicodeProtrailGlobalStatus?.());
  const deadline = Date.now() + timeoutMs;
  if (!wanted) {
    let status = await readStatus();
    while (
      (overlayPages().length || status?.state !== "off" || status?.input !== "none") &&
      Date.now() < deadline
    ) {
      await sleep(200);
      status = await readStatus();
    }
    await sleep(settleMs);
    status = await readStatus();
    assert.equal(
      overlayPages().length,
      0,
      "zero global ProTrail overlays are required while the saved mode is off",
    );
    assert.equal(status?.state, "off", "the global ProTrail owner is off");
    assert.equal(status?.input, "none", "no global cursor input reader remains active");
    return {
      expectedEnabled,
      expectedEverywhere,
      monitors,
      displays,
      expectedOverlays: 0,
      overlayCount: 0,
      lit: [],
      input: status.input,
      status,
      verification: "VERIFIED",
    };
  }
  // A session without a display (a service, a remote shell) has nothing to draw on.
  if (monitors === 0)
    return {
      expectedEnabled,
      expectedEverywhere,
      monitors: 0,
      overlayCount: overlayPages().length,
      skipped: "no display",
      verification: "NOT_VERIFIED",
    };
  while (overlayPages().length < monitors && Date.now() < deadline) await sleep(400);
  const pages = overlayPages();
  assert.equal(
    pages.length,
    monitors,
    `one ProTrail overlay per monitor came up on its own (${pages.length} of ${monitors})`,
  );
  // The pages take their config at load; give a slow machine a moment before the sweep.
  await sleep(settleMs);
  const probes = await Promise.all(
    pages.map((overlay) => overlay.evaluate(() => window.__zaicodeProtrailProbe?.())),
  );
  const bounds = await Promise.all(
    pages.map(async (overlay) =>
      (await app.browserWindow(overlay)).evaluate((win) => win.getBounds()),
    ),
  );
  const matched = new Set();
  for (const [index, probe] of probes.entries()) {
    assert.ok(
      probe?.configured && probe.enabled && probe.frames,
      `overlay ${index} holds an enabled config and draws frames`,
    );
    const monitor = displays.find((display) =>
      ["x", "y", "width", "height"].every(
        (key) => Math.abs(display.bounds[key] - bounds[index][key]) <= 2,
      ),
    );
    assert.ok(
      monitor && !matched.has(monitor.id),
      `overlay ${index} uniquely covers a detected monitor`,
    );
    matched.add(monitor.id);
    assert.ok(
      Math.abs(probe.width - monitor.bounds.width) <= 2 &&
        Math.abs(probe.height - monitor.bounds.height) <= 2,
      `overlay ${index} canvas geometry matches its monitor`,
    );
  }
  const watchers = pages.map((page) => watchCanvas(page, 900));
  await sleep(60);
  await app.evaluate(({ BrowserWindow }) => {
    const now = performance.now();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !/zaicode-protrail\.html/.test(win.webContents.getURL())) continue;
      const bounds = win.getBounds();
      const events = [];
      for (let i = 0; i < 40; i += 1) {
        events.push(
          0,
          -1,
          bounds.x + Math.round(bounds.width * (0.1 + (i * 0.8) / 40)),
          bounds.y + Math.round(bounds.height * (0.5 + Math.sin(i / 4) * 0.08)),
          now - (39 - i) * 8,
        );
      }
      win.webContents.send("zaicode:protrail-overlay-feed", { events });
    }
  });
  const lit = await Promise.all(watchers);
  assert.ok(
    lit.every((count) => typeof count === "number" && count > 0),
    `every ProTrail overlay draws (lit pixels per monitor: ${lit.join(", ")}); ProTrail is on but an overlay shows nothing`,
  );
  const status = await readStatus();
  assert.equal(status?.state, "running", "enabled ProTrail converges to running without a toggle");
  assert.equal(status?.verified, monitors, "every enabled monitor is health-verified");
  return {
    expectedEnabled,
    expectedEverywhere,
    monitors,
    displays,
    expectedOverlays: monitors,
    overlayCount: pages.length,
    probes,
    bounds,
    lit,
    input: status.input,
    status,
    verification: "VERIFIED",
  };
}

module.exports = { checkProtrail, readExpectedProtrail };
