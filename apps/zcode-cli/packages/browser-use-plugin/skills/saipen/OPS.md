# SAIPEN OPS — the mechanical execution layer

OPS owns HOW protocol state is committed safely, never WHAT it means. It is the
contract for SAIOPS, the zero-dependency Python mechanical layer that performs
deterministic protocol operations agents would otherwise do by hand-editing
STATE.md / BOARD.md / LOG.md.

The division of labour:

```
PROSE DEFINES WHY.      the phase docs / CORE define reasoning and checks
LLM DECIDES WHAT.       ticket choice, classification, severity, intent
PYTHON DEFINES HOW.     SAIOPS commits the decided representation safely
TESTS PROVE THE RESULT. red controls + crash injection + full gates
```

OPS does NOT restate phase semantics, the Pick Rule, HUNT, CLEAN, Improve, or
SubSaipen semantics. Those live where they already live.

## 1. Semantic / mechanical boundary

LLM owns decisions requiring understanding: choose the correct ticket, classify
a defect, determine severity, write ticket prose, decide whether evidence
proves something, choose architecture, interpret user intent, decide which
USERPERSON preferences are semantically relevant, decide whether a new task is
necessary.

Python owns deterministic mechanics: resolve project, parse STATE/BOARD/LOG,
allocate event IDs, generate timestamps, validate transition legality, move
ticket between sections, set checkbox/owner/claim_time/task/next_action/
transition_from/last_event/counters, append LOG, preserve formatting, lock
writer, journal operation, recover interrupted operation, validate result,
reject stale input.

Never put fuzzy reasoning into Python pretending it is deterministic.
`should_this_bug_be_P1()` is forbidden; `create_ticket(priority="P1")` is the
shape. The model chooses, Python records.

## 2. Operation lifecycle

Every mutating operation is PLAN / APPLY separated around one immutable
OperationPlan.

PLAN:

1. read a ProjectSnapshot (state_hash, board_hash, log_hash, log tail E-ID,
   HEAD where Git exists);
2. validate the semantic request (ticket exists, needs, binding, legal
   transition, lifecycle source);
3. compute ALL intended final bytes in memory, encoding/BOM/newline already
   applied (the codec preserves representation; the journal stores EXACT
   bytes);
4. validate the IN-MEMORY proposed STATE/BOARD/LOG (fast cross-file
   invariants);
5. return the OperationPlan with its stable op_id, semantic_payload_hash,
   preconditions and ordered targets -- writing ZERO bytes.

`--dry-run` calls PLAN and renders it. Nothing else.

APPLY consumes THAT plan object under the writer lock:

1. acquire the project writer lock (real OS lock, `.saipen/locks/core.lock`);
2. run Recovery preflight first (section 3);
3. re-read every declared precondition under the lock; compare; refuse
   STALE_STATE;
4. compute each target's before_hash (live file) and after_hash (planned
   bytes); journal PREPARED with those hashes and the staged final bytes;
5. apply targets in the plan's declared order; journal progress per target;
6. re-read all affected files; verify exact bytes AND fast cross-file
   invariants; only then journal VERIFIED;
7. journal COMMITTED; release the lock.

The plan's op_id is the applied op_id; the plan's bytes are the committed
bytes; the plan is never recomputed during APPLY. A retry of a committed op
returns ALREADY_APPLIED.

CORE.md § 1.5's `LOG -> BOARD -> STATE` order is preserved for canonical Core
checkpoints (TransactionPolicy.CORE_CHECKPOINT). Single-file Improve writes use
TransactionPolicy.ATOMIC_FILE: one ordered target. Multi-file atomicity is NOT
claimed: there is no atomic multi-file primitive. The write-ahead journal is the
truth about how far a crash got.

## 3. Transaction / recovery behavior

The journal is GENERIC: every target is identified by path + role (log,
board, state, manifest, report, sweep, generic), never by its position in the
target list. A MANIFEST is never reported as LOG_WRITTEN.

### Lifecycle vocabulary (NITRO dogfood II)

Operation statuses split into two closed classes:

- **SETTLED** (`COMMITTED`, `ABORTED`): the operation owns no further
  mutation state. Recovery may not act; a committed retry returns
  ALREADY_APPLIED.
- **UNRESOLVED** (`PREPARED`, `APPLYING`, `VERIFIED`, `CONFLICT`): the
  operation still owns mutation state that must be resolved before any new
  canonical mutation.

`pending_ops()` lists every UNRESOLVED journal; `pending_conflicts()` lists the
CONFLICT subset. CONFLICT is stable evidence but NOT permission to continue.
Evidence that cannot be decoded or safely traversed is `CORRUPT_JOURNAL`, not
CONFLICT: preflight, mutation, recovery, release, status, next, and read-only
context all refuse with that exact code and preserve the structured detail.
Corrupt evidence is never constructed as a Journal and never replayed
automatically.

`saipen status` / `saipen next` surface recovery_pending and recovery_conflict;
`saipen recover` lists pending operations, recovers the mechanically safe ones,
and REFUSEs a conflict with the op named and evidence preserved rather than
hiding it. Repeated recovery is idempotent.

### Recovery preflight

Before ANY new canonical mutation the `pending_ops` journals are scanned, and
the FIRST matching rule decides:

- corrupt recovery evidence exists -> refuse CORRUPT_JOURNAL before replay;
- an unresolved CONFLICT exists -> refuse RECOVERY_CONFLICT naming the op;
- multiple unresolved -> refuse RECOVERY_REQUIRED naming the exact op_ids;
- exactly one recoverable -> recover/complete it first, and refuse with the
  evidence preserved if that recovery hits a conflict;
- none pending -> proceed.

### Recovery semantics

Recovery is ROLL-FORWARD and CONFLICT-SAFE. LOG is append-only evidence; once
the operation's LOG event exists, do not "rollback" by deleting it.

Per unfinished target:

- current hash == before_hash: apply the staged planned bytes;
- current hash == after_hash: already applied; advance;
- anything else: CONFLICT. Preserve journal + staged bytes, write nothing
  further, refuse to guess.

Per already-applied target the live bytes MUST equal after_hash; otherwise the
applied work was overwritten: CONFLICT.

Every journal records a `verification_policy` from a closed registry
(core_fast / improve_atomic_file / userperson / sub_lifecycle / none) and the
READ-ONLY preconditions the original plan read but did not write. Recovery:

1. rechecks every READ-ONLY precondition against the plan's allowed state --
   a changed read dependency is CONFLICT (the plan is no longer the authorized
   decision), never rolled forward over;
2. applies/validates each unfinished target (staged bytes MUST hash to the
   planned after_hash);
3. byte-verifies every written target;
4. reruns the operation's registered semantic verifier (the SAME postcondition
   class the original APPLY ran) -- a semantically invalid recovered state is
   CONFLICT, never VERIFIED/COMMITTED.

"VERIFIED" on the recovery path means the verifier actually ran and passed.

## 4. Idempotency

Every mutating operation carries an op_id owned by its journal. A retry after
client/model/process failure must not duplicate ticket movement, LOG events, or
counter increments. Before applying, check the op journal: already COMMITTED
returns ALREADY_APPLIED with the original result; interrupted operations are
recovered first. Never create a second equivalent operation while an unresolved
first one exists.

## 4a. Mechanical provenance

Every SAIOPS structural operation writes its LOG event WITH its op_id as an
`[op: <op_id>]` marker: claim, transition, checkpoint, ticket lifecycle, goal
pivot, valve reauthorization, stop. Ordinary semantic LOG entries carry no
marker.

The migration boundary is self-establishing: the first event in a project's
LOG history that ever carries an `[op: ...]` marker. Every structural event
at/after that boundary MUST carry one. The validator's `[saio]` check fails a
structural SAIOPS-owned event after the boundary that lacks `[op: ...]`, so a
manual structural edit that bypassed the engine is detectable and reported.
Pre-boundary history is exempt (append-only, cannot be rewritten).

In `mode: full` with Python available, covered maintenance MUST use SAIOPS;
manual structural editing is FALLBACK / RECOVERY ONLY and must record why the
mechanical path was unavailable.

### Dependency continuation transaction

`saipen ticket block-for A B REASON` is the sole active-parent handoff. PLAN
requires A to be the owned DOING ticket and B to be a workable TODO ticket.
APPLY journals and commits A→BLOCKED, `A needs B`, `blocked_on: B`, and A's
saved phase tuple together. While that reservation exists, B wins the Pick
Rule and `CONTINUATION_RESERVED` refuses every unrelated claim including
`--explicit`. Finishing B commits B→DONE and A→DOING with the restored tuple in
one operation. A failed/blocked B leaves A parked. Ordinary journal recovery
therefore cannot expose an intermediate second owner or two DOING tickets.

DEPENDENCY COMPLETION IS NOT A CLAIM EVENT (T-1436, measured E-7715/E-7716).
The resumed A carries a live claim only when the actor closing B presents the
SAME host-session binding the reservation saved for A -- the one mechanically
proven live session that legitimately holds the lease. Every other case (a
different session, no saved binding, no provable binding) restores A UNCLAIMED:
`owner`, `claim_time` and `claim_session` leave together (a half pair is
INVALID), the resume event records the previous owner as historical
attribution only, and the seat is adopted explicitly by whoever resumes the
Work. A mechanical resume must never refresh liveness metadata as though the
historical owner process reclaimed the seat.

HANDBACK (T-1473). `saipen start` parks the active Work behind a new request
with this same edge. When the request's SCOUT finds its first bounded Work IS
the Work it parked, `saipen ticket unblock <parked> <decision>` hands the seat
back: PLAN requires the holder to be this seat's active DOING ticket, the
reservation to be the actor's own (restore, never transfer) and every other
need of the parked Work DONE; APPLY returns the holder to the top of TODO
unclaimed and the parked Work to DOING at its saved phase tuple, pause edge
dropped, in one journaled transaction. Unblocking parked Work in any other
shape refuses with zero writes.

### Retirement transaction

`saipen ticket retire T-### --reason CODE --evidence REF --authority SRC-###
[--discovery-event E-###] [--note TEXT]` is the canonical disposition for Work
that was minted into the WRONG PROJECT. It is not `ticket done` and not
`source close`. It asserts exactly one thing:

    THIS WORK NEVER BELONGED TO THIS PROJECT'S EXECUTION HISTORY.

Nothing reaches `## DONE`, no coverage is fabricated, no disposition is
upgraded, and the request text is never rewritten. PLAN refuses -- zero
writes -- unless all of these hold:

- `--reason` is in the registered closed set (`RETIREMENT_REASONS`;
  `MISROUTED_PROJECT_BINDING` today). A free-text reason is
  `RETIREMENT_REASON_UNKNOWN`;
- `--authority` is an ACTIVE operator-ingress receipt (not an imported spec or
  external audit, not linked to the Work being retired) whose OWN STORED BYTES
  carry an operator-authority capsule GRANTING this ticket with exactly the
  receipts it carries. Naming Work is not authorizing it: "DO NOT retire
  T-1369 / SRC-048" grants nothing (`RETIREMENT_AUTHORITY_REQUIRED`). The
  capsule is a closed line grammar lifted verbatim from the first operator
  grant, so that decision (SRC-049) stays representable as written:

      This message supplies operator authority for:

          T-1368 / SRC-047
          T-1369 / SRC-048

      only.

  One item line per Work (`T-###` alone for Work without receipts), blank
  lines allowed, anything else inside makes the capsule malformed. A capsule
  inside a fenced code block is a quotation; two grants of one ticket with
  different receipt sets grant nothing. The grammar is consumed by
  retirement only;
- `--evidence` RESOLVES: a canonical LOG event `E-###` that precedes the
  retirement, or an owned regular artifact under `.saipen/evidence/` whose
  sha256 (CRLF folded to LF, so a checkout's line-ending policy is not a
  content change) is bound into every retirement carrier. Free text is a
  claim, not evidence;
- `--discovery-event` is OPTIONAL. Null means no canonical event ever recorded
  the discovery and the bound evidence alone carries the proof; when given it
  is a real LOG event that precedes the retirement. `--note` is an optional
  single bounded line;
- every named receipt is active, still hashes to its recorded digest, and is
  linked back to this exact ticket;
- the ticket is not under `## DONE` (`TICKET_ALREADY_DONE`): completed Work
  with closure evidence is history and cannot be rewritten as misrouted.

APPLY commits ONE journaled transaction: the LOG `DEC: RETIRE ...` event
(which carries the evidence binding inline and is never externalized), the
ticket's forensic record, the receipt's cold-storage bundle, the INVALID
tombstone, one intake index write, the BOARD row removal, and -- when a parent
was parked on this ticket by `block-for` -- that parent's restoration to its
saved phase tuple. Retirement is NOT "the dependency succeeded": the dependency
EDGE was invalid, because the child was never this project's Work. A crash
converges to the complete old set or the complete new set; a repeat returns
`ALREADY_RETIRED` and writes nothing.

RESTORE, NEVER TRANSFER. Retirement is a non-transferring mutation (CORE-001).
A restored parent goes back to the seat its own reservation names, and
`STATE.agent` follows that owner so STATE and BOARD never split. A foreign
actor restores the owner's claim verbatim, `claim_time` included -- forging
another seat's liveness would be a transfer by other means -- and is recorded
only as `actor B (seat A)` provenance; the owner acting itself refreshes its
claim. Without a restored parent the seat is preserved unchanged.

The BOARD row disappears from schedulable Work. The permanent evidence is LOG
plus `.saipen/archive/retired/`, which still answers what the ticket was, who
retired it, under which grant, which Source created it and what proved it
invalid. That archive is itself evidence and validates itself: every ticket
record and tombstone is checked structurally (schema, identity, BOARD row
digest, receipt/event/timestamp grammar, retirable section, restored parent),
the tombstone's `ticket_ref` must resolve to a regular non-reparse record for
the same Work telling the same story, the archived metadata must agree, the
namespace may hold no stray or linked artifact, retired Work may not be back
on BOARD, a bound artifact must still hash to its digest, and the events a
record cites must exist in LOG and say what the record says.

Schema-1 records (the first T-1370 slice: free-text evidence, authority by
identifier presence) are never valid state. Running the same `ticket retire`
on such a ticket RE-AFFIRMS it: today's authority and evidence gates run
against the SAME decision and reason, the ledger must back the old record, and
`RETIREMENT_EVIDENCE_BOUND` records the binding as a NEW event. The retirement
event, time, actor, BOARD row and restored parent stay verbatim; the old
free-text evidence survives as the note.

The retired namespace is `-text` in `.gitattributes`, like `intake/` and
`archive/source/`: its bodies are bound by raw digest, and a text-normalizing
checkout would otherwise report every retirement in a Windows clone as
tampered.

Retirement never deletes repository files: residue found alongside it goes
through CLEAN's own recovery gate.

### Work re-verification transaction

`saipen work reverify <T-###> [--verification <command>:PASS]...
[--run <command>]... [--timeout SECONDS]` re-checks already-DONE Work
against the CURRENT tree and writes ONE immutable `RV-NNNNNN` receipt under
`.saipen/recovery/conformance/reverify/`. It is not a lifecycle edge: DONE
stays DONE, no VERIFY boundary is fabricated, and no historical LOG event or
evidence blob is rewritten. The receipt is the ONE canonical cure for the
validator's `work_closure_evidence` gap; a current-tree `PASS` (or
`PASS_WITH_CARRIED_DEBT`) receipt bound to project identity, lineage,
ruleset and source fingerprint counts as closure evidence, while a newer
`FAIL` never hides behind an older `PASS`.

Checks come from exactly two places. `--verification cmd:PASS` records a
check the CALLER ran (a non-PASS attestation refuses with zero writes).
`--run cmd` makes the ENGINE execute the command in the project root and
record the real exit code (a timeout or non-zero exit is an honest FAIL).
With neither, the operation derives its contract from the project's own
strict gate and records that execution, so the validator's remediation is a
single executable command with no arguments.

The receipt binds `verification_contract_digest` (identity of the CHECKS,
not of their outcome), `original_closure` (owner, claim time, closure mode,
source receipts, last ticket-bearing event) and `verifier`. It is idempotent
for the same Work + same findings digest + same ruleset + same contract +
a successful receipt; after repair, a re-run writes a NEW receipt rather
than resurrecting an old verdict.

### Work supersession transaction

`saipen ticket supersede T-OLD --by T-NEW --evidence E-### --authority
SRC-###` terminally settles legitimate old Work through a later DONE Work. It
writes `closure_mode: superseded_verified`, `superseded_by`,
`supersession_evidence`, `supersession_authority` and
`implementation_delta: none` on the preserved DONE row. It never writes a
retirement record and never claims publication.

PLAN fails closed unless OLD and NEW are distinct, OLD is schedulable TODO or
BLOCKED Work, NEW exists under DONE, the exact PASS event is owned by NEW and
contains `[target: T-OLD]`, NEW has a later canonical completion event, the
relation is acyclic, and an ACTIVE operator-ingress receipt grants the exact
pair through this dedicated closed capsule:

    This message supplies operator authority for Work supersession:

        T-OLD - T-NEW

    only.

Fenced, malformed, unclosed, prose-only or conflicting capsules grant nothing.
The retirement capsule parser is not consulted. OLD carrying `source_receipts`
refuses `SUPERSESSION_SOURCE_MIGRATION_REQUIRED`; this first route does not
guess how Source authority migrates. A repeat of the identical settled tuple
returns `ALREADY_APPLIED` with zero writes.

Publication resolution may follow `T-OLD -> T-NEW` recursively, but success
still requires the successor chain to reach committed release evidence. DONE
and local Git commits remain insufficient publication authority.

## 5. Locks

One project-local lock file, `.saipen/locks/core.lock`, using real OS file
locking (msvcrt on Windows, fcntl on POSIX). The lock file carries no canonical
truth. Process death releases the OS lock. All Core-mutating operations acquire
the same canonical project lock; read-only operations do not. Project path
aliases resolve to the same lock identity.

## 6. Dry-run

Every mutation supports `--dry-run`: it acquires no mutation ownership, computes
the planned result, validates it, prints affected files and structural
before/after, and writes zero canonical bytes.

## 7. Operation result shape

Every operation returns a structured result:

```
{
  "ok": true, "code": "CLAIMED", "op_id": "...",
  "changed_files": [...], "event_id": "E-2437", "ticket": "T-551",
  "phase": "SCOUT", "next_action": "PHASE SCOUT T-551",
  "recovery_required": false
}
```

CLI prints concise human text by default; `--json` emits JSON only. Every error
message names one exact refusal and the executable next action. Stable error
codes: STALE_STATE, TICKET_NOT_FOUND, TICKET_NOT_WORKABLE,
TICKET_ALREADY_DONE, ILLEGAL_TICKET_LIFECYCLE, NOT_TOP_WORKABLE,
ACTIVE_TICKET_MISMATCH, ALREADY_CLAIMED, CONTINUATION_RESERVED, ACTIVE_CLAIM_FOREIGN, ILLEGAL_TRANSITION,
ILLEGAL_PHASE, WRITER_BUSY, VALIDATION_FAILED, RECOVERY_REQUIRED,
RECOVERY_CONFLICT, CORRUPT_JOURNAL, DESTRUCTIVE_CONFIRMATION_REQUIRED, CONFLICT,
NEEDS_REPAIR, PATH_ESCAPE, INVALID_ID, ACTIVE_IMPROVE_CYCLE,
INVALID_DISPOSITION, PACKAGE_INCOMPLETE, MALFORMED_PACKAGE,
INCOMPLETE_TICKET, INVALID_MANIFEST, INVALID_GOAL, STALE_PLAN, RELEASE_CLOSURE_PENDING,
TAG_CONFLICT, FIRST_PUBLISH_WAIT, NO_PUBLISH_MODE,
SOURCE_SCOPE_MISSING, RELEASE_FAILED, RETIREMENT_AUTHORITY_REQUIRED,
RETIREMENT_REASON_UNKNOWN, ALREADY_RETIRED, RETIRED, RETIREMENT_EVIDENCE_BOUND,
INVALID_AUTHORITY_CAPTURE.

The codes whose meaning is not self-evident from the name:

- `HOME_REQUIRED` -- STATE.saipen_home is missing or unusable. The executable
  next action is `saipen rebind-home --auto` when a canonical runtime is
  already proven (the executing engine or a verified carrier): it converges the
  dead pointer automatically (`HOST_BINDING_CONVERGED`, idempotent) rather than
  demanding the operator retype a path SAIPEN already found. When nothing is
  proven it refuses and names `saipen rebind-home <candidate>`: the explicit
  mechanical rebind, which proves the candidate install (readable `VERSION`,
  compatible major, `BOOT` layout, required protocol files) and journals a
  single narrowly-owned `STATE.saipen_home` pointer update.
- `CREW_BLOCKED` -- the EXPECTED crew result when the circuit has no executable
  semantic continuation: an unsatisfied stage needs inspection, not invention.
  The result carries the unsatisfied `stage`/`role`/`reason` and an
  inspect-required next action. A legitimate crew blocker is a structured
  result, never a traceback.
- `CREW_NOT_READY` -- the release executor's refusal when the human explicitly
  asks to publish while the crew epoch is not terminal. An ordinary ticket under
  an active crew epoch is DEFERRED to the crew, never silently published, and a
  terminal publication requires SC-0..SC-10 all explicitly satisfied; missing
  evidence is never PASS.
- `INVALID_SOURCE_HOME` -- the configured saipen_home is missing a REQUIRED
  source item (PROTOCOL.md/README.md/crew.md, the complete TEMPLATE surface, or
  any built-in role charter): zero writes, zero obsolete deletion, and the
  operator refreshes the install.
- `RELEASE_FAILED` -- the single stable code every public release refusal that
  is not a named preflight gate collapses to (subprocess/staging/commit/push/
  tag/receipt failures). The diagnostic stage and the underlying error stay in
  the result's `detail`/`stage` fields, never as new global codes.
- `ILLEGAL_PHASE` -- the gate refusal. `finish_ticket` (the atomic
  ticket-closure operation behind `ticket done`) accepts a ticket only from
  `phase: SHIP`, the canonical SHIP -> DONE closure edge; from
  SCOUT/BUILD/VERIFY/REVIEW it REFUSEs and writes zero canonical bytes, because
  a ticket whose required gates did not run must not be laundered into a
  legal-looking DONE state.

COMMIT FAILURE ALWAYS WINS: a failed commit returns its own refusal
(STALE_STATE / RECOVERY_REQUIRED / CONFLICT / WRITER_BUSY), never the plan's
semantic success metadata. WRITER_BUSY is a structured result, not a
traceback.

## 8. Fallback

Python is the preferred mechanical path under `mode: full`. If Python is
genuinely unavailable, use the documented manual protocol as compatibility
fallback, state that mechanical enforcement was unavailable, and run available
validation afterwards. A repository must remain readable without an executable
environment: canonical files are the cold truth, never a cache or engine state.

## 9. Effect-based authorization (T-1160, INC-PERMISSION-EFFECT-BYPASS-001)
<!-- RULE-OWNER: OPS-EFFECT-01 -->

AUTHORIZATION FOLLOWS EFFECT, NOT TOOL IDENTITY. The law lives in CORE § 1.1
(`OPS-EFFECT-01`); this section owns the deterministic vocabulary and mechanics.

**Closed effect vocabulary** (`tools/saipen_engine/effects.py`): `fs.read`,
`fs.write`, `fs.delete`, `repo.read`, `repo.mutate`, `process.execute`,
`network.read`, `network.write`, `external.mutate`. Mutating effects:
`fs.write`, `fs.delete`, `repo.mutate`, `network.write`, `external.mutate`.
Extending the set is a protocol change, not a code edit.

**Three separated concepts.** POLICY = what is authorized (derived from the
negotiated session capability by default; a project may tighten it through an
optional bounded `.saipen/policy.json` mapping effect -> ALLOW|MANUAL|DENY --
tightening never loosens). ENFORCEMENT = what the host prevents: UNAVAILABLE
unless declared via `SAIPEN_HOST_ENFORCEMENT` (`none`, `tool-conventions`,
`sandbox-readonly`); SAIPEN never claims a sandbox it cannot see, and a
MANUAL/DENY policy over a non-STRONG host surfaces as ENFORCEMENT_GAP.
AUDIT = what SAIPEN observes: cheap read-only Git worktree deltas
(`tree_snapshot`/`tree_delta`, porcelain only -- index/stash/HEAD untouched;
no Git means status UNAVAILABLE, never a fabricated clean bill).

**Tool contracts.** POSSIBLE != REQUESTED != OBSERVED. A dedicated edit tool
guarantees `fs.write`; a shell/interpreter POSSIBLY exercises anything and is
therefore never "read-only because the command looked harmless". Possible
effects are capability metadata for humans and diagnostics -- never proof.

**Shell preflight resolution bounds** (CORE § 1.4). Shell text visibly naming a
`.saipen` path -- quoted, Windows/POSIX separator, or simple-traversal
spellings -- is refused before execution; a standalone canonical `saipen
<verb>` keeps its operation exemption, and ordinary source-development shell
use remains available. Destructive EFFECTS are resolved from a bounded
delete/move/rename verb set with its documented flags, the explicit `bash -c` /
`powershell -Command` / `cmd /c` / `eval` wrappers, command substitution, and
the working directory as `cd`, `pushd` and `popd` move it; each resolved
effect is judged exactly as the file-tool effect it is. An effect whose
operands or working directory cannot be proven -- a variable, a pipeline, an
encoded command, a directory stack deeper than the guard tracks -- is refused
as unresolved, never admitted as ordinary shell. This is an accidental-
mutation barrier over explicit command text, not a sandbox: obfuscated or
dynamically computed paths stay outside its proof.

**Coverage evaluation** (`evaluate_coverage`) answers one question
mechanically: WHAT AUTHORIZATION COVERS THIS OBSERVED EFFECT? DENY fails
closed; MANUAL requires a scope-bound Approval naming the exact EFFECT
(optionally paths, Work, Attempt; one-shot unless reusable); an
`fs.write` approval implies `repo.mutate` of the same paths and NOTHING else
-- a `process.execute` approval never promotes to `fs.write`. Declared-but-
absent or observed-but-undeclared effects are EFFECT_DRIFT (review trigger,
never silently absorbed). Verdicts are mechanical facts:
AUTHORIZED / AUTHORIZATION_MISSING / SCOPE_MISMATCH / EFFECT_DRIFT -- they
say nothing about intent.

**Provenance** uses KNOWN/UNKNOWN/UNAVAILABLE literally: paths from observed
delta are KNOWN; originating process UNKNOWN without durable evidence;
pre-existing dirt and concurrent external edits are never attributed to the
active Attempt. Mutation evidence remains separate from validation, review,
and completion evidence.

**Diagnostic**: `saipen permissions` (READ_ONLY, `--json` capable) prints
policy + source + overrides, host enforcement truth, gaps, tool contracts,
and the current worktree delta.

## 10. Self-resolving gates (T-1161)

The law lives in CORE's protocol-state repair contract -- carriers the current
agent MUST execute rather than couriering to a human, the validator as a sensor
and never authority to falsify state, ship converging to shipped or a genuine
terminal boundary, and traceability surviving umbrella Work. This section owns
the deterministic mechanics in `tools/saipen_engine/disposition.py`.

**Closed disposition vocabulary**: `EXECUTE_SELF`, `RECONCILE_SELF`,
`WAIT_USER`, `WAIT_EXTERNAL`, `BLOCKED`, `COMPLETE`, `INVALID`.
`classify_carrier()` maps the fields SAIPEN carriers ALREADY emit
(`execute_in_current_agent`, `requires_human`, `terminal`, `crew_complete`,
`next_action`, stable refusal codes) onto exactly one disposition. It never
derives WAIT_USER from optionality: only an explicit `requires_human: true`
or a human-boundary WAIT category (`user brake`/`manual-verify`/
`destructive-op`/`first-publish`) yields it. `blocked`/`safety valve` WAIT
categories classify as BLOCKED -- they are not user questions. STALE +
refreshable classifies EXECUTE_SELF, never BLOCKED.

**User-wait proof obligation**: `user_wait_proof()` fails any WAIT_USER whose
proof is incomplete -- `missing_authority`, `evidence_insufficient`,
`consequence`, each a substantive sentence fragment. "Need user decision" is
not a proof.

**Traceability reconstruction**: `reconstruct_traceability()` passes an
umbrella ticket ONLY when every source finding carries its own disposition,
evidence, and explicit verification (`verified` / `rejected-with-evidence` /
`duplicate-of`) and the ticket durably references every finding ID.
FINDING_VALIDITY != EVIDENCE_FRESHNESS.

**Diagnostic**: `saipen explain-next` (READ_ONLY, `--json`) routes the same
next action as `next`/`cc` WITHOUT executing and reports the disposition,
the owner (agent/user), the selected action, and why the human is or is not
required. Decision-trace output for debugging autonomy; writes nothing.

**Meaningful automatic reconciliations** (state repaired against authority,
stale evidence regenerated, traceability reconstructed) are recorded through
the existing LOG DEC convention so a cold agent can answer "why did STATE
change from X to Y?" without chat history. Trivial formatting is not logged.

### Continuation reconciliation contract (normative)

Bare recover also reconciles machine-owned checkpoint drift. It recomputes
derived STATE counters/markers and regenerates the BOARD checkbox from the
BOARD section, then validates the proposed complete surface before committing
one existing journaled operation. The operation computes all target bytes
first and uses the normal multi-file CAS/atomic transaction; it never edits
implementation files or fabricates historical evidence.

The result codes are unambiguous: CLEAN means no repairable drift remains,
REPAIRED means the reconciliation committed, WARN means only truthful legacy
debt remains, BLOCKED means a semantic choice is needed, and CORRUPT means
safe parsing or ownership failed. CLEAN is forbidden when continuation would
still reject a reconciliation-owned defect. continue performs the same
reconciliation gate before routing; it repairs, revalidates, and then follows
the canonical next route. An active receipt with exactly one evidence-backed
ticket may be linked automatically. Multiple candidates produce
BLOCKED_AMBIGUOUS_SOURCE_RECEIPT with the receipt and candidate ticket IDs;
unrelated ambiguity is reported as a warning.

Legacy closure/provenance gaps are immutable historical debt. They remain
readable and are reported as legacy/unknown or WARN according to the
protocol-version boundary. The engine never invents filenames, commits,
timestamps, test results, or other evidence to make old records pass.

## 11. Validator remediation contract (T-1434 M5)

Every actionable machine-readable remediation the validator emits resolves to
exactly ONE of two kinds, and there is no third:

    REGISTERED_CANONICAL_COMMAND   a REGISTRY.json verb/action, classified in
                                   COMMAND_EFFECTS.json, parsed and dispatched
                                   by tools/saipen.py;
    TYPED_EXTERNAL_ACTION          a closed `external_kind` naming an actor
                                   SAIPEN is not (operator GUI verification,
                                   unavailable upstream credential, external
                                   publication authority, external project
                                   observation); never a command in disguise.

The closed table lives in `tools/saipen_engine/remediation.py`;
`tools/validate.py` extracts receipt remediation ONLY through that table, so a
failure message can never smuggle an unregistered command, an internal Python
function, a docs-only verb, a pseudocommand, or a generic `saipen validate`
recursion into the conformance receipt while a specific repair exists. The
conformance receipt carries the commands as `remediation_commands` and the
typed external requirements as `external_actions` (possibly empty); a machine
consumer distinguishes them by `kind`, never by prose.

`tools/test_remediation_self_consistency.py` is the ONE executable gate: for
every table entry it proves the registry identity, the effects classification,
the parser/dispatch owner (a structured engine answer to a nonexistent
target), the no-internal-function rule, and -- for the closure-evidence
remediation -- the full round trip (emit -> parse -> registry -> effects ->
dispatch -> execute -> validator green). A new emitted remediation without a
table entry fails the gate, not a review.

## 12. Foreign project authority and cross-repo provenance (T-1434 M6)

Binding precedence is unchanged: explicit `--project-root` > verified
host/session carrier (`SAIPEN_PROJECT_ROOT` + `SAIPEN_PROJECT_LINEAGE`) > Git
worktree > Git common worktree > nearest ancestor `.saipen` > refusal.

What the EXPLICIT root means depends on the caller's declared USE of it, a
closed authority value derived mechanically from the command's effect class:

    observe   DIAGNOSTIC effects. An explicit target may be bound
              deliberately even when the ambient session names another
              project: observing B from a session bound to A is legitimate,
              write-free observation and inherits no mutation authority.
              The validator itself resolves under `observe` -- its only write
              is the conformance receipt for the tree it was pointed at.
    mutation  every other effect. The explicit target must agree with every
              ambient carrier lineage, or the binding REFUSES
              (`PROJECT_LINEAGE_MISMATCH`): silently mutating a foreign
              project merely because `--project-root` was supplied stays
              impossible. A coherent carrier set (root + lineage naming the
              target) authorizes the repair surface normally.

Cross-repository provenance is one closed model (`fix == local patch` is no
longer an assumption). Each semantic class has its durable representation:

    local implementation                      closure_mode: own_patch
    external implementation verified locally  closure_mode: external_implementation
                                              + EX-NNNNNN receipt, resolution_reason
                                              PROTOCOL_HOME_FIX_VERIFIED |
                                              UPSTREAM_FIX_VERIFIED |
                                              DEPENDENCY_UPGRADE_VERIFIED
    dependency upgrade satisfying local Work  resolution_reason:
                                              DEPENDENCY_UPGRADE_VERIFIED
    protocol-home repair for a product defect resolution_reason:
                                              PROTOCOL_HOME_FIX_VERIFIED
    superseded local Work                     closure_mode: superseded_verified
                                              + superseded_by

External authority is a STABLE IDENTITY, never a URL: `--authority` must be a
portable `lineage-<32hex>`, the implementation a `T-###@commit`, and the
receipt binds the installed engine generation. Arbitrary URLs, ticket ids and
free text are refused by the grammar; the receipt predicate is shared by the
closure resolver and the validator
(`tools/test_foreign_observation_authority.py`).
