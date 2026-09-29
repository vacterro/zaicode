/**
 * ZAICODE customization folder (T-126, SRC-089): one folder the operator can find and drop things into.
 *
 *   <root>\customization\sounds\   WAV / MP3 / OGG, sub-folders allowed, listed live
 *   <root>\customization\presets\  one JSON file per exported preset
 *
 * The main process owns the disk (zaicodeCustomization.ts); the renderer only ever names a file by its path
 * INSIDE `sounds\` or `presets\`, never by an absolute path. This file is the vocabulary both sides share.
 */

/** Where the customization root was found; shown so the operator can see why it is where it is. */
export type ZaicodeCustomizationRootSource = "env-dir" | "env-root" | "workspace" | "appdata";

export const ZAICODE_CUSTOM_SOUND_EXTENSIONS: readonly string[] = [".wav", ".mp3", ".ogg"];
export const ZAICODE_CUSTOM_SOUND_ID_PREFIX = "customization:";
/** One sound over this size is not listed, read or written (a preset carries at most 25 MB per sound on top of that). */
export const ZAICODE_CUSTOM_SOUND_MAX_BYTES = 100 * 1024 * 1024;
export const ZAICODE_CUSTOM_SOUND_MAX_DEPTH = 6;
export const ZAICODE_CUSTOM_SOUND_MAX_FILES = 5000;
export const ZAICODE_CUSTOM_PRESET_MAX_BYTES = 160 * 1024 * 1024;
export const ZAICODE_CUSTOM_PRESET_MAX_FILES = 500;

export interface ZaicodeCustomizationInfo {
  /** Absolute path of `customization\`. */
  root: string;
  soundsDir: string;
  presetsDir: string;
  source: ZaicodeCustomizationRootSource;
}

export interface ZaicodeCustomSoundEntry {
  /** Path inside `sounds\`, forward slashes, e.g. `Horse/HORSE01.wav`. */
  path: string;
  /** Length in seconds; -1 when the header does not say. */
  seconds: number;
  bytes: number;
  mtimeMs: number;
}

export interface ZaicodeCustomSoundList {
  info: ZaicodeCustomizationInfo;
  sounds: ZaicodeCustomSoundEntry[];
  /** More files than the scan reads (or nested deeper than it looks). */
  truncated: boolean;
}

export interface ZaicodeCustomPresetEntry {
  /** File name inside `presets\`. */
  name: string;
  bytes: number;
  mtimeMs: number;
}

export type ZaicodeCustomizationKind = "root" | "sounds" | "presets";

export type ZaicodeCustomizationChange = "sounds" | "presets";

export type ZaicodeCustomSoundReadResult =
  | { ok: true; bytes: Uint8Array; mtimeMs: number }
  | { ok: false; reason: string };

export interface ZaicodeCustomSoundWriteRequest {
  /** Wanted path inside `sounds\` (a preset's `customization:<path>`); a taken path with other bytes gets ` (2)`. */
  path: string;
  bytes: Uint8Array;
}

export type ZaicodeCustomWriteResult =
  | { ok: true; /** Path or file name it ended up under. */ path: string; /** False when identical bytes were already there. */ created: boolean; /** Absolute path, for "show in folder". */ absolute: string }
  | { ok: false; reason: string };

export interface ZaicodeCustomPresetWriteRequest {
  /** Wanted file name (`zaicode-preset-sounds-my setup.json`); a taken name with other text gets ` (2)`. */
  name: string;
  text: string;
}

export type ZaicodeCustomPresetReadResult = { ok: true; text: string } | { ok: false; reason: string };

/** `customization:<path>` for a path inside `sounds\`. */
export function zaicodeCustomSoundId(path: string): string {
  return `${ZAICODE_CUSTOM_SOUND_ID_PREFIX}${path}`;
}

/** The path a `customization:<path>` id names, or null when it is not one. */
export function zaicodeCustomSoundPathOf(id: string): string | null {
  if (!id.startsWith(ZAICODE_CUSTOM_SOUND_ID_PREFIX)) return null;
  const path = id.slice(ZAICODE_CUSTOM_SOUND_ID_PREFIX.length);
  return path.length > 0 ? path : null;
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not carry
const ILLEGAL_SEGMENT = /[<>:"|?*\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Whether `path` is a safe relative path inside a customization sub-folder: forward slashes, no absolute part, no
 * drive letter, no `..`, no reserved Windows name, no name ending in a space or dot, at most `maxDepth` segments.
 * Pure, so the renderer and the main process ask the same question.
 */
export function isZaicodeCustomizationRelPath(path: string, maxDepth = ZAICODE_CUSTOM_SOUND_MAX_DEPTH): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 300) return false;
  if (path.includes("\\") || path.startsWith("/")) return false;
  const segments = path.split("/");
  if (segments.length > maxDepth) return false;
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !ILLEGAL_SEGMENT.test(segment) &&
      !WINDOWS_RESERVED.test(segment) &&
      !/[ .]$/.test(segment),
  );
}

export function isZaicodeCustomSoundPath(path: string): boolean {
  if (!isZaicodeCustomizationRelPath(path)) return false;
  const lower = path.toLowerCase();
  return ZAICODE_CUSTOM_SOUND_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** A preset file name: one segment, `.json`, nothing a file system refuses. */
export function isZaicodeCustomPresetName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length <= 160 &&
    name.toLowerCase().endsWith(".json") &&
    name.length > ".json".length &&
    !name.includes("/") &&
    isZaicodeCustomizationRelPath(name, 1)
  );
}

/** A file name safe on every file system, from any text a person typed; never empty. */
export function zaicodeCustomizationFileStem(text: string, fallback: string): string {
  const cleaned = text
    // eslint-disable-next-line no-control-regex -- see ILLEGAL_SEGMENT
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "")
    .slice(0, 80)
    .trim();
  if (!cleaned || WINDOWS_RESERVED.test(cleaned)) return fallback;
  return cleaned;
}
