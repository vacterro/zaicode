import type { BrowserWindow, Rectangle } from "electron";
import type { AppSettings } from "@zcode/shared";

export const DEFAULT_DESKTOP_WINDOW_WIDTH = 1200;
export const DEFAULT_DESKTOP_WINDOW_HEIGHT = 800;
export const MIN_DESKTOP_WINDOW_WIDTH = 480;
export const MIN_DESKTOP_WINDOW_HEIGHT = 540;
const WINDOW_SIZE_PERSIST_DEBOUNCE_MS = 250;

export type DesktopWindowSize = NonNullable<AppSettings["desktopWindowSize"]>;

function clampDimension(value: number, minimum: number, available: number): number {
  const maximum = Math.max(minimum, Math.floor(available));
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

export function resolveDesktopWindowSize(
  persisted: DesktopWindowSize | undefined,
  workAreaSize: Pick<Rectangle, "width" | "height">,
): DesktopWindowSize {
  const width = persisted?.width ?? DEFAULT_DESKTOP_WINDOW_WIDTH;
  const height = persisted?.height ?? DEFAULT_DESKTOP_WINDOW_HEIGHT;

  return {
    width: clampDimension(width, MIN_DESKTOP_WINDOW_WIDTH, workAreaSize.width),
    height: clampDimension(height, MIN_DESKTOP_WINDOW_HEIGHT, workAreaSize.height),
    maximized: persisted?.maximized ?? false,
  };
}

type WindowSizePersistenceTarget = Pick<
  BrowserWindow,
  "getNormalBounds" | "isDestroyed" | "isMaximized" | "on"
>;

type MaximizeGeometryTarget = Pick<
  BrowserWindow,
  "getBounds" | "getNormalBounds" | "isDestroyed" | "on" | "setBounds"
>;

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * SRC-151:R004: "when I maximize the window it maximizes like this".
 *
 * The window is frameless on Windows (`frame: false`, the native title bar is
 * replaced by renderer-drawn controls), and a frameless maximized window is
 * given the monitor rather than the work area, with the invisible resize border
 * still on top of it: the operator's captures are 1930x1080 on a 1920x1080
 * screen and 960x1080 for the half-width restore rect -- both 48 px taller than
 * the work area, so the window sits over the taskbar and hangs off both sides.
 *
 * Native maximize still decides *whether* the window is maximized -- this only
 * corrects the rectangle it produced, and only when that rectangle actually
 * disagrees with the work area, so an already-correct window is never touched
 * and the operator's own maximize gesture stays the one that runs. Windows
 * records the corrected rectangle as the restore rect, so the pre-maximize
 * bounds are put back on unmaximize.
 */
export function attachNativeMaximizeGeometry(
  win: MaximizeGeometryTarget,
  workAreaFor: (bounds: Rectangle) => Rectangle,
): void {
  let restore: Rectangle | null = null;

  win.on("maximize", () => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    const workArea = workAreaFor(bounds);
    if (sameRect(bounds, workArea)) return;
    restore = win.getNormalBounds();
    win.setBounds(workArea);
  });

  win.on("unmaximize", () => {
    if (win.isDestroyed() || !restore) return;
    const back = restore;
    restore = null;
    win.setBounds(back);
  });
}

export function attachDesktopWindowSizePersistence(
  win: WindowSizePersistenceTarget,
  save: (state: DesktopWindowSize) => Promise<void>,
  onSaveError: (error: unknown) => void = () => undefined,
): void {
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  const persistCurrentState = (): void => {
    if (win.isDestroyed()) return;

    // 最大化窗口的当前 bounds 等于显示器工作区，直接持久化会覆盖用户最后一次
    // 手动调整的普通窗口尺寸。始终读取 normal bounds，并把 maximized 作为独立状态保存。
    const bounds = win.getNormalBounds();
    const state: DesktopWindowSize = {
      width: Math.max(MIN_DESKTOP_WINDOW_WIDTH, Math.floor(bounds.width)),
      height: Math.max(MIN_DESKTOP_WINDOW_HEIGHT, Math.floor(bounds.height)),
      maximized: win.isMaximized(),
    };
    void save(state).catch(onSaveError);
  };

  const clearResizeTimer = () => {
    if (resizeTimer === null) return;
    clearTimeout(resizeTimer);
    resizeTimer = null;
  };
  const persistImmediately = (): void => {
    clearResizeTimer();
    persistCurrentState();
  };

  win.on("resize", () => {
    // resize 在 Linux 和部分 Windows 窗口管理器中会随拖拽高频触发；只保存稳定后的尺寸，
    // 避免把与渲染帧同量级的写入堆进 setting.json 原子写队列。
    clearResizeTimer();
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      void persistCurrentState();
    }, WINDOW_SIZE_PERSIST_DEBOUNCE_MS);
  });
  win.on("maximize", () => void persistImmediately());
  win.on("unmaximize", () => void persistImmediately());
  // 退出屏障结束后 Electron 会再次触发 close；这里若启动异步设置写入，
  // 随后的 app.exit 可能在 releaseLock 完成前终止 Main，遗留 setting.json.lock。
  // close 只取消尚未触发的 resize 防抖，不再启动新的设置写入。
  win.on("close", clearResizeTimer);
}
