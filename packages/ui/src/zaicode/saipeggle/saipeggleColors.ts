import type { SpgPegKind } from "./saipeggleModel.js";

/**
 * SAIPEGGLE's colours come from the ZAICODE palette in use: the board is the
 * palette's background and surfaces, the pegs are its accent (blue), warning
 * (orange), success (green) and danger turned purple. A palette colour that
 * would vanish on the board is pushed brighter until it reads. "Classic"
 * keeps the palette's board but the genre's own peg colours.
 */

export type Rgb = [number, number, number];

export interface SpgColors {
  bg: string;
  board: string;
  panel: string;
  frame: string;
  frameLight: string;
  text: string;
  dim: string;
  highlight: string;
  ball: string;
  ballShade: string;
  fire: string;
  guide: string;
  bucket: string;
  bucketShade: string;
  peg: Record<SpgPegKind, { base: string; shade: string; lit: string; glint: string }>;
}

export function parseRgb(value: string): Rgb | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

export const hex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Moves `color` away from `bg` (toward white on a dark board, black on a light one) until the contrast is `min`. */
export function readable(color: Rgb, bg: Rgb, min = 3): Rgb {
  const target: Rgb = luminance(bg) < 0.4 ? [255, 255, 255] : [0, 0, 0];
  let out = color;
  for (let i = 0; i < 10 && contrast(out, bg) < min; i += 1) out = mix(out, target, 0.18);
  return out;
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** `color` turned to hue `hue`, keeping (at least some of) its saturation and lightness. */
export function withHue(color: Rgb, hue: number): Rgb {
  const [, s, l] = rgbToHsl(color);
  return hslToRgb(hue, Math.max(0.45, s), Math.min(0.7, Math.max(0.35, l)));
}

/** Blue and green pegs must never read as one colour: a palette whose accent sits near its green gets a blue accent. */
function apart(color: Rgb, other: Rgb, fallbackHue: number): Rgb {
  const [h1, s1] = rgbToHsl(color);
  const [h2] = rgbToHsl(other);
  const distance = Math.min(Math.abs(h1 - h2), 360 - Math.abs(h1 - h2));
  return s1 > 0.15 && distance < 50 ? withHue(color, fallbackHue) : color;
}

const CLASSIC: Record<SpgPegKind, Rgb> = {
  blue: [58, 128, 232],
  orange: [240, 128, 32],
  green: [60, 200, 90],
  purple: [170, 80, 230],
};

function pegTones(base: Rgb, bg: Rgb) {
  const color = readable(base, bg, 2.6);
  return {
    base: hex(color),
    shade: hex(mix(color, [0, 0, 0], 0.38)),
    lit: hex(mix(color, [255, 255, 255], 0.45)),
    glint: hex(mix(color, [255, 255, 255], 0.8)),
  };
}

export interface SpgPaletteInput {
  background: Rgb;
  surface: Rgb;
  border: Rgb;
  borderLight: Rgb;
  text: Rgb;
  textDim: Rgb;
  accent: Rgb;
  warning: Rgb;
  success: Rgb;
  danger: Rgb;
  highlight: Rgb;
}

export function saipeggleColors(p: SpgPaletteInput, mode: "palette" | "classic"): SpgColors {
  const board = mix(p.background, p.surface, 0.35);
  const pegs =
    mode === "classic"
      ? CLASSIC
      : { blue: apart(p.accent, p.success, 210), orange: p.warning, green: p.success, purple: withHue(p.danger, 285) };
  const ball = readable(mix(p.text, [255, 255, 255], 0.35), board, 4);
  return {
    bg: hex(p.background),
    board: hex(board),
    panel: hex(p.surface),
    frame: hex(p.border),
    frameLight: hex(readable(p.borderLight, p.surface, 1.6)),
    text: hex(readable(p.text, p.surface, 4)),
    dim: hex(readable(p.textDim, p.surface, 2.5)),
    highlight: hex(readable(p.highlight, board, 3)),
    ball: hex(ball),
    ballShade: hex(mix(ball, [0, 0, 0], 0.4)),
    fire: hex(readable([255, 110, 30], board, 3)),
    guide: hex(readable(mix(p.text, board, 0.35), board, 2.2)),
    bucket: hex(readable(p.highlight, board, 3)),
    bucketShade: hex(mix(readable(p.highlight, board, 3), [0, 0, 0], 0.4)),
    peg: {
      blue: pegTones(pegs.blue, board),
      orange: pegTones(pegs.orange, board),
      green: pegTones(pegs.green, board),
      purple: pegTones(pegs.purple, board),
    },
  };
}

/** Reads the live palette from the page's CSS variables (any CSS colour syntax). */
export function readSaipegglePalette(root: HTMLElement = document.documentElement): SpgPaletteInput {
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const style = getComputedStyle(root);
  const read = (names: readonly string[], fallback: Rgb): Rgb => {
    for (const name of names) {
      const value = style.getPropertyValue(name).trim();
      if (!value) continue;
      const direct = parseRgb(value);
      if (direct) return direct;
      if (probe) {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = "#000";
        probe.fillStyle = value;
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
        return [r!, g!, b!];
      }
    }
    return fallback;
  };
  return {
    background: read(["--color-background"], [16, 16, 16]),
    surface: read(["--color-surface", "--color-card"], [34, 34, 34]),
    border: read(["--color-border"], [80, 80, 80]),
    borderLight: read(["--color-border-hover"], [120, 120, 120]),
    text: read(["--color-foreground"], [200, 200, 200]),
    textDim: read(["--color-foreground-subtle"], [150, 150, 150]),
    accent: read(["--color-accent", "--color-primary"], CLASSIC.blue),
    warning: read(["--color-warning"], CLASSIC.orange),
    success: read(["--color-success"], CLASSIC.green),
    danger: read(["--color-destructive"], [220, 60, 60]),
    highlight: read(["--zaicode-highlight", "--color-warning"], [240, 208, 96]),
  };
}
