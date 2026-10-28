# Phase: REVIEW

## Entry and reads

Review the current wave/ship diff. Under `mode: manual-verify`, request a human
review verdict and do not auto-transition. If
`.saipen/extensions/performance/` (or legacy `extensions/performance/`)
exists, load its required benchmarks first.

## Independent evidence

**Re-run the ticket's own `verify:` here; do not read VERIFY's claim of it.**
LOG this run. Disagreement is a finding: the tree changed, the verifier is
unstable, or the claim was false. Prove every suspicion with trace/repro and
report `file:line + what breaks`.

Agreement is not one either, on a bug fix. Re-running the same verifier
reproduces a weakened one exactly as faithfully as a sound one, so ask what the
diff did to the CHECK: did any test, fixture, oracle or verification command
move; if so, on what independent grounds; does the pre-fix FAIL belong to the
verifier now passing (`VERIFY-ORACLE-01`, phases/verify.md); and can this
verifier still see the original bug. "All tests pass" answers none of those.

Classify:

- P0 correctness/data loss and P1 security: fix now, route to BUILD.
- P2 reliability and P3 maintainability/tests: create follow-up tickets.

Run one bounded memory-promotion check after independent evidence exists:
did this Work reveal a verified, reusable, decision-bearing, non-cheap,
non-duplicate, non-transient, safe lesson? Usually NO. If YES, upsert normally
one structured card or explicitly supersede the old card; never write a card
merely because Work finished.

Verdict is `DEC: SHIP`, `SHIP after FIXES`, or `NO -- BLOCKER`.

## Retry cap

One finding gets two review passes, identified by `file:line`: pass one finds,
BUILD fixes, pass two rechecks. Still broken on pass two means
`NO -- BLOCKER`; canonically block that ticket and continue another workable
ticket. A genuinely new finding gets its own budget. Record the count in
`review_passes:`; do not count from memory. MAINTENANCE owns the global
goal-run continuation and caps.

## Exit

When P0/P1 are clear, enter SHIP. REVIEW has no DONE branch. The passed ticket
**stays in `## DOING` through SHIP -- do NOT close it**; publication has not
happened. Emit `PHASE SHIP T-###`. Atomic finish moves it to DONE only after
SHIP succeeds.
