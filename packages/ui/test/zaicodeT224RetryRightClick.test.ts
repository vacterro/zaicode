import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ZAICODE_RIGHT_CLICK_CONTROLS,
  rightClickOpensSettings,
} from "../src/zaicode/zaicodeUiPrefs.js";

// T-224 R005: right-click the Auto retry button must lead to its settings,
// through the same wrapper every settings-owning control uses.

test("T-224 R005: retry is a registered right-click control, on by default", () => {
  assert.equal(ZAICODE_RIGHT_CLICK_CONTROLS.retry, "Auto retry");
  assert.equal(rightClickOpensSettings({ rightClickSettings: {} }, "retry"), true);
  assert.equal(rightClickOpensSettings({ rightClickSettings: { retry: false } }, "retry"), true, "SRC-162: an old OFF no longer kills the right button");
});

test("T-224 R005: the retry button wraps itself in the shared right-click panel", () => {
  const button = readFileSync(new URL("../src/zaicode/ZaicodeAutoRetryButton.tsx", import.meta.url), "utf8");
  assert.match(button, /ZaicodeRightClickSettings/);
  assert.match(button, /preferenceKey="retry"/);
  assert.match(button, /openZaicodeSettings\("zaicodeWorkers"\)/);
});
