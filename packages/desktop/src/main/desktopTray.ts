import { app, Menu, Tray } from "electron";
import { join } from "node:path";
import {
  DesktopCommandIds,
  desktopMenuMessageIds,
  getDesktopMenuMessage,
  isZaicodeProductMode,
  ZCODE_PRODUCT_FLAVOR,
  type DesktopCommandId,
  type Locale,
} from "@zcode/shared";
import { runZaicodeWindowAction } from "./zaicodeGlobalHotkeys.js";
import { showZaicodeTrayMenu } from "./zaicodeTrayMenu.js";
import { ZAICODE_TRAY_MENU } from "./zaicodeTrayMenuModel.js";

let desktopTray: Tray | null = null;
let rebuildDesktopTrayContextMenu: (() => void) | null = null;
/** ZAICODE: one line of engine quota appended to the tray tooltip (LIMISAW's "every limit in your tray"). */
let desktopTrayLimitsLine = "";
let desktopTrayBaseLabel = "";

export function setWindowsDesktopTrayLimits(line: string): void {
  const next = line.trim();
  if (next === desktopTrayLimitsLine) return;
  desktopTrayLimitsLine = next;
  if (!desktopTray) return;
  // The shell truncates tray tooltips at 127 characters.
  desktopTray.setToolTip(next ? `${desktopTrayBaseLabel}\n${next}`.slice(0, 127) : desktopTrayBaseLabel);
}

function resolveDesktopTrayIconPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "tray_icon.ico")
    : join(import.meta.dirname, "../../build/icon.ico");
}

export function createWindowsDesktopTray(options: {
  getLocale: () => Locale;
  showCurrentWindow: () => Promise<void> | void;
  executeDesktopCommand: (command: DesktopCommandId) => Promise<unknown>;
  quitApp: () => void;
  logger: { warn: (...args: unknown[]) => void };
}) {
  if (process.platform !== "win32") {
    return null;
  }

  if (desktopTray) {
    return desktopTray;
  }

  try {
    desktopTray = new Tray(resolveDesktopTrayIconPath());
  } catch (error) {
    options.logger.warn("[desktop-tray] failed to create tray icon", error);
    return null;
  }

  const getLabel = (id: (typeof desktopMenuMessageIds)[keyof typeof desktopMenuMessageIds]) =>
    getDesktopMenuMessage(options.getLocale(), id);
  const showTrayWindow = () => {
    void Promise.resolve(options.showCurrentWindow()).catch((error) => {
      options.logger.warn("[desktop-tray] failed to show current window", error);
    });
  };
  const executeTrayCommand = (command: DesktopCommandId) => {
    void Promise.resolve(options.showCurrentWindow())
      .then(() => options.executeDesktopCommand(command))
      .catch((error) => {
        options.logger.warn(`[desktop-tray] failed to execute tray command ${command}`, error);
      });
  };
  const rebuildContextMenu = () => {
    const trayLabel = getLabel(desktopMenuMessageIds.trayTooltip);
    desktopTrayBaseLabel = trayLabel;
    desktopTray?.setToolTip(
      desktopTrayLimitsLine ? `${trayLabel}\n${desktopTrayLimitsLine}`.slice(0, 127) : trayLabel,
    );
    desktopTray?.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: getLabel(desktopMenuMessageIds.trayOpenZCode),
          click: showTrayWindow,
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.fileNewTask),
          click: () => executeTrayCommand(DesktopCommandIds.NewTask),
        },
        {
          label: getLabel(desktopMenuMessageIds.fileOpenWorkspace),
          click: () => executeTrayCommand(DesktopCommandIds.OpenWorkspace),
        },
        { type: "separator" },
        // 更新入口跟随产品身份：Preview（含生产后端的 Preview）禁用更新器，托盘也不能露出入口。
        ...(ZCODE_PRODUCT_FLAVOR === "production"
          ? [
              {
                label: getLabel(desktopMenuMessageIds.helpCheckForUpdates),
                click: () => executeTrayCommand(DesktopCommandIds.CheckForUpdates),
              },
            ]
          : []),
        {
          label: getLabel(desktopMenuMessageIds.helpAbout),
          click: () => executeTrayCommand(DesktopCommandIds.ShowAbout),
        },
        {
          label: getLabel(desktopMenuMessageIds.helpClearAllData),
          click: () => executeTrayCommand(DesktopCommandIds.ClearAllData),
        },
        { type: "separator" },
        {
          label: getLabel(desktopMenuMessageIds.trayQuit),
          click: () => options.quitApp(),
        },
      ]),
    );
  };

  if (isZaicodeProductMode()) {
    const runTrayPick = (id: string) => {
      if (id === "open") showTrayWindow();
      else if (id === "quit") options.quitApp();
      else if (id === "newTask") executeTrayCommand(DesktopCommandIds.NewTask);
      else {
        void Promise.resolve(options.showCurrentWindow())
          .then(() => runZaicodeWindowAction(`tray.${id}`))
          .catch((error) => options.logger.warn(`[desktop-tray] failed to run tray pick ${id}`, error));
      }
    };
    rebuildDesktopTrayContextMenu = () => {
      desktopTrayBaseLabel = "ZAICODE";
      desktopTray?.setToolTip(
        desktopTrayLimitsLine ? `ZAICODE\n${desktopTrayLimitsLine}`.slice(0, 127) : "ZAICODE",
      );
    };
    desktopTray.on("right-click", () => showZaicodeTrayMenu(ZAICODE_TRAY_MENU, runTrayPick));
    desktopTray.on("click", showTrayWindow);
    desktopTray.on("double-click", showTrayWindow);
    rebuildDesktopTrayContextMenu();
    return desktopTray;
  }

  rebuildDesktopTrayContextMenu = rebuildContextMenu;
  desktopTray.on("click", showTrayWindow);
  desktopTray.on("double-click", showTrayWindow);
  rebuildContextMenu();

  return desktopTray;
}

export function updateWindowsDesktopTrayMenu() {
  rebuildDesktopTrayContextMenu?.();
}
