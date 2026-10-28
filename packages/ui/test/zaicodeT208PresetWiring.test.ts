import assert from "node:assert/strict";
import test from "node:test";
import * as preferences from "../src/lib/taskNotificationPreferences.js";
import * as sections from "../src/zaicode/zaicodePresetSections.js";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, value),
};
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });

test("notification preset writes refresh existing subscribers without rewriting removed keys", () => {
  const api = preferences as typeof preferences & {
    subscribeTaskNotificationPreferences: (listener: (snapshot: Record<string, boolean>) => void) => () => void;
    reloadTaskNotificationPreferences: () => void;
  };
  assert.equal(typeof api.subscribeTaskNotificationPreferences, "function");
  assert.equal(typeof api.reloadTaskNotificationPreferences, "function");
  const snapshots: Record<string, boolean>[] = [];
  const unsubscribe = api.subscribeTaskNotificationPreferences(value => snapshots.push(value));
  values.set("zcode-notification-enabled", "false");
  values.set("zcode-notification-sound-enabled", "false");
  api.reloadTaskNotificationPreferences();
  assert.deepEqual(snapshots.at(-1), { notificationEnabled: false, notificationSoundEnabled: false });
  values.clear();
  api.reloadTaskNotificationPreferences();
  assert.deepEqual(snapshots.at(-1), { notificationEnabled: true, notificationSoundEnabled: true });
  assert.equal(values.size, 0, "refresh is a read, not a settings write");
  unsubscribe();
  const count = snapshots.length;
  api.reloadTaskNotificationPreferences();
  assert.equal(snapshots.length, count, "an unmounted owner has no stale subscriber");
});

test("the merged shortcut page retains Hotkeys presets only in ZAICODE mode", () => {
  const api = sections as typeof sections & {
    zaicodePresetSectionForSettings: (id: string, zaicode: boolean) => string | undefined;
  };
  assert.equal(typeof api.zaicodePresetSectionForSettings, "function");
  assert.equal(api.zaicodePresetSectionForSettings("shortcuts", true), "zaicodeHotkeys");
  assert.equal(api.zaicodePresetSectionForSettings("shortcuts", false), undefined);
  assert.equal(api.zaicodePresetSectionForSettings("general", true), undefined);
  for (const section of sections.ZAICODE_PRESET_SECTIONS) {
    assert.equal(api.zaicodePresetSectionForSettings(section.id, true), section.id);
  }
});
