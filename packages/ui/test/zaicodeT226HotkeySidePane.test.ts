// T-226 / SRC-156 -- Ctrl+Alt+B toggles the SAIPEN side pane again.
//
// The old default bound the Usage sidebar to the historical side-pane key,
// so the capture-phase ZAICODE dispatcher consumed Ctrl+Alt+B and the
// upstream toggleSidePane (the right-side pane with the SAIPEN tab, whose
// persistence is the Always-everywhere / per-project policy) never fired.
// These tests pin: the default leaves the key free, the upstream map still
// answers toggleSidePane on it, the old stored default is migrated once and
// a deliberate rebinding afterwards is respected, and a deliberate Usage
// binding on the key surfaces as a conflict instead of being hidden.
import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultZaicodeHotkeySettings,
  findZaicodeHotkeyConflicts,
  readZaicodeHotkeySettings,
  reloadZaicodeHotkeys,
  ZAICODE_HOTKEY_ACTIONS,
  zaicodeUpstreamShortcutBindings,
} from "@/zaicode/zaicodeHotkeys.js";

const SIDE_PANE_KEY = "Ctrl+Alt+B";
const REV_KEY = "zaicode-hotkeys-sidepane-rev";
const STORAGE_KEY = "zaicode-hotkeys-v1";

interface StorageMock {
  values: Map<string, string>;
  restore: () => void;
}

function mockLocalStorage(initial: Record<string, string>): StorageMock {
  const values = new Map(Object.entries(initial));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, String(value));
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  return {
    values,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

test("T-226: no ZAICODE action owns Ctrl+Alt+B by default; the side pane does", () => {
  for (const action of ZAICODE_HOTKEY_ACTIONS) {
    assert.ok(
      !action.defaults.includes(SIDE_PANE_KEY),
      `${action.id} must not take ${SIDE_PANE_KEY} from the side pane`,
    );
  }
  assert.equal(
    zaicodeUpstreamShortcutBindings().get(SIDE_PANE_KEY),
    "toggleSidePane",
  );
  assert.deepEqual(
    defaultZaicodeHotkeySettings().bindings["ui.usageSidebar"],
    ["", ""],
  );
});

test("T-226: the old stored default moves off Ctrl+Alt+B exactly once", () => {
  const oldStored = JSON.stringify({
    enabled: true,
    fKeys: "off",
    bindings: { "ui.usageSidebar": [SIDE_PANE_KEY, ""] },
  });
  const mock = mockLocalStorage({ [STORAGE_KEY]: oldStored });
  try {
    reloadZaicodeHotkeys();
    assert.deepEqual(readZaicodeHotkeySettings().bindings["ui.usageSidebar"], ["", ""]);
    assert.equal(mock.values.get(REV_KEY), "1");
    // A deliberate rebinding after the migration is respected, not migrated again.
    mock.values.set(STORAGE_KEY, oldStored);
    reloadZaicodeHotkeys();
    assert.deepEqual(readZaicodeHotkeySettings().bindings["ui.usageSidebar"], [SIDE_PANE_KEY, ""]);
  } finally {
    mock.restore();
    reloadZaicodeHotkeys();
  }
  // Another key was never touched by the migration in the first place.
  const other = JSON.stringify({
    enabled: true,
    fKeys: "off",
    bindings: { "ui.usageSidebar": ["Ctrl+Alt+U", ""] },
  });
  const fresh = mockLocalStorage({ [STORAGE_KEY]: other });
  try {
    reloadZaicodeHotkeys();
    assert.deepEqual(readZaicodeHotkeySettings().bindings["ui.usageSidebar"], ["Ctrl+Alt+U", ""]);
  } finally {
    fresh.restore();
    reloadZaicodeHotkeys();
  }
});

test("T-226: a deliberate Usage binding on the pane key is reported, not hidden", () => {
  const conflicts = findZaicodeHotkeyConflicts({
    enabled: true,
    fKeys: "off",
    bindings: { "ui.usageSidebar": [SIDE_PANE_KEY, ""] as [string, string] },
  });
  const conflict = conflicts.find((entry) => entry.binding === SIDE_PANE_KEY);
  assert.ok(conflict, "Ctrl+Alt+B must surface as a conflict when Usage takes it");
  assert.deepEqual(conflict.actions, ["ui.usageSidebar"]);
  assert.equal(conflict.upstream, "toggleSidePane");
});
