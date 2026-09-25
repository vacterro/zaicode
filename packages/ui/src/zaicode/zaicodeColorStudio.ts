import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import {
  ZAICODE_NO_ADJUST,
  adjustZaicodeTokens,
  normalizeZaicodeHex,
  type ZaicodeColorAdjust,
} from "./zaicodeColorMath.js";
import {
  ZAICODE_PALETTES,
  findZaicodePalette,
  paletteCssVariables,
  type ZaicodePalette,
  type ZaicodePaletteTokens,
} from "./zaicodePalettes.js";

/**
 * ZAICODE Color Studio (SRC-035 "Great Color Customizing"). One predictable
 * cascade, top wins:
 *
 *   base palette (built-in or the operator's own theme)
 *     -> whole-palette adjusters (hue, saturation, lightness, contrast)
 *       -> single-colour overrides of any app colour variable
 *
 * Own themes carry all 21 palette colours, can be duplicated from any palette,
 * renamed, deleted, exported and imported as JSON. Every change applies live
 * and can be undone.
 */

export interface ZaicodeCustomPalette extends ZaicodePalette {
  /** Palette it was made from (for "reset colour to base"). */
  base: string;
}

export interface ZaicodeColorStudio {
  customs: ZaicodeCustomPalette[];
  adjust: ZaicodeColorAdjust;
  /** App colour variable (`--color-*`, `--zaicode-*`) -> `#RRGGBB`. */
  overrides: Record<string, string>;
}

export const ZAICODE_COLOR_STUDIO_EVENT = "zaicode-color-studio-changed";
const STORAGE_KEY = "zaicode-color-studio-v1";
const CUSTOM_PREFIX = "custom-";
const MAX_CUSTOMS = 40;
const UNDO_DEPTH = 50;
const ADJUST_LIMITS: Record<keyof ZaicodeColorAdjust, number> = { hue: 180, saturation: 100, lightness: 50, contrast: 50 };

export const ZAICODE_TOKEN_KEYS = Object.keys(ZAICODE_PALETTES[0]!.tokens) as (keyof ZaicodePaletteTokens)[];

/** Palette colours, grouped and named for people (not for the code). */
export const ZAICODE_TOKEN_GROUPS: readonly { title: string; tokens: readonly { key: keyof ZaicodePaletteTokens; label: string; hint: string }[] }[] = [
  {
    title: "Surfaces",
    tokens: [
      { key: "background", label: "Window", hint: "Main background, sidebar, terminal" },
      { key: "backgroundSoft", label: "Panels", hint: "Headers, panels, tabs" },
      { key: "surface", label: "Cards", hint: "Cards, menus, popovers, tooltips" },
      { key: "surfaceRaised", label: "Raised / hover", hint: "Hovered rows, raised buttons" },
      { key: "surfaceAlt", label: "Selected", hint: "Selected rows and cards" },
      { key: "selection", label: "Selection", hint: "Selection backdrop" },
      { key: "compareBack", label: "Wells", hint: "Inputs, code wells" },
    ],
  },
  {
    title: "Borders",
    tokens: [
      { key: "borderMuted", label: "Border", hint: "Everyday borders and dividers" },
      { key: "bevelLight", label: "Bevel light", hint: "Hovered borders, 3D bevel light side" },
      { key: "borderDark", label: "Bevel dark", hint: "3D bevel dark side" },
      { key: "borderHighlight", label: "Highlight", hint: "Focus, active choice, ZAICODE accent" },
    ],
  },
  {
    title: "Text",
    tokens: [
      { key: "textPrimary", label: "Text", hint: "Main text, primary buttons" },
      { key: "textSecondary", label: "Secondary text", hint: "Labels, less important text" },
      { key: "textMuted", label: "Muted text", hint: "Hints, timestamps" },
      { key: "link", label: "Links", hint: "Links, tooltip tags" },
    ],
  },
  {
    title: "States & accents",
    tokens: [
      { key: "success", label: "Success", hint: "Done, healthy, quota full" },
      { key: "warning", label: "Warning", hint: "Pending, low quota" },
      { key: "danger", label: "Danger", hint: "Danger backgrounds" },
      { key: "dangerText", label: "Error text", hint: "Errors, blockers, destructive actions" },
      { key: "accentTeal", label: "Accent", hint: "Secondary accent" },
      { key: "accentTealDeep", label: "Accent deep", hint: "Accent fills" },
    ],
  },
];

/** Every app colour variable a palette sets; each can be overridden alone. */
export const ZAICODE_COLOR_VARIABLES: readonly string[] = Object.keys(paletteCssVariables(ZAICODE_PALETTES[0]!));

function clampAdjust(raw: unknown): ZaicodeColorAdjust {
  const value = (raw ?? {}) as Partial<Record<keyof ZaicodeColorAdjust, unknown>>;
  const next = { ...ZAICODE_NO_ADJUST };
  for (const key of Object.keys(ADJUST_LIMITS) as (keyof ZaicodeColorAdjust)[]) {
    const number = typeof value[key] === "number" && Number.isFinite(value[key]) ? Math.round(value[key] as number) : 0;
    next[key] = Math.max(-ADJUST_LIMITS[key], Math.min(ADJUST_LIMITS[key], number));
  }
  return next;
}

function cleanTokens(raw: unknown, fallback: ZaicodePaletteTokens): ZaicodePaletteTokens {
  const value = (raw ?? {}) as Record<string, unknown>;
  const tokens = { ...fallback };
  for (const key of ZAICODE_TOKEN_KEYS) tokens[key] = normalizeZaicodeHex(value[key]) ?? fallback[key];
  return tokens;
}

function cleanLabel(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 40) : fallback;
}

export function normalizeZaicodeColorStudio(raw: unknown): ZaicodeColorStudio {
  const value = (raw ?? {}) as { customs?: unknown; adjust?: unknown; overrides?: unknown };
  const seen = new Set<string>();
  const customs = (Array.isArray(value.customs) ? value.customs : []).flatMap((row): ZaicodeCustomPalette[] => {
    const entry = (row ?? {}) as Record<string, unknown>;
    if (typeof entry.slug !== "string" || !entry.slug.startsWith(CUSTOM_PREFIX) || seen.has(entry.slug)) return [];
    seen.add(entry.slug);
    const base = typeof entry.base === "string" && findZaicodePalette(entry.base) ? entry.base : ZAICODE_PALETTES[0]!.slug;
    return [{ slug: entry.slug, label: cleanLabel(entry.label, "My theme"), base, tokens: cleanTokens(entry.tokens, findZaicodePalette(base)!.tokens) }];
  });
  const overrides: Record<string, string> = {};
  for (const [name, color] of Object.entries((value.overrides ?? {}) as Record<string, unknown>)) {
    const hex = normalizeZaicodeHex(color);
    if (hex && ZAICODE_COLOR_VARIABLES.includes(name)) overrides[name] = hex;
  }
  return { customs: customs.slice(0, MAX_CUSTOMS), adjust: clampAdjust(value.adjust), overrides };
}

let cached: ZaicodeColorStudio | null = null;
const undoStack: ZaicodeColorStudio[] = [];

export function readZaicodeColorStudio(): ZaicodeColorStudio {
  if (cached) return cached;
  try {
    const raw = readZaicodeSetting(STORAGE_KEY);
    cached = normalizeZaicodeColorStudio(raw ? JSON.parse(raw) : null);
  } catch {
    cached = normalizeZaicodeColorStudio(null);
  }
  return cached;
}

function write(next: ZaicodeColorStudio, remember = true): void {
  if (remember && cached) {
    undoStack.push(cached);
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
  }
  cached = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // applies for this session anyway
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ZAICODE_COLOR_STUDIO_EVENT));
}

export function useZaicodeColorStudio(): ZaicodeColorStudio {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener(ZAICODE_COLOR_STUDIO_EVENT, listener);
      return () => window.removeEventListener(ZAICODE_COLOR_STUDIO_EVENT, listener);
    },
    readZaicodeColorStudio,
    readZaicodeColorStudio,
  );
}

export function canUndoZaicodeColors(): boolean {
  return undoStack.length > 0;
}

export function undoZaicodeColors(): void {
  const previous = undoStack.pop();
  if (previous) write(previous, false);
}

/** Built-in palette or one of the operator's own themes. */
export function findAnyZaicodePalette(slug: string | null | undefined): ZaicodePalette | null {
  if (!slug) return null;
  return findZaicodePalette(slug) ?? readZaicodeColorStudio().customs.find((custom) => custom.slug === slug) ?? null;
}

export function isZaicodeCustomPalette(slug: string): boolean {
  return slug.startsWith(CUSTOM_PREFIX);
}

/** A new own theme copied from `fromSlug` (built-in or own); returns its slug. */
export function createZaicodeCustomPalette(fromSlug: string, label?: string, tokens?: ZaicodePaletteTokens): string | null {
  const source = findAnyZaicodePalette(fromSlug);
  if (!source) return null;
  const studio = readZaicodeColorStudio();
  if (studio.customs.length >= MAX_CUSTOMS) return null;
  const slug = `${CUSTOM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const base = (source as Partial<ZaicodeCustomPalette>).base ?? source.slug;
  const custom: ZaicodeCustomPalette = {
    slug,
    label: cleanLabel(label, `${source.label} (mine)`),
    base,
    tokens: { ...(tokens ?? source.tokens) },
  };
  write({ ...studio, customs: [...studio.customs, custom] });
  return slug;
}

function updateCustom(slug: string, change: (custom: ZaicodeCustomPalette) => ZaicodeCustomPalette): void {
  const studio = readZaicodeColorStudio();
  if (!studio.customs.some((custom) => custom.slug === slug)) return;
  write({ ...studio, customs: studio.customs.map((custom) => (custom.slug === slug ? change(custom) : custom)) });
}

export function renameZaicodeCustomPalette(slug: string, label: string): void {
  updateCustom(slug, (custom) => ({ ...custom, label: cleanLabel(label, custom.label) }));
}

export function setZaicodeCustomToken(slug: string, key: keyof ZaicodePaletteTokens, color: string): void {
  const hex = normalizeZaicodeHex(color);
  if (hex) updateCustom(slug, (custom) => ({ ...custom, tokens: { ...custom.tokens, [key]: hex } }));
}

/** Back to the colour of the palette this theme was made from. */
export function resetZaicodeCustomToken(slug: string, key: keyof ZaicodePaletteTokens): void {
  updateCustom(slug, (custom) => ({ ...custom, tokens: { ...custom.tokens, [key]: findZaicodePalette(custom.base)!.tokens[key] } }));
}

export function replaceZaicodeCustomTokens(slug: string, tokens: ZaicodePaletteTokens): void {
  updateCustom(slug, (custom) => ({ ...custom, tokens: cleanTokens(tokens, custom.tokens) }));
}

export function deleteZaicodeCustomPalette(slug: string): void {
  const studio = readZaicodeColorStudio();
  write({ ...studio, customs: studio.customs.filter((custom) => custom.slug !== slug) });
}

export function setZaicodeColorAdjust(patch: Partial<ZaicodeColorAdjust>): void {
  const studio = readZaicodeColorStudio();
  write({ ...studio, adjust: clampAdjust({ ...studio.adjust, ...patch }) });
}

export function setZaicodeColorOverride(name: string, color: string | null): void {
  if (!ZAICODE_COLOR_VARIABLES.includes(name)) return;
  const studio = readZaicodeColorStudio();
  const overrides = { ...studio.overrides };
  const hex = color === null ? null : normalizeZaicodeHex(color);
  if (hex) overrides[name] = hex;
  else delete overrides[name];
  write({ ...studio, overrides });
}

export function resetZaicodeColorStudioLayer(layer: "adjust" | "overrides"): void {
  const studio = readZaicodeColorStudio();
  write(layer === "adjust" ? { ...studio, adjust: { ...ZAICODE_NO_ADJUST } } : { ...studio, overrides: {} });
}

/** The variables the app gets: palette (adjusted) then single overrides. Null palette = upstream colours + overrides. */
export function zaicodeEffectiveColorVariables(palette: ZaicodePalette | null, studio: ZaicodeColorStudio): Record<string, string> {
  const base = palette ? paletteCssVariables({ ...palette, tokens: adjustZaicodeTokens(palette.tokens, studio.adjust) }) : {};
  return { ...base, ...studio.overrides };
}

export function zaicodeAdjustedPalette(palette: ZaicodePalette, studio: ZaicodeColorStudio = readZaicodeColorStudio()): ZaicodePalette {
  return { ...palette, tokens: adjustZaicodeTokens(palette.tokens, studio.adjust) };
}

/** Shareable JSON of one palette (built-in or own). */
export function exportZaicodePalette(slug: string): string | null {
  const palette = findAnyZaicodePalette(slug);
  return palette ? JSON.stringify({ zaicodeTheme: 1, label: palette.label, tokens: palette.tokens }, null, 2) : null;
}

/** Imports a theme JSON (from Export, or a bare token map); returns the new theme's slug or an error. */
export function importZaicodePalette(json: string): { slug: string } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { error: "This is not JSON." };
  }
  const value = (parsed ?? {}) as { label?: unknown; tokens?: unknown };
  const tokens = (value.tokens ?? parsed) as Record<string, unknown>;
  const known = ZAICODE_TOKEN_KEYS.filter((key) => normalizeZaicodeHex(tokens?.[key]));
  if (known.length === 0) return { error: "No palette colours found (expected keys like background, textPrimary)." };
  const base = ZAICODE_PALETTES[0]!;
  const slug = createZaicodeCustomPalette(base.slug, cleanLabel(value.label, "Imported theme"), cleanTokens(tokens, base.tokens));
  return slug ? { slug } : { error: `At most ${MAX_CUSTOMS} own themes.` };
}
