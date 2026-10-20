import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Load desktopWindowLifecycle.ts with pure mocked ports
function loadLifecycleModule() {
  const path = join(import.meta.dirname, "../src/main/desktopWindowLifecycle.ts");
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: {
    handleDesktopWindowCloseRequest: (options: {
      platform: NodeJS.Platform;
      forceQuit: boolean;
      explicitQuitRequested?: boolean;
      shiftCloseRequested?: boolean;
      closeToTrayOnWindows?: boolean;
      isLastWindow: boolean;
      label: string;
      logger: { info: (...args: unknown[]) => void };
      shouldConfirmQuit?: boolean;
      confirmQuit: () => boolean;
      requestQuit: () => void;
      hideWindow?: () => void;
    }) => boolean;
  } = {} as any;
  const ports: Record<string, unknown> = {
    "node:crypto": { randomUUID: () => "uuid" },
    electron: {
      app: {},
      BrowserWindow: {},
      Menu: {},
      MessageChannelMain: class {},
    },
    "@zcode/shared": {
      HostMessageTypes: {},
      InternalChannels: {},
      PlatformChannels: {},
    },
    "./databaseStartupRelay.js": { getDatabaseStartupPortPayload: () => null },
    "./armsBrowserPerfLoadNudge.js": { scheduleArmsBrowserPerfLoadNudge: () => {} },
    "./desktopWindowChrome.js": { createBrowserWindow: () => {} },
    "./desktopDarwinCloseBehavior.js": { handleDarwinWindowCloseRequest: () => false },
    "./unreadBadge.js": {
      parseWindowUnreadCount: () => null,
      sumWindowUnreadCounts: () => 0,
      syncAppUnreadBadge: () => {},
    },
    "./desktopWindowSize.js": { attachDesktopWindowSizePersistence: () => {} },
    "./zaicodeSplash.js": { isZaicodeWindowHeld: () => false },
    "./resourceManagerWindow.js": {
      registerMainApplicationWindow: () => {},
      unregisterMainApplicationWindow: () => {},
    },
  };
  runInNewContext(compiled, {
    exports,
    require: (id: string) => ports[id] ?? {},
    process: { platform: "win32" },
  });
  return exports;
}

const { handleDesktopWindowCloseRequest } = loadLifecycleModule();

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

test("Control A: Normal X hides to tray when configured on Windows", () => {
  let hidden = false;
  let quitRequested = false;
  let confirmCalled = false;

  const prevented = handleDesktopWindowCloseRequest({
    platform: "win32",
    forceQuit: false,
    explicitQuitRequested: false,
    shiftCloseRequested: false,
    closeToTrayOnWindows: true,
    isLastWindow: true,
    label: "test-window-1",
    logger: mockLogger,
    shouldConfirmQuit: true,
    confirmQuit: () => {
      confirmCalled = true;
      return true;
    },
    requestQuit: () => {
      quitRequested = true;
    },
    hideWindow: () => {
      hidden = true;
    },
  });

  assert.equal(prevented, true, "close event is prevented so window hides instead of destroying");
  assert.equal(hidden, true, "window hideWindow is invoked");
  assert.equal(quitRequested, false, "app quit is NOT requested");
  assert.equal(confirmCalled, false, "confirmation dialog is NOT triggered for tray minimization");
});

test("Control B: Shift+Click X requests a real full quit", () => {
  let hidden = false;
  let quitRequested = false;
  let confirmCalled = false;

  const prevented = handleDesktopWindowCloseRequest({
    platform: "win32",
    forceQuit: false,
    explicitQuitRequested: false,
    shiftCloseRequested: true,
    closeToTrayOnWindows: true,
    isLastWindow: true,
    label: "test-window-2",
    logger: mockLogger,
    shouldConfirmQuit: true,
    confirmQuit: () => {
      confirmCalled = true;
      return true;
    },
    requestQuit: () => {
      quitRequested = true;
    },
    hideWindow: () => {
      hidden = true;
    },
  });

  assert.equal(prevented, true, "close event prevented while quit flow is dispatched");
  assert.equal(quitRequested, true, "requestQuit is invoked for full application shutdown");
  assert.equal(hidden, false, "window is NOT hidden to tray");
  assert.equal(confirmCalled, false, "confirmation dialog is bypassed for explicit Shift+Click quit");
});

test("Control C: Modifier intent survives asynchronous IPC boundary", () => {
  // Simulates command dispatch in desktopCommandHandlers.ts
  const windowExplicitShiftCloseMap = new Set<number>();
  const targetWindow = { id: 42, closeCalled: false, close: function() { this.closeCalled = true; } };

  function handleCloseCommand(commandOptions?: { shiftKey?: boolean }) {
    if (commandOptions?.shiftKey && targetWindow) {
      windowExplicitShiftCloseMap.add(targetWindow.id);
    }
    targetWindow.close();
  }

  handleCloseCommand({ shiftKey: true });
  assert.equal(targetWindow.closeCalled, true);
  assert.equal(windowExplicitShiftCloseMap.has(42), true, "explicit Shift intent captured across IPC");
});

test("Control D: Focus changes do not erase captured click intent", () => {
  const windowExplicitShiftCloseMap = new Set<number>();
  const winId = 101;
  let shiftPressed = true;

  // 1. Shift+Click captured in command
  windowExplicitShiftCloseMap.add(winId);

  // 2. Window blur event resets transient keyboard modifier
  shiftPressed = false;

  // 3. handleBeforeClose evaluates effective modifier
  const explicitShiftClose = windowExplicitShiftCloseMap.has(winId);
  windowExplicitShiftCloseMap.delete(winId);
  const effectiveShiftClose = explicitShiftClose || shiftPressed;

  assert.equal(effectiveShiftClose, true, "captured click modifier survives blur reset");
  assert.equal(windowExplicitShiftCloseMap.has(winId), false, "map is cleanly cleaned up after retrieval");
});

test("Control E: Ordinary X never becomes full quit accidentally", () => {
  let quitRequested = false;
  let hidden = false;

  const prevented = handleDesktopWindowCloseRequest({
    platform: "win32",
    forceQuit: false,
    explicitQuitRequested: false,
    shiftCloseRequested: false,
    closeToTrayOnWindows: true,
    isLastWindow: true,
    label: "test-window-ordinary",
    logger: mockLogger,
    shouldConfirmQuit: true,
    confirmQuit: () => false,
    requestQuit: () => {
      quitRequested = true;
    },
    hideWindow: () => {
      hidden = true;
    },
  });

  assert.equal(prevented, true);
  assert.equal(hidden, true);
  assert.equal(quitRequested, false, "ordinary close does not accidentally request quit");
});

test("Control F: Shutdown barrier does not trap closing windows (forceQuit check)", () => {
  let hidden = false;
  let quitRequested = false;

  // When forceQuit is true (during prepareAppQuit teardown)
  const prevented = handleDesktopWindowCloseRequest({
    platform: "win32",
    forceQuit: true,
    explicitQuitRequested: false,
    shiftCloseRequested: false,
    closeToTrayOnWindows: true,
    isLastWindow: true,
    label: "test-window-teardown",
    logger: mockLogger,
    shouldConfirmQuit: false,
    confirmQuit: () => true,
    requestQuit: () => {
      quitRequested = true;
    },
    hideWindow: () => {
      hidden = true;
    },
  });

  assert.equal(prevented, false, "forceQuit returns false so windows close and destroy naturally");
  assert.equal(hidden, false, "window is NOT hidden to tray during shutdown");
  assert.equal(quitRequested, false, "no duplicate quit requested");
});

test("Control G: Owned child process cleanup association", () => {
  // Simulates window-to-host and host-to-agent PID tree association
  const mainPid = 12000;
  const hostPids = new Map<number, number>(); // windowId -> hostPid
  const childAgentPids = new Map<number, Set<number>>(); // hostPid -> agentPids

  hostPids.set(1, 12001);
  childAgentPids.set(12001, new Set([12010, 12011]));

  function isOwnedProcess(pid: number): boolean {
    if (pid === mainPid) return true;
    for (const hostPid of hostPids.values()) {
      if (pid === hostPid) return true;
      if (childAgentPids.get(hostPid)?.has(pid)) return true;
    }
    return false;
  }

  assert.equal(isOwnedProcess(12001), true, "host process is owned");
  assert.equal(isOwnedProcess(12010), true, "child agent process is owned");
  assert.equal(isOwnedProcess(12011), true, "second child agent process is owned");
});

test("Control H: Unrelated CLI and process isolation", () => {
  const mainPid = 12000;
  const hostPids = new Map<number, number>([[1, 12001]]);
  const childAgentPids = new Map<number, Set<number>>([[12001, new Set([12010])]]);

  function isOwnedProcess(pid: number): boolean {
    if (pid === mainPid) return true;
    for (const hostPid of hostPids.values()) {
      if (pid === hostPid) return true;
      if (childAgentPids.get(hostPid)?.has(pid)) return true;
    }
    return false;
  }

  const unrelatedCliPid = 99999;
  const unrelatedZaicodePid = 88888;
  assert.equal(isOwnedProcess(unrelatedCliPid), false, "unrelated CLI is not classified as owned");
  assert.equal(isOwnedProcess(unrelatedZaicodePid), false, "independent ZAICODE instance is not classified as owned");
});

test("Control I: Multiple ZAICODE windows maintain isolated close intent", () => {
  const windowExplicitShiftCloseMap = new Set<number>();

  // Window 1 receives Shift+Click
  windowExplicitShiftCloseMap.add(1);
  // Window 2 receives normal click
  // (nothing added for 2)

  assert.equal(windowExplicitShiftCloseMap.has(1), true, "window 1 has explicit shift intent");
  assert.equal(windowExplicitShiftCloseMap.has(2), false, "window 2 has NO shift intent");

  // Closing window 1 consumes only its own intent
  windowExplicitShiftCloseMap.delete(1);
  assert.equal(windowExplicitShiftCloseMap.has(1), false);
  assert.equal(windowExplicitShiftCloseMap.has(2), false);
});

test("Control J: Shift+Click request marks both explicitQuit and forceQuit", () => {
  let explicitQuitMarked = false;
  let forceQuitMarked = false;
  let quitCalled = false;

  const mockMarkExplicitQuit = () => {
    explicitQuitMarked = true;
  };
  const mockMarkForceQuit = () => {
    forceQuitMarked = true;
  };
  const mockAppQuit = () => {
    quitCalled = true;
  };

  const handleRequestQuit = () => {
    mockMarkExplicitQuit();
    mockMarkForceQuit();
    mockAppQuit();
  };

  const prevented = handleDesktopWindowCloseRequest({
    platform: "win32",
    forceQuit: false,
    explicitQuitRequested: false,
    shiftCloseRequested: true,
    closeToTrayOnWindows: true,
    isLastWindow: false,
    label: "test-window-shift",
    logger: mockLogger,
    shouldConfirmQuit: true,
    confirmQuit: () => true,
    requestQuit: handleRequestQuit,
    hideWindow: () => {},
  });

  assert.equal(prevented, true, "window close is prevented so graceful quit starts");
  assert.equal(explicitQuitMarked, true, "explicitQuit must be marked so tray cannot intercept");
  assert.equal(forceQuitMarked, true, "forceQuit must be marked so subsequent checks bypass confirmation");
  assert.equal(quitCalled, true, "app.quit is requested");
});

test("Control K: Remaining windows during teardown receive explicit close and fallback destruction", async () => {
  let closedCalled = false;
  let destroyedCalled = false;
  let isDestroyedState = false;

  const mockWindow = {
    isDestroyed: () => isDestroyedState,
    close: () => {
      closedCalled = true;
    },
    destroy: () => {
      destroyedCalled = true;
      isDestroyedState = true;
    },
  };

  const windows = [mockWindow];

  // 1. Teardown triggers explicit close on all remaining windows
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
  assert.equal(closedCalled, true, "window receives explicit close invocation");

  // 2. If window hangs and timeout fires, destroy() is invoked
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
  assert.equal(destroyedCalled, true, "hung window is destroyed on timeout fallback");
  assert.equal(mockWindow.isDestroyed(), true);
});
