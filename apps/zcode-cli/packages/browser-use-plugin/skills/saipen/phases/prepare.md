# Phase: PREPARE

## Purpose and entry

Entered by `saipen prepare [producer]`. Package one complete producer result
for a later consumer; a named producer never means a quick scan.

## Reads and freshness

**Forced-fresh preparation** synchronizes the current project-local charter,
derives its `role_revision`, inspects the current project, and binds the final
`source_head`, `source_tree_fingerprint`, `role_revision` after the producer's
last source-affecting read or mutation.

Invalidate an earlier package when any binding differs. Reuse is legal only
under a **deterministic cache contract** proving byte/content-equivalent
regeneration against all three current inputs, followed by a freshly rerun
verification recorded in `verified`. `status: ready` alone is never proof.
Core may reject stale evidence; **only this producer preparation writes replacement evidence**.

## Package

Assemble complete, structurally sound artifacts plus instructions a cold next
agent can execute without guessing.

Every collectable handoff MUST include these fields: `status`, `producer`, `source_head`, `source_tree_fingerprint`, `role_revision`, `coverage`, `payload`, `verified`, and `instructions`.

`status: ready` requires complete coverage, current freshness values, passed
producer checks, executable payload, and executable injection instructions.
Any read/stat/classification/freshness failure is `blocked`; incomplete but
recoverable work is `draft`. Unknown input is never silently skipped.

- A SubSaipen writes the combined result to its `kitchen/OUTBOX.md` and closes
  its own ticket only when ready.
- `saipen prepare saitranslate` (`ee`) reruns the full TRANSLATE contract and
  writes `.saipen/saitranslate/kitchen/OUTBOX.md`; coverage names every source
  surface and locale, payload names exact integration files.
- `saipen prepare saiwiki` (`qq`) prepares the maintained wiki surface and
  writes `.saipen/extensions/subs/saiwiki/kitchen/OUTBOX.md`; coverage and
  payload name exact pages.
- An unqualified main-project run may write a non-collectable package under
  `.saipen/kitchen/`; it may not impersonate a named producer.

PREPARE packages only. It **MUST NOT integrate the payload**, modify a target
remote, commit, tag, or push. Collection followed by the Core gates and SHIP
owns those effects. No ready handoff grants main-project mutation authority.

## Exit and evidence

Success uses the normal Event Graph skeleton with
`RUN: prepare <producer> -> done`; failure uses
`RUN: prepare <producer> -> FAILED <reason>` and enters BLOCKED. When none was
requested, **the word `unqualified` is the producer name**. The OUTBOX owns
source revision; the LOG answers only which producer ran and its outcome.

Success transitions to DONE. Generic checkpoint, effect authorization,
recovery, and Source receipt mechanics remain in CORE/OPS/SOURCES.

Under converge, CONVERGE owns stages K/L and the EE-before-QQ order; no main
source mutation may follow either preparation.
