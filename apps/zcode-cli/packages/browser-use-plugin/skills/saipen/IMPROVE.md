# SAIPEN Improve — the meta-control that audits SAIPEN

Improve is a META-CONTROL, not a project phase (T-552). It audits SAIPEN and
the project under it; it does not run project execution. This file is the
single canonical owner of the Improve lifecycle: cycle admission, the seat and
report contract, the finding schema, sweep, verify, and archive semantics.
CORE.md section 1.10 owns command routing only. STATE owns no Improve
semantics. SubSaipen boundaries stay in `extensions/subs/PROTOCOL.md`. There is
no improve phase document under the phases directory, and the phase count
remains 16.

## 0. Why a meta-control

Improve is invoked on top of whatever the project is doing. Several seats may
audit independently and concurrently; reports are read-only evidence, never
canonical state; invoking improve during BUILD or VERIFY must not orphan the
DOING ticket; and one global `STATE.phase: IMPROVE` cannot represent several
independent audit seats at once. Adding Improve routing fields to STATE turns
retrospective evidence collection into project execution state — the category
error this file exists to prevent.

## 1. Command surface (routing lives in COMMANDS.md, CMD-ROUTING-01)

This lifecycle declaration must exactly mirror CORE's routing declaration;
the validator compares both with the CLI executor set.

`IMPROVE_ACTIONS = [bare, status, submit, complete, sweep, sweep-queue, verify, cycle-complete, reconcile, abort, retire, clean, hold, unhold]`

Each action's own validation rules live in the section that owns it; this list
is the surface, not a second copy of the law.

- `saipen improve` — the meta-control entry point: binds the current project,
  finds or mechanically admits the one active cycle, registers this seat,
  creates the DRAFT report mechanically with the real captured source
  identity, and returns a bounded AUDIT ASSIGNMENT (cycle_id, seat_id, report
  path, source identity, scope, proof levels, schema, write boundary, next
  mechanical submission action). It is NEVER an alias for status, and section 11
  owns its phase/task/next_action boundary.
  Bare invocation admits a NEW independent `core` seat.
  `--new-seat` states that choice explicitly;
  `--session <seat_id>` admits or resumes exactly one stable concrete session;
  `--role core|critic` selects the closed role, with `core` as default. A
  session retry returns the same assignment and never allocates another seat.
- `saipen improve status` — read-only derived status (section 5). Refuses to
  round malformed evidence up to a normal lifecycle state: invalid
  manifests/reports/sweeps are reported as INVALID_CYCLE / INVALID_REPORT.
- `saipen improve hold <T-###> [reason]` — persist the typed operator policy
  that automatic improvement discovery is held until the named gate ticket
  resolves (STATE.improve_gate). While it names an unresolved ticket, `continue`
  routes to that gate / WAIT and the automatic `continue -> improve`
  fallthrough cannot fire; an explicit `saipen improve` invocation is never
  blocked. Cleared by `saipen improve unhold` or deterministically by
  reconciliation the moment the gate reaches DONE or leaves BOARD.
- `saipen improve unhold` — clear the hold (idempotent; reports
  IMPROVE_GATE_NONE when no hold is set).
- `saipen improve submit <cycle> <seat> <project> <findings.json>` — the
  mechanical RUN submission path: Python appends the semantic RUN text through
  the journaled writer; the agent never edits the report file directly.
- `saipen improve complete <cycle> <seat> <project>` — mechanical report
  completion: full report validation, then draft -> complete, journaled and
  immutable.
- `saipen improve sweep-queue <cycle>` — read-only enumeration of the exact
  unswept composite finding queue (cycle + seat/report + RUN + IMP), in
  deterministic order. Semantic adjudication (reproduce/classify/dedupe/decide)
  is Core-owned; each decision is committed through `saipen improve sweep`.
- `saipen improve sweep <cycle> <RUN-N/IMP-NNN> <DISPOSITION> [--ticket T-###]
  [--report <ident>] [--reproduced y|n] [--fixed-by <ref>]
  [--verification <ref>]` — the Core-only disposition write
  through `write_sweep_entry`; section 7 owns its pre-write validation, and
  `--fixed-by`/`--verification` bind a resolution or successor evidence ref
  (a historical `SUPERSEDED`/`NOT_REPRODUCED` disposition uses
  `--verification` to name the current replacement finding it defers to).
- `saipen improve verify <cycle>` — the bounded DELTA audit of section 9.
- `saipen improve cycle-complete <cycle>` — runs the full cycle bar
  (section 2) and flips ACTIVE -> COMPLETE through `complete_cycle`. A partial
  sweep REFUSES it; complete-before-sweep is impossible.
- `saipen improve abort <cycle>` — the sanctioned mechanical exit for a STUCK
  DRAFT cycle whose report cannot complete (an interrupted audit, a committed
  RUN missing a required field). Refuses once any disposition exists, flips
  the manifest to archived with a journaled `cycle_aborted` marker, and
  byte-preserves the never-completed draft reports AT THEIR SAME PATH (no
  rename, no move, no raw file deletion): the manifest's archived +
  cycle_aborted markers are the single source of truth that the cycle and
  its drafts are non-authoritative (T-632). The next cycle can be admitted.
- `saipen improve retire <cycle> <seat> --reason <CODE>` — the bounded exit
  for ONE expected seat that can never complete (section 3). It marks that
  seat `availability: unavailable` through the journaled roster write; the
  never-completed report stays byte-identical at its path, every SWEEP
  disposition is untouched, and the cycle bar can then be met with the
  remaining seats. It never touches a seat whose report IS complete. The one
  COMPLETE route is `--reason STALE_COMPLETE --replacement <fresh-seat>`: it
  is NOT ordinary retirement and returns `SEAT_SUPERSEDED` (not
  `SEAT_RETIRED`), marking the seat `availability: superseded` bound to its
  preserved report hash and its current same-scope replacement (section 7).
  A COMPLETE report is never made generically retireable.
- `saipen improve clean <cycle>` — archive/retention meta-operation
  (section 10). Never means phase CLEAN, never enters the CLEAN phase.
- `saipen improve reconcile <cycle>` — ONE canonical finite exit for a strict
  ACTIVE cycle (section 14): it classifies every roster seat, executes the
  lossless transitions the evidence already authorizes (retire an un-started
  `EMPTY_DRAFT`, supersede a `STALE_COMPLETE` seat onto a current same-scope
  replacement), refuses while genuine actionable work remains, and terminalizes
  the cycle with the lifecycle class that records WHY it ended (`complete` /
  `superseded` / `blocked_external`). Idempotent on a terminal cycle
  (`ALREADY_TERMINAL`, zero writes).
- `saipen ticket reasoning <T-###> --recurrence <text> --weak-model <text>` —
  the canonical writer for the strict-sweep reasoning gates (section 13). It
  refuses unless a strict Core sweep `CONFIRMED` `PROTOCOL_VIOLATION`
  disposition resolves to that exact ticket, so the fields can never be
  attached to an arbitrary ticket and no raw BOARD field edit is ever needed.

No repeated-letter shortcut is assigned; the shortcut key count stays
byte-unchanged.

## 2. Cycle lifecycle

- Core is the sole creator of an Improve cycle.
- `cycle_id` is unique WITHOUT relying on chat history: derived from the
  canonical project identity plus a deterministic token (e.g.
  `imp-<projectkey>-<YYYYMMDD>-<NN>`, the counter taken from the cycle
  directory's existing entries read to end-of-file).
- Creation is atomic: a cycle directory becomes visible only after its roster
  is written.
- Two simultaneous attempts cannot silently create two "current" cycles: the
  second admission REFUSES with the existing cycle named.
- One project has at most one active Improve cycle unless an explicit
  separate-cycle operation exists.
- A completed cycle is immutable.

Improve routing/status is DERIVED, never carried in `STATE.md` (T-553). A
manifest/sweep edit changes the visible status with ZERO STATE writes. No
independent `improve_*` counter may live in STATE -- the validator's
`[improve-state-purity]` check FAILs such a field and FAILs finding text in
STATE (findings live in seat reports, judgment lives in SWEEP.md).

One real lifecycle order (NITRO dogfood IV, T-601):

```
ACTIVE
    seat reports written / completed (per-seat, parallel)
    ↓
    Core sweep dispositions written to SWEEP.md (judgment is Core-owned)
    ↓
    complete_cycle
    ↓
COMPLETE
    immutable historical evidence (every ordinary mutator refuses)
    ↓
ARCHIVED
    retention state only (saipen improve clean)
```

**The cycle bar** — one statement, cited by `cycle-complete` and by verify
(section 9): a strict manifest, every expected report full-valid, and exact
composite sweep coverage. "Full-valid" is a valid header, at least one explicit
`## RUN N` (or an explicit `NO_FINDINGS` run), and every finding carrying its
composite identity and full expected/actual/evidence triple. "Exact composite
sweep coverage" is a final Core disposition for every finding's exact composite
identity (cycle + seat/report + run + IMP id). One seat's disposition never
satisfies another's finding.

- COMPLETE means the cycle's mutation-producing work is over: the bar above
  must hold before the flip. A partial sweep REFUSES `complete_cycle` -- Core
  can never freeze the artifact before its own sweep finished.
- After COMPLETE every ordinary mutator (register_seat, append_run,
  write_sweep_entry) refuses; only permitted archive metadata may change the
  cycle, and a new cycle may then be admitted without deleting history.
- Every ACTIVE cycle has a finite canonical exit even after its sweep started:
  an un-audited DRAFT (zero committed RUNs) is re-bound on resume (section 4),
  a seat that can never complete is retired through `saipen improve retire`
  (section 3), and a stale COMPLETE seat is superseded to a current
  same-scope replacement through `--reason STALE_COMPLETE --replacement`
  (section 7). Retirement preserves every existing disposition and the
  never-completed report's bytes; `abort` stays forbidden once the sweep has
  dispositions, because aborting would discard them.
- The CYCLE terminal classes (T-1434 M4) are `complete` (every expected seat
  reported, current or superseded onto current replacements), `superseded`
  (closed by reconciliation with seats canonically unavailable), and
  `blocked_external` (closed with a seat explicitly recorded
  `retire_reason: BLOCKED_EXTERNAL`). `archived` remains the abort/retention
  state. Only `active` blocks a new cycle; every terminal class is sealed
  historical evidence and frees admission of the next cycle. `saipen improve
  reconcile` (section 14) is the ONE operation that decides which terminal
  class is truthful -- never a generic DONE that erases why the cycle ended.

Cycle directory:

```
.saipen/improve/<cycle_id>/
    MANIFEST.md      Core-owned roster (stable routing/identity only)
    SWEEP.md         Core-owned sweep ledger (dispositions, judgments)
    <seat_id>/saipen_improve_<PROJECTNAME>.md     seat report (immutable once complete)
```

Strict-schema manifest (all new cycles; written by create_cycle, validated by
the same grammar):

```
# IMPROVE CYCLE ROSTER

manifest_schema: strict
cycle_id
created_at            (valid UTC timestamp, exactly once)
project_identity      (portable key, never a machine-local absolute path)
cycle_status          (exactly once)
```

Legacy pre-boundary cycles carry none of the strict identity fields and the
historical reports' symbolic `source_tree_fingerprint` values stay valid legacy
evidence -- read-only compatibility, never emitted by a new writer.

## 3. Seat roster (MANIFEST.md)

Core registers the expected seat roster before fan-out. `seat_id` identifies
ONE concrete audit seat or session, never a model family:
`opencode-01`, `claude-01`, `codex-01`, `saiui`, `saihunt`. Two sessions both
running `agent: opencode` MUST NOT resolve to one report unless deliberately
the same registered seat.

Roster fields (stable routing/identity only):

```
manifest_schema         (strict cycles)
cycle_id
created_at
project_identity
seat_id
role
report_path
availability        (expected | unavailable | superseded)
```

Superseded seats add exactly these fields to the same block:

```
availability: superseded
resolution: stale-complete
replacement_seat: <seat_id>
preserved_report_sha256: <64 lowercase hex>
```

- `seat_id` is path-safe.
- Roles are closed to `core | critic`; roster and report roles must match.
- Duplicate seat registration fails.
- A seat cannot silently attach itself to another project's cycle.
- Unavailable historical seats are explicitly `availability: unavailable`.
  `saipen improve retire` is the canonical journaled transition for a seat
  whose report never reached complete; it is refused for a completed report
  and refused when it would leave the roster with no expected seat, so a
  cycle is never completed into evidence-free history. T-1434 M4: the retire
  reason is PERSISTED as `retire_reason: <CODE>` beside the availability, so
  a terminal cycle records WHY its seat was abandoned; a seat retired with
  `retire_reason: BLOCKED_EXTERNAL` is the explicit externally blocked seat
  class and terminalizes its cycle as `blocked_external` (section 14). The
  field is legal ONLY with `availability: unavailable`.
- `availability: superseded` is written ONLY by stale-COMPLETE resolution
  (section 7): the seat's COMPLETE report is stale against the current tree
  and a distinct, current, same-role, same-`context_scope` replacement seat
  carries its findings forward. The old report and the SWEEP ledger stay
  byte-identical; `preserved_report_sha256` binds those exact bytes, and any
  drift is a validation failure. The replacement chain must be acyclic and
  terminate at an `expected` seat. `prepare` never overrides a roster
  decision: preparing a superseded or unavailable seat returns
  `SEAT_SUPERSEDED`/`SEAT_UNAVAILABLE` and names the replacement where one
  exists.
- Seat identity is NEVER inferred from `STATE.agent` (latest actor only) or
  from LOG agent tags (optional field).
- Bare/`--new-seat` allocates the next `<agent>-NN` while holding SAIOPS's
  project writer lock. `--session <seat_id>` is the only resume selector; no
  model/client family guess can merge independent sessions. Selection,
  registration and initial report creation are one journaled admission.
- Expected writer contention returns the stable `WRITER_BUSY` Result; it never
  escapes as a traceback. Other `PermissionError`, `TypeError` and programming
  failures remain loud rather than being mislabeled as contention.
- Once Core has written a legacy bare-basename SWEEP record, admission refuses
  a second seat owning that basename: changing owner cardinality would
  reinterpret persisted provenance. Admit independent seats before sweep (new
  records are seat-qualified) or use a distinct report identity.
- Python owns manifest formatting: `create_cycle`/`register_seat` render the
  roster; no caller supplies preformatted MANIFEST prose.

The roster is NOT a second report: it carries no `draft`/`complete`/`swept`
status. Those are derived (section 5).

## 4. Seat report

Canonical paths:

```
Core seat:      <project_root>/.saipen/improve/<cycle_id>/<seat_id>/
                    saipen_improve_<PROJECTNAME>.md
SubSaipen seat: <sub_home>/improve/<cycle_id>/
                    saipen_improve_<PROJECTNAME>.md
```

- The exact requested basename is preserved; everything above it is the
  canonical path.
- Nothing is ever written under the shared protocol install (`saipen_home`).
- One seat owns one report path. A different seat gets a different directory;
  a different cycle gets a different directory.
- A second run from the SAME seat in the SAME cycle APPENDS an immutable RUN
  section; an earlier RUN is never overwritten.
- Every new report is created mechanically (`create_report`), RUNs append
  through the journaled writer, and `report_status` flips draft -> complete
  only through `complete_report` after the FULL report validation passes. Raw
  report file construction by Core/agent is banned after the migration
  boundary.
- Every semantic audit invocation produces an explicit `## RUN N` section.
  A strict cycle's completed report carries at least one RUN; a RUN with no
  findings MUST declare the explicit `NO_FINDINGS` marker, so an intentional
  empty audit is distinguishable from an interrupted one.
- Once complete the report is immutable; lifecycle state is PARSER-derived,
  never a substring search.

Report header identity — NO absolute machine-local path. Report identity uses:

```
saipen_version
protocol_fingerprint
```

A logical protocol-source classification MAY appear; the absolute local
installation path (e.g. `V:\...\_SAIPEN`) must never be persisted as report
identity: it is machine-local, non-portable, unnecessary for reproduction, and
potentially user-specific filesystem leakage.

A DRAFT with zero committed `## RUN` sections is an assignment, not evidence:
when its mechanical identity header (installed `saipen_version`/
`protocol_fingerprint`, `source_head`, `source_tree_fingerprint`,
`discovery_model`) went stale between admission and resume -- an install
update, a tracked source change -- the canonical resume re-derives ONLY those
fields in place through the journal, and the assignment result carries
`header_rebound: true` with the previous fingerprint/head. Assignment context
fields (`agent`, `role`, `model_or_runtime`, `project`, `context_scope`,
`context_available`) and every body byte are never touched. A draft with ANY
committed RUN is evidence and is never re-bound.

`report_status: draft | complete`. A seat marks a RUN complete; from that
moment the original report content is immutable (byte-stable).

## 5. Derived status (one fact, one owner)

`saipen improve status` DERIVES the visible status:

| Visible | Derivation |
|---|---|
| expected | roster entry exists, no report |
| draft | report exists, `report_status: draft` |
| complete | `report_status: complete`, no Core disposition yet |
| swept | sweep ledger contains final disposition coverage for that report |
| unavailable | roster explicitly records `availability: unavailable` |
| superseded | roster records `availability: superseded` with its stale-complete resolution |

MANIFEST never mirrors report status. SWEEP owns dispositions.

## 6. Finding schema

A finding is `IMP-###`, numeric order inside a RUN. FINDING IDENTITY IS
COMPOSITE: the canonical reference is
`<cycle_id>/<seat_id>/<report_path>#<RUN-N>/<IMP-NNN>` (a legacy pre-boundary
finding has no RUN and uses the bare `IMP-NNN` local form). One RUN's IMP-001
never satisfies another RUN's IMP-001; one cycle's IMP-001 never satisfies
another cycle's ticket provenance. No subsystem resolves provenance by a bare
IMP-### substring. Required header block:

```
agent, role, model_or_runtime, project,
saipen_version, protocol_fingerprint, source_head, source_tree_fingerprint,
discovery_model, context_scope, context_available, report_status
```

`source_tree_fingerprint` MUST be a real mechanical fingerprint
(`git-delta-v1:...` or `no-git-tree-v1:...`), captured by Python through
`freshness.compute_source_identity()` at report creation -- a hand-typed hash
or a friendly label never passes as fresh audit evidence. For strict active
cycles the report must also be fresh against the CURRENT source identity:
same HEAD plus a changed/dirty tree is detected, and stale evidence cannot
authorize fresh canonical work without current reproduction. A zero-RUN draft
is not evidence, so the section 4 re-bind rule is its one exception -- it
rewrites no observation and frees no stale evidence into fresh work.

No `saipen_home` absolute path. Every finding MUST carry an observable
expected/actual/evidence triple — a finding without it is rejected, not
softened. Closed vocabularies:

- severity: `P0 | P1 | P2 | P3`
- class: `PROTOCOL_VIOLATION | PROJECT_VIOLATION | LOGIC_ERROR |
  ACCIDENTAL_SUCCESS | USERPERSON_MISS | VAGUE | OTHER`
- confidence: `observed | reproduced | proven | suspected`
- action: `fix | ticket | note | reject`

`context_available: complete` is refused when the stated scope is partial.
`NO_FINDINGS` with a stated scope is legal. `LATER_RULE` is distinct from a
historical violation. `ACCIDENTAL_SUCCESS` is first-class: a correct result
reached without the required verification is never PASS.

`USERPERSON_MISS` is a preference class, not automatically a protocol
violation. A seat may only be classified `USERPERSON_MISS` for a preference it
was legitimately given via a projection (section 8).

## 7. Core sweep (judgment is Core-owned)

Core sweep is the only path from report to canonical work:

1. deterministic report order; `sweep-queue` enumerates the exact unswept
   composite findings (cycle + seat/report + RUN + IMP) with no substring
   guessing;
2. reproduce; reject invalid findings;
3. root-cause deduplication: several reports naming one root cause produce ONE
   ticket with every `source_reports:` reference;
4. dispositions are written to the Core-owned ledger `.saipen/improve/
   <cycle_id>/SWEEP.md`, NEVER into the seat report;
5. `write_sweep_entry` validates BEFORE write: the named cycle is active, the
   named seat/report exists, the report is complete, the named RUN exists, the
   named IMP exists in that exact RUN, the disposition and reproduced values
   are legal, the disposition/ticket relation is legal, a CONFIRMED
   disposition names a canonical ticket that exists on the board or in the
   LOG, and -- for a strict cycle -- a CONFIRMED disposition is refused on
   STALE evidence (the report's source identity no longer matches the current
   tree; same HEAD + dirty tree is stale). Fictional reports/runs/findings/
   tickets can never COMMIT, and stale evidence demands current reproduction
   (a new RUN) or a non-CONFIRMED disposition.

ONE structured sweep record (`SweepRecord`) is shared by the writer, the
parser, `derive_status`, the validator and ticket provenance:

```
finding_ref        RUN-N/IMP-NNN (strict) or IMP-NNN (legacy)
disposition        closed set
ticket             canonical ticket or -
report             <seat_id>/<report_path> exact identity
reproduced         y | n
fixed_by           resolution identity or -
verification       verification evidence/ref or -
```

A bare legacy `report_path` resolves only while exactly one roster seat owns
that basename; duplicate owners MUST use the seat-qualified identity and never
share disposition coverage.

Disposition set (closed): `CONFIRMED | DUPLICATE | ALREADY_FIXED |
SUPERSEDED | LATER_RULE | NOT_REPRODUCED | INVALID | NEEDS_EXTERNAL_EVIDENCE`.

### Stale COMPLETE evidence and its finding accounting (T-1411)

A strict active cycle's COMPLETE report whose captured source identity no
longer matches the current tree is stale, and stale evidence never authorizes
fresh canonical work (T-619): `CONFIRMED` on that report is refused. The
finding still owes a truthful final Core disposition and the cycle owes a
finite executable exit. The ONE route is:

1. create and complete a distinct replacement seat (`saipen improve
   --new-seat`, section 4) auditing the SAME `context_scope` against the
   current tree;
2. dispose every historical finding with a non-CONFIRMED disposition --
   `SUPERSEDED` with `reproduced=y` when the replacement reproduced the
   defect, `NOT_REPRODUCED` with `reproduced=n` when it no longer does --
   bound to the successor with `--verification
   <cycle>/<replacement-seat>/<report>#<RUN-N/IMP-NNN>`. Current ticket
   authority flows ONLY through the replacement's own `CONFIRMED`
   disposition on fresh evidence; the historical record carries no ticket;
3. `saipen improve retire <cycle> <seat> --reason STALE_COMPLETE
   --replacement <fresh-seat>`, which validates the replacement is distinct,
   registered, `expected`, COMPLETE, current and same-role/same-scope, then
   writes the `availability: superseded` binding. The machine result is
   `SEAT_SUPERSEDED`, never `SEAT_RETIRED`.

Existing SWEEP dispositions are never rewritten: the route appends only. A
finding may never disappear because its report was superseded -- unswept
findings refuse the supersession itself. Repeated resolution of the same
relation returns `ALREADY_APPLIED` and writes nothing; that is a statement
about the relation, never about cycle freshness -- if the replacement later
goes stale, `saipen improve verify` reports it and names the next route. Every
refusal that blocks a recoverable stale-COMPLETE state prints the executable
route above. `saipen improve verify`, `saipen improve cycle-complete`,
`saipen improve clean` and `tools/validate.py` share the same
`validate_superseded_seat` evidence: a tampered preserved report, a
dangling/cyclic replacement chain, or a swallowed finding fails them all.
`saipen improve reconcile` (section 14) executes this exact route, plus the
empty-draft retirement, in ONE operation when the cycle is otherwise
terminalizable; it never weakens the evidence bar, and it refuses when no
current same-scope replacement exists.

A report's own `confidence: proven` is evidence to inspect, never a ticket
authorization. Canonical tickets carry: `source_reports, reproduced,
invariant, defect, impact, exact_fix_scope, red_control, done_condition`.

`source_reports:` MUST use the exact composite reference
`<cycle>/<seat>/<report>#RUN-N/IMP-NNN`. A bare `IMP-NNN` ref is LEGACY
evidence only: it may resolve against legacy (run-less) sweep records in
legacy cycles, and FAILs once the only matching records live in strict cycles
-- a new ticket can never launder a strict finding through a bare IMP.
Provenance resolves to a `CONFIRMED` disposition only: a historical
`SUPERSEDED`/`NOT_REPRODUCED`/`INVALID` record never satisfies a ticket's
`source_reports`, because only `CONFIRMED` authorizes canonical work.
Substring search is never provenance.

Chain of custody:

```
SEAT REPORT      immutable observation
        |
        v
CORE SWEEP       canonical judgment (SWEEP.md)
        |
        v
BOARD TICKET     actionable work
```

Observation and judgment never live in one writable file. A completed seat
report is hash-verified unchanged after sweep/fix/verify.

## 8. USERPERSON projections

SubSaipen handoffs project a relevant preference subset, never the whole
profile, and record what was projected so Core can audit it:

```
projection_policy(role) -> allowed preference categories
effective_profile(project_root) -> global + project preferences with provenance
effective_projection(project_root, role) -> the bounded projection
```

A projection handoff includes: the effective source fingerprint, provenance,
which preference IDs/categories were selected, and the scope statement. If the
semantic category selection is performed by the model rather than Python, that
is stated explicitly and the mechanical layer only validates/writes the
already-distilled representation. USERPERSON preference identity is structured
(category-keyed), never pretended to be solved by string splitting.

## 9. Verify (delta-only)

`saipen improve verify` validates the COMPLETE cycle output of the current
cycle against section 2's cycle bar, plus -- for strict active cycles -- source
freshness against the current tree. It MUST NOT reopen unrelated history and
MUST NOT recurse into a full improve cycle. It can never PASS a report that
contains only `report_status: complete`: the bar, not the marker, is the test.
If it starts another historical self-audit, it fails.

## 10. Archive / clean semantics

`saipen improve clean` is archive-with-provenance and NOTHING else: it
refuses while any finding is unswept or any disposition is missing (naming
the finding, red control 23), it preserves the original findings verbatim,
and every archived report keeps the canonical ticket references that point
back at it (the `[sweep-ticket-link]` check must still resolve an archived
report's `source_reports` -- deleting SWEEP.md or the report to "clean up"
breaks provenance, red control 24). Partial or timed-out test evidence can
never mark an IMP fixed (a CONFIRMED disposition with `reproduced` other
than `y` fails, red control 25).

Prefer immutable cycle directories plus a compact index/archive marker over
renaming paths that tickets reference. Do not create link rot as a cleanup
feature: canonical ticket provenance must still resolve through a stable
cycle/report identity after archiving.

## 11. Meta-control proof

Improve being a meta-control means:

- no phase enum row is added (phase count stays 16);
- no improve document exists under the phases directory;
- INDEX does not list IMPROVE as a phase;
- no transition table contains IMPROVE;
- `saipen improve` may checkpoint current work before an audit but never
  changes phase/task/next_action merely to run the audit;
- `saipen improve` never silently enters ADD -- an audit run never routes
  into the ADD phase (T-557).

## 12. Writer boundary and recursion stop (T-557)

During SELF-AUDIT/REPORT no seat may touch Core protocol, main source, or the
canonical BOARD/LOG/STATE except the bookkeeping that registers the audit. A
SubSaipen writes only inside its own home (`extensions/subs/PROTOCOL.md`);
an auditing sub that writes a main-project file violates the boundary. A seat
report is evidence, never canonical BOARD state: a report that carries BOARD
section headings (`## DOING` / `## TODO` / `## DONE` / `## BLOCKED`) is
rejected (red control 22). `saipen improve verify` is delta-only (section 9)
and NEVER re-enters a full improve cycle -- a verify pass that reopens
unrelated history or starts a fresh cycle fails (red controls 17/18).

## 13. Reasoning gates are checked artifacts (T-558)

A protocol-level improve ticket (a `PROTOCOL_VIOLATION` finding that produced
a canonical ticket) MUST record two checked artifacts on the ticket itself:

- `recurrence:` -- the META-IMPROVEMENT rule. The cross-project recurrence
  analysis: does this defect recur across projects, or is it local? A
  protocol-level fix records the reasoning; a local bug stays local.
- `weak_model:` -- the WEAK-MODEL PRECEDENT test. The answer to "could a weak
  but compliant model still choose wrong while honestly believing it followed
  SAIPEN?", strengthened in the fixed preference order: state field,
  transition rule, validator, red scenario, canonical example, prose last.

The `[sweep-ticket-link]` check FAILs a `PROTOCOL_VIOLATION` finding that
produced a ticket without both fields (red controls 15/16). The canonical
writer is `saipen ticket reasoning <T-###> --recurrence <text> --weak-model
<text>` (T-1434 M4): it resolves the strict-sweep link first and refuses a
ticket no strict `CONFIRMED` `PROTOCOL_VIOLATION` disposition names, so the
reasoning text can never be attached to an arbitrary ticket and the validator
remediation is executable by construction. A fix answered
only with prose where a state field or validator was available is flagged.
`ACCIDENTAL_SUCCESS` is first-class: a finding whose result was correct but
whose verification never ran is classified `ACCIDENTAL_SUCCESS`, never PASS
-- a sweep disposition recording it as verified (`reproduced=y`) fails (red
control 5).

## 14. Strict-cycle reconciliation (T-1434 M4)

An ACTIVE strict cycle whose seats are individually resolvable can still be
globally stuck: drafts that never started, COMPLETE seats stale against a
moved install, dispositions already in the sweep ledger (so `abort` refuses),
and `cycle-complete` unmet. Every ACTIVE cycle therefore owes ONE canonical
operation that decides the cycle's finite exit:

    saipen improve reconcile <cycle>

It classifies every roster seat into exactly one machine-readable class:

```
CURRENT_COMPLETE           terminal; complete and current on this tree/install
SUPERSEDED                 terminal; availability: superseded with valid binding
CANONICALLY_UNAVAILABLE    terminal; retired seat, reason persisted
BLOCKED_EXTERNAL           terminal; retired seat with retire_reason: BLOCKED_EXTERNAL
EMPTY_DRAFT                resolvable; zero committed RUNs, losslessly retired
STALE_COMPLETE             resolvable; superseded onto a current replacement
STILL_ACTIONABLE           refuse; committed evidence in flight or evidence broken
```

Rules:

- a seat with committed audit content that is not COMPLETE is genuine work in
  flight: reconcile REFUSES and names the submit/complete route;
- an EMPTY_DRAFT has produced no evidence: retiring it discards nothing, and
  its report stays byte-identical at its path;
- a STALE_COMPLETE seat may only be superseded onto a CURRENT, COMPLETE,
  same-role, same-`context_scope` replacement; with none registered reconcile
  refuses and names the `--new-seat` route rather than weakening the bar;
- reconcile re-derives every classification from the bytes on disk after the
  transitions and requires the full cycle bar (`verify_cycle`) before it
  terminalizes -- it never trusts its own plan;
- the terminal class records WHY: `complete` when every expected seat is
  reported, `superseded` when seats were canonically unavailable,
  `blocked_external` when an external blockage was explicitly recorded;
- reports, SWEEP bytes and preserved report hashes are never rewritten;
- an already-terminal cycle returns `ALREADY_TERMINAL` with ZERO writes.

Legacy (non-strict) cycles are sealed read-only history: reconcile refuses
them and the historical exits (`retire`, `abort`) keep their meaning.

A real IMPROVE phase may still be proposed only by first proving a failure the
meta-control design cannot solve.
