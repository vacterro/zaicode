import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createPrimaryWindowCoordinator } from "../src/main/primaryWindowCoordinator.js";

/** Window double: counters read live, so assertions see post-action state. */
function fakeWindow(overrides: { visible?: boolean; minimized?: boolean; rendererCrashed?: boolean } = {}) {
  const state = {
    destroyed: false,
    visible: overrides.visible ?? false,
    minimized: overrides.minimized ?? false,
    rendererCrashed: overrides.rendererCrashed ?? false,
    shown: 0,
    focused: 0,
    destroyedCount: 0,
  };
  return {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isRendererCrashed: () => state.rendererCrashed,
    show: () => {
      state.shown += 1;
      state.visible = true;
    },
    focus: () => {
      state.focused += 1;
    },
    restore: () => {
      state.minimized = false;
    },
    destroy: () => {
      state.destroyedCount += 1;
      state.destroyed = true;
    },
    get shown() {
      return state.shown;
    },
    get focused() {
      return state.focused;
    },
    get destroyedCount() {
      return state.destroyedCount;
    },
  };
}

type FakeWindow = ReturnType<typeof fakeWindow>;

function coordinator(
  listWindows: () => FakeWindow[],
  deps: { isHeldWindow?: (window: FakeWindow) => boolean } = {},
) {
  const infos: string[] = [];
  let created = 0;
  return {
    infos,
    get created() {
      return created;
    },
    coordinator: createPrimaryWindowCoordinator({
      listWindows,
      ...(deps.isHeldWindow ? { isHeldWindow: deps.isHeldWindow as never } : {}),
      resolveStartupWindowBootstrap: async () => ({}),
      createWindow: () => {
        created += 1;
      },
      logger: { info: (message: string) => infos.push(message) },
    }),
  };
}

test("app-ready with only the splash alive creates the main window (SRC-050)", async () => {
  // The T-63 splash window must be excluded by the listWindows wiring; when it
  // was not, the coordinator "reused" the splash and no main window ever
  // appeared - the operator stared at a picture until quitting from the tray.
  const harness = coordinator(() => []);
  await harness.coordinator.ensurePrimaryWindow("app-ready");
  assert.equal(harness.created, 1);
  assert.ok(harness.infos.some((line) => line.includes("creating main window")));
});

test("an existing application window is reused instead of creating a second one", async () => {
  const win = fakeWindow({ visible: true });
  const harness = coordinator(() => [win]);
  await harness.coordinator.ensurePrimaryWindow("app-ready");
  assert.equal(harness.created, 0);
  assert.ok(harness.infos.some((line) => line.includes("reused existing window")));
});

test("a hidden main window (startup hold, tray click) is shown, not recreated", async () => {
  const held = fakeWindow({ visible: false });
  const harness = coordinator(() => [held]);
  await harness.coordinator.ensurePrimaryWindow("tray-show-current-window");
  assert.equal(harness.created, 0);
  assert.equal(held.shown, 1);
  assert.equal(held.focused, 1);
});

test("a window whose renderer crashed is destroyed and the next one revealed", async () => {
  const crashed = fakeWindow({ visible: true, rendererCrashed: true });
  const next = fakeWindow();
  const harness = coordinator(() => [crashed, next]);
  await harness.coordinator.ensurePrimaryWindow("app-ready");
  assert.equal(crashed.destroyedCount, 1);
  assert.equal(next.shown, 1);
  assert.equal(harness.created, 0);
});

// SRC-060: the whole start-up picture feature was inert on desktop. The preload
// bridge, the channels and the main-process handlers all existed, but
// desktopPlatform.ts never mapped get/setZaicodeSplashPrefs into
// IPlatformService, so every control in ZaicodeSplashSettings guarded on
// `!platform.setZaicodeSplashPrefs` stayed permanently disabled and apply()
// returned early. The operator read that as "the splash is blocked from
// changes".
//
// The check is deliberately about the adapter rather than the handlers: the
// handlers were never the problem, and a test on them would have stayed green
// through the entire outage.
test("the desktop platform adapter maps both splash preference methods", () => {
  const adapter = readFileSync(
    join(import.meta.dirname, "..", "src", "renderer", "src", "desktopPlatform.ts"),
    "utf8",
  );
  assert.match(adapter, /getZaicodeSplashPrefs:\s*window\.zcode\.getZaicodeSplashPrefs/);
  assert.match(adapter, /setZaicodeSplashPrefs:\s*window\.zcode\.setZaicodeSplashPrefs/);
  // Both must be optional-guarded like every sibling, so a preload without them
  // (the dev renderer) still constructs.
  assert.match(adapter, /getZaicodeSplashPrefs\s*\n\s*\?\s*\(\)\s*=>\s*window\.zcode\.getZaicodeSplashPrefs!/);
  assert.match(adapter, /setZaicodeSplashPrefs\s*\n\s*\?\s*\(input\)\s*=>\s*window\.zcode\.setZaicodeSplashPrefs!\(input\)/);
});

test("the preload still exposes what the adapter now maps", () => {
  const preload = readFileSync(join(import.meta.dirname, "..", "src", "preload", "index.ts"), "utf8");
  for (const channel of ["GetZaicodeSplashPrefs", "SetZaicodeSplashPrefs"]) {
    assert.ok(preload.includes(channel), `${channel} is exposed by the preload bridge`);
  }
});

test("the splash settings component is not wired to a method that does not exist", () => {
  const settings = readFileSync(
    join(import.meta.dirname, "..", "..", "ui", "src", "settings", "ZaicodeSplashSettings.tsx"),
    "utf8",
  );
  // The component guards on these two; if the platform service stops declaring
  // them the section is inert again and this catches the drift.
  const platform = readFileSync(
    join(import.meta.dirname, "..", "..", "shared", "src", "platform.ts"),
    "utf8",
  );
  assert.ok(settings.includes("getZaicodeSplashPrefs"), "the section reads the preferences");
  assert.ok(settings.includes("setZaicodeSplashPrefs"), "the section writes the preferences");
  assert.ok(platform.includes("getZaicodeSplashPrefs?"), "the service still declares the reader");
  assert.ok(platform.includes("setZaicodeSplashPrefs?"), "the service still declares the writer");
});
// SRC-060: "the splash stays until the app is ready". Tray, dock and
// app-activate all route through the primary window coordinator, and every one
// of them used to call show() on a window the splash was still holding -- so
// clicking the tray icon during start-up revealed a half-loaded window with the
// splash still floating on top of it.
test("a window held by the start-up splash is not revealed from the coordinator", async () => {
  const held = fakeWindow({ visible: false });
  const crashed = fakeWindow({ visible: false, rendererCrashed: true });
  const harness = coordinator(() => [held, crashed], { isHeldWindow: () => true });
  await harness.coordinator.ensurePrimaryWindow("tray-show-current-window");
  assert.equal(held.shown, 0, "the held window stays hidden");
  assert.equal(held.focused, 0, "and is not focused either");
  assert.equal(crashed.destroyedCount, 0, "a held window is not destroyed as a crash");
  assert.equal(harness.created, 0, "and no replacement window is created");
});

test("an ordinary hidden window is still shown by the coordinator", async () => {
  const plain = fakeWindow({ visible: false });
  const harness = coordinator(() => [plain], { isHeldWindow: () => false });
  await harness.coordinator.ensurePrimaryWindow("tray-show-current-window");
  assert.equal(plain.shown, 1, "without the hold, the coordinator still shows it");
});
