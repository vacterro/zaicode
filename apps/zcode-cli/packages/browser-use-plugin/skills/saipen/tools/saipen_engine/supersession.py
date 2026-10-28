"""Terminal Work supersession authority and evidence.

Supersession is local lifecycle truth: legitimate old Work was implemented
and verified through a later Work item, so it no longer owns an executable
delta.  It is neither retirement nor publication authority.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from . import intake

GRANT_HEADER = "This message supplies operator authority for Work supersession:"
GRANT_TERMINATOR = "only."

AUTHORITY_SOURCE_KINDS = (
    "user_instruction",
    "user_audit",
    "implementation_mission",
    "review_handoff",
    "corrective_followup",
)

_TICKET_RE = re.compile(r"^T-\d+$")
_EVENT_RE = re.compile(r"^E-(\d+)$")
_GRANT_ITEM_RE = re.compile(r"^[ \t]*(T-\d+)[ \t]+-[ \t]+(T-\d+)[ \t]*$")
_FENCE_RE = re.compile(r"^[ \t]{0,3}(```|~~~)")
_TARGET_PASS_RE = re.compile(r"^verify -> PASS \[target: (T-\d+)\](?:\s|$)")
_COMPLETION_RE = re.compile(r"^ticket finished via SAIOPS -- completion(?: \(from SHIP\))?$")


@dataclass(frozen=True)
class GrantParse:
    grants: dict[str, str]
    lines: dict[str, str]
    problems: tuple[str, ...]


def authority_grants(text: str) -> GrantParse:
    """Parse only closed, unfenced OLD - NEW supersession capsules."""
    lines = text.splitlines()
    grants: dict[str, str] = {}
    grant_lines: dict[str, str] = {}
    conflicted: set[str] = set()
    problems: list[str] = []
    fence: str | None = None
    i = 0
    while i < len(lines):
        line = lines[i]
        fenced = _FENCE_RE.match(line)
        if fence is not None:
            if fenced and fenced.group(1) == fence:
                fence = None
            i += 1
            continue
        if fenced:
            fence = fenced.group(1)
            i += 1
            continue
        if line.rstrip() != GRANT_HEADER:
            i += 1
            continue
        header_line = i + 1
        items: list[tuple[str, str, str]] = []
        j = i + 1
        closed = False
        malformed: str | None = None
        while j < len(lines):
            candidate = lines[j]
            if not candidate.strip():
                j += 1
                continue
            if candidate.rstrip() == GRANT_TERMINATOR:
                closed = True
                break
            item = _GRANT_ITEM_RE.fullmatch(candidate)
            if not item:
                malformed = f"line {j + 1} is neither OLD - NEW nor the terminator"
                break
            items.append((item.group(1), item.group(2), candidate.strip()))
            j += 1
        if malformed is None and not closed:
            malformed = "it is never closed"
        if malformed is None and not items:
            malformed = "it grants no Work pair"
        if malformed is not None:
            problems.append(
                f"Work-supersession capsule at line {header_line} is malformed "
                f"({malformed}) and grants nothing"
            )
            i = j + 1 if closed else max(j, i + 1)
            continue
        for old, new, raw in items:
            if old in grants and grants[old] != new:
                conflicted.add(old)
            grants.setdefault(old, new)
            grant_lines.setdefault(old, raw)
        i = j + 1
    for old in sorted(conflicted):
        problems.append(f"{old} is granted to conflicting successors and so is not granted")
        grants.pop(old, None)
        grant_lines.pop(old, None)
    return GrantParse(grants, grant_lines, tuple(problems))


def grammar_hint() -> str:
    return (
        f"a capsule is a line `{GRANT_HEADER}`, one `T-OLD - T-NEW` line per "
        f"grant, then a line `{GRANT_TERMINATOR}`"
    )


def authority_error(
    root: Path,
    authority_receipt: str,
    *,
    old_ticket: str,
    successor_ticket: str,
) -> tuple[str | None, dict | None]:
    """Return why stored operator authority does not grant this exact pair."""
    if not intake._valid_receipt_id(authority_receipt):
        return f"authority {authority_receipt!r} is not a receipt id", None
    meta = intake._read_meta(root, authority_receipt)
    if not meta:
        return f"authority receipt {authority_receipt} has no active metadata", None
    if meta.get("status") != intake.ACTIVE_STATUS:
        return (
            f"authority receipt {authority_receipt} is {meta.get('status')!r}; "
            "supersession authority must be an ACTIVE operator decision",
            None,
        )
    if meta.get("source_kind") not in AUTHORITY_SOURCE_KINDS:
        return (
            f"authority receipt {authority_receipt} is a {meta.get('source_kind')!r} "
            "source; Work supersession requires the operator's own ingress",
            None,
        )
    integrity = intake.verify_integrity(root, authority_receipt)
    if not integrity["ok"]:
        return f"authority receipt {authority_receipt}: {integrity['code']}", None
    body = intake.read_body(root, authority_receipt)
    if not body.get("ok"):
        return f"authority receipt {authority_receipt} body unreadable", None
    parsed = authority_grants(str(body.get("body") or ""))
    granted = parsed.grants.get(old_ticket)
    if granted != successor_ticket:
        detail = (
            f"authority receipt {authority_receipt} grants no Work supersession "
            f"{old_ticket} - {successor_ticket}"
        )
        if parsed.problems:
            detail += " (" + "; ".join(parsed.problems[:3]) + ")"
        return detail + " -- " + grammar_hint(), None
    return None, {
        "authority_receipt": authority_receipt,
        "authority_sha256": meta.get("source_sha256"),
        "authority_grant": parsed.lines[old_ticket],
    }


def evidence_error(
    events,
    evidence_ref: str,
    *,
    old_ticket: str,
    successor_ticket: str,
) -> tuple[str | None, dict | None]:
    """Require a successor-owned PASS targeted exactly at OLD, then completion."""
    match = _EVENT_RE.fullmatch(str(evidence_ref or "").strip().upper())
    if not match:
        return "supersession evidence must be an exact canonical E-### event", None
    number = int(match.group(1))
    by_number = {
        int(event.get("event")): event
        for event in events
        if isinstance(event, dict) and isinstance(event.get("event"), int)
    }
    event = by_number.get(number)
    if event is None:
        return f"supersession evidence E-{number} does not exist", None
    target = _TARGET_PASS_RE.match(str(event.get("text") or ""))
    if (
        event.get("taxonomy") != "RUN"
        or event.get("ticket") != successor_ticket
        or target is None
        or target.group(1) != old_ticket
    ):
        return (
            f"E-{number} is not a RUN verify -> PASS owned by {successor_ticket} "
            f"and explicitly targeted at {old_ticket}",
            None,
        )
    completions = [
        candidate
        for candidate in by_number.values()
        if int(candidate.get("event")) > number
        and candidate.get("ticket") == successor_ticket
        and candidate.get("taxonomy") == "DEC"
        and _COMPLETION_RE.fullmatch(str(candidate.get("text") or ""))
    ]
    if not completions:
        return (
            f"{successor_ticket} has no canonical completion event after E-{number}; "
            "a DONE row alone cannot prove ordering",
            None,
        )
    completion = min(completions, key=lambda item: int(item["event"]))
    return None, {
        "evidence": f"E-{number}",
        "target": old_ticket,
        "successor": successor_ticket,
        "successor_completion": f"E-{completion['event']}",
    }


def cycle_error(tickets: dict, old_ticket: str, successor_ticket: str) -> str | None:
    """Why adding OLD -> NEW would create a supersession cycle."""
    chain = [old_ticket, successor_ticket]
    seen = {old_ticket}
    current = successor_ticket
    while current:
        if current in seen:
            return "cyclic Work supersession: " + " -> ".join(chain)
        seen.add(current)
        ticket = tickets.get(current)
        if ticket is None:
            return None
        current = str((ticket.get("fields") or {}).get("superseded_by") or "").strip()
        if current:
            chain.append(current)
    return None
