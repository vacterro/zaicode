"""Shared deterministic next-action router (NITRO dogfood II, T-590).

One pure function implements the deterministic parts of CORE section 1.11's
action priority -- RECOVER > UNBLOCK > FINISH > START > MAINTAIN -- from a
parsed STATE + BOARD + recovery state. `saipen status`, `saipen next` and the
context compiler all consume THIS router, never separate routing logic.

It deliberately does NOT decide semantic architecture questions (whether a
transition deserves REVIEW, whether a goal is satisfied); it computes the
exact next EXECUTABLE mechanical action the state demands.
"""

from __future__ import annotations

from pathlib import Path

from . import ownership, phases
from .audit_route import audit_route_owns
from .board import (
    board_graph_errors,
    goal_blocked_tickets,
    is_user_explicit,
    operator_gates,
    parse_board,
    pick_next_work,
)
from .result import Result
from .state import binding_brake


def _top_workable(board: dict, agent: str | None = None, now=None) -> str | None:
    """Backward-compatible name for the BOARD Pick Rule's chosen ticket.

    CORE-003: the rule itself now lives in `board.pick_next_work` -- ONE pure
    selector the router, the projection, the persisted-`next_action`
    recomputation and the validator all consume. This wrapper keeps existing
    callers working while the decision has exactly one home.
    """
    return pick_next_work(board["tickets"], agent=agent, now=now)[0]


def route_next(
    state_text: str,
    board_text: str,
    pending_ops: list | None = None,
    conflict_ops: list | None = None,
    now: datetime.datetime | None = None,  # noqa: F821
    current_capability: str | None = None,
    current_agent: str | None = None,
    snap=None,
    audit_inbox: dict | None = None,
    queued_source: dict | None = None,
    pending_append: dict | None = None,
    # PERF-004: optional pre-parsed objects from the caller to avoid
    # redundant STATE/BOARD parsing. When provided, these take precedence
    # over parsing state_text/board_text.
    _state: dict | None = None,
    _board: dict | None = None,
    _state_error: str | None = None,
) -> dict:
    """Compute the exact next executable action.

    Returns a dict with `action` (an executable mechanical action), `reason`
    (which priority rule fired), and optional `ticket`/`detail`. Never echoes
    STATE.next_action -- it is a projection, not a mirror (NITRO dogfood II).
    `now` (UTC) drives § 1.4 claim-liveness for the active-ticket binding; tests
    inject a fixed instant (P0 claim-ownership truth).

    `current_capability` is the FRESHLY NEGOTIATED session capability
    ("full"/"read-only"/...), supplied by the caller. CORE § 1.3: a persisted
    `STATE.mode` is only the LAST handshake outcome and MUST NOT prove current
    authority, so routing never infers write authority from STATE.mode -- it
    gates only on an explicit current-capability value when one is supplied.

    `current_agent` is the canonical acting identity (T-1006): the ONE
    resolver in tools/saipen.py INHERITS persisted STATE.agent for a bare CLI
    and journals an explicit old -> new DEC for a genuine `--agent` handover.
    Claim truth and workability are judged relative to THAT value, never by
    reading STATE.agent a second time here -- a genuinely different actor B
    entering state last written by A must see A's live claim as FOREIGN_LIVE
    and refuse takeover, not impersonate A. When `current_agent` is None (a
    caller that does not know its own identity), routing falls back to the
    historical value for backward compatibility of pure-semantic callers,
    but the CLI/adapters always supply the resolved identity.

    `audit_inbox` is the Audit Inbox's READ-ONLY structural projection
    (`audit_inbox.projection`), supplied by the caller because this function
    stays pure -- it never touches the filesystem. `SOURCE-AUDIT-INBOX-01`
    places it AFTER recovery / WAIT / active continuation and BEFORE the
    ordinary BOARD Pick Rule: a fresh external audit usually corrects current
    project truth and must not sit unseen behind a stale backlog, but it never
    preempts a legitimately active ticket mid-transaction.
    """
    pending = list(pending_ops or [])
    conflicts = list(conflict_ops or [])
    # PERF-004: parse STATE/BOARD ONCE and reuse the result for both the
    # checkpoint-surface validation and the routing logic below. When the
    # caller provides pre-parsed objects, skip parsing entirely.
    from .state import parse_state_or_error

    if _state is not None and _board is not None:
        # PERF-004: the pre-parsed seam. `_state_error` may be None -- the
        # NORMAL "no parse error" case -- so it is NOT part of the guard; a
        # clean pre-parsed call must not silently fall through to re-parsing.
        state, state_error, board = _state, _state_error, _board
    else:
        state, state_error = parse_state_or_error(state_text)
        board = parse_board(board_text)
    if snap is not None:
        from .fast_check import validate_checkpoint_surface

        errors = validate_checkpoint_surface(
            state_text,
            board_text,
            snap,
            current_agent=current_agent,
            _state=state,
            _board=board,
            _state_error=state_error,
        )
        if errors:
            # The route is `recover`, never `status`. Naming the command that
            # just refused is the self-loop measured in the field: a stranded
            # session reads `action` as an instruction, runs it, gets the same
            # refusal and the same instruction, and stops. `recover` is the one
            # canonical entry that owns an invalid checkpoint surface, and it
            # answers with either the exact approval command or a named
            # operator decision -- both of which are somewhere to GO.
            return {
                "ok": False,
                "action": "saipen recover",
                "reason": "checkpoint-invalid",
                "detail": "checkpoint invalid: " + "; ".join(errors[:3]),
            }
    # A STATE the shared parser cannot read whole is not a routing surface:
    # duplicate keys or a broken fence must never project an executable next
    # action from a partial parse (T-1003 hostile findings). Fail closed.
    if state_error:
        return {
            "ok": False,
            "action": "saipen recover",
            "reason": "state-malformed",
            "detail": f"STATE parse error: {state_error}",
        }
    # Empty STATE is bootstrap-only (hostile-regression, P1): a file with no
    # frontmatter reads as {} for status display, but it is NOT a routing
    # surface -- there is no phase, no agent, no continuation to project.
    # Only a fresh bootstrap may sit here, and the routed action for a
    # bootstrap is the INIT entry, never an ordinary maintenance/start
    # projection.
    if not state:
        return {
            "ok": True,
            "action": "saipen status",
            "reason": "bootstrap",
            "executable_behavior": "RESTATE_AND_STOP",
            "detail": "empty STATE is bootstrap-only; no continuation "
            "exists yet -- bootstrap via INIT before routing",
        }
    phase = state.get("phase")
    task = state.get("task")
    na = state.get("next_action") or ""

    # Second-wave P0: the CURRENT-SESSION actor, never STATE.agent. STATE.agent
    # is historical last-writer evidence; claim truth and workability are judged
    # relative to the identity the caller actually IS.
    session_agent = current_agent if current_agent is not None else state.get("agent")

    # CURRENT-SESSION CAPABILITY gate (CORE § 1.3): only an explicitly supplied,
    # freshly negotiated capability may grant/revoke write authority. A persisted
    # STATE.mode is the LAST handshake outcome and is NEVER used to infer current
    # authority (a stale read-only must not suppress a newly writable session,
    # nor a stale full route mutation into a newly read-only one). Callers that
    # do not pass current_capability get pure state-semantic routing.
    #
    # A capability that was supplied but is not one of the four closed values is
    # a broken handshake, never permission: fail closed rather than route as if
    # the session were writable.
    if current_capability is not None:
        from .capability import capability_error

        _cap_problem = capability_error(current_capability)
        if _cap_problem is not None:
            return {
                "ok": False,
                "action": "saipen status",
                "reason": "capability-invalid",
                "detail": _cap_problem,
            }
    if current_capability == "read-only":
        return {
            "ok": True,
            "action": "saipen status",
            "reason": "read-only-mode",
            "executable_behavior": "RESTATE_AND_STOP",
            "detail": "current session capability is read-only; no mutating "
            "next action may be routed -- inspect only",
        }

    # RECOVER outranks everything (after the read-only brake): an unresolved
    # op or conflict must be resolved before any canonical work.
    if conflicts:
        return {
            "ok": False,
            "action": "saipen recover",
            "reason": "recovery-conflict",
            "detail": f"unresolved conflict: {', '.join(conflicts)}",
        }
    if pending:
        return {
            "ok": False,
            "action": "saipen recover",
            "reason": "recovery-pending",
            "detail": f"unresolved operation: {', '.join(pending)}",
        }

    # A board the shared parser cannot read whole (an unrecognized ticket
    # field, a malformed ticket line, a missing heading) is not a work
    # surface: a typo'd `| blockr:` is exactly how a blocker-bearing ticket
    # launders itself into workable, so malformed input must FAIL the route
    # (ok: false, VALIDATION_FAILED) -- never a successful projection from
    # corrupt input. status/next/context propagate the failure; the parser
    # diagnostics stay in `detail` and recovery flags stay truthful.
    if board["errors"]:
        return {
            "ok": False,
            "action": "saipen status",
            "reason": "board-malformed",
            "detail": "BOARD parse error(s): " + "; ".join(board["errors"][:3]),
        }

    doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
    active = doing[0]["id"] if doing else None

    # BINDING BRAKE (T-1322, parity T-1324/H): the ONE authoritative hard-stop
    # truth, shared with the mutation admission guard (`state.binding_brake`).
    # It is evaluated BEFORE any board reasoning: a braked project is not a
    # work surface, so the router must never advertise a board mutation
    # (`saipen claim`, `PHASE ...`) that the guard -- which admits only
    # `recover` while braked -- would refuse. The guard used to honour a
    # non-empty STATE.blocker while the router only looked at phase==BLOCKED
    # and a persisted WAIT, so `continue` advertised work the guard refused
    # (AUDAPACK: SCOUT with an EXTERNAL blocker routed as runnable). The brake
    # carries the same contextual `binding_wait` rule the WAIT branch always
    # used, so CORE's DONE+empty-TODO UNBLOCK exception is preserved.
    _empty_todo = not any(t["section"] == "## TODO" for t in board["tickets"].values())
    _brake = binding_brake(state, empty_todo=_empty_todo)
    if _brake is not None:
        _kind, _detail = _brake
        if _kind == "wait":
            # CORE-004: the safety valve is an AUTHORIZATION boundary, not a
            # resumable yield. Once the 3-wave / 20-ticket budget is exhausted,
            # the persisted WAIT is a HARD STOP (RESTATE_AND_STOP) until the
            # documented re-authorization operation durably resets the counters.
            return {
                "ok": True,
                "action": na,
                "reason": "wait",
                "executable_behavior": "RESTATE_AND_STOP",
                "detail": "persisted WAIT is a hard stop; do not route past it",
            }
        # phase BLOCKED or a non-empty STATE.blocker: a hard stop, whatever the
        # board holds. UNBLOCK is a routing-priority NAME (CORE 1.11), not
        # necessarily a `ticket unblock` command -- the router must not emit a
        # mutation the executor refuses.
        return {
            "ok": True,
            "action": "saipen status",
            "reason": "unblock",
            "executable_behavior": "RESTATE_AND_STOP",
            "detail": _detail,
        }

    # OPERATIONAL APPEND (SRC-104 / T-1461). An append the operator made
    # durable for this mission changes what the active phase has to do, so it
    # is projected BEFORE any phase continuation -- continuing BUILD as if the
    # new requirement had not arrived is the "read it, summarized it, carried
    # on" failure in mechanical form. Only the seat holder projects (the
    # projection may rewind the active Work); a foreign, invalid or adoptable
    # seat falls through to the binding rules below. An unreadable ledger never
    # blocks valid Work: it falls through too and `source appends` names it.
    if pending_append and not pending_append.get("invalid"):
        _append_seat_ok = True
        if active:
            _append_own = ownership.classify_active_ownership(
                state, board, session_agent, now=now
            )
            _append_seat_ok = _append_own.status == "SELF" and not _append_own.misbound
        if _append_seat_ok:
            return {
                "ok": True,
                "action": pending_append["action"],
                "reason": "unprojected-source-append",
                "receipt": pending_append.get("receipt"),
                "source_receipt": pending_append.get("source"),
                "ticket": active,
                "detail": pending_append.get("detail"),
            }

    # BINDING (hostile-regression, P0): STATE.task binds BOARD.DOING only where
    # this agent actually OWNS or ADOPTS the active ticket. The ONE
    # claim_status classifier decides: a runtime-fresh FOREIGN_LIVE or INVALID
    # claim changes the rule.
    #   - INVALID (half owner/claim_time pair, non-UTC stamp): fail closed.
    #   - FOREIGN_LIVE: another agent is actively working it; a foreign-owned
    #     DOING with observer STATE.task:none is VALID multi-agent state and
    #     routes NON-MUTATING (observe, do not take over).
    #   - SELF (this agent owns it): binding is mandatory; task:none fails.
    #   - UNCLAIMED / FOREIGN_STALE: adoptable orphan/stale DOING; task:none is
    #     fine and routes to ADOPT it.
    if active:
        # CORE-002 (SRC-026:R002): the ownership decision comes from the ONE
        # shared classifier the active-mutation authorization gate consumes,
        # evaluated at the SAME instant. Two independent readings of the same
        # snapshot are how `route_next` came to advertise `PHASE BUILD T-1298`
        # while `_active_claim_refusal` refused that exact mutation.
        _own = ownership.classify_active_ownership(state, board, session_agent, now=now)
        cs = _own.status
        if cs == "INVALID":
            return {
                "ok": False,
                "action": "saipen status",
                "reason": "binding-mismatch",
                "detail": f"BOARD.DOING {active} carries an INVALID claim "
                f"(half owner/claim_time pair or non-UTC stamp); "
                f"repair the claim before routing",
            }
        if cs == "FOREIGN_LIVE":
            if task and task != "none":
                return {
                    "ok": False,
                    "action": "saipen status",
                    "reason": "binding-mismatch",
                    "detail": f"STATE.task={task} but BOARD.DOING={active} "
                    f"is FOREIGN_LIVE (owned by another agent)",
                }
            return {
                "ok": True,
                "action": "saipen status",
                "reason": "foreign-live",
                "executable_behavior": "RESTATE_AND_STOP",
                "detail": f"BOARD.DOING {active} is actively owned by "
                f"another agent; observe, do not take over",
            }
        if _own.misbound:
            return {
                "ok": False,
                "action": "saipen status",
                "reason": "binding-mismatch",
                "detail": f"STATE.task={task} but BOARD.DOING={active}; "
                "repair the split before routing",
            }
        if cs in ("UNCLAIMED", "FOREIGN_STALE"):
            # CORE-002: an adoptable orphan/stale DOING routes to the EXPLICIT
            # claim action whether or not a stale STATE.task still names it.
            # The old rule only fired at `task: none`, so a stale foreign
            # owner with the ticket still bound fell through to the ordinary
            # FINISH branch and advertised `PHASE <phase> T-###` -- a mutation
            # `_active_claim_refusal` refuses until adoption happens. The
            # advertised string is the authorization gate's own remedy, from
            # `ownership.adoption_action`, so router and executor cannot word
            # the same requirement two ways.
            _owner = _own.board_owner
            return {
                "ok": True,
                "action": ownership.adoption_action(active),
                "reason": "adopt",
                "ticket": active,
                "ownership": cs,
                "detail": (
                    f"BOARD.DOING {active} carries no live claim of this "
                    f"session's own (owner {_owner or 'none'!r}, {cs}); "
                    f"explicit adoption is required before any active-ticket "
                    f"mutation"
                ),
                "load": load_for_action(ownership.adoption_action(active)),
            }
        if cs == "SELF" and not _own.bound:
            return {
                "ok": False,
                "action": "saipen status",
                "reason": "binding-mismatch",
                "detail": f"STATE.task is none but BOARD.DOING={active} is "
                f"this agent's own SELF claim; bind STATE.task",
            }
    elif task and task != "none":
        return {
            "ok": False,
            "action": "saipen status",
            "reason": "binding-mismatch",
            "detail": f"STATE.task={task} but no BOARD.DOING ticket; "
            "repair the split before routing",
        }

    # FINISH: phase in a ticket-bearing phase with an active ticket -> the
    # persisted next_action names the exact phase work; fall back to the
    # persisted value only when it is still a legal PHASE action for the
    # active ticket.
    if active and phase in phases.TICKET_BEARING_PHASES:
        if na.startswith("PHASE ") and task and task == active:
            return {
                "ok": True,
                "action": na,
                "reason": "finish",
                "ticket": active,
                "load": load_for_action(na),
            }
        if na.startswith(("RUN:", "RESUME:")) and task == active:
            return {
                "ok": True,
                "action": na,
                "reason": "finish",
                "ticket": active,
                "load": load_for_action(na),
            }
        return {
            "ok": True,
            "action": f"PHASE {phase} {active}",
            "reason": "finish",
            "ticket": active,
            "load": load_for_action(f"PHASE {phase} {active}"),
        }

    # Phase-owned partial continuation (T-1011): an UNFINISHED MARKHUNT pass
    # owns the next action even under an outer converge/crew target.
    # `phases/markhunt.md` makes `next_action: "saipen markhunt"` the resume
    # marker of a partial pass (manifest cursor: partial) -- routing must
    # continue THAT sweep until its manifest closes, never exit the audit
    # campaign to crew while findings are still being recorded. The persisted
    # crew intent is left untouched and resumes after MARKHUNT legitimately
    # closes (the crew branch below then owns continuation again).
    if phase == "MARKHUNT" and na.startswith("saipen markhunt"):
        return {
            "ok": True,
            "action": na,
            "reason": "markhunt-continue",
            "load": load_for_action(na),
            "detail": "partial MARKHUNT pass owns continuation until its manifest closes",
        }

    # QUEUED EXPLICIT USER SOURCE (T-1436): a request the operator already
    # submitted while the seat was busy is DURABLE QUEUE TRUTH, not a command
    # to retype. Once no active continuation owns the seat, the OLDEST
    # unprojected operator Source is STARTED through the canonical ingress
    # BEFORE persisted converge intent and speculative backlog. It can never
    # preempt a live ticket: every active/continuation branch above returned
    # first.
    #
    # T-1446 cc-all-recovery ordering refinement: the queue sits BELOW the
    # shared Pick Rule's `user_explicit` tier, not above the whole BOARD. The
    # incident proved the failure mode: a stale unprojected wave brief (days
    # old, its Work already DONE) took the START seat from the live workable
    # user_explicit mission and the project looked DONE-idle. A queued Source
    # is still an operator request that outranks ordinary backlog -- the
    # Pick Rule itself starts a fresh projection for it -- but the LIVE
    # user_explicit Work on the BOARD outranks a stale unlinked brief.
    if not active and queued_source:
        if queued_source.get("invalid"):
            return {
                "ok": True,
                "action": queued_source.get("action", "saipen source status"),
                "reason": "queued-source-invalid",
                "executable_behavior": "RESTATE_AND_STOP",
                "detail": queued_source.get(
                    "detail", "the queued Source projection is unreadable"
                ),
            }
        # T-1446: a workable user_explicit Work outranks the stale queue.
        # T-1458: so does a dependency reservation. `ticket block-for` parks
        # the live mission on its child and CONTINUATION_RESERVED refuses
        # every unrelated claim, so routing the queue there emitted a start
        # the reservation (or the receipt gate) refuses. The reserved child IS
        # the parked mission's continuation, not backlog.
        _top, _pick_reason = pick_next_work(board["tickets"], agent=session_agent, now=now)
        _outranks_queue = _top is not None and (
            _pick_reason == "dependency-continuation"
            or is_user_explicit(board["tickets"].get(_top, {}))
        )
        if not _outranks_queue:
            return {
                "ok": True,
                "action": queued_source["action"],
                "reason": "queued-source",
                "receipt": queued_source.get("receipt"),
                "detail": queued_source.get(
                    "detail", "queued explicit user Source owns continuation"
                ),
            }
        # Fall through to the START branch below, which re-derives the same
        # pick; the queued Source stays projected for when the mission closes.

    # Crew is an outer convergence target. Once local ticket execution has no
    # immediate continuation, ordinary `cc` returns to crew orchestration from
    # persisted semantics rather than relying on a lucky next_action string.
    if state.get("execution_intent") == "converge" and state.get("converge_target") == "crew":
        return {
            "ok": True,
            "action": "saipen crew",
            "reason": "crew-converge",
            "detail": "active crew target owns continuation",
        }

    # AUDIT INBOX (SOURCE-AUDIT-INBOX-01): an unconsumed external audit layer
    # outranks SELECTION of unrelated queued TODO. It sits here on purpose --
    # every active-continuation branch above has already returned, so a fresh
    # file can never steal ownership from a live BUILD/VERIFY/REVIEW
    # transaction; it only wins the START decision that has not been made yet.
    # `invalid_only` and `residue_only` are NOT routed here: an unreadable
    # layer and an uncaptured leftover are diagnostics that must not outrank
    # real workable BOARD Work (both are surfaced below, before the project
    # can call itself idle).
    if not active and audit_inbox and audit_route_owns(
        audit_inbox, board["tickets"], agent=session_agent, now=now
    ):
        routed_audit = {
            "ok": True,
            "action": audit_inbox["action"],
            "reason": "audit-inbox",
            "detail": audit_inbox.get("detail", "audit inbox owns continuation"),
            "audit_layer": audit_inbox.get("layer"),
            "audit_path": audit_inbox.get("path"),
            "load": load_for_action(audit_inbox["action"]),
        }
        if audit_inbox.get("work"):
            routed_audit["ticket"] = audit_inbox["work"]
        return routed_audit

    # START: no DOING + a workable TODO -> the ONE shared Pick Rule chooses.
    # CORE-003: explicit user intent outranks speculative backlog inside this
    # stage; the selector is `board.pick_next_work`, the same function the
    # projection, the persisted-`next_action` recomputation and the validator
    # call, so a persisted pick and a fresh route cannot name different work.
    if not active:
        top, pick_reason = pick_next_work(board["tickets"], agent=session_agent, now=now)
        if top is not None:
            return {
                "ok": True,
                "action": f"PHASE SCOUT {top}",
                "reason": pick_reason,
                "ticket": top,
                "detail": (
                    "topmost workable explicit user request"
                    if pick_reason == "start-user-explicit"
                    else "topmost workable ticket"
                ),
                "load": load_for_action(f"PHASE SCOUT {top}"),
            }
        # A cyclic or dangling `needs:` graph with NOTHING workable is corrupt
        # work state, not "no work left" (4th-wave P1#4): routing to
        # maintenance / `saipen continue` there hides the damage behind a
        # healthy-looking action. The gate sits HERE, after the Pick Rule, on
        # purpose: CORE § 1.2's remedy for a cycle or a dangling reference is to
        # block that ticket and KEEP WORKING the other tickets, so a broken edge
        # must never suppress a genuinely workable one.
        _graph_errors = board_graph_errors(board["tickets"])
        if _graph_errors:
            return {
                "ok": False,
                "action": "saipen status",
                "reason": "board-graph-invalid",
                "detail": "BOARD needs: graph invalid with no workable "
                "ticket: " + "; ".join(_graph_errors[:3]),
            }

        # T-1429: an operator due-time GATE is a REAL human boundary, never a
        # maintenance candidate and never a fabricated agent action. It fires
        # here, after no Work remains workable: with unrelated agent-owned Work
        # eligible the gates stay visible as SIDE STATE and that Work is
        # selected (the pick above already won). When NOTHING agent-owned is
        # executable and a gate is due, the truthful next action is the
        # operator boundary itself -- NOT GOAL_BLOCKED (which means something
        # different) and never an invented `continue`.
        _gates = operator_gates(board["tickets"], now=now)
        if _gates:
            _due = [g for g in _gates if g["state"] == "DUE_OPERATOR_ACTION"]
            if _due:
                return {
                    "ok": True,
                    "action": "saipen status",
                    "reason": "operator-gate-due",
                    "stop_reason": "OPERATOR_ACTION_DUE",
                    "executable_behavior": "RESTATE_AND_STOP",
                    "requires_human": True,
                    "operator_gates": _gates,
                    "detail": (
                        "no unrelated executable Work remains and the operator "
                        "gate is due: " + ", ".join(g["ticket"] for g in _due)
                        + " is operator-actionable now (DUE_OPERATOR_ACTION); "
                        "this is a human boundary -- the operator gate is "
                        "surfaced, not executed"
                    ),
                }
            return {
                "ok": True,
                "action": "saipen status",
                "reason": "operator-gate-deferred",
                "executable_behavior": "RESTATE_AND_STOP",
                "requires_human": True,
                "operator_gates": _gates,
                "detail": (
                    "no unrelated executable Work remains; the operator gate "
                    + ", ".join(g["ticket"] for g in _gates)
                    + " is DEFERRED_OPERATOR until its retry_not_before "
                    "instant -- the loop waits truthfully, it does not "
                    "manufacture agent Work"
                ),
            }

        # GOAL_BLOCKED (CORE-003): a clean stop, and ONLY when it is true --
        # nothing active, nothing workable, and at least one blocker that
        # explicitly claims GOAL scope. A ticket-scope blocker never reaches
        # here with work still available, which is the whole point: the
        # FastPrompter loop stopped because one parked ticket was read as a
        # global halt.
        _goal_blocked = goal_blocked_tickets(board["tickets"])
        if _goal_blocked:
            _blocked = [
                t["id"] for t in board["tickets"].values() if t["section"] == "## BLOCKED"
            ]
            return {
                "ok": True,
                "action": "saipen status",
                "reason": "goal-blocked",
                "stop_reason": "GOAL_BLOCKED",
                "executable_behavior": "RESTATE_AND_STOP",
                "blocked": _blocked,
                "goal_blocked": _goal_blocked,
                "detail": "no workable Work remains and "
                + ", ".join(_goal_blocked[:3])
                + " declares a GOAL-scope blocker; this is a legitimate stop, "
                "not an idle project",
            }

    # A deliberately unreadable audit layer is NOT an idle project. Nothing
    # workable remains at this point, so surfacing the invalid inbox here --
    # before any maintenance/Improve verdict -- is the difference between
    # "your audit file is broken" and a silent "nothing to do".
    if audit_inbox and audit_inbox.get("invalid_only"):
        return {
            "ok": True,
            "action": audit_inbox.get("action", "saipen audit status"),
            "reason": "audit-inbox-invalid",
            "executable_behavior": "RESTATE_AND_STOP",
            "detail": audit_inbox.get(
                "detail", "audit inbox holds only invalid layer(s); it is not idle"
            ),
        }

    # Every layer settled, but `audit/` still holds bytes SAIPEN never
    # captured. The work is genuinely finished, so this is not a failure and
    # never a refusal -- it is the difference between "the audit is closed"
    # and "the audit directory is clean", which are not the same claim.
    if audit_inbox and audit_inbox.get("residue_only"):
        return {
            "ok": True,
            "action": audit_inbox.get("action", "saipen audit status"),
            "reason": "audit-inbox-residue",
            "executable_behavior": "RESTATE_AND_STOP",
            "detail": audit_inbox.get(
                "detail", "audit inbox is settled but the directory is not clean"
            ),
        }

    # IMPROVE GATE (T-1415): the typed no-improve-before-gate hold. It sits
    # AFTER every executable-work branch above -- active continuation, the
    # audit inbox, the BOARD Pick Rule -- and BEFORE the idle-maintain verdict
    # the Improve fallthrough consumes. The defect class it ends: deterministic
    # work reaches DONE, a parked operator-only gate owns the next real
    # decision, the operator said once "no more Improve before that gate", and
    # the prose was not routing -- `continue` prepared Improve cycles the
    # operator aborted by hand. A gate that has RESOLVED (DONE, or gone from
    # BOARD) is inert here too: reconciliation removes the field, and routing
    # degrades to ordinary maintenance even before that clear lands.
    _gate = str(state.get("improve_gate") or "").strip()
    if _gate:
        _gate_ticket = board["tickets"].get(_gate)
        if _gate_ticket is not None and _gate_ticket.get("section") != "## DONE":
            return {
                "ok": True,
                "action": "saipen status",
                "reason": "improve-gate",
                "executable_behavior": "RESTATE_AND_STOP",
                "ticket": _gate,
                "detail": (
                    f"automatic improvement discovery is held until {_gate} resolves "
                    f"(STATE.improve_gate; {_gate} is {_gate_ticket.get('section')}); "
                    f"resolve the gate or run `saipen improve unhold` to lift the hold"
                ),
            }

    # MAINTAIN: fall through to the persisted next_action only when it is a
    # legal non-ticket action (saipen continue / saipen <verb>), never a stale
    # PHASE echo and never a WAIT -- a WAIT reaching here already failed the
    # hard-stop gate above (the narrow DONE+empty-TODO exception), so it is a
    # stale WAIT to route past, not a brake to restate.
    if na.startswith("saipen ") or na.startswith("RUN:"):
        return {"ok": True, "action": na, "reason": "maintain"}
    return {
        "ok": True,
        "action": "saipen continue",
        "reason": "maintain",
        "detail": "no pending recovery, no active ticket, no workable "
        "TODO; continue ordinary maintenance",
    }


ROUTING_FAILURE_CODES = {
    # Recovery conflicts/pending are recovery work: the project holds an
    # unresolved journal.
    "recovery-conflict": "RECOVERY_CONFLICT",
    "recovery-pending": "RECOVERY_REQUIRED",
    # Everything else is a malformed/binding failure: there is NO journal to
    # recover, so recovery_pending must be false and the refusal must be a
    # validation failure -- telling the agent to recover a non-existent op
    # would send it chasing ghosts (T-1003 hostile findings).
    "state-malformed": "VALIDATION_FAILED",
    "binding-mismatch": "VALIDATION_FAILED",
    "board-malformed": "VALIDATION_FAILED",
    "board-graph-invalid": "VALIDATION_FAILED",
    "checkpoint-invalid": "VALIDATION_FAILED",
    "capability-invalid": "VALIDATION_FAILED",
    # SRC-085 M3: the conformance red gate's own outcomes. They are NOT
    # malformed-input failures -- the state is perfectly readable and the
    # remediation is executable -- so they keep their own stable codes.
    "conformance-remediation": "CONFORMANCE_UNHEALTHY",
    "conformance-unhealthy": "CONFORMANCE_UNHEALTHY",
    "conformance-unknown": "CONFORMANCE_UNKNOWN",
}


def routing_failure_code(out: dict) -> str:
    """The stable failure code for one route_next result."""
    return ROUTING_FAILURE_CODES.get(out.get("reason"), "VALIDATION_FAILED")


def pending_append_projection(project_root) -> dict | None:
    """The oldest received-but-unprojected operational append, or None.

    Read-only seam for `route_next` (SRC-104 / T-1461); the owner is
    `source_append`. A failure to read a ledger is reported as `invalid` and
    never raised: routing must not die on append metadata.
    """
    if project_root is None:
        return None
    try:
        from .source_append import pending_append_projection as _projection

        return _projection(project_root)
    except Exception as exc:  # metadata trouble never takes routing down
        return {"invalid": True, "action": "saipen source appends",
                "detail": f"append ledger unreadable ({type(exc).__name__}: {exc})"}


def queued_source_projection(project_root) -> dict | None:
    """The OLDEST unprojected explicit user Source, or None (T-1436).

    A durable queue behaves like a queue: an operator request captured while
    the seat was occupied is STARTED by the next canonical poll after the seat
    frees -- the operator never retypes `saipen start --receipt SRC-###`.
    Read-only. Only `user_instruction` Sources qualify: audit layers and
    authority captures are not queued Work.

    T-1458: `source_kind` alone is not admissibility. Operator authority
    capsules are captured as `user_instruction` too, and `start --receipt`
    refuses them, so this projection routed a start its own executor refused
    -- after every dependency park, forever. The queue now asks the SAME owner
    `start --receipt` asks (`entry.request_from_receipt`, which reads the
    receipt's request header): a receipt that is not a request is skipped, a
    receipt that cannot be read is surfaced, never skipped.

    T-1460: "unprojected" means no Work in the receipt's durable MEMBERSHIP
    (`intake.linked_works`, T-1437), not merely an empty primary. A request
    that existing Work already executed is consumed ingress once that
    consumption is bound with `saipen source link`; routing it again would
    project duplicate Work for intent the operator gave once. Measured live
    2026-09-22: SRC-082 and SRC-089 sat unbound after their Work ran, and this
    stage routed `saipen start --receipt SRC-082`.
    """
    if project_root is None:
        return None
    try:
        from . import intake
        from .entry import RECEIPT_UNREADABLE, request_from_receipt

        for item in intake.active_receipts(project_root):
            receipt = str(item.get("receipt") or "").strip()
            if not receipt:
                continue
            meta = intake._read_meta(Path(project_root), receipt) or {}
            if intake.linked_works(meta):
                continue
            if meta.get("source_kind") != "user_instruction":
                continue
            _request, problem, problem_class = request_from_receipt(
                Path(project_root), receipt
            )
            if problem_class == RECEIPT_UNREADABLE:
                return {
                    "action": "saipen source status",
                    "invalid": True,
                    "detail": (
                        f"queued Source {receipt} cannot be read ({problem}); "
                        "inspect the intake surface before treating the "
                        "project as idle"
                    ),
                }
            if problem is not None:
                continue
            return {
                "action": f"saipen start --receipt {receipt}",
                "receipt": receipt,
                "detail": (
                    f"queued explicit user request {receipt} is durable and "
                    "unprojected; this is the canonical ingress that projects "
                    "and claims it"
                ),
            }
    except Exception as exc:  # transport failure is a diagnostic, never idle
        return {
            "action": "saipen source status",
            "invalid": True,
            "detail": (
                "the queued Source projection is unreadable "
                f"({type(exc).__name__}: {exc}); inspect the intake surface "
                "before treating the project as idle"
            ),
        }
    return None


def audit_inbox_projection(project_root) -> dict | None:
    """The Audit Inbox's read-only routing projection, or None.

    The ONE seam between the pure router and the filesystem-backed inbox.
    Writes nothing. An unexpected failure does NOT fail open into "the project
    is idle": it degrades to an `invalid_only` projection so routing surfaces
    the inbox condition instead of letting Improve run over a live audit.
    """
    if project_root is None:
        return None
    try:
        from .audit_inbox import projection

        return projection(project_root)
    except Exception as exc:  # transport failure is a diagnostic, never idle
        return {
            "action": "saipen audit status",
            "invalid_only": True,
            "detail": f"audit inbox could not be classified ({type(exc).__name__}: {exc})",
            "pending": [],
            "closed_pending_delete": [],
            "invalid": [],
        }


def conformance_crew_gate(project_root, routed: dict) -> dict | None:
    """CORE-004 / T-1412: ONE conformance gate for the crew convergence route.

    Returns `routed` with the refusal merged in (`ok` False) when the mapping
    is the crew convergence route and the receipt-derived decision is not
    CURRENT_PASS; returns None when the route is not a crew route or
    conformance is healthy.

    ONE owner, two consumers: `route_next_result` (the Result wrapper) and the
    CLI's `_route_once` continuation path both call THIS function, so a
    `saipen crew` route can never be emitted by one surface while another
    refuses it. NOT_RUN is not an exemption -- absence of validator evidence is
    not health. Missing/stale evidence names a validation refresh; current
    failures name a registered repair or a terminal engineering diagnosis.
    """
    if not (
        routed.get("ok")
        and routed.get("action") == "saipen crew"
        and routed.get("reason") == "crew-converge"
        and project_root is not None
    ):
        return None
    try:
        from .conformance import (
            CONFORMANCE_UNHEALTHY,
            conformance_decision,
        )

        decision = conformance_decision(project_root, gate="core")
        if decision["healthy"]:
            return None
        command = decision["remediation_command"]
        return {
            **routed,
            "ok": False,
            "code": CONFORMANCE_UNHEALTHY,
            "action": command,
            "reason": "conformance-unhealthy",
            "detail": decision["diagnostic"]["detail"] if decision["diagnostic"] else (
                "crew convergence requires a CURRENT_PASS canonical conformance "
                f"receipt, got {decision['status']}: {decision['reason']} -- run "
                f"'{command}' before crew work"
            ),
            "conformance_status": decision["status"],
            "canonical_next_command": command,
            "diagnostic": decision["diagnostic"],
            "repair_status": decision["repair_status"],
            "terminal": command is None,
        }
    except Exception as exc:
        # W2-007: fail closed when conformance cannot be positively
        # established. An import/read/decode or unexpected runtime failure at
        # the gate disables the gate and masks its root cause if it falls
        # through to ROUTED. Route toward validate/recover instead of crew
        # execution.
        return {
            **routed,
            "ok": False,
            "code": "CONFORMANCE_UNKNOWN",
            "action": "saipen validate",
            "reason": "conformance-unknown",
            "detail": (
                f"crew convergence could not establish conformance evidence "
                f"({type(exc).__name__}: {exc}); run 'saipen validate' before crew work"
            ),
            "canonical_next_command": "saipen validate",
        }


def conformance_idle_gate(project_root, routed: dict) -> dict | None:
    """SRC-085 M3: an unaccepted CURRENT_FAIL owns IDLE continuation.

    The measured coexistence (AUDAPACK): the strict gate reported CURRENT_FAIL
    while `status` advertised `next_action: saipen continue` and
    `automation.disposition: CONTINUE`, with the accepted-debt rationale living
    only in historical LOG prose -- two incompatible machine authorities.

    This gate closes the contract for the exact measured case. The idle
    terminal route (`reason: maintain` -- no pending recovery, no active
    ticket, no workable TODO; the action is `saipen continue` or an idle
    canonical command) is rewritten to the canonical remediation when the
    authoritative decision says REMEDIATION_REQUIRED. UNPROVEN statuses
    (NOT_RUN / stale) do NOT stop a fresh project: only a CURRENT_FAIL measured
    on the CURRENT checkpoint does. No acceptance surface exists yet, so no
    unaccepted red can buy itself a CONTINUE.

    ONE owner, two consumers: `route_next_result` and the CLI continuation and
    status paths reach it through `gate_route`.
    """
    if not (
        routed.get("ok")
        and routed.get("reason") == "maintain"
        and project_root is not None
    ):
        return None
    try:
        from .conformance import (
            CONFORMANCE_DISPOSITION_REMEDIATION_REQUIRED,
            CONFORMANCE_UNHEALTHY,
            conformance_decision,
        )

        current_action = str(routed.get("action") or "").strip()
        decision = conformance_decision(project_root, gate="core")
        if decision["disposition"] != CONFORMANCE_DISPOSITION_REMEDIATION_REQUIRED:
            return None
        # T-1434 M1: the receipt's own failure-named repair wins over the
        # generic gate re-run, and naming THAT command must not wrap itself in
        # its own refusal either.
        command = decision["remediation_command"]
        if command and current_action == command:
            return None
        return {
            **routed,
            "ok": False,
            "code": CONFORMANCE_UNHEALTHY,
            "action": command,
            "reason": "conformance-remediation",
            "detail": decision["diagnostic"]["detail"] if decision["diagnostic"] else (
                "idle continuation is owned by the unaccepted conformance red "
                f"gate (CURRENT_FAIL: {decision['reason']}); run "
                f"'{command}' before continuing"
            ),
            "conformance_status": decision["status"],
            "conformance_disposition": decision["disposition"],
            "canonical_next_command": command,
            "diagnostic": decision["diagnostic"],
            "repair_status": decision["repair_status"],
            "terminal": command is None,
        }
    except Exception as exc:
        # Fail closed: an unestablished decision never yields a green-looking
        # idle continuation.
        return {
            **routed,
            "ok": False,
            "code": "CONFORMANCE_UNKNOWN",
            "action": "saipen validate",
            "reason": "conformance-unknown",
            "detail": (
                "idle continuation could not establish conformance evidence "
                f"({type(exc).__name__}: {exc}); run 'saipen validate'"
            ),
            "canonical_next_command": "saipen validate",
        }


def gate_route(project_root, routed: dict) -> dict | None:
    """The ONE ordered gate chain every production route surface applies.

    Returns the first gate's rewrite, or None when the route stands. Consumers:
    `route_next_result` and the CLI continuation, status and explain-next
    paths must agree on the executable action.
    """
    for gate in (conformance_crew_gate, closure_finish_gate, conformance_idle_gate):
        rewritten = gate(project_root, routed)
        if rewritten is not None:
            return rewritten
    return None


def closure_finish_gate(project_root, routed: dict) -> dict | None:
    """T-1403: the router must not EMIT a finish route its own closure gate
    already refuses.

    Returns `routed` rewritten to the exact legal remediation when the route is
    the finish corridor (`PHASE SHIP <ticket>`) and the current closure gate
    proves it would refuse; returns None when the route is not a finish route or
    the Work is genuinely ready to close.

    ONE owner, two consumers -- `route_next_result` (the Result wrapper) and the
    CLI's `_route_once` continuation path -- exactly like `conformance_crew_gate`.
    The router core stays PURE (it never reads the filesystem); this gate reads
    the project so it can consult the SAME closure-readiness decision the finish
    operation reads. The remediation is chosen from current source-clause truth
    (`closure_readiness.closure_readiness`), never a hardcoded
    `SOURCE_UNRESOLVED -> block`, and it is always a finite executable route.
    """
    if not (
        routed.get("ok")
        and project_root is not None
        and isinstance(routed.get("action"), str)
        and routed["action"].startswith("PHASE SHIP ")
    ):
        return None
    ticket = str(routed["action"]).split()[-1]
    try:
        from .closure_readiness import closure_readiness

        decision = closure_readiness(project_root, ticket)
    except Exception as exc:
        # Fail toward a named route, not a silent PHASE the gate will refuse.
        return {
            **routed,
            "ok": False,
            "code": "CLOSURE_UNKNOWN",
            "action": "saipen source status",
            "reason": "closure-unknown",
            "ticket": ticket,
            "detail": (
                "closure readiness could not be established "
                f"({type(exc).__name__}: {exc}); inspect the Work's linked "
                "sources before finishing"
            ),
            "canonical_next_command": "saipen source status",
        }
    if decision.get("ready"):
        return None
    route = decision.get("canonical_next_command")
    return {
        **routed,
        "ok": False,
        "code": "CLOSURE_NOT_READY",
        "action": route,
        "reason": "closure-not-ready",
        "ticket": ticket,
        "detail": (
            f"closure is not ready for {ticket} ({decision.get('code')}"
            + (
                f"; unresolved {', '.join(decision.get('unresolved') or [])}"
                if decision.get("unresolved")
                else ""
            )
            + f") -- the finite route out is `{route}`, not a finish the gate "
            "would refuse"
        ),
        "canonical_next_command": route,
        "closure_code": decision.get("code"),
        "receipt": decision.get("receipt"),
    }


def route_next_result(
    project_root,
    state_text: str,
    board_text: str,
    pending_ops_list: list | None = None,
    conflict_ops_list: list | None = None,
    snap=None,
) -> Result:
    """route_next wrapped in the stable Result shape for status/next/context."""
    out = route_next(
        state_text,
        board_text,
        pending_ops_list,
        conflict_ops_list,
        snap=snap,
        audit_inbox=audit_inbox_projection(project_root),
        queued_source=queued_source_projection(project_root),
        pending_append=pending_append_projection(project_root),
    )
    data = {k: v for k, v in out.items() if k != "ok"}
    # Capability surface (hostile-regression, P0#5): a PHASE action names the
    # phase doc it will load (saipen/phases/<phase>.md). A missing or empty
    # phase doc is a bogus checkpoint -- surface it as a routing failure so the
    # agent never boots from a phase that has no contract to execute.
    action = out.get("action")
    if out.get("ok") and isinstance(action, str) and action.startswith("PHASE "):
        load = load_for_action(action)
        if load:
            load_path = Path(project_root) / load
            if not load_path.is_file() or load_path.stat().st_size == 0:
                return Result(
                    ok=False,
                    code="VALIDATION_FAILED",
                    data={
                        "action": action,
                        "load": load,
                        "reason": "phase-doc-missing",
                        "detail": f"phase doc {load} is missing or empty",
                    },
                )
    # CORE-004 / T-1412 + T-1403 + SRC-085 M3: the ONE gate chain every
    # production route surface applies. It is applied HERE for every
    # Result-shaped route consumer and by the CLI's `_route_once` continuation
    # path and `_status` through the SAME `gate_route`, because a gate that
    # lived only in this wrapper while the production route was emitted by the
    # raw router was a route one surface refused and another handed out
    # (measured live in the T-1412 field acceptance).
    gated = gate_route(project_root, out)
    if gated is not None:
        return Result(
            ok=False,
            code=gated["code"],
            data={key: value for key, value in gated.items() if key not in ("ok", "code")},
        )
    return Result(
        ok=bool(out.get("ok")),
        code=("ROUTED" if out.get("ok") else routing_failure_code(out)),
        data=data,
    )


def load_for_action(action: str) -> str | None:
    """The phase doc the ROUTED action needs, derived from the action itself
    (NITRO dogfood III, T-591): `next.action` and `next.load` can never
    disagree. For a PHASE <X> [T-###] action the doc is phases/<x>.md; a
    recovery/command/WAIT action carries no phase doc (the command/routing
    owner governs instead).
    """
    if not action or not action.startswith("PHASE "):
        return None
    parts = action.split()
    if len(parts) < 2:
        return None
    phase = parts[1].lower()
    return f"saipen/phases/{phase}.md"
