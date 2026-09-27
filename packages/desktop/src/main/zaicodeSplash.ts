import { app, BrowserWindow, screen, type Rectangle } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { zaicodeSplashSize, type ZaicodeSplashScale } from "@zcode/shared";
import { readZaicodeLauncherPreferences, zaicodeSplashOptionsOf } from "./zaicodeLauncherPreferences.js";
import { refreshZaicodeCustomSplashPage } from "./zaicodeSplashFiles.js";
import { zaicodeSplashCustomDir } from "./zaicodeSplashPrefs.js";

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
 * invisible. A main window that never gets ready is shown after the operator's
 * longest wait (Settings, SRC-060) anyway; the splash never outlives it.
 */

/** A little longer than the renderer's own fallback, so the renderer decides first. */
const HOLD_MARGIN_MS = 5_000;
const READY_POLL_MS = 200;
/** The main window paints before the splash goes, so nothing flashes in between. */
const CLOSE_DELAY_MS = 120;

let splash: BrowserWindow | null = null;
let holdTimer: ReturnType<typeof setTimeout> | null = null;
/** Main windows waiting hidden -> whether to maximize them when shown. */
const held = new Map<BrowserWindow, boolean>();
let holding = false;

/** Full path of the splash page: the operator's own picture first, else the bundled one. */
function splashPagePath(): string | null {
  // SRC-049, Settings -> ZAICODE -> Start-up: a custom picture lives in
  // userData/zaicode-splash/ with its own generated page.
  // SRC-060: a page written by an older template is rewritten first.
  if (refreshZaicodeCustomSplashPage(zaicodeSplashCustomDir())) {
    return join(zaicodeSplashCustomDir(), "zaicode-splash.html");
  }
  const candidates = [
    join(process.resourcesPath ?? "", "zaicode-splash"),
    join(app.getAppPath(), "build", "zaicode-splash"),
    join(app.getAppPath(), "..", "build", "zaicode-splash"),
    join(app.getAppPath(), "..", "..", "build", "zaicode-splash"),
  ];
  for (const dir of candidates) {
    const page = join(dir, "splash.html");
    if (existsSync(page)) return page;
  }
  return null;
}

/** Centre of the primary work area, whole pixels (the launcher uses the same rule). */
export function zaicodeSplashBounds(
  scale: ZaicodeSplashScale = 1,
  area: Rectangle = screen.getPrimaryDisplay().workArea,
): Rectangle {
  const { width, height } = zaicodeSplashSize(scale);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

/** Shows the splash at once; main windows created while it is up wait hidden. */
export function showZaicodeSplash(): void {
  if (splash || process.env.ZAICODE_NO_SPLASH === "1") return;
  holding = true;
  const preferences = readZaicodeLauncherPreferences();
  const options = zaicodeSplashOptionsOf(preferences);
  // The main window waits hidden until it is ready whatever the picture does:
  // splash off (SRC-049) means nothing shows at all, then the app appears loaded.
  holdTimer = setTimeout(() => {
    for (const win of held.keys()) revealZaicodeWindow(win);
    finishZaicodeSplash();
  }, options.maxWaitSec * 1000 + HOLD_MARGIN_MS);
  const splashPage = preferences.splashEnabled ? splashPagePath() : null;
  if (!splashPage) return;
  splash = new BrowserWindow({
    ...zaicodeSplashBounds(options.scale),
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
  const query: Record<string, string> = { fit: options.fit, status: options.status ? "1" : "0" };
  if (version) query.v = version;
  void splash.loadFile(splashPage, { query }).catch(() => undefined);
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

/**
 * True for the splash window itself. It must never count as an application
 * window: the primary-window coordinator "reuses" the first window it sees, so
 * an unfiltered splash made app-ready skip main-window creation entirely and
 * the app stayed a picture forever (SRC-050).
 */
export function isZaicodeSplashWindow(win: BrowserWindow): boolean {
  return win === splash;
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
