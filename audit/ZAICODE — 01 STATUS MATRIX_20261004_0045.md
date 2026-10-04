# ZAICODE — SILO GAP STATUS MATRIX
Snapshot reviewed:
- Wishlist bundle: `silo_bundle_20261004_003004.zip`
- ZAICODE audit snapshot: `_ZAICODE_04.10.26-T00-35-27.zip`

IMPORTANT EVIDENCE LIMITATION

The supplied ZAICODE archive is an AUDAPACK-style audit representation and does
not contain the nested `zcode/` product source repository itself.

This status matrix is therefore based on the current SAIPEN BOARD/STATE/LOG and
the ticket evidence carried in the archive. Do not pretend this is an
independent line-by-line source audit.

CURRENT MACHINE TRUTH

- STATE: REVIEW T-194.
- Safety valve is active after 20 goal tickets.
- T-194 implementation evidence is complete and independently reviewed/published
  only remains pending.
- T-197 through T-206 are explicitly preserved as independent unimplemented
  requests.
- T-190 remains TODO but substantial overlapping Scheduler behavior is already
  implemented inside the current T-194 candidate and must be reconciled rather
  than rebuilt.
- T-191 is DONE and added running/completed session duration presentation, but
  the newly reported empty `Working for` state is a separate uncovered defect.

STATUS BY WISHLIST ITEM

1. WORKERS expanded/collapsed state appears to have no effect
STATUS: NOT RECORDED / NOT PROVEN IMPLEMENTED.
No current ticket in this snapshot directly covers the new 23:54 report.
Treat as a new runtime UI defect.

2. Session can show `Working for` with no duration
STATUS: NOT PROVEN FIXED.
T-191 added valid duration rendering for known running/completed states, but the
new screenshot proves an uncovered missing/invalid timestamp edge case.
Treat as a new regression.

3. P0: applying Settings presets must not restart ZAICODE
STATUS: NOT RECORDED / NOT PROVEN IMPLEMENTED.
Existing preset work and hot file discovery exist, but no current evidence proves
that applying every relevant preset is restart-free while active sessions/workers
continue.
Treat as a new P0 lifecycle defect.

4. Move irrelevant Settings sections down; make secondary sections collapsible
and collapsed by default
STATUS: TODO T-206 / SRC-140.
NOT IMPLEMENTED in the reviewed snapshot.

5. Usage panel: refresh choices 10/5/3/2/1 sec, remove redundant Done text,
resizable model/metric columns
STATUS: TODO T-205 / SRC-139.
T-181 already improved Usage identity/presentation and live UI verification, but
these new controls are NOT implemented.

6. Composer Auto-Goal mode, per project, default ON, invisible `goal cc all`
attachment
STATUS: TODO T-204 / SRC-138.
NOT IMPLEMENTED.

7. Settings keyword/function search
STATUS: TODO T-203 / SRC-137.
NOT IMPLEMENTED.

8. WORKERS panel toolbar buttons can become unresponsive
STATUS: TODO T-202 / SRC-136.
NOT IMPLEMENTED.

9. Composer Auto Retry toggle with Session/Project/Global scope
STATUS: TODO T-201 / SRC-135.
NOT IMPLEMENTED.

10. If the last/only worker collapses, collapse the now-empty WORKERS panel too
STATUS: TODO T-200 / SRC-134.
NOT IMPLEMENTED.

11. Remove bright/white native-looking sliders and controls; make them theme-aware
STATUS: TODO T-199 / SRC-133.
NOT IMPLEMENTED.

12. Ctrl+Click subscription/readiness tiles to enable/disable scheduled Worker
eligibility
STATUS: TODO T-198 / SRC-132.
NOT IMPLEMENTED.

13. Unseen-completion indicator for newly finished project/session, cleared when
the operator visits it
STATUS: TODO T-197 / SRC-131.
NOT IMPLEMENTED.

14. Maximize token/cache efficiency
STATUS: IMPLEMENTED IN CURRENT T-194 CANDIDATE, REVIEW/PUBLICATION PENDING.
Current evidence proves deterministic provider-visible extension and built-in
tool ordering to keep identical prompt prefixes stable across reversed discovery.
Existing cache accounting/breakpoints are preserved.
Do NOT claim vendor cache-hit guarantees or paid warm-up behavior: current
evidence explicitly does not claim those.

15. Make project/session sidebar navigation obvious; project click must lead to
meaningful content rather than a confusing blank MAIN/session state
STATUS: IMPLEMENTED IN CURRENT T-194 CANDIDATE, REVIEW/PUBLICATION PENDING.
Evidence covers meaningful MAIN selection, empty-MAIN fallback prevention,
working-only filters, explicit fold chevron, and draft behavior for empty
projects.

16. Remove repeated useless `Iteration N · Goal incomplete, continuing`-style
presentation noise
STATUS: IMPLEMENTED IN CURRENT T-194 CANDIDATE, REVIEW/PUBLICATION PENDING.
Repeated not-satisfied goal-control notices and their empty turns are hidden
while errors, verification failures and successful completion are retained.

17. Show TEST activity separately from AGENT activity in projects/sessions and
support independent Highlights & Motion test indicators
STATUS: IMPLEMENTED IN CURRENT T-194 CANDIDATE, REVIEW/PUBLICATION PENDING.
Evidence covers live test-command projection, project/session/timeline TEST marks,
independent motion preferences, command tooltip and clearing on completion.

18. Fix stale Working state that can remain after a session has ended
STATUS: IMPLEMENTED IN CURRENT T-194 CANDIDATE, REVIEW/PUBLICATION PENDING.
Evidence proves ended foreground work cannot remain animated from stale phase
data, real quiet background work stays Working, and runtime death invalidates
local live reports.

19. Scheduler: detect vendor limits and continue later via SAIFREN/other selected
routes until subscription reset
STATUS: ENGINEERING PRESENT IN T-194 CANDIDATE; LIVE PAID-VENDOR RECOVERY NOT
CLAIMED.
T-194 evidence covers delayed vendor-limit handoff, ordered selected
subscriptions/in-app SAIFREN, fresh quota recovery, execution leases, restart
idempotency, cancellation and stop time.
T-190 remains TODO and should be reconciled against this evidence instead of
reimplementing the same scheduler.

20. Scheduler/Worker automation must not sit for hours behind `Trust all and
continue` hook prompts
STATUS: IMPLEMENTED IN CURRENT T-194 CANDIDATE, REVIEW/PUBLICATION PENDING.
Evidence covers recognized startup folder/hooks menus on owned live terminals
without run-age/answer-count cutoffs, including five-hour-old/repeated menus,
while retaining identity/generation/ownership safety checks.

EXECUTION CONCLUSION

Do not start by reimplementing items 14-20.

First:
1. finish T-194 REVIEW -> SHIP -> DONE if independent review still passes;
2. reconcile T-190 against T-194 and keep only a proven residual;
3. then execute the remaining gaps in the attached waves.

The new P0 preset lifecycle defect and the two new Worker/session regressions are
not represented by the existing T-197..T-206 queue and need canonical intake.
