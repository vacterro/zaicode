"""Lossless externalization for one oversized new LOG event."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .journal import hash_bytes, owned_target_path
from .log import (
    MAX_NEW_EVENT_BYTES,
    STRUCTURAL_DETAIL_TAG,
    ActiveTicketBlockStructure,
    render_event,
    structural_event_prefix,
    structural_event_record,
)
from .paths import project_identity, project_lineage_identity
from .plan import TargetPlan

LOG_DETAIL_ROOT = ".saipen/recovery/log-detail"


@dataclass(frozen=True)
class LogEventResult:
    event: int
    line: str
    targets: tuple[TargetPlan, ...]
    detail_ref: str


def prepare_event(
    root: Path | str,
    tail: int | None,
    taxonomy: str,
    message: str,
    *,
    ticket: str | None,
    agent: str | None,
    now: str,
    op_id: str | None,
    structure: ActiveTicketBlockStructure | None = None,
) -> LogEventResult:
    """Build a bounded event, preserving detail and machine-owned structure."""
    root = Path(root).resolve()
    event = (tail or 0) + 1
    full_line = render_event(
        tail, taxonomy, message, ticket=ticket, agent=agent, now=now, op_id=op_id
    )
    full = (full_line + "\n").encode("utf-8")
    force_externalization = structure is not None and (
        "detail_ref:" in message or "structural_event:" in message
    )
    if len(full_line.encode("utf-8")) <= MAX_NEW_EVENT_BYTES and not force_externalization:
        return LogEventResult(event, full_line, (), "")
    digest = hashlib.sha256(full).hexdigest()
    stem = f"E-{event}-{digest[:24]}"
    detail_ref = f"{LOG_DETAIL_ROOT}/{stem}.LOG.md"
    metadata_ref = f"{LOG_DETAIL_ROOT}/{stem}.json"
    owned_target_path(root, detail_ref, kind="LOG event detail")
    owned_target_path(root, metadata_ref, kind="LOG event metadata")
    metadata = {
        "schema_version": 1,
        "operation": "log_event_externalization",
        "status": "COMMITTED",
        "event_id": f"E-{event}",
        "ticket_id": ticket,
        "project_identity": project_identity(root),
        "project_lineage": project_lineage_identity(root),
        "source": ".saipen/LOG.md",
        "original_event_path": detail_ref,
        "original_event_sha256": digest,
        "original_event_bytes": len(full),
        "metadata_path": metadata_ref,
        "externalization_event": {
            "operation_id": op_id,
            "reason": "new LOG event exceeds the live cap; canonical detail externalization",
        },
        "lossless": True,
    }
    if structure is not None:
        metadata["structural_event"] = structural_event_record(structure)
    metadata_bytes = (json.dumps(metadata, sort_keys=True, indent=2) + "\n").encode("utf-8")
    compact_message = f"detail_ref: {metadata_ref}"
    if structure is not None:
        compact_message = (
            f"{structural_event_prefix(structure)} -- {STRUCTURAL_DETAIL_TAG} -- "
            f"detail_ref: {metadata_ref}"
        )
    compact = render_event(
        tail,
        taxonomy,
        compact_message,
        ticket=ticket,
        agent=agent,
        now=now,
        op_id=op_id,
    )
    compact_size = len(compact.encode("utf-8"))
    if compact_size > MAX_NEW_EVENT_BYTES:
        raise ValueError(
            f"LOG_EVENT_OVERSIZE: compact structural event is {compact_size} bytes, "
            f"cap is {MAX_NEW_EVENT_BYTES}"
        )
    return LogEventResult(
        event,
        compact,
        (
            TargetPlan(detail_ref, "generic", full, "", hash_bytes(full)),
            TargetPlan(metadata_ref, "generic", metadata_bytes, "", hash_bytes(metadata_bytes)),
        ),
        metadata_ref,
    )

