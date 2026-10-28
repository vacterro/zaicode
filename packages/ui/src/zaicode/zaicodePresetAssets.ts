import {
  isPresetAssetSoundId,
  presetSoundIds,
  type PresetAssetPayload,
  type PresetAssetRef,
  type PresetValue,
  ZAICODE_PRESET_ASSET_MAX_BYTES,
} from "./zaicodePresetFile.js";

/**
 * The own sounds a preset carries (T-125).
 *
 * Settings only NAME a sound (`custom:sidebar.project`); the file lives elsewhere -- an IndexedDB store of the
 * window, or the customization folder on disk. So a preset that uses one has to bring the bytes, or a share
 * would play a different sound or none. Two rules make that safe and cheap:
 *
 * - content addressing: a sound is kept once per sha256 in a small blob store, whatever number of presets uses
 *   it, and its digest travels with the preset, so an import says exactly what is missing or altered;
 * - sources: each kind of sound id has one source that reads and writes it (this module knows none of them),
 *   and a source may put a sound under another id (the customization folder never overwrites a different file
 *   of the same name), which the caller then rewrites in the settings.
 */

/** Bytes of one own sound and what to call it. */
export interface OwnSound {
  bytes: Uint8Array;
  name: string;
  mime: string;
}

export interface PresetSoundSource {
  handles(id: string): boolean;
  /** null = this installation does not have that sound. */
  read(id: string): Promise<OwnSound | null>;
  /** Puts the sound in place; answers the id the settings must use from now on (usually the same), null when it could not. */
  write(id: string, sound: OwnSound): Promise<string | null>;
}

/** A place where sounds live by digest. */
export interface PresetBlobStore {
  get(sha256: string): Promise<Uint8Array | null>;
  put(sha256: string, bytes: Uint8Array): Promise<void>;
  keys(): Promise<string[]>;
  remove(sha256: string): Promise<void>;
}

export function memoryBlobStore(): PresetBlobStore & { size(): number } {
  const blobs = new Map<string, Uint8Array>();
  return {
    get: async (sha256) => blobs.get(sha256) ?? null,
    put: async (sha256, bytes) => void blobs.set(sha256, bytes),
    keys: async () => [...blobs.keys()],
    remove: async (sha256) => void blobs.delete(sha256),
    size: () => blobs.size,
  };
}

/** Deletes every blob that no preset and no undo record refers to; answers how many went. */
export async function pruneUnusedBlobs(blobs: PresetBlobStore, used: ReadonlySet<string>): Promise<number> {
  let removed = 0;
  for (const sha256 of await blobs.keys()) {
    if (used.has(sha256)) continue;
    await blobs.remove(sha256);
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------- bytes

/** The bytes as a standalone ArrayBuffer (a view may sit in the middle of a bigger one). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  // Chunks keep String.fromCharCode inside the engine's argument limit for a 25 MB file.
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

export function base64ToBytes(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

const MIME_BY_EXTENSION: Record<string, string> = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg" };

export function soundMime(name: string, fallback = "audio/wav"): string {
  return MIME_BY_EXTENSION[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""] ?? fallback;
}

// ---------------------------------------------------------------- capture and restore

export interface CapturedAssets {
  refs: PresetAssetRef[];
  /** Sounds the settings name that this installation does not have. */
  missing: string[];
}

/**
 * Reads every own sound the settings name, keeps its bytes by digest and answers the refs a preset stores.
 * `alsoIds` are sounds to keep even though the settings do not name them (an apply is about to overwrite them):
 * the ones this installation does not have are not "missing", there is just nothing to keep.
 */
export async function capturePresetAssets(
  settings: Record<string, PresetValue>,
  sources: readonly PresetSoundSource[],
  blobs: PresetBlobStore,
  alsoIds: readonly string[] = [],
): Promise<CapturedAssets> {
  const refs: PresetAssetRef[] = [];
  const missing: string[] = [];
  const named = presetSoundIds(settings);
  const extra = alsoIds.filter((id) => !named.includes(id) && isPresetAssetSoundId(id));
  for (const id of [...named, ...extra]) {
    const source = sources.find((candidate) => candidate.handles(id));
    const sound = source ? await source.read(id).catch(() => null) : null;
    if (!sound || sound.bytes.length === 0 || sound.bytes.length > ZAICODE_PRESET_ASSET_MAX_BYTES) {
      if (named.includes(id)) missing.push(id);
      continue;
    }
    const sha256 = await sha256Hex(sound.bytes);
    await blobs.put(sha256, sound.bytes);
    refs.push({ id, kind: "sound", name: sound.name, mime: sound.mime, bytes: sound.bytes.length, sha256 });
  }
  return { refs, missing };
}

export interface RestoredAssets {
  /** Sounds put in place. */
  restored: string[];
  /** Sounds the preset names whose bytes are not in the store (an old preset, cleared site data). */
  missing: string[];
  /** Sounds a source put under another id: the settings have to follow. */
  renamed: Record<string, string>;
}

/** Puts a preset's own sounds where the app finds them; nothing is silently replaced by something else. */
export async function restorePresetAssets(
  refs: readonly PresetAssetRef[],
  sources: readonly PresetSoundSource[],
  blobs: PresetBlobStore,
): Promise<RestoredAssets> {
  const result: RestoredAssets = { restored: [], missing: [], renamed: {} };
  for (const ref of refs) {
    const source = sources.find((candidate) => candidate.handles(ref.id));
    const bytes = await blobs.get(ref.sha256);
    if (!source || !bytes) {
      result.missing.push(ref.id);
      continue;
    }
    // A store that answers bytes of another digest is as good as empty: the settings would name a wrong sound.
    if ((await sha256Hex(bytes)) !== ref.sha256) {
      result.missing.push(ref.id);
      continue;
    }
    const id = await source.write(ref.id, { bytes, name: ref.name, mime: ref.mime }).catch(() => null);
    if (!id) {
      result.missing.push(ref.id);
      continue;
    }
    result.restored.push(ref.id);
    if (id !== ref.id) result.renamed[ref.id] = id;
  }
  return result;
}

/** The settings with sound ids replaced (a source put a sound under another name). */
export function rewriteSoundIds(settings: Record<string, PresetValue>, renamed: Record<string, string>): Record<string, PresetValue> {
  if (Object.keys(renamed).length === 0) return settings;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return isPresetAssetSoundId(value) && renamed[value] ? renamed[value] : value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, walk(value) as PresetValue]));
}

/** The refs and their bytes as a file carries them. */
export async function loadAssetPayloads(refs: readonly PresetAssetRef[], blobs: PresetBlobStore): Promise<{ payloads: PresetAssetPayload[]; missing: string[] }> {
  const payloads: PresetAssetPayload[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const bytes = await blobs.get(ref.sha256);
    if (!bytes) missing.push(ref.id);
    else payloads.push({ ...ref, data: bytesToBase64(bytes) });
  }
  return { payloads, missing };
}
