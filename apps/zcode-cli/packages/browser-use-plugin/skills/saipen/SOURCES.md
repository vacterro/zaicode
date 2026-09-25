# saipen SOURCES — durable external intent

This contract eliminates chat-only authority: a detailed audit must not die
when chat, model, provider, or session state disappears. It owns the source
receipt lifecycle; CORE owns precedence and Work completion, BOOT owns read
order, and the engine owns mechanical validation.

## Authority and lifecycle
<!-- RULE-OWNER: SOURCE-AUTHORITY-01 -->

For external Work intent, authority is: original immutable receipt, explicit
later amendment, derived Work Contract, BOARD/STATE projection, agent memory.
The layers answer different questions and are never merged into one document.

`RECEIVE -> CAPTURE -> VERIFY -> LINK -> NORMALIZE -> EXECUTE -> COVER ->
REREAD -> CLOSE -> ARCHIVE/PURGE`

Capture precedes interpretation. The UTF-8 source body is opaque data and is
written first; its sidecar records `receipt_id`, `source_sha256`, kind,
transport facts, time, lifecycle status, amendment and Work linkage. The digest
covers body bytes only. Metadata, BOARD titles and agent summaries are not part
of the digest and cannot replace the body.

Canonical project paths:

- `.saipen/intake/active/SRC-NNN.md` and `.meta.json`: hot immutable authority;
- `.saipen/intake/contracts/SRC-NNN.json`: derived, revisioned interpretation;
- `.saipen/intake/coverage/SRC-NNN.json`: clause disposition and evidence;
- `.saipen/intake/tombstones/SRC-NNN.json`: compact verified closure;
- `.saipen/archive/source/`: cold forensic bodies and derived closure records.
- `.saipen/intake/distribution/SRC-NNN.json`: export-safe quarantine record;
- `.saipen/quarantine/source/SRC-NNN.md`: exact local, non-exportable authority.

Archived source bodies are excluded from ordinary startup, status, context,
validation and Work selection. Explicit forensic `source show` may read them.
State-only exports include distributable receipt authority and the metadata
required to identify quarantined authority. They never include the protected
quarantine namespace.

## Distribution state
<!-- RULE-OWNER: SOURCE-DISTRIBUTION-01 -->

This contract eliminates source-authority/distribution conflation: exact bytes
may remain valid local authority while publication of those same bytes is
forbidden. Lifecycle status (`ACTIVE`, `CLOSED`, `INVALID`, `RETIRED`) never
grants distribution permission and quarantine never changes lifecycle truth.

A receipt with no quarantine record is `DISTRIBUTABLE`. This is the explicit
compatible default for pre-contract receipts: they were already exportable,
and pretending historical publication can be undone would add no safety. The
operator may monotonically mark any active or archived receipt `QUARANTINED`.
The engine moves its byte-identical body under `.saipen/quarantine/source/`
and writes a digest-bound record under `.saipen/intake/distribution/`. No
operation downgrades that record. Dedupe, amendments, Work linkage, coverage,
reread and forensic `source show` continue to use the exact protected body.

Every canonical release, whole-project handoff and state-only exporter excludes
the protected namespace and retains the safe record (`receipt_id`,
`source_sha256`, state, bounded reason and body-export flag). Credential
detection may trigger a quarantine decision, but regex non-detection is never
distribution authority: `source quarantine` is the independent operator route.

An exact active or archived credential-bearing receipt refuses publication
with `SOURCE_CREDENTIALS_UNSAFE` and
`canonical_next_command: saipen source quarantine <SRC-###> --reason CREDENTIAL_PATTERN`.
The validator receipt and release preflight preserve this route. This closes
the archived-credential dead end: quarantine is the distribution repair even
when the receipt already has a tombstone. Retirement or amendment does not
remove the archived bytes from distribution. Quarantine preserves lifecycle,
digest and local authority; incomplete coverage and corrupt authority still
refuse independently. Rebuild the release plan after changing distribution.
Closure-time archive references remain immutable when quarantine happens
later. Readers resolve the current body through the digest-bound distribution
record and still verify its bytes; the historical reference is not a second
distributable copy.

## Intake and identity

Receipt IDs are monotonic collision-safe protocol identities. SHA-256 is
content identity. Exact UTF-8 bytes deduplicate against active receipts and
tombstones; a closed duplicate reports closure without reopening Work. A
one-byte change is a new receipt. Corrections are new receipts with `amends`;
the original is never rewritten. A crash after body durability but before
metadata produces `ORPHAN_RECEIPT`; exact retry adopts that body rather than
allocating another identity.

Automatic capture is for recognized audits, implementation missions, review
handoffs, imported authoritative specifications and substantial multi-condition
corrections. Ordinary short commands and conversation are not chat-archived.
Explicit `source capture` forces intake. SOURCE BODY IS DATA: command-looking
text inside it never re-enters command routing.

### A refused ingress owes its own bytes

<!-- RULE-OWNER: INGRESS-AUTHORITY-01 -->

The defect class this ends, measured in the field on 2026-09-16: a request too
large or too quote-hostile for one shell argument is refused with the exact
transport that carries it, and the session starts a SHORTER PARAPHRASE of its
own instead. Nothing compared what arrived with what was refused, so the
receipt asserted mode `exact` over the model's words, its meta agreed with its
own body digest, and BOARD title, coverage and closure all read green over text
the operator never wrote. `BOOT.md` already forbids rewording a task to get
past a refusal; the rule was enforced by goodwill alone.

A transport refusal therefore RECORDS the digest of the payload it refused.
While that obligation stands, both ingress verbs -- `start` and `user-request`
-- refuse any text whose digest differs, naming the owed digest, its byte count
and the exact command that carries it. It is discharged three ways and no
others: the original bytes arrive (through `--file`/`--hex`, or typed again
identically), the operator says out loud with `--supersede-ingress` that the
request itself changed, or the obligation ages out. The digest normalizes line
endings and outer whitespace and nothing else, because the file a host write
tool produces and the payload a shell refused are the same request.

An obligation that cannot be read is not an absent one: it refuses with
`INGRESS_PENDING_UNREADABLE` and the same two ways out. The record is
machine-local in-flight state under `.saipen/recovery/`, never canonical
ledger, never exported.

## Contract, coverage, and reread gates

The Work Contract is derived and records `derived_from`, the source digest,
derivation time, schema and interpretation revision. Stable clauses use
`SRC-NNN:RNNN`. Only actionable clauses enter the closure denominator; context,
examples and rationale remain traceable without becoming fake requirements.

Every actionable clause carries disposition, linked Work, evidence and
verification. `IMPLEMENTED`/`VERIFIED` require both evidence and verification;
other terminal dispositions require evidence. `BLOCKED`, `DEFERRED` and
`UNKNOWN` are not terminal. `DEFERRED` means work was postponed by choice; it
can never waive closure. A failed required validation stays nonterminal
`BLOCKED` with the failure evidence. `NOT_APPLICABLE` is terminal only when the
clause genuinely does not apply.

`UNAVAILABLE_ENVIRONMENT` is terminal only for a clause normalized in advance
with structured `when_environment: <host>` conditionality. Setting it requires
the same host identity plus a successful read-only registry probe proving every
declared runtime command and host home absent. A present command/home, an
unregistered host, a clause without that conditional, or a hand-written proof
refuses; an agent cannot retrofit environmental optionality onto unfinished
work. An unconditional external requirement that cannot run is `BLOCKED` in
source coverage and `BLOCKED_EXTERNAL` at Work lifecycle level.

Parent Work cannot reach DONE and SHIP cannot pass while linked active source
integrity, contract provenance or coverage is red.

The original body, contract and coverage are reread/checked at intake,
implementation entry, review convergence, Work DONE, source closure and ship
when release-affecting. Mechanical gates verify exact digest and structural
coverage; agents own semantic clause extraction. Model memory is navigation,
never authority.

### A receipt says whose words it holds

<!-- RULE-OWNER: REQUEST-PROVENANCE-01 -->

The defect class this ends, measured live on 2026-09-17: a session handed a
520-byte request ran the ingress with a 46-character substitute it wrote itself,
and nothing in the receipt contradicted it. `source_authority: exact` is a true
statement about BYTES -- the stored body is whole and unredacted -- and it was
being read as a statement about WORDS. INGRESS-AUTHORITY-01 only arms when a
transport refusal recorded something; a session that never attempted the literal
ingress was never refused, so nothing compared anything.

Every `user_instruction` receipt therefore records its WITNESS:

| witness | who compared what |
|---|---|
| `operator_carrier` | something outside the session declared the task's digest and the arriving text matches it |
| `transport_obligation` | a transport refusal recorded these exact bytes and they arrived |
| `model_supplied` | nobody compared anything |

`model_supplied` is honest, not degrading: most sessions have no carrier, and
refusing them would make the protocol unusable while inventing a witness would
be the fabrication this rule exists to stop. What IS refused is a contradiction:
a declared task whose digest differs from the text that arrived
(`INGRESS_TASK_MISMATCH`), and a carrier that declares a task it cannot prove
(`INGRESS_TASK_CARRIER_INVALID`) -- an environment that meant to declare one and
failed is not the same as an environment that never declared one.

The carrier is `SAIPEN_TASK_SHA256`, or `SAIPEN_TASK_FILE` when a launcher can
write the text but not a digest. Digests normalize line endings and outer
whitespace exactly as INGRESS-AUTHORITY-01 does, so a launcher's file and a
shell payload are the same request.

### A request is one requirement, and the Work's own proof discharges it

<!-- RULE-OWNER: REQUEST-CLAUSE-01 -->

The defect class this ends, measured live on 2026-09-17: `saipen start`
captured its receipt with an empty Contract, `coverage_complete` requires at
least one actionable clause, so the closure gate answered `SOURCE_UNRESOLVED`
for that receipt forever and **the ticket the canonical entry command creates
could not be finished by any command the CLI offers** -- the two functions that
could have changed it are Python-only. Two independent field sessions drove the
whole chain, edited their target, and looped there.

A request is not zero requirements. It is exactly one: the text the operator
wrote. At closure, each linked `user_instruction` receipt gets that clause if it
has none, and the clause is settled from the SAME verification evidence the Work
gate already demands -- one proof, not two. Nothing is settled when that
evidence is absent, and a clause an agent DERIVED from a larger specification is
never settled from here: it is that agent's own claim, and it keeps the closure
gate red until the agent settles it with its own evidence. A clause counts as
the request's own exactly when its text equals the request body's own
`## Request` section, so the distinction is read from bytes rather than
declared.

### An operational append is mission state, not prose

<!-- RULE-OWNER: SOURCE-APPEND-01 -->

The defect class this ends: the operator hands a RUNNING mission one more
operational file -- a replacement handoff after `/new`, ten small bricks over an
afternoon, or one line saying a recoverable binding failure must fall back to
direct launch -- and the agent answers with a summary of it. The requirement
reaches no receipt, no coverage and no routing, so it exists only in a chat
transcript the next incarnation will not see, and the operator has to restate it
by hand. Transport was never the variable: pasted text, an attached `.md`, a
2,000-line mega handoff and a one-invariant brick are the same input form.

An append is an immutable receipt captured VERBATIM with `amends: <SRC-###>`.
The controlling source's bytes are never edited, and exact-digest dedupe makes
the same file supplied twice ONE append. A per-source ordered ledger at
`.saipen/intake/appends/SRC-###.json` carries each append's class, delta,
supersession and processing state, so RECEIVED-but-unprojected is a machine
fact: `saipen continue` routes `saipen source apply-append SRC-###` ahead of any
phase continuation, and the mission cannot proceed as if the append had not
arrived.

Projection derives traceable clauses deterministically from the normative units
of the body (`MUST` / `MUST NOT` / `never` / `do not`, and list or fenced units
under an acceptance or test heading), binds them to the controlling mission's
Work, and marks what the append supersedes SUPERSEDED -- never deleted, and
terminal evidence survives. Identical texts collapse, so ten bricks and the one
consolidated handoff assembled from them derive the SAME clause set: project
behaviour does not depend on how the operator grouped the instructions. Every
step is individually idempotent, so a crash mid-projection is completed by the
next call, never duplicated, and repeated content never mints a second Work.

Rewind is the minimum truthful one. Only an `implementation` delta returns a
Work that already moved past BUILD; an evidence-, review- or packaging-only
append leaves the Work where it stands, because its unresolved clause already
gates closure. An append is never refused for arriving late, arriving during
BUILD, being larger than the current ticket, or overlapping work already done --
those are reconciliation, not operator blockers. A NEW_MISSION goes through
normal intake instead: unrelated missions are never silently merged.

Semantic judgement stays with the agent. The class, the delta and what an append
supersedes are explicit inputs, because only a reader can tell an amendment from
a different mission. Everything mechanical -- identity, ordering, derivation,
supersession, rewind, routing -- is decided once, here.

## Closure and retention

Closure requires: digest PASS, contract bound to that digest, every actionable
clause terminal with sufficient evidence, and linked Work DONE. Default
retention immediately removes the body/contract/coverage from the hot surface,
moves them to cold archive, and leaves a tiny tombstone. `purge --confirm` is an
explicit destructive retention option: it removes cold bodies but retains the
digest and closure tombstone, so full forensic reproduction is honestly lost.

### Retirement -- terminal without being successful

A receipt reaches a tombstone by exactly two routes, and they mean opposite
things. CLOSED means the request was implemented and proven here. INVALID
means it never belonged to this project's execution history at all: the
ingress resolved the wrong project root and minted Work in the wrong
repository. A misrouted receipt has no terminal coverage and must never be
given any -- inventing a disposition to reach CLOSED is the fraud retirement
exists to remove.

`saipen ticket retire` (OPS.md) is the only writer of the INVALID tombstone.
It preserves the receipt id, the exact source bytes and their digest, the
untouched Contract and coverage ledgers, the original linked Work, the reason
code, the resolved evidence binding, the operator authority receipt with its
digest and exact grant line, the optional discovery event and the retirement
event, in `.saipen/archive/retired/`. `saipen source status SRC-N` reports
`location: retired` with that record and `saipen source show SRC-N` still
returns the body verbatim. Nothing is purged: what the rogue fixture injected
stays exactly readable.

Unlike a closed archive, a retired bundle IS read by ordinary validation: it is
the only evidence that Work vanished honestly, so its body digest, metadata,
ticket record, bound evidence artifact and the LOG events it cites are
re-proven every time, and any drift is a validation failure.

Legacy Work remains readable with unavailable/unknown source provenance. A
BOARD title is never converted into a fake verbatim receipt. Guarantees start
only when a real receipt was committed.

## Commands

- `saipen source capture --file SPEC [--kind KIND] [--work T-N] [--amends SRC-N]`
- `saipen source status SRC-N` / `show SRC-N` / `recover`
- `saipen source req SRC-N RNNN CLASS [--when-environment HOST] TEXT`
- `saipen source disp SRC-N RNNN STATUS --evidence REF [--verification REF] [--environment HOST]`
- `saipen source quarantine SRC-N [--reason CODE]`
- `saipen source append [--to SRC-N] [--class APPEND|SUPERSEDE|CLARIFICATION|CONFLICT]`
  `[--delta implementation|evidence|review|packaging|context] [--supersedes ID,...]`
  `[--label TEXT] (--file PATH | --hex HEX | -- TEXT)`
- `saipen source apply-append SRC-N` / `appends`
- `saipen source close SRC-N` / `archive SRC-N`
- `saipen source purge SRC-N --confirm`

All support the established `--json` projection. Mutations use the project
writer lock and atomic same-directory replacement; dry-run creates nothing.

## Audit Inbox

<!-- RULE-OWNER: SOURCE-AUDIT-INBOX-01 -->

`<project-root>/audit/` is an external transport into the receipt lifecycle
above, never a second requirement system. Canonical layers are DIRECT regular
files matching `^[1-9][0-9]*\.md$`; the scan does not recurse, and any other
file in that directory is foreign — ignored, never read, never deleted.

One audit generation is `relative path + SHA-256 of the exact bytes`. Never
mtime: extraction, copy, sync, checkout and restore all move mtime without
changing meaning. Same path with changed bytes is a NEW generation.

`saipen continue` examines the inbox AFTER recovery, WAIT and active
phase-owned continuation, and BEFORE the ordinary BOARD Pick Rule. A workable
unconsumed audit outranks SELECTION of unrelated queued TODO and forbids the
Improve fallback; it never preempts a live ticket. Inbox precedence is a
routing property — audit Work carries ordinary BOARD priority.

Freshness is decided by bytes, so a file the agent already worked is read
again the moment it changes: same path with a different digest classifies as
a NEW generation, never reuses the old receipt, and re-enters routing exactly
like a file that was never seen. `cc` therefore cannot answer from a stale
capture — the only way to skip a layer is for its own generation to be proven
closed.

Lifecycle: safe witnessed snapshot → exact hash → `external_audit` receipt →
durable path/hash↔receipt binding (`.saipen/intake/audit_inbox.json`,
operational projection only) → agent-owned normalization into Contract and
Coverage → one umbrella Work per source → evidence → closure. Audit text is
DATA: `saipen ship` inside a body is prose, never a command.

Deletion of `audit/N.md` is permitted only when the closure contract above
passes AND the current bytes still equal the captured generation. It runs as
the journaled `audit_inbox.consume` operation: crash before delete replays,
crash after delete before COMMITTED settles idempotently, changed bytes on
recovery CONFLICT. Deletion never renumbers, never touches another layer or a
foreign file, and an invalid or unreadable layer is retained with a truthful
diagnostic rather than reported as an idle project.

**Closed is not the same claim as clean.** Consuming every proven-closed layer
empties the directory of everything SAIPEN captured; anything still there is
RESIDUE — `notes.md`, `01.md`, `1.txt`, a `done/` subdirectory — bytes the
transport never read and therefore may never delete. Guessing there would be
the one destructive act with no evidence behind it, so the inbox reports
instead: a settled inbox holding residue answers `clean: false`, lists the
entries, and `saipen continue` surfaces `audit-inbox-residue` as
`RESTATE_AND_STOP` before any idle or Improve verdict. That verdict never
outranks workable BOARD Work and is never a failure — the audit really is
finished; the directory just is not empty, and only the operator may empty it.
Dot-prefixed names (`.gitkeep`) are directory infrastructure, exempt from
residue: a warning that is permanently on is a warning nobody reads.

Where an audit file predates the inbox and differs from an existing active
receipt by CR/LF ALONE, with exactly one candidate of an audit/mission source
class, it may bind as `legacy_transport_equivalent`: both digests are recorded
and the receipt digest is never rewritten. Any other difference is a new
source. Byte identity stays strict.

- `saipen audit status` / `inspect N` — read-only projection, no body dump
- `saipen audit ingest` — settle proven cleanup, then capture the lowest
  workable layer and derive its Work. `cc` routes here on its own.

## Producer enqueue

<!-- RULE-OWNER: SOURCE-AUDIT-ENQUEUE-01 -->

A producer — a person's script, AUDAPACK, a future SAIPAL — hands SAIPEN BYTES
and an operation id. It never names a path and never picks a layer number.
That removes the defect class where two producers each compute "the next free
number" and one silently overwrites the other's audit.

Layer numbers come from `.saipen/intake/audit_allocator.json` and only go up.
A number that was consumed and deleted is never handed out again: every
downstream provenance record keys on it. A hand-dropped `audit/99.md` raises
the floor instead of being overwritten.

Placement is reserve-then-place. The allocation and the operation record are
durable BEFORE the bytes land, so a crash costs at most one spent id and a
retry with the same `producer_operation_id` finishes the SAME layer instead of
enqueueing a second copy. A retry carrying different bytes is refused, and a
refused placement frees the operation while keeping the id spent. The lock
covers allocation and placement only — never analysis, never Source
processing.

A layer MAY open with one optional envelope (`<!-- saipen-audit-envelope`,
`key: value` lines, closed by `-->`). Plain Markdown without one stays valid;
parsing is pure, so the file digest is unaffected; a malformed envelope
degrades to "no usable metadata" and never blocks capture or authorizes
deletion. Every field is a Source CLAIM: severity, confidence and proposed
fixes are read as text, no routing or priority decision consults them,
`maintainer_verdict` is PENDING on intake — a producer cannot approve its own
finding — and no code path branches on WHICH producer sent an audit.

Provenance is written once at capture into the layer binding and outlives the
file: after the bytes are journaled away the record still names the digest,
the producer, their item id, the receipt, the Work and its closure. Rejection
is a valid closure.

- `saipen audit enqueue --producer NAME --operation-id ID [--item-id ID]
  (--file PATH | --text ...)` — the only producer writer
- `saipen audit trace [N]` — read-only audit→receipt→Work→disposition
