import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_USAGE_PANEL_DEFAULT_WIDTH,
  ZAICODE_USAGE_PANEL_MIN_WIDTH,
  clampZaicodeUsagePanelWidth,
  parseZaicodeUsagePanelWidth,
  snapZaicodeUsagePanelWidth,
} from "../src/zaicode/zaicodeUsagePanelWidth.js";

test("REQ-008: widths clamp into [min, viewport/2], garbage means default", () => {
  assert.equal(clampZaicodeUsagePanelWidth(480, 1600), 480);
  assert.equal(clampZaicodeUsagePanelWidth(100, 1600), ZAICODE_USAGE_PANEL_MIN_WIDTH);
  assert.equal(clampZaicodeUsagePanelWidth(900, 1600), 800);
  assert.equal(clampZaicodeUsagePanelWidth(Number.NaN, 1600), ZAICODE_USAGE_PANEL_DEFAULT_WIDTH);
  assert.equal(parseZaicodeUsagePanelWidth(null, 1600), ZAICODE_USAGE_PANEL_DEFAULT_WIDTH);
  assert.equal(parseZaicodeUsagePanelWidth("  ", 1600), ZAICODE_USAGE_PANEL_DEFAULT_WIDTH);
  assert.equal(parseZaicodeUsagePanelWidth("640", 1600), 640);
  assert.equal(parseZaicodeUsagePanelWidth("junk", 1600), ZAICODE_USAGE_PANEL_DEFAULT_WIDTH);
});

test("REQ-008: dragging snaps near the default, saved customs survive reads", () => {
  assert.equal(snapZaicodeUsagePanelWidth(480), 480);
  assert.equal(snapZaicodeUsagePanelWidth(471), 480);
  assert.equal(snapZaicodeUsagePanelWidth(500), 500);
  assert.equal(parseZaicodeUsagePanelWidth("500", 1600), 500);
});
