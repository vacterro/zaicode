import { useSyncExternalStore } from "react";
import { readZaicodeSetting } from "./zaicodeSettingsSnapshot.js";
import { isZaicodeProductMode } from "@zcode/shared";
import {
  ZAICODE_CRISP_CSS,
  ZAICODE_DEFAULT_PALETTE,
  ZAICODE_PALETTE_NONE,
  isDarkPalette,
} from "./zaicodePalettes.js";
import {
  ZAICODE_COLOR_STUDIO_EVENT,
  findAnyZaicodePalette,
  readZaicodeColorStudio,
  zaicodeAdjustedPalette,
  zaicodeEffectiveColorVariables,
} from "./zaicodeColorStudio.js";

/**
 * ZAICODE appearance preferences (per machine, renderer-local):
 *   palette: a Wintage palette slug, or "none" for upstream colours;
 *   crisp:   pixel mode without antialiasing (default on).
 * Applied as a <style> element + classes on <html>; changes apply live.
 */
const PALETTE_KEY = "zaicode-palette";
const CRISP_KEY = "zaicode-crisp";
const FONT_KEY = "zaicode-font-settings";
const LIST_LABEL_WIDTH_KEY = "zaicode-list-label-width";
const STYLE_ID = "zaicode-appearance-style";
const CHANGE_EVENT = "zaicode-appearance-changed";
const PIXEL_FILTER_ID = "zaicode-pixel-threshold";

function ensurePixelIconFilter(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(PIXEL_FILTER_ID)) return;
  if (!document.body) {
    if (typeof window !== "undefined") {
      window.addEventListener("DOMContentLoaded", () => ensurePixelIconFilter(), { once: true });
    }
    return;
  }
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-zaicode-pixel-filter", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
  const filter = document.createElementNS(ns, "filter");
  filter.id = PIXEL_FILTER_ID;
  filter.setAttribute("x", "-50%");
  filter.setAttribute("y", "-50%");
  filter.setAttribute("width", "200%");
  filter.setAttribute("height", "200%");
  const transfer = document.createElementNS(ns, "feComponentTransfer");
  const alpha = document.createElementNS(ns, "feFuncA");
  alpha.setAttribute("type", "discrete");
  alpha.setAttribute("tableValues", "0 1");
  transfer.append(alpha);
  filter.append(transfer);
  svg.append(filter);
  document.body.append(svg);
}

export interface ZaicodeAppearance {
  palette: string;
  crisp: boolean;
  typography: ZaicodeTypography;
  listLabelWidth: number;
}

export const ZAICODE_CODE_FONT_OPTIONS = [
  // 已安装的 Terminus TTF 保留内嵌位图（无抗锯齿）；@font-face 版本会被 Chromium 剥掉位图，只作兜底。
  {
    id: "terminus",
    label: "Terminus (bitmap, crisp at 12/14/16/18/20/22/24/28/32 px)",
    family: '"Terminus (TTF) for Windows", "ZAICODE Terminus", monospace',
  },
  { id: "consolas", label: "Consolas", family: "Consolas, monospace" },
  { id: "cascadia", label: "Cascadia Code", family: '"Cascadia Code", Consolas, monospace' },
  { id: "jetbrains", label: "JetBrains Mono", family: '"JetBrains Mono", Consolas, monospace' },
  { id: "fira", label: "Fira Code", family: '"Fira Code", Consolas, monospace' },
  { id: "plex", label: "IBM Plex Mono", family: '"IBM Plex Mono", Consolas, monospace' },
  { id: "custom", label: "Custom installed font", family: "" },
] as const;

export const ZAICODE_UI_FONT_OPTIONS = [
  // 默认：位图补丁版 Verdana_m1（4-30 px 全部带内嵌位图，DirectWrite 直接画像素，不抗锯齿）。
  {
    id: "verdana",
    label: "Verdana m1 (bitmap, crisp)",
    family: '"Verdana_m1", Verdana, Tahoma, sans-serif',
  },
  { id: "verdana-plain", label: "Verdana (system)", family: "Verdana, Tahoma, sans-serif" },
  { id: "tahoma", label: "Tahoma", family: "Tahoma, Verdana, sans-serif" },
  { id: "segoe", label: "Segoe UI", family: '"Segoe UI", Verdana, sans-serif' },
  { id: "arial", label: "Arial", family: "Arial, Verdana, sans-serif" },
  { id: "custom", label: "Custom installed font", family: "" },
] as const;

export interface ZaicodeTypography {
  codeFont: string;
  customCodeFont: string;
  uiFont: string;
  customUiFont: string;
  inlineCodeSize: number;
  codeLineHeight: number;
  ligatures: boolean;
}

const DEFAULT_TYPOGRAPHY: ZaicodeTypography = {
  codeFont: "terminus",
  customCodeFont: "",
  uiFont: "verdana",
  customUiFont: "",
  inlineCodeSize: 14,
  codeLineHeight: 1.5,
  ligatures: false,
};

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function safeFontName(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value]
    .filter((char) => (char.codePointAt(0) ?? 0) >= 32 && !'"\\;'.includes(char))
    .join("")
    .slice(0, 80)
    .trim();
}

function readTypography(): ZaicodeTypography {
  try {
    const raw = safeGet(FONT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ZaicodeTypography>) : {};
    return {
      codeFont: ZAICODE_CODE_FONT_OPTIONS.some((option) => option.id === parsed.codeFont)
        ? parsed.codeFont!
        : DEFAULT_TYPOGRAPHY.codeFont,
      customCodeFont: safeFontName(parsed.customCodeFont),
      uiFont: ZAICODE_UI_FONT_OPTIONS.some((option) => option.id === parsed.uiFont)
        ? parsed.uiFont!
        : DEFAULT_TYPOGRAPHY.uiFont,
      customUiFont: safeFontName(parsed.customUiFont),
      inlineCodeSize: boundedNumber(
        parsed.inlineCodeSize,
        12,
        22,
        DEFAULT_TYPOGRAPHY.inlineCodeSize,
      ),
      codeLineHeight: boundedNumber(
        parsed.codeLineHeight,
        1.1,
        2,
        DEFAULT_TYPOGRAPHY.codeLineHeight,
      ),
      ligatures: parsed.ligatures === true,
    };
  } catch {
    return { ...DEFAULT_TYPOGRAPHY };
  }
}

function safeGet(key: string): string | null {
  try {
    return readZaicodeSetting(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: preference lasts for this session only
  }
}

let cached: ZaicodeAppearance | null = null;

export function readZaicodeAppearance(): ZaicodeAppearance {
  if (cached) return cached;
  const storedPalette = safeGet(PALETTE_KEY);
  const palette =
    storedPalette === ZAICODE_PALETTE_NONE || findAnyZaicodePalette(storedPalette)
      ? (storedPalette as string)
      : ZAICODE_DEFAULT_PALETTE;
  const storedWidth = Number(safeGet(LIST_LABEL_WIDTH_KEY));
  cached = {
    palette,
    crisp: safeGet(CRISP_KEY) !== "0",
    typography: readTypography(),
    listLabelWidth: Number.isFinite(storedWidth) && storedWidth >= 64 && storedWidth <= 220
      ? storedWidth
      : 112,
  };
  return cached;
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (![PALETTE_KEY, CRISP_KEY, FONT_KEY, LIST_LABEL_WIDTH_KEY].includes(event.key ?? "")) return;
    cached = null;
    applyZaicodeAppearance();
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useZaicodeAppearance(): ZaicodeAppearance {
  return useSyncExternalStore(subscribe, readZaicodeAppearance, readZaicodeAppearance);
}

function update(next: ZaicodeAppearance): void {
  cached = next;
  safeSet(PALETTE_KEY, next.palette);
  safeSet(CRISP_KEY, next.crisp ? "1" : "0");
  safeSet(FONT_KEY, JSON.stringify(next.typography));
  safeSet(LIST_LABEL_WIDTH_KEY, String(next.listLabelWidth));
  applyZaicodeAppearance();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setZaicodePalette(palette: string): void {
  update({ ...readZaicodeAppearance(), palette });
}

export function setZaicodeCrisp(crisp: boolean): void {
  update({ ...readZaicodeAppearance(), crisp });
}

export function setZaicodeTypography(patch: Partial<ZaicodeTypography>): void {
  const current = readZaicodeAppearance();
  update({ ...current, typography: { ...current.typography, ...patch } });
}

export function setZaicodeListLabelWidth(width: number): void {
  const current = readZaicodeAppearance();
  update({ ...current, listLabelWidth: Math.min(220, Math.max(64, Math.round(width))) });
}

export function resetZaicodeTypography(): void {
  const current = readZaicodeAppearance();
  update({ ...current, typography: { ...DEFAULT_TYPOGRAPHY } });
}

function fontFamily(
  options: readonly { id: string; family: string }[],
  id: string,
  custom: string,
) {
  const selected = options.find((option) => option.id === id);
  return selected?.id === "custom" && custom
    ? `${JSON.stringify(safeFontName(custom))}, monospace`
    : selected?.family || options[0]?.family || "monospace";
}

/**
 * Polarity forced by the active palette ("dark"/"light"), or null when no
 * palette is active. The theme hook uses it so a light Wintage palette
 * (Vintage Classic) does not sit on dark-mode component rules.
 */
export function zaicodePaletteResolvedTheme(): "dark" | "light" | null {
  if (!isZaicodeProductMode()) return null;
  const palette = findAnyZaicodePalette(readZaicodeAppearance().palette);
  if (!palette) return null;
  return isDarkPalette(zaicodeAdjustedPalette(palette)) ? "dark" : "light";
}

/** Writes the palette/crisp style element and <html> classes. Idempotent. */
export function applyZaicodeAppearance(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const enabled = isZaicodeProductMode();
  if (enabled) ensurePixelIconFilter();
  const { palette: slug, crisp, typography } = readZaicodeAppearance();
  // Color Studio cascade: palette (built-in or own) -> adjusters -> single-colour overrides.
  const palette = enabled ? findAnyZaicodePalette(slug) : null;
  const studio = readZaicodeColorStudio();

  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.append(style);
  }
  const entries = enabled ? Object.entries(zaicodeEffectiveColorVariables(palette, studio)) : [];
  const variables = entries.map(([name, value]) => `  ${name}: ${value};`).join("\n");
  // html.zaicode-palette (元素+类) 的优先级高于 .theme-zai-dark，覆盖上游 token 不需要 !important。
  style.textContent = `${entries.length > 0 ? `html.zaicode-palette {\n${variables}\n}\n` : ""}${ZAICODE_CRISP_CSS}`;

  root.classList.toggle("zaicode-palette", entries.length > 0);
  root.classList.toggle("zaicode-crisp", enabled && crisp);
  root.classList.toggle("zaicode-fonts", enabled);
  if (enabled) {
    root.style.setProperty("--zaicode-list-label-width", `${readZaicodeAppearance().listLabelWidth}px`);
    root.style.setProperty(
      "--font-mono",
      fontFamily(ZAICODE_CODE_FONT_OPTIONS, typography.codeFont, typography.customCodeFont),
    );
    root.style.setProperty(
      "--zaicode-ui-font-family",
      fontFamily(ZAICODE_UI_FONT_OPTIONS, typography.uiFont, typography.customUiFont).replace(
        /, monospace$/,
        ", sans-serif",
      ),
    );
    root.style.setProperty("--zaicode-code-line-height", String(typography.codeLineHeight));
    root.style.setProperty("--zaicode-inline-code-size", `${typography.inlineCodeSize}px`);
    root.style.setProperty("--zaicode-code-ligatures", typography.ligatures ? "normal" : "none");
  } else {
    for (const property of [
      "--font-mono",
      "--zaicode-ui-font-family",
      "--zaicode-code-line-height",
      "--zaicode-inline-code-size",
      "--zaicode-code-ligatures",
      "--zaicode-list-label-width",
    ])
      root.style.removeProperty(property);
  }
  if (palette) {
    const dark = isDarkPalette(zaicodeAdjustedPalette(palette, studio));
    root.classList.toggle("dark", dark);
    root.classList.toggle("theme-zai-dark", dark);
    root.classList.toggle("theme-zai-light", !dark);
  }
}

// Color Studio edits (own themes, adjusters, overrides) apply live.
if (typeof window !== "undefined") {
  window.addEventListener(ZAICODE_COLOR_STUDIO_EVENT, () => {
    cached = null;
    applyZaicodeAppearance();
    window.dispatchEvent(new Event(CHANGE_EVENT));
  });
}
