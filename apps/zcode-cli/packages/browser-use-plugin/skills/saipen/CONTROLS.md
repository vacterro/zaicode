# SAIPEN Controls — Focus, Build, Cut, Undo

Normative semantic owner for T-1156's four controls. `CORE.md` section 1.10
owns names, shortcuts and compound routing; `OPS.md` owns transaction
mechanics. This file owns meaning. No new phase or second command registry.

```
ff = attention without mutation
vv = contextual creation without architectural surprise
xx = contextual removal without collateral damage
zz = reversible progress without historical amnesia
```

## 1. Shared boundary

Python owns deterministic mechanics: syntax, project binding, IDs, hashes,
path containment, ownership, stale checks, immutable plans, locks, journals,
recovery and projections. The agent owns fuzzy reasoning: semantic target
resolution, architectural fit, impact analysis, feature/cut scope, milestone
worthiness and Knowledge promotion.

All controls reuse Work, Attempt, the Core DFA, destructive-operation gate and
SAIOPS PLAN/APPLY. They never create FOCUS, CUT, SMART_BUILD or UNDO phases.
`scope` remains reviewed release scope. A Core Checkpoint remains frequent
`LOG -> BOARD -> STATE` crash continuity. A Restore Milestone is a sparse,
user-visible exact-byte project anchor. These concepts are not aliases.

Classification:

- `focus` / `ff`: read-only.
- `cut <target>` / `xx <target>`: read-only preview.
- `cut confirm <CUT-ID>` / `xx confirm <CUT-ID>`: mutating.
- `build <directive>` / `vv <directive>`: mutating.
- `undo` / `zz`: read-only preview.
- `undo confirm <CP-ID> --reason <text>`: mutating.

Malformed forms write nothing. Preview forms never hand over `STATE.agent`,
open an Attempt, create an operation journal, or write STATE/BOARD/LOG. Payload
after `ff`, `vv` or unconfirmed `xx` is opaque free text. `/` and `;` are
punctuation, not command separators. Only CORE section 1.10's existing `+`
and newline compound grammar applies.

## 2. Focus (`ff`, `saipen focus`)

Focus is a session-local attention lens, not Goal, Work, plan, phase or durable
authority. It never moves BOARD, phase, task, next_action or execution intent.
An unrelated explicit user topic drops the lens automatically; no `focus off`
ceremony exists.

Bare focus resolves: active `STATE.task`, live DOING Work, executable
next_action, then current project frontier. It never invents Work.

For a focus expression, search only as far as useful: exact names/symbols,
files/modules, BOARD/LOG, KNOWLEDGE/ADR, tests, callers/consumers/dependencies,
bounded Git history, then directly adjacent architecture. The mechanical
projection provides bounded exact evidence. It does not decide whether
`performance` is a subsystem or an analytic lens.

The agent synthesizes the applicable Focus Brief: resolved focus; where,
what, purpose, how and why; evidence-backed history; current state;
dependencies and data/UI flow; known issues/blockers; requested analytic
lens; risk; recent Work; interesting signals; natural next directions.
Evidence and inference stay separate. Unknown history is reported as
`WHY ADDED: not proven by available evidence`. Focus may report a possible
defect but never fixes it or creates a ticket. A related milestone is named
only when its owned scope proves the relationship.

## 3. Build (`vv`, `saipen build`)

Build accepts short natural-language change intent. It is not a jump to BUILD
phase and not hidden `gg`. It creates bounded foreground Work at SCOUT,
preserves `normal`/`goal`/`converge`, then follows normal SCOUT -> BUILD ->
VERIFY -> REVIEW -> SHIP -> DONE gates.

Before editing, agent performs FIT: user intent; existing analogues; natural
home; smallest coherent useful slice; real dependencies; state ownership and
persistence; UI surface/lifecycle; failure path; compatibility; performance;
testability; reversibility. Reuse beats a parallel timer/store/controller.
Smallest coherent does not mean fewest lines. Related directives become one
capability DAG only when architecture proves the relationship.

When no Work is active, foreground directive is claimed at SCOUT and its first
Attempt opens in the same SAIOPS transaction; intake cannot leave claimed Work
without its execution episode after a crash. The Attempt closes before the
normal VERIFY admission boundary. When Work is already in a ticket-bearing
phase, the Core DFA has no legal edge back to SCOUT: that Work and its Attempt
remain truthful, while the explicit
directive is inserted as top TODO and is claimed at the next legal DONE ->
SCOUT boundary. A fake BLOCKED/DONE hop is forbidden. This is the smallest
preemption compatible with the unchanged DFA and single-DOING invariant.
Broader intent and counters survive. Low-risk ambiguity chooses smaller,
native, reversible and dependency-light. Materially incompatible product
meanings still require clarification. Build grants no destructive authority.

Before significant/risky edits, agent creates sparse pre-change milestone over
the resolved owned scope. After successful closure, user-visible features,
schema/persistence, multi-component changes, significant UI behavior,
mechanism replacement and risky architecture create a post-change milestone
over the same scope. Typos, formatting and trivial isolated fixes do not spam
milestones.

## 4. Cut (`xx`, `saipen cut`)

Cut removes one resolved feature/mechanism/UI behavior while preserving the
coherent remainder. Always two-stage.

`cut <target>` is zero-write preview. Agent resolves the target and maps exact
implementation, entry points, callers, dependencies/dependents, persisted
state/schema, UI fallback, tests, docs, translations, dead code/dependencies,
migration, performance, preserved behavior and risk. Grep is evidence, never
deletion authority.

The first user invocation stays one read-only stage: mechanics supplies the
snapshot, agent resolves the impact, then mechanics returns `CUT-<digest>`
bound to project identity, source revision, canonical STATE/BOARD/LOG
snapshot, target interpretation, affected scope and the canonical full-plan
hash. An unresolved scan has no confirmable CUT-ID. Agent retains the resolved
plan session-locally; preview writes no plan, lock or journal. Repeating target
stays preview. Changing any impact field produces a different CUT-ID.

Only `cut confirm <CUT-ID>` authorizes. Agent transports exact resolved impact
plan over the internal mechanical boundary. Confirmation recomputes binding;
source/state drift is `STALE_PLAN`. Missing plan, ambiguity, path escape or
missing impact fields refuse without mutation.

Before confirmed Work starts, SAIOPS creates a real pre-cut Restore Milestone
covering every affected path, including absent markers. Only then normal cut
Work enters SCOUT. Agent removes approved consequences: orphan settings,
translations, docs, tests, imports, dependencies and layout gaps, without
unrelated refactor. Post-cut milestone is normally warranted. Compound
STOP_ON_FAILURE and existing destructive gates remain authoritative.

## 5. Restore Milestones

Storage is separate from crash recovery:

```
.saipen/milestones/
  blobs/<sha256>
  CP-NNN/manifest.json
  current.json
```

Each completed manifest records schema, monotonic non-reused sequence, ID,
explicit parent, UTC time, short `YYYY-MM-DD Ddd  Label`, project identity,
optional Git source revision, associated Work/Attempt IDs, creation kind,
publication/external-effect facts, exact owned scope, file/absent state,
payload hashes and manifest integrity hash. Payload preserves exact bytes:
binary, UTF-8, BOM, CRLF and Unicode filenames are not normalized.

Identical bytes reuse a content-addressed blob. This is bounded dedup, not a
database. For the first baseline only, a Git project may read sparse owned
bytes from an exact local commit through plumbing; the creation timestamp says
the baseline was created now, never that it existed historically. Milestone
code never stash/reset/checkout/switch/commit/push or touch the user's index.
Non-Git captures the same sparse payload from live files.

Creation stages payload then publishes manifest in one journaled operation.
Incomplete payload has no valid selectable manifest. `current.json` is a
rebuildable projection; manifests plus append-only LOG are authority.
Validator checks IDs/sequences, parents/cycles, identity, path containment and
aliases, integrity, payload and current lineage. Projects without milestones
remain valid.

Rollback leaves descendants historical. Pointer moves to restored parent.
Next milestone uses `max(sequence)+1` and names current as parent; IDs never
reuse.

## 6. Undo (`zz`, `saipen undo`)

Bare undo validates integrity and previews one lineage step without writes.
When live state matches current milestone, target is explicit parent. When
live bytes differ but an existing reviewed release-scope record proves the
exact paths, Work, project identity, time ordering and current hashes, target
is the current milestone: this removes owned unmilestoned work. Without that
proof the same bytes are foreign. Every restore path must have exact target
pre-state. No milestones or root-only baseline yields no undo; history is
never guessed.

Live bytes must match current manifest over restore scope. Unattributed overlap
refuses and names paths. Undo never stash/reset or secretly copies foreign
edits away. Preview separates local reversible state from external effects.
Any pending operation has recovery priority: status marks milestone projection
invalid and undo refuses `RECOVERY_REQUIRED` until the journal is settled, so
a partially published milestone is never selectable.

Confirmation is:

```
undo confirm <CP-ID> --reason "<one bounded sentence>"
```

Missing/wrong target or reason writes nothing. RestorePlan binds current and
target IDs, target manifest hash, current hashes, canonical snapshot and
reason. APPLY rechecks under writer lock, journals exact write/delete targets,
verifies bytes, updates lineage and appends truthful rollback LOG. Retry is
idempotent. LOG is never truncated; old Work/Attempt history remains.

Published work creates ordinary forward-revert Work and never rewrites commit,
tag or remote history. Local unshipped state may restore exact bytes directly.
Recorded external effects without a proven compensation path refuse. Agent
promotes rollback reason into KNOWLEDGE only when it establishes reusable
product/architecture/compatibility truth.

## 7. Status and cold continuation

`status`/`sss` shows compact current milestone ID/label/parent/undo availability
without hashing all blobs. Full integrity runs at create, undo and validate.
Mutating controls leave ordinary BOARD/STATE/LOG truth. A cold agent can see
foreground Work/Attempt, lineage, rollback reason and next_action from files
alone. Session-local focus is intentionally absent.
