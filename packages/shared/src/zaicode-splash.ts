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

/**
 * SRC-062: the start-up placeholder -- the SAIPEN emblem, 128 x 128, two
 * colours, hard pixel edges (no anti-aliasing). Both splashes (the root
 * launcher's and the app's own) show it centred until the picture is decoded
 * and the window has its final size, and keep it when the picture cannot be
 * read, so the first frame is never a cut-off picture. The root launcher
 * (tools/launcher/ZaicodeLauncher.cs) embeds the same bytes.
 */
export const ZAICODE_SPLASH_PLACEHOLDER_SIZE = 128;
export const ZAICODE_SPLASH_PLACEHOLDER_PNG_BASE64 =
  "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";
