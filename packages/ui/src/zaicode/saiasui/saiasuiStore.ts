import { create } from "zustand";
import { readZaicodeSetting } from "../zaicodeSettingsSnapshot.js";
import {
  detectSaiasuiPreset,
  normalizeSaiasuiConfig,
  saiasuiPresetConfig,
  SAIASUI_DEFAULTS,
  type SaiasuiConfig,
  type SaiasuiPreset,
} from "./saiasuiConfig.js";
import type { PacingMode } from "./saiasuiEngine.js";

const SETTINGS = "zaicode-saiasui-settings-v1";
const RECORDS = "zaicode-saiasui-records-v1";
type Best = { score: number; combo: number };
type Records = Record<PacingMode, Best>;

/** Back-compat: the old three-field settings shape, still used by some callers/tests. */
export interface SaiasuiSettings {
  enabled: boolean;
  sound: boolean;
  pacing: PacingMode;
}

/** Legacy normalizer kept for the old settings surface; the full model is normalizeSaiasuiConfig. */
export function normalizeSaiasuiSettings(raw: unknown): SaiasuiSettings {
  const c = normalizeSaiasuiConfig(raw);
  return { enabled: c.enabled, sound: c.audioEnabled, pacing: c.pacing };
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

interface SaiasuiStore {
  config: SaiasuiConfig;
  best: Records;
  /** Patch one or more fields; the run's preset drops to "custom" when a preset-defined field changes. */
  configure: (patch: Partial<SaiasuiConfig>) => void;
  /** Load a named preset wholesale (Custom keeps the current config). */
  applyPreset: (preset: SaiasuiPreset) => void;
  /** Reset every field to shipped defaults. */
  resetAll: () => void;
  record: (mode: PacingMode, score: number, combo: number) => void;
}

export const useSaiasui = create<SaiasuiStore>((set, get) => {
  const persist = (next: SaiasuiConfig) => {
    const config = normalizeSaiasuiConfig({ ...next, preset: detectSaiasuiPreset(normalizeSaiasuiConfig(next)) });
    save(SETTINGS, config);
    set({ config });
  };
  return {
    config: normalizeSaiasuiConfig(load(SETTINGS)),
    best: records(),
    configure: (patch) => persist({ ...get().config, ...patch }),
    applyPreset: (preset) => {
      if (preset === "custom") {
        persist({ ...get().config, preset: "custom" });
        return;
      }
      persist(saiasuiPresetConfig(preset));
    },
    resetAll: () => persist({ ...SAIASUI_DEFAULTS }),
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
  };
});
