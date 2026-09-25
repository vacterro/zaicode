# Phase: ADD

## Purpose and entry

Complete an existing product evolutionarily; do not invent a new one. ADD is
entered only after a clean HUNT on `normal`/`goal` intent. **Never entered under
`execution_intent: converge`**; CONVERGE stages F/I own their destinations.

New prose is an addition: cite CORE §1.1's defect class gate before writing it.

## Selection

Evaluate in order and pick exactly one real gap:

1. bugfix;
2. complementary feature in an existing pair;
3. missing step in an existing workflow;
4. UX consistency;
5. platform convention.

Reject speculative, experimental, unrelated, or architecture-replacing work.
If no real gap exists, the product is mature: LOG the decision and exit DONE.

Every selected gap becomes a ticket. A bugfix always enters the standard
pipeline at SCOUT; ADD neither fixes inline nor loops back to HUNT.

Two implementation paths exist:

- **Direct minimal path:** the next step is concrete, roughly at PLAN's
  `<=2 files + obvious change` bar, and matches existing design language.
  Ticket and canonically claim it, then enter BUILD.
- **Planned path:** design, dependency ordering, research, or a non-obvious
  delta remains. Ticket it and enter PLAN; use SCOUT instead when the desired
  change is clear but repository facts still need discovery. Uncertain means
  PLAN.

These destinations become legal `next_action` values: `PHASE BUILD T-###`,
`PHASE SCOUT T-###`, or `PHASE PLAN`. `RETURN` is pseudocode, not a persisted
prefix. Generic claiming and lifecycle mechanics remain in CORE; ADD-created
work follows BUILD -> VERIFY -> REVIEW -> SHIP -> DONE.

## Completion policy

Apply MAINTENANCE §2.3's Industrial Completion Rule: when one requested step
implies a familiar workflow, implement the smallest coherent set, finish the
requested workflow before extending it, and reject unrelated epics. Preserve
user expectations.

For every ADD selection:

- user-visible settings persist between sessions;
- prefer user-editable configuration over hardcoded values;
- match the repository's architecture and design language.

If the product is mature under `execution_intent: goal`, this is the canonical
goal exit: clear intent/counters, report requested versus incidental work and
blocked items, then enter DONE (MAINTENANCE §2.4).

## Goal accounting

An ADD evaluation completes one HUNT->ADD goal wave when it selects any route,
including mature DONE. Increment `goal_waves` once and write
`DEC: goal_waves N->M`. If the route is PLAN, PLAN must not count the same wave
again. MAINTENANCE §2.4 owns persistence, the 3-wave/20-ticket valve, stop
shape, and `cc` reauthorization.

## Evidence and exit

Before leaving, write one decision-bearing Event Graph line:

- minimal claimed work: `RUN: add -> T-### <what>`;
- planning: `RUN: add -> T-### <what>, RETURN PLAN`;
- mature: `DEC: add -> mature, intent <normal|goal>` plus the goal report when
  applicable;
- no gap on an already empty board: say exactly that.

Then use the canonical CORE checkpoint. ADD owns the choice and route; it does
not restate ticket fields, checkpoint order, or the downstream lifecycle.
