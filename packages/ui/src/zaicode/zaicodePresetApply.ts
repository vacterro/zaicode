import {
  base64ToBytes,
  capturePresetAssets,
  loadAssetPayloads,
  restorePresetAssets,
  rewriteSoundIds,
  sha256Hex,
  type PresetBlobStore,
  type PresetSoundSource,
} from "./zaicodePresetAssets.js";
import {
  applyPresetSettings,
  buildPresetFile,
  capturePresetSettings,
  newPresetId,
  parsePresetFile,
  presetChanges,
  presetFileName,
  type PresetAssetRef,
  type PresetValue,
  type ZaicodePreset,
  type ZaicodePresetFile,
} from "./zaicodePresetFile.js";
import { zaicodePresetSection, type ZaicodePresetSectionId } from "./zaicodePresetSections.js";

/**
 * What saving, applying, undoing, exporting and importing a preset DO (T-125), against an environment passed
 * in: storage, the places own sounds live, the way new values reach the open window. The real environment is
 * zaicodePresetEnv.ts; tests pass memory ones, so a round trip between two "machines" runs without a window.
 *
 * Applying is the one step that changes what the operator has, so it always leaves a way back: the state it
 * replaces is kept (settings and the own sounds they used, by digest) and one click restores it.
 */

/** The state an apply or a reset replaced, kept so it can be put back. */
export interface PresetUndo {
  section: ZaicodePresetSectionId;
  /** What was applied, for the button: "Undo: Night shift". */
  label: string;
  at: string;
  settings: Record<string, PresetValue>;
  assets: PresetAssetRef[];
}

export interface PresetEnv {
  read(key: string): string | null;
  write(key: string, value: string | null): void;
  sources: readonly PresetSoundSource[];
  blobs: PresetBlobStore;
  undo: { get(section: ZaicodePresetSectionId): PresetUndo | null; set(section: ZaicodePresetSectionId, undo: PresetUndo | null): void };
  /** Refreshes this section's existing stores in place; failures propagate without restarting the runtime. */
  rehydrate(section: ZaicodePresetSectionId): void;
  now(): string;
  /** "ZAICODE 0.0.1", written into exported files for the person reading them. */
  app?: string;
}

export interface ApplyOutcome {
  /** Settings keys whose value differs from what the page had. */
  changed: string[];
  /** Own sounds put in place. */
  restored: string[];
  /** Own sounds the preset names that could not be put in place: those events stay silent until a sound is picked. */
  missing: string[];
  /** The new values are on screen already. Presets never reload the renderer. */
  live: boolean;
}

function section(id: ZaicodePresetSectionId) {
  const found = zaicodePresetSection(id);
  if (!found) throw new Error(`No presets for ${id}`);
  return found;
}

/** The page as it is now, with the own sounds it uses (and any in `alsoIds`) kept by digest. */
async function snapshot(env: PresetEnv, id: ZaicodePresetSectionId, alsoIds: readonly string[] = []) {
  const settings = capturePresetSettings(section(id), env.read);
  const { refs, missing } = await capturePresetAssets(settings, env.sources, env.blobs, alsoIds);
  return { settings, assets: refs, missing };
}

/** Saves the page's current settings (and its own sounds) as a preset; not stored in any list yet. */
export async function saveCurrentPreset(env: PresetEnv, id: ZaicodePresetSectionId, name: string): Promise<{ preset: ZaicodePreset; missing: string[] }> {
  const { settings, assets, missing } = await snapshot(env, id);
  return { preset: { id: newPresetId(), section: id, name, createdAt: env.now(), settings, assets }, missing };
}

/** A preset's settings and sounds replaced by what the page holds now (the "Update" button). */
export async function refreshPreset(env: PresetEnv, preset: ZaicodePreset): Promise<{ preset: ZaicodePreset; missing: string[] }> {
  const { settings, assets, missing } = await snapshot(env, preset.section);
  return { preset: { ...preset, settings, assets }, missing };
}

async function put(
  env: PresetEnv,
  id: ZaicodePresetSectionId,
  settings: Record<string, PresetValue>,
  assets: readonly PresetAssetRef[],
  label: string,
): Promise<ApplyOutcome> {
  const target = section(id);
  // Undo has to bring back a sound the preset is about to overwrite even when the current settings do not use it:
  // the operator may have uploaded it and picked another sound since, and would pick it again from the list.
  const before = await snapshot(env, id, assets.map((asset) => asset.id));
  env.undo.set(id, { section: id, label, at: env.now(), settings: before.settings, assets: before.assets });
  const sounds = await restorePresetAssets(assets, env.sources, env.blobs);
  const followed = rewriteSoundIds(settings, sounds.renamed);
  const changed = presetChanges(target, followed, env.read);
  try {
    applyPresetSettings(target, followed, env.write, env.read);
  } catch (error) {
    // Storage refused a write (full): put the page, and the own sounds the preset replaced, back as they were
    // rather than leave it half changed.
    try {
      applyPresetSettings(target, before.settings, env.write, env.read);
    } catch {
      // Nothing more can be done; the undo record is dropped either way.
    }
    await restorePresetAssets(before.assets, env.sources, env.blobs).catch(() => undefined);
    env.undo.set(id, null);
    throw error;
  }
  // 旧的 false → reload 分支会中断 worker 和草稿；刷新只能通知现有设置所有者。
  env.rehydrate(id);
  return { changed, restored: sounds.restored, missing: sounds.missing, live: true };
}

/** Puts a preset in place. The state it replaces is kept for Undo. */
export function applyPreset(env: PresetEnv, preset: ZaicodePreset): Promise<ApplyOutcome> {
  return put(env, preset.section, preset.settings, preset.assets, preset.name);
}

/** Every setting of the page back to the release default (its keys removed). Undoable like an apply. */
export function resetSection(env: PresetEnv, id: ZaicodePresetSectionId): Promise<ApplyOutcome> {
  const blank: Record<string, PresetValue> = Object.fromEntries(section(id).keys.map((key) => [key, null]));
  return put(env, id, blank, [], "the release defaults");
}

/** Puts back what the last apply or reset replaced. Null when there is nothing to undo. */
export async function undoLastApply(env: PresetEnv, id: ZaicodePresetSectionId): Promise<ApplyOutcome | null> {
  const undo = env.undo.get(id);
  if (!undo) return null;
  const sounds = await restorePresetAssets(undo.assets, env.sources, env.blobs);
  const settings = rewriteSoundIds(undo.settings, sounds.renamed);
  const changed = presetChanges(section(id), settings, env.read);
  applyPresetSettings(section(id), settings, env.write, env.read);
  env.undo.set(id, null);
  env.rehydrate(id);
  return { changed, restored: sounds.restored, missing: sounds.missing, live: true };
}

/** What was done, in one line for the person: the sounds put in place and the ones that could not be. */
export function describeOutcome(done: string, outcome: ApplyOutcome): string {
  const parts = [`${done}${outcome.changed.length === 0 && outcome.restored.length === 0 ? " (this page already matched it)" : ""}.`];
  if (outcome.restored.length > 0) parts.push(`${outcome.restored.length} own sound${outcome.restored.length === 1 ? "" : "s"} put in place.`);
  if (outcome.missing.length > 0) {
    const names = outcome.missing.map((id) => id.replace(/^[a-z]+:/, ""));
    parts.push(`No sound file for ${names.join(", ")}: ${outcome.missing.length === 1 ? "that event stays" : "those events stay"} silent until you pick a sound.`);
  }
  return parts.join(" ");
}

/** The preset as a file's text, its own sounds inside. */
export async function exportPresetText(env: PresetEnv, preset: ZaicodePreset): Promise<{ fileName: string; text: string; missing: string[] }> {
  const { payloads, missing } = await loadAssetPayloads(preset.assets, env.blobs);
  const file = buildPresetFile(preset, payloads, env.app);
  return { fileName: presetFileName(preset.section, preset.name), text: JSON.stringify(file, null, 2), missing };
}

export interface ImportPreview {
  file: ZaicodePresetFile;
  notes: string[];
  /** Settings the preset would change on this page right now. */
  changes: number;
  sounds: { id: string; name: string; bytes: number }[];
}

/** Reads a file for the person to look at before anything is stored. */
export function previewPresetFile(env: PresetEnv, text: string): { ok: true; preview: ImportPreview } | { ok: false; error: string } {
  const read = parsePresetFile(text);
  if (!read.ok) return read;
  return {
    ok: true,
    preview: {
      file: read.file,
      notes: read.notes,
      changes: presetChanges(section(read.file.section), read.file.settings, env.read).length,
      sounds: read.file.assets.map(({ id, name, bytes }) => ({ id, name, bytes })),
    },
  };
}

/**
 * Makes a read file a local preset: its own sounds go into the blob store (a sound whose bytes do not match
 * their digest is dropped and said), and the preset keeps refs only. Not applied: adding is one step, using it
 * is another.
 */
export async function adoptPresetFile(env: PresetEnv, file: ZaicodePresetFile, name: string): Promise<{ preset: ZaicodePreset; notes: string[] }> {
  const notes: string[] = [];
  const assets: PresetAssetRef[] = [];
  for (const { data, ...ref } of file.assets) {
    const bytes = base64ToBytes(data);
    if ((await sha256Hex(bytes)) !== ref.sha256) {
      notes.push(`${ref.id}: its bytes do not match their digest (a damaged or altered file); left out`);
      continue;
    }
    await env.blobs.put(ref.sha256, bytes);
    assets.push({ ...ref, bytes: bytes.length });
  }
  return { preset: { id: newPresetId(), section: file.section, name, createdAt: file.createdAt, settings: file.settings, assets }, notes };
}
