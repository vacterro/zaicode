import { zaicodeSessionTextDefaults, type ZaicodeSessionTextPrefs } from "./zaicodeSessionTextModel.js";
import { normalizeZaicodeSessionText } from "./zaicodeSessionTextNormalize.js";

/**
 * Session-text presets (SRC-062): a whole look in one click. Built-in ones are
 * patches over "as the app"; own ones are complete settings the operator saved,
 * and both export / import as a JSON file.
 */

type Patch = { [key: string]: unknown };

export interface ZaicodeSessionTextPreset {
  id: string;
  name: string;
  hint: string;
  builtIn: boolean;
  prefs: ZaicodeSessionTextPrefs;
}

function merge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out: Patch = { ...(base && typeof base === "object" ? (base as Patch) : {}) };
  for (const [key, value] of Object.entries(patch as Patch)) out[key] = merge(out[key], value);
  return out;
}

export function applyZaicodeSessionTextPatch(base: ZaicodeSessionTextPrefs, patch: Patch): ZaicodeSessionTextPrefs {
  return normalizeZaicodeSessionText(merge(base, patch));
}

const headings = (patch: Patch, levels: readonly string[] = ["h1", "h2", "h3", "h4", "h5", "h6"]) =>
  Object.fromEntries(levels.map((level) => [level, patch]));

const BUILT_IN: readonly { id: string; name: string; hint: string; patch: Patch }[] = [
  { id: "app", name: "As the app", hint: "Nothing changed: the ZAICODE look", patch: {} },
  {
    id: "word",
    name: "Word document",
    hint: "Calibri body, blue Cambria headings, a rule under Heading 1, numbered sections",
    patch: {
      numberHeadings: true,
      body: { font: "calibri", sizePx: 15, lineHeight: 1.5, marginBottom: 10 },
      headings: {
        ...headings({ font: "cambria", color: "#4f81bd", weight: 700 }),
        h1: { font: "cambria", color: "#365f91", sizePx: 24, weight: 700, rule: "under", ruleColor: "#4f81bd", marginTop: 18, marginBottom: 8 },
        h2: { font: "cambria", color: "#4f81bd", sizePx: 19, weight: 700, marginTop: 14, marginBottom: 6 },
        h3: { font: "cambria", color: "#4f81bd", sizePx: 16, weight: 700, marginTop: 12, marginBottom: 4 },
      },
      strong: { weight: 700 },
      link: { color: "#0563c1", underline: "always" },
      table: { borderColor: "#8eaadb", headerBackground: "#d9e2f3", zebra: true, cellPaddingPx: 4 },
      quote: { italic: "on", barColor: "#4f81bd", barWidthPx: 3, indentPx: 12 },
    },
  },
  {
    id: "book",
    name: "Book",
    hint: "Serif, justified, first-line indent, small-caps headings, calm links",
    patch: {
      body: { font: "georgia", sizePx: 16, lineHeight: 1.7, align: "justify", indentPx: 24, hyphens: true, maxWidthCh: 80, marginBottom: 4 },
      headings: headings({ font: "garamond", textCase: "small-caps", weight: 600, letterSpacing: 4 }),
      em: { italic: "on" },
      link: { underline: "hover" },
      quote: { italic: "on", barWidthPx: 0, indentPx: 32 },
      rule: { style: "double", thicknessPx: 3, marginPx: 20 },
    },
  },
  {
    id: "typewriter",
    name: "Typewriter",
    hint: "Courier everywhere, underlined capital headings, bold is underlined too",
    patch: {
      body: { font: "courier", sizePx: 15, lineHeight: 1.6 },
      headings: headings({ font: "courier", textCase: "uppercase", decoration: "solid", weight: 700, underlineOffset: 3 }),
      strong: { decoration: "solid", weight: 700 },
      list: { bullet: "–" },
      rule: { style: "dashed", thicknessPx: 1 },
    },
  },
  {
    id: "terminal",
    name: "Terminal",
    hint: "Bitmap Terminus, green prompt-like headings, ▸ bullets",
    patch: {
      body: { font: "terminus", sizePx: 16, lineHeight: 1.45 },
      headings: headings({ font: "terminus", color: "#7fc35a", textCase: "uppercase", weight: 700 }),
      strong: { color: "#e8d27a", weight: 700 },
      inlineCode: { color: "#7fc35a", background: "#101010", border: "#2d4d20", paddingPx: 3 },
      list: { bullet: "▸", markerColor: "#7fc35a" },
      link: { color: "#5fb3e8", underline: "always", decoration: "dotted" },
    },
  },
  {
    id: "pixel",
    name: "Pixel (FastPrompter)",
    hint: "Verdana m1 bitmap text, bars before headings, ■ bullets, no smoothing anywhere",
    patch: {
      body: { font: "verdana", sizePx: 13, lineHeight: 1.6 },
      headings: headings({ font: "verdana", weight: 700, rule: "bar", ruleColor: "#d3b57a", textCase: "uppercase", letterSpacing: 6 }),
      list: { bullet: "■", markerColor: "#d3b57a" },
      strong: { color: "#e2ca95", weight: 700 },
      quote: { barColor: "#d3b57a", barWidthPx: 2 },
      rule: { style: "dotted", color: "#665033", thicknessPx: 2 },
    },
  },
  {
    id: "highlighter",
    name: "Highlighter",
    hint: "What the agent stresses gets a marker behind it; links wavy-underlined",
    patch: {
      strong: { background: "#5a4a10", color: "#ffe38a", weight: 700 },
      em: { background: "#20304a", italic: "on" },
      del: { color: "#b05050", decoration: "solid", decorationColor: "#b05050" },
      link: { decoration: "wavy", underline: "always" },
      headings: headings({ rule: "band", ruleColor: "#2b2111" }, ["h1", "h2"]),
    },
  },
  {
    id: "large",
    name: "Large print",
    hint: "Big, airy text for long reading",
    patch: {
      body: { sizePx: 19, lineHeight: 1.9, maxWidthCh: 90, marginBottom: 14 },
      headings: { h1: { sizePx: 30 }, h2: { sizePx: 25 }, h3: { sizePx: 21 } },
      list: { gapPx: 8 },
    },
  },
  {
    id: "compact",
    name: "Compact",
    hint: "Small and dense: more of the answer on screen",
    patch: {
      body: { sizePx: 12, lineHeight: 1.35, marginBottom: 4 },
      headings: { ...headings({ marginTop: 8, marginBottom: 4 }), h1: { sizePx: 16, marginTop: 8, marginBottom: 4 }, h2: { sizePx: 14, marginTop: 8, marginBottom: 4 } },
      list: { gapPx: 0, indentPx: 14 },
      table: { cellPaddingPx: 2 },
    },
  },
];

export const ZAICODE_SESSION_TEXT_BUILT_INS: readonly ZaicodeSessionTextPreset[] = BUILT_IN.map((preset) => ({
  id: preset.id,
  name: preset.name,
  hint: preset.hint,
  builtIn: true,
  prefs: applyZaicodeSessionTextPatch(zaicodeSessionTextDefaults(), preset.patch),
}));

const EXPORT_KIND = "zaicode-session-text-presets";

export function normalizeZaicodeSessionTextPresets(raw: unknown): ZaicodeSessionTextPreset[] {
  if (!Array.isArray(raw)) return [];
  const builtInIds = new Set(ZAICODE_SESSION_TEXT_BUILT_INS.map((preset) => preset.id));
  const out: ZaicodeSessionTextPreset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { id?: unknown; name?: unknown; hint?: unknown; prefs?: unknown };
    if (typeof value.id !== "string" || !value.id || builtInIds.has(value.id)) continue;
    if (typeof value.name !== "string" || !value.name.trim()) continue;
    if (out.some((preset) => preset.id === value.id)) continue;
    out.push({
      id: value.id.slice(0, 64),
      name: value.name.trim().slice(0, 48),
      hint: typeof value.hint === "string" ? value.hint.slice(0, 160) : "",
      builtIn: false,
      prefs: normalizeZaicodeSessionText(value.prefs),
    });
  }
  return out;
}

export function exportZaicodeSessionTextPresets(presets: readonly ZaicodeSessionTextPreset[]): string {
  return JSON.stringify({ kind: EXPORT_KIND, version: 1, presets: presets.filter((preset) => !preset.builtIn) }, null, 2);
}

/** A file from another machine: its presets get fresh ids so nothing of ours is overwritten. */
export function parseZaicodeSessionTextPresets(text: string, taken: readonly string[]): ZaicodeSessionTextPreset[] {
  const data = JSON.parse(text) as { kind?: unknown; presets?: unknown };
  if (data.kind !== EXPORT_KIND) throw new Error("This file is not a ZAICODE session-text preset file.");
  const names = new Set(taken);
  return normalizeZaicodeSessionTextPresets(data.presets).map((preset, index) => {
    let name = preset.name;
    for (let n = 2; names.has(name); n += 1) name = `${preset.name} (${n})`;
    names.add(name);
    return { ...preset, id: `own-${Date.now().toString(36)}-${index}`, name };
  });
}
