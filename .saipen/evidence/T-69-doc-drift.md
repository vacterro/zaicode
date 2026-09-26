# T-69 — installed SAIPEN docs caught up to their own validator (IMP-002)

Verify clause: "validate.py reports 0 cross-doc-drift warnings against the
current install." Result: 15 → **0** on both installs (the launcher-bound
mirror `C:\Users\vac34\.config\opencode\skills\saipen` and the source
`C:\Users\vac34\AppData\Local\saipen\scheduled-source`).

## What was added, and where

All 15 warnings were law text the validator demanded but no owning document
carried. The install's `RFC.md` is a partition stub; `_read_rfc()` resolves to
CORE.md + MAINTENANCE.md, so everything the warnings called "RFC § x" lives in
`saipen/CORE.md`.

`saipen/CORE.md`:
- § 1.2 BOARD: the closed ticket-field list (34 fields, matching
  `saipen_engine.board.KNOWN_FIELDS` exactly); the ticket-bearing-five anchor
  sentence (`SCOUT/BUILD/VERIFY/REVIEW/SHIP`); the permanent-owner rule (a
  ticket whose completion can never be met + a ticket owned by another
  instance sit in `## BLOCKED`, never `## TODO`).
- § 1.2 LOG: "An ahead-stamp is repaired, not waited out" — restamp to a
  defensible bound with a DEC naming original, replacement, inherited minute.
- § 1.6: the `**From-any-phase set**` anchor
  (`VALIDATE/MARKHUNT/CLEAN/TRANSLATE/PREPARE/PLAN/HUNT`).
- § 1.10: a shortcut is a command, never a greeting; read-before-act and
  recall equals invention; **length has no global meaning** / no undeclared
  repeated forms; the plan-then-bare-goal PAIR carve-out; `saipen stop` +
  counter reset only at/over the caps, bare `saipen goal` never resets;
  producer refusal markers (`Not ready: run qq first.` / `run ee first.`, no
  main-project change on refusal).
- § 1.11 OBEY: a command that cannot execute now is written down, never
  dropped (`next_action` vs top of `## TODO`).

`saipen/BOOT.md`: step-6 shortcut bullet — read § 1.10's table before acting,
"Memory is never a source for it", no duplicate of the table into BOOT
("a second copy drifts").

`saipen/COMMANDS.md`: `gg` row — NEW GOAL ONLY, pivot needs text
(`gg <objective>`), bare form is never a continuation alias; `cc` row —
enters convergence from `normal`, resumes `execution_intent: goal`, never asks
for an objective, `cc <args>` is not a goal.

`saipen/phases/translate.md`: the line-broken marker
"**No ready handoff means no main write.**" rejoined to one line (the check
is a literal substring match).

## Verification

- `python tools/validate.py --project-root <project>` (both installs):
  **0 cross-doc-drift warnings**. Remaining 3 warnings are unrelated and
  pre-existing: two `log-taxonomy` on sealed LOG-001 historical lines
  (cold evidence, kept as-is) and one `log-soft-cap` (active LOG at 279/300
  lines — CLEAN seals it at the next checkpoint, not this ticket's scope).
- Red scenario (weakest link, from the ticket's own weak-model note): the
  BOOT.md sentence "Memory is never a source for it." was deleted, validate
  re-run → `[shortcut-memory-ban]` WARN reappeared (grep count 1); sentence
  restored → 0 cross-doc-drift again. The check fails loud, not vacuously.
- Anchor checks `ticket-bearing` and `any-from` now find and verify their
  anchors (previously "cannot find its anchor").

## Notes

- Both installs are deployed copies with no `.git` (not repositories), so
  there is no commit to make; publishing the SAIPEN repo itself remains
  T-62's operator decision.
- The four edited docs were copied verbatim from the source install into the
  launcher-bound mirror so the two cannot disagree.
