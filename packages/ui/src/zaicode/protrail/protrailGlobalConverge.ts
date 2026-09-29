import type { ZaicodeProtrailGlobalStatus } from "@zcode/shared";

/**
 * The window's half of desktop-wide ProTrail as a plain, testable run loop.
 *
 * The invariant this exists for: a persisted-enabled ProTrail converges to
 * active without the operator visiting Settings. One `set` is not enough --
 * the desktop can refuse it because its handler is not registered yet (a
 * window created from the tray, a deep link or `app.activate` can reach the
 * renderer before the platform handlers exist), can answer "off" because the
 * display list has not settled, and can answer "starting" while the Raw Input
 * helper compiles. All three are states the desktop converges out of, so the
 * window keeps asking with a backoff instead of waiting for a toggle.
 */

export interface ProtrailConvergePort {
  /** Hand the desktop the config to draw with, or null to switch the mode off. */
  set(config: unknown): Promise<ZaicodeProtrailGlobalStatus>;
  /** Ask the desktop what it can do at all. Used to tell "not yet" from "never". */
  status(): Promise<ZaicodeProtrailGlobalStatus>;
}

export interface ProtrailConvergeOptions {
  wanted: boolean;
  config: unknown;
  onStatus(next: ZaicodeProtrailGlobalStatus): void;
  onRecovered(): void;
  onUnavailable(): void;
  /** Debounce for slider drags, which change the config many times a second. */
  debounceMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 4000;
/** Refusals in a row before the desktop is asked whether it answers at all. */
const MAX_REFUSALS = 8;

/**
 * The desktop really draws: the mode is on and every monitor's overlay is confirmed by its own page
 * (T-129). A main process that does not check (`verified` absent) is taken at its word about the
 * overlays whose document is loaded, as before. "Loaded" alone once let a converged ProTrail stand
 * in for one that drew nothing, so the window's own canvas is only switched off on this test.
 */
export function zaicodeProtrailDesktopDraws(next: ZaicodeProtrailGlobalStatus): boolean {
  if (next.state !== "running") return false;
  const confirmed = next.verified ?? next.displays;
  return confirmed > 0 && confirmed >= (next.monitors ?? next.displays);
}

/** The desktop says it is really drawing (or, for `wanted` false, that it is off). */
export function zaicodeProtrailGlobalConverged(next: ZaicodeProtrailGlobalStatus, wanted: boolean): boolean {
  if (!wanted) return next.state === "off";
  return zaicodeProtrailDesktopDraws(next);
}

/** What Settings -> ProTrail says about the desktop-wide mode: the honest state, not the wished one. */
export function zaicodeProtrailStatusLine(status: ZaicodeProtrailGlobalStatus): string {
  if (status.state === "off") return "Not drawing outside ZAICODE right now.";
  if (status.state === "unavailable") return status.note ?? "Not available in this build.";
  const count = status.monitors ?? status.displays;
  const monitors = `${count} monitor${count === 1 ? "" : "s"}`;
  const note = status.note ? ` ${status.note}` : "";
  if (status.state === "starting") return `Starting over ${monitors}…${note}`;
  const source = status.input === "raw-input" ? "moves and clicks (Raw Input)" : "the cursor only (no clicks)";
  // T-129: an overlay counts as drawing only once its own page said so; until then the window draws the trail itself.
  if (status.verified !== undefined && status.verified < count) {
    return `Checking the overlays: ${status.verified} of ${count} confirmed, reading ${source}. The trail is drawn in this window meanwhile.${note}`;
  }
  return `Drawing over ${monitors}, reading ${source}.${note}`;
}

/** Quick while a start is still settling, then slow enough that a permanent failure costs nothing. */
export function zaicodeProtrailGlobalRetryDelay(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

export function runZaicodeProtrailGlobalConverge(port: ProtrailConvergePort, options: ProtrailConvergeOptions): () => void {
  const setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const { onStatus, onRecovered, onUnavailable } = options;
  let disposed = false;
  let handle: unknown;
  let attempt = 0;
  let refusals = 0;

  const retry = (): void => {
    if (disposed) return;
    attempt += 1;
    handle = setTimer(ask, zaicodeProtrailGlobalRetryDelay(attempt));
  };

  const stillThere = async (): Promise<boolean> => {
    try {
      const next = await port.status();
      if (!disposed) onStatus(next);
      return true;
    } catch {
      return false;
    }
  };

  const refuse = async (): Promise<void> => {
    if (disposed) return;
    refusals += 1;
    // A refusal alone only means the desktop has not registered its handler
    // yet, which is the normal state during startup. Only a desktop that
    // cannot answer anything at all is a build that cannot draw.
    if (refusals >= MAX_REFUSALS && !(await stillThere())) {
      if (disposed) return;
      onUnavailable();
      return;
    }
    retry();
  };

  const ask = (): void => {
    if (disposed) return;
    void port.set(options.wanted ? options.config : null).then(
      (next) => {
        if (disposed) return;
        onStatus(next);
        onRecovered();
        refusals = 0;
        attempt = 0;
        if (!zaicodeProtrailGlobalConverged(next, options.wanted)) retry();
      },
      () => {
        if (disposed) return;
        void refuse();
      },
    );
  };

  handle = setTimer(ask, options.debounceMs ?? 40);
  return () => {
    disposed = true;
    clearTimer(handle);
  };
}
