# Phase: HUNT

## Purpose and entry

Run a bounded defect sweep. Autonomous eligibility is owned by MAINTENANCE
§2.1. Entered by explicit `saipen hunt` / `hh`? The cache **does not apply -- run the full sweep** regardless of BOARD or prior markers.

For autonomous entry, skip only when both conditions hold:

1. `git status --porcelain` prints nothing; and
2. LOG contains `hunt -> clean @<HASH>` for the exact current
   `git rev-parse --short HEAD`.

Dirty tree, absent/stale marker, unreadable Git, or no repository means run the
sweep. HEAD alone is not a worktree fingerprint; no mtime or substitute
heuristic is legal.

## Actions

If ephemeral read-only workers exist, dispatch the six categories as one
bounded batch and merge results. They are **EPHEMERAL WORKERS, not SubSaipen instances**: one assigned investigation, one returned result, then disappear;
never enter `MANIFEST.md`, never receive STATE/BOARD/LOG/kitchen or lifecycle state, and never mutate `.saipen/`. Otherwise run sequentially. Either route
uses this order and a five-ticket cap. **The cap is a batch size, not a
ceiling on completeness**: a pass that files the full five has not finished
looking. An explicit `hh` re-enters HUNT after the filed batch is worked off,
and keeps doing so until a pass files fewer than five, bounded by the goal caps
in MAINTENANCE § 2.4 rather than by a private counter. `aa`/MARKHUNT keeps its
own uncapped single-pass role; this is repetition, not the removal of a cap.

1. failing tests;
2. commits unverified in LOG;
3. stale TODO/FIXME/HACK;
4. silent failures: empty catches, ignored results, missing I/O errors;
5. symmetry gaps: save/load, undo/redo, import/export, start/stop, public
   parameters versus internal/UI surfaces;
6. dead code and orphan files, proven by references plus entry/config/docs.

Before filing, search every BOARD section, including BLOCKED. An existing
finding is not new. Classify new findings by priority and ticket them.

An ambiguous finding is never a reason to stop the sweep and never silently
dropped. Ticket it at the lowest priority with `AMBIGUOUS:` naming the exact
question. It stays workable when that question is answerable from evidence
inside the project; one that genuinely needs the operator moves to `## BLOCKED`
with the question as its blocker, which is where a run already parks work whose
answer it must not invent. Nothing here becomes a mutation that was not one
before: HUNT still deletes, moves and renames nothing, and CLEAN keeps every
destructive path and its confirmation boundaries.

Small obvious work may route to SCOUT, otherwise PLAN.

**HUNT deletes, moves and renames nothing.** It detects, classifies, tickets,
and reports. Its only mutations are canonical BOARD/LOG/STATE bookkeeping.
CLEAN alone owns proven-safe hygiene mutation, deletion recovery proofs,
mass-deletion limits, move reference sweeps, and confirmation boundaries.
MARKHUNT owns explicit exhaustive uncapped audit and unvetted finding brakes.

`.saipen/kitchen/` and every present
`.saipen/extensions/subs/<name>/kitchen/` are detection surfaces only. Apply
CLEAN's Core-kitchen definition and SubSaipen PROTOCOL §6's five-class stale
verdict; age or repeated collection is not proof. Ticket candidates for CLEAN.

## Exit and evidence

Findings: ticket them, then route to PLAN or SCOUT by the size/clarity rule.

No findings: append exactly
`RUN: hunt -> clean @SHORT-HASH` in the normal Event Graph skeleton. Under
`normal`/`goal`, transition to ADD. Under `execution_intent: converge`, this is
stage F or I and must route through CONVERGE to CLEAN or closure; never ADD.
MAINTENANCE owns the autonomous routing and checkpoint law.

No-git HUNT can finish after the full sweep but cannot create or reuse a hash
cache marker; LOG truthful unavailable evidence instead of inventing a hash.

## Optional performance submode

Only when explicitly requested or ticketed: record a baseline, fix the top
proven bottleneck, remeasure identically, and revert with evidence when gain is
under 20% and complexity rises.
