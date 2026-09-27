import { app } from "electron";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ZaicodeSplashPrefsInput, ZaicodeSplashPrefsState } from "@zcode/shared";
import {
  findZaicodeCustomSplashImage,
  installZaicodeCustomSplashImage,
  zaicodeSplashPage,
} from "./zaicodeSplashFiles.js";
import {
  readZaicodeLauncherPreferences,
  setZaicodeSplashEnabled,
  setZaicodeSplashOptions,
  writeZaicodeLauncherPreferences,
  zaicodeSplashOptionsOf,
} from "./zaicodeLauncherPreferences.js";

/**
 * Custom start-up splash picture (SRC-049): the operator picks one picture in
 * Settings and every start-up surface uses it - the root launcher's splash,
 * the app's own splash window and the in-window loading shell. The picture is
 * COPIED here (userData/zaicode-splash/) next to a generated splash.html, so
 * the bundled build never changes and a moved/deleted source file cannot break
 * the start-up. The generated page is the twin of build/zaicode-splash/splash.html.
 */

export function zaicodeSplashCustomDir(): string {
  return join(app.getPath("userData"), "zaicode-splash");
}

/** The custom dir only counts when it holds both its page and its picture. */
export function hasZaicodeCustomSplash(): boolean {
  return existsSync(join(zaicodeSplashCustomDir(), "zaicode-splash.html")) && customImageFile() !== null;
}

function customImageFile(): string | null {
  return findZaicodeCustomSplashImage(zaicodeSplashCustomDir());
}


function readState(): ZaicodeSplashPrefsState {
  const preferences = readZaicodeLauncherPreferences();
  const hasCustom = hasZaicodeCustomSplash();
  let customDataUrl: string | null = null;
  const file = hasCustom ? customImageFile() : null;
  if (file) {
    const bytes = readFileSync(file);
    const ext = /\.(\w+)$/.exec(file)?.[1]?.toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext ?? "png"}`;
    customDataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  }
  return { ...zaicodeSplashOptionsOf(preferences), enabled: preferences.splashEnabled, hasCustom, customDataUrl };
}

/** Reads the splash preferences for the settings page (the data URL previews the picture). */
export function readZaicodeSplashPrefs(): ZaicodeSplashPrefsState {
  return readState();
}

/**
 * Persists the splash preferences: the enabled flag, and a picture picked by
 * path (copied in) or `null` to return to the bundled picture. Returns the new
 * state; a bad picture leaves everything unchanged.
 */
export function setZaicodeSplashPrefs(input: ZaicodeSplashPrefsInput): ZaicodeSplashPrefsState {
  setZaicodeSplashEnabled(input.enabled);
  if (input.options) setZaicodeSplashOptions(input.options);
  // `undefined` = leave the picture alone (a toggle or an option changed).
  if (input.imagePath === undefined) return readState();
  if (input.imagePath === null) {
    if (readZaicodeLauncherPreferences().splashCustom) {
      rmSync(zaicodeSplashCustomDir(), { recursive: true, force: true });
      writeZaicodeLauncherPreferences({ splashCustom: false });
    }
    return readState();
  }
  if (typeof input.imagePath !== "string" || !input.imagePath.trim()) return readState();
  // SRC-058: replaces any earlier custom.* whatever its format, so the launcher,
  // the app splash and the settings preview all show the same picture.
  if (!installZaicodeCustomSplashImage(zaicodeSplashCustomDir(), input.imagePath, zaicodeSplashPage)) return readState();
  writeZaicodeLauncherPreferences({ splashCustom: true });
  return readState();
}
