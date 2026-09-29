import { storeZaicodeOwnSound, readZaicodeOwnSound, reloadZaicodeSoundSettings } from "./zaicodeSoundEvents.js";
import { reloadZaicodeAudio } from "./zaicodeAudio.js";
import { reloadZaicodeSoundPickerPrefs } from "./ZaicodeSoundPicker.js";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { pruneUnusedBlobs, toArrayBuffer, type PresetSoundSource } from "./zaicodePresetAssets.js";
import type { PresetEnv } from "./zaicodePresetApply.js";
import { zaicodePresetBlobStore } from "./zaicodePresetBlobs.js";
import { setZaicodePresetUndo, usedBlobDigests, useZaicodePresets } from "./zaicodePresetStore.js";
import { markPresetReopen } from "./zaicodePresetReopen.js";

/**
 * The real environment of the preset system (T-125): this window's storage, its own sounds, the way new
 * values reach what is open. zaicodePresetApply.ts does the work against it; tests pass memory ones.
 *
 * Where a page cannot take new values while it is open (nearly every store reads storage once at start, like
 * a profile switch), the window reloads and comes back to the same Settings page, saying what was done.
 */

/** Own files of the Sounds table: `custom:<event id>`, in IndexedDB, one per event. */
export const zaicodeOwnSoundSource: PresetSoundSource = {
  handles: (id) => id.startsWith("custom:"),
  read: readZaicodeOwnSound,
  write: async (id, sound) => {
    const existing = await readZaicodeOwnSound(id).catch(() => null);
    // The same bytes are already there: nothing to overwrite and nothing to invalidate.
    if (existing && existing.bytes.length === sound.bytes.length && existing.bytes.every((byte, index) => byte === sound.bytes[index])) return id;
    await storeZaicodeOwnSound(id.slice("custom:".length), new Blob([toArrayBuffer(sound.bytes)], { type: sound.mime }), sound.name);
    return id;
  },
};

function writeSetting(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

export const zaicodePresetEnv: PresetEnv = {
  read: readZaicodeSetting,
  // A refused write throws: the apply then puts everything back instead of leaving a page half changed.
  write: writeSetting,
  sources: [zaicodeOwnSoundSource],
  blobs: zaicodePresetBlobStore,
  undo: {
    get: (section) => useZaicodePresets.getState().undos[section] ?? null,
    set: (section, undo) => void setZaicodePresetUndo(section, undo),
  },
  rehydrate: (section) => {
    // The Sounds page is the one that can show new values without a reload: three small stores, one event each.
    if (section !== "zaicodeSounds") return false;
    reloadZaicodeSoundSettings();
    reloadZaicodeAudio();
    reloadZaicodeSoundPickerPrefs();
    return true;
  },
  reload: (section, note) => {
    try {
      markPresetReopen(sessionStorage, { section, note });
    } catch {
      // Without the mark the window still reloads; the person opens the page again.
    }
    window.location.reload();
  },
  now: () => new Date().toISOString(),
  app: "ZAICODE",
};

/** Deletes the sounds no saved preset and no Undo record needs (after a delete, an update, an undo). Best effort. */
export async function pruneZaicodePresetBlobs(): Promise<void> {
  const { presets, undos } = useZaicodePresets.getState();
  await pruneUnusedBlobs(zaicodePresetBlobStore, usedBlobDigests(presets, undos)).catch(() => 0);
}
