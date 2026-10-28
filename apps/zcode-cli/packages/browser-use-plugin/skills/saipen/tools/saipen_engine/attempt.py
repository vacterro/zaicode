"""Attempt lifecycle -- Work vs Attempt separation (T-1148).

A SAIPEN ticket (Work) is durable; an Attempt is one bounded execution
episode of one agent working that ticket. An agent dying, a context window
ending, or a provider switching must never rename, fail, or destroy the
Work -- only the Attempt closes. The Attempt record lives in the existing
append-only LOG as machine-owned DEC events plus an optional STATE pointer;
there is no second storage engine, no daemon, no database.

Event grammar (the ONE shared form; validator and engine parse these):

    open:   attempt A-### open[; supersedes A-###]
    close:  attempt A-### close result R stop S[ -- evidence E-###(,...)][; unknown: <text>]

Closed vocabularies and the result->stop matrix live here so the CLI, the
fast gate and the release validator can never drift.
"""

from __future__ import annotations

import re

# The closed Attempt result vocabulary. `active` is DERIVED (an open with no
# close) and is never written.
RESULTS = ("candidate", "failed", "interrupted", "yielded", "superseded")

# Why the episode stopped. Independent from the result on purpose: an
# interrupted attempt may stop for context/provider/crash reasons, and only
# the matrix below says which pairing is truthful.
STOP_REASONS = (
    "completed_execution",
    "context_limit",
    "provider_limit",
    "provider_failure",
    "process_crash",
    "user_stop",
    "capability_missing",
    "validation_failure",
    "deliberate_handoff",
    "unknown",
)

# The closed result -> allowed stop reasons matrix. Anything else refuses:
# a result/stop pairing outside this table is a fabricated record, not a
# nuance (fail-closed).
RESULT_STOP_MATRIX = {
    "candidate": ("completed_execution",),
    "failed": ("validation_failure", "capability_missing"),
    "interrupted": (
        "context_limit",
        "provider_limit",
        "provider_failure",
        "process_crash",
        "unknown",
    ),
    "yielded": ("user_stop", "deliberate_handoff"),
    "superseded": ("deliberate_handoff", "unknown"),
}

MAX_EVIDENCE_REFS = 8
MAX_UNKNOWN_CHARS = 200

_ATTEMPT_ID = r"A-\d{3,}"
OPEN_RE = re.compile(
    rf"^attempt ({_ATTEMPT_ID}) open(?:; supersedes ({_ATTEMPT_ID}))?$"
)
_CLOSE_HEAD_RE = re.compile(
    rf"^attempt ({_ATTEMPT_ID}) close result ([a-z_]+) stop ([a-z_]+)"
)
_EVIDENCE_ITEM_RE = re.compile(r"^E-\d+$")


def parse_attempt_text(text: str):
    """Parse the text payload of a DEC line as an attempt event.

    Returns None when the text is not an attempt event at all (the common
    case for every other DEC line), and raises ValueError for a malformed
    ATTEMPT-looking payload so corruption is never silently downgraded to
    "some other DEC".
    """
    stripped = (text or "").strip()
    if not stripped.startswith("attempt "):
        return None
    # Only a payload whose SECOND token is an A-### id claims the attempt
    # grammar. Ordinary English DEC prose may begin with the word "attempt"
    # ("attempt to fix flaky harness -> gave up") -- that is not an attempt
    # event and must parse as None, never as a corruption error (hostile
    # hunt H21). A real A-### id (any digit width) with a broken tail IS
    # corruption and fails loudly.
    second = stripped.split(None, 2)[1] if len(stripped.split(None, 2)) > 1 else ""
    if not re.fullmatch(r"A-\d+", second):
        return None

    m = OPEN_RE.match(stripped)
    if m:
        return {"kind": "open", "id": m.group(1), "supersedes": m.group(2)}

    head = _CLOSE_HEAD_RE.match(stripped)
    if not head:
        raise ValueError(
            f"malformed attempt event: {stripped[:120]!r} "
            "(expected 'attempt A-### open' or 'attempt A-### close "
            "result <result> stop <stop> [-- evidence ...][; unknown: ...]')"
        )
    record = {
        "kind": "close",
        "id": head.group(1),
        "result": head.group(2),
        "stop": head.group(3),
        "evidence": [],
        "unknown": None,
    }
    rest = stripped[head.end() :]

    unknown_sep = "; unknown:"
    if unknown_sep in rest:
        body, _, unknown_text = rest.partition(unknown_sep)
        unknown_text = unknown_text.strip()
        if "\n" in unknown_text:
            raise ValueError("attempt unknown clause must stay on one line")
        if len(unknown_text) > MAX_UNKNOWN_CHARS:
            raise ValueError(
                f"attempt unknown clause exceeds {MAX_UNKNOWN_CHARS} chars "
                f"(got {len(unknown_text)}) -- bounded field, shorten it"
            )
        record["unknown"] = unknown_text
    else:
        body = rest

    body = body.strip()
    if body:
        prefix = "-- evidence "
        if not body.startswith(prefix):
            raise ValueError(f"malformed attempt close tail: {body[:80]!r}")
        refs = [r.strip() for r in body[len(prefix) :].split(",")]
        if len(refs) > MAX_EVIDENCE_REFS:
            raise ValueError(
                f"attempt evidence carries {len(refs)} refs; bound is "
                f"{MAX_EVIDENCE_REFS}"
            )
        for ref in refs:
            if not _EVIDENCE_ITEM_RE.match(ref):
                raise ValueError(f"attempt evidence ref {ref!r} is not an E-### id")
        record["evidence"] = refs
    return record


def parse_attempt_event(ev: dict):
    """(record, error) for one parsed LOG event. (None, None) = not attempt."""
    if ev.get("taxonomy") != "DEC":
        return None, None
    try:
        record = parse_attempt_text(ev.get("text") or "")
    except ValueError as exc:
        return None, str(exc)
    if record is None:
        return None, None
    record["event"] = ev["event"]
    record["ticket"] = ev.get("ticket")
    record["agent"] = ev.get("agent")
    return record, None


def build_attempts(events) -> tuple[dict, list[str]]:
    """Fold the complete event history into ordered Attempt records.

    Returns ({id: record}, errors). Each record:
      {id, ticket, agent, open_event, close_event|None, result|None,
       stop|None, evidence, unknown|None, supersedes|None}
    """
    records: dict[str, dict] = {}
    errors: list[str] = []
    order: list[str] = []
    for ev in events:
        record, err = parse_attempt_event(ev)
        if err is not None:
            errors.append(f"E-{ev['event']}: {err}")
            continue
        if record is None:
            continue
        aid = record["id"]
        if record["kind"] == "open":
            if aid in records:
                errors.append(
                    f"E-{ev['event']}: duplicate attempt id {aid} "
                    f"(first opened at E-{records[aid]['open_event']})"
                )
                continue
            if record["supersedes"] is not None and record["supersedes"] not in records:
                errors.append(
                    f"E-{ev['event']}: {aid} supersedes "
                    f"{record['supersedes']}, which has no earlier open event"
                )
            records[aid] = {
                "id": aid,
                "ticket": record.get("ticket"),
                "agent": record.get("agent"),
                "open_event": record["event"],
                "close_event": None,
                "result": None,
                "stop": None,
                "evidence": [],
                "unknown": None,
                "supersedes": record.get("supersedes"),
                # CORE-005 (audit ed1f86e8): the CLOSE actor is distinct from
                # the OPEN owner. A successor a2 recovering a stale predecessor
                # episode closes under its own seat; replay identity must match
                # the close actor, not the opener.
                "close_agent": None,
            }
            order.append(aid)
            continue

        # close
        existing = records.get(aid)
        if existing is None:
            errors.append(
                f"E-{ev['event']}: attempt {aid} closes without any open event"
            )
            continue
        if existing["close_event"] is not None:
            errors.append(
                f"E-{ev['event']}: attempt {aid} closed twice "
                f"(first at E-{existing['close_event']})"
            )
            continue
        if record.get("ticket") != existing["ticket"]:
            errors.append(
                f"E-{ev['event']}: attempt {aid} close names ticket "
                f"{record.get('ticket') or 'none'} but its open named "
                f"{existing['ticket'] or 'none'} -- an attempt belongs to "
                "exactly one Work"
            )
            continue
        if record["result"] not in RESULTS:
            errors.append(
                f"E-{ev['event']}: attempt {aid} result {record['result']!r} "
                f"is not one of {'|'.join(RESULTS)}"
            )
            continue
        allowed = RESULT_STOP_MATRIX[record["result"]]
        if record["stop"] not in STOP_REASONS:
            errors.append(
                f"E-{ev['event']}: attempt {aid} stop reason "
                f"{record['stop']!r} is not one of {'|'.join(STOP_REASONS)}"
            )
            continue
        if record["stop"] not in allowed:
            errors.append(
                f"E-{ev['event']}: attempt {aid} pairs result "
                f"{record['result']} with stop {record['stop']}; allowed "
                f"stops for that result: {'|'.join(allowed)}"
            )
            continue
        existing["close_event"] = record["event"]
        existing["result"] = record["result"]
        existing["stop"] = record["stop"]
        existing["evidence"] = record["evidence"]
        existing["unknown"] = record["unknown"]
        if record.get("agent") and not existing["agent"]:
            existing["agent"] = record.get("agent")
        # CORE-005: preserve the CLOSE actor separately from open ownership so
        # replay identity (and successor recovery replay) match the right seat.
        existing["close_agent"] = record.get("agent") or existing["close_agent"]

    # Predecessor links must walk backwards in time and must not cycle. A
    # cycle needs a forward reference, which the earlier-existence rule above
    # already refuses; this pass proves acyclicity independently of event ids.
    for aid, rec in records.items():
        seen = {aid}
        cur = rec.get("supersedes")
        while cur is not None:
            if cur in seen:
                errors.append(f"attempt lineage cycle through {cur} starting at {aid}")
                break
            seen.add(cur)
            nxt = records.get(cur)
            if nxt is None:
                break
            cur = nxt.get("supersedes")
    return records, errors


def active_attempts(records: dict) -> list[str]:
    """Attempt IDs that are open (no close), in first-open order."""
    return [
        aid
        for aid, rec in sorted(records.items(), key=lambda kv: kv[1]["open_event"])
        if rec["close_event"] is None
    ]


def next_attempt_id(events) -> str:
    """One above the highest attempt ID ever recorded (never reused)."""
    highest = 0
    for ev in events:
        record, _err = parse_attempt_event(ev)
        if record is None:
            continue
        m = re.match(r"^A-(\d{3,})$", record["id"])
        if m:
            highest = max(highest, int(m.group(1)))
    return f"A-{highest + 1:03d}"


def contract_errors(
    events,
    state_fields: dict,
    known_ticket_ids=None,
) -> list[str]:
    """The full Attempt contract over one history snapshot.

    Proves: legal grammar, unique IDs, open/close pairing, single active
    attempt project-wide, ticket coherence, closed vocabularies + matrix,
    resolvable evidence references, acyclic predecessor chains, bounded
    fields, and the STATE.attempt pointer agreement:

      * pointer present  -> task != none AND exactly that attempt is open
        AND its ticket == task;
      * pointer absent   -> fine (legacy projects carry no attempts).
    """
    errors: list[str] = []
    records, fold_errors = build_attempts(events)
    errors.extend(fold_errors)

    opens_without_close = active_attempts(records)
    if len(opens_without_close) > 1:
        errors.append(
            f"multiple open attempts ({', '.join(opens_without_close)}) -- "
            "single-writer semantics allow at most one active attempt "
            "project-wide; close or supersede before opening another"
        )

    if known_ticket_ids is not None:
        for aid, rec in records.items():
            tid = rec.get("ticket")
            # W2-003 (audit ed1f86e8): `T-none` is a legal general LOG
            # no-ticket marker, but an ATTEMPT is an execution episode on real
            # Work. An attempt attached to `T-none` bypasses ticket coherence
            # entirely and would let hand-forged/imported history create
            # validator-green execution episodes on "no Work". Reject it
            # explicitly in the narrower Attempt domain.
            if tid == "T-none":
                errors.append(
                    f"attempt {aid} is attached to 'T-none' -- an attempt "
                    "executes claimed Work and must carry a real T-### "
                    "ticket id"
                )
            elif tid and tid not in known_ticket_ids:
                errors.append(
                    f"attempt {aid} references {tid}, which is neither on "
                    "the board nor anywhere in canonical history -- an "
                    "attempt cannot attach to nonexistent Work"
                )

    event_ids = {ev["event"] for ev in events}
    for aid, rec in records.items():
        for ref in rec.get("evidence") or []:
            num = int(ref[2:])
            if num not in event_ids:
                errors.append(
                    f"attempt {aid} cites evidence {ref}, which does not "
                    "exist in the LOG -- dangling evidence can never prove "
                    "anything"
                )

    pointer = state_fields.get("attempt")
    if pointer is not None:
        if state_fields.get("task", "none") in (None, "", "none"):
            errors.append(
                f"STATE.attempt {pointer} present but task is none -- an "
                "attempt attaches to claimed Work, never to nothing"
            )
        elif pointer not in records:
            errors.append(
                f"STATE.attempt {pointer} has no open event in the LOG -- "
                "Work names an attempt that does not exist"
            )
        elif records[pointer]["close_event"] is not None:
            errors.append(
                f"STATE.attempt {pointer} is already closed (E-"
                f"{records[pointer]['close_event']}) but the pointer was not "
                "cleared -- torn attempt state"
            )
        elif state_fields.get("task") != records[pointer].get("ticket"):
            errors.append(
                f"STATE.attempt {pointer} belongs to "
                f"{records[pointer].get('ticket')} but STATE.task is "
                f"{state_fields.get('task')}"
            )

    # CORE-004 (audit ed1f86e8): the attempt pointer invariant is
    # BIDIRECTIONAL. The block above validates pointer -> open record; this
    # block enforces open record -> pointer: exactly one open attempt on the
    # Work requires STATE.attempt to equal that exact attempt, and zero open
    # attempts requires no active pointer. Without this, an open DEC with a
    # missing pointer is validator-green while the CLI is wedged (close fails
    # 'no active attempt', open fails 'still open').
    open_list = active_attempts(records)
    work_opens = [
        aid
        for aid in open_list
        if records[aid].get("ticket") == state_fields.get("task")
    ]
    if work_opens:
        if len(work_opens) > 1:
            errors.append(
                f"{len(work_opens)} open attempts exist for "
                f"{state_fields.get('task')} but STATE.attempt is a single "
                "pointer -- impossible, refuse"
            )
        elif pointer is None:
            errors.append(
                f"attempt {work_opens[0]} is open in the LOG but STATE carries "
                "no attempt pointer -- torn attempt state; close it or restore "
                "the pointer"
            )
        elif pointer != work_opens[0]:
            errors.append(
                f"STATE.attempt {pointer} does not match the open attempt "
                f"{work_opens[0]} on this Work -- attempt pointer ownership "
                "is inconsistent"
            )
    elif pointer is not None:
        # pointer already validated above against records; this branch covers
        # an open-less pointer that somehow has no record -- already reported.
        pass

    # Producer self-approval guard: an attempt closed as `candidate` may be
    # admitted only by verification evidence that comes AFTER the candidate
    # close. The closure-evidence check proves a VERIFY boundary + PASS exist
    # somewhere; THIS check pins their ORDER against the producing attempt.
    return errors


def admission_error(rec: dict, done_ticket_id: str, events) -> str | None:
    """Why a DONE ticket's producing candidate attempt lacks post-close
    independent verification, or None when admission is properly ordered."""
    if rec.get("result") != "candidate":
        return None
    close_eid = rec.get("close_event")
    if close_eid is None:
        return None
    from .log import _is_verify_boundary

    boundary_after = any(
        ev.get("ticket") == done_ticket_id
        and ev.get("taxonomy") == "RUN"
        and _is_verify_boundary(ev)
        and ev["event"] > close_eid
        for ev in events
    )
    if not boundary_after:
        return (
            f"ticket {done_ticket_id} is DONE but its producing attempt "
            f"{rec['id']} closed candidate at E-{close_eid} with no VERIFY "
            "boundary after that close -- a producer claim admitted without "
            "independent verification"
        )
    return None


def ticket_admission_error(
    ticket_id: str,
    records: dict,
    events,
) -> str | None:
    """Centralized ticket-level admission check (CORE-002 audit ed1f86e8).

    Resolves every candidate attempt for the Work from its ticket-coherent
    lineage, then requires a valid VERIFY boundary after each candidate close.
    The first candidate remains the producing episode; a later candidate is a
    new producer claim and cannot be appended after admission to stamp fresh
    producer authority onto already-DONE Work. A later non-candidate attempt
    (interrupted/failed) does not erase the original admission obligation.

    Both writer-side finish and full validation share this helper, so a DONE
    the CLI commits is exactly the DONE the validator certifies.
    """
    candidates = sorted(
        (
            rec
            for rec in records.values()
            if rec.get("ticket") == ticket_id
            and rec.get("result") == "candidate"
            and rec.get("close_event") is not None
        ),
        key=lambda rec: rec["open_event"],
    )
    if not candidates:
        return None
    from .log import _is_verify_boundary

    for candidate in candidates:
        close_eid = candidate["close_event"]
        boundary_after = any(
            ev.get("ticket") == ticket_id
            and ev.get("taxonomy") == "RUN"
            and _is_verify_boundary(ev)
            and ev["event"] > close_eid
            for ev in events
        )
        if not boundary_after:
            return (
                f"ticket {ticket_id} is DONE but its candidate attempt "
                f"{candidate['id']} closed at E-{close_eid} with no VERIFY "
                "boundary after that close -- a producer claim admitted "
                "without independent verification"
            )
    return None
