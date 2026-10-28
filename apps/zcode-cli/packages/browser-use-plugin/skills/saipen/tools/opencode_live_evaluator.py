"""Causal evaluator for OpenCode continuation event streams.

This is verification tooling, not protocol runtime.  A repeated command string
is a duplicate only when it routes the same unresolved action from the same
observed checkpoint generation.  A later invocation after meaningful protocol
progress is a new routing decision.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


_CONTINUE_RE = re.compile(
    r"^\s*saipen\s+continue(?:\s+--json)?(?:\s+2>&1)?\s*$",
    re.IGNORECASE,
)


def _json_payload(output: str) -> dict[str, Any] | None:
    """Return the first complete JSON object embedded in command output."""
    start = output.find("{")
    if start < 0:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(output[start:])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _numbered_scalar(output: str, key: str) -> str | None:
    match = re.search(
        rf"^\s*(?:\d+:\s*)?{re.escape(key)}:\s*['\"]?([^'\"\s]+)",
        output,
        re.MULTILINE,
    )
    return match.group(1) if match else None


def _event_state(event: dict[str, Any]) -> dict[str, Any]:
    """Extract checkpoint-generation facts observable in one tool event."""
    output = str(event.get("output") or "")
    payload = _json_payload(output)
    state: dict[str, Any] = {}

    if payload:
        scope = payload.get("scope") if isinstance(payload.get("scope"), dict) else {}
        cold = payload.get("cold_route") if isinstance(payload.get("cold_route"), dict) else {}
        state["phase"] = payload.get("phase") or scope.get("phase") or cold.get("phase")
        state["task"] = payload.get("task") or scope.get("task") or payload.get("ticket")
        last_event = payload.get("last_event") or payload.get("log_tail_event")
        event_id = payload.get("event_id")
        if last_event is None and isinstance(event_id, str) and event_id.startswith("E-"):
            last_event = event_id[2:]
        state["last_event"] = last_event
    else:
        state = {
            "phase": _numbered_scalar(output, "phase"),
            "task": _numbered_scalar(output, "task"),
            "last_event": _numbered_scalar(output, "last_event"),
        }

    return {key: value for key, value in state.items() if value is not None}


def _route_result(event: dict[str, Any]) -> tuple[str | None, bool]:
    payload = _json_payload(str(event.get("output") or ""))
    if not payload:
        return None, False
    result = payload.get("action") or payload.get("code")
    return (str(result) if result is not None else None, payload.get("ok") is True)


def _project_identity(event: dict[str, Any]) -> str | None:
    workdir = (event.get("input") or {}).get("workdir")
    if not workdir:
        return None
    return str(workdir).replace("\\", "/").rstrip("/").lower()


def _is_continue(event: dict[str, Any]) -> bool:
    if event.get("tool") != "bash":
        return False
    command = str((event.get("input") or {}).get("command") or "")
    return bool(_CONTINUE_RE.fullmatch(command))


def evaluate_duplicate_continuations(
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    """Classify repeated continuation routes by checkpoint generation.

    Equality requires every causal component to be known and equal: project,
    task, phase, last_event and returned action.  Unknown evidence never proves
    a duplicate.  State observations from reads and canonical operation output
    update the generation before the next invocation is classified.
    """
    current: dict[str, Any] = {}
    routes: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []

    for ordinal, event in enumerate(events):
        if not _is_continue(event):
            current.update(_event_state(event))
            continue

        before = dict(current)
        project = _project_identity(event)
        if project is not None:
            before["project_identity"] = project

        result, completed = _route_result(event)
        observed = _event_state(event)
        before.setdefault("phase", observed.get("phase"))
        before.setdefault("task", observed.get("task"))
        fingerprint = {
            "project_identity": before.get("project_identity"),
            "task": before.get("task"),
            "phase": before.get("phase"),
            "last_event": before.get("last_event"),
            "returned_action": result,
        }
        comparable = all(value is not None for value in fingerprint.values())
        prior = next(
            (
                route
                for route in routes
                if comparable and route["comparable"] and route["fingerprint"] == fingerprint
            ),
            None,
        )
        route = {
            "event_index": event.get("event_index", ordinal),
            "status": event.get("status"),
            "completed": completed,
            "before": before,
            "returned_action": result,
            "fingerprint": fingerprint,
            "comparable": comparable,
            "duplicate": prior is not None,
        }
        if prior is not None:
            duplicates.append(
                {
                    "event_index": route["event_index"],
                    "duplicates_event_index": prior["event_index"],
                    "fingerprint": fingerprint,
                }
            )
        routes.append(route)
        current.update(observed)

    return {
        "no_duplicate_continue": not duplicates,
        "duplicate_events": duplicates,
        "routes": routes,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("proof", nargs="+")
    args = parser.parse_args(argv)
    results = []
    for raw_path in args.proof:
        path = Path(raw_path)
        proof = json.loads(path.read_text(encoding="utf-8"))
        results.append(
            {
                "proof": str(path),
                **evaluate_duplicate_continuations(proof.get("tools") or []),
            }
        )
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
