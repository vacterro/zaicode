# T-58 evidence -- SRC-043: sidebar speed, CONTINUE ALL / DONE, mixes, Freebuff, profiles

Source: the operator's batch captured as SRC-043 (nine items; "crashes" already crossed out).

## The items (operator's words -> cause -> change)

| Item | Cause found | Where |
|---|---|---|
| Remove the grab hand on projects; rebuild the sidebar to be maximally responsive, no lag | project rows carried `cursor-grab`; every project row subscribed to whole lists (running sessions, waiting sessions, the entire workers store), so any streaming update or a worker window drag re-rendered all rows; the session-nav store republished new `waiting` arrays on every task-list push; the scroll container had a CSS mask; hover/selection used transitions; a project row re-rendered on every hover to mount its actions | `WorkspaceSidebarItem.tsx` (no grab in ZAICODE, CSS group-hover action zone), `zaicode/zaicodeProjectRuntime.ts` (count selectors), `zaicode/zaicodeWorkers.ts` (`useZaicodeWorkersSelector`), `ZaicodeProjectEngines.tsx` (chip signature), `zaicode/zaicodeSessionNav.ts` (stable lists), `ZaicodeSidebarNavBlock.tsx` (dock flag only), `WorkspaceSidebar.tsx` (no mask, `data-zaicode-instant`), `zaicodeMotionCss.ts` (instant rule) |
| An obvious button to jump to finished, unseen sessions; predictable, light, fast | no such control | `zaicode/ZaicodeSessionActionStrip.tsx` DONE n (oldest first, opening marks seen, right-click lists all), hotkey `session.nextDone` Alt+Right; order rule `zaicodeDoneUnseen` |
| "Projects" is movable although it is the root; drop the word; profile per user at the bottom, a profile saves everything individually | ZAICODE hid the other purpose section but kept the sortable "Projects" section (title, fold, drag handle); profiles held a name + picture only | `WorkspaceSidebar.tsx`: ZAICODE renders the project list directly (`data-zaicode-project-root`), SLOTS / LIVE / + in the toolbar, folded preference ignored. Profiles: `zaicode/zaicodeProfileBundles.ts` + `zaicodeProfiles.ts` -- every preference (ZAICODE + upstream theme / language / UI size / sidebar width) per profile; switch saves, restores and reloads; new profile = copy of the current one; live facts stay shared. Footer menu explains it. |
| Clock "the same by colour" (screenshot: FastPrompter's bar) | ZAICODE printed the reset countdown grey with only the account code coloured; FastPrompter paints every countdown bold in its colour, the reset in the vendor colour | `ZaicodeTopbarClock.tsx` (`zaicodeProductivityColor`, `ZAICODE_CLOCK_INTERVAL_COLOR`, reset label bold in vendor colour) |
| Big "Continue all" (smart); Alt+Click continues a session; a button on the session to continue without entering | none | `zaicode/zaicodeContinue.ts` (plan + one-session decision), `zaicodeContinueHost.ts` (resumeTask + v4 `sendGoalCommand` / `sendText`), `ZaicodeSessionActionStrip.tsx` CONTINUE ALL, `TaskListItem.tsx` ▶ + Alt+Click, `TaskList.tsx` / `WorkspaceSidebarItem.tsx` wiring |
| Freebuff support, only as a metric | no Freebuff source | `shared/src/zaicode-engines.ts` (vendor, `ZAICODE_METRICS_ONLY_VENDORS`, `parseFreebuffSession`, `readFreebuff`), `desktop/src/main/zaicodeEngines.ts` (discovery + read-only GET), UI launch surfaces use `launchableZaicodeAccounts`, `launchZaicodeWorker` refuses, Engines settings: "metrics only" + switch, vendor colour `#50ecb3` |
| Opacity does not react to blink "and so on" | blink / breathe keyframes animate `opacity`, which overwrote the inline Opacity value; Reach was offered for blink but blink ignored it | `zaicodeWorkingIconStyle.ts`: resting opacity = `filter: opacity()`, `--zw-blink-low` from Reach; `zaicodeMotionCss.ts` blink keyframe |
| Combine every effect in Highlights & motion; Shift-combining wherever possible | one effect / shape / motion / picture per rule | `zaicode/zaicodeCombo.ts` (one rule, reused by the sound-picker tabs), `ZaicodePrefCombo`, model lists `effects[]`, `shapes[]`, `motions[]`, `images[]` (old values read as one-item lists), per-effect CSS channels multiplied into `--zh-k`, shapes `~=`, underline + bar in one box-shadow, mixed icon motions on registered channels, stacked pictures (max 3) |
| Black text on black (Timers) | `body` has no colour upstream; the Temp Timer status box had no text class, so it drew browser-default black inside the portaled dialog | `zaicodePalettes.ts` (`html.zaicode-fonts body { color: var(--color-foreground) }`), `ZaicodeTimersDialog.tsx`, `ZaicodeTimersOther.tsx` |

## CONTINUE ALL plan (what it does, what it leaves)

- a session whose goal is paused or still active and idle -> `sendGoalCommand` with the same objective;
- a session whose last turn failed -> `cc` (SAIPEN project) / `continue`;
- a SAIPEN project whose read-model verdict is `pending` (open ticket, nothing running) and nothing else continued there -> its MAIN session gets `/goal cc all`; no MAIN -> `createTask` + `/goal cc all`, the new session becomes MAIN;
- left alone: finished sessions, running ones, `budget_limited` goals, switched-off projects, sessions waiting for a human (listed as "left alone").

The plan is shown on hover / right-click before anything is sent; the result lists every step.

## Freebuff live probe (2026-09-25, read-only GET, token never printed)

`HTTP 200`; top-level keys `status, accessTier, freebucks, subscription, ...`;
parsed: plan `starter · 0/105 FB today · wallet 15 FB`, one window `daily`
0 % remaining, reset `2026-09-25T21:00:00.000Z`.

## Gates (2026-09-25, from `zcode/`)

- UI `node --import tsx --test test/zaicode*.test.ts`: 184/184 (new `zaicodeWave58.test.ts` 16; `zaicodeWave49` updated to the list model).
- Services `test/zaicode*.test.ts`: 30/30. Desktop `test/zaicode*.test.ts`: 38/38.
- `pnpm typecheck` (tsc -b): EXIT 0; `tsc --noEmit -p packages/ui/tsconfig.json`: 0 errors; desktop main tsconfig filtered to the touched engine files: 0.
- `pnpm lint`: 0 errors, 72 warnings (baseline count unchanged).
- `architecture-check check` (full) and `--changed`: OK, 0 violations.

Red controls (each broken on purpose, the matching test failed for the intended reason, restored -> 16/16):
- resting opacity back on the `opacity` property -> "Opacity slider survives blink and breathe" (+ mixed-motion opacity) fail;
- session-nav `waiting` dedupe removed -> "an unchanged waiting / recent list keeps its identity" fails;
- CONTINUE ALL also taking unseen finished sessions -> the plan test fails.

## Builds

- Test build 1 (`REBUILD.cmd --fast`, 186.4 MiB) staged and swapped in by the launcher at 12:21Z (the running app tree was stopped at the operator's request; `launcher.log`: "Applied staged build from dist-next").
- Test build 2 adds the profile bundles and the 400-line split.

## Backup

`https://github.com/vacterro/zaicode` (public): `main` = zcode branch `zaicode`, `workspace` = root repo. Modified Microsoft Verdana files excluded (licence), kept local. KNOWLEDGE D-11.

## MANUAL-VERIFY (operator)

1. Hover projects: no grab hand; the row lights at once; ◆ ▶ … swap in without delay.
2. No "Projects" title above the list; SLOTS / LIVE / + are in the toolbar row.
3. DONE n (green) under the menu: each press opens the next unseen finished session; right-click lists them.
4. Hover CONTINUE ALL: the plan; click: the result card lists each step.
5. Alt+Click a finished session: it continues without opening; ▶ on hover does the same; a session with a question opens instead.
6. Settings -> Highlights & motion: Shift+Click Blink + Pulse, Glow + Box; Working icon Shift+Click Spin + Pulse + Blink, and Orbit on the SAIPEN mark; Opacity 25 % with Blink dims it.
7. Title-bar clock: the reset countdown bold in the vendor colour.
8. AI limits meter: an FB (Freebuff) cell with today's Freebucks; no FB tile under Subs, none in Dispatch or SCHEDULER.
9. Timers -> Temp Timer: "No Temp Timer running." is readable.
10. Footer profile menu: add a profile, change the palette, switch back: the window reloads with the first profile's palette.
