import assert from "node:assert/strict";
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

function coordinator(listWindows: () => FakeWindow[]) {
  const infos: string[] = [];
  let created = 0;
  return {
    infos,
    get created() {
      return created;
    },
    coordinator: createPrimaryWindowCoordinator({
      listWindows,
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
