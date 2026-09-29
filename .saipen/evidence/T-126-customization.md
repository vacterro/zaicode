# T-126 -- customization folder and a live sound list (SRC-089): what was built and how it was checked

Product commit: see the LOG line of the VERIFY pass (zcode branch `zaicode`). Plan and decisions: `T-126-plan.md`; operator's words and
code facts: `T-125-T-126-customization-handoff.md`.

## What the operator asked

1. The sound list updates in real time when they add their own sounds.
2. One findable folder for those sounds (their example: `...\_ZAICODE\customization\sounds`), and the same idea for the other
   customization pieces that get exported and imported.

## What is there now

- **Folder.** `customization\` next to `zcode\` (found by walking up from the executable to the folder that holds `zcode\packages\desktop`;
  overrides `ZAICODE_CUSTOMIZATION_DIR`, `ZAICODE_ROOT`; last resort `%APPDATA%\ZAICODE\customization`). Created at start with `sounds\`,
  `presets\` and a README. `customization/` is in the workspace `.gitignore`: it is the operator's data, never a checkpoint.
- **Live list.** The main process watches both folders (`fs.watch`, recursive for sounds, 300 ms debounce, one notice per burst) and tells
  every window over `zaicode:customization-changed`; the window re-lists, and also re-lists when it gets focus (safety net). Lengths come
  from headers (WAV exact, OGG from the last page, MP3 from Xing/VBRI or the bitrate, big cover-art ID3 tags skipped) and are cached by
  path + mtime + size. A picker held open on the **Mine** tab gets the new row without a click.
- **Playing.** `customization:<path inside sounds\>` ids play everywhere a sound id plays: event table, timers, reminders, picker audition,
  Ambience (it starts when the read lands and follows a replaced or removed file). The window reads the bytes through main by path and plays
  from a blob URL cached by mtime, so a file saved over plays its new bytes. It never sees or sends an absolute path.
- **Presets (T-125 seam).** A preset that names a customization sound carries its bytes; importing writes the file into `sounds\` without
  replacing a different file of that name (`name (2).wav`) and the settings follow the new id; identical bytes add nothing. Export from the
  Presets menu now saves into `presets\` with one click ("Show in folder"), falls back to the download when there is no desktop or the
  folder refuses; under Import the files named for this page are listed and read on click, then the usual preview.
- **Findable.** Sounds page strip: the full path, the live count, Open folder, Scan again. The picker's footer has a Folder button.

## Checks

Gate: `pnpm run verify:pre-push` exit 0 (oxlint 0 errors, architecture 0 new, ui/services/desktop/cli suites pass), `pnpm run typecheck` exit 0.
New tests: desktop `zaicodeSoundHeader` (11), `zaicodeCustomization` (21), `zaicodeCustomizationIpc` (5); ui `zaicodeSrc89CustomSounds` (14).

Red controls (a wrong version of the code turns the named test red): WAV rate arithmetic, WAV odd-chunk padding, OGG granule above 32 bits,
write flag `wx` (six racing writers), identical-bytes recognition, real-path containment, the debounce, the length cache, the big ID3 tag branch,
mtime-keyed URL cache, no-retry of a missing file, no-op rescan, renamed id after a clash, the Mine tab, export placement, the queued refresh.
One guard is not separately red: the explicit `isSymbolicLink()` skip in the scan is redundant with `Dirent` semantics (a link is neither file
nor directory there); its behaviour is still pinned by the "link out of the folder is not followed" test.

Real Electron (built `out/`, dev electron, throw-away profile, `ZAICODE_CUSTOMIZATION_DIR` inside it), `verify-zaicode-customization.cjs`:
folder and README created; a Mine picker held open shows "Nothing here yet", then the row `tick` (folder `Gate`) after a file is dropped from
outside the app; the Sounds page count goes 0 -> 1 -> 2 (second file written through the app: a different sound under a taken name lands as
`tick (2).wav`, the original untouched) -> 0 (folder deleted); the header length equals Chromium's decoded length; `../README.txt` and `C:/x.wav`
are refused by main; a `.json` dropped in `presets\` is listed and a `.txt` is not. The same check now runs inside the packaged boot gate
(`verify-zaicode-boot.cjs`), so a staged bundle cannot pass without it.

## Left to the operator / not done

- The twenty `HORSE*.wav` (untracked) are untouched in `zcode/packages/ui/src/assets/fastprompter-sounds/`; they still ship inside the app.
  Moving them into `customization\sounds\` makes them live-listed and removes them from the bundle -- the operator decides.
- The launcher does not export `ZAICODE_ROOT` (not needed; the walk-up finds the workspace). An installed copy outside any workspace uses
  `%APPDATA%\ZAICODE\customization`.
- Not tested by ear: nothing was played through speakers; playback is proven by decoding the same bytes in Chromium.
- Limits, on purpose: 5000 files, 5 folders deep, 100 MB per sound in the folder (25 MB per sound inside a preset file).
