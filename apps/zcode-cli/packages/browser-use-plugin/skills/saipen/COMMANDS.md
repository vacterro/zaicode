# SAIPEN Command Surface

This document owns command semantics. `REGISTRY.json` owns the closed machine
facts consumed by the engine; no runtime parses this prose. CORE owns only the
global authority and deterministic priority rules.

## Shortcut table

<!-- RULE-OWNER: CMD-ROUTING-01 -->

| Input | Routes to | Rule ref | Notes |
|-------|-----------|-----------------|-------|
| `gg` | `saipen goal` | CMD-ROUTING-01 | New goal; payload is the objective |
| `hh` | `saipen hunt` | CMD-ROUTING-01 | Autonomous defect/improvement scan |
| `ff` | `saipen focus` | CMD-ROUTING-01 | Read-only closer inspection |
| `xx` | `saipen cut` | CMD-ROUTING-01 | `xx confirm <CUT-ID>` authorizes the planned mutation |
| `vv` | `saipen build` | CMD-ROUTING-01 | Bounded foreground Work |
| `zz` | `saipen undo` | CMD-ROUTING-01 | Restore the last safe milestone |
| `cc` | `saipen continue` | CMD-CONTINUE-01 | Resume the active intent through deterministic routing |
| `ccc` | `saipen continue` | CMD-CONTINUE-01 | Converge target `ship`, then refresh stages J-M |
| `st` | `saipen stop` | CMD-ROUTING-01 | Checkpoint and return control; `ss` retired |
| `sss` | `saipen status` | CMD-ROUTING-01 | Read-only status |
| `dd` | `saipen plan` | CMD-ROUTING-01 | Plan; payload supplies user items |
| `aa` | `saipen markhunt` | CMD-ROUTING-01 | Dry audit; records, never fixes |
| `qq` | `saipen prepare saiwiki` | CMD-ROUTING-01 | Force-fresh wiki package |
| `qqq` | `saipen collect saiwiki` | CMD-ROUTING-01 | Integrate ready wiki package, then ship |
| `ee` | `saipen prepare saitranslate` | CMD-ROUTING-01 | Force-fresh translation package |
| `eee` | `saipen collect saitranslate` | CMD-ROUTING-01 | Integrate ready translation package, then ship |
| `pp` | `saipen sub spawn saipython` | CMD-ROUTING-01 | Python tooling role |
| `tt` | `saipen test` | CMD-ROUTING-01 | Run the declared suite, read-only |
| `sc` | `saipen crew` | CMD-ROUTING-01 | Serial full-platoon convergence circuit |

## Canonical commands (non-shortcut)

| Command | Phase / Action | Rule ID |
|---------|---------------|---------|
| `saipen set` | INIT | CMD-ROUTING-01 |
| `saipen init` | INIT | CMD-ROUTING-01 |
| `saipen continue` | router | CMD-CONTINUE-01 |
| `saipen goal <text>` | PLAN | CMD-ROUTING-01 |
| `saipen clean` | CLEAN | CMD-ROUTING-01 |
| `saipen translate` | TRANSLATE | CMD-ROUTING-01 |
| `saipen validate` | canonical Core-conformance front door: structural precheck on STATE/BOARD/LOG, then the canonical full validator (`tools/validate.py --gate core`) whose receipt decides; VALID only on CURRENT_PASS | CMD-ROUTING-01 |
| `saipen prepare <producer>` | PREPARE | CMD-ROUTING-01 |
| `saipen collect <producer>` | router | CMD-ROUTING-01 |
| `saipen ship` | SHIP | CMD-ROUTING-01 |
| `saipen push` | SHIP | CMD-ROUTING-01 |
| `saipen improve [action]` | meta | CMD-CONTINUE-01 |
| `saipen improve reconcile <cycle>` | BUILD/RECOVERY: strict-cycle finite exit; classify every seat, execute lossless transitions, refuse while actionable work remains, terminalize COMPLETE/SUPERSEDED/BLOCKED_EXTERNAL; idempotent | CMD-ROUTING-01 |
| `saipen ticket reasoning <T-###> --recurrence <text> --weak-model <text>` | BUILD: canonical writer for the strict-sweep reasoning gates; refuses unless a strict CONFIRMED PROTOCOL_VIOLATION disposition names the ticket | CMD-ROUTING-01 |
| `saipen status` | read-only | CMD-ROUTING-01 |
| `saipen autonomy` | read-only: the supervisor's ONE verdict (RUN_WORK, ADOPT_WORKER, REPLACE_WORKER, AWAIT_WORKER, OPERATOR_ACTION_DUE, NO_PROGRESS_LOOP, AMBIGUOUS_AUTHORITY, IDLE) plus the observation that produced it -- lease generation and heartbeat age, executable Work, due/deferred operator gates, no-progress verdict. Writes nothing; ambiguous lease authority fails closed for mutation | CMD-ROUTING-01 |
| `saipen autonomy recall` | read-only AUTO_RECALL + turn-entry decision for a replaced/cold agent (RUNTIME.md) | CMD-ROUTING-01 |
| `saipen gpu [status\|on\|off\|index\|recall <text>\|triage]` | DIAGNOSTIC: idle-GPU lane, default OFF (`SAIPEN_GPU=off` wins); a local embedding model indexes Work/decisions/knowledge, a local chat model annotates red declared-family runs (mechanical groups, one hypothesis each), both while the card is idle and beside `supervise`; ADVISORY only, writes only `.saipen/cache/` (gpu.py) | CMD-ROUTING-01 |
| `saipen context orient [--handoff JSON]` | bounded current-truth orientation | CONTEXT-BUDGET-01 |
| `saipen brief` | generated handoff with identity/lineage/event provenance | CONTEXT-BUDGET-01 |
| `saipen acceptance <T-###>` | read-only | CMD-ROUTING-01 |
| `saipen runtime` | read-only | CMD-ROUTING-01 |
| `saipen host bootstrap [--host ID] [--project-root PATH]` | read-only host/runtime binding diagnostic; `HOST_UNSUPPORTED` for unregistered hosts | CMD-ROUTING-01 |
| `saipen host activation --project-root PATH` | read-only; does the managed project's resolved runtime carry the activation contract | CMD-ROUTING-01 |
| `saipen rebind-home --auto` | RECOVERY: converge a dead persisted home onto an already-proven runtime (`HOST_BINDING_CONVERGED`; refuses `HOME_REQUIRED` when nothing proves) | CMD-ROUTING-01 |
| `saipen rebind-home <candidate-home-path>` | RECOVERY: explicit re-point of `STATE.saipen_home` onto a proven install | CMD-ROUTING-01 |
| `saipen search <pattern>` | read-only bounded search | CMD-ROUTING-01 |
| `saipen --agent <seat> launch opencode -- [args]` | optional explicit-actor host process | CMD-ROUTING-01 |
| `saipen knowledge [status\|index\|retrieve]` | project knowledge | CMD-ROUTING-01 |
| `saipen start '<task>' [--file PATH] [--hex HEX] [--receipt SRC-###]` | THE entry command for a new actionable task: capture, recover, seat, claim | CMD-ROUTING-01 |
| `saipen user-request <text>` | USER_INTERRUPT ingress | CMD-ROUTING-01 |
| `saipen ticket retire <T-###> --reason <CODE> --evidence <E-###\|.saipen/evidence/PATH> --authority <SRC-###> [--discovery-event E-###] [--note TEXT]` | canonical retirement of misrouted/invalid Work -- NOT done, NOT close; the authority must GRANT it (OPS.md) | CMD-ROUTING-01 |
| `saipen work reverify <T-###> [--verification <command>:PASS]... [--run <command>]... [--timeout <SECONDS>]` | RECOVERY: re-verify already-DONE Work against the CURRENT tree; writes ONE immutable `RV-NNNNNN` receipt, keeps DONE, never rewrites history (OPS.md); only an EXECUTED contract is current-tree closure evidence, an attested-only contract is recorded but never closure proof | CMD-ROUTING-01 |
| `saipen ticket resolve-external <T-###> --authority <lineage-32hex> --implementation <T-###@commit> --reason <CLASS> --run <command>...` | EXECUTION: close BLOCKED Work implemented by an external authority with an immutable `EX-NNNNNN` receipt bound to the installed engine generation (OPS.md) | CMD-ROUTING-01 |
| `saipen ticket repair-metadata <T-###> --field source_receipts (--to <SRC-###> \| --legacy-unbound [--authority <SRC-###\|lineage-32hex>])` | RECOVERY: migrate malformed legacy metadata on historical DONE Work; `--to` needs an exact linked receipt, `--legacy-unbound` removes an unprovable token and preserves its bytes in an immutable `MR-NNNNNN` receipt; non-DONE rows and conflicting second migrations refuse with zero writes (T-1435) | CMD-ROUTING-01 |
| `saipen ticket reasoning <T-###> --recurrence <text> --weak-model <text>` | EXECUTION: canonical writer for the strict-sweep reasoning gates; refuses unless a strict CONFIRMED PROTOCOL_VIOLATION disposition names the ticket | CMD-ROUTING-01 |
| `saipen cohort [status\|ship] <C-###>` | batch publication authority | CMD-ROUTING-01 |
| `saipen source` | intake | CMD-ROUTING-01 |
| `saipen source retire <SRC-###> --reason <CLASS> [--successor SRC-###] [--note TEXT]` | EXECUTION: receipt-only source retirement; cold-copies the original bytes, refuses while any unresolved actionable requirement would be discarded or live Work names the receipt (OPS.md) | CMD-ROUTING-01 |
| `saipen source link <SRC-###> --work T-###` | EXECUTION: canonical multi-work membership (T-1437); adds ONE Work to a receipt's durable membership, never moves the historical primary `linked_work`, idempotent, refuses an unknown receipt / Work / integrity failure with zero writes | CMD-ROUTING-01 |
| `saipen source append [--to <SRC-###>] [--class APPEND\|SUPERSEDE\|CLARIFICATION\|CONFLICT] [--delta implementation\|evidence\|review\|packaging\|context] [--supersedes <ID,...>] [--label TEXT] (--file <PATH> \| --hex <HEX> \| -- <TEXT>)` | INGRESS: make ONE operational handoff/brick durable against the controlling mission source (T-1461); verbatim immutable receipt with `amends:`, exact-digest dedupe, ordered per-source ledger; never edits the source it amends (SOURCES.md) | CMD-ROUTING-01 |
| `saipen source apply-append <SRC-###>` | EXECUTION: project the oldest RECEIVED append into requirements, Work and the minimum truthful rewind; idempotent and crash-resumable; what it supersedes becomes SUPERSEDED, never deleted (SOURCES.md) | CMD-ROUTING-01 |
| `saipen source appends` | DIAGNOSTIC: read-only per-mission append view status shares -- latest append, active and superseded clause counts, unprojected appends, affected Work | CMD-ROUTING-01 |
| `saipen source recover` | DIAGNOSTIC: read-only orphan/crash diagnostic; never deletes or invents source intent | CMD-ROUTING-01 |
| `saipen source quarantine <SRC-###> [--reason CODE]` | EXECUTION: preserve the exact active or archived body locally and exclude it from release/export; `--dry-run` previews without writing; does not close Work or waive coverage (SOURCES.md) | CMD-ROUTING-01 |
| `saipen authority capture --file <UTF8_FILE>\|--hex <UTF8_HEX>` | persist ONE operator-authority Source from exact bytes; never projects Work | CMD-ROUTING-01 |
| `saipen audit [status\|inspect\|ingest]` | intake transport | CMD-CONTINUE-01 |
| `saipen userperson` | meta | CMD-ROUTING-01 |
| `saipen sub <verb> <name>` | sub | CMD-ROUTING-01 |
| `saipen sub reconcile <role> --authority <SRC-###>` | RECOVERY: producer-owned terminal reconciliation (T-1435); OUTCOME A clears stale task/residue on a DONE producer whose BOARD proves all work terminal, OUTCOME B restores a truthful nonterminal projection (SCOUT/PLAN/BLOCKED) without touching real open work; malformed STATE/BOARD and a foreign producer owner refuse with zero writes; the journaled `sub_lifecycle` verification is the write-time backstop | CMD-ROUTING-01 |

`saipen validate` is the canonical Core-conformance front door. It first runs
the cheap structural gate over `.saipen/STATE.md`, `BOARD.md` and `LOG.md`; a
malformed document is refused there and no validator runs. When the structural
gate passes it executes the canonical validator of the running SAIPEN runtime
(`tools/validate.py --project-root <project> --gate core`) through an internal
argv path -- no shell. That validator emits the ordinary conformance receipt,
so the command is NOT zero-write: receipt generation is its only write, and it
never mutates product files, BOARD Work state, STATE phase, source intake or
Improve cycles. The verdict is then re-read from the authoritative
`conformance_status` decision and `VALID` is returned ONLY on CURRENT_PASS -- a
process exit of 0 with no durable CURRENT_PASS receipt is not conformance.

CURRENT_FAIL retains blocking findings; ENGINEERING_REQUIRED has no next command.

This optional advanced `launch opencode` command requires its explicit global
`--agent` seat. It exports that actor plus resolved project root and portable
lineage before starting the host; host arguments follow `--`. Missing actor on
this explicit-envelope command fails `ACTOR_UNBOUND`. Routine generic OpenCode
launches do not route through it and need no manual seat: Core inherits the
project's canonical `STATE.agent`. Neither path treats a host session id as an
actor.

## Compound parsing

<!-- RULE-OWNER: CMD-COMPOUND-01 -->

- Segments separated by ` + ` (space-plus-space) or newlines.
- Quoted payload (`"..."`) is opaque and never split.
- STOP_ON_FAILURE by default: a later segment after an earlier REFUSED/FAILED
  becomes NOT_RUN unless provably independent.
- `saipen push + build ccc` executes both segments in order.
- `hush <task>` applies execution policy `EXEC-HUSH-01`; `hush` is syntax,
  never a lifecycle or style owner.

## Unicode twin normalization

Cyrillic shortcuts are the same as Latin. Codepoint substitution:
`а→a е→e о→o р→p с→c у→y х→x`. Latin `st`/`sss` have no Cyrillic twin.
Cyrillic `сс` → Latin `cc` (continue), never `st` (stop) or retired `ss`.
Retired `ss` returns `SHORTCUT_RETIRED` with non-success and zero mutation;
use `st` to checkpoint and stop, or `sss` for read-only status.

## Continue→improve fallthrough

<!-- RULE-OWNER: CMD-CONTINUE-01 -->

**Skill-only no-op is not continuation.** A skill tool returns instructions,
never a Git result or execution receipt. For `saipen continue`, bare `saipen`,
`cc` and `сс`, finish BOOT's required reads, invoke `saipen continue --json`,
then open `load_path` when present and execute `action` under its owner in the
same turn. `cold_route` names the bound memory and protocol paths without
search. A successful routing response is not completion evidence. If state
has not been read, read it; do not ask the user to define a registered command.
A clean Git tree does not imply a completed BOARD. Recovery remains bounded
by OPS; WAIT and actual refusals retain their existing meaning.

`saipen continue` routes: recovery -> WAIT -> active phase-owned continuation
-> queued explicit user Source -> Audit Inbox -> ordinary BOARD Pick Rule ->
maintenance -> bounded Improve fallback. A queued Source stage means the
oldest unprojected `user_instruction` receipt (T-1436): a request captured
while the seat was busy is started through `saipen start --receipt SRC-###` by
the next canonical poll after the seat frees -- an operator never retypes the
command, and the queued request outranks persisted converge intent and
speculative backlog. The Audit Inbox stage checks the canonical `audit/` layers
(`SOURCE-AUDIT-INBOX-01`, SOURCES.md): a workable unconsumed audit outranks
SELECTION of unrelated queued TODO but never preempts active Work, and a
project holding one is never idle. Layer identity is the file digest, so a
changed audit at a path already worked is a NEW generation and is read again.

Every `continue`/`cc`/`status` JSON answer carries `telegrams`: the acting
seat's unread SAIMAIL telegram COUNTS when `SAIMAIL_WORKSPACE` is set and
`saimail-local` is on PATH (else `NOT_CONFIGURED`/`UNAVAILABLE`). Report a
nonzero count; reading is `read_command`, opening is an explicit decision. A
telegram never routes, creates Work or skips a WAIT (T-1497).

After the Pick Rule and before any idle verdict, two inbox diagnostics are
restated rather than routed: `audit-inbox-invalid` (a layer that cannot be
read) and `audit-inbox-residue` (every layer settled and deleted, but
`audit/` still holds entries SAIPEN never captured). Neither outranks workable
BOARD Work; neither is ever deleted automatically.

`saipen continue` falls through to `saipen improve` ONCE after recovery,
blocked, queued, audit-inbox and required-follow-up routing is exhausted. An
already-active prepared cycle is resumed, never duplicated. A
completed/archived cycle allows fresh discovery. No unbounded improve
carousel.
