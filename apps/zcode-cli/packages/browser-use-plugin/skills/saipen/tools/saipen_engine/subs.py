"""SubSaipen lifecycle operations on the common machinery (NITRO M8, SAICREW).

Mechanizes the DETERMINISTIC parts of the SubSaipen lifecycle (extensions/subs/
PROTOCOL.md section 7): manifest parsing, spawn, list, status, adopt, pause,
resume, sync, evidence-gated clean, INTAKE (sub collect), Core DISPOSITION
(sub dispose), and the one built-in crew registry the crew planner/gate/docs/
tests all consume.

The mechanical truth contract (SAICREW):

- ONE strict MANIFEST parser is used by every consumer (list/status/collect/
  spawn/adopt/sync/crew/validator). A malformed manifest is INVALID_MANIFEST,
  never "skip bad line and continue".
- KNOWN INVALID BASE MUST NOT BE MUTATED: every predictable spawn
  prerequisite (strict MANIFEST grammar, shared-contract sync PLAN, TEMPLATE,
  role evidence, proposed MANIFEST/STATE/BOARD grammar) is validated READ-ONLY
  before any write; dry-run consumes the SAME plans/verdicts as APPLY, so a
  refusal APPLY would reach is always visible to --dry-run.
- The PROJECT-LOCAL charter (`.saipen/extensions/subs/<name>.md`) is the only
  role-revision authority for an attached project. The installation charter is
  only the `saipen sub sync` source. Missing local evidence is
  SYNC_REQUIRED / ROLE_EVIDENCE_UNAVAILABLE, never a silent fallback.
- A generic `sai*` worker's role_revision is the deterministic digest of the
  project-local PROTOCOL.md (never blank).
- INTAKE != REVIEW (Wave 2): `sub collect` only queues the hypothesis as an
  ordinary Core review ticket with a durable collect receipt binding package
  identity -> ticket; the package stays READY. `sub dispose` writes the
  `reviewed` claim ONLY after the linked Core ticket is terminal. Health
  derivation reports REVIEW_PENDING between the two, never CURRENT.
- `sub clean` performs evidence-gated DELETION (archive, unregister, remove)
  after a deterministic blocker scan; `sub clean --dry-run`/preflight are the
  read-only windows into that same evidence.
- Every mutating sub command honors `dry_run`: same validation, same proposed
  outcome, ZERO writes/LOG/STATE/MANIFEST/journal. Successful dry-run results
  use plan codes (SUB_*_PLAN) with `would_result`, never a past-tense success.
- Board/STATE are validated as one coherent machine: DONE cannot coexist with
  TODO/DOING/unresolved BLOCKED, duplicate headings/IDs fail, at most one
  DOING, checkbox matches section.
- `sub list`/`sub status` report mechanically-derived health, never a
  timestamp or an empty OUTBOX dressed up as clean.

NO semantic acceptance of a finding is mechanized. Core still judges work;
this module guarantees boundaries and mechanics.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import stat
import struct
from dataclasses import dataclass, field
from pathlib import Path

from . import codec
from .applicability import ALWAYS as APPLICABILITY_ALWAYS
from .applicability import VISUAL_SURFACE as APPLICABILITY_VISUAL_SURFACE
from .journal import empty_delete_tree_hash, hash_bytes, hash_delete_tree, hash_tree, run_mutation
from .lock import project_writer_lock
from .paths import project_identity
from .result import Result
from .safeid import prove_inside, validate_safe_id
from .state import patch_state

SUBS_REL = ".saipen/extensions/subs"
MANIFEST_REL = f"{SUBS_REL}/MANIFEST.md"
MANIFEST_HEADER = "# SubSaipen Manifest"
MANIFEST_METADATA = frozenset({"last_collect"})

# Shared inherited contract files (PROTOCOL.md section 7): the exact surface
# `saipen sub sync` refreshes from <saipen_home>/extensions/subs/. A live
# instance's own STATE/BOARD/LOG/kitchen is NEVER part of this surface, and
# _shared/inbox.md is created once then preserved byte-identically.
_SHARED_FILES = ("PROTOCOL.md", "README.md", "crew.md")
_SHARED_DIRS = ("TEMPLATE",)

OUTBOX_STATUSES = ("ready", "draft", "blocked", "reviewed", "stale")


# ---------------------------------------------------------------------------
# Built-in crew registry -- ONE machine-readable contract (SAICREW section M).
# Used by the crew planner, crew gate, docs parity and tests. Custom subs are
# standalone by default; the crew never runs every arbitrary `sai*` worker.
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class CrewRole:
    name: str
    role_class: str
    runtime_kind: str
    ticket_prefix: str
    ensure_instance: bool
    collect_policy: str
    stage: str
    evidence_kind: str
    outbox_path: str
    #: Which deterministic project fact decides whether this role has anything
    #: to apply to (T-1279). A name from `applicability.PROBES`; `always` means
    #: the role declares no condition and is never skipped. An unknown name
    #: resolves APPLICABLE, so a typo can never silently retire a capability.
    applicability: str = APPLICABILITY_ALWAYS


CREW_ROLES = (
    CrewRole(
        "saihunt",
        "core-review",
        "generic-sub",
        "HUNT",
        True,
        "core-review",
        "SC-2",
        "sensor",
        f"{SUBS_REL}/saihunt/kitchen/OUTBOX.md",
    ),
    CrewRole(
        "saitest",
        "core-review",
        "generic-sub",
        "TEST",
        True,
        "core-review",
        "SC-3",
        "sensor",
        f"{SUBS_REL}/saitest/kitchen/OUTBOX.md",
    ),
    CrewRole(
        "saipython",
        "core-review",
        "generic-sub",
        "PY",
        True,
        "core-review",
        "SC-4",
        "sensor",
        f"{SUBS_REL}/saipython/kitchen/OUTBOX.md",
    ),
    CrewRole(
        "saiui",
        "core-review",
        "generic-sub",
        "UI",
        True,
        "core-review",
        "SC-5",
        "sensor",
        f"{SUBS_REL}/saiui/kitchen/OUTBOX.md",
        # The only built-in with a condition today. Eleven consecutive empty
        # packages against a tree with zero visual files is not a sensor
        # finding nothing; it is a sensor with nothing to look at, and the
        # difference is exactly what this probe makes reportable.
        applicability=APPLICABILITY_VISUAL_SURFACE,
    ),
    CrewRole(
        "saitranslate",
        "producer",
        "specialized-translate",
        "SAIT",
        False,
        "explicit",
        "SC-8",
        "translation",
        ".saipen/saitranslate/kitchen/OUTBOX.md",
    ),
    CrewRole(
        "saiwiki",
        "producer",
        "generic-sub",
        "W",
        True,
        "explicit",
        "SC-9",
        "wiki",
        f"{SUBS_REL}/saiwiki/kitchen/OUTBOX.md",
    ),
)
ROLE_REGISTRY = {role.name: role for role in CREW_ROLES}
CREW_SENSORS = tuple(role.name for role in CREW_ROLES if role.role_class == "core-review")
CREW_PRODUCERS = tuple(role.name for role in CREW_ROLES if role.role_class == "producer")
CREW_REGISTRY = CREW_ROLES

# The serial full-platoon convergence circuit (SAICREW sections O/P). One
# immutable record per stage: (id, name, human condition prose, owner_kind,
# condition_key). The machine evaluator dispatches ONLY on condition_key and
# owner_kind -- the prose column is display, never machine truth (Wave 2 item
# 10: a stage description may explain, it may not silently redefine the
# condition). Docs parity checks id, name, owner_kind and condition_key, so a
# doc that redefines a condition is mechanically detectable.
CREW_STAGES = (
    (
        "SC-0",
        "recover-sync",
        "no unresolved recovery; shared contract surface current; strict MANIFEST",
        "CORE",
        "CORE_RECOVERY_CURRENT",
    ),
    ("SC-1", "instances", "required durable crew instances exist", "CORE", "ROSTER_CURRENT"),
    (
        "SC-2",
        "saihunt",
        "saihunt board valid, no pending work, current evidence",
        "SENSOR",
        "SENSOR_EVIDENCE_CURRENT",
    ),
    (
        "SC-3",
        "saitest",
        "saitest board valid, no pending work, current evidence",
        "SENSOR",
        "SENSOR_EVIDENCE_CURRENT",
    ),
    (
        "SC-4",
        "saipython",
        "saipython board valid, no pending work, current evidence",
        "SENSOR",
        "SENSOR_EVIDENCE_CURRENT",
    ),
    (
        "SC-5",
        "saiui",
        "saiui board valid, no pending work, current evidence",
        "SENSOR",
        "SENSOR_EVIDENCE_CURRENT",
    ),
    (
        "SC-6",
        "core-collect",
        "each core-review package durably ingested; reviewed claim only after "
        "the linked Core ticket is terminal (INTAKE != REVIEW)",
        "CORE",
        "SENSOR_INTAKE_DISPOSED",
    ),
    (
        "SC-7",
        "core-converge",
        "canonical Core convergence verdict current against one source identity; "
        "working tree fully attributed",
        "CORE",
        "CORE_CONVERGENCE_CURRENT",
    ),
    (
        "SC-8",
        "saitranslate",
        "EE prepared AND integrated",
        "PRODUCER",
        "PRODUCER_INTEGRATION_CURRENT",
    ),
    ("SC-9", "saiwiki", "QQ prepared AND integrated", "PRODUCER", "PRODUCER_INTEGRATION_CURRENT"),
    (
        "SC-10",
        "final-fixed-point",
        "all crew evidence re-verified after producer integration",
        "CORE_AND_SENSORS",
        "FINAL_FIXED_POINT_CURRENT",
    ),
    (
        "SC-11",
        "ship",
        "exactly one COMMITTED verified release binds the epoch",
        "RELEASE_EXECUTOR",
        "RELEASE_VERIFIED",
    ),
    (
        "SC-12",
        "post-ship",
        "post-ship certification bound to the shipped HEAD",
        "CORE",
        "POST_SHIP_CERTIFIED",
    ),
    (
        "SC-13",
        "finalize",
        "canonical finalizer clears crew target; final --gate crew passes",
        "CORE_FINALIZER",
        "CREW_FINALIZED",
    ),
)

# ---------------------------------------------------------------------------
# Health vocabulary -- mechanical state, never subjective quality.
# ---------------------------------------------------------------------------
HEALTH_CURRENT = "CURRENT"
HEALTH_WORK_PENDING = "WORK_PENDING"
HEALTH_READY_FOR_REVIEW = "READY_FOR_REVIEW"
HEALTH_REVIEW_PENDING = "REVIEW_PENDING"
HEALTH_BLOCKED = "BLOCKED"
HEALTH_STALE = "STALE"
HEALTH_INVALID = "INVALID"
HEALTH_NOT_RUN = "NOT_RUN"


def _utc_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%d.%m.%y %H:%M")


def _refuse(code: str, detail: str = "", **extra) -> Result:
    return Result(ok=False, code=code, message=detail, data=extra)


def _reject_reparse_ancestors(root: Path, path: Path) -> None:
    """Fail when an owned path would traverse a symlink or junction."""
    root = root.absolute()
    path = path.absolute()
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"owned path {path} escapes project root {root}") from exc
    current = root
    for part in relative.parts:
        current /= part
        if not os.path.lexists(current):
            continue
        info = current.lstat()
        attributes = getattr(info, "st_file_attributes", 0)
        if current.is_symlink() or attributes & 0x400:
            raise ValueError(f"owned path traverses symlink or reparse point: {current}")


def _sub_dir(project_root: Path, name: str) -> Path:
    """The instance dir for a subSaipen, path-safe and inside the owner root.

    The name is validated through the shared safe-ID primitive and the
    resolved path is proven inside `.saipen/extensions/subs/` before use --
    no `..`, separators, drive/absolute forms or control characters can
    escape the owner root.
    """
    safe = validate_safe_id(name, kind="subSaipen name")
    root = Path(project_root).resolve()
    owner_path = Path(project_root) / SUBS_REL
    prove_inside(owner_path, root, kind="SubSaipen owner root")
    _reject_reparse_ancestors(Path(project_root), owner_path)
    owner = owner_path.resolve()
    path = Path(project_root) / SUBS_REL / safe
    prove_inside(path, owner, kind="subSaipen instance")
    _reject_reparse_ancestors(Path(project_root), path)
    return path


def _read_maybe(path: Path) -> str:
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8-sig")


def _read_bytes_maybe(path: Path) -> bytes | None:
    try:
        return path.read_bytes()
    except OSError:
        return None


def _captured_hash(raw: bytes | None) -> str:
    return hash_bytes(raw) if raw is not None else ""


def _decode_captured(raw: bytes | None, label: str) -> str:
    if raw is None:
        return ""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError(f"{label} is not UTF-8: {exc}") from exc


def _role_revision_from_bytes(raw: bytes, *, generic: bool) -> str:
    canonical = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    magic = b"saipen-generic-role-revision-v1\0"
    if not generic:
        lines = canonical.splitlines(keepends=True)
        body = []
        in_yaml = False
        removed = 0
        for line in lines:
            stripped = line.strip()
            if stripped == b"```yaml" and not in_yaml:
                in_yaml = True
            elif stripped == b"```" and in_yaml:
                in_yaml = False
            elif in_yaml and line.lstrip().startswith(b"role_revision:"):
                removed += 1
                continue
            body.append(line)
        if removed != 1:
            raise ValueError(f"role charter must contain one role_revision; found {removed}")
        canonical = b"".join(body)
        magic = b"saipen-role-revision-v1\0"
    digest = hashlib.sha256()
    digest.update(magic)
    digest.update(struct.pack(">Q", len(canonical)))
    digest.update(canonical)
    return "sha256:" + digest.hexdigest()


def _sources_unchanged(targets: list[dict]) -> bool:
    return all(
        _captured_hash(_read_bytes_maybe(Path(target["source_path"]))) == target["source_hash"]
        for target in targets
        if target.get("source_path")
    )


def _external_read_preconditions(targets: list[dict]) -> dict[str, str]:
    return {
        target["source_path"]: target["source_hash"]
        for target in targets
        if target.get("source_path")
    }


# ---------------------------------------------------------------------------
# ONE strict MANIFEST parser (SAICREW section B). Every consumer -- list,
# status, spawn, adopt, collect, sync, crew, validator -- parses the manifest
# through this function. Malformed input is INVALID_MANIFEST, never a skipped
# line.
# ---------------------------------------------------------------------------
_ENTRY_RE = re.compile(r"^(.+?) -- (\S+)$")
_META_RE = re.compile(r"^([a-z_][a-z0-9_]*):\s*(.*)$")
_ISO_Z_RE = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"
LAST_COLLECT_RE = re.compile(rf"^(?:sha256:[0-9a-f]{{64}}@)?{_ISO_Z_RE}$")


@dataclass(frozen=True)
class ManifestEntry:
    name: str
    path: str
    metadata: dict = field(default_factory=dict)


def parse_manifest(text: str) -> tuple[list[ManifestEntry], list[str]]:
    """Strict MANIFEST.md parser.

    Returns (entries, errors). Any error makes the manifest unusable: callers
    MUST refuse with INVALID_MANIFEST. Accepted shape:

        # SubSaipen Manifest
        - <name> -- .saipen/extensions/subs/<name>/ | meta: value

    Only the current project-local path is legal. Metadata is a closed schema:
    optional `last_collect` only, once, with either an ISO-8601 UTC value or
    the immutable collected-package identity joined to that time.
    """
    text = text.replace("\r\n", "\n")
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines or lines[0].strip() != MANIFEST_HEADER:
        return [], [f"MANIFEST must open with exactly `{MANIFEST_HEADER}`"]
    entries: dict[str, ManifestEntry] = {}
    errors: list[str] = []
    for line_no, line in enumerate(lines[1:], 2):
        stripped = line.strip()
        if not stripped.startswith("- "):
            errors.append(
                f"MANIFEST.md:{line_no} non-entry line {stripped!r} -- the "
                "strict manifest admits only `- <name> -- <path>` entry lines"
            )
            continue
        content = stripped[2:].strip()
        parts = content.split("|")
        head = parts[0].strip()
        match = _ENTRY_RE.match(head)
        if not match:
            errors.append(f"MANIFEST.md:{line_no} entry {head!r} is not `<name> -- <path>`")
            continue
        name, path = match.group(1).strip(), match.group(2).strip()
        try:
            name = validate_safe_id(name, kind="subSaipen name")
        except ValueError as exc:
            errors.append(f"MANIFEST.md:{line_no} invalid name {name!r}: {exc}")
            continue
        canonical = f"{SUBS_REL}/{name}/"
        if path != canonical:
            errors.append(
                f"MANIFEST.md:{line_no} path {path!r} for {name!r} does not "
                f"map exactly to {canonical} -- legacy, absolute, traversal, "
                "alias and arbitrary paths are forbidden"
            )
            continue
        metadata: dict[str, str] = {}
        for part in parts[1:]:
            meta_match = _META_RE.match(part.strip())
            if not meta_match:
                errors.append(
                    f"MANIFEST.md:{line_no} unparseable metadata "
                    f"{part.strip()!r} -- metadata must be explicit "
                    "`key: value` tokens"
                )
                continue
            key, value = meta_match.group(1), meta_match.group(2).strip()
            if key not in MANIFEST_METADATA:
                errors.append(
                    f"MANIFEST.md:{line_no} unknown metadata {key!r}; allowed: "
                    + ", ".join(sorted(MANIFEST_METADATA))
                )
                continue
            if key in metadata:
                errors.append(f"MANIFEST.md:{line_no} duplicate metadata {key!r}")
                continue
            if not LAST_COLLECT_RE.fullmatch(value):
                errors.append(
                    f"MANIFEST.md:{line_no} {key} must be ISO-8601 UTC or "
                    "sha256:<64>@<ISO-8601 UTC>"
                )
                continue
            metadata[key] = value
        if name in entries:
            errors.append(f"MANIFEST.md:{line_no} duplicate entry for {name!r}")
            continue
        if any(path == entry.path for entry in entries.values()):
            errors.append(f"MANIFEST.md:{line_no} duplicate path {path!r}")
            continue
        entries[name] = ManifestEntry(name=name, path=path, metadata=metadata)
    if errors:
        return [], errors
    return list(entries.values()), []


def parse_manifest_file(project_root: Path | str) -> tuple[list[ManifestEntry], list[str]]:
    """Read + strictly parse the project's MANIFEST.md."""
    root = Path(project_root)
    manifest = root / MANIFEST_REL
    if not manifest.is_file():
        return [], [
            "no MANIFEST.md; crew first-run bootstrap requires current shared contract "
            "followed by first durable role spawn (`saipen sub spawn <name>` creates the registry)"
        ]
    return parse_manifest(_read_maybe(manifest))


def _entry_dir(root: Path, entry: ManifestEntry) -> Path:
    path = root / entry.path.rstrip("/")
    prove_inside(path, (root / SUBS_REL).resolve(), kind="manifest subSaipen path")
    return path


def _registered_entry(
    root: Path, name: str
) -> tuple[bytes | None, ManifestEntry | None, list[str]]:
    raw = _read_bytes_maybe(root / MANIFEST_REL)
    if raw is None:
        return None, None, ["no MANIFEST.md"]
    try:
        entries, errors = parse_manifest(_decode_captured(raw, MANIFEST_REL))
    except ValueError as exc:
        return raw, None, [str(exc)]
    entry = next((candidate for candidate in entries if candidate.name == name), None)
    if not errors and entry is None:
        errors = [f"{name!r} is not registered in MANIFEST.md"]
    return raw, entry, errors


# ---------------------------------------------------------------------------
# Shared-contract surface (SAICREW section C). `_bootstrap_needed()` was
# "directory exists", which cannot distinguish a partial bootstrap from a
# complete one; `shared_contract_status()` reports the exact truth.
# ---------------------------------------------------------------------------
def _shared_contract_source(saipen_home: str) -> tuple[list[dict], list[dict], str | None]:
    """Return file targets plus exact file/directory source inventory.

    The source is a CLOSED mandatory inventory (T-1003 sweep): PROTOCOL.md,
    README.md, crew.md, the complete TEMPLATE required surface and every
    built-in CREW_ROLES charter MUST exist. Absence in a broken source is
    NEVER evidence that a shipped contract was deliberately removed -- a
    missing required source refuses with INVALID_SOURCE_HOME and zero writes.
    """
    src = Path(saipen_home) / "extensions" / "subs"
    required = [*_SHARED_FILES, *(f"{role.name}.md" for role in CREW_ROLES)]
    missing = [name for name in required if not (src / name).is_file()]
    template_required = ("STATE.md", "BOARD.md", "LOG.md", "kitchen/OUTBOX.md")
    missing_template = [
        f"TEMPLATE/{path}" for path in template_required if not (src / "TEMPLATE" / path).is_file()
    ]
    if missing or missing_template:
        return (
            [],
            [],
            (
                "INVALID_SOURCE_HOME: saipen_home "
                f"{saipen_home!r} is missing required shared-contract source: "
                + ", ".join(missing + missing_template)
                + "; refresh the install before syncing -- absence in a broken "
                "source is not deletion authority"
            ),
        )
    targets: list[dict] = []
    inventory: list[dict] = []

    def add(source: Path, rel: str) -> None:
        try:
            info = source.lstat()
        except OSError as exc:
            raise ValueError(f"shared source {rel} unreadable: {exc}") from exc
        attributes = getattr(info, "st_file_attributes", 0)
        if source.is_symlink() or attributes & 0x400 or not stat.S_ISREG(info.st_mode):
            raise ValueError(f"shared source {rel} is not a regular file")
        raw = source.read_bytes()
        targets.append(
            {
                "path": f"{SUBS_REL}/{rel}",
                "content": raw,
                "source_path": str(source.resolve()),
                "source_hash": hash_bytes(raw),
            }
        )
        inventory.append({"path": rel, "kind": "file", "source_hash": hash_bytes(raw)})

    def add_directory(directory: Path, rel: str) -> None:
        digest = hash_delete_tree(directory)
        if not digest.startswith("delete-tree-sha256:"):
            raise ValueError(f"shared source directory {rel} is unsafe: {digest}")
        inventory.append({"path": rel, "kind": "directory", "source_hash": digest})

    try:
        for name in _SHARED_FILES:
            source = src / name
            if source.is_file():
                add(source, name)
        for dirname in _SHARED_DIRS:
            directory = src / dirname
            if not directory.is_dir():
                continue
            directories = []
            for current, dirnames, filenames in os.walk(directory, topdown=True, followlinks=False):
                dirnames.sort()
                filenames.sort()
                current_path = Path(current)
                directories.append(current_path)
                for child in dirnames:
                    candidate = current_path / child
                    info = candidate.lstat()
                    attributes = getattr(info, "st_file_attributes", 0)
                    if (
                        candidate.is_symlink()
                        or attributes & 0x400
                        or not stat.S_ISDIR(info.st_mode)
                    ):
                        raise ValueError(f"shared source directory is unsafe: {candidate}")
                for filename in filenames:
                    source = current_path / filename
                    add(source, source.relative_to(src).as_posix())
            for source_dir in directories:
                add_directory(source_dir, source_dir.relative_to(src).as_posix())
        for charter in sorted(src.glob("sai*.md")):
            add(charter, charter.name)
    except (OSError, ValueError) as exc:
        return [], [], str(exc)
    inventory.sort(key=lambda item: (item["path"], item["kind"]))
    targets.sort(key=lambda item: item["path"])
    return targets, inventory, None


def _shared_contract_targets(saipen_home: str) -> tuple[list[dict], str | None]:
    """Compatibility wrapper for callers that only need inherited files."""
    targets, _inventory, invalid = _shared_contract_source(saipen_home)
    return targets, invalid


def _valid_inventory_path(path: str, kind: str) -> bool:
    """Constrain receipt ownership to the shipped shared-contract surface."""
    candidate = Path(path)
    if (
        not path
        or candidate.is_absolute()
        or "\\" in path
        or candidate.as_posix() != path
        or ".." in candidate.parts
    ):
        return False
    if kind == "directory":
        return path == "TEMPLATE" or path.startswith("TEMPLATE/")
    return (
        path in _SHARED_FILES
        or path.startswith("TEMPLATE/")
        or (len(candidate.parts) == 1 and re.fullmatch(r"sai[^/]*\.md", path) is not None)
    )


def _normalize_owned_inventory(value) -> list[dict] | None:
    if not isinstance(value, list):
        return None
    normalized = []
    seen = set()
    for item in value:
        if not isinstance(item, dict):
            return None
        path = item.get("path")
        kind = item.get("kind")
        digest = item.get("source_hash")
        if (
            not isinstance(path, str)
            or kind not in {"file", "directory"}
            or not isinstance(digest, str)
            or not _valid_inventory_path(path, kind)
        ):
            return None
        if kind == "file" and not re.fullmatch(r"[0-9a-f]{16}", digest):
            return None
        if kind == "directory" and not re.fullmatch(r"delete-tree-sha256:[0-9a-f]{64}", digest):
            return None
        key = (path, kind)
        if key in seen:
            return None
        seen.add(key)
        normalized.append({"path": path, "kind": kind, "source_hash": digest})
    return sorted(normalized, key=lambda item: (item["path"], item["kind"]))


_DURABLE_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def _valid_durable_timestamp(value) -> bool:
    """A receipt's OWN committed UTC timestamp is the durable lineage key."""
    return isinstance(value, str) and _DURABLE_TS_RE.fullmatch(value) is not None


def _inventory_key(inventory: list[dict]) -> tuple:
    return tuple(sorted((i["path"], i["kind"], i["source_hash"]) for i in inventory))


def _actual_receipt_rel(root: Path, op_id: str) -> str:
    """W2-002: resolve the ACTUAL receipt path for an op_id across BOTH ops and
    settled namespaces (settled wins, since a settled receipt is the canonical
    terminal evidence). Falls back to the ops path when neither exists, so
    callers always receive a well-formed relative path."""
    from .journal import OPS_DIR, SETTLED_DIR

    for ns in (SETTLED_DIR, OPS_DIR):
        candidate = root / ns / str(op_id) / "operation.json"
        if candidate.is_file():
            return candidate.relative_to(root).as_posix()
    return f"{OPS_DIR}/{op_id}/operation.json"


def _latest_sub_sync_inventory(
    root: Path, records: tuple[dict, ...] | None = None
) -> tuple[dict | None, list[dict] | None, str]:
    """Durable canonical sub_sync receipt selection (T-1001).

    W2-002: scans BOTH recovery/ops and recovery/settled through the ONE
    canonical semantic snapshot, not ops alone -- a sub_sync receipt settled by
    _settle_journal lives under recovery/settled/<op_id>, so the ops-only scan
    destroyed sub_sync idempotence. The returned receipt path is the ACTUAL
    on-disk location (resolved against both namespaces), never a reconstructed
    recovery/ops/<op_id> guess. The third element reports lineage so callers
    can fail closed: "none" (no committed receipt), "broken" (every candidate
    lacks a valid durable timestamp), "ambiguous" (receipts sharing the newest
    timestamp disagree about the inventory -- the same committed second cannot
    be durably ordered), or "ok".
    """
    if records is None:
        from .journal import semantic_receipt_snapshot

        snapshot = semantic_receipt_snapshot(root)
        if snapshot.errors:
            return None, None, "corrupt"
        records = snapshot.records
    candidates = []
    for record in records:
        try:
            inventory = _normalize_owned_inventory(
                (record.get("receipt_metadata") or {}).get("owned_source_inventory")
            )
        except (AttributeError, TypeError):
            continue
        if (
            record.get("operation") == "sub_sync"
            and record.get("status") == "COMMITTED"
            and inventory is not None
        ):
            op_id = record.get("op_id", "")
            candidates.append(
                (
                    record.get("created_at", ""),
                    op_id,
                    record,
                    inventory,
                    _actual_receipt_rel(root, op_id),
                )
            )
    if not candidates:
        return None, None, "none"
    valid = [c for c in candidates if _valid_durable_timestamp(c[0])]
    if not valid:
        return None, None, "broken"
    newest = max(c[0] for c in valid)
    top = [c for c in valid if c[0] == newest]
    if len({_inventory_key(c[3]) for c in top}) > 1:
        # W2-003: check if same-second divergent inventories are actually a
        # serial chain via previous_sub_sync_op_id. Serial A->B with same
        # timestamp and B.previous == A.op_id is ordered, not ambiguous.
        # Legacy receipts without predecessor remain ambiguous.
        top_by_id = {c[1]: c for c in top}
        # Build predecessor map: for each top candidate, its previous op_id
        pred_to_succ: dict[str, str] = {}
        has_legacy = False
        for _ts, _op, rec, _inv, _path in top:
            prev = (rec.get("receipt_metadata") or {}).get("previous_sub_sync_op_id")
            if not prev:
                has_legacy = True
            elif prev in top_by_id:
                pred_to_succ[prev] = _op
        # If any legacy among divergent top, keep ambiguous (cannot prove chain)
        if has_legacy:
            return None, None, "ambiguous"
        # If the divergent top forms a single predecessor chain, resolve to head
        # Head is the op that is not a predecessor of any other top candidate
        # and whose predecessors are within top. For serial A->B, pred_to_succ = {A: B}, head = B.
        # For chain A->B->C, pred_to_succ = {A: B, B: C}, head = C.
        # If multiple heads or disconnected, it's a true fork -> ambiguous.
        successors = set(pred_to_succ.values())
        predecessors = set(pred_to_succ.keys())
        # Heads are successors that are never predecessors in this top set
        heads = [op for op in successors if op not in predecessors]
        # If exactly one head and the chain covers all divergent inventories
        # (i.e., all top nodes are connected via predecessor links), not ambiguous.
        if len(heads) == 1 and len(pred_to_succ) == len(top) - 1:
            head_op = heads[0]
            head = top_by_id[head_op]
            _ts, _op, record, inventory, receipt_path = head
            return {**record, "_receipt_path": receipt_path}, inventory, "ok"
        return None, None, "ambiguous"
    _ts, _op, record, inventory, receipt_path = max(top, key=lambda item: item[1])
    return {**record, "_receipt_path": receipt_path}, inventory, "ok"


def _owned_local_path(root: Path, rel: str) -> Path:
    shared = root / SUBS_REL
    prove_inside(shared, root.resolve(), kind="project-local shared root")
    _reject_reparse_ancestors(root, shared)
    candidate = shared / rel
    prove_inside(candidate, shared.resolve(), kind="inherited shared path")
    _reject_reparse_ancestors(root, candidate)
    return candidate


def _live_inventory_hash(root: Path, item: dict) -> str:
    try:
        path = _owned_local_path(root, item["path"])
        info = path.lstat()
    except FileNotFoundError:
        return ""
    except (OSError, ValueError):
        return "object-unreadable"
    attributes = getattr(info, "st_file_attributes", 0)
    if path.is_symlink() or attributes & 0x400:
        return "object-reparse"
    if item["kind"] == "file":
        if not stat.S_ISREG(info.st_mode):
            return f"object:{info.st_mode}"
        try:
            return hash_bytes(path.read_bytes())
        except OSError:
            return "object-unreadable"
    if not stat.S_ISDIR(info.st_mode):
        return f"object:{info.st_mode}"
    return hash_delete_tree(path)


def _obsolete_inventory(prior: list[dict] | None, current: list[dict]) -> list[dict]:
    current_keys = {(item["path"], item["kind"]) for item in current}
    return [item for item in (prior or []) if (item["path"], item["kind"]) not in current_keys]


def _obsolete_contract_status(
    root: Path, prior: list[dict] | None, current: list[dict]
) -> tuple[list[dict], list[str]]:
    obsolete = _obsolete_inventory(prior, current)
    conflicts = []
    for item in obsolete:
        live = _live_inventory_hash(root, item)
        if live and live != item["source_hash"]:
            conflicts.append(item["path"])
    return obsolete, sorted(set(conflicts))


def _unexpected_inherited(
    root: Path, source_inventory: list[dict], prior_inventory: list[dict] | None = None
) -> tuple[list[str], list[str]]:
    """Files/directories present under an inherited directory locally that the
    source inventory does NOT own. Unknown extras are never auto-deleted --
    they surface here so the shared contract reads NOT current (T-1003). A
    path the PRIOR receipt inventory owns is either current or obsolete --
    never unexpected; only a path owned by neither source nor any committed
    receipt is a foreign extra."""
    owned_files = {item["path"] for item in source_inventory if item["kind"] == "file"}
    owned_dirs = {item["path"] for item in source_inventory if item["kind"] == "directory"}
    for item in prior_inventory or ():
        if item["kind"] == "file":
            owned_files.add(item["path"])
        else:
            owned_dirs.add(item["path"])
    unexpected_files = set()
    unexpected_dirs = set()
    for item in source_inventory:
        if item["kind"] != "directory":
            continue
        directory = _owned_local_path(root, item["path"])
        if not directory.is_dir():
            continue
        for current, dirnames, filenames in os.walk(directory, topdown=True, followlinks=False):
            rel_current = Path(current).relative_to(root / SUBS_REL).as_posix()
            for dirname in dirnames:
                rel = f"{rel_current}/{dirname}" if rel_current != "." else dirname
                if rel not in owned_dirs:
                    unexpected_dirs.add(rel)
            for filename in filenames:
                rel = f"{rel_current}/{filename}" if rel_current != "." else filename
                if rel not in owned_files:
                    unexpected_files.add(rel)
    return sorted(unexpected_files), sorted(unexpected_dirs)


def shared_contract_status(
    project_root: Path | str, saipen_home: str, records: tuple[dict, ...] | None = None
) -> dict:
    """The exact shared-contract drift report.

    Returns {"current", "invalid_source_home", "missing_files",
    "stale_files"}. `current` is True ONLY when the source home is valid and
    every inherited file exists locally with identical bytes.
    """
    root = Path(project_root)
    _targets, source_inventory, invalid = _shared_contract_source(saipen_home)
    if invalid:
        return {
            "current": False,
            "invalid_source_home": invalid,
            "missing_files": [],
            "stale_files": [],
            "obsolete_files": [],
            "obsolete_dirs": [],
            "obsolete_conflicts": [],
            "inventory_known": False,
            "inventory_establishment": False,
            "inventory_lineage": "unknown",
        }
    receipt, prior_inventory, lineage = _latest_sub_sync_inventory(root, records)
    obsolete, conflicts = _obsolete_contract_status(root, prior_inventory, source_inventory)
    missing, stale, missing_dirs = [], [], []
    for item in source_inventory:
        rel = f"{SUBS_REL}/{item['path']}"
        live = _live_inventory_hash(root, item)
        if item["kind"] == "file":
            if not live:
                missing.append(rel)
            elif live != item["source_hash"]:
                stale.append(rel)
            continue
        if not live:
            missing_dirs.append(rel)
        elif live != item["source_hash"]:
            stale.append(rel)
    unexpected_files, unexpected_dirs = _unexpected_inherited(
        root, source_inventory, prior_inventory
    )
    inventory_changed = prior_inventory != source_inventory
    return {
        "current": (
            receipt is not None
            and not inventory_changed
            and not missing
            and not stale
            and not missing_dirs
            and not conflicts
            and not unexpected_files
            and not unexpected_dirs
        ),
        "invalid_source_home": None,
        "missing_files": sorted(missing),
        "missing_dirs": sorted(missing_dirs),
        "stale_files": sorted(stale),
        "unexpected_files": sorted(f"{SUBS_REL}/{path}" for path in unexpected_files),
        "unexpected_dirs": sorted(f"{SUBS_REL}/{path}" for path in unexpected_dirs),
        "obsolete_files": sorted(
            f"{SUBS_REL}/{item['path']}" for item in obsolete if item["kind"] == "file"
        ),
        "obsolete_dirs": sorted(
            (f"{SUBS_REL}/{item['path']}" for item in obsolete if item["kind"] == "directory"),
            key=lambda path: (len(Path(path).parts), path),
            reverse=True,
        ),
        "obsolete_conflicts": [f"{SUBS_REL}/{path}" for path in conflicts],
        "inventory_known": receipt is not None,
        "inventory_establishment": receipt is None,
        "inventory_lineage": lineage,
        "inventory_changed": inventory_changed,
        "inventory_receipt": receipt.get("op_id") if receipt else None,
        "inventory_receipt_path": receipt.get("_receipt_path") if receipt else None,
    }


def verify_sub_sync_receipt(root: Path, receipt_metadata: dict | None) -> list[str]:
    """Recovery-safe verifier for one provenance-backed sync plan."""
    if not isinstance(receipt_metadata, dict):
        return ["sub_sync receipt metadata missing"]
    inventory = _normalize_owned_inventory(receipt_metadata.get("owned_source_inventory"))
    reconciled = receipt_metadata.get("obsolete_reconciliation")
    if inventory is None or not isinstance(reconciled, list):
        return ["sub_sync receipt inventory/reconciliation malformed"]
    errors = []
    for item in inventory:
        live = _live_inventory_hash(root, item)
        if item["kind"] == "file" and live != item["source_hash"]:
            errors.append(
                f"{SUBS_REL}/{item['path']}: live {live!r} != source {item['source_hash']!r}"
            )
        elif item["kind"] == "directory" and live != item["source_hash"]:
            errors.append(
                f"{SUBS_REL}/{item['path']}: inherited directory "
                f"live {live!r} != source {item['source_hash']!r}"
            )
    for item in reconciled:
        if (
            not isinstance(item, dict)
            or _normalize_owned_inventory(
                [
                    {
                        "path": item.get("path"),
                        "kind": item.get("kind"),
                        "source_hash": item.get("source_hash"),
                    }
                ]
            )
            is None
        ):
            errors.append("obsolete reconciliation entry malformed")
            continue
        path = _owned_local_path(root, item["path"])
        if os.path.lexists(path):
            errors.append(f"{SUBS_REL}/{item['path']}: receipt-safe obsolete path remains")
    return errors


# ---------------------------------------------------------------------------
# Role-revision authority (SAICREW sections D/E). For an attached project the
# PROJECT-LOCAL charter is the only role-revision source; the installation
# charter is only the sync source. A generic `sai*` worker's revision is the
# deterministic digest of the project-local PROTOCOL.md. Never blank.
# ---------------------------------------------------------------------------
def current_local_role_revision(root: Path, name: str, saipen_home: str = "") -> str | None:
    """The role revision the project-local charter (or local PROTOCOL for a
    generic role) derives RIGHT NOW, or None when evidence is unavailable.

    Built-in vs generic is decided by whether the SAIPEN home ships a charter
    for this name. A BUILT-IN role with a missing project-local charter is
    UNAVAILABLE -- never a silent fallback to the generic PROTOCOL digest
    (SAICREW D/E); the home charter is only the sync source. A custom name
    with no shipped charter is generic and derives from the project-local
    PROTOCOL.md. With no home known, a local charter still wins; otherwise
    the local PROTOCOL is the generic authority.
    """
    try:
        from freshness import compute_generic_role_revision, compute_role_revision, FreshnessError
    except ImportError:
        return None
    local_charter = root / SUBS_REL / f"{name}.md"
    local_protocol = root / SUBS_REL / "PROTOCOL.md"
    home_charter = Path(saipen_home) / "extensions" / "subs" / f"{name}.md" if saipen_home else None
    built_in = home_charter is not None and home_charter.is_file()
    try:
        if built_in:
            if not local_charter.is_file():
                return None  # built-in charter must exist locally: UNAVAILABLE
            return compute_role_revision(local_charter)
        if local_charter.is_file():
            return compute_role_revision(local_charter)
        if local_protocol.is_file():
            return compute_generic_role_revision(local_protocol)
    except (FreshnessError, OSError):
        return None
    return None


def role_freshness(root: Path, name: str, recorded: str, saipen_home: str = "") -> str:
    """Tri-state role freshness against the PROJECT-LOCAL authority.

    Returns `current` (local evidence matches the recorded revision),
    `stale` (local evidence readable but differs), or `unavailable`
    (no local charter, no local PROTOCOL, or a read/hash failure).
    UNKNOWN is never FRESH: ROLE_EVIDENCE_UNAVAILABLE means the instance
    cannot be verified and MUST NOT be treated as current (SAICREW D).
    """
    current = current_local_role_revision(root, name, saipen_home)
    if current is None:
        return "unavailable"
    return "current" if current == recorded else "stale"


# ---------------------------------------------------------------------------
# ONE reusable sub-board parser (SAICREW section H). The sub board uses its
# own `PREFIX-NNN` namespace (PROTOCOL § 3), never Core's T-###, and must be a
# coherent machine with its STATE phase.
# ---------------------------------------------------------------------------
SUB_HEADINGS = ("## DOING", "## TODO", "## DONE", "## BLOCKED")
# Optional `[TAG]` prefix (e.g. `[MARKHUNT]`) before the ticket id.
SUB_TICKET_RE = re.compile(
    r"^- \[([ x/])\] (?:\[[^\]]*\]\s*)?([A-Za-z][A-Za-z0-9]*-\d+)"
    r"(?:\s+(.*))?$"
)


def ticket_prefix_for_role(role: str, declared: str | None = None) -> str:
    """One deterministic ticket-prefix authority for built-in/custom roles."""
    if declared is not None:
        prefix = declared.rstrip("-")
        if not re.fullmatch(r"[A-Z][A-Z0-9]*", prefix):
            raise ValueError(f"declared ticket prefix {declared!r} is invalid")
        return prefix
    registered = ROLE_REGISTRY.get(role)
    if registered:
        return registered.ticket_prefix
    safe = validate_safe_id(role, kind="subSaipen role")
    return safe[:4].upper()


def parse_sub_board(
    text: str, expected_role: str | None = None, ticket_prefix: str | None = None
) -> dict:
    """Strict sub-board parser.

    Returns {"tickets", "headings", "errors", "counts"}. Errors cover:
    duplicate/missing headings, duplicate ticket IDs, at most one DOING,
    checkbox/section disagreement, Core T-### IDs, malformed ticket lines,
    tickets outside the four sections. HTML comments and prose are inert
    (the validator reading this file does NOT skip comments, but only
    `- [ ] PREFIX-NNN` lines are tickets).
    """
    expected_prefix = None
    if expected_role is not None or ticket_prefix is not None:
        expected_prefix = ticket_prefix_for_role(expected_role or "generic", ticket_prefix)
    tickets: dict[str, dict] = {}
    seen_ticket_ids: set[str] = set()
    headings: list[str] = []
    errors: list[str] = []
    section = None
    legacy_history = False
    for line_no, line in enumerate(text.splitlines(), 1):
        if line.strip().startswith("# LEGACY"):
            legacy_history = True
            continue
        if line.startswith("## "):
            section = line.strip()
            headings.append(section)
            if section not in SUB_HEADINGS:
                errors.append(f"BOARD.md:{line_no} unknown heading {section!r}")
            continue
        if not line.strip():
            continue
        if line.lstrip().startswith("- ["):
            match = SUB_TICKET_RE.match(line.strip())
            if not match:
                errors.append(
                    f"BOARD.md:{line_no} ticket-ish line doesn't match "
                    "`- [ ] <PREFIX>-NNN description`"
                )
                continue
            checkbox, tid, rest = match.groups()
            if tid in seen_ticket_ids:
                errors.append(f"duplicate ticket ID {tid}")
                continue
            seen_ticket_ids.add(tid)
            if section not in SUB_HEADINGS:
                errors.append(
                    f"ticket {tid} sits under {section or 'no heading'} -- "
                    "not one of the four sections"
                )
                continue
            if tid.startswith("T-"):
                errors.append(
                    f"ticket {tid} uses Core's T-### namespace -- a sub "
                    "board must use its own prefix (PROTOCOL § 3)"
                )
                continue
            prefix = tid.rsplit("-", 1)[0]
            if expected_prefix is not None and prefix != expected_prefix:
                if not legacy_history:
                    errors.append(
                        f"ticket {tid} has prefix {prefix}-, expected "
                        f"{expected_prefix}- for {expected_role or 'declared role'}"
                    )
                    continue
                if checkbox != "x" or section != "## DONE":
                    errors.append(
                        f"legacy ticket {tid} is not read-only DONE history "
                        "-- legacy IDs stay historical and can never become "
                        "actionable"
                    )
                    continue
            expected_checkbox = {
                "## DOING": "/",
                "## TODO": " ",
                "## DONE": "x",
                "## BLOCKED": " ",
            }[section]
            if checkbox != expected_checkbox:
                errors.append(
                    f"ticket {tid} checkbox [{checkbox}] disagrees with "
                    f"section {section}; expected [{expected_checkbox}]"
                )
            tickets[tid] = {
                "id": tid,
                "section": section,
                "checkbox": checkbox,
                "description": rest or "",
                "legacy": legacy_history,
            }
    for heading in SUB_HEADINGS:
        seen = headings.count(heading)
        if seen != 1:
            errors.append(f"required heading {heading} appears {seen} time(s)")
    doing = [t for t in tickets.values() if t["section"] == "## DOING"]
    if len(doing) > 1:
        errors.append("at most one DOING ticket allowed")
    counts = {
        heading[3:]: sum(1 for t in tickets.values() if t["section"] == heading)
        for heading in SUB_HEADINGS
    }
    return {"tickets": tickets, "headings": headings, "errors": errors, "counts": counts}


def _derive_health(
    state: dict, board: dict, outbox: dict, role_state: str, collect_state: dict | None = None
) -> str:
    """Mechanical health from STATE + BOARD + OUTBOX + role evidence.

    Order of precedence (each higher rule wins):
    1. board invalid                     -> INVALID
    2. phase DONE but pending board work -> INVALID (H's key invariant)
    3. phase BLOCKED                     -> BLOCKED
    4. role evidence unavailable         -> STALE
    5. open TODO/DOING work              -> WORK_PENDING
    6. reviewed claim without a terminal linked Core disposition
                                          -> INVALID (item 13/16: REVIEWED
                                             TEXT IS NOT A REVIEW DISPOSITION)
    7. collected READY package with open/terminal linked review ticket
                                          -> REVIEW_PENDING (INTAKE != REVIEW;
                                             Core owns the disposition now)
    8. current READY package, not collected -> READY_FOR_REVIEW
    9. DONE + current-source package     -> CURRENT
    10. DONE + ready-but-stale package    -> STALE
    11. DONE + no package                 -> NOT_RUN (J: empty OUTBOX is not
                                            proof of running)
    12. PLAN/INIT with no work/evidence   -> NOT_RUN
    13. otherwise                        -> WORK_PENDING
    """
    phase = state.get("phase") or "?"
    if board["errors"] or outbox.get("errors"):
        return HEALTH_INVALID
    counts = board["counts"]
    if phase == "DONE" and (counts["TODO"] or counts["DOING"] or counts["BLOCKED"]):
        return HEALTH_INVALID
    if phase == "BLOCKED" or counts["BLOCKED"]:
        return HEALTH_BLOCKED
    if counts["TODO"] or counts["DOING"]:
        return HEALTH_WORK_PENDING
    collect_state = collect_state or {}
    if collect_state.get("reviewed_without_disposition"):
        return HEALTH_INVALID
    if collect_state.get("ready_collected_open") or collect_state.get("ready_collected_terminal"):
        return HEALTH_REVIEW_PENDING
    if outbox.get("counts", {}).get("ready"):
        if outbox.get("ready_current"):
            return HEALTH_READY_FOR_REVIEW
        return HEALTH_STALE
    if outbox.get("counts", {}).get("reviewed") and not outbox.get("package_current"):
        return HEALTH_STALE
    if role_state != "current":
        return HEALTH_STALE
    if phase == "DONE":
        if outbox.get("package_current"):
            return HEALTH_CURRENT
        return HEALTH_NOT_RUN
    if phase in ("PLAN", "INIT"):
        return HEALTH_NOT_RUN
    return HEALTH_WORK_PENDING


OUTBOX_FIELDS = frozenset(
    {
        "status",
        "summary",
        "main_project_refs",
        "critical",
        "severity",
        "producer",
        "source_head",
        "source_tree_fingerprint",
        "role_revision",
        "coverage",
        "payload",
        "verified",
        "instructions",
        "details",
        "superseded_by",
        "base_head",
        "patch",
        "legacy",
    }
)
OUTBOX_COMPLETE_FIELDS = frozenset(
    {
        "status",
        "producer",
        "source_head",
        "source_tree_fingerprint",
        "role_revision",
        "coverage",
        "payload",
        "verified",
        "instructions",
    }
)
OUTBOX_FIELD_RE = re.compile(r"^- \*\*([a-z_][a-z0-9_]*):\*\*\s*(.*)$")
OUTBOX_HEADING_RE = re.compile(r"^## ([A-Za-z][A-Za-z0-9]*-\d+):\s*(\S.*)$")
GIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")
TREE_FINGERPRINT_RE = re.compile(r"^(?:git-delta-v1|no-git-tree-v1):[0-9a-f]{64}$")
ROLE_REVISION_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass(frozen=True)
class OutboxPackage:
    package_id: str
    description: str
    fields: dict[str, str]
    block: str
    legacy: bool = False

    @property
    def status(self) -> str:
        return self.fields["status"]


@dataclass(frozen=True)
class OutboxModel:
    packages: tuple[OutboxPackage, ...]
    errors: tuple[str, ...]


def parse_outbox(text: str, producer: str | None = None) -> OutboxModel:
    """Parse one OUTBOX using a closed, duplicate-proof package grammar."""
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.splitlines()
    if not lines or lines[0] != "# OUTBOX":
        return OutboxModel((), ("OUTBOX must open with exactly `# OUTBOX`",))
    errors: list[str] = []
    starts = [index for index, line in enumerate(lines) if line.startswith("## ")]
    preamble_end = starts[0] if starts else len(lines)
    in_comment = False
    for line in lines[1:preamble_end]:
        stripped = line.strip()
        if stripped.startswith("<!--"):
            in_comment = True
        if stripped and not in_comment:
            errors.append("OUTBOX preamble may contain only blank lines/comments")
            break
        if "-->" in stripped:
            in_comment = False
    if in_comment:
        errors.append("OUTBOX preamble has an unclosed comment")
    packages: list[OutboxPackage] = []
    seen_ids: set[str] = set()
    for pos, start in enumerate(starts):
        end = starts[pos + 1] if pos + 1 < len(starts) else len(lines)
        block_lines = lines[start:end]
        heading = OUTBOX_HEADING_RE.fullmatch(block_lines[0])
        if not heading:
            errors.append(f"OUTBOX:{start + 1} malformed package heading")
            continue
        package_id, description = heading.groups()
        if package_id in seen_ids:
            errors.append(f"OUTBOX:{start + 1} duplicate package ID {package_id}")
        seen_ids.add(package_id)
        fields: dict[str, str] = {}
        active_field = None
        for line_no, line in enumerate(block_lines[1:], start + 2):
            match = OUTBOX_FIELD_RE.match(line)
            if match:
                key, value = match.groups()
                if key not in OUTBOX_FIELDS:
                    errors.append(f"OUTBOX:{line_no} unknown field {key!r}")
                    active_field = None
                    continue
                if key in fields:
                    errors.append(f"OUTBOX:{line_no} duplicate field {key!r}")
                    active_field = None
                    continue
                fields[key] = value.strip()
                active_field = key
                continue
            if line.startswith("  ") and active_field:
                fields[active_field] += ("\n" if fields[active_field] else "") + line.strip()
                continue
            if not line.strip():
                active_field = None
                continue
            errors.append(f"OUTBOX:{line_no} malformed field/content line")
            active_field = None
        status = fields.get("status", "")
        if status not in OUTBOX_STATUSES:
            errors.append(f"OUTBOX:{start + 1} status {status!r} outside closed enum")
        if "producer" in fields and producer is not None and fields["producer"] != producer:
            errors.append(
                f"OUTBOX:{start + 1} producer {fields['producer']!r} "
                f"does not match owner {producer!r}"
            )
        # T-1003 sweep: an EXPLICIT `legacy: true` marker is the one boundary
        # that exempts a package from today's provenance schema. Legacy is
        # never inferred from missing fields (that would be fail-open); the
        # historical package keeps its bytes, is never collectable, and must
        # not poison a strict current package in the same OUTBOX.
        legacy = fields.get("legacy") == "true"
        if not legacy:
            head = fields.get("source_head", "")
            if head and head != "no-git" and not GIT_SHA_RE.fullmatch(head):
                errors.append(f"OUTBOX:{start + 1} invalid source_head")
            tree = fields.get("source_tree_fingerprint", "")
            if tree and not TREE_FINGERPRINT_RE.fullmatch(tree):
                errors.append(f"OUTBOX:{start + 1} invalid source_tree_fingerprint")
            if head == "no-git" and tree and not tree.startswith("no-git-tree-v1:"):
                errors.append(
                    f"OUTBOX:{start + 1} no-git source_head requires no-git-tree-v1 fingerprint"
                )
            if GIT_SHA_RE.fullmatch(head) and tree and not tree.startswith("git-delta-v1:"):
                errors.append(
                    f"OUTBOX:{start + 1} Git source_head requires git-delta-v1 fingerprint"
                )
            role = fields.get("role_revision", "")
            if role and not ROLE_REVISION_RE.fullmatch(role):
                errors.append(f"OUTBOX:{start + 1} invalid role_revision")
            missing = sorted(OUTBOX_COMPLETE_FIELDS - fields.keys())
            if missing:
                errors.append(f"OUTBOX:{start + 1} package missing " + ", ".join(missing))
            for key in OUTBOX_COMPLETE_FIELDS:
                if key in fields and not fields[key].strip():
                    errors.append(f"OUTBOX:{start + 1} field {key} is empty")
            # Wave 2 item 12: `verified` is a CLOSED verdict, not a prose
            # field. Arbitrary nonempty text ("verified: looks good",
            # "verified: banana") is not evidence -- only a positive closed
            # verdict may certify a READY package. The shape is
            # `PASS -- <command/result evidence>` | `FAIL -- <evidence>` |
            # `BLOCKED -- <missing fact>`.
            verified = fields.get("verified", "").strip()
            if verified:
                verdict_match = re.fullmatch(r"(?i)(PASS|FAIL|BLOCKED)(?:\s*--\s*.*)?", verified)
                if not verdict_match:
                    errors.append(
                        f"OUTBOX:{start + 1} verified field must be a closed "
                        "verdict (`PASS -- <command/result evidence>` | "
                        "`FAIL -- <evidence>` | `BLOCKED -- <missing fact>`); "
                        "arbitrary prose is never positive evidence"
                    )
                elif status == "ready" and verdict_match.group(1).upper() != "PASS":
                    errors.append(
                        f"OUTBOX:{start + 1} status ready but verified "
                        f"verdict is {verdict_match.group(1).upper()} -- only "
                        "a positive closed PASS may certify READY work"
                    )
        packages.append(
            OutboxPackage(package_id, description, fields, "\n".join(block_lines), legacy=legacy)
        )
    if not starts and not errors:
        # Header plus comments is canonical empty queue (TEMPLATE included).
        pass
    return OutboxModel(tuple(packages), tuple(errors))


def _outbox_model(root: Path, name: str, source_id, saipen_home: str = "") -> OutboxModel:
    """The parsed OUTBOX model for one role (used by health + linkage)."""
    outbox_path = root / SUBS_REL / name / "kitchen" / "OUTBOX.md"
    if not outbox_path.is_file():
        return OutboxModel((), ())
    return parse_outbox(_read_maybe(outbox_path), name)


def _outbox_health(root: Path, name: str, source_id, saipen_home: str = "") -> dict:
    """OUTBOX status counts + package currentness against source identity.

    `package_current` is True only when a ready/reviewed entry binds the
    current source_head + source_tree_fingerprint + role_revision triple.
    A clean run with payload [] is valid evidence; NO package is never
    evidence (SAICREW J).
    """
    outbox_path = root / SUBS_REL / name / "kitchen" / "OUTBOX.md"
    if not outbox_path.is_file():
        return {"present": False, "counts": {}, "package_current": False, "ready_current": False}
    text = _read_maybe(outbox_path)
    model = parse_outbox(text, name)
    counts = {status: 0 for status in OUTBOX_STATUSES}
    for package in model.packages:
        status = package.fields.get("status", "")
        if status in counts:
            counts[status] += 1
    if source_id is None:
        try:
            from freshness import compute_source_identity

            source_id = compute_source_identity(root)
        except Exception:
            source_id = None
    current_role = current_local_role_revision(root, name, saipen_home)
    package_current = False
    ready_current = False
    if source_id is not None and current_role is not None:
        current_ready = []
        for package in model.packages:
            if package.legacy:
                continue
            status = package.fields.get("status", "")
            if status not in ("ready", "reviewed"):
                continue
            head = package.fields.get("source_head", "")
            tree = package.fields.get("source_tree_fingerprint", "")
            role = package.fields.get("role_revision", "")
            if not head or not tree or not role:
                continue
            if (
                head != source_id.source_head
                or tree != source_id.source_tree_fingerprint
                or role != current_role
            ):
                continue
            package_current = True
            if status == "ready":
                ready_current = True
                current_ready.append(package.package_id)
        if len(current_ready) > 1:
            model = OutboxModel(
                model.packages,
                (
                    *model.errors,
                    "multiple current READY packages are ambiguous: " + ", ".join(current_ready),
                ),
            )
    return {
        "present": True,
        "counts": counts,
        "package_current": package_current,
        "ready_current": ready_current,
        "errors": list(model.errors),
    }


def validate_sub_state(state: dict) -> list[str]:
    """Semantic validation of one Sub STATE -- the SAME contract the validator
    applies (T-1003 sweep). A syntactically parseable but schema-invalid
    worker state must report INVALID, never CURRENT. Consumed by
    sub_instance_health, the crew snapshot/gate, lifecycle verifiers and the
    validator (which layers per-file detail over these errors)."""
    from . import phases
    from .board import strict_iso_utc

    errors: list[str] = []
    required = (
        "phase",
        "task",
        "next_action",
        "blocker",
        "agent",
        "saipen_version",
        "mode",
        "updated",
    )
    for key in required:
        if key not in state:
            errors.append(f"missing required field {key}")
    phase = state.get("phase")
    if phase not in phases.VALID_TRANSITIONS and phase not in phases.ANY_FROM:
        errors.append(f"phase {phase!r} outside the 16-value enum")
    tf = state.get("transition_from")
    if tf is None:
        if phase != "INIT":
            errors.append("missing transition_from -- required except on INIT")
    elif tf not in phases.VALID_TRANSITIONS and tf not in phases.ANY_FROM:
        errors.append(f"transition_from {tf!r} is not in the phase enum")
    elif phase and tf != phase and phase not in phases.ANY_FROM:
        allowed = list(phases.VALID_TRANSITIONS.get(tf, []))
        if tf == "HUNT":
            allowed.append("DONE")
        if phase not in allowed:
            errors.append(f"{tf} -> {phase} is not in the transition table")
    mode = state.get("mode")
    if mode not in ("full", "read-only", "no-publish", "manual-verify"):
        errors.append(f"mode {mode!r} outside the closed capability set")
    updated = state.get("updated")
    if isinstance(updated, str) and not strict_iso_utc(updated):
        errors.append("updated must be a real ISO-8601 UTC instant (Z or +00:00)")
    na = state.get("next_action")
    if isinstance(na, str):
        if na.startswith("PHASE "):
            err = phases.phase_next_action_error(na)
            if err:
                errors.append(f"next_action {err}")
        elif not na.startswith(("WAIT:", "saipen ", "RUN:", "RESUME:")):
            errors.append("next_action does not start with WAIT:/saipen /PHASE /RUN:/RESUME:")
    if state.get("execution_intent") == "goal":
        for counter in ("goal_waves", "goal_tickets"):
            if not isinstance(state.get(counter), int):
                errors.append(f"execution_intent: goal but {counter} is missing/not an integer")
    return errors


#: T-1435 M4: the closed producer terminal-consistency verdicts. ONE
#: side-effect-free predicate classifies a producer's STATE/BOARD pair; the
#: validator, the producer-owned reconciliation and the terminal writers all
#: consume the SAME facts, so "repairable" and "refused" can never disagree.
TERMINAL_VERDICTS = (
    "CLEAN",
    "STALE_STATE",
    "DONE_CLAIM_FALSE",
    "MUST_RESUME",
    "MUST_BLOCK",
    "NONTERMINAL",
    "MALFORMED_STATE",
    "MALFORMED_BOARD",
)


def terminal_consistency(state: dict | None, board: dict | None) -> dict:
    """ONE side-effect-free producer terminal-truth predicate (T-1435 M4).

    Truth table (STATE phase DONE unless stated otherwise):

      A  DONE + task/residue, BOARD terminal   -> STALE_STATE   (clear residue)
      B  DONE + real TODO                      -> DONE_CLAIM_FALSE
      C  DONE + DOING                          -> MUST_RESUME
      D  DONE + active BLOCKED                 -> MUST_BLOCK
      E  DONE + task none, BOARD terminal      -> CLEAN
      F  malformed STATE                       -> MALFORMED_STATE (refuse)
      G  malformed BOARD                       -> MALFORMED_BOARD (refuse)

    Precedence inside a contradiction is conservative: a live DOING outranks
    a BLOCKED, which outranks a TODO, because the stronger lifecycle truth is
    the one the producer must resume. Nothing here writes or infers from
    prose; archival rows are distinguishable because only the OPEN sections
    are counted.
    """
    if state is None or not isinstance(state, dict):
        return {"verdict": "MALFORMED_STATE", "detail": "STATE is absent or unparseable"}
    if board is None or not isinstance(board, dict):
        return {"verdict": "MALFORMED_BOARD", "detail": "BOARD is absent or unparseable"}
    phase = str(state.get("phase") or "")
    tickets = board.get("tickets", {}) or {}
    doing = sorted(t["id"] for t in tickets.values() if t.get("section") == "## DOING")
    todo = sorted(t["id"] for t in tickets.values() if t.get("section") == "## TODO")
    blocked = sorted(t["id"] for t in tickets.values() if t.get("section") == "## BLOCKED")
    facts = {
        "phase": phase,
        "task": state.get("task"),
        "task_residue": False,
        "state_residue": [],
        "doing": doing,
        "todo": todo,
        "blocked": blocked,
    }
    if phase != "DONE":
        return {**facts, "verdict": "NONTERMINAL", "detail": f"phase {phase!r} is not terminal"}
    task = state.get("task")
    ticket = None if task in (None, "", "none") else str(task).strip()
    residue: list[str] = []
    if ticket:
        residue.append(f"task {task!r}")
    if str(state.get("blocker") or "").strip():
        residue.append("an active blocker")
    facts["task_residue"] = bool(ticket)
    facts["state_residue"] = residue
    if doing:
        verdict = "MUST_RESUME"
    elif blocked:
        verdict = "MUST_BLOCK"
    elif todo:
        verdict = "DONE_CLAIM_FALSE"
    elif residue:
        verdict = "STALE_STATE"
    else:
        verdict = "CLEAN"
    return {**facts, "verdict": verdict, "detail": "; ".join(residue) or "terminal"}


def validate_sub_lifecycle(state: dict, board: dict, role_name: str) -> list[str]:
    """Bind ONE sub STATE phase/task to its parsed BOARD as one coherent
    machine (T-1003 sweep, hostile finding 2). The shared validator every
    consumer uses -- validate.py, sub_instance_health, verify_sub_lifecycle
    and the crew snapshot/gate -- so DONE+task, task/DOING splits and
    wrong-prefix tasks cannot pass one path while failing another.

    Invariants:
    - DONE: task == none; zero TODO, zero DOING, zero unresolved BLOCKED.
    - ticket-bearing phase: a concrete role-valid ticket ID, exactly one
      DOING ticket, task == that DOING ticket.
    - non-ticket phase: task present iff exactly one matching DOING ticket
      (no impossible active-ticket binding).
    - BLOCKED: truthful non-empty blocker; no active task, no DOING ticket.
    """
    errors: list[str] = []
    phase = state.get("phase")
    task = state.get("task")
    ticket = None if task in (None, "", "none") else str(task).strip()
    tickets = board.get("tickets", {})
    counts = board.get("counts", {})
    doing = [t for t in tickets.values() if t["section"] == "## DOING"]
    prefix = ticket_prefix_for_role(role_name)
    if phase == "DONE":
        # T-1435 M4: the DONE branch reads the ONE terminal predicate's facts
        # (message strings unchanged, so a second truth cannot drift).
        verdict = terminal_consistency(state, board)
        if verdict["task_residue"]:
            errors.append(
                f"phase DONE but task is {task!r} -- Core's "
                "terminal invariant requires task none in a DONE "
                "worker state"
            )
        if verdict["doing"]:
            errors.append("phase DONE but the board still carries a ## DOING ticket")
        if verdict["todo"] or verdict["blocked"] or counts.get("TODO") or counts.get("BLOCKED"):
            errors.append(
                "phase DONE but the board still holds open work "
                "(TODO/BLOCKED) -- a worker cannot say DONE while "
                "its board says unresolved work"
            )
        return errors
    if phase == "BLOCKED":
        # Truthful blocker/WAIT relation (item 2): a blocked worker MUST
        # carry a real reason. A BLOCKED worker MAY hold a mission/task ref
        # while it waits for external input (shipped saiui-adoption pattern),
        # so task/DOING binding is NOT restricted here -- the blocker is the
        # invariant, not the ticket.
        if not str(state.get("blocker") or "").strip():
            errors.append("phase BLOCKED but blocker is empty")
        return errors
    if ticket:
        if len(doing) != 1:
            errors.append(
                f"task {task!r} does not bind a single ## DOING ticket "
                f"(board holds {len(doing)}) -- task and DOING must be one "
                "coherent binding"
            )
        elif doing[0]["id"] != ticket:
            errors.append(
                f"task {task!r} != the board's ## DOING ticket "
                f"{doing[0]['id']} -- an active-ticket binding split is "
                "impossible"
            )
        elif not re.fullmatch(rf"{re.escape(prefix)}-\d+", ticket):
            errors.append(
                f"task {task!r} is not a {prefix}- role ticket ID -- a task "
                "must be a concrete role-valid ticket ID, not a description"
            )
    elif doing:
        errors.append(
            f"no active task but the board has a ## DOING ticket "
            f"{doing[0]['id']} -- an active-ticket binding without a task is "
            "impossible"
        )
    return errors


def sub_instance_health(
    project_root: Path | str,
    name: str,
    source_id=None,
    manifest_entry: ManifestEntry | None = None,
    records: tuple[dict, ...] | None = None,
    authority_errors: tuple[str, ...] = (),
) -> dict:
    """The full mechanically-derived health record for one sub (SAICREW I).

    ``records`` is the pre-captured crew receipt snapshot; when given, every
    subs evidence helper iterates it instead of reopening disk (T-1004)."""
    root = Path(project_root)
    info = {"name": name}
    if authority_errors:
        return {
            **info,
            "phase": None,
            "task": None,
            "health": HEALTH_INVALID,
            "authority": "CORRUPT_JOURNAL",
            "authority_errors": list(authority_errors[:3]),
            "board": {"valid": False, "errors": [], "counts": {}},
            "outbox": {"present": False, "counts": {}, "errors": []},
            "collect": {"state": "INVALID", "reason": "semantic receipt corruption"},
        }
    if manifest_entry is None:
        _manifest_raw, manifest_entry, manifest_errors = _registered_entry(root, name)
        if manifest_errors:
            return {
                **info,
                "phase": None,
                "task": None,
                "health": HEALTH_INVALID,
                "board": {"valid": False, "errors": manifest_errors, "counts": {}},
                "local_charter_present": False,
                "role_revision": "",
                "role_revision_state": "UNAVAILABLE",
                "outbox": {
                    "present": False,
                    "counts": {},
                    "package_current": False,
                    "ready_current": False,
                    "errors": [],
                },
            }
    instance = _entry_dir(root, manifest_entry)
    state_path = instance / "STATE.md"
    if not state_path.is_file():
        return {
            **info,
            "phase": None,
            "task": None,
            "health": HEALTH_INVALID,
            "board_valid": False,
            "board_errors": ["no STATE.md"],
            "local_charter_present": False,
            "role_revision": "",
            "role_revision_state": "UNAVAILABLE",
            "outbox": {
                "present": False,
                "counts": {},
                "package_current": False,
                "ready_current": False,
            },
        }
    from .state import parse_state_or_error

    st, state_error = parse_state_or_error(codec.read_doc(state_path))
    state_errors = [state_error] if state_error else validate_sub_state(st or {})
    saipen_home = (st or {}).get("saipen_home") or ""
    board = parse_sub_board(_read_maybe(instance / "BOARD.md"), expected_role=name)
    # A malformed STATE must NEVER reach the lifecycle/derivation logic:
    # `st` is None on a parse error, and health must report HEALTH_INVALID
    # with the exact parse error instead of tracebacking (T-1003).
    lifecycle_errors = [] if state_error else validate_sub_lifecycle(st, board, name)
    if lifecycle_errors:
        board = {**board, "errors": tuple(board["errors"]) + tuple(lifecycle_errors)}
    outbox = _outbox_health(root, name, source_id, saipen_home)
    role_state = role_freshness(root, name, (st or {}).get("role_revision") or "", saipen_home)
    collect_state = _collect_review_state(
        root,
        name,
        _outbox_model(root, name, source_id, saipen_home),
        source_id,
        saipen_home,
        records,
    )
    if state_errors:
        return {
            **info,
            "phase": (st or {}).get("phase"),
            "task": (st or {}).get("task"),
            "board": {
                "valid": not board["errors"],
                "errors": board["errors"][:5],
                "counts": board["counts"],
            },
            "outbox": outbox,
            "local_charter_present": bool((root / SUBS_REL / f"{name}.md").is_file()),
            "role_revision": (st or {}).get("role_revision") or "",
            "role_revision_state": role_state.upper(),
            "health": HEALTH_INVALID,
            "state_errors": state_errors,
            "collect": collect_state,
        }
    health = _derive_health(st, board, outbox, role_state, collect_state)
    return {
        **info,
        "phase": st.get("phase"),
        "task": st.get("task"),
        "board": {
            "valid": not board["errors"],
            "errors": board["errors"][:5],
            "counts": board["counts"],
        },
        "outbox": outbox,
        "local_charter_present": bool((root / SUBS_REL / f"{name}.md").is_file()),
        "role_revision": st.get("role_revision") or "",
        "role_revision_state": role_state.upper(),
        "health": health,
        "collect": collect_state,
    }


# ---------------------------------------------------------------------------
# list / status
# ---------------------------------------------------------------------------
def sub_list(project_root: Path | str) -> Result:
    """Truthful manifest-backed list with per-role mechanical health.

    `blocked` reports every instance whose PHASE is BLOCKED or whose BOARD
    still holds unresolved BLOCKED entries -- an empty OUTBOX or a DONE phase
    can never hide an open block.
    """
    root = Path(project_root)
    try:
        from userperson import UserpersonError, effective_profile, project_profile

        effective = effective_profile(root)
    except UserpersonError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            exc.detail,
            scope=exc.scope,
            userperson_code=exc.code,
        )
    entries, errors = parse_manifest_file(root)
    if errors:
        return _refuse(
            "INVALID_MANIFEST", "MANIFEST malformed: " + "; ".join(errors[:5]), errors=errors
        )
    try:
        from freshness import compute_source_identity

        source_id = compute_source_identity(root)
    except Exception:
        source_id = None
    # PERF-005: ONE command-scoped semantic receipt snapshot serves every role.
    # Per-role health is not an independent receipt universe -- all roles in
    # one sub list belong to the same read-only command snapshot. Feeding the
    # same records to every helper removes N-role lifetime-receipt re-scans.
    from .journal import semantic_receipt_snapshot

    try:
        _receipt_snapshot = semantic_receipt_snapshot(root)
    except Exception as exc:
        return _refuse(
            "CORRUPT_JOURNAL",
            f"cannot capture semantic receipt authority: {type(exc).__name__}: {exc}",
            recovery_required=True,
        )
    if _receipt_snapshot.errors:
        return _refuse(
            "CORRUPT_JOURNAL",
            "semantic receipt corruption: " + "; ".join(_receipt_snapshot.errors[:3]),
            recovery_required=True,
            errors=list(_receipt_snapshot.errors[:3]),
        )
    _records = _receipt_snapshot.records
    lines = []
    blocked = []
    for entry in entries:
        info = sub_instance_health(root, entry.name, source_id, entry, records=_records)
        if effective["active"]:
            info["userperson_projection"] = project_profile(
                effective["preferences"],
                entry.name,
                source_fingerprint=effective["effective_fingerprint"],
            )
        lines.append(info)
        if info["health"] == HEALTH_BLOCKED or info.get("board", {}).get("counts", {}).get(
            "BLOCKED"
        ):
            blocked.append(entry.name)
    return Result(ok=True, code="SUB_LIST", data={"subs": lines, "blocked": blocked})


def sub_status(project_root: Path | str, name: str) -> Result:
    """Read-only peek with mechanically-derived health (SAICREW I)."""
    root = Path(project_root)
    try:
        from userperson import UserpersonError, effective_projection

        userperson_projection = effective_projection(root, name)
    except UserpersonError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            exc.detail,
            scope=exc.scope,
            userperson_code=exc.code,
        )
    try:
        _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    _manifest_raw, entry, errors = _registered_entry(root, name)
    if errors:
        code = (
            "INVALID_MANIFEST"
            if any("MANIFEST" in error or "registered" not in error for error in errors)
            else "TICKET_NOT_FOUND"
        )
        return _refuse(code, "; ".join(errors[:5]), name=name)
    if not (_entry_dir(root, entry) / "STATE.md").is_file():
        return _refuse("TICKET_NOT_FOUND", f"no subSaipen {name!r}", name=name)
    try:
        from freshness import compute_source_identity

        source_id = compute_source_identity(root)
    except Exception:
        source_id = None
    from .journal import semantic_receipt_snapshot

    try:
        receipt_snapshot = semantic_receipt_snapshot(root)
    except Exception as exc:
        return _refuse(
            "CORRUPT_JOURNAL",
            f"cannot capture semantic receipt authority: {type(exc).__name__}: {exc}",
            recovery_required=True,
        )
    if receipt_snapshot.errors:
        return _refuse(
            "CORRUPT_JOURNAL",
            "semantic receipt corruption: " + "; ".join(receipt_snapshot.errors[:3]),
            recovery_required=True,
            errors=list(receipt_snapshot.errors[:3]),
        )
    health = sub_instance_health(root, name, source_id, entry, records=receipt_snapshot.records)
    if userperson_projection["active"]:
        health["userperson_projection"] = userperson_projection
    return Result(ok=True, code="SUB_STATUS", data=health)


# ---------------------------------------------------------------------------
# sync
# ---------------------------------------------------------------------------
def plan_sub_sync(project_root: Path | str, saipen_home: str) -> dict:
    """The ONE pure, READ-ONLY sub-sync planner (Wave 2 items 6/7/8).

    `sub_sync` (dry-run AND APPLY) and `sub_spawn` consume this SAME
    plan/verdict, so a refusal APPLY would reach is always visible to
    --dry-run and to spawn's read-only preflight, and NO mutation can
    precede a predictable refusal. Only writes differ between dry-run and
    APPLY; the semantic verdict is computed once, here.
    """
    root = Path(project_root)
    source_root = Path(saipen_home) / "extensions" / "subs"
    source_tree_plan_hash = hash_tree(source_root)
    targets, source_inventory, invalid = _shared_contract_source(saipen_home)
    receipt, prior_inventory, lineage = _latest_sub_sync_inventory(root)
    obsolete, conflicts = _obsolete_contract_status(root, prior_inventory, source_inventory)
    prior_kinds = {item["path"]: item["kind"] for item in (prior_inventory or [])}
    current_kinds = {item["path"]: item["kind"] for item in source_inventory}
    kind_changes = sorted(
        path
        for path in prior_kinds.keys() & current_kinds
        if prior_kinds[path] != current_kinds[path]
    )
    inbox_src = Path(saipen_home) / "extensions" / "subs" / "_shared" / "inbox.md"
    local_inbox = root / f"{SUBS_REL}/_shared/inbox.md"
    local_inbox_raw = _read_bytes_maybe(local_inbox)
    inbox_target = None
    if inbox_src.is_file() and local_inbox_raw is None:
        inbox_raw = inbox_src.read_bytes()
        inbox_target = {
            "path": f"{SUBS_REL}/_shared/inbox.md",
            "content": inbox_raw,
            "source_path": str(inbox_src.resolve()),
            "source_hash": hash_bytes(inbox_raw),
        }
        targets.append(inbox_target)
    changed = []
    for target in targets:
        local = root / target["path"]
        local_raw = _read_bytes_maybe(local)
        if local_raw != target["content"]:
            changed.append({**target, "before_hash": _captured_hash(local_raw)})
    unexpected_files, unexpected_dirs = _unexpected_inherited(
        root, source_inventory, prior_inventory
    )
    unexpected = [f"{SUBS_REL}/{path}" for path in (*unexpected_files, *unexpected_dirs)]
    delete_files = []
    delete_dirs = []
    for item in obsolete:
        live = _live_inventory_hash(root, item)
        if not live:
            continue
        rel = f"{SUBS_REL}/{item['path']}"
        if item["kind"] == "file":
            delete_files.append(
                {
                    "path": rel,
                    "role": "manifest",
                    "action": "delete_file",
                    "expected_hash": item["source_hash"],
                }
            )
        else:
            delete_dirs.append(
                {
                    "path": rel,
                    "role": "manifest",
                    "action": "delete_dir",
                    "planned_before_hash": empty_delete_tree_hash(),
                }
            )
    delete_files.sort(key=lambda item: (-len(Path(item["path"]).parts), item["path"]))
    delete_dirs.sort(key=lambda item: (-len(Path(item["path"]).parts), item["path"]))
    # W2-003: durable predecessor for same-second ordering
    prior_op_id = receipt.get("op_id", "") if receipt else ""
    receipt_metadata = {
        "owned_source_inventory": source_inventory,
        "obsolete_reconciliation": obsolete,
        "previous_sub_sync_op_id": prior_op_id,
    }
    inventory_changed = prior_inventory != source_inventory
    drift = bool(changed or delete_files or delete_dirs or receipt is None or inventory_changed)
    return {
        "source_root": source_root,
        "source_tree_plan_hash": source_tree_plan_hash,
        "targets": targets,
        "source_inventory": source_inventory,
        "invalid": invalid,
        "receipt": receipt,
        "prior_inventory": prior_inventory,
        "lineage": lineage,
        "obsolete": obsolete,
        "conflicts": conflicts,
        "kind_changes": kind_changes,
        "changed": changed,
        "unexpected": unexpected,
        "delete_files": delete_files,
        "delete_dirs": delete_dirs,
        "inventory_changed": inventory_changed,
        "drift": drift,
        "receipt_metadata": receipt_metadata,
    }


def _sync_plan_problem(plan: dict, *, for_spawn: bool = False) -> Result | None:
    """The shared refusal the sync APPLY and spawn preflight both reach, so
    a refusal is always computed BEFORE any mutation (items 6/7/8)."""
    if plan.get("invalid"):
        return _refuse(
            "INVALID_SOURCE_HOME",
            plan["invalid"] + " -- run `saipen sub sync` after "
            "refreshing the install (BLOCKED, never copy from a "
            "path that did not check out)",
        )
    if plan.get("lineage") == "ambiguous":
        return _refuse(
            "VALIDATION_FAILED",
            "ambiguous sub-sync receipt lineage; refuse obsolete "
            "reconciliation until a durable canonical successor is "
            "committed",
        )
    if plan.get("kind_changes"):
        return _refuse(
            "VALIDATION_FAILED",
            "shared-contract path kind changed; one journal target cannot "
            "safely delete and recreate the same path: "
            + ", ".join(f"{SUBS_REL}/{path}" for path in plan["kind_changes"][:5]),
        )
    if plan.get("conflicts"):
        return _refuse(
            "VALIDATION_FAILED",
            "obsolete inherited path has local changes; refusing deletion: "
            + ", ".join(f"{SUBS_REL}/{path}" for path in plan["conflicts"][:5]),
            obsolete_conflicts=[f"{SUBS_REL}/{path}" for path in plan["conflicts"]],
        )
    if plan.get("unexpected"):
        return _refuse(
            "VALIDATION_FAILED",
            "unexpected inherited file(s) present outside the shipped "
            "source inventory: "
            + ", ".join(plan["unexpected"][:5])
            + " -- never auto-delete unknown extras; remove them or adopt "
            "them explicitly",
        )
    return None


def sub_sync(
    project_root: Path | str, saipen_home: str, agent: str | None = None, dry_run: bool = False
) -> Result:
    """Refresh the inherited shared contract surface -- never a sub's history.

    Copies PROTOCOL.md/README.md/crew.md/TEMPLATE/** and every built-in
    sai*.md charter from <saipen_home>/extensions/subs/. Creates a missing
    _shared/inbox.md once; preserves an existing one byte-identically. Never
    looks inside a `<name>/` folder. One journaled mutation; a second sync
    with no drift performs ZERO writes (idempotent). `dry_run` consumes the
    SAME plan_sub_sync verdict as APPLY with ZERO writes.
    """
    root = Path(project_root)
    plan = plan_sub_sync(root, saipen_home)
    problem = _sync_plan_problem(plan)
    if problem is not None:
        return problem
    if not plan["drift"]:
        return Result(
            ok=True,
            code="SUB_SYNC",
            data={
                "changed": [],
                "deleted": [],
                "drift": False,
                "inventory_established": False,
                "dry_run": dry_run,
            },
        )

    changed = plan["changed"]
    delete_files = plan["delete_files"]
    delete_dirs = plan["delete_dirs"]
    writes = [
        {"path": item["path"], "role": item.get("role", "manifest"), "content": item["content"]}
        for item in changed
    ]
    mutation_targets = [*delete_files, *delete_dirs, *writes]
    proposed_writes = [item["path"] for item in changed]
    proposed_deletes = [item["path"] for item in (*delete_files, *delete_dirs)]
    proposed = [item["path"] for item in mutation_targets]
    if dry_run:
        return Result(
            ok=True,
            code="SUB_SYNC",
            data={
                "changed": proposed,
                "drift": True,
                "dry_run": True,
                "would_write": proposed_writes,
                "would_delete": proposed_deletes,
                "would_record_receipt": True,
                "inventory_established": plan["receipt"] is None,
            },
        )
    op_id = "sub-sync-" + __import__("uuid").uuid4().hex[:8]
    preconditions = {item["path"]: item["before_hash"] for item in changed}
    preconditions.update({item["path"]: item["expected_hash"] for item in delete_files})
    semantic = json.dumps(plan["receipt_metadata"], sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )
    actor = agent or "saipen-cli"
    with project_writer_lock(root):
        if not _sources_unchanged(changed):
            return _refuse(
                "STALE_STATE", "shared-contract source changed after sync planning; replan"
            )
        commit = run_mutation(
            root,
            op_id,
            "sub_sync",
            actor,
            project_identity(root),
            hash_bytes(b"sub_sync:" + semantic),
            mutation_targets,
            preconditions=preconditions,
            read_preconditions={
                **{str(plan["source_root"].resolve()): plan["source_tree_plan_hash"]},
                **_external_read_preconditions(changed),
            },
            verification_policy="sub_sync",
            receipt_metadata=plan["receipt_metadata"],
        )
    if not commit.get("ok"):
        return _refuse(commit.get("code", "VALIDATION_FAILED"), commit.get("detail", ""))
    return Result(
        ok=True,
        code="SUB_SYNC",
        op_id=op_id,
        changed_files=proposed,
        data={
            "changed": proposed,
            "deleted": proposed_deletes,
            "drift": True,
            "inventory_established": plan["receipt"] is None,
        },
    )


# ---------------------------------------------------------------------------
# spawn
# ---------------------------------------------------------------------------
def sub_spawn(
    project_root: Path | str,
    name: str,
    saipen_home: str,
    agent: str | None = None,
    dry_run: bool = False,
) -> Result:
    """Bootstrap-and-spawn a subSaipen, journaled (PROTOCOL.md section 7).

    KNOWN INVALID BASE MUST NOT BE MUTATED (Wave 2 item 6): every
    predictable spawn prerequisite is validated READ-ONLY before any write --
    safe role ID, target absence, strict MANIFEST grammar, the shared-contract
    sync PLAN (the SAME verdict sub_sync APPLY uses, item 7/8), source-home
    and TEMPLATE completeness, role charter/generic role evidence, the
    proposed role_revision, the proposed resulting MANIFEST and the proposed
    worker STATE/BOARD grammar. Only when all are valid may mutation begin;
    there is no rollback because a predictable invalid plan never started.

    The shared contract surface is repaired first as a SEPARATE committed
    sync operation when the plan needs it, then the spawn plan is REPLANNED
    against the new canonical state (one operation's AFTER is the next
    operation's BEFORE). `dry_run` consumes the same plan/verdicts with ZERO
    writes and reports would_result -- the mutation did not happen.
    """
    root = Path(project_root)
    try:
        from userperson import UserpersonError, effective_projection

        userperson_projection = effective_projection(root, name)
    except UserpersonError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            exc.detail,
            scope=exc.scope,
            userperson_code=exc.code,
            name=name,
        )
    # W2-004: pending-recovery admission BEFORE any post-apply state-derived
    # idempotence check. A target that appears to exist may be the partial
    # effect of a crash-left PREPARED op; recovery must settle it first.
    if not dry_run:
        from .journal import recovery_preflight

        pre = recovery_preflight(root)
        if not pre["ok"]:
            return _refuse(pre.get("code", "RECOVERY_REQUIRED"), pre.get("detail", ""), name=name)
    try:
        target = _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    except OSError as exc:
        # T-1013: a valid-looking but over-long ID (or an owner root already
        # near the host path budget) can still fail the FILESYSTEM probe,
        # even after the shared length budget -- a dry-run/JSON boundary must
        # refuse structurally with zero writes, never traceback.
        return _refuse(
            "VALIDATION_FAILED", f"cannot probe subSaipen path for {name!r}: {exc}", name=name
        )
    try:
        target_exists = target.exists()
    except OSError as exc:
        return _refuse(
            "VALIDATION_FAILED", f"cannot probe subSaipen path for {name!r}: {exc}", name=name
        )
    if target_exists:
        return _refuse(
            "ALREADY_CLAIMED",
            f"subSaipen {name!r} already exists; run "
            f"`saipen sub clean {name}` first if replacement is "
            "intended",
            name=name,
        )
    try:
        instance_tree_hash = hash_tree(target)
    except OSError as exc:
        return _refuse(
            "VALIDATION_FAILED", f"cannot hash subSaipen path for {name!r}: {exc}", name=name
        )

    # 1. Strict MANIFEST grammar FIRST -- a malformed registry is a KNOWN
    # invalid base; refusing it must not follow any write (item 6).
    manifest = root / MANIFEST_REL
    manifest_raw = _read_bytes_maybe(manifest)
    try:
        manifest_text = _decode_captured(manifest_raw, MANIFEST_REL)
    except ValueError as exc:
        return _refuse("INVALID_MANIFEST", str(exc), name=name)
    if manifest_text.strip():
        _entries, manifest_errors = parse_manifest(manifest_text)
        if manifest_errors:
            return _refuse(
                "INVALID_MANIFEST",
                "MANIFEST malformed; spawn refused: " + "; ".join(manifest_errors[:5]),
                errors=manifest_errors,
            )
    if not manifest_text.strip():
        # Fresh bootstrap: the strict parser requires the exact header, so
        # the first spawn writes it -- a header-less manifest would make the
        # very registry this command maintains INVALID_MANIFEST.
        new_manifest = MANIFEST_HEADER + f"\n\n- {name} -- {SUBS_REL}/{name}/\n"
    else:
        if not manifest_text.startswith(MANIFEST_HEADER):
            manifest_text = MANIFEST_HEADER + "\n\n" + manifest_text
        new_manifest = manifest_text.rstrip("\n") + "\n" + f"- {name} -- {SUBS_REL}/{name}/\n"
    _parsed_new_manifest, new_manifest_errors = parse_manifest(new_manifest)
    if new_manifest_errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed resulting MANIFEST invalid: " + "; ".join(new_manifest_errors[:3]),
            name=name,
        )

    # 2. READ-ONLY shared-contract sync PLAN (items 6/7/8): the SAME verdict
    # sub_sync APPLY computes, so dry-run and APPLY refuse identically and no
    # predictable refusal (invalid source home, ambiguous lineage, kind
    # changes, conflicts, unexpected inherited files) can follow a mutation.
    sync_plan = plan_sub_sync(root, saipen_home)
    problem = _sync_plan_problem(sync_plan)
    if problem is not None:
        return problem

    # 3. Template completeness + role evidence + proposed role_revision and
    # proposed STATE/BOARD grammar -- all read-only (item 6).
    template_root = Path(saipen_home) / "extensions" / "subs" / "TEMPLATE"
    template_paths = {
        "STATE.md": template_root / "STATE.md",
        "BOARD.md": template_root / "BOARD.md",
        "LOG.md": template_root / "LOG.md",
        "kitchen/OUTBOX.md": template_root / "kitchen" / "OUTBOX.md",
    }
    template_raw = {rel: _read_bytes_maybe(path) for rel, path in template_paths.items()}
    if any(raw is None for raw in template_raw.values()):
        return _refuse(
            "VALIDATION_FAILED",
            f"saipen_home {saipen_home!r} has incomplete subSaipen TEMPLATE; "
            "clone/refresh before spawning",
            name=name,
        )
    role_source = Path(saipen_home) / "extensions" / "subs" / f"{name}.md"
    generic_role = not role_source.is_file()
    if generic_role:
        role_source = Path(saipen_home) / "extensions" / "subs" / "PROTOCOL.md"
    role_raw = _read_bytes_maybe(role_source)
    try:
        role_revision = (
            _role_revision_from_bytes(role_raw, generic=generic_role)
            if role_raw is not None
            else None
        )
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), name=name)
    if not role_revision or role_raw is None:
        return _refuse(
            "VALIDATION_FAILED",
            f"no role evidence to anchor spawn of {name!r}: no "
            "built-in charter and no PROTOCOL.md (ROLE_EVIDENCE_"
            "UNAVAILABLE) -- a strict worker never gets a blank "
            "role identity; refresh the install and run "
            "`saipen sub sync`",
            name=name,
        )
    now = _utc_iso()
    template_state_doc = codec.read_document(template_paths["STATE.md"])
    state = template_state_doc.text_norm
    state = patch_state(
        state,
        {
            "agent": name,
            "saipen_home": saipen_home,
            "updated": now,
            "role_revision": role_revision,
        },
    )
    from .state import parse_state as _parse_sub_state_text

    proposed_state = _parse_sub_state_text(state)
    state_errors = validate_sub_state(proposed_state)
    if state_errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed worker STATE fails lifecycle grammar: " + "; ".join(state_errors[:3]),
            name=name,
        )
    board_errors = parse_sub_board(
        _decode_captured(template_raw["BOARD.md"], f"{SUBS_REL}/{name}/BOARD.md"),
        expected_role=name,
    )["errors"]
    if board_errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed worker BOARD fails lifecycle grammar: " + "; ".join(board_errors[:3]),
            name=name,
        )

    # 4. APPLY sync as a SEPARATE committed operation only when the plan
    # needs it, then REPLAN spawn from the new canonical state (item 8).
    sync_result = None
    sync_changed = []
    if not dry_run and sync_plan["drift"]:
        # T-1006: the bootstrap sync is part of the SAME invocation, so it
        # journals under the SAME canonical acting seat -- never a hardcoded
        # CLI identity that disagrees with the spawn receipt that follows.
        sync_result = sub_sync(root, saipen_home, agent=agent)
        if not sync_result.ok:
            return _refuse(
                sync_result.code,
                "shared-contract bootstrap refused: " + sync_result.message,
                name=name,
                sync=sync_result.data,
            )
        sync_changed = list(sync_result.changed_files)
        # REPLAN against post-sync truth: re-read the MANIFEST and re-verify
        # target absence (sync never touches either, but the AFTER state is
        # the only state the spawn plan may be built from).
        manifest_raw = _read_bytes_maybe(manifest)
        if target.exists():
            return _refuse(
                "ALREADY_CLAIMED",
                f"subSaipen {name!r} appeared during bootstrap; refusing overwrite",
                name=name,
            )

    source_tree_plan_hash = hash_tree(Path(saipen_home) / "extensions" / "subs")
    targets, invalid = _shared_contract_targets(saipen_home)
    if invalid:
        return _refuse("VALIDATION_FAILED", invalid, name=name)
    # Only copy what is still missing/stale locally AFTER sync (partial-
    # bootstrap repair); a shared contract that moves during the transaction
    # is a race, not a bootstrap to paper over.
    shared = []
    for t in targets:
        local = root / t["path"]
        local_raw = _read_bytes_maybe(local)
        if local_raw != t["content"]:
            shared.append({**t, "before_hash": _captured_hash(local_raw)})
    if not dry_run and shared:
        return _refuse(
            "STALE_STATE",
            "shared contract changed immediately after bootstrap sync; retry "
            "spawn against a stable saipen_home",
            name=name,
        )
    inbox_src = Path(saipen_home) / "extensions" / "subs" / "_shared" / "inbox.md"
    local_inbox = root / f"{SUBS_REL}/_shared/inbox.md"
    local_inbox_raw = _read_bytes_maybe(local_inbox)
    if inbox_src.is_file() and local_inbox_raw is None:
        inbox_raw = inbox_src.read_bytes()
        shared.append(
            {
                "path": f"{SUBS_REL}/_shared/inbox.md",
                "content": inbox_raw,
                "before_hash": "",
                "source_path": str(inbox_src.resolve()),
                "source_hash": hash_bytes(inbox_raw),
            }
        )

    mutation_targets = [t for t in shared]
    mutation_targets += [
        {
            "path": f"{SUBS_REL}/{name}/STATE.md",
            "role": "state",
            "content": template_state_doc.encode(state),
            "before_hash": "",
        },
        {
            "path": f"{SUBS_REL}/{name}/BOARD.md",
            "role": "board",
            "content": template_raw["BOARD.md"],
            "before_hash": "",
        },
        {
            "path": f"{SUBS_REL}/{name}/LOG.md",
            "role": "log",
            "content": template_raw["LOG.md"],
            "before_hash": "",
        },
        {
            "path": f"{SUBS_REL}/{name}/kitchen/OUTBOX.md",
            "role": "report",
            "content": template_raw["kitchen/OUTBOX.md"],
            "before_hash": "",
        },
        {
            "path": MANIFEST_REL,
            "role": "manifest",
            "content": new_manifest.encode("utf-8"),
            "before_hash": _captured_hash(manifest_raw),
        },
    ]
    source_preconditions = {
        str((Path(saipen_home) / "extensions" / "subs").resolve()): source_tree_plan_hash
    }
    source_preconditions.update(_external_read_preconditions(shared))
    source_preconditions.update(
        {
            str(path.resolve()): _captured_hash(template_raw[rel])
            for rel, path in template_paths.items()
        }
    )
    source_preconditions[str(role_source.resolve())] = hash_bytes(role_raw)
    write_preconditions = {item["path"]: item["before_hash"] for item in mutation_targets}
    proposed = [t["path"] for t in mutation_targets]
    if dry_run:
        return Result(
            ok=True,
            code="SUB_SPAWN_PLAN",
            data={
                "name": name,
                "path": f"{SUBS_REL}/{name}/",
                "bootstrap": bool(sync_plan["drift"] or shared),
                "would_sync": bool(sync_plan["drift"]),
                "role_revision": role_revision,
                "dry_run": True,
                "would_result": "SPAWNED",
                "would_write": proposed,
                **(
                    {"userperson_projection": userperson_projection}
                    if userperson_projection["active"]
                    else {}
                ),
            },
        )
    op_id = "sub-spawn-" + __import__("uuid").uuid4().hex[:8]
    with project_writer_lock(root):
        if hash_tree(target) != instance_tree_hash:
            return _refuse(
                "STALE_STATE", f"subSaipen {name!r} target changed after planning", name=name
            )
        commit = run_mutation(
            root,
            op_id,
            "sub_spawn",
            agent or name,
            project_identity(root),
            hash_bytes(("sub_spawn:" + name).encode("utf-8")),
            mutation_targets,
            preconditions=write_preconditions,
            read_preconditions=source_preconditions,
            verification_policy="sub_lifecycle",
        )
    if not commit.get("ok"):
        return _refuse(commit.get("code", "VALIDATION_FAILED"), commit.get("detail", ""), name=name)
    return Result(
        ok=True,
        code="SPAWNED",
        op_id=op_id,
        changed_files=[*sync_changed, *proposed],
        data={
            "name": name,
            "path": f"{SUBS_REL}/{name}/",
            "bootstrap": bool(sync_changed),
            "sync_op_id": sync_result.op_id if sync_result else None,
            "role_revision": role_revision,
            **(
                {"userperson_projection": userperson_projection}
                if userperson_projection["active"]
                else {}
            ),
        },
    )


def _lifecycle_read_preconditions(
    root: Path, name: str, manifest_raw: bytes | None, saipen_home: str = ""
) -> dict[str, str]:
    dependencies = {MANIFEST_REL: _captured_hash(manifest_raw)}
    board_rel = f"{SUBS_REL}/{name}/BOARD.md"
    dependencies[board_rel] = _captured_hash(_read_bytes_maybe(root / board_rel))
    charter_rel = f"{SUBS_REL}/{name}.md"
    dependencies[charter_rel] = _captured_hash(_read_bytes_maybe(root / charter_rel))
    protocol_rel = f"{SUBS_REL}/PROTOCOL.md"
    dependencies[protocol_rel] = _captured_hash(_read_bytes_maybe(root / protocol_rel))
    if saipen_home:
        home_charter = (Path(saipen_home) / "extensions" / "subs" / f"{name}.md").resolve()
        dependencies[str(home_charter)] = _captured_hash(_read_bytes_maybe(home_charter))
    return dependencies


# ---------------------------------------------------------------------------
# adopt
# ---------------------------------------------------------------------------
def sub_adopt(
    project_root: Path | str,
    name: str,
    saipen_home: str,
    agent: str | None = None,
    dry_run: bool = False,
) -> Result:
    """Re-anchor a sub under the CURRENT project-local charter (PROTOCOL § 6).

    The local charter is the only authority: a built-in charter present in
    saipen_home but missing locally is SYNC_REQUIRED / ROLE_EVIDENCE_-
    UNAVAILABLE, never silently replaced by the home copy. A generic role
    adopts against the local PROTOCOL digest. `dry_run` computes the same
    patch with ZERO writes.
    """
    root = Path(project_root)
    try:
        from userperson import UserpersonError, effective_projection

        userperson_projection = effective_projection(root, name)
    except UserpersonError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            exc.detail,
            scope=exc.scope,
            userperson_code=exc.code,
            name=name,
        )
    try:
        _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    manifest_raw, entry, manifest_errors = _registered_entry(root, name)
    if manifest_errors:
        return _refuse(
            "INVALID_MANIFEST", "; ".join(manifest_errors[:5]), name=name, errors=manifest_errors
        )
    state_path = _entry_dir(root, entry) / "STATE.md"
    if not state_path.is_file():
        return _refuse("TICKET_NOT_FOUND", f"no subSaipen {name!r}", name=name)
    local_charter = root / SUBS_REL / f"{name}.md"
    home_charter = Path(saipen_home) / "extensions" / "subs" / f"{name}.md"
    local_protocol = root / SUBS_REL / "PROTOCOL.md"
    role_raw = None
    home_charter_raw = _read_bytes_maybe(home_charter)
    try:
        if local_charter.is_file():
            role_raw = local_charter.read_bytes()
            role_revision = _role_revision_from_bytes(role_raw, generic=False)
        elif home_charter_raw is not None:
            return _refuse(
                "VALIDATION_FAILED",
                f"{name!r} has a built-in charter in saipen_home "
                "but not project-locally -- SYNC_REQUIRED: run "
                "`saipen sub sync`; ROLE_EVIDENCE_UNAVAILABLE",
                name=name,
            )
        elif local_protocol.is_file():
            role_raw = local_protocol.read_bytes()
            role_revision = _role_revision_from_bytes(role_raw, generic=True)
        else:
            return _refuse(
                "VALIDATION_FAILED",
                f"no local charter or PROTOCOL.md for {name!r} -- "
                "run `saipen sub sync`; ROLE_EVIDENCE_UNAVAILABLE",
                name=name,
            )
    except (ValueError, OSError) as exc:
        return _refuse(
            "VALIDATION_FAILED", f"cannot derive role revision for {name!r}: {exc}", name=name
        )
    doc = codec.read_document(state_path)
    rel = f"{SUBS_REL}/{name}/STATE.md"
    new_text = patch_state(
        doc.text_norm,
        {
            "role_revision": role_revision,
            "updated": _utc_iso(),
        },
    )
    lifecycle_reads = _lifecycle_read_preconditions(root, name, manifest_raw, saipen_home)
    actor = agent or "saipen-cli"
    if dry_run:
        return Result(
            ok=True,
            code="SUB_ADOPT_PLAN",
            data={
                "name": name,
                "role_revision": role_revision,
                "dry_run": True,
                "would_result": "SUB_ADOPTED",
                "would_write": [rel],
                **(
                    {"userperson_projection": userperson_projection}
                    if userperson_projection["active"]
                    else {}
                ),
            },
        )
    op_id = "sub-adopt-" + __import__("uuid").uuid4().hex[:8]
    with project_writer_lock(root):
        commit = run_mutation(
            root,
            op_id,
            "sub_adopt",
            actor,
            project_identity(root),
            hash_bytes(("sub_adopt:" + name).encode("utf-8")),
            [
                {
                    "path": rel,
                    "role": "state",
                    "content": doc.encode(new_text),
                    "before_hash": doc.raw_hash,
                    "after_hash": hash_bytes(doc.encode(new_text)),
                }
            ],
            preconditions={rel: doc.raw_hash},
            read_preconditions=lifecycle_reads,
            verification_policy="sub_lifecycle",
        )
    if not commit.get("ok"):
        return _refuse(commit.get("code", "VALIDATION_FAILED"), commit.get("detail", ""), name=name)
    return Result(
        ok=True,
        code="SUB_ADOPTED",
        op_id=op_id,
        changed_files=[rel],
        data={
            "name": name,
            "role_revision": role_revision,
            **(
                {"userperson_projection": userperson_projection}
                if userperson_projection["active"]
                else {}
            ),
        },
    )


# ---------------------------------------------------------------------------
# pause / resume
# ---------------------------------------------------------------------------
def sub_pause(
    project_root: Path | str, name: str, agent: str | None = None, dry_run: bool = False
) -> Result:
    """Pause a subSaipen: record prior phase/next_action, then BLOCKED.

    The prior execution state is stored conditionally on the sub's STATE as
    owned pause-lifecycle metadata (`paused_from_phase` / `paused_from_na`)
    so resume can restore it deterministically. A trace line is appended to
    the sub's own LOG. `dry_run` performs the same validation and computes
    the same patch with ZERO writes/LOG/STATE/journal.
    """
    root = Path(project_root)
    if not dry_run:
        from .journal import recovery_preflight

        pre = recovery_preflight(root)
        if not pre["ok"]:
            return _refuse(pre.get("code", "RECOVERY_REQUIRED"), pre.get("detail", ""), name=name)
    try:
        _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    manifest_raw, entry, manifest_errors = _registered_entry(root, name)
    if manifest_errors:
        return _refuse(
            "INVALID_MANIFEST", "; ".join(manifest_errors[:5]), name=name, errors=manifest_errors
        )
    state_path = _entry_dir(root, entry) / "STATE.md"
    if not state_path.is_file():
        return _refuse("TICKET_NOT_FOUND", f"no subSaipen {name!r}", name=name)
    doc = codec.read_document(state_path)
    from .state import parse_state_or_error

    st, state_error = parse_state_or_error(doc.text_norm)
    if state_error:
        return _refuse(
            "VALIDATION_FAILED", f"subSaipen {name!r} STATE is malformed: {state_error}", name=name
        )
    if st.get("phase") == "BLOCKED":
        return _refuse("VALIDATION_FAILED", f"subSaipen {name!r} is already BLOCKED", name=name)
    rel = f"{SUBS_REL}/{name}/STATE.md"
    new_text = patch_state(
        doc.text_norm,
        {
            "phase": "BLOCKED",
            "blocker": "paused by main agent",
            "paused_from_phase": st.get("phase") or "PLAN",
            "paused_from_na": st.get("next_action") or "saipen plan",
            "updated": _utc_iso(),
        },
    )
    targets = [
        {
            "path": rel,
            "role": "state",
            "content": doc.encode(new_text),
            "before_hash": doc.raw_hash,
            "after_hash": hash_bytes(doc.encode(new_text)),
        }
    ]
    log_rel = f"{SUBS_REL}/{name}/LOG.md"
    log_raw = _read_bytes_maybe(root / log_rel)
    actor = agent or "saipen-cli"
    targets.extend(
        _sub_trace_targets(
            root,
            name,
            "pause",
            f"paused by main agent (from {st.get('phase')})",
            log_raw,
            agent=actor,
        )
    )
    lifecycle_reads = _lifecycle_read_preconditions(
        root, name, manifest_raw, st.get("saipen_home") or ""
    )
    if dry_run:
        return Result(
            ok=True,
            code="SUB_PAUSE_PLAN",
            data={
                "name": name,
                "paused_from_phase": st.get("phase"),
                "dry_run": True,
                "would_result": "SUB_PAUSED",
                "would_write": [t["path"] for t in targets],
            },
        )
    op_id = "sub-pause-" + __import__("uuid").uuid4().hex[:8]
    with project_writer_lock(root):
        commit = run_mutation(
            root,
            op_id,
            "sub_pause",
            actor,
            project_identity(root),
            hash_bytes(("sub_pause:" + name).encode("utf-8")),
            targets,
            preconditions={rel: doc.raw_hash, log_rel: _captured_hash(log_raw)},
            read_preconditions=lifecycle_reads,
            verification_policy="sub_lifecycle",
        )
    if not commit.get("ok"):
        return _refuse(commit.get("code", "VALIDATION_FAILED"), commit.get("detail", ""), name=name)
    return Result(
        ok=True,
        code="SUB_PAUSED",
        op_id=op_id,
        changed_files=[t["path"] for t in targets],
        data={"name": name, "paused_from_phase": st.get("phase")},
    )


def sub_resume(
    project_root: Path | str, name: str, agent: str | None = None, dry_run: bool = False
) -> Result:
    """Resume a subSaipen: prove it was paused by us, restore exact prior
    phase + next_action, clear blocker and pause metadata, append trace.

    Refuses SUB_RESUME if the sub was not paused by the main agent or has no
    recorded prior state -- no fake success. `dry_run` computes the same
    patch with ZERO writes.
    """
    root = Path(project_root)
    if not dry_run:
        from .journal import recovery_preflight

        pre = recovery_preflight(root)
        if not pre["ok"]:
            return _refuse(pre.get("code", "RECOVERY_REQUIRED"), pre.get("detail", ""), name=name)
    try:
        _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    manifest_raw, entry, manifest_errors = _registered_entry(root, name)
    if manifest_errors:
        return _refuse(
            "INVALID_MANIFEST", "; ".join(manifest_errors[:5]), name=name, errors=manifest_errors
        )
    state_path = _entry_dir(root, entry) / "STATE.md"
    if not state_path.is_file():
        return _refuse("TICKET_NOT_FOUND", f"no subSaipen {name!r}", name=name)
    doc = codec.read_document(state_path)
    from .state import parse_state_or_error

    st, state_error = parse_state_or_error(doc.text_norm)
    if state_error:
        return _refuse(
            "VALIDATION_FAILED", f"subSaipen {name!r} STATE is malformed: {state_error}", name=name
        )
    if st.get("phase") != "BLOCKED" or st.get("blocker") != "paused by main agent":
        return _refuse(
            "VALIDATION_FAILED",
            f"subSaipen {name!r} is not paused by the main agent",
            name=name,
            phase=st.get("phase"),
        )
    prior_phase = st.get("paused_from_phase")
    prior_na = st.get("paused_from_na")
    if not prior_phase:
        return _refuse(
            "RECOVERY_REQUIRED",
            f"subSaipen {name!r} has no recorded paused state; "
            "restore phase/next_action from its LOG tail manually",
            name=name,
        )
    rel = f"{SUBS_REL}/{name}/STATE.md"
    new_text = patch_state(
        doc.text_norm,
        {
            "phase": prior_phase,
            "next_action": prior_na,
            "blocker": "",
            "paused_from_phase": "",
            "paused_from_na": "",
            "updated": _utc_iso(),
        },
    )
    targets = [
        {
            "path": rel,
            "role": "state",
            "content": doc.encode(new_text),
            "before_hash": doc.raw_hash,
            "after_hash": hash_bytes(doc.encode(new_text)),
        }
    ]
    log_rel = f"{SUBS_REL}/{name}/LOG.md"
    log_raw = _read_bytes_maybe(root / log_rel)
    actor = agent or "saipen-cli"
    targets.extend(
        _sub_trace_targets(
            root, name, "resume", f"resumed to {prior_phase}", log_raw, agent=actor
        )
    )
    lifecycle_reads = _lifecycle_read_preconditions(
        root, name, manifest_raw, st.get("saipen_home") or ""
    )
    if dry_run:
        return Result(
            ok=True,
            code="SUB_RESUME_PLAN",
            data={
                "name": name,
                "restored_phase": prior_phase,
                "restored_next_action": prior_na,
                "dry_run": True,
                "would_result": "SUB_RESUMED",
                "would_write": [t["path"] for t in targets],
            },
        )
    op_id = "sub-resume-" + __import__("uuid").uuid4().hex[:8]
    with project_writer_lock(root):
        commit = run_mutation(
            root,
            op_id,
            "sub_resume",
            actor,
            project_identity(root),
            hash_bytes(("sub_resume:" + name).encode("utf-8")),
            targets,
            preconditions={rel: doc.raw_hash, log_rel: _captured_hash(log_raw)},
            read_preconditions=lifecycle_reads,
            verification_policy="sub_lifecycle",
        )
    if not commit.get("ok"):
        return _refuse(commit.get("code", "VALIDATION_FAILED"), commit.get("detail", ""), name=name)
    return Result(
        ok=True,
        code="SUB_RESUMED",
        op_id=op_id,
        changed_files=[t["path"] for t in targets],
        data={"name": name, "restored_phase": prior_phase, "restored_next_action": prior_na},
    )


def _bounded_wait(value: object) -> str:
    """The producer's own WAIT, re-bounded to CORE § 1.2's shape (T-1435 M5).

    A historical producer STATE can carry a WAIT whose category is legal but
    whose body is several sentences (the measured saitranslate residue). The
    strict parser refuses to READ that state, so without a bounded rewrite the
    producer-owned reconciliation would be unreachable -- the exact deadlock
    T-1435 exists to remove. This helper keeps the FIRST sentence (the human
    action) and drops the rest; the producer's own journaled transaction is
    the only writer. An unparseable shape returns "" and the caller refuses.
    """
    from .state import WAIT_CATEGORIES

    text = str(value or "").strip()
    if not text.startswith("WAIT:"):
        return ""
    body = text[len("WAIT:") :].strip()
    head, sep, tail = body.partition(" -- ")
    if sep:
        category = head.strip().lower()
        sentence = tail.strip()
    else:
        category = ""
        sentence = body
    if category not in WAIT_CATEGORIES:
        category = "manual-verify"
    sentence = re.split(r"\.\s+(?=[A-Z`])", sentence)[0].strip()
    sentence = re.sub(r"\s+", " ", sentence).strip()
    if not sentence:
        sentence = "producer terminal residue recorded; session status belongs in the sub LOG"
    if len(sentence) > 400:
        cut = sentence[:400]
        space = cut.rfind(" ")
        sentence = (cut[:space] if space > 0 else cut).strip()
    return f"WAIT: {category} -- {sentence}"


def sub_reconcile(
    project_root: Path | str,
    name: str,
    agent: str | None = None,
    *,
    authority: str = "",
    dry_run: bool = False,
) -> Result:
    """Producer-owned terminal reconciliation (T-1435 M5).

    A producer's STATE and BOARD can contradict each other (the measured
    FastPrompter incident: saitranslate/saiwiki DONE with a live task, saiwiki
    DONE with open BOARD work). Core may DETECT and ROUTE that contradiction
    but must never patch another producer's canonical files, and it must never
    clear unfinished work to make a ship gate green. This is the finite,
    producer-owned repair: ONE side-effect-free predicate
    (:func:`terminal_consistency`) decides the truth, and this transaction
    writes the producer's OWN STATE plus a producer-attributed LOG event.

    Outcomes:
      OUTCOME A (STALE_STATE)      terminal BOARD proves the task/reference
                                   residue stale -> clear it, stay DONE.
      OUTCOME B (MUST_RESUME /     real open Work -> truthful nonterminal
      DONE_CLAIM_FALSE /           projection; the open rows are untouched.
      MUST_BLOCK)
      CLEAN                        already coherent -> no-op, zero writes.
      NONTERMINAL                  producer is not in DONE; nothing to do here.

    Authority is MANDATORY: dropping a terminal claim is never anonymous. It
    must be a receipt this project already owns, and it is named in the LOG
    event. Any malformed STATE/BOARD, a foreign producer owner, or a proposed
    state that fails the role grammar refuses with ZERO writes -- and the
    journal's own `sub_lifecycle` verification is the write-time backstop.
    """
    root = Path(project_root)
    name = str(name or "").strip()
    authority = str(authority or "").strip().upper()
    if not authority:
        return _refuse(
            "SUB_RECONCILE_AUTHORITY_REQUIRED",
            "producer reconciliation requires --authority <SRC-###>: a receipt "
            "this project owns that names the reconciliation decision",
            name=name,
        )
    from . import metadata_repair

    if not authority.startswith("SRC-") or not metadata_repair.receipt_exists(root, authority):
        return _refuse(
            "SUB_RECONCILE_AUTHORITY_INVALID",
            f"authority receipt {authority!r} does not exist in this project's "
            "intake history",
            name=name,
        )
    if not dry_run:
        from .journal import recovery_preflight

        pre = recovery_preflight(root)
        if not pre["ok"]:
            return _refuse(pre.get("code", "RECOVERY_REQUIRED"), pre.get("detail", ""), name=name)
    try:
        _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    manifest_raw, entry, manifest_errors = _registered_entry(root, name)
    if manifest_errors:
        return _refuse(
            "INVALID_MANIFEST", "; ".join(manifest_errors[:5]), name=name, errors=manifest_errors
        )
    state_path = _entry_dir(root, entry) / "STATE.md"
    if not state_path.is_file():
        return _refuse("TICKET_NOT_FOUND", f"no subSaipen {name!r}", name=name)
    doc = codec.read_document(state_path)
    from .state import parse_state_or_error

    st, state_error = parse_state_or_error(doc.text_norm)
    malformed_wait = False
    if state_error:
        if "next_action is a malformed WAIT" in state_error:
            # The ONE observed damage class with a finite producer-owned
            # rewrite: the category is legal, the BODY is not bounded. Read
            # leniently so the contradiction can be seen at all; the proposal
            # below is still proved against the strict grammar before commit.
            malformed_wait = True
            from .state import parse_frontmatter

            st, _lenient_error = parse_frontmatter(doc.text_norm)
            if not st:
                return _refuse(
                    "VALIDATION_FAILED",
                    f"subSaipen {name!r} STATE is malformed -- reconciliation "
                    f"refuses with zero writes: {state_error}",
                    name=name,
                )
        else:
            return _refuse(
                "VALIDATION_FAILED",
                f"subSaipen {name!r} STATE is malformed -- reconciliation refuses "
                f"with zero writes: {state_error}",
                name=name,
            )
    board_path = state_path.parent / "BOARD.md"
    board_text = board_path.read_text(encoding="utf-8-sig") if board_path.is_file() else ""
    parsed_board = parse_sub_board(board_text, expected_role=name)
    if parsed_board["errors"]:
        return _refuse(
            "VALIDATION_FAILED",
            f"subSaipen {name!r} BOARD is malformed -- reconciliation refuses "
            f"with zero writes: {'; '.join(parsed_board['errors'][:3])}",
            name=name,
        )
    owner = str(st.get("agent") or "").strip()
    if owner and owner != name:
        return _refuse(
            "SUB_RECONCILE_OWNERSHIP_CONFLICT",
            f"subSaipen {name!r} STATE.agent is {owner!r}, not the producer "
            "itself -- Core never takes over a foreign producer seat; the "
            "recorded owner must reconcile or release it first",
            name=name,
        )
    verdict = terminal_consistency(st, parsed_board)
    surfaces = {
        "doing": verdict["doing"],
        "todo": verdict["todo"],
        "blocked": verdict["blocked"],
        "state_residue": verdict["state_residue"],
    }
    kind = verdict["verdict"]
    if kind == "CLEAN":
        return Result(
            ok=True,
            code="SUB_RECONCILE_CLEAN",
            data={"name": name, "verdict": kind, "contradictory_surfaces": surfaces},
        )
    if kind == "NONTERMINAL":
        return _refuse(
            "SUB_RECONCILE_NOT_TERMINAL",
            f"subSaipen {name!r} phase is {st.get('phase')!r}; terminal "
            "reconciliation only repairs a DONE claim against its own BOARD",
            name=name,
        )
    updates: dict[str, str] = {"updated": _utc_iso()}
    if kind == "STALE_STATE":
        updates.update({"task": "none", "blocker": ""})
        if malformed_wait:
            bounded = _bounded_wait(st.get("next_action"))
            if not bounded:
                return _refuse(
                    "VALIDATION_FAILED",
                    f"subSaipen {name!r} carries a malformed WAIT that cannot "
                    "be bounded to one sentence; the producer must rewrite it",
                    name=name,
                )
            updates["next_action"] = bounded
        outcome = "OUTCOME_A_STALE_STATE_CLEARED"
    elif kind == "MUST_RESUME":
        # A sub ticket uses the role's own prefix, and the shared `PHASE ...`
        # grammar only admits a T-### ref -- so the truthful projection is the
        # non-ticket-bearing PLAN phase with the DOING ticket bound to `task`
        # (exactly what validate_sub_lifecycle checks for that phase).
        ticket = verdict["doing"][0]
        updates.update(
            {
                "phase": "PLAN",
                "task": ticket,
                "blocker": "",
                "next_action": "PHASE PLAN",
            }
        )
        outcome = "OUTCOME_B_RESUMED_NONTERMINAL"
    elif kind == "DONE_CLAIM_FALSE":
        updates.update(
            {
                "phase": "PLAN",
                "task": "none",
                "blocker": "",
                "next_action": "PHASE PLAN",
            }
        )
        outcome = "OUTCOME_B_RESUMED_NONTERMINAL"
    else:  # MUST_BLOCK
        ticket = verdict["blocked"][0]
        row = parsed_board["tickets"].get(ticket) or {}
        description = str(row.get("description") or "").strip().split(" | ")[0].strip()
        why = f"{ticket}: {description}" if description else f"{ticket} awaits external resolution"
        updates.update(
            {"phase": "BLOCKED", "task": "none", "blocker": why, "next_action": "PHASE BLOCKED"}
        )
        outcome = "OUTCOME_B_BLOCKED_NONTERMINAL"
    new_text = patch_state(doc.text_norm, updates)
    from .state import parse_state as _parse_state_text

    proposed_state = _parse_state_text(new_text)
    proposed_errors = validate_sub_state(proposed_state) + validate_sub_lifecycle(
        proposed_state, parsed_board, name
    )
    if proposed_errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed reconciliation fails the producer lifecycle grammar: "
            + "; ".join(proposed_errors[:3]),
            name=name,
        )
    rel = f"{SUBS_REL}/{name}/STATE.md"
    log_rel = f"{SUBS_REL}/{name}/LOG.md"
    log_raw = _read_bytes_maybe(root / log_rel)
    targets = [
        {
            "path": rel,
            "role": "state",
            "content": doc.encode(new_text),
            "before_hash": doc.raw_hash,
            "after_hash": hash_bytes(doc.encode(new_text)),
        }
    ]
    # Producer attribution: the role itself is the event's agent; the Core
    # dispatcher and the authority are named inside the message.
    targets.extend(
        _sub_trace_targets(
            root,
            name,
            "reconcile",
            f"terminal reconciliation {kind} -> {outcome}; dispatched by "
            f"{agent or 'saipen-cli'}; authority {authority}"
            + ("; malformed WAIT re-bounded to one sentence" if malformed_wait else ""),
            log_raw,
            agent=name,
        )
    )
    lifecycle_reads = _lifecycle_read_preconditions(
        root, name, manifest_raw, st.get("saipen_home") or ""
    )
    if dry_run:
        return Result(
            ok=True,
            code="SUB_RECONCILE_PLAN",
            data={
                "name": name,
                "verdict": kind,
                "outcome": outcome,
                "contradictory_surfaces": surfaces,
                "authority": authority,
                "normalized_wait": malformed_wait,
                "dry_run": True,
                "would_result": "SUB_RECONCILED",
                "would_write": [t["path"] for t in targets],
            },
        )
    op_id = "sub-reconcile-" + __import__("uuid").uuid4().hex[:8]
    with project_writer_lock(root):
        commit = run_mutation(
            root,
            op_id,
            "sub_reconcile",
            agent or "saipen-cli",
            project_identity(root),
            hash_bytes(("sub_reconcile:" + name + ":" + kind).encode("utf-8")),
            targets,
            preconditions={
                rel: doc.raw_hash,
                log_rel: _captured_hash(log_raw),
            },
            read_preconditions=lifecycle_reads,
            verification_policy="sub_lifecycle",
            receipt_metadata={
                "producer": name,
                "verdict": kind,
                "outcome": outcome,
                "authority": authority,
                "dispatched_by": agent or "saipen-cli",
            },
        )
    if not commit.get("ok"):
        return _refuse(commit.get("code", "VALIDATION_FAILED"), commit.get("detail", ""), name=name)
    return Result(
        ok=True,
        code="SUB_RECONCILED",
        op_id=op_id,
        changed_files=[t["path"] for t in targets],
        data={
            "name": name,
            "verdict": kind,
            "outcome": outcome,
            "contradictory_surfaces": surfaces,
            "authority": authority,
            "normalized_wait": malformed_wait,
        },
    )


def _target_dict(plan) -> dict:
    """The journal TARGET SHAPE for one prepared write target.

    T-1326 P0: a prepared LOG detail artifact is a `TargetPlan`, while the
    sub-lifecycle planners commit plain target dicts -- so the ONE conversion
    lives here instead of at each producer.
    """
    return {
        "path": plan.path,
        "role": plan.role,
        "content": plan.content,
        "before_hash": plan.before_hash,
        "after_hash": plan.after_hash,
    }


def _sub_trace_targets(
    root: Path,
    name: str,
    action: str,
    message: str,
    log_raw: bytes | None,
    agent: str = "saipen-cli",
) -> list[dict]:
    """One trace line appended to the sub's own LOG (PROTOCOL traceability).

    T-1326 P0: the trace message carries caller-supplied text, so this producer
    goes through the ONE shared bounded LOG builder. An oversized trace is
    externalized losslessly into the same journaled commit -- never truncated
    and never a hard refusal of the lifecycle verb that produced it.
    """
    from .log import log_tail_event, prepare_bounded_event

    log_rel = f"{SUBS_REL}/{name}/LOG.md"
    text = _decode_captured(log_raw, log_rel)
    tail = log_tail_event(text)
    _event, line, detail_targets = prepare_bounded_event(
        root,
        tail,
        "DEC",
        f"main agent {action}: {message}",
        ticket=None,
        agent=agent,
        now=_now(),
    )
    new_log = (text.rstrip("\n") + "\n" + line + "\n") if text else ("# Log\n\n" + line + "\n")
    return [
        *(_target_dict(plan) for plan in detail_targets),
        {
            "path": log_rel,
            "role": "log",
            "content": new_log.encode("utf-8"),
            "before_hash": _captured_hash(log_raw),
            "after_hash": hash_bytes(new_log.encode("utf-8")),
        },
    ]


def sub_clean_preflight(project_root: Path | str, name: str) -> Result:
    """Evidence-gated removal preflight (PROTOCOL section 7, read-only).

    Delegates the deterministic evidence scan to tools/sub_clean.py's
    sub_clean_blockers -- the SAME blockers `sub_clean` gates on. This
    read-only preflight reports every blocker; when clean, `sub_clean` may
    archive, unregister and remove the instance in one journaled mutation.
    """
    root = Path(project_root)
    try:
        _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    _manifest_raw, entry, manifest_errors = _registered_entry(root, name)
    if manifest_errors:
        missing_registration = (
            len(manifest_errors) == 1 and "is not registered" in manifest_errors[0]
        )
        return _refuse(
            "TICKET_NOT_FOUND" if missing_registration else "INVALID_MANIFEST",
            "; ".join(manifest_errors[:5]),
            name=name,
            errors=manifest_errors,
        )
    instance = _entry_dir(root, entry)
    if not instance.is_dir():
        return _refuse("TICKET_NOT_FOUND", f"no subSaipen {name!r}", name=name)
    try:
        from sub_clean import sub_clean_blockers

        blockers = sub_clean_blockers(instance, root / ".saipen" / "recovery" / "subs" / name)
    except RuntimeError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), name=name)
    if blockers:
        return _refuse(
            "VALIDATION_FAILED",
            "clean refused; " + "; ".join(blockers[:5]),
            name=name,
            blockers=list(blockers),
        )
    return Result(ok=True, code="CLEAN_PREFLIGHT", data={"name": name})


def _clean_manifest_bytes(raw: bytes, name: str) -> bytes:
    """Remove exactly one strict entry line while preserving all other bytes."""
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    kept = []
    removed = 0
    for raw_line in raw[len(bom) :].splitlines(keepends=True):
        line = raw_line.decode("utf-8")
        stripped = line.strip()
        matched_name = None
        if stripped.startswith("- "):
            head = stripped[2:].split("|", 1)[0].strip()
            match = _ENTRY_RE.fullmatch(head)
            if match:
                matched_name = match.group(1).strip()
        if matched_name == name:
            removed += 1
        else:
            kept.append(raw_line)
    if removed != 1:
        raise ValueError(f"strict MANIFEST contains {removed} entries for {name!r}")
    return bom + b"".join(kept)


def _capture_clean_instance(instance: Path) -> dict:
    """Capture every regular file and directory without crossing links."""
    from sub_clean import _is_reparse_point

    try:
        root_info = instance.lstat()
    except OSError as exc:
        raise RuntimeError(f"cannot stat cleanup instance {instance}: {exc}") from exc
    if not stat.S_ISDIR(root_info.st_mode) or instance.is_symlink() or _is_reparse_point(instance):
        raise RuntimeError("cleanup instance is not a regular owned directory")
    files: dict[str, bytes] = {}
    directories: list[str] = []
    errors: list[OSError] = []
    for current, dirnames, names in os.walk(
        instance, topdown=True, followlinks=False, onerror=errors.append
    ):
        dirnames.sort()
        names.sort()
        current_path = Path(current)
        directories.append(current_path.relative_to(instance).as_posix())
        for dirname in dirnames:
            candidate = current_path / dirname
            try:
                info = candidate.lstat()
            except OSError as exc:
                errors.append(exc)
                continue
            if (
                not stat.S_ISDIR(info.st_mode)
                or candidate.is_symlink()
                or _is_reparse_point(candidate)
            ):
                rel = candidate.relative_to(instance).as_posix()
                raise RuntimeError(f"cleanup refuses symlink, junction, or non-directory: {rel}")
        for filename in names:
            candidate = current_path / filename
            try:
                info = candidate.lstat()
            except OSError as exc:
                errors.append(exc)
                continue
            if (
                not stat.S_ISREG(info.st_mode)
                or candidate.is_symlink()
                or _is_reparse_point(candidate)
            ):
                rel = candidate.relative_to(instance).as_posix()
                raise RuntimeError(f"cleanup refuses symlink, junction, or non-regular file: {rel}")
            try:
                files[candidate.relative_to(instance).as_posix()] = candidate.read_bytes()
            except OSError as exc:
                errors.append(exc)
    if errors:
        raise RuntimeError(f"cannot capture cleanup instance: {errors[0]}")
    tree_hash = hash_delete_tree(instance)
    if not tree_hash.startswith("delete-tree-sha256:"):
        raise RuntimeError(f"cleanup instance tree is unsafe: {tree_hash}")
    return {"files": files, "directories": directories, "tree_hash": tree_hash}


def sub_clean(
    project_root: Path | str, name: str, agent: str | None = None, dry_run: bool = False
) -> Result:
    """Archive, unregister, and remove one SubSaipen transactionally."""
    root = Path(project_root)
    # W2-004: pending-recovery admission BEFORE any post-apply state-derived
    # ALREADY_CLEAN/ALREADY_CLAIMED check.
    if not dry_run:
        from .journal import recovery_preflight

        pre = recovery_preflight(root)
        if not pre["ok"]:
            return _refuse(pre.get("code", "RECOVERY_REQUIRED"), pre.get("detail", ""), name=name)
    try:
        instance = _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    manifest_raw = _read_bytes_maybe(root / MANIFEST_REL)
    if manifest_raw is None:
        return _refuse("INVALID_MANIFEST", "no MANIFEST.md", name=name)
    try:
        entries, manifest_errors = parse_manifest(_decode_captured(manifest_raw, MANIFEST_REL))
    except ValueError as exc:
        return _refuse("INVALID_MANIFEST", str(exc), name=name)
    if manifest_errors:
        return _refuse(
            "INVALID_MANIFEST", "; ".join(manifest_errors[:5]), name=name, errors=manifest_errors
        )
    entry = next((candidate for candidate in entries if candidate.name == name), None)
    if entry is None:
        if not os.path.lexists(instance):
            return Result(ok=True, code="ALREADY_CLEAN", data={"name": name})
        return _refuse(
            "RECOVERY_REQUIRED", f"unregistered instance still exists for {name!r}", name=name
        )
    try:
        if _entry_dir(root, entry).resolve() != instance.resolve():
            return _refuse(
                "PATH_ESCAPE", f"MANIFEST path does not bind {name!r} instance", name=name
            )
        snapshot = _capture_clean_instance(instance)
        from sub_clean import sub_clean_blockers

        blockers = sub_clean_blockers(instance, root / ".saipen" / "recovery" / "subs" / name)
        new_manifest = _clean_manifest_bytes(manifest_raw, name)
    except (RuntimeError, ValueError, OSError) as exc:
        return _refuse("VALIDATION_FAILED", str(exc), name=name)
    if blockers:
        return _refuse(
            "VALIDATION_FAILED",
            "clean refused; " + "; ".join(blockers[:5]),
            name=name,
            blockers=list(blockers),
        )

    op_id = "sub-clean-" + __import__("uuid").uuid4().hex[:8]
    archive_rel = f".saipen/recovery/subs/{name}/{op_id}"
    archive_instance_rel = f"{archive_rel}/instance"
    archive_root = root / archive_rel
    try:
        prove_inside(archive_root, root.resolve(), kind="sub clean archive")
        _reject_reparse_ancestors(root, archive_root)
    except ValueError as exc:
        return _refuse("PATH_ESCAPE", str(exc), name=name)
    file_hashes = {rel: hash_bytes(raw) for rel, raw in sorted(snapshot["files"].items())}
    receipt = {
        "operation": "sub_clean",
        "op_id": op_id,
        "name": name,
        "source_instance": f"{SUBS_REL}/{name}",
        "archive_instance": archive_instance_rel,
        "instance_tree_hash": snapshot["tree_hash"],
        "manifest_before_hash": hash_bytes(manifest_raw),
        "files": file_hashes,
    }
    receipt_raw = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode("utf-8")
    targets = [
        {
            "path": f"{archive_instance_rel}/{rel}",
            "role": "generic",
            "action": "write",
            "content": raw,
        }
        for rel, raw in sorted(snapshot["files"].items())
    ]
    targets.extend(
        [
            {
                "path": f"{archive_rel}/receipt.json",
                "role": "report",
                "action": "write",
                "content": receipt_raw,
            },
            {"path": MANIFEST_REL, "role": "manifest", "action": "write", "content": new_manifest},
        ]
    )
    source_prefix = f"{SUBS_REL}/{name}"
    targets.extend(
        {"path": f"{source_prefix}/{rel}", "role": "generic", "action": "delete_file"}
        for rel in sorted(snapshot["files"])
    )
    deepest_dirs = sorted(
        snapshot["directories"], key=lambda rel: (len(Path(rel).parts), rel), reverse=True
    )
    targets.extend(
        {
            "path": source_prefix if rel == "." else f"{source_prefix}/{rel}",
            "role": "generic",
            "action": "delete_dir",
            "planned_before_hash": empty_delete_tree_hash(),
        }
        for rel in deepest_dirs
    )
    would_write = [target["path"] for target in targets if target["action"] == "write"]
    would_delete = [target["path"] for target in targets if target["action"].startswith("delete_")]
    if dry_run:
        return Result(
            ok=True,
            code="SUB_CLEAN_PLAN",
            op_id=op_id,
            data={
                "name": name,
                "dry_run": True,
                "would_write": would_write,
                "would_delete": would_delete,
                "instance_tree_hash": snapshot["tree_hash"],
            },
        )

    try:
        with project_writer_lock(root):
            live_manifest = _read_bytes_maybe(root / MANIFEST_REL)
            try:
                live_snapshot = _capture_clean_instance(instance)
            except RuntimeError:
                live_snapshot = None
            if live_manifest != manifest_raw or live_snapshot != snapshot:
                return _refuse(
                    "STALE_STATE",
                    "MANIFEST or instance tree changed after clean "
                    "planning; zero cleanup writes performed",
                    name=name,
                )
            if os.path.lexists(archive_root):
                return _refuse(
                    "STALE_STATE", f"archive destination already exists: {archive_rel}", name=name
                )
            commit = run_mutation(
                root,
                op_id,
                "sub_clean",
                agent or "saipen-cli",
                project_identity(root),
                hash_bytes(("sub_clean:" + name + ":" + snapshot["tree_hash"]).encode("utf-8")),
                targets,
                preconditions={
                    MANIFEST_REL: hash_bytes(manifest_raw),
                    **{f"{archive_instance_rel}/{rel}": "" for rel in snapshot["files"]},
                    f"{archive_rel}/receipt.json": "",
                    **{f"{source_prefix}/{rel}": digest for rel, digest in file_hashes.items()},
                },
                verification_policy="sub_clean",
            )
    except PermissionError:
        return _refuse("WRITER_BUSY", "another live writer holds the project lock", name=name)
    if not commit.get("ok"):
        return _refuse(commit.get("code", "VALIDATION_FAILED"), commit.get("detail", ""), name=name)
    return Result(
        ok=True,
        code="SUB_CLEANED",
        op_id=op_id,
        changed_files=would_write + would_delete,
        data={"name": name, "archive": archive_rel, "deleted": would_delete},
    )


def _collect_policy(root: Path, name: str) -> tuple[str | None, str | None, Path]:
    """Resolve executable collection policy from registry + local charter."""
    charter = root / SUBS_REL / f"{name}.md"
    role = ROLE_REGISTRY.get(name)
    if not charter.is_file():
        if role is not None:
            return None, f"{name}: local charter missing", charter
        return "core-review", None, root / SUBS_REL / "PROTOCOL.md"
    try:
        text = charter.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    except OSError as exc:
        return None, f"{name}: charter unreadable: {exc}", charter
    block = re.search(r"(?ms)^```yaml\n(.*?)^```\s*$", text)
    values = re.findall(r"(?m)^collect_policy:\s*(\S+)\s*$", block.group(1) if block else "")
    if len(values) != 1 or values[0] not in {"automatic", "core-review", "explicit"}:
        return (
            None,
            (
                f"{name}: charter must declare one collect_policy from "
                "automatic|core-review|explicit"
            ),
            charter,
        )
    policy = values[0]
    if role is not None and policy != role.collect_policy:
        return (
            None,
            (
                f"{name}: charter collect_policy {policy!r} disagrees "
                f"with CrewRole {role.collect_policy!r}"
            ),
            charter,
        )
    return policy, None, charter


def _canonical_package_block(package: OutboxPackage) -> bytes:
    """Status-neutral LF form: ready -> reviewed keeps package identity."""
    lines = package.block.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    rendered = []
    for line in lines:
        match = OUTBOX_FIELD_RE.match(line)
        rendered.append("- **status:** ready" if match and match.group(1) == "status" else line)
    return ("\n".join(rendered).rstrip("\n") + "\n").encode("utf-8")


def package_identity(package: OutboxPackage) -> str:
    """Immutable full SHA-256 over package block + producer/source triple."""
    parts = (
        _canonical_package_block(package),
        package.fields.get("producer", "").encode("utf-8"),
        package.fields.get("source_head", "").encode("utf-8"),
        package.fields.get("source_tree_fingerprint", "").encode("utf-8"),
        package.fields.get("role_revision", "").encode("utf-8"),
    )
    digest = hashlib.sha256(b"saipen-sub-collect-v1\0")
    for part in parts:
        digest.update(struct.pack(">Q", len(part)))
        digest.update(part)
    return "sha256:" + digest.hexdigest()


def _mark_package_reviewed(text: str, package_id: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    active = False
    changed = 0
    for index, line in enumerate(lines):
        heading = OUTBOX_HEADING_RE.fullmatch(line)
        if heading:
            active = heading.group(1) == package_id
            continue
        match = OUTBOX_FIELD_RE.match(line)
        if active and match and match.group(1) == "status":
            if match.group(2).strip() != "ready":
                raise ValueError(f"package {package_id} is no longer READY")
            lines[index] = "- **status:** reviewed"
            changed += 1
    if changed != 1:
        raise ValueError(f"package {package_id} has {changed} status fields")
    return "\n".join(lines)


def _manifest_with_collects(text: str, updates: dict[str, str]) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    seen = set()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        parts = stripped[2:].split("|")
        match = _ENTRY_RE.match(parts[0].strip())
        if not match or match.group(1).strip() not in updates:
            continue
        name = match.group(1).strip()
        metadata = [
            part.strip() for part in parts[1:] if not part.strip().startswith("last_collect:")
        ]
        metadata.append(f"last_collect: {updates[name]}")
        lines[index] = "- " + parts[0].strip() + " | " + " | ".join(metadata)
        seen.add(name)
    missing = sorted(set(updates) - seen)
    if missing:
        raise ValueError("MANIFEST entries disappeared: " + ", ".join(missing))
    return "\n".join(lines)


def _core_log_context(root: Path, active_log: str) -> tuple[str, dict[str, str]]:
    """Return full LOG allocation context and captured sealed dependencies."""
    dependencies = {}
    chunks = []
    segments = sorted(
        (root / ".saipen" / "logs").glob("LOG-*.md"),
        key=lambda path: int(re.search(r"(\d+)", path.stem).group(1)),
    )
    for segment in segments:
        raw = _read_bytes_maybe(segment)
        rel = segment.relative_to(root).as_posix()
        dependencies[rel] = _captured_hash(raw)
        chunks.append(_decode_captured(raw, rel))
    chunks.append(active_log)
    return "\n".join(chunks), dependencies


def _iter_operation_records(root: Path, records: tuple[dict, ...] | None = None):
    """W2-001: Yield every parseable operation.json from both ops and settled.

    Uses the canonical semantic receipt snapshot from journal.py instead
    of scanning only recovery/ops. This ensures committed receipts that
    have been moved to recovery/settled remain visible to subs readers.

    When ``records`` is given (a pre-captured crew receipt snapshot), iterate
    it instead of reopening disk (T-1004 perf): every subs evidence helper
    consumes the SAME coherent capture.
    """
    if records is not None:
        yield from records
        return
    from .journal import SemanticReceiptCorruptionError, semantic_receipt_snapshot

    snapshot = semantic_receipt_snapshot(root)
    if snapshot.errors:
        # CORE-002 (audit fdc73e06): silent-empty here collapsed CORRUPT into
        # CLEAN_EMPTY, so a malformed unrelated settled receipt made a valid
        # committed sub_collect receipt invisible, destroying dedup idempotence
        # and permitting duplicate Core tickets. Corruption is authority
        # failure, never "no evidence"; callers that can handle it (mutation
        # planners) catch and refuse zero-write, read-only health surfaces
        # surface it as INVALID.
        raise SemanticReceiptCorruptionError(snapshot.errors, snapshot)
    yield from snapshot.records


def _durable_collect_witness(
    root: Path, last_collect: str, identity: str, records: tuple[dict, ...] | None = None
) -> bool:
    """Structured-only collection dedup witness (T-1003 sweep).

    Free prose is never mechanical evidence: a package_identity SHA mentioned
    inside an arbitrary BOARD description or LOG message is NOT proof an
    intake happened. The ONLY witness is a COMMITTED `sub_collect` operation
    receipt whose structured receipt_metadata carries the exact
    `package_identity`.

    The MANIFEST `last_collect` marker is an INDEX, never authority: it is a
    journal target of the very collect op that also writes it, so a collect
    that CONFLICTs during post-write verification leaves the marker on disk
    while no COMMITTED receipt exists. Treating the marker as a witness turns
    one failed collect into a permanent `ALREADY_COLLECTED` dedup that blocks
    the retry from ever creating its review ticket (reproduced live on
    saihunt/HUNT-008 at HEAD e045ad07). A marker with no backing receipt is
    poisoned evidence and MUST NOT dedup.
    """
    for record in _iter_operation_records(root, records):
        if not _durable_collect_receipt(record):
            continue
        meta = record.get("receipt_metadata") or {}
        if identity in (meta.get("package_identities") or ()):
            return True
    return False


def _durable_collect_receipt(record: dict) -> bool:
    """Whether a settled receipt durably proves one completed intake.

    Ordinary intake ends COMMITTED. Recovery may instead settle an operation
    as RESOLVED/accept_live after every planned target reached its exact
    post-write bytes and the normal ``sub_collect`` verifier passed. That
    terminal record is equally durable; ignoring it splits MANIFEST dedup
    truth from collect linkage and leaves the package impossible to review.

    A partial or replanned resolution is never positive evidence.
    """
    if record.get("operation") != "sub_collect":
        return False
    if record.get("status") == "COMMITTED":
        return True
    if record.get("status") != "RESOLVED" or record.get("resolution") != "accept_live":
        return False
    meta = record.get("receipt_metadata") or {}
    if meta.get("operation") != "sub_collect" or meta.get("status") != "COMMITTED":
        return False
    targets = record.get("targets") or []
    applied = record.get("resolution_applied_targets") or []
    skipped = record.get("resolution_skipped_targets") or []
    target_paths = [target.get("path") for target in targets]
    return (
        bool(target_paths)
        and not skipped
        and all(
            target.get("applied") is True and target.get("path") in applied for target in targets
        )
    )


def _collect_linkage(
    root: Path, records: tuple[dict, ...] | None = None
) -> tuple[set[str], dict[str, str]]:
    """Durable intake linkage (items 4/13/16): every package identity with a
    COMMITTED sub_collect receipt, and its exact linked Core review ticket.

    The receipt's structured receipt_metadata binds package_identities to
    tickets positionally -- that binding is the INTAKE != REVIEW relation.
    The MANIFEST last_collect marker is a dedup witness; the ticket link is
    the disposition relation.
    """
    collected: set[str] = set()
    links: dict[str, str] = {}
    for record in _iter_operation_records(root, records):
        meta = record.get("receipt_metadata") or {}
        if not _durable_collect_receipt(record):
            continue
        identities = meta.get("package_identities") or []
        tickets = meta.get("tickets") or []
        for index, identity in enumerate(identities):
            collected.add(identity)
            if index < len(tickets):
                links[identity] = tickets[index]
    return collected, links


def _terminal_tickets(root: Path) -> dict[str, bool]:
    """Terminal state of every Core ticket: DONE or BLOCKED is a terminal
    disposition; everything else is open review work."""
    from .board import parse_board

    board = parse_board(_read_maybe(root / ".saipen" / "BOARD.md"))
    return {
        tid: ticket["section"] in ("## DONE", "## BLOCKED")
        for tid, ticket in board.get("tickets", {}).items()
    }


def _collect_review_state(
    root: Path,
    name: str,
    model: OutboxModel,
    source_id,
    saipen_home: str,
    records: tuple[dict, ...] | None = None,
) -> dict:
    """The INTAKE/REVIEW relation for one role's current packages (item 16).

    Returns structured flags the health derivation consumes:
    - reviewed_without_disposition: a current package claims 'reviewed' but
      has no durable collect receipt with a terminal linked Core ticket --
      REVIEWED TEXT IS NOT A REVIEW DISPOSITION, this is INVALID.
    - ready_collected_open: current READY package durably collected, linked
      Core review ticket not terminal -- REVIEW_PENDING (Core owns it now).
    - ready_collected_terminal: collected and the linked ticket IS terminal,
      but the disposition mark has not been applied -- REVIEW_PENDING with
      disposition_pending True (a mechanical DISPOSE action remains).
    - ready_uncollected: current READY package with no collect receipt --
      READY_FOR_REVIEW (intake is the missing action).
    """
    out = {
        "reviewed_without_disposition": False,
        "ready_collected_open": False,
        "ready_collected_terminal": False,
        "ready_uncollected": False,
        "disposition_pending": False,
        "review_ticket": None,
    }
    if source_id is None:
        return out
    current_role = current_local_role_revision(root, name, saipen_home)
    if current_role is None:
        return out
    collected, links = _collect_linkage(root, records)
    terminal = _terminal_tickets(root)
    for package in model.packages:
        if package.legacy:
            continue
        status = package.fields.get("status")
        if status not in ("ready", "reviewed"):
            continue
        if package.fields.get("source_head") != source_id.source_head:
            continue
        if package.fields.get("source_tree_fingerprint") != source_id.source_tree_fingerprint:
            continue
        if package.fields.get("role_revision") != current_role:
            continue
        identity = package_identity(package)
        ticket = links.get(identity)
        disposed = bool(ticket and terminal.get(ticket) is True)
        if status == "reviewed":
            if not (identity in collected and disposed):
                out["reviewed_without_disposition"] = True
                out["review_ticket"] = ticket
        else:
            if identity in collected:
                if disposed:
                    out["ready_collected_terminal"] = True
                    out["disposition_pending"] = True
                else:
                    out["ready_collected_open"] = True
                out["review_ticket"] = ticket
            else:
                out["ready_uncollected"] = True
    return out


def sub_collect(
    project_root: Path | str,
    name: str | None = None,
    agent: str | None = None,
    dry_run: bool = False,
) -> Result:
    """INTAKE: journal ready SubSaipen hypotheses as ordinary Core review
    tickets (items 4/5/13). INTAKE != REVIEW.

    The operation validates the package, creates exactly one Core review TODO
    ticket carrying the immutable package identity + provenance, and commits
    a durable collect receipt binding package_identity -> Core ticket id +
    producer + source identity. The package is NOT marked reviewed here: a
    reviewed claim is a Core DISPOSITION, and only `sub_disposition` (after
    the linked Core ticket is terminal) may write it. Health derivation turns
    a collected package into REVIEW_PENDING, never CURRENT, until then.

    Aggregate collection considers only automatic/core-review policies and
    skips explicit producers. Targeting an explicit producer refuses because
    its producer-specific SC integration stage owns that payload.
    """
    from .board import escape_ticket_description, parse_board
    from .fast_check import validate_texts
    from .log import log_tail_event, prepare_bounded_event
    from .operations import next_ticket_id

    root = Path(project_root)
    # CORE-002 (audit fdc73e06): one canonical semantic snapshot at mutation
    # start. Any corruption is a hard zero-write CORRUPT_JOURNAL refusal
    # BEFORE any planning/dedup, so a malformed unrelated settled receipt can
    # never launder valid committed collection evidence into "no evidence"
    # and produce a duplicate Core review ticket.
    from .journal import semantic_receipt_snapshot

    try:
        _collect_snapshot = semantic_receipt_snapshot(root)
    except Exception:
        return _refuse(
            "CORRUPT_JOURNAL",
            "cannot capture semantic receipt authority; refuse intake with zero writes",
        )
    if _collect_snapshot.errors:
        return _refuse(
            "CORRUPT_JOURNAL",
            "semantic receipt corruption blocks intake: "
            + "; ".join(_collect_snapshot.errors[:3])
            + " -- resolve the corrupt receipt before collecting; zero writes",
        )
    _collect_records = _collect_snapshot.records
    manifest_path = root / MANIFEST_REL
    manifest_doc = codec.read_document(manifest_path)
    entries, errors = parse_manifest(manifest_doc.text_norm)
    if errors:
        return _refuse(
            "INVALID_MANIFEST", "MANIFEST malformed: " + "; ".join(errors[:5]), errors=errors
        )
    by_name = {entry.name: entry for entry in entries}
    if name is not None and name not in by_name:
        return _refuse("TICKET_NOT_FOUND", f"no subSaipen {name!r} in MANIFEST", name=name)

    candidates = [name] if name is not None else sorted(by_name)
    policies = {}
    charter_dependencies = {}
    skipped = []
    for producer in candidates:
        policy, policy_error, charter = _collect_policy(root, producer)
        raw = _read_bytes_maybe(charter)
        charter_dependencies[str(charter.resolve())] = _captured_hash(raw)
        if policy_error:
            return _refuse("VALIDATION_FAILED", policy_error, name=producer)
        policies[producer] = policy
        if policy == "explicit":
            if name is not None:
                role = ROLE_REGISTRY.get(producer)
                stage = role.stage if role is not None else "SC"
                return _refuse(
                    "VALIDATION_FAILED",
                    f"EXPLICIT_POLICY: {producer} is an explicit producer; "
                    f"producer-specific {stage} "
                    "integration owns it, so `saipen sub collect` refuses",
                )
            skipped.append({"name": producer, "policy": policy, "reason": "EXPLICIT_POLICY"})

    eligible = [
        producer for producer in candidates if policies[producer] in ("automatic", "core-review")
    ]
    from freshness import compute_source_identity

    # T-1015: ONE PLAN source sample. The semantic decisions (current/stale
    # packages) and the CAS token come from the SAME SourceIdentity -- the
    # token is derived, never recomputed. APPLY revalidates the LIVE tree
    # independently through run_mutation's read-precondition pass, so any
    # post-PLAN mutation still refuses STALE_STATE with zero writes.
    from .journal import source_identity_dependency

    try:
        current = compute_source_identity(root)
        source_dependency = source_identity_dependency(current)
    except Exception as exc:
        return _refuse("VALIDATION_FAILED", f"source identity UNKNOWN: {exc}")

    state_doc = codec.read_document(root / ".saipen" / "STATE.md")
    board_doc = codec.read_document(root / ".saipen" / "BOARD.md")
    log_doc = codec.read_document(root / ".saipen" / "LOG.md")
    board = parse_board(board_doc.text_norm)
    if board["errors"]:
        return _refuse(
            "VALIDATION_FAILED", "BOARD parse error(s): " + "; ".join(board["errors"][:3])
        )
    full_log, sealed_dependencies = _core_log_context(root, log_doc.text_norm)

    planned = []
    package_reports = []
    deduplicated = []
    outbox_docs = {}
    for producer in eligible:
        entry = by_name[producer]
        outbox_path = _entry_dir(root, entry) / "kitchen" / "OUTBOX.md"
        if not outbox_path.is_file():
            if name is not None:
                return _refuse("PACKAGE_INCOMPLETE", f"{producer}: no OUTBOX")
            package_reports.append({"name": producer, "packages": []})
            continue
        outbox_doc = codec.read_document(outbox_path)
        outbox_docs[producer] = outbox_doc
        model = parse_outbox(outbox_doc.text_norm, producer)
        if model.errors:
            return _refuse(
                "MALFORMED_PACKAGE",
                f"{producer}: " + "; ".join(model.errors[:5]),
                name=producer,
                errors=list(model.errors),
            )
        current_ready = []
        stale_ready = []
        reviewed = []
        for package in model.packages:
            if package.legacy:
                package_reports.append(
                    {
                        "name": producer,
                        "packages": [
                            {"id": package.package_id, "status": package.status, "legacy": True}
                        ],
                    }
                )
                continue
            identity = package_identity(package)
            info = {
                "id": package.package_id,
                "status": package.status,
                "package_identity": identity,
            }
            if package.status == "reviewed":
                reviewed.append((package, identity))
                continue
            if package.status != "ready":
                continue
            try:
                _core_home = saipen_home_of(root)
            except ValueError as exc:
                return _refuse("VALIDATION_FAILED", str(exc), name=producer)
            role_state = role_freshness(root, producer, package.fields["role_revision"], _core_home)
            reasons = []
            if package.fields["source_head"] != current.source_head:
                reasons.append("source_head stale")
            if package.fields["source_tree_fingerprint"] != current.source_tree_fingerprint:
                reasons.append("source_tree_fingerprint differs")
            if role_state != "current":
                reasons.append(f"role_revision {role_state}")
            if reasons:
                stale_ready.append((package, reasons))
            else:
                current_ready.append((package, identity, info))
        last_collect = entry.metadata.get("last_collect", "")
        # Dedup is by durable intake receipt for BOTH statuses: a collected
        # package stays READY until Core disposes it, so 'ready + durable
        # receipt' is ALREADY_COLLECTED, never a second ticket.
        durable = {
            identity
            for identity in (
                {identity for _package, identity, _info in current_ready}
                | {identity for _package, identity in reviewed}
            )
            if _durable_collect_witness(root, last_collect, identity, records=_collect_records)
        }
        fresh_ready = [
            (package, identity, info)
            for package, identity, info in current_ready
            if identity not in durable
        ]
        if stale_ready:
            detail = "; ".join(
                f"{producer}/{package.package_id}: {', '.join(reasons)}"
                for package, reasons in stale_ready
            )
            return _refuse(
                "PACKAGE_INCOMPLETE", "collect refused; stale READY package(s): " + detail
            )
        if not fresh_ready:
            if durable:
                deduplicated.extend(
                    {"name": producer, "package_identity": identity} for identity in sorted(durable)
                )
                package_reports.append(
                    {
                        "name": producer,
                        "packages": [
                            {
                                "id": package.package_id,
                                "status": package.status,
                                "package_identity": identity,
                                "deduplicated": True,
                            }
                            for package, identity, _info in current_ready
                            if identity in durable
                        ]
                        + [
                            {
                                "id": package.package_id,
                                "status": package.status,
                                "package_identity": identity,
                                "deduplicated": True,
                            }
                            for package, identity in reviewed
                            if identity in durable
                        ],
                    }
                )
                continue
            # An existing canonical empty queue is truthful evidence that
            # there is currently nothing to collect, including for a targeted
            # diagnostic. A targeted nonempty queue with no READY package is
            # different: it is incomplete and must still refuse.
            if name is None or not model.packages:
                package_reports.append({"name": producer, "packages": []})
                continue
            return _refuse(
                "PACKAGE_INCOMPLETE",
                f"{producer}: expected exactly one current READY package; found 0",
            )
        if len(fresh_ready) != 1:
            return _refuse(
                "MALFORMED_PACKAGE",
                f"{producer}: expected exactly one current READY package; found {len(fresh_ready)}",
            )
        package, identity, info = fresh_ready[0]
        planned.append(
            {
                "producer": producer,
                "entry": entry,
                "package": package,
                "identity": identity,
                "outbox_path": outbox_path,
            }
        )
        package_reports.append({"name": producer, "packages": [info]})

    if not planned:
        code = "ALREADY_COLLECTED" if deduplicated else "SUB_COLLECT"
        return Result(
            ok=True,
            code=code,
            data={
                "names": eligible,
                "packages": package_reports,
                "skipped": skipped,
                "deduplicated": deduplicated,
                "dry_run": dry_run,
            },
        )

    now_iso = _utc_iso()
    now_log = _now()
    next_id = next_ticket_id(board_doc.text_norm, full_log)
    tail = log_tail_event(full_log)
    op_id = "sub-collect-" + __import__("uuid").uuid4().hex[:8]
    new_board = board_doc.text_norm
    new_log = log_doc.text_norm
    tickets = []
    manifest_updates = {}
    for offset, item in enumerate(planned):
        producer = item["producer"]
        package = item["package"]
        identity = item["identity"]
        ticket = f"T-{next_id + offset}"
        provenance = codec.redact_credentials(
            f"package_identity={identity}; producer={producer}; "
            f"package={package.package_id}; source_head="
            f"{package.fields['source_head']}; source_tree_fingerprint="
            f"{package.fields['source_tree_fingerprint']}; role_revision="
            f"{package.fields['role_revision']}; outbox="
            f"{item['outbox_path'].relative_to(root).as_posix()}"
        )
        description = escape_ticket_description(
            f"Review SubSaipen hypothesis {producer}/{package.package_id}: "
            f"{codec.redact_credentials(package.description)}; not accepted fact; {provenance}"
        )
        verify = escape_ticket_description(
            "Independently reproduce or reject hypothesis, record Core "
            f"disposition, apply no package patch during intake; {provenance}"
        )
        severity = package.fields.get("severity", "")
        priority = (
            severity
            if severity in ("P0", "P1", "P2")
            else ("P1" if package.fields.get("critical", "").lower() == "true" else "P2")
        )
        line = f"- [ ] {ticket} [{priority}] {description} | verify: {verify}"
        board_lines = new_board.splitlines(keepends=True)
        # T-1003 sweep: an autonomous collected hypothesis must NOT preempt
        # already-workable Core work (board order is priority). Collected
        # review hypotheses go at the END of ## TODO, deterministic and
        # batch-order-preserved.
        done_index = next(
            index for index, value in enumerate(board_lines) if value.startswith("## DONE")
        )
        board_lines.insert(done_index, line + "\n")
        new_board = "".join(board_lines)
        # T-1003 Wave 2 item 5 + T-1006: the Core mutation event agent is the
        # ACTUAL Core writer -- the CANONICAL acting seat threaded from the
        # invocation (inherited STATE.agent or explicit --agent), never a
        # hardcoded CLI identity and never the evidence producer. The producer
        # identity is structured provenance in the ticket/receipt, not the LOG
        # writer's identity.
        event, log_line, log_detail_targets = prepare_bounded_event(
            root,
            tail,
            "RUN",
            f"collect {producer}/{package.package_id} -> {ticket}; "
            f"{provenance}; queued as Core review hypothesis",
            ticket=ticket,
            agent=agent or "saipen-cli",
            now=now_log,
            op_id=op_id,
        )
        tail = event
        new_log = new_log.rstrip("\n") + "\n" + log_line + "\n"
        tickets.append(
            {
                "ticket": ticket,
                "producer": producer,
                "package": package.package_id,
                "package_identity": identity,
            }
        )
        manifest_updates[producer] = identity + "@" + now_iso

    new_state = patch_state(
        state_doc.text_norm,
        {
            "last_event": tail,
            "updated": now_iso,
        },
    )
    new_manifest = _manifest_with_collects(manifest_doc.text_norm, manifest_updates)
    # T-1006: the sub mutation validates under the SAME canonical actor it
    # writes, so claim/liveness checks can never disagree with LOG/STATE.
    proposed_errors = validate_texts(
        new_state, new_board, new_log, current_agent=agent or "saipen-cli"
    )
    _parsed_manifest, manifest_errors = parse_manifest(new_manifest)
    if proposed_errors or manifest_errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed collect fails validation: "
            + "; ".join((proposed_errors + manifest_errors)[:5]),
        )

    targets = [
        # T-1326 P0: any externalized LOG detail is part of the SAME journaled
        # commit as LOG/STATE/BOARD/MANIFEST -- a compact `detail_ref` may never
        # name bytes this transaction did not write.
        *(_target_dict(plan) for plan in log_detail_targets),
        {"path": ".saipen/LOG.md", "role": "log", "content": log_doc.encode(new_log)},
        {"path": ".saipen/BOARD.md", "role": "board", "content": board_doc.encode(new_board)},
        {"path": ".saipen/STATE.md", "role": "state", "content": state_doc.encode(new_state)},
        {"path": MANIFEST_REL, "role": "manifest", "content": manifest_doc.encode(new_manifest)},
    ]
    preconditions = {
        ".saipen/LOG.md": log_doc.raw_hash,
        ".saipen/BOARD.md": board_doc.raw_hash,
        ".saipen/STATE.md": state_doc.raw_hash,
        MANIFEST_REL: manifest_doc.raw_hash,
    }
    # The OUTBOX is a READ-ONLY dependency of intake: the package stays READY
    # (INTAKE != REVIEW) and must not move during the transaction.
    read_preconditions = {
        ".": source_dependency,
        **sealed_dependencies,
        **charter_dependencies,
        **{
            item["outbox_path"].relative_to(root).as_posix(): outbox_docs[item["producer"]].raw_hash
            for item in planned
        },
    }
    changed = [target["path"] for target in targets]
    if dry_run:
        return Result(
            ok=True,
            code="SUB_COLLECT_PLAN",
            data={
                "names": eligible,
                "packages": package_reports,
                "tickets": tickets,
                "skipped": skipped,
                "deduplicated": deduplicated,
                "dry_run": True,
                "would_result": "SUB_COLLECTED",
                "would_write": changed,
            },
        )
    with project_writer_lock(root):
        commit = run_mutation(
            root,
            op_id,
            "sub_collect",
            agent or "saipen-cli",
            project_identity(root),
            hash_bytes(
                ("sub_collect:" + ",".join(item["identity"] for item in planned)).encode("utf-8")
            ),
            targets,
            preconditions=preconditions,
            read_preconditions=read_preconditions,
            verification_policy="sub_collect",
            receipt_metadata={
                "operation": "sub_collect",
                "status": "COMMITTED",
                "package_identities": [item["identity"] for item in planned],
                "producers": sorted({item["producer"] for item in planned}),
                "tickets": [t["ticket"] for t in tickets],
            },
        )
    if not commit.get("ok"):
        return _refuse(
            commit.get("code", "VALIDATION_FAILED"), commit.get("detail", ""), tickets=tickets
        )
    return Result(
        ok=True,
        code="SUB_COLLECTED",
        op_id=op_id,
        changed_files=changed,
        data={
            "names": eligible,
            "packages": package_reports,
            "tickets": tickets,
            "skipped": skipped,
            "deduplicated": deduplicated,
        },
    )


def sub_disposition(
    project_root: Path | str,
    name: str,
    package_id: str | None = None,
    agent: str | None = None,
    dry_run: bool = False,
) -> Result:
    """CORE DISPOSITION: mark a collected core-review package `reviewed` ONLY
    after its linked Core review ticket is terminal (items 4/13/16).

    INTAKE != REVIEW: sub_collect only queues the hypothesis; this operation
    writes the reviewed claim, and only when:
      - the package is current (source triple + role revision),
      - a durable collect receipt links its immutable identity to a Core
        review ticket,
      - that ticket is terminal (DONE or BLOCKED) on the Core board.
    Health derivation turns the role CURRENT only after this receipt exists;
    until then the role is REVIEW_PENDING.
    """
    from .fast_check import validate_texts
    from .log import log_tail_event, prepare_bounded_event

    root = Path(project_root)
    try:
        instance = _sub_dir(root, name)
    except ValueError as exc:
        return _refuse("INVALID_ID", str(exc), name=name)
    _manifest_raw, _entry, manifest_errors = _registered_entry(root, name)
    if manifest_errors:
        return _refuse(
            "INVALID_MANIFEST", "; ".join(manifest_errors[:5]), name=name, errors=manifest_errors
        )
    outbox_path = instance / "kitchen" / "OUTBOX.md"
    if not outbox_path.is_file():
        return _refuse("PACKAGE_INCOMPLETE", f"{name}: no OUTBOX", name=name)
    outbox_doc = codec.read_document(outbox_path)
    model = parse_outbox(outbox_doc.text_norm, name)
    if model.errors:
        return _refuse(
            "MALFORMED_PACKAGE",
            f"{name}: " + "; ".join(model.errors[:5]),
            name=name,
            errors=list(model.errors),
        )
    from freshness import compute_source_identity

    # T-1015: ONE PLAN source sample (see sub_collect): semantic currentness
    # and the CAS token share the same SourceIdentity; APPLY revalidates live.
    from .journal import source_identity_dependency

    try:
        current = compute_source_identity(root)
        source_dependency = source_identity_dependency(current)
    except Exception as exc:
        return _refuse("VALIDATION_FAILED", f"source identity UNKNOWN: {exc}")
    try:
        core_home = saipen_home_of(root)
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), name=name)
    current_role = current_local_role_revision(root, name, core_home)
    candidates = []
    for package in model.packages:
        if package.legacy:
            continue
        if package.status != "ready":
            continue
        if package_id is not None and package.package_id != package_id:
            continue
        if package.fields.get("source_head") != current.source_head:
            continue
        if package.fields.get("source_tree_fingerprint") != current.source_tree_fingerprint:
            continue
        if package.fields.get("role_revision") != current_role:
            continue
        candidates.append(package)
    if not candidates:
        return _refuse(
            "PACKAGE_INCOMPLETE",
            f"{name}: no current READY package to dispose"
            + (f" ({package_id})" if package_id else ""),
            name=name,
        )
    if len(candidates) > 1:
        return _refuse(
            "MALFORMED_PACKAGE",
            f"{name}: multiple current READY packages; dispose exactly one by package id",
            name=name,
        )
    package = candidates[0]
    identity = package_identity(package)
    try:
        collected, links = _collect_linkage(root)
    except Exception as exc:
        from .journal import SemanticReceiptCorruptionError

        if isinstance(exc, SemanticReceiptCorruptionError):
            return _refuse(
                "CORRUPT_JOURNAL",
                "semantic receipt corruption blocks disposition: "
                + "; ".join(exc.errors[:3])
                + " -- resolve the corrupt receipt before disposing; zero writes",
                name=name,
                package=package.package_id,
            )
        raise
    ticket = links.get(identity)
    if identity not in collected or not ticket:
        return _refuse(
            "VALIDATION_FAILED",
            f"{name}/{package.package_id}: no durable collect receipt links "
            "this package to a Core review ticket -- INTAKE must precede a "
            "reviewed claim",
            name=name,
        )
    terminal = _terminal_tickets(root)
    if not terminal.get(ticket):
        return _refuse(
            "VALIDATION_FAILED",
            f"{name}/{package.package_id}: linked Core review ticket {ticket} "
            "is not terminal -- a reviewed claim requires an independent "
            "Core disposition (DONE or BLOCKED) first",
            name=name,
            ticket=ticket,
        )

    try:
        reviewed_text = _mark_package_reviewed(outbox_doc.text_norm, package.package_id)
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc), name=name, package=package.package_id)
    rel = outbox_path.relative_to(root).as_posix()
    state_doc = codec.read_document(root / ".saipen" / "STATE.md")
    board_doc = codec.read_document(root / ".saipen" / "BOARD.md")
    log_doc = codec.read_document(root / ".saipen" / "LOG.md")
    full_log, sealed_dependencies = _core_log_context(root, log_doc.text_norm)
    tail = log_tail_event(full_log)
    now_iso = _utc_iso()
    now_log = _now()
    op_id = "sub-disposition-" + __import__("uuid").uuid4().hex[:8]
    # T-1006: the Core disposition event names the canonical acting seat
    # (inherited STATE.agent or explicit --agent), never a hardcoded identity.
    event, log_line, log_detail_targets = prepare_bounded_event(
        root,
        tail,
        "DEC",
        f"disposition {name}/{package.package_id} reviewed after Core "
        f"review {ticket} terminal; package_identity={identity}",
        ticket=None,
        agent=agent or "saipen-cli",
        now=now_log,
        op_id=op_id,
    )
    new_log = log_doc.text_norm.rstrip("\n") + "\n" + log_line + "\n"
    new_state = patch_state(
        state_doc.text_norm,
        {
            "last_event": event,
            "updated": now_iso,
        },
    )
    errors = validate_texts(
        new_state, board_doc.text_norm, new_log, current_agent=agent or "saipen-cli"
    )
    if errors:
        return _refuse(
            "VALIDATION_FAILED",
            "proposed disposition fails fast validation: " + "; ".join(errors[:5]),
        )
    targets = [
        # T-1326 P0: the disposition's externalized detail joins this commit.
        *(_target_dict(plan) for plan in log_detail_targets),
        {"path": ".saipen/LOG.md", "role": "log", "content": log_doc.encode(new_log)},
        {"path": ".saipen/STATE.md", "role": "state", "content": state_doc.encode(new_state)},
        {"path": rel, "role": "report", "content": outbox_doc.encode(reviewed_text)},
    ]
    preconditions = {
        ".saipen/LOG.md": log_doc.raw_hash,
        ".saipen/STATE.md": state_doc.raw_hash,
        rel: outbox_doc.raw_hash,
    }
    read_preconditions = {
        ".": source_dependency,
        ".saipen/BOARD.md": board_doc.raw_hash,
        **sealed_dependencies,
    }
    changed = [target["path"] for target in targets]
    if dry_run:
        return Result(
            ok=True,
            code="SUB_DISPOSITION_PLAN",
            data={
                "name": name,
                "package": package.package_id,
                "package_identity": identity,
                "ticket": ticket,
                "dry_run": True,
                "would_result": "SUB_DISPOSITIONED",
                "would_write": changed,
            },
        )
    with project_writer_lock(root):
        commit = run_mutation(
            root,
            op_id,
            "sub_disposition",
            agent or "saipen-cli",
            project_identity(root),
            hash_bytes(("sub_disposition:" + identity).encode("utf-8")),
            targets,
            preconditions=preconditions,
            read_preconditions=read_preconditions,
            verification_policy="sub_disposition",
            receipt_metadata={
                "operation": "sub_disposition",
                "status": "COMMITTED",
                "package_identity": identity,
                "producer": name,
                "package": package.package_id,
                "ticket_id": ticket,
                "source_head": package.fields.get("source_head"),
                "source_tree_fingerprint": package.fields.get("source_tree_fingerprint"),
            },
        )
    if not commit.get("ok"):
        return _refuse(
            commit.get("code", "VALIDATION_FAILED"),
            commit.get("detail", ""),
            name=name,
            ticket=ticket,
        )
    return Result(
        ok=True,
        code="SUB_DISPOSITIONED",
        op_id=op_id,
        changed_files=changed,
        data={
            "name": name,
            "package": package.package_id,
            "package_identity": identity,
            "ticket": ticket,
        },
    )


def saipen_home_of(project_root: Path) -> str:
    """The Core STATE's saipen_home, or a fail-closed raise: a malformed
    Core STATE must never synthesize an empty home -- an empty home is a
    real value with real consequences, not a lenient default (T-1003)."""
    from .state import parse_state_or_error

    st, state_error = parse_state_or_error(codec.read_doc(project_root / ".saipen" / "STATE.md"))
    if state_error:
        raise ValueError(f"state-malformed: {state_error}")
    return st.get("saipen_home") or ""
