# Board

<!-- Same checkbox ticket shape as Core (RFC section 1.2), never the OUTBOX.md
     bold-field shape (PROTOCOL.md section 2) -- that shape is for the deliverable
     leaving via OUTBOX, not for this board. Example, shown without its
     leading "- " so nothing parses it as a live ticket (a validator reading
     this file does NOT skip HTML comments):

       [ ] HUNT-001 short description | critical: true

     Real lines start with "- ", and use your own ID prefix (PROTOCOL.md
     section 3), never Core's T-###. -->

<!-- BOUNDARY: this is YOUR board. The main project has its own BOARD.md
     elsewhere -- never touch it directly, never write a ticket there
     yourself. Findings leave through kitchen/OUTBOX.md only; the main
     agent folds them into its own BOARD.md when it runs `saipen sub
     collect`, never the other way around. -->

## DOING

## TODO

## DONE
- [x] HUNT-001 six-signal sweep of the ZAICODE export surface: 3 dead-code removals, no behavioural defect | critical: false
- [x] HUNT-002 six-signal sweep at workspace 4e213552 / zcode 1cbb0921: Save All allowlist vs read-path symmetry gap, one REPRODUCED defect class | critical: false
- [x] HUNT-003 sweep at fingerprint f96332c0: HUNT-002's exclusion rationale for four profile-durable families is falsified by the profile list | critical: false
- [x] HUNT-004 sweep at fingerprint f413c6fb: three REPRODUCED unconsumed-or-contradicted decisions (the goal supervisor's budget/detach rules have no production caller; T-231's rationale names the crash resume wrongly; zaicodeAutoSendAllowed has no non-test caller), plus HUNT-003's Save All payload carried forward after its package went stale | critical: false

## BLOCKED
