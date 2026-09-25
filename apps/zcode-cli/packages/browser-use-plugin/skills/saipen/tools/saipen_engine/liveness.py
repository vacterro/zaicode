"""Continuation liveness projection (T-1159).

Durable memory for exactly one fact across CLI invocations: the fingerprint
of the last actionable crew/continuation carrier handed to the agent, so an
identical actionable answer twice in a row is surfaced as CREW_STALLED
instead of silently re-polled (CORE § 1.10 "EXECUTE, DO NOT EXPLAIN").

This is a PROJECTION stored under `.saipen/cache/`: rebuildable, never
canonical authority, never read by the validator as project truth. A missing
or corrupt carrier degrades to "no history" (first observation), never to a
failure. Read-only sessions and `--dry-run` invocations never write it.
"""

from __future__ import annotations

import hashlib
import json
import threading
from contextlib import suppress
from pathlib import Path

from .lock import FileLockBusy, file_writer_lock
from .paths import safe_atomic_write_bytes, safe_unlink_owned

CACHE_REL = Path(".saipen") / "cache" / "continuation-liveness.json"
LOCK_REL = Path(".saipen") / "locks" / "continuation-liveness.lock"
RESET_REL = Path(".saipen") / "cache" / "continuation-liveness.reset"

# The second consecutive identical actionable carrier means the previous one
# did NOT produce a qualifying state change: that is a stall, not progress.
STALL_THRESHOLD = 2
_LIVENESS_GUARD = threading.Lock()


def action_fingerprint(
    *,
    stage: object = None,
    role: object = None,
    action: object = None,
    reason: object = None,
    source: object = None,
) -> str:
    """Deterministic identity of an actionable carrier's semantic content.

    Two carriers with the same fingerprint describe the same unresolved state:
    same stage, same role, same action, same unsatisfied-stage reasons, same
    source-tree identity. Any real progress (fresh evidence, replan, source
    change) changes at least one input and therefore the fingerprint.
    """
    payload = json.dumps(
        {
            "stage": stage,
            "role": role,
            "action": action,
            "reason": reason,
            "source": source,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _cache_path(project_root: Path | str) -> Path:
    return Path(project_root).resolve() / CACHE_REL


def _load(path: Path) -> dict:
    from .paths import prove_owned_regular

    try:
        st = prove_owned_regular(path)
    except (FileNotFoundError, ValueError):
        return {}
    try:
        from .paths import read_bound_regular_bytes

        raw = read_bound_regular_bytes(path, st, max_bytes=64 * 1024)
    except (OSError, ValueError):
        return {}
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def record_actionable(project_root: Path | str, fingerprint: str) -> dict:
    """Record one actionable carrier and classify repetition.

    Returns ``{"stalled": bool, "stall_repeats": int}``. The stalled verdict
    is deterministic: the same fingerprint observed ``STALL_THRESHOLD`` times
    in a row. A write failure degrades to a first observation -- liveness is
    best-effort projection and must never become a new failure surface.
    """
    root = Path(project_root).resolve()
    path = root / CACHE_REL
    try:
        with _LIVENESS_GUARD, file_writer_lock(root / LOCK_REL, root, blocking=False):
            reset_path = root / RESET_REL
            reset_pending = reset_path.exists()
            if reset_pending:
                with suppress(OSError, ValueError):
                    safe_unlink_owned(
                        reset_path,
                        kind="continuation liveness reset marker",
                        ownership_root=root,
                    )
                data = {}
            else:
                data = _load(path)
            if data.get("fingerprint") == fingerprint and isinstance(data.get("repeats"), int):
                repeats = data["repeats"] + 1
            else:
                repeats = 1
            doc = {
                "schema_version": 1,
                "fingerprint": fingerprint,
                "repeats": repeats,
            }
            body = (json.dumps(doc, indent=2, sort_keys=True) + "\n").encode("utf-8")
            safe_atomic_write_bytes(
                path,
                body,
                kind="continuation liveness cache",
                ownership_root=root,
            )
    except (FileLockBusy, OSError, ValueError):
        return {"stalled": False, "stall_repeats": 1}
    return {"stalled": repeats >= STALL_THRESHOLD, "stall_repeats": repeats}


def clear(project_root: Path | str) -> None:
    """Forget the last actionable carrier (real progress happened)."""
    root = Path(project_root).resolve()
    lock = file_writer_lock(root / LOCK_REL, root, blocking=False)
    try:
        with _LIVENESS_GUARD, lock:
            safe_unlink_owned(
                root / CACHE_REL,
                kind="continuation liveness cache",
                ownership_root=root,
            )
    except FileLockBusy:
        # Preserve the reset edge under contention.  The next successful
        # record consumes this marker while holding the same lock.
        with suppress(OSError, ValueError):
            safe_atomic_write_bytes(
                root / RESET_REL,
                b'{"reset": true}\n',
                kind="continuation liveness reset marker",
                ownership_root=root,
            )
    except (OSError, ValueError):
        return
