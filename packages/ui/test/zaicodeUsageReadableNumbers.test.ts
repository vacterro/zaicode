import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatZaicodeUsageCount,
  formatZaicodeUsageCost,
  formatZaicodeUsageExactCount,
} from "../src/zaicode/zaicodeUsageLabels.js";

test("Usage counts stay short, rounded and readable at unit boundaries", () => {
  for (const [value, expected] of [
    [0, "0"], [20, "20"], [999, "999"], [999.9, "1K"], [1000, "1K"],
    [12345, "12.3K"], [999999, "1M"], [295520523, "296M"], [3070000000, "3.07B"],
  ] as const) assert.equal(formatZaicodeUsageCount(value), expected);
});

test("Usage cost uses one dash for missing or zero, and preserves a genuinely positive tiny cost", () => {
  for (const value of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatZaicodeUsageCost(value), "—");
  }
  assert.equal(formatZaicodeUsageCost(0.0001), "<$0.01");
  assert.equal(formatZaicodeUsageCost(0.8459), "$0.85");
  assert.equal(formatZaicodeUsageCost(10), "$10");
  assert.equal(formatZaicodeUsageCost(61.8316), "$61.8");
  assert.equal(formatZaicodeUsageCost(567.872), "$568");
  assert.equal(formatZaicodeUsageCost(12345), "$12.3K");
});

test("Usage invalid counts never invent a value, and the hover representation keeps full integers", () => {
  for (const value of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(formatZaicodeUsageCount(value), "—");
  }
  assert.equal(formatZaicodeUsageExactCount(295520523), (295520523).toLocaleString(undefined, { maximumFractionDigits: 0 }));
});
