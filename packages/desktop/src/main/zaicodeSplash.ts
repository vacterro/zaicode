import { app, BrowserWindow, screen, type Rectangle } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * ZAICODE start-up splash (SRC-048). The operator used to get a grey window
 * across the whole screen for half a minute while the interface loaded. Now
 * only a picture appears at once (the SAIPEN splash, a small rectangle like an
 * old game or After Effects), and the main window stays hidden until its
 * renderer says it is ready (`zcode-startup-ready` on <body>), then replaces
 * the splash in one step.
 *
 * Same size and place (centre of the primary work area) as the root
 * launcher's splash (tools/launcher), so the hand-over between the two is
 * invisible. A main window that never gets ready is shown after MAX_HOLD_MS
 * anyway; the splash never outlives it.
 */

export const ZAICODE_SPLASH_WIDTH = 560;
export const ZAICODE_SPLASH_HEIGHT = 300;
const MAX_HOLD_MS = 90_000;
const READY_POLL_MS = 200;
/** The main window paints before the splash goes, so nothing flashes in between. */
const CLOSE_DELAY_MS = 120;

let splash: BrowserWindow | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** Main windows waiting hidden -> whether to maximize them when shown. */
const held = new Map<BrowserWindow, boolean>();
let holding = false;

function splashDir(): string | null {
  const candidates = [
    join(process.resourcesPath ?? "", "zaicode-splash"),
    join(app.getAppPath(), "build", "zaicode-splash"),
    join(app.getAppPath(), "..", "build", "zaicode-splash"),
    join(app.getAppPath(), "..", "..", "build", "zaicode-splash"),
  ];
  return candidates.find((dir) => existsSync(join(dir, "splash.html"))) ?? null;
}

/** Centre of the primary work area, whole pixels (the launcher uses the same rule). */
export function zaicodeSplashBounds(area: Rectangle = screen.getPrimaryDisplay().workArea): Rectangle {
  return {
    x: Math.round(area.x + (area.width - ZAICODE_SPLASH_WIDTH) / 2),
    y: Math.round(area.y + (area.height - ZAICODE_SPLASH_HEIGHT) / 2),
    width: ZAICODE_SPLASH_WIDTH,
    height: ZAICODE_SPLASH_HEIGHT,
  };
}

/** Shows the splash at once; main windows created while it is up wait hidden. */
export function showZaicodeSplash(): void {
  if (splash || process.env.ZAICODE_NO_SPLASH === "1") return;
  const dir = splashDir();
  if (!dir) return;
  holding = true;
  splash = new BrowserWindow({
    ...zaicodeSplashBounds(),
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: "#1A1810",
    title: "ZAICODE",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
  });
  splash.once("ready-to-show", () => splash?.show());
  splash.on("closed", () => {
    splash = null;
  });
  // The product version comes from the root launcher (workspace VERSION); the app's own number is upstream's.
  const version = process.env.ZAICODE_VERSION?.trim() ?? "";
  void splash.loadFile(join(dir, "splash.html"), { query: version ? { v: version } : {} }).catch(() => undefined);
  holdTimer = setTimeout(() => {
    for (const win of held.keys()) revealZaicodeWindow(win);
    finishZaicodeSplash();
  }, MAX_HOLD_MS);
}

export function setZaicodeSplashStatus(text: string): void {
  if (!splash || splash.isDestroyed()) return;
  void splash.webContents
    .executeJavaScript(`window.zaicodeSplashStatus && window.zaicodeSplashStatus(${JSON.stringify(text)})`)
    .catch(() => undefined);
}

/** True while a new main window must be created hidden (the splash stands in for it). */
export function zaicodeSplashHolds(): boolean {
  return holding;
}

/** True while this main window waits hidden for its renderer. */
export function isZaicodeWindowHeld(win: BrowserWindow): boolean {
  return held.has(win);
}

function finishZaicodeSplash(): void {
  holding = false;
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  const closing = splash;
  splash = null;
  if (closing && !closing.isDestroyed()) setTimeout(() => closing.destroy(), CLOSE_DELAY_MS);
}

function revealZaicodeWindow(win: BrowserWindow): void {
  const maximize = held.get(win) ?? false;
  held.delete(win);
  if (win.isDestroyed()) return;
  if (maximize) win.maximize();
  win.show();
  win.focus();
  if (held.size === 0) finishZaicodeSplash();
}

/**
 * Keeps a freshly created main window hidden until its renderer marks itself
 * ready, then shows it (maximized when it was) and closes the splash.
 */
export function holdZaicodeMainWindow(win: BrowserWindow, maximize: boolean): void {
  held.set(win, maximize);
  setZaicodeSplashStatus("Loading the interface…");
  let poll: ReturnType<typeof setInterval> | null = null;
  let asking = false;
  const stop = () => {
    if (poll) clearInterval(poll);
    poll = null;
  };
  // Ask only once the document exists: executeJavaScript on a loading page waits for the load,
  // and a question every 200 ms would pile up listeners until then.
  win.webContents.once("dom-ready", () => {
    setZaicodeSplashStatus("Starting the workspace…");
    poll = setInterval(() => {
      if (win.isDestroyed() || !held.has(win)) {
        stop();
        return;
      }
      if (asking) return;
      asking = true;
      void win.webContents
        .executeJavaScript("Boolean(document.body && document.body.classList.contains('zcode-startup-ready'))", true)
        .then((ready: unknown) => {
          if (ready === true && held.has(win)) {
            stop();
            revealZaicodeWindow(win);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          asking = false;
        });
    }, READY_POLL_MS);
  });
  win.once("closed", () => {
    stop();
    if (held.delete(win) && held.size === 0) finishZaicodeSplash();
  });
}
