"""Immutable OperationPlan + the APPLY that consumes it (NITRO integrity).

PLAN (the operation-specific `*_targets` builders) reads the project snapshot
and produces an OperationPlan: a frozen, self-describing intention holding the
op_id, the semantic request, the preconditions the plan was decided against,
and the ordered exact-bytes targets. PLAN writes ZERO bytes.

APPLY takes THAT plan object and commits exactly its planned bytes: under the
writer lock it runs Recovery preflight, re-checks every declared precondition,
journals PREPARED, applies the targets in order, and verifies the result
before COMMITTED. It never recomputes a different plan and never mints a new
op_id.
"""

from __future__ import annotations

import datetime
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from . import fast_check
from .errors import CODES
from .journal import run_mutation
from .lock import project_writer_lock
from .result import Result


def semantic_payload_hash(semantic_request: dict) -> str:
    """Deterministic hash of the semantic request a plan was made from."""
    payload = json.dumps(semantic_request, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


@dataclass(frozen=True)
class TargetPlan:
    """One ordered write target of an OperationPlan.

    `content` is the EXACT final bytes -- encoding/BOM/newline already applied
    by the codec before the plan exists. The journal stores these bytes and
    recovery replays them; nothing re-encodes during APPLY.

    `action` is the journal's target action (`write`, `delete_file`,
    `delete_dir`). It defaults to `write`, so every existing plan builder is
    unchanged, and it exists because an operation that RETIRES canonical
    Work has to remove the hot-surface bytes in the SAME journaled
    transaction that writes their forensic replacement -- a second,
    unjournaled delete pass would reintroduce exactly the half-applied state
    the journal exists to prevent.
    """

    path: str
    role: str
    content: bytes
    before_hash: str
    after_hash: str
    action: str = "write"


@dataclass(frozen=True)
class OperationPlan:
    """The immutable intention an operation's APPLY commits."""

    op_id: str
    operation: str
    agent: str
    project_identity: str
    created_at: str
    semantic_request: dict
    semantic_payload_hash: str
    preconditions: dict[str, str]
    targets: tuple[TargetPlan, ...]
    expected: dict  # the semantic success metadata (ok/code/event_id/...)
    receipt_metadata: dict | None = None  # structured receipt facts for journal

    @property
    def changed_files(self) -> list[str]:
        return [t.path for t in self.targets]


def build_plan(
    operation: str,
    agent: str,
    project_identity: str,
    semantic_request: dict,
    preconditions: dict[str, str],
    targets: list[TargetPlan],
    expected: dict,
    op_id: str | None = None,
    receipt_metadata: dict | None = None,
) -> OperationPlan:
    """Construct an OperationPlan with a stable op_id.

    `op_id` defaults to `<operation>-<uuid8>`. PLAN and APPLY share it; APPLY
    consumes the plan object and never mints another.
    """
    return OperationPlan(
        op_id=op_id or f"{operation}-{_hex8()}",
        operation=operation,
        agent=agent,
        project_identity=project_identity,
        created_at=datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        semantic_request=semantic_request,
        semantic_payload_hash=semantic_payload_hash(semantic_request),
        preconditions=dict(preconditions),
        targets=tuple(targets),
        expected=dict(expected),
        receipt_metadata=receipt_metadata,
    )


def _hex8() -> str:
    import uuid

    return uuid.uuid4().hex


def _read_only_preconditions(plan: OperationPlan) -> dict[str, str]:
    """The plan's preconditions that are NOT write targets.

    A write target's own before_hash already covers its write precondition;
    recovery validates it per-target. A file the plan READ but did not write
    (e.g. BOARD read to decide a transition) is a READ-ONLY dependency: its
    live bytes must still match the plan's allowed state at recovery time,
    or the plan is no longer the authorized decision (NITRO dogfood II).
    """
    written = {t.path for t in plan.targets}
    return {path: expected for path, expected in plan.preconditions.items() if path not in written}


def apply_plan(project_root: Path | str, plan: OperationPlan) -> Result:
    """APPLY the exact plan through lock + journal + recovery + verification.

    COMMIT FAILURE ALWAYS WINS: a failed commit returns its own refusal
    (STALE_STATE / RECOVERY_REQUIRED / CONFLICT / WRITER_BUSY), never the
    plan's semantic success. Only a successful commit carries the semantic
    expected metadata.
    """
    root = Path(project_root)
    try:
        with project_writer_lock(root):
            written = {t.path for t in plan.targets}
            # WRITE CAS only for targets (their own before_hash also covers
            # them); everything else the plan READ is a READ-ONLY dependency
            # and may legitimately reference the absolute SAIPEN home
            # (T-1003 owned-target resolver). Sending home paths through the
            # write-precondition channel would wrongly refuse valid plans.
            commit = run_mutation(
                root,
                plan.op_id,
                plan.operation,
                plan.agent,
                plan.project_identity,
                plan.semantic_payload_hash,
                [
                    {
                        "path": t.path,
                        "role": t.role,
                        "action": t.action,
                        "content": t.content,
                        "before_hash": t.before_hash,
                        "after_hash": t.after_hash,
                    }
                    for t in plan.targets
                ],
                preconditions={
                    path: expected
                    for path, expected in plan.preconditions.items()
                    if path in written
                },
                read_preconditions=_read_only_preconditions(plan),
                verify=fast_check.validate_project,
                verification_policy="core_fast",
                receipt_metadata=plan.receipt_metadata,
            )
    except PermissionError as exc:
        if "WRITER_BUSY" in str(exc):
            return Result(
                ok=False,
                code="WRITER_BUSY",
                op_id=plan.op_id,
                message="another live writer holds the project lock",
            )
        raise

    if not commit["ok"]:
        code = commit.get("code")
        if code not in CODES:
            code = "VALIDATION_FAILED"
        return Result(
            ok=False,
            code=code,
            op_id=plan.op_id,
            message=commit.get("detail", ""),
            recovery_required=bool(commit.get("recovery_required")),
            data={k: v for k, v in commit.items() if k not in ("ok", "code", "detail")},
        )

    expected = dict(plan.expected)
    expected["op_id"] = plan.op_id
    expected["recovery_required"] = False
    if commit.get("code") == "ALREADY_APPLIED":
        expected["code"] = "ALREADY_APPLIED"
    expected["changed_files"] = list(plan.changed_files)
    return Result(
        ok=True,
        code=expected.get("code", "COMMITTED"),
        data={k: v for k, v in expected.items() if k not in ("ok", "code", "message")},
        message=expected.get("message", ""),
        changed_files=list(plan.changed_files),
        op_id=plan.op_id,
    )
