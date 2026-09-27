import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ZAICODE_FOOTER_TOOLS, normalizeZaicodeLayoutList } from "../src/zaicode/zaicodeLayoutPrefs.js";

// SRC-062 append: "make ProTrail visible as an on/off item -- if the user does
// not like it they switch it off fast, and back on if they change their mind;
// right click opens the full settings; put it next to Problip. And make the
// footer section fully changeable: e.g. keep just the avatar of the profile
// and fill the freed space with my own buttons, as usual."

const source = (path: string) => readFileSync(join(import.meta.dirname, "../src", path), "utf8");

test("the footer row defaults to Problip, ProTrail next to it, and the gear", () => {
  const list = normalizeZaicodeLayoutList(null, ZAICODE_FOOTER_TOOLS);
  assert.deepEqual(
    list.filter((entry) => entry.visible).map((entry) => entry.id),
    ["problip", "protrail", "settings"],
  );
  // Every other shared button can join the row.
  for (const id of ["home", "timers", "help", "mute", "palette", "workers", "dispatch", "focusCycle"]) {
    assert.ok(list.some((entry) => entry.id === id && !entry.visible), id);
  }
});

test("a stored footer keeps the operator's order and drops what this build does not know", () => {
  const list = normalizeZaicodeLayoutList(
    [
      { id: "settings", visible: true },
      { id: "timers", visible: true },
      { id: "gone", visible: true },
      { id: "protrail", visible: false },
    ],
    ZAICODE_FOOTER_TOOLS,
  );
  // The stored entries keep their order and visibility...
  const stored = list.filter((entry) => ["settings", "timers", "protrail"].includes(entry.id));
  assert.deepEqual(stored.map((entry) => [entry.id, entry.visible]), [
    ["settings", true],
    ["timers", true],
    ["protrail", false],
  ]);
  // ...and the ones not stored come back with their defaults (Problip, the first definition, first).
  assert.deepEqual([list[0]!.id, list[0]!.visible], ["problip", true]);
  assert.equal(list.length, ZAICODE_FOOTER_TOOLS.length);
  assert.ok(!list.some((entry) => (entry.id as string) === "gone"));
});

test("ProTrail's footer button: left click toggles, right click opens its settings", () => {
  const footer = source("zaicode/ZaicodeFooterTools.tsx");
  assert.match(footer, /onClick=\{\(\) => set\(\{ enabled: !enabled \}\)\}/);
  assert.match(footer, /onContextMenu=\{\(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);\s+openZaicodeSettings\("zaicodeProtrail"\);/);
});

test("the profile can shrink to its avatar and hand its width to the buttons", () => {
  const footer = source("WorkspaceSidebarFooter.tsx");
  assert.match(footer, /<ZaicodeProfileBadge avatarOnly=\{zaicodeAvatarOnly\} \/>/);
  assert.match(footer, /zaicodeAvatarOnly \? "shrink-0" : "min-w-0 flex-1"/);
  assert.match(footer, /<ZaicodeFooterTools settingsButton=\{settingsButton\} \/>/);
  const tools = source("zaicode/ZaicodeFooterTools.tsx");
  assert.match(tools, /fill \? "min-w-0 flex-1" : "shrink-0"/);
  assert.match(tools, /<ZaicodeOverflowRow className="flex-1" items=\{items\} \/>/, "whatever does not fit moves into ⋯");
  assert.match(source("settings/ZaicodeSidebarSettings.tsx"), /<ZaicodeFooterEditor \/>/, "Settings -> Sidebar edits the same list");
});
