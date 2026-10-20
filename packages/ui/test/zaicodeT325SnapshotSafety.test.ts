import assert from "node:assert/strict";
import test from "node:test";
import bundled from "../src/zaicode/zaicodeSettingsDefaults.json" with { type: "json" };
import { captureZaicodeSettingsSnapshot } from "../src/zaicode/zaicodeSettingsSnapshot.js";

async function capture(key: string, raw: string): Promise<Record<string, string>> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (name: string) => (name === key ? raw : null) },
  });
  try {
    return (
      JSON.parse(await captureZaicodeSettingsSnapshot()) as { settings: Record<string, string> }
    ).settings;
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

const durable = {
  id: "synthetic-rule",
  enabled: true,
  prompt: "bounded synthetic task",
  trigger: "time",
  time: "09:00",
  continuation: { enabled: true, runnerIds: ["synthetic-local"], delayMinutes: 2 },
};

test("T-326: scheduler policy and continuation execution records are both excluded", async () => {
  const raw = JSON.stringify([
    {
      ...durable,
      continuationRuns: [
        {
          sessionId: "sess_synthetic_release",
          state: "running",
          recovery: { attempts: 3 },
          nested: [{ sessionId: "sess_synthetic_nested" }],
        },
      ],
      lastRunAt: 123,
      lastResult: "synthetic result",
      runs: [{}],
    },
  ]);
  const settings = await capture("zaicode-autostart-v1", raw);
  assert.equal(settings["zaicode-autostart-v1"], undefined);
  assert.doesNotMatch(JSON.stringify(settings), /sess_synthetic/);
});

test("T-325: existing presets lose nested continuation and execution history", async () => {
  const raw = JSON.stringify([
    {
      name: "synthetic preset",
      settings: {
        jobs: [
          {
            ...durable,
            continuationRuns: [{ sessionId: "sess_synthetic_preset" }],
            lastRunAt: 456,
            lastResult: "old",
          },
        ],
      },
    },
  ]);
  const settings = await capture("zaicode-presets-v1", raw);
  assert.deepEqual(JSON.parse(settings["zaicode-presets-v1"]!), [
    { name: "synthetic preset", settings: { jobs: [durable] } },
  ]);
});

test("T-325: preset JSON-encoded families use the same recursive projection", async () => {
  const raw = JSON.stringify([
    {
      settings: {
        "zaicode-autostart-v1": JSON.stringify([
          { ...durable, continuationRuns: [{ sessionId: "synthetic-unprefixed-id" }] },
        ]),
      },
    },
  ]);
  const settings = await capture("zaicode-presets-v1", raw);
  const preset = JSON.parse(settings["zaicode-presets-v1"]!) as {
    settings: Record<string, string>;
  }[];
  assert.equal(preset[0]!.settings["zaicode-autostart-v1"], undefined);
});

test("T-325: ordinary bracket-prefixed labels remain durable bytes", async () => {
  const raw = JSON.stringify({ title: "[synthetic label]", template: "{project}" });
  const settings = await capture("zaicode-header-title-v1", raw);
  assert.equal(settings["zaicode-header-title-v1"], raw);
});

for (const [name, value] of [
  ["scalar value", { selection: "sess_synthetic_scalar" }],
  ["nested array", { rows: [{ value: "sess_synthetic_array" }] }],
  ["object key", { sess_synthetic_key: true }],
  ["named identity", { sessionId: "synthetic-unprefixed-id" }],
  ["session model override", { modelOverrides: { sess_synthetic_model: { model: "synthetic" } } }],
  ["historical auto-continue", { bySession: { sess_synthetic_continue: "on" } }],
] as const) {
  test(`T-325: release capture refuses leftover session identity in ${name}`, async () => {
    const settings = await capture("zaicode-header-title-v1", JSON.stringify(value));
    assert.equal(settings["zaicode-header-title-v1"], undefined);
  });
}

test("T-325: plain scalar session identity is refused", async () => {
  const settings = await capture("zaicode-default-model", "sess_synthetic_plain");
  assert.equal(settings["zaicode-default-model"], undefined);
});

for (const raw of [
  "[]",
  "{}",
  JSON.stringify([durable]),
  JSON.stringify([{ id: "synthetic-empty-optional" }]),
]) {
  test(`T-326: even valid/empty schedule configuration stays local (${raw.length} bytes)`, async () => {
    const settings = await capture("zaicode-autostart-v1", raw);
    assert.equal(settings["zaicode-autostart-v1"], undefined);
  });
}

test("T-325: malformed structured scheduler payload is excluded", async () => {
  const settings = await capture("zaicode-autostart-v1", '{"continuationRuns":');
  assert.equal(settings["zaicode-autostart-v1"], undefined);
});

test("T-325: independent factory oracle rejects all historical session identity", () => {
  let violations = 0;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (/\bsess_[\w-]+/.test(value)) violations += 1;
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (/^sess_|^sessionIds?$|^continuationRuns$/.test(key)) violations += 1;
      walk(child);
    }
  };
  for (const value of Object.values(bundled.settings)) {
    try {
      walk(JSON.parse(value));
    } catch {
      walk(value);
    }
  }
  assert.equal(
    violations,
    0,
    "factory defaults contain historical identity/runtime records (values intentionally withheld)",
  );
});
