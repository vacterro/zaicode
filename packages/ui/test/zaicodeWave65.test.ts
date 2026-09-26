import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeZaicodeSidebarColor,
  normalizeZaicodeSidebarPrefs,
  ZAICODE_SIDEBAR_DEFAULT_PREFS,
  type ZaicodeSidebarPrefs,
} from "../src/zaicode/zaicodeSidebarPrefs.js";

test("sidebar prefs keep the T-65 controls through normalize (SRC-049)", () => {
  const raw = {
    textSize: 14,
    iconSize: "large",
    slotColors: { MAIN0: "#f0c040", LIVE: "red", SIDE3: "#abc" },
    sessionsCondition: "working-or-waiting",
  };
  const prefs = normalizeZaicodeSidebarPrefs(raw);
  assert.equal(prefs.textSize, 14);
  assert.equal(prefs.iconSize, "large");
  assert.equal(prefs.sessionsCondition, "working-or-waiting");
  // "red" is not a hex colour: dropped, the theme stays; 3-digit hex is fine.
  assert.deepEqual(prefs.slotColors, { MAIN0: "#f0c040", SIDE3: "#abc" });
});

test("bad or missing T-65 values fall back to defaults, never to undefined", () => {
  const prefs = normalizeZaicodeSidebarPrefs({ textSize: 15, iconSize: "huge", sessionsCondition: "sometimes" });
  const d = ZAICODE_SIDEBAR_DEFAULT_PREFS;
  assert.equal(prefs.textSize, d.textSize);
  assert.equal(prefs.iconSize, d.iconSize);
  assert.equal(prefs.sessionsCondition, d.sessionsCondition);
  assert.deepEqual(prefs.slotColors, {});
  const fromNothing = normalizeZaicodeSidebarPrefs("junk");
  assert.equal(fromNothing.textSize, 12);
  assert.deepEqual(fromNothing.slotColors, {});
});

test("slot colour validation: 3- and 6-digit hex pass, everything else drops", () => {
  assert.equal(normalizeZaicodeSidebarColor("#D4C89A"), "#D4C89A");
  assert.equal(normalizeZaicodeSidebarColor("#abc"), "#abc");
  assert.equal(normalizeZaicodeSidebarColor("rgb(1,2,3)"), undefined);
  assert.equal(normalizeZaicodeSidebarColor(null), undefined);
});

test("a stored slot colour for an unknown group never reaches the prefs", () => {
  const prefs: ZaicodeSidebarPrefs = normalizeZaicodeSidebarPrefs({ slotColors: { NOPE: "#fff" } });
  assert.deepEqual(prefs.slotColors, {});
});
