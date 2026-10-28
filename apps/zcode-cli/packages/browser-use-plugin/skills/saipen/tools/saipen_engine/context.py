"""Context compiler -- saipen context cold/hot/audit (NITRO M9 + IV, T-600).

Consumes the NOW-TRUSTWORTHY mechanical layer: the engine's parsers
(saipen_engine.state/board/log), ProjectSnapshot, and the phase DFA. It emits
BOUNDED compact surfaces a cold/hot agent consumes instead of re-reading raw
canonical files. All read-only: zero bytes written.

- `context cold`: the minimal cold-start surface (STATE fields + exact next
  ticket + BOARD orientation map + LOG tail + phase-doc routing) as a compact
  deterministic artifact.
- `context hot`: the current-work surface (status + next + active ticket +
  recent LOG events + recovery state).
- `context audit`: a bounded bytes/tokens accounting per source, with an
  HONEST projection metric (projection_reduction_bytes = raw canonical bytes
  minus cold-surface bytes -- never a claim about "unchanged" revisions).

PROJECTION INTEGRITY (NITRO dogfood IV, T-600):

- STRUCTURAL BUDGETING, never global string chopping. Mandatory sections are
  emitted in FULL and are never truncated away; only the optional orientation
  (BOARD MAP) and bounded evidence (LOG tail) shrink, in that priority order.
  Priority: recovery/conflict > computed next action > exact full active/next
  ticket > STATE essentials > required routed phase doc > exact needs/verify >
  bounded LOG evidence > optional BOARD orientation.
- The exact routed/active ticket lives in a protected `## NEXT TICKET`
  section OUTSIDE any orientation truncation; the BOARD MAP is a bounded
  orientation that at most shows N non-protected entries and then a truthful
  `... +K more`.
- METRICS DESCRIBE THE EMITTED SURFACE. bytes == len(surface.encode('utf-8')),
  characters == len(surface), tokens are estimated from the exact surface.
  pre_bound_bytes / truncation_bytes are reported SEPARATELY as projection
  economics, never labeled as model-visible bytes.

The compiler NEVER re-parses: every field is derived through the shared
parsers/snapshot, so it cannot drift from what the engine sees.
"""

from __future__ import annotations

import re
from pathlib import Path

from .board import parse_board
from .log import HistoryOwnershipError
from .result import Result

_TAIL_EVENTS = 12
_BOARD_CAP = 8


def _tokens(text: str) -> int:
    """Rough deterministic token estimate: words + punctuation clusters."""
    words = len(re.findall(r"\b\w+\b", text))
    symbols = len(re.findall(r"[^\w\s]", text))
    return words + symbols


def _bytes(text: str) -> int:
    """REAL UTF-8 byte count -- len(str) counts characters, not bytes, and
    this protocol is multilingual (NITRO dogfood II)."""
    return len(text.encode("utf-8"))


def _state_fields(state: dict) -> str:
    """The CLOSED operational-essentials projection (T-1003 carrier-loss
    wave). A cold projection may omit detail, NEVER a fact that changes
    authorization or routing. Every field the router/release/crew/
    capability/version-guard branches on is either emitted here or replaced
    by its mechanically-derived decision (`saipen_home_present`).
    """
    lines = []
    for key in (
        "phase",
        "task",
        "next_action",
        "blocker",
        "agent",
        "mode",
        "saipen_version",
        "saipen_home",
        "execution_intent",
        "converge_target",
        "requires",
        "goal_waves",
        "goal_tickets",
        "last_event",
        "updated",
    ):
        if key in state:
            value = state[key]
            if isinstance(value, (list, tuple)):
                value = ", ".join(str(v) for v in value)
            lines.append(f"{key}: {value}")
    return "\n".join(lines)


def _home_present(state: dict) -> str:
    """The mechanically-derived effective home-availability decision: the
    version guard/boot layer branches on whether the pointed-to SAIPEN home
    is actually present, so the cold surface must expose that decision, not
    only the raw pointer (T-1003 carrier-loss wave)."""
    home = state.get("saipen_home")
    if not home:
        return "none"
    try:
        return "true" if Path(str(home)).is_dir() else "false"
    except (OSError, ValueError):
        return "false"


def _userperson_section(effective: dict) -> str:
    """Compact mandatory activation signal; never embeds preference text."""
    if not effective.get("active"):
        return ""
    return "\n".join(
        [
            "## USERPERSON",
            "active: true",
            f"global_present: {str(effective['global']['present']).lower()}",
            f"project_present: {str(effective['project']['present']).lower()}",
            f"effective_fingerprint: {effective['effective_fingerprint']}",
            "load: saipen userperson show --effective --json",
        ]
    )


def _source_receipts_section(receipts: list[dict]) -> str:
    """Compact activation signal; original bodies remain targeted/JIT."""
    if not receipts:
        return ""
    shown = receipts[:8]
    lines = ["## SOURCE RECEIPTS", f"active: {len(receipts)}"]
    for item in shown:
        lines.append(
            f"- {item['receipt']} work={item.get('linked_work') or 'none'} "
            f"coverage={item.get('terminal', 0)}/{item.get('requirements', 0)} "
            f"unresolved={item.get('unresolved', 0)}"
        )
    if len(receipts) > len(shown):
        lines.append(f"... +{len(receipts) - len(shown)} more")
    lines.append("load: saipen source show <SRC-ID> --json")
    return "\n".join(lines)


def _xpatch_section(summary: dict) -> str:
    """ONE line of foreign-patch reality, or nothing (T-1256).

    Minimal UI, maximal proof: a cold agent needs to know that attributed
    foreign changes exist before it reads the tree, not a dashboard. The
    receipt itself carries who/why/which bytes, and is opened on demand.
    """
    if not summary:
        return ""
    if not (summary["unreviewed"] or summary["verified"] or summary["conflicting"]):
        return ""
    return summary["line"] + "\nload: .saipen/exchange/xpatch/<XP-ID>/intent.json"


def _board_map(
    buckets: dict[str, list[dict]], full_ticket: str | None = None, cap: int = _BOARD_CAP
) -> str:
    """Board ORIENTATION projection, TRUTHFULLY bounded (NITRO dogfood IV,
    T-600).

    At most `cap` NON-protected entries are emitted per section, followed by
    a truthful `... +K more` naming the exact number omitted. The exact
    routed/active ticket is a protected exception: it is ALWAYS emitted in
    full (raw line, needs + verify + description intact) and never counts
    against the cap. The old projection printed every ticket AND then
    '+N more' -- logically false; this one prints N, then names the real K.
    """
    lines = []
    for section in ("## DOING", "## TODO", "## BLOCKED", "## DONE"):
        tickets = buckets.get(section, [])
        lines.append(f"{section} ({len(tickets)})")
        emitted = 0
        skipped = 0
        for ticket in tickets:
            if full_ticket and ticket["id"] == full_ticket:
                lines.append(f"  - {ticket['raw'].strip()}")
                continue
            if emitted >= cap:
                skipped += 1
                continue
            desc = (ticket["description"] or "").replace(" | ", " / ")
            lines.append(f"  - {ticket['id']} [{ticket['checkbox']}] {desc[:80]}")
            emitted += 1
        if skipped:
            lines.append(f"  ... +{skipped} more")
    return "\n".join(lines)


def _next_ticket_section(board: dict, ticket_id: str | None) -> str:
    """The PROTECTED exact-ticket section (NITRO dogfood IV, T-600).

    The complete canonical ticket line -- ID, priority, description, needs,
    verify, blocker -- emitted in full and OUTSIDE any orientation
    truncation. The next ticket can never disappear because DONE history was
    long."""
    if not ticket_id or ticket_id not in board["tickets"]:
        return "no routed ticket"
    return board["tickets"][ticket_id]["raw"].strip()


def _log_tail(event_lines, count: int = _TAIL_EVENTS) -> str:
    """Project the bounded LOG tail from ONE pre-parsed pass (T-1014).

    `event_lines` is the call-scoped tuple of raw event lines, filtered once
    by the caller; slicing per budget costs zero re-parsing, so the complete
    LOG is parsed exactly once per command instead of once per budget probe.
    `event_lines[-0:]` is the ENTIRE list (Python: -0 == 0), so a `count` of
    0 must be branched explicitly to emit ZERO events -- never the full
    history. A shrinking budget reaching count=0 collapses to the empty
    surface, so LOG bytes never increase as the limit descends
    (hostile-regression, P1#6)."""
    if not event_lines:
        return "(no events)"
    if count <= 0:
        return ""
    return "\n".join(event_lines[-count:])


def _load_context_inputs(root: Path) -> dict:
    """ONE call-scoped capture of the canonical context world.

    Reads STATE/BOARD docs, one pending-scan, and one complete LOG snapshot
    exactly once per call. cold/hot/audit renderers reuse this single
    captured world when called through audit; the public APIs still load
    fresh when called alone. Nothing is retained globally or across calls.

    W2-005: the snapshot's exact STATE/BOARD bytes are the coherent generation
    for rendering/routing/validation; no second independent read of those files
    is performed, so a commit between reads cannot mix generations.
    """
    from .snapshot import ProjectSnapshot
    from .state import parse_state_or_error
    from .journal import scan_pending
    from .intake import active_receipts
    from userperson import effective_profile

    snap = ProjectSnapshot.capture(root)
    state_text = snap.state_text
    board_text = snap.board_text
    log_snap = snap.history
    state, state_error = parse_state_or_error(state_text)
    board = parse_board(board_text)
    _pending, _conflicts = scan_pending(root)
    # T-1014: the raw event lines are captured EXACTLY ONCE by
    # `read_history_snapshot` (in the same pass that builds `events`) and
    # reused verbatim here -- cold/hot/audit projections and every `_fit`
    # budget probe slice this same tuple instead of re-parsing the complete
    # LOG text a second time. Nothing is retained globally or across calls.
    log_event_lines = log_snap.event_lines
    userperson = effective_profile(root)
    source_receipts = active_receipts(root)
    return {
        "root": root,
        "state_text": state_text,
        "board_text": board_text,
        "log_text": log_snap.text,
        "log_tail": log_snap.tail,
        "log_event_lines": log_event_lines,
        "state": state,
        "state_error": state_error,
        "board": board,
        "pending": [op["op_id"] for op in _pending],
        "conflicts": [op["op_id"] for op in _conflicts],
        "corrupt": [op for op in _pending if op.get("corrupt")],
        "snap": snap,
        "userperson": userperson,
        "source_receipts": source_receipts,
        "xpatch": _xpatch_summary(root),
    }


def _xpatch_summary(root: Path) -> dict:
    """Foreign-patch counts for the cold surface; never fatal.

    A broken exchange namespace must not take down the cold start -- the
    receipts are ADDITIONAL evidence, and their own problems already surface
    through convergence attribution.
    """
    try:
        from .xpatch import summary as xpatch_summary

        return xpatch_summary(root)
    except Exception:
        return {}


def _load_inputs_checked(root: Path) -> Result | dict:
    """ONE call-scoped capture, converted to the deterministic read-only
    failure contract (second-wave P1).

    A symlinked/junction/reparse or non-regular history node raises
    `HistoryOwnershipError` (external bytes must never enter the digest or the
    ledger); an unreadable canonical file raises OSError. Both MUST surface as
    the same structured `VALIDATION_FAILED` result other read-only commands
    return -- never a raw traceback, and never a partial surface built from
    what could be read before the refusal."""
    try:
        inputs = _load_context_inputs(root)
        corrupt = inputs["corrupt"]
        if corrupt:
            first = corrupt[0]
            return Result(
                ok=False,
                code="CORRUPT_JOURNAL",
                op_id=str(first.get("op_id", "")),
                message=(
                    f"corrupt recovery evidence {first.get('op_id', '?')}: "
                    f"{first.get('detail', '')}"
                ),
                data={"corrupt": corrupt, "recovery_required": True},
            )
        return inputs
    except HistoryOwnershipError as exc:
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message=f"history-ownership: {exc}",
            data={},
        )
    except (OSError, ValueError) as exc:
        from userperson import UserpersonError

        if isinstance(exc, UserpersonError):
            return Result(
                ok=False,
                code="VALIDATION_FAILED",
                op_id="",
                message=exc.detail,
                data={"scope": exc.scope, "userperson_code": exc.code},
            )
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message=f"history-ownership: {type(exc).__name__}: {exc}",
            data={},
        )


def _fit(
    fixed: str,
    limit: int,
    board_fn,
    log_fn,
    board_header: str = "## BOARD MAP",
    log_header: str = "## LOG TAIL",
) -> tuple[str, str]:
    """STRUCTURAL budgeting (NITRO dogfood IV, T-600).

    `fixed` is the concatenated mandatory prefix -- recovery/conflict, computed
    next action, exact next ticket, STATE essentials, routed phase doc,
    needs/verify -- and is NEVER truncated. The BOARD orientation is the most
    optional section, so it shrinks FIRST (down to its protected-exception
    form); only when it is gone does the bounded LOG evidence shrink. If the
    mandatory prefix alone exceeds the limit, it is still emitted in full: the
    budget is a projection target, never a license to cut the instruction
    required to execute the task. Returns (board_text, log_text).

    Every fit decision is made on the EXACT final surface -- including the
    section wrapper headers and the joining newline -- measured in REAL UTF-8
    bytes via `_bytes`, never character counts: a multilingual or
    boundary-sized surface must not exceed its declared byte budget while
    optional sections could still shrink (T-1003). The one documented
    exception is preserved: mandatory content alone exceeding the limit stays
    untruncated and measurable.
    """

    def surface_bytes(board_text: str, log_text: str) -> int:
        body = (
            fixed
            + "\n"
            + log_header
            + "\n"
            + log_text
            + "\n"
            + board_header
            + "\n"
            + board_text
            + "\n"
        )
        return _bytes(body)

    _b_memo = {}

    def _b(c):
        if c not in _b_memo:
            _b_memo[c] = board_fn(c)
        return _b_memo[c]

    _l_memo = {}

    def _l(c):
        if c not in _l_memo:
            _l_memo[c] = log_fn(c)
        return _l_memo[c]

    for board_cap in (8, 6, 4, 2, 0):
        board_text = _b(board_cap)
        log_full = _l(12)
        if surface_bytes(board_text, log_full) <= limit:
            return board_text, log_full
    for log_count in (12, 10, 8, 6, 4, 2, 0):
        log_text = _l(log_count)
        if surface_bytes(_b(0), log_text) <= limit:
            return _b(0), log_text
    return _b(0), _l(0)


def context_cold(
    project_root: Path | str,
    limit: int = 4000,
    _inputs: dict | None = None,
    current_agent: str | None = None,
    _routed: dict | None = None,
) -> Result:
    """Minimal cold-start surface with STRUCTURAL budgeting.

    Uses the SHARED router (NITRO dogfood II), so it cannot echo a stale
    next_action. Metrics describe the FINAL emitted surface: bytes ==
    len(surface.encode('utf-8')), characters == len(surface) (NITRO dogfood
    IV, T-600). `_inputs` is the call-scoped capture from
    `_load_context_inputs` (audit reuses one world); when None the public
    API loads a fresh world itself."""
    root = Path(project_root)
    inputs = _inputs if _inputs is not None else _load_inputs_checked(root)
    if isinstance(inputs, Result):
        return inputs
    state_text = inputs["state_text"]
    board_text = inputs["board_text"]
    log_event_lines = inputs["log_event_lines"]
    state = inputs["state"]
    state_error = inputs["state_error"]
    if state_error:
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message=f"state-malformed: {state_error}",
            data={},
        )
    board = inputs["board"]
    pending = inputs["pending"]
    conflicts = inputs["conflicts"]
    from .router import load_for_action, route_next, routing_failure_code

    # P0#4: the cold-start projection routes under the CURRENT-SESSION
    # capability, never the persisted STATE.mode -- a read-only session is
    # handed an inspect-only action even when the last handshake was full.
    # Second-wave P0: claim truth is judged relative to the SESSION identity,
    # never to persisted STATE.agent.
    from .capability import negotiate_capability
    from .router import pending_append_projection, queued_source_projection

    routed = (
        _routed
        if _routed is not None
        else route_next(
            state_text,
            board_text,
            pending,
            conflicts,
            current_capability=negotiate_capability(),
            current_agent=current_agent,
            snap=inputs["snap"],
            queued_source=queued_source_projection(root),
            pending_append=pending_append_projection(root),
        )
    )
    if not routed.get("ok") and routing_failure_code(routed) == "VALIDATION_FAILED":
        # A malformed surface must not project a healthy cold start: the
        # router's diagnostics propagate instead, recovery flags stay
        # truthful (T-1003 hostile findings).
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message=f"{routed.get('reason')}: " + str(routed.get("detail", "")),
            data={
                "recovery_pending": bool(pending),
                "recovery_conflict": bool(conflicts),
                "conflict_ops": conflicts,
                "pending_ops": pending,
            },
        )
    next_ticket = routed.get("ticket")
    # phase_doc derives from the ROUTED action, never from the persisted
    # STATE.phase -- action and instructions can never disagree.
    phase_doc = load_for_action(routed.get("action"))

    # SRC-020: KNOWLEDGE is targeted decision context, never cold-start bulk.
    # Exact source reads prove index freshness; only selected bodies reach
    # model context. Missing/stale projections fall back read-only. A match adds
    # card claim/Why/evidence to the protected decision surface.
    from .knowledge import render_retrieval, retrieve

    objective = _next_ticket_section(board, next_ticket)
    knowledge_result = retrieve(root, objective)
    knowledge_section = render_retrieval(knowledge_result)

    # MANDATORY prefix (never truncated): recovery/conflict, computed next
    # action, the exact full next ticket (needs + verify included), STATE
    # essentials, routed phase doc.
    mandatory = [
        "## RECOVERY",
        f"recovery_pending: {bool(pending)}",
        f"recovery_conflict: {bool(conflicts)}",
        f"conflict_ops: {', '.join(conflicts) or 'none'}",
        "",
        "## ROUTED NEXT",
        f"action: {routed.get('action')}",
        f"reason: {routed.get('reason')}",
        f"ticket: {next_ticket or 'none'}",
        "",
        "## NEXT TICKET",
        _next_ticket_section(board, next_ticket),
        "",
        "## STATE",
        _state_fields(state),
        f"saipen_home_present: {_home_present(state)}",
    ]
    userperson_section = _userperson_section(inputs["userperson"])
    if userperson_section:
        mandatory.extend(["", userperson_section])
    source_section = _source_receipts_section(inputs["source_receipts"])
    if source_section:
        mandatory.extend(["", source_section])
    xpatch_section = _xpatch_section(inputs.get("xpatch") or {})
    if xpatch_section:
        mandatory.extend(["", xpatch_section])
    if knowledge_section:
        mandatory.extend(["", knowledge_section])
    mandatory.extend(["", "## ROUTING", f"phase_doc: {phase_doc}"])
    fixed = "\n".join(mandatory) + "\n"

    # Bucket tickets exactly once
    buckets = {s: [] for s in ("## DOING", "## TODO", "## BLOCKED", "## DONE")}
    for t in board.get("tickets", {}).values():
        if t["section"] in buckets:
            buckets[t["section"]].append(t)

    # FULL unbounded body, for the honest pre-bound economics.
    full_body = (
        fixed
        + "\n"
        + (
            "## LOG TAIL\n" + _log_tail(log_event_lines) + "\n"
            "## BOARD MAP\n" + _board_map(buckets, full_ticket=next_ticket) + "\n"
        )
    )

    # STRUCTURAL fit: BOARD orientation shrinks before LOG evidence.
    board_part, log_part = _fit(
        fixed,
        limit,
        lambda cap: _board_map(buckets, full_ticket=next_ticket, cap=cap),
        lambda count: _log_tail(log_event_lines, count),
    )
    body = fixed + "\n" + ("## LOG TAIL\n" + log_part + "\n## BOARD MAP\n" + board_part + "\n")
    pre_bound = len(full_body.encode("utf-8"))
    emitted = len(body.encode("utf-8"))
    return Result(
        ok=True,
        code="CONTEXT_COLD",
        data={
            "surface": body,
            "bytes": emitted,
            "characters": len(body),
            "tokens": _tokens(body),
            "pre_bound_bytes": pre_bound,
            "truncation_bytes": max(0, pre_bound - emitted),
            "knowledge": {
                "index": knowledge_result.get("index"),
                "retrieved": len(knowledge_result.get("retrieved") or []),
                "loaded_paths": knowledge_result.get("loaded_paths") or [],
                "metadata_scanned": knowledge_result.get("metadata_scanned", 0),
            },
        },
    )


def context_hot(
    project_root: Path | str,
    limit: int = 3000,
    _inputs: dict | None = None,
    current_agent: str | None = None,
    _routed: dict | None = None,
) -> Result:
    """Current-work surface: STATE + computed next + active ticket + recent
    LOG + recovery state. Shares the router (NITRO dogfood II); metrics
    describe the emitted surface (NITRO dogfood IV, T-600). `_inputs` is the
    call-scoped capture from `_load_context_inputs` (audit reuses one world);
    when None the public API loads a fresh world itself."""
    root = Path(project_root)
    inputs = _inputs if _inputs is not None else _load_inputs_checked(root)
    if isinstance(inputs, Result):
        return inputs
    state_text = inputs["state_text"]
    board_text = inputs["board_text"]
    log_event_lines = inputs["log_event_lines"]
    state = inputs["state"]
    state_error = inputs["state_error"]
    if state_error:
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message=f"state-malformed: {state_error}",
            data={},
        )
    board = inputs["board"]
    doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
    pending = inputs["pending"]
    conflicts = inputs["conflicts"]
    from .router import (
        pending_append_projection,
        queued_source_projection,
        route_next,
        routing_failure_code,
    )

    # P0#4: same current-session capability authority as the cold-start
    # projection above. Second-wave P0: same session-agent claim truth.
    from .capability import negotiate_capability

    routed = (
        _routed
        if _routed is not None
        else route_next(
            state_text,
            board_text,
            pending,
            conflicts,
            current_capability=negotiate_capability(),
            current_agent=current_agent,
            snap=inputs["snap"],
            queued_source=queued_source_projection(root),
            pending_append=pending_append_projection(root),
        )
    )
    if not routed.get("ok") and routing_failure_code(routed) == "VALIDATION_FAILED":
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message=f"{routed.get('reason')}: " + str(routed.get("detail", "")),
            data={
                "recovery_pending": bool(pending),
                "recovery_conflict": bool(conflicts),
                "conflict_ops": conflicts,
                "pending_ops": pending,
            },
        )

    fixed_lines = [
                "## NOW",
                _state_fields(state),
                f"claimed_ticket: {doing[0]['id'] if doing else None}",
                "",
                "## COMPUTED NEXT",
                f"action: {routed.get('action')}",
                f"reason: {routed.get('reason')}",
                f"ticket: {routed.get('ticket') or 'none'}",
                "",
                "## MACHINE",
                f"recovery_pending: {bool(pending)}",
                f"recovery_conflict: {bool(conflicts)}",
                f"pending_ops: {', '.join(pending) or 'none'}",
                f"log_tail_event: {inputs['log_tail']}",
    ]
    userperson_section = _userperson_section(inputs["userperson"])
    if userperson_section:
        fixed_lines.extend(["", userperson_section])
    source_section = _source_receipts_section(inputs["source_receipts"])
    if source_section:
        fixed_lines.extend(["", source_section])
    fixed = "\n".join(fixed_lines) + "\n"
    full_body = fixed + "\n## RECENT LOG\n" + _log_tail(log_event_lines) + "\n"
    log_part = _log_tail(log_event_lines)
    # STRUCTURAL fit: RECENT LOG is the only optional section in hot. The
    # decision is made on the EXACT final surface (wrapper header + joining
    # newline included) in REAL UTF-8 bytes -- character counts would let a
    # multilingual surface exceed its declared budget (T-1003).
    for count in (12, 10, 8, 6, 4, 2, 0):
        log_part = _log_tail(log_event_lines, count)
        candidate = fixed + "\n## RECENT LOG\n" + log_part + "\n"
        if _bytes(candidate) <= limit:
            break
    body = fixed + "\n## RECENT LOG\n" + log_part + "\n"
    pre_bound = len(full_body.encode("utf-8"))
    emitted = len(body.encode("utf-8"))
    return Result(
        ok=True,
        code="CONTEXT_HOT",
        data={
            "surface": body,
            "bytes": emitted,
            "characters": len(body),
            "tokens": _tokens(body),
            "pre_bound_bytes": pre_bound,
            "truncation_bytes": max(0, pre_bound - emitted),
        },
    )


def context_audit(project_root: Path | str) -> Result:
    """Bytes/tokens accounting per source with an HONEST projection metric.

    `projection_reduction_bytes` = raw canonical bytes minus cold-surface
    bytes: it measures what the projection omits, NOT what is "unchanged"
    across revisions (NITRO dogfood II renames the old dishonest
    repeated_unchanged_bytes)."""
    root = Path(project_root)
    # ONE call-scoped capture: STATE/BOARD docs, one pending scan and one
    # complete LOG snapshot feed the source accounting AND both projections,
    # so audit never rescans/rerereads the same canonical world (T-1003, NITRO
    # perf pass). LOG evidence covers the SAME complete sealed+active history
    # the snapshot measures: an empty active LOG with sealed events must never
    # read as "(no events)" next to a non-empty log_tail.
    inputs = _load_inputs_checked(root)
    if isinstance(inputs, Result):
        return inputs
    sources = {
        "STATE.md": inputs["state_text"],
        "BOARD.md": inputs["board_text"],
        "LOG history (sealed + active)": inputs["log_text"],
    }
    source_byte_counts: dict[str, int] = {}
    effective = inputs["userperson"]
    for scope, label in (("global", "global USERPERSON"), ("project", "project USERPERSON")):
        source = effective["sources"][scope]
        if source["present"]:
            sources[label] = source["text"]
            source_byte_counts[label] = source["bytes"]
    # Active source bodies are authoritative current-task context economics,
    # but are captured only for audit accounting and never embedded in the
    # cold/hot surface. Archived bodies are intentionally not scanned.
    from .intake import _read_owned_file

    for item in inputs["source_receipts"]:
        label = f"source receipt {item['receipt']}"
        try:
            raw = _read_owned_file(
                root,
                f".saipen/intake/active/{item['receipt']}.md",
                kind="source body",
                max_bytes=64 * 1024 * 1024,
            )
        except (OSError, ValueError):
            continue
        text = raw.decode("utf-8")
        sources[label] = text
        source_byte_counts[label] = len(raw)
    pending = len(inputs["pending"])
    rows = []
    for name, text in sources.items():
        rows.append(
            {
                "source": name,
                "bytes": source_byte_counts.get(name, _bytes(text)),
                "characters": len(text),
                "tokens": _tokens(text),
            }
        )
    total_bytes = sum(r["bytes"] for r in rows)
    # PERF-004: compute the routed next action ONCE from the shared inputs and
    # reuse it for both projections -- cold and hot previously each re-ran the
    # full router (validation + routing) over the same world.
    from .capability import negotiate_capability
    from .router import pending_append_projection, queued_source_projection, route_next

    routed = route_next(
        inputs["state_text"],
        inputs["board_text"],
        inputs["pending"],
        inputs["conflicts"],
        current_capability=negotiate_capability(),
        current_agent=None,
        snap=inputs["snap"],
        queued_source=queued_source_projection(root),
        pending_append=pending_append_projection(root),
    )
    cold = context_cold(root, _inputs=inputs, _routed=routed)
    if not cold.ok:
        return cold
    hot = context_hot(root, _inputs=inputs, _routed=routed)
    if not hot.ok:
        return hot
    audit = {
        "sources": rows,
        "total_bytes": total_bytes,
        "cold_surface": {"bytes": cold.get("bytes"), "tokens": cold.get("tokens")},
        "hot_surface": {"bytes": hot.get("bytes"), "tokens": hot.get("tokens")},
        "projection_reduction_bytes": total_bytes - cold.get("bytes", 0),
        "note": (
            "projection_reduction_bytes = raw canonical bytes minus "
            "cold-surface bytes; it measures what the projection omits, "
            "never 'unchanged across revisions' (no historical comparison "
            "is made)"
        ),
        "log_tail_event": inputs["log_tail"],
        "recovery_pending": pending,
    }
    from .cold_truth import generated_handoff_provenance

    audit["provenance"] = generated_handoff_provenance(root, inputs["state"])
    return Result(ok=True, code="CONTEXT_AUDIT", data=audit)


def brief_projection(project_root: Path | str) -> Result:
    """The cold-handoff projection (T-1148): Work, attempt, stop reason,
    evidence, unknowns, next action -- synthesized from canonical state.

    A DERIVED projection and nothing more: it writes NOTHING, so deleting
    its output loses no information, and it can always be rebuilt from the
    authoritative files. It never executes `next_action`; printing a command
    is not running it.
    """
    root = Path(project_root)
    inputs = _load_inputs_checked(root)
    if isinstance(inputs, Result):
        return inputs
    # CORE-006 (audit ed1f86e8): fail closed before projection when STATE is
    # unparseable. brief_projection previously dereferenced state.get(...)
    # without checking state_error, so a torn STATE fence produced a raw
    # AttributeError instead of a controlled failure, and a malformed
    # STATE.task/attempt cross-link laundered into apparently healthy
    # machine-readable handoff JSON the validator rejects.
    state_error = inputs["state_error"]
    if state_error:
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message=f"state-malformed: {state_error}",
            data={},
        )
    state = inputs["state"]
    board = inputs["board"]
    if board.get("errors"):
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message="BOARD parse error(s): " + "; ".join(board["errors"][:3]),
            data={},
        )

    from . import attempt as attempt_mod

    records, fold_errors = attempt_mod.build_attempts(inputs["snap"].history.events)
    if fold_errors:
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message="LOG carries malformed attempt history: " + "; ".join(fold_errors[:3]),
            data={},
        )

    task = state.get("task")
    work_id = task if task and task != "none" else None
    objective = None
    if work_id and work_id in board["tickets"]:
        objective = board["tickets"][work_id].get("description") or None

    ordered = sorted(records.values(), key=lambda rec: rec["open_event"])
    current = None
    if work_id:
        open_here = [
            rec for rec in ordered if rec["close_event"] is None and rec["ticket"] == work_id
        ]
        if open_here:
            current = open_here[-1]
    pointer = state.get("attempt")
    if pointer is not None and (
        pointer not in records or records[pointer]["close_event"] is not None
    ):
        # A torn attempt pointer means the checkpoint does not describe a
        # real episode; projecting a healthy handoff from it would launder
        # the corruption into the next agent's context (hostile hunt H28).
        return Result(
            ok=False,
            code="VALIDATION_FAILED",
            op_id="",
            message=(
                f"STATE.attempt {pointer} names no open episode in the LOG -- "
                "torn attempt state; run tools/validate.py"
            ),
            data={},
        )
    if pointer is not None and records[pointer]["close_event"] is None:
        # CORE-006 (audit ed1f86e8): an open attempt pointer that belongs to a
        # DIFFERENT Work than STATE.task is incoherent and must be refused --
        # the checkpoint cannot project a handoff whose active episode is for
        # another ticket (the full validator rejects this STATE/attempt split).
        if work_id is not None and records[pointer].get("ticket") != work_id:
            return Result(
                ok=False,
                code="VALIDATION_FAILED",
                op_id="",
                message=(
                    f"STATE.attempt {pointer} belongs to "
                    f"{records[pointer].get('ticket')} but STATE.task is "
                    f"{work_id} -- attempt/Work split; run tools/validate.py"
                ),
                data={},
            )
        current = records[pointer]

    # CORE-004/CORE-006 (audit ed1f86e8): the pointer invariant is
    # bidirectional in the cold-handoff projection too. An open attempt on the
    # active Work with no matching STATE.attempt pointer is torn state: brief
    # must refuse it rather than project a healthy handoff that the full
    # validator rejects (close would say 'no active attempt', open would say
    # 'still open').
    if work_id is not None:
        open_work = [
            rec
            for rec in ordered
            if rec["close_event"] is None and rec["ticket"] == work_id
        ]
        if open_work:
            if len(open_work) > 1:
                return Result(
                    ok=False,
                    code="VALIDATION_FAILED",
                    op_id="",
                    message=(
                        f"{len(open_work)} open attempts exist for {work_id} "
                        "but STATE.attempt is a single pointer -- impossible, "
                        "run tools/validate.py"
                    ),
                    data={},
                )
            if pointer is None or pointer != open_work[0]["id"]:
                return Result(
                    ok=False,
                    code="VALIDATION_FAILED",
                    op_id="",
                    message=(
                        f"attempt {open_work[0]['id']} is open in the LOG for "
                        f"{work_id} but STATE carries no matching attempt "
                        "pointer -- torn attempt state; run tools/validate.py"
                    ),
                    data={},
                )

    previous = None
    closed = [rec for rec in ordered if rec["close_event"] is not None]
    if closed:
        prev_candidates = (
            [rec for rec in closed if rec["ticket"] == work_id] if work_id else []
        )
        previous = (prev_candidates or closed)[-1]

    def _attempt_view(rec):
        if rec is None:
            return None
        view = {"id": rec["id"], "result": rec["result"] or "active"}
        if rec["close_event"] is not None:
            view["stop_reason"] = rec["stop"]
        else:
            view["stop_reason"] = None
        return view

    blockers_all: list[str] = []
    state_blocker = str(state.get("blocker") or "").strip()
    if state_blocker and state_blocker.lower() not in ("none", ""):
        blockers_all.append(f"STATE: {state_blocker}")
    for ticket in board["tickets"].values():
        if ticket["section"] == "## BLOCKED":
            b = ticket["fields"].get("blocker") or ""
            blockers_all.append(f"{ticket['id']}: {b}".strip())
    blockers = [item[:200] for item in blockers_all[:8]]
    blockers_omitted = max(0, len(blockers_all) - len(blockers))

    unknowns_all: list[str] = []
    for rec in reversed(ordered):
        if work_id and rec["ticket"] != work_id:
            continue
        if rec.get("unknown"):
            unknowns_all.append(f"{rec['id']}: {rec['unknown']}")
    unknowns = [item[:200] for item in unknowns_all[:8]]
    unknowns_omitted = max(0, len(unknowns_all) - len(unknowns))

    tail = inputs["log_tail"]
    context_refs = [".saipen/STATE.md", ".saipen/BOARD.md"]
    if work_id:
        context_refs.append(f"BOARD:{work_id}")
    context_refs.append(f"LOG tail E-{tail}" if tail is not None else "LOG tail (empty)")
    effective = inputs["userperson"]
    userperson_meta = None
    if effective["active"]:
        userperson_meta = {
            "active": True,
            "global_present": effective["global"]["present"],
            "project_present": effective["project"]["present"],
            "effective_fingerprint": effective["effective_fingerprint"],
            "load": "saipen userperson show --effective --json",
        }
        context_refs.append("USERPERSON effective profile (explicit load required)")
    source_receipts = inputs["source_receipts"]
    source_meta = None
    if source_receipts:
        source_meta = {
            "active": len(source_receipts),
            "receipts": source_receipts[:8],
            "omitted": max(0, len(source_receipts) - 8),
            "load": "saipen source show <SRC-ID> --json",
        }
        context_refs.append("active SOURCE RECEIPTS (original reread required)")

    from .paths import project_lineage_identity
    from .cold_truth import generated_handoff_provenance

    project_lineage = project_lineage_identity(root)

    handoff_provenance = generated_handoff_provenance(root, state)

    # T-1446: the cold recovery carrier rides the brief so a zero-context
    # worker gets Work, owner/liveness, lease health and the exact next command
    # from ONE read-only surface. Watchdog observation is read-only by design.
    from . import board as _board_mod
    from . import watchdog as _watchdog_mod
    from .cold_recovery import build_recovery_package

    watchdog_status = _watchdog_mod.observe(root).as_dict()
    claim_liveness = ""
    if work_id and work_id in board["tickets"]:
        claim_liveness = _board_mod.claim_status(
            board["tickets"][work_id], agent=state.get("agent")
        )
    recovery = build_recovery_package(
        inputs["state_text"],
        inputs["board_text"],
        inputs["log_text"],
        runtime_state={
            "canonical_root": str(root),
            "project_identity": handoff_provenance["project_identity"],
            "project_lineage": project_lineage,
            "watchdog": watchdog_status,
            "claim_liveness": claim_liveness,
        },
    )

    payload = {
        "project": root.name,
        "project_identity": handoff_provenance["project_identity"],
        "project_lineage": project_lineage,
        "phase": state.get("phase"),
        "work_id": work_id or "none",
        "objective": objective,
        "attempt": _attempt_view(current),
        "previous_attempt": _attempt_view(previous),
        "previous_stop": previous["stop"] if previous else None,
        "blockers": blockers,
        "blockers_omitted": blockers_omitted,
        "context": context_refs,
        "unknowns": unknowns,
        "unknowns_omitted": unknowns_omitted,
        "next_action": state.get("next_action"),
        "userperson": userperson_meta,
        "source_receipts": source_meta,
        "last_event": state.get("last_event"),
        "state_updated": state.get("updated"),
        "based_on_event": handoff_provenance["based_on_event"],
        "generated_at": handoff_provenance["generated_at"],
        "runtime_generation": handoff_provenance["runtime_generation"],
        "implementation_checkpoint": handoff_provenance["implementation_checkpoint"],
        "provenance": handoff_provenance,
        "recovery": recovery,
    }

    def _or_none(value):
        return value if value not in (None, "", "none") else "none"

    lines = [
        f"PROJECT: {payload['project']}",
        f"LINEAGE: {_or_none(payload['project_lineage'])}",
        f"PHASE: {_or_none(payload['phase'])}",
        f"WORK: {payload['work_id']}",
        f"OBJECTIVE: {_or_none(payload['objective'])}",
    ]
    if current is not None:
        lines.append(
            f"ATTEMPT: {current['id']} "
            f"{current['result'] or 'active'}"
            + (f" (stop: {current['stop']})" if current["stop"] else "")
        )
    elif previous is not None:
        lines.append(
            f"ATTEMPT: {previous['id']} {previous['result']} (stop: {previous['stop']})"
        )
    else:
        lines.append("ATTEMPT: none recorded")
    lines.append(
        f"PREVIOUS_STOP: {payload['previous_stop'] or 'none'}"
    )
    blocker_line = "; ".join(blockers) if blockers else "none"
    if blockers_omitted:
        blocker_line += f"; +{blockers_omitted} more"
    lines.append(f"BLOCKERS: {blocker_line}")
    if userperson_meta is not None:
        lines.append(
            "USERPERSON: active "
            f"({userperson_meta['effective_fingerprint']}; "
            "load: saipen userperson show --effective --json)"
        )
    if source_meta is not None:
        lines.append(
            "SOURCE_RECEIPTS: active "
            + ", ".join(item["receipt"] for item in source_meta["receipts"])
            + (f", +{source_meta['omitted']} more" if source_meta["omitted"] else "")
            + " (load: saipen source show <SRC-ID> --json)"
        )
    lines.append("")
    lines.append("RELEVANT CONTEXT:")
    for ref in context_refs:
        lines.append(f"- {ref}")
    lines.append("")
    lines.append("KNOWN UNCERTAINTY:")
    if unknowns:
        for item in unknowns:
            lines.append(f"- {item}")
        if unknowns_omitted:
            lines.append(f"- +{unknowns_omitted} more")
    else:
        lines.append("- none recorded")
    lines.append("")
    lines.append("NEXT ACTION:")
    lines.append(str(payload["next_action"]))
    lines.append("")
    lines.append("RECOVERY (derived):")
    lines.append(f"- ACTIVE_WORK: {recovery['ACTIVE_WORK'] or 'none'}")
    lines.append(
        f"- OWNER: {recovery['OWNER'] or 'unclaimed'}"
        f" ({recovery['CLAIM_LIVENESS'] or 'unclassified'})"
    )
    lines.append(
        f"- LEASE: {recovery['MUTATION_LEASE'].get('state', 'UNKNOWN')}"
        f" gen={recovery['MUTATION_LEASE'].get('lease_generation', 'none')}"
    )
    lines.append(f"- NEXT_COMMAND: {recovery['NEXT_COMMAND']}")
    if recovery["DEFERRED"]:
        lines.append("- DEFERRED: " + ", ".join(d["id"] for d in recovery["DEFERRED"]))
    if recovery["DO_NOT_REPEAT"]:
        lines.append(f"- DO_NOT_REPEAT: {len(recovery['DO_NOT_REPEAT'])} recorded")
    surface = "\n".join(lines) + "\n"
    return Result(
        ok=True,
        code="BRIEF",
        data={"surface": surface, "json": payload},
    )
