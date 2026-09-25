"""Runtime-local watchdog and mutation-lease fencing (T-1448).

This module owns no protocol truth.  It records replaceable worker health under
``.saipen/cache`` and fails closed when the carrier is absent, corrupt, stale,
or belongs to an older lease generation.  Durable Work/checkpoint authority
remains STATE/BOARD/LOG and is deliberately not copied into this cache.
"""

from __future__ import annotations

import datetime as _dt
import json
from dataclasses import dataclass
from pathlib import Path

from .paths import safe_atomic_write_bytes

CACHE_REL = Path(".saipen") / "cache" / "autonomy-watchdog.json"
SCHEMA_VERSION = 1
HEALTHY = "HEALTHY"
SUSPECT = "SUSPECT"
EXPIRED = "EXPIRED"
TERMINAL = "TERMINAL"
UNKNOWN = "UNKNOWN"
HEALTH_STATES = (HEALTHY, SUSPECT, EXPIRED, TERMINAL, UNKNOWN)


def _instant(value: str) -> _dt.datetime | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text.endswith("Z"):
        return None
    try:
        parsed = _dt.datetime.fromisoformat(text[:-1] + "+00:00")
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _utc(value: _dt.datetime | None = None) -> str:
    value = value or _dt.datetime.now(_dt.timezone.utc)
    return (
        value.astimezone(_dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True)
class WatchdogStatus:
    state: str
    worker_id: str | None
    lease_generation: int | None
    heartbeat_at: str | None
    age_seconds: float | None
    reason: str

    def as_dict(self) -> dict:
        return {
            "state": self.state,
            "worker_id": self.worker_id,
            "lease_generation": self.lease_generation,
            "heartbeat_at": self.heartbeat_at,
            "age_seconds": self.age_seconds,
            "reason": self.reason,
        }


def _path(root: Path | str) -> Path:
    return Path(root).resolve() / CACHE_REL


def _load(root: Path | str) -> dict | None:
    path = _path(root)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("schema_version") != SCHEMA_VERSION:
        return None
    if not isinstance(payload.get("lease_generation"), int) or payload["lease_generation"] < 1:
        return None
    if not isinstance(payload.get("worker_id"), str) or not payload["worker_id"].strip():
        return None
    if _instant(payload.get("heartbeat_at")) is None:
        return None
    return payload


def _save(root: Path | str, payload: dict) -> None:
    root = Path(root).resolve()
    body = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
    safe_atomic_write_bytes(
        _path(root),
        body,
        kind="autonomy watchdog runtime state",
        ownership_root=root,
    )


def acquire_lease(root: Path | str, worker_id: str, *, now: _dt.datetime | None = None) -> dict:
    """Create generation 1 or advance the fenced generation.

    A live, healthy lease is never silently stolen.  Callers must observe and
    fence an unhealthy generation before invoking this replacement operation.
    """
    current = _load(root)
    if current is not None:
        status = observe(root, now=now)
        if status.state in (HEALTHY, SUSPECT):
            raise RuntimeError("LIVE_LEASE_PRESENT")
        generation = current["lease_generation"] + 1
    else:
        generation = 1
    payload = {
        "schema_version": SCHEMA_VERSION,
        "worker_id": str(worker_id),
        "lease_generation": generation,
        "heartbeat_at": _utc(now),
        "status": HEALTHY,
    }
    _save(root, payload)
    return payload.copy()


def heartbeat(
    root: Path | str,
    worker_id: str,
    lease_generation: int,
    *,
    now: _dt.datetime | None = None,
) -> dict:
    """Refresh only the current generation; stale workers are fenced."""
    current = _load(root)
    if current is None:
        raise RuntimeError("UNKNOWN_LEASE")
    if current["worker_id"] != worker_id or current["lease_generation"] != lease_generation:
        raise RuntimeError("FENCED_LEASE_GENERATION")
    if _is_fenced(current):
        # A fenced generation must not revive itself. Before T-1446 this
        # rewrote status back to HEALTHY, so a returning fenced worker
        # un-fenced its own lease with one heartbeat.
        raise RuntimeError("FENCED_LEASE_GENERATION")
    payload = {**current, "heartbeat_at": _utc(now), "status": HEALTHY}
    _save(root, payload)
    return payload.copy()


def _is_fenced(current: dict) -> bool:
    return current.get("status") == EXPIRED and bool(current.get("fenced_at"))


def observe(
    root: Path | str,
    *,
    now: _dt.datetime | None = None,
    suspect_after: float = 30.0,
    expire_after: float = 120.0,
) -> WatchdogStatus:
    """Reconstruct health after supervisor restart, failing closed on unknown."""
    current = _load(root)
    if current is None:
        return WatchdogStatus(UNKNOWN, None, None, None, None, "missing_or_corrupt_runtime_state")
    heartbeat_at = _instant(current["heartbeat_at"])
    observed_at = now or _dt.datetime.now(_dt.timezone.utc)
    age = max(0.0, (observed_at - heartbeat_at).total_seconds())
    if current.get("status") == TERMINAL:
        state, reason = TERMINAL, "worker_terminal"
    elif _is_fenced(current):
        # Fencing takes effect when it is written, not when the heartbeat
        # ages out: a fenced generation read as HEALTHY for up to
        # `expire_after`, still passed `mutation_allowed`, and blocked its own
        # replacement with LIVE_LEASE_PRESENT (measured 2026-09-22).
        state, reason = EXPIRED, "fenced"
    elif age >= expire_after:
        state, reason = EXPIRED, "heartbeat_timeout"
    elif age >= suspect_after:
        state, reason = SUSPECT, "heartbeat_late"
    else:
        state, reason = HEALTHY, "heartbeat_current"
    return WatchdogStatus(
        state,
        current["worker_id"],
        current["lease_generation"],
        current["heartbeat_at"],
        age,
        reason,
    )


def fence(
    root: Path | str, worker_id: str, lease_generation: int, *, now: _dt.datetime | None = None
) -> dict:
    """Fence exactly the observed generation; stale callers cannot fence a replacement."""
    current = _load(root)
    if current is None:
        raise RuntimeError("UNKNOWN_LEASE")
    if current["worker_id"] != worker_id or current["lease_generation"] != lease_generation:
        raise RuntimeError("FENCED_LEASE_GENERATION")
    payload = {**current, "status": EXPIRED, "fenced_at": _utc(now)}
    _save(root, payload)
    return payload.copy()


def mutation_allowed(
    root: Path | str, worker_id: str, lease_generation: int, *, now: _dt.datetime | None = None
) -> bool:
    """Admission predicate: only current healthy generation may mutate."""
    current = _load(root)
    status = observe(root, now=now)
    return bool(
        current
        and status.state == HEALTHY
        and current.get("worker_id") == worker_id
        and current.get("lease_generation") == lease_generation
    )
