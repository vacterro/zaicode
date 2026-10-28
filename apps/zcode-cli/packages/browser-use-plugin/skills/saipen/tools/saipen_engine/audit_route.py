"""Did the agent follow the audit route? (T-1270, `SOURCE-AUDIT-INBOX-01`)

The route is deterministic in law and in code. `SOURCES.md` gives ingest the
lowest workable layer and ordinary BOARD priority for the derived Work, and the
router reaches that stage whenever no live ticket owns continuation. So WHICH
findings to fix was never a human choice -- and nothing verified that an agent
had followed it.

Witnessed on another project running this protocol: an agent found a 17-ticket
audit campaign, then stopped and offered the human a three-option scope menu.
`wait_categories` is a closed set of seven and scope selection is not among
them, so that pause had no legal form. It also had no detector, and a rule with
a route and no detector is a preference.

This module is the DECISION only, kept pure so the promise is provable without
copying a tree and running the whole validator. It reads a projection someone
else built, writes nothing, and knows nothing about how the finding is
reported.
"""

from __future__ import annotations

import datetime
import re

#: `PHASE <NAME> <T-N>` -- the shape of a live phase-owned continuation.
_CONTINUATION = re.compile(r"PHASE\s+[A-Z]+\s+(T-\d+)\s*$")


def audit_route_owns(
    projection: object,
    tickets: dict | None = None,
    agent: str | None = None,
    now: datetime.datetime | None = None,
) -> bool:
    """Does the audit inbox own continuation right now?

    True when:
    1. projection is a dict with an 'action'
    2. not invalid_only and not residue_only
    3. if the action is a PHASE action bound to a work ticket:
       when tickets is provided, that work ticket must be workable.
       A blocked or unworkable ticket must not own continuation -- the router
       falls through to the Pick Rule, and the validator must agree.
    """
    if not isinstance(projection, dict) or not projection.get("action"):
        return False
    if projection.get("invalid_only") or projection.get("residue_only"):
        return False
    work = projection.get("work")
    action_str = str(projection.get("action", ""))
    if work and action_str.startswith("PHASE ") and tickets is not None:
        from saipen_engine.board import ticket_is_workable

        ticket = tickets.get(work, {})
        if not ticket_is_workable(ticket, tickets, agent=agent, now=now):
            return False
    return True


def route_applies(projection: object) -> bool:
    """Does the inbox own a routable action right now?

    False for an absent or empty inbox, and false for the two diagnostic
    verdicts. An unreadable layer and an uncaptured leftover are conditions
    the operator must see, not Work -- the router does not route them either,
    so a check that fired on them would demand an agent follow a route that
    does not exist.
    """
    return audit_route_owns(projection)


def live_continuation(next_action: str, doing_ids) -> str | None:
    """The DOING ticket this `next_action` is continuing, or None.

    A DOING ticket alone proves nothing: a `next_action` that has wandered off
    its own ticket is exactly the drift being looked for, so the continuation
    has to NAME the claimed ticket.
    """
    match = _CONTINUATION.fullmatch((next_action or "").strip())
    if match is None:
        return None
    ticket = match.group(1)
    return ticket if ticket in set(doing_ids or ()) else None


def route_violation(
    projection: object,
    next_action: str,
    doing_ids=(),
    wait_categories=(),
    tickets: dict | None = None,
    agent: str | None = None,
    now: datetime.datetime | None = None,
) -> str | None:
    """Why the audit route was not followed, or None when it was.

    The returned text always NAMES the routed action, because a diagnostic that
    says only "wrong" leaves the agent exactly as stuck as it was.
    """
    if not audit_route_owns(projection, tickets=tickets, agent=agent, now=now):
        return None
    assert isinstance(projection, dict)  # narrowed by audit_route_owns
    routed = str(projection["action"])
    current = (next_action or "").strip()
    if current == routed or live_continuation(current, doing_ids):
        return None
    why = (
        f"the audit inbox routes {routed!r} (layer {projection.get('layer')}, "
        f"{projection.get('path')}) but next_action is "
        f"{current or '(empty)'!r}, which is neither that action nor a "
        f"live-ticket continuation"
    )
    if current.startswith("WAIT") and wait_categories:
        # A scope question -- "which of these findings should I fix?" -- has no
        # legal form. WAIT is a CLOSED set and scope selection is not in it, so
        # such a pause is not a slow answer; it is an answer the protocol has
        # no category for.
        why += (
            f". WAIT is a closed set of {len(wait_categories)} categories "
            f"({', '.join(wait_categories)}) and scope selection is not among "
            f"them, so asking which findings to fix has no legal form"
        )
    return why
