import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// SRC-087: "make the list more compact, remove the empty places where a whole empty line is created
// for single/pool ... and review all of ZAICODE for places where such voids come from small things".

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8").replace(/\r\n/g, "\n");

test("Sounds: single/pool is a cell in the event row, and only a pool takes an extra line", () => {
  const pool = source("settings/ZaicodeSoundPoolControls.tsx");
  assert.match(pool, /export function ZaicodePoolModeButton/);
  assert.match(pool, /if \(row\.soundMode !== "pool"\) return null;/, "a single-sound event draws no sub-row");
  assert.doesNotMatch(pool, /\{mode === "single" \? "single" : "pool"\}/, "the two labelled buttons are gone from the sub-row");
  const table = source("settings/ZaicodeSoundSettings.tsx");
  assert.match(table, /<ZaicodePoolModeButton event=\{event\} row=\{row\} \/>/);
  // The header, the group rows and the event rows agree on ten columns.
  assert.match(table, /grid-cols-\[18px_minmax\(120px,1\.2fr\)_28px_minmax\(120px,1fr\)_22px_22px_58px_minmax\(110px,1fr\)_52px_22px\]/);
  assert.match(table, /col-span-10 mt-1 flex/);
  assert.doesNotMatch(table, /col-span-9/);
  const preview = table.indexOf('title="Preview at the real volume"');
  assert.ok(table.indexOf("<ZaicodePoolControls", preview) > preview, "the pool sub-row still follows the last column cell");
});

test("Notifications: a scenario is one line, its hint follows the label; timers: no 80 px box for an empty list", () => {
  const notifications = source("settings/ZaicodeNotificationsSettings.tsx");
  assert.doesNotMatch(notifications, /block truncate text-\[10px\] text-foreground-subtlest">\{scenario\.hint\}/, "the hint no longer doubles the row");
  assert.match(notifications, /flex min-w-0 items-baseline gap-2/);
  const timers = source("zaicode/ZaicodeTimersAlarms.tsx");
  assert.doesNotMatch(timers, /min-h-\[80px\]/);
});
