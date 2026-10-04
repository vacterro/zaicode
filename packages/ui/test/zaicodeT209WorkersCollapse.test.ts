import assert from "node:assert/strict";
import test from "node:test";
import { normalizeZaicodeWorkerPrefs, reloadZaicodeWorkerPrefs, useZaicodeWorkerPrefs } from "../src/zaicode/zaicodeWorkerPrefs.js";

test("worker layout has a persistent, safely normalized collapsed flag without changing expanded geometry", () => {
  const defaults = normalizeZaicodeWorkerPrefs(null) as ReturnType<typeof normalizeZaicodeWorkerPrefs> & { panelCollapsed: boolean };
  assert.equal(defaults.panelCollapsed, false);
  for (const value of [undefined, null, 1, "true", {}, []]) {
    assert.equal((normalizeZaicodeWorkerPrefs({ panelCollapsed: value }) as typeof defaults).panelCollapsed, false);
  }
  const collapsed = normalizeZaicodeWorkerPrefs({ panelCollapsed: true, panelHeight: 431, panelWidth: 719, panelDock: "left" }) as typeof defaults;
  assert.equal(collapsed.panelCollapsed, true);
  assert.equal(collapsed.panelHeight, 431);
  assert.equal(collapsed.panelWidth, 719);
  assert.equal(collapsed.panelDock, "left");
});

test("the existing settings owner persists and rehydrates collapse without discarding dock, size or split", () => {
  const previous = globalThis.localStorage;
  const values = new Map<string, string>();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(), key: () => null, get length() { return values.size; },
  } as Storage;
  const before = useZaicodeWorkerPrefs.getState();
  try {
    before.update({ panelCollapsed: true, panelDock: "right", panelWidth: 719, panelHeight: 431, splitSizes: [0.25, 0.75] } as never);
    const saved = JSON.parse(values.get("zaicode-workers-prefs-v1")!);
    assert.equal(saved.panelCollapsed, true);
    reloadZaicodeWorkerPrefs();
    const loaded = useZaicodeWorkerPrefs.getState() as typeof before & { panelCollapsed: boolean };
    assert.equal(loaded.panelCollapsed, true);
    assert.equal(loaded.panelDock, "right");
    assert.equal(loaded.panelWidth, 719);
    assert.equal(loaded.panelHeight, 431);
    assert.deepEqual(loaded.splitSizes, [0.25, 0.75]);
    loaded.update({ panelCollapsed: false } as never);
    assert.equal(JSON.parse(values.get("zaicode-workers-prefs-v1")!).panelCollapsed, false);
  } finally {
    useZaicodeWorkerPrefs.setState(before);
    globalThis.localStorage = previous;
  }
});
