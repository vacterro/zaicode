# T-126 -- customization folder and a live sound list (SRC-089): plan at the stop

State at the stop (2026-09-29, operator's usage limit): T-126 claimed at BUILD, NO product code written yet.
T-125 (presets) is DONE and already carries the seam this ticket plugs into. Read this together with
`T-125-T-126-customization-handoff.md` (operator's words, code facts) and `T-125-presets.md` (what exists).

## What T-125 already gives T-126

- Sound ids `customization:<relative path>` are valid in presets (`isPresetAssetSoundId`: no absolute path, no
  `..`, no drive letter, no control characters, <= 300 chars). No source handles them yet.
- `PresetSoundSource { handles, read, write }` in `zaicodePresetAssets.ts`; `write` may answer ANOTHER id and the
  settings follow (that is the never-overwrite rule). Add a `customization:` source next to
  `zaicodeOwnSoundSource` in `zaicodePresetEnv.ts` (`sources: [...]`).
- The presets menu (`ZaicodePresetsPanel.tsx`) exports through `downloadZaicodeTextFile`; the file name pattern is
  `zaicode-preset-<page>-<name>.json` (page = section id without `zaicode`, lower case).

## Decisions taken for the build (the operator said "just continue"; change them if they object)

1. **Root.** `customization\` next to `zcode\`. Resolution order in main: env `ZAICODE_CUSTOMIZATION_DIR`; env
   `ZAICODE_ROOT` + `\customization`; walk up from `process.execPath` to the first folder that holds `zcode\packages\desktop`
   (the packaged exe lives under it) + `\customization`; last resort `%APPDATA%\ZAICODE\customization`. Created at start:
   `sounds\`, `presets\`, and a `README.txt` (what goes where, "changes show up at once"). The launcher exporting
   `ZAICODE_ROOT` is optional (walk-up works without it); rebuilding the launcher needs `tools\launcher\build.cmd` and the
   running launcher exe may be locked, so do not touch it during a goal run.
2. **Main module** `packages/desktop/src/main/zaicodeCustomization.ts` (injectable fs, tested on a temp dir):
   `resolveCustomizationRoot`, `ensureFolders`, `scanSounds` (`.wav/.mp3/.ogg`, depth <= 6, <= 5000 files, skip symlinks,
   path must stay inside the real root), `readSound`, `writeSound` (same bytes -> same path, no write; different bytes ->
   suffix ` (2)`; answers the final relative path), `watchSounds` (`fs.watch` recursive, ~300 ms debounce, plus the renderer
   re-scans on window focus), `listPresets` / `readPreset` / `writePreset` (same non-overwrite rule), open-folder via
   `shell.openPath` / `showItemInFolder`.
3. **Length and kind.** Header parsing in main, cached by (path, mtime, size): WAV exact from `fmt `/`data`; OGG from the
   last page's granule position; MP3 from a Xing/Info frame count or a CBR estimate; else `-1`. `categorizeZaicodeSound`
   already treats `seconds < 0` as "alert", so an unknown length is safe.
4. **IPC** (pattern: `shared/src/channels.ts` name + contract -> `platform.ts` -> `client/src/globals.d.ts` ->
   `desktop/src/preload/index.ts` -> `desktop/src/renderer/src/desktopPlatform.ts` -> `desktopMainIpcPlatform.ts`):
   info, list-sounds, read-sound, write-sound, list-presets, read-preset, write-preset, open-folder, and one
   main -> renderer event `changed`. The renderer never passes a raw path outside the customization root.
5. **Renderer.** `zaicodeCustomSounds.ts`: a module store (`useSyncExternalStore`) fed by list + `changed` + window focus;
   `useZaicodeSoundCatalog()` merges these entries (id `customization:<rel>`, name = file name, folder = its folder,
   `seconds`, `kind`) into the static manifest catalog; the picker uses the hook instead of `listZaicodeSoundCatalog()`
   (two call sites in `ZaicodeSoundPicker.tsx`) and gets a **Mine** tab (`ZaicodeSoundTab` += `"mine"`, `zaicodeSoundInTabs`).
   Playback: `resolveSoundUrl("customization:...")` reads bytes through IPC -> blob URL cached by id + mtime;
   `zaicodeSoundUrl` (sync) answers the cached URL or null; ambience (`ambienceUrl` in `zaicodeAudio.ts`) uses the same
   sync cache and primes it then calls `reconcileAmbience()`. `zaicodeSoundDisplayName` shows `name · folder (customization)`.
   A chosen sound whose file is gone plays nothing and shows as missing (pools already mark `missing`).
6. **UI.** Sounds page: a strip "Your sounds folder: <path>  [Open folder]" with the live count. Presets menu: Export
   writes into `customization\presets\` (falls back to the download when there is no desktop) and shows
   "Saved as ...  [Show in folder]"; under Import a list "In the presets folder" of files whose name starts with
   `zaicode-preset-<this page>-` (read on click, then the usual preview).
7. **The operator's twenty `HORSE*.wav`** stay where they are (untracked in `zcode/packages/ui/src/assets/fastprompter-sounds/`);
   they are bundled at build time as before. Moving them into `customization\sounds\` makes them appear live; the operator
   decides.

## Tests to write (red-controlled, per VERIFY-ORACLE-01)

- header parsing (WAV/OGG/MP3/unknown), root resolution (each source, precedence), scan (subfolders, extensions, symlink
  and traversal refused), write (same bytes, different bytes -> suffix, path escape refused), watch (drop a file -> the
  callback fires once, debounced), IPC pin tests, store + catalog merge, `mine` tab, preset source round trip with a
  `customization:` sound (save on A, apply on B where a different file of that name exists -> renamed id, settings follow).
- Gate: `pnpm run verify:pre-push` in `zcode/`; packaged check: drop a file into a temp customization dir, it appears in the
  list without a restart.

## Also still open

T-127 (pool UX, design in the handoff), T-128 (UI rebuild pass for clumsy screens; likely `window.prompt` in Session text
presets and `window.confirm` in its import), T-113 (translation workload, parked behind T-126).
Staged bundle of product `e7c5723` (T-125 + T-129) was started into `zcode/packages/desktop/dist-next` at the stop; check
`dist-next/win-unpacked/ZAICODE.exe` and the boot receipt, then the operator restarts to look at presets and ProTrail.
