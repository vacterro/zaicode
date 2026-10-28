import assert from "node:assert/strict";
import test from "node:test";

/** Minimal browser globals: a Storage-like map, window as an EventTarget. */
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}
const storage = new MemoryStorage();
const fakeWindow = Object.assign(new EventTarget(), { localStorage: storage });
Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

const { normalizeZaicodeDispatchPrefs, pickZaicodeDispatchProject, zaicodeDispatchTitle, ZAICODE_DISPATCH_DEFAULT_PREFS } =
  await import("../src/zaicode/zaicodeDispatch.js");
const { normalizeZaicodeUiPrefs } = await import("../src/zaicode/zaicodeUiPrefs.js");
const { adoptZaicodeComposerModel, readZaicodeDefaultModel, setZaicodeDefaultModel } = await import(
  "../src/zaicode/zaicodeDefaultModel.js"
);
const { readZaicodeActiveEngine, setZaicodeActiveEngine } = await import("../src/zaicode/zaicodeEngines.js");
const { persistV4ComposerDraft, persistV4ComposerDraftContent, readV4ComposerDraft } = await import(
  "../src/v4/composer/composerDraftStore.js"
);

test("CLEAR empties this session by default; 'new' is the only other mode", () => {
  assert.equal(normalizeZaicodeUiPrefs(null).clearMode, "session");
  assert.equal(normalizeZaicodeUiPrefs({ clearMode: "new" }).clearMode, "new");
  assert.equal(normalizeZaicodeUiPrefs({ clearMode: "wipe-disk" }).clearMode, "session");
});

test("a composer model pick becomes the START default and releases a sidebar engine", () => {
  setZaicodeDefaultModel({ providerId: "sairoute", modelId: "SAIFREN" });
  setZaicodeActiveEngine("claude-1");
  const released = adoptZaicodeComposerModel("opencode-local", "my-model");
  assert.equal(released, true);
  assert.equal(readZaicodeActiveEngine(), null);
  assert.deepEqual(readZaicodeDefaultModel(), { providerId: "opencode-local", modelId: "my-model" });
  // No engine selected: nothing to release, the default still follows the pick.
  assert.equal(adoptZaicodeComposerModel("sairoute", "SAIOPP"), false);
  assert.deepEqual(readZaicodeDefaultModel(), { providerId: "sairoute", modelId: "SAIOPP" });
  // An incomplete pick changes nothing.
  assert.equal(adoptZaicodeComposerModel("", "x"), false);
  assert.deepEqual(readZaicodeDefaultModel(), { providerId: "sairoute", modelId: "SAIOPP" });
});

test("a draft left inside the debounce window is written to the scope being left", () => {
  const ws = "V:/proj";
  persistV4ComposerDraft(ws, undefined, "session-a", {
    text: "old",
    mode: "build",
    modelSelection: { providerId: "sairoute", modelId: "SAIFREN" },
  });
  persistV4ComposerDraftContent(ws, undefined, "session-a", { text: "old plus the last keystrokes" });
  const draft = readV4ComposerDraft(ws, undefined, "session-a");
  assert.equal(draft?.text, "old plus the last keystrokes");
  // Mode and model of that scope survive the content write.
  assert.equal(draft?.mode, "build");
  assert.deepEqual(draft?.modelSelection, { providerId: "sairoute", modelId: "SAIFREN" });
  // A scope that had nothing stored gets the text.
  persistV4ComposerDraftContent(ws, undefined, "session-b", { text: "fresh" });
  assert.equal(readV4ComposerDraft(ws, undefined, "session-b")?.text, "fresh");
  // Empty content of an otherwise empty scope stores nothing.
  persistV4ComposerDraftContent(ws, undefined, "session-c", { text: "" });
  assert.equal(readV4ComposerDraft(ws, undefined, "session-c"), null);
});

test("Dispatch prefs: own window by default, launchers validated, ids unique", () => {
  assert.equal(ZAICODE_DISPATCH_DEFAULT_PREFS.where, "external");
  const defaults = normalizeZaicodeDispatchPrefs(null);
  assert.deepEqual(
    defaults.launchers.map((launcher) => launcher.id),
    ["terminal", "opencode"],
  );
  const prefs = normalizeZaicodeDispatchPrefs({
    where: "panel",
    launchers: [
      { id: "x", label: "Gemini", short: "GEMINI-LONG", command: "gemini --yolo" },
      { id: "x", label: "Dup", command: "" },
      { label: "   " },
      "junk",
    ],
  });
  assert.equal(prefs.where, "panel");
  assert.equal(prefs.launchers.length, 2);
  assert.equal(prefs.launchers[0]!.short, "GEMI");
  assert.equal(prefs.launchers[1]!.short, "DU");
  assert.notEqual(prefs.launchers[0]!.id, prefs.launchers[1]!.id);
  assert.equal(normalizeZaicodeDispatchPrefs({ where: "moon" }).where, "external");
});

test("Dispatch project: last pick, else the active project, else the first", () => {
  const projects = [
    { path: "V:/a", name: "a" },
    { path: "V:/b", name: "b" },
  ];
  assert.equal(pickZaicodeDispatchProject(projects, "V:/b", "V:/a")?.name, "b");
  assert.equal(pickZaicodeDispatchProject(projects, "V:/gone", "V:/a")?.name, "a");
  assert.equal(pickZaicodeDispatchProject(projects, null, null)?.name, "a");
  assert.equal(pickZaicodeDispatchProject([], null, null), null);
  assert.equal(zaicodeDispatchTitle("OC", "_ZAICODE"), "OC _ZAICODE | ZAICODE");
});
