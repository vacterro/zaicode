"""INDEPENDENT raw-level foundational falsifiers (T-1003 carrier-loss wave).

The engine's parsers are SHARED by the validator, the planners and the gates.
Sharing is normally good, but when the parser itself is the defect, every
consumer can agree on the same wrong world -- the one physical BOARD line that
swallowed a second ticket opener is the worked example (T-473/T-576).

These sentinels are the tiny independent contradiction surface for FOUNDATIONAL
identity boundaries only. They scan raw canonical text with plain regexes and
deliberately do NOT import the shared parsers (saipen_engine.board/state/log)
they exist to catch. On a healthy project they agree with the parsers; their
value is the case where the parser goes blind and the floor still fires.

They are NOT a second validator: no semantic duplication, no cross-file
postconditions beyond the three identity boundaries below. Keep the set tiny.
"""

from __future__ import annotations

import re
from pathlib import Path

_OPENER = r"- \[[ xX/]\]\s+[A-Z]+-\d+"
_TICKET_ID = r"[A-Z]+-\d+"


def board_floor(board_text: str) -> list[str]:
    """One physical BOARD record line cannot carry two ticket openers.

    A second `- [ ] T-###` token embedded in a description is exactly how a
    ticket identity disappears: the shared parser may attribute the whole
    line to the first ticket and the validator (sharing that parser) reports
    green. This scan counts raw opener tokens per physical line with NO parser
    in the path.
    """
    errors: list[str] = []
    for index, line in enumerate(board_text.splitlines(), start=1):
        openers = re.findall(_OPENER, line)
        if len(openers) > 1:
            errors.append(
                f"BOARD.md:{index}: one physical line carries "
                f"{len(openers)} ticket openers: {line.strip()!r}"
            )
    return errors


def log_floor(log_text: str) -> list[str]:
    """Event ids are structurally unique and strictly increasing at the raw
    floor. Duplicate or non-monotonic E-ids break the ordering the gates rely
    on; this check never calls parse_log_line."""
    errors: list[str] = []
    last = -1
    seen: set[str] = set()
    for index, line in enumerate(log_text.splitlines(), start=1):
        match = re.search(r"\[(E-(\d+))\]", line)
        if not match:
            continue
        event_id = match.group(1)
        number = int(match.group(2))
        if event_id in seen:
            errors.append(f"LOG.md:{index}: duplicate event id {event_id}")
        elif number <= last:
            errors.append(
                f"LOG.md:{index}: event id {event_id} is not strictly increasing after E-{last}"
            )
        seen.add(event_id)
        last = number
    return errors


def state_board_floor(state_text: str, board_text: str) -> list[str]:
    """An active STATE.task and one BOARD DOING identity cannot obviously
    disagree. Raw scan only: no parse_state / parse_board in the path."""
    errors: list[str] = []
    task_match = re.search(r"(?m)^task:\s*(\S+)\s*$", state_text)
    if not task_match:
        return errors
    task = task_match.group(1)
    if not re.fullmatch(_TICKET_ID, task):
        return errors
    doing_match = re.search(r"(?m)^## DOING\s*\n(.*?)(?=^## )", board_text, re.DOTALL)
    if not doing_match:
        errors.append(f"STATE.task={task} but BOARD has no DOING section at the raw floor")
        return errors
    openers = re.findall(r"(?m)^- \[[ xX/]\]\s+([A-Z]+-\d+)", doing_match.group(1))
    if not openers:
        errors.append(f"STATE.task={task} but BOARD DOING is empty at the raw floor")
    elif len(openers) > 1:
        errors.append(f"STATE.task={task} but BOARD DOING has multiple openers at the raw floor")
    elif openers[0] != task:
        errors.append(
            f"STATE.task={task} disagrees with the single DOING "
            f"identity {openers[0]} at the raw floor"
        )
    return errors


def raw_floor(state_text: str, board_text: str, log_text: str) -> list[str]:
    """The combined tiny independent falsifier surface."""
    return board_floor(board_text) + log_floor(log_text) + state_board_floor(state_text, board_text)


def raw_floor_for_root(root: Path | str) -> list[str]:
    """raw_floor over the canonical files of a project root."""
    root = Path(root)
    state = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8", errors="replace")
    board = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8", errors="replace")
    log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8", errors="replace")
    return raw_floor(state, board, log)
