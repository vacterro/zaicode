"""Whose words a receipt actually holds, and who says so.

MEASURED, 2026-09-17, nine-condition field matrix on installed generation
f3d2104a. `long_file_task` was handed a 520-byte request over twelve lines with
four explicit constraints. It ran `saipen start` with a 46-character substitute
it wrote itself, minted `T-1` and `SRC-001`, changed `src/app.py`, and every
gate read green. T-1372's obligation never armed, because that mechanism records
what a transport refusal REFUSED and nothing refused anything: the session never
attempted the literal ingress at all.

The defect class this ends: **the operator's request reaches the protocol only
through the model's own hands, and the receipt says nothing about that.**
`source_authority: exact` is a true statement about BYTES -- the stored body is
the body we were handed, unredacted -- and it was being read as a statement
about WORDS.

So the receipt records its witness. Three values, and the difference between
them is who compared what:

* ``operator_carrier`` -- something outside the session declared the task's
  digest (a launcher, a harness, an operator), and the text that arrived
  matches it. A mismatch is refused, not recorded.
* ``transport_obligation`` -- a transport refusal recorded these exact bytes
  and they arrived (INGRESS-AUTHORITY-01, T-1372).
* ``model_supplied`` -- nobody compared anything. The text is what the session
  typed, and the receipt says so instead of implying more.

`model_supplied` is not a failure and is not refused: most sessions have no
carrier, and inventing one would be the fabrication this module exists to stop.
It is a fact a reader can act on, and a matrix can count.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

#: The operator's task digest, declared by whoever launched this session.
ENV_TASK_SHA256 = "SAIPEN_TASK_SHA256"

#: The operator's task text on disk, when a launcher can write a file but not a
#: digest. Read-only, bounded; the digest is computed from its bytes.
ENV_TASK_FILE = "SAIPEN_TASK_FILE"

#: A task file past this size is not a task, and reading it unbounded would let
#: an environment variable point the engine at anything on the disk.
MAX_TASK_FILE_BYTES = 256 * 1024

WITNESS_CARRIER = "operator_carrier"
WITNESS_OBLIGATION = "transport_obligation"
WITNESS_MODEL = "model_supplied"

CODE_MISMATCH = "INGRESS_TASK_MISMATCH"
CODE_CARRIER_INVALID = "INGRESS_TASK_CARRIER_INVALID"

_SHA256 = re.compile(r"[0-9a-f]{64}")


def declared(env: dict | None = None) -> dict | None:
    """What this session was LAUNCHED with, or None when nobody said.

    Returns ``{"digest": ..., "source": ENV_TASK_SHA256|ENV_TASK_FILE}`` or an
    ``{"error": ...}`` record. A malformed carrier is an error rather than an
    absence: an environment that meant to declare the task and failed must not
    read as an environment that never declared one.
    """
    from .pending_ingress import ingress_digest

    env = os.environ if env is None else env
    raw = (env.get(ENV_TASK_SHA256) or "").strip().lower()
    if raw:
        if not _SHA256.fullmatch(raw):
            return {"error": f"{ENV_TASK_SHA256} is not a 64-character sha256 hex digest"}
        return {"digest": raw, "source": ENV_TASK_SHA256}
    path_raw = (env.get(ENV_TASK_FILE) or "").strip()
    if not path_raw:
        return None
    path = Path(path_raw)
    try:
        if path.stat().st_size > MAX_TASK_FILE_BYTES:
            return {"error": f"{ENV_TASK_FILE} is larger than {MAX_TASK_FILE_BYTES} bytes"}
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, ValueError) as exc:
        return {"error": f"{ENV_TASK_FILE} is not a readable UTF-8 file: {exc}"}
    return {"digest": ingress_digest(text), "source": ENV_TASK_FILE}


def file_route(task_file: str | None) -> str | None:
    """`saipen start --file` for a declared task file, typed so every shell carries it.

    MEASURED in four real shells (T-1380 review): the unquoted route arrived
    intact in PowerShell 5, pwsh 7 and cmd, but Git Bash handed the CLI
    `V:_TEMP_t1363-abc.saipen-launched-task.txt` -- an unquoted backslash is an
    escape there -- and a path with a space split into three arguments in all
    four. The double-quoted form arrived intact in every one. A path no quoted
    argument carries literally (a quote, `$`, a backtick, `%VAR%`, a trailing
    backslash) gets no route rather than one that breaks when typed.
    """
    from .guard_events import ingress_payload_literal

    path = (task_file or "").strip()
    if not path or not ingress_payload_literal(path, '"'):
        return None
    return f'saipen start --file "{path}"'


def _reachable_route(env: dict | None) -> str | None:
    """The command a session can actually RUN to answer a mismatch, or None.

    Measured 2026-09-17 on the final matrix: a refusal whose only instruction is
    "carry the operator's own bytes" is unanswerable when the carrier declared a
    DIGEST, because a digest is irreversible. `long_file_task` was refused, wrote
    its own paraphrase to a file, was refused again, then dumped
    SAIPEN_TASK_SHA256 and built a list of text variants to search for one that
    hashes to it. A route the session cannot run is worse than no route: it
    turns a correct refusal into a guessing loop.
    """
    env = os.environ if env is None else env
    return file_route(env.get(ENV_TASK_FILE))


def witness(text: str, *, obligation_met: bool = False, env: dict | None = None) -> dict:
    """How this request's fidelity was established, or why it is refused.

    ``{"witness": ..., "compared_digest": ...}`` when the ingress may proceed;
    ``{"code": ..., "detail": ...}`` when an operator carrier contradicts the
    text that arrived.
    """
    from .pending_ingress import ingress_digest

    supplied = ingress_digest(text)
    record = declared(env)
    if record and record.get("error"):
        return {
            "code": CODE_CARRIER_INVALID,
            "detail": (
                str(record["error"])
                + ". The session declares an operator task it cannot prove, so this "
                "ingress is refused rather than recorded as unwitnessed. Fix the "
                "carrier or unset it"
            ),
            "canonical_next_command": _reachable_route(env),
        }
    if record:
        if record["digest"] != supplied:
            route = _reachable_route(env)
            reach = (
                "The operator's own bytes are on disk at the declared task file; run "
                "the command in canonical_next_command, which needs no shell quoting."
                if route
                else (
                    "This session cannot reach the operator's text: the carrier declared "
                    "a DIGEST, and a digest is irreversible -- do not try to reconstruct "
                    "the text from it. Ask the operator to restate the request, or have "
                    "the launcher declare " + ENV_TASK_FILE + " so the bytes are readable."
                )
            )
            return {
                "code": CODE_MISMATCH,
                "detail": (
                    "this session was launched with a task whose sha256 is "
                    + record["digest"]
                    + " (declared by "
                    + record["source"]
                    + ") and the text supplied to the ingress has digest "
                    + supplied
                    + ". A receipt built from it would carry the session's words under "
                    "the operator's authority. "
                    + reach
                ),
                "declared_digest": record["digest"],
                "supplied_digest": supplied,
                "canonical_next_command": route,
                "operator_text_reachable": bool(route),
            }
        return {
            "witness": WITNESS_CARRIER,
            "compared_digest": supplied,
            "declared_by": record["source"],
        }
    if obligation_met:
        return {"witness": WITNESS_OBLIGATION, "compared_digest": supplied}
    return {
        "witness": WITNESS_MODEL,
        "compared_digest": supplied,
        "note": (
            "no operator carrier and no transport obligation: the stored bytes are "
            "what this session supplied, and nothing compared them with what the "
            "operator wrote"
        ),
    }


def unstarted(root: Path | str, env: dict | None = None) -> dict | None:
    """The task this session was launched with that this project has not taken.

    Returns ``{"digest", "source", "command"}`` when a carrier declares a task
    and NO receipt here already holds those bytes; None otherwise (including
    when nothing was declared, which is most sessions).

    Measured 2026-09-17: four of nine field sessions opened with `saipen status`
    or `saipen continue` although BOOT's entry table says a new actionable task
    goes to `saipen start`. `status` answered `next_action: saipen continue`,
    and `continue` answered IMPROVE_AUDIT_ASSIGNMENT -- it sent a session that
    was handed a user task into an improvement audit. The table was right and
    the runtime's own answer did not agree with it, which is a protocol defect
    rather than a model one: the session asked the project what to do and the
    project did not say "start the task you were given".
    """
    import json as _json

    record = declared(env)
    if not record or record.get("error"):
        return None
    root = Path(root)
    index = root / ".saipen" / "intake" / "index.json"
    active: dict = {}
    try:
        active = (_json.loads(index.read_text(encoding="utf-8")) or {}).get("active") or {}
    except (OSError, ValueError):
        active = {}
    for receipt_id in active:
        meta_path = root / ".saipen" / "intake" / "active" / f"{receipt_id}.meta.json"
        try:
            meta = _json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        provenance = meta.get("request_provenance")
        if isinstance(provenance, dict) and provenance.get("compared_digest") == record["digest"]:
            return None
    env = os.environ if env is None else env
    command = file_route(env.get(ENV_TASK_FILE)) or (
        "saipen start '<the task you were given, one line>'"
    )
    return {"digest": record["digest"], "source": record["source"], "command": command}


__all__ = [
    "CODE_CARRIER_INVALID",
    "CODE_MISMATCH",
    "ENV_TASK_FILE",
    "ENV_TASK_SHA256",
    "MAX_TASK_FILE_BYTES",
    "WITNESS_CARRIER",
    "WITNESS_MODEL",
    "WITNESS_OBLIGATION",
    "declared",
    "unstarted",
    "witness",
]
