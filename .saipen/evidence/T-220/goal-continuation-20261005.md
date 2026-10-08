# /goal cc all continuation 2026-10-05 (T-220 VERIFY + T-222/T-223 created)

## Tickets (canonical checkpoints, no hand edits)
- T-222 Auto Goal supervisor (owns SRC-153 R002-R003). TODO.
- T-223 Save All / ProTrail snapshot (owns SRC-153 R004). TODO.
- T-220 VERIFY retains R001, R005..R017.

## T-220 machine work completed this run
- E2 audit admission: smartSweep returns [] when autoWaves is off -- zero
  automatic campaigns, zero resumed plans, manual start/work/Continue and /a3
  unaffected, running work untouched. Panel copy states the stronger contract.
  Red: 3 new E2 tests failed pre-fix (36: 33 pass/3 fail); green post-fix.
- D connection presence: one pure projector (working/reconnecting/fallback-
  active/waiting-retry/waiting-quota/offline/idle) over supervisor + ledger +
  quota wall + halted; composer mini and sidebar row read the same function.
  9 focused tests green. No new timers (existing 15s router poll feeds it).
- E1 accounts: merge-level convergence proof -- second same-vendor account adds
  exactly one distinct ready row; removal leaves no stale duplicate; ids stable
  across refreshes (no work migration); bound documented as bounded polling
  (default intervalMinutes 5 + sweep; on-demand IPC refreshZaicodeEngines).
  4 new tests green (file 16/16).
- E3 composer overlap: R002 responsive work did NOT cover the 301px geometry
  (box-width metric blind to wrapped-child overflow) -> BUILD applied:
  furthest-child-extent measurement in useComposerToolbarFit. The 2 formerly
  failing fit tests now pass; file pair 8/8.

## Gates (zcode root, exit codes captured, no pipe masking)
- typecheck exit 0; lint 165 warnings/0 errors exit 0; architecture 0 violations.
- ui 1132/1132 exit 0; services 103/103 exit 0; desktop 246 pass/0 fail exit 0.

## T-166 re-arm condition (deterministic, no operator question)
Retry only when ALL hold: (a) the Playwright teardown defect is repaired so the
page survives past a roll boundary; (b) the next real vendor rolling-window
boundary is known and the deadline is computed from it; (c) the run targets the
already-rolled end state or a live transition with new information. Until then
T-166 stays OPEN/BLOCKED_ON_LIVE_ACCEPTANCE. No duplicate run (receipt ok:false
is harness failure, adjudicated 2026-10-05, neither product PASS nor FAIL).

## Operator checklist (the ONLY remaining T-220 items; nothing else to decide)
1. Launch the exact current packaged build (dist with T-220 + this run).
2. Open the project from the SRC-153 R001 screenshot.
3. Click Auto Retry OFF -> ON; visible AND effective state must change.
4. Click ON -> OFF; visible AND effective state must change.
5. Reload/restart; persisted state must match.
6. Report PASS or the exact mismatch (screenshot + effective label text).
Manual Group-1 visuals (E4) per manual-verify-steps.md as before.

## Addendum (second /goal pass): button simplification
- Removed the obsolete editing-scope cycler from the composer pill (it switched
  a scope that no longer governs the toggle) and the manual onKeyDown handler
  (native button activation already fires onClick; the handler risked a Space
  double-fire). Pill is now a static effective-scope readout; Inherit stays.
- Focused retry tests 12/12, typecheck 0, full ui 1132/1132 post-change.
- T-222 claim refused ALREADY_CLAIMED (DOING holds T-220 VERIFY): T-222/T-223
  remain TODO until T-220 leaves VERIFY. No state hand-edited.

## Addendum (evidence hygiene): manual-verify-steps.md corrected
- Gate table updated to current counts; cross-refs to this file + SRC-153
  ledger added; stale R007/R008/R009 rows replaced with E1/E2/E3 acceptance;
  new R005/D presence row and R001 click-truth row added. All rows stay
  MANUAL_PENDING -- nothing converted to PASS. No product code touched.

## Addendum (T-222 BUILD): supervisor core + composer wiring
- New `zcode/packages/ui/src/zaicode/zaicodeGoalSupervisor.ts`: idempotent
  intent registration (project+session+objective), authoritative observation
  folding (active/recovering/waiting/blocked/complete/stopped), send/no-send
  gate with 20-continuation budget, explicit STOP priority with no
  resurrection, mid-run detach parking, compact readout, live version hook.
  No timers, no scheduler (guarded by test).
- Wired: composer registers one intent per Auto Goal submit
  (`ConversationComposer.tsx`), STOP stops intents, Auto Goal button shows the
  live supervised state (`ZaicodeAutoGoalButton.tsx` + sessionId).
- Tests `zaicodeT222GoalSupervisor.test.ts`: 11/11 green. Red control: suite
  fails with the module removed; 7/8 pre-fix on the overbroad scheduler
  regex (fixed to call-shaped patterns with cause stated).
- Gates: typecheck exit 0; lint 165/0 (one new spread warning fixed at cause);
  arch 0 violations.
- Open T-222 remainder (per ticket): observation feed from live session briefs
  (goalStatus mapping), restart re-derivation, queue-persistence proof,
  provider/compact/fallback survival tests, packaged acceptance.

## Addendum (T-222 BUILD-2): observation feed from live briefs
- `mapBriefToGoalObservation` + `observeZaicodeGoalFromBrief`: SAIPEN
  goalStatus decides (active=open, complete=terminal, budget_limited=real
  blocker, paused=parked); waiting-without-running reads Goal waiting;
  manually-stopped sessions manufacture no intent; fresh boot with a named
  objective re-registers the SAME deterministic intent (restart survival).
- `useZaicodeGoalObservationFeed` mounted once per composer; briefs drive it.
- Tests 16/16 green. Gates: typecheck 0, lint 165/0 (one unused-var fixed at
  cause by asserting intent identity), arch unchanged.
- SRC-154 captured (9 clauses, 4 DUPLICATE); T-224 TODO owns R001-R005.
