import { BrowserWindow, screen } from "electron";
import {
  ZAICODE_TRAY_MENU_WIDTH,
  buildZaicodeTrayMenuHtml,
  placeZaicodeTrayMenu,
  readZaicodeTrayMenuPick,
  zaicodeTrayMenuHeight,
  type ZaicodeTrayMenuEntry,
} from "./zaicodeTrayMenuModel.js";

/** The popup window behind the ZAICODE tray menu (see zaicodeTrayMenuModel.ts). */

let menuWindow: BrowserWindow | null = null;

function closeMenu(): void {
  const window = menuWindow;
  menuWindow = null;
  if (window && !window.isDestroyed()) window.destroy();
}

export function showZaicodeTrayMenu(
  entries: readonly ZaicodeTrayMenuEntry[],
  onPick: (id: string) => void,
): void {
  closeMenu();
  const size = { width: ZAICODE_TRAY_MENU_WIDTH, height: zaicodeTrayMenuHeight(entries) };
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  const position = placeZaicodeTrayMenu(cursor, workArea, size);
  const window = new BrowserWindow({
    ...position,
    ...size,
    useContentSize: true,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#332E22",
    title: "ZAICODE",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  menuWindow = window;
  window.setMenu(null);
  window.webContents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    const id = readZaicodeTrayMenuPick(title);
    if (id === null) return;
    closeMenu();
    if (id) onPick(id);
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("blur", closeMenu);
  window.once("ready-to-show", () => {
    if (window.isDestroyed()) return;
    window.show();
    window.focus();
  });
  void window
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildZaicodeTrayMenuHtml(entries))}`)
    .catch(closeMenu);
}
