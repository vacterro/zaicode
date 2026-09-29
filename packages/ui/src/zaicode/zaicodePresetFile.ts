import { zaicodeFileStem } from "./zaicodeFiles.js";
import { zaicodePresetSection, type ZaicodePresetSection, type ZaicodePresetSectionId } from "./zaicodePresetSections.js";

/**
 * A Settings preset as data (T-125), free of the DOM and of storage so it can be reasoned about and tested:
 * what a section's settings look like as a shareable value, how a file is read (never trusted), and which
 * own sounds a preset needs to carry.
 *
 * A preset holds only the keys of ONE section (zaicodePresetSections.ts). A value is stored the way the app
 * keeps it -- a string in localStorage -- but written into the file readable: a JSON object or array is
 * embedded as itself (not as an escaped string inside a string), any other string as it is, `null` = the key
 * is unset (the release default). Own sounds ride along as assets with a sha256, so an import can say
 * exactly what is missing or altered instead of playing something else.
 */

export const ZAICODE_PRESET_KIND = "zaicode-preset";
export const ZAICODE_PRESET_VERSION = 1;
export const ZAICODE_PRESET_NAME_MAX = 60;
/** One own sound, and all of a preset's, as a file may carry them. */
export const ZAICODE_PRESET_ASSET_MAX_BYTES = 25 * 1024 * 1024;
export const ZAICODE_PRESET_ASSETS_MAX_BYTES = 100 * 1024 * 1024;

export type PresetValue = string | null | Record<string, unknown> | unknown[];

/** An own sound a preset needs: which sound id it stands for, what it was called, what it held. */
export interface PresetAssetRef {
  /** The sound id the settings use: `custom:<event id>` (own file of one event) or `customization:<path>` (the customization folder). */
  id: string;
  kind: "sound";
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface PresetAssetPayload extends PresetAssetRef {
  /** The file's bytes, base64. */
  data: string;
}

/** A preset in the local list. */
export interface ZaicodePreset {
  id: string;
  section: ZaicodePresetSectionId;
  name: string;
  createdAt: string;
  settings: Record<string, PresetValue>;
  assets: PresetAssetRef[];
}

/** A preset as a file. */
export interface ZaicodePresetFile {
  kind: typeof ZAICODE_PRESET_KIND;
  version: number;
  section: ZaicodePresetSectionId;
  name: string;
  createdAt: string;
  /** The ZAICODE that wrote it, for the person reading the file. */
  app?: string;
  settings: Record<string, PresetValue>;
  assets: PresetAssetPayload[];
}

// ---------------------------------------------------------------- values

/** A stored string as a preset value (see the module comment). */
export function encodeSettingValue(raw: string | null): PresetValue {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown> | unknown[];
  } catch {
    // Not JSON: it is a plain string setting.
  }
  return raw;
}

/** A preset value as the string the app stores (null = remove the key). */
export function decodeSettingValue(value: PresetValue): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function sameSetting(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  try {
    return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- facts that stay on this machine

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function copyOf<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function pick(value: unknown, parts: readonly string[]): { found: boolean; value?: unknown } {
  let at: unknown = value;
  for (const part of parts) {
    if (!isPlain(at) || !Object.hasOwn(at, part)) return { found: false };
    at = at[part];
  }
  return { found: true, value: at };
}

function drop(target: Record<string, unknown>, parts: readonly string[]): void {
  const parent = parts.length === 1 ? target : pick(target, parts.slice(0, -1)).value;
  if (isPlain(parent)) delete parent[parts[parts.length - 1]!];
}

function put(target: Record<string, unknown>, parts: readonly string[], value: unknown): void {
  let at = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlain(at[part])) at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  at[parts[parts.length - 1]!] = copyOf(value);
}

/** The value without the parts of it that belong to this machine or to right now (section.local). */
export function stripLocalFacts(section: ZaicodePresetSection, key: string, value: PresetValue): PresetValue {
  const paths = section.local?.[key];
  if (!paths || !isPlain(value)) return value;
  const copy = copyOf(value);
  for (const path of paths) drop(copy, path.split("."));
  return copy;
}

/**
 * The incoming value with this machine's own facts put back from what the page has now. A key that is unset in
 * the preset stays unset unless the page holds such a fact: then only the facts remain (the rest is default).
 */
export function keepLocalFacts(section: ZaicodePresetSection, key: string, incoming: PresetValue, current: PresetValue): PresetValue {
  const paths = section.local?.[key];
  if (!paths || (incoming !== null && !isPlain(incoming))) return incoming;
  const merged: Record<string, unknown> = incoming === null ? {} : copyOf(incoming);
  let kept = 0;
  for (const path of paths) {
    const parts = path.split(".");
    const there = pick(current, parts);
    if (there.found) {
      put(merged, parts, there.value);
      kept += 1;
    } else {
      drop(merged, parts);
    }
  }
  return incoming === null && kept === 0 ? null : merged;
}

/** The section's settings as they stand: every key it owns, `null` where unset, local facts left out. */
export function capturePresetSettings(section: ZaicodePresetSection, read: (key: string) => string | null): Record<string, PresetValue> {
  const settings: Record<string, PresetValue> = {};
  for (const key of section.keys) settings[key] = stripLocalFacts(section, key, encodeSettingValue(read(key)));
  return settings;
}

/** The keys a preset would change right now, for the person about to apply it. */
export function presetChanges(section: ZaicodePresetSection, settings: Record<string, PresetValue>, read: (key: string) => string | null): string[] {
  return section.keys.filter((key) => {
    if (!Object.hasOwn(settings, key)) return false;
    const wanted = decodeSettingValue(stripLocalFacts(section, key, settings[key]!));
    const now = decodeSettingValue(stripLocalFacts(section, key, encodeSettingValue(read(key))));
    return !sameSetting(wanted, now);
  });
}

/**
 * Puts a preset's settings in place; only keys of the section are ever written. With `read`, the page's own
 * local facts (section.local) are kept: they are never taken from the preset.
 */
export function applyPresetSettings(
  section: ZaicodePresetSection,
  settings: Record<string, PresetValue>,
  write: (key: string, value: string | null) => void,
  read?: (key: string) => string | null,
): string[] {
  const written: string[] = [];
  for (const key of section.keys) {
    if (!Object.hasOwn(settings, key)) continue;
    const value = read ? keepLocalFacts(section, key, settings[key]!, encodeSettingValue(read(key))) : settings[key]!;
    write(key, decodeSettingValue(value));
    written.push(key);
  }
  return written;
}

// ---------------------------------------------------------------- sounds a preset needs

function hasControlCharacter(text: string): boolean {
  for (const char of text) if ((char.codePointAt(0) ?? 0) < 32) return true;
  return false;
}

/** `custom:<event id>` or `customization:<path in the customization folder>`: the sounds a file has to carry. */
export function isPresetAssetSoundId(id: string): boolean {
  if (/^custom:[A-Za-z0-9._-]{1,120}$/.test(id)) return true;
  if (!id.startsWith("customization:")) return false;
  const path = id.slice("customization:".length);
  return path.length > 0 && path.length <= 300 && !/^[\\/]/.test(path) && !path.includes("..") && !/[<>:"|?*]/.test(path) && !hasControlCharacter(path);
}

/** Every own-sound id mentioned anywhere in the settings, in order of appearance, once each. */
export function presetSoundIds(settings: Record<string, PresetValue>): string[] {
  const found = new Set<string>();
  const walk = (value: unknown, depth: number): void => {
    if (depth > 10) return;
    if (typeof value === "string") {
      if (isPresetAssetSoundId(value)) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value && typeof value === "object") for (const item of Object.values(value)) walk(item, depth + 1);
  };
  for (const value of Object.values(settings)) walk(value, 0);
  return [...found];
}

// ---------------------------------------------------------------- names, ids, files

export function cleanPresetName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const name = [...value]
    .filter((char) => (char.codePointAt(0) ?? 0) >= 32)
    .join("")
    .trim()
    .slice(0, ZAICODE_PRESET_NAME_MAX);
  return name || fallback;
}

/** A name not used yet ("Night", "Night 2", ...). */
export function uniquePresetName(name: string, taken: readonly string[]): string {
  const base = cleanPresetName(name, "Preset");
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`.slice(0, ZAICODE_PRESET_NAME_MAX + 4);
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function newPresetId(): string {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The file name an export gets: what it is, whose it is. */
export function presetFileName(section: ZaicodePresetSectionId, name: string): string {
  return `zaicode-preset-${zaicodeFileStem(section.replace(/^zaicode/, "").toLowerCase() || "settings", "settings")}-${zaicodeFileStem(name, "preset")}.json`;
}

export function buildPresetFile(preset: ZaicodePreset, payloads: readonly PresetAssetPayload[], app?: string): ZaicodePresetFile {
  return {
    kind: ZAICODE_PRESET_KIND,
    version: ZAICODE_PRESET_VERSION,
    section: preset.section,
    name: preset.name,
    createdAt: preset.createdAt,
    ...(app ? { app } : {}),
    settings: preset.settings,
    assets: [...payloads],
  };
}

export type PresetFileParse = { ok: true; file: ZaicodePresetFile; notes: string[] } | { ok: false; error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readAsset(raw: unknown, notes: string[]): PresetAssetPayload | null {
  if (!isRecord(raw)) return null;
  const { id, kind, name, mime, bytes, sha256, data } = raw;
  const label = typeof id === "string" ? id : "an own sound";
  if (typeof id !== "string" || !isPresetAssetSoundId(id) || kind !== "sound") {
    notes.push(`${label}: not a sound this ZAICODE can take; left out`);
    return null;
  }
  if (typeof data !== "string" || !BASE64.test(data) || typeof sha256 !== "string" || !SHA256.test(sha256)) {
    notes.push(`${label}: its data or digest is malformed; left out`);
    return null;
  }
  const size = typeof bytes === "number" && Number.isFinite(bytes) ? Math.floor(bytes) : Math.floor((data.length * 3) / 4);
  // The claimed size must be what the data decodes to (within base64 padding), and within the limit.
  if (Math.abs(size - Math.floor((data.length * 3) / 4)) > 3 || size <= 0 || size > ZAICODE_PRESET_ASSET_MAX_BYTES) {
    notes.push(`${label}: its size is wrong or over ${Math.round(ZAICODE_PRESET_ASSET_MAX_BYTES / 1024 / 1024)} MB; left out`);
    return null;
  }
  return {
    id,
    kind: "sound",
    name: cleanPresetName(name, id.replace(/^[a-z]+:/, "")).slice(0, 120),
    mime: typeof mime === "string" && /^audio\/[\w.+-]{1,40}$/.test(mime) ? mime : "audio/wav",
    bytes: size,
    sha256,
    data,
  };
}

/**
 * Reads an exported file. Never trusts it: the kind and version are checked, the section has to be one this
 * ZAICODE knows, keys outside that section are dropped (and said), values and assets are validated, and a
 * newer format is refused with the reason. Nothing is stored here.
 */
export function parsePresetFile(text: string): PresetFileParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file is not JSON." };
  }
  if (!isRecord(parsed) || parsed.kind !== ZAICODE_PRESET_KIND) {
    return { ok: false, error: "This is not a ZAICODE preset (expected a file exported from a Settings page)." };
  }
  if (typeof parsed.version !== "number" || !Number.isInteger(parsed.version) || parsed.version < 1) {
    return { ok: false, error: "This preset has no readable format version." };
  }
  if (parsed.version > ZAICODE_PRESET_VERSION) {
    return { ok: false, error: `This preset was made by a newer ZAICODE (format ${parsed.version}); update ZAICODE to read it.` };
  }
  const section = typeof parsed.section === "string" ? zaicodePresetSection(parsed.section) : undefined;
  if (!section) return { ok: false, error: `This preset is for "${String(parsed.section)}", a page this ZAICODE has no presets for.` };
  if (!isRecord(parsed.settings)) return { ok: false, error: "This preset holds no settings." };
  const notes: string[] = [];
  const settings: Record<string, PresetValue> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(parsed.settings)) {
    if (!section.keys.includes(key)) {
      dropped.push(key);
      continue;
    }
    if (value === null || typeof value === "string" || (typeof value === "object" && value !== undefined)) {
      settings[key] = stripLocalFacts(section, key, value as PresetValue);
    } else {
      notes.push(`${key}: not a setting value; left out`);
    }
  }
  if (dropped.length > 0) notes.push(`${dropped.length} setting${dropped.length === 1 ? "" : "s"} that ${section.title} does not own were left out (${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? ", ..." : ""})`);
  if (Object.keys(settings).length === 0) return { ok: false, error: `This preset holds no ${section.title} settings this ZAICODE knows.` };
  const assets: PresetAssetPayload[] = [];
  let total = 0;
  for (const raw of Array.isArray(parsed.assets) ? parsed.assets : []) {
    const asset = readAsset(raw, notes);
    if (!asset) continue;
    if (total + asset.bytes > ZAICODE_PRESET_ASSETS_MAX_BYTES) {
      notes.push(`${asset.id}: the sounds together are over ${Math.round(ZAICODE_PRESET_ASSETS_MAX_BYTES / 1024 / 1024)} MB; left out`);
      continue;
    }
    if (assets.some((existing) => existing.id === asset.id)) continue;
    total += asset.bytes;
    assets.push(asset);
  }
  return {
    ok: true,
    notes,
    file: {
      kind: ZAICODE_PRESET_KIND,
      version: parsed.version,
      section: section.id,
      name: cleanPresetName(parsed.name, "Imported"),
      createdAt: typeof parsed.createdAt === "string" && !Number.isNaN(Date.parse(parsed.createdAt)) ? parsed.createdAt : new Date(0).toISOString(),
      ...(typeof parsed.app === "string" ? { app: parsed.app.slice(0, 60) } : {}),
      settings,
      assets,
    },
  };
}
