"""`saipen continue` -> `saipen improve` fallthrough (T-20260830_0842).

`saipen continue` must never terminate merely because there is no
immediately actionable queued Work. Once recovery, blocked/retryable,
queued and required-follow-up routing has been exhausted (the router's
idle-maintain verdict), continuation falls through ONCE to the
improvement-discovery path (`saipen improve` bare = the bounded audit
assignment PREPARE step). A marker keeps the fallback bounded across
invocations: an already-active prepared cycle is resumed, never duplicated,
and a completed/archived cycle allows a fresh discovery.

This module is the deterministic decision + marker side. The actual
`saipen improve` invocation stays in the CLI so capability, handover and
writer-lock rules stay in their owning boundary.
"""

from __future__ import annotations

import json
from pathlib import Path


FALLBACK_MARKER_REL = Path(".saipen") / "extensions" / "continue_fallback.json"


def _marker_path(root: Path) -> Path:
    return Path(root) / FALLBACK_MARKER_REL


def read_marker(root: Path) -> dict:
    """The persisted continue-fallback marker, or {} when absent/malformed.

    Malformed bytes are treated as absent: a broken marker must never block
    continuation or fabrication-safe routing, and the next write overwrites
    it atomically.
    """
    path = _marker_path(root)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def active_cycle_status(root: Path, cycle_id: str) -> str:
    """The manifest `cycle_status:` of the named cycle, '' when absent.

    '' means no active cycle under that id: a fresh discovery may run.
    `complete`/`archived` seal the cycle and also allow a fresh discovery.
    Any other value (`active`) means the improvement discovery is already in
    flight -- resume, never prepare a duplicate.
    """
    manifest = Path(root) / ".saipen" / "improve" / cycle_id / "MANIFEST.md"
    try:
        text = manifest.read_text(encoding="utf-8")
    except OSError:
        return ""
    for line in text.splitlines():
        if line.startswith("cycle_status:"):
            return line.split(":", 1)[1].strip()
    return ""


def write_marker(root: Path, cycle_id: str, agent: str) -> Path:
    """Persist the one marker record for this fallback cycle. Atomic replace."""
    path = _marker_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "cycle_id": cycle_id,
        "agent": agent,
        "prepared_at": _now_utc(),
    }
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        json.dumps(payload, sort_keys=True), encoding="utf-8", newline="\n"
    )
    tmp.replace(path)
    return path


def _now_utc() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
