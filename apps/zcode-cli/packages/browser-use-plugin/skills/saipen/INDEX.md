# SAIPEN INDEX

Lazy-load map only. BOOT selects one owner; phase work loads one active phase.
Machine-owned closed facts and Rule-ID ownership live in `REGISTRY.json`.

## Runtime route

- `BOOT.md` -- cold execution router; no protocol semantics.
- `STYLE.md` -- reply language, voice and artifact style; loaded first.
- `REGISTRY.json` -- executable closed sets, routing facts and load profiles.
- `COMMANDS.md` -- command, shortcut and compound-command semantics.
- `EXECUTION.md` -- execution/output policy, including planned HUSH behavior.
- `CORE.md` -- global state, checkpoint, priority and transition invariants.
- `MAINTENANCE.md` -- goal-driven and autonomous maintenance semantics.
- `OPS.md` -- journaled operations, recovery, reconciliation and rebind mechanics.
- `SOURCES.md` -- receipt authority, Work Contract and coverage lifecycle.
- `RUNTIME.md` -- runtime identity, capabilities and adaptive strategy.
- `CONTROLS.md` -- focus/build/cut/undo controls and restore milestones.
- `IMPROVE.md` -- Improve admission, seats, findings and lifecycle.
- `CONVERGE.md` -- converge stage order and closure bar.
- `SAICRITIC.md`: ordered self-critique proof vocabulary.
- `RFC.md` -- compatibility redirect only; never a rule destination.

## Phase route

Load only `phases/<STATE.phase>.md`; replace it on transition.

- `init.md`: bootstrap.
- `plan.md`: ticket planning.
- `scout.md`: bounded discovery.
- `build.md`: implementation.
- `verify.md`: evidence.
- `review.md`: independent review.
- `ship.md`: release.
- `done.md`: closure routing.
- `blocked.md`: session blocker.
- `hunt.md`: defect sweep.
- `markhunt.md`: report-only sweep.
- `add.md`: minimal next work.
- `clean.md`: hygiene.
- `validate.md`: protocol repair.
- `translate.md`: translation factory.
- `prepare.md`: handoff factory.

## Conditional surfaces

- `UI.md` -- only UI/frontend work.
- `HABITS.md` -- known model failure patterns.
- `CONFORMANCE.md` -- compact human conformance contract/index; routine agents
  do not load it. Scenario proof data lives in `tests/conformance_cases.jsonl`.
- `.saipen/KNOWLEDGE/*.md` -- project truths relevant to the current ticket.
- `CHANGELOG.md` -- release history, never cold context.
- `SKILL.md` -- platform loader entry, not runtime protocol.

Use the owner named by the route. Do not read the full protocol tree.
