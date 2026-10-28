/**
 * SAIPEGGLE's 5 x 7 bitmap font. Canvas text is always anti-aliased; the game
 * is not, so every letter is drawn as whole pixels (fillRect runs) at an
 * integer scale. Rows are 5-bit masks, the top bit is the leftmost pixel.
 */

const G: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12],
  K: [17, 18, 20, 24, 20, 18, 17],
  L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17],
  N: [17, 17, 25, 21, 19, 17, 17],
  O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13],
  R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30],
  T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4],
  W: [17, 17, 17, 21, 21, 21, 10],
  X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4],
  Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14],
  "1": [4, 12, 4, 4, 4, 4, 14],
  "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14],
  "4": [2, 6, 10, 18, 31, 2, 2],
  "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14],
  "7": [31, 1, 2, 4, 8, 8, 8],
  "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  " ": [0, 0, 0, 0, 0, 0, 0],
  "+": [0, 4, 4, 31, 4, 4, 0],
  "-": [0, 0, 0, 31, 0, 0, 0],
  ".": [0, 0, 0, 0, 0, 12, 12],
  ",": [0, 0, 0, 0, 12, 4, 8],
  ":": [0, 12, 12, 0, 12, 12, 0],
  "!": [4, 4, 4, 4, 0, 0, 4],
  "?": [14, 17, 1, 2, 4, 0, 4],
  "'": [12, 4, 8, 0, 0, 0, 0],
  '"': [10, 10, 10, 0, 0, 0, 0],
  "/": [0, 1, 2, 4, 8, 16, 0],
  "%": [24, 25, 2, 4, 8, 19, 3],
  "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8],
  "<": [2, 4, 8, 16, 8, 4, 2],
  ">": [8, 4, 2, 1, 2, 4, 8],
  "=": [0, 0, 31, 0, 31, 0, 0],
  "#": [10, 10, 31, 10, 31, 10, 10],
  "*": [0, 4, 21, 14, 21, 4, 0],
  "&": [12, 18, 20, 8, 21, 18, 13],
  _: [0, 0, 0, 0, 0, 0, 31],
  x: [0, 0, 17, 10, 4, 10, 17],
  "·": [0, 0, 0, 4, 0, 0, 0],
};

export const SPG_FONT_W = 5;
export const SPG_FONT_H = 7;

function glyph(char: string): readonly number[] {
  return G[char] ?? G[char.toUpperCase()] ?? G["?"]!;
}

/** Width in pixels of `text` at `scale` (one pixel column between letters). */
export function saipeggleTextWidth(text: string, scale = 1): number {
  return text.length === 0 ? 0 : (text.length * (SPG_FONT_W + 1) - 1) * scale;
}

/** Draws `text` with its top-left (or top-centre / top-right) at x, y. */
export function saipeggleText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  options: { scale?: number; align?: "left" | "center" | "right"; shadow?: string } = {},
): void {
  const scale = Math.max(1, Math.round(options.scale ?? 1));
  const width = saipeggleTextWidth(text, scale);
  let left = Math.round(options.align === "center" ? x - width / 2 : options.align === "right" ? x - width : x);
  const top = Math.round(y);
  if (options.shadow) {
    saipeggleText(ctx, text, left + scale, top + scale, options.shadow, { scale });
  }
  ctx.fillStyle = color;
  for (const char of text) {
    const rows = glyph(char);
    rows.forEach((mask, row) => {
      let run = -1;
      for (let col = 0; col <= SPG_FONT_W; col += 1) {
        const on = col < SPG_FONT_W && (mask & (1 << (SPG_FONT_W - 1 - col))) !== 0;
        if (on && run < 0) run = col;
        if (!on && run >= 0) {
          ctx.fillRect(left + run * scale, top + row * scale, (col - run) * scale, scale);
          run = -1;
        }
      }
    });
    left += (SPG_FONT_W + 1) * scale;
  }
}

/** Every character the font draws as itself (anything else shows as "?"). */
export function saipeggleFontCovers(char: string): boolean {
  return char in G || char.toUpperCase() in G;
}
