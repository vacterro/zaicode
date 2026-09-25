"""Accepted legacy debt registry for immutable historical findings.

DECISION B (operator, SRC-047): a sealed historical finding -- one that cannot
be repaired without rewriting append-only history -- may be REGISTERED as
accepted legacy debt, bounded by immutable evidence, so the canonical
validator downgrades exactly that finding to a visible warning instead of a
blocking FAIL. Nothing else changes: new findings of the same rule still FAIL,
unrelated findings still FAIL, and the accepted debt stays on screen.

WHY THIS EXISTS: the `[saio]` mechanical-provenance check (T-584) legitimately
flags hand-written structural events from the pre-mechanization window; for
some projects those exact events are sealed (retroactively marking them would
forge provenance -- E-965/E-967), and the only prior honoring mechanism was a
project-local stdout shim the engine receipt path never consulted. This module
is the canonical, project-scoped, journaled replacement for that shim.

NARROW BINDING (fail-closed on every condition):
  * record is project- and lineage-bound -- a copied record never travels;
  * record binds ONE rule and the EXACT set of missing event ids -- an extra
    new event changes the set and the acceptance no longer matches;
  * record binds each event's source FILE and the SHA-256 of that event's
    exact line bytes -- any mutation of accepted history invalidates it;
  * record binds CHECK_VERSION -- a semantic change to the consuming check
    forces conscious re-registration;
  * the record itself carries an integrity digest over its own body.

Storage: `<project>/.saipen/recovery/conformance/accepted_debt/AD-NNNNNN.json`,
written through the canonical journal (run_mutation) only -- never by hand.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from .paths import project_identity as _project_identity
from .paths import project_lineage_identity

ACCEPTED_DEBT_DIR = ".saipen/recovery/conformance/accepted_debt"
ACCEPTED_DEBT_ID_RE = re.compile(r"\AAD-(\d{6})\Z")
#: Canonical event spelling is `E-{int}` exactly as the validator renders it:
#: a ledger `[E-003]` and an operator input `E-003` both canonicalize to
#: `E-3`, which is what the `[saio]` FAIL message, the findings subject and
#: this registry all compare.
EVENT_INPUT_RE = re.compile(r"\AE-0*(\d+)\Z")
AUTHORITY_RE = re.compile(r"\A(?:SRC-\d+|E-\d+|lineage-[0-9a-f]{32})\Z")

SCHEMA_VERSION = 1
#: The `[saio]` missing-set semantics this registry binds to. Bump when the
#: consuming check in tools/validate.py changes meaning; records then refuse
#: comparison until consciously re-registered under the new check.
CHECK_VERSION = 1
RULE_ID = "log_provenance_marker"


def canonical_event_id(event: str) -> str | None:
    """Canonical `E-{int}` spelling, or None when the input is not E-###."""
    found = EVENT_INPUT_RE.match(str(event or "").strip())
    return f"E-{int(found.group(1))}" if found else None


class AcceptedDebtRefusal(Exception):
    """Structured, fail-closed refusal carrying its protocol code."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


def _utc() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _line_sha256(raw_line: str) -> str:
    return hashlib.sha256(raw_line.encode("utf-8")).hexdigest()


def _integrity_digest(record_body: dict) -> str:
    canonical = json.dumps(record_body, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _record_dir(root: Path) -> Path:
    return Path(root) / ACCEPTED_DEBT_DIR


def _record_files(root: Path) -> list[Path]:
    directory = _record_dir(root)
    if not directory.is_dir():
        return []
    return sorted(
        p for p in directory.glob("AD-*.json") if p.is_file() and ACCEPTED_DEBT_ID_RE.match(p.stem)
    )


def next_record_id(root: Path) -> str:
    numbers = [
        int(ACCEPTED_DEBT_ID_RE.match(p.stem).group(1)) for p in _record_files(Path(root))
    ]
    return f"AD-{(max(numbers) + 1) if numbers else 1:06d}"


def _read_lines(path: Path) -> list[str]:
    """Replicate tools/validate.py `read_doc` line normalization exactly.

    The registration tool and the validator MUST hash the same bytes: both
    decode BOM/UTF-16 the same way and normalize newlines before `splitlines`,
    so an accepted line hash can never depend on which side computed it.
    """
    try:
        raw = Path(path).read_bytes()
    except OSError as exc:
        raise AcceptedDebtRefusal("VALIDATION_FAILED", f"unreadable log segment {path}: {exc}")
    for bom, enc in (
        (b"\xff\xfe\x00\x00", "utf-32-le"),
        (b"\x00\x00\xfe\xff", "utf-32-be"),
        (b"\xef\xbb\xbf", "utf-8-sig"),
        (b"\xff\xfe", "utf-16-le"),
        (b"\xfe\xff", "utf-16-be"),
    ):
        if raw.startswith(bom):
            text = raw[len(bom) :].decode(enc, errors="replace")
            break
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            try:
                text = raw.decode("cp1251")
            except UnicodeDecodeError:
                text = raw.decode("utf-8", errors="replace")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text.splitlines()


def load_record(root: Path | str, ref: str) -> dict:
    """Decode ONE accepted-debt record fail-closed (identity + integrity)."""
    root = Path(root)
    if not ACCEPTED_DEBT_ID_RE.match(ref or ""):
        raise AcceptedDebtRefusal("VALIDATION_FAILED", f"invalid accepted-debt id {ref!r}")
    path = _record_dir(root) / f"{ref}.json"
    try:
        raw = path.read_bytes()
    except FileNotFoundError as exc:
        raise AcceptedDebtRefusal("ACCEPTED_DEBT_MISSING", f"{ref} does not exist") from exc
    except OSError as exc:
        raise AcceptedDebtRefusal("ACCEPTED_DEBT_CORRUPT", f"{ref} unreadable: {exc}") from exc
    try:
        record = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise AcceptedDebtRefusal(
            "ACCEPTED_DEBT_CORRUPT", f"{ref} is not valid JSON: {exc}"
        ) from exc
    if not isinstance(record, dict) or record.get("schema_version") != SCHEMA_VERSION:
        raise AcceptedDebtRefusal("ACCEPTED_DEBT_CORRUPT", f"{ref} has an unsupported schema")
    if record.get("record_id") != ref:
        raise AcceptedDebtRefusal("ACCEPTED_DEBT_CORRUPT", f"{ref} names a different record id")
    if record.get("kind") != "accepted_legacy_debt":
        raise AcceptedDebtRefusal("ACCEPTED_DEBT_CORRUPT", f"{ref} is not an accepted-debt record")
    body = {k: v for k, v in record.items() if k != "integrity_digest"}
    if _integrity_digest(body) != record.get("integrity_digest"):
        raise AcceptedDebtRefusal(
            "ACCEPTED_DEBT_CORRUPT", f"{ref} integrity digest mismatch (hand-edited or damaged)"
        )
    if record.get("project_identity") != _project_identity(root):
        raise AcceptedDebtRefusal(
            "ACCEPTED_DEBT_FOREIGN_PROJECT",
            f"{ref} was registered for {record.get('project_identity')!r}, not this project",
        )
    if record.get("project_lineage") != project_lineage_identity(root):
        raise AcceptedDebtRefusal(
            "ACCEPTED_DEBT_FOREIGN_LINEAGE",
            f"{ref} binds a foreign lineage; a copied .saipen directory never makes "
            "an acceptance portable",
        )
    if record.get("check_id") != RULE_ID or record.get("check_version") != CHECK_VERSION:
        raise AcceptedDebtRefusal(
            "ACCEPTED_DEBT_CHECK_CHANGED",
            f"{ref} was registered for check {record.get('check_id')!r} v"
            f"{record.get('check_version')!r}; current is {RULE_ID!r} v{CHECK_VERSION} -- "
            "the check semantics changed, re-register consciously",
        )
    return record


def evaluate_provenance(
    root: Path | str, missing: list[tuple[str, str, str]]
) -> dict:
    """Decide whether the EXACT missing set is registered accepted legacy debt.

    `missing` = [(event_id, segment_relpath, raw_line), ...] exactly as the
    `[saio]` check found them. Returns ``{"accepted": bool, "record_id": ...,
    "reason": ...}``. Fail-closed: an absent registry is ordinary (accepted
    False, empty reason); any unreadable/corrupt/foreign/mismatched record or
    a set/line/file mismatch keeps the finding blocking.
    """
    root = Path(root)
    files = _record_files(root)
    if not files:
        return {"accepted": False, "record_id": None, "reason": ""}
    wanted = {event_id for event_id, _file, _line in missing}
    by_event = {event_id: (file, line) for event_id, file, line in missing}
    if len(by_event) != len(wanted):
        return {
            "accepted": False,
            "record_id": None,
            "reason": "duplicate event ids in missing set",
        }
    for path in files:
        try:
            record = load_record(root, path.stem)
        except AcceptedDebtRefusal as refusal:
            # A damaged registry record must never half-accept: refuse this
            # record (the validator then keeps its ordinary FAIL).
            return {"accepted": False, "record_id": None, "reason": refusal.detail}
        accepted_events = record.get("accepted_missing_events")
        if not isinstance(accepted_events, list) or not all(
            isinstance(item, str) for item in accepted_events
        ):
            return {
                "accepted": False,
                "record_id": None,
                "reason": f"{path.stem} accepted_missing_events malformed",
            }
        if set(accepted_events) != wanted or len(accepted_events) != len(wanted):
            continue
        evidence = record.get("evidence")
        if not isinstance(evidence, list):
            return {
                "accepted": False,
                "record_id": None,
                "reason": f"{path.stem} evidence malformed",
            }
        ok = True
        seen: set[str] = set()
        for item in evidence:
            if not isinstance(item, dict):
                ok = False
                break
            event_id = item.get("event")
            file = item.get("file")
            line_sha = item.get("line_sha256")
            if (
                not isinstance(event_id, str)
                or event_id not in by_event
                or event_id in seen
                or not isinstance(file, str)
                or not isinstance(line_sha, str)
            ):
                ok = False
                break
            seen.add(event_id)
            live_file, live_line = by_event[event_id]
            if file != live_file or _line_sha256(live_line) != line_sha:
                ok = False
                break
        if ok and seen == wanted:
            return {
                "accepted": True,
                "record_id": path.stem,
                "reason": "exact missing set and line evidence verified",
            }
        return {
            "accepted": False,
            "record_id": None,
            "reason": f"{path.stem} does not cover the exact missing set/line evidence",
        }
    return {"accepted": False, "record_id": None, "reason": "no covering accepted-debt record"}


def _iter_history(root: Path):
    """Yield (segment_relpath, line_no, raw_line, parsed_event) in file order.

    Walks exactly the segments the validator walks (saipen_engine.log.
    history_paths, absolute) with the shared line normalization, but records
    the ROOT-RELATIVE spelling -- that is what the validator's `[saio]`
    message and every registered evidence `file` field use.
    """
    from .log import history_paths, parse_log_line

    base = Path(root).resolve()
    for path in history_paths(Path(root)):
        if not Path(path).is_file():
            continue
        try:
            rel_str = Path(path).resolve().relative_to(base).as_posix()
        except ValueError:
            rel_str = Path(path).as_posix()
        lines = _read_lines(Path(path))
        for line_no, raw in enumerate(lines, 1):
            if not raw.strip() or raw.startswith("#"):
                continue
            parsed = parse_log_line(raw)
            if parsed is None:
                continue
            yield rel_str, line_no, raw, parsed


def register(
    root: Path | str,
    *,
    agent: str,
    events: list[str],
    reason: str,
    authority: str,
) -> dict:
    """Register ONE exact sealed historical missing-set as accepted legacy debt.

    Fail-closed validation before any write: every event must exist, lack an
    `[op: ...]` marker, and sit at/after the self-established provenance
    boundary; no overlap with an existing record; authority must name a
    canonical SRC/E/lineage token. The record is journaled through the
    canonical operation layer (run_mutation) -- never a bare file write.
    """
    root = Path(root)
    normalized = []
    for event in events:
        canonical = canonical_event_id(event)
        if canonical is None:
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"invalid event id {event!r} (expected E-###)",
            }
        if canonical not in normalized:
            normalized.append(canonical)
    if not normalized:
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": "no events supplied"}
    if not str(reason or "").strip():
        return {"ok": False, "code": "VALIDATION_FAILED", "detail": "reason is required"}
    authority = str(authority or "").strip()
    if not AUTHORITY_RE.match(authority):
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": "authority must be SRC-###, E-### or lineage-<32hex>",
        }

    wanted = set(normalized)
    found: dict[str, tuple[str, int, str]] = {}
    first_op: int | None = None
    numbers: dict[str, int] = {}
    for rel_str, line_no, raw, parsed in _iter_history(root):
        event_id = f"E-{parsed['event']}"
        if parsed.get("op_id") and first_op is None:
            first_op = parsed["event"]
        if event_id in wanted:
            found[event_id] = (rel_str, line_no, raw)
            numbers[event_id] = parsed["event"]
    missing_ids = sorted(wanted - set(found))
    if missing_ids:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": "events not found in canonical history: " + ", ".join(missing_ids),
        }
    if first_op is None:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": "project history carries no provenance boundary; nothing to accept",
        }
    with_marker = []
    pre_boundary = []
    from .log import parse_log_line

    for event_id in normalized:
        rel_str, line_no, raw = found[event_id]
        # An event that already carries [op: ...] is mechanized, not debt.
        parsed = parse_log_line(raw)
        if parsed is None:
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"{event_id} no longer parses as a LOG line",
            }
        if parsed.get("op_id"):
            with_marker.append(event_id)
        elif numbers[event_id] < first_op:
            pre_boundary.append(event_id)
    if with_marker:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": "events already carry [op: ...] provenance: " + ", ".join(with_marker),
        }
    if pre_boundary:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": "events predate the provenance boundary and are already exempt: "
            + ", ".join(pre_boundary),
        }

    # No conflicting claims against an existing record for this check. A
    # BROADER registration may subsume an earlier narrower one (the earlier
    # exact-set record can never match the live set again anyway); a subset,
    # identical or partial-overlap registration is refused so one event is
    # never claimed by two conflicting records.
    for path in _record_files(root):
        try:
            existing = load_record(root, path.stem)
        except AcceptedDebtRefusal:
            continue
        existing_set = set(existing.get("accepted_missing_events") or [])
        intersection = wanted & existing_set
        if not intersection:
            continue
        if existing_set == wanted:
            return {
                "ok": False,
                "code": "ACCEPTED_DEBT_EXISTS",
                "detail": f"{path.stem} already accepts exactly this set",
            }
        if not existing_set <= wanted:
            return {
                "ok": False,
                "code": "ACCEPTED_DEBT_EXISTS",
                "detail": f"{path.stem} already accepts: "
                + ", ".join(sorted(existing_set & wanted)),
            }

    from .journal import ensure_project_lineage, run_mutation

    lineage = ensure_project_lineage(root)
    record = {
        "schema_version": SCHEMA_VERSION,
        "kind": "accepted_legacy_debt",
        "record_id": next_record_id(root),
        "created_at": _utc(),
        "agent": str(agent or "unknown"),
        "project_identity": _project_identity(root),
        "project_lineage": lineage,
        "check_id": RULE_ID,
        "check_version": CHECK_VERSION,
        "authority": authority,
        "reason": str(reason),
        "accepted_missing_events": sorted(
            normalized, key=lambda e: int(EVENT_INPUT_RE.match(e).group(1))
        ),
        "evidence": [
            {
                "event": event_id,
                "file": found[event_id][0],
                "line_number": found[event_id][1],
                "line_sha256": _line_sha256(found[event_id][2]),
            }
            for event_id in sorted(
                normalized, key=lambda e: int(EVENT_INPUT_RE.match(e).group(1))
            )
        ],
        "journal_op_id": None,
    }
    op_id = (
        "accepted_debt.register-"
        + hashlib.sha256(
            f"{lineage}|{record['record_id']}|{record['accepted_missing_events']}".encode(
                "utf-8"
            )
        ).hexdigest()[:12]
    )
    record["journal_op_id"] = op_id
    record["integrity_digest"] = _integrity_digest(
        {k: v for k, v in record.items() if k != "integrity_digest"}
    )
    content = json.dumps(record, indent=2, sort_keys=True).encode("utf-8")
    rel = f"{ACCEPTED_DEBT_DIR}/{record['record_id']}.json"
    committed = run_mutation(
        root,
        op_id=op_id,
        operation="accepted_debt.register",
        agent=str(agent or "unknown"),
        project_identity=record["project_identity"],
        semantic_payload_hash=hashlib.sha256(
            json.dumps(
                {
                    "record": record["record_id"],
                    "events": record["accepted_missing_events"],
                    "authority": authority,
                },
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest(),
        targets=[
            {
                "path": rel,
                "role": "report",
                "action": "write",
                "content": content,
                "before_hash": "",
                "after_hash": hashlib.sha256(content).hexdigest(),
            }
        ],
        preconditions={rel: ""},
        verification_policy="none",
    )
    if not committed.get("ok"):
        return {
            "ok": False,
            "code": committed.get("code", "VALIDATION_FAILED"),
            "detail": committed.get("detail", committed.get("message", "journal apply failed")),
        }
    return {
        "ok": True,
        "code": "ACCEPTED_DEBT_REGISTERED",
        "record_id": record["record_id"],
        "events": record["accepted_missing_events"],
        "journal_op_id": op_id,
        "authority": authority,
    }
