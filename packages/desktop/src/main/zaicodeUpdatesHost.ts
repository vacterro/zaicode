import { BrowserWindow, app, ipcMain } from "electron";
import { join } from "node:path";
import {
  PlatformChannels,
  ZAICODE_UPDATE_CHECK_EVERY_MS,
  ZAICODE_UPDATE_FIRST_CHECK_MS,
  isZaicodeUpdateComponentId,
  type ZaicodeUpdatesState,
} from "@zcode/shared";
import {
  ZaicodeUpdatesController,
  isZaicodeManagedInstall,
  resolveZaicodeInstallRoot,
  zaicodePowershellRunner,
} from "./zaicodeUpdates.js";

/**
 * Electron half of ZAICODE updates (T-134): answers Settings -> ZAICODE ->
 * Updates, tells every window when the state moves, and runs the schedule
 * (a first look a few minutes after the start, then every six hours; the
 * parts set to "update by itself" are updated right after a look finds
 * something). A new app build is staged while ZAICODE runs and starts with
 * the next start, so nothing here ever restarts the app.
 */

function broadcast(state: ZaicodeUpdatesState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(PlatformChannels.ZaicodeUpdatesChanged, state);
  }
}

export function registerZaicodeUpdatesIpc(options: { log?: (message: string) => void } = {}): void {
  const log = options.log ?? (() => undefined);
  let appPath: string | undefined;
  try {
    appPath = app.getAppPath();
  } catch {
    appPath = undefined;
  }
  const root = resolveZaicodeInstallRoot({ env: process.env, execPath: process.execPath, ...(appPath ? { appPath } : {}) });
  const managed = isZaicodeManagedInstall(root);
  log(root ? `install ${root} (${managed ? "installed: parts may update by themselves" : "developer checkout: report only by default"})` : "no install folder: updates off");
  const controller = new ZaicodeUpdatesController({
    root,
    managed,
    runner: zaicodePowershellRunner,
    storePath: join(app.getPath("userData"), "zaicode-updates.json"),
    onChange: broadcast,
    log,
  });

  ipcMain.handle(PlatformChannels.GetZaicodeUpdates, () => controller.state());
  ipcMain.handle(PlatformChannels.CheckZaicodeUpdates, () => controller.check());
  ipcMain.handle(PlatformChannels.ApplyZaicodeUpdates, (_event, components: unknown) =>
    controller.apply(Array.isArray(components) ? components.filter(isZaicodeUpdateComponentId) : []),
  );
  ipcMain.handle(PlatformChannels.SetZaicodeUpdateAuto, (_event, request: unknown) => {
    const value = (request ?? {}) as { component?: unknown; enabled?: unknown };
    if (!isZaicodeUpdateComponentId(value.component) || typeof value.enabled !== "boolean") throw new TypeError("Expected { component, enabled }");
    return controller.setAuto(value.component, value.enabled);
  });

  // ZAICODE_UPDATES=off keeps a gate run, a preview window or a test profile from ever asking GitHub.
  if (!root || process.env.ZAICODE_UPDATES === "off" || process.env.ZCODE_ZAICODE_PREVIEW === "1") return;
  const turn = () => {
    void controller.tick().then(
      (result) => {
        if (result.updated.length > 0) log(`updated by itself: ${result.updated.join(", ")}`);
      },
      (error: unknown) => log(`scheduled update failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };
  const first = setTimeout(turn, ZAICODE_UPDATE_FIRST_CHECK_MS);
  const every = setInterval(turn, ZAICODE_UPDATE_CHECK_EVERY_MS);
  first.unref?.();
  every.unref?.();
  app.on("will-quit", () => {
    clearTimeout(first);
    clearInterval(every);
  });
}
