# T-35 evidence — SRC-030 wave

T-35 was paused at BUILD by SRC-031 (T-36). Its modules were written before the
pause; mounting and the remaining items were finished inside T-36's build
because both waves share the same surfaces. Gates and bundle: see
`.saipen/evidence/T-36-control-wave.md` (same tree, same run).

## Items -> implementation

| SRC-030 item | Where |
|---|---|
| 1. Header buttons: full control (which, order, hide), "focus next session" click = next, right-click = back, arrows | `zaicodeLayoutPrefs.ts` (header tools incl. `focusCycle`, `cycleArrows`), `ZaicodeHeaderToolbar.tsx`, right-click editor `ZaicodeLayoutListEditor.tsx`, Settings -> Layout & home |
| 2. Menu block editable, Automations / Plugin Marketplace off by default, Search as an icon; ZAICODE simple for newcomers with presets and a play-button guide | nav defaults New task + ZAICODE (`ZAICODE_NAV_ITEMS`), `ZaicodeSidebarNavBlock.tsx`; `ZaicodeTeamPresets.tsx` (Solo, Builder + Reviewer, SAIPEN crew, Research -> Build), `ZaicodeTour.tsx` (▶ Tour, 8 steps on the real screen) |
| 3. HELP simple for every function | `settings/ZaicodeHelpSection.tsx` (15 topics, search, "Open" jumps), F1 |
| 4. Richer notifications, glow what reset | `zaicodeNotifications.ts` scenarios + `ZaicodeToastHost`; refills named per window with glow on meter cell, tile and limit row (`ZaicodeLimitMeter.tsx` `useZaicodeLimitAlerts`, `zaicodeLimitRefills.ts`); agent, worker, autostart, SAIMAIL, Problip cards; Settings -> Notifications |
| 5. Clone FastPrompter Timers (all tabs) + top-bar display | `zaicodeTimers.ts`, `zaicodeDuration.ts`, `zaicodeProductivity.ts`, `zaicodeIntervalRules.ts`, Timers window tabs, `ZaicodeTopbarClock.tsx` (mounted in the title bar), Settings -> Timers |
| 6. Full hotkey control (FastPrompter base) | `zaicodeHotkeys.ts` (global + in-app, two bindings each, F-keys block, conflicts), `ZaicodeAppRuntime.tsx` dispatcher + global bridge, Settings -> Hotkeys |
| 7. Click on the working indicators opens that session | `ZaicodeRunningMeter` cells -> `openZaicodeSession` |
| 8. Ambience -> Sounds, settings placement review, Terminal font out of General | Settings group ZAICODE; Ambience + Problip in Sounds -> Background; sidebar layout / home / zones in Layout & home; terminal font in Workers & terminal (hidden from General in ZAICODE mode) |
| 9. Sound choice intuitive: kinds, lengths, audition on scroll | `zaicodeSoundCatalog.ts` + `ZaicodeSoundPicker.tsx` in every Sounds row (replaces the alphabetical datalist) and in timers/ambience |
| 10. Readable 0% text | `zaicodeRemainingTextColor` in limit rows (test: luminance > 0.35 for every level) |

Tests: `packages/ui/test/zaicodeWave35.test.ts` (timers, durations, productivity,
interval rules, hotkeys, layout lists, session ring, sound kinds, quiet hours,
refills, text colours) — part of the 94/94 ui run.
