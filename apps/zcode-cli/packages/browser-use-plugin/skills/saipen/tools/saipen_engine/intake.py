"""Lossless source receipts (T-1162, INC-LOSSY-WORK-SUMMARY-001).

A large user audit must survive model switches, context loss, session death
and cold continuation WITHOUT being reduced to a lossy BOARD summary. The
law (CORE § 1.10): PRESERVE THE SOURCE BEFORE INTERPRETING THE SOURCE;
BOARD MAY SUMMARIZE INTENT, BOARD MUST NEVER BE THE ONLY SURVIVING COPY OF
DETAILED INTENT.

Storage (all under ``.saipen/intake/``):

    active/SRC-###.md        immutable verbatim source body
    active/SRC-###.meta.json metadata sidecar (digest, kind, status, work)
    coverage/SRC-###.json    coverage ledger (requirement -> disposition)
    tombstones/SRC-###.json  small closed record (no body)
    ../archive/source/SRC-###.md+.meta cold body + metadata (excluded from hot scans)
    index.json               active + tombstone projection (rebuildable)

Invariants:

- SOURCE IS DATA. The body is opaque content during capture and is never
  routed as a command (a source containing "saipen ship" must not ship).
- DURABILITY PRECEDES INTERPRETATION: body + digest are written BEFORE any
  Work linkage commits.
- receipt_id is stable protocol identity; source_sha256 is content identity.
- EXACT canonical digest dedupes; near-duplicate is a new source; amendments
  are new immutable receipts linked ``amends``.
- CLOSED requires full terminal disposition on every actionable requirement
  (coverage ledger), never merely a green parent ticket.
- Integrity check recomputes the body digest; mismatch fails closed.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import codec
from .distribution import (
    DISTRIBUTABLE,
    QUARANTINED,
    distribution_record_rel,
    quarantine_body_rel,
)
from .journal import _atomic_write, owned_target_path
from .lock import project_writer_lock
from .paths import (
    prove_owned_dir_chain,
    prove_owned_regular,
    read_bound_regular_bytes,
    safe_unlink_owned,
)

ACTIVE_STATUS = "ACTIVE"
CLOSED_STATUS = "CLOSED"
SUPERSEDED_STATUS = "SUPERSEDED"
INVALID_STATUS = "INVALID"
ARCHIVED_STATUS = "ARCHIVED"

STATUSES = (ACTIVE_STATUS, CLOSED_STATUS, SUPERSEDED_STATUS, INVALID_STATUS)

SOURCE_KINDS = (
    "user_audit",
    "user_instruction",
    "implementation_mission",
    "review_handoff",
    "external_audit",
    "imported_spec",
    "corrective_followup",
)

#: What capturing this Source produces (T-1414). `work` is the historical
#: behaviour: callers may project the receipt as Work. `authority_only` marks
#: bytes that exist to GRANT something (an operator retirement decision): they
#: persist with full authority and NEVER project Work, a ticket, a goal or an
#: Improve cycle. The policy is typed data on the receipt, not a title prefix.
PROJECTION_POLICIES = ("work", "authority_only")
PROJECTION_WORK = "work"
PROJECTION_AUTHORITY_ONLY = "authority_only"

INTENT_RE = re.compile(r"^(SRC-\d+)$")

# Requirement clause classes (agent-normalized, recorded durably).
CLAUSE_CLASSES = (
    "requirement",
    "invariant",
    "non-goal",
    "acceptance-criterion",
    "context",
    "example",
    "rationale",
    "open-question",
)

# Dispositions (terminal = enough evidence to close the source).
TERMINAL_DISPOSITIONS = {
    "IMPLEMENTED",
    "VERIFIED",
    "REJECTED",
    "DUPLICATE",
    "SUPERSEDED",
    "NOT_APPLICABLE",
    "UNAVAILABLE_ENVIRONMENT",
}
ALL_DISPOSITIONS = TERMINAL_DISPOSITIONS | {"BLOCKED", "DEFERRED", "UNKNOWN"}
ACTIONABLE_CLASSES = {
    "requirement",
    "invariant",
    "non-goal",
    "acceptance-criterion",
    "open-question",
}

SCHEMA_VERSION = 1
INDEX_FIELDS = ("schema_version", "next_id", "active", "tombstones")


def capture_worthy(body: str, *, source_kind: str | None = None, explicit: bool = False) -> dict:
    """Bounded intake classification; length alone can never force capture."""
    if explicit:
        return {"capture_required": True, "reason": "explicit"}
    if source_kind in set(SOURCE_KINDS) - {"user_instruction"}:
        return {"capture_required": True, "reason": f"source_kind:{source_kind}"}
    text = body if isinstance(body, str) else ""
    heading = bool(
        re.search(
            r"(?im)^\s*(?:#{1,6}\s*)?(?:audit|mission|implementation mission|"
            r"implementation handoff|"
            r"review handoff|requirements?|acceptance criteria|specification)\b",
            text,
        )
    )
    sections = len(re.findall(r"(?m)^\s*(?:#{1,6}\s+|\d+[.)]\s+)", text))
    conditions = len(
        re.findall(
            r"(?i)\b(?:must|must not|required|expected|acceptance|invariant|"
            r"do not|never|always|verify|test)\b",
            text,
        )
    )
    required = heading and sections >= 2 and conditions >= 3
    return {
        "capture_required": required,
        "reason": "recognized-high-information-workflow" if required else "ordinary-input",
        "signals": {"heading": heading, "sections": sections, "conditions": conditions},
    }


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _agent_for_intake(root: Path | None = None) -> str:
    """The acting seat recorded in the current project STATE, or the default.

    Used to bind journaled source mutations (CORE-001) to the same agent the
    rest of the protocol attributes them to. Never raises: an unreadable or
    malformed STATE is not a reason to refuse a source transaction.
    """
    try:
        from .state import parse_state

        state_path = (root or Path(".")).resolve() / ".saipen" / "STATE.md"
        if state_path.is_file():
            state = parse_state(state_path.read_text(encoding="utf-8-sig"))
            agent = state.get("agent")
            if agent:
                return agent
    except Exception:
        pass
    return "saipen-autonomous"


def _json_bytes(value: dict) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _looks_sensitive(text: str) -> bool:
    """Conservative metadata signal; never redacts or echoes the source."""
    return bool(
        re.search(
            r"(?im)\b(?:api[_-]?key|access[_-]?token|token|password|secret)\b\s*[:=]\s*(?!<redacted>|\*{3})\S+",
            text,
        )
    )


_CREDENTIAL_ASSIGNMENT_RE = re.compile(
    r"(?im)(\b(?:api[_-]?key|access[_-]?token|token|password|secret)\b\s*[:=]\s*)\S+"
)


def _redact_text(text: str) -> str:
    """Mask credential-looking assignments in a body for DISPLAY/EXPORT only.

    CORE-001: this is a derived, explicitly non-authoritative view. Two
    byte-distinct sources mask to identical text (`token = A` and `token = B`
    both become `token = <redacted>`), so anything hashed or deduplicated over
    this value is not source identity. Only `capture` writes canonical bytes,
    and it never calls this function.
    """
    masked = codec.redact_credentials(text)
    return _CREDENTIAL_ASSIGNMENT_RE.sub(r"\1<redacted>", masked)


def _redacted_derivative(text: str) -> tuple[str, dict]:
    """Build an explicitly NON-authoritative masked copy of an exact body."""
    masked = _redact_text(text)
    return masked, {
        "applied": masked != text,
        "authoritative": False,
        "original_sha256": _sha256(text),
        "sanitized_sha256": _sha256(masked),
    }


def _source_authority(meta: dict) -> dict:
    """Project how a receipt's stored bytes relate to the original source.

    A receipt captured before CORE-001 stored a redacted DERIVATIVE as its
    body. Its `original_sha256` is then a fact about bytes that exist nowhere
    -- a digest over a body that was discarded -- not a recoverable copy. This
    projection states that instead of letting a caller silently treat the
    derivative as authority.
    """
    digest = meta.get("source_sha256")
    redaction = meta.get("redaction")
    applied = isinstance(redaction, dict) and redaction.get("applied") is True
    if applied:
        return {
            "mode": "redacted-derivative",
            "original_available": False,
            "body_sha256": digest,
            "original_sha256": redaction.get("original_sha256"),
            "note": (
                "stored bytes are a redacted derivative; the original body was "
                "not retained and cannot be reconstructed from original_sha256"
            ),
        }
    return {
        "mode": "exact",
        "original_available": True,
        "body_sha256": digest,
        "original_sha256": digest,
    }


def _exact_authority_record(digest: str) -> tuple[dict, dict]:
    """Redaction + authority records for a capture that stored exact bytes.

    Nothing was masked, so the "sanitized" digest deliberately coincides with
    the canonical digest: it asserts `redact(body) == body`, which the release
    gate re-checks, rather than claiming a second body exists.
    """
    redaction = {
        "applied": False,
        "authoritative": False,
        "original_sha256": digest,
        "sanitized_sha256": digest,
    }
    authority = {
        "mode": "exact",
        "original_available": True,
        "body_sha256": digest,
    }
    return redaction, authority


def _is_link_or_reparse(path: Path) -> bool:
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return os.path.islink(path) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _safe_path(root: Path, rel: str, *, expect_file: bool = False) -> Path:
    """Resolve one project-owned intake path without following hostile nodes."""
    path = owned_target_path(root, rel, kind="source-receipt")
    current = root
    for part in Path(rel).parts[:-1]:
        current = current / part
        if current.exists() and (_is_link_or_reparse(current) or not current.is_dir()):
            raise ValueError(f"unsafe source-receipt container: {current}")
    if path.exists():
        info = os.lstat(path)
        if _is_link_or_reparse(path) or (expect_file and not stat.S_ISREG(info.st_mode)):
            raise ValueError(f"unsafe source-receipt node: {path}")
    return path


# Bounded ownership-safe read caps for every intake authority file. These are
# generous safety ceilings (far above any legitimate receipt) so a hostile or
# corrupted authority can never force an unbounded descriptor read.
_INDEX_MAX = 4 * 1024 * 1024
_META_MAX = 1024 * 1024
_LEDGER_MAX = 8 * 1024 * 1024
_BODY_MAX = 64 * 1024 * 1024
_BOARD_MAX = 8 * 1024 * 1024


def _read_owned_file(
    root: Path, rel: str, *, kind: str = "source authority", max_bytes: int
) -> bytes:
    """Bounded ownership-safe read of ONE project-owned authority file.

    This is the single reader every intake READ path routes through (CORE-002):
    index, active metadata/body, Contract, coverage, tombstones, archive
    metadata/body, and the BOARD state consulted by intake.

    ``_safe_path`` proves every existing ancestor AND the final node with
    no-follow lstat (refuses symlink/junction/reparse/non-regular topology and
    any escape from the project root); ``prove_owned_regular`` re-witnesses the
    exact final node; ``read_bound_regular_bytes`` reads through a descriptor
    bound to that exact node, closing the lstat/open race and refusing any
    pivot or oversized authority.

    Raises ``FileNotFoundError`` when absent and ``ValueError`` (or its
    ``InvalidIdError`` subclass) on any unsafe/racing/oversized topology.
    """
    path = _safe_path(root, rel, expect_file=True)
    expected = prove_owned_regular(path, kind=kind)
    return read_bound_regular_bytes(path, expected, max_bytes=max_bytes)


def _valid_receipt_id(receipt_id: str) -> bool:
    return bool(INTENT_RE.fullmatch(receipt_id))


def _invalid_receipt_id(receipt_id: str) -> dict:
    return {"ok": False, "code": "INVALID_ID", "detail": receipt_id}


def _index_path(root: Path) -> Path:
    return root / ".saipen" / "intake" / "index.json"


def _active_dir(root: Path) -> Path:
    return root / ".saipen" / "intake" / "active"


def _coverage_dir(root: Path) -> Path:
    return root / ".saipen" / "intake" / "coverage"


def _tombstone_dir(root: Path) -> Path:
    return root / ".saipen" / "intake" / "tombstones"


def _archive_dir(root: Path) -> Path:
    return root / ".saipen" / "archive" / "source"


def _contract_dir(root: Path) -> Path:
    return root / ".saipen" / "intake" / "contracts"


_DISTRIBUTION_SCHEMA_VERSION = 1
_DISTRIBUTION_REASON_RE = re.compile(r"[A-Z][A-Z0-9_-]{0,63}")


def _read_distribution_record(root: Path, receipt_id: str) -> dict | None:
    """Read the canonical distribution overlay for one receipt.

    Record absence preserves the pre-T-1400 state: the receipt body remains in
    its ordinary active/archive location and is distributable.  Once a record
    exists, quarantine is monotonic; no operation removes or downgrades it.
    """
    if not _valid_receipt_id(receipt_id):
        raise ValueError(f"invalid source receipt id: {receipt_id!r}")
    rel = distribution_record_rel(receipt_id)
    try:
        raw = _read_owned_file(
            root, rel, kind="source distribution record", max_bytes=_META_MAX
        )
    except FileNotFoundError:
        return None
    try:
        record = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError(f"malformed distribution record {receipt_id}: {exc}") from exc
    expected_body = quarantine_body_rel(receipt_id)
    if not isinstance(record, dict):
        raise ValueError(f"malformed distribution record {receipt_id}: root is not an object")
    if (
        record.get("schema_version") != _DISTRIBUTION_SCHEMA_VERSION
        or record.get("receipt_id") != receipt_id
        or record.get("state") != QUARANTINED
        or record.get("body_ref") != expected_body
        or not isinstance(record.get("source_sha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", record["source_sha256"])
        or not isinstance(record.get("quarantined_at"), str)
        or not record["quarantined_at"]
        or not isinstance(record.get("reason"), str)
        or not _DISTRIBUTION_REASON_RE.fullmatch(record["reason"])
    ):
        raise ValueError(f"distribution record {receipt_id} identity/state drift")
    return record


def _write_distribution_record(root: Path, receipt_id: str, record: dict) -> None:
    path = _safe_path(root, distribution_record_rel(receipt_id), expect_file=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, _json_bytes(record), ownership_root=root)


def _protected_body_exists(root: Path, receipt_id: str) -> bool:
    try:
        _read_owned_file(
            root,
            quarantine_body_rel(receipt_id),
            kind="quarantined source body",
            max_bytes=_BODY_MAX,
        )
    except FileNotFoundError:
        return False
    return True


def _distribution_projection(root: Path, receipt_id: str, digest: str) -> dict:
    """Return trusted distribution state bound to canonical content identity."""
    record = _read_distribution_record(root, receipt_id)
    if record is None:
        if _protected_body_exists(root, receipt_id):
            raise ValueError(
                f"quarantined body {receipt_id} lacks its distribution record"
            )
        return {
            "state": DISTRIBUTABLE,
            "receipt_id": receipt_id,
            "source_sha256": digest,
        }
    if record["source_sha256"] != digest:
        raise ValueError(f"distribution record {receipt_id} digest drift")
    return dict(record)


def _canonical_body_rel(root: Path, receipt_id: str, digest: str, location: str) -> str:
    distribution = _distribution_projection(root, receipt_id, digest)
    if distribution["state"] == QUARANTINED:
        return distribution["body_ref"]
    if location == "active":
        return f".saipen/intake/active/{receipt_id}.md"
    return f".saipen/archive/source/{receipt_id}.md"


def _archive_ref_matches(reference: object, receipt_id: str, current_ref: str) -> bool:
    """A later quarantine preserves the immutable reference recorded at closure.

    The caller resolves current_ref through the digest-bound distribution
    overlay first. Only that reference or the original archive location is
    legal; the body itself is still read and verified at current_ref.
    """
    return reference in (current_ref, f".saipen/archive/source/{receipt_id}.md")


def _read_index(root: Path) -> dict:
    try:
        raw = _read_owned_file(
            root, ".saipen/intake/index.json", kind="source intake index", max_bytes=_INDEX_MAX
        )
    except FileNotFoundError:
        return {"active": {}, "tombstones": {}, "next_id": 1}
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"malformed source intake index: {exc}") from exc
    return _decode_index(doc)


def _decode_index(doc: object) -> dict:
    """Decode the persisted intake index once, fail-closed.

    The index is discoverability authority.  A mutator must never turn a
    damaged index into a new empty one: doing so silently strands receipts or
    erases tombstone history.  Validation and every mutator therefore share
    this decoder instead of each inventing a weaker shape check.
    """
    if not isinstance(doc, dict):
        raise ValueError("source intake index corrupt: root is not an object")
    schema = doc.get("schema_version", SCHEMA_VERSION)
    if not isinstance(schema, int) or isinstance(schema, bool) or schema != SCHEMA_VERSION:
        raise ValueError(f"source intake index corrupt: invalid schema_version {schema!r}")
    next_id = doc.get("next_id")
    if not isinstance(next_id, int) or isinstance(next_id, bool) or next_id < 1:
        raise ValueError("source intake index corrupt: next_id must be a positive integer")
    decoded = dict(doc)
    for field in ("active", "tombstones"):
        value = doc.get(field)
        if not isinstance(value, dict):
            raise ValueError(f"source intake index corrupt: {field} is not an object")
        checked: dict[str, dict] = {}
        for receipt_id, entry in value.items():
            if not isinstance(receipt_id, str) or not _valid_receipt_id(receipt_id):
                raise ValueError(f"source intake index corrupt: invalid {field} id {receipt_id!r}")
            if not isinstance(entry, dict):
                raise ValueError(
                    f"source intake index corrupt: {field} entry {receipt_id} is not an object"
                )
            if field == "active":
                digest = entry.get("source_sha256")
                if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                    raise ValueError(
                        f"source intake index corrupt: active entry {receipt_id} has invalid digest"
                    )
                linked = entry.get("linked_work")
                if linked is not None and (
                    not isinstance(linked, str) or not re.fullmatch(r"T-\d+", linked)
                ):
                    raise ValueError(
                        "source intake index corrupt: active entry "
                        f"{receipt_id} has invalid linked_work"
                    )
            else:
                digest = entry.get("source_sha256")
                if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                    raise ValueError(
                        f"source intake index corrupt: tombstone {receipt_id} has invalid digest"
                    )
                # A tombstone is terminal, not necessarily SUCCESSFUL. CLOSED
                # means "implemented and proven"; INVALID means the Work never
                # belonged to this project at all and was RETIRED with operator
                # authority (`retirement.py`). Refusing the second shape here
                # would force a retirement to masquerade as a closure, which is
                # the exact fabrication the retirement path exists to remove.
                from .retirement import is_retired_tombstone

                if entry.get("status") != CLOSED_STATUS and not is_retired_tombstone(entry):
                    raise ValueError(
                        f"source intake index corrupt: tombstone {receipt_id} is neither "
                        f"CLOSED nor a retired (INVALID) receipt"
                    )
            checked[receipt_id] = entry
        decoded[field] = checked
    overlap = set(decoded["active"]) & set(decoded["tombstones"])
    if overlap:
        raise ValueError(
            "source intake index corrupt: receipt appears active and tombstoned: "
            + ", ".join(sorted(overlap))
        )
    highest = max(
        (int(receipt_id.split("-", 1)[1]) for group in (decoded["active"], decoded["tombstones"])
         for receipt_id in group),
        default=0,
    )
    if next_id <= highest:
        raise ValueError(
            f"source intake index corrupt: next_id {next_id} does not follow receipt ids"
        )
    decoded["next_id"] = next_id
    decoded["schema_version"] = schema
    return decoded


def _write_index(root: Path, index: dict) -> None:
    index["schema_version"] = SCHEMA_VERSION
    path = _safe_path(root, ".saipen/intake/index.json", expect_file=True)
    _atomic_write(path, _json_bytes(index), ownership_root=root)


def _read_meta(root: Path, receipt_id: str) -> dict | None:
    if not _valid_receipt_id(receipt_id):
        raise ValueError(f"invalid source receipt id: {receipt_id!r}")
    rel = f".saipen/intake/active/{receipt_id}.meta.json"
    try:
        raw = _read_owned_file(root, rel, kind="source receipt metadata", max_bytes=_META_MAX)
    except FileNotFoundError:
        return None
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"malformed source metadata {receipt_id}: {exc}") from exc
    if not isinstance(doc, dict):
        raise ValueError(f"malformed source metadata {receipt_id}: root is not an object")
    return doc


def _write_meta(root: Path, receipt_id: str, meta: dict) -> None:
    path = _safe_path(root, f".saipen/intake/active/{receipt_id}.meta.json", expect_file=True)
    _atomic_write(path, _json_bytes(meta), ownership_root=root)


def _read_archived_meta(root: Path, receipt_id: str) -> dict | None:
    rel = f".saipen/archive/source/{receipt_id}.meta.json"
    try:
        raw = _read_owned_file(
            root, rel, kind="source archive metadata", max_bytes=_META_MAX
        )
    except FileNotFoundError:
        return None
    try:
        value = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValueError(f"malformed archived metadata {receipt_id}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"malformed archived metadata {receipt_id}: root is not an object")
    return value


def _write_body(root: Path, receipt_id: str, body: str) -> None:
    path = _safe_path(root, f".saipen/intake/active/{receipt_id}.md", expect_file=True)
    if path.exists():
        raise ValueError(f"immutable source body already exists: {receipt_id}")
    _atomic_write(path, body.encode("utf-8"), ownership_root=root)


def _coverage_path(root: Path, receipt_id: str) -> Path:
    if not _valid_receipt_id(receipt_id):
        raise ValueError(f"invalid source receipt id: {receipt_id!r}")
    return _coverage_dir(root) / f"{receipt_id}.json"


def _read_coverage(root: Path, receipt_id: str) -> dict:
    rel = f".saipen/intake/coverage/{receipt_id}.json"
    try:
        raw = _read_owned_file(root, rel, kind="source coverage ledger", max_bytes=_LEDGER_MAX)
    except FileNotFoundError:
        return {"requirements": {}}
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"malformed source coverage {receipt_id}: {exc}") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("requirements"), dict):
        raise ValueError(f"malformed source coverage {receipt_id}: requirements is not an object")
    return doc


def _write_coverage(root: Path, receipt_id: str, ledger: dict) -> None:
    path = _safe_path(root, f".saipen/intake/coverage/{receipt_id}.json", expect_file=True)
    _atomic_write(path, _json_bytes(ledger), ownership_root=root)


def _contract_path(root: Path, receipt_id: str) -> Path:
    if not _valid_receipt_id(receipt_id):
        raise ValueError(f"invalid source receipt id: {receipt_id!r}")
    return _contract_dir(root) / f"{receipt_id}.json"


def _read_contract(root: Path, receipt_id: str) -> dict | None:
    rel = f".saipen/intake/contracts/{receipt_id}.json"
    try:
        raw = _read_owned_file(root, rel, kind="source Work Contract", max_bytes=_LEDGER_MAX)
    except FileNotFoundError:
        return None
    try:
        value = json.loads(raw.decode("utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"malformed source Work Contract {receipt_id}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"malformed source Work Contract {receipt_id}: root is not an object")
    return value


def _write_contract(root: Path, receipt_id: str, contract: dict) -> None:
    path = _safe_path(root, f".saipen/intake/contracts/{receipt_id}.json", expect_file=True)
    _atomic_write(path, _json_bytes(contract), ownership_root=root)


def _write_contract_revision(root: Path, receipt_id: str, contract: dict) -> None:
    revision = int(contract.get("interpretation_revision", 0))
    path = _safe_path(
        root,
        f".saipen/intake/contracts/{receipt_id}.r{revision:03d}.json",
        expect_file=True,
    )
    if path.exists():
        raise ValueError(f"contract revision already exists: {receipt_id} r{revision}")
    _atomic_write(path, _json_bytes(contract), ownership_root=root)


def _write_tombstone(root: Path, receipt_id: str, tombstone: dict) -> None:
    path = _safe_path(root, f".saipen/intake/tombstones/{receipt_id}.json", expect_file=True)
    _atomic_write(path, _json_bytes(tombstone), ownership_root=root)


def _strip_source_receipts_pseudo_link(ticket: dict) -> str | None:
    """Cleaned `verify` value with an embedded `source_receipts:` pseudo-link
    removed, or None when the value carries none (T-1316 authorized repair).

    A pseudo-link (`verify: ... ; source_receipts: SRC-027`) is malformed
    structured state: the parser rejects it, validation refuses the record,
    and nothing may silently normalize it ON READ. The ONE permitted writer
    is the authorized source-linkage projection below -- the same canonical
    operation that binds the receipt properly. The pseudo-marker is stripped
    only when it names the exact receipt being linked, so this can never
    launder an unrelated or fabricated reference.
    """
    verify = str((ticket.get("fields") or {}).get("verify") or "")
    pattern = re.compile(
        r"\s*[;,]?\s*source_receipts:\s*(?P<ids>[A-Za-z0-9][A-Za-z0-9, \\-]*)"
    )
    match = pattern.search(verify)
    if not match:
        return None
    named = {part.strip() for part in match.group("ids").split(",") if part.strip()}
    if match.group("ids").strip() not in named:
        return None
    cleaned = verify[: match.start()] + verify[match.end() :]
    cleaned = cleaned.rstrip(" ;,") + (" " if verify[: match.start()].rstrip() else "")
    return cleaned.strip()


def _board_link_proposal(root: Path, work: str, receipt_id: str, *, op_id: str) -> dict:
    """PROPOSE the canonical BOARD receipt projection (read-only).

    T-1326 P1 (intake half-commit): the projection is computed -- including the
    shared resulting-row compaction -- BEFORE anything is written. The previous
    implementation wrote the durable metadata `linked_work` and the intake index
    link first and only then discovered that the BOARD row could not accept the
    receipt (`BOARD_RECORD_OVERSIZE`), leaving three authorities in disagreement:
    durable state said linked, BOARD said nothing.

    Returns the complete commit set for `_commit_source_link`, or a refusal that
    writes nothing at all.
    """
    from . import codec
    from .board import parse_board, set_ticket_field
    from .board_compaction import MAX_LIVE_RECORD_CHARS, prepare_existing, prepare_expanded

    path = _safe_path(root, ".saipen/BOARD.md", expect_file=True)
    try:
        raw = _read_owned_file(
            root, ".saipen/BOARD.md", kind="source BOARD authority", max_bytes=_BOARD_MAX
        )
        document = codec.read_document(path, raw=raw)
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "ORPHAN_RECEIPT", "detail": str(exc)}
    board_text = document.text_norm

    def project(text: str) -> tuple[str, bool]:
        board = parse_board(text)
        ticket = board.get("tickets", {}).get(work)
        if not ticket:
            raise KeyError(f"source durable but linked Work {work} is missing")
        existing = [
            value.strip()
            for value in str(ticket.get("fields", {}).get("source_receipts") or "").split(",")
            if value.strip()
        ]
        # Authorized normalization (T-1316): the projection that binds receipt_id
        # is also the only writer allowed to remove the matching pseudo-link from
        # `verify` -- read-side normalization stays forbidden. The ORIGINAL raw
        # line stays the replace anchor; only the replacement carries the strip.
        original_raw = ticket["raw"]
        cleaned_verify = _strip_source_receipts_pseudo_link(ticket)
        already_linked = receipt_id in existing
        if already_linked and cleaned_verify is None:
            return text, True
        if not already_linked:
            existing.append(receipt_id)
        # The size ceiling is lifted for the PROPOSED mutation only: phase 3
        # externalizes an oversized result losslessly in this SAME journaled
        # transaction. The record boundary (never a second physical ticket) is
        # still enforced by `set_ticket_field` itself.
        if cleaned_verify is not None:
            replacement = set_ticket_field(
                original_raw, "verify", cleaned_verify, enforce_cap=False
            )
        else:
            replacement = original_raw
        replacement = set_ticket_field(
            replacement, "source_receipts", ",".join(existing), enforce_cap=False
        )
        updated = text.replace(original_raw, replacement, 1)
        if updated == text:
            raise KeyError(f"could not project {receipt_id} onto BOARD {work}")
        return updated, False

    targets: list = []
    try:
        # Phase 1: a readable but oversized historical row is compacted FIRST, so
        # the projection edits a legal record. Phase 2: the mutation itself is
        # run with the cap lifted. Phase 3: a row the projection left oversized
        # (the near-cap reproduction) is externalized LOSSLESSLY in the same
        # transaction instead of refusing the receipt.
        compacted = prepare_existing(
            root,
            board_text,
            [work],
            op_id=op_id,
            event_id=None,
            reason="existing oversized BOARD record requires canonical source receipt link",
        )
        targets.extend(compacted.targets)
        proposed, already_linked = project(compacted.board_text)
        if already_linked and not compacted.targets:
            return {"ok": True, "already_linked": True, "board_text": proposed, "targets": []}
        grown = prepare_expanded(
            root,
            proposed,
            [work],
            op_id=op_id,
            event_id=None,
            reason="source receipt link grew the BOARD record past the live cap",
        )
        targets.extend(grown.targets)
    except KeyError as exc:
        return {"ok": False, "code": "ORPHAN_RECEIPT", "detail": str(exc.args[0])}
    except ValueError as exc:
        # Covers the compaction refusal for machine truth that cannot fit: the
        # exact receipt token is never truncated, and nothing is linked.
        return {
            "ok": False,
            "code": (
                "BOARD_RECORD_OVERSIZE"
                if "oversize" in str(exc).lower()
                else "VALIDATION_FAILED"
            ),
            "detail": str(exc),
        }
    return {
        "ok": True,
        "already_linked": False,
        "board_text": grown.board_text,
        "targets": targets,
        "oversize_limit": MAX_LIVE_RECORD_CHARS,
    }


def _commit_source_link(root: Path, work: str, receipt_id: str, *, op_id: str) -> dict:
    """ONE linkage transaction: metadata + index + BOARD (or none of them).

    Commit order is BOARD first (its projection carries the only operator-visible
    truth and it is the step that can fail), then the durable metadata and the
    intake index. If either durable write fails the BOARD projection is ROLLED
    BACK, so every failure leaves all three authorities agreeing that the source
    is NOT linked -- which is exactly what a retry needs to converge from.
    """
    proposal = _board_link_proposal(root, work, receipt_id, op_id=op_id)
    if not proposal.get("ok"):
        return {
            "ok": False,
            "code": proposal.get("code", "ORPHAN_RECEIPT"),
            "detail": proposal.get("detail"),
            "linked_work": None,
        }
    if proposal.get("already_linked") and not proposal.get("targets"):
        linked = _relink_authorities(root, work, receipt_id)
        return {
            "ok": bool(linked.get("ok")),
            "code": "SOURCE_LINKED" if linked.get("ok") else "ORPHAN_RECEIPT",
            "linked_work": work if linked.get("ok") else None,
            "detail": linked.get("detail"),
        }
    path = _safe_path(root, ".saipen/BOARD.md", expect_file=True)
    before = _read_owned_file(
        root, ".saipen/BOARD.md", kind="source BOARD authority", max_bytes=_BOARD_MAX
    )
    board_written = False
    try:
        from . import codec

        document = codec.read_document(path, raw=before)
        for target in proposal["targets"]:
            owned_target_path(root, target.path, kind="source BOARD compaction detail")
            _atomic_write(root / target.path, target.content, ownership_root=root)
        _atomic_write(path, document.encode(proposal["board_text"]), ownership_root=root)
        board_written = True
        linked = _relink_authorities(root, work, receipt_id)
        if not linked.get("ok"):
            raise OSError(str(linked.get("detail") or "durable linkage refused"))
    except (OSError, ValueError) as exc:
        if board_written:
            # pragma: no cover - rollback is best effort
            with contextlib.suppress(OSError, ValueError):
                _atomic_write(path, before, ownership_root=root)
        return {
            "ok": False,
            "code": "ORPHAN_RECEIPT",
            "linked_work": None,
            "detail": f"source linkage transaction did not commit: {exc}",
        }
    return {"ok": True, "code": "SOURCE_LINKED", "work": work, "linked_work": work}


def linked_works(meta: dict | None) -> set[str]:
    """Every Work a receipt's durable metadata names (T-1437).

    ONE source receipt may legitimately produce several independent Work
    items. `linked_work` stays the historical PRIMARY (single-work receipts
    are byte-for-byte unchanged), and the optional `linked_works` list carries
    the remaining membership. Linkage checks consume MEMBERSHIP; the primary
    is display/back-compat only, so closing one child never rewrites the
    ownership away from its siblings.
    """
    works: set[str] = set()
    primary = str((meta or {}).get("linked_work") or "").strip()
    if primary:
        works.add(primary)
    extra = (meta or {}).get("linked_works")
    if isinstance(extra, list):
        for item in extra:
            value = str(item or "").strip()
            if value:
                works.add(value)
    return works


def is_linked_to(meta: dict | None, work: str) -> bool:
    """Is `work` a canonical member of this receipt's Work membership?"""
    return str(work or "").strip() in linked_works(meta)


def _relink_authorities(root: Path, work: str, receipt_id: str) -> dict:
    """Durably record the link in the metadata and the intake index.

    T-1437: an EMPTY primary takes the Work (single-work receipts keep their
    exact old shape); an existing DIFFERENT primary is never moved -- the Work
    joins `linked_works` instead.
    """
    try:
        meta = _read_meta(root, receipt_id)
        primary = str(meta.get("linked_work") or "").strip()
        if not primary:
            meta["linked_work"] = work
        elif primary != work:
            extra = sorted(
                {value for value in (meta.get("linked_works") or []) if str(value).strip()}
                | {work}
            )
            meta["linked_works"] = extra
        _write_meta(root, receipt_id, meta)
        index = _read_index(root)
        entry = index.setdefault("active", {}).get(receipt_id)
        if entry is None:
            return {"ok": False, "detail": f"{receipt_id} is not in the active intake index"}
        entry["linked_work"] = meta.get("linked_work")
        if meta.get("linked_works"):
            entry["linked_works"] = list(meta["linked_works"])
        _write_index(root, index)
    except (OSError, ValueError) as exc:
        return {"ok": False, "detail": str(exc)}
    return {"ok": True}


def link_work_to(root: Path | str, receipt_id: str, work: str) -> dict:
    """Canonically add ONE Work to a receipt's durable membership (T-1437).

    Fail closed on an unknown receipt, a Work missing from BOARD, a byte
    integrity failure, or an invalid identity. Idempotent: a Work already in
    the membership returns ALREADY_LINKED with zero writes.
    """
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    work = str(work or "").strip()
    if not _WORK_ID_RE.match(work):
        return {
            "ok": False,
            "code": "INVALID_ID",
            "detail": f"source link needs a T-### Work id, got {work!r}",
        }
    index = _read_index(root)
    if receipt_id not in index.get("active", {}):
        return {
            "ok": False,
            "code": "SOURCE_RECEIPT_MISSING",
            "detail": f"{receipt_id} is not on the active intake surface",
        }
    if not _board_has_work(root, work):
        return {
            "ok": False,
            "code": "ORPHAN_RECEIPT",
            "detail": f"linked Work {work} is missing from BOARD",
        }
    integrity = verify_integrity(root, receipt_id)
    if not integrity.get("ok"):
        return integrity
    meta = _read_meta(root, receipt_id) or {}
    if work in linked_works(meta):
        return {
            "ok": True,
            "code": "ALREADY_LINKED",
            "receipt": receipt_id,
            "work": work,
            "linked_work": meta.get("linked_work"),
            "linked_works": sorted(linked_works(meta)),
        }
    committed = _commit_source_link(
        root,
        work,
        receipt_id,
        op_id="source-link-"
        + hashlib.sha256(f"{receipt_id}:{work}".encode("utf-8")).hexdigest()[:16],
    )
    if not committed.get("ok"):
        return committed
    after = _read_meta(root, receipt_id) or {}
    return {
        "ok": True,
        "code": "SOURCE_LINKED",
        "receipt": receipt_id,
        "work": work,
        "linked_work": after.get("linked_work"),
        "linked_works": sorted(linked_works(after)),
    }


def _board_source_links(root: Path) -> dict[str, set[str]]:
    """Return the reverse BOARD projection: Work -> durable receipt IDs."""
    from . import codec
    from .board import parse_board

    raw = _read_owned_file(
        root, ".saipen/BOARD.md", kind="source BOARD authority", max_bytes=_BOARD_MAX
    )
    document = codec.read_document(root / ".saipen" / "BOARD.md", raw=raw)
    board = parse_board(document.text_norm)
    if board.get("errors"):
        raise ValueError("BOARD parse error: " + "; ".join(board["errors"][:3]))
    result: dict[str, set[str]] = {}
    for work, ticket in board.get("tickets", {}).items():
        values = {
            value.strip()
            for value in str(ticket.get("fields", {}).get("source_receipts") or "").split(",")
            if value.strip()
        }
        if values:
            result[work] = values
    return result


def _board_has_work(root: Path, work: str) -> bool:
    """Canonical BOARD authority check (CORE-004): does `work` exist?

    Only this canonical projection may authorize a durable Work linkage.
    Reads through the bounded ownership-safe reader and never through a raw
    pathname, so a hostile/racing BOARD is refused rather than consulted.
    """
    if not work:
        return False
    try:
        from .board import parse_board

        raw = _read_owned_file(
            root, ".saipen/BOARD.md", kind="source BOARD authority", max_bytes=_BOARD_MAX
        )
        board = parse_board(raw.decode("utf-8-sig"))
    except (OSError, ValueError):
        return False
    return work in board.get("tickets", {})


def _amends_resolvable(root: Path, amends: str) -> bool:
    """CORE-004: an `amends` target must name an existing receipt identity
    across the active OR tombstone history before it is made authoritative.
    A dangling amendment reference is never committed to durable metadata."""
    if not _valid_receipt_id(amends):
        return False
    index = _read_index(root)
    if amends in index.get("active", {}):
        return True
    return amends in index.get("tombstones", {})


def _contract_revision_integrity(root: Path, receipt_id: str, contract: dict) -> None:
    """Validate the owned contiguous contract revision chain (W2-004).

    Revisions may live under the active contract directory (.saipen/intake/contracts)
    or the archive (.saipen/archive/source) when an interrupted close moved
    some targets. The chain is valid when the union of owned regular revision
    files exactly matches the contiguous set r001..rN and every revision
    carries matching receipt/derived_from/source_sha256/schema_version/
    interpretation_revision identity.
    """
    revision = contract.get("interpretation_revision", 0)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise ValueError(f"source {receipt_id} has invalid interpretation revision")
    expected = set(range(1, revision + 1))
    active_dir = _contract_dir(root)
    archive_dir = _archive_dir(root)
    found: dict[int, Path] = {}
    for directory in (active_dir, archive_dir):
        if not directory.is_dir() or _is_link_or_reparse(directory):
            continue
        for path in directory.glob(f"{receipt_id}.r*.json"):
            match = re.fullmatch(rf"{re.escape(receipt_id)}\.r(\d+)\.json", path.name)
            if not match:
                raise ValueError(
                    f"source {receipt_id} has invalid contract revision file {path.name}"
                )
            number = int(match.group(1))
            if not path.is_file() or _is_link_or_reparse(path):
                raise ValueError(
                    f"source {receipt_id} revision r{number:03d} is a symlink/reparse"
                )
            if number in found:
                raise ValueError(
                    f"source {receipt_id} has duplicate revision r{number:03d}"
                )
            found[number] = path
    if set(found) != expected:
        raise ValueError(
            f"source {receipt_id} contract revision chain is not contiguous: "
            f"expected {sorted(expected)}, found {sorted(found)}"
        )
    for number in sorted(expected):
        path = found[number]
        rel = path.relative_to(root).as_posix()
        raw = _read_owned_file(
            root,
            rel,
            kind="source Contract revision",
            max_bytes=_LEDGER_MAX,
        )
        try:
            historical = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ValueError(
                f"source {receipt_id} revision r{number:03d} is malformed: {exc}"
            ) from exc
        if not isinstance(historical, dict):
            raise ValueError(f"source {receipt_id} revision r{number:03d} is not an object")
        if (
            historical.get("receipt_id", receipt_id) != receipt_id
            or historical.get("derived_from", receipt_id) != receipt_id
            or historical.get("source_sha256") != contract.get("source_sha256")
            or historical.get("schema_version") != contract.get("schema_version")
            or historical.get("interpretation_revision") != number
        ):
            raise ValueError(f"source {receipt_id} revision r{number:03d} identity drift")
        if number == revision and historical != contract:
            raise ValueError(
                f"source {receipt_id} current Contract differs from revision r{number:03d}"
            )


def _contract_integrity(root: Path, receipt_id: str, meta: dict) -> dict:
    """Bind Contract, contiguous revisions and coverage to one source digest."""
    try:
        contract = _read_contract(root, receipt_id)
        if not contract or contract.get("source_sha256") != meta.get("source_sha256"):
            return {"ok": False, "code": "CONTRACT_DRIFT", "receipt": receipt_id}
        ledger = _read_coverage(root, receipt_id)
        clauses = contract.get("clauses")
        requirements = ledger.get("requirements")
        if not isinstance(clauses, dict) or not isinstance(requirements, dict):
            return {
                "ok": False,
                "code": "CONTRACT_DRIFT",
                "receipt": receipt_id,
                "detail": "Contract clauses or coverage requirements are not objects",
            }
        if set(clauses) != set(requirements):
            return {
                "ok": False,
                "code": "CONTRACT_DRIFT",
                "receipt": receipt_id,
                "detail": "Contract and coverage clause identities differ",
            }
        _validate_contract_coverage(receipt_id, contract, ledger)
        _contract_revision_integrity(root, receipt_id, contract)
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "CONTRACT_DRIFT", "receipt": receipt_id, "detail": str(exc)}
    return {"ok": True, "code": "CONTRACT_INTEGRITY_OK", "receipt": receipt_id}


def _validate_contract_coverage(receipt_id: str, contract: object, coverage: object) -> None:
    """Validate the nested source ledger shared by active and archive paths."""
    if not isinstance(contract, dict) or not isinstance(coverage, dict):
        raise ValueError(f"source {receipt_id} Contract/coverage root is not an object")
    clauses = contract.get("clauses")
    requirements = coverage.get("requirements")
    if not isinstance(clauses, dict) or not isinstance(requirements, dict):
        raise ValueError(f"source {receipt_id} Contract/coverage containers are not objects")
    if set(clauses) != set(requirements):
        raise ValueError(f"source {receipt_id} Contract/coverage clause identities differ")
    for rid, clause in clauses.items():
        if not isinstance(rid, str) or not re.fullmatch(rf"{re.escape(receipt_id)}:R\d+", rid):
            raise ValueError(f"source {receipt_id} has invalid clause id {rid!r}")
        entry = requirements[rid]
        if not isinstance(clause, dict) or not isinstance(entry, dict):
            raise ValueError(f"source {receipt_id} clause {rid} is not an object")
        clause_class = clause.get("class")
        text = clause.get("text")
        actionable = clause.get("actionable")
        if clause_class not in CLAUSE_CLASSES or not isinstance(text, str) or not text.strip():
            raise ValueError(f"source {receipt_id} clause {rid} has invalid structure")
        if not isinstance(actionable, bool) or actionable != (clause_class in ACTIONABLE_CLASSES):
            raise ValueError(f"source {receipt_id} clause {rid} has invalid actionable flag")
        if set(clause) != {"class", "text", "actionable"}:
            raise ValueError(
                f"source {receipt_id} Contract clause {rid} has extra or missing fields"
            )
        if set(entry) != {
            "class",
            "text",
            "actionable",
            "disposition",
            "work",
            "evidence",
            "verification",
        }:
            raise ValueError(
                f"source {receipt_id} coverage clause {rid} has extra or missing fields"
            )
        if any(entry.get(field) != clause.get(field) for field in ("class", "text", "actionable")):
            raise ValueError(f"source {receipt_id} clause {rid} drift")
        disposition = entry.get("disposition", "UNKNOWN")

        if disposition not in ALL_DISPOSITIONS:
            raise ValueError(f"source {receipt_id} requirement {rid} has invalid disposition")
        for field in ("evidence", "verification"):
            value = entry.get(field)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ValueError(f"source {receipt_id} requirement {rid} has invalid {field}")


def _find_exact_duplicate(root: Path, digest: str) -> dict | None:
    index = _read_index(root)
    for receipt_id in index.get("active", {}):
        meta = _read_meta(root, receipt_id)
        if meta and meta.get("source_sha256") == digest:
            integrity = verify_integrity(root, receipt_id)
            if not integrity["ok"]:
                return {"receipt_id": receipt_id, "meta": meta, "invalid": integrity}
            return {"receipt_id": receipt_id, "meta": meta}
    for receipt_id, tomb in index.get("tombstones", {}).items():
        if tomb.get("source_sha256") == digest:
            return {"receipt_id": receipt_id, "tombstone": tomb, "closed": True}
    # Crash window: body durable, process died before metadata/index commit.
    # Exact retry must adopt this orphan instead of allocating SRC-N+1.
    active = _active_dir(root)
    if active.is_dir() and not _is_link_or_reparse(active):
        for body_path in sorted(active.glob("SRC-*.md")):
            receipt_id = body_path.stem
            if not INTENT_RE.fullmatch(receipt_id) or _is_link_or_reparse(body_path):
                continue
            # T-1323: a leftover active body whose id is ALREADY a tombstone is
            # stale residue from a completed close, never an adoptable orphan.
            # Adopting it would resurrect a closed receipt with its old id.
            if receipt_id in index.get("tombstones", {}):
                continue
            try:
                raw = _read_owned_file(
                    root,
                    f".saipen/intake/active/{receipt_id}.md",
                    kind="source body",
                    max_bytes=_BODY_MAX,
                )
                if hashlib.sha256(raw).hexdigest() == digest:
                    return {"receipt_id": receipt_id, "orphan": True}
            except (OSError, ValueError):
                continue
    return None


def find_by_body(root: Path | str, body: str) -> dict | None:
    """The existing receipt for these EXACT bytes, or None (read-only).

    The public idempotency probe. `capture` is already content-addressed, but
    a caller that also projects Work (CORE-003 `user_request`) has to know
    BEFORE it writes whether this request already has an authority AND a Work
    line -- otherwise a retry mints a second ticket for one request.
    """
    root = Path(root)
    found = _find_exact_duplicate(root, _sha256(body))
    if not found:
        return None
    meta = found.get("meta") or {}
    return {
        "receipt": found.get("receipt_id"),
        "linked_work": meta.get("linked_work"),
        "status": meta.get("status") or (CLOSED_STATUS if found.get("closed") else None),
        "orphan": bool(found.get("orphan")),
        "invalid": found.get("invalid"),
        "projection_policy": meta.get("projection_policy") or PROJECTION_WORK,
    }


def _next_receipt_id(root: Path, index: dict) -> str:
    used: set[int] = set()
    for collection in (index.get("active", {}), index.get("tombstones", {})):
        for receipt_id in collection:
            if INTENT_RE.fullmatch(receipt_id):
                used.add(int(receipt_id.split("-", 1)[1]))
    for directory in (_active_dir(root), _archive_dir(root), _tombstone_dir(root)):
        if not directory.is_dir() or _is_link_or_reparse(directory):
            continue
        for path in directory.glob("SRC-*.*"):
            match = re.match(r"SRC-(\d+)", path.name)
            if match:
                used.add(int(match.group(1)))
    value = max(int(index.get("next_id", 1)), max(used, default=0) + 1)
    while value in used:
        value += 1
    index["next_id"] = value + 1
    return f"SRC-{value:03d}"


def capture(
    root: Path | str,
    body: str,
    *,
    source_kind: str = "user_instruction",
    work: str | None = None,
    amends: str | None = None,
    force: bool = False,
    transport_transform: str = "none",
    newline_normalization: str = "none",
    request_provenance: dict | None = None,
    projection_policy: str = PROJECTION_WORK,
) -> dict:
    """Capture an authoritative source VERBATIM before any interpretation.

    Idempotent: an exact canonical digest returns the existing receipt
    (duplicate=true) and never creates a second one. Body is written first,
    then metadata, then the index -- so a crash after the body leaves a
    detectable orphan that recovery can reconcile, and a crash before any
    durable write loses nothing.
    """
    root = Path(root)
    if not isinstance(body, str) or not body:
        return {"ok": False, "code": "INVALID_SOURCE", "detail": "empty source body"}
    # CORE-001: the received UTF-8 body IS the authority. Credential masking is
    # a display/export concern and must never run before the canonical digest,
    # dedupe or persistence -- masking before identity made two byte-distinct
    # sources collapse onto one receipt (SOURCES.md:38-44).
    detected_sensitive = _looks_sensitive(body)
    sensitive = detected_sensitive
    body_bytes = body.encode("utf-8")

    if len(body_bytes) > _BODY_MAX:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"source body exceeds {_BODY_MAX} byte limit",
        }
    if source_kind not in SOURCE_KINDS:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"unknown source kind {source_kind!r}",
        }
    if projection_policy not in PROJECTION_POLICIES:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"unknown projection policy {projection_policy!r}",
        }
    if work is not None and not re.fullmatch(r"T-\d+", work):
        return {"ok": False, "code": "INVALID_ID", "detail": f"work {work!r}"}
    if amends and not INTENT_RE.fullmatch(amends):
        return {"ok": False, "code": "INVALID_ID", "detail": f"amends {amends!r}"}
    digest = _sha256(body)
    redaction, authority = _exact_authority_record(digest)
    try:
        with project_writer_lock(root):
            existing = _find_exact_duplicate(root, digest)
            if existing and not force:
                if existing.get("invalid"):
                    return existing["invalid"]
                if existing.get("closed"):
                    # Terminal, but not necessarily SUCCESSFUL: a retired
                    # receipt is terminal because the request never belonged
                    # here. Reporting CLOSED for it would tell the caller the
                    # work was done, which is the exact lie this whole path
                    # exists to make impossible.
                    _tomb = existing.get("tombstone") or {}
                    return {
                        "ok": True,
                        "code": "SOURCE_DUPLICATE_CLOSED",
                        "receipt": existing["receipt_id"],
                        "source_sha256": digest,
                        "status": _tomb.get("status") or CLOSED_STATUS,
                        "closure": existing.get("tombstone"),
                    }
                if not existing.get("orphan"):
                    meta = existing.get("meta") or {}
                    linked_work = meta.get("linked_work")
                    if work and linked_work and linked_work != work:
                        return {
                            "ok": False,
                            "code": "SOURCE_WORK_CONFLICT",
                            "receipt": existing["receipt_id"],
                            "linked_work": linked_work,
                            "requested_work": work,
                        }
                    if amends and not _amends_resolvable(root, amends):
                        return {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": f"amends references unknown receipt {amends}",
                        }
                    if work and not linked_work:
                        if not _board_has_work(root, work):
                            return {
                                "ok": False,
                                "code": "ORPHAN_RECEIPT",
                                "receipt": existing["receipt_id"],
                                "detail": f"linked Work {work} is missing from BOARD",
                            }
                        linked_work = work
                    if linked_work:
                        # ONE linkage transaction: BOARD, metadata and index move
                        # together, or the source stays unlinked everywhere
                        # (T-1326 P1).
                        linkage = _commit_source_link(
                            root,
                            linked_work,
                            existing["receipt_id"],
                            op_id="source-link-"
                            + hashlib.sha256(
                                f"{existing['receipt_id']}:{linked_work}".encode("utf-8")
                            ).hexdigest()[:16],
                        )
                        if not linkage.get("ok"):
                            return {
                                "ok": False,
                                "code": linkage.get("code", "ORPHAN_RECEIPT"),
                                "receipt": existing["receipt_id"],
                                "linked_work": None,
                                "detail": linkage.get("detail"),
                            }
                        linked_work = linkage.get("linked_work") or linked_work
                        meta["linked_work"] = linked_work
                    return {
                        "ok": True,
                        "code": "SOURCE_DUPLICATE",
                        "receipt": existing["receipt_id"],
                        "source_sha256": digest,
                        "status": meta.get("status", ACTIVE_STATUS),
                        "linked_work": linked_work,
                        "coverage": coverage_summary(root, existing["receipt_id"]),
                        "distribution": _distribution_projection(
                            root, existing["receipt_id"], digest
                        ),
                    }

            index = _read_index(root)
            receipt_id = (
                existing["receipt_id"]
                if existing and existing.get("orphan") and not force
                else _next_receipt_id(root, index)
            )
            if amends and not _amends_resolvable(root, amends):
                return {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"amends references unknown receipt {amends}",
                }
            # CORE-004: never commit an invalid Work reference as authoritative.
            # The canonical BOARD decides whether `work` may be linked. A
            # missing/invalid Work leaves the captured source recoverably
            # UNLINKED (linked_work stays None in durable metadata + index);
            # a later exact retry with the correct Work attaches it.
            # T-1326 P1: the source becomes durable as UNLINKED. The linkage is
            # committed only after the BOARD projection (including any required
            # resulting-row compaction) has been computed and can actually
            # succeed, so no failure can leave metadata/index claiming a link the
            # BOARD does not carry.
            intended_work = work if (work and _board_has_work(root, work)) else None
            linked_work = None
            meta = {
                "receipt_id": receipt_id,
                "received_at": _utc(),
                "source_kind": source_kind,
                "source_sha256": digest,
                "status": ACTIVE_STATUS,
                "linked_work": linked_work,
                "sensitive": sensitive,
                "redaction": redaction,
                "source_authority": authority,
                "schema_version": SCHEMA_VERSION,
                "transport": {
                    "source_encoding": "utf-8",
                    "newline_normalization": newline_normalization,
                    "transport_transform": transport_transform,
                },
                # T-1376: `source_authority: exact` is true about BYTES -- the
                # stored body is the body we were handed. It was being read as a
                # statement about WORDS, and a session that reworded its own
                # task produced a receipt nothing contradicted. This records who
                # compared the arriving text with what the operator wrote, and
                # `model_supplied` means nobody did.
                "request_provenance": dict(request_provenance)
                if isinstance(request_provenance, dict)
                else {"witness": "model_supplied"},
            }
            if projection_policy != PROJECTION_WORK:
                # Typed, explicit and additive: only a non-default policy is
                # recorded, so every historical receipt keeps its exact shape
                # while an authority-only receipt says what it is.
                meta["projection_policy"] = projection_policy
            if amends:
                meta["amends"] = amends

            # CRASH ORDER: body first, verified readback, then metadata,
            # contract/coverage, finally the discoverability index.
            if not (existing and existing.get("orphan") and not force):
                _write_body(root, receipt_id, body)
            try:
                raw_body = _read_owned_file(
                    root,
                    f".saipen/intake/active/{receipt_id}.md",
                    kind="source body",
                    max_bytes=_BODY_MAX,
                )
            except (ValueError, OSError) as exc:
                return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
            actual = hashlib.sha256(raw_body).hexdigest()
            if actual != digest:
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "recorded": digest,
                    "actual": actual,
                }
            _write_meta(root, receipt_id, meta)
            _write_contract(
                root,
                receipt_id,
                {
                    "schema_version": SCHEMA_VERSION,
                    "derived_from": receipt_id,
                    "source_sha256": digest,
                    "derived_at": None,
                    "interpretation_revision": 0,
                    "clauses": {},
                },
            )
            _write_coverage(
                root,
                receipt_id,
                {"schema_version": SCHEMA_VERSION, "requirements": {}},
            )
            index["active"][receipt_id] = {
                "source_sha256": digest,
                "linked_work": linked_work,
            }
            # W2-001: the allocator invariant `next_id > max(existing ids)`
            # must be restored whenever a receipt id is adopted. An orphan
            # recovery reuses `existing["receipt_id"]` without advancing
            # `next_id`, so the persisted index would later be rejected by
            # `_decode_index` as corrupt. Raise `next_id` to one past the
            # adopted id (and any existing higher value) BEFORE writing.
            try:
                adopted_numeric = int(receipt_id.split("-", 1)[1])
            except (IndexError, ValueError):
                adopted_numeric = 0
            current_next = int(index.get("next_id", 0))
            index["next_id"] = max(current_next, adopted_numeric + 1)
            _write_index(root, index)
            if intended_work is not None:
                linkage = _commit_source_link(
                    root,
                    intended_work,
                    receipt_id,
                    op_id="source-link-"
                    + hashlib.sha256(
                        f"{receipt_id}:{intended_work}".encode("utf-8")
                    ).hexdigest()[:16],
                )
                linked_work = linkage.get("linked_work")
            else:
                linkage = {"ok": True, "detail": None}
            if not index.get("tombstones") and len(index.get("active") or {}) == 1:
                # T-1435 M6: the FIRST durable capture in a project is its
                # adoption boundary, so the canonical machine-local runtime
                # ignore policy is established beside it. Best-effort
                # project-file policy: its failure never loses a source
                # transaction, and an existing policy is never duplicated.
                from . import runtime_namespace

                runtime_namespace.ensure_gitignore_policy(root)
            return {
                "ok": bool(linkage.get("ok")),
                "code": "ORPHAN_RECEIPT_RECOVERED"
                if existing and existing.get("orphan") and not force
                else (
                    "SOURCE_RECEIVED"
                    if linkage.get("ok")
                    else linkage.get("code", "ORPHAN_RECEIPT")
                ),
                "receipt": receipt_id,
                "source_sha256": digest,
                "status": ACTIVE_STATUS,
                "linked_work": linked_work,
                "duplicate": False,
                "requirements": 0,
                "sensitive": meta["sensitive"],
                "redaction": redaction,
                "source_authority": authority,
                "distribution": {
                    "state": DISTRIBUTABLE,
                    "receipt_id": receipt_id,
                    "source_sha256": digest,
                },
                "detail": linkage.get("detail"),
            }
    except (OSError, PermissionError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}


def quarantine_receipt(
    root: Path | str, receipt_id: str, *, reason: str = "OPERATOR_MARKED"
) -> dict:
    """Make an active or archived receipt non-distributable without rewriting it.

    The exact body is moved into the protected local-authority namespace first;
    only then is the export-safe, digest-bound distribution record written.
    Thus every interruption is fail-closed for export.  A retry repairs the
    narrow body-moved/record-missing crash state.  No inverse operation exists:
    quarantine is monotonic and cannot grant or remove source authority.
    """
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    if not isinstance(reason, str) or not _DISTRIBUTION_REASON_RE.fullmatch(reason):
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": "quarantine reason must match [A-Z][A-Z0-9_-]{0,63}",
        }
    try:
        with project_writer_lock(root):
            meta = _read_meta(root, receipt_id)
            location = "active"
            if meta is None:
                meta = _read_archived_meta(root, receipt_id)
                location = "archive"
            if meta is None:
                return {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id}
            digest = meta.get("source_sha256")
            if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"source {receipt_id} metadata has invalid digest",
                }

            standard_rel = (
                f".saipen/intake/active/{receipt_id}.md"
                if location == "active"
                else f".saipen/archive/source/{receipt_id}.md"
            )
            protected_rel = quarantine_body_rel(receipt_id)
            standard = _safe_path(root, standard_rel, expect_file=True)
            protected = _safe_path(root, protected_rel, expect_file=True)

            existing_record = _read_distribution_record(root, receipt_id)
            if existing_record is not None and existing_record["source_sha256"] != digest:
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"distribution record {receipt_id} digest drift",
                }

            standard_raw = None
            protected_raw = None
            with contextlib.suppress(FileNotFoundError):
                standard_raw = _read_owned_file(
                    root, standard_rel, kind="source body", max_bytes=_BODY_MAX
                )
            with contextlib.suppress(FileNotFoundError):
                protected_raw = _read_owned_file(
                    root, protected_rel, kind="quarantined source body", max_bytes=_BODY_MAX
                )
            if standard_raw is None and protected_raw is None:
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"source body {receipt_id} is missing",
                }
            if standard_raw is not None and hashlib.sha256(standard_raw).hexdigest() != digest:
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"source body {receipt_id} digest mismatch",
                }
            if protected_raw is not None and hashlib.sha256(protected_raw).hexdigest() != digest:
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"quarantined source body {receipt_id} digest mismatch",
                }
            if standard_raw is not None and protected_raw is not None:
                if standard_raw != protected_raw:
                    return {
                        "ok": False,
                        "code": "SOURCE_CORRUPTION",
                        "detail": f"source body {receipt_id} disagrees across locations",
                    }
                safe_unlink_owned(
                    standard, kind="duplicate distributable source body", ownership_root=root
                )
            elif protected_raw is None:
                prove_owned_regular(standard, kind="source body")
                protected.parent.mkdir(parents=True, exist_ok=True)
                prove_owned_dir_chain(
                    protected.parent, kind="quarantine source body", ownership_root=root
                )
                os.replace(standard, protected)

            record = existing_record or {
                "schema_version": _DISTRIBUTION_SCHEMA_VERSION,
                "receipt_id": receipt_id,
                "source_sha256": digest,
                "state": QUARANTINED,
                "reason": reason,
                "quarantined_at": _utc(),
                "body_ref": protected_rel,
                "authoritative_body_exported": False,
            }
            if existing_record is None:
                _write_distribution_record(root, receipt_id, record)
            return {
                "ok": True,
                "code": "SOURCE_QUARANTINED"
                if existing_record is None
                else "ALREADY_SATISFIED",
                "receipt": receipt_id,
                "source_sha256": digest,
                "distribution": dict(record),
                "source_authority": _source_authority(meta),
            }
    except (OSError, PermissionError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}


def distribution_status(root: Path | str, receipt_id: str) -> dict:
    """Read-only distribution projection; never opens or exposes body bytes."""
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    try:
        meta = _read_meta(root, receipt_id) or _read_archived_meta(root, receipt_id)
        if meta is None:
            tomb = _read_index(root).get("tombstones", {}).get(receipt_id)
            if not isinstance(tomb, dict):
                return {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id}
            digest = tomb.get("source_sha256")
        else:
            digest = meta.get("source_sha256")
        if not isinstance(digest, str):
            raise ValueError(f"source {receipt_id} has no valid content identity")
        projection = _distribution_projection(root, receipt_id, digest)
        return {"ok": True, "code": "SOURCE_DISTRIBUTION", **projection}
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}


def add_requirement(
    root: Path | str,
    receipt_id: str,
    *,
    rid: str,
    text: str,
    clause_class: str = "requirement",
    when_environment: str | None = None,
) -> dict:
    """Persist one new requirement clause as ONE recoverable transaction.

    CORE-001: Contract + immutable revision + coverage ledger bytes are
    computed together, integrity-gated as a single generation, and committed
    through one OperationPlan under the canonical writer lock. Any failure
    before COMMIT leaves the on-disk state byte-identical to the pre-call
    generation; a successful commit advances the immutable revision
    monotonically. Seeded Contract/coverage drift refuses the request with
    ZERO writes. The one-clause case of `add_requirements`.
    """
    result = add_requirements(
        root,
        receipt_id,
        [
            {
                "rid": rid,
                "text": text,
                "class": clause_class,
                "when_environment": when_environment,
            }
        ],
    )
    if not result.get("ok"):
        return result
    return {
        "ok": True,
        "code": "REQUIREMENT_ADDED",
        "receipt": receipt_id,
        "rid": result["rids"][0],
        "revision": result["revision"],
    }


def add_requirements(root: Path | str, receipt_id: str, clauses: list[dict]) -> dict:
    """Persist N new requirement clauses as ONE recoverable transaction (T-1462).

    Each clause is `{"rid", "text", "class", "when_environment"}` and is
    judged exactly as `add_requirement` judges one; any refusal refuses the
    whole batch with ZERO writes. The batch is ONE contract revision and ONE
    OperationPlan under the writer lock: measured 2026-09-22, projecting the
    156 clauses of SRC-105 one plan per clause pushed `saipen continue` past
    its 120-second interactive bound.
    """
    root = Path(root)
    if not INTENT_RE.fullmatch(receipt_id):
        return {"ok": False, "code": "INVALID_ID", "detail": receipt_id}
    if not clauses:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": "no clause to add"}
    normalized: list[tuple[str, str, str, str | None]] = []
    for item in clauses:
        rid = str(item.get("rid") or "")
        text = str(item.get("text") or "")
        clause_class = str(item.get("class") or "requirement")
        when_environment = item.get("when_environment")
        if re.fullmatch(r"R\d+", rid):
            rid = f"{receipt_id}:{rid}"
        if not re.fullmatch(rf"{re.escape(receipt_id)}:R\d+", rid):
            return {"ok": False, "code": "INVALID_ID", "detail": rid}
        if not text.strip():
            return {"ok": False, "code": "VALIDATION_FAILED", "detail": "empty clause text"}
        if clause_class not in CLAUSE_CLASSES:
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"unknown clause class {clause_class!r}",
            }
        if when_environment is not None and not re.fullmatch(r"[a-z0-9_-]+", when_environment):
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"invalid environment identity {when_environment!r}",
            }
        normalized.append((rid, text, clause_class, when_environment))
    try:
        meta = _read_meta(root, receipt_id)
        if not meta:
            return {
                "ok": False,
                "code": "TICKET_NOT_FOUND",
                "detail": f"no active receipt {receipt_id}",
            }
        # CORE-001: refuse split Contract/coverage state BEFORE any mutation
        # planning. The same gate the verify_integrity path uses is the
        # precondition of a permitted commit; an already-red state cannot
        # receive REQUIREMENT_ADDED.
        integrity = verify_integrity(root, receipt_id)
        if not integrity["ok"]:
            return integrity
        contract_gate = _contract_integrity(root, receipt_id, meta)
        if not contract_gate["ok"]:
            return contract_gate
        ledger = _read_coverage(root, receipt_id)
        contract = _read_contract(root, receipt_id)
        if not contract or contract.get("source_sha256") != meta.get("source_sha256"):
            return {
                "ok": False,
                "code": "CONTRACT_DRIFT",
                "detail": "contract missing or source digest mismatch",
            }
        for rid, text, clause_class, when_environment in normalized:
            if rid in ledger["requirements"]:
                return {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"requirement {rid} exists",
                }
            clause = {
                "class": clause_class,
                "text": text,
                "actionable": clause_class in ACTIONABLE_CLASSES,
                "disposition": "UNKNOWN",
                "work": meta.get("linked_work"),
                "evidence": None,
                "verification": None,
            }
            contract_clause = {
                "class": clause_class,
                "text": text,
                "actionable": clause_class in ACTIONABLE_CLASSES,
            }
            if when_environment:
                clause["when_environment"] = when_environment
                contract_clause["when_environment"] = when_environment
            ledger["requirements"][rid] = clause
            contract.setdefault("clauses", {})[rid] = contract_clause
        new_revision = int(contract.get("interpretation_revision", 0)) + 1
        contract["interpretation_revision"] = new_revision
        contract["derived_at"] = _utc()
        # CORE-001: build the exact future bytes for all three targets so a
        # single OperationPlan binds them under one writer lock and one
        # journal. Direct sequential _write_* are never called here.
        from .journal import hash_bytes
        from .paths import project_identity as _project_identity
        from .plan import TargetPlan, apply_plan, build_plan

        contract_rel = f".saipen/intake/contracts/{receipt_id}.json"
        revision_rel = f".saipen/intake/contracts/{receipt_id}.r{new_revision:03d}.json"
        coverage_rel = f".saipen/intake/coverage/{receipt_id}.json"
        contract_bytes = _json_bytes(contract)
        coverage_bytes = _json_bytes(ledger)
        contract_path = _safe_path(root, contract_rel, expect_file=True)
        revision_path = _safe_path(root, revision_rel, expect_file=True)
        coverage_path = _safe_path(root, coverage_rel, expect_file=True)
        if revision_path.exists():
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"contract revision already exists: {receipt_id} r{new_revision}",
            }

        def _before(path: Path) -> str:
            try:
                return hash_bytes(path.read_bytes())
            except FileNotFoundError:
                return ""

        rids = [rid for rid, _text, _klass, _env in normalized]
        if len(normalized) == 1:
            rid, _text, clause_class, when_environment = normalized[0]
            semantic_request = {
                "receipt": receipt_id,
                "rid": rid,
                "class": clause_class,
                "revision": new_revision,
                "when_environment": when_environment,
            }
            expected = {"ok": True, "code": "REQUIREMENT_ADDED", "receipt": receipt_id, "rid": rid}
        else:
            semantic_request = {
                "receipt": receipt_id,
                "rids": rids,
                "classes": [klass for _rid, _text, klass, _env in normalized],
                "revision": new_revision,
            }
            expected = {
                "ok": True,
                "code": "REQUIREMENT_ADDED",
                "receipt": receipt_id,
                "rids": rids,
            }
        plan = build_plan(
            operation="source.requirement_add",
            agent=_agent_for_intake(root),
            project_identity=_project_identity(root),
            semantic_request=semantic_request,
            preconditions={
                contract_rel: _before(contract_path),
                revision_rel: "",
                coverage_rel: _before(coverage_path),
            },
            targets=[
                TargetPlan(
                    contract_rel,
                    "contract",
                    contract_bytes,
                    _before(contract_path),
                    hash_bytes(contract_bytes),
                ),
                TargetPlan(
                    revision_rel,
                    "contract_revision",
                    contract_bytes,
                    "",
                    hash_bytes(contract_bytes),
                ),
                TargetPlan(
                    coverage_rel,
                    "coverage",
                    coverage_bytes,
                    _before(coverage_path),
                    hash_bytes(coverage_bytes),
                ),
            ],
            expected=expected,
        )
        committed = apply_plan(root, plan)
        if not committed.get("ok"):
            return {
                "ok": False,
                "code": committed.get("code", "VALIDATION_FAILED"),
                "receipt": receipt_id,
                "rid": rids[0] if len(rids) == 1 else None,
                "rids": rids,
                "detail": committed.get("message")
                or committed.get("detail", "plan apply failed"),
            }
        return {
            "ok": True,
            "code": "REQUIREMENT_ADDED",
            "receipt": receipt_id,
            "rids": rids,
            "revision": new_revision,
        }
    except (OSError, PermissionError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}


def _probe_environment_absence(environment: str) -> dict:
    """Mechanically prove a registry-declared host runtime is absent.

    Absence requires BOTH every declared runtime command to be missing and
    every declared host home to be absent. A stale home is conservative:
    UNKNOWN/PRESENT, never a waiver. The probe is read-only.
    """
    registry_path = (
        Path(__file__).resolve().parents[2] / "extensions" / "adapters" / "registry.json"
    )
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"ok": False, "code": "ENVIRONMENT_PROOF_UNAVAILABLE", "detail": str(exc)}
    adapter = next(
        (item for item in registry.get("adapters", []) if item.get("id") == environment), None
    )
    if not isinstance(adapter, dict):
        return {
            "ok": False,
            "code": "ENVIRONMENT_PROOF_UNAVAILABLE",
            "detail": f"environment {environment!r} is not registry-declared",
        }
    commands = adapter.get("runtime_commands") or []
    home = (adapter.get("install") or {}).get("home")
    homes = [home] if isinstance(home, str) and home.strip() else []
    if not commands or not homes:
        return {
            "ok": False,
            "code": "ENVIRONMENT_PROOF_UNAVAILABLE",
            "detail": f"environment {environment} lacks command+home absence probes",
        }
    command_rows = [{"name": name, "path": shutil.which(name)} for name in commands]
    home_rows = [
        {"path": value, "exists": Path(value).expanduser().exists()} for value in homes
    ]
    unavailable = all(row["path"] is None for row in command_rows) and all(
        not row["exists"] for row in home_rows
    )
    proof = {
        "schema_version": 1,
        "kind": "environment_absence",
        "environment": environment,
        "commands": command_rows,
        "homes": home_rows,
        "unavailable": unavailable,
        "observed_at": _utc(),
    }
    if not unavailable:
        return {
            "ok": False,
            "code": "ENVIRONMENT_PRESENT",
            "detail": f"{environment} runtime command or host home exists",
            "proof": proof,
        }
    return {"ok": True, "code": "ENVIRONMENT_ABSENT", "proof": proof}


def set_disposition(
    root: Path | str,
    receipt_id: str,
    rid: str,
    disposition: str,
    *,
    work: str | None = None,
    evidence: str | None = None,
    verification: str | None = None,
    environment: str | None = None,
) -> dict:
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    if disposition not in ALL_DISPOSITIONS:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": f"disposition {disposition!r}"}
    if re.fullmatch(r"R\d+", rid):
        rid = f"{receipt_id}:{rid}"
    try:
        with project_writer_lock(root):
            integrity = verify_integrity(root, receipt_id)
            if not integrity["ok"]:
                return integrity
            ledger = _read_coverage(root, receipt_id)
            if rid not in ledger["requirements"]:
                return {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"unknown requirement {rid}",
                }
            entry = ledger["requirements"][rid]
            environment_proof = None
            if disposition == "UNAVAILABLE_ENVIRONMENT":
                contract = _read_contract(root, receipt_id) or {}
                clause = (contract.get("clauses") or {}).get(rid) or {}
                declared = str(clause.get("when_environment") or "").strip()
                if not environment or declared != environment:
                    return {
                        "ok": False,
                        "code": "ENVIRONMENT_WAIVER_REFUSED",
                        "detail": (
                            "UNAVAILABLE_ENVIRONMENT requires a matching structured "
                            "when_environment clause and --environment probe"
                        ),
                    }
                probed = _probe_environment_absence(environment)
                if not probed.get("ok"):
                    return probed
                environment_proof = probed["proof"]
                evidence = evidence or f"mechanical environment absence probe: {environment}"
            if disposition in TERMINAL_DISPOSITIONS and entry.get("actionable", True):
                if not evidence:
                    return {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "terminal actionable disposition requires evidence",
                    }
                if disposition in {"IMPLEMENTED", "VERIFIED"} and not verification:
                    return {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "implemented/verified disposition requires verification",
                    }
            entry["disposition"] = disposition
            if work:
                entry["work"] = work
            if evidence:
                entry["evidence"] = evidence
            if verification:
                entry["verification"] = verification
            if environment_proof is not None:
                entry["environment_evidence"] = environment_proof
            elif disposition != "UNAVAILABLE_ENVIRONMENT":
                entry.pop("environment_evidence", None)
            _write_coverage(root, receipt_id, ledger)
            return {
                "ok": True,
                "code": "COVERAGE_UPDATED",
                "receipt": receipt_id,
                "rid": rid,
                "disposition": disposition,
            }
    except (OSError, PermissionError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}


#: The header the durable request document puts the operator's own words under
#: (`operations._user_request_body`). The seeded clause below IS that text, so
#: no new schema field is needed to recognize it later: a clause whose text
#: equals the request is the request's own clause, and one that does not is a
#: derived clause an agent wrote and owns.
REQUEST_HEADER = "## Request"


#: How much of a header-less body the fallback clause quotes. The clause is a
#: POINTER to the authoritative receipt, never a second copy of it.
REQUEST_FALLBACK_HEAD = 240

#: Kinds whose body IS the operator's own request, so "what was asked" needs
#: no interpretation to exist. An audit or an imported specification is NOT
#: here on purpose: its clauses are its individual findings, and one catch-all
#: clause would let a forty-finding audit close on a single disposition.
REQUEST_KINDS = ("user_instruction", "corrective_followup")


def request_clause_text(body: str) -> str:
    """The operator's own words inside a durable request document, or ""."""
    if REQUEST_HEADER not in body:
        return ""
    return body.split(REQUEST_HEADER, 1)[1].strip()


def canonical_request_clause_text(receipt_id: str, body: str, digest: str = "") -> str:
    """The ONE clause a captured user request always has: itself.

    A body written by `saipen start` carries the `## Request` header and its
    clause stays exactly the operator's words. A body that arrived through any
    OTHER ingress -- `saipen source capture --file`, the transport every
    operator handoff actually uses -- has no header, and the header-only
    derivation returned "" for it. The receipt then sat at requirements 0,
    `coverage_complete` needs `actionable > 0`, and `release_gate` fails closed
    SOURCE_UNRESOLVED for an unprojected receipt: three ordinary handoffs
    captured on 2026-09-22 (SRC-101/102/103) froze publication on arrival.

    The fallback clause NAMES the receipt and its digest instead of restating
    the request, because the authoritative bytes are the body and a truncated
    paraphrase must never read as the contract.
    """
    header_text = request_clause_text(body)
    if header_text:
        return header_text
    compact = " ".join(str(body or "").split())
    if not compact:
        return ""
    head = compact[:REQUEST_FALLBACK_HEAD]
    if len(compact) > REQUEST_FALLBACK_HEAD:
        head = head.rstrip() + "…"
    fingerprint = str(digest or "")[:12] or "unrecorded"
    return (
        f"Satisfy the captured request {receipt_id} in full; the authoritative "
        f"text is the receipt body (sha256 {fingerprint}): {head}"
    )


def ensure_request_clause(root: Path | str, receipt_id: str) -> dict:
    """Give a user request the one clause it always had: itself.

    The defect this ends, measured live on 2026-09-17: `saipen start` captured
    its receipt with an EMPTY contract, `coverage_complete` requires
    `actionable > 0`, so `work_closure_gate` answered SOURCE_UNRESOLVED for
    that receipt forever and the ticket the canonical entry command created
    could never be finished. Two field sessions drove the whole chain, edited
    their target, and then looped on `requirements 0, actionable 0`.

    A request is not zero requirements. It is exactly one, and it is the text
    the operator wrote. Deriving further clauses from a large specification
    stays an agent's semantic job; this only refuses to pretend that a request
    with no derived clauses asked for nothing.
    """
    root = Path(root)
    meta = _read_meta(root, receipt_id)
    if not meta or meta.get("source_kind") not in REQUEST_KINDS:
        return {"ok": False, "code": "NOT_A_USER_REQUEST", "receipt": receipt_id}
    contract = _read_contract(root, receipt_id) or {}
    if contract.get("clauses"):
        return {"ok": True, "code": "ALREADY_DERIVED", "receipt": receipt_id}
    body = read_body(root, receipt_id)
    if not body.get("ok"):
        return body
    text = canonical_request_clause_text(
        receipt_id, body.get("body") or "", str(meta.get("source_sha256") or "")
    )
    if not text:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": "request body has no request"}
    return add_requirement(root, receipt_id, rid="R001", text=text, clause_class="requirement")


def is_request_clause(root: Path | str, receipt_id: str, rid: str) -> bool:
    """True when this clause IS the request, not something an agent derived."""
    root = Path(root)
    contract = _read_contract(root, receipt_id) or {}
    clause = (contract.get("clauses") or {}).get(rid)
    if not isinstance(clause, dict):
        return False
    body = read_body(root, receipt_id)
    if not body.get("ok"):
        return False
    meta = _read_meta(root, receipt_id) or {}
    text = canonical_request_clause_text(
        receipt_id, body.get("body") or "", str(meta.get("source_sha256") or "")
    )
    return bool(text) and clause.get("text", "").strip() == text


def coverage_summary(root: Path | str, receipt_id: str) -> dict:
    root = Path(root)
    ledger = _read_coverage(root, receipt_id)
    return _coverage_summary_from_ledger(receipt_id, ledger)


def _coverage_summary_from_ledger(receipt_id: str, ledger: dict) -> dict:
    """Apply one strict coverage interpretation to active and archive data."""
    if not isinstance(ledger, dict) or not isinstance(ledger.get("requirements"), dict):
        raise ValueError(f"coverage {receipt_id} requirements is not an object")
    requirements = ledger["requirements"]
    counts: dict[str, int] = {}
    for rid, entry in requirements.items():
        if not isinstance(entry, dict):
            raise ValueError(f"coverage {receipt_id} requirement {rid} is not an object")
        if not isinstance(rid, str) or not re.fullmatch(rf"{re.escape(receipt_id)}:R\d+", rid):
            raise ValueError(f"coverage {receipt_id} has invalid requirement id {rid!r}")
        clause_class = entry.get("class")
        if clause_class not in CLAUSE_CLASSES or not isinstance(entry.get("text"), str):
            raise ValueError(
                f"coverage {receipt_id} requirement {rid} has invalid clause structure"
            )
        expected_actionable = clause_class in ACTIONABLE_CLASSES
        if entry.get("actionable", expected_actionable) is not expected_actionable:
            raise ValueError(f"coverage {receipt_id} requirement {rid} has invalid actionable flag")
        disp = entry.get("disposition", "UNKNOWN")
        if disp not in ALL_DISPOSITIONS:
            raise ValueError(f"coverage {receipt_id} requirement {rid} has invalid disposition")
        for field in ("evidence", "verification"):
            value = entry.get(field)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise ValueError(f"coverage {receipt_id} requirement {rid} has invalid {field}")
        when_environment = entry.get("when_environment")
        if when_environment is not None and (
            not isinstance(when_environment, str)
            or not re.fullmatch(r"[a-z0-9_-]+", when_environment)
        ):
            raise ValueError(f"coverage {receipt_id} requirement {rid} has invalid environment")
        if disp == "UNAVAILABLE_ENVIRONMENT":
            proof = entry.get("environment_evidence")
            if (
                not isinstance(proof, dict)
                or proof.get("kind") != "environment_absence"
                or proof.get("environment") != when_environment
                or proof.get("unavailable") is not True
                or not proof.get("commands")
                or not proof.get("homes")
            ):
                raise ValueError(
                    f"coverage {receipt_id} requirement {rid} lacks mechanical environment proof"
                )
        counts[disp] = counts.get(disp, 0) + 1
    actionable = {
        rid: entry
        for rid, entry in requirements.items()
        if entry.get("actionable", entry.get("class") in ACTIONABLE_CLASSES)
    }
    unresolved = [
        rid
        for rid, entry in actionable.items()
        if entry.get("disposition") not in TERMINAL_DISPOSITIONS
        or not entry.get("evidence")
        or (
            entry.get("disposition") in {"IMPLEMENTED", "VERIFIED"}
            and not entry.get("verification")
        )
    ]
    return {
        "receipt": receipt_id,
        "requirements": len(requirements),
        "actionable": len(actionable),
        "terminal": len(actionable) - len(unresolved),
        "dispositions": counts,
        "unresolved": unresolved,
    }


def coverage_complete(root: Path | str, receipt_id: str) -> bool:
    summary = coverage_summary(root, receipt_id)
    return summary["actionable"] > 0 and not summary["unresolved"]


def verify_integrity(root: Path | str, receipt_id: str) -> dict:
    """Reread boundary gate: stored body digest MUST equal recorded digest."""
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    meta = _read_meta(root, receipt_id)
    if not meta:
        return {"ok": False, "code": "INVALID", "detail": "receipt metadata missing"}
    try:
        rel = _canonical_body_rel(
            root, receipt_id, str(meta.get("source_sha256") or ""), "active"
        )
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    try:
        body = _read_owned_file(root, rel, kind="source body", max_bytes=_BODY_MAX)
    except FileNotFoundError:
        return {"ok": False, "code": "INVALID", "detail": "receipt body missing"}
    except (ValueError, OSError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    actual = hashlib.sha256(body).hexdigest()
    if actual != meta.get("source_sha256"):
        return {
            "ok": False,
            "code": "SOURCE_CORRUPTION",
            "recorded": meta.get("source_sha256"),
            "actual": actual,
        }
    return {"ok": True, "code": "SOURCE_INTEGRITY_OK", "receipt": receipt_id}


def _work_is_done(root: Path, work: str | None) -> bool:
    if not work:
        return True
    try:
        from .board import parse_board

        raw = _read_owned_file(
            root, ".saipen/BOARD.md", kind="source BOARD authority", max_bytes=_BOARD_MAX
        )
        board = parse_board(raw.decode("utf-8-sig"))
    except (OSError, ValueError):
        return False
    ticket = board.get("tickets", {}).get(work)
    return bool(ticket and ticket.get("section") == "## DONE")


def discharge_request_clauses(
    root: Path | str, work: str, *, evidence: str, verification: str
) -> list[str]:
    """Settle each linked request's OWN clause from the Work's own proof.

    One proof, not two. The ticket gate already demands explicit verification
    evidence for this Work; the clause being settled is the request that Work
    exists to answer, so asking an agent to restate the same proof in a second
    ledger -- through an API no CLI exposes -- was a ritual, and the ritual is
    what made the ticket unclosable.

    Only a clause that IS the request is touched (`is_request_clause`), and
    only while it is nonterminal. A clause an agent derived from a large
    specification is its own claim and is never settled from here.
    """
    root = Path(root)
    settled: list[str] = []
    try:
        board_links = _board_source_links(root).get(work, set())
    except (OSError, ValueError):
        return settled
    for receipt_id in sorted(board_links):
        if not _valid_receipt_id(receipt_id):
            continue
        meta = _read_meta(root, receipt_id)
        if not meta or not is_linked_to(meta, work):
            continue
        # ONE owner for "is this body the operator's own request". A second
        # literal here read `!= "user_instruction"` and silently skipped every
        # corrective_followup, so SRC-042 stayed unresolved after T-1326 was
        # already DONE -- a receipt no closure path would ever settle again.
        if meta.get("source_kind") not in REQUEST_KINDS:
            continue
        ensure_request_clause(root, receipt_id)
        try:
            summary = coverage_summary(root, receipt_id)
        except ValueError:
            continue
        for rid in summary["unresolved"]:
            if not is_request_clause(root, receipt_id, rid):
                continue
            outcome = set_disposition(
                root,
                receipt_id,
                rid,
                "VERIFIED",
                work=work,
                evidence=evidence,
                verification=verification,
            )
            if outcome.get("ok"):
                settled.append(rid)
    return settled


#: T-1452/SRC-103 M8. What a caller must do next for each coverage refusal.
#: A bare `{"code": "SOURCE_UNRESOLVED", "receipt": "SRC-007"}` sent two field
#: sessions digging through intake ledgers, and both surfaced with the same two
#: invented escapes: declaring the project MISROUTED_PROJECT_BINDING, and
#: hand-authoring an operator-authority capsule. Neither is a repair. A refusal
#: that cannot name its own next action gets one invented for it.
_COVERAGE_NEXT_COMMAND = {
    "SOURCE_UNRESOLVED": (
        "saipen source disp <SRC-###> <RID> <DISPOSITION> --work <T-###> "
        "--evidence <E-###> --verification '<command> -> PASS'"
    ),
    "SOURCE_LINKAGE_MISSING": (
        "saipen ticket repair-metadata <T-###> --field source_receipts --to <SRC-###>"
    ),
    "SOURCE_LINKAGE_DRIFT": "saipen source link <SRC-###> --work <T-###>",
    "SOURCE_RECEIPT_MISSING": "saipen source recover",
    "SOURCE_WORK_ACTIVE": "saipen continue --json",
    "SOURCE_CORRUPTION": "saipen source recover",
}


def route_source_refusal(
    root: Path | str,
    refusal: dict,
    *,
    work: str | None = None,
    release_scope: set | frozenset | None = None,
) -> dict:
    """Add the routing facts a coverage refusal has to carry to be actionable.

    One owner, so every gate answers the same shape: which receipt, which Work
    owns it, whether a contract was ever derived, which clauses are unresolved,
    whether the receipt is inside the release scope being shipped, and the
    exact canonical command that changes the answer. Best-effort by design --
    a refusal must never become an exception while explaining itself.
    """
    if not isinstance(refusal, dict) or refusal.get("ok"):
        return refusal
    code = str(refusal.get("code") or "")
    routed = dict(refusal)
    routed.setdefault("work", work)
    receipt_id = refusal.get("receipt")
    if isinstance(receipt_id, str) and _valid_receipt_id(receipt_id):
        try:
            meta = _read_meta(Path(root), receipt_id) or {}
        except (OSError, ValueError):
            meta = {}
        routed["source_status"] = meta.get("status")
        routed["linked_work"] = meta.get("linked_work")
        routed["linked_works"] = meta.get("linked_works") or (
            [meta["linked_work"]] if meta.get("linked_work") else []
        )
        try:
            contract = _read_contract(Path(root), receipt_id) or {}
        except (OSError, ValueError):
            contract = {}
        routed["contract_derived"] = bool(contract.get("clauses"))
        if "coverage" not in routed:
            try:
                routed["coverage"] = coverage_summary(root, receipt_id)
            except (OSError, ValueError):
                routed["coverage"] = None
        summary = routed.get("coverage")
        if isinstance(summary, dict):
            routed["unresolved_clauses"] = list(summary.get("unresolved") or [])
    # Release-scope membership is ALWAYS answered: True/False inside a release
    # evaluation, None when no release is being evaluated. An absent field
    # reads the same as "not in scope" to a caller that defaults it, and the
    # release gate used to return a relevant Work's refusal without it.
    if release_scope is None:
        routed["in_release_scope"] = None
    else:
        owner = routed.get("linked_work")
        routed["in_release_scope"] = bool(
            (routed.get("work") in release_scope)
            or (owner is not None and owner in release_scope)
        )
    if code == "SOURCE_UNRESOLVED" and routed.get("contract_derived") is False:
        # Nothing to dispose yet: the receipt has no contract at all, so
        # pointing at `source disp` would name a clause id that does not
        # exist. Zero clauses and unresolved clauses are different repairs.
        command = "saipen source req <SRC-###> R001 requirement '<what the receipt asks for>'"
    else:
        command = _COVERAGE_NEXT_COMMAND.get(code, "saipen status --json")
    # Fill in what the refusal already knows. A template that makes the caller
    # look up the receipt, the Work and the open clause is the archaeology
    # this owner exists to end; the caller supplies only its own decisions.
    if isinstance(receipt_id, str) and _valid_receipt_id(receipt_id):
        command = command.replace("<SRC-###>", receipt_id)
    work_id = routed.get("work") or routed.get("linked_work")
    if isinstance(work_id, str) and work_id:
        command = command.replace("<T-###>", work_id)
    unresolved = routed.get("unresolved_clauses") or []
    if unresolved and "<RID>" in command:
        command = command.replace("<RID>", str(unresolved[0]).rsplit(":", 1)[-1])
    if (
        command == "saipen source recover"
        and isinstance(work_id, str)
        and work_id
        and not recover_reports(root, receipt_id)
    ):
        # T-1476: same rule as closure_readiness -- a read-only diagnostic
        # that does not report this receipt is no route out.
        command = f'saipen ticket block {work_id} "source closure not ready ({code})"'
    routed["canonical_next_command"] = command
    # Said out loud, because both invented escapes were attempts to reclassify
    # a coverage fact as a binding fault.
    routed["binding_fault"] = False
    return routed


def work_closure_gate(root: Path | str, work: str) -> dict:
    """Mechanical DONE/SHIP gate for every active receipt linked to Work."""
    root = Path(root)
    try:
        index = _read_index(root)
        board_links = _board_source_links(root).get(work, set())
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc), "work": work}
    active_linked: set[str] = set()
    for receipt_id in index.get("active", {}):
        meta = _read_meta(root, receipt_id)
        if not meta or not is_linked_to(meta, work):
            continue
        active_linked.add(receipt_id)
    missing_projection = active_linked - board_links
    if missing_projection:
        receipt_id = min(missing_projection)
        return route_source_refusal(
            root,
            {
                "ok": False,
                "code": "SOURCE_LINKAGE_MISSING",
                "receipt": receipt_id,
                "work": work,
            },
            work=work,
        )
    linked: list[str] = []
    for receipt_id in sorted(board_links):
        if not _valid_receipt_id(receipt_id):
            return _invalid_receipt_id(receipt_id) | {"work": work}
        meta = _read_meta(root, receipt_id) if receipt_id in index.get("active", {}) else None
        if not meta:
            tomb = index.get("tombstones", {}).get(receipt_id)
            if (
                isinstance(tomb, dict)
                and tomb.get("status") == CLOSED_STATUS
                and work in (tomb.get("linked_works") or [tomb.get("linked_work")])
            ):
                linked.append(receipt_id)
                continue
            return route_source_refusal(
                root,
                {
                    "ok": False,
                    "code": "SOURCE_RECEIPT_MISSING",
                    "receipt": receipt_id,
                    "work": work,
                },
                work=work,
            )
        if not is_linked_to(meta, work):
            return route_source_refusal(
                root,
                {
                    "ok": False,
                    "code": "SOURCE_LINKAGE_DRIFT",
                    "receipt": receipt_id,
                    "work": work,
                },
                work=work,
            )
        linked.append(receipt_id)
        integrity = verify_integrity(root, receipt_id)
        if not integrity["ok"]:
            return integrity | {"receipt": receipt_id, "work": work}
        contract_gate = _contract_integrity(root, receipt_id, meta)
        if not contract_gate["ok"]:
            return contract_gate | {"work": work}
        summary = coverage_summary(root, receipt_id)
        if not coverage_complete(root, receipt_id):
            return route_source_refusal(
                root,
                {
                    "ok": False,
                    "code": "SOURCE_UNRESOLVED",
                    "receipt": receipt_id,
                    "work": work,
                    "coverage": summary,
                },
                work=work,
            )
    return {"ok": True, "code": "SOURCE_COVERAGE_COMPLETE", "work": work, "receipts": linked}


def boundary_gate(root: Path | str, work: str, boundary: str) -> dict:
    """Real targeted original-body read at meaningful execution boundaries."""
    root = Path(root)
    try:
        index = _read_index(root)
        board_links = _board_source_links(root).get(work, set())
    except (OSError, ValueError) as exc:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": str(exc),
            "boundary": boundary,
        }
    checked: list[str] = []
    for receipt_id in sorted(board_links):
        if not _valid_receipt_id(receipt_id):
            return _invalid_receipt_id(receipt_id) | {"boundary": boundary}
        meta = _read_meta(root, receipt_id) if receipt_id in index.get("active", {}) else None
        if not meta:
            return {
                "ok": False,
                "code": "SOURCE_RECEIPT_MISSING",
                "receipt": receipt_id,
                "boundary": boundary,
            }
        if not is_linked_to(meta, work):
            return {
                "ok": False,
                "code": "SOURCE_LINKAGE_DRIFT",
                "receipt": receipt_id,
                "boundary": boundary,
            }
        integrity = verify_integrity(root, receipt_id)
        if not integrity["ok"]:
            return integrity | {"receipt": receipt_id, "boundary": boundary}
        contract_gate = _contract_integrity(root, receipt_id, meta)
        if not contract_gate["ok"]:
            return contract_gate | {"boundary": boundary}
        checked.append(receipt_id)
    return {
        "ok": True,
        "code": "SOURCE_REREAD_OK",
        "boundary": boundary,
        "receipts": checked,
    }


def _legacy_sensitive_source_gate(root: Path) -> dict:
    """Block release/export of credential-bearing or lost-original source bytes.

    CORE-001 moved credential handling OUT of the capture path, so an exact
    authoritative body may legitimately contain a credential. Publication is
    still refused -- the difference is that the refusal no longer costs the
    receipt its bytes: nothing here rewrites the canonical body, and a masked
    view is never substituted for it.

    Two refusal classes plus one truthful admission:
      * a body whose bytes still match a credential pattern -> refuse, because
        releasing it publishes the credential;
      * an ACTIVE receipt whose stored bytes are a pre-CORE-001 redacted
        derivative -> refuse, because active receipts drive execution and their
        authority must be exact;
      * an ARCHIVED derivative is recorded honestly as a lost original and does
        not block, because its Work is closed and no execution reads it.
    """
    try:
        index = _read_index(root)
        candidates = set(index.get("active", {})) | set(index.get("tombstones", {}))
        for directory in (_active_dir(root), _archive_dir(root)):
            if directory.is_dir() and not _is_link_or_reparse(directory):
                candidates.update(
                    path.name.split(".", 1)[0]
                    for path in directory.glob("SRC-*.meta.json")
                    if INTENT_RE.fullmatch(path.name.split(".", 1)[0])
                )
        lost_originals: list[str] = []
        quarantined: list[str] = []
        for receipt_id in sorted(candidates):
            meta = _read_meta(root, receipt_id)
            location = "active"
            if meta is None:
                try:
                    raw_meta = _read_owned_file(
                        root,
                        f".saipen/archive/source/{receipt_id}.meta.json",
                        kind="source archive metadata",
                        max_bytes=_META_MAX,
                    )
                    meta = json.loads(raw_meta.decode("utf-8-sig"))
                    location = "archive"
                except FileNotFoundError:
                    continue
            if not isinstance(meta, dict):
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"{location} metadata {receipt_id} is not an object",
                }
            authority = _source_authority(meta)
            # Metadata written before CORE-001 carries no `source_authority`
            # record. For those, `sensitive=True` with `applied=False` really
            # did mean "captured in the redaction window and left unmasked";
            # for current metadata it is the ordinary state of an exact
            # sensitive capture, so the legacy reading must not apply.
            legacy_metadata = "source_authority" not in meta
            redaction = meta.get("redaction")
            applied = isinstance(redaction, dict) and redaction.get("applied") is True
            digest = meta.get("source_sha256")
            if not isinstance(digest, str):
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"{location} source {receipt_id} has no content digest",
                }
            distribution = _distribution_projection(root, receipt_id, digest)
            rel = _canonical_body_rel(root, receipt_id, digest, location)
            try:
                body = _read_owned_file(
                    root, rel, kind="source body", max_bytes=_BODY_MAX
                ).decode("utf-8")
            except FileNotFoundError:
                continue
            except (UnicodeDecodeError, OSError, ValueError) as exc:
                return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
            if hashlib.sha256(body.encode("utf-8")).hexdigest() != digest:
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"{location} source {receipt_id} digest mismatch",
                }
            if legacy_metadata and meta.get("sensitive") is True and not applied:
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION",
                    "detail": f"legacy sensitive unsanitized {location} source {receipt_id}",
                }
            if _redact_text(body) != body and distribution["state"] != QUARANTINED:
                quarantine_command = (
                    f"saipen source quarantine {receipt_id} --reason CREDENTIAL_PATTERN"
                )
                return {
                    "ok": False,
                    "code": "SOURCE_CORRUPTION" if legacy_metadata else "SOURCE_CREDENTIALS_UNSAFE",
                    "detail": (
                        f"unsanitized credential pattern in {location} source {receipt_id}"
                        if legacy_metadata
                        else (
                            f"credential pattern in exact {location} source {receipt_id}; "
                            f"run {quarantine_command} to preserve local authority "
                            "and exclude the body from release"
                        )
                    ),
                    **(
                        {"receipt": receipt_id, "canonical_next_command": quarantine_command}
                        if not legacy_metadata
                        else {}
                    ),
                }
            if distribution["state"] == QUARANTINED:
                quarantined.append(receipt_id)
            if authority["mode"] == "redacted-derivative":
                if location == "active":
                    return {
                        "ok": False,
                        "code": "SOURCE_ORIGINAL_LOST",
                        "detail": (
                            f"active source {receipt_id} stores a redacted derivative; "
                            "capture the exact original or an amendment before release"
                        ),
                    }
                lost_originals.append(receipt_id)
    except (OSError, ValueError, UnicodeError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    return {
        "ok": True,
        "code": "SOURCE_CREDENTIALS_SAFE",
        "lost_originals": tuple(lost_originals),
        "quarantined": tuple(quarantined),
    }




@dataclass(frozen=True)
class _ReleaseScopeTrust:
    """Trust verdict for one existing release-scope authority record."""

    status: str
    paths: frozenset[str] = frozenset()
    code: str = ""
    detail: str = ""


@dataclass(frozen=True)
class _ReleaseRelevance:
    work: frozenset[str]
    uncertain_work: str | None = None
    scope: _ReleaseScopeTrust | None = None


def _scope_trust(
    status: str, code: str, detail: str, *, paths: set[str] | None = None
) -> _ReleaseScopeTrust:
    return _ReleaseScopeTrust(status, frozenset(paths or ()), code, detail)


def _scope_refusal_trust(exc: Exception) -> _ReleaseScopeTrust:
    """Map one writer-side scope refusal onto the gate's trust vocabulary."""
    code = getattr(exc, "code", "")
    status = {
        "SOURCE_SCOPE_MISSING": "NO_SCOPE",
        "STALE_PLAN": "STALE_SCOPE",
        "PATH_ESCAPE": "FOREIGN_SCOPE",
    }.get(code, "INVALID_SCOPE")
    return _scope_trust(status, code, getattr(exc, "detail", str(exc)))


def _release_scope_trust(root: Path, work: str, source_identity: object) -> _ReleaseScopeTrust:
    """Validate one scope through the writer's source/content identity contract.

    Scope absence or corruption is uncertainty, never evidence of disjointness.
    The status remains separate from paths so callers cannot collapse UNKNOWN
    relevance into an empty set.

    Two legitimate bindings exist. A FRESH scope was reviewed at the live HEAD
    and its tree fingerprint must still match exactly. A CONTINUATION scope was
    reviewed before the release's own content/closure commits landed, so its
    reviewed HEAD is an ancestor of the live HEAD and every reviewed path must
    still hash to its live bytes (the writer's own continuation contract). The
    defect this closes: loading only the fresh binding made every in-flight
    release -- the post-release retry and the fresh-clone continuation above
    all -- fail closed as STALE_SCOPE the moment its own commits moved HEAD.
    """
    if not isinstance(work, str) or not re.fullmatch(r"T-\d+", work):
        return _scope_trust(
            "INVALID_SCOPE", "RECOVERY_CONFLICT", f"invalid release-scope Work id {work!r}"
        )
    from .release import ReleaseRefusal, _load_scope

    live_head = getattr(source_identity, "source_head", None)
    live_tree = getattr(source_identity, "source_tree_fingerprint", None)
    fresh = True
    try:
        record = _load_scope(root, work, live_head, live_tree, continuation=False)
    except ReleaseRefusal as exc:
        if exc.code != "STALE_PLAN":
            return _scope_refusal_trust(exc)
        try:
            record = _load_scope(root, work, live_head, live_tree, continuation=True)
        except ReleaseRefusal as continuation_exc:
            return _scope_refusal_trust(continuation_exc)
        fresh = False
    except (OSError, ValueError, UnicodeError) as exc:
        return _scope_trust(
            "RECOVERY_CONFLICT",
            f"cannot validate release scope for {work}: {exc}",
        )
    recorded_tree = record.get("source_tree_fingerprint")
    if not isinstance(recorded_tree, str):
        return _scope_trust(
            "INVALID_SCOPE", "RECOVERY_CONFLICT", f"release scope for {work} lacks tree identity"
        )
    if fresh and recorded_tree != live_tree:
        return _scope_trust(
            "STALE_SCOPE",
            "STALE_PLAN",
            f"release scope tree identity for {work} differs from the live tree",
        )
    paths = set(record["paths"])
    return _scope_trust(
        "TRUSTED_SCOPE", "SOURCE_SCOPE_TRUSTED", f"release scope for {work} is current",
        paths=paths,
    )


def _release_relevant_work(
    root: Path, current_work: str | None, board_links: dict[str, set[str]]
) -> _ReleaseRelevance:
    """Work that may constrain publication of the CURRENT release artifact.

    Closure is scoped to release-relevant Work: the current Work always, plus
    any other Work whose recorded reviewed release scope overlaps the artifact
    (transitively -- a contributing Work's own scope joins the artifact). With
    no named release target the old repository-wide scope is preserved, which
    keeps the fail-closed behaviour wherever a caller cannot name an artifact.
    """
    if not current_work:
        return _ReleaseRelevance(frozenset(board_links))
    try:
        from freshness import compute_source_identity

        source_identity = compute_source_identity(root)
    except Exception as exc:
        scope = _scope_trust(
            "INVALID_SCOPE",
            "VALIDATION_FAILED",
            f"cannot compute source identity for release relevance: {exc}",
        )
        return _ReleaseRelevance(frozenset({current_work}), current_work, scope)

    scopes: dict[str, _ReleaseScopeTrust] = {}
    for work in sorted(set(board_links) | {current_work}):
        if work != current_work and _work_is_done(root, work):
            continue
        scope = _release_scope_trust(root, work, source_identity)
        if scope.status != "TRUSTED_SCOPE":
            return _ReleaseRelevance(frozenset({current_work}), work, scope)
        scopes[work] = scope

    relevant = {current_work}
    frontier = set(scopes[current_work].paths)
    changed = True
    while changed:
        changed = False
        for work, scope in sorted(scopes.items()):
            if work in relevant:
                continue
            paths = set(scope.paths)
            if paths and paths & frontier:
                relevant.add(work)
                frontier |= paths
                changed = True
    return _ReleaseRelevance(frozenset(relevant))


def _route_release_refusal(root: Path, gate: dict, work: str, relevant) -> dict:
    """A Work closure refusal, re-answered in the release being evaluated.

    `work_closure_gate` knows nothing about a release, so its refusal carried
    no release-scope membership when the release gate passed it on unchanged
    (T-1455). Only coverage refusals are re-routed; a validation or integrity
    answer keeps exactly the shape its own owner gave it.
    """
    if str(gate.get("code") or "").startswith("SOURCE_"):
        return route_source_refusal(root, gate, work=work, release_scope=relevant)
    return gate


def release_gate(root: Path | str, current_work: str | None = None) -> dict:
    """Fail ship closed while active source coverage that CAN affect this release
    artifact is unresolved.

    Two classes of gate are deliberately kept apart:

    * REPOSITORY AUTHORITY / INTEGRITY -- credentials, receipt/index integrity
      and unprojected authoritative receipts -- stays global: a corrupt or
      unowned source must freeze every publication.
    * WORK CLOSURE -- receipt coverage for a Work -- is scoped to Work whose
      recorded release scope overlaps the artifact being released. An unrelated
      parked Work no longer freezes an independent release.
    """
    root = Path(root)
    credential_gate = _legacy_sensitive_source_gate(root)
    if not credential_gate["ok"]:
        return credential_gate
    try:
        board_links = _board_source_links(root)
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}
    try:
        relevance = _release_relevant_work(root, current_work, board_links)
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    if relevance.scope is not None:
        return {
            "ok": False,
            "code": relevance.scope.code,
            "detail": relevance.scope.detail,
            "work": relevance.uncertain_work,
            "scope_status": relevance.scope.status,
        }
    relevant = set(relevance.work)
    checked: set[str] = set()
    for work in sorted(relevant):
        gate = work_closure_gate(root, work)
        if not gate.get("ok"):
            return _route_release_refusal(root, gate, work, relevant)
        checked.update(gate.get("receipts", []))
        if work != current_work and not _work_is_done(root, work):
            return route_source_refusal(
                root,
                {"ok": False, "code": "SOURCE_WORK_ACTIVE", "work": work},
                work=work,
                release_scope=relevant,
            )
    try:
        receipts = active_receipts(root)
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    for item in receipts:
        receipt_id = item["receipt"]
        if receipt_id in checked:
            continue
        # Integrity is repository-global: a receipt whose body no longer matches
        # its recorded digest fails closed for EVERY release, relevant or not.
        integrity = verify_integrity(root, receipt_id)
        if not integrity["ok"]:
            return integrity | {"receipt": receipt_id}
        linked = item.get("linked_work")
        if not linked:
            # UNPROJECTED authoritative receipt: no Work owns its closure, so
            # the repository answers for it -- fail closed.
            if not coverage_complete(root, receipt_id):
                return route_source_refusal(
                    root,
                    {
                        "ok": False,
                        "code": "SOURCE_UNRESOLVED",
                        "receipt": receipt_id,
                        "detail": (
                            "an authoritative receipt no BOARD Work projects: the "
                            "repository answers for its coverage, so link it to the "
                            "Work that owns it or resolve its clauses"
                        ),
                    },
                    release_scope=relevant,
                )
            continue
        if linked in relevant:
            gate = work_closure_gate(root, linked)
            if not gate.get("ok"):
                return _route_release_refusal(root, gate, linked, relevant)
            checked.update(gate.get("receipts", []))
            continue
        if linked not in board_links:
            # A projection naming no BOARD Work is untrustworthy: refuse
            # regardless of release scope.
            return route_source_refusal(
                root,
                {
                    "ok": False,
                    "code": "SOURCE_WORK_ACTIVE",
                    "receipt": receipt_id,
                    "work": linked,
                },
                work=linked,
                release_scope=relevant,
            )
        # Projected to an unrelated Work: coverage is Work-scoped and does not
        # gate this artifact. Integrity was proven above.
    return {
        "ok": True,
        "code": "SOURCE_RELEASE_COVERAGE_COMPLETE",
        "receipts": sorted(checked | {item["receipt"] for item in receipts}),
    }


def _is_archive_commit_pending(root: Path, receipt_id: str, index: dict) -> bool:
    """True when `receipt_id` sits in an interrupted close (CORE-003): still
    indexed as active, the active surface is cleared, and complete archived
    artifacts are present. This is the resumable crash state the close
    transaction must settle before it can be retried.

    CLEARED IS PARTIAL (T-1346). The transaction moves the body, then unlinks
    the active metadata, so a crash between those two steps leaves exactly ONE
    active artifact behind. Requiring the metadata to be gone missed that real
    window and answered a generic `INVALID receipt body missing` for a state
    whose archive bundle is the proof the retry must consult -- measured on
    the corrupt-partial fixture, which must refuse SOURCE_CORRUPTION, and on
    the body-limit recovery fixture, which must classify as pending. The body
    probe resolves through the digest-bound distribution overlay, so a
    quarantined body (which the close never moves) is found at its quarantine
    path.
    """
    if not isinstance(index.get("active", {}).get(receipt_id), dict):
        return False
    projection = index["active"][receipt_id]
    digest = projection.get("source_sha256")
    if not isinstance(digest, str):
        return False
    try:
        active_body_rel = _canonical_body_rel(root, receipt_id, digest, "active")
        archive_body_rel = _canonical_body_rel(root, receipt_id, digest, "archive")
    except (OSError, ValueError):
        return False
    active_present: list[bool] = []
    for active_rel, max_bytes in (
        (active_body_rel, _BODY_MAX),
        (f".saipen/intake/active/{receipt_id}.meta.json", _META_MAX),
    ):
        try:
            _read_owned_file(root, active_rel, kind="source receipt probe", max_bytes=max_bytes)
        except FileNotFoundError:
            active_present.append(False)
            continue
        except (ValueError, OSError):
            return False
        active_present.append(True)
    try:
        _read_owned_file(
            root,
            f".saipen/archive/source/{receipt_id}.meta.json",
            kind="source archive probe",
            max_bytes=_META_MAX,
        )
        _read_owned_file(
            root,
            archive_body_rel,
            kind="source archive probe",
            max_bytes=_BODY_MAX,
        )
    except (FileNotFoundError, ValueError, OSError):
        return False
    return not all(active_present)


def _closed_archive_bundle(
    root: Path,
    receipt_id: str,
    projection: dict,
    *,
    allow_active_fallback: bool = False,
) -> tuple[dict, dict, dict, dict]:
    """Read and prove every carrier required for a closed receipt."""
    meta_raw = _read_owned_file(
        root,
        f".saipen/archive/source/{receipt_id}.meta.json",
        kind="source archive metadata",
        max_bytes=_META_MAX,
    )
    meta = json.loads(meta_raw.decode("utf-8-sig"))
    if not isinstance(meta, dict):
        raise ValueError("archive metadata is not an object")
    expected_digest = projection.get("source_sha256")
    if not isinstance(expected_digest, str):
        raise ValueError(f"archive projection {receipt_id} has no content digest")
    expected_ref = _canonical_body_rel(
        root, receipt_id, expected_digest, "archive"
    )
    if (
        meta.get("receipt_id") != receipt_id
        or meta.get("source_sha256") != expected_digest
        or meta.get("status") != CLOSED_STATUS
        or meta.get("storage_status") != ARCHIVED_STATUS
        or not _archive_ref_matches(meta.get("archive_ref"), receipt_id, expected_ref)
        or meta.get("linked_work") != projection.get("linked_work")
        or meta.get("source_kind") not in SOURCE_KINDS
        or meta.get("schema_version") != SCHEMA_VERSION
    ):
        raise ValueError(f"archived metadata {receipt_id} identity/status drift")
    for field in ("received_at", "closed_at", "reread_at"):
        value = meta.get(field)
        if not isinstance(value, str) or not value:
            raise ValueError(f"archived metadata {receipt_id} has invalid {field}")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"archived metadata {receipt_id} has invalid {field}") from exc
        if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed):
            raise ValueError(f"archived metadata {receipt_id} {field} is not UTC")
    redaction = meta.get("redaction")
    if redaction is not None:
        if not isinstance(redaction, dict) or not isinstance(redaction.get("applied"), bool):
            raise ValueError(f"archived metadata {receipt_id} has invalid redaction metadata")
        sanitized_digest = redaction.get("sanitized_sha256")
        if (
            not isinstance(sanitized_digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", sanitized_digest)
        ):
            raise ValueError(f"archived metadata {receipt_id} has invalid sanitized digest")

    body = _read_owned_file(
        root,
        expected_ref,
        kind="source archive body",
        max_bytes=_BODY_MAX,
    )
    body_digest = hashlib.sha256(body).hexdigest()
    if body_digest != expected_digest:
        raise ValueError(f"archived body {receipt_id} digest mismatch")
    if isinstance(redaction, dict) and redaction.get("sanitized_sha256") != body_digest:
        raise ValueError(f"archived metadata {receipt_id} redaction digest drift")
    if meta.get("sensitive") is True and not isinstance(redaction, dict):
        raise ValueError(
            f"archived metadata {receipt_id} sensitive source lacks redaction metadata"
        )

    def read_artifact(label: str) -> bytes:
        archive_rel = f".saipen/archive/source/{receipt_id}.{label}.json"
        active_dir = "contracts" if label == "contract" else "coverage"
        active_rel = f".saipen/intake/{active_dir}/{receipt_id}.json"
        try:
            archived = _read_owned_file(
                root, archive_rel, kind=f"source {label}", max_bytes=_LEDGER_MAX
            )
        except FileNotFoundError:
            if not allow_active_fallback:
                raise
            return _read_owned_file(
                root, active_rel, kind=f"source {label}", max_bytes=_LEDGER_MAX
            )
        if allow_active_fallback:
            try:
                active = _read_owned_file(
                    root, active_rel, kind=f"active source {label}", max_bytes=_LEDGER_MAX
                )
            except FileNotFoundError:
                return archived
            if active != archived:
                raise ValueError(f"active and archived {label} disagree for {receipt_id}")
        return archived

    contract = json.loads(read_artifact("contract").decode("utf-8-sig"))
    coverage = json.loads(read_artifact("coverage").decode("utf-8-sig"))
    if not isinstance(contract, dict) or contract.get("source_sha256") != expected_digest:
        raise ValueError(f"archived Contract {receipt_id} digest drift")
    _validate_contract_coverage(receipt_id, contract, coverage)
    summary = _coverage_summary_from_ledger(receipt_id, coverage)
    if not summary["actionable"] or summary["unresolved"]:
        raise ValueError(
            f"archived coverage {receipt_id} unresolved: {summary['unresolved']}"
        )
    # W2-004: validate the archived revision chain is contiguous r001..rN
    _validate_archive_revisions(root, receipt_id, contract)
    return meta, contract, coverage, summary


def _validate_archive_revisions(root: Path, receipt_id: str, contract: dict) -> None:
    """Validate archived contract revision chain (W2-004)."""
    revision = contract.get("interpretation_revision", 0)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise ValueError(
            f"source {receipt_id} archived contract has invalid interpretation revision"
        )
    expected = set(range(1, revision + 1))
    found: set[int] = set()
    for path in sorted(root.glob(f".saipen/archive/source/{receipt_id}.r*.json")):
        if path.is_file() and not _is_link_or_reparse(path):
            match = re.fullmatch(rf"{re.escape(receipt_id)}\.r(\d+)\.json", path.name)
            if match:
                found.add(int(match.group(1)))
    if found != expected:
        raise ValueError(
            f"source {receipt_id} archived contract revision chain is not contiguous: "
            f"expected {sorted(expected)}, found {sorted(found)}"
        )


def _settle_archive_commit(root: Path, receipt_id: str, index: dict) -> dict | None:
    """Settle an ARCHIVE_COMMIT_PENDING close transaction (CORE-003).

    Never infers closure from an archive body alone: it verifies the archived
    body digest and the archived Contract/coverage ledger against the
    still-indexed projection, reconstructs and writes the EXACT tombstone from
    the archived metadata (which retains the close evidence), then atomically
    settles the index active->tombstone. Returns the ``SOURCE_CLOSED`` result
    on success, a stable refusal on any evidence failure, or None when the
    receipt is not in a pending-close state.
    """
    projection = index.get("active", {}).get(receipt_id)
    if not isinstance(projection, dict):
        return None
    try:
        archived_meta, _archived_contract, _archived_cov, summary = _closed_archive_bundle(
            root, receipt_id, projection, allow_active_fallback=True
        )
    except FileNotFoundError:
        return None
    except (ValueError, OSError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    expected_digest = projection.get("source_sha256")
    requirements = summary["requirements"]
    actionable = summary["actionable"]
    tombstone = {
        "schema_version": SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "source_sha256": expected_digest,
        "linked_work": archived_meta.get("linked_work"),
        "status": CLOSED_STATUS,
        "closed_at": archived_meta.get("closed_at"),
        "closure_event": archived_meta.get("closure_event"),
        "archive_ref": archived_meta.get("archive_ref"),
        "requirements": requirements,
        "actionable": actionable,
        "unresolved": len(summary["unresolved"]),
    }
    # Evidence is now proven. Finish only missing idempotent artifact moves;
    # malformed evidence returned above before any write.
    try:
        _finish_archive_bundle_locked(root, receipt_id)
    except (OSError, ValueError) as exc:
        return {
            "ok": False,
            "code": "ARCHIVE_COMMIT_PENDING",
            "receipt": receipt_id,
            "detail": str(exc),
        }
    _write_tombstone(root, receipt_id, tombstone)

    index["active"].pop(receipt_id, None)
    index["tombstones"][receipt_id] = tombstone
    _write_index(root, index)
    return {
        "ok": True,
        "code": "SOURCE_CLOSED",
        "receipt": receipt_id,
        "status": CLOSED_STATUS,
        "archive_ref": tombstone["archive_ref"],
        "recovered": True,
    }


def _move_archive_artifact(
    root: Path,
    source: Path,
    destination: Path,
    *,
    label: str,
    required: bool,
) -> None:
    """Idempotently complete one owned active->archive move."""
    try:
        source_stat = prove_owned_regular(source, kind=f"active {label}")
    except FileNotFoundError:
        source_stat = None
    try:
        destination_stat = prove_owned_regular(destination, kind=f"archived {label}")
    except FileNotFoundError:
        destination_stat = None
    if source_stat is not None and destination_stat is not None:
        source_raw = read_bound_regular_bytes(source, source_stat, max_bytes=_BODY_MAX)
        destination_raw = read_bound_regular_bytes(
            destination, destination_stat, max_bytes=_BODY_MAX
        )
        if source_raw != destination_raw:
            raise ValueError(f"active and archived {label} disagree for {source.name}")
        safe_unlink_owned(source, kind=f"duplicate active {label}", ownership_root=root)
        return
    if source_stat is None:
        if destination_stat is not None or not required:
            return
        raise ValueError(f"both active and archived {label} are missing for {source.name}")
    prove_owned_dir_chain(destination.parent, kind=f"archive {label}", ownership_root=root)
    os.replace(source, destination)


def _finish_archive_bundle_locked(root: Path, receipt_id: str) -> None:
    """Complete artifact moves after a pending close bundle is validated."""
    contract = _read_contract(root, receipt_id)
    if contract is None:
        # Active Contract already moved to archive during an interrupted close
        # -- the archived Contract is the canonical authority for the
        # remaining revision chain. Use the one that exposes a non-empty
        # interpretation_revision without rewriting bytes.
        archive_contract_rel = f".saipen/archive/source/{receipt_id}.contract.json"
        try:
            raw = _read_owned_file(
                root, archive_contract_rel, kind="source archive Contract", max_bytes=_LEDGER_MAX
            )
        except FileNotFoundError as exc:
            raise ValueError(
                f"active Contract missing for {receipt_id} and no archive copy: {exc}"
            ) from exc
        contract = json.loads(raw.decode("utf-8-sig"))
        if not isinstance(contract, dict):
            raise ValueError(f"archived Contract {receipt_id} is not an object")
    # W2-004: move exactly the validated contiguous revision chain r001..rN.
    _contract_revision_integrity(root, receipt_id, contract)
    expected_revisions = set(range(1, int(contract.get("interpretation_revision", 0)) + 1))
    for label, path in (
        ("coverage", _coverage_path(root, receipt_id)),
        ("contract", _contract_path(root, receipt_id)),
    ):
        destination = _safe_path(
            root,
            f".saipen/archive/source/{receipt_id}.{label}.json",
            expect_file=True,
        )
        _move_archive_artifact(root, path, destination, label=label, required=True)
    contract_dir = _contract_dir(root)
    archive_dir = _archive_dir(root)
    for number in sorted(expected_revisions):
        active_revision = (
            contract_dir / f"{receipt_id}.r{number:03d}.json"
            if contract_dir.is_dir() and not _is_link_or_reparse(contract_dir)
            else None
        )
        archived_revision = (
            archive_dir / f"{receipt_id}.r{number:03d}.json"
            if archive_dir.is_dir() and not _is_link_or_reparse(archive_dir)
            else None
        )
        if (active_revision and active_revision.is_file()
                and not _is_link_or_reparse(active_revision)):
            revision = _safe_path(
                root,
                f".saipen/intake/contracts/{receipt_id}.r{number:03d}.json",
                expect_file=True,
            )
            destination = _safe_path(
                root, f".saipen/archive/source/{revision.name}", expect_file=True
            )
            _move_archive_artifact(
                root, revision, destination, label="contract revision", required=True
            )
        elif (archived_revision and archived_revision.is_file()
              and not _is_link_or_reparse(archived_revision)):
            # already in archive from a prior _archive_closed_locked call; fine
            continue
        else:
            raise ValueError(
                f"source {receipt_id} revision r{number:03d} missing at archive time"
            )


def _archive_closed_locked(root: Path, receipt_id: str, meta: dict) -> dict:
    archive = _archive_dir(root)
    digest = meta.get("source_sha256")
    if not isinstance(digest, str):
        raise ValueError(f"source {receipt_id} metadata has no content digest")
    distribution = _distribution_projection(root, receipt_id, digest)
    body_rel = _canonical_body_rel(root, receipt_id, digest, "active")
    archive_ref = _canonical_body_rel(root, receipt_id, digest, "archive")
    body = _safe_path(root, body_rel, expect_file=True)
    active_meta = _safe_path(
        root, f".saipen/intake/active/{receipt_id}.meta.json", expect_file=True
    )
    archive_body = _safe_path(root, f".saipen/archive/source/{receipt_id}.md", expect_file=True)
    archive_meta = _safe_path(
        root, f".saipen/archive/source/{receipt_id}.meta.json", expect_file=True
    )
    archive.mkdir(parents=True, exist_ok=True)
    meta = dict(meta)
    meta["storage_status"] = ARCHIVED_STATUS
    meta["archive_ref"] = archive_ref
    _atomic_write(archive_meta, _json_bytes(meta), ownership_root=root)
    if distribution["state"] == QUARANTINED:
        raw = _read_owned_file(
            root, body_rel, kind="quarantined source body", max_bytes=_BODY_MAX
        )
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError(f"quarantined source body {receipt_id} digest mismatch")
    else:
        _move_archive_artifact(root, body, archive_body, label="source body", required=True)
    safe_unlink_owned(active_meta, kind="active source metadata", ownership_root=root)
    for label, path in (
        ("coverage", _coverage_path(root, receipt_id)),
        ("contract", _contract_path(root, receipt_id)),
    ):
        destination = _safe_path(
            root,
            f".saipen/archive/source/{receipt_id}.{label}.json",
            expect_file=True,
        )
        _move_archive_artifact(root, path, destination, label=label, required=True)
    for revision in sorted(_contract_dir(root).glob(f"{receipt_id}.r*.json")):
        if revision.is_file() and not _is_link_or_reparse(revision):
            destination = _safe_path(
                root, f".saipen/archive/source/{revision.name}", expect_file=True
            )
            _move_archive_artifact(
                root, revision, destination, label="contract revision", required=True
            )
    return {
        "ok": True,
        "code": "SOURCE_ARCHIVED",
        "receipt": receipt_id,
        "archive_ref": meta["archive_ref"],
    }


def _settle_closed_residue_locked(root: Path, receipt_id: str, tomb: dict) -> dict:
    """Remove stale `active/` bytes for a receipt that is ALREADY closed.

    The close transaction archives the body, then unlinks the active body and
    metadata. A crash between those steps (or a foreign restore of the hot
    surface) leaves `active/<SRC>.md`(+meta) beside a valid tombstone. The
    receipt is fully reconstructed in the archive, so this is residue, never a
    deletion of SRC-024. Proof is the archived body digest against the
    tombstone's recorded digest; a mismatch is corruption, not a cleanup.
    Caller holds the project writer lock.
    """
    try:
        raw = _read_owned_file(
            root,
            _canonical_body_rel(
                root, receipt_id, str(tomb.get("source_sha256") or ""), "archive"
            ),
            kind="source body",
            max_bytes=_BODY_MAX,
        )
    except (FileNotFoundError, OSError, ValueError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    if hashlib.sha256(raw).hexdigest() != tomb.get("source_sha256"):
        return {
            "ok": False,
            "code": "SOURCE_CORRUPTION",
            "detail": f"closed receipt {receipt_id} archived body digest mismatch",
        }
    removed = False
    for rel, kind in (
        (f".saipen/intake/active/{receipt_id}.md", "active source body"),
        (f".saipen/intake/active/{receipt_id}.meta.json", "active source metadata"),
    ):
        path = _safe_path(root, rel, expect_file=True)
        if path.is_file() and not _is_link_or_reparse(path):
            safe_unlink_owned(path, kind=kind, ownership_root=root)
            removed = True
    return {
        "ok": True,
        "code": "SOURCE_CLOSED",
        "receipt": receipt_id,
        "status": CLOSED_STATUS,
        "archive_ref": tomb.get("archive_ref"),
        "recovered": True,
        "residue_removed": removed,
    }


def close_receipt(root: Path | str, receipt_id: str, *, closure_event: str | None = None) -> dict:
    """Close only with full terminal coverage; then leave the hot surface.

    Idempotent and self-healing for its own residue: if the receipt is ALREADY a
    tombstone, closure is a done fact, so the only remaining action is to
    deterministically settle any stale `active/` bytes left behind by the
    original close crash window (T-1323) -- verified against the archived body
    digest,     never inferred from the residue alone.
    """
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    try:
        with project_writer_lock(root):
            index = _read_index(root)
            tomb = index.get("tombstones", {}).get(receipt_id)
            if tomb is not None:
                return _settle_closed_residue_locked(root, receipt_id, tomb)
            if _is_archive_commit_pending(root, receipt_id, index):
                settled = _settle_archive_commit(root, receipt_id, index)
                if settled is not None:
                    return settled
            meta = _read_meta(root, receipt_id)
            if not meta:
                return {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id}
            integrity = verify_integrity(root, receipt_id)
            if not integrity["ok"]:
                return integrity
            contract_gate = _contract_integrity(root, receipt_id, meta)
            if not contract_gate["ok"]:
                return contract_gate
            summary = coverage_summary(root, receipt_id)
            if not coverage_complete(root, receipt_id):
                return {
                    "ok": False,
                    "code": "SOURCE_UNRESOLVED",
                    "detail": f"unresolved: {summary['unresolved']}",
                    "coverage": summary,
                }
            open_members = sorted(
                member
                for member in linked_works(meta)
                if _board_has_work(root, member) and not _work_is_done(root, member)
            )
            if open_members:
                return {
                    "ok": False,
                    "code": "SOURCE_WORK_ACTIVE",
                    "detail": f"linked Work {', '.join(open_members)} is not DONE",
                }
            closed_at = _utc()
            meta["status"] = CLOSED_STATUS
            meta["closed_at"] = closed_at
            meta["reread_at"] = closed_at
            meta["closure_event"] = closure_event
            tombstone = {
                "schema_version": SCHEMA_VERSION,
                "receipt_id": receipt_id,
                "source_sha256": meta["source_sha256"],
                "linked_work": meta.get("linked_work"),
                "linked_works": sorted(linked_works(meta)),
                "status": CLOSED_STATUS,
                "closed_at": closed_at,
                "closure_event": closure_event,
                "archive_ref": _canonical_body_rel(
                    root, receipt_id, meta["source_sha256"], "archive"
                ),
                "requirements": summary["requirements"],
                "actionable": summary["actionable"],
                "unresolved": 0,
            }
            archived = _archive_closed_locked(root, receipt_id, meta)
            index = _read_index(root)
            index["active"].pop(receipt_id, None)
            index["tombstones"][receipt_id] = tombstone
            _write_tombstone(root, receipt_id, tombstone)
            _write_index(root, index)
            return {
                "ok": True,
                "code": "SOURCE_CLOSED",
                "receipt": receipt_id,
                "closure_event": closure_event,
                "status": CLOSED_STATUS,
                "archive_ref": archived["archive_ref"],
            }
    except (OSError, PermissionError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}


def archive_receipt(root: Path | str, receipt_id: str) -> dict:
    """Move a CLOSED receipt out of the active surface into cold storage."""
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    try:
        with project_writer_lock(root):
            index = _read_index(root)
            if _is_archive_commit_pending(root, receipt_id, index):
                settled = _settle_archive_commit(root, receipt_id, index)
                if settled is not None:
                    return settled
            meta = _read_meta(root, receipt_id)
            if not meta:
                tomb = _read_index(root).get("tombstones", {}).get(receipt_id)
                if tomb and not tomb.get("purged"):
                    _closed_archive_bundle(root, receipt_id, tomb)
                    return {
                        "ok": True,
                        "code": "ALREADY_SATISFIED",
                        "receipt": receipt_id,
                        "archive_ref": _canonical_body_rel(
                            root, receipt_id, tomb["source_sha256"], "archive"
                        ),
                    }
                return {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id}
            if meta.get("status") != CLOSED_STATUS:
                return {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "only CLOSED receipts archive",
                }
            archived = _archive_closed_locked(root, receipt_id, meta)
            index = _read_index(root)
            index["active"].pop(receipt_id, None)
            tomb = index.get("tombstones", {}).get(receipt_id)
            if tomb is None:
                tomb = {
                    "schema_version": SCHEMA_VERSION,
                    "receipt_id": receipt_id,
                    "source_sha256": meta.get("source_sha256"),
                    "linked_work": meta.get("linked_work"),
                    "status": CLOSED_STATUS,
                    "closed_at": meta.get("closed_at"),
                    "closure_event": meta.get("closure_event"),
                    "archive_ref": _canonical_body_rel(
                        root,
                        receipt_id,
                        str(meta.get("source_sha256") or ""),
                        "archive",
                    ),
                    "requirements": 0,
                    "actionable": 0,
                    "unresolved": 0,
                }
                index["tombstones"][receipt_id] = tomb
                _write_tombstone(root, receipt_id, tomb)
            _write_index(root, index)
            return {
                "ok": True,
                "code": "SOURCE_ARCHIVED",
                "receipt": receipt_id,
                "archive_ref": archived["archive_ref"],
            }
    except (OSError, PermissionError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}


def purge_receipt(root: Path | str, receipt_id: str) -> dict:
    """Optional hard purge: keep the tombstone, remove the cold body.

    W2-003: the entire destructive delete set is PLANNED before the first
    irreversible delete. The journal operation binds the proven closed
    archive bundle, the expected revision set, the post-purge tombstone and
    the intake-index bytes, into one recoverable journal. A crash before
    COMMITTED leaves every planned target either pre- or post-state;
    recovery converges to the complete old set OR the complete new set,
    never a half-purged archive. Repeating the request after success is
    idempotent.
    """
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    try:
        index = _read_index(root)
        tomb = index.get("tombstones", {}).get(receipt_id)
        if not tomb:
            return {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id}
        if tomb.get("purged"):
            return {"ok": True, "code": "SOURCE_PURGED", "receipt": receipt_id}
        archive_dir = _archive_dir(root)
        delete_suffixes = (".md", ".meta.json", ".coverage.json", ".contract.json")
        archive_targets: list[Path] = []
        for suffix in delete_suffixes:
            rel = f".saipen/archive/source/{receipt_id}{suffix}"
            path = _safe_path(root, rel, expect_file=True)
            if path.is_file() and not _is_link_or_reparse(path):
                archive_targets.append(path)
        distribution = _read_distribution_record(root, receipt_id)
        if distribution is not None:
            protected = _safe_path(
                root, distribution["body_ref"], expect_file=True
            )
            if protected.is_file() and not _is_link_or_reparse(protected):
                archive_targets.append(protected)
        revision_targets: list[Path] = []
        if archive_dir.is_dir() and not _is_link_or_reparse(archive_dir):
            for revision in sorted(archive_dir.glob(f"{receipt_id}.r*.json")):
                if revision.is_file() and not _is_link_or_reparse(revision):
                    revision_targets.append(revision)
        new_tomb = dict(tomb)
        new_tomb["purged"] = True
        new_tomb["purged_at"] = _utc()
        index_out = _read_index(root)
        index_out["tombstones"][receipt_id] = new_tomb
        from .journal import hash_bytes, run_mutation
        from .paths import project_identity as _project_identity
        from .plan import semantic_payload_hash

        targets: list[dict] = []
        for path in archive_targets:
            targets.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "role": "generic",
                    "action": "delete_file",
                    "content": b"",
                    "before_hash": hash_bytes(path.read_bytes()),
                    "after_hash": "",
                }
            )
        for path in revision_targets:
            targets.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "role": "generic",
                    "action": "delete_file",
                    "content": b"",
                    "before_hash": hash_bytes(path.read_bytes()),
                    "after_hash": "",
                }
            )
        tomb_rel = f".saipen/intake/tombstones/{receipt_id}.json"
        index_rel = ".saipen/intake/index.json"
        new_tomb_bytes = _json_bytes(new_tomb)
        new_index_bytes = _json_bytes(index_out)
        targets.append(
            {
                "path": tomb_rel,
                "role": "generic",
                "action": "write",
                "content": new_tomb_bytes,
                "before_hash": hash_bytes(
                    (_tombstone_dir(root) / f"{receipt_id}.json").read_bytes()
                ),
                "after_hash": hash_bytes(new_tomb_bytes),
            }
        )
        targets.append(
            {
                "path": index_rel,
                "role": "generic",
                "action": "write",
                "content": new_index_bytes,
                "before_hash": hash_bytes(_index_path(root).read_bytes()),
                "after_hash": hash_bytes(new_index_bytes),
            }
        )
        semantic_request = {
            "receipt": receipt_id,
            "delete_targets": [t["path"] for t in targets if t["action"] == "delete_file"],
        }
        committed = run_mutation(
            root,
            op_id=f"source.purge-{hash_bytes(tomb_rel.encode('utf-8'))[:12]}",
            operation="source.purge",
            agent=_agent_for_intake(root),
            project_identity=_project_identity(root),
            semantic_payload_hash=semantic_payload_hash(semantic_request),
            targets=targets,
            preconditions={t["path"]: t["before_hash"] for t in targets},
            verification_policy="none",
        )
        if not committed.get("ok"):
            return {
                "ok": False,
                "code": committed.get("code", "VALIDATION_FAILED"),
                "receipt": receipt_id,
                "detail": committed.get("detail", "plan apply failed"),
            }
        return {"ok": True, "code": "SOURCE_PURGED", "receipt": receipt_id}
    except (OSError, PermissionError, ValueError) as exc:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}


def read_body(root: Path | str, receipt_id: str) -> dict:
    """Forensic retrieval: active or archived body, explicitly requested."""
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    try:
        meta = _read_meta(root, receipt_id)
        location = "active"
        rel = f".saipen/intake/active/{receipt_id}.md"
        if not meta:
            # Tombstoned/archived: look in cold storage only on explicit request.
            # Two cold namespaces, one lookup: `archive/source` holds CLOSED
            # receipts, `archive/retired` holds RETIRED ones. Forensic
            # retrieval must reach both, or "the bytes are preserved" would be
            # a promise no reader could cash.
            from .retirement import RETIRED_DIR

            for location_name, prefix in (
                ("archive", ".saipen/archive/source"),
                ("retired", RETIRED_DIR),
            ):
                try:
                    raw_meta = _read_owned_file(
                        root,
                        f"{prefix}/{receipt_id}.meta.json",
                        kind="source archive metadata",
                        max_bytes=_META_MAX,
                    )
                    meta = json.loads(raw_meta.decode("utf-8-sig"))
                    location = location_name
                    rel = f"{prefix}/{receipt_id}.md"
                    break
                except (FileNotFoundError, OSError, ValueError):
                    meta = None
    except (ValueError, OSError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    if not meta:
        tomb = _read_index(root).get("tombstones", {}).get(receipt_id)
        if tomb and tomb.get("purged"):
            return {
                "ok": False,
                "code": "SOURCE_PURGED",
                "detail": "body removed by purge; tombstone retains digest/closure",
            }
        return {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id}
    try:
        distribution = (
            _distribution_projection(root, receipt_id, str(meta.get("source_sha256") or ""))
            if location in {"active", "archive"}
            else {
                "state": DISTRIBUTABLE,
                "receipt_id": receipt_id,
                "source_sha256": meta.get("source_sha256"),
            }
        )
        if location in {"active", "archive"}:
            rel = _canonical_body_rel(
                root, receipt_id, str(meta.get("source_sha256") or ""), location
            )
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    try:
        raw = _read_owned_file(root, rel, kind="source body", max_bytes=_BODY_MAX)
        body = raw.decode("utf-8")
    except UnicodeDecodeError:
        return {"ok": False, "code": "INVALID", "detail": "source body is not UTF-8"}
    except FileNotFoundError:
        return {
            "ok": False,
            "code": "SOURCE_PURGED",
            "detail": "body removed by purge; tombstone retains digest/closure",
        }
    except (ValueError, OSError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    actual = hashlib.sha256(raw).hexdigest()
    if actual != meta.get("source_sha256"):
        return {
            "ok": False,
            "code": "SOURCE_CORRUPTION",
            "recorded": meta.get("source_sha256"),
            "actual": actual,
        }
    return {
        "ok": True,
        "receipt": receipt_id,
        "location": location,
        "body": body,
        "meta": meta,
        "source_authority": _source_authority(meta),
        "distribution": distribution,
    }


def status(root: Path | str, receipt_id: str) -> dict:
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return _invalid_receipt_id(receipt_id)
    try:
        meta = _read_meta(root, receipt_id)
    except (ValueError, OSError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    location = "active"
    if not meta:
        try:
            raw = _read_owned_file(
                root,
                f".saipen/archive/source/{receipt_id}.meta.json",
                kind="source archive metadata",
                max_bytes=_META_MAX,
            )
            meta = json.loads(raw.decode("utf-8-sig"))
            location = "archive"
        except (FileNotFoundError, OSError, ValueError):
            tomb = _read_index(root).get("tombstones", {}).get(receipt_id)
            if tomb:
                from .retirement import is_retired_tombstone

                if is_retired_tombstone(tomb):
                    return {
                        "ok": True,
                        "receipt": receipt_id,
                        "status": tomb.get("status"),
                        "location": "retired",
                        "source_sha256": tomb.get("source_sha256"),
                        "linked_work": tomb.get("linked_work"),
                        "reason": tomb.get("reason"),
                        "evidence": tomb.get("evidence"),
                        "evidence_note": tomb.get("evidence_note"),
                        "authority_receipt": tomb.get("authority_receipt"),
                        "authority_grant": tomb.get("authority_grant"),
                        "retirement_event": tomb.get("retirement_event"),
                        "discovery_event": tomb.get("discovery_event"),
                        "evidence_bound_event": tomb.get("evidence_bound_event"),
                        "retired_at": tomb.get("retired_at"),
                        "retired_by": tomb.get("retired_by"),
                        "archive_ref": tomb.get("archive_ref"),
                        "ticket_ref": tomb.get("ticket_ref"),
                    }
                if not tomb.get("purged"):
                    try:
                        _closed_archive_bundle(
                            root,
                            receipt_id,
                            tomb,
                            allow_active_fallback=False,
                        )
                    except (FileNotFoundError, OSError, ValueError) as exc:
                        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
                try:
                    distribution = _distribution_projection(
                        root,
                        receipt_id,
                        str(tomb.get("source_sha256") or ""),
                    )
                except (OSError, ValueError) as exc:
                    return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
                return {
                    "ok": True,
                    "receipt": receipt_id,
                    "status": tomb.get("status"),
                    "location": "purged" if tomb.get("purged") else "tombstone",
                    "source_sha256": tomb.get("source_sha256"),
                    "linked_work": tomb.get("linked_work"),
                    "closure_event": tomb.get("closure_event"),
                    "coverage": {
                        "requirements": tomb.get("requirements", 0),
                        "actionable": tomb.get("actionable", 0),
                        "terminal": tomb.get("actionable", 0),
                        "unresolved": [],
                    },
                    "distribution": distribution,
                }
            return {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id}
    if location == "archive":
        try:
            raw = _read_owned_file(
                root,
                f".saipen/archive/source/{receipt_id}.coverage.json",
                kind="source archive coverage",
                max_bytes=_LEDGER_MAX,
            )
            archived_ledger = json.loads(raw.decode("utf-8-sig"))
        except (FileNotFoundError, OSError, ValueError) as exc:
            return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
        try:
            summary = _coverage_summary_from_ledger(receipt_id, archived_ledger)
        except ValueError as exc:
            return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
        try:
            index = _read_index(root)
            projection = index.get("tombstones", {}).get(receipt_id) or index.get(
                "active", {}
            ).get(receipt_id)
            if not isinstance(projection, dict):
                raise ValueError(f"archive {receipt_id} has no index projection")
            _closed_archive_bundle(
                root,
                receipt_id,
                projection,
                allow_active_fallback=False,
            )
        except (FileNotFoundError, OSError, ValueError) as exc:
            return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    else:
        summary = coverage_summary(root, receipt_id)
    try:
        distribution = _distribution_projection(
            root, receipt_id, str(meta.get("source_sha256") or "")
        )
    except (OSError, ValueError) as exc:
        return {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    return {
        "ok": True,
        "receipt": receipt_id,
        "status": meta.get("status"),
        "location": location,
        "source_kind": meta.get("source_kind"),
        "source_sha256": meta.get("source_sha256"),
        "linked_work": meta.get("linked_work"),
        "linked_works": sorted(linked_works(meta)),
        "amends": meta.get("amends"),
        "closure_event": meta.get("closure_event"),
        "coverage": summary,
        "distribution": distribution,
    }


def active_receipts(root: Path | str, *, work: str | None = None) -> list[dict]:
    """Cheap hot projection: index + metadata only; never opens source bodies."""
    root = Path(root)
    result = []
    index = _read_index(root)
    active = index.get("active", {})
    if not isinstance(active, dict):
        raise ValueError("source intake index active projection is not an object")
    for receipt_id in sorted(active):
        if not _valid_receipt_id(receipt_id):
            raise ValueError(f"invalid source receipt id: {receipt_id!r}")
        try:
            meta = _read_meta(root, receipt_id)
        except (OSError, ValueError) as exc:
            raise ValueError(f"active receipt {receipt_id} metadata unreadable: {exc}") from exc
        if not meta:
            raise ValueError(f"active receipt {receipt_id} has no metadata")
        projection = active.get(receipt_id)
        if not isinstance(projection, dict) or projection.get("source_sha256") != meta.get(
            "source_sha256"
        ):
            raise ValueError(f"active receipt {receipt_id} index metadata drift")
        if work is not None and not is_linked_to(meta, work):
            continue
        summary = coverage_summary(root, receipt_id)
        result.append(
            {
                "receipt": receipt_id,
                "source_sha256": meta.get("source_sha256"),
                "linked_work": meta.get("linked_work"),
                "requirements": summary["requirements"],
                "terminal": summary["terminal"],
                "unresolved": len(summary["unresolved"]),
                "distribution": _distribution_projection(
                    root, receipt_id, str(meta.get("source_sha256") or "")
                ),
            }
        )
    return result


def recover_orphans(root: Path | str) -> dict:
    """Read-only crash diagnostic; never deletes or invents source intent."""
    root = Path(root)
    index = _read_index(root)
    indexed = set(index.get("active", {}))
    orphans = []
    for receipt_id in sorted(indexed):
        if not _valid_receipt_id(receipt_id):
            continue
        try:
            _read_owned_file(
                root,
                f".saipen/intake/active/{receipt_id}.md",
                kind="source body",
                max_bytes=_BODY_MAX,
            )
            active_body = True
        except FileNotFoundError:
            active_body = False
        except (ValueError, OSError):
            active_body = True
        try:
            _read_owned_file(
                root,
                f".saipen/archive/source/{receipt_id}.md",
                kind="source body",
                max_bytes=_BODY_MAX,
            )
            archived_body = True
        except FileNotFoundError:
            archived_body = False
        except (ValueError, OSError):
            archived_body = False
        if not active_body and archived_body:
            orphans.append(
                {
                    "receipt": receipt_id,
                    "state": "ARCHIVE_COMMIT_PENDING",
                    "source_sha256": index["active"][receipt_id].get("source_sha256"),
                }
            )
    active = _active_dir(root)
    if active.is_dir() and not _is_link_or_reparse(active):
        for body in sorted(active.glob("SRC-*.md")):
            receipt_id = body.stem
            # T-1323: stale active residue of a receipt that is ALREADY a
            # tombstone is not an orphan -- the receipt is reconstructed in the
            # archive. Only a body with no active meta AND no tombstone is a
            # genuine unreconstructed orphan.
            if receipt_id in index.get("tombstones", {}):
                continue
            if receipt_id not in indexed or not _read_meta(root, receipt_id):
                try:
                    raw = _read_owned_file(
                        root,
                        f".saipen/intake/active/{receipt_id}.md",
                        kind="source body",
                        max_bytes=_BODY_MAX,
                    )
                    digest = hashlib.sha256(raw).hexdigest()
                except (OSError, ValueError):
                    digest = None
                orphans.append(
                    {
                        "receipt": receipt_id,
                        "state": "ORPHAN_RECEIPT",
                        "source_sha256": digest,
                    }
                )
    return {"ok": True, "code": "ORPHAN_RECEIPTS", "orphans": orphans}


def recover_reports(root: Path | str, receipt_id: object) -> bool:
    """Does `source recover` have anything to say about this receipt?

    T-1476. `source recover` is read-only, so it is a route out of a stuck
    closure only when it reports the stuck receipt. Anything else -- a receipt
    retired under its live Work, a corrupt body -- gets `orphans: []`, the
    state never changes, and every agent generation re-runs the same route.
    """
    try:
        orphans = recover_orphans(root).get("orphans") or []
    except (OSError, ValueError):
        return False
    return any(item.get("receipt") == receipt_id for item in orphans)


def validate_project(root: Path | str) -> list[str]:
    """Structural validation only; no LLM-level semantic interpretation."""
    root = Path(root)
    index_path = _index_path(root)
    try:
        board_links = _board_source_links(root)
    except (OSError, ValueError) as exc:
        return [f"source receipt BOARD projection unreadable: {exc}"]
    if not index_path.exists():
        return [
            f"BOARD Work {work} references missing source receipt {receipt_id}"
            for work, receipts in board_links.items()
            for receipt_id in sorted(receipts)
        ]
    errors: list[str] = []
    try:
        raw = _read_owned_file(
            root, ".saipen/intake/index.json", kind="source intake index", max_bytes=_INDEX_MAX
        )
        index = _decode_index(json.loads(raw.decode("utf-8-sig")))
    except (OSError, ValueError) as exc:
        return [f"source intake index unreadable: {exc}"]
    seen_digests: dict[str, str] = {}
    board: dict | None = None
    board_tickets: dict = {}
    try:
        from .board import parse_board

        raw_board = _read_owned_file(
            root,
            ".saipen/BOARD.md",
            kind="source BOARD authority",
            max_bytes=_BOARD_MAX,
        )
        board = parse_board(raw_board.decode("utf-8-sig"))
        board_tickets = board.get("tickets", {})
    except (OSError, ValueError):
        board = None
        board_tickets = {}
    for receipt_id, projection in index.get("active", {}).items():
        if not INTENT_RE.fullmatch(receipt_id):
            errors.append(f"invalid source receipt id {receipt_id!r}")
            continue
        try:
            meta = _read_meta(root, receipt_id)
        except (OSError, ValueError) as exc:
            errors.append(f"active receipt {receipt_id} metadata unreadable: {exc}")
            continue
        if not meta:
            errors.append(f"active receipt {receipt_id} has no metadata")
            continue
        if meta.get("status") == CLOSED_STATUS:
            errors.append(f"closed receipt {receipt_id} remains in active surface")
        try:
            integrity = verify_integrity(root, receipt_id)
        except (OSError, ValueError) as exc:
            integrity = {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
        if not integrity["ok"]:
            errors.append(f"active receipt {receipt_id}: {integrity['code']}")
        digest = meta.get("source_sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            errors.append(f"active receipt {receipt_id} has invalid source_sha256")
        elif digest in seen_digests:
            errors.append(
                f"exact duplicate active receipts {seen_digests[digest]} and {receipt_id}"
            )
        else:
            seen_digests[digest] = receipt_id
        if not isinstance(projection, dict):
            errors.append(f"active receipt {receipt_id} index projection is not an object")
        elif projection.get("source_sha256") != digest:
            errors.append(f"active receipt {receipt_id} index digest drift")
        try:
            contract = _read_contract(root, receipt_id)
        except (OSError, ValueError) as exc:
            contract = None
            errors.append(f"active receipt {receipt_id} Work Contract unreadable: {exc}")
        if not contract:
            errors.append(f"active receipt {receipt_id} has no Work Contract")
        elif contract.get("source_sha256") != digest:
            errors.append(f"active receipt {receipt_id} CONTRACT_DRIFT")
        else:
            clauses = contract.get("clauses", {})
            try:
                coverage = _read_coverage(root, receipt_id)
            except (OSError, ValueError) as exc:
                errors.append(f"active receipt {receipt_id} coverage unreadable: {exc}")
                coverage = None
            if not isinstance(clauses, dict):
                errors.append(f"active receipt {receipt_id} Contract clauses are not an object")
                clauses = {}
            if coverage is not None:
                try:
                    _validate_contract_coverage(receipt_id, contract, coverage)
                except (OSError, ValueError) as exc:
                    errors.append(
                        f"active receipt {receipt_id} contract/coverage invalid: {exc}"
                    )
            contract_ids = set(clauses)
            coverage_ids = set() if coverage is None else set(coverage.get("requirements", {}))
            if contract_ids != coverage_ids:
                errors.append(
                    f"active receipt {receipt_id} contract/coverage clause drift: "
                    f"contract={len(contract_ids)} coverage={len(coverage_ids)}"
                )
            try:
                revision = int(contract.get("interpretation_revision", 0))
            except (TypeError, ValueError):
                revision = 0
                errors.append(f"active receipt {receipt_id} has invalid contract revision")
            if revision > 0:
                try:
                    _contract_revision_integrity(root, receipt_id, contract)
                except (ValueError, OSError) as exc:
                    errors.append(
                        f"active receipt {receipt_id} contract revision chain: {exc}"
                    )
        linked = meta.get("linked_work")
        if linked:
            ticket = board_tickets.get(linked)
            if ticket is None:
                errors.append(f"active receipt {receipt_id} references missing Work {linked}")
            else:
                projected = {
                    value.strip()
                    for value in str(ticket.get("fields", {}).get("source_receipts") or "").split(
                        ","
                    )
                    if value.strip()
                }
                if receipt_id not in projected:
                    errors.append(
                        f"active receipt {receipt_id} linkage missing from BOARD Work {linked}"
                    )
                if ticket.get("section") == "## DONE":
                    try:
                        complete = coverage_complete(root, receipt_id)
                    except (OSError, ValueError) as exc:
                        complete = False
                        errors.append(f"active receipt {receipt_id} coverage unreadable: {exc}")
                    if not complete:
                        errors.append(
                            f"DONE Work {linked} has unresolved source receipt {receipt_id}"
                        )
        amends = meta.get("amends")
        if amends:
            if not _valid_receipt_id(amends):
                errors.append(f"active receipt {receipt_id} has invalid amends {amends!r}")
            elif amends not in index.get("active", {}) and amends not in index.get(
                "tombstones", {}
            ):
                errors.append(
                    f"active receipt {receipt_id} references missing amended receipt {amends}"
                )
    for receipt_id, tomb in index.get("tombstones", {}).items():
        if receipt_id in index.get("active", {}):
            errors.append(f"receipt {receipt_id} is both active and tombstoned")
        if not isinstance(tomb, dict):
            errors.append(f"tombstone {receipt_id} projection is not an object")
            continue
        from .retirement import is_retired_tombstone, retirement_tombstone_errors

        retired = is_retired_tombstone(tomb)
        if retired:
            errors.extend(retirement_tombstone_errors(receipt_id, tomb))
        elif tomb.get("status") != CLOSED_STATUS or tomb.get("unresolved") != 0:
            errors.append(f"tombstone {receipt_id} lacks verified closed coverage")
        if not retired:
            try:
                expected_archive = _canonical_body_rel(
                    root,
                    receipt_id,
                    str(tomb.get("source_sha256") or ""),
                    "archive",
                )
            except (OSError, ValueError) as exc:
                expected_archive = None
                errors.append(f"tombstone {receipt_id} distribution invalid: {exc}")
            if expected_archive is not None and not _archive_ref_matches(
                tomb.get("archive_ref"), receipt_id, expected_archive
            ):
                errors.append(f"tombstone {receipt_id} has invalid archive_ref")
        tomb_path = _tombstone_dir(root) / f"{receipt_id}.json"
        if not tomb_path.is_file() or _is_link_or_reparse(tomb_path):
            errors.append(f"tombstone {receipt_id} file missing or unsafe")
        else:
            try:
                tomb_raw = _read_owned_file(
                    root,
                    f".saipen/intake/tombstones/{receipt_id}.json",
                    kind="source tombstone",
                    max_bytes=_META_MAX,
                )
                if json.loads(tomb_raw.decode("utf-8-sig")) != tomb:
                    errors.append(f"tombstone {receipt_id} differs from index projection")
            except (OSError, ValueError) as exc:
                errors.append(f"tombstone {receipt_id} unreadable: {exc}")
        if retired:
            # A retired bundle is verified against its OWN carriers: the exact
            # body bytes, the archived metadata's retirement block and the
            # ticket record its `ticket_ref` names. `_closed_archive_bundle`
            # would refuse it for lacking terminal coverage, which is the truth
            # about it, not a defect in it.
            from .retirement import retired_archive_errors

            errors.extend(retired_archive_errors(root, receipt_id, tomb))
        elif not tomb.get("purged"):
            try:
                _meta, _contract, _coverage, archive_summary = _closed_archive_bundle(
                    root, receipt_id, tomb
                )
                for field, expected in (
                    ("requirements", archive_summary["requirements"]),
                    ("actionable", archive_summary["actionable"]),
                    ("unresolved", len(archive_summary["unresolved"])),
                ):
                    if tomb.get(field) != expected:
                        errors.append(
                            f"tombstone {receipt_id} {field} count drift: "
                            f"recorded={tomb.get(field)!r} derived={expected!r}"
                        )
            except (FileNotFoundError, OSError, ValueError) as exc:
                errors.append(f"closed receipt {receipt_id} archive bundle invalid: {exc}")
    # The forensic namespace itself: a ticket record nobody points at, a stray
    # bundle, a linked node, or retired Work still on BOARD is invisible to the
    # per-tombstone checks above.
    from .retirement import retired_namespace_errors

    errors.extend(retired_namespace_errors(root, index, board_tickets))
    try:
        credential_gate = _legacy_sensitive_source_gate(root)
    except (OSError, ValueError) as exc:
        credential_gate = {"ok": False, "code": "SOURCE_CORRUPTION", "detail": str(exc)}
    if not credential_gate.get("ok"):
        errors.append(
            f"source credential gate: {credential_gate.get('code', 'SOURCE_CORRUPTION')} "
            f"{credential_gate.get('detail', '')}".rstrip()
        )
    # A closed, archived redacted-derivative receipt is NOT appended here: the
    # archive is immutable, so an error line would be a permanent failure no
    # future work could clear. The fact stays queryable through
    # `_source_authority` / the gate's `lost_originals` field instead.
    known_receipts = set(index.get("active", {})) | set(index.get("tombstones", {}))
    for work, receipts in board_links.items():
        for receipt_id in sorted(receipts):
            if receipt_id not in known_receipts:
                errors.append(f"BOARD Work {work} references missing source receipt {receipt_id}")
    for orphan in recover_orphans(root)["orphans"]:
        errors.append(f"ORPHAN_RECEIPT {orphan['receipt']}")
    return errors


# ---------------------------------------------------------------------------
# Terminal recovered-source attribution proof (SAIPEN T-1315 / AUDAPACK T-183)
#
# WHY THIS EXISTS: a terminal TOMBSTONE_AUTHORITATIVE recovery can leave an
# INTENTIONALLY PRESERVED INVALID original Contract as durable residue. Strict
# Core correctly reports it forever -- the archive is immutable and no clause
# may be fabricated to make it valid. Work-delta then classifies the finding
# GLOBAL because it cannot prove who owns the residue, which permanently
# blocks unrelated Work whose only sin is living in a project with honest
# historical debt.
#
# The fix is ATTRIBUTION, never a waiver. This helper is READ-ONLY: it never
# mutates the project, never repairs the contract, never suppresses the strict
# finding and never throws for ordinary invalid evidence. It answers exactly
# one question: "can this recovered source's residue be PROVEN to belong to
# that one terminal linked Work?" Anything unproven returns NOT_ATTRIBUTABLE
# with a machine-readable reason, and the caller keeps the finding blocking.
# ---------------------------------------------------------------------------

RECOVERY_SCHEMA_VERSION = 1
_WORK_ID_RE = re.compile(r"\AT-\d+\Z")

# Only recovery methods whose contract is fully understood by this proof are
# accepted. Arbitrary strings are never trusted.
PRESERVING_RECOVERY_METHODS = frozenset({"TOMBSTONE_AUTHORITATIVE"})

# Fields that exist only in the LEGACY rich tombstone shape the recovery verb
# normalized into the canonical compact form. Their disappearance is the
# documented normalization, never a mutation of closure identity; the identity
# itself is compared through `_closure_identity_view`.
RICH_TOMBSTONE_ONLY_FIELDS = frozenset({"closure", "consumption", "kind", "layer", "transport"})

# Fields the recovery method is allowed to ADD to a tombstone file after the
# original tombstone was embedded. They are journaled recovery metadata, not
# closure identity, so their presence is never corruption.
RECOVERY_ADDITIVE_TOMBSTONE_FIELDS = frozenset({"recovery"})

RECOVERY_INTEGRITY_REQUIRED = (
    "schema_version",
    "receipt_id",
    "source_sha256",
    "method",
    "recovered_at",
)


def _b64_sha256(text: object) -> str | None:
    """Digest of one embedded base64 payload, or None when undecodable."""
    import base64
    import binascii

    if not isinstance(text, str) or not text.strip():
        return None
    try:
        raw = base64.b64decode(text.encode("ascii"), validate=True)
    except (binascii.Error, ValueError):
        return None
    return hashlib.sha256(raw).hexdigest()


def _load_json_artifact(root: Path, rel: str, *, max_bytes: int = _LEDGER_MAX):
    """Read one owned JSON artifact; returns (doc, error_reason)."""
    try:
        raw = _read_owned_file(root, rel, kind="source recovery artifact", max_bytes=max_bytes)
    except FileNotFoundError:
        return None, f"{rel} is missing"
    except (OSError, ValueError) as exc:
        return None, f"{rel} unreadable: {exc}"
    try:
        doc = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        return None, f"{rel} is not valid JSON: {exc}"
    if not isinstance(doc, dict):
        return None, f"{rel} root is not an object"
    return doc, None


def _recovered_requirement_truth(receipt_id: str, coverage: dict) -> tuple[dict | None, str]:
    """Tolerant coverage truth for a PRESERVED (possibly legacy-shaped) ledger.

    Strict `_coverage_summary_from_ledger` deliberately refuses coverage whose
    requirement entries lack canonical clause structure -- that refusal is the
    contract residue this proof is about and must stay. Attribution still needs
    the counts, so this reader computes them without raising:
    actionable = every requirement except ones explicitly marked
    ``actionable: false``; terminal = terminal disposition + evidence (+ a
    verification string for IMPLEMENTED/VERIFIED).
    """
    requirements = coverage.get("requirements") if isinstance(coverage, dict) else None
    if not isinstance(requirements, dict):
        return None, "coverage requirements is not an object"
    if not requirements:
        return None, "coverage has no requirements"
    works: set[str] = set()
    actionable = 0
    terminal = 0
    for rid, entry in requirements.items():
        if not isinstance(rid, str) or not re.fullmatch(rf"{re.escape(receipt_id)}:R\d+", rid):
            return None, f"coverage has invalid requirement id {rid!r}"
        if not isinstance(entry, dict):
            return None, f"coverage requirement {rid} is not an object"
        linked = entry.get("linked_work")
        if not isinstance(linked, str) or not _WORK_ID_RE.match(linked):
            return None, f"coverage requirement {rid} has no canonical linked_work"
        works.add(linked)
        if entry.get("actionable", True) is not False:
            actionable += 1
            disp = entry.get("disposition")
            evidence = entry.get("evidence")
            verification = entry.get("verification")
            if disp not in TERMINAL_DISPOSITIONS:
                continue
            if not isinstance(evidence, str) or not evidence.strip():
                continue
            if disp in {"IMPLEMENTED", "VERIFIED"} and (
                not isinstance(verification, str) or not verification.strip()
            ):
                continue
            terminal += 1
    return {
        "requirements": len(requirements),
        "actionable": actionable,
        "terminal": terminal,
        "linked_works": works,
    }, None


def _recovery_record_path(root: Path, receipt_id: str, tombstone: dict) -> str:
    """The journaled recovery record location, from the tombstone when present."""
    recovery = tombstone.get("recovery")
    if isinstance(recovery, dict):
        declared = recovery.get("record")
        if isinstance(declared, str) and declared.strip():
            return declared.strip()
    return f".saipen/archive/source/{receipt_id}.recovery.json"


def _recovery_record_integrity(receipt_id: str, record: dict, tombstone: dict) -> str | None:
    """Canonical schema/integrity check for one recovery record."""
    for field in RECOVERY_INTEGRITY_REQUIRED:
        if field not in record:
            return f"recovery record missing {field}"
    if record.get("schema_version") != RECOVERY_SCHEMA_VERSION:
        return "recovery record has an unsupported schema_version"
    if record.get("receipt_id") != receipt_id:
        return "recovery record receipt_id mismatch"
    if record.get("source_sha256") != tombstone.get("source_sha256"):
        return "recovery record source_sha256 mismatch"
    method = record.get("method")
    if not isinstance(method, str) or method not in PRESERVING_RECOVERY_METHODS:
        return f"recovery method {method!r} is not supported"
    for field in ("original_contract", "original_coverage", "original_tombstone"):
        block = record.get(field)
        if not isinstance(block, dict):
            return f"recovery record missing {field}"
        if not isinstance(block.get("bytes"), str) or not isinstance(block.get("sha256"), str):
            return f"recovery record {field} is malformed"
    declared = tombstone.get("recovery")
    if isinstance(declared, dict) and declared.get("method") != method:
        return "recovery method disagrees with the tombstone declaration"
    return None


def _closure_identity_view(tombstone: dict) -> dict:
    """Canonical IMMUTABLE closure identity of one tombstone.

    The recovery verb normalized the legacy rich tombstone into the compact
    canonical shape, so the two files are NOT field-for-field identical: the
    rich-only carriers (closure/consumption/kind/layer/transport) exist before
    the recovery and not after. What must never change is the closure identity
    they both carry -- receipt id, source digest, linked Work, the closure
    event/run, closed_at, the requirement/actionable counts and the work_done
    identity -- plus, when the legacy block declares it, the consumption file
    identity. Rich-block fields that the current tombstone DOES carry must
    still agree when they are present in both shapes.
    """
    identity: dict[str, object] = {
        "receipt_id": tombstone.get("receipt_id"),
        "source_sha256": tombstone.get("source_sha256"),
        "linked_work": tombstone.get("linked_work"),
        "closed_at": tombstone.get("closed_at"),
        "schema_version": tombstone.get("schema_version"),
        "requirements": tombstone.get("requirements"),
        "actionable": tombstone.get("actionable"),
        "unresolved": tombstone.get("unresolved"),
    }
    closure = tombstone.get("closure")
    if isinstance(closure, dict):
        identity["closure.work_done"] = closure.get("work_done")
        identity["closure.run"] = closure.get("run")
        identity["closure.terminal_clauses"] = closure.get("terminal_clauses")
        identity["closure.actionable_clauses"] = closure.get("actionable_clauses")
    consumption = tombstone.get("consumption")
    if isinstance(consumption, dict):
        # Consumption file identity is immutable when the recovery schema
        # records it: the same file, the same digest, one generation.
        for field in ("file", "file_sha256", "generation"):
            if field in consumption:
                identity[f"consumption.{field}"] = consumption[field]
    return identity


def _closure_identity(original: dict, current: dict) -> str | None:
    """Semantic equality of IMMUTABLE tombstone closure identity.

    The current tombstone may legitimately carry additive journaled recovery
    metadata, and the legacy rich carriers may have been normalized away. Any
    OTHER field appearing out of nowhere, or any change to closure identity,
    is a refusal. Extra unknown fields are never waved through.
    """
    original_is_rich = bool(RICH_TOMBSTONE_ONLY_FIELDS & set(original))
    current_is_compact = not (RICH_TOMBSTONE_ONLY_FIELDS & set(current))
    if original_is_rich and current_is_compact:
        # Documented recovery normalization: the legacy rich tombstone was
        # rewritten into the canonical compact form. Only the closure identity
        # (compared below) and the shared raw fields are authoritative.
        shared = set(original) & set(current) - RECOVERY_ADDITIVE_TOMBSTONE_FIELDS
        for field in sorted(shared):
            if current[field] != original[field]:
                return f"tombstone immutable field {field} changed"
    else:
        extra = set(current) - set(original) - RECOVERY_ADDITIVE_TOMBSTONE_FIELDS
        if extra:
            return f"tombstone gained undocumented fields: {','.join(sorted(extra))}"
        dropped = set(original) - set(current) - RECOVERY_ADDITIVE_TOMBSTONE_FIELDS
        if dropped:
            return f"tombstone lost immutable field(s): {','.join(sorted(dropped))}"
        for field, expected in original.items():
            if field == "recovery":
                continue
            if current.get(field) != expected:
                return f"tombstone immutable field {field} changed"
    before = _closure_identity_view(original)
    after = _closure_identity_view(current)
    for field, expected in before.items():
        if expected is None:
            continue
        actual = after.get(field)
        if actual is None:
            # A legacy carrier that the current compact tombstone no longer
            # repeats is the documented normalization, not a lost identity --
            # but the counts it carried are compared directly below.
            if field in (
                "closure.run",
                "closure.work_done",
                "closure.terminal_clauses",
                "closure.actionable_clauses",
                "consumption.file",
                "consumption.file_sha256",
                "consumption.generation",
                "unresolved",
                "requirements",
                "actionable",
            ):
                continue
            return f"tombstone lost immutable closure identity {field}"
        if actual != expected:
            return f"tombstone immutable closure identity {field} changed"
    # counts declared inside the legacy closure block are immutable truth
    closure = original.get("closure")
    current_closure = current.get("closure")
    if isinstance(closure, dict) and not isinstance(current_closure, dict):
        for field, key in (
            ("actionable_clauses", "actionable"),
            ("terminal_clauses", "actionable"),
        ):
            value = closure.get(field)
            if isinstance(value, int) and current.get(key) != value:
                return f"tombstone closure {field} disagrees with {key}"
        if isinstance(closure.get("terminal_clauses"), int) and (
            current.get("unresolved") != 0
        ):
            return "tombstone unresolved count contradicts terminal closure"
    return None


def evaluate_terminal_recovered_source_attribution(root: Path | str, receipt_id: str) -> dict:
    """Fail-closed proof that a recovered source's residue belongs to one Work.

    Returns ``{"attributable": True, "linked_work": <T-###>, "recovery_class":
    "terminal_recovered_source_residue", ...}`` only when EVERY condition in
    the attribution contract holds, otherwise ``{"attributable": False,
    "reason": <machine-readable code>, "detail": ...}``.

    Never raises for ordinary invalid evidence. Never mutates the project.
    Never repairs, rewrites or fabricates a Contract clause. This is
    PROVENANCE, never correctness: the strict finding stays exactly as it was.
    """
    root = Path(root)
    if not _valid_receipt_id(receipt_id):
        return {"attributable": False, "reason": "INVALID_RECEIPT_ID", "receipt_id": receipt_id}
    try:
        index = _read_index(root)
    except (OSError, ValueError) as exc:
        return {
            "attributable": False,
            "reason": "INDEX_UNREADABLE",
            "receipt_id": receipt_id,
            "detail": str(exc),
        }
    tombstones = index.get("tombstones", {})
    if not isinstance(tombstones, dict) or receipt_id not in tombstones:
        return {"attributable": False, "reason": "NO_TOMBSTONE", "receipt_id": receipt_id}
    # -- 27/28: a recovered terminal source must be OFF the active surface.
    if receipt_id in index.get("active", {}):
        return {"attributable": False, "reason": "SOURCE_ACTIVE", "receipt_id": receipt_id}
    active_dir = _active_dir(root)
    if active_dir.is_dir() and not _is_link_or_reparse(active_dir):
        for pattern in (f"{receipt_id}.*", f"{receipt_id}.md"):
            if any(active_dir.glob(pattern)):
                return {
                    "attributable": False,
                    "reason": "ACTIVE_ARTIFACT_PRESENT",
                    "receipt_id": receipt_id,
                }
    tombstone, reason = _load_json_artifact(
        root, f".saipen/intake/tombstones/{receipt_id}.json", max_bytes=_META_MAX
    )
    if tombstone is None:
        return {
            "attributable": False,
            "reason": "TOMBSTONE_UNREADABLE",
            "receipt_id": receipt_id,
            "detail": reason,
        }
    if tombstone.get("receipt_id") != receipt_id:
        return {
            "attributable": False,
            "reason": "TOMBSTONE_RECEIPT_MISMATCH",
            "receipt_id": receipt_id,
        }
    if tombstone.get("status") != CLOSED_STATUS:
        return {"attributable": False, "reason": "TOMBSTONE_NOT_CLOSED", "receipt_id": receipt_id}
    linked_work = tombstone.get("linked_work")
    if not isinstance(linked_work, str) or not _WORK_ID_RE.match(linked_work):
        return {"attributable": False, "reason": "LINKED_WORK_MISSING", "receipt_id": receipt_id}

    # -- archived metadata must agree with the tombstone on identity.
    meta, meta_reason = _load_json_artifact(
        root, f".saipen/archive/source/{receipt_id}.meta.json", max_bytes=_META_MAX
    )
    if meta is None:
        return {
            "attributable": False,
            "reason": "ARCHIVE_META_UNREADABLE",
            "receipt_id": receipt_id,
            "detail": meta_reason,
        }
    if meta.get("receipt_id") != receipt_id:
        return {
            "attributable": False,
            "reason": "ARCHIVE_RECEIPT_MISMATCH",
            "receipt_id": receipt_id,
        }
    if meta.get("status") != CLOSED_STATUS or meta.get("storage_status") != ARCHIVED_STATUS:
        return {"attributable": False, "reason": "ARCHIVE_NOT_CLOSED", "receipt_id": receipt_id}
    if meta.get("linked_work") != linked_work:
        return {"attributable": False, "reason": "ARCHIVE_WORK_MISMATCH", "receipt_id": receipt_id}
    digest = tombstone.get("source_sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        return {"attributable": False, "reason": "SOURCE_SHA_INVALID", "receipt_id": receipt_id}
    if meta.get("source_sha256") != digest:
        return {"attributable": False, "reason": "ARCHIVE_SHA_MISMATCH", "receipt_id": receipt_id}

    # -- archived body digest must agree too (the source is what it claims).
    try:
        body = _read_owned_file(
            root,
            f".saipen/archive/source/{receipt_id}.md",
            kind="source archive body",
            max_bytes=_BODY_MAX,
        )
    except FileNotFoundError:
        return {"attributable": False, "reason": "ARCHIVE_BODY_MISSING", "receipt_id": receipt_id}
    except (OSError, ValueError) as exc:
        return {
            "attributable": False,
            "reason": "ARCHIVE_BODY_UNREADABLE",
            "receipt_id": receipt_id,
            "detail": str(exc),
        }
    if hashlib.sha256(body).hexdigest() != digest:
        return {
            "attributable": False,
            "reason": "ARCHIVE_BODY_SHA_MISMATCH",
            "receipt_id": receipt_id,
        }

    # -- 29: no newer generation may amend this receipt.
    for other_id in sorted(set(index.get("active", {})) | set(tombstones)):
        if other_id == receipt_id:
            continue
        other_meta = _read_meta(root, other_id)
        if other_meta and other_meta.get("amends") == receipt_id:
            return {
                "attributable": False,
                "reason": "NEWER_GENERATION_EXISTS",
                "receipt_id": receipt_id,
                "detail": other_id,
            }
        other_tomb = tombstones.get(other_id) if isinstance(other_id, str) else None
        if isinstance(other_tomb, dict) and other_tomb.get("amends") == receipt_id:
            return {
                "attributable": False,
                "reason": "NEWER_GENERATION_EXISTS",
                "receipt_id": receipt_id,
                "detail": other_id,
            }

    # -- recovery record: existence, schema, integrity, provenance.
    rel = _recovery_record_path(root, receipt_id, tombstone)
    record, record_reason = _load_json_artifact(root, rel)
    if record is None:
        return {
            "attributable": False,
            "reason": "RECOVERY_RECORD_MISSING",
            "receipt_id": receipt_id,
            "detail": record_reason,
        }
    integrity_reason = _recovery_record_integrity(receipt_id, record, tombstone)
    if integrity_reason:
        return {
            "attributable": False,
            "reason": "RECOVERY_INTEGRITY_INVALID",
            "receipt_id": receipt_id,
            "detail": integrity_reason,
        }

    # -- C1/C2/C3: every embedded original must match its recorded digest.
    decoded: dict[str, object] = {}
    for field in ("original_contract", "original_coverage", "original_tombstone"):
        block = record.get(field)
        declared = block.get("sha256")
        if not isinstance(declared, str) or not re.fullmatch(r"[0-9a-f]{64}", declared or ""):
            return {
                "attributable": False,
                "reason": "RECOVERY_EMBEDDED_DIGEST_INVALID",
                "receipt_id": receipt_id,
                "detail": field,
            }
        actual = _b64_sha256(block.get("bytes"))
        if actual is None:
            return {
                "attributable": False,
                "reason": "RECOVERY_EMBEDDED_BYTES_INVALID",
                "receipt_id": receipt_id,
                "detail": field,
            }
        if actual != declared:
            return {
                "attributable": False,
                "reason": "RECOVERY_EMBEDDED_DIGEST_MISMATCH",
                "receipt_id": receipt_id,
                "detail": field,
            }
        import base64

        decoded[field] = json.loads(base64.b64decode(block["bytes"].encode("ascii")))

    original_tombstone = decoded["original_tombstone"]
    if not isinstance(original_tombstone, dict):
        return {
            "attributable": False,
            "reason": "ORIGINAL_TOMBSTONE_MALFORMED",
            "receipt_id": receipt_id,
        }
    identity_reason = _closure_identity(original_tombstone, tombstone)
    if identity_reason:
        return {
            "attributable": False,
            "reason": "TOMBSTONE_CLOSURE_IDENTITY_CHANGED",
            "receipt_id": receipt_id,
            "detail": identity_reason,
        }

    # -- 18/19: current archived Contract/coverage must still be the preserved
    # originals. Byte-identical is the only thing that proves no fabrication.
    for field, suffix in (("original_contract", "contract"), ("original_coverage", "coverage")):
        try:
            current_raw = _read_owned_file(
                root,
                f".saipen/archive/source/{receipt_id}.{suffix}.json",
                kind="source archive artifact",
                max_bytes=_LEDGER_MAX,
            )
        except FileNotFoundError:
            return {
                "attributable": False,
                "reason": "ARCHIVE_ARTIFACT_MISSING",
                "receipt_id": receipt_id,
                "detail": suffix,
            }
        except (OSError, ValueError) as exc:
            return {
                "attributable": False,
                "reason": "ARCHIVE_ARTIFACT_UNREADABLE",
                "receipt_id": receipt_id,
                "detail": f"{suffix}: {exc}",
            }
        import base64

        if current_raw != base64.b64decode(record[field]["bytes"].encode("ascii")):
            return {
                "attributable": False,
                "reason": "PRESERVED_ORIGINAL_REPLACED",
                "receipt_id": receipt_id,
                "detail": suffix,
            }

    coverage = decoded["original_coverage"]
    truth, truth_reason = _recovered_requirement_truth(receipt_id, coverage)
    if truth is None:
        return {
            "attributable": False,
            "reason": "COVERAGE_UNINTERPRETABLE",
            "receipt_id": receipt_id,
            "detail": truth_reason,
        }
    if truth["requirements"] != tombstone.get("requirements"):
        return {
            "attributable": False,
            "reason": "COVERAGE_COUNT_MISMATCH",
            "receipt_id": receipt_id,
        }
    if truth["terminal"] != tombstone.get("actionable"):
        return {
            "attributable": False,
            "reason": "COVERAGE_TERMINAL_MISMATCH",
            "receipt_id": receipt_id,
        }
    if truth["terminal"] != truth["actionable"]:
        return {"attributable": False, "reason": "COVERAGE_NOT_TERMINAL", "receipt_id": receipt_id}
    if len(truth["linked_works"]) != 1 or linked_work not in truth["linked_works"]:
        return {"attributable": False, "reason": "COVERAGE_SPLIT_WORK", "receipt_id": receipt_id}
    if not _work_is_done(root, linked_work):
        return {"attributable": False, "reason": "LINKED_WORK_NOT_DONE", "receipt_id": receipt_id}
    return {
        "attributable": True,
        "reason": None,
        "receipt_id": receipt_id,
        "linked_work": linked_work,
        "recovery_class": "terminal_recovered_source_residue",
        "recovery_method": record.get("method"),
        "recovery_record": rel,
        "source_sha256": digest,
        "requirements": truth["requirements"],
        "terminal": truth["terminal"],
    }
