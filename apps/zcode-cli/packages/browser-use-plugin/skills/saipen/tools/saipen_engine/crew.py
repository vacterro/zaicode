"""Serial, evidence-derived SAICREW fixed-point planner and finalizer."""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .applicability import ALWAYS, APPLICABLE, NOT_APPLICABLE
from .board import blocker_class, convergence_closure_problems, parse_board, wait_role_target
from .journal import (
    hash_file_dependency,
    hash_tree_dependency,
    pending_ops,
    source_identity_dependency,
)
from .operations import RELEASE_SCOPE_DIR
from .result import Result
from .state import parse_state
from .subs import (
    CREW_ROLES,
    CREW_STAGES,
    HEALTH_BLOCKED,
    HEALTH_CURRENT,
    HEALTH_INVALID,
    HEALTH_NOT_RUN,
    HEALTH_READY_FOR_REVIEW,
    HEALTH_REVIEW_PENDING,
    HEALTH_STALE,
    HEALTH_WORK_PENDING,
    ROLE_REGISTRY,
    SUBS_REL,
    current_local_role_revision,
    package_identity,
    parse_manifest_file,
    parse_outbox,
    shared_contract_status,
    sub_adopt,
    sub_instance_health,
    sub_spawn,
    sub_sync,
)
from .convergence import convergence_verdict, source_worktree_deltas

SATISFIED = "SATISFIED"
UNSATISFIED = "UNSATISFIED"
WAITING = "WAITING_ON_PREDECESSOR"
_STAGE_NAMES = {stage: name for stage, name, *_rest in CREW_STAGES}


@dataclass(frozen=True)
class CrewAction:
    stage: str
    role: str | None
    action: str
    source_identity: dict
    required_contract: str
    inputs: tuple[str, ...]
    expected_evidence: str
    completion_condition: str
    on_success: str = "REPLAN"
    on_failure: str = "BLOCK"
    # T-1003 hostile finding 22: serial SC executes each role IN THE CURRENT
    # agent session. A SubSaipen is an authority/state namespace, not a
    # mandatory process or chat-session boundary. The role paths below let a
    # machine action say exactly which files the current agent must own.
    execute_in_current_agent: bool = True
    role_paths: tuple[str, ...] = ()
    write_boundary: str = ""
    then_action: str = "REPLAN_CREW"
    # AUTO-002/AUTO-007: autonomy/terminality carriers. A crew action is an
    # EXECUTABLE next step for the CURRENT agent, never an advisory or a
    # terminal stop: `terminal` is false unless the action itself is a
    # protocol-defined done/blocked state, `requires_human` is false unless a
    # genuine human-only decision is needed, and `resume_after` names the
    # continuation to return to after the action's evidence is produced.
    terminal: bool = False
    requires_human: bool = False
    next_action: str = "RUN_ROLE"
    resume_after: str = "REPLAN_CREW"
    userperson_projection: dict | None = None


@dataclass(frozen=True)
class CrewEpoch:
    event: int
    op_id: str
    ticket: str | None
    created_at: str


class CrewEpochCarrierError(ValueError):
    """A present durable crew-epoch carrier is not canonical authority."""


@dataclass(frozen=True)
class ReleaseEvidence:
    op_id: str
    ticket: str
    tag: str
    source_head: str
    closure_commit: str
    created_at: str
    stages: tuple[str, ...]
    pre_ship_evidence: dict
    source_tree_fingerprint: str = ""
    # SRC-019:R1 -- the applicability manifest FROZEN at pre-ship capture:
    # {role: {probe, verdict, reason, source_head, source_tree_fingerprint}}
    # for every built-in role. Post-ship certification reads this record, so
    # the certified role set cannot drift when the tree changes after the
    # ship. Empty for pre-SRC-019 receipts, which fall back to the full
    # roster (the set those receipts were actually captured against).
    pre_ship_applicability: dict = field(default_factory=dict)
    verdict: str = "ok"
    verdict_reason: str = ""


@dataclass(frozen=True)
class CrewSnapshot:
    root: Path
    source_id: object | None
    source_error: str | None
    state_text: str
    state: dict
    board_text: str
    board: dict
    log_text: str
    log_tail: int | None
    log_events: tuple[dict, ...]
    saipen_home: str
    home_problem: str | None
    contract_status: dict
    manifest_entries: tuple
    manifest_errors: tuple[str, ...]
    pending: tuple[dict, ...]
    roles: dict
    packages: dict
    epoch: CrewEpoch | None
    release: ReleaseEvidence | None
    input_hashes: dict[str, str]
    stable: bool
    # The ONE coherent operation-receipt capture backing this snapshot
    # (T-1004 perf): every crew/sub evidence helper consumes the same parsed
    # records instead of reopening disk per helper. Command-scoped: never
    # cached across crew_snapshot calls, and a stability failure means
    # consumers must fail closed rather than trust this data.
    op_records: tuple[dict, ...] = ()
    receipt_errors: tuple[str, ...] = ()
    receipt_snapshot: object | None = None
    # P0#4: the CURRENT-SESSION capability negotiated at the public command
    # boundary. Persisted STATE.mode is historical; this is the live authority
    # the crew gate/closure consult. None means "not injected" (legacy
    # internal call) and the persisted mode governs.
    current_capability: str | None = None
    userperson: dict | None = None
    # T-1279: the deterministic project facts every applicability probe is
    # judged against, enumerated ONCE per snapshot. None means the enumeration
    # was not attempted, which `applicability.verdict` resolves to APPLICABLE --
    # a capability is never retired by a fact nobody looked for.
    project_facts: object | None = None
    # SRC-019:R2: the applicability facts were read INSIDE the source
    # observation that `source_id` names, and that observation revalidated
    # identical afterwards. False means the source provably moved while the
    # facts were being collected, so the facts may describe a different tree
    # than the identity they are filed under and no NOT_APPLICABLE skip may be
    # authorized from them. True when there was no source identity to bind
    # against at all: that is already carried by `stable` and is not a
    # witnessed mutation.
    facts_source_bound: bool = True


def _refuse(code: str, detail: str = "", **extra) -> Result:
    return Result(ok=False, code=code, message=detail, data=extra)


def _quick_hash(raw: bytes) -> str:
    import hashlib

    return hashlib.sha256(raw).hexdigest()[:16]


def _source_identity(root: Path):
    try:
        from freshness import compute_source_identity

        return compute_source_identity(root), None
    except Exception as exc:
        return None, str(exc)


def _revalidate_source_identity(root: Path, source_id: object) -> tuple[bool, str | None]:
    try:
        from freshness import revalidate_source_identity

        return revalidate_source_identity(root, source_id)
    except Exception as exc:
        return False, str(exc)


def _read_maybe(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except OSError:
        return ""


def _root_dependency_specs(root: Path) -> dict[str, tuple[Path, bool]]:
    """Exact decision surface read by one crew snapshot.

    Large instance/scratch trees are not planner inputs.  The CAS binds exact
    checkpoint, charter, role-state, OUTBOX, READY and durable release files,
    small inherited TEMPLATE/READY trees, plus shallow membership tokens where
    appearance/disappearance changes routing.  Producer `kitchen/pen`, caches,
    staging and archives are intentionally outside this surface.
    """
    specs: dict[str, tuple[Path, str]] = {}

    def add(rel: str, mode: str = "file") -> None:
        specs[rel] = (root / rel, mode)

    for rel in (".saipen/STATE.md", ".saipen/BOARD.md", ".saipen/LOG.md"):
        add(rel)
    add(".saipen/logs", "listing")
    logs = root / ".saipen" / "logs"
    if logs.is_dir():
        for segment in sorted(logs.glob("LOG-*.md")):
            add(segment.relative_to(root).as_posix())

    shared = ".saipen/extensions/subs"
    add(shared, "listing")
    for name in ("MANIFEST.md", "PROTOCOL.md", "README.md", "crew.md"):
        add(f"{shared}/{name}")
    add(f"{shared}/TEMPLATE", "tree")
    local_shared = root / shared
    if local_shared.is_dir():
        for charter in sorted(local_shared.glob("sai*.md")):
            add(charter.relative_to(root).as_posix())
    for role in CREW_ROLES:
        add(f"{shared}/{role.name}.md")
        if role.name != "saitranslate":
            base = f"{shared}/{role.name}"
            add(base, "listing")
            for name in ("STATE.md", "BOARD.md", "LOG.md", "kitchen/OUTBOX.md"):
                add(f"{base}/{name}")

    for base in (f"{shared}/saiwiki", ".saipen/saitranslate"):
        add(base, "listing")
        add(f"{base}/READY", "tree")
    for rel in (
        ".saipen/saitranslate/kitchen/OUTBOX.md",
        ".saipen/kitchen/crew_epoch.json",
        ".saipen/kitchen/release_receipt.json",
        ".saipen/kitchen/crew_release_evidence.json",
    ):
        add(rel)
    add(".saipen/recovery/conformance", "tree")
    return specs


def _home_dependency_specs(home: str) -> dict[str, tuple[Path, str]]:
    if not home:
        return {}
    root = Path(home)
    shared = root / "extensions" / "subs"
    specs: dict[str, tuple[Path, str]] = {
        str(shared.resolve()): (shared, "listing"),
        str((shared / "TEMPLATE").resolve()): (shared / "TEMPLATE", "tree"),
    }
    for name in ("PROTOCOL.md", "README.md", "crew.md", *(f"{r.name}.md" for r in CREW_ROLES)):
        path = shared / name
        specs[str(path.resolve())] = (path, "file")
    if shared.is_dir():
        for charter in sorted(shared.glob("sai*.md")):
            specs[str(charter.resolve())] = (charter, "file")
    for candidate in (root / "saipen/BOOT.md", root / "BOOT.md"):
        specs[str(candidate.resolve())] = (candidate, "file")
    return specs


def _capture_dependencies(specs: dict[str, tuple[Path, str]]) -> dict[str, str]:
    from .journal import hash_directory_listing_dependency

    hashers = {
        "file": hash_file_dependency,
        "tree": hash_tree_dependency,
        "listing": hash_directory_listing_dependency,
    }
    return {name: hashers[mode](path) for name, (path, mode) in specs.items()}


def _unsafe_dependency(digest: str) -> bool:
    return digest.startswith("object") or not digest


def _strict_created_at(value: object) -> str:
    """Strict ISO-8601 UTC timestamp (Z or +00:00, utcoffset == 0), or '' when
    invalid. Delegated to the ONE shared strict-UTC parser (hostile-regression,
    P2#1): a non-zero offset stamp is NOT UTC and must refuse, never pass."""
    from .board import strict_iso_utc

    return strict_iso_utc(value)


def read_durable_crew_epoch(root: Path | str) -> dict | None:
    """Read the tracked crew-epoch carrier as strict durable authority.

    Absence is the sole legacy-fallback condition.  Once the carrier exists,
    malformed JSON, a non-regular/reparse node, schema drift, hostile IDs, or
    foreign project lineage is corruption rather than permission to fall back
    to weaker recovery receipts.
    """
    from .codec import is_canonical_encoding
    from .paths import project_lineage_identity, read_bound_regular_bytes
    from .safeid import InvalidIdError, validate_safe_id

    root = Path(root)
    path = root / ".saipen" / "kitchen" / "crew_epoch.json"
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

    def node_identity(info) -> tuple[int, int, int, int]:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

    def unsafe_node(candidate: Path, info, *, directory: bool) -> bool:
        expected_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
        return (
            os.path.islink(candidate)
            or bool(getattr(info, "st_file_attributes", 0) & reparse_flag)
            or not expected_type
        )

    ancestor_before: list[tuple[Path, tuple[int, int, int, int]]] = []
    for ancestor in (root / ".saipen", root / ".saipen" / "kitchen"):
        try:
            ancestor_info = ancestor.lstat()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise CrewEpochCarrierError(f"cannot inspect {ancestor}: {exc}") from exc
        if unsafe_node(ancestor, ancestor_info, directory=True):
            raise CrewEpochCarrierError(
                f"crew_epoch.json ancestor {ancestor} is a symlink, "
                "reparse point, or non-directory"
            )
        ancestor_before.append((ancestor, node_identity(ancestor_info)))

    try:
        before = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise CrewEpochCarrierError(f"cannot inspect {path}: {exc}") from exc

    if unsafe_node(path, before, directory=False):
        raise CrewEpochCarrierError(
            "crew_epoch.json is a symlink, reparse point, or non-regular file"
        )
    if before.st_size > 16 * 1024:
        raise CrewEpochCarrierError("crew_epoch.json exceeds the 16 KiB authority limit")
    try:
        raw = read_bound_regular_bytes(path, before, max_bytes=16 * 1024)
        after = path.lstat()
    except (OSError, ValueError) as exc:
        raise CrewEpochCarrierError(f"cannot read crew_epoch.json: {exc}") from exc
    before_identity = node_identity(before)
    after_identity = node_identity(after)
    if unsafe_node(path, after, directory=False):
        raise CrewEpochCarrierError(
            "crew_epoch.json became a symlink, reparse point, or non-regular file"
        )
    if before_identity != after_identity:
        raise CrewEpochCarrierError("crew_epoch.json changed while it was being read")
    if not is_canonical_encoding(raw):
        raise CrewEpochCarrierError("crew_epoch.json is not canonical UTF-8 without a BOM")
    def reject_duplicate_keys(pairs):
        decoded = {}
        for key, value in pairs:
            if key in decoded:
                raise CrewEpochCarrierError(
                    f"crew_epoch.json repeats field {key!r}"
                )
            decoded[key] = value
        return decoded

    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CrewEpochCarrierError(f"crew_epoch.json is not canonical JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise CrewEpochCarrierError("crew_epoch.json root must be an object")

    required = {
        "schema_version",
        "operation",
        "op_id",
        "target",
        "status",
        "created_at",
        "project_lineage",
    }
    allowed = required | {"ticket_id"}
    missing = sorted(required - set(data))
    unknown = sorted(set(data) - allowed)
    if missing or unknown:
        detail = []
        if missing:
            detail.append("missing " + ", ".join(missing))
        if unknown:
            detail.append("unknown " + ", ".join(unknown))
        raise CrewEpochCarrierError(
            "crew_epoch.json fields are not canonical: " + "; ".join(detail)
        )
    if type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise CrewEpochCarrierError("crew_epoch.json schema_version must be integer 1")
    for key, expected in (
        ("operation", "crew_epoch"),
        ("target", "crew"),
        ("status", "COMMITTED"),
    ):
        if data[key] != expected:
            raise CrewEpochCarrierError(
                f"crew_epoch.json {key} must be {expected!r}, got {data[key]!r}"
            )
    op_id = data["op_id"]
    try:
        validate_safe_id(op_id, kind="crew epoch op_id")
    except InvalidIdError as exc:
        raise CrewEpochCarrierError(str(exc)) from exc
    if not re.fullmatch(r"converge_intent-[0-9a-f]{32}", op_id):
        raise CrewEpochCarrierError(
            "crew_epoch.json op_id must match converge_intent-<32 lowercase hex>"
        )
    if not _strict_created_at(data["created_at"]):
        raise CrewEpochCarrierError("crew_epoch.json created_at must be strict UTC")
    # CORE-004: current-schema crew epoch authority requires a canonical
    # NON-NULL lineage matching the live carrier. None==None must never count
    # as valid current-schema authority when IDENTITY.md is absent.
    lineage = data["project_lineage"]
    if not isinstance(lineage, str) or not re.fullmatch(r"lineage-[0-9a-f]{32}", lineage):
        raise CrewEpochCarrierError(
            "crew_epoch.json project_lineage must be a canonical non-null "
            "lineage-[0-9a-f]{32} value"
        )
    expected_lineage = project_lineage_identity(root)
    if lineage != expected_lineage:
        raise CrewEpochCarrierError(
            "crew_epoch.json project_lineage does not match .saipen/IDENTITY.md"
        )
    if "ticket_id" in data and (
        not isinstance(data["ticket_id"], str)
        or not re.fullmatch(r"T-[1-9][0-9]*", data["ticket_id"])
    ):
        raise CrewEpochCarrierError("crew_epoch.json ticket_id must match T-<positive integer>")
    for ancestor, expected_identity in ancestor_before:
        try:
            ancestor_after = ancestor.lstat()
        except OSError as exc:
            raise CrewEpochCarrierError(
                f"crew_epoch.json ancestor changed while reading: {ancestor}: {exc}"
            ) from exc
        if unsafe_node(ancestor, ancestor_after, directory=True):
            raise CrewEpochCarrierError(
                f"crew_epoch.json ancestor became a symlink or reparse point: {ancestor}"
            )
        if node_identity(ancestor_after) != expected_identity:
            raise CrewEpochCarrierError(
                f"crew_epoch.json ancestor changed while reading: {ancestor}"
            )
    return data


def _iter_operation_records(root: Path, records: tuple[dict, ...] | None = None):
    """W2-001: Yield every parseable operation.json from both ops and settled.

    Uses the canonical semantic receipt snapshot from journal.py instead
    of scanning only recovery/ops. This ensures committed receipts that
    have been moved to recovery/settled remain visible to crew readers.

    When ``records`` is given (a pre-captured receipt snapshot), iterate it
    instead of reopening disk: every crew/sub evidence helper consumes the
    SAME coherent capture, so a snapshot performs one manifest traversal
    instead of one per helper (T-1004 perf).
    """
    if records is not None:
        yield from records
        return
    from .journal import semantic_receipt_snapshot
    snapshot = semantic_receipt_snapshot(root)
    if snapshot.errors:
        return
    yield from snapshot.records


def _capture_operation_receipts(root: Path):
    """W2-001: ONE coherent operation-receipt capture from both ops and settled.

    Uses the canonical semantic receipt snapshot from journal.py and
    digests the EXACT bytes from both namespaces.

    The digest covers operation-directory identity plus exact operation.json
    and progress.json authority from both ops/ and settled/ -- never *.staged
    payload bytes, which cannot change a crew verdict (T-1004 perf). Invalid
    structural entries feed deterministic sentinels, so adding/removing or
    replacing either authority always stales the capture.
    """
    from .journal import semantic_receipt_snapshot

    # Authority selection, strict decoding, duplicate handling, corruption and
    # the byte-stability token all come from one canonical traversal.
    return semantic_receipt_snapshot(root)


def _capture_receipt_digest(root: Path, snapshot=None) -> str:
    """Lightweight stability digest over both receipt namespaces.

    W2-002: the closing proof is a FRESH live capture, not the opening
    snapshot's stored digest. A new PREPARED operation, settled receipt,
    tampered manifest or corrupt progress entry between the opening scan
    and the crew decision must stale the verdict; comparing the opening
    digest with itself cannot detect that. Reading membership and bytes
    again costs O(present receipts) and detects every concurrent change.

    The helper never decodes JSON and never reads staged payloads, so the
    closing pass stays byte-cheap. When the caller already has a clean
    opening snapshot, the closing capture is a deterministic
    `semantic_receipt_digest` over the same already-on-disk authority.
    """
    from .journal import semantic_receipt_digest

    return semantic_receipt_digest(root)


def _crew_epoch(
    root: Path, history: "HistorySnapshot", records: tuple[dict, ...] | None = None # noqa: F821
) -> CrewEpoch | None:
    """Derive the active crew epoch from STRUCTURED evidence -- never from
    LOG prose (T-1003 hostile finding 8).

    Since the carrier-loss wave, the epoch's DURABLE proof is the tracked
    `.saipen/kitchen/crew_epoch.json` written in the SAME journaled mutation
    as the converge_intent operation: it survives Git clone and the deletion
    of settled recovery receipts (RECOVERY SCRATCH != DURABLE PROJECT MEMORY).
    Legacy projects without the tracked file fall back to scanning COMMITTED
    `converge_intent` operation receipts. In both paths the LOG is consulted
    for one thing only: the event id of the line that carries
    `[op: <op_id>]`, which is lineage, not identity -- a matching LOG sentence
    is neither sufficient (item 8's hostile fact: unrelated receipt + matching
    prose) nor required.
    """
    found: list[tuple[str, str, str | None]] = []
    try:
        data = read_durable_crew_epoch(root)
    except CrewEpochCarrierError:
        # Present-but-corrupt durable authority may never downgrade to the
        # legacy recovery-receipt scan.  None makes every crew completion gate
        # non-green until the carrier is repaired from reviewed evidence.
        return None
    if data is not None:
        found.append((data["created_at"], data["op_id"], data.get("ticket_id")))
    else:
        for record in _iter_operation_records(root, records):
            meta = record.get("receipt_metadata") or {}
            if record.get("operation") != "converge_intent":
                continue
            if record.get("status") != "COMMITTED":
                continue
            if (
                meta.get("target") != "crew"
                or meta.get("operation") != "converge_intent"
                or meta.get("status") != "COMMITTED"
            ):
                continue
            created = _strict_created_at(record.get("created_at"))
            if not created:
                continue
            op_id = record.get("op_id")
            if not op_id:
                continue
            found.append((created, op_id, meta.get("ticket_id")))
    if not found:
        return None
    by_time: dict[str, list[tuple[str, str | None]]] = {}
    for created, op_id, ticket in found:
        by_time.setdefault(created, []).append((op_id, ticket))
    newest_time = max(by_time)
    top = by_time[newest_time]
    if len({item[0] for item in top}) > 1:
        # Two converge receipts at the same instant from different operations
        # cannot both own the epoch: ambiguous, fail closed.
        return None
    op_id, ticket = top[0]
    event = None
    for parsed in history.events:
        if parsed.get("op_id") == op_id:
            event = parsed["event"]
            break
    return CrewEpoch(event if event is not None else 0, op_id, ticket, newest_time)


def _release_evidence(
    root: Path, epoch: CrewEpoch | None, receipt_snapshot=None
) -> ReleaseEvidence | None:
    """Canonical release truth from the release engine's read-only verdict
    (T-1003 sweep): crew consumes the release-engine verdict, never a second
    self-attesting JSON scan. UNKNOWN/AMBIGUOUS are carried on the evidence so
    the gate reads them as not-PASS rather than as a green release."""
    if epoch is None or not epoch.created_at:
        return None
    from .release import release_verdict

    verdict = release_verdict(
        root, crew_epoch=epoch.op_id, receipt_snapshot=receipt_snapshot
    )
    if verdict["status"] == "ok":
        ev = verdict["evidence"]
        return ReleaseEvidence(
            ev["op_id"],
            ev["ticket_id"],
            ev.get("tag", ""),
            ev.get("source_head", ""),
            ev["closure_commit"],
            ev["created_at"],
            tuple(ev["stages"]),
            ev.get("pre_ship_evidence") or {},
            ev.get("source_tree_fingerprint", ""),
            ev.get("pre_ship_applicability") or {},
        )
    return ReleaseEvidence(
        op_id="",
        ticket="",
        tag="",
        source_head="",
        closure_commit="",
        created_at="",
        stages=(),
        pre_ship_evidence={},
        verdict=verdict["status"],
        verdict_reason=verdict.get("reason", ""),
    )


def _specialized_health(snapshot_source, root: Path, role, saipen_home: str) -> dict:
    """One source of saipen_home inside one coherent pass (T-1003 hostile
    finding 18): the caller captures STATE.saipen_home ONCE in the snapshot
    and hands it here -- the planner must never re-read a decision input
    halfway through derivation, or a moving state yields a mixed plan."""
    path = root / role.outbox_path
    model = parse_outbox(_read_maybe(path), role.name) if path.is_file() else None
    current_role = current_local_role_revision(root, role.name, saipen_home)
    statuses = {"ready": False, "reviewed": False}
    current_ids = []
    if model and not model.errors and snapshot_source and current_role:
        for package in model.packages:
            fields = package.fields
            status = fields.get("status")
            if status not in statuses:
                continue
            if (
                fields.get("source_head") == snapshot_source.source_head
                and fields.get("source_tree_fingerprint") == snapshot_source.source_tree_fingerprint
                and fields.get("role_revision") == current_role
            ):
                statuses[status] = True
                current_ids.append(package.package_id)
    errors = list(model.errors) if model else ([] if path.is_file() else ["no OUTBOX"])
    if (
        sum(
            1
            for package in (model.packages if model else ())
            if package.fields.get("status") == "ready" and package.package_id in current_ids
        )
        > 1
    ):
        errors.append("multiple current READY packages")
    return {
        "health": (
            HEALTH_INVALID
            if errors
            else HEALTH_READY_FOR_REVIEW
            if statuses["ready"]
            else HEALTH_CURRENT
            if statuses["reviewed"]
            else HEALTH_NOT_RUN
        ),
        "ready_current": statuses["ready"],
        "reviewed_current": statuses["reviewed"],
        "errors": errors,
        "package_ids": current_ids,
    }


def _producer_ready_health(
    snapshot_source, root: Path, role, saipen_home: str
) -> dict | None:
    """Strict READY-layer health shared by both producer roles."""
    from .producer import SETTLED_DIRNAME, StagingGeneration, producer_namespace

    namespace = producer_namespace(root, role.name)
    if not (namespace / "READY").exists() and not (namespace / SETTLED_DIRNAME).exists():
        return None
    # PERF-002: this branch only uses metadata (head/fingerprint/role_rev).
    # Skip payload materialization to keep READY population O(metadata).
    packages, scan_errors = StagingGeneration.scan_ready(
        namespace, materialize_payloads=False
    )
    current_role = current_local_role_revision(root, role.name, saipen_home)
    current = [
        package
        for package in packages
        if snapshot_source is not None
        and current_role
        and package.base_source_head == snapshot_source.source_head
        and package.base_source_tree_fingerprint == snapshot_source.source_tree_fingerprint
        and package.role_revision == current_role
    ]
    errors = [item.get("detail", "invalid READY") for item in scan_errors]
    status = (
        HEALTH_INVALID
        if errors
        else HEALTH_READY_FOR_REVIEW
        if current
        else HEALTH_NOT_RUN
    )
    health = {
        "health": status,
        "ready_current": bool(current),
        "reviewed_current": False,
        "errors": errors,
        "package_ids": [package.package_identity for package in current],
    }
    # Legacy caller shape for generic-sub saiwiki.
    health["outbox"] = dict(health)
    return health


def crew_snapshot(
    project_root: Path | str,
    current_capability: str | None = None,
    userperson_profile: dict | None = None,
) -> CrewSnapshot:
    root = Path(project_root)
    from userperson import effective_profile

    userperson = (
        userperson_profile
        if userperson_profile is not None
        else effective_profile(root)
    )
    state_path = root / ".saipen/STATE.md"
    board_path = root / ".saipen/BOARD.md"
    root_specs = _root_dependency_specs(root)
    root_before = _capture_dependencies(root_specs)
    # ONE coherent operation-receipt capture: every crew/sub evidence helper
    # below consumes the same parsed records, and the digest is the stability
    # token (operation.json identity+bytes only -- never *.staged payloads).
    semantic_snapshot = _capture_operation_receipts(root)
    records = semantic_snapshot.records
    receipt_errors = semantic_snapshot.errors
    stability_before = semantic_snapshot.digest
    state_text = _read_maybe(state_path)
    state = parse_state(state_text)
    state.get("phase", "")
    state.get("task", "")
    state.get("agent", "")
    state.get("mode", "")
    home = state.get("saipen_home") or ""
    home_specs = _home_dependency_specs(home)
    home_before = _capture_dependencies(home_specs)
    home_problem = _home_problem_for(home)
    source_id, source_error = _source_identity(root)
    source_token = source_identity_dependency(source_id) if source_id is not None else ""
    board_text = _read_maybe(board_path)
    from .log import read_history_snapshot

    history = read_history_snapshot(root)
    log_text = history.text
    board = parse_board(board_text)
    status = shared_contract_status(root, home, records=records)
    entries, manifest_errors = parse_manifest_file(root)
    entry_by_name = {entry.name: entry for entry in entries}
    roles = {}
    for role in CREW_ROLES:
        if role.role_class == "producer":
            from .producer import producer_namespace

            health = _producer_ready_health(source_id, root, role, home)
            if health is not None:
                health["instance_present"] = producer_namespace(root, role.name).is_dir()
        else:
            health = None
        if health is None and role.runtime_kind == "generic-sub":
            health = sub_instance_health(
                root, role.name, source_id, entry_by_name.get(role.name), records=records
            )
            health["instance_present"] = (root / SUBS_REL / role.name / "STATE.md").is_file()
        elif health is None:
            health = _specialized_health(source_id, root, role, home)
            health["instance_present"] = (root / role.outbox_path).is_file()
        roles[role.name] = health
    epoch = _crew_epoch(root, history, records)
    run_receipts = _crew_run_receipts(
        root, epoch.op_id if epoch else None, records, history=history
    )
    packages = {
        role.name: _current_packages_for(
            root, source_id, home, role, epoch.op_id if epoch else None, run_receipts
        )
        for role in CREW_ROLES
    }
    release = _release_evidence(root, epoch, semantic_snapshot)
    pending = tuple(pending_ops(root))
    from .journal import validate_op_id
    from .safeid import InvalidIdError

    def _safe_op_path(op_id: str) -> str:
        """One owned receipt-path builder: a hostile op_id must fail the
        snapshot, never escape the ops dir (T-1003 operational integrity)."""
        validate_op_id(op_id)
        return f".saipen/recovery/ops/{op_id}/operation.json"

    def _refuse_snapshot(detail: str) -> CrewSnapshot:
        """Fail-closed snapshot when a hostile op_id/path appears: the crew
        gate must go non-green with the detail, never hash an escaping path."""
        return CrewSnapshot(
            root,
            source_id,
            source_error,
            state_text,
            state,
            board_text,
            board,
            log_text,
            history.tail,
            history.events,
            home,
            home_problem,
            status,
            tuple(entries),
            tuple(manifest_errors),
            pending,
            roles,
            packages,
            epoch,
            release,
            {},
            False,
            records,
            receipt_errors,
            semantic_snapshot,
            current_capability=current_capability,
            userperson=userperson,
        )

    receipt_paths = set()
    try:
        if epoch is not None:
            # The epoch's DURABLE binding is the tracked crew_epoch.json when
            # it exists (carrier-loss wave): deleting settled recovery
            # receipts must not change the snapshot. Legacy epochs bind the
            # recovery receipt.
            tracked_epoch = root / ".saipen" / "kitchen" / "crew_epoch.json"
            if tracked_epoch.is_file():
                receipt_paths.add(".saipen/kitchen/crew_epoch.json")
            else:
                receipt_paths.add(_safe_op_path(epoch.op_id))
        if release is not None and release.op_id:
            # A non-green release verdict carries an empty op_id and is NOT a
            # receipt to bind; only a real terminal release has one.
            receipt_paths.add(_safe_op_path(release.op_id))
    except InvalidIdError as exc:
        return _refuse_snapshot(f"hostile op_id: {exc}")
    # T-1003 finding 9: the finalizer receipt is part of the crew CAS surface
    # too -- a published-then-forgotten finalization must stale the snapshot.
    finalizer = _finalizer_receipt(
        root, epoch.op_id if epoch else None, release.op_id if release else None, records
    )
    if finalizer is not None:
        try:
            receipt_paths.add(_safe_op_path(finalizer))
        except InvalidIdError as exc:
            return _refuse_snapshot(f"hostile finalizer op_id: {exc}")
    contract_receipt_path = status.get("inventory_receipt_path")
    if isinstance(contract_receipt_path, str) and contract_receipt_path:
        try:
            from .journal import owned_target_path

            owned_target_path(root, contract_receipt_path, kind="inventory-receipt")
            receipt_paths.add(contract_receipt_path)
        except InvalidIdError as exc:
            return _refuse_snapshot(f"hostile inventory_receipt_path: {exc}")
    receipt_hashes = {}
    for receipt_path in sorted(receipt_paths):
        receipt_hashes[receipt_path] = hash_file_dependency(root / receipt_path)
    # SRC-019:R2 -- collected BEFORE the closing revalidation, so the tree read
    # that decides applicability sits INSIDE the same observation window as
    # every other crew input. It used to run after `stable` had already been
    # computed, which let a snapshot advertise `stable=True` while its
    # applicability facts came from a later tree state; a race in the negative
    # direction could then skip a mandatory audit role.
    project_facts = _project_facts(root)
    if source_id is None:
        source_stable = False
    else:
        source_stable, _repeated_error = _revalidate_source_identity(root, source_id)
    root_after = _capture_dependencies(root_specs)
    # Re-scan ONLY operation.json membership + bytes for the stability proof
    # (the digest never reads *.staged payloads, which cannot change a crew
    # verdict -- T-1004 perf).
    stability_after = _capture_receipt_digest(root, semantic_snapshot)
    home_after = _capture_dependencies(home_specs)
    hashes = {**root_before, **home_before, **receipt_hashes}
    hashes[".saipen/recovery"] = stability_before
    if source_token:
        hashes["."] = source_token
    dependencies_stable = (
        root_before == root_after
        and home_before == home_after
        and stability_before == stability_after
        and not receipt_errors
        and not any(_unsafe_dependency(value) for value in hashes.values())
    )
    return CrewSnapshot(
        root,
        source_id,
        source_error,
        state_text,
        state,
        board_text,
        board,
        log_text,
        history.tail,
        history.events,
        home,
        home_problem,
        status,
        tuple(entries),
        tuple(manifest_errors),
        pending,
        roles,
        packages,
        epoch,
        release,
        hashes,
        source_stable and dependencies_stable,
        records,
        receipt_errors,
        semantic_snapshot,
        current_capability=current_capability,
        userperson=userperson,
        project_facts=project_facts,
        facts_source_bound=source_id is None or source_stable,
    )


def _role_applicability(snapshot: CrewSnapshot, role) -> tuple[str, str]:
    """`(verdict, reason)` for one built-in role against this snapshot's facts.

    One entry point so every consumer -- the roster stage, the sensor stages,
    the collect set and the final fixed point -- asks the same question of the
    same facts. Two of them disagreeing is precisely how a role would end up
    skipped in one place and demanded in another.

    A skip is also refused when the source moved while those facts were being
    read (SRC-019:R2). Retiring a mandatory role is the one answer that must be
    bound to a single observation; the opposite error only costs a pass.
    """
    from .applicability import verdict

    state, reason = verdict(getattr(role, "applicability", ALWAYS), snapshot.project_facts)
    if state == NOT_APPLICABLE and not snapshot.facts_source_bound:
        return (
            APPLICABLE,
            "source changed while the applicability facts were collected, so "
            f"{role.name} cannot be retired against this snapshot's source "
            "identity; applicability fails closed to APPLICABLE",
        )
    return state, reason


def applicable_roles(snapshot: CrewSnapshot, roles=None) -> tuple:
    """The subset of `roles` that has something to apply to in this project."""
    return tuple(
        role
        for role in (CREW_ROLES if roles is None else roles)
        if _role_applicability(snapshot, role)[0] != NOT_APPLICABLE
    )


def _project_facts(root: Path):
    """The applicability facts for this snapshot, or None if they cannot be had.

    Not collected when no built-in declares a condition. `crew_snapshot` is on
    the `cc`/`sc`/`status` hot path and the walk costs a Git subprocess plus a
    bounded read of every module in the tree; spending that to answer a
    question nobody asked is the kind of cost T-1019 counts. None resolves
    APPLICABLE for every probe, which is exactly the answer an all-`always`
    roster would have produced anyway -- the skip changes timing, never a
    verdict.

    Deliberately swallows every enumeration failure into None rather than
    raising: applicability decides whether OPTIONAL work runs, and a crew
    circuit must not be stopped by a probe. None resolves APPLICABLE in
    `applicability.verdict`, so the failure direction is "run the capability
    anyway", never "skip it quietly".
    """
    from .applicability import collect_facts

    if all(getattr(role, "applicability", ALWAYS) == ALWAYS for role in CREW_ROLES):
        return None
    try:
        return collect_facts(root)
    except (OSError, ValueError):
        return None


def _source_dict(snapshot: CrewSnapshot) -> dict:
    if snapshot.source_id is None:
        return {"error": snapshot.source_error or "UNKNOWN"}
    return {
        "source_head": snapshot.source_id.source_head,
        "source_tree_fingerprint": snapshot.source_id.source_tree_fingerprint,
    }


def _action(
    snapshot: CrewSnapshot,
    stage: str,
    action: str,
    role: str | None,
    contract: str,
    evidence: str,
    completion: str,
    *inputs: str,
) -> CrewAction:
    role_paths = ()
    write_boundary = ""
    if role is not None:
        role_paths = _role_paths_for(snapshot.root, role)
        write_boundary = str(
            snapshot.root / SUBS_REL
            if role != "saitranslate"
            else snapshot.root / ".saipen" / "saitranslate"
        )
    userperson_projection = None
    if role is not None and snapshot.userperson and snapshot.userperson.get("active"):
        from userperson import project_profile

        userperson_projection = project_profile(
            snapshot.userperson["preferences"],
            role,
            source_fingerprint=snapshot.userperson["effective_fingerprint"],
        )
    return CrewAction(
        stage,
        role,
        action,
        _source_dict(snapshot),
        contract,
        tuple(inputs),
        evidence,
        completion,
        execute_in_current_agent=True,
        role_paths=role_paths,
        write_boundary=write_boundary,
        then_action="REPLAN_CREW",
        # AUTO-002: every crew action is an EXECUTABLE instruction for the
        # current agent, never a terminal stop and never a human task. The
        # carrier is machine-readable so a weak model cannot misread a routing
        # action as a stop or as a request to bounce the work elsewhere.
        terminal=False,
        requires_human=False,
        next_action=action,
        resume_after="REPLAN_CREW",
        userperson_projection=userperson_projection,
    )


def _role_paths_for(root: Path, role: str) -> tuple[str, ...]:
    """The exact authority/state namespace a serial SC role run owns (item
    22): charter, STATE, BOARD, LOG and OUTBOX, all project-local."""
    from .subs import SUBS_REL

    if role == "saitranslate":
        base = ".saipen/saitranslate"
        return (
            f"{base}/STATE.md",
            f"{base}/BOARD.md",
            f"{base}/LOG.md",
            f"{base}/kitchen/OUTBOX.md",
            f"{SUBS_REL}/saitranslate.md",
        )
    return (
        f"{SUBS_REL}/{role}.md",
        f"{SUBS_REL}/{role}/STATE.md",
        f"{SUBS_REL}/{role}/BOARD.md",
        f"{SUBS_REL}/{role}/LOG.md",
        f"{SUBS_REL}/{role}/kitchen/OUTBOX.md",
    )


def _home_problem_for(saipen_home: str) -> str | None:
    if not saipen_home:
        return "HOME_REQUIRED: STATE.saipen_home is missing"
    home = Path(saipen_home)
    if not (
        (home / "extensions/subs/PROTOCOL.md").is_file()
        and ((home / "saipen/BOOT.md").is_file() or (home / "BOOT.md").is_file())
    ):
        return (
            "SYNC_SOURCE_UNAVAILABLE: saipen_home "
            f"{saipen_home!r} cannot provide installed protocol "
            "and extensions/subs/PROTOCOL.md"
        )
    return None


def _home_problem(snapshot: CrewSnapshot) -> str | None:
    """The home verdict captured before the snapshot's closing hash barrier."""
    return snapshot.home_problem


def _core_fixed_point(snapshot: CrewSnapshot, session_agent: str | None = None) -> tuple[bool, str]:
    """SC-7 fixed point (Wave 2 items 1/14): ONE shared convergence verdict
    plus attribution. DONE + task none + an empty workable board is NOT
    convergence proof -- the canonical E-I sequence (TEST, forced HUNT, CLEAN,
    post-clean TEST, final HUNT) must be recorded against the current source
    identity by structured receipts, and the working tree must be fully
    attributed. Missing/stale proof => UNSATISFIED => CONVERGE_CORE, never
    "phase DONE => tests probably happened".

    `session_agent` is the CURRENT-SESSION actor (second-wave P0): closure
    workability is judged relative to THIS identity, never to persisted
    STATE.agent (historical last-writer evidence). When None (a caller that
    does not know its own identity) the historical value is used for
    backward compatibility; the CLI/adapters always supply the session
    identity."""
    actor = session_agent or snapshot.state.get("agent") or "saipen-cli"
    errors = convergence_closure_problems(
        snapshot.board, actor, wait_role_roles=frozenset(role.name for role in CREW_ROLES)
    )
    if snapshot.state.get("phase") != "DONE":
        errors.append(f"Core phase is {snapshot.state.get('phase')!r}, not DONE")
    if snapshot.state.get("task") not in (None, "", "none"):
        errors.append(f"Core task is {snapshot.state.get('task')!r}, not none")
    verdict = convergence_verdict(
        snapshot.root, snapshot.source_id, receipt_snapshot=snapshot.receipt_snapshot
    )
    if not verdict.ok:
        errors.append("canonical convergence proof missing: " + "; ".join(verdict.reasons[:3]))
    return not errors, "; ".join(errors[:3])


def _sensor_executed(snapshot: CrewSnapshot, role) -> tuple[bool, str]:
    """Whether a core-review sensor stage is satisfied.

    Item 7: currentness and crew-run freshness are DIFFERENT facts. A package
    that binds the current source triple but was produced BEFORE the active
    crew epoch may remain valid historical evidence -- it does NOT certify the
    new SC stage. The stage requires at least one current package bound to
    THIS epoch by a committed crew_run receipt."""
    health = snapshot.roles[role.name]
    kind = health.get("health")
    ok = kind in (HEALTH_CURRENT, HEALTH_READY_FOR_REVIEW, HEALTH_REVIEW_PENDING)
    if kind == HEALTH_INVALID:
        errors = health.get("board", {}).get("errors", []) + health.get("outbox", {}).get(
            "errors", []
        )
        return False, "invalid role evidence: " + "; ".join(errors[:2])
    if kind == HEALTH_BLOCKED:
        return False, "role has operational BLOCKED work"
    if kind == HEALTH_WORK_PENDING:
        return False, "role board has pending work"
    if kind == HEALTH_STALE:
        return False, "role/package evidence is stale"
    if not ok:
        return (
            False,
            "role has no current certification" if kind == HEALTH_NOT_RUN else f"health is {kind}",
        )
    if ok and not _current_packages(snapshot, role):
        return False, (
            "role evidence predates the active crew epoch -- CURRENT != FRESH FOR THIS CREW EPOCH"
        )
    return True, ""


def _worktree_matches_head(root: Path, require_git: bool = False) -> bool:
    """The source worktree equals HEAD exactly (T-1003 sweep, finding 13/17).

    HEAD equality is not worktree equality. `.saipen` runtime mutations stay
    excluded per the canonical freshness rules; any other tracked delta or
    untracked source file makes post-ship certification impossible. For a FULL
    published release (require_git=True) a project without Git cannot prove
    worktree == shipped commit: no-git inability is UNKNOWN and never a
    vacuous PASS -- that vacuity belongs only to explicit no-publish
    semantics.
    """
    deltas = source_worktree_deltas(root)
    if deltas is None:
        return not require_git
    return not deltas


def _pre_ship_applicability(snapshot: CrewSnapshot) -> dict:
    """The applicability manifest to FREEZE into the release receipt (R1).

    Every built-in role gets an entry -- including the retired ones, whose
    reason is the whole point: a receipt that simply omits a role cannot be
    told apart from a receipt written before the role existed. Each entry
    carries the source identity the verdict was read against, so a verdict
    copied from another source cannot pass as this release's own.
    """
    source = _source_dict(snapshot)
    manifest = {}
    for role in CREW_ROLES:
        state, reason = _role_applicability(snapshot, role)
        manifest[role.name] = {
            "probe": getattr(role, "applicability", ALWAYS),
            "verdict": state,
            "reason": reason,
            "source_head": source.get("source_head", ""),
            "source_tree_fingerprint": source.get("source_tree_fingerprint", ""),
        }
    return manifest


def _certified_role_names(release: ReleaseEvidence) -> tuple[tuple[str, ...], str]:
    """`(role names the receipt must carry evidence for, problem)`.

    Reads the FROZEN manifest, never the current tree: post-ship
    certification of a shipped release must not change verdict because a UI
    file was added or deleted after the ship. A malformed or unbound manifest
    entry is a refusal, not a silent fallback to the full roster -- falling
    back would let a broken manifest look like an old receipt.
    """
    manifest = release.pre_ship_applicability or {}
    if not manifest:
        return tuple(role.name for role in CREW_ROLES), ""
    required = []
    for role in CREW_ROLES:
        record = manifest.get(role.name)
        if not isinstance(record, dict):
            return (), f"release applicability manifest has no entry for {role.name}"
        state = record.get("verdict")
        if state not in (APPLICABLE, NOT_APPLICABLE):
            return (), (
                f"release applicability manifest carries no usable verdict for {role.name}"
            )
        if not record.get("reason"):
            return (), f"release applicability manifest states no reason for {role.name}"
        if record.get("source_head") != release.source_head:
            return (), (
                f"release applicability verdict for {role.name} is bound to a "
                "different source than the release it claims to certify"
            )
        if record.get("source_tree_fingerprint") != release.source_tree_fingerprint:
            return (), (
                f"release applicability verdict for {role.name} is bound to a "
                "different source tree than the release it claims to certify"
            )
        if state == APPLICABLE:
            required.append(role.name)
    forged = [
        name
        for name in release.pre_ship_evidence
        if isinstance(manifest.get(name), dict)
        and manifest[name].get("verdict") == NOT_APPLICABLE
    ]
    if forged:
        return (), (
            "release carries pre-ship evidence for role(s) its own "
            "applicability manifest retired: " + ", ".join(sorted(forged))
        )
    return tuple(required), ""


def _missing_pre_ship_evidence(release: ReleaseEvidence) -> str:
    required, problem = _certified_role_names(release)
    if problem:
        return problem
    missing = [name for name in required if name not in release.pre_ship_evidence]
    if missing:
        return "release lacks pre-ship crew evidence: " + ", ".join(missing)
    return ""


def _release_current(
    snapshot: CrewSnapshot, current_capability: str | None = None
) -> tuple[bool, str]:
    # P0#4: the CURRENT-SESSION capability authorizes crew release closure. A
    # persisted STATE.mode is historical; a read-only session cannot close a
    # crew release. When no capability was injected (legacy internal call) the
    # persisted mode governs, but the public `saipen crew` command always
    # negotiates and injects one.
    if current_capability is None:
        current_capability = getattr(snapshot, "current_capability", None)
    if current_capability == "read-only":
        return False, (
            "current session capability is read-only; crew "
            "release closure is refused in a read-only session "
            "(capability injected at the command boundary)"
        )
    release = snapshot.release
    if release is None or not release.verdict:
        return False, "no canonical release receipt binds this crew epoch"
    if release.verdict != "ok":
        return False, f"crew release truth {release.verdict.upper()}: " + release.verdict_reason
    mode = snapshot.state.get("mode") or "full"
    if mode == "no-publish":
        # Item 16: a no-publish terminal crew release is verified for LOCAL
        # closure truth (release_verdict already proved it) -- zero Git
        # requirements, so closure==HEAD and worktree checks do not apply.
        if snapshot.state.get("phase") != "DONE" or snapshot.state.get("task") not in (
            None,
            "",
            "none",
        ):
            return False, "no-publish closure requires Core DONE / task none"
        problem = _missing_pre_ship_evidence(release)
        if problem:
            return False, problem
        return True, ""
    if snapshot.source_id is None:
        return False, "source identity unavailable"
    if release.closure_commit != snapshot.source_id.source_head:
        return False, "crew release closure is not current HEAD"
    if not _worktree_matches_head(snapshot.root, require_git=True):
        return (
            False,
            "post-ship certification requires the working tree to "
            "equal the shipped commit exactly; a dirty tree (or an "
            "unprovable one) is not shipped HEAD",
        )
    problem = _missing_pre_ship_evidence(release)
    if problem:
        return False, problem
    return True, ""


def _certified_roles(snapshot: CrewSnapshot) -> tuple:
    """The roles post-ship certification must cover: the FROZEN set when the
    receipt carries a manifest, today's live set only for pre-SRC-019 receipts.
    """
    release = snapshot.release
    if release is None or not release.pre_ship_applicability:
        return applicable_roles(snapshot)
    required, problem = _certified_role_names(release)
    if problem:
        return applicable_roles(snapshot)
    names = set(required)
    return tuple(role for role in CREW_ROLES if role.name in names)


def _current_packages_for(
    root: Path,
    source_id,
    saipen_home: str,
    role,
    crew_epoch: str | None = None,
    run_receipts: tuple[dict, ...] = (),
) -> list[dict]:
    """Current pre-ship package evidence, epoch-bound (T-1003 findings 7/13).

    A package must (1) bind the current source triple + role revision AND (2)
    carry a crew-run receipt for the CURRENT epoch binding its immutable
    package identity. An old package before a new SC epoch may remain valid
    historical/standalone evidence; it MUST NOT satisfy the new SC
    certification (CURRENT != FRESH FOR THIS CREW EPOCH). The returned record
    carries the immutable package_identity and exact source bindings -- labels
    are not evidence.
    """
    path = root / role.outbox_path
    if not path.is_file() or source_id is None:
        return []
    model = parse_outbox(_read_maybe(path), role.name)
    current_role = current_local_role_revision(root, role.name, saipen_home)
    if model.errors or current_role is None:
        return []
    certified = set()
    if crew_epoch is not None:
        for record in run_receipts:
            meta = record.get("receipt_metadata") or {}
            if meta.get("role") != role.name:
                continue
            for identity in meta.get("package_identities") or ():
                certified.add(identity)
    out = []
    for package in model.packages:
        if package.fields.get("status") not in ("ready", "reviewed"):
            continue
        if package.fields.get("source_head") != source_id.source_head:
            continue
        if package.fields.get("source_tree_fingerprint") != source_id.source_tree_fingerprint:
            continue
        if package.fields.get("role_revision") != current_role:
            continue
        identity = package_identity(package)
        if crew_epoch is not None and identity not in certified:
            continue
        out.append(
            {
                "package_id": package.package_id,
                "status": package.fields.get("status"),
                "role_revision": current_role,
                "producer": role.name,
                "package_identity": identity,
                "source_head": package.fields.get("source_head"),
                "source_tree_fingerprint": package.fields.get("source_tree_fingerprint"),
                "crew_epoch": crew_epoch,
            }
        )
    return out


def _current_packages(snapshot: CrewSnapshot, role) -> list[dict]:
    """Return package evidence captured inside the coherent snapshot."""
    return list(snapshot.packages.get(role.name, ()))


def _crew_run_receipts(
    root: Path,
    epoch_op_id: str | None,
    records: tuple[dict, ...] | None = None,
    *,
    history: "HistorySnapshot",  # noqa: F821
) -> tuple[dict, ...]:
    """Every COMMITTED crew_run receipt for the epoch (item 7): structured
    proof a role actually ran IN this epoch and bound its package identities
    to epoch + role + source + role_revision.

    T-1430: a receipt counts only when the journal wrote it -- the LOG event
    its metadata names carries this receipt's own `[op: ...]` tag. A
    hand-written operation.json has a decoder-valid shape and no such line,
    and it satisfied SC-2 while no shipped command could produce a receipt.
    """
    out = []
    if not epoch_op_id:
        return ()
    logged = {
        parsed.get("op_id"): parsed.get("event")
        for parsed in history.events
        if parsed.get("op_id")
    }
    for record in _iter_operation_records(root, records):
        meta = record.get("receipt_metadata") or {}
        if record.get("operation") != "crew_run":
            continue
        if record.get("status") != "COMMITTED":
            continue
        if meta.get("crew_epoch") != epoch_op_id:
            continue
        if not _strict_created_at(record.get("created_at")):
            continue
        event_id = str(meta.get("event_id") or "")
        if not event_id.startswith("E-") or f"E-{logged.get(record.get('op_id'))}" != event_id:
            continue
        out.append(record)
    return tuple(out)


def crew_record_run(
    project_root: Path | str,
    agent: str,
    role_name: str,
    package_ids: list[str] | None = None,
    dry_run: bool = False,
) -> Result:
    """T-1430: the ONE canonical producer of a crew_run receipt.

    `operations.record_crew_run` had no caller, so a sensor stage (SC-2 for
    saihunt) could be satisfied only by a hand-written receipt. This binds the
    role's CURRENT packages -- ready/reviewed OUTBOX packages carrying the live
    source triple and the current role revision -- to the ACTIVE crew epoch
    through the journaled writer. The caller names only the role and,
    optionally, which packages; epoch, source identity and role revision are
    read, never supplied, and a named package that is not current is refused.
    """
    from .log import read_history_snapshot
    from .operations import record_crew_run

    root = Path(project_root)
    role = next((item for item in CREW_ROLES if item.name == role_name), None)
    if role is None:
        return _refuse(
            "INVALID_ROLE",
            f"{role_name!r} is not a crew role",
            roles=[item.name for item in CREW_ROLES],
        )
    state = parse_state(_read_maybe(root / ".saipen/STATE.md"))
    home = state.get("saipen_home") or ""
    history = read_history_snapshot(root)
    records = _capture_operation_receipts(root).records
    epoch = _crew_epoch(root, history, records)
    if epoch is None:
        return _refuse(
            "CREW_NOT_READY",
            "no active crew epoch: a crew run is recorded inside a running crew circuit",
            canonical_next_command="saipen crew",
        )
    source_id, source_error = _source_identity(root)
    if source_id is None:
        return _refuse(
            "SOURCE_IDENTITY_UNKNOWN",
            f"the live source identity is unavailable: {source_error}",
        )
    current = _current_packages_for(root, source_id, home, role)
    by_id = {package["package_id"]: package for package in current}
    if package_ids:
        stale = [package_id for package_id in package_ids if package_id not in by_id]
        if stale:
            return _refuse(
                "STALE_PACKAGE",
                f"{', '.join(stale)} is not a current {role.name} package: it must be "
                "ready or reviewed and carry the live source triple and the current "
                "role revision",
                current=sorted(by_id),
            )
        chosen = [by_id[package_id] for package_id in package_ids]
    else:
        chosen = current
    if not chosen:
        return _refuse(
            "NO_READY_PACKAGE",
            f"{role.name} has no current package to bind to crew epoch {epoch.op_id}",
        )
    return record_crew_run(
        root,
        agent,
        crew_epoch=epoch.op_id,
        role=role.name,
        source_head=source_id.source_head,
        source_tree_fingerprint=source_id.source_tree_fingerprint,
        role_revision=chosen[0]["role_revision"],
        package_identities=[package["package_identity"] for package in chosen],
        dry_run=dry_run,
    )


def _finalizer_receipt(
    root: Path,
    epoch_op_id: str | None,
    release_op_id: str | None,
    records: tuple[dict, ...] | None = None,
) -> str | None:
    """The COMMITTED structured finalizer op for epoch+release, or None
    (item 9: the final gate binds the committed finalize_converge_intent
    operation receipt, never a LOG sentence)."""
    if not epoch_op_id or not release_op_id:
        return None
    for record in _iter_operation_records(root, records):
        meta = record.get("receipt_metadata") or {}
        if record.get("operation") != "finalize_crew":
            continue
        if record.get("status") != "COMMITTED":
            continue
        if meta.get("target") != "crew":
            continue
        if meta.get("crew_epoch") != epoch_op_id:
            continue
        if meta.get("release_op_id") != release_op_id:
            continue
        return record.get("op_id") or ""
    return None


def _producer_integration_receipts(
    root: Path, epoch_op_id: str | None, records: tuple[dict, ...] | None = None
) -> tuple[dict, ...]:
    """Every COMMITTED producer_integration receipt for the epoch (item 11):
    the S0 -> S1 integration EDGE, never a rewritten package provenance."""
    out = []
    if not epoch_op_id:
        return ()
    for record in _iter_operation_records(root, records):
        meta = record.get("receipt_metadata") or {}
        if record.get("operation") != "producer_integration":
            continue
        if record.get("status") != "COMMITTED":
            continue
        if meta.get("crew_epoch") != epoch_op_id:
            continue
        if not _strict_created_at(record.get("created_at")):
            continue
        out.append(record)
    return tuple(out)


def derive_crew_scope(
    snapshot: CrewSnapshot, records: tuple[dict, ...] | None = None
) -> tuple[dict, str | None]:
    """Item 5: the terminal crew release surface is DERIVED from committed
    crew-defer receipts -- never git status, never a manual list, never prose.

    For every path the latest owning defer approved: its current bytes MUST
    equal the bytes that review approved; a later unreviewed mutation is
    stale/refuse. A deleted path stays an exact deletion identity. Overlapping
    ticket scopes are legal because the latest owning defer owns the later
    bytes."""
    root = snapshot.root
    epoch = snapshot.epoch
    if epoch is None:
        return {}, "active crew epoch missing"
    by_path: dict[str, tuple[tuple[str, str], object]] = {}
    for record in _iter_operation_records(root, records):
        meta = record.get("receipt_metadata") or {}
        if record.get("operation") != "crew_defer":
            continue
        if record.get("status") != "COMMITTED":
            continue
        if meta.get("crew_epoch") != epoch.op_id:
            continue
        created = _strict_created_at(record.get("created_at"))
        if not created:
            continue
        op_id = record.get("op_id") or ""
        for rel, expected in (meta.get("paths") or {}).items():
            key = (created, op_id)
            prev = by_path.get(rel)
            if prev is None or key > prev[0]:
                by_path[rel] = (key, expected)
    scope: dict[str, object] = {}
    for rel, (_key, expected) in by_path.items():
        fp = root / rel
        if expected is None:
            if fp.exists():
                return (
                    {},
                    f"crew scope path {rel} is a reviewed deletion "
                    "but exists again -- stale, refuse",
                )
        else:
            if not fp.is_file():
                return {}, f"crew scope path {rel} is missing"
            if _quick_hash(fp.read_bytes()) != expected:
                return (
                    {},
                    f"crew scope path {rel} changed after the owning "
                    "defer -- stale, re-review before terminal release",
                )
        scope[rel] = expected
    if not scope:
        return {}, "no deferred crew scope recorded (DEFER_FOR_CREW ran for zero tickets)"
    return scope, None


def crew_ready_for_terminal_ship(
    snapshot: CrewSnapshot,
    stages: list[dict] | None = None,
) -> tuple[bool, str]:
    """ONE dedicated terminal-ship authorization predicate (T-1003 finding 6).

    It requires EXACTLY SC-0..SC-10 all present, all SATISFIED, one coherent
    snapshot, no active Core ticket, no WAITING predecessor, and the active
    crew epoch bound. MISSING EVIDENCE != PASS: an absent mandatory stage is a
    refusal, not "not relevant". Planner display is never authorization proof.
    """
    if snapshot.state.get("task") not in (None, "", "none"):
        return False, "active Core ticket prevents terminal ship"
    if snapshot.epoch is None or not snapshot.epoch.created_at:
        return False, "active crew epoch missing"
    if not snapshot.stable:
        return False, "crew snapshot is not coherent/stable"
    if stages is None:
        stages, _action_value = _evaluate(snapshot, ignore_active_task=True)
    required = {f"SC-{n}" for n in range(0, 11)}
    present = {stage["stage"] for stage in stages}
    missing = sorted(required - present)
    if missing:
        return False, "mandatory crew stages absent: " + ", ".join(missing)
    blockers = [
        stage for stage in stages if stage["stage"] in required and stage["state"] != SATISFIED
    ]
    if blockers:
        return False, "terminal ship authorization missing: " + "; ".join(
            f"{stage['stage']} {stage['reason']}" for stage in blockers[:3]
        )
    return True, ""


def _producer_package_records(snapshot: CrewSnapshot, role) -> list[dict]:
    """Current source-bound producer package evidence for the release receipt.
    Producers are proven by their integration EDGE; the receipt still records
    the exact package identity + source bindings (item 13: labels are not
    evidence)."""
    if snapshot.source_id is None:
        return []
    path = snapshot.root / role.outbox_path
    model = parse_outbox(_read_maybe(path), role.name) if path.is_file() else None
    if model is None or model.errors:
        return []
    current_role = current_local_role_revision(snapshot.root, role.name, snapshot.saipen_home)
    out = []
    for package in model.packages:
        if package.fields.get("status") not in ("ready", "reviewed"):
            continue
        if package.fields.get("source_head") != snapshot.source_id.source_head:
            continue
        if (
            package.fields.get("source_tree_fingerprint")
            != snapshot.source_id.source_tree_fingerprint
        ):
            continue
        out.append(
            {
                "package_id": package.package_id,
                "status": package.fields.get("status"),
                "role_revision": current_role,
                "producer": role.name,
                "package_identity": package_identity(package),
                "source_head": package.fields.get("source_head"),
                "source_tree_fingerprint": package.fields.get("source_tree_fingerprint"),
                "crew_epoch": snapshot.epoch.op_id if snapshot.epoch else None,
            }
        )
    return out


def crew_release_context(project_root: Path | str) -> dict:
    """Evidence canonical release stores when active crew authorizes SHIP."""
    snapshot = crew_snapshot(project_root)
    if (
        snapshot.state.get("execution_intent") != "converge"
        or snapshot.state.get("converge_target") != "crew"
        or snapshot.epoch is None
    ):
        return {"ok": False, "detail": "active crew epoch missing"}
    stages, _next = _evaluate(snapshot, ignore_active_task=True)
    ok, reason = crew_ready_for_terminal_ship(snapshot, stages)
    if not ok:
        return {"ok": False, "detail": "crew not ready to ship: " + reason}
    scope, scope_problem = derive_crew_scope(snapshot, snapshot.op_records)
    if scope_problem:
        return {"ok": False, "detail": scope_problem}
    evidence = {}
    for role in applicable_roles(snapshot):
        evidence[role.name] = (
            _current_packages(snapshot, role)
            if role.role_class == "core-review"
            else _producer_package_records(snapshot, role)
        )
    missing = [name for name, packages in evidence.items() if not packages]
    if missing:
        return {
            "ok": False,
            "detail": "current pre-ship package identity missing: " + ", ".join(missing),
        }
    return {
        "ok": True,
        "crew_epoch": snapshot.epoch.op_id,
        "crew_pre_ship_source": _source_dict(snapshot),
        "crew_pre_ship_evidence": evidence,
        "crew_pre_ship_applicability": _pre_ship_applicability(snapshot),
        "crew_defer_scope": scope,
        "ticket_id": snapshot.epoch.ticket or "",
    }


def _post_ship(snapshot: CrewSnapshot) -> tuple[bool, str, CrewAction | None]:
    release_ok, reason = _release_current(snapshot)
    if not release_ok:
        return False, reason, None
    for role in _certified_roles(snapshot):
        health = snapshot.roles[role.name]
        if role.role_class == "core-review":
            kind = health.get("health")
            if kind == HEALTH_CURRENT:
                continue
            if kind == HEALTH_READY_FOR_REVIEW:
                return (
                    False,
                    (
                        f"{role.name}: package ready against shipped HEAD -- "
                        "COLLECT is the missing action, never a rerun"
                    ),
                    _action(
                        snapshot,
                        "SC-12",
                        "COLLECT_ROLE",
                        role.name,
                        "post-ship package durably ingested once",
                        "Core review unit + durable collect receipt",
                        f"{role.name} health REVIEW_PENDING",
                        role.outbox_path,
                    ),
                )
            if kind == HEALTH_REVIEW_PENDING:
                if health.get("collect", {}).get("disposition_pending"):
                    return (
                        False,
                        (
                            f"{role.name}: linked Core review is terminal; the "
                            "reviewed claim is the pending disposition"
                        ),
                        _action(
                            snapshot,
                            "SC-12",
                            "DISPOSE_REVIEW",
                            role.name,
                            "terminal Core review marks the package reviewed",
                            "sub_disposition receipt",
                            f"{role.name} health CURRENT",
                            role.outbox_path,
                        ),
                    )
                ticket = health.get("collect", {}).get("review_ticket")
                return (
                    False,
                    (
                        f"{role.name}: collected, Core review "
                        f"{ticket or 'ticket'} open -- terminal human/agent "
                        "review blocker"
                    ),
                    None,
                )
            _ok, role_reason = _sensor_executed(snapshot, role)
            return (
                False,
                f"{role.name}: {role_reason or 'not reviewed'}",
                _action(
                    snapshot,
                    "SC-12",
                    "RUN_ROLE",
                    role.name,
                    "post-ship current sensor package against shipped HEAD",
                    "complete source-bound package bound to the shipped source",
                    "worker health READY_FOR_REVIEW or CURRENT against shipped HEAD",
                    role.outbox_path,
                ),
            )
    translate = snapshot.roles["saitranslate"]
    if not translate.get("ready_current"):
        return (
            False,
            "final EE is not READY/current",
            _action(
                snapshot,
                "SC-12",
                "PREPARE_TRANSLATE_FINAL",
                "saitranslate",
                "fresh terminal producer package",
                "READY translation package",
                "READY/current package against shipped HEAD",
                next(r.outbox_path for r in CREW_ROLES if r.name == "saitranslate"),
            ),
        )
    wiki = snapshot.roles["saiwiki"]
    if not wiki.get("outbox", {}).get("ready_current"):
        return (
            False,
            "final QQ is not READY/current",
            _action(
                snapshot,
                "SC-12",
                "PREPARE_WIKI_FINAL",
                "saiwiki",
                "fresh terminal producer package",
                "READY wiki package",
                "READY/current package against shipped HEAD",
                next(r.outbox_path for r in CREW_ROLES if r.name == "saiwiki"),
            ),
        )
    return True, "", None


def _producer_integrated(snapshot: CrewSnapshot, role) -> bool:
    """Item 11: a producer is integrated iff a structured integration EDGE
    binds its immutable package identity to an input source (S0) that the
    package STILL records, with a resulting source (S1) equal to the current
    source. The package is truthfully bound to S0 -- integration makes it
    naturally stale against newer sources; it must never be rewritten to
    claim S1."""
    if snapshot.epoch is None or snapshot.source_id is None:
        return False
    receipts = _producer_integration_receipts(
        snapshot.root, snapshot.epoch.op_id, snapshot.op_records
    )
    matching = [
        record
        for record in receipts
        if (record.get("receipt_metadata") or {}).get("producer") == role.name
    ]
    if not matching:
        return False
    from .board import iso_utc_sort_key

    _earliest = iso_utc_sort_key("0000-01-01T00:00:00Z")
    latest = max(
        matching,
        key=lambda record: (
            iso_utc_sort_key(record.get("created_at", "")) or _earliest,
            record.get("op_id", ""),
        ),
    )
    meta = latest.get("receipt_metadata") or {}
    from .producer import ProducerPackage, SETTLED_DIRNAME, producer_namespace

    package = None
    settled = producer_namespace(snapshot.root, role.name) / SETTLED_DIRNAME
    if settled.is_dir():
        for path in sorted(settled.glob("*.json")):
            try:
                candidate = ProducerPackage.from_dict(
                    json.loads(path.read_text(encoding="utf-8")),
                    expected_producer=role.name,
                    ready_path=path,
                )
            except Exception:
                return False
            if candidate.package_identity == meta.get("package_identity"):
                package = candidate
                break
    if package is None:
        # Compatibility for pre-READY-layer crew receipts.
        model = parse_outbox(_read_maybe(snapshot.root / role.outbox_path), role.name)
        legacy = next(
            (
                item
                for item in model.packages
                if package_identity(item) == meta.get("package_identity")
            ),
            None,
        )
        if legacy is None:
            return False
        if legacy.fields.get("source_head") != meta.get("input_source"):
            return False
    else:
        # Found a SETTLED package matching the receipt's package identity.
        # A content-identical re-bind (same package_identity and content,
        # refreshed source binding) legitimately leaves the SETTLED package's
        # base_source_head older than the receipt's input_source -- the
        # identity match plus the resulting-source check below are the true
        # authority, not the stale base binding. This is the crew treadmill
        # fix (E-3836): without it every content-identical re-integration
        # never satisfies SC-8/SC-9.
        pass
    return (
        meta.get("resulting_source") == snapshot.source_id.source_head
        and meta.get("resulting_source_fingerprint") == snapshot.source_id.source_tree_fingerprint
    )


def _producer_oscillation(snapshot: CrewSnapshot) -> str | None:
    """Item 12: detect a producer pair whose integrations keep invalidating
    each other's package source bindings -- root-cause block, never an
    infinite rerun loop."""
    if snapshot.epoch is None:
        return None
    receipts = _producer_integration_receipts(
        snapshot.root, snapshot.epoch.op_id, snapshot.op_records
    )
    by_role: dict[str, list[dict]] = {}
    for record in receipts:
        producer = (record.get("receipt_metadata") or {}).get("producer")
        if producer:
            by_role.setdefault(producer, []).append(record)
    if len(by_role) < 2:
        return None
    heads: dict[str, str] = {}
    for name in by_role:
        role = ROLE_REGISTRY.get(name)
        if role is None:
            continue
        model = parse_outbox(_read_maybe(snapshot.root / role.outbox_path), name)
        ready = [p for p in model.packages if p.fields.get("status") in ("ready", "reviewed")]
        if ready:
            heads[name] = ready[-1].fields.get("source_head", "")
    names = [name for name in by_role if name in heads]
    from .board import iso_utc_sort_key

    _earliest = iso_utc_sort_key("0000-01-01T00:00:00Z")
    for index, a in enumerate(names):
        for b in names[index + 1 :]:
            la = max(
                by_role[a],
                key=lambda r: (
                    iso_utc_sort_key(r.get("created_at", "")) or _earliest,
                    r.get("op_id", ""),
                ),
            )
            lb = max(
                by_role[b],
                key=lambda r: (
                    iso_utc_sort_key(r.get("created_at", "")) or _earliest,
                    r.get("op_id", ""),
                ),
            )
            ra = (la.get("receipt_metadata") or {}).get("resulting_source")
            rb = (lb.get("receipt_metadata") or {}).get("resulting_source")
            if heads.get(b) != ra and heads.get(a) != rb:
                return (
                    f"producer oscillation {a}<->{b}: {b}'s package is "
                    f"invalidated by {a}'s integration and {a}'s package "
                    f"is invalidated by {b}'s -- rerunning would loop; "
                    "root-cause the overlapping payload surface before "
                    "continuing"
                )
    return None


def _wait_role_evidence_ready(snapshot: CrewSnapshot, role_name: str) -> bool:
    """Item 10: a WAIT_ROLE:<role> blocker is cleared only by the role's
    actual evidence -- sensor intake or producer integration edge."""
    role = ROLE_REGISTRY.get(role_name)
    if role is None:
        return False
    if role.role_class == "core-review":
        # A durably collected package is real evidence (intake happened), even
        # while the Core review ticket is still open.
        return snapshot.roles.get(role_name, {}).get("health") in (
            HEALTH_CURRENT,
            HEALTH_READY_FOR_REVIEW,
            HEALTH_REVIEW_PENDING,
        )
    return _producer_integrated(snapshot, role)


def _wait_role_dispositions(snapshot: CrewSnapshot) -> list[str]:
    """WAIT_ROLE tickets whose owning built-in role has produced evidence and
    now needs mechanical disposition (unblocked, not left to rot)."""
    out = []
    for ticket in snapshot.board.get("tickets", {}).values():
        if ticket.get("section") != "## BLOCKED":
            continue
        blocker = ticket.get("fields", {}).get("blocker", "")
        if blocker_class(blocker) != "WAIT_ROLE":
            continue
        role = wait_role_target(blocker)
        if role in ROLE_REGISTRY and _wait_role_evidence_ready(snapshot, role):
            out.append(ticket["id"])
    return out


def _evaluate(
    snapshot: CrewSnapshot, ignore_active_task: bool = False, session_agent: str | None = None,
    pre_finalization: bool = False,
) -> tuple[list[dict], CrewAction | None]:
    evaluations: list[tuple[str, str, str, str, CrewAction | None]] = []
    home_problem = _home_problem(snapshot)
    contract = snapshot.contract_status
    sc0_reason = ""
    sc0_action = None
    if snapshot.pending:
        sc0_reason = "unresolved recovery: " + ", ".join(
            item.get("op_id", "?") for item in snapshot.pending[:3]
        )
        sc0_action = _action(
            snapshot,
            "SC-0",
            "RECOVER",
            None,
            "no unresolved journal",
            "settled operation",
            "pending_ops is empty",
            ".saipen/recovery/ops",
        )
    elif home_problem:
        sc0_reason = home_problem
    elif not snapshot.stable:
        sc0_reason = "STALE_PLAN: crew inputs moved during snapshot"
    elif snapshot.source_error:
        sc0_reason = "source identity UNKNOWN: " + snapshot.source_error
    elif snapshot.manifest_errors:
        # Wave 3: distinguish absence vs corruption. A missing MANIFEST on a
        # fresh consuming project is first-run bootstrap, not integrity damage.
        # Malformed existing registry remains fail-closed.
        if len(snapshot.manifest_errors) == 1 and "no MANIFEST.md" in snapshot.manifest_errors[0]:
            # Missing is not SC-0 blocker -- fall through to shared-contract
            # evaluation: SC-0 owns recovery/home/source/shared-contract,
            # SC-1 owns roster assurance. If contract drift exists, SC-0 will
            # produce SYNC_SHARED; otherwise SC-0 passes and SC-1 spawns.
            if not contract.get("current"):
                drift = (
                    contract.get("missing_files", [])
                    + contract.get("missing_dirs", [])
                    + contract.get("stale_files", [])
                    + contract.get("obsolete_files", [])
                    + contract.get("obsolete_dirs", [])
                    + contract.get("unexpected_files", [])
                    + contract.get("unexpected_dirs", [])
                )
                if contract.get("inventory_lineage") == "ambiguous":
                    drift.append("sub-sync receipt lineage ambiguous")
                elif contract.get("inventory_establishment"):
                    drift.append("shared-contract ownership receipt missing")
                elif contract.get("inventory_changed") and not drift:
                    drift.append("shared-contract source inventory changed")
                drift = drift or ["shared-contract status is not current"]
                sc0_reason = "shared contract drift: " + "; ".join(drift[:3])
                sc0_action = _action(
                    snapshot,
                    "SC-0",
                    "SYNC_SHARED",
                    None,
                    "project-local inherited contract current",
                    "journaled exact-byte sync receipt",
                    "shared_contract_status.current",
                    *drift[:3],
                )
        else:
            sc0_reason = "MANIFEST malformed: " + "; ".join(snapshot.manifest_errors[:2])
    elif not contract.get("current"):
        drift = (
            contract.get("missing_files", [])
            + contract.get("missing_dirs", [])
            + contract.get("stale_files", [])
            + contract.get("obsolete_files", [])
            + contract.get("obsolete_dirs", [])
            + contract.get("unexpected_files", [])
            + contract.get("unexpected_dirs", [])
        )
        if contract.get("inventory_lineage") == "ambiguous":
            drift.append("sub-sync receipt lineage ambiguous")
        elif contract.get("inventory_establishment"):
            drift.append("shared-contract ownership receipt missing")
        elif contract.get("inventory_changed") and not drift:
            drift.append("shared-contract source inventory changed")
        drift = drift or ["shared-contract status is not current"]
        sc0_reason = "shared contract drift: " + "; ".join(drift[:3])
        sc0_action = _action(
            snapshot,
            "SC-0",
            "SYNC_SHARED",
            None,
            "project-local inherited contract current",
            "journaled exact-byte sync receipt",
            "shared_contract_status.current",
            *drift[:3],
        )
    evaluations.append(
        (
            "SC-0",
            _STAGE_NAMES["SC-0"],
            SATISFIED if not sc0_reason else UNSATISFIED,
            sc0_reason,
            sc0_action,
        )
    )

    active_task = snapshot.state.get("task")
    if active_task not in (None, "", "none") and not ignore_active_task:
        # Item 4: an ORDINARY ticket that reached terminal SHIP under an
        # active crew epoch does NOT publish. It is mechanically
        # DEFER_FOR_CREW'd -- scope must be recorded -- and Core returns to
        # the crew planner. This kills the
        # PHASE SHIP -> CREW_NOT_READY -> no workers -> PHASE SHIP loop.
        if (
            snapshot.state.get("phase") == "SHIP"
            and (snapshot.root / RELEASE_SCOPE_DIR / f"{active_task}.json").is_file()
        ):
            action = _action(
                snapshot,
                "DEFER-FOR-CREW",
                "DEFER_FOR_CREW",
                None,
                "ordinary ticket SHIP defers to crew publication",
                "committed structured crew-defer receipt + scope identity",
                "ticket locally closed as deferred; Core returns to crew planner",
                f"{RELEASE_SCOPE_DIR}/{active_task}.json",
                active_task,
            )
            evaluations.append(
                (
                    "DEFER-FOR-CREW",
                    "defer-for-crew",
                    UNSATISFIED,
                    f"active ticket {active_task} reached SHIP under crew; "
                    "ordinary publication defers to the crew epoch",
                    action,
                )
            )
            stages = _reachable(evaluations)
            return stages, _first_action(stages)
        evaluations.append(
            (
                "CORE-TASK",
                "active-core-task",
                UNSATISFIED,
                "finish active Core task before crew roles",
                None,
            )
        )
        stages = _reachable(evaluations)
        return stages, _first_action(stages)

    manifest_names = {entry.name for entry in snapshot.manifest_entries}
    roster_reason = ""
    roster_action = None
    for role in CREW_ROLES:
        if not role.ensure_instance:
            continue
        if _role_applicability(snapshot, role)[0] == NOT_APPLICABLE:
            # An instance is machinery for producing evidence. A role with
            # nothing to produce evidence ABOUT does not need one spawned,
            # kept in the manifest, or re-adopted on every charter revision.
            continue
        health = snapshot.roles[role.name]
        state_path = snapshot.root / SUBS_REL / role.name / "STATE.md"
        if role.name not in manifest_names or not health.get("instance_present"):
            roster_reason = f"missing durable role {role.name}"
            roster_action = _action(
                snapshot,
                "SC-1",
                "SPAWN_ROLE",
                role.name,
                "all durable generic built-ins registered and present",
                "STATE/BOARD/LOG/OUTBOX plus strict manifest registration",
                f"{role.name} health is not missing",
                str(state_path),
            )
            break
        if health.get("role_revision_state") == "STALE":
            roster_reason = f"stale role revision: {role.name}"
            roster_action = _action(
                snapshot,
                "SC-1",
                "ADOPT_ROLE",
                role.name,
                "worker role revision equals project-local charter",
                "journaled STATE adoption preserving history",
                f"{role.name} role_revision_state CURRENT",
                f"{SUBS_REL}/{role.name}.md",
            )
            break
        if health.get("health") == HEALTH_INVALID:
            roster_reason = f"invalid/conflicting role {role.name}; refuse overwrite"
            break
    evaluations.append(
        (
            "SC-1",
            _STAGE_NAMES["SC-1"],
            SATISFIED if not roster_reason else UNSATISFIED,
            roster_reason,
            roster_action,
        )
    )

    # Stages whose verdict no predecessor can move (see `_reachable`).
    unconditional_stages = set()
    for role in (item for item in CREW_ROLES if item.role_class == "core-review"):
        applies, applies_reason = _role_applicability(snapshot, role)
        if applies == NOT_APPLICABLE:
            unconditional_stages.add(role.stage)
            # The machine receipt (AC-02). The stage is SATISFIED and the
            # reason NAMES the deciding fact, so a reader can tell this apart
            # from a stage that ran and found nothing -- which is the entire
            # point. No model run, no package, no review ticket.
            evaluations.append(
                (
                    role.stage,
                    role.name,
                    SATISFIED,
                    f"NOT_APPLICABLE -- {applies_reason}",
                    None,
                )
            )
            continue
        ok, reason = _sensor_executed(snapshot, role)
        action = (
            None
            if ok
            else _action(
                snapshot,
                role.stage,
                "RUN_ROLE",
                role.name,
                "current source-bound independent role evidence bound to THIS crew epoch",
                "complete strict OUTBOX package (payload [] allowed) + a "
                "committed crew_run receipt binding the epoch",
                "role evidence READY_FOR_REVIEW or CURRENT for the active epoch",
                role.outbox_path,
            )
        )
        evaluations.append(
            (role.stage, role.name, SATISFIED if ok else UNSATISFIED, reason, action)
        )

    ready = [
        role.name
        for role in applicable_roles(snapshot)
        if role.role_class == "core-review"
        and snapshot.roles[role.name].get("health") == HEALTH_READY_FOR_REVIEW
    ]
    dispositions = [
        role.name
        for role in applicable_roles(snapshot)
        if role.role_class == "core-review"
        and snapshot.roles[role.name].get("health") == HEALTH_REVIEW_PENDING
        and snapshot.roles[role.name].get("collect", {}).get("disposition_pending")
    ]
    sc6_action = None
    sc6_reason = ""
    if ready:
        role = ready[0]
        sc6_action = _action(
            snapshot,
            "SC-6",
            "COLLECT_ROLE",
            role,
            "core-review package durably ingested once (INTAKE != REVIEW)",
            "ordinary Core review unit + durable collect receipt binding "
            "package identity to the ticket",
            f"{role} health REVIEW_PENDING with a linked review ticket",
            next(item.outbox_path for item in CREW_ROLES if item.name == role),
        )
        sc6_reason = "ready package(s): " + ", ".join(ready)
    elif dispositions:
        role = dispositions[0]
        sc6_action = _action(
            snapshot,
            "SC-6",
            "DISPOSE_REVIEW",
            role,
            "Core review terminal; the reviewed claim is a disposition",
            "sub_disposition receipt binding package identity to the terminal review ticket",
            f"{role} health CURRENT (reviewed + terminal disposition)",
            next(item.outbox_path for item in CREW_ROLES if item.name == role),
        )
        sc6_reason = "Core review terminal, reviewed claim pending: " + ", ".join(dispositions)
    evaluations.append(
        (
            "SC-6",
            _STAGE_NAMES["SC-6"],
            SATISFIED if not (ready or dispositions) else UNSATISFIED,
            sc6_reason,
            sc6_action,
        )
    )

    core_ok, core_reason = _core_fixed_point(snapshot, session_agent)
    evaluations.append(
        (
            "SC-7",
            _STAGE_NAMES["SC-7"],
            SATISFIED if core_ok else UNSATISFIED,
            core_reason,
            None,
        )
    )

    oscillation = _producer_oscillation(snapshot)
    for role in (item for item in CREW_ROLES if item.role_class == "producer"):
        health = snapshot.roles[role.name]
        integrated = _producer_integrated(snapshot, role)
        ready_current = (
            health.get("ready_current")
            if role.runtime_kind == "specialized-translate"
            else health.get("outbox", {}).get("ready_current")
        )
        if oscillation:
            action = None
            reason = oscillation
        elif integrated:
            action = None
            reason = ""
        elif ready_current:
            action = _action(
                snapshot,
                role.stage,
                ("INTEGRATE_TRANSLATE" if role.name == "saitranslate" else "INTEGRATE_WIKI"),
                role.name,
                "producer payload applied through a structured S0 -> S1 integration edge",
                "committed producer_integration receipt binding the package "
                "identity to input/resulting source",
                "producer integrated against the current source",
                role.outbox_path,
            )
            reason = "current READY package awaits integration"
        else:
            action = _action(
                snapshot,
                role.stage,
                ("PREPARE_TRANSLATE" if role.name == "saitranslate" else "PREPARE_WIKI"),
                role.name,
                "fresh producer package prepared against the current source",
                "READY current package",
                "producer prepared against the current source",
                role.outbox_path,
            )
            reason = "no current READY producer package"
        evaluations.append(
            (
                role.stage,
                role.name,
                SATISFIED if integrated and not oscillation else UNSATISFIED,
                reason,
                action,
            )
        )

    # Item 10: WAIT_ROLE tickets whose role has produced evidence need
    # mechanical disposition (unblock/close), never a human courier and never
    # a session boundary.
    dispositions = _wait_role_dispositions(snapshot)
    wait_action = None
    wait_reason = ""
    if dispositions:
        tid = dispositions[0]
        wait_action = _action(
            snapshot,
            "WAIT-ROLE",
            "CLEAR_WAIT_ROLE",
            None,
            "crew-owned blocker cleared by the owning role's evidence",
            "ticket unblocked/disposed after the owning role integrated",
            f"{tid} is no longer WAIT_ROLE-blocked",
            tid,
        )
        wait_reason = f"WAIT_ROLE ticket {tid} has owning-role evidence; dispose it"
    evaluations.append(
        (
            "WAIT-ROLE",
            "wait-role",
            SATISFIED if not dispositions else UNSATISFIED,
            wait_reason,
            wait_action,
        )
    )

    sensors_current = all(
        snapshot.roles[role.name].get("health") == HEALTH_CURRENT
        for role in applicable_roles(snapshot)
        if role.role_class == "core-review"
    )
    final_fixed = sensors_current and core_ok and not oscillation and not dispositions
    evaluations.append(
        (
            "SC-10",
            _STAGE_NAMES["SC-10"],
            SATISFIED if final_fixed else UNSATISFIED,
            "" if final_fixed else "Core/sensor evidence changed after producer integration",
            None,
        )
    )

    release_ok, release_reason = _release_current(snapshot)
    if release_ok:
        evaluations.append(("SC-11", _STAGE_NAMES["SC-11"], SATISFIED, "", None))
    else:
        # Terminal ship authorization is computed against SC-0..SC-10 only
        # (no recursion: the reachability of the pre-ship circuit is derived
        # here, before SC-11/12/13 append their own evaluations).
        pre_stages = _reachable(evaluations, unconditional=frozenset(unconditional_stages))
        ship_ok, ship_reason = crew_ready_for_terminal_ship(snapshot, pre_stages)
        action = (
            None
            if not ship_ok
            else _action(
                snapshot,
                "SC-11",
                "SHIP",
                None,
                "canonical terminal release bound to the crew epoch",
                "committed release receipt verified by the release engine",
                "release closure is current HEAD and remote-verified",
            )
        )
        reason = release_reason if ship_ok else "terminal ship not authorized: " + ship_reason
        evaluations.append(("SC-11", _STAGE_NAMES["SC-11"], UNSATISFIED, reason, action))

    post_ok, post_reason, post_action = _post_ship(snapshot)
    evaluations.append(
        (
            "SC-12",
            _STAGE_NAMES["SC-12"],
            SATISFIED if post_ok else UNSATISFIED,
            post_reason,
            post_action,
        )
    )
    sc13_ok, sc13_reason = _sc13_conformance_check(
        snapshot, pre_finalization=pre_finalization, source_identity=snapshot.source_id
    )
    evaluations.append(
        (
            "SC-13",
            _STAGE_NAMES["SC-13"],
            SATISFIED if sc13_ok else UNSATISFIED,
            "" if sc13_ok else sc13_reason,
            _action(
                snapshot,
                "SC-13",
                "FINALIZE",
                None,
                "all substantive crew invariants proven",
                "canonical final LOG+STATE event",
                "normal intent, DONE, final public crew gate PASS",
            )
            if sc13_ok
            else None,
        )
    )
    stages = _reachable(evaluations, unconditional=frozenset(unconditional_stages))
    return stages, _first_action(stages)


def _sc13_conformance_check(
    snapshot, *, pre_finalization: bool = False, source_identity=None
) -> tuple[bool, str]:
    """§7: SC-13 must independently prove a CURRENT_PASS canonical conformance
    receipt bound to the current checkpoint/tree. A historical green, a stale
    validator, or a FAIL must never let `WAIT: crew closed` / CREW_FINALIZED
    surface.

    CORE-002: The circular dependency is broken by splitting the check:
    - During pre-finalization evaluation (planning), SC-13 is satisfied when
      all substantive stages (SC-0..SC-12) are met AND the finalize action
      is ready. The crew conformance receipt is NOT required at this point
      because the validator needs terminal state to produce it.
    - During post-finalization verification (after the FINALIZE action has
      transitioned to terminal state), SC-13 requires the actual crew
      conformance PASS receipt.

    ``pre_finalization`` is True when called during crew_plan evaluation
    (the planning phase), and False when called during finalize_crew
    verification (the terminal gate).
    """
    if pre_finalization:
        # During planning: SC-13 is ready for finalization when all
        # substantive stages are met. The conformance receipt will be
        # produced AFTER the terminal transition.
        return True, ""
    try:
        from .conformance import conformance_status

        # PERF-002: reuse the snapshot's already-captured SourceIdentity instead
        # of recomputing it inside conformance_status (one fewer filesystem/Git
        # capture on the crew_plan hot path).
        ident = source_identity if source_identity is not None else snapshot.source_id
        st = conformance_status(snapshot.root, gate="crew", source_identity=ident)
    except Exception as exc:  # pragma: no cover - defensive
        return False, f"conformance gate error: {exc}"
    if st["status"] != "CURRENT_PASS":
        return False, (
            f"canonical crew conformance is {st['status']}: {st.get('reason', '')}"
        )
    return True, ""


def _reachable(
    evaluations,
    forced_action: CrewAction | None = None,
    unconditional: frozenset = frozenset(),
) -> list[dict]:
    """Project the evaluations into the plan's stage listing.

    A stage after the first unsatisfied one normally reports WAITING, because
    its own verdict can still move once the blocker is worked -- running a
    sensor mutates the tree, which is exactly what invalidates later evidence.

    `unconditional` names the stages whose verdict does NOT depend on any
    predecessor (T-1279: a role with no applicable surface has nothing for a
    predecessor to change). Blanking those to "waiting on predecessor" would
    hide the deciding fact in precisely the plan an operator reads to find out
    why a stage is quiet, which is the confusion this whole change removes.
    """
    blocked_by = None
    stages = []
    for stage, name, status, reason, action in evaluations:
        if blocked_by is not None and stage not in unconditional:
            stages.append(
                {
                    "stage": stage,
                    "name": name,
                    "state": WAITING,
                    "satisfied": False,
                    "reason": f"waiting on predecessor {blocked_by}",
                    "action": None,
                }
            )
            continue
        stages.append(
            {
                "stage": stage,
                "name": name,
                "state": status,
                "satisfied": status == SATISFIED,
                "reason": reason,
                "action": asdict(action) if action else None,
            }
        )
        if status == UNSATISFIED:
            blocked_by = stage
    if forced_action and blocked_by is None:
        stages.append(
            {
                "stage": "CORE-TASK",
                "name": "active-core-task",
                "state": UNSATISFIED,
                "satisfied": False,
                "reason": "finish active Core task before crew roles",
                "action": asdict(forced_action),
            }
        )
    return stages


def _first_action(stages: list[dict]) -> CrewAction | None:
    for stage in stages:
        raw = stage.get("action")
        if raw and stage.get("state") == UNSATISFIED:
            raw = dict(raw)
            raw["inputs"] = tuple(raw.get("inputs", ()))
            return CrewAction(**raw)
    return None


def _crew_plan_from_snapshot(
    snapshot: CrewSnapshot, current_agent: str | None = None
) -> dict:
    """Evaluate one already coherent world-view without recapturing it."""
    stages, action = _evaluate(snapshot, session_agent=current_agent)
    substantive_ok = all(
        stage["state"] == SATISFIED for stage in stages if stage["stage"] != "SC-13"
    )
    state = snapshot.state
    # Item 11: DONE is legal ONLY when the CURRENT substantive crew proof is
    # green AND the finalization proof is green. A historical final marker
    # proves a past run finalized; it is NOT current terminal truth. If the
    # current proof is red, the planner may never project DONE.
    finalized = (
        substantive_ok
        and state.get("execution_intent") in (None, "normal")
        and "converge_target" not in state
        and state.get("phase") == "DONE"
        and _final_marker_problem(snapshot) is None
    )
    if substantive_ok:
        action = (
            None
            if finalized
            else _action(
                snapshot,
                "SC-13",
                "FINALIZE",
                None,
                "all substantive crew invariants proven",
                "canonical final LOG+STATE event",
                "normal intent, DONE, final public crew gate PASS",
            )
        )
    # Item 21: `ok` is the COMMAND result (the plan was derived without
    # structural failure); a valid plan with work remaining is ok:true.
    # crew_complete / action_required are the semantic facts -- a weak
    # wrapper must not treat "work remains" as a command failure.
    crew_complete = substantive_ok and finalized
    return {
        "stages": stages,
        "code": "CREW_PLAN",
        "first_unsatisfied": next(
            (stage["stage"] for stage in stages if stage["state"] == UNSATISFIED), None
        ),
        "action": asdict(action) if action else ({"action": "DONE"} if finalized else None),
        "roles": {name: data.get("health") for name, data in snapshot.roles.items()},
        "source": _source_dict(snapshot),
        "snapshot": {
            "state": snapshot.input_hashes.get(".saipen/STATE.md"),
            "board": snapshot.input_hashes.get(".saipen/BOARD.md"),
            "log_tail": snapshot.log_tail,
            "stable": snapshot.stable,
        },
        "ok": snapshot.stable and not snapshot.source_error,
        "crew_complete": crew_complete,
        "action_required": not crew_complete,
        "finalized": finalized,
    }


def _capture_crew_plan(
    project_root: Path | str,
    current_capability: str | None = None,
    current_agent: str | None = None,
    userperson_profile: dict | None = None,
) -> tuple[CrewSnapshot, dict]:
    snapshot = crew_snapshot(
        project_root,
        current_capability=current_capability,
        userperson_profile=userperson_profile,
    )
    return snapshot, _crew_plan_from_snapshot(snapshot, current_agent=current_agent)


def crew_plan(
    project_root: Path | str,
    current_capability: str | None = None,
    current_agent: str | None = None,
    *,
    userperson_profile: dict | None = None,
) -> dict:
    return _capture_crew_plan(
        project_root,
        current_capability,
        current_agent,
        userperson_profile,
    )[1]


def _finalize_problems(snapshot: CrewSnapshot, session_agent: str | None = None) -> list[str]:
    stages, _action_value = _evaluate(snapshot, session_agent=session_agent)
    problems = [
        f"{stage['stage']}: {stage['reason']}"
        for stage in stages
        if stage["stage"] != "SC-13" and stage["state"] != SATISFIED
    ]
    if (
        snapshot.state.get("execution_intent") != "converge"
        or snapshot.state.get("converge_target") != "crew"
    ):
        problems.append("active execution intent is not converge/crew")
    return problems


def crew_ready_to_finalize(project_root: Path | str) -> tuple[bool, list[str]]:
    snapshot = crew_snapshot(project_root)
    problems = _finalize_problems(snapshot)
    return not problems, problems


def finalize_crew(
    project_root: Path | str, dry_run: bool = False, current_agent: str | None = None
) -> Result:
    root = Path(project_root)
    # ONE coherent snapshot owns both the verdict and the CAS tokens handed to
    # the canonical finalizer. A second independent snapshot would open a gap
    # where role evidence could change after the green verdict.
    snapshot = crew_snapshot(root)
    return _finalize_crew_from_snapshot(snapshot, dry_run=dry_run, current_agent=current_agent)


def _finalize_crew_from_snapshot(
    snapshot: CrewSnapshot, dry_run: bool = False, current_agent: str | None = None
) -> Result:
    """Finalize against the planner snapshot; canonical APPLY rechecks its CAS."""
    root = snapshot.root
    problems = _finalize_problems(snapshot, session_agent=current_agent)
    if problems:
        return _refuse(
            "VALIDATION_FAILED", "crew not ready to finalize: " + "; ".join(problems[:4])
        )
    release = snapshot.release
    epoch = snapshot.epoch
    if release is None or epoch is None:
        return _refuse("VALIDATION_FAILED", "crew release/epoch evidence missing")
    from .operations import finalize_converge_intent

    actor = current_agent or snapshot.state.get("agent") or "saipen-cli"
    message = f"crew finalized {epoch.op_id} release {release.tag} @{release.closure_commit}"
    # T-1003 finding 9: the finalizer receipt carries STRUCTURED semantics
    # (operation, target=crew, crew_epoch, release operation identity and
    # ticket). The LOG sentence mirrors it; it never authorizes it.
    # SC-13 finalization is a LOCAL/runtime mutation: the terminal release
    # (SC-11) cannot contain evidence its own finalizer has not written yet,
    # so `crew_release_evidence.json` is local runtime evidence, staged by a
    # later closure if one happens. The PUBLIC crew gate derives the
    # finalization proof from COMMITTED STATE/LOG, which a fresh clone sees
    # identically -- no recovery/ops reliance (T-1003 crew terminal truth).
    evidence_target = None
    try:
        from . import codec as _codec
        from .plan import TargetPlan
        from .journal import hash_bytes as _hash_bytes
        import datetime as _dt

        ev_path = root / ".saipen" / "kitchen" / "crew_release_evidence.json"
        ev_doc = _codec.read_document(ev_path)
        evidence_record = {
            "schema_version": 1,
            "operation": "crew_finalize_evidence",
            "crew_epoch": epoch.op_id,
            "release_op_id": release.op_id,
            "release_tag": release.tag,
            "closure_commit": release.closure_commit,
            "final_state": "normal/DONE",
            "recorded_at": _dt.datetime.now(_dt.timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            ),
        }
        if epoch.ticket is not None:
            evidence_record["ticket_id"] = epoch.ticket
        ev_content = json.dumps(evidence_record, indent=2) + "\n"
        before_hash = ev_doc.raw_hash if ev_path.is_file() else ""
        evidence_target = TargetPlan(
            ".saipen/kitchen/crew_release_evidence.json",
            "report",
            ev_doc.encode(ev_content),
            before_hash,
            _hash_bytes(ev_doc.encode(ev_content)),
        )
    except OSError:
        pass
    finalizer_metadata = {
        "operation": "finalize_crew",
        "target": "crew",
        "status": "COMMITTED",
        "crew_epoch": epoch.op_id,
        "release_op_id": release.op_id,
        "release_tag": release.tag,
        "release_closure_commit": release.closure_commit,
    }
    if epoch.ticket is not None:
        finalizer_metadata["ticket_id"] = epoch.ticket
    return finalize_converge_intent(
        root,
        actor,
        "crew",
        message,
        ticket_id=epoch.ticket,
        dry_run=dry_run,
        evidence_preconditions=snapshot.input_hashes,
        receipt_metadata=finalizer_metadata,
        extra_targets=[evidence_target] if evidence_target else None,
    )


def crew_apply(
    project_root: Path | str,
    current_capability: str | None = None,
    current_agent: str | None = None,
) -> Result:
    """Execute exactly one bounded mechanical crew action.

    P0#4: `current_capability` is the freshly negotiated CURRENT-SESSION
    capability. A read-only session may not execute ANY crew action -- the
    persisted STATE.mode is historical and never grants current authority.
    `current_agent` is the CURRENT-SESSION actor: every crew RUN/receipt/
    closure names THIS identity, never persisted STATE.agent (second-wave
    P0). None falls back to the historical value for legacy callers; the
    CLI always supplies the session identity.
    """
    root = Path(project_root)
    if current_capability == "read-only":
        return _refuse(
            "VALIDATION_FAILED",
            "current session capability is read-only; no crew action may be "
            "executed in a read-only session (capability negotiated at the "
            "command boundary)",
            next_action="saipen crew --dry-run",
        )
    if pending_ops(root):
        return _refuse("RECOVERY_REQUIRED", "unresolved operation; recover first")
    from .fast_check import validate_project

    actor = current_agent or "saipen-cli"
    base_errors = validate_project(root, current_agent=actor)
    if base_errors:
        return _refuse("VALIDATION_FAILED", "; ".join(base_errors[:5]))
    from userperson import UserpersonError, effective_profile

    try:
        userperson = effective_profile(root)
    except UserpersonError as exc:
        return _refuse(
            "VALIDATION_FAILED",
            exc.detail,
            scope=exc.scope,
            userperson_code=exc.code,
        )
    # PERF-006: only the minimum stable pre-intent state is needed to decide
    # whether to set the crew intent. Reading the full crew_snapshot here would
    # be thrown away the moment set_converge_intent mutates STATE (it must never
    # be reused across that mutation). Parse STATE directly for the intent
    # check and the saipen_home validity check.
    from .state import parse_state as _parse_state

    _state_text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8-sig")
    pre_state = _parse_state(_state_text)
    home_problem = _home_problem_for(pre_state.get("saipen_home") or "")
    if home_problem:
        return _refuse(
            "HOME_REQUIRED",
            home_problem,
            next_action="set a valid saipen_home in STATE.md pointing at a real SAIPEN install",
        )
    if (
        pre_state.get("execution_intent") != "converge"
        or pre_state.get("converge_target") != "crew"
    ):
        from .operations import set_converge_intent

        intent = set_converge_intent(root, actor, "crew")
        if not intent.ok:
            return intent
        plan = crew_plan(
            root,
            current_capability=current_capability,
            current_agent=actor,
            userperson_profile=userperson,
        )
        return Result(
            ok=True,
            code="CREW_INTENT_SET",
            op_id=intent.op_id,
            changed_files=intent.changed_files,
            data={"plan": plan, "action": plan.get("action")},
        )

    snapshot = crew_snapshot(
        root,
        current_capability=current_capability,
        userperson_profile=userperson,
    )
    plan = _crew_plan_from_snapshot(snapshot, current_agent=actor)
    action = plan.get("action") or {}
    kind = action.get("action")
    role = action.get("role")
    if kind == "SYNC_SHARED":
        return sub_sync(root, snapshot.saipen_home)
    if kind == "SPAWN_ROLE":
        return sub_spawn(root, role, snapshot.saipen_home)
    if kind == "ADOPT_ROLE":
        return sub_adopt(root, role, snapshot.saipen_home)
    if kind == "FINALIZE":
        return _finalize_crew_from_snapshot(snapshot, current_agent=actor)
    if kind == "DEFER_FOR_CREW":
        # Item 4: an ordinary SHIP ticket under active crew closes LOCALLY as
        # deferred -- zero publication -- and Core returns to the planner.
        from .operations import defer_for_crew

        inputs = action.get("inputs") or ()
        ticket = inputs[-1] if inputs else ""
        if not ticket.startswith("T-"):
            return _refuse("VALIDATION_FAILED", "DEFER_FOR_CREW carries no Core ticket identity")
        if snapshot.epoch is None:
            return _refuse("VALIDATION_FAILED", "DEFER_FOR_CREW requires an active crew epoch")
        return defer_for_crew(root, ticket, actor, snapshot.epoch.op_id)
    if kind == "CLEAR_WAIT_ROLE":
        # Item 10: the owning role's evidence has arrived; the WAIT_ROLE
        # blocker is mechanically disposed (unblocked to DONE), never a
        # human courier.
        inputs = action.get("inputs") or ()
        ticket = inputs[-1] if inputs else ""
        if not ticket.startswith("T-"):
            return _refuse("VALIDATION_FAILED", "CLEAR_WAIT_ROLE carries no Core ticket identity")
        return _clear_wait_role(root, ticket, actor)
    if kind == "DONE":
        return Result(
            ok=True,
            code="CREW_DONE",
            data={"plan": plan, "crew_complete": True, "action_required": False},
        )
    if not action:
        first_unsat = plan.get("first_unsatisfied")
        stage = next((s for s in plan.get("stages", []) if s.get("stage") == first_unsat), None)
        stage_action = (stage or {}).get("action") or {}
        invalid_roles = [
            name for name, status in (plan.get("roles") or {}).items() if status == "INVALID"
        ]
        role = (
            invalid_roles[0]
            if invalid_roles
            else (stage_action.get("role") if isinstance(stage_action, dict) else None)
        )
        # AUTO-002: CREW_BLOCKED is a ROUTING carrier. A blocked stage whose
        # resolution is locally satisfiable carries `execute_in_current_agent`
        # + the canonical action; only a genuine stage that needs real Core
        # implementation work or a human decision is terminal. A weak model
        # must be able to distinguish "inspect and I act" from "stop".
        return Result(
            ok=False,
            code="CREW_BLOCKED",
            message="no executable crew action; the circuit is blocked on an "
            "unsatisfied stage -- inspect before continuing",
            data={
                "stage": first_unsat,
                "role": role,
                "reason": (stage or {}).get("reason", ""),
                "terminal": False,
                "requires_human": False,
                "execute_in_current_agent": True,
                "next_action": (
                    stage_action.get("action") if isinstance(stage_action, dict) else None
                ),
                "resume_after": "saipen crew",
                "next": "inspect the unsatisfied stage and resolve its "
                "evidence; never invent an action when inspection is "
                "required",
                "plan": plan,
                "action": action,
                "action_fingerprint": _carrier_fingerprint(plan, role=role),
            },
        )
    return Result(
        ok=True,
        code="CREW_ACTION",
        data={
            "plan": plan,
            "action": action,
            "crew_complete": plan.get("crew_complete"),
            "action_required": plan.get("action_required"),
            "execute_in_current_agent": action.get("execute_in_current_agent"),
            "terminal": action.get("terminal", False),
            "requires_human": action.get("requires_human", False),
            "next_action": action.get("next_action", action.get("action")),
            "resume_after": action.get("resume_after", "saipen crew"),
            "action_fingerprint": _carrier_fingerprint(
                plan, role=action.get("role"), action=action
            ),
        },
    )


def _carrier_fingerprint(plan: dict, *, role: object = None, action: object = None) -> str:
    """Deterministic identity of an actionable carrier (T-1159 liveness).

    Same fingerprint twice in a row means the previous actionable answer did
    not produce a qualifying state change -- a stall, never progress. Any
    real role work (fresh evidence, replan, source change) moves at least one
    hashed input: first unsatisfied stage, per-stage unsatisfied reasons,
    action kind, role, or source-tree fingerprint.
    """
    from .liveness import action_fingerprint

    unsatisfied = [
        {"stage": stage.get("stage"), "reason": stage.get("reason")}
        for stage in plan.get("stages", [])
        if isinstance(stage, dict) and stage.get("state") != SATISFIED
    ]
    source = plan.get("source") or {}
    action_kind = action.get("action") if isinstance(action, dict) else None
    projection = action.get("userperson_projection") if isinstance(action, dict) else None
    source_fingerprint = source.get("source_tree_fingerprint")
    if isinstance(projection, dict) and projection.get("source_fingerprint"):
        source_fingerprint = (
            f"{source_fingerprint}:{projection['source_fingerprint']}"
        )
    return action_fingerprint(
        stage=plan.get("first_unsatisfied"),
        role=role,
        action=action_kind,
        reason=unsatisfied,
        source=source_fingerprint,
    )


def _clear_wait_role(root: Path, ticket_id: str, agent: str) -> Result:
    """Mechanically dispose a WAIT_ROLE blocker whose owning role produced
    evidence: the ticket is closed as DONE (the resolution is the role's real
    evidence, never prose). Journaled through the canonical operation with
    zero invention."""
    from .operations import clear_wait_role as _clear_op

    return _clear_op(root, ticket_id, agent)


def _final_marker_problem(snapshot: CrewSnapshot) -> str | None:
    """Finalization proof, derived from CLONE-VISIBLE committed artifacts
    (SC-13 is a local/runtime mutation; its verdict must be reproducible on a
    fresh clone that has no `.saipen/recovery/ops`).

    Clone-visible proof (the same in both worlds): the committed STATE is
    targetless `execution_intent: normal`, `phase: DONE`, and the committed
    LOG carries the finalizer's mechanical event naming the exact epoch and
    release identity -- the fixed-shape sentence `finalize_converge_intent`
    writes, not free prose.

    Local strengthening (item 9, only when the local receipt store exists):
    the COMMITTED structured finalize_crew operation receipt must name
    target=crew and the exact epoch/release, and its STATE target's
    after-hash must equal the CURRENT STATE bytes (the final normal/DONE
    state is committed, not just announced). Absence of the local store is
    the fresh-clone case, never a failure by itself."""
    release = snapshot.release
    epoch = snapshot.epoch
    if release is None or epoch is None:
        return "crew epoch/release evidence missing"
    # ---- clone-visible proof: committed STATE + mechanical LOG event ------
    state = snapshot.state
    if state.get("execution_intent") not in (None, "normal"):
        return "final STATE is not targetless execution_intent normal"
    if "converge_target" in state:
        return "final STATE still carries converge_target"
    if state.get("phase") != "DONE":
        return "final STATE is not phase DONE"
    finalizer_lines = [
        parsed
        for parsed in snapshot.log_events
        if parsed.get("taxonomy") == "DEC"
        and (parsed.get("text") or "").startswith("crew finalized")
        and epoch.op_id in (parsed.get("text") or "")
        and (
            release.tag in (parsed.get("text") or "") or release.op_id in (parsed.get("text") or "")
        )
    ]
    if not finalizer_lines:
        return (
            "committed LOG carries no finalizer event naming epoch "
            f"{epoch.op_id} / release {release.tag}"
        )
    # ---- local strengthening: structured receipt when the store exists ----
    ops_store = snapshot.root / ".saipen/recovery/ops"
    if not ops_store.is_dir():
        return None  # fresh clone: committed STATE/LOG are the whole truth
    op_id = _finalizer_receipt(snapshot.root, epoch.op_id, release.op_id, snapshot.op_records)
    if not op_id:
        return (
            "canonical structured crew finalization receipt missing for "
            f"epoch {epoch.op_id} release {release.op_id}"
        )
    record = None
    for candidate in _iter_operation_records(snapshot.root, snapshot.op_records):
        if candidate.get("op_id") == op_id:
            record = candidate
            break
    if record is None:
        return "finalizer receipt disappeared"
    state_after = None
    for target in record.get("targets", []):
        if target.get("path") == ".saipen/STATE.md":
            state_after = target.get("after_hash")
    live_state = snapshot.input_hashes.get(".saipen/STATE.md")
    if state_after and live_state and state_after != live_state:
        return (
            "finalizer receipt does not bind the current STATE bytes -- "
            "local finalization was overwritten"
        )
    # Event lineage: the finalizer's own LOG event must carry [op: <op_id>].
    if not any(parsed.get("op_id") == op_id for parsed in snapshot.log_events):
        return "finalizer receipt has no committed LOG event lineage"
    return None


def crew_gate_problems(project_root: Path | str) -> list[str]:
    """Public terminal gate: finalized Core state plus immutable crew proof."""
    snapshot = crew_snapshot(project_root)
    problems = []
    state = snapshot.state
    if state.get("execution_intent") not in (None, "normal"):
        problems.append("final execution_intent is not normal")
    if "converge_target" in state:
        problems.append("final state still carries converge_target")
    if state.get("phase") != "DONE" or state.get("task") not in (None, "", "none"):
        problems.append("final Core state is not DONE/task none")
    stages, _action_value = _evaluate(snapshot)
    problems.extend(
        f"{stage['stage']} {stage['name']}: {stage['reason']}"
        for stage in stages
        if stage["stage"] != "SC-13" and stage["state"] != SATISFIED
    )
    marker_problem = _final_marker_problem(snapshot)
    if marker_problem:
        problems.append(marker_problem)
    return problems
