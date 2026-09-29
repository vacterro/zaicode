// ProTrail end-to-end check for the packaged boot gate (T-129).
//
// The operator's report -- "ProTrail is on at the start of the session, but I have to switch it off and on
// for it to work" -- is a state the unit suites could not see: overlay windows that exist and count as ready
// but draw nothing. Startup convergence (T-108) was proven against a fake Electron; this runs the PACKAGED
// app on its throw-away profile, where ProTrail is on by default, and asks the overlays themselves:
//
//   1. one overlay page per monitor comes up on its own (no toggle, no Settings visit);
//   2. each of them lights pixels when the main process feeds it a synthetic mouse sweep, which proves the
//      page holds the config, sits at a size that can draw, and makes frames -- the things "loaded" does not.
//
// The sweep goes through the very channel the real mouse events use (zaicode:protrail-overlay-feed), so the
// operator's cursor is never touched and no click is ever sent.
const assert = require("node:assert/strict");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
            const data = ctx.getImageData(0, 240, canvas.width, 170).data;
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
 * @returns {Promise<{ monitors: number, lit: number[] } | { monitors: 0, skipped: string }>}
 */
async function checkProtrail(app, { timeoutMs = 45_000 } = {}) {
  const monitors = await app.evaluate(({ screen }) => screen.getAllDisplays().length);
  // A session without a display (a service, a remote shell) has nothing to draw on.
  if (monitors === 0) return { monitors: 0, skipped: "no display" };
  const overlayPages = () => app.windows().filter((window) => !window.isClosed() && /zaicode-protrail\.html/.test(window.url()));
  const deadline = Date.now() + timeoutMs;
  while (overlayPages().length < monitors && Date.now() < deadline) await sleep(400);
  const pages = overlayPages();
  assert.equal(pages.length, monitors, `one ProTrail overlay per monitor came up on its own (${pages.length} of ${monitors})`);
  // The pages take their config at load; give a slow machine a moment before the sweep.
  await sleep(1500);
  const watchers = pages.map((page) => watchCanvas(page, 900));
  await sleep(60);
  await app.evaluate(({ BrowserWindow }) => {
    const now = performance.now();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || !/zaicode-protrail\.html/.test(win.webContents.getURL())) continue;
      const bounds = win.getBounds();
      const events = [];
      for (let i = 0; i < 40; i += 1) {
        events.push(0, -1, bounds.x + 100 + i * 20, bounds.y + 300 + Math.round(Math.sin(i / 4) * 40), now - (39 - i) * 8);
      }
      win.webContents.send("zaicode:protrail-overlay-feed", { events });
    }
  });
  const lit = await Promise.all(watchers);
  assert.ok(
    lit.every((count) => typeof count === "number" && count > 0),
    `every ProTrail overlay draws (lit pixels per monitor: ${lit.join(", ")}); ProTrail is on but an overlay shows nothing`,
  );
  return { monitors, lit };
}

module.exports = { checkProtrail };
