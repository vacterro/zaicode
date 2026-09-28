import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { PlatformChannels } from "@zcode/shared";
import * as shared from "@zcode/shared";

// Execute the real main module with isolated Electron/input ports, without
// opening windows or starting a system-wide input reader in the unit suite.
function harness(platform = "linux") {
  const windows: Overlay[] = [];
  const handlers = new Map<string, (event: unknown, config: unknown) => unknown>();
  const displays = [-1920, 0, 1920].map((x, id) => ({ id, bounds: { x, y: 0, width: 1920, height: 1080 } }));
  class Contents extends EventEmitter {
    destroyed = false;
    loading = true;
    feeds: any[] = [];
    isDestroyed() { return this.destroyed; }
    isLoading() { return this.loading; }
    send(channel: string, feed: unknown) {
      assert.equal(channel, PlatformChannels.ZaicodeProtrailOverlayFeed);
      this.feeds.push(JSON.parse(JSON.stringify(feed)));
    }
  }
  class Overlay extends EventEmitter {
    webContents = new Contents();
    destroyed = false;
    visible = false;
    constructor(readonly options: { type?: string }) { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible && !this.destroyed; }
    getBounds() { return { x: 0, y: 0, width: 1920, height: 1080 }; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
    showInactive() { this.visible = true; }
    loadFile() {}
    loadURL() {}
  }
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => displays });
  const ports: Record<string, unknown> = {
    "node:path": { join },
    electron: { app, screen, BrowserWindow: Overlay, ipcMain: { handle: (key: string, fn: any) => handlers.set(key, fn) } },
    "@zcode/shared": shared,
    "./zaicodeProtrailInput.js": {
      startZaicodeProtrailCursorPoll: () => ({ kind: "cursor-poll", stop() {} }),
      ensureZaicodeProtrailInputHelper: () => new Promise(() => {}),
    },
  };
  const source = readFileSync(join(import.meta.dirname, "../src/main/zaicodeProtrailGlobal.ts"), "utf8");
  const compiled = ts.transpileModule(source.replaceAll("import.meta.dirname", JSON.stringify(import.meta.dirname)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = { registerZaicodeProtrailGlobalIpc() {} };
  runInNewContext(compiled, {
    exports, require: (id: string) => { assert.ok(id in ports, id); return ports[id]; },
    process: { platform, env: {} }, setTimeout, clearTimeout,
  });
  exports.registerZaicodeProtrailGlobalIpc();
  const sender = new Contents();
  const configure = (config: unknown) => handlers.get(PlatformChannels.SetZaicodeProtrailGlobal)!({ sender }, config);
  return { windows, displays, screen, configure };
}

test("every monitor receives current initial state before did-stop-loading", () => {
  const h = harness();
  h.configure({ color: "red" });
  h.configure({ color: "blue" });
  h.displays[0]!.bounds.x = -2560;
  h.screen.emit("display-metrics-changed");
  for (const [index, win] of h.windows.entries()) {
    assert.deepEqual(win.webContents.feeds, [], "no feed before the renderer listener is ready");
    assert.equal(win.webContents.isLoading(), true, "Electron 41 still loads at did-finish-load");
    win.webContents.emit("did-finish-load");
    assert.deepEqual(win.webContents.feeds, [{ config: { color: "blue" }, origin: { x: h.displays[index]!.bounds.x, y: 0 } }]);
  }
  h.configure(null);
});

test("Windows overlays are native tool windows so desktop managers do not relocate them", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    const h = harness(platform);
    h.configure({ color: "red" });
    assert.equal(h.windows.length, 3);
    for (const win of h.windows) {
      assert.equal(win.options.type, platform === "win32" ? "toolbar" : undefined);
    }
    h.configure(null);
  }
});

test("reload withholds feeds then resends current state; destroyed targets receive nothing", () => {
  const h = harness();
  h.configure({ color: "red" });
  const [left, primary, right] = h.windows;
  for (const win of h.windows) { win.webContents.loading = false; win.webContents.emit("did-finish-load"); }
  left!.webContents.emit("did-start-loading");
  // Readiness must not rely on isLoading(), including between load transitions.
  primary!.webContents.destroyed = true;
  right!.destroyed = true;
  h.configure({ color: "blue" });
  assert.equal(left!.webContents.feeds.length, 1, "reloading document must not receive feeds");
  assert.equal(primary!.webContents.feeds.length, 1);
  assert.equal(right!.webContents.feeds.length, 1);
  left!.webContents.loading = true;
  left!.webContents.emit("did-finish-load");
  assert.deepEqual(left!.webContents.feeds.at(-1), { config: { color: "blue" }, origin: { x: -1920, y: 0 } });
  h.configure({ color: "green" });
  assert.deepEqual(left!.webContents.feeds.at(-1), { config: { color: "green" } });
  h.configure(null);
});
