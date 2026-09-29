/* eslint-disable max-lines -- one owner module: the overlay windows, the input source and their health share one piece of state (wanted, config, status) that a split would pass around by argument. */
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, screen, type Display, type Rectangle, type WebContents } from "electron";
import {
  PlatformChannels,
  ZAICODE_PROTRAIL_EVENT_STRIDE,
  ZAICODE_PROTRAIL_GLOBAL_OFF,
  type ZaicodeProtrailGlobalStatus,
  type ZaicodeProtrailInputEvent,
  type ZaicodeProtrailOverlayFeed,
} from "@zcode/shared";
import {
  ensureZaicodeProtrailInputHelper,
  startZaicodeProtrailCursorPoll,
  startZaicodeProtrailRawInput,
  type ZaicodeProtrailInput,
} from "./zaicodeProtrailInput.js";
import { createOverlayHealth, type OverlayProbe, type OverlayView } from "./zaicodeProtrailHealth.js";

/**
 * ProTrail over the whole desktop (SRC-062), the way ProTrail itself works:
 * one click-through overlay per monitor, always on top, never focused, never
 * in the taskbar or Alt+Tab, and a system-wide mouse source. The ZAICODE
 * windows own the mode: each sends its config (or null), and the overlays
 * live while any window still wants them, so closing ZAICODE never leaves a
 * trail behind and "all windows closed" still quits the app.
 */

const FLUSH_MS = 4;
const MAX_HELPER_RESTARTS = 3;
const MAX_BATCH = ZAICODE_PROTRAIL_EVENT_STRIDE * 4096;
/**
 * The overlays must converge on their own. A start that ran before the
 * display list settled, a window that failed to load and a renderer that
 * missed the first feed are all recoverable without the operator opening
 * Settings, so each of them schedules another attempt. The first retries are
 * quick; once they stop helping the cadence drops so a permanently broken
 * display costs nothing.
 */
const OVERLAY_RETRY_MS = 250;
const OVERLAY_RETRY_SLOW_MS = 2000;
const OVERLAY_FAST_RETRIES = 20;
/**
 * A click reader that keeps failing (an antivirus scan, a machine still busy with its start) is asked
 * again this often for as long as the mode is wanted, so clicks come back without a toggle.
 */
const HELPER_RETRY_SLOW_MS = 30_000;
/** How long an overlay page gets to answer a health probe. */
const PROBE_TIMEOUT_MS = 1500;
/** A reader is watched this long after "ready"; four cursor moves with no event from it make it silent. */
const READER_WATCH_MS = 15_000;
const READER_WATCH_STEP_MS = 500;
const READER_SILENT_MOVES = 4;

const overlays = new Map<number, BrowserWindow>();
const overlayWindows = new WeakSet<BrowserWindow>();
const overlayBounds = new WeakMap<BrowserWindow, Rectangle>();
const readyOverlays = new WeakSet<BrowserWindow>();
/**
 * Every ZAICODE window that wants the desktop-wide mode, with its config, most
 * recent last. Several main windows each run the ZAICODE runtime; the overlays
 * stay while any of them wants them and follow the latest config. (A single
 * "owner" let the closing of one window switch ProTrail off for all.)
 */
const wanted = new Map<WebContents, unknown>();
const watched = new WeakSet<WebContents>();
let config: unknown = null;
let input: ZaicodeProtrailInput | null = null;
/** The Raw Input reader between its start and its "ready" (the cursor poll runs meanwhile). */
let pending: ZaicodeProtrailInput | null = null;
/** Bumps on every start and stop, so a late compile or restart of an older run is ignored. */
let generation = 0;
let restarts = 0;
let status: ZaicodeProtrailGlobalStatus = { ...ZAICODE_PROTRAIL_GLOBAL_OFF };
let batch: number[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let screenHooked = false;
let overlayRetryTimer: ReturnType<typeof setTimeout> | null = null;
let overlayRetries = 0;
let helperRetryTimer: ReturnType<typeof setTimeout> | null = null;
let readerWatchTimer: ReturnType<typeof setTimeout> | null = null;
/** Which window is on a monitor now and since when: a rebuilt overlay is a new life with a clean record. */
const overlayLife = new WeakMap<BrowserWindow, { serial: number; createdAt: number }>();
let overlaySerial = 0;
let logSink: (message: string) => void = () => undefined;

function log(message: string): void {
  try {
    logSink(message);
  } catch {
    // Logging never breaks the overlays.
  }
}

/** An overlay is not an application window: window pickers, "last window" logic and hotkeys skip it. */
export function isZaicodeProtrailWindow(win: BrowserWindow): boolean {
  return overlayWindows.has(win);
}

export function registerZaicodeProtrailGlobalIpc(options: { log?: (message: string) => void } = {}): void {
  if (options.log) logSink = options.log;
  ipcMain.handle(PlatformChannels.SetZaicodeProtrailGlobal, (event, next: unknown) => setGlobal(event.sender, next));
  ipcMain.handle(PlatformChannels.GetZaicodeProtrailGlobalStatus, () => ({ ...status }));
  app.on("will-quit", stop);
}

function apply(): ZaicodeProtrailGlobalStatus {
  let next: unknown = null;
  for (const value of wanted.values()) next = value;
  if (next === null) {
    stop();
    return { ...status };
  }
  config = next;
  if (status.state === "off") start();
  else {
    broadcast({ config });
    // Repeating the same config used to only rebroadcast, so a start that
    // produced no overlay (displays not enumerated yet) stayed dead until the
    // operator toggled the setting. Reconcile instead: a healthy overlay set
    // makes this a no-op.
    if (!overlaysConverged()) syncOverlays();
  }
  return { ...status };
}

function setGlobal(sender: WebContents, next: unknown): ZaicodeProtrailGlobalStatus {
  wanted.delete(sender);
  if (next && typeof next === "object") {
    wanted.set(sender, next);
    if (!watched.has(sender)) {
      watched.add(sender);
      sender.once("destroyed", () => {
        wanted.delete(sender);
        apply();
      });
    }
  }
  return apply();
}

function setStatus(patch: Partial<ZaicodeProtrailGlobalStatus>): void {
  status = { ...status, ...patch };
}

function start(): void {
  generation += 1;
  restarts = 0;
  overlayRetries = 0;
  status = { state: "starting", input: "none", displays: 0, verified: 0, monitors: screen.getAllDisplays().length, note: null };
  log(`starting the desktop-wide mode for ${wanted.size} window${wanted.size === 1 ? "" : "s"}, ${screen.getAllDisplays().length} display(s)`);
  hookScreen(true);
  syncOverlays();
  startInput(generation);
  health.start();
}

function stop(): void {
  const wasOn = status.state !== "off";
  generation += 1;
  health.stop();
  if (overlayRetryTimer) clearTimeout(overlayRetryTimer);
  overlayRetryTimer = null;
  overlayRetries = 0;
  if (helperRetryTimer) clearTimeout(helperRetryTimer);
  helperRetryTimer = null;
  if (readerWatchTimer) clearTimeout(readerWatchTimer);
  readerWatchTimer = null;
  pending?.stop();
  pending = null;
  input?.stop();
  input = null;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  batch = [];
  hookScreen(false);
  for (const win of overlays.values()) if (!win.isDestroyed()) win.destroy();
  overlays.clear();
  config = null;
  status = { ...ZAICODE_PROTRAIL_GLOBAL_OFF };
  if (wasOn) log("the desktop-wide mode is off");
}

function startInput(run: number): void {
  if (process.platform !== "win32") {
    useCursorPoll("Clicks are read only on Windows (Raw Input); here the trail follows the cursor.");
    return;
  }
  // The trail follows the cursor at once; clicks join when the Raw Input reader
  // reports ready (its first start compiles it, which takes a moment).
  if (!input) useCursorPoll("Starting the click reader…", "starting");
  ensureZaicodeProtrailInputHelper().then(
    (exe) => {
      if (run !== generation || pending || input?.kind === "raw-input") return;
      let delivered = 0;
      // A reader that failed to start, died, or was ready and yet silent: one path for all three.
      const lost = (reason: string): void => {
        if (run !== generation) return;
        if (pending === helper) pending = null;
        if (input === helper) input = null;
        helper.stop();
        restarts += 1;
        log(`the click reader failed (${restarts}): ${reason}`);
        if (restarts > MAX_HELPER_RESTARTS) {
          useCursorPoll(`Clicks are not seen: ${reason}. The trail follows the cursor.`);
          scheduleHelperRetry(run);
          return;
        }
        if (!input) useCursorPoll("Restarting the click reader…", "starting");
        setStatus({ state: "starting", note: `Restarting the click reader: ${reason}` });
        setTimeout(() => {
          if (run === generation && !pending && input?.kind !== "raw-input") startInput(run);
        }, 1000 * restarts);
      };
      const helper = startZaicodeProtrailRawInput(exe, {
        onEvent: (event) => {
          if (input !== helper) return;
          delivered += 1;
          push(event, true);
        },
        onReady: () => {
          if (run !== generation || pending !== helper) return;
          pending = null;
          input?.stop();
          input = helper;
          restarts = 0;
          if (helperRetryTimer) clearTimeout(helperRetryTimer);
          helperRetryTimer = null;
          setStatus({ state: "running", input: "raw-input", note: null });
          log("the click reader is ready");
          watchReaderDelivery(run, helper, () => delivered, lost);
        },
        onFailure: lost,
      });
      pending = helper;
    },
    (error: unknown) => {
      if (run !== generation) return;
      useCursorPoll(`Clicks are not seen: ${error instanceof Error ? error.message : String(error)}. The trail follows the cursor.`);
    },
  );
}

/**
 * A reader that said "ready" and has delivered nothing while the cursor demonstrably moved is as good as
 * dead: a registration that took but does not deliver, a message pump that stalled. It replaced the cursor
 * poll on "ready", so from then on the trail would follow nothing. A few different cursor positions in the
 * first seconds with not one event from the reader count as that, and it is handled like a reader that
 * failed: restarted, and after the usual tries the cursor poll carries the trail. Cursor moves that raw
 * input cannot see (another program placing the pointer) are few and short, so four are asked for.
 */
function watchReaderDelivery(run: number, helper: ZaicodeProtrailInput, delivered: () => number, lost: (reason: string) => void): void {
  const startedAt = Date.now();
  let last: { x: number; y: number } | null = null;
  let moves = 0;
  const check = (): void => {
    readerWatchTimer = null;
    if (run !== generation || input !== helper || delivered() > 0) return;
    const point = screen.getCursorScreenPoint();
    if (last && (point.x !== last.x || point.y !== last.y)) moves += 1;
    last = { x: point.x, y: point.y };
    if (moves >= READER_SILENT_MOVES) {
      lost("it was ready but delivered nothing while the cursor moved");
      return;
    }
    if (Date.now() - startedAt >= READER_WATCH_MS) return;
    readerWatchTimer = setTimeout(check, READER_WATCH_STEP_MS);
    (readerWatchTimer as { unref?: () => void }).unref?.();
  };
  if (readerWatchTimer) clearTimeout(readerWatchTimer);
  readerWatchTimer = setTimeout(check, READER_WATCH_STEP_MS);
  (readerWatchTimer as { unref?: () => void }).unref?.();
}

/**
 * The reader gave up for now. Give it another go every half minute while the mode is wanted: the reason
 * (a busy machine right after the start, a scan of the helper) rarely lasts, and the operator should not
 * have to switch ProTrail off and on to get the clicks back.
 */
function scheduleHelperRetry(run: number): void {
  if (helperRetryTimer) clearTimeout(helperRetryTimer);
  helperRetryTimer = setTimeout(() => {
    helperRetryTimer = null;
    if (run !== generation || wanted.size === 0 || pending || input?.kind === "raw-input") return;
    log("trying the click reader again");
    startInput(run);
  }, HELPER_RETRY_SLOW_MS);
  (helperRetryTimer as { unref?: () => void }).unref?.();
}

function useCursorPoll(note: string, state: ZaicodeProtrailGlobalStatus["state"] = "running"): void {
  if (input?.kind !== "cursor-poll") {
    input?.stop();
    input = startZaicodeProtrailCursorPoll({ onEvent: (event) => push(event, false) });
  }
  setStatus({ state, input: "cursor-poll", note });
}

function push(event: ZaicodeProtrailInputEvent, physical: boolean): void {
  let { x, y } = event;
  if (physical && process.platform === "win32") {
    try {
      const dip = screen.screenToDipPoint({ x, y });
      x = dip.x;
      y = dip.y;
    } catch {
      // Keep the physical point; wrong only on a scaled monitor.
    }
  }
  batch.push(event.kind, event.button, x, y, event.t);
  // Overlays that stall must not grow this forever; the oldest events go first.
  if (batch.length > MAX_BATCH) batch.splice(0, batch.length - MAX_BATCH);
  flushTimer ??= setTimeout(flush, FLUSH_MS);
}

function flush(): void {
  flushTimer = null;
  if (batch.length === 0) return;
  const events = batch;
  batch = [];
  // Every overlay gets every event: a trail or a hold crossing monitors stays whole.
  broadcast({ events });
}

function send(win: BrowserWindow, feed: ZaicodeProtrailOverlayFeed): void {
  if (!win.isDestroyed() && !win.webContents.isDestroyed() && readyOverlays.has(win)) {
    win.webContents.send(PlatformChannels.ZaicodeProtrailOverlayFeed, feed);
  }
}

function broadcast(feed: ZaicodeProtrailOverlayFeed): void {
  for (const win of overlays.values()) send(win, feed);
}

function hookScreen(on: boolean): void {
  if (on === screenHooked) return;
  screenHooked = on;
  if (on) {
    screen.on("display-added", syncOverlays);
    screen.on("display-removed", syncOverlays);
    screen.on("display-metrics-changed", syncOverlays);
  } else {
    screen.removeListener("display-added", syncOverlays);
    screen.removeListener("display-removed", syncOverlays);
    screen.removeListener("display-metrics-changed", syncOverlays);
  }
}

function syncOverlays(): void {
  const displays = screen.getAllDisplays();
  const ids = new Set(displays.map((display) => display.id));
  for (const [id, win] of overlays) {
    if (ids.has(id) && !win.isDestroyed()) continue;
    overlays.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
  for (const display of displays) {
    const existing = overlays.get(display.id);
    if (!existing) {
      overlays.set(display.id, createOverlay(display));
      continue;
    }
    // Only a moved or resized overlay needs to be told again: re-sending on every
    // reconcile would push a feed between the config broadcast and the
    // overlay's next load, and the document is what applies it. A change of size
    // alone counts (a monitor that settles on its real mode after the start keeps
    // its origin): the window used to stay at the old, smaller size.
    const previous = overlayBounds.get(existing);
    overlayBounds.set(existing, display.bounds);
    if (previous && sameRect(previous, display.bounds)) continue;
    existing.setBounds(display.bounds);
    send(existing, { origin: { x: display.bounds.x, y: display.bounds.y } });
  }
  settleOverlayRetry();
}

/**
 * Republish the overlay state and re-arm (or drop) the reconcile timer. Called
 * from the sync itself and from every event that changes whether an overlay is
 * loaded, so the status never lags the windows it describes.
 */
function settleOverlayRetry(): void {
  if (overlayRetryTimer) {
    clearTimeout(overlayRetryTimer);
    overlayRetryTimer = null;
  }
  setStatus({ displays: countReadyOverlays(), verified: health.verified(), monitors: screen.getAllDisplays().length });
  if (overlaysConverged()) overlayRetries = 0;
  else scheduleOverlayRetry();
}

/** One live, loaded overlay per connected display: the state ProTrail claims to be in. */
function overlaysConverged(): boolean {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return false;
  return displays.every((display) => {
    const win = overlays.get(display.id);
    return !!win && !win.isDestroyed() && readyOverlays.has(win);
  });
}

function countReadyOverlays(): number {
  let ready = 0;
  for (const win of overlays.values()) if (!win.isDestroyed() && readyOverlays.has(win)) ready += 1;
  return ready;
}

/** Re-run the sync until the overlays are there, at a cadence that stops costing anything if they never are. */
function scheduleOverlayRetry(): void {
  if (overlayRetryTimer) return;
  if (wanted.size === 0) return;
  overlayRetries += 1;
  const delay = overlayRetries > OVERLAY_FAST_RETRIES ? OVERLAY_RETRY_SLOW_MS : OVERLAY_RETRY_MS;
  overlayRetryTimer = setTimeout(() => {
    overlayRetryTimer = null;
    if (wanted.size === 0) return;
    syncOverlays();
  }, delay);
  // A background reconcile must never be the reason a process stays alive.
  (overlayRetryTimer as { unref?: () => void }).unref?.();
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function isProbe(value: unknown): value is OverlayProbe {
  const probe = value as Partial<OverlayProbe> | null;
  return (
    !!probe &&
    typeof probe.configured === "boolean" &&
    typeof probe.enabled === "boolean" &&
    typeof probe.frames === "boolean" &&
    typeof probe.width === "number" &&
    typeof probe.height === "number"
  );
}

/** Asks an overlay page what it holds (zaicode-protrail.ts answers). No answer in time, or none at all, is null. */
async function probeOverlay(win: BrowserWindow): Promise<OverlayProbe | null> {
  try {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const silence = new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
      (deadline as { unref?: () => void }).unref?.();
    });
    const answer = await Promise.race([
      win.webContents.executeJavaScript("window.__zaicodeProtrailProbe ? window.__zaicodeProtrailProbe() : null", false),
      silence,
    ]).finally(() => clearTimeout(deadline));
    return isProbe(answer) ? answer : null;
  } catch {
    return null;
  }
}

/** One view per display that has an overlay, for the health check. */
function overlayViews(): OverlayView[] {
  const views: OverlayView[] = [];
  for (const display of screen.getAllDisplays()) {
    const win = overlays.get(display.id);
    const life = win ? overlayLife.get(win) : undefined;
    if (!win || win.isDestroyed() || !life) continue;
    views.push({
      displayId: display.id,
      serial: life.serial,
      createdAt: life.createdAt,
      ready: readyOverlays.has(win),
      visible: win.isVisible(),
      placed: sameRect(win.getBounds(), display.bounds),
      expected: { width: display.bounds.width, height: display.bounds.height },
      probe: () => probeOverlay(win),
    });
  }
  return views;
}

/** The window a view describes, unless it has been replaced since the check looked. */
function currentOverlay(view: OverlayView): BrowserWindow | null {
  const win = overlays.get(view.displayId);
  if (!win || win.isDestroyed() || overlayLife.get(win)?.serial !== view.serial) return null;
  return win;
}

const health = createOverlayHealth({
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  wanted: () => wanted.size > 0,
  views: overlayViews,
  repairs: {
    reveal: (view) => {
      const win = currentOverlay(view);
      if (win) revealOverlay(win);
    },
    place: (view) => {
      const win = currentOverlay(view);
      const display = screen.getAllDisplays().find((candidate) => candidate.id === view.displayId);
      if (!win || !display) return;
      overlayBounds.set(win, display.bounds);
      win.setBounds(display.bounds);
      send(win, { origin: { x: display.bounds.x, y: display.bounds.y } });
    },
    resend: (view) => {
      const win = currentOverlay(view);
      const bounds = win ? overlayBounds.get(win) : undefined;
      if (win) send(win, { config, ...(bounds ? { origin: { x: bounds.x, y: bounds.y } } : {}) });
    },
    rebuild: (view) => {
      const win = currentOverlay(view);
      if (!win) return;
      readyOverlays.delete(win);
      overlays.delete(view.displayId);
      win.destroy();
      syncOverlays();
    },
  },
  onChange: () => setStatus({ verified: health.verified() }),
  log,
});

/** Show the overlay once its document is loaded. Idempotent: a reload must reveal it again. */
function revealOverlay(win: BrowserWindow): void {
  if (win.isDestroyed() || !readyOverlays.has(win) || win.isVisible()) return;
  win.setBounds(overlayBounds.get(win) ?? win.getBounds());
  win.showInactive();
  win.setAlwaysOnTop(true, "screen-saver");
}

function createOverlay(display: Display): BrowserWindow {
  const bounds = display.bounds;
  const win = new BrowserWindow({
    ...bounds,
    title: "ZAICODE ProTrail",
    // Windows 工具窗口不会被 FancyZones 当作普通新窗口移到当前显示器；skipTaskbar 不够。
    ...(process.platform === "win32" ? { type: "toolbar" } : {}),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/zaicodeProtrailOverlay.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  overlayWindows.add(win);
  overlayBounds.set(win, bounds);
  overlayLife.set(win, { serial: (overlaySerial += 1), createdAt: Date.now() });
  log(`overlay ${display.id} created at ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
  // WS_EX_TRANSPARENT + WS_EX_LAYERED: every click goes to the app underneath.
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // did-finish-load 时 isLoading() 仍为 true，会丢失副屏原点；按文档就绪状态发送。
  win.webContents.on("did-start-loading", () => readyOverlays.delete(win));
  win.webContents.on("did-finish-load", () => {
    readyOverlays.add(win);
    log(`overlay ${display.id} loaded after ${Date.now() - (overlayLife.get(win)?.createdAt ?? Date.now())} ms`);
    const current = overlayBounds.get(win) ?? bounds;
    send(win, { config, origin: { x: current.x, y: current.y } });
    revealOverlay(win);
    settleOverlayRetry();
  });
  // A blank overlay is worse than no overlay: the desktop is covered by a
  // click-through nothing and nothing else in the app can see it. Drop it and
  // let the sync build a fresh one.
  win.webContents.on("did-fail-load", () => {
    readyOverlays.delete(win);
    if (!win.isDestroyed()) win.destroy();
    settleOverlayRetry();
  });
  win.webContents.on("render-process-gone", () => {
    readyOverlays.delete(win);
    if (!win.isDestroyed()) win.destroy();
    settleOverlayRetry();
  });
  // on, not once: after a document reload only did-finish-load fires again, and
  // a window that never comes back would stay loaded but invisible.
  win.on("ready-to-show", () => revealOverlay(win));
  win.on("closed", () => {
    for (const [id, candidate] of overlays) if (candidate === win) overlays.delete(id);
    settleOverlayRetry();
  });
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/zaicode-protrail.html`);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/zaicode-protrail.html"));
  }
  return win;
}
