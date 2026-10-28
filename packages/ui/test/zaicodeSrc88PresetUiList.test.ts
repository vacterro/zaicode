import "./support/presetStorage.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZaicodePresetsPanel } from "../src/settings/ZaicodePresetsPanel.js";
import type { PresetEnv } from "../src/zaicode/zaicodePresetApply.js";
import { memoryBlobStore } from "../src/zaicode/zaicodePresetAssets.js";

/**
 * SRC-088 (T-125): saved presets on screen. The store reads its list from storage when it is first imported
 * (support/presetStorage.ts filled it first), which is what a server render shows.
 */

const env: PresetEnv = {
  read: () => null,
  write: () => undefined,
  sources: [],
  blobs: memoryBlobStore(),
  undo: { get: () => null, set: () => undefined },
  rehydrate: () => true,
  now: () => "2026-09-29T12:00:00.000Z",
};
const prune = async () => undefined;

test("L1 saved presets are listed with their own page only, each with apply, replace, export and delete that say what they do", () => {
  const html = renderToStaticMarkup(createElement(ZaicodePresetsPanel, { section: "zaicodeSounds", env, prune }));
  assert.match(html, /data-zaicode-preset="a"/);
  assert.doesNotMatch(html, /data-zaicode-preset="b"/, "another page's presets are not shown here");
  assert.match(html, />Night shift</);
  assert.match(html, /29 Sep 2026/, "when it was saved");
  assert.match(html, /aria-label="Replace Night shift with the current settings"/);
  assert.match(html, /aria-label="Export Night shift as a file"/);
  assert.match(html, /aria-label="Delete Night shift"/);
  assert.match(html, />Apply</);
  assert.doesNotMatch(html, /No presets yet/);
  const colors = renderToStaticMarkup(createElement(ZaicodePresetsPanel, { section: "zaicodeColors", env, prune }));
  assert.match(colors, /data-zaicode-preset="b"/);
  assert.doesNotMatch(colors, /data-zaicode-preset="a"/);
});

test("L2 an Undo button appears when the page has something to put back, named after what it puts back, and only there", () => {
  const html = renderToStaticMarkup(createElement(ZaicodePresetsPanel, { section: "zaicodeSounds", env, prune }));
  assert.match(html, /Undo “Night shift”/);
  const other = renderToStaticMarkup(createElement(ZaicodePresetsPanel, { section: "zaicodeColors", env, prune }));
  assert.doesNotMatch(other, /Undo “/, "an undo belongs to its page");
});
