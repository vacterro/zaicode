import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_HOME_PRESETS,
  moveZaicodeHomeWidget,
  normalizeZaicodeHomePrefs,
  zaicodeHomeCustomFromScreen,
  zaicodeHomeLayout,
} from "../src/zaicode/home/zaicodeHomePrefs.js";

// SRC-061: "в SAIHOME карточки перемещаемы драгом и дроппом".

test("a dragged card lands before or after the card it was dropped on", () => {
  const prefs = normalizeZaicodeHomePrefs({ preset: "custom" });
  const ids = prefs.custom.map((entry) => entry.id);
  const [a, b, c] = ids as [string, string, string];
  const before = moveZaicodeHomeWidget(prefs.custom, c, a, "before").map((entry) => entry.id);
  assert.deepEqual(before.slice(0, 3), [c, a, b]);
  const after = moveZaicodeHomeWidget(prefs.custom, a, c, "after").map((entry) => entry.id);
  assert.deepEqual(after.slice(0, 3), [b, c, a]);
  assert.equal(after.length, ids.length, "nothing is lost or doubled");
  assert.deepEqual(moveZaicodeHomeWidget(prefs.custom, a, a, "after").map((entry) => entry.id), ids);
  assert.deepEqual(moveZaicodeHomeWidget(prefs.custom, "nope", a, "after").map((entry) => entry.id), ids);
});

test("dragging on a preset starts CUSTOM from what is on screen, so nothing jumps", () => {
  const preset = Object.keys(ZAICODE_HOME_PRESETS)[1] as keyof typeof ZAICODE_HOME_PRESETS;
  const prefs = normalizeZaicodeHomePrefs({ preset });
  const screen = zaicodeHomeLayout(prefs).map((entry) => entry.id);
  const custom = zaicodeHomeCustomFromScreen(prefs);
  assert.deepEqual(
    custom.filter((entry) => entry.visible).map((entry) => entry.id),
    screen,
  );
  assert.deepEqual(zaicodeHomeLayout({ preset: "custom", custom }).map((entry) => entry.id), screen);
});
