"""Bounded authenticated conformance receipt lineage (SRC-025:R011).

The v1 lineage document grows one member per lifetime receipt, so every
latest-receipt lookup re-hashed the whole population and every append rebuilt
the full membership. This module replaces the hot path with:

    bounded immutable sealed generations (fixed GEN_BOUND members)
  + one bounded active append generation
  + one compact authenticated lineage head
  + exact per-gate latest locators

The receipt JSON files remain the ONLY evidence authority: nothing here
rewrites historical receipt bytes, and every lookup re-verifies the exact
bytes of the receipt it returns against its generation member digest. The
receipt-directory mtime stays the cheap staleness hint (one stat), exactly as
the v1 locator used it, so an out-of-band sibling can never be laundered into
"latest" and a crash can never half-advertise a locator: generation authority
is published before the locator advertises it, and a lookup that cannot
authenticate the locator through its generation degrades to the canonical
strict scan without mutating anything.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

GEN_BOUND = 128

SCHEMA_VERSION = 2

#: Same sidecar namespace the v1 locator index already owns.
INDEX_DIR_REL = ".saipen/recovery/conformance/index"
HEAD_REL = f"{INDEX_DIR_REL}/lineage-head.json"
ACTIVE_ID = "active-gen"

_HEAD_DOMAIN = b"saipen-conformance-lineage-head-v2\0"
_GENERATION_DOMAIN = b"saipen-conformance-generation-v2\0"
_LOCATOR_DOMAIN = b"saipen-conformance-locator-v2\0"


def _canonical(payload) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _content_root(domain: bytes, payload) -> str:
    return hashlib.sha256(domain + _canonical(payload)).hexdigest()


def _index_path(root: Path, rel: str) -> Path:
    from .journal import owned_target_path

    return owned_target_path(root, rel, kind="conformance lineage")


def _member(receipt_id: str, gate: str, timestamp: str, receipt_path: str, content_sha256: str):
    return {
        "receipt_id": receipt_id,
        "gate": gate,
        "timestamp_utc": timestamp,
        "receipt_path": receipt_path,
        "content_sha256": content_sha256,
    }


def _member_sort_key(member: dict):
    """Validated-completion order: timestamp, then receipt id."""
    from .board import iso_utc_sort_key
    import datetime as _datetime

    _earliest = iso_utc_sort_key("0000-01-01T00:00:00Z") or _datetime.datetime.min.replace(
        tzinfo=_datetime.timezone.utc
    )
    return (
        iso_utc_sort_key(member.get("timestamp_utc", "")) or _earliest,
        member.get("receipt_id", ""),
    )


def _read_generation(root: Path, generation_id: str):
    rel = f"{INDEX_DIR_REL}/{generation_id}.json"
    from .paths import prove_owned_regular

    path = _index_path(root, rel)
    try:
        prove_owned_regular(path, kind="conformance lineage generation")
        document = json.loads(path.read_bytes().decode("utf-8-sig"))
    except (FileNotFoundError, OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(document, dict):
        return None
    root_value = document.get("root")
    payload = {
        "schema_version": document.get("schema_version"),
        "generation_id": document.get("generation_id"),
        "members": document.get("members"),
    }
    if _content_root(_GENERATION_DOMAIN, payload) != root_value:
        return None
    if payload.get("schema_version") != SCHEMA_VERSION:
        return None
    if payload.get("generation_id") != generation_id:
        return None
    members = payload.get("members")
    if not isinstance(members, list) or len(members) > GEN_BOUND:
        return None
    if any(not isinstance(member, dict) for member in members):
        return None
    return members, root_value


def _write_generation(root: Path, generation_id: str, members: list[dict]) -> str:
    from .paths import safe_atomic_write_bytes

    payload = {
        "schema_version": SCHEMA_VERSION,
        "generation_id": generation_id,
        "members": members,
    }
    generation_root = _content_root(_GENERATION_DOMAIN, payload)
    document = dict(payload)
    document["root"] = generation_root
    safe_atomic_write_bytes(
        _index_path(root, f"{INDEX_DIR_REL}/{generation_id}.json"),
        _canonical(document) + b"\n",
        kind="conformance lineage generation",
        ownership_root=root,
    )
    return generation_root


def _read_head(root: Path):
    from .paths import prove_owned_regular

    path = _index_path(root, HEAD_REL)
    try:
        prove_owned_regular(path, kind="conformance lineage head")
        document = json.loads(path.read_bytes().decode("utf-8-sig"))
    except (FileNotFoundError, OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(document, dict):
        return None
    head_root = document.get("root")
    payload = {
        "schema_version": document.get("schema_version"),
        "gen_bound": document.get("gen_bound"),
        "receipt_count": document.get("receipt_count"),
        "sealed_count": document.get("sealed_count"),
        "active_root": document.get("active_root"),
        "latest_sealed_id": document.get("latest_sealed_id"),
        "latest_sealed_root": document.get("latest_sealed_root"),
        "prev_root": document.get("prev_root"),
        "receipt_dir_mtime_ns": document.get("receipt_dir_mtime_ns"),
        "sealed_gate_bindings": document.get("sealed_gate_bindings"),
    }
    if _content_root(_HEAD_DOMAIN, payload) != head_root:
        return None
    if payload.get("schema_version") != SCHEMA_VERSION or payload.get("gen_bound") != GEN_BOUND:
        return None
    if not isinstance(payload.get("receipt_count"), int) or not isinstance(
        payload.get("sealed_count"), int
    ):
        return None
    bindings = payload.get("sealed_gate_bindings")
    if not isinstance(bindings, dict):
        return None
    if any(
        not isinstance(binding, dict)
        or not isinstance(binding.get("generation_id"), str)
        or not isinstance(binding.get("generation_root"), str)
        for binding in bindings.values()
    ):
        return None
    return payload, head_root


def _write_head(
    root: Path,
    *,
    receipt_count: int,
    sealed_count: int,
    active_root: str,
    latest_sealed_id: str | None,
    latest_sealed_root: str | None,
    prev_root: str | None,
    receipt_dir_mtime_ns: int,
    sealed_gate_bindings: dict | None = None,
) -> str:
    from .paths import safe_atomic_write_bytes

    payload = {
        "schema_version": SCHEMA_VERSION,
        "gen_bound": GEN_BOUND,
        "receipt_count": receipt_count,
        "sealed_count": sealed_count,
        "active_root": active_root,
        "latest_sealed_id": latest_sealed_id,
        "latest_sealed_root": latest_sealed_root,
        "prev_root": prev_root,
        "receipt_dir_mtime_ns": receipt_dir_mtime_ns,
        "sealed_gate_bindings": sealed_gate_bindings or {},
    }
    head_root = _content_root(_HEAD_DOMAIN, payload)
    document = dict(payload)
    document["root"] = head_root
    safe_atomic_write_bytes(
        _index_path(root, HEAD_REL),
        _canonical(document) + b"\n",
        kind="conformance lineage head",
        ownership_root=root,
    )
    return head_root


def _locator_payload(
    gate: str,
    receipt_id: str,
    timestamp: str,
    receipt_path: str,
    content_sha256: str,
    generation_id: str,
    generation_root: str,
):
    return {
        "schema_version": SCHEMA_VERSION,
        "gate": gate,
        "receipt_id": receipt_id,
        "timestamp_utc": timestamp,
        "receipt_path": receipt_path,
        "content_sha256": content_sha256,
        "generation_id": generation_id,
        "generation_root": generation_root,
    }


def _write_locator(root: Path, payload: dict) -> None:
    from .paths import safe_atomic_write_bytes

    document = dict(payload)
    document["root"] = _content_root(_LOCATOR_DOMAIN, payload)
    safe_atomic_write_bytes(
        _index_path(root, f"{INDEX_DIR_REL}/{payload['gate']}.json"),
        _canonical(document) + b"\n",
        kind="conformance lineage locator",
        ownership_root=root,
    )


def _read_locator(root: Path, gate: str):
    from .paths import prove_owned_regular

    path = _index_path(root, f"{INDEX_DIR_REL}/{gate}.json")
    try:
        prove_owned_regular(path, kind="conformance lineage locator")
        document = json.loads(path.read_bytes().decode("utf-8-sig"))
    except (FileNotFoundError, OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(document, dict):
        return None
    payload = {
        key: document.get(key)
        for key in (
            "schema_version",
            "gate",
            "receipt_id",
            "timestamp_utc",
            "receipt_path",
            "content_sha256",
            "generation_id",
            "generation_root",
        )
    }
    if _content_root(_LOCATOR_DOMAIN, payload) != document.get("root"):
        return None
    if payload.get("schema_version") != SCHEMA_VERSION or payload.get("gate") != gate:
        return None
    return payload


def _receipt_dir_mtime_ns(root: Path) -> int | None:
    from .conformance import RECEIPT_DIRNAME

    try:
        return (root / RECEIPT_DIRNAME).stat().st_mtime_ns
    except OSError:
        return None


def _iter_receipt_records_with_paths(root: Path):
    """The strict receipt iteration, with each record's ACTUAL file path.

    Mirrors conformance._iter_receipts (symlink/reparse/kind/JSON gates,
    fail-closed discovery errors) and yields (relative_path, record) so
    membership can bind the real filename -- receipt files are named
    `<ts>_<rid>_<gate>_<verdict>.json`, never `<rid>.json`.
    """
    from .conformance import RECEIPT_DIRNAME, ReceiptDiscoveryError
    import os

    out_dir = root / RECEIPT_DIRNAME
    if not out_dir.is_dir():
        return
    for path in sorted(out_dir.glob("*.json")):
        try:
            info = os.lstat(path)
        except OSError as exc:
            raise ReceiptDiscoveryError(f"receipt {path.name} is unreadable: {exc}") from exc
        if (
            os.path.islink(path)
            or getattr(info, "st_file_attributes", 0) & 0x400
            or not path.is_file()
        ):
            raise ReceiptDiscoveryError(f"receipt {path.name} is not an owned regular file")
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ReceiptDiscoveryError(
                f"receipt {path.name} is not readable canonical JSON: {exc}"
            ) from exc
        if not isinstance(record, dict) or record.get("kind") != "conformance_receipt":
            raise ReceiptDiscoveryError(f"receipt {path.name} is not a conformance_receipt object")
        yield f"{RECEIPT_DIRNAME}/{path.name}", record


def _scan_receipt_members(root: Path):
    """One strict deep scan: every receipt decoded once, member metadata built.

    Raises ReceiptDiscoveryError on any unreadable/foreign receipt, exactly
    like the canonical scan, so corrupt evidence can never silently seed the
    projection.
    """
    members = []
    for receipt_path, record in _iter_receipt_records_with_paths(root):
        raw = (root / receipt_path).read_bytes()
        members.append(
            _member(
                record["receipt_id"],
                record.get("gate", ""),
                record.get("timestamp_utc", ""),
                receipt_path,
                hashlib.sha256(raw).hexdigest(),
            )
        )
    members.sort(key=lambda member: member["receipt_path"])
    return members


def rebuild_lineage(root: Path) -> dict:
    """The ONE canonical v1 -> v2 (or corrupt -> fresh) rebuild.

    One deep O(N) scan of the actual receipt bytes; malformed v1 authority is
    never used as migration input. The caller must hold the project writer
    lock (the append path already does). Receipt bytes are read, never
    rewritten.
    """
    root = Path(root)
    members = _scan_receipt_members(root)
    generations = [
        members[start : start + GEN_BOUND] for start in range(0, len(members), GEN_BOUND)
    ]
    active_members = generations.pop() if generations else []
    # A rebuild re-establishes the chain from actual bytes: it never inherits
    # prev_root from the projection it replaces, so rebuilding twice over an
    # unchanged namespace is byte-idempotent.
    prev_root = None
    latest_sealed_id = None
    latest_sealed_root = None
    latest_by_gate: dict[str, dict] = {}
    # SRC-025:R011: the head authenticates the generation each latest
    # locator references. A gate whose latest receipt lives in a sealed
    # generation is bound here, keyed by gate -- bounded by the gate set,
    # never by the lifetime receipt population.
    sealed_gate_bindings: dict[str, dict] = {}
    for index, chunk in enumerate(generations):
        generation_id = f"gen-{index:04d}"
        generation_root = _write_generation(root, generation_id, chunk)
        latest_sealed_id, latest_sealed_root = generation_id, generation_root
        for member in chunk:
            gate = member["gate"]
            current = latest_by_gate.get(gate)
            if current is not None and _member_sort_key(member) <= _member_sort_key(current[0]):
                continue
            latest_by_gate[gate] = (member, generation_id, generation_root)
            sealed_gate_bindings[gate] = {
                "generation_id": generation_id,
                "generation_root": generation_root,
            }
    active_root = _write_generation(root, ACTIVE_ID, active_members)
    for member in active_members:
        gate = member["gate"]
        current = latest_by_gate.get(gate)
        if current is not None and _member_sort_key(member) <= _member_sort_key(current[0]):
            continue
        latest_by_gate[gate] = (member, ACTIVE_ID, active_root)
        sealed_gate_bindings.pop(gate, None)
    mtime = _receipt_dir_mtime_ns(root)
    if mtime is None:
        return {"ok": False, "code": "RECEIPT_DIR_UNREADABLE"}
    head_root = _write_head(
        root,
        receipt_count=len(members),
        sealed_count=len(generations),
        active_root=active_root,
        latest_sealed_id=latest_sealed_id,
        latest_sealed_root=latest_sealed_root,
        prev_root=prev_root,
        receipt_dir_mtime_ns=mtime,
        sealed_gate_bindings=sealed_gate_bindings,
    )
    for gate, (member, generation_id, generation_root) in latest_by_gate.items():
        _write_locator(
            root,
            _locator_payload(
                gate,
                member["receipt_id"],
                member["timestamp_utc"],
                member["receipt_path"],
                member["content_sha256"],
                generation_id,
                generation_root,
            ),
        )
    return {
        "ok": True,
        "code": "CONFORMANCE_LINEAGE_REBUILT",
        "receipt_count": len(members),
        "head_root": head_root,
    }


def advance_append(
    root: Path,
    gate: str,
    receipt_id: str,
    timestamp: str,
    receipt_path: str,
    *,
    prior_receipt_dir_mtime_ns: int | None,
) -> bool:
    """Fold one freshly written receipt into the v2 lineage (mutating).

    SRC-025:R011 freshness authority: the canonical append sequence owns the
    pre-append directory token (captured before the receipt file is
    created). The head republishes the post-append token, so the head
    represents the pre-append namespace exactly when the passed token
    matches it:

    * head absent -> one canonical deep rebuild from actual bytes (the
      freshly written receipt included); True when it publishes.
    * no trustworthy token (``prior_receipt_dir_mtime_ns`` is None) -> refuse:
      a direct caller without freshness authority never drives the bounded
      fold; the strict scan remains the truth and is never penalized.
    * token mismatch -> refuse the bounded fold and take the canonical deep
      rebuild: a crash between a receipt write and the head publish, or an
      out-of-band sibling, means the head no longer represents the namespace
      the caller saw. The deep rebuild re-establishes authority over the
      ACTUAL bytes and is the only honest recovery.
    * token match -> fold exactly the named receipt: no receipt-directory
      enumeration, no sealed-body reads; the active generation (bounded by
      GEN_BOUND) keeps its structural guard, the full tail seals exactly
      once at the bound, and the head republished carries the
      ``sealed_gate_bindings`` updates for the gates whose latest moved from
      the active tail into the new sealed generation.

    False means "refuse": the caller leaves both the old (still truthful)
    locator and the head untouched, and the next canonical strict path
    degrades exactly like the v1 design.

    Crash-safety order: generation bytes first, head second, locator last, so
    a locator is never advertised before the authority that authenticates it.
    """
    root = Path(root)
    if not isinstance(prior_receipt_dir_mtime_ns, int) or isinstance(
        prior_receipt_dir_mtime_ns, bool
    ):
        return False
    current_mtime = _receipt_dir_mtime_ns(root)
    if current_mtime is None:
        return False

    raw = None
    try:
        raw = (root / receipt_path).read_bytes()
    except OSError:
        return False
    content_sha256 = hashlib.sha256(raw).hexdigest()

    head = _read_head(root)
    if head is None:
        # First lineage establishment (or nothing to inherit): one deep
        # rebuild from actual bytes. The freshly written receipt is already
        # in the namespace, so the rebuild folds it; malformed siblings make
        # the scan raise and the append is refused.
        try:
            result = rebuild_lineage(root)
        except (ValueError, OSError):
            return False
        return bool(result.get("ok"))
    payload, _ = head

    if (
        prior_receipt_dir_mtime_ns is None
        or not isinstance(prior_receipt_dir_mtime_ns, int)
        or isinstance(prior_receipt_dir_mtime_ns, bool)
        or prior_receipt_dir_mtime_ns != payload.get("receipt_dir_mtime_ns")
    ):
        # The head does not represent the pre-append namespace the caller
        # saw: a crash left an unposted receipt, or an out-of-band writer
        # touched the directory. REFUSE the bounded advance and mutate
        # nothing -- the out-of-band receipt is never silently advertised as
        # authenticated lineage. Recovery belongs to the explicit canonical
        # deep rebuild, never to a bounded guess.
        return False

    tail = _read_generation(root, ACTIVE_ID)
    if tail is None or tail[1] != payload.get("active_root"):
        try:
            rebuilt = rebuild_lineage(root)
        except (ValueError, OSError):
            return False
        return bool(rebuilt.get("ok"))
    tail_members, _active_root = tail
    new_member = _member(receipt_id, gate, timestamp, receipt_path, content_sha256)
    # Idempotent re-append: the receipt identity is already in the active
    # generation (an interrupted fold that DID publish, or a direct caller
    # re-advancing the same receipt). Never folds twice; a different identity
    # on the same path is a conflict, not a retry.
    for member in tail_members:
        if member.get("receipt_path") != receipt_path:
            continue
        same_identity = (
            member.get("receipt_id") == receipt_id
            and member.get("gate") == gate
            and member.get("timestamp_utc") == timestamp
            and member.get("content_sha256") == content_sha256
        )
        # Same identity -> already folded, idempotent no-op; a different
        # identity on the same path is a conflict, not a retry.
        return same_identity
    sealed_count = payload.get("sealed_count") or 0
    latest_sealed_id = payload.get("latest_sealed_id")
    latest_sealed_root = payload.get("latest_sealed_root")
    bindings = dict(payload.get("sealed_gate_bindings") or {})
    if len(tail_members) >= GEN_BOUND:
        # Seal the full active generation exactly once; the new receipt opens
        # a fresh active generation. Every gate whose latest receipt was in
        # the sealed tail is bounded by GEN_BOUND and gets its
        # current-head binding to the new sealed generation.
        generation_id = f"gen-{sealed_count:04d}"
        generation_root = _write_generation(root, generation_id, tail_members)
        sealed_count += 1
        latest_sealed_id = generation_id
        latest_sealed_root = generation_root
        for member in tail_members:
            member_gate = member.get("gate")
            if isinstance(member_gate, str) and member_gate and member_gate != gate:
                bindings[member_gate] = {
                    "generation_id": generation_id,
                    "generation_root": generation_root,
                }
        bindings.pop(gate, None)
        tail_members = [new_member]
        active_root = _write_generation(root, ACTIVE_ID, tail_members)
    else:
        # Structural guard over the ACTIVE generation only (bounded by
        # GEN_BOUND; sealed history is never reopened here). A structurally
        # invalid sibling in the active generation refuses the advance
        # exactly like the v1 append guard did -- corruption never rides
        # into the locator.
        for member in tail_members:
            try:
                member_raw = (root / str(member.get("receipt_path"))).read_bytes()
                parsed = json.loads(member_raw.decode("utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                return False
            if not isinstance(parsed, dict) or parsed.get("kind") != "conformance_receipt":
                return False
        tail_members = [*tail_members, new_member]
        active_root = _write_generation(root, ACTIVE_ID, tail_members)
        bindings.pop(gate, None)
    mtime = current_mtime
    _write_head(
        root,
        receipt_count=(payload.get("receipt_count") or 0) + 1,
        sealed_count=sealed_count,
        active_root=active_root,
        latest_sealed_id=latest_sealed_id,
        latest_sealed_root=latest_sealed_root,
        prev_root=payload.get("prev_root"),
        receipt_dir_mtime_ns=mtime,
        sealed_gate_bindings=bindings,
    )
    _refresh_gate_locators(root)
    return True


def _refresh_gate_locators(root: Path) -> None:
    """Re-advertise every per-gate latest locator against CURRENT authority.

    The latest receipt of a gate always lives in the active generation or in
    the newest sealed generation, so the refresh reads at most those two
    small documents (gates are a tiny closed set: core/crew). Missing
    locators are created; stale ones are overwritten. Without this, an
    active-generation fold would silently invalidate the previous locator's
    generation root, and a gate's first receipt would never get a locator at
    all.
    """
    head = _read_head(root)
    if head is None:
        return
    payload, _ = head
    candidates = []
    if payload.get("latest_sealed_id"):
        generation = _read_generation(root, str(payload["latest_sealed_id"]))
        if generation is not None:
            candidates.append((str(payload["latest_sealed_id"]), generation[1], generation[0]))
    tail = _read_generation(root, ACTIVE_ID)
    if tail is not None:
        candidates.append((ACTIVE_ID, tail[1], tail[0]))

    from .board import iso_utc_sort_key
    import datetime as _datetime

    _earliest = iso_utc_sort_key("0000-01-01T00:00:00Z") or _datetime.datetime.min.replace(
        tzinfo=_datetime.timezone.utc
    )

    def _sort_key(member):
        return (
            iso_utc_sort_key(member.get("timestamp_utc", "")) or _earliest,
            member.get("receipt_id", ""),
        )

    latest_by_gate: dict[str, tuple[str, str, dict]] = {}
    for generation_id, generation_root, members in candidates:
        for member in members:
            gate = member.get("gate")
            if not isinstance(gate, str) or not gate:
                continue
            current = latest_by_gate.get(gate)
            if current is None or _sort_key(member) > _sort_key(current[2]):
                latest_by_gate[gate] = (generation_id, generation_root, member)
    for gate, (generation_id, generation_root, member) in latest_by_gate.items():
        _write_locator(
            root,
            _locator_payload(
                gate,
                member["receipt_id"],
                member["timestamp_utc"],
                member["receipt_path"],
                member["content_sha256"],
                generation_id,
                generation_root,
            ),
        )


def _verify_receipt_bytes(root: Path, receipt_path: str, expected_sha256: str):
    from .conformance import RECEIPT_DIRNAME
    from .paths import prove_owned_regular

    if not receipt_path.startswith(RECEIPT_DIRNAME + "/"):
        return None
    path = root / receipt_path
    try:
        prove_owned_regular(path, kind="conformance receipt")
        raw = path.read_bytes()
    except (OSError, ValueError):
        return None
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        return None
    try:
        record = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or record.get("kind") != "conformance_receipt":
        return None
    return record


def latest_receipt_bounded(root: Path, gate: str):
    """The bounded authenticated latest lookup.

    Returns (handled, record):

    * handled=False: no v2 lineage exists -- the caller runs the legacy
      fallback path unchanged (read-only, never mutating).
    * handled=True, record set: the locator, its generation and the exact
      receipt bytes all authenticated.
    * handled=True, record None: the locator could not be authenticated
      (staleness hint, missing/corrupt locator or generation, digest or
      identity mismatch) -- the caller degrades to the strict scan and
      reports the true latest; nothing here mutates on a read path.

    Cost: one head read, one generation read, one locator read, one receipt
    read, one directory stat. No lifetime receipt is opened or hashed.
    """
    root = Path(root)
    head = _read_head(root)
    if head is None:
        head_path = _index_path(root, HEAD_REL)
        if head_path.exists():
            # Corrupt v2 authority on a read-only path: refuse bounded trust
            # (the strict fallback decides), never rebuild from a reader.
            return True, None
        return False, None
    payload, _ = head
    mtime = _receipt_dir_mtime_ns(root)
    if mtime is None or mtime != payload.get("receipt_dir_mtime_ns"):
        # Directory changed after the head was published: the locator may
        # lag a newer receipt. Degrade to the strict scan.
        return True, None
    locator = _read_locator(root, gate)
    if locator is None:
        # No authenticated locator for this gate. Absent means "no receipts
        # for this gate" ONLY if no receipt for the gate exists in the
        # generations -- proving that cheaply is not possible, so degrade.
        if _index_path(root, f"{INDEX_DIR_REL}/{gate}.json").exists():
            return True, None
        return False, None
    generation_id = locator.get("generation_id")
    generation = _read_generation(root, str(generation_id))
    if generation is None:
        return True, None
    members, generation_root = generation
    if locator.get("generation_root") != generation_root:
        return True, None
    # SRC-025:R011: a self-consistent generation plus a self-consistent
    # locator is NOT enough. The referenced generation must be authenticated
    # by the CURRENT lineage head: the active generation through the head's
    # active_root, the newest sealed generation through its head root, and
    # every older sealed generation through the head's per-gate binding --
    # never by walking the generations, never by trusting the locator's own
    # assertion.
    if generation_id == ACTIVE_ID:
        if payload.get("active_root") != generation_root:
            return True, None
    elif payload.get("latest_sealed_id") == generation_id:
        if payload.get("latest_sealed_root") != generation_root:
            return True, None
    else:
        binding = (payload.get("sealed_gate_bindings") or {}).get(gate)
        if (
            not isinstance(binding, dict)
            or binding.get("generation_id") != generation_id
            or binding.get("generation_root") != generation_root
        ):
            return True, None
    member = next(
        (
            m
            for m in members
            if m.get("receipt_id") == locator.get("receipt_id")
            and m.get("gate") == gate
            and m.get("timestamp_utc") == locator.get("timestamp_utc")
            and m.get("receipt_path") == locator.get("receipt_path")
        ),
        None,
    )
    if member is None or member.get("content_sha256") != locator.get("content_sha256"):
        return True, None
    record = _verify_receipt_bytes(root, str(locator.get("receipt_path")), member["content_sha256"])
    if record is None:
        return True, None
    if (
        record.get("gate") != gate
        or record.get("receipt_id") != locator.get("receipt_id")
        or record.get("timestamp_utc") != locator.get("timestamp_utc")
    ):
        return True, None
    return True, record


def validate_lineage_deep(root: Path) -> tuple[bool, list[str]]:
    """The explicit forensic path: every receipt, every generation, all locators.

    Normal latest lookup is NOT this. Here every historical receipt byte is
    re-read and re-hashed, generation roots and the head chain are verified,
    membership completeness (no missing, duplicate or foreign receipts) is
    proven, and every per-gate locator is authenticated against its
    generation.
    """
    root = Path(root)
    errors: list[str] = []
    head = _read_head(root)
    if head is None:
        return False, [f"{HEAD_REL}: absent or untrusted lineage head"]
    payload, _ = head
    by_path: dict[str, dict] = {}
    for receipt_path, record in _iter_receipt_records_with_paths(root):
        raw = (root / receipt_path).read_bytes()
        by_path[receipt_path] = {
            "receipt_id": record["receipt_id"],
            "gate": record.get("gate", ""),
            "timestamp_utc": record.get("timestamp_utc", ""),
            "content_sha256": hashlib.sha256(raw).hexdigest(),
        }

    seen: dict[str, dict] = {}
    path_generation: dict[str, str] = {}
    generation_root_by_id: dict[str, str] = {}
    sealed_count = payload.get("sealed_count") or 0
    for index in range(sealed_count):
        generation = _read_generation(root, f"gen-{index:04d}")
        if generation is None:
            errors.append(f"gen-{index:04d}.json: untrusted generation")
            continue
        generation_root_by_id[f"gen-{index:04d}"] = generation[1]
        for member in generation[0]:
            receipt_path = member.get("receipt_path")
            if receipt_path in seen:
                errors.append(f"{receipt_path}: duplicate membership across generations")
            seen[receipt_path] = member
            path_generation[receipt_path] = f"gen-{index:04d}"
    tail = _read_generation(root, ACTIVE_ID)
    if tail is None:
        errors.append(f"{ACTIVE_ID}.json: untrusted active generation")
    else:
        generation_root_by_id[ACTIVE_ID] = tail[1]
        for member in tail[0]:
            receipt_path = member.get("receipt_path")
            if receipt_path in seen:
                errors.append(f"{receipt_path}: duplicate membership in the active generation")
            seen[receipt_path] = member
            path_generation[receipt_path] = ACTIVE_ID
    if sorted(seen) != sorted(by_path):
        missing = sorted(set(by_path) - set(seen))
        extra = sorted(set(seen) - set(by_path))
        errors.append(
            f"lineage membership diverges from the receipt namespace "
            f"(missing {missing[:3]}, extra {extra[:3]})"
        )
    for receipt_path, actual in by_path.items():
        member = seen.get(receipt_path)
        if member is None:
            continue  # divergence already reported
        if (
            member.get("content_sha256") != actual["content_sha256"]
            or member.get("gate") != actual["gate"]
            or member.get("timestamp_utc") != actual["timestamp_utc"]
        ):
            errors.append(f"{receipt_path}: receipt bytes disagree with lineage membership")

    gates = sorted({actual["gate"] for actual in by_path.values()})

    # SRC-025:R011 deep authority: the head's sealed_gate_bindings must be a
    # COMPLETE and CURRENT map for the sealed-generation latests -- every
    # binding authenticates a real sealed generation, no binding names a
    # gate whose latest lives in the active generation, and no binding names
    # a gate the receipt namespace does not carry.
    bindings = payload.get("sealed_gate_bindings") or {}
    for gate, binding in sorted(bindings.items()):
        if not isinstance(binding, dict):
            errors.append(f"{gate}: malformed sealed-generation binding")
            continue
        binding_generation = binding.get("generation_id")
        binding_root = binding.get("generation_root")
        if gate not in gates:
            errors.append(f"{gate}: sealed-generation binding names an unknown gate")
            continue
        if binding_generation == ACTIVE_ID or not (
            isinstance(binding_generation, str) and binding_generation.startswith("gen-")
        ):
            errors.append(f"{gate}: sealed-generation binding does not name a sealed generation")
            continue
        generation = _read_generation(root, str(binding_generation))
        if generation is None or generation[1] != binding_root:
            errors.append(
                f"{gate}: sealed-generation binding does not authenticate a real generation"
            )
    for gate in gates:
        latest_generation = None
        for receipt_path, member in seen.items():
            if member.get("gate") != gate:
                continue
            generation_id = path_generation.get(receipt_path)
            # Latest by the same validated-completion order the locator
            # contract uses.
            if latest_generation is None or _member_sort_key(member) > _member_sort_key(
                latest_generation[1]
            ):
                latest_generation = (generation_id, member)
        if latest_generation is None:
            continue
        latest_gen_id = latest_generation[0]
        if latest_gen_id == ACTIVE_ID:
            if gate in bindings:
                errors.append(
                    f"{gate}: stale sealed-generation binding for a gate whose "
                    f"latest receipt is in the active generation"
                )
        else:
            binding = bindings.get(gate)
            if (
                not isinstance(binding, dict)
                or binding.get("generation_id") != latest_gen_id
                or binding.get("generation_root") != generation_root_by_id.get(latest_gen_id)
            ):
                errors.append(
                    f"{gate}: latest receipt in {latest_gen_id} is not bound by the "
                    f"current lineage head"
                )

    for gate in gates:
        locator = _read_locator(root, gate)
        if locator is None:
            errors.append(f"{gate}.json: untrusted locator")
            continue
        generation = _read_generation(root, str(locator.get("generation_id")))
        if generation is None or locator.get("generation_root") != generation[1]:
            errors.append(f"{gate}.json: locator generation unauthenticated")
            continue
        locator_generation_id = locator.get("generation_id")
        if locator_generation_id == ACTIVE_ID:
            if payload.get("active_root") != generation[1]:
                errors.append(
                    f"{gate}.json: locator active generation is not the head's active generation"
                )
        elif payload.get("latest_sealed_id") == locator_generation_id:
            if payload.get("latest_sealed_root") != generation[1]:
                errors.append(
                    f"{gate}.json: locator newest-sealed generation disagrees with the head"
                )
        else:
            binding = bindings.get(gate)
            if (
                not isinstance(binding, dict)
                or binding.get("generation_id") != locator_generation_id
                or binding.get("generation_root") != generation[1]
            ):
                errors.append(
                    f"{gate}.json: locator generation is not authenticated by the "
                    f"current lineage head"
                )
        member = next(
            (
                m
                for m in generation[0]
                if m.get("receipt_id") == locator.get("receipt_id")
                and m.get("gate") == gate
            ),
            None,
        )
        if member is None or member.get("content_sha256") != locator.get("content_sha256"):
            errors.append(f"{gate}.json: locator does not bind a real generation member")
            continue
        # The advertised latest must BE the latest by validated completion,
        # and it must live in the generation the locator advertises.
        candidates = [
            (receipt_path, m)
            for receipt_path, m in seen.items()
            if m.get("gate") == gate
        ]
        best_path, best = max(
            candidates,
            key=lambda item: _member_sort_key(item[1]),
        )
        if best.get("receipt_id") != locator.get("receipt_id"):
            errors.append(f"{gate}.json: locator is not the true latest receipt")
        elif path_generation.get(best_path) != locator_generation_id:
            errors.append(
                f"{gate}.json: locator does not advertise the generation holding the true latest"
            )
    return not errors, errors
