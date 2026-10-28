import type { ZaicodePaletteTokens } from "./zaicodePalettes.js";

/**
 * Colour arithmetic for the ZAICODE Color Studio: hex <-> HSL, WCAG contrast,
 * whole-palette adjusters and a palette generated from one colour. Pure, so
 * every result is predictable and testable.
 */

export interface ZaicodeHsl {
  h: number;
  s: number;
  l: number;
}

/** `#abc` / `#aabbcc` (any case) -> `#AABBCC`; anything else -> null. */
export function normalizeZaicodeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toUpperCase();
  const long = /^#?([0-9a-f]{6})$/i.exec(text);
  return long ? `#${long[1]!.toUpperCase()}` : null;
}

function channels(hex: string): [number, number, number] {
  const value = normalizeZaicodeHex(hex) ?? "#000000";
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
}

function toHex(r: number, g: number, b: number): string {
  const part = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

export function hexToZaicodeHsl(hex: string): ZaicodeHsl {
  const [r, g, b] = channels(hex).map((value) => value / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

export function zaicodeHslToHex({ h, s, l }: ZaicodeHsl): string {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;
  if (sat === 0) return toHex(light * 255, light * 255, light * 255);
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex(channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255);
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 (none) .. 21 (black on white). */
export function zaicodeContrastRatio(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Whole-palette adjusters: one move recolours everything consistently. */
export interface ZaicodeColorAdjust {
  /** Degrees added to every hue, -180..180. */
  hue: number;
  /** Points added to saturation, -100..100. */
  saturation: number;
  /** Points added to lightness, -50..50. */
  lightness: number;
  /** Spreads (+) or squeezes (-) lightness around the middle, -50..50. */
  contrast: number;
}

export const ZAICODE_NO_ADJUST: ZaicodeColorAdjust = { hue: 0, saturation: 0, lightness: 0, contrast: 0 };

export function isZaicodeAdjustNeutral(adjust: ZaicodeColorAdjust): boolean {
  return adjust.hue === 0 && adjust.saturation === 0 && adjust.lightness === 0 && adjust.contrast === 0;
}

export function adjustZaicodeColor(hex: string, adjust: ZaicodeColorAdjust): string {
  if (isZaicodeAdjustNeutral(adjust)) return normalizeZaicodeHex(hex) ?? hex;
  const hsl = hexToZaicodeHsl(hex);
  const spread = 1 + adjust.contrast / 50;
  return zaicodeHslToHex({
    h: hsl.h + adjust.hue,
    s: hsl.s + adjust.saturation,
    l: 50 + (hsl.l - 50) * spread + adjust.lightness,
  });
}

export function adjustZaicodeTokens(tokens: ZaicodePaletteTokens, adjust: ZaicodeColorAdjust): ZaicodePaletteTokens {
  if (isZaicodeAdjustNeutral(adjust)) return tokens;
  const next = { ...tokens };
  for (const key of Object.keys(next) as (keyof ZaicodePaletteTokens)[]) next[key] = adjustZaicodeColor(next[key], adjust);
  return next;
}

/**
 * A complete palette from one colour: surfaces step in lightness from the
 * seed's hue, text keeps readable contrast, states keep their meaning
 * (green / amber / red). Same seed + polarity -> same palette.
 */
export function generateZaicodePalette(seed: string, dark: boolean): ZaicodePaletteTokens {
  const { h, s } = hexToZaicodeHsl(normalizeZaicodeHex(seed) ?? "#D3B57A");
  const tint = Math.min(s, 45);
  const at = (l: number, sat = tint) => zaicodeHslToHex({ h, s: sat, l: dark ? l : 100 - l });
  const accent = zaicodeHslToHex({ h, s: Math.max(s, 40), l: dark ? 64 : 36 });
  return {
    background: at(9),
    backgroundSoft: at(11),
    surface: at(15),
    surfaceRaised: at(19),
    surfaceAlt: at(22),
    borderDark: at(4),
    borderHighlight: accent,
    bevelLight: at(32),
    borderMuted: at(25),
    textPrimary: at(84, Math.min(tint, 35)),
    textSecondary: at(70, Math.min(tint, 30)),
    textMuted: at(52, Math.min(tint, 25)),
    accentTeal: zaicodeHslToHex({ h: h + 180, s: 60, l: dark ? 40 : 45 }),
    accentTealDeep: zaicodeHslToHex({ h: h + 180, s: 60, l: dark ? 30 : 35 }),
    success: zaicodeHslToHex({ h: 100, s: 50, l: dark ? 40 : 35 }),
    warning: zaicodeHslToHex({ h: 45, s: 60, l: dark ? 45 : 40 }),
    danger: zaicodeHslToHex({ h: 0, s: 55, l: dark ? 38 : 42 }),
    dangerText: zaicodeHslToHex({ h: 0, s: 55, l: dark ? 64 : 38 }),
    selection: at(19),
    compareBack: at(6),
    link: accent,
  };
}
