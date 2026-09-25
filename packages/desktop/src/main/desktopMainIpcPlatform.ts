/* eslint-disable max-lines -- 桌面平台 IPC 集中装配，拆散会让权限边界更难审计；行数随平台能力增长。 */
import { BrowserWindow, dialog, ipcMain, nativeTheme, screen } from "electron";
import { readZCodeStdioTapDevState } from "@zcode/services/node";
import {
  DesktopCommandIds,
  appSettingsPatchSchema,
  formatZodError,
  localeSchema,
  nonEmptyStringSchema,
  PlatformChannels,
  rendererLogPayloadSchema,
  stringArraySchema,
  type DesktopCommandId,
  type ApplicationIconRequest,
  type Locale,
  type LoadCliMcpFromUserDirectoryRequest,
  type MigrateLegacyCommonMcpRequest,
  type OpenInEditorOptions,
  type SaveCliMcpToUserDirectoryRequest,
  type CreateTempTextAttachmentRequest,
  type UpdateStatePayload,
  type WindowControlsOverlayReadyPayload,
} from "@zcode/shared";
import { getInstalledEditors } from "./editors.js";
import type { ZaicodeRouterCall } from "@zcode/shared";
import {
  callZaicodeRouter,
  getZaicodeRouterInfo,
  openZaicodeRouterDashboard,
  runZaicodeRouterExtraUpdate,
  startZaicodeRouter,
} from "./zaicodeRouter.js";
import { getZaicodeSaipenProjection } from "./zaicodeSaipenProjection.js";
import { showZaicodeNotification } from "./zaicodeNotify.js";
import { getZaicodeRouterHostStatus, setZaicodeRouterMode } from "./zaicodeRouterHost.js";
import {
  addZaicodeFreeKey,
  bootstrapZaicodeRouter,
  readZaicodeFreeScanInfo,
  scanZaicodeFreeModelsNow,
  troubleshootZaicodeRouter,
} from "./zaicodeRouterBootstrap.js";
import { getApplicationIcon } from "./applicationIcons.js";
import { exportLogs } from "./exportLogs.js";
import { resolveCommunityUrl } from "./desktopCommandHandlers.js";
import { openInEditor } from "./openInEditor.js";
import {
  openResourceManager,
  getResourceUsageSnapshot,
  setResourceUsageSamplingActive,
} from "./resourceManagerWindow.js";
import { registerResourceManagerStorageIpc } from "./resourceManagerStorage.js";
import { applyWindowsTitleBarTheme, getWindowOverlayTheme } from "./desktopWindowChrome.js";
import { syncWindowControlsOverlayForZoomLevel } from "./desktopWindowButtonPosition.js";
import { resolveDesktopZoomLevelFromFactor } from "./desktopZoom.js";
import { resolveDesktopWindowChromeState } from "./desktopWindowChromeState.js";
import { handleWindowUnreadCountSync } from "./desktopWindowLifecycle.js";
import { captureWindowScreenshot, openPathInFileManager } from "./desktopMainIpcHelpers.js";
import { registerCuaPermissionIpcHandlers } from "./desktopCuaPermissionIpc.js";
import {
  registerDesktopBrowserIpcHandlers,
  type AttachBrowserGuest,
  type ReportBrowserScreenshotSurfaceReady,
  type UpdateBrowserGuestViewport,
  type BrowserViewResidencyIpcHandlers,
} from "./desktopBrowserViewIpc.js";
import {
  loadCliMcpFromUserDirectory,
  migrateLegacyCommonMcp,
  saveCliMcpToUserDirectory,
} from "./mcpUserDirectory/index.js";
import { createTempTextAttachment } from "./tempTextAttachment.js";
import { registerDesktopSaveFileIpcHandler } from "./desktopSaveFile.js";
import { registerDesktopPrintToPdfIpcHandler } from "./desktopPrintToPdf.js";
import { registerCuaPipActiveSessionIpc } from "./desktopCuaPipIpc.js";
import {
  readZaicodeLauncherPreferences,
  setZaicodeAutoRestartOnCrash,
  setZaicodePixelExact,
  setZaicodeSaimailWorkspace,
} from "./zaicodeLauncherPreferences.js";
import { initZaicodeSaimailWorkspace } from "./zaicodeSaimailInit.js";
import {
  getZaicodeEnginesState,
  getZaicodeStartWithWindows,
  launchZaicodeExternalWorker,
  prepareZaicodeEngineAccountHome,
  refreshZaicodeEngines,
  setZaicodeEnginesConfig,
  setZaicodeStartWithWindows,
} from "./zaicodeEngines.js";
import { saveZaicodeSettingsSnapshot } from "./zaicodeSettingsSnapshot.js";
import { setZaicodeGlobalHotkeys } from "./zaicodeGlobalHotkeys.js";

export function registerPlatformIpcHandlers(options: {
  fetchHelpConfig?: () => Promise<unknown>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  applyApplicationLocale: (locale: Locale) => Promise<void>;
  resolveSystemLocale: () => Locale;
  focusWorkspaceInExistingWindow: (
    path: string,
    extra?: { skipWindowId?: number },
  ) => { activated: boolean; winId?: number };
  windowWorkspaceMap: Map<number, Set<string>>;
  windowUnreadCountMap: Map<number, number>;
  currentApplicationLocale: () => Locale;
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  acknowledgePostUpdateReleaseNotes: (version: string) => Promise<void>;
  syncActiveTaskSession: (windowId: number, sessionId: string | null) => void;
  syncTaskRealtimeWorkspaceKeys: (windowId: number, workspaceKeys: Iterable<string>) => void;
  getUpdateState: () => UpdateStatePayload;
  openUpdateStatusWindow: () => void;
  getDesktopSessionActivity: () => {
    runningAgentSessionCount: number;
  };
  getAutoUpdatePreferences: () => Promise<{
    autoDownloadAndInstallUpdates: boolean;
  }>;
  setAutoDownloadAndInstallUpdates: (enabled: boolean) => Promise<void>;
  syncAppSettings: (patch: unknown) => void;
  /** 快捷键设置页录制态开关：true 时 main 重建菜单摘除可配置 accelerator */
  setShortcutRecordingActive?: (active: boolean, ownerWebContentsId?: number | null) => void;
  /** 桌面端设备标识符（基于 userData 路径的 SHA-256） */
  deviceMid: string;
  /** CDP-on-guest pivot：renderer `<webview>` 上报 guest webContentsId → main attach。 */
  attachBrowserGuest?: AttachBrowserGuest;
  /** renderer 自由尺寸变化 → 当前窗口所属的受控 tab。 */
  updateBrowserGuestViewport?: UpdateBrowserGuestViewport;
  /** 可信 owner renderer 上报的后台截图表面 ready。 */
  reportBrowserScreenshotSurfaceReady?: ReportBrowserScreenshotSurfaceReady;
  /** Browser tab 关闭、挂起、恢复与跨重启 shell IPC。 */
  browserViewResidencyHandlers?: BrowserViewResidencyIpcHandlers;
}) {
  ipcMain.handle(PlatformChannels.SelectDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectFile, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle(PlatformChannels.SelectFiles, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }
    return result.filePaths;
  });

  registerDesktopSaveFileIpcHandler(options.logger);
  registerDesktopPrintToPdfIpcHandler(options.logger);

  ipcMain.handle(
    PlatformChannels.CreateTempTextAttachment,
    async (_event, payload: CreateTempTextAttachmentRequest) => {
      return createTempTextAttachment(payload);
    },
  );

  registerDesktopBrowserIpcHandlers(
    options.attachBrowserGuest,
    options.updateBrowserGuestViewport,
    options.logger,
    options.reportBrowserScreenshotSurfaceReady,
    options.browserViewResidencyHandlers,
  );

  ipcMain.handle(PlatformChannels.ActivateOrSetWorkspace, (event, path: string) => {
    const validatedPath = nonEmptyStringSchema.parse(path);
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    const activated = options.focusWorkspaceInExistingWindow(validatedPath, {
      skipWindowId: senderWin?.id,
    });
    if (activated.activated) {
      return { activated: true };
    }

    if (senderWin) {
      let pathSet = options.windowWorkspaceMap.get(senderWin.id);
      if (!pathSet) {
        pathSet = new Set();
        options.windowWorkspaceMap.set(senderWin.id, pathSet);
        senderWin.on("closed", () => options.windowWorkspaceMap.delete(senderWin.id));
      }
      pathSet.add(validatedPath);
      options.syncTaskRealtimeWorkspaceKeys(senderWin.id, pathSet);
    }
    return { activated: false };
  });

  ipcMain.handle(PlatformChannels.GetResourceUsageSnapshot, (event) =>
    getResourceUsageSnapshot(event.sender.id),
  );
  ipcMain.on(PlatformChannels.SetResourceUsageSamplingActive, (event, active: unknown) => {
    if (typeof active === "boolean") setResourceUsageSamplingActive(event.sender.id, active);
  });
  registerResourceManagerStorageIpc();
  ipcMain.handle(PlatformChannels.GetZCodeStdioTapDevState, () => readZCodeStdioTapDevState());
  ipcMain.on(PlatformChannels.OpenResourceManager, () => {
    openResourceManager();
  });

  ipcMain.handle(
    PlatformChannels.LoadMcpFromUserDirectory,
    async (_event, payload?: LoadCliMcpFromUserDirectoryRequest) => {
      return loadCliMcpFromUserDirectory(payload);
    },
  );

  ipcMain.handle(
    PlatformChannels.SaveMcpToUserDirectory,
    async (_event, payload: SaveCliMcpToUserDirectoryRequest) => {
      try {
        await saveCliMcpToUserDirectory(payload);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn("[mcp-user-directory] save failed", message);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PlatformChannels.MigrateLegacyCommonMcp,
    async (_event, payload?: MigrateLegacyCommonMcpRequest) => {
      return migrateLegacyCommonMcp(payload);
    },
  );

  ipcMain.handle(PlatformChannels.SetTitleBarTheme, (event, theme: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow) {
      return;
    }

    if (theme !== "light" && theme !== "dark" && theme !== "system") {
      options.logger.warn("[title-bar-theme] invalid theme:", theme);
      return;
    }

    nativeTheme.themeSource = theme;
    applyWindowsTitleBarTheme(senderWindow, theme === "system" ? getWindowOverlayTheme() : theme);
  });

  ipcMain.handle(PlatformChannels.SetApplicationLocale, (_event, locale: unknown) => {
    const result = localeSchema.safeParse(locale);
    if (!result.success) {
      options.logger.warn("[application-locale] invalid locale:", formatZodError(result.error));
      return;
    }

    return options.applyApplicationLocale(result.data);
  });

  ipcMain.handle(PlatformChannels.GetSystemLocale, () => options.resolveSystemLocale());

  ipcMain.on(PlatformChannels.SyncWindowTabs, (event, paths: string[]) => {
    const result = stringArraySchema.safeParse(paths);
    if (!result.success) {
      options.logger.warn("[sync-window-tabs] invalid payload:", formatZodError(result.error));
      return;
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      options.windowWorkspaceMap.set(win.id, new Set(result.data));
      options.syncTaskRealtimeWorkspaceKeys(win.id, result.data);
    }
  });

  ipcMain.on(PlatformChannels.SyncWindowUnreadCount, (event, payload: unknown) => {
    handleWindowUnreadCountSync(
      BrowserWindow.fromWebContents(event.sender),
      payload,
      options.windowUnreadCountMap,
      options.logger,
    );
  });
  registerCuaPipActiveSessionIpc({
    syncActiveTaskSession: options.syncActiveTaskSession,
    warn: (message) => options.logger.warn(message),
  });
  ipcMain.on(
    PlatformChannels.WindowControlsOverlayReady,
    (event, payload: WindowControlsOverlayReadyPayload) => {
      const senderWindow = BrowserWindow.fromWebContents(event.sender);
      if (!senderWindow || !Number.isFinite(payload.zoomLevel)) {
        return;
      }

      // preload 早于 React 页面运行，用它同步到的 zoom 档位先调整 macOS 红绿灯，
      // 避免等 RootStartupLoading 切到 App 页面后才重置位置。
      syncWindowControlsOverlayForZoomLevel(senderWindow, payload.zoomLevel);
    },
  );

  ipcMain.on(PlatformChannels.SyncAppSettings, (_event, payload: unknown) => {
    const result = appSettingsPatchSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn(
        "[settings] invalid app settings sync payload:",
        formatZodError(result.error),
      );
      return;
    }

    options.syncAppSettings(result.data);
  });

  // 快捷键录制态：renderer 设置页进入/退出录制时通知。macOS 系统菜单会先于 renderer
  // 吃掉按键，录制 menu 通道命令必须先摘掉可配置 accelerator，否则按键直接触发原命令。
  // 附带发起方 webContents id：录制中窗口销毁时 main 侧据此复位（见 index.ts）。
  ipcMain.on(PlatformChannels.SetShortcutRecordingActive, (event, payload: unknown) => {
    if (typeof payload !== "boolean") {
      options.logger.warn("[shortcuts] invalid recording-active payload:", payload);
      return;
    }
    options.setShortcutRecordingActive?.(payload, event.sender.id);
  });

  ipcMain.on(PlatformChannels.Log, (_event, payload: unknown) => {
    const result = rendererLogPayloadSchema.safeParse(payload);
    if (!result.success) {
      options.logger.warn("[renderer-log] invalid payload:", formatZodError(result.error));
      return;
    }
    (
      options.logger as unknown as { fromRenderer(level: string, args: unknown[]): void }
    ).fromRenderer?.(result.data.level, result.data.args);
  });

  ipcMain.handle(PlatformChannels.OpenInFileManager, async (_event, rawPath: string) =>
    openPathInFileManager(rawPath, options.logger),
  );

  registerCuaPermissionIpcHandlers({
    logger: options.logger,
    currentApplicationLocale: options.currentApplicationLocale,
  });

  ipcMain.handle(PlatformChannels.CanOpenCommunity, async (_event, locale: unknown) => {
    const result = localeSchema.safeParse(locale);
    if (!result.success) {
      options.logger.warn("[community] invalid locale:", formatZodError(result.error));
      return false;
    }

    const communityUrl = await resolveCommunityUrl({
      locale: result.data,
      fetchRemoteConfig: options.fetchHelpConfig,
      logger: options.logger,
    });

    return typeof communityUrl === "string" && communityUrl.length > 0;
  });

  ipcMain.handle(
    PlatformChannels.AcknowledgePostUpdateReleaseNotes,
    async (_event, version: string) => {
      const validatedVersion = nonEmptyStringSchema.parse(version);
      await options.acknowledgePostUpdateReleaseNotes(validatedVersion);
    },
  );

  ipcMain.handle(PlatformChannels.GetUpdateState, () => options.getUpdateState());
  ipcMain.handle(PlatformChannels.OpenUpdateStatusWindow, () => {
    options.openUpdateStatusWindow();
  });
  ipcMain.handle(PlatformChannels.GetAutoUpdatePreferences, () =>
    options.getAutoUpdatePreferences(),
  );
  ipcMain.handle(PlatformChannels.GetZaicodeLauncherPreferences, () =>
    readZaicodeLauncherPreferences(),
  );
  ipcMain.handle(PlatformChannels.SetZaicodeAutoRestartOnCrash, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean")
      throw new TypeError("Expected boolean crash recovery preference");
    return setZaicodeAutoRestartOnCrash(enabled);
  });
  ipcMain.handle(PlatformChannels.SetZaicodeSaimailWorkspace, (_event, workspace: unknown) => {
    if (workspace !== null && typeof workspace !== "string")
      throw new TypeError("Expected SAIMAIL workspace path or null");
    return setZaicodeSaimailWorkspace(workspace);
  });
  ipcMain.handle(PlatformChannels.GetZaicodePixelExact, () => ({
    pixelExact: readZaicodeLauncherPreferences().pixelExact,
  }));
  ipcMain.handle(PlatformChannels.SetZaicodePixelExact, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new TypeError("Expected boolean pixel-exact preference");
    return { pixelExact: setZaicodePixelExact(enabled).pixelExact };
  });
  ipcMain.handle(PlatformChannels.SaveZaicodeSettingsSnapshot, (_event, json: unknown) => {
    if (typeof json !== "string") throw new TypeError("Expected settings snapshot JSON");
    return saveZaicodeSettingsSnapshot(json);
  });
  ipcMain.handle(PlatformChannels.InitZaicodeSaimailWorkspace, (_event, workspace: unknown) => {
    if (typeof workspace !== "string" || !workspace.trim())
      throw new TypeError("Expected SAIMAIL workspace path");
    return initZaicodeSaimailWorkspace(workspace.trim());
  });
  ipcMain.handle(PlatformChannels.MoveWindowBy, (event, delta: unknown) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) return { success: false };
    const d = delta as { dx?: number; dy?: number };
    const dx = Number(d?.dx) || 0;
    const dy = Number(d?.dy) || 0;
    if (!dx && !dy) return { success: true };
    if (senderWindow.isMaximized()) {
      senderWindow.unmaximize();
    }
    const [x = 0, y = 0] = senderWindow.getPosition();
    senderWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
    return { success: true };
  });
  ipcMain.handle(PlatformChannels.SnapWindowZone, (event, rawZone: unknown) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) return { success: false };
    const zone = rawZone as {
      fx: number;
      fy: number;
      fw: number;
      fh: number;
      state?: "normal" | "maximized";
    };
    if (senderWindow.isMinimized()) {
      senderWindow.restore();
    }
    if (zone?.state === "maximized") {
      if (!senderWindow.isMaximized()) {
        senderWindow.maximize();
      }
      return { success: true };
    }
    if (senderWindow.isMaximized()) {
      senderWindow.unmaximize();
    }
    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint) || screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const x = Math.round(workArea.x + Math.max(0, Math.min(1, zone.fx)) * workArea.width);
    const y = Math.round(workArea.y + Math.max(0, Math.min(1, zone.fy)) * workArea.height);
    const width = Math.max(300, Math.round(Math.max(0.05, Math.min(1, zone.fw)) * workArea.width));
    const height = Math.max(200, Math.round(Math.max(0.05, Math.min(1, zone.fh)) * workArea.height));
    senderWindow.setBounds({ x, y, width, height });
    return { success: true };
  });
  // Right-button window drag: the window follows the real cursor (read here, not
  // summed from renderer deltas), so fast drags never drift or stall at the edge.
  const windowDrags = new WeakMap<BrowserWindow, { dx: number; dy: number }>();
  ipcMain.on(PlatformChannels.ZaicodeWindowDrag, (event, phase: unknown) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    if (phase === "start") {
      let bounds = senderWindow.getBounds();
      if (senderWindow.isMaximized()) {
        const ratio = (cursor.x - bounds.x) / Math.max(1, bounds.width);
        const grabY = cursor.y - bounds.y;
        senderWindow.unmaximize();
        bounds = senderWindow.getBounds();
        windowDrags.set(senderWindow, { dx: Math.round(ratio * bounds.width), dy: Math.min(grabY, bounds.height - 8) });
        senderWindow.setPosition(Math.round(cursor.x - ratio * bounds.width), Math.round(cursor.y - Math.min(grabY, bounds.height - 8)));
        return;
      }
      windowDrags.set(senderWindow, { dx: cursor.x - bounds.x, dy: cursor.y - bounds.y });
      return;
    }
    const drag = windowDrags.get(senderWindow);
    if (!drag) return;
    if (phase === "end") {
      windowDrags.delete(senderWindow);
      return;
    }
    senderWindow.setPosition(Math.round(cursor.x - drag.dx), Math.round(cursor.y - drag.dy));
  });
  ipcMain.handle(PlatformChannels.GetWindowZone, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) return null;
    const bounds = senderWindow.isMaximized() ? senderWindow.getNormalBounds() : senderWindow.getBounds();
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const workArea = (screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay()).workArea;
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    return {
      fx: clamp((bounds.x - workArea.x) / workArea.width),
      fy: clamp((bounds.y - workArea.y) / workArea.height),
      fw: clamp(bounds.width / workArea.width),
      fh: clamp(bounds.height / workArea.height),
      state: senderWindow.isMaximized() ? "maximized" : "normal",
    };
  });
  ipcMain.handle(PlatformChannels.GetZaicodeEngines, () => getZaicodeEnginesState());
  ipcMain.handle(PlatformChannels.RefreshZaicodeEngines, async (_event, accountId: unknown) => {
    await refreshZaicodeEngines(typeof accountId === "string" && accountId ? accountId : undefined);
    return getZaicodeEnginesState();
  });
  ipcMain.handle(PlatformChannels.SetZaicodeEnginesConfig, (_event, patch: unknown) =>
    setZaicodeEnginesConfig(patch),
  );
  ipcMain.handle(PlatformChannels.LaunchZaicodeExternalWorker, (_event, params: unknown) => {
    const p = params as { cwd?: unknown; command?: unknown; title?: unknown } | null;
    if (typeof p?.cwd !== "string" || typeof p.command !== "string")
      throw new TypeError("Expected worker cwd and command");
    return launchZaicodeExternalWorker({
      cwd: p.cwd,
      command: p.command,
      title: typeof p.title === "string" ? p.title : "ZAICODE worker",
    });
  });
  ipcMain.handle(PlatformChannels.CallZaicodeRouter, (_event, call: unknown) =>
    callZaicodeRouter(call as ZaicodeRouterCall),
  );
  ipcMain.handle(PlatformChannels.GetZaicodeRouterInfo, () => getZaicodeRouterInfo());
  ipcMain.handle(PlatformChannels.StartZaicodeRouter, () => startZaicodeRouter());
  ipcMain.handle(PlatformChannels.OpenZaicodeRouterDashboard, (_event, page: unknown) =>
    openZaicodeRouterDashboard(typeof page === "string" ? page : ""),
  );
  ipcMain.handle(PlatformChannels.RunZaicodeRouterExtraUpdate, () => runZaicodeRouterExtraUpdate());
  ipcMain.handle(PlatformChannels.GetZaicodeSaipenProjection, (_event, projectPath: unknown) =>
    typeof projectPath === "string" && projectPath ? getZaicodeSaipenProjection(projectPath) : null,
  );
  ipcMain.handle(PlatformChannels.ShowZaicodeNotification, (event, input: unknown) => showZaicodeNotification(event, input));
  ipcMain.handle(PlatformChannels.GetZaicodeRouterHost, () => getZaicodeRouterHostStatus());
  ipcMain.handle(PlatformChannels.SetZaicodeRouterMode, (_event, mode: unknown) => {
    if (mode !== "auto" && mode !== "shared" && mode !== "isolated") throw new TypeError("Expected auto, shared or isolated");
    return setZaicodeRouterMode(mode);
  });
  ipcMain.handle(PlatformChannels.BootstrapZaicodeRouter, (_event, options: unknown) =>
    bootstrapZaicodeRouter({ needKey: (options as { needKey?: unknown } | null)?.needKey === true }),
  );
  ipcMain.handle(PlatformChannels.TroubleshootZaicodeRouter, () => troubleshootZaicodeRouter());
  ipcMain.handle(PlatformChannels.ScanZaicodeFreeModels, () => scanZaicodeFreeModelsNow());
  ipcMain.handle(PlatformChannels.GetZaicodeFreeScanInfo, () => readZaicodeFreeScanInfo());
  ipcMain.handle(PlatformChannels.AddZaicodeFreeKey, (_event, input: unknown) => {
    const value = (input ?? {}) as { providerId?: unknown; apiKey?: unknown };
    if (typeof value.providerId !== "string" || typeof value.apiKey !== "string") throw new TypeError("Expected providerId and apiKey");
    return addZaicodeFreeKey(value.providerId, value.apiKey);
  });
  ipcMain.handle(PlatformChannels.PrepareZaicodeEngineAccountHome, (_event, vendor: unknown) =>
    prepareZaicodeEngineAccountHome(typeof vendor === "string" ? vendor : ""),
  );
  ipcMain.handle(PlatformChannels.SetZaicodeGlobalHotkeys, (_event, bindings: unknown) =>
    setZaicodeGlobalHotkeys(bindings),
  );
  ipcMain.handle(PlatformChannels.GetZaicodeStartWithWindows, () => getZaicodeStartWithWindows());
  ipcMain.handle(PlatformChannels.SetZaicodeStartWithWindows, (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") throw new TypeError("Expected boolean");
    return setZaicodeStartWithWindows(enabled);
  });
  ipcMain.handle(
    PlatformChannels.SetAutoDownloadAndInstallUpdates,
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return;
      }
      await options.setAutoDownloadAndInstallUpdates(enabled);
    },
  );
  ipcMain.handle(PlatformChannels.GetDesktopSessionActivity, () =>
    options.getDesktopSessionActivity(),
  );
  ipcMain.handle(PlatformChannels.GetDesktopZoomLevel, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) {
      return { zoomLevel: 0 };
    }

    return {
      zoomLevel: resolveDesktopZoomLevelFromFactor(senderWindow.webContents.getZoomFactor()),
    };
  });
  ipcMain.handle(PlatformChannels.GetDesktopWindowChromeState, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return resolveDesktopWindowChromeState(senderWindow?.isMaximized() ?? false);
  });
  ipcMain.handle(PlatformChannels.GetInstalledEditors, () => getInstalledEditors());
  ipcMain.handle(
    PlatformChannels.GetApplicationIcon,
    (_event, request: string | ApplicationIconRequest) => getApplicationIcon(request),
  );
  ipcMain.handle(PlatformChannels.GetDeviceId, () => options.deviceMid);
  ipcMain.handle(PlatformChannels.ExportLogs, () => exportLogs());
  ipcMain.handle(PlatformChannels.CaptureWindowScreenshot, async (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    return captureWindowScreenshot(senderWindow);
  });
  ipcMain.handle(
    PlatformChannels.OpenInEditor,
    (_event, payload: { editorId: string; path: string; options?: OpenInEditorOptions }) =>
      openInEditor(payload.editorId, payload.path, payload.options),
  );

  ipcMain.handle(PlatformChannels.ExecuteDesktopCommand, async (event, command: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const isKnownCommand = (Object.values(DesktopCommandIds) as string[]).includes(command);
    if (!isKnownCommand) {
      options.logger.warn("[desktop-command] invalid command:", command);
      return;
    }

    // 返回值直通 renderer 的 executeDesktopCommand promise（GetCuaOsSupport 依赖此行为）。
    return await options.executeDesktopCommand(command as DesktopCommandId, senderWindow);
  });
}
