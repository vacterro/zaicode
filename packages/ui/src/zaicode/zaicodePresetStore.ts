import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import type { PresetUndo } from "./zaicodePresetApply.js";
import {
  cleanPresetName,
  isPresetAssetSoundId,
  stripLocalFacts,
  uniquePresetName,
  type PresetAssetRef,
  type PresetValue,
  type ZaicodePreset,
} from "./zaicodePresetFile.js";
import { zaicodePresetSection, type ZaicodePresetSection, type ZaicodePresetSectionId } from "./zaicodePresetSections.js";

/**
 * The list of saved presets (T-125) and the one-step Undo record of every section, kept in localStorage.
 * Shared by every profile like the Highlights & motion presets: a look you saved is yours, whichever profile
 * is open. Only references to own sounds live here (a digest); the bytes are in the blob store.
 *
 * Whatever storage holds is not trusted: a list written by another version, edited by hand or cut short is read
 * row by row and every row that is not a preset of a known section is dropped.
 */

export const ZAICODE_PRESETS_KEY = "zaicode-presets-v1";
export const ZAICODE_PRESET_UNDO_KEY = "zaicode-preset-undo-v1";
export const ZAICODE_PRESETS_MAX_PER_SECTION = 40;

const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validDate(value: unknown): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : new Date(0).toISOString();
}

function normalizeRefs(raw: unknown): PresetAssetRef[] {
  const refs: PresetAssetRef[] = [];
  for (const row of Array.isArray(raw) ? raw : []) {
    if (!isRecord(row)) continue;
    const { id, name, mime, bytes, sha256 } = row;
    if (typeof id !== "string" || !isPresetAssetSoundId(id) || typeof sha256 !== "string" || !SHA256.test(sha256)) continue;
    if (refs.some((ref) => ref.id === id)) continue;
    refs.push({
      id,
      kind: "sound",
      name: cleanPresetName(name, id.replace(/^[a-z]+:/, "")).slice(0, 120),
      mime: typeof mime === "string" && /^audio\/[\w.+-]{1,40}$/.test(mime) ? mime : "audio/wav",
      bytes: typeof bytes === "number" && Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0,
      sha256,
    });
  }
  return refs;
}

/** Only the keys the section owns, without its local facts; null when nothing usable is left. */
function normalizeSettings(section: ZaicodePresetSection, raw: unknown): Record<string, PresetValue> | null {
  if (!isRecord(raw)) return null;
  const settings: Record<string, PresetValue> = {};
  for (const key of section.keys) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (value === null || typeof value === "string" || (typeof value === "object" && value !== undefined)) {
      settings[key] = stripLocalFacts(section, key, value as PresetValue);
    }
  }
  return Object.keys(settings).length > 0 ? settings : null;
}

/** The saved list as storage holds it: malformed rows dropped, every row cleaned, at most N per section. */
export function normalizeZaicodePresets(raw: unknown): ZaicodePreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const perSection = new Map<string, number>();
  const out: ZaicodePreset[] = [];
  for (const row of raw) {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id || seen.has(row.id) || typeof row.section !== "string") continue;
    const section = zaicodePresetSection(row.section);
    const settings = section ? normalizeSettings(section, row.settings) : null;
    if (!section || !settings) continue;
    if ((perSection.get(section.id) ?? 0) >= ZAICODE_PRESETS_MAX_PER_SECTION) continue;
    seen.add(row.id);
    perSection.set(section.id, (perSection.get(section.id) ?? 0) + 1);
    out.push({
      id: row.id.slice(0, 80),
      section: section.id,
      name: cleanPresetName(row.name, "Preset"),
      createdAt: validDate(row.createdAt),
      settings,
      assets: normalizeRefs(row.assets),
    });
  }
  return out;
}

export type PresetUndos = Partial<Record<ZaicodePresetSectionId, PresetUndo>>;

export function normalizePresetUndos(raw: unknown): PresetUndos {
  if (!isRecord(raw)) return {};
  const out: PresetUndos = {};
  for (const [key, value] of Object.entries(raw)) {
    const section = zaicodePresetSection(key);
    const settings = section && isRecord(value) ? normalizeSettings(section, value.settings) : null;
    if (!section || !settings || !isRecord(value)) continue;
    out[section.id] = {
      section: section.id,
      label: cleanPresetName(value.label, "the previous settings"),
      at: validDate(value.at),
      settings,
      assets: normalizeRefs(value.assets),
    };
  }
  return out;
}

/** Every sound digest a preset or an undo record still needs: what the blob store must keep. */
export function usedBlobDigests(presets: readonly ZaicodePreset[], undos: PresetUndos): Set<string> {
  const used = new Set<string>();
  for (const preset of presets) for (const asset of preset.assets) used.add(asset.sha256);
  for (const undo of Object.values(undos)) for (const asset of undo?.assets ?? []) used.add(asset.sha256);
  return used;
}

/** The presets of one page, in the order they were saved. */
export function presetsOfSection(all: readonly ZaicodePreset[], section: ZaicodePresetSectionId): ZaicodePreset[] {
  return all.filter((preset) => preset.section === section);
}

// ---------------------------------------------------------------- store

function load(key: string): unknown {
  try {
    return JSON.parse(readZaicodeSetting(key) ?? "null");
  } catch {
    return null;
  }
}

interface ZaicodePresetsState {
  presets: ZaicodePreset[];
  undos: PresetUndos;
}

export const useZaicodePresets = create<ZaicodePresetsState>(() => ({
  presets: normalizeZaicodePresets(load(ZAICODE_PRESETS_KEY)),
  undos: normalizePresetUndos(load(ZAICODE_PRESET_UNDO_KEY)),
}));

/** False when storage refused it (full); the list still changes for this window. */
function keep(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function persistPresets(presets: ZaicodePreset[]): boolean {
  useZaicodePresets.setState({ presets });
  return keep(ZAICODE_PRESETS_KEY, presets);
}

/** Adds a preset under a name not used on its page yet; null when the page's list is full. */
export function addZaicodePreset(preset: ZaicodePreset): { preset: ZaicodePreset; stored: boolean } | null {
  const all = useZaicodePresets.getState().presets;
  const same = presetsOfSection(all, preset.section);
  if (same.length >= ZAICODE_PRESETS_MAX_PER_SECTION) return null;
  const added = { ...preset, name: uniquePresetName(preset.name, same.map((entry) => entry.name)) };
  return { preset: added, stored: persistPresets([...all, added]) };
}

/** The preset's settings and sounds replaced (the "Update" button); the name and place in the list stay. Null: no such preset. */
export function replaceZaicodePreset(preset: ZaicodePreset): { stored: boolean } | null {
  const all = useZaicodePresets.getState().presets;
  if (!all.some((entry) => entry.id === preset.id)) return null;
  return { stored: persistPresets(all.map((entry) => (entry.id === preset.id ? preset : entry))) };
}

export function renameZaicodePreset(id: string, name: string): void {
  const all = useZaicodePresets.getState().presets;
  const target = all.find((entry) => entry.id === id);
  if (!target) return;
  const others = presetsOfSection(all, target.section)
    .filter((entry) => entry.id !== id)
    .map((entry) => entry.name);
  persistPresets(all.map((entry) => (entry.id === id ? { ...entry, name: uniquePresetName(name, others) } : entry)));
}

export function removeZaicodePreset(id: string): void {
  persistPresets(useZaicodePresets.getState().presets.filter((entry) => entry.id !== id));
}

/** The Undo record of a page (null = none); kept across a window reload, because an apply may cause one. */
export function setZaicodePresetUndo(section: ZaicodePresetSectionId, undo: PresetUndo | null): boolean {
  const undos: PresetUndos = { ...useZaicodePresets.getState().undos };
  if (undo) undos[section] = undo;
  else delete undos[section];
  useZaicodePresets.setState({ undos });
  return keep(ZAICODE_PRESET_UNDO_KEY, undos);
}
