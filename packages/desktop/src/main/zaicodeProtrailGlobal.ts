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

/** An overlay is not an application window: window pickers, "last window" logic and hotkeys skip it. */
export function isZaicodeProtrailWindow(win: BrowserWindow): boolean {
  return overlayWindows.has(win);
}

export function registerZaicodeProtrailGlobalIpc(): void {
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
  else broadcast({ config });
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
  status = { state: "starting", input: "none", displays: 0, note: null };
  hookScreen(true);
  syncOverlays();
  startInput(generation);
}

function stop(): void {
  generation += 1;
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
      const helper = startZaicodeProtrailRawInput(exe, {
        onEvent: (event) => {
          if (input === helper) push(event, true);
        },
        onReady: () => {
          if (run !== generation || pending !== helper) return;
          pending = null;
          input?.stop();
          input = helper;
          setStatus({ state: "running", input: "raw-input", note: null });
        },
        onFailure: (reason) => {
          if (run !== generation) return;
          if (pending === helper) pending = null;
          if (input === helper) input = null;
          helper.stop();
          restarts += 1;
          if (restarts > MAX_HELPER_RESTARTS) {
            useCursorPoll(`Clicks are not seen: ${reason}. The trail follows the cursor.`);
            return;
          }
          if (!input) useCursorPoll("Restarting the click reader…", "starting");
          setStatus({ state: "starting", note: `Restarting the click reader: ${reason}` });
          setTimeout(() => {
            if (run === generation && !pending && input?.kind !== "raw-input") startInput(run);
          }, 1000 * restarts);
        },
      });
      pending = helper;
    },
    (error: unknown) => {
      if (run !== generation) return;
      useCursorPoll(`Clicks are not seen: ${error instanceof Error ? error.message : String(error)}. The trail follows the cursor.`);
    },
  );
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
    if (existing) {
      overlayBounds.set(existing, display.bounds);
      existing.setBounds(display.bounds);
      send(existing, { origin: { x: display.bounds.x, y: display.bounds.y } });
    } else {
      overlays.set(display.id, createOverlay(display));
    }
  }
  setStatus({ displays: overlays.size });
}

function createOverlay(display: Display): BrowserWindow {
  const bounds = display.bounds;
  const win = new BrowserWindow({
    ...bounds,
    title: "ZAICODE ProTrail",
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
  // WS_EX_TRANSPARENT + WS_EX_LAYERED: every click goes to the app underneath.
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // did-finish-load 时 isLoading() 仍为 true，会丢失副屏原点；按文档就绪状态发送。
  win.webContents.on("did-start-loading", () => readyOverlays.delete(win));
  win.webContents.on("did-finish-load", () => {
    readyOverlays.add(win);
    const current = overlayBounds.get(win) ?? bounds;
    send(win, { config, origin: { x: current.x, y: current.y } });
  });
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    // A window created on a monitor with another scale can come up mis-sized; set it again.
    win.setBounds(overlayBounds.get(win) ?? bounds);
    win.showInactive();
    win.setAlwaysOnTop(true, "screen-saver");
  });
  win.on("closed", () => {
    for (const [id, candidate] of overlays) if (candidate === win) overlays.delete(id);
  });
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    void win.loadURL(`${process.env["ELECTRON_RENDERER_URL"]}/zaicode-protrail.html`);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/zaicode-protrail.html"));
  }
  return win;
}
