import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveZaicodeSidebarWidth, zaicodeSidebarDragWidth, zaicodeSidebarKeyboardWidth } from "../src/zaicode/zaicodeSidebarWidth.js";
import { normalizeZaicodeSidebarPrefs } from "../src/zaicode/zaicodeSidebarPrefs.js";

test("a short sidebar drag snaps to the rail and dragging back restores readable rows", () => {
  assert.equal(resolveZaicodeSidebarWidth(159), 52);
  assert.equal(resolveZaicodeSidebarWidth(-500), 52);
  assert.equal(resolveZaicodeSidebarWidth(170), 200);
  assert.equal(resolveZaicodeSidebarWidth(264), 264);
  assert.equal(resolveZaicodeSidebarWidth(600, 400), 400);
});
test("swapped sidebar resize and stored placement use the same preference", () => {
  assert.equal(zaicodeSidebarDragWidth(264, -40, false), 224);
  assert.equal(zaicodeSidebarDragWidth(264, -40, true), 304);
  assert.equal(normalizeZaicodeSidebarPrefs({}).sidebarsSwapped, false);
  assert.equal(normalizeZaicodeSidebarPrefs({ sidebarsSwapped: true }).sidebarsSwapped, true);
  assert.equal(zaicodeSidebarKeyboardWidth(52, 1, false, 16), 200);
  assert.equal(zaicodeSidebarKeyboardWidth(200, -1, false, 16), 52);
  assert.equal(zaicodeSidebarKeyboardWidth(52, -1, true, 16), 200);
  assert.equal(zaicodeSidebarKeyboardWidth(200, 1, true, 16), 52);
});
