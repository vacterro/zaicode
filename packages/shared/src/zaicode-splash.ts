/**
 * ZAICODE start-up splash options (SRC-060). One definition for every surface
 * that shows the start-up picture: the root launcher (tools/launcher, which
 * reads the same keys from zaicode-launcher.json), the app's splash window, the
 * in-window loading shell and Settings -> ZAICODE -> Start-up splash.
 */

/** How the picture fills the splash box. */
export type ZaicodeSplashFit = "contain" | "cover" | "stretch";
export const ZAICODE_SPLASH_FITS: readonly ZaicodeSplashFit[] = ["contain", "cover", "stretch"];

/** Whole and half steps only, so the bundled 560x300 pixel picture stays crisp at 1x and 2x. */
export const ZAICODE_SPLASH_SCALES = [1, 1.5, 2] as const;
export type ZaicodeSplashScale = (typeof ZAICODE_SPLASH_SCALES)[number];

/** How long the splash may wait for the interface before the app is shown anyway. */
export const ZAICODE_SPLASH_MAX_WAIT_SECONDS = [10, 20, 30, 60, 90] as const;

export const ZAICODE_SPLASH_BASE_WIDTH = 560;
export const ZAICODE_SPLASH_BASE_HEIGHT = 300;

export interface ZaicodeSplashOptions {
  fit: ZaicodeSplashFit;
  scale: ZaicodeSplashScale;
  /** The loading line at the bottom of the picture ("Loading the interface…", version). */
  status: boolean;
  /**
   * Keep the splash until the interface is usable (projects and input loaded).
   * Off = the app appears as soon as its first frame paints, with its own
   * loading screen, as before SRC-060.
   */
  holdUntilReady: boolean;
  maxWaitSec: number;
}

export const DEFAULT_ZAICODE_SPLASH_OPTIONS: ZaicodeSplashOptions = {
  fit: "contain",
  scale: 1,
  status: true,
  holdUntilReady: true,
  maxWaitSec: 60,
};

export function normalizeZaicodeSplashOptions(raw: unknown): ZaicodeSplashOptions {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_ZAICODE_SPLASH_OPTIONS;
  return {
    fit: ZAICODE_SPLASH_FITS.includes(record.fit as ZaicodeSplashFit) ? (record.fit as ZaicodeSplashFit) : d.fit,
    scale: (ZAICODE_SPLASH_SCALES as readonly number[]).includes(record.scale as number)
      ? (record.scale as ZaicodeSplashScale)
      : d.scale,
    status: typeof record.status === "boolean" ? record.status : d.status,
    holdUntilReady: typeof record.holdUntilReady === "boolean" ? record.holdUntilReady : d.holdUntilReady,
    maxWaitSec: (ZAICODE_SPLASH_MAX_WAIT_SECONDS as readonly number[]).includes(record.maxWaitSec as number)
      ? (record.maxWaitSec as number)
      : d.maxWaitSec,
  };
}

/** Window size of the splash at `scale`, whole pixels. */
export function zaicodeSplashSize(scale: ZaicodeSplashScale): { width: number; height: number } {
  return {
    width: Math.round(ZAICODE_SPLASH_BASE_WIDTH * scale),
    height: Math.round(ZAICODE_SPLASH_BASE_HEIGHT * scale),
  };
}

/**
 * Where a `picture` of the given size lands inside a `box`: "contain" shows
 * the whole picture (bands in the background colour), "cover" fills the box
 * and crops the overflow evenly, "stretch" fills the box and ignores the
 * aspect ratio. The launcher's SplashForm uses the same rule.
 */
export function zaicodeSplashPictureRect(
  picture: { width: number; height: number },
  box: { width: number; height: number },
  fit: ZaicodeSplashFit,
): { x: number; y: number; width: number; height: number } {
  if (fit === "stretch" || picture.width <= 0 || picture.height <= 0) {
    return { x: 0, y: 0, width: box.width, height: box.height };
  }
  const scaleX = box.width / picture.width;
  const scaleY = box.height / picture.height;
  const scale = fit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
  const width = Math.round(picture.width * scale);
  const height = Math.round(picture.height * scale);
  return {
    x: Math.round((box.width - width) / 2),
    y: Math.round((box.height - height) / 2),
    width,
    height,
  };
}

/** Everything Settings shows and edits. */
export interface ZaicodeSplashPrefsState extends ZaicodeSplashOptions {
  enabled: boolean;
  hasCustom: boolean;
  customDataUrl: string | null;
}

export interface ZaicodeSplashPrefsInput {
  enabled: boolean;
  /** A picked picture file (copied into ZAICODE's data); null returns to the bundled picture. */
  imagePath?: string | null;
  options?: Partial<ZaicodeSplashOptions>;
}

/**
 * The renderer's boot shell runs before any IPC exists, so the settings page
 * mirrors what it needs into localStorage under this key.
 */
export const ZAICODE_SPLASH_BOOT_KEY = "zaicode-splash-boot";

export interface ZaicodeSplashBootMirror {
  hold: boolean;
  maxWaitMs: number;
  fit: ZaicodeSplashFit;
}

export function zaicodeSplashBootMirror(options: ZaicodeSplashOptions): ZaicodeSplashBootMirror {
  return { hold: options.holdUntilReady, maxWaitMs: options.maxWaitSec * 1000, fit: options.fit };
}

/**
 * Fired on window once the interface is usable: the start-up gate is clear
 * (projects restored, input mounted), the sign-in screen is up, or a start-up
 * error needs the operator. The boot shell and the main process hold the
 * splash until then when `holdUntilReady` is on.
 */
export const ZAICODE_APP_INTERACTIVE_EVENT = "zcode-app-interactive";
