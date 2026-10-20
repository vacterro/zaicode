import assert from "node:assert/strict";
import test from "node:test";
import bundled from "../src/zaicode/zaicodeSettingsDefaults.json" with { type: "json" };
import {
  captureZaicodeSettingsSnapshot,
  readZaicodeSetting,
  ZAICODE_SAVE_ALL_SETTING_KEYS,
} from "../src/zaicode/zaicodeSettingsSnapshot.js";

const SCHEDULE_KEY = "zaicode-autostart-v1";
const schedule = { id: "synthetic-schedule", name: "Synthetic private task", enabled: true,
  prompt: "synthetic local task", trigger: "time", time: "02:20", project: "C:/synthetic-workspace" };

async function capture(values: Map<string, string>): Promise<Record<string, string>> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const original = [...values];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: () => { throw new Error("export must not write operator storage"); },
    removeItem: () => { throw new Error("export must not delete operator schedules"); },
  } });
  try {
    const result = JSON.parse(await captureZaicodeSettingsSnapshot()) as { settings: Record<string, string> };
    assert.deepEqual([...values], original);
    for (const [key, value] of original) assert.equal(readZaicodeSetting(key), value);
    return result.settings;
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

test("T-326: release allowlist excludes user autostart schedules", () => {
  assert.equal(new Set<string>(ZAICODE_SAVE_ALL_SETTING_KEYS).has(SCHEDULE_KEY), false);
});

for (const raw of [JSON.stringify([schedule]), JSON.stringify([{ ...schedule, enabled: false }]), "[]", "{malformed"]) {
  test(`T-326: Save Settings excludes schedules without changing live bytes (${raw.length})`, async () => {
    const appearance = '{"showProject":true,"size":16}';
    const result = await capture(new Map([[SCHEDULE_KEY, raw], ["zaicode-header-title-v1", appearance]]));
    assert.equal(result[SCHEDULE_KEY], undefined);
    assert.equal(result["zaicode-header-title-v1"], appearance);
  });
}

test("T-326: custom timer rules and missed markers do not travel with clock preferences", async () => {
  const raw = JSON.stringify({ clock: { showDate: true, hour12: false }, temp: { minutes: 5 },
    intervalRules: [{ id: "synthetic-interval", enabled: true, minutes: 60 }], missed: ["synthetic-interval"] });
  const result = await capture(new Map([["zaicode-timer-prefs-v1", raw]]));
  assert.deepEqual(JSON.parse(result["zaicode-timer-prefs-v1"]!), {
    clock: { showDate: true, hour12: false }, temp: { minutes: 5 },
  });
});

for (const key of ["zaicode-presets-v1", "zaicode-profiles"]) {
  test(`T-326: nested legacy ${key} cannot reintroduce user schedules`, async () => {
    const raw = JSON.stringify({ rows: [{ name: "synthetic bundle", values: {
      [SCHEDULE_KEY]: JSON.stringify([schedule]),
      "zaicode-timer-prefs-v1": JSON.stringify({ clock: { showDate: true }, intervalRules: [schedule], missed: ["synthetic"] }),
      "zaicode-protrail-v1": '{"enabled":false}',
    } }] });
    const result = await capture(new Map([[key, raw]]));
    const projected = JSON.parse(result[key]!) as { rows: { values: Record<string, string> }[] };
    const values = projected.rows[0]!.values;
    assert.equal(values[SCHEDULE_KEY], undefined);
    assert.deepEqual(JSON.parse(values["zaicode-timer-prefs-v1"]!), { clock: { showDate: true } });
    assert.equal(values["zaicode-protrail-v1"], '{"enabled":false}');
  });
}

test("T-326: bundled defaults do not contain user autostart rules", () => {
  assert.equal(Object.hasOwn(bundled.settings, SCHEDULE_KEY), false);
  const prefs = JSON.parse(bundled.settings["zaicode-timer-prefs-v1"] ?? "{}") as Record<string, unknown>;
  assert.equal(Object.hasOwn(prefs, "intervalRules"), false);
  assert.equal(Object.hasOwn(prefs, "missed"), false);
});

test("T-326: an empty profile has no inherited autostart schedule", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  try { assert.equal(readZaicodeSetting(SCHEDULE_KEY), null); }
  finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
