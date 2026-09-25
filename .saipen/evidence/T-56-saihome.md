# T-56 evidence -- SRC-041: nine UI items + SAIHOME (extends T-52 / T-54 / T-55)

Source: `V:\_TEMP_\fastprompter_drag\Пусть если task_20260925_0856.md` (receipt SRC-041).

## The nine items (operator's words -> cause -> change)

| Item | Cause found | Where |
|---|---|---|
| "If the task completed because I stopped it, no such message" (Task completed / Turn finished card) | a stopped turn ends in phase `completedInterrupted`, which the orchestrator mapped to "completed" | `ui/src/lib/taskNotificationOrchestrator.ts` `skipInterrupted`; `hooks/useTaskNotifications.ts` passes it in ZAICODE mode (upstream unchanged). |
| Hovering a project hides its name; buttons still reachable and understandable | on hover five 24 px buttons (…, files, new session, ◆, ▶) were mounted and squeezed the name to "Proje…" | `ui/src/WorkspaceSidebarItem.tsx`: a fixed 60 px zone on the right shows working / waiting / OFF while idle and ◆ MAIN, ▶ START, … (20 px) on hover; the name's width never changes. New session, Files and on/off moved into the … menu (labelled). Research note below. |
| Row jumps up and down on hover (WORKERS row); other such places | the worker buttons were `hidden group-hover:flex`: taller than the text row, so the row grew on hover | `zaicode/ZaicodeSidebarWorkers.tsx`: buttons always laid out, `invisible` until hover / focus. Audit: no other `hidden group-hover:*` in ZAICODE UI; roster/queue use opacity (no reflow); session rows keep h-8. |
| Shift + drag a project and hold 2 s -> drop into a specific slot from another slot | cross-slot drop only worked onto a project of the other slot; empty / folded / hidden slots could not take a drop | `zaicode/ZaicodeSlotDrop.tsx` (hold timer, SLOTS panel, slot-first collision) + `WorkspaceSidebar.tsx` drop branch. |
| Big classic analog clock; a real HOME (not NEW TASK) with statistics, clock, limits, everything | the "home" was the composer's empty state | SAIHOME, below. |
| Timers: cannot type zeros, want an all-day checkbox, white picker with rounded corners; timers are not added at all | native `<input type="time">` follows the Windows locale (AM/PM columns, no 00 hour, white rounded picker); 00:00–00:00 silently meant "all day"; the moment could only be set through the native datetime picker | `zaicode/ZaicodeTimeFields.tsx` + `zaicodeClockText.ts`: typed 24-hour fields (7, 0730, 07:30, 00:00 = midnight, arrows step), themed date field with ‹ ›; sound rows get their own All box; Enter in the moment text adds; Add explains why it is disabled. Same fields in SCHEDULER (at / daily / stop at), interval reminders and quiet hours. Store add path verified in node (timer persisted, listed, due). |
| Enable / disable a project with Shift+Click: dimmed, invisible to automatic agents | -- | `shared/src/zaicode-projects.ts`, service `getDisabledWorkspaces` / `setWorkspaceDisabled` (setting `disabled_workspaces`), `pump()` skips a disabled workspace, SCHEDULER `fire()` skips it, row dims to 40 % with an OFF badge (`zaicode/zaicodeProjectSwitch.ts`). |
| Shows the wrong time (title bar 07:57 while Windows said 10:57) | the running app was started from an agent shell that exports `TZ=UTC`; removing TZ inside main was too late because Chromium fixes its zone at start | launcher and `ZAICODE.ps1` drop TZ; a packaged app that still inherited one relaunches once without it (`main/zaicodeTimeZone.ts` `shouldRelaunchForLocalTimeZone`, loop-guarded). |
| Context menu to the theme; remove "Clear all data" corporate stuff; shake corporate tinsel out | the tray right-click menu is native (white) and carried Clear all data / Check for updates / About; the app menu and footer Help carried vendor feedback / log export / docs / issue links | own tray popup (`main/zaicodeTrayMenu*.ts`, Golden Default tokens, keyboard, closes on blur): Open, SAIHOME, New task, WORKERS, Timers, Settings, Quit. zaicode flavor app menu drops What's new, Feedback, Export logs, Clear all data. Footer Help: ZAICODE Help instead of vendor docs / issue form. |

Project-row research note: shrinking buttons alone trades Fitts' law for
space; the stable answer is a reserved zone (the name keeps one width, so
nothing moves under the pointer), three actions only (MAIN, START, more),
everything else labelled in the menu and on right-click, and 20 px targets
(the pixel UI's standard small button).

## SAIHOME (acceptance criteria of SRC-041)

1. First-class view `saihome` (not the composer); menu line SAIHOME first, Alt+H, tray, header tool. Opening creates nothing (`openZaicodeHomeView` only switches the view).
2. Startup: SAIHOME (default), Last active, New task (`zaicodeStartupMainView`).
3. Analog clock: SVG, own 1 Hz state, calm / reduced motion respected, textual equivalent (`role=img` label, `<time>`), settings for hands, numerals, date, zone, digital 24/12, second zone.
4.-6. Local statistics: migration `0006_zaicode_stats`; ingestion from the agent usage store (model_usage / turn_usage), queue runs, worker sessions; today / yesterday / week / month / all time, streak grid with five measures, keyboard-walkable.
7.-8. AI limits wall from engine snapshots (stale / unavailable / sign-in, temporary show-all, prepared-meter highlight + "Prepared: starts at reset"); Scheduler module with the next five and stop times.
9.-10. Project fleet from T-41 verdicts (sorted blocked -> waiting -> working …, details, Go to project, Open MAIN session); Agents (waiting, running sessions, workers, queue runs).
11. Routing: router host + API (mode, pools, providers, restarts, scan), Fix = Autotroubleshoot.
12. NEEDS YOU: what / why / impact / one action; empty when healthy.
13.-14. Empty modules take no grid cell; columns from the grid width (ResizeObserver, whole pixels, no transform scaling).
15. Presets EVERYTHING / MINIMAL / OPERATOR / STATS / FACTORY / CUSTOM; Edit layout (order, visibility, size), Reset layout; persisted per profile.
16.-17. Truth states on values (`data-zaicode-truth`), unknown = "—", "not enough data" for empty ratios; no cost or productivity numbers; unmeasured worker time shown as such.
18. No execution side effect on navigation (fleet selects projects only).
19. Existing gates green (below).
20. Docs: `UI.md` (SAIHOME != NEW TASK, sources table), `docs/ZAICODE_IMPLEMENTATION.md` §24, `docs/ZAICODE_ARCHITECTURE.md` §10, `docs/ZAICODE_UPSTREAM_DELTA.md` (T-56 rows), Help topics.

Real data (read-only probe of this machine's agent store): 19,677 model
requests, 3,550,534,108 tokens; first ingest 410 ms, next 50 ms; 20,059 events.

## Gates (2026-09-25, from `zcode/`)

- UI `node --import tsx --test test/zaicode*.test.ts`: 168/168 (new `zaicodeSaihome.test.ts` 12, `zaicodeWave56.test.ts` 5; `zaicodeWave35` / `zaicodeWave50` menu oracle now expects SAIHOME first).
- Services `node --import tsx --test test/zaicode*.test.ts`: 30/30 (new `zaicodeStats.test.ts` 6: periods in Europe/Tallinn, restart + replay dedupe, late rows in the overlap, clear floor, queue + workers + honest coverage, empty profile, DST end).
- Desktop `node --import tsx --test test/zaicode*.test.ts`: 38/38 (new `zaicodeTrayMenu.test.ts` 4, `zaicodeTimeZone.test.ts` +2).
- `tsc -b` (the `pnpm typecheck` set): 0 errors; `tsc --noEmit -p packages/ui/tsconfig.json`: 0 errors.
- `pnpm lint` (oxlint): 0 errors, 72 warnings (none in touched files).
- `pnpm architecture:check --changed`: OK, 0 violations.

## Post-E-811 final validation (2026-09-25, T-57 driver SRC-042)

The two fixes made after the E-810 broad gates, re-proven against the freshly
rebuilt bundle:

- **feed-start race** -- `packages/ui/src/zaicode/home/zaicodeHomeFeed.ts`.
  `refreshZaicodeHome()` guards concurrent callers with an `inflight` singleton
  (`if (inflight) return inflight; ... .finally(() => { inflight = null; })`),
  and `useZaicodeHomeFeedRefresh()` self-publishes the base services before the
  first refresh (SAIHOME is the first view after a start, so it cannot wait for
  another component to publish them). No busy-loop, no double pass.
- **SAIOPP noise** -- `packages/ui/src/zaicode/home/zaicodeHomeModel.ts`
  `zaicodeHomeRouting()` lines 169-179. Only SAIFREN emptiness / missing pool /
  failing providers raise `degraded`; an empty paid SAIOPP pool (no subscription
  yet) stays `healthy`. Real router-down / provider failures are NOT suppressed
  (`status === "down"` and `failing.length > 0` still surface). Covered by
  `zaicodeSaihome.test.ts` "routing" case (empty SAIOPP -> healthy, empty
  SAIFREN -> degraded).

Rebuild: `REBUILD.cmd --fast` -> `node scripts/bundle-zaicode.mjs`, EXIT 0;
staged bundle `packages/desktop/dist-next/win-unpacked/ZAICODE.exe` (dir mtime
2026-09-25 13:49) + NSIS `ZAICODE-3.14.0-win-x64_TEST.exe` (186.3 MiB, under
500 MiB limit). Launcher swaps dist-next in on next start.

Re-run gates against the current tree:
- UI `node --import tsx --test test/zaicode*.test.ts`: 168/168 PASS.
- Services `node --import tsx --test test/zaicode*.test.ts`: 30/30 PASS.
- Desktop `node --import tsx --test test/zaicode*.test.ts`: 38/38 PASS.
- `tsc --noEmit -p packages/ui/tsconfig.json`: EXIT 0.
- `pnpm typecheck` (tsc -b set): EXIT 0.
- `pnpm lint` (oxlint, 2819 files): 0 errors.
- `pnpm architecture:check --changed`: OK, violations 0, new 0.

Red control (SAIOPP-noise guard): replaced `emptyFree = free!==undefined &&
free.models===0` with `pools.some((pool) => pool.models === 0)` -> the routing
test fails 1/1 (empty SAIOPP wrongly degraded); restored -> 12/12 green. The
control fails for the intended reason and was not "fixed" into green.

## MANUAL-VERIFY (operator)

1. Close and reopen ZAICODE (the staged build swaps in): SAIHOME appears, the clock shows the Windows time.
2. SAIHOME -> New task -> SAIHOME -> click a project row -> Go to project: no session appears in the sidebar until you type.
3. Right-click the tray icon: the gold menu, no Clear all data.
4. Stop a running turn: no "Task completed" card.
5. Hover a project: the name stays; ◆ ▶ … appear at the right.
6. Shift+Click a project: dimmed + OFF; Shift+Click again: back.
7. Shift + drag a project, hold 2 s: SLOTS panel; drop on an empty slot.
8. Timers -> type 00:00 / 0730 in a sound row, untick All; Add an alarm "in 10m".
