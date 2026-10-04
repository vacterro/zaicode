import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZaicodePresetImportPreview } from "../src/settings/ZaicodePresetImportPreview.js";
import { ZaicodePresetsPanel } from "../src/settings/ZaicodePresetsPanel.js";
import type { PresetEnv } from "../src/zaicode/zaicodePresetApply.js";
import { memoryBlobStore } from "../src/zaicode/zaicodePresetAssets.js";
import { formatSoundSize, importPreviewLines, missingSoundsNote, ownSoundsLabel, presetDateLabel, presetMeta } from "../src/zaicode/zaicodePresetLabels.js";
import { ZAICODE_PRESET_REOPEN_KEY, markPresetReopen, takePresetReopen } from "../src/zaicode/zaicodePresetReopen.js";

/**
 * SRC-088 (T-125): the presets menu as a person meets it. Rendered with a memory environment (no window behind
 * it), plus source pins for the wiring that a node test cannot execute: the Settings title row, the reload that
 * comes back to the same page, and the three sound stores that let Sounds take a preset without a reload.
 */

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const read = (relative: string): string => readFileSync(join(srcRoot, relative), "utf8");

const env: PresetEnv = {
  read: () => null,
  write: () => undefined,
  sources: [],
  blobs: memoryBlobStore(),
  undo: { get: () => null, set: () => undefined },
  rehydrate: () => true,
  now: () => "2026-09-29T12:00:00.000Z",
};
const prune = async () => undefined;

test("U1 the words: sizes, dates, what a file would do, which sounds could not be kept", () => {
  assert.equal(formatSoundSize(600), "600 B");
  assert.equal(formatSoundSize(20 * 1024), "20 KB");
  assert.equal(formatSoundSize(2.5 * 1024 * 1024), "2.5 MB");
  assert.equal(ownSoundsLabel(1), "1 own sound");
  assert.equal(ownSoundsLabel(3), "3 own sounds");
  assert.equal(presetDateLabel("2026-09-29T12:00:00.000Z"), "29 Sep 2026");
  assert.equal(presetDateLabel(new Date(0).toISOString()), "", "a file that named no date shows none");
  assert.equal(presetMeta({ createdAt: "2026-09-29T12:00:00.000Z", assets: [] }), "29 Sep 2026");
  assert.equal(
    presetMeta({ createdAt: "2026-09-29T12:00:00.000Z", assets: [{ id: "custom:a", kind: "sound", name: "a.wav", mime: "audio/wav", bytes: 1, sha256: "a".repeat(64) }] }),
    "29 Sep 2026 · 1 own sound",
  );
  const preview = {
    file: { kind: "zaicode-preset", version: 1, section: "zaicodeSounds", name: "x", createdAt: "", settings: {}, assets: [] },
    notes: [],
    changes: 2,
    sounds: [{ id: "custom:a", name: "neigh.wav", bytes: 20 * 1024 }],
  } as never;
  assert.deepEqual(importPreviewLines(preview, "Sounds"), ["Would change 2 stored settings of Sounds (not applied until you say so).", "Brings 1 own sound: neigh.wav (20 KB)."]);
  assert.match(importPreviewLines({ ...(preview as object), changes: 0, sounds: [] } as never, "Sounds")[0]!, /set exactly like this already/);
  assert.equal(missingSoundsNote([], "saved"), "");
  assert.match(missingSoundsNote(["custom:sidebar.project"], "exported"), /No sound file for sidebar\.project .* that event is silent .* before sharing/);
});

test("U2 an import shows what it would do BEFORE anything is stored: page, changes, sounds, what was left out, then three ways forward", () => {
  const html = renderToStaticMarkup(
    createElement(ZaicodePresetImportPreview, {
      preview: {
        file: { kind: "zaicode-preset", version: 1, section: "zaicodeSounds", name: "Night shift", createdAt: "2026-09-29T12:00:00.000Z", app: "ZAICODE", settings: {}, assets: [] },
        notes: ["3 settings that Sounds does not own were left out (a, b, c)"],
        changes: 1,
        sounds: [{ id: "custom:a", name: "neigh.wav", bytes: 6 }],
      },
      sectionTitle: "Sounds",
      name: "Night shift",
      busy: false,
      onName: () => undefined,
      onAdd: () => undefined,
      onAddAndApply: () => undefined,
      onCancel: () => undefined,
    }),
  );
  assert.match(html, /Import a Sounds preset/);
  assert.match(html, /29 Sep 2026 · by ZAICODE/);
  assert.match(html, /Would change 1 stored setting of Sounds/);
  assert.match(html, /Brings 1 own sound: neigh\.wav \(6 B\)/);
  assert.match(html, /3 settings that Sounds does not own were left out/, "what the file held that could not be used is said, not swallowed");
  assert.match(html, /value="Night shift"/);
  for (const label of ["Add and apply", "Add to list", "Cancel"]) assert.match(html, new RegExp(`>${label}<`));
});

test("U3 an empty page offers save, import and reset; a Sounds page says its own files travel", () => {
  const sounds = renderToStaticMarkup(createElement(ZaicodePresetsPanel, { section: "zaicodeSounds", env, prune }));
  assert.match(sounds, /Presets · Sounds/);
  assert.match(sounds, /No presets yet\. Save the current settings above, or import a file\./);
  assert.match(sounds, /Name for the new preset/);
  assert.match(sounds, />Save current</);
  assert.match(sounds, /Import file…/);
  assert.match(sounds, />Reset to defaults</);
  assert.match(sounds, /Your own sound files travel inside it/);
  assert.doesNotMatch(sounds, /Undo “/, "nothing to undo yet");
  const colors = renderToStaticMarkup(createElement(ZaicodePresetsPanel, { section: "zaicodeColors", env, prune }));
  assert.match(colors, /Presets · Colors/);
  assert.doesNotMatch(colors, /sound files travel/);
});

test("U4 the reopen mark survives one reload for a page with presets and nothing else", () => {
  const data = new Map<string, string>();
  const store = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
  assert.equal(takePresetReopen(store), null);
  markPresetReopen(store, { section: "zaicodeColors", note: "Applied “Amber”" });
  assert.deepEqual(takePresetReopen(store), { section: "zaicodeColors", note: "Applied “Amber”" });
  assert.equal(takePresetReopen(store), null, "taken once");
  store.setItem(ZAICODE_PRESET_REOPEN_KEY, JSON.stringify({ section: "zaicodeRouter", note: "x" }));
  assert.equal(takePresetReopen(store), null, "a page without presets is not opened");
  assert.equal(data.has(ZAICODE_PRESET_REOPEN_KEY), false, "and the mark is gone either way");
  store.setItem(ZAICODE_PRESET_REOPEN_KEY, "{not json");
  assert.equal(takePresetReopen(store), null);
  store.setItem(ZAICODE_PRESET_REOPEN_KEY, JSON.stringify({ section: "zaicodeSounds", note: "y".repeat(900) }));
  assert.equal(takePresetReopen(store)!.note.length, 300);
});

test("U5 wiring: the title row of every page with presets holds the menu, and the runtime reopens the page after a reload", () => {
  const page = read("SettingsPage.tsx");
  assert.match(page, /import \{ ZaicodePresetsMenu \} from "@\/settings\/ZaicodePresetsMenu\.js"/);
  assert.match(page, /zaicodePresetSectionForSettings\(activeSection, isZaicodeProductMode\(\)\)/);
  assert.match(page, /<ZaicodePresetsMenu section=\{activePresetSection\}/);
  const menuAt = page.indexOf("<ZaicodePresetsMenu section=");
  assert.ok(menuAt > 0 && menuAt < page.indexOf("<GeneralSectionHeader"), "in the title row, above the page content");
  const runtime = read("zaicode/ZaicodeAppRuntime.tsx");
  assert.match(runtime, /useZaicodePresetReopen\(useTabStore\(\(state\) => state\.tabs\.length\)\);/);
  const hook = read("zaicode/useZaicodePresetReopen.ts");
  assert.match(hook, /takePresetReopen\(sessionStorage\)/);
  assert.match(hook, /openZaicodeSettings\(marker\.section\)/);
  assert.match(hook, /actionLabel: "Undo"/, "the message after a reload can take the change back");
  assert.match(hook, /tabCount > 0 \? SETTLE_MS : NO_TABS_MS/, "Settings opens after the workspace has stopped opening tabs");
  assert.match(hook, /\[tabCount\]\);/, "a new tab restarts the wait");
});

test("U6 wiring: all preset sections refresh their stores without renderer reload authority", () => {
  const environment = read("zaicode/zaicodePresetEnv.ts");
  assert.match(environment, /rehydrate:\s*\(section\) => rehydrateZaicodePresetSection\(section\)/);
  assert.doesNotMatch(environment, /markPresetReopen|window\.location\.reload/);
  const dispatcher = read("zaicode/zaicodePresetRehydrate.ts");
  assert.match(dispatcher, /zaicodeSounds:\s*\[reloadZaicodeSoundSettings, reloadZaicodeAudio, reloadZaicodeSoundPickerPrefs\]/);
  assert.match(environment, /localStorage\.removeItem\(key\)/, "an unset value removes the key: the release default returns");
  const model = read("zaicode/zaicodeSoundSettingsModel.ts");
  assert.match(model, /export function reloadZaicodeSoundSettings\(\): void \{\s*cached = null;[\s\S]*?dispatchEvent\(new Event\(CHANGE_EVENT\)\)/);
  const audio = read("zaicode/zaicodeAudio.ts");
  assert.match(audio, /export function reloadZaicodeAudio\(\): void \{\s*const running = cached\?\.problip\.running \?\? false;\s*cached = null;/, "a Problip that is running stays running");
  const picker = read("zaicode/ZaicodeSoundPicker.tsx");
  assert.match(picker, /export function reloadZaicodeSoundPickerPrefs\(\): void \{\s*prefsCache = null;\s*window\.dispatchEvent\(new Event\(PREFS_EVENT\)\)/);
});

test("U7 wiring: importing an own sound and restoring one from a preset use the same storage step, which forgets the cached old file", () => {
  const engine = read("zaicode/zaicodeSoundEvents.ts");
  assert.match(engine, /export async function storeZaicodeOwnSound\(id: string, blob: Blob, name: string\)/);
  assert.match(engine, /await storeZaicodeOwnSound\(id, file, file\.name\);\s*setZaicodeSoundEvent\(id, \{ sound: `custom:\$\{id\}` \}\);/);
  const store = engine.slice(engine.indexOf("export async function storeZaicodeOwnSound"), engine.indexOf("export async function importZaicodeSoundFile"));
  assert.match(store, /customUrls\.delete\(sound\)/, "the object URL of the old file is dropped");
  assert.match(store, /buffers\.delete\(previous \?\? ""\)/, "and so is its decoded buffer");
  assert.doesNotMatch(store, /setZaicodeSoundEvent/, "storing a sound selects nothing: a preset brings its own settings");
  assert.match(read("zaicode/zaicodePresetEnv.ts"), /storeZaicodeOwnSound\(id\.slice\("custom:"\.length\)/);
});
