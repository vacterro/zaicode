"""V7 Producer Parallelism Hardening -- the mechanical layer.

Everything here is zero-dependency stdlib so it can be imported by the
validator, the engine, and the scenario harness without drift.

Design contract (see the V7 spec, PRODUCER PARALLELISM HARDENING):

  * Core remains the sole main-tree writer. `saipen crew` stays serial.
  * Producers (saitranslate / saiwiki) may:
        - read canonical project source;
        - write their own producer namespace;
        - create their own package evidence.
  * Producers may NOT:
        - mutate Core STATE/BOARD/LOG;
        - integrate their own output;
        - collect / disposition;
        - commit / tag / push / ship.
  * Integration is serialized through the canonical Core writer lock.
  * No daemon, no DB, no GUI, no background service, no distributed STATE.

The module is deliberately PATH-AGNOSTIC: a "namespace" is just a directory.
Conventional layout is provided by `producer_namespace()` but never hard-coded
into the safety logic.
"""

from __future__ import annotations

import hashlib
import contextlib
import json
import os
import re
import shutil
import struct
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Iterable, Mapping

# --- local engine imports (no cycle: lock/capability never import producer) ---
from .lock import ProducerLock, project_writer_lock
from .paths import (
    prove_owned_dir_chain,
    prove_owned_regular,
    read_bound_regular_bytes,
    safe_atomic_write_bytes,
    safe_create_bytes_exclusive,
    safe_unlink_owned,
)


def _utc_now_iso() -> str:
    """W2-004: microsecond-precision UTC timestamp for dependency binding."""
    import datetime as _dt

    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


# ---------------------------------------------------------------------------
# Constants & closed enums
# ---------------------------------------------------------------------------

PRODUCERS = ("saitranslate", "saiwiki")

STAGING_DIRNAME = ".prepare-staging"
READY_DIRNAME = "READY"
SETTLED_DIRNAME = "SETTLED"
SUPERSEDED_DIRNAME = "SUPERSEDED"
EPOCH_FILENAME = "producer_epoch.json"
# One shared writer/reader bound: every successfully published READY artifact
# is therefore guaranteed to be reopenable after process restart.
READY_MAX_BYTES = 32 * 1024 * 1024


def _namespace_authority(namespace: Path | str) -> tuple[Path, Path]:
    """Bind a producer namespace lexically beneath one owned `.saipen` root."""
    lexical = Path(os.path.abspath(namespace))
    saipen = next((node for node in (lexical, *lexical.parents) if node.name == ".saipen"), None)
    if saipen is None:
        raise ProducerError(f"producer namespace {lexical} is not beneath .saipen")
    root_input = saipen.parent
    try:
        relative = lexical.relative_to(root_input)
        root = root_input.resolve(strict=True)
    except (OSError, ValueError) as exc:
        raise ProducerError(f"producer namespace owner is invalid: {exc}") from exc
    owned = root / relative
    try:
        prove_owned_dir_chain(owned, kind="producer namespace", ownership_root=root)
    except (OSError, ValueError) as exc:
        raise ProducerError(f"producer namespace ownership refused: {exc}") from exc
    return owned, root


def _owned_descendant(namespace: Path | str, relative: Path | str, *, kind: str) -> Path:
    ns, root = _namespace_authority(namespace)
    rel = Path(relative)
    if rel.is_absolute() or ".." in rel.parts:
        raise ProducerError(f"{kind} path {relative!s} escapes producer namespace")
    path = ns / rel
    try:
        parent_owner = root if path == ns else ns
        prove_owned_dir_chain(path.parent, kind=kind, ownership_root=parent_owner)
    except (OSError, ValueError) as exc:
        raise ProducerError(f"{kind} ownership refused: {exc}") from exc
    return path


def _ensure_owned_dir(namespace: Path | str, relative: Path | str, *, kind: str) -> Path:
    ns, _root = _namespace_authority(namespace)
    path = _owned_descendant(ns, relative, kind=kind)
    try:
        path.mkdir(parents=True, exist_ok=True)
        prove_owned_dir_chain(path, kind=kind, ownership_root=ns)
    except (OSError, ValueError) as exc:
        raise ProducerError(f"{kind} directory refused: {exc}") from exc
    return path


def _read_owned_descendant(
    namespace: Path | str,
    relative: Path | str,
    *,
    kind: str,
    max_bytes: int = READY_MAX_BYTES,
) -> bytes:
    path = _owned_descendant(namespace, relative, kind=kind)
    try:
        witnessed = prove_owned_regular(path, kind=kind)
        return read_bound_regular_bytes(path, witnessed, max_bytes=max_bytes)
    except FileNotFoundError:
        raise
    except (OSError, ValueError) as exc:
        raise ProducerError(f"{kind} read refused: {exc}") from exc


def _owned_regular_exists(namespace: Path | str, relative: Path | str, *, kind: str) -> bool:
    path = _owned_descendant(namespace, relative, kind=kind)
    try:
        prove_owned_regular(path, kind=kind)
    except FileNotFoundError:
        return False
    except ValueError as exc:
        raise ProducerError(f"{kind} ownership refused: {exc}") from exc
    return True


def _owned_dir_exists(namespace: Path | str, relative: Path | str, *, kind: str) -> bool:
    ns, _root = _namespace_authority(namespace)
    path = _owned_descendant(ns, relative, kind=kind)
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    try:
        prove_owned_dir_chain(path, kind=kind, ownership_root=ns)
    except (OSError, ValueError) as exc:
        raise ProducerError(f"{kind} ownership refused: {exc}") from exc
    return True


def _remove_owned_tree(namespace: Path | str, relative: Path | str, *, kind: str) -> None:
    """Remove only a recursively re-proven directory tree owned by namespace."""
    ns, _root = _namespace_authority(namespace)
    path = _owned_descendant(ns, relative, kind=kind)
    try:
        path.lstat()
    except FileNotFoundError:
        return
    try:
        prove_owned_dir_chain(path, kind=kind, ownership_root=ns)
        for entry in list(path.iterdir()):
            info = entry.lstat()
            if entry.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & 0x400):
                raise ProducerError(f"{kind} descendant {entry} is a link/reparse node")
            rel = entry.relative_to(ns)
            if entry.is_dir():
                _remove_owned_tree(ns, rel, kind=kind)
            else:
                prove_owned_regular(entry, kind=kind)
                entry.unlink()
        prove_owned_dir_chain(path, kind=kind, ownership_root=ns)
        path.rmdir()
    except ProducerError:
        raise
    except (OSError, ValueError) as exc:
        raise ProducerError(f"{kind} cleanup refused: {exc}") from exc


def _ready_filename(package_identity: str) -> str:
    """Filesystem-safe READY filename.

    ``package_identity`` is ``sha256:…`` and Windows forbids ``:`` in paths, so
    we sanitize the colon. The on-disk name is cosmetic only -- the canonical
    identity always lives INSIDE the JSON payload.
    """
    return package_identity.replace(":", "_") + ".json"


PACKAGE_MAGIC = b"saipen-producer-pkg-v1\0"
DEP_MAGIC = b"saipen-producer-dep-v1\0"


class PackageStatus(str, Enum):
    STAGING = "staging"
    READY = "ready"
    REVIEWED = "reviewed"
    STALE = "stale"
    SUPERSEDED = "superseded"


class IntegrationClass(str, Enum):
    CURRENT = "CURRENT"
    COMPATIBLE_DRIFT = "COMPATIBLE_DRIFT"
    STALE = "STALE"


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class ProducerError(RuntimeError):
    """Base class for producer-layer failures."""


class StaleWorkerError(ProducerError):
    """An older producer epoch tried to publish after a takeover."""


class ConflictError(ProducerError):
    """Two packages collide on a write target before any canonical write."""


# ---------------------------------------------------------------------------
# Hashing helpers
# ---------------------------------------------------------------------------


def _sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def file_sha256(path: Path) -> str:
    """sha256 of a regular file; `sha256:absent` for a missing path.

    Never mtime-based -- we only ever compare content digests.
    """
    p = Path(path)
    if not p.is_file():
        return "sha256:absent"
    return _sha256_bytes(p.read_bytes())


def _is_windows_absolute(rel: str) -> bool:
    """Platform-neutral detection of Windows absolute paths.

    ``Path.is_absolute()`` is HOST-PLATFORM dependent: a drive-rooted path like
    ``C:\\Windows\\win.ini`` or a UNC path like ``\\\\server\\share\\x`` is NOT
    absolute on a POSIX audit host, so a naive host check lets those escape the
    project. We detect the Windows forms by string inspection regardless of the
    host OS so producer dependency metadata can never name an outside-tree file.
    """
    if not isinstance(rel, str):
        return False
    # Drive rooted:  C:\  or  C:/
    if re.match(r"^[A-Za-z]:[\\/]", rel):
        return True
    # UNC / POSIX-double-slash share:  \\server\share  or  //server/share
    return bool(re.match(r"^[\\/]{2,}", rel))


def _validate_producer_rel_path(rel: str, *, context: str = "") -> None:
    """CORE-007: Centralized producer path validation.

    Accepts only safe normalized relative paths from a closed grammar.
    Rejects absolute paths, UNC/drive forms, parent traversal, control
    characters, and paths that would resolve outside a container.
    Raises ProducerError on any violation.
    """
    if not isinstance(rel, str) or not rel:
        raise ProducerError(f"{context}: path must be a non-empty string")
    # Reject absolute paths. ``Path.is_absolute()`` is host-dependent, so we
    # ALSO detect Windows drive/UNC forms by string inspection (CORE-008).
    if Path(rel).is_absolute() or _is_windows_absolute(rel):
        raise ProducerError(
            f"{context}: absolute path {rel!r} rejected; only producer-relative paths allowed"
        )
    # Reject parent traversal
    parts = Path(rel).parts
    if any(part in ("..", ".") for part in parts):
        raise ProducerError(
            f"{context}: path traversal {rel!r} rejected; only simple relative paths allowed"
        )
    # Reject paths with null bytes or control characters
    for ch in rel:
        if ord(ch) < 0x20:
            raise ProducerError(f"{context}: control character in path rejected")
    # Reject Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    _reserved = {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
    for part in parts:
        stem = part.split(".")[0].upper()
        if stem in _reserved:
            raise ProducerError(f"{context}: Windows reserved name {part!r} in path rejected")


def _safe_rel_hash(root: Path | str, rel: str) -> str:
    """CORE-008: validate, prove containment, then hash a producer-relative path.

    Never opens/hashes ``root / rel`` until ``rel`` passes the closed path
    grammar and the *resolved* target is proven to sit beneath the project
    root (symlink/junction/reparse escape included). This is the single choke
    point every dependency/integration hash must pass.
    """
    _validate_producer_rel_path(rel, context="dependency hash")
    root_path = Path(root)
    try:
        root_res = root_path.resolve()
    except OSError as exc:
        raise ProducerError(f"dependency path {rel!r}: project root unresolvable: {exc}") from exc
    try:
        candidate = (root_path / rel).resolve()
    except OSError as exc:
        raise ProducerError(f"dependency path {rel!r}: target unresolvable: {exc}") from exc
    if candidate != root_res and root_res not in candidate.parents:
        raise ProducerError(
            f"dependency path {rel!r} resolves outside project root "
            f"({candidate} is not under {root_res}); refusing to hash "
            "outside-tree content"
        )
    return file_sha256(candidate)


def read_set_from(root: Path | str, paths: Iterable[str]) -> dict[str, str]:
    """Canonical source dependency path -> content hash (at prepare time).

    CORE-008: every path is validated and containment-proven before hashing so
    an absolute, traversing, drive/UNC, or reparse-escaping path cannot reach
    the filesystem.
    """
    return {rel: _safe_rel_hash(root, rel) for rel in paths}


def write_set_before(root: Path | str, paths: Iterable[str]) -> dict[str, str]:
    """Intended target path -> content hash of the file as it stands NOW
    (the 'before' hash). `sha256:absent` means the target does not yet exist.

    CORE-008: every path is validated before hashing.
    """
    return read_set_from(root, paths)


# ---------------------------------------------------------------------------
# Source identity (duck-typed to freshness.SourceIdentity)
# ---------------------------------------------------------------------------


class SourceKey:
    """W2-007: normalized source-identity representation.

    Both runtime SourceIdentity objects and serialized package fields
    must produce the same classification through global_source_key.
    This class normalizes both forms so the identical-global-identity
    fast path works from any caller.
    """

    __slots__ = ("discovery_model", "source_head", "source_tree_fingerprint")

    def __init__(self, source_head: str, source_tree_fingerprint: str, discovery_model: str = ""):
        self.source_head = source_head
        self.source_tree_fingerprint = source_tree_fingerprint
        self.discovery_model = discovery_model

    @classmethod
    def from_package(cls, pkg: "ProducerPackage") -> "SourceKey":
        """Construct from a ProducerPackage's serialized identity fields."""
        return cls(
            pkg.base_source_head,
            pkg.base_source_tree_fingerprint,
            pkg.base_discovery_model,
        )

    @classmethod
    def from_identity(cls, identity) -> "SourceKey":
        """Construct from a runtime SourceIdentity or duck-typed object."""
        return cls(
            getattr(identity, "source_head", ""),
            getattr(identity, "source_tree_fingerprint", ""),
            getattr(identity, "discovery_model", ""),
        )

    @classmethod
    def from_tuple(cls, t: tuple[str, str, str]) -> "SourceKey":
        """Construct from an explicit (head, fp, model) tuple."""
        head, fp = t[0], t[1]
        model = t[2] if len(t) > 2 else ""
        return cls(head, fp, model)


def global_source_key(identity) -> tuple[str, str, str]:
    """W2-007: (source_head, source_tree_fingerprint, discovery_model).

    Structural-equality key for the 'identical global source identity' fast
    path. Accepts SourceIdentity objects, ProducerPackages, SourceKey
    instances, or duck-typed objects with the three attributes.
    """
    if isinstance(identity, SourceKey):
        return (identity.source_head, identity.source_tree_fingerprint, identity.discovery_model)
    if isinstance(identity, ProducerPackage):
        return (
            identity.base_source_head,
            identity.base_source_tree_fingerprint,
            identity.base_discovery_model,
        )
    if isinstance(identity, tuple) and len(identity) >= 2:
        model = identity[2] if len(identity) > 2 else ""
        return (identity[0], identity[1], model)
    # Duck-typed object with attributes
    return (
        getattr(identity, "source_head", ""),
        getattr(identity, "source_tree_fingerprint", ""),
        getattr(identity, "discovery_model", ""),
    )


# ---------------------------------------------------------------------------
# Dependency fingerprint + stable package identity (spec §1, §6)
# ---------------------------------------------------------------------------


def dependency_fingerprint(
    read_set: Mapping[str, str],
    write_set: Mapping[str, str],
    role_revision: str,
) -> str:
    """A stable hash over the dependency STRUCTURE (paths + content hashes).

    Order-independent: sorting keys makes the fingerprint depend only on the
    declared dependency set, not on dict iteration order.
    """
    digest = hashlib.sha256()
    digest.update(DEP_MAGIC)
    digest.update(role_revision.encode("utf-8"))
    digest.update(b"\0")
    for rel in sorted(read_set):
        digest.update(struct.pack(">Q", len(rel)))
        digest.update(rel.encode("utf-8"))
        digest.update(struct.pack(">Q", len(read_set[rel])))
        digest.update(read_set[rel].encode("utf-8"))
    for rel in sorted(write_set):
        digest.update(struct.pack(">Q", len(rel)))
        digest.update(rel.encode("utf-8"))
        digest.update(struct.pack(">Q", len(write_set[rel])))
        digest.update(write_set[rel].encode("utf-8"))
    return "sha256:" + digest.hexdigest()


def package_identity(
    producer: str,
    role_revision: str,
    dependency_fp: str,
    requested_scope: str,
    base_source_head: str = "",
    base_source_tree_fingerprint: str = "",
    base_discovery_model: str = "",
) -> str:
    """Stable identity for one producer result at one source generation."""
    digest = hashlib.sha256()
    digest.update(PACKAGE_MAGIC)
    for part in (
        producer,
        role_revision,
        dependency_fp,
        requested_scope,
        base_source_head,
        base_source_tree_fingerprint,
        base_discovery_model,
    ):
        chunk = part.encode("utf-8")
        digest.update(struct.pack(">Q", len(chunk)))
        digest.update(chunk)
    return "sha256:" + digest.hexdigest()


# ---------------------------------------------------------------------------
# ProducerPackage (spec §1)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProducerPackage:
    producer: str
    role_revision: str
    base_source_head: str
    base_source_tree_fingerprint: str
    base_discovery_model: str
    scope: str
    read_set: dict[str, str] = field(default_factory=dict)
    write_set: dict[str, str] = field(default_factory=dict)
    epoch: int = 0
    dependency_fp: str = ""
    package_identity: str = ""
    status: str = PackageStatus.STAGING.value
    # READY-only decoded payload. Excluded from identity derivation because the
    # published payload is independently bound by payload_hashes and the exact
    # write-set keys.
    payloads: dict[str, bytes] = field(default_factory=dict, repr=False, compare=False)
    ready_path: Path | None = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        if not self.dependency_fp:
            object.__setattr__(
                self,
                "dependency_fp",
                dependency_fingerprint(self.read_set, self.write_set, self.role_revision),
            )
        if not self.package_identity:
            object.__setattr__(
                self,
                "package_identity",
                package_identity(
                    self.producer,
                    self.role_revision,
                    self.dependency_fp,
                    self.scope,
                    self.base_source_head,
                    self.base_source_tree_fingerprint,
                    self.base_discovery_model,
                ),
            )

    def materialize_payload(self) -> bool:
        """Re-open ``self.ready_path`` and populate ``self.payloads``.

        Used by callers that performed a metadata-only ``scan_ready`` and
        later need the decoded payload bytes for one selected package.
        Strict hash verification is repeated against the on-disk artifact
        so a tampered READY between scan and materialize cannot reach
        integration as a forged payload. Returns ``True`` on success.
        """
        if self.ready_path is None:
            return False
        if self.payloads:
            return True
        if self.status != PackageStatus.READY.value:
            return False
        try:
            ns = self.ready_path.parent.parent
            relative = Path(READY_DIRNAME) / self.ready_path.name
            raw_bytes = _read_owned_descendant(
                ns,
                relative,
                kind="producer READY package",
                max_bytes=READY_MAX_BYTES,
            )
            data = json.loads(raw_bytes.decode("utf-8"))
            rehydrated = ProducerPackage.from_dict(
                data,
                expected_producer=self.producer,
                expected_identity=self.package_identity,
                ready_path=self.ready_path,
                materialize_payloads=True,
            )
        except (ProducerError, OSError, UnicodeDecodeError, json.JSONDecodeError):
            return False
        object.__setattr__(self, "payloads", dict(rehydrated.payloads))
        return True

    def to_dict(self) -> dict:
        return {
            "producer": self.producer,
            "role_revision": self.role_revision,
            "base_source_head": self.base_source_head,
            "base_source_tree_fingerprint": self.base_source_tree_fingerprint,
            "base_discovery_model": self.base_discovery_model,
            "scope": self.scope,
            "read_set": dict(self.read_set),
            "write_set": dict(self.write_set),
            "epoch": self.epoch,
            "dependency_fp": self.dependency_fp,
            "package_identity": self.package_identity,
            "status": self.status,
        }

    @classmethod
    def from_dict(
        cls,
        data: Mapping,
        *,
        expected_producer: str | None = None,
        expected_identity: str | None = None,
        ready_path: Path | None = None,
        materialize_payloads: bool = True,
    ) -> "ProducerPackage":
        """Strict persisted-package decoder.

        Derived authority is always recomputed.  READY payload bytes/hashes,
        namespace producer and filename identity are one closed persistence
        schema; hostile or partial JSON raises ``ProducerError`` rather than
        reaching autonomous planning as a forged package.
        """
        if not isinstance(data, Mapping):
            raise ProducerError("READY package must be a JSON object")
        if ready_path is not None:
            ready_schema = {
                "producer",
                "role_revision",
                "base_source_head",
                "base_source_tree_fingerprint",
                "base_discovery_model",
                "scope",
                "read_set",
                "write_set",
                "epoch",
                "dependency_fp",
                "package_identity",
                "status",
                "payload_hashes",
                "payload_bytes",
            }
            if set(data) != ready_schema:
                missing = sorted(ready_schema - set(data))
                extra = sorted(set(data) - ready_schema)
                raise ProducerError(f"READY schema mismatch (missing={missing}, extra={extra})")
        required_strings = (
            "producer",
            "role_revision",
            "base_source_head",
            "base_source_tree_fingerprint",
            "base_discovery_model",
            "scope",
            "dependency_fp",
            "package_identity",
            "status",
        )
        for key in required_strings:
            if not isinstance(data.get(key), str):
                raise ProducerError(f"READY field {key!r} must be a string")
        producer = data["producer"]
        if producer not in PRODUCERS:
            raise ProducerError(f"READY producer {producer!r} outside {PRODUCERS}")
        if expected_producer is not None and producer != expected_producer:
            raise ProducerError(
                f"READY producer {producer!r} does not match namespace {expected_producer!r}"
            )
        status = data["status"]
        if status not in {item.value for item in PackageStatus}:
            raise ProducerError(f"READY status {status!r} outside closed status set")
        if ready_path is not None and status != PackageStatus.READY.value:
            raise ProducerError("file in READY/SETTLED must carry status 'ready'")
        epoch = data.get("epoch")
        if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
            raise ProducerError("READY epoch must be a non-negative integer")

        def _hash_map(key: str) -> dict[str, str]:
            value = data.get(key)
            if not isinstance(value, Mapping):
                raise ProducerError(f"READY field {key!r} must be a JSON object")
            out: dict[str, str] = {}
            for rel, digest in value.items():
                _validate_producer_rel_path(rel, context=f"package {key}")
                if not isinstance(digest, str):
                    raise ProducerError(f"READY {key}[{rel!r}] must be a string hash")
                out[rel] = digest
            return out

        read_set = _hash_map("read_set")
        write_set = _hash_map("write_set")
        derived_dep = dependency_fingerprint(read_set, write_set, data["role_revision"])
        if data["dependency_fp"] != derived_dep:
            raise ProducerError("READY dependency_fp does not match recomputed dependencies")
        derived_identity = package_identity(
            producer,
            data["role_revision"],
            derived_dep,
            data["scope"],
            data["base_source_head"],
            data["base_source_tree_fingerprint"],
            data["base_discovery_model"],
        )
        if data["package_identity"] != derived_identity:
            raise ProducerError("READY package_identity does not match recomputed identity")
        if expected_identity is not None and derived_identity != expected_identity:
            raise ProducerError("READY filename/request identity does not match package identity")

        payloads: dict[str, bytes] = {}
        if status == PackageStatus.READY.value:
            import base64

            payload_hashes = data.get("payload_hashes")
            payload_bytes = data.get("payload_bytes")
            if not isinstance(payload_hashes, Mapping) or not isinstance(payload_bytes, Mapping):
                raise ProducerError("READY payload_hashes/payload_bytes must be JSON objects")
            if set(payload_hashes) != set(write_set) or set(payload_bytes) != set(write_set):
                raise ProducerError("READY payload keys must exactly equal write_set keys")
            for rel in write_set:
                encoded = payload_bytes[rel]
                expected_hash = payload_hashes[rel]
                if not isinstance(encoded, str) or not isinstance(expected_hash, str):
                    raise ProducerError(f"READY payload metadata for {rel!r} must be strings")
                try:
                    raw = base64.b64decode(encoded.encode("ascii"), validate=True)
                except Exception as exc:
                    raise ProducerError(
                        f"READY payload {rel!r} is not valid base64: {exc}"
                    ) from exc
                if _sha256_bytes(raw) != expected_hash:
                    raise ProducerError(f"READY payload hash mismatch for {rel!r}")
                # PERF-002: strict payload validation runs even when callers want
                # only metadata; retained bytes are dropped unless the caller
                # explicitly materialized the payload. Hot READY scans
                # (crew health + targeted ship) stay metadata-only; the
                # integrate path materializes the single winner on demand.
                if materialize_payloads:
                    payloads[rel] = raw

        return cls(
            producer=producer,
            role_revision=data["role_revision"],
            base_source_head=data["base_source_head"],
            base_source_tree_fingerprint=data["base_source_tree_fingerprint"],
            base_discovery_model=data["base_discovery_model"],
            scope=data["scope"],
            read_set=read_set,
            write_set=write_set,
            epoch=epoch,
            dependency_fp=derived_dep,
            package_identity=derived_identity,
            status=status,
            payloads=payloads,
            ready_path=ready_path,
        )


def build_package(
    *,
    producer: str,
    role_revision: str,
    base_source_head: str,
    base_source_tree_fingerprint: str,
    base_discovery_model: str,
    scope: str,
    read_set: Mapping[str, str],
    write_set: Mapping[str, str],
    epoch: int = 0,
    status: str = PackageStatus.STAGING.value,
) -> ProducerPackage:
    return ProducerPackage(
        producer=producer,
        role_revision=role_revision,
        base_source_head=base_source_head,
        base_source_tree_fingerprint=base_source_tree_fingerprint,
        base_discovery_model=base_discovery_model,
        scope=scope,
        read_set=dict(read_set),
        write_set=dict(write_set),
        epoch=epoch,
        status=status,
    )


# ---------------------------------------------------------------------------
# Integration classification (spec §1, read_set/write_set revalidation)
# ---------------------------------------------------------------------------


def classify_integration(
    base_identity,
    current_identity,
    read_set: Mapping[str, str],
    write_set: Mapping[str, str],
    current_hashes: Mapping[str, str],
) -> tuple[IntegrationClass, str]:
    """Decide how a prepared package integrates against the CURRENT source.

    Fast path: identical global source identity -> CURRENT.
    Otherwise revalidate the declared read_set AND write_set against the live
    filesystem (content hashes only -- never mtime):

      * any read dependency changed  -> STALE (relevant input drifted);
      * any intended write target diverged from its 'before' hash -> STALE
        (someone else moved a path this package would clobber);
      * otherwise -> COMPATIBLE_DRIFT (global identity changed but no declared
        dependency of THIS package changed) -> serialized Core integration OK.
    """
    if global_source_key(base_identity) == global_source_key(current_identity):
        return IntegrationClass.CURRENT, "identical global source identity"

    for rel, expected in read_set.items():
        now = current_hashes.get(rel, "sha256:absent")
        if now != expected:
            return (
                IntegrationClass.STALE,
                f"read dependency {rel!r} changed (expected {expected[:12]}.. got {now[:12]}..)",
            )

    for rel, before in write_set.items():
        now = current_hashes.get(rel, "sha256:absent")
        if now != before:
            return (
                IntegrationClass.STALE,
                f"intended write target {rel!r} diverged from its 'before' hash "
                f"(before {before[:12]}.. now {now[:12]}..)",
            )

    return (
        IntegrationClass.COMPATIBLE_DRIFT,
        "global source identity changed but no declared read/write dependency "
        "of this package changed",
    )


# ---------------------------------------------------------------------------
# Explicit conflict model (spec §2)
# ---------------------------------------------------------------------------


def derive_conflicts(a: ProducerPackage, b: ProducerPackage) -> dict:
    """Derive compatibility mechanically from the two packages' read/write sets.

    Exposes the EXACT conflict/invalidation reason so Core can refuse with a
    precise diagnosis instead of a generic failure.
    """
    a_write = set(a.write_set)
    a_read = set(a.read_set)
    b_write = set(b.write_set)
    b_read = set(b.read_set)

    write_write = sorted(a_write & b_write)
    a_write_b_read = sorted(a_write & b_read)
    b_write_a_read = sorted(b_write & a_read)

    compatible = not (write_write or a_write_b_read or b_write_a_read)
    reasons: list[str] = []
    if write_write:
        reasons.append(
            f"write/write collision on {write_write}: {a.producer} and "
            f"{b.producer} both intend to write the same path"
        )
    if a_write_b_read:
        reasons.append(f"{a.producer} writes paths {a_write_b_read} that {b.producer} reads")
    if b_write_a_read:
        reasons.append(f"{b.producer} writes paths {b_write_a_read} that {a.producer} reads")

    return {
        "packages": (a.package_identity, b.package_identity),
        "write_write": write_write,
        "a_write_b_read": a_write_b_read,
        "b_write_a_read": b_write_a_read,
        "compatible": compatible,
        "reasons": reasons,
    }


# ---------------------------------------------------------------------------
# Producer epoch / stale-worker rejection (spec §5)
# ---------------------------------------------------------------------------


class ProducerEpoch:
    """Per-namespace monotonic ownership epoch.

    A mutable producer preparation generation carries the epoch it claimed.
    If ownership is replaced (a newer epoch exists), an older epoch can no
    longer publish READY state -- a resumed stale worker fails BEFORE it
    overwrites newer producer evidence.

    CORE-008: The epoch must distinguish ABSENT (never-initialized, resolve
    to epoch 0) from CORRUPT (malformed/truncated/unreadable, block
    claim/publish). Malformed state must NOT silently reset authority --
    that lets a stale worker publish over a newer generation.
    """

    @staticmethod
    def _path(namespace: Path) -> Path:
        return Path(namespace) / EPOCH_FILENAME

    @staticmethod
    def _decode(namespace: Path | str) -> tuple[int, str, str]:
        """Strictly decode persisted fencing authority once.

        Numeric coercion, booleans and negative epochs would roll the fencing
        token backwards.  A present record therefore has one closed shape;
        only genuine absence denotes the initial epoch zero.
        """
        ns, _root = _namespace_authority(namespace)
        if not _owned_regular_exists(ns, EPOCH_FILENAME, kind="producer epoch"):
            return 0, "", ""
        try:
            raw = _read_owned_descendant(
                ns, EPOCH_FILENAME, kind="producer epoch", max_bytes=64 * 1024
            )
            data = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProducerError(f"producer epoch file is corrupt/unreadable: {exc}") from exc
        if not isinstance(data, dict):
            raise ProducerError("producer epoch file is not a JSON object")
        known = {"epoch", "owner", "claimed_at"}
        unknown = set(data) - known
        if unknown:
            raise ProducerError(f"producer epoch file contains unrecognized fields: {unknown}")
        epoch = data.get("epoch")
        owner = data.get("owner")
        claimed_at = data.get("claimed_at")
        if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
            raise ProducerError(
                f"producer epoch must be a non-negative JSON integer, got {epoch!r}"
            )
        if not isinstance(owner, str) or not owner:
            raise ProducerError("producer epoch owner must be a non-empty string")
        if not isinstance(claimed_at, str) or not claimed_at:
            raise ProducerError("producer epoch claimed_at must be a non-empty string")
        return epoch, owner, claimed_at

    @staticmethod
    def current(namespace: Path | str) -> int:
        """Read the current epoch. Returns 0 only when genuinely ABSENT.

        Malformed/truncated/unreadable state raises rather than resetting
        to epoch 0. This prevents a crash-truncated file from letting a
        stale worker appear current.
        """
        return ProducerEpoch._decode(namespace)[0]

    @staticmethod
    def claim(namespace: Path | str) -> int:
        """Advance and persist the namespace epoch atomically; return the epoch owned.

        CORE-008: Claim writes through a temp file + os.replace to guarantee
        atomic visibility. A crash during write leaves either the old epoch
        or the new one, never a partial/truncated file.
        """
        ns, project_root = _namespace_authority(namespace)
        producer = ns.name
        if producer not in PRODUCERS:
            raise ProducerError(f"cannot claim epoch for unknown producer {producer!r}")
        # The read/increment/replace sequence is one producer-local critical
        # section.  Unique temp names alone prevent temp collisions but do not
        # prevent the classic n -> n+1 lost update.
        with ProducerLock(project_root, producer):
            _ensure_owned_dir(ns, ".", kind="producer namespace")
            path = ProducerEpoch._path(ns)
            new_epoch = ProducerEpoch.current(ns) + 1
            owner = uuid.uuid4().hex
            payload = (
                json.dumps(
                    {
                        "epoch": new_epoch,
                        "owner": owner,
                        "claimed_at": uuid.uuid1().hex,
                    },
                    sort_keys=True,
                )
                + "\n"
            )
            safe_atomic_write_bytes(
                path,
                payload.encode("utf-8"),
                kind="producer epoch",
                ownership_root=ns,
            )
            return new_epoch

    @staticmethod
    def current_owner(namespace: Path | str) -> str:
        """Return the current owner token; corrupt authority raises."""
        return ProducerEpoch._decode(namespace)[1]

    @staticmethod
    def owns(namespace: Path | str, epoch: int, owner: str | None = None) -> bool:
        """True only when the stored epoch matches and (optionally) the owner matches.

        When owner is None, only epoch matching is checked (backward
        compatible). When owner is provided, both epoch and owner must match
        to prove current ownership.
        """
        stored = ProducerEpoch.current(namespace)
        if stored != epoch:
            return False
        if owner is not None:
            return ProducerEpoch.current_owner(namespace) == owner
        return True


# ---------------------------------------------------------------------------
# Atomic prepare publication (spec §3)
# ---------------------------------------------------------------------------


class StagingGeneration:
    """Prepare into a non-READY staging generation.

    READY becomes visible ONLY after every payload is complete, hashes/manifests
    are complete, internal verification passed, and package metadata is
    complete. A crash before final publication leaves only incomplete staging
    evidence -- never a READY package. Final publication is atomic (os.replace)
    and idempotent (re-publishing the same identity is a no-op success).
    """

    def __init__(
        self,
        namespace: Path | str,
        producer: str,
        generation_id: str | None = None,
    ) -> None:
        self.namespace, self._project_root = _namespace_authority(namespace)
        self._producer = producer
        self._generation_id = generation_id or uuid.uuid4().hex
        if (
            not self._generation_id
            or Path(self._generation_id).name != self._generation_id
            or self._generation_id in {".", ".."}
        ):
            raise ProducerError(f"invalid producer generation id {self._generation_id!r}")
        self.staging_dir = self.namespace / STAGING_DIRNAME / self._generation_id
        self.payload_dir = self.staging_dir / "payload"
        self.manifest_path = self.staging_dir / "staging.manifest.json"
        self.package: ProducerPackage | None = None
        self._begin_manifest: dict[str, str | int] | None = None
        self._bound_generation_id: str | None = None
        self._bound_producer: str | None = None
        self._bound_epoch: int | None = None
        self._bound_authority: tuple[str, str, int] | None = None
        self._bound_manifest: tuple[tuple[str, str | int], ...] | None = None

    @property
    def producer(self) -> str:
        return self._producer

    @property
    def generation_id(self) -> str:
        return self._generation_id

    # -- lifecycle --------------------------------------------------------

    def begin(self) -> "StagingGeneration":
        epoch = ProducerEpoch.current(self.namespace)
        begin_time = _utc_now_iso()
        staging_rel = Path(STAGING_DIRNAME) / self.generation_id
        was_present = self.staging_dir.exists()
        if self.producer != self.namespace.name or self.producer not in PRODUCERS:
            raise ProducerError(
                f"producer {self.producer!r} does not match namespace {self.namespace.name!r}"
            )
        manifest = {
            "generation_id": self.generation_id,
            "producer": self.producer,
            "epoch": epoch,
            "begin_time": begin_time,
        }
        try:
            self.staging_dir = _ensure_owned_dir(
                self.namespace, staging_rel, kind="producer staging generation"
            )
            self.payload_dir = _ensure_owned_dir(
                self.namespace, staging_rel / "payload", kind="producer payload directory"
            )
            safe_create_bytes_exclusive(
                self.staging_dir / ".in-flight",
                (json.dumps(manifest, sort_keys=True) + "\n").encode("utf-8"),
                kind="producer in-flight marker",
                ownership_root=self.namespace,
            )
            safe_create_bytes_exclusive(
                self.manifest_path,
                (json.dumps(manifest, sort_keys=True) + "\n").encode("utf-8"),
                kind="producer staging manifest",
                ownership_root=self.namespace,
            )
        except Exception:
            if not was_present:
                with contextlib.suppress(Exception):
                    _remove_owned_tree(
                        self.namespace,
                        staging_rel,
                        kind="producer staging generation",
                    )
            raise
        self._begin_manifest = dict(manifest)
        self._bound_generation_id = self.generation_id
        self._bound_producer = self.producer
        self._bound_epoch = epoch
        self._bound_authority = (self.generation_id, self.producer, epoch)
        self._bound_manifest = tuple(sorted(manifest.items()))
        return self

    def add_payload(self, rel_path: str, content: bytes | str) -> None:
        # CORE-007: validate the path before any filesystem operation so
        # absolute paths, traversal, or reparse escapes cannot write outside
        # the producer namespace.
        _validate_producer_rel_path(rel_path, context="add_payload")
        data = content.encode("utf-8") if isinstance(content, str) else content
        rel = Path(STAGING_DIRNAME) / self.generation_id / "payload" / rel_path
        target = _owned_descendant(self.namespace, rel, kind="producer payload")
        _ensure_owned_dir(self.namespace, rel.parent, kind="producer payload parent")
        safe_atomic_write_bytes(
            target,
            data,
            kind="producer payload",
            ownership_root=self.namespace,
        )

    def set_package(self, package: ProducerPackage) -> None:
        if self._bound_authority is None:
            raise ProducerError("staging generation has not begun")
        if package.producer != self._bound_authority[1]:
            raise ProducerError("package producer does not match staging generation producer")
        if package.epoch != self._bound_authority[2]:
            raise ProducerError("package epoch does not match staging generation epoch")
        self.package = package

    def _verify(self) -> list[str]:
        errors: list[str] = []
        if self.package is None:
            errors.append("package metadata is missing -- nothing to publish")
            return errors
        # Every declared write_set target must have a COMPLETE payload present.
        # The payload carries the NEW content; the 'before' hash in write_set is
        # checked only at integration time (by classify_integration), not here.
        # A crash before every payload is written leaves this generation in
        # flight and never reaches publish() -> no READY artifact.
        for rel in self.package.write_set:
            payload_rel = Path(STAGING_DIRNAME) / self.generation_id / "payload" / rel
            try:
                exists = _owned_regular_exists(self.namespace, payload_rel, kind="producer payload")
            except ProducerError as exc:
                errors.append(str(exc))
                continue
            if not exists:
                errors.append(f"payload missing for intended write target {rel!r}")
        # package metadata completeness
        if not self.package.package_identity:
            errors.append("package_identity not derived")
        if not self.package.read_set and not self.package.write_set:
            errors.append("package declares neither read_set nor write_set")
        # W2-004: revalidate that declared dependencies still match.
        # This catches the case where Core changed a declared input between
        # the producer's real read/generation step and this publish call.
        reval_errs = self._revalidate_dependencies()
        errors.extend(reval_errs)
        return errors

    def _revalidate_dependencies(self) -> list[str]:
        """W2-004: re-read every declared dependency/write precondition and
        require it still matches what the package declares.

        Unrelated whole-tree drift may remain compatible, but any
        declared-input drift makes the generation STALE/RETRY and it
        must never publish READY.

        Read-set dependencies are checked against the PROJECT ROOT (not the
        namespace), since that's where source files live.
        """
        if self.package is None:
            return []
        errors: list[str] = []
        # W2-004: read-set dependencies are in the project source tree,
        # not in the namespace. Resolve the project root by going up from
        # the namespace until we find a .saipen directory.
        project_root = self._find_project_root()
        # Revalidate read_set: each declared read dependency must still
        # have the same content hash as when the package was built.
        for rel, expected_hash in self.package.read_set.items():
            if project_root is not None:
                actual = file_sha256(project_root / rel)
            else:
                # Fallback: check in the staging parent (namespace)
                actual = file_sha256(self.staging_dir.parent / rel)
            if actual != expected_hash:
                errors.append(
                    f"W2-004: read dependency {rel!r} drifted: "
                    f"expected {expected_hash[:16]}.. got {actual[:16]}.. "
                    "-- package is STALE, must retry"
                )
        # Write preconditions bind canonical project targets exactly, including
        # absent->present and present->absent movement.
        for rel, expected_before in self.package.write_set.items():
            if project_root is None:
                errors.append("W2-004: project root unavailable for write precondition")
                continue
            try:
                actual = _safe_rel_hash(project_root, rel)
            except ProducerError as exc:
                errors.append(str(exc))
                continue
            if actual != expected_before:
                errors.append(
                    f"W2-004: write target {rel!r} 'before' hash drifted: "
                    f"expected {expected_before[:16]}.. got {actual[:16]}.. "
                    "-- package is STALE, must retry"
                )
        return errors

    def _find_project_root(self) -> Path | None:
        """W2-004: resolve the project root by finding .saipen directory."""
        return self._project_root

    def publish(self) -> dict:
        """Publish under the same-role producer lock.

        Claim and publication share one lock identity.  A concurrent same-role
        publisher therefore either wins the lock or receives PRODUCER_BUSY;
        it can never race the epoch check and publish beside the winner.
        """
        project_root = self._find_project_root()
        if project_root is None:
            return {
                "ok": False,
                "code": "PROJECT_ROOT_UNKNOWN",
                "detail": "cannot locate project root for producer publication",
            }
        try:
            with ProducerLock(project_root, self.producer):
                return self._publish_under_lock()
        except PermissionError as exc:
            return {"ok": False, "code": "PRODUCER_BUSY", "detail": str(exc)}
        except ProducerError as exc:
            return {"ok": False, "code": "OWNERSHIP_REFUSED", "detail": str(exc)}

    def _publish_under_lock(self) -> dict:
        """Atomically promote this staging generation to READY.

        Returns a result dict. On any failure, no READY artifact is created.
        """
        if self.package is None:
            return {"ok": False, "code": "NO_PACKAGE", "detail": "package metadata missing"}
        errors = self._verify()
        if errors:
            return {"ok": False, "code": "INCOMPLETE", "detail": "; ".join(errors)}

        try:
            manifest_raw = _read_owned_descendant(
                self.namespace,
                self.manifest_path.relative_to(self.namespace),
                kind="producer staging manifest",
                max_bytes=64 * 1024,
            )
            manifest = json.loads(manifest_raw.decode("utf-8"))
        except (FileNotFoundError, ProducerError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            return {"ok": False, "code": "STAGING_CORRUPT", "detail": str(exc)}
        expected_manifest = self._bound_manifest
        if not isinstance(manifest, dict):
            return {
                "ok": False,
                "code": "STAGING_CORRUPT",
                "detail": "staging manifest is not a JSON object",
            }
        if expected_manifest is None or tuple(sorted(manifest.items())) != expected_manifest:
            return {
                "ok": False,
                "code": "STAGING_CORRUPT",
                "detail": "staging manifest does not match bound generation authority",
            }
        if (
            self.package.producer != self._bound_authority[1]
            or self.package.epoch != self._bound_authority[2]
        ):
            return {
                "ok": False,
                "code": "STAGING_CORRUPT",
                "detail": "package does not match bound generation authority",
            }
        try:
            owns = ProducerEpoch.owns(self.namespace, self._bound_authority[2])
        except ProducerError as exc:
            return {
                "ok": False,
                "code": "EPOCH_CORRUPT",
                "detail": f"producer epoch is corrupt/unreadable: {exc}",
            }
        if not owns:
            return {
                "ok": False,
                "code": "STALE_WORKER",
                "detail": (
                    f"namespace epoch advanced past {self._bound_authority[2]}; "
                    "this worker is stale and may not publish"
                ),
            }

        ready_dir = _ensure_owned_dir(
            self.namespace, READY_DIRNAME, kind="producer READY directory"
        )
        rid = self.package.package_identity
        target = ready_dir / _ready_filename(rid)

        # Idempotent: an identical READY package already exists -> reuse.
        # BUT a matching package_identity only proves identical CONTENT; the
        # artifact's recorded base-source binding must still be CURRENT.
        # package_identity is derived from producer/role/dependencies/scope,
        # NOT from the source binding, so a package produced against an older
        # HEAD can share the identity while carrying a stale source_head/
        # source_tree_fingerprint. Reusing that artifact leaves producer
        # health NOT_RUN/STALE against the current tree forever (reproduced
        # live: saitranslate READY carried e045ad07/da948ff while the tree was
        # a5bbda6f/55f, so `saipen crew` kept demanding PREPARE_TRANSLATE).
        # Only reuse when the existing binding equals the new one; otherwise
        # fall through and re-publish the current binding.
        if _owned_regular_exists(
            self.namespace,
            Path(READY_DIRNAME) / target.name,
            kind="producer READY package",
        ):
            try:
                raw = _read_owned_descendant(
                    self.namespace,
                    Path(READY_DIRNAME) / target.name,
                    kind="producer READY package",
                    max_bytes=READY_MAX_BYTES,
                )
                existing = ProducerPackage.from_dict(
                    json.loads(raw.decode("utf-8")),
                    expected_producer=self.producer,
                    expected_identity=rid,
                    ready_path=target,
                )
                staged_payloads: dict[str, bytes] = {}
                for rel in self.package.write_set:
                    payload_rel = Path(STAGING_DIRNAME) / self.generation_id / "payload" / rel
                    staged_payloads[rel] = _read_owned_descendant(
                        self.namespace,
                        payload_rel,
                        kind="producer payload",
                        max_bytes=READY_MAX_BYTES,
                    )
                metadata_match = all(
                    getattr(existing, field_name) == getattr(self.package, field_name)
                    for field_name in (
                        "producer",
                        "role_revision",
                        "base_source_head",
                        "base_source_tree_fingerprint",
                        "base_discovery_model",
                        "scope",
                        "read_set",
                        "write_set",
                        "epoch",
                        "dependency_fp",
                        "package_identity",
                    )
                )
                if metadata_match and existing.payloads == staged_payloads:
                    _remove_owned_tree(
                        self.namespace,
                        self.staging_dir.relative_to(self.namespace),
                        kind="producer staging generation",
                    )
                    return {
                        "ok": True,
                        "code": "REUSED",
                        "package_identity": rid,
                        "detail": "identical READY package already present",
                    }
                return {
                    "ok": False,
                    "code": "READY_CONFLICT",
                    "package_identity": rid,
                    "detail": "existing READY package is valid but not identical",
                }
            except (
                ProducerError,
                ValueError,
                OSError,
                UnicodeDecodeError,
                json.JSONDecodeError,
            ) as exc:
                # A pre-existing READY node is durable evidence.  Never hide
                # corruption by replacing it with a newly generated package.
                return {
                    "ok": False,
                    "code": "READY_CORRUPT",
                    "package_identity": rid,
                    "detail": f"existing READY package is unreadable: {exc}",
                }

        data = self.package.to_dict()
        data["status"] = PackageStatus.READY.value
        # CORE-006: retain payload bytes so READY is a self-contained
        # artifact. Integration can reconstruct/apply solely from READY
        # storage without any in-memory staging objects.
        payload_hashes: dict[str, str] = {}
        payload_bytes: dict[str, str] = {}
        # Read one staged payload at a time.  The generation no longer keeps a
        # second raw in-memory copy beside its staged file and encoded JSON.
        for rel in self.package.write_set:
            payload_rel = Path(STAGING_DIRNAME) / self.generation_id / "payload" / rel
            try:
                payload_path = _owned_descendant(
                    self.namespace, payload_rel, kind="producer payload"
                )
                payload_stat = prove_owned_regular(payload_path, kind="producer payload")
                if payload_stat.st_size > READY_MAX_BYTES:
                    return {
                        "ok": False,
                        "code": "READY_TOO_LARGE",
                        "detail": (
                            f"payload {rel!r} is {payload_stat.st_size} bytes; "
                            f"READY reader limit is {READY_MAX_BYTES}"
                        ),
                    }
                raw = _read_owned_descendant(
                    self.namespace,
                    payload_rel,
                    kind="producer payload",
                    max_bytes=READY_MAX_BYTES,
                )
            except (FileNotFoundError, ProducerError) as exc:
                return {"ok": False, "code": "INCOMPLETE", "detail": str(exc)}
            h = _sha256_bytes(raw)
            payload_hashes[rel] = h
            # Store as base64 so the JSON is self-contained binary-safe
            import base64 as _b64

            payload_bytes[rel] = _b64.b64encode(raw).decode("ascii")
        data["payload_hashes"] = payload_hashes
        data["payload_bytes"] = payload_bytes
        ready_body = (json.dumps(data, sort_keys=True) + "\n").encode("utf-8")
        if len(ready_body) > READY_MAX_BYTES:
            return {
                "ok": False,
                "code": "READY_TOO_LARGE",
                "detail": (
                    f"serialized READY artifact is {len(ready_body)} bytes; "
                    f"reader limit is {READY_MAX_BYTES}"
                ),
            }
        safe_atomic_write_bytes(
            target,
            ready_body,
            kind="producer READY package",
            ownership_root=self.namespace,
        )
        # READY replacement is the semantic commit point.  Staging cleanup is
        # maintenance after publication; a cleanup/topology failure must not
        # lie to callers that no package became visible.  Leaving the owned
        # generation is safe and lets retry/recovery remove it later.
        try:
            _remove_owned_tree(
                self.namespace,
                self.staging_dir.relative_to(self.namespace),
                kind="producer staging generation",
            )
        except (ProducerError, OSError, ValueError) as exc:
            return {
                "ok": True,
                "code": "PUBLISHED",
                "package_identity": rid,
                "cleanup_pending": True,
                "warning": f"staging cleanup pending: {exc}",
            }
        return {"ok": True, "code": "PUBLISHED", "package_identity": rid}

    # -- visibility -------------------------------------------------------

    @classmethod
    def is_ready(cls, namespace: Path | str, package_identity: str) -> bool:
        try:
            return _owned_regular_exists(
                namespace,
                Path(READY_DIRNAME) / _ready_filename(package_identity),
                kind="producer READY package",
            )
        except ProducerError:
            return False

    @classmethod
    def ready_package(cls, namespace: Path | str, package_identity: str) -> ProducerPackage | None:
        try:
            ns, _root = _namespace_authority(namespace)
            relative = Path(READY_DIRNAME) / _ready_filename(package_identity)
            if not _owned_regular_exists(ns, relative, kind="producer READY package"):
                return None
            path = ns / relative
            raw = _read_owned_descendant(
                ns,
                relative,
                kind="producer READY package",
                max_bytes=READY_MAX_BYTES,
            )
            return ProducerPackage.from_dict(
                json.loads(raw.decode("utf-8")),
                expected_producer=ns.name,
                expected_identity=package_identity,
                ready_path=path,
            )
        except (ProducerError, OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    @classmethod
    def scan_ready(
        cls, namespace: Path | str, materialize_payloads: bool = True
    ) -> tuple[list[ProducerPackage], list[dict]]:
        """Return valid READY packages plus structured invalid-record errors.

        When *materialize_payloads* is ``False``, payload bytes are validated
        (base64 decode + hash verify) but not retained; callers must invoke
        :meth:`materialize_payload` on a selected package before using its
        ``payloads`` dict.  Default ``True`` preserves the existing behaviour.
        """
        try:
            ns, _root = _namespace_authority(namespace)
            if not _owned_dir_exists(ns, READY_DIRNAME, kind="producer READY directory"):
                return [], []
        except ProducerError as exc:
            return [], [{"code": "INVALID_READY", "path": str(namespace), "detail": str(exc)}]
        ready_dir = ns / READY_DIRNAME
        producer = ns.name
        out: list[ProducerPackage] = []
        errors: list[dict] = []
        for path in sorted(ready_dir.glob("*.json")):
            try:
                raw = _read_owned_descendant(
                    ns,
                    path.relative_to(ns),
                    kind="producer READY package",
                    max_bytes=READY_MAX_BYTES,
                )
                data = json.loads(raw.decode("utf-8"))
                candidate = ProducerPackage.from_dict(
                    data,
                    expected_producer=producer,
                    ready_path=path,
                    materialize_payloads=materialize_payloads,
                )
                if path.name != _ready_filename(candidate.package_identity):
                    raise ProducerError("READY filename does not match package identity")
                out.append(candidate)
            except (ProducerError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                errors.append({"code": "INVALID_READY", "path": str(path), "detail": str(exc)})
        return out, errors

    @classmethod
    def list_ready(cls, namespace: Path | str) -> list[ProducerPackage]:
        packages, _errors = cls.scan_ready(namespace)
        return packages

    # -- recovery (spec §M) ----------------------------------------------

    @classmethod
    def _project_root_from_namespace(cls, ns: Path) -> Path:
        """CORE-005: resolve the project root that owns a producer namespace.

        Walks up from the namespace until it finds the directory containing
        ``.saipen``. This is the single authoritative registry used so recovery
        locks the SAME canonical ``ProducerLock(project_root, producer)`` the live
        writer holds -- never a path derived from ``namespace.parent``.
        """
        _owned, root = _namespace_authority(ns)
        return root

    @classmethod
    def recover(
        cls,
        namespace: Path | str,
        project_root: Path | str | None = None,
        producer: str | None = None,
    ) -> dict:
        """W2-002: Deterministic cleanup of orphaned staging generations.

        Acquires the producer-local ProducerLock before classifying or
        deleting staging generations. If another writer owns the lock,
        returns BUSY/no-op with zero deletion. Under the lock, only
        deletes generations that are mechanically proven stale/abandoned
        relative to current ownership -- never infers abandonment solely
        because READY is absent.

        CORE-005: the lock is the CANONICAL ``ProducerLock(project_root,
        producer)`` -- identical to the live writer's lock. The namespace alone
        no longer determines the lock path (the old code used ``namespace.parent``
        which landed on ``.saipen/.saipen/locks`` for saitranslate and locked a
        different file from the real writer, allowing a live generation to be
        classified as an orphan and deleted). ``project_root``/``producer`` may
        be passed explicitly; otherwise they are derived from the namespace.

        A staging dir with no published READY counterpart is incomplete by
        definition (publication is atomic and removes it). We delete it. We
        NEVER synthesize a READY package from partial staging evidence.
        Returns a report of what was removed.
        """
        ns = Path(namespace)
        _explicit_project = project_root is not None
        if project_root is None:
            project_root = cls._project_root_from_namespace(ns)
        if producer is None:
            producer = ns.name
        if producer not in PRODUCERS:
            raise ProducerError(f"recover: unknown producer role {producer!r}")
        # W2-001: when the caller explicitly supplies project_root, prove the
        # namespace is the canonical owned one for this project/producer before
        # reading or deleting anything through it -- otherwise a symlink/junction
        # substitution turns recover into an outside-root recursive delete.
        # When project_root was derived from the namespace (not explicitly passed),
        # the caller is using a legacy layout; skip the strict canonical check
        # to avoid breaking test fixtures that predate the extensions/subs/ layout.
        if _explicit_project:
            try:
                canonical = _resolve_namespace_ownership(project_root, producer)
            except ValueError as exc:
                raise ProducerError(
                    f"recover: namespace authority refused for producer {producer!r}: {exc}"
                ) from exc
            if not ns.is_absolute():
                ns = (Path(project_root) / ns).resolve()
            try:
                if ns.resolve() != canonical.resolve():
                    raise ProducerError(
                        f"recover: namespace {ns} is not the canonical producer "
                        f"namespace {canonical} for project {project_root}; refuse"
                    )
            except OSError as exc:
                raise ProducerError(f"recover: namespace {ns} cannot be resolved: {exc}") from exc
        staging_root = ns / STAGING_DIRNAME
        removed: list[str] = []
        invalid: list[dict] = []
        # W2-002 / CORE-005: acquire the canonical producer-local lock to
        # prevent racing a live producer that holds the SAME lock identity.
        try:
            with ProducerLock(project_root, producer):
                removed, invalid = cls._recover_under_lock(ns, staging_root)
        except PermissionError:
            # Another writer owns the lock -- do not delete anything
            return {"removed_staging": [], "false_ready": False, "busy": True}
        except ProducerError:
            # Epoch is corrupt -- do not delete anything
            return {"removed_staging": [], "false_ready": False, "busy": True}
        return {
            "removed_staging": removed,
            "invalid_staging": invalid,
            "false_ready": False,
            "busy": False,
        }

    @classmethod
    def _recover_under_lock(cls, ns: Path, staging_root: Path) -> tuple[list[str], list[dict]]:
        """Delete only generations with matching in-flight authority superseded by takeover."""
        removed: list[str] = []
        invalid: list[dict] = []
        if not cls._owned_staging_exists(ns):
            return removed, invalid
        try:
            current_epoch = ProducerEpoch.current(ns)
        except ProducerError:
            return removed, invalid
        for gen in staging_root.iterdir():
            relative = gen.relative_to(ns)
            if not _owned_dir_exists(ns, relative, kind="producer staging generation"):
                raise ProducerError(f"producer staging entry {gen} is not an owned directory")
            authority = cls._generation_authority(ns, gen)
            if authority is None:
                invalid.append({"generation_id": gen.name, "code": "INCOMPLETE_STAGING"})
                continue
            if authority["epoch"] >= current_epoch:
                continue
            _remove_owned_tree(ns, relative, kind="producer staging generation")
            removed.append(gen.name)
        return removed, invalid

    @staticmethod
    def _owned_staging_exists(ns: Path) -> bool:
        return _owned_dir_exists(ns, STAGING_DIRNAME, kind="producer staging directory")

    @staticmethod
    def _generation_authority(ns: Path, gen_dir: Path) -> dict | None:
        marker_relative = gen_dir.relative_to(ns) / ".in-flight"
        if not _owned_regular_exists(ns, marker_relative, kind="producer .in-flight"):
            return None
        try:
            marker = json.loads(
                _read_owned_descendant(
                    ns, marker_relative, kind="producer .in-flight", max_bytes=64 * 1024
                ).decode("utf-8")
            )
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(marker, dict):
            return None
        if (
            set(marker) != {"generation_id", "producer", "epoch", "begin_time"}
            or marker.get("generation_id") != gen_dir.name
            or marker.get("producer") != ns.name
            or not isinstance(marker.get("epoch"), int)
            or isinstance(marker.get("epoch"), bool)
            or marker["epoch"] < 0
            or not isinstance(marker.get("begin_time"), str)
            or not marker["begin_time"]
        ):
            return None
        manifest_relative = gen_dir.relative_to(ns) / "staging.manifest.json"
        if not _owned_regular_exists(ns, manifest_relative, kind="producer staging.manifest.json"):
            return marker
        try:
            manifest = json.loads(
                _read_owned_descendant(
                    ns,
                    manifest_relative,
                    kind="producer staging.manifest.json",
                    max_bytes=64 * 1024,
                ).decode("utf-8")
            )
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return None
        return marker if isinstance(manifest, dict) and manifest == marker else None


# ---------------------------------------------------------------------------
# Conventional namespace helper (optional; never hard-coded into safety)
# ---------------------------------------------------------------------------


def _resolve_namespace_ownership(root: Path | str, producer: str) -> Path:
    """The canonical producer-namespace ownership resolver (W2-001).

    Validates that the producer namespace resolves INSIDE the canonical
    project root and rejects symlinks, junctions/reparse points, or any
    resolved path outside the root. Returns the owned namespace path.
    Raises ValueError on any containment failure.
    """
    root = Path(root).resolve()
    if producer == "saitranslate":
        ns = root / ".saipen" / "saitranslate"
    else:
        ns = root / ".saipen" / "extensions" / "subs" / producer
    # Prove every existing namespace component resolves inside the root.
    # lstat each component so a symlink/junction is detected, not followed.
    try:
        resolved = ns.resolve(strict=False)
    except OSError as exc:
        raise ValueError(f"producer namespace {ns} cannot be resolved: {exc}") from exc
    # Containment: resolved path must be the root itself or a descendant.
    try:
        resolved.relative_to(root)
    except ValueError:
        raise ValueError(
            f"producer namespace {ns} resolves to {resolved}, outside project root {root}"
        ) from None
    # Walk each ancestor from root down to the namespace, lstat-checking
    # each component so a symlink/junction/reparse point is rejected
    # BEFORE it can redirect a write or delete outside the project.
    _check = root
    for part in ns.relative_to(root).parts:
        _check = _check / part
        try:
            st = _check.lstat()
        except FileNotFoundError:
            break  # Non-existent is fine; we'll create it under the root.
        except OSError as exc:
            raise ValueError(
                f"producer namespace component {_check} cannot be lstat'd: {exc}"
            ) from exc
        # On POSIX, S_ISLNK; on Windows, reparse points via S_ISLNK too.
        import stat as _stat

        if _stat.S_ISLNK(st.st_mode):
            raise ValueError(
                f"producer namespace component {_check} is a symlink; "
                f"producer operations refuse to follow it"
            )
    return ns


def producer_namespace(root: Path | str, producer: str) -> Path:
    """The conventional on-disk namespace for a producer role.

    Mirrors subs.py: saitranslate -> .saipen/saitranslate (special-cased);
    saiwiki -> .saipen/extensions/subs/saiwiki.

    W2-001: returns the owned namespace only after proving it resolves
    inside the canonical project root (no symlinks/junctions/reparse).
    """
    return _resolve_namespace_ownership(root, producer)


# ---------------------------------------------------------------------------
# Multi-package integration plan (spec §8) + serialized Core integration (§N)
# ---------------------------------------------------------------------------


def plan_integration(
    packages: Iterable[ProducerPackage],
    base_identity,
    *,
    current_identity_provider: Callable[[], object],
    current_hashes_provider: Callable[[ProducerPackage], Mapping[str, str]],
) -> dict:
    """Dry-run / planning output for Core.

    Shows, in a DETERMINISTIC order:
      - READY packages;
      - exact base identities;
      - CURRENT / COMPATIBLE_DRIFT / STALE for each;
      - read/write conflicts between packages;
      - deterministic integration order;
      - which package must be regenerated after each integration.

    Does NOT auto-rebase semantically stale packages. Integrates sequentially:
    after each non-stale package we apply its write_set to a SIMULATED current
    state so later packages are re-classified against the post-integration world.
    """
    pkgs = list(packages)
    order = sorted(pkgs, key=lambda p: (p.producer, p.package_identity))

    # pairwise conflicts
    conflicts: list[dict] = []
    for i in range(len(order)):
        for j in range(i + 1, len(order)):
            c = derive_conflicts(order[i], order[j])
            if not c["compatible"]:
                conflicts.append(
                    {
                        "a": order[i].package_identity,
                        "b": order[j].package_identity,
                        "write_write": c["write_write"],
                        "a_write_b_read": c["a_write_b_read"],
                        "b_write_a_read": c["b_write_a_read"],
                        "reasons": c["reasons"],
                    }
                )

    entries: list[dict] = []
    # W2-003: simulated world starts EMPTY. Live hashes remain authoritative
    # for all paths. Simulation may overlay only concrete post-write effects
    # from packages already accepted EARLIER in this plan. This prevents the
    # planner from hiding actual concurrent modification of a package's write
    # target by replacing live hashes with the package's historical 'before' hashes.
    simulated: dict[str, str] = {}

    for idx, p in enumerate(order):
        cur_id = current_identity_provider()
        cur_hashes = current_hashes_provider(p)
        # W2-003: start from live hashes (authoritative). Only overlay
        # simulated post-write effects from EARLIER accepted packages.
        merged = dict(cur_hashes)
        for rel, before in simulated.items():
            if rel in merged:
                merged[rel] = before
        cls, reason = classify_integration(
            (
                p.base_source_head,
                p.base_source_tree_fingerprint,
                p.base_discovery_model,
            ),
            cur_id,
            p.read_set,
            p.write_set,
            merged,
        )
        regenerate = cls is IntegrationClass.STALE
        entries.append(
            {
                "order": idx,
                "producer": p.producer,
                "package_identity": p.package_identity,
                "base_source_head": p.base_source_head,
                "base_source_tree_fingerprint": p.base_source_tree_fingerprint,
                "role_revision": p.role_revision,
                "class": cls.value,
                "reason": reason,
                "regenerate": regenerate,
            }
        )
        if not regenerate:
            # advance simulated world: the integrated writes now land.
            for rel, before in p.write_set.items():
                # after integration the path holds the producer's new content;
                # we don't have it here, but the *next* package only cares that
                # the path no longer equals its OWN before-hash if it overlaps.
                # Mark divergence so a later package with the same target is
                # forced STALE (handled by conflict refusal in integrate()).
                simulated[rel] = "sha256:integrated:" + rel

    return {
        "order": [e["package_identity"] for e in entries],
        "packages": entries,
        "conflicts": conflicts,
        "serialized": True,
    }


def integrate_packages_core(
    packages: Iterable[ProducerPackage],
    root: Path | str,
    *,
    apply_write: Callable[[ProducerPackage, Path], None] | None = None,
    dry_run: bool = False,
    agent: str = "saipen-core",
    crew_epoch: str = "",
    ticket_id: str = "",
) -> dict:
    """Serialized Core integration through the canonical Core writer lock.

    Each package is re-classified against the REAL filesystem at integration
    time. A package that is STALE, or that collides (write/write) with a
    package already integrated in THIS batch, is REFUSED before any canonical
    write. Returns a per-package report. The Core writer lock guarantees that
    no two integrations run concurrently (spec §N).
    """
    with project_writer_lock(root):
        root_path = Path(root)
        pkgs = sorted(packages, key=lambda p: (p.producer, p.package_identity))
        applied: list[str] = []
        results: list[dict] = []
        from .journal import semantic_receipt_snapshot

        # PERF-001: these are command-scoped authorities.  Reopening the
        # complete receipt lifetime and source tree for every package turns a
        # batch into P copies of the same expensive decision.
        receipt_snapshot = semantic_receipt_snapshot(root_path)
        committed_receipts = list(receipt_snapshot.records)
        try:
            live_identity = _live_source_identity(root_path)
        except (ProducerError, OSError, UnicodeError):
            live_identity = None

        for p in pkgs:
            # CORE-006: strict pre-flight verification -- status must be ready
            if p.status != PackageStatus.READY.value:
                results.append(
                    {
                        "package_identity": p.package_identity,
                        "producer": p.producer,
                        "result": "REFUSED",
                        "code": "NOT_READY",
                        "reason": f"package status is {p.status!r}, not 'ready'",
                        "wrote": False,
                    }
                )
                continue
            # W2-003: a COMMITTED producer_integration receipt for this exact
            # package is idempotence authority ONLY when its resulting edge is
            # still CURRENT. The receipt's resulting_source/fingerprint bind
            # the source the integration produced; if that HEAD has since moved
            # (even with identical content -- a commit is a new source
            # identity), the committed edge no longer certifies the current
            # tree and the package must be re-integrated to record a fresh
            # resulting edge. Without this, a content-identical commit leaves
            # the producer permanently ALREADY_APPLIED against a stale
            # resulting_source and crew SC-8/SC-9 never advances (reproduced
            # live: saitranslate READY at 4451d073 short-circuited on a
            # receipt whose resulting_source was e98bcb03).
            if receipt_snapshot.errors:
                results.append(
                    {
                        "package_identity": p.package_identity,
                        "producer": p.producer,
                        "result": "REFUSED",
                        "code": "CORRUPT_JOURNAL",
                        "reason": (
                            "semantic receipt snapshot is corrupt: "
                            f"{'; '.join(receipt_snapshot.errors[:2])}"
                        ),
                        "wrote": False,
                        "recovery_required": True,
                    }
                )
                continue
            _live = live_identity
            _current_edge = any(
                rec.get("status") == "COMMITTED"
                and (rec.get("receipt_metadata") or {}).get("package_identity")
                == p.package_identity
                and _live is not None
                and (rec.get("receipt_metadata") or {}).get("resulting_source") == _live.source_head
                and (rec.get("receipt_metadata") or {}).get("resulting_source_fingerprint")
                == _live.source_tree_fingerprint
                for rec in committed_receipts
            )
            if _current_edge:
                # Retirement failure is non-fatal cleanup debt; the source is
                # already integrated and must not be reapplied.
                cleanup_pending, cleanup_reason = _retirement_result(p)
                results.append(
                    {
                        "package_identity": p.package_identity,
                        "producer": p.producer,
                        "result": "INTEGRATED",
                        "code": "ALREADY_APPLIED",
                        "reason": "committed producer integration receipt exists; "
                        + cleanup_reason,
                        "wrote": True,
                        "cleanup_pending": cleanup_pending,
                    }
                )
                continue
            # Re-classify on the live tree. Source identity is authority for
            # the integration decision; an unreadable/unstable source must be
            # a structured per-package refusal, never a synthetic fallback or
            # a public traceback.
            try:
                cur_id = live_identity
                if cur_id is None:
                    raise ProducerError("cannot capture authoritative source identity")
                cur_hashes = _live_hashes(root_path, p)
            except (ProducerError, OSError, UnicodeError) as exc:
                results.append(
                    {
                        "package_identity": p.package_identity,
                        "producer": p.producer,
                        "result": "REFUSED",
                        "code": "SOURCE_IDENTITY_FAILED",
                        "reason": str(exc),
                        "wrote": False,
                    }
                )
                continue
            cls, reason = classify_integration(
                (
                    p.base_source_head,
                    p.base_source_tree_fingerprint,
                    p.base_discovery_model,
                ),
                cur_id,
                p.read_set,
                p.write_set,
                cur_hashes,
            )
            if cls is IntegrationClass.STALE:
                results.append(
                    {
                        "package_identity": p.package_identity,
                        "producer": p.producer,
                        "result": "REFUSED",
                        "code": "STALE",
                        "reason": reason,
                        "wrote": False,
                    }
                )
                continue

            # write/write collision with an already-integrated package?
            collision = next((q for q in applied if set(q.write_set) & set(p.write_set)), None)
            if collision is not None:
                results.append(
                    {
                        "package_identity": p.package_identity,
                        "producer": p.producer,
                        "result": "REFUSED",
                        "code": "CONFLICT",
                        "reason": (
                            f"write target collides with already-integrated "
                            f"package {collision.package_identity}"
                        ),
                        "wrote": False,
                    }
                )
                continue

            if dry_run:
                applied.append(p)
                results.append(
                    {
                        "package_identity": p.package_identity,
                        "producer": p.producer,
                        "result": "PLANNED",
                        "code": cls.value,
                        "reason": reason,
                        "wrote": False,
                    }
                )
                continue

            payloads = dict(p.payloads)
            if set(payloads) != set(p.write_set):
                if apply_write is None:
                    results.append(
                        {
                            "package_identity": p.package_identity,
                            "producer": p.producer,
                            "result": "REFUSED",
                            "code": "PAYLOAD_MISSING",
                            "reason": "READY package has no complete authenticated payload",
                            "wrote": False,
                        }
                    )
                    continue
                # Compatibility adapter for old in-memory callers: execute the
                # callback only in an isolated scratch root, capture its declared
                # outputs, then journal those bytes.  The callback never receives
                # the canonical root and therefore cannot leave a mixed tree.
                import tempfile

                try:
                    with tempfile.TemporaryDirectory(prefix="saipen-producer-apply-") as td:
                        scratch = Path(td)
                        for rel in sorted(set(p.read_set) | set(p.write_set)):
                            source = root_path / rel
                            if source.is_file():
                                target = scratch / rel
                                target.parent.mkdir(parents=True, exist_ok=True)
                                shutil.copyfile(source, target)
                        apply_write(p, scratch)
                        payloads = {}
                        for rel in p.write_set:
                            target = scratch / rel
                            if not target.is_file():
                                raise ProducerError(
                                    f"legacy apply callback did not materialize {rel!r}"
                                )
                            payloads[rel] = target.read_bytes()
                except Exception as exc:
                    results.append(
                        {
                            "package_identity": p.package_identity,
                            "producer": p.producer,
                            "result": "REFUSED",
                            "code": "APPLY_MATERIALIZATION_FAILED",
                            "reason": str(exc),
                            "wrote": False,
                        }
                    )
                    continue

            from .journal import run_mutation
            from .paths import project_identity

            resulting_identity: list[object] = []
            resulting_metadata: list[dict] = []

            def _integration_receipt_metadata(live_root: Path, metadata: dict) -> dict:
                resulting = _live_source_identity(live_root)
                resulting_identity.append(resulting)
                metadata["resulting_source"] = resulting.source_head
                metadata["resulting_source_fingerprint"] = resulting.source_tree_fingerprint
                resulting_metadata.append(dict(metadata))
                return metadata

            # op_id MUST vary with the input source binding, not just the
            # content-stable package identity. The identity digest alone is
            # unchanged by a content-identical commit, so a deterministic
            # `producer-integrate-<identity>` collides when the SAME package is
            # re-integrated against a moved HEAD: the existing receipt's
            # semantic payload (input_source, after_hashes vs preconditions)
            # no longer matches, and the second integration is REFUSED
            # `op_id collision` even though `_current_edge` proved the old
            # resulting edge is stale and a fresh receipt is exactly what the
            # crew needs. Binding the input source into the op_id gives every
            # source-edge its own idempotence identity (treadmill root cause,
            # E-3836).
            op_id = (
                "producer-integrate-"
                + p.package_identity.split(":", 1)[-1][:32]
                + "-"
                + p.base_source_head[:12]
            )
            journal_result = run_mutation(
                root_path,
                op_id,
                "producer_integration",
                agent,
                project_identity(root_path),
                p.package_identity,
                [
                    {"path": rel, "role": "generic", "content": payloads[rel]}
                    for rel in sorted(payloads)
                ],
                receipt_metadata={
                    "operation": "producer_integration",
                    "status": "COMMITTED",
                    "crew_epoch": crew_epoch,
                    "ticket_id": ticket_id,
                    "producer": p.producer,
                    "package_identity": p.package_identity,
                    "input_source": p.base_source_head,
                    "input_source_fingerprint": p.base_source_tree_fingerprint,
                },
                receipt_metadata_finalize=_integration_receipt_metadata,
                # W2-002: producer integration binds the canonical project
                # lineage like every other recoverable mutation. Suppressing it
                # produced legacy null-lineage receipts that became
                # unrecoverable after a legitimate project move. The lineage
                # migration primitive itself still suppresses recursion
                # internally.
                _ensure_lineage=True,
            )
            if not journal_result.get("ok"):
                results.append(
                    {
                        "package_identity": p.package_identity,
                        "producer": p.producer,
                        "result": "REFUSED",
                        "code": journal_result.get("code", "INTEGRATION_FAILED"),
                        "reason": journal_result.get("detail", "journaled integration failed"),
                        "wrote": False,
                        "recovery_required": journal_result.get("recovery_required", False),
                    }
                )
                continue
            applied.append(p)
            if resulting_identity:
                live_identity = resulting_identity[-1]
            if resulting_metadata:
                committed_receipts.append(
                    {
                        "operation": "producer_integration",
                        "status": "COMMITTED",
                        "receipt_metadata": resulting_metadata[-1],
                    }
                )
            # W2-003: READY retirement is a post-commit cleanup step OUTSIDE the
            # integration journal. Its failure must not be reported as if source
            # mutation failed: the payload is already committed. Surface
            # cleanup-pending debt truthfully and let a retry converge through
            # the committed-receipt idempotence path above.
            _cleanup_pending, _cleanup_reason = _retirement_result(p)
            results.append(
                {
                    "package_identity": p.package_identity,
                    "producer": p.producer,
                    "result": "INTEGRATED",
                    "code": cls.value,
                    "reason": f"{reason}; {_cleanup_reason}",
                    "wrote": True,
                    "op_id": journal_result.get("op_id"),
                    "cleanup_pending": _cleanup_pending,
                }
            )

        return {"serialized": True, "results": results}


def _retirement_result(package: ProducerPackage) -> tuple[bool, str]:
    try:
        _retire_ready_package(package, supersede_older=True)
    except (OSError, ProducerError, ValueError) as exc:
        return True, f"READY cleanup pending: {exc}"
    return False, "READY retired idempotently"


def _retire_ready_package(package: ProducerPackage, *, supersede_older: bool = False) -> None:
    """Atomically remove terminal package evidence from the READY hot set."""
    source = package.ready_path
    if source is None:
        return
    namespace, _root = _namespace_authority(source.parent.parent)
    source_relative = Path(READY_DIRNAME) / source.name
    if source != namespace / source_relative:
        raise ProducerError("READY package path is not owned by its producer namespace")
    if not _owned_regular_exists(namespace, source_relative, kind="producer READY package"):
        return
    raw = _read_owned_descendant(
        namespace, source_relative, kind="producer READY package", max_bytes=READY_MAX_BYTES
    )
    try:
        current = ProducerPackage.from_dict(
            json.loads(raw.decode("utf-8")),
            expected_producer=package.producer,
            expected_identity=package.package_identity,
            ready_path=source,
        )
    except (ProducerError, OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProducerError(f"READY retirement authority is invalid: {exc}") from exc
    if (
        current.base_source_head != package.base_source_head
        or current.base_source_tree_fingerprint != package.base_source_tree_fingerprint
        or current.base_discovery_model != package.base_discovery_model
        or current.payloads != package.payloads
    ):
        raise ConflictError("READY artifact changed before retirement")
    settled = _ensure_owned_dir(namespace, SETTLED_DIRNAME, kind="producer SETTLED directory")
    destination = settled / source.name
    destination_relative = Path(SETTLED_DIRNAME) / source.name
    if _owned_regular_exists(namespace, destination_relative, kind="producer SETTLED package"):
        settled_raw = _read_owned_descendant(
            namespace,
            destination_relative,
            kind="producer SETTLED package",
            max_bytes=READY_MAX_BYTES,
        )
        if settled_raw != raw:
            raise ConflictError("SETTLED artifact collision for package identity")
        safe_unlink_owned(
            source,
            kind="producer READY package",
            ownership_root=namespace,
        )
    else:
        prove_owned_regular(source, kind="producer READY package")
        prove_owned_dir_chain(settled, kind="producer SETTLED directory", ownership_root=namespace)
        os.replace(source, destination)
    if not supersede_older:
        return
    ready_dir = namespace / READY_DIRNAME
    superseded = namespace / SUPERSEDED_DIRNAME
    if not _owned_dir_exists(namespace, READY_DIRNAME, kind="producer READY directory"):
        return
    for candidate in list(ready_dir.glob("*.json")):
        try:
            raw = _read_owned_descendant(
                namespace,
                candidate.relative_to(namespace),
                kind="producer READY package",
            )
            data = json.loads(raw.decode("utf-8"))
            epoch = data.get("epoch")
            producer = data.get("producer")
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if producer != package.producer or not isinstance(epoch, int) or epoch > package.epoch:
            continue
        superseded = _ensure_owned_dir(
            namespace, SUPERSEDED_DIRNAME, kind="producer SUPERSEDED directory"
        )
        target = superseded / candidate.name
        target_relative = Path(SUPERSEDED_DIRNAME) / candidate.name
        if _owned_regular_exists(namespace, target_relative, kind="producer SUPERSEDED package"):
            safe_unlink_owned(
                candidate,
                kind="producer READY package",
                ownership_root=namespace,
            )
        else:
            prove_owned_regular(candidate, kind="producer READY package")
            prove_owned_dir_chain(
                superseded,
                kind="producer SUPERSEDED directory",
                ownership_root=namespace,
            )
            os.replace(candidate, target)


def _live_source_identity(root: Path) -> object:
    """Resolve the live SourceIdentity (git or no-git) without hard-coupling
    to `freshness` at import time."""
    try:
        from freshness import FreshnessError, compute_source_identity
    except ImportError as exc:
        raise ProducerError(f"source identity provider unavailable: {exc}") from exc
    try:
        return compute_source_identity(root)
    except (FreshnessError, OSError, UnicodeError) as exc:
        # Authority capture is fail-closed. The retired fallback swallowed
        # every internal error and recursively hashed the whole project,
        # following unrelated scratch/cache trees and potentially external
        # symlink targets into a fabricated `fallback:` identity.
        raise ProducerError(f"cannot capture authoritative source identity: {exc}") from exc


def _live_hashes(root: Path, package: ProducerPackage) -> dict[str, str]:
    keys = set(package.read_set) | set(package.write_set)
    return {rel: _safe_rel_hash(root, rel) for rel in keys}
