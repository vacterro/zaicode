import assert from "node:assert/strict";
import { test } from "node:test";
import { admitZaicodeSound, createZaicodeSoundMemory } from "../src/zaicode/zaicodeSoundBus.js";
import { createSettingsPageConfig, resolveSettingsSectionForPlatform } from "../src/settings/settingsPageConfig.js";
import { resolveSettingsSection } from "../src/lib/settingsNavigation.js";

test("every real hover and typing event is admitted even within 120 ms", () => {
  const memory = createZaicodeSoundMemory();
  for (const id of ["ui.hover", "ui.typing"]) {
    assert.equal(admitZaicodeSound(id, false, 1000, memory), true);
    assert.equal(admitZaicodeSound(id, false, 1010, memory), true);
    assert.equal(admitZaicodeSound(id, false, 1020, memory), true);
  }
  assert.equal(admitZaicodeSound("session.open", false, 2000, memory), true);
  assert.equal(admitZaicodeSound("session.open", false, 2010, memory), false);
});
test("hotkeys has one visible destination and legacy links resolve to shortcuts", () => {
  const { settingsSections } = createSettingsPageConfig({ isDesktop: true });
  assert.equal(settingsSections.some((s) => s.id === "zaicodeHotkeys"), false);
  assert.equal(settingsSections.some((s) => s.id === "shortcuts"), true);
  assert.equal(resolveSettingsSection("zaicodeHotkeys"), "shortcuts");
  assert.equal(resolveSettingsSectionForPlatform("zaicodeHotkeys", settingsSections), "shortcuts");
});
