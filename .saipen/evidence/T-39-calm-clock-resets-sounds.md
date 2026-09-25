# T-39 evidence — SRC-033 items 1–4 (UI); analysis items split to T-41..T-44, T-10 unblocked

SRC-033 had four UI requests and a long review of the SAIPEN / SAIMAIL /
ZAICODE triad. The review's actionable ZAICODE items became their own Work:
T-41 (System Read Model), T-42 (topology vs layout), T-43 (fault-injection
matrix), T-44 (full-system E2E, non-GUI chain). Its delegation rules
(primary coordinator only, depth exactly 1, fixed budget, allowed roles,
parent linkage, no child->child, no ownership stealing, results through the
queue + SAIMAIL) are the operator scope decision T-10 was blocked on; T-10
was unblocked with that decision.

## Items -> implementation

| SRC-033 item | Where |
|---|---|
| 1. A switch that turns off animations, pop-ups, dimming/opacity tricks | `zaicodeUiPrefs.ts` `noMotion` / `noDim` / `noHoverPopups` (+ `zaicodeCalmClasses`, `isZaicodeCalm`); `<html>` classes set in `ZaicodeAppRuntime.tsx`; CSS in `zaicodePalettes.ts` (no animation / transition / smooth scroll; no backdrop blur, transparent dialog overlays; tooltips and hover cards hidden). Settings -> Layout & home -> "Calm interface" (master + three), hotkey `ui.calm` (Interface). |
| 2. Local time is wrong; 12/24 switch; basic essentials | Cause: the process environment carried `TZ=UTC` (seen in this very session: `$env:TZ=UTC`, Windows zone FLE Standard Time) and ZAICODE inherited it, so every renderer and agent ran in UTC: 23:37 shown at 02:37 local. Fix: `desktop/src/main/zaicodeTimeZone.ts` removes an inherited `TZ` at ZAICODE main start-up (kept as `ZAICODE_INHERITED_TZ`) before any window or agent is spawned. Clock essentials (`zaicodeTimerStore.ts` / `ZaicodeTopbarClock.tsx`): 12-hour clock (applies to every time display through `formatZaicodeTimeOfDay` in @zcode/shared: clock, timers, limit resets), day of week, year, ISO week number, time-zone name; tooltip shows the full date, week and the IANA zone. |
| 3. Wrong reset values ("5h: resets in 6h 30m") | Same 3 h offset: Claude's `/usage` prints `resets Sep 25, 5:51am (Europe/Tallinn)`; the parser ignored the zone and read local time in a UTC process -> 05:51 UTC instead of 02:51 UTC. `parseClaudeResetTime` now honours the zone the CLI names (`zonedWallTimeToEpoch`, Intl), and `plausibleZaicodeReset` drops a reset further away than its window (+15 min) as a misread. Two older tests encoded the bug (they expected local-time readings and passed only when the test process ran in Tallinn); their oracles are now absolute instants. |
| 4. Sounds section: not clickable, no sound on hover, play on scroll / click | `ZaicodeSoundPicker.tsx`: hovering no longer plays and no longer moves the list (hover set the cursor and `scrollIntoView` pulled the next row under the pointer, so the list kept running away from the click); click plays (the test); wheel / arrows step and play while "listen" is on; double-click, Enter or the row's "use" button picks; the closed picker steps only with Shift+wheel, a plain wheel scrolls the Settings page (it used to change and play a row's sound while scrolling past it); quick slots no longer play on hover. |

## Gates (from `zcode/`)

- `tsc -b` (typecheck list) 0; UI `tsc --noEmit` 0; `pnpm lint` 0 errors (72 baseline warnings);
  `pnpm architecture:check --changed` OK.
- UI tests 110/110 (new `zaicodeWave39.test.ts` 4/4; `zaicodeEngines.test.ts` 11/11 with the
  new regression test). `zaicodeEngines.test.ts` green under TZ=UTC, Europe/Tallinn,
  America/New_York and Asia/Tokyo.
- Desktop `test/zaicodeTimeZone.test.ts` (run from `packages/services`): 2/2.
- REGRESSION-EVIDENCE FAIL verifier:2ce7311ec7e8 subject:580399b028cf -- pre-fix parser (zone ignored,
  no plausibility) vs the fixed test file, TZ=UTC: 3 fail / 8 pass.
- REGRESSION-EVIDENCE PASS verifier:2ce7311ec7e8 subject:80b765d4cb44 -- fixed parser, same test file,
  TZ=UTC: 11/11.
- Red controls: TZ not deleted -> timezone test 1 fail; 12-hour noon as "am" -> wave39 1 fail;
  both restored green.

## MANUAL-VERIFY STEPS + EXPECTED

1. Start ZAICODE from a shell that has `TZ=UTC` set -> the title-bar clock shows the Windows local
   time; tooltip "Time zone: Europe/Tallinn (…)".
2. Right-click the clock -> tick 12-hour clock -> clock, timers and "resets Tue 5:00 pm" follow.
3. Sidebar Claude tile tooltip: the 5h window never shows a reset more than 5 h away.
4. Settings -> Layout & home -> Calm interface -> all three: menus and dialogs appear without fades,
   dialogs do not darken the window, hovering a button shows no tooltip.
5. Settings -> Sounds: scroll the page with the wheel over the rows -> page scrolls, no sound changes.
   Open a picker: hovering rows is silent and the list stays still; click a row -> it plays; wheel
   (listen on) steps and plays; double-click or "use" picks it and closes.

## Bundle (shared staging for T-38, T-39, T-40)

`REBUILD.cmd --fast` EXIT 0 -> `packages/desktop/dist-next` (ZAICODE-3.14.0-win-x64_TEST); `app.asar`
contains `Subscriptions as models`, `zaicode:call-router`, `zaicode-no-motion`, `Calm interface`,
`12-hour clock`, `ZAICODE_INHERITED_TZ`, the picker's "Use this sound".
