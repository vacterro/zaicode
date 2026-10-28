"""Bounded segmented projection over the settled receipt namespace.

SRC-025:R010 / PERF-001. The settled projection that predates this module is
O(lifetime) on every read: the monolithic index authenticates every historical
receipt (stat inventory plus manifest/progress re-hash) and
``semantic_receipt_snapshot`` materializes the complete record set before any
operation filter runs. This module replaces the hot read path with a bounded
structure over the EXISTING immutable settled directories:

    immutable sealed segments (fixed SEG_BOUND members)
  + one bounded active tail
  + operation-keyed locators
  + one compact authenticated head

The settled ``operation.json``/``progress.json`` bytes remain the ONLY
evidence authority. Projection files are accelerators: a crash may leave the
authoritative receipt with a stale/missing projection, never the reverse, and
every hot read re-verifies the exact bytes of every receipt it returns. A
zero-match query opens no lifetime receipt at all.

Hot-path cost contract (proven by tests with instrumentation, not timing):
reads scale with the locator + the relevant segment(s) + the active tail +
ONE directory stat for staleness detection -- never with the decoded receipt
population and never with a lifetime namespace enumeration. The namespace
freshness token (``settled_dir_mtime_ns``) is captured before the settlement
move and republished with every head, so a crash between the receipt move and
the projection advance is detected by a single stat instead of an O(N) scan.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

#: Fixed documented bound. Tests use it explicitly; it is never tuned from
#: timing.
SEG_BOUND = 128

#: v3 adds the ``settled_dir_mtime_ns`` namespace freshness token to the head.
#: A v2 head (pre-token generation) is not corruption: it is an older
#: projection protocol, treated exactly like an ABSENT projection (read-only
#: fallback, next settlement rebuilds).
SCHEMA_VERSION = 3

INDEX_DIR_REL = ".saipen/recovery/settled-index"
HEAD_REL = f"{INDEX_DIR_REL}/head.json"
ACTIVE_ID = "active"

#: Names inside recovery/settled that are engine bookkeeping, never receipts.
_SETTLED_SKIP_NAMES = {".cleanup-needed", ".receipt-index.json"}

_ROOT_DOMAIN = b"saipen-settled-projection-v2\0"
_SEGMENT_DOMAIN = b"saipen-settled-segment-v2\0"
_LOCATOR_DOMAIN = b"saipen-settled-locator-v2\0"


def _canonical(payload) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _content_root(domain: bytes, payload) -> str:
    return hashlib.sha256(domain + _canonical(payload)).hexdigest()


def _locator_key(operation: str) -> str:
    """Safe cryptographic filename for one operation's locator.

    Raw operation names are never path components; the hex digest prefix is
    the only path token and the file carries the exact operation for
    verification.
    """
    return hashlib.sha256(operation.encode("utf-8")).hexdigest()[:16]


def _index_path(root: Path, rel: str) -> Path:
    from .journal import owned_target_path

    return owned_target_path(root, rel, kind="settled projection")


def _read_authenticated(path: Path, payload_keys: tuple[str, ...], domain: bytes):
    """Read one root-authenticated projection document, or return None.

    Malformed, unparseable, or root-mismatched bytes are NOT positive
    evidence. Returns (payload, root) on success or None.
    """
    from .paths import prove_owned_regular

    try:
        prove_owned_regular(path, kind="settled projection")
        document = json.loads(path.read_bytes().decode("utf-8-sig"))
    except (FileNotFoundError, OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(document, dict):
        return None
    root_value = document.get("root")
    if not isinstance(root_value, str):
        return None
    payload = {key: document.get(key) for key in payload_keys}
    if _content_root(domain, payload) != root_value:
        return None
    return payload, root_value


def _member_from_record(name: str, record: dict, manifest_raw: bytes, progress_raw) -> dict:
    return {
        "name": name,
        "operation": record.get("operation"),
        "status": record.get("status"),
        "created_at": record.get("created_at"),
        "manifest_sha256": hashlib.sha256(manifest_raw).hexdigest(),
        "progress_sha256": (
            hashlib.sha256(progress_raw).hexdigest() if progress_raw is not None else None
        ),
    }


def _settled_names(root: Path) -> list[str] | None:
    """Names-only enumeration of the settled namespace (no stat, no reads).

    O(N) by construction, so it belongs ONLY to the deep paths (rebuild,
    deep validation). The hot lookup and the bounded advance use the
    namespace freshness token instead. None means the namespace could not be
    listed.
    """
    settled = root / ".saipen/recovery/settled"
    try:
        return sorted(
            entry.name for entry in settled.iterdir() if entry.name not in _SETTLED_SKIP_NAMES
        )
    except FileNotFoundError:
        return []
    except OSError:
        return None


def _settled_dir_token(root: Path) -> int | None:
    """The namespace freshness token: ONE directory stat, never a listing.

    Any settled-namespace mutation (receipt move in/out, marker create) bumps
    the directory mtime, so a head token captured before the move disagrees
    with the post-move namespace exactly when a crash or out-of-band writer
    intervened. None means the namespace is unreadable (never a clean bill).
    """
    try:
        return (root / ".saipen/recovery/settled").stat().st_mtime_ns
    except FileNotFoundError:
        return 0
    except OSError:
        return None


def _head_is_legacy_v2(root: Path) -> bool:
    """True when head.json is a pre-token v2 projection (not corruption).

    A v2 head cannot carry the freshness token, so it can never be trusted
    on the bounded path -- but it is an honestly published older protocol
    generation, not tampered bytes. The read-only caller falls back to the
    canonical whole-history scan exactly as it does for an ABSENT
    projection, and the next settlement rebuilds to v3. Anything else that
    fails verification stays UNTRUSTED (fail closed).
    """
    try:
        document = json.loads(_index_path(root, HEAD_REL).read_bytes().decode("utf-8-sig"))
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(document, dict) and document.get("schema_version") == 2


def _segment_ids(sealed_count: int) -> list[str]:
    return [f"seg-{index:04d}" for index in range(sealed_count)]


def _read_segment(root: Path, segment_id: str):
    """Read one segment document (sealed or active), root-verified.

    Returns (segment_id, members, root) or None.
    """
    rel = f"{INDEX_DIR_REL}/{segment_id}.json"
    result = _read_authenticated(
        _index_path(root, rel),
        ("schema_version", "segment_id", "members"),
        _SEGMENT_DOMAIN,
    )
    if result is None:
        return None
    payload, root_value = result
    if payload.get("schema_version") != SCHEMA_VERSION or payload.get("segment_id") != segment_id:
        return None
    members = payload.get("members")
    if not isinstance(members, list) or len(members) > SEG_BOUND:
        return None
    if any(not isinstance(member, dict) for member in members):
        return None
    return segment_id, members, root_value


def _read_head(root: Path):
    """Read the compact authenticated head, or None (absent OR untrusted)."""
    result = _read_authenticated(
        _index_path(root, HEAD_REL),
        (
            "schema_version",
            "lineage",
            "seg_bound",
            "sealed_count",
            "settled_count",
            "settled_dir_mtime_ns",
            "active_root",
            "latest_sealed_id",
            "latest_sealed_root",
            "prev_root",
        ),
        _ROOT_DOMAIN,
    )
    if result is None:
        return None
    payload, head_root = result
    if payload.get("schema_version") != SCHEMA_VERSION or payload.get("seg_bound") != SEG_BOUND:
        return None
    if not isinstance(payload.get("sealed_count"), int) or not isinstance(
        payload.get("settled_count"), int
    ):
        return None
    token = payload.get("settled_dir_mtime_ns")
    if not isinstance(token, int) or isinstance(token, bool):
        return None
    return payload, head_root


def _write_segment(root: Path, segment_id: str, members: list[dict]) -> str:
    from .paths import safe_atomic_write_bytes

    payload = {"schema_version": SCHEMA_VERSION, "segment_id": segment_id, "members": members}
    segment_root = _content_root(_SEGMENT_DOMAIN, payload)
    document = dict(payload)
    document["root"] = segment_root
    safe_atomic_write_bytes(
        _index_path(root, f"{INDEX_DIR_REL}/{segment_id}.json"),
        _canonical(document) + b"\n",
        kind="settled projection segment",
        ownership_root=root,
    )
    return segment_root


def _write_head(
    root: Path,
    *,
    lineage: str,
    sealed_count: int,
    settled_count: int,
    settled_dir_mtime_ns: int,
    active_root: str | None,
    latest_sealed_id: str | None,
    latest_sealed_root: str | None,
    prev_root: str | None,
) -> str:
    from .paths import safe_atomic_write_bytes

    payload = {
        "schema_version": SCHEMA_VERSION,
        "lineage": lineage,
        "seg_bound": SEG_BOUND,
        "sealed_count": sealed_count,
        "settled_count": settled_count,
        "settled_dir_mtime_ns": settled_dir_mtime_ns,
        "active_root": active_root,
        "latest_sealed_id": latest_sealed_id,
        "latest_sealed_root": latest_sealed_root,
        "prev_root": prev_root,
    }
    head_root = _content_root(_ROOT_DOMAIN, payload)
    document = dict(payload)
    document["root"] = head_root
    safe_atomic_write_bytes(
        _index_path(root, HEAD_REL),
        _canonical(document) + b"\n",
        kind="settled projection head",
        ownership_root=root,
    )
    return head_root


def _write_locator(root: Path, operation: str, entries: list[dict]) -> None:
    from .paths import safe_atomic_write_bytes

    key = _locator_key(operation)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "operation": operation,
        "key": key,
        "entries": entries,
    }
    document = dict(payload)
    document["root"] = _content_root(_LOCATOR_DOMAIN, payload)
    safe_atomic_write_bytes(
        _index_path(root, f"{INDEX_DIR_REL}/loc/{key}.json"),
        _canonical(document) + b"\n",
        kind="settled projection locator",
        ownership_root=root,
    )


def _locator_path(root: Path, operation: str) -> Path:
    return _index_path(root, f"{INDEX_DIR_REL}/loc/{_locator_key(operation)}.json")


def _read_locator(root: Path, operation: str):
    result = _read_authenticated(
        _locator_path(root, operation),
        ("schema_version", "operation", "key", "entries"),
        _LOCATOR_DOMAIN,
    )
    if result is None:
        return None
    payload, _ = result
    if (
        payload.get("schema_version") != SCHEMA_VERSION
        or payload.get("operation") != operation
        or payload.get("key") != _locator_key(operation)
    ):
        return None
    entries = payload.get("entries")
    if not isinstance(entries, list) or any(
        not isinstance(entry, dict)
        or not isinstance(entry.get("loc"), str)
        or not isinstance(entry.get("names"), list)
        for entry in entries
    ):
        return None
    return entries


def rebuild_projection(root: Path) -> dict:
    """The ONE canonical (mutating) rebuild: one deep O(N) scan.

    Every settled receipt is decoded through the strict decoder exactly once
    and folded into sealed segments plus an active tail. Corrupt settled
    evidence is never silently omitted: any structural or decode failure
    refuses publication and leaves the projection ABSENT (or stale), which
    every hot read treats as no-bounded-trust while the strict whole-history
    scan surfaces the corruption. The caller must hold the project writer
    lock (settlement already does).
    """
    root = Path(root)
    from .journal import SETTLED_DIR, _receipt_namespace_entries, decode_operation_record
    from .paths import project_lineage_identity

    lineage = project_lineage_identity(root)
    members: list[dict] = []
    for entry in _receipt_namespace_entries(root / SETTLED_DIR):
        if entry.structural_error is not None or entry.op_dir is None:
            return {
                "ok": False,
                "code": "SETTLED_CORRUPT",
                "detail": f"{entry.name}: {entry.structural_error}",
            }
        decoded = decode_operation_record(
            root,
            entry.op_dir,
            raw=entry.manifest_raw,
            progress_raw=entry.progress_raw,
            progress_captured=True,
        )
        if not decoded["ok"]:
            return {
                "ok": False,
                "code": decoded.get("code", "RECOVERY_CONFLICT"),
                "detail": f"{entry.name}: {decoded.get('detail', 'unparseable receipt')}",
            }
        members.append(
            _member_from_record(
                entry.name, decoded["record"], entry.manifest_raw, entry.progress_raw
            )
        )
    members.sort(key=lambda member: member["name"])

    # Locators from the FINAL membership so a locator never advertises a
    # segment that does not exist yet.
    sealed: list[list[dict]] = [
        members[start : start + SEG_BOUND] for start in range(0, len(members), SEG_BOUND)
    ]
    active_members = sealed.pop() if sealed else []
    # Index by operation over the final loc/tail split.
    locator_entries: dict[str, list[dict]] = {}
    for index, chunk in enumerate(sealed):
        segment_id = f"seg-{index:04d}"
        _collect_locator_entries(locator_entries, segment_id, chunk)
    _collect_locator_entries(locator_entries, ACTIVE_ID, active_members)

    prev_root = None
    head = _read_head(root)
    if head is not None:
        prev_root = head[1]

    latest_sealed_id = None
    latest_sealed_root = None
    for index, chunk in enumerate(sealed):
        segment_id = f"seg-{index:04d}"
        segment_root = _write_segment(root, segment_id, chunk)
        latest_sealed_id, latest_sealed_root = segment_id, segment_root
    active_root = _write_segment(root, ACTIVE_ID, active_members)
    settled_count = len(members)
    # The deep rebuild is the one place the namespace may be enumerated; the
    # head it publishes carries the post-rebuild freshness token so the hot
    # path can detect the next crash-shaped change with a single stat.
    token = _settled_dir_token(root)
    if token is None:
        return {"ok": False, "code": "SETTLED_DIR_UNREADABLE"}
    head_root = _write_head(
        root,
        lineage=lineage,
        sealed_count=len(sealed),
        settled_count=settled_count,
        settled_dir_mtime_ns=token,
        active_root=active_root,
        latest_sealed_id=latest_sealed_id,
        latest_sealed_root=latest_sealed_root,
        prev_root=prev_root,
    )
    for operation, entries in locator_entries.items():
        _write_locator(root, operation, entries)
    return {
        "ok": True,
        "code": "SETTLED_PROJECTION_REBUILT",
        "head_root": head_root,
        "sealed_count": len(sealed),
        "settled_count": settled_count,
    }


def _collect_locator_entries(
    locator_entries: dict[str, list[dict]], segment_id: str, members: list[dict]
) -> None:
    for member in members:
        operation = member.get("operation")
        if not isinstance(operation, str) or not operation:
            continue
        bucket = locator_entries.setdefault(operation, [])
        if bucket and bucket[-1]["loc"] == segment_id:
            bucket[-1]["names"].append(member["name"])
        else:
            bucket.append({"loc": segment_id, "names": [member["name"]]})


def advance_after_settlement(
    root: Path,
    moved_names: list[str] | None = None,
    prior_settled_dir_mtime_ns: int | None = None,
) -> dict:
    """Advance (or rebuild) the projection after one settlement move.

    SRC-025:R010 incremental protocol: the caller KNOWS what moved. It
    captures the settled-directory freshness token BEFORE the move and names
    the exact settled directory entries the settlement created, so the fold
    never rediscovers the delta by comparing the complete namespace:

    * head absent/lineage-mismatched, OR no trustworthy pre-move token
      (``prior_settled_dir_mtime_ns`` is None), OR the token disagrees with
      the head -> the canonical deep rebuild re-establishes authority over
      the post-move namespace (the just-moved receipts included). A direct
      caller without a token and a crash-shaped namespace are both refused
      the bounded fold on purpose; neither may guess.
    * token matches -> ONLY the named moved receipts are read (targeted
      reads; sealed history is never reopened, the namespace is never
      enumerated), folded into the active tail, sealed exactly once at the
      bound, and the affected locators are updated incrementally.

    The caller holds the project writer lock.
    """
    root = Path(root)
    from .journal import decode_operation_record
    from .paths import project_lineage_identity

    lineage = project_lineage_identity(root)
    head = _read_head(root)
    if head is None:
        return rebuild_projection(root)
    payload, _ = head
    if payload.get("lineage") != lineage:
        return rebuild_projection(root)
    if (
        prior_settled_dir_mtime_ns is None
        or not isinstance(prior_settled_dir_mtime_ns, int)
        or isinstance(prior_settled_dir_mtime_ns, bool)
        or prior_settled_dir_mtime_ns != payload.get("settled_dir_mtime_ns")
    ):
        # The head does not represent the pre-move namespace state (a direct
        # caller without a token, or a crash/out-of-band change the head
        # never saw). Refuse the bounded fold; the canonical deep rebuild is
        # the only honest authority here.
        return rebuild_projection(root)
    tail = _read_segment(root, ACTIVE_ID)
    if tail is None:
        return rebuild_projection(root)
    _sid, tail_members, tail_root = tail
    if tail_root != payload.get("active_root"):
        return rebuild_projection(root)

    # Targeted reads of EXACTLY the named moved receipts; a name the tail
    # already carries was folded by an interrupted earlier advance and is
    # never folded twice.
    projected_tail_names = {member.get("name") for member in tail_members}
    new_members: list[dict] = []
    for name in moved_names or []:
        if name in projected_tail_names:
            continue
        op_dir = root / ".saipen/recovery/settled" / name
        try:
            manifest_raw = (op_dir / "operation.json").read_bytes()
        except OSError:
            return rebuild_projection(root)
        progress_path = op_dir / "progress.json"
        progress_raw = None
        if progress_path.is_file():
            try:
                progress_raw = progress_path.read_bytes()
            except OSError:
                return rebuild_projection(root)
        decoded = decode_operation_record(
            root,
            op_dir,
            raw=manifest_raw,
            progress_raw=progress_raw,
            progress_captured=True,
        )
        if not decoded["ok"]:
            return rebuild_projection(root)
        new_members.append(
            _member_from_record(name, decoded["record"], manifest_raw, progress_raw)
        )

    if not new_members:
        # Idempotent no-op: nothing (left) to fold. Republish the head so the
        # derived counts and the freshness token stay current even after an
        # interrupted advance, without ever re-reading sealed history.
        token = _settled_dir_token(root)
        if token is None:
            return rebuild_projection(root)
        sealed_count = payload.get("sealed_count") or 0
        settled_count = sealed_count * SEG_BOUND + len(tail_members)
        head_root = _write_head(
            root,
            lineage=lineage,
            sealed_count=sealed_count,
            settled_count=settled_count,
            settled_dir_mtime_ns=token,
            active_root=tail_root,
            latest_sealed_id=payload.get("latest_sealed_id"),
            latest_sealed_root=payload.get("latest_sealed_root"),
            prev_root=payload.get("prev_root"),
        )
        return {
            "ok": True,
            "code": "SETTLED_PROJECTION_CURRENT",
            "head_root": head_root,
            "settled_count": settled_count,
        }

    sealed_count = payload.get("sealed_count") or 0
    latest_sealed_id = payload.get("latest_sealed_id")
    latest_sealed_root = payload.get("latest_sealed_root")
    if len(tail_members) >= SEG_BOUND:
        # Seal the FULL tail exactly once, then fold the new receipts into a
        # fresh tail so no sealed segment ever exceeds the bound. Only the
        # operations present in the just-sealed tail need their locators
        # relocated -- bounded by SEG_BOUND, never a historical scan.
        segment_id = f"seg-{sealed_count:04d}"
        latest_sealed_id = segment_id
        latest_sealed_root = _write_segment(root, segment_id, tail_members)
        sealed_count += 1
        _relocate_locators_for_seal(root, segment_id, tail_members)
        tail_members = []
    tail_members.extend(new_members)
    tail_members.sort(key=lambda member: member["name"])
    tail_root = _write_segment(root, ACTIVE_ID, tail_members)
    # Sealed segments are always exactly SEG_BOUND members, so the derived
    # count is exact without ever enumerating the namespace.
    settled_count = sealed_count * SEG_BOUND + len(tail_members)
    token = _settled_dir_token(root)
    if token is None:
        return rebuild_projection(root)
    head_root = _write_head(
        root,
        lineage=lineage,
        sealed_count=sealed_count,
        settled_count=settled_count,
        settled_dir_mtime_ns=token,
        active_root=tail_root,
        latest_sealed_id=latest_sealed_id,
        latest_sealed_root=latest_sealed_root,
        prev_root=payload.get("prev_root"),
    )
    folded = [name for name in moved_names or [] if name not in projected_tail_names]
    folded_operations = {
        member["name"]: member.get("operation")
        for member in new_members
        if isinstance(member.get("operation"), str)
    }
    for name in folded:
        operation = folded_operations.get(name)
        if isinstance(operation, str) and operation:
            _merge_locator_active(root, name, operation)
    return {
        "ok": True,
        "code": "SETTLED_PROJECTION_ADVANCED",
        "head_root": head_root,
        "settled_count": settled_count,
    }


def _relocate_locators_for_seal(root: Path, segment_id: str, sealed_members: list[dict]) -> None:
    """Relocate ACTIVE locator references after sealing the tail (bounded).

    The operations requiring relocation are exactly those present in the
    just-sealed tail -- bounded by SEG_BOUND. For each: read ITS existing
    locator, replace the ACTIVE reference with the new sealed-segment
    reference (names preserved), keep earlier sealed references, and write
    back exactly that locator. Historical segments are never scanned: the
    locator authority already holds everything the relocation needs.
    """
    operations: list[str] = []
    seen: set[str] = set()
    for member in sealed_members:
        operation = member.get("operation")
        if isinstance(operation, str) and operation and operation not in seen:
            seen.add(operation)
            operations.append(operation)
    for operation in operations:
        entries = _read_locator(root, operation)
        if entries is None:
            # ABSENT (nothing to relocate) or CORRUPT (never rewritten from
            # a scan; the hot lookup fails closed and the deep rebuild
            # re-establishes it).
            continue
        changed = False
        for entry in entries:
            if entry.get("loc") == ACTIVE_ID:
                entry["loc"] = segment_id
                changed = True
        if changed:
            _write_locator(root, operation, entries)


def _merge_locator_active(root: Path, moved_name: str, operation: str) -> None:
    """Fold one newly settled receipt into its operation's locator.

    The operation identity comes from the receipt the fold already decoded;
    the existing locator for that operation is read (exact binding verified
    by _read_locator), the new active-tail location is appended/merged, and
    exactly that locator is written back. A corrupt locator is never patched
    from a namespace scan; the hot lookup already refuses it and the deep
    rebuild re-establishes it.
    """
    entries = _read_locator(root, operation)
    if entries is None:
        if _locator_path(root, operation).exists():
            return
        entries = []
    for entry in reversed(entries):
        if entry.get("loc") == ACTIVE_ID:
            names = entry.get("names")
            if isinstance(names, list):
                entry["names"] = sorted({str(name) for name in names} | {moved_name})
                _write_locator(root, operation, entries)
                return
    entries.append({"loc": ACTIVE_ID, "names": [moved_name]})
    _write_locator(root, operation, entries)


def validate_projection_deep(root: Path) -> tuple[bool, list[str]]:
    """The explicit forensic validation: every settled receipt, every segment.

    The hot lookup deliberately does NOT run this: it opens only the
    relevant segment(s) plus the active tail. This path is what proves the
    WHOLE projection still binds the WHOLE namespace -- segment roots, head
    root, membership completeness, and the exact bytes of every historical
    receipt. A tampered unrelated sealed receipt is exactly its subject.
    """
    root = Path(root)
    from .journal import SETTLED_DIR, _receipt_namespace_entries, decode_operation_record
    from .paths import project_lineage_identity

    errors: list[str] = []
    head = _read_head(root)
    if head is None:
        return False, [f"{HEAD_REL}: absent or untrusted projection head"]
    payload, _ = head
    lineage = project_lineage_identity(root)
    if payload.get("lineage") != lineage:
        errors.append(f"{HEAD_REL}: lineage mismatch")
    names = _settled_names(root)
    if names is None:
        return False, ["settled namespace unreadable"]
    seen: dict[str, dict] = {}
    segment_count = payload.get("sealed_count") or 0
    for index in range(segment_count):
        segment = _read_segment(root, f"seg-{index:04d}")
        if segment is None:
            errors.append(f"seg-{index:04d}.json: untrusted segment")
            continue
        for member in segment[1]:
            name = member.get("name")
            if name in seen:
                errors.append(f"{name}: duplicate membership across segments")
            seen[name] = member
    tail = _read_segment(root, ACTIVE_ID)
    if tail is None:
        errors.append(f"{ACTIVE_ID}.json: untrusted active tail")
    else:
        for member in tail[1]:
            name = member.get("name")
            if name in seen:
                errors.append(f"{name}: duplicate membership between tail and segments")
            seen[name] = member
    if sorted(seen) != names:
        missing = sorted(set(names) - set(seen))
        extra = sorted(set(seen) - set(names))
        errors.append(
            f"projection membership diverges from the settled namespace "
            f"(missing {missing[:3]}, extra {extra[:3]})"
        )
    for entry in _receipt_namespace_entries(root / SETTLED_DIR):
        if entry.structural_error is not None or entry.op_dir is None:
            errors.append(f"{entry.name}: CORRUPT_JOURNAL: {entry.structural_error}")
            continue
        decoded = decode_operation_record(
            root,
            entry.op_dir,
            raw=entry.manifest_raw,
            progress_raw=entry.progress_raw,
            progress_captured=True,
        )
        if not decoded["ok"]:
            errors.append(
                f"{entry.name}: {decoded.get('code', 'RECOVERY_CONFLICT')}: "
                f"{decoded.get('detail', 'unparseable receipt')}"
            )
            continue
        member = seen.get(entry.name)
        if member is None:
            continue  # membership divergence already reported
        if hashlib.sha256(entry.manifest_raw).hexdigest() != member.get("manifest_sha256"):
            errors.append(f"{entry.name}: receipt content digest disagrees with the projection")
        progress_digest = (
            hashlib.sha256(entry.progress_raw).hexdigest()
            if entry.progress_raw is not None
            else None
        )
        if progress_digest != member.get("progress_sha256"):
            errors.append(f"{entry.name}: progress digest disagrees with the projection")
    return not errors, errors


def operation_receipts_bounded(root: Path, operation: str):
    """The bounded hot path behind semantic_receipts_for_operation_safe.

    Returns (records, errors, projection_used):

    * projection ABSENT -> ([], (), False): the caller falls back to the
      canonical whole-history scan (read-only, never mutates).
    * projection present but UNTRUSTED (corrupt head/segment/locator, digest
      mismatch on a relevant receipt, staleness against the namespace) ->
      ([], errors, True): fail closed. Corruption never becomes negative
      evidence, and the caller never silently scans around it.
    * projection trusted -> (records, (), True): only the locator, the
      relevant segment(s), the active tail, and the matched receipts' exact
      bytes were read.
    """
    root = Path(root)
    from .journal import (
        OPS_DIR,
        SETTLED_DIR,
        _receipt_namespace_entries,
        decode_operation_record,
    )
    from .paths import project_lineage_identity

    # ABSENT versus UNTRUSTED are different answers. A missing head means the
    # projection was never established: the caller falls back to the
    # canonical whole-history scan. Bytes that exist but fail verification
    # are corrupt authority: fail closed, never scan around them.
    head_path = _index_path(root, HEAD_REL)
    head = _read_head(root)
    if head is None:
        if head_path.exists():
            if _head_is_legacy_v2(root):
                # An honestly published pre-token v2 projection can never
                # carry the freshness authority: treat it exactly like an
                # ABSENT projection (read-only fallback; the next settlement
                # rebuilds). Tampered bytes do not gain anything here -- the
                # fallback is the strict whole-history scan itself.
                return [], (), False
            return [], (f"{HEAD_REL}: untrusted projection head; refusing bounded trust",), True
        return [], (), False
    payload, _ = head
    lineage = project_lineage_identity(root)
    if payload.get("lineage") != lineage:
        return [], (f"{HEAD_REL}: projection lineage mismatch; refusing bounded trust",), True

    # Staleness: ONE directory stat compares the namespace freshness token.
    # A crash between the receipt move and the advance leaves a directory
    # the head never saw -- detected without listing a single entry and
    # without opening a single receipt.
    token = _settled_dir_token(root)
    if token is None:
        return [], ("settled namespace unreadable; refusing bounded trust",), True
    if token != payload.get("settled_dir_mtime_ns"):
        return [], (
            f"{HEAD_REL}: projection stale (settled namespace token mismatch); "
            f"canonical settlement rebuilds it",
        ), True

    records: list[dict] = []
    errors: list[str] = []

    # Active tail: every settlement's most recent members.
    tail = _read_segment(root, ACTIVE_ID)
    if tail is None:
        return [], (f"{ACTIVE_ID}.json: untrusted active tail",), True
    tail_members, tail_root = tail[1], tail[2]
    if tail_root != payload.get("active_root"):
        return [], (f"{ACTIVE_ID}.json: tail root disagrees with head",), True

    locator = _read_locator(root, operation)
    if locator is None:
        # ABSENT locator: this operation never settled (zero matches below).
        # CORRUPT locator: bytes exist but fail verification -- fail closed
        # instead of inventing a zero-match answer.
        if _locator_path(root, operation).exists():
            return [], (
                f"loc/{_locator_key(operation)}.json: untrusted locator for {operation!r}",
            ), True
        locator = []

    referenced = {entry["loc"]: set(entry["names"]) for entry in locator}
    if ACTIVE_ID in referenced:
        tail_hits = [m for m in tail_members if m.get("operation") == operation]
        tail_names = {m.get("name") for m in tail_hits}
        if not referenced[ACTIVE_ID].issubset(tail_names):
            return [], (
                f"{ACTIVE_ID}.json: locator advertises names the tail does not carry",
            ), True
        records.extend(_load_members(root, SETTLED_DIR, tail_hits, errors, decode_operation_record))
        referenced.pop(ACTIVE_ID)

    for segment_id, wanted in referenced.items():
        segment = _read_segment(root, segment_id)
        if segment is None:
            return [], (f"{segment_id}.json: untrusted segment",), True
        _sid, members, segment_root = segment
        if payload.get("latest_sealed_id") == segment_id:
            if segment_root != payload.get("latest_sealed_root"):
                return [], (f"{segment_id}.json: root disagrees with head",), True
        hits = [m for m in members if m.get("operation") == operation]
        hit_names = {m.get("name") for m in hits}
        if not wanted.issubset(hit_names):
            return [], (
                f"{segment_id}.json: locator advertises names the segment does not carry",
            ), True
        records.extend(_load_members(root, SETTLED_DIR, hits, errors, decode_operation_record))
        if errors:
            return [], errors, True

    # Unresolved (ops) namespace: bounded active tail, unchanged semantics.
    ops_entries = list(_receipt_namespace_entries(root / OPS_DIR))
    for entry in ops_entries:
        if entry.structural_error is not None or entry.op_dir is None:
            errors.append(
                f"{entry.name}: CORRUPT_JOURNAL: "
                f"{entry.structural_error or 'invalid receipt structure'}"
            )
            continue
        decoded = decode_operation_record(
            root,
            entry.op_dir,
            raw=entry.manifest_raw,
            progress_raw=entry.progress_raw,
            progress_captured=True,
        )
        if not decoded["ok"]:
            errors.append(
                f"{entry.name}: {decoded.get('code', 'RECOVERY_CONFLICT')}: "
                f"{decoded.get('detail', 'unparseable operation receipt')}"
            )
            continue
        if decoded["record"].get("operation") == operation:
            records.append(decoded["record"])

    if errors:
        return [], errors, True

    from .board import iso_utc_sort_key
    from .journal import SETTLED as _SETTLED_STATUSES, _recovery_identity_binding

    # Live project binding on every returned record (the same gate the
    # whole-history snapshot applies): foreign-lineage receipts are excluded
    # as errors, never silently returned.
    kept: list[dict] = []
    for record in records:
        if record.get("project_lineage") is None and record.get("status") in _SETTLED_STATUSES:
            kept.append(record)
            continue
        binding = _recovery_identity_binding(root, record, live_lineage=lineage)
        if binding["ok"]:
            kept.append(record)
        else:
            errors.append(
                f"foreign-lineage/identity receipt excluded: {record.get('op_id', '')}"
            )
    if errors:
        return [], errors, True

    import datetime as _datetime

    _earliest = iso_utc_sort_key("0001-01-01T00:00:00Z") or _datetime.datetime.min.replace(
        tzinfo=_datetime.timezone.utc
    )
    kept.sort(
        key=lambda r: (iso_utc_sort_key(r.get("created_at", "")) or _earliest, r.get("op_id", ""))
    )
    return kept, (), True


def _load_members(root: Path, settled_rel: str, members, errors, decode_operation_record):
    """Open, digest-verify, and strictly decode the matched members only."""
    records = []
    for member in members:
        name = member.get("name")
        op_dir = root / settled_rel / str(name)
        try:
            manifest_raw = (op_dir / "operation.json").read_bytes()
        except OSError as exc:
            errors.append(f"{name}: operation.json unreadable ({type(exc).__name__}): {exc}")
            return records
        digest = hashlib.sha256(manifest_raw).hexdigest()
        if digest != member.get("manifest_sha256"):
            errors.append(
                f"{name}: settled receipt content digest mismatch; refusing bounded trust"
            )
            return records
        progress_raw = None
        progress_path = op_dir / "progress.json"
        if progress_path.is_file():
            try:
                progress_raw = progress_path.read_bytes()
            except OSError as exc:
                errors.append(f"{name}: progress.json unreadable ({type(exc).__name__}): {exc}")
                return records
        progress_digest = (
            hashlib.sha256(progress_raw).hexdigest() if progress_raw is not None else None
        )
        if progress_digest != member.get("progress_sha256"):
            errors.append(
                f"{name}: settled progress content digest mismatch; refusing bounded trust"
            )
            return records
        decoded = decode_operation_record(
            root,
            op_dir,
            raw=manifest_raw,
            progress_raw=progress_raw,
            progress_captured=True,
        )
        if not decoded["ok"]:
            errors.append(
                f"{name}: {decoded.get('code', 'RECOVERY_CONFLICT')}: "
                f"{decoded.get('detail', 'unparseable receipt')}"
            )
            return records
        records.append(decoded["record"])
    return records
