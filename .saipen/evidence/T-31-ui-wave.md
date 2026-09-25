# T-31 ZAICODE UI wave (SRC-025) — evidence

Date: 2026-09-24  Owner: claude-code  Receipt: SRC-025
Source: `V:\_TEMP_\fastprompter_drag\ZAICODE (Day 24 Sep - 14_31)_20260924_1431.md`

## Items -> implementation (all under `zcode/`)

| # | Request | Where |
|---|---------|-------|
| 1 | SAIPEN icon everywhere instead of the old zcode "Z" | `packages/desktop/build/icon*.{png,ico,icns}`, `build/icons/*`, `public/icon_512@2x.png`, `public/logo/icons/*` (square dark background, white SAIPEN glyph); UI logo `packages/ui/src/assets/zaicode-logo-{20,40,128}.png` via `zaicode/zaicodeBrand.ts` (App, sidebar header, collapsed rail, settings); root launcher rebuilt with the new `icon.ico` |
| 2 | Phase chip ("DONE · none") tinted by state | `prompt-editor/ZaicodeSaipenControls.tsx` (red blocked / gold working / green done) |
| 3 | "Iteration N · Goal incomplete" hangs, then unfinished | `apps/zcode-cli/packages/core/src/runtime/methods/saipen-goal-verdict.ts` + `target-completion-verification.ts`: SAIPEN board decides instantly; model verifier gets a 120 s timeout |
| 4 | Vertical todo bar left of the composer (Battlezone meter) | `v4/ZaicodeTodoGauge.tsx` `ZaicodeTodoColumn`; click toggles the todo list |
| 5 | Ambient (computalk1.wav @ 0.03 when work starts) | `zaicode/zaicodeAudio.ts` + `ZaicodeAudioDirector`; Settings -> ZAICODE -> Ambience |
| 6 | Full Problip + button next to Settings | `zaicode/zaicodeAudio.ts`, `ZaicodeAudioPanels.tsx` (`ZaicodeProblipButton` in the footer, panel in Settings) |
| 7 | SAIMAIL: short "what is it" | `ZAICODE_SAIMAIL_WHAT` in the envelope tooltip and Settings |
| 8 | Project title strip: BLOCKED red / TODO yellow / DONE green from the right | `WorkspaceSidebarItem.tsx` + `saipenBoardShares` |
| 9 | Remove empty-project START dash slot | `TaskList.tsx` |
| 10-11 | Sessions may not archive; one-click archive, Ctrl+Z restores | `TaskList.tsx` (no confirm click), `WorkspaceSidebarItem.tsx`, `zaicode/zaicodeArchiveUndo.ts` (failures shown, undo stack) |
| 12 | Default model switch at the top of the sidebar (SAIFREN / SAIOPP buttons) | `zaicode/ZaicodeDefaultModelBar.tsx`, `zaicodeDefaultModel.ts`, `v4/composer/newTaskDraft.ts` |
| 13 | No rounded corners anywhere | `zaicodePalettes.ts` zeroes Tailwind `--radius-*` (layered `!rounded-lg` beat the unlayered override) |
| 14 | START = `/goal cc all` from a fresh session | composer START opens a new session when inside one; sidebar START queues `/goal cc all` |
| 15 | Archive all | project "..." menu -> Archive all sessions (idle ones; Ctrl+Z restores) |
| 16 | +/- buttons instead of typing the UI font size | `settingsCodePreview.tsx` |
| 17 | Working indicator = operator avatar | already shipped (T-30 amendment) |
| 18 | Running counter + Battlezone readiness cells | `zaicode/ZaicodeSidebarHeaderTools.tsx` `ZaicodeRunningMeter` in the sidebar header (all running sessions) |
| 19 | 640x540 + sidebar auto-hide | min 480x540 (T-30); `WorkspaceShellLayout.tsx` hides earlier (<440 px chat) and restores at >=900 px window, also at startup |
| 20 | Remove duplicate "Tasks" section | `WorkspaceSidebar.tsx` (conversations section hidden in ZAICODE) |
| 21 | Outline off "Open in explorer", onto SAIMAIL unread | already shipped (T-30) |
| 22 | Hide corporate header items, only the envelope | share (T-30) + help menu hidden; help moved to operator menu "Help & about" |
| 23 | Rebuild the operator menu | theme + interface-mode submenus gone; zoom and language inline; Help & about |
| 24 | New task / Search / ... block hidden by default, header toggle | `zaicodeSidebarPrefs.ts` + `ZaicodeSidebarNavToggle` |
| 25 | Working-first stacking mode | LIVE toggle in the Projects header |
| 26 | AUDAPACK priority slots MAIN0/MAIN1/SIDE0/SIDE1/SIDE2, compact, default on | SLOTS toggle; group via drag onto a project in another group or "Priority group" menu; compact rows |
| 27 | Todo window movable; clicking the todo list hides it | `v4/ZaicodeTodoDock.tsx` (always draggable; every trigger toggles) |
| 28 | Readable icons | crisp mode stroke 2.6 px; sidebar row icons 16 px |
| 29 | CLEAR next to START (fresh empty session) | `ZaicodeSaipenControls.tsx` |
| 30 | GLM limit -> undo + resend still used GLM after picking SAIFREN | `v4/SessionPane.tsx`: retry/edit switch the session model to the composer selection first |
| 31-32 | Suggested prompts off; tinted Empty | already shipped (T-29/T-30) |
| 33 | /goal in SAIPEN = close every human-free ticket | `saipen-goal-verdict.ts` (open TODO/DOING -> continue with next ticket; only BLOCKED left -> done) |
| 34 | Simple Hunter/Tester/Cleaner/Wikier/Translator modes | MODES row (HUNT/TEST/CLEAN/WIKI/TRANSL/CREW) opens a fresh session with the sub-role; queue dispatch clamps unsupported reasoning levels (`Reasoning effort "high" is not supported by new-provider/SAIFREN`) |

## Gates
- `tsc --noEmit -p packages/ui/tsconfig.json` EXIT=0 (probe with a deliberate error proved the check is real)
- `tsc -b packages/shared packages/ui packages/desktop/tsconfig.host.json` EXIT=0
- `tsc --noEmit -p apps/zcode-cli/packages/core/tsconfig.json` EXIT=0
- `oxlint` on 35 changed files: 0 errors (remaining warnings are upstream baseline)
- `node --import tsx --test`: ui `test/zaicode*.test.ts` 27/27 PASS (incl. new `zaicodeUiWave31.test.ts` 4/4); services 20/20 PASS; core `test/saipenGoalVerdict.test.ts` 6/6 PASS
- CLI rebuilt: `pnpm --filter @zcode/core build`, `pnpm --filter @zcode/cli build` EXIT=0
- Root launcher rebuilt with the new icon (`tools\launcher\build.cmd` EXIT=0)
- Also fixed: `REBUILD.cmd --fast` passed `--fast` through to the bundler (`shift` does not change `%*`)
- Packaged: `REBUILD.cmd --fast` EXIT=0 (first two attempts hit transient `EBUSY` on
  `apps/zcode-cli/packages/*/dist` while the operator's ZAICODE agents ran ugrep; retry passed).
  ZAICODE was running, so the build is staged in `zcode/packages/desktop/dist-next/win-unpacked`;
  the root launcher swaps it in on the next start.
- Package spot-check: `app.asar` contains `data-zaicode-running-meter`, `data-zaicode-problip-button`,
  `data-zaicode-todo-column`, `zaicode-archive-notice`, `Priority group`, `--radius-lg: 0px`,
  `SAIMAIL is a local post office`, the reasoning clamp, hashed `computalk1-*.wav` and
  `blip_*.wav`; `resources/glm/zcode.cjs` contains the SAIPEN goal verdict;
  `resources/icon.png`, `icon_windows.png`, `tray_icon.ico` are the new SAIPEN icons.

## Operator check after restart (not automatable here)
Close ZAICODE and start it from `ZAICODE.exe` / `ZAICODE.lnk` so the staged build swaps in;
Windows may show the old taskbar icon until its icon cache refreshes.
