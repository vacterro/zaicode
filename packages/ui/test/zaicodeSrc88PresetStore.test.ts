import assert from "node:assert/strict";
import test from "node:test";
import {
  ZAICODE_PRESETS_MAX_PER_SECTION,
  addZaicodePreset,
  normalizePresetUndos,
  normalizeZaicodePresets,
  presetsOfSection,
  removeZaicodePreset,
  renameZaicodePreset,
  replaceZaicodePreset,
  setZaicodePresetUndo,
  useZaicodePresets,
  usedBlobDigests,
} from "../src/zaicode/zaicodePresetStore.js";
import type { ZaicodePreset } from "../src/zaicode/zaicodePresetFile.js";

/**
 * SRC-088 (T-125): the saved list. Storage is not trusted: a list from another version, cut short or edited by
 * hand is read row by row, and a row that is not a preset of a known page never reaches the page.
 */

const digest = "a".repeat(64);

const good = (patch: Record<string, unknown> = {}) => ({
  id: "preset-1",
  section: "zaicodeSounds",
  name: "Night shift",
  createdAt: "2026-09-29T12:00:00.000Z",
  settings: { "zaicode-sound-events-v1": { masterVolume: 30 }, "zaicode-audio-v1": null },
  assets: [{ id: "custom:sidebar.project", kind: "sound", name: "neigh.wav", mime: "audio/wav", bytes: 6, sha256: digest }],
  ...patch,
});

function fresh() {
  useZaicodePresets.setState({ presets: [], undos: {} });
}

const preset = (id: string, section: ZaicodePreset["section"], name: string): ZaicodePreset => ({
  id,
  section,
  name,
  createdAt: "2026-09-29T12:00:00.000Z",
  settings: { "zaicode-palette": "blue" },
  assets: [],
});

test("S1 a good row is read as it is; anything that is not a list, or not a row of a known page, is dropped", () => {
  assert.deepEqual(normalizeZaicodePresets(null), []);
  assert.deepEqual(normalizeZaicodePresets({ presets: [] }), []);
  const rows = normalizeZaicodePresets([good(), 5, null, "x", good({ id: "" }), good({ id: "preset-1" }), good({ id: "p2", section: "zaicodeRouter" }), good({ id: "p3", settings: {} }), good({ id: "p4", settings: { "zaicode-profiles": "x" } })]);
  assert.deepEqual(rows.map((row) => row.id), ["preset-1"], "one good row, once; the router has no presets; a row with nothing of its page's keys is no preset");
  assert.equal(rows[0]!.assets.length, 1);
});

test("S2 a row is cleaned: foreign keys and local facts removed, names cleaned, sounds without a real digest dropped", () => {
  const [row] = normalizeZaicodePresets([
    good({
      name: "  Night\u0007 shift ",
      createdAt: "yesterday",
      settings: { "zaicode-audio-v1": { ambience: { enabled: true }, problip: { running: true, interval: "PULSE" }, problipDays: { "2026-09-29": 5 } }, "zaicode-palette": "x" },
      assets: [
        { id: "custom:a", kind: "sound", name: "a.wav", mime: "audio/wav", bytes: 1, sha256: "nope" },
        { id: "customization:../evil.wav", kind: "sound", name: "e.wav", mime: "audio/wav", bytes: 1, sha256: digest },
        { id: "custom:b", kind: "sound", name: "b.wav", mime: "text/html", bytes: -4, sha256: digest },
        { id: "custom:b", kind: "sound", name: "again.wav", mime: "audio/wav", bytes: 2, sha256: digest },
      ],
    }),
  ]);
  assert.equal(row!.name, "Night shift");
  assert.equal(row!.createdAt, new Date(0).toISOString());
  assert.deepEqual(row!.settings, { "zaicode-audio-v1": { ambience: { enabled: true }, problip: { interval: "PULSE" } } });
  assert.deepEqual(row!.assets.map((asset) => [asset.id, asset.mime, asset.bytes]), [["custom:b", "audio/wav", 0]], "the traversal, the bad digest and the duplicate are gone; a wrong type falls back to audio");
});

test("S3 a page keeps at most N presets", () => {
  const rows = Array.from({ length: ZAICODE_PRESETS_MAX_PER_SECTION + 5 }, (_, index) => good({ id: `s${index}` }));
  const other = good({ id: "c1", section: "zaicodeColors", settings: { "zaicode-palette": "blue" }, assets: [] });
  const list = normalizeZaicodePresets([...rows, other]);
  assert.equal(presetsOfSection(list, "zaicodeSounds").length, ZAICODE_PRESETS_MAX_PER_SECTION);
  assert.equal(presetsOfSection(list, "zaicodeColors").length, 1, "another page has its own room");
});

test("S4 the undo records of storage are read the same way, and the sounds they and the presets need are known", () => {
  const undos = normalizePresetUndos({
    zaicodeSounds: { label: "Night shift", at: "2026-09-29T12:00:00.000Z", settings: { "zaicode-audio-v1": null }, assets: [{ id: "custom:x", kind: "sound", name: "x.wav", mime: "audio/wav", bytes: 3, sha256: "b".repeat(64) }] },
    zaicodeRouter: { label: "x", settings: { a: 1 }, assets: [] },
    zaicodeColors: { label: "x", settings: {}, assets: [] },
  });
  assert.deepEqual(Object.keys(undos), ["zaicodeSounds"]);
  assert.equal(undos.zaicodeSounds!.label, "Night shift");
  const used = usedBlobDigests(normalizeZaicodePresets([good()]), undos);
  assert.deepEqual([...used].sort(), [digest, "b".repeat(64)].sort());
  assert.deepEqual(normalizePresetUndos("nope"), {});
});

test("S5 adding gives a name not used on that page yet; another page may reuse it; a full page refuses", () => {
  fresh();
  const first = addZaicodePreset(preset("a", "zaicodeColors", "Amber"));
  const second = addZaicodePreset(preset("b", "zaicodeColors", "Amber"));
  const other = addZaicodePreset(preset("c", "zaicodeTimers", "Amber"));
  assert.equal(first!.preset.name, "Amber");
  assert.equal(second!.preset.name, "Amber 2");
  assert.equal(other!.preset.name, "Amber", "names are per page");
  for (let index = 0; index < ZAICODE_PRESETS_MAX_PER_SECTION; index += 1) addZaicodePreset(preset(`x${index}`, "zaicodeSidebar", `S${index}`));
  assert.equal(addZaicodePreset(preset("late", "zaicodeSidebar", "Late")), null, "a full page says so instead of dropping the oldest");
  assert.equal(presetsOfSection(useZaicodePresets.getState().presets, "zaicodeSidebar").length, ZAICODE_PRESETS_MAX_PER_SECTION);
});

test("S6 replace keeps name and place, rename stays unique, remove removes", () => {
  fresh();
  addZaicodePreset(preset("a", "zaicodeColors", "Amber"));
  addZaicodePreset(preset("b", "zaicodeColors", "Blue"));
  assert.notEqual(replaceZaicodePreset({ ...preset("a", "zaicodeColors", "ignored"), name: "Amber", settings: { "zaicode-palette": "red" } }), null);
  assert.equal(replaceZaicodePreset(preset("nope", "zaicodeColors", "x")), null);
  renameZaicodePreset("b", "Amber");
  const list = presetsOfSection(useZaicodePresets.getState().presets, "zaicodeColors");
  assert.deepEqual(list.map((entry) => [entry.id, entry.name]), [["a", "Amber"], ["b", "Amber 2"]]);
  assert.equal(list[0]!.settings["zaicode-palette"], "red");
  removeZaicodePreset("a");
  assert.deepEqual(useZaicodePresets.getState().presets.map((entry) => entry.id), ["b"]);
});

test("S7 the undo record of a page is set and cleared without touching the others", () => {
  fresh();
  const record = { section: "zaicodeColors" as const, label: "Amber", at: "2026-09-29T12:00:00.000Z", settings: { "zaicode-palette": "blue" }, assets: [] };
  setZaicodePresetUndo("zaicodeColors", record);
  setZaicodePresetUndo("zaicodeTimers", { ...record, section: "zaicodeTimers" as const, settings: { "zaicode-timer-prefs-v1": null } });
  setZaicodePresetUndo("zaicodeColors", null);
  assert.deepEqual(Object.keys(useZaicodePresets.getState().undos), ["zaicodeTimers"]);
});
