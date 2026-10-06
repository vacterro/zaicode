// T-229 deep audit (F6) — the Save All IPC boundary.
//
// The writer takes an arbitrary JSON string from the renderer and writes it into the
// shipped defaults file, so the shape the reader consumes has to be enforced before
// anything lands on disk. These tests exercise the decision directly (behaviour, not
// the writer's source text); one wiring check follows it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ZAICODE_SNAPSHOT_MAX_CUE_AUDIO_KEYS,
  ZAICODE_SNAPSHOT_MAX_SETTINGS_KEYS,
  validateZaicodeSettingsSnapshotShape,
} from "../src/main/zaicodeSettingsSnapshotShape.js";

/** Exactly what captureZaicodeSettingsSnapshot() builds, and what the settings UI sends. */
const valid = () => ({
  version: 1,
  settings: {
    "zaicode-ui-prefs-v1": JSON.stringify({ noMotion: true }),
    "zaicode-protrail-v1": JSON.stringify({ click: { holdWakeEnabled: false } }),
  },
  cueAudio: { "custom:agent.done": "data:audio/wav;base64,AAAA" },
});

test("F6: a real snapshot passes the shape gate", () => {
  assert.deepEqual(validateZaicodeSettingsSnapshotShape(valid()), { ok: true });
  // cueAudio is optional: a release with no custom sounds is still a snapshot.
  const withoutCues = valid();
  delete (withoutCues as { cueAudio?: unknown }).cueAudio;
  assert.deepEqual(validateZaicodeSettingsSnapshotShape(withoutCues), { ok: true });
  // An empty settings map is legal (a fresh profile that saved nothing yet).
  assert.deepEqual(validateZaicodeSettingsSnapshotShape({ version: 1, settings: {} }), { ok: true });
});

test("F6: arbitrary content the reader could never consume is refused", () => {
  const cases: [string, unknown][] = [
    ["not an object", "{}"],
    ["an array", [1, 2, 3]],
    ["null", null],
    ["a wrong schema version", { version: 2, settings: {} }],
    ["a missing version", { settings: {} }],
    ["missing settings", { version: 1, cueAudio: {} }],
    ["settings as an array", { version: 1, settings: [] }],
    ["a key outside the namespace", { version: 1, settings: { evil: "x" } }],
    // JSON.parse really creates an own `__proto__` key; an object literal would not.
    ["a key that would shadow a browser global", JSON.parse('{"version":1,"settings":{"__proto__":"x"}}')],
    ["a non-string value", { version: 1, settings: { "zaicode-palette": 42 } }],
    ["a nested object where a string belongs", { version: 1, settings: { "zaicode-palette": { a: 1 } } }],
    ["cueAudio as a number", { version: 1, settings: {}, cueAudio: 7 }],
    ["a non-string cue value", { version: 1, settings: {}, cueAudio: { done: 3 } }],
    ["an empty cue key", { version: 1, settings: {}, cueAudio: { "": "data:audio/wav;base64,AA" } }],
  ];
  for (const [label, payload] of cases) {
    const result = validateZaicodeSettingsSnapshotShape(payload);
    assert.equal(result.ok, false, `${label} must be refused`);
    assert.ok(!result.ok && result.reason.length > 0, `${label} must name a reason`);
  }
});

test("F6: the bounds that keep a runaway renderer out of the shipped file", () => {
  const many = (count: number, pattern: (index: number) => string) =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [pattern(index), "x"]));
  assert.equal(
    validateZaicodeSettingsSnapshotShape({
      version: 1,
      settings: many(ZAICODE_SNAPSHOT_MAX_SETTINGS_KEYS, (index) => `zaicode-key-${index}`),
    }).ok,
    true,
    "at the cap is still a snapshot",
  );
  const overSettings = validateZaicodeSettingsSnapshotShape({
    version: 1,
    settings: many(ZAICODE_SNAPSHOT_MAX_SETTINGS_KEYS + 1, (index) => `zaicode-key-${index}`),
  });
  assert.equal(overSettings.ok, false);
  const overCues = validateZaicodeSettingsSnapshotShape({
    version: 1,
    settings: {},
    cueAudio: many(ZAICODE_SNAPSHOT_MAX_CUE_AUDIO_KEYS + 1, (index) => `cue-${index}`),
  });
  assert.equal(overCues.ok, false);
  const longKey = validateZaicodeSettingsSnapshotShape({
    version: 1,
    settings: { [`zaicode-${"a".repeat(400)}`]: "x" },
  });
  assert.equal(longKey.ok, false, "an unusable key is refused on length, not on the regex alone");
});

test("F6 wiring: the writer consults the gate before it touches disk", () => {
  const writer = readFileSync(join(import.meta.dirname, "../src/main/zaicodeSettingsSnapshot.ts"), "utf8");
  assert.match(writer, /validateZaicodeSettingsSnapshotShape\(parsed\)/);
  const gateAt = writer.indexOf("validateZaicodeSettingsSnapshotShape(parsed)");
  const buildAt = writer.indexOf("const content =");
  assert.ok(gateAt > 0 && buildAt > gateAt, "the gate runs before the snapshot is serialized");
  assert.doesNotMatch(writer, /if \(!parsed \|\| typeof parsed !== "object"\)/, "the old object-only check is gone");
});
