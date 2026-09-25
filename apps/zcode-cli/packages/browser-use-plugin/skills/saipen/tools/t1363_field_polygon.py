"""T-1363 field polygon: a real model, a real task, the INSTALLED runtime.

T-1363 exists because a weak free model, given one ordinary task in a real
project, never started work. Unit proof cannot close that: the defect was a
PROTOCOL UX defect, visible only as a transcript. So this drives the installed
OpenCode runtime with models from the local 9Router free pool over a matrix of
project conditions, and records -- per session -- the sequence a model actually
chose.

Read-only toward every real home: the installed engine is EXECUTED, never
written. Every project is disposable.

    python tools/t1363_field_polygon.py --models sairoute/SAIFREN --out DIR

Measured per session, from the host's own event stream:

* the FIRST saipen command the model chose;
* how many protocol commands it ran before a productive (non-protocol) action;
* every refusal code, in order, and whether any refusal repeated identically;
* whether it reached a productive action at all;
* whether canonical state in the project stayed byte-identical except through
  canonical operations.

STRONG acceptance: a healthy project answers in <= 1 entry command. With a
genuine operator decision: entry, ONE exact question, then productive action.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from contextlib import suppress
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

OPENCODE = shutil.which("opencode")
GIT = shutil.which("git")
HOME = Path(os.path.expanduser("~"))
INSTALLED = HOME / ".config" / "opencode" / "skills" / "saipen"


def _git_worktree(root: Path) -> Path:
    """Make the fixture a REAL git worktree before any model sees it.

    Measured the hard way: a fixture that is not a worktree does not bind as a
    project for the host, and a session started in it resolved its shell to the
    REPOSITORY instead -- so a free model ran `saipen start` against the live
    project and minted real tickets there. The sandbox is only a sandbox when
    the host can see its boundary.
    """
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "fixture",
        "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
        "GIT_COMMITTER_NAME": "fixture",
        "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
    }
    for args in (
        [GIT, "init", "-q", str(root)],
        [GIT, "-C", str(root), "add", "-A"],
        [GIT, "-C", str(root), "commit", "-qm", "fixture"],
    ):
        subprocess.run(args, check=True, capture_output=True, env=env, timeout=300)
    return root

#: The EXACT shape the field incident carried: a Windows path in the task text.
#: That path does not exist on this machine, so it is the NEGATIVE control
#: (`windows_path_missing`): a session handed a missing authority must stop,
#: and stopping is correct -- measured 17.09, the model refused to invent notes
#: it could not read, which the matrix had been scoring as broken transport.
FIELD_TASK = (
    r"add a docstring to the top of src/app.py explaining what it does; "
    r"the original notes are in V:\_TEMP_\fastprompter_drag\SAIPENVIEW_main.py"
)
SIMPLE_TASK = "add a one-line docstring to the top of src/app.py"

#: The POSITIVE Windows-path case (SRC-055 section 6): a real file inside the
#: fixture, named in the task by an absolute path that carries a drive colon,
#: backslashes and spaces, holding one value a session can only get by reading
#: it. Transport is proven when that value lands in the target.
NOTES_DIR = "operator notes"
NOTES_FILE = "notes with spaces.txt"
NOTES_KEY = "MODULE_PURPOSE"


def windows_notes_path(project: Path) -> Path:
    return Path(project) / NOTES_DIR / NOTES_FILE


def windows_path_task(project: Path) -> str:
    """The positive task, naming this fixture's notes file by its absolute path."""
    return (
        "add a one-line docstring to the top of src/app.py whose text is exactly the "
        f"{NOTES_KEY} value written in {windows_notes_path(project)}"
    )


def notes_value(project: Path) -> str | None:
    """The value the positive fixture wrote, read back from the file itself."""
    path = windows_notes_path(project)
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.partition("=")
        if sep and key.strip() == NOTES_KEY and value.strip():
            return value.strip()
    return None


def _windows_notes_project(case) -> Path:
    """A healthy project plus the readable notes file its task points at."""
    import uuid

    import test_t1363_zero_manual_entry as fixtures

    root = fixtures.healthy(case)
    notes = windows_notes_path(root)
    notes.parent.mkdir(parents=True)
    notes.write_text(
        f"{NOTES_KEY}=launch ledger {uuid.uuid4().hex[:12]}\n", encoding="utf-8", newline="\n"
    )
    return root

#: A request no shell carries: multi-line, several hundred bytes, the shape a
#: user actually pastes. `guard_events.ingress_rewrite` answers
#: `saipen start --file <path>` above MAX_INGRESS_HEX_PAYLOAD, so the session
#: has to write the text with its OWN write tool and run that command. The
#: matrix named this condition (SRC-051 section 11) and the polygon did not
#: build it, so a complete-looking run never exercised the one transport BOOT
#: offers for a task the shell cannot carry -- the transport measured twice as
#: the only one a weak model gets right, because hex re-encoding corrupted it
#: both times.
LONG_TASK = (
    "add a docstring to the top of src/app.py.\n"
    "\n"
    "it should say what the module is for, not repeat the function names, and\n"
    "it should stay one paragraph. keep the wording plain -- no marketing, no\n"
    "'this module provides', no bullet list.\n"
    "\n"
    "context you may need: this file is the application entry point, it is the\n"
    "first thing a reader opens, and the notes I wrote earlier are scattered\n"
    "across several places, so do not go looking for them -- write the summary\n"
    "from what the file itself says.\n"
    "\n"
    "when it is in, say which line you put it on.\n"
)

#: Every condition the field matrix names, in its order. Declared here rather
#: than left implicit in the builder below, because the builder covered eight
#: of the nine for a whole wave and printed a row per BUILT condition -- so the
#: run read complete while `long_file_task` had never been driven at all. A
#: matrix that is whatever its builder happens to contain is checked by nothing.
CONDITION_NAMES = (
    "healthy",
    "operator_decision",
    "safety_valve",
    "repairable_debt",
    "captured_unprojected",
    "already_done",
    "foreign_owner",
    "windows_path_task",
    "long_file_task",
)

#: The task each condition hands the model. Absent means SIMPLE_TASK; a task
#: that has to name its own fixture is computed by `condition_task`.
CONDITION_TASKS = {
    "long_file_task": LONG_TASK,
}

#: Controls runnable by name that are NOT part of the nine-condition matrix.
#: Their correct outcome is a stop, so they are judged on their own terms and
#: never folded into the positive conditions' verdicts.
NEGATIVE_CONTROLS = ("windows_path_missing",)
NEGATIVE_CONTROL_TASKS = {"windows_path_missing": FIELD_TASK}


def condition_task(name: str, project: Path) -> str:
    """The exact request condition `name` hands the model in `project`."""
    if name == "windows_path_task":
        return windows_path_task(project)
    if name in NEGATIVE_CONTROL_TASKS:
        return NEGATIVE_CONTROL_TASKS[name]
    return CONDITION_TASKS.get(name, SIMPLE_TASK)

#: Commands that are PROTOCOL, not product. A session that runs many of these
#: before touching the work is the failure this ticket measures.
_PROTOCOL = re.compile(r"^\s*saipen\b")


def condition_builders() -> dict:
    """Name -> the callable that makes that condition's project.

    Separate from `conditions()` so the covered set can be checked without
    building nine git worktrees: the completeness control reads THIS.
    """
    import test_t1363_zero_manual_entry as fixtures

    build = {
        "healthy": fixtures.healthy,
        "operator_decision": fixtures.blocker_project,
        "safety_valve": fixtures.valve_project,
        "repairable_debt": fixtures.unexecutable_next_action_project,
        "captured_unprojected": _captured_unprojected,
        "already_done": lambda case: fixtures.completed_request_project(case, SIMPLE_TASK),
        "foreign_owner": fixtures.foreign_owner_project,
        "windows_path_task": _windows_notes_project,
        "long_file_task": fixtures.healthy,
    }
    missing = [name for name in CONDITION_NAMES if name not in build]
    extra = [name for name in build if name not in CONDITION_NAMES]
    if missing or extra:
        raise ValueError(
            f"condition builders disagree with CONDITION_NAMES: missing={missing} extra={extra}"
        )
    return build


def negative_control_builders() -> dict:
    import test_t1363_zero_manual_entry as fixtures

    return {"windows_path_missing": fixtures.healthy}


def conditions(names=None) -> dict:
    """The requested conditions, built; the nine the matrix names by default.

    Only what was asked for is built: a targeted re-run of three conditions
    used to build nine git worktrees and drive three of them.
    """

    class _Case:
        def addCleanup(self, _fn):  # fixtures keep themselves; we keep the tree
            return None

    holder = _Case()
    build = {**condition_builders(), **negative_control_builders()}
    selected = list(names) if names else list(CONDITION_NAMES)
    unknown = [name for name in selected if name not in build]
    if unknown:
        raise ValueError(f"unknown condition(s) {unknown}; known: {sorted(build)}")
    return {name: _git_worktree(build[name](holder)) for name in selected}


def _captured_unprojected(case) -> Path:
    """A receipt that was captured and never became Work (the SRC-044 shape)."""
    import test_t1363_zero_manual_entry as fixtures
    from saipen_engine import intake
    from saipen_engine.operations import USER_REQUEST_VERIFY, _user_request_body

    root = fixtures.healthy(case)
    body = _user_request_body(SIMPLE_TASK, "P1", USER_REQUEST_VERIFY, [])
    intake.capture(root, body, source_kind="user_instruction")
    return root


#: Every canonical carrier a wrong-project session can damage. `intake/index.json`
#: is on this list because the incident's FIRST durable trace was a receipt, not a
#: BOARD row -- a watcher that saw only STATE/BOARD/LOG would have reported the
#: contaminating run clean (T-1370, SRC-049:R011).
CANONICAL_CARRIERS = ("STATE.md", "BOARD.md", "LOG.md", "intake/index.json")


def _canonical_hashes(root: Path) -> dict:
    out = {}
    for name in CANONICAL_CARRIERS:
        path = root / ".saipen" / name
        out[name] = (
            hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        )
    return out


#: The file every field task names. Its bytes are the product; the ledger is
#: only the bookkeeping around it.
TARGET_FILE = "src/app.py"


def _target_digest(root: Path) -> str | None:
    path = root / TARGET_FILE
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def _installed_generation() -> dict:
    """Which runtime the models are actually about to drive.

    SRC-051 section 10 asks for the installed generation per session, and a
    field result is only attributable to a runtime that can be named. Reading
    it from the distribution projection rather than from the session's prose
    keeps it a measurement.
    """
    try:
        import autoinject
    except ImportError as exc:  # pragma: no cover -- tools/ is on sys.path
        return {"error": f"autoinject unavailable: {exc}"}
    report = autoinject.distribution_report()
    home = next(
        (item for item in report["homes"] if Path(item["path"]) == INSTALLED),
        None,
    )
    return {
        "installed_home": str(INSTALLED),
        "expected_generation": report.get("expected_generation"),
        "runtime_generation": (home or {}).get("runtime_generation"),
        "source_head": (home or {}).get("source_head"),
        "generation_current": (home or {}).get("generation_current"),
        "installed_at": (home or {}).get("installed_at"),
    }


def _owner_repository(ids: dict, fixture: Path) -> dict:
    """Which repository's OWN ledger holds each id the session minted.

    "the model said it created T-1 in the fixture" is prose. This asks both
    ledgers and reports the answer they give.
    """
    fixture_ledger = _owning_ledger(fixture)
    repo_ledger = _owning_ledger(REPO)
    out = {}
    for kind, key in (("tickets", "tickets"), ("receipts", "receipts")):
        for ident in ids.get(kind, []):
            owners = []
            if ident in fixture_ledger[key]:
                owners.append(str(fixture))
            if ident in repo_ledger[key]:
                owners.append(str(REPO))
            out[ident] = owners
    return out


def _owning_ledger(root: Path) -> dict:
    """What this project's OWN ledger says it owns.

    A model reporting "T-1371 created" is not evidence that T-1371 belongs to
    the fixture. This reads the fixture's files instead of believing the
    transcript.
    """
    from saipen_engine.board import parse_board

    board = root / ".saipen" / "BOARD.md"
    index = root / ".saipen" / "intake" / "index.json"
    tickets: list[str] = []
    receipts: list[str] = []
    if board.is_file():
        try:
            tickets = sorted(parse_board(board.read_text(encoding="utf-8-sig"))["tickets"])
        except (OSError, ValueError):
            tickets = []
    if index.is_file():
        try:
            receipts = sorted(json.loads(index.read_text(encoding="utf-8-sig")).get("active", {}))
        except (OSError, ValueError):
            receipts = []
    return {"tickets": tickets, "receipts": receipts}


#: OpenCode's own session store. It is the SECOND source for the same facts,
#: and it exists here because the first one is not always there: measured on
#: `long_file_task`, a session ran the entire protocol chain and closed its
#: ticket -- its fixture ledger proves it -- while `--format json` put nothing
#: parseable on stdout. The metrics then read as a model that sat still, and
#: `protocol_commands_before_productive: 0` is the STRONG acceptance number, so
#: an unreadable transcript scored a perfect run. Reading the host's own store
#: does not make the transcript optional; it makes UNMEASURED rare enough to
#: be a real finding rather than the usual outcome.
HOST_STORE = HOME / ".local" / "share" / "opencode" / "opencode.db"

#: Where a session's facts came from. Recorded per session, because a metric
#: whose provenance is unknown cannot be argued with.
SOURCE_STDOUT = "stdout_events"
SOURCE_HOST_STORE = "host_session_store"
SOURCE_NONE = "none"


def _same_directory(left: str | None, right: Path) -> bool:
    if not left:
        return False
    try:
        return Path(left).resolve() == right.resolve()
    except (OSError, ValueError):
        return False


def _host_store_parts(
    project: Path, since_ms: int, session_id: str | None, store: Path | None = None
) -> list[dict]:
    """Part payloads the host recorded for THIS session, read-only.

    Bound by identity first: the session id the stdout stream named, when it
    named one. Without it, only a session whose own `directory` IS this
    fixture and which began after this run started can be adopted -- a
    harness that picked "the newest session" would happily measure another
    project's work and report it as this condition's result.
    """
    import sqlite3

    path = store or HOST_STORE
    if not path.is_file():
        return []
    try:
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    except sqlite3.Error:
        return []
    try:
        if session_id is None:
            rows = con.execute(
                "select id, directory from session where time_created >= ? "
                "order by time_created desc limit 50",
                (since_ms,),
            ).fetchall()
            match = next(
                (row[0] for row in rows if _same_directory(row[1], project)), None
            )
            if match is None:
                return []
            session_id = match
        parts = con.execute(
            "select data from part where session_id = ? order by time_created",
            (session_id,),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        con.close()
    out = []
    for (raw,) in parts:
        try:
            out.append(json.loads(raw))
        except (json.JSONDecodeError, TypeError):
            continue
    return out


def _part_tool_events(parts: list[dict]) -> list[dict]:
    """The same tool facts `_tool_events` extracts, from stored parts."""
    return _tool_events(
        [{"type": "tool_use", "part": part} for part in parts if part.get("type") == "tool"]
    )


def _tool_events(events: list[dict]) -> list[dict]:
    out = []
    for event in events:
        part = event.get("part") or {}
        if event.get("type") != "tool_use" or part.get("type") != "tool":
            continue
        state = part.get("state") or {}
        out.append(
            {
                "tool": part.get("tool"),
                "status": state.get("status"),
                "input": state.get("input") or {},
                # T-1380: a refusal message that fell outside this window made
                # every VALIDATION_FAILED read as one empty-message identity,
                # and three different problems scored as a loop.
                "output": str(state.get("output") or "")[:6000],
                "error": str(state.get("error") or "")[:1200],
            }
        )
    return out


def _host_env(project: Path) -> dict:
    """The child's environment must agree with its cwd about where it is.

    `subprocess` sets the real working directory and leaves `PWD` alone, so a
    harness launched from the repository hands the host a `PWD` naming the
    REPOSITORY while its cwd is the fixture. Measured: the model's shell
    resolved to `PWD`, read the repository's files and ran `saipen start`
    against the repository's ledger -- a sandbox that fails silently, because
    every command succeeds against the wrong project.

    The carrier list itself is NOT kept here. `paths.PROJECT_BINDING_ENV` owns
    the answer to "what binds a process to a project"; this function owns only
    the two decisions that are the polygon's own: the actor carrier is dropped
    so the child inherits `STATE.agent` like a real cold session, and `PWD` is
    re-pointed at the fixture instead of merely removed, because the measured
    host reads it.
    """
    from saipen_engine.paths import unbound_environment

    return unbound_environment(SAIPEN_AGENT=None, PWD=str(project))


def _task_env(project: Path, task: str) -> dict:
    """The child's environment, WITH the operator's task declared (T-1376).

    The harness knows the exact request it is about to hand the model, which is
    precisely what an operator knows and the protocol never did. Declaring its
    digest is what turns "the session reworded the task and every gate agreed"
    into either the operator's own bytes or a refusal -- and it makes the
    matrix able to measure which of the two happened.
    """
    from saipen_engine import operator_task as carrier

    env = _host_env(project)
    # T-1380: declare the task by FILE, not by digest. A digest is irreversible,
    # so a session refused for paraphrasing had no way back -- measured: one
    # dumped the variable and built a list of text variants to search for a
    # match. The file is the operator's own bytes, and the refusal can name a
    # command the session can actually run.
    task_file = project / ".saipen-launched-task.txt"
    task_file.write_text(task, encoding="utf-8", newline="\n")
    env[carrier.ENV_TASK_FILE] = str(task_file)
    return env


def _shell_commands(tools: list[dict]) -> list[str]:
    commands = []
    for item in tools:
        command = item["input"].get("command")
        if isinstance(command, str) and command.strip():
            commands.append(command.strip())
    return commands


#: A refusal in JSON is an object whose `ok` is false; `code` alone is not one.
#: Measured on the 17.09 smoke: the old rule scraped EVERY `"code"` field, so a
#: healthy session that checkpointed twice reported `repeated_refusal:
#: ['CHECKPOINTED']` and a session that claimed its ticket reported a refusal
#: called `CLAIMED`. SRC-051 §11 bans "the same refusal repeating with nothing
#: changed", and a metric that counts successes as refusals can convict a
#: session of the one thing it did right.
_JSON_REFUSAL = re.compile(r'"ok"\s*:\s*false.{0,400}?"code"\s*:\s*"([A-Z_]+)"', re.DOTALL)

#: The guard's own marker: it is emitted for ANY tool, so it counts whatever
#: command the session ran -- but only where the host puts a before-tool
#: refusal, the tool's ERROR text. Measured on the T-1380 re-run: one completed
#: `grep` over this repository listed source lines carrying the marker, and
#: `operator_decision` scored a repeated PROTOCOL_STATE_INVALID it never
#: received. Every real guard refusal in all five sessions sat in `error` with
#: status `error`.
_GUARD_REFUSAL = re.compile(r"SAIPEN_(?:GUARD|FLEET)_REFUSAL: ([A-Z_]+):?([^\r\n]{0,160})")

#: Human-mode refusal, counted only when the tool that produced it actually ran
#: `saipen`. The CLI prints `REFUSE [CODE]` and puts the sentence on the NEXT
#: line under `reason:`, so matching only the rest of the first line captured an
#: empty message for every one of them: `saipen ship` refusing over a missing
#: VERSION and `ticket done` refusing over a surplus `--paths` then shared one
#: identity and scored as the same refusal repeating with nothing changed.
_HUMAN_REFUSAL = re.compile(
    r"REFUSE \[([A-Z_]+)\][^\r\n]{0,160}(?:[\r\n]+reason:\s*([^\r\n]{0,200}))?"
)


def _refusal_texts(tools: list[dict]) -> list[tuple[str, str]]:
    """``(code, the message that came with it)`` for refusals this session GOT.

    Two things this refuses to count, both measured on 17.09:

    * a refusal the session merely READ. Three sessions grepped this
      repository's own files, one of which documents `REFUSE [CODE]` in a
      docstring, and the harness scored `CODE` as a refusal they received. A
      refusal arrives as the result of running `saipen`, or as the guard's own
      marker -- which the guard emits for any tool, so it is counted whatever
      the command was.
    * a success. `_JSON_REFUSAL` already requires `"ok": false`.
    """
    out: list[tuple[str, str]] = []
    for item in tools:
        blob = item["output"] + " " + item["error"]
        command = item["input"].get("command")
        ran_saipen = isinstance(command, str) and _PROTOCOL.search(command) is not None
        for match in _GUARD_REFUSAL.finditer(item["error"]):
            out.append((match.group(1), match.group(2).strip()))
        if not ran_saipen:
            continue
        for match in _HUMAN_REFUSAL.finditer(blob):
            out.append((match.group(1), (match.group(2) or "").strip()))
        for match in _JSON_REFUSAL.finditer(blob):
            tail = blob[match.end() : match.end() + 600]
            message = re.search(r'"(?:message|detail)":\s*"([^"]{0,200})', tail)
            out.append((match.group(1), (message.group(1) if message else "").strip()))
    return out


def _refusal_codes(tools: list[dict]) -> list[str]:
    return [code for code, _message in _refusal_texts(tools)]


#: Shell verbs that look at the project without moving it. SRC-051 section 11
#: is explicit -- "Do not count status/read/git-status/test-only shell as
#: productivity" -- and the old rule counted ANY non-`saipen` shell line, so a
#: session that ran `git status` and then argued with the protocol for twenty
#: minutes scored "productive at command 1". The defect class: a productivity
#: metric that counts looking as doing can never report a stalled session.
_INERT_SHELL = re.compile(
    r"""^\s*(?:
        (?:ls|dir|pwd|cd|echo|cat|type|head|tail|wc|find|where|which|tree|stat)\b
      | (?:grep|rg|sls|select-string|findstr)\b
      | git\s+(?:status|log|diff|show|branch|remote|rev-parse|ls-files|check-attr)\b
      | (?:python|python3|py)\s+(?:-[A-Za-z]+\s+)*-m\s+(?:unittest|pytest|ruff)\b
      | (?:pytest|ruff)\b
      | (?:get-content|get-childitem|get-location|test-path|measure-object)\b
    )""",
    re.IGNORECASE | re.VERBOSE,
)


def productive_shell(command: str) -> bool:
    """True when this shell line moves the project rather than inspects it."""
    text = command.strip()
    if not text or _PROTOCOL.match(text):
        return False
    return not _INERT_SHELL.match(text)


#: What a session's UX metrics are worth. `MEASURED` means the host's event
#: stream was readable; `UNMEASURED_NO_EVENT_STREAM` means it was not, and
#: every transcript metric below is None rather than zero.
MEASURED = "MEASURED"
UNMEASURED = "UNMEASURED_NO_EVENT_STREAM"
#: The provider or host failed before the session did anything. Measured twice
#: on `long_file_task` (17.09): `Unexpected server error` and exit 1 before the
#: first tool, recorded as MEASURED with `protocol_commands_before_productive:
#: 0` -- the STRONG acceptance number, handed to a session that never ran. An
#: empty session is not a SAIPEN result of any kind: not PASS, not FAIL.
INFRASTRUCTURE_UNMEASURED = "INFRASTRUCTURE_UNMEASURED"
#: How many times a condition is re-driven after an infrastructure failure.
DEFAULT_INFRA_RETRIES = 2
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def infrastructure_failure(
    returncode: int | None, tools: list[dict], events: list[dict], stderr: str
) -> str | None:
    """Why this session never reached the model's first action, or None.

    Only a session with NO tool event qualifies: once anything ran, the
    transcript is a measurement whatever the exit code says. Then either the
    host exited non-zero or its own event stream reported an error.
    """
    if tools:
        return None
    error_events = [event for event in events if event.get("type") == "error"]
    if not error_events and returncode in (0, None):
        return None
    text = _ANSI.sub("", stderr or "").strip()
    if not text and error_events:
        text = json.dumps(error_events[-1], ensure_ascii=False)
    return (text or f"host exited {returncode} before any tool ran")[-600:]

#: The shape returned when the host produced no readable events. Measured on
#: `long_file_task`: the session ran the whole protocol chain and finished
#: T-1 at E-13 -- its own ledger proves it -- while `--format json` put
#: nothing parseable on stdout, so the metrics read `tools: 0,
#: first_saipen_command: None, protocol_commands_before_productive: 0,
#: productive_action: None, refusal_sequence: []`. That is indistinguishable
#: from a model that sat there, and `protocol_commands_before_productive: 0`
#: is the STRONG acceptance number, so an unreadable transcript scored as a
#: perfect run. A metric that cannot say "I did not see this" lies.
_UNMEASURED_METRICS = {
    "tools": None,
    "first_saipen_command": None,
    "protocol_commands": None,
    "protocol_commands_before_productive": None,
    "productive_action": None,
    "refusal_sequence": None,
    "repeated_refusal": None,
}


def measure(tools: list[dict], *, measured: bool = True) -> dict:
    """The transcript facts the acceptance is stated in."""
    if not measured:
        return {"measurement": UNMEASURED, **_UNMEASURED_METRICS}
    commands = _shell_commands(tools)
    protocol = [c for c in commands if _PROTOCOL.match(c)]
    first = protocol[0] if protocol else None
    # A productive action is any tool effect that is not a protocol command:
    # a write/edit/patch, or a shell line that is not `saipen ...`.
    productive_at = None
    protocol_before = 0
    for item in tools:
        command = item["input"].get("command")
        if isinstance(command, str) and _PROTOCOL.match(command.strip()):
            protocol_before += 1
            continue
        if item["tool"] in ("write", "edit", "patch", "apply_patch", "multiedit"):
            productive_at = item["tool"]
            break
        if isinstance(command, str) and productive_shell(command):
            productive_at = "shell"
            break
    # SRC-051 section 11 bans "the same refusal repeating with nothing changed".
    # A CODE is a bucket, not an answer: VALIDATION_FAILED covers a malformed
    # ticket ref, a surplus argument and a missing VERSION file, and scoring
    # two different problems as a repeat convicts a session that was making
    # progress through three distinct errors. Identity is the code AND the
    # sentence that came with it.
    identities = _refusal_texts(tools)
    refusals = [code for code, _message in identities]
    repeated = [
        code
        for index, (code, message) in enumerate(identities[1:], start=1)
        if (code, message) == identities[index - 1]
    ]
    return {
        "measurement": MEASURED,
        "tools": len(tools),
        "first_saipen_command": first,
        "protocol_commands": protocol,
        "protocol_commands_before_productive": protocol_before,
        "productive_action": productive_at,
        "refusal_sequence": refusals[:20],
        "repeated_refusal": sorted(set(repeated)),
    }


def session(model: str, project: Path, task: str, timeout: int) -> dict:
    began = time.time()
    since_ms = int(began * 1000)
    env = _task_env(project, task)
    proc = subprocess.run(
        [OPENCODE, "run", task, "--format", "json", "--auto", "--model", model],
        cwd=str(project),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    events = []
    for raw in proc.stdout.splitlines():
        line = raw.strip()
        if not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    tools = _tool_events(events)
    source = SOURCE_STDOUT if events else SOURCE_NONE
    session_id = next(
        (event["sessionID"] for event in events if isinstance(event.get("sessionID"), str)),
        None,
    )
    stored_parts: list[dict] = []
    if not events:
        stored_parts = _host_store_parts(project, since_ms, session_id)
        if stored_parts:
            tools = _part_tool_events(stored_parts)
            source = SOURCE_HOST_STORE
    measured = source != SOURCE_NONE
    infrastructure = infrastructure_failure(proc.returncode, tools, events, proc.stderr)
    metrics = (
        {"measurement": INFRASTRUCTURE_UNMEASURED, **_UNMEASURED_METRICS}
        if infrastructure
        else measure(tools, measured=measured)
    )
    return {
        "model": model,
        "returncode": proc.returncode,
        "elapsed_s": round(time.time() - began, 1),
        # SRC-049:R011 -- the binding a session actually ran under, recorded
        # from the environment that was HANDED to the host, not from prose.
        "binding": {
            "cwd": str(project),
            "PWD": env.get("PWD"),
            "SAIPEN_PROJECT_ROOT": env.get("SAIPEN_PROJECT_ROOT"),
            "SAIPEN_TASK_FILE": env.get("SAIPEN_TASK_FILE"),
            "OLDPWD": env.get("OLDPWD"),
            "INIT_CWD": env.get("INIT_CWD"),
            "resolved_project_root": str(project),
        },
        "text": "\n".join(
            (event.get("part") or {}).get("text", "")
            for event in events
            if event.get("type") == "text"
        )[:2000],
        "stderr_tail": proc.stderr[-4000:],
        "events_parsed": len(events),
        "stdout_chars": len(proc.stdout),
        "stderr_chars": len(proc.stderr),
        "measurement_source": source,
        "host_store_parts": len(stored_parts),
        "session_id": session_id,
        **metrics,
        "infrastructure_error": infrastructure,
        "tool_names": [item["tool"] for item in tools] if measured else None,
    }


def drive_with_retries(run_once, retries: int, unchanged) -> dict:
    """Drive one condition, re-driving ONLY an infrastructure failure, boundedly.

    `run_once()` returns a session record; `unchanged()` answers whether the
    fixture is still byte-identical to what the first attempt was handed. A
    retry happens only when both hold -- the provider failed before any tool,
    and nothing moved -- so a retry can never re-drive a project a previous
    attempt touched. Every attempt stays on the record.
    """
    attempts: list[dict] = []
    record: dict = {}
    for attempt in range(1 + max(0, retries)):
        record = run_once()
        attempts.append(
            {
                "attempt": attempt + 1,
                "measurement": record.get("measurement"),
                "returncode": record.get("returncode"),
                "infrastructure_error": record.get("infrastructure_error"),
            }
        )
        if record.get("measurement") != INFRASTRUCTURE_UNMEASURED or not unchanged():
            break
    record["attempts"] = attempts
    return record


#: Isolation outcomes. INCONCLUSIVE exists because "this repository's bytes
#: moved" answers TWO different questions and the old verdict collapsed them.
#: Measured: an operator checkpointing in the main repository while the matrix
#: ran turned a clean `healthy` session into isolation=FAIL -- a contamination
#: verdict against a model that never touched this project. The discriminator
#: is the one already available: a session that wrote HERE leaves the ids it
#: minted in THIS ledger. No minted id here means somebody else did the
#: writing, and the isolation question is simply unanswered for that session.
ISOLATION_PASS = "PASS"
ISOLATION_FAIL = "FAIL"
ISOLATION_INCONCLUSIVE = "INCONCLUSIVE_CONCURRENT_MAIN_WRITE"


def isolation_verdict(record: dict, repo: Path) -> str:
    """Did this session leak into THIS repository? Nothing else.

    The old rule opened with "the fixture's canonical files did not move ->
    FAIL", which answers a different question: a session that did nothing at
    all contaminates nothing, and on the 17.09 smoke `windows_path_task` --
    no tool calls, no minted id, this repository byte-identical -- was
    convicted of contamination it could not have committed. Whether the
    fixture moved is productivity (`fixture_moved`, and the target bytes), and
    `matrix_verdict.py` already judges that.

    Contamination has exactly two witnesses, and both are read from ledgers
    rather than prose: an id THIS repository minted while a fixture session
    ran, or an id the fixture minted that THIS repository's own ledger also
    holds.
    """
    if record.get("main_minted", {}).get("tickets") or record.get("main_minted", {}).get(
        "receipts"
    ):
        return ISOLATION_FAIL
    owners = record.get("owner_repository") or {}
    if any(str(repo) in places for places in owners.values()):
        return ISOLATION_FAIL
    if not record.get("repository_canonical_changed"):
        return ISOLATION_PASS
    return ISOLATION_INCONCLUSIVE


def force_utf8_console(*streams) -> None:
    """The console must never be able to kill a run.

    A model answers in whatever language it likes, and a redirected stdout on
    this Windows host is cp1251. Measured: the fifth session of a nine-session
    matrix printed a u-umlaut and the WHOLE RUN died with UnicodeEncodeError --
    forty minutes of live model time and four measured sessions thrown away by
    a console codec. The transcript is DATA; it does not get a veto.
    """
    for stream in streams:
        with suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8", errors="replace")


def _write_report(out_dir: str | None, report: dict) -> bool:
    if not out_dir:
        return False
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "polygon.json").write_text(
        json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8", newline="\n"
    )
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", default=["sairoute/SAIFREN"])
    parser.add_argument("--conditions", nargs="+", default=None)
    parser.add_argument("--timeout", type=int, default=1200)
    parser.add_argument("--out", default=None)
    parser.add_argument(
        "--infra-retries",
        type=int,
        default=DEFAULT_INFRA_RETRIES,
        help="re-drive a condition whose provider failed before any tool, at most N times",
    )
    args = parser.parse_args()

    force_utf8_console(sys.stdout, sys.stderr)

    if not OPENCODE:
        print("opencode runtime unavailable")
        return 3
    if not GIT:
        print("git unavailable: a fixture that is not a worktree is not a sandbox")
        return 3
    generation = subprocess.run(
        [sys.executable, str(INSTALLED / "tools" / "saipen.py"), "runtime", "--json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
    ).stdout

    built = conditions(args.conditions)
    selected = list(built)
    report = {
        "installed_runtime": INSTALLED.exists(),
        "installed_generation": _installed_generation(),
        "runtime_probe": generation[:4000],
        "sessions": [],
    }
    for model in args.models:
        for name in selected:
            project = built[name]
            task = condition_task(name, project)
            before = _canonical_hashes(project)
            # SRC-049:R011 -- the MAIN repository is measured too. "the model
            # edited the fixture's file" is not isolation; "this repository's
            # canonical carriers are byte-identical" is.
            repo_before = _canonical_hashes(REPO)
            owned_before = _owning_ledger(project)
            repo_owned_before = _owning_ledger(REPO)
            # SRC-051 section 11 -- "the requested target bytes actually
            # change". A model can drive the whole protocol chain, close the
            # ticket, and never touch the file it was asked about.
            target_before = _target_digest(project)

            def run_once(project=project, task=task, model=model):
                began_ms = int(time.time() * 1000)
                try:
                    return session(model, project, task, args.timeout)
                except subprocess.TimeoutExpired:
                    # A killed session's stdout is lost, but the host wrote its
                    # parts down as it went: the work it DID do before the wall
                    # clock ran out is a measurement, not a blank. Only when that
                    # store is empty too does the session go UNMEASURED -- which
                    # must never read as a run that chose to do nothing.
                    stored = _host_store_parts(project, began_ms, None)
                    return {
                        "model": model,
                        "timeout": True,
                        "measurement_source": SOURCE_HOST_STORE if stored else SOURCE_NONE,
                        "host_store_parts": len(stored),
                        **measure(_part_tool_events(stored), measured=bool(stored)),
                    }

            def unchanged(project=project, before=before, target_before=target_before):
                return (
                    _canonical_hashes(project) == before
                    and _target_digest(project) == target_before
                )

            record = drive_with_retries(run_once, args.infra_retries, unchanged)
            after = _canonical_hashes(project)
            repo_after = _canonical_hashes(REPO)
            owned_after = _owning_ledger(project)
            record["condition"] = name
            record["task"] = task
            record["project"] = str(project)
            record["canonical_changed"] = sorted(
                key for key in before if before[key] != after[key]
            )
            record["repository_canonical_changed"] = sorted(
                key for key in repo_before if repo_before[key] != repo_after[key]
            )
            record["fixture_minted"] = {
                "tickets": [
                    t for t in owned_after["tickets"] if t not in owned_before["tickets"]
                ],
                "receipts": [
                    r for r in owned_after["receipts"] if r not in owned_before["receipts"]
                ],
            }
            repo_owned_after = _owning_ledger(REPO)
            record["main_minted"] = {
                "tickets": [
                    t
                    for t in repo_owned_after["tickets"]
                    if t not in repo_owned_before["tickets"]
                ],
                "receipts": [
                    r
                    for r in repo_owned_after["receipts"]
                    if r not in repo_owned_before["receipts"]
                ],
            }
            record["fixture_moved"] = bool(record["canonical_changed"])
            record["owner_repository"] = _owner_repository(
                record["fixture_minted"], project
            )
            target_after = _target_digest(project)
            record["target"] = {
                "path": TARGET_FILE,
                "before": target_before,
                "after": target_after,
                "changed": target_before != target_after,
            }
            if name == "windows_path_task":
                # SRC-055 section 6: transport is proven by the VALUE only the
                # named file holds arriving in the target, not by any edit.
                value = notes_value(project)
                landed = (project / TARGET_FILE).read_text(encoding="utf-8", errors="replace")
                record["authority"] = {
                    "path": str(windows_notes_path(project)),
                    "readable": value is not None,
                    "value": value,
                    "target_carries_value": bool(value) and value in landed,
                }
            elif name == "windows_path_missing":
                missing = re.search(r"[A-Za-z]:\\\S+", task)
                record["authority"] = {
                    "path": missing.group(0) if missing else None,
                    "exists": bool(missing) and Path(missing.group(0)).exists(),
                }
            record["isolation"] = isolation_verdict(record, REPO)
            report["sessions"].append(record)
            # Write after EVERY session. Live model time is the expensive part
            # of this harness, and a run that only persists at the end throws
            # all of it away on any crash in the loop -- which is exactly how
            # four measured sessions were lost to a console codec.
            _write_report(args.out, report)
            print(
                f"{model} :: {name:22s} measurement={record.get('measurement')} "
                f"first={record.get('first_saipen_command')!r} "
                f"protocol_before={record.get('protocol_commands_before_productive')} "
                f"productive={record.get('productive_action')} "
                f"target_changed={record['target']['changed']} "
                f"refusals={record.get('refusal_sequence')} "
                f"repeated={record.get('repeated_refusal')} "
                f"isolation={record.get('isolation')} "
                f"minted={record.get('fixture_minted')} "
                f"attempts={len(record.get('attempts') or [])} "
                f"authority={record.get('authority')}"
            )
    if _write_report(args.out, report):
        print(f"wrote {Path(args.out) / 'polygon.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
