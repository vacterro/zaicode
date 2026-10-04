import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { PresetEnv, PresetUndo } from "../src/zaicode/zaicodePresetApply.js";
import type { ZaicodePresetSectionId } from "../src/zaicode/zaicodePresetSections.js";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => void values.set(key, value),
  removeItem: (key: string) => void values.delete(key),
};
let reloads = 0;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: Object.assign(new EventTarget(), {
    localStorage: storage,
    location: { reload: () => { reloads += 1; } },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    innerWidth: 1280,
    innerHeight: 800,
  }),
});

const { memoryBlobStore } = await import("../src/zaicode/zaicodePresetAssets.js");
const { applyPreset, resetSection, saveCurrentPreset, undoLastApply } =
  await import("../src/zaicode/zaicodePresetApply.js");
const { ZAICODE_PRESET_SECTIONS } = await import("../src/zaicode/zaicodePresetSections.js");
const { useZaicodeTimers, reloadZaicodeTimerPrefs } = await import("../src/zaicode/zaicodeTimerStore.js");
const { ZAICODE_INTERVAL_DEFAULT_RULE } = await import("../src/zaicode/zaicodeIntervalRules.js");

function environment(): PresetEnv {
  const undos = new Map<ZaicodePresetSectionId, PresetUndo>();
  return Object.assign({
    read: (key: string) => storage.getItem(key),
    write: (key: string, value: string | null) => void (value === null ? storage.removeItem(key) : storage.setItem(key, value)),
    sources: [],
    blobs: memoryBlobStore(),
    undo: {
      get: (section: ZaicodePresetSectionId) => undos.get(section) ?? null,
      set: (section: ZaicodePresetSectionId, undo: PresetUndo | null) => void (undo ? undos.set(section, undo) : undos.delete(section)),
    },
    rehydrate: (section: ZaicodePresetSectionId) => {
      if (section === "zaicodeTimers") reloadZaicodeTimerPrefs();
      // The old contract interpreted false as permission to interrupt the runtime.
      return false;
    },
    now: () => "2026-10-04T00:00:00.000Z",
  }, { reload: () => { reloads += 1; } });
}

test("a production preset environment has no renderer reload capability", () => {
  const source = readFileSync(new URL("../src/zaicode/zaicodePresetEnv.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /window\.location\.reload|reload:\s*\(/);
});

test("apply, reset and undo refresh every registered preset family in the same window", async () => {
  const env = environment();
  const before = reloads;
  for (const section of ZAICODE_PRESET_SECTIONS) {
    const preset = (await saveCurrentPreset(env, section.id, section.title)).preset;
    assert.equal((await applyPreset(env, preset)).live, true, section.id);
    assert.equal((await resetSection(env, section.id)).live, true, `${section.id} reset`);
    assert.equal((await undoLastApply(env, section.id))?.live, true, `${section.id} undo`);
  }
  assert.equal(reloads, before);
});

test("timer apply/reset/undo preserves active countdowns, alarms and interval history", async () => {
  const env = environment();
  for (const state of ["running", "paused", "idle"] as const) {
    const productivity = {
      ...useZaicodeTimers.getState().productivity,
      state,
      phase: "break" as const,
      remaining: state === "idle" ? 0 : 91,
      completedCycles: 4,
      alarmPending: state === "idle",
      alarmPhase: state === "idle" ? "work" as const : null,
    };
    const intervalRules = [{ ...ZAICODE_INTERVAL_DEFAULT_RULE, lastFired: 123_456, lastFiredMinute: "2026-10-04 01:00" }];
    useZaicodeTimers.setState({ productivity, intervalRules, missed: ["local-alarm"] });
    useZaicodeTimers.getState().setClock({ showSeconds: false });
    const timers = useZaicodeTimers.getState().timers;
    const preset = {
      id: `timer-${state}`, section: "zaicodeTimers" as const, name: "Clock with old facts",
      createdAt: "2026-10-04T00:00:00.000Z", assets: [],
      settings: {
        "zaicode-timer-prefs-v1": {
          clock: { showSeconds: true },
          productivity: { workSeconds: 600, breakSeconds: 120, completedCycles: 999, remaining: 999 },
          intervalRules: [{ ...ZAICODE_INTERVAL_DEFAULT_RULE, id: "foreign", lastFired: 999 }],
          missed: ["foreign-alarm"],
        },
      },
    };
    for (const act of [
      () => applyPreset(env, preset),
      () => resetSection(env, "zaicodeTimers"),
      () => undoLastApply(env, "zaicodeTimers"),
    ]) {
      await act();
      const current = useZaicodeTimers.getState();
      for (const key of ["state", "phase", "remaining", "completedCycles", "alarmPending", "alarmPhase"] as const) {
        assert.equal(current.productivity[key], productivity[key], `${state}: ${key}`);
      }
      assert.deepEqual(current.timers, timers);
      assert.deepEqual(current.intervalRules, intervalRules);
      assert.deepEqual(current.missed, ["local-alarm"]);
    }
  }
});

test("a saved timer preset excludes machine schedules and productivity run facts", async () => {
  const env = environment();
  const preset = (await saveCurrentPreset(env, "zaicodeTimers", "Share clock")).preset;
  const prefs = preset.settings["zaicode-timer-prefs-v1"] as Record<string, unknown>;
  assert.equal("intervalRules" in prefs, false);
  assert.equal("missed" in prefs, false);
  const productivity = prefs.productivity as Record<string, unknown>;
  assert.equal("completedCycles" in productivity, false);
  assert.equal("remaining" in productivity, false);
});
