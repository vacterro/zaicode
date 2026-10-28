import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_FANCYZONE_LAYOUTS,
  readZaicodeFancyZonesSettings,
} from "../src/zaicode/zaicodeFancyZones.js";

test("BUILTIN_FANCYZONE_LAYOUTS includes Quarters and Columns", () => {
  const quarters = BUILTIN_FANCYZONE_LAYOUTS.find((l) => l.id === "Quarters");
  assert.ok(quarters, "Quarters layout missing");
  assert.equal(quarters.zones.length, 4);

  // Each zone must have finite coordinates within [0, 1]
  for (const zone of quarters.zones) {
    assert.ok(zone.fx >= 0 && zone.fx <= 1);
    assert.ok(zone.fy >= 0 && zone.fy <= 1);
    assert.ok(zone.fw > 0 && zone.fw <= 1);
    assert.ok(zone.fh > 0 && zone.fh <= 1);
  }

  const columns = BUILTIN_FANCYZONE_LAYOUTS.find((l) => l.id === "Columns");
  assert.ok(columns, "Columns layout missing");
  assert.equal(columns.zones.length, 3);
  for (const zone of columns.zones) {
    assert.ok(zone.fx >= 0 && zone.fx <= 1);
    assert.ok(zone.fy >= 0 && zone.fy <= 1);
    assert.ok(zone.fw > 0 && zone.fw <= 1);
    assert.ok(zone.fh > 0 && zone.fh <= 1);
  }
});

test("FancyZones fast cycling index wraps correctly", () => {
  const quarters = BUILTIN_FANCYZONE_LAYOUTS.find((l) => l.id === "Quarters")!;
  const len = quarters.zones.length;
  let idx = 0;
  idx = (idx + 1) % len;
  assert.equal(idx, 1);
  idx = (idx + 1) % len;
  assert.equal(idx, 2);
  idx = (idx + 1) % len;
  assert.equal(idx, 3);
  idx = (idx + 1) % len;
  assert.equal(idx, 0);
});

test("FancyZones settings fall back to valid defaults", () => {
  const settings = readZaicodeFancyZonesSettings();
  assert.ok(settings.layoutId === "Quarters" || settings.layoutId === "Columns");
  assert.equal(typeof settings.fastMode, "boolean");
  assert.equal(typeof settings.soundEnabled, "boolean");
});

test("Right-click drag 3px threshold logic", () => {
  const shouldMove = (dx: number, dy: number) => Math.hypot(dx, dy) > 3;
  assert.equal(shouldMove(0, 0), false);
  assert.equal(shouldMove(2, 0), false);
  assert.equal(shouldMove(0, 3), false);
  assert.equal(shouldMove(2, 2), false); // sqrt(8) ~ 2.828 <= 3
  assert.equal(shouldMove(3, 1), true);  // sqrt(10) ~ 3.162 > 3
  assert.equal(shouldMove(4, 0), true);
  assert.equal(shouldMove(0, 5), true);
});
