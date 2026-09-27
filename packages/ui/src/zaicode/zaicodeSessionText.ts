import { create } from "zustand";
import { isZaicodeProductMode } from "@zcode/shared";
import { zaicodeSessionTextDefaults, type ZaicodeSessionTextPrefs } from "./zaicodeSessionTextModel.js";
import { normalizeZaicodeSessionText } from "./zaicodeSessionTextNormalize.js";
import { zaicodeSessionTextCss } from "./zaicodeSessionTextCss.js";
import { normalizeZaicodeSessionTextPresets, type ZaicodeSessionTextPreset } from "./zaicodeSessionTextPresets.js";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";

/**
 * Session text (SRC-062), the live side: the operator's settings, stored like
 * every ZAICODE preference and part of a profile, turned into one <style>
 * element and the `zaicode-session-text` class on <html>. Every agent answer's
 * markdown root carries `zaicode-md`, so the change shows at once in every
 * open session, without a reload.
 */

const STORAGE_KEY = "zaicode-session-text-v1";
const PRESETS_KEY = "zaicode-session-text-presets-v1";
const STYLE_ID = "zaicode-session-text-css";
const HTML_CLASS = "zaicode-session-text";

function readJson(key: string): unknown {
  try {
    return JSON.parse(readZaicodeSetting(key) ?? "null");
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Applies for this window anyway.
  }
}

/** Puts the stylesheet in place (or removes it). Safe to call again with the same settings. */
export function applyZaicodeSessionText(prefs: ZaicodeSessionTextPrefs): void {
  if (typeof document === "undefined") return;
  const css = isZaicodeProductMode() ? zaicodeSessionTextCss(prefs) : "";
  document.documentElement.classList.toggle(HTML_CLASS, css.length > 0);
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
}

interface ZaicodeSessionTextState {
  prefs: ZaicodeSessionTextPrefs;
  presets: ZaicodeSessionTextPreset[];
  /** The preset last applied, while nothing was changed after it. */
  activePresetId: string | null;
  set: (prefs: ZaicodeSessionTextPrefs, presetId?: string | null) => void;
  reset: () => void;
  savePreset: (name: string) => void;
  deletePreset: (id: string) => void;
  renamePreset: (id: string, name: string) => void;
  addPresets: (presets: readonly ZaicodeSessionTextPreset[]) => void;
}

const initial = normalizeZaicodeSessionText(readJson(STORAGE_KEY));

export const useZaicodeSessionText = create<ZaicodeSessionTextState>((set, get) => {
  const persistPresets = (presets: ZaicodeSessionTextPreset[]) => {
    write(PRESETS_KEY, presets);
    set({ presets });
  };
  return {
    prefs: initial,
    presets: normalizeZaicodeSessionTextPresets(readJson(PRESETS_KEY)),
    activePresetId: null,
    set: (prefs, presetId = null) => {
      const next = normalizeZaicodeSessionText(prefs);
      write(STORAGE_KEY, next);
      applyZaicodeSessionText(next);
      set({ prefs: next, activePresetId: presetId });
    },
    reset: () => get().set(zaicodeSessionTextDefaults(), "app"),
    savePreset: (name) => {
      const clean = name.trim().slice(0, 48);
      if (!clean) return;
      const id = `own-${Date.now().toString(36)}`;
      persistPresets([...get().presets, { id, name: clean, hint: "", builtIn: false, prefs: get().prefs }]);
      set({ activePresetId: id });
    },
    deletePreset: (id) => persistPresets(get().presets.filter((preset) => preset.id !== id)),
    renamePreset: (id, name) =>
      persistPresets(get().presets.map((preset) => (preset.id === id ? { ...preset, name: name.trim().slice(0, 48) || preset.name } : preset))),
    addPresets: (presets) => persistPresets([...get().presets, ...presets]),
  };
});

/** Called once at start-up (the app shell) so the stored look applies before the first answer renders. */
export function installZaicodeSessionText(): void {
  applyZaicodeSessionText(useZaicodeSessionText.getState().prefs);
}
