# T-134 -- more control, a zero-setup FREE model, one ZAICODE of four parts, a one-click installer (SRC-097)

Operator (2026-09-30, Russian): more control over practically every element, icon, sound (where there is none yet),
placement and conditions; check that the FREE model and its installation take no effort on a first install; ZAICODE +
SAIPEN + SAIMAIL as one whole whose parts update separately and come in by themselves; a beautiful one-click installer
that is proven to work; then commit and push to the main branches.

## Control (product, zcode `6945ef0`, `e392e5d`)

| Before | After |
|---|---|
| 30 icon slots; every sidebar header / footer button and menu line drew a fixed lucide icon | +28 slots: `tool.*` (a button looks the same in header and footer, incl. mute/muted, menu/menuOpen, prev/next) and `nav.*` (every menu line). The layout editor shows each row's icon; a click edits it in place (emoji, picture URL, badge) |
| a ticked button / line was always on screen | per entry `when`: always / while working / while idle / on hover; applied by header, footer, menu and the working meter |
| sound rows: on/off, sound or pool, gain, mix/cut; conditions only global | per row: only in the background / only in front (wins over the master focus switch), also in quiet hours, at most once per 5 s .. 1 h; "When" column (two-letter tag) unfolds a sub-row |
| silent: SAIFREN ready, a new free model, updates | `free.ready`, `free.newModel`, `update.available`, `update.applied`, `update.failed` (new "Updates" group) |
| operator's HORSE01..27 in the folder, not in the picker | manifest regenerated (1311 sounds) |

## FREE with no setup (zcode `636691f`, `84b19d1`, `b3aae16`)

`packages/desktop/scripts/verify-zaicode-free.cjs`: packaged app, empty profile (own HOME, APPDATA, LOCALAPPDATA; every
CLAUDE*/CODEX*/ANTHROPIC*/OPENAI*/GEMINI* variable of this machine removed), no click in any setting.

| Build | Router | First token | New task answered |
|---|---|---|---|
| live dist (1677486, 0.5.65-extra bundled) | isolated :20138 | 1.1 s | PONG after 3 s (16 s from start) PASS |
| same, `--router-package` = 9router 0.5.91-extra (T-135) | isolated | 1.2 s | after 2 s PASS |
| staged dist-next (636691f) | isolated | 0.8 s | after 4 s (18 s) PASS |

Defects found on the way and fixed:
- a fresh machine showed "Claude 1 / Codex 1: sign-in required" under Needs you and a red HEALTH for subscriptions never
  set up: a login whose default home does not exist is now `optional` ("optional, sign in any time", no "!", not a
  Needs-you item); a login that was set up and broke still asks (UI test F1).
- SAIHOME kept "Router up - no SAIFREN pool" (red HEALTH) after "SAIFREN is ready": the router store is read again
  when the setup result is stored (UI test F2; the free gate now fails on the stale line).
- **the first app build of any one-click install died** in `prepare-prebuilds.mjs`: Node binaries for remote
  workspaces come as `.tar.xz`, Windows' own tar needs an external `xz` a fresh Windows lacks. On Windows hosts the same
  archives are taken as `.tar.gz` (verified: `tar -xzf` of node-v22.16.0-linux-arm64.tar.gz with System32 tar). The
  developer machine never saw it because its mock-cdn cache held the binaries.

## One ZAICODE, four parts (zcode `40647c3`; workspace `519e9881`)

`install\Update-ZAICODE.ps1` (the installer library) fast-forwards workspace / app / SAIPEN / SAIMAIL alone with each
follow-up; local work always wins. The desktop main process runs it (3 min after start, every 6 h; "by itself" per part,
on in an installer-made ZAICODE); Settings -> ZAICODE opens with the Updates card.
- `install\tests\Test-ZaicodeUpdate.ps1`: 23 assertions on throw-away repos, PASS.
- `packages/desktop/test/zaicodeUpdates.test.ts`: R1..R7, 7/7.
- Dev checkout, real GitHub: `Update-ZAICODE.ps1 -Check -Json` -> workspace ahead 21, app ahead 54, saipen/saimail
  missing (managed=false, nothing moved).

## Installer (workspace `519e9881`)

- Defect: `RootBranch = 'workspace'` and the raw/one-liner URLs named a branch that left GitHub on 2026-09-27 -> an
  install from nothing failed at the first clone. Now `master`.
- Defect: `install/ZAICODE-Setup.exe` was gitignored, so the README could not link a one-click installer. Now tracked.
- `ZAICODE-Setup.exe`: WinForms window in the launcher-splash palette; live step list from `##ZAICODE {json}` progress.

## Gates

- `pnpm run verify:pre-push` (zcode, after the four feature commits' content): exit 0 -- lint 0 errors (107 warnings, none
  in T-134 files after the test's escape fix), architecture OK, ui 793/793, services 86/86, desktop 195 + 2 skipped, cli 30.
- `pnpm run typecheck`: exit 0.
- T-134 tests red on the old source: `zaicodeT134Control.test.ts` and `zaicodeUpdates.test.ts` run in a worktree of
  1677486 fail with ERR_MODULE_NOT_FOUND (their modules do not exist there); green on the new tree (15/15, 7/7).
- Staged bundle of 636691f into dist-next: packaged boot gate PASS (shell, 29 Settings sections, ProTrail on 3 monitors,
  customization live, 0 uncaught exceptions, 0 console errors).
- `tools\launcher\build.cmd`: exit 0.
