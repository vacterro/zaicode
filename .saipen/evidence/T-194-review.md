# T-194 independent REVIEW re-run

Reviewer: saipen-cli (REVIEW phase, WAVE 0 of audit/ZAICODE roadmap 20261004_0045).
Subject: frozen `T-194-subject-final.json` (49 owned paths, base `c21dfde1`).

## Independent gate re-run (live tree, not VERIFY's claims)

| Gate | Claimed by VERIFY | Re-run here |
| --- | --- | --- |
| Full repository suite | 1474 PASS / 2 skipped / 0 FAIL | 1476 collected, 1474 pass, 2 skipped, 0 fail, exit 0 (`/tmp/t194-review-tests.log`) |
| Root typecheck | exit 0 | exit 0 (`/tmp/t194-review-tsc.log`) |
| Root lint | 162 warnings / 0 errors | 162 warnings / 0 errors, exit 0 (`/tmp/t194-review-lint.log`) |
| Architecture | 0 violations | OK, violations 0, baseline 0, new 0 (`/tmp/t194-review-arch.log`) |

Subject identity after gates: all 49 owned paths match their frozen SHA256
exactly. Foreign drift: exactly one path moved,
`packages/ui/src/zaicode/zaicodeSettingsDefaults.json` (the live operator
settings export), consistent with the T-196 precedent (E-3190): the running
app writes it during the operator session. New bytes preserved, excluded from
T-194 staging; the other 17 foreign hashes are unchanged.

## Oracle-movement check (VERIFY-ORACLE-01)

Modified test files were inspected against the SRC-129 requirement text:
project-click semantics, window-start proof, stall/background semantics and
the deadline oracle changed because the requirements changed (SRC-129:R002,
R005, R006 and the T-188 window-start boundary), not to hide failures. Each
behavioural flip carries its pre-fix FAIL control in the frozen evidence
(`T-194-deadline-red.txt` 1FAIL/5controls, `T-194-ui-red-final.json`
28FAIL/17controls), and the current suite still exercises both directions
(retained positive controls). No skipped or deleted test was found in the
owned diff; no TODO/debugger/console noise in owned additions.

Deadline RED control is reproducible from
`.saipen/evidence/T-194-deadline/continuation-before.ts` (the exact pre-fix
file bound by `deadlineRegression.before`).

## Findings

- P0/P1: none.
- P2/P3: none new. The empty-suffix `Working for` case and the preset-restart
  P0 are separate reports (wave 1 intake), not T-194 regressions; T-194
  evidence explicitly covers only known-state durations.

## Memory promotion

NO. Nothing decision-bearing and non-cheap beyond what existing cards hold.

## Verdict

DEC: SHIP. Publish exactly the 49 owned paths in the separate `zcode`
repository; preserve the 18 foreign paths (incl. the live settings export).
