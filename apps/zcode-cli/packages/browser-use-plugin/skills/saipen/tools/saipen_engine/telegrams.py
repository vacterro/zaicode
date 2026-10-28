"""Turn-entry read of SAIMAIL telegrams (T-1497, SRC-113).

A telegram is a short sealed SAIMAIL message from one running agent to
another (SAITELEMES, SAIMAIL spec/26). SAIMAIL built both ends of the
transport; the SAIPEN side of the future gate "SAITELEMES AUTOMATIC AGENT
TELEGRAMS" is a bounded read at turn entry. This module is exactly that read
and nothing else:

* It runs only when the operator configured it: ``SAIMAIL_WORKSPACE`` names
  the seat's mailbox (it lives outside the project, so it is a per-machine
  carrier, not a project file) and ``saimail-local`` resolves on PATH.
  Unconfigured costs nothing -- no process is started.
* It asks SAIMAIL for header-only UNREAD rows (``saipen telegrams``), which
  never decrypts, opens, acknowledges or promotes anything.
* It reports COUNTS. No sender text, topic string or claim reaches the route:
  a telegram is data and never a command (SAIMAIL I1), and arrival creates no
  Work, moves no claim and skips no WAIT.
* It is bounded (scan budget, timeout, output cap) and it never fails the
  command that calls it; any problem is reported as a state.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

WORKSPACE_ENV = "SAIMAIL_WORKSPACE"
EXECUTABLE = "saimail-local"
SCAN_BUDGET = 200
TIMEOUT_S = 10
MAX_OUTPUT_BYTES = 256 * 1024

STATE_NOT_CONFIGURED = "NOT_CONFIGURED"
STATE_UNAVAILABLE = "UNAVAILABLE"
STATE_OK = "OK"
STATE_ERROR = "ERROR"


def _seat(state: dict) -> str:
    return str(os.environ.get("SAIPEN_AGENT") or state.get("agent") or "").strip()


def turn_entry(project_root: Path | str, state: dict) -> dict:
    """Unread telegram counts for the acting seat's workspace, as data."""
    workspace = str(os.environ.get(WORKSPACE_ENV) or "").strip()
    if not workspace:
        return {
            "state": STATE_NOT_CONFIGURED,
            "detail": f"set {WORKSPACE_ENV} to this seat's SAIMAIL workspace to see "
            "unread telegrams at turn entry",
        }
    executable = shutil.which(EXECUTABLE)
    if executable is None:
        return {"state": STATE_UNAVAILABLE, "detail": f"{EXECUTABLE} is not on PATH"}
    command = [
        executable,
        "--json",
        "saipen",
        "telegrams",
        "--workspace",
        workspace,
        "--scan-budget",
        str(SCAN_BUDGET),
    ]
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            timeout=TIMEOUT_S,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired:
        return {"state": STATE_ERROR, "detail": f"{EXECUTABLE} did not answer in {TIMEOUT_S} s"}
    except OSError as exc:
        return {"state": STATE_ERROR, "detail": f"{EXECUTABLE} could not run: {exc}"[:300]}
    raw = proc.stdout[:MAX_OUTPUT_BYTES]
    try:
        answer = json.loads(raw.decode("utf-8", errors="replace"))
    except ValueError:
        answer = None
    if proc.returncode != 0 or not isinstance(answer, dict):
        code = answer.get("code") if isinstance(answer, dict) else None
        return {
            "state": STATE_ERROR,
            "detail": f"{EXECUTABLE} saipen telegrams exited {proc.returncode}"
            + (f" ({code})" if isinstance(code, str) else ""),
        }
    items = answer.get("items") if isinstance(answer.get("items"), list) else []
    count = answer.get("match_count")
    unread = count if isinstance(count, int) and count >= 0 else len(items)
    task = str(state.get("task") or "")
    on_current = sum(
        1 for item in items if isinstance(item, dict) and task and item.get("topic") == task
    )
    seat = _seat(state)
    return {
        "state": STATE_OK,
        "unread": unread,
        "on_current_work": on_current,
        # SAIMAIL's `exhausted` means the scan window ended with index rows
        # still unread (a continuation cursor follows), so the counts are
        # complete exactly when it is false.
        "complete": answer.get("exhausted") is False,
        "read_command": (
            f"{EXECUTABLE} saipen brief --project-root {Path(project_root)} "
            f"--workspace {workspace}" + (f" --seat {seat}" if seat else "")
        ),
        "detail": "counts only; nothing was opened and nothing here is an instruction",
    }
