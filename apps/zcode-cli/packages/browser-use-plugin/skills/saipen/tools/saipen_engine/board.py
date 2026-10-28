"""BOARD ticket parsing -- the shared primitive."""

from __future__ import annotations

import datetime
import hashlib
import re

REQUIRED_HEADINGS = ["## DOING", "## TODO", "## DONE", "## BLOCKED"]
TICKET_RE = re.compile(r"^- \[([ x/])\] (T-\d+)\s+(.*)$")

# ONE canonical strict-UTC timestamp parser (hostile-regression, P1#5 / wave 3).
# The contract admits EXACTLY ``YYYY-MM-DDTHH:MM:SS[.fraction](Z|+00:00)``:
# a ``T`` separator (never a space), seconds mandatory, and a UTC suffix of
# ``Z`` or ``+00:00`` only. Forbidden spellings -- space separator, ``+0000``,
# ``+00``, or missing seconds -- are refused before any parse, so a 10:00+03:00
# (07:00Z) stamp can never enter chronological ordering (P1#3).
_STRICT_UTC_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$"
    r"|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$"
)
_UTC_ZERO = datetime.timedelta(0)


def _strict_utc_stamp(text: str) -> datetime.datetime | None:
    """Parse a canonical strict-UTC string into a UTC-aware datetime, or None."""
    if not _STRICT_UTC_RE.match(text):
        return None
    try:
        stamp = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None or stamp.utcoffset() != _UTC_ZERO:
        return None
    return stamp.astimezone(datetime.timezone.utc)


def strict_iso_utc(value: object) -> str:
    """Strict ISO-8601 UTC (Z or +00:00, ``utcoffset() == 0``) -> canonical Z.

    Returns the canonical ``YYYY-MM-DDTHH:MM:SS[.fff]Z`` form, or ``""`` for any
    non-string, noncanonical-spelling, naive, or non-zero-offset stamp."""
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text:
        return ""
    stamp = _strict_utc_stamp(text)
    if stamp is None:
        return ""
    return stamp.replace(tzinfo=None).isoformat() + "Z"


def iso_utc_sort_key(value: object) -> datetime.datetime | None:
    """The actual UTC instant of ``value``, or None when not strict-UTC.

    Use as the sort key for pending-op and terminal-receipt ordering so two
    admissible instants tie by the real clock (op_id is only the equal-instant
    tiebreak) and never by their spelling -- ``00Z`` and ``00.900000Z`` order
    correctly regardless of lexical form (P1#3)."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return _strict_utc_stamp(text)


# A second canonical ticket-record opener anywhere AFTER the first on the same
# physical line. ONE PHYSICAL BOARD RECORD == ONE TICKET IDENTITY (T-1003): a
# merged record silently deletes the second ticket's identity (T-473/T-576 and
# T-407/T-406 both shipped merged once). A description may legitimately hold
# `- [ ]` prose; a `- [ ] T-###`/`- [/] T-###`/`- [x] T-###` marker is NEVER
# prose -- it is a second identity and a parse error.
EMBEDDED_TICKET_RE = re.compile(r"\[[ x/]\]\s+T-\d+")
PIPE_SENTINEL = "\x00"
KNOWN_FIELDS = frozenset(
    {
        "needs",
        "owner",
        "claim_time",
        "blocker",
        "verify",
        "review_passes",
        "verify_attempts",
        "source_reports",
        "source_receipts",
        "recurrence",
        "weak_model",
        # CORE-001: does this ticket owe a regression PAIR, not merely a green
        # run? `regression: required` is the machine-owned declaration that the
        # VERIFY -> REVIEW and finish gates must additionally consume
        # `oracle.regression_pair_verdict`. It is a FIELD on purpose: inferring
        # "this is a bug fix" from the description would make the gate depend
        # on prose, which is the one thing this whole rule exists to stop.
        "regression",
        # ---- orchestration repair (T-1302 / CORE-003, SRC-026:R003) -------
        # These seven are declared by the Board schema and the DONE/SHIP phase
        # contracts while the parser still rejected them as unrecognized, so a
        # board written to the documented contract failed to PARSE. Docs and
        # schema must never advertise a value the runtime ignores -- here it
        # did worse than ignore it, it refused the whole record.
        #
        # blocker_scope         ticket | goal -- a ticket block parks one
        #                       ticket; only a goal block may stop the loop.
        # closure_mode          own_patch | inherited_verified | cohort --
        #                       the provenance of a DONE closure.
        # closure_cohort        C-### batch identity for cohort closure.
        # user_explicit         `true` marks Work created from an explicit
        #                       user request; it arms scheduler precedence.
        # implementation_delta  none | patch -- did BUILD produce code?
        # implementation_source the durable publication authority an
        #                       inherited_verified closure resolves against.
        # closure_paths         the shared worktree paths a cohort member
        #                       attributes to its batch.
        "blocker_scope",
        "closure_mode",
        "closure_cohort",
        "user_explicit",
        "implementation_delta",
        "implementation_source",
        "closure_paths",
        # Terminal local lifecycle supersession. These fields assert neither
        # retirement nor publication; they bind OLD -> NEW, the old-target
        # PASS event, and the operator authority that granted the pair.
        "superseded_by",
        "supersession_evidence",
        "supersession_authority",
        # Active-parent dependency handoff. These fields exist only while the
        # parent is BLOCKED on one child Work item; finish_ticket consumes
        # them atomically when that child reaches DONE.
        "blocked_on",
        "resume_phase",
        "resume_transition_from",
        "retry_not_before",
        # T-1326: a compact execution-index pointer to losslessly externalized
        # historical detail.  The resolver is canonical; the pointer itself
        # carries no authority beyond naming that artifact.
        "detail_ref",
        # T-1384: which HOST SESSION holds this claim, as a salted digest.
        # `owner` says who, and a name is not a process -- an arriving window
        # reads the same `owner` the incumbent wrote and inherits it, which
        # is how an unseated agent mutated product bytes while the ledger
        # stayed clean. This field is the half `owner` cannot carry: proof
        # that the CURRENT process is the one that claimed. It is a digest,
        # never the session id, so BOARD and every audit archive built from
        # it carry no reusable bearer value.
        "claim_session",
        # External implementation resolution (SRC-088 / T-1434 M2): the LOCAL
        # ticket was implemented by an EXTERNAL authority and verified locally.
        # external_authority     the portable lineage identity of the
        #                        implementing project;
        # external_implementation the upstream T-###@<commit> identity;
        # external_evidence      the append-only EX-###### receipt;
        # resolution_reason      the registered reason class.
        "external_authority",
        "external_implementation",
        "external_evidence",
        "resolution_reason",
    }
)


def claim_session_digest(project_lineage: str | None, session_id: str | None) -> str | None:
    """The non-secret binding written beside a claim, or None when unprovable.

    Salted with the project lineage so one window's digest cannot be replayed
    into another project, and truncated because this is an equality check
    between two values the verifier already holds, not a secret.

    Returns None for a missing session id ON PURPOSE: absence must stay
    absence all the way to the comparison. A digest of the empty string would
    be a value, and a value is something a later check can accidentally treat
    as proof.
    """
    if not session_id or not str(session_id).strip():
        return None
    material = f"{(project_lineage or '').strip()}\0{str(session_id).strip()}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


#: The host session identity the adapter exports just before it runs the tool
#: that carries this command (T-1384). Plain environment, exactly like the PATH
#: the same adapter prepends -- a WITNESS of which process is acting, never a
#: credential and never an actor.
HOST_SESSION_ENV = "SAIPEN_HOST_SESSION"


def host_session_binding(root) -> str | None:
    """This process's claim binding for ``root``, or None when unprovable."""
    import os

    from .paths import project_lineage_identity

    return claim_session_digest(project_lineage_identity(root), os.environ.get(HOST_SESSION_ENV))


def session_locked_out(ticket: dict, root, now=None) -> bool:
    """Does a LIVE claim on ``ticket`` belong to a session this process is not?

    The SEAT gate needs the same answer the mutation gate reaches, or the two
    doors disagree -- and measured live on 2026-09-17 they did. A second
    window was refused UNSEATED_MUTATION once, then ran `saipen start`,
    inherited `STATE.agent`, parked the foreign owner's Work as if it were its
    own, rebound the claim to itself, and every later mutation was legal.
    Nothing was stolen: the name was simply assumed, which is the same
    tautology one layer up.

    Liveness is asked WITHOUT an actor on purpose. With one, a matching name
    short-circuits to SELF before the clock is ever read, so a dead owner's
    binding would freeze the ticket forever instead of reaching takeover.
    """
    bound = str((ticket.get("fields") or {}).get("claim_session") or "").strip()
    if not bound or claim_status(ticket, None, now) != "FOREIGN_LIVE":
        return False
    return host_session_binding(root) != bound


#: Closed blocker-scope vocabulary. Absent reads as `ticket`: a block whose
#: scope was never declared parks exactly its own ticket, which is the safe
#: half -- the loop keeps working instead of stopping on an unstated claim.
BLOCKER_SCOPES = ("ticket", "goal")
DEFAULT_BLOCKER_SCOPE = "ticket"

#: Closed closure-mode vocabulary. Absent reads as `own_patch`: the ticket
#: owns and publishes its implementation delta, which is the strict half.
CLOSURE_MODES = (
    "own_patch",
    "inherited_verified",
    "cohort",
    "superseded_verified",
    "external_implementation",
)
DEFAULT_CLOSURE_MODE = "own_patch"

#: The ONLY value that arms explicit-user scheduling precedence. Anything else
#: is a declaration the parser keeps and the scheduler ignores, so a typo can
#: never silently promote ordinary Work to the front of the queue.
USER_EXPLICIT_TRUE = "true"

# New or updated live records must remain an execution index.  Historical
# rows are still parsed exactly as written; a canonical writer touching an
# oversized row refuses with an externalization route instead of deleting or
# truncating prose.
MAX_LIVE_RECORD_CHARS = 1200

#: The only value that turns the extra gate on. Anything else is a declaration
#: the parser keeps and the gate ignores, so a typo cannot silently arm or
#: disarm the strictest check in the phase chain -- `regression_required`
#: reports what it saw.
REGRESSION_REQUIRED = "required"


def regression_required(ticket: dict) -> bool:
    """True when this ticket declares that it owes a regression pair."""
    value = str(((ticket or {}).get("fields") or {}).get("regression") or "").strip().lower()
    return value == REGRESSION_REQUIRED


def parse_board(text: str) -> dict:
    """Walk the board into a ticket map.

    Returns {"tickets": {tid: {...}}, "headings": [...], "errors": [...]}.
    Mirrors the validator's walk exactly so the engine and validate.py cannot
    drift apart. A ticket line preserves its raw text for surgical mutation.

    Physical grammar is CLOSED (CORE-003 / SRC-026:R003 parser defense):
    inside a machine-owned section (``## DOING``/``## TODO``/``## DONE``/
    ``## BLOCKED``) the only legal physical records are the section heading,
    a canonical ticket record, and an empty line. Any other non-empty record
    -- an injected physical separator's detached continuation, a malformed
    scalar tail, an unexpected list item, detached metadata, a record
    fragment -- is a parse error naming the line, section and record. The
    bytes are already ambiguous or corrupt: fail closed, never silently skip,
    never glue the continuation back to the prior ticket (the separator no
    longer exists in the parsed field, so the record can never be
    truthfully reconstructed). Before the first ``##`` heading a documented
    preamble (title, HTML comments, legacy banner lines) is legal --
    arbitrary prose there is an unknown record too.
    """
    tickets = {}
    headings = []
    errors = []
    section = None
    for line_no, line in enumerate(text.splitlines(), 1):
        if line.startswith("## "):
            section = line.strip()
            headings.append(section)
            continue
        if not line.strip():
            continue
        if line.lstrip().startswith("- ["):
            m = TICKET_RE.match(line.strip().replace("\\|", PIPE_SENTINEL))
            if not m:
                errors.append(
                    f"BOARD.md:{line_no} ticket-ish line doesn't match "
                    f"RFC section 1.2 shape `- [ ] T-### description`"
                )
                continue
            checkbox, tid, rest = m.groups()
            if EMBEDDED_TICKET_RE.search(rest):
                errors.append(
                    f"BOARD.md:{line_no} ticket {tid} embeds a second "
                    f"ticket-record opener -- ONE PHYSICAL BOARD RECORD == "
                    f"ONE TICKET IDENTITY; split the records onto separate "
                    f"lines or the embedded ticket silently loses its "
                    f"identity"
                )
                continue
            if section not in REQUIRED_HEADINGS:
                errors.append(
                    f"BOARD.md:{line_no} ticket {tid} sits under "
                    f"{section or 'no heading'} -- not one of the four RFC "
                    f"sections, so no operation may mutate a board built "
                    f"around it"
                )
                continue
            parts = [unescape_ticket_part(p.strip()) for p in rest.split(" | ")]
            needs, fields = [], {}
            for part in parts[1:]:
                fm = re.match(r"^([a-z_]+):\s*(.*)$", part)
                if not fm or fm.group(1) not in KNOWN_FIELDS:
                    errors.append(
                        f"BOARD.md:{line_no} ticket {tid} has unrecognized field {part!r}"
                    )
                    continue
                if fm.group(1) in fields:
                    errors.append(
                        f"BOARD.md:{line_no} ticket {tid} duplicates the "
                        f"known field {fm.group(1)!r} -- a weak model must "
                        f"never read one value while Python uses another"
                    )
                    continue
                fields[fm.group(1)] = fm.group(2)
                if fm.group(1) == "needs":
                    needs = re.findall(r"T-\d+", fm.group(2))
            if tid in tickets:
                errors.append(f"BOARD.md:{line_no} duplicate ticket ID {tid}")
                continue
            tickets[tid] = {
                "id": tid,
                "section": section,
                "line_no": line_no,
                "checkbox": checkbox,
                "needs": needs,
                "fields": fields,
                "raw": line,
                "description": parts[0] if parts else "",
            }
            continue
        # Not a heading, not empty, not ticket-shaped: an unknown physical
        # record. Inside the four machine-owned sections this is a detached
        # continuation -- an injected record separator (NEL, U+2028/U+2029,
        # CR/LF, ...) is consumed by splitlines BEFORE the field is parsed,
        # so the tail surfaces HERE, not inside the parsed field. A detached
        # continuation silently ignored is a field whose bytes were lost while
        # validation accepted the record. Fail closed (CORE-003 / SRC-026:R003).
        # Before any section and under unknown headings we keep the historical
        # permissive skip: the grammar for those zones is documented separately
        # (sub boards, template documentation) and does not form the attack
        # surface for ticket identity injection.
        if section is None or section not in REQUIRED_HEADINGS:
            continue
        # section is one of the four required: an unexpected physical record
        # here is a detached continuation or fragment.
        errors.append(
            f"BOARD.md:{line_no} unexpected physical BOARD record "
            f"under {section} ({line.strip()[:80]!r}) -- a detached "
            f"continuation or record fragment never becomes "
            f"authority; the board grammar is closed and the bytes "
            f"are ambiguous or corrupt, refuse them"
        )
    for heading in REQUIRED_HEADINGS:
        if headings.count(heading) != 1:
            errors.append(
                f"BOARD.md required heading {heading} appears "
                f"{headings.count(heading)} time(s) -- the shared parser "
                f"refuses a board whose work surface is split or missing, so "
                f"no operation can mutate it into a crash"
            )
    return {"tickets": tickets, "headings": headings, "errors": errors}


def board_record_digest(raw: str) -> str:
    """Content-bound identity for ONE physical BOARD record.

    A line NUMBER is not an identity: every repair that inserts, removes or
    moves a row changes it, so an operator decision that named a line could be
    aimed by a later edit at a row nobody chose. What a decision must name is
    the record's bytes, so this is their digest. It hashes the STRIPPED record,
    byte for byte the same way `retirement.board_record_digest` does, so a
    digest written into recovery evidence means one thing everywhere.
    """
    return hashlib.sha256(str(raw).strip().encode("utf-8")).hexdigest()


def duplicate_records(text: str, ticket_id: str) -> list[dict]:
    """EVERY physical record claiming ``ticket_id``, in file order.

    `parse_board` keeps the FIRST record for an id and reports the rest as
    errors -- right for a reader, useless for a repair. Two records claim one
    identity, the history references the id and not the row, and the record the
    parser dropped is exactly the one that has no other name: an operator
    deciding which record keeps the identity could not even point at them.

    Each entry carries the content-bound digest, the section and the parsed
    description, so a decision is about RECORDS rather than lines. The walk
    mirrors `parse_board` (same `TICKET_RE`, same heading rules, same
    `PIPE_SENTINEL` unescape) so the two views of one board cannot drift.
    """
    wanted = str(ticket_id or "").strip()
    if not wanted:
        return []
    found: list[dict] = []
    section = None
    for line_no, line in enumerate(text.splitlines(), 1):
        if line.startswith("## "):
            section = line.strip()
            continue
        if not line.strip() or not line.lstrip().startswith("- ["):
            continue
        match = TICKET_RE.match(line.strip().replace("\\|", PIPE_SENTINEL))
        if not match:
            continue
        checkbox, tid, rest = match.groups()
        if tid != wanted:
            continue
        parts = [unescape_ticket_part(p.strip()) for p in rest.split(" | ")]
        entries: dict = {}
        for part in parts[1:]:
            fm = re.match(r"^([a-z_]+):\s*(.*)$", part)
            if fm and fm.group(1) in KNOWN_FIELDS:
                entries[fm.group(1)] = fm.group(2)
        found.append(
            {
                "id": tid,
                "digest": board_record_digest(line),
                "line_no": line_no,
                "section": section,
                "checkbox": checkbox,
                "description": parts[0] if parts else "",
                "fields": entries,
                "raw": line,
            }
        )
    return found


# Reserved structural BOARD fields (T-1316 handoff): a field marker for one of
# these embedded inside ANOTHER field's value is a pseudo-link -- prose trying
# to borrow the authority of a structured field. Real incident: a ticket written
# with `verify: ... ; source_receipts: SRC-027` parsed `fields.verify` as prose
# carrying a receipt name while `fields.source_receipts` stayed absent, so the
# source-closure gate saw ZERO linked receipts and answered
# SOURCE_COVERAGE_COMPLETE for work that had an unresolved actionable
# requirement. Normalizing on read would be a hidden auto-healer; the machine
# refuses instead, and only an explicitly authorized writer may normalize.
RESERVED_FIELD_MARKERS = ("source_receipts", "owner", "claim_time", "needs")
#: Matches `field:` or `; field:` or `, field:` inside a value -- the shapes a
#: pseudo-link takes when prose imitates the pipe-field grammar. A value that
#: legitimately NEEDS the literal text `owner:` (rare) must escape or reword it;
#: ambiguity resolves toward refusal, not toward guessing which half is data.
_PSEUDO_FIELD_MARKER_RE = re.compile(r"(?:^|[;,])\s*(%s)\s*:" % "|".join(RESERVED_FIELD_MARKERS))


def board_scalar_errors(fields: dict, ticket_id: str) -> list[str]:
    """ONE shared parse-side BOARD scalar scan (CORE-003 / SRC-026:R003).

    A parsed field value that still carries a physical record separator can
    only exist if the bytes were written out-of-band (a hand edit, a corrupt
    tool, or a pre-repair writer): the canonical writers refuse separators,
    so the only safe reading is to refuse the record too. This is the parse
    side of the same invariant `assert_single_record` writes -- one
    predicate, both directions, no drift.
    """
    errors = []
    for name, value in (fields or {}).items():
        sep = record_separator_in(value)
        if sep is not None:
            errors.append(
                f"{ticket_id} field {name!r} carries a physical record "
                f"separator -- the canonical writers refuse separators, so "
                f"these bytes are out-of-band authority"
            )
        # T-1316: a reserved field marker inside another field's value is a
        # pseudo-link, not prose. The parser read `fields.verify` while the
        # machine authority `fields.source_receipts` stayed empty, and the
        # closure gate then claimed coverage that did not exist.
        for marker in _PSEUDO_FIELD_MARKER_RE.finditer(str(value or "")):
            errors.append(
                f"{ticket_id} field {name!r} embeds reserved field marker "
                f"{marker.group(1)!r} -- a structured field marker inside "
                "another field's value is a pseudo-link, not authority; "
                "write `| source_receipts:` as its own field through the "
                "canonical source-capture authority"
            )
    return errors


def detached_ticket_id_errors(tickets: dict, allocated_max_ticket_id: object) -> list[str]:
    """Allocation-frontier check retained as the cheap first tell.

    Any BOARD record above the history's max allocated id is detached
    outright. (Below-frontier detached records need the stronger
    per-ticket-event backing the fast gate and validate.py check; this
    frontier pass is the shared vocabulary for both.)
    """
    try:
        frontier = int(allocated_max_ticket_id)
    except (TypeError, ValueError):
        return []
    errors = []
    for tid in tickets:
        m = re.fullmatch(r"T-(\d+)", str(tid))
        if not m:
            continue
        if int(m.group(1)) > frontier:
            errors.append(
                f"{tid} sits above the allocation frontier ({frontier}) -- "
                f"ticket identity comes from canonical allocation "
                f"(next_ticket_id + a journaled [T-###] event), never from "
                f"a record that merely looks like a ticket"
            )
    return errors


def detached_ticket_id_known_ids(events: object) -> set[str]:
    """Structured ticket identities named by complete-history events.

    The allocation-event half of the identity check: ``parse_log_line``
    structured ``[T-###]`` slots are ticket identity, prose mentions are
    not. Events may be a HistorySnapshot (with ``.events``), a plain
    iterable of parsed events, or None.
    """
    if events is None:
        return set()
    if hasattr(events, "events"):
        events = events.events
    try:
        iterator = list(events)
    except TypeError:
        return set()
    known = set()
    for ev in iterator:
        tid = (ev or {}).get("ticket") if isinstance(ev, dict) else None
        if tid and re.fullmatch(r"T-\d+", str(tid)):
            known.add(str(tid))
    return known


def board_semantic_errors(ticket: dict) -> list[str]:
    """Mechanically-decidable BOARD lifecycle invariants, ONE shared home.

    fast_check (transactional verifier: does this proposed board survive
    the release gate?) and validate.py (canonical validator) must reject the
    SAME checkbox/section/evidence mismatches -- an unrelated mutation may
    otherwise COMMIT an already-invalid board that the full release gate
    rejects, and the two gates would disagree (T-1003).

    Rules (RFC § 1.2): the section IS the status; the checkbox is how a
    human skims it.
      - [x] belongs only under ## DONE
      - [/] belongs only under ## DOING
      - open [ ] belongs only under ## TODO / ## BLOCKED
      - ## DONE requires non-empty | verify: evidence (a completion claim
        with no evidence attached is indistinguishable from one never tested)
      - ## BLOCKED requires a non-empty | blocker:
      - | blocker: outside ## BLOCKED is stale advisory data
    """
    errors = []
    section = ticket.get("section")
    checkbox = ticket.get("checkbox")
    fields = ticket.get("fields", {})
    tid = ticket.get("id", "?")
    if checkbox == "x" and section != "## DONE":
        errors.append(
            f"{tid} is checked [x] but sits under {section} -- "
            "checkbox and section disagree; [x] belongs only "
            "under ## DONE"
        )
    if checkbox == "/" and section != "## DOING":
        errors.append(
            f"{tid} is [/] in-progress but sits under {section} -- "
            "in-progress work belongs only under ## DOING"
        )
    if checkbox in (" ", "") and section in ("## DONE", "## DOING"):
        errors.append(
            f"{tid} has an open [ ] checkbox under {section} -- "
            "open boxes belong under ## TODO or ## BLOCKED"
        )
    if section == "## DONE" and not str(fields.get("verify", "")).strip():
        errors.append(
            f"{tid} sits under ## DONE with no | verify: evidence "
            "-- ## DONE is a claim that the ticket's own verify "
            "condition was met"
        )
    status_error = ticket_status_error(ticket)
    if status_error:
        errors.append(f"{tid} {status_error}")
    # Parse-side half of the record invariant (CORE-003 / SRC-026:R003): a
    # writer-prevented separator that reached the bytes anyway is
    # out-of-band authority, and a parsed record built on it must be refused
    # rather than projected into routing decisions.
    scalars = dict(ticket.get("fields", {}))
    if isinstance(ticket.get("description"), str):
        scalars["description"] = ticket["description"]
    errors.extend(board_scalar_errors(scalars, tid))
    errors.extend(closure_metadata_errors(ticket))
    return errors


def closure_metadata_errors(ticket: dict) -> list[str]:
    """Orchestration-metadata placement + vocabulary (T-1302 / CORE-003).

    The schema already said where these fields may live and which values they
    admit; nothing enforced it, so a board could carry `closure_mode: cohort`
    on a TODO ticket, or `blocker_scope: gaol`, and validate clean while the
    runtime read a default that contradicted the line a human was reading.
    A declaration the machine ignores is worse than no declaration.
    """
    errors: list[str] = []
    fields = ticket.get("fields", {})
    section = ticket.get("section")
    tid = ticket.get("id", "?")

    scope = str(fields.get("blocker_scope", "")).strip()
    if scope:
        if section != "## BLOCKED":
            errors.append(
                f"{tid} carries | blocker_scope: outside ## BLOCKED ({section}) "
                "-- scope describes an ACTIVE block and is stale anywhere else"
            )
        elif scope.lower() not in BLOCKER_SCOPES:
            errors.append(
                f"{tid} declares blocker_scope {scope!r}, outside "
                f"{'|'.join(BLOCKER_SCOPES)} -- an unreadable scope would be "
                "silently downgraded to ticket while the line claims otherwise"
            )

    rnb = str(fields.get("retry_not_before", "")).strip()
    if rnb:
        if section != "## BLOCKED":
            errors.append(
                f"{tid} carries | retry_not_before: outside ## BLOCKED ({section}) "
                "-- a deferred due instant is ACTIVE blocked-state data"
            )
        elif iso_utc_sort_key(rnb) is None:
            errors.append(
                f"{tid} retry_not_before {rnb!r} is not strict UTC "
                "(YYYY-MM-DDTHH:MM:SS[.fff]Z); malformed or naive local "
                "timestamps fail closed -- they never fall back to host time"
            )
        elif deferred_operator_class(str(fields.get("blocker", ""))) is None:
            # T-1429: the invariant is "a machine operator due instant may
            # exist ONLY on an operator-eligible BLOCKED ticket", not "any
            # BLOCKED ticket may carry the field". The projection already
            # fails closed; without this the board keeps claiming a human
            # deadline that nothing will ever report.
            errors.append(
                f"{tid} carries | retry_not_before: with blocker "
                f"{str(fields.get('blocker', '')).strip().split(' -- ', 1)[0]!r}, "
                "which is not an operator-owned deferred class "
                f"({'|'.join(sorted(_DEFERRED_OPERATOR_BLOCKER_CLASSES))}) "
                "-- a due instant nobody can action is dead metadata"
            )

    closure_fields = (
        "closure_mode",
        "closure_cohort",
        "implementation_delta",
        "implementation_source",
        "closure_paths",
        "superseded_by",
        "supersession_evidence",
        "supersession_authority",
        "external_authority",
        "external_implementation",
        "external_evidence",
        "resolution_reason",
    )
    declared = [name for name in closure_fields if str(fields.get(name, "")).strip()]
    if declared and section != "## DONE":
        errors.append(
            f"{tid} carries closure metadata ({', '.join(declared)}) under "
            f"{section} -- closure provenance describes a COMPLETED ticket"
        )

    mode = str(fields.get("closure_mode", "")).strip()
    if mode and mode.lower() not in CLOSURE_MODES:
        errors.append(
            f"{tid} declares closure_mode {mode!r}, outside "
            f"{'|'.join(CLOSURE_MODES)}"
        )
    delta = str(fields.get("implementation_delta", "")).strip()
    if delta and delta.lower() not in ("none", "patch"):
        errors.append(f"{tid} declares implementation_delta {delta!r}, outside none|patch")
    cohort = str(fields.get("closure_cohort", "")).strip()
    if cohort and not re.fullmatch(r"C-\d+", cohort):
        errors.append(f"{tid} declares closure_cohort {cohort!r}, which is not a C-### identity")
    if mode.lower() == "cohort" and not cohort:
        errors.append(f"{tid} closes as cohort with no | closure_cohort: C-### authority")
    if cohort and mode.lower() != "cohort":
        errors.append(
            f"{tid} names closure_cohort {cohort} but closes as "
            f"{mode or DEFAULT_CLOSURE_MODE} -- cohort membership is only "
            "valid with closure_mode cohort"
        )
    implementation_source_value = str(fields.get("implementation_source", "")).strip()
    if mode.lower() == "inherited_verified" and not implementation_source_value:
        errors.append(f"{tid} closes inherited_verified with no | implementation_source:")
    if implementation_source_value and mode.lower() != "inherited_verified":
        errors.append(
            f"{tid} names implementation_source outside closure_mode inherited_verified"
        )

    supersession = {
        "superseded_by": str(fields.get("superseded_by", "")).strip(),
        "supersession_evidence": str(fields.get("supersession_evidence", "")).strip(),
        "supersession_authority": str(fields.get("supersession_authority", "")).strip(),
    }
    present_supersession = [name for name, value in supersession.items() if value]
    if mode.lower() == "superseded_verified":
        missing = [name for name, value in supersession.items() if not value]
        if missing:
            errors.append(
                f"{tid} closes superseded_verified with missing " + ", ".join(missing)
            )
        if supersession["superseded_by"] and not re.fullmatch(
            r"T-\d+", supersession["superseded_by"]
        ):
            errors.append(f"{tid} superseded_by is not a T-### identity")
        if supersession["superseded_by"] == tid:
            errors.append(f"{tid} cannot supersede itself")
        if supersession["supersession_evidence"] and not re.fullmatch(
            r"E-\d+", supersession["supersession_evidence"]
        ):
            errors.append(f"{tid} supersession_evidence is not an E-### identity")
        if supersession["supersession_authority"] and not re.fullmatch(
            r"SRC-\d+", supersession["supersession_authority"]
        ):
            errors.append(f"{tid} supersession_authority is not an SRC-### identity")
        if delta.lower() != "none":
            errors.append(
                f"{tid} closes superseded_verified without implementation_delta none"
            )
    elif present_supersession:
        errors.append(
            f"{tid} carries {', '.join(present_supersession)} outside "
            "closure_mode superseded_verified"
        )

    # external_implementation (SRC-088 / T-1434 M2): the LOCAL_IMPLEMENTATION
    # vs EXTERNAL_IMPLEMENTATION_LOCAL_VERIFICATION distinction. The mode is
    # written only by `saipen ticket resolve-external`; its four provenance
    # fields are a closed grammar over a portable lineage authority, a
    # structured <T-###>@<commit> implementation identity, an append-only
    # EX-###### receipt and a registered reason. A partial or mixed record is
    # a declaration the machine would silently ignore, so it refuses here.
    external = {
        "external_authority": str(fields.get("external_authority", "")).strip(),
        "external_implementation": str(fields.get("external_implementation", "")).strip(),
        "external_evidence": str(fields.get("external_evidence", "")).strip(),
        "resolution_reason": str(fields.get("resolution_reason", "")).strip(),
    }
    present_external = [name for name, value in external.items() if value]
    if mode.lower() == "external_implementation":
        missing = [name for name, value in external.items() if not value]
        if missing:
            errors.append(
                f"{tid} closes external_implementation with missing " + ", ".join(missing)
            )
        if external["external_authority"] and not re.fullmatch(
            r"lineage-[0-9a-f]{32}", external["external_authority"]
        ):
            errors.append(
                f"{tid} external_authority is not a lineage-<32 hex> identity"
            )
        if external["external_implementation"] and not re.fullmatch(
            r"T-\d+@[0-9a-f]{7,40}", external["external_implementation"]
        ):
            errors.append(
                f"{tid} external_implementation is not a T-###@<commit> identity"
            )
        if external["external_evidence"] and not re.fullmatch(
            r"EX-\d{6}", external["external_evidence"]
        ):
            errors.append(f"{tid} external_evidence is not an EX-###### identity")
        if external["resolution_reason"] and external["resolution_reason"] not in (
            "PROTOCOL_HOME_FIX_VERIFIED",
            "DEPENDENCY_UPGRADE_VERIFIED",
            "UPSTREAM_FIX_VERIFIED",
        ):
            errors.append(
                f"{tid} resolution_reason {external['resolution_reason']!r} is "
                "outside the registered reason set"
            )
        if delta.lower() != "none":
            errors.append(
                f"{tid} closes external_implementation without implementation_delta none"
            )
    elif present_external:
        errors.append(
            f"{tid} carries {', '.join(present_external)} outside "
            "closure_mode external_implementation"
        )
    explicit = str(fields.get("user_explicit", "")).strip()
    if explicit and explicit.lower() != USER_EXPLICIT_TRUE:
        errors.append(
            f"{tid} declares user_explicit {explicit!r}; only 'true' arms "
            "explicit-user scheduling, so any other value is a declaration "
            "the scheduler ignores"
        )

    reservation_fields = ("blocked_on", "resume_phase", "resume_transition_from")
    reservation = {name: str(fields.get(name, "")).strip() for name in reservation_fields}
    present = [name for name, value in reservation.items() if value]
    if present and section != "## BLOCKED":
        errors.append(
            f"{tid} carries continuation reservation ({', '.join(present)}) under "
            f"{section} -- only a BLOCKED parent may reserve continuation"
        )
    if present and len(present) != len(reservation_fields):
        missing = [name for name, value in reservation.items() if not value]
        errors.append(
            f"{tid} carries a partial continuation reservation; missing "
            + ", ".join(missing)
        )
    if reservation["blocked_on"] and not re.fullmatch(r"T-\d+", reservation["blocked_on"]):
        errors.append(f"{tid} blocked_on {reservation['blocked_on']!r} is not T-###")
    if reservation["resume_phase"]:
        from . import phases

        if reservation["resume_phase"] not in phases.TICKET_BEARING_PHASES:
            errors.append(
                f"{tid} resume_phase {reservation['resume_phase']!r} is not ticket-bearing"
            )
        elif not phases.transition_legal(
            reservation["resume_transition_from"], reservation["resume_phase"]
        ):
            errors.append(
                f"{tid} continuation snapshot has illegal transition "
                f"{reservation['resume_transition_from']} -> {reservation['resume_phase']}"
            )
    return errors


def ticket_has_blocker(ticket: dict) -> bool:
    """Whether a blocker field exists, including a malformed empty one."""
    return "blocker" in ticket.get("fields", {})


def board_graph_errors(tickets: dict) -> list[str]:
    """Dangling `needs:` references and `needs:` cycles -- ONE shared primitive
    (hostile-regression, 4th-wave P1#4) used by fast_check, validate.py and the
    router before Pick Rule evaluation. A cyclic all-TODO graph is corrupt work
    state, never merely 'no workable ticket' (which would otherwise route to
    maintenance / `saipen continue`).

    Self-edges (`T-1 needs T-1`) and two-node cycles are both caught.

    Cycle detection is EXPLICIT-STACK iterative three-color DFS (second-wave
    P1): recursive DFS over a valid acyclic chain deeper than Python's
    recursion limit would raise RecursionError, taking fast validation, routing
    and full validation down instead of returning a deterministic result. The
    explicit stack preserves the exact insertion-order traversal and the
    cycle-path diagnostic (`cyclic needs: T-a -> T-b -> T-a`) of the old
    recursion.
    """
    errors: list[str] = []
    ids = set(tickets.keys())
    superseded: dict[str, str] = {}
    for tid, ticket in tickets.items():
        successor = str((ticket.get("fields") or {}).get("superseded_by") or "").strip()
        if not successor:
            continue
        superseded[tid] = successor
        if successor not in ids:
            errors.append(f"supersession {tid} names nonexistent successor {successor}")
        elif tickets[successor].get("section") != "## DONE":
            errors.append(f"supersession {tid} names non-DONE successor {successor}")

    for start in superseded:
        chain: list[str] = []
        positions: dict[str, int] = {}
        current = start
        while current in superseded:
            if current in positions:
                cycle = [*chain[positions[current] :], current]
                errors.append("cyclic supersession: " + " -> ".join(cycle))
                break
            positions[current] = len(chain)
            chain.append(current)
            current = superseded[current]
    for tid, ticket in tickets.items():
        for need in ticket.get("needs", []):
            if need not in ids:
                errors.append(f"{tid} needs nonexistent {need} (line {ticket.get('line_no')})")
    reserved_children: dict[str, str] = {}
    for tid, ticket in tickets.items():
        blocked_on = str(ticket.get("fields", {}).get("blocked_on", "")).strip()
        if not blocked_on:
            continue
        if blocked_on not in ids:
            errors.append(f"{tid} blocked_on nonexistent {blocked_on}")
            continue
        if blocked_on not in ticket.get("needs", []):
            errors.append(f"{tid} blocked_on {blocked_on} is missing from its needs graph")
        prior = reserved_children.get(blocked_on)
        if prior is not None and prior != tid:
            errors.append(
                f"{blocked_on} has multiple continuation parents: {prior}, {tid}"
            )
        reserved_children[blocked_on] = tid
    # Cycle detection over the needs: dependency DAG (iterative three-color).
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {tid: WHITE for tid in tickets}
    seen_cycles: set[tuple[str, ...]] = set()

    for start in tickets:
        if color[start] != WHITE:
            continue
        # Explicit DFS stack of [node, next-need-index] frames -- mirrors the
        # recursion exactly (push on WHITE descent, pop on node completion)
        # without consuming the Python call stack.
        stack: list[str] = [start]
        color[start] = GRAY
        frames: list[list] = [[start, 0]]
        while frames:
            node, idx = frames[-1]
            needs = tickets[node].get("needs", [])
            descended = False
            while idx < len(needs):
                need = needs[idx]
                frames[-1][1] = idx + 1
                if need not in tickets:
                    idx += 1
                    continue
                if color.get(need) == GRAY:
                    cycle_start = stack.index(need)
                    cycle = tuple([*stack[cycle_start:], need])
                    if cycle not in seen_cycles:
                        seen_cycles.add(cycle)
                        errors.append("cyclic needs: " + " -> ".join(cycle))
                elif color.get(need) == WHITE:
                    color[need] = GRAY
                    stack.append(need)
                    frames.append([need, 0])
                    descended = True
                    break
                idx += 1
            if descended:
                continue
            stack.pop()
            color[node] = BLACK
            frames.pop()
    return errors


def ticket_status_error(ticket: dict) -> str | None:
    """Enforce blocker presence iff ticket status is BLOCKED."""
    fields = ticket.get("fields", {})
    blocked = ticket.get("section") == "## BLOCKED"
    if blocked and not str(fields.get("blocker", "")).strip():
        return "sits under ## BLOCKED without a non-empty | blocker: field"
    if not blocked and "blocker" in fields:
        return f"carries | blocker: outside ## BLOCKED ({ticket.get('section')})"
    return None


CLAIM_LIVENESS_WINDOW = datetime.timedelta(minutes=15)

# The ONE claim-ownership classifier (hostile-regression, P0): every consumer
# (validator, fast gate, router, workability, claim) decides claim truth through
# this, never a divergent half-check. CORE's both-or-neither rule is enforced
# here: a half pair (owner xor claim_time) or an unparsable/non-UTC stamp is
# INVALID, which fails closed and can never be picked.
CLAIM_STATUS = ("UNCLAIMED", "SELF", "FOREIGN_LIVE", "FOREIGN_STALE", "INVALID")


def claim_status(
    ticket: dict, agent: str | None = None, now: datetime.datetime | None = None
) -> str:
    """Classify a ticket's § 1.4 claim relative to ``agent`` at ``now``.

    Returns one of UNCLAIMED | SELF | FOREIGN_LIVE | FOREIGN_STALE | INVALID.
      - UNCLAIMED: no owner and no claim_time.
      - SELF:       owner == agent (this agent owns it).
      - FOREIGN_LIVE:   another agent owns it and the claim is still within the
                        15-minute liveness window.
      - FOREIGN_STALE:  another agent owns it but the claim has lapsed.
      - INVALID:    half pair (owner xor claim_time), or an unparsable /
                    non-UTC (utcoffset != 0) claim_time -- CORE's both-or-neither
                    rule, fail closed.
    """
    fields = ticket.get("fields", {})
    owner = (fields.get("owner") or "").strip()
    claim_time = (fields.get("claim_time") or "").strip()
    has_owner = bool(owner)
    has_time = bool(claim_time)
    if has_owner != has_time:
        return "INVALID"
    if not has_owner:
        return "UNCLAIMED"
    if now is None:
        now = datetime.datetime.now(datetime.timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=datetime.timezone.utc)
    stamp = iso_utc_sort_key(claim_time)
    if stamp is None:
        return "INVALID"
    if agent and owner == agent:
        return "SELF"
    expired = (now - stamp).total_seconds() >= CLAIM_LIVENESS_WINDOW.total_seconds()
    return "FOREIGN_STALE" if expired else "FOREIGN_LIVE"


def _claim_is_live(
    owner: str, claim_time: str, agent: str | None, now: datetime.datetime | None
) -> bool:
    """Backward-compatible live-foreign-claim probe (delegates to claim_status).

    True only for a present, well-formed, foreign-owned claim still inside the
    § 1.4 liveness window. A half pair or bad stamp is INVALID and therefore
    never "live" -- fail closed, never picked (P0 both-or-neither rule).
    """
    owner = (owner or "").strip()
    claim_time = (claim_time or "").strip()
    if not owner or not claim_time:
        return False
    if agent and owner == agent:
        return False
    return (
        claim_status({"fields": {"owner": owner, "claim_time": claim_time}}, agent, now)
        == "FOREIGN_LIVE"
    )


def ticket_is_workable(
    ticket: dict, tickets: dict, agent: str | None = None, now: datetime.datetime | None = None
) -> bool:
    """Defense-in-depth Pick Rule for possibly malformed BOARD input.

    Workable means: open ## TODO, no blocker (even malformed), every needs:
    DONE, and not under another agent's live § 1.4 claim. A half pair or
    non-UTC claim_time is INVALID and fails closed -- it can never be picked
    (CORE's both-or-neither rule, P0).
    """
    ticket.get("fields", {})
    # A syntactically VALID claim (owner + claim_time) on a non-DOING ticket is
    # INACTIVE history -- CORE's claim truth lives in DOING, so a stale pair
    # left by a block/unblock cycle must not make a TODO non-workable
    # (hostile-regression, P1#5). A half/bad (INVALID) pair still fails closed,
    # and a live foreign claim on an ACTIVE DOING ticket still blocks.
    _cs = claim_status(ticket, agent, now)
    _claim_blocks = _cs == "INVALID" or (
        ticket.get("section") == "## DOING" and _cs == "FOREIGN_LIVE"
    )
    return (
        ticket.get("section") == "## TODO"
        and ticket.get("checkbox") in (" ", "")
        and not ticket_has_blocker(ticket)
        and not _claim_blocks
        and all(
            need in tickets and tickets[need].get("section") == "## DONE"
            for need in ticket.get("needs", [])
        )
    )


# The closed blocker-class vocabulary. A ## BLOCKED ticket is closure-exempt
# ONLY when its blocker field opens with one of these EXACT class tokens
# (prose is never a class). HELD/FUTURE_GATE/PERMANENT_WARNING_OWNER/
# WAIT_USER_CONFIRMATION are exempt by design; ACTIVE is a recognized class
# that genuinely blocks closure. Any other blocker text fails closed and
# blocks closure (T-1003 sweep: prose never decides control flow).
_NON_CLOSURE_BLOCKER_TOKENS = frozenset(
    {
        "HELD",
        "FUTURE_GATE",
        "PERMANENT_WARNING_OWNER",
        "WAIT_USER_CONFIRMATION",
        "WAIT_USER_DECISION",
        "ACTIVE",
        "WAIT_ROLE",
        "BLOCKED_EXTERNAL",
    }
)
_CLOSURE_EXEMPT_BLOCKER_CLASSES = frozenset(
    {
        "HELD",
        "FUTURE_GATE",
        "PERMANENT_WARNING_OWNER",
        "WAIT_USER_CONFIRMATION",
        "WAIT_USER_DECISION",
    }
)
# T-1429: the deferred-operator vocabulary is NARROWER than the general
# blocker vocabulary, and conflating them was the defect. A due instant
# claims "a HUMAN must act at this moment"; only a blocker class whose
# owner IS the operator may make that claim. HELD/FUTURE_GATE/ACTIVE are
# protocol holds, PERMANENT_WARNING_OWNER can never be actioned at all, and
# WAIT_ROLE:<role> is crew-owned Work -- none of them are a person with a
# clock. BLOCKED_EXTERNAL earns its place on evidence: T-1426's documented
# live acceptance gate is exactly that class and is explicitly operator-owned.
# Expanding this set requires live repository evidence of an explicit
# operator-owned contract for the added class, recorded with the change.
_DEFERRED_OPERATOR_BLOCKER_CLASSES = frozenset(
    {
        "WAIT_USER_CONFIRMATION",
        "WAIT_USER_DECISION",
        "BLOCKED_EXTERNAL",
    }
)


def _field(ticket: dict, name: str) -> str:
    """One canonical accessor: the trimmed field value, or "" when absent."""
    return str(((ticket or {}).get("fields") or {}).get(name) or "").strip()


def is_user_explicit(ticket: dict) -> bool:
    """True when this Work came from an EXPLICIT user request (T-1302).

    The scheduler precedence this arms is the FastPrompter regression: a fresh
    user request must not sit behind speculative Work that was merely filed
    earlier. Only the exact token `true` arms it -- prose never decides
    control flow, and a typo must not silently reorder the queue.
    """
    return _field(ticket, "user_explicit").lower() == USER_EXPLICIT_TRUE


def blocker_scope(ticket: dict) -> str:
    """The declared blocker scope, defaulting to `ticket`.

    An undeclared or unrecognized scope reads as `ticket` ON PURPOSE: the
    dangerous direction is a ticket-level obstacle silently stopping the whole
    loop, which is exactly what the FastPrompter incident did. An unreadable
    declaration therefore parks one ticket and keeps working.
    """
    value = _field(ticket, "blocker_scope").lower()
    return value if value in BLOCKER_SCOPES else DEFAULT_BLOCKER_SCOPE


def closure_mode(ticket: dict) -> str:
    """The declared closure provenance, defaulting to `own_patch`.

    Defaults the strict way round: an unreadable declaration means the ticket
    owes an attributable implementation delta, never that publication may be
    inherited from something nobody named.
    """
    value = _field(ticket, "closure_mode").lower()
    return value if value in CLOSURE_MODES else DEFAULT_CLOSURE_MODE


def closure_cohort(ticket: dict) -> str | None:
    """The C-### cohort this DONE ticket published through, or None."""
    value = _field(ticket, "closure_cohort")
    return value if re.fullmatch(r"C-\d+", value) else None


def implementation_source(ticket: dict) -> str | None:
    """The durable publication authority named by this closure, or None."""
    return _field(ticket, "implementation_source") or None


def superseded_by(ticket: dict) -> str | None:
    """The explicit successor of terminal superseded Work, or None."""
    value = _field(ticket, "superseded_by")
    return value if re.fullmatch(r"T-\d+", value) else None


def external_authority(ticket: dict) -> str | None:
    """The portable lineage identity that implemented the fix, or None."""
    value = _field(ticket, "external_authority")
    return value if re.fullmatch(r"lineage-[0-9a-f]{32}", value) else None


def external_implementation(ticket: dict) -> str | None:
    """The upstream ``T-###@<commit>`` implementation identity, or None."""
    value = _field(ticket, "external_implementation")
    return value if re.fullmatch(r"T-\d+@[0-9a-f]{7,40}", value) else None


def external_evidence(ticket: dict) -> str | None:
    """The append-only EX-###### resolution receipt id, or None."""
    value = _field(ticket, "external_evidence")
    return value if re.fullmatch(r"EX-\d{6}", value) else None


def resolution_reason(ticket: dict) -> str | None:
    """The registered external-resolution reason, or None."""
    from .external import RESOLUTION_REASONS

    value = _field(ticket, "resolution_reason")
    return value if value in RESOLUTION_REASONS else None


def closure_paths(ticket: dict) -> list[str]:
    """The shared worktree paths a cohort member attributes to its batch."""
    raw = _field(ticket, "closure_paths")
    return [part.strip() for part in raw.replace(",", " ").split() if part.strip()]


def retry_not_before(ticket: dict) -> str | None:
    """The canonical machine-readable deferred due instant, or None.

    T-1429: one field only (``retry_not_before``), strict-UTC
    ``YYYY-MM-DDTHH:MM:SS[.fff]Z``. Malformed, naive, or non-UTC prose
    fails closed to None -- prose never drives timing.
    """
    value = _field(ticket, "retry_not_before")
    if not value:
        return None
    return value if iso_utc_sort_key(value) is not None else None


def deferred_state(ticket: dict, now=None) -> str | None:
    """DEFERRED_OPERATOR | DUE_OPERATOR_ACTION | None for one ticket.

    None when no valid machine due-time exists. A timestamp alone never
    creates a gate: only a ## BLOCKED ticket whose blocker is an
    OPERATOR-OWNED deferred class (`deferred_operator_class`) plus a valid
    due instant projects. Before due -> DEFERRED_OPERATOR; at/after -> DUE.

    A due instant sitting on a HELD, FUTURE_GATE, ACTIVE,
    PERMANENT_WARNING_OWNER or WAIT_ROLE ticket -- however it got there,
    including out-of-band historical bytes -- fails closed to None here.
    """
    if ticket.get("section") != "## BLOCKED":
        return None
    due = retry_not_before(ticket)
    if due is None:
        return None
    blocker = str(((ticket or {}).get("fields") or {}).get("blocker") or "")
    if deferred_operator_class(blocker) is None:
        return None
    stamp = iso_utc_sort_key(due)
    if stamp is None:
        return None
    if now is None:
        import datetime as _dt

        now = _dt.datetime.now(_dt.timezone.utc)
    elif now.tzinfo is None:
        import datetime as _dt

        now = now.replace(tzinfo=_dt.timezone.utc)
    return "DUE_OPERATOR_ACTION" if now >= stamp else "DEFERRED_OPERATOR"


def operator_gates(tickets: dict, now=None) -> list[dict]:
    """Every ## BLOCKED ticket projecting a machine due-time gate.

    T-1429: one entry per ticket with a valid ``retry_not_before`` AND an
    operator-eligible blocker class (`deferred_operator_class`) --
    ``{"ticket", "retry_not_before", "state"}``
    where state is DEFERRED_OPERATOR (before the instant) or
    DUE_OPERATOR_ACTION (at or after it). Prose timestamps are invisible
    here: ``deferred_state`` returns None without the structured field.
    """
    gates: list[dict] = []
    for ticket in tickets.values():
        if ticket.get("section") != "## BLOCKED":
            continue
        state = deferred_state(ticket, now)
        if state is None:
            continue
        gates.append(
            {
                "ticket": ticket["id"],
                "retry_not_before": retry_not_before(ticket),
                "state": state,
            }
        )
    return gates


def goal_blocked_tickets(tickets: dict) -> list[str]:
    """Every ## BLOCKED ticket whose blocker explicitly claims GOAL scope."""
    return [
        ticket["id"]
        for ticket in tickets.values()
        if ticket.get("section") == "## BLOCKED" and blocker_scope(ticket) == "goal"
    ]


def workable_tickets(tickets: dict, agent: str | None = None, now=None) -> list[str]:
    """Every workable ticket in BOARD order -- the Pick Rule's candidate set."""
    return [
        ticket["id"]
        for ticket in tickets.values()
        if ticket_is_workable(ticket, tickets, agent=agent, now=now)
    ]


def pick_next_work(tickets: dict, agent: str | None = None, now=None) -> tuple[str | None, str]:
    """THE one BOARD-level Pick Rule (T-1302 / CORE-003, SRC-026:R003).

    Returns ``(ticket_id, reason)``; ``(None, "none")`` when no BOARD Work is
    workable. Router, ticket/source projection, persisted `next_action`
    recomputation and the validator all call THIS -- the validator used to
    keep its own `min(line_no)` fallback, which is how a persisted pick and a
    freshly routed pick could name different tickets from the same board.

    Precedence inside the BOARD stage (the outer stages -- recovery/WAIT,
    active continuation, audit-inbox authority -- are the router's and sit
    above this call):

      1. workable `user_explicit` Work, topmost first;
      2. ordinary workable Work, topmost first.

    Explicit user intent outranking speculative backlog IS the FastPrompter
    fix: the incident lost a live user request behind work filed earlier.
    """
    reserved = reserved_continuation_child(tickets, agent=agent, now=now)
    if reserved is not None:
        return reserved["id"], "dependency-continuation"
    workable = workable_tickets(tickets, agent=agent, now=now)
    for tid in workable:
        if is_user_explicit(tickets[tid]):
            return tid, "start-user-explicit"
    if workable:
        return workable[0], "start"
    return None, "none"


def reserved_continuation_child(
    tickets: dict, agent: str | None = None, now=None
) -> dict | None:
    """Return the one workable child reserved by a BLOCKED parent.

    The BOARD validator rejects duplicate child reservations.  A reservation
    outranks ordinary queue order and cannot be bypassed with an explicit
    claim: it is the durable continuation edge that prevents unrelated Work
    from taking the temporarily free single-DOING seat.
    """
    children = []
    for parent in tickets.values():
        if parent.get("section") != "## BLOCKED":
            continue
        child_id = str(parent.get("fields", {}).get("blocked_on", "")).strip()
        child = tickets.get(child_id)
        if (
            child is not None
            and child_id in parent.get("needs", [])
            and ticket_is_workable(child, tickets, agent=agent, now=now)
        ):
            children.append(child)
    return children[0] if len(children) == 1 else None


def continuation_parent(tickets: dict, child_id: str, *, require_done: bool = True) -> dict | None:
    """Return the one BLOCKED parent reserved on ``child_id``.

    The structural validator rejects duplicate reservations; this helper stays
    pure and returns no parent when the child has not reached the required
    terminal state.
    """
    child = tickets.get(child_id)
    if child is None or (require_done and child.get("section") != "## DONE"):
        return None
    found = [
        ticket
        for ticket in tickets.values()
        if ticket.get("section") == "## BLOCKED"
        and str(ticket.get("fields", {}).get("blocked_on", "")).strip() == child_id
        and child_id in ticket.get("needs", [])
    ]
    return found[0] if len(found) == 1 else None


def resumable_parent(tickets: dict) -> dict | None:
    """Return the unique continuation parent whose child is DONE."""
    parents = [
        ticket
        for ticket in tickets.values()
        if ticket.get("section") == "## BLOCKED"
        and continuation_parent(
            tickets,
            str(ticket.get("fields", {}).get("blocked_on", "")).strip(),
        )
        is ticket
    ]
    return parents[0] if len(parents) == 1 else None


def blocker_class(blocker: str) -> str | None:
    """The exact class token a blocker field opens with, or None when it does
    not open with one of the closed tokens. Exact-match only -- a substring
    mention inside free prose is not a class. `WAIT_ROLE:<role>` is the
    structured crew-owned blocker: the CREW planner routes to that built-in
    role; it is NOT globally closure-exempt -- ordinary Core treats it as a
    genuine blocker."""
    head = blocker.strip().split(" -- ", 1)[0].strip().upper()
    if head in _NON_CLOSURE_BLOCKER_TOKENS:
        return head
    wait_role = re.match(
        r"^WAIT_ROLE:([A-Za-z0-9_-]+)$", blocker.strip().split(" -- ", 1)[0].strip()
    )
    return "WAIT_ROLE" if wait_role else None


def deferred_operator_class(blocker: str) -> str | None:
    """The operator-owned deferred class a blocker opens with, or None.

    T-1429's single policy owner for "may this blocker carry a machine
    operator due instant". It is deliberately NOT `blocker_class` filtered
    at the call site: `blocker_class` answers "is this a recognized
    blocker", which is a different and broader question, and every consumer
    that re-derived the narrower answer locally drifted. Router, status,
    the public writer, the board validator and the schema all ask HERE.

    Recognized but ineligible (no human owns the clock): HELD, FUTURE_GATE,
    ACTIVE, PERMANENT_WARNING_OWNER, WAIT_ROLE:<role>, and every unrecognized
    blocker such as ACTIVE_DEPENDENCY:<T-###>.
    """
    head = blocker.strip().split(" -- ", 1)[0].strip().upper()
    return head if head in _DEFERRED_OPERATOR_BLOCKER_CLASSES else None


def wait_role_target(blocker: str) -> str | None:
    """The role name a WAIT_ROLE:<role> blocker names, or None."""
    m = re.match(r"^WAIT_ROLE:([A-Za-z0-9_-]+)", blocker.strip().split(" -- ", 1)[0].strip())
    return m.group(1) if m else None


def convergence_closure_problems(
    board: dict, agent: str | None = None, wait_role_roles: frozenset = frozenset()
) -> list[str]:
    """Canonical mechanically-decidable Core work-closure predicate.

    Closure means no active work, no currently workable TODO, and no blocker
    that claims to prevent present closure. A ## BLOCKED ticket is exempt
    ONLY when its blocker field opens with an exact closed-class token from
    the exempt set; the description is inert and arbitrary prose inside the
    blocker details is inert. Explicit held/future/historical blockers remain
    on BOARD without turning fixed point into "empty BOARD".

    WAIT_ROLE:<role> is NEVER exempt by itself (ordinary Core: blocked remains
    blocked). Only the CREW planner may pass `wait_role_roles` = the built-in
    crew registry; a WAIT_ROLE ticket whose role is in that set is work FOR
    the crew, so it does not block the crew's Core-convergence stage -- the
    planner routes to that role instead (T-1003 hostile finding 10).
    """
    errors = list(board.get("errors", []))
    tickets = board.get("tickets", {})
    doing = [ticket["id"] for ticket in tickets.values() if ticket.get("section") == "## DOING"]
    if doing:
        errors.append("active DOING: " + ", ".join(doing[:3]))
    workable = [
        ticket["id"]
        for ticket in tickets.values()
        if ticket_is_workable(ticket, tickets, agent=agent)
    ]
    if workable:
        errors.append("workable TODO: " + ", ".join(workable[:3]))
    blocking = []
    for ticket in tickets.values():
        if ticket.get("section") != "## BLOCKED":
            continue
        blocker = ticket.get("fields", {}).get("blocker", "")
        cls = blocker_class(blocker)
        if cls is not None and cls in _CLOSURE_EXEMPT_BLOCKER_CLASSES:
            continue
        if cls == "WAIT_ROLE" and wait_role_roles:
            role = wait_role_target(blocker)
            if role in wait_role_roles:
                continue
        blocking.append(ticket["id"])
    if blocking:
        errors.append("closure-blocking ticket(s): " + ", ".join(blocking[:3]))
    return errors


#: Every character Python's ``str.splitlines()`` treats as a line boundary.
#: ONE PHYSICAL BOARD RECORD == ONE TICKET IDENTITY, so a scalar that carries
#: any of these can render as two records: the tail becomes an authoritative
#: ticket line that no allocator ever issued (CORE-003 / SRC-026:R003, T-999
#: injection through ``\n``, ``\r`` and ``U+2028``). The tuple is the
#: canonical predicate -- not ``len(value.splitlines()) > 1``, which a
#: TRAILING separator fools (``"x\\n".splitlines()`` has length 1 while the
#: value still terminates a physical record).
RECORD_SEPARATORS: tuple[str, ...] = (
    "\n",  # LF
    "\r",  # CR
    "\x0b",  # VT
    "\x0c",  # FF
    "\x1c",  # FS
    "\x1d",  # GS
    "\x1e",  # RS
    "\x85",  # NEL
    "\u2028",  # LINE SEPARATOR
    "\u2029",  # PARAGRAPH SEPARATOR
)

#: Human-readable names for the separator set, in the same order -- a refusal
#: has to NAME the character it refused, not point at an index.
RECORD_SEPARATOR_NAMES: tuple[str, ...] = (
    "LF (\\n)",
    "CR (\\r)",
    "VT (\\x0b)",
    "FF (\\x0c)",
    "FS (\\x1c)",
    "GS (\\x1d)",
    "RS (\\x1e)",
    "NEL (\\x85)",
    "U+2028",
    "U+2029",
)


def record_separator_in(value: object) -> str | None:
    """The FIRST physical record separator inside ``value``, or None.

    The canonical predicate every writer-side check consumes, so the BOARD
    record boundary is enforced in ONE place instead of nine ad-hoc
    ``"\\n" in x`` tests that each cover a different subset. Non-str values
    are rejected as separators on the safe side: a scalar that is not text
    has no business reaching a BOARD field at all.
    """
    if not isinstance(value, str):
        return None
    for sep in RECORD_SEPARATORS:
        if sep in value:
            return sep
    return None


def assert_single_record(value: object, field: str) -> str:
    """Validate ONE BOARD-projected scalar: return it, or raise ValueError.

    The record boundary owns the invariant (CORE-003 / SRC-026:R003). Every
    writer that projects a scalar onto BOARD calls this first, so an
    injection cannot choose its way past the gate by picking a writer whose
    ad-hoc check only knew about ``\\n`` and ``\\r``. Legal backslash and
    pipe escaping is untouched -- that is `escape_ticket_description`'s job
    and it runs after this, never instead of it.
    """
    if not isinstance(value, str):
        raise ValueError(f"BOARD field {field!r} must be a string, got {type(value).__name__}")
    sep = record_separator_in(value)
    if sep is not None:
        name = RECORD_SEPARATOR_NAMES[RECORD_SEPARATORS.index(sep)]
        raise ValueError(
            f"BOARD field {field!r} carries a physical record separator "
            f"({name}); one BOARD scalar must render as exactly one ticket "
            f"record -- a separator can inject a ticket identity no allocator "
            f"ever issued"
        )
    return value


def assert_live_record(record: str) -> str:
    """Admit one newly created/updated BOARD record, or refuse losslessly."""
    assert_single_record(record, "ticket_record")
    if len(record) > MAX_LIVE_RECORD_CHARS:
        raise ValueError(
            f"BOARD_RECORD_OVERSIZE: new/updated live ticket record is "
            f"{len(record)} characters, cap is {MAX_LIVE_RECORD_CHARS}; "
            "retain the full specification in its source receipt/evidence/detail "
            "artifact and keep only a compact verify/blocker reference on BOARD"
        )
    return record


def escape_ticket_description(description: str) -> str:
    """Reversibly escape payload text so it renders as ONE ticket field.

    Backslash first, pipe second: a literal backslash becomes `\\\\` and a
    literal pipe becomes `\\|`, so a value that itself contains `\\|` cannot
    lose its backslash on the parse round-trip.

    The record boundary is checked FIRST (CORE-003 / SRC-026:R003): escaping
    only neutralises the pipe and the backslash, so a value carrying a
    separator would survive this call intact and split the ticket line into
    two physical records -- the second an authoritative ticket nobody
    allocated. Refusing here is the ONE place every writer shares.
    """
    assert_single_record(description, "description")
    return description.replace("\\", "\\\\").replace("|", "\\|")


def unescape_ticket_part(part: str) -> str:
    """Reverse escape_ticket_description for one pipe-delimited part."""
    return part.replace("\\\\", "\\").replace(PIPE_SENTINEL, "|")


def _fields_split(raw: str) -> list[str]:
    """Split a ticket line into checkbox/prefix and pipe-delimited fields,
    honouring `\\|` escapes."""
    return raw.replace("\\|", PIPE_SENTINEL).split(" | ")


def _fields_join(parts: list[str]) -> str:
    return " | ".join(parts).replace(PIPE_SENTINEL, "\\|")


def _reject_duplicate_fields(raw: str) -> None:
    """Refuse to MUTATE a ticket line that repeats a field name.

    A board with `| owner: a | owner: b` is already a parse error; a mutator
    must never rewrite only the first occurrence and leave the second -- the
    effective value would silently disagree with the mutation (T-1003).
    """
    seen: set[str] = set()
    for part in _fields_split(raw):
        if part.startswith("- "):
            continue
        fm = re.match(r"^([a-z_]+):\s*", part)
        if not fm:
            continue
        if fm.group(1) in seen:
            raise ValueError(
                f"ticket line repeats field {fm.group(1)!r}; parse the board "
                "before mutating -- refusing to edit a malformed record"
            )
        seen.add(fm.group(1))


def set_ticket_field(raw: str, field: str, value: str, *, enforce_cap: bool = True) -> str:
    """Replace or append `field: value` on a ticket line, preserving every
    other field byte-for-byte.

    ``enforce_cap=False`` skips ONLY the size ceiling, never the record-boundary
    check: a caller that will losslessly externalize an oversized PROPOSED
    record through `board_compaction` in the same journaled plan passes it, so
    the mutation can be built before its compact projection is computed. Every
    other writer keeps the default and still refuses an oversized record.
    """
    # The record boundary owns the invariant (CORE-003 / SRC-026:R003). This
    # is the ONE generic BOARD field mutator, so every field written through
    # it -- owner, claim_time, blocker, verify, closure metadata -- is
    # single-record-safe by construction: a separator in `value` would turn
    # one physical ticket record into two, the tail an authoritative ticket
    # line no allocator issued.
    assert_single_record(value, field)
    _reject_duplicate_fields(raw)
    parts = _fields_split(raw)
    out = []
    replaced = False
    pattern = re.compile(rf"^{re.escape(field)}:\s*")
    for part in parts:
        if part.startswith("- ") or pattern.match(part):
            if pattern.match(part):
                if not replaced:
                    out.append(f"{field}: {value}")
                    replaced = True
                    continue
            out.append(part)
            continue
        out.append(part)
    if not replaced:
        out.append(f"{field}: {value}")
    joined = _fields_join(out)
    if enforce_cap:
        return assert_live_record(joined)
    return assert_single_record(joined, "ticket_record")


def remove_ticket_field(raw: str, field: str) -> str:
    """Remove exactly `| field: <value>` structurally. The leftover value
    cannot survive as free text."""
    _reject_duplicate_fields(raw)
    parts = _fields_split(raw)
    pattern = re.compile(rf"^{re.escape(field)}:\s*")
    kept = [part for part in parts if not pattern.match(part)]
    return _fields_join(kept)
