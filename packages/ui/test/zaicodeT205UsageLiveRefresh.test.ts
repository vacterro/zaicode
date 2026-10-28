import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  zaicodeUsageNameColumnPercent,
  ZAICODE_USAGE_DEFAULT_REFRESH_SECONDS,
  ZAICODE_USAGE_NAME_COLUMN_MAX_PERCENT,
  ZAICODE_USAGE_NAME_COLUMN_MIN_PERCENT,
  ZAICODE_USAGE_REFRESH_SECONDS,
} from "../src/zaicode/zaicodeUsage.js";

const view = readFileSync(
  fileURLToPath(new URL("../src/zaicode/ZaicodeUsageView.tsx", import.meta.url)),
  "utf8",
);

test("the live meter offers every refresh rate the user asked for, 10s still the default", () => {
  assert.deepEqual([...ZAICODE_USAGE_REFRESH_SECONDS], [10, 5, 3, 2, 1]);
  assert.equal(ZAICODE_USAGE_DEFAULT_REFRESH_SECONDS, 10);
  assert.ok(
    (ZAICODE_USAGE_REFRESH_SECONDS as readonly number[]).includes(
      ZAICODE_USAGE_DEFAULT_REFRESH_SECONDS,
    ),
  );
});

test("the panel reads its timer from the chosen rate instead of a fixed 10s", () => {
  // The rate reaches the one timer that drives the meter; no second, hardcoded interval.
  assert.match(view, /setTimeout\(\(\) => void read\(\), refreshSeconds \* 1000\)/);
  assert.doesNotMatch(view, /read\(\), 10_000\)/);
  assert.doesNotMatch(view, /Live · 10s/);
  // And it is offered as a control, wired to that state, not just a label.
  assert.match(view, /data-zaicode-usage-refresh/);
  assert.match(view, /setRefreshSeconds\(next as ZaicodeUsageRefreshSeconds\)/);
  assert.match(view, /ZAICODE_USAGE_REFRESH_SECONDS\.map\(\(seconds\)/);
});

test("dragging the name column widens it within the bounds the metrics need", () => {
  const table = { tableLeft: 100, tableWidth: 1000, current: 34 };
  assert.equal(zaicodeUsageNameColumnPercent({ clientX: 550, ...table }), 45);
  assert.equal(zaicodeUsageNameColumnPercent({ clientX: 50, ...table }), ZAICODE_USAGE_NAME_COLUMN_MIN_PERCENT);
  assert.equal(zaicodeUsageNameColumnPercent({ clientX: 900, ...table }), ZAICODE_USAGE_NAME_COLUMN_MAX_PERCENT);
  // A collapsed or unmounted table has no width to divide by: keep what the user had.
  assert.equal(zaicodeUsageNameColumnPercent({ clientX: 550, ...table, tableWidth: 0 }), 34);
  assert.ok(ZAICODE_USAGE_NAME_COLUMN_MIN_PERCENT < ZAICODE_USAGE_NAME_COLUMN_MAX_PERCENT);
});

test("the table hands its name column to a drag handle and to the row cells", () => {
  assert.match(view, /data-zaicode-usage-column-resize/);
  assert.match(view, /aria-orientation="vertical"/);
  assert.match(view, /setPointerCapture\(event\.pointerId\)/);
  assert.match(view, /cursor-col-resize/);
  assert.match(view, /ref=\{tableRef\}/);
  // The width is state now, not a class the user cannot move.
  assert.doesNotMatch(view, /w-\[34%\]|w-\[29%\]/);
  assert.equal(
    view.split("style={{ width: `${nameColumnPercent}%` }}").length - 1,
    2,
    "the header and the body cells share the dragged width",
  );
});

test("a finished request no longer prints a status word under the model name", () => {
  assert.match(view, /const status =\s*tab === "recent" && data/);
  assert.match(view, /\{status \? \(/);
});