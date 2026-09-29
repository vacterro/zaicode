import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * SRC-089 (T-126): the customization folder as the window sees it. The desktop is faked with a `window.zcode` that
 * holds a mutable "folder"; everything below runs the real store, source and helpers against it. Each test fails on
 * the version of the code that has that fault: a list that needs a restart, a replaced file that keeps playing its
 * old bytes, a missing file that spins the ambience layer, an imported preset that overwrites a different sound.
 */

interface FakeFile {
  bytes: Uint8Array;
  seconds: number;
  mtimeMs: number;
}

const files = new Map<string, FakeFile>();
const presets = new Map<string, { text: string; mtimeMs: number }>();
const calls = { list: 0, read: [] as string[], write: [] as string[], opened: [] as unknown[] };
let changed: ((change: "sounds" | "presets") => void) | null = null;
let listGate: Promise<void> | null = null;

const wavBytes = (fill: number): Uint8Array => {
  const bytes = new Uint8Array(64);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WAVE"), 8);
  bytes.fill(fill, 16);
  return bytes;
};

function put(path: string, seconds: number, fill = 1, mtimeMs = 1000): void {
  files.set(path, { bytes: wavBytes(fill), seconds, mtimeMs });
}

const info = { root: "V:/ws/customization", soundsDir: "V:/ws/customization/sounds", presetsDir: "V:/ws/customization/presets", source: "workspace" as const };

const bridge = {
  getZaicodeCustomizationInfo: async () => info,
  listZaicodeCustomSounds: async () => {
    calls.list += 1;
    // The list is a snapshot of the folder at the moment main looks, however long the answer takes to arrive.
    const snapshot = [...files].map(([path, file]) => ({ path, seconds: file.seconds, bytes: file.bytes.length, mtimeMs: file.mtimeMs }));
    if (listGate) await listGate;
    return { info, truncated: false, sounds: snapshot };
  },
  readZaicodeCustomSound: async (path: string) => {
    calls.read.push(path);
    const file = files.get(path);
    return file ? { ok: true as const, bytes: file.bytes, mtimeMs: file.mtimeMs } : { ok: false as const, reason: "no such file" };
  },
  writeZaicodeCustomSound: async (request: { path: string; bytes: Uint8Array }) => {
    calls.write.push(request.path);
    const existing = files.get(request.path);
    let path = request.path;
    if (existing && Buffer.compare(Buffer.from(existing.bytes), Buffer.from(request.bytes)) !== 0) path = request.path.replace(/(\.[a-z]+)$/i, " (2)$1");
    const created = !files.has(path);
    if (created) files.set(path, { bytes: request.bytes, seconds: 1, mtimeMs: 5000 });
    return { ok: true as const, path, created, absolute: `${info.soundsDir}/${path}` };
  },
  listZaicodeCustomPresets: async () => [...presets].map(([name, file]) => ({ name, bytes: file.text.length, mtimeMs: file.mtimeMs })),
  readZaicodeCustomPreset: async (name: string) => (presets.has(name) ? { ok: true as const, text: presets.get(name)!.text } : { ok: false as const, reason: "no such file" }),
  writeZaicodeCustomPreset: async (request: { name: string; text: string }) => {
    presets.set(request.name, { text: request.text, mtimeMs: 1 });
    return { ok: true as const, path: request.name, created: true, absolute: `${info.presetsDir}/${request.name}` };
  },
  openZaicodeCustomization: async (request: unknown) => {
    calls.opened.push(request);
    return { ok: true, message: "" };
  },
  onZaicodeCustomizationChanged: (callback: (change: "sounds" | "presets") => void) => {
    changed = callback;
    return () => {
      changed = null;
    };
  },
};

// The window exists BEFORE the store module loads: it starts itself at import, like it does in the app.
const focusListeners: (() => void)[] = [];
(globalThis as Record<string, unknown>)["window"] = {
  zcode: bridge,
  addEventListener: (type: string, listener: () => void) => {
    if (type === "focus") focusListeners.push(listener);
  },
  removeEventListener: () => undefined,
};

const store = await import("../src/zaicode/zaicodeCustomSounds.js");
const catalog = await import("../src/zaicode/zaicodeSoundCatalog.js");
const tabs = await import("../src/zaicode/zaicodeSoundTabs.js");
const custom = await import("../src/zaicode/zaicodeCustomPresets.js");
const assets = await import("../src/zaicode/zaicodePresetAssets.js");
const presetFile = await import("../src/zaicode/zaicodePresetFile.js");
const panelModule = await import("../src/settings/ZaicodePresetsPanel.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("C1 the list is live: a file that appears in the folder shows up in the catalog after main's notice, with no restart", async () => {
  put("Horse/a.wav", 0.2);
  put("b.wav", 6);
  await store.refreshZaicodeCustomSounds();
  const state = store.getZaicodeCustomSounds();
  assert.equal(state.available, true);
  assert.deepEqual(state.mine.map((entry) => [entry.id, entry.name, entry.folder, entry.kind]), [
    ["customization:Horse/a.wav", "a", "Horse", "click"],
    ["customization:b.wav", "b", "", "long"],
  ]);
  assert.ok(state.catalog.length > state.mine.length, "the bundled library is still there");
  assert.ok(state.mine.every((entry) => state.catalog.includes(entry)));
  assert.equal(catalog.zaicodeSoundEntry("customization:b.wav")?.seconds, 6, "the picker finds an entry by its id");
  assert.equal(catalog.zaicodeSoundDisplayName("customization:Horse/a.wav"), "a · Horse");

  const before = state.version;
  let renders = 0;
  const stop = store.subscribeZaicodeCustomSounds(() => (renders += 1));
  put("Horse/HORSE07.wav", 1.2);
  assert.ok(changed, "the store listens for main's change notice");
  changed!("sounds");
  await settle();
  const after = store.getZaicodeCustomSounds();
  assert.equal(after.mine.length, 3);
  assert.ok(after.mine.some((entry) => entry.id === "customization:Horse/HORSE07.wav" && entry.kind === "alert"));
  assert.ok(after.version > before);
  assert.equal(renders, 1);

  // Nothing changed: a re-scan (window focus) tells nobody, so pickers do not re-render for nothing.
  for (const listener of focusListeners) listener();
  await settle();
  assert.equal(renders, 1);
  assert.equal(store.getZaicodeCustomSounds().version, after.version);
  stop();
});

test("C1b a refresh asked for during a scan waits for a scan that started after it: a file written a moment ago is in the list", async () => {
  put("late.wav", 1, 8, 6000);
  let release!: () => void;
  listGate = new Promise((resolve) => (release = resolve));
  // Scan A takes its snapshot now and is held; the file below appears after that snapshot.
  const first = store.refreshZaicodeCustomSounds();
  await settle();
  put("later.wav", 1, 9, 6100);
  const second = store.refreshZaicodeCustomSounds();
  const third = store.refreshZaicodeCustomSounds();
  listGate = null;
  release();
  await Promise.all([first, second, third]);
  assert.ok(store.getZaicodeCustomSounds().mine.some((entry) => entry.id === "customization:later.wav"), "the second ask returned only after a scan that saw the new file");
  files.delete("late.wav");
  files.delete("later.wav");
  await store.refreshZaicodeCustomSounds();
});

test("C2 a preset notice for another kind does not scan the sounds", async () => {
  const scans = calls.list;
  changed!("presets");
  await settle();
  assert.equal(calls.list, scans);
});

test("C3 a sound is read through main once, played from a URL, and read again only when the file changed", async () => {
  calls.read.length = 0;
  const revoked: string[] = [];
  const stop = store.onZaicodeCustomSoundUrlRevoked((url) => revoked.push(url));
  const first = await store.resolveZaicodeCustomSoundUrl("customization:b.wav");
  assert.match(first ?? "", /^blob:/);
  assert.equal(await store.resolveZaicodeCustomSoundUrl("customization:b.wav"), first);
  assert.equal(store.cachedZaicodeCustomSoundUrl("customization:b.wav"), first);
  assert.deepEqual(calls.read, ["b.wav"], "the second play needs no read");

  // The operator saves a new version over the file: the next play uses the new bytes, not the cached old ones.
  put("b.wav", 6, 9, 2000);
  await store.refreshZaicodeCustomSounds();
  assert.equal(store.cachedZaicodeCustomSoundUrl("customization:b.wav"), null, "the old bytes are no longer offered");
  assert.deepEqual(revoked, [first], "the old URL is released so its decoded copy can go too");
  const second = await store.resolveZaicodeCustomSoundUrl("customization:b.wav");
  assert.notEqual(second, first);
  assert.deepEqual(calls.read, ["b.wav", "b.wav"]);
  stop();
});

test("C4 a path the folder would refuse is never asked for", async () => {
  calls.read.length = 0;
  for (const id of ["customization:../x.wav", "customization:C:/x.wav", "customization:a.txt", "customization:", "fastprompter:x.wav"]) {
    assert.equal(await store.resolveZaicodeCustomSoundUrl(id), null, id);
  }
  assert.deepEqual(calls.read, []);
});

test("C5 the ambience layer's synchronous request starts one read, is called back when it lands, and does not spin on a missing file", async () => {
  calls.read.length = 0;
  put("loop.wav", 30, 3, 3000);
  await store.refreshZaicodeCustomSounds();
  let ready = 0;
  assert.equal(store.requestZaicodeCustomSoundUrl("customization:loop.wav", () => (ready += 1)), null, "not ready on the first ask");
  assert.equal(store.requestZaicodeCustomSoundUrl("customization:loop.wav", () => (ready += 1)), null, "asking again while it reads starts nothing");
  await settle();
  assert.equal(ready, 1);
  assert.deepEqual(calls.read, ["loop.wav"]);
  assert.match(store.requestZaicodeCustomSoundUrl("customization:loop.wav", () => undefined) ?? "", /^blob:/);

  calls.read.length = 0;
  let missingReady = 0;
  for (let ask = 0; ask < 5; ask += 1) {
    store.requestZaicodeCustomSoundUrl("customization:gone.wav", () => (missingReady += 1));
    await settle();
  }
  assert.equal(missingReady, 0);
  assert.deepEqual(calls.read, ["gone.wav"], "a file that is not there is read once, not on every reconcile");
  // The file appears: the list changes, so the next ask tries again and plays it.
  put("gone.wav", 2, 4, 4000);
  await store.refreshZaicodeCustomSounds();
  store.requestZaicodeCustomSoundUrl("customization:gone.wav", () => (missingReady += 1));
  await settle();
  assert.equal(missingReady, 1);
});

test("C6 a file that was removed stops playing and reads as missing, not as its raw id", async () => {
  await store.resolveZaicodeCustomSoundUrl("customization:Horse/a.wav");
  assert.ok(store.cachedZaicodeCustomSoundUrl("customization:Horse/a.wav"));
  files.delete("Horse/a.wav");
  await store.refreshZaicodeCustomSounds();
  assert.equal(store.cachedZaicodeCustomSoundUrl("customization:Horse/a.wav"), null);
  assert.equal(catalog.zaicodeSoundEntry("customization:Horse/a.wav"), undefined);
  assert.equal(catalog.zaicodeSoundDisplayName("customization:Horse/a.wav"), "a.wav (missing)");
});

test("C7 the Mine tab shows the folder's files whatever their kind, and only those", () => {
  const mine = { id: "customization:b.wav", kind: "long" as const };
  const library = { id: "fastprompter:QUEST.wav", kind: "long" as const };
  assert.equal(tabs.zaicodeSoundInTabs(mine, ["mine"], new Set()), true);
  assert.equal(tabs.zaicodeSoundInTabs(library, ["mine"], new Set()), false);
  assert.equal(tabs.zaicodeSoundInTabs(mine, ["click"], new Set()), false, "a long file is not a click");
  assert.equal(tabs.zaicodeSoundInTabs(library, ["mine", "long"], new Set()), true, "tabs combine");
  assert.equal(tabs.zaicodeSoundInTabs(library, ["all"], new Set()), true);
});

// ---------------------------------------------------------------- presets carry the folder's sounds

test("C8 a preset that names a customization sound carries its bytes and puts them back", async () => {
  put("Horse/HORSE07.wav", 1.2, 7, 1000);
  const blobs = assets.memoryBlobStore();
  // Settings are stored as objects inside a preset (strings stay raw); the id sits where the event row keeps its sound.
  const settings = { "zaicode-sound-events-v1": { events: { "ui.click": { sound: "customization:Horse/HORSE07.wav" } } } };
  const captured = await assets.capturePresetAssets(settings, [store.zaicodeCustomizationSoundSource], blobs);
  assert.deepEqual(captured.missing, []);
  assert.equal(captured.refs.length, 1);
  assert.deepEqual(captured.refs[0]!.id, "customization:Horse/HORSE07.wav");
  assert.equal(captured.refs[0]!.name, "HORSE07.wav");
  assert.equal(captured.refs[0]!.mime, "audio/wav");

  // Another machine: the same file name holds a DIFFERENT sound there. The preset's copy must land beside it.
  files.delete("Horse/HORSE07.wav");
  files.set("Horse/HORSE07.wav", { bytes: wavBytes(99), seconds: 3, mtimeMs: 1 });
  calls.write.length = 0;
  const restored = await assets.restorePresetAssets(captured.refs, [store.zaicodeCustomizationSoundSource], blobs);
  assert.deepEqual(restored.missing, []);
  assert.deepEqual(restored.renamed, { "customization:Horse/HORSE07.wav": "customization:Horse/HORSE07 (2).wav" });
  assert.equal(Buffer.compare(Buffer.from(files.get("Horse/HORSE07.wav")!.bytes), Buffer.from(wavBytes(99))), 0, "the other machine's own sound is untouched");
  assert.equal(Buffer.compare(Buffer.from(files.get("Horse/HORSE07 (2).wav")!.bytes), Buffer.from(wavBytes(7))), 0);
  // The catalog knows the new file by the time the settings name it.
  assert.ok(catalog.zaicodeSoundEntry("customization:Horse/HORSE07 (2).wav"));
  const rewritten = assets.rewriteSoundIds(settings, restored.renamed);
  assert.equal(JSON.stringify(rewritten).includes("HORSE07 (2).wav"), true, "the settings follow the file to its new name");
  assert.equal(JSON.stringify(settings).includes("HORSE07 (2).wav"), false, "and the original is not edited in place");
});

test("C9 a sound this installation does not have is reported missing, never swapped for another", async () => {
  const captured = await assets.capturePresetAssets({ key: "customization:nope.wav" }, [store.zaicodeCustomizationSoundSource], assets.memoryBlobStore());
  assert.deepEqual(captured.missing, ["customization:nope.wav"]);
  assert.deepEqual(captured.refs, []);
});

test("C10 the same sound imported twice adds no second copy", async () => {
  const blobs = assets.memoryBlobStore();
  const captured = await assets.capturePresetAssets({ key: "customization:b.wav" }, [store.zaicodeCustomizationSoundSource], blobs);
  const before = files.size;
  const restored = await assets.restorePresetAssets(captured.refs, [store.zaicodeCustomizationSoundSource], blobs);
  assert.deepEqual(restored.renamed, {});
  assert.equal(files.size, before);
});

// ---------------------------------------------------------------- the presets folder

test("C11 the presets folder: exports land in it with one click, the list is by page, a failed write falls back to a download", async () => {
  const folder = custom.zaicodePresetFolder();
  assert.ok(folder, "the desktop has a presets folder");
  const downloads: string[] = [];
  const download = (name: string) => void downloads.push(name);
  const prefix = presetFile.presetFilePrefix("zaicodeSounds");
  assert.equal(prefix, "zaicode-preset-sounds-");
  assert.equal(presetFile.presetFileName("zaicodeSounds", "Night shift"), "zaicode-preset-sounds-Night-shift.json");

  const placed = await custom.placeExportedPreset(folder, "zaicode-preset-sounds-Night-shift.json", "{}", download);
  assert.deepEqual(placed, { where: "folder", name: "zaicode-preset-sounds-Night-shift.json" });
  assert.deepEqual(downloads, [], "no download dialog when the folder took it");
  assert.deepEqual(await folder!.list(), ["zaicode-preset-sounds-Night-shift.json"]);
  assert.equal(await folder!.read("zaicode-preset-sounds-Night-shift.json"), "{}");
  assert.equal(await folder!.read("missing.json"), null);
  assert.equal(await folder!.location(), info.presetsDir);
  folder!.open();
  folder!.show("zaicode-preset-sounds-Night-shift.json");
  assert.deepEqual(calls.opened.slice(-2), [{ kind: "presets" }, { kind: "presets", file: "zaicode-preset-sounds-Night-shift.json" }]);

  const refusing = { ...folder!, save: async () => null };
  assert.deepEqual(await custom.placeExportedPreset(refusing, "x.json", "{}", download), { where: "download", fallback: true });
  assert.deepEqual(await custom.placeExportedPreset(null, "y.json", "{}", download), { where: "download", fallback: false });
  assert.deepEqual(downloads, ["x.json", "y.json"]);

  let heard = 0;
  const stop = folder!.onChange(() => (heard += 1));
  changed!("sounds");
  assert.equal(heard, 0, "a sounds notice is not a presets notice");
  changed!("presets");
  assert.equal(heard, 1);
  stop();
});

const memoryEnv = {
  read: () => null,
  write: () => undefined,
  sources: [],
  blobs: assets.memoryBlobStore(),
  undo: { get: () => null, set: () => undefined },
  rehydrate: () => true,
  reload: () => undefined,
  now: () => "2026-09-29T12:00:00.000Z",
};

test("C12 the panel offers the folder only when there is one", () => {
  const props = { section: "zaicodeSounds" as const, env: memoryEnv, prune: async () => undefined };
  const without = renderToStaticMarkup(createElement(panelModule.ZaicodePresetsPanel, props));
  assert.doesNotMatch(without, /data-zaicode-presets-folder/);
  assert.match(without, /Import file…/, "the file picker stays the way in");
  const withFolder = renderToStaticMarkup(createElement(panelModule.ZaicodePresetsPanel, { ...props, folder: custom.zaicodePresetFolder() }));
  assert.match(withFolder, /data-zaicode-presets-folder/);
  assert.match(withFolder, /In the presets folder/);
  assert.match(withFolder, /Open folder/);
  assert.match(withFolder, /Import file…/);
});

// ---------------------------------------------------------------- wiring a node test cannot execute

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const source = (relative: string): string => readFileSync(join(srcRoot, relative), "utf8");

test("C13 every place that lists or plays a sound goes through the live list", () => {
  const picker = source("zaicode/ZaicodeSoundPicker.tsx");
  assert.doesNotMatch(picker, /listZaicodeSoundCatalog\(\)/, "the picker must not read the build-time catalog alone");
  assert.equal((picker.match(/useZaicodeCustomSounds\(\)/g) ?? []).length, 2, "the picker and its body both follow the live list");
  assert.match(picker, /id: "mine"/, "the Mine tab exists");
  assert.match(source("zaicode/zaicodeSoundEvents.ts"), /resolveZaicodeCustomSoundUrl\(sound\)/, "event and timer sounds are read through main");
  assert.match(source("zaicode/zaicodeAudio.ts"), /requestZaicodeCustomSoundUrl\(id, reconcileAmbience\)/, "the ambience layer plays customization sounds");
  assert.match(source("zaicode/zaicodeAudio.ts"), /subscribeZaicodeCustomSounds\(\(\) => reconcileAmbience\(\)\)/, "and follows a replaced or removed file");
  assert.match(source("zaicode/zaicodePresetEnv.ts"), /sources: \[zaicodeOwnSoundSource, zaicodeCustomizationSoundSource\]/, "presets carry the folder's sounds");
  assert.match(source("settings/ZaicodeSoundSettings.tsx"), /<ZaicodeCustomSoundsStrip \/>/, "the Sounds page shows where the folder is");
  assert.match(source("settings/ZaicodePresetsMenu.tsx"), /folder=\{folder\}/, "the presets menu hands the panel the presets folder");
});
