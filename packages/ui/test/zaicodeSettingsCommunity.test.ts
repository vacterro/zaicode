import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setZaicodeModelAppearance } from "../src/zaicode/zaicodeModelAppearance.js";

// T-116 (SRC-080): three operator-visible faults in Settings, each pinned by
// the structure that caused it -- a missing bottom link, a toggle that only
// updated when some unrelated store re-rendered the page, and a sounds table
// whose rows staircase out from under their nine-column header.

test("the Discord SAIPEN COMMUNITY invite is the last Settings sidebar link", () => {
  // zaicodeBrand imports .svg assets, so the value is asserted on the source,
  // the way the other Settings structure tests read their subjects.
  const brand = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeBrand.ts"), "utf8");
  assert.match(brand, /export const ZAICODE_DISCORD_URL = "https:\/\/discord\.gg\/SEYaYkuVgN"/);
  const page = readFileSync(join(import.meta.dirname, "..", "src", "SettingsPage.tsx"), "utf8");
  const support = page.indexOf('data-zaicode-support-link=""');
  const discord = page.indexOf('data-zaicode-discord-link=""');
  assert.ok(support >= 0, "the Support Developer row anchors the bottom of the sidebar");
  assert.ok(discord > support, "the Discord row sits below Support Developer, at the very bottom");
  assert.match(page, /platform\.openExternal\(ZAICODE_DISCORD_URL\)/);
});

test("one appearance write dispatches the event a subscribed control listens for", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "zaicodeModelAppearance.ts"), "utf8");
  assert.match(source, /export const ZAICODE_MODEL_APPEARANCE_CHANGED_EVENT/);
  assert.match(
    source,
    /window\.addEventListener\(ZAICODE_MODEL_APPEARANCE_CHANGED_EVENT, listener\)/,
    "a React subscription binds to that event",
  );
  assert.match(source, /window\.dispatchEvent\(new Event\(ZAICODE_MODEL_APPEARANCE_CHANGED_EVENT\)\)/);

  const settings = readFileSync(join(import.meta.dirname, "..", "src", "zaicode", "ZaicodeModelAppearanceSettings.tsx"), "utf8");
  assert.match(settings, /useZaicodeModelAppearancePrefs\(\)/, "the Settings screen reads the prefs as live state");

  // The behavior the operator saw: a toggle that wrote prefs nothing reacted
  // to. Here the write itself must reach a listener in the same tick.
  const fired: string[] = [];
  const windowStub = {
    addEventListener: (name: string) => fired.push(`add:${name}`),
    removeEventListener: () => undefined,
    dispatchEvent: (event: Event) => fired.push(`event:${(event as { type: string }).type}`) || true,
  };
  const hadWindow = "window" in globalThis;
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = windowStub;
  try {
    setZaicodeModelAppearance({ providerId: "test-provider", modelId: "test-model" }, { mode: "separate" });
  } finally {
    if (hadWindow) (globalThis as { window?: unknown }).window = previous;
    else delete (globalThis as { window?: unknown }).window;
  }
  assert.ok(fired.includes("event:zaicode-model-appearance-changed"), `the write notified listeners, got ${fired.join(", ")}`);
});

test("a sounds row keeps its nine columns and wraps the pool sub-row after the preview button", () => {
  const table = readFileSync(join(import.meta.dirname, "..", "src", "settings", "ZaicodeSoundSettings.tsx"), "utf8");
  const preview = table.indexOf('title="Preview at the real volume"');
  const pool = table.indexOf("<ZaicodePoolControls event={event} row={row} />");
  assert.ok(preview >= 0, "each row ends in its preview button");
  assert.ok(pool > preview, "the full-width pool controls come after the last column cell, never between columns");
});

// SRC-086: the Discord label ran into the row's border in the narrow Settings sidebar.
test("the Discord row wraps its label instead of running into the border", () => {
  const page = readFileSync(join(import.meta.dirname, "..", "src", "SettingsPage.tsx"), "utf8").replace(/\r\n/g, "\n");
  const start = page.indexOf('data-zaicode-discord-link=""');
  const block = page.slice(page.lastIndexOf("<SettingsSidebarButton", start), page.indexOf("</SettingsSidebarButton>", start));
  assert.ok(block.includes("h-auto min-h-8"), "the row may grow past one line");
  assert.ok(block.includes("whitespace-normal"), "the words wrap");
  assert.ok(!block.includes("truncate"), "nothing is cut with an ellipsis");
});
