import { BrowserWindow, app, ipcMain, shell } from "electron";
import { PlatformChannels, type ZaicodeCustomizationChange, type ZaicodeCustomizationInfo } from "@zcode/shared";
import {
  ensureZaicodeCustomizationFolders,
  listZaicodeCustomPresets,
  listZaicodeCustomSounds,
  openZaicodeCustomization,
  readZaicodeCustomPreset,
  readZaicodeCustomSound,
  resolveZaicodeCustomizationRoot,
  watchZaicodeCustomization,
  writeZaicodeCustomPreset,
  writeZaicodeCustomSound,
  zaicodeCustomizationInfo,
} from "./zaicodeCustomization.js";

/**
 * Electron half of the customization folder (T-126): resolves where it is, keeps it created, watches it and answers
 * the renderer. zaicodeCustomization.ts holds everything that touches the disk and is tested without electron.
 */

function broadcast(change: ZaicodeCustomizationChange): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(PlatformChannels.ZaicodeCustomizationChanged, change);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * The per-user application data folder, or undefined. Electron throws "Failed to get 'appData' path" on a machine whose profile
 * folders cannot be resolved; the customization folder is a convenience and must never be the reason the app does not start,
 * so the resolver falls back to the home folder instead.
 */
function safeAppData(): string | undefined {
  try {
    return app.getPath("appData");
  } catch {
    return undefined;
  }
}

export function registerZaicodeCustomizationIpc(options: { log?: (message: string) => void } = {}): void {
  const log = options.log ?? (() => undefined);
  const resolved = resolveZaicodeCustomizationRoot({ env: process.env, execPath: process.execPath, appData: safeAppData() });
  const info: ZaicodeCustomizationInfo = zaicodeCustomizationInfo(resolved.root, resolved.source);
  log(`customization folder ${info.root} (${info.source})`);

  // Created first, then watched: a watcher on a folder that does not exist yet would never fire.
  const ready = ensureZaicodeCustomizationFolders(info).then(
    () => {
      const watcher = watchZaicodeCustomization(info, broadcast);
      app.on("will-quit", () => watcher.close());
    },
    (error: unknown) => log(`customization folder could not be created: ${error instanceof Error ? error.message : String(error)}`),
  );

  ipcMain.handle(PlatformChannels.GetZaicodeCustomizationInfo, async () => {
    await ready;
    return info;
  });
  ipcMain.handle(PlatformChannels.ListZaicodeCustomSounds, async () => {
    await ready;
    return listZaicodeCustomSounds(info);
  });
  ipcMain.handle(PlatformChannels.ReadZaicodeCustomSound, (_event, path: unknown) =>
    typeof path === "string" ? readZaicodeCustomSound(info, path) : { ok: false, reason: "expected a path" },
  );
  ipcMain.handle(PlatformChannels.WriteZaicodeCustomSound, async (_event, request: unknown) => {
    if (!isObject(request) || typeof request["path"] !== "string" || !(request["bytes"] instanceof Uint8Array)) return { ok: false, reason: "expected { path, bytes }" };
    await ready;
    return writeZaicodeCustomSound(info, { path: request["path"], bytes: request["bytes"] });
  });
  ipcMain.handle(PlatformChannels.ListZaicodeCustomPresets, async () => {
    await ready;
    return listZaicodeCustomPresets(info);
  });
  ipcMain.handle(PlatformChannels.ReadZaicodeCustomPreset, (_event, name: unknown) =>
    typeof name === "string" ? readZaicodeCustomPreset(info, name) : { ok: false, reason: "expected a file name" },
  );
  ipcMain.handle(PlatformChannels.WriteZaicodeCustomPreset, async (_event, request: unknown) => {
    if (!isObject(request) || typeof request["name"] !== "string" || typeof request["text"] !== "string") return { ok: false, reason: "expected { name, text }" };
    await ready;
    return writeZaicodeCustomPreset(info, { name: request["name"], text: request["text"] });
  });
  ipcMain.handle(PlatformChannels.OpenZaicodeCustomization, (_event, request: unknown) => {
    const kind = isObject(request) ? request["kind"] : null;
    if (kind !== "root" && kind !== "sounds" && kind !== "presets") return { ok: false, message: "expected a kind" };
    const file = isObject(request) && typeof request["file"] === "string" ? request["file"] : undefined;
    return openZaicodeCustomization(info, file === undefined ? { kind } : { kind, file }, {
      openPath: (path) => shell.openPath(path),
      showItemInFolder: (path) => shell.showItemInFolder(path),
    });
  });
}
