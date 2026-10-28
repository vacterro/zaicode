import assert from "node:assert/strict";
import test from "node:test";
import { applyZaicodeLocalTimeZone, shouldRelaunchForLocalTimeZone } from "../src/main/zaicodeTimeZone.js";

test("an inherited TZ is removed before anything is spawned, and remembered", () => {
  const env: NodeJS.ProcessEnv = { TZ: "UTC", PATH: "x" };
  assert.equal(applyZaicodeLocalTimeZone(env), "UTC");
  assert.equal(env.TZ, undefined);
  assert.equal(env.ZAICODE_INHERITED_TZ, "UTC");
  assert.equal(env.PATH, "x");
});

test("no TZ: nothing changes", () => {
  const env: NodeJS.ProcessEnv = { PATH: "x" };
  assert.equal(applyZaicodeLocalTimeZone(env), null);
  assert.deepEqual(env, { PATH: "x" });
});

test("a packaged app that inherited TZ relaunches once, never in a loop", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.equal(shouldRelaunchForLocalTimeZone("UTC", { packaged: true, env }), true);
  assert.equal(env.ZAICODE_TZ_RELAUNCHED, "1");
  // The relaunched process sees the marker (TZ set system-wide came back): no second relaunch.
  assert.equal(shouldRelaunchForLocalTimeZone("UTC", { packaged: true, env }), false);
});

test("no inherited TZ, or a dev run: no relaunch", () => {
  assert.equal(shouldRelaunchForLocalTimeZone(null, { packaged: true, env: {} }), false);
  assert.equal(shouldRelaunchForLocalTimeZone("UTC", { packaged: false, env: {} }), false);
});
