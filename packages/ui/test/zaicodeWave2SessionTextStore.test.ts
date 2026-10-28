import assert from "node:assert/strict";
import { test } from "node:test";

import { zaicodeSessionTextDefaults } from "@/zaicode/zaicodeSessionTextModel.js";

/**
 * Wave 2, part A, the live half: what is stored and what is being edited are
 * two values. The store is a module singleton, so each case loads a fresh
 * instance -- that is exactly the "close Settings and open it again" move.
 */

interface FakeStorage {
  values: Map<string, string>;
  failNextWrite: boolean;
}

function installBrowserGlobals(): FakeStorage {
  const state: FakeStorage = { values: new Map(), failNextWrite: false };
  const storage = {
    getItem: (key: string) => state.values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (state.failNextWrite) throw new Error("quota exceeded");
      state.values.set(key, value);
    },
    removeItem: (key: string) => {
      state.values.delete(key);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const style = {
    id: "",
    textContent: "",
    remove: () => {
      style.id = "";
      style.textContent = "";
    },
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      documentElement: { classList: { toggle: () => undefined } },
      getElementById: (id: string) => (style.id === id ? style : null),
      createElement: () => ({ id: "", textContent: "" }),
      head: { appendChild: (node: { id: string }) => {
        style.id = node.id;
        style.textContent = node.textContent;
      } },
    },
  });
  return state;
}

let instance = 0;
async function freshStore() {
  return import(`../src/zaicode/zaicodeSessionText.js?instance=${(instance += 1)}`);
}

const PREFS_KEY = "zaicode-session-text-v1";

test("Wave 2 A: an edit is dirty and visible, and is NOT stored until Save", async () => {
  const storage = installBrowserGlobals();
  const { useZaicodeSessionText } = await freshStore();
  const store = useZaicodeSessionText.getState();

  assert.equal(store.dirty, false);
  assert.equal(storage.values.has(PREFS_KEY), false, "a fresh profile has nothing stored");

  store.edit({ ...store.prefs, body: { ...store.prefs.body, sizePx: 20 } });
  const edited = useZaicodeSessionText.getState();
  assert.equal(edited.dirty, true, "an edit that differs from what is stored is dirty");
  assert.equal(edited.editing.body.sizePx, 20, "the draft is what the screen shows");
  assert.equal(edited.prefs.body.sizePx, 0, "the saved value is untouched until Save");
  assert.equal(storage.values.has(PREFS_KEY), false, "an edit writes nothing to storage");

  const saved = useZaicodeSessionText.getState().save();
  assert.deepEqual(saved, { ok: true, unchanged: false, error: "" });
  const after = useZaicodeSessionText.getState();
  assert.equal(after.dirty, false);
  assert.equal(after.prefs.body.sizePx, 20);
  assert.equal(
    JSON.parse(storage.values.get(PREFS_KEY) ?? "{}").body.sizePx,
    20,
    "Save persisted the settings",
  );
});

test("Wave 2 A: reopening Settings reads the saved value, not the component's", async () => {
  const storage = installBrowserGlobals();
  const first = await freshStore();
  const store = first.useZaicodeSessionText.getState();
  store.edit({ ...store.prefs, body: { ...store.prefs.body, sizePx: 21, font: "georgia" } });
  first.useZaicodeSessionText.getState().save();

  // A second instance reads the same storage: this is the reopened screen.
  const second = await freshStore();
  const reopened = second.useZaicodeSessionText.getState();
  assert.equal(reopened.prefs.body.sizePx, 21);
  assert.equal(reopened.prefs.body.font, "georgia");
  assert.equal(reopened.dirty, false, "nothing is unsaved just because the screen was closed");
  assert.equal(reopened.editing, reopened.prefs);

  // An edit that is thrown away never reaches the next open.
  reopened.edit({ ...reopened.prefs, body: { ...reopened.prefs.body, sizePx: 99 } });
  second.useZaicodeSessionText.getState().discard();
  const third = await freshStore();
  assert.equal(third.useZaicodeSessionText.getState().prefs.body.sizePx, 21);
  assert.ok(storage.values.has(PREFS_KEY));
});

test("Wave 2 A: a Save that storage refuses says so, and keeps the change dirty", async () => {
  const storage = installBrowserGlobals();
  const { useZaicodeSessionText } = await freshStore();
  const store = useZaicodeSessionText.getState();
  store.edit({ ...store.prefs, body: { ...store.prefs.body, sizePx: 22 } });
  storage.failNextWrite = true;

  const result = useZaicodeSessionText.getState().save();
  assert.equal(result.ok, false, "Save must report the failure, not swallow it");
  assert.match(result.error, /quota exceeded/);
  assert.equal(useZaicodeSessionText.getState().dirty, true, "an unsaved edit stays dirty");
  assert.equal(useZaicodeSessionText.getState().prefs.body.sizePx, 0, "and stays unsaved");

  storage.failNextWrite = false;
  assert.equal(useZaicodeSessionText.getState().save().ok, true);
  assert.equal(useZaicodeSessionText.getState().dirty, false);
});

test("Wave 2 A: a no-op Save is reported as unchanged, and typing the saved value back is not dirty", async () => {
  installBrowserGlobals();
  const { useZaicodeSessionText } = await freshStore();
  assert.deepEqual(useZaicodeSessionText.getState().save(), { ok: true, unchanged: true, error: "" });

  useZaicodeSessionText.getState().edit({ ...useZaicodeSessionText.getState().prefs, body: { ...useZaicodeSessionText.getState().prefs.body, sizePx: 20 } });
  assert.equal(useZaicodeSessionText.getState().dirty, true);
  useZaicodeSessionText.getState().save();
  // Typing the stored value back in is not a change: the bar must not lie.
  useZaicodeSessionText.getState().edit({ ...useZaicodeSessionText.getState().prefs, body: { ...useZaicodeSessionText.getState().prefs.body, sizePx: 20 } });
  assert.equal(useZaicodeSessionText.getState().dirty, false);
  assert.deepEqual(useZaicodeSessionText.getState().save(), { ok: true, unchanged: true, error: "" });
});

test("Wave 2 A: reset is a change you can see, and only becomes the saved value on Save", async () => {
  installBrowserGlobals();
  const { useZaicodeSessionText } = await freshStore();
  const store = useZaicodeSessionText.getState();
  store.edit({ ...store.prefs, body: { ...store.prefs.body, sizePx: 23 } });
  useZaicodeSessionText.getState().save();

  useZaicodeSessionText.getState().reset();
  assert.equal(useZaicodeSessionText.getState().dirty, true, "reset is unsaved until Save says so");
  useZaicodeSessionText.getState().save();
  const reopened = (await freshStore()).useZaicodeSessionText.getState();
  assert.deepEqual(reopened.prefs, zaicodeSessionTextDefaults());
});

test("Wave 2 A: export writes the draft on screen; import replaces everything at once", async () => {
  installBrowserGlobals();
  const { useZaicodeSessionText } = await freshStore();
  const store = useZaicodeSessionText.getState();
  store.edit({
    ...store.prefs,
    body: { ...store.prefs.body, sizePx: 18 },
    userMessage: { mode: "separate", style: { ...store.prefs.userMessage.style, sizePx: 13, color: "#123123" } },
  });
  const file = useZaicodeSessionText.getState().exportDocument();
  const exported = JSON.parse(file) as { prefs: { body: { sizePx: number }; userMessage: { mode: string; style: { sizePx: number } } } };
  assert.equal(exported.prefs.body.sizePx, 18, "what you see is what you export");
  assert.equal(exported.prefs.userMessage.style.sizePx, 13);

  // A bad file changes nothing at all.
  const before = JSON.stringify(useZaicodeSessionText.getState().prefs);
  const rejected = useZaicodeSessionText.getState().importDocument('{"kind":"something.else"}');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /nothing was changed/i);
  assert.equal(JSON.stringify(useZaicodeSessionText.getState().prefs), before);

  // A good file lands whole, and the unsaved draft is gone with it.
  useZaicodeSessionText.getState().importDocument(file);
  const after = useZaicodeSessionText.getState();
  assert.equal(after.prefs.body.sizePx, 18);
  assert.equal(after.prefs.userMessage.mode, "separate");
  assert.equal(after.prefs.userMessage.style.color, "#123123");
  assert.equal(after.dirty, false, "an import is itself the save");
  const reopened = (await freshStore()).useZaicodeSessionText.getState();
  assert.equal(reopened.prefs.userMessage.style.sizePx, 13);
});
