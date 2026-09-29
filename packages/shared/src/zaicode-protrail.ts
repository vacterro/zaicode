/**
 * ProTrail over the whole desktop (SRC-062): "it must work fully, not only
 * inside the program but globally in Windows".
 *
 * The desktop main process owns one click-through overlay per monitor (like
 * ProTrail's own per-monitor overlays) and reads the mouse the way ProTrail
 * does: a Raw Input sink (RIDEV_INPUTSINK) on a message-only window, plus
 * GetCursorPos for the position of every packet. That sink is a tiny helper
 * process; this module holds the contract between it, the main process and
 * the overlay pages.
 */

export interface ZaicodeProtrailGlobalStatus {
  /** off: no overlays. starting: overlays are coming up. running: drawing over the desktop. unavailable: see `note`. */
  state: "off" | "starting" | "running" | "unavailable";
  /** raw-input: moves and clicks (ProTrail's own source). cursor-poll: moves only (no clicks, holds or wake). */
  input: "raw-input" | "cursor-poll" | "none";
  /** Overlays whose document is loaded. */
  displays: number;
  /** Connected monitors, each of which should get an overlay (absent from an older main process). */
  monitors?: number;
  /**
   * Overlays whose own page confirmed it holds the config, has the monitor's size and draws frames
   * (T-129). Absent from a main process that does not check; then `displays` is all there is.
   */
  verified?: number;
  /** Why clicks are not seen, or why the desktop-wide mode is unavailable. */
  note: string | null;
}

export const ZAICODE_PROTRAIL_GLOBAL_OFF: ZaicodeProtrailGlobalStatus = {
  state: "off",
  input: "none",
  displays: 0,
  note: null,
};

export const ZAICODE_PROTRAIL_INPUT_MOVE = 0;
export const ZAICODE_PROTRAIL_INPUT_DOWN = 1;
export const ZAICODE_PROTRAIL_INPUT_UP = 2;

/** One mouse event. Buttons use DOM numbering: 0 left, 1 middle, 2 right. `t` is in the source's own millisecond clock. */
export interface ZaicodeProtrailInputEvent {
  kind: typeof ZAICODE_PROTRAIL_INPUT_MOVE | typeof ZAICODE_PROTRAIL_INPUT_DOWN | typeof ZAICODE_PROTRAIL_INPUT_UP;
  button: number;
  x: number;
  y: number;
  t: number;
}

/** Stride of the flattened event list sent to the overlays: kind, button, x, y, t. */
export const ZAICODE_PROTRAIL_EVENT_STRIDE = 5;

/** What the main process sends an overlay page; every field is optional and applies when present. */
export interface ZaicodeProtrailOverlayFeed {
  /** The ProTrail config (normalized again by the page), or null to stop drawing. */
  config?: unknown;
  /** This overlay's monitor in desktop coordinates (DIP). */
  origin?: { x: number; y: number };
  /** Flattened events (stride 5) in desktop coordinates (DIP). */
  events?: number[];
}

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * One line of the Raw Input helper: `m X Y T` (move), `d B X Y T` (button
 * down), `u B X Y T` (button up). X/Y are physical screen pixels, T is the
 * helper's millisecond clock. Anything else is ignored (null).
 */
export function parseZaicodeProtrailInputLine(line: string): ZaicodeProtrailInputEvent | null {
  const parts = line.trim().split(" ");
  const kind = parts[0];
  if (kind === "m" && parts.length === 4 && parts.slice(1).every((part) => NUMBER.test(part))) {
    return { kind: ZAICODE_PROTRAIL_INPUT_MOVE, button: -1, x: Number(parts[1]), y: Number(parts[2]), t: Number(parts[3]) };
  }
  if ((kind === "d" || kind === "u") && parts.length === 5 && parts.slice(1).every((part) => NUMBER.test(part))) {
    const button = Number(parts[1]);
    if (button !== 0 && button !== 1 && button !== 2) return null;
    return {
      kind: kind === "d" ? ZAICODE_PROTRAIL_INPUT_DOWN : ZAICODE_PROTRAIL_INPUT_UP,
      button,
      x: Number(parts[2]),
      y: Number(parts[3]),
      t: Number(parts[4]),
    };
  }
  return null;
}

/**
 * Maps a foreign millisecond clock (the helper's, the main process's) onto
 * the page's performance.now(). The offset is the smallest delivery delay
 * seen, relaxing slowly so a drift or a sleep cannot pin it: mapped times
 * never lie in the future and keep the source's spacing, which the trail's
 * fade and the wake's speed need.
 */
export class ZaicodeProtrailClock {
  private offset = Number.POSITIVE_INFINITY;
  private lastNow = 0;

  /** Call once per delivered batch with the batch's newest source time. */
  observe(sourceNewest: number, now: number): void {
    const delay = now - sourceNewest;
    if (Number.isFinite(this.offset)) this.offset += Math.max(0, now - this.lastNow) * 0.02;
    this.lastNow = now;
    if (!Number.isFinite(this.offset) || delay < this.offset || delay - this.offset > 1000) this.offset = delay;
  }

  map(sourceTime: number, now: number): number {
    return Number.isFinite(this.offset) ? Math.min(now, sourceTime + this.offset) : now;
  }
}
