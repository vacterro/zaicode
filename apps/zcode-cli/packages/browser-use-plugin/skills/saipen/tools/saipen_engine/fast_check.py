"""Fast proposed-state validation (NITRO integrity).

Every mutating SAIOPS operation validates its IN-MEMORY proposed result before
the journal is ever PREPARED, and re-runs the cross-file invariants on the live
files after writing before VERIFIED is marked. This module is that check. It is
FAST and deliberate: it covers exactly what SAIOPS can mutate and refuses a
mutation whose proposed state would not survive the release gate.

The full tools/validate.py remains the release/gate proof; this is
transactional safety, not a replacement.
"""

from __future__ import annotations

import re

from . import phases
from .board import (
    board_semantic_errors,
    detached_ticket_id_known_ids,
    parse_board,
    claim_status,
    board_graph_errors,
)
from .state import _current_schema_version, is_absolute_home


def _log_errors(log_text: str) -> list[str]:
    """Structural LOG errors in exactly the current diagnostic order.

    PERF-007: kept as a thin wrapper over the single-pass ``_analyze_log`` so
    every consumer shares ONE parse_log_line call per line instead of each
    re-walking the whole active LOG.
    """
    return _analyze_log(log_text).errors


def _analyze_log(log_text: str) -> "LogAnalysis":
    """PERF-007: one single-pass semantic analysis of active LOG text.

    Walks ``log_text.splitlines()`` once, invoking ``parse_log_line`` exactly
    once per non-trivial line, and returns the parsed events, the
    ``_log_errors``-equivalent ordered structural errors and the maximum/tail
    event in the same pass. Consumers that previously parsed the LOG three
    times (active-events comprehension + _log_errors + log_tail_event) now
    share this one pass. ``raw_floor``/``log_floor`` remain a deliberately
    independent implementation, so a parser bug is still caught by the second
    invariant layer.
    """
    from .log import declared_event_id, parse_log_line

    events: list[dict] = []
    errors: list[str] = []
    amnestied: list[str] = []
    seen: set[int] = set()
    parents: set[int] = set()
    prev = None
    highest = None
    # T-1285: a gap in the chain is a DEFECT by default and stays one. A
    # project that carries a documented historical hole can exempt THAT hole,
    # by name, with a recorded decision -- never by loosening the rule for
    # everything, which was measured to accept a forged log line outright.
    #
    # Resolved LAZILY, on the first gap only. An amnesty can never precede the
    # gap it covers (BOUNDING below), so it cannot be collected in this forward
    # pass -- and PERF-007 exists because this module is on every mutation's
    # write path. A project with no gap pays nothing; a gapped one pays one
    # extra walk, once.
    amnesties: dict[tuple[int, int], int] | None = None
    for lineno, line in enumerate(log_text.splitlines(), 1):
        if not line.strip():
            continue
        if line.lstrip().startswith("#"):
            continue
        parsed = parse_log_line(line)
        if parsed is None:
            errors.append(f"LOG.md:{lineno} not a legal event line")
            # The line is malformed, and the id it CLAIMS is still spent: an
            # append-only ledger never gives a number back. Stepping over the
            # slot keeps the next allocation from reusing it and keeps the
            # consecutive check from reading a damaged line as a HOLE -- which
            # is how _SAITULS (17.09.26) ended up with a `recover` whose own
            # proposal was refused for a gap the repair had just created by
            # jumping over three lines it could not parse.
            claimed = declared_event_id(line)
            if claimed is not None:
                if claimed in seen:
                    errors.append(f"LOG.md:{lineno} duplicate event E-{claimed}")
                seen.add(claimed)
                if prev is None or claimed > prev:
                    prev = claimed
                if highest is None or claimed > highest:
                    highest = claimed
            continue
        events.append(parsed)
        event = parsed["event"]
        if event in seen:
            errors.append(f"LOG.md:{lineno} duplicate event E-{event}")
        seen.add(event)
        if prev is not None and event != prev + 1:
            if amnesties is None:
                amnesties = _ledger_gap_amnesties(log_text)
            if (prev, event) in amnesties and amnesties[(prev, event)] >= event:
                # Exempted, and not invisible: carried on the analysis beside
                # the errors rather than instead of them, because a hole
                # nobody can see is the state the loosened rule produced.
                amnestied.append(
                    f"LOG.md:{lineno} E-{event} follows E-{prev} through an "
                    f"amnestied ledger gap"
                )
            else:
                errors.append(
                    f"LOG.md:{lineno} E-{event} is not consecutive after E-{prev}; "
                    f"an unexplained gap means events were lost or removed from an "
                    f"append-only ledger. A documented historical gap is exempted by "
                    f"a DEC line at or after E-{event} whose text BEGINS "
                    f"`{_GAP_AMNESTY_MARKER}E-{prev} -> E-{event}`"
                )
        prev = event
        if parsed["parent"] is not None:
            parents.add(parsed["parent"])
            if parsed["parent"] >= event:
                errors.append(
                    f"LOG.md:{lineno} parent E-{parsed['parent']} is not older than E-{event}"
                )
        if highest is None or event > highest:
            highest = event
    return LogAnalysis(tuple(events), errors, highest, tuple(amnestied))


#: A ledger-gap amnesty (T-1285). Three conditions, the same three
#: `structural_marker_events` requires and for the same reasons:
#:
#: * TAXONOMY -- a `DEC` decides; a `RUN` reporting one is not the decision.
#: * ANCHORING -- the marker BEGINS the event text. A line that merely
#:   discusses an amnesty is discussing it.
#: * BOUNDING -- twice. It names the EXACT pair it exempts, and the deciding
#:   event must itself sit at or after the gap, so an amnesty cannot cover a
#:   hole that did not exist when it was granted. Both are the property the
#:   loosened rule threw away: "gaps are fine" has no scope and no expiry.
_GAP_AMNESTY_MARKER = "LEDGER-GAP AMNESTY "
_GAP_AMNESTY_RE = re.compile(r"^LEDGER-GAP AMNESTY E-(\d+)\s*->\s*E-(\d+)\b")


def _ledger_gap_amnesties(log_text: str) -> dict[tuple[int, int], int]:
    """`(previous, next) -> newest deciding event id` for exempted gaps.

    Read from the same append-only history the gap lives in, so an amnesty is
    as durable and as auditable as the hole it covers, and cannot be supplied
    out of band by whoever happens to be running the command. The deciding id
    is returned rather than a boolean because a boolean cannot be bounded --
    that is precisely how the timestamp-inversion amnesty stayed disarmed for
    five weeks (`structural_marker_events`).
    """
    from .log import parse_log_line

    out: dict[tuple[int, int], int] = {}
    for line in log_text.splitlines():
        parsed = parse_log_line(line)
        if parsed is None or parsed.get("taxonomy") != "DEC":
            continue
        event = parsed.get("event")
        if not isinstance(event, int):
            continue
        match = _GAP_AMNESTY_RE.match((parsed.get("text") or "").strip())
        if match:
            pair = (int(match.group(1)), int(match.group(2)))
            out[pair] = max(out.get(pair, 0), event)
    return out


class LogAnalysis:
    #: `amnestied` carries the ledger gaps this history explicitly exempted
    #: (T-1285). It is separate from `errors` on purpose: an exempted gap is
    #: not a defect, and it is not invisible either. The loosened rule made
    #: every gap invisible, which is how a forged line rode through.
    __slots__ = ("amnestied", "errors", "events", "tail")

    def __init__(self, events, errors, tail, amnestied=()):
        self.events = events
        self.errors = errors
        self.tail = tail
        self.amnestied = tuple(amnestied)


def block_parked_evidence_error(
    state: dict,
    board: dict,
    events,
    *,
    planned_detail_events=frozenset(),
) -> str | None:
    """Bind the narrow mid-flight ``phase -> DONE`` exception to its event.

    ``state_contract_errors`` can validate the transition shape, but the one
    deliberate DFA exception needs cross-file proof. The most recent
    phase-changing event at or before ``STATE.last_event`` must be a canonical
    active-ticket block whose exact ticket remains in ``BOARD.BLOCKED``.
    Neutral checkpoints after the block are legal; a later claim, transition,
    finish, goal entry, or active block supersedes the old phase evidence.
    """
    source = state.get("transition_from")
    destination = state.get("phase")
    if not (
        destination == "DONE"
        and source in ("SCOUT", "BUILD", "VERIFY", "REVIEW", "SHIP")
        and not phases.transition_legal(source, destination)
    ):
        return None

    last_event = state.get("last_event")
    if not isinstance(last_event, int) or isinstance(last_event, bool):
        relevant = []
    else:
        relevant = [
            event
            for event in events
            if isinstance(event.get("event"), int) and event["event"] <= last_event
        ]

    from .log import ACTIVE_TICKET_BLOCK_MARKER, compact_detail_reference

    def detail_authority_valid(event: dict) -> bool:
        text = str(event.get("text") or "")
        claims_detail = text.startswith(ACTIVE_TICKET_BLOCK_MARKER) and (
            "detail_ref:" in text or "structural_event:" in text
        )
        if not claims_detail:
            return True
        compact = compact_detail_reference(text)
        if compact is not None and compact[1] is None:
            return False
        return bool(
            event.get("detail_integrity") == "valid"
            or event.get("event") in planned_detail_events
        )

    def is_active_block(event: dict) -> bool:
        ticket_id = event.get("ticket")
        ticket = board.get("tickets", {}).get(ticket_id) if ticket_id else None
        return bool(
            ticket is not None
            and ticket.get("section") == "## BLOCKED"
            and event.get("taxonomy") == "DEC"
            and str(event.get("op_id") or "").startswith("ticket-")
            and str(event.get("text") or "").startswith(ACTIVE_TICKET_BLOCK_MARKER)
            and detail_authority_valid(event)
        )

    phase_events = [
        event
        for event in relevant
        if str(event.get("op_id") or "").startswith(
            ("claim-", "transition-", "finish-", "goal-entry-")
        )
        or str(event.get("text") or "").startswith(ACTIVE_TICKET_BLOCK_MARKER)
    ]
    latest_phase_event = max(phase_events, key=lambda event: event["event"], default=None)
    if latest_phase_event is None or not is_active_block(latest_phase_event):
        if (
            latest_phase_event is not None
            and str(latest_phase_event.get("text") or "").startswith(
                ACTIVE_TICKET_BLOCK_MARKER
            )
            and not detail_authority_valid(latest_phase_event)
        ):
            return (
                "structural/detail integrity failure: the canonical active-block "
                f"event E-{latest_phase_event.get('event')} has a missing, malformed, "
                "unbound, or non-atomic detail proof"
            )
        return (
            f"invalid phase transition: {source} -> {destination} (RFC § 1.6). "
            "The block-parked shape requires the latest phase-changing event "
            "through STATE.last_event to be the canonical active-block DEC "
            "for the exact ticket still in BOARD.BLOCKED"
        )
    return None


def validate_checkpoint_surface(
    state_text: str,
    board_text: str,
    snap,
    current_agent: str | None = None,
    *,
    _state=None,
    _board=None,
    _state_error=None,
) -> list[str]:
    """Validate the read-only checkpoint surface using the already captured snapshot.
    Used by status/next/context to apply the SAME transactional invariant set before routing.

    PERF-004: ``_state``/``_board``/``_state_error`` let the caller reuse a single
    parse of STATE/BOARD instead of re-parsing them here (``route_next`` now parses
    once and passes the result). When omitted, the surface is parsed from the raw
    text exactly as before, so every external caller keeps the raw-text entry point
    and behavior is unchanged."""
    errors: list[str] = []

    if state_text != snap.state_text:
        errors.append("STATE bytes do not belong to the supplied ProjectSnapshot")
    if board_text != snap.board_text:
        errors.append("BOARD bytes do not belong to the supplied ProjectSnapshot")
    if errors:
        return errors

    from .floor import state_board_floor, board_floor

    floor_errors = state_board_floor(state_text, board_text) + board_floor(board_text)
    if floor_errors:
        errors.extend(f"FLOOR: {e}" for e in floor_errors)

    from .state import parse_state_or_error

    if _state is not None or _state_error is not None:
        state, state_error = _state, _state_error
    else:
        state, state_error = parse_state_or_error(state_text)
    if state_error:
        # A STATE the parser refuses stops the checks that READ state fields.
        # It must not stop the ones that do not: returning here is what let a
        # project be reported as one unknown field away from healthy while the
        # write gate refused every proposal over a duplicate ticket id, a
        # blocker outside `## BLOCKED` and three malformed LOG lines. A
        # diagnostic surface may say "I cannot judge this"; it may not imply
        # health it has not checked. The LOG verdict comes from the snapshot
        # this surface was already handed, not from a second read.
        errors.append(f"STATE proposed malformed: {state_error}")
        errors.extend(board_surface_errors(board_text))
        errors.extend(f"LOG: {problem}" for problem in getattr(snap, "illegal_lines", ()))
        return errors
    missing = [
        k
        for k in (
            "phase",
            "task",
            "next_action",
            "blocker",
            "agent",
            "saipen_version",
            "mode",
            "updated",
        )
        if k not in state
    ]
    for key in missing:
        errors.append(f"STATE proposed missing required field {key}")
    phase = state.get("phase")
    if phase not in phases.VALID_TRANSITIONS and phase not in phases.ANY_FROM:
        errors.append(f"STATE proposed phase {phase!r} outside the enum")
    na = state.get("next_action")
    if isinstance(na, str):
        if na.startswith("PHASE "):
            error = phases.phase_next_action_error(na)
            if error:
                errors.append(f"STATE proposed next_action invalid: {error}")
        else:
            prefixes = ("WAIT:", "saipen ", "RUN:", "RESUME:")
            if not na.startswith(prefixes):
                errors.append(
                    f"STATE proposed next_action {na!r} does not "
                    "start with WAIT:/saipen /PHASE /RUN:/RESUME:"
                )
        subject = state.get("task")
        m = re.match(r"^PHASE\s+([A-Za-z_-]+)(?:\s+(T-\d+))?", na.strip())
        if (
            m
            and m.group(2)
            and subject
            and m.group(2) != subject
            and phase in phases.TICKET_BEARING_PHASES
        ):
            errors.append(f"STATE proposed next_action names {m.group(2)} but task is {subject}")
    intent = state.get("execution_intent")
    if intent == "goal":
        if "goal_waves" not in state or "goal_tickets" not in state:
            errors.append("STATE proposed intent=goal without goal_waves/goal_tickets")
        if "converge_target" in state:
            errors.append("STATE proposed intent=goal with converge_target")
    elif intent == "converge":
        if state.get("converge_target") not in ("done", "ship", "crew"):
            errors.append("STATE proposed intent=converge without target done|ship|crew")
        if "goal_waves" in state or "goal_tickets" in state:
            errors.append("STATE proposed intent=converge with goal counters")
    elif intent in (None, "normal"):
        if "goal_waves" in state or "goal_tickets" in state:
            errors.append("STATE proposed non-goal intent with goal counters")
        if "converge_target" in state:
            errors.append("STATE proposed non-converge intent with converge_target")
    elif intent not in (None, "normal", "converge"):
        errors.append(f"STATE proposed execution_intent {intent!r} outside normal|goal|converge")
    if state.get("phase") and state.get("transition_from") and state.get("phase") != "INIT":
        tf = state.get("transition_from")
        if tf not in phases.VALID_TRANSITIONS and tf not in phases.ANY_FROM:
            errors.append(f"STATE proposed transition_from {tf!r} outside the enum")

    board = _board if _board is not None else parse_board(board_text)
    errors.extend(f"BOARD: {e}" for e in board["errors"])
    tickets = board["tickets"]
    for ge in board_graph_errors(tickets):
        errors.append(f"BOARD: {ge}")
    doing = [t for t in tickets.values() if t["section"] == "## DOING"]
    if len(doing) > 1:
        errors.append("BOARD proposed has more than one ## DOING ticket")
    for ticket in tickets.values():
        for semantic in board_semantic_errors(ticket):
            errors.append(f"BOARD proposed {semantic}")
        for need in ticket["needs"]:
            # A DANGLING `needs:` edge is already reported by board_graph_errors
            # above. Indexing it here anyway crashed the whole validator with a
            # KeyError, so a contradictory BOARD produced a traceback instead of
            # the structured refusal the caller is entitled to -- and on the
            # recovery path that meant no refusal at all. Report once, never
            # raise (T-1318 red/green matrix).
            if need not in tickets:
                continue
            if ticket["section"] == "## DOING" and tickets[need]["section"] != "## DONE":
                errors.append(f"BOARD proposed {ticket['id']} needs {need} which is not DONE")

    parked_error = block_parked_evidence_error(state, board, snap.history.events)
    if parked_error is not None:
        errors.append(f"STATE proposed {parked_error}")

    from .log import snapshot_contract_errors

    errors.extend(f"LOG: {e}" for e in snapshot_contract_errors(snap.history))

    tail = snap.history.tail
    last_event = state.get("last_event")
    _csv = _current_schema_version(state.get("saipen_home"))
    if _csv is not None and state.get("schema_version") == _csv and tail is not None:
        if last_event is None:
            errors.append(
                "current-schema STATE requires last_event matching the "
                "LOG tail; last_event is absent"
            )
        elif not isinstance(last_event, int) or last_event != tail:
            errors.append(f"STATE proposed last_event {last_event} != LOG tail {tail}")
    elif last_event is not None and tail is not None and last_event != tail:
        errors.append(f"STATE proposed last_event {last_event} != LOG tail {tail}")

    _home = state.get("saipen_home")
    if _csv is not None and state.get("schema_version") == _csv and _home:
        if not is_absolute_home(str(_home)):
            errors.append(f"current-schema STATE requires absolute saipen_home, got {_home!r}")

    task = state.get("task")
    active = doing[0]["id"] if doing else None
    phase = state.get("phase")
    ticket_bearing = phase in phases.TICKET_BEARING_PHASES

    if ticket_bearing:
        if not active:
            errors.append(
                f"STATE proposed phase {phase} is ticket-bearing but BOARD has no ## DOING ticket"
            )
        if not task or task == "none":
            errors.append(
                f"STATE proposed phase {phase} is ticket-bearing but task is not a real T-###"
            )
        elif active and task != active:
            errors.append(f"STATE proposed task {task} != BOARD DOING {active}")
        na = state.get("next_action")
        if isinstance(na, str):
            m = re.match(r"^PHASE\s+([A-Za-z_-]+)(?:\s+(T-\d+))?", na.strip())
            if m and m.group(2) and active and m.group(2) != active:
                errors.append(
                    f"STATE proposed next_action names "
                    f"{m.group(2)} but the active DOING ticket is "
                    f"{active}"
                )
    else:
        if active:
            _cs = claim_status(doing[0], current_agent or state.get("agent"))
            if _cs in ("SELF", "INVALID"):
                errors.append(
                    f"STATE proposed phase {phase} is not ticket-bearing "
                    "but BOARD has a ## DOING ticket; a DOING ticket "
                    "requires a ticket-bearing phase (a completed "
                    "ticket's execution state must be closed, not "
                    "left in a non-ticket phase)"
                )
        if task and task != "none":
            errors.append(
                f"STATE proposed phase {phase} is not ticket-bearing "
                f"but task is {task!r}; task must be none outside a "
                "ticket-bearing phase"
            )
    return errors


#: The identity of a DEFECT, independent of where it currently sits.
#:
#: Repair proposals move lines, so the same defect is reported at a different
#: line number before and after a repair. Comparing raw strings would therefore
#: read every inherited defect as a NEW one, and a repair that fixed its own
#: surface would be refused for damage it never touched. Only the position is
#: dropped -- the file stays in the signature, because the same sentence about
#: two different files is two different defects.
_DEFECT_POSITION_RE = re.compile(r"\b([A-Za-z_][A-Za-z_0-9]*\.md):\d+:?")


def defect_signature(error: str) -> str:
    """One validator error, reduced to what makes it THAT defect."""
    return _DEFECT_POSITION_RE.sub(r"\g<1>:", error).strip()


def defect_delta(before: list[str], after: list[str]) -> tuple[list[str], list[str]]:
    """(introduced, inherited) for a proposed change.

    `introduced` is damage the proposal ADDS and is always disqualifying.
    `inherited` is damage that was there first: it must stay visible and must
    keep the project out of CLEAN, but it is not a reason to refuse a repair
    that strictly improves the surface it owns. Measured on _SAITULS, 17.09.26:
    the STATE repair was refused for a duplicate BOARD id, two stale blockers
    and FIVE malformed LOG lines (four events that had lost their leading `- `
    and one free-text record) it had never proposed to touch, so the one repair
    that could have made the next repair runnable never ran.
    """
    seen = {}
    for error in before:
        seen[defect_signature(error)] = seen.get(defect_signature(error), 0) + 1
    introduced: list[str] = []
    inherited: list[str] = []
    for error in after:
        key = defect_signature(error)
        if seen.get(key):
            seen[key] -= 1
            inherited.append(error)
        else:
            introduced.append(error)
    return introduced, inherited


def board_surface_errors(board_text: str) -> list[str]:
    """Every BOARD defect that does not depend on STATE parsing.

    Extracted so the malformed-STATE path and the ordinary path answer with
    the SAME list. They used not to: a STATE the parser refused made
    `validate_texts` return immediately, so a duplicate ticket id and a blocker
    outside `## BLOCKED` were invisible to `saipen validate` while the write
    gate refused every proposal over them. Measured on _SAITULS, 17.09.26:
    `validate --json` reported one unknown STATE field and nothing else, and
    the operator was told the project was one field away from healthy.
    """
    errors: list[str] = []
    board = parse_board(board_text)
    errors.extend(f"BOARD: {e}" for e in board["errors"])
    tickets = board["tickets"]
    for ge in board_graph_errors(tickets):
        errors.append(f"BOARD: {ge}")
    if len([t for t in tickets.values() if t["section"] == "## DOING"]) > 1:
        errors.append("BOARD proposed has more than one ## DOING ticket")
    for ticket in tickets.values():
        for semantic in board_semantic_errors(ticket):
            errors.append(f"BOARD proposed {semantic}")
        for need in ticket["needs"]:
            if need not in tickets:
                continue
            if ticket["section"] == "## DOING" and tickets[need]["section"] != "## DONE":
                errors.append(f"BOARD proposed {ticket['id']} needs {need} which is not DONE")
    return errors


def log_surface_errors(log_text: str) -> list[str]:
    """Every LOG-grammar defect that does not depend on STATE parsing."""
    return [f"LOG: {e}" for e in _analyze_log(log_text).errors]


def validate_texts(
    state_text: str,
    board_text: str,
    log_text: str,
    current_agent: str | None = None,
    sealed_events=None,
    planned_detail_events=frozenset(),
) -> list[str]:
    """Validate the proposed STATE/BOARD/LOG texts. Returns every error.

    `current_agent` is the CURRENT-SESSION actor (second-wave P0). Claim
    classification and the active-DOING structural check are judged relative
    to THIS identity, never to persisted STATE.agent -- that field is
    historical last-writer evidence. A session B viewing an A-owned DOING
    under a non-ticket-bearing phase is valid multi-agent state (FOREIGN),
    not the SELF-corruption the check exists to catch. When None (a caller
    that does not know its own identity), the historical value is used for
    backward compatibility; the CLI/adapters always supply the session
    identity.

    CORE-005: `sealed_events` is the already-captured canonical sealed+active
    HistorySnapshot (or its parsed event tuple). When supplied, the
    block-park evidence check consumes the COMPLETE historical truth (sealed
    segments + proposed active LOG) instead of redefining project history
    from the proposed active LOG.md alone. This keeps the transactional
    write-path validator consistent with the canonical read-path validator
    once decisive evidence rotates into a sealed LOG segment.

    `planned_detail_events` names only structural detail targets present in the
    same immutable OperationPlan as this proposed LOG. Live validation never
    supplies it; persisted detail must prove its own integrity from disk.
    """
    errors: list[str] = []

    from .floor import raw_floor

    floor_errors = raw_floor(state_text, board_text, log_text)
    if floor_errors:
        errors.extend(f"FLOOR: {e}" for e in floor_errors)

    from .state import parse_state_or_error

    state, state_error = parse_state_or_error(state_text)
    if state_error:
        # A STATE the parser refuses stops the checks that READ state fields.
        # It must not stop the ones that do not. Returning here is what let a
        # project be reported as one unknown field away from healthy while the
        # write gate refused every proposal over a duplicate ticket id, a
        # blocker outside `## BLOCKED` and three malformed LOG lines (_SAITULS,
        # 17.09.26). A diagnostic surface may say "I cannot judge this"; it may
        # not imply health it never checked.
        errors.append(f"STATE proposed malformed: {state_error}")
        errors.extend(board_surface_errors(board_text))
        errors.extend(log_surface_errors(log_text))
        return errors
    missing = [
        k
        for k in (
            "phase",
            "task",
            "next_action",
            "blocker",
            "agent",
            "saipen_version",
            "mode",
            "updated",
        )
        if k not in state
    ]
    for key in missing:
        errors.append(f"STATE proposed missing required field {key}")
    phase = state.get("phase")
    if phase not in phases.VALID_TRANSITIONS and phase not in phases.ANY_FROM:
        errors.append(f"STATE proposed phase {phase!r} outside the enum")
    na = state.get("next_action")
    if isinstance(na, str):
        if na.startswith("PHASE "):
            error = phases.phase_next_action_error(na)
            if error:
                errors.append(f"STATE proposed next_action invalid: {error}")
        else:
            prefixes = ("WAIT:", "saipen ", "RUN:", "RESUME:")
            if not na.startswith(prefixes):
                errors.append(
                    f"STATE proposed next_action {na!r} does not "
                    "start with WAIT:/saipen /PHASE /RUN:/RESUME:"
                )
        # A PHASE next_action naming a ticket must agree with the active task
        # ONLY in a ticket-bearing phase, where task is the active DOING
        # ticket. In a non-ticket-bearing phase (DONE after closure) task is
        # none and next_action legitimately names the next workable ticket --
        # the router's START projection, not a task-binding violation.
        subject = state.get("task")
        m = re.match(r"^PHASE\s+([A-Za-z_-]+)(?:\s+(T-\d+))?", na.strip())
        if (
            m
            and m.group(2)
            and subject
            and m.group(2) != subject
            and phase in phases.TICKET_BEARING_PHASES
        ):
            errors.append(f"STATE proposed next_action names {m.group(2)} but task is {subject}")
    intent = state.get("execution_intent")
    if intent == "goal":
        if "goal_waves" not in state or "goal_tickets" not in state:
            errors.append("STATE proposed intent=goal without goal_waves/goal_tickets")
        if "converge_target" in state:
            errors.append("STATE proposed intent=goal with converge_target")
    elif intent == "converge":
        if state.get("converge_target") not in ("done", "ship", "crew"):
            errors.append("STATE proposed intent=converge without target done|ship|crew")
        if "goal_waves" in state or "goal_tickets" in state:
            errors.append("STATE proposed intent=converge with goal counters")
    elif intent in (None, "normal"):
        if "goal_waves" in state or "goal_tickets" in state:
            errors.append("STATE proposed non-goal intent with goal counters")
        if "converge_target" in state:
            errors.append("STATE proposed non-converge intent with converge_target")
    elif intent not in (None, "normal", "converge"):
        errors.append(f"STATE proposed execution_intent {intent!r} outside normal|goal|converge")
    if state.get("phase") and state.get("transition_from") and state.get("phase") != "INIT":
        tf = state.get("transition_from")
        if tf not in phases.VALID_TRANSITIONS and tf not in phases.ANY_FROM:
            errors.append(f"STATE proposed transition_from {tf!r} outside the enum")

    board = parse_board(board_text)
    tickets = board["tickets"]
    doing = [t for t in tickets.values() if t["section"] == "## DOING"]
    errors.extend(board_surface_errors(board_text))

    # PERF-007: ONE single-pass LOG analysis replaces three separate parsings
    # (active-events comprehension + _log_errors + log_tail_event). The
    # independent raw_floor/log_floor still runs as a separate implementation.
    log_analysis = _analyze_log(log_text)
    active_events = log_analysis.events
    # CORE-005: the block-park evidence check must see the COMPLETE canonical
    # history. When the caller supplies the frozen HistorySnapshot (sealed +
    # active), prepend its sealed/prior events to the proposed active events so
    # decisive evidence that rotated into a sealed segment is not lost. The
    # history snapshot's OWN parsed events already include the current active
    # LOG; we append the proposed active tail to keep the proposed mutation
    # visible while the snapshot supplies the authoritative prior history.
    if sealed_events is not None:
        if hasattr(sealed_events, "events"):
            prior = list(sealed_events.events)
        else:
            prior = list(sealed_events)
        prior_ids = {ev.get("event") for ev in prior}
        active_events = tuple(
            prior + [ev for ev in active_events if ev.get("event") not in prior_ids]
        )
    parked_error = block_parked_evidence_error(
        state,
        board,
        active_events,
        planned_detail_events=planned_detail_events,
    )
    if parked_error is not None:
        errors.append(f"STATE proposed {parked_error}")

    # Allocation identity (CORE-003 / SRC-026:R003): canonical ticket
    # identity comes from next_ticket_id over structured records and is
    # journaled as a [T-###] event in the SAME transaction. So every BOARD
    # record must be backed by a [T-###] event in the complete history or
    # the proposed transaction's own LOG tail -- a detached, hand-injected
    # ticket-shaped record never becomes canonical authority merely because
    # it looks like a ticket. Enforcement arms only when the project HAS an
    # allocation authority (a nonzero history-wide max ticket id): a project
    # that has never allocated a ticket cannot be judged, which keeps
    # hand-authored fresh fixtures legal while catching detached records in
    # any real project. The structured [T-###] events are the existing
    # authority -- no second allocator is invented here.
    _frontier = getattr(sealed_events, "max_ticket_id", 0) if sealed_events is not None else 0
    if _frontier:
        _known = {"T-none"}
        for ev in active_events:
            if ev.get("ticket"):
                _known.add(ev["ticket"])
        _known.update(detached_ticket_id_known_ids(sealed_events.events))
        # Scope to WORKABLE sections: a detached record in ## BLOCKED is a
        # parked foreign finding the canonical validator already reports --
        # it can never be claimed or executed, so it does not gate the
        # repository's mutations. Only a record in ## TODO / ## DOING could
        # become execution authority, so only those refuse here.
        for tid, t in tickets.items():
            if t.get("section") in ("## TODO", "## DOING") and tid not in _known:
                errors.append(
                    f"BOARD: {tid} has no [T-###] allocation event in the "
                    f"complete history -- ticket identity comes from "
                    f"canonical allocation, never from a record that merely "
                    f"looks like a ticket (CORE-003 / SRC-026:R003)"
                )

    errors.extend(log_surface_errors(log_text))

    tail = log_analysis.tail
    last_event = state.get("last_event")
    # Current-schema states (schema_version == the installed schema's
    # x-current-schema-version) MUST carry a last_event that matches the LOG tail
    # when the LOG has events (hostile-regression, P0#2): the cross-file fast gate
    # enforces the same marker the release gate requires, so the two never disagree.
    # Legacy schemas keep their looser handling below.
    _csv = _current_schema_version(state.get("saipen_home"))
    if _csv is not None and state.get("schema_version") == _csv and tail is not None:
        if last_event is None:
            errors.append(
                "current-schema STATE requires last_event matching the "
                "LOG tail; last_event is absent"
            )
        elif not isinstance(last_event, int) or last_event != tail:
            errors.append(f"STATE proposed last_event {last_event} != LOG tail {tail}")
    elif last_event is not None and tail is not None and last_event != tail:
        errors.append(f"STATE proposed last_event {last_event} != LOG tail {tail}")

    _home = state.get("saipen_home")
    if _csv is not None and state.get("schema_version") == _csv and _home:
        if not is_absolute_home(str(_home)):
            errors.append(f"current-schema STATE requires absolute saipen_home, got {_home!r}")

    # CORE-001 (SRC-026:R001): the ACTIVE EXECUTION OWNER invariant, absent
    # from this gate until now. E-5941 committed `STATE.task=T-1298,
    # STATE.agent=buffy` against `BOARD active owner opencode` because nothing
    # here compared the two; `validate.py --gate core` refused the same bytes
    # afterwards, so a mutation could commit a state the release gate rejects.
    # The predicate is IMPORTED, not restated, so the transactional gate and
    # the canonical validator cannot drift apart again. A transitional value
    # may exist inside an uncommitted transaction (the handover plan builds
    # STATE and BOARD before either is written); no COMMITTED state may hold
    # the split, and every plan passes through here before its bytes are
    # journaled.
    from .ownership import ownership_invariant_errors

    errors.extend(ownership_invariant_errors(state, board, current_agent))

    # Active-ticket binding (NITRO dogfood III, T-591): the one-way check
    # "BOARD has DOING and STATE has task and they differ" is not a proof of
    # the actual invariant. For every ticket-bearing phase the binding is
    # bidirectional: exactly one BOARD.DOING must exist, STATE.task must be a
    # real T-### equal to it, and next_action's ticket subject must equal it.
    # Any ticket-bearing phase with task:none, no DOING, a mismatched task, or
    # a next_action naming a different ticket is structural corruption.
    task = state.get("task")
    active = doing[0]["id"] if doing else None
    phase = state.get("phase")
    ticket_bearing = phase in phases.TICKET_BEARING_PHASES

    if ticket_bearing:
        if not active:
            errors.append(
                f"STATE proposed phase {phase} is ticket-bearing but BOARD has no ## DOING ticket"
            )
        if not task or task == "none":
            errors.append(
                f"STATE proposed phase {phase} is ticket-bearing but task is not a real T-###"
            )
        elif active and task != active:
            errors.append(f"STATE proposed task {task} != BOARD DOING {active}")
        na = state.get("next_action")
        if isinstance(na, str):
            m = re.match(r"^PHASE\s+([A-Za-z_-]+)(?:\s+(T-\d+))?", na.strip())
            if m and m.group(2) and active and m.group(2) != active:
                errors.append(
                    f"STATE proposed next_action names "
                    f"{m.group(2)} but the active DOING ticket is "
                    f"{active}"
                )
    else:
        if active:
            # A DOING ticket that is UNCLAIMED / FOREIGN_STALE / FOREIGN_LIVE is
            # owned by nobody or by another agent; an observer in a non-ticket-
            # bearing phase (e.g. DONE / task:none) is valid multi-agent state and
            # must NOT be rejected here (P0 claim-ownership truth: one classifier
            # decides). Only a SELF or INVALID DOING under a non-ticket-bearing
            # phase is structural corruption.
            _cs = claim_status(doing[0], current_agent or state.get("agent"))
            if _cs in ("SELF", "INVALID"):
                errors.append(
                    f"STATE proposed phase {phase} is not ticket-bearing "
                    "but BOARD has a ## DOING ticket; a DOING ticket "
                    "requires a ticket-bearing phase (a completed "
                    "ticket's execution state must be closed, not "
                    "left in a non-ticket phase)"
                )
        if task and task != "none":
            errors.append(
                f"STATE proposed phase {phase} is not ticket-bearing "
                f"but task is {task!r}; task must be none outside a "
                "ticket-bearing phase"
            )

    # Attempt contract on the PROPOSED world (T-1148). The transactional
    # write path refuses the same attempt corruption the release gate
    # fails: a malformed/mis-paired attempt event, more than one open
    # episode, or an attempt pointer disagreeing with the proposed LOG.
    # Evaluated over sealed+proposed events so a close of an attempt opened
    # in a sealed segment never reads as orphaned.
    from . import attempt as _attempt_mod

    for ev in active_events:
        if ev.get("taxonomy") != "DEC":
            continue
        _rec, err = _attempt_mod.parse_attempt_event(ev)
        if err is not None:
            errors.append(f"LOG proposed attempt event: {err}")
    _att_records, _att_errs = _attempt_mod.build_attempts(active_events)
    for _att_e in _att_errs:
        errors.append(f"LOG: {_att_e}")
    _att_pointer = state.get("attempt")
    if _att_pointer is not None:
        if _att_pointer not in _att_records or (
            _att_records[_att_pointer]["close_event"] is not None
        ):
            errors.append(
                f"STATE proposed attempt {_att_pointer} has no open event in "
                "the proposed history -- torn attempt state"
            )
        elif state.get("task") != _att_records[_att_pointer].get("ticket"):
            errors.append(
                f"STATE proposed attempt {_att_pointer} belongs to "
                f"{_att_records[_att_pointer].get('ticket')} but task is "
                f"{state.get('task')}"
            )
    # CORE-004 (audit ed1f86e8): bidirectional pointer invariant in the fast
    # checker too -- an open attempt on the proposed Work with no matching
    # STATE.attempt pointer is torn state, not conformant.
    _open = _attempt_mod.active_attempts(_att_records)
    _work_open = [aid for aid in _open if _att_records[aid].get("ticket") == state.get("task")]
    if _work_open:
        if len(_work_open) > 1:
            errors.append(
                f"LOG proposed {len(_work_open)} open attempts for "
                f"{state.get('task')} but STATE.attempt is a single pointer "
                "-- impossible, refuse"
            )
        elif _att_pointer is None:
            errors.append(
                f"attempt {_work_open[0]} is open in the proposed LOG but "
                "STATE carries no attempt pointer -- torn attempt state"
            )
        elif _att_pointer != _work_open[0]:
            errors.append(
                f"STATE proposed attempt {_att_pointer} does not match the "
                f"open attempt {_work_open[0]} on this Work -- attempt "
                "pointer ownership is inconsistent"
            )
    return errors


def validate_project(root, current_agent: str | None = None) -> list[str]:
    """Validate the live canonical files (post-write / recovery verification)."""
    errors: list[str] = []
    from pathlib import Path

    root = Path(root)
    from . import codec

    # Encoding is diagnosed before anything is parsed, exactly like the
    # release gate (hostile-regression, P1): a UTF-16 or BOM-carrying
    # checkpoint file is what PowerShell 5.1's Set-Content produces by
    # default, and the consequences differ by tool -- the portable floor
    # matches nothing, a BOM alone breaks `^---` so the frontmatter parses
    # as empty. One named error beats three unrelated symptoms, and a
    # post-write verification must refuse a commit that wrote one.
    for name in ("STATE.md", "BOARD.md", "LOG.md"):
        path = root / ".saipen" / name
        if not path.is_file():
            continue
        enc = codec.encoding_of(path)
        if enc != "utf-8":
            errors.append(
                f".saipen/{name} is {enc}, not plain UTF-8 -- every SAIPEN "
                "tool reads it byte-wise and will fail differently; rewrite "
                "as UTF-8 without a BOM (KNOWLEDGE/traps.md)"
            )
    state = codec.read_doc(root / ".saipen" / "STATE.md")
    board = codec.read_doc(root / ".saipen" / "BOARD.md")
    log = codec.read_doc(root / ".saipen" / "LOG.md")
    # CORE-006: evaluate block-park semantics against the complete sealed+active
    # history, not just the active LOG. Reuse the frozen HistorySnapshot that
    # _read already captures; here we capture it fresh for post-write verification.
    try:
        from .log import read_history_snapshot

        _history = read_history_snapshot(root)
    except Exception:
        _history = None
    errors.extend(
        validate_texts(state, board, log, current_agent=current_agent, sealed_events=_history)
    )
    # The COMPLETE sealed+active ledger must be internally valid (legal syntax,
    # unique E-IDs, contiguous parent chain, parent existence, order) -- not
    # just the active segment (hostile-regression, P0#2). A void sealed log is
    # what once let a mutation PLAN against a record that did not exist, so the
    # live verification must FAIL it too.
    from .log import snapshot_contract_errors

    # PERF-003: reuse the HistorySnapshot captured above instead of
    # history_contract_errors(root), which would re-read the entire ledger
    # (sealed segments + active LOG) a second time. The contract is proved
    # once, from the same bytes the post-write verification already saw.
    errors.extend(f"LOG: {e}" for e in snapshot_contract_errors(_history))
    return errors
