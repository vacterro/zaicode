import assert from "node:assert/strict";
import test from "node:test";
import {
  captureZaicodeSettingsSnapshot,
  readBundledZaicodeCustomSound,
  readZaicodeCustomSoundBlob,
  readZaicodeSetting,
} from "../src/zaicode/zaicodeSettingsSnapshot.js";

test("release snapshot keeps durable preferences and drops runtime audio state", async () => {
  const values = new Map<string, string>([
    ["zaicode-ui-prefs-v1", JSON.stringify({ showGreeting: false })],
    ["zaicode-audio-v1", JSON.stringify({ ambience: { volume: 0.2 }, problip: { running: true, runOnLaunch: true }, problipDays: { yesterday: 5 } })],
    ["zaicode-main-sessions-v1", "session-id"],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  try {
    assert.equal(readZaicodeSetting("zaicode-ui-prefs-v1"), values.get("zaicode-ui-prefs-v1"));
    const snapshot = JSON.parse(await captureZaicodeSettingsSnapshot()) as {
      version: number;
      settings: Record<string, string>;
      cueAudio: Record<string, string>;
    };
    assert.equal(snapshot.version, 1);
    assert.deepEqual(JSON.parse(snapshot.settings["zaicode-ui-prefs-v1"]!), { showGreeting: false });
    assert.deepEqual(JSON.parse(snapshot.settings["zaicode-audio-v1"]!), {
      ambience: { volume: 0.2 },
      problip: { running: false, runOnLaunch: true },
    });
    assert.equal(snapshot.settings["zaicode-main-sessions-v1"], undefined);
    assert.deepEqual(snapshot.cueAudio, {});
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

function withLocalStorage(values: Map<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null },
  });
  return run().finally(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}

test("release snapshot refuses a Sounds-table own file it cannot carry", async () => {
  const values = new Map<string, string>([
    ["zaicode-sound-events-v1", JSON.stringify({ events: { "agent.done": { sound: "custom:agent.done" } } })],
    ["zaicode-sound-custom-names", JSON.stringify({ "agent.done": "gong.wav" })],
  ]);
  await withLocalStorage(values, async () => {
    // No IndexedDB here and nothing bundled: the file is really missing.
    assert.equal(await readZaicodeCustomSoundBlob("custom:agent.done"), null);
    assert.equal(readBundledZaicodeCustomSound("custom:agent.done"), null);
    await assert.rejects(captureZaicodeSettingsSnapshot(), /Own sound for agent\.done is missing/);
  });
});

test("release snapshot keeps Sounds-table rows and own-file names", async () => {
  const rows = JSON.stringify({ events: { "agent.done": { sound: "fastprompter:blip1.wav" } } });
  const names = JSON.stringify({ "agent.done": "gong.wav" });
  const values = new Map<string, string>([
    ["zaicode-sound-events-v1", rows],
    ["zaicode-sound-custom-names", names],
  ]);
  await withLocalStorage(values, async () => {
    const snapshot = JSON.parse(await captureZaicodeSettingsSnapshot()) as {
      settings: Record<string, string>;
      cueAudio: Record<string, string>;
    };
    assert.equal(snapshot.settings["zaicode-sound-events-v1"], rows);
    assert.equal(snapshot.settings["zaicode-sound-custom-names"], names);
    assert.deepEqual(snapshot.cueAudio, {});
  });
});
