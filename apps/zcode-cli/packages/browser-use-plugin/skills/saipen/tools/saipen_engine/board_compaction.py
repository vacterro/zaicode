"""Lossless canonical repair for historical oversized BOARD records.

New writers still enforce ``MAX_LIVE_RECORD_CHARS``.  This module owns the one
repair path for a readable historical row that needs a normal mutation: the
complete physical record is journaled into the existing recovery namespace and
the BOARD projection keeps only scheduling truth plus a deterministic detail
reference.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from .board import (
    KNOWN_FIELDS,
    MAX_LIVE_RECORD_CHARS,
    assert_live_record,
    escape_ticket_description,
    parse_board,
)
from .journal import hash_bytes, owned_target_path
from .paths import project_identity, project_lineage_identity
from .plan import TargetPlan

COMPACTION_ROOT = ".saipen/recovery/board-compaction"
COMPACTION_SCHEMA = 1
_TITLE_LIMIT = 180
_VERIFY_LIMIT = 220
_FIELD_LIMIT = 200
_MIN_PART = 16
_MIN_CRITICAL_PART = 40

#: The closed set of compaction dispositions a field may carry. Every value is
#: an explicitly authored decision, never a default:
#:
#:   inline     exact small machine-routing truth, re-emitted bounded (owner,
#:              claim_time, verify_attempts, review_passes, the enum fields)
#:   compact    replaced by its dedicated bounded representation (`verify`)
#:   tokenized  bounded inline list that keeps every machine identifier the
#:              consumers read (needs T-###, source_reports/source_receipts
#:              SRC-###, closure_paths); the full prose lives in detail
#:   head       bounded prefix that keeps the leading class token intact
#:              (`blocker` -- blocker_class reads the prefix before ` -- `)
#:   replaced   overwritten by the compaction authority (`detail_ref`)
COMPACTION_MODES = frozenset({"inline", "compact", "tokenized", "head", "replaced"})

#: Per-field machine identifier pattern preserved by the `tokenized` mode.
_TOKEN_PATTERNS = {
    "needs": r"T-\d+",
    "source_reports": r"SRC-\d+(?::R\d+)?",
    "source_receipts": r"SRC-\d+(?::R\d+)?",
    "closure_paths": r"[^,\s]+",
}

#: The one authored policy. Adding a member to `KNOWN_FIELDS` without editing
#: this mapping is a loud RED in the focused suite (`validate_compaction_
#: disposition` / the equality assertion), never a silent `inline` fall-through.
COMPACTION_DISPOSITION = {
    "blocked_on": "inline",
    "blocker": "head",
    "blocker_scope": "inline",
    "claim_time": "inline",
    # T-1384. Inline beside `owner`/`claim_time` because admission reads it on
    # the live record to decide a mutation: a binding moved out to an
    # externalized detail file would be a gate the gate cannot see, and the
    # answer would silently become "unbound". It is 32 hex characters, so it
    # costs the live line nothing worth reclaiming.
    "claim_session": "inline",
    "closure_cohort": "inline",
    "closure_mode": "inline",
    "closure_paths": "tokenized",
    "detail_ref": "replaced",
    "external_authority": "inline",
    "external_evidence": "inline",
    "external_implementation": "inline",
    "implementation_delta": "inline",
    "implementation_source": "inline",
    "resolution_reason": "inline",
    "needs": "tokenized",
    "owner": "inline",
    "recurrence": "inline",
    "regression": "inline",
    "resume_phase": "inline",
    "resume_transition_from": "inline",
    # T-1429: the deferred due instant is machine-routing truth -- a cold
    # worker must see DEFERRED/DUE without opening the externalized detail.
    # 20 characters, so inline costs the live line nothing.
    "retry_not_before": "inline",
    "review_passes": "inline",
    "source_receipts": "tokenized",
    "source_reports": "tokenized",
    "superseded_by": "inline",
    "supersession_authority": "inline",
    "supersession_evidence": "inline",
    "user_explicit": "inline",
    "verify": "compact",
    "verify_attempts": "inline",
    "weak_model": "inline",
}

#: Fields whose bounded value carries a semantic identifier and is therefore
#: reduced only toward `_MIN_CRITICAL_PART`, never dropped.
_CRITICAL_FIELDS = frozenset(
    {
        "blocker",
        "blocker_scope",
        "blocked_on",
        "closure_cohort",
        "closure_mode",
        "detail_ref",
        "external_authority",
        "external_evidence",
        "external_implementation",
        "needs",
        "resolution_reason",
        "resume_phase",
        "resume_transition_from",
        "review_passes",
        "source_receipts",
        "superseded_by",
        "supersession_authority",
        "supersession_evidence",
        "user_explicit",
        "verify",
        "verify_attempts",
    }
)


def validate_compaction_disposition(mapping: dict | None = None) -> dict:
    """Prove the disposition mapping is a closed, well-typed policy.

    Raises when a `KNOWN_FIELDS` member has no disposition, a disposition names
    a field the parser cannot produce, or a mode is outside `COMPACTION_MODES`.
    """
    policy = COMPACTION_DISPOSITION if mapping is None else mapping
    unknown = sorted(set(policy) - set(KNOWN_FIELDS))
    missing = sorted(set(KNOWN_FIELDS) - set(policy))
    if unknown:
        raise ValueError(f"compaction disposition names unknown BOARD fields: {unknown}")
    if missing:
        raise ValueError(f"compaction disposition is missing BOARD fields: {missing}")
    bad = sorted(name for name, mode in policy.items() if mode not in COMPACTION_MODES)
    if bad:
        raise ValueError(
            f"compaction disposition carries unknown modes for {bad}; "
            f"allowed: {sorted(COMPACTION_MODES)}"
        )
    return policy


#: A `KNOWN_FIELDS` addition with no authored disposition is a hard failure at
#: import, not a silent `inline` fall-through discovered on the next compaction.
validate_compaction_disposition()


#: The closed set of metadata shapes `resolve_detail` will accept as authority.
COMPACTION_OPERATION = "board_legacy_compaction"
COMPACTION_STATUS = "COMMITTED"

#: T-1326 TARGET B: a `supersedes_detail_ref` is an authority EDGE, so the
#: chain it forms is validated recursively, fail-closed. The bound is generous
#: (a real re-compaction history is short) and exists only so a pathological
#: chain cannot become unbounded work; a cycle is detected independently.
_MAX_SUPERSESSION_DEPTH = 64

#: T-1326 TARGET B (writer/reader agreement): the WRITER must never commit a
#: detail graph the READER immediately rejects. `_MAX_SUPERSESSION_DEPTH` alone
#: could not honour that -- successive oversized mutations kept succeeding until
#: one crossed the limit, committed, and made the very next resolve fail with a
#: chain-depth error, leaving Fleet BLOCKED with no repair. Long history is
#: therefore represented by a bounded LINEAGE CHECKPOINT manifest: a flat,
#: hash-anchored snapshot of the complete ancestry that TERMINATES automatic
#: traversal. The manifest is written into the SAME journaled plan as the
#: successor that declares it, so the graph is always readable at the instant it
#: becomes readable.
LINEAGE_CHECKPOINT_ROOT = ".saipen/recovery/board-compaction-lineage"
LINEAGE_CHECKPOINT_OPERATION = "board_legacy_compaction_lineage"
LINEAGE_CHECKPOINT_SCHEMA = 1
#: Maximum entries a checkpoint may carry -- the traversal bound.
_MAX_LINEAGE_ENTRIES = _MAX_SUPERSESSION_DEPTH
#: Ancestry length at which a successor attaches a checkpoint instead of
#: extending the raw chain further.
_CHECKPOINT_TRIGGER = _MAX_SUPERSESSION_DEPTH - 4


@dataclass(frozen=True)
class CompactionResult:
    board_text: str
    targets: tuple[TargetPlan, ...]
    detail_ref: str
    original_hash: str
    compacted_tickets: tuple[str, ...]


def _slug_ticket(ticket_id: str) -> str:
    if not re.fullmatch(r"T-\d+", ticket_id):
        raise ValueError(f"invalid BOARD compaction ticket id {ticket_id!r}")
    return ticket_id


def _record_bytes(board_text: str, line_no: int) -> bytes:
    lines = board_text.splitlines(keepends=True)
    if not 1 <= line_no <= len(lines):
        raise ValueError(f"BOARD compaction line {line_no} is outside BOARD.md")
    raw = lines[line_no - 1].encode("utf-8")
    if not raw.endswith((b"\n", b"\r")):
        raw += b"\n"
    return raw


#: Machine identifiers that must never be split by a character cut. A
#: truncated `T-20...`/`SRC-101...` is a FABRICATED identifier, not a shorter
#: one: every consumer that resolves it sees a token that names nothing.
_AUTHORITY_TOKEN_RE = re.compile(r"(?:T-\d+|SRC-\d+(?::R\d+)?|C-\d+|W-\d+|EV-\d+|BB-\d+)")

#: Structural delimiters a bounded prose cut may fall back to so a partial
#: list element or path fragment is never emitted.
_CUT_DELIMITERS = " ,;|"


def _short(value: str, limit: int) -> str:
    """Bound `value` to `limit` WITHOUT ever emitting a partial machine token.

    Regression (T-1326 escape): the old pure character slice could end a
    tokenized list at `T-202...` or a path mid-segment. The cut now snaps back
    to the start of an authority token it would have split, and to the previous
    structural delimiter otherwise, so no `T-`, `SRC-`, cohort, owner or path
    identifier is ever fabricated by truncation.
    """
    value = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(value) <= limit:
        return value
    cut = limit - 3
    if cut <= 0:
        return "..."
    for match in _AUTHORITY_TOKEN_RE.finditer(value):
        if match.start() < cut < match.end():
            cut = match.start()
            break
    if 0 < cut < len(value) and value[cut - 1] not in _CUT_DELIMITERS:
        boundary = max(
            value.rfind(" ", 0, cut),
            value.rfind(",", 0, cut),
            value.rfind(";", 0, cut),
            value.rfind("|", 0, cut),
        )
        if boundary > 0:
            cut = boundary
    return value[:cut].rstrip() + "..."


def _compact_verify(value: str, detail_ref: str) -> str:
    value = _short(value, _VERIFY_LIMIT)
    suffix = f" [detail_ref: {detail_ref}]"
    if value:
        return value + suffix
    return "legacy verification externalized" + suffix


def _compact_value(name: str, value: str, detail_ref: str) -> str | None:
    """The bounded projection of ONE field under its authored disposition."""
    mode = COMPACTION_DISPOSITION.get(name)
    if mode is None:
        raise ValueError(
            f"BOARD compaction has no disposition for field {name!r}; add an "
            f"explicit policy to COMPACTION_DISPOSITION before compacting"
        )
    if mode == "replaced":
        return None
    if mode == "compact":
        return _compact_verify(str(value), detail_ref)
    if mode == "tokenized":
        # Tokenized machine fields are reduced ONLY at token boundaries and,
        # because their identifiers are consumed exactly (dependency graph,
        # scheduler, intake/debt/source attribution), they are NEVER dropped to
        # satisfy the character cap. Every token the historical row carried is
        # re-emitted in full; the fitter below shrinks prose first and fails
        # loudly rather than clipping an identifier (T-1326 TARGET A).
        tokens = dict.fromkeys(re.findall(_TOKEN_PATTERNS[name], str(value or "")))
        return ", ".join(tokens)
    # inline / head: a bounded prefix. `head` keeps the leading class token
    # (`blocker_class` reads everything before the first ` -- `).
    return _short(str(value), _FIELD_LIMIT)


def _render_compact(tid: str, checkbox: str, parts: list, detail_ref: str) -> str:
    segments = [f"- [{checkbox}] {tid} {escape_ticket_description(parts[0][1])}"]
    for name, value in parts[1:]:
        segments.append(f"{name}: {escape_ticket_description(value)}")
    segments.append(f"detail_ref: {detail_ref}")
    return " | ".join(segments)


#: Tokenized fields whose identifiers are consumed INLINE and therefore may
#: never be reduced, only re-emitted in full: the dependency graph/scheduler
#: read `needs`, and intake/debt/source attribution reads `source_receipts`.
#: `closure_paths`/`source_reports` stay tokenized but MAY drop WHOLE tokens
#: (their complete list lives in the detail authority) -- never a partial one.
_NON_REDUCIBLE_TOKEN_FIELDS = frozenset({"needs", "source_receipts"})

_VERIFY_DETAIL_SUFFIX_RE = re.compile(r" \[detail_ref: [^\]]*\]$")


def _reducible_part(name: str) -> bool:
    """Whether a rendered part may be reduced to reach the cap.

    `needs`/`source_receipts` are INLINE authority and are never reduced. Every
    other field (description, verify, inline enums/counters, and the
    detail-backed tokenized lists) may shrink, but only at token/word
    boundaries via `_shrink_part`.
    """
    return name not in _NON_REDUCIBLE_TOKEN_FIELDS


def _shrink_part(name: str, value: str, target: int) -> str:
    """Reduce ONE rendered part to about `target`, never mid-identifier."""
    mode = COMPACTION_DISPOSITION.get(name)
    if mode == "tokenized":
        tokens = [token for token in value.split(", ") if token]
        if len(tokens) <= 1:
            return value
        while len(tokens) > 1 and len(", ".join(tokens)) > target:
            tokens.pop()
        return ", ".join(tokens)
    if name == "verify":
        match = _VERIFY_DETAIL_SUFFIX_RE.search(value)
        suffix = match.group(0) if match else ""
        head = value[: match.start()] if match else value
        room = max(_MIN_PART, target - len(suffix))
        return _short(head, room).rstrip() + suffix
    return _short(value, target)


def _fit_compact(tid: str, checkbox: str, parts: list, detail_ref: str) -> str:
    """Guarantee the compact projection satisfies `MAX_LIVE_RECORD_CHARS`.

    Reduction tightens the longest REDUCIBLE part first. Inline machine truth
    (`needs`, `source_receipts`) is never touched; detail-backed token lists
    drop WHOLE tokens only; the `verify` suffix path is preserved verbatim. If
    the required inline truth cannot be represented within the cap even after
    all prose is reduced to its floor, the fit refuses with an
    architecture-level diagnosis instead of emitting a partial identifier
    (T-1326 TARGET A).
    """
    line = _render_compact(tid, checkbox, parts, detail_ref)
    guard = 0
    frozen: set[int] = set()
    while len(line) > MAX_LIVE_RECORD_CHARS and len(parts) > 1 and guard < 100000:
        guard += 1
        candidates = [
            i
            for i in range(len(parts))
            if i not in frozen
            and _reducible_part(parts[i][0])
            and len(parts[i][1])
            > (_MIN_CRITICAL_PART if parts[i][0] in _CRITICAL_FIELDS else _MIN_PART)
        ]
        if not candidates:
            break
        idx = max(candidates, key=lambda i: len(parts[i][1]))
        name, value = parts[idx]
        floor = _MIN_CRITICAL_PART if name in _CRITICAL_FIELDS else _MIN_PART
        target = max(floor, int(len(value) * 0.6))
        if target >= len(value):
            target = len(value) - 1
        shrunk = _shrink_part(name, value, target)
        if shrunk == value:
            frozen.add(idx)
            continue
        parts[idx] = (name, shrunk)
        line = _render_compact(tid, checkbox, parts, detail_ref)
    if len(line) > MAX_LIVE_RECORD_CHARS:
        pinned = sorted(
            {
                name
                for name, _ in parts
                if COMPACTION_DISPOSITION.get(name) == "tokenized"
            }
        )
        raise ValueError(
            "BOARD compaction cannot represent required machine truth within "
            f"{MAX_LIVE_RECORD_CHARS} characters: exact tokenized value(s) "
            f"{pinned} must stay complete and no referenced representation "
            "exists for them. Refusing rather than emitting a partial "
            "identifier (T-1326 TARGET A)."
        )
    return line


def _compact_line(ticket: dict, detail_ref: str) -> str:
    """Project one ticket onto BOARD under the authored compaction policy.

    `value` is always the SEMANTIC scalar the parser already unescaped:
    escaping runs exactly once here, through the canonical owner, like every
    other BOARD writer -- never an ad-hoc pipe/backslash replacement.
    """
    tid = ticket["id"]
    checkbox = ticket.get("checkbox") or " "
    parts: list = [("description", _short(ticket.get("description", ""), _TITLE_LIMIT))]
    for name, value in (ticket.get("fields") or {}).items():
        rendered = _compact_value(name, value, detail_ref)
        if rendered is not None:
            parts.append((name, rendered))
    compact = _fit_compact(tid, checkbox, parts, detail_ref)
    assert_live_record(compact)
    return compact


def _artifact_paths(ticket_id: str, original_hash: str) -> tuple[str, str]:
    stem = f"{_slug_ticket(ticket_id)}-{original_hash[:24]}"
    return (
        f"{COMPACTION_ROOT}/{ticket_id}/{stem}.BOARD.md",
        f"{COMPACTION_ROOT}/{ticket_id}/{stem}.json",
    )


def _metadata(
    *,
    root: Path,
    ticket: dict,
    original: bytes,
    original_hash: str,
    record_path: str,
    metadata_path: str,
    op_id: str,
    event_id: str | None,
    reason: str,
    prior_detail_ref: str | None = None,
    checkpoint_ref: str | None = None,
    checkpoint_sha256: str | None = None,
) -> dict:
    metadata = {
        "schema_version": COMPACTION_SCHEMA,
        "operation": COMPACTION_OPERATION,
        "status": COMPACTION_STATUS,
        "ticket_id": ticket["id"],
        "project_identity": project_identity(root),
        "project_lineage": project_lineage_identity(root),
        "source": ".saipen/BOARD.md",
        "original_record_path": record_path,
        "original_record_sha256": original_hash,
        "original_record_bytes": len(original),
        "metadata_path": metadata_path,
        "supersedes_detail_ref": prior_detail_ref or "",
        "externalization_event": {
            "operation_id": op_id,
            "event_id": event_id,
            "reason": reason,
        },
        "lossless": True,
    }
    if checkpoint_ref:
        # The bounded representation of the ancestry BEYOND the immediate edge.
        # The immediate `supersedes_detail_ref` above is always the truthful,
        # cross-checked predecessor edge; this names the hash-anchored snapshot
        # that terminates automatic traversal.
        metadata["supersedes_checkpoint"] = checkpoint_ref
        metadata["supersedes_checkpoint_sha256"] = checkpoint_sha256 or ""
    return metadata


def _entry_for(root: Path, detail_ref: str, metadata: dict) -> dict:
    return {
        "detail_ref": detail_ref,
        "metadata_path": str(metadata.get("metadata_path") or ""),
        "original_record_path": str(metadata.get("original_record_path") or ""),
        "original_record_sha256": str(metadata.get("original_record_sha256") or ""),
        "original_record_bytes": int(metadata.get("original_record_bytes") or 0),
        "event_id": (metadata.get("externalization_event") or {}).get("event_id"),
        "supersedes_detail_ref": str(metadata.get("supersedes_detail_ref") or ""),
    }


def _entries_digest(entries: list[dict]) -> str:
    canonical = json.dumps(entries, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def gather_lineage(
    root: Path | str,
    detail_ref: str,
    ticket_id: str,
    *,
    _limit: int = _MAX_LINEAGE_ENTRIES,
) -> dict | None:
    """The bounded, ordered ancestry behind one detail reference.

    Returns None when the START reference is not (yet) on disk: a canonical
    mutation may externalize a row whose predecessor is an artifact the SAME
    journaled plan is about to create, and requiring it here would deadlock the
    repair. Any break MID-chain raises -- a chain that is already broken is a
    fail-closed refusal, never a silent shorter history.

    Traversal is bounded by `_limit` entries; a lineage that reaches the bound
    is reported as truncated with its named tail so the bound is DECLARED rather
    than silently applied. Cycles fail closed.
    """
    root = Path(root).resolve()
    cursor = str(detail_ref)
    seen: set[str] = set()
    entries: list[dict] = []
    truncated = False
    while cursor:
        if cursor in seen:
            raise ValueError(
                f"BOARD detail supersession cycle detected at {cursor}; "
                "historical authority is not a well-founded chain"
            )
        if len(entries) >= _limit:
            truncated = True
            break
        seen.add(cursor)
        try:
            metadata, _original, _digest = _verified_detail(
                root, cursor, expected_ticket_id=ticket_id
            )
        except (OSError, ValueError, UnicodeError) as exc:
            if not entries:
                # The plan may be creating this very artifact. Not a break.
                if not (root / cursor).is_file():
                    return None
            raise ValueError(
                f"BOARD detail predecessor {cursor} is not resolvable: {exc}"
            ) from exc
        entries.append(_entry_for(root, cursor, metadata))
        checkpoint = metadata.get("supersedes_checkpoint")
        if isinstance(checkpoint, str) and checkpoint.strip():
            snapshot = _verified_checkpoint(root, checkpoint.strip(), ticket_id)
            for entry in snapshot["entries"]:
                if len(entries) >= _limit:
                    truncated = True
                    break
                if entry.get("detail_ref") in seen:
                    continue
                seen.add(str(entry.get("detail_ref")))
                entries.append(entry)
            # The checkpoint TERMINATES traversal: it is the bounded authority
            # for everything behind the generation it anchored.
            cursor = ""
            continue
        cursor = str(metadata.get("supersedes_detail_ref") or "").strip()
    return {
        "entries": entries,
        "truncated": truncated,
        "tail_detail_ref": entries[-1]["supersedes_detail_ref"] if truncated else "",
    }


def checkpoint_plan(
    root: Path | str,
    ticket_id: str,
    lineage: dict,
    *,
    op_id: str,
    event_id: str | None,
) -> tuple[str, bytes, str]:
    """The deterministic lineage-checkpoint artifact for one ancestry."""
    root = Path(root).resolve()
    entries = list(lineage["entries"])
    payload = {
        "schema_version": LINEAGE_CHECKPOINT_SCHEMA,
        "operation": LINEAGE_CHECKPOINT_OPERATION,
        "status": COMPACTION_STATUS,
        "ticket_id": ticket_id,
        "project_identity": project_identity(root),
        "project_lineage": project_lineage_identity(root),
        "source": ".saipen/BOARD.md",
        "entry_count": len(entries),
        "max_entries": _MAX_LINEAGE_ENTRIES,
        "entries_digest": _entries_digest(entries),
        "truncated": bool(lineage["truncated"]),
        "tail_detail_ref": str(lineage["tail_detail_ref"]),
        "entries": entries,
        "externalization_event": {
            "operation_id": op_id,
            "event_id": event_id,
            "reason": (
                "supersession ancestry exceeds the bounded depth; "
                "flattened lossless checkpoint"
            ),
        },
        "lossless": True,
    }
    raw = (json.dumps(payload, sort_keys=True, indent=2) + "\n").encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    relative = f"{LINEAGE_CHECKPOINT_ROOT}/{ticket_id}/{ticket_id}-{digest[:24]}.json"
    owned_target_path(root, relative, kind="BOARD compaction lineage checkpoint")
    return relative, raw, digest


def event_id_for(event_id: "str | Mapping[str, str] | None", ticket_id: str) -> str | None:
    """The DEC event ONE ticket's artifact must name.

    T-1326 P2: a multi-row compaction emits one DEC per ticket, so a single
    `event_id` supplied to the whole plan cited the FIRST row's event on every
    artifact -- metadata that points at another ticket's decision. The plan now
    carries an explicit `ticket_id -> event_id` mapping, and a mapping that does
    not name the row under compaction is a hard refusal rather than a silent
    fallback to somebody else's event.
    """
    if event_id is None:
        return None
    if isinstance(event_id, str):
        return event_id
    if isinstance(event_id, Mapping):
        value = event_id.get(ticket_id)
        if value is None:
            raise ValueError(
                f"BOARD compaction plan names no DEC event for {ticket_id}; the "
                "detail artifact may not cite another ticket's event"
            )
        return str(value)
    raise ValueError(
        "BOARD compaction event_id must be a DEC event id, a ticket->event "
        f"mapping, or None (got {type(event_id).__name__})"
    )


def _one(
    root: Path,
    board_text: str,
    ticket_id: str,
    *,
    op_id: str,
    event_id: "str | Mapping[str, str] | None",
    reason: str,
    tolerated_ids: frozenset[str] | set[str] = frozenset(),
) -> tuple[str, tuple[TargetPlan, ...], str | None, str | None]:
    parsed = parse_board(board_text)
    tolerated = set(tolerated_ids)
    for error in parsed.get("errors", []):
        # Tolerate ONLY unknown-field errors on rows this SAME journaled plan
        # rewrites: compaction externalizes each such row's full physical bytes,
        # so the refused field is preserved losslessly. Every other fault --
        # including one on a row this plan does not rewrite -- is fatal, so a
        # named compaction can never leave a board that strict validation still
        # refuses (T-1326 TARGET C tolerates the WHOLE repairable set, never a
        # foreign ambiguity).
        if unrecognized_field_ticket(error) not in tolerated:
            raise ValueError("BOARD parse error(s): " + "; ".join(parsed["errors"][:3]))
    ticket = parsed["tickets"].get(ticket_id)
    if ticket is None:
        raise ValueError(f"{ticket_id} not on the board")
    raw = str(ticket["raw"])
    if len(raw) <= MAX_LIVE_RECORD_CHARS:
        return board_text, (), None, None
    prior_ref = str((ticket.get("fields") or {}).get("detail_ref") or "").strip() or None
    original = _record_bytes(board_text, ticket["line_no"])
    original_hash = hashlib.sha256(original).hexdigest()
    record_path, metadata_path = _artifact_paths(ticket_id, original_hash)
    owned_target_path(root, record_path, kind="BOARD compaction detail")
    owned_target_path(root, metadata_path, kind="BOARD compaction metadata")
    # T-1326 TARGET B: never commit a detail graph the READER would reject. Once
    # the ancestry behind this row reaches the trigger, the successor carries a
    # bounded lineage checkpoint instead of extending the raw chain toward the
    # depth limit that used to strand Fleet BLOCKED with no repair.
    lineage_targets: list[TargetPlan] = []
    checkpoint_ref = ""
    checkpoint_digest = ""
    if prior_ref:
        lineage = gather_lineage(root, prior_ref, ticket_id)
        if lineage is not None and len(lineage["entries"]) >= _CHECKPOINT_TRIGGER:
            checkpoint_ref, checkpoint_bytes, checkpoint_digest = checkpoint_plan(
                root, ticket_id, lineage, op_id=op_id, event_id=event_id
            )
            lineage_targets.append(
                TargetPlan(
                    checkpoint_ref,
                    "generic",
                    checkpoint_bytes,
                    "",
                    hash_bytes(checkpoint_bytes),
                )
            )
    metadata = _metadata(
        root=root,
        ticket=ticket,
        original=original,
        original_hash=original_hash,
        record_path=record_path,
        metadata_path=metadata_path,
        op_id=op_id,
        event_id=event_id_for(event_id, ticket_id),
        reason=reason,
        prior_detail_ref=prior_ref,
        checkpoint_ref=checkpoint_ref,
        checkpoint_sha256=checkpoint_digest,
    )
    metadata_bytes = (json.dumps(metadata, sort_keys=True, indent=2) + "\n").encode("utf-8")
    compact = _compact_line(ticket, metadata_path)
    lines = board_text.splitlines(keepends=True)
    suffix = "\n" if lines[ticket["line_no"] - 1].endswith("\n") else ""
    lines[ticket["line_no"] - 1] = compact + suffix
    return (
        "".join(lines),
        (
            TargetPlan(record_path, "generic", original, "", hash_bytes(original)),
            TargetPlan(metadata_path, "generic", metadata_bytes, "", hash_bytes(metadata_bytes)),
            *lineage_targets,
        ),
        metadata_path,
        original_hash,
    )


def prepare_existing(
    root: Path | str,
    board_text: str,
    ticket_ids: list[str] | tuple[str, ...],
    *,
    op_id: str,
    event_id: "str | Mapping[str, str] | None",
    reason: str,
    tolerated_ids: frozenset[str] | set[str] | None = None,
) -> CompactionResult:
    """Compact each requested oversized existing row exactly once.

    T-1326 TARGET C: this is the ONE shared entry every canonical BOARD
    mutation already passes through, so the detail-authority proof lives here.
    A row that points at a missing, malformed, tampered, wrong-project,
    wrong-lineage or foreign-ticket compaction record refuses the whole
    mutation instead of being treated as healthy.

    `tolerated_ids` is the complete set of refused-field rows this plan
    rewrites in the same transaction (defaults to the requested ids, the
    single-row case). Tolerating the whole set is what makes N>1 repairable
    rows reachable through one journaled operation.

    `event_id` is a DEC event id, or -- for a multi-row plan, where the caller
    emits ONE DEC per ticket -- the explicit `ticket_id -> event_id` mapping, so
    every artifact names its OWN ticket's event (T-1326 P2).
    """
    root = Path(root).resolve()
    broken = detail_integrity_error(root, board_text, ticket_ids)
    if broken:
        raise ValueError(
            "BOARD compact record has no reachable detail authority -- " + broken
        )
    tolerated = frozenset(ticket_ids) if tolerated_ids is None else frozenset(tolerated_ids)
    current = board_text
    targets: list[TargetPlan] = []
    refs: list[str] = []
    hashes: list[str] = []
    compacted: list[str] = []
    for ticket_id in dict.fromkeys(ticket_ids):
        current, extra, ref, digest = _one(
            root,
            current,
            ticket_id,
            op_id=op_id,
            event_id=event_id,
            reason=reason,
            tolerated_ids=tolerated,
        )
        targets.extend(extra)
        if ref:
            refs.append(ref)
            hashes.append(digest or "")
            compacted.append(ticket_id)
    return CompactionResult(
        current,
        tuple(targets),
        refs[0] if refs else "",
        hashes[0] if hashes else "",
        tuple(compacted),
    )


def prepare_expanded(
    root: Path | str,
    board_text: str,
    ticket_ids: list[str] | tuple[str, ...],
    *,
    op_id: str,
    event_id: "str | Mapping[str, str] | None",
    reason: str,
) -> CompactionResult:
    """Externalize rows that are oversized in THIS (proposed) board text.

    T-1326 TARGET B: a normal row can cross the live cap BECAUSE of a requested
    mutation, not merely before it. This mirrors `prepare_existing` but skips
    the pre-existing detail-edge integrity precheck: the prior artifact a
    proposed row names may be one this SAME journaled plan is about to create,
    so requiring it to resolve on disk would deadlock the very repair. The
    complete PROPOSED bytes become the new lossless authority, and any prior
    `detail_ref` the proposed row carried is recorded as the supersession
    parent on the successor metadata -- a deterministic chain, never an
    in-place overwrite of historical bytes.
    """
    root = Path(root).resolve()
    current = board_text
    targets: list[TargetPlan] = []
    refs: list[str] = []
    hashes: list[str] = []
    compacted: list[str] = []
    for ticket_id in dict.fromkeys(ticket_ids):
        current, extra, ref, digest = _one(
            root,
            current,
            ticket_id,
            op_id=op_id,
            event_id=event_id,
            reason=reason,
        )
        targets.extend(extra)
        if ref:
            refs.append(ref)
            hashes.append(digest or "")
            compacted.append(ticket_id)
    return CompactionResult(
        current,
        tuple(targets),
        refs[0] if refs else "",
        hashes[0] if hashes else "",
        tuple(compacted),
    )


def prepare_new(
    root: Path | str,
    record: str,
    ticket_id: str,
    *,
    priority: str,
    description: str,
    needs: list[str],
    verify: str,
    op_id: str,
    event_id: str,
) -> CompactionResult:
    """Externalize a new record before it is projected onto BOARD.

    `record` is the FULL serialized BOARD record (already escaped) and stays the
    externalized byte authority. `description`/`verify` are the SEMANTIC
    (redacted, unescaped) scalars: the compact projection serializes each of
    them exactly once, through `_compact_line`. Passing pre-escaped text here
    double-escapes literal pipe/backslash content (T-1326 TARGET D).
    """
    if len(record) <= MAX_LIVE_RECORD_CHARS:
        return CompactionResult(record + "\n", (), "", "", ())
    root = Path(root).resolve()
    original = (record + "\n").encode("utf-8")
    original_hash = hashlib.sha256(original).hexdigest()
    record_path, metadata_path = _artifact_paths(ticket_id, original_hash)
    owned_target_path(root, record_path, kind="BOARD compaction detail")
    owned_target_path(root, metadata_path, kind="BOARD compaction metadata")
    ticket = {
        "id": ticket_id,
        "checkbox": " ",
        "description": f"[{priority}] {description}",
        "fields": {"needs": ",".join(needs), "verify": verify},
    }
    metadata = _metadata(
        root=root,
        ticket=ticket,
        original=original,
        original_hash=original_hash,
        record_path=record_path,
        metadata_path=metadata_path,
        op_id=op_id,
        event_id=event_id,
        reason="new BOARD record exceeds the live cap; canonical writer externalized detail",
    )
    metadata_bytes = (json.dumps(metadata, sort_keys=True, indent=2) + "\n").encode("utf-8")
    compact = _compact_line(ticket, metadata_path) + "\n"
    return CompactionResult(
        compact,
        (
            TargetPlan(record_path, "generic", original, "", hash_bytes(original)),
            TargetPlan(metadata_path, "generic", metadata_bytes, "", hash_bytes(metadata_bytes)),
        ),
        metadata_path,
        original_hash,
        (ticket_id,),
    )


_UNRECOGNIZED_FIELD_RE = re.compile(
    r"BOARD\.md:\d+ ticket (T-\d+) has unrecognized field "
)


def unrecognized_field_ticket(error: str) -> str | None:
    """The ticket id of a TOLERATED unknown-field error, else None.

    `unrecognized field` is the only parse error whose record can be repaired
    losslessly by compaction: the field is outside the closed grammar, so no
    KNOWN authority is silently chosen from it, and the complete physical line
    (field included) is journaled verbatim into the detail authority before the
    projection is rewritten. Every other error class -- duplicate field,
    embedded ticket, wrong section, detached continuation, heading fault -- is
    an AMBIGUITY about what the record MEANS and stays fatal (fail closed).
    """
    match = _UNRECOGNIZED_FIELD_RE.match(error)
    return match.group(1) if match else None


def oversized_ticket_ids(board_text: str) -> list[str]:
    parsed = parse_board(board_text)
    tolerated: set[str] = set()
    for error in parsed.get("errors", []):
        ticket_id = unrecognized_field_ticket(error)
        if ticket_id is None or ticket_id not in parsed["tickets"]:
            return []
        tolerated.add(ticket_id)
    oversized = [
        ticket_id
        for ticket_id, ticket in parsed["tickets"].items()
        if len(str(ticket.get("raw", ""))) > MAX_LIVE_RECORD_CHARS
    ]
    # T-1326 TARGET C: ONE canonical BOARD compaction now rewrites EVERY
    # repairable oversized row in a single journaled operation, so N>1
    # refused-field rows are reachable instead of each naming a command that
    # the other row's parse error would refuse (the false dead end). The path
    # stays strictly bounded: a refused field on a row compaction will NOT
    # rewrite (a small foreign/skew row) leaves no canonical path at all, so
    # the operator surface names nothing rather than a command that would
    # refuse.
    if tolerated - set(oversized):
        return []
    return oversized


def _require(condition: object, message: str) -> None:
    if not condition:
        raise ValueError(message)


def carried_detail_ref(original: bytes, ticket_id: str) -> str:
    """The `detail_ref` the EXTERNALIZED original row itself carried, or "".

    T-1326 TARGET B: `metadata.supersedes_detail_ref` alone is NOT topology
    authority. It is a CLAIM the writer makes about a predecessor edge, and a
    claim nothing cross-checks can be blanked, substituted or deleted while the
    successor still resolves -- severing history silently. The externalized
    original row is the immutable counter-witness: it is the exact physical
    BOARD line this artifact was created from, so the `detail_ref` IT carried is
    the edge the successor must declare.

    Read with the SAME parser the live board uses, tolerating exactly the one
    error class compaction exists to repair (a refused unknown field, whose bytes
    are preserved wholesale). Any other parse fault means the original record
    cannot be interpreted -- fail closed rather than assume the edge was absent.
    """
    try:
        text = original.decode("utf-8")
    except UnicodeError as exc:  # pragma: no cover - writer emits UTF-8
        raise ValueError(
            f"BOARD detail original record is not decodable UTF-8: {exc}"
        ) from exc
    parsed = parse_board(
        "## DOING\n" + text.rstrip("\n") + "\n## TODO\n## DONE\n## BLOCKED\n"
    )
    for error in parsed.get("errors", []):
        if unrecognized_field_ticket(error) != ticket_id:
            raise ValueError(
                "BOARD detail original record cannot be interpreted as its own "
                f"ticket's record: {error}"
            )
    ticket = parsed["tickets"].get(ticket_id)
    if ticket is None:
        raise ValueError(
            "BOARD detail original record does not name its own ticket "
            f"({ticket_id}); its supersession edge cannot be proven"
        )
    value = (ticket.get("fields") or {}).get("detail_ref")
    _require(
        value is None or isinstance(value, str),
        f"BOARD detail original record carries a malformed detail_ref {value!r}",
    )
    return str(value or "").strip()


def _verified_detail(
    root: Path,
    detail_ref: str,
    *,
    expected_ticket_id: str | None = None,
) -> tuple[dict, bytes, str]:
    """Prove ONE artifact: schema, identity, project, hash and byte count.

    No supersession traversal happens here; both `resolve_detail` (which owns
    the edge rules) and `gather_lineage` (which must stay bounded) consume this
    single verification so the proofs can never diverge.
    """
    owned_target_path(root, detail_ref, kind="BOARD compaction metadata")
    metadata_path = (root / detail_ref).resolve()
    if not metadata_path.is_file() or metadata_path.is_symlink():
        raise ValueError(
            f"BOARD detail metadata is missing or not a regular file: {detail_ref}"
        )
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ValueError(f"BOARD detail metadata is malformed: {detail_ref}: {exc}") from exc
    if not isinstance(metadata, dict):
        raise ValueError(f"BOARD detail metadata is malformed (not an object): {detail_ref}")
    _require(
        metadata.get("schema_version") == COMPACTION_SCHEMA,
        f"BOARD detail metadata declares unsupported compaction schema "
        f"{metadata.get('schema_version')!r}, expected {COMPACTION_SCHEMA}",
    )
    _require(
        metadata.get("operation") == COMPACTION_OPERATION,
        f"BOARD detail metadata declares unsupported compaction operation "
        f"{metadata.get('operation')!r}, expected {COMPACTION_OPERATION!r}",
    )
    _require(
        metadata.get("status") == COMPACTION_STATUS,
        f"BOARD detail metadata declares unsupported compaction status "
        f"{metadata.get('status')!r}, expected {COMPACTION_STATUS!r}",
    )
    _require(
        metadata.get("lossless") is True,
        "BOARD detail metadata does not declare a lossless externalization",
    )
    ticket_id = metadata.get("ticket_id")
    _require(
        isinstance(ticket_id, str) and re.fullmatch(r"T-\d+", ticket_id),
        f"BOARD detail metadata is malformed: ticket identity {ticket_id!r}",
    )
    if expected_ticket_id is not None and ticket_id != expected_ticket_id:
        raise ValueError(
            f"BOARD detail metadata at {detail_ref} belongs to another ticket "
            f"({ticket_id}, expected {expected_ticket_id})"
        )
    _require(
        metadata.get("project_identity") == project_identity(root),
        "BOARD detail project identity mismatch",
    )
    _require(
        metadata.get("project_lineage") == project_lineage_identity(root),
        "BOARD detail project lineage mismatch",
    )
    record_ref = metadata.get("original_record_path")
    if not isinstance(record_ref, str) or not record_ref:
        raise ValueError("BOARD detail original record path is missing from the metadata")
    owned_target_path(root, record_ref, kind="BOARD compaction detail")
    record_path = (root / record_ref).resolve()
    if not record_path.is_file() or record_path.is_symlink():
        raise ValueError(
            f"BOARD detail original record is missing or not a regular file: {record_ref}"
        )
    try:
        original = record_path.read_bytes()
    except OSError as exc:
        raise ValueError(
            f"BOARD detail original record is unreadable: {record_ref}: {exc}"
        ) from exc
    digest = hashlib.sha256(original).hexdigest()
    _require(
        digest == metadata.get("original_record_sha256"),
        f"BOARD detail original record hash mismatch at {record_ref}",
    )
    _require(
        len(original) == metadata.get("original_record_bytes"),
        f"BOARD detail original record byte count mismatch at {record_ref} "
        f"({len(original)} on disk, {metadata.get('original_record_bytes')!r} declared)",
    )
    return metadata, original, digest


def _verified_checkpoint(root: Path, checkpoint_ref: str, ticket_id: str) -> dict:
    """Prove ONE bounded lineage checkpoint and its own entry digest."""
    owned_target_path(root, checkpoint_ref, kind="BOARD compaction lineage checkpoint")
    path = (root / checkpoint_ref).resolve()
    if not path.is_file() or path.is_symlink():
        raise ValueError(
            f"BOARD detail lineage checkpoint is missing or not a regular file: {checkpoint_ref}"
        )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ValueError(
            f"BOARD detail lineage checkpoint is malformed: {checkpoint_ref}: {exc}"
        ) from exc
    _require(
        isinstance(payload, dict),
        f"BOARD detail lineage checkpoint is malformed (not an object): {checkpoint_ref}",
    )
    _require(
        payload.get("schema_version") == LINEAGE_CHECKPOINT_SCHEMA,
        "BOARD detail lineage checkpoint declares unsupported schema "
        f"{payload.get('schema_version')!r}, expected {LINEAGE_CHECKPOINT_SCHEMA}",
    )
    _require(
        payload.get("operation") == LINEAGE_CHECKPOINT_OPERATION,
        "BOARD detail lineage checkpoint declares unsupported operation "
        f"{payload.get('operation')!r}, expected {LINEAGE_CHECKPOINT_OPERATION!r}",
    )
    _require(
        payload.get("status") == COMPACTION_STATUS and payload.get("lossless") is True,
        "BOARD detail lineage checkpoint does not declare a committed lossless snapshot",
    )
    _require(
        payload.get("ticket_id") == ticket_id,
        "BOARD detail lineage checkpoint belongs to another ticket "
        f"({payload.get('ticket_id')!r}, expected {ticket_id})",
    )
    _require(
        payload.get("project_identity") == project_identity(root)
        and payload.get("project_lineage") == project_lineage_identity(root),
        "BOARD detail lineage checkpoint project identity/lineage mismatch",
    )
    entries = payload.get("entries")
    _require(
        isinstance(entries, list) and all(isinstance(e, dict) for e in entries),
        "BOARD detail lineage checkpoint carries a malformed entry list",
    )
    _require(
        len(entries) <= _MAX_LINEAGE_ENTRIES,
        "BOARD detail lineage checkpoint exceeds the bounded entry count "
        f"{_MAX_LINEAGE_ENTRIES}",
    )
    _require(
        payload.get("entry_count") == len(entries),
        "BOARD detail lineage checkpoint entry count disagrees with its entry list",
    )
    _require(
        payload.get("entries_digest") == _entries_digest(entries),
        "BOARD detail lineage checkpoint entry digest mismatch -- its ancestry was rewritten",
    )
    refs = [str(entry.get("detail_ref") or "") for entry in entries]
    _require(
        all(refs) and len(set(refs)) == len(refs),
        "BOARD detail lineage checkpoint names a missing or duplicated ancestor",
    )
    # The snapshot is an ORDERED ancestry: each entry must supersede the next one
    # exactly. A dropped or reordered middle entry cannot be hidden.
    for position, entry in enumerate(entries[:-1]):
        _require(
            str(entry.get("supersedes_detail_ref") or "") == refs[position + 1],
            "BOARD detail lineage checkpoint ancestry is not contiguous at "
            f"{refs[position]}: declares "
            f"{entry.get('supersedes_detail_ref')!r}, snapshot continues with "
            f"{refs[position + 1]!r}",
        )
    return payload


def resolve_detail(
    root: Path | str,
    detail_ref: str,
    *,
    expected_ticket_id: str | None = None,
    _seen: set[str] | None = None,
) -> dict:
    """Resolve and verify one canonical detail reference.

    T-1326 TARGET C: a compact BOARD row's `detail_ref` is an AUTHORITY EDGE,
    not a decorative pointer. This proves the metadata is the expected
    compaction record for the expected ticket in the expected project, and that
    the externalized original bytes are still exactly the bytes that were
    compacted. Every failure names the broken detail authority; none of them
    reconstructs missing historical bytes from the compact projection.

    T-1326 TARGET B: `supersedes_detail_ref` is the SAME kind of authority
    edge. When present it is resolved RECURSIVELY and fail-closed -- the whole
    historical chain must be intact before the current row's truth is accepted.
    A supersession is never claimed losslessly while a predecessor's metadata
    or original bytes are missing. Cycles are detected and bounded.

    T-1326 TARGET B (bounded long history): when the metadata names a
    `supersedes_checkpoint`, that hash-anchored snapshot IS the authority for the
    ancestry behind the immediate predecessor, so traversal stops there instead
    of walking an unbounded chain. Every ancestor the snapshot names is verified,
    at its declared hash and byte count, as a LEAF -- and the immediate edge is
    still proven against the immediate predecessor.
    """
    root = Path(root).resolve()
    seen = set() if _seen is None else _seen
    reference = str(detail_ref)
    if reference in seen:
        raise ValueError(
            f"BOARD detail supersession cycle detected at {reference}; "
            "historical authority is not a well-founded chain"
        )
    if len(seen) >= _MAX_SUPERSESSION_DEPTH:
        raise ValueError(
            "BOARD detail supersession chain exceeds the bounded depth "
            f"{_MAX_SUPERSESSION_DEPTH}"
        )
    seen.add(reference)
    return _resolve_detail_seen(root, reference, expected_ticket_id, seen)


def _resolve_detail_seen(
    root: Path,
    reference: str,
    expected_ticket_id: str | None,
    seen: set[str],
) -> dict:
    metadata, original, digest = _verified_detail(
        root, reference, expected_ticket_id=expected_ticket_id
    )
    ticket_id = str(metadata["ticket_id"])
    record_ref = str(metadata["original_record_path"])
    # Recursive supersession-authority check (T-1326 TARGET B). The predecessor
    # is validated with the SAME ticket/project/lineage/schema/operation/status
    # and hash+byte proofs by re-entering this function; `expected_ticket_id`
    # forces every predecessor onto the same ticket. Fail-closed: a broken
    # predecessor raises here instead of letting a lossless-supersession claim
    # stand over missing history.
    #
    # T-1326 TARGET B (falsified topology): the metadata's claim is CROSS-CHECKED
    # against the externalized original row before it is trusted. Blanking the
    # claim, deleting the predecessor, pointing at a substituted artifact or
    # typing the field as something other than a path all fail closed, so a
    # successor can never silently sever the history it supersedes.
    #
    # T-1331 backward compatibility: a legacy pre-supersession artifact was
    # written before the edge existed, so the key is ABSENT -- not present with
    # an empty value. An absent key therefore declares the empty predecessor
    # (a genuine first generation), while a PRESENT key of any non-string type
    # (explicit null, integer, list, object) is malformed/forged modern metadata
    # and stays fail-closed. `metadata.get(...)` alone conflated the two.
    if "supersedes_detail_ref" not in metadata:
        declared = ""
    else:
        prior_ref = metadata.get("supersedes_detail_ref")
        _require(
            isinstance(prior_ref, str),
            "BOARD detail metadata declares a non-string supersession edge "
            f"{prior_ref!r}; the predecessor of a lossless successor must be named",
        )
        declared = prior_ref.strip()
    carried = carried_detail_ref(original, ticket_id)
    _require(
        declared == carried,
        "BOARD detail supersession edge disagrees with the externalized original "
        f"record at {record_ref}: metadata declares {declared!r}, the original row "
        f"carried {carried!r} -- the successor's history is not proven",
    )
    checkpoint = metadata.get("supersedes_checkpoint")
    if isinstance(checkpoint, str) and checkpoint.strip():
        snapshot = _verified_checkpoint(root, checkpoint.strip(), ticket_id)
        recorded = metadata.get("supersedes_checkpoint_sha256")
        _require(
            isinstance(recorded, str) and recorded,
            "BOARD detail metadata names a lineage checkpoint without its hash",
        )
        raw = (root / checkpoint.strip()).read_bytes()
        _require(
            hashlib.sha256(raw).hexdigest() == recorded,
            f"BOARD detail lineage checkpoint hash mismatch at {checkpoint.strip()}",
        )
        entries = snapshot["entries"]
        head = entries[0] if entries else {}
        _require(
            str(head.get("detail_ref") or "") == declared,
            "BOARD detail lineage checkpoint does not anchor the immediate "
            f"predecessor {declared!r}: its first entry is "
            f"{head.get('detail_ref')!r}",
        )
        # Bounded traversal: every named ancestor is verified as a leaf at its
        # declared hash, byte count and ticket identity. The snapshot is the
        # authority for the ancestry, so no ancestor's own edge is walked here.
        ancestors = []
        for entry in entries:
            ancestor_ref = str(entry["detail_ref"])
            ancestor, ancestor_original, ancestor_digest = _verified_detail(
                root, ancestor_ref, expected_ticket_id=ticket_id
            )
            _require(
                ancestor_digest == entry["original_record_sha256"]
                and len(ancestor_original) == entry["original_record_bytes"],
                f"BOARD detail lineage checkpoint ancestor {ancestor_ref} does not "
                "match the snapshot's declared bytes",
            )
            ancestors.append({"detail_ref": ancestor_ref, "metadata": ancestor})
        return {
            "metadata": metadata,
            "original_record": original,
            "sha256": digest,
            "supersedes_detail_ref": declared,
            "lineage_checkpoint": checkpoint.strip(),
            "lineage": ancestors,
        }
    if declared:
        _resolve_detail_seen(root, declared, ticket_id, seen)
    return {
        "metadata": metadata,
        "original_record": original,
        "sha256": digest,
        "supersedes_detail_ref": declared,
        "lineage_checkpoint": "",
        "lineage": [],
    }


def detail_integrity_error(
    root: Path | str, board_text: str, ticket_ids: list[str] | tuple[str, ...]
) -> str | None:
    """Name the broken detail authority for any named compacted ticket.

    Returns None when every named ticket either carries no `detail_ref` or
    carries one that resolves to its own intact, lossless compaction record.
    Read-only: it never writes, repairs, or fabricates bytes.
    """
    try:
        parsed = parse_board(board_text)
    except (ValueError, UnicodeError) as exc:  # pragma: no cover - parser is total
        return str(exc)
    for ticket_id in dict.fromkeys(ticket_ids):
        ticket = parsed["tickets"].get(ticket_id)
        if ticket is None:
            continue
        ref = str((ticket.get("fields") or {}).get("detail_ref") or "").strip()
        if not ref:
            continue
        try:
            resolve_detail(root, ref, expected_ticket_id=ticket_id)
        except (OSError, ValueError, UnicodeError) as exc:
            return f"{ticket_id}: {exc}"
    return None


def compacted_ticket_ids(board_text: str) -> list[str]:
    """Every BOARD row whose truth now lives behind a compaction reference."""
    parsed = parse_board(board_text)
    if parsed.get("errors"):
        return []
    return [
        ticket_id
        for ticket_id, ticket in parsed["tickets"].items()
        if str((ticket.get("fields") or {}).get("detail_ref") or "").strip()
    ]
