import {
  ZAICODE_SPLASH_BOOT_KEY,
  zaicodeSplashBootMirror,
  type ZaicodeSplashPrefsState,
} from "@zcode/shared";

/** The in-window loading shell reads these synchronously at boot (desktop renderer index.html). */
const SPLASH_IMAGE_KEY = "zaicode-splash-image";

/**
 * Mirrors the splash state the boot shell needs before any IPC exists: the
 * custom picture and (SRC-060) hold-until-ready, longest wait and fit.
 */
export function mirrorZaicodeSplashBoot(state: ZaicodeSplashPrefsState): void {
  try {
    if (state.customDataUrl) localStorage.setItem(SPLASH_IMAGE_KEY, state.customDataUrl);
    else localStorage.removeItem(SPLASH_IMAGE_KEY);
    localStorage.setItem(ZAICODE_SPLASH_BOOT_KEY, JSON.stringify(zaicodeSplashBootMirror(state)));
  } catch {
    // The main-process copy still applies; only the pre-boot mirror fails.
  }
}
