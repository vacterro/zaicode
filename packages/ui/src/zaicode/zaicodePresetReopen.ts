import { isZaicodePresetSection, type ZaicodePresetSectionId } from "./zaicodePresetSections.js";

/**
 * The mark a preset that reloads the window leaves for the window that comes back (T-125): which Settings page
 * to open again and what to say there. In sessionStorage, so it belongs to this window and dies with it.
 * Whatever is found there is not trusted: it has to name a page that has presets.
 */

export const ZAICODE_PRESET_REOPEN_KEY = "zaicode-preset-reopen";

export interface PresetReopen {
  section: ZaicodePresetSectionId;
  note: string;
}

export function markPresetReopen(store: Pick<Storage, "setItem">, marker: PresetReopen): void {
  store.setItem(ZAICODE_PRESET_REOPEN_KEY, JSON.stringify(marker));
}

/** Reads and clears the mark; null when there is none or it does not name a page with presets. */
export function takePresetReopen(store: Pick<Storage, "getItem" | "removeItem">): PresetReopen | null {
  const raw = store.getItem(ZAICODE_PRESET_REOPEN_KEY);
  if (raw === null) return null;
  store.removeItem(ZAICODE_PRESET_REOPEN_KEY);
  try {
    const parsed = JSON.parse(raw) as { section?: unknown; note?: unknown } | null;
    if (!parsed || typeof parsed.section !== "string" || !isZaicodePresetSection(parsed.section)) return null;
    return { section: parsed.section, note: typeof parsed.note === "string" && parsed.note ? parsed.note.slice(0, 300) : "Preset applied" };
  } catch {
    return null;
  }
}
