import assert from "node:assert/strict";
import test from "node:test";
import bundledDefaults from "../src/zaicode/zaicodeSettingsDefaults.json" with { type: "json" };
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

function withLocalStorage<T>(values: Map<string, string>, run: () => Promise<T>): Promise<T> {
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

// T-245 / SRC-160:R005: the snapshot becomes the NEXT install's factory default, so state
// about one session or one run must never travel inside an allowlisted family. Each such
// family declares its volatile fields and they are stripped; a family that still carries
// session state is refused instead of shipped.
type Snapshot = { version: number; settings: Record<string, string>; cueAudio: Record<string, string> };

function snapshotOf(values: Map<string, string>): Promise<Snapshot> {
  return withLocalStorage(values, async () => JSON.parse(await captureZaicodeSettingsSnapshot()) as Snapshot);
}

test("T-245: a per-session override in an allowlisted family never reaches the snapshot", async () => {
  const values = new Map<string, string>([
    [
      "zaicode-ui-prefs-v1",
      JSON.stringify({
        showGreeting: false,
        autoRetrySessions: { sess_3377c3c7: true },
        schedulerIneligible: { sess_3377c3c7: true },
      }),
    ],
  ]);
  const snapshot = await snapshotOf(values);
  assert.deepEqual(JSON.parse(snapshot.settings["zaicode-ui-prefs-v1"]!), { showGreeting: false });
  assert.doesNotMatch(JSON.stringify(snapshot), /sess_/);
});

test("T-245: an undeclared family carrying session state is refused, not shipped", async () => {
  const values = new Map<string, string>([
    ["zaicode-home-v1", JSON.stringify({ startup: "newTask", sess_31f0: { open: true } })],
  ]);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const snapshot = await snapshotOf(values);
    assert.equal(snapshot.settings["zaicode-home-v1"], undefined);
    assert.doesNotMatch(JSON.stringify(snapshot), /sess_31f0/);
    assert.match(warnings.join("\n"), /Save All refused zaicode-home-v1/);
  } finally {
    console.warn = realWarn;
  }
});

test("T-245: autostart rows keep the schedule and drop fired-event and run history", async () => {
  const row = {
    id: "job-1",
    name: "SAIPEN",
    enabled: true,
    prompt: "cc all",
    stopAt: "07:00",
    trigger: "everyReset",
    firedEvents: ["reset:five_hour:1791012089000"],
    lastRunAt: 1791070642829,
    lastResult: "C1 started",
    runs: [{ jobId: "session:s1" }],
  };
  const snapshot = await snapshotOf(new Map([["zaicode-autostart-v1", JSON.stringify([row])]]));
  assert.deepEqual(JSON.parse(snapshot.settings["zaicode-autostart-v1"]!), [
    { id: "job-1", name: "SAIPEN", enabled: true, prompt: "cc all", stopAt: "07:00", trigger: "everyReset" },
  ]);
});

test("T-245: timer rules keep the schedule and drop the last-fired marks", async () => {
  const values = new Map([
    [
      "zaicode-timer-prefs-v1",
      JSON.stringify({
        intervalRules: [
          { id: "r1", minutes: 60, enabled: true, lastFired: 1791190800277, lastFiredMinute: "2026-10-05 12:00" },
        ],
      }),
    ],
  ]);
  const snapshot = await snapshotOf(values);
  assert.deepEqual(JSON.parse(snapshot.settings["zaicode-timer-prefs-v1"]!), {
    intervalRules: [{ id: "r1", minutes: 60, enabled: true }],
  });
});

test("T-245: a family with no session state travels byte-identical", async () => {
  const raw = JSON.stringify({ showProject: true, size: 16 });
  const snapshot = await snapshotOf(new Map([["zaicode-header-title-v1", raw]]));
  assert.equal(snapshot.settings["zaicode-header-title-v1"], raw);
});

test("T-245: the shipped defaults carry no session or run state", () => {
  const volatile = [
    "autoRetrySessions",
    "schedulerIneligible",
    "firedEvents",
    "lastRunAt",
    "lastResult",
    "runs",
    "lastFired",
    "lastFiredMinute",
    "lastProject",
    "lastView",
  ];
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((row, index) => walk(row, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith("sess_") || volatile.includes(key)) found.push(`${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(bundledDefaults.settings)) {
    try {
      walk(JSON.parse(value), key);
    } catch {
      // A scalar value carries no nested state.
    }
  }
  assert.deepEqual(found, []);
});
