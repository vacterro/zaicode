import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptPresetFile,
  applyPreset,
  describeOutcome,
  exportPresetText,
  previewPresetFile,
  refreshPreset,
  resetSection,
  saveCurrentPreset,
  undoLastApply,
  type PresetEnv,
  type PresetUndo,
} from "../src/zaicode/zaicodePresetApply.js";
import { memoryBlobStore, pruneUnusedBlobs, sha256Hex, type OwnSound, type PresetSoundSource } from "../src/zaicode/zaicodePresetAssets.js";
import type { ZaicodePresetSectionId } from "../src/zaicode/zaicodePresetSections.js";

/**
 * SRC-088 (T-125): presets, export, import, and "if a user added custom sounds, account for that smartly".
 * These run the real save / apply / undo / export / import against two in-memory "machines": what one saves,
 * the other can read, apply and undo, own sounds included, and a share never plays a different sound silently.
 */

const bytes = (...values: number[]) => new Uint8Array(values);
const neigh: OwnSound = { bytes: bytes(1, 2, 3, 4, 5, 6), name: "neigh.wav", mime: "audio/wav" };
const bark: OwnSound = { bytes: bytes(9, 9, 9), name: "bark.wav", mime: "audio/wav" };

function machine(sounds: Record<string, OwnSound> = {}, options: { live?: ZaicodePresetSectionId[]; rename?: boolean } = {}) {
  const storage = new Map<string, string>();
  const undos = new Map<ZaicodePresetSectionId, PresetUndo>();
  const reloads: string[] = [];
  const notes: string[] = [];
  const rehydrated: string[] = [];
  const source: PresetSoundSource = {
    handles: (id) => id.startsWith("custom:"),
    read: async (id) => sounds[id] ?? null,
    write: async (id, sound) => {
      // A source that never overwrites a different file of the same name (the customization folder does).
      if (options.rename && sounds[id] && sounds[id]!.bytes.join() !== sound.bytes.join()) {
        const other = `${id}-2`;
        sounds[other] = sound;
        return other;
      }
      sounds[id] = sound;
      return id;
    },
  };
  const env: PresetEnv & { reload: (id: ZaicodePresetSectionId, note: string) => void } = {
    read: (key) => storage.get(key) ?? null,
    write: (key, value) => void (value === null ? storage.delete(key) : storage.set(key, value)),
    sources: [source],
    blobs: memoryBlobStore(),
    undo: { get: (id) => undos.get(id) ?? null, set: (id, undo) => void (undo ? undos.set(id, undo) : undos.delete(id)) },
    rehydrate: (id) => {
      rehydrated.push(id);
      return (options.live ?? ["zaicodeSounds"]).includes(id);
    },
    reload: (id, note) => {
      reloads.push(id);
      notes.push(note);
    },
    now: () => "2026-09-29T12:00:00.000Z",
    app: "ZAICODE test",
  };
  return { env, storage, sounds, undos, reloads, notes, rehydrated };
}

const eventsWithOwnSound = JSON.stringify({
  masterVolume: 35,
  events: { "sidebar.project": { enabled: true, sound: "custom:sidebar.project", soundMode: "single", pool: [] } },
});

test("A1 saving takes the page's settings and keeps its own sound by digest, once", async () => {
  const a = machine({ "custom:sidebar.project": neigh });
  a.storage.set("zaicode-sound-events-v1", eventsWithOwnSound);
  const { preset, missing } = await saveCurrentPreset(a.env, "zaicodeSounds", "Night shift");
  assert.deepEqual(missing, []);
  assert.equal(preset.section, "zaicodeSounds");
  assert.equal(preset.assets.length, 1);
  assert.equal(preset.assets[0]!.sha256, await sha256Hex(neigh.bytes));
  assert.equal(preset.assets[0]!.bytes, 6);
  assert.equal(preset.assets[0]!.name, "neigh.wav");
  assert.equal((a.env.blobs as ReturnType<typeof memoryBlobStore>).size(), 1);
  assert.equal(preset.settings["zaicode-audio-v1"], null, "an unset key is saved as unset");
});

test("A2 a preset shared through a file plays the same on another machine, own sound included", async () => {
  const a = machine({ "custom:sidebar.project": neigh });
  a.storage.set("zaicode-sound-events-v1", eventsWithOwnSound);
  const saved = (await saveCurrentPreset(a.env, "zaicodeSounds", "Night shift")).preset;
  const { text, fileName, missing } = await exportPresetText(a.env, saved);
  assert.deepEqual(missing, []);
  assert.equal(fileName, "zaicode-preset-sounds-Night-shift.json");

  const b = machine(); // no own sound here, no settings
  const preview = previewPresetFile(b.env, text);
  assert.ok(preview.ok);
  if (!preview.ok) return;
  assert.equal(preview.preview.file.name, "Night shift");
  assert.deepEqual(preview.preview.sounds.map((sound) => sound.name), ["neigh.wav"]);
  assert.ok(preview.preview.changes >= 1, "the preview says how many settings it would change");
  assert.equal(b.storage.size, 0, "a preview stores nothing");
  assert.equal(b.sounds["custom:sidebar.project"], undefined);

  const adopted = await adoptPresetFile(b.env, preview.preview.file, "Night shift");
  assert.deepEqual(adopted.notes, []);
  assert.equal(b.storage.size, 0, "adding a preset to the list does not apply it");

  const outcome = await applyPreset(b.env, adopted.preset);
  assert.deepEqual(outcome.missing, []);
  assert.deepEqual(outcome.restored, ["custom:sidebar.project"]);
  assert.deepEqual([...b.sounds["custom:sidebar.project"]!.bytes], [...neigh.bytes], "the very bytes arrived");
  assert.deepEqual(JSON.parse(b.storage.get("zaicode-sound-events-v1")!), JSON.parse(eventsWithOwnSound));
  assert.equal(outcome.live, true);
  assert.deepEqual(b.reloads, [], "Sounds is put in front of the open window: no reload");
});

test("A3 a refresh return value never authorizes a renderer reload after settings are written", async () => {
  const a = machine();
  a.storage.set("zaicode-palette", "gray-amber");
  const { preset } = await saveCurrentPreset(a.env, "zaicodeColors", "Amber");
  a.storage.set("zaicode-palette", "blue");
  const outcome = await applyPreset(a.env, preset);
  assert.equal(a.storage.get("zaicode-palette"), "gray-amber");
  assert.equal(outcome.live, true);
  assert.deepEqual(a.rehydrated, ["zaicodeColors"]);
  assert.deepEqual(a.reloads, []);
  assert.deepEqual(a.notes, []);
});

test("A4 Undo puts back the settings AND the own sound that an apply replaced", async () => {
  const a = machine({ "custom:sidebar.project": neigh });
  a.storage.set("zaicode-sound-events-v1", eventsWithOwnSound);
  const mine = (await saveCurrentPreset(a.env, "zaicodeSounds", "Mine")).preset;
  const b = machine({ "custom:sidebar.project": bark });
  b.storage.set("zaicode-sound-events-v1", JSON.stringify({ masterVolume: 90, events: {} }));
  // A's preset arrives at B (through the blob store the file import fills).
  const shared = await adoptPresetFile(b.env, previewOk(b.env, (await exportPresetText(a.env, mine)).text), "Mine");
  await applyPreset(b.env, shared.preset);
  assert.deepEqual([...b.sounds["custom:sidebar.project"]!.bytes], [...neigh.bytes], "B now plays A's sound");
  assert.equal(JSON.parse(b.storage.get("zaicode-sound-events-v1")!).masterVolume, 35);
  const undone = await undoLastApply(b.env, "zaicodeSounds");
  assert.ok(undone);
  assert.deepEqual([...b.sounds["custom:sidebar.project"]!.bytes], [...bark.bytes], "B's own sound is back");
  assert.equal(JSON.parse(b.storage.get("zaicode-sound-events-v1")!).masterVolume, 90);
  assert.equal(await undoLastApply(b.env, "zaicodeSounds"), null, "one step back, then nothing to undo");
});

function previewOk(env: PresetEnv, text: string) {
  const preview = previewPresetFile(env, text);
  assert.ok(preview.ok);
  return preview.ok ? preview.preview.file : (undefined as never);
}

test("A5 a sound the preset names but whose bytes are gone is REPORTED, never replaced by another", async () => {
  const a = machine();
  a.storage.set("zaicode-sound-events-v1", eventsWithOwnSound); // names an own sound this machine does not have
  const { preset, missing } = await saveCurrentPreset(a.env, "zaicodeSounds", "Broken");
  assert.deepEqual(missing, ["custom:sidebar.project"], "saving says which own sound it could not keep");
  assert.deepEqual(preset.assets, []);
  const outcome = await applyPreset(machine().env, { ...preset, assets: [{ id: "custom:sidebar.project", kind: "sound", name: "x.wav", mime: "audio/wav", bytes: 3, sha256: "b".repeat(64) }] });
  assert.deepEqual(outcome.missing, ["custom:sidebar.project"], "applying says it too, so the event is known to be silent");
  assert.deepEqual(outcome.restored, []);
});

test("A6 a source that will not overwrite a different file puts the sound under another id, and the settings follow", async () => {
  const a = machine({ "custom:sidebar.project": neigh });
  a.storage.set("zaicode-sound-events-v1", eventsWithOwnSound);
  const { preset } = await saveCurrentPreset(a.env, "zaicodeSounds", "Shared");
  const b = machine({ "custom:sidebar.project": bark }, { rename: true });
  await a.env.blobs.get(preset.assets[0]!.sha256).then((blob) => b.env.blobs.put(preset.assets[0]!.sha256, blob!));
  const outcome = await applyPreset(b.env, preset);
  assert.deepEqual([...b.sounds["custom:sidebar.project"]!.bytes], [...bark.bytes], "B's own file was not overwritten");
  assert.deepEqual([...b.sounds["custom:sidebar.project-2"]!.bytes], [...neigh.bytes]);
  assert.match(b.storage.get("zaicode-sound-events-v1")!, /custom:sidebar\.project-2/);
  assert.deepEqual(outcome.restored, ["custom:sidebar.project"]);
});

test("A7 a damaged or altered file cannot bring a sound in: the bytes must match their digest", async () => {
  const a = machine({ "custom:sidebar.project": neigh });
  a.storage.set("zaicode-sound-events-v1", eventsWithOwnSound);
  const { preset } = await saveCurrentPreset(a.env, "zaicodeSounds", "Shared");
  const file = JSON.parse((await exportPresetText(a.env, preset)).text);
  file.assets[0].data = "AAAAAAAA"; // other bytes, same claimed digest and size
  const b = machine();
  const preview = previewPresetFile(b.env, JSON.stringify(file));
  assert.ok(preview.ok);
  if (!preview.ok) return;
  const adopted = await adoptPresetFile(b.env, preview.preview.file, "Shared");
  assert.deepEqual(adopted.preset.assets, []);
  assert.match(adopted.notes.join("\n"), /do not match their digest/);
  assert.equal((b.env.blobs as ReturnType<typeof memoryBlobStore>).size(), 0);
});

test("A8 Reset is an apply of the defaults: every key of the page removed, undoable", async () => {
  const a = machine();
  a.storage.set("zaicode-palette", "gray-amber");
  a.storage.set("zaicode-crisp", "1");
  a.storage.set("zaicode-sound-events-v1", "{}");
  const outcome = await resetSection(a.env, "zaicodeColors");
  assert.equal(a.storage.has("zaicode-palette"), false);
  assert.equal(a.storage.has("zaicode-crisp"), false);
  assert.equal(a.storage.get("zaicode-sound-events-v1"), "{}", "another page is untouched");
  assert.deepEqual(outcome.changed.sort(), ["zaicode-crisp", "zaicode-palette"]);
  assert.equal(a.undos.get("zaicodeColors")?.label, "the release defaults");
  await undoLastApply(a.env, "zaicodeColors");
  assert.equal(a.storage.get("zaicode-palette"), "gray-amber");
  assert.equal(a.storage.get("zaicode-crisp"), "1");
});

test("A9 Update replaces a preset with what the page holds now, keeping its name and id", async () => {
  const a = machine();
  a.storage.set("zaicode-palette", "gray-amber");
  const { preset } = await saveCurrentPreset(a.env, "zaicodeColors", "Amber");
  a.storage.set("zaicode-palette", "blue");
  const { preset: updated } = await refreshPreset(a.env, preset);
  assert.equal(updated.id, preset.id);
  assert.equal(updated.name, "Amber");
  assert.equal(updated.settings["zaicode-palette"], "blue");
});

test("A10 a write that storage refuses leaves the page as it was, with no undo to offer, and the error is raised", async () => {
  const a = machine();
  a.storage.set("zaicode-palette", "gray-amber");
  a.storage.set("zaicode-crisp", "1");
  const { preset } = await saveCurrentPreset(a.env, "zaicodeColors", "Amber");
  a.storage.set("zaicode-palette", "blue");
  a.storage.set("zaicode-crisp", "0");
  let writes = 0;
  const env: PresetEnv = {
    ...a.env,
    write: (key, value) => {
      writes += 1;
      if (writes === 2) throw new Error("QuotaExceededError");
      a.env.write(key, value);
    },
  };
  await assert.rejects(() => applyPreset(env, preset), /QuotaExceededError/);
  assert.equal(a.storage.get("zaicode-palette"), "blue", "the first key was written, then put back");
  assert.equal(a.storage.get("zaicode-crisp"), "0");
  assert.equal(a.undos.size, 0, "nothing changed, so there is nothing to undo");
  assert.deepEqual(a.reloads, [], "no reload for an apply that did not happen");
});

test("A11 a refused write also puts back the own sound the preset had replaced", async () => {
  const a = machine({ "custom:sidebar.project": neigh });
  a.storage.set("zaicode-sound-events-v1", eventsWithOwnSound);
  const preset = (await saveCurrentPreset(a.env, "zaicodeSounds", "Shared")).preset;
  const b = machine({ "custom:sidebar.project": bark });
  b.storage.set("zaicode-sound-events-v1", JSON.stringify({ masterVolume: 90, events: {} }));
  await b.env.blobs.put(preset.assets[0]!.sha256, neigh.bytes);
  const env: PresetEnv = {
    ...b.env,
    write: () => {
      throw new Error("QuotaExceededError");
    },
  };
  await assert.rejects(() => applyPreset(env, preset), /QuotaExceededError/);
  assert.deepEqual([...b.sounds["custom:sidebar.project"]!.bytes], [...bark.bytes], "B's own sound was written over, then put back");
  assert.equal(JSON.parse(b.storage.get("zaicode-sound-events-v1")!).masterVolume, 90);
  assert.equal(b.undos.size, 0);
});

test("A12 blobs nothing refers to any more are pruned, the ones a preset or an undo needs stay", async () => {
  const blobs = memoryBlobStore();
  await blobs.put("a", bytes(1));
  await blobs.put("b", bytes(2));
  await blobs.put("c", bytes(3));
  assert.equal(await pruneUnusedBlobs(blobs, new Set(["b"])), 2);
  assert.deepEqual(await blobs.keys(), ["b"]);
  assert.equal(await pruneUnusedBlobs(blobs, new Set(["b"])), 0);
});

test("A13 the outcome line says what was done, what was put in place and what stays silent", () => {
  assert.equal(describeOutcome("Applied “X”", { changed: ["k"], restored: [], missing: [], live: true }), "Applied “X”.");
  assert.equal(describeOutcome("Applied “X”", { changed: [], restored: [], missing: [], live: true }), "Applied “X” (this page already matched it).");
  assert.equal(
    describeOutcome("Applied “X”", { changed: ["k"], restored: ["custom:a"], missing: ["custom:sidebar.project", "customization:x/y.wav"], live: true }),
    "Applied “X”. 1 own sound put in place. No sound file for sidebar.project, x/y.wav: those events stay silent until you pick a sound.",
  );
});
