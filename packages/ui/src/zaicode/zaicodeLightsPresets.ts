import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { zaicodeFileStem } from "./zaicodeFiles.js";
import {
  ZAICODE_HIGHLIGHT_DEFAULTS,
  ZAICODE_WORKING_ICON_DEFAULTS,
  normalizeZaicodeLights,
  readZaicodeLights,
  useZaicodeLights,
  type ZaicodeLightsPrefs,
} from "./zaicodeHighlights.js";

/**
 * Saved presets for Highlights & motion (SRC-048): the whole set -- Working
 * icon, every highlight, every separate mix setting -- under a name, applied
 * with one click, exported to a file and imported on another machine or into
 * another profile. The list is shared by every profile (like own sound files);
 * the set in use belongs to the profile.
 */

export interface ZaicodeLightsPreset {
  id: string;
  name: string;
  /** Shipped with ZAICODE: can be applied and exported, not renamed or deleted. */
  builtIn: boolean;
  lights: ZaicodeLightsPrefs;
}

const STORAGE_KEY = "zaicode-lights-presets-v1";
export const ZAICODE_LIGHTS_PRESETS_MAX = 60;
const NAME_MAX = 60;
/** The file marker, so an import can tell a preset file from any other JSON. */
export const ZAICODE_LIGHTS_FILE_KIND = "zaicode-lights-presets";

function builtIn(id: string, name: string, raw: unknown): ZaicodeLightsPreset {
  return { id, name, builtIn: true, lights: normalizeZaicodeLights(raw) };
}

const D = ZAICODE_HIGHLIGHT_DEFAULTS;
const W = ZAICODE_WORKING_ICON_DEFAULTS;

export const ZAICODE_BUILT_IN_LIGHTS_PRESETS: readonly ZaicodeLightsPreset[] = [
  builtIn("builtin:default", "ZAICODE default", { highlights: D, working: W }),
  builtIn("builtin:calm", "Calm", {
    highlights: Object.fromEntries(
      Object.entries(D).map(([target, rule]) => [target, { ...rule, effects: ["steady"], keepMoving: false }]),
    ),
    working: { ...W, motions: ["spin"], seconds: 6, easing: "linear" },
  }),
  builtIn("builtin:radar", "Radar", {
    highlights: { ...D, sessionWorking: { ...D.sessionWorking, effects: ["pulse"], shapes: ["text", "bar"], seconds: 1.2 } },
    working: {
      ...W,
      motions: ["spin", "pulse"],
      easing: "steps",
      steps: 12,
      seconds: 2,
      tuning: { pulse: { seconds: 1, easing: "smooth", amplitude: 30, phase: 0 } },
    },
  }),
  builtIn("builtin:neon", "Neon", {
    highlights: {
      ...D,
      sessionWorking: {
        ...D.sessionWorking,
        effects: ["breathe", "flicker"],
        shapes: ["text", "glow"],
        color: "rainbow",
        tuning: { flicker: { seconds: 5.5, phase: 30 } },
      },
      projectWorking: { ...D.projectWorking, enabled: true, effects: ["flicker"], shapes: ["glow"], color: "accent" },
    },
    working: { ...W, motions: ["spin"], glow: true, color: "accent", easing: "elastic", seconds: 1.8 },
  }),
  builtIn("builtin:heartbeat", "Heartbeat", {
    highlights: {
      ...D,
      sessionWorking: { ...D.sessionWorking, effects: ["heartbeat"], shapes: ["text", "dot"], seconds: 1.1 },
      headerWorking: { ...D.headerWorking, enabled: true, effects: ["heartbeat"], seconds: 1.1 },
    },
    working: { ...W, motions: ["pulse"], seconds: 1.1, amplitude: 35, easing: "out" },
  }),
  builtIn("builtin:coin", "Coin flip", {
    highlights: D,
    working: { ...W, motions: ["flip", "bounce"], seconds: 1.6, tuning: { bounce: { seconds: 0.8, amplitude: 60, phase: 0 } } },
  }),
];

function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const name = [...value]
    .filter((char) => (char.codePointAt(0) ?? 0) >= 32)
    .join("")
    .trim()
    .slice(0, NAME_MAX);
  return name || fallback;
}

function newId(): string {
  return `lights-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Own presets from storage; anything malformed is dropped, the rest normalized. */
export function normalizeZaicodeLightsPresets(raw: unknown): ZaicodeLightsPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ZaicodeLightsPreset[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const { id, name, lights } = row as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.startsWith("builtin:") || seen.has(id) || !lights || typeof lights !== "object") continue;
    seen.add(id);
    out.push({ id, name: cleanName(name, "Preset"), builtIn: false, lights: normalizeZaicodeLights(lights) });
    if (out.length >= ZAICODE_LIGHTS_PRESETS_MAX) break;
  }
  return out;
}

/** A name not used yet ("Neon", "Neon 2", ...). */
export function uniqueZaicodePresetName(name: string, taken: readonly string[]): string {
  const base = cleanName(name, "Preset");
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** The file an export writes: one preset or many. */
export function exportZaicodeLightsPresets(presets: readonly ZaicodeLightsPreset[]): string {
  return JSON.stringify(
    { kind: ZAICODE_LIGHTS_FILE_KIND, version: 1, presets: presets.map(({ name, lights }) => ({ name, lights })) },
    null,
    2,
  );
}

export type ZaicodeLightsImport = { presets: ZaicodeLightsPreset[] } | { error: string };

/**
 * Reads an exported file (or a bare `{ highlights, working }` set) into new
 * own presets with fresh ids and free names. Nothing is stored here.
 */
export function parseZaicodeLightsPresets(json: string, taken: readonly string[]): ZaicodeLightsImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "This file is not JSON." };
  }
  const value = (parsed ?? {}) as { kind?: unknown; presets?: unknown; highlights?: unknown; working?: unknown };
  const rows: unknown[] = Array.isArray(value.presets)
    ? value.presets
    : value.highlights || value.working
      ? [{ name: "Imported", lights: value }]
      : [];
  const names = [...taken];
  const presets: ZaicodeLightsPreset[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { name, lights } = row as { name?: unknown; lights?: unknown };
    if (!lights || typeof lights !== "object") continue;
    const unique = uniqueZaicodePresetName(cleanName(name, "Imported"), names);
    names.push(unique);
    presets.push({ id: newId(), name: unique, builtIn: false, lights: normalizeZaicodeLights(lights) });
  }
  return presets.length > 0
    ? { presets }
    : { error: "No Highlights & motion presets found in this file (expected an export from ZAICODE)." };
}

// ---------------------------------------------------------------- store

function load(): ZaicodeLightsPreset[] {
  try {
    return normalizeZaicodeLightsPresets(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return [];
  }
}

interface ZaicodeLightsPresetsState {
  own: ZaicodeLightsPreset[];
}

export const useZaicodeLightsPresets = create<ZaicodeLightsPresetsState>(() => ({ own: load() }));

/** False when storage refused it (full); the list still changes for this session. */
function persist(own: ZaicodeLightsPreset[]): boolean {
  useZaicodeLightsPresets.setState({ own });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(own.map(({ builtIn: _builtIn, ...rest }) => rest)));
    return true;
  } catch {
    return false;
  }
}

function takenNames(): string[] {
  return [...ZAICODE_BUILT_IN_LIGHTS_PRESETS, ...useZaicodeLightsPresets.getState().own].map((preset) => preset.name);
}

export function allZaicodeLightsPresets(own: readonly ZaicodeLightsPreset[]): ZaicodeLightsPreset[] {
  return [...ZAICODE_BUILT_IN_LIGHTS_PRESETS, ...own];
}

/** Saves what is on screen now as a new preset; returns its id, or null when the list is full. */
export function saveZaicodeLightsPreset(name: string): { id: string; stored: boolean } | null {
  const own = useZaicodeLightsPresets.getState().own;
  if (own.length >= ZAICODE_LIGHTS_PRESETS_MAX) return null;
  const preset: ZaicodeLightsPreset = {
    id: newId(),
    name: uniqueZaicodePresetName(name, takenNames()),
    builtIn: false,
    lights: readZaicodeLights(),
  };
  return { id: preset.id, stored: persist([...own, preset]) };
}

/** Replaces an own preset's set with what is on screen now. */
export function overwriteZaicodeLightsPreset(id: string): boolean {
  const own = useZaicodeLightsPresets.getState().own;
  if (!own.some((preset) => preset.id === id)) return false;
  return persist(own.map((preset) => (preset.id === id ? { ...preset, lights: readZaicodeLights() } : preset)));
}

export function renameZaicodeLightsPreset(id: string, name: string): void {
  const own = useZaicodeLightsPresets.getState().own;
  const others = takenNames().filter((taken) => taken !== own.find((preset) => preset.id === id)?.name);
  persist(own.map((preset) => (preset.id === id ? { ...preset, name: uniqueZaicodePresetName(name, others) } : preset)));
}

export function removeZaicodeLightsPreset(id: string): void {
  persist(useZaicodeLightsPresets.getState().own.filter((preset) => preset.id !== id));
}

/** Puts a preset's whole set in place. */
export function applyZaicodeLightsPreset(id: string): boolean {
  const preset = allZaicodeLightsPresets(useZaicodeLightsPresets.getState().own).find((candidate) => candidate.id === id);
  if (!preset) return false;
  useZaicodeLights.getState().replaceLights(preset.lights);
  return true;
}

/** Adds the presets of an exported file; the message says what happened. */
export function importZaicodeLightsPresets(json: string): { ok: boolean; message: string } {
  const result = parseZaicodeLightsPresets(json, takenNames());
  if ("error" in result) return { ok: false, message: result.error };
  const own = useZaicodeLightsPresets.getState().own;
  const room = ZAICODE_LIGHTS_PRESETS_MAX - own.length;
  if (room <= 0) return { ok: false, message: `The list is full (${ZAICODE_LIGHTS_PRESETS_MAX} presets): delete some first.` };
  const added = result.presets.slice(0, room);
  const stored = persist([...own, ...added]);
  const skipped = result.presets.length - added.length;
  return {
    ok: true,
    message: `Imported ${added.length} preset${added.length === 1 ? "" : "s"}: ${added.map((preset) => preset.name).join(", ")}${
      skipped > 0 ? ` (${skipped} left out: the list is full)` : ""
    }${stored ? "" : " (not saved: storage is full, they last until restart)"}.`,
  };
}

/** The export file name for a preset name. */
export function zaicodePresetFileName(name: string): string {
  return `zaicode-lights-${zaicodeFileStem(name, "presets")}.json`;
}
