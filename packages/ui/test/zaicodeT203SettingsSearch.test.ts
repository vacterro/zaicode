import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createSettingsPageConfig,
  searchSettingsSections,
  type SettingsSectionId,
} from "../src/settings/settingsPageConfig.js";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
const page = read("SettingsPage.tsx");
const entries = createSettingsPageConfig({ isDesktop: true }).settingsSections.map((section) => ({
  id: section.id,
  // The matcher runs on what the operator reads, not on the message id.
  title: String(section.id),
  keywords: section.keywords ?? [],
}));
const ids = (query: string) => searchSettingsSections(entries, query).map((entry) => entry.id);

test("the words someone actually types find the section, not the label alone", () => {
  // "Appearance" is the label; nobody looks for the thing that sets their font size that way.
  assert.deepEqual(ids("font size"), ["appearance", "zaicodeSessionText"]);
  assert.ok(ids("api key").includes("modelProvider"));
  assert.ok(ids("tokens").includes("usage"));
  assert.ok(ids("worker").includes("zaicodeWorkers"));
  assert.ok(ids("keybinding").includes("shortcuts"));
  // automations is a workspace view, not a settings section (settingsNavigation.ts:51), so the
  // search must not offer a destination the sidebar never had.
  assert.ok(!ids("cron").includes("automations"));
});

test("every visible section carries keywords, so no section is a dead end", () => {
  const blank = createSettingsPageConfig({ isDesktop: true })
    .settingsSections.filter((section) => !(section.keywords ?? []).length)
    .map((section) => section.id);
  assert.deepEqual(blank, []);
});

test("an empty query is not a filter", () => {
  const all = entries.map((entry) => entry.id);
  for (const query of ["", "   ", "\t\n"]) {
    assert.deepEqual(ids(query), all);
  }
});

test("all the words have to hit, so two loose ones do not match everything", () => {
  // "dark" alone reaches Appearance; adding "font" narrows rather than widens.
  assert.deepEqual(ids("dark"), ["appearance"]);
  assert.ok(ids("dark").length >= ids("dark font").length);
  assert.deepEqual(ids("font dark"), ["appearance"]);
  assert.deepEqual(ids("nothing matchesthis"), []);
});

test("matching ignores case and the order the words were typed", () => {
  assert.deepEqual(ids("  DARK   FONT "), ["appearance"]);
});

test("the box filters the nav, opens the fold that hides the hit, and jumps on Enter", () => {
  assert.match(page, /data-testid="settings-section-search"/);
  assert.match(page, /onChange=\{\(event\) => setSectionQuery\(event\.target\.value\)\}/);
  assert.match(page, /data-testid="settings-section-search-empty"/);
  assert.match(page, /data-testid="settings-section-search-clear"/);
  // The nav reads the filtered groups, not the raw ones.
  assert.match(page, /visibleSettingsSectionGroups\.map\(/);
  assert.ok(
    !/\{\s*settingsSectionGroups\.map\(/.test(page),
    "the nav must not still render the unfiltered groups",
  );
  // A hit inside T-206's Advanced fold has to open it, or finding it proves nothing.
  assert.match(page, /\.\.\.\(isSearching \? \{ open: true \} : \{\}\)/);
  assert.ok(
    page.indexOf("setAdvancedRevealed") < page.indexOf("visibleSettingsSectionGroups.map("),
    "advancedRevealed is decided from the filtered groups before the nav renders",
  );
  // Enter opens the first surviving section.
  assert.match(page, /if \(event\.key !== "Enter"\) return;/);
  assert.match(page, /\[\.\.\.group\.sections, \.\.\.group\.advancedSections\]\)\[0\]/);
});

test("outside a search the Advanced fold stays the operator's to open and close", () => {
  // `open` must not be bound unconditionally, or the T-206 fold can never be collapsed again.
  const details = page.match(/<details[\s\S]{0,400}?>/g)?.filter((node) => node.includes("settings-advanced")) ?? [];
  assert.equal(details.length, 1);
  assert.doesNotMatch(details[0]!, /\sopen=\{advancedRevealed\}/);
});
