"""Run-to-Closure automation projection (SRC-021 R2-R8).

The read-only machine surface the external Run-to-Closure transport (SAIPATCH)
consumes: an ``automation`` block on ``saipen status --json``. SAIPEN owns the
semantic truth inside it -- whether useful autonomous work remains, whether
the project is genuinely complete, whether continuation requires a
human/external event, and whether current convergence is valid for the latest
audit generation. This module only CLASSIFIES evidence ``saipen status``
already reads (the router verdict, the audit inbox transport state,
convergence receipts, the live source identity) into the closed SRC-021
vocabulary. It writes nothing, enqueues nothing, and never emits prose another
program may parse as truth.

The contract vocabulary (R2, R3):

- ``disposition`` is one of CONTINUE | COMPLETE | WAIT_USER | WAIT_EXTERNAL
  | BLOCKED | INVALID -- never anything else, so an unknown disposition on
  the consumer side fails closed by construction.
- ``next_command`` is ``"cc"`` exactly when disposition is CONTINUE, and
  ``None`` for every other disposition (R3).
- ``schema_version`` is 1; an unknown version on the consumer side fails
  closed (R3).

The engine dispositions map onto the contract as (R1 ownership invariant --
SAIPEN decides, SAIPATCH transports):

- EXECUTE_SELF and RECONCILE_SELF -> CONTINUE: a mechanical next action
  exists and no human/external authority owns it (recovery is agent work,
  never a human question; the safety valve is re-authorized by exactly the
  ordinary ``cc`` its own resume key names -- R7).
- WAIT_USER -> WAIT_USER; WAIT_EXTERNAL -> WAIT_EXTERNAL; BLOCKED -> BLOCKED.
  COMPLETE -> COMPLETE, only through the eight-condition closure gate (R5).
  INVALID -> INVALID: the state cannot be safely interpreted, a hard stop.

R5's gate is computed here from the same evidence the router consumes: audit
inbox quiescence (C1/C2), a convergence pass committed after the latest
audit-empty boundary and bound to the current epoch/source (C3/C4/C5/C6), no
workable board work (C7), and no human/external/blocking boundary (C8). A
physically empty ``audit/`` directory is NOT sufficient (R5 note): residue and
missing-after-capture orphans both veto quiescence.

The audit epoch is a deterministic digest of the CURRENT transport surface
(layer rows in every state + orphans + residue + allocator head). The race
rule (R6) then becomes a chronology test: the closure must postdate the last
audit consume event, or a newer epoch owns the project. Minute-precision LOG
stamps are compared conservatively (fail closed on ambiguity): a convergence
instant within the same minute as the boundary is treated as not-proven-after.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import re

SCHEMA_VERSION = 1

# Contract dispositions (R2/R3). Closed set -- nothing else may be emitted.
CONTINUE = "CONTINUE"
COMPLETE = "COMPLETE"
WAIT_USER = "WAIT_USER"
WAIT_EXTERNAL = "WAIT_EXTERNAL"
BLOCKED = "BLOCKED"
INVALID = "INVALID"

DISPOSITIONS = (
    CONTINUE,
    COMPLETE,
    WAIT_USER,
    WAIT_EXTERNAL,
    BLOCKED,
    INVALID,
)

# R3: only CONTINUE transports a synthetic cc.
_NEXT_COMMAND = {CONTINUE: "cc"}

# WAIT categories that are genuine human boundaries (R7: Run-to-Closure never
# pre-authorizes these -- manual verification, destructive confirmation,
# secrets/input the user owns, first publish, user brakes).
_HUMAN_WAIT_CATEGORIES = frozenset(
    {"user brake", "manual-verify", "destructive-op", "first-publish"}
)
# R7: only the soft safety-valve boundary (and INIT, which is mechanical
# bootstrapping, not a human question) keeps ordinary cc legal.
_PREAUTHORIZED_WAIT_CATEGORIES = frozenset({"safety valve", "init"})

# Stable reason codes for gate failures on the closure path.
RC_CLOSURE_COMPLETE = "closure-complete"
RC_AUTOMATION_FAILURE = "automation-projection-failed"
RC_SOURCE_IDENTITY_UNKNOWN = "source-identity-unknown"

_LOG_STAMP_RE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{2})(?: (\d{2}):(\d{2}))?$")


def _stamp_to_instant(stamp: str | None) -> datetime.datetime | None:
    """A LOG event stamp (``DD.MM.YY`` optionally ``HH:MM``) as UTC instant.

    Conservative by design: a stamp that does not parse is NOT evidence of
    an ordering -- the caller fails closed on None.
    """
    if not stamp:
        return None
    m = _LOG_STAMP_RE.match(stamp.strip())
    if not m:
        return None
    try:
        return datetime.datetime(
            2000 + int(m.group(3)),
            int(m.group(2)),
            int(m.group(1)),
            int(m.group(4) or 0),
            int(m.group(5) or 0),
            tzinfo=datetime.timezone.utc,
        )
    except ValueError:
        return None


def _iso_instant(value: str | None) -> datetime.datetime | None:
    """A strict ISO-8601 UTC ``created_at`` as an instant, or None."""
    from .board import iso_utc_sort_key

    return iso_utc_sort_key(value)


# ---------------------------------------------------------------------------
# audit transport facts
# ---------------------------------------------------------------------------


def audit_quiescent(status_out: dict) -> bool:
    """Canonical transport quiescence (R5 C1/C2).

    ``clean`` already means no canonical layer file and no residue in
    ``audit/``. On top of that: a corrupt binding, an invalid layer, a
    closed-but-unsettled layer, and a MISSING_AFTER_CAPTURE orphan all mean
    the transport still owns work or diagnostics -- none of them is
    quiescent.
    """
    if not status_out or not status_out.get("ok"):
        return False
    if not status_out.get("clean"):
        return False
    if status_out.get("closed_pending_delete"):
        return False
    if status_out.get("invalid"):
        return False
    for orphan in status_out.get("orphans") or []:
        if orphan.get("state") == "MISSING_AFTER_CAPTURE":
            return False
    return True


def audit_epoch(status_out: dict) -> str:
    """Deterministic digest of the CURRENT audit transport surface.

    Rendered as ``audit-epoch-v1:<sha256>``. The row set is the transport's
    own classification output -- every layer in every state, every orphan and
    every residue entry -- plus the allocator head, so consuming, re-enqueuing
    or residue growth all change the epoch. Sorted and separators-collapsed so
    the digest never depends on map iteration order. An absent or empty inbox
    is a legal, stable digest of the empty surface.
    """
    rows: list[tuple[str, str, str]] = []
    for item in status_out.get("pending") or []:
        rows.append(
            (
                str(item.get("path") or item.get("layer") or ""),
                str(item.get("state") or ""),
                str(item.get("sha256") or ""),
            )
        )
    for orphan in status_out.get("orphans") or []:
        rows.append(
            (
                str(orphan.get("rel") or ""),
                str(orphan.get("state") or ""),
                str(orphan.get("sha256") or ""),
            )
        )
    for item in status_out.get("residue") or []:
        rows.append((str(item.get("rel") or ""), "RESIDUE", ""))
    allocator = status_out.get("last_allocated_id")
    canonical = json.dumps(
        {"rows": sorted(rows), "allocator": allocator},
        sort_keys=True,
        separators=(",", ":"),
    )
    return "audit-epoch-v1:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# routing -> disposition (R1 ownership invariant)
# ---------------------------------------------------------------------------


def _routing_disposition(routed: dict | None, action: str, reason: str) -> tuple[str, str]:
    """The contract disposition a route verdict carries, plus its reason code.

    The engine route reasons and refusal reasons are already stable machine
    strings (``finish``, ``recovery-pending``, ``board-malformed`` ...), so
    they ARE the contract's ``reason_code``; no second vocabulary is minted
    for the common path.
    """
    if not isinstance(routed, dict):
        return INVALID, "automation-invalid-route"
    if not routed.get("ok"):
        # Refusals the agent itself can resolve mechanically remain
        # CONTINUE; refusals that mean the state cannot be safely read are
        # INVALID (R3 fail-closed).
        if reason in ("recovery-conflict", "recovery-pending"):
            return CONTINUE, reason
        # SRC-085 M3: a red conformance gate that owns the route is a STOP for
        # the transport. The routed action itself names the remediation, and
        # the block carries it as remediation_command; CONTINUE is not
        # advertised while an unaccepted red gate holds the route.
        if reason in ("conformance-remediation", "conformance-unhealthy"):
            return BLOCKED, "conformance-remediation"
        if reason == "conformance-unknown":
            return INVALID, "conformance-unknown"
        if reason in (
            "state-malformed",
            "board-malformed",
            "board-graph-invalid",
            "binding-mismatch",
            "checkpoint-invalid",
            "capability-invalid",
        ):
            return INVALID, reason
        return INVALID, reason or "route-refused"
    if reason == "wait" and action.startswith("WAIT:"):
        from .state import parse_wait

        category = parse_wait(action)
        if category in _HUMAN_WAIT_CATEGORIES:
            return WAIT_USER, f"wait-{category.replace(' ', '-')}"
        if category in _PREAUTHORIZED_WAIT_CATEGORIES:
            return CONTINUE, f"wait-{category.replace(' ', '-')}"
        return BLOCKED, f"wait-{category or 'unknown'}"
    named: dict[str, tuple[str, str]] = {
        "foreign-live": (WAIT_EXTERNAL, "foreign-live"),
        "read-only-mode": (BLOCKED, "read-only-mode"),
        "unblock": (BLOCKED, "unblock"),
        "audit-inbox-residue": (WAIT_USER, "audit-inbox-residue"),
        "audit-inbox-invalid": (CONTINUE, "audit-inbox-invalid"),
        "audit-inbox": (CONTINUE, "audit-inbox"),
        "bootstrap": (CONTINUE, "bootstrap"),
        # SRC-085 M3: a red conformance gate that owns the route is a STOP for
        # the transport, never a synthetic `cc` -- the routed action itself
        # names `saipen validate`, and the block carries it as
        # remediation_command. CONTINUE is not advertised while an unaccepted
        # red gate holds the route.
        "conformance-remediation": (BLOCKED, "conformance-remediation"),
        "conformance-unhealthy": (BLOCKED, "conformance-remediation"),
        "conformance-unknown": (INVALID, "conformance-unknown"),
    }
    if reason in named:
        return named[reason]
    # Every other routed reason is an executable next action (finish, start,
    # adopt, maintain, markhunt-continue, crew-converge, rejection-free audit
    # routing): agent work, no human question.
    return CONTINUE, reason or "routed"


# ---------------------------------------------------------------------------
# closure gate (R5 C1-C8, R6 race rule)
# ---------------------------------------------------------------------------


def _audit_consume_instants(history_events) -> list[datetime.datetime]:
    """Instants of every journaled audit consume boundary.

    The AUDIT_INBOX_CLOSED events are the transport's own durable record of a
    layer leaving the inbox -- the audit-empty boundary. Unknown dates are
    dropped (they contribute no ordering evidence); an event id alone is not
    used because global LOG event ids are not monotonic across torn/sealed
    history (T-1261 class).
    """
    instant_map: dict[int, datetime.datetime] = {}
    for ev in history_events or ():
        if not isinstance(ev, dict):
            continue
        if ev.get("taxonomy") != "RUN":
            continue
        text = str(ev.get("text") or "")
        if "AUDIT_INBOX_CLOSED" not in text:
            continue
        event_id = ev.get("event")
        stamp = ev.get("date")
        instant = _stamp_to_instant(stamp)
        if instant is None:
            continue
        if event_id is not None and event_id in instant_map:
            continue
        instant_map[event_id] = instant
    return sorted(instant_map.values())


def _latest_i_created_at(convergence: dict | None) -> str | None:
    """The created_at of the newest closure (I) stage, for the completed_at
    field and the after-boundary chronology test."""
    if not isinstance(convergence, dict):
        return None
    stages = convergence.get("stages") or []
    for stage in reversed(stages):
        if isinstance(stage, dict) and stage.get("stage") == "I":
            return stage.get("created_at")
    return None


def closure_gate(
    *,
    status_out: dict | None,
    convergence: dict | None,
    history_events,
    board: dict | None,
    state: dict | None,
    agent: str | None = None,
) -> dict:
    """The eight-condition closure verdict (R5) plus the CF-flag always
    computed. Returns ``{"conditions": {C1..C8: bool}, "complete": bool}``.

    The gate never mutates and never throws on bad evidence: every condition
    is a strict boolean and a condition with insufficient evidence is False
    (fail closed -- absence of proof is not closure).
    """
    from .board import convergence_closure_problems

    c_quiescent = audit_quiescent(status_out)
    board_problems = convergence_closure_problems(board or {}, agent=agent)
    convergence_ok = bool((convergence or {}).get("ok"))
    i_created = _latest_i_created_at(convergence)
    i_instant = _iso_instant(i_created)
    consume_instants = _audit_consume_instants(history_events)
    last_consume = consume_instants[-1] if consume_instants else None

    # C3/C6: the pass must be CURRENT against the live source identity --
    # convergence_verdict already refuses on any source mutation after the
    # final HUNT (that is exactly C6) -- and committed after the latest
    # audit-empty boundary. Minute-precision stamps are compared
    # conservatively: an I in the same minute as the boundary is ambiguous
    # and therefore not proven-after (R6 race rule fails closed).
    if i_instant is None:
        proven_after_boundary = False
    elif last_consume is None:
        # No audit consume boundary exists: the inbox has been empty since
        # before any convergence evidence -- nothing to outrun.
        proven_after_boundary = True
    else:
        # Minute-precision stamps: an I in the same minute as the boundary is
        # ambiguous, therefore not proven-after (R6 fails closed).
        proven_after_boundary = i_instant > last_consume + datetime.timedelta(minutes=1)
    # C5: no new audit generation after the pass -- a consume event whose
    # boundary is AT or AFTER the closure instant is a newer epoch (R6).
    # Same-minute ambiguity reads as possibly-newer, so it fails closed.
    if last_consume is None:
        no_new_generation = True
    elif i_instant is None:
        no_new_generation = False
    else:
        no_new_generation = last_consume < i_instant
    # C4: bound to the current audit epoch. The epoch is the CURRENT
    # transport surface; quiescence (C1) plus proven-after-boundary (C3) plus
    # no-new-generation (C5) together mean the pass postdates every evidenced
    # epoch change, which is the mechanical reading of "bound to the current
    # audit_epoch" with no stored audit-binding field.
    bound_to_epoch = bool(proven_after_boundary)

    wait_text = ""
    if isinstance(state, dict):
        candidate = state.get("next_action")
        if isinstance(candidate, str):
            wait_text = candidate

    conditions = {
        # C1 audit transport canonically quiescent.
        "C1": bool(c_quiescent),
        # C2 no actionable audit-linked work: quiescence + settled transport;
        # a bound ACTIVE receipt is surfaced as invalid/queued above.
        "C2": bool(c_quiescent),
        # C3 one full current convergence pass after the latest boundary.
        "C3": bool(proven_after_boundary),
        # C4 that convergence bound to the current audit_epoch.
        "C4": bool(bound_to_epoch),
        # C5 no new audit generation arrived afterward.
        "C5": bool(no_new_generation),
        # C6 no qualifying source mutation invalidated convergence.
        "C6": bool(convergence_ok),
        # C7 no workable TODO/DOING/follow-up remains.
        "C7": not board_problems,
        # C8 no human/external/blocking boundary: no binding WAIT and no
        # blocked phase (a live WI8 phrase is handled by routing already).
        "C8": not (wait_text.startswith("WAIT:")),
    }
    if last_consume is None:
        current = convergence_ok and i_created is not None
    elif i_instant is None:
        current = False
    else:
        # Current = the pass postdates the last audit-empty boundary; a
        # consume AT or after the pass means a newer epoch owns progress.
        current = convergence_ok and last_consume < i_instant
    return {
        "conditions": conditions,
        "complete": all(conditions.values()),
        "convergence_current": bool(current),
    }


# ---------------------------------------------------------------------------
# public projection
# ---------------------------------------------------------------------------


def automation_block(
    project_root,
    *,
    state: dict | None,
    board: dict | None,
    routed: dict | None,
    history_events=(),
    audit_status: dict | None = None,
    convergence: dict | None = None,
    source_identity=None,
    agent: str | None = None,
) -> dict:
    """One read-only ``automation`` block for ``saipen status --json``.

    Every caller-supplied value is already the same evidence ``saipen status``
    reads (the parsed state/board, the route verdict, the audit inbox status);
    `automation_block` only classifies it, so the block can never disagree with
    the projection beside it. When a value is omitted it is computed here from
    the canonical engine modules.

    The block NEVER fails open: any internal failure yields an INVALID block
    with ``next_command: null`` and a named failure, never a fabricated
    CONTINUE/COMPLETE.
    """
    try:
        if audit_status is None:
            from .audit_inbox import status as audit_inbox_status

            audit_status = audit_inbox_status(project_root)
        if convergence is None:
            from .convergence import convergence_verdict

            convergence = convergence_verdict(project_root).as_dict()
        action = str((routed or {}).get("action") or "")
        route_reason = str((routed or {}).get("reason") or "")

        disposition, reason_code = _routing_disposition(routed, action, route_reason)

        gate = closure_gate(
            status_out=audit_status,
            convergence=convergence,
            history_events=history_events,
            board=board,
            state=state,
            agent=agent,
        )
        closure_complete = False
        completed_at: str | None = None
        if disposition == CONTINUE:
            if gate["complete"]:
                disposition = COMPLETE
                reason_code = RC_CLOSURE_COMPLETE
                closure_complete = True
                completed_at = _latest_i_created_at(convergence)
            elif route_reason == "maintain":
                # The idle route is where the closure question is live: name
                # the unmet conditions instead of a bare "maintain".
                missing = [k for k, v in gate["conditions"].items() if not v]
                reason_code = f"closure-conditions-{'-'.join(missing)}"

        # Source identity: needed for the fingerprint field and, on the
        # closure path, as the C6 binding truth.
        source_fingerprint: str | None = None
        if source_identity is None:
            try:
                from freshness import compute_source_identity

                source_identity = compute_source_identity(project_root)
            except Exception:
                source_identity = None
        if source_identity is not None:
            if getattr(source_identity, "source_tree_fingerprint", None):
                source_fingerprint = (
                    f"{getattr(source_identity, 'source_head', '') or 'no-git'}"
                    f"+{source_identity.source_tree_fingerprint}"
                )
        if source_identity is None or source_fingerprint is None:
            if gate["convergence_current"] or closure_complete:
                closure_complete = False

        quiescent = audit_quiescent(audit_status)
        epoch = audit_epoch(audit_status)

        # SRC-085 M3: when the red gate owns the route, the machine surface
        # names the ONE executable remediation instead of leaving a consumer to
        # mine LOG prose for why CURRENT_FAIL and a stop coexist.
        remediation_command: str | None = None
        if reason_code in ("conformance-remediation", "conformance-unknown"):
            remediation_command = (routed or {}).get("canonical_next_command")

        reason_text = None
        if disposition == COMPLETE:
            reason_text = (
                "all eight closure conditions mechanically true; "
                f"convergence bound to source {source_fingerprint or 'UNKNOWN'} "
                f"and audit epoch {epoch}"
            )
        elif isinstance(routed, dict) and routed.get("detail"):
            reason_text = str(routed.get("detail"))
        else:
            reason_text = f"route reason: {route_reason or 'none'}"

        block = {
            "schema_version": SCHEMA_VERSION,
            "disposition": disposition,
            "next_command": _NEXT_COMMAND.get(disposition),
            "reason_code": reason_code,
            "reason": reason_text,
            "audit_quiescent": quiescent,
            "audit_epoch": epoch,
            "convergence_current": bool(gate["convergence_current"]),
            "closure_complete": closure_complete,
            "source_fingerprint": source_fingerprint,
            "completed_at": completed_at,
        }
        if reason_code in ("conformance-remediation", "conformance-unknown"):
            block["remediation_command"] = remediation_command
            block["diagnostic"] = (routed or {}).get("diagnostic")
        return block
    except Exception as exc:
        return failed_automation_block(RC_AUTOMATION_FAILURE, f"{type(exc).__name__}: {exc}")


def failed_automation_block(reason_code: str, reason: str) -> dict:
    """An INVALID fail-closed block for callers whose projection input could
    not even be assembled (R3)."""
    return {
        "schema_version": SCHEMA_VERSION,
        "disposition": INVALID,
        "next_command": None,
        "reason_code": reason_code,
        "reason": reason,
        "audit_quiescent": False,
        "audit_epoch": None,
        "convergence_current": False,
        "closure_complete": False,
        "source_fingerprint": None,
        "completed_at": None,
    }
