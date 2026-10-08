# Follow-up repair report — ZAICODE fast bundle

Date: 2026-10-06. Repo: `_ZAICODE` workspace, product in `zcode/` (untracked/mixed
working tree; nothing committed by this pass). Scope: the four defects of the fast
bundle, without regressing T-222..T-232, the account system, SAI Accounts federation,
queue behaviour, composer behaviour, or existing workflows.

Ticket map: T-234 (defect 1) · T-235 (defect 2) · T-236 (defect 3) · T-237 (defect 4).
Ledger: `.saipen/evidence/T-229-deep-audit-20261006.md` §11–§12.

---

## 1. Files changed

New (`??`) files:

| file | ticket |
|---|---|
| `zcode/packages/ui/src/zaicode/zaicodeGoalContinuation.ts` | T-235 — the single production continuation owner |
| `zcode/packages/ui/src/v4/conversationLatestAnswer.ts` | T-236 — pure latest-answer derivation |
| `zcode/packages/ui/src/v4/ConversationLatestAnswerBar.tsx` | T-236 — the sticky affordance |
| `zcode/packages/ui/test/zaicodeT234GoalContinuation.test.ts` | T-235 — 11 tests |
| `zcode/packages/ui/test/zaicodeSrc139LatestAnswer.test.ts` | T-236 — 7 tests |
| `zcode/packages/desktop/src/main/zaicodeSettingsSnapshotShape.ts` | T-232 — shape gate |
| `zcode/packages/desktop/test/zaicodeSettingsSnapshotShape.test.ts` | T-232 — 4 tests |
| `zcode/packages/ui/src/zaicode/zaicodeGoalSupervisor.ts` | T-222/T-230/T-235 — supervisor (new file in this batch) |
| `zcode/packages/ui/test/zaicodeT222GoalSupervisor.test.ts` | T-222/T-230 — supervisor suite (new file) |

Modified (`M`) files:

| file | ticket |
|---|---|
| `zcode/packages/ui/src/zaicode/zaicodeStall.ts` | T-234 — bounded background window |
| `zcode/packages/ui/test/zaicodeSrc81Stall.test.ts` | T-234 — zombie + boundary fixtures |
| `zcode/packages/ui/src/zaicode/ZaicodeAppRuntime.tsx` | T-235 — one mount point |
| `zcode/packages/ui/src/v4/ConversationTimeline.tsx` | T-236 — bar mount |
| `zcode/packages/ui/src/zaicode/zaicodeCrashResume.ts` | T-237 — effective policy |
| `zcode/packages/ui/src/zaicode/zaicodeRetryPolicy.ts` | T-231/T-237 — effective projection |
| `zcode/packages/ui/src/zaicode/zaicodeQueueAutoResume.ts` | T-231 — queue gate |
| `zcode/packages/ui/test/zaicodeSrc81Queue.test.ts` | T-231 — audit assertions |
| `zcode/packages/ui/test/zaicodeSrc82Retry.test.ts` | T-237 — truth table |
| `zcode/packages/desktop/src/main/zaicodeSettingsSnapshot.ts` | T-232 — writer consults the gate |
| `zcode/packages/ui/src/zaicode/zaicodeSettingsSnapshot.ts` | T-232 — renderer capture |

Ledger/state: `.saipen/evidence/T-229-deep-audit-20261006.md` (§11 closing addendum,
§11.3 corrective evidence, §12 focused verification), `.saipen/BOARD.md`,
`.saipen/STATE.md`, `.saipen/LOG.md` (via the SAIPEN CLI).

---

## 2. Defect 1 — background liveness was immortal (T-234)

**Root cause.** `zaicodeSessionWorking` exempted any session carrying attached
background work from stall detection with no bound at all, so a session whose writer
had stopped still read `running` forever. The observed case is the sidebar row
`TEST 5h 16m`: the foreground lease had long ended and no event had arrived, but
`hasBackgroundWork === true` made the row permanently exempt.

**Behavioral change.** The exemption is now bounded by
`ZAICODE_BACKGROUND_STALL_MS`, evaluated against the gap since the last real activity
event (`lastActivityAt`, which advances on every non-configuration `SessionEvent`).
Total runtime is never used; only silence is. The off-screen measurement follows the
same window. When the writer goes quiet past the bound, the row stops reading `running`
and drops out of `runningSessionsOf`.

**Why the window is five hours, not N.** The repository already carries an accepted
operator contract — `zaicodeEfficientAutomation.test.ts` "quiet live background tests
are working after five hours" — so a shorter window would reap legitimate long jobs,
and the observed zombie sits at 5h16m. The bound is therefore pinned between the
accepted contract (5h) and the observed zombie (5h16m), with a strict `>` so exactly
five hours still counts as working. A runtime-emitted per-work heartbeat is the true
ceiling and is named in the source comment; no heartbeat was faked from UI rendering.

**Tests.** `zaicodeSrc81Stall.test.ts` (7 tests): the 5h16m zombie is STALLED with
indicator `none` and is dropped by `runningSessionsOf`; five hours of silence is still
inside the contract; `bg-over`, `finished-bg` and `restored` fixtures moved to
`ZAICODE_BACKGROUND_STALL_MS ± MINUTE`.

---

## 3. Defect 2 — Auto Goal had no production continuation owner (T-235)

**Root cause.** `mayContinueZaicodeGoal` / `recordZaicodeGoalContinuation` and the
observation feed existed, but no production code called them: the goal could only
advance while a composer was mounted, i.e. never after the very turn that started it.
T-222's "keep going until terminal" was asserted against functions no sender called.

**Behavioral change.** Exactly one owner, `useZaicodeGoalContinuation`, mounted once in
`ZaicodeAppRuntime.useZaicodeCrashSafety`. It runs off the published session briefs —
the briefs *are* the clock, so there is no polling and no timer. When a turn of an open
goal ends it: folds the brief through the existing observation feed, asks the new pure
truth table `zaicodeGoalContinuationAllowed`, takes the atomic claim
(`claimZaicodeGoalContinuation` — synchronous check-and-record), spends the process-local
"saw running" evidence so one turn end buys exactly one continuation, decides the send
with the canonical `decideZaicodeSessionContinue`, and sends through the canonical
handle. Every refusal path (`!allowed`, `!claimed`, planner disagreement, missing
handle) releases the claim via `failZaicodeGoalContinuation`.

**Stops on:** goal complete, explicit STOP, blocker, Auto Goal disabled, project
disabled, stop-all, budget exhausted, turn still running, session waiting, or a
continuation already in flight. Duplicate sends are prevented across re-renders (pure
derivation, no effect on render), queue wakeups (claim is process-global), background
completion (the fold is idempotent), restart (a reload drops the evidence and replays
nothing), and multiple observers (no second owner exists; also asserted by source).

**Order note.** The budget reason now wins over the in-flight mark inside
`mayContinueZaicodeGoal`, so a spent budget reads "continuation budget exhausted" rather
than "already in flight" — the durable truth, not the leftover of the last claim.

**Tests.** `zaicodeT234GoalContinuation.test.ts` (11 tests): gate truth table with one
named reason per blocker; OFF/disabled/stop-all spend nothing; a completed goal is never
continued; explicit STOP is never resurrected; blocker and exhausted budget stop the
owner; two racing claims yield exactly one; repeated ticks produce no duplicate; one
turn end = one continuation with re-arm only on a new turn; a rejected send releases the
claim (`pending false`, `failures 1`, `continuations 1`); a reload cannot replay; and
source wiring (canonical host import, one mount, no `setInterval`/`setTimeout`, exactly
two files naming claim/record).

---

## 4. Defect 3 — sticky latest assistant answer was missing (T-236)

**Root cause.** The sessions-index projection had reduced the latest assistant text to
the boolean `hasAssistantOutput`, so no upstream data existed to hang an affordance on.

**Behavioral change.** A sticky, compact latest-answer bar at the top of the
conversation, in product mode, shown only while a meaningful latest answer exists. The
anchor is derived from the render units every render (no stored copy), keyed on
`identity: entityId ?? rowId`, and the click jumps through the DOM by
`[data-row-id="{rowId}"]` into the virtualizer — never by matching preview text. The
preview is collapsed whitespace, cut on a word over 60% of the 140-char ceiling. The
bar is a zero-height sticky wrapper (`h-0`), pointer-through, so virtual rows never
shift; it hides below the `864px` conversation breakpoint; and it reuses the navigator's
existing i18n key (`chat.turnNavigator.jumpToQuery`) rather than costing 34 locale files.
If the target row is already visible (8px tolerance) the click is a no-op.

**Tests.** `zaicodeSrc139LatestAnswer.test.ts` (7 tests): newest settled answer wins with
its own `rowId`/`identity` (entityId preferred); only settled non-empty answers are
offered, with fallback to the previous settled one; flat truncated preview with a hard
ceiling; already-visible click is a no-op; derives from units and jumps by row id, never
by text (asserts no `textContent` matching and no React state); cannot obstruct
composer/header/panels (zero-height sticky wrapper, position checks inside the scroll
container and outside the masked layer); accessible name reuses the navigator key.

---

## 5. Defect 4 — Auto Retry split brain, second half (T-237)

**Root cause.** The queue owner had already been moved onto `zaicodeEffectiveAutoRetry`
under T-231, but `zaicodeCrashResume.ts` still asked the older `zaicodeMayAutoSend`
(session-On wins, feature flag read from one scope only), so the Auto Retry surface and
an autonomous crash resume could disagree. `zaicodeMayAutoSend` / the dead
`zaicodeAutoSendAllowed` were the second authority.

**Behavioral change.** Crash resume now asks `zaicodeAutoRetryAllowedFor` — the effective
projection plus the stop-all ledger plus per-project/session overrides — and the dead
predicate/export is deleted. One canonical effective policy; the UI state and the actual
autonomous-send behaviour read the same function. Valid project/session overrides are
preserved (an explicit per-project ON is honoured; an explicit OFF wins).

**Tests.** `zaicodeSrc82Retry.test.ts` and `zaicodeSrc81Queue.test.ts` green: the truth
table on `zaicodeEffectiveAutoRetry`, and wiring assertions that no source still
references the deleted predicate.

---

## 6. Validation — focused (per changed subsystem, run this pass)

| suite | result |
|---|---|
| `zaicodeSrc81Stall.test.ts` + `zaicodeEfficientAutomation.test.ts` (T-234) | 15 pass / 0 fail, exit 0 |
| `zaicodeT234GoalContinuation.test.ts` (T-235) | 11 pass / 0 fail, exit 0 |
| `zaicodeSrc139LatestAnswer.test.ts` (T-236) | 7 pass / 0 fail, exit 0 |
| `zaicodeSrc82Retry.test.ts` + `zaicodeSrc81Queue.test.ts` (T-237) | green, exit 0 |
| `zaicodeT222GoalSupervisor.test.ts` + `zaicodeSrc81Queue.test.ts` (T-230/T-231) | 24 pass / 0 fail, exit 0 |
| `zaicodeSettingsSnapshotShape.test.ts` (T-232) | 4 pass / 0 fail, exit 0 |

Red controls: each repaired clause/predicate was reverted one at a time, the new test
went red, and the file was restored and re-verified green (recorded in the T-229 ledger,
§2, §3, §3b, §11).

## 7. Validation — broader (this pass)

`pnpm verify:pre-push` on `zcode/` → **exit 0**. Totals from that run: `@zcode/ui`
**1239 pass / 0 fail / 0 skipped**; `@zcode/desktop` **250 pass / 0 fail / 2 conditional
skips**; other suites 9 + 11 + 45 + 103 + 118 pass, 0 fail. Covered by the same chain:
`pnpm lint` **0 errors**, `pnpm architecture:check --changed` **0 violations**. No test
was red; nothing was inspected as red because none occurred.

## 8. Remaining manual / operator checks (not closed by this pass)

1. **Defect 2 live drive**: the owner is proven at unit level and by source wiring; a real
   end-to-end goal (submit `/goal cc all`, watch it continue across turn ends, and stop on
   STOP/complete) needs a live packaged run.
2. **Defect 3 visual placement**: DOM-index and source assertions only; the running app's
   narrow-layout / no-jitter behaviour is a visual look.
3. **Defect 1 contract**: the five-hour accepted contract is asserted by the pre-existing
   `zaicodeEfficientAutomation.test.ts` case against the new bound; the true fix (a
   runtime-emitted per-work heartbeat) is not implemented.
4. Pre-existing and untouched: frameless-maximize geometry, composer fit at real
   breakpoints, live vendor windows/quota clocks, packaged Electron boot, SAIPEN
   conformance `CURRENT_FAIL`; F8's five Core-owned locale surfaces still carry the stale
   digest; F9 (`locale_readme_paths`) reported, not repaired.

## 9. Intentionally deferred edge cases (with exact reason)

1. **Replace the source-regex half of the UI suite with behaviour** (779 assertions / 186
   suites): a test-quality programme, not one of the four defects. The two data-loss-path
   suites (`zaicodeT224PastedTextEdit`, `zaicodeT223SaveAllCoverage`) are named as the
   first targets.
2. **Chaos-test the router supervisor against a flapping stub**: no such harness exists;
   building one is new test infrastructure, outside these four defects.
3. **Electron stub for the main-process suites**: needs a new stub module; these defects
   touched the main process only in T-232, already behaviour-tested at the pure boundary.
4. **T-235's `removeZaicodeGoalSawRunning` / `zaicodeGoalSawRunning` were not exercised
   against a real second owner instance** — there is none by design, so the
   "multiple observers" safety rests on unit-level claim atomicity plus the single-mount
   source assertion. Stated plainly: this is not a production race test.

## 10. SAIPEN ledger updates

- T-234, T-235, T-236, T-237 — added, claimed, and closed `own_patch` through
  SCOUT → BUILD → VERIFY → REVIEW → SHIP → DONE.
- T-229 (deep-audit parent) — closed `own_patch` after appending §11 (the four follow-up
  defects, the disposition of §9, the unchanged residual), §11.3 (corrective evidence) and
  §12 (focused verification) to the ledger.
- T-230, T-231, T-232 — closed `own_patch` (repairs already in the working tree; focused
  suites re-run this pass).
- Corrective evidence appended, not erased: T-222's DONE line is unchanged, but ledger
  §11.3 records that its "supervise until terminal" claim was false of the product until
  T-235; T-231's DONE line is unchanged, but §11.3 records that its audit was the queue
  half only, the crash-resume half being T-237.
- No operator/manual gate was closed. BOARD `## TODO` and `## DOING` are empty; goal
  `goal-0f1e92d1031c9389` drained to `goal_tickets 0`.
