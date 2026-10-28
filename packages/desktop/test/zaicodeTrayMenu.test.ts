import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_TRAY_MENU,
  buildZaicodeTrayMenuHtml,
  placeZaicodeTrayMenu,
  readZaicodeTrayMenuPick,
  zaicodeTrayMenuHeight,
} from "../src/main/zaicodeTrayMenuModel.js";

test("tray menu: only the operator's destinations, no upstream housekeeping", () => {
  const labels = ZAICODE_TRAY_MENU.flatMap((entry) => (entry === "separator" ? [] : [entry.label]));
  assert.ok(labels.includes("SAIHOME"));
  assert.ok(labels.includes("Quit ZAICODE"));
  for (const banned of ["Clear all data", "Check for updates", "About"]) {
    assert.ok(!labels.some((label) => label.includes(banned)), banned);
  }
});

test("tray menu page uses Golden Default tokens and escapes labels", () => {
  const html = buildZaicodeTrayMenuHtml([{ id: "x", label: "<b>&" }, "separator"]);
  assert.match(html, /#332E22/);
  assert.match(html, /#D4C89A/);
  assert.ok(!html.includes("<b>&"));
  assert.ok(!/border-radius:\s*[1-9]/.test(html));
});

test("tray menu picks come back through the title", () => {
  assert.equal(readZaicodeTrayMenuPick("pick:home"), "home");
  assert.equal(readZaicodeTrayMenuPick("pick:close"), "");
  assert.equal(readZaicodeTrayMenuPick("ZAICODE"), null);
});

test("tray menu opens up-left of the cursor and stays inside the work area", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 190, height: zaicodeTrayMenuHeight(ZAICODE_TRAY_MENU) };
  assert.deepEqual(placeZaicodeTrayMenu({ x: 1800, y: 1060 }, area, size), { x: 1610, y: 1040 - size.height });
  // Taskbar at the top: opens downwards.
  assert.deepEqual(placeZaicodeTrayMenu({ x: 1800, y: 10 }, area, size), { x: 1610, y: 10 });
  // Taskbar on the left: opens to the right.
  assert.equal(placeZaicodeTrayMenu({ x: 20, y: 900 }, area, size).x, 20);
});
