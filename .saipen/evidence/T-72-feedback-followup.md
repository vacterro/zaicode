# T-72 — ZAICODE feedback follow-up (SRC-052, SRC-053)

Source: `V:\_TEMP_\fastprompter_drag\Пусть тогда Shift_20260927_0116.md`.
The source contains 23 actionable requests. R007–R023 repeat the 17 requests
addressed in `T-71-feedback-wave.md`; this work rechecked their code paths and
completed the gaps noted below. R001–R005 are new. R006 was already present.

| Clause | Disposition and evidence |
| --- | --- |
| R001 | Implemented: Shift held while closing the Windows ZAICODE window calls `requestQuit()` in `desktopWindowLifecycle.ts`; `index.ts` tracks the modifier. Native caption-button behavior needs a live desktop check. |
| R002 | Implemented: `zaicodeMeterPrefs.ts` now treats a fresh 100%-remaining account as visible under the capacity filter; `ZaicodeLimitMeter.tsx` names accounts hidden by meter or Engines settings. FastPrompter `usage_limits/model.py` used to require both spent and remaining quota, so a fresh Codex account was suppressed; it now requires remaining quota only and the setting text says “Hide spent accounts.” LIMISAW `VisibleAccounts` uses separate explicit hide/spent/5h filters; its current `LIMISAW.ini` has all three off. No LIMISAW code change was justified by the supplied screenshot. |
| R003 | Implemented: `ZaicodeSessionActionStrip.tsx` has a prominent Auto toggle that advances open work without duplicate sends from an unchanged snapshot. It uses the background host path when a sidebar row is folded and retries only failed sends after 60 seconds. Turning Auto off stops later steps in an in-flight plan; disabling a project skips its later steps. The session brief signature now includes `updatedAt`, so a completed turn can advance Auto even if polling missed its brief running phase. `ZaicodeAppRuntime.tsx` publishes running sessions, the SAIPEN DONE verdict, and whether the project is disabled. `zaicodeAuditService.ts` skips disabled projects, then starts A3 only after an explicit DONE verdict, a clear board, and no running work; it caps each run at 1–10 cycles, requires an explicit `ACTIONABLE_FINDINGS` count, queues one durable implementer job per nonempty handoff, and stops on zero findings or a failed/blocked job. T-72 VERIFY review also made a planned cycle resume after an interrupted enqueue, with the DONE/empty-board/no-running gate rechecked before dispatch. Each wave queue job has a campaign-specific title, so a restart can recover a successfully queued job whose campaign write was interrupted. `ZaicodeAuditPanel.tsx` exposes the cycle cap and handoff state. This is statically checked; no 10-cycle live run was performed. |
| R004 | Implemented: `zaicodeRouterSetup.ts` uses provider model listings, two bounded direct probes per scan, retained success/failure/latency evidence, and published context/tool metadata to rank automatically managed SAIFREN models. Two consecutive valid listings that omit a model or show it is no longer free retire it; a later valid listing can restore it. Two explicit `model not found` probe responses also retire a model; it is quarantined for 24 hours and must answer a direct retry before being restored. Timeouts and rate limits only lower its rank. Manual ordering/removal is preserved. `useZaicodeRouterAutoSetup.ts` scans hourly and the settings panel offers Scan now and shows additions, removals and errors. Published model properties come from the [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/get-models); usage rankings are not treated as model-quality proof. |
| R005 | Implemented: `zaicodeSoundEvents.ts` adds configurable ordinary button, selection and context-menu cues; `zaicodeSoundBus.ts` suppresses a generic cue when a control already played its own sound. |
| R006 | Existing: `zaicodeEngines.ts` reads Coding Plan quota from the configured Z.ai/BigModel host and `zaicode-engines.ts` maps 5h/weekly/monthly windows plus `nextResetTime`. The current Coding Lite entry uses that parser. The quota endpoint is vendor internal and could change; no separate stable public reset API was found in official docs. |
| R007 | T-71 background retry remains in `zaicodeTurnRetryWatch.ts`; this work made SAIPEN unfinished goals resume with `cc` in the same session instead of reissuing a goal command. A T-72 VERIFY review found and fixed further background gaps: an unconnected project no longer consumes retry attempts, a timer rechecks whether the turn is still failed and the project enabled before sending, an in-flight host submission suppresses another retry timer, and a clean finish resets the attempt budget even when no pane is open. |
| R008 | T-72 review corrected the T-71 launcher: the separate `ZAICODE-Preview.exe` starts an isolated one-time session while daily ZAICODE stays open. Preview chooses a completed `dist-next` package when present; the completion marker is its installer blockmap. Electron's saved UI preferences are under `session/Local Storage/leveldb`, so it copies that tree and optional IndexedDB/Preferences into a unique temporary session, skipping LevelDB locks. It copies the main `~/.zcode/v2/setting.json` while forcing its `dataBaseDir` to the temporary profile, seeds the ZAICODE provider config, and redirects `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `ZCODE_HOME`, and the desktop data paths. Saving a settings snapshot in Preview writes only to that temporary profile. The launcher removes the temporary profile on exit when files are free, and sweeps older locked leftovers after a week. If isolated setup fails, the launcher aborts instead of opening the real profile. The icon-bearing launcher compiles to `ZAICODE.exe.new` and `ZAICODE-Preview.exe`; the current daily `ZAICODE.exe` is running, so its replacement and live preview confirmation remain. |
| R009 | T-71 `zaicodeSidebarPrefs.ts` defaults LIVE to recent activity and migrates the former default. |
| R010 | T-71 `zaicodeAutoRetry.ts` targets an existing retryable turn or editable user input; retry uses the same session. The duplicate retry banner was removed from `ConversationComposer.tsx`. |
| R011 | T-71 `ZaicodeHeaderToolbar.tsx` exposes the palette menu from the header. |
| R012 | T-71 `ZaicodeWorkersSettings.tsx` exposes failed-turn interval and attempt limits; streaming recovery supports up to 100 ZAICODE attempts and an override. |
| R013 | T-71 `ZaicodeIconEditor.tsx` and `zaicodeIconSlots.tsx` provide slots, presets, profiles and import/export. |
| R014 | T-71 project-switch cue is enabled and preheated in `zaicodeSoundEvents.ts`. |
| R015 | T-71 project row and `ZaicodeComposerWorkingFor.tsx` show elapsed running time. |
| R016 | T-71 `ZaicodeTodoDock.tsx` clamps the free dock into the resized window. |
| R017 | T-71 `WorkspaceSidebarItem.tsx` avoids the duplicate worker glyph when MAIN already spins. |
| R018 | T-71 badge designer supports solid colors and gradients through `buildZaicodeIconBadgeDataUri`. |
| R019 | T-71 `ZaicodeHeaderProjectTitle.tsx` centers against the usable title-bar band. |
| R020 | T-71 SUBCHAT model/effort selection and responding model remain. This work adds a visible SAIPEN badge in `ZaicodeSubchatView.tsx` and protocol context for ordinary project prompts in `zaicodeSubchat.ts`, while preserving exact shortcut/slash commands. |
| R021 | T-71 dot/tint freshness remains. This work adds the SAIPEN `STATE.updated` checkpoint to session activity in `WorkspaceSidebarItem.tsx`, so board work changes freshness. |
| R022 | T-71 three sidebar modes share `WorkspaceSidebarItem`; its worker, freshness and elapsed-time fixes apply to each mode. |
| R023 | T-71 `ControlHintTooltip.tsx` disables hoverable tooltip content to stop pointer-jitter flicker. |

Static validation: the final `pnpm typecheck` passed across all configured
packages, including the desktop host. `pnpm lint` passed with 78 warnings and
zero errors; targeted lint of the four latest Auto/A3 files found two existing
spread warnings in the retry watcher. `pnpm architecture:check --changed`
reported zero violations; `git diff --check` passed in zcode. Two
`pnpm bundle:zaicode` invocations completed, with the last run after all code
edits; it verified runtime dependencies and staged a 186.5 MiB installer in
`packages/desktop/dist-next/` at 2026-09-27 02:59 local. Its installer
blockmap and `win-unpacked/ZAICODE.exe` are present. The C# launcher compiled
with the product icon to `ZAICODE.exe.new` and the byte-identical
`ZAICODE-Preview.exe` (matching SHA-256). The running daily root `ZAICODE.exe`
is older, so its launcher replacement remains staged. Python AST parse passed
for all changed FastPrompter files; root `git diff --check` passed. A separate
FastPrompter diff check still reports pre-existing trailing whitespace in an
unrelated `.saipen/LOG.md` line. The graph generations predate the edits
(ZAICODE 2026-09-23, FastPrompter 2026-09-23); exact paths had no recorded
coverage gaps, so direct source and diff reads were used for current claims.
No automated test suite or live UI run was requested or run in this follow-up.

## Manual verification still needed

MANUAL-VERIFY STEPS + EXPECTED (request, not a PASS):

1. While daily ZAICODE remains open, double-click `ZAICODE-Preview.exe` after
   `pnpm bundle:zaicode` finishes. Expect a second window from the staged build
   with the saved palette/sidebar settings; daily ZAICODE and its sessions stay
   open. Change a Preview preference, close Preview, open it again, and expect
   the original saved preference. The daily profile and source defaults must
   retain their original values.
2. In that disposable Preview, enable close-to-tray, hold Shift, and click its
   close control. Expect its process to quit instead of hiding in the tray.
3. In a disposable SAIPEN project with a configured provider, enable Auto and
   work through a small open ticket. Expect continuation without opening the
   project, no duplicate input on an unchanged snapshot, A3 only after an
   explicit DONE and an empty board, and no A3 for a disabled project. A
   controlled actionable A3 finding should create one remediation job; zero
   findings should end the loop. Turning Auto off during a multi-project
   continuation should stop the later sends; disabling a project should skip
   its pending step. Cap remains at ten cycles.
4. With a working SAIFREN router, run Scan now and inspect the reported
   additions, removals, and probe count. Expect transient errors to reduce
   rank without deleting a model, and two explicit missing-model replies to
   quarantine that automatic model until a successful later direct retry.
5. Let a local project turn fail while its chat pane is closed. Expect its
   configured retry timer to submit in that same session without opening the
   project. When a retry finishes cleanly, a later failure should start a
   fresh attempt budget. If the project is disabled before a timer fires,
   expect no submission.
