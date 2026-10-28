/**
 * How ZAICODE draws for the screen it is on (SRC-062): pixel mode looks right
 * on a Full HD monitor at 100-125 %, but on a 2K-4K monitor scaled 150 % and
 * up it only costs size (1:1 device pixels make everything half as big) while
 * the density already hides any blur.
 *
 *   auto   -- pixels below 150 % scaling, smooth from 150 % up (default);
 *   pixel  -- always pixels (1:1 device pixels, bitmap fonts, crisp icons);
 *   smooth -- never: Windows scaling, smooth icons and images.
 */

export const ZAICODE_SCREEN_MODES = ["auto", "pixel", "smooth"] as const;
export type ZaicodeScreenMode = (typeof ZAICODE_SCREEN_MODES)[number];

/** From this scale factor up a screen counts as dense (Windows 150 %). */
export const ZAICODE_SMOOTH_SCALE = 1.5;

/**
 * A stored mode, or the older on/off switch it replaces: an explicit "off"
 * stays smooth, anything else becomes auto (on a Full HD screen auto is the
 * old default, pixels).
 */
export function normalizeZaicodeScreenMode(value: unknown, legacy?: unknown): ZaicodeScreenMode {
  if (ZAICODE_SCREEN_MODES.includes(value as ZaicodeScreenMode)) return value as ZaicodeScreenMode;
  if (legacy === false || legacy === "0") return "smooth";
  return "auto";
}

/** Whether the pixel look applies on a screen with this scale factor. */
export function zaicodePixelLook(mode: ZaicodeScreenMode, scale: number): boolean {
  if (mode === "pixel") return true;
  if (mode === "smooth") return false;
  return !(Number.isFinite(scale) && scale >= ZAICODE_SMOOTH_SCALE);
}
