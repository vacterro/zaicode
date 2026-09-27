import { create } from "zustand";
import { readZaicodeSetting } from "../zaicodeSettingsSnapshot.js";
import { normalizeSaipeggleSettings, saipeggleDefaults, type SaipeggleSettings } from "./saipeggleModel.js";

/**
 * SAIPEGGLE's settings and progress, stored like every ZAICODE preference
 * (and part of a profile): which adventure levels are open, the best score
 * of every level, the last level played.
 */

const STORAGE_KEY = "zaicode-saipeggle-v1";

export interface SaipeggleProgress {
  /** Adventure levels open to play: 1..55 (the first is always open). */
  unlocked: number;
  best: Record<string, number>;
  cleared: Record<string, boolean>;
  /** The adventure index last played (0-based). */
  current: number;
  totalScore: number;
}

export function emptySaipeggleProgress(): SaipeggleProgress {
  return { unlocked: 1, best: {}, cleared: {}, current: 0, totalScore: 0 };
}

function normalizeProgress(raw: unknown): SaipeggleProgress {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const scores = (value: unknown) =>
    Object.fromEntries(
      Object.entries(value && typeof value === "object" ? (value as Record<string, unknown>) : {}).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
      ),
    );
  const flags = (value: unknown) =>
    Object.fromEntries(
      Object.entries(value && typeof value === "object" ? (value as Record<string, unknown>) : {}).filter((entry): entry is [string, boolean] => entry[1] === true),
    );
  const int = (value: unknown, min: number, max: number, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  return {
    unlocked: int(r.unlocked, 1, 55, 1),
    best: scores(r.best),
    cleared: flags(r.cleared),
    current: int(r.current, 0, 54, 0),
    totalScore: int(r.totalScore, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

function load(): { settings: SaipeggleSettings; progress: SaipeggleProgress } {
  try {
    const raw = JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null") as { settings?: unknown; progress?: unknown } | null;
    return { settings: normalizeSaipeggleSettings(raw?.settings), progress: normalizeProgress(raw?.progress) };
  } catch {
    return { settings: saipeggleDefaults(), progress: emptySaipeggleProgress() };
  }
}

interface SaipeggleStore {
  settings: SaipeggleSettings;
  progress: SaipeggleProgress;
  setSettings: (patch: Partial<SaipeggleSettings>) => void;
  resetSettings: () => void;
  /** A level ended in a win: its best score, and the next adventure level opens. */
  recordWin: (levelId: string, score: number, adventureIndex: number | null) => void;
  setCurrent: (adventureIndex: number) => void;
  resetProgress: () => void;
}

export const useSaipeggle = create<SaipeggleStore>((set, get) => {
  const persist = (patch: Partial<Pick<SaipeggleStore, "settings" | "progress">>) => {
    set(patch);
    try {
      const { settings, progress } = get();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, progress }));
    } catch {
      // this session only
    }
  };
  return {
    ...load(),
    setSettings: (patch) => persist({ settings: normalizeSaipeggleSettings({ ...get().settings, ...patch }) }),
    resetSettings: () => persist({ settings: saipeggleDefaults() }),
    recordWin: (levelId, score, adventureIndex) => {
      const progress = get().progress;
      const best = Math.max(progress.best[levelId] ?? 0, score);
      persist({
        progress: {
          ...progress,
          best: { ...progress.best, [levelId]: best },
          cleared: { ...progress.cleared, [levelId]: true },
          unlocked: adventureIndex === null ? progress.unlocked : Math.min(55, Math.max(progress.unlocked, adventureIndex + 2)),
          totalScore: progress.totalScore + score,
        },
      });
    },
    setCurrent: (current) => persist({ progress: { ...get().progress, current: Math.min(54, Math.max(0, current)) } }),
    resetProgress: () => persist({ progress: emptySaipeggleProgress() }),
  };
});
