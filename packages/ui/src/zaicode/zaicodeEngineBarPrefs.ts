import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * What the sidebar engine bar shows (SRC-061: "simpler, not so loud, and
 * full control over which models show"). Only the pools the operator picked
 * appear as buttons; by default that is SAIFREN and SAIOPP, the two pools
 * ZAICODE itself manages. Everything else stays one right-click away.
 */

export interface ZaicodeEngineBarPrefs {
  /** Model ids of the SAIRoute provider shown as buttons, in order; null = the defaults. */
  pools: string[] | null;
  /** The subscription tiles row. */
  showSubs: boolean;
}

export const ZAICODE_ENGINE_BAR_DEFAULT_POOLS: readonly string[] = ["SAIFREN", "SAIOPP"];
export const ZAICODE_ENGINE_BAR_MAX_POOLS = 4;

export function normalizeZaicodeEngineBarPrefs(raw: unknown): ZaicodeEngineBarPrefs {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pools = Array.isArray(record.pools)
    ? [...new Set(record.pools.filter((id): id is string => typeof id === "string" && id.trim().length > 0))].slice(
        0,
        ZAICODE_ENGINE_BAR_MAX_POOLS,
      )
    : null;
  return { pools, showSubs: record.showSubs !== false };
}

/**
 * The pool buttons to draw, from what the router offers: the operator's own
 * list when set (models that disappeared are skipped), else the defaults that
 * exist, else the first two offered.
 */
export function zaicodeEngineBarPools<T extends { modelId: string }>(
  options: readonly T[],
  prefs: Pick<ZaicodeEngineBarPrefs, "pools">,
): T[] {
  const byId = new Map(options.map((option) => [option.modelId, option]));
  if (prefs.pools) return prefs.pools.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const defaults = ZAICODE_ENGINE_BAR_DEFAULT_POOLS.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  return defaults.length > 0 ? defaults : options.slice(0, 2);
}

/** A button label: the model without its route prefix ("ag/claude-opus" -> "claude-opus"). */
export function zaicodeEngineBarLabel(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

const STORAGE_KEY = "zaicode-engine-bar-v1";

interface ZaicodeEngineBarStore extends ZaicodeEngineBarPrefs {
  update: (patch: Partial<ZaicodeEngineBarPrefs>) => void;
}

export const useZaicodeEngineBarPrefs = create<ZaicodeEngineBarStore>((set, get) => {
  let initial: ZaicodeEngineBarPrefs;
  try {
    initial = normalizeZaicodeEngineBarPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    initial = normalizeZaicodeEngineBarPrefs(null);
  }
  return {
    ...initial,
    update: (patch) => {
      const { update: _update, ...current } = get();
      const next = normalizeZaicodeEngineBarPrefs({ ...current, ...patch });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // this window only
      }
      set(next);
    },
  };
});
