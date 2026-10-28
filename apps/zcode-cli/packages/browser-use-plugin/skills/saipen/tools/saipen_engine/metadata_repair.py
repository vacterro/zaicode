"""Legacy BOARD metadata migration authority (T-1435 / SRC-090 M2-M3).

A historical DONE Work can carry machine-interpreted BOARD metadata written
before the canonical grammar existed -- the measured instance is FastPrompter
T-1226, whose `source_receipts` field holds a human handoff token
(`FASTPROMPTER - SMART_20260908_0645`) instead of an `SRC-###` identity. The
validator is CORRECT to refuse the malformed value, but the validator can only
refuse it forever when no canonical operation owns the repair: the Work is
historical DONE, manual BOARD editing is forbidden, and the source history is
immutable. That is a repairability deadlock, and this module is the ONE owner
of the finite legal route out of it.

Two classifications, both closed:

  EXACT_CANONICAL_MIGRATION
      the malformed token's exact canonical receipt is MECHANICALLY PROVABLE:
      the named `SRC-###` exists in this project AND the receipt's own durable
      metadata links it to this Work. The malformed field is replaced with
      that exact existing identity. Nothing is invented.

  LEGACY_UNBOUND_REFERENCE
      no exact canonical receipt proves the historical token (it predates the
      intake contract, or names an artifact this project never captured). The
      malformed prose is REMOVED from the machine-interpreted field and the
      exact original bytes survive in an immutable MR-###### receipt. No
      `SRC-999`, no `SRC-LEGACY`, no synthetic receipt is ever minted.

Nothing here trusts prose. The field is closed (`source_receipts`), the
classification is a closed vocabulary, the repair authority is a portable
identity (a target-project receipt, or the protocol home lineage that owns the
migration), the receipt is integrity-sealed, and the mutation is refused
unless the target row is genuinely historical DONE and every proposed value is
already canonical in the project's own intake truth.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

METADATA_REPAIR_SCHEMA_VERSION = 1
METADATA_REPAIR_DIR = ".saipen/recovery/conformance/metadata-repair"
METADATA_REPAIR_ID_RE = re.compile(r"\AMR-(\d{6})\Z")

#: Closed classification vocabulary. Free text is never the discriminator.
CLASSIFICATIONS = ("EXACT_CANONICAL_MIGRATION", "LEGACY_UNBOUND_REFERENCE")

#: The closed set of BOARD fields this operation may migrate on a DONE row.
SUPPORTED_FIELDS = ("source_receipts",)

_SRC_RE = re.compile(r"\ASRC-\d+\Z")
_SRC_IN_TEXT_RE = re.compile(r"SRC-\d+")
_LINEAGE_AUTHORITY_RE = re.compile(r"\Alineage-[0-9a-f]{32}\Z")

AUTHORITY_KINDS = ("SRC_RECEIPT", "PROTOCOL_HOME_LINEAGE")


class MetadataRepairRefusal(Exception):
    """A structured metadata-migration refusal (code + bounded detail)."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def repair_dir(root: Path | str) -> Path:
    return Path(root) / METADATA_REPAIR_DIR


def existing_receipts(root: Path | str) -> list[Path]:
    directory = repair_dir(root)
    if not directory.is_dir():
        return []
    return [
        path
        for path in sorted(directory.glob("MR-*.json"))
        if path.is_file() and METADATA_REPAIR_ID_RE.match(path.stem)
    ]


def next_receipt_id(root: Path | str) -> str:
    numbers = [
        int(METADATA_REPAIR_ID_RE.match(path.stem).group(1))
        for path in existing_receipts(root)
    ]
    return f"MR-{(max(numbers) + 1) if numbers else 1:06d}"


def _hash_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


# -- value grammar ----------------------------------------------------------


def receipt_tokens(value: object) -> list[str]:
    """The field's own comma-separated tokens, whitespace-stripped."""
    return [token.strip() for token in str(value or "").split(",") if token.strip()]


def is_canonical_token(token: str) -> bool:
    return bool(_SRC_RE.match(token))


def malformed_tokens(value: object) -> list[str]:
    """Tokens that are not `SRC-###` identities at all."""
    return [token for token in receipt_tokens(value) if not is_canonical_token(token)]


def canonical_tokens(value: object) -> list[str]:
    return [token for token in receipt_tokens(value) if is_canonical_token(token)]


# -- receipt existence / membership -----------------------------------------


def receipt_exists(root: Path | str, receipt_id: str) -> bool:
    """Is `receipt_id` a receipt this project actually owns?

    Active intake, compact tombstone, the archive bundle (body/metadata/
    contract), and a retired bundle all count. A dangling `SRC-###` does not.
    """
    from . import intake

    root = Path(root)
    rid = str(receipt_id or "").strip()
    if not _SRC_RE.match(rid):
        return False
    try:
        index = intake._read_index(root)
    except (OSError, ValueError):
        return False
    if rid in index.get("active", {}) or rid in index.get("tombstones", {}):
        return True
    archive = root / ".saipen/archive/source"
    for suffix in (".meta.json", ".md", ".contract.json"):
        if (archive / f"{rid}{suffix}").is_file():
            return True
    return (root / ".saipen/intake/active" / f"{rid}.md").is_file()


def _archive_work_membership(root: Path, receipt_id: str) -> set[str]:
    archive_meta = root / ".saipen/archive/source" / f"{receipt_id}.meta.json"
    try:
        record = json.loads(archive_meta.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return set()
    if not isinstance(record, dict):
        return set()
    works = set()
    primary = str(record.get("linked_work") or "").strip()
    if primary:
        works.add(primary)
    for item in record.get("linked_works") or []:
        value = str(item or "").strip()
        if value:
            works.add(value)
    retirement = record.get("retirement")
    if isinstance(retirement, dict):
        ref = str(retirement.get("ticket_ref") or "").strip()
        if ref:
            works.add(ref)
    return works


def work_membership(root: Path | str, receipt_id: str) -> set[str]:
    """Every Work this receipt's durable metadata names (fail-closed: empty
    when the receipt is unknown)."""
    from . import intake

    root = Path(root)
    rid = str(receipt_id or "").strip()
    if not _SRC_RE.match(rid):
        return set()
    works: set[str] = set()
    try:
        index = intake._read_index(root)
    except (OSError, ValueError):
        return set()
    if rid in index.get("active", {}):
        try:
            meta = intake._read_meta(root, rid)
        except (OSError, ValueError):
            meta = None
        works |= intake.linked_works(meta)
        return works
    tomb = index.get("tombstones", {}).get(rid)
    if isinstance(tomb, dict):
        for key in ("linked_work", "linked_works"):
            value = tomb.get(key)
            if isinstance(value, str) and value.strip():
                works.add(value.strip())
            elif isinstance(value, list):
                works |= {str(item).strip() for item in value if str(item or "").strip()}
    works |= _archive_work_membership(root, rid)
    return works


def target_problem(root: Path | str, work: str, receipt_id: str) -> tuple[str, str] | None:
    """Why `receipt_id` cannot be the exact canonical target for `work`.

    Returns ``(code, detail)`` or None when the mapping is mechanically
    provable: the receipt exists in this project AND its own durable metadata
    links it to THIS Work.
    """
    rid = str(receipt_id or "").strip().upper()
    if not _SRC_RE.match(rid):
        return (
            "METADATA_REPAIR_TARGET_UNPROVEN",
            f"{receipt_id!r} is not an SRC-### identity",
        )
    if not receipt_exists(root, rid):
        return (
            "METADATA_REPAIR_TARGET_MISSING",
            f"{rid} does not exist in this project's intake history",
        )
    if work not in work_membership(root, rid):
        return (
            "METADATA_REPAIR_TARGET_MISMATCH",
            f"{rid} exists but its durable metadata links it to "
            f"{sorted(work_membership(root, rid)) or ['no Work']}, not {work}",
        )
    return None


# -- authority --------------------------------------------------------------


def authority_kind(authority: str | None) -> str | None:
    value = str(authority or "").strip()
    if _SRC_RE.match(value):
        return "SRC_RECEIPT"
    if _LINEAGE_AUTHORITY_RE.match(value):
        return "PROTOCOL_HOME_LINEAGE"
    return None


def protocol_home_lineage() -> str:
    """The lineage identity of the protocol home executing this operation.

    The migration is a PROTOCOL-level act: a consumer project's legacy
    metadata is repaired by the protocol that owns the grammar. Binding the
    acting home's lineage makes that provenance checkable instead of implied.
    """
    from .paths import project_lineage_identity
    from .state import running_home

    try:
        home = running_home()
    except (OSError, ValueError):
        return ""
    return str(project_lineage_identity(home) or "").strip()


def authority_problem(root: Path | str, authority: str | None, *, required: bool) -> str | None:
    """Why this authority is not admissible, or None (``result_code, detail``
    shape is returned by callers through the operation layer)."""
    value = str(authority or "").strip()
    if not value:
        if required:
            return (
                "a legacy-unbound migration must name its authority "
                "(--authority <SRC-###>|lineage-<32hex>): dropping an unprovable "
                "historical reference is a protocol act and needs a checkable actor"
            )
        return None
    kind = authority_kind(value)
    if kind is None:
        return (
            f"authority {value!r} is neither a target-project receipt (SRC-###) "
            "nor a protocol home lineage (lineage-<32 hex chars>)"
        )
    if kind == "SRC_RECEIPT" and not receipt_exists(root, value):
        return f"authority receipt {value} does not exist in this project's intake history"
    if kind == "PROTOCOL_HOME_LINEAGE" and value != protocol_home_lineage():
        return (
            f"authority {value} names a protocol home lineage that is not the "
            "one executing this operation"
        )
    return None


# -- receipts ---------------------------------------------------------------


def load_receipt(root: Path | str, receipt_id: str) -> dict:
    """Read ONE repair receipt, fail-closed on any identity problem."""
    rid = str(receipt_id or "").strip()
    if not METADATA_REPAIR_ID_RE.match(rid):
        raise MetadataRepairRefusal(
            "METADATA_REPAIR_RECEIPT_CORRUPT", f"{receipt_id!r} is not an MR-###### identity"
        )
    path = repair_dir(root) / f"{rid}.json"
    if not path.is_file():
        raise MetadataRepairRefusal(
            "METADATA_REPAIR_RECEIPT_CORRUPT",
            f"{rid} does not exist at {METADATA_REPAIR_DIR}/",
        )
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise MetadataRepairRefusal(
            "METADATA_REPAIR_RECEIPT_CORRUPT", f"{rid} unreadable: {exc}"
        ) from exc
    if (
        not isinstance(record, dict)
        or record.get("schema_version") != METADATA_REPAIR_SCHEMA_VERSION
    ):
        raise MetadataRepairRefusal(
            "METADATA_REPAIR_RECEIPT_CORRUPT", f"{rid} has an unsupported schema"
        )
    if record.get("repair_id") != rid:
        raise MetadataRepairRefusal(
            "METADATA_REPAIR_RECEIPT_CORRUPT", f"{rid} names a different repair id"
        )
    recorded = str(record.get("integrity_digest") or "")
    if not recorded:
        raise MetadataRepairRefusal(
            "METADATA_REPAIR_RECEIPT_CORRUPT", f"{rid} carries no integrity digest"
        )
    canonical = {key: value for key, value in record.items() if key != "integrity_digest"}
    raw = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if _hash_bytes(raw) != recorded:
        raise MetadataRepairRefusal(
            "METADATA_REPAIR_RECEIPT_CORRUPT", f"{rid} integrity digest mismatch"
        )
    return record


def _receipt_target(record: dict) -> tuple[str, object]:
    """The (field, repaired value) a receipt semantically asserts."""
    value = record.get("repaired_value")
    return str(record.get("field") or ""), value


def latest_receipt_for(root: Path | str, work: str, field: str) -> dict | None:
    """The latest well-formed receipt for (work, field), or None.

    A corrupt receipt is deliberately NOT skipped: the caller must refuse
    rather than silently write a second repair over unreadable evidence.
    """
    found: dict | None = None
    for path in existing_receipts(root):
        try:
            record = load_receipt(root, path.stem)
        except MetadataRepairRefusal:
            continue
        if record.get("work") != work or record.get("field") != field:
            continue
        found = record
    return found


def build_receipt(
    *,
    repair_id: str,
    work: str,
    field: str,
    classification: str,
    original_board_record: str,
    original_value: str,
    repaired_value: str | None,
    evidence: list[str],
    authority: str,
    authority_kind_value: str,
    engine_generation: dict,
    project_identity: str,
    project_lineage: str,
    agent: str,
    event_id: str,
    created_at: str,
    op_id: str = "",
) -> dict:
    """The immutable receipt record, integrity-sealed before return."""
    if classification not in CLASSIFICATIONS:
        raise MetadataRepairRefusal(
            "VALIDATION_FAILED",
            f"classification {classification!r} outside {'|'.join(CLASSIFICATIONS)}",
        )
    record = {
        "schema_version": METADATA_REPAIR_SCHEMA_VERSION,
        "repair_id": repair_id,
        "work": work,
        "field": field,
        "classification": classification,
        "original_board_record": original_board_record,
        "original_board_record_sha256": _hash_bytes(original_board_record.encode("utf-8")),
        "original_value": original_value,
        "repaired_value": repaired_value,
        "removed": repaired_value is None,
        "evidence": list(evidence),
        "authority": authority,
        "authority_kind": authority_kind_value,
        "engine_generation": engine_generation,
        "project_identity": project_identity,
        "project_lineage": project_lineage,
        "agent": agent,
        "event_id": event_id,
        "created_at": created_at,
        "journal_op_id": op_id,
    }
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    record["integrity_digest"] = _hash_bytes(canonical)
    return record


# -- validator remediation --------------------------------------------------


def exact_candidate(root: Path | str, work: str, value: object) -> str | None:
    """A canonically mapped receipt id provable from the current field value.

    Two shapes prove an exact canonical migration: an `SRC-###` literally
    embedded in a malformed token, and an already-present canonical token
    (a mixed legacy row can carry the canonical identity beside the legacy
    prose, e.g. after a canonical linkage appended its receipt). The proof is
    the same in both cases: the receipt exists AND its durable metadata links
    it to THIS Work.
    """
    candidates: list[str] = []
    for token in malformed_tokens(value):
        candidates.extend(_SRC_IN_TEXT_RE.findall(token))
    candidates.extend(canonical_tokens(value))
    for candidate in candidates:
        if target_problem(root, work, candidate) is None:
            return candidate
    return None


def current_field_value(root: Path | str, work: str, field: str = "source_receipts") -> str:
    """The CURRENT BOARD value of `field` for `work`, or '' when unreadable."""
    from .board import parse_board

    try:
        raw = (Path(root) / ".saipen/BOARD.md").read_text(encoding="utf-8-sig")
    except OSError:
        return ""
    try:
        board = parse_board(raw)
    except ValueError:
        return ""
    ticket = (board.get("tickets") or {}).get(str(work or "").strip().upper())
    if not ticket:
        return ""
    return str((ticket.get("fields") or {}).get(field) or "")


def remediation_command_for_work(
    root: Path | str, work: str, field: str = "source_receipts"
) -> str | None:
    """The ONE executable migration for a Work's malformed machine metadata.

    Reads the row's CURRENT value: a mixed legacy row (malformed prose beside
    a canonically linked receipt) must advertise the exact `--to` form, not a
    removal that would drop live authority.
    """
    value = current_field_value(root, work, field)
    if not value:
        return None
    return remediation_command(root, work, value)


def remediation_command(root: Path | str, work: str, value: object) -> str | None:
    """The ONE executable repair for a malformed `source_receipts` value.

    Returns the canonical command string, or None when the value is not the
    malformed-legacy class (all tokens already canonical). The emitted shape
    always matches a registered remediation pattern.
    """
    if not malformed_tokens(value):
        return None
    candidate = exact_candidate(root, work, value)
    if candidate is not None:
        return (
            f"saipen ticket repair-metadata {work} --field source_receipts "
            f"--to {candidate}"
        )
    lineage = protocol_home_lineage()
    if not lineage:
        return None
    return (
        f"saipen ticket repair-metadata {work} --field source_receipts "
        f"--legacy-unbound --authority {lineage}"
    )