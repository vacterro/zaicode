import { create } from "zustand";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * The message box (SRC-038): most of the work happens there, so every part
 * of it can be hidden, and one button folds the SAIPEN strip into a single
 * row of small square buttons with icons ("compact"). Renderer-local.
 */
export interface ZaicodeComposerPrefs {
  /** One row of square icon buttons instead of the full strip. */
  compact: boolean;
  /** Full strip parts. */
  showSlot: boolean;
  showModes: boolean;
  showPhase: boolean;
  showBoard: boolean;
  showNext: boolean;
  showThen: boolean;
  showLast: boolean;
  showBlocker: boolean;
  showEngineRoute: boolean;
  /** Compact row parts. */
  compactModes: boolean;
  compactPhase: boolean;
  /** One NEXT line under the compact row. */
  compactNext: boolean;
  /** Smaller padding and gaps around the message box while compact. */
  compactShell: boolean;
}

export const ZAICODE_COMPOSER_DEFAULT_PREFS: ZaicodeComposerPrefs = {
  compact: false,
  showSlot: true,
  showModes: true,
  showPhase: true,
  showBoard: true,
  showNext: true,
  showThen: true,
  showLast: true,
  showBlocker: true,
  showEngineRoute: true,
  compactModes: true,
  compactPhase: true,
  compactNext: false,
  compactShell: true,
};

/** What each switch is called in Settings and in the right-click panel, in strip order. */
export const ZAICODE_COMPOSER_PARTS: readonly { key: keyof ZaicodeComposerPrefs; label: string; hint: string; compact?: boolean }[] = [
  { key: "showSlot", label: "MAIN / SIDE badge", hint: "Which slot this session is" },
  { key: "showPhase", label: "Phase chip", hint: "SCOUT · T-49, tinted by the board state" },
  { key: "showBoard", label: "Board count", hint: "done / all tickets" },
  { key: "showModes", label: "MODES row", hint: "WIKI, TRANSL, TEST, AUDIT, HUNT, CLEAN, CREW" },
  { key: "showEngineRoute", label: "Engine route line", hint: "Where START goes when a subscription is picked on the sidebar" },
  { key: "showBlocker", label: "BLOCKER line", hint: "Shown only when SAIPEN names one" },
  { key: "showNext", label: "NEXT line", hint: "SAIPEN's next exact action" },
  { key: "showThen", label: "THEN line", hint: "The ticket after this one" },
  { key: "showLast", label: "LAST line", hint: "The last LOG event" },
  { key: "compactModes", label: "Mode squares", hint: "Compact: the MODES as small squares", compact: true },
  { key: "compactPhase", label: "Phase chip", hint: "Compact: the phase chip at the end of the row", compact: true },
  { key: "compactNext", label: "NEXT line", hint: "Compact: one NEXT line under the row", compact: true },
  { key: "compactShell", label: "Tight message box", hint: "Compact: less padding around the text and buttons", compact: true },
];

const STORAGE_KEY = "zaicode-composer-prefs-v1";

export function normalizeZaicodeComposerPrefs(raw: unknown): ZaicodeComposerPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ZaicodeComposerPrefs, unknown>>;
  const next = { ...ZAICODE_COMPOSER_DEFAULT_PREFS };
  for (const key of Object.keys(next) as (keyof ZaicodeComposerPrefs)[]) {
    if (typeof r[key] === "boolean") next[key] = r[key] as boolean;
  }
  return next;
}

function load(): ZaicodeComposerPrefs {
  try {
    return normalizeZaicodeComposerPrefs(JSON.parse(readZaicodeSetting(STORAGE_KEY) ?? "null"));
  } catch {
    return normalizeZaicodeComposerPrefs(null);
  }
}

interface ZaicodeComposerPrefsState extends ZaicodeComposerPrefs {
  update: (patch: Partial<ZaicodeComposerPrefs>) => void;
  reset: () => void;
}

export const useZaicodeComposerPrefs = create<ZaicodeComposerPrefsState>((set, get) => {
  const persist = (next: ZaicodeComposerPrefs) => {
    const normalized = normalizeZaicodeComposerPrefs(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // preference only
    }
    set(normalized);
  };
  return {
    ...load(),
    update: (patch) => {
      const current = get();
      const next = {} as ZaicodeComposerPrefs;
      for (const key of Object.keys(ZAICODE_COMPOSER_DEFAULT_PREFS) as (keyof ZaicodeComposerPrefs)[]) next[key] = current[key];
      persist({ ...next, ...patch });
    },
    reset: () => persist(ZAICODE_COMPOSER_DEFAULT_PREFS),
  };
});
