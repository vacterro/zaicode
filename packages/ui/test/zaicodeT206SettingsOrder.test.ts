import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

// T-206: "убрать irrelevant настройки секции в самый низ ... и так везде" --
// low-importance settings move to the bottom of their group and fold away by default.
test("decorative ZAICODE sections fold into the advanced bucket at the bottom of the group", () => {
  const { settingsSectionGroups } = createSettingsPageConfig({ isDesktop: true });
  const zaicode = settingsSectionGroups.find((group) => group.id === "zaicode");
  assert.ok(zaicode, "the ZAICODE group is present");

  const primary = zaicode.sections.map((section) => section.id);
  const advanced = zaicode.advancedSections.map((section) => section.id);

  assert.ok(advanced.length > 0, "something must actually be demoted, or this is a no-op");
  // The two lists partition the group: a demoted section must not also stay visible.
  assert.deepEqual(primary.filter((id) => advanced.includes(id)), []);
  assert.equal(primary.length + advanced.length, new Set([...primary, ...advanced]).size);

  // Everyday configuration must stay reachable without expanding anything.
  for (const id of ["zaicode", "zaicodeSidebar", "zaicodeLayout", "zaicodeEngines", "zaicodeWorkers"]) {
    assert.ok(primary.includes(id as never), `${id} stays in the visible list`);
  }
  for (const id of [
    "zaicodeSounds",
    "zaicodeColors",
    "zaicodeLights",
    "zaicodeProtrail",
    "zaicodeSessionText",
    "zaicodeNotifications",
  ]) {
    assert.ok(advanced.includes(id as never), `${id} is demoted`);
  }
});

test("no group renders an advanced fold it never fills", () => {
  for (const isDesktop of [false, true]) {
    const { settingsSectionGroups } = createSettingsPageConfig({ isDesktop });
    for (const group of settingsSectionGroups) {
      if (group.advancedSections.length === 0) continue;
      assert.ok(group.sections.length > 0, `${group.id}: an advanced-only group renders an empty label`);
    }
  }
});

test("the ZAICODE page folds SAIASUI and the splash instead of greeting the user with them", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../src/settings/ZaicodeSettingsSection.tsx"),
    "utf8",
  );
  const foldStart = source.indexOf("data-zaicode-advanced");
  assert.ok(foldStart > 0, "the advanced fold exists");

  // Native <details> starts collapsed: no `open` attribute on the element.
  assert.doesNotMatch(source.slice(foldStart, foldStart + 200), /<details[^>]*\sopen/, "the fold must start collapsed");
  const folded = source.slice(foldStart);
  assert.match(folded, /<SaiasuiSettings \/>/, "SAIASUI lives in the fold");
  assert.match(folded, /<ZaicodeSplashSettings \/>/, "the splash lives in the fold");

  const beforeFold = source.slice(0, foldStart);
  assert.doesNotMatch(beforeFold, /<SaiasuiSettings \/>/, "SAIASUI must not greet the user before the fold");
});