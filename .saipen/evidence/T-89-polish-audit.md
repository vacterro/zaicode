# T-89: polish audit of the SRC-058 feedback list

SRC-058 is the operator's list sent on 2026-09-27, plus the follow-up
instruction: "instead of new features, if there really are none, check that
everything is implemented correctly and fix what is wrong. This is the polish
stage."

## What the list is

The list has 39 items. Each item's text was matched against every captured
source, both active and archived:

| Items | Source | Earlier owner |
|---|---|---|
| 2 | **new** | none |
| 11 | SRC-055 (before its first `---`) | T-83, coverage in `docs/ZAICODE_FEEDBACK_COVERAGE.md` |
| 23 | SRC-053 | T-72, and T-71 before it (`T-72-feedback-followup.md`) |
| 3 | SRC-049 (the unchecked `[ ]` items at the end) | T-64 |

## Product fixes

The fixes are in the zcode clone, branch `zaicode`, on top of
`origin/zaicode` `4860369`. Every fix has a regression test, and each test
was run red against the old behaviour.

| Commit | Item | Defect | Test | Red control |
|---|---|---|---|---|
| `6295bec` | new #2, SRC-053 R015 | The chatbox "working for" timer counted from the moment the operator opened the session. The project row counted from the session's `createdAt`, so a days-old MAIN read "3d". | `zaicodeRunClock.test.ts` (6), `zaicodeWorkingSince.test.ts` (3) | 2 of 3 fail on the pre-fix code |
| `99bcffa` | SRC-053 R023 `[ ]` | The hint tooltip blinked. The card slid in under the pointer and took the hover from its trigger, so it closed and reopened in a loop. | `zaicodeHintTooltip.test.ts` (2) | 0 of 2 pass without the class |
| `f4284a1` | SRC-049 splash `[ ]` | Choosing a start-up picture in another format left the old `custom.*` in place. The launcher (it tries png first) kept showing the old picture while the app showed the new one. | `packages/desktop/test/zaicodeSplashFiles.test.ts` (4) | 2 of 4 fail without the cleanup |
| `5260c2f` | SRC-053 R007 (third report) | A failed turn retried only after the operator entered the project. A mounted pane that could not act still claimed the session, so the background retry host stood down. | `zaicodeRetryClaim.test.ts` (3) | the old rule fails the main case |

Gates at `5260c2f`, run in Claude Code Cloud with node 24.14.0 and pnpm
10.33.2:

| Gate | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | 0 errors, 76 warnings (same as baseline) |
| `pnpm run architecture:check` (full and `--changed`) | 0 violations |
| `pnpm test` | ui 284/284, services 49/49, desktop 44 pass / 9 skip (win32 only) |
| `git diff --check 4860369..HEAD` | clean |

The baseline at `4860369` had the same results with ui 270 and desktop 40.
The install used `--ignore-scripts`, because the desktop postinstall rebuilds
node-pty against Electron headers.

None of the changed files overlap the operator's local, unpublished T-84 delta
(`packages/desktop/src/host/zaicodeRunDispatch.ts`,
`packages/desktop/test/zaicodeHitAndGo.test.ts`).

## Audited, no defect found

| Item | What was checked |
|---|---|
| SRC-055 #1: STOP excludes the session from Auto | `zaicodeContinue.ts:67`: a manual Stop marks the step `autoEligible: false`. The same `continued` flag also suppresses the SAIPEN MAIN step, so no other kind of step gets around it. |
| SRC-055 #4: "Task completed" out of nowhere | `taskNotificationOrchestrator.ts:76-82` stays silent for every goal status except `verified`. One case is not checked: whether `phase` can arrive before `goalStatus`, which needs a live CLI. |
| SRC-055 #8: SUBCHAT xhigh/max | `zaicode-subchat.ts:180` passes the value through as `model_reasoning_effort`. Upstream Codex accepts `none/minimal/low/medium/high/xhigh/max/ultra/persistent` and any model-defined value (`openai/codex` `codex-rs/protocol/src/openai_models.rs:59-89`). |
| SRC-055 #10, SRC-049 "where am I" `[ ]` | By default the header shows the project in the centre (`showProject: true`). At a header width of 420 px or less, `data-zaicode-narrow-context` shows the project and the session. Below 720 px, `ZaicodeWhereAmI` adds a line. The only gap is when the operator turns "Project name in the title bar" off. |
| SRC-055 #11: working icon up to 1 MiB, 4096², video | `zaicodeWorkingMedia.ts` checks MIME, size and dimensions and requires the media to decode. The normalizer allows 1.4 MiB of data URL, which fits the base64 of a 1 MiB file (about 1,398,127 characters). |
| SRC-049 shortcuts incl. Exit `[ ]` | All 35 catalog actions have a handler (`global.toggleWindow` is handled in `zaicodeGlobalHotkeys.ts:45`). The defaults have 0 conflicts (`findZaicodeHotkeyConflicts`). Exit is `app.exit` on Alt+F4 plus a bindable `global.exit`, which goes through IPC to `quitAppForZaicode`. The ZAICODE page links to the upstream Shortcuts page. |
| SRC-049 grey block while loading | The renderer boot shell (`packages/desktop/src/renderer/index.html`) shows the ZAICODE picture on `#1a1810`, with no grey logo tile. The custom picture is mirrored into `localStorage` before first paint. |

## Second pass: the 25 repeats (cloud, 2026-09-27)

The first pass left 25 repeats unread. This pass read the code of each one on
`zaicode` at `5260c2f`. One defect was found and fixed:

| Commit | Item | Defect | Test | Red control |
|---|---|---|---|---|
| `24931f2`, `290136a` | SRC-053 R003 (A3 loop) | `ZaicodeAuditService.reconcileAll` read every campaign before taking that campaign's lock. A `getState()` issued while `cancel()` held the lock reconciled the stale `running` copy, saw the cancelled wave job and wrote `blocked` over `cancelled`. It now re-reads that one `campaign.json` inside the lock (`290136a`: not `findCampaign()`, which rescans every campaign directory). | `zaicodeAudits.test.ts` "a reconcile queued behind cancel" | old code: actual `blocked`, expected `cancelled` |

Audited with no defect found:

| Item | What was read |
|---|---|
| SRC-055 #2 A3 counter | `zaicodeAuditProgressFor` (active campaigns only) drives the `A3 n/m` badge on every project row (`WorkspaceSidebarItem.tsx:1397`). The operator's screenshot shows it. |
| SRC-055 #3 analogue clock | `ZaicodeMiniAnalogClock` in `ZaicodeTopbarClock.tsx:74`, drawn with the digital time when `showTime` is on. |
| SRC-055 #5 PLAY in the MAIN view | `startSaipen` activates the tab, then awaits the durable `listTasks` (5 s timeout, no command on timeout) before deciding fresh/open/continue, so a cold project is not read as empty. |
| SRC-055 #6 Pebble game | `ZaicodePebbleGame.tsx`; `zaicodePebbleGame.test.ts` passes in the suite. |
| SRC-055 #7 ON/OFF styling | `projectOn*/projectOff*` colour, opacity, font, size, bold, underline in `zaicodeSidebarPrefs.ts`, applied in `WorkspaceSidebarItem.tsx:1008-1011`, edited in `ZaicodeSidebarSettings.tsx`. |
| SRC-055 #9 Continue All width | covered by the T-83 packaged smoke at 640x540 (`verify-zaicode-t83.cjs`); no code change since. |
| R001 Shift+close | `handleDesktopWindowCloseRequest` quits on `shiftCloseRequested`; `index.ts:1825` tracks Shift via `before-input-event` and clears it on blur. Needs a live Windows check (caption button). |
| R002 account visibility | `zaicodeEngineHasCapacity` keeps a fresh 100% account visible; unknown readings stay visible; label "Hide spent engines". |
| R004 SAIFREN sanitation | `scanZaicodeFreeModels` (desktop `zaicodeRouterSetup.ts:237-362`): two absent listings retire, two explicit not-found probes quarantine 24 h, transient failures only lower rank, manual order kept. |
| R005 sound triggers | generic `ui.button` / `ui.toggle` / `ui.select` / `ui.contextMenu` listeners stand down when a control played its own cue within 80 ms. More triggers are new work (T-91). |
| R006 GLM resets | `zaicode-engines.ts:570` maps `nextResetTime`; `zaicodeEngines.test.ts:161` covers it. |
| R008 dev preview | `ZaicodeLauncher.cs` preview mode (isolated profile, abort on failure, cleanup). Launcher build is Windows-only. |
| R009 LIVE order | `orderZaicodeProjectSections` ranks LIVE by `lastActivityAt` by default with a grace hold. Remain-in-position is new work (T-91). |
| R010 retry chat | `zaicodeAutoRetry.ts` retries the retryable row in the same session. |
| R011 theme button | header toolbar `palette` action opens `ZaicodePaletteMenuContent`. |
| R012 retry settings | `autoRetryIntervalSec` / `autoRetryMaxAttempts` read by `zaicodeTurnRetryWatch.ts:84,132,140`. |
| R013 icon workshop | `zaicodeIconSlots.tsx` slots, overrides, reset; editor in `ZaicodeIconEditor.tsx`. |
| R014 project-switch sound | cue on by migration, all enabled cues pre-decoded (`preheatZaicodeSounds`), context resumed before `start()`. |
| R016 todo dock | `clampToWindow` on every resize (`v4/ZaicodeTodoDock.tsx:41,77`). |
| R017 duplicate worker glyph | `WorkspaceSidebarItem.tsx:973` skips the worker glyph when MAIN already spins. |
| R018 icon gradients | `buildZaicodeIconBadgeDataUri({from,to,gradient,glyph})`. |
| R019 title centring | `ZaicodeHeaderProjectTitle.tsx:216` centres on the free band. |

SRC-053 R020, R021 and R022 are marked `[x]` (done) by the operator in the
list itself.

Gates at `290136a` (cloud, node 24.14.0, pnpm 10.33.2): `pnpm typecheck` 0
errors; `pnpm lint` 0 errors, 76 warnings; `pnpm run architecture:check --
--changed` 0 new; `pnpm test` ui 284/284, services 50/50, desktop 44 pass / 9
skip (win32 only).

## New, not implemented

The new item #1 asks for Claude Code's new reset system in ZAICODE, LIMISAW
and FastPrompter.

ZAICODE already reads Claude Code's `/usage` text: current session, current
week and spend limit, each with its reset time and time zone
(`packages/shared/src/zaicode-engines.ts:262-271`). What Claude Code added is
shown only in the screenshot `clipboard_20260927_075217_46640d99.png`, which
is on the operator's `V:` drive and cannot be reached from the cloud. LIMISAW
and FastPrompter are not in this session. Scoping this needs the text of the
new `/usage` output, and it is a new feature, not polish.

## Operator checks (local only)

- Alt+F4 on Windows: confirm that the renderer receives the key and the app
  fully quits, rather than only hiding to the tray.
- Background retry: fail a turn in a project that is not open, and expect the
  countdown toast after the configured interval without opening the project.
- Splash: pick a PNG, then a JPG. Expect the new picture in the root
  launcher, the app splash and the settings preview.
- Hover the composer's Stop button and other hint icons near their edges.
  Expect a steady tooltip.

## Third pass: re-audit of the second pass's "no defect found" rows (operator machine, 2026-09-27)

The second pass read each repeat once and filed 23 of them as "no defect
found". This pass read them again, deeper, on the operator machine at
`290136a`, and **14 of those 23 verdicts do not survive**. Reading a symbol
once and seeing the right name is the failure mode the operator's follow-up
names, and it produced these. The corrected verdicts follow, each with the
evidence that overturns the earlier row.

| Item | Second pass | Corrected | What overturned it |
|---|---|---|---|
| SRC-055 #5 PLAY in MAIN view | no defect | **DEFECT** | `startSaipen` races `listTasks` against a 5 s timeout and, on a cold project, returns without opening anything (`WorkspaceSidebarItem.tsx:471-489`). Every manual-open path has no timeout, which is exactly the operator's "manual open loads it, PLAY does not". It then fires a headless `resumeTask`+`send` with no barrier against the pane's own load, and never calls `showChatMainView()`. |
| SRC-055 #9 Continue All width | "no code change since" | **DEFECT** (fixed `393590a`) | `@min-[360px]/workspace-sidebar` queries a container nothing ever declared, so the wide three-column layout was dead at every width. |
| R014 project-switch sound | "cue on by migration" | **DEFECT** (fixed `393590a`) | The row is a `role=button`, so the global `ui.button` listener played a *direct* sound; the `sidebar.project` echo followed inside the 700 ms suppression window and was dropped. Clicking the row never played the project cue. |
| R019 title centring | "centres on the free band" | **DEFECT** | `--windows-caption-controls-right-inset` is written only by `createWindowsCaptionControlsStyle`, applied to `DesktopTopOverlay`, which is not an ancestor of `<header>`. The header always falls back to 136 px on every platform, so on macOS the title sits off-centre. |
| SRC-055 #2 A3 counter | "drives the badge" | PARTIAL | Shows complete/total, not remaining. A `partial` wave sets the campaign `blocked`, which still counts as active, so a blocked campaign reads as reserve it will never spend. The project match is an exact case-sensitive compare while the product uses `sameZaicodeProjectPath` everywhere else. |
| SRC-055 #6 Pebble game | "test passes" | PARTIAL | A real game, but the six levels are one minigame with numeric scaling only; `drawPixelText` uses antialiased `ctx.fillText`, which the CSS `-webkit-font-smoothing` rule cannot reach, against the operator's "pixeled without blurriness"; scaling is non-integer below `max-w-[960px]`. |
| SRC-055 #7 ON/OFF styling | "editable in settings" | PASS | Confirmed: per-state colour and opacity plus font, size, bold and underline (`ZaicodeSidebarSettings.tsx:132-190`), with an `OFF` text badge so the state is not colour-only. No test covers the keys. |
| R003 AUTO toggle + A3 loop | fixed in `290136a` | PARTIAL | The fall-through fires only when `blockedTickets === 0` (`ZaicodeAppRuntime.tsx:378`), and that value is `null` without a SAIPEN board, so for a project with no board A3 never starts even with Auto ON. The loop *conditions* are hard-coded in `shouldStartZaicodeAuditCampaign`, so the "configurable conditions" half of the request is not met. |
| R002 account visibility | "has-capacity keeps it visible" | PARTIAL | The reported symptom is **not reproducible from source**: discovery, the probe pool and every display are set-correct. The one real gap found is that `discoverCodex` has no `CODEX_HOME` equivalent, so a Codex account configured only by environment is never discovered. |
| R006 GLM resets | "maps nextResetTime" | PARTIAL | Detection is plan-agnostic and correct. *Discovery* is not: `ZCODE_PLAN_PROVIDER_IDS` is a fixed four-entry list with no Lite entry and no registry, and `readZcodePlanEntries()[0]` makes a second concurrent plan invisible. |
| R011 theme button | "header toolbar opens the menu" | PARTIAL | Placement and adjacency are delivered and visible by default. The "marked yellow" reading cannot be confirmed: the referenced screenshot is not in the repo and `SRC-053:R011` normalises the request to "move the trigger to the quick-access row". It also degrades to two clicks when the overflow row swallows it. |
| R012 retry settings | "reads the prefs" | PARTIAL | The preferences are real and the default budget is 100. But the "reconnecting" state the operator asked for does not exist: `RECONNECT_DELAYS` is a hard-coded nine attempts in `packages/rpc/src/remote.ts`, `RemoteAgentConnection` is never instantiated, and `connectionState: "reconnecting"` is never emitted. |
| R013 icon workshop | "slots, overrides, reset" | PARTIAL | Export and import are real. Coverage is not "all icons": 31 fixed slots, only 11 files consume `ZaicodeIcon`, 42 files under `src/zaicode/` import `lucide-react` directly, and there is no `worker.*` slot. |
| R016 todo dock | "clampToWindow on resize" | PARTIAL | A clamp, not a reposition: the docked panel is pinned at `right:16 top:64` at every size, with no breakpoints and no re-docking. |
| R017 duplicate worker glyph | "skips when MAIN spins" | PARTIAL | The fixed case was the *spinner*, not the worker glyph. `zaicodeProjectWorkers` still dedups nothing, so two workers of one engine in one project render two identical chips, and one worker shows in three places at once. |
| R018 icon gradients | "badge builder" | PARTIAL | One two-stop 45° linear gradient behind one checkbox: no angle, extra stops, radial or blur, and `ZaicodeWorkerPrefs` has no colour or gradient fields at all. This is the generic slot designer, not a worker icon editor. |
| R001 Shift+close | "needs a live check" | PASS (verified in source) | `before-input-event` records Shift, `shiftCloseRequested` calls `requestQuit()` then `app.quit()`, the same path as a confirmed quit. Caveat: the shipped feature is Shift plus a *click* on the X; a Shift+X chord works only if the operator binds `app.exit`, whose default is `Alt+F4`. |
| R008 dev preview | not restated | PASS | Real isolation: a temp profile with HOME, USERPROFILE, APPDATA and all `ZCODE_*` roots redirected, so the single-instance lock is taken independently. Real settings seeding: `session/Local Storage` plus `zaicode-settings-snapshot.json`, and the renderer reads `localStorage` first. |
| R010 retry chat | "same session" | PASS | `fork-edit-retry` is a rewind-and-resend inside the current session, and auto-retry re-sends into the same `sessionId`, so no session is created and none can vanish. The separate **queue** retry does create a row (`zaicodeJobService.ts:294`) and `zaicodeStore.ts:223` does not select it, so the panel shows the old row. |
| R004 SAIFREN sanitation | not restated | PASS | A real reaper: two absences or two 404s retire a model, a 24 h `retryAfter` re-probes and restores it, ranking is capability plus health, and `ranked = [...manual, ...automatic]` means the scanner can only evict what it added. `zaicodeRouterSetup.test.ts` passes 8/8 on this machine. |
| R005 sound triggers | "more triggers is new work" | PASS | Already 48 events with 41 enabled, five global document listeners (any button, toggle, select, copy, context menu) and a declarative `data-zaicode-sound` opt-in. This is also the mechanism that caused the R014 defect above. |

The two fixed defects, each with a red control:

| Commit | Item | Fix | Test | Red control |
|---|---|---|---|---|
| `393590a` | SRC-055 #9 | `@container/workspace-sidebar` declared on the sidebar panel (`WorkspaceShellLayout.tsx:1654`), so the action strip's wide layout can match | `zaicodeSrc58Polish.test.ts` (2 tests) | 2 of 2 RED on the pre-fix code |
| `393590a` | R014 | `data-zaicode-sound="sidebar.project"` on the project row, which plays the cue directly and opts the row out of the generic `ui.button` listener | same file, second test | 2 of 2 RED on the pre-fix code |

The packaged smoke missed both by construction: it asserts that the narrow
640x540 strip does not overflow, which the stacked fallback already satisfies,
and it never clicks a project row. That is a gap in the smoke, not a false
claim in `docs/ZAICODE_FEEDBACK_COVERAGE.md` — the script and the claims there
check out and were re-read.

Gates at `393590a` on this machine (node 24.15.0, pnpm 10.33.2):
`pnpm run verify:pre-push` exit 0 — lint 0 errors and 76 warnings (the
baseline), ui 286/286, services 50/50, desktop 54/54. Published to
`origin/zaicode` as a fast-forward, 290136a..393590a.

## Not fixed here, and why

- **R019 title centring** needs the real caption inset. The renderer never
  receives the caption-button position, and the 136 px fallback is only correct
  on Windows with the buttons on the right, so changing it blind would move the
  title somewhere else wrong. Recorded instead.
- **SRC-055 #5 PLAY** is a product decision, not a typo. The 5 s timeout was
  added deliberately to avoid a second MAIN on a hydrating project, as the
  comment at `WorkspaceSidebarItem.tsx:463` records. Removing it restores the
  operator's behaviour and reinstates the race it guards. That tradeoff is the
  operator's to make.
- **R003 loop conditions** configurable in settings is new build surface for the
  feature the operator called the core one; it is tracked as T-91.
- **R013 and R018 icon coverage** is new build surface, not polish: 42 files
  would have to move onto the slot system.
