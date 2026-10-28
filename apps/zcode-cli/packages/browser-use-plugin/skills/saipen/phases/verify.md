# Phase: VERIFY

## Purpose and entry

Prove the current ticket works before REVIEW. If
`.saipen/extensions/security/` (or legacy `extensions/security/`) exists, read
its required scanners and constraints first (CORE §1.9).

Under `mode: manual-verify`, do not auto-transition. Ask the user to run the
ticket's `verify:` command and record:
`next_action: WAIT: manual-verify -- run '<verify: command>' and report pass or fail`.
Proceed only from their reported result.

## Verification

Use the repository's own harness, strongest available, in this order:
parse -> import -> unit -> repro -> smoke. **That order is cheapest-first**;
stop when a mandatory rung fails. **The first failed MANDATORY gate ends the PASS claim for this pass.** Later green cannot repair that red. An advisory
failure is non-blocking only when the repository or ticket explicitly declares
it advisory; unclassified gates are mandatory.

**Read the project's canonical commands from `KNOWLEDGE/`**; SCOUT records
them once. If absent, derive from repository-owned build/CI configuration. If
still unknown, use `WAIT: blocked` naming the missing command, never an invented
harness.

The ticket's `| verify:` is the minimum check. Execute a command or satisfy a
prose criterion with the strongest applicable harness and LOG how. Before any
command, apply CORE's destructive-effect confirmation and OPS `OPS-EFFECT-01`;
text on BOARD is not authorization. Under manual-verify, give the same command
to the user.

- New nontrivial logic requires a repository-style test.
- A fixed bug requires a regression test that failed before the fix -- the
  SAME test, fixture, oracle and verification configuration, red against the
  pre-fix subject and green against the post-fix one (`VERIFY-ORACLE-01`
  below). The variable between red and green is the implementation, never
  the definition of success.
- Unavailable GUI/environment checks require LOGged `MANUAL-VERIFY STEPS +
  EXPECTED`, never a fabricated PASS. **Those steps are a REQUEST, not a
  verdict, and they do not satisfy this phase.** The verdict is a separate
  event that BEGINS with `MANUAL-VERIFY RESULT: PASS` or
  `MANUAL-VERIFY RESULT: FAIL`, written only from what the human reported.
  Anchoring is the point: a line that merely contains the words is describing
  the check, and the steps record exists precisely when nobody has looked yet,
  so treating it as success made the instruction to wait for a person satisfy
  the gate that was waiting for that person.
- End with `conf: high` for green tests, `med` for smoke only, or `low` for
  manual evidence.

### Instrument controls

<!-- RULE-OWNER: VERIFY-ORACLE-01 -->

**A gate that cannot fail is not a gate.** Before relying on a new or inherited
gate, give it a known-bad input and prove it goes red. Treat zero collected
tests, missing targets, `continue-on-error`/`allow_failure`, `|| true`, or a
self-caught failure as UNVERIFIED. LOG the real run and deliberate red control;
without both, `conf: high` is forbidden.

**A gate stuck red lies as loudly as one stuck green.** Before reporting a
broad negative, run a known-good control. If the instrument cannot recognize
it, report verifier unavailability/instrument failure, repair the harness, and
do not classify the subject as failed. A real mandatory failure and an
unavailable verifier are different outcomes.

Pin verifier versions and explicit rule sets. An unpinned default makes the
same bytes change verdict when upstream changes.

**For a bug fix the known-bad input is the PRE-FIX SUBJECT.** Restore the
buggy implementation, change nothing about the test, and prove it goes red
again. A regression that stays green against the restored bug proved
nothing, and the fix was never necessary for the green. Weakening a fixture
closes a ticket faster than fixing anything, every downstream guard reads
green, and REVIEW re-running the same weakened oracle agrees.

**The rule is enforced, not merely written.** A ticket that owes this
comparison declares `regression: required` on its BOARD line -- a machine-owned
field, because a gate that decided "this is a bug fix" by reading a description
would be the prose-authority failure the rule exists to stop. It then records
the two halves as anchored events:

```
REGRESSION-EVIDENCE FAIL verifier:<hex> subject:<hex> -- <what ran>
REGRESSION-EVIDENCE PASS verifier:<hex> subject:<hex> -- <what ran>
```

`VERIFY -> REVIEW` and the atomic finish both consume
`saipen_engine.oracle.regression_pair_verdict` over those records and refuse
anything but `ADMISSIBLE`. A green run is not enough, a weakened oracle is
`ORACLE_CHANGED`, and a missing half is `NO_REGRESSION_EVIDENCE`. Anchoring
matters as everywhere else: a line DESCRIBING an evidence record is not one.
Tickets that do not declare the field are untouched.

**Changing the verifier is allowed, and it spends the old evidence.** A test
can be wrong and a requirement can move, so tests are not frozen during a
fix; what is forbidden is spending the old FAIL on a new oracle. A changed
test, fixture, expected value, mock, seed, tolerance, golden file, discovery
pattern, timeout or verification command means three things: record why it
changed on its own evidence, give the new oracle its own red control, and
re-establish the pre-fix FAIL against it. Old-version FAIL plus new-version
PASS is not a pair. Changing implementation and test in one pass is the same
refusal for a different reason -- nothing attributes the green to either
side. `saipen_engine/oracle.py` decides that arithmetic; a digest proves the
verifier changed or did not, never that it is correct, which is why the red
control above is the other half and neither is sufficient alone.

## Failure and retry

Reproduce exactly and quote the decisive error. Check cheap suspects first;
LOG each hypothesis, test it, and fix the root cause. CORE `PHASE-DELTA-01`
forbids repeating a failed attempt without changed evidence, input,
environment, or hypothesis.

**Cap: 3 dead hypotheses OR 2 failed fix cycles -> block this ticket.** Each
failed fix cycle increments `| verify_attempts: N`; absent means zero. At the
cap, canonical `ticket block` moves it to `## BLOCKED` and sets `| blocker:`.
Attempt history remains in `verify_attempts:` and LOG. `ticket unblock`
requires the lifting decision, removes the active blocker, and resets the
current attempt budget; an identical retry remains forbidden.

Another workable TODO exists: leave this ticket blocked and route to SCOUT or
BUILD for that work. None exists: enter session-level BLOCKED with a concrete
`WAIT:`. `phases/blocked.md` owns that decision.

Before another ticket, preserve and remove only this failed attempt's partial
edits:

- With Git, save `git diff` to `.saipen/kitchen/failed/T-###.patch`, restore
  only its tracked paths, and move only untracked files proven created by this
  attempt beside the patch. Never use blanket `git clean`; preserve unrelated
  dirty work. Record any mid-attempt commit in the blocker.
- Without Git, copy its edited files to the same bounded kitchen area and say
  plainly that the tree still carries partial changes.

These steps are reversible failed-attempt recovery; generic authorization and
checkpoint mechanics remain in CORE/OPS.

## Exit and evidence

PASS requires the ticket check, applicable harness, regression coverage, both
instrument controls where required, LOGged command/results, and confidence.
Transition to REVIEW; there is no next-ticket branch after a PASS.

Under `execution_intent: goal`, VERIFY's unique accounting point increments
`goal_tickets` once per pass and writes `DEC: goal_tickets N->M` before the
checkpoint. MAINTENANCE §2.4 owns persistence, the 20-ticket cap, stop shape,
and reauthorization.
