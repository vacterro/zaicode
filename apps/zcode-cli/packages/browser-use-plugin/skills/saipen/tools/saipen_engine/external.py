"""External implementation resolution authority (SRC-088 / T-1434 M2).

A defect can be reported locally, implemented in an UPSTREAM authority (the
protocol home, a shared engine, a released dependency), and verified locally
against the INSTALLED implementation. Before this module the only closure
provenance was local patch ownership, so such a ticket stayed BLOCKED_EXTERNAL
forever or had to lie with `own_patch`.

This module owns the ONE external closure mode (``external_implementation``,
the protocol's LOCAL_IMPLEMENTATION vs
EXTERNAL_IMPLEMENTATION_LOCAL_VERIFICATION distinction): the receipt format,
the closed authority/implementation grammar, and the re-derivation every
consumer shares -- the closure resolver and the validator both call
:func:`resolution_problems`, so they cannot drift.

Nothing here trusts prose. An authority must be a portable project lineage
identity, an implementation must be ``<T-###>@<commit>``, and the resolution
is valid only while the running ENGINE GENERATION it was verified against is
still the one installed: a dependency rollback (or any installed-code move)
makes an external closure non-green instead of silently green. Re-resolution
is the lawful repair, and it writes a NEW append-only receipt -- no historical
bytes are rewritten.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

EXTERNAL_SCHEMA_VERSION = 1
EXTERNAL_DIR = ".saipen/recovery/conformance/external"
EXTERNAL_ID_RE = re.compile(r"\AEX-(\d{6})\Z")

#: The closure_mode written on the resolved DONE row.
CLOSURE_MODE = "external_implementation"

#: Closed resolution-reason vocabulary. Free text is never provenance.
RESOLUTION_REASONS = (
    "PROTOCOL_HOME_FIX_VERIFIED",
    "DEPENDENCY_UPGRADE_VERIFIED",
    "UPSTREAM_FIX_VERIFIED",
)

_AUTHORITY_RE = re.compile(r"\Alineage-[0-9a-f]{32}\Z")
_IMPLEMENTATION_RE = re.compile(r"\A(T-\d+)@([0-9a-f]{7,40})\Z")


class ExternalRefusal(Exception):
    """A structured external-resolution refusal (code + bounded detail)."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def external_dir(root: Path | str) -> Path:
    return Path(root) / EXTERNAL_DIR


def existing_receipts(root: Path | str) -> list[Path]:
    directory = external_dir(root)
    if not directory.is_dir():
        return []
    return [
        path
        for path in sorted(directory.glob("EX-*.json"))
        if path.is_file() and EXTERNAL_ID_RE.match(path.stem)
    ]


def next_receipt_id(root: Path | str) -> str:
    numbers = [
        int(EXTERNAL_ID_RE.match(path.stem).group(1))
        for path in existing_receipts(root)
    ]
    return f"EX-{(max(numbers) + 1) if numbers else 1:06d}"


def authority_error(authority: str | None) -> str | None:
    """Why this external authority identity is not admissible, or None."""
    value = str(authority or "").strip()
    if not value:
        return (
            "external implementation authority is required (--authority): the "
            "portable lineage identity of the project that implemented the fix, "
            "e.g. lineage-<32 hex chars>"
        )
    if not _AUTHORITY_RE.match(value):
        return (
            f"authority {value!r} is not a portable lineage identity "
            "(lineage-<32 hex chars>); a URL, a path or a prose name is not "
            "an authority that can be checked"
        )
    return None


def implementation_error(implementation: str | None) -> str | None:
    """Why this upstream implementation identity is not admissible, or None."""
    value = str(implementation or "").strip()
    if not value:
        return (
            "external implementation identity is required (--implementation): "
            "the upstream Work and the exact commit that carries the fix, "
            "e.g. T-1411@cc86601f"
        )
    if not _IMPLEMENTATION_RE.match(value):
        return (
            f"implementation {value!r} is not a structured <T-###>@<commit> "
            "identity; free text or a URL cannot prove an upstream change"
        )
    return None


def reason_error(reason: str | None) -> str | None:
    value = str(reason or "").strip()
    if value not in RESOLUTION_REASONS:
        return (
            f"resolution reason {reason!r} is outside "
            f"{'|'.join(RESOLUTION_REASONS)}"
        )
    return None


def contract_digest(work: str, verify_text: str) -> str:
    """Identity of the LOCAL defect contract this resolution answers.

    The local ticket's own verify clause is the contract; hashing it means a
    resolution recorded for T-73 can never be replayed against T-66's contract
    without the digests disagreeing.
    """
    material = f"{str(work).strip()}\0{str(verify_text).strip()}"
    return "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def _hash_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def engine_identity() -> dict:
    """The identity of the engine generation CURRENTLY executing.

    The digest covers every engine source this resolution depends on, so an
    installed generation move, a rollback to an older install, or a different
    engine copy answering the re-check all produce a different identity. The
    receipt binds it; the closure resolver and the validator recompute it, so
    an external closure is green only against the generation it verified.
    """
    package = Path(__file__).resolve().parent
    tools = package.parent
    files: list[Path] = sorted(
        [path for path in package.glob("*.py") if path.is_file()]
        + [path for path in (tools / "saipen.py", tools / "validate.py") if path.is_file()]
    )
    material = ""
    for path in files:
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError:
            digest = "unreadable"
        material += f"{path.name}:{digest}\n"
    version = ""
    version_file = tools.parent / "VERSION"
    if version_file.is_file():
        try:
            version = version_file.read_text(encoding="utf-8-sig").strip()
        except OSError:
            version = ""
    return {
        "kind": "saipen-engine",
        "version": version,
        "engine_digest": _hash_bytes(material.encode("utf-8")),
        "files": len(files),
    }


def load_receipt(root: Path | str, receipt_id: str) -> dict:
    """Read ONE external receipt, fail-closed on any identity problem."""
    rid = str(receipt_id or "").strip()
    if not EXTERNAL_ID_RE.match(rid):
        raise ExternalRefusal(
            "EXTERNAL_RECEIPT_MISSING", f"{receipt_id!r} is not an EX-###### identity"
        )
    path = external_dir(root) / f"{rid}.json"
    if not path.is_file():
        raise ExternalRefusal(
            "EXTERNAL_RECEIPT_MISSING", f"{rid} does not exist at {EXTERNAL_DIR}/"
        )
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ExternalRefusal(
            "EXTERNAL_RECEIPT_CORRUPT", f"{rid} unreadable: {exc}"
        ) from exc
    if not isinstance(record, dict) or record.get("schema_version") != EXTERNAL_SCHEMA_VERSION:
        raise ExternalRefusal(
            "EXTERNAL_RECEIPT_CORRUPT", f"{rid} has an unsupported schema"
        )
    if record.get("receipt_id") != rid:
        raise ExternalRefusal(
            "EXTERNAL_RECEIPT_CORRUPT", f"{rid} names a different receipt id"
        )
    recorded = str(record.get("integrity_digest") or "")
    if not recorded:
        raise ExternalRefusal(
            "EXTERNAL_RECEIPT_CORRUPT", f"{rid} carries no integrity digest"
        )
    canonical = {
        key: value for key, value in record.items() if key != "integrity_digest"
    }
    raw = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if _hash_bytes(raw) != recorded:
        raise ExternalRefusal(
            "EXTERNAL_RECEIPT_CORRUPT", f"{rid} integrity digest mismatch"
        )
    return record


def build_receipt(
    *,
    root: Path | str,
    receipt_id: str,
    work: str,
    project_identity: str,
    project_lineage: str,
    agent: str,
    created_at: str,
    authority: str,
    implementation: str,
    resolution_reason: str,
    defect_contract_digest: str,
    defect_contract_text: str,
    prior_blocker_sha256: str,
    verification: list[dict],
    verification_contract_digest: str,
    verdict: str,
    op_id: str = "",
) -> dict:
    """The immutable receipt record, integrity-sealed before return."""
    record = {
        "schema_version": EXTERNAL_SCHEMA_VERSION,
        "receipt_id": receipt_id,
        "work": work,
        "project_identity": project_identity,
        "project_lineage": project_lineage,
        "created_at": created_at,
        "agent": agent,
        "external_authority": authority,
        "external_implementation": implementation,
        "resolution_reason": resolution_reason,
        "defect_contract_digest": defect_contract_digest,
        "defect_contract_text": defect_contract_text,
        "prior_blocker_sha256": prior_blocker_sha256,
        "verification": verification,
        "verification_contract_digest": verification_contract_digest,
        "verdict": verdict,
        "installed_identity": engine_identity(),
        "journal_op_id": op_id,
    }
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8")
    record["integrity_digest"] = _hash_bytes(canonical)
    return record


def resolution_problems(root: Path | str, work: str, ticket: dict) -> list[str]:
    """Why this DONE external closure is NOT current, or [] when it is.

    Both the closure resolver and the validator call THIS, so "resolves" and
    "validates" are one predicate. A missing receipt, a foreign project, a
    tampered record, a non-PASS verdict, a board/receipt disagreement and a
    moved (rolled back or upgraded) installed engine generation are all
    distinct, named problems.
    """
    from .board import (
        external_authority as _authority,
        external_evidence as _evidence,
        external_implementation as _implementation,
        resolution_reason as _reason,
    )

    root = Path(root)
    problems: list[str] = []
    receipt_id = _evidence(ticket)
    if not receipt_id:
        return [f"{work} closes external_implementation with no | external_evidence: EX-######"]
    try:
        record = load_receipt(root, receipt_id)
    except ExternalRefusal as exc:
        return [f"{work}: {exc.detail}"]
    if record.get("work") != work:
        problems.append(
            f"{work} cites {receipt_id}, which resolves {record.get('work')!r}"
        )
    from .paths import project_lineage_identity
    from .debt import _project_identity

    if record.get("project_identity") != _project_identity(root):
        problems.append(f"{receipt_id} was written for a different project identity")
    if record.get("project_lineage") != project_lineage_identity(root):
        problems.append(f"{receipt_id} was written for a different project lineage")
    if record.get("verdict") != "PASS":
        problems.append(
            f"{receipt_id} verdict is {record.get('verdict')!r}; only a PASS "
            "external verification is closure evidence"
        )
    board_authority = _authority(ticket)
    board_implementation = _implementation(ticket)
    if board_authority and board_authority != record.get("external_authority"):
        problems.append(
            f"{work} names authority {board_authority} but {receipt_id} records "
            f"{record.get('external_authority')}"
        )
    if board_implementation and board_implementation != record.get("external_implementation"):
        problems.append(
            f"{work} names implementation {board_implementation} but {receipt_id} "
            f"records {record.get('external_implementation')}"
        )
    board_reason = _reason(ticket)
    if board_reason and board_reason != record.get("resolution_reason"):
        problems.append(
            f"{work} names resolution_reason {board_reason} but {receipt_id} "
            f"records {record.get('resolution_reason')}"
        )
    current = engine_identity()
    installed = record.get("installed_identity") or {}
    if installed.get("engine_digest") != current.get("engine_digest"):
        problems.append(
            f"{receipt_id} was verified against installed engine generation "
            f"{(installed.get('engine_digest') or 'unknown')[:23]}... but the "
            f"running engine is {(current.get('engine_digest') or 'unknown')[:23]}... "
            "-- the dependency moved (rollback or upgrade): re-resolve truthfully "
            "instead of inheriting a stale green"
        )
    return problems
