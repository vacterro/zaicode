import { app, BrowserWindow, globalShortcut } from "electron";

/**
 * ZAICODE global hotkeys (FastPrompter's RegisterHotKey pair, via Electron
 * globalShortcut): they work while another app has the focus. "Show / hide"
 * is handled here; every other action brings ZAICODE forward only when it
 * needs the window, then the renderer runs it. A combination another app
 * already owns is reported as "taken", never silently skipped.
 */

export const ZAICODE_GLOBAL_HOTKEY_CHANNEL = "zaicode:global-hotkey";

export type ZaicodeGlobalHotkeyStatus = "ok" | "taken" | "invalid";

/** Actions that do not need ZAICODE in front to do their job. */
const BACKGROUND_ACTIONS = new Set(["global.tempTimer", "global.productivity", "global.stopSounds"]);

let registered: string[] = [];
let quitHooked = false;

function mainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  return BrowserWindow.getFocusedWindow() ?? windows.find((window) => window.isVisible()) ?? windows[0] ?? null;
}

function bringForward(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
}

function toggleWindow(): void {
  const window = mainWindow();
  if (!window) return;
  if (window.isVisible() && window.isFocused() && !window.isMinimized()) window.minimize();
  else bringForward(window);
}

/** Runs a ZAICODE window action by id (global hotkeys, tray menu picks "tray.*"). */
export function runZaicodeWindowAction(id: string): void {
  run(id);
}

function run(id: string): void {
  if (id === "global.toggleWindow") {
    toggleWindow();
    return;
  }
  const window = mainWindow();
  if (!window) return;
  if (!BACKGROUND_ACTIONS.has(id)) bringForward(window);
  window.webContents.send(ZAICODE_GLOBAL_HOTKEY_CHANNEL, id);
}

export function setZaicodeGlobalHotkeys(raw: unknown): Record<string, ZaicodeGlobalHotkeyStatus> {
  for (const accelerator of registered) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      // already gone
    }
  }
  registered = [];
  if (!quitHooked) {
    quitHooked = true;
    // A global hotkey outliving the app would keep the key swallowed system-wide.
    app.once("will-quit", () => clearZaicodeGlobalHotkeys());
  }
  const status: Record<string, ZaicodeGlobalHotkeyStatus> = {};
  if (!Array.isArray(raw)) return status;
  for (const entry of raw.slice(0, 32)) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    const accelerator = typeof entry?.accelerator === "string" ? entry.accelerator : "";
    if (!id.startsWith("global.") || !accelerator) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => run(id));
    } catch {
      status[id] = "invalid";
      continue;
    }
    if (ok) registered.push(accelerator);
    // one binding of an action failing must not hide that the other one works
    if (status[id] !== "ok") status[id] = ok ? "ok" : "taken";
  }
  return status;
}

export function clearZaicodeGlobalHotkeys(): void {
  setZaicodeGlobalHotkeys([]);
}
