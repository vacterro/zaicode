import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PlatformChannels } from "@zcode/shared";
import * as shared from "@zcode/shared";
import { healthPort } from "./protrailPorts.js";

/**
 * The real ProTrail main module (zaicodeProtrailGlobal.ts) in a vm, with a fake Electron, a fake input
 * source and a hand-cranked clock that also answers `Date.now()`. Windows are modelled well enough to
 * ask them what a real overlay page answers to the health probe: a page holds a config once it was fed
 * one, unless it is made deaf; it can be frozen (never answers) or draw no frames.
 *
 * `PROTRAIL_MAIN_SOURCE` points the harness at another copy of the module (the pre-fix source, for the
 * red control that proves a test can see the defect it was written for).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface FakeDisplay {
  id: number;
  bounds: Rect;
}

export const THREE_DISPLAYS: FakeDisplay[] = [-1920, 0, 1920].map((x, id) => ({ id, bounds: { x, y: 0, width: 1920, height: 1080 } }));

export function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    now: () => now,
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
        const due = [...jobs.entries()].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
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

export interface PageModel {
  /** The document ignores every config feed (its listener was not there). */
  deaf: boolean;
  /** The page never answers a probe. */
  frozen: boolean;
  /** The compositor makes no frames: the probe reports frames:false. */
  noFrames: boolean;
  configured: boolean;
  enabled: boolean;
  width: number;
  height: number;
  loaded: boolean;
}

class FakeContents extends EventEmitter {
  destroyed = false;
  feeds: any[] = [];
  probes = 0;
  page: PageModel = { deaf: false, frozen: false, noFrames: false, configured: false, enabled: false, width: 0, height: 0, loaded: false };
  isDestroyed() {
    return this.destroyed;
  }
  isLoading() {
    return !this.page.loaded;
  }
  send(channel: string, feed: any) {
    assert.equal(channel, PlatformChannels.ZaicodeProtrailOverlayFeed);
    this.feeds.push(JSON.parse(JSON.stringify(feed)));
    if (this.page.deaf || !("config" in feed)) return;
    this.page.configured = true;
    this.page.enabled = feed.config != null && feed.config.enabled !== false;
  }
  executeJavaScript(code: string): Promise<unknown> {
    assert.match(code, /__zaicodeProtrailProbe/);
    this.probes += 1;
    if (this.page.frozen) return new Promise(() => {});
    if (!this.page.loaded) return Promise.resolve(null);
    const { configured, enabled, width, height, noFrames } = this.page;
    return Promise.resolve({ configured, enabled, width, height, frames: !noFrames });
  }
}

export class FakeOverlay extends EventEmitter {
  webContents = new FakeContents();
  destroyed = false;
  visible = false;
  shown = 0;
  bounds: Rect;
  boundsSet: Rect[] = [];
  constructor(
    readonly options: { x: number; y: number; width: number; height: number; type?: string },
    register: (win: FakeOverlay) => void,
  ) {
    super();
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.webContents.page.width = options.width;
    this.webContents.page.height = options.height;
    register(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible && !this.destroyed;
  }
  getBounds() {
    return { ...this.bounds };
  }
  setBounds(bounds: Rect) {
    this.bounds = { ...bounds };
    this.boundsSet.push({ ...bounds });
    this.webContents.page.width = bounds.width;
    this.webContents.page.height = bounds.height;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
  setIgnoreMouseEvents() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  showInactive() {
    this.visible = true;
    this.shown += 1;
  }
  loadFile() {}
  loadURL() {}
  /** The document finishes loading (and the window may show). */
  load() {
    this.webContents.page.loaded = true;
    this.webContents.emit("did-finish-load");
    this.emit("ready-to-show");
  }
}

/** A scripted click reader for the win32 path: each start is answered by `readerPlan`. */
export type ReaderOutcome = "ready" | "fail" | "hang";

export interface HarnessOptions {
  platform?: string;
  displays?: FakeDisplay[];
  /** win32: what each successive click-reader start does. Defaults to "ready". */
  readerPlan?: ReaderOutcome[];
}

export function createProtrailHarness(options: HarnessOptions = {}) {
  const platform = options.platform ?? "linux";
  const clock = fakeClock();
  const windows: FakeOverlay[] = [];
  let displays = options.displays ?? THREE_DISPLAYS;
  const handlers = new Map<string, (event: unknown, config: unknown) => unknown>();
  const logs: string[] = [];
  const readers: { outcome: ReaderOutcome; stopped: boolean }[] = [];
  const plan = [...(options.readerPlan ?? [])];
  const app = Object.assign(new EventEmitter(), { isPackaged: true });
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => displays, screenToDipPoint: (p: unknown) => p });
  const input = {
    startZaicodeProtrailCursorPoll: () => ({ kind: "cursor-poll", stop() {} }),
    ensureZaicodeProtrailInputHelper: () => Promise.resolve("helper.exe"),
    startZaicodeProtrailRawInput: (_exe: string, callbacks: { onReady?: () => void; onFailure?: (reason: string) => void }) => {
      const outcome = plan.shift() ?? "ready";
      const reader = { outcome, stopped: false };
      readers.push(reader);
      // The reader answers on the next tick, like a process would.
      if (outcome === "ready") setImmediate(() => callbacks.onReady?.());
      if (outcome === "fail") setImmediate(() => callbacks.onFailure?.("the input helper exited (code 1)"));
      return { kind: "raw-input", stop: () => void (reader.stopped = true) };
    },
  };
  const ports: Record<string, unknown> = {
    "node:path": { join },
    electron: {
      app,
      screen,
      BrowserWindow: function BrowserWindow(this: unknown, opts: FakeOverlay["options"]) {
        return new FakeOverlay(opts, (win) => windows.push(win));
      },
      ipcMain: { handle: (key: string, fn: (event: unknown, config: unknown) => unknown) => handlers.set(key, fn) },
    },
    "@zcode/shared": shared,
    "./zaicodeProtrailInput.js": input,
    "./zaicodeProtrailHealth.js": healthPort(),
  };
  const path = process.env.PROTRAIL_MAIN_SOURCE ?? join(import.meta.dirname, "../../src/main/zaicodeProtrailGlobal.ts");
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source.replaceAll("import.meta.dirname", JSON.stringify(import.meta.dirname)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { registerZaicodeProtrailGlobalIpc: (options?: { log?: (message: string) => void }) => void } = {
    registerZaicodeProtrailGlobalIpc() {},
  };
  runInNewContext(compiled, {
    exports,
    require: (id: string) => {
      assert.ok(id in ports, id);
      return ports[id];
    },
    process: { platform, env: {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
  });
  exports.registerZaicodeProtrailGlobalIpc({ log: (message) => logs.push(message) });
  const sender = new EventEmitter() as EventEmitter & { destroyed: boolean; isDestroyed(): boolean };
  sender.destroyed = false;
  sender.isDestroyed = () => sender.destroyed;
  return {
    clock,
    windows,
    logs,
    readers,
    screen,
    live: () => windows.filter((win) => !win.destroyed),
    setDisplays: (next: FakeDisplay[]) => {
      displays = next;
    },
    displays: () => displays,
    status: () => handlers.get(PlatformChannels.GetZaicodeProtrailGlobalStatus)!({}, undefined) as {
      state: string;
      input: string;
      displays: number;
      verified?: number;
      monitors?: number;
      note: string | null;
    },
    configure: (config: unknown) => handlers.get(PlatformChannels.SetZaicodeProtrailGlobal)!({ sender }, config),
    /** Every live overlay finishes loading; time moves a millisecond so the module's handlers settle. */
    async loadAll() {
      for (const win of windows.filter((candidate) => !candidate.destroyed && !candidate.webContents.page.loaded)) win.load();
      await clock.advance(1);
    },
  };
}
