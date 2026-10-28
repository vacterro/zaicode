import { create } from "zustand";
import { isZaicodeProductMode } from "@zcode/shared";
import { zaicodeSessionTextDefaults, type ZaicodeSessionTextPrefs } from "./zaicodeSessionTextModel.js";
import { normalizeZaicodeSessionText } from "./zaicodeSessionTextNormalize.js";
import { zaicodeAllSessionTextCss } from "./zaicodeSessionTextCss.js";
import { normalizeZaicodeSessionTextPresets, type ZaicodeSessionTextPreset } from "./zaicodeSessionTextPresets.js";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import {
  exportZaicodeSessionTextDocument,
  parseZaicodeSessionTextDocument,
  sameZaicodeSessionText,
  type ZaicodeSessionTextDocument,
} from "./zaicodeSessionTextDocument.js";

/**
 * Session text (SRC-062), the live side: the operator's settings, stored like
 * every ZAICODE preference and part of a profile, turned into one <style>
 * element and the `zaicode-session-text` class on <html>. An agent answer's
 * markdown root carries `zaicode-md` and the operator's own bubble carries
 * `data-v4-user-input-bubble`, so one stylesheet paints both, live, in every
 * open session, without a reload.
 *
 * Wave 2: what is stored and what is being edited are now two values. `prefs`
 * is the SAVED one; `draft` is what the settings screen is holding. An edit
 * shows at once (so the sample answer moves under the operator's hand) but
 * only `save` persists it, and save reports success or the reason it failed.
 * Reopening Settings therefore reads the saved value, never a stale component.
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

/** Returns the failure instead of swallowing it: Save has to be able to say it failed. */
function write(key: string, value: unknown): { ok: true } | { ok: false; error: string } {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "storage refused the write" };
  }
}

/** Puts the stylesheet in place (or removes it). Safe to call again with the same settings. */
export function applyZaicodeSessionText(prefs: ZaicodeSessionTextPrefs): void {
  if (typeof document === "undefined") return;
  const css = isZaicodeProductMode() ? zaicodeAllSessionTextCss(prefs) : "";
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

export interface ZaicodeSaveResult {
  ok: boolean;
  /** True when there was nothing to save. */
  unchanged: boolean;
  error: string;
}

export interface ZaicodeImportResult {
  ok: boolean;
  error: string;
  /** What the operator was told before confirming, verbatim. */
  description: string;
}

interface ZaicodeSessionTextState {
  /** The saved settings: what the app runs on and what a reopen reads. */
  prefs: ZaicodeSessionTextPrefs;
  /** Unsaved edits, or null. Shown live, persisted only by `save`. */
  draft: ZaicodeSessionTextPrefs | null;
  presets: ZaicodeSessionTextPreset[];
  /** The preset last applied, while nothing was changed after it. */
  activePresetId: string | null;
  /** An edit that differs from what is stored. */
  dirty: boolean;
  /** Edits the settings screen is holding (draft when dirty, else the saved value). */
  editing: ZaicodeSessionTextPrefs;
  edit: (prefs: ZaicodeSessionTextPrefs, presetId?: string | null) => void;
  save: () => ZaicodeSaveResult;
  discard: () => void;
  set: (prefs: ZaicodeSessionTextPrefs, presetId?: string | null) => void;
  reset: () => void;
  exportDocument: () => string;
  /** Validates, then replaces everything at once; a bad file changes nothing. */
  importDocument: (text: string) => ZaicodeImportResult;
  savePreset: (name: string) => void;
  deletePreset: (id: string) => void;
  renamePreset: (id: string, name: string) => void;
  addPresets: (presets: readonly ZaicodeSessionTextPreset[]) => void;
}

const initial = normalizeZaicodeSessionText(readJson(STORAGE_KEY));

export const useZaicodeSessionText = create<ZaicodeSessionTextState>((set, get) => {
  const persistPresets = (presets: ZaicodeSessionTextPreset[]) => {
    const written = write(PRESETS_KEY, presets);
    if (written.ok) set({ presets });
    return written;
  };
  const settle = (patch: Partial<ZaicodeSessionTextState> & { prefs: ZaicodeSessionTextPrefs; draft: ZaicodeSessionTextPrefs | null }) => {
    const dirty = patch.draft !== null && !sameZaicodeSessionText(patch.draft, patch.prefs);
    set({ ...patch, dirty, editing: dirty ? patch.draft! : patch.prefs });
  };
  return {
    prefs: initial,
    draft: null,
    presets: normalizeZaicodeSessionTextPresets(readJson(PRESETS_KEY)),
    activePresetId: null,
    dirty: false,
    editing: initial,
    edit: (prefs, presetId = null) => {
      const next = normalizeZaicodeSessionText(prefs);
      applyZaicodeSessionText(next);
      settle({ prefs: get().prefs, draft: next, activePresetId: presetId });
    },
    save: () => {
      const { draft, prefs } = get();
      if (draft === null || sameZaicodeSessionText(draft, prefs)) {
        return { ok: true, unchanged: true, error: "" };
      }
      const written = write(STORAGE_KEY, draft);
      if (!written.ok) return { ok: false, unchanged: false, error: written.error };
      applyZaicodeSessionText(draft);
      settle({ prefs: draft, draft: null });
      return { ok: true, unchanged: false, error: "" };
    },
    discard: () => {
      applyZaicodeSessionText(get().prefs);
      settle({ prefs: get().prefs, draft: null });
    },
    set: (prefs, presetId = null) => {
      const next = normalizeZaicodeSessionText(prefs);
      write(STORAGE_KEY, next);
      applyZaicodeSessionText(next);
      settle({ prefs: next, draft: null, activePresetId: presetId });
    },
    reset: () => get().edit(zaicodeSessionTextDefaults(), "app"),
    exportDocument: () => exportZaicodeSessionTextDocument(get().editing, get().presets),
    importDocument: (text) => {
      let document_: ZaicodeSessionTextDocument;
      try {
        document_ = parseZaicodeSessionTextDocument(text);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), description: "" };
      }
      // Everything is validated; the two writes are the only mutation, and a
      // failed preset write leaves the settings write (the visible one) intact.
      const prefsWritten = write(STORAGE_KEY, document_.prefs);
      if (!prefsWritten.ok) return { ok: false, error: prefsWritten.error, description: "" };
      if (document_.presets.length > 0) write(PRESETS_KEY, document_.presets);
      applyZaicodeSessionText(document_.prefs);
      settle({ prefs: document_.prefs, draft: null, presets: document_.presets, activePresetId: null });
      return {
        ok: true,
        error: "",
        description: `Imported session text settings (${document_.presets.length} preset(s)).`,
      };
    },
    savePreset: (name) => {
      const clean = name.trim().slice(0, 48);
      if (!clean) return;
      const id = `own-${Date.now().toString(36)}`;
      persistPresets([...get().presets, { id, name: clean, hint: "", builtIn: false, prefs: get().editing }]);
      set({ activePresetId: id });
    },
    deletePreset: (id) => {
      persistPresets(get().presets.filter((preset) => preset.id !== id));
    },
    renamePreset: (id, name) => {
      persistPresets(get().presets.map((preset) => (preset.id === id ? { ...preset, name: name.trim().slice(0, 48) || preset.name } : preset)));
    },
    addPresets: (presets) => {
      persistPresets([...get().presets, ...presets]);
    },
  };
});

/** Called once at start-up (the app shell) so the stored look applies before the first answer renders. */
export function installZaicodeSessionText(): void {
  applyZaicodeSessionText(useZaicodeSessionText.getState().prefs);
}
