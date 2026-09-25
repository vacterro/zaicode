"""START: an actionable user task becomes claimed Work in one operation (T-1363).

The field failure this exists for: a real OpenCode session was given a normal
task and the operator had to walk the model through `seat`, `intake`,
`recovery`, `auth` and `cc` -- and it still never started. Every step it tried
answered a different question than the one asked: status ran recovery,
continue reauthorized a valve that never tripped, the ingress was unreachable
behind old debt, and the human-mode refusal hid the one command that mattered.

`start` is orchestration, not a second policy engine. Every write it performs
is an existing canonical operation, in this order:

1. the COMPLETE request becomes a durable intake receipt -- first, before any
   old execution debt is touched, whenever no unfinished operation targets the
   intake store itself;
2. journal recovery and deterministic reconciliation run exactly as
   `continue` runs them; a tripped safety valve is reauthorized, because a new
   explicit task is the human authority `cc` stands for; every other operator
   decision is preserved, never approximated;
3. the receipt is projected as `user_explicit` Work (idempotent: the same
   request is the same receipt is the same ticket);
4. the seat is inherited, never invented: the caller's own interrupted Work is
   parked with `ticket block-for` so it resumes at its phase when the new Work
   closes; a live foreign claim is reported and never taken;
5. the Work is claimed into SCOUT.

The answer is `STARTED`, or `WAIT_OPERATOR` naming ONE exact decision plus the
exact command that resumes afterwards, or `WAIT_FOREIGN_OWNER` naming the
ownership fact. A retry after the decision converges; it never re-asks.
"""

from __future__ import annotations

from pathlib import Path

from . import codec, guard_events, intake, operator_task, ownership, pending_ingress
from .board import parse_board
from .errors import EngineError
from .journal import recovery_preflight, scan_pending
from .reconcile import reconcile_protocol_state
from .state import parse_state_or_error

STARTED = "STARTED"
WAIT_OPERATOR = "WAIT_OPERATOR"
WAIT_FOREIGN_OWNER = "WAIT_FOREIGN_OWNER"
USAGE = (
    "Use: saipen start '<task in one line>'  "
    "(or --file PATH, "
    "--hex <utf-8 hex>, or --receipt SRC-###)"
)

#: The canonical execution phases a claimed ticket can be resumed in.
_WORK_PHASES = frozenset({"SCOUT", "BUILD", "VERIFY", "REVIEW", "SHIP"})
_REQUEST_HEADER = "## Request"


def _refuse(code: str, detail: str, **fields) -> dict:
    return {"ok": False, "code": code, "detail": detail, **fields}


def _normalized_request(text: str) -> str:
    return " ".join(str(text or "").split()).strip().lower()


def existing_work_for_request(root: Path, tickets: dict, text: str) -> str | None:
    """The BOARD Work that already carries this exact request, or None.

    Measured in the T-1446 field soak (2026-09-22): one minute after a cold
    successor finished T-2, it ran `saipen start` with T-2's exact text and
    minted SRC-001 + T-4 over DONE Work. START deduplicated identical receipt
    BODIES only, never an existing Work for the same request.

    Two classes stay distinct. An operator repeating an operator request after
    it is DONE is a NEW action (T-1363 RequestIdentityTests: a new receipt that
    supersedes the old one) -- so DONE Work matched through its own request
    receipt is not a duplicate. Echoing a Work item's DESCRIPTION back as a
    request, with no operator request of that text behind the Work, is the
    field defect: that is the same Work, open or DONE.
    """
    import re as _re

    wanted = _normalized_request(text)
    if not wanted:
        return None
    for work, ticket in tickets.items():
        receipts = [
            item.strip()
            for item in str((ticket.get("fields") or {}).get("source_receipts") or "").split(",")
            if item.strip()
        ]
        via_receipt = False
        for receipt_id in receipts:
            request, problem, _cls = request_from_receipt(root, receipt_id)
            if problem is None and _normalized_request(request.get("text") or "") == wanted:
                via_receipt = True
                break
        done = ticket.get("section") == "## DONE"
        if via_receipt:
            if done:
                continue  # operator repeat after DONE: a new action (T-1363)
            return work
        description = _re.sub(r"^\[P\d\]\s*", "", str(ticket.get("description") or "").strip())
        if _normalized_request(description) == wanted:
            return work
    return None


def _bind_duplicate_ingress(root: Path, receipt_id: str, work: str, ticket: dict) -> dict:
    """Bind a repeated request to the Work that already owns it (T-1446).

    Open Work gains the receipt as membership. DONE Work gains it as CONSUMED
    ingress: the request clause is VERIFIED by that Work's own closure, so the
    receipt never re-queues and never leaves DONE Work with an unresolved
    source.
    """
    if ticket.get("section") == "## DONE":
        clause = intake.ensure_request_clause(root, receipt_id)
        if not clause.get("ok"):
            return clause
        ledger = intake._read_coverage(root, receipt_id) or {}
        for rid in sorted((ledger.get("requirements") or {}).keys()):
            marked = intake.set_disposition(
                root,
                receipt_id,
                rid,
                "VERIFIED",
                work=work,
                evidence=f"duplicate ingress of DONE {work}: identical request text",
                verification=f"{work} closed through its own VERIFY/REVIEW/SHIP chain",
            )
            if not marked.get("ok"):
                return marked
    return intake.link_work_to(root, receipt_id, work)


def _snapshot(root: Path) -> tuple[dict | None, dict | None, str | None]:
    """STATE + parsed BOARD, or the reason they cannot be read."""
    try:
        state, error = parse_state_or_error(codec.read_doc(root / ".saipen" / "STATE.md"))
        board = parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))
    except (OSError, ValueError, EngineError) as exc:
        return None, None, f"{type(exc).__name__}: {exc}"
    if error or state is None:
        return None, None, f"STATE unreadable: {error}"
    if board.get("errors"):
        return state, None, "BOARD parse error(s): " + "; ".join(board["errors"][:3])
    return state, board, None


#: Why `saipen start --receipt` refuses a receipt. The queued-Source router
#: asks `request_from_receipt` too (T-1458), and needs to tell a receipt that
#: is simply not a request (skip it) from one it cannot read (surface it).
RECEIPT_UNREADABLE = "UNREADABLE"
RECEIPT_AUTHORITY_ONLY = "AUTHORITY_ONLY"
RECEIPT_NOT_A_REQUEST = "NOT_A_REQUEST"


def request_from_receipt(
    root: Path, receipt: str
) -> tuple[dict | None, str | None, str | None]:
    """(request, problem, problem_class) of a `user-request` receipt body.

    THE admissibility owner for starting a receipt. The queued-Source router
    used to decide on `source_kind` alone, so an operator authority capsule
    captured as `user_instruction` was routed as `saipen start --receipt` and
    this function then refused it -- measured live 2026-09-22 (T-1458): the
    router answered the same refused start after every dependency park.
    """
    found = intake.read_body(root, receipt)
    if not found.get("ok"):
        return (
            None,
            f"{receipt}: {found.get('code')} {found.get('detail') or ''}".strip(),
            RECEIPT_UNREADABLE,
        )
    meta = found.get("meta") or {}
    if meta.get("projection_policy") == intake.PROJECTION_AUTHORITY_ONLY:
        # T-1414: an authority-only Source is typed data, not a task. It
        # exists to be cited by `saipen ticket retire --authority` and must
        # never be re-projected into Work.
        return None, (
            f"{receipt} is captured operator authority (projection_policy "
            "authority_only) and never projects Work; cite it with "
            f"saipen ticket retire <T-###> --authority {receipt}"
        ), RECEIPT_AUTHORITY_ONLY
    body = str(found.get("body") or "")
    head, sep, request = body.partition("\n" + _REQUEST_HEADER + "\n")
    if not sep or not head.startswith("# User request"):
        return (
            None,
            f"{receipt} is not a user request receipt; start it with its own text",
            RECEIPT_NOT_A_REQUEST,
        )
    fields = {}
    for line in head.splitlines():
        key, colon, value = line.partition(": ")
        if colon and key in ("priority", "verify", "needs", "supersedes"):
            fields[key] = value
    return {
        "priority": fields.get("priority") or "P1",
        "verify": fields.get("verify"),
        "needs": [part.strip() for part in fields.get("needs", "").split(",") if part.strip()],
        "supersedes": (fields.get("supersedes") or "").strip() or None,
        "text": request.strip("\n"),
        "linked_work": (found.get("meta") or {}).get("linked_work"),
    }, None, None


def _pending_touches_intake(root: Path) -> bool:
    """Does an unfinished operation (or an unreadable one) target intake?"""
    from .admission import _pending_operation_targets

    pending, conflicts = scan_pending(root)
    ops = (conflicts or []) + (pending or [])
    if not ops:
        return False
    targets = _pending_operation_targets(root, ops)
    if targets is None:
        return True
    return any(".saipen/intake" in str(path).replace("\\", "/") for path in targets)


def _decision_wait(
    decision: dict, *, receipt: str | None, ticket: str | None, detail: str, **fields
) -> dict:
    command = decision.get("command")
    return {
        "ok": False,
        "code": WAIT_OPERATOR,
        "detail": detail,
        "decision": decision,
        "canonical_next_command": command,
        "operator_decision_available": bool(command),
        "receipt": receipt,
        "ticket": ticket,
        "resume_command": f"saipen start --receipt {receipt}" if receipt else None,
        **fields,
    }


#: A request text asked again and again over a project's life. The bound stops
#: the chain walk below from being unbounded; nothing real approaches it.
_MAX_SUPERSEDE_CHAIN = 64


def _foreign_seat_route(
    seat, *, receipt_form: bool, queue_id: str | None
) -> tuple[str, str | None]:
    """The route a live FOREIGN seat hands out must make progress (T-1397).

    A plain-text ingress is told to resume by receipt -- real progress: the
    request becomes durable and the resume form is exact. A receipt-form
    ingress has ALREADY run that command; re-handing it makes compliance a
    fixed point (the field measured a session execute the handed ``then:``
    verbatim and receive a byte-identical refusal with the same ``then:``),
    so that answer is terminal instead: the request is queued, the seat is
    not taken over, and the caller stops rather than loops.
    """
    held = (
        f"{seat.active_ticket} is live Work owned by {seat.board_owner!r} "
        f"(claim_time {seat.claim_time}); it is not taken over."
    )
    if receipt_form:
        return (
            f"{held} The request is already queued as {queue_id}; running the same "
            "resume again cannot advance it -- stop here and return after that "
            "seat is free.",
            None,
        )
    resume = (
        f"saipen start --receipt {queue_id}"
        if str(queue_id or "").startswith("SRC-")
        else None
    )
    return (
        f"{held} The request is durable as {queue_id} and starts when that seat is free.",
        resume,
    )


def _terminal(root: Path, found: dict | None) -> bool:
    """Is this receipt's Work finished, so a new submission is a NEW action?"""
    if not found:
        return False
    if found.get("status") == intake.CLOSED_STATUS or found.get("closed"):
        return True
    work = found.get("linked_work")
    if not work:
        # Captured but never projected: the transport retry this receipt IS.
        return False
    _state, board, _problem = _snapshot(root)
    record = ((board or {}).get("tickets") or {}).get(work)
    if record is None:
        # The Work the receipt names is gone from BOARD. Not a live retry, and
        # not a proven completion either -- treat it as open so the existing
        # authority is reused rather than silently forked.
        return False
    return record.get("section") == "## DONE"


def _request_identity(root: Path, render, text: str) -> tuple[str, str | None, dict | None]:
    """(body, supersedes, existing receipt record) for THIS submission.

    P0-4. Identical bytes mean "the same transport attempt" only while the
    Work they produced is unfinished. Once it is DONE, the same words are a
    NEW instruction, and the new request records which finished one it
    follows -- a durable, derived fact, so the new action is itself content-
    addressed and its own retries converge on it.
    """
    supersedes: str | None = None
    for _ in range(_MAX_SUPERSEDE_CHAIN):
        body = render(supersedes)
        found = intake.find_by_body(root, body)
        if not _terminal(root, found):
            return body, supersedes, found
        supersedes = found["receipt"]
    return render(supersedes), supersedes, intake.find_by_body(root, render(supersedes))


def _decisions_of(reconciliation: dict | None) -> list[dict]:
    if not isinstance(reconciliation, dict) or reconciliation.get("ok"):
        return []
    decisions = [
        item for item in reconciliation.get("operator_decisions") or [] if isinstance(item, dict)
    ]
    if decisions:
        return decisions
    return [
        {
            "field": reconciliation.get("blocking_field"),
            "surface": reconciliation.get("blocking_surface"),
            "ticket": None,
            "command": reconciliation.get("canonical_next_command"),
            "reason": str(reconciliation.get("detail") or reconciliation.get("code") or "")[:400],
        }
    ]


def start_work(
    project_root: Path | str,
    actor: str,
    *,
    actor_source: str,
    text: str | None = None,
    receipt: str | None = None,
    priority: str = "P1",
    verify: str | None = None,
    dry_run: bool = False,
    supersede_ingress: bool = False,
) -> dict:
    from .operations import (
        USER_REQUEST_VERIFY,
        _user_request_body,
        apply_claim,
        reauthorize_valve,
        set_goal_intent,
        ticket_move,
        user_request,
    )

    root = Path(project_root)
    needs: list[str] = []
    linked_work = None
    explicit_supersedes = None
    if receipt:
        request, problem, _problem_class = request_from_receipt(root, receipt)
        if problem:
            return _refuse("VALIDATION_FAILED", problem, usage=USAGE)
        text, priority = request["text"], request["priority"]
        verify, needs, linked_work = request["verify"], request["needs"], request["linked_work"]
        explicit_supersedes = request["supersedes"]
    if not isinstance(text, str) or not text.strip():
        return _refuse("VALIDATION_FAILED", USAGE, usage=USAGE)
    text = text.strip()
    # T-1398: shell control operators are transport syntax, not user request
    # content. A shell consumes an operator-only tail and passes no task at
    # all, so those bytes cannot buy a receipt, a ticket or a resumed
    # request, whatever carried them -- plain text, --hex, --file or a
    # receipt body. Measured live: `saipen start --hex 323e2631` (utf-8 of
    # "2>&1") minted a ticket titled `2>&1` with `user_explicit: true`.
    if guard_events.shell_control_expression(text):
        return _refuse(
            "INGRESS_SHELL_CONTROL",
            "the request text is shell control syntax, not a request: a shell "
            "would consume it as transport and pass no task at all; name the "
            "task in words",
            canonical_next_command="saipen start '<the task, one line>'",
        )
    # T-1372: a transport refusal names a command AND owes specific bytes. A
    # request that is not those bytes cannot enter here silently -- that is how
    # a model's paraphrase earned a receipt asserting the operator's own words.
    obligation = pending_ingress.pending(root)
    owed = pending_ingress.enforce(
        root, text, supersede=supersede_ingress, commit=not dry_run
    )
    if owed is not None:
        return _refuse(owed.pop("code"), owed.pop("detail"), **owed)
    # T-1376: the obligation above only exists when something REFUSED these
    # bytes. A session that never attempted the literal ingress was never
    # refused, so nothing compared its words with the operator's -- unless the
    # launcher declared the task, which is what this asks.
    provenance = operator_task.witness(
        text,
        obligation_met=bool(obligation) and not obligation.get("malformed"),
    )
    if "code" in provenance:
        return _refuse(provenance.pop("code"), provenance.pop("detail"), **provenance)
    verify_text = (verify or "").strip() or USER_REQUEST_VERIFY

    def render(supersedes: str | None) -> str:
        return _user_request_body(text, priority, verify_text, needs, supersedes)

    if receipt:
        # An explicit receipt IS the authority: resume exactly it, never a
        # successor derived from its text.
        body, supersedes = render(explicit_supersedes), explicit_supersedes
    else:
        body, supersedes, _existing = _request_identity(root, render, text)
    identity = {"project_root": str(root.resolve()), "actor": actor, "actor_source": actor_source}

    if dry_run:
        # PLAN purity: nothing below may write. The preview names what start
        # would do from the current bytes, not a promise about later bytes.
        state, board, problem = _snapshot(root)
        preview = reconcile_protocol_state(root, actor, dry_run=True)
        seat = (
            ownership.classify_active_ownership(
                state, board["tickets"], actor, root=root
            ).status
            if state is not None and board is not None
            else None
        )
        return {
            "ok": True,
            "code": "PLAN",
            "operation": "start",
            "dry_run": True,
            **identity,
            "existing_receipt": (intake.find_by_body(root, body) or {}).get("receipt"),
            "reconciliation": preview.get("code"),
            "remediation": preview.get("remediation"),
            "seat": seat,
            "snapshot_problem": problem,
            "steps": [
                "capture request receipt",
                "recover journal / reconcile",
                "project user_explicit Work",
                "park own interrupted Work (ticket block-for)" if seat == ownership.SELF else None,
                "claim Work into SCOUT",
            ],
        }

    # 1. INGRESS before execution debt. The receipt is intake-only bytes; an
    # unfinished operation that writes intake is the one debt it must wait on.
    captured_receipt = None
    if not _pending_touches_intake(root):
        captured = intake.capture(
            root, body, source_kind="user_instruction", request_provenance=provenance
        )
        if not captured.get("ok"):
            return _refuse(
                captured.get("code") or "SOURCE_UNRESOLVED",
                "the request could not be captured durably: "
                + str(captured.get("detail") or captured),
                **identity,
            )
        captured_receipt = captured.get("receipt")
        linked_work = linked_work or captured.get("linked_work")

    # 2. Journal recovery, exactly the continuation's mandatory preflight.
    preflight = recovery_preflight(root)
    if not preflight.get("ok"):
        command = preflight.get("canonical_next_command")
        return _decision_wait(
            {
                "field": None,
                "surface": "journal",
                "ticket": None,
                "command": command,
                "inspect_command": preflight.get("inspect_command"),
                "reason": str(preflight.get("detail") or preflight.get("code") or "")[:400],
            },
            receipt=captured_receipt,
            ticket=None,
            detail="unfinished canonical operation(s) must be settled first: "
            + str(preflight.get("detail") or preflight.get("code")),
            journal=preflight,
            inspect_command=preflight.get("inspect_command"),
            **identity,
        )
    if captured_receipt is None:
        captured = intake.capture(
            root, body, source_kind="user_instruction", request_provenance=provenance
        )
        if not captured.get("ok"):
            return _refuse(
                captured.get("code") or "SOURCE_UNRESOLVED",
                "the request could not be captured durably: "
                + str(captured.get("detail") or captured),
                **identity,
            )
        captured_receipt = captured.get("receipt")
        linked_work = linked_work or captured.get("linked_work")

    # A live FOREIGN seat is answered BEFORE reconciliation, because
    # reconciliation writes STATE for the acting actor and a project owned by
    # somebody else is not this caller's to reconcile. Answering it later
    # turned "codex is working here" into a VALIDATION_FAILED about an
    # owner/STATE split this caller had just proposed to create.
    state, board, problem = _snapshot(root)
    if state is not None and board is not None:
        seat = ownership.classify_active_ownership(
            state, board["tickets"], actor, root=root
        )
        if seat.status == ownership.FOREIGN_LIVE:
            detail, resume = _foreign_seat_route(
                seat, receipt_form=receipt is not None, queue_id=captured_receipt
            )
            return {
                "ok": False,
                "code": WAIT_FOREIGN_OWNER,
                "detail": detail,
                **identity,
                "receipt": captured_receipt,
                "ticket": None,
                "active_ticket": seat.active_ticket,
                "owner": seat.board_owner,
                "claim_time": seat.claim_time,
                "resume_command": resume,
            }

    # Reconciliation, with the valve cleared by the new explicit task.
    reconciliation = reconcile_protocol_state(root, actor, dry_run=False)
    valve_reauthorized = False
    if reconciliation.get("safety_valve_tripped"):
        reauth = reauthorize_valve(root, actor)
        if not reauth.ok:
            return _refuse(reauth.code, reauth.message, receipt=captured_receipt, **identity)
        valve_reauthorized = True
        reconciliation = reconcile_protocol_state(root, actor, dry_run=False)
    state, board, problem = _snapshot(root)
    if (
        state is not None
        and state.get("execution_intent") == "goal"
        and ((state.get("goal_waves") or 0) >= 3 or (state.get("goal_tickets") or 0) >= 20)
    ):
        # A valve already stating its own WAIT reconciles CLEAN; the new task
        # is still the reauthorization it waits for.
        reauth = reauthorize_valve(root, actor)
        if not reauth.ok:
            return _refuse(reauth.code, reauth.message, receipt=captured_receipt, **identity)
        valve_reauthorized = True
    preserved = _decisions_of(reconciliation)

    def wait_on_decision(detail: str, ticket: str | None, refusal: dict | None = None) -> dict:
        decision = next((item for item in preserved if item.get("command")), None)
        if decision is None:
            return _refuse(
                (refusal or {}).get("code") or "VALIDATION_FAILED",
                detail,
                receipt=captured_receipt,
                ticket=ticket,
                valve_reauthorized=valve_reauthorized,
                resume_command=f"saipen start --receipt {captured_receipt}",
                reconciliation=reconciliation if not reconciliation.get("ok") else None,
                refusal=refusal,
                **identity,
            )
        return _decision_wait(
            decision,
            receipt=captured_receipt,
            ticket=ticket,
            detail=detail,
            refusal=refusal,
            valve_reauthorized=valve_reauthorized,
            **identity,
        )

    if preserved:
        # P0-7 negative control. The new explicit task IS the human authority
        # for the safety valve -- and for NOTHING else. An operator gate that
        # was already open when the task arrived is answered by the operator,
        # once, with its exact command; START never consumes it by walking
        # past it, and never asks a second time after it is answered.
        return wait_on_decision(
            f"the request is durable as {captured_receipt}; one operator decision is "
            "open in this project and must be answered before new Work is projected",
            None,
        )

    # 3. Project the receipt as Work (idempotent on the receipt's bytes).
    tickets = (board or {}).get("tickets") or {}
    ticket = linked_work if linked_work in tickets else None
    if ticket is None and captured_receipt:
        existing = existing_work_for_request(root, tickets, text)
        if existing is not None:
            bound = _bind_duplicate_ingress(root, captured_receipt, existing, tickets[existing])
            if not bound.get("ok"):
                return wait_on_decision(
                    f"the request repeats {existing} but could not be bound to it: "
                    f"{bound.get('code')} {bound.get('detail') or ''}".strip(),
                    existing,
                    bound,
                )
            ticket = existing
    if ticket is None:
        projected = user_request(
            root,
            actor,
            text,
            priority=priority,
            verify=verify_text,
            needs=needs,
            supersedes=supersedes,
        )
        if not projected.ok:
            return wait_on_decision(
                "the request is durable as "
                + str(captured_receipt)
                + " but could not become Work: "
                + str(projected.message),
                None,
                projected.to_dict(),
            )
        ticket = projected.data.get("ticket")
        # T-1474, GOAL-01 Entry (MAINTENANCE 2.4): a request projected as NEW
        # Work is a new objective, and its run starts with both counters at 0.
        # Only a tripped valve was reset here, so SRC-107 (/goal) inherited
        # 1 wave / 18 tickets and would have tripped after two VERIFY passes.
        # An echo bound to existing Work never reaches this branch (T-1469).
        state, board, problem = _snapshot(root)
        if state is not None and not (
            state.get("execution_intent") == "goal"
            and not state.get("goal_waves")
            and not state.get("goal_tickets")
        ):
            objective = " ".join(str(text or "").split())[:200]
            pivot = set_goal_intent(root, actor, f"{ticket} ({captured_receipt}): {objective}")
            if not pivot.ok:
                return wait_on_decision(
                    f"{ticket} was projected but its goal Entry could not be recorded: "
                    f"{pivot.code} {pivot.message or ''}".strip(),
                    ticket,
                    pivot.to_dict(),
                )
            state, board, problem = _snapshot(root)
        tickets = (board or {}).get("tickets") or {}
    if state is None or board is None:
        return wait_on_decision(
            f"canonical state is unreadable after projecting {ticket}: {problem}", ticket
        )
    record = tickets.get(ticket) or {}
    section = record.get("section")
    base = {
        **identity,
        "receipt": captured_receipt,
        "ticket": ticket,
        "valve_reauthorized": valve_reauthorized,
        "preserved_decisions": preserved,
    }
    if section == "## DONE":
        return _refuse(
            "TICKET_ALREADY_DONE",
            f"this exact request was already completed as {ticket}; state what is new",
            **base,
        )
    if section == "## BLOCKED":
        return _decision_wait(
            {
                "field": "blocker",
                "surface": "board",
                "ticket": ticket,
                "command": f"saipen ticket unblock {ticket} <decision>",
                "reason": str((record.get("fields") or {}).get("blocker") or "")[:400],
            },
            receipt=captured_receipt,
            ticket=ticket,
            detail=f"the request's Work {ticket} is BLOCKED",
            **identity,
        )

    # 4. The seat.
    seat = ownership.classify_active_ownership(state, tickets, actor, root=root)
    parked = None
    if seat.active_ticket == ticket and seat.status == ownership.SELF:
        phase = state.get("phase") if state.get("task") == ticket else "SCOUT"
        return {
            "ok": True,
            "code": STARTED,
            **base,
            "resumed": True,
            "phase": phase,
            "action": f"PHASE {phase} {ticket}",
            "next_action": state.get("next_action"),
            "parked": None,
        }
    if seat.status == ownership.FOREIGN_LIVE:
        detail, resume = _foreign_seat_route(
            seat, receipt_form=receipt is not None, queue_id=captured_receipt or ticket
        )
        return {
            "ok": False,
            "code": WAIT_FOREIGN_OWNER,
            "detail": detail,
            **base,
            "active_ticket": seat.active_ticket,
            "owner": seat.board_owner,
            "claim_time": seat.claim_time,
            "resume_command": resume,
        }
    if seat.status == ownership.INVALID:
        return wait_on_decision(
            f"{seat.active_ticket} carries an INVALID claim pair; it must be repaired "
            "before any seat can change",
            ticket,
        )
    if seat.active_ticket and seat.active_ticket != ticket:
        active = seat.active_ticket
        resume_phase = state.get("phase")
        if seat.status in (ownership.UNCLAIMED, ownership.FOREIGN_STALE):
            adopted = _call(apply_claim, root, active, actor, explicit=True)
            if not adopted.get("ok"):
                return wait_on_decision(
                    f"{active} holds the only DOING seat with a lapsed claim and could not "
                    f"be adopted to park it: {adopted.get('message') or adopted.get('detail')}",
                    ticket,
                    adopted,
                )
            state, board, problem = _snapshot(root)
            resume_phase = (state or {}).get("phase") or resume_phase
        if resume_phase not in _WORK_PHASES:
            return wait_on_decision(
                f"{active} is DOING but STATE is {resume_phase!r}, not an execution phase; "
                "it cannot be parked with a resume point",
                ticket,
            )
        pending_wait = str((state or {}).get("next_action") or "")
        reason = (
            f"PAUSED by user request {captured_receipt}: explicit new task {ticket} takes "
            f"the seat; resumes at {resume_phase} when {ticket} closes"
        )
        if pending_wait.startswith("WAIT:"):
            reason += f"; pending {pending_wait[:160]}"
        parked_result = _call(
            ticket_move, root, "block-for", active, actor, reason, blocked_on=ticket
        )
        if not parked_result.get("ok"):
            return wait_on_decision(
                f"own interrupted Work {active} could not be parked: "
                f"{parked_result.get('message') or parked_result.get('detail')}",
                ticket,
                parked_result,
            )
        parked = {"ticket": active, "resume_phase": resume_phase, "blocked_on": ticket}

    # 5. Claim into SCOUT.
    claimed = _call(apply_claim, root, ticket, actor, explicit=True)
    if not claimed.get("ok"):
        return wait_on_decision(
            f"{ticket} could not be claimed: {claimed.get('message') or claimed.get('detail')}",
            ticket,
            claimed,
        )
    return {
        "ok": True,
        "code": STARTED,
        **base,
        "resumed": False,
        "phase": claimed.get("phase") or "SCOUT",
        "action": f"PHASE {claimed.get('phase') or 'SCOUT'} {ticket}",
        "next_action": claimed.get("next_action"),
        "event_id": claimed.get("event_id"),
        "parked": parked,
    }


def _call(operation, *args, **kwargs) -> dict:
    """One canonical operation as a result record; a raise is a refusal."""
    from .operations import CheckpointError, HomeDeadError, StateMalformedError

    try:
        result = operation(*args, **kwargs)
    except HomeDeadError as exc:
        return {"ok": False, "code": "HOME_REQUIRED", "detail": str(exc)}
    except (StateMalformedError, CheckpointError, ValueError) as exc:
        return {"ok": False, "code": getattr(exc, "code", "VALIDATION_FAILED"), "detail": str(exc)}
    return result.to_dict() if hasattr(result, "to_dict") else dict(result)
