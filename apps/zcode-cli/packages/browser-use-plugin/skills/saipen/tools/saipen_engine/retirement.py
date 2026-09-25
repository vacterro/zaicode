"""Canonical retirement of misrouted/invalid Work -- the ONE owner.

WHY THIS EXISTS
---------------
A field fixture ran with its working directory inside a sandbox worktree while
`PWD` still named THIS repository. The host trusted `PWD`, so a weak model's
`saipen start` minted real Source receipts and real BOARD Work **in the wrong
project**. The polygon is fixed (`PWD` is bound to the fixture and the stale
project carriers are stripped), but the ledger keeps what the incident wrote,
and the protocol had no truthful disposition for it:

* `ticket done` is a LIE -- the request was never implemented here;
* `source close` is a LIE -- it demands terminal coverage, so reaching it
  requires fabricating clauses or dispositions;
* leaving it TODO is a DEADLOCK -- a reserved continuation child holds the
  single DOING seat and `CONTINUATION_RESERVED` refuses every other claim,
  including the claim of the work that would repair it.

Retirement is the missing third verdict:

    THIS WORK NEVER BELONGED TO THIS PROJECT'S EXECUTION HISTORY.

It is NOT completion and it is NOT closure. Nothing is marked DONE, no
coverage is invented, no disposition is upgraded, and the original request
bytes are never rewritten or purged: they move from the ACTIVE intake surface
into a forensic cold-storage bundle that any later reader can still answer
"what was T-1369, who retired it, which Source created it, and what proved it
invalid?" from.

WHY IT IS NOT A DELETE ESCAPE HATCH
-----------------------------------
Every gate below is a refusal, not a warning, and all of them are evaluated
before a single byte is planned:

* the reason code comes from a CLOSED set (`RETIREMENT_REASONS`);
* the operator authority is a GRANT, not a mention. The authority receipt's
  own stored bytes must carry an operator-authority capsule (see
  `authority_grants`) that grants exactly this ticket with exactly the
  receipts it carries. "DO NOT retire T-1369 / SRC-048" names both identities
  and grants nothing;
* the evidence resolves: a canonical LOG event that precedes the retirement,
  or an owned artifact under `.saipen/evidence/` whose digest is bound into
  every record. "trust me this was wrong" resolves to nothing;
* the receipt's stored body must still hash to its recorded digest, and the
  receipt and the ticket must be linked in both directions;
* completed Work (`## DONE`) can never be rewritten as misrouted;
* a parent parked on the retired child is RESTORED to its own reserved seat,
  never transferred to whoever ran the retirement.

The whole transaction -- LOG, BOARD, STATE, the intake index, the tombstone
and the forensic archive -- is ONE journaled operation, so a crash converges
to the complete old set or the complete new set, and a repeat is
`ALREADY_RETIRED` rather than a second retirement.

WHY THE FORENSIC RECORDS VALIDATE THEMSELVES
--------------------------------------------
The retired bundle is evidence. If it could drift silently, retirement would
only have moved the lie somewhere quieter. Every artifact is therefore checked
structurally (`ticket_record_errors`, `retirement_tombstone_errors`,
`meta_retirement_errors`), against its siblings (`retired_link_errors`: the
ticket record, the tombstone and the archived metadata must tell one story),
against the namespace (`retired_namespace_errors`: no stray, linked or
dangling artifact), and against the append-only LOG (`retirement_history_errors`:
the events a record cites must exist and say what the record says).
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

from . import intake
from .journal import hash_bytes
from .plan import TargetPlan

#: Retirement schema version for every artifact this module writes.
#:
#:   2  the evidence contract: `evidence` is a resolved binding (a canonical
#:      event, or an owned artifact plus its sha256), the authority is bound by
#:      digest and exact grant line, and the parent restoration names the seat
#:      it went back to.
RETIREMENT_SCHEMA_VERSION = 2

#: Schema 1 was written only by the first T-1370 BUILD slice, before the
#: evidence contract existed: its `evidence` is free text and its authority was
#: proven by identifier presence. A schema-1 record is NEVER valid project
#: state -- the validator reports it -- and the only thing that can be done
#: with one is to RE-AFFIRM it under the current contract through
#: `saipen ticket retire` (`operations._bind_legacy_retirement`), which keeps
#: every historical field verbatim and records the binding as a NEW event.
LEGACY_SCHEMA_VERSION = 1

#: The CLOSED set of reasons Work may be retired for. A reason outside it is
#: `RETIREMENT_REASON_UNKNOWN` and zero bytes are written. Growing this set is
#: an authored protocol decision, never an inference from a free-text string:
#: an open-ended reason field would turn retirement into "delete any ticket".
#:
#:   MISROUTED_PROJECT_BINDING
#:       The Work was minted into THIS project only because the ingress
#:       resolved the wrong project root (a stale `PWD`/carrier out-stating
#:       the real working directory). The request may be perfectly valid --
#:       somewhere else.
#:
#:   TEST_FIXTURE_CONTAMINATION
#:       The Work and its Source receipt were minted into THIS project by
#:       SAIPEN's OWN test fixtures: a test run invoked `saipen start` with a
#:       fixture payload and this project's canonical ledger was written
#:       (request provenance `model_supplied`, no operator carrier). The
#:       request was never the operator's; it must never be implemented,
#:       completed, or closed with coverage.
RETIREMENT_REASONS = ("MISROUTED_PROJECT_BINDING", "TEST_FIXTURE_CONTAMINATION")

#: Forensic cold storage. Deliberately NOT `.saipen/archive/source/`: that
#: namespace means "closed with proven terminal coverage" and every reader of
#: it (`_closed_archive_bundle`) enforces exactly that. Retired bundles carry
#: unresolved coverage on purpose -- the truth is that nothing was ever
#: implemented -- so they get their own namespace instead of weakening the
#: meaning of the closed one.
RETIRED_DIR = ".saipen/archive/retired"

#: The owned evidence namespace an artifact reference must resolve inside.
EVIDENCE_DIR = ".saipen/evidence"

#: BOARD sections a ticket can be retired FROM. `## DONE` is absent on
#: purpose: finished Work carries closure evidence and cannot be rewritten as
#: misrouted (`TICKET_ALREADY_DONE`).
RETIRABLE_SECTIONS = ("## TODO", "## DOING", "## BLOCKED")

#: Source kinds that can carry operator authority. Imported specifications and
#: external audits are text somebody ELSE wrote; a capsule inside one is a
#: quotation of authority, not the operator's own grant.
AUTHORITY_SOURCE_KINDS = (
    "user_instruction",
    "user_audit",
    "implementation_mission",
    "review_handoff",
    "corrective_followup",
)

# ---------------------------------------------------------------------------
# The operator-authority capsule
# ---------------------------------------------------------------------------

#: The capsule grammar is the operator's OWN first grant, lifted verbatim from
#: the decision that authorized the first retirement (SRC-049), so that
#: decision stays representable exactly as it was written and no operator
#: intent has to be re-stated or invented to satisfy a newer format:
#:
#:     This message supplies operator authority for:
#:
#:         T-1368 / SRC-047
#:         T-1369 / SRC-048
#:
#:     only.
#:
#: A header line, one item line per Work naming EXACTLY the receipts that Work
#: carries (or the bare ticket id for Work with none), and a closing line.
#: Blank lines may separate them; anything else inside the capsule makes it
#: malformed and it grants nothing. A capsule inside a fenced code block is a
#: quotation and grants nothing. This grammar is consumed by retirement ONLY;
#: another destructive operation that needs operator authority must define its
#: own capsule instead of reusing this one.
GRANT_HEADER = "This message supplies operator authority for:"
GRANT_TERMINATOR = "only."

_TICKET_RE = re.compile(r"\AT-\d+\Z")
_RECEIPT_RE = re.compile(r"\ASRC-\d+\Z")
_EVENT_RE = re.compile(r"\AE-(\d+)\Z")
_SHA256_RE = re.compile(r"\A[0-9a-f]{64}\Z")
_STAMP_RE = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\Z")
_GRANT_ITEM_RE = re.compile(
    r"\A[ \t]*(T-\d+)(?:[ \t]*/[ \t]*(SRC-\d+(?:[ \t]*,[ \t]*SRC-\d+)*))?[ \t]*\Z"
)
_FENCE_RE = re.compile(r"\A[ \t]{0,3}(```|~~~)")
_RETIRED_NAME_RE = re.compile(
    r"\A(?:(T-\d+)\.json|(SRC-\d+)\.(?:md|meta\.json|contract\.json|coverage\.json|r\d+\.json))\Z"
)

_REF_MAX = 240
_NOTE_MAX = 240
_RECORD_MAX_BYTES = 256 * 1024
_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True)
class GrantParse:
    """Every grant a body makes, plus why any capsule in it granted nothing."""

    grants: dict
    lines: dict
    problems: tuple


def authority_grants(text: str) -> GrantParse:
    """Parse the operator-authority capsules in one Source body.

    Returns `grants` (ticket -> sorted receipt tuple), `lines` (ticket -> the
    exact grant item line, stripped) and `problems` (malformed or conflicting
    capsules). This is a closed line grammar, not language understanding: a
    sentence that merely MENTIONS a ticket -- including one that forbids its
    retirement -- is not a capsule and grants nothing.
    """
    lines = text.splitlines()
    grants: dict[str, tuple[str, ...]] = {}
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
        items: list[tuple[str, tuple[str, ...], str]] = []
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
            item = _GRANT_ITEM_RE.match(candidate)
            if not item:
                malformed = f"line {j + 1} is neither a grant item nor the terminator"
                break
            receipts = tuple(
                sorted({part.strip() for part in (item.group(2) or "").split(",") if part.strip()})
            )
            items.append((item.group(1), receipts, candidate.strip()))
            j += 1
        if malformed is None and not closed:
            malformed = "it is never closed"
        if malformed is None and not items:
            malformed = "it grants no Work"
        if malformed is not None:
            problems.append(
                f"operator-authority capsule at line {header_line} is malformed "
                f"({malformed}) and grants nothing"
            )
            # Resume AT the offending line: it may itself open a fence or a
            # new capsule, and skipping it would hide that.
            i = j + 1 if closed else max(j, i + 1)
            continue
        for ticket, receipts, raw in items:
            if ticket in grants and grants[ticket] != receipts:
                conflicted.add(ticket)
            grants.setdefault(ticket, receipts)
            grant_lines.setdefault(ticket, raw)
        i = j + 1
    for ticket in sorted(conflicted):
        problems.append(f"{ticket} is granted with conflicting receipt sets and so is not granted")
        grants.pop(ticket, None)
        grant_lines.pop(ticket, None)
    return GrantParse(grants, grant_lines, tuple(problems))


def grammar_hint() -> str:
    return (
        f"a capsule is a line `{GRANT_HEADER}`, one `T-### / SRC-###[, SRC-###]` "
        f"line per Work naming exactly its receipts, then a line `{GRANT_TERMINATOR}`"
    )


def capsule_problem(text: str) -> str | None:
    """Why these exact bytes are not a usable operator-authority capsule.

    Syntax gate for `saipen authority capture` (T-1414): the SAME parser
    retirement uses decides what grants. A body whose capsule is malformed,
    conflicting, fenced (a quotation), never closed or absent stores nothing;
    semantic checks against the live BOARD stay retirement's job.
    """
    if not isinstance(text, str):
        return "operator-authority capsule bytes must be UTF-8 text"
    parsed = authority_grants(text)
    if parsed.problems:
        return "; ".join(parsed.problems) + " -- " + grammar_hint()
    if parsed.grants:
        return None
    if GRANT_HEADER in text:
        return (
            "the operator-authority capsule is fenced, unclosed or quoted as a "
            "whole, so it grants nothing -- " + grammar_hint()
        )
    return "the body carries no operator-authority capsule -- " + grammar_hint()


def authority_error(
    root: Path,
    authority_receipt: str,
    *,
    ticket_id: str,
    receipts: list[str] | tuple[str, ...],
) -> tuple[str | None, dict | None]:
    """(why this authority does NOT cover the retirement, binding) -- one is None.

    The binding pins the decision that was relied on: its receipt id, its
    source digest and the exact grant line.
    """
    if not intake._valid_receipt_id(authority_receipt):
        return f"authority {authority_receipt!r} is not a receipt id", None
    meta = intake._read_meta(root, authority_receipt)
    if not meta:
        return f"authority receipt {authority_receipt} has no active metadata", None
    if meta.get("status") != intake.ACTIVE_STATUS:
        return (
            f"authority receipt {authority_receipt} is {meta.get('status')!r}; "
            "retirement authority must be an ACTIVE operator decision"
        ), None
    if authority_receipt in receipts:
        return (
            f"{authority_receipt} cannot authorize its own retirement -- "
            "authority must come from a separate operator decision"
        ), None
    if meta.get("linked_work") == ticket_id:
        return (
            f"authority receipt {authority_receipt} is linked to {ticket_id} itself; "
            "the Work being retired cannot carry its own authority"
        ), None
    if meta.get("source_kind") not in AUTHORITY_SOURCE_KINDS:
        return (
            f"authority receipt {authority_receipt} is a {meta.get('source_kind')!r} "
            "source; operator authority comes only from the operator's own ingress "
            f"({', '.join(AUTHORITY_SOURCE_KINDS)})"
        ), None
    integrity = intake.verify_integrity(root, authority_receipt)
    if not integrity["ok"]:
        return f"authority receipt {authority_receipt}: {integrity['code']}", None
    body = intake.read_body(root, authority_receipt)
    if not body.get("ok"):
        return f"authority receipt {authority_receipt} body unreadable", None
    parsed = authority_grants(str(body.get("body") or ""))
    granted = parsed.grants.get(ticket_id)
    if granted is None:
        detail = (
            f"authority receipt {authority_receipt} grants no retirement authority "
            f"for {ticket_id}: naming Work is not authorizing it"
        )
        if parsed.problems:
            detail += " (" + "; ".join(parsed.problems[:3]) + ")"
        return detail + " -- " + grammar_hint(), None
    expected = tuple(sorted(set(receipts)))
    if granted != expected:
        return (
            f"authority receipt {authority_receipt} grants {ticket_id} with receipts "
            f"{','.join(granted) or 'none'} but the ticket carries "
            f"{','.join(expected) or 'none'}; a grant must name exactly the linkage "
            "it retires"
        ), None
    return None, {
        "authority_receipt": authority_receipt,
        "authority_sha256": meta.get("source_sha256"),
        "authority_grant": parsed.lines[ticket_id],
    }


# ---------------------------------------------------------------------------
# Evidence and discovery
# ---------------------------------------------------------------------------


def _event_number(value: object) -> int | None:
    if not isinstance(value, str):
        return None
    match = _EVENT_RE.fullmatch(value)
    return int(match.group(1)) if match else None


def artifact_digest(raw: bytes) -> str:
    """The sha256 an evidence artifact is bound by, line-ending normalized.

    `.saipen/evidence/` is ordinary git text (`text=auto`): a checkout rewrites
    LF as CRLF or back according to the host's policy, so the raw bytes of the
    same committed artifact differ between a Windows and a Linux clone. A raw
    digest would report every such clone as tampered evidence. CRLF is folded
    to LF before hashing, so only a change to the artifact's CONTENT moves it.
    """
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


def _evidence_rel_error(rel: object) -> str | None:
    if not isinstance(rel, str) or not rel:
        return "artifact reference is empty"
    if "\\" in rel or rel.startswith("/") or re.match(r"\A[A-Za-z]:", rel):
        return f"artifact reference {rel!r} is not a project-relative forward-slash path"
    if not rel.startswith(EVIDENCE_DIR + "/"):
        return f"artifact reference {rel!r} is outside {EVIDENCE_DIR}/"
    if any(part in ("", ".", "..") for part in rel.split("/")):
        return f"artifact reference {rel!r} carries an empty, '.' or '..' segment"
    return None


def resolve_evidence(
    root: Path,
    ref: object,
    events: dict,
    *,
    before_event: int,
) -> tuple[dict | None, str | None]:
    """Resolve `--evidence` to a binding, or say why it is not evidence.

    Two forms exist and nothing else does:

    * `E-###` -- a canonical LOG event strictly before `before_event`. The
      append-only ledger binds its content;
    * `.saipen/evidence/<path>` -- an owned regular artifact. Its sha256 is
      bound into every retirement record, so the artifact can never be
      rewritten afterwards without the validator saying so.

    A free-text claim resolves to neither and is refused.
    """
    if not isinstance(ref, str) or not ref.strip():
        return None, (
            "retirement requires --evidence: a canonical event E-### or an owned "
            f"artifact under {EVIDENCE_DIR}/"
        )
    text = ref.strip()
    if len(text) > _REF_MAX:
        return None, f"retirement evidence reference exceeds {_REF_MAX} characters"
    number = _event_number(text)
    if number is not None:
        if number not in events:
            return None, f"evidence event {text} is not in the canonical LOG history"
        if number >= before_event:
            return None, f"evidence event {text} does not precede the retirement"
        return {"kind": "event", "ref": text}, None
    rel = text.replace("\\", "/")
    problem = _evidence_rel_error(rel)
    if problem:
        return None, (
            f"evidence {text!r} is neither a canonical event E-### nor an owned artifact "
            f"under {EVIDENCE_DIR}/ ({problem}) -- a free-text claim is not evidence"
        )
    try:
        raw = intake._read_owned_file(
            root, rel, kind="retirement evidence artifact", max_bytes=_EVIDENCE_MAX_BYTES
        )
    except FileNotFoundError:
        return None, f"evidence artifact {rel} does not exist"
    except (OSError, ValueError) as exc:
        return None, f"evidence artifact {rel} is unsafe or unreadable: {exc}"
    return {"kind": "artifact", "ref": rel, "sha256": artifact_digest(raw)}, None


def discovery_error(discovery_event: object, events: dict, *, before_event: int) -> str | None:
    """`discovery_event` is OPTIONAL.

    null means no canonical event ever recorded the discovery and the bound
    evidence alone carries the proof. When present it is a real LOG event that
    precedes the retirement -- never a label for something that did not
    happen in canonical history.
    """
    if discovery_event is None:
        return None
    number = _event_number(discovery_event)
    if number is None:
        return f"discovery event {discovery_event!r} is not an event id E-###"
    if number not in events:
        return f"discovery event {discovery_event} is not in the canonical LOG history"
    if number >= before_event:
        return f"discovery event {discovery_event} does not precede the retirement"
    return None


def note_error(note: object) -> str | None:
    if note is None:
        return None
    if not isinstance(note, str) or not note.strip():
        return "--note, when given, must say something"
    if "\n" in note or "\r" in note:
        return "--note must be a single line"
    if len(note.strip()) > _NOTE_MAX:
        return f"--note exceeds {_NOTE_MAX} characters"
    return None


def evidence_token(binding: dict) -> str:
    """How an evidence binding is written into the permanent LOG line."""
    if binding.get("kind") == "artifact":
        return f"evidence {binding.get('ref')} sha256:{binding.get('sha256')}"
    return f"evidence {binding.get('ref')}"


def retirement_head(ticket_id: str, reason: str, authority: str) -> str:
    return f"RETIRE {ticket_id} [{reason}] authority {authority} -- "


def retirement_message(
    *,
    ticket_id: str,
    reason: str,
    authority: str,
    receipts: list[str],
    evidence: dict,
    discovery_event: str | None,
    restored_parent: str | None,
    restored_parent_owner: str | None,
    note: str | None,
) -> str:
    parts = [
        retirement_head(ticket_id, reason, authority) + f"receipts {','.join(receipts) or 'none'}",
        evidence_token(evidence),
    ]
    if discovery_event:
        parts.append(f"discovered {discovery_event}")
    if restored_parent:
        parts.append(f"restores {restored_parent} to seat {restored_parent_owner or 'unowned'}")
    if note:
        parts.append(f"note: {note}")
    return " -- ".join(parts)


def binding_head(ticket_id: str, retirement_event: str) -> str:
    return f"RETIREMENT EVIDENCE BOUND {ticket_id} (retired {retirement_event}) -- "


def binding_message(
    *,
    ticket_id: str,
    retirement_event: str,
    authority: str,
    grant: str,
    evidence: dict,
    discovery_event: str | None,
) -> str:
    parts = [
        binding_head(ticket_id, retirement_event) + f"authority {authority} grants '{grant}'",
        evidence_token(evidence),
    ]
    if discovery_event:
        parts.append(f"discovered {discovery_event}")
    return " -- ".join(parts)


# ---------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------

#: Fields every retirement carrier (ticket record, tombstone, archived
#: metadata) holds, and which must therefore agree across all three.
SHARED_FIELDS = (
    "reason",
    "evidence",
    "evidence_note",
    "authority_receipt",
    "authority_sha256",
    "authority_grant",
    "retired_at",
    "retired_by",
    "retirement_event",
    "discovery_event",
    "evidence_bound_event",
)

TICKET_RECORD_FIELDS = frozenset(
    {
        "schema_version",
        "ticket",
        "board_record",
        "board_record_sha256",
        "section",
        "source_receipts",
        "restored_parent",
        "restored_parent_owner",
        *SHARED_FIELDS,
    }
)
TOMBSTONE_FIELDS = frozenset(
    {
        "schema_version",
        "receipt_id",
        "source_sha256",
        "linked_work",
        "status",
        "archive_ref",
        "ticket_ref",
        *SHARED_FIELDS,
    }
)
META_RETIREMENT_FIELDS = frozenset(
    {
        "schema_version",
        "retired_work",
        "board_record",
        "board_record_sha256",
        *SHARED_FIELDS,
    }
)

LEGACY_TICKET_RECORD_FIELDS = frozenset(
    {
        "schema_version",
        "ticket",
        "board_record",
        "board_record_sha256",
        "section",
        "source_receipts",
        "reason",
        "evidence",
        "authority_receipt",
        "retired_at",
        "retired_by",
        "retirement_event",
        "discovery_event",
        "restored_parent",
    }
)
LEGACY_TOMBSTONE_FIELDS = frozenset(
    {
        "schema_version",
        "receipt_id",
        "source_sha256",
        "linked_work",
        "status",
        "reason",
        "evidence",
        "authority_receipt",
        "retired_at",
        "retired_by",
        "retirement_event",
        "discovery_event",
        "archive_ref",
        "ticket_ref",
    }
)
LEGACY_META_RETIREMENT_FIELDS = frozenset(
    {
        "schema_version",
        "reason",
        "evidence",
        "authority_receipt",
        "retired_at",
        "retired_by",
        "retirement_event",
        "discovery_event",
        "retired_work",
        "board_record",
        "board_record_sha256",
    }
)


def retired_ticket_ref(ticket_id: str) -> str:
    return f"{RETIRED_DIR}/{ticket_id}.json"


def retired_source_ref(receipt_id: str) -> str:
    return f"{RETIRED_DIR}/{receipt_id}.md"


def retired_meta_ref(receipt_id: str) -> str:
    return f"{RETIRED_DIR}/{receipt_id}.meta.json"


def valid_reason(reason: object) -> bool:
    return isinstance(reason, str) and reason in RETIREMENT_REASONS


def valid_stamp(value: object) -> bool:
    if not isinstance(value, str) or not _STAMP_RE.fullmatch(value):
        return False
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return False
    return True


def board_record_digest(board_record: str) -> str:
    return hashlib.sha256(board_record.encode("utf-8")).hexdigest()


def is_retired_tombstone(tomb: object) -> bool:
    """True for a tombstone this module wrote.

    `intake.validate_project` and `_decode_index` branch on this instead of
    assuming every tombstone is a CLOSED one, so a retired receipt is never
    reported as "lacks verified closed coverage" -- it never had any, and
    inventing some is the exact fraud this operation exists to avoid.
    """
    if not isinstance(tomb, dict):
        return False
    return tomb.get("status") == intake.INVALID_STATUS and bool(tomb.get("retired_at"))


def evidence_binding_errors(label: str, binding: object) -> list[str]:
    if not isinstance(binding, dict):
        return [f"{label} evidence is not a resolved binding"]
    kind = binding.get("kind")
    if kind == "event":
        errors = []
        if set(binding) != {"kind", "ref"}:
            errors.append(f"{label} event evidence carries unexpected fields")
        if _event_number(binding.get("ref")) is None:
            errors.append(f"{label} event evidence is not an event id")
        return errors
    if kind == "artifact":
        errors = []
        if set(binding) != {"kind", "ref", "sha256"}:
            errors.append(f"{label} artifact evidence carries unexpected fields")
        problem = _evidence_rel_error(binding.get("ref"))
        if problem:
            errors.append(f"{label} artifact evidence: {problem}")
        if not isinstance(binding.get("sha256"), str) or not _SHA256_RE.fullmatch(
            binding["sha256"]
        ):
            errors.append(f"{label} artifact evidence has no valid sha256")
        return errors
    return [f"{label} evidence kind {kind!r} is neither event nor artifact"]


def _shared_field_errors(label: str, doc: dict) -> list[str]:
    errors: list[str] = []
    if not valid_reason(doc.get("reason")):
        errors.append(f"{label} carries an unregistered reason {doc.get('reason')!r}")
    errors.extend(evidence_binding_errors(label, doc.get("evidence")))
    note = doc.get("evidence_note")
    if note is not None and (not isinstance(note, str) or not note.strip() or "\n" in note):
        errors.append(f"{label} evidence_note is neither null nor a single line")
    if not intake._valid_receipt_id(str(doc.get("authority_receipt", ""))):
        errors.append(f"{label} authority_receipt is not a receipt id")
    if not isinstance(doc.get("authority_sha256"), str) or not _SHA256_RE.fullmatch(
        doc["authority_sha256"]
    ):
        errors.append(f"{label} authority_sha256 is not a sha256")
    grant = doc.get("authority_grant")
    if not isinstance(grant, str) or not _GRANT_ITEM_RE.fullmatch(grant):
        errors.append(f"{label} authority_grant is not a capsule grant line")
    if not valid_stamp(doc.get("retired_at")):
        errors.append(f"{label} retired_at is not a UTC timestamp")
    if not isinstance(doc.get("retired_by"), str) or not doc.get("retired_by", "").strip():
        errors.append(f"{label} retired_by is empty")
    retired = _event_number(doc.get("retirement_event"))
    if retired is None:
        errors.append(f"{label} retirement_event is not an event id")
    bound = _event_number(doc.get("evidence_bound_event"))
    if bound is None:
        errors.append(f"{label} evidence_bound_event is not an event id")
    elif retired is not None and bound < retired:
        errors.append(f"{label} evidence was bound before the retirement happened")
    discovery = doc.get("discovery_event")
    if discovery is not None:
        number = _event_number(discovery)
        if number is None:
            errors.append(f"{label} discovery_event is neither null nor an event id")
        elif retired is not None and number >= retired:
            errors.append(f"{label} discovery_event does not precede the retirement")
    evidence = doc.get("evidence")
    if isinstance(evidence, dict) and evidence.get("kind") == "event":
        number = _event_number(evidence.get("ref"))
        if number is not None and bound is not None and number >= bound:
            errors.append(f"{label} evidence event does not precede its binding")
    return errors


def _legacy_error(label: str) -> str:
    return (
        f"{label} is a legacy schema-{LEGACY_SCHEMA_VERSION} retirement: its evidence is "
        "unbound free text -- re-affirm it with `saipen ticket retire <T-###> --reason "
        "<CODE> --evidence <E-###|.saipen/evidence/PATH> --authority <SRC-###>`"
    )


def ticket_record_errors(ticket_id: str, record: object) -> list[str]:
    """ONE structural validator for a retired ticket's forensic record."""
    label = f"retired ticket record {ticket_id}"
    if not isinstance(record, dict):
        return [f"{label} is not an object"]
    if record.get("schema_version") == LEGACY_SCHEMA_VERSION:
        return [_legacy_error(label), *legacy_ticket_record_errors(ticket_id, record)]
    errors: list[str] = []
    if record.get("schema_version") != RETIREMENT_SCHEMA_VERSION:
        errors.append(f"{label} has invalid schema_version {record.get('schema_version')!r}")
    if set(record) != TICKET_RECORD_FIELDS:
        errors.append(
            f"{label} field set drift: missing {sorted(TICKET_RECORD_FIELDS - set(record))} "
            f"unexpected {sorted(set(record) - TICKET_RECORD_FIELDS)}"
        )
    errors.extend(_ticket_identity_errors(label, ticket_id, record))
    errors.extend(_shared_field_errors(label, record))
    parent = record.get("restored_parent")
    owner = record.get("restored_parent_owner")
    if parent is None:
        if owner is not None:
            errors.append(f"{label} names a restored parent owner without a restored parent")
    elif not isinstance(owner, str) or not owner.strip():
        errors.append(f"{label} restored {parent} without naming the seat it went back to")
    return errors


def _ticket_identity_errors(label: str, ticket_id: str, record: dict) -> list[str]:
    errors: list[str] = []
    if not _TICKET_RE.fullmatch(str(ticket_id)):
        errors.append(f"{label} is filed under a name that is not a ticket id")
    if record.get("ticket") != ticket_id:
        errors.append(f"{label} identity drift: the record names {record.get('ticket')!r}")
    board_record = record.get("board_record")
    if not isinstance(board_record, str) or not board_record.strip():
        errors.append(f"{label} has no board_record")
    else:
        if board_record_digest(board_record) != record.get("board_record_sha256"):
            errors.append(f"{label} board_record does not hash to board_record_sha256")
        if not re.match(r"\A- \[[ /]\] " + re.escape(str(ticket_id)) + r" ", board_record):
            errors.append(f"{label} board_record is not this ticket's live BOARD row")
    if record.get("section") not in RETIRABLE_SECTIONS:
        errors.append(f"{label} section {record.get('section')!r} is not a retirable BOARD section")
    receipts = record.get("source_receipts")
    if not isinstance(receipts, list) or not all(
        isinstance(r, str) and _RECEIPT_RE.fullmatch(r) for r in receipts
    ):
        errors.append(f"{label} source_receipts are not receipt ids")
    elif len(set(receipts)) != len(receipts):
        errors.append(f"{label} source_receipts repeat a receipt")
    elif record.get("authority_receipt") in receipts:
        errors.append(f"{label} is authorized by one of its own receipts")
    parent = record.get("restored_parent")
    if parent is not None and (
        not isinstance(parent, str) or not _TICKET_RE.fullmatch(parent) or parent == ticket_id
    ):
        errors.append(f"{label} restored_parent is neither null nor another ticket id")
    return errors


def legacy_ticket_record_errors(ticket_id: str, record: object) -> list[str]:
    """Structural check of a schema-1 record, so re-affirmation starts from truth."""
    label = f"legacy retired ticket record {ticket_id}"
    if not isinstance(record, dict):
        return [f"{label} is not an object"]
    errors: list[str] = []
    if record.get("schema_version") != LEGACY_SCHEMA_VERSION:
        errors.append(f"{label} is not schema {LEGACY_SCHEMA_VERSION}")
    if set(record) != LEGACY_TICKET_RECORD_FIELDS:
        errors.append(f"{label} field set drift")
    errors.extend(_ticket_identity_errors(label, ticket_id, record))
    if not valid_reason(record.get("reason")):
        errors.append(f"{label} carries an unregistered reason")
    if not isinstance(record.get("evidence"), str) or not record["evidence"].strip():
        errors.append(f"{label} has no evidence text")
    if not intake._valid_receipt_id(str(record.get("authority_receipt", ""))):
        errors.append(f"{label} authority_receipt is not a receipt id")
    if not valid_stamp(record.get("retired_at")):
        errors.append(f"{label} retired_at is not a UTC timestamp")
    if not isinstance(record.get("retired_by"), str) or not record.get("retired_by", "").strip():
        errors.append(f"{label} retired_by is empty")
    if _event_number(record.get("retirement_event")) is None:
        errors.append(f"{label} retirement_event is not an event id")
    if record.get("discovery_event") is not None and _event_number(
        record.get("discovery_event")
    ) is None:
        errors.append(f"{label} discovery_event is neither null nor an event id")
    return errors


#: The closed field set of a receipt-only retirement tombstone (T-1434 M3).
RECEIPT_ONLY_TOMBSTONE_FIELDS = frozenset(
    {
        "schema_version",
        "receipt_id",
        "source_sha256",
        "measured_sha256",
        "linked_work",
        "status",
        "archive_ref",
        "retirement",
        "retired_at",
        "retired_by",
        "retirement_event",
        "source_reason",
    }
)

#: The closed field set of a receipt-only retirement block inside the archived
#: metadata (the exact same story the tombstone tells).
RECEIPT_ONLY_RETIREMENT_FIELDS = frozenset(
    {
        "schema_version",
        "receipt_only",
        "reason",
        "successor",
        "note",
        "recorded_sha256",
        "measured_sha256",
        "digest_mismatch",
        "retired_at",
        "retired_by",
        "retirement_event",
        "source_reason",
    }
)


def _receipt_only_block_errors(label: str, block: object) -> list[str]:
    if not isinstance(block, dict):
        return [f"{label} has no retirement block"]
    errors: list[str] = []
    if block.get("schema_version") != RETIREMENT_SCHEMA_VERSION:
        errors.append(f"{label} retirement block has invalid schema_version")
    if set(block) != RECEIPT_ONLY_RETIREMENT_FIELDS:
        errors.append(f"{label} retirement block field set drift")
    if block.get("receipt_only") is not True:
        errors.append(f"{label} is not marked receipt_only")
    if not valid_source_retirement_reason(block.get("reason")):
        errors.append(f"{label} carries an unregistered source reason")
    successor = block.get("successor")
    if successor not in (None, "") and not intake._valid_receipt_id(str(successor)):
        errors.append(f"{label} successor is not a Source receipt id")
    note = block.get("note")
    if note is not None and (not isinstance(note, str) or "\n" in note):
        errors.append(f"{label} note is neither null nor a single line")
    for field in ("recorded_sha256", "measured_sha256"):
        if not isinstance(block.get(field), str) or not _SHA256_RE.fullmatch(block[field]):
            errors.append(f"{label} {field} is not a sha256")
    if not isinstance(block.get("digest_mismatch"), bool):
        errors.append(f"{label} digest_mismatch is not a boolean")
    if not valid_stamp(block.get("retired_at")):
        errors.append(f"{label} retired_at is not a UTC timestamp")
    if not isinstance(block.get("retired_by"), str) or not block.get("retired_by", "").strip():
        errors.append(f"{label} retired_by is empty")
    if _event_number(block.get("retirement_event")) is None:
        errors.append(f"{label} retirement_event is not an event id")
    return errors


def receipt_only_tombstone_errors(receipt_id: str, tomb: dict) -> list[str]:
    """Structural validation for a receipt-only retirement tombstone."""
    label = f"retired source tombstone {receipt_id}"
    errors: list[str] = []
    if tomb.get("schema_version") != RETIREMENT_SCHEMA_VERSION:
        errors.append(f"{label} has invalid schema_version")
    if set(tomb) != RECEIPT_ONLY_TOMBSTONE_FIELDS:
        errors.append(
            f"{label} field set drift: missing "
            f"{sorted(RECEIPT_ONLY_TOMBSTONE_FIELDS - set(tomb))} unexpected "
            f"{sorted(set(tomb) - RECEIPT_ONLY_TOMBSTONE_FIELDS)}"
        )
    if tomb.get("receipt_id") != receipt_id:
        errors.append(f"{label} identity drift")
    if tomb.get("status") != intake.INVALID_STATUS or not tomb.get("retired_at"):
        errors.append(f"{label} is not a retired tombstone state")
    if tomb.get("archive_ref") != retired_source_ref(receipt_id):
        errors.append(f"{label} has invalid archive_ref")
    linked = tomb.get("linked_work")
    if linked is not None and not (isinstance(linked, str) and _TICKET_RE.fullmatch(linked)):
        errors.append(f"{label} linked_work is neither null nor a ticket id")
    for field in ("source_sha256", "measured_sha256"):
        if not isinstance(tomb.get(field), str) or not _SHA256_RE.fullmatch(tomb[field]):
            errors.append(f"{label} has invalid {field}")
    errors.extend(_receipt_only_block_errors(label, tomb.get("retirement")))
    for field in ("retired_at", "retired_by", "retirement_event"):
        if tomb.get(field) != (tomb.get("retirement") or {}).get(field):
            errors.append(f"{label} {field} disagrees with its retirement block")
    if tomb.get("source_reason") != (tomb.get("retirement") or {}).get("source_reason"):
        errors.append(f"{label} source_reason disagrees with its retirement block")
    return errors


def retirement_tombstone_errors(receipt_id: str, tomb: dict) -> list[str]:
    """Structural validation for one retired tombstone projection."""
    label = f"retired tombstone {receipt_id}"
    if tomb.get("schema_version") == LEGACY_SCHEMA_VERSION:
        return [_legacy_error(label)]
    if isinstance(tomb.get("retirement"), dict) and tomb["retirement"].get("receipt_only"):
        return receipt_only_tombstone_errors(receipt_id, tomb)
    errors: list[str] = []
    if tomb.get("schema_version") != RETIREMENT_SCHEMA_VERSION:
        errors.append(f"{label} has invalid schema_version")
    if set(tomb) != TOMBSTONE_FIELDS:
        errors.append(
            f"{label} field set drift: missing {sorted(TOMBSTONE_FIELDS - set(tomb))} "
            f"unexpected {sorted(set(tomb) - TOMBSTONE_FIELDS)}"
        )
    if tomb.get("receipt_id") != receipt_id:
        errors.append(f"{label} identity drift")
    if tomb.get("archive_ref") != retired_source_ref(receipt_id):
        errors.append(f"{label} has invalid archive_ref")
    work = tomb.get("linked_work")
    if not (isinstance(work, str) and _TICKET_RE.fullmatch(work)):
        errors.append(f"{label} has invalid linked_work")
    elif tomb.get("ticket_ref") != retired_ticket_ref(work):
        errors.append(f"{label} ticket_ref does not name {work}'s retirement record")
    if not isinstance(tomb.get("source_sha256"), str) or not _SHA256_RE.fullmatch(
        tomb["source_sha256"]
    ):
        errors.append(f"{label} has invalid source_sha256")
    errors.extend(_shared_field_errors(label, tomb))
    return errors


def meta_retirement_errors(receipt_id: str, meta: dict, tomb: dict) -> list[str]:
    """The archived metadata's `retirement` block must tell the tombstone's story."""
    label = f"retired metadata {receipt_id}"
    block = meta.get("retirement")
    if not isinstance(block, dict):
        return [f"{label} has no retirement block"]
    if block.get("schema_version") == LEGACY_SCHEMA_VERSION:
        return [_legacy_error(label)]
    if block.get("receipt_only"):
        errors = _receipt_only_block_errors(label, block)
        if meta.get("receipt_id") != receipt_id:
            errors.append(f"{label} identity drift")
        if meta.get("linked_work") != tomb.get("linked_work"):
            errors.append(f"{label} names different Work than its tombstone")
        for field in ("source_sha256", "measured_sha256"):
            if meta.get(field) != tomb.get(field) and block.get(field) != tomb.get(field):
                errors.append(f"{label} {field} disagrees with its tombstone")
        return errors
    errors: list[str] = []
    if block.get("schema_version") != RETIREMENT_SCHEMA_VERSION:
        errors.append(f"{label} retirement block has invalid schema_version")
    if set(block) != META_RETIREMENT_FIELDS:
        errors.append(f"{label} retirement block field set drift")
    errors.extend(_shared_field_errors(label, block))
    if meta.get("receipt_id") != receipt_id:
        errors.append(f"{label} identity drift")
    if meta.get("linked_work") != tomb.get("linked_work") or block.get(
        "retired_work"
    ) != tomb.get("linked_work"):
        errors.append(f"{label} names different Work than its tombstone")
    board_record = block.get("board_record")
    if not isinstance(board_record, str) or board_record_digest(board_record) != block.get(
        "board_record_sha256"
    ):
        errors.append(f"{label} board_record does not hash to board_record_sha256")
    for field in SHARED_FIELDS:
        if block.get(field) != tomb.get(field):
            errors.append(f"{label} {field} disagrees with its tombstone")
    return errors


# ---------------------------------------------------------------------------
# Owned reads
# ---------------------------------------------------------------------------


def _existing(root: Path, rel: str) -> bytes | None:
    path = root / rel
    try:
        if not path.is_file():
            return None
        return path.read_bytes()
    except OSError:
        return None


def load_ticket_retirement(root: Path | str, ticket_id: str) -> tuple[dict | None, list[str], bool]:
    """(record, errors, exists) for one ticket's forensic record.

    Read through the intake owned-file reader, so a symlink, junction, reparse
    point or non-regular node is refused before a byte is trusted. `record`
    is returned even when invalid so re-affirmation can inspect a legacy one;
    callers decide by `errors`.
    """
    root = Path(root)
    if not _TICKET_RE.fullmatch(str(ticket_id)):
        return None, [f"{ticket_id!r} is not a ticket id"], False
    rel = retired_ticket_ref(ticket_id)
    try:
        raw = intake._read_owned_file(
            root, rel, kind="retired ticket record", max_bytes=_RECORD_MAX_BYTES
        )
    except FileNotFoundError:
        if os.path.lexists(root / rel):
            return None, [f"retired ticket record {ticket_id} is a dangling link"], True
        return None, [], False
    except (OSError, ValueError) as exc:
        return None, [f"retired ticket record {ticket_id} is unsafe or unreadable: {exc}"], True
    try:
        record = json.loads(raw.decode("utf-8-sig"))
    except ValueError as exc:
        return None, [f"retired ticket record {ticket_id} does not parse: {exc}"], True
    return record, ticket_record_errors(ticket_id, record), True


def read_ticket_retirement(root: Path | str, ticket_id: str) -> dict | None:
    """The VALID retirement record for a ticket, or None.

    An invalid record is not an answer to "what was T-1369?": a caller that
    needs to know one exists but is broken uses `load_ticket_retirement`.
    """
    record, errors, _exists = load_ticket_retirement(root, ticket_id)
    return record if record is not None and not errors else None


# ---------------------------------------------------------------------------
# Cross-artifact, namespace and history validation
# ---------------------------------------------------------------------------


def retired_link_errors(root: Path, receipt_id: str, tomb: dict) -> list[str]:
    """No dangling forensic link: the tombstone's `ticket_ref` must resolve to
    a valid record for the SAME Work that tells the SAME retirement story."""
    work = tomb.get("linked_work")
    ref = tomb.get("ticket_ref")
    if not isinstance(work, str) or not _TICKET_RE.fullmatch(work):
        return []  # reported structurally
    if ref != retired_ticket_ref(work):
        return []  # reported structurally
    record, record_errors, exists = load_ticket_retirement(root, work)
    if not exists:
        return [f"retired tombstone {receipt_id} points at {ref}, which does not exist"]
    if record is None or record_errors:
        return [
            f"retired tombstone {receipt_id} points at an invalid record: {problem}"
            for problem in record_errors
        ]
    errors: list[str] = []
    receipts = record.get("source_receipts") or []
    if receipt_id not in receipts:
        errors.append(f"retired ticket record {work} does not list {receipt_id} among its receipts")
    for field in SHARED_FIELDS:
        if record.get(field) != tomb.get(field):
            errors.append(
                f"retired tombstone {receipt_id} and ticket record {work} disagree on {field}"
            )
    return errors


def _node_errors(path: Path, label: str, *, expect_dir: bool) -> list[str]:
    try:
        info = os.lstat(path)
    except OSError as exc:
        return [f"{label} is unreadable: {exc}"]
    if intake._is_link_or_reparse(path):
        return [f"{label} is a link or reparse point"]
    if expect_dir and not stat.S_ISDIR(info.st_mode):
        return [f"{label} is not a directory"]
    if not expect_dir and not stat.S_ISREG(info.st_mode):
        return [f"{label} is not a regular file"]
    return []


def retired_namespace_errors(root: Path, index: dict, board_tickets: dict) -> list[str]:
    """Every artifact in the forensic namespace is owned, recognized and linked.

    The per-tombstone checks cannot see a ticket record nobody points at, a
    stray receipt bundle, or a record for Work that is somehow still on BOARD.
    This walks the namespace itself.
    """
    root = Path(root)
    directory = root / RETIRED_DIR
    tombstones = index.get("tombstones", {})
    retired_tombs = {
        rid: tomb for rid, tomb in tombstones.items() if is_retired_tombstone(tomb)
    }
    if not os.path.lexists(directory):
        return []
    errors: list[str] = []
    for container in (root / ".saipen" / "archive", directory):
        errors.extend(
            _node_errors(container, f"forensic container {container.name}", expect_dir=True)
        )
    if errors:
        return errors
    records: dict[str, dict] = {}
    for entry in sorted(os.listdir(directory)):
        path = directory / entry
        node = _node_errors(path, f"retired artifact {entry}", expect_dir=False)
        if node:
            errors.extend(node)
            continue
        match = _RETIRED_NAME_RE.fullmatch(entry)
        if not match:
            errors.append(f"retired artifact {entry} is not a recognized forensic file")
            continue
        if match.group(1):
            ticket_id = match.group(1)
            record, record_errors, _exists = load_ticket_retirement(root, ticket_id)
            errors.extend(record_errors)
            if record is not None and not record_errors:
                records[ticket_id] = record
        elif match.group(2) not in retired_tombs:
            errors.append(
                f"retired artifact {entry} belongs to {match.group(2)}, which has no "
                "retired tombstone"
            )
    for ticket_id, record in sorted(records.items()):
        if ticket_id in board_tickets:
            errors.append(f"retired ticket {ticket_id} is still on BOARD as schedulable Work")
        errors.extend(bound_artifact_errors(root, ticket_id, record.get("evidence") or {}))
        for receipt_id in record.get("source_receipts") or []:
            tomb = retired_tombs.get(receipt_id)
            if tomb is None:
                errors.append(
                    f"retired ticket record {ticket_id} lists {receipt_id}, which has no "
                    "retired tombstone"
                )
            elif tomb.get("linked_work") != ticket_id:
                errors.append(
                    f"retired ticket record {ticket_id} lists {receipt_id}, whose tombstone "
                    f"names {tomb.get('linked_work')!r}"
                )
    if records:
        errors.extend(_history_errors_for(root, records))
    return errors


def bound_artifact_errors(root: Path, ticket_id: str, evidence: dict) -> list[str]:
    """A content-bound artifact must still BE the content it was bound to."""
    if evidence.get("kind") != "artifact":
        return []
    ref = evidence.get("ref")
    label = f"retired ticket record {ticket_id} evidence artifact {ref}"
    try:
        raw = intake._read_owned_file(
            root, str(ref), kind="retirement evidence artifact", max_bytes=_EVIDENCE_MAX_BYTES
        )
    except (FileNotFoundError, OSError, ValueError) as exc:
        return [f"{label} is missing or unsafe: {exc}"]
    if artifact_digest(raw) != evidence.get("sha256"):
        return [f"{label} no longer hashes to the sha256 its retirement bound"]
    return []


def _history_errors_for(root: Path, records: dict) -> list[str]:
    try:
        from .log import read_history_snapshot

        snapshot = read_history_snapshot(root, lean=True)
    except Exception as exc:  # any history fault fails the check closed
        return [f"retired ticket history unverifiable: {exc}"]
    events = {event["event"]: event for event in snapshot.events}
    errors: list[str] = []
    for ticket_id, record in sorted(records.items()):
        errors.extend(retirement_history_errors(ticket_id, record, events))
    return errors


def retirement_history_errors(ticket_id: str, record: dict, events: dict) -> list[str]:
    """The events a record cites exist and say what the record says.

    The forensic record is a projection of the append-only LOG. A record whose
    retirement event is missing, names other Work, or tells another story was
    not written by the transaction it claims.
    """
    label = f"retired ticket record {ticket_id}"
    errors: list[str] = []
    retired = _event_number(record.get("retirement_event"))
    bound = _event_number(record.get("evidence_bound_event"))
    evidence = record.get("evidence") or {}
    reason = record.get("reason")
    authority = record.get("authority_receipt")

    retire_event = events.get(retired) if retired is not None else None
    if retire_event is None:
        errors.append(
            f"{label} cites retirement event {record.get('retirement_event')}, absent from LOG"
        )
    else:
        text = str(retire_event.get("text") or "")
        if (
            retire_event.get("taxonomy") != "DEC"
            or retire_event.get("ticket") != ticket_id
            or not str(retire_event.get("op_id") or "").startswith("retire-")
            or retirement_head(ticket_id, str(reason), str(authority)) not in text
        ):
            errors.append(
                f"{label} cites {record.get('retirement_event')}, which is not this "
                "ticket's retirement event"
            )
        elif retire_event.get("agent") != record.get("retired_by"):
            errors.append(f"{label} retired_by disagrees with the retirement event's agent")
        elif bound == retired and evidence_token(evidence) not in text:
            errors.append(f"{label} evidence is not the evidence its retirement event recorded")
        elif bound == retired and record.get("evidence_note") and (
            f"note: {record['evidence_note']}" not in text
        ):
            errors.append(f"{label} evidence_note is not the note its retirement event recorded")
    if bound is not None and retired is not None and bound != retired:
        bind_event = events.get(bound)
        if bind_event is None:
            errors.append(
                f"{label} cites evidence binding {record.get('evidence_bound_event')}, "
                "absent from LOG"
            )
        else:
            text = str(bind_event.get("text") or "")
            if (
                bind_event.get("taxonomy") != "DEC"
                or bind_event.get("ticket") != ticket_id
                or not str(bind_event.get("op_id") or "").startswith("retire-")
                or binding_head(ticket_id, str(record.get("retirement_event"))) not in text
                or evidence_token(evidence) not in text
            ):
                errors.append(
                    f"{label} cites {record.get('evidence_bound_event')}, which is not this "
                    "ticket's evidence binding"
                )
        if retire_event is not None and record.get("evidence_note") and (
            f" -- {record['evidence_note']}" not in str(retire_event.get("text") or "")
        ):
            errors.append(
                f"{label} evidence_note is not the evidence text its retirement event recorded"
            )
    for field in ("discovery_event",):
        number = _event_number(record.get(field))
        if record.get(field) is not None and (number is None or number not in events):
            errors.append(f"{label} {field} {record.get(field)} is absent from LOG")
    if evidence.get("kind") == "event":
        number = _event_number(evidence.get("ref"))
        if number is None or number not in events:
            errors.append(f"{label} evidence event {evidence.get('ref')} is absent from LOG")
    return errors


def retired_archive_errors(root: Path, receipt_id: str, tomb: dict) -> list[str]:
    """The receipt half: exact body bytes, honest metadata, a resolvable link."""
    errors: list[str] = []
    digest = tomb.get("source_sha256")
    block = tomb.get("retirement") if isinstance(tomb.get("retirement"), dict) else {}
    receipt_only = bool(block.get("receipt_only"))
    try:
        body = intake._read_owned_file(
            root,
            retired_source_ref(receipt_id),
            kind="retired source body",
            max_bytes=intake._BODY_MAX,
        )
    except (FileNotFoundError, OSError, ValueError) as exc:
        return [f"retired receipt {receipt_id} body unreadable: {exc}"]
    # Receipt-only retirement preserves the ORIGINAL bytes even when the
    # recorded digest no longer matches them (STALE_CREDENTIAL): the measured
    # digest is what the archived copy must reproduce, so corruption stays
    # visible instead of being "fixed" during cold storage.
    expected = (
        block.get("measured_sha256")
        if receipt_only and block.get("digest_mismatch")
        else digest
    )
    if hashlib.sha256(body).hexdigest() != expected:
        errors.append(f"retired receipt {receipt_id} archived body digest mismatch")
    try:
        meta_raw = intake._read_owned_file(
            root,
            retired_meta_ref(receipt_id),
            kind="retired source metadata",
            max_bytes=intake._META_MAX,
        )
        meta = json.loads(meta_raw.decode("utf-8-sig"))
    except (FileNotFoundError, OSError, ValueError) as exc:
        errors.append(f"retired receipt {receipt_id} metadata unreadable: {exc}")
        return errors
    if not isinstance(meta, dict) or meta.get("status") != intake.INVALID_STATUS:
        errors.append(f"retired receipt {receipt_id} archived metadata is not INVALID")
        return errors
    if meta.get("source_sha256") != digest:
        errors.append(f"retired receipt {receipt_id} archived metadata digest drift")
    if tomb.get("schema_version") != LEGACY_SCHEMA_VERSION:
        errors.extend(meta_retirement_errors(receipt_id, meta, tomb))
        # A receipt-only retirement has no ticket link to resolve; its identity
        # is the tombstone itself plus the archived meta.
        if not receipt_only:
            errors.extend(retired_link_errors(root, receipt_id, tomb))
    if os.path.lexists(root / ".saipen" / "intake" / "active" / f"{receipt_id}.md"):
        errors.append(f"retired receipt {receipt_id} still holds an active body")
    return errors


# ---------------------------------------------------------------------------
# Planning
# ---------------------------------------------------------------------------


def _write_target(rel: str, content: bytes, before: bytes | None) -> TargetPlan:
    return TargetPlan(
        rel,
        "generic",
        content,
        hash_bytes(before) if before is not None else "",
        hash_bytes(content),
    )


def _delete_target(rel: str, before: bytes) -> TargetPlan:
    return TargetPlan(rel, "generic", b"", hash_bytes(before), "", action="delete_file")


def shared_fields(
    *,
    reason: str,
    evidence: dict,
    evidence_note: str | None,
    authority: dict,
    retired_at: str,
    retired_by: str,
    retirement_event: str,
    discovery_event: str | None,
    evidence_bound_event: str,
) -> dict:
    return {
        "reason": reason,
        "evidence": dict(evidence),
        "evidence_note": evidence_note,
        "authority_receipt": authority["authority_receipt"],
        "authority_sha256": authority["authority_sha256"],
        "authority_grant": authority["authority_grant"],
        "retired_at": retired_at,
        "retired_by": retired_by,
        "retirement_event": retirement_event,
        "discovery_event": discovery_event,
        "evidence_bound_event": evidence_bound_event,
    }


def source_retirement_targets(
    root: Path,
    receipt_id: str,
    *,
    ticket_id: str,
    board_record: str,
    shared: dict,
) -> tuple[list[TargetPlan], dict]:
    """Plan the intake half: hot surface out, forensic cold storage in.

    Returns (targets, tombstone). Raises ValueError for anything the caller
    must refuse; it is PLAN-time only and writes zero bytes.
    """
    meta = intake._read_meta(root, receipt_id)
    if not meta:
        raise ValueError(f"receipt {receipt_id} has no active metadata")
    digest = meta.get("source_sha256")
    body = _existing(root, f".saipen/intake/active/{receipt_id}.md")
    if body is None:
        raise ValueError(f"receipt {receipt_id} body missing")
    if hashlib.sha256(body).hexdigest() != digest:
        raise ValueError(f"receipt {receipt_id} body digest mismatch")

    retired_meta = dict(meta)
    retired_meta["status"] = intake.INVALID_STATUS
    retired_meta["storage_status"] = intake.ARCHIVED_STATUS
    retired_meta["archive_ref"] = retired_source_ref(receipt_id)
    retired_meta["retirement"] = {
        "schema_version": RETIREMENT_SCHEMA_VERSION,
        "retired_work": ticket_id,
        "board_record": board_record,
        "board_record_sha256": board_record_digest(board_record),
        **shared,
    }

    tombstone = {
        "schema_version": RETIREMENT_SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "source_sha256": digest,
        "linked_work": meta.get("linked_work"),
        "status": intake.INVALID_STATUS,
        "archive_ref": retired_source_ref(receipt_id),
        "ticket_ref": retired_ticket_ref(ticket_id),
        **shared,
    }

    targets: list[TargetPlan] = []
    # Cold storage first: the forensic copy exists before the hot surface
    # loses it, so every crash window keeps the bytes readable somewhere.
    body_rel = retired_source_ref(receipt_id)
    targets.append(_write_target(body_rel, body, _existing(root, body_rel)))
    meta_rel = retired_meta_ref(receipt_id)
    targets.append(
        _write_target(meta_rel, intake._json_bytes(retired_meta), _existing(root, meta_rel))
    )
    # Contract and coverage are copied EXACTLY as they stand -- unresolved
    # clauses included. Upgrading a disposition here would manufacture the
    # coverage this operation exists to avoid.
    for label, active_rel in (
        ("contract", f".saipen/intake/contracts/{receipt_id}.json"),
        ("coverage", f".saipen/intake/coverage/{receipt_id}.json"),
    ):
        current = _existing(root, active_rel)
        if current is None:
            continue
        cold_rel = f"{RETIRED_DIR}/{receipt_id}.{label}.json"
        targets.append(_write_target(cold_rel, current, _existing(root, cold_rel)))
    for revision in sorted((root / ".saipen/intake/contracts").glob(f"{receipt_id}.r*.json")):
        if not revision.is_file():
            continue
        rel = f".saipen/intake/contracts/{revision.name}"
        current = _existing(root, rel)
        if current is None:
            continue
        cold_rel = f"{RETIRED_DIR}/{revision.name}"
        targets.append(_write_target(cold_rel, current, _existing(root, cold_rel)))

    # Hot surface out: metadata first, so a crash never leaves metadata that
    # names a body which is already gone.
    for active_rel in (
        f".saipen/intake/active/{receipt_id}.meta.json",
        f".saipen/intake/active/{receipt_id}.md",
        f".saipen/intake/contracts/{receipt_id}.json",
        f".saipen/intake/coverage/{receipt_id}.json",
    ):
        current = _existing(root, active_rel)
        if current is not None:
            targets.append(_delete_target(active_rel, current))
    for revision in sorted((root / ".saipen/intake/contracts").glob(f"{receipt_id}.r*.json")):
        rel = f".saipen/intake/contracts/{revision.name}"
        current = _existing(root, rel)
        if current is not None:
            targets.append(_delete_target(rel, current))

    tomb_rel = f".saipen/intake/tombstones/{receipt_id}.json"
    targets.append(
        _write_target(tomb_rel, intake._json_bytes(tombstone), _existing(root, tomb_rel))
    )
    return targets, tombstone


# ------------------------------------------------- receipt-only retirement


#: Receipt-only retirement reasons (T-1434 M3 / SRC-088). These retire a SOURCE
#: whose own state proves it cannot represent current actionable work. Each one
#: is machine-checkable, which is the whole point: a reason that cannot be
#: proven is a free-text excuse to delete a receipt.
#:
#:   EMPTY_STALE_SOURCE       zero requirements; nothing was ever owed.
#:   STALE_CREDENTIAL         the body no longer matches its recorded digest
#:                            identity (bytes are preserved, never rewritten).
#:   SUPERSEDED_SOURCE        a named successor receipt exists; no unresolved
#:                            requirement is discarded.
#:   ORPHANED_RECEIPT         no live Work references it and its linked Work is
#:                            absent from BOARD.
#:   MISROUTED_PROJECT_BINDING the receipt was minted here by a wrong-root
#:                            resolution; requires a --note naming the owner.
SOURCE_RETIREMENT_REASONS = (
    "EMPTY_STALE_SOURCE",
    "STALE_CREDENTIAL",
    "SUPERSEDED_SOURCE",
    "ORPHANED_RECEIPT",
    "MISROUTED_PROJECT_BINDING",
)


def valid_source_retirement_reason(reason: object) -> bool:
    return isinstance(reason, str) and reason in SOURCE_RETIREMENT_REASONS


def source_retirement_errors(
    root: Path,
    receipt_id: str,
    *,
    reason: str,
    successor: str | None,
    note: str | None,
) -> list[str]:
    """Why this receipt may NOT be retired for this reason, or [] when it may.

    PLAN-time only, zero writes. Unresolved actionable requirements ALWAYS
    refuse: retirement may remove a non-actionable receipt from CURRENT gating,
    never discard an obligation. Each reason additionally proves its own class.
    """
    root = Path(root)
    problems: list[str] = []
    if not intake._valid_receipt_id(receipt_id):
        return [f"{receipt_id!r} is not a Source receipt id"]
    if not valid_source_retirement_reason(reason):
        return [f"reason {reason!r} is outside {'|'.join(SOURCE_RETIREMENT_REASONS)}"]
    meta = intake._read_meta(root, receipt_id)
    if not meta:
        return [f"{receipt_id} has no active metadata (already retired or never captured)"]
    if str(meta.get("status") or "") != intake.ACTIVE_STATUS:
        problems.append(f"{receipt_id} is {meta.get('status')!r}, not ACTIVE")
    successor = str(successor or "").strip()
    try:
        summary = intake.coverage_summary(root, receipt_id)
    except (OSError, ValueError) as exc:
        return [f"{receipt_id} coverage is unreadable: {exc}"]
    unresolved = list(summary.get("unresolved") or [])
    if unresolved:
        problems.append(
            f"{receipt_id} still carries {len(unresolved)} unresolved actionable "
            f"requirement(s): {', '.join(unresolved[:3])}"
            + (" ..." if len(unresolved) > 3 else "")
        )
    if reason == "EMPTY_STALE_SOURCE" and summary.get("requirements"):
        problems.append(
            f"{receipt_id} is not empty: it carries {summary['requirements']} requirement(s)"
        )
    if reason == "SUPERSEDED_SOURCE":
        if not successor:
            problems.append("SUPERSEDED_SOURCE requires --successor SRC-###")
        elif not intake._valid_receipt_id(successor):
            problems.append(f"successor {successor!r} is not a Source receipt id")
        elif successor == receipt_id:
            problems.append(f"{receipt_id} cannot succeed itself")
        else:
            successor_meta = intake._read_meta(root, successor)
            successor_tomb = intake._read_index(root).get("tombstones", {}).get(successor)
            if not successor_meta and not successor_tomb:
                problems.append(
                    f"successor {successor} exists in neither ACTIVE nor tombstones"
                )
    from .board import parse_board

    board_raw = _existing(root, ".saipen/BOARD.md")
    tickets = (
        parse_board(board_raw.decode("utf-8-sig")).get("tickets", {})
        if board_raw is not None
        else {}
    )
    # T-1476: a live Work's own request is an obligation even while its
    # contract is still empty (the request clause is added at closure), so
    # the unresolved-requirement check above cannot see it. Retiring the
    # receipt under the Work strands its closure: the gate answers
    # SOURCE_RECEIPT_MISSING and nothing can close or re-home the Work.
    live = sorted(
        tid
        for tid, t in tickets.items()
        if t.get("section") != "## DONE"
        and (
            tid in intake.linked_works(meta)
            or receipt_id
            in {
                value.strip()
                for value in str((t.get("fields") or {}).get("source_receipts") or "").split(",")
            }
        )
    )
    if live:
        problems.append(
            f"{receipt_id} is the source of live Work {', '.join(live[:3])}; "
            "close or retire that Work before its source"
        )
    if reason == "ORPHANED_RECEIPT":
        linked = str(meta.get("linked_work") or "").strip()
        if linked and linked in tickets and linked not in live:
            problems.append(f"{receipt_id} is still linked to live Work {linked}")
        if not linked:
            referencing = [
                tid
                for tid, t in tickets.items()
                if receipt_id in str((t.get("fields") or {}).get("source_receipts") or "")
                and tid not in live
            ]
            if referencing:
                problems.append(
                    f"{receipt_id} is claimed by BOARD Work {referencing[0]}"
                )
    # A broken body-digest identity has exactly ONE provable reason class: it
    # may not be buried under EMPTY_STALE_SOURCE or ORPHANED_RECEIPT, because
    # then the corruption disappears from the retirement record's meaning.
    try:
        identity_ok = bool(intake.verify_integrity(root, receipt_id).get("ok"))
    except (OSError, ValueError) as exc:
        problems.append(f"{receipt_id} body-digest identity is unreadable: {exc}")
        identity_ok = False
    if reason == "STALE_CREDENTIAL":
        if identity_ok:
            problems.append(
                f"{receipt_id} still passes its own body-digest identity check; "
                "STALE_CREDENTIAL requires a provably dead credential/digest identity"
            )
    elif not identity_ok:
        problems.append(
            f"{receipt_id} fails its own body-digest identity; the provable "
            f"reason class is STALE_CREDENTIAL, not {reason}"
        )
    if reason == "MISROUTED_PROJECT_BINDING" and not str(note or "").strip():
        problems.append("MISROUTED_PROJECT_BINDING requires --note naming the true project")
    return problems


def source_only_retirement_targets(
    root: Path,
    receipt_id: str,
    *,
    reason: str,
    successor: str | None,
    note: str | None,
    shared: dict,
) -> tuple[list[TargetPlan], dict]:
    """Plan a receipt-only retirement: cold copy first, hot surface out.

    The ORIGINAL body bytes are copied to cold storage EXACTLY as they stand
    (corrupt digest included) and the measured digest is recorded beside the
    recorded one, so nothing is silently rewritten and the mismatch stays
    visible forever. Raises ValueError on anything the caller must refuse.
    """
    root = Path(root)
    meta = intake._read_meta(root, receipt_id)
    if not meta:
        raise ValueError(f"receipt {receipt_id} has no active metadata")
    recorded = meta.get("source_sha256")
    body = _existing(root, f".saipen/intake/active/{receipt_id}.md")
    if body is None:
        raise ValueError(
            f"receipt {receipt_id} body missing; original bytes cannot be preserved"
        )
    measured = hashlib.sha256(body).hexdigest()
    retirement = {
        "schema_version": RETIREMENT_SCHEMA_VERSION,
        "receipt_only": True,
        "reason": reason,
        "successor": str(successor or ""),
        "note": str(note or ""),
        "recorded_sha256": recorded,
        "measured_sha256": measured,
        "digest_mismatch": measured != recorded,
        **shared,
    }
    retired_meta = dict(meta)
    retired_meta["status"] = intake.INVALID_STATUS
    retired_meta["storage_status"] = intake.ARCHIVED_STATUS
    retired_meta["archive_ref"] = retired_source_ref(receipt_id)
    retired_meta["retirement"] = retirement
    tombstone = {
        "schema_version": RETIREMENT_SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "source_sha256": recorded,
        "measured_sha256": measured,
        "linked_work": meta.get("linked_work"),
        "status": intake.INVALID_STATUS,
        "archive_ref": retired_source_ref(receipt_id),
        "retirement": retirement,
        **shared,
    }

    targets: list[TargetPlan] = []
    body_rel = retired_source_ref(receipt_id)
    targets.append(_write_target(body_rel, body, _existing(root, body_rel)))
    meta_rel = retired_meta_ref(receipt_id)
    targets.append(
        _write_target(meta_rel, intake._json_bytes(retired_meta), _existing(root, meta_rel))
    )
    for label, active_rel in (
        ("contract", f".saipen/intake/contracts/{receipt_id}.json"),
        ("coverage", f".saipen/intake/coverage/{receipt_id}.json"),
    ):
        current = _existing(root, active_rel)
        if current is None:
            continue
        cold_rel = f"{RETIRED_DIR}/{receipt_id}.{label}.json"
        targets.append(_write_target(cold_rel, current, _existing(root, cold_rel)))
    for revision in sorted((root / ".saipen/intake/contracts").glob(f"{receipt_id}.r*.json")):
        if not revision.is_file():
            continue
        rel = f".saipen/intake/contracts/{revision.name}"
        current = _existing(root, rel)
        if current is None:
            continue
        targets.append(
            _write_target(f"{RETIRED_DIR}/{revision.name}", current, _existing(root, rel))
        )
    for active_rel in (
        f".saipen/intake/active/{receipt_id}.meta.json",
        f".saipen/intake/active/{receipt_id}.md",
        f".saipen/intake/contracts/{receipt_id}.json",
        f".saipen/intake/coverage/{receipt_id}.json",
    ):
        current = _existing(root, active_rel)
        if current is not None:
            targets.append(_delete_target(active_rel, current))
    for revision in sorted((root / ".saipen/intake/contracts").glob(f"{receipt_id}.r*.json")):
        rel = f".saipen/intake/contracts/{revision.name}"
        current = _existing(root, rel)
        if current is not None:
            targets.append(_delete_target(rel, current))
    tomb_rel = f".saipen/intake/tombstones/{receipt_id}.json"
    targets.append(
        _write_target(tomb_rel, intake._json_bytes(tombstone), _existing(root, tomb_rel))
    )
    return targets, tombstone


def index_target(root: Path, tombstones: dict[str, dict]) -> TargetPlan:
    """ONE intake index write carrying every tombstone of the transaction."""
    index_rel = ".saipen/intake/index.json"
    index_raw = _existing(root, index_rel)
    if index_raw is None:
        raise ValueError("source intake index missing")
    index = intake._decode_index(json.loads(index_raw.decode("utf-8-sig")))
    for receipt_id, tomb in tombstones.items():
        index["active"].pop(receipt_id, None)
        index["tombstones"][receipt_id] = tomb
    return _write_target(index_rel, intake._json_bytes(index), index_raw)


def ticket_retirement_target(
    root: Path,
    ticket_id: str,
    *,
    board_record: str,
    section: str,
    receipts: list[str],
    shared: dict,
    restored_parent: str | None,
    restored_parent_owner: str | None,
) -> tuple[TargetPlan, dict]:
    """The ticket's own tombstone: the answer to "what WAS T-1369?".

    The BOARD row is stored VERBATIM. BOARD is a scheduling projection and is
    legitimately pruned; this record is what makes the prune non-destructive.
    """
    record = {
        "schema_version": RETIREMENT_SCHEMA_VERSION,
        "ticket": ticket_id,
        "board_record": board_record,
        "board_record_sha256": board_record_digest(board_record),
        "section": section,
        "source_receipts": list(receipts),
        "restored_parent": restored_parent,
        "restored_parent_owner": restored_parent_owner if restored_parent else None,
        **shared,
    }
    rel = retired_ticket_ref(ticket_id)
    return _write_target(rel, intake._json_bytes(record), _existing(root, rel)), record


def legacy_rebind_targets(
    root: Path,
    ticket_id: str,
    record: dict,
    *,
    shared: dict,
) -> tuple[list[TargetPlan], dict]:
    """Re-affirm a schema-1 retirement under the current contract.

    Every historical field -- the BOARD row, the section, the receipts, the
    reason, the authority, the time, the actor, the retirement event and the
    restored parent -- is kept VERBATIM. The free-text evidence survives as
    `evidence_note`. What is added is exactly what the old record could not
    prove: a resolved evidence binding, the authority digest and grant line,
    the seat the parent went back to, and the NEW event that bound them.
    """
    receipts = list(record.get("source_receipts") or [])
    restored_parent = record.get("restored_parent")
    upgraded = {
        "schema_version": RETIREMENT_SCHEMA_VERSION,
        "ticket": ticket_id,
        "board_record": record["board_record"],
        "board_record_sha256": record["board_record_sha256"],
        "section": record["section"],
        "source_receipts": receipts,
        "restored_parent": restored_parent,
        # Schema 1 restored a parked parent to the ACTING agent -- that is what
        # its code did, so that is the seat this names.
        "restored_parent_owner": record.get("retired_by") if restored_parent else None,
        **shared,
    }
    targets: list[TargetPlan] = []
    rel = retired_ticket_ref(ticket_id)
    targets.append(_write_target(rel, intake._json_bytes(upgraded), _existing(root, rel)))
    tombstones: dict[str, dict] = {}
    for receipt_id in receipts:
        tomb_rel = f".saipen/intake/tombstones/{receipt_id}.json"
        raw_tomb = _existing(root, tomb_rel)
        if raw_tomb is None:
            raise ValueError(f"retired receipt {receipt_id} tombstone missing")
        old_tomb = json.loads(raw_tomb.decode("utf-8-sig"))
        if set(old_tomb) != LEGACY_TOMBSTONE_FIELDS or old_tomb.get("schema_version") != (
            LEGACY_SCHEMA_VERSION
        ):
            raise ValueError(f"retired receipt {receipt_id} tombstone is not a legacy retirement")
        tomb = {
            "schema_version": RETIREMENT_SCHEMA_VERSION,
            "receipt_id": receipt_id,
            "source_sha256": old_tomb["source_sha256"],
            "linked_work": old_tomb["linked_work"],
            "status": intake.INVALID_STATUS,
            "archive_ref": old_tomb["archive_ref"],
            "ticket_ref": old_tomb["ticket_ref"],
            **shared,
        }
        targets.append(_write_target(tomb_rel, intake._json_bytes(tomb), raw_tomb))
        tombstones[receipt_id] = tomb
        meta_rel = retired_meta_ref(receipt_id)
        raw_meta = _existing(root, meta_rel)
        if raw_meta is None:
            raise ValueError(f"retired receipt {receipt_id} metadata missing")
        meta = json.loads(raw_meta.decode("utf-8-sig"))
        block = meta.get("retirement") if isinstance(meta, dict) else None
        if not isinstance(block, dict) or set(block) != LEGACY_META_RETIREMENT_FIELDS:
            raise ValueError(f"retired receipt {receipt_id} metadata is not a legacy retirement")
        meta["retirement"] = {
            "schema_version": RETIREMENT_SCHEMA_VERSION,
            "retired_work": block["retired_work"],
            "board_record": block["board_record"],
            "board_record_sha256": block["board_record_sha256"],
            **shared,
        }
        targets.append(_write_target(meta_rel, intake._json_bytes(meta), raw_meta))
    targets.append(index_target(root, tombstones))
    return targets, upgraded
