import { create } from "zustand";
import { readZaicodeSetting } from "../zaicodeSettingsSnapshot.js";
import type { PacingMode } from "./saiasuiEngine.js";

export interface SaiasuiSettings {
  enabled: boolean;
  sound: boolean;
  pacing: PacingMode;
}
const SETTINGS = "zaicode-saiasui-settings-v1";
const RECORDS = "zaicode-saiasui-records-v1";
type Best = { score: number; combo: number };
type Records = Record<PacingMode, Best>;

export function normalizeSaiasuiSettings(raw: unknown): SaiasuiSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    enabled: r.enabled !== false,
    sound: r.sound !== false,
    pacing: r.pacing === "step" ? "step" : "linear",
  };
}

function load(key: string): unknown {
  try {
    return JSON.parse(readZaicodeSetting(key) ?? "null");
  } catch {
    return null;
  }
}
function records(): Records {
  const raw = load(RECORDS) as Partial<Records> | null;
  const best = (mode: PacingMode): Best => {
    const n = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
        : 0;
    return { score: n(raw?.[mode]?.score), combo: n(raw?.[mode]?.combo) };
  };
  return { linear: best("linear"), step: best("step") };
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Session-only when storage is unavailable. */
  }
}

export const useSaiasui = create<{
  settings: SaiasuiSettings;
  best: Records;
  configure: (patch: Partial<SaiasuiSettings>) => void;
  record: (mode: PacingMode, score: number, combo: number) => void;
}>((set, get) => ({
  settings: normalizeSaiasuiSettings(load(SETTINGS)),
  best: records(),
  configure: (patch) => {
    const settings = normalizeSaiasuiSettings({ ...get().settings, ...patch });
    save(SETTINGS, settings);
    set({ settings });
  },
  record: (mode, score, combo) => {
    const previous = get().best;
    const best = {
      ...previous,
      [mode]: {
        score: Math.max(previous[mode].score, score),
        combo: Math.max(previous[mode].combo, combo),
      },
    };
    save(RECORDS, best);
    set({ best });
  },
}));
