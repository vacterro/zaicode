import { normalizeZaicodeSessionText } from "./zaicodeSessionTextNormalize.js";
import { zaicodeSessionTextDefaults, type ZaicodeSessionTextPrefs } from "./zaicodeSessionTextModel.js";
import { normalizeZaicodeSessionTextPresets, type ZaicodeSessionTextPreset } from "./zaicodeSessionTextPresets.js";

/**
 * The exported Session-text artifact (SRC-062, Wave 2): ONE versioned file
 * holding every supported setting, so Save/Export/Import has a single model
 * instead of a preset-shaped half of it.
 *
 * Import is total: it either returns a complete, normalized, ready-to-apply
 * document or throws. Nothing is written anywhere on the way, so a bad file
 * cannot leave half of itself applied.
 */

export const ZAICODE_SESSION_TEXT_DOCUMENT_KIND = "zaicode.session-text";
export const ZAICODE_SESSION_TEXT_DOCUMENT_VERSION = 1;

export interface ZaicodeSessionTextDocument {
  kind: typeof ZAICODE_SESSION_TEXT_DOCUMENT_KIND;
  version: number;
  exportedAt: string;
  prefs: ZaicodeSessionTextPrefs;
  presets: ZaicodeSessionTextPreset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function exportZaicodeSessionTextDocument(
  prefs: ZaicodeSessionTextPrefs,
  presets: readonly ZaicodeSessionTextPreset[],
  now: Date = new Date(),
): string {
  const document_: ZaicodeSessionTextDocument = {
    kind: ZAICODE_SESSION_TEXT_DOCUMENT_KIND,
    version: ZAICODE_SESSION_TEXT_DOCUMENT_VERSION,
    exportedAt: now.toISOString(),
    prefs: normalizeZaicodeSessionText(prefs),
    presets: normalizeZaicodeSessionTextPresets(presets.filter((preset) => !preset.builtIn)),
  };
  return `${JSON.stringify(document_, null, 2)}\n`;
}

/** Throws with an operator-readable reason. Returns only a complete document. */
export function parseZaicodeSessionTextDocument(text: string): ZaicodeSessionTextDocument {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not a readable JSON file: nothing was changed.");
  }
  if (!isRecord(data)) throw new Error("Not a ZAICODE session-text file: nothing was changed.");
  if (data.kind !== ZAICODE_SESSION_TEXT_DOCUMENT_KIND) {
    throw new Error(`This file is not a ZAICODE session-text file (kind: ${String(data.kind ?? "missing")}). Nothing was changed.`);
  }
  const version = typeof data.version === "number" ? data.version : Number.NaN;
  if (version !== ZAICODE_SESSION_TEXT_DOCUMENT_VERSION) {
    throw new Error(`Version ${String(data.version)} is not version ${ZAICODE_SESSION_TEXT_DOCUMENT_VERSION} of this file. Nothing was changed.`);
  }
  if (!isRecord(data.prefs)) throw new Error("The file has no settings in it. Nothing was changed.");
  if (data.presets !== undefined && !Array.isArray(data.presets)) {
    throw new Error("The file's preset list is not a list. Nothing was changed.");
  }
  return {
    kind: ZAICODE_SESSION_TEXT_DOCUMENT_KIND,
    version,
    exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : "",
    prefs: normalizeZaicodeSessionText(data.prefs),
    presets: normalizeZaicodeSessionTextPresets(data.presets),
  };
}

/**
 * What an import would replace, in words, BEFORE it replaces it. The operator
 * sees this in the confirmation; an import that says nothing about what it
 * overwrites is the defect Wave 2 was written about.
 */
export function describeZaicodeSessionTextDocument(document_: ZaicodeSessionTextDocument): string {
  const exported = document_.exportedAt ? new Date(document_.exportedAt) : null;
  const when = exported && !Number.isNaN(exported.getTime()) ? exported.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "an unknown date";
  const lines = [
    `Session text settings from ${when}.`,
    `Your messages: ${document_.prefs.userMessage.mode === "separate" ? "their own style" : "following the shared theme"}.`,
    `Presets in the file: ${document_.presets.length}.`,
    `Importing REPLACES your current Session text settings (${document_.presets.length} preset(s) from the file replace your own) and cannot be undone from here. Export first if you want to keep the current ones.`,
  ];
  return lines.join("\n");
}

/** Deep value equality on the normalized shape; the dirty flag must not lie about a no-op edit. */
export function sameZaicodeSessionText(left: ZaicodeSessionTextPrefs, right: ZaicodeSessionTextPrefs): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The "Default" button: back to the app's own look, which is also what an empty import yields. */
export function resetZaicodeSessionText(): ZaicodeSessionTextPrefs {
  return zaicodeSessionTextDefaults();
}
