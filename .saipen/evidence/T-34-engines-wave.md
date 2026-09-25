# T-34 Evidence: engines, workers, limits, autostart, sounds, hotkeys, bugs (SRC-029)

## Scope mapped from SRC-029

| Request | Delivered |
|---|---|
| Hotkeys on any keyboard layout | `zaicodeKeys.ts` (`KeyboardEvent.code` first); Ctrl+Q, zone picker keys, Ctrl+Z archive undo, Ctrl+S search rules. Upstream shortcut kernel already falls back to `code`. |
| Strongest LIMISAW ideas | discovered accounts (`~/.claude*`, `~/.codex*`, agy login, ZCode plan), zero-cost vendor reads, pool-aware gating, elapsed reset = full, last-good carry-forward (stale), refill/low alerts once per cycle, add-second-account button, connection states with exact fix commands, right-hold window move. |
| Limits unobtrusive, click-and-done | discovery at launch, first sweep 8 s later, 5 min interval, cache on disk; "Connect everything" shows the exact login/install commands and runs them in WORKERS tabs on one click. |
| FastPrompter ideas + every sound configurable | Settings -> Sounds: 43 action rows (on, sound from the 1294-file library or own file, mix/cut, gain dB vs master, preview), STOP ALL, enable/disable all, reset, diagnostics; `data-zaicode-sound` + `playZaicodeSound` hooks. Title-bar AI limit meter (Stacked/Bars/Dots, hover breakdown, Ctrl+Click style, Shift+Click read-all). Ctrl+Q full clone. |
| AUDAPACK ideas | per-project launcher row (⋯ menu: A1 A2 C1 C2 C3 AG ZC with quota fill), running-worker chips on project rows, autostart (prepared launches) with triggers at/daily/interval/on-refill/every-refill, safety delay, catch-up window, wait-for-quota, exactly-once event ids. |
| Subscriptions as engines (all except Freebuff) | Claude 1/2, Codex 1/2/3, Antigravity, ZCode discovered; sidebar engine picker (no combobox) with quota-filled tiles; START and new draft prompts go to the picked subscription as a worker; WORKERS window keeps every CLI alive across project switches. |
| Autostart | `zaicodeAutostart.ts` + Settings -> Engines & limits; also ZAICODE's own START as an engine; "Start ZAICODE with Windows" (HKCU Run -> root launcher). |
| Bug: sidebar shifted left | `zaicodeScrollGuard.ts` resets hidden horizontal scroll in and around the sidebar; list container `overflow-x-hidden`. |
| Bug: rows vanish down while dragging | project sections frozen for the duration of a drag (LIVE-first reorder / slot changes no longer move sortable items under dnd-kit). |
| Group view colors | project stripe (stable color per project), todo cells under the title, role glyph, error/needs-you title tones. |
| Subsession icons | pixel SVG role glyphs (MAIN, side, WIKI, TRANSL, TEST, AUDIT, HUNT, CLEAN, CREW) recorded at launch, so renamed sessions keep them; emoji + title-word regex removed. |
| SAIMAIL empty text | persistent opened-letter count; "Empty. / Maybe, someone one day will mail you, who knows..." -> "Hmm, maybe another one?..." -> quiet escalating lines; indented layout; legal description hidden in the empty state; home line shows it too. |
| Right-button drag anywhere | pointer capture + main process places the window at the real cursor (no drift, keeps following outside the window). |
| Ctrl+Q full clone with settings | Quarters/Columns/Presets pages, S save (10 max, maximized kept), Del remove, 1-9/0, Tab/arrows, Enter, Esc/Q, picker under the pointer, fast mode, hotkey on/off, presets page on/off, snap sound. |
| Agent must resolve itself | goal verdict: only secrets/money/physical/destructive/legal/operator-only blockers stop `/goal cc all`; "needs user decision" content choices, missing files, non-human WAITs are pushed back with "decide yourself"; loop guard 2 pushes per blocker. |
| Composer strip | START shows the picked engine (`START ▸A1`), route hint line; strip layout from T-33 kept. |

## Resume (2026-09-24 20:45 UTC, claude-code)

The first session implemented the wave and built a bundle (17:29 UTC) but
stopped before VERIFY. The resumed session re-audited the diff and fixed:

| Finding | Fix |
|---|---|
| `zaicodeKeyIs` matched code OR key: AZERTY Ctrl+A (physical KeyQ) opened the zone picker, QWERTZ Ctrl+Y (physical KeyZ) undid an archive | a printed Latin letter decides; only a non-Latin layout (ЙЦУКЕН, ...) falls back to the physical key; digits stay physical. Ctrl+S in file-search rules uses the same helper. |
| Sounds table dropped a legacy cue's own file (`sound: "custom"` -> default sound) | migrates to `custom:agent.<cue>`; playback falls back to the old cue database and to the release snapshot. |
| Release snapshot did not carry Sounds-table own files or their names | `captureZaicodeSettingsSnapshot` embeds every `custom:*` file (refuses to save a missing one) and `zaicode-sound-custom-names`. |
| Dead legacy cue store (`zaicodeCues.ts`: settings/IndexedDB with no callers) | reduced to the cue names + `playZaicodeCue` adapter over the Sounds table. |
| Worker command is typed into the shell with Enter: a multi-line prompt pressed Enter inside the quoted string | prompt line breaks collapse to spaces. |
| `pnpm lint` failed: 7 `max-lines` errors; the diff had deleted upstream's own disable header in `desktopMainIpcPlatform.ts` | upstream header restored; upstream idiom with a reason on the six long ZAICODE modules; 5 small warnings cleaned. |
| `MoveWindowBy` `[x, y]` possibly undefined (desktop main tsconfig) | defaults. |

## Verification

Run from `zcode/` after the last edit:

- `pnpm typecheck` EXIT=0.
- `pnpm lint` EXIT=0 (70 warnings, 0 errors; was 7 errors).
- Fresh UI typecheck (`tsc --noEmit -p packages/ui/tsconfig.json`, new tsbuildinfo) EXIT=0;
  red control (same config + `const n: number = "..."`) EXIT=2 with TS2322.
- CLI core fresh typecheck EXIT=0. Desktop main/preload are outside the gate: 74
  upstream error sites, none on a line the ZAICODE diff added (checked against
  `git diff -U0 HEAD` hunks); the preload `@zcode/shared` misses are config
  resolution, the symbols are exported in HEAD and now.
- `node --import tsx --test test/zaicode*.test.ts` (ui) 55/55; services 20/20;
  core `saipenGoalVerdict` 10/10.
- Regression pair: the new AZERTY/QWERTZ assertions FAIL against the pre-fix
  `zaicodeKeyIs` (`actual: true, expected: false`) and PASS after the fix.
- `pnpm architecture:check --changed`: OK, 0 violations.
- `REBUILD.cmd --fast` EXIT=0: ZAICODE was running, so the build is staged in
  `packages/desktop/dist-next` (171.9 MiB, 21:05 UTC); asar spot-check finds the
  new snapshot/legacy-cue strings. The launcher swaps it in on the next start
  (only when newer than the live build).
- GUI click-through is not automatable here (T-9); the renderer behaviours above
  are covered by unit tests and code review only.

## Review pass 1 (claude-code)

Finding P2 `packages/ui/src/zaicode/zaicodeSoundEvents.ts`: 5 of the 43 Sounds
rows had no trigger anywhere, so switching them on did nothing -
`session.new` and `session.pin` (both on by default), `composer.send`,
`sidebar.collapse`, `ui.hotkey`. Fixed (SHIP after FIXES):

- `session.pin`: after every successful `setTaskPinned` (sidebar project rows,
  pinned section x2, timeline x2, header menu).
- `session.new`: New task (menu, Ctrl+N, sidebar) and the project row's new
  session; START / CLEAR keep their own rows (no double sound).
- `composer.send`: once per send (a queue re-confirmation does not replay).
- `sidebar.collapse`: slot group fold / unfold.
- `ui.hotkey` (renamed "Keyboard shortcut"): app shortcut dispatcher, off by default.
- Test `every Sounds-table row has a place that plays it`: red with the
  `ui.hotkey` wiring removed (`actual: [ 'ui.hotkey' ]`), green restored; the
  instrument also reports a made-up id.

Gates after the fixes: `pnpm typecheck` 0, `pnpm lint` 0 errors, fresh UI tsc 0,
architecture 0 violations, ui 56/56, services 20/20, core 10/10.
`REBUILD.cmd --fast` EXIT=0 again after the fixes: staged `dist-next` 21:18 UTC.
