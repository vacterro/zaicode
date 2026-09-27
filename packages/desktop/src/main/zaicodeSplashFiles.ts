import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * File side of the custom start-up splash (SRC-049), kept free of `electron`
 * so it can be tested. zaicodeSplashPrefs.ts owns the settings and the page.
 *
 * SRC-058: exactly one `custom.<ext>` may exist. Three start-up surfaces read
 * the picture:
 * - the root launcher tries custom.png first, then jpg, jpeg, gif, webp, bmp;
 * - the generated page names the file it was written for;
 * - the settings preview took the first readdir match.
 * Before this change, replacing a PNG with a JPG left both files, so the
 * launcher kept showing the old picture while the app showed the new one.
 */

export const ZAICODE_CUSTOM_SPLASH_IMAGE = /^custom\.(png|jpg|jpeg|gif|webp|bmp)$/i;

/** The picture's real format by its magic bytes (never by its file name), or null. */
export function sniffZaicodeSplashImage(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (bytes.subarray(0, 2).toString("latin1") === "BM") return "bmp";
  return null;
}

/** The installed custom picture in `dir`, or null (also when `dir` does not exist). */
export function findZaicodeCustomSplashImage(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const entry = readdirSync(dir).find((name) => ZAICODE_CUSTOM_SPLASH_IMAGE.test(name));
  return entry ? join(dir, entry) : null;
}

/**
 * Copies `sourcePath` into `dir` as the one custom picture and writes the page
 * for it. Any previous `custom.*` is removed first, whatever its format.
 * Returns the installed file name, or null when the source is not a supported
 * picture; in that case nothing in `dir` changes.
 */
export function installZaicodeCustomSplashImage(
  dir: string,
  sourcePath: string,
  page: (imageFile: string) => string,
): string | null {
  const ext = sniffZaicodeSplashImage(readFileSync(sourcePath));
  if (!ext) return null;
  mkdirSync(dir, { recursive: true });
  const target = `custom.${ext}`;
  for (const name of readdirSync(dir)) {
    if (ZAICODE_CUSTOM_SPLASH_IMAGE.test(name) && name !== target) rmSync(join(dir, name), { force: true });
  }
  copyFileSync(sourcePath, join(dir, target));
  writeFileSync(join(dir, "zaicode-splash.html"), page(target), "utf8");
  return target;
}
