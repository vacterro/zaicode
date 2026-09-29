# T-125 -- presets for every Settings page (SRC-088)

Operator ask: "presets in Sound settings, and ideally in every section: presets, imports, exports, saves --
meant for people to share their presets easily. If a user added custom sounds, account for that on export and
import, smartly."

Product commits (zcode, branch zaicode): `6789704` (feature) and `e7c5723` (review fixes).

## What the operator gets

A **Presets** button at the right of the Settings page title, on ten pages: Sounds, Notifications, Colors,
ProTrail, Timers, Hotkeys, Sidebar, Layout & home, Workers & terminal, Engines & limits. (Highlights & motion
and Session text keep the preset systems they already had; General, Router and Help hold nothing to share.)

The popover offers, per page: save the page as it is now under a name; **Apply**; replace a preset with the
current settings (two clicks); **Export** as `zaicode-preset-<page>-<name>.json`; delete (two clicks); rename
(click the name); **Import file...** with a preview before anything is stored (page, how many stored settings
would change, which own sounds come along, what was left out) and a choice of Add and apply / Add to list /
Cancel; **Reset to defaults** (two clicks); and **Undo "<preset>"** after any apply or reset.

Presets are shared by all profiles (like the Highlights presets). At most 40 per page.

## Own sounds ("custom sounds handled smartly")

Settings only NAME a sound (`custom:sidebar.project`); the file is in IndexedDB. A preset therefore carries the
bytes: saved presets keep a sha256 reference and the bytes live once per digest in a blob store
(`zaicode-preset-blobs`); an exported file embeds them as base64 with the digest. On import every sound is
checked against its digest and size; a sound whose bytes do not match is left out and said. A sound the
preset names but this installation no longer has is REPORTED ("No sound file for X: that event stays silent
until you pick a sound"), never replaced by another. A sound source may put a sound under another id (the
customization folder of T-126 will never overwrite a different file of the same name): the settings then
follow the rename. Sound ids of the future customization folder (`customization:<path>`) are already valid
and validated (no absolute path, no `..`, no drive, no control characters); no source handles them yet.

## What never travels ("local facts")

`section.local` names dotted paths inside a stored setting that belong to this machine or to right now. They
are not captured, not compared, stripped from a file on read, and an apply leaves the page's own value:
Problip `running` and `problipDays` (Sounds), the sidebar's `groups` (project paths), Dispatch `launchers`
(command lines that Dispatch runs -- a shared file must never add one) and `lastProject`, the home page's
`lastView`, FancyZones `fastIndex`. A reset keeps these too.

## Apply, Undo, reload

Apply snapshots the page (settings and the own sounds it uses AND the ones the preset is about to overwrite,
even when the current settings do not use them) into a one-step Undo record per page, restores sounds,
writes settings, then puts the values in front of the open window. **Sounds does this live** (three stores
re-read storage: sound table, Problip/Ambience -- a running Problip stays running -- and the picker's
favourites). **Every other page reloads the window** (like a profile switch) and comes back to the same
Settings page with "Applied ..." and an Undo button; the mark is a sessionStorage entry read once per page
load, and Settings opens once the workspace has stopped opening tabs. The Undo record is persisted, so it
survives that reload. A write that storage refuses puts the page and the replaced sounds back, keeps no undo
record and raises the error.

## Where things are (zcode/packages/ui)

- `src/zaicode/zaicodePresetSections.ts` -- closed section -> keys registry, `local` paths.
- `src/zaicode/zaicodePresetFile.ts` -- values, capture/compare/apply, local facts, file format, parse (never trusted).
- `src/zaicode/zaicodePresetAssets.ts` -- own sounds: sources, blob store interface, capture/restore/rewrite, prune.
- `src/zaicode/zaicodePresetApply.ts` -- save, refresh, apply, reset, undo, export, preview, adopt, outcome text.
- `src/zaicode/zaicodePresetStore.ts` -- the saved list and the undo records (zustand + localStorage, normalized on read).
- `src/zaicode/zaicodePresetEnv.ts`, `zaicodePresetBlobs.ts`, `zaicodePresetReopen.ts`, `useZaicodePresetReopen.ts` -- the real environment.
- `src/zaicode/zaicodeSoundEvents.ts` -- `storeZaicodeOwnSound`, `readZaicodeOwnSound` (import goes through the same step).
- `src/settings/ZaicodePresetsMenu.tsx`, `ZaicodePresetsPanel.tsx`, `ZaicodePresetImportPreview.tsx`; mounted in `SettingsPage.tsx`.
- Tests: `test/zaicodeSrc88Preset{File,Apply,Store,Ui,UiList}.test.ts`, `test/support/presetStorage.ts` (44 tests).

## Verification (all quoted from real runs)

- `pnpm run verify:pre-push` exit 0 at 6789704 and again at e7c5723: ui 715, services 85, desktop 131 pass 2
  skipped, cli 30; oxlint 0 errors; architecture 0 new.
- Nine red controls (mutation of the implementation, named test goes red, tree restored, suites green):
  undo without the overwritten sound (A4), capture without stripping local facts (P13), apply without keeping
  them (P13, P14), digest check off (A7), no write rollback (A10, A11), missing sound not reported (A5),
  title row without the menu (U5), non-Sounds page claiming to be live (U6), section key filter off (P10).
- One real bug found by a test on the way: an Undo that did not bring back an own sound the current settings
  no longer referenced (A4).

## NOT verified

- No packaged E2E of the popover yet (Radix popover in the real window, the file dialogs, the reload and the
  reopen). A staged bundle with T-125..T-128 is planned; operator look pending.
- Live rehydrate exists for Sounds only. Every other page reloads the window; if that feels heavy, the next
  step is a per-page `reload*` function like the three for Sounds.

## Follow-ups

- T-126: customization folder source (`customization:<path>`), presets folder for userpref packs.
- A Help topic for presets; an "all pages at once" pack if wanted.
