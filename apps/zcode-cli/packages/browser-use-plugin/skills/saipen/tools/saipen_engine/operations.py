"""Core operations: claim / transition / checkpoint / ticket lifecycle /
goal / stop (NITRO M3-M5, integrity-repaired).

Every operation is PLAN / APPLY separated around an immutable OperationPlan.

PLAN reads the project snapshot, validates the request, computes the intended
exact bytes for every target (encoding already applied by the codec), and
returns the plan -- writing ZERO bytes. `--dry-run` renders the plan and
nothing else.

APPLY consumes THAT plan object under the writer lock: runs Recovery
preflight, re-checks every declared precondition against the live files
(STALE_STATE refusal), journals PREPARED, applies the ordered targets, verifies
the written result, and only then marks VERIFIED + COMMITTED. The plan's op_id
is the applied op_id; the plan's bytes are the committed bytes. A commit
failure always wins over the semantic success metadata.

STATE is mutated ONLY through owned-field patches (state.patch_state): every
operation declares exactly which keys it owns, everything else is preserved.
There is no `_render_state` anymore.
"""

from __future__ import annotations

import json
import os
import re
import datetime
import hashlib
import uuid
from pathlib import Path

from . import codec, ownership, phases
from .board import (
    BLOCKER_SCOPES,
    CLOSURE_MODES,
    DEFAULT_BLOCKER_SCOPE,
    DEFAULT_CLOSURE_MODE,
    MAX_LIVE_RECORD_CHARS,
    USER_EXPLICIT_TRUE,
    assert_live_record,
    assert_single_record,
    claim_status,
    continuation_parent,
    escape_ticket_description,
    iso_utc_sort_key,
    parse_board,
    pick_next_work,
    remove_ticket_field,
    reserved_continuation_child,
    set_ticket_field,
    strict_iso_utc,
    ticket_has_blocker,
    ticket_is_workable,
)
from .codec import redact_credentials
from .board_compaction import (
    CompactionResult,
    oversized_ticket_ids,
    unrecognized_field_ticket,
    prepare_existing,
    prepare_expanded,
    prepare_new,
    resolve_detail,
)
from .fast_check import block_parked_evidence_error, validate_texts
from .journal import MISSING_FILE_DEPENDENCY, hash_bytes
from .log import (
    VALID_TAXONOMIES,
    ActiveTicketBlockStructure,
    active_ticket_block_structure,
    prepare_bounded_event,
)
from .plan import OperationPlan, TargetPlan, apply_plan, build_plan
from .result import Result
from .state import (
    parse_state,
    patch_state,
    remove_state_fields,
    transition_execution_intent,
    is_legal_wait,
    running_schema_version,
    running_style_token,
    is_absolute_home,
)

#: What the `saipen checkpoint` COMMAND SURFACE accepts. Deliberately narrower
#: than the LOG grammar: an operator typing a checkpoint writes a decision or a
#: run, and the other record types are produced by the operations that own them.
_CHECKPOINT_TAXONOMIES = {"DEC", "RUN"}


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%d.%m.%y %H:%M")


def uuid4_hex() -> str:
    return uuid.uuid4().hex


def _utc_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class _operation_clock:
    """ONE frozen UTC instant for one ownership-sensitive operation.

    The wall clock is read exactly ONCE at the start of the operation; claim
    classification, the claim_time written during a transfer/refresh, and the
    LOG display timestamp are all derived from that single instant. Reading
    three independent wall clocks for one ownership decision is what let the
    CORE-001 handover evidence flip verdict between two runs of identical
    committed code: the fixture's LIVE claim classified as live at capture
    time and stale on the later rerun (SRC-026 REVIEW repair).

    A caller that needs to pin the instant (tests, replays) passes it in; the
    derived strings are then deterministic functions of that instant alone.
    """

    __slots__ = ("instant",)

    def __init__(self, instant: datetime.datetime | None = None) -> None:
        self.instant = instant or datetime.datetime.now(datetime.timezone.utc)

    @property
    def utc(self) -> str:
        return self.instant.strftime("%Y-%m-%dT%H:%M:%SZ")

    @property
    def now(self) -> str:
        return self.instant.strftime("%d.%m.%y %H:%M")


def _clock_instant(now: datetime.datetime | _operation_clock | None) -> datetime.datetime | None:
    """Unwrap a frozen operation clock to its instant (identity otherwise).

    `None` means "no fixed instant", which the shared ownership authority
    resolves to its own single read -- never three.
    """
    if isinstance(now, _operation_clock):
        return now.instant
    return now


class StateMalformedError(ValueError):
    """Raised when STATE.md is present but cannot be parsed whole.

    Mutators MUST fail closed with VALIDATION_FAILED/state-malformed and
    zero canonical writes; a corrupt STATE may never silently mutate as if
    it were the empty dict (T-1003 hostile findings).
    """


class CheckpointError(ValueError):
    """The checkpoint is not loadable as canonical SAIPEN state.

    Raised by the canonical checkpoint loader BEFORE any decode/parse when a
    `.saipen/` is missing STATE.md/BOARD.md/LOG.md, or any carries a
    non-canonical encoding (UTF-16/BOM). Surfaces as VALIDATION_FAILED with
    zero canonical writes (T-1003 / P1#3, P1#4).

    ``code`` names the refusal class when it is more precise than the generic
    VALIDATION_FAILED -- e.g. HISTORY_LEDGER_CORRUPT for immutable-ledger
    corruption. It is one of the registered error_codes so the code survives
    the Result closure and reaches the outer Fleet/continue surface.
    """

    def __init__(self, message: str = "", *, code: str = "VALIDATION_FAILED"):
        super().__init__(message)
        self.code = code


class HomeDeadError(ValueError):
    """`STATE.saipen_home` names an absolute path that is not a SAIPEN install.

    The bootloader cannot load the protocol the checkpoint was written against
    (CORE § 1.2), so an ORDINARY mutation must refuse with HOME_REQUIRED and
    zero canonical writes. `saipen rebind-home --auto` is the ONE operation
    allowed to repair the dead pointer when a replacement is already proven;
    the explicit form (`saipen rebind-home <candidate>`) does so only after
    proving an explicitly named candidate (hostile-regression, P0#3).
    """


def _state_guard(fn):
    """Convert a checkpoint/STATE raise into the operation's structured refusal.

    Every PUBLIC mutator must surface VALIDATION_FAILED with zero canonical
    writes when the checkpoint is missing/non-canonical (CheckpointError) or
    STATE.md is present but unparseable (StateMalformedError). One decorator,
    one refusal shape. A DEAD persisted `saipen_home` is a different failure
    with a different repair, so it carries its own code (HOME_REQUIRED) and
    names `saipen rebind-home` (hostile-regression, P0#3).
    """
    import functools

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except HomeDeadError as exc:
            return _refuse(
                "HOME_REQUIRED",
                str(exc),
                next_action="saipen rebind-home --auto",
            )
        except (StateMalformedError, CheckpointError) as exc:
            return _refuse(getattr(exc, "code", "VALIDATION_FAILED"), str(exc))
        except ValueError as exc:
            detail = str(exc)
            for code in ("LOG_EVENT_OVERSIZE", "BOARD_RECORD_OVERSIZE"):
                if detail.startswith(code + ":"):
                    return _refuse(code, detail)
            raise

    return wrapper


#: Damage classes a REPAIR PLANNER is allowed to OBSERVE.
#:
#: Each name is a defect `_read` would otherwise raise on, and each one is a
#: defect some canonical repair already knows how to fix. Raising on it is what
#: makes that repair unreachable -- the reader refuses, so the repair never
#: runs, so the reader keeps refusing -- and that loop has now been measured
#: three times in the field, on three different surfaces, which is why the set
#: is a named constant instead of a third boolean keyword:
#:
#:   `state`             an unparseable reconciliation-owned STATE field
#:                       (`last_event`, a goal counter, the schema/style
#:                       markers). FastPrompter, 13.09.26.
#:   `log`              illegal LOG LINE SYNTAX, the class `normalize_log`
#:                       repairs and could not read. T-1356.
#:   `history_binding`  a `phase: DONE` whose block-parked evidence is not in
#:                       the history at or before `last_event`. SAIPAL,
#:                       16.09.26 -- every verb including `recover` refused.
#:
#: What is NOT on this list is the point of the list. Ledger corruption
#: (duplicate, out-of-order or dangling E-IDs), a dead `saipen_home`, history
#: OWNERSHIP and every protected-path and seat gate stay armed for every
#: caller: those are not damage a planner repairs by looking harder, and
#: relaxing a READ must never become relaxing an AUTHORITY.
REPAIR_OBSERVABLE = ("state", "log", "history_binding")


def _read(
    root: Path,
    *,
    allow_dead_home: bool = False,
    observe: tuple[str, ...] = (),
) -> tuple[dict, dict, dict, dict]:
    """Read STATE/BOARD/LOG docs + their parsed forms (normalised view).

    The canonical checkpoint loader: every canonical file MUST exist and be
    plain UTF-8 without a BOM, and STATE must actually parse, BEFORE any
    decode/parse/write. A missing or non-canonical file raises CheckpointError
    (VALIDATION_FAILED, zero canonical writes); an empty or unparseable STATE
    raises the same shape so a corrupt checkpoint can never reach patch_state
    and leak a ValueError traceback through the public CLI (T-1003 / P1#4).

    `observe` names the damage classes a REPAIR PLANNER may look at --
    `REPAIR_OBSERVABLE` above is the closed set and the reason each one is on
    it. The rule it encodes is one sentence: a defect the reader refuses to
    read is a defect no repair can ever reach, because the repair lives behind
    the read. Every class not named stays fully armed, and a caller that names
    a class gets the strict verdict handed back in `docs["_observed"]` rather
    than an exception. Observing is NOT authority: the caller must still PROVE
    its repaired proposal against the same strict validator before a single
    byte is written, and a proposal that cannot pass is refused, never
    committed.
    """
    allow_malformed_state = "state" in observe
    allow_illegal_log = "log" in observe
    allow_unbound_history = "history_binding" in observe
    observed: dict[str, str] = {}
    # PERFORMANCE (PERF-003): each canonical checkpoint document is read ONCE.
    # ``read_checkpoint_doc`` folds the old two-step ``checkpoint_preflight``
    # (encoding check) + ``read_document`` (decode) into a single filesystem read,
    # so STATE/BOARD/LOG are no longer opened twice during PLAN. The preflight
    # contract (missing / non-canonical-UTF-8 refusal, zero canonical writes) is
    # preserved exactly by raising ``CheckpointError`` with the same problem text.
    try:
        state_doc = codec.read_checkpoint_doc(root, "STATE.md")
        board_doc = codec.read_checkpoint_doc(root, "BOARD.md")
        log_doc = codec.read_checkpoint_doc(root, "LOG.md")
    except codec.CheckpointLoadError as exc:
        raise CheckpointError(str(exc))
    if not state_doc.text_norm.strip():
        raise CheckpointError(
            "STATE.md is empty -- not a usable checkpoint; a checkpoint needs "
            "a parsed frontmatter fence"
        )
    from .state import parse_state_or_error

    state, state_error = parse_state_or_error(state_doc.text_norm)
    if state_error and not allow_malformed_state:
        raise StateMalformedError(f"state-malformed: {state_error}")
    if state_error:
        observed["state"] = state_error
    if state_error:
        # CORE-002 reconciliation path: fall back to the lenient frontmatter
        # parse so the repair set can be derived at all. `state_error` is the
        # STRICT verdict and travels with the docs -- the caller proves the
        # repaired proposal against it rather than trusting it.
        from .state import parse_frontmatter

        lenient, parse_error = parse_frontmatter(state_doc.text_norm)
        state = lenient if lenient is not None else {}
        if parse_error:
            raise StateMalformedError(f"state-malformed: {parse_error}")
    board = parse_board(board_doc.text_norm)
    from .log import read_history_snapshot_and_logs_digest, snapshot_contract_errors
    from .state import persisted_home_error, running_home

    # The PERSISTED bootloader pointer is validated as a POINTER, separately
    # from the running install that owns VERSION/schema/STYLE
    # (hostile-regression, P0#3). A dead absolute `saipen_home` means the
    # protocol this checkpoint was written against cannot be loaded here, so
    # every ORDINARY mutation refuses BEFORE journaling; `rebind-home` passes
    # allow_dead_home=True because repairing that pointer is its whole job.
    if not allow_dead_home:
        home_problem = persisted_home_error(state.get("saipen_home"))
        if home_problem is not None:
            raise HomeDeadError(
                f"home-dead: {home_problem} -- the bootloader cannot load the "
                f"protocol this checkpoint names, so ordinary mutation is "
                f"refused; converge it with `saipen rebind-home --auto` "
                f"(or name the replacement explicitly with `saipen "
                f"rebind-home <candidate-home-path>`)"
            )
    # ONE strict complete-history snapshot before any planning
    # (hostile-regression, P0#2). The SAME pass supplies the immutable-ledger
    # verdict and the E-ID tail, so a mutation is planned against exactly the
    # evidence that was validated -- never a second, possibly different read.
    #
    # A void/forged sealed+active LOG (duplicate E-IDs, a dangling or
    # non-decreasing parent edge, out-of-order events, an illegal line) would
    # otherwise let a mutation PLAN against a trusted record that does not
    # exist. Refuse before journaling, zero canonical writes; `fast_check`
    # applies the same contract so live verification FAILs it too.
    #
    # Scoped to THIS install's OWN project (its `saipen_home` resolves to the
    # running install): that is the immutable ledger the audit defends
    # (LOG-001..013). Sub-instance and foreign-home projects carry their own
    # histories validated by the sub contract (subs.py), and rejecting theirs
    # here would abort legitimate sub collection -- the running install is the
    # only home whose ledger it is the authority for.
    from .log import HistoryOwnershipError

    # Second-wave P1 ownership: a symlinked/junction/reparse/non-regular
    # history node is refused BEFORE reading external bytes. It surfaces as
    # the same structured CheckpointError (VALIDATION_FAILED, zero writes) as
    # any other corrupt checkpoint, never a raw traceback.
    try:
        # PERF-003 (audit ed1f86e8): the mutation reader consumes only the
        # structured events + derived max_ticket_id, never the combined
        # whole-history text (a 1 MB+ string on every mutation load). Skip
        # materializing it; any caller that genuinely needs the raw history
        # text uses retain_text=True explicitly.
        snapshot, _logs_digest = read_history_snapshot_and_logs_digest(root, retain_text=False)
    except HistoryOwnershipError as exc:
        raise CheckpointError(f"history-ownership: {exc}")
    parked_error = block_parked_evidence_error(state, board, snapshot.events)
    if parked_error is not None:
        # The measured deadlock (T-1382, SAIPAL 16.09.26, last_event 951): this
        # raise is unconditional, `reconcile` reads through this same path, and
        # `_state_phase_repairs` -- which already derives the correct pair from
        # the transition chain -- sits on the other side of it. So the project
        # had a repair and no way to run it: status, next, continue, recover,
        # every recover subcommand, transition, claim, checkpoint and start all
        # answered VALIDATION_FAILED and named no command that could help.
        # The planner may now SEE the unbound shape. It still may not commit
        # one: its proposal is proved against this same binding rule by
        # `validate_texts` before any write.
        if not allow_unbound_history:
            raise CheckpointError(f"state-history-binding: {parked_error}")
        observed["history_binding"] = parked_error
    _home = state.get("saipen_home")
    # T-1010: the cross-platform absolute classifier -- a foreign-OS absolute
    # home must not read as legacy-relative on this host and skip the
    # running-install history ownership gate.
    if (
        _home
        and str(_home).strip()
        and is_absolute_home(_home)
        and Path(str(_home)).resolve() == running_home()
    ):
        history_problems = snapshot_contract_errors(snapshot)
        if allow_illegal_log:
            # T-1356: `normalize_log` is the repair for illegal LOG LINES, and
            # it cannot read the state it repairs if line syntax refuses the
            # read -- the deadlock measured live, where every mutation was
            # refused and no canonical route rewrote a line. It sees past that
            # one class and nothing else: duplicate, out-of-order or broken
            # parent edges are ledger damage this operation does not repair and
            # must never plan on top of.
            illegal = set(snapshot.illegal_lines)
            history_problems = [
                problem for problem in history_problems if problem not in illegal
            ]
        if history_problems:
            raise CheckpointError(
                "history-void: complete LOG history fails the immutable-ledger "
                "contract -- " + "; ".join(history_problems[:4]),
                code="HISTORY_LEDGER_CORRUPT",
            )
    log_tail = snapshot.tail
    # ALWAYS bind the complete sealed history (`.saipen/logs` numeric segments)
    # as a read precondition so APPLY rechecks it under the lock and refuses
    # STALE_STATE the moment a sealed segment is altered between PLAN and APPLY
    # (hostile-regression, P0#2). The `_logs_digest` here is produced by the
    # SAME single pass that built `snapshot` (PERF-003): one read of every
    # sealed segment, framed with the exact `saipen-delete-tree-v1` identity, so
    # APPLY's under-lock recheck compares the same value it always did -- just
    # without a second content read. The miss case is still pinned to the
    # `tree-missing-v1` sentinel (never a conditional hash_tree()/None skip,
    # which is exactly how a fabricated sealed log was once admitted).
    # PERFORMANCE (T-1014): the ONE call-scoped HistorySnapshot is exposed so
    # same-command consumers (transition/finish/ticket_add PLAN paths) reuse
    # the captured events/combined text instead of re-opening the complete
    # LOG history a second time. Nothing is cached across commands, and
    # APPLY/recovery still revalidate LIVE evidence under the lock.
    docs = {
        "state": state_doc,
        "board": board_doc,
        "log": log_doc,
        "_logs_digest": _logs_digest,
        "_history": snapshot,
        # Every damage class the caller ASKED to observe and that was actually
        # present, as the strict verdict text. A caller that named a class and
        # finds nothing here read a surface that is clean on that class.
        "_observed": observed,
        # T-1326 P0: the canonical project root travels WITH the documents. Every
        # later `_event_line` therefore externalizes an oversized event
        # losslessly without the caller having to remember a `root=` keyword --
        # lossless construction is a property of the checkpoint, not an
        # accidental caller opt-in.
        "_root": Path(root),
    }
    if state_error:
        # Set only on the CORE-002 tolerant path: the STRICT verdict the
        # lenient `state` was read in spite of. Empty means "parsed clean".
        docs["_state_error"] = state_error
    return docs, state, board, log_tail


def _live_before(root: Path, rel: str, doc) -> str:
    """The before-hash of an EXTRA target, in the journal's live convention.

    `codec.read_document` represents a missing file as an empty document, and
    the hash of empty bytes is a real hash. The journal represents a missing
    file as "". Using the document hash for a target that does not exist yet
    therefore declared a precondition nothing could satisfy, and the FIRST
    write of that file was refused as `unexpected live bytes (live '')` --
    reproduced by the first no-publish release in a project with no
    `digest.md`. Extra targets must speak the journal's convention.
    """
    return doc.raw_hash if (root / rel).exists() else ""


def _target(doc, path: str, role: str, new_text: str) -> TargetPlan:
    """One planned write target: exact bytes + before/after hashes computed
    from the read document and the planned content."""
    return TargetPlan(
        path, role, doc.encode(new_text), doc.raw_hash, hash_bytes(doc.encode(new_text))
    )


def _docs_preconditions(docs: dict, *keys: str) -> dict:
    pc = {f".saipen/{key.upper()}.md": docs[key].raw_hash for key in keys}
    # The complete sealed LOG history (hostile-regression, P0#2): bound as a
    # read precondition so APPLY rechecks it under the lock. Never a write
    # target, so it stays a read-only dependency and is rechecked even when no
    # canonical file is written.
    _ld = docs.get("_logs_digest")
    if _ld:
        pc[".saipen/logs"] = _ld
    return pc


def _actor_provenance(state: dict, agent: str, message: str) -> str:
    """Record WHO performed this mutation when it is not the seated agent.

    CORE-001 (SRC-026:R001): event wording is NOT an authorization transition.
    The predecessor of this helper prepended `agent handover old -> new`
    whenever the acting agent differed from persisted `STATE.agent`, and the
    call sites then wrote `STATE.agent = agent` -- so a mutation with nothing
    to do with the active ticket silently moved the execution seat while BOARD
    kept the real owner's claim. The split committed (E-5941) because the fast
    gate had no owner invariant, and the canonical validator refused it later.

    What survives is exactly the useful half: out-of-band actor provenance in
    the journal. Ownership now moves ONLY through `ownership`-mediated claim /
    handover operations, which mutate STATE.agent, BOARD owner and BOARD
    claim_time inside one transaction.
    """
    seated = state.get("agent")
    if seated and seated != agent:
        return f"actor {agent} (seat {seated}); {message}"
    return message


def _seat_agent(state: dict, board_text: str, agent: str) -> str:
    """The `STATE.agent` value a NON-TRANSFERRING mutation may persist.

    THE out-of-band actor rule (CORE-001): a non-transferring operation --
    adding future Work, persisting user intent, capturing an audit source,
    checkpointing unrelated future work -- NEVER moves the execution seat.
    Ownership moves ONLY through claim/handover operations, which mutate
    BOARD ownership in the same transaction and pass their own value, so
    they deliberately do NOT call this.

    Audit/17 CORE-002 (SRC-026:R001 REVIEW reopen): the previous answer
    chose between `actor` and `board owner`, which still conflated the
    actor performing an operation with the persistent seat:
      * an actor filing future Work with NO active ticket silently took the
        seat (`persisted_execution_agent` fell back to `actor`);
      * with an UNCLAIMED active ticket the same fallback fired even though
        nothing was claimed;
      * with a PRE-EXISTING owner/STATE split (STATE.agent=A, BOARD owner=B)
        an unrelated mutation silently "healed" the corruption to B instead
        of exposing it.

    The seat rule is PRESERVATION: validate the BEFORE ownership snapshot,
    refuse when it is already invalid (the caller surfaces the refusal --
    zero STATE/BOARD/LOG mutation for a corrupt ownership state), and
    otherwise return BEFORE STATE.agent unchanged. `agent` is returned only
    under the narrow initialization case where the BEFORE state carries no
    agent at all (existing initialization semantics), never as ordinary
    fallback behavior.
    """
    seated = state.get("agent")
    own = ownership.classify_active_ownership(state, board_text, agent)
    split = ownership.preexisting_split_error(own, seated)
    if split:
        raise OwnershipSplitError(split)
    if seated:
        return seated
    return agent


class OwnershipSplitError(RuntimeError):
    """The BEFORE ownership snapshot is corrupt; refuse, never heal.

    Raised by `_seat_agent` when the active ownership state it is asked to
    preserve is itself invalid: a claimed active ticket whose BOARD owner
    disagrees with STATE.agent, or an INVALID (half owner/claim_time pair or
    non-UTC stamp) claim. Only explicit handover, explicit claim/adoption or
    canonical reconcile/repair may change execution authority through that
    state -- an unrelated future-work mutation must REFUSE with zero
    STATE/BOARD/LOG mutation instead of silently "repairing" the split.
    """


def goal_blocked_now(board_text: str, agent: str | None = None) -> list[str]:
    """The goal-scope blockers that ACTUALLY stop the loop right now.

    Empty means the loop is not goal-blocked, whatever a stale STATE says. The
    condition is deliberately conjunctive: a declared goal blocker AND nothing
    active AND nothing workable. A goal blocker beside a workable ticket is a
    real obstacle to ONE line of work, not a reason to stop the project --
    treating the two as the same thing is what parked the FastPrompter loop
    with independent work still on the board.
    """
    from .board import goal_blocked_tickets, workable_tickets

    tickets = parse_board(board_text)["tickets"]
    if any(ticket.get("section") == "## DOING" for ticket in tickets.values()):
        return []
    if workable_tickets(tickets, agent=agent):
        return []
    return goal_blocked_tickets(tickets)


def _recompute_free_slot_route(
    state_text: str, board_text: str, before: dict, agent: str | None = None
) -> str:
    """Re-derive the persisted `next_action` when Work is added to a FREE slot.

    CORE-003 / SRC-026:R003, reproduced live at E-5975: `audit/16.md` was
    ingested, `SRC-026` was captured, `T-1304` was projected onto BOARD ahead
    of everything else -- and the persisted `next_action` still named T-1303,
    because projecting Work never recomputed the route. `status` then reported
    a `next_action` its own `computed_next_action` disagreed with, and a cold
    agent following the file would have executed the wrong ticket.

    Deliberately narrow: only when nothing is active and no WAIT brake is
    persisted. An active transaction owns its own continuation and a WAIT is a
    hard stop; neither may be walked over merely because a ticket was filed.
    The answer itself comes from the shared router, never from a local rule --
    that is the whole point of having ONE Pick Rule.
    """
    # A stale stop reason is cleared whatever the slot state: adding Work is
    # precisely the event that can make a recorded GOAL_BLOCKED false.
    state_text = _settle_stop_reason(state_text, board_text, agent)
    if str(before.get("next_action") or "").startswith("WAIT:"):
        return state_text
    if before.get("task") not in (None, "", "none"):
        return state_text
    if any(t.get("section") == "## DOING" for t in parse_board(board_text)["tickets"].values()):
        return state_text
    from .router import route_next

    routed = route_next(state_text, board_text, current_agent=agent)
    if routed.get("ok") and routed.get("action"):
        return patch_state(state_text, {"next_action": routed["action"]})
    return state_text


def _settle_stop_reason(state_text: str, board_text: str, agent: str | None = None) -> str:
    """Persist `stop_reason: GOAL_BLOCKED` only while it is TRUE.

    Set AND cleared by the same predicate, at every boundary that can change
    the answer (block, unblock, ticket add, user request, closure). A stop
    reason that outlives its cause is worse than none: the loop reads it as
    permission to stay stopped with workable Work on the board.
    """
    from .state import parse_state as _parse_state

    blocked = goal_blocked_now(board_text, agent)
    current = _parse_state(state_text).get("stop_reason")
    if blocked:
        return patch_state(state_text, {"stop_reason": "GOAL_BLOCKED"})
    if current == "GOAL_BLOCKED":
        return remove_state_fields(state_text, ["stop_reason"])
    return state_text


def _event_line(
    docs: dict,
    log_tail: int | None,
    taxonomy: str,
    ticket: str | None,
    agent: str,
    message: str,
    now: str,
    op_id: str | None = None,
    root: Path | None = None,
    structure: ActiveTicketBlockStructure | None = None,
) -> tuple[int, str]:
    # T-1361 CL-04: the WRITER asks the LOG grammar, which is the one owner of
    # what a LOG event may be. It used to consult the command surface's own
    # narrower set, so `_plan_first_publish_wait` -- which correctly asks for a
    # `WAIT` event, a taxonomy `log.VALID_TAXONOMIES` has always accepted --
    # raised ValueError out of the CLI. `saipen ship` on a first publish died
    # with rc=1 and no JSON at all, and TEN release-executor checks reported a
    # parse error with an empty detail. Two sets for one fact, and the narrower
    # copy silently killed a whole verb.
    if taxonomy not in VALID_TAXONOMIES:
        raise ValueError(f"taxonomy {taxonomy!r} outside {sorted(VALID_TAXONOMIES)}")
    # T-1326 P0: the project root comes from the CALLER or from the checkpoint
    # itself -- never from a silent raw fallback. A producer that could not name
    # its project could not preserve an oversized event, and the capped builder
    # would raise LOG_EVENT_OVERSIZE on the very DEC a recovery verb exists to
    # write.
    canonical_root = root if root is not None else docs.get("_root")
    if canonical_root is None:
        raise ValueError(
            "LOG event has no canonical project root -- lossless externalization "
            "is a property of the checkpoint, not an optional caller convention"
        )
    # CORE-003: the persistence boundary is the ONE invariant, not an opt-in
    # caller convention. Redaction and the byte cap live in the shared bounded
    # producer, so no caller can forget to scrub a credential before canonical
    # LOG bytes / journal staging are built.
    event, line, targets = prepare_bounded_event(
        canonical_root,
        log_tail,
        taxonomy,
        message,
        ticket=ticket,
        agent=agent,
        now=now,
        op_id=op_id,
        structure=structure,
    )
    if targets:
        docs.setdefault("_log_detail_targets", []).extend(targets)
    return event, line


def _producer_event(
    docs: dict,
    log_tail: int | None,
    taxonomy: str,
    message: str,
    *,
    ticket: str | None,
    agent: str | None,
    now: str,
    op_id: str | None = None,
) -> tuple[int, str]:
    """T-1326 P0: the ONLY bounded producer entry for ancillary LOG events.

    Any canonical writer whose message is NOT a literal -- a release note, a
    remote endpoint, a caller-supplied RUN/WAIT payload -- reaches LOG through
    this shared helper, so variable-length event construction is never an
    accidental caller opt-in and an oversized event externalizes losslessly
    into the same journaled commit instead of refusing the verb.
    """
    return _event_line(docs, log_tail, taxonomy, ticket, agent or "", message, now, op_id)


def _log_targets(docs: dict, new_log: str) -> list:
    """The canonical LOG target set: externalized detail artifacts, then LOG.md.

    T-1326 P0: an oversized event's detail artifacts join the SAME journaled
    commit as LOG/STATE/BOARD. Building that set HERE -- instead of at each of
    the ~30 canonical mutation call sites -- is what makes the guarantee
    structural: no plan can commit a compact `detail_ref` that names bytes the
    transaction never wrote, and a new LOG producer cannot forget the rule.
    """
    return [
        *docs.get("_log_detail_targets", []),
        _target(docs["log"], ".saipen/LOG.md", "log", new_log),
    ]


def _regression_gate(docs: dict, ticket_id: str) -> str | None:
    """Why this ticket's regression pair is inadmissible, or None (CORE-001).

    Returns None -- silently, for every ticket -- unless the BOARD declares
    `regression: required`. That declaration is the machine-owned switch: the
    gate never guesses from a description whether something is a bug fix,
    because a gate that reads prose is the failure this rule exists to close.

    When the switch is on, the pair is decided by the same
    `oracle.regression_pair_verdict` arithmetic the module owns, over the
    anchored `REGRESSION-EVIDENCE` records of the CURRENT VERIFY cycle. Before
    this existed the rule was documentation plus a helper with no production
    caller, so a weakened oracle passed both canonical gates.
    """
    from .board import parse_board, regression_required
    from .log import regression_evidence

    try:
        tickets = parse_board(docs["board"].text_norm)["tickets"]
    except (KeyError, AttributeError, ValueError):
        return None
    ticket = tickets.get(ticket_id)
    if ticket is None or not regression_required(ticket):
        return None
    ok, reason = regression_evidence(ticket_id, docs["_history"].events)
    if ok:
        return None
    return (
        f"ticket {ticket_id} declares `regression: required`, so a green run is "
        f"not enough -- the SAME verifier must be red against the pre-fix "
        f"subject and green against the post-fix one ({reason})"
    )


def _refuse(code: str, detail: str = "", **extra) -> Result:
    return Result(ok=False, code=code, message=detail, data=extra)


def _iter_operation_records(root: Path):
    """W2-001: Yield every parseable operation.json from both ops and settled.

    Uses the canonical semantic receipt snapshot from journal.py instead
    of scanning only recovery/ops. This ensures committed receipts that
    have been moved to recovery/settled remain visible.
    """
    from .journal import semantic_receipt_snapshot

    snapshot = semantic_receipt_snapshot(root)
    if snapshot.errors:
        return
    yield from snapshot.records


def _strict_created_at(value: object) -> str:
    """Strict ISO-8601 UTC timestamp (Z or +00:00, utcoffset() == 0), or '' when
    invalid. Delegated to the ONE shared strict-UTC parser (P1#5): a non-zero
    offset stamp is NOT UTC and must refuse, never silently pass."""
    from .board import strict_iso_utc

    return strict_iso_utc(value)


def _convergence_event_number(record: dict) -> int:
    """The monotonic LOG event id a convergence receipt committed under."""
    meta = record.get("receipt_metadata") or {}
    match = re.match(r"E-(\d+)", str(meta.get("event_id") or ""))
    return int(match.group(1)) if match else -1


def _latest_convergence_stage(root: Path, stage: str) -> dict | None:
    """The latest COMMITTED convergence_stage receipt for one stage, ordered
    by the monotonic LOG event (same-second receipts must still order)."""
    out = None
    for record in _iter_operation_records(root):
        meta = record.get("receipt_metadata") or {}
        if record.get("operation") != "convergence_stage":
            continue
        if record.get("status") != "COMMITTED":
            continue
        if not _strict_created_at(record.get("created_at")):
            continue
        if meta.get("stage") != stage:
            continue
        if _convergence_event_number(record) < 0:
            continue
        if out is None or _convergence_event_number(record) > _convergence_event_number(out):
            out = record
    return out


# --------------------------------------------------------------------------- claim


#: The host session identity the adapter exports before it runs the tool that
#: carries this command (T-1384). Plain environment, exactly like the PATH the
#: same adapter prepends -- this is a WITNESS of which process is acting, never
#: a credential and never an actor.
HOST_SESSION_ENV = "SAIPEN_HOST_SESSION"


def host_session_binding(root: Path) -> str | None:
    """This process's claim binding for `root`, or None when unprovable."""
    from .board import claim_session_digest
    from .paths import project_lineage_identity

    return claim_session_digest(project_lineage_identity(root), os.environ.get(HOST_SESSION_ENV))


def _claim_fields_in_place(
    board_text: str,
    ticket_id: str,
    fields: dict[str, str],
    *,
    enforce_cap: bool = True,
    session_binding: str | None = None,
) -> str:
    """Surgically set/overwrite owner/claim_time on the EXISTING DOING ticket
    line in place -- no second ticket, no duplicated fields (P0#2 adoption).

    Uses board.set_ticket_field, which replaces an existing field value rather
    than appending a duplicate and refuses (via _reject_duplicate_fields) a
    malformed line that already repeats the field. Every other field on the
    line is preserved byte-for-byte.

    Every caller of this function is a seat being taken or refreshed BY THIS
    PROCESS now, which is exactly when the session binding is knowable, so
    T-1384 writes it here rather than at four call sites that would drift.
    A process that cannot prove its session REMOVES the field instead of
    leaving it: a claim carrying some other window's binding would lock its
    own owner out of the Work it just claimed.
    """
    parsed = parse_board(board_text)
    ticket = parsed["tickets"].get(ticket_id)
    if ticket is None or ticket.get("section") != "## DOING":
        raise ValueError(f"{ticket_id} is not a ## DOING ticket")
    raw = ticket["raw"]
    new = raw
    if session_binding:
        new = set_ticket_field(new, "claim_session", session_binding, enforce_cap=enforce_cap)
    else:
        new = remove_ticket_field(new, "claim_session")
    for key, value in fields.items():
        new = set_ticket_field(new, key, value, enforce_cap=enforce_cap)
    if enforce_cap:
        assert_live_record(new)
    lines = board_text.splitlines(keepends=True)
    idx = ticket["line_no"] - 1
    suffix = "\n" if lines[idx].endswith("\n") else ""
    lines[idx] = new + suffix
    return "".join(lines)


def _ticket_fields_in_place(
    board_text: str,
    ticket_id: str,
    fields: dict[str, str],
    remove: tuple[str, ...] = (),
    *,
    enforce_cap: bool = True,
) -> str:
    """Set/remove fields on one existing ticket without changing its section."""
    parsed = parse_board(board_text)
    ticket = parsed["tickets"].get(ticket_id)
    if ticket is None:
        raise ValueError(f"{ticket_id} is not on the board")
    raw = ticket["raw"]
    new = raw
    for key in remove:
        new = remove_ticket_field(new, key)
    for key, value in fields.items():
        new = set_ticket_field(new, key, value, enforce_cap=enforce_cap)
    if enforce_cap:
        assert_live_record(new)
    lines = board_text.splitlines(keepends=True)
    idx = ticket["line_no"] - 1
    suffix = "\n" if lines[idx].endswith("\n") else ""
    lines[idx] = new + suffix
    return "".join(lines)


def _project_board_mutation(
    root: Path,
    board_text: str,
    propose,
    ticket_ids: list[str],
    *,
    op_id: str,
    event_id: str | None,
    reason: str,
) -> CompactionResult:
    """The ONE shared BOARD mutation projector (T-1326 TARGET B).

    Phase 1 compacts any row that was ALREADY oversized, so the caller's
    `propose` step operates on a legal projection. Phase 2 runs the requested
    semantic mutation with the size cap lifted. Phase 3 externalizes any row
    the mutation left oversized, transactionally, in the SAME journaled plan --
    so a normal row that crosses the cap BECAUSE of the requested verify,
    blocker or closure payload completes canonically instead of dying in a
    `BOARD_RECORD_OVERSIZE` dead-end that `ticket compact` cannot repair.

    Raises ValueError (never a partial write: this is PLAN-time only).
    """
    compacted = prepare_existing(
        root, board_text, ticket_ids, op_id=op_id, event_id=event_id, reason=reason
    )
    proposed = propose(compacted.board_text)
    grown = prepare_expanded(
        root, proposed, ticket_ids, op_id=op_id, event_id=event_id, reason=reason
    )
    return CompactionResult(
        grown.board_text,
        (*compacted.targets, *grown.targets),
        grown.detail_ref or compacted.detail_ref,
        grown.original_hash or compacted.original_hash,
        tuple(dict.fromkeys((*compacted.compacted_tickets, *grown.compacted_tickets))),
    )


def _active_claim_refusal(
    state: dict,
    board_text: str,
    agent: str,
    ticket_id: str | None = None,
    now: datetime.datetime | _operation_clock | None = None,
) -> Result | None:
    """The SELF-ownership gate every ACTIVE-ticket mutation must pass
    (second-wave P0). Returns a refusal Result (zero canonical writes) or None.

    ONE shared authority (CORE-001/002): this gate CONSUMES
    `ownership.classify_active_ownership` -- the same structured classifier
    the router, the fast gate and the canonical validator consume -- instead
    of reconstructing the active-seat answer from `claim_status` locally.
    Persisted STATE.agent is HISTORICAL last-writer evidence -- the acting
    identity is the SESSION agent the CLI threaded down. A session B that
    mutates a project A is actively claiming would overwrite STATE.agent=B
    while BOARD keeps A's live claim, which is exactly the binding-mismatch
    impersonation this closes. Mapping (from the shared classifier):
      * SELF (or NO_ACTIVE, unbound) -> mutation allowed;
      * FOREIGN_LIVE claim -> TICKET_NOT_WORKABLE refusal, zero writes;
      * INVALID claim -> VALIDATION_FAILED refusal for repair;
      * UNCLAIMED / FOREIGN_STALE -> TICKET_NOT_WORKABLE: explicit
        `claim T-###` (adoption/takeover) must come first.
    """
    active = state.get("task")
    if not active or active == "none":
        return None
    tickets = parse_board(board_text)["tickets"]
    ticket = tickets.get(active)
    if ticket is None or ticket.get("section") != "## DOING":
        return None
    own = ownership.classify_active_ownership(state, tickets, agent, now=_clock_instant(now))
    if not own.has_active or own.active_ticket != active:
        return None
    if own.status in ("SELF", ownership.NO_ACTIVE):
        return None
    owner = ticket["fields"].get("owner", "")
    if own.status == ownership.FOREIGN_LIVE:
        return _refuse(
            "TICKET_NOT_WORKABLE",
            f"{active} is actively claimed by another agent ({owner}); a live "
            f"foreign claim cannot be mutated by session {agent}",
            ticket=active,
        )
    if own.status == ownership.INVALID:
        return _refuse(
            "VALIDATION_FAILED",
            f"{active} carries an INVALID claim (half owner/claim_time pair "
            f"or non-UTC stamp); repair before mutating",
            ticket=active,
        )
    return _refuse(
        "TICKET_NOT_WORKABLE",
        f"{active} is unclaimed or carries a stale claim (owner {owner or 'none'!r}); "
        f"explicit 'claim {active}' adoption is required before any "
        f"active-ticket mutation by session {agent}",
        ticket=active,
    )


def _refresh_active_claim(
    board_text: str,
    state: dict,
    agent: str,
    utc: str,
    now: datetime.datetime | None = None,
    root: Path | None = None,
) -> tuple[str | None, str | None]:
    """If the active ticket is this agent's own SELF claim, advance its
    claim_time in place on BOARD. Returns (new_board_text | None, ticket_id).

    Used by checkpoint/transition so an actively worked ticket never becomes
    legally stale while its owner checkpoints/transitions (CORE § 1.4). A
    foreign/unclaimed/non-owned DOING is NOT touched -- adoption is a separate
    `claim T` action, not a side effect of unrelated mutations.

    ONE shared authority (CORE-001): only `SELF` may refresh the active lease.
    UNCLAIMED, FOREIGN_STALE, FOREIGN_LIVE and INVALID all refresh nothing, and
    the answer comes from `ownership.classify_active_ownership` rather than a
    local `claim_status` read. `now` is the frozen OPERATION instant, so the
    classification and the `utc` stamp written below are two views of one
    instant -- the refresh never makes a second, later clock read of its own.
    """
    if state.get("phase") not in phases.TICKET_BEARING_PHASES:
        return None, None
    active = state.get("task")
    if not active or active == "none":
        return None, None
    tickets = parse_board(board_text)["tickets"]
    ticket = tickets.get(active)
    if ticket is None or ticket.get("section") != "## DOING":
        return None, None
    own = ownership.classify_active_ownership(state, tickets, agent, now=now)
    if own.status != ownership.SELF:
        return None, None
    return (
        _claim_fields_in_place(
            board_text, active, {"claim_time": utc},
            session_binding=host_session_binding(root) if root is not None else None,
        ),
        active,
    )


def _plan_claim(
    root: Path,
    ticket_id: str,
    agent: str,
    now: str,
    utc: str,
    instant: datetime.datetime | None = None,
    explicit: bool = False,
) -> OperationPlan | Result:
    op_id = "claim-" + uuid4_hex()
    # ONE frozen operation instant: classify and stamp from the same clock.
    if instant is None:
        instant = datetime.datetime.now(datetime.timezone.utc)
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=ticket_id,
        )
    tickets = board["tickets"]
    if ticket_id not in tickets:
        return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
    ticket = tickets[ticket_id]
    # T-1326: readable legacy rows may be oversized.  Compact the historical
    # projection before any normal claim mutation; the detail targets join the
    # same OperationPlan below, so no orphan reference can be accepted.
    try:
        compacted = prepare_existing(
            root,
            docs["board"].text_norm,
            [ticket_id],
            op_id=op_id,
            event_id=None,
            reason="existing oversized BOARD record requires canonical claim update",
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    board_text = compacted.board_text
    compaction_targets = list(compacted.targets)
    if ticket_has_blocker(ticket):
        return _refuse(
            "TICKET_NOT_WORKABLE",
            f"{ticket_id} carries a blocker; explicit priority override does "
            "not override authorization",
            ticket=ticket_id,
        )
    section = ticket["section"]
    # Ticket-local claim primitive (CORE-001 REVIEW repair, TARGET 5): a claim
    # on a NOT-YET-ACTIVE TODO ticket evaluates one ticket's lease directly --
    # this is adoption INTO the seat, not authorization of an active mutation,
    # so `claim_status` stays legal here. For the DOING branch below the
    # classification is the ACTIVE-EXECUTION decision and goes through the
    # shared authority `ownership.classify_active_ownership` at the ONE frozen
    # operation instant -- never a local `claim_status` read (the boundary
    # documented in `operations._seat_agent`: ACTIVE_EXECUTION_AUTHORITY ->
    # shared classifier; TICKET_LOCAL_CLAIM_PRIMITIVE -> claim_status).
    cs = (
        ownership.classify_active_ownership(
            state, tickets, agent, now=instant, root=root
        ).status
        if section == "## DOING"
        else claim_status(ticket, agent, None)
    )

    if section == "## DOING":
        # In-place adoption / lease refresh -- never a second ticket or
        # duplicated fields (P0#2 / CORE § 1.4 stale/unclaimed adoption).
        if cs == ownership.FOREIGN_LIVE:
            return _refuse(
                "TICKET_NOT_WORKABLE",
                f"{ticket_id} is actively claimed by another agent "
                f"({ticket['fields'].get('owner', '')}); a live "
                f"foreign claim cannot be taken over",
                ticket=ticket_id,
            )
        if cs == "INVALID":
            return _refuse(
                "VALIDATION_FAILED",
                f"{ticket_id} carries an INVALID claim (half "
                f"owner/claim_time pair or non-UTC stamp); repair "
                f"before claiming",
                ticket=ticket_id,
            )
        if cs == "SELF":
            # BOARD-only lease refresh: advance claim_time in place. No LOG, no
            # STATE change -- the owner and binding are unchanged.
            new_board = _claim_fields_in_place(
                board_text, ticket_id, {"claim_time": utc},
                session_binding=host_session_binding(root),
            )
            errors = validate_texts(
                docs["state"].text_norm,
                new_board,
                docs["log"].text_norm,
                current_agent=agent,
                sealed_events=docs["_history"],
            )
            if errors:
                return _refuse(
                    "VALIDATION_FAILED",
                    "proposed state fails fast validation: " + "; ".join(errors[:5]),
                )
            targets = [
                *compaction_targets,
                _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
            ]
            return build_plan(
                "claim",
                agent,
                _identity(root),
                {
                    "operation": "claim",
                    "ticket": ticket_id,
                    "agent": agent,
                    "explicit": explicit,
                    "refresh": True,
                },
                _docs_preconditions(docs, "state", "board", "log"),
                targets,
                {
                    "ok": True,
                    "code": "CLAIMED",
                    "ticket": ticket_id,
                    "refresh": True,
                    "detail": "lease refreshed (claim_time advanced)",
                },
                op_id=op_id,
            )
        # UNCLAIMED or FOREIGN_STALE -> adopt / take over in place.
        # FOREIGN_STALE is a TAKEOVER of another agent's lapsed claim, so the
        # DEC payload must record who it was taken from and the staleness that
        # authorized the takeover (hostile-regression, P1#8) -- an ordinary
        # UNCLAIMED adoption records only the new owner. Splitting the payload
        # keeps the ledger's takeover audit distinct from fresh adoption.
        # Attempt/claim interaction (T-1148): adopting or taking over Work
        # while an attempt episode is still open would leave the episode's
        # STATE pointer attached to a ticket changing hands -- torn state.
        # The successor closes the predecessor's dangling attempt FIRST
        # (interrupted / unknown), then claims. The owner's own SELF lease
        # refresh stays legal mid-episode.
        if cs != "SELF" and state.get("attempt"):
            return _refuse(
                "VALIDATION_FAILED",
                f"attempt {state.get('attempt')} is still open on this "
                "Work -- close it (result interrupted, stop unknown after a "
                "crashed predecessor) before claiming",
                ticket=ticket_id,
            )
        if cs == "FOREIGN_STALE":
            _old_owner = (ticket["fields"].get("owner") or "").strip()
            _prior_claim = (ticket["fields"].get("claim_time") or "").strip()
            _msg = (
                f"claimed via SAIOPS -- took over STALE claim from "
                f"{_old_owner} (prior claim_time {_prior_claim}); owner "
                f"{agent}"
            )
        else:
            _msg = f"claimed via SAIOPS -- owner {agent}"
        _msg = _actor_provenance(state, agent, _msg)
        event, line = _event_line(docs, log_tail, "DEC", ticket_id, agent, _msg, now, op_id)
        new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
        new_board = _claim_fields_in_place(
            board_text, ticket_id, {"owner": agent, "claim_time": utc},
            session_binding=host_session_binding(root),
        )
        resume_in_place = (
            state.get("task") == ticket_id and state.get("phase") in phases.TICKET_BEARING_PHASES
        )
        owned = {
            "task": ticket_id,
            "last_event": event,
            "updated": utc,
            "agent": agent,
        }
        if not resume_in_place:
            owned.update(
                {
                    "phase": "SCOUT",
                    "next_action": f"PHASE SCOUT {ticket_id}",
                    "transition_from": state.get("phase") or "DONE",
                }
            )
        new_state = patch_state(docs["state"].text_norm, owned)
        errors = validate_texts(
            new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
        )
        if errors:
            return _refuse(
                "VALIDATION_FAILED",
                "proposed state fails fast validation: " + "; ".join(errors[:5]),
            )
        targets = [
            *_log_targets(docs, new_log),
            *compaction_targets,
            _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
            _target(docs["state"], ".saipen/STATE.md", "state", new_state),
        ]
        return build_plan(
            "claim",
            agent,
            _identity(root),
            {
                "operation": "claim",
                "ticket": ticket_id,
                "agent": agent,
                "explicit": explicit,
                "adopt": True,
            },
            _docs_preconditions(docs, "state", "board", "log"),
            targets,
            {
                "ok": True,
                "code": "CLAIMED",
                "ticket": ticket_id,
                "event_id": f"E-{event}",
                "phase": state.get("phase") if resume_in_place else "SCOUT",
                "next_action": (
                    state.get("next_action") if resume_in_place else f"PHASE SCOUT {ticket_id}"
                ),
                "adopted": True,
                "resumed_in_place": resume_in_place,
            },
            op_id=op_id,
        )

    if section != "## TODO":
        return _refuse("TICKET_NOT_WORKABLE", f"{ticket_id} is under {section}", ticket=ticket_id)
    if ticket["checkbox"] not in (" ", ""):
        return _refuse(
            "TICKET_NOT_WORKABLE",
            f"{ticket_id} is [{ticket['checkbox']}] but sits under "
            f"## TODO -- checkbox/section disagreement is malformed "
            f"input and cannot be claimed",
            ticket=ticket_id,
        )
    # A claim (owner/claim_time) on a TODO is INACTIVE history: CORE's claim
    # truth lives in DOING, so a stale pair left by a block/unblock cycle must
    # not make the ticket non-workable (hostile-regression, P1#5). A half/bad
    # (INVALID) pair still fails closed -- only a syntactically VALID foreign
    # claim is treated as inactive outside DOING.
    if cs == "INVALID":
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id} carries an INVALID claim (half owner/claim_time pair or non-UTC stamp)",
            ticket=ticket_id,
        )
    # Attempt/claim interaction (T-1148): a fresh claim while an episode is
    # open would orphan that episode's pointer on a ticket it does not name.
    if state.get("attempt"):
        return _refuse(
            "VALIDATION_FAILED",
            f"attempt {state.get('attempt')} is still open -- close it "
            "before claiming different Work",
            ticket=ticket_id,
        )
    for need in ticket["needs"]:
        if need not in tickets or tickets[need]["section"] != "## DONE":
            return _refuse("TICKET_NOT_WORKABLE", f"unmet needs: {need}", ticket=ticket_id)
    doing = [t for t in tickets.values() if t["section"] == "## DOING"]
    if doing:
        return _refuse("ALREADY_CLAIMED", f"DOING holds {doing[0]['id']}", ticket=ticket_id)

    reserved_child = reserved_continuation_child(tickets, agent=agent, now=instant)
    if reserved_child is not None and reserved_child["id"] != ticket_id:
        return _refuse(
            "CONTINUATION_RESERVED",
            f"{reserved_child['id']} owns the free seat until its blocked parent "
            "can resume; an explicit claim cannot bypass this dependency handoff",
            ticket=ticket_id,
            blocked_on=reserved_child["id"],
        )

    # The Pick Rule's own answer, computed whether or not it is being overridden:
    # a refusal needs it to name the ticket that wins, and an override needs it
    # to name the ticket it stepped over (T-1275). CORE.md PICK-01 already
    # allows the override and bounds it -- "explicit override cannot bypass
    # eligibility or authorization" -- which is why every gate above this point
    # runs first and refuses with the flag present.
    top_workable, _pick_reason = pick_next_work(tickets, agent=agent, now=instant)
    if not explicit:
        if top_workable is None or top_workable != ticket_id:
            return _refuse(
                "NOT_TOP_WORKABLE",
                f"topmost workable ticket is {top_workable or 'none'}, "
                f"requested {ticket_id}; re-run with --explicit to override the "
                "Pick Rule and record which ticket was stepped over",
                ticket=ticket_id,
                top_workable=top_workable,
            )

    # `--explicit` on a ticket that WAS topmost is a redundant flag, not an
    # override: annotating it would put a false "stepped over" claim in
    # immutable history.
    stepped_over = top_workable if (explicit and top_workable != ticket_id) else None
    detail = f"claimed via SAIOPS -- owner {agent}"
    if stepped_over is not None:
        detail += (
            " -- EXPLICIT claim over PICK-01: topmost workable was "
            f"{stepped_over}"
        )
    event, line = _event_line(docs, log_tail, "DEC", ticket_id, agent, detail, now, op_id)
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    # T-1326 TARGET B for the CLAIM path: claiming APPENDS `owner`/`claim_time`
    # (and the session binding), so a row that was legal can cross the live cap
    # BECAUSE of the claim itself. Asserting the cap on that proposed row made
    # the ticket unclaimable AND unreachable by `ticket compact` (the row was
    # under the cap before the claim, so compact reports ALREADY_APPLIED) -- the
    # exact frozen-seat dead end other lifecycle writers already closed by
    # routing through the ONE shared externalizing projector.
    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            lambda board: _claim_move(
                board,
                ticket_id,
                agent,
                utc,
                session_binding=host_session_binding(root),
                enforce_cap=False,
            ),
            [ticket_id],
            op_id=op_id,
            event_id=f"E-{event}",
            reason=("existing/proposed oversized BOARD record requires canonical claim update"),
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    new_board = projected.board_text
    compaction_targets = list(projected.targets)
    owned = {
        "phase": "SCOUT",
        "task": ticket_id,
        "next_action": f"PHASE SCOUT {ticket_id}",
        "transition_from": state.get("phase") or "DONE",
        "last_event": event,
        "updated": utc,
        "agent": agent,
    }
    new_state = patch_state(docs["state"].text_norm, owned)

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED", "proposed state fails fast validation: " + "; ".join(errors[:5])
        )

    targets = [
        *_log_targets(docs, new_log),
        *compaction_targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "claim",
        agent,
        _identity(root),
        {"operation": "claim", "ticket": ticket_id, "agent": agent, "explicit": explicit},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "CLAIMED",
            "ticket": ticket_id,
            "event_id": f"E-{event}",
            "phase": "SCOUT",
            "next_action": f"PHASE SCOUT {ticket_id}",
        },
        op_id=op_id,
    )


def _claim_move(
    board_text: str,
    ticket_id: str,
    agent: str,
    utc: str,
    session_binding: str | None = None,
    *,
    enforce_cap: bool = True,
) -> str:
    """Surgical claim move: target ticket TODO -> DOING with [/] owner.

    T-1384: a fresh TODO -> DOING claim is the OTHER place a seat is taken by
    this process, so it binds the host session the same way the in-place
    claim writer does. A TODO line may still carry an old binding from a
    previous DOING episode; it is replaced or removed here for the same
    reason the owner/claim_time pair is -- claim truth lives in DOING, and a
    leftover binding would be a false witness rather than merely stale.
    """
    lines = board_text.splitlines(keepends=True)
    out = []
    ticket_line = None
    doing_idx = None
    for line in lines:
        stripped = line.rstrip("\n")
        if stripped.startswith("- [ ] " + ticket_id + " "):
            ticket_line = stripped
            continue
        if stripped.startswith("## DOING"):
            doing_idx = len(out)
        out.append(line)
    if ticket_line is None or doing_idx is None:
        raise ValueError("cannot locate ticket or DOING section")
    # A claimed-then-blocked/unblocked TODO may still carry a previous
    # owner/claim_time pair (claim truth lives in DOING). Move must STRUCTURALLY
    # REPLACE the existing pair, never append a second one -- a duplicate field
    # is a parse error that rejects the whole board (hostile-regression, P1#5).
    marked = ticket_line.replace("- [ ] ", "- [/] ", 1).rstrip()
    marked = set_ticket_field(marked, "owner", agent, enforce_cap=enforce_cap)
    marked = set_ticket_field(marked, "claim_time", utc, enforce_cap=enforce_cap)
    if session_binding:
        marked = set_ticket_field(marked, "claim_session", session_binding, enforce_cap=enforce_cap)
    else:
        marked = remove_ticket_field(marked, "claim_session")
    out.insert(doing_idx + 1, marked + "\n")
    return "".join(out)


@_state_guard
def plan_claim(
    project_root: Path | str, ticket_id: str, agent: str, explicit: bool = False
) -> Result:
    # ONE frozen operation instant (CORE-001 REVIEW repair, SRC-026:R001/R002):
    # the ownership classification and the claim_time written to BOARD derive
    # from the same clock -- a second wall-clock read could let the decision
    # flip verdict between classification and write.
    clock = _operation_clock()
    plan = _plan_claim(
        Path(project_root),
        ticket_id,
        agent,
        clock.now,
        clock.utc,
        instant=clock.instant,
        explicit=explicit,
    )
    if isinstance(plan, Result):
        return plan
    return _render_plan(plan)


@_state_guard
def apply_claim(
    project_root: Path | str, ticket_id: str, agent: str, explicit: bool = False
) -> Result:
    clock = _operation_clock()
    plan = _plan_claim(
        Path(project_root),
        ticket_id,
        agent,
        clock.now,
        clock.utc,
        instant=clock.instant,
        explicit=explicit,
    )
    if isinstance(plan, Result):
        return plan
    return apply_plan(Path(project_root), plan)


# ------------------------------------------------------------ attempt (T-1148)


def _plan_attempt(
    root: Path,
    agent: str,
    action: str,
    result: str | None,
    stop: str | None,
    evidence: list[str] | None,
    unknown: str | None,
    now: str,
    utc: str,
    instant: datetime.datetime | None = None,
) -> OperationPlan | Result | dict:
    """PLAN one Attempt lifecycle step (open|close) over the ACTIVE Work.

    An Attempt is one bounded execution episode of one agent on the claimed
    ticket. The op writes TWO targets in ONE transaction: the machine-owned
    DEC event in LOG.md and the STATE.attempt pointer (set on open, removed
    on close) -- so a crash can never leave Work claiming an episode the LOG
    does not know about, nor an episode the Work disowned.

    ``instant`` is the ONE frozen operation instant: every ownership decision
    in here evaluates against it, never a second wall-clock read.
    """
    from . import attempt as attempt_mod

    op_id = ("attempt-" + action + "-") + uuid4_hex()
    docs, state, board, log_tail = _read(root)
    if action == "open":
        _guard = _active_claim_refusal(state, docs["board"].text_norm, agent, now=instant)
        if _guard is not None:
            return _guard
    else:
        # Closing an episode uses a RELAXED ownership guard: closing a crashed
        # predecessor's dangling attempt is THE recovery step that unblocks
        # adoption (claim refuses while an episode is open), so it must stay
        # reachable for any session when the predecessor's claim is stale or
        # gone. Only a LIVE foreign claim or an INVALID claim still refuses.
        # The decision is classified through the shared ownership authority
        # at the frozen instant -- never a local second classifier.
        _tickets = parse_board(docs["board"].text_norm)["tickets"]
        _task = state.get("task")
        _ticket = _tickets.get(_task) if _task else None
        if _ticket is not None and _ticket.get("section") == "## DOING":
            _cs = ownership.classify_active_ownership(state, _tickets, agent, now=instant).status
            if _cs in (ownership.FOREIGN_LIVE, ownership.INVALID):
                return _refuse(
                    "TICKET_NOT_WORKABLE" if _cs == ownership.FOREIGN_LIVE else "VALIDATION_FAILED",
                    f"{_task} carries a {_cs} claim; that claim's holder closes its own attempt",
                    ticket=_task,
                )

    records, fold_errors = attempt_mod.build_attempts(docs["_history"].events)
    if fold_errors:
        return _refuse(
            "VALIDATION_FAILED",
            "LOG carries malformed attempt history; run tools/validate.py: "
            + "; ".join(fold_errors[:3]),
        )
    open_ids = attempt_mod.active_attempts(records)

    task = state.get("task")

    if action == "open":
        # Replay safety (T-1148): the same session re-running a committed
        # open gets its own live attempt back, never a duplicate episode.
        pointer = state.get("attempt")
        if pointer and pointer in records and records[pointer]["close_event"] is None:
            same_work = records[pointer].get("ticket") == task
            same_seat = (state.get("agent") or "") == agent or records[pointer].get(
                "agent"
            ) == agent
            if same_work and same_seat:
                return {
                    "ok": True,
                    "code": "ATTEMPT_ACTIVE",
                    "idempotent": True,
                    "attempt": pointer,
                    "ticket": task,
                    "detail": f"attempt {pointer} already open for {task}; "
                    "no second episode created",
                }
        if open_ids:
            return _refuse(
                "VALIDATION_FAILED",
                f"attempt {open_ids[0]} is still open -- close it before "
                "opening another; single-writer semantics allow exactly one "
                "active attempt",
            )
        if not task or task == "none":
            return _refuse(
                "ACTIVE_TICKET_MISMATCH",
                "attempt open needs claimed Work -- STATE.task is none",
            )
        tickets = board["tickets"]
        if task not in tickets:
            return _refuse("TICKET_NOT_FOUND", f"{task} is not on the board", ticket=task)
        if tickets[task]["section"] != "## DOING":
            return _refuse(
                "ACTIVE_TICKET_MISMATCH",
                f"{task} is {tickets[task]['section']}, not ## DOING -- "
                "an attempt executes claimed Work",
                ticket=task,
            )

        new_id = attempt_mod.next_attempt_id(docs["_history"].events)
        # CORE-003 (audit ed1f86e8): the `supersedes` predecessor MUST be the
        # previous episode on THIS Work, never the globally latest attempt on
        # any ticket. A closed attempt on T-001 must not become the
        # predecessor of the first attempt on T-002 -- that would cross-link
        # unrelated tickets and corrupt recovery/history lineage while staying
        # validator-green (the old contract checked existence/acyclicity but
        # not predecessor ticket identity).
        same_work = [rec for rec in records.values() if rec.get("ticket") == task]
        latest = max(same_work, key=lambda rec: rec["open_event"], default=None)
        text = f"attempt {new_id} open"
        if latest is not None:
            text += f"; supersedes {latest['id']}"
        event, line = _event_line(docs, log_tail, "DEC", task, agent, text, now, op_id)
        new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
        owned = {"attempt": new_id, "last_event": event, "updated": utc, "agent": agent}
        new_state = patch_state(docs["state"].text_norm, owned)
        errors = validate_texts(
            new_state,
            docs["board"].text_norm,
            new_log,
            current_agent=agent,
            sealed_events=docs["_history"],
        )
        if errors:
            return _refuse(
                "VALIDATION_FAILED",
                "proposed state fails fast validation: " + "; ".join(errors[:5]),
            )
        targets = [
            *_log_targets(docs, new_log),
            _target(docs["state"], ".saipen/STATE.md", "state", new_state),
        ]
        return build_plan(
            "attempt-open",
            agent,
            _identity(root),
            {
                "operation": "attempt-open",
                "attempt": new_id,
                "ticket": task,
                "agent": agent,
            },
            _docs_preconditions(docs, "state", "log"),
            targets,
            {
                "ok": True,
                "code": "ATTEMPT_OPENED",
                "attempt": new_id,
                "ticket": task,
                "supersedes": latest["id"] if latest is not None else None,
                "event_id": f"E-{event}",
            },
            op_id=op_id,
        )

    # ---- close ----
    pointer = state.get("attempt")
    if not pointer:
        # Replay safety: a committed close re-run finds no pointer. Match the
        # most recently CLOSED attempt against the SAME request and answer
        # idempotent-ok instead of manufacturing a duplicate close event.
        # CORE-005 (audit ed1f86e8): the full close payload must match --
        # result, stop, evidence, unknown, AND close_agent (the actor who
        # actually closed, not the opener). A successor's stale recovery close
        # must be replayable by that same successor. Different evidence/unknown
        # with the same result/stop is NOT an exact replay.
        closed = [
            rec
            for rec in records.values()
            if rec["close_event"] is not None
            and rec.get("result") == result
            and rec.get("stop") == stop
            and rec.get("close_agent") == agent
            and rec.get("evidence") == [e.strip() for e in (evidence or []) if e and e.strip()]
            and rec.get("unknown") == ((unknown or "").strip() or None)
        ]
        if closed:
            latest_closed = max(closed, key=lambda rec: rec["close_event"])
            return {
                "ok": True,
                "code": "ATTEMPT_CLOSED",
                "idempotent": True,
                "attempt": latest_closed["id"],
                "result": result,
                "stop": stop,
                "detail": f"attempt {latest_closed['id']} already closed with "
                "this exact verdict; no duplicate close event written",
            }
        return _refuse(
            "VALIDATION_FAILED",
            "no active attempt to close -- STATE carries no attempt pointer",
        )
    if pointer not in records:
        return _refuse(
            "VALIDATION_FAILED",
            f"STATE.attempt {pointer} has no open event in the LOG -- torn "
            "state; run tools/validate.py",
        )
    rec = records[pointer]
    if rec["close_event"] is not None:
        return _refuse(
            "VALIDATION_FAILED",
            f"attempt {pointer} is already closed (E-{rec['close_event']}) "
            "but the STATE pointer survived -- torn state; run tools/validate.py",
        )

    # W2-002 (audit ed1f86e8): cross-agent stale-attempt recovery is a
    # DIFFERENT operation from an owner closing its own episode. When this
    # close runs over a FOREIGN_STALE claim (a successor recovering a crashed
    # predecessor's dangling attempt before adopting the Work), the successor
    # may only record the recovery verdict (`result interrupted`, `stop
    # unknown` unless a real attributable interruption reason exists), never
    # fabricate terminal meanings like `candidate/completed_execution` for
    # another agent's episode. The close must also end in a validator-green
    # checkpoint and record the explicit ownership handover, so the next step
    # is the canonical claim/adoption -- never PHASE execution under the
    # predecessor's stale BOARD owner.
    _close_is_recovery = False
    _tickets = parse_board(docs["board"].text_norm)["tickets"]
    _cs = ownership.classify_active_ownership(state, _tickets, agent, now=instant).status
    if _cs in (ownership.FOREIGN_STALE, ownership.UNCLAIMED) and rec.get("agent") != agent:
        _close_is_recovery = True
        if result != "interrupted":
            return _refuse(
                "VALIDATION_FAILED",
                f"attempt {pointer} belongs to {rec.get('agent')} whose "
                f"claim is {_cs}; a successor recovers a stale predecessor "
                "episode as `result interrupted`, never a terminal result "
                f"like {result!r}",
                ticket=task,
            )
        if stop not in ("unknown", "agent-crash"):
            return _refuse(
                "VALIDATION_FAILED",
                f"successor recovery of {pointer} may only stop with "
                "'unknown' (or an attributable interruption reason), not "
                f"{stop!r}",
                ticket=task,
            )
    if result not in attempt_mod.RESULTS:
        return _refuse(
            "VALIDATION_FAILED",
            f"attempt result {result!r} outside the closed vocabulary "
            f"{'|'.join(attempt_mod.RESULTS)}",
        )
    allowed_stops = attempt_mod.RESULT_STOP_MATRIX[result]
    if stop not in attempt_mod.STOP_REASONS:
        return _refuse(
            "VALIDATION_FAILED",
            f"attempt stop reason {stop!r} outside the closed vocabulary "
            f"{'|'.join(attempt_mod.STOP_REASONS)}",
        )
    if stop not in allowed_stops:
        return _refuse(
            "VALIDATION_FAILED",
            f"result {result} cannot pair with stop {stop}; allowed stops "
            f"for that result: {'|'.join(allowed_stops)}",
        )
    evidence = [e.strip() for e in (evidence or []) if e and e.strip()]
    if len(evidence) > attempt_mod.MAX_EVIDENCE_REFS:
        return _refuse(
            "VALIDATION_FAILED",
            f"evidence carries {len(evidence)} refs; bound is {attempt_mod.MAX_EVIDENCE_REFS}",
        )
    event_ids = {ev["event"] for ev in docs["_history"].events}
    for ref in evidence:
        if not re.fullmatch(r"E-\d+", ref):
            return _refuse("VALIDATION_FAILED", f"evidence ref {ref!r} is not an E-### id")
        if int(ref[2:]) not in event_ids:
            return _refuse(
                "VALIDATION_FAILED",
                f"evidence {ref} does not exist in the LOG -- dangling "
                "evidence can never prove anything",
            )
    if unknown is not None:
        unknown = unknown.strip() or None
        if unknown and ("\n" in unknown or len(unknown) > attempt_mod.MAX_UNKNOWN_CHARS):
            return _refuse(
                "VALIDATION_FAILED",
                f"unknown clause must be one line of at most {attempt_mod.MAX_UNKNOWN_CHARS} chars",
            )

    text = f"attempt {pointer} close result {result} stop {stop}"
    if evidence:
        text += " -- evidence " + ",".join(evidence)
    if unknown:
        text += f"; unknown: {unknown}"
    event, line = _event_line(docs, log_tail, "DEC", rec.get("ticket"), agent, text, now, op_id)
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    cleaned = remove_state_fields(docs["state"].text_norm, ("attempt",))
    new_state = patch_state(cleaned, {"last_event": event, "updated": utc, "agent": agent})
    new_board = docs["board"].text_norm
    if _close_is_recovery and task and task in _tickets:
        # Validate the complete proposed checkpoint, including release of the
        # predecessor's claim. Recovery closes an episode, not a new claim.
        tick_raw = _tickets[task]["raw"]
        released = tick_raw
        for field in ("owner", "claim_time", "claim_session"):
            released = remove_ticket_field(released, field)
        new_board = new_board.replace(tick_raw, released, 1)
    errors = validate_texts(
        new_state,
        new_board,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed state fails fast validation: " + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
    ]
    if new_board != docs["board"].text_norm:
        targets.append(_target(docs["board"], ".saipen/BOARD.md", "board", new_board))
    targets.append(_target(docs["state"], ".saipen/STATE.md", "state", new_state))
    return build_plan(
        "attempt-close",
        agent,
        _identity(root),
        {
            "operation": "attempt-close",
            "attempt": pointer,
            "result": result,
            "stop": stop,
            "agent": agent,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "ATTEMPT_CLOSED",
            "attempt": pointer,
            "ticket": rec.get("ticket"),
            "result": result,
            "stop": stop,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
    )


@_state_guard
def attempt_lifecycle(
    project_root: Path | str,
    agent: str,
    action: str,
    result: str | None = None,
    stop: str | None = None,
    evidence: list[str] | None = None,
    unknown: str | None = None,
    dry_run: bool = False,
):
    """Public Attempt lifecycle entry (`saipen attempt open|close`)."""
    if action not in ("open", "close"):
        return _refuse("VALIDATION_FAILED", f"attempt action {action!r} outside open|close")
    if action == "close":
        if not result or not stop:
            return _refuse(
                "VALIDATION_FAILED",
                "attempt close needs <RESULT> <STOP> from the closed vocabularies",
            )
    else:
        result = stop = None
    clock = _operation_clock()
    planned = _plan_attempt(
        Path(project_root),
        agent,
        action,
        result,
        stop,
        evidence,
        unknown,
        clock.now,
        clock.utc,
        clock.instant,
    )
    if isinstance(planned, Result):
        return planned
    if isinstance(planned, dict):
        return planned
    if dry_run:
        return _render_plan(planned)
    return apply_plan(Path(project_root), planned)


# ------------------------------------------------------------ transition


def _plan_transition(
    root: Path,
    destination: str,
    agent: str,
    ticket_id: str | None,
    event_text: str,
    now: str,
    utc: str,
) -> OperationPlan | Result:
    destination = destination.upper()
    op_id = "transition-" + uuid4_hex()
    docs, state, board, log_tail = _read(root)
    # SELF-ownership gate (second-wave P0): a transition writes STATE.agent
    # and may mutate the active ticket, so a session may only run it over a
    # claim that is its own (or over a project with no active claim).
    _guard = _active_claim_refusal(state, docs["board"].text_norm, agent)
    if _guard is not None:
        return _guard
    current = state.get("phase")
    if destination not in phases.VALID_TRANSITIONS and destination not in phases.ANY_FROM:
        return _refuse(
            "ILLEGAL_TRANSITION",
            f"{current} -> {destination}: destination outside the phase enum",
            phase=destination,
        )
    if not phases.transition_legal(current, destination):
        # T-1377: a refusal that names the rule and not the move is measured as
        # a loop. `already_done` asked SCOUT -> VERIFY, was told the edge is
        # illegal, and asked BUILD -> REVIEW next; neither answer said which
        # edge leaves the phase the project is actually in.
        legal = phases.VALID_TRANSITIONS.get(current) or []
        # T-1380: the subject is the ACTIVE Work, not the operand or STATE.task.
        # Measured: a project with no Work printed `transition SCOUT none`, the
        # STATE.task literal, and the guard refused that line there. Several
        # DOING rows are a board problem no transition answers.
        doing = [t["id"] for t in board["tickets"].values() if t["section"] == "## DOING"]
        return _refuse(
            "ILLEGAL_TRANSITION",
            f"{current} -> {destination} is not a legal edge"
            + (f"; from {current} the legal edges are {', '.join(legal)}" if legal else ""),
            phase=destination,
            legal_destinations=legal,
            canonical_next_command=(
                phases.forward_route(current, doing[0] if doing else None)
                if len(doing) <= 1
                else None
            ),
        )

    subject = None
    if destination in phases.TICKET_BEARING_PHASES:
        doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
        active = doing[0]["id"] if doing else None
        state_task = state.get("task")
        if active is None:
            return _refuse(
                "ACTIVE_TICKET_MISMATCH",
                f"{destination} is ticket-bearing but no ticket is DOING",
                phase=destination,
            )
        if state_task and active != state_task:
            return _refuse(
                "ACTIVE_TICKET_MISMATCH",
                f"STATE.task={state_task} but BOARD.DOING={active}",
                phase=destination,
            )
        if ticket_id is not None and ticket_id != active:
            if ticket_id not in board["tickets"]:
                return _refuse(
                    "TICKET_NOT_FOUND", f"{ticket_id} is not on the board", ticket=ticket_id
                )
            return _refuse(
                "ACTIVE_TICKET_MISMATCH",
                f"requested ticket {ticket_id} != active DOING "
                f"{active}; a ticket-bearing transition binds the "
                "exact active DOING ticket",
                ticket=ticket_id,
            )
        subject = active
        if subject not in board["tickets"]:
            return _refuse(
                "TICKET_NOT_FOUND",
                f"active ticket {subject} missing from the board",
                ticket=subject,
            )

    if subject and destination in {"BUILD", "REVIEW", "SHIP"}:
        from .intake import boundary_gate

        source_boundary = boundary_gate(root, subject, destination)
        if not source_boundary.get("ok"):
            return _refuse(
                source_boundary.get("code", "SOURCE_CORRUPTION"),
                f"source reread gate at {destination}: {source_boundary}",
                ticket=subject,
                receipt=source_boundary.get("receipt"),
            )

    if subject and destination == "SHIP":
        from .core_unit import evidence_command, ship_gate

        # T-1344: closures recorded green from narrower invocations while the
        # declared core-unit family was red. A project that declares the family
        # ships only on a current-cycle run of it with no red outside baseline.
        core_unit_problem = ship_gate(root, subject, docs["_history"].events)
        if core_unit_problem is not None:
            return _refuse(
                "INCOMPLETE_TICKET",
                f"-> SHIP: {core_unit_problem}",
                phase=destination,
                ticket=subject,
                canonical_next_command=evidence_command(subject),
            )

    if destination == "REVIEW" and current == "VERIFY":
        from .log import verification_evidence

        # T-1014: reuse the snapshot `_read` already captured -- the VERIFY
        # boundary search sees exactly the evidence this plan was validated
        # against, never a second re-read of the complete history.
        history_events = docs["_history"].events
        ok, reason = verification_evidence(subject, history_events)
        if not ok:
            # T-1377: measured -- a session asked twice and got the same
            # sentence twice. The evidence has an exact shape, so the refusal
            # prints the command that writes it.
            return _refuse(
                "INCOMPLETE_TICKET",
                f"VERIFY -> REVIEW requires explicit verification evidence for ticket {subject} (got: {reason})",  # noqa: E501
                phase=destination,
                ticket=subject,
                canonical_next_command=_verification_command(subject),
            )
        regression_problem = _regression_gate(docs, subject)
        if regression_problem is not None:
            return _refuse(
                "INCOMPLETE_TICKET",
                f"VERIFY -> REVIEW: {regression_problem}",
                phase=destination,
                ticket=subject,
            )

    # Machine-owned marker (hostile-regression): the transition text is ALWAYS
    # `transition to {destination}` -- a caller-supplied reason is appended
    # after ` -- `, never replaces the marker. verification_evidence treats
    # the exact marker as the VERIFY boundary, so a replaced marker would
    # silently erase the ticket's verification cycle.
    marker = f"transition to {destination}"
    event_text = marker if not event_text else f"{marker} -- {event_text}"
    event, line = _event_line(
        docs, log_tail, "RUN", subject, agent, event_text, now, op_id, root=root
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    if destination in phases.TICKET_BEARING_PHASES:
        na = f"PHASE {destination} {subject}"
    else:
        na = f"PHASE {destination}"
    owned = {
        "phase": destination,
        "next_action": na,
        "transition_from": current,
        "last_event": event,
        "updated": utc,
        "agent": agent,
    }
    if destination == "DONE":
        owned["task"] = "none"
    new_state = patch_state(docs["state"].text_norm, owned)

    # Goal-counter mechanics (NITRO dogfood II, T-590): a VERIFY -> REVIEW
    # transition under execution_intent: goal is the contract point where a
    # ticket has passed VERIFY. The OPERATION owns the bookkeeping -- it
    # bumps goal_tickets, emits DEC: goal_tickets N->N+1, updates last_event,
    # and writes the WAIT when the valve trips. The model no longer has to
    # remember deterministic accounting.
    if destination == "REVIEW" and current == "VERIFY" and state.get("execution_intent") == "goal":
        tickets = int(state.get("goal_tickets") or 0)
        new_tickets = tickets + 1
        dec_event, dec_line = _producer_event(
            docs,
            event,
            "DEC",
            f"goal_tickets {tickets}->{new_tickets}",
            ticket=None,
            agent=agent,
            now=now,
            op_id=op_id,
        )
        new_log = new_log.rstrip("\n") + "\n" + dec_line + "\n"
        cap_reached = new_tickets >= GOAL_TICKET_CAP
        owned["goal_tickets"] = new_tickets
        owned["last_event"] = dec_event
        if cap_reached:
            owned["next_action"] = (
                f"WAIT: safety valve reached ({state.get('goal_waves') or 0} "
                f"waves / {new_tickets} tickets) -- run 'cc' to continue"
            )
        new_state = patch_state(docs["state"].text_norm, owned)

    # Goal-wave mechanics (NITRO dogfood II, T-590): a HUNT -> ADD transition
    # under execution_intent: goal is the contract point where a
    # HUNT->ADD cycle completes (MAINTENANCE section 2.4). The operation owns
    # the bump: goal_waves N->N+1 with its DEC line, and the valve WAIT.
    elif destination == "ADD" and current == "HUNT" and state.get("execution_intent") == "goal":
        waves = int(state.get("goal_waves") or 0)
        new_waves = waves + 1
        wave_event, wave_line = _producer_event(
            docs,
            event,
            "DEC",
            f"goal_waves {waves}->{new_waves}",
            ticket=None,
            agent=agent,
            now=now,
            op_id=op_id,
        )
        new_log = new_log.rstrip("\n") + "\n" + wave_line + "\n"
        cap_reached = new_waves >= GOAL_WAVE_CAP
        owned["goal_waves"] = new_waves
        owned["last_event"] = wave_event
        if cap_reached:
            owned["next_action"] = (
                f"WAIT: safety valve reached ({new_waves} waves / "
                f"{state.get('goal_tickets') or 0} tickets) -- run 'cc' to "
                "continue"
            )
        new_state = patch_state(docs["state"].text_norm, owned)

    # SELF-owned active ticket: refresh its claim lease in place (CORE § 1.4).
    # Target order LOG -> BOARD -> STATE.
    refreshed_board, _active = _refresh_active_claim(
        docs["board"].text_norm, state, agent, utc, root=root
    )
    new_board = refreshed_board if refreshed_board is not None else docs["board"].text_norm

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED", "proposed state fails fast validation: " + "; ".join(errors[:5])
        )

    targets = [
        *_log_targets(docs, new_log),
    ]
    if refreshed_board is not None:
        targets.append(_target(docs["board"], ".saipen/BOARD.md", "board", new_board))
    targets.append(_target(docs["state"], ".saipen/STATE.md", "state", new_state))
    expected = {
        "ok": True,
        "code": "TRANSITIONED",
        "phase": destination,
        "next_action": na,
        "event_id": f"E-{event}",
        "ticket": subject,
    }
    if destination == "REVIEW" and current == "VERIFY" and state.get("execution_intent") == "goal":
        expected["goal_tickets"] = int(state.get("goal_tickets") or 0) + 1
    return build_plan(
        "transition",
        agent,
        _identity(root),
        {
            "operation": "transition",
            "destination": destination,
            "from_phase": current,
            "ticket": subject,
            "agent": agent,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        expected,
        op_id=op_id,
    )


@_state_guard
def transition_phase(
    project_root: Path | str,
    destination: str,
    agent: str,
    ticket_id: str | None = None,
    event_text: str = "",
    dry_run: bool = False,
) -> Result:
    now, utc = _now(), _utc_iso()
    plan = _plan_transition(Path(project_root), destination, agent, ticket_id, event_text, now, utc)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        # SRC-026:R004 -- the preview path invokes ZERO mutating baseline
        # primitives: the pre-BUILD debt baseline is established only on the
        # real APPLY path, never during planning or dispatch.
        return _render_plan(plan)
    # SRC-026:R004 / W2-001 -- a real SCOUT -> BUILD transition establishes
    # the exact pre-BUILD debt baseline BEFORE BUILD authority is committed.
    # A baseline failure is a deterministic structured refusal: the phase
    # stays SCOUT, no transition event exists and no canonical surface moved.
    _baseline = _establish_pre_build_baseline(Path(project_root), plan, agent)
    if _baseline is not None:
        return _baseline
    return apply_plan(Path(project_root), plan)


def _establish_pre_build_baseline(
    root: Path, plan: "OperationPlan", agent: str
) -> Result | None:
    """Establish the pre-BUILD debt baseline for a real SCOUT -> BUILD plan.

    Returns None when the plan is not a SCOUT -> BUILD transition (nothing to
    do) or when the baseline was established/reused successfully. Returns a
    structured refusal Result when the baseline could not be established --
    BUILD authority is then never committed (fail-closed).

    Ordering invariant: the baseline is a separate journaled operation that
    commits BEFORE the transition applies. If the process dies between the
    two, recovery replays idempotently: ``ensure_debt_baseline`` reuses the
    committed snapshot for the same Work + checkpoint and the transition
    applies on the retry. The invariant "BUILD without baseline" is
    unreachable: the transition only applies after the baseline is verified.
    """
    from .debt import DebtRefusal, ensure_debt_baseline, load_snapshot
    from .errors import CODES

    def _baseline_refuse(code: object, detail: str, *, ticket: str) -> Result:
        # The debt baseline speaks its OWN internal diagnostic vocabulary
        # (`FINDINGS_CAPTURE_FAILED`, `BASELINE_RULESET_CHANGED`, ...), which
        # is NOT the public operation Result vocabulary. Feeding one straight
        # into `Result` raises ValueError and turns a promised deterministic
        # structured refusal into a crash (W2-003 class). A code outside the
        # closed set becomes VALIDATION_FAILED, with the internal code and
        # detail preserved VERBATIM in the message so the cause is never lost.
        text = str(code)
        if text not in CODES:
            return _refuse(
                "VALIDATION_FAILED", f"{text}: {detail}", ticket=ticket
            )
        return _refuse(text, detail, ticket=ticket)

    request = plan.semantic_request
    if request.get("operation") != "transition":
        return None
    if request.get("destination") != "BUILD" or request.get("from_phase") != "SCOUT":
        return None
    subject = request.get("ticket")
    if not subject:
        return None
    try:
        baseline = ensure_debt_baseline(root, subject, agent, plan.created_at)
    except DebtRefusal as refusal:
        return _baseline_refuse(
            refusal.code,
            f"pre-BUILD baseline establishment failed for {subject}: {refusal.detail}",
            ticket=subject,
        )
    if not baseline.get("ok"):
        return _baseline_refuse(
            baseline.get("code", "VALIDATION_FAILED"),
            "pre-BUILD baseline establishment failed for "
            + str(subject)
            + ": "
            + str(baseline.get("detail") or baseline),
            ticket=subject,
        )
    snapshot_id = baseline.get("snapshot_id")
    if not snapshot_id:
        return _refuse(
            "VALIDATION_FAILED",
            f"pre-BUILD baseline for {subject} returned no snapshot identity",
            ticket=subject,
        )
    # Verify the EXACT committed baseline identity before BUILD authority:
    # the snapshot must load fail-closed and be bound to this Work.
    try:
        record = load_snapshot(root, snapshot_id)
    except DebtRefusal as refusal:
        return _baseline_refuse(
            refusal.code,
            f"pre-BUILD baseline {snapshot_id} failed verification for {subject}: "
            f"{refusal.detail}",
            ticket=subject,
        )
    if record.get("bound_work") != subject:
        return _baseline_refuse(
            "DEBT_SNAPSHOT_FOREIGN_WORK",
            f"pre-BUILD baseline {snapshot_id} is bound to "
            f"{record.get('bound_work')!r}, not {subject}",
            ticket=subject,
        )
    return None


# ------------------------------------------------------------- checkpoint


def _schema_upgrade_owned(state: dict) -> dict:
    """The schema/style keys a checkpoint must own to bring a legacy or
    missing-revision STATE up to the running current schema (second-wave P1).

    Protocol requires a readable legacy STATE (missing or lower
    `schema_version`) to upgrade at its next checkpoint. Uses the SAME
    authoritative current-schema/style providers as the Core fix
    (`running_schema_version` / `running_style_token`). Returns {} when the
    persisted revision is already current or FUTURE -- a future or invalid
    revision is never downgraded or reforged.
    """
    current = running_schema_version()
    if current is None:
        return {}
    have = state.get("schema_version")
    try:
        have_int = int(have) if have is not None else None
    except (TypeError, ValueError):
        have_int = None
    if have_int is not None and have_int >= current:
        return {}
    owned = {"schema_version": current}
    style = running_style_token()
    if style:
        owned["style_contract"] = style
    return owned


def _plan_checkpoint(
    root: Path,
    agent: str,
    taxonomy: str,
    ticket_id: str | None,
    description: str,
    now: str,
    utc: str,
) -> OperationPlan | Result:
    op_id = "checkpoint-" + uuid4_hex()
    docs, _state, _board, log_tail = _read(root)
    # SELF-ownership gate (second-wave P0): a checkpoint writes STATE.agent
    # and refreshes the active claim, so it may only run as the SESSION agent
    # on a project whose active DOING claim is its own (or absent).
    _guard = _active_claim_refusal(_state, docs["board"].text_norm, agent)
    if _guard is not None:
        return _guard
    # A ticket-bearing checkpoint names a real ticket. The event is durable
    # LOG identity, so a non-existent / malformed ref would mint a [T-###]
    # that next_ticket_id later reissues and sweep linkage can never resolve
    # (hostile-regression, P1#3). Ticket-LESS session checkpoints stay legal.
    if ticket_id is not None:
        if not re.fullmatch(r"T-\d+", str(ticket_id)):
            # T-1377: measured -- a model passed the whole event text where the
            # ticket goes and got the rule back, not the shape.
            return _refuse(
                "VALIDATION_FAILED",
                f"checkpoint ticket_id {ticket_id!r} is not a valid "
                f"T-### ref (expected T-<digits>): the ticket comes BEFORE the text",
                ticket=ticket_id,
                canonical_next_command='saipen checkpoint RUN <T-###> "<what happened>"',
            )
        if ticket_id not in _board["tickets"]:
            return _refuse(
                "TICKET_NOT_FOUND",
                f"{ticket_id} is not on the board; a checkpoint may only name an existing ticket",
                ticket=ticket_id,
            )
    event, line = _event_line(
        docs, log_tail, taxonomy.upper(), ticket_id, agent, description, now, op_id
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    owned = {
        "last_event": event,
        "updated": utc,
        "agent": agent,
    }
    # Second-wave P1: a legacy or missing-revision STATE must upgrade to the
    # running current schema at its next checkpoint -- protocol REQUIRES a
    # readable legacy STATE to upgrade here, and it never does while the
    # checkpoint owns only last_event/updated/agent. Using the same
    # authoritative current-schema/style providers as the Core fix, atomically
    # add the running `schema_version` and the actual `style_contract` when the
    # persisted revision is absent or strictly lower. A future or otherwise
    # invalid revision is NEVER downgraded or reforged.
    owned.update(_schema_upgrade_owned(_state))
    new_state = patch_state(docs["state"].text_norm, owned)

    # SELF-owned active ticket: refresh its claim lease in place (CORE § 1.4)
    # so an actively worked ticket never goes legally stale while its owner
    # checkpoints. Target order LOG -> BOARD -> STATE.
    refreshed_board, _active = _refresh_active_claim(
        docs["board"].text_norm, _state, agent, utc, root=root
    )
    new_board = refreshed_board if refreshed_board is not None else docs["board"].text_norm

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED", "proposed state fails fast validation: " + "; ".join(errors[:5])
        )

    targets = [
        *_log_targets(docs, new_log),
    ]
    if refreshed_board is not None:
        targets.append(_target(docs["board"], ".saipen/BOARD.md", "board", new_board))
    targets.append(_target(docs["state"], ".saipen/STATE.md", "state", new_state))
    return build_plan(
        "checkpoint",
        agent,
        _identity(root),
        {
            "operation": "checkpoint",
            "taxonomy": taxonomy.upper(),
            "ticket": ticket_id,
            "description": description,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {"ok": True, "code": "CHECKPOINTED", "event_id": f"E-{event}"},
        op_id=op_id,
    )


@_state_guard
def checkpoint(
    project_root: Path | str,
    agent: str,
    taxonomy: str,
    ticket_id: str | None,
    description: str,
    dry_run: bool = False,
) -> Result:
    if taxonomy.upper() not in _CHECKPOINT_TAXONOMIES:
        return _refuse(
            "VALIDATION_FAILED",
            f"taxonomy {taxonomy!r} outside {sorted(_CHECKPOINT_TAXONOMIES)}",
        )
    now, utc = _now(), _utc_iso()
    plan = _plan_checkpoint(Path(project_root), agent, taxonomy, ticket_id, description, now, utc)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(Path(project_root), plan)


# ---------------------------------------------------------- ticket numbers

# BOARD canonical ticket-line shape: a list item whose text starts with the
# checkbox and an uppercase T-NNN. Only these lines are ticket IDENTITY --
# prose that merely mentions "T-900000" in a description or verify clause is
# not a ticket record (T-639/§9).
_BOARD_TICKET_LINE_RE = re.compile(r"^-\s*\[[ x/]\]\s*T-(\d+)\b")


def next_ticket_id(board_text: str, log_text: str, history_max_ticket_id: int | None = None) -> int:
    """The next canonical production ticket ID, from STRUCTURED records only
    (T-639/§9): canonical BOARD ticket lines (`- [ ] T-###`) and the LOG's
    structured `[T-###]` event field. Prose that merely mentions a T-NNN --
    in a ticket description, a verify clause, or LOG message text -- is never
    ticket identity, so a fixture note like "synthetic T-990" or a
    prose-mentioned T-777 cannot poison allocation. The tiny synthetic-id
    exclusion set is gone; structure is what keeps fixtures out.

    `log_text` MUST be the canonical COMPLETE history (sealed segments +
    active LOG.md, `log.read_history`), the same source E-IDs allocate from:
    a sealed segment's [T-###] is durable ticket identity and must never be
    reissued (T-1003).

    PERF-004: when the caller already computed the history-wide max ticket
    ID during its authoritative parse (``HistorySnapshot.max_ticket_id``),
    pass it in and skip the redundant O(history) re-parse. ``log_text`` then
    only needs to be truthy for the historical API shape; the structured
    history IDs come from ``history_max_ticket_id``."""
    ids: set[int] = set()
    for line in board_text.splitlines():
        match = _BOARD_TICKET_LINE_RE.match(line.strip())
        if match:
            ids.add(int(match.group(1)))
    if history_max_ticket_id is not None:
        if history_max_ticket_id > 0:
            ids.add(int(history_max_ticket_id))
        return (max(ids, default=0) + 1) if ids else 1
    from .log import parse_log_line

    for line in log_text.splitlines():
        parsed = parse_log_line(line)
        if parsed is not None and parsed["ticket"]:
            match = re.fullmatch(r"T-(\d+)", parsed["ticket"])
            if match:
                ids.add(int(match.group(1)))
    return (max(ids, default=0) + 1) if ids else 1


def _insert_todo(board_text: str, line: str) -> str:
    assert_live_record(line)
    lines = board_text.splitlines(keepends=True)
    todo_idx = next(i for i, ln in enumerate(lines) if ln.startswith("## TODO"))
    lines.insert(todo_idx + 1, line + "\n")
    return "".join(lines)


def _plan_handback(
    root: Path,
    docs: dict,
    state: dict,
    tickets: dict,
    log_tail: int | None,
    parked: dict,
    agent: str,
    decision: str,
    now: str,
    utc: str,
    op_id: str,
) -> OperationPlan | Result:
    """PLAN the handback of the seat to Work parked on the ACTIVE ticket (T-1473).

    `saipen start` parks the active Work behind a new request with the same
    `block-for` edge a parent takes for its child. When the request's own SCOUT
    finds that its first bounded Work IS the parked Work (a request to continue
    it), nothing could return the seat: `unblock` left the reservation under
    TODO, `block-for` needs a workable TODO blocker and an explicit claim
    refuses a blocked ticket, so the request deadlocked the Work it named.

    The handback is the inverse of that `block-for`, in ONE transaction: the
    holder -- the active DOING ticket of this very seat -- returns to the top of
    TODO unclaimed, and the parked Work returns to DOING at its saved phase
    tuple with the pause edge dropped. The actor hands over only the seat it
    holds now, so a reservation saved for another agent refuses (restore,
    never transfer), as does every other precondition, with zero writes.
    """
    parked_id = parked["id"]
    fields = parked.get("fields", {})
    holder_id = str(fields.get("blocked_on", "")).strip()
    head = str(fields.get("blocker", "")).split(" -- ", 1)[0].strip()
    if head != f"ACTIVE_DEPENDENCY:{holder_id}" or holder_id not in parked.get("needs", []):
        return _refuse(
            "VALIDATION_FAILED",
            f"{parked_id} is reserved on {holder_id} but its blocker/needs do not name "
            "that dependency; the reservation is malformed",
            ticket=parked_id,
        )
    holder = tickets.get(holder_id)
    if (
        holder is None
        or holder.get("section") != "## DOING"
        or state.get("task") != holder_id
        or state.get("phase") not in phases.TICKET_BEARING_PHASES
        or claim_status(holder, agent) != "SELF"
    ):
        return _refuse(
            "CONTINUATION_RESERVED",
            f"{parked_id} is parked on {holder_id} and resumes when {holder_id} closes; "
            f"unblock hands the seat back only while {holder_id} is this seat's "
            "active DOING ticket",
            ticket=parked_id,
        )
    saved_owner = str(fields.get("owner") or "").strip()
    if saved_owner and saved_owner != agent:
        return _refuse(
            "TICKET_NOT_WORKABLE",
            f"{parked_id} is reserved for seat {saved_owner}; a handback returns only "
            f"the seat {agent} holds (restore, never transfer)",
            ticket=parked_id,
        )
    resume_phase = str(fields.get("resume_phase", "")).strip()
    resume_from = str(fields.get("resume_transition_from", "")).strip()
    if resume_phase not in phases.TICKET_BEARING_PHASES:
        return _refuse(
            "VALIDATION_FAILED",
            f"{parked_id} is parked with resume_phase {resume_phase!r}; restoring it "
            "would fabricate a phase",
            ticket=parked_id,
        )
    other_needs = [need for need in parked.get("needs", []) if need != holder_id]
    unmet = [
        need for need in other_needs if tickets.get(need, {}).get("section") != "## DONE"
    ]
    if unmet:
        return _refuse(
            "TICKET_NOT_WORKABLE",
            f"{parked_id} still needs {', '.join(unmet)}; the seat would go to Work its "
            "own dependencies block",
            ticket=parked_id,
        )

    event, holder_line = _event_line(
        docs,
        log_tail,
        "DEC",
        holder_id,
        agent,
        f"ticket checkpointed to TODO via SAIOPS -- handback: {holder_id} returns the seat "
        f"to {parked_id}, which was parked on it",
        now,
        op_id,
        root=root,
    )
    event, parked_line = _event_line(
        docs,
        event,
        "DEC",
        parked_id,
        agent,
        f"ticket unblock via SAIOPS (handback from {holder_id}) -- resumes at "
        f"{resume_phase} -- {redact_credentials(decision)}",
        now,
        op_id,
        root=root,
    )
    new_log = (
        docs["log"].text_norm.rstrip("\n") + "\n" + holder_line + "\n" + parked_line + "\n"
    )
    binding = host_session_binding(root)

    def _propose(board_text: str) -> str:
        board_text = _move_ticket(
            board_text, holder_id, "## TODO", "[ ]", "demote", "", enforce_cap=False
        )
        board_text = _ticket_fields_in_place(
            board_text,
            holder_id,
            {},
            remove=("owner", "claim_time", "claim_session"),
            enforce_cap=False,
        )
        board_text = _move_ticket(
            board_text, parked_id, "## DOING", "[/]", "resume", "", enforce_cap=False
        )
        claim = {"owner": agent, "claim_time": utc}
        remove = [
            "blocker",
            "blocker_scope",
            "blocked_on",
            "resume_phase",
            "resume_transition_from",
            "retry_not_before",
        ]
        if binding:
            claim["claim_session"] = binding
        else:
            remove.append("claim_session")
        if other_needs:
            claim["needs"] = ",".join(other_needs)
        else:
            remove.append("needs")
        return _ticket_fields_in_place(
            board_text, parked_id, claim, remove=tuple(remove), enforce_cap=False
        )

    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            _propose,
            [holder_id, parked_id],
            op_id=op_id,
            event_id=f"E-{event}",
            reason="existing/proposed oversized BOARD record requires canonical handback update",
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=parked_id)
    new_board = projected.board_text
    next_action = str(state.get("next_action") or "")
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "phase": resume_phase,
            "task": parked_id,
            # A hard stop outranks the handback: a WAIT is kept verbatim.
            "next_action": next_action
            if next_action.startswith("WAIT:")
            else f"PHASE {resume_phase} {parked_id}",
            "transition_from": resume_from,
            "last_event": event,
            "updated": utc,
            "agent": agent,
        },
    )
    new_state = _settle_stop_reason(new_state, new_board, agent)
    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed handback state fails fast validation: " + "; ".join(errors[:5]),
            ticket=parked_id,
        )
    targets = [
        *_log_targets(docs, new_log),
        *projected.targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "ticket_move",
        agent,
        _identity(root),
        {"operation": "ticket_move", "action": "unblock", "ticket": parked_id, "holder": holder_id},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "HANDBACK",
            "ticket": parked_id,
            "holder": holder_id,
            "phase": resume_phase,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
    )


def _ticket_targets(
    root: Path,
    action: str,
    ticket_id: str,
    agent: str,
    payload: str,
    now: str,
    utc: str,
    scope: str | None = None,
    blocked_on: str | None = None,
    retry_not_before: str | None = None,
) -> OperationPlan | Result:
    op_id = "ticket-" + uuid4_hex()
    # T-1429: one canonical machine due instant, written only by a block and
    # always strict-UTC. A malformed or naive stamp is refused HERE (PLAN
    # time, zero writes) -- it never degrades to host-local interpretation.
    _rnb = str(retry_not_before or "").strip()
    if _rnb and action not in ("block", "block-for"):
        return _refuse(
            "VALIDATION_FAILED",
            "retry_not_before may be written only by a block (it is "
            "ACTIVE blocked-state data)",
            ticket=ticket_id,
        )
    if _rnb and iso_utc_sort_key(_rnb) is None:
        return _refuse(
            "VALIDATION_FAILED",
            f"retry_not_before {_rnb!r} is not strict UTC "
            "(YYYY-MM-DDTHH:MM:SS[.fff]Z); naive/local/malformed stamps "
            "are refused, never reinterpreted as host time",
            ticket=ticket_id,
        )
    if _rnb:
        # T-1429: the public writer must not be able to author state the
        # projection then refuses to honour. `block-for` always writes an
        # ACTIVE_DEPENDENCY blocker, which is never operator-owned, so it
        # is refused here too -- a dependency is not a person with a clock.
        from .board import _DEFERRED_OPERATOR_BLOCKER_CLASSES, deferred_operator_class

        _candidate = "ACTIVE_DEPENDENCY:" if action == "block-for" else str(payload or "")
        if deferred_operator_class(_candidate) is None:
            _head = _candidate.strip().split(" -- ", 1)[0].strip() or "(empty)"
            return _refuse(
                "VALIDATION_FAILED",
                f"retry_not_before needs an operator-owned deferred blocker "
                f"({'|'.join(sorted(_DEFERRED_OPERATOR_BLOCKER_CLASSES))}); "
                f"blocker {_head!r} is not one, so the due instant would "
                "never be reported operator-actionable",
                ticket=ticket_id,
            )
    # CORE-003: blocker SCOPE is the difference between "this task is stuck"
    # and "nothing can be done at all". The FastPrompter loop stopped because
    # the protocol had only the second meaning, so parking one ticket parked
    # everything. An undeclared scope reads as `ticket`.
    _scope = (scope or DEFAULT_BLOCKER_SCOPE).strip().lower()
    if action in ("block", "block-for") and _scope not in BLOCKER_SCOPES:
        return _refuse(
            "VALIDATION_FAILED",
            f"blocker scope {scope!r} is outside {'|'.join(BLOCKER_SCOPES)}",
            ticket=ticket_id,
        )
    docs, state, board, log_tail = _read(root)
    # SELF-ownership gate (second-wave P0): blocking the active DOING ticket
    # parks A's live claim; a session may only do that over its own claim.
    _guard = _active_claim_refusal(state, docs["board"].text_norm, agent, ticket_id=ticket_id)
    if _guard is not None:
        return _guard
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=ticket_id,
        )
    tickets = board["tickets"]
    if ticket_id not in tickets:
        return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
    ticket = tickets[ticket_id]

    if action == "done":
        # `done` is the atomic finish operation, never a raw section move
        # (NITRO dogfood III, T-591); the split it used to leave is now a
        # corruption the fast binding rejects.
        return _refuse(
            "ILLEGAL_TICKET_LIFECYCLE",
            "done is the atomic finish operation; use finish_ticket "
            "or `saipen ticket done` (it closes LOG+BOARD+STATE "
            "together)",
            ticket=ticket_id,
        )
    elif action in ("block", "block-for"):
        if not payload or not payload.strip():
            return _refuse(
                "VALIDATION_FAILED",
                "block requires the facts/dead ends that justify the block",
                ticket=ticket_id,
            )
        if ticket["section"] not in ("## DOING", "## TODO"):
            return _refuse(
                "ILLEGAL_TICKET_LIFECYCLE",
                f"{action} accepts DOING or TODO; {ticket_id} is under {ticket['section']}",
                ticket=ticket_id,
            )
        target_section, checkbox = "## BLOCKED", "[ ]"
    elif action == "unblock":
        if not payload or not payload.strip():
            return _refuse(
                "VALIDATION_FAILED",
                "unblock requires the decision/evidence that lifts the block",
                ticket=ticket_id,
            )
        if ticket["section"] != "## BLOCKED":
            return _refuse(
                "ILLEGAL_TICKET_LIFECYCLE",
                f"unblock accepts only BLOCKED; {ticket_id} is under {ticket['section']}",
                ticket=ticket_id,
            )
        if str(ticket.get("fields", {}).get("blocked_on", "")).strip():
            # T-1473: parked Work carries a continuation reservation, which is
            # only legal under BLOCKED; lifting it is the handback or nothing.
            return _plan_handback(
                root, docs, state, tickets, log_tail, ticket, agent, payload, now, utc, op_id
            )
        target_section, checkbox = "## TODO", "[ ]"
    else:
        return _refuse("VALIDATION_FAILED", f"unknown ticket action {action!r}")

    # Blocking the ACTIVE DOING ticket parks the current work: the ticket
    # leaves ## DOING, so the execution state must not keep naming it in a
    # ticket-bearing phase, and the block MUST NOT become a session-level
    # phase: BLOCKED -- that state is reserved for when no ticket anywhere is
    # workable (CORE.md § 1.11), carries its own STATE.blocker + WAIT, and
    # contradicts a running goal intent. The block therefore neutralizes the
    # execution state to DONE/task none (the same no-active-ticket form
    # finish_ticket uses) and routes the next_action from the RESULTING
    # board. Blocking a merely-TODO ticket leaves execution state untouched.
    # The ACTIVE case must be provable from the LOG alone: the block event
    # carries an explicit (active) marker so the validator's block-park
    # exception can never be satisfied by a TODO-ticket block event.
    if action == "block-for":
        child_id = str(blocked_on or "").strip()
        if not re.fullmatch(r"T-\d+", child_id):
            return _refuse(
                "VALIDATION_FAILED",
                "block-for requires one child blocker T-### identity",
                ticket=ticket_id,
            )
        child = tickets.get(child_id)
        if child is None:
            return _refuse("TICKET_NOT_FOUND", f"blocker {child_id} not on the board")
        if child_id == ticket_id:
            return _refuse("VALIDATION_FAILED", "a ticket cannot block on itself", ticket=ticket_id)
        if child.get("section") != "## TODO" or not ticket_is_workable(
            child, tickets, agent=agent
        ):
            return _refuse(
                "TICKET_NOT_WORKABLE",
                f"blocker {child_id} must be a workable ## TODO ticket",
                ticket=child_id,
            )
        for candidate in tickets.values():
            if str(candidate.get("fields", {}).get("blocked_on", "")).strip() == child_id:
                return _refuse(
                    "CONTINUATION_RESERVED",
                    f"{child_id} already resumes parent {candidate['id']}",
                    ticket=child_id,
                )

    is_active_block = (
        action in ("block", "block-for")
        and state.get("task") == ticket_id
        and ticket["section"] == "## DOING"
        and state.get("phase") in phases.TICKET_BEARING_PHASES
    )
    if action in ("block", "block-for") and ticket["section"] == "## DOING" and not is_active_block:
        return _refuse(
            "ILLEGAL_TICKET_LIFECYCLE",
            f"blocking DOING ticket {ticket_id} requires a "
            f"ticket-bearing source phase "
            f"({', '.join(sorted(phases.TICKET_BEARING_PHASES))}); "
            f"STATE is {state.get('phase')!r} with task "
            f"{state.get('task')!r}",
            ticket=ticket_id,
        )
    _safe_payload = redact_credentials(payload) if payload else ""
    event_structure = None
    if is_active_block:
        event_structure = active_ticket_block_structure(
            child_id if action == "block-for" else None
        )
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        ticket_id,
        agent,
        f"ticket {'block' if action == 'block-for' else action} via SAIOPS"
        + (" (active)" if is_active_block else "")
        + (f" -- dependency {child_id}" if action == "block-for" else "")
        + (f" -- {_safe_payload}" if _safe_payload else ""),
        now,
        op_id,
        root=root,
        structure=event_structure,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    # T-1101: redact credentials in the payload before it reaches BOARD
    block_payload = _safe_payload
    if action == "block-for":
        block_payload = f"ACTIVE_DEPENDENCY:{child_id} -- {_safe_payload}"

    def _propose_moved(board: str) -> str:
        moved = _move_ticket(
            board,
            ticket_id,
            target_section,
            checkbox,
            "block" if action == "block-for" else action,
            block_payload,
            blocker_scope=_scope if action in ("block", "block-for") else None,
            retry_not_before=strict_iso_utc(_rnb) if _rnb else None,
            enforce_cap=False,
        )
        if action == "block-for":
            needs = list(ticket.get("needs", []))
            if child_id not in needs:
                needs.append(child_id)
            moved = _ticket_fields_in_place(
                moved,
                ticket_id,
                {
                    "needs": ",".join(needs),
                    "blocked_on": child_id,
                    "resume_phase": str(state.get("phase")),
                    "resume_transition_from": str(state.get("transition_from")),
                },
                enforce_cap=False,
            )
        return moved

    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            _propose_moved,
            [ticket_id],
            op_id=op_id,
            event_id=f"E-{event}",
            reason=(
                "existing/proposed oversized BOARD record requires canonical ticket "
                f"{action} update"
            ),
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    new_board = projected.board_text
    compaction_targets = list(projected.targets)
    owned = {
        "last_event": event,
        "updated": utc,
        "agent": agent,
    }
    if is_active_block:
        if not state.get("phase"):
            return _refuse(
                "VALIDATION_FAILED",
                "blocking the active ticket needs a real source "
                "phase; STATE carries none, so transition_from "
                "would be fabricated",
                ticket=ticket_id,
            )
        owned["phase"] = "DONE"
        owned["task"] = "none"
        if str(state.get("next_action") or "").startswith("WAIT:"):
            owned["next_action"] = state.get("next_action")
        else:
            owned["next_action"] = "saipen continue"
        owned["transition_from"] = state.get("phase")
    elif state.get("phase") == "DONE" and state.get("transition_from") in (
        "SCOUT",
        "BUILD",
        "VERIFY",
        "REVIEW",
        "SHIP",
    ):
        # This ticket move is a later canonical state event. If it follows an
        # active-ticket block, record the actual DONE -> DONE self-transition
        # so an unblock cannot leave STATE claiming the narrow block-parked
        # exception after the ticket has left BOARD.BLOCKED.
        owned["transition_from"] = "DONE"
    new_state = patch_state(docs["state"].text_norm, owned)
    # Routing after a structural move must not walk over a hard stop: a
    # safety-valve or user WAIT is preserved, never replaced by a fresh pick.
    # Unblock also re-routes, because moving a line back into ## TODO changes
    # the topmost-workable order the neutral state's next_action points at.
    from .router import route_next

    if action in ("block", "block-for", "unblock") and not str(
        state.get("next_action") or ""
    ).startswith(
        "WAIT:"
    ):
        _neutral = state.get("task") in (None, "none") and not any(
            t["section"] == "## DOING" for t in parse_board(new_board)["tickets"].values()
        )
        if _neutral or is_active_block:
            # CORE-003: settle the stop reason BEFORE routing, so the router
            # reads the same state that will be persisted and the two cannot
            # disagree about whether the loop is goal-blocked.
            new_state = _settle_stop_reason(new_state, new_board, agent)
            routed = route_next(new_state, new_board, current_agent=agent)
            if routed.get("ok"):
                new_state = patch_state(new_state, {"next_action": routed["action"]})
    else:
        new_state = _settle_stop_reason(new_state, new_board, agent)

    planned_detail_events = (
        {event} if is_active_block and docs.get("_log_detail_targets") else set()
    )
    errors = validate_texts(
        new_state,
        new_board,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
        planned_detail_events=planned_detail_events,
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED", "proposed state fails fast validation: " + "; ".join(errors[:5])
        )

    targets = [
        *_log_targets(docs, new_log),
        *compaction_targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "ticket_move",
        agent,
        _identity(root),
        {
            "operation": "ticket_move",
            "action": action,
            "ticket": ticket_id,
            "blocked_on": blocked_on,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "BLOCKED_FOR" if action == "block-for" else action.upper(),
            "ticket": ticket_id,
            "blocked_on": blocked_on,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
    )


def _only_request_clauses_await(root: Path, source_gate: dict) -> bool:
    """True when the ONLY thing the coverage gate wants is the request's clause.

    That case is not a coverage problem at all: the request's clause is
    discharged by the Work's own verification evidence, so the honest refusal
    is the missing evidence, with the command that writes it.
    """
    from .intake import ensure_request_clause, is_request_clause

    receipt = source_gate.get("receipt")
    if not receipt:
        return False
    unresolved = list((source_gate.get("coverage") or {}).get("unresolved") or [])
    if not unresolved:
        # A receipt whose contract has no clauses at all is the same case: the
        # clause it is missing IS its own request.
        return bool(ensure_request_clause(root, receipt).get("ok"))
    return all(is_request_clause(root, receipt, rid) for rid in unresolved)


def _verification_command(ticket_id: str) -> str:
    """The exact checkpoint that satisfies the verification-evidence gate.

    `log.verification_evidence` accepts a RUN event after the current VERIFY
    boundary carrying the PASS token and `conf: high`. That is a SHAPE, and
    printing the rule instead of the shape is what the field measured as a
    loop -- twice in one session, and twice more in this repository's own work.
    """
    return (
        f'saipen checkpoint RUN {ticket_id} "verify -> PASS [target: {ticket_id}] '
        f'conf: high -- <the command that ran and what it reported>"'
    )


#: The phases whose checkpoints fall after a VERIFY boundary, so a PASS written
#: there can count. Before VERIFY nothing written can.
_EVIDENCE_PHASES = frozenset({"VERIFY", "REVIEW", "SHIP"})


def _evidence_route(ticket_id: str, reason: str, phase: str | None) -> str | None:
    """The move that discharges a missing-verification refusal FROM `phase`.

    T-1380, measured by running the old route: finish from BUILD answered
    `no current-cycle VERIFY boundary` with the PASS checkpoint, the checkpoint
    succeeded, and the refusal came back byte-identical -- evidence counts only
    after the boundary, and BUILD has none. Before the cycle exists the move is
    the phase edge; inside it, the evidence shape.
    """
    from .log import NO_VERIFY_BOUNDARY

    if reason == NO_VERIFY_BOUNDARY and phase not in _EVIDENCE_PHASES:
        return phases.forward_route(phase, ticket_id)
    return _verification_command(ticket_id)


def closure_request_error(
    closure_mode: str | None,
    closure_cohort: str | None,
    implementation_source: str | None,
    closure_paths,
) -> str | None:
    """Why this closure request is malformed, or None (CORE-003).

    ONE grammar check, evaluated BEFORE any plan is built so every refusal is
    zero-write. It is separate from the resolver on purpose: "you did not name
    an authority" and "the authority you named is not published" are different
    findings and an agent has to be able to tell them apart.
    """
    mode = (closure_mode or DEFAULT_CLOSURE_MODE).strip()
    if mode not in CLOSURE_MODES:
        return (
            f"closure_mode {closure_mode!r} is outside "
            f"{'|'.join(CLOSURE_MODES)}"
        )
    if mode == "superseded_verified":
        return (
            "closure_mode superseded_verified is written only by `saipen ticket "
            "supersede T-OLD --by T-NEW --evidence E-### --authority SRC-###`"
        )
    if mode == "external_implementation":
        return (
            "closure_mode external_implementation is written only by `saipen "
            "ticket resolve-external <T-###> --authority lineage-<32hex> "
            "--implementation T-###@<commit> --reason <CLASS> --run <command>`; "
            "`ticket done` can never claim local implementation for externally "
            "implemented work"
        )
    if mode == "inherited_verified" and not (implementation_source or "").strip():
        return (
            "closure_mode inherited_verified requires --implementation-source "
            "<release:<id>|T-###|SRC-###>: a closure that adds no implementation "
            "must name the durable authority that published it"
        )
    if mode != "inherited_verified" and (implementation_source or "").strip():
        return (
            f"--implementation-source is only valid with closure_mode "
            f"inherited_verified, not {mode}"
        )
    if mode == "cohort" and not (closure_cohort or "").strip():
        return (
            "closure_mode cohort requires --closure-cohort C-###: a closure_cohort "
            "authority is what owns the deferred publication"
        )
    if mode != "cohort" and (closure_cohort or "").strip():
        return (
            f"--closure-cohort is only valid with closure_mode cohort, not {mode}; "
            f"run: saipen ticket done <T-###> --closure-mode {mode}"
        )
    if (closure_cohort or "").strip() and not _COHORT_ID_RE.fullmatch(closure_cohort.strip()):
        return f"closure_cohort {closure_cohort!r} is not a C-### identity"
    paths = [str(x).strip() for x in (closure_paths or []) if str(x).strip()]
    if mode == "cohort" and not paths:
        return (
            "closure_mode cohort requires --paths: the shared worktree paths "
            "this member attributes to the batch are the cohort's scope"
        )
    if mode != "cohort" and paths:
        # T-1377: measured twice in the field -- the refusal named the rule and
        # the sessions retried the same line. The corrected command is one
        # deletion away, so it is printed.
        return (
            f"--paths is only valid with closure_mode cohort, not {mode}; "
            f"run: saipen ticket done <T-###> --closure-mode {mode}"
        )
    return None


def _plan_finish_ticket(
    root: Path,
    ticket_id: str,
    agent: str,
    now: str,
    utc: str,
    digest_text: str | None = None,
    digest_done: str | None = None,
    digest_awaiting: str | None = None,
    prefix_run: str | None = None,
    closure_mode: str | None = None,
    closure_cohort: str | None = None,
    implementation_source: str | None = None,
    closure_paths=None,
) -> OperationPlan | Result:
    """PLAN the ONE atomic ticket-closure operation (NITRO dogfood III).

    Closing a ticket is a cross-file transaction, not choreography: the split
    `transition state; move board ticket; repair next_action` leaves BOARD
    DONE[x] while STATE still names the ticket in a ticket-bearing phase --
    the exact corruption reproduced in DOGFOOD III. ONE OperationPlan owns:

    LOG:   ticket completion event (and, for a release closure, ONE truthful
           RUN event emitted immediately before it -- `prefix_run`, T-994 /
           § 15 -- so the release evidence is written by the SAME canonical
           LOG machinery, never a second writer, and the journal carries a
           single LOG target recovery can verify)
    BOARD: DOING -> DONE, [/] -> [x]
    STATE: phase -> DONE, task -> none, transition_from -> SHIP (the ACTUAL
           previous phase), last_event -> completion event, updated, agent
    NEXT:  computed from the resulting proposed state by the shared router.

    GATE PRECONDITION (NITRO dogfood IV, T-602): the ordinary ticket
    completion requires the ticket to have actually passed its required
    gates -- STATE.phase MUST be SHIP, STATE.task MUST be the ticket, and
    exactly one BOARD.DOING MUST be the ticket. From SCOUT/BUILD/VERIFY/
    REVIEW the finish REFUSEs ILLEGAL_PHASE with zero canonical bytes
    written. `transition_from` records the ACTUAL previous phase -- never a
    fabricated legal-looking DONE source. The SHIP gate cannot be skipped by
    laundering the phase history into a legal-looking final STATE.

    Required preconditions: exactly one BOARD.DOING, STATE.task == that
    ticket, ticket identity matches. No split-state window exists.
    """
    op_id = "finish-" + uuid4_hex()
    # CORE-003: the closure GRAMMAR is checked before the project is even
    # read, so a malformed request cannot touch the filesystem at all.
    _grammar = closure_request_error(
        closure_mode, closure_cohort, implementation_source, closure_paths
    )
    if _grammar is not None:
        # T-1377: the grammar sentence already knows the corrected command;
        # carrying it in the machine field is what a weak model can act on.
        route = None
        if "; run: " in _grammar:
            route = _grammar.split("; run: ", 1)[1].strip().replace(
                "<T-###>", ticket_id or "<T-###>"
            )
        return _refuse(
            "VALIDATION_FAILED", _grammar, ticket=ticket_id, canonical_next_command=route
        )
    _mode = (closure_mode or DEFAULT_CLOSURE_MODE).strip()
    _cohort_id = (closure_cohort or "").strip()
    _impl_source = (implementation_source or "").strip()
    _paths = [str(x).strip().replace("\\", "/") for x in (closure_paths or []) if str(x).strip()]
    docs, state, board, log_tail = _read(root)
    # T-1162: a short BOARD title cannot close Work whose authoritative
    # source still has missing, corrupt, or uncovered clauses. This gate
    # rereads the original body and verifies its digest; model memory and a
    # green umbrella ticket are not closure evidence.
    from .intake import discharge_request_clauses, work_closure_gate

    source_gate = work_closure_gate(root, ticket_id)
    if not source_gate.get("ok") and source_gate.get("code") == "SOURCE_UNRESOLVED":
        # T-1379: the request's own clause is discharged by the Work's own
        # verification evidence, here, at the one moment both exist. Measured
        # live: `saipen start` captured a receipt with an empty contract, so
        # this gate answered SOURCE_UNRESOLVED forever and the ticket the
        # canonical entry command created could not be finished by any command
        # the CLI offers. The evidence gate below still decides whether this
        # Work proved anything -- nothing is settled without it.
        from .log import verification_evidence

        proven, reason = verification_evidence(ticket_id, docs["_history"].events)
        if proven:
            settled = discharge_request_clauses(
                root,
                ticket_id,
                evidence=f"{ticket_id} closed with verification evidence in LOG: {reason[:400]}",
                verification=(
                    f"the Work this request created reached its own verification gate; "
                    f"see the {ticket_id} VERIFY cycle in .saipen/LOG.md"
                ),
            )
            if settled:
                source_gate = work_closure_gate(root, ticket_id)
        elif _only_request_clauses_await(root, source_gate):
            # T-1377: name the ROOT cause, not the symptom. The coverage is not
            # what is missing here -- the Work's own verification evidence is,
            # and once it exists this gate settles the request's clause itself.
            # Answering SOURCE_UNRESOLVED sent the model to a ledger it cannot
            # edit instead of to the checkpoint it can write.
            return _refuse(
                "INCOMPLETE_TICKET",
                f"finish requires explicit verification evidence for ticket {ticket_id} "
                f"(got: {reason}); the linked request's own clause is settled from it",
                ticket=ticket_id,
                receipt=source_gate.get("receipt"),
                canonical_next_command=_evidence_route(ticket_id, reason, state.get("phase")),
            )
    if not source_gate.get("ok"):
        # T-1403: a repairable closure refusal must NAME a finite executable
        # route, from current source-clause truth -- never prose and never a
        # hardcoded code->block. The router consults the SAME decision owner
        # (`closure_readiness`) before it emits a finish route, so this refusal
        # and that gate can never disagree.
        try:
            from .closure_readiness import closure_readiness

            _route = closure_readiness(root, ticket_id).get("canonical_next_command")
        except Exception:
            _route = None
        return _refuse(
            source_gate.get("code", "SOURCE_UNRESOLVED"),
            f"source coverage gate for {ticket_id}: {source_gate}",
            ticket=ticket_id,
            receipt=source_gate.get("receipt"),
            unresolved=(source_gate.get("coverage") or {}).get("unresolved"),
            canonical_next_command=_route,
        )
    # SELF-ownership gate (second-wave P0): finishing a ticket is THE active
    # mutation -- it closes the DOING claim and rewrites STATE.agent.
    _guard = _active_claim_refusal(state, docs["board"].text_norm, agent, ticket_id=ticket_id)
    if _guard is not None:
        return _guard
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=ticket_id,
        )
    tickets = board["tickets"]
    if ticket_id not in tickets:
        return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
    ticket = tickets[ticket_id]
    if ticket["section"] != "## DOING" or ticket["checkbox"] != "/":
        return _refuse(
            "ILLEGAL_TICKET_LIFECYCLE",
            f"finish accepts only a ## DOING [/] ticket; "
            f"{ticket_id} is {ticket['section']} "
            f"[{ticket['checkbox']}]",
            ticket=ticket_id,
        )
    doing = [t for t in tickets.values() if t["section"] == "## DOING"]
    if len(doing) != 1:
        return _refuse(
            "ACTIVE_TICKET_MISMATCH",
            f"finish needs exactly one ## DOING ticket, found {len(doing)}",
            ticket=ticket_id,
        )
    if state.get("task") != ticket_id:
        return _refuse(
            "ACTIVE_TICKET_MISMATCH",
            f"STATE.task={state.get('task')} != finished ticket {ticket_id}",
            ticket=ticket_id,
        )

    prev_phase = state.get("phase") or "DONE"

    # GATE: the canonical closure is SHIP -> DONE (CORE section 1.6). A
    # ticket may only be closed after its required gates (SCOUT/BUILD/VERIFY/
    # REVIEW/SHIP) actually ran in a legal path. The DFA makes SHIP reachable
    # only from REVIEW, and every transition is journaled, so requiring
    # phase == SHIP here IS the gate proof. Refusing from any earlier phase
    # with zero canonical bytes written is what makes skipped gates
    # mechanically impossible (NITRO dogfood IV, T-602). This gate runs
    # BEFORE the verification-evidence check: an unfinished phase chain is
    # the primary violation, so ILLEGAL_PHASE wins over INCOMPLETE_TICKET
    # from any phase before SHIP.
    if prev_phase != "SHIP":
        return _refuse(
            "ILLEGAL_PHASE",
            f"finish requires phase SHIP (the canonical closure edge "
            f"SHIP -> DONE); actual phase {prev_phase} cannot close a ticket "
            "without its required REVIEW/SHIP gates. Run the ticket through "
            "REVIEW then SHIP first; the gates cannot be skipped by "
            "laundering the phase history",
            ticket=ticket_id,
            phase=prev_phase,
            # T-1380, measured live: a session in REVIEW ran `ticket done`
            # twice. The sentence says which gates are missing; this says which
            # command supplies the next one -- the DFA's forward edge out of the
            # phase the ticket is actually in, because REVIEW can send Work back
            # to BUILD and `transition REVIEW` is not an edge from there.
            canonical_next_command=phases.forward_route(prev_phase, ticket_id),
        )
    closure_from = prev_phase  # the ACTUAL phase: SHIP.

    # Attempt gate (T-1148): completion authority belongs to the Work's
    # verification chain, not to a live episode. An open attempt must be
    # closed (normally `candidate`) BEFORE the ticket can finish, so the
    # producing episode's claim and the Work's admission stay two separate,
    # ordered facts.
    if state.get("attempt"):
        return _refuse(
            "INCOMPLETE_TICKET",
            f"attempt {state.get('attempt')} is still open on {ticket_id} -- "
            "close it (result candidate, stop completed_execution) before "
            "completion; the producer's live episode must not close the Work",
            ticket=ticket_id,
        )

    # CORE-002 (audit ed1f86e8): writer-side finish must apply the SAME
    # ticket-level admission rule full validation applies. The producing
    # candidate attempt needs a VERIFY boundary AFTER its close; a later
    # non-candidate attempt must not erase that obligation. Without this, the
    # CLI can commit a DONE the validator then rejects, or a later interrupted
    # attempt can make an invalid completion appear conformant.
    try:
        from . import attempt as _attempt_mod

        _hist_events = docs.get("_history").events if docs.get("_history") else ()
        _att_records, _att_errors = _attempt_mod.build_attempts(_hist_events)
        if _att_errors:
            return _refuse(
                "VALIDATION_FAILED",
                "LOG carries malformed attempt history; run tools/validate.py: "
                + "; ".join(_att_errors[:3]),
                ticket=ticket_id,
            )
        _adm_err = _attempt_mod.ticket_admission_error(ticket_id, _att_records, _hist_events)
        if _adm_err:
            return _refuse(
                "INCOMPLETE_TICKET",
                _adm_err,
                ticket=ticket_id,
            )
    except Exception:
        # Attempt admission is a gate, not a substitute for the rest of the
        # closure; a failure to derive it must refuse rather than silently
        # bypass admission authority.
        return _refuse(
            "VALIDATION_FAILED",
            f"cannot derive attempt admission for {ticket_id}; run "
            "tools/validate.py before completing",
            ticket=ticket_id,
        )

    # Verification-evidence gate (T-602, closure-evidence): with the phase
    # chain complete, the ticket still needs explicit verification evidence
    # in the LOG for the current cycle (a VERIFY boundary plus a PASS).
    # T-1014: reuse the snapshot `_read` already captured for the SAME
    # evidence the plan was validated against.
    from .log import verification_evidence

    history_events = docs["_history"].events
    ok, reason = verification_evidence(ticket_id, history_events)
    if not ok:
        return _refuse(
            "INCOMPLETE_TICKET",
            f"finish requires explicit verification evidence for ticket {ticket_id} (got: {reason})",  # noqa: E501
            ticket=ticket_id,
            canonical_next_command=_evidence_route(ticket_id, reason, prev_phase),
        )
    regression_problem = _regression_gate(docs, ticket_id)
    if regression_problem is not None:
        return _refuse(
            "INCOMPLETE_TICKET",
            f"finish: {regression_problem}",
            ticket=ticket_id,
        )

    # A parent parked by `ticket block-for` owns the continuation after this
    # child closes. The relation is read from BOARD authority, never inferred
    # from prose or queue order. It is consumed below in the SAME journaled
    # finish transaction, so no unrelated ticket can take the single DOING
    # seat between child completion and parent resumption.
    resume_parent = continuation_parent(tickets, ticket_id, require_done=False)

    # T-1436: DEPENDENCY COMPLETION IS NOT A CLAIM EVENT. A parent resumed by
    # its child's closure may retain a live claim ONLY when the actor closing
    # the child NOW is mechanically proven to be the SAME host session the
    # reservation names -- the saved claim_session binding equals this
    # process's binding. Anything else (a different session, no saved binding,
    # no provable binding) restores the Work WITHOUT any claim: the previous
    # owner stays historical attribution in the resume LOG line, and the seat
    # is adopted explicitly by whoever actually resumes the Work. The old
    # behaviour wrote `owner` + a fresh `claim_time` with no session write,
    # so a dead window's name carried a fresh 15-minute FOREIGN_LIVE window
    # and every other agent got WAIT_FOREIGN_OWNER for a session that never
    # reclaimed the seat (measured E-7715/E-7716).
    resume_claim_mode = None
    resume_previous_owner = None
    finisher_binding = None
    if resume_parent is not None:
        _parent_fields = resume_parent.get("fields", {})
        resume_previous_owner = str(_parent_fields.get("owner") or "").strip() or None
        _saved_binding = str(_parent_fields.get("claim_session") or "").strip() or None
        finisher_binding = host_session_binding(root)
        if _saved_binding and finisher_binding and _saved_binding == finisher_binding:
            resume_claim_mode = "refresh"
        else:
            resume_claim_mode = "clear"

    # One LOG completion event naming the ACTUAL closure phase -- the event
    # is the provenance that the gate chain actually ended at SHIP.
    if prefix_run:
        # ONE truthful RUN event emitted immediately before the completion
        # event, both through the canonical LOG builder (T-994 / § 15). The
        # journal then carries a SINGLE LOG target whose after-bytes recovery
        # can verify -- a second sequential LOG target would defeat per-target
        # before/after classification.
        run_event, run_line = _producer_event(
            docs,
            log_tail,
            "RUN",
            prefix_run,
            ticket=ticket_id,
            agent=agent,
            now=now,
            op_id=op_id,
        )
        event, line = _producer_event(
            docs,
            run_event,
            "DEC",
            f"ticket finished via SAIOPS -- completion (from {prev_phase})",
            ticket=ticket_id,
            agent=agent,
            now=now,
            op_id=op_id,
        )
        new_log = docs["log"].text_norm.rstrip("\n") + "\n" + run_line + "\n" + line + "\n"
    else:
        event, line = _event_line(
            docs,
            log_tail,
            "DEC",
            ticket_id,
            agent,
            f"ticket finished via SAIOPS -- completion (from {prev_phase})",
            now,
            op_id,
        )
        new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"

    if resume_parent is not None:
        parent_id = resume_parent["id"]
        resume_detail = f"blocked parent resumed after dependency {ticket_id} reached DONE"
        if resume_claim_mode == "clear":
            resume_detail += (
                "; dependency completion is not a claim event -- no live claim "
                "restored"
            )
            if resume_previous_owner:
                resume_detail += (
                    f"; previous owner {resume_previous_owner} is historical "
                    "attribution only and the seat must be claimed explicitly"
                )
        event, resume_line = _producer_event(
            docs,
            event,
            "DEC",
            resume_detail,
            ticket=parent_id,
            agent=agent,
            now=now,
            op_id=op_id,
        )
        new_log = new_log.rstrip("\n") + "\n" + resume_line + "\n"

    # CORE-003: closure PROVENANCE. `inherited_verified` is the mode that
    # closes without a personal patch, so its named authority must resolve to
    # an ACTUAL durable publication -- one strict resolver, shared with the
    # validator, that never trusts a bare DONE and refuses cycles.
    _registry_text = None
    if _mode == "inherited_verified":
        from .closure import resolve_implementation_source

        _verdict = resolve_implementation_source(root, _impl_source)
        if not _verdict.ok:
            return _refuse("VALIDATION_FAILED", _verdict.detail, ticket=ticket_id)
    if _mode == "cohort":
        # Membership is DURABLE authority, not a BOARD adjective: the registry
        # write is a TARGET of this same journaled closure, so a ticket can
        # never claim a cohort the registry has never heard of.
        from . import closure as _closure

        try:
            _registry = _closure.read_registry(root)
        except (OSError, ValueError) as exc:
            return _refuse(
                "VALIDATION_FAILED", f"cohort registry is unreadable: {exc}", ticket=ticket_id
            )
        _existing = (_registry.get("cohorts") or {}).get(_cohort_id) or {}
        if _existing.get("publication_status") == "shipped":
            return _refuse(
                "VALIDATION_FAILED",
                f"cohort {_cohort_id} is already published; a new member cannot "
                f"join a shipped batch -- open a new cohort",
                ticket=ticket_id,
            )
        try:
            _path_hashes = _closure.hash_paths(root, _paths)
        except FileNotFoundError as exc:
            return _refuse(
                "SOURCE_SCOPE_MISSING",
                f"cohort path {exc.args[0]!r} is missing from the worktree; a "
                f"cohort binds the LIVE shared bytes",
                ticket=ticket_id,
            )
        _registry = _closure.upsert_member(
            _registry,
            _cohort_id,
            ticket_id,
            paths=_path_hashes,
            verification=str(ticket["fields"].get("verify", "")),
            closed_at=utc,
            agent=agent,
        )
        try:
            _closure.cohort_scope(_registry["cohorts"][_cohort_id])
        except ValueError as exc:
            return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
        _registry_text = _closure.render_registry(_registry)

    compaction_ids = [ticket_id]
    if resume_parent is not None:
        compaction_ids.append(resume_parent["id"])

    def _propose_closed(board: str) -> str:
        # BOARD: DOING -> DONE, [/] -> [x], preserve all other fields.
        closed = _move_ticket(board, ticket_id, "## DONE", "[x]", "done", "", enforce_cap=False)
        closed = _set_closure_fields(
            closed,
            ticket_id,
            mode=_mode,
            cohort=_cohort_id,
            implementation_source=_impl_source,
            paths=_paths,
            enforce_cap=False,
        )
        if resume_parent is not None:
            parent_tid = resume_parent["id"]
            closed = _move_ticket(
                closed, parent_tid, "## DOING", "[/]", "resume", "", enforce_cap=False
            )
            remove_fields = [
                "blocker",
                "blocker_scope",
                "blocked_on",
                "resume_phase",
                "resume_transition_from",
            ]
            if resume_claim_mode == "refresh":
                # The SAME mechanically-proven live session that the
                # reservation names is closing the child now -- its lease is
                # current, so the seat is retained and re-bound to it.
                claim_fields = {
                    "owner": agent,
                    "claim_time": utc,
                    "claim_session": finisher_binding,
                }
            else:
                # No proven live claim: the parent returns UNCLAIMED. A
                # half-pair (owner or claim_time alone) is INVALID, so all
                # three claim fields leave together; the previous owner is
                # preserved as historical attribution in the resume event.
                claim_fields = {}
                remove_fields += ["owner", "claim_time", "claim_session"]
            closed = _ticket_fields_in_place(
                closed,
                parent_tid,
                claim_fields,
                remove=tuple(remove_fields),
                enforce_cap=False,
            )
        return closed

    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            _propose_closed,
            compaction_ids,
            op_id=op_id,
            event_id=f"E-{event}",
            reason=(
                "existing/proposed oversized BOARD record requires canonical ticket "
                "completion update"
            ),
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    new_board = projected.board_text
    compaction_targets = list(projected.targets)

    # STATE: phase -> DONE, task -> none, transition_from -> the ACTUAL
    # previous phase (SHIP), and the next_action computed from the RESULTING
    # proposed state.
    if resume_parent is None:
        owned = {
            "phase": "DONE",
            "task": "none",
            "next_action": "saipen continue",
            "transition_from": closure_from,
            "last_event": event,
            "updated": utc,
            "agent": agent,
        }
    else:
        parent_id = resume_parent["id"]
        parent_fields = resume_parent.get("fields", {})
        resume_phase = str(parent_fields.get("resume_phase", ""))
        resume_from = str(parent_fields.get("resume_transition_from", ""))
        owned = {
            "phase": resume_phase,
            "task": parent_id,
            "next_action": f"PHASE {resume_phase} {parent_id}",
            "transition_from": resume_from,
            "last_event": event,
            "updated": utc,
            "agent": agent,
        }
    new_state = patch_state(docs["state"].text_norm, owned)
    from .router import route_next

    if resume_parent is None:
        routed = route_next(new_state, new_board, current_agent=agent)
        if routed.get("ok") and routed.get("action") != "saipen continue":
            new_state = patch_state(new_state, {"next_action": routed["action"]})

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed finish state fails fast validation: " + "; ".join(errors[:5]),
        )

    targets = [
        *_log_targets(docs, new_log),
        *compaction_targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    # The cohort registry commits in the SAME journaled transaction as the
    # BOARD line that names it: membership and its claim are one fact.
    if _registry_text is not None:
        registry_doc = codec.read_document(root / ".saipen" / "kitchen" / "cohort_registry.json")
        targets.append(
            TargetPlan(
                ".saipen/kitchen/cohort_registry.json",
                "report",
                registry_doc.encode(_registry_text),
                _live_before(root, ".saipen/kitchen/cohort_registry.json", registry_doc),
                hash_bytes(registry_doc.encode(_registry_text)),
            )
        )
    # T-994 / § 16: the release closure OWNS the human digest. ship.md's
    # digest is a PLAN TARGET of the same journaled closure so a ship can
    # never report RELEASED with a stale/missing digest. Ordinary `ticket
    # done` passes no digest and stays LOG+BOARD+STATE only.
    if digest_text is not None:
        digest_doc = codec.read_document(root / ".saipen" / "kitchen" / "digest.md")
        targets.append(
            TargetPlan(
                ".saipen/kitchen/digest.md",
                "report",
                digest_doc.encode(digest_text),
                _live_before(root, ".saipen/kitchen/digest.md", digest_doc),
                hash_bytes(digest_doc.encode(digest_text)),
            )
        )
    final_state = parse_state(new_state)
    expected = {
        "ok": True,
        "code": "FINISHED",
        "ticket": ticket_id,
        "event_id": f"E-{event}",
        "phase": final_state.get("phase"),
        "task": final_state.get("task"),
        "next_action": final_state.get("next_action"),
        "transition_from": final_state.get("transition_from"),
    }
    if resume_parent is not None:
        expected["resumed_parent"] = resume_parent["id"]
    if digest_text is not None:
        expected["digest"] = str(root / ".saipen" / "kitchen" / "digest.md")
    return build_plan(
        "finish",
        agent,
        _identity(root),
        {"operation": "finish", "ticket": ticket_id},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        expected,
        op_id=op_id,
    )


@_state_guard
def finish_ticket(
    project_root: Path | str,
    ticket_id: str,
    agent: str,
    dry_run: bool = False,
    digest_text: str | None = None,
    digest_done: str | None = None,
    digest_awaiting: str | None = None,
    prefix_run: str | None = None,
    closure_mode: str | None = None,
    closure_cohort: str | None = None,
    implementation_source: str | None = None,
    closure_paths=None,
) -> Result:
    """Atomically finish a ticket: LOG + BOARD + STATE in ONE journaled plan.
    The public `ticket done` semantics become this operation.

    The release closure passes `digest_text` so the human digest commits in
    the SAME journaled transaction as the ticket closure (T-994 / § 16), and
    `prefix_run` to emit its ONE truthful release RUN event through the same
    canonical LOG builder (§ 15). The `digest_done` / `digest_awaiting` hints
    are reserved for the no-publish digest shape.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_finish_ticket(
        root,
        ticket_id,
        agent,
        now,
        utc,
        digest_text=digest_text,
        digest_done=digest_done,
        digest_awaiting=digest_awaiting,
        prefix_run=prefix_run,
        closure_mode=closure_mode,
        closure_cohort=closure_cohort,
        implementation_source=implementation_source,
        closure_paths=closure_paths,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


_COHORT_ID_RE = re.compile(r"C-\d+")


def _set_closure_fields(
    board_text: str,
    ticket_id: str,
    *,
    mode: str,
    cohort: str,
    implementation_source: str,
    paths,
    enforce_cap: bool = True,
) -> str:
    """Write closure provenance onto the DONE line, surgically (CORE-003).

    Every mode records `closure_mode` -- including the default -- because a
    DONE line that says nothing about its provenance is exactly the ambiguity
    the FastPrompter incident turned into a stall: nobody could tell whether
    the ticket owed a patch. `implementation_delta: none` is written only when
    the closure genuinely added no code, so its presence is information rather
    than boilerplate.
    """
    parsed = parse_board(board_text)
    ticket = parsed["tickets"].get(ticket_id)
    if ticket is None:
        raise ValueError(f"cannot locate closed ticket {ticket_id}")
    raw = ticket["raw"].rstrip("\n")
    new = set_ticket_field(raw, "closure_mode", mode, enforce_cap=enforce_cap)
    if mode == "inherited_verified":
        new = set_ticket_field(new, "implementation_delta", "none", enforce_cap=enforce_cap)
        new = set_ticket_field(
            new,
            "implementation_source",
            escape_ticket_description(implementation_source),
            enforce_cap=enforce_cap,
        )
    if mode == "cohort":
        new = set_ticket_field(new, "closure_cohort", cohort, enforce_cap=enforce_cap)
        new = set_ticket_field(
            new,
            "closure_paths",
            escape_ticket_description(", ".join(paths)),
            enforce_cap=enforce_cap,
        )
    lines = board_text.splitlines(keepends=True)
    idx = ticket["line_no"] - 1
    suffix = "\n" if lines[idx].endswith("\n") else ""
    lines[idx] = new + suffix
    return "".join(lines)


def _move_ticket(
    board_text: str,
    ticket_id: str,
    target_section: str,
    checkbox: str,
    action: str,
    payload: str,
    blocker_scope: str | None = None,
    retry_not_before: str | None = None,
    *,
    enforce_cap: bool = True,
) -> str:
    lines = board_text.splitlines(keepends=True)
    out = []
    ticket_line = None
    heading_idx = {}
    for line in lines:
        stripped = line.rstrip("\n")
        if stripped.startswith("- [/] " + ticket_id + " ") or stripped.startswith(
            "- [ ] " + ticket_id + " "
        ):
            ticket_line = stripped
            continue
        for heading in ("## DOING", "## TODO", "## DONE", "## BLOCKED"):
            if stripped.startswith(heading):
                heading_idx[heading] = len(out)
        out.append(line)
    if ticket_line is None:
        raise ValueError(f"cannot locate ticket {ticket_id}")
    target_idx = heading_idx.get(target_section)
    if target_idx is None:
        raise ValueError(f"cannot locate section {target_section}")
    if action == "done":
        marked = ticket_line.replace("- [/] ", "- [x] ", 1)
    elif action == "supersede":
        # Terminal supersession closes schedulable TODO/BLOCKED Work in one
        # transition; ordinary completion still starts from claimed DOING.
        marked = re.sub(r"^- \[[/ ]\] ", "- [x] ", ticket_line, count=1)
    elif action == "resolve":
        # External implementation resolution closes BLOCKED Work; the ticket
        # was never claimed DOING, so the open checkbox is the normal shape.
        marked = re.sub(r"^- \[[/ ]\] ", "- [x] ", ticket_line, count=1)
    elif action == "block":
        marked = ticket_line.replace("- [/] ", "- [ ] ", 1)
        marked = set_ticket_field(
            marked,
            "blocker",
            escape_ticket_description(payload or "blocked"),
            enforce_cap=enforce_cap,
        )
        marked = set_ticket_field(
            marked,
            "blocker_scope",
            blocker_scope or DEFAULT_BLOCKER_SCOPE,
            enforce_cap=enforce_cap,
        )
        # T-1429: one canonical machine due instant, canonicalized by the
        # caller. Written only on a block; cleared by unblock below.
        if str(retry_not_before or "").strip():
            marked = set_ticket_field(
                marked,
                "retry_not_before",
                str(retry_not_before).strip(),
                enforce_cap=enforce_cap,
            )
    elif action == "unblock":
        marked = ticket_line.replace("- [/] ", "- [ ] ", 1)
        marked = remove_ticket_field(marked, "blocker")
        # The scope described THAT block; leaving it on an unblocked ticket
        # would be stale advisory data the parser then refuses outside BLOCKED.
        marked = remove_ticket_field(marked, "blocker_scope")
        marked = remove_ticket_field(marked, "verify_attempts")
        # T-1429: the due instant is ACTIVE blocked-state data too -- a resumed
        # ticket must never carry stale timing metadata.
        marked = remove_ticket_field(marked, "retry_not_before")
    elif action == "resume":
        marked = ticket_line.replace("- [ ] ", "- [/] ", 1)
    elif action == "demote":
        # T-1473: the handback holder leaves DOING as plain open Work; its
        # claim fields are removed by the caller, nothing else changes.
        marked = ticket_line.replace("- [/] ", "- [ ] ", 1)
    else:  # pragma: no cover
        marked = ticket_line.replace("- [/] ", "- [ ] ", 1)
    if enforce_cap:
        assert_live_record(marked.rstrip())
    out.insert(target_idx + 1, marked.rstrip() + "\n")
    return "".join(out)


# -------------------------------------------------------- Work supersession


def _plan_supersede_ticket(
    root: Path,
    old_ticket: str,
    successor_ticket: str,
    agent: str,
    evidence: str,
    authority: str,
    now: str,
    utc: str,
) -> OperationPlan | Result:
    """Plan one terminal local Work-supersession transaction."""
    from . import supersession as _sup

    old_ticket = str(old_ticket or "").strip().upper()
    successor_ticket = str(successor_ticket or "").strip().upper()
    evidence = str(evidence or "").strip().upper()
    authority = str(authority or "").strip().upper()
    if not re.fullmatch(r"T-\d+", old_ticket):
        return _refuse("INVALID_ID", f"old ticket {old_ticket!r}")
    if not re.fullmatch(r"T-\d+", successor_ticket):
        return _refuse("INVALID_ID", f"successor ticket {successor_ticket!r}")
    if old_ticket == successor_ticket:
        return _refuse(
            "SUPERSESSION_SELF_CYCLE",
            f"{old_ticket} cannot be superseded by itself",
            ticket=old_ticket,
        )
    if not evidence:
        return _refuse(
            "SUPERSESSION_EVIDENCE_REQUIRED",
            "Work supersession requires --evidence E-### targeted at the OLD Work",
            ticket=old_ticket,
        )
    if not authority:
        return _refuse(
            "SUPERSESSION_AUTHORITY_REQUIRED",
            "Work supersession requires --authority SRC-### -- " + _sup.grammar_hint(),
            ticket=old_ticket,
        )

    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=old_ticket,
        )
    tickets = board["tickets"]
    old = tickets.get(old_ticket)
    if old is None:
        return _refuse("TICKET_NOT_FOUND", f"{old_ticket} not on the board", ticket=old_ticket)

    fields = old.get("fields") or {}
    if old.get("section") == "## DONE":
        if (
            str(fields.get("closure_mode") or "") == "superseded_verified"
            and str(fields.get("superseded_by") or "") == successor_ticket
            and str(fields.get("supersession_evidence") or "") == evidence
            and str(fields.get("supersession_authority") or "") == authority
        ):
            return Result(
                ok=True,
                code="ALREADY_APPLIED",
                message=f"{old_ticket} is already superseded by {successor_ticket}",
                data={
                    "ticket": old_ticket,
                    "successor": successor_ticket,
                    "evidence": evidence,
                    "authority": authority,
                },
            )
        return _refuse(
            "TICKET_ALREADY_DONE",
            f"{old_ticket} is already terminal with a different closure",
            ticket=old_ticket,
        )
    if old.get("section") not in ("## TODO", "## BLOCKED"):
        return _refuse(
            "SUPERSESSION_OLD_NOT_SETTLEABLE",
            f"{old_ticket} sits under {old.get('section')}; only schedulable TODO or "
            "BLOCKED Work may be superseded",
            ticket=old_ticket,
        )
    if old.get("section") == "## TODO" and not ticket_is_workable(old, tickets, agent):
        return _refuse(
            "SUPERSESSION_OLD_NOT_SETTLEABLE",
            f"{old_ticket} is TODO but not schedulable",
            ticket=old_ticket,
        )

    successor = tickets.get(successor_ticket)
    if successor is None:
        return _refuse(
            "SUPERSESSION_SUCCESSOR_NOT_FOUND",
            f"successor {successor_ticket} not on the board",
            ticket=old_ticket,
        )
    if successor.get("section") != "## DONE":
        return _refuse(
            "SUPERSESSION_SUCCESSOR_NOT_DONE",
            f"successor {successor_ticket} sits under {successor.get('section')}; "
            "only DONE Work may settle another Work",
            ticket=old_ticket,
        )
    cycle = _sup.cycle_error(tickets, old_ticket, successor_ticket)
    if cycle:
        return _refuse("SUPERSESSION_CYCLE", cycle, ticket=old_ticket)

    if str(fields.get("source_receipts") or "").strip():
        return _refuse(
            "SUPERSESSION_SOURCE_MIGRATION_REQUIRED",
            f"{old_ticket} carries Source receipts; this first supersession route "
            "cannot prove their transfer or settlement",
            ticket=old_ticket,
        )

    authority_problem, authority_binding = _sup.authority_error(
        root,
        authority,
        old_ticket=old_ticket,
        successor_ticket=successor_ticket,
    )
    if authority_problem:
        return _refuse(
            "SUPERSESSION_AUTHORITY_REQUIRED", authority_problem, ticket=old_ticket
        )
    evidence_problem, evidence_binding = _sup.evidence_error(
        docs["_history"].events,
        evidence,
        old_ticket=old_ticket,
        successor_ticket=successor_ticket,
    )
    if evidence_problem:
        return _refuse(
            "SUPERSESSION_EVIDENCE_INVALID", evidence_problem, ticket=old_ticket
        )

    try:
        seat = _seat_agent(state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"Work supersession refuses a corrupt ownership snapshot: {exc}",
            ticket=old_ticket,
        )

    op_id = "supersede-" + uuid4_hex()
    message = _actor_provenance(
        state,
        agent,
        f"SUPERSEDE {old_ticket} -> {successor_ticket} -- evidence {evidence}; "
        f"authority {authority}; grant {authority_binding['authority_grant']}; "
        f"successor completion {evidence_binding['successor_completion']}; "
        "local lifecycle terminal, publication not asserted",
    )
    event, line = _producer_event(
        docs,
        log_tail,
        "DEC",
        message,
        ticket=old_ticket,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"

    def _propose_superseded(board_text: str) -> str:
        closed = _move_ticket(
            board_text,
            old_ticket,
            "## DONE",
            "[x]",
            "supersede",
            "",
            enforce_cap=False,
        )
        return _ticket_fields_in_place(
            closed,
            old_ticket,
            {
                "closure_mode": "superseded_verified",
                "implementation_delta": "none",
                "superseded_by": successor_ticket,
                "supersession_evidence": evidence,
                "supersession_authority": authority,
            },
            remove=("blocker", "blocker_scope", "verify_attempts"),
            enforce_cap=False,
        )

    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            _propose_superseded,
            [old_ticket],
            op_id=op_id,
            event_id=f"E-{event}",
            reason="terminal Work supersession metadata requires canonical projection",
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=old_ticket)
    new_board = projected.board_text
    new_state = patch_state(
        docs["state"].text_norm,
        {"last_event": event, "updated": utc, "agent": seat},
    )
    new_state = _settle_stop_reason(new_state, new_board, agent)
    if str(parse_state(new_state).get("task") or "none") == "none":
        from .router import route_next

        routed = route_next(new_state, new_board, current_agent=agent)
        if routed.get("ok"):
            new_state = patch_state(new_state, {"next_action": routed["action"]})

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed Work supersession fails fast validation: " + "; ".join(errors[:5]),
            ticket=old_ticket,
        )

    targets = [
        *_log_targets(docs, new_log),
        *projected.targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "ticket_supersede",
        agent,
        _identity(root),
        {
            "operation": "ticket_supersede",
            "ticket": old_ticket,
            "successor": successor_ticket,
            "evidence": evidence,
            "authority": authority,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "SUPERSEDED",
            "ticket": old_ticket,
            "successor": successor_ticket,
            "evidence": evidence,
            "authority": authority,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
    )


@_state_guard
def supersede_ticket(
    project_root: Path | str,
    old_ticket: str,
    successor_ticket: str,
    agent: str,
    *,
    evidence: str,
    authority: str,
    dry_run: bool = False,
) -> Result:
    """Terminally settle OLD through verified DONE successor NEW."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_supersede_ticket(
        root,
        old_ticket,
        successor_ticket,
        agent,
        evidence,
        authority,
        now,
        utc,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


# ------------------------------------- external implementation resolution


def _plan_resolve_external_ticket(
    root: Path,
    work: str,
    agent: str,
    *,
    authority: str,
    implementation: str,
    resolution_reason: str,
    runs,
    verification,
    contract: str | None,
    timeout: int,
    now: str,
    utc: str,
) -> OperationPlan | Result:
    """Plan ONE external-implementation resolution transaction (SRC-088 M2).

    A local ticket represents a defect that was implemented in an EXTERNAL
    authority and is observable in the installed implementation. The local
    verification contract is EXECUTED here against the current tree; a PASS
    writes the append-only EX receipt and terminalizes the BLOCKED Work, a
    FAIL records its own receipt and changes no lifecycle byte. The immutable
    receipt binds the installed engine GENERATION, so a later dependency
    rollback makes the closure non-green instead of silently green.
    """
    from . import external as _external
    from .debt import _run_verification_command, _verification_contract_digest

    work = str(work or "").strip().upper()
    authority = str(authority or "").strip()
    implementation = str(implementation or "").strip()
    resolution_reason = str(resolution_reason or "").strip()
    runs = [str(item) for item in (runs or []) if str(item).strip()]
    verification = list(verification or [])

    if not re.fullmatch(r"T-\d+", work):
        return _refuse("INVALID_ID", f"ticket {work!r}")
    problem = _external.authority_error(authority)
    if problem:
        return _refuse("EXTERNAL_AUTHORITY_REQUIRED", problem, ticket=work)
    problem = _external.implementation_error(implementation)
    if problem:
        return _refuse("EXTERNAL_IMPLEMENTATION_REQUIRED", problem, ticket=work)
    problem = _external.reason_error(resolution_reason)
    if problem:
        return _refuse("EXTERNAL_REASON_INVALID", problem, ticket=work)
    for entry in verification:
        if entry.get("result") != "PASS":
            return _refuse(
                "EXTERNAL_VERIFICATION_REFUSED",
                f"attested verification is not PASS: {entry.get('command')}",
                ticket=work,
            )
    if not runs and not verification:
        return _refuse(
            "EXTERNAL_VERIFICATION_REQUIRED",
            "external resolution requires at least one --run <command> so the "
            "local verification is executed evidence, not an assertion",
            ticket=work,
        )

    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=work,
        )
    tickets = board["tickets"]
    ticket = tickets.get(work)
    if ticket is None:
        return _refuse("TICKET_NOT_FOUND", f"{work} not on the board", ticket=work)
    fields = ticket.get("fields") or {}
    already_done = False
    if ticket.get("section") == "## DONE":
        same = (
            str(fields.get("closure_mode") or "") == _external.CLOSURE_MODE
            and str(fields.get("external_authority") or "") == authority
            and str(fields.get("external_implementation") or "") == implementation
            and str(fields.get("resolution_reason") or "") == resolution_reason
        )
        if not same:
            return _refuse(
                "TICKET_ALREADY_DONE",
                f"{work} is already terminal with a different closure; external "
                "resolution never rewrites another closure mode",
                ticket=work,
            )
        if not _external.resolution_problems(root, work, ticket):
            return Result(
                ok=True,
                code="ALREADY_APPLIED",
                message=f"{work} is already resolved externally with a current receipt",
                data={
                    "ticket": work,
                    "receipt_id": str(fields.get("external_evidence") or ""),
                    "authority": authority,
                    "implementation": implementation,
                },
            )
        # Same tuple, but the installed generation moved: this is the
        # RE-RESOLUTION path. A new append-only receipt replaces the pointer;
        # the DONE row and all history stay intact.
        already_done = True
    elif ticket.get("section") != "## BLOCKED":
        return _refuse(
            "EXTERNAL_RESOLUTION_REQUIRES_BLOCKED",
            f"{work} sits under {ticket.get('section')}; only externally blocked "
            "Work is resolved through an external implementation",
            ticket=work,
        )

    verify_text = str(fields.get("verify") or "")
    digest = _external.contract_digest(work, verify_text)
    if contract and str(contract).strip() != digest:
        return _refuse(
            "EXTERNAL_CONTRACT_MISMATCH",
            f"--contract {contract} does not match {work}'s own defect contract "
            f"{digest}; a resolution may not answer a different defect",
            ticket=work,
        )

    from .intake import work_closure_gate

    gate = work_closure_gate(root, work)
    if not gate.get("ok"):
        return _refuse(
            gate.get("code") or "SOURCE_UNRESOLVED",
            "external resolution refuses while the Work's Source coverage is "
            f"unresolved: {gate.get('detail')}",
            ticket=work,
        )

    try:
        seat = _seat_agent(state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"external resolution refuses a corrupt ownership snapshot: {exc}",
            ticket=work,
        )

    executed = [_run_verification_command(root, command, timeout) for command in runs]
    entries = verification + executed
    verdict = "PASS" if all(entry.get("result") == "PASS" for entry in entries) else "FAIL"
    contract_identity = _verification_contract_digest(entries, "external")
    prior_blocker = str(fields.get("blocker") or "")
    op_id = "resolve-external-" + uuid4_hex()
    receipt_id = _external.next_receipt_id(root)
    from .journal import LineageRefusal, ensure_project_lineage

    try:
        # The receipt must bind the DURABLE lineage, and a journaled commit
        # mints the carrier on first mutation anyway; ensure it here so the
        # receipt bytes and the live carrier can never be two different
        # values (the T-1434 M2 fixture caught exactly that race).
        lineage = ensure_project_lineage(root)
    except LineageRefusal as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"external resolution requires a durable project lineage: {exc}",
            ticket=work,
        )

    record = _external.build_receipt(
        root=root,
        receipt_id=receipt_id,
        work=work,
        project_identity=_identity(root),
        project_lineage=lineage,
        agent=agent,
        created_at=utc,
        authority=authority,
        implementation=implementation,
        resolution_reason=resolution_reason,
        defect_contract_digest=digest,
        defect_contract_text=verify_text,
        prior_blocker_sha256=(
            hash_bytes(prior_blocker.encode("utf-8")) if prior_blocker else ""
        ),
        verification=entries,
        verification_contract_digest=contract_identity,
        verdict=verdict,
        op_id=op_id,
    )
    content = json.dumps(record, indent=2, sort_keys=True).encode("utf-8")
    rel = f"{_external.EXTERNAL_DIR}/{receipt_id}.json"
    receipt_target = TargetPlan(
        path=rel,
        role="report",
        content=content,
        before_hash="",
        after_hash=hash_bytes(content),
    )
    if verdict != "PASS":
        # Honest FAIL evidence, zero lifecycle mutation: the BLOCKED Work stays
        # BLOCKED and the receipt says exactly why the claimed fix was not
        # verified locally.
        return build_plan(
            "external_resolve",
            agent,
            _identity(root),
            {
                "operation": "ticket_resolve_external",
                "ticket": work,
                "receipt": receipt_id,
                "verdict": verdict,
            },
            {**_docs_preconditions(docs, "state", "board", "log"), rel: ""},
            [receipt_target],
            {
                "ok": False,
                "code": "EXTERNAL_VERIFICATION_FAILED",
                "ticket": work,
                "receipt_id": receipt_id,
                "verdict": verdict,
            },
            op_id=op_id,
        )

    message = _actor_provenance(
        state,
        agent,
        f"RESOLVE-EXTERNAL {work} -- authority {authority}; implementation "
        f"{implementation}; reason {resolution_reason}; local verification PASS "
        f"({len(entries)} check(s)); receipt {receipt_id}; prior blocker sha256 "
        f"{(record['prior_blocker_sha256'] or 'none')[:20]}"
        + ("; RE-RESOLVED after installed generation move" if already_done else ""),
    )
    event, line = _producer_event(
        docs,
        log_tail,
        "DEC",
        message,
        ticket=work,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"

    def _propose_resolved(board_text: str) -> str:
        if already_done:
            mutated = board_text
        else:
            mutated = _move_ticket(
                board_text,
                work,
                "## DONE",
                "[x]",
                "resolve",
                "",
                enforce_cap=False,
            )
        return _ticket_fields_in_place(
            mutated,
            work,
            {
                "closure_mode": _external.CLOSURE_MODE,
                "implementation_delta": "none",
                "external_authority": authority,
                "external_implementation": implementation,
                "external_evidence": receipt_id,
                "resolution_reason": resolution_reason,
            },
            remove=("blocker", "blocker_scope", "verify_attempts"),
            enforce_cap=False,
        )

    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            _propose_resolved,
            [work],
            op_id=op_id,
            event_id=f"E-{event}",
            reason="external implementation resolution requires canonical projection",
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=work)
    new_board = projected.board_text
    new_state = patch_state(
        docs["state"].text_norm,
        {"last_event": event, "updated": utc, "agent": seat},
    )
    new_state = _settle_stop_reason(new_state, new_board, agent)
    if str(parse_state(new_state).get("task") or "none") == "none":
        from .router import route_next

        routed = route_next(new_state, new_board, current_agent=agent)
        if routed.get("ok"):
            new_state = patch_state(new_state, {"next_action": routed["action"]})

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed external resolution fails fast validation: "
            + "; ".join(errors[:5]),
            ticket=work,
        )

    targets = [
        *_log_targets(docs, new_log),
        *projected.targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
        receipt_target,
    ]
    return build_plan(
        "external_resolve",
        agent,
        _identity(root),
        {
            "operation": "ticket_resolve_external",
            "ticket": work,
            "receipt": receipt_id,
            "authority": authority,
            "implementation": implementation,
            "verdict": verdict,
        },
        {**_docs_preconditions(docs, "state", "board", "log"), rel: ""},
        targets,
        {
            "ok": True,
            "code": "EXTERNAL_RESOLVED",
            "ticket": work,
            "receipt_id": receipt_id,
            "verdict": verdict,
            "authority": authority,
            "implementation": implementation,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
    )


@_state_guard
def resolve_external_ticket(
    project_root: Path | str,
    work: str,
    agent: str,
    *,
    authority: str,
    implementation: str,
    resolution_reason: str,
    runs=None,
    verification=None,
    contract: str | None = None,
    timeout: int = 300,
    dry_run: bool = False,
) -> Result:
    """Resolve locally reported Work through an externally implemented fix."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_resolve_external_ticket(
        root,
        work,
        agent,
        authority=authority,
        implementation=implementation,
        resolution_reason=resolution_reason,
        runs=runs,
        verification=verification,
        contract=contract,
        timeout=timeout,
        now=now,
        utc=utc,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    applied = apply_plan(root, plan)
    if not isinstance(applied, Result):
        return applied
    expected = plan.expected if isinstance(plan.expected, dict) else {}
    if expected.get("code") == "EXTERNAL_VERIFICATION_FAILED":
        return Result(
            ok=False,
            code="EXTERNAL_VERIFICATION_FAILED",
            message=(
                f"local verification of the claimed external implementation did "
                f"not pass; FAIL receipt recorded, {work} stays BLOCKED"
            ),
            data={
                "ticket": work,
                "receipt_id": expected.get("receipt_id"),
                "verdict": "FAIL",
                "applied": applied.code,
            },
        )
    return applied


# ------------------------------------- legacy metadata migration (T-1435)


def _plan_repair_metadata(
    root: Path,
    work: str,
    agent: str,
    *,
    field: str,
    to_target: str,
    legacy_unbound: bool,
    authority: str,
    now: str,
    utc: str,
) -> OperationPlan | Result:
    """Plan ONE legacy BOARD metadata migration on a historical DONE row.

    The validator correctly refuses a malformed machine-interpreted field, and
    before this operation no legal canonical move owned the repair: the Work is
    historical DONE, manual BOARD editing is forbidden, and history is
    immutable. Two closed classifications:

      EXACT_CANONICAL_MIGRATION -- the malformed token's exact `SRC-###` exists
      in this project AND that receipt's durable metadata links it to THIS Work.
      The field is replaced with the proven identity; nothing is invented.

      LEGACY_UNBOUND_REFERENCE -- no exact receipt proves the token. The
      malformed prose leaves the machine-interpreted field; the exact original
      bytes survive in the immutable MR receipt; authority is required because
      dropping an unprovable historical reference is a protocol act.

    Refuses non-DONE rows, unproven or foreign targets, a second conflicting
    migration and an ambiguous request -- always zero writes, always through
    the same journaled commit as the LOG/STATE/BOARD bytes.
    """
    from . import metadata_repair as _mr

    work = str(work or "").strip().upper()
    field = str(field or "").strip()
    to_target = str(to_target or "").strip().upper()
    authority = str(authority or "").strip()

    if not re.fullmatch(r"T-\d+", work):
        return _refuse("INVALID_ID", f"ticket {work!r}")
    if field not in _mr.SUPPORTED_FIELDS:
        return _refuse(
            "METADATA_REPAIR_FIELD_UNSUPPORTED",
            f"field {field!r} is outside {'|'.join(_mr.SUPPORTED_FIELDS)}",
            ticket=work,
        )
    if bool(to_target) == bool(legacy_unbound):
        return _refuse(
            "VALIDATION_FAILED",
            "metadata repair needs exactly one of --to <SRC-###> or "
            "--legacy-unbound",
            ticket=work,
        )
    problem = _mr.authority_problem(root, authority, required=legacy_unbound)
    if problem:
        return _refuse(
            "METADATA_REPAIR_AUTHORITY_REQUIRED"
            if not authority
            else "METADATA_REPAIR_AUTHORITY_INVALID",
            problem,
            ticket=work,
        )

    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=work,
        )
    ticket = board["tickets"].get(work)
    if ticket is None:
        return _refuse("TICKET_NOT_FOUND", f"{work} not on the board", ticket=work)
    if ticket.get("section") != "## DONE":
        return _refuse(
            "METADATA_REPAIR_REQUIRES_DONE",
            f"{work} sits under {ticket.get('section')}; legacy metadata is only "
            "migrated on historical DONE rows -- active Work is repaired by "
            "editing its own canonical fields through their normal writers",
            ticket=work,
        )

    fields = ticket.get("fields") or {}
    original_value = str(fields.get(field) or "")
    tokens = _mr.receipt_tokens(original_value)
    desired: str | None = to_target or None

    prior = _mr.latest_receipt_for(root, work, field)
    if prior is not None:
        prior_value = prior.get("repaired_value")
        prior_desired = str(prior_value) if prior_value is not None else None
        if prior_desired != desired:
            return _refuse(
                "METADATA_REPAIR_CONFLICT",
                f"{work} field {field} was already migrated by "
                f"{prior.get('repair_id')} to {prior_value!r}; a different "
                "second migration is never a silent rewrite",
                ticket=work,
                prior_receipt=prior.get("repair_id"),
            )

    current_is_target = tokens == [to_target] if to_target else not tokens
    if current_is_target:
        if prior is None:
            return _refuse(
                "METADATA_REPAIR_NOT_NEEDED",
                f"{work} field {field} already carries the requested canonical "
                "state",
                ticket=work,
            )
        return Result(
            ok=True,
            code="ALREADY_APPLIED",
            message=f"{work} was already migrated by {prior.get('repair_id')}",
            data={
                "ticket": work,
                "field": field,
                "receipt_id": prior.get("repair_id"),
                "classification": prior.get("classification"),
            },
        )

    if to_target:
        target_problem = _mr.target_problem(root, work, to_target)
        if target_problem is not None:
            return _refuse(target_problem[0], target_problem[1], ticket=work)
        if tokens and all(
            _mr.is_canonical_token(token) and _mr.receipt_exists(root, token)
            for token in tokens
        ):
            return _refuse(
                "METADATA_REPAIR_CONFLICT",
                f"{work} field {field} already names live canonical receipts "
                f"({','.join(tokens)}); an exact migration never rewrites live "
                "authority",
                ticket=work,
            )
        classification = "EXACT_CANONICAL_MIGRATION"
        repaired_value: str | None = to_target
        evidence = [
            f"target-receipt:{to_target}",
            f"linkage-work:{work}",
            f"receipt-membership:{','.join(sorted(_mr.work_membership(root, to_target)))}",
        ]
    else:
        live = [token for token in tokens if _mr.receipt_exists(root, token)]
        if live:
            return _refuse(
                "METADATA_REPAIR_CONFLICT",
                f"{work} field {field} names live canonical receipts "
                f"({','.join(live)}); removing them would drop real authority -- "
                "migrate to the proven receipt with --to instead",
                ticket=work,
            )
        if not tokens:
            return _refuse(
                "METADATA_REPAIR_NOT_NEEDED",
                f"{work} field {field} carries no value to remove",
                ticket=work,
            )
        classification = "LEGACY_UNBOUND_REFERENCE"
        repaired_value = None
        evidence = [
            f"original-token-sha256:{hash_bytes(original_value.encode('utf-8'))}",
            "classification:no-exact-canonical-src-provable",
        ]

    receipt_id = _mr.next_receipt_id(root)
    op_id = "metadata-repair-" + uuid4_hex()
    from .journal import LineageRefusal, ensure_project_lineage

    try:
        lineage = ensure_project_lineage(root)
    except LineageRefusal as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"metadata repair requires a durable project lineage: {exc}",
            ticket=work,
        )
    try:
        seat = _seat_agent(state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"metadata repair refuses a corrupt ownership snapshot: {exc}",
            ticket=work,
        )

    message = _actor_provenance(
        state,
        agent,
        f"REPAIR-METADATA {work} -- field {field}; classification "
        f"{classification}; receipt {receipt_id}; original field value "
        f"{original_value!r} preserved by hash; "
        + (f"replaced with {repaired_value}" if repaired_value else "malformed value removed"),
    )
    event, line = _producer_event(
        docs,
        log_tail,
        "DEC",
        message,
        ticket=work,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    from .external import engine_identity as _engine_identity

    record = _mr.build_receipt(
        repair_id=receipt_id,
        work=work,
        field=field,
        classification=classification,
        original_board_record=str(ticket.get("raw") or ""),
        original_value=original_value,
        repaired_value=repaired_value,
        evidence=evidence,
        authority=authority,
        authority_kind_value=_mr.authority_kind(authority) or "NONE",
        engine_generation=_engine_identity(),
        project_identity=_identity(root),
        project_lineage=lineage,
        agent=seat,
        event_id=f"E-{event}",
        created_at=utc,
        op_id=op_id,
    )
    content = json.dumps(record, indent=2, sort_keys=True).encode("utf-8")
    rel = f"{_mr.METADATA_REPAIR_DIR}/{receipt_id}.json"
    receipt_target = TargetPlan(
        path=rel,
        role="report",
        content=content,
        before_hash="",
        after_hash=hash_bytes(content),
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"

    def _propose_repaired(board_text: str) -> str:
        if repaired_value is None:
            return _ticket_fields_in_place(
                board_text, work, {}, remove=(field,), enforce_cap=False
            )
        return _ticket_fields_in_place(
            board_text, work, {field: repaired_value}, enforce_cap=False
        )

    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            _propose_repaired,
            [work],
            op_id=op_id,
            event_id=f"E-{event}",
            reason="legacy metadata migration requires canonical projection",
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=work)
    new_board = projected.board_text
    new_state = patch_state(
        docs["state"].text_norm,
        {"last_event": event, "updated": utc, "agent": seat},
    )
    new_state = _settle_stop_reason(new_state, new_board, agent)
    if str(parse_state(new_state).get("task") or "none") == "none":
        from .router import route_next

        routed = route_next(new_state, new_board, current_agent=agent)
        if routed.get("ok"):
            new_state = patch_state(new_state, {"next_action": routed["action"]})

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed metadata repair fails fast validation: " + "; ".join(errors[:5]),
            ticket=work,
        )

    targets = [
        *_log_targets(docs, new_log),
        *projected.targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
        receipt_target,
    ]
    return build_plan(
        "metadata_repair",
        agent,
        _identity(root),
        {
            "operation": "ticket_repair_metadata",
            "ticket": work,
            "field": field,
            "classification": classification,
            "receipt": receipt_id,
        },
        {**_docs_preconditions(docs, "state", "board", "log"), rel: ""},
        targets,
        {
            "ok": True,
            "code": "METADATA_REPAIRED",
            "ticket": work,
            "field": field,
            "classification": classification,
            "receipt_id": receipt_id,
            "original_value": original_value,
            "repaired_value": repaired_value,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
    )


@_state_guard
def repair_metadata(
    project_root: Path | str,
    work: str,
    agent: str,
    *,
    field: str,
    to_target: str | None = None,
    legacy_unbound: bool = False,
    authority: str = "",
    dry_run: bool = False,
) -> Result:
    """Migrate malformed legacy metadata on historical DONE Work (T-1435)."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_repair_metadata(
        root,
        work,
        agent,
        field=field,
        to_target=str(to_target or ""),
        legacy_unbound=bool(legacy_unbound),
        authority=authority,
        now=now,
        utc=utc,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _plan_retire_source(
    root: Path,
    receipt_id: str,
    agent: str,
    *,
    reason: str,
    successor: str | None,
    note: str | None,
    now: str,
    utc: str,
) -> OperationPlan | Result:
    """Plan ONE receipt-only source retirement (T-1434 M3 / SRC-088).

    A stale, non-actionable Source is tombstoned out of CURRENT gating while
    every byte it ever held is preserved: cold copy first, hot surface out, the
    original tombstone shape recorded in the same journaled transaction as the
    LOG and STATE. No unresolved actionable requirement may be discarded -- the
    eligibility gate refuses first.
    """
    from . import intake
    from . import retirement as _ret

    receipt_id = str(receipt_id or "").strip().upper()
    reason = str(reason or "").strip().upper()
    successor = str(successor or "").strip().upper() or None
    note = str(note or "").strip() or None
    if not intake._valid_receipt_id(receipt_id):
        return _refuse("INVALID_ID", f"source {receipt_id!r}", receipt=receipt_id)
    if not _ret.valid_source_retirement_reason(reason):
        return _refuse(
            "RETIREMENT_REASON_UNKNOWN",
            f"reason {reason!r} is outside {'|'.join(_ret.SOURCE_RETIREMENT_REASONS)}",
            receipt=receipt_id,
        )

    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            receipt=receipt_id,
        )
    index = intake._read_index(root)
    existing = (index.get("tombstones") or {}).get(receipt_id)
    if existing is not None:
        if _ret.is_retired_tombstone(existing):
            retirement = existing.get("retirement") or {}
            if (
                retirement.get("reason") == reason
                and str(retirement.get("successor") or "") == str(successor or "")
            ):
                return Result(
                    ok=True,
                    code="ALREADY_RETIRED",
                    message=f"{receipt_id} is already retired for {reason}",
                    data={"receipt": receipt_id, "reason": reason},
                )
        return _refuse(
            "ALREADY_RETIRED",
            f"{receipt_id} already carries a tombstone; retirement never rewrites it",
            receipt=receipt_id,
        )

    problems = _ret.source_retirement_errors(
        root, receipt_id, reason=reason, successor=successor, note=note
    )
    if problems:
        first = problems[0]
        route = None
        marker = "requirement(s): "
        if marker in first:
            rid = first.split(marker, 1)[1].split(",", 1)[0].strip()
            # T-1383: a route is typed, not read -- `[...]` is shell glob syntax
            # the guard refuses, and a terminal disposition needs its evidence.
            route = (
                f"saipen source disp {receipt_id} {rid} <DISPOSITION> "
                "--evidence <E-###>"
            )
        return _refuse(
            "SOURCE_RETIREMENT_NOT_ELIGIBLE",
            f"{receipt_id} is not retirable for {reason}: " + "; ".join(problems[:3]),
            receipt=receipt_id,
            canonical_next_command=route,
        )

    try:
        seat = _seat_agent(state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"source retirement refuses a corrupt ownership snapshot: {exc}",
            receipt=receipt_id,
        )

    op_id = "retire-source-" + uuid4_hex()
    event, line = _producer_event(
        docs,
        log_tail,
        "DEC",
        _actor_provenance(
            state,
            agent,
            f"RETIRE-SOURCE {receipt_id} -- reason {reason}; original bytes preserved "
            f"to {_ret.retired_source_ref(receipt_id)}; successor "
            f"{successor or 'none'}; the receipt leaves CURRENT gating and its "
            "history stays readable",
        ),
        ticket=None,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    shared = {
        "retired_at": utc,
        "retired_by": agent,
        "retirement_event": f"E-{event}",
        "source_reason": reason,
    }
    try:
        source_targets, tombstone = _ret.source_only_retirement_targets(
            root,
            receipt_id,
            reason=reason,
            successor=successor,
            note=note,
            shared=shared,
        )
        source_targets.append(_ret.index_target(root, {receipt_id: tombstone}))
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), receipt=receipt_id)

    new_state = patch_state(
        docs["state"].text_norm,
        {"last_event": event, "updated": utc, "agent": seat},
    )
    new_state = _settle_stop_reason(new_state, docs["board"].text_norm, agent)
    if str(parse_state(new_state).get("task") or "none") == "none":
        from .router import route_next

        routed = route_next(new_state, docs["board"].text_norm, current_agent=agent)
        if routed.get("ok"):
            new_state = patch_state(new_state, {"next_action": routed["action"]})

    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed source retirement fails fast validation: " + "; ".join(errors[:5]),
            receipt=receipt_id,
        )

    targets = [
        *_log_targets(docs, new_log),
        *source_targets,
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "source_retire",
        agent,
        _identity(root),
        {
            "operation": "source_retire",
            "receipt": receipt_id,
            "reason": reason,
            "successor": successor or "",
        },
        _docs_preconditions(docs, "state", "log"),
        targets,
        {
            "ok": True,
            "code": "RETIRED",
            "receipt": receipt_id,
            "reason": reason,
            "successor": successor or "",
            "event_id": f"E-{event}",
            "archive_ref": _ret.retired_source_ref(receipt_id),
        },
        op_id=op_id,
    )


@_state_guard
def retire_source(
    project_root: Path | str,
    receipt_id: str,
    agent: str,
    *,
    reason: str,
    successor: str | None = None,
    note: str | None = None,
    dry_run: bool = False,
) -> Result:
    """Retire ONE stale, non-actionable Source receipt without deleting history."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_retire_source(
        root,
        receipt_id,
        agent,
        reason=reason,
        successor=successor,
        note=note,
        now=now,
        utc=utc,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


# ----------------------------------------------------------- retirement


def _remove_ticket(board_text: str, ticket_id: str) -> tuple[str, str, str]:
    """Delete one ticket's physical BOARD record.

    Returns (new_board, exact_record, section_heading). BOARD is a scheduling
    projection, not history -- CLEAN already prunes rows once durable evidence
    exists (CORE.md, BOARD.md contract). This helper is the mechanical
    implementation of that rule for retirement, and it HANDS BACK the exact
    bytes it removed so the caller can journal them into the forensic record
    in the same transaction. A prune whose bytes were not preserved first is
    an erasure, and erasure is the one thing retirement must never become.
    """
    lines = board_text.splitlines(keepends=True)
    out: list[str] = []
    record: str | None = None
    section = ""
    seen_section = ""
    openers = (
        "- [/] " + ticket_id + " ",
        "- [ ] " + ticket_id + " ",
        "- [x] " + ticket_id + " ",
    )
    for line in lines:
        stripped = line.rstrip("\n")
        for heading in ("## DOING", "## TODO", "## DONE", "## BLOCKED"):
            if stripped.startswith(heading):
                seen_section = heading
        if stripped.startswith(openers):
            record = stripped
            section = seen_section
            continue
        out.append(line)
    if record is None:
        raise ValueError(f"cannot locate ticket {ticket_id}")
    return "".join(out), record, section


def _retire_targets(
    root: Path,
    ticket_id: str,
    agent: str,
    reason: str,
    evidence: str,
    authority: str,
    now: str,
    utc: str,
    discovery_event: str | None = None,
    note: str | None = None,
) -> OperationPlan | Result:
    """PLAN one canonical retirement. Writes zero bytes.

    Every gate below is a fail-closed refusal evaluated BEFORE any target is
    built, in the order a hostile reader attacks them: grammar, then proof of
    operator authority, then proof of evidence, then proof of identity, then
    lifecycle and seat.
    """
    from . import intake as _intake
    from . import retirement as _ret

    if not re.fullmatch(r"T-\d+", ticket_id):
        return _refuse("INVALID_ID", f"ticket {ticket_id!r}")
    if reason not in _ret.RETIREMENT_REASONS:
        return _refuse(
            "RETIREMENT_REASON_UNKNOWN",
            f"reason {reason!r} is outside the registered set "
            f"{'|'.join(_ret.RETIREMENT_REASONS)}; retirement never accepts a free-text reason",
            ticket=ticket_id,
        )
    if not isinstance(evidence, str) or not evidence.strip():
        return _refuse(
            "VALIDATION_FAILED",
            "retirement requires --evidence: a canonical event E-### or an owned "
            f"artifact under {_ret.EVIDENCE_DIR}/",
            ticket=ticket_id,
        )
    note_problem = _ret.note_error(note)
    if note_problem:
        return _refuse("VALIDATION_FAILED", note_problem, ticket=ticket_id)
    if not authority or not str(authority).strip():
        return _refuse(
            "RETIREMENT_AUTHORITY_REQUIRED",
            "retirement requires --authority SRC-### naming the operator decision "
            "whose capsule grants this retirement -- " + _ret.grammar_hint(),
            ticket=ticket_id,
        )
    authority = str(authority).strip().upper()
    evidence = evidence.strip()
    note = note.strip() if isinstance(note, str) else None
    if isinstance(discovery_event, str) and discovery_event.strip():
        discovery_event = discovery_event.strip().upper()
    else:
        discovery_event = None

    op_id = "retire-" + uuid4_hex()
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=ticket_id,
        )
    tickets = board["tickets"]
    events = {item["event"]: item for item in docs["_history"].events}
    next_event = (log_tail or 0) + 1
    ticket = tickets.get(ticket_id)
    record, record_errors, record_exists = _ret.load_ticket_retirement(root, ticket_id)
    if ticket is None:
        if not record_exists:
            return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
        if record is not None and not record_errors:
            return Result(
                ok=True,
                code="ALREADY_RETIRED",
                message=(
                    f"{ticket_id} was retired at {record.get('retired_at')} "
                    f"({record.get('reason')}), event {record.get('retirement_event')}"
                ),
                data={
                    "ticket": ticket_id,
                    "reason": record.get("reason"),
                    "retirement_event": record.get("retirement_event"),
                    "evidence_bound_event": record.get("evidence_bound_event"),
                    "record": _ret.retired_ticket_ref(ticket_id),
                },
            )
        if (
            isinstance(record, dict)
            and record.get("schema_version") == _ret.LEGACY_SCHEMA_VERSION
            and not _ret.legacy_ticket_record_errors(ticket_id, record)
        ):
            return _bind_legacy_retirement(
                root,
                docs,
                state,
                log_tail,
                events,
                op_id,
                ticket_id=ticket_id,
                record=record,
                agent=agent,
                reason=reason,
                evidence=evidence,
                authority=authority,
                discovery_event=discovery_event,
                note=note,
                now=now,
                utc=utc,
            )
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id} owns a retirement record that fails validation -- the forensic "
            "archive was altered and cannot answer for it: " + "; ".join(record_errors[:3]),
            ticket=ticket_id,
        )
    if record_exists:
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id} already owns a retirement record but is still on BOARD -- "
            "run `saipen recover` before retiring it again",
            ticket=ticket_id,
        )

    # A finished ticket is history. Retirement answers "this never belonged
    # here"; a DONE row already asserts the opposite and carries verification
    # evidence, so rewriting it as misrouted would falsify the ledger in the
    # other direction.
    section = ticket.get("section")
    if section == "## DONE":
        return _refuse(
            "TICKET_ALREADY_DONE",
            f"{ticket_id} is completed Work with closure evidence; retirement "
            "cannot rewrite finished history as misrouted",
            ticket=ticket_id,
        )
    if section not in _ret.RETIRABLE_SECTIONS:
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id} sits under {section!r}, which is not a retirable BOARD section",
            ticket=ticket_id,
        )

    receipts = [
        part.strip().upper()
        for part in str(ticket.get("fields", {}).get("source_receipts") or "").split(",")
        if part.strip()
    ]

    # AUTHORITY. A GRANT, not a mention: the operator's own stored bytes must
    # carry a capsule granting this ticket with exactly the receipts it drags
    # along. A live foreign claim needs no separate gate for the same reason --
    # Work another seat is running is retired only when the operator granted
    # exactly that, in writing.
    authority_problem, authority_binding = _ret.authority_error(
        root, authority, ticket_id=ticket_id, receipts=receipts
    )
    if authority_problem:
        return _refuse("RETIREMENT_AUTHORITY_REQUIRED", authority_problem, ticket=ticket_id)

    # EVIDENCE. A canonical event that precedes this retirement, or an owned
    # artifact whose digest is bound into every record. Free text is a claim.
    evidence_binding, evidence_problem = _ret.resolve_evidence(
        root, evidence, events, before_event=next_event
    )
    if evidence_problem:
        return _refuse("VALIDATION_FAILED", evidence_problem, ticket=ticket_id)
    discovery_problem = _ret.discovery_error(discovery_event, events, before_event=next_event)
    if discovery_problem:
        return _refuse("VALIDATION_FAILED", discovery_problem, ticket=ticket_id)

    # IDENTITY. Digest and linkage, both directions, fail closed on either.
    index = _intake._read_index(root)
    for receipt_id in receipts:
        if receipt_id not in index.get("active", {}):
            return _refuse(
                "VALIDATION_FAILED",
                f"{ticket_id} names receipt {receipt_id}, which is not on the active "
                "intake surface; retirement refuses an unresolvable linkage",
                ticket=ticket_id,
            )
        integrity = _intake.verify_integrity(root, receipt_id)
        if not integrity["ok"]:
            return _refuse(
                "VALIDATION_FAILED",
                f"receipt {receipt_id}: {integrity['code']} -- retirement refuses to "
                "archive bytes it cannot prove are the ones received",
                ticket=ticket_id,
            )
        meta = _intake._read_meta(root, receipt_id) or {}
        if not _intake.is_linked_to(meta, ticket_id):
            return _refuse(
                "VALIDATION_FAILED",
                f"receipt {receipt_id} is linked to "
                f"{sorted(_intake.linked_works(meta))!r}, not "
                f"{ticket_id}; retirement refuses a crossed ticket/receipt linkage",
                ticket=ticket_id,
            )

    # SEAT. Retirement is a non-transferring mutation (CORE-001): the seat is
    # PRESERVED, and a corrupt ownership snapshot is refused rather than
    # carried forward or silently healed.
    try:
        seat = _seat_agent(state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"retirement refuses a corrupt ownership snapshot: {exc}",
            ticket=ticket_id,
        )

    # A parent parked on THIS ticket owns the continuation. Retirement is not
    # "the dependency succeeded" -- the dependency EDGE was invalid, because
    # the child was never this project's Work. The parent therefore returns to
    # the exact phase tuple it saved, inside this same transaction.
    #
    # RESTORE, NEVER TRANSFER. The parent goes back to the seat its own
    # reservation names. Being authorized to retire the child grants nothing
    # over the parent: a foreign actor restores the owner's claim verbatim --
    # including its claim_time, because forging another seat's liveness would
    # be a transfer by other means -- and only the owner itself acting now
    # refreshes the claim. An unowned reservation is restored to the actor,
    # since there is nobody to take it from.
    resume_parent = continuation_parent(tickets, ticket_id, require_done=False)
    parent_id = resume_parent["id"] if resume_parent is not None else None
    restored_owner: str | None = None
    parent_claim = ""
    if parent_id:
        parent_fields = resume_parent.get("fields", {})
        resume_phase = str(parent_fields.get("resume_phase", ""))
        if resume_phase not in phases.TICKET_BEARING_PHASES:
            return _refuse(
                "VALIDATION_FAILED",
                f"{parent_id} is parked on {ticket_id} with resume_phase "
                f"{resume_phase!r}; restoring it would fabricate a phase",
                ticket=ticket_id,
            )
        saved_owner = str(parent_fields.get("owner") or "").strip()
        saved_claim = str(parent_fields.get("claim_time") or "").strip()
        restored_owner = saved_owner or agent
        parent_claim = utc if restored_owner == agent else saved_claim
        if not parent_claim:
            return _refuse(
                "VALIDATION_FAILED",
                f"{parent_id} is reserved for seat {restored_owner} without a claim_time; "
                "restoring it would forge that seat's claim",
                ticket=ticket_id,
            )

    message = _actor_provenance(
        state,
        agent,
        _ret.retirement_message(
            ticket_id=ticket_id,
            reason=reason,
            authority=authority,
            receipts=receipts,
            evidence=evidence_binding,
            discovery_event=discovery_event,
            restored_parent=parent_id,
            restored_parent_owner=restored_owner,
            note=note,
        ),
    )
    oversize = _retirement_event_oversize(docs, log_tail, message, ticket_id, agent, now, op_id)
    if oversize:
        return _refuse("VALIDATION_FAILED", oversize, ticket=ticket_id)
    event, line = _producer_event(
        docs,
        log_tail,
        "DEC",
        message,
        ticket=ticket_id,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    event_id = f"E-{event}"

    try:
        new_board, record_text, _section = _remove_ticket(docs["board"].text_norm, ticket_id)
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    if parent_id:
        new_board = _move_ticket(
            new_board, parent_id, "## DOING", "[/]", "resume", "", enforce_cap=False
        )
        parent_needs = [n for n in resume_parent.get("needs", []) if n != ticket_id]
        fields = {"owner": restored_owner, "claim_time": parent_claim}
        remove = [
            "blocker",
            "blocker_scope",
            "blocked_on",
            "resume_phase",
            "resume_transition_from",
        ]
        if parent_needs:
            fields["needs"] = ",".join(parent_needs)
        else:
            remove.append("needs")
        new_board = _ticket_fields_in_place(
            new_board, parent_id, fields, remove=tuple(remove), enforce_cap=False
        )

    if parent_id:
        parent_fields = resume_parent.get("fields", {})
        owned = {
            "phase": str(parent_fields.get("resume_phase", "")),
            "task": parent_id,
            "next_action": f"PHASE {parent_fields.get('resume_phase', '')} {parent_id}",
            "transition_from": str(parent_fields.get("resume_transition_from", "")),
            "last_event": event,
            "updated": utc,
            # The restored active ticket's owner IS the seat: STATE and BOARD
            # never commit an execution-owner split (CORE § 1.4).
            "agent": restored_owner,
        }
    else:
        owned = {"last_event": event, "updated": utc, "agent": seat}
        if state.get("task") == ticket_id:
            owned.update(
                {
                    "phase": "DONE",
                    "task": "none",
                    "transition_from": str(state.get("phase") or "DONE"),
                    "next_action": "saipen continue",
                }
            )
    new_state = patch_state(docs["state"].text_norm, owned)
    if parent_id is None:
        new_state = _settle_stop_reason(new_state, new_board, agent)
        if not str(parse_state(new_state).get("next_action") or "").startswith("WAIT:"):
            from .router import route_next

            routed = route_next(new_state, new_board, current_agent=agent)
            if routed.get("ok"):
                new_state = patch_state(new_state, {"next_action": routed["action"]})

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed retirement state fails fast validation: " + "; ".join(errors[:5]),
            ticket=ticket_id,
        )

    shared = _ret.shared_fields(
        reason=reason,
        evidence=evidence_binding,
        evidence_note=note,
        authority=authority_binding,
        retired_at=utc,
        retired_by=agent,
        retirement_event=event_id,
        discovery_event=discovery_event,
        evidence_bound_event=event_id,
    )
    ticket_target, _ticket_record = _ret.ticket_retirement_target(
        root,
        ticket_id,
        board_record=record_text,
        section=section,
        receipts=receipts,
        shared=shared,
        restored_parent=parent_id,
        restored_parent_owner=restored_owner,
    )
    source_targets: list[TargetPlan] = []
    tombstones: dict[str, dict] = {}
    try:
        for receipt_id in receipts:
            planned, tomb = _ret.source_retirement_targets(
                root,
                receipt_id,
                ticket_id=ticket_id,
                board_record=record_text,
                shared=shared,
            )
            source_targets.extend(planned)
            tombstones[receipt_id] = tomb
        if tombstones:
            # ONE index write for every receipt: a write per receipt would be
            # computed from the same before-bytes and the last would erase the
            # tombstones the earlier ones added.
            source_targets.append(_ret.index_target(root, tombstones))
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)

    targets = [
        *_log_targets(docs, new_log),
        ticket_target,
        *source_targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "ticket_retire",
        agent,
        _identity(root),
        {
            "operation": "ticket_retire",
            "ticket": ticket_id,
            "reason": reason,
            "authority": authority,
            "receipts": receipts,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "RETIRED",
            "ticket": ticket_id,
            "reason": reason,
            "authority": authority,
            "authority_grant": authority_binding["authority_grant"],
            "evidence": evidence_binding,
            "receipts": receipts,
            "restored_parent": parent_id,
            "restored_parent_owner": restored_owner,
            "record": _ret.retired_ticket_ref(ticket_id),
            "event_id": event_id,
        },
        op_id=op_id,
    )


def _retirement_event_oversize(
    docs: dict,
    log_tail: int | None,
    message: str,
    ticket_id: str,
    agent: str,
    now: str,
    op_id: str,
) -> str | None:
    """Refuse an event the LOG would externalize.

    Every other producer may move an oversized event into a `detail_ref`
    artifact. A retirement event may not: the validator proves each forensic
    record against the INLINE text of the event it cites, and a compact
    summary would leave that proof pointing at a second file instead of at
    the append-only ledger.
    """
    from .log import MAX_NEW_EVENT_BYTES, render_event

    rendered = render_event(
        log_tail,
        "DEC",
        redact_credentials(message),
        ticket=ticket_id,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    size = len(rendered.encode("utf-8"))
    if size > MAX_NEW_EVENT_BYTES:
        return (
            f"the retirement event would be {size} bytes (cap {MAX_NEW_EVENT_BYTES}); "
            "shorten --note or --evidence -- the permanent LOG line must carry the whole "
            "binding inline"
        )
    if redact_credentials(message) != message:
        return (
            "the retirement event text would be credential-redacted, so the LOG could "
            "no longer prove the record verbatim; cite evidence that carries no secret"
        )
    return None


def _bind_legacy_retirement(
    root: Path,
    docs: dict,
    state: dict,
    log_tail: int | None,
    events: dict,
    op_id: str,
    *,
    ticket_id: str,
    record: dict,
    agent: str,
    reason: str,
    evidence: str,
    authority: str,
    discovery_event: str | None,
    note: str | None,
    now: str,
    utc: str,
) -> OperationPlan | Result:
    """Re-affirm a schema-1 retirement under the current contract.

    Schema 1 is what the first T-1370 slice wrote: free-text evidence and an
    authority proven by identifier presence. Such a record is not valid
    project state, and it is not rewritten either. This transaction re-runs
    today's gates against the SAME decision -- the capsule must grant the
    retired ticket with exactly its receipts, the evidence must resolve -- and
    records the binding as a NEW event. The historical retirement event, time,
    actor, BOARD row and restored parent stay verbatim; the old free-text
    evidence survives as the note.
    """
    from . import intake as _intake
    from . import retirement as _ret

    if note is not None:
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id} is a legacy retirement: re-affirmation keeps its original "
            "evidence text verbatim as the note and accepts no new --note",
            ticket=ticket_id,
        )
    if reason != record.get("reason"):
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id} was retired as {record.get('reason')}; re-affirmation cannot "
            "change the reason",
            ticket=ticket_id,
        )
    if authority != record.get("authority_receipt"):
        return _refuse(
            "RETIREMENT_AUTHORITY_REQUIRED",
            f"{ticket_id} was retired under {record.get('authority_receipt')}; "
            "re-affirmation must cite that same operator decision",
            ticket=ticket_id,
        )
    receipts = list(record.get("source_receipts") or [])
    authority_problem, authority_binding = _ret.authority_error(
        root, authority, ticket_id=ticket_id, receipts=receipts
    )
    if authority_problem:
        return _refuse("RETIREMENT_AUTHORITY_REQUIRED", authority_problem, ticket=ticket_id)
    evidence_binding, evidence_problem = _ret.resolve_evidence(
        root, evidence, events, before_event=(log_tail or 0) + 1
    )
    if evidence_problem:
        return _refuse("VALIDATION_FAILED", evidence_problem, ticket=ticket_id)
    recorded_discovery = record.get("discovery_event")
    if recorded_discovery is not None and discovery_event not in (None, recorded_discovery):
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id} already records discovery event {recorded_discovery}; "
            "re-affirmation never replaces recorded history",
            ticket=ticket_id,
        )
    discovery = discovery_event or recorded_discovery
    retirement_event = str(record["retirement_event"])
    retired_number = int(retirement_event[2:])
    discovery_problem = _ret.discovery_error(discovery, events, before_event=retired_number)
    if discovery_problem:
        return _refuse("VALIDATION_FAILED", discovery_problem, ticket=ticket_id)

    # The ledger must back the legacy record before anything is bound to it: a
    # hand-written schema-1 file would otherwise be laundered into schema 2.
    historical = events.get(retired_number) or {}
    historical_text = str(historical.get("text") or "")
    if (
        historical.get("taxonomy") != "DEC"
        or historical.get("ticket") != ticket_id
        or historical.get("agent") != record.get("retired_by")
        or not str(historical.get("op_id") or "").startswith("retire-")
        or _ret.retirement_head(ticket_id, reason, authority) not in historical_text
        or f" -- {record.get('evidence')}" not in historical_text
    ):
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id}'s legacy record does not match {retirement_event} in LOG; "
            "re-affirmation refuses to bind evidence to a record the ledger does not back",
            ticket=ticket_id,
        )
    index = _intake._read_index(root)
    for receipt_id in receipts:
        tomb = index.get("tombstones", {}).get(receipt_id)
        if not _ret.is_retired_tombstone(tomb) or tomb.get("linked_work") != ticket_id:
            return _refuse(
                "VALIDATION_FAILED",
                f"{ticket_id}'s legacy record lists {receipt_id}, which is not its retired "
                "tombstone",
                ticket=ticket_id,
            )
        archive_problems = _ret.retired_archive_errors(root, receipt_id, tomb)
        if archive_problems:
            return _refuse(
                "VALIDATION_FAILED",
                f"retired receipt {receipt_id} is not intact: " + "; ".join(archive_problems[:3]),
                ticket=ticket_id,
            )

    message = _actor_provenance(
        state,
        agent,
        _ret.binding_message(
            ticket_id=ticket_id,
            retirement_event=retirement_event,
            authority=authority,
            grant=authority_binding["authority_grant"],
            evidence=evidence_binding,
            discovery_event=discovery,
        ),
    )
    oversize = _retirement_event_oversize(docs, log_tail, message, ticket_id, agent, now, op_id)
    if oversize:
        return _refuse("VALIDATION_FAILED", oversize, ticket=ticket_id)
    event, line = _producer_event(
        docs,
        log_tail,
        "DEC",
        message,
        ticket=ticket_id,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    event_id = f"E-{event}"
    try:
        seat = _seat_agent(state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"re-affirmation refuses a corrupt ownership snapshot: {exc}",
            ticket=ticket_id,
        )
    new_state = patch_state(
        docs["state"].text_norm, {"last_event": event, "updated": utc, "agent": seat}
    )
    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed re-affirmation state fails fast validation: " + "; ".join(errors[:5]),
            ticket=ticket_id,
        )
    shared = _ret.shared_fields(
        reason=reason,
        evidence=evidence_binding,
        evidence_note=str(record["evidence"]),
        authority=authority_binding,
        retired_at=str(record["retired_at"]),
        retired_by=str(record["retired_by"]),
        retirement_event=retirement_event,
        discovery_event=discovery,
        evidence_bound_event=event_id,
    )
    try:
        record_targets, _upgraded = _ret.legacy_rebind_targets(
            root, ticket_id, record, shared=shared
        )
    except (OSError, ValueError, KeyError) as exc:
        return _refuse("VALIDATION_FAILED", f"re-affirmation cannot plan: {exc}", ticket=ticket_id)
    targets = [
        *_log_targets(docs, new_log),
        *record_targets,
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "ticket_retire",
        agent,
        _identity(root),
        {
            "operation": "ticket_retire",
            "ticket": ticket_id,
            "reason": reason,
            "authority": authority,
            "receipts": receipts,
            "reaffirm": retirement_event,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "RETIREMENT_EVIDENCE_BOUND",
            "ticket": ticket_id,
            "reason": reason,
            "authority": authority,
            "authority_grant": authority_binding["authority_grant"],
            "evidence": evidence_binding,
            "discovery_event": discovery,
            "retirement_event": retirement_event,
            "record": _ret.retired_ticket_ref(ticket_id),
            "event_id": event_id,
        },
        op_id=op_id,
    )


@_state_guard
def retire_ticket(
    project_root: Path | str,
    ticket_id: str,
    agent: str,
    *,
    reason: str,
    evidence: str,
    authority: str,
    discovery_event: str | None = None,
    note: str | None = None,
    dry_run: bool = False,
) -> Result:
    """Retire misrouted/invalid Work without ever claiming it was done.

    The third verdict the protocol was missing (see `retirement.py`). It is
    NOT `ticket done` and NOT `source close`: nothing reaches DONE, no
    coverage is fabricated, the request bytes survive in forensic cold
    storage, and the BOARD row stops being schedulable Work.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _retire_targets(
        root,
        ticket_id.upper(),
        agent,
        reason,
        evidence,
        authority,
        now,
        utc,
        discovery_event=discovery_event,
        note=note,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _is_placeholder_verify(verify: str) -> bool:
    """A verify value that proves nothing about DONE (NITRO dogfood II).

    Python owns mechanics, not missing semantic content: a ticket's verify
    clause is the model's DONE proof. Refusing a placeholder keeps a weak
    model from creating mechanically perfect tickets whose completion can
    never be proven.
    """
    cleaned = (verify or "").strip().lower()
    return (
        not cleaned
        or cleaned
        in ("tbd", "todo", "verify: tbd", "verify: todo", "tbd -", "todo -", "placeholder")
        or (cleaned.startswith("verify:") and len(cleaned) < 12)
    )


def _ticket_add_route(priority: str, description: str) -> str:
    """The `ticket add` that creates the same ticket once its DONE proof is
    written in (T-1383). What the caller supplied is carried over when it can
    be typed back verbatim inside single quotes; anything else stays a
    placeholder rather than a line that would parse differently."""
    priority = str(priority or "").strip().upper()
    if not re.fullmatch(r"P[0-9]", priority):
        priority = "<PRIORITY>"
    text = " ".join(str(description or "").split())
    if not text or "'" in text or len(text) > 200:
        text = "<the ticket, one line>"
    return f"saipen ticket add {priority} '{text}' --verify '<how DONE is proven>'"


@_state_guard
def ticket_add(
    project_root: Path | str,
    agent: str,
    priority: str,
    description: str,
    needs: list[str],
    verify: str,
    dry_run: bool = False,
) -> Result:
    root = Path(project_root)
    if not description or not description.strip():
        return _refuse(
            "INCOMPLETE_TICKET",
            "ticket description is required (semantic input)",
            canonical_next_command=_ticket_add_route(priority, ""),
        )
    # T-1383: the BOARD grammar is `[P<digit>]`, and cold recovery and entry
    # read nothing else -- `ticket add fix the bug ...` made "fix" a priority
    # and a ticket those readers could not see. Case is mechanics, not intent.
    given = str(priority or "").strip()
    priority = given.upper()
    if not re.fullmatch(r"P[0-9]", priority):
        # Most often the priority was left out and the description's first
        # word took its place, so the route keeps that word in the text.
        return _refuse(
            "VALIDATION_FAILED",
            f"priority {given!r} is not P0-P9; the priority comes first, "
            "then the description",
            canonical_next_command=_ticket_add_route("", f"{given} {description}"),
        )
    if _is_placeholder_verify(verify):
        # T-1383: the refusal names the move, not only the rule -- the same
        # ticket with the one option it lacked.
        return _refuse(
            "INCOMPLETE_TICKET",
            "verify is required and cannot be a placeholder: pass --verify with "
            "the DONE proof (no TBD/TODO/empty)",
            verify=verify,
            canonical_next_command=_ticket_add_route(priority, description),
        )
    # CORE-003 / SRC-026:R003, ONE shared record-boundary predicate (not two
    # ad-hoc \\n/\\r tests): a scalar that carries ANY physical record
    # separator could render as two BOARD records, the second an
    # authoritative ticket line no allocator ever issued. Refuse BEFORE any
    # durable write.
    for scalar_name, scalar_value in (("description", description), ("verify", verify)):
        try:
            assert_single_record(scalar_value, scalar_name)
        except ValueError as exc:
            return _refuse("VALIDATION_FAILED", str(exc))
    op_id = "ticket-" + uuid4_hex()
    now, utc = _now(), _utc_iso()
    docs, _state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED", "BOARD parse error(s): " + "; ".join(board["errors"][:3])
        )
    # Ticket IDs derive from the SAME canonical complete history (sealed
    # segments + active LOG.md) already used for E-ID allocation -- a sealed
    # segment's [T-###] is ticket identity, never reissuable (T-1003).
    # T-1014: the combined text is the snapshot `_read` already captured;
    # re-opening the complete history here would be a second full pass.
    tid = next_ticket_id(
        docs["board"].text_norm,
        docs["_history"].text,
        history_max_ticket_id=getattr(docs["_history"], "max_ticket_id", None),
    )
    for need in needs:
        if need not in board["tickets"]:
            return _refuse("TICKET_NOT_FOUND", f"dangling needs: {need}")
    # T-1326 TARGET D: `semantic_*` is the redacted VALUE; `description`/
    # `verify` below are its BOARD SERIALIZATION. The full serialized record is
    # the externalized byte authority, and the compact projection serializes
    # each semantic scalar exactly once -- escaping the value here and again in
    # the projection double-escaped literal pipe/backslash content.
    semantic_description = redact_credentials(description)
    semantic_verify = redact_credentials(verify)
    description = escape_ticket_description(semantic_description)
    verify = escape_ticket_description(semantic_verify)
    desc = (
        f"- [ ] T-{tid} [{priority}] {description}"
        + (f" | needs: {', '.join(needs)}" if needs else "")
        + f" | verify: {verify}"
    )
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        f"T-{tid}",
        agent,
        _actor_provenance(_state, agent, "ticket added via SAIOPS"),
        now,
        op_id,
    )

    new_projection = prepare_new(
        root,
        desc,
        f"T-{tid}",
        priority=priority,
        description=semantic_description,
        needs=needs,
        verify=semantic_verify,
        op_id=op_id,
        event_id=f"E-{event}",
    )
    new_board = _insert_todo(docs["board"].text_norm, new_projection.board_text.rstrip("\n"))
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    owned = {
        "last_event": event,
        "updated": utc,
        # CORE-001 CONTROL A: filing FUTURE Work is an out-of-band operation.
        # It must not move the execution seat off the agent that owns the
        # active ticket -- the exact E-5941 split. The acting identity is in
        # the event's actor provenance instead. The seat is PRESERVED from
        # the BEFORE snapshot; a corrupt BEFORE ownership state refuses
        # (OwnershipSplitError) instead of being silently healed.
    }
    try:
        owned["agent"] = _seat_agent(_state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    new_state = patch_state(docs["state"].text_norm, owned)
    new_state = _recompute_free_slot_route(new_state, new_board, _state, agent)

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED", "proposed state fails fast validation: " + "; ".join(errors[:5])
        )

    targets = [
        *_log_targets(docs, new_log),
        *new_projection.targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    plan = build_plan(
        "ticket_add",
        agent,
        _identity(root),
        {
            "operation": "ticket_add",
            "priority": priority,
            "description": description,
            "needs": needs,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {"ok": True, "code": "TICKET_ADDED", "ticket": f"T-{tid}", "event_id": f"E-{event}"},
        op_id=op_id,
    )
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


@_state_guard
def compact_board(
    project_root: Path | str,
    ticket_id: str,
    agent: str,
    dry_run: bool = False,
) -> Result:
    """Canonical, lossless projection repair for one legacy BOARD row."""
    root = Path(project_root)
    op_id = "board-compact-" + uuid4_hex()
    now, utc = _now(), _utc_iso()
    docs, state, board, log_tail = _read(root)
    board_text = docs["board"].text_norm
    # Tolerant READ, strict WRITE. T-1326 TARGET C: ONE canonical compaction
    # rewrites EVERY repairable oversized row, so N>1 refused-field rows have a
    # reachable path instead of each naming a command the other row would
    # refuse. A refused unknown field on a row this plan rewrites is
    # repairable (its full physical bytes are journaled first); any other parse
    # fault -- or a refused field on a row this plan does NOT rewrite -- still
    # refuses here, and validate_texts below re-proves strict validity.
    repairable = oversized_ticket_ids(board_text)
    if board["errors"]:
        allowed = set(repairable)
        if not allowed or any(
            unrecognized_field_ticket(error) not in allowed for error in board["errors"]
        ):
            return _refuse(
                "VALIDATION_FAILED",
                "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
                ticket=ticket_id,
            )
    ticket = board["tickets"].get(ticket_id)
    if ticket is None:
        return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
    if ticket_id not in repairable:
        if len(str(ticket.get("raw", ""))) <= MAX_LIVE_RECORD_CHARS:
            detail_ref = str(ticket.get("fields", {}).get("detail_ref") or "").strip()
            if detail_ref:
                try:
                    resolve_detail(root, detail_ref, expected_ticket_id=ticket_id)
                except (OSError, ValueError, UnicodeError) as exc:
                    return _refuse(
                        "VALIDATION_FAILED",
                        f"existing BOARD detail reference is not resolvable: {exc}",
                        ticket=ticket_id,
                    )
                return Result(
                    True,
                    "ALREADY_APPLIED",
                    data={"ticket": ticket_id, "detail_ref": detail_ref, "idempotent": True},
                    message="BOARD legacy compaction already committed",
                )
        return _refuse(
            "VALIDATION_FAILED",
            f"{ticket_id} is already within the {MAX_LIVE_RECORD_CHARS}-character BOARD cap",
            ticket=ticket_id,
        )
    # T-1326 TARGET C: ONE DEC event PER compacted row in the SAME journaled
    # plan. The fast gate requires every workable BOARD record to have its own
    # `[T-###]` event in the history; a single-row DEC would leave the other
    # rows it just rewrote "detached" and refuse the very multi-row repair that
    # exists to make them canonical.
    event_lines: list[str] = []
    event_numbers: list[int] = []
    tail = log_tail
    for tid in repairable:
        event, line = _event_line(
            docs,
            tail,
            "DEC",
            tid,
            agent,
            "legacy oversized BOARD record compacted losslessly via SAIOPS",
            now,
            op_id,
        )
        tail = event
        event_numbers.append(event)
        event_lines.append(line)
    try:
        compacted = prepare_existing(
            root,
            board_text,
            repairable,
            op_id=op_id,
            # T-1326 P2: one DEC per row above, so each row's detail metadata
            # names ITS OWN event -- never the first row's.
            event_id={
                tid: f"E-{number}" for tid, number in zip(repairable, event_numbers)
            },
            reason="explicit canonical legacy BOARD compaction",
            tolerated_ids=set(repairable),
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    new_log = (
        docs["log"].text_norm.rstrip("\n")
        + "\n"
        + "".join(single + "\n" for single in event_lines)
    )
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "last_event": event_numbers[-1],
            "updated": utc,
            "agent": _seat_agent(state, docs["board"].text_norm, agent),
        },
    )
    # T-1354 RECOVERY LIVENESS. This gate judged the WHOLE proposed board, so a
    # repair scoped to ONE record was refused by unrelated records that were
    # already invalid before anybody touched anything. Measured on three real
    # projects at once: `saipen ticket compact T-195` -- the canonical repair
    # the protocol itself names and Fleet itself dispatches -- answered
    # "BOARD: T-196 has no [T-###] allocation event", so the named route could
    # never run, Fleet reported RECOVERY_FAILED forever, and every consequential
    # tool in those sessions was refused. A repair that cannot be executed from
    # the state that asks for it is not a recovery route.
    #
    # The fix is not a weaker gate: it is a gate that judges the REPAIR instead
    # of the repository's history. An error the proposal INTRODUCES still
    # refuses, exactly as before. An error that was already there, unchanged,
    # is pre-existing residue -- it is carried in the result so nothing is
    # silently legitimized, and it is not this repair's veto.
    before_errors = validate_texts(
        docs["state"].text_norm,
        docs["board"].text_norm,
        docs["log"].text_norm,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    errors = validate_texts(
        new_state,
        compacted.board_text,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    inherited = set(before_errors)
    introduced = [error for error in errors if error not in inherited]
    if introduced:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed BOARD compaction fails fast validation: " + "; ".join(introduced[:5]),
            ticket=ticket_id,
        )
    carried_findings = [error for error in errors if error in inherited]
    targets = [
        *compacted.targets,
        *_log_targets(docs, new_log),
        _target(docs["board"], ".saipen/BOARD.md", "board", compacted.board_text),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    plan = build_plan(
        "board_legacy_compaction",
        agent,
        _identity(root),
        {"operation": "board_legacy_compaction", "ticket": ticket_id},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "BOARD_COMPACTED",
            "ticket": ticket_id,
            "event_id": f"E-{event_numbers[0]}",
            "detail_ref": compacted.detail_ref,
            # T-1354: pre-existing findings this repair did not touch travel
            # WITH the success, so a repaired record never reads as a clean
            # board and the legacy records stay visible and unlegitimized.
            "carried_findings": carried_findings[:10],
            "carried_finding_count": len(carried_findings),
        },
        op_id=op_id,
        receipt_metadata={
            "operation": "board_legacy_compaction",
            "status": "COMMITTED",
            "ticket": ticket_id,
            "detail_ref": compacted.detail_ref,
            "original_record_sha256": compacted.original_hash,
            "event_id": f"E-{event_numbers[0]}",
            "reason": "lossless historical BOARD repair",
            # T-1354: the findings this repair INHERITED, declared so the
            # post-write verifier can judge the write instead of the
            # repository's history -- and journaled, so the exemption is
            # auditable and belongs to this one operation.
            "inherited_findings": before_errors[:50],
        },
    )
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


@_state_guard
def ticket_verify(
    project_root: Path | str,
    ticket_id: str,
    agent: str,
    verify: str,
    dry_run: bool = False,
) -> Result:
    """Canonical verify-field update, including legacy BOARD repair."""
    root = Path(project_root)
    if not verify or not verify.strip():
        return _refuse("VALIDATION_FAILED", "verify text is required", ticket=ticket_id)
    try:
        assert_single_record(verify, "verify")
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    op_id = "ticket-verify-" + uuid4_hex()
    now, utc = _now(), _utc_iso()
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=ticket_id,
        )
    if ticket_id not in board["tickets"]:
        return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
    verify = escape_ticket_description(redact_credentials(verify))
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        ticket_id,
        agent,
        "ticket verify updated via SAIOPS",
        now,
        op_id,
    )
    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            lambda board: _ticket_fields_in_place(
                board, ticket_id, {"verify": verify}, enforce_cap=False
            ),
            [ticket_id],
            op_id=op_id,
            event_id=f"E-{event}",
            reason="existing/proposed oversized BOARD record requires canonical verify update",
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    new_board = projected.board_text
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "last_event": event,
            "updated": utc,
            "agent": _seat_agent(state, docs["board"].text_norm, agent),
        },
    )
    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed verify update fails fast validation: " + "; ".join(errors[:5]),
            ticket=ticket_id,
        )
    targets = [
        *_log_targets(docs, new_log),
        *projected.targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    plan = build_plan(
        "ticket_verify",
        agent,
        _identity(root),
        {"operation": "ticket_verify", "ticket": ticket_id},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {"ok": True, "code": "TICKET_VERIFIED", "ticket": ticket_id, "event_id": f"E-{event}"},
        op_id=op_id,
    )
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


USER_REQUEST_VERIFY = (
    "the requested change is present and demonstrated against the user own "
    "description of it"
)


def _improve_module():
    """The improve.py owning the Core-sweep grammar, imported path-safely.

    `saipen_engine` loads from any harness that put the engine package on
    sys.path; improve.py is its SIBLING under the same tools/ root and may not
    be importable in every such harness. The fallback adds only that one
    directory -- the module's own home -- never an ambient path.
    """
    import importlib
    import sys

    try:
        return importlib.import_module("improve")
    except ImportError:
        tools_dir = str(Path(__file__).resolve().parent.parent)
        if tools_dir not in sys.path:
            sys.path.insert(0, tools_dir)
        return importlib.import_module("improve")


def _sweep_linkage(root: Path, ticket_id: str) -> dict:
    """The strict Core-sweep links naming `ticket_id` (T-1434 M4)."""
    try:
        improve = _improve_module()
    except ImportError as exc:
        return {"ok": False, "linked": False, "error": str(exc), "links": []}
    return improve.sweep_ticket_linkage(root, ticket_id)


def ticket_reasoning(
    project_root: Path | str,
    ticket_id: str,
    agent: str,
    recurrence: str,
    weak_model: str,
    dry_run: bool = False,
) -> Result:
    """Canonical writer for the Core-sweep reasoning-gate linkage (T-1434 M4).

    `recurrence:` (META-IMPROVEMENT) and `weak_model:` (WEAK-MODEL PRECEDENT)
    are required by the validator on a ticket produced by a STRICT Core sweep
    CONFIRMED PROTOCOL_VIOLATION disposition, and until now no canonical
    writer existed: the only way to satisfy the check was a raw BOARD edit.
    This operation refuses unless that exact linkage resolves through the ONE
    sweep grammar, so reasoning text can never be attached to an arbitrary
    ticket; an identical repeat is idempotent and writes nothing.
    """
    root = Path(project_root)
    for label, value in (("recurrence", recurrence), ("weak_model", weak_model)):
        if not value or not value.strip():
            return _refuse("VALIDATION_FAILED", f"{label} text is required", ticket=ticket_id)
        try:
            assert_single_record(value, label)
        except ValueError as exc:
            return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    op_id = "ticket-reasoning-" + uuid4_hex()
    now, utc = _now(), _utc_iso()
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=ticket_id,
        )
    if ticket_id not in board["tickets"]:
        return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
    linkage = _sweep_linkage(root, ticket_id)
    if not linkage.get("linked"):
        detail = (
            "no strict Core sweep CONFIRMED PROTOCOL_VIOLATION disposition "
            f"references {ticket_id}; the reasoning gates bind only to a real "
            "sweep linkage -- a ticket that a strict sweep did not produce is "
            "never given reasoning text"
        )
        if linkage.get("error"):
            detail += f" (linkage scan unavailable: {linkage['error']})"
        return _refuse("TICKET_REASONING_NOT_LINKED", detail, ticket=ticket_id)
    recurrence = escape_ticket_description(redact_credentials(recurrence.strip()))
    weak_model = escape_ticket_description(redact_credentials(weak_model.strip()))
    fields = board["tickets"][ticket_id].get("fields", {})
    if fields.get("recurrence") == recurrence and fields.get("weak_model") == weak_model:
        return Result(
            True,
            "ALREADY_LINKED",
            data={
                "ticket": ticket_id,
                "idempotent": True,
                "links": [link["ref"] for link in linkage["links"]],
            },
            message="the exact reasoning linkage is already recorded",
        )
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        ticket_id,
        agent,
        "ticket reasoning linkage written via SAIOPS "
        f"({len(linkage['links'])} strict sweep ref(s))",
        now,
        op_id,
    )
    try:
        projected = _project_board_mutation(
            root,
            docs["board"].text_norm,
            lambda board: _ticket_fields_in_place(
                board,
                ticket_id,
                {"recurrence": recurrence, "weak_model": weak_model},
                enforce_cap=False,
            ),
            [ticket_id],
            op_id=op_id,
            event_id=f"E-{event}",
            reason="existing/proposed oversized BOARD record requires canonical reasoning update",
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), ticket=ticket_id)
    new_board = projected.board_text
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "last_event": event,
            "updated": utc,
            "agent": _seat_agent(state, docs["board"].text_norm, agent),
        },
    )
    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed reasoning update fails fast validation: " + "; ".join(errors[:5]),
            ticket=ticket_id,
        )
    targets = [
        *_log_targets(docs, new_log),
        *projected.targets,
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    plan = build_plan(
        "ticket_reasoning",
        agent,
        _identity(root),
        {"operation": "ticket_reasoning", "ticket": ticket_id},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "TICKET_REASONING_WRITTEN",
            "ticket": ticket_id,
            "event_id": f"E-{event}",
            "links": [link["ref"] for link in linkage["links"]],
        },
        op_id=op_id,
    )
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _user_request_body(
    text: str,
    priority: str,
    verify: str,
    needs: list[str],
    supersedes: str | None = None,
) -> str:
    """The DURABLE request document -- the complete body, never the BOARD title.

    Deterministic on purpose: no timestamp, no nonce. The intake receipt is
    content-addressed, so an identical re-submission resolves to the SAME
    receipt instead of minting a second authority for one request. That is the
    whole idempotency story -- a retry after a crash is safe by construction.

    T-1363: content equality is a TRANSPORT identity, not an ACTION identity.
    "run the nightly cleanup" asked again next week is a new instruction, and
    the old digest answered it with `TICKET_ALREADY_DONE` -- so the only way
    to ask again was to reword the request, which is the user changing their
    words to defeat a hash. `supersedes` records the durable fact that makes
    the two different: THIS request follows a previous identical one that is
    finished. It is derived, never invented, so a retry of the new action
    renders the identical body and still resolves to its own single receipt.
    """
    lines = [
        "# User request",
        "",
        "priority: " + priority,
        "verify: " + verify,
    ]
    if needs:
        lines.append("needs: " + ", ".join(needs))
    if supersedes:
        lines.append("supersedes: " + supersedes)
    lines.extend(["", "## Request", "", text.strip(), ""])
    return "\n".join(lines)


def _request_title(text: str, limit: int = 160) -> str:
    """One BOARD-safe line derived from the request, never a replacement for it.

    BOARD carries a title; `.saipen/intake` carries the authority. The two are
    different artifacts, and this function is the only place that turns the
    second into the first.
    """
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    first = re.sub(r"\s+", " ", first)
    if len(first) > limit:
        first = first[: limit - 3].rstrip() + "..."
    return first


@_state_guard
def user_request(
    project_root: Path | str,
    agent: str,
    text: str,
    priority: str = "P1",
    verify: str | None = None,
    needs: list[str] | None = None,
    dry_run: bool = False,
    supersedes: str | None = None,
    supersede_ingress: bool = False,
) -> Result:
    """Persist an explicit user request as durable authority, THEN project it.

    CORE-003 / SRC-026:R003, and the FastPrompter regression in one sentence:
    a fresh user request arrived while an unrelated ticket was being finished,
    the protocol had nowhere to put it that survived a restart, and it was
    lost. The ordering here is the fix and it is not negotiable:

        1. the COMPLETE request body becomes a durable intake receipt;
        2. a concise `user_explicit` Work line is projected onto BOARD;
        3. the persisted `next_action` is recomputed through the shared Pick
           Rule, so a free START slot routes to the new request immediately.

    A crash between 1 and 2 leaves a recoverable receipt, never a ticket whose
    request body is gone; the retry is idempotent because the receipt is
    content-addressed. A crash before 1 loses nothing durable.

    CORE-001 integration: this is an OUT-OF-BAND operation. Recording user
    intent while another agent owns the active ticket must not move the
    execution seat -- the acting identity is journal provenance; the seat is
    left exactly where it was.
    """
    root = Path(project_root)
    if not isinstance(text, str) or not text.strip():
        return _refuse("INCOMPLETE_TICKET", "user request text is required (semantic input)")
    if not re.fullmatch(r"P[0-9]", priority or ""):
        return _refuse("VALIDATION_FAILED", "priority " + repr(priority) + " is not P0-P9")
    # T-1398: the same rule the start door carries. `user-request 2>&1` is a
    # shell line the shell itself would consume as transport; the operator
    # bytes are not a request under either ingress verb.
    from . import guard_events as _guard_events

    if _guard_events.shell_control_expression(text.strip()):
        return _refuse(
            "INGRESS_SHELL_CONTROL",
            "the user request is shell control syntax, not a request: a shell "
            "would consume it as transport and pass no task at all; name the "
            "task in words",
            canonical_next_command="saipen start '<the task, one line>'",
        )
    needs = list(needs or [])
    # T-1372: the other ingress door. `start` and `user-request` are the two
    # verbs the guard refuses on transport, so closing only one of them would
    # leave the paraphrase a door with a different name on it.
    from . import operator_task, pending_ingress

    obligation = pending_ingress.pending(root)
    owed = pending_ingress.enforce(
        root, text.strip(), supersede=supersede_ingress, commit=not dry_run
    )
    if owed is not None:
        return _refuse(owed.pop("code"), owed.pop("detail"), **owed)
    # T-1376: the same witness the other ingress door asks for.
    provenance = operator_task.witness(
        text.strip(),
        obligation_met=bool(obligation) and not obligation.get("malformed"),
    )
    if "code" in provenance:
        return _refuse(provenance.pop("code"), provenance.pop("detail"), **provenance)
    verify_text = (verify or "").strip() or USER_REQUEST_VERIFY
    if _is_placeholder_verify(verify_text):
        return _refuse(
            "INCOMPLETE_TICKET",
            "verify is a placeholder; an explicit user request still needs a real DONE proof",
            verify=verify_text,
        )
    # CORE-003 / SRC-026:R003, ordering invariant: `verify` is PROJECTED onto
    # BOARD, so it must be single-record-safe BEFORE durable capture. An
    # invalid scalar is a malformed request -- reject it with zero Source
    # receipt, zero BOARD mutation, zero STATE mutation and zero LOG mutation;
    # never capture first and discover the unsafe projection afterwards.
    # (The complete request BODY may stay multiline: intake authority, not a
    # BOARD scalar -- only the projected `title`/`verify` are constrained, and
    # `_request_title` collapses the body to one line by construction.)
    try:
        assert_single_record(verify_text, "verify")
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    title = _request_title(text)
    body = _user_request_body(text, priority, verify_text, needs, supersedes)

    from . import intake

    # Idempotency BEFORE any write: an identical request already captured and
    # already projected returns the SAME receipt and the SAME Work. Retrying a
    # request must never fork the authority for it.
    existing = intake.find_by_body(root, body)
    if existing and existing.get("linked_work"):
        board_now = parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))
        if existing["linked_work"] in board_now["tickets"]:
            return Result(
                True,
                "USER_REQUEST_DUPLICATE",
                message="request already captured as "
                + str(existing["receipt"])
                + " -> "
                + str(existing["linked_work"]),
                data={
                    "receipt": existing["receipt"],
                    "ticket": existing["linked_work"],
                    "duplicate": True,
                },
            )

    if dry_run:
        # PLAN purity (CORE-003): a previewed user request writes NOTHING --
        # no receipt, no BOARD line, no STATE. The plan names the exact targets
        # it would write instead of minting half of them first.
        return Result(
            True,
            "PLAN",
            message="user request would be captured durably, then projected",
            data={
                "operation": "user_request",
                "dry_run": True,
                "title": title,
                "priority": priority,
                "verify": verify_text,
                "needs": needs,
                "targets": [
                    ".saipen/intake (source receipt)",
                    ".saipen/LOG.md",
                    ".saipen/BOARD.md",
                    ".saipen/STATE.md",
                ],
            },
        )

    captured = intake.capture(
        root, body, source_kind="user_instruction", request_provenance=provenance
    )
    if not captured.get("ok"):
        return _refuse(
            captured.get("code", "SOURCE_UNRESOLVED"),
            "user request could not be captured durably: "
            + str(captured.get("detail") or captured),
        )
    receipt = captured.get("receipt")

    projected = _project_user_request(
        root, agent, receipt, title, priority, verify_text, needs
    )
    if not projected.ok:
        # The receipt survives on purpose: an unroutable receipt is
        # RECOVERABLE (the same request re-run adopts it); a lost request body
        # is not.
        return projected
    ticket_id = projected.data.get("ticket")
    linked = intake.capture(
        root,
        body,
        source_kind="user_instruction",
        work=ticket_id,
        request_provenance=provenance,
    )
    if not linked.get("ok"):
        return _refuse(
            linked.get("code", "ORPHAN_RECEIPT"),
            "user request "
            + str(receipt)
            + " was projected as "
            + str(ticket_id)
            + " but could not be linked to it: "
            + str(linked.get("detail") or linked),
            receipt=receipt,
            ticket=ticket_id,
        )
    return Result(
        True,
        "USER_REQUEST_RECORDED",
        message="user request captured as "
        + str(receipt)
        + " and projected as "
        + str(ticket_id),
        data={
            "receipt": receipt,
            "ticket": ticket_id,
            "user_explicit": True,
            "next_action": projected.data.get("next_action"),
            "event_id": projected.data.get("event_id"),
        },
    )


def authority_capture(
    project_root: Path | str,
    agent: str,
    text: str,
    *,
    dry_run: bool = False,
) -> Result:
    """Persist ONE operator-authority capsule and project NOTHING (T-1414).

    The retirement contract already demands `--authority SRC-###` whose stored
    bytes carry an operator-authority capsule granting exactly the Work's
    receipts -- and it must not be weakened to trust prose, event text, Work
    titles or command lines. What was missing is the pure persistence half:
    every existing ingress (`start`, `user-request`, `source capture`) either
    also projected Work or accepted arbitrary bodies. This owner captures the
    SAME closed capsule grammar the retirement parser owns, with an explicit
    non-projecting policy, so the operator's decision becomes one Source and
    zero Work/ticket/goal/Improve rows.
    """
    from . import intake as _intake
    from . import retirement as _ret

    root = Path(project_root)
    if not isinstance(text, str) or not text.strip():
        return _refuse(
            "INVALID_AUTHORITY_CAPTURE",
            "authority capture needs the exact UTF-8 capsule bytes from --file or --hex",
        )
    problem = _ret.capsule_problem(text)
    if problem:
        return _refuse("INVALID_AUTHORITY_CAPTURE", problem)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    operation_id = "authority-capture-" + digest[:16]
    if dry_run:
        existing = _intake.find_by_body(root, text)
        return Result(
            True,
            "PLAN",
            message="operator-authority capsule would be captured as its own Source",
            data={
                "operation": "authority_capture",
                "dry_run": True,
                "receipt": (existing or {}).get("receipt"),
                "source_sha256": digest,
                "operation_id": operation_id,
                "projection_policy": _intake.PROJECTION_AUTHORITY_ONLY,
                "targets": [".saipen/intake/active (source receipt)"],
            },
        )
    captured = _intake.capture(
        root,
        text,
        source_kind="user_instruction",
        projection_policy=_intake.PROJECTION_AUTHORITY_ONLY,
    )
    if not captured.get("ok"):
        return _refuse(
            captured.get("code", "SOURCE_UNRESOLVED"),
            "operator-authority capsule could not be captured durably: "
            + str(captured.get("detail") or captured),
        )
    duplicate = str(captured.get("code") or "").startswith("SOURCE_DUPLICATE")
    return Result(
        True,
        "AUTHORITY_ALREADY_CAPTURED" if duplicate else "AUTHORITY_CAPTURED",
        message="operator-authority capsule captured as "
        + str(captured.get("receipt"))
        + (" (already present)" if duplicate else "")
        + "; it authorizes retirement and projects no Work",
        data={
            "receipt": captured.get("receipt"),
            "source_sha256": captured.get("source_sha256") or digest,
            "operation_id": operation_id,
            "projection_policy": _intake.PROJECTION_AUTHORITY_ONLY,
            "source_kind": "user_instruction",
            "duplicate": duplicate,
            "linked_work": None,
        },
    )


def _project_user_request(
    root: Path,
    agent: str,
    receipt: str,
    title: str,
    priority: str,
    verify: str,
    needs: list[str],
) -> Result:
    """ONE journaled transaction: LOG + BOARD Work + recomputed routing."""
    op_id = "userreq-" + uuid4_hex()
    now, utc = _now(), _utc_iso()
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED", "BOARD parse error(s): " + "; ".join(board["errors"][:3])
        )
    for need in needs:
        if need not in board["tickets"]:
            return _refuse("TICKET_NOT_FOUND", "dangling needs: " + need)
    tid = next_ticket_id(
        docs["board"].text_norm,
        docs["_history"].text,
        history_max_ticket_id=getattr(docs["_history"], "max_ticket_id", None),
    )
    ticket_id = "T-" + str(tid)

    def render(title_text: str, verify_text: str) -> str:
        return (
            "- [ ] " + ticket_id + " [" + priority + "] "
            + escape_ticket_description(redact_credentials(title_text))
            + (" | needs: " + ", ".join(needs) if needs else "")
            + " | verify: " + escape_ticket_description(redact_credentials(verify_text))
            + " | user_explicit: " + USER_EXPLICIT_TRUE
            + " | source_receipts: " + receipt
        )

    # A projected Work that cannot be CLAIMED is the same dead end SRC-044
    # was: the receipt is durable, the row exists, and the next canonical step
    # refuses. Claiming appends exactly ` | owner: <agent> | claim_time:
    # <ISO-8601 Z>`, so that much of the cap belongs to the claim, not to the
    # projection, and the shrink below must leave it.
    cap = MAX_LIVE_RECORD_CHARS - len(" | owner: " + agent + " | claim_time: ") - 20

    def shrink(text: str, current: str, other: str, first: bool) -> tuple[str, str]:
        """Trim `text` until the rendered row fits, or until nothing is left.

        Escaping and redaction change lengths, so each step shrinks by the
        MEASURED excess and re-renders; predicting the rendered size is how a
        loop like this stops converging.
        """
        pointer = " ... [full text: " + receipt + "]"
        keep = len(text)
        while keep > 0:
            candidate = text[:keep].rstrip() + pointer
            rendered = render(candidate, other) if first else render(other, candidate)
            if len(rendered) <= cap:
                return candidate, rendered
            keep -= max(1, len(rendered) - cap)
        pointer = "see " + receipt
        return pointer, (render(pointer, other) if first else render(other, pointer))

    line = render(title, verify)
    board_title, board_verify = title, verify
    if len(line) > cap:
        # T-1363 / SRC-044: the request is already durable in `receipt`, the
        # complete verify clause included. Refusing the projection here left
        # that receipt linked to nothing -- measured live -- and a retry of the
        # same request refused the same way, so the user's intent had no Work
        # at all. BOARD carries a compact reference instead, exactly what the
        # cap's own refusal asks for; the receipt stays the authority.
        board_verify, line = shrink(verify, line, title, first=False)
    if len(line) > cap:
        # An enormous TITLE can overflow the row on its own. Shrink it the same
        # way rather than looping on a verify that is already at its floor.
        board_title, line = shrink(title, line, board_verify, first=True)
    if len(line) > cap:
        # Nothing the projection owns is left to trim: `needs` and the ticket
        # identity are the remainder. ONE bounded answer that names the durable
        # receipt and the exact way forward -- never a retry that loops.
        return _refuse(
            "BOARD_RECORD_OVERSIZE",
            f"the request is durable as {receipt}, but even a minimum BOARD row is "
            f"{len(line)} characters against a claimable budget of {cap} because "
            f"`needs` names {len(needs)} ticket(s); resubmit it with fewer `needs`",
            receipt=receipt,
            canonical_next_command=f"saipen start --receipt {receipt}",
            needs=needs,
        )
    verify = board_verify
    title = board_title
    new_board = _insert_todo(docs["board"].text_norm, line)
    event, event_line = _event_line(
        docs,
        log_tail,
        "DEC",
        ticket_id,
        agent,
        _actor_provenance(
            state,
            agent,
            "user request " + receipt + " projected as " + ticket_id + " (user_explicit)",
        ),
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + event_line + "\n"
    owned = {
        "last_event": event,
        "updated": utc,
        # CORE-001 CONTROL B: persisting user intent is OUT-OF-BAND. It never
        # takes the active execution seat from the agent that owns it. The seat
        # is PRESERVED from the BEFORE snapshot; a corrupt BEFORE ownership
        # state refuses instead of being silently healed.
    }
    try:
        owned["agent"] = _seat_agent(state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    new_state = patch_state(docs["state"].text_norm, owned)
    # The persisted route is recomputed in the SAME transaction: a free START
    # slot must point at the new explicit request immediately, not whenever a
    # later `continue` happens to run. A legitimate WAIT brake and a live
    # active ticket both keep their own continuation -- same shared rule the
    # ordinary ticket projection uses, so the two cannot diverge.
    new_state = _recompute_free_slot_route(new_state, new_board, state, agent)
    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED", "proposed state fails fast validation: " + "; ".join(errors[:5])
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    plan = build_plan(
        "user_request",
        agent,
        _identity(root),
        {"operation": "user_request", "receipt": receipt, "ticket": ticket_id},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "USER_REQUEST_RECORDED",
            "ticket": ticket_id,
            "receipt": receipt,
            "event_id": "E-" + str(event),
            "next_action": parse_state(new_state).get("next_action"),
        },
        op_id=op_id,
    )
    if isinstance(plan, Result):
        return plan
    return apply_plan(root, plan)


def cohort_status(project_root: Path | str, cohort_id: str) -> Result:
    """Read-only cohort projection: membership, scope, readiness, publication."""
    from . import closure as _closure

    root = Path(project_root)
    try:
        registry = _closure.read_registry(root)
    except (OSError, ValueError) as exc:
        return _refuse("VALIDATION_FAILED", "cohort registry is unreadable: " + str(exc))
    cohort = (registry.get("cohorts") or {}).get(cohort_id)
    if cohort is None:
        return _refuse(
            "VALIDATION_FAILED",
            "cohort " + cohort_id + " has no durable registry record -- BOARD "
            "prose is not cohort authority",
        )
    readiness = _closure.cohort_readiness(root, cohort)
    return Result(
        True,
        "COHORT_STATUS",
        data={
            "cohort": cohort_id,
            "publication_status": cohort.get("publication_status"),
            "members": sorted(cohort.get("members") or {}),
            "scope": sorted(cohort.get("scope") or []),
            "ready": readiness["ready"],
            "problems": readiness["problems"],
            "release_op_id": cohort.get("release_op_id") or "",
            "version": cohort.get("version") or "",
            "tag": cohort.get("tag") or "",
            "commit": cohort.get("commit") or "",
        },
    )


@_state_guard
def cohort_ship(
    project_root: Path | str,
    cohort_id: str,
    agent: str,
    dry_run: bool = False,
    current_capability: str | None = None,
) -> Result:
    """Publish ONE cohort batch through the EXISTING release machinery.

    CORE-003 / SRC-026:R003. The members already closed with evidence; what
    remains is the publication obligation the batch owns collectively. This
    function does not publish anything itself -- it derives the frozen batch
    scope (each shared path exactly once, bound to the live bytes every member
    attributed) and hands it to `release.plan_release` as a carrier, so the
    R001-hardened staging, foreign-index protection, ship gate, tag/push and
    recovery are the same code an ordinary release runs.

    Repeating a ship is a deterministic already-published refusal, not a
    second publication.
    """
    from . import closure as _closure
    from .release import ReleaseRefusal, execute_release, plan_release

    root = Path(project_root)
    try:
        registry = _closure.read_registry(root)
    except (OSError, ValueError) as exc:
        return _refuse("VALIDATION_FAILED", "cohort registry is unreadable: " + str(exc))
    cohort = (registry.get("cohorts") or {}).get(cohort_id)
    if cohort is None:
        return _refuse(
            "VALIDATION_FAILED",
            "cohort " + cohort_id + " has no durable registry record -- BOARD "
            "prose is not cohort authority",
        )
    if cohort.get("publication_status") == "shipped":
        return _refuse(
            "VALIDATION_FAILED",
            "cohort " + cohort_id + " is already published (release "
            + str(cohort.get("release_op_id"))
            + ", version "
            + str(cohort.get("version"))
            + "); a second ship would publish the same batch twice",
            cohort=cohort_id,
        )
    readiness = _closure.cohort_readiness(root, cohort)
    if not readiness["ready"]:
        return _refuse(
            "COHORT_NOT_READY",
            "cohort " + cohort_id + " is not ready to publish: "
            + "; ".join(readiness["problems"][:3]),
            cohort=cohort_id,
        )
    try:
        scope = _closure.cohort_scope(cohort)
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), cohort=cohort_id)
    if not scope:
        return _refuse(
            "SOURCE_SCOPE_MISSING",
            "cohort " + cohort_id + " has no batch scope to publish",
            cohort=cohort_id,
        )
    members = sorted(cohort.get("members") or {})
    carrier = {
        "cohort_id": cohort_id,
        # The carrier needs ONE Work identity for the release receipt; the
        # batch's own authority is `cohort_id`, and every member is recorded
        # in the registry. The lowest member id is a stable, non-arbitrary
        # choice that survives re-derivation.
        "ticket_id": members[0],
        "scope": scope,
    }
    try:
        plan = plan_release(
            root,
            "cohort-ship",
            dry_run=dry_run,
            cohort_carrier=carrier,
            current_capability=current_capability,
            current_agent=agent,
        )
    except (ReleaseRefusal, ValueError) as exc:
        return _refuse(
            getattr(exc, "code", "VALIDATION_FAILED"),
            getattr(exc, "detail", str(exc)),
            cohort=cohort_id,
        )
    if dry_run:
        # PLAN purity: the carrier is derived and the plan is built, and NOTHING
        # is written -- no registry flip, no release receipt, no Git index touch.
        return Result(
            True,
            "PLAN",
            message="cohort " + cohort_id + " would publish one batch scope",
            data={
                "operation": "cohort_ship",
                "dry_run": True,
                "cohort": cohort_id,
                "members": members,
                "scope": sorted(scope),
                "version": plan.version,
                "tag": plan.tag,
                "mode": plan.mode,
            },
        )
    outcome = execute_release(root, plan)
    if not outcome.get("ok"):
        return _refuse(
            outcome.get("code", "RELEASE_FAILED"),
            str(outcome.get("detail") or outcome.get("message") or "cohort publication failed"),
            cohort=cohort_id,
        )
    return Result(
        True,
        "COHORT_SHIPPED",
        message="cohort " + cohort_id + " published as one batch",
        data={
            "cohort": cohort_id,
            "members": members,
            "scope": sorted(scope),
            "release_op_id": plan.op_id,
            "version": plan.version,
            "tag": plan.tag,
            "mode": plan.mode,
        },
    )


@_state_guard
def ticket_move(
    project_root: Path | str,
    action: str,
    ticket_id: str,
    agent: str,
    payload: str = "",
    dry_run: bool = False,
    scope: str | None = None,
    blocked_on: str | None = None,
    retry_not_before: str | None = None,
) -> Result:
    """Move a ticket between BOARD sections.

    `done` is NOT a section move: it is the atomic ticket-closure operation
    (NITRO dogfood III, T-591). A standalone `done` here would leave the split
    (BOARD DONE[x] while STATE still names the ticket in a ticket-bearing
    phase) that the composition audit reproduced. `done` delegates to
    finish_ticket so one public operation, one lifecycle meaning.

    `retry_not_before` (T-1429) is the ONE canonical machine-readable
    deferred-operator due instant, written only on a `block`/`block-for` and
    cleared by `unblock`.
    """
    if action == "done":
        return finish_ticket(project_root, ticket_id, agent, dry_run=dry_run)
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _ticket_targets(
        root,
        action,
        ticket_id,
        agent,
        payload,
        now,
        utc,
        scope=scope,
        blocked_on=blocked_on,
        retry_not_before=retry_not_before,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


# ------------------------------------------------------------------ goal


def _state_only_plan(
    root: Path,
    operation: str,
    agent: str,
    mutate,
    event_message: str,
    expected: dict,
    now: str,
    utc: str,
    owned_keys: set,
    ticket_id: str | None = None,
    evidence_preconditions: dict[str, str] | None = None,
    receipt_metadata: dict | None = None,
    extra_targets: list[TargetPlan] | None = None,
    op_id: str | None = None,
    allow_dead_home: bool = False,
    read_once: tuple | None = None,
    log_text: str | None = None,
    repair: bool = False,
) -> OperationPlan | Result:
    # `repair=True` marks an operation whose SUBJECT is damage. Ordinary work
    # must still refuse on a project that fails validation -- that is the write
    # gate doing its job -- but a repair walks in on damage by definition, and
    # several damage classes have separate owners that each need the others'
    # surface to parse. Judging a repair on the whole project is what made that
    # set of repairs mutually unreachable: `normalize-log`, the one owner of a
    # malformed LOG line, refused over a duplicate BOARD id it does not repair
    # and cannot reach (_SAITULS, 17.09.26). A repair is judged on its DELTA;
    # what it inherits is declared, exempted for this one operation, and still
    # reported everywhere else.
    # `log_text` REPLACES the LOG this plan appends its event to. Exactly one
    # caller supplies it -- `normalize_log`, whose whole point is that the bytes
    # on disk are not a legal ledger -- and the proposed text still passes
    # `validate_texts` below, so the append-only contract is proved on the
    # result rather than assumed from the input.
    op_id = op_id or (operation + "-" + uuid4_hex())
    # ONE frozen read (second-wave P0): an operation that already read the
    # project for its authorization/derivation decision MUST hand that exact
    # snapshot here, never a second independent `_read`. State can change
    # between reads; two reads would let an authorization proven on snapshot A
    # mutate snapshot B. When no snapshot is supplied this reads once itself --
    # still exactly ONE `_read` per plan. APPLY remains the only later live
    # reread/CAS check.
    if read_once is not None:
        docs, _state, _board, log_tail = read_once
    else:
        docs, _state, _board, log_tail = _read(root, allow_dead_home=allow_dead_home)
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        ticket_id,
        agent,
        _actor_provenance(_state, agent, event_message),
        now,
        op_id,
    )
    base_log = docs["log"].text_norm if log_text is None else log_text
    new_log = base_log.rstrip("\n") + "\n" + line + "\n"
    new_state = mutate(docs["state"].text_norm, event)
    # CORE-001: every caller's `mutate` writes `agent: <actor>` into its owned
    # patch. That is correct for the last-writer meaning and WRONG for the
    # execution-seat meaning, and STATE.agent is the second one. This is the
    # ONE choke point every state-only operation passes through, so the seat
    # rule is applied here rather than in each caller's closure. The seat is
    # PRESERVED from the BEFORE snapshot; a corrupt BEFORE ownership state
    # refuses (zero mutation) instead of being silently healed.
    try:
        _seat = _seat_agent(_state, docs["board"].text_norm, agent)
    except OwnershipSplitError as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    if _seat != agent:
        new_state = patch_state(new_state, {"agent": _seat})
    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors and repair:
        from .fast_check import defect_delta, validate_project

        before = validate_texts(
            docs["state"].text_norm,
            docs["board"].text_norm,
            docs["log"].text_norm,
            current_agent=agent,
            sealed_events=docs["_history"],
        )
        errors, _inherited = defect_delta(before, errors)
        inherited_findings = list(validate_project(root) or [])
        if inherited_findings:
            receipt_metadata = {
                **(receipt_metadata or {}),
                "inherited_findings": inherited_findings,
            }
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            ("repair INTRODUCES defects the surface did not have: " if repair else
             "proposed state fails fast validation: ") + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    targets.extend(extra_targets or [])
    expected["event_id"] = f"E-{event}"
    preconditions = _docs_preconditions(docs, "state", "board", "log")
    # Snapshot evidence wins on overlap. If STATE/LOG moved after the domain
    # snapshot but before this generic planner read them, APPLY must refuse
    # the mixed plan rather than authorize against the later bytes.
    preconditions.update(evidence_preconditions or {})
    for target in extra_targets or []:
        # A MISSING extra target's live hash is "" (journal._hash_file), while
        # codec.read_document of a missing file hashes empty BYTES. The plan
        # precondition must use the live convention or a first-time write of
        # an extra target would refuse itself as STALE_STATE.
        # A domain snapshot may already bind this target to older bytes.  Keep
        # that earlier authority so a change between planning and extra-target
        # construction becomes STALE_STATE instead of being laundered into the
        # new plan as its own precondition.
        target_before = target.before_hash if (root / target.path).exists() else ""
        if preconditions.get(target.path) == MISSING_FILE_DEPENDENCY and target_before == "":
            # The domain snapshot represented an absent READ dependency with
            # the safe file token; once that same path becomes a WRITE target,
            # journal CAS represents absence as "". Normalize only this exact
            # equivalent state. If another writer creates the file before
            # APPLY, its nonempty live hash still differs from "" and refuses.
            preconditions[target.path] = ""
        else:
            preconditions.setdefault(target.path, target_before)
    return build_plan(
        operation,
        agent,
        _identity(root),
        {"operation": operation, "agent": agent},
        preconditions,
        targets,
        expected,
        op_id=op_id,
        receipt_metadata=receipt_metadata,
    )


@_state_guard
def set_goal_intent(
    project_root: Path | str, agent: str, objective: str, dry_run: bool = False
) -> Result:
    """Record a decided goal pivot: execution_intent goal, counters from 0.
    Owns ONLY intent/counters/last_event/updated/agent -- never phase, task or
    next_action. Claiming the top ticket is a separate operation.

    This is the STATE-only primitive used by existing callers (valve tests,
    intent resume). The CLI `goal` command uses goal_entry instead.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()

    def mutate(text: str, event: int) -> str:
        transitioned = transition_execution_intent(text, "goal", goal_waves=0, goal_tickets=0)
        return patch_state(
            transitioned,
            {
                "last_event": event,
                "updated": utc,
                "agent": agent,
            },
        )

    # W2-004: the STATE-only primitive also refuses a blank/whitespace/
    # normalized-empty objective with ZERO writes before any LOG/counter write.
    _, goal_err = _validate_goal_objective(objective)
    if goal_err is not None:
        return _refuse("INVALID_GOAL", goal_err, objective=objective)

    plan = _state_only_plan(
        root,
        "goal",
        agent,
        mutate,
        f"goal pivot -- {objective}",
        {"ok": True, "code": "GOAL_SET"},
        now,
        utc,
        {"execution_intent", "goal_waves", "goal_tickets"},
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _validate_goal_objective(objective: str | None) -> tuple[str, str | None]:
    """W2-004: ONE shared goal-pivot objective validator.

    Returns (normalized, error). ``error`` is a closed-code detail string when
    the objective is missing, whitespace-only, or redacts to nothing; callers
    MUST refuse (zero writes) on a non-None error. A valid objective is
    returned redacted + stripped so the CLI and every primitive persist the
    SAME canonical text -- no divergent blank-pivot behaviour across callers.
    """
    if objective is None:
        return "", "objective is required (no pivot text supplied)"
    raw = objective.strip()
    if not raw:
        return "", "objective is required (whitespace-only pivot is not a goal)"
    safe = redact_credentials(raw).strip()
    if not safe:
        return "", "objective is required (redacts to nothing -- supply real goal text)"
    return safe, None


def _goal_plan_steps(objective: str) -> list[str]:
    """Decompose a normalized objective into bounded, deterministic plan steps
    (W2-003). Splits on clause boundaries; caps at GOAL_TICKET_CAP; falls back
    to the whole objective when no clause yields a non-empty step."""
    import re as _re

    clauses = _re.split(r"[\n;]+|\.\s+|\s+--\s+|\bthen\b", objective)
    steps = [c.strip().strip(".!?").strip() for c in clauses]
    steps = [s for s in steps if s]
    if not steps:
        steps = [objective]
    return steps[:GOAL_TICKET_CAP]


def _goal_plan_ticket_ids(
    board_text: str, history_text: str, count: int, history_max_ticket_id: int | None = None
) -> list[str]:
    """Allocate one collision-free monotonic ID block from a frozen snapshot."""
    if count < 0 or count > GOAL_TICKET_CAP:
        raise ValueError(f"goal plan ticket count {count} outside 0..{GOAL_TICKET_CAP}")
    first = next_ticket_id(board_text, history_text, history_max_ticket_id=history_max_ticket_id)
    return [f"T-{first + offset}" for offset in range(count)]


@_state_guard
def goal_entry(
    project_root: Path | str, agent: str, objective: str, dry_run: bool = False
) -> Result:
    """T-1100 + second-wave W2-003/W2-004: Durable goal-entry operation.

    The ONE canonical pivot that durably captures a NEW objective and plans it
    into the board. Cross-file transaction owns:

    LOG:   pivot DEC event (redacted objective) plus the countable Entry PLAN
           wave bump required by MAINTENANCE.md section 2.4;
    BOARD: checkpoint active DOING ticket -> TODO (demote, clear claim fields);
           generate the new objective's PLAN tickets ABOVE the existing TODO
           (no deletion); promote the first plan ticket to DOING (SCOUT claim).
    STATE: execution_intent -> goal, goal_waves -> 1 (Entry PLAN, exactly once),
           goal_tickets -> 0 (tickets count only after VERIFY), next_action ->
           first plan ticket.

    W2-004: a missing/whitespace/normalized-empty objective is refused with
    ZERO writes before any handover/LOG/counter/BOARD/journal touch.

    T-1446 duplicate-goal idempotence: a semantic objective whose deterministic
    ingress identity (project + normalized objective) already owns a nonterminal
    goal with no new semantic scope is NOT planned again. The existing goal is
    returned as GOAL_ALREADY_CAPTURED with zero LOG/BOARD/STATE writes, so a
    repeated broad shorthand (`cc all`) can never mint a second goal, demote a
    live mission, or consume another verification run. A materially changed
    objective, a changed project, or a TERMINAL prior goal is a NEW scope and
    plans normally.
    """
    # W2-004: validate the objective BEFORE touching any canonical file.
    safe_objective, goal_err = _validate_goal_objective(objective)
    if goal_err is not None:
        return _refuse("INVALID_GOAL", goal_err, objective=objective)

    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    op_id = "goal-entry-" + uuid4_hex()

    # ONE frozen read (second-wave P0 discipline).
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
        )

    # --- T-1446 duplicate-goal idempotence (deterministic, no LLM guessing) --
    from .cold_recovery import goal_ingress_identity

    ingress = goal_ingress_identity(safe_objective, _identity(root))
    goal_waves = 0
    if (
        state.get("execution_intent") == "goal"
        and str(state.get("goal_ingress") or "").strip()
    ):
        goal_waves = int(state.get("goal_waves") or 0)
        if str(state.get("goal_ingress")) == ingress and goal_waves > 0:
            return Result(
                True,
                "GOAL_ALREADY_CAPTURED",
                message="duplicate goal ingress: this exact objective is already "
                "the active goal; no second goal is planned and no work is "
                "duplicated",
                data={
                    "goal_ingress": ingress,
                    "objective": safe_objective,
                    "goal_waves": goal_waves,
                    "task": state.get("task"),
                    "next_action": state.get("next_action"),
                },
            )

    active_ticket = None
    doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
    if doing:
        active_ticket = doing[0]["id"]
        state_task = state.get("task")
        if state_task and state_task != "none" and state_task != active_ticket:
            return _refuse(
                "ACTIVE_TICKET_MISMATCH",
                f"STATE.task={state_task} but BOARD.DOING={active_ticket}; "
                "repair the split before entering goal-driven execution",
            )

    # --- LOG: pivot event ---
    pivot_msg = f"goal pivot -- {safe_objective}"
    if active_ticket:
        pivot_msg += f" (active {active_ticket} checkpointed to TODO)"
    pivot_event, pivot_line = _event_line(
        docs, log_tail, "DEC", active_ticket, agent, pivot_msg, now, op_id
    )
    wave_event, wave_line = _event_line(
        docs, pivot_event, "DEC", active_ticket, agent, "goal_waves 0->1", now, op_id
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + pivot_line + "\n" + wave_line + "\n"

    # --- BOARD: demote active DOING, then plan the new objective above TODO ---
    new_board_text = docs["board"].text_norm
    if active_ticket:
        ticket = board["tickets"][active_ticket]
        raw = ticket["raw"]
        lines = new_board_text.splitlines(keepends=True)
        doing_line_idx = None
        for idx, line in enumerate(lines):
            stripped = line.rstrip("\n")
            if stripped.startswith("- [/] " + active_ticket + " ") or stripped.startswith(
                "- [ ] " + active_ticket + " "
            ):
                doing_line_idx = idx
                break
        if doing_line_idx is not None:
            demoted = raw
            demoted = remove_ticket_field(demoted, "owner")
            demoted = remove_ticket_field(demoted, "claim_time")
            demoted = demoted.replace("- [/] ", "- [ ] ", 1)
            lines.pop(doing_line_idx)
            todo_idx = next(
                i for i, ln in enumerate(lines) if ln.rstrip("\n").startswith("## TODO")
            )
            lines.insert(todo_idx + 1, demoted.rstrip() + "\n")
            new_board_text = "".join(lines)

    # Generate the objective's PLAN tickets (canonical TODO lines, above old
    # TODO) and capture their ids in board order (top first). No deletion of
    # the existing backlog.
    steps = _goal_plan_steps(safe_objective)
    plan_lines = []
    plan_ids = _goal_plan_ticket_ids(
        new_board_text,
        docs["_history"].text,
        len(steps),
        history_max_ticket_id=getattr(docs["_history"], "max_ticket_id", None),
    )
    if (
        len(plan_ids) != len(steps)
        or len(set(plan_ids)) != len(plan_ids)
        or any(re.fullmatch(r"T-[1-9]\d*", ticket_id) is None for ticket_id in plan_ids)
    ):
        return _refuse(
            "VALIDATION_FAILED",
            "goal plan ticket allocator returned duplicate, malformed, or incomplete IDs",
            plan_tickets=plan_ids,
        )
    for step, ticket_id in zip(steps, plan_ids, strict=True):
        desc = escape_ticket_description(step)
        verify = escape_ticket_description(
            f"{step} is complete and the repository-declared verification harness passes"
        )
        plan_lines.append(f"- [ ] {ticket_id} [P1] {desc} | verify: {verify}")
        # A new BOARD identity needs its own structured allocation evidence,
        # just as ticket_add does. The pivot event names the old active Work
        # and cannot prove allocation of any of these new IDs.
        wave_event, allocation_line = _event_line(
            docs, wave_event, "DEC", ticket_id, agent,
            "ticket added via SAIOPS -- goal entry", now, op_id,
        )
        new_log += allocation_line + "\n"
    if plan_lines:
        blines = new_board_text.splitlines(keepends=True)
        todo_idx = next(i for i, ln in enumerate(blines) if ln.rstrip("\n").startswith("## TODO"))
        # Insert the plan block ABOVE existing TODO; plan_lines order preserved
        # (first step on top) so the new objective outranks the old backlog.
        blines.insert(todo_idx + 1, "".join(line + "\n" for line in plan_lines))
        new_board_text = "".join(blines)

    # Promote the FIRST plan ticket to DOING (SCOUT claim) so the Entry PLAN
    # establishes an actionable first step bound to this agent.
    first_id = plan_ids[0] if plan_ids else None
    if first_id is not None:
        new_board_text = _claim_move(
            new_board_text, first_id, agent, utc,
            session_binding=host_session_binding(root),
        )

    # --- STATE: record Entry PLAN exactly once (wave 1) --------------------
    # CORE-009: when the current phase is a ticket-bearing phase (BUILD,
    # VERIFY, etc.), keep it -- goal_entry only changes the intent/task,
    # not the phase. The SCOUT phase is only set when starting from a
    # non-ticket-bearing phase (DONE, INIT).
    cur_phase = state.get("phase") or "DONE"
    if first_id is not None and cur_phase not in ("DONE", "INIT", "BLOCKED"):
        # Keep the current phase; only change task and next_action
        new_phase = cur_phase
    elif first_id is not None:
        new_phase = "SCOUT"
    else:
        new_phase = cur_phase
    if active_ticket and first_id is None:
        new_phase = "DONE"
    next_action = f"PHASE SCOUT {first_id}" if first_id is not None else "saipen continue"
    transitioned = transition_execution_intent(
        docs["state"].text_norm, "goal", goal_waves=1, goal_tickets=0
    )
    new_state = patch_state(
        transitioned,
        {
            "phase": new_phase,
            "task": first_id if first_id is not None else "none",
            "next_action": next_action,
            "goal_ingress": ingress,
            # CORE-009: only set transition_from when the phase actually changes
            "transition_from": (
                (state.get("phase") or "DONE")
                if new_phase != (state.get("phase") or "DONE")
                else new_phase
            ),
            "last_event": wave_event,
            "updated": utc,
            "agent": agent,
        },
    )

    errors = validate_texts(
        new_state, new_board_text, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed goal-entry state fails fast validation: " + "; ".join(errors[:5]),
        )

    targets = [
        *_log_targets(docs, new_log),
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board_text),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    expected = {
        "ok": True,
        "code": "GOAL_SET",
        "event_id": f"E-{wave_event}",
        "objective": safe_objective,
        "demoted": active_ticket,
        "plan_tickets": plan_ids,
        "goal_waves": 1,
        "goal_tickets": 0,
        "goal_ingress": ingress,
    }
    plan = build_plan(
        "goal_entry",
        agent,
        _identity(root),
        {
            "operation": "goal_entry",
            "objective": safe_objective,
            "agent": agent,
            "plan_tickets": plan_ids,
            "goal_ingress": ingress,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        expected,
        op_id=op_id,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


@_state_guard
def set_converge_intent(
    project_root: Path | str,
    agent: str,
    target: str = "done",
    dry_run: bool = False,
    *,
    required_source_intent: str | None = None,
) -> Result:
    """Persist a complete converge-family transition without losing work.

    Active ticket continuation remains exact. With no immediate ticket action,
    crew becomes the outer orchestration action; other converge targets retain
    ordinary continuation semantics.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()

    # ONE frozen snapshot for the whole converge_intent operation (second-wave
    # P0): the authorization/derivation decision and the plan must consume the
    # exact same STATE/BOARD/LOG bytes. No second independent `_read`.
    _docs, before_state, _board, _tail = _read(root)
    source_intent = before_state.get("execution_intent") or "normal"
    if required_source_intent is not None and source_intent != required_source_intent:
        return _refuse(
            "STALE_STATE",
            "execution intent changed before converge entry: "
            f"expected {required_source_intent}, found {source_intent}",
            execution_intent=source_intent,
        )
    entry_ticket = before_state.get("task")
    if entry_ticket in (None, "", "none"):
        entry_ticket = None

    def mutate(text: str, event: int) -> str:
        before = parse_state(text)
        transitioned = transition_execution_intent(text, "converge", target)
        active = (
            before.get("task") not in (None, "", "none")
            and before.get("phase") in phases.TICKET_BEARING_PHASES
        )
        if active:
            next_action = before.get("next_action")
        elif target == "crew":
            next_action = "saipen crew"
        else:
            # CORE-003: entering converge must not DISCARD a valid pick. The
            # literal "saipen continue" that used to be written here erased a
            # freshly persisted route -- an explicit user request projected one
            # command earlier was silently demoted back to "figure it out
            # again later". The shared router owns this answer; converge entry
            # only records the intent.
            next_action = "saipen continue"
            from .router import route_next as _route_next

            _routed = _route_next(transitioned, _docs["board"].text_norm, current_agent=agent)
            if _routed.get("ok") and _routed.get("action"):
                next_action = _routed["action"]
        return patch_state(
            transitioned,
            {
                "next_action": next_action,
                "last_event": event,
                "updated": utc,
                "agent": agent,
            },
        )

    extra_targets = None
    epoch_op_id = None
    if target == "crew":
        # T-1003 carrier-loss wave: the crew epoch is DURABLE project proof,
        # never only a gitignored recovery receipt. The converge_intent op
        # writes a tracked `.saipen/kitchen/crew_epoch.json` in the SAME
        # journaled mutation, so deleting settled recovery receipts cannot
        # erase the epoch (RECOVERY SCRATCH != DURABLE PROJECT MEMORY).
        from .paths import project_lineage_identity

        # CORE-004: establish lineage BEFORE planning the epoch record so the
        # durable carrier carries the same lineage APPLY will create. A dry-run
        # must not touch IDENTITY.md; a real mutation finalizes lineage first.
        if not dry_run:
            from .journal import ensure_project_lineage, LineageRefusal
            from .lock import project_writer_lock

            try:
                with project_writer_lock(root):
                    ensure_project_lineage(root)
            except LineageRefusal as exc:
                return _refuse(
                    exc.code if hasattr(exc, "code") else "VALIDATION_FAILED",
                    f"cannot establish project lineage for crew epoch: {exc}",
                )
        epoch_op_id = "converge_intent-" + uuid4_hex()
        try:
            epoch_doc = codec.read_document(root / ".saipen" / "kitchen" / "crew_epoch.json")
        except OSError:
            epoch_doc = None
        lineage = project_lineage_identity(root) or ""
        epoch_record = {
            "schema_version": 1,
            "operation": "crew_epoch",
            "op_id": epoch_op_id,
            "target": "crew",
            "status": "COMMITTED",
            "created_at": utc,
            "project_lineage": lineage,
        }
        if entry_ticket is not None:
            epoch_record["ticket_id"] = entry_ticket
        epoch_content = json.dumps(epoch_record, indent=2, sort_keys=True) + "\n"
        epoch_target = _target(
            epoch_doc, ".saipen/kitchen/crew_epoch.json", "report", epoch_content
        )
        extra_targets = [epoch_target]
    converge_metadata = {
        "operation": "converge_intent",
        "target": target,
        "status": "COMMITTED",
        "project_identity": _identity(root),
    }
    if entry_ticket is not None:
        converge_metadata["ticket_id"] = entry_ticket
    plan = _state_only_plan(
        root,
        "converge_intent",
        agent,
        mutate,
        f"execution intent -> converge/{target}",
        {
            "ok": True,
            "code": "CONVERGE_SET",
            "execution_intent": "converge",
            "converge_target": target,
        },
        now,
        utc,
        {"execution_intent", "converge_target", "goal_waves", "goal_tickets", "next_action"},
        ticket_id=entry_ticket,
        receipt_metadata=converge_metadata,
        extra_targets=extra_targets,
        op_id=epoch_op_id,
        read_once=(_docs, before_state, _board, _tail),
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


@_state_guard
def enter_ship_convergence(
    project_root: Path | str,
    agent: str,
    dry_run: bool = False,
) -> Result:
    """Atomically enter the special ``ccc`` converge/ship route.

    Unlike the generic converge-intent operation, this transition owns the
    recovery evidence that makes the I -> SHIP -> J boundary derivable after a
    crash: the exact pre-SHIP source revision, refreshed active ownership, and
    the converge state are committed in one journal transaction.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
        )
    guard = _active_claim_refusal(state, docs["board"].text_norm, agent)
    if guard is not None:
        return guard

    try:
        from freshness import compute_source_identity

        identity = compute_source_identity(root)
    except Exception as exc:
        return _refuse(
            "VALIDATION_FAILED",
            f"cannot capture pre-SHIP source identity: {exc}",
        )

    op_id = "ccc-entry-" + uuid4_hex()
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        state.get("task") if state.get("task") not in (None, "", "none") else None,
        agent,
        f"ccc converge target -> ship @{identity.source_head}",
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    transitioned = transition_execution_intent(
        docs["state"].text_norm,
        "converge",
        "ship",
    )
    new_state = patch_state(
        transitioned,
        {
            "next_action": state.get("next_action") or "saipen continue",
            "last_event": event,
            "updated": utc,
            "agent": agent,
        },
    )
    refreshed_board, active_ticket = _refresh_active_claim(
        docs["board"].text_norm,
        state,
        agent,
        utc,
        root=root,
    )
    new_board = refreshed_board or docs["board"].text_norm
    errors = validate_texts(
        new_state,
        new_board,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed ccc entry fails fast validation: " + "; ".join(errors[:5]),
        )

    targets = _log_targets(docs, new_log)
    if refreshed_board is not None:
        targets.append(_target(docs["board"], ".saipen/BOARD.md", "board", new_board))
    targets.append(_target(docs["state"], ".saipen/STATE.md", "state", new_state))

    from .journal import source_identity_dependency

    preconditions = _docs_preconditions(docs, "state", "board", "log")
    preconditions["."] = source_identity_dependency(identity)
    metadata = {
        "operation": "ccc_entry",
        "target": "ship",
        "status": "COMMITTED",
        "source_head": identity.source_head,
        "source_tree_fingerprint": identity.source_tree_fingerprint,
        "project_identity": _identity(root),
        "event_id": f"E-{event}",
    }
    if active_ticket is not None:
        metadata["ticket_id"] = active_ticket
    plan = build_plan(
        "ccc_entry",
        agent,
        _identity(root),
        {
            "operation": "ccc_entry",
            "target": "ship",
            "source_head": identity.source_head,
        },
        preconditions,
        targets,
        {
            "ok": True,
            "code": "CONVERGE_SET",
            "execution_intent": "converge",
            "converge_target": "ship",
            "source_head": identity.source_head,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
        receipt_metadata=metadata,
    )
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


@_state_guard
def finalize_converge_intent(
    project_root: Path | str,
    agent: str,
    target: str,
    evidence: str,
    ticket_id: str | None = None,
    dry_run: bool = False,
    evidence_preconditions: dict[str, str] | None = None,
    receipt_metadata: dict | None = None,
    extra_targets: list[TargetPlan] | None = None,
) -> Result:
    """Close one proven converge target through canonical LOG+STATE mutation."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    # ONE frozen snapshot for the whole finalize operation (second-wave P0).
    _docs, state, _board, _tail = _read(root)
    if state.get("execution_intent") != "converge" or state.get("converge_target") != target:
        return _refuse("VALIDATION_FAILED", f"active converge target is not {target!r}")
    if state.get("phase") != "DONE" or state.get("task") not in (None, "", "none"):
        return _refuse(
            "VALIDATION_FAILED",
            "converge finalization requires local Core phase DONE with task none",
        )

    def mutate(text: str, event: int) -> str:
        transitioned = transition_execution_intent(text, "normal")
        return patch_state(
            transitioned,
            {
                "phase": "DONE",
                "task": "none",
                "next_action": "saipen continue",
                "blocker": "",
                "last_event": event,
                "updated": utc,
                "agent": agent,
            },
        )

    finalize_metadata = receipt_metadata
    if not finalize_metadata:
        finalize_metadata = {
            "operation": f"finalize_{target}",
            "target": target,
            "status": "COMMITTED",
            "project_identity": _identity(root),
        }
        if ticket_id is not None:
            finalize_metadata["ticket_id"] = ticket_id
    plan = _state_only_plan(
        root,
        f"finalize_{target}",
        agent,
        mutate,
        evidence,
        {"ok": True, "code": "CONVERGE_FINALIZED", "target": target},
        now,
        utc,
        {
            "execution_intent",
            "converge_target",
            "goal_waves",
            "goal_tickets",
            "phase",
            "task",
            "next_action",
            "blocker",
        },
        ticket_id=ticket_id,
        evidence_preconditions=evidence_preconditions,
        receipt_metadata=finalize_metadata,
        extra_targets=extra_targets,
        read_once=(_docs, state, _board, _tail),
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _candidate_home_errors(root: Path, state: dict, candidate_home: str) -> list[str]:
    """Closed preconditions for rebinding STATE.saipen_home to a replacement
    SAIPEN install (T-1003 carrier-loss wave).

    Proves BEFORE any write: the candidate is a real directory, its VERSION
    is readable and major-compatible with the project's protocol major, the
    core BOOT layout is present, and the required protocol files exist. No
    disk search, no guessing a home -- the caller names the candidate.
    """
    errors, major = _home_layout_errors(candidate_home)
    if major is not None:
        expected = str(state.get("saipen_version") or 7)
        if major != expected:
            errors.append(
                f"candidate home protocol major {major or 'unreadable'} != "
                f"project saipen_version {expected}; refuse to rebind onto "
                "an incompatible protocol. If the project's declared major is "
                "simply stale -- the home moved generation and the field did "
                "not -- record it first with `saipen recover "
                "--migrate-generation`; a refusal that names no exit strands "
                "the project, because EVERY candidate then fails this same "
                "comparison (T-1352)"
            )
    return errors


def _home_layout_errors(candidate_home: str) -> tuple[list[str], str | None]:
    """Prove a candidate SAIPEN install, WITHOUT judging its generation.

    Returns `(errors, major)`. `major` is None when the layout is so broken
    that no generation could be read from it; otherwise it is the parsed
    major (or `""` when VERSION is present but unreadable), so a caller can
    decide what to do about a generation difference instead of having that
    decision baked in here. `_candidate_home_errors` refuses on a difference;
    `migrate_saipen_generation` is the sanctioned way to record one.
    """
    errors: list[str] = []
    home = Path(candidate_home)
    if not candidate_home or not home.is_dir():
        return [f"candidate home {candidate_home!r} is not a directory"], None
    major: str | None = None
    version_file = home / "VERSION"
    if not version_file.is_file():
        errors.append(f"candidate home {candidate_home!r} has no readable VERSION file")
    else:
        try:
            version_text = version_file.read_text(encoding="utf-8-sig", errors="replace").strip()
        except OSError:
            version_text = ""
        match = re.match(r"v?(\d+)\.", version_text)
        major = match.group(1) if match else ""
    if not ((home / "saipen" / "BOOT.md").is_file() or (home / "BOOT.md").is_file()):
        errors.append(
            f"candidate home {candidate_home!r} has no saipen/BOOT.md (core layout invalid)"
        )
    if not (home / "extensions" / "subs" / "PROTOCOL.md").is_file():
        errors.append(
            f"candidate home {candidate_home!r} lacks "
            "extensions/subs/PROTOCOL.md (required protocol "
            "files)"
        )
    return errors, major


#: Where `normalize_log` preserves the bytes it rewrote.
NORMALIZE_EVIDENCE_ROOT = ".saipen/recovery/log-normalize"


def _normalized_log_lines(log_text: str) -> tuple[list[str], list[str], list[str]]:
    """`(lines, repairs, refusals)` for one active LOG text (T-1356).

    Two bounded repairs, each named, and everything else refuses:

    * a line that parses once a leading ``- `` is restored -- the shape a
      hand-edit or a tool that strips the bullet leaves behind;
    * a line carrying no event id at all -- a free-text note -- which becomes a
      comment, so its bytes survive in place and stop being read as a forged
      event.

    A line that CARRIES an id and still will not parse is not repaired. Its id
    is ledger identity and guessing at the rest would fabricate history, which
    is the one thing a repair for a corrupt ledger must never do.
    """
    from .log import parse_log_line

    lines: list[str] = []
    repairs: list[str] = []
    refusals: list[str] = []
    for lineno, line in enumerate(log_text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#") or parse_log_line(line):
            lines.append(line)
            continue
        bulleted = "- " + line.lstrip()
        if parse_log_line(bulleted):
            lines.append(bulleted)
            repairs.append(f"LOG.md:{lineno} restored the leading bullet")
            continue
        if re.search(r"\[E-\d+\]", line):
            refusals.append(
                f"LOG.md:{lineno} carries an event id and still does not parse; its "
                f"id is ledger identity and the rest cannot be guessed: {line.strip()[:70]!r}"
            )
            lines.append(line)
            continue
        lines.append("# " + line)
        repairs.append(f"LOG.md:{lineno} kept a non-event note as a comment")
    return lines, repairs, refusals


@_state_guard
def normalize_log(project_root: Path | str, agent: str, dry_run: bool = False) -> Result:
    """Make an illegal LOG line legal again, under the writer lock (T-1356).

    Measured live on a bound project: five lines in `.saipen/LOG.md` did not
    match `LOG_RE` -- three had lost their leading ``- `` and two were free-text
    notes -- and from then on `fast_check` put them on every mutation's error
    list, so SAIOPS refused before the journal was ever PREPARED. `saipen
    recover` was admitted and returned a sanctioned plan; applying it failed on
    those same five lines and wrote zero bytes. No canonical verb rewrote a LOG
    line, and a direct edit of `.saipen/LOG.md` is terminally refused by the
    guard, so the ONE sanctioned mutation could never succeed while the LOG was
    malformed. Reads, globs and greps worked; nothing else did, forever.

    This is the exit. It repairs SYNTAX and nothing else: the two shapes above,
    with the original bytes preserved beside the journal as evidence, and a
    refusal that names the line whenever the repair is not provable. A ledger
    defect that is not line syntax -- a duplicate id, an out-of-order event, a
    broken parent edge -- is refused by the ordinary read and stays refused.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    read_once = _read(root, observe=("log",))
    docs, state, _board, _tail = read_once
    original = docs["log"].text_norm
    lines, repairs, refusals = _normalized_log_lines(original)
    if refusals:
        return _refuse(
            "CONFLICT",
            "LOG normalization refuses to guess: " + "; ".join(refusals[:4]),
        )
    if not repairs:
        return _refuse(
            "VALIDATION_FAILED",
            "every line in .saipen/LOG.md is already a legal event, a comment or blank",
        )
    normalized = "\n".join(lines).rstrip("\n") + "\n"
    # The repair's own DEC must be allocated above the NORMALIZED tail. A
    # bulletless line is invisible to the parser, so its id does not count
    # toward the pre-repair tail; restoring the bullet brings the id back and a
    # DEC allocated from the old tail collides with it. That refused the repair
    # with `duplicate event id` -- the same deadlock, one line deep.
    docs, state, board, log_tail = read_once
    from .log import parse_log_line as _parse

    revealed = [_parse(line) for line in normalized.splitlines()]
    tail = max(
        [log_tail or 0] + [parsed["event"] for parsed in revealed if parsed]
    )
    read_once = (docs, state, board, tail)
    op_id = "normalize-log-" + uuid4_hex()
    evidence = f"{NORMALIZE_EVIDENCE_ROOT}/{op_id}/LOG.md"
    preserved_bytes = docs["log"].encode(original)
    preserved = TargetPlan(
        evidence, "generic", preserved_bytes, "", hash_bytes(preserved_bytes)
    )
    task = state.get("task")

    def mutate(text: str, event: int) -> str:
        return patch_state(text, {"last_event": event, "updated": utc, "agent": agent})

    plan = _state_only_plan(
            root,
            "normalize_log",
            agent,
            mutate,
            f"LOG normalized: {len(repairs)} line(s) repaired -- "
            + "; ".join(repairs[:4])
            + f". Original bytes preserved at {evidence}",
            {
                "ok": True,
                "code": "LOG_NORMALIZED",
                "repairs": repairs,
                "evidence_path": evidence,
            },
            now,
            utc,
            {"last_event", "updated", "agent"},
            ticket_id=task if isinstance(task, str) and task.startswith("T-") else None,
            extra_targets=[preserved],
            op_id=op_id,
            read_once=read_once,
            log_text=normalized,
            repair=True,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


@_state_guard
def migrate_saipen_generation(
    project_root: Path | str, agent: str, dry_run: bool = False
) -> Result:
    """Record that this project's state belongs to its home's generation.

    T-1352. `saipen_version` is the protocol MAJOR the state was written
    against, and nothing in the engine could ever move it. That was survivable
    while it only produced a validator warning, and it is not a warning: a
    project whose declared major has fallen behind every home that exists can
    never rebind, because `_candidate_home_errors` refuses every candidate on
    that same comparison, and the only escape left is editing a protected
    canonical file by hand -- which the guard correctly forbids. A guard whose
    refusal has no exit is a dead end, so this is the exit.

    It RECORDS, it does not upgrade: no state is rewritten into another
    generation's shape, because the engine has been applying the home's rules
    to this state all along (that is exactly what the warning says). What
    changes is one field and the LOG line that says which generation it left
    and which it joined. The home is PROVEN first -- readable VERSION, core
    BOOT layout, required protocol files -- so the recorded major is never a
    guess, and an equal major refuses rather than writing a no-op.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    # Same allowance as `rebind_saipen_home`: the pointer this reads may be
    # exactly what is stale, and proving the home is this operation's job.
    _docs, state, _board, _tail = _read(root, allow_dead_home=True)
    home = str(state.get("saipen_home") or "").strip()
    if not home:
        return _refuse(
            "HOME_REQUIRED",
            "STATE.saipen_home is unset, so there is no proven generation to record",
            next_action="saipen rebind-home --auto",
        )
    errors, major = _home_layout_errors(home)
    if errors or not major:
        return _refuse(
            "HOME_REQUIRED",
            "cannot read a generation from the bound home: "
            + ("; ".join(errors[:4]) if errors else f"VERSION in {home!r} is unreadable"),
            next_action="saipen rebind-home --auto",
        )
    declared = str(state.get("saipen_version") or 7)
    if major == declared:
        return _refuse(
            "VALIDATION_FAILED",
            f"STATE.saipen_version is already {declared} and the bound home is at "
            f"major {major}; nothing to record",
        )
    task = state.get("task")

    def mutate(text: str, event: int) -> str:
        return patch_state(
            text,
            {
                "saipen_version": int(major),
                "last_event": event,
                "updated": utc,
                "agent": agent,
            },
        )

    plan = _state_only_plan(
        root,
        "migrate_generation",
        agent,
        mutate,
        f"saipen_version recorded {declared} -> {major} from the proven home {home}",
        {
            "ok": True,
            "code": "GENERATION_RECORDED",
            "saipen_version": int(major),
            "previous_saipen_version": int(declared) if declared.isdigit() else declared,
            "saipen_home": home,
        },
        now,
        utc,
        {"saipen_version", "last_event", "updated", "agent"},
        ticket_id=task if task not in (None, "", "none") else None,
        allow_dead_home=True,
        read_once=(_docs, state, _board, _tail),
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _commit_rebound_home(
    root: Path,
    agent: str,
    resolved_home: str,
    read_once: tuple[dict, dict, dict, dict],
    *,
    code: str,
    detail: str,
    extra: dict | None = None,
    dry_run: bool = False,
) -> Result:
    """Journal ONE STATE-only home-pointer update (the rebind body).

    Shared by the explicit `rebind_saipen_home` and the automatic
    `rebind_home_auto`: both write exactly `saipen_home`, `last_event`,
    `updated` and `agent`, both preserve phase/task/BOARD, and both carry the
    same LOG evidence shape. Only the result code and detail differ, so a
    consumer can tell an operator-directed rebind from an automatic
    convergence without guessing.
    """
    _docs, state, _board, _tail = read_once
    now, utc = _now(), _utc_iso()
    task = state.get("task")

    def mutate(text: str, event: int) -> str:
        return patch_state(
            text,
            {
                "saipen_home": resolved_home,
                "last_event": event,
                "updated": utc,
                "agent": agent,
            },
        )

    payload: dict = {"ok": True, "code": code, "saipen_home": resolved_home}
    if extra:
        payload.update(extra)
    plan = _state_only_plan(
        root,
        "rebind_home",
        agent,
        mutate,
        detail,
        payload,
        now,
        utc,
        {"saipen_home", "last_event", "updated", "agent"},
        ticket_id=task if task not in (None, "", "none") else None,
        allow_dead_home=True,
        read_once=read_once,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def rebind_home_auto(
    project_root: Path | str,
    agent: str,
    dry_run: bool = False,
    *,
    engine_root: Path | str | None = None,
) -> Result:
    """Converge a DEAD persisted home onto an already-PROVEN canonical runtime.

    The zero-manual repair for the contradiction this operation exists to end
    (T-1425 REPAIR 1): bootstrap proves a canonical runtime (the executing
    engine, a verified installed carrier, a verified canonical bridge), the
    persisted `STATE.saipen_home` names a previous host/OS and does not resolve
    here, and admission refuses `HOME_REQUIRED`. Operator-directed
    `rebind-home <candidate>` already repaired that, but required the human to
    type a path SAIPEN had already proven.

    Semantics, one deterministic rule:

        dead persisted home + no proven replacement  -> HOME_REQUIRED (refuse)
        dead persisted home + proven replacement     -> journal the pointer
                                                        (HOST_BINDING_CONVERGED)
        live persisted home                          -> HOME_ALREADY_BOUND,
                                                        zero writes (idempotent)

    Candidates come only from `host_bootstrap.replacement_candidates` (SAIPEN-
    controlled sources, never a disk scan), and each one is proved with the
    SAME `_candidate_home_errors` the explicit rebind uses (readable VERSION,
    compatible major, core BOOT layout, required protocol files). No candidate
    is adopted on discovery alone. `engine_root` is a fixture-only override that
    models a host whose executing engine is not a usable install.
    """
    from . import host_bootstrap
    from .state import persisted_home_error

    root = Path(project_root)
    read_once = _read(root, allow_dead_home=True)
    _docs, state, _board, _tail = read_once

    current_home = str(state.get("saipen_home") or "").strip()
    current_problem = persisted_home_error(state.get("saipen_home"))
    if current_home and current_problem is None:
        return Result(
            ok=True,
            code="HOME_ALREADY_BOUND",
            data={
                "saipen_home": current_home,
                "changed": False,
                "detail": (
                    "STATE.saipen_home already resolves to a usable SAIPEN "
                    "install on this host; no convergence was needed"
                ),
            },
        )

    tried: list[dict] = []
    for candidate in host_bootstrap.replacement_candidates(
        root, engine_root=engine_root
    ):
        raw = str(candidate.get("path") or "")
        try:
            resolved = Path(raw).expanduser().resolve().as_posix()
        except Exception:  # pragma: no cover - defensive: unrepresentable path
            resolved = raw
        record = {"source": candidate.get("source"), "path": resolved, "ok": False}
        if not raw or resolved == current_home:
            record["why"] = "candidate is the dead persisted pointer itself"
            tried.append(record)
            continue
        errors = _candidate_home_errors(root, state, resolved)
        if errors:
            record["why"] = "; ".join(errors[:2])
            tried.append(record)
            continue
        record["ok"] = True
        tried.append(record)
        return _commit_rebound_home(
            root,
            agent,
            resolved,
            read_once,
            code="HOST_BINDING_CONVERGED",
            detail=(
                f"saipen_home automatically converged to the proven canonical "
                f"runtime {resolved} (source: {candidate.get('source')}); "
                f"previous pointer: {current_home or 'unset'}"
            ),
            extra={
                "auto": True,
                "previous_home": current_home or None,
                "runtime_source": candidate.get("source"),
                "candidates": tried,
            },
            dry_run=dry_run,
        )

    return _refuse(
        "HOME_REQUIRED",
        "no proven canonical replacement is reachable for the dead "
        f"STATE.saipen_home {current_home or '(unset)'!r}; attempted: "
        + "; ".join(
            f"{row.get('source')}={row.get('why')}" for row in tried
        )[:400],
        next_action="saipen rebind-home <candidate-home-path>",
    )


def rebind_saipen_home(
    project_root: Path | str, agent: str, candidate_home: str, dry_run: bool = False
) -> Result:
    """Rebind STATE.saipen_home to a VERIFIED replacement SAIPEN install.

    This is the ONE explicit recovery path for a dead bootloader pointer
    (T-1003 carrier-loss wave): the caller names a candidate home, this
    operation proves it (readable VERSION, compatible major, BOOT layout,
    required protocol files), then journals ONE narrowly-owned STATE pointer
    update -- phase/task/board untouched -- with truthful LOG evidence. The
    version guard resumes normally afterwards; sub sync/adopt then handle
    role copies against the new home.
    """
    root = Path(project_root)
    try:
        resolved_home = Path(candidate_home).expanduser().resolve().as_posix()
    except Exception:
        resolved_home = candidate_home
    # The ONE reader allowed to load a checkpoint whose persisted pointer is
    # already dead (P0#3): repairing exactly that pointer is this operation's
    # purpose, and the replacement is proved by `_candidate_home_errors` below.
    # ONE frozen snapshot for the whole rebind operation (second-wave P0).
    read_once = _read(root, allow_dead_home=True)
    _docs, state, _board, _tail = read_once
    errors = _candidate_home_errors(root, state, resolved_home)
    if errors:
        return _refuse(
            "HOME_REQUIRED",
            "cannot rebind onto the candidate home: " + "; ".join(errors[:4]),
            next_action="name a valid SAIPEN install path",
        )
    if state.get("saipen_home") == resolved_home:
        return _refuse(
            "VALIDATION_FAILED",
            f"STATE.saipen_home already points at {resolved_home!r}; nothing to rebind",
        )
    return _commit_rebound_home(
        root,
        agent,
        resolved_home,
        read_once,
        code="HOME_REBOUND",
        detail=f"saipen_home rebound to {resolved_home}",
        dry_run=dry_run,
    )


@_state_guard
def handover_agent(
    project_root: Path | str,
    new_agent: str,
    dry_run: bool = False,
    allow_dead_home: bool = False,
    explicit: bool = False,
    now: datetime.datetime | None = None,
) -> Result:
    """The ONE explicit agent-handover operation (T-1006).

    CORE.md section 1.4 and BOOT.md: the seat is inherited from STATE.agent,
    and it changes only for a genuinely different actor -- and when it does,
    the agent MUST log a DEC naming the old value and the new one so the
    graph shows a handover rather than an unexplained stranger. This operation
    journals exactly that single DEC plus the STATE.agent owned-field patch
    (LOG first, STATE last), so an explicit `--agent <id>` override can never
    overwrite STATE.agent silently before the handover is recorded.

    Second-wave W2-002: a handover is only ever SAFE when STATE.agent stays
    bound to the live active BOARD claim. If a ## DOING ticket is actively
    claimed, the handover transfers that exact claim to the new seat in the
    SAME LOG->BOARD->STATE transaction (refreshed claim_time + explicit
    handover DEC). A FOREIGN_LIVE or INVALID active claim cannot be silently
    stolen or stranded, so the handover REFUSES (zero writes, byte-identical
    to the pre-command checkpoint) and requires the active ticket to be
    checkpointed/demoted/repaired first. Fail closed: STATE.agent must never
    diverge from the only live active claim.

    A no-op refusal (VALIDATION_FAILED) is returned when the requested agent
    already IS the persisted seat -- nothing to record, no write. `dry_run`
    renders the same plan with ZERO writes.

    `now` pins the ONE frozen operation instant (deterministic evaluation, CORE
    -001 REVIEW repair): the claim classification, the transferred claim_time
    and the LOG event timestamp are all derived from it. Unset means the
    wall clock is read exactly ONCE here -- never again inside the decision.
    """
    root = Path(project_root)
    clock = _operation_clock(now)
    now, utc = clock.now, clock.utc
    # ONE frozen snapshot for the whole handover (second-wave P0 discipline).
    docs, state, board, log_tail = _read(root, allow_dead_home=allow_dead_home)
    old = state.get("agent")
    if old == new_agent:
        # A handover to the CURRENT seat is a no-op, not a write: refuse with
        # the closed OPS.md validation code rather than inventing a new one.
        return _refuse(
            "VALIDATION_FAILED",
            f"agent is already {new_agent!r}; nothing to hand over",
            agent=new_agent,
        )
    old_label = old or "(none)"
    op_id = "handover-" + uuid4_hex()

    # --- W2-002: active-claim awareness -----------------------------------
    # Find the live active DOING claim (if any) and decide transfer vs refuse.
    board_text = docs["board"].text_norm
    tickets = board["tickets"]
    active_id = state.get("task")
    if not active_id or active_id == "none":
        # Fall back to a lone DOING ticket when STATE.task is not set.
        doing = [t["id"] for t in tickets.values() if t["section"] == "## DOING"]
        active_id = doing[0] if doing else None
    active_ticket = tickets.get(active_id) if active_id else None
    new_board_text = board_text
    claim_transferred = None
    if active_ticket is not None and active_ticket.get("section") == "## DOING":
        # CORE-001 CONTROL D: classify through the ONE shared ownership
        # authority relative to the INCOMING seat, which is the identity
        # actually requesting the transfer. Judging against the OUTGOING seat
        # made every live claim read SELF, so a bare `--agent <other>` silently
        # took over another agent's live claim -- the takeover this refusal
        # exists to stop. An operator-authorized transfer says so with
        # `explicit=True` (CONTROL C). The classification and the claim_time
        # written below come from ONE frozen operation instant: a second live
        # clock read here is what let a fixed fixture change verdict between
        # two runs of identical committed code (SRC-026 REVIEW repair).
        own = ownership.classify_active_ownership(state, tickets, new_agent, now=clock.instant)
        cs = own.status
        if cs == ownership.FOREIGN_LIVE and explicit:
            cs = ownership.SELF
        if cs in (ownership.SELF, ownership.UNCLAIMED, ownership.FOREIGN_STALE):
            # The outgoing seat owns the live active ticket (or it is unclaimed /
            # lapsed) -- transfer the EXACT claim to the new seat atomically so
            # STATE.agent and the only live active claim never diverge.
            new_board_text = _claim_fields_in_place(
                board_text, active_id, {"owner": new_agent, "claim_time": utc},
                session_binding=host_session_binding(root),
            )
            claim_transferred = active_id
        elif cs == ownership.FOREIGN_LIVE:
            return _refuse(
                "ACTIVE_CLAIM_FOREIGN",
                f"active {active_id} is live-claimed by another agent "
                f"({active_ticket['fields'].get('owner', '')!r}); checkpoint/"
                f"demote it before handing the seat over",
                ticket=active_id,
            )
        else:  # INVALID: half owner/claim_time pair or non-UTC stamp
            return _refuse(
                "VALIDATION_FAILED",
                f"active {active_id} carries an INVALID claim (half "
                f"owner/claim_time pair or non-UTC stamp); repair before "
                f"handing the seat over",
                ticket=active_id,
            )

    # --- LOG: handover DEC (names old -> new, records any claim transfer) ---
    pivot_msg = f"agent handover {old_label} -> {new_agent}"
    if claim_transferred:
        pivot_msg += f" (active {claim_transferred} claim transferred)"
    pivot_event, pivot_line = _event_line(
        docs, log_tail, "DEC", claim_transferred, new_agent, pivot_msg, now, op_id
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + pivot_line + "\n"

    # --- STATE: seat change ONLY (no phase/task/next_action touch) ---------
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "agent": new_agent,
            "last_event": pivot_event,
            "updated": utc,
        },
    )

    # Validate against the NEW board text so the claim transfer is checked,
    # not the stale pre-handover board (a pre-write would otherwise flag a
    # spurious binding-mismatch and refuse a valid handover).
    errors = validate_texts(
        new_state, new_board_text, new_log, current_agent=new_agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed handover fails fast validation: " + "; ".join(errors[:5]),
        )

    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    if claim_transferred:
        targets.append(_target(docs["board"], ".saipen/BOARD.md", "board", new_board_text))
    plan = build_plan(
        "handover",
        new_agent,
        _identity(root),
        {
            "operation": "handover",
            "agent": new_agent,
            "previous_agent": old_label,
            "claim_transferred": claim_transferred,
        },
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "HANDOVERED",
            "agent": new_agent,
            "previous_agent": old_label,
            "claim_transferred": claim_transferred,
            "event_id": f"E-{pivot_event}",
        },
        op_id=op_id,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


GOAL_WAVE_CAP = 3
GOAL_TICKET_CAP = 20


@_state_guard
def reauthorize_valve(project_root: Path | str, agent: str, dry_run: bool = False) -> Result:
    """Conditional safety-valve reauthorization: reset BOTH counters to 0 only
    when a counter has tripped its cap. Never grants a fresh budget on a run
    that did not trip the valve."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    # ONE frozen snapshot for the whole valve operation (second-wave P0).
    _docs, state, _board, _log_tail = _read(root)
    waves = state.get("goal_waves") or 0
    tickets = state.get("goal_tickets") or 0
    if not (state.get("execution_intent") == "goal" and (waves >= 3 or tickets >= 20)):
        return _refuse(
            "VALIDATION_FAILED",
            "valve has not tripped; no fresh budget is owed",
            goal_waves=waves,
            goal_tickets=tickets,
        )

    def mutate(text: str, event: int) -> str:
        return patch_state(
            text,
            {
                "goal_waves": 0,
                "goal_tickets": 0,
                # The persisted safety-valve WAIT describes the pre-reset
                # authorization state. Keeping it after reauthorization
                # would make route_next bind the stale brake and deadlock the
                # command that just cleared the valve.
                "next_action": "saipen continue",
                "last_event": event,
                "updated": utc,
                "agent": agent,
            },
        )

    plan = _state_only_plan(
        root,
        "valve",
        agent,
        mutate,
        f"goal reauthorized -- goal_waves {waves}->0, goal_tickets {tickets}->0",
        {"ok": True, "code": "VALVE_REAUTHORIZED"},
        now,
        utc,
        {"goal_waves", "goal_tickets", "next_action"},
        read_once=(_docs, state, _board, _log_tail),
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


@_state_guard
def stop_checkpoint(
    project_root: Path | str, agent: str, reason: str = "", dry_run: bool = False
) -> Result:
    """The brake: checkpoint the exact current execution with a resumable
    next_action. Never resets phase; never changes intent or counters. The
    human digest is a PLAN TARGET (NITRO dogfood II): it commits inside the
    same journaled transaction as LOG/STATE, so a stop can never report
    STOPPED with a missing/stale digest."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    docs, state, board, log_tail = _read(root)
    task = state.get("task")
    phase = state.get("phase")
    # CORE-002: the brake uses the same active-claim authority rules as every
    # other transition/checkpoint. A live FOREIGN BOARD owner must not be
    # split from STATE.agent by a stop that claims to checkpoint this session
    # -- refuse zero writes and let adoption happen explicitly.
    guard = _active_claim_refusal(state, docs["board"].text_norm, agent)
    if guard is not None:
        return guard
    # Preserve an already-legal hard WAIT byte-for-byte (hostile-regression,
    # P1#2): `saipen stop` must never erase a legitimate WAIT (safety valve,
    # user brake, markhunt brake, ...) -- only synthesize a resumable action
    # when no legal WAIT is currently set. When no legal WAIT exists and the
    # goal safety valve is tripped, the resumable action IS the valve's WAIT
    # (MAINTENANCE § 2.4): a routine continuation must never disguise an
    # exhausted goal loop. Counters and intent stay untouched.
    _current_na = state.get("next_action")
    if is_legal_wait(_current_na):
        na = _current_na
    elif state.get("execution_intent") == "goal" and (
        int(state.get("goal_waves") or 0) >= GOAL_WAVE_CAP
        or int(state.get("goal_tickets") or 0) >= GOAL_TICKET_CAP
    ):
        na = (
            f"WAIT: safety valve reached ({state.get('goal_waves') or 0} waves / "
            f"{state.get('goal_tickets') or 0} tickets) -- run 'cc' to continue"
        )
    else:
        na = f"PHASE {phase} {task}" if task and task != "none" else "saipen continue"

    op_id = "stop-" + uuid4_hex()
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        None,
        agent,
        f"stop checkpoint{': ' + reason if reason else ''}",
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "next_action": na,
            "last_event": event,
            "updated": utc,
            "agent": agent,
        },
    )
    # CORE-002: a SELF-owned active ticket gets its claim lease refreshed and
    # BOARD joins the journaled mutation so ownership stays coherent with
    # STATE.agent after the stop. Target order LOG -> BOARD -> STATE.
    refreshed_board, _active = _refresh_active_claim(
        docs["board"].text_norm, state, agent, utc, root=root
    )
    new_board = refreshed_board if refreshed_board is not None else docs["board"].text_norm
    errors = validate_texts(
        new_state,
        new_board,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED", "proposed state fails fast validation: " + "; ".join(errors[:5])
        )
    # CORE-002: digest remaining/awaiting derive from the parsed BOARD active
    # ticket (its blocker) and the resumable next action, not a generic task
    # echo that ignores the board value.
    active_ticket = board["tickets"].get(task or "")
    blocker = ""
    if active_ticket is not None:
        blocker = (active_ticket.get("fields", {}).get("blocker") or "").strip()
    remaining = task or blocker or "see BOARD"
    awaiting = na if is_legal_wait(na) else (reason or "nothing")
    digest_content = (
        f"done: stopped via SAIOPS checkpoint\nremaining: {remaining}\nawaiting: {awaiting}\n"
    )
    digest_lines = digest_content.rstrip("\n").splitlines()
    targets = [
        *_log_targets(docs, new_log),
    ]
    if refreshed_board is not None:
        targets.append(_target(docs["board"], ".saipen/BOARD.md", "board", new_board))
    targets.append(_target(docs["state"], ".saipen/STATE.md", "state", new_state))
    digest_doc = codec.read_document(root / ".saipen" / "kitchen" / "digest.md")
    targets.append(
        TargetPlan(
            ".saipen/kitchen/digest.md",
            "report",
            digest_doc.encode(digest_content),
            _live_before(root, ".saipen/kitchen/digest.md", digest_doc),
            hash_bytes(digest_doc.encode(digest_content)),
        )
    )
    plan = build_plan(
        "stop",
        agent,
        _identity(root),
        {"operation": "stop", "reason": reason},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "STOPPED",
            "next_action": na,
            "digest": str(root / ".saipen" / "kitchen" / "digest.md"),
            "digest_lines": digest_lines,
        },
        op_id=op_id,
    )
    if dry_run:
        result = _render_plan(plan)
        result.data["digest"] = str(root / ".saipen" / "kitchen" / "digest.md")
        result.data["digest_lines"] = digest_lines
        return result
    return apply_plan(root, plan)


# ------------------------------------------------------- release scope (T-994)

RELEASE_SCOPE_DIR = ".saipen/kitchen/release_scope"


def release_scope_hash(raw: bytes) -> str:
    """Full content identity for new reviewed scopes; journal tokens stay unchanged."""
    import hashlib
    return hashlib.sha256(raw).hexdigest()


def release_scope_matches(raw: bytes, expected) -> bool:
    """Read v2 exact identities and explicit historical v1 truncated tokens."""
    if not isinstance(expected, str) or not re.fullmatch(
        r"(?:[0-9a-f]{16}|[0-9a-f]{64})", expected
    ):
        return False
    return release_scope_hash(raw)[:len(expected)] == expected


def _plan_record_scope(
    root: Path, ticket_id: str, agent: str, paths: list[str], now: str, utc: str
) -> OperationPlan | Result:
    """PLAN the exact reviewed release scope for a ticket (T-994 / § 2).

    The scope is the model's EXACT reviewed file list -- never inferred from
    dirty files, never `git add .`. It is bound to the ticket, the project
    identity and the source identity (HEAD + per-path content hashes), so the
    release planner can prove the bytes about to ship are the bytes that were
    reviewed. The record lives under `.saipen/kitchen/release_scope/` and is
    journaled through SAIOPS like any other canonical mutation.
    """
    op_id = "scope-" + uuid4_hex()
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=ticket_id,
        )
    phase = state.get("phase")
    if phase not in ("REVIEW", "SHIP"):
        return _refuse(
            "ILLEGAL_PHASE",
            f"release scope may be recorded at REVIEW -> SHIP; actual phase "
            f"{phase} cannot name the reviewed scope for a release",
            ticket=ticket_id,
            phase=phase,
        )
    if state.get("task") != ticket_id:
        return _refuse(
            "ACTIVE_TICKET_MISMATCH",
            f"STATE.task={state.get('task')} != scope ticket {ticket_id}",
            ticket=ticket_id,
        )
    tickets = board["tickets"]
    ticket = tickets.get(ticket_id)
    if ticket is None or ticket["section"] != "## DOING":
        return _refuse(
            "TICKET_NOT_FOUND", f"{ticket_id} is not the active ## DOING ticket", ticket=ticket_id
        )
    clean: list[str] = []
    root_resolved = root.resolve()
    for raw in paths:
        candidate = (root / raw).resolve()
        try:
            rel_path = candidate.relative_to(root_resolved)
        except ValueError:
            return _refuse("PATH_ESCAPE", f"scope path escapes project root: {raw}")
        if rel_path.as_posix() == ".":
            return _refuse("PATH_ESCAPE", "scope path cannot be the project root itself")
        clean.append(rel_path.as_posix())
    clean = sorted(set(clean))
    if not clean:
        return _refuse(
            "SOURCE_SCOPE_MISSING",
            "release scope cannot be empty; name the exact reviewed files",
            ticket=ticket_id,
        )
    try:
        from freshness import compute_source_identity

        ident = compute_source_identity(root)
    except Exception as exc:
        return _refuse(
            "VALIDATION_FAILED", f"cannot compute source identity for scope binding: {exc}"
        )
    hashes: dict[str, object] = {}
    for rel in clean:
        fp = root / rel
        if fp.is_file():
            hashes[rel] = release_scope_hash(fp.read_bytes())
        elif not fp.exists():
            # Deletion intent (T-994 / § 2): a reviewed removal is a scope
            # path too -- recorded as JSON null so APPLY stages `git add -u`
            # instead of failing the missing file. Only a TRACKED path can be
            # a legal deletion; an untracked missing path is a mistake.
            import subprocess

            tracked = subprocess.run(
                ["git", "-C", str(root), "ls-files", "--error-unmatch", "--", rel],
                capture_output=True,
                check=False,
            )
            if tracked.returncode != 0:
                return _refuse(
                    "SOURCE_SCOPE_MISSING",
                    f"scope path {rel} does not exist and is not tracked -- "
                    "a deletion scope must name a tracked file",
                    ticket=ticket_id,
                )
            hashes[rel] = None
        else:
            return _refuse(
                "SOURCE_SCOPE_MISSING", f"scope path {rel} is not a regular file", ticket=ticket_id
            )
    import json
    from .paths import project_lineage_identity

    record = {
        "schema_version": 2,
        "ticket": ticket_id,
        "project_identity": _identity(root),
        "project_lineage": project_lineage_identity(root),
        "source_head": ident.source_head,
        "source_tree_fingerprint": ident.source_tree_fingerprint,
        "paths": hashes,
        "recorded_at": utc,
        "op_id": op_id,
    }
    content = json.dumps(record, indent=2, sort_keys=True) + "\n"

    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        ticket_id,
        agent,
        f"release scope recorded -- {len(clean)} path(s) bound to {ident.source_head[:12]}",
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    owned = {"last_event": event, "updated": utc, "agent": agent}
    new_state = patch_state(docs["state"].text_norm, owned)

    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed scope state fails fast validation: " + "; ".join(errors[:5]),
        )

    scope_rel = f"{RELEASE_SCOPE_DIR}/{ticket_id}.json"
    scope_doc = codec.read_document(root / scope_rel)
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
        TargetPlan(
            scope_rel,
            "report",
            scope_doc.encode(content),
            scope_doc.raw_hash,
            hash_bytes(scope_doc.encode(content)),
        ),
    ]
    from .journal import source_identity_dependency

    preconditions = _docs_preconditions(docs, "state", "board", "log")
    preconditions["."] = source_identity_dependency(ident)
    return build_plan(
        "scope",
        agent,
        _identity(root),
        {"operation": "scope", "ticket": ticket_id, "paths": clean},
        preconditions,
        targets,
        {
            "ok": True,
            "code": "SCOPE_RECORDED",
            "ticket": ticket_id,
            "paths": clean,
            "event_id": f"E-{event}",
            "scope": scope_rel,
        },
        op_id=op_id,
    )


@_state_guard
def record_scope(
    project_root: Path | str, ticket_id: str, agent: str, paths: list[str], dry_run: bool = False
) -> Result:
    """Journal the exact reviewed release scope for a ticket (T-994 / § 2)."""
    root = Path(project_root)
    # CORE-004: a real mutation finalizes lineage BEFORE planning so the
    # persisted scope binds the same lineage APPLY will use -- a first-ever
    # scope on an unmigrated project must stay portable after a move. Dry-run
    # stays zero-write and models the planned lineage through the empty string.
    if not dry_run:
        from .journal import ensure_project_lineage, LineageRefusal
        from .lock import project_writer_lock

        try:
            with project_writer_lock(root):
                ensure_project_lineage(root)
        except LineageRefusal as exc:
            return _refuse(
                exc.code if hasattr(exc, "code") else "VALIDATION_FAILED",
                f"cannot establish project lineage for release scope: {exc}",
            )
    now, utc = _now(), _utc_iso()
    plan = _plan_record_scope(root, ticket_id, agent, paths, now, utc)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _improve_gate_plan(
    root: Path,
    agent: str,
    *,
    gate: str | None,
    reason: str,
    dry_run: bool,
) -> Result | OperationPlan:
    """Shared PLAN body for hold (gate set) and unhold (gate None)."""
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED", "BOARD parse error(s): " + "; ".join(board["errors"][:3])
        )
    current = str(state.get("improve_gate") or "").strip()
    if gate is not None and current == gate:
        return Result(
            True,
            "IMPROVE_GATE_ALREADY_SET",
            message=f"automatic improvement discovery is already held until {gate} resolves",
            data={"improve_gate": gate},
        )
    if gate is None and not current:
        return Result(
            True,
            "IMPROVE_GATE_NONE",
            message="no improve hold is set; automatic improvement discovery is not constrained",
        )
    now, utc = _now(), _utc_iso()
    op_id = ("improve-hold-" if gate is not None else "improve-unhold-") + uuid4_hex()
    if gate is not None:
        text = f"improve discovery held until {gate} resolves"
        if reason:
            text += f" -- {reason[:200]}"
        code = "IMPROVE_GATE_SET"
        owned = {"improve_gate": gate, "last_event": None, "updated": utc, "agent": agent}
        ticket = gate
    else:
        text = f"improve hold cleared (was {current})"
        code = "IMPROVE_GATE_CLEARED"
        owned = {"last_event": None, "updated": utc, "agent": agent}
        ticket = current
    event, line = _event_line(docs, log_tail, "DEC", ticket, agent, text, now, op_id)
    owned["last_event"] = event
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    if gate is not None:
        new_state = patch_state(docs["state"].text_norm, owned)
    else:
        stripped = remove_state_fields(docs["state"].text_norm, ["improve_gate"])
        new_state = patch_state(stripped, owned)
    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed improve-gate state fails fast validation: " + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    if dry_run:
        return build_plan(
            "improve_hold" if gate is not None else "improve_unhold",
            agent,
            _identity(root),
            {"operation": "improve_hold", "gate": gate},
            _docs_preconditions(docs, "state", "board", "log"),
            [],
            {
                "ok": True,
                "code": "PLAN",
                "operation": "improve_hold",
                "dry_run": True,
                "improve_gate": gate or None,
            },
            op_id=op_id,
        )
    return build_plan(
        "improve_hold" if gate is not None else "improve_unhold",
        agent,
        _identity(root),
        {"operation": "improve_hold", "gate": gate, "reason": reason},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": code,
            "improve_gate": gate or None,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
    )


@_state_guard
def hold_improve(
    project_root: Path | str,
    agent: str,
    gate_ticket: str,
    *,
    reason: str = "",
    dry_run: bool = False,
) -> Result:
    """Persist the typed no-improve-before-gate constraint (T-1415).

    The operator's temporary policy -- do not start another Improve cycle
    before THIS gate resolves -- becomes `STATE.improve_gate` instead of prose
    a later router greps for. While the field names an unresolved ticket, the
    router surfaces that gate and the automatic `continue -> improve`
    fallthrough cannot fire. Cleared by `release_improve`, or deterministically
    by reconciliation the moment the named ticket resolves.
    """
    root = Path(project_root)
    gate = str(gate_ticket or "").strip().upper()
    if not re.fullmatch(r"T-\d+", gate):
        return _refuse(
            "VALIDATION_FAILED",
            f"improve hold needs a T-### gate ticket, got {gate_ticket!r}",
        )
    _docs, _state, board, _tail = _read(root)
    if not board["errors"]:
        ticket = board["tickets"].get(gate)
        if ticket is None:
            return _refuse(
                "TICKET_NOT_FOUND", f"improve gate {gate} is on no BOARD section", ticket=gate
            )
        if ticket["section"] == "## DONE":
            return _refuse(
                "TICKET_ALREADY_DONE",
                f"improve gate {gate} is already DONE; there is no unresolved gate to hold",
                ticket=gate,
            )
    plan = _improve_gate_plan(root, agent, gate=gate, reason=reason, dry_run=dry_run)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


@_state_guard
def release_improve(project_root: Path | str, agent: str, dry_run: bool = False) -> Result:
    """Clear the typed no-improve-before-gate constraint (T-1415)."""
    root = Path(project_root)
    plan = _improve_gate_plan(root, agent, gate=None, reason="", dry_run=dry_run)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


# ------------------------------------------- first-publish wait (T-994 / § 11)


def _sanitize_remote(url: str) -> str:
    """Endpoint identity without credentials, normalized so `file://V:\\x`
    and `file://V:/x` are the same endpoint (T-994 / § 11)."""
    url = url.strip()
    if "://" in url:
        scheme, rest = url.split("://", 1)
        rest = rest.split("@", 1)[-1]
        return f"{scheme}://{rest.replace(chr(92), '/')}"
    if "@" in url:
        return url.split("@", 1)[-1].replace(chr(92), "/")
    return url.replace(chr(92), "/")


def _plan_first_publish_wait(
    root: Path, agent: str, remote_name: str, now: str, utc: str
) -> OperationPlan | Result:
    """PLAN the canonical first-publish WAIT checkpoint.

    ZERO commit/tag/push: the WAIT is a journaled canonical checkpoint that
    parks STATE.next_action on the exact ship.md line so the decision is
    recoverable evidence, not chat memory.
    """
    op_id = "wait-" + uuid4_hex()
    docs, state, _board, log_tail = _read(root)
    # T-1361 CL-04: `none` is the canonical NO-TASK value and it is a string,
    # so passing it straight through rendered the event's ticket slot as
    # `[none]` -- not a legal event line, which fast validation then refused
    # for a reason that has nothing to do with the WAIT. Every other reader of
    # STATE.task in this module already carries this guard; this one did not,
    # so a first publish from a project with no active task could not be
    # parked at all.
    task = state.get("task")
    task = task if task and task != "none" else None
    remote_name = _sanitize_remote(remote_name)
    message = f"first-publish -- confirm repo name '{remote_name}' and public/private before I push"
    event, line = _producer_event(
        docs,
        log_tail,
        "WAIT",
        message,
        ticket=task,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    na = f"WAIT: {message}"
    owned = {"next_action": na, "last_event": event, "updated": utc, "agent": agent}
    new_state = patch_state(docs["state"].text_norm, owned)
    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed first-publish WAIT state fails fast validation: " + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "wait",
        agent,
        _identity(root),
        {"operation": "wait", "remote": remote_name},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {"ok": True, "code": "FIRST_PUBLISH_WAIT", "next_action": na, "event_id": f"E-{event}"},
        op_id=op_id,
    )


@_state_guard
def record_first_publish_wait(
    project_root: Path | str, agent: str, remote_name: str, dry_run: bool = False
) -> Result:
    """Park STATE on the canonical first-publish WAIT (T-994 / § 11)."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_first_publish_wait(root, agent, remote_name, now, utc)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _plan_first_publish_confirm(
    root: Path, agent: str, remote_name: str, visibility: str, now: str, utc: str
) -> OperationPlan | Result:
    """PLAN the canonical first-publish confirmation record.

    Confirmation is canonical evidence, never chat memory: the confirming
    agent journal-records the repo name + public/private decision into STATE
    bound to the exact remote identity, so a later `saipen ship` can verify
    the publication is authorized for THIS endpoint.
    """
    op_id = "fpc-" + uuid4_hex()
    docs, state, _board, log_tail = _read(root)
    na = str(state.get("next_action") or "")
    if not na.startswith("WAIT: first-publish"):
        return _refuse(
            "VALIDATION_FAILED",
            "first-publish confirmation requires a pending "
            "first-publish WAIT in STATE.next_action; current "
            f"next_action is {na!r}",
        )
    if visibility not in ("public", "private"):
        return _refuse("VALIDATION_FAILED", f"visibility {visibility!r} outside public|private")
    remote_name = _sanitize_remote(remote_name)
    task = state.get("task")
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        task,
        agent,
        f"first publish confirmed -- repo '{remote_name}' ({visibility})",
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    owned = {
        "first_publish_confirmation": f"{remote_name} {visibility}",
        "next_action": (f"PHASE SHIP {task}" if task and task != "none" else "saipen continue"),
        "last_event": event,
        "updated": utc,
        "agent": agent,
    }
    new_state = patch_state(docs["state"].text_norm, owned)
    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed first-publish confirmation state fails fast "
            "validation: " + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "fpc",
        agent,
        _identity(root),
        {"operation": "fpc", "remote": remote_name, "visibility": visibility},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "FIRST_PUBLISH_CONFIRMED",
            "confirmation": f"{remote_name} {visibility}",
            "event_id": f"E-{event}",
        },
        op_id=op_id,
    )


@_state_guard
def confirm_first_publish(
    project_root: Path | str, agent: str, remote_name: str, visibility: str, dry_run: bool = False
) -> Result:
    """Record canonical first-publish confirmation (T-994 / § 11)."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_first_publish_confirm(root, agent, remote_name, visibility, now, utc)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


# ------------------------------------------------------------------ helpers
def _identity(root: Path) -> str:
    from .paths import project_identity

    return project_identity(root)


def _plan_crew_closure(
    root: Path,
    agent: str,
    now: str,
    utc: str,
    digest_text: str | None = None,
    prefix_run: str | None = None,
) -> OperationPlan | Result:
    """PLAN the terminal CREW release closure (T-1003 sweep, hostile finding
    3/5/16). The ordinary release executor closes an ordinary ticket through
    _plan_finish_ticket; a terminal crew release has NO ## DOING ticket (every
    ordinary ticket was already crew-deferred), so its closure writes the RUN +
    completion LOG events, the digest, and the STATE last_event/updated/agent
    while leaving phase DONE / task none and the deferred tickets DONE. The
    closure bytes are journaled exactly like any other canonical mutation."""
    op_id = "crew-closure-" + uuid4_hex()
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED", "BOARD parse error(s): " + "; ".join(board["errors"][:3])
        )
    if state.get("phase") != "DONE" or state.get("task") not in (None, "", "none"):
        return _refuse(
            "ILLEGAL_PHASE",
            f"crew terminal closure requires local Core phase DONE / task "
            f"none; live {state.get('phase')}/{state.get('task')}",
        )
    if prefix_run:
        run_event, run_line = _producer_event(
            docs,
            log_tail,
            "RUN",
            prefix_run,
            ticket=None,
            agent=agent,
            now=now,
            op_id=op_id,
        )
        event, line = _producer_event(
            docs,
            run_event,
            "DEC",
            "crew terminal release closure -- all deferred tickets shipped",
            ticket=None,
            agent=agent,
            now=now,
            op_id=op_id,
        )
        new_log = docs["log"].text_norm.rstrip("\n") + "\n" + run_line + "\n" + line + "\n"
    else:
        event, line = _event_line(
            docs, log_tail, "DEC", None, agent, "crew terminal release closure", now, op_id
        )
        new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    owned = {
        "last_event": event,
        "updated": utc,
        "agent": agent,
    }
    new_state = patch_state(docs["state"].text_norm, owned)
    from .router import route_next

    new_board = docs["board"].text_norm
    routed = route_next(new_state, new_board, current_agent=agent)
    if routed.get("ok") and routed.get("action") != "saipen continue":
        new_state = patch_state(new_state, {"next_action": routed["action"]})
    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed crew closure state fails fast validation: " + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    if digest_text is not None:
        digest_doc = codec.read_document(root / ".saipen" / "kitchen" / "digest.md")
        targets.append(
            TargetPlan(
                ".saipen/kitchen/digest.md",
                "report",
                digest_doc.encode(digest_text),
                _live_before(root, ".saipen/kitchen/digest.md", digest_doc),
                hash_bytes(digest_doc.encode(digest_text)),
            )
        )
    expected = {
        "ok": True,
        "code": "CREW_RELEASED",
        "event_id": f"E-{event}",
        "phase": "DONE",
        "task": "none",
        "next_action": routed.get("action"),
    }
    if digest_text is not None:
        expected["digest"] = str(root / ".saipen" / "kitchen" / "digest.md")
    return build_plan(
        "release_crew_closure",
        agent,
        _identity(root),
        {"operation": "release_crew_closure"},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        expected,
        op_id=op_id,
    )


def _is_converge_intent_epoch(value: object) -> bool:
    """True only for the exact op-id shape minted by set_converge_intent."""
    return (
        isinstance(value, str) and re.fullmatch(r"converge_intent-[0-9a-f]{32}", value) is not None
    )


def _plan_defer_for_crew(
    root: Path, ticket_id: str, agent: str, crew_epoch: str, now: str, utc: str
) -> OperationPlan | Result:
    """PLAN the crew-deferred closure of an ordinary ticket (T-1003 sweep,
    hostile finding 3/4).

    Under an active `converge_target: crew`, an ordinary ticket that reaches
    SHIP after VERIFY+REVIEW does NOT publish. This plan closes it LOCALLY
    (SHIP -> DONE, task none) and records a committed STRUCTURED defer receipt
    carrying crew_epoch, ticket_id, the exact reviewed release-scope identity
    and per-path hashes, and the source identity -- zero git commit, zero
    version bump, zero tag, zero push. The terminal crew release (SC-11) is
    later DERIVED from these receipts and fed to the ordinary release executor.

    Gate (mirrors _plan_finish_ticket): phase SHIP + task == ticket + exactly
    one ## DOING ticket + a recorded release scope bound to this project and
    source identity. DEFER is publication-free, but it is still a CLOSURE, so
    the SHIP gate cannot be skipped any more than a real ship can.
    """
    import json as _json

    op_id = "crew-defer-" + uuid4_hex()
    docs, state, board, log_tail = _read(root)
    # SELF-ownership gate (second-wave P0): a crew defer closes the active
    # DOING ticket locally, so it may only run over the session's own claim.
    _guard = _active_claim_refusal(state, docs["board"].text_norm, agent, ticket_id=ticket_id)
    if _guard is not None:
        return _guard
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            ticket=ticket_id,
        )
    tickets = board["tickets"]
    if ticket_id not in tickets:
        return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
    ticket = tickets[ticket_id]
    if ticket["section"] != "## DOING" or ticket["checkbox"] != "/":
        return _refuse(
            "ILLEGAL_TICKET_LIFECYCLE",
            f"crew defer accepts only a ## DOING [/] ticket; "
            f"{ticket_id} is {ticket['section']} "
            f"[{ticket['checkbox']}]",
            ticket=ticket_id,
        )
    doing = [t for t in tickets.values() if t["section"] == "## DOING"]
    if len(doing) != 1:
        return _refuse(
            "ACTIVE_TICKET_MISMATCH",
            f"crew defer needs exactly one ## DOING ticket, found {len(doing)}",
            ticket=ticket_id,
        )
    if state.get("task") != ticket_id:
        return _refuse(
            "ACTIVE_TICKET_MISMATCH",
            f"STATE.task={state.get('task')} != deferred ticket {ticket_id}",
            ticket=ticket_id,
        )
    prev_phase = state.get("phase") or "DONE"
    if prev_phase != "SHIP":
        return _refuse(
            "ILLEGAL_PHASE",
            f"crew defer requires phase SHIP (the canonical closure edge "
            f"SHIP -> DONE); actual phase {prev_phase} cannot defer a ticket "
            "without its required REVIEW/SHIP gates",
            ticket=ticket_id,
            phase=prev_phase,
        )
    # ``set_converge_intent`` is the sole epoch producer and persists
    # ``converge_intent-`` plus ``uuid4().hex`` (32 lowercase hex chars).
    # Accept that exact identity instead of the old generic uuid8 shape,
    # which rejected every real crew epoch while accepting unrelated op IDs.
    if not _is_converge_intent_epoch(crew_epoch):
        return _refuse(
            "VALIDATION_FAILED",
            f"crew_epoch {crew_epoch!r} is not a structured converge_intent op identity",
            ticket=ticket_id,
        )

    # The exact reviewed release scope must already exist and bind THIS
    # project and the reviewed source identity (item 5: derived, never a new
    # manual list; the defer receipt copies the reviewed path hashes).
    scope_rel = f"{RELEASE_SCOPE_DIR}/{ticket_id}.json"
    scope_path = root / scope_rel
    if not scope_path.is_file():
        return _refuse(
            "SOURCE_SCOPE_MISSING",
            f"no release scope recorded for {ticket_id} -- the exact reviewed "
            "files must be recorded (`saipen scope`) before the crew defer",
            ticket=ticket_id,
        )
    try:
        scope_doc = codec.read_document(scope_path)
        scope_record = _json.loads(scope_doc.text_norm)
    except (OSError, _json.JSONDecodeError) as exc:
        return _refuse("RECOVERY_CONFLICT", f"release scope record {scope_path} is corrupt: {exc}")
    if scope_record.get("schema_version") not in (1, 2) or scope_record.get("ticket") != ticket_id:
        return _refuse(
            "RECOVERY_CONFLICT",
            f"release scope record {scope_path} does not bind ticket {ticket_id}",
        )
    record_lineage = scope_record.get("project_lineage")
    if record_lineage:
        from .paths import project_lineage_identity

        live_lineage = project_lineage_identity(root)
        if not live_lineage or live_lineage != record_lineage:
            return _refuse(
                "PATH_ESCAPE",
                "release scope record belongs to a different project lineage; "
                "refuse cross-project defer",
            )
    elif scope_record.get("project_identity") != _identity(root):
        return _refuse(
            "PATH_ESCAPE",
            "legacy release scope record was created for a different runtime project; "
            "refuse cross-project defer",
        )
    paths = scope_record.get("paths") or {}
    if not paths:
        return _refuse(
            "SOURCE_SCOPE_MISSING", f"release scope record {scope_path} carries no paths"
        )
    try:
        from freshness import compute_source_identity

        ident = compute_source_identity(root)
    except Exception as exc:
        return _refuse("VALIDATION_FAILED", f"cannot compute source identity for defer: {exc}")
    if ident.source_head != scope_record.get(
        "source_head"
    ) or ident.source_tree_fingerprint != scope_record.get("source_tree_fingerprint"):
        return _refuse(
            "STALE_PLAN",
            f"reviewed scope source identity differs from the live tree; "
            f"re-record the scope before deferring {ticket_id}",
        )

    # Closure targets (same cross-file transaction as a real ship closure).
    # T-1015: the PLAN CAS token is derived from the ALREADY-SAMPLED
    # SourceIdentity (`ident`) -- the semantic sample and the CAS token
    # describe exactly one PLAN snapshot, never two Git discoveries that
    # could disagree. APPLY still revalidates the live tree independently
    # (run_mutation recomputes hash_source_identity under the lock), so any
    # post-PLAN change still fails STALE_STATE with zero writes.
    from .journal import source_identity_dependency

    run_event, run_line = _producer_event(
        docs,
        log_tail,
        "RUN",
        f"deferred {ticket_id} to crew epoch {crew_epoch} "
        "(no publication; SC-11 owns terminal release)",
        ticket=ticket_id,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    event, line = _producer_event(
        docs,
        run_event,
        "DEC",
        "ticket deferred via SAIOPS -- completion (from SHIP), deferred to crew",
        ticket=ticket_id,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + run_line + "\n" + line + "\n"
    new_board = _move_ticket(docs["board"].text_norm, ticket_id, "## DONE", "[x]", "done", "")
    owned = {
        "phase": "DONE",
        "task": "none",
        "next_action": "saipen continue",
        "transition_from": prev_phase,
        "last_event": event,
        "updated": utc,
        "agent": agent,
    }
    new_state = patch_state(docs["state"].text_norm, owned)
    from .router import route_next

    routed = route_next(new_state, new_board, current_agent=agent)
    if routed.get("ok") and routed.get("action") != "saipen continue":
        new_state = patch_state(new_state, {"next_action": routed["action"]})

    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed defer state fails fast validation: " + "; ".join(errors[:5]),
        )

    targets = [
        *_log_targets(docs, new_log),
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    preconditions = _docs_preconditions(docs, "state", "board", "log")
    preconditions[scope_rel] = scope_doc.raw_hash
    preconditions["."] = source_identity_dependency(ident)
    receipt_metadata = {
        "operation": "crew_defer",
        "status": "COMMITTED",
        "crew_epoch": crew_epoch,
        "ticket_id": ticket_id,
        "release_scope_path": scope_rel,
        "release_scope_identity": hash_bytes(scope_doc.text_norm.encode("utf-8")),
        "paths": dict(paths),
        "source_head": scope_record.get("source_head"),
        "source_tree_fingerprint": scope_record.get("source_tree_fingerprint"),
        "project_identity": _identity(root),
        "project_lineage": scope_record.get("project_lineage"),
        "event_id": f"E-{event}",
        "op_id": op_id,
    }
    return build_plan(
        "crew_defer",
        agent,
        _identity(root),
        {"operation": "crew_defer", "ticket": ticket_id, "crew_epoch": crew_epoch},
        preconditions,
        targets,
        {
            "ok": True,
            "code": "DEFERRED",
            "ticket": ticket_id,
            "crew_epoch": crew_epoch,
            "event_id": f"E-{event}",
            "phase": "DONE",
            "task": "none",
            "next_action": routed.get("action"),
        },
        op_id=op_id,
        receipt_metadata=receipt_metadata,
    )


@_state_guard
def defer_for_crew(
    project_root: Path | str, ticket_id: str, agent: str, crew_epoch: str, dry_run: bool = False
) -> Result:
    """Close an ordinary SHIP ticket as crew-deferred (public DEFER_FOR_CREW).

    Structured defer receipt committed through the journal (operation
    `crew_defer`); zero git write, zero version bump, zero tag, zero push.
    Core returns to the crew planner for the terminal SC-11 release.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_defer_for_crew(root, ticket_id, agent, crew_epoch, now, utc)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _plan_clear_wait_role(
    root: Path, ticket_id: str, agent: str, now: str, utc: str
) -> OperationPlan | Result:
    """PLAN the mechanical disposition of a WAIT_ROLE:<role> blocker whose
    owning crew role produced real evidence (T-1003 finding 10). The ticket
    is moved ## BLOCKED -> ## DONE with the blocker removed -- the resolution
    IS the role's evidence, never prose, never a human courier. Core state
    stays DONE/task none; a crew-owned blocker is work for SC, not a
    terminal human stop."""
    docs, state, board, log_tail = _read(root)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED", "BOARD parse error(s): " + "; ".join(board["errors"][:3])
        )
    tickets = board["tickets"]
    if ticket_id not in tickets:
        return _refuse("TICKET_NOT_FOUND", f"{ticket_id} not on the board", ticket=ticket_id)
    ticket = tickets[ticket_id]
    if ticket["section"] != "## BLOCKED":
        return _refuse(
            "ILLEGAL_TICKET_LIFECYCLE",
            f"clear-wait-role accepts only a ## BLOCKED ticket; {ticket_id} is {ticket['section']}",
            ticket=ticket_id,
        )
    from .board import blocker_class

    blocker = ticket.get("fields", {}).get("blocker", "")
    if blocker_class(blocker) != "WAIT_ROLE":
        return _refuse(
            "ILLEGAL_TICKET_LIFECYCLE",
            f"{ticket_id} blocker is not a WAIT_ROLE class",
            ticket=ticket_id,
        )
    op_id = "clear-wait-role-" + uuid4_hex()
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        ticket_id,
        agent,
        "WAIT_ROLE blocker cleared -- owning role evidence received; ticket resolved",
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    new_board = _move_ticket(docs["board"].text_norm, ticket_id, "## DONE", "[x]", "done", "")
    owned = {"last_event": event, "updated": utc, "agent": agent}
    if state.get("phase") == "DONE" and state.get("transition_from") in (
        "SCOUT",
        "BUILD",
        "VERIFY",
        "REVIEW",
        "SHIP",
    ):
        owned["transition_from"] = "DONE"
    new_state = patch_state(docs["state"].text_norm, owned)
    errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed clear-wait-role state fails fast validation: " + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["board"], ".saipen/BOARD.md", "board", new_board),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    return build_plan(
        "clear_wait_role",
        agent,
        _identity(root),
        {"operation": "clear_wait_role", "ticket": ticket_id},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {"ok": True, "code": "WAIT_ROLE_CLEARED", "ticket": ticket_id, "event_id": f"E-{event}"},
        op_id=op_id,
    )


@_state_guard
def clear_wait_role(
    project_root: Path | str, ticket_id: str, agent: str, dry_run: bool = False
) -> Result:
    """Public disposition of a crew-owned WAIT_ROLE blocker (item 10)."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_clear_wait_role(root, ticket_id, agent, now, utc)
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _plan_crew_run(
    root: Path,
    agent: str,
    *,
    crew_epoch: str,
    role: str,
    source_head: str,
    source_tree_fingerprint: str,
    role_revision: str,
    package_identities: list[str],
    now: str,
    utc: str,
) -> OperationPlan | Result:
    """PLAN a structured crew-run receipt (T-1003 finding 7): structured
    proof a role actually RAN in this epoch and bound its package identities
    to epoch + role + exact source identity + role_revision. Package evidence
    produced before the current epoch may stay valid history -- it does not
    certify the new SC stage. CURRENT != FRESH FOR THIS CREW EPOCH."""
    op_id = "crew-run-" + uuid4_hex()
    docs, _state, _board, log_tail = _read(root)
    # T-1430: the actor who records the run is the agent; the role is what
    # ran, and it is named in the text and the receipt.
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        None,
        agent,
        f"crew run -- epoch {crew_epoch} role {role} ({len(package_identities)} package(s))",
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "last_event": event,
            "updated": utc,
            "agent": agent,
        },
    )
    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed crew-run state fails fast validation: " + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    receipt_metadata = {
        "operation": "crew_run",
        "status": "COMMITTED",
        "crew_epoch": crew_epoch,
        "role": role,
        "source_head": source_head,
        "source_tree_fingerprint": source_tree_fingerprint,
        "role_revision": role_revision,
        "package_identities": list(package_identities),
        "project_identity": _identity(root),
        "event_id": f"E-{event}",
    }
    return build_plan(
        "crew_run",
        agent,
        _identity(root),
        {"operation": "crew_run", "role": role, "crew_epoch": crew_epoch},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "CREW_RUN_RECORDED",
            "role": role,
            "crew_epoch": crew_epoch,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
        receipt_metadata=receipt_metadata,
    )


@_state_guard
def record_crew_run(
    project_root: Path | str,
    agent: str,
    *,
    crew_epoch: str,
    role: str,
    source_head: str,
    source_tree_fingerprint: str,
    role_revision: str,
    package_identities: list[str],
    dry_run: bool = False,
) -> Result:
    """Commit a structured crew-run receipt (item 7)."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_crew_run(
        root,
        agent,
        crew_epoch=crew_epoch,
        role=role,
        source_head=source_head,
        source_tree_fingerprint=source_tree_fingerprint,
        role_revision=role_revision,
        package_identities=package_identities,
        now=now,
        utc=utc,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _plan_producer_integration(
    root: Path,
    agent: str,
    *,
    crew_epoch: str,
    producer: str,
    package_identity: str,
    input_source: str,
    input_source_fingerprint: str,
    resulting_source: str,
    resulting_source_fingerprint: str,
    core_ticket: str | None = None,
    now: str = "",
    utc: str = "",
) -> OperationPlan | Result:
    """PLAN a structured producer INTEGRATION EDGE (T-1003 findings 11/12).

    The package was prepared against S0 (input_source) and its payload was
    APPLIED, making the source S1 (resulting_source). The package truthfully
    stays bound to S0 -- it is never rewritten to claim S1. SC-8/9 consume
    this edge; the edge is the integration proof, and the natural staleness of
    the S0 package against later sources is exactly what detects whether a
    rerun is required."""
    op_id = "producer-integration-" + uuid4_hex()
    docs, _state, _board, log_tail = _read(root)
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        core_ticket,
        producer,
        f"producer integration -- {producer} {input_source[:12]} -> {resulting_source[:12]}",
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "last_event": event,
            "updated": utc,
            "agent": agent,
        },
    )
    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed integration state fails fast validation: " + "; ".join(errors[:5]),
        )
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    receipt_metadata = {
        "operation": "producer_integration",
        "status": "COMMITTED",
        "crew_epoch": crew_epoch,
        "producer": producer,
        "package_identity": package_identity,
        "input_source": input_source,
        "input_source_fingerprint": input_source_fingerprint,
        "resulting_source": resulting_source,
        "resulting_source_fingerprint": resulting_source_fingerprint,
        "core_ticket": core_ticket,
        "project_identity": _identity(root),
        "event_id": f"E-{event}",
    }
    return build_plan(
        "producer_integration",
        agent,
        _identity(root),
        {"operation": "producer_integration", "producer": producer},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": "INTEGRATION_RECORDED",
            "producer": producer,
            "crew_epoch": crew_epoch,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
        receipt_metadata=receipt_metadata,
    )


@_state_guard
def record_producer_integration(
    project_root: Path | str,
    agent: str,
    *,
    crew_epoch: str,
    producer: str,
    package_identity: str,
    input_source: str,
    input_source_fingerprint: str,
    resulting_source: str,
    resulting_source_fingerprint: str,
    core_ticket: str | None = None,
    dry_run: bool = False,
) -> Result:
    """Commit a structured producer integration edge (item 11)."""
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_producer_integration(
        root,
        agent,
        crew_epoch=crew_epoch,
        producer=producer,
        package_identity=package_identity,
        input_source=input_source,
        input_source_fingerprint=input_source_fingerprint,
        resulting_source=resulting_source,
        resulting_source_fingerprint=resulting_source_fingerprint,
        core_ticket=core_ticket,
        now=now,
        utc=utc,
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _plan_convergence_stage(
    root: Path,
    agent: str,
    *,
    stage: str,
    verdict: str,
    detail: str = "",
    now: str = "",
    utc: str = "",
) -> OperationPlan | Result:
    """PLAN a structured canonical convergence-stage receipt (T-1003 Wave 2
    items 1/14). CONVERGE.md owns the E-I sequence; this receipt is the
    mechanical proof that one stage ran and bound the LIVE source identity at
    its execution time. Only a COMMITTED terminal chain E,F,G,H,I -- ordered,
    identity-consistent, ending at the CURRENT source -- satisfies the
    convergence verdict consumed by SC-7 and the crew gate.

    The op computes and binds the source identity itself (no caller-supplied
    identity can be fabricated); stage G (CLEAN) additionally derives its
    INPUT identity from the latest committed F receipt, so CLEAN is proven to
    run on the source the test gate and forced HUNT proved.
    """
    from .convergence import CONVERGENCE_STAGES, STAGE_NAMES, STAGE_VERDICTS

    if stage not in CONVERGENCE_STAGES:
        return _refuse(
            "VALIDATION_FAILED",
            f"convergence stage {stage!r} outside the closed E-I set {list(CONVERGENCE_STAGES)}",
        )
    allowed = STAGE_VERDICTS[stage]
    if verdict not in allowed:
        return _refuse(
            "VALIDATION_FAILED",
            f"stage {stage} verdict {verdict!r} is not a closed "
            f"{STAGE_NAMES[stage]} outcome ({', '.join(allowed)}) -- "
            "arbitrary prose is never convergence evidence",
        )
    try:
        from freshness import compute_source_identity

        ident = compute_source_identity(root)
    except Exception as exc:
        return _refuse(
            "VALIDATION_FAILED", f"cannot bind convergence stage to a source identity: {exc}"
        )
    # §3/§5 Conformance Closure: the canonical test gates (E/H) and the CLEAN
    # exit (G) MUST be backed by a REAL, CURRENT conformance receipt. Prose
    # `verdict: PASS` or a caller-supplied PASS is never convergence evidence,
    # so the gate helper derives satisfaction from the canonical receipt only.
    from .conformance import clean_exit_allowed, convergence_stage_satisfied

    if stage in ("E", "H"):
        ok, why = convergence_stage_satisfied(root, stage, ident)
        if not ok:
            # PERF-005: use canonical VALIDATION_FAILED code from the closed set
            return _refuse("VALIDATION_FAILED", f"convergence stage {stage}: {why}")
    if stage == "G":
        ok, why = clean_exit_allowed(root)
        if not ok:
            # PERF-005: use canonical VALIDATION_FAILED code from the closed set
            return _refuse("VALIDATION_FAILED", f"clean exit gate: {why}")
    op_id = "convergence-" + uuid4_hex()
    docs, _state, _board, log_tail = _read(root)
    meta = {
        "operation": "convergence_stage",
        "status": "COMMITTED",
        "stage": stage,
        "verdict": verdict,
        "source_head": ident.source_head,
        "source_tree_fingerprint": ident.source_tree_fingerprint,
        "detail": detail,
        "project_identity": _identity(root),
    }
    # Record-time ordered evidence (items 1/19): a stage may be recorded only
    # after its canonical predecessor exists, so the chain cannot be written
    # out of order even by an agent that ignores the sequence. E restarts are
    # legal (CONVERGE.md's F -> E loop when HUNT finds work).
    predecessor = {"F": "E", "G": "F", "H": "G", "I": "H"}
    predecessor_receipt = None
    if stage in predecessor:
        predecessor_receipt = _latest_convergence_stage(root, predecessor[stage])
        if predecessor_receipt is None:
            return _refuse(
                "VALIDATION_FAILED",
                f"stage {stage} requires a committed "
                f"{predecessor[stage]} receipt first -- the canonical "
                "sequence is E,F,G,H,I in order",
            )
    if stage == "G":
        # CLEAN input identity comes from the latest committed F receipt; the
        # resulting identity is the LIVE tree after the CLEAN mutation.
        latest_f = predecessor_receipt
        if latest_f is None:
            return _refuse(
                "VALIDATION_FAILED",
                "CLEAN requires a committed forced HUNT (F) receipt first -- "
                "CLEAN must run on the source the test gate and forced HUNT "
                "proved",
            )
        meta["input_source_head"] = (latest_f.get("receipt_metadata") or {}).get("source_head", "")
        meta["input_source_tree_fingerprint"] = (latest_f.get("receipt_metadata") or {}).get(
            "source_tree_fingerprint", ""
        )
        meta["resulting_source_head"] = ident.source_head
        meta["resulting_source_tree_fingerprint"] = ident.source_tree_fingerprint
    event, line = _event_line(
        docs,
        log_tail,
        "DEC",
        None,
        agent,
        f"convergence stage {stage} ({STAGE_NAMES[stage]}) -- {verdict}"
        + (f": {detail}" if detail else ""),
        now,
        op_id,
    )
    new_log = docs["log"].text_norm.rstrip("\n") + "\n" + line + "\n"
    new_state = patch_state(
        docs["state"].text_norm,
        {
            "last_event": event,
            "updated": utc,
            "agent": agent,
        },
    )
    errors = validate_texts(
        new_state,
        docs["board"].text_norm,
        new_log,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed convergence state fails fast validation: " + "; ".join(errors[:5]),
        )
    meta["event_id"] = f"E-{event}"
    targets = [
        *_log_targets(docs, new_log),
        _target(docs["state"], ".saipen/STATE.md", "state", new_state),
    ]
    from .journal import source_identity_dependency

    preconditions = _docs_preconditions(docs, "state", "board", "log")
    preconditions["."] = source_identity_dependency(ident)
    return build_plan(
        "convergence_stage",
        agent,
        _identity(root),
        {"operation": "convergence_stage", "stage": stage, "verdict": verdict},
        preconditions,
        targets,
        {
            "ok": True,
            "code": "CONVERGENCE_RECORDED",
            "stage": stage,
            "verdict": verdict,
            "event_id": f"E-{event}",
        },
        op_id=op_id,
        receipt_metadata=meta,
    )


@_state_guard
def record_convergence(
    project_root: Path | str,
    agent: str,
    *,
    stage: str,
    verdict: str,
    detail: str = "",
    dry_run: bool = False,
) -> Result:
    """Commit one structured canonical convergence-stage receipt.

    PUBLIC convergence operation (Wave 2 item 1): the canonical E-I sequence
    records each executed stage through THIS operation, and the read-only
    verdict in saipen_engine.convergence proves the chain is current. E2E
    acceptance must use this operation -- never direct receipt fabrication.
    """
    root = Path(project_root)
    now, utc = _now(), _utc_iso()
    plan = _plan_convergence_stage(
        root, agent, stage=stage, verdict=verdict, detail=detail, now=now, utc=utc
    )
    if isinstance(plan, Result):
        return plan
    if dry_run:
        return _render_plan(plan)
    return apply_plan(root, plan)


def _render_plan(plan: OperationPlan) -> Result:
    """Render an OperationPlan as the dry-run result. Reads nothing live,
    writes nothing."""
    expected = dict(plan.expected)
    expected["op_id"] = plan.op_id
    expected["dry_run"] = True
    expected["changed_files"] = plan.changed_files
    return Result(
        ok=True,
        code=expected.get("code", "PLANNED"),
        data=expected,
        op_id=plan.op_id,
        changed_files=plan.changed_files,
    )
