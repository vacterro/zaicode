import assert from "node:assert/strict";
import { test } from "node:test";
import { ZAICODE_WORKING_ICON_DEFAULTS, ZAICODE_HIGHLIGHT_DEFAULTS } from "../src/zaicode/zaicodeHighlights.js";
const appearance = await import(process.env.ZAICODE_T142_APPEARANCE_SUBJECT ?? "../src/zaicode/zaicodeModelAppearance.js");

test("model working appearance retains the entire icon, motion and layer configuration", () => {
  const working = { ...ZAICODE_WORKING_ICON_DEFAULTS, images: ["cog"], motions: ["swing", "pulse"], seconds: 3.2, color: "custom", custom: "#00ffff", direction: "ccw", layers: { cog: { opacity: 55 } } };
  const prefs = appearance.normalizeZaicodeModelAppearancePrefs({ models: { "provider::model": { mode: "separate", working } } });
  const resolved = appearance.resolveZaicodeModelWorking(prefs, "provider/model", ZAICODE_WORKING_ICON_DEFAULTS);
  assert.deepEqual(resolved.images, ["cog"]);
  assert.deepEqual(resolved.motions, ["swing", "pulse"]);
  assert.equal(resolved.seconds, 3.2);
  assert.equal(resolved.custom, "#00ffff");
  assert.equal(resolved.direction, "ccw");
  assert.equal(resolved.layers.cog?.opacity, 55);
});

test("unconfigured/default models follow current Working icon settings, never the shipped picture", () => {
  const global = { ...ZAICODE_WORKING_ICON_DEFAULTS, images: ["asterisk"], seconds: 5 } as typeof ZAICODE_WORKING_ICON_DEFAULTS;
  const prefs = appearance.normalizeZaicodeModelAppearancePrefs({ models: { "p::m": { mode: "default", working: { images: ["cog"] } } } });
  assert.deepEqual(appearance.resolveZaicodeModelWorking(prefs, "p/m", global), global);
  assert.deepEqual(appearance.resolveZaicodeModelWorking(prefs, "other/m", global), global);
});

test("legacy global and model assets survive without masking a new full working override", () => {
  const prefs = appearance.normalizeZaicodeModelAppearancePrefs({ global: { workerIcon: "data:image/png;base64,GLOBAL" }, models: { "p::m": { mode: "separate", workerIcon: "data:image/png;base64,MODEL" }, "p::new": { mode: "separate", workerIcon: "data:image/png;base64,OLD", working: { images: ["fan"] } } } });
  assert.equal(appearance.resolveZaicodeModelWorking(prefs, "p/m", ZAICODE_WORKING_ICON_DEFAULTS).customImage, "data:image/png;base64,MODEL");
  assert.equal(appearance.resolveZaicodeModelWorking(prefs, "p/default", ZAICODE_WORKING_ICON_DEFAULTS).customImage, "data:image/png;base64,GLOBAL");
  assert.deepEqual(appearance.resolveZaicodeModelWorking(prefs, "p/new", ZAICODE_WORKING_ICON_DEFAULTS).images, ["fan"]);
});

test("a model overriding one highlight field inherits the other global fields of that target", () => {
  const prefs = appearance.normalizeZaicodeModelAppearancePrefs({ global: { highlight: { sessionWorking: { effects: ["blink"], strength: 45 } } }, models: { "p::m": { mode: "separate", highlight: { sessionWorking: { color: "custom", custom: "#00ffff" } } } } });
  assert.deepEqual(appearance.resolveZaicodeModelAppearance(prefs, "p/m").highlight.sessionWorking, { effects: ["blink"], strength: 45, color: "custom", custom: "#00ffff" });
  const rule = appearance.resolveZaicodeModelHighlight(prefs, "p/m", "sessionWorking", ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking);
  assert.equal(rule.strength, 45);
  assert.deepEqual(rule.effects, ["blink"]);
});

test("complete highlight fine tuning survives persistence and provider identities stay isolated", () => {
  const rule = { ...ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking, seconds: 4, effects: ["pulse"], tuning: { pulse: { seconds: 3 } }, shapeTuning: { box: { strength: 80 } } };
  const prefs = appearance.normalizeZaicodeModelAppearancePrefs({ models: { "a::same": { mode: "separate", highlight: { sessionWorking: rule } } } });
  const resolved = appearance.resolveZaicodeModelHighlight(prefs, "a/same", "sessionWorking", ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking);
  assert.equal(resolved.tuning.pulse?.seconds, 3);
  assert.equal(resolved.shapeTuning.box?.strength, 80);
  assert.equal(appearance.resolveZaicodeModelHighlight(prefs, "b/same", "sessionWorking", ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking).seconds, ZAICODE_HIGHLIGHT_DEFAULTS.sessionWorking.seconds);
});
