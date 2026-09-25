import assert from "node:assert/strict";
import test from "node:test";
import { getAtmosphericSaimailEmptyText, nextSaimailHistory } from "../src/zaicode/zaicodeSaimailModel.js";
import { zaicodeRoleForCommand, zaicodeRoleFromTitle } from "../src/zaicode/zaicodeSessionRoles.js";
import { zaicodeDigitOf, zaicodeKeyIs } from "../src/zaicode/zaicodeKeys.js";
import { shouldResetHorizontalScroll } from "../src/zaicode/zaicodeScrollGuard.js";
import { healFancyZone, normalizeZaicodeFancyZonesSettings } from "../src/zaicode/zaicodeFancyZones.js";
import { ZAICODE_SAIPEN_MODES } from "../src/zaicode/zaicodeMainSession.js";

test("empty SAIMAIL desk grows from 'someone one day' to 'another one?'", () => {
  const day = new Date(2026, 8, 24);
  assert.deepEqual(getAtmosphericSaimailEmptyText(0, day), {
    title: "Empty.",
    subtitle: "Maybe, someone one day will mail you, who knows...",
  });
  assert.equal(getAtmosphericSaimailEmptyText(1, day).subtitle, "Hmm, maybe another one?...");
  const later = new Set([2, 5, 10, 30, 80, 200].map((count) => getAtmosphericSaimailEmptyText(count, day).subtitle));
  assert.equal(later.size, 6, "every stage says something of its own");
});

test("a letter counts as opened once, when it leaves the unread folder", () => {
  let history = { lastUnread: [] as string[], opened: 0, arrived: 0 };
  history = nextSaimailHistory(history, ["a", "b"]);
  assert.equal(history.arrived, 2);
  history = nextSaimailHistory(history, ["b"]);
  assert.equal(history.opened, 1);
  history = nextSaimailHistory(history, ["b"]);
  assert.equal(history.opened, 1);
  history = nextSaimailHistory(history, []);
  assert.equal(history.opened, 2);
});

test("helper roles come from the launch command, never from a word inside a title", () => {
  for (const mode of ZAICODE_SAIPEN_MODES) assert.ok(zaicodeRoleForCommand(mode.command), mode.command);
  assert.equal(zaicodeRoleFromTitle("saiwiki"), "WIKI");
  assert.equal(zaicodeRoleFromTitle("saipen clean"), "CLEAN");
  assert.equal(zaicodeRoleFromTitle("aa"), "AUDIT");
  assert.equal(zaicodeRoleFromTitle("Fix the test runner"), null);
  assert.equal(zaicodeRoleFromTitle("PHASE SCOUT T-194"), null);
  assert.equal(zaicodeRoleFromTitle("clean up wiki links"), null);
});

test("hotkeys match the physical key on any layout", () => {
  // Ctrl+Q on the Russian layout: key is "й", code is KeyQ.
  assert.equal(zaicodeKeyIs({ key: "й", code: "KeyQ" }, "q"), true);
  assert.equal(zaicodeKeyIs({ key: "я", code: "KeyZ" }, "z"), true);
  assert.equal(zaicodeKeyIs({ key: "q", code: "KeyA" }, "q"), true, "AZERTY still matches by the printed key");
  assert.equal(zaicodeKeyIs({ key: "w", code: "KeyW" }, "q"), false);
  // A Latin layout's printed letter decides: AZERTY Ctrl+A (physical KeyQ) stays select-all,
  // QWERTZ Ctrl+Y (physical KeyZ) is not Ctrl+Z.
  assert.equal(zaicodeKeyIs({ key: "a", code: "KeyQ" }, "q"), false);
  assert.equal(zaicodeKeyIs({ key: "y", code: "KeyZ" }, "z"), false);
  assert.equal(zaicodeKeyIs({ key: "z", code: "KeyY" }, "z"), true);
  assert.equal(zaicodeKeyIs({ key: "Q", code: "KeyQ" }, "q"), true, "Shift / Caps Lock");
  assert.equal(zaicodeKeyIs({ key: "Escape", code: "Escape" }, "escape"), true);
  assert.equal(zaicodeDigitOf({ key: "\"", code: "Digit2" }), 2);
  assert.equal(zaicodeDigitOf({ key: "0", code: "Numpad0" }), 0);
  assert.equal(zaicodeDigitOf({ key: "x", code: "KeyX" }), null);
});

test("sidebar horizontal drift is reset only where no real scrollbar exists", () => {
  assert.equal(shouldResetHorizontalScroll("hidden"), true);
  assert.equal(shouldResetHorizontalScroll("clip"), true);
  assert.equal(shouldResetHorizontalScroll("auto"), false);
  assert.equal(shouldResetHorizontalScroll("scroll"), false);
});

test("zone presets heal corrupt geometry and keep at most ten", () => {
  assert.deepEqual(healFancyZone({ fx: -1, fy: 2, fw: 0, fh: Number.NaN, state: "maximized" }), {
    fx: 0,
    fy: 1,
    fw: 0.1,
    fh: 0.1,
    state: "maximized",
  });
  const settings = normalizeZaicodeFancyZonesSettings({
    presets: Array.from({ length: 14 }, () => ({ fx: 0.1, fy: 0.1, fw: 0.5, fh: 0.5 })),
    layoutId: "Nope",
  });
  assert.equal(settings.presets.length, 10);
  assert.equal(settings.layoutId, "Quarters");
  assert.equal(settings.enabled, true);
  assert.equal(normalizeZaicodeFancyZonesSettings({ layoutId: "Presets" }).layoutId, "Presets");
});
