"""Canonical conformance closure (SAIPEN Conformance Closure Hardening).

GOAL: a SAIPEN project MUST NOT report `crew closed`, `CREW_FINALIZED`,
converged `DONE`, successful convergence closure, or post-CLEAN closure while
the canonical validator for the CURRENT checkpoint is FAILing. No reliance on
an agent remembering to run validation.

This single module is the load-bearing core. The canonical validator
(tools/validate.py) emits a structured conformance receipt on EVERY run (PASS or
FAIL). Convergence stage E/H, terminal DONE, crew SC-13 finalization, the CLEAN
exit, the continue entry gate and `saipen status` all consume that ONE receipt
-- a prose `verdict: PASS`, a caller-supplied PASS verdict, a stale validator,
fake verify evidence or an empty board can never manufacture apparent
conformance.

Sections implemented here:
  §1  canonical validator version ownership + STALE_VALIDATOR reporting
  §2  structured conformance receipt (emitted only by the validator run path)
  §3  convergence E/H must consume real receipts
  §4  terminal closure requires current conformance PASS
  §5  CLEAN exit conformance gate
  §6  continue entry health gate (additive; hard gates live in the closers)
  §8  status / viewer truth (status classification)
  §9  real UTC timestamps (fabricated-future refusal)
"""

from __future__ import annotations

import datetime
import contextlib
import hashlib
import json
import os
import re
import stat
import tempfile

import uuid
from dataclasses import dataclass
from pathlib import Path

# §1: the canonical validator's own protocol version. Bump when the receipt
# schema or the gate semantics change. The project's OWN protocol version lives
# in STATE.md `saipen_version`; that is a DIFFERENT axis and must never be
# compared against this one for staleness.
CONFORMANCE_PROTOCOL_VERSION = "1"

# Receipts live under the append-only recovery tree but are SIDE EVIDENCE, not
# history: they never mutate STATE/BOARD/LOG and a fresh clone recomputes them
# by re-running the validator. They only ever grow.
RECEIPT_DIRNAME = ".saipen/recovery/conformance"

# CORE-003: the three nested path components that must be inside the project
# root and must NOT be symlinks/junctions/reparse points.
_CONTAINMENT_COMPONENTS = (
    ".saipen",
    ".saipen/recovery",
    ".saipen/recovery/conformance",
    # CORE-001: the O(1) receipt index lives BELOW conformance/ and must obey
    # the same no-follow containment invariant. A stale/hostile symlink or
    # reparse point at this level must never redirect a canonical write
    # outside the project root.
    ".saipen/recovery/conformance/index",
)


# --------------------------------------------------------------------------- CORE-003 containment
def _validate_conformance_write_containment(
    root: Path, targets: tuple[Path, ...] = ()
) -> None:
    root_resolved = root.resolve()
    for comp in _CONTAINMENT_COMPONENTS:
        comp_path = root / comp
        try:
            info = os.lstat(comp_path)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ValueError(
                f"conformance storage component {comp!r} cannot be inspected "
                f"({exc}); refusing with zero writes"
            ) from exc
        if os.path.islink(comp_path):
            raise ValueError(
                f"conformance storage component {comp!r} is a symlink; "
                "symlinks in the conformance path are forbidden"
            )
        if getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(
                f"conformance storage component {comp!r} is a reparse point; "
                "reparse points in the conformance path are forbidden"
            )
        try:
            comp_resolved = comp_path.resolve()
        except OSError as exc:
            raise ValueError(
                f"conformance storage component {comp!r} cannot be resolved "
                f"({exc}); refusing with zero writes"
            ) from exc
        if not comp_resolved.is_relative_to(root_resolved):
            raise ValueError(
                f"conformance storage component {comp!r} resolves outside "
                f"project root ({comp_resolved} is not under {root_resolved})"
            )
    for target in targets:
        try:
            info = os.lstat(target)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ValueError(f"conformance write target cannot be inspected ({exc})") from exc
        if os.path.islink(target) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(
                f"conformance write target {target.name!r} is a symlink or reparse point"
            )
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(
                f"conformance write target {target.name!r} is not a regular file"
            )


def _validate_conformance_containment(root: Path) -> None:
    _validate_conformance_write_containment(root)
    receipt_dir = root / RECEIPT_DIRNAME
    try:
        candidates = sorted(receipt_dir.glob("*.json")) if receipt_dir.is_dir() else []
    except OSError as exc:
        raise ValueError(f"conformance receipt history cannot be listed ({exc})") from exc
    for p in candidates:
        try:
            info = os.lstat(p)
        except OSError as exc:
            raise ValueError(f"conformance receipt {p.name} cannot be inspected ({exc})") from exc
        if os.path.islink(p) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"conformance receipt {p.name} is a symlink or reparse point")
        if not stat.S_ISREG(info.st_mode):
            raise ValueError(f"conformance receipt {p.name} is not an owned regular file")
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(
                f"conformance receipt {p.name} is not readable canonical JSON: {exc}"
            ) from exc
        if not isinstance(rec, dict) or rec.get("kind") != "conformance_receipt":
            raise ValueError(f"conformance receipt {p.name} is not a conformance_receipt object")


def _atomic_write_receipt(path: Path, body: str) -> None:
    """CORE-003: write a receipt atomically via temp + replace.

    The receipt directory must already exist and pass containment checks.
    A crash during write leaves either the old receipt or the new one,
    never a partial file.
    """
    parent = path.parent
    fd, tmp_path = tempfile.mkstemp(suffix=".tmp", prefix=path.stem + "-", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body)
            f.write("\n")
        os.replace(tmp_path, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_path)
        raise


# §9: max allowed clock skew (seconds). A receipt timestamp further in the
# future than this is treated as fabricated and refused.
MAX_CLOCK_SKEW_SECONDS = 300

# §8: closed set of authoritative conformance statuses.
STATUS_CURRENT_PASS = "CURRENT_PASS"
STATUS_CURRENT_FAIL = "CURRENT_FAIL"
STATUS_STALE_PASS = "STALE_PASS"
STATUS_STALE_FAIL = "STALE_FAIL"
STATUS_NOT_RUN = "NOT_RUN"
STATUS_VERSION_MISMATCH = "VALIDATOR_VERSION_MISMATCH"
STATUS_INVALID = "INVALID_RECEIPT"

# How long a PASS receipt stays "current" before it ages into STALE (24h). A
# project that has not validated in a day cannot claim terminal closure on a
# week-old green stamp.
FRESHNESS_WINDOW_SECONDS = 24 * 3600


class ReceiptDiscoveryError(ValueError):
    """A canonical receipt candidate exists but cannot be trusted.

    Discovery is part of the conformance proof.  Silently dropping a broken
    candidate would let an older PASS become authoritative after newer red
    evidence was damaged.
    """


# --------------------------------------------------------------------------- utils
def _utc_now_iso(now: datetime.datetime | None = None) -> str:
    """W2-005: microsecond-precision UTC timestamp for total ordering.

    Two executions within the same wall-clock second must still produce
    different timestamps so receipt ordering is deterministic.
    """
    ref = now or datetime.datetime.now(datetime.timezone.utc)
    return ref.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _receipt_id() -> str:
    """W2-005: immutable unique receipt identifier.

    Every validator execution gets a unique id so receipts can never
    overwrite earlier evidence and ordering is unambiguous.
    """
    return "receipt-" + uuid.uuid4().hex[:12]


def _safe_filename_component(value: str) -> str:
    """W2-006: make a string safe for use as a filename component.

    Replaces OS-specific invalid characters (Windows reserved chars
    like : / * ? " < > | and control characters) with underscores.
    """
    # Characters forbidden on Windows (and problematic on POSIX in filenames)
    _unsafe = set('/<>:"|?*\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\x0c\r\x0e\x0f')
    # Also forbid colon which is NTFS alternate-data-stream syntax
    _unsafe.add(":")
    result = []
    for ch in value:
        if ch in _unsafe or ord(ch) < 0x20:
            result.append("_")
        else:
            result.append(ch)
    return "".join(result)


def _strict_iso_utc(value) -> str:
    """Strict ISO-8601 UTC (Z or +00:00, utcoffset == 0), else ''."""
    if not isinstance(value, str):
        return ""
    text = value.strip()
    if not text:
        return ""
    try:
        dt = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if dt.utcoffset() is None or dt.utcoffset().total_seconds() != 0:
        return ""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _future_beyond_skew(ts_iso: str, now: datetime.datetime | None = None) -> bool:
    """§9: a timestamp in the future beyond the skew allowance is fabricated."""
    norm = _strict_iso_utc(ts_iso)
    if not norm:
        return False
    dt = datetime.datetime.fromisoformat(norm.replace("Z", "+00:00"))
    ref = now or datetime.datetime.now(datetime.timezone.utc)
    return (dt - ref).total_seconds() > MAX_CLOCK_SKEW_SECONDS


def _quick_hash(text) -> str:
    data = text.encode("utf-8") if isinstance(text, str) else text
    return hashlib.sha256(data).hexdigest()[:16]


def _hash_file(path: Path) -> str:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:16]
    except OSError:
        return ""


def _source_identity(project_root: Path):
    try:
        from freshness import compute_source_identity

        return compute_source_identity(Path(project_root))
    except Exception:
        return None


def _project_identity(project_root: Path) -> str:
    try:
        from .paths import project_identity as _pi

        return _pi(Path(project_root))
    except Exception:
        return ""


def _log_hash(project_root: Path) -> str:
    try:
        from .log import history_hash

        return history_hash(Path(project_root))
    except Exception:
        return ""


# --------------------------------------------------------------------------- §1
@dataclass(frozen=True)
class ValidatorVersionInfo:
    validator_path: str
    validator_protocol_version: str
    project_protocol_version: str | None
    gate: str
    source_head: str
    source_tree_fingerprint: str

    def as_dict(self) -> dict:
        return {
            "validator_path": self.validator_path,
            "validator_protocol_version": self.validator_protocol_version,
            "project_protocol_version": self.project_protocol_version,
            "gate": self.gate,
            "source_head": self.source_head,
            "source_tree_fingerprint": self.source_tree_fingerprint,
        }


def validator_version_info(
    project_root: Path | str,
    gate: str = "core",
    # PERF-002: optional pre-computed SourceIdentity to avoid redundant
    # filesystem/Git subprocess calls. When provided, skips _source_identity.
    source_identity=None,
) -> ValidatorVersionInfo:
    """§1: resolve validator authority from the project's bound SAIPEN home.

    The canonical validator is the one living next to this engine
    (tools/validate.py), NOT a copy vendored elsewhere. We report its path and
    protocol version together with the project's own protocol version so any
    viewer/tool can detect a STALE_VALIDATOR (a different validator binary than
    the canonical one on disk).

    PERF-002: accepts an optional pre-computed SourceIdentity to avoid
    redundant computation when the caller has already captured the identity.
    """
    root = Path(project_root)
    validator_path = str((Path(__file__).resolve().parent.parent / "validate.py").resolve())
    project_protocol: str | None = None
    try:
        state_text = (root / ".saipen" / "STATE.md").read_text(
            encoding="utf-8-sig", errors="ignore"
        )
        for line in state_text.splitlines():
            if line.startswith("saipen_version:"):
                project_protocol = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    # PERF-002: use pre-computed identity if available
    ident = source_identity if source_identity is not None else _source_identity(root)
    return ValidatorVersionInfo(
        validator_path=validator_path,
        validator_protocol_version=CONFORMANCE_PROTOCOL_VERSION,
        project_protocol_version=project_protocol,
        gate=gate,
        source_head=ident.source_head if ident else "",
        source_tree_fingerprint=ident.source_tree_fingerprint if ident else "",
    )


def stale_validator(project_root: Path | str, tool_validator_version: str | None = None) -> bool:
    """§1: report STALE_VALIDATOR when a viewer/tool uses a different validator
    version than the canonical one on disk."""
    return bool(
        tool_validator_version is not None
        and tool_validator_version != CONFORMANCE_PROTOCOL_VERSION
    )


# --------------------------------------------------------------------------- §2
def _bounded_remediation_commands(commands) -> list[str]:
    """The executable commands a FAIL receipt may advertise (T-1434 M1).

    The validator's own failure messages name their remediation; carrying the
    bounded machine-readable list INTO the receipt is what lets the router
    lead with a real repair (`saipen work reverify T-008`) instead of the
    generic `saipen validate` loop. Only registered remediation shapes survive,
    each bounded, deduplicated and capped -- a receipt is evidence, not a log.
    """
    from .remediation import resolve_command

    out: list[str] = []
    seen: set[str] = set()
    for raw in commands or ():
        command = str(raw or "").strip()
        if len(command) > 160 or not resolve_command(command).get("ok"):
            continue
        if command in seen:
            continue
        seen.add(command)
        out.append(command)
        if len(out) >= 10:
            break
    return out


def _bounded_external_actions(actions) -> list[dict]:
    """The TYPED external remediations a FAIL receipt may advertise (M5.2).

    An external action is never a command: each record carries
    ``kind: external`` plus a closed ``external_kind``, so a machine consumer
    can distinguish "executable now" from "requires an actor SAIPEN is not"
    without prose parsing.
    """
    from . import remediation

    out: list[dict] = []
    for raw in actions or ():
        if remediation.is_external(raw):
            out.append(
                {
                    "kind": "external",
                    "external_kind": raw["external_kind"],
                    "detail": str(raw.get("detail") or "")[:240],
                }
            )
        if len(out) >= 10:
            break
    return out


def generate_conformance_receipt(
    project_root: Path | str,
    *,
    gate: str,
    exit_code: int,
    validator_version: str | None = None,
    now: datetime.datetime | None = None,
    source_identity=None,
    remediation_commands=None,
    external_actions=None,
    blocking_findings=None,
) -> dict:
    """§2: mechanically produce ONE structured conformance receipt.

    Binds validator version, gate, exit code, PASS/FAIL, real UTC timestamp,
    project/source identity, STATE/BOARD/LOG hashes and source_head/
    source_tree_fingerprint. Written under `.saipen/recovery/conformance/`.

    CRITICAL: the verdict is DERIVED ONLY from `exit_code` (0 == PASS). The
    function does not even accept a `verdict` argument, so no caller can pass
    `verdict="PASS"` to manufacture a green receipt. This is the ONLY path that
    creates a receipt, and it is invoked exclusively from the validator's real
    execution path (tools/validate.py)."""
    root = Path(project_root)
    verdict = "PASS" if int(exit_code or 0) == 0 else "FAIL"
    ts = _utc_now_iso(now)
    # §9: refuse to write a receipt whose stamp sits in the future beyond the
    # skew allowance relative to the REAL wall clock. Comparing against the real
    # clock (not the caller-supplied `now`) is what makes this guard live: a
    # caller passing a fabricated-future `now` gets refused instead of emitting
    # a back-dated-looking green stamp.
    if _future_beyond_skew(ts, datetime.datetime.now(datetime.timezone.utc)):
        raise ValueError("conformance receipt timestamp is in the future beyond allowed skew")
    state_hash = _hash_file(root / ".saipen" / "STATE.md")
    board_hash = _hash_file(root / ".saipen" / "BOARD.md")
    log_hash = _log_hash(root)
    # PERF-002: carry the call-scoped SourceIdentity forward when the caller
    # already captured one (the validator establishes source identity before
    # receipt generation). Bounded-revalidate it so the receipt still binds
    # proof valid at receipt time; fall back to a fresh full capture only when
    # unavailable or changed.
    if source_identity is not None:
        try:
            from freshness import revalidate_source_identity

            ok, _err = revalidate_source_identity(root, source_identity)
            ident = source_identity if ok else _source_identity(root)
        except Exception:
            ident = _source_identity(root)
    else:
        ident = _source_identity(root)
    # CORE-002: missing proof is NOT proof. A PASS receipt must carry positive
    # source identity and complete checkpoint bindings; refusing to mint one
    # from empty evidence stops "empty==empty" from ever becoming CURRENT_PASS.
    source_head = getattr(ident, "source_head", "") or ""
    source_fp = getattr(ident, "source_tree_fingerprint", "") or ""
    if verdict == "PASS":
        if not source_head or not source_fp:
            raise ValueError(
                "conformance PASS receipt requires positive source identity; "
                "source_head/source_tree_fingerprint are empty"
            )
        missing = []
        if not state_hash:
            missing.append("state_hash")
        if not board_hash:
            missing.append("board_hash")
        if not log_hash:
            missing.append("log_hash")
        if missing:
            raise ValueError(
                "conformance PASS receipt requires complete checkpoint binding; "
                "missing: " + ", ".join(missing)
            )
    project_identity = _project_identity(root)
    # W2-005: unique receipt id and microsecond-precision timestamp for
    # total ordering. Never overwrites an earlier receipt.
    rid = _receipt_id()
    bounded_remediation = _bounded_remediation_commands(remediation_commands)
    bounded_external = _bounded_external_actions(external_actions)
    receipt = {
        "schema_version": 2,
        "kind": "conformance_receipt",
        "receipt_id": rid,
        "validator_protocol_version": validator_version or CONFORMANCE_PROTOCOL_VERSION,
        "gate": gate,
        "exit_code": int(exit_code or 0),
        "verdict": verdict,
        "timestamp_utc": ts,
        "project_identity": project_identity,
        "source_head": ident.source_head if ident else "",
        "source_tree_fingerprint": ident.source_tree_fingerprint if ident else "",
        "state_hash": state_hash,
        "board_hash": board_hash,
        "log_hash": log_hash,
        # T-1434 M1: the executable repairs the failures themselves named,
        # bounded and deduplicated. Empty on a PASS; on a FAIL the router may
        # lead with the first one instead of re-running the whole gate.
        "remediation_commands": bounded_remediation,
        # T-1434 M5.2: typed external remediations, never disguised commands.
        # Empty when no current rule needs an actor outside the project.
        "external_actions": bounded_external,
        # T-1439: complete classified blocking records from THIS execution,
        # bound by the same content/source/checkpoint hashes as the verdict.
        # Retain the array: distinct unclassified findings may share a key.
        "blocking_findings": blocking_findings if blocking_findings is not None else {
            "status": "unavailable",
            "reason": "validator did not provide complete classified blocking findings",
        },
        "canonical_next_command": (
            bounded_remediation[0] if verdict == "FAIL" and bounded_remediation else None
        ),
    }
    # content_hash binds the EXACT written bytes, so compute it from the body
    # BEFORE serializing for real -- otherwise the on-disk receipt would omit it.
    receipt["content_hash"] = _quick_hash(json.dumps(receipt, indent=2, sort_keys=True))
    body = json.dumps(receipt, indent=2, sort_keys=True)
    # CORE-003: validate WRITE containment BEFORE any filesystem mutation so a
    # symlinked .saipen/recovery/conformance never follows to an outside dir.
    # This is the constant-size storage-chain proof; the historical-receipt
    # validity check is separate and is invoked by readers/strict-fallback paths.
    _validate_conformance_write_containment(root)
    out_dir = root / RECEIPT_DIRNAME
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        prior_receipt_dir_mtime_ns = out_dir.stat().st_mtime_ns
    except OSError:
        prior_receipt_dir_mtime_ns = -1
    # W2-005/W2-006: use receipt_id + safe gate name for unique, portable filename
    safe_gate = _safe_filename_component(gate)
    safe_ts = _safe_filename_component(ts)
    fname = f"{safe_ts}_{rid}_{safe_gate}_{verdict}.json"
    _atomic_write_receipt(out_dir / fname, body)
    # PERF-003: atomically advance the per-gate latest-receipt index
    _update_receipt_index(
        root,
        gate,
        rid,
        ts,
        receipt_path=f"{RECEIPT_DIRNAME}/{fname}",
        prior_receipt_dir_mtime_ns=prior_receipt_dir_mtime_ns,
    )
    return receipt


# PERF-003: per-gate latest-receipt index for O(1) lookup
_INDEX_DIRNAME = ".saipen/recovery/conformance/index"
_LINEAGE_INDEX_NAME = ".lineage.json"


def _receipt_inventory(root: Path) -> tuple[int, int] | None:
    """Cheap name/stat inventory used only by legacy direct index callers.

    Canonical receipt generation passes the pre-append directory token and is
    O(1).  Direct callers lack that token, so this no-content scan proves that
    exactly the named receipt was appended before trusting the lineage cursor.
    """
    out_dir = root / RECEIPT_DIRNAME
    count = 0
    xor = 0
    try:
        with os.scandir(out_dir) as entries:
            for entry in entries:
                if not entry.name.endswith(".json"):
                    continue
                if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                    return None
                # DirEntry.stat() reports a synthetic inode on this host;
                # use lstat so the append token matches direct callers.
                info = os.lstat(entry.path)
                # Metadata is only a mutation hint.  Any drift falls back to
                # the strict content parser; it is never conformance proof.
                token = _receipt_stat_token(entry.name, info)
                xor ^= int.from_bytes(token[:16], "big")
                count += 1
    except OSError:
        return None
    return count, xor


def _receipt_inventory_token(root: Path, receipt_path: str) -> int | None:
    rel = Path(receipt_path)
    expected_parent = Path(RECEIPT_DIRNAME)
    if rel.parent != expected_parent or rel.name in {"", ".", ".."}:
        return None
    target = root / rel
    try:
        info = os.lstat(target)
    except OSError:
        return None
    if os.path.islink(target) or not target.is_file():
        return None
    token = _receipt_stat_token(rel.name, info)
    return int.from_bytes(token[:16], "big")


def _receipt_stat_token(name: str, info: os.stat_result) -> bytes:
    """Return a cheap mutation hint; content remains the authority."""
    return hashlib.sha256(
        (
            name
            + "\0"
            + str(info.st_size)
            + "\0"
            + str(info.st_mtime_ns)
            + "\0"
            + str(getattr(info, "st_ctime_ns", 0))
            + "\0"
            + str(getattr(info, "st_ino", 0))
        ).encode("utf-8", "surrogatepass")
    ).digest()


def _receipt_content_token(path: Path, name: str, witnessed: os.stat_result) -> int | None:
    """Hash exact receipt bytes through the witnessed regular-file node."""
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        descriptor = os.open(path, flags)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or (
            opened.st_dev,
            opened.st_ino,
        ) != (witnessed.st_dev, witnessed.st_ino):
            return None
        digest = hashlib.sha256(name.encode("utf-8", "surrogatepass") + b"\0")
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            descriptor = -1
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        return int.from_bytes(digest.digest()[:16], "big")
    except OSError:
        return None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _receipt_content_inventory(root: Path) -> tuple[int, int] | None:
    """Exact-byte inventory backing the authenticated lineage cursor."""
    out_dir = root / RECEIPT_DIRNAME
    count = 0
    xor = 0
    try:
        with os.scandir(out_dir) as entries:
            for entry in entries:
                if not entry.name.endswith(".json"):
                    continue
                if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                    return None
                witnessed = os.lstat(entry.path)
                token = _receipt_content_token(Path(entry.path), entry.name, witnessed)
                if token is None:
                    return None
                xor ^= token
                count += 1
    except OSError:
        return None
    return count, xor


def _receipt_content_inventory_token(root: Path, receipt_path: str) -> int | None:
    rel = Path(receipt_path)
    if rel.parent != Path(RECEIPT_DIRNAME) or rel.name in {"", ".", ".."}:
        return None
    target = root / rel
    try:
        witnessed = os.lstat(target)
    except OSError:
        return None
    if os.path.islink(target) or not stat.S_ISREG(witnessed.st_mode):
        return None
    return _receipt_content_token(target, rel.name, witnessed)


def _receipt_member_inventory(root: Path) -> tuple[tuple[str, str], ...] | None:
    """Return exact receipt filename/content membership, not XOR evidence."""
    out_dir = root / RECEIPT_DIRNAME
    members = []
    try:
        with os.scandir(out_dir) as entries:
            for entry in entries:
                if not entry.name.endswith(".json"):
                    continue
                if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                    return None
                witnessed = os.lstat(entry.path)
                token = _receipt_content_token(Path(entry.path), entry.name, witnessed)
                if token is None:
                    return None
                members.append((entry.name, f"{token:032x}"))
    except OSError:
        return None
    return tuple(sorted(members))


def _load_lineage_index(root: Path) -> dict | None:

    path = root / _INDEX_DIRNAME / _LINEAGE_INDEX_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    required = {
        "version": int,
        "receipt_count": int,
        "inventory_xor": str,
        "content_xor": str,
        "receipt_dir_mtime_ns": int,
        "lineage_hash": str,
        "members": list,
    }

    if not isinstance(data, dict) or any(
        not isinstance(data.get(key), kind) for key, kind in required.items()
    ):
        return None
    try:
        int(data["inventory_xor"], 16)
        int(data["content_xor"], 16)
    except ValueError:
        return None
    members = data["members"]
    if any(
        not isinstance(item, list)
        or len(item) != 2
        or not isinstance(item[0], str)
        or not isinstance(item[1], str)
        or not re.fullmatch(r"[0-9a-f]{32}", item[1])
        for item in members
    ) or len({item[0] for item in members}) != len(members):
        return None
    return data



def _receipt_matches_append(
    root: Path, gate: str, receipt_id: str, timestamp: str, receipt_path: str
) -> dict | None:
    rec = _read_indexed_receipt(root, {"receipt_path": receipt_path})
    if (
        rec is None
        or rec.get("gate") != gate
        or rec.get("receipt_id") != receipt_id
        or rec.get("timestamp_utc") != timestamp
    ):
        return None
    return rec


def _update_receipt_index(
    root: Path,
    gate: str,
    receipt_id: str,
    timestamp: str,
    receipt_path: str = "",
    *,
    prior_receipt_dir_mtime_ns: int | None = None,
) -> None:
    """PERF-003/04: atomically advance the per-gate latest-receipt index.

    The index is a tiny JSON LOCATOR carrying the receipt_id, the validated
    timestamp, and a safe RELATIVE path to the receipt file. The path turns
    lookup into a constant-I/O direct read; lookup still validates the receipt
    and falls back to a full scan on a missing/corrupt/relocated index -- it
    never mutates state on a read-only upgrade.

    SRC-025:R011: when a trustworthy pre-append directory token is supplied
    (prior_receipt_dir_mtime_ns), delegate to the bounded conformance lineage
    advance. On bounded success the v2 lineage head and per-gate locators are
    written by the lineage module and this v1 index pass returns without
    touching them. On refusal with a live v2 head the v1 index pass also
    returns without touching anything: the lineage authority already exists,
    the refusal means the head no longer represents the namespace the caller
    saw (crash between receipt write and head publish, or an out-of-band
    sibling), and the only honest recovery is the canonical deep rebuild --
    this legacy writer must never clobber the v2 head/locator pair with a v1
    bootstrap document (zero mutation on refusal).
    """
    root = Path(root)
    if prior_receipt_dir_mtime_ns is not None:
        from . import conformance_lineage as _cl

        if _cl.advance_append(
            root,
            gate,
            receipt_id,
            timestamp,
            receipt_path,
            prior_receipt_dir_mtime_ns=prior_receipt_dir_mtime_ns,
        ):
            return
        if _cl._read_head(root) is not None:
            return
    appended = _receipt_matches_append(root, gate, receipt_id, timestamp, receipt_path)
    proof = _load_lineage_index(root)
    incremental = False
    next_count = 0
    next_xor = 0
    next_content_xor = 0
    members: tuple[tuple[str, str], ...] | None = None
    if proof is not None:
        if appended is None:
            return
        content_token = _receipt_content_inventory_token(root, receipt_path)
        if content_token is None:
            return
        previous_members = tuple(map(tuple, proof["members"]))
        members = _receipt_member_inventory(root)
        expected_members = tuple(
            sorted((*previous_members, (Path(receipt_path).name, f"{content_token:032x}")))
        )
        incremental = members == expected_members
        if incremental:
            next_count = proof["receipt_count"] + 1
            next_xor = int(proof["inventory_xor"], 16) ^ int.from_bytes(
                _receipt_stat_token(Path(receipt_path).name, os.lstat(root / receipt_path))[:16],
                "big",
            )
            next_content_xor = int(proof["content_xor"], 16) ^ content_token
        else:
            return


    receipts: list[dict] | None = None
    if not incremental:
        # Bootstrap or unexpected out-of-band change: strict full validation.
        # A corrupt sibling leaves both the lineage cursor and per-gate locator
        # stale, so readers fail closed via their canonical scan.
        try:
            receipts = _iter_receipts(root)
        except ReceiptDiscoveryError:
            return
        if not any(
            rec.get("receipt_id") == receipt_id
            and rec.get("gate") == gate
            and rec.get("timestamp_utc") == timestamp
            for rec in receipts
        ):
            return
        inventory = _receipt_inventory(root)
        content_inventory = _receipt_content_inventory(root)
        if inventory is None or content_inventory is None or inventory[0] != content_inventory[0]:
            return
        next_count, next_xor = inventory
        next_content_xor = content_inventory[1]
        members = _receipt_member_inventory(root)
        if members is None:
            return
    # CORE-001: the index directory participates in the conformance

    # write-containment boundary. Prove .saipen/recovery/conformance/index
    # has no symlink/junction/reparse ancestry and resolves inside the project
    # BEFORE mkdir / temp-file / os.replace. Zero index writes before this proof.
    # Constant-size write containment: the historical sibling scan is a separate
    # evidence-validation step (PERF-003), not part of this write proof.
    _validate_conformance_write_containment(root)
    index_dir = root / _INDEX_DIRNAME
    index_dir.mkdir(parents=True, exist_ok=True)
    index_path = index_dir / f"{gate}.json"
    receipt_dir = root / RECEIPT_DIRNAME
    try:
        receipt_dir_mtime_ns = receipt_dir.stat().st_mtime_ns
    except OSError:
        receipt_dir_mtime_ns = -1
    index = {
        "gate": gate,
        "receipt_id": receipt_id,
        "timestamp_utc": timestamp,
        "receipt_path": receipt_path,
        "version": 1,
        # Crash-staleness token: creation of any newer immutable receipt
        # changes the receipt directory mtime before index replacement.  A
        # reader can therefore prove the locator is still latest with one stat;
        # mismatch falls back to the canonical ordered scan.
        "receipt_dir_mtime_ns": receipt_dir_mtime_ns,
    }
    _atomic_write_receipt(index_path, json.dumps(index, indent=2, sort_keys=True))
    if incremental and proof is not None:
        lineage_seed = proof["lineage_hash"]
        lineage_payload = {
            "previous": lineage_seed,
            "receipt_id": receipt_id,
            "receipt_path": receipt_path,
            "content_hash": appended.get("content_hash", ""),
        }
    else:
        lineage_payload = [
            {
                "receipt_id": rec.get("receipt_id", ""),
                "gate": rec.get("gate", ""),
                "timestamp_utc": rec.get("timestamp_utc", ""),
                "content_hash": rec.get("content_hash", ""),
            }
            for rec in (receipts or [])
        ]
    lineage = {
        "version": 1,
        "receipt_count": next_count,
        "inventory_xor": f"{next_xor:032x}",
        "content_xor": f"{next_content_xor:032x}",
        "members": [list(item) for item in (members or ())],
        "receipt_dir_mtime_ns": receipt_dir_mtime_ns,

        "lineage_hash": hashlib.sha256(
            json.dumps(lineage_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
    }
    _atomic_write_receipt(
        index_dir / _LINEAGE_INDEX_NAME,
        json.dumps(lineage, indent=2, sort_keys=True),
    )


def _lookup_receipt_index(root: Path, gate: str) -> dict | None:
    """PERF-003: read the per-gate latest-receipt index.

    Returns the indexed receipt metadata, or None if the index is
    absent/corrupt.
    """
    index_path = root / _INDEX_DIRNAME / f"{gate}.json"
    if not index_path.is_file():
        return None
    try:
        data = json.loads(index_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return None
        if data.get("gate") != gate or "receipt_id" not in data:
            return None
        return data
    except (OSError, json.JSONDecodeError):
        return None


def _read_indexed_receipt(root: Path, index: dict) -> dict | None:
    """PERF-004: constant-I/O direct read of the indexed receipt by its safe
    relative path. Rejects path escapes, symlinks and reparse points; returns
    None (never mutating state) on any failure so the caller falls back to a
    full scan -- the index is a LOCATOR, not conformance proof."""
    rel = index.get("receipt_path") or ""
    if not rel or not rel.startswith(RECEIPT_DIRNAME):
        return None
    try:
        base = (root / RECEIPT_DIRNAME).resolve()
        target = (root / rel).resolve()
    except OSError:
        return None
    if target != base and base not in target.parents:
        return None
    try:
        info = os.lstat(target)
    except OSError:
        return None
    if os.path.islink(target) or getattr(info, "st_file_attributes", 0) & 0x400:
        return None
    try:
        rec = json.loads(Path(target).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if rec.get("kind") != "conformance_receipt":
        return None
    return rec


def _find_receipt_by_id(project_root: Path, receipt_id: str) -> dict | None:
    """PERF-003: find a receipt by its unique id across all receipt files."""
    out_dir = project_root / RECEIPT_DIRNAME
    if not out_dir.is_dir():
        return None
    for p in out_dir.glob("*.json"):
        try:
            info = os.lstat(p)
        except OSError:
            continue
        if os.path.islink(p) or getattr(info, "st_file_attributes", 0) & 0x400:
            continue
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if rec.get("receipt_id") == receipt_id:
            return rec
    return None


def _iter_receipts(project_root: Path) -> list[dict]:
    root = Path(project_root)
    out_dir = root / RECEIPT_DIRNAME
    if not out_dir.is_dir():
        return []
    out: list[dict] = []
    for p in sorted(out_dir.glob("*.json")):
        # CORE-003: reject symlinked/reparse-point receipt files -- an
        # externally located receipt must never be imported as project evidence.
        try:
            info = os.lstat(p)
        except OSError as exc:
            raise ReceiptDiscoveryError(f"receipt {p.name} is unreadable: {exc}") from exc
        if (
            os.path.islink(p)
            or getattr(info, "st_file_attributes", 0) & 0x400
            or not p.is_file()
        ):
            raise ReceiptDiscoveryError(f"receipt {p.name} is not an owned regular file")
        try:
            rec = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReceiptDiscoveryError(
                f"receipt {p.name} is not readable canonical JSON: {exc}"
            ) from exc
        if not isinstance(rec, dict) or rec.get("kind") != "conformance_receipt":
            raise ReceiptDiscoveryError(
                f"receipt {p.name} is not a conformance_receipt object"
            )
        out.append(rec)
    return out


def latest_receipt(project_root: Path | str, gate: str | None = None) -> dict | None:
    """PERF-003/W2-005: return the latest receipt ordered by validated completion.

    Uses the atomic per-gate index for O(1) lookup when available. Falls back
    to a full strict scan if the index is absent/corrupt/references a missing
    receipt.
    """
    root = Path(project_root)
    if gate is not None:
        # SRC-025:R011: bounded authenticated lineage lookup first (head +
        # locator + one generation + one receipt). handled=False means no v2
        # lineage exists: the legacy path below runs unchanged. handled=True
        # with record None degrades to the same legacy path.
        from .conformance_lineage import latest_receipt_bounded

        handled, record = latest_receipt_bounded(root, gate)
        if handled and record is not None:
            return record
        # PERF-003/04: index-first lookup. When the index carries a safe
        # relative receipt path, read that ONE file directly (constant I/O);
        # otherwise fall back to a full scan. Any failure (missing path,
        # corrupt/moved receipt, relocated index) degrades to the scan and
        # never mutates state on a read-only upgrade.
        index = _lookup_receipt_index(root, gate)
        if index is not None:
            rec = _read_indexed_receipt(root, index)
            proof = _load_lineage_index(root)
            inventory = _receipt_inventory(root) if proof is not None else None
            content_inventory = (
                _receipt_content_inventory(root) if proof is not None else None
            )
            if (
                rec is not None
                and proof is not None
                and inventory == (proof["receipt_count"], int(proof["inventory_xor"], 16))
                and content_inventory
                == (proof["receipt_count"], int(proof["content_xor"], 16))
                and rec.get("gate") == gate
                and rec.get("receipt_id") == index.get("receipt_id")
                and rec.get("timestamp_utc") == index.get("timestamp_utc")
            ):
                return rec
        # Index miss/corruption/relocation: fall back to full scan
        receipts = _iter_receipts(root)
        receipts = [r for r in receipts if r.get("gate") == gate]
    else:
        receipts = _iter_receipts(root)
    if not receipts:
        return None
    # CORE-001: order by parsed canonical UTC instant, not lexical string.
    # `Z` sorts after `.` lexically, reversing chronology inside one second
    # when legacy whole-second and current fractional spellings coexist.
    # Malformed timestamps are fail-closed: they sort as earliest, never as
    # permissive lexical latest.
    from .board import iso_utc_sort_key

    _earliest = iso_utc_sort_key("0000-01-01T00:00:00Z")

    def _receipt_sort_key(r: dict):
        ts = iso_utc_sort_key(r.get("timestamp_utc", ""))
        return (ts or _earliest, r.get("receipt_id", ""))

    return max(receipts, key=_receipt_sort_key)


# ---------------------------------------------------------------------------
# CORE-001 strict receipt validation
# Required fields for a receipt to be considered structurally valid.
# schema_version 2+ requires receipt_id for W2-005 total ordering.
_RECEIPT_REQUIRED_FIELDS_V1 = frozenset(
    {
        "schema_version",
        "kind",
        "validator_protocol_version",
        "gate",
        "exit_code",
        "verdict",
        "timestamp_utc",
    }
)
_RECEIPT_REQUIRED_FIELDS_V2 = _RECEIPT_REQUIRED_FIELDS_V1 | {"receipt_id"}

# Allowed gate values.
_ALLOWED_GATES = ("core", "crew")


def _strict_validate_receipt(receipt: dict, gate: str, project_root: Path) -> str | None:
    """CORE-001: one strict conformance-receipt decoder.

    Returns None when the receipt is structurally and cryptographically
    valid. Returns a reason string when the receipt is malformed, tampered,
    or checkpoint-mismatched. A receipt that fails this check is INVALID
    and must never satisfy `current_conformance_pass`.

    Checks:
    - Closed schema (required fields present)
    - Receipt protocol version matches
    - Allowed gate value
    - Real timestamp parsing
    - exit_code == 0 <=> verdict == PASS
    - content_hash revalidation over the canonical receipt body
    - (For CURRENT status) STATE/BOARD/LOG hashes match current files
    """
    # 1. Schema: required fields present (version-aware)
    if not isinstance(receipt, dict):
        return "receipt is not a JSON object"
    schema_version = receipt.get("schema_version")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version not in (1, 2)
    ):
        return f"receipt schema_version must be integer 1 or 2: {schema_version!r}"
    required = _RECEIPT_REQUIRED_FIELDS_V2 if schema_version >= 2 else _RECEIPT_REQUIRED_FIELDS_V1
    missing = required - set(receipt.keys())
    if missing:
        return f"receipt is missing required fields: {sorted(missing)}"

    # 2. Gate is in the allowed set. Protocol-version classification is a
    # separate authoritative status after the shape is proven total.
    if receipt.get("gate") not in _ALLOWED_GATES:
        return f"receipt gate {receipt.get('gate')!r} is not in {_ALLOWED_GATES}"
    if receipt.get("gate") != gate:
        return f"receipt gate {receipt.get('gate')!r} does not match requested gate {gate!r}"

    # 3. exit_code / verdict consistency: exit_code == 0 <=> verdict == PASS
    exit_code = receipt.get("exit_code")
    verdict = receipt.get("verdict")
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        return f"receipt exit_code is not an integer: {exit_code!r}"
    if verdict not in ("PASS", "FAIL"):
        return f"receipt verdict is not PASS/FAIL: {verdict!r}"
    if (exit_code == 0) != (verdict == "PASS"):
        return f"exit_code/verdict inconsistency: exit_code={exit_code} but verdict={verdict}"

    # 4. content_hash revalidation: recompute from the receipt body
    #    (every field except content_hash itself)
    stored_hash = receipt.get("content_hash", "")
    if not stored_hash:
        return "receipt has no content_hash"
    body_for_hash = {k: v for k, v in receipt.items() if k != "content_hash"}
    recomputed = _quick_hash(json.dumps(body_for_hash, indent=2, sort_keys=True))
    if recomputed != stored_hash:
        return (
            f"content_hash mismatch: stored={stored_hash[:16]}.. "
            f"recomputed={recomputed[:16]}.. (receipt body was tampered)"
        )

    # Optional diagnostic extension; old receipts remain readable. A malformed
    # complete set is unavailable evidence, never a current empty/green set.
    blocking = receipt.get("blocking_findings")
    if blocking is not None:
        if not isinstance(blocking, dict) or blocking.get("status") not in (
            "complete", "unavailable"
        ):
            return "receipt blocking_findings has invalid status/shape"
        if blocking["status"] == "complete":
            problems = blocking.get("problems")
            count = blocking.get("problem_count")
            warning_count = blocking.get("warning_count")
            if (
                not isinstance(problems, list)
                or type(count) is not int or count != len(problems)
                or type(warning_count) is not int or warning_count < 0
                or not blocking.get("ruleset_version")
                or not blocking.get("ruleset_fingerprint")
                or any(not isinstance(item, dict) or item.get("severity") != "problem"
                       for item in problems)
                or (verdict == "PASS" and count != 0)
            ):
                return "receipt blocking_findings is not a complete consistent problem set"

    # 5. Real timestamp parsing
    ts = receipt.get("timestamp_utc", "")
    if not _strict_iso_utc(ts):
        return f"receipt timestamp is not valid ISO-8601 UTC: {ts!r}"

    return None


def _checkpoint_hash_mismatch(receipt: dict, root: Path) -> str | None:
    """CORE-001: recompute and compare STATE/BOARD/LOG hashes.

    Returns None when all hashes match, or a reason string describing the
    first mismatch. This catches tampered receipts that have valid structure
    but were written for a different checkpoint state.

    CORE-002: empty evidence is NOT matching evidence. A missing stored hash
    (a receipt minted without binding) or an unreadable current file must
    classify as a mismatch so CURRENT_PASS never rests on empty==empty.
    """
    current_state = _hash_file(root / ".saipen" / "STATE.md")
    current_board = _hash_file(root / ".saipen" / "BOARD.md")
    current_log = _log_hash(root)
    stored_state = receipt.get("state_hash", "")
    stored_board = receipt.get("board_hash", "")
    stored_log = receipt.get("log_hash", "")
    for label, stored, current in (
        ("STATE", stored_state, current_state),
        ("BOARD", stored_board, current_board),
        ("LOG", stored_log, current_log),
    ):
        if not stored:
            return f"{label} receipt hash is empty -- receipt was not bound to a checkpoint"
        if not current:
            return f"{label} current hash unavailable -- cannot prove checkpoint currentness"
        if stored != current:
            return f"{label} hash mismatch: receipt={stored} current={current}"
    return None


# --------------------------------------------------------------------------- §8
def conformance_status(
    project_root: Path | str,
    gate: str = "core",
    now: datetime.datetime | None = None,
    # PERF-002: optional pre-computed SourceIdentity to avoid redundant
    # filesystem/Git subprocess calls.
    source_identity=None,
) -> dict:
    """§8: classify the CURRENT authoritative conformance for a gate.

    CORE-001: the receipt is now STRICTLY validated before classification.
    Schema, exit_code/verdict consistency, content_hash integrity, and
    (for CURRENT) checkpoint hash binding are all enforced. A forged,
    tampered, or checkpoint-mismatched receipt is INVALID/STALE and never
    satisfies `current_conformance_pass`.

    PERF-002: accepts an optional pre-computed SourceIdentity to avoid
    redundant computation when the caller has already captured the identity.

    Terminal/crew closure is permitted ONLY when status == CURRENT_PASS. Every
    other status (NOT_RUN, STALE_*, CURRENT_FAIL, VALIDATOR_VERSION_MISMATCH)
    forbids closure and must be surfaced truthfully by `saipen status` and any
    viewer."""
    ref = now or datetime.datetime.now(datetime.timezone.utc)
    info = validator_version_info(project_root, gate=gate, source_identity=source_identity)
    root = Path(project_root)
    try:
        receipt = latest_receipt(project_root, gate)
    except ReceiptDiscoveryError as exc:
        return {
            "status": STATUS_INVALID,
            "gate": gate,
            "reason": f"canonical receipt discovery failed closed: {exc}",
            "validator": info.as_dict(),
        }
    if receipt is None:
        return {
            "status": STATUS_NOT_RUN,
            "gate": gate,
            "reason": "no canonical validator receipt on record -- conformance is "
            "UNKNOWN, never assumed PASS",
            "validator": info.as_dict(),
        }
    # Validate the complete shape before comparing any typed/versioned field.
    # A hostile schema_version must classify INVALID, never raise TypeError or
    # masquerade as an ordinary validator-version mismatch.
    strict_err = _strict_validate_receipt(receipt, gate, root)
    if strict_err:
        return {
            "status": STATUS_INVALID,
            "gate": gate,
            "reason": f"receipt is invalid: {strict_err}",
            "receipt": receipt,
            "validator": info.as_dict(),
        }
    if receipt.get("validator_protocol_version") != CONFORMANCE_PROTOCOL_VERSION:
        return {
            "status": STATUS_VERSION_MISMATCH,
            "gate": gate,
            "reason": "conformance receipt was written by a different validator "
            f"protocol version ({receipt.get('validator_protocol_version')} != "
            f"{CONFORMANCE_PROTOCOL_VERSION})",
            "receipt": receipt,
            "validator": info.as_dict(),
        }
    if _future_beyond_skew(receipt.get("timestamp_utc", ""), ref):
        return {
            "status": STATUS_STALE_FAIL,
            "gate": gate,
            "reason": "conformance receipt timestamp is in the future beyond "
            "allowed skew (fabricated)",
            "receipt": receipt,
            "validator": info.as_dict(),
        }
    current_head = info.source_head
    current_fp = info.source_tree_fingerprint
    # CORE-002: empty current source identity is unavailable evidence, never a
    # matching identity. Empty==empty must NOT bind as current -- the receipt
    # cannot be proven bound to THIS project/tree when neither side has a value.
    if not current_head or not current_fp:
        return {
            "status": STATUS_STALE_FAIL,
            "gate": gate,
            "reason": (
                "current source identity is unavailable (empty source_head/"
                "source_tree_fingerprint) -- the receipt cannot be proven bound "
                "to the current tree"
            ),
            "receipt": receipt,
            "validator": info.as_dict(),
        }
    bound = (
        receipt.get("source_head") == current_head
        and receipt.get("source_tree_fingerprint") == current_fp
    )
    is_pass = receipt.get("verdict") == "PASS"
    age_seconds = 0
    try:
        rdt = datetime.datetime.fromisoformat(receipt["timestamp_utc"].replace("Z", "+00:00"))
        age_seconds = (ref - rdt).total_seconds()
    except Exception:
        pass
    if not bound:
        status = STATUS_STALE_PASS if is_pass else STATUS_STALE_FAIL
        reason = (
            "conformance receipt is bound to a different source identity "
            "than the current checkpoint"
        )
    elif age_seconds > FRESHNESS_WINDOW_SECONDS:
        status = STATUS_STALE_PASS if is_pass else STATUS_STALE_FAIL
        reason = (
            f"conformance receipt is {int(age_seconds // 3600)}h old (older than "
            f"the {int(FRESHNESS_WINDOW_SECONDS // 3600)}h freshness window)"
        )
    else:
        # CORE-001: for a CURRENT receipt that appears to PASS, also verify
        # that the checkpoint hashes (STATE/BOARD/LOG) in the receipt match
        # the current files. This catches the case where a receipt was minted
        # for one checkpoint but the files have since been mutated.
        if is_pass:
            cp_err = _checkpoint_hash_mismatch(receipt, root)
            if cp_err:
                status = STATUS_STALE_PASS
                reason = f"receipt checkpoint hashes invalid: {cp_err}"
            else:
                status = STATUS_CURRENT_PASS
                reason = ""
        else:
            status = STATUS_CURRENT_FAIL
            reason = "canonical validator reports FAIL for the current checkpoint"
    return {
        "status": status,
        "gate": gate,
        "reason": reason,
        "receipt": receipt,
        "validator": info.as_dict(),
    }


def current_conformance_pass(
    project_root: Path | str,
    gate: str = "core",
    now: datetime.datetime | None = None,
    # PERF-002: optional pre-computed SourceIdentity to avoid redundant
    # filesystem/Git subprocess calls.
    source_identity=None,
) -> bool:
    """§4/§7: terminal/crew closure is allowed ONLY on a CURRENT_PASS receipt
    bound to the current checkpoint. Everything else forbids closure."""
    return (
        conformance_status(project_root, gate=gate, now=now, source_identity=source_identity).get(
            "status"
        )
        == STATUS_CURRENT_PASS
    )


#: T-1412: the ONE executable remediation the conformance decision names. It is
#: the command that runs the canonical validator and re-reads this decision, so
#: a refusal can never hand the operator a route the remediation path itself
#: refuses to walk.
CONFORMANCE_REMEDIATION_COMMAND = "saipen validate"

#: T-1412: the code a non-green decision carries on the command surfaces. One
#: name for every non-CURRENT_PASS status -- the exact closed status travels in
#: the decision itself -- so consumers never invent per-status strings.
CONFORMANCE_UNHEALTHY = "CONFORMANCE_UNHEALTHY"

#: T-1412: fail-closed code for "the decision could not be established" /
#: "the canonical validator could not execute". Distinct from UNHEALTHY because
#: the instrument, not the project, is the problem -- and both are non-green.
CONFORMANCE_UNAVAILABLE = "CONFORMANCE_UNAVAILABLE"

# SRC-085 M3: the machine-readable reconciliation between "the strict gate is
# red" and "the router advertises continuation". A closed set so a consumer can
# fail closed on an unknown value instead of interpreting it:
#   HEALTHY              -- CURRENT_PASS; no red gate exists.
#   REMEDIATION_REQUIRED -- CURRENT_FAIL measured on the CURRENT checkpoint; the
#                           red gate is actionable and must outrank idle
#                           continuation until the canonical remediation runs.
#   UNPROVEN             -- no receipt / stale / not yet bound: not a red gate,
#                           never assumed green (fresh projects keep working;
#                           closure still refuses, which is the existing rule).
#   INVALID              -- the receipt could not be trusted at all.
CONFORMANCE_DISPOSITION_HEALTHY = "HEALTHY"
CONFORMANCE_DISPOSITION_REMEDIATION_REQUIRED = "REMEDIATION_REQUIRED"
CONFORMANCE_DISPOSITION_UNPROVEN = "UNPROVEN"
CONFORMANCE_DISPOSITION_INVALID = "INVALID"


def conformance_disposition(status: str | None) -> str:
    """Map ONE authoritative conformance status onto the closed disposition.

    This is the single owner for "what does this status MEAN for routing": the
    status string travels beside it, so a consumer never re-derives a meaning
    from prose. Only a CURRENT_FAIL is actionable red; absence of evidence
    (NOT_RUN/stale) stays UNPROVEN and is not a stop -- the closure gates
    already refuse it where closure is what is being asked.
    """
    if status == STATUS_CURRENT_PASS:
        return CONFORMANCE_DISPOSITION_HEALTHY
    if status == STATUS_CURRENT_FAIL:
        return CONFORMANCE_DISPOSITION_REMEDIATION_REQUIRED
    if status in (STATUS_INVALID, STATUS_VERSION_MISMATCH):
        return CONFORMANCE_DISPOSITION_INVALID
    return CONFORMANCE_DISPOSITION_UNPROVEN


def conformance_decision(
    project_root: Path | str,
    gate: str = "core",
    now: datetime.datetime | None = None,
    # PERF-002: optional pre-computed SourceIdentity to avoid redundant
    # filesystem/Git subprocess calls.
    source_identity=None,
) -> dict:
    """T-1412: ONE structured health decision over `conformance_status`.

    Every consumer -- `saipen status` (JSON and human render), `saipen
    validate` and the router's crew gate -- reads THIS projection instead of
    re-deriving "is conformance green" from the status string in its own
    dialect, so the three surfaces cannot drift apart again.

    `healthy` is exactly `status == CURRENT_PASS`. NOT_RUN, every stale status,
    CURRENT_FAIL and the invalid/version-mismatched statuses are all non-green
    for the same reason: none of them proves the CURRENT source conformant. The
    decision carries a registered repair, a refresh, or a terminal diagnosis, and
    `status_block` is the untouched `conformance_status` payload so a caller
    that needs the receipt or validator metadata still gets the full evidence.
    """
    status = conformance_status(project_root, gate=gate, now=now, source_identity=source_identity)
    kind = status.get("status")
    healthy = kind == STATUS_CURRENT_PASS
    # Only current, valid evidence may supply executable repairs. An unchanged
    # CURRENT_FAIL with no registered repair is an engineering boundary, not
    # an instruction to run the same failing validator forever (T-1439).
    receipt = status.get("receipt") or {}
    bounded = (_bounded_remediation_commands(receipt.get("remediation_commands"))
               if kind == STATUS_CURRENT_FAIL else [])
    diagnostic = None
    if healthy:
        primary, repair_status = None, "HEALTHY"
    elif kind != STATUS_CURRENT_FAIL:
        primary, repair_status = CONFORMANCE_REMEDIATION_COMMAND, "REFRESH_REQUIRED"
    elif bounded:
        primary, repair_status = bounded[0], "REPAIR_AVAILABLE"
    else:
        primary, repair_status = None, "ENGINEERING_REQUIRED"
        blocking = receipt.get("blocking_findings") or {}
        diagnostic = {
            "kind": "ENGINEERING_REQUIRED",
            "owner": "SAIPEN conformance/remediation",
            "receipt_id": receipt.get("receipt_id"),
            "findings_status": blocking.get("status", "unavailable"),
            "detail": (
                "CURRENT_FAIL has no registered executable repair. Diagnose the "
                "receipt-bound blocking findings under their owning Work and implement "
                "or register the required repair; validate again after the input, "
                "state or runtime changes. Missing findings require diagnostic repair."
            ),
        }
    return {
        "status": kind,
        "gate": status.get("gate", gate),
        "healthy": healthy,
        # SRC-085 M3: the routing meaning of this status, machine-readable, so
        # "CURRENT_FAIL" next to "CONTINUE" is explained by a value rather than
        # by historical LOG prose.
        "disposition": conformance_disposition(kind),
        "reason": status.get("reason", "") or "",
        "remediation_command": primary,
        "remediation_commands": bounded,
        "repair_status": repair_status,
        "diagnostic": diagnostic,
        "status_block": status,
    }


# --------------------------------------------------------------------------- §3
def convergence_stage_satisfied(
    project_root: Path | str, stage: str, source_identity, now: datetime.datetime | None = None
) -> tuple[bool, str]:
    """§3: a convergence stage E/H (verdict PASS) must be backed by a REAL,
    CURRENT conformance receipt for gate `core`, bound to the SAME source
    identity the stage binds. Without it the stage is not satisfied and the
    convergence planner must refuse with CONVERGENCE_GATE_UNSATISFIED."""
    if stage not in ("E", "H"):
        return True, ""
    # The current-source identity used for the CURRENT_PASS comparison is the
    # project's REAL live identity, never the stage's own expected Src stand-in.
    # Passing the stage's Src here would compare the receipt against an
    # arbitrary OTHER value and misclassify a genuinely bound receipt as stale
    # (E4 regression). The stage's own binding is checked separately below.
    status = conformance_status(project_root, gate="core", now=now)
    if status["status"] != STATUS_CURRENT_PASS:
        return False, (
            f"convergence stage {stage} requires a CURRENT_PASS canonical "
            f"conformance receipt bound to the current source identity, got "
            f"{status['status']}: {status.get('reason', '')}"
        )
    rec = status.get("receipt", {})
    want = (
        getattr(source_identity, "source_head", None),
        getattr(source_identity, "source_tree_fingerprint", None),
    )
    got = (rec.get("source_head"), rec.get("source_tree_fingerprint"))
    if got != want:
        return False, (
            f"convergence stage {stage} binds a source identity that does not "
            f"match the current conformance receipt -- a PASS from a different "
            f"tree cannot certify this one"
        )
    return True, ""


# --------------------------------------------------------------------------- §5
def clean_exit_allowed(
    project_root: Path | str, now: datetime.datetime | None = None, source_identity=None
) -> tuple[bool, str]:
    """§5: after CLEAN mutations, the canonical Core validator must PASS for the
    CURRENT checkpoint. If it FAILs, CLEAN MUST NOT claim closure. Missing
    verify evidence is NOT invented -- absence of a PASS receipt forbids."""
    status = conformance_status(project_root, gate="core", now=now, source_identity=source_identity)
    if status["status"] != STATUS_CURRENT_PASS:
        return False, (
            f"CLEAN exit requires a CURRENT_PASS canonical conformance receipt "
            f"for the current checkpoint, got {status['status']}: "
            f"{status.get('reason', '')}"
        )
    return True, ""


# --------------------------------------------------------------------------- §6
def continue_entry_health(
    project_root: Path | str, state: dict | None = None, board: dict | None = None, now=None
) -> list[str]:
    """§6: additive continue-entry health gate. Hard closure refusals live in
    the actual closers (operations/crew/release); this surfaces the conformance
    requirement plus the cheap structural checks route_next already enforces, so
    a viewer can show WHY an entry is unhealthy without trusting prose.

    Returns a list of problem strings (empty == healthy)."""
    root = Path(project_root)
    problems: list[str] = []
    if state is None:
        try:
            from .state import parse_state_or_error

            st = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8-sig", errors="ignore")
            state, _ = parse_state_or_error(st)
        except Exception:
            state = {}
        if not isinstance(state, dict):
            state = {}
    if board is None:
        try:
            from .board import parse_board

            bt = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig", errors="ignore")
            board = parse_board(bt)
        except Exception:
            board = {"tickets": {}, "errors": []}
    # PERF-002: capture the source identity ONCE and reuse it for both gate
    # checks instead of recomputing it inside each current_conformance_pass
    # (two git-delta captures -> one).
    try:
        source_id = _source_identity(root)
    except Exception:
        source_id = None
    # DONE without any convergence/verify evidence is not closure.
    if state.get("phase") == "DONE" and not current_conformance_pass(
        root, "core", now=now, source_identity=source_id
    ):
        problems.append(
            "phase DONE without a CURRENT_PASS canonical conformance receipt -- "
            "DONE is not convergence proof"
        )
    # converge/crew intent without current conformance is not finalizable.
    if state.get("execution_intent") == "converge" and state.get("converge_target") == "crew":
        if not current_conformance_pass(root, "crew", now=now, source_identity=source_id):
            problems.append(
                "converge/crew intent present but canonical crew conformance is "
                "not CURRENT_PASS -- crew closure is impossible"
            )
    # DONE tickets without verify evidence (mirrors status' claimed_but_unproven).
    done = [t for t in board.get("tickets", {}).values() if t.get("section") == "## DONE"]
    for t in done:
        verify = (t.get("fields", {}) or {}).get("verify", "")
        if not verify:
            problems.append(f"DONE ticket {t.get('id')} has no verify evidence")
    # BLOCKED without a blocker.
    blocked = [t for t in board.get("tickets", {}).values() if t.get("section") == "## BLOCKED"]
    for t in blocked:
        blocker = (t.get("fields", {}) or {}).get("blocker", "")
        if not blocker:
            problems.append(f"BLOCKED ticket {t.get('id')} has no blocker")
    # multiple DOING.
    doing = [t for t in board.get("tickets", {}).values() if t.get("section") == "## DOING"]
    if len(doing) > 1:
        problems.append(f"multiple DOING tickets: {', '.join(t.get('id') for t in doing)}")
    return problems
