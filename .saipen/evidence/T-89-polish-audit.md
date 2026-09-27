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
