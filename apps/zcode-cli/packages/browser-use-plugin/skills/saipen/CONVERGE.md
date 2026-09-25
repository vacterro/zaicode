# saipen CONVERGE — the convergence contract

`cc` does not mean "do a bit more work". It means: take this project from
wherever it is to a state where nothing known is left undone, and prove it.
This document is the ONLY place that sequence is defined.

**Read it when `execution_intent: converge` is set, or when a command routes
here.** Nothing else in the protocol may restate the sequence below — `hunt.md`,
`clean.md`, `done.md` and `prepare.md` reference this file by name and describe
only their own step. That split is the point: the lifecycle was previously
implied by five documents that each knew one hop, so no single reader could
answer "what comes after CLEAN?" without assembling it, and two agents assembled
it differently.

converge_targets: done | ship | crew

## The sequence

Stages run in order. A stage that produces work does not skip ahead — it returns
to the stage named in its own return rule, and the sequence resumes from there.

`converge_target` preserves which closure the user requested. Absent or `done`
is plain `cc`: run A-M. `ship` is `ccc`: LOG
`DEC: ccc converge target -> ship @<pre-SHIP-source_head>`,
run A-I, execute normal REVIEW/SHIP gates, and only after successful SHIP resume
at J so K/L/M bind to the shipped HEAD. This is the **CCC SHIP boundary between
I and J**. `crew` is `sc`/`saipen crew`: the serial full-platoon convergence
circuit (SC-0..SC-13), whose fixed point is the whole built-in crew — the
circuit is defined ONCE in `extensions/subs/crew.md` and mechanically in
`tools/saipen_engine/subs.py`'s `CREW_STAGES`, and this document does not
restate it. While `crew` is active, `cc` resumes the crew, not ordinary
convergence; the ordinary A-M sequence is the `sc`-internal stages it already
reuses. A crash keeps the field; it cannot silently resume as plain `cc` and
prepare K/L before SHIP. Clear the field only when the convergence intent clears.

**A. RECOVER.** Repair invalid or stale `STATE.md`/`BOARD.md`/`LOG.md` before
any work, per CORE.md § 1.5. This is first because every later stage reads the
state it would otherwise corrupt further.

**B. FINISH CURRENT WORK.** A `## DOING` ticket is finished or honestly blocked,
never abandoned — CORE.md § 1.11's FINISH priority already governs which.

**C. EXHAUST REAL BOARD WORK.** While a workable `## TODO` ticket exists (the
halt definition is MAINTENANCE.md § 2.1's, not a second one), run the Core chain
for it and take the next. No pause between tickets unless a genuine `WAIT:` or
`BLOCKED` condition needs the user or an external fact. **Do not invent an
objective and do not run `ADD`.** Convergence finishes what exists; inventing
work is the one way a converge run can never terminate.

**D. COLLECT ACTIONABLE SUBSAIPEN RESULTS.** Before believing the board is
empty, inspect active SubSaipen OUTBOXes. Collect only roles whose declared
`collect_policy` permits it, after the freshness and boundary checks
`extensions/subs/PROTOCOL.md` defines. A scout or fixer finding becomes ordinary
Core work — return to C. **Producer packages (`saitranslate`, `saiwiki`) are
never auto-collected here.** They are prepared at K and L and integrated only by
an explicit `eee`/`qqq`; a converge run that consumed its own factories at this
stage would invalidate the packages it is about to build.

**E. CANONICAL TEST / VALIDATE GATE.** Run the project's full applicable test
and conformance gate. Any failure is ticketed and returns to C. Inspection is
not PASS. Skipped is not PASS. Timeout is not PASS.

**F. FORCED HUNT.** Run a real `HUNT` (`phases/hunt.md`). **An existing
`hunt -> clean @HASH` marker does not satisfy this stage** — an explicit
convergence claim needs evidence produced by this run, not by an earlier one.
Findings are ticketed and return to C, after which E and F both run again.
In validator terms: an existing hunt -> clean marker cannot satisfy forced HUNT.

**G. CLEAN.** Only after F is clean. `phases/clean.md` owns what may be mutated
and what may not. Ambiguous or destructive cleanup produces an exact ticket or a
`WAIT:` — never a silent deletion, and never a step forward to the factories.

**H. POST-CLEAN TEST GATE.** CLEAN mutates files, so E's result no longer
describes the tree. Re-run it. Failure returns to C.

**I. FINAL FORCED HUNT.** Run `HUNT` again, after CLEAN and after H passed.
This is the closure sweep, and it is the last stage that may find work: anything
it reports returns to C. With `converge_target: ship`, successful I routes to
normal REVIEW/SHIP and then J; it MUST NOT execute J, K, or L before SHIP.

**J. SUBSAIPEN FACTORY SYNC.** Only now, `saipen sub sync` — refresh inherited
role charters and detect role drift, touching no live SubSaipen
`STATE`/`BOARD`/`LOG`/kitchen. Any producer whose recorded role revision is now
stale is not fresh.

**K. FRESH EE.** Force a current translation preparation. An earlier ready
package is not reusable merely because `HEAD` is unchanged.

**L. FRESH QQ.** Then the same for the wiki. EE before QQ, in that fixed order,
unless a future change proves parallel preparation safe.

**M. FINAL FRESHNESS CHECK.** Both producer packages must be `status: ready`,
produced after I, bound to the current source fingerprint and role revision,
internally verified, and written outside the main tree. **This stage runs
`tools/validate.py --gate converge`** — the one gate under which a missing,
unready or stale EE/QQ package is a hard FAIL. Nothing earlier in this sequence
runs it, and nothing earlier may: producer readiness is a closure requirement,
not a precondition for the Core work in stages A–I (T-568). Then: write the
closing LOG evidence, clear `execution_intent` back to `normal`, enter `DONE`,
and name in the report every package still waiting on an explicit `eee`/`qqq`.

## The ordering rule

**Nothing that mutates main source may run after K.** Every stage from A to I
can change the tree; a package prepared before a later mutation describes a
project that no longer exists, and it will still look ready. This is why the
factories are last and why `ccc` ships BEFORE regenerating them rather than
after — a commit and tag change the source revision that freshness binds to.

## The closure bar

`cc` may report DONE only when every one of these holds. They are conditions,
not a checklist to skim: each one is a way a run has previously claimed
completion it had not reached.

- no `## DOING` ticket;
- no workable `## TODO` ticket;
- no unresolved actionable Core finding;
- no untriaged `[MARKHUNT]` finding;
- no unresolved blocker preventing project closure;
- no fresh critical scout or fixer OUTBOX awaiting Core review;
- canonical tests PASS against the tree as it stands after the last mutation;
- canonical validator PASS against that same tree;
- CLEAN completed, or proved nothing safe remained to do;
- the final forced HUNT after CLEAN came back clean;
- the working tree is fully attributed — every change belongs to a ticket;
- `saipen sub sync` completed;
- the EE package is fresh and ready;
- the QQ package is fresh and ready;
- both packages match the current source fingerprint;
- both match the current role revisions;
- no main mutation happened after they were prepared.

Four things that are NOT closure, each of which has been offered as one:
"nothing obvious remains", "`HEAD` is unchanged", "a ready package already
exists", and "tests passed before the cleanup".

## How the crew gate proves E-I is current

This document owns the sequence; the mechanical proof that the sequence is
CURRENT against one source identity is owned once, by the shared read-only
convergence verdict (`saipen_engine.convergence.convergence_verdict`), which
SC-7 and `--gate crew` consume. Every executed stage records a structured
`convergence_stage` receipt (E/F/G/H/I, closed verdict, bound to the live
source identity; CLEAN also binds its input and resulting identities) through
the public `record_convergence` operation. The verdict requires the ordered
terminal chain E,F,G,H,I with consistent identities, the current tree equal to
I's identity (no mutation after the final HUNT), and a fully attributed
working tree. `phase: DONE` + an empty workable board is NEVER this proof;
missing or stale proof keeps SC-7 red with `CONVERGE_CORE`.

## What this document does not own

The phase mechanics belong to the phase docs, the command rows to CORE.md
§ 1.10, the intent enum and its safety valve to MAINTENANCE.md § 2.4, the
SubSaipen lifecycle and freshness algorithm to `extensions/subs/PROTOCOL.md`,
and each role's own behavior to its `sai*.md` charter. This file owns the ORDER
and the closure bar, and nothing else.
