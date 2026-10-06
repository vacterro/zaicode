import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Rectangle } from "electron";
import test from "node:test";
import {
  DEFAULT_DESKTOP_WINDOW_HEIGHT,
  DEFAULT_DESKTOP_WINDOW_WIDTH,
  MIN_DESKTOP_WINDOW_HEIGHT,
  MIN_DESKTOP_WINDOW_WIDTH,
  attachDesktopWindowSizePersistence,
  attachNativeMaximizeGeometry,
  resolveDesktopWindowSize,
} from "../src/main/desktopWindowSize.js";

/**
 * SRC-151:R004: "when I maximize the window it maximizes like this".
 *
 * The desktop window is frameless on Windows, and a frameless maximized window
 * is handed the monitor instead of the work area with the invisible resize
 * border on top: the operator's captures are 1930x1080 on a 1920x1080 screen
 * and 960x1080 for the half-width restore rect -- both 48 px past the work
 * area, over the taskbar and hanging off both sides. `desktopWindowSize.ts` had
 * no test at all before this one, so both halves of it are pinned here.
 */

const WORK_AREA: Rectangle = { x: 0, y: 0, width: 1920, height: 1032 };

/** A BrowserWindow that lets a test drive its geometry the way Windows does. */
class FakeWindow extends EventEmitter {
  bounds: Rectangle;
  normal: Rectangle;
  destroyed = false;
  maximized = false;
  writes: Rectangle[] = [];
  saves: { width: number; height: number; maximized: boolean }[] = [];

  constructor(bounds: Rectangle) {
    super();
    this.bounds = { ...bounds };
    this.normal = { ...bounds };
  }
  isDestroyed() { return this.destroyed; }
  isMaximized() { return this.maximized; }
  getBounds() { return { ...this.bounds }; }
  getNormalBounds() { return { ...this.normal }; }
  setBounds(bounds: Rectangle) {
    this.writes.push({ ...bounds });
    this.bounds = { ...bounds };
  }
  /** What Windows does on a real maximize: the monitor, plus the invisible border. */
  maximizeLikeWindows(monitor: Rectangle) {
    this.normal = { ...this.bounds };
    this.bounds = { x: monitor.x - 5, y: monitor.y - 5, width: monitor.width + 10, height: monitor.height + 10 };
    this.maximized = true;
    this.emit("maximize");
  }
  unmaximize() {
    this.maximized = false;
    this.bounds = { ...this.normal };
    this.emit("unmaximize");
  }
}

const MONITOR: Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };

test("a maximized window is put on the work area, not left over the taskbar", () => {
  const win = new FakeWindow({ x: 300, y: 120, width: 1200, height: 800 });
  attachNativeMaximizeGeometry(win, () => WORK_AREA);

  win.maximizeLikeWindows(MONITOR);
  assert.deepEqual(win.bounds, WORK_AREA, "the 1930x1090 monitor rect is corrected to the 1920x1032 work area");
  assert.equal(win.maximized, true, "the window stays maximized: only the rectangle was wrong");
});

test("an already-correct maximize is left alone", () => {
  const win = new FakeWindow({ x: 300, y: 120, width: 1200, height: 800 });
  attachNativeMaximizeGeometry(win, () => WORK_AREA);
  win.normal = { ...WORK_AREA };

  win.maximizeLikeWindows(MONITOR);
  // Now the work area agrees with what Windows produced: nothing to repair, so
  // the operator's own restore rect is never overwritten.
  win.bounds = { ...WORK_AREA };
  win.writes = [];
  win.emit("maximize");
  assert.deepEqual(win.writes, [], "a correct maximize writes no bounds at all");
});

test("restoring after a corrected maximize returns the size the operator had", () => {
  const win = new FakeWindow({ x: 300, y: 120, width: 1200, height: 800 });
  attachNativeMaximizeGeometry(win, () => WORK_AREA);

  win.maximizeLikeWindows(MONITOR);
  win.unmaximize();
  assert.deepEqual(win.bounds, { x: 300, y: 120, width: 1200, height: 800 }, "the pre-maximize window comes back, not the work area");
});

test("a window that is never maximized keeps its bounds", () => {
  const win = new FakeWindow({ x: 300, y: 120, width: 1200, height: 800 });
  attachNativeMaximizeGeometry(win, () => WORK_AREA);
  assert.deepEqual(win.writes, [], "a window that is only ever unmaximized is not resized");
});

test("a restored size is persisted from the normal bounds, never from the maximized one", async () => {
  const win = new FakeWindow({ x: 300, y: 120, width: 1200, height: 800 });
  const saves: { width: number; height: number; maximized: boolean }[] = [];
  attachDesktopWindowSizePersistence(win, async (state) => { saves.push(state); });

  win.maximized = true;
  win.normal = { x: 300, y: 120, width: 1200, height: 800 };
  win.bounds = WORK_AREA;
  win.emit("maximize");
  await Promise.resolve();

  assert.deepEqual(saves.at(-1), { width: 1200, height: 800, maximized: true },
    "maximizing records the state and the size the operator last chose by hand");
});

test("a persisted size is clamped to the work area it is restored on", () => {
  const offScreen = resolveDesktopWindowSize({ width: 4000, height: 3000, maximized: true }, WORK_AREA);
  assert.deepEqual(offScreen, { width: 1920, height: 1032, maximized: true });

  const tooSmall = resolveDesktopWindowSize({ width: 10, height: 10, maximized: false }, WORK_AREA);
  assert.deepEqual(tooSmall, { width: MIN_DESKTOP_WINDOW_WIDTH, height: MIN_DESKTOP_WINDOW_HEIGHT, maximized: false });

  const fresh = resolveDesktopWindowSize(undefined, WORK_AREA);
  assert.deepEqual(fresh, { width: DEFAULT_DESKTOP_WINDOW_WIDTH, height: DEFAULT_DESKTOP_WINDOW_HEIGHT, maximized: false });
});