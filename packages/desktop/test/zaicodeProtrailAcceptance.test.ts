import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { checkProtrail, readExpectedProtrail } = require("../scripts/verify-zaicode-protrail.cjs");
const config = (enabled: boolean, everywhere = true) => ({
  enabled,
  everywhere,
  trail: { enabled: true },
  click: { enabled: true },
});

function fixture(count: number, { lit = [20, 30], enabled = true, monitors = 2 } = {}) {
  const displays = Array.from({ length: monitors }, (_, i) => ({
    id: i + 1,
    bounds: { x: i ? -800 : 0, y: 0, width: i ? 800 : 1200, height: i ? 600 : 900 },
  }));
  const pages = Array.from({ length: count }, (_, i) => ({
    url: () => "file:///zaicode-protrail.html",
    isClosed: () => false,
    evaluate: (fn: Function) =>
      Promise.resolve(
        fn.toString().includes("__zaicodeProtrailProbe")
          ? {
              configured: true,
              enabled: true,
              frames: true,
              width: displays[i]?.bounds.width,
              height: displays[i]?.bounds.height,
            }
          : lit[i],
      ),
  }));
  const page = {
    evaluate: () =>
      Promise.resolve({
        state: enabled ? "running" : "off",
        input: enabled ? "raw-input" : "none",
        displays: count,
        verified: count,
        monitors,
      }),
  };
  const app = {
    windows: () => pages,
    evaluate: (fn: Function) =>
      Promise.resolve(
        fn({
          screen: { getAllDisplays: () => displays },
          BrowserWindow: { getAllWindows: () => [] },
        }),
      ),
    browserWindow: (overlay: unknown) =>
      Promise.resolve({
        evaluate: () =>
          Promise.resolve(displays[pages.indexOf(overlay as (typeof pages)[number])]?.bounds),
      }),
  };
  return { app, page };
}

test("T-325: explicit Off overrides bundled settings and expects no overlays", async () => {
  assert.equal(readExpectedProtrail(JSON.stringify(config(false))).enabled, false);
  const { app, page } = fixture(0, { enabled: false });
  const result = await checkProtrail(app, {
    page,
    expectedConfig: config(false),
    timeoutMs: 0,
    settleMs: 0,
  });
  assert.equal(result.overlayCount, 0);
  assert.equal(result.expectedEnabled, false);
  assert.equal(result.input, "none");
});

test("T-325: explicit On overrides bundled Off", () => {
  assert.equal(readExpectedProtrail(JSON.stringify(config(true))).enabled, true);
  assert.equal(readExpectedProtrail(null).enabled, false);
});

test("T-325: malformed and non-object preferences use the existing factory normalizer", () => {
  for (const raw of ["{bad", "null", "[]", '"invalid"'])
    assert.equal(readExpectedProtrail(raw).enabled, true);
  assert.equal(readExpectedProtrail('{"enabled":"false"}').enabled, true);
});

test("T-325: enabled acceptance still fails when a monitor overlay is absent", async () => {
  const { app, page } = fixture(1);
  await assert.rejects(
    checkProtrail(app, { page, expectedConfig: config(true), timeoutMs: 0, settleMs: 0 }),
    /overlay per monitor/,
  );
});

test("T-325: disabled acceptance fails on orphan overlays", async () => {
  const { app, page } = fixture(1, { enabled: false });
  await assert.rejects(
    checkProtrail(app, { page, expectedConfig: config(false), timeoutMs: 0, settleMs: 0 }),
    /zero.*overlay|overlays.*off/i,
  );
});

test("T-325: an expected state is mandatory", async () => {
  const { app, page } = fixture(0, { enabled: false });
  await assert.rejects(
    checkProtrail(app, { page, timeoutMs: 0, settleMs: 0 }),
    /expected.*configuration/i,
  );
});

test("T-325: no-display result is explicitly unavailable drawing proof", async () => {
  const { app, page } = fixture(0, { monitors: 0 });
  const result = await checkProtrail(app, {
    page,
    expectedConfig: config(true),
    timeoutMs: 0,
    settleMs: 0,
  });
  assert.equal(result.monitors, 0);
  assert.equal(result.verification, "NOT_VERIFIED");
  assert.equal(result.skipped, "no display");
});

test("T-325: different monitor geometry preserves strict per-monitor pixels", async () => {
  const { app, page } = fixture(2);
  const result = await checkProtrail(app, {
    page,
    expectedConfig: config(true),
    timeoutMs: 0,
    settleMs: 0,
  });
  assert.equal(result.overlayCount, 2);
  assert.deepEqual(result.lit, [20, 30]);
  assert.equal(result.displays[1].bounds.x, -800);
});

test("T-325: one dark monitor still fails the enabled-state gate", async () => {
  const { app, page } = fixture(2, { lit: [20, 0] });
  await assert.rejects(
    checkProtrail(app, { page, expectedConfig: config(true), timeoutMs: 0, settleMs: 0 }),
    /every ProTrail overlay draws/,
  );
});
