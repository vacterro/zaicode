# Log

## 2026-10-01T14:22:02Z | RUN | PLAN
RUN: saihunt spawn -> role adopted, charter `sha256:4edb0418` read in order, mode read-only. Source identity pinned: workspace `298f12bd`, zcode `6db3c3bf`.

## 2026-10-01T14:24:10Z | RUN | HUNT
RUN: signal 1 (failing tests) -> `pnpm test` exit 0 on `6db3c3bf`, clean worktree. No failing suite.

## 2026-10-01T14:26:35Z | RUN | HUNT
RUN: signal 2 (unverified commits) -> every product commit in `6db3c3bf` carries a checkpoint line in the workspace LOG. No unverified commit.

## 2026-10-01T14:28:02Z | RUN | HUNT
RUN: signal 3 (stale TODO/FIXME/HACK) -> no genuine marker in the ZAICODE surfaces; every hit is an identifier or a UI string. One upstream `// TODO(i18n)` at `desktopOAuthDeepLink.ts:143` is outside ZAICODE scope.

## 2026-10-01T14:31:44Z | RUN | HUNT
RUN: signal 4 (silent failures) -> every empty catch read in context, all deliberate with a naming comment (`useZaicodeRightClickDrag.ts:60,87`, `zaicodeAutoTitle.ts:31`, `zaicodeAudio.ts:221,450`, `useZaicodeRouterAutoSetup.ts:61,89`). No swallowed I/O.

## 2026-10-01T14:34:18Z | RUN | HUNT
RUN: signal 5 (symmetry gaps) -> four hypotheses tried, none reproduced: thought funnel caller coverage, repair-funnel agreement, `options` data loss in `normalizeModelSelection`, solo-mode lifecycle. Evidence in HUNT-100.

## 2026-10-01T14:36:50Z | RUN | HUNT
RUN: signal 6 (dead code / orphans) -> orphan sweep `kitchen/_orphan-scan.cjs`: 1075 candidates against a 4162-file corpus, 3 hits, 1 real. `pnpm knip` independently named the same two dead aliases and one needlessly exported interface. Two sweep hits dismissed as false positives (`protrailPublic.ts` = published subpath, `zaicodeRuntimeRegistry.ts` = test-only consumer) and recorded so they are never re-filed.

## 2026-10-01T14:38:12Z | RUN | HUNT
RUN: found 3 REPRODUCED dead-code findings plus a full NOT_REPRODUCED record for signals 1-5. OUTBOX grammar bar: first pass REFUSE 14 violations (four prose `verified` values, one blank-line-broken `details` block), second pass `OUTBOX_VALID`.

## 2026-10-01T14:41:50Z | RUN | HUNT
RUN: found nothing new -> findings collapsed from four packages into ONE combined package HUNT-001. `saipen sub collect` refuses with `MALFORMED_PACKAGE: expected exactly one current READY package; found 4`, and PROTOCOL.md section 4 step 3 asks PREPARE to write "the combined result" -- one sweep, one package. Folding the NOT_REPRODUCED signal record into that package's `details` instead of giving it its own package, since it is coverage evidence, not collectable work.

## 2026-10-01T14:43:05Z | RUN | DONE
RUN: collected by main agent -> T-147. Read-only toward the project tree held throughout: `git status` over both trees shows my writes confined to this folder, the `zcode` product tree untouched. Role idle.

## 2026-10-05T23:02:10Z | RUN | PLAN
RUN: role re-adopted from a bare `saihunt`; read order held (own STATE/BOARD/LOG -> PROTOCOL.md -> saihunt.md -> source -> `.saipen/BOARD.md`). First write was a checkpoint repair: the STATE carried `style_contract: ded-6b950e75`, so `parse_state_or_error` returned None and `sub status` read health INVALID with `role_revision_state: STALE`; restamped to `ded-069a4c52`. Source identity re-pinned: workspace `4e213552`, zcode `1cbb0921`, `git-delta-v1:0446f0eb`. HUNT-001 is history -- T-147 is DONE and its three deletions are confirmed present in the tree by direct grep (file gone, both aliases 0 hits, `interface ZaicodeChatEditState` no longer exported); disposal of the package is Core's step, not mine.

## 2026-10-05T23:03:20Z | RUN | HUNT
RUN: signal 1 (failing tests) -> `pnpm test` on the 89-path uncommitted tree exits 0 (TEST_EXIT=0). No failing suite.

## 2026-10-05T23:03:40Z | RUN | HUNT
RUN: signal 2 (unverified commits) -> the twelve newest zcode commits name T-188/T-217/T-220 and each has a workspace LOG checkpoint; no commit without a ticket. Nothing unverified.

## 2026-10-05T23:04:00Z | RUN | HUNT
RUN: signal 3 (stale TODO/FIXME/HACK) -> 5 marker hits, none stale: `web/src/main.tsx:206` (web-remote-workspace, upstream), `shared/src/protocol.ts:297` (settings-schema-version, upstream), `desktop/src/main/desktopOAuthDeepLink.ts:143` (i18n, outside ZAICODE), `WorkspaceSidebarItem.tsx:1733` (a TODO inside a commented-out className string, still meaningful), `ZaicodeSaipenSidePane.tsx:81` (a UI label, not a marker).

## 2026-10-05T23:04:15Z | RUN | HUNT
RUN: signal 4 (silent failures) -> the whole uncommitted diff adds exactly three `catch` blocks, all read in context: `ZaicodeAutoRetryButton.tsx:68` restores state and raises a visible failure flag, `:74` a commented best-effort restore behind a failure already surfaced, `zaicodeHotkeys.ts:287` the one-shot side-pane migration returning the untouched stored value on a failed write (retried on the next read). Nothing swallowed.

## 2026-10-05T23:04:30Z | RUN | HUNT
RUN: signal 5 (symmetry gaps) -> REPRODUCED. The two ZAICODE durable-family lists and their readers compared key by key: `ZAICODE_SAVE_ALL_SETTING_KEYS` holds 55 keys, three of them have no reader that goes through `readZaicodeSetting` -- `zaicode-icon-profiles-v1` (`zaicodeIconSlots.tsx:310`), `zaicode-saipen-log-order-v1` (`ZaicodeSaipenSidePane.tsx:47`) and `zaicode-saipen-ticket-order-v1` (`:57`). `zaicode-icon-profiles-v1` is one of the seventeen T-226 added under a comment asserting exactly the opposite. The coverage test pins list membership only (`zaicodeT223SaveAllCoverage.test.ts:73-108`), so no gate can see it.

## 2026-10-05T23:04:40Z | RUN | HUNT
RUN: signal 6 (dead code / orphans) -> `pnpm knip --workspace packages/ui --include files` names exactly one file, `test/e2e/saiasui.fixture.tsx`, and its consumer could not be determined: no static importer, no config entry (`knip.json` declares entry points for four other workspaces and none for `packages/ui`), and its `.e2e.ts` siblings are equally unimported, which points at a URL-driven harness outside the workspace. Recorded as a BLOCKED lead with the missing capability named, never as a guess and never silently dismissed. The `--include exports,types,files` run named only exported type aliases at internal module boundaries, a pre-existing flood already represented by HUNT-001 finding 3.

## 2026-10-05T23:05:00Z | RUN | DONE
RUN: found 1 REPRODUCED finding class (two halves: the read-path asymmetry and the test that cannot see it) plus a full NOT_REPRODUCED record for signals 1-4 and 6. Delivered as ONE combined package HUNT-002. Read-only toward the project tree held throughout: every write is inside this folder, the workspace and the zcode product tree untouched.

## 2026-10-05T23:35:00Z | RUN | PLAN
RUN: role re-adopted from a bare `saihunt`. Own STATE carried the HUNT-002 idle line, both earlier packages now read `reviewed` (Core disposed HUNT-001 -> T-147 and HUNT-002 -> T-228 after the payload landed under T-227), board DOING/TODO empty. Source identity re-pinned and it MOVED: workspace `4e213552` unchanged, `git-delta-v1:0446f0eb` -> `git-delta-v1:f96332c0`, zcode still `1cbb0921` with the three T-227 repairs in its working tree. A sweep at a new identity is warranted.

## 2026-10-05T23:35:20Z | RUN | HUNT
RUN: signals 1-4, 6 -> nothing new. `pnpm test` last full run on this product tree exit 0 (V:/_TEMP_/saihunt/t227-gates.log, 3494 passed / 0 red / 0 ELIFECYCLE); every zcode commit in the current chain names a ticket with a LOG checkpoint; no stale marker beyond the four already classified in HUNT-002; the uncommitted diff still adds exactly the three catch blocks already read there; HUNT-001's three removals stay gone and `pnpm knip --include files` still names only the one BLOCKED e2e-fixture lead.

## 2026-10-05T23:35:50Z | RUN | HUNT
RUN: signal 5 (symmetry gaps) -> REPRODUCED, one provenance defect in the closed HUNT-002 package. Its `instructions` told Core not to touch `zaicode-notification-sound`, `zaicode-notification-custom-sound-name`, `zaicode-saipen-pane-open-v1` and `zaicode-todo-window` because `zaicodeProfileBundles.ts:10-14` "already declares live facts shared". The same file lists all four as PROFILE-SCOPED members (`:51-54`), the live sentence at `:11-14` never names them, and each one's only reader is a bare `localStorage.getItem` -- the exact class HUNT-002 finding 1 fixed for three other keys. See the package for the file:line evidence.

## 2026-10-05T23:36:20Z | RUN | DONE
RUN: found 1 REPRODUCED finding plus a full NOT_REPRODUCED record for signals 1-4 and 6; delivered as ONE combined package HUNT-003. Read-only toward the project tree held throughout: every write is inside this folder, the workspace and the zcode product tree untouched by this run.

## 2026-10-06T02:10:00Z | RUN | PLAN
RUN: role re-adopted from a bare `saihunt`; read order held (own STATE/BOARD/LOG -> PROTOCOL.md -> saihunt.md -> hunt.md -> source -> `.saipen/BOARD.md`). Source identity re-pinned and it MOVED: workspace `4e213552` unchanged, `git-delta-v1:f96332c0` -> `git-delta-v1:f413c6fb`, zcode still `1cbb0921`. Found HUNT-003 still `ready` while its recorded fingerprint no longer describes the tree -- the collector refuses a queue holding a stale READY package (`PACKAGE_INCOMPLETE`), so this sweep has to leave exactly ONE current READY package, not two.

## 2026-10-06T02:12:00Z | RUN | HUNT
RUN: signal 1 (failing tests) -> the repository's own test script exits 0 on this tree: `_hunt004-test.log` 7 blocks, 1756 tests, 1754 pass, 0 fail, last line 2046 `TEST_EXIT=0`. The background run recorded as PID 19056 has exited; its log is the evidence and was read, not assumed.

## 2026-10-06T02:13:00Z | RUN | HUNT
RUN: signal 2 (unverified commits) -> NOT_REPRODUCED. zcode `625c0119` has zero literal mentions in `.saipen/LOG.md` while `2c25beda` (4), `adac42dc` (1) and `1cbb0921` (1) have them, so a hash-only search looks like an unlogged commit -- it is not one: E-3753/E-3754 journal the same verifier (`zaicodeT188AdmissionFullness.test.ts`) against the same pre-fix subject with the identical tally the commit message reports (exit 1, 3 tests, 2 pass / 1 fail, subject `0cda0488`). Recorded as a near-miss so it is never filed as an unlogged commit later.

## 2026-10-06T02:14:00Z | RUN | HUNT
RUN: signal 3 (stale TODO/FIXME/HACK) -> NOT_REPRODUCED: only the two upstream markers (`desktopOAuthDeepLink.ts:143` i18n, `shared/src/protocol.ts:297` settings-schema-version); every other hit is an identifier or a UI string. Signal 4 (silent failures) -> NOT_REPRODUCED: `zaicodeQueueAutoResume.ts:148` logs a warn, `zaicodeGoalSupervisor.ts:262` is the documented `catch {}` inside `bumpGoalVersion`, and HUNT-002's three catches are unchanged. No swallowed I/O in the delta.

## 2026-10-06T02:16:00Z | RUN | HUNT
RUN: signals 5 and 6 (symmetry gaps, dead code) -> REPRODUCED, three findings of one shape (a rule the project believes is enforced and a live path that never asks it). (1) `zaicodeGoalSupervisor.ts:175,186,213` (`mayContinueZaicodeGoal`, `recordZaicodeGoalContinuation`, `detachZaicodeGoalSupervision`) have zero production callers -- only `test/zaicodeT222GoalSupervisor.test.ts` -- so `intent.continuations` only ever increments in that test and `ZAICODE_GOAL_MAX_CONTINUATIONS` (`:58`) is unreachable in the product while the header at `:14-19` promises an owner that asks. (2) T-231's own rationale says "the composer countdown, the background retry host and the crash resume all gate on zaicodeEffectiveAutoRetry"; the first two do (`ZaicodeAutoRetryButton.tsx:36`, `zaicodeAutoRetry.ts:224`, `zaicodeTurnRetryWatch.ts:103,160`), the crash resume does not (`zaicodeCrashResume.ts:15,153` calls `zaicodeMayAutoSend` with `featureOn: prefs.resumeAfterCrash`), and nothing writes the ledger's declared `"crash"` source (`zaicodeRetryPolicy.ts:135`). (3) `zaicodeAutoSendAllowed` (`zaicodeRetryPolicy.ts:79`), documented as "the whole gate for one session, outside React", has only test callers. Its missing halt fold was considered and dismissed as unobservable, not filed as a behavioural defect.

## 2026-10-06T02:18:00Z | RUN | HUNT
RUN: HUNT-003's four-family payload re-measured at this identity before carrying it forward: all four keys still absent from the 55-key `ZAICODE_SAVE_ALL_SETTING_KEYS` (`zaicodeSettingsSnapshot.ts:6-67`, zero hits), each reader still bare (`ZaicodSaipenSidePane.tsx:32,38`; `v4/ZaicodeTodoDock.tsx:9,28`; `taskNotificationSound.ts:14,50` and `:15,58`), all four PROFILE-SCOPED at `zaicodeProfileBundles.ts:51-54`.

## 2026-10-06T02:20:00Z | RUN | DONE
RUN: found 3 REPRODUCED findings plus the re-verified HUNT-003 carry-over; delivered as ONE combined package HUNT-004 with HUNT-003 marked `stale` + `superseded_by` so the queue holds one current READY package again and nothing is dropped. `saipen outbox check saihunt` -> OUTBOX_VALID exit 0. Deliberately NOT filed, with the reason in the package: the stale gitignored `packages/desktop/out/main/index.js` bundle (build artefact; `pre-dev` deletes and rebuilds `out/`) and the 108,822 KiB / 7912-file `.saipen/saitranslate/kitchen` detection surface (CLEAN owns the classification). Read-only toward the project tree held throughout: every write is inside this folder.
