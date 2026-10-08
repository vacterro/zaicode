# T-220 / SRC-150 + SRC-151 — clause dispositions

Group 1 (R002..R012, R040) was built in the BUILD phase and re-checked on the real tree in
the VERIFY pass. Every row below reads `MACHINE_GATES_PASS; MANUAL_PENDING`: the machine
gates genuinely passed (typecheck 0 errors, lint 165 warnings / 0 errors, architecture 0
violations, ui 1109/1109, desktop 246/246, services 100/100 — re-run 2026-10-05), and the
visual acceptance is **not** claimed here. See `manual-verify-steps.md` for why and for the
per-clause steps.

The 32 rows not in Group 1 keep their original intake dispositions untouched. They have not
been built or checked and must not be read as either.

| Requirement | Source line | Disposition | Historical work | Current check |
|---|---:|---|---|---|
| REQ-001 | 3 | VERIFIED | — | MACHINE_GATES_PASS; receipt ok:true (`.saipen/evidence/T-220/packaged-outage-2026-10-05T03-09-17-171Z/receipt.json`); MANUAL_PENDING: screenshot attribution only |
| REQ-002 | 5 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-003 | 7 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-004 | 9 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-005 | 11 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-006 | 13 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-007 | 15 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-008 | 17 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-009 | 19 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-010 | 21 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-011 | 23 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-012 | 25 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-013 | 28 | DUPLICATE | T-190, T-217, T-216 | NOT_RUN |
| REQ-014 | 30 | DUPLICATE | T-217 | NOT_RUN |
| REQ-015 | 32 | DUPLICATE | T-217 | NOT_RUN |
| REQ-016 | 34 | DUPLICATE | T-217 | NOT_RUN |
| REQ-017 | 36 | DUPLICATE | T-217 | NOT_RUN |
| REQ-018 | 39 | DUPLICATE | T-217, T-201 | NOT_RUN |
| REQ-019 | 41 | DUPLICATE | T-217 | NOT_RUN |
| REQ-020 | 43 | DUPLICATE | T-217 | NOT_RUN |
| REQ-021 | 45 | DUPLICATE | T-217 | NOT_RUN |
| REQ-022 | 47 | DUPLICATE | T-217 | NOT_RUN |
| REQ-023 | 49 | DUPLICATE | T-217 | NOT_RUN |
| REQ-024 | 51 | DUPLICATE | T-217 | NOT_RUN |
| REQ-025 | 54 | DUPLICATE | T-209, T-212 | NOT_RUN |
| REQ-026 | 58 | USER_CHECKED_OFF | T-208 | NOT_RUN |
| REQ-027 | 61 | DUPLICATE | T-206 | NOT_RUN |
| REQ-028 | 63 | DUPLICATE | T-205 | NOT_RUN |
| REQ-029 | 65 | DUPLICATE | T-204 | NOT_RUN |
| REQ-030 | 67 | DUPLICATE | T-203 | NOT_RUN |
| REQ-031 | 69 | DUPLICATE | T-202 | NOT_RUN |
| REQ-032 | 71 | DUPLICATE | T-201, T-217 | NOT_RUN |
| REQ-033 | 73 | DUPLICATE | T-200 | NOT_RUN |
| REQ-034 | 75 | DUPLICATE | T-199 | NOT_RUN |
| REQ-035 | 77 | DUPLICATE | T-198 | NOT_RUN |
| REQ-036 | 79 | DUPLICATE | T-197 | NOT_RUN |
| REQ-037 | 82 | USER_CHECKED_OFF | — | NOT_RUN |
| REQ-038 | 84 | DUPLICATE | T-217 | NOT_RUN |
| REQ-039 | 88 | USER_CHECKED_OFF | — | NOT_RUN |
| REQ-040 | 90 | BUILT | — | MACHINE_GATES_PASS; MANUAL_PENDING |
| REQ-041 | 93 | DUPLICATE | T-190, T-217, T-216 | NOT_RUN |
| USER-CHECKED-OFF-L056 | 56 | USER_CHECKED_OFF | — | NOT_RUN |
| USER-CHECKED-OFF-L086 | 86 | USER_CHECKED_OFF | — | NOT_RUN |
| USER-CHECKED-OFF-L095 | 95 | USER_CHECKED_OFF | — | NOT_RUN |

## Blocking gates

- E-3772: operator explicitly selected current local checkout instead of missing exact snapshot; T-220 is active under saipen-cli. T-166 remains preserved on external vendor-clock wait.
- Packaged desktop router-outage scenario EXECUTED: `.saipen/evidence/T-220/packaged-outage-2026-10-05T03-09-17-171Z/receipt.json` ok:true (fallback exercised, safe return, 0 paid requests). Remaining open item: original screenshot runtime attribution.

## Producer index caveats

- Raw checked-off lines 56, 86 and 95 are missing from producer requirement index.
- Media 025, 033 and 034 belong to these checked-off source lines, not new acceptance for REQ-025, REQ-038 and REQ-041 respectively.
- Bundle manifest build revision identifies FastPrompter producer, not screenshot ZAICODE runtime.
