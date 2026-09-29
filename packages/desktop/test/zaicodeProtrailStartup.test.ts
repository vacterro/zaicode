import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { PlatformChannels } from "@zcode/shared";
import * as shared from "@zcode/shared";
import { healthPort } from "./support/protrailPorts.js";

/**
 * Startup convergence for desktop-wide ProTrail (SRC-070 item A).
 *
 * The invariant: a persisted-enabled ProTrail reaches `running` with one
 * overlay per monitor on its own. No Settings visit, no toggle, no second
 * claim. Every test below reproduces a real way the old boot path lost that,
 * and each is RED against the single-shot starter it replaced.
 */

// A hand-cranked clock: the module only ever waits through setTimeout, so the
// whole convergence is driven by advancing time instead of sleeping.
function clock() {
  let now = 0;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    setTimeout(fn: () => void, ms = 0) {
      const id = ++seq;
      jobs.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id: number) {
      jobs.delete(id);
    },
    pending: () => jobs.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...jobs.entries()]
          .filter(([, job]) => job.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        jobs.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

const THREE_DISPLAYS = [-1920, 0, 1920].map((x, id) => ({ id, bounds: { x, y: 0, width: 1920, height: 1080 } }));

class Contents extends EventEmitter {
  destroyed = false;
  loading = true;
  feeds: unknown[] = [];
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
  shown = 0;
  constructor(readonly options: { type?: string }) { super(); harnessWindows.push(this); }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible && !this.destroyed; }
  getBounds() { return { x: 0, y: 0, width: 1920, height: 1080 }; }
  destroy() { this.destroyed = true; this.emit("closed"); }
  setIgnoreMouseEvents() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setBounds() {}
  showInactive() { this.visible = true; this.shown += 1; }
  loadFile() {}
  loadURL() {}
}

let harnessWindows: Overlay[] = [];

function harness(platform = "linux", initialDisplays: typeof THREE_DISPLAYS = THREE_DISPLAYS) {
  harnessWindows = [];
  const windows = harnessWindows;
  const time = clock();
  let displays = initialDisplays;
  const handlers = new Map<string, (event: unknown, config: unknown) => unknown>();
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
    "./zaicodeProtrailHealth.js": healthPort(),
  };
  const source = readFileSync(join(import.meta.dirname, "../src/main/zaicodeProtrailGlobal.ts"), "utf8");
  const compiled = ts.transpileModule(source.replaceAll("import.meta.dirname", JSON.stringify(import.meta.dirname)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = { registerZaicodeProtrailGlobalIpc() {} };
  runInNewContext(compiled, {
    exports,
    require: (id: string) => { assert.ok(id in ports, id); return ports[id]; },
    process: { platform, env: {} },
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  });
  exports.registerZaicodeProtrailGlobalIpc();
  const setHandler = handlers.get(PlatformChannels.SetZaicodeProtrailGlobal)!;
  const window = new Contents();
  const live = () => windows.filter((win) => !win.destroyed);
  return {
    windows,
    live,
    time,
    screen,
    setDisplays(next: typeof THREE_DISPLAYS) { displays = next; },
    status: () => handlers.get(PlatformChannels.GetZaicodeProtrailGlobalStatus)!(),
    claim: (sender: EventEmitter, config: unknown) => setHandler({ sender }, config),
    configure: (config: unknown) => setHandler({ sender: window }, config),
    /** Load every overlay document and let the module reveal it. */
    async loadAll() {
      for (const win of live()) {
        win.webContents.loading = false;
        win.webContents.emit("did-finish-load");
        win.emit("ready-to-show");
      }
      await time.advance(1);
    },
  };
}

test("A1 relaunch with persisted enabled: displays that settle late still get an overlay each", async () => {
  const h = harness("linux", []);
  // Electron has not enumerated the monitors when the renderer first claims.
  h.configure({ color: "red" });
  assert.equal(h.status().displays, 0, "nothing to draw on yet");
  h.setDisplays(THREE_DISPLAYS);
  h.screen.emit("display-added");
  assert.equal(h.status().displays, 0, "the status does not claim overlays before their documents load");
  await h.loadAll();
  assert.equal(h.live().length, 3, "one overlay per monitor without a second claim");
  assert.equal(h.status().displays, 3);
  assert.equal(h.status().state, "running");
});

test("A2 a start that produced no overlay is repaired by the same config, not by a toggle", async () => {
  const h = harness("linux", []);
  h.configure({ color: "red" });
  h.setDisplays(THREE_DISPLAYS);
  // The same config, which is exactly what the renderer re-asserts.
  h.configure({ color: "red" });
  await h.loadAll();
  assert.equal(h.live().length, 3, "a repeat claim reconciles the overlay set");
  assert.equal(h.status().displays, 3);
});

test("A3 an overlay whose document fails to load is replaced, not left blank over the desktop", async () => {
  const h = harness();
  h.configure({ color: "red" });
  const [blank] = h.windows;
  blank!.webContents.emit("did-fail-load");
  assert.equal(blank!.destroyed, true, "the blank overlay is dropped");
  await h.time.advance(1000);
  assert.equal(h.live().length, 3, "a fresh one is built without operator action");
  await h.loadAll();
  assert.equal(h.status().displays, 3);
});

test("A4 a reloaded document reveals the overlay again: ready-to-show does not fire twice", async () => {
  const h = harness();
  h.configure({ color: "red" });
  await h.loadAll();
  const [first] = h.windows;
  assert.equal(first!.isVisible(), true);
  // Electron does not re-fire ready-to-show after a document reload, so a
  // window hidden at that moment used to stay loaded and invisible forever.
  first!.visible = false;
  first!.webContents.loading = true;
  first!.webContents.emit("did-start-loading");
  first!.webContents.loading = false;
  first!.webContents.emit("did-finish-load");
  assert.equal(first!.isVisible(), true, "revealed again from the document, not from ready-to-show");
  assert.equal(first!.webContents.feeds.length >= 2, true, "current state is re-sent to the reloaded document");
});

test("A5 renderer reconnect: a new window re-claims and converges after the old document is destroyed", async () => {
  const h = harness();
  const first = new Contents();
  h.claim(first, { color: "red" });
  await h.loadAll();
  first.destroyed = true;
  first.emit("destroyed");
  assert.equal(h.status().state, "off", "the last window dropping the mode switches it off");
  h.claim(new Contents(), { color: "red" });
  await h.loadAll();
  assert.equal(h.status().state, "running");
  assert.equal(h.status().displays, 3, "the reconnected window rebuilds every overlay");
});

test("A6 a healthy overlay set costs nothing: the reconcile is a no-op", async () => {
  const h = harness();
  h.configure({ color: "red" });
  await h.loadAll();
  const before = h.live().map((win) => win.webContents.feeds.length);
  h.configure({ color: "blue" });
  assert.equal(h.live().length, 3, "no overlay is rebuilt while every display already has a loaded one");
  // T-129: a slow health pass (one probe per overlay every few seconds) now watches a healthy set, so one
  // timer is armed on purpose; what must not be armed is a reconcile retry.
  assert.equal(h.time.pending(), 1, "only the slow health pass is armed once the overlays are there: no reconcile retry");
  for (const [index, win] of h.live().entries()) {
    assert.equal(win.webContents.feeds.length, before[index]! + 1, "only the new config is broadcast");
  }
});
