import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Storage key and user preferences for composer toolbar model quick buttons.
 * Keeps quick-button presentation visibility separate from provider configuration
 * and from the 8-model engine-bar preferences (zaicode-engine-bar-v1).
 */
export const ZAICODE_COMPOSER_MODEL_BUTTONS_STORAGE_KEY = "zaicode-composer-model-buttons-v1";

export interface ZaicodeComposerModelButtonsPrefs {
  /** Array of model values that the user has hidden. null = default (show all eligible). */
  hiddenButtons: string[] | null;
}

export function normalizeZaicodeComposerModelButtonsPrefs(
  raw: unknown,
): ZaicodeComposerModelButtonsPrefs {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const hiddenButtons = Array.isArray(record.hiddenButtons)
    ? [
        ...new Set(
          record.hiddenButtons.filter(
            (v): v is string => typeof v === "string" && v.trim().length > 0,
          ),
        ),
      ]
    : null;
  return { hiddenButtons };
}

interface ZaicodeComposerModelButtonsStore extends ZaicodeComposerModelButtonsPrefs {
  update: (patch: Partial<ZaicodeComposerModelButtonsPrefs>) => void;
  toggleButton: (value: string, show: boolean) => void;
  reset: () => void;
}

export const useZaicodeComposerModelButtonsPrefs = create<ZaicodeComposerModelButtonsStore>(
  (set, get) => {
    let initial: ZaicodeComposerModelButtonsPrefs;
    try {
      initial = normalizeZaicodeComposerModelButtonsPrefs(
        JSON.parse(readZaicodeSetting(ZAICODE_COMPOSER_MODEL_BUTTONS_STORAGE_KEY) ?? "null"),
      );
    } catch {
      initial = normalizeZaicodeComposerModelButtonsPrefs(null);
    }
    return {
      ...initial,
      update: (patch) => {
        const { update: _u, toggleButton: _t, reset: _r, ...current } = get();
        const next = normalizeZaicodeComposerModelButtonsPrefs({ ...current, ...patch });
        try {
          localStorage.setItem(
            ZAICODE_COMPOSER_MODEL_BUTTONS_STORAGE_KEY,
            JSON.stringify(next),
          );
        } catch {
          // localStorage may be unavailable in tests or sandbox
        }
        set(next);
      },
      toggleButton: (value: string, show: boolean) => {
        const current = get().hiddenButtons ?? [];
        const nextHidden = show
          ? current.filter((v) => v !== value)
          : [...new Set([...current, value])];
        get().update({ hiddenButtons: nextHidden.length > 0 ? nextHidden : null });
      },
      reset: () => {
        get().update({ hiddenButtons: null });
      },
    };
  },
);
