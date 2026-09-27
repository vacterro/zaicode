import { create } from "zustand";
import { readZaicodeSetting } from "../zaicodeSettingsSnapshot.js";
import { protrailDefaults, type ProtrailClickConfig, type ProtrailConfig, type ProtrailTrailConfig } from "./protrailModel.js";
import { normalizeProtrailConfig } from "./protrailNormalize.js";

/**
 * ProTrail settings in ZAICODE: stored like every ZAICODE preference (and part
 * of a profile), normalized on every write the way ProTrail validates its
 * config.json. "Restore defaults" per domain (Trail, Click) and for all, as in
 * the native app.
 */

const STORAGE_KEY = "zaicode-protrail-v1";

function load(): ProtrailConfig {
  try {
    return normalizeProtrailConfig(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return protrailDefaults();
  }
}

interface ProtrailStore {
  config: ProtrailConfig;
  set: (patch: Partial<Omit<ProtrailConfig, "trail" | "click">>) => void;
  setTrail: (patch: Partial<ProtrailTrailConfig>) => void;
  setClick: (patch: Partial<ProtrailClickConfig>) => void;
  resetTrail: () => void;
  resetClick: () => void;
  resetAll: () => void;
}

export const useZaicodeProtrail = create<ProtrailStore>((set, get) => {
  const persist = (next: ProtrailConfig) => {
    const config = normalizeProtrailConfig(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch {
      // applies for this window anyway
    }
    set({ config });
  };
  return {
    config: load(),
    set: (patch) => persist({ ...get().config, ...patch }),
    setTrail: (patch) => persist({ ...get().config, trail: { ...get().config.trail, ...patch } }),
    setClick: (patch) => persist({ ...get().config, click: { ...get().config.click, ...patch } }),
    resetTrail: () => persist({ ...get().config, trail: protrailDefaults().trail }),
    resetClick: () => persist({ ...get().config, click: protrailDefaults().click }),
    resetAll: () => persist(protrailDefaults()),
  };
});
