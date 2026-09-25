#!/usr/bin/env python
# ruff: noqa: E402
"""saipen -- thin adapter over the SAIPEN engine (NITRO).

Read-only commands: `saipen status`, `saipen next`. Mutating commands run
PLAN/APPLY through the engine's lock + journal + recovery machinery:
`claim`, `transition`, `checkpoint`, `ticket add/done/supersede/retire/block/unblock`.
`saipen recover` lists and resolves pending operation journals; status and
next derive `recovery_pending` from the real journal state, never a hardcoded
false.

Exit codes: 0 success, 1 refused, 2 usage, 3 not a SAIPEN project.
"""

from __future__ import annotations

import json
import os
import re
import sys
from contextlib import suppress
from pathlib import Path

# Public commands promise not to dirty the project merely by importing their
# implementation. Set this before importing project modules so ``tt`` and all
# other read-only routes cannot create ``__pycache__``/``.pyc`` artifacts.
sys.dont_write_bytecode = True

from saipen_engine import codec, snapshot
from saipen_engine.board import parse_board, ticket_is_workable
from saipen_engine.commands import load_shortcut_table, resolve_shortcut
from saipen_engine.journal import auto_recover_pending
from saipen_engine.operations import (
    _ticket_add_route,
    apply_claim,
    checkpoint,
    compact_board,
    finish_ticket,
    plan_claim,
    repair_metadata,
    resolve_external_ticket,
    supersede_ticket,
    ticket_add,
    ticket_move,
    ticket_reasoning,
    ticket_verify,
    transition_phase,
)
from saipen_engine.paths import resolve_project_root, resolve_protocol_dir, resolve_tool_root
from saipen_engine.state import parse_state, parse_state_or_error

AGENT = "saipen-cli"

HOME = resolve_tool_root()
VERSION_FILE = HOME / "VERSION"
# The canonical protocol home this adapter ships from: the shortcut table and
# its Cyrillic-twin normalization are read from here through the ONE shared
# engine resolver -- never re-declared in this file (no Cyrillic literal, no
# second confusable map, no hardcoded twin dictionary may live below).
PROTOCOL_DIR = resolve_protocol_dir(HOME)

# The ONE canonical actor resolver (T-1006): bare CLI INHERITS STATE.agent
# -- the seat CORE.md section 1.4 defines -- and an explicit `--agent <id>`
# names the ACTING actor for this invocation. CORE-001 (SRC-026:R001) resolved
# the long-standing ambiguity in favour of ACTING ACTOR, NOT automatic
# handover:
#
#   * `--agent B` identifies who is running the command. It is recorded as
#     journal provenance (`actor B (seat A)`) on every mutation B performs
#     out of band.
#   * It does NOT by itself steal A's LIVE active execution seat. Active
#     execution ownership transfers only through an explicit authorized path:
#     `saipen claim <T-###> [--explicit]` (adoption/lease refresh) or the
#     authorized handover operation `operations.handover_agent(...,
#     explicit=True)`.
#
# The pre-CORE-001 comment claiming "an explicit --agent is a genuine
# handover request" described a fold (`_ensure_handover`) that is now a
# deliberate no-op: an out-of-band actor recording future Work must not move
# the seat. STATE.agent is never invented by the CLI; only an explicit
# ownership operation replaces the inherited seat.
_AGENT_OVERRIDE: str | None = None

# Adaptive Runtime Wave 1: optional runtime metadata is telemetry for this
# invocation.  It is deliberately separate from `_AGENT_OVERRIDE`, which owns
# the acting seat/handover identity.  The projection is read-only and never
# persists this value into project state.
_RUNTIME_INFO_OVERRIDE: str | None = None

# CORE § 1.10 (Cyrillic-twin incident): when the invoked command resolved
# through the shared shortcut resolver, EVERY payload this adapter emits
# carries `route` -- the canonical Latin key the raw token landed on. The
# agreement property is then mechanical: whatever the resolver declares,
# every branch's output (success or refusal) names its route, so output can
# never silently disagree with resolution. Set once in main(); None when the
# invocation was not a declared shortcut (direct verbs stay untagged).
_ROUTE_ECHO: str | None = None

#: T-1378. The project root whose DIAGNOSTIC answer must also name the entry
#: command when this session was launched with a task it has not started.
#: Measured 2026-09-17: four of nine field sessions opened with `status` or
#: `continue` although BOOT's entry table sends a new actionable task to
#: `start`. `status` answered `next_action: saipen continue`, and `continue`
#: answered IMPROVE_AUDIT_ASSIGNMENT -- a session handed a user task was routed
#: into an improvement audit. The table was right; the runtime's own answer to
#: the question the model actually asked did not agree with it.
_ENTRY_HINT_ROOT: Path | None = None
#: T-1497: set for the turn-entry questions (`continue`/`cc`/`status`); every
#: JSON answer they emit carries the seat's unread SAIMAIL telegram counts.
_TELEGRAM_ROOT: Path | None = None


def _agent_for(project_root: Path) -> str:
    """The canonical acting actor for this invocation (T-1006, CORE-001).

    An explicit `--agent <id>` override names the ACTING ACTOR (not an
    automatic handover: it never steals A's live active seat -- that transfer
    goes through `saipen claim` or an explicit authorized handover).
    Otherwise the actor is INHERITED from persisted STATE.agent -- a
    returning agent keeps the seat (CORE.md section 1.4, BOOT.md).
    `AGENT` is the fallback only for a project with no persisted agent."""
    if _AGENT_OVERRIDE is not None:
        return _AGENT_OVERRIDE
    state_path = _state_path(project_root)
    if state_path.is_file():
        state, _ = parse_state_or_error(codec.read_doc(state_path))
        if state and state.get("agent"):
            return state["agent"]
    return AGENT


# T-1006 / T-1363: ONE canonical, subcommand-aware effect classifier decides
# whether an invocation writes canonical state (and therefore journals its
# acting actor as provenance). It does NOT trigger any handover: since CORE-001
# (SRC-026:R001) a mutating command under `--agent B` never transfers A's live
# seat -- the mutations fold the acting actor into the journal instead.
#
# The verb taxonomy is `REGISTRY.json.command_effects`, read by
# `saipen_engine.command_effects`; the guard and the host adapters consume the
# same table. This CLI kept a second copy of it, and the copies disagreed:
# `validate` stayed "mutating" here after it became a read-only gate, and
# `attempt`/`stop` were "read-only" here while both journal. A DIAGNOSTIC class
# is the only read-only answer; the confirm/directive arity below is the one
# refinement the table cannot express -- a malformed confirm writes nothing.


def _command_mutates(command: str, rest: list[str]) -> bool:
    """Does this invocation write canonical state? (T-1006 mutation gate.)

    Subcommand-aware and authoritative: the dispatcher routes AFTER this
    verdict, so a read-only projection under `--agent B` never writes
    canonical state, never appends LOG, never updates STATE, and never
    creates recovery operations. Mutating invocations do NOT perform any
    seat transfer (T-1014 fold removed, CORE-001/SRC-026:R001): the acting
    actor is journaled as provenance inside the op's own admissible
    transaction (T-1014: only after the concrete action's syntax/arity
    validation has passed, so a malformed invocation stays zero-write).
    """
    from saipen_engine.command_effects import DIAGNOSTIC, classify_invocation

    sub = rest[0] if rest and not rest[0].startswith("-") else None
    if command in ("cut", "xx"):
        return (
            sub == "confirm"
            and len(rest) == 4
            and bool(rest[1].strip())
            and rest[2] == "--"
            and bool(rest[3].strip())
        )
    if command in ("undo", "zz"):
        return (
            sub == "confirm"
            and len(rest) >= 4
            and rest[2] == "--reason"
            and bool(" ".join(rest[3:]).strip())
        )
    if command in ("build", "vv"):
        return bool(" ".join(rest).strip())
    return classify_invocation(command, rest) != DIAGNOSTIC


def _ensure_handover(
    project_root: Path, as_json: bool, dry_run: bool, allow_dead_home: bool = False
) -> int | None:
    """Deferred handover hook (CORE-003) -- deliberately a NO-OP.

    CORE-001 (SRC-026:R001) made the seat semantics explicit: `--agent B`
    names the acting actor, it does not transfer A's live execution seat.
    An out-of-band actor recording future Work/user intent/checkpoints keeps
    the seat where it is (`operations._actor_provenance` /
    `operations._seat_agent`); the mutations fold the acting actor into the
    journal instead of stealing STATE.agent. The real explicit transfer
    surfaces are `operations.handover_agent(..., explicit=True)` and
    `saipen claim <T-###>`. Retained for call-site stability; performs no
    disk write and delegates no fold (the historical reference to
    `operations._event_line_with_handover` was removed with that fold).
    """
    return None


_TERMINAL_RESULT_RE = re.compile(r"->\s*(PASS|FAIL)\b")


def _validator_terminal_result(txt: str) -> str:
    """The canonical terminal result of a validator RUN event, or UNKNOWN
    (second-wave P2).

    The result token is `-> PASS` / `-> FAIL`, and evidence MAY follow it --
    `validate.py -> PASS conf: high -- 0 FAIL 21 WARN` is the shape agents
    actually write. This used to anchor the token to end of line, which made
    UNKNOWN the answer for every real record and left `saipen status` reporting
    an unknown gate until somebody hand-wrote a bare line (T-1243).

    The property the anchor was defending survives intact, in two parts that
    each carry their own half:

    - the token must sit IMMEDIATELY after the arrow, on a word boundary, so
      `-> BYPASS`, `-> PASSING` and `-> NOT PASS` match nothing at all;
    - a record that claims a PASS and also claims a failure is UNKNOWN, not
      PASS. `_claims_failure` is the repository's existing hostile-tested
      negative-evidence reader, reused rather than reimplemented: it reads
      `PASS but the suite failed on linux` as a claim and `0 FAIL 21 WARN` as
      a count, which is exactly the distinction this needs.

    Nothing is ever promoted to a conformance PASS on a substring.
    """
    m = _TERMINAL_RESULT_RE.search(txt)
    if not m:
        return "UNKNOWN"
    if m.group(1) == "FAIL":
        return "FAIL"

    from saipen_engine.log import _claims_failure

    return "UNKNOWN" if _claims_failure(txt) else "PASS"


def _project_conformance(history_events) -> str | None:
    """The conformance gate `saipen status` reports, or None when unrecorded.

    Two narrownesses, and dropping either one breaks the projection in a
    different direction (T-1243).

    The RESULT is read only from the canonical token, so nothing is promoted to
    a PASS on a substring -- that half lives in `_validator_terminal_result`.

    The SELECTOR is the half this function owns: naming the validator is not
    running it. A checkpoint that discusses `validate.py:3871` is prose about
    the file, and treating it as the newest validator record let it shadow the
    last real run, which is how a green repository reported an unknown gate. So
    the search takes the newest RUN that both names the validator and carries a
    decidable result; a record with no result token contributes no gate
    information and must not hide one that does. If nothing decidable exists at
    all, the answer is UNKNOWN, dated by the newest naming record -- silence and
    "not proven" stay distinguishable.
    """
    fallback: str | None = None
    for ev in reversed(history_events):
        txt = ev.get("text", "")
        if ev.get("taxonomy") != "RUN":
            continue
        if not ("validate.py" in txt or "validate.sh" in txt or "validate.ps1" in txt):
            continue
        stamp = ev.get("date") or ""
        result = _validator_terminal_result(txt)
        rendered = f"{result} ({stamp})" if stamp else result
        if result == "UNKNOWN":
            if fallback is None:
                fallback = rendered
            continue
        return rendered
    return fallback


def _protocol_version() -> str:
    try:
        return VERSION_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return "unknown"


def _same_install_path(a: Path, b: Path) -> bool:
    """Path identity that tolerates Windows case and separator drift."""
    left, right = str(a), str(b)
    if os.name == "nt":
        left, right = left.lower().replace("/", "\\"), right.lower().replace("/", "\\")
    return left == right


def _runtime_drift_payload(project_root: Path, command: str) -> dict | None:
    """T-1159: diagnose stale-installed-runtime drift on an unknown command.

    The observed incident: a project booted against SAIPEN home A was driven
    with an OLDER install B whose adapter lacked `continue`, producing a bare
    ``unknown command`` that invited improvisation. When the project's own
    `saipen_home` names an install other than the executing runtime, the
    unknown command is reported as RUNTIME_DRIFT with both versions and the
    exact safe action -- never silently reinterpreted, never auto-migrated.
    """
    state_path = _state_path(project_root)
    if not state_path.is_file():
        return None
    try:
        head = state_path.read_text(encoding="utf-8-sig", errors="replace")[:4096]
    except OSError:
        return None
    match = re.search(
        r"^saipen_home:\s*\"?([^\"\r\n]+?)\"?\s*$", head, re.MULTILINE | re.IGNORECASE
    )
    if not match:
        return None
    other_raw = match.group(1).strip()
    if not other_raw:
        return None
    mine = HOME.resolve()
    other = Path(other_raw)
    with suppress(OSError):
        other = other.resolve()
    if _same_install_path(other, mine):
        return None

    def _version_at(path: Path) -> str:
        try:
            return (path / "VERSION").read_text(encoding="utf-8-sig").strip()
        except OSError:
            return "unavailable"

    runner = other / "tools" / "saipen.py"
    return {
        "ok": False,
        "code": "RUNTIME_DRIFT",
        "command": command,
        "runtime": {"home": str(mine), "version": _version_at(mine)},
        "project_protocol": {"home": str(other), "version": _version_at(other)},
        "detail": (
            f"command {command!r} is not implemented by this runtime, and this "
            "project's saipen_home points at a DIFFERENT SAIPEN install; this "
            "is runtime drift between the installed skill/runtime and the "
            "project protocol, not a project error (CORE § 1.10)"
        ),
        "action": (
            f"drive this project through {runner} if it exists (the project's "
            f"own protocol home), or from a trusted install run "
            f"`saipen rebind-home {other}`; no silent fallback to different "
            "semantics is performed"
        ),
    }


def _state_path(project_root: Path) -> Path:
    return project_root / ".saipen" / "STATE.md"


def _scan_full(project_root: Path) -> tuple[list[str], list[str], list[dict]]:
    """ONE recovery-manifest traversal for pending ids, conflicts AND the
    structured corrupt records (T-1014). One scan serves all three
    projections, so every command sees exactly one manifest snapshot."""
    from saipen_engine.journal import scan_pending

    pending, conflicts = scan_pending(project_root)
    return (
        [op["op_id"] for op in pending],
        [op["op_id"] for op in conflicts],
        [op for op in pending if op.get("corrupt")],
    )


def _corrupt_refusal(corrupt: list[dict]) -> dict:
    """The ONE shared CORRUPT_JOURNAL refusal payload (P1#6)."""
    return {
        "ok": False,
        "code": "CORRUPT_JOURNAL",
        "op_ids": [op["op_id"] for op in corrupt],
        "recovery_required": True,
        "corrupt": [
            {"op_id": op["op_id"], "status": op.get("status"), "detail": op.get("detail", "")}
            for op in corrupt
        ],
        "detail": f"corrupt recovery evidence {corrupt[0]['op_id']} "
        f"({corrupt[0].get('detail', '')}) -- resolve it "
        f"explicitly before any further canonical write",
    }


def _negotiate_capability(project_root: Path) -> str:
    """Negotiate the CURRENT-SESSION capability at the public command boundary
    (hostile-regression, P0#4).

    The persisted STATE.mode is ONLY the LAST handshake outcome and MUST NOT
    prove current write authority -- a stale read-only must not suppress a
    newly writable session, nor a stale full publish into a newly read-only
    one. The live session negotiates a fresh capability through the ONE shared
    negotiator and injects it into routing/release/crew; the persisted mode
    stays historical. `project_root` is accepted so the signature stays stable
    for callers, and deliberately UNUSED: reading the project's own STATE here
    is exactly the fail-open this closes."""
    from saipen_engine.capability import negotiate_capability

    return negotiate_capability()


def _invalid_capability_refusal() -> dict | None:
    """The refusal payload for a present-but-invalid live capability, or None.

    Read-only by construction: it inspects the declaration and returns a dict.
    Nothing is journaled, no project root is resolved, no canonical byte is
    touched, so an invalid declaration cannot reach a write path at all --
    which is the property CORE-004's acceptance measures by hashing the tree
    before and after a mutating command.
    """
    from saipen_engine.capability import (
        CAPABILITIES,
        ENV_VAR,
        capability_error,
        negotiate_capability,
    )

    declared = negotiate_capability()
    problem = capability_error(declared)
    if problem is None:
        return None
    return {
        "ok": False,
        "code": "CAPABILITY_DENIED",
        "detail": (
            f"{ENV_VAR}={declared!r} is not one of {'/'.join(CAPABILITIES)}; "
            "an invalid live capability declaration is refused before any "
            "command runs rather than treated as a writable session"
        ),
    }


def _capability_refusal(as_json: bool) -> int:
    """Emit the read-only capability refusal and return exit 1 (CORE-002).

    Called AFTER the concrete command's syntax/arity validation has passed
    but BEFORE any real write/journal creation, so a malformed
    mutating invocation still gets its specific VALIDATION_FAILED message
    and stays zero-write, while a syntactically valid mutating invocation
    under a read-only session is refused deterministically.
    """
    _emit(
        {
            "ok": False,
            "code": "CAPABILITY_DENIED",
            "detail": "current session capability is read-only; no mutating "
            "command may proceed without --dry-run",
        },
        as_json,
    )
    return 1


def _parked_work(board_tickets: dict, state: dict) -> list[str]:
    """The complete parked-work summary (CORE-006).

    Every `## BLOCKED` ticket, any untriaged `[MARKHUNT]` finding, and a
    live `WAIT:` from STATE. Deduplicated, read-only, zero-write.
    """
    parked: list[str] = []
    seen: set[str] = set()
    for tid, ticket in board_tickets.items():
        if ticket.get("section") == "## BLOCKED":
            blocker = ticket.get("fields", {}).get("blocker", "")
            label = f"{tid} blocked: {blocker}" if blocker else f"{tid} blocked"
            if tid not in seen:
                parked.append(label)
                seen.add(tid)
    # A live STATE WAIT carries a live stuck signal.
    wait = state.get("wait")
    if wait and str(wait).strip():
        key = f"WAIT: {wait}"
        if key not in seen:
            parked.append(key)
            seen.add(key)
    # Untriaged [MARKHUNT] findings: any BLOCKED ticket whose blocker text
    # references an untriaged markhunt finding.
    for tid, ticket in board_tickets.items():
        blocker = ticket.get("fields", {}).get("blocker", "")
        if "[MARKHUNT]" in blocker.upper() and tid not in seen:
            parked.append(f"{tid} untriaged [MARKHUNT]")
            seen.add(tid)
    return parked


def _permissions(project_root: Path, as_json: bool) -> int:
    """T-1160: read-only effect-authorization diagnostic (P2).

    Explains, per effect: the POLICY in force and where it came from, what
    the HOST enforcement actually is (UNAVAILABLE unless declared), whether
    the combination leaves an ENFORCEMENT_GAP, and the tool/adapter effect
    contracts. Also reports the current dirty worktree through the cheap
    read-only Git delta. It NEVER claims a sandbox it cannot see.
    """
    from saipen_engine.capability import negotiate_capability
    from saipen_engine.effects import (
        TOOL_GUARANTEED_EFFECTS,
        TOOL_POSSIBLE_EFFECTS,
        assess_enforcement_gap,
        load_policy,
        tree_snapshot,
    )

    capability = negotiate_capability()
    loaded = load_policy(project_root, capability=capability)
    gap = assess_enforcement_gap(loaded["policy"])
    tree = tree_snapshot(project_root)
    payload = {
        "ok": True,
        "code": "PERMISSIONS",
        "capability": capability,
        "policy_source": loaded["source"],
        "policy_overrides": loaded["overrides"],
        "policy": loaded["policy"],
        "host_enforcement": gap["host"],
        "strict_effects": gap["policy_strict_effects"],
        "enforcement_gap": gap["gap"],
        "enforcement_verdict": gap["verdict"],
        "tool_contracts": {
            "guaranteed": {k: list(v) for k, v in TOOL_GUARANTEED_EFFECTS.items()},
            "possible": {k: list(v) for k, v in TOOL_POSSIBLE_EFFECTS.items()},
            "note": "possible effects are capability, not observation",
        },
        "worktree_delta": {"status": tree["status"], "paths": list(tree["paths"])},
    }
    if as_json:
        _emit(payload, True)
        return 0
    print(f"session capability : {capability}")
    print(f"policy source      : {payload['policy_source']}")
    if payload["policy_overrides"]:
        for override in payload["policy_overrides"]:
            print(f"  override         : {override}")
    for effect in sorted(payload["policy"]):
        marker = " *" if payload["policy"][effect] != "ALLOW" else ""
        print(f"  {effect:<18} {payload['policy'][effect]}{marker}")
    print(f"host enforcement   : {gap['host']['strength']} ({gap['host']['note']})")
    if gap["gap"]:
        strict = ", ".join(gap["policy_strict_effects"])
        print("ENFORCEMENT_GAP    : policy is stricter than enforced reality")
        print(f"  strict effects   : {strict}")
        print("  indirect execution paths may bypass tool-specific approval")
    print(
        f"worktree delta     : {tree['status']}"
        + (f" ({len(tree['paths'])} changed)" if tree["paths"] else "")
    )
    return 0


def _hex_decode(text: str) -> str | None:
    """Strict even-length hex token -> UTF-8 text, or None.

    Free-form search text travels HEX-ENCODED through the canonical surface
    because the guard's canonical argument alphabet (`_SAIPEN_ARG_CHARS`) and
    its shell-syntax refusal exist on purpose, and a regex like
    `CommitSnapshot|FlushSyncUnderGate` is mostly shell metacharacters. Hex is
    also the reason the transport is shell-agnostic: PowerShell, cmd and bash
    cannot reinterpret `616263` as a pipe, quote or variable.
    """
    if not text or len(text) % 2 != 0:
        return None
    try:
        return bytes.fromhex(text).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


#: T-1412: a canonical-validator run is bounded like every other internal
#: capture (the debt engine's VALIDATOR_CAPTURE_TIMEOUT), and its output is
#: summarized for the operator, never proxied whole into JSON.
_CANONICAL_VALIDATOR_TIMEOUT_SECONDS = 1800
_VALIDATOR_OUTPUT_TAIL_CHARS = 2000


def _bounded_validator_output(completed) -> str:
    """Tail-bounded validator output. NEVER a PASS/FAIL verdict source."""
    text = completed.stdout or ""
    if completed.stderr:
        text = f"{text}\n{completed.stderr}" if text else completed.stderr
    text = text.strip()
    if len(text) <= _VALIDATOR_OUTPUT_TAIL_CHARS:
        return text
    return text[-_VALIDATOR_OUTPUT_TAIL_CHARS:]


def _canonical_validator_path() -> Path:
    """The canonical validator owned by the RUNNING SAIPEN runtime (T-1412).

    Resolved through the install-ownership primitive
    (`saipen_engine.paths.resolve_tool_path` -> `<install>/tools/validate.py`),
    with the executing adapter's own directory as the source-layout
    equivalent. Deliberately no PATH search and no cwd dependence: a stale
    clone or a project-vendored copy must never answer for this runtime.
    """
    from saipen_engine.paths import resolve_tool_path

    try:
        return resolve_tool_path("validate.py")
    except (FileNotFoundError, ValueError):
        beside = Path(__file__).resolve().parent / "validate.py"
        if beside.is_file():
            return beside
        raise FileNotFoundError(
            "canonical tools/validate.py is missing from the running SAIPEN runtime"
        ) from None


class _ValidatorRun:
    """One bounded canonical-validator execution result (T-1412)."""

    __slots__ = ("error", "exit_code", "launched", "path", "summary")

    def __init__(self, path, launched, exit_code=None, summary="", error=None):
        self.path = path
        self.launched = launched
        self.exit_code = exit_code
        self.summary = summary
        self.error = error


def _run_canonical_validator(project_root: Path) -> _ValidatorRun:
    """Execute the canonical Core validator through an INTERNAL argv path.

    No shell, no command string, no `shell=True`. The exit code and the receipt
    the validator writes are the only inputs; free-form stdout is summarized
    for the operator and never parsed for a PASS/FAIL verdict (T-1412).
    """
    import subprocess

    try:
        validator = _canonical_validator_path()
    except Exception as exc:
        return _ValidatorRun(None, False, error=f"{type(exc).__name__}: {exc}")
    command = [
        sys.executable,
        str(validator),
        "--project-root",
        str(project_root),
        "--gate",
        "core",
    ]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_CANONICAL_VALIDATOR_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        return _ValidatorRun(validator, False, error=f"{type(exc).__name__}: {exc}")
    return _ValidatorRun(
        validator,
        True,
        exit_code=completed.returncode,
        summary=_bounded_validator_output(completed),
    )


def _validator_run_block(run: _ValidatorRun) -> dict:
    block = {
        "path": str(run.path) if run.path else None,
        "launched": run.launched,
        "exit_code": run.exit_code,
        "summary": run.summary,
    }
    if run.error:
        block["error"] = run.error
    return block


def _validate(project_root: Path, as_json: bool) -> int:
    """The canonical Core-conformance front door (T-1412). EVIDENCE-WRITE.

    T-1357 gave a blocked operator a read-only fast-gate report under this verb;
    T-1412 makes it the REAL remediation the router already recommends. Two
    ordered stages:

    1. a cheap structural gate over canonical STATE/BOARD/LOG. A malformed
       document returns the structural failure immediately -- running the whole
       validator over proven corruption would only manufacture a receipt.
    2. if the structural gate passes, the canonical validator of the SAME
       running runtime runs as `validate.py --project-root <root> --gate core`
       through an internal argv path (no shell) and emits its ordinary
       conformance receipt.

    The verdict is NOT the validator's exit code and NOT its stdout: after the
    run `conformance_decision(project_root, gate="core")` is re-read, and ONLY
    CURRENT_PASS returns VALID -- a validator process that exits 0 without a
    durable CURRENT_PASS receipt for the final source is not proof. The receipt
    is the command's ONLY write: product files, BOARD Work, STATE phase, source
    intake and Improve cycles are untouched.
    """
    from saipen_engine import codec
    from saipen_engine.conformance import (
        CONFORMANCE_REMEDIATION_COMMAND,
        CONFORMANCE_UNAVAILABLE,
        CONFORMANCE_UNHEALTHY,
        conformance_decision,
    )
    from saipen_engine.fast_check import validate_texts

    def _authoritative_block():
        try:
            return conformance_decision(project_root, gate="core")["status_block"]
        except Exception:
            return None

    saipen = project_root / ".saipen"
    missing = [
        f".saipen/{name}"
        for name in ("STATE.md", "BOARD.md", "LOG.md")
        if not (saipen / name).is_file()
    ]
    if missing:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "canonical document(s) missing: " + ", ".join(missing),
                "errors": missing,
                "conformance_status": _authoritative_block(),
            },
            as_json,
        )
        return 1
    try:
        errors = validate_texts(
            codec.read_doc(saipen / "STATE.md"),
            codec.read_doc(saipen / "BOARD.md"),
            codec.read_doc(saipen / "LOG.md"),
            current_agent=_agent_for(project_root),
        )
    except Exception as exc:
        # A gate that cannot run is not a gate that passed: report the
        # instrument failure as itself rather than as a clean project.
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_UNAVAILABLE",
                "detail": f"the fast gate could not run ({type(exc).__name__}: {exc})",
            },
            as_json,
        )
        return 1
    if errors:
        # Structural failure: refuse before the expensive validator so a
        # malformed canonical document never manufactures a conformance receipt.
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "error_count": len(errors),
                "errors": errors,
                "detail": "; ".join(errors[:8]),
                "conformance_status": _authoritative_block(),
            },
            as_json,
        )
        return 1

    run = _run_canonical_validator(project_root)
    try:
        decision = conformance_decision(project_root, gate="core")
    except Exception as exc:
        _emit(
            {
                "ok": False,
                "code": CONFORMANCE_UNAVAILABLE,
                "detail": (
                    "the canonical validator ran but conformance could not be "
                    f"established afterwards ({type(exc).__name__}: {exc})"
                ),
                "validator": _validator_run_block(run),
            },
            as_json,
        )
        return 1

    healthy = bool(decision["healthy"])
    code = CONFORMANCE_UNHEALTHY
    detail = f"conformance is {decision['status']}: {decision['reason']}".strip()
    if run.error:
        code = CONFORMANCE_UNAVAILABLE
        detail = (
            f"conformance could not be refreshed ({run.error}); the current "
            f"authoritative status is {decision['status']}"
        )
    elif run.exit_code not in (0, None) and healthy:
        # Fail closed: a failing live run and a still-current PASS receipt
        # cannot both be true, and process output is not the authority.
        healthy = False
        code = CONFORMANCE_UNAVAILABLE
        detail = (
            f"the canonical validator exited {run.exit_code} while the stored "
            "receipt still read CURRENT_PASS -- durable evidence and the live "
            "run disagree, so no conformance verdict is claimable"
        )

    payload = {
        "ok": healthy,
        "code": "VALID" if healthy else code,
        "structural_gate": "pass",
        "validator": _validator_run_block(run),
        "conformance_status": decision["status_block"],
    }
    if healthy:
        payload["detail"] = (
            "canonical STATE/BOARD/LOG pass the structural gate and the "
            "canonical validator minted a CURRENT_PASS conformance receipt"
        )
    else:
        payload["reason"] = decision["reason"]
        payload["detail"] = detail
        if code == CONFORMANCE_UNAVAILABLE:
            payload["canonical_next_command"] = CONFORMANCE_REMEDIATION_COMMAND
        else:
            command = decision["remediation_command"]
            payload["canonical_next_command"] = command
            payload["repair_status"] = decision["repair_status"]
            payload["diagnostic"] = decision["diagnostic"]
            payload["terminal"] = command is None
            if decision.get("remediation_commands"):
                payload["remediation_commands"] = decision["remediation_commands"]
    _emit(payload, as_json)
    return 0 if healthy else 1


def _search(project_root: Path, args: list[str], as_json: bool) -> int:
    """Canonical bounded search transport (T-1320). STRICTLY READ-ONLY.

    This exists because mandatory work had two single points of failure: the
    host's ripgrep-backed Grep tool, and generic shell admission. When the host
    transport broke and the protocol state was invalid, the worker's `grep`
    fallback was correctly refused (`PROTOCOL_STATE_INVALID`) and search died
    exactly where a bound project needed it.

    The `saipen` surface is admitted by the guard as a canonical operation
    *even while protocol state is invalid*, so this verb is reachable in the
    state that broke search. It never shells out and never writes: the search
    primitive itself is pure `pathlib`/`re` (`saipen_engine/search.py`).
    """
    from saipen_engine import search as search_engine

    pattern: str | None = None
    scope: str | None = None
    include: str | None = None
    literal = False
    native_failed = False
    max_matches = search_engine.DEFAULT_MAX_MATCHES
    max_files = search_engine.DEFAULT_MAX_FILES
    error: str | None = None
    positional: list[str] = []

    rest = args[1:]
    i = 0
    while i < len(rest):
        token = rest[i]
        has_eq = "=" in token
        flag = token.split("=", 1)[0] if has_eq else token
        value = token.split("=", 1)[1] if has_eq else (rest[i + 1] if i + 1 < len(rest) else "")
        # Only a VALUE flag may consume the following token; a boolean flag
        # that swallowed its neighbour would silently demote the next argument
        # to a positional pattern (`--native-failed --hex <h>`).
        step = 1 if has_eq else 2

        if flag in ("--hex", "--scope-hex", "--include-hex"):
            decoded = _hex_decode(value)
            if decoded is None:
                error = f"{flag} takes an even-length hex-encoded UTF-8 value"
                break
            if flag == "--hex":
                pattern = decoded
            elif flag == "--scope-hex":
                scope = decoded
            else:
                include = decoded
            i += step
        elif flag == "--scope":
            if not value:
                error = "--scope takes a relative path"
                break
            scope = value
            i += step
        elif flag in ("--max-matches", "--max-files"):
            if not value.isdigit() or int(value) < 1:
                error = f"{flag} takes a positive integer"
                break
            if flag == "--max-matches":
                max_matches = int(value)
            else:
                max_files = int(value)
            i += step
        elif flag == "--literal":
            literal = True
            i += 1
        elif flag == "--native-failed":
            native_failed = True
            i += 1
        elif flag.startswith("--"):
            error = f"search does not accept {flag}"
            break
        else:
            positional.append(token)
            i += 1

    if error is None and pattern is None and positional:
        if len(positional) > 1:
            error = (
                "search takes ONE positional pattern; use --hex for text "
                "containing shell-syntax characters"
            )
        else:
            pattern = positional[0]
    if error is None and pattern is None:
        error = (
            "search needs a pattern: `saipen search <token>` for a plain "
            "token, or `saipen search --hex <hex-encoded-utf8>` for anything "
            "containing shell-syntax characters"
        )
    if error is not None:
        _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": error}, as_json)
        return 2

    if native_failed:
        # Session-scoped degradation memory: one proven-broken host transport
        # must not become fifty identical failing tool calls (T-1320 Q).
        search_engine.record_native_search(project_root, search_engine.DEGRADED)

    payload = search_engine.search(
        project_root,
        pattern or "",
        scope=scope,
        literal=literal,
        include=include,
        max_matches=max_matches,
        max_files=max_files,
    )
    # Runtime capability distinction (T-1320 P): host-transport health is
    # session/runtime diagnostic, never canonical project truth.
    payload["native_search"] = search_engine.native_search_state(project_root)
    if as_json or not payload.get("ok"):
        _emit(payload, as_json)
        return 0 if payload.get("ok") else 2
    # Bounded human view. The shared `_emit` renderer knows the canonical
    # singular keys only, and a search answer that prints NOTHING would be
    # indistinguishable from the host transport's own silent failure.
    print(
        f"engine: {payload['engine']}  status: {payload['status']}"
        f"  native: {payload['native_search']}"
    )
    print(f"root: {payload['root']}")
    print(f"scope: {payload['scope']}  query: {payload['query']}  mode: {payload['mode']}")
    summary = (
        f"matches: {payload['matches_returned']} "
        f"({payload['files_scanned']} file(s) scanned of {payload['files_considered']} considered)"
    )
    if payload["truncated"]:
        summary += "  TRUNCATED: " + ",".join(payload["truncation_reasons"])
    print(summary)
    for match in payload["matches"]:
        print(f"{match['path']}:{match['line']}: {match['excerpt']}")
    return 0


def _runtime(
    project_root: Path,
    as_json: bool,
    task_class: str | None = None,
    helper_reason: str | None = None,
    control_plane: bool = False,
) -> int:
    """Adaptive Runtime read-only identity/capability/strategy projection.

    Wave 1 supplies identity + capabilities; Wave 2 supplies the executable
    strategy decision for a declared work class.  Both are READ-ONLY: nothing
    here is written to STATE, BOARD, LOG, a cache, or a handover, and no
    provider/model identity is ever persisted into canonical Work truth.
    """
    from saipen_engine.runtime import (
        DEFAULT_TASK_CLASS,
        RuntimeInfoError,
        runtime_projection,
        strategy_projection,
    )

    try:
        projection = runtime_projection(
            _agent_for(project_root), explicit_path=_RUNTIME_INFO_OVERRIDE
        )
        strategy = strategy_projection(
            task_class=task_class or DEFAULT_TASK_CLASS,
            helper_reason=helper_reason,
            control_plane=control_plane,
            capabilities=projection["capabilities"],
        )
    except RuntimeInfoError as exc:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": str(exc),
            },
            as_json,
        )
        return 1

    payload = {"ok": True, "code": "RUNTIME", **projection, "strategy": strategy}
    if as_json:
        _emit(payload, True)
        return 0
    print("SAIPEN runtime (read-only)")
    print(f"agent seat : {projection['agent']}")
    print(f"metadata   : {projection['runtime_info_source']}")
    for field in ("harness", "provider", "model", "variant"):
        print(f"{field:<10} : {projection[field] or 'UNKNOWN'}")
    print("capabilities:")
    for name, value in projection["capabilities"].items():
        rendered = "UNKNOWN" if value is None else str(value).lower()
        print(f"  {name:<28} {rendered}")
    print("strategy:")
    print(f"  task class : {strategy['task_class']}")
    print(f"  strategy   : {strategy['strategy']}")
    print(f"  why        : {strategy['why']}")
    print(
        f"  helpers    : max {strategy['helper_ceiling']} "
        f"(depth {strategy['max_subagent_depth']}, "
        f"enforcement {strategy['depth_enforcement']})"
    )
    print(
        f"  context    : {strategy['context_budget_class']} "
        f"({strategy['context_budget_bytes']} bytes, "
        f"child packet <= {strategy['child_packet_ceiling_bytes']})"
    )
    if strategy["unknown_capabilities"]:
        print(f"  unknown    : {', '.join(strategy['unknown_capabilities'])}")
    return 0


def _guard_event(project_root_opt: str | None, args: list[str], as_json: bool) -> int:
    """Structured host-event guard (SRC-030 Part 6), routed BEFORE project-root
    resolution: a host adapter invokes the guard from the SESSION cwd carried in
    the event, and that cwd may legitimately be a detached staging directory.
    The ordinary main gate would refuse such a process before the guard could
    ever speak. The event -- then the optional explicit root -- decides binding.
    """
    from saipen_engine import guard_events

    event_json = None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--event-json" and i + 1 < len(args):
            event_json = args[i + 1]
            i += 2
        elif arg.startswith("--event-json="):
            event_json = arg.split("=", 1)[1]
            i += 1
        elif arg in ("--json", "--dry-run"):
            i += 1
        else:
            i += 1
    if event_json is None:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "guard event mode requires --event-json PATH|-|INLINE",
            },
            as_json,
        )
        return 2
    try:
        if event_json == "-":
            raw = sys.stdin.read()
        elif "\n" in event_json or event_json.lstrip().startswith("{"):
            raw = event_json
        else:
            raw = Path(event_json).read_text(encoding="utf-8", errors="replace")
        event = guard_events.load_event(raw)
    except (OSError, guard_events.EventError) as exc:
        # A malformed host event is fail-closed material for a blocking
        # adapter: the nonzero exit is the block signal.
        _emit(
            {
                "ok": False,
                "code": "GUARD_EVENT_INVALID",
                "admitted": False,
                "detail": str(exc),
            },
            as_json,
        )
        return 1
    admission_result = guard_events.evaluate_event(event, project_root_opt)
    _guard_event_probe(event, admission_result)
    _emit(admission_result, as_json)
    return 0 if admission_result.get("admitted") else 1


def _guard_event_probe(event: dict, result: dict) -> None:
    """Append one bounded line per judged event when a probe file is named.

    T-1384: the session identity the adapter carries has never been observed
    arriving, because nothing on the engine side ever wrote it down. A
    measurement that reads the adapter's SOURCE proves the field is sent, not
    that the host fills it -- and the difference is the whole question. This
    is the same shape as `SAIPEN_GUARD_STARTUP_PROBE`, per event instead of
    per process, and like it a probe failure never changes a verdict.
    """
    target = os.environ.get("SAIPEN_GUARD_EVENT_PROBE")
    if not target:
        return
    mapped = result.get("event") if isinstance(result.get("event"), dict) else {}
    line = json.dumps(
        {
            "tool_name": event.get("tool_name"),
            "session_id": mapped.get("session_id"),
            "actor": mapped.get("actor"),
            "action": mapped.get("action"),
            "code": result.get("code"),
            "admitted": result.get("admitted"),
        }
    )
    try:
        with open(target, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        # Diagnostic only. A guard that fails to journal still judges.
        pass


def _guard(project_root: Path, args: list[str], as_json: bool) -> int:
    """Read-only admission guard (SRC-028 / T-1317).

    Legacy file-action form: `--file`/`--action`/`--agent` evaluate one
    proposed file action. The structured host-event contract lives in
    `_guard_event`, routed before project-root resolution.
    """
    from saipen_engine.admission import ADAPTER_REGISTRY, effective_strength, evaluate_admission

    target_path = None
    action = "write"
    agent = None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--file" and i + 1 < len(args):
            target_path = args[i + 1]
            i += 2
        elif arg.startswith("--file="):
            target_path = arg.split("=", 1)[1]
            i += 1
        elif arg == "--action" and i + 1 < len(args):
            action = args[i + 1]
            i += 2
        elif arg.startswith("--action="):
            action = arg.split("=", 1)[1]
            i += 1
        elif arg == "--agent" and i + 1 < len(args):
            agent = args[i + 1]
            i += 2
        elif arg.startswith("--agent="):
            agent = arg.split("=", 1)[1]
            i += 1
        elif not arg.startswith("--") and target_path is None:
            target_path = arg
            i += 1
        else:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"unexpected argument for guard: {arg}",
                },
                as_json,
            )
            return 2

    # No target is the guard's diagnostic status projection, not a request to
    # mutate an unnamed file. Keep it usable while Work is BLOCKED/absent.
    if target_path is None and action == "write":
        action = "read"
    admission_result = evaluate_admission(
        project_root,
        target_path=target_path,
        action=action,
        agent=agent or _agent_for(project_root),
    )

    if target_path is None:
        # Status view: declared capability vs truthful effective enforcement
        # (SRC-030 Part 11). Never aspirational.
        admission_result["adapters"] = {
            name: {
                "declared": entry.get("declared_strength"),
                "effective": effective_strength(name)["effective"],
                "reason": effective_strength(name)["reason"],
            }
            for name, entry in ADAPTER_REGISTRY.items()
        }

    _emit(admission_result, as_json)
    return 0 if admission_result.get("admitted", admission_result.get("ok")) else 1


# T-1319: the cold route must be NAMEABLE without the host's search layer.
# OpenCode's grep/glob run through a ripgrep-backed service, and every failure
# inside that service collapses into one generic string --
# `ripgrep execution failed` -- which the operator sees instead of the real
# defect. A host fault there may not be allowed to stop protocol startup, so
# the exact files the kernel reads are resolved here with pathlib alone.
#
# Bounded by construction: a fixed document-name list inside two known
# directories, plus a `phases/<phase>.md` probe. No directory walk, no
# drive/profile scan, no recursion into unrelated repositories.
_COLD_ROUTE_DOCS = (
    "STYLE.md",
    "BOOT.md",
    "INDEX.md",
    "COMMANDS.md",
    "OPS.md",
    "SOURCES.md",
    "EXECUTION.md",
    "MAINTENANCE.md",
    "CORE.md",
    "RUNTIME.md",
)


def _cold_route(project_root: Path, state: dict | None, state_text: str = "") -> dict:
    """Deterministic cold-route locator (T-1319). Read-only, never searches.

    Names the bound project, the protocol owner, and the exact documents the
    kernel reads, so a skill entry can open them by path rather than asking the
    host to search for them.

    `state` may be None: a MALFORMED checkpoint is precisely when the located
    route matters most (recovery is found from it), so the two fields the
    locator needs are read back from the bounded head of the raw STATE text
    instead of being surrendered to the parse failure. Still no search, still
    no walk -- two anchored regexes over a bounded prefix.
    """
    root = Path(project_root).resolve()
    fields = state or {}
    home_text = str(fields.get("saipen_home") or "").strip()
    phase = str(fields.get("phase") or "").strip()
    if (not home_text or not phase) and state_text:
        head = state_text[:4096]
        if not home_text:
            match = re.search(
                r'^saipen_home:\s*"?([^"\r\n]+?)"?\s*$', head, re.MULTILINE | re.IGNORECASE
            )
            home_text = match.group(1).strip() if match else ""
        if not phase:
            match = re.search(r'^phase:\s*"?([^"\r\n]+?)"?\s*$', head, re.MULTILINE | re.IGNORECASE)
            phase = match.group(1).strip() if match else ""
    home = Path(home_text).expanduser() if home_text else None
    protocol_dir = None
    if home is not None:
        try:
            from saipen_engine.paths import resolve_protocol_dir

            protocol_dir = resolve_protocol_dir(home)
        except (OSError, ValueError):
            protocol_dir = None
    documents: dict[str, str] = {}
    if protocol_dir is not None:
        for name in _COLD_ROUTE_DOCS:
            candidate = protocol_dir / name
            if candidate.is_file():
                documents[name] = str(candidate)
    phase_module = None
    if protocol_dir is not None and phase:
        candidate = protocol_dir / "phases" / f"{phase.lower()}.md"
        if candidate.is_file():
            phase_module = str(candidate)
    project_memory: dict[str, str] = {}
    for name in ("STATE.md", "BOARD.md", "LOG.md"):
        candidate = root / ".saipen" / name
        if candidate.is_file():
            project_memory[name] = str(candidate)
    return {
        "project_root": str(root),
        "saipen_home": str(home) if home is not None else None,
        "protocol_dir": str(protocol_dir) if protocol_dir is not None else None,
        "phase": phase or None,
        "phase_module": phase_module,
        "boot": documents.get("BOOT.md"),
        "style": documents.get("STYLE.md"),
        "documents": documents,
        "project_memory": project_memory,
        # A false here is the contract: the cold route is nameable without the
        # host search layer, so a broken ripgrep cannot stop skill startup.
        "search_required": False,
    }


def _status(project_root: Path, as_json: bool) -> int:
    state_path = _state_path(project_root)
    if not state_path.is_file():
        _emit({"ok": False, "code": "NOT_SAIPEN_PROJECT"}, as_json)
        return 3
    try:
        snap = snapshot.ProjectSnapshot.capture(project_root, lean=True)
    except (OSError, ValueError) as exc:
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": f"history-ownership: {exc}"},
            as_json,
        )
        return 1
    state_text = snap.state_text
    board_text = snap.board_text
    state, state_error = parse_state_or_error(state_text)
    if state_error:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"state-malformed: {state_error}",
                # A malformed checkpoint must not cost the caller its locator:
                # the route is how the recovery command and the protocol
                # documents are found WITHOUT the host search layer (T-1320 J).
                "cold_route": _cold_route(project_root, state, state_text),
            },
            as_json,
        )
        return 1
    board = parse_board(board_text)
    doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
    todo = [t for t in board["tickets"].values() if t["section"] == "## TODO"]
    done_tickets = [t for t in board["tickets"].values() if t["section"] == "## DONE"]
    blocked_tickets = [t for t in board["tickets"].values() if t["section"] == "## BLOCKED"]

    top_workable = None
    resolved_agent = (
        _AGENT_OVERRIDE if _AGENT_OVERRIDE is not None else (state.get("agent") or AGENT)
    )
    if not board["errors"]:
        for ticket in todo:
            if ticket_is_workable(ticket, board["tickets"], agent=resolved_agent):
                top_workable = ticket["id"]
                break
    # T-1014: ONE recovery-manifest traversal serves pending/conflicts and
    # the structured corrupt records; P1#6 still refuses CORRUPT_JOURNAL with
    # the STRUCTURED record (op_id + detail) before any projection.
    pending, conflicts, _corrupt = _scan_full(project_root)
    if _corrupt:
        _emit(_corrupt_refusal(_corrupt), as_json)
        return 1
    from saipen_engine.router import (
        audit_inbox_projection,
        pending_append_projection,
        queued_source_projection,
        route_next,
        routing_failure_code,
    )

    # P0#4: the freshly negotiated current-session capability gates routing --
    # a read-only session routes RESTATE_AND_STOP, never a mutating action.
    # T-1006: routing judges claim truth against the canonical acting seat.
    routed = route_next(
        state_text,
        board_text,
        pending,
        conflicts,
        current_capability=_negotiate_capability(project_root),
        current_agent=resolved_agent,
        snap=snap,
        audit_inbox=audit_inbox_projection(project_root),
        queued_source=queued_source_projection(project_root),
        pending_append=pending_append_projection(project_root),
    )
    # SRC-085 M3: `computed_next_action`, `computed_reason` and the automation
    # block must classify the SAME gated route every other surface executes --
    # otherwise status advertises an idle continuation the continuation path
    # provably refuses. One owner: `router.gate_route`.
    from saipen_engine.router import gate_route

    _status_gated = gate_route(project_root, routed)
    if _status_gated is not None:
        routed = _status_gated
    if not routed.get("ok") and routing_failure_code(routed) == "VALIDATION_FAILED":
        # A malformed/binding failure must NOT project a healthy surface from
        # corrupt input (T-1003): status fails closed with the router's
        # diagnostics while the recovery flags stay truthful.
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "action": routed.get("action"),
                "reason": routed.get("reason"),
                "detail": routed.get("detail", ""),
                "board_errors": board["errors"],
                "recovery_pending": bool(pending),
                "recovery_conflict": bool(conflicts),
                "conflict_ops": conflicts,
                "pending_ops": pending,
            },
            as_json,
        )
        return 1

    # T-1429: operator due-time gates, visible as MACHINE side state on every
    # status projection -- differing from `parked_work` (which lists BLOCKED
    # tickets) by carrying the canonical due instant and the DEFERRED_OPERATOR
    # / DUE_OPERATOR_ACTION classification computed against the live clock.
    from saipen_engine.board import deferred_operator_class, operator_gates

    _operator_gates = operator_gates(board["tickets"])
    waiting_on_you: list[str] = []
    next_act = state.get("next_action") or ""
    if next_act.startswith("WAIT:"):
        waiting_on_you.append(next_act)
    for bt in blocked_tickets:
        # Human waits live in the parsed BOARD field map (`fields`), never at
        # the ticket-record level -- `ticket["fields"]["blocker"]` is the
        # canonical home of `| blocker:` (T-1003 hostile findings).
        b_text = bt.get("fields", {}).get("blocker") or ""
        # T-1429: ONE owner decides "does a human own this". The third local
        # copy of the vocabulary lived here and listed only the two WAIT_USER
        # classes, so a genuine BLOCKED_EXTERNAL operator gate never reached
        # `Waiting on you` -- the same hole the recovery package had, pointing
        # the other way: that one over-reported, this one hid real work.
        if deferred_operator_class(b_text) is not None:
            waiting_on_you.append(f"{bt['id']}: {b_text}")

    # A standing ingress obligation is operator-owned: only the human holds the
    # original bytes, or the authority to say the request itself changed. It
    # used to be visible ONLY inside the refusal that enforced it, so a session
    # that hit it had nothing to read and nothing to tell the operator.
    from saipen_engine.pending_ingress import obligation as _ingress_obligation

    _owed = _ingress_obligation(project_root)
    if _owed.get("owed"):
        waiting_on_you.append(
            f"{_owed['code']}: this project owes its last refused ingress"
            + (f" ({_owed.get('bytes')} bytes, sha256 {_owed.get('digest')})"
               if _owed.get("digest") else "")
            + f" -- carry the ORIGINAL bytes with `{_owed['canonical_next_command']}`,"
            + f" or supersede it with `{_owed['supersede_command']}`"
        )

    # T-1014: the parsed events come from the SAME one-pass ProjectSnapshot
    # that supplied log_hash/log_tail/head -- status never reopens the complete
    # LOG history for evidence after capturing the snapshot once.
    # T-1021: ONE backward pass over the shared history computes the verdict
    # for every DONE ticket (was one independent reverse scan per ticket).
    from saipen_engine.log import bulk_verification_evidence

    history_events = snap.history_events
    # DONE proof: a successful RUN event ASSOCIATED WITH THE TICKET.
    claimed_but_unproven: list[str] = []
    verdicts = bulk_verification_evidence(history_events, [dt["id"] for dt in done_tickets])
    for dt in done_tickets:
        if not verdicts[dt["id"]][0]:
            claimed_but_unproven.append(dt["id"])

    # Second-wave P2: parse ONLY the canonical terminal result of the validator
    # RUN (`-> PASS` / `-> FAIL` as an exact result token). A substring test
    # would promote free event text like `NOT PASS`, `BYPASS`, `PASSING` or
    # mixed failure prose to a conformance PASS although no exact successful
    # result was recorded. Noncanonical text stays UNKNOWN and is never
    # promoted to PASS.
    #
    # T-1243: the selector also has to be narrow. Naming the validator is not
    # running it -- a checkpoint that discusses `validate.py:3871` is prose
    # about the file, and treating it as the newest validator record let it
    # shadow the last real run and report UNKNOWN. So the search takes the
    # newest RUN that both names the validator AND carries a decidable result;
    # a record with no result token contributes no gate information and must
    # not hide one that does. When nothing decidable exists, the gate is
    # UNKNOWN and says so, dated by the newest naming record.
    conformance = _project_conformance(history_events)

    staleness: str | None = None
    updated_str = state.get("updated")
    if updated_str:
        import datetime

        try:
            clean_ts = updated_str.replace("Z", "+00:00")
            dt_updated = datetime.datetime.fromisoformat(clean_ts)
            dt_now = datetime.datetime.now(datetime.timezone.utc)
            delta = dt_now - dt_updated
            total_seconds = int(delta.total_seconds())
            if total_seconds >= 3600:
                hours = total_seconds // 3600
                days = hours // 24
                staleness = f"{days}d ago" if days > 0 else f"{hours}h ago"
        except (ValueError, TypeError):
            pass

    payload = {
        "ok": True,
        "project_identity": snap.project_identity,
        "protocol_version": _protocol_version(),
        "phase": state.get("phase"),
        "task": state.get("task"),
        "next_action": state.get("next_action"),
        "computed_next_action": routed.get("action"),
        "computed_reason": routed.get("reason"),
        "blocker": state.get("blocker"),
        "execution_intent": state.get("execution_intent"),
        "claimed_ticket": doing[0]["id"] if doing else None,
        "top_workable_ticket": top_workable,
        "log_tail_event": snap.log_tail,
        "head": snap.head,
        "board_errors": board["errors"],
        "recovery_pending": bool(pending),
        "recovery_conflict": bool(conflicts),
        "pending_ops": pending,
        "conflict_ops": conflicts,
    }
    # Restore Milestones are a separate, optional authority domain.  Status
    # reads bounded metadata only; full payload integrity belongs to create,
    # undo and validate, never the common `sss` hot path.
    from saipen_engine.controls import milestone_status

    payload["milestone"] = milestone_status(project_root)
    # T-1319: name the cold route deterministically so skill startup never has
    # to ask the host search layer where the protocol documents are.
    payload["cold_route"] = _cold_route(project_root, state, state_text)

    # T-1249: an agent that boots an INSTALLED copy of the protocol has no way
    # to know how old it is -- the digest needs the clone to compare against,
    # and a consumer machine may not have one. The install time and source head
    # stand on their own, so a copy last refreshed days ago says so here rather
    # than quietly answering from a protocol that has since moved. That was the
    # real incident: an agent read a pre-W4 CORE.md hunting a shortcut table
    # that had been relocated, and nothing told it the copy was behind.
    try:
        from saipen_engine.paths import resolve_protocol_dir

        _home = Path(state.get("saipen_home") or "").expanduser()
        _protocol_dir = resolve_protocol_dir(_home)
        # Flattened skill layout stamps protocol_dir itself; a source tree
        # stamps the repository root one level above it.
        _stamp_path = _protocol_dir / ".saipen_injected"
        if not _stamp_path.is_file():
            _stamp_path = _protocol_dir.parent / ".saipen_injected"
        if _stamp_path.is_file():
            _raw = _stamp_path.read_text(encoding="utf-8-sig").strip()
            _record = json.loads(_raw) if _raw.startswith("{") else {"digest": _raw}
            if isinstance(_record, dict) and _record.get("digest"):
                _copy = {
                    "digest": _record.get("digest"),
                    "installed_at": _record.get("installed_at"),
                    "source_head": _record.get("source_head"),
                }
                _when = _record.get("installed_at")
                if _when:
                    import datetime as _dt

                    try:
                        _age = _dt.datetime.now(_dt.timezone.utc) - _dt.datetime.fromisoformat(
                            _when.replace("Z", "+00:00")
                        )
                        _hours = int(_age.total_seconds() // 3600)
                        _copy["age_hours"] = _hours
                        # The scheduled injector runs every 15 minutes, so a
                        # copy older than a day means it is not running here.
                        _copy["refresh_running"] = _hours < 24
                    except (ValueError, TypeError):
                        _copy["age_hours"] = None
                payload["protocol_copy"] = _copy
    except Exception:
        # A missing or unreadable stamp is the ordinary case on a source-tree
        # install and must never fail a read-only projection.
        pass

    # T-1234: the operator surface names the inbox in counts, never in prose
    # from an audit body. An absent `audit/` renders nothing at all -- a
    # project with no inbox should not grow a permanent empty section.
    try:
        from saipen_engine.audit_inbox import status as audit_inbox_status

        _inbox = audit_inbox_status(project_root)
        _summary = {
            "pending": len(_inbox.get("pending") or []),
            "active_layer": next(
                (
                    item["layer"]
                    for item in _inbox.get("pending") or []
                    if item["state"] == "ACTIVE"
                ),
                None,
            ),
            "bound_receipt": next(
                (
                    item["receipt"]
                    for item in _inbox.get("pending") or []
                    if item["state"] == "ACTIVE"
                ),
                None,
            ),
            "bound_work": next(
                (item["work"] for item in _inbox.get("pending") or [] if item["state"] == "ACTIVE"),
                None,
            ),
            "closed_pending_delete": len(_inbox.get("closed_pending_delete") or []),
            "invalid": len(_inbox.get("invalid") or []),
            "residue": _inbox.get("residue_count", 0),
            "clean": _inbox.get("clean"),
            "last_allocated_id": _inbox.get("last_allocated_id"),
            # SRC-025:R009: an UNSAFE/UNREADABLE inbox is a transport failure
            # and must be visible even with zero discoverable layers, instead
            # of the whole section disappearing and the inbox reading idle.
            "inbox_state": _inbox.get("inbox_state"),
            "error_state": None if _inbox.get("ok") else _inbox.get("code"),
        }
        if (
            _summary["pending"]
            or _summary["residue"]
            or _summary["last_allocated_id"] is not None
            or _summary["error_state"]
        ):
            payload["audit_inbox"] = _summary
    except Exception as exc:
        # The inbox is transport, not terminal truth: a projection failure is
        # reported as a condition, never allowed to hide behind a green status.
        payload["audit_inbox"] = {"error": f"{type(exc).__name__}: {exc}"}

    # T-1271: whether an installed agent home runs current SAIPEN was
    # answerable only by opening a log under LOCALAPPDATA. The stamps and the
    # runner's log already held the answer; nothing surfaced it here. This
    # reads both and writes nothing -- it never stamps, never injects and
    # never triggers a run.
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from autoinject import distribution_line, distribution_report

        _dist = distribution_report()
        if _dist["installed"]:
            _last_run = _dist.get("last_run")
            if _last_run is not None:
                _last_run = {**_last_run, "dirty": _last_run["dirty"][:5]}
            payload["distribution"] = {
                "installed": _dist["installed"],
                "stale": _dist["stale"],
                "unknown": _dist["unknown"],
                "fresh": _dist["fresh"],
                "source_head": _dist["source_head"],
                "newest_installed_head": _dist["newest_installed_head"],
                # T-1371: provenance, not the current verdict. The newest
                # scheduled run may have skipped on a dirty surface; that is
                # history, and `fresh` above is decided by current bytes only.
                "last_run": _last_run,
                # T-1454: the CURRENT blocking condition and the exact command
                # that clears it. Without it a stale home reads as bad luck,
                # and the repairs that cannot reach it read as missing.
                "blocker": _dist.get("blocker"),
                "summary": distribution_line(_dist),
            }
    except Exception as exc:
        # Distribution is an observation, not terminal truth: a projection
        # failure is reported as a condition, never allowed to hide behind a
        # green status.
        payload["distribution"] = {"error": f"{type(exc).__name__}: {exc}"}

    parked = _parked_work(board["tickets"], state)
    if parked:
        payload["parked_work"] = parked
    if _operator_gates:
        payload["operator_gates"] = _operator_gates
    if waiting_on_you:
        payload["waiting_on_you"] = waiting_on_you
    if _owed.get("owed"):
        # The machine-readable half: digest, byte count, preview, how long it
        # still stands, and both discharge routes. Discoverable WITHOUT
        # attempting the ingress it would refuse.
        payload["pending_ingress"] = _owed
    # SRC-104 / T-1461: an operational append is mission state, so status shows
    # it -- latest append, active/superseded requirements, anything received
    # but not yet projected, the Work it touched and the exact next action --
    # instead of burying it in LOG. Read-only; a broken ledger is reported,
    # never fatal to status.
    try:
        from saipen_engine.source_append import append_status as _append_status

        _append_missions = _append_status(project_root).get("missions") or []
    except Exception as _append_exc:  # status must survive metadata faults
        payload["appends_error"] = f"{type(_append_exc).__name__}: {_append_exc}"
    else:
        if _append_missions:
            payload["appends"] = _append_missions
    if claimed_but_unproven:
        payload["claimed_but_unproven"] = claimed_but_unproven
    if conformance is not None:
        payload["conformance"] = conformance
    if staleness is not None:
        payload["staleness"] = staleness

    # §8 Conformance Closure: the authoritative current-conformance status,
    # derived from the canonical validator receipt, not from prose in the LOG.
    # `conformance` (above) is the legacy history-derived hint; this is the
    # load-bearing truth that gates terminal/crew closure. T-1412: it is read
    # through the shared decision owner, the SAME projection `saipen validate`
    # and the router consume.
    try:
        from saipen_engine.conformance import conformance_decision

        # SRC-085 M3: the machine-readable conformance disposition travels with
        # the authoritative status block, so a consumer never has to decide by
        # prose whether CURRENT_FAIL may coexist with a continuation route.
        _conf_decision = conformance_decision(project_root, gate="core")
        payload["conformance_status"] = {
            **_conf_decision["status_block"],
            "disposition": _conf_decision["disposition"],
            "remediation_command": _conf_decision["remediation_command"],
            "repair_status": _conf_decision["repair_status"],
            "diagnostic": _conf_decision["diagnostic"],
        }
    except Exception as exc:
        # Conformance is load-bearing terminal truth.  A projection may never
        # report ok:true while silently omitting it because evidence decoding
        # failed unexpectedly.
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"conformance-status: {type(exc).__name__}: {exc}",
            },
            as_json,
        )
        return 1

    # SRC-021 R2: the read-only Run-to-Closure automation block. Classified
    # from the SAME evidence this projection already holds (parsed state and
    # board, the route verdict, history events, the audit inbox status), so
    # it can never contradict the fields beside it. R3: its next_command is
    # machine authority, never the human-printed marker or any prose.
    try:
        from saipen_engine.automation import automation_block, failed_automation_block
        from saipen_engine.audit_inbox import status as _audit_inbox_status

        try:
            _audit_status = _audit_inbox_status(project_root)
        except Exception:
            _audit_status = None
        try:
            from saipen_engine.convergence import convergence_verdict

            _convergence = convergence_verdict(project_root).as_dict()
        except Exception:
            _convergence = None
        _source_identity = None
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from freshness import compute_source_identity as _csi_auto

            _source_identity = _csi_auto(project_root)
        except Exception:
            _source_identity = None
        payload["automation"] = automation_block(
            project_root,
            state=state,
            board=board,
            routed=routed,
            history_events=history_events,
            audit_status=_audit_status,
            convergence=_convergence,
            source_identity=_source_identity,
            agent=resolved_agent,
        )
    except Exception as exc:
        # R3 fail-closed: a projection that cannot be assembled is INVALID,
        # never a healthy-looking block or a missing field.
        payload["automation"] = failed_automation_block(
            "automation-projection-failed", f"{type(exc).__name__}: {exc}"
        )

    _emit(payload, as_json)
    return 0


def _is_idle_maintain_route(routed: dict, board: dict) -> bool:
    """Is the routed action the genuine idle terminal (nothing actionable)?

    The router emits `action: "saipen continue"` with `reason: "maintain"`
    exactly when no pending recovery, no active DOING ticket, and no
    workable TODO remains.  That verdict -- not a board glance -- is the
    required proof that recovery/queued/follow-up routing is exhausted, so
    the improvement fallback may run.  Every other routed action (a PHASE,
    a WAIT, `saipen recover`, a crew/ship continuation, a failed route)
    means real work or a real stop exists and must outrank discovery.
    """
    if not routed.get("ok"):
        return False
    if routed.get("action") != "saipen continue":
        return False
    return routed.get("reason") == "maintain"


def _continue_improve_fallthrough(
    project_root: Path,
    as_json: bool,
    dry_run: bool,
    routed: dict,
    parked: list,
    pending: list,
    reconciliation: dict | None,
    *,
    chain_trace: list | None = None,
    iterations: int = 0,
) -> int:
    """T-20260830_0842: one bounded fallthrough `continue` -> `improve`.

    Fires only for the idle-maintain route (nothing actionable), runs the
    bare `saipen improve` PREPARE step once, and emits the resulting audit
    assignment (or a clean idle verdict). The anti-loop guarantee is:
      - ONE invocation per `continue` call (this branch runs once);
      - NO recursion back into `continue`;
      - a marker names the prepared cycle, and `improve` itself resumes an
        already-active cycle instead of preparing a duplicate;
      - read-only / dry-run sessions do not write: the fallback projects the
        prepare plan or refuses exactly as `improve` would.

    T-1416: when the bounded executor drove a deterministic chain to this
    terminal boundary, its trace and iteration count ride along on whichever
    outcome is emitted, so the machine-readable answer covers the whole
    invocation.
    """

    def _emit_result(payload: dict) -> None:
        if chain_trace:
            payload = {
                **payload,
                "continue_trace": chain_trace,
                "iterations": iterations,
                "stop_reason": "idle",
            }
        _emit(payload, as_json)
    from saipen_engine.continue_fallback import (
        active_cycle_status,
        read_marker,
        write_marker,
    )

    marker = read_marker(project_root)
    prior_cycle = marker.get("cycle_id") or ""
    if prior_cycle:
        status = active_cycle_status(project_root, prior_cycle)
        # T-1434 M4: every terminal lifecycle status frees a fresh discovery;
        # only `active` is "in flight".
        if status not in ("", "complete", "archived", "superseded", "blocked_external"):
            # The improvement discovery is already in flight (an active cycle
            # was prepared by a prior `continue`). Resume is `improve`'s own
            # semantics; re-preparing here would duplicate. Emit the resume
            # point rather than a second discovery.
            _emit_result(
                {
                    "ok": True,
                    "code": "CONTINUE_IMPROVE_IN_FLIGHT",
                    "cycle_id": prior_cycle,
                    "action": "saipen improve",
                    "reason": "improve-in-flight",
                    "dry_run": bool(dry_run),
                    "detail": (
                        "improvement discovery cycle "
                        f"{prior_cycle} is already active; resume it "
                        "(saipen improve) instead of preparing a duplicate"
                    ),
                }
            )
            return 0

    import contextlib as _ctxlib
    import io as _io

    _buf = _io.StringIO()
    with _ctxlib.redirect_stdout(_buf):
        rc = _public_improve(project_root, [], as_json, dry_run)
    raw = _buf.getvalue()
    prepared: dict = {}
    if as_json and raw.strip():
        try:
            prepared = json.loads(raw.strip())
        except ValueError:
            prepared = {}
    if rc == 0 and prepared and prepared.get("ok"):
        cycle_id = prepared.get("cycle_id") or prior_cycle
        if cycle_id:
            write_marker(project_root, cycle_id, _agent_for(project_root))
        # Replay the captured result unchanged -- the fallback outcome is the
        # improve outcome.
        if as_json and prepared:
            _emit_result(prepared)
        elif raw:
            print(raw, end="")
        return rc
    # A recovery-class improve refusal is a real blocker, not an idle
    # verdict: the fallback must never mask pending/conflict/corrupt
    # recovery as "no worthwhile improvement" (acceptance #14).
    _rec_code = prepared.get("code") or ""
    if _rec_code in (
        "RECOVERY_REQUIRED",
        "RECOVERY_CONFLICT",
        "CORRUPT_JOURNAL",
        "WRITER_BUSY",
    ):
        if as_json and prepared:
            _emit_result(prepared)
        elif raw:
            print(raw, end="")
        return 1
    # W3B.11: only a genuine NO_WORTHWHILE_IMPROVEMENT outcome from the
    # improve prepare step may become CONTINUE_IDLE.  All other non-recovery
    # failures (ambiguity, validation, manifest corruption, ImproveError,
    # permission, corrupt state) are structured refusals that propagate
    # as-is -- never mapped to idle.
    _imp_code = prepared.get("code") if prepared else ""
    if _imp_code == "NO_WORTHWHILE_IMPROVEMENT":
        if as_json:
            _emit_result(
                {
                    "ok": True,
                    "code": "CONTINUE_IDLE",
                    "detail": "no worthwhile improvement discovered",
                }
            )
        else:
            _emit_result({"ok": True, "code": "CONTINUE_IDLE"})
        return 0
    # Non-recovery structured failure: propagate the improve refusal as-is
    # so ambiguity, validation, manifest, permission and corrupt-state
    # failures are surfaced, never masked as idle.
    if as_json and prepared:
        _emit_result(prepared)
    elif raw:
        print(raw, end="")
    return 1


def _route_once(project_root: Path) -> dict:
    """ONE read-only route computation, shared by `next` and the chain (T-1416).

    Returns either a terminal `emitted` payload with its exit code, or the
    live snapshot pieces the continuation executor drives from. This is the
    same computation `_next_action` always performed; extracting it is what
    lets the bounded executor re-route on CURRENT bytes after every committed
    operation instead of trusting a stale multi-step plan.
    """
    from saipen_engine.state import parse_state_or_error

    state_path = _state_path(project_root)
    if not state_path.is_file():
        return {"emitted": {"ok": False, "code": "NOT_SAIPEN_PROJECT"}, "rc": 3}
    # T-1014: ONE recovery-manifest traversal (pending + conflicts + corrupt).
    pending, conflicts, _corrupt = _scan_full(project_root)
    if _corrupt:
        return {"emitted": _corrupt_refusal(_corrupt), "rc": 1}
    try:
        snap = snapshot.ProjectSnapshot.capture(project_root, lean=True)
    except (OSError, ValueError) as exc:
        return {
            "emitted": {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"history-ownership: {exc}",
            },
            "rc": 1,
        }
    state_text = snap.state_text
    board_text = snap.board_text
    state, state_error = parse_state_or_error(state_text)
    if state_error:
        return {
            "emitted": {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"state-malformed: {state_error}",
            },
            "rc": 1,
        }
    subject = state.get("task")
    board = parse_board(board_text)
    parked = _parked_work(board["tickets"], state)
    from saipen_engine.router import (
        audit_inbox_projection,
        pending_append_projection,
        queued_source_projection,
        route_next,
        routing_failure_code,
    )

    # P0#4: the freshly negotiated current-session capability gates routing.
    # T-1006: routing judges claim truth against the canonical acting seat.
    resolved_agent = (
        _AGENT_OVERRIDE if _AGENT_OVERRIDE is not None else (state.get("agent") or AGENT)
    )
    routed = route_next(
        state_text,
        board_text,
        pending,
        conflicts,
        current_capability=_negotiate_capability(project_root),
        current_agent=resolved_agent,
        snap=snap,
        audit_inbox=audit_inbox_projection(project_root),
        queued_source=queued_source_projection(project_root),
        pending_append=pending_append_projection(project_root),
    )
    # T-1412 + T-1403 + SRC-085 M3: the SAME ordered gate chain the Result
    # wrapper applies, so `continue` can never hand out a route another surface
    # provably refuses. One owner: `router.gate_route`.
    from saipen_engine.router import gate_route

    _gated = gate_route(project_root, routed)
    if _gated is not None:
        routed = _gated
    route = {
        "emitted": None,
        "rc": 0,
        "subject": subject,
        "state": state,
        "state_text": state_text,
        "board": board,
        "board_text": board_text,
        "parked": parked,
        "pending": pending,
        "conflicts": conflicts,
        "routed": routed,
    }
    if not routed.get("ok"):
        # The router owns the stable failure code: recovery conflicts/pending
        # are RECOVERY_*; malformed/binding failures are VALIDATION_FAILED
        # with recovery_pending strictly false (there is no journal to
        # recover -- T-1003 hostile findings). T-1412: a refusal the router
        # itself classified (e.g. CONFORMANCE_UNHEALTHY) keeps ITS code and
        # route instead of being re-derived here.
        emitted = {
            "ok": False,
            "code": routed.get("code") or routing_failure_code(routed),
            "action": routed.get("action"),
            "reason": routed.get("reason"),
            "detail": routed.get("detail", ""),
            "recovery_pending": bool(pending),
            "recovery_conflict": bool(conflicts),
            "conflict_ops": conflicts,
            "pending_ops": pending,
            "parked_work": parked or None,
        }
        for key in ("conformance_status", "canonical_next_command", "remediation",
                    "diagnostic", "repair_status", "terminal"):
            if key in routed:
                emitted[key] = routed[key]
        route["emitted"] = emitted
        route["rc"] = 1
    return route


def _turn_entry_telegrams(project_root: Path, state: dict) -> dict:
    """The turn-entry telegram read (T-1497); a failure is a state, never a raise."""
    try:
        from saipen_engine.telegrams import turn_entry

        return turn_entry(project_root, state)
    except Exception as exc:  # the read must never fail `continue`
        return {"state": "ERROR", "detail": f"turn-entry telegram read failed: {exc}"[:300]}


def _route_payload(
    project_root: Path,
    route: dict,
    *,
    reconciliation: dict | None,
    dry_run: bool,
    kind: str | None = None,
) -> dict:
    """The public route projection for one computed route."""
    from saipen_engine.router import load_for_action

    routed = route["routed"]
    state = route["state"]
    state_text = route["state_text"]
    subject = route["subject"]
    load = load_for_action(routed.get("action"))
    cold_route = _cold_route(project_root, state, state_text)
    protocol_dir = cold_route.get("protocol_dir")
    load_path = (
        str(Path(protocol_dir) / load.removeprefix("saipen/")) if protocol_dir and load else None
    )
    payload = {
        "ok": True,
        "action": routed.get("action"),
        "ticket": routed.get("ticket") or subject,
        "reason": routed.get("reason"),
        "detail": routed.get("detail") or None,
        "executable_behavior": routed.get("executable_behavior"),
        "load": load,
        "load_path": load_path,
        "cold_route": cold_route,
        "execution_instruction": (
            "Routing is not completion evidence. Read load_path when present, "
            "then execute action under its owner in this turn; respect WAIT and "
            "actual refusals. If --dry-run was requested, this is a preview only."
        ),
        "execution_intent": state.get("execution_intent") or "normal",
        "converge_target": state.get("converge_target"),
        "goal_waves": state.get("goal_waves"),
        "goal_tickets": state.get("goal_tickets"),
        "recovery_pending": bool(route["pending"]),
        "recovery_conflict": False,
        "pending_ops": route["pending"],
        "parked_work": route["parked"] or None,
        "reconciliation": reconciliation,
    }
    if dry_run and kind is not None:
        from saipen_engine import continue_loop

        if kind == continue_loop.FINISH_AT_SHIP:
            ticket = str((routed.get("ticket") or subject) or "")
            payload["projected_steps"] = [
                {
                    "step": 1,
                    "action": f"saipen ticket done {ticket} --closure-mode own_patch",
                    "condition": "the finish gate stays green on current bytes",
                }
            ]
            payload["projection_ends_at"] = (
                "after that closure, the next route depends on bytes the "
                "execution would create; projection ends there"
            )
        elif kind == continue_loop.IDLE_MAINTAIN:
            payload["projected_steps"] = [
                {
                    "step": 1,
                    "action": "saipen improve",
                    "condition": "the idle-maintain route is still the route",
                }
            ]
            payload["projection_ends_at"] = (
                "improvement discovery depends on bytes it would create; projection ends there"
            )
    return payload


def _continue_chain(
    project_root: Path,
    as_json: bool,
    first_route: dict,
    *,
    reconciliation: dict | None,
) -> int:
    """Drive deterministic canonical operations until a real boundary (T-1416).

    Every iteration re-routes from CURRENT bytes after the previous operation
    commits; nothing here trusts a stale plan. Only `continue_loop`'s closed
    action vocabulary may execute, and executing anything at all is bounded by
    a hard iteration budget plus a fixed-point witness. The loop holds no
    authority of its own: each step is the same journaled canonical operation
    the model would have run.
    """
    from saipen_engine import continue_loop
    from saipen_engine.operations import apply_claim, finish_ticket

    agent = _agent_for(project_root)
    trace: list[dict] = []
    iterations = 0
    route = first_route
    seen = {continue_loop.state_identity(route["state"], route["board_text"])}
    while True:
        routed = route["routed"]
        state = route["state"]
        board = route["board"]
        kind = continue_loop.classify_route(routed, state, board)
        if kind in (continue_loop.FINISH_AT_SHIP, continue_loop.ADOPT, continue_loop.APPLY_APPEND):
            before_event = state.get("last_event")
            if kind == continue_loop.APPLY_APPEND:
                from saipen_engine.source_append import apply_append

                ticket = routed.get("ticket")
                outcome = apply_append(project_root, str(routed.get("receipt")), actor=agent)
                step_ok, step_code, failure_payload = (
                    bool(outcome.get("ok")), str(outcome.get("code")), outcome
                )
                operation_name = "apply_append"
            else:
                doing = next(
                    t for t in board["tickets"].values() if t["section"] == "## DOING"
                )
                ticket = doing["id"]
                if kind == continue_loop.FINISH_AT_SHIP:
                    result = finish_ticket(project_root, ticket, agent)
                    operation_name = "ticket_done"
                else:
                    # T-1436: the resumed parent is UNCLAIMED, so the router's own
                    # adoption action is the next mechanical step. It is the same
                    # canonical claim the model would run; the operation re-checks
                    # ownership and refuses a live foreign claim at apply time.
                    result = apply_claim(project_root, ticket, agent, explicit=True)
                    operation_name = "claim"
                step_ok, step_code, failure_payload = (
                    bool(result.ok), result.code, result.to_dict()
                )
            after_route = _route_once(project_root) if step_ok else None
            trace.append(
                {
                    "iteration": iterations + 1,
                    "action": str(routed.get("action") or ""),
                    "kind": kind,
                    "operation": operation_name,
                    "ticket": ticket,
                    "result": step_code,
                    "ok": step_ok,
                    "before_last_event": before_event,
                    "after_last_event": (
                        after_route["state"].get("last_event") if after_route is not None else None
                    ),
                }
            )
            if not step_ok:
                payload = dict(failure_payload)
                payload.update(
                    {
                        "recovery_pending": bool(route["pending"]),
                        "parked_work": route["parked"] or None,
                        "continue_trace": trace,
                        "iterations": iterations,
                        "stop_reason": "refusal",
                    }
                )
                _emit(payload, as_json)
                return 1
            iterations += 1
            if after_route is None:  # unreachable; keeps the bound explicit
                break
            if iterations >= continue_loop.max_iterations():
                payload = {
                    "ok": True,
                    "code": continue_loop.CONTINUE_BUDGET_EXHAUSTED,
                    "iterations": iterations,
                    "last_operation": trace[-1]["operation"],
                    "canonical_next_action": str(after_route["routed"].get("action") or ""),
                    "continue_trace": trace,
                    "stop_reason": "budget",
                    "detail": (
                        f"the deterministic chain reached the hard "
                        f"{continue_loop.max_iterations()}-iteration bound; no silent "
                        "success was claimed"
                    ),
                }
                _emit(payload, as_json)
                return 0
            route = after_route
            identity = continue_loop.state_identity(route["state"], route["board_text"])
            if identity in seen:
                payload = {
                    "ok": True,
                    "code": continue_loop.CONTINUE_FIXED_POINT,
                    "iterations": iterations,
                    "last_operation": trace[-1]["operation"],
                    "canonical_next_action": str(route["routed"].get("action") or ""),
                    "continue_trace": trace,
                    "stop_reason": "fixed-point",
                    "detail": (
                        "an executed canonical operation left phase, task, last_event "
                        "and BOARD byte-identical and the same action routed again; "
                        "this is a deterministic fixed point / repeated-refusal defect, "
                        "not progress"
                    ),
                }
                _emit(payload, as_json)
                return 0
            seen.add(identity)
            continue
        if kind == continue_loop.IDLE_MAINTAIN:
            # The single bounded Improve fallthrough keeps its existing owner
            # and semantics; the hold from ROOT B gates it when it must, and
            # the chain trace rides along on its outcome.
            return _continue_improve_fallthrough(
                project_root,
                as_json,
                False,
                routed,
                route["parked"],
                route["pending"],
                reconciliation,
                chain_trace=trace,
                iterations=iterations,
            )
        # A gate may refuse only AFTER preceding deterministic steps finish.
        # Preserve that refusal exactly; the ordinary success projection would
        # otherwise turn the final red boundary into ok:true and exit 0.
        payload = dict(route["emitted"]) if route["emitted"] is not None else _route_payload(
            project_root, route, reconciliation=reconciliation, dry_run=False, kind=kind
        )
        payload["continue_trace"] = trace
        payload["iterations"] = iterations
        payload["stop_reason"] = "refusal" if route["emitted"] is not None else "boundary"
        _emit(payload, as_json)
        return route["rc"]


def _next_action(
    project_root: Path,
    as_json: bool,
    *,
    reconciliation: dict | None = None,
    fallthrough_to_improve: bool = False,
    dry_run: bool = False,
) -> int:
    route = _route_once(project_root)
    if route["emitted"] is not None:
        _emit(route["emitted"], as_json)
        return route["rc"]
    from saipen_engine import continue_loop

    kind = continue_loop.classify_route(route["routed"], route["state"], route["board"])
    # T-20260830_0842: the `continue` fallthrough. ONLY `saipen continue`
    # (and its aliases) may fall through to the improvement-discovery path or
    # drive the bounded chain. `saipen next` stays a pure projection and never
    # triggers a mutation. A `--dry-run` is purely observational -- the spec
    # forbids the fallthrough from generating work, and observers must see the
    # same idle-maintain verdict the prior release carried.
    if fallthrough_to_improve and not dry_run and kind in (
        continue_loop.FINISH_AT_SHIP,
        continue_loop.APPLY_APPEND,
    ):
        return _continue_chain(
            project_root,
            as_json,
            route,
            reconciliation=reconciliation,
        )
    if fallthrough_to_improve and not dry_run and kind == continue_loop.IDLE_MAINTAIN:
        return _continue_improve_fallthrough(
            project_root, as_json, dry_run, route["routed"], route["parked"], route["pending"],
            reconciliation,
        )
    _emit(
        _route_payload(
            project_root, route, reconciliation=reconciliation, dry_run=dry_run, kind=kind
        ),
        as_json,
    )
    return 0


def _explain_next(project_root: Path, as_json: bool) -> int:
    """T-1161: read-only decision-trace diagnostic (P2).

    Routes the same next action `next`/`cc` would take, then classifies WHO
    owns it via the closed disposition vocabulary. Makes the no-human-courier
    law inspectable: candidates, selected action, authority, and exactly why
    the human is or is not required. Writes nothing.
    """
    from saipen_engine.disposition import classify_carrier

    state_path = _state_path(project_root)
    if not state_path.is_file():
        _emit({"ok": False, "code": "NOT_SAIPEN_PROJECT"}, as_json)
        return 3
    pending, conflicts, _corrupt = _scan_full(project_root)
    if _corrupt:
        _emit(_corrupt_refusal(_corrupt), as_json)
        return 1
    try:
        snap = snapshot.ProjectSnapshot.capture(project_root, lean=True)
    except (OSError, ValueError) as exc:
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": f"history-ownership: {exc}"},
            as_json,
        )
        return 1
    state_text = snap.state_text
    board_text = snap.board_text
    from saipen_engine.state import parse_state_or_error

    state, state_error = parse_state_or_error(state_text)
    if state_error:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"state-malformed: {state_error}",
            },
            as_json,
        )
        return 1
    from saipen_engine.board import operator_gates, parse_board

    _parsed_board = parse_board(board_text)
    parked = _parked_work(_parsed_board["tickets"], state)
    _gates = operator_gates(_parsed_board["tickets"])
    from saipen_engine.router import (
        audit_inbox_projection,
        gate_route,
        pending_append_projection,
        queued_source_projection,
        route_next,
        routing_failure_code,
    )

    resolved_agent = (
        _AGENT_OVERRIDE if _AGENT_OVERRIDE is not None else (state.get("agent") or AGENT)
    )
    routed = route_next(
        state_text,
        board_text,
        pending,
        conflicts,
        current_capability=_negotiate_capability(project_root),
        current_agent=resolved_agent,
        snap=snap,
        audit_inbox=audit_inbox_projection(project_root),
        queued_source=queued_source_projection(project_root),
        pending_append=pending_append_projection(project_root),
    )
    # Explain the executable route, including the same conformance and closure
    # gates used by status/next/continue. A raw route can name a refused action.
    gated = gate_route(project_root, routed)
    if gated is not None:
        routed = gated
    if not routed.get("ok"):
        carrier = {
            "code": routing_failure_code(routed),
            "action": routed.get("action"),
            "reason": routed.get("reason"),
            "next_action": routed.get("action"),
            "canonical_next_command": routed.get("canonical_next_command"),
            "recovery_pending": bool(pending),
            "terminal": bool(routed.get("terminal")),
            "diagnostic": routed.get("diagnostic"),
        }
    else:
        carrier = {
            "ok": True,
            "code": "ROUTED",
            "action": routed.get("action"),
            "reason": routed.get("reason"),
            "next_action": routed.get("action"),
            "terminal": False,
            "requires_human": bool(routed.get("requires_human")),
            "execute_in_current_agent": True,
        }
    verdict = classify_carrier(carrier)
    payload = {
        "ok": True,
        "code": "EXPLAIN_NEXT",
        "state": {
            "phase": state.get("phase"),
            "task": state.get("task"),
            "execution_intent": state.get("execution_intent") or "normal",
            "converge_target": state.get("converge_target"),
        },
        "carrier": {k: v for k, v in carrier.items() if v is not None},
        "disposition": verdict["disposition"],
        "owner": "user" if verdict["requires_human"] else "agent",
        "human_required": verdict["requires_human"],
        "why": verdict["reason"],
        "selected_action": verdict["action"],
        "parked_work": parked or None,
        "operator_gates": _gates or None,
        "note": (
            "internal sequencing alternatives never create a human decision; "
            "WAIT_USER requires human-owned information or authority"
        ),
    }
    _emit(payload, as_json)
    return 0


def _recover(project_root: Path, args: list[str], as_json: bool, dry_run: bool = False) -> int:
    args = list(args)
    adopt_legacy: list[str] = []
    attest_legacy_done: list[str] = []
    resolve_blocker: str | None = None
    resolve_next_action: str | None = None
    approved_repair_id: str | None = None
    migrate_generation = False
    normalize_log_requested = False
    # T-1382: the OPERATOR'S duplicate-id decision, carried as content-bound
    # record digests. `--resolve-duplicate-id <T-###>` names the duplicated
    # identity; `--keep` / `--reassign` name the two records by their digest.
    # Line numbers are deliberately not an option: they move, and a decision
    # that could be aimed at a different row is worse than no decision.
    duplicate_id_ticket: str | None = None
    keep_record_digest: str | None = None
    reassign_record_digest: str | None = None

    def _refuse(detail: str) -> int:
        _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": detail}, as_json)
        return 2

    # Target B/E/C repair-control plane: `recover` owns the exact-match,
    # bounded-argument forms that stay reachable while ordinary work is blocked.
    # Closed grammar (hostile-regression rule): every token is consumed by a
    # known flag or the invocation is refused -- no shell tails, no surplus
    # tokens, no substring matching. The two flags may be combined so a single
    # idempotent pass can repair a multi-defect braked surface.
    #
    #   --adopt-legacy <T-###[,T-###...]>       Target E (legacy BOARD adoption)
    #   --attest-legacy-done <T-###[,T-###...]> legacy terminal completion
    #   resolve-blocker "<decision>"            Target C (operator-gated blocker)
    #   --resolve-duplicate-id <T-###>
    #       --keep <digest> --reassign <digest> T-1382 (duplicate identity)
    #
    # `--resolve-duplicate-id` carries the OPERATOR'S answer to a duplicated
    # BOARD identity: which of the two records keeps the ticket id, named by the
    # record's own digest. It is a targeted repair and combines with nothing.
    #
    # `--attest-legacy-done` is the operator's answer to a `legacy-done-review`
    # refusal: a `## DONE` record older than this project's closure contract,
    # with no execution evidence in either generation's grammar. It writes ONE
    # NOW-dated DEC recording that the historical completion stands. It
    # fabricates no `closure_mode` for a generation that had none and rewrites
    # no historical LOG line.
    #
    # `resolve-blocker` is NOT a generic unblock: it requires non-empty decision
    # text, owns ONLY an ACTIVE-phase STATE.blocker, records the authority in the
    # LOG, and archives the original bytes. `inspect <op_id>` / `resolve <op_id>`
    # / bare are handled further down.
    rest: list[str] = []
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--adopt-legacy":
            if index + 1 >= len(args):
                return _refuse(
                    "usage: recover --adopt-legacy <T-###[,T-###...]> (missing id list)"
                )
            ids = [t.strip() for t in args[index + 1].split(",") if t.strip()]
            if not ids or any(re.fullmatch(r"T-\d+", t) is None for t in ids):
                return _refuse(
                    "recover --adopt-legacy ids must be T-### (digits), "
                    "comma-separated when several"
                )
            adopt_legacy = list(dict.fromkeys(ids))
            index += 2
            continue
        if token == "--attest-legacy-done":
            if index + 1 >= len(args):
                return _refuse(
                    "usage: recover --attest-legacy-done <T-###[,T-###...]> "
                    "(missing id list)"
                )
            ids = [t.strip() for t in args[index + 1].split(",") if t.strip()]
            if not ids or any(re.fullmatch(r"T-\d+", t) is None for t in ids):
                return _refuse(
                    "recover --attest-legacy-done ids must be T-### (digits), "
                    "comma-separated when several"
                )
            attest_legacy_done = list(dict.fromkeys(ids))
            index += 2
            continue
        if token == "--migrate-generation":
            # T-1352: the exit for a project whose declared protocol major has
            # fallen behind every home that exists. `_candidate_home_errors`
            # refuses each candidate on that comparison, so without this the
            # only escape is editing a protected canonical file by hand.
            # It takes no argument: the generation is READ from the bound
            # home, never supplied, so nobody can name a generation the
            # install does not actually carry.
            migrate_generation = True
            index += 1
            continue
        if token == "normalize-log":
            # T-1356: the exit for a LOG whose line syntax refuses every
            # mutation, including the sanctioned repair that would fix it.
            # It takes no argument: the repairs are READ from the file, never
            # supplied, so nobody can name a line the LOG does not carry.
            normalize_log_requested = True
            index += 1
            continue
        if token == "--resolve-duplicate-id":
            if index + 1 >= len(args):
                return _refuse(
                    "usage: recover --resolve-duplicate-id <T-###> "
                    "--keep <digest> --reassign <digest> (missing ticket id)"
                )
            candidate = args[index + 1].strip()
            if re.fullmatch(r"T-\d+", candidate) is None:
                return _refuse(
                    "recover --resolve-duplicate-id requires the duplicated "
                    "ticket id (T-###), exactly as `saipen recover` printed it"
                )
            duplicate_id_ticket = candidate
            index += 2
            continue
        if token in ("--keep", "--reassign"):
            if index + 1 >= len(args):
                return _refuse(
                    f"usage: recover {token} <64-hex record digest> (missing digest)"
                )
            candidate = args[index + 1].strip().lower()
            if re.fullmatch(r"[0-9a-f]{64}", candidate) is None:
                return _refuse(
                    f"recover {token} takes the 64-hex record digest printed by "
                    "`saipen recover`, not a line number -- a line number moves "
                    "and cannot address a record"
                )
            if token == "--keep":
                keep_record_digest = candidate
            else:
                reassign_record_digest = candidate
            index += 2
            continue
        if token == "--apply-approved-repair":
            if index + 1 >= len(args):
                return _refuse(
                    "usage: recover --apply-approved-repair <repair_id> (missing id)"
                )
            candidate = args[index + 1].strip()
            if re.fullmatch(r"[0-9a-f]{64}", candidate) is None:
                return _refuse(
                    "recover --apply-approved-repair requires the 64-hex repair id "
                    "printed by a prior `saipen recover` plan"
                )
            approved_repair_id = candidate
            index += 2
            continue
        if token == "resolve-next-action":
            # T-1358: the operator gate for a `next_action` the router cannot
            # project. Same shape as `resolve-blocker` and for the same reason:
            # tokens up to the next flag, unquoted, because a quote character
            # disqualifies the whole line from the canonical grammar.
            words: list[str] = []
            index += 1
            # A real flag ends the decision; a BARE `--` does not. The
            # canonical WAIT grammar is `WAIT: <category> -- <text>`, so
            # treating the separator as a flag boundary made every legal WAIT
            # value unsuppliable and dropped the rest of the line, `--json`
            # included, into the unknown-argument refusal.
            while index < len(args) and not (
                args[index].startswith("--") and len(args[index]) > 2
            ):
                words.append(args[index])
                index += 1
            proposed = " ".join(words).strip()
            if not proposed:
                return _refuse(
                    "recover resolve-next-action requires the next_action to set; "
                    "usage: saipen [--json] recover resolve-next-action "
                    "<next-action words>. The decision runs to the end of the "
                    "line, so global flags go BEFORE it -- a WAIT value carries a "
                    "bare -- separator, which ends flag parsing. The operator "
                    "decides the VALUE, and the engine still checks it against "
                    "the executable grammar"
                )
            resolve_next_action = proposed
            continue
        if token == "resolve-blocker":
            # T-1357: the decision is every following token up to the next
            # flag, joined by single spaces -- NOT one quoted argument. The
            # guard's canonical grammar refuses any command containing a quote
            # character, deliberately, because quoting is how a compound
            # expression hides inside one that looks canonical. So the engine's
            # own `saipen recover resolve-blocker "<decision>"` could never
            # classify as a canonical operation: it became an ordinary shell
            # effect and was refused under the very invalid state it was
            # printed to repair. Widening the grammar would reopen that hole;
            # the command fits the grammar instead.
            words: list[str] = []
            index += 1
            # A real flag ends the decision; a BARE `--` does not. The
            # canonical WAIT grammar is `WAIT: <category> -- <text>`, so
            # treating the separator as a flag boundary made every legal WAIT
            # value unsuppliable and dropped the rest of the line, `--json`
            # included, into the unknown-argument refusal.
            while index < len(args) and not (
                args[index].startswith("--") and len(args[index]) > 2
            ):
                words.append(args[index])
                index += 1
            decision = " ".join(words).strip()
            if not decision:
                return _refuse(
                    "recover resolve-blocker requires non-empty decision/authority "
                    "text; usage: recover resolve-blocker <decision words>. There "
                    "is no generic unblock-anything path, and no quoting: a quote "
                    "character disqualifies the whole line from the canonical "
                    "grammar the guard admits"
                )
            resolve_blocker = decision
            continue
        rest.append(token)
        index += 1
    args = rest
    if args and args[0] not in ("inspect", "resolve"):
        # Closed grammar: no unknown/surplus token is silently treated as a bare
        # `recover`. `inspect` and `resolve` carry their own arity checks below.
        return _refuse(
            f"unknown recover argument(s) {args!r}; usage: recover "
            '[--adopt-legacy <T-###[,T-###...]>] '
            '[--attest-legacy-done <T-###[,T-###...]>] '
            "[--resolve-duplicate-id <T-###> --keep <digest> --reassign <digest>] "
            "[--migrate-generation] "
            "[normalize-log] "
            "[resolve-blocker <decision>] "
            "[resolve-next-action <next-action>] "
            "[--apply-approved-repair <repair_id>] "
            "| recover inspect <op_id> | recover resolve <op_id> [--resolution <mode>]"
        )
    if keep_record_digest or reassign_record_digest:
        if duplicate_id_ticket is None:
            return _refuse(
                "--keep/--reassign carry a duplicate-id DECISION and mean nothing "
                "without `--resolve-duplicate-id <T-###>`; the exact command for "
                "each choice is printed as `duplicate_id_decision.choices`"
            )
    if duplicate_id_ticket is not None:
        # T-1382: a targeted repair, not a journal replay, and it combines with
        # nothing -- exactly like `normalize-log` and `--migrate-generation`.
        # It runs BEFORE the plan machinery for the same reason: the operator's
        # decision is about the bytes on disk now, and the plan machinery would
        # need the very duplicate it resolves to be addressable first.
        if (
            keep_record_digest is None
            or reassign_record_digest is None
            or normalize_log_requested
            or migrate_generation
            or adopt_legacy
            or attest_legacy_done
            or resolve_blocker
            or resolve_next_action
            or approved_repair_id
        ):
            return _refuse(
                "recover --resolve-duplicate-id takes exactly "
                "`--keep <digest> --reassign <digest>` and combines with nothing "
                "else; run the other decisions in their own pass"
            )
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        from saipen_engine.reconcile import resolve_duplicate_id

        resolved = resolve_duplicate_id(
            project_root,
            _agent_for(project_root),
            duplicate_id_ticket,
            keep_record_digest,
            reassign_record_digest,
            dry_run=dry_run,
        )
        _emit(resolved, as_json)
        return 0 if resolved.get("ok") else 1
    if normalize_log_requested:
        # T-1356: a targeted repair, not a journal replay. It runs before the
        # pending-operation machinery for the same reason `--migrate-generation`
        # does -- that machinery reads the LOG this repair exists to make
        # readable -- and combines with nothing.
        if args or migrate_generation:
            return _refuse(
                "recover normalize-log takes no other argument; it reads the "
                "repairs from the LOG itself"
            )
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        from saipen_engine.operations import normalize_log

        normalized = normalize_log(project_root, _agent_for(project_root), dry_run=dry_run)
        _emit(normalized.to_dict(), as_json)
        return 0 if normalized.ok else 1
    if migrate_generation:
        # T-1352: a targeted repair, not a journal replay, so it runs before
        # the pending-operation machinery and combines with nothing.
        if args:
            return _refuse(
                "recover --migrate-generation takes no other argument; it reads "
                "the generation from the bound home"
            )
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        from saipen_engine.operations import migrate_saipen_generation

        migrated = migrate_saipen_generation(
            project_root, _agent_for(project_root), dry_run=dry_run
        )
        _emit(migrated.to_dict(), as_json)
        return 0 if migrated.ok else 1
    # `saipen recover inspect <op_id>` -- read-only conflict inspection.
    # Closed grammar: exactly one positional <op_id> (hostile-regression, P0#1).
    if args and args[0] == "inspect":
        if len(args) != 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "recover inspect requires exactly <op_id>",
                },
                as_json,
            )
            return 2
        from saipen_engine.journal import inspect_op

        result = inspect_op(project_root, args[1])
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    # `saipen recover resolve <op_id> [--resolution accept_live|replan]` --
    # the explicit conflict-resolution lifecycle (NITRO dogfood III, T-594).
    # Closed grammar (hostile-regression, P0#1): exactly `<op_id>` OR
    # `<op_id> --resolution <accept_live|replan>`. Unknown/surplus tokens and a
    # missing/unknown --resolution value are refused here; resolve_conflict is
    # NEVER called with a defaulted accept_live from malformed input.
    if args and args[0] == "resolve":
        rest = args[1:]
        if len(rest) == 0:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "recover resolve needs <op_id>",
                },
                as_json,
            )
            return 2
        op_id = rest[0]
        extra = rest[1:]
        resolution = "accept_live"
        if extra:
            if extra[0] == "--resolution":
                if len(extra) != 2:
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "usage: recover resolve <op_id> "
                            "--resolution <accept_live|replan>",
                        },
                        as_json,
                    )
                    return 2
                if extra[1] not in ("accept_live", "replan"):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": f"unknown resolution {extra[1]!r}; use accept_live|replan",
                        },
                        as_json,
                    )
                    return 2
                resolution = extra[1]
            else:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unexpected token {extra[0]!r}; usage: "
                        "recover resolve <op_id> "
                        "[--resolution <accept_live|replan>]",
                    },
                    as_json,
                )
                return 2
        from saipen_engine.journal import resolve_conflict

        if dry_run:
            _emit(
                {
                    "ok": False,
                    "code": "DRY_RUN_UNSUPPORTED",
                    "detail": "dry_run not supported for recovery mutations",
                },
                as_json,
            )
            return 1
        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run=False)
        if _ho is not None:
            return _ho
        result = resolve_conflict(project_root, op_id, resolution, agent=_agent_for(project_root))
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    # W2-001/W2-002 (audit fdc73e06): bare recovery is a MUTATION with a
    # closed grammar. Any non-empty argument list that is not exactly
    # `inspect <op_id>` / `resolve <op_id> ...` is VALIDATION_FAILED with
    # zero writes -- a stray token must never silently authorize replay.
    if args and args[0] not in ("inspect", "resolve"):
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "recover takes no arguments (bare recover), or "
                "`inspect <op_id>` / `resolve <op_id> [--resolution "
                "accept_live|replan]`; unexpected: " + " ".join(args),
            },
            as_json,
        )
        return 2
    pending, _conflicts, _corrupt = _scan_full(project_root)
    # CORE-003: corrupt recovery evidence checked FIRST, before conflicts
    # (hostile-regression, P1#6): a scan_pending record marked corrupt:true --
    # e.g. a symlinked OPS_DIR or an unreadable entry -- must never be replayed
    # as a normal op_id (which surfaced a generic VALIDATION_FAILED). The
    # STRUCTURED record survives to the refusal via the ONE shared payload every
    # projection uses (already scanned above by `_scan_full`, T-1014).
    if _corrupt:
        _emit(_corrupt_refusal(_corrupt), as_json)
        return 1
    if not pending:
        # CLEAN is a statement about the whole recovery responsibility, not
        # merely the absence of an interrupted journal. Reconcile the
        # machine-owned checkpoint surface before claiming it. This closes
        # the old contract hole where `recover: CLEAN` was immediately
        # followed by `continue: VALIDATION_FAILED`.
        from saipen_engine.reconcile import reconcile_protocol_state

        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        reconciliation = reconcile_protocol_state(
            project_root,
            _agent_for(project_root),
            dry_run=dry_run,
            adopt_legacy=adopt_legacy,
            attest_legacy_done=attest_legacy_done,
            resolve_blocker=resolve_blocker,
            resolve_next_action=resolve_next_action,
            approved_repair_id=approved_repair_id,
        )
        _emit(reconciliation, as_json)
        return 0 if reconciliation.get("ok") else 1
    # CORE-002 (audit fdc73e06): a bare `recover --dry-run` is a recovery
    # PLAN, not a refusal. The pending op set has already been gathered; the
    # dry-run path returns the planned replay targets so the caller can
    # inspect what recovery would commit without holding the writer lock or
    # writing canonical bytes. The old `DRY_RUN_UNSUPPORTED` early-return hid
    # the plan and made dry-run observationally different from a real replay.
    if dry_run:
        from saipen_engine.journal import decode_operation_record

        plan_ops = []
        for op_id in pending:
            record, err = decode_operation_record(
                project_root, project_root / ".saipen" / "recovery" / "ops" / op_id
            )
            if not err:
                plan_ops.append(
                    {
                        "op_id": op_id,
                        "operation": record.get("operation"),
                        "stage": record.get("status"),
                        "targets": [
                            t.get("path") for t in record.get("targets", []) if isinstance(t, dict)
                        ],
                    }
                )
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "recover",
                "pending_ops": pending,
                "plan": plan_ops,
                "adopt_legacy": adopt_legacy,
                "attest_legacy_done": attest_legacy_done,
                "resolve_blocker": resolve_blocker,
                "detail": "planned replay targets; no writes",
            },
            as_json,
        )
        return 0
    if _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)
    _ho = _ensure_handover(project_root, as_json, dry_run=False)
    if _ho is not None:
        return _ho
    result = auto_recover_pending(project_root)
    # T-1318 Phase H: replaying an interrupted operation SETTLES THE JOURNAL, but
    # it does not by itself have to leave the CHECKPOINT valid -- a crash between
    # PREPARE and APPLY leaves the malformed phase exactly where it was, and the
    # replay legitimately reports success. `saipen recover` promises a ONE-SHOT
    # convergence to a valid protocol state, so when the replay succeeded and the
    # checkpoint is still blocked, fall through to the ordinary reconciliation in
    # the same invocation. Bounded: at most one extra reconciliation, and it
    # never runs when the protocol state is already sound.
    if result.get("ok"):
        from saipen_engine.admission import protocol_snapshot
        from saipen_engine.reconcile import reconcile_protocol_state

        snapshot = protocol_snapshot(project_root, _agent_for(project_root))
        block = snapshot.get("block")
        # A checkpoint surface that does not exist has nothing to reconcile and
        # cannot be reconciled: `reconcile` would only re-report the absence. The
        # journal replay is then the terminal answer (a journal-only project has
        # no STATE/BOARD/LOG to repair), so the fallback is gated on the surface
        # actually being present. An operator-supplied repair flag always runs,
        # so an explicit decision against a broken surface still reports truth.
        checkpoint_present = (project_root / ".saipen" / "STATE.md").is_file()
        blocked_checkpoint = block in ("PROTOCOL_STATE_INVALID", "RECOVERY_REQUIRED")
        if adopt_legacy or attest_legacy_done or resolve_blocker or resolve_next_action or (
            approved_repair_id
        ) or (
            blocked_checkpoint and checkpoint_present
        ):
            reconciliation = reconcile_protocol_state(
                project_root,
                _agent_for(project_root),
                dry_run=dry_run,
                adopt_legacy=adopt_legacy,
                attest_legacy_done=attest_legacy_done,
                resolve_blocker=resolve_blocker,
                resolve_next_action=resolve_next_action,
                approved_repair_id=approved_repair_id,
            )
            merged = dict(result)
            merged["code"] = reconciliation.get("code", result.get("code"))
            merged["ok"] = bool(reconciliation.get("ok"))
            merged["checkpoint"] = {
                "block": block,
                "detail": str(snapshot.get("detail", ""))[:200],
            }
            for key in ("changed", "targets", "detail", "adopted"):
                if reconciliation.get(key) is not None:
                    merged[key] = reconciliation.get(key)
            result = merged
    _emit(result, as_json)
    return 0 if result.get("ok") else 1


def _sub(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """saipen sub list|status|spawn|adopt|pause|resume|sync|clean|collect|
    dispose.

    Strict grammar (SAICREW G): `list`/`sync` take zero positional args;
    `status`/`spawn`/`adopt`/`pause`/`resume`/`clean` take exactly one;
    `collect` takes zero or one; `dispose` takes one name plus an optional
    package id. Unknown or surplus tokens are a structured
    VALIDATION_FAILED with ZERO writes -- ignored garbage is never accepted
    as implied semantics. Every mutator honors --dry-run (same validation,
    same proposed outcome, ZERO writes/LOG/STATE/MANIFEST/journal).
    """
    from saipen_engine.subs import (
        sub_adopt,
        sub_clean,
        sub_collect,
        sub_disposition,
        sub_list,
        sub_pause,
        sub_reconcile,
        sub_resume,
        sub_spawn,
        sub_status,
        sub_sync,
    )

    if not args:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "sub needs an action: list|sync|status|spawn|adopt|"
                "pause|resume|reconcile|clean|collect|dispose",
            },
            as_json,
        )
        return 2
    action = args[0]
    rest = args[1:]
    grammar = {
        "list": (0, 0),
        "sync": (0, 0),
        "status": (1, 1),
        "spawn": (1, 1),
        "adopt": (1, 1),
        "pause": (1, 1),
        "resume": (1, 1),
        "reconcile": (1, 1),
        "clean": (1, 1),
        "collect": (0, 1),
        "dispose": (1, 2),
    }
    if action not in grammar:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"unknown sub action {action!r}; use "
                "list|sync|status|spawn|adopt|pause|resume|reconcile|clean|"
                "collect|dispose",
            },
            as_json,
        )
        return 2
    if action == "reconcile":
        # T-1435 M5: the ONE producer-owned terminal reconciliation route.
        # The producer's OWN STATE/LOG are written in one journaled
        # transaction; Core only detects, routes and dispatches -- it never
        # patches a foreign producer's files by hand and never clears open
        # work. The authorizing receipt is mandatory.
        _opts, _pos, _opt_err = _parse_value_options(rest, {"--authority": "authority"})
        if _opt_err:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _opt_err}, as_json)
            return 2
        if len(_pos) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]+", _pos[0]):
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "sub reconcile takes exactly <role> --authority "
                    "SRC-###",
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = sub_reconcile(
            project_root,
            _pos[0],
            _agent_for(project_root),
            authority=str(_opts.get("authority") or ""),
            dry_run=dry_run,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    minimum, maximum = grammar[action]
    if len(rest) < minimum or len(rest) > maximum:
        wanted = f"exactly {minimum}" if minimum == maximum else f"at most {maximum}"
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"sub {action} takes {wanted} positional "
                f"argument(s); surplus: {' '.join(rest[maximum:])}",
            },
            as_json,
        )
        return 2
    state = parse_state(codec.read_doc(_state_path(project_root)))
    saipen_home = state.get("saipen_home") or ""
    if action in ("sync", "spawn", "adopt") and not saipen_home:
        _emit(
            {
                "ok": False,
                "code": "HOME_REQUIRED",
                "detail": "STATE.saipen_home is required; project root is "
                "not installation provenance",
            },
            as_json,
        )
        return 1
    # T-1006: sub mutators persist the CANONICAL acting seat (inherited
    # STATE.agent or explicit --agent), never a hardcoded CLI identity.
    actor = _agent_for(project_root)

    # CORE-002: list/status are read-only; all other sub actions mutate and
    # must respect the live read-only capability gate.
    if action not in ("list", "status") and not dry_run:
        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho

    def _run(thunk):
        """One sub-action execution with the structured CLI boundary
        (T-1013): a residual path-length/host filesystem failure (an ID that
        passes every safe-ID check yet still breaks the host path budget) is
        a zero-write VALIDATION_FAILED refusal, never a traceback.

        T-1014: mutating sub actions previously performed the seat handover
        here, but the acting actor now folds into the op's own admissible
        transaction (W2-001) -- a rejected command writes nothing and no
        sub action moves the active seat.
        list/status are read-only and touch no ownership."""
        try:
            result = thunk()
        except OSError as exc:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"sub {action} failed on the filesystem: {type(exc).__name__}: {exc}",
                },
                as_json,
            )
            return 1
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1

    if action == "list":
        return _run(lambda: sub_list(project_root))
    if action == "sync":
        return _run(lambda: sub_sync(project_root, saipen_home, agent=actor, dry_run=dry_run))
    if action == "status":
        return _run(lambda: sub_status(project_root, rest[0]))
    if action == "spawn":
        return _run(
            lambda: sub_spawn(project_root, rest[0], saipen_home, agent=actor, dry_run=dry_run)
        )
    if action == "adopt":
        return _run(
            lambda: sub_adopt(project_root, rest[0], saipen_home, agent=actor, dry_run=dry_run)
        )
    if action in ("pause", "resume"):
        fn = sub_pause if action == "pause" else sub_resume
        return _run(lambda: fn(project_root, rest[0], agent=actor, dry_run=dry_run))
    if action == "clean":
        return _run(lambda: sub_clean(project_root, rest[0], agent=actor, dry_run=dry_run))
    if action == "collect":
        name = rest[0] if rest else None
        return _run(lambda: sub_collect(project_root, name, agent=actor, dry_run=dry_run))
    if action == "dispose":
        package_id = rest[1] if len(rest) > 1 else None
        return _run(
            lambda: sub_disposition(project_root, rest[0], package_id, agent=actor, dry_run=dry_run)
        )
    return 2


def _crew(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """saipen crew -- the serial full-platoon convergence circuit (SAICREW).

    `--dry-run` derives the full circuit, shows per-role health and the first
    unsatisfied stage, and writes NOTHING. Apply persists
    `execution_intent: converge` + `converge_target: crew`, runs the
    mechanical transitions (sub sync + required instances), and hands the
    semantic stage work back to the agent; `saipen crew`/`sc` then resumes
    the same target. The launcher scripts stay an OPTIONAL manual multi-window
    helper -- never `saipen crew` semantics.
    """
    if args and args[0] == "record-run":
        # T-1430: the one canonical producer of a crew_run receipt.
        rest = args[1:]
        packages: list[str] = []
        role_name = None
        index = 0
        while index < len(rest):
            token = rest[index]
            if token == "--package" and index + 1 < len(rest):
                packages.append(rest[index + 1])
                index += 2
                continue
            if token.startswith("-") or role_name is not None:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "crew record-run <ROLE> [--package <PACKAGE-ID>]...",
                    },
                    as_json,
                )
                return 2
            role_name = token
            index += 1
        if role_name is None:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "crew record-run <ROLE> [--package <PACKAGE-ID>]...",
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        from saipen_engine.crew import crew_record_run

        result = crew_record_run(
            project_root, _agent_for(project_root), role_name, packages, dry_run=dry_run
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if args:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "crew accepts no positional arguments except record-run; surplus: "
                + " ".join(args),
            },
            as_json,
        )
        return 2
    from saipen_engine.crew import crew_apply, crew_plan

    # P0#4: inject the freshly negotiated current-session capability so a
    # read-only session cannot close a crew release. Second-wave P0: the
    # acting identity is the SESSION agent, never persisted STATE.agent.
    capability = _negotiate_capability(project_root)
    try:
        if dry_run:
            plan = crew_plan(
                project_root,
                current_capability=capability,
                current_agent=_agent_for(project_root),
            )
            _emit(
                {
                    "ok": plan.get("ok"),
                    "code": "CREW_PLAN",
                    "crew_complete": plan.get("crew_complete"),
                    "action_required": plan.get("action_required"),
                    "dry_run": True,
                    **plan,
                },
                as_json,
            )
            # Item 21: a valid nonterminal plan (work remains) is NOT a command
            # failure -- ok:true / exit 0. Nonzero exit is reserved for a
            # structurally invalid or refused derivation.
            return 0 if plan.get("ok") else 1
        result = crew_apply(
            project_root,
            current_capability=capability,
            current_agent=_agent_for(project_root),
        )
    except ValueError as exc:
        from userperson import UserpersonError

        if isinstance(exc, UserpersonError):
            _emit(
                {
                    "ok": False,
                    "code": exc.code,
                    "scope": exc.scope,
                    "detail": exc.detail,
                },
                as_json,
            )
            return 1
        raise
    payload = result.to_dict()
    payload.update(_crew_liveness(project_root, result, capability=capability, dry_run=dry_run))
    _emit(payload, as_json)
    return 0 if result.ok else 1


def _crew_liveness(
    project_root: Path, result: object, *, capability: str | None, dry_run: bool
) -> dict:
    """T-1159: cross-invocation liveness for actionable crew carriers.

    An actionable carrier (one that carries `action_fingerprint`: the
    CREW_BLOCKED routing carrier and the RUN_ROLE-style `CREW_ACTION` handback)
    is recorded in a rebuildable `.saipen/cache/` projection. The SAME
    fingerprint twice in a row means the previous actionable answer produced
    NO qualifying state change -- reported as CREW_STALLED instead of being
    silently re-printed forever. Any carrier without a fingerprint is engine
    progress (a mechanical stage executed, or the circuit finished) and clears
    the projection. Read-only sessions and --dry-run never write it.
    """
    if dry_run or capability == "read-only":
        return {}
    from saipen_engine.liveness import clear as liveness_clear
    from saipen_engine.liveness import record_actionable

    data = getattr(result, "data", None) or {}
    fingerprint = data.get("action_fingerprint")
    if not fingerprint:
        liveness_clear(project_root)
        return {}
    verdict = record_actionable(project_root, str(fingerprint))
    if verdict["stalled"]:
        return {
            "liveness": {
                "stalled": True,
                "stall_repeats": verdict["stall_repeats"],
                "verdict": "CREW_STALLED",
                "detail": (
                    "the same actionable crew state was returned again with no "
                    "qualifying state change since the previous identical "
                    "carrier; this is an execution/conformance failure, not a "
                    "user-action requirement -- do not poll"
                ),
            }
        }
    return {}


def _start_actor(project_root: Path) -> tuple[str, str]:
    """(seat, where it came from) for START, never a question to the operator.

    BOOT's order made mechanical: an explicit `--agent`, then the launcher's
    `SAIPEN_AGENT` carrier, then the project's own `STATE.agent`, then the CLI
    default for a genuinely unseated project. A host session id is none of
    these and is never consulted. Ownership contradictions are judged later by
    the canonical claim, which is the only place a seat can be refused.
    """
    if _AGENT_OVERRIDE is not None:
        return _AGENT_OVERRIDE, "explicit"
    carrier = (os.environ.get("SAIPEN_AGENT") or "").strip()
    if carrier:
        return carrier, "launcher"
    inherited = _agent_for(project_root)
    return inherited, ("inherited" if inherited != AGENT else "default")


def _start(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """`saipen start <task>`: the ONE entry command for a new actionable task."""
    from saipen_engine.entry import USAGE, start_work

    # T-1372: the ONE way to say "the request itself changed" out loud. It is a
    # flag and not a heuristic on purpose -- every silent way to supersede a
    # refused request is a way to launder a paraphrase into the operator's seat.
    supersede_ingress = "--supersede-ingress" in args
    args = [token for token in args if token != "--supersede-ingress"]
    opts, positional, option_error = _parse_value_options(
        args,
        {
            "--priority": "priority",
            "--verify": "verify",
            "--hex": "hex",
            "--file": "file",
            "--receipt": "receipt",
        },
    )
    if option_error:
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": option_error, "usage": USAGE},
            as_json,
        )
        return 2
    text = " ".join(positional).strip() or None
    if opts.get("hex") is not None:
        decoded = _hex_decode(opts["hex"])
        if decoded is None or text:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "--hex needs even-length UTF-8 hex and no other task text",
                    "usage": USAGE,
                },
                as_json,
            )
            return 2
        text = decoded
    if opts.get("file") is not None:
        # T-1363 field finding: a long request cannot be transcribed as hex by
        # a weak model -- measured, twice, corrupted both times. A file written
        # with the host's own write tool passes through no shell, so there is
        # no quoting to get wrong and nothing to copy by hand.
        source = Path(opts["file"])
        if not source.is_absolute():
            source = project_root / source
        try:
            text = source.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError) as exc:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"--file {opts['file']!r} is not a readable UTF-8 file: {exc}",
                    "usage": USAGE,
                },
                as_json,
            )
            return 2
        if opts.get("hex") is not None or positional:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "--file carries the whole task; give no other task text",
                    "usage": USAGE,
                },
                as_json,
            )
            return 2
    receipt = opts.get("receipt")
    if receipt and text:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "--receipt resumes a captured request; give no new task text",
                "usage": USAGE,
            },
            as_json,
        )
        return 2
    if not text and not receipt:
        _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": USAGE, "usage": USAGE}, as_json)
        return 2
    priority = opts.get("priority") or "P1"
    if not re.fullmatch(r"P[0-9]", priority):
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"priority {priority!r} is not P0-P9",
            },
            as_json,
        )
        return 2
    if not dry_run and _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)
    # T-1425: a new actionable task on a host whose persisted home is dead
    # converges first, so START is a zero-manual entry exactly like `cc`.
    _converged = _converge_home_binding(project_root, as_json, dry_run)
    if _converged is not None:
        return _converged
    actor, actor_source = _start_actor(project_root)
    result = start_work(
        project_root,
        actor,
        actor_source=actor_source,
        text=text,
        receipt=receipt,
        priority=priority,
        verify=opts.get("verify"),
        dry_run=dry_run,
        supersede_ingress=supersede_ingress,
    )
    if result.get("code") == "STARTED":
        state_path = _state_path(project_root)
        state, _error = parse_state_or_error(codec.read_doc(state_path))
        route = _cold_route(project_root, state)
        result["load_path"] = route.get("phase_module")
        result["load"] = (
            f"saipen/phases/{str(result.get('phase') or 'SCOUT').lower()}.md"
            if route.get("phase_module")
            else None
        )
        result["execution_instruction"] = (
            "The task is claimed Work. Read load_path, then execute action now under that "
            "phase; do not run status, continue, source or recover first."
        )
    _emit(result, as_json)
    return 0 if result.get("ok") else 1


def _exact_no_args(command: str, args: list[str], as_json: bool) -> int | None:
    """Fail a closed zero-argument command grammar before its handler runs."""
    if not args:
        return None
    _emit(
        {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"{command} accepts no arguments; surplus: {' '.join(args)}",
            # T-1377: the command without the surplus IS the next command.
            "canonical_next_command": f"saipen {command}",
        },
        as_json,
    )
    return 2


def _converge_home_binding(project_root: Path, as_json: bool, dry_run: bool) -> int | None:
    """Auto-converge a dead persisted home before an ordinary entry command.

    The zero-manual half of T-1425 REPAIR 1. When `STATE.saipen_home` names a
    previous host/OS and a replacement runtime is already PROVEN (the
    executing engine, a verified installed carrier), the canonical
    `rebind_home_auto` operation journals the pointer here and the caller
    proceeds; when nothing is proven, that operation's own HOME_REQUIRED
    refusal is emitted and returned as the exit code, so the session gets one
    structured diagnostic instead of a guard refusal on its next tool call.

    Returns None when no convergence was needed, the session is read-only, or
    the convergence committed. NEVER guesses a path -- the candidate set is
    `host_bootstrap.replacement_candidates`, and each candidate is proved with
    the same layout/VERSION proof the explicit rebind uses.
    """
    if dry_run:
        return None
    path = _state_path(project_root)
    if not path.is_file():
        return None
    fields, error = parse_state_or_error(codec.read_doc(path))
    if error or not isinstance(fields, dict):
        return None
    from saipen_engine.state import persisted_home_error

    if persisted_home_error(fields.get("saipen_home")) is None:
        return None
    if _negotiate_capability(project_root) == "read-only":
        return None
    from saipen_engine.operations import rebind_home_auto

    result = rebind_home_auto(project_root, _agent_for(project_root))
    if result.ok:
        return None
    payload = result.to_dict()
    payload["action"] = "home-convergence"
    _emit(payload, as_json)
    return 1


def _continue(
    project_root: Path,
    args: list[str],
    as_json: bool,
    dry_run: bool,
    *,
    shortcut: bool = False,
) -> int:
    """Resume the persisted execution intent through the canonical router.

    Goal resumes its existing objective (and reauthorizes only a tripped
    safety valve), converge keeps its durable target, and normal enters the
    plain ``done`` convergence contract. This command deliberately does not
    call the crew executor: crew is only one possible persisted converge
    target and is routed by ``route_next`` when that target actually owns the
    run.
    """
    if args:
        detail = (
            "Use: gg <objective>"
            if shortcut
            else "continue accepts no positional arguments; surplus: " + " ".join(args)
        )
        if shortcut and not as_json:
            # CORE section 1.10 owns this exact shortcut response. Do not
            # decorate it with the generic REFUSE envelope.
            print(detail)
        else:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": detail}, as_json)
        return 2

    # Read the state once at the public boundary.  This closes the same
    # intent-race window as the later operation precondition: reconciliation
    # must never publish a repair based on a different persisted intent than
    # the continuation caller observed.
    initial_state = None
    initial_path = _state_path(project_root)
    if initial_path.is_file():
        initial_state, initial_error = parse_state_or_error(codec.read_doc(initial_path))
        if initial_error:
            initial_state = None
        else:
            from saipen_engine.state import parse_frontmatter

            observed_state, observed_error = parse_frontmatter(codec.read_doc(initial_path))
            if (
                observed_error is None
                and observed_state is not None
                and initial_state.get("execution_intent") != observed_state.get("execution_intent")
            ):
                _emit(
                    {
                        "ok": False,
                        "code": "STALE_STATE",
                        "detail": "execution_intent changed before continuation "
                        "reconciliation; no repair committed",
                    },
                    as_json,
                )
                return 1

    pending, conflicts, corrupt = _scan_full(project_root)
    if corrupt:
        _emit(_corrupt_refusal(corrupt), as_json)
        return 1
    if conflicts:
        _emit(
            {
                "ok": False,
                "code": "RECOVERY_CONFLICT",
                "op_ids": conflicts,
                "detail": "continuation cannot guess through unresolved recovery conflict(s): "
                + ", ".join(conflicts),
            },
            as_json,
        )
        return 1
    if pending:
        if dry_run:
            # CORE-002: `continue --dry-run` PROJECTS recovery instead of
            # refusing. The pending op set is decoded and the planned replay
            # targets are returned so the caller sees what continuation would
            # commit; no journal is settled and no bytes are written. The
            # post-recovery route cannot be truthfully routed from this
            # process (recovery would need to settle first), so the replay
            # plan is the projection, with zero writes.
            from saipen_engine.journal import decode_operation_record

            plan_ops = []
            for op_id in pending:
                record, err = decode_operation_record(
                    project_root, project_root / ".saipen" / "recovery" / "ops" / op_id
                )
                if not err:
                    plan_ops.append(
                        {
                            "op_id": op_id,
                            "operation": record.get("operation"),
                            "stage": record.get("status"),
                            "targets": [
                                t.get("path")
                                for t in record.get("targets", [])
                                if isinstance(t, dict)
                            ],
                        }
                    )
            _emit(
                {
                    "ok": True,
                    "code": "DRY_RUN_PLAN",
                    "action": "continue",
                    "pending_ops": pending,
                    "plan": plan_ops,
                    "detail": "planned recovery replay before routing; no writes",
                },
                as_json,
            )
            return 0
        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        recovered = auto_recover_pending(project_root)
        if not recovered.get("ok"):
            _emit(recovered, as_json)
            return 1

    # T-1425: `cc` is the zero-manual convergence entry. A dead persisted home
    # whose replacement runtime is already proven converges here; a dead home
    # with no proven replacement returns the operation's structured
    # HOME_REQUIRED (never a conversational fallback).
    if not dry_run:
        _converged = _converge_home_binding(project_root, as_json, dry_run)
        if _converged is not None:
            return _converged

    # Continuation is the self-healing entry point. Journal recovery and
    # deterministic checkpoint reconciliation happen before strict routing;
    # semantic ambiguity/corruption still returns a hard classified refusal.
    if not dry_run and _negotiate_capability(project_root) == "read-only":
        # A read-only session may inspect, but cannot promise that it repaired
        # the state it is about to execute.
        from saipen_engine.reconcile import reconcile_protocol_state

        preview = reconcile_protocol_state(project_root, _agent_for(project_root), dry_run=True)
        if preview.get("code") not in ("CLEAN", "WARN"):
            _emit(
                {
                    **preview,
                    "code": "CAPABILITY_UNAVAILABLE",
                    "detail": "continue found repairable protocol drift but mode is read-only; "
                    "run again in a writable session",
                },
                as_json,
            )
            return 1
        # Keep the continuation itself read-only after the preview. A clean
        # projection is safe to route; a REPAIRED preview is not safe to claim
        # as committed by a session that cannot write.
        dry_run = True

    from saipen_engine.reconcile import reconcile_protocol_state

    reconciliation = reconcile_protocol_state(
        project_root, _agent_for(project_root), dry_run=dry_run
    )
    # CORE-001 (audit-all3): a tripped safety valve is an explicit refusal
    # with the reauthorization path as the only clearing. ``cc`` IS that
    # reauthorization, so the refusal must not stop continuation cold --
    # reauthorize and emit the reauth outcome (the rest of the run already
    # sees the cleared STATE).
    #
    # T-1363: route on the refusal's REMEDIATION, never on its code. The same
    # RECONCILE_REAUTH_REQUIRED carries four kinds of operator decision, and
    # sending every one of them here answered "valve has not tripped; no fresh
    # budget is owed" -- measured on five real projects. Only a proven valve
    # is reauthorized; every other decision leaves with its exact command.
    from saipen_engine.reconcile import SAFETY_VALVE_TRIPPED

    if reconciliation.get("code") == "RECONCILE_REAUTH_REQUIRED" and reconciliation.get(
        "safety_valve_tripped"
    ):
        from saipen_engine.operations import reauthorize_valve

        reauth = reauthorize_valve(project_root, _agent_for(project_root), dry_run=dry_run)
        if not reauth.ok:
            _emit(reauth.to_dict(), as_json)
            return 1
        if reconciliation.get("remediation") == SAFETY_VALVE_TRIPPED:
            # Surface the reauthorization as the canonical outcome of this
            # ``cc`` invocation. The post-reauth reconciliation runs
            # downstream of the reauth it just executed; the caller already
            # saw the reason the valve tripped and that it is now cleared.
            reauth_dict = reauth.to_dict()
            reauth_dict["execution_intent"] = "goal"
            reauth_dict["goal_waves"] = 0
            reauth_dict["goal_tickets"] = 0
            reauth_dict["reconciliation"] = reconciliation
            _emit(reauth_dict, as_json)
            return 0
        if dry_run:
            # The valve shares the refusal with a real decision. A preview
            # cannot clear the valve and then observe what remains, so it
            # reports both: the planned reauthorization and the decision.
            _emit({**reconciliation, "planned_valve_reauthorization": reauth.to_dict()}, as_json)
            return 1
        reconciliation = reconcile_protocol_state(
            project_root, _agent_for(project_root), dry_run=dry_run
        )
    if not reconciliation.get("ok"):
        _emit(reconciliation, as_json)
        return 1
    # A dry-run reports the reconciliation alongside the canonical command
    # plan.  It must not return early as ``REPAIRED``: aliases and explicit
    # continue have one observable route, and callers still need to see what
    # continuation would do after the proposed repair.  No bytes are written
    # because both the reconciliation and the routed operation are dry-run.

    state_path = _state_path(project_root)
    if not state_path.is_file():
        _emit({"ok": False, "code": "NOT_SAIPEN_PROJECT"}, as_json)
        return 3
    state, state_error = parse_state_or_error(codec.read_doc(state_path))
    if state_error:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"state-malformed: {state_error}",
            },
            as_json,
        )
        return 1

    execution_intent = state.get("execution_intent") or "normal"
    actor = _agent_for(project_root)
    if execution_intent == "normal":
        from saipen_engine.operations import set_converge_intent

        result = set_converge_intent(
            project_root,
            actor,
            "done",
            dry_run=dry_run,
            required_source_intent="normal",
        )
        if dry_run or not result.ok:
            payload = result.to_dict()
            payload["dry_run"] = dry_run
            if result.ok:
                payload.update(
                    {
                        "execution_intent": "converge",
                        "converge_target": "done",
                    }
                )
            payload["reconciliation"] = reconciliation
            _emit(payload, as_json)
            return 0 if result.ok else 1
        return _next_action(
            project_root,
            as_json,
            reconciliation=reconciliation,
            fallthrough_to_improve=True,
            dry_run=dry_run,
        )

    if execution_intent == "goal":
        waves = state.get("goal_waves") or 0
        tickets = state.get("goal_tickets") or 0
        if waves >= 3 or tickets >= 20:
            from saipen_engine.operations import reauthorize_valve

            result = reauthorize_valve(project_root, actor, dry_run=dry_run)
            if dry_run or not result.ok:
                payload = result.to_dict()
                payload["dry_run"] = dry_run
                if result.ok:
                    payload.update(
                        {
                            "execution_intent": "goal",
                            "goal_waves": 0,
                            "goal_tickets": 0,
                        }
                    )
                payload["reconciliation"] = reconciliation
                _emit(payload, as_json)
                return 0 if result.ok else 1

    # Goal (untripped or freshly reauthorized) and converge both derive the
    # next action from the same STATE/BOARD/complete-LOG snapshot as `next`.
    return _next_action(
        project_root,
        as_json,
        reconciliation=reconciliation,
        fallthrough_to_improve=True,
        dry_run=dry_run,
    )


def _audit_enqueue(project_root: Path, rest: list[str], as_json: bool, dry_run: bool) -> int:
    """`saipen audit enqueue` -- the ONE constrained producer writer (T-1230).

    Flags: `--producer NAME --operation-id ID [--item-id ID]` plus exactly one
    body source, `--file PATH` or `--text ...`. The producer never names a
    path and never picks a layer number; `--file` is read, never linked to.
    """
    from saipen_engine import audit_enqueue

    producer = operation_id = item_id = file_path = None
    text_tokens: list[str] = []
    i = 0
    while i < len(rest):
        token = rest[i]
        if token == "--text":
            text_tokens = rest[i + 1 :]
            break
        if token in ("--producer", "--operation-id", "--item-id", "--file"):
            if i + 1 >= len(rest):
                _emit(
                    {"ok": False, "code": "VALIDATION_FAILED", "detail": f"{token} needs a value"},
                    as_json,
                )
                return 2
            value = rest[i + 1]
            if token == "--producer":
                producer = value
            elif token == "--operation-id":
                operation_id = value
            elif token == "--item-id":
                item_id = value
            else:
                file_path = value
            i += 2
            continue
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": f"unknown flag {token!r}"},
            as_json,
        )
        return 2

    if not producer or not operation_id:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "audit enqueue needs --producer and --operation-id",
            },
            as_json,
        )
        return 2
    if bool(file_path) == bool(text_tokens):
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "audit enqueue needs exactly one body source: --file or --text",
            },
            as_json,
        )
        return 2
    if file_path:
        try:
            body = Path(file_path).read_bytes()
        except OSError as exc:
            _emit(
                {"ok": False, "code": "VALIDATION_FAILED", "detail": f"cannot read file: {exc}"},
                as_json,
            )
            return 1
    else:
        body = (" ".join(text_tokens) + "\n").encode("utf-8")

    if dry_run:
        # PLAN parity: validate exactly like the real call, name the layer the
        # allocator would hand out, write nothing. The SOLE idempotence
        # authority is the allocator's `producer + operation -> layer` map
        # (REGISTRY.audit_enqueue), the same read the real `enqueue` consults --
        # a plan that says "fresh layer N" where the real call would recover or
        # refuse is exactly the dry-run-certifies-invalid-input defect. A
        # corrupt allocator refuses here precisely as the real path does
        # (`read_allocator_state`, never the tolerant reader).
        doc, allocator_state = audit_enqueue.read_allocator_state(project_root)
        if allocator_state == audit_enqueue.ALLOCATOR_CORRUPT:
            _emit(
                {
                    "ok": False,
                    "code": "ALLOCATOR_CORRUPT",
                    "operation": "audit_enqueue",
                    "detail": (
                        f"{audit_enqueue.ALLOCATOR_REL} exists but cannot be read "
                        "as an allocator document; the real enqueue would refuse"
                    ),
                },
                as_json,
            )
            return 1
        doc = audit_enqueue._reconcile(project_root, doc)
        existing = doc["operations"].get(audit_enqueue._op_key(producer, operation_id))
        if isinstance(existing, dict) and isinstance(existing.get("layer"), int):
            layer = existing["layer"]
            idempotent = True
        else:
            layer = doc["next_id"]
            idempotent = False
        _emit(
            {
                "ok": True,
                "code": "PLAN",
                "operation": "audit_enqueue",
                "producer": producer,
                "producer_operation_id": operation_id,
                "layer": layer,
                "rel": f"audit/{layer}.md",
                "sha256": audit_enqueue.layer_digest(body),
                "idempotent": idempotent,
                "writes": [],
            },
            as_json,
        )
        return 0
    if _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)

    result = audit_enqueue.enqueue(
        project_root,
        producer=producer,
        body=body,
        producer_operation_id=operation_id,
        producer_item_id=item_id,
    )
    _emit(result, as_json)
    return 0 if result.get("ok") else 1


def _audit_manifest(project_root: Path, rest: list[str], as_json: bool, dry_run: bool) -> int:
    """`saipen audit manifest [--write [--force]]`.

    The protocol declaring its own audit evidence. Read-only by default,
    because a packager must be able to ASK without mutating the project it
    is about to snapshot.
    """
    from saipen_engine import audit_manifest

    write = force = False
    for token in rest:
        if token == "--write":
            write = True
        elif token == "--force":
            force = True
        else:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"unknown flag {token!r}; expected --write [--force]",
                },
                as_json,
            )
            return 2
    if force and not write:
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": "--force requires --write"},
            as_json,
        )
        return 2

    if not write:
        result = audit_manifest.status(project_root, protocol_dir=PROTOCOL_DIR)
        result["manifest"] = audit_manifest.build(project_root, protocol_dir=PROTOCOL_DIR)
        # The read-only projection also answers the question a packager asks
        # first: WOULD this project enroll, and if not, why not. Read-only by
        # construction (dry_run) -- asking never mutates the project.
        result["enrollment"] = audit_manifest.ensure(
            project_root, protocol_dir=PROTOCOL_DIR, dry_run=True
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    if dry_run:
        _emit(
            audit_manifest.ensure(project_root, protocol_dir=PROTOCOL_DIR, dry_run=True),
            as_json,
        )
        return 0
    if _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)
    result = audit_manifest.ensure(
        project_root, protocol_dir=PROTOCOL_DIR, force=force
    )
    _emit(result, as_json)
    return 0 if result.get("ok") else 1


def _audit(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """Audit Inbox admin surface (SOURCE-AUDIT-INBOX-01).

    Subcommands:
      status            compact read-only projection (default)
      inspect <N>       one layer's transport facts, read-only, no body dump
      trace [N]         audit -> receipt -> Work -> disposition provenance,
                        read-only, survives the consumed file
      ingest            settle proven cleanup, then capture the lowest workable
                        layer and derive its canonical Work (mutating)
      enqueue           place one producer audit as the next canonical layer
                        (mutating; SOURCE-AUDIT-ENQUEUE-01)
      manifest [--write [--force]]
                        the protocol's own audit-evidence contract: what a
                        packager must capture for a snapshot to represent
                        current lifecycle truth. Read-only by default;
                        `--write` enrolls/migrates `.saipen/MANIFEST.json`
                        idempotently (a current manifest is left untouched; a
                        newer contract, or one that is not this contract, is
                        refused unless `--force`). Enrollment also happens on
                        its own: every canonical state transition heals it
                        through `reconcile_protocol_state`.

    Ordinary operation needs NONE of these: `cc` routes through the same
    projection. They exist for inspection and for the executable action the
    router names.
    """
    from saipen_engine import audit_inbox

    action = args[0] if args else "status"
    rest = args[1:]

    if action == "manifest":
        return _audit_manifest(project_root, rest, as_json, dry_run)

    if action == "status":
        _emit(audit_inbox.status(project_root), as_json)
        return 0

    if action == "trace":
        if len(rest) > 1 or (rest and not rest[0].isdigit()):
            _emit(
                {"ok": False, "code": "VALIDATION_FAILED", "detail": "trace takes an optional <N>"},
                as_json,
            )
            return 2
        _emit(audit_inbox.provenance_trace(project_root, int(rest[0]) if rest else None), as_json)
        return 0

    if action == "inspect":
        if len(rest) != 1 or not rest[0].isdigit():
            _emit(
                {"ok": False, "code": "VALIDATION_FAILED", "detail": "inspect needs <N>"},
                as_json,
            )
            return 2
        rel = f"{audit_inbox.AUDIT_DIRNAME}/{int(rest[0])}.md"
        for item in audit_inbox.classify(project_root)["layers"]:
            if item["rel"] == rel:
                _emit({"ok": True, "code": "AUDIT_INBOX_STATUS", "layer": item}, as_json)
                return 0
        _emit({"ok": False, "code": "TICKET_NOT_FOUND", "detail": rel}, as_json)
        return 1

    if action == "enqueue":
        return _audit_enqueue(project_root, rest, as_json, dry_run)

    if action != "ingest":
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": (
                    "audit needs a subcommand: "
                    "status|inspect|trace|ingest|enqueue|manifest"
                ),
            },
            as_json,
        )
        return 2
    if rest:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"audit ingest takes no arguments; surplus: {' '.join(rest)}",
            },
            as_json,
        )
        return 2
    if not dry_run and _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)

    agent = _agent_for(project_root)
    # SRC-019:R6 -- classify FIRST. A corrupt inbox binding is refused here,
    # before `reconcile_bootstrap` reads it, because every mutation below
    # (bootstrap binding, journaled cleanup, capture) would otherwise decide
    # from authority nobody could read.
    state = audit_inbox.classify(project_root)
    if not state.get("ok", True):
        _emit(
            {
                **state,
                "action": "saipen audit status",
                "detail": state.get("detail", "audit inbox binding is unreadable"),
                "layers": None,
                "orphans": None,
                "residue": None,
            },
            as_json,
        )
        return 1
    # Bootstrap migration: layers that already own canonical Work are BOUND,
    # never recaptured. Without this the first activation would look at a
    # hand-converted audit and manufacture a duplicate receipt and ticket.
    try:
        migrated = audit_inbox.reconcile_bootstrap(project_root) if not dry_run else []
    except audit_inbox.BindingBusy as exc:
        _emit(
            {"ok": False, "code": "WRITER_BUSY", "detail": str(exc)},
            as_json,
        )
        return 1
    if migrated:
        state = audit_inbox.classify(project_root)
    layers = state["layers"]

    # CLEANUP FIRST: a completed audit must disappear on the next `cc` without
    # a separate ritual. Every settle re-proves the closure gate and the
    # current digest, so a layer replaced since closure is preserved, not
    # deleted (`AUDIT_GENERATION_CHANGED`).
    consumed: list[dict] = []
    for item in layers:
        if item["state"] != audit_inbox.CLOSED_PENDING_DELETE:
            continue
        outcome = audit_inbox.consume_layer(project_root, item["rel"], agent, dry_run=dry_run)
        consumed.append(outcome)
        if not outcome.get("ok"):
            _emit(
                {
                    **outcome,
                    "action": "saipen audit status",
                    "detail": outcome.get("detail", "audit cleanup refused; the file is retained"),
                },
                as_json,
            )
            return 1
    if consumed:
        _emit(
            {
                "ok": True,
                "code": "AUDIT_CONSUME_PLAN" if dry_run else "AUDIT_CONSUMED",
                "dry_run": dry_run,
                "migrated": migrated or None,
                "consumed": consumed,
                "next": audit_inbox.projection(project_root) if not dry_run else None,
            },
            as_json,
        )
        return 0

    fresh = next((item for item in layers if item["state"] == audit_inbox.NEW), None)
    if fresh is None:
        # W2-004: RESUME. Ingestion commits BOARD Work, then the Source link,
        # then the inbox binding, and a crash between them left a layer that is
        # already ACTIVE -- so this selection, which only ever looked for NEW,
        # returned status-only success. `projection()` meanwhile kept routing
        # `saipen audit ingest`, so the router prescribed a command whose
        # implementation refused to consume the state it prescribed it for: a
        # permanent no-progress loop, and `SOURCE-AUDIT-INBOX-01` REQUIRES an
        # agent to follow that route. Picking up the partial state here is what
        # makes the action consume every state the projection emits.
        fresh = next(
            (
                item
                for item in layers
                if item["state"] == audit_inbox.ACTIVE and not item.get("linked_work")
            ),
            None,
        )
    if fresh is None:
        settled = audit_inbox.status(project_root)
        _emit(
            {
                **settled,
                "code": "AUDIT_INBOX_STATUS",
                "migrated": migrated or None,
                "detail": (
                    "no unconsumed audit generation and nothing to settle; "
                    + (
                        "audit/ is clean"
                        if settled.get("clean")
                        else f"audit/ still holds {settled.get('residue_count', 0)} "
                        "entr(y/ies) SAIPEN never captured -- listed under residue, "
                        "never deleted for you"
                    )
                ),
            },
            as_json,
        )
        return 0
    if dry_run:
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "audit ingest",
                "layer": fresh["layer"],
                "path": fresh["rel"],
                "sha256": fresh["sha256"],
                "would_capture_as": "external_audit source receipt",
                "detail": "no capture, no BOARD mutation, no journal, no deletion",
            },
            as_json,
        )
        return 0

    _ho = _ensure_handover(project_root, as_json, dry_run)
    if _ho is not None:
        return _ho

    captured = audit_inbox.capture_layer(project_root, fresh["rel"])
    if not captured.get("ok"):
        _emit(captured, as_json)
        return 1
    receipt = captured["receipt"]
    work = captured.get("linked_work")
    if not work:
        from saipen_engine import intake

        status_out = intake.status(project_root, receipt)
        work = status_out.get("linked_work") if status_out.get("ok") else None

    # DERIVE ORDINARY WORK. One umbrella ticket per audit source; individual
    # requirements link through the existing coverage `work` field. Priority is
    # P1, never P0 merely because the file came from `audit/` -- inbox
    # precedence is a ROUTING property and must not corrupt BOARD priority.
    if not work:
        # W2-004: a retry after the ticket committed must ADOPT that ticket,
        # never manufacture a second one. The link is a structured
        # `source_receipt=<SRC-NNN>` token -- the same machine-owned key=value
        # linkage the sub-collect tickets already use for package identity --
        # so discovery is a field lookup, not a guess from title prose.
        work = _work_for_source_receipt(project_root, receipt)
    if not work:
        from saipen_engine.operations import ticket_add

        added = ticket_add(
            project_root,
            agent,
            "P1",
            f"Execute external audit inbox layer {fresh['rel']} ({receipt}); "
            f"source_receipt={receipt}",
            [],
            (
                f"every actionable clause of {receipt} is terminal with evidence; "
                f"linked Work DONE; source closure succeeds; {fresh['rel']} consumed "
                f"by the journaled audit inbox cleanup; source_receipt={receipt}"
            ),
        )
        if not added.ok:
            _emit(added.to_dict(), as_json)
            return 1
        work = added.data.get("ticket")

    # W2-004: the Source link is written for a DISCOVERED ticket exactly as for
    # a freshly created one. It used to live inside the creation branch, so a
    # resumed ingest adopted the right ticket and then left the receipt
    # unlinked -- the same wedge one step further along, and the projection
    # would have kept routing here forever.
    if work and not captured.get("linked_work"):
        linked = audit_inbox.capture_layer(project_root, fresh["rel"], work=work)
        if not linked.get("ok"):
            _emit(linked, as_json)
            return 1

    try:
        record = audit_inbox.bind_layer(
            project_root,
            fresh["rel"],
            layer=fresh["layer"],
            generation=fresh["generation"],
            file_sha256=captured["file_sha256"],
            size_bytes=fresh["size_bytes"],
            receipt_id=receipt,
            receipt_sha256=captured.get("source_sha256") or captured["file_sha256"],
            binding=captured.get("binding", "exact"),
            linked_work=work,
            state=audit_inbox.ACTIVE,
            provenance=captured.get("provenance"),
        )
    except audit_inbox.BindingBusy as exc:
        # SRC-025:R007: a contested binding writer is a structured busy
        # result the producer can retry, never a raw race exception and
        # never a success reported before the record is committed.
        _emit({"ok": False, "code": "WRITER_BUSY", "detail": str(exc)}, as_json)
        return 1
    _emit(
        {
            "ok": True,
            "code": "AUDIT_INGESTED",
            "migrated": migrated or None,
            "layer": fresh["layer"],
            "path": fresh["rel"],
            "receipt": receipt,
            "work": work,
            "binding": record["binding"],
            "file_sha256": record["file_sha256"],
            "source_sha256": record["receipt_sha256"],
            "action": f"PHASE SCOUT {work}" if work else "saipen audit status",
            "detail": (
                "audit captured as durable source authority; normalize its "
                "requirements through `saipen source req` before execution"
            ),
        },
        as_json,
    )
    return 0


def _work_for_source_receipt(project_root: Path, receipt: str) -> str | None:
    """The BOARD ticket already created for this Source receipt, or None.

    W2-004: ingestion is three durable writes -- BOARD Work, the Source link,
    the inbox binding -- and a crash between the first two leaves real Work the
    receipt cannot reach. The retry has to find that exact ticket, and it has to
    find it by MACHINE identity: matching on the title text would adopt any
    ticket whose prose happened to mention the receipt, which is the
    narrative-authority failure this repository already has a name for.

    TWO records of one fact, and both are needed because they become durable at
    DIFFERENT points:

    * `source_receipts:` is the canonical board field, and it is written by the
      LINKAGE step -- the write that crashes. It cannot be the discovery key on
      the very path this function exists for, but where it is present it is the
      authority and is checked first.
    * `source_receipt=<SRC-NNN>` rides inside the description, so it commits
      ATOMICALLY with the ticket itself. It is the only marker that survives a
      crash between ticket creation and linkage.

    Both are structured `key=value`/field lookups, not title-text matching:
    adopting a ticket because its prose happened to mention the receipt is the
    narrative-authority failure this repository already has a name for.

    A non-terminal ticket is preferred, but a terminal one still counts: the
    receipt belongs to the Work created for it whatever state that Work
    reached, and making a second ticket because the first was closed would be
    the duplicate dispatch this exists to prevent.
    """
    from saipen_engine.board import parse_board

    try:
        board = parse_board((project_root / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None

    field_matches: list[dict] = []
    token_matches: list[dict] = []
    token = f"source_receipt={receipt}"
    for ticket in (board.get("tickets") or {}).values():
        fields = ticket.get("fields") or {}
        declared = str(fields.get("source_receipts") or "")
        if receipt in [part.strip() for part in declared.replace(",", " ").split()]:
            field_matches.append(ticket)
            continue
        blob = f"{ticket.get('description') or ''} {fields.get('verify') or ''}"
        if token in blob:
            token_matches.append(ticket)

    for candidates in (field_matches, token_matches):
        if candidates:
            candidates.sort(key=lambda t: (t.get("section") == "## DONE", t.get("id") or ""))
            return candidates[0].get("id")
    return None


#: Closure/scope option grammar for the public ticket commands (CORE-003).
#: One table, so `--help`, the parser and the refusal messages cannot drift.
_TICKET_DONE_OPTIONS = {
    "--closure-mode": "closure_mode",
    "--closure-cohort": "closure_cohort",
    "--implementation-source": "implementation_source",
    "--paths": "closure_paths",
}
_TICKET_BLOCK_OPTIONS = {"--scope": "scope", "--retry_not_before": "retry_not_before"}
#: `ticket retire` grammar. The first three are MANDATORY and each one is a
#: separate refusal: a reason outside the registered set, evidence that does
#: not resolve to a canonical event or an owned artifact, and an authority
#: receipt whose capsule does not grant this Work are three different mistakes
#: and a weak model has to be able to tell them apart. `--discovery-event` and
#: `--note` are optional.
_TICKET_RETIRE_OPTIONS = {
    "--reason": "reason",
    "--evidence": "evidence",
    "--authority": "authority",
    "--discovery-event": "discovery_event",
    "--note": "note",
}
_TICKET_SUPERSEDE_OPTIONS = {
    "--by": "successor",
    "--evidence": "evidence",
    "--authority": "authority",
}


def _parse_value_options(tokens: list[str], spec: dict[str, str]) -> tuple[dict, list[str], str]:
    """Split ``tokens`` into declared ``--opt value`` pairs and positionals.

    Returns ``(values, positionals, error)``. The grammar is deliberately
    strict and its refusals are distinct sentences, because an agent has to be
    able to tell "you typed it twice", "that option does not exist" and "you
    left the value off" apart from each other -- CONTROL B asserts exactly
    those three. Every refusal is zero-write: parsing happens before any
    project read.
    """
    values: dict[str, str] = {}
    positionals: list[str] = []
    idx = 0
    while idx < len(tokens):
        token = tokens[idx]
        if token in spec:
            key = spec[token]
            if key in values:
                return {}, [], "duplicate option " + token
            if idx + 1 >= len(tokens) or tokens[idx + 1] in spec:
                return {}, [], "option " + token + " needs a value"
            values[key] = tokens[idx + 1]
            idx += 2
            continue
        if token.startswith("--"):
            return {}, [], "unknown option " + token
        positionals.append(token)
        idx += 1
    return values, positionals, ""


def _cohort(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """`saipen cohort status|ship C-###` -- durable batch publication (CORE-003).

    A cohort exists because several tickets can legitimately share ONE
    unpublished implementation. Its publication is a single batch through the
    EXISTING release machinery -- there is no second publisher here, only a
    carrier handed to `plan_release`.
    """
    from saipen_engine import closure as _closure

    if len(args) < 2:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "cohort needs an action and an id: cohort status|ship C-###",
            },
            as_json,
        )
        return 2
    action, cohort_id = args[0], args[1]
    if len(args) > 2:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "cohort "
                + action
                + " takes exactly one C-### id; surplus: "
                + " ".join(args[2:]),
            },
            as_json,
        )
        return 2
    if not _closure.COHORT_ID_RE.match(cohort_id):
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "cohort id " + repr(cohort_id) + " is not a C-### identity",
            },
            as_json,
        )
        return 2
    try:
        registry = _closure.read_registry(project_root)
    except (OSError, ValueError) as exc:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "cohort registry is unreadable: " + str(exc),
            },
            as_json,
        )
        return 1
    cohort = (registry.get("cohorts") or {}).get(cohort_id)
    if cohort is None:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "cohort " + cohort_id + " has no durable registry record",
            },
            as_json,
        )
        return 1
    if action == "status":
        readiness = _closure.cohort_readiness(project_root, cohort)
        _emit(
            {
                "ok": True,
                "code": "COHORT_STATUS",
                "cohort": cohort_id,
                "publication_status": cohort.get("publication_status"),
                "members": sorted(cohort.get("members") or {}),
                "scope": sorted(cohort.get("scope") or []),
                "ready": readiness["ready"],
                "problems": readiness["problems"],
                "release_op_id": cohort.get("release_op_id") or "",
                "version": cohort.get("version") or "",
                "tag": cohort.get("tag") or "",
                "commit": cohort.get("commit") or "",
            },
            as_json,
        )
        return 0
    if action != "ship":
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "unknown cohort action " + repr(action) + "; use status|ship",
            },
            as_json,
        )
        return 2
    if not dry_run and _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)
    from saipen_engine.operations import cohort_ship

    result = cohort_ship(
        project_root,
        cohort_id,
        _agent_for(project_root),
        dry_run=dry_run,
        current_capability=_negotiate_capability(project_root),
    )
    _emit(result.to_dict(), as_json)
    return 0 if result.ok else 1


_SOURCE_APPEND_USAGE = (
    "source append [--to SRC-###] [--class APPEND|SUPERSEDE|CLARIFICATION|CONFLICT] "
    "[--delta implementation|evidence|review|packaging|context] "
    "[--supersedes SRC-###:R###,SRC-###] [--label TEXT] (--file PATH | --hex HEX | -- TEXT) | "
    "source apply-append <SRC-###> | source appends"
)


def _source_append_command(
    project_root: Path, action: str, rest: list[str], as_json: bool, dry_run: bool
) -> int:
    """SRC-104 / T-1461: operational appends are mission input, not prose.

    `append` makes the bytes durable against the controlling mission source,
    `apply-append` projects them into requirements, Work and the minimum
    truthful rewind, and `appends` is the read-only view status shares.
    """
    from saipen_engine import source_append

    if action == "appends":
        _emit(source_append.append_status(project_root), as_json)
        return 0
    if not dry_run and _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)
    if action == "apply-append":
        if len(rest) != 1 or not re.fullmatch(r"SRC-\d+", rest[0]):
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _SOURCE_APPEND_USAGE},
                  as_json)
            return 2
        if dry_run:
            source, entry = source_append.find_append(project_root, rest[0])
            _emit(
                {
                    "ok": entry is not None,
                    "code": "PLAN" if entry is not None else "APPEND_NOT_FOUND",
                    "dry_run": True,
                    "receipt": rest[0],
                    "source": source,
                    "state": (entry or {}).get("state"),
                },
                as_json,
            )
            return 0 if entry is not None else 1
        result = source_append.apply_append(project_root, rest[0], actor=_agent_for(project_root))
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    opts = {"to": None, "class": source_append.APPEND, "delta": "implementation",
            "supersedes": "", "label": "", "file": None, "hex": None}
    body_tokens: list[str] = []
    i = 0
    while i < len(rest):
        token = rest[i]
        if token == "--":
            body_tokens.extend(rest[i + 1:])
            break
        key = token[2:] if token.startswith("--") else None
        if key in opts:
            if i + 1 >= len(rest):
                _emit(
                    {"ok": False, "code": "VALIDATION_FAILED", "detail": f"{token} needs a value"},
                    as_json,
                )
                return 2
            opts[key] = rest[i + 1]
            i += 2
            continue
        if token.startswith("--"):
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": f"unknown flag {token!r}",
                   "usage": _SOURCE_APPEND_USAGE}, as_json)
            return 2
        body_tokens.append(token)
        i += 1
    carriers = [bool(opts["file"]), bool(opts["hex"]), bool(body_tokens)]
    if sum(carriers) != 1:
        _emit({"ok": False, "code": "VALIDATION_FAILED",
               "detail": "source append takes exactly one of --file, --hex or -- TEXT",
               "usage": _SOURCE_APPEND_USAGE}, as_json)
        return 2
    try:
        if opts["file"]:
            body = Path(opts["file"]).read_bytes().decode("utf-8")
        elif opts["hex"]:
            body = bytes.fromhex(opts["hex"]).decode("utf-8")
        else:
            body = " ".join(body_tokens)
    except (OSError, ValueError) as exc:
        _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": f"cannot read append: {exc}"},
              as_json)
        return 1
    supersedes = [part.strip() for part in str(opts["supersedes"]).split(",") if part.strip()]
    if dry_run:
        target = source_append.resolve_controlling_source(project_root, opts["to"])
        _emit({"ok": bool(target.get("ok")),
               "code": "PLAN" if target.get("ok") else target.get("code"),
               "dry_run": True, "source": target.get("source"), "class": opts["class"],
               "delta": opts["delta"], "supersedes": supersedes,
               "derived_clauses": len(source_append.derive_normative_clauses(body)),
               "detail": target.get("detail")}, as_json)
        return 0 if target.get("ok") else 1
    result = source_append.append(
        project_root,
        body,
        to=opts["to"],
        klass=str(opts["class"]).upper(),
        delta=str(opts["delta"]).lower(),
        supersedes=supersedes,
        label=opts["label"],
        actor=_agent_for(project_root),
    )
    _emit(result, as_json)
    return 0 if result.get("ok") else 1


def _source(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """T-1162: lossless source receipts.

    Subcommands:
      capture           capture a large audit/instruction verbatim (mutating)
      status <SRC>      read-only projection (identity, work, coverage)
      show <SRC>        forensic body retrieval (active or archived)
      recover           read-only orphan-receipt crash diagnostic
      req <SRC> <RID> <class> [--when-environment HOST] <text...>
      disp <SRC> <RID> <DISPOSITION> [--work T-x] [--evidence E-y]
           [--environment HOST]
      quarantine <SRC> [--reason CODE]
                        retain exact local authority; exclude body from export
      close <SRC>       close ONLY when coverage is terminal (mutating)
      archive <SRC>     move a CLOSED receipt to cold storage (mutating)
      purge <SRC>       hard purge, tombstone retained (mutating, explicit)
      retire <SRC>      retire a STALE, non-actionable receipt: cold copy of
                        the original bytes, tombstone out of CURRENT gating
                        (mutating; reason classes in SOURCES.md)

    SOURCE BODY IS DATA: captured text is never routed as a command.
    """
    from saipen_engine import intake

    if not args:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail":                 "source needs a subcommand: capture|status|show|req|"
                "disp|quarantine|link|close|archive|purge|retire|recover|"
                "append|apply-append|appends",
            },
            as_json,
        )
        return 2
    action = args[0]
    rest = args[1:]
    if action in ("append", "apply-append", "appends"):
        return _source_append_command(project_root, action, rest, as_json, dry_run)
    if action == "retire":
        # T-1434 M3 / SRC-088: receipt-only retirement. Eligibility proves the
        # reason class and that no unresolved actionable requirement is being
        # discarded; the original body bytes are preserved verbatim in cold
        # storage and the tombstone leaves CURRENT gating in ONE journaled
        # transaction.
        _opts, _pos, _opt_err = _parse_value_options(
            rest[1:],
            {"--reason": "reason", "--successor": "successor", "--note": "note"},
        )
        _retire_usage = (
            "source retire needs <SRC-###> --reason EMPTY_STALE_SOURCE|"
            "STALE_CREDENTIAL|SUPERSEDED_SOURCE|ORPHANED_RECEIPT|"
            "MISROUTED_PROJECT_BINDING [--successor SRC-###] [--note TEXT]"
        )
        if not rest or not re.fullmatch(r"SRC-\d+", rest[0], re.IGNORECASE):
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _retire_usage}, as_json)
            return 2
        if _opt_err:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _opt_err}, as_json)
            return 2
        if _pos:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"source retire takes <SRC-###>; surplus: {' '.join(_pos)}",
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        from saipen_engine.operations import retire_source as _retire_source

        result = _retire_source(
            project_root,
            rest[0].upper(),
            _agent_for(project_root),
            reason=str(_opts.get("reason") or ""),
            successor=_opts.get("successor") or None,
            note=_opts.get("note") or None,
            dry_run=dry_run,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if action == "link":
        # T-1437: canonical multi-work membership. ONE source receipt may
        # legitimately produce several Work items; this adds ONE Work to the
        # durable membership without moving the historical primary.
        _opts, _pos, _opt_err = _parse_value_options(
            rest[1:], {"--work": "work"}
        )
        _link_usage = (
            "source link needs <SRC-###> --work T-### "
            "(adds one Work to the receipt's durable membership)"
        )
        if not rest or not re.fullmatch(r"SRC-\d+", rest[0], re.IGNORECASE):
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _link_usage}, as_json)
            return 2
        if _opt_err:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _opt_err}, as_json)
            return 2
        if _pos:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"source link takes <SRC-###>; surplus: {' '.join(_pos)}",
                },
                as_json,
            )
            return 2
        if not str(_opts.get("work") or "").strip():
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _link_usage}, as_json)
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        from saipen_engine import intake as _intake_mod

        receipt_id = rest[0].upper()
        work_id = str(_opts.get("work") or "").strip()
        if dry_run:
            meta = (
                _intake_mod._read_meta(project_root, receipt_id)
                if _intake_mod._valid_receipt_id(receipt_id)
                else None
            )
            if meta is None:
                _emit(
                    {
                        "ok": False,
                        "code": "SOURCE_RECEIPT_MISSING",
                        "detail": f"{receipt_id} is not on the active intake surface",
                    },
                    as_json,
                )
                return 1
            members = sorted(_intake_mod.linked_works(meta))
            _emit(
                {
                    "ok": True,
                    "code": "DRY_RUN_PLAN",
                    "receipt": receipt_id,
                    "work": work_id,
                    "linked_work": meta.get("linked_work"),
                    "linked_works": members,
                    "would_add": work_id not in members,
                    "writes": 0,
                },
                as_json,
            )
            return 0
        resolved = _intake_mod.link_work_to(project_root, receipt_id, work_id)
        _emit(resolved, as_json)
        return 0 if resolved.get("ok") else 1
    # CORE-002 (audit fdc73e06): dry-run is one semantic PLAN path, not a
    # short-circuit. Refusals at parsing/validation stage are returned for
    # invalid input the same way under dry-run; valid requests are PLANned
    # with concrete target paths, zero writes, and the canonical mutator is
    # NOT invoked. The old `SOURCE_DRY_RUN` early-return certified invalid
    # input as successful, which is removed here.
    if action in ("capture", "close", "archive", "purge", "req", "disp", "quarantine"):
        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)

    if dry_run and action in (
        "capture", "close", "archive", "purge", "req", "disp", "quarantine"
    ):
        return _source_dry_run_plan(project_root, action, rest, as_json)

    if action == "capture":
        # Body from --file, stdin (piped), or positional args. Recognized
        # flags are removed wherever they appear; `--` makes all following
        # tokens opaque body data.
        transport_transform = "none"
        kind = "user_instruction"
        work = None
        amends = None
        file_path = None
        body_tokens = []
        opaque = False
        i = 0
        while i < len(rest):
            token = rest[i]
            if opaque:
                body_tokens.append(token)
                i += 1
                continue
            if token == "--":
                opaque = True
                i += 1
                continue
            if token in ("--file", "--kind", "--work", "--amends"):
                if i + 1 >= len(rest):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": f"{token} needs a value",
                        },
                        as_json,
                    )
                    return 2
                value = rest[i + 1]
                if token == "--file":
                    file_path = value
                elif token == "--kind":
                    kind = value
                elif token == "--work":
                    work = value
                else:
                    amends = value
                i += 2
                continue
            if token.startswith("--"):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unknown flag {token!r}",
                    },
                    as_json,
                )
                return 2
            body_tokens.append(token)
            i += 1
        if file_path and body_tokens:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": ("source capture accepts either --file or body text, not both"),
                },
                as_json,
            )
            return 2
        if file_path:
            try:
                body = Path(file_path).read_bytes().decode("utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"cannot read file: {exc}",
                    },
                    as_json,
                )
                return 1
        else:
            if not body_tokens and not sys.stdin.isatty():
                try:
                    body = sys.stdin.buffer.read().decode("utf-8")
                except UnicodeDecodeError as exc:
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": f"stdin is not UTF-8: {exc}",
                        },
                        as_json,
                    )
                    return 1
            elif body_tokens:
                body = " ".join(body_tokens)
                transport_transform = "argv_join_spaces"
            else:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": ("source capture needs a body (args, --file, or piped stdin)"),
                    },
                    as_json,
                )
                return 2
        result = intake.capture(
            project_root,
            body,
            source_kind=kind,
            work=work,
            amends=amends,
            transport_transform=transport_transform,
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    if action == "status":
        if len(rest) != 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source status needs <SRC-ID>",
                },
                as_json,
            )
            return 2
        result = intake.status(project_root, rest[0])
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    if action == "recover":
        if rest:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source recover accepts no arguments",
                },
                as_json,
            )
            return 2
        _emit(intake.recover_orphans(project_root), as_json)
        return 0

    if action == "show":
        if len(rest) != 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source show needs <SRC-ID>",
                },
                as_json,
            )
            return 2
        result = intake.read_body(project_root, rest[0])
        if as_json:
            _emit(result, True)
            return 0 if result.get("ok") else 1
        if not result.get("ok"):
            _emit(result, as_json)
            return 1
        print(result["body"])
        return 0

    if action == "req":
        if len(rest) < 4:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source req needs <SRC> <RID> <class> <text...>",
                },
                as_json,
            )
            return 2
        receipt_id, rid, clause_class = rest[0], rest[1], rest[2]
        when_environment = None
        text_tokens = rest[3:]
        if text_tokens[:1] == ["--when-environment"]:
            if len(text_tokens) < 3:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "--when-environment needs HOST and clause text",
                    },
                    as_json,
                )
                return 2
            when_environment = text_tokens[1]
            text_tokens = text_tokens[2:]
        text = " ".join(text_tokens)
        result = intake.add_requirement(
            project_root,
            receipt_id,
            rid=rid,
            text=text,
            clause_class=clause_class,
            when_environment=when_environment,
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    if action == "disp":
        if len(rest) < 3:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": (
                        "source disp needs <SRC> <RID> <DISPOSITION> [--work T-x] [--evidence E-y]"
                    ),
                },
                as_json,
            )
            return 2
        receipt_id, rid, disposition = rest[0], rest[1], rest[2]
        work = evidence = verification = environment = None
        i = 3
        while i < len(rest):
            if rest[i] == "--work" and i + 1 < len(rest):
                work = rest[i + 1]
                i += 2
            elif rest[i] == "--evidence" and i + 1 < len(rest):
                evidence = rest[i + 1]
                i += 2
            elif rest[i] == "--verification" and i + 1 < len(rest):
                verification = rest[i + 1]
                i += 2
            elif rest[i] == "--environment" and i + 1 < len(rest):
                environment = rest[i + 1]
                i += 2
            else:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unknown flag {rest[i]!r}",
                    },
                    as_json,
                )
                return 2
        result = intake.set_disposition(
            project_root,
            receipt_id,
            rid,
            disposition,
            work=work,
            evidence=evidence,
            verification=verification,
            environment=environment,
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    if action == "close":
        if len(rest) != 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source close needs <SRC-ID>",
                },
                as_json,
            )
            return 2
        result = intake.close_receipt(project_root, rest[0])
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    if action == "quarantine":
        reason = "OPERATOR_MARKED"
        if len(rest) == 1:
            receipt_id = rest[0]
        elif len(rest) == 3 and rest[1] == "--reason":
            receipt_id, reason = rest[0], rest[2]
        else:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source quarantine needs <SRC-ID> [--reason CODE]",
                },
                as_json,
            )
            return 2
        result = intake.quarantine_receipt(project_root, receipt_id, reason=reason)
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    if action == "archive":
        if len(rest) != 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source archive needs <SRC-ID>",
                },
                as_json,
            )
            return 2
        result = intake.archive_receipt(project_root, rest[0])
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    if action == "purge":
        if len(rest) != 2 or rest[1] != "--confirm":
            _emit(
                {
                    "ok": False,
                    "code": "CONFIRMATION_REQUIRED",
                    "detail": "source purge needs <SRC-ID> --confirm",
                },
                as_json,
            )
            return 2
        result = intake.purge_receipt(project_root, rest[0])
        _emit(result, as_json)
        return 0 if result.get("ok") else 1

    _emit(
        {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"unknown source subcommand {action!r}",
        },
        as_json,
    )
    return 2


def _source_dry_run_plan(project_root: Path, action: str, rest: list[str], as_json: bool) -> int:
    """CORE-002: semantic PLAN for a source mutation under --dry-run.

    Parses and validates the request exactly like the real mutation path
    (same refusal classes), computes the concrete planned target paths from
    the live project state, and returns a structured plan with ZERO writes.
    """
    from saipen_engine import intake

    if action == "req":
        if len(rest) < 4:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source req needs <SRC> <RID> <class> <text...>",
                },
                as_json,
            )
            return 2
        receipt_id, rid, clause_class = rest[0], rest[1], rest[2]
        when_environment = None
        text_tokens = rest[3:]
        if text_tokens[:1] == ["--when-environment"]:
            if len(text_tokens) < 3:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "--when-environment needs HOST and clause text",
                    },
                    as_json,
                )
                return 2
            when_environment = text_tokens[1]
            text_tokens = text_tokens[2:]
        text = " ".join(text_tokens)
        if not re.fullmatch(r"SRC-\d+", receipt_id):
            _emit({"ok": False, "code": "INVALID_ID", "detail": receipt_id}, as_json)
            return 1
        if not text.strip():
            _emit(
                {"ok": False, "code": "VALIDATION_FAILED", "detail": "empty clause text"},
                as_json,
            )
            return 1
        if when_environment is not None and not re.fullmatch(r"[a-z0-9_-]+", when_environment):
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"invalid environment identity {when_environment!r}",
                },
                as_json,
            )
            return 1
        from saipen_engine.intake import CLAUSE_CLASSES

        if clause_class not in CLAUSE_CLASSES:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"unknown clause class {clause_class!r}",
                },
                as_json,
            )
            return 1
        contract = intake._read_contract(Path(project_root), receipt_id)
        if not contract:
            _emit(
                {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id},
                as_json,
            )
            return 1
        new_revision = int(contract.get("interpretation_revision", 0)) + 1
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "req",
                "receipt": receipt_id,
                "rid": f"{receipt_id}:{rid}" if re.fullmatch(r"R\d+", rid) else rid,
                "revision": new_revision,
                "when_environment": when_environment,
                "targets": [
                    f".saipen/intake/contracts/{receipt_id}.json",
                    f".saipen/intake/contracts/{receipt_id}.r{new_revision:03d}.json",
                    f".saipen/intake/coverage/{receipt_id}.json",
                ],
                "detail": "planned Contract + immutable revision + coverage commit; no writes",
            },
            as_json,
        )
        return 0
    if action == "disp":
        if len(rest) < 3:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source disp needs <SRC> <RID> <DISPOSITION>",
                },
                as_json,
            )
            return 2
        receipt_id, rid, disposition = rest[0], rest[1], rest[2]
        work = evidence = verification = environment = None
        i = 3
        while i < len(rest):
            if rest[i] in ("--work", "--evidence", "--verification", "--environment"):
                if i + 1 >= len(rest):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": f"{rest[i]} needs a value",
                        },
                        as_json,
                    )
                    return 2
                value = rest[i + 1]
                if rest[i] == "--work":
                    work = value
                elif rest[i] == "--evidence":
                    evidence = value
                elif rest[i] == "--verification":
                    verification = value
                else:
                    environment = value
                i += 2
                continue
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"unknown flag {rest[i]!r}",
                },
                as_json,
            )
            return 2
        from saipen_engine.intake import ALL_DISPOSITIONS

        if disposition not in ALL_DISPOSITIONS:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"disposition {disposition!r}",
                },
                as_json,
            )
            return 1
        if disposition == "UNAVAILABLE_ENVIRONMENT":
            contract = intake._read_contract(Path(project_root), receipt_id) or {}
            full_rid = f"{receipt_id}:{rid}" if re.fullmatch(r"R\d+", rid) else rid
            clause = (contract.get("clauses") or {}).get(full_rid) or {}
            if not environment or clause.get("when_environment") != environment:
                _emit(
                    {
                        "ok": False,
                        "code": "ENVIRONMENT_WAIVER_REFUSED",
                        "detail": (
                            "UNAVAILABLE_ENVIRONMENT requires a matching structured "
                            "when_environment clause and --environment probe"
                        ),
                    },
                    as_json,
                )
                return 1
            probed = intake._probe_environment_absence(environment)
            if not probed.get("ok"):
                _emit(probed, as_json)
                return 1
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "disp",
                "receipt": receipt_id,
                "rid": rid,
                "disposition": disposition,
                "work": work,
                "evidence": evidence,
                "verification": verification,
                "environment": environment,
                "targets": [f".saipen/intake/coverage/{receipt_id}.json"],
                "detail": "planned coverage ledger update; no writes",
            },
            as_json,
        )
        return 0
    if action == "capture":
        has_body = bool(rest) or (not sys.stdin.isatty())
        if not has_body:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source capture needs a body (args, --file, or piped stdin)",
                },
                as_json,
            )
            return 2
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "capture",
                "targets": [
                    ".saipen/intake/active/SRC-NNN.md",
                    ".saipen/intake/active/SRC-NNN.meta.json",
                    ".saipen/intake/index.json",
                ],
                "detail": "planned immutable source body + metadata + index; no writes",
            },
            as_json,
        )
        return 0
    if action == "quarantine":
        reason = "OPERATOR_MARKED"
        if len(rest) == 1:
            receipt_id = rest[0]
        elif len(rest) == 3 and rest[1] == "--reason":
            receipt_id, reason = rest[0], rest[2]
        else:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source quarantine needs <SRC-ID> [--reason CODE]",
                },
                as_json,
            )
            return 2
        if not re.fullmatch(r"SRC-\d+", receipt_id):
            _emit({"ok": False, "code": "INVALID_ID", "detail": receipt_id}, as_json)
            return 1
        if not re.fullmatch(r"[A-Z][A-Z0-9_-]{0,63}", reason):
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "quarantine reason must match [A-Z][A-Z0-9_-]{0,63}",
                },
                as_json,
            )
            return 1
        projection = intake.distribution_status(Path(project_root), receipt_id)
        if not projection.get("ok"):
            _emit(projection, as_json)
            return 1
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "quarantine",
                "receipt": receipt_id,
                "reason": reason,
                "targets": [
                    f".saipen/quarantine/source/{receipt_id}.md",
                    f".saipen/intake/distribution/{receipt_id}.json",
                ],
                "detail": "planned exact-body relocation + distribution record; no writes",
            },
            as_json,
        )
        return 0
    if action == "close":
        if len(rest) != 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source close needs <SRC-ID>",
                },
                as_json,
            )
            return 2
        receipt_id = rest[0]
        meta = intake._read_meta(Path(project_root), receipt_id)
        if not meta:
            _emit(
                {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id},
                as_json,
            )
            return 1
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "close",
                "receipt": receipt_id,
                "targets": [
                    f".saipen/archive/source/{receipt_id}.md",
                    f".saipen/archive/source/{receipt_id}.meta.json",
                    f".saipen/archive/source/{receipt_id}.coverage.json",
                    f".saipen/archive/source/{receipt_id}.contract.json",
                    f".saipen/intake/tombstones/{receipt_id}.json",
                    ".saipen/intake/index.json",
                ],
                "detail": "planned archive bundle + tombstone + index; no writes",
            },
            as_json,
        )
        return 0
    if action == "archive":
        if len(rest) != 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "source archive needs <SRC-ID>",
                },
                as_json,
            )
            return 2
        receipt_id = rest[0]
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "archive",
                "receipt": receipt_id,
                "targets": [
                    f".saipen/archive/source/{receipt_id}.md",
                    f".saipen/archive/source/{receipt_id}.meta.json",
                    f".saipen/archive/source/{receipt_id}.coverage.json",
                    f".saipen/archive/source/{receipt_id}.contract.json",
                    f".saipen/intake/tombstones/{receipt_id}.json",
                    ".saipen/intake/index.json",
                ],
                "detail": "planned archive move + tombstone + index; no writes",
            },
            as_json,
        )
        return 0
    if action == "purge":
        if len(rest) != 2 or rest[1] != "--confirm":
            _emit(
                {
                    "ok": False,
                    "code": "CONFIRMATION_REQUIRED",
                    "detail": "source purge needs <SRC-ID> --confirm",
                },
                as_json,
            )
            return 2
        receipt_id = rest[0]
        index = intake._read_index(Path(project_root))
        tomb = index.get("tombstones", {}).get(receipt_id)
        if not tomb:
            _emit(
                {"ok": False, "code": "TICKET_NOT_FOUND", "detail": receipt_id},
                as_json,
            )
            return 1
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "purge",
                "receipt": receipt_id,
                "targets": [
                    f".saipen/archive/source/{receipt_id}.md",
                    f".saipen/archive/source/{receipt_id}.meta.json",
                    f".saipen/archive/source/{receipt_id}.coverage.json",
                    f".saipen/archive/source/{receipt_id}.contract.json",
                    f".saipen/intake/tombstones/{receipt_id}.json",
                    ".saipen/intake/index.json",
                ],
                "detail": "planned destructive archive purge + tombstone + index; no writes",
            },
            as_json,
        )
        return 0
    _emit(
        {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"unknown source subcommand {action!r}",
        },
        as_json,
    )
    return 2


def _context(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """saipen context cold|hot|audit|orient (read-only)."""
    if not args:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "context needs a mode: cold|hot|audit|orient",
            },
            as_json,
        )
        return 2
    mode = args[0]
    handoff_path = None
    surplus = args[1:]
    if mode == "orient" and surplus[:1] == ["--handoff"] and len(surplus) >= 2:
        handoff_path = surplus[1]
        surplus = surplus[2:]
    if surplus:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"context {mode} has surplus: {' '.join(surplus)}",
            },
            as_json,
        )
        return 2
    if mode == "orient":
        from saipen_engine.cold_truth import orientation_projection, render_orientation

        result = orientation_projection(project_root, handoff_path=handoff_path)
        if as_json or not result.get("ok"):
            _emit(result, as_json)
        else:
            print(render_orientation(result), end="")
        return 0 if result.get("ok") else 1
    from saipen_engine.context import context_audit, context_cold, context_hot
    from saipen_engine.log import HistoryOwnershipError

    fn = {"cold": context_cold, "hot": context_hot, "audit": context_audit}.get(mode)
    if fn is None:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"unknown context mode {mode!r}; use cold|hot|audit|orient",
            },
            as_json,
        )
        return 2
    try:
        # Second-wave P0: the projection routes as the SESSION agent, so
        # `context hot --agent B` reports A's live claim as FOREIGN instead of
        # impersonating A. audit has no routing surface and takes no agent.
        if mode == "audit":
            result = fn(project_root)
        else:
            result = fn(project_root, current_agent=_agent_for(project_root))
    except (HistoryOwnershipError, OSError) as exc:
        # Deterministic read-only failure contract (second-wave P1): a
        # symlinked/unreadable history node or canonical file must surface as
        # structured VALIDATION_FAILED with the reason, never a traceback.
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"history-ownership: {type(exc).__name__}: {exc}",
            },
            as_json,
        )
        return 1
    if as_json:
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if not result.ok:
        _emit(result.to_dict(), as_json)
        return 1
    if mode == "audit":
        import json

        payload = result.to_dict()
        payload.pop("ok", None)
        payload.pop("code", None)
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    else:
        print(result.get("surface", ""), end="")
    return 0


def _knowledge(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """Optional structured KNOWLEDGE cards and their deletable projection."""
    from saipen_engine.knowledge import retrieve, validate_knowledge, write_index

    if not args or args[0] not in ("status", "index", "retrieve"):
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "knowledge needs status | index | retrieve <objective>",
            },
            as_json,
        )
        return 2
    action, rest = args[0], args[1:]
    if action in ("status", "index") and rest:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"knowledge {action} accepts no arguments; surplus: {' '.join(rest)}",
            },
            as_json,
        )
        return 2
    if action == "retrieve" and not " ".join(rest).strip():
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "knowledge retrieve needs an objective",
            },
            as_json,
        )
        return 2
    if action == "status":
        status = validate_knowledge(project_root)
        payload = {"ok": not status["errors"], "code": "KNOWLEDGE_STATUS", **status}
        _emit(payload, as_json)
        return 0 if payload["ok"] else 1
    if action == "retrieve":
        result = retrieve(project_root, " ".join(rest))
        payload = {
            "ok": not result.get("error"),
            "code": "VALIDATION_FAILED" if result.get("error") else "KNOWLEDGE_RETRIEVED",
            "objective": " ".join(rest),
            **result,
        }
        _emit(payload, as_json)
        return 0 if payload["ok"] else 1
    if not dry_run and _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)
    _ho = _ensure_handover(project_root, as_json, dry_run)
    if _ho is not None:
        return _ho
    payload = write_index(project_root, dry_run=dry_run)
    _emit(payload, as_json)
    return 0 if payload.get("ok") else 1


def _attempt(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """saipen attempt open|close (T-1148, journaled Work/Attempt lifecycle)."""
    from saipen_engine.attempt import RESULTS, RESULT_STOP_MATRIX, STOP_REASONS

    if not args or args[0] not in ("open", "close"):
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "attempt needs an action: open | close <RESULT> <STOP> "
                "[--evidence E-1,E-2] [--unknown 'text']",
            },
            as_json,
        )
        return 2
    action = args[0]
    rest = args[1:]
    result = stop = None
    evidence: list[str] = []
    unknown: str | None = None
    if action == "close":
        positional: list[str] = []
        i = 0
        while i < len(rest):
            arg = rest[i]
            if arg == "--evidence":
                if i + 1 >= len(rest):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "dangling --evidence option",
                        },
                        as_json,
                    )
                    return 2
                evidence = [e.strip() for e in rest[i + 1].split(",") if e.strip()]
                i += 2
            elif arg == "--unknown":
                if i + 1 >= len(rest):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "dangling --unknown option",
                        },
                        as_json,
                    )
                    return 2
                unknown = rest[i + 1]
                i += 2
            elif arg.startswith("--"):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unknown option {arg}",
                    },
                    as_json,
                )
                return 2
            else:
                positional.append(arg)
                i += 1
        if len(positional) != 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "attempt close takes exactly <RESULT> <STOP> "
                    f"(surplus/missing: {' '.join(positional)})",
                },
                as_json,
            )
            return 2
        result, stop = positional
    elif rest:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"attempt open accepts no arguments; surplus: {' '.join(rest)}",
                "canonical_next_command": "saipen attempt open",
            },
            as_json,
        )
        return 2

    # Fail fast on the closed vocabularies BEFORE any capability/mutation work,
    # so a typo'd result never burns an op_id or a DEC.
    if action == "close":
        if result not in RESULTS:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"result {result!r} outside the closed vocabulary "
                    f"{'|'.join(RESULTS)}",
                },
                as_json,
            )
            return 2
        if stop not in STOP_REASONS:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"stop reason {stop!r} outside the closed vocabulary "
                    f"{'|'.join(STOP_REASONS)}",
                },
                as_json,
            )
            return 2
        if stop not in RESULT_STOP_MATRIX[result]:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"result {result} cannot pair with stop {stop}; "
                    f"allowed stops: {'|'.join(RESULT_STOP_MATRIX[result])}",
                },
                as_json,
            )
            return 2

    if not dry_run and _negotiate_capability(project_root) == "read-only":
        return _capability_refusal(as_json)
    _ho = _ensure_handover(project_root, as_json, dry_run)
    if _ho is not None:
        return _ho
    from saipen_engine.operations import attempt_lifecycle

    out = attempt_lifecycle(
        project_root,
        _agent_for(project_root),
        action,
        result=result,
        stop=stop,
        evidence=evidence or None,
        unknown=unknown,
        dry_run=dry_run,
    )
    payload = out.to_dict() if hasattr(out, "to_dict") else dict(out)
    _emit(payload, as_json)
    return 0 if payload.get("ok") else 1


def _acceptance(project_root: Path, args: list[str], as_json: bool) -> int:
    """`saipen acceptance <T-###>` -- what was promised, what proves it.

    READ-ONLY by construction, not by discipline: it opens BOARD and LOG, and
    there is no write path in this function or in the module it calls. The
    projection rebuilds on every run, so it holds no state that could go stale
    on its own, and it creates no authority -- a criterion reported SATISFIED
    is a statement about the evidence found, never a gate anything passes.
    """
    from saipen_engine.acceptance import reconcile, render
    from saipen_engine.board import parse_board
    from saipen_engine.log import parse_log_line

    positional = [a for a in args if a != "--json"]
    if len(positional) != 1 or not re.fullmatch(r"T-\d+", positional[0]):
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "usage: saipen acceptance <T-###>",
            },
            as_json,
        )
        return 2
    ticket_id = positional[0]

    saipen_dir = project_root / ".saipen"
    board_path = saipen_dir / "BOARD.md"
    if not board_path.is_file():
        _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": "BOARD.md missing"}, as_json)
        return 2

    board = parse_board(board_path.read_text(encoding="utf-8-sig", errors="replace"))
    ticket = board.get("tickets", {}).get(ticket_id)
    if ticket is None:
        _emit(
            {
                "ok": False,
                "code": "TICKET_NOT_FOUND",
                "detail": f"{ticket_id} is not on the board",
                "ticket": ticket_id,
            },
            as_json,
        )
        return 2

    events = []
    segments = (
        sorted((saipen_dir / "logs").glob("LOG-*.md")) if (saipen_dir / "logs").is_dir() else []
    )
    for path in [*segments, saipen_dir / "LOG.md"]:
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            parsed = parse_log_line(line)
            if parsed is not None:
                events.append(parsed)

    projection = reconcile(ticket_id, ticket.get("fields", {}).get("verify", ""), events)
    if as_json:
        _emit({"ok": True, "code": "ACCEPTANCE", **projection}, as_json)
    else:
        print(render(projection))
    return 0


_GPU_USAGE = (
    "saipen gpu [status|on|off|index [--budget SECONDS]|recall <text> [--k N]|triage] [--json]"
)


def _gpu(project_root: Path, args: list[str], as_json: bool) -> int:
    """saipen gpu: the idle-GPU recall lane (SAIGPU). Default OFF; advisory only.

    Every write is under .saipen/cache/gpu/ -- a git-ignored runtime cache, never
    canonical state -- which is why the verb is DIAGNOSTIC.
    """
    from saipen_engine import gpu as _gpu_lane

    args = [a for a in args if a != "--json"]
    action = args[0] if args else "status"
    rest = args[1:]

    def refuse(detail: str) -> int:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": detail,
                "canonical_next_command": _GPU_USAGE,
            },
            as_json,
        )
        return 2

    if action == "status" and not rest:
        _gpu_out(_gpu_lane.status(project_root), as_json)
        return 0
    if action in ("on", "off") and not rest:
        config = _gpu_lane.set_enabled(project_root, action == "on")
        payload = _gpu_lane.status(project_root)
        payload.update({"code": "GPU_SWITCH", "config": config})
        if action == "on" and payload["hardware"] != _gpu_lane.READY:
            payload["note"] = (
                f"switch is ON; the lane waits until the hardware answers READY "
                f"(now {payload['hardware']})"
            )
        _gpu_out(payload, as_json)
        return 0
    if action == "index":
        budget = 300.0
        if rest[:1] == ["--budget"] and len(rest) == 2:
            try:
                budget = float(rest[1])
            except ValueError:
                return refuse(f"--budget needs seconds, got {rest[1]!r}")
        elif rest:
            return refuse(f"gpu index: unknown argument(s) {' '.join(rest)}")
        verdict = _gpu_lane.gate(project_root)
        if not verdict["ok"]:
            _emit(
                {
                    "ok": False,
                    "code": "GPU_LANE_UNAVAILABLE",
                    "reason": verdict["reason"],
                    "detail": f"the GPU lane is not usable now: {verdict['reason']}",
                    "canonical_next_command": "saipen gpu status",
                },
                as_json,
            )
            return 1
        result = _gpu_lane.refresh_index(project_root, budget_s=budget)
        _gpu_out({**result, "ok": True, "complete": result["ok"]}, as_json)
        return 0
    if action == "triage" and not rest:
        result = _gpu_lane.triage(project_root)
        if result.get("stop") == _gpu_lane.DISABLED:
            _emit(
                {
                    "ok": False,
                    "code": "GPU_LANE_UNAVAILABLE",
                    "reason": _gpu_lane.DISABLED,
                    "detail": "the GPU lane is not usable now: DISABLED",
                    "canonical_next_command": "saipen gpu on",
                },
                as_json,
            )
            return 1
        _gpu_out({**result, "ok": True, "complete": result["ok"]}, as_json)
        return 0
    if action == "recall":
        k = 5
        if "--k" in rest:
            at = rest.index("--k")
            try:
                k = int(rest[at + 1])
            except (IndexError, ValueError):
                return refuse("--k needs a whole number")
            rest = rest[:at] + rest[at + 2 :]
        text = " ".join(rest).strip()
        if not text:
            return refuse("gpu recall needs <text>")
        answer = _gpu_lane.recall(project_root, text, k=k)
        if not answer["ok"]:
            _emit(
                {
                    **answer,
                    "detail": f"no recall: {answer['reason']}",
                    # T-1482: the route out depends on why there is no answer.
                    "canonical_next_command": {
                        _gpu_lane.DISABLED: "saipen gpu on",
                        "EMPTY_INDEX": "saipen gpu index",
                        "INDEX_MODEL_MISMATCH": "saipen gpu index",
                    }.get(answer["reason"], "saipen gpu status"),
                },
                as_json,
            )
            return 1
        _gpu_out(answer, as_json)
        return 0
    return refuse(f"gpu: unknown action {' '.join(args)!r}")


def _gpu_out(payload: dict, as_json: bool) -> None:
    """The gpu verb's own compact human rendering; --json is the full payload."""
    if as_json:
        _emit(payload, as_json)
        return
    print(f"code: {payload.get('code')}")
    if "enabled" in payload:
        print(f"switch: {'ON' if payload['enabled'] else 'OFF'} ({payload.get('switch')})")
        print(f"lane: {payload.get('lane')}  hardware: {payload.get('hardware')}")
        card = payload.get("gpu") or {}
        if card:
            print(
                f"gpu: {card.get('name')}  busy {card.get('utilization_percent')}%  "
                f"free {card.get('memory_free_mib')}/{card.get('memory_total_mib')} MiB"
            )
        backend = payload.get("backend") or {}
        if backend:
            state = "up" if backend.get("up") else "down"
            print(f"backend: {state}  model: {payload.get('embed_model')}")
        index = payload.get("index") or {}
        print(
            f"index: {index.get('items', 0)} items {index.get('by_kind') or {}}  "
            f"updated {index.get('updated_at')}"
        )
        if payload.get("note"):
            print(f"note: {payload['note']}")
    for key in (
        "stop",
        "embedded",
        "pending",
        "indexed",
        "seconds",
        "file",
        "groups",
        "annotated",
        "covered_ids",
    ):
        if key in payload:
            print(f"{key}: {payload[key]}")
    for hit in payload.get("hits") or []:
        print(f"{hit['score']:.3f}  {hit['kind']:<11} {hit['ref']}  {hit['preview'][:100]}")
    if payload.get("advisory"):
        print(payload["advisory"])


def _gpu_echo_advisory(project_root: Path, text: str, new_ticket: str) -> None:
    """ADVISORY on stderr: existing Work that nearly echoes the new ticket.

    Silent unless the GPU lane is ON and indexed; never changes the result,
    the exit code or stdout.
    """
    try:
        from saipen_engine import gpu as _gpu_lane

        hits = _gpu_lane.echo_advisory(project_root, text, exclude=new_ticket or None)
    except Exception:
        return
    for hit in hits:
        print(
            f"{_gpu_lane.ADVISORY}: {new_ticket or 'the new Work'} may echo "
            f"{hit['ref']} (similarity {hit['score']}); if so, supersede one of them",
            file=sys.stderr,
        )


def _autonomy_recall(project_root: Path, args: list[str], as_json: bool) -> int:
    """saipen autonomy recall (T-1446): AUTO_RECALL + the turn-entry decision.

    Read-only. The host passes what only the host knows -- host, session,
    provider, model, the previous incarnation and the latest user message
    identity -- as ONE JSON carrier (``--carrier-json`` or, for shells that
    cannot carry it, ``--carrier-hex``). ``--directive`` adds the bounded text
    a host puts in front of every model request.
    """
    from saipen_engine.cold_recovery import auto_recall, render_directive

    carrier: dict = {}
    directive = False
    index = 0
    while index < len(args):
        token = args[index]
        if token == "--json":
            index += 1
            continue
        if token == "--directive":
            directive = True
            index += 1
            continue
        if token in ("--carrier-json", "--carrier-hex") and index + 1 < len(args):
            raw = args[index + 1]
            try:
                text = bytes.fromhex(raw).decode("utf-8") if token == "--carrier-hex" else raw
                parsed = json.loads(text)
            except (ValueError, UnicodeDecodeError) as exc:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"{token} is not one JSON object: {exc}",
                    },
                    as_json,
                )
                return 2
            if not isinstance(parsed, dict):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"{token} must be an object",
                    },
                    as_json,
                )
                return 2
            carrier = parsed
            index += 2
            continue
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"autonomy recall: unknown argument {token!r}",
                "canonical_next_command": "saipen autonomy recall --json",
            },
            as_json,
        )
        return 2
    recall = auto_recall(project_root, carrier)
    payload = {"ok": True, "code": "AUTO_RECALL", **recall}
    if directive:
        payload["directive"] = render_directive(recall)
    if as_json:
        _emit(payload, as_json)
    else:
        print(render_directive(recall))
    return 0


def _brief(project_root: Path, as_json: bool) -> int:
    """saipen brief (T-1148): derived cold-handoff projection. Read-only."""
    from saipen_engine.context import brief_projection
    from saipen_engine.log import HistoryOwnershipError

    try:
        result = brief_projection(project_root)
    except (HistoryOwnershipError, OSError) as exc:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"history-ownership: {type(exc).__name__}: {exc}",
            },
            as_json,
        )
        return 1
    if not result.ok:
        _emit(result.to_dict(), as_json)
        return 1
    if as_json:
        _emit(result.get("json"), as_json)
    else:
        print(result.get("surface", ""), end="")
    return 0


def _userperson_scope(args: list[str]) -> tuple[str, list[str], str | None]:
    """Extract one USERPERSON scope regardless of flag position."""
    flags = [item for item in args if item in ("--project", "--global", "--effective")]
    unique = set(flags)
    if len(flags) != len(unique) or len(unique) > 1:
        return "", args, "choose exactly one of --project, --global, or --effective"
    scope = flags[0][2:] if flags else "project"
    return scope, [item for item in args if item not in unique], None


def _userperson(project_root: Path | None, args: list[str], as_json: bool, dry_run: bool) -> int:
    """USERPERSON project/global/effective management."""
    if not args:
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "userperson needs an action: show|add|remove|reset",
            },
            as_json,
        )
        return 2
    from userperson import (
        UserpersonError,
        effective_profile,
        load_global_profile,
        load_project_profile,
        merge_profile,
        mutate_global_profile,
        profile_fingerprint,
        remove_preference,
        render_profile,
        reset_profile,
        write_profile,
    )

    action = args[0]
    scope, clean_args, scope_error = _userperson_scope(args[1:])
    if scope_error:
        _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": scope_error}, as_json)
        return 2
    args = [action, *clean_args]
    if scope == "effective" and action != "show":
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "--effective is read-only and valid only with userperson show",
            },
            as_json,
        )
        return 2
    if scope in ("project", "effective") and project_root is None:
        _emit(
            {
                "ok": False,
                "code": "NOT_SAIPEN_PROJECT",
                "detail": f"userperson --{scope} requires a bound SAIPEN project",
            },
            as_json,
        )
        return 3

    try:
        if scope == "effective":
            if len(args) != 1:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "userperson show --effective accepts no other arguments",
                    },
                    as_json,
                )
                return 2
            effective = effective_profile(project_root)
            payload = {
                "ok": True,
                "code": "SHOW",
                "scope": "effective",
                "active": effective["active"],
                "global": effective["global"],
                "project": effective["project"],
                "effective_fingerprint": effective["effective_fingerprint"],
                "preferences": effective["preferences"],
            }
            if as_json:
                _emit(payload, True)
            else:
                print("USERPERSON scope: effective")
                print(f"active: {str(effective['active']).lower()}")
                print(f"effective_fingerprint: {effective['effective_fingerprint']}")
                for preference in effective["preferences"]:
                    print(
                        f"- [{preference['category']}] {preference['text']} "
                        f"(source: {preference['source']})"
                    )
            return 0
        source = load_global_profile() if scope == "global" else load_project_profile(project_root)
    except UserpersonError as exc:
        _emit(
            {
                "ok": False,
                "code": exc.code,
                "scope": exc.scope,
                "detail": exc.detail,
            },
            as_json,
        )
        return 1
    current_text = source["text"]

    if action == "show":
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"userperson show accepts no arguments; surplus: {' '.join(args[1:])}",  # noqa: E501
                    "canonical_next_command": "saipen userperson show",
                },
                as_json,
            )
            return 2
        if as_json:
            _emit(
                {
                    "ok": True,
                    "code": "SHOW" if source["present"] else "EMPTY",
                    "scope": scope,
                    "present": source["present"],
                    "fingerprint": source["fingerprint"],
                    "preferences": source["preferences"],
                },
                as_json,
            )
        else:
            print(f"USERPERSON scope: {scope}")
            if current_text:
                from userperson import _redact_credentials

                print(_redact_credentials(current_text), end="")
        return 0

    if action == "reset":
        surplus = [a for a in args[1:] if a != "--confirm"]
        if surplus:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"userperson reset accepts only --confirm; surplus: {' '.join(surplus)}",  # noqa: E501
                },
                as_json,
            )
            return 2
        if not source["present"]:
            _emit(
                {"ok": False, "code": "TICKET_NOT_FOUND", "detail": "no profile to reset"}, as_json
            )
            return 1
        if "--confirm" not in args:
            _emit(
                {
                    "ok": False,
                    "code": "DESTRUCTIVE_CONFIRMATION_REQUIRED",
                    "detail": "userperson reset deletes the profile; pass --confirm to authorize",
                },
                as_json,
            )
            return 1
        if dry_run:
            _emit(
                {"ok": True, "code": "RESET", "scope": scope, "dry_run": True},
                as_json,
            )
            return 0
        if scope == "global":
            result = mutate_global_profile("reset")
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        # CORE says reset DELETES the profile; absence is the canonical OFF
        # state. One journaled delete_file target (real before_hash, empty
        # after_hash) -- NO post-commit unlink, so a crash between COMMIT and
        # unlink can never leave a state recovery cannot complete (T-1003
        # operational integrity). Recovery COMMITTED always means absent.
        result = reset_profile(project_root, _agent_for(project_root))
        if result.get("ok"):
            result["code"] = "RESET"
            result["scope"] = "project"
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    if action in ("add", "remove"):
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"userperson {action} needs <text>",
                },
                as_json,
            )
            return 2
        category = "general"
        category_supplied = False
        clean_args = []
        idx = 0
        while idx < len(args):
            if args[idx] == "--category":
                if idx + 1 >= len(args) or args[idx + 1].startswith("--"):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "--category needs a non-option value",
                        },
                        as_json,
                    )
                    return 2
                category = args[idx + 1]
                category_supplied = True
                idx += 2
            elif args[idx].startswith("--"):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unknown userperson option {args[idx]!r}",
                    },
                    as_json,
                )
                return 2
            else:
                clean_args.append(args[idx])
                idx += 1
        text = " ".join(clean_args[1:])
        from userperson import _redact_credentials

        text = _redact_credentials(text)
        if not text.strip():
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"userperson {action} needs non-empty text",
                },
                as_json,
            )
            return 2
        current = source["preferences"]
        if scope == "global" and action == "remove" and not source["present"]:
            _emit(
                {"ok": True, "code": "UNCHANGED", "scope": "global"},
                as_json,
            )
            return 0
        if action == "add":
            updated = merge_profile(current, [f"- [{category}] {text}"])
        else:
            updated, refusal = remove_preference(
                current, text, category if category_supplied else None
            )
            if refusal:
                _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": refusal}, as_json)
                return 1
        new_text = render_profile(updated)
        if new_text == current_text:
            _emit({"ok": True, "code": "UNCHANGED", "scope": scope}, as_json)
            return 0
        if dry_run:
            _emit(
                {
                    "ok": True,
                    "code": "PREFERENCE_PLAN",
                    "action": action,
                    "text": text,
                    "category": category if action == "add" else None,
                    "scope": scope,
                    "dry_run": True,
                },
                as_json,
            )
            return 0
        if scope == "global":
            result = mutate_global_profile(
                action,
                text=text,
                category=category if action == "add" or category_supplied else None,
            )
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = write_profile(project_root, new_text, _agent_for(project_root))
        result["scope"] = "project"
        if result.get("ok"):
            result["fingerprint"] = profile_fingerprint(new_text)
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    _emit(
        {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"unknown userperson action {action!r}",
        },
        as_json,
    )
    return 2


#: T-1363: how much of a refusal's reason the human form prints. JSON stays the
#: authority and carries everything; the human form is the cheap interface a
#: model reads first, so it says why and what next, never a payload dump.
_HUMAN_REASON_CHARS = 300


def _human_refusal_lines(payload: dict) -> list[str]:
    """`reason:` / `next:` / `then:` for a refusal, when the payload has them.

    `REFUSE [CODE]` alone was the whole human answer, while the JSON beside it
    named the exact command that would clear the refusal. A model shown only
    the code grepped the installation and asked the user about "auth".
    """
    lines: list[str] = []
    detail = payload.get("detail") or payload.get("message")
    if isinstance(detail, str) and detail.strip():
        text = " ".join(detail.split())
        if len(text) > _HUMAN_REASON_CHARS:
            text = text[: _HUMAN_REASON_CHARS - 3].rstrip() + "..."
        lines.append(f"reason: {text}")
    # T-1412: a refusal that carries the authoritative conformance block must
    # name the status it is actually refusing on -- the human form is where a
    # model reads it first.
    conformance = payload.get("conformance_status")
    if isinstance(conformance, dict) and conformance.get("status"):
        lines.append(f"conformance: {conformance['status']}")
    command = payload.get("canonical_next_command")
    if not command:
        decisions = [
            item.get("command")
            for item in payload.get("operator_decisions") or []
            if isinstance(item, dict) and item.get("command")
        ]
        command = decisions[0] if decisions else None
    if not command:
        next_action = payload.get("next_action")
        if isinstance(next_action, str) and next_action.startswith("saipen "):
            command = next_action
    if isinstance(command, str) and command.strip():
        suffix = " (operator decision)" if payload.get("operator_decision_available") else ""
        lines.append(f"next: {' '.join(command.split())}{suffix}")
    resume = payload.get("resume_command")
    if isinstance(resume, str) and resume.strip():
        lines.append(f"then: {resume}")
    return lines


def _emit(payload: dict, as_json: bool) -> None:
    # ONE public refusal shape. CLI-side refusals have always carried
    # `detail`; engine `Result` refusals carry `message`, so the same public
    # command answered "why" under two different keys depending on which layer
    # refused, and a caller had to know the internal boundary to read the
    # reason. `detail` is the published key -- fill it from `message` when the
    # engine is the refuser. `message` is preserved, never replaced.
    if not payload.get("ok") and payload.get("message") and not payload.get("detail"):
        payload = {**payload, "detail": payload["message"]}
    if _ENTRY_HINT_ROOT is not None and payload.get("ok") is not False:
        from saipen_engine import operator_task as _operator_task

        _unstarted = _operator_task.unstarted(_ENTRY_HINT_ROOT)
        if _unstarted:
            payload = {
                **payload,
                "unstarted_operator_task": {
                    "digest": _unstarted["digest"],
                    "declared_by": _unstarted["source"],
                },
                "canonical_next_command": payload.get("canonical_next_command")
                or _unstarted["command"],
                "entry_hint": (
                    "this session was launched with a task this project has not taken; "
                    "BOOT's entry table routes a new actionable task to `saipen start`"
                ),
            }
    if _TELEGRAM_ROOT is not None and as_json and "telegrams" not in payload:
        # T-1497: counts only, and data only -- the answer above was computed
        # before this line and nothing in it depends on the telegrams.
        _state_file = _TELEGRAM_ROOT / ".saipen" / "STATE.md"
        try:
            _telegram_state = parse_state(_state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _telegram_state = {}
        payload = {**payload, "telegrams": _turn_entry_telegrams(_TELEGRAM_ROOT, _telegram_state)}
    if _ROUTE_ECHO is not None:
        # Route echo: the invocation resolved through the shared shortcut
        # resolver, so every emitted payload names its canonical route. This
        # is presentation metadata only -- routing itself already happened.
        payload = {**payload, "route": _ROUTE_ECHO}
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    if not payload.get("ok"):
        print(f"REFUSE [{payload.get('code', 'ERROR')}]")
        for line in _human_refusal_lines(payload):
            print(line)
        return
    if payload.get("code") == "NOT_SAIPEN_PROJECT":
        return
    for key in (
        "action",
        "ticket",
        # T-1363: the receipt is the durable authority for the COMPLETE
        # request, and a projected BOARD row is a compact reference to it. A
        # human answer that names the ticket and hides the receipt sends a
        # reader to the row that was shortened.
        "receipt",
        "route",
        "load",
        "load_path",
        "execution_instruction",
        "phase",
        "task",
        "next_action",
        "claimed_ticket",
        "top_workable_ticket",
        "log_tail_event",
        "head",
        "pending_ops",
        "code",
    ):
        value = payload.get(key)
        if value is not None and value != []:
            print(f"{key}: {value}")
    milestone = payload.get("milestone")
    if isinstance(milestone, dict) and milestone.get("current"):
        print(f"CHECKPOINT: {milestone['current']}  {milestone.get('label') or ''}".rstrip())
        if milestone.get("parent"):
            parent_label = milestone.get("parent_label") or ""
            print(f"PARENT: {milestone['parent']}  {parent_label}".rstrip())
    if payload.get("waiting_on_you"):
        print(f"Waiting on you: {'; '.join(payload['waiting_on_you'])}")
    if payload.get("claimed_but_unproven"):
        print(f"Claimed but unproven: {', '.join(payload['claimed_but_unproven'])}")
    # T-1412: the receipt-derived `conformance_status` is the operator's PRIMARY
    # conformance truth; the LOG-derived `conformance` projection is history and
    # may never be rendered under the `Conformance:` label.
    _conformance = payload.get("conformance_status")
    if isinstance(_conformance, dict) and _conformance.get("status"):
        from saipen_engine.conformance import STATUS_CURRENT_PASS

        print(f"Conformance: {_conformance['status']}")
        if _conformance["status"] != STATUS_CURRENT_PASS:
            _disp = str(_conformance.get("disposition") or "").strip()
            if _disp:
                print(f"Disposition: {_disp}")
            _reason = str(_conformance.get("reason") or "").strip()
            if _reason:
                print(f"Reason: {_reason}")
            print("Remediation: saipen validate")
    elif payload.get("conformance"):
        print("Conformance: UNKNOWN (authoritative receipt status unavailable)")
    if payload.get("conformance"):
        print(
            f"Validator history hint: {payload['conformance']} "
            "(historical; not current authority)"
        )
    if payload.get("staleness"):
        print(f"Staleness: {payload['staleness']}")
    automation = payload.get("automation")
    if isinstance(automation, dict) and automation.get("disposition") == "COMPLETE":
        # SRC-023 (audit/10.md) §7: display-only human line. Machine truth
        # lives in the JSON automation block; consumers must never parse
        # this line -- it carries no disposition authority and prints only
        # when the mechanical eight-condition gate already passed.
        epoch = str(automation.get("audit_epoch") or "")
        fingerprint = str(automation.get("source_fingerprint") or "")
        print(f"SAIPEN_CLOSURE_COMPLETE audit={epoch[:24]} source={fingerprint[:24]}")


def _canonical_proof_levels() -> list[str]:
    """Read SAICRITIC's ordered proof vocabulary from its canonical table."""
    candidates = (HOME / "saipen" / "SAICRITIC.md", HOME / "SAICRITIC.md")
    critic = next((path for path in candidates if path.is_file()), None)
    if critic is None:
        raise ValueError("SAICRITIC.md is missing from the protocol install")
    text = critic.read_text(encoding="utf-8-sig")
    start = text.find("## What it does")
    end = text.find("\n## ", start + 3)
    section = text[start : end if end >= 0 else None]
    levels = re.findall(r"(?m)^\| ([A-Z]+) \|", section)
    if not levels or len(levels) != len(set(levels)):
        raise ValueError("SAICRITIC proof vocabulary is missing or duplicated")
    return levels


def _runtime_identity() -> str:
    """The runtime identifier supplied by the adapter/environment, else unknown
    (T-992/§5). This is an untrusted input, never mechanically detected model
    identity: it is stripped, bounded, and control-free before use, and a
    value that cannot be made safe becomes the truthful neutral 'unknown'."""
    import re as _re

    value = os.environ.get("SAIPEN_RUNTIME", "") or ""
    value = value.strip()
    if not value or len(value) > 128:
        return "unknown"
    if _re.search(r"[\x00-\x1f\x7f]", value):
        return "unknown"
    return value


def _improve_dry_run_plan(project_root: Path, action: str, rest: list[str], as_json: bool) -> int:
    """CORE-002: semantic PLAN for an improve mutator under --dry-run.

    Validates the closed grammar of `submit` / `complete` / `cycle-complete` /
    `abort` / `retire` and returns concrete planned journal/LOG/state targets
    with zero writes. The pre-improve state error surface (NOT_SAIPEN_PROJECT /
    state-malformed) is shared between dry-run and the real mutator so an
    invalid session refuses consistently.
    """
    state_path = _state_path(project_root)
    if not state_path.is_file():
        _emit({"ok": False, "code": "NOT_SAIPEN_PROJECT"}, as_json)
        return 3
    _state, state_error = parse_state_or_error(codec.read_doc(state_path))
    if state_error:
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": f"state-malformed: {state_error}"},
            as_json,
        )
        return 1
    if action == "submit":
        if len(rest) < 4:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve submit needs <cycle> <seat> <project> <findings.json>",
                },
                as_json,
            )
            return 2
        cycle, seat, project = rest[0], rest[1], rest[2]
        from improve import resolve_report_path

        report = resolve_report_path(project_root, cycle, seat, project)
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "submit",
                "cycle": cycle,
                "seat": seat,
                "project": project,
                "report": str(report),
                "targets": [str(report), ".saipen/LOG.md"],
                "detail": "planned RUN append + LOG append; no writes",
            },
            as_json,
        )
        return 0
    if action == "complete":
        if len(rest) < 3:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve complete needs <cycle> <seat> <project>",
                },
                as_json,
            )
            return 2
        cycle, seat, project = rest[0], rest[1], rest[2]
        from improve import resolve_report_path

        report = resolve_report_path(project_root, cycle, seat, project)
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "complete",
                "cycle": cycle,
                "seat": seat,
                "project": project,
                "report": str(report),
                "targets": [str(report), ".saipen/LOG.md"],
                "detail": "planned report completion + LOG append; no writes",
            },
            as_json,
        )
        return 0
    if action == "cycle-complete":
        if len(rest) < 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve cycle-complete needs <cycle>",
                },
                as_json,
            )
            return 2
        cycle = rest[0]
        cycle_root = project_root / ".saipen" / "improve" / cycle
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "cycle-complete",
                "cycle": cycle,
                "targets": [
                    str(cycle_root / "MANIFEST.md"),
                    str(cycle_root / "REPORTS"),
                    ".saipen/LOG.md",
                ],
                "detail": "planned cycle ACTIVE -> COMPLETE; no writes",
            },
            as_json,
        )
        return 0
    if action == "abort":
        if len(rest) < 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve abort needs <cycle>",
                },
                as_json,
            )
            return 2
        cycle = rest[0]
        cycle_root = project_root / ".saipen" / "improve" / cycle
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "abort",
                "cycle": cycle,
                "targets": [str(cycle_root / "MANIFEST.md"), ".saipen/LOG.md"],
                "detail": "planned cycle ABORTED transition; no writes",
            },
            as_json,
        )
        return 0
    if action == "retire":
        if len(rest) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve retire needs <cycle> <seat> --reason <CODE>",
                },
                as_json,
            )
            return 2
        cycle, seat = rest[0], rest[1]
        reason = ""
        replacement = ""
        tail = rest[2:]
        while tail:
            if tail[0] == "--reason" and len(tail) > 1 and not reason:
                reason, tail = tail[1], tail[2:]
            elif tail[0] == "--replacement" and len(tail) > 1 and not replacement:
                replacement, tail = tail[1], tail[2:]
            else:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unsupported or duplicate improve retire option {tail[0]!r}",
                    },
                    as_json,
                )
                return 2
        if not reason:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve retire needs --reason <CODE> "
                    "(pattern [A-Z][A-Z0-9_-]{0,63})",
                },
                as_json,
            )
            return 2
        if reason == "STALE_COMPLETE" and not replacement:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "stale-COMPLETE retire needs --replacement <fresh-seat>",
                },
                as_json,
            )
            return 2
        if replacement and reason != "STALE_COMPLETE":
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "--replacement is valid only with --reason STALE_COMPLETE",
                },
                as_json,
            )
            return 2
        cycle_root = project_root / ".saipen" / "improve" / cycle
        _emit(
            {
                "ok": True,
                "code": "DRY_RUN_PLAN",
                "action": "retire",
                "cycle": cycle,
                "seat": seat,
                "reason": reason,
                "replacement_seat": replacement,
                "targets": [str(cycle_root / "MANIFEST.md"), ".saipen/LOG.md"],
                "detail": (
                    "planned stale COMPLETE -> superseded binding; no writes"
                    if replacement
                    else "planned seat availability -> unavailable; no writes"
                ),
            },
            as_json,
        )
        return 0
    _emit(
        {"ok": False, "code": "VALIDATION_FAILED", "detail": f"unknown improve action {action!r}"},
        as_json,
    )
    return 2


def _improve(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """saipen improve -- the meta-control command family (T-554, T-606,
    DOGFOOD V T-615..T-618).

    Bare `improve` PREPARES the bounded audit assignment (cycle, seat, draft
    report, real source identity, proof levels) and never aliases status.
    `status` derives per-seat visible status read-only and refuses to round
    malformed evidence up to a normal lifecycle state. `submit` appends a RUN
    mechanically, `complete` finishes a report through full validation,
    `sweep-queue` enumerates the exact unswept composite findings, `sweep
    <cycle> <RUN-N/IMP-NNN> <DISPOSITION>` commits a validated Core
    disposition (the finding/run/report/ticket must exist BEFORE write;
    `--fixed-by`/`--verification` bind a resolution/successor evidence ref),
    `verify <cycle>` validates the COMPLETE cycle output (delta-only, never a
    new cycle), `cycle-complete <cycle>` runs the full cycle bar and flips
    ACTIVE -> COMPLETE, `abort <cycle>` is the pre-sweep mechanical exit,
    `retire <cycle> <seat> --reason <CODE>` is the bounded exit for one seat
    that can never complete; `--reason STALE_COMPLETE --replacement <seat>`
    binds immutable stale COMPLETE evidence to a fresh same-scope replacement.
    `clean <cycle>` is archive-with-provenance.
    """
    state_path = _state_path(project_root)
    if not state_path.is_file():
        _emit({"ok": False, "code": "NOT_SAIPEN_PROJECT"}, as_json)
        return 3
    state, state_error = parse_state_or_error(codec.read_doc(state_path))
    if state_error:
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": f"state-malformed: {state_error}"},
            as_json,
        )
        return 1

    from improve import archive_cycle, complete_cycle, cycle_dir, derive_status, write_sweep_entry

    from improve import _sweep_records
    import re as _re

    imp_root = project_root / ".saipen" / "improve"

    def _cycle_statuses() -> list[dict]:
        rows = []
        if not imp_root.is_dir():
            return rows
        from improve import validate_manifest as _vm
        from improve import validate_report as _vr
        from improve import validate_sweep as _vs
        from improve import _report_fresh as _rf
        from improve import _seat_block as _sb
        from improve import _cycle_schema as _cs
        from improve import _field as _imp_field
        from improve import validate_superseded_seat as _validate_superseded

        for cycle in sorted(imp_root.iterdir()):
            manifest = cycle / "MANIFEST.md"
            if not manifest.is_file():
                continue
            try:
                roster = manifest.read_text(encoding="utf-8-sig")
                sweep = (
                    (cycle / "SWEEP.md").read_text(encoding="utf-8-sig")
                    if (cycle / "SWEEP.md").is_file()
                    else ""
                )
            except (UnicodeDecodeError, LookupError, OSError):
                rows.append(
                    {
                        "cycle": cycle.name,
                        "cycle_status": "INVALID_CYCLE",
                        "seats": [],
                        "invalid": True,
                        "manifest_errors": ["MANIFEST/SWEEP not valid UTF-8"],
                        "sweep_errors": [],
                    }
                )
                continue
            status = "active"
            m = _re.search(r"(?m)^cycle_status:\s*([A-Za-z_]+)", roster)
            if m:
                status = m.group(1)
            # DOGFOOD V (T-616): status never rounds corruption up to a
            # normal lifecycle state -- invalid evidence is reported as
            # INVALID_CYCLE / INVALID_REPORT, never as swept.
            manifest_errors = _vm(roster, expected_cycle_id=cycle.name)
            sweep_errors = _vs(sweep) if sweep else []
            invalid = bool(manifest_errors or sweep_errors)
            strict = _cs(manifest) == "strict"
            seats = []
            for block in roster.splitlines():
                if not block.startswith("seat_id:"):
                    continue
                seat = block.split(":", 1)[1].strip()
                report_path = ""
                roster_role = ""
                in_block = False
                for line in roster.splitlines():
                    if line == block:
                        in_block = True
                        continue
                    if line.startswith("seat_id:") and line != block:
                        in_block = False
                    if in_block and line.startswith("report_path:"):
                        report_path = line.split(":", 1)[1].strip()
                    if in_block and line.startswith("role:"):
                        roster_role = line.split(":", 1)[1].strip()
                if not report_path:
                    seats.append({"seat": seat, "role": roster_role, "visible": "missing"})
                    continue
                report = cycle / seat / report_path
                try:
                    report_text = report.read_text(encoding="utf-8-sig") if report.is_file() else ""
                except (UnicodeDecodeError, LookupError, OSError):
                    seats.append(
                        {
                            "seat": seat,
                            "role": roster_role,
                            "visible": "INVALID_REPORT",
                            "report_status": "",
                            "errors": ["report not valid UTF-8"],
                        }
                    )
                    continue
                if not report_text:
                    seats.append({"seat": seat, "role": roster_role, "visible": "expected"})
                    continue
                seat_block = _sb(roster, seat) or ""
                availability = _imp_field(seat_block, "availability") or "expected"
                if availability == "superseded":
                    resolution_errors = _validate_superseded(
                        cycle,
                        seat,
                        roster_text=roster,
                        sweep_text=sweep,
                    )
                    if resolution_errors:
                        seats.append(
                            {
                                "seat": seat,
                                "role": roster_role,
                                "visible": "INVALID_REPORT",
                                "report_status": _imp_field(report_text, "report_status"),
                                "errors": resolution_errors[:3],
                            }
                        )
                    else:
                        derived = derive_status(
                            report_path, roster, report_text, sweep, seat_id=seat
                        )
                        seats.append({"seat": seat, "role": roster_role, **derived})
                    continue
                # DOGFOOD V (T-620): status applies the SAME report-validation
                # depth the validator applies -- schema AND mechanical source
                # identity (fingerprint format + freshness for strict cycles).
                report_role = _imp_field(report_text, "role")
                report_errors = _vr(report_text, strict=strict)
                if report_role != roster_role:
                    report_errors.append(
                        f"roster/report role mismatch: {roster_role!r} != {report_role!r}"
                    )
                report_errors.extend(_rf(project_root, cycle, report_path, report_text, strict))
                if report_errors:
                    status_m = _re.search(r"(?m)^report_status:\s*(\S+)", report_text)
                    seats.append(
                        {
                            "seat": seat,
                            "role": roster_role,
                            "visible": "INVALID_REPORT",
                            "report_status": status_m.group(1) if status_m else "",
                            "errors": report_errors[:3],
                        }
                    )
                else:
                    derived = derive_status(report_path, roster, report_text, sweep, seat_id=seat)
                    seats.append({"seat": seat, "role": roster_role, **derived})
            rows.append(
                {
                    "cycle": cycle.name,
                    "cycle_status": status,
                    "seats": seats,
                    "invalid": invalid,
                    "manifest_errors": manifest_errors[:3],
                    "sweep_errors": sweep_errors[:3],
                }
            )
        return rows

    action = args[0] if args and not args[0].startswith("--") else None
    # CORE-002 (audit fdc73e06): the improve MUTATORS (submit/complete/
    # cycle-complete/abort) now run their semantic PLAN under --dry-run and
    # return the planned targets with zero writes. Refusal classes are the
    # same as non-dry; valid requests report concrete plan targets. The
    # previous `DRY_RUN_UNSUPPORTED` short-circuit hid the plan and made
    # dry-run observationally different from a real submission.
    if dry_run and action in ("submit", "complete", "cycle-complete", "abort", "retire"):
        return _improve_dry_run_plan(project_root, action, args[1:] if action else [], as_json)
    if action is None:
        # DOGFOOD V (T-617): bare `saipen improve` is the documented
        # meta-control -- it PREPARES the current seat's bounded audit
        # assignment, never an alias for status. It binds the project, finds
        # or mechanically admits the one active cycle, registers this seat,
        # creates the DRAFT report mechanically with the real captured source
        # identity, and returns the exact assignment the current agent must
        # execute. It never changes phase/task/next_action.
        try:
            proof_levels = _canonical_proof_levels()
        except (OSError, ValueError) as exc:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"cannot load canonical SAICRITIC proof vocabulary: {exc}",
                },
                as_json,
            )
            return 1
        role = "core"
        session_id = None
        explicit_new = False
        rest = list(args)
        while rest:
            if rest[0] == "--role" and len(rest) > 1:
                role, rest = rest[1], rest[2:]
            elif rest[0] == "--session" and len(rest) > 1:
                session_id, rest = rest[1], rest[2:]
            elif rest[0] == "--new-seat":
                explicit_new, rest = True, rest[1:]
            else:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unknown or incomplete Improve prepare option {rest[0]!r}",
                    },
                    as_json,
                )
                return 2
        if session_id is not None and explicit_new:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "--session and --new-seat are mutually exclusive",
                },
                as_json,
            )
            return 2
        from improve import ImproveError, prepare_audit_seat
        from improve import installed_protocol_fingerprint as _proto_fp

        try:
            runtime = _runtime_identity()
            fingerprint = _proto_fp(HOME)
            prepared = prepare_audit_seat(
                project_root,
                agent_family=state.get("agent") or "agent",
                role=role,
                session_id=session_id,
                project_name="SAIPEN",
                model_or_runtime=runtime,
                protocol_fingerprint=fingerprint,
                context_scope=f"SAIPEN audit, phase {state.get('phase') or '?'}",
                context_available="partial",
                dry_run=dry_run,
            )
        except ImproveError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 1
        if not prepared.get("ok"):
            _emit(prepared, as_json)
            return 1
        active_cycle = prepared["cycle_id"]
        seat_id = prepared["seat_id"]
        report_path = Path(prepared["report_path"])
        _emit(
            {
                "ok": True,
                "code": "IMPROVE_AUDIT_ASSIGNMENT",
                "op_id": prepared.get("op_id"),
                "cycle_id": active_cycle,
                "seat_id": seat_id,
                "role": prepared["role"],
                "report_path": report_path.relative_to(project_root).as_posix(),
                "report_created": prepared["report_created"],
                "resumed": prepared["resumed"],
                "dry_run": bool(prepared.get("dry_run")),
                "source": {
                    "source_head": prepared["source_head"],
                    "source_tree_fingerprint": prepared["source_tree_fingerprint"],
                    "discovery_model": prepared["discovery_model"],
                },
                "scope": {"phase": state.get("phase") or "?", "task": state.get("task") or ""},
                "proof_levels": proof_levels,
                "schema": "cycle + seat/report + RUN-N/IMP-NNN composite finding "
                "ref; dispositions go to SWEEP.md via saipen improve "
                "sweep; report completion via saipen improve complete",
                "write_boundary": "RUNs append via saipen improve submit; report "
                "completion via saipen improve complete; no raw "
                "report/MANIFEST/SWEEP editing",
                "next": f"perform the semantic audit, then: saipen improve submit "
                f"{active_cycle} {seat_id} SAIPEN <findings.json>",
            },
            as_json,
        )
        return 0
    if action == "hold":
        # T-1415: persist the typed no-improve-before-gate hold. This is the
        # operator's temporary policy made canonical data -- the router reads
        # it and never greps prose for "do not improve until ...".
        from saipen_engine.operations import hold_improve

        rest = args[1:]
        if not rest or rest[0].startswith("-"):
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve hold needs <T-###> [reason]",
                    "canonical_next_command": "saipen improve hold <T-###>",
                },
                as_json,
            )
            return 2
        result = hold_improve(
            project_root,
            _agent_for(project_root),
            rest[0],
            reason=" ".join(rest[1:]).strip(),
            dry_run=dry_run,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if action == "unhold":
        from saipen_engine.operations import release_improve

        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve unhold accepts no arguments; surplus: "
                    + " ".join(args[1:]),
                    "canonical_next_command": "saipen improve unhold",
                },
                as_json,
            )
            return 2
        result = release_improve(project_root, _agent_for(project_root), dry_run=dry_run)
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if action == "submit":
        # DOGFOOD V (T-617): structured report submission -- the current agent
        # supplies the semantic RUN text in a JSON file, Python appends the
        # RUN mechanically through append_run (validated, journaled).
        if len(args) < 5:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve submit needs <cycle> <seat> <project> <findings.json>",
                },
                as_json,
            )
            return 2
        if len(args) > 5:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"improve submit takes <cycle> <seat> <project> "
                    f"<findings.json>; unsupported surplus argument "
                    f"{args[5]!r}",
                },
                as_json,
            )
            return 2
        from improve import append_run as _append_run
        from improve import resolve_report_path as _resolve_report_path

        cycle = cycle_dir(project_root, args[1])
        payload = Path(args[4])
        if not payload.is_file():
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"findings file not found: {args[4]}",
                },
                as_json,
            )
            return 2
        import json as _json

        try:
            data = _json.loads(payload.read_text(encoding="utf-8-sig"))
        except ValueError as exc:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"findings file is not valid JSON: {exc}",
                },
                as_json,
            )
            return 2
        # Shape-check before any .get(): array/scalar/null payloads would
        # otherwise crash with a raw AttributeError instead of a structured
        # refusal, and a non-string run_text must never reach .strip().
        if not isinstance(data, dict):
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "findings payload must be a JSON object with a run_text field",
                },
                as_json,
            )
            return 2
        run_text = data.get("run_text")
        if not isinstance(run_text, str) or not run_text.strip():
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "findings payload needs a non-empty string run_text field",
                },
                as_json,
            )
            return 2
        report = _resolve_report_path(project_root, args[1], args[2], args[3])
        try:
            result = _append_run(report, run_text)
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        except ValueError as exc:
            # SRC-085 M2: a refusal that carries its own stable code (a
            # run_text that smuggles the RUN heading append_run owns) reports
            # that code; every other refusal keeps VALIDATION_FAILED.
            _emit(
                {
                    "ok": False,
                    "code": getattr(exc, "code", None) or "VALIDATION_FAILED",
                    "detail": str(exc),
                },
                as_json,
            )
            return 1
    if action == "complete":
        # DOGFOOD V (T-616): mechanical report completion -- full validation,
        # then draft -> complete, journaled and immutable.
        # W2-004 (audit fdc73e06): closed grammar -- exactly
        # `<cycle> <seat> <project>`; surplus tokens are refused, never
        # silently ignored.
        if len(args) < 4:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve complete needs <cycle> <seat> <project>",
                },
                as_json,
            )
            return 2
        if len(args) > 4:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"improve complete takes <cycle> <seat> <project>; "
                    f"unsupported surplus argument {args[4]!r}",
                },
                as_json,
            )
            return 2
        from improve import complete_report as _complete_report
        from improve import resolve_report_path as _resolve_report_path

        report = _resolve_report_path(project_root, args[1], args[2], args[3])
        try:
            result = _complete_report(report)
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        except ValueError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 1
    if action == "sweep-queue":
        # DOGFOOD V (T-617): deterministic enumeration of the unswept finding
        # queue -- read-only; the semantic adjudication stays Core-owned.
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve sweep-queue needs <cycle_id>",
                },
                as_json,
            )
            return 2
        from improve import (
            composite_finding_ref,
            parse_report,
            verify_cycle,
            _report_ledger_keys,
            _seat_blocks,
            _field as _imp_field,
        )

        cycle = cycle_dir(project_root, args[1])
        precheck = verify_cycle(cycle)
        roster = (cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
        sweep = (
            (cycle / "SWEEP.md").read_text(encoding="utf-8-sig")
            if (cycle / "SWEEP.md").is_file()
            else ""
        )
        disposed = list(_sweep_records(sweep))
        queue = []
        for block in _seat_blocks(roster):
            if _imp_field(block, "availability") in {"unavailable", "superseded"}:
                continue
            seat_id = _imp_field(block, "seat_id")
            report_ident = _imp_field(block, "report_path")
            report_keys = _report_ledger_keys(roster, seat_id, report_ident)
            report = cycle / seat_id / report_ident
            if not report.is_file():
                continue
            for finding in parse_report(report.read_text(encoding="utf-8-sig")).findings:
                if any(
                    record.report in report_keys
                    and record.run() == finding.run
                    and record.imp() == finding.imp
                    for record in disposed
                ):
                    continue
                queue.append(
                    {
                        "finding_ref": composite_finding_ref(
                            cycle.name, seat_id, report_ident, finding.run, finding.imp
                        ),
                        "run": finding.run,
                        "imp": finding.imp,
                        "report": f"{seat_id}/{report_ident}",
                        "severity": finding.severity,
                        "class": finding.cls,
                        "expected": finding.expected,
                        "actual": finding.actual,
                        "evidence": finding.evidence,
                    }
                )
        _emit(
            {
                "ok": True,
                "code": "IMPROVE_SWEEP_QUEUE",
                "cycle": args[1],
                "queue": queue,
                "precheck_errors": precheck[:5],
                "note": "semantic adjudication (reproduce/classify/dedupe/"
                "decide) is Core-owned; commit each decision via "
                "saipen improve sweep",
            },
            as_json,
        )
        return 0
    if action == "status":
        rows = _cycle_statuses()
        if as_json:
            _emit({"ok": True, "code": "IMPROVE_STATUS", "cycles": rows}, as_json)
        else:
            for row in rows:
                print(f"{row['cycle']} ({row['cycle_status']})")
                for seat in row["seats"]:
                    print(
                        f"  {seat['seat']}: {seat.get('visible', '?')}"
                        + (
                            f" (report_status {seat.get('report_status')})"
                            if seat.get("report_status")
                            else ""
                        )
                        + (f" missing={seat.get('missing')}" if seat.get("missing") else "")
                    )
        return 0
    if action == "verify":
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve verify needs <cycle_id>",
                },
                as_json,
            )
            return 2
        cycle = cycle_dir(project_root, args[1])
        # DOGFOOD V (T-616): verify validates the COMPLETE cycle output --
        # strict manifest, every expected report full-valid, exact composite
        # sweep coverage -- never whether individual files merely resemble
        # writable intermediate targets. A report that only says
        # `report_status: complete` can never PASS this.
        from improve import verify_cycle

        errors = verify_cycle(cycle)
        if errors:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "; ".join(errors[:5]),
                    "delta_only": True,
                },
                as_json,
            )
            return 1
        _emit(
            {"ok": True, "code": "IMPROVE_VERIFY_PASS", "delta_only": True, "cycle": args[1]},
            as_json,
        )
        return 0
    if action == "sweep":
        if len(args) < 4:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve sweep needs <cycle> <finding_ref> "
                    "<disposition> [--ticket T-###] [--report "
                    "<ident>] [--reproduced y|n] [--fixed-by <ref>] "
                    "[--verification <ref>] where finding_ref "
                    "is RUN-N/IMP-NNN (strict) or IMP-NNN (legacy); "
                    "--verification binds a historical SUPERSEDED/"
                    "NOT_REPRODUCED disposition to its successor evidence",
                },
                as_json,
            )
            return 2
        cycle = cycle_dir(project_root, args[1])
        finding_ref, disposition = args[2], args[3]
        _run = None
        import re as _re

        _fm = _re.fullmatch(r"(?:RUN-(\d+)/)?IMP-(\d+)", finding_ref)
        if not _fm:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"finding_ref {finding_ref!r} is not RUN-N/IMP-NNN or IMP-NNN",
                },
                as_json,
            )
            return 2
        run_raw, imp_id = _fm.group(1), _fm.group(2)
        ticket = "-"
        report = "-"
        reproduced = "-"
        fixed_by = "-"
        verification = "-"
        rest = args[4:]
        while rest:
            if rest[0] == "--ticket" and len(rest) > 1:
                ticket, rest = rest[1], rest[2:]
            elif rest[0] == "--report" and len(rest) > 1:
                report, rest = rest[1], rest[2:]
            elif rest[0] == "--reproduced" and len(rest) > 1:
                reproduced, rest = rest[1], rest[2:]
            elif rest[0] == "--fixed-by" and len(rest) > 1:
                fixed_by, rest = rest[1], rest[2:]
            elif rest[0] == "--verification" and len(rest) > 1:
                verification, rest = rest[1], rest[2:]
            else:
                rest = rest[1:]
        if dry_run:
            _emit(
                {
                    "ok": True,
                    "code": "IMPROVE_SWEEP_PLAN",
                    "cycle": args[1],
                    "finding_ref": finding_ref,
                    "disposition": disposition,
                },
                as_json,
            )
            return 0
        try:
            entry = {
                "imp_id": imp_id,
                "disposition": disposition,
                "ticket": ticket,
                "report": report,
                "reproduced": reproduced,
                "fixed_by": fixed_by,
                "verification": verification,
            }
            if run_raw is not None:
                entry["run"] = f"RUN-{run_raw}"
            result = write_sweep_entry(cycle, entry)
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        except ValueError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 1
    if action == "reconcile":
        # T-1434 M4: ONE canonical finite exit for a strict cycle. Classifies
        # every roster seat, executes the lossless transitions the evidence
        # already authorizes (retire EMPTY_DRAFT, supersede STALE_COMPLETE onto
        # a current same-scope replacement), refuses while genuine actionable
        # work remains, and terminalizes with WHY (COMPLETE/SUPERSEDED/
        # BLOCKED_EXTERNAL). Idempotent on a terminal cycle.
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve reconcile needs <cycle_id>",
                },
                as_json,
            )
            return 2
        if len(args) > 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"improve reconcile takes <cycle_id>; unsupported "
                    f"surplus argument {args[2]!r}",
                },
                as_json,
            )
            return 2
        from improve import reconcile_cycle as _reconcile_cycle

        cycle = cycle_dir(project_root, args[1])
        try:
            result = _reconcile_cycle(cycle, dry_run=dry_run)
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        except ValueError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 1
    if action == "cycle-complete":
        # DOGFOOD V (T-616): mechanical cycle completion through the public
        # path -- full cycle bar (strict manifest, every report full-valid,
        # exact composite sweep coverage), then ACTIVE -> COMPLETE.
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve cycle-complete needs <cycle_id>",
                },
                as_json,
            )
            return 2
        if len(args) > 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"improve cycle-complete takes <cycle_id>; unsupported "
                    f"surplus argument {args[2]!r}",
                },
                as_json,
            )
            return 2
        cycle = cycle_dir(project_root, args[1])
        try:
            result = complete_cycle(cycle)
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        except ValueError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 1
    if action == "abort":
        # DOGFOOD V (T-621): mechanical abort for a stuck draft cycle -- the
        # journaled exit for an active cycle whose report cannot complete.
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve abort needs <cycle_id>",
                },
                as_json,
            )
            return 2
        if len(args) > 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"improve abort takes <cycle_id>; unsupported "
                    f"surplus argument {args[2]!r}",
                },
                as_json,
            )
            return 2
        from improve import abort_cycle as _abort_cycle

        cycle = cycle_dir(project_root, args[1])
        try:
            result = _abort_cycle(cycle)
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        except ValueError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 1
    if action == "clean":
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve clean needs <cycle_id>",
                },
                as_json,
            )
            return 2
        cycle = cycle_dir(project_root, args[1])
        # archive-with-provenance: only a COMPLETE (fully swept) cycle may be
        # archived; the sweep ledger + reports are preserved verbatim.
        if dry_run:
            _emit(
                {"ok": True, "code": "IMPROVE_CLEAN_PLAN", "cycle": args[1], "archive_only": True},
                as_json,
            )
            return 0
        try:
            result = archive_cycle(cycle)
            _emit(
                {
                    "ok": result.get("ok", False),
                    "code": "IMPROVE_CLEAN" if result.get("ok") else "VALIDATION_FAILED",
                    "cycle": args[1],
                    "archive_only": True,
                    "detail": result.get("message", ""),
                },
                as_json,
            )
            return 0 if result.get("ok") else 1
        except ValueError as exc:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": str(exc),
                    "archive_only": True,
                },
                as_json,
            )
            return 1
    if action == "retire":
        # T-1406: canonical bounded exit for a seat that can never complete.
        # Marks that ONE roster seat unavailable (journaled) so the cycle bar
        # can be met; the never-completed report and every SWEEP disposition
        # stay byte-identical.
        if len(args) < 5:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve retire needs <cycle_id> <seat_id> "
                    "--reason <CODE> [--replacement <fresh-seat>] "
                    "(pattern [A-Z][A-Z0-9_-]{0,63})",
                },
                as_json,
            )
            return 2
        reason = ""
        replacement = ""
        tail = args[3:]
        while tail:
            if tail[0] == "--reason" and len(tail) > 1 and not reason:
                reason, tail = tail[1], tail[2:]
            elif tail[0] == "--replacement" and len(tail) > 1 and not replacement:
                replacement, tail = tail[1], tail[2:]
            else:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unsupported or duplicate improve retire option {tail[0]!r}",
                    },
                    as_json,
                )
                return 2
        if not reason:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "improve retire needs --reason <CODE>",
                },
                as_json,
            )
            return 2
        if reason == "STALE_COMPLETE" and not replacement:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "stale-COMPLETE retire needs --replacement <fresh-seat>",
                },
                as_json,
            )
            return 2
        if replacement and reason != "STALE_COMPLETE":
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "--replacement is valid only with --reason STALE_COMPLETE",
                },
                as_json,
            )
            return 2
        from improve import resolve_stale_complete_seat as _resolve_stale_complete_seat
        from improve import retire_seat as _retire_seat

        cycle = cycle_dir(project_root, args[1])
        try:
            if reason == "STALE_COMPLETE":
                result = _resolve_stale_complete_seat(cycle, args[2], replacement)
            else:
                result = _retire_seat(cycle, args[2], reason)
            _emit(result, as_json)
            return 0 if result.get("ok") else 1
        except ValueError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 1
    _emit(
        {
            "ok": False,
            "code": "UNKNOWN_ACTION",
            "detail": f"unknown saipen improve action {action!r}; use "
            "status|submit|complete|sweep|sweep-queue|"
            "verify|cycle-complete|reconcile|abort|retire|clean",
        },
        as_json,
    )
    return 2


def _public_improve(project_root: Path, args: list[str], as_json: bool, dry_run: bool) -> int:
    """Normalize expected Improve writer contention at the public boundary."""
    # CORE-002: verify/status/sweep-queue are read-only; bare improve and
    # submit/complete/sweep/cycle-complete/abort/clean mutate and must
    # respect the live read-only capability gate.
    if not dry_run and _command_mutates("improve", args):
        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
    try:
        return _improve(project_root, args, as_json, dry_run)
    except PermissionError as exc:
        if str(exc) == "WRITER_BUSY":
            _emit(
                {
                    "ok": False,
                    "code": "WRITER_BUSY",
                    "detail": "another live writer holds the project lock",
                },
                as_json,
            )
            return 1
        raise


#: Install-scoped `runtime` flags: they act on the INSTALLED adapter surface,
#: never on project memory, and must therefore run outside a bound project.
_RUNTIME_INSTALL_FLAGS = ("--bootstrap", "--check-freshness", "--check", "--prelaunch")


def _runtime_install_flags(tokens: list[str]) -> bool:
    return any(token in _RUNTIME_INSTALL_FLAGS for token in tokens)


def _runtime_install_command(tokens: list[str], as_json: bool) -> int:
    """`saipen runtime --prelaunch|--bootstrap|--check-freshness [--adapter ID]`.

    ONE stable machine-readable prelaunch operation (TARGET C). Consumer
    contract: exit 0 with `code` in {RUNTIME_CURRENT, RUNTIME_RESYNCED} means
    the installed generation is proven current and a host may now be started;
    any other code means it is NOT, and the caller must not start the host.
    `requires_host_restart` is true exactly when bytes changed under an
    already-running process -- the supported launcher consumes that by starting
    the host after this call, never by hot-replacing a loaded module.
    """
    from saipen_engine.runtime_bootstrap import (
        CanonicalSourceUnproven,
        check_freshness,
        prelaunch,
        run_bootstrap,
    )

    adapter: str | None = None
    mode: str | None = None
    no_resync = False
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token in ("--check-freshness", "--check"):
            mode = mode or "freshness"
            index += 1
        elif token == "--bootstrap":
            mode = mode or "bootstrap"
            index += 1
        elif token == "--prelaunch":
            mode = "prelaunch"
            index += 1
        elif token == "--no-resync":
            no_resync = True
            index += 1
        elif token == "--adapter" and index + 1 < len(tokens):
            adapter = tokens[index + 1]
            index += 2
        elif token.startswith("--adapter="):
            adapter = token.split("=", 1)[1]
            index += 1
        else:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": (
                        "runtime install flags are --prelaunch [--adapter ID] [--no-resync], "
                        "--bootstrap and --check-freshness; surplus: " + token
                    ),
                },
                as_json,
            )
            return 2
    if adapter is not None and not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", adapter):
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": "invalid --adapter id"},
            as_json,
        )
        return 2
    if adapter is not None and mode != "prelaunch":
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "--adapter applies only to runtime --prelaunch",
            },
            as_json,
        )
        return 2
    if no_resync and mode != "prelaunch":
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "--no-resync applies only to runtime --prelaunch",
            },
            as_json,
        )
        return 2
    try:
        if mode == "prelaunch":
            payload = prelaunch(adapter, resync=not no_resync)
        elif mode == "bootstrap":
            payload = run_bootstrap()
        else:
            payload = check_freshness()
    except CanonicalSourceUnproven as exc:
        _emit(
            {"ok": False, "code": "CANONICAL_RUNTIME_SOURCE_UNPROVEN", "detail": str(exc)},
            as_json,
        )
        return 1
    _emit(payload, as_json)
    return 0 if payload.get("ok", True) else 1


#: T-1424: the host-bootstrap diagnostic verb and its subcommands. `bootstrap`
#: is the whole resolver; `activation` is the narrower contract question.
_HOST_BOOTSTRAP_SUBCOMMANDS = ("bootstrap", "activation")


def _host_command(tokens: list[str], project_root_opt: str | None, as_json: bool) -> int:
    """`saipen host bootstrap|activation [--host ID] [--project-root PATH]`.

    Read-only. Answers whether THIS host can reach a canonical SAIPEN runtime
    for THIS project, and when it cannot, names the exact leg of the chain that
    broke. It never installs, never scans disks and never guesses a path: every
    candidate comes from SAIPEN-controlled state. Exit 0 only on a green
    binding (`HOST_BOOTSTRAP_BOUND` / `ACTIVATION_PRESENT`); every other verdict
    exits 2 so a host branch can gate product work on it.
    """
    from saipen_engine import host_bootstrap

    sub = tokens[0]
    host: str | None = None
    root_opt = project_root_opt
    index = 1
    while index < len(tokens):
        token = tokens[index]
        if token == "--host" and index + 1 < len(tokens):
            host = tokens[index + 1]
            index += 2
        elif token.startswith("--host="):
            host = token.split("=", 1)[1]
            index += 1
        elif token == "--project-root" and index + 1 < len(tokens):
            root_opt = tokens[index + 1]
            index += 2
        elif token.startswith("--project-root="):
            root_opt = token.split("=", 1)[1]
            index += 1
        else:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": (
                        "host bootstrap accepts --host ID and --project-root PATH; "
                        "surplus: " + token
                    ),
                },
                as_json,
            )
            return 2
    start = None if root_opt else Path.cwd().resolve()
    try:
        if sub == "activation":
            resolved = host_bootstrap.resolve_bootstrap(root_opt, host=host, start=start)
            # T-1425 REPAIR 3: the activation contract is asked of the MANAGED
            # PROJECT ROOT (the thing carrying `.saipen/`), never of the
            # resolved install home -- a flattened/installed runtime home has
            # no `.saipen/` of its own and answered NOT_SAIPEN before this.
            # The activation question is answered from the project root
            # whenever one is definite (resolved or explicitly requested), even
            # when the runtime binding itself is unavailable or the host is
            # unsupported; with no project root at all the binding verdict is
            # the truthful answer.
            project_root = resolved.get("project_root") or root_opt
            if project_root:
                payload = host_bootstrap.activation_contract(project_root)
                payload.setdefault("host", resolved.get("host"))
                payload.setdefault("project_root", resolved.get("project_root"))
                payload.setdefault("project_lineage", resolved.get("project_lineage"))
            else:
                payload = resolved
        else:
            payload = host_bootstrap.resolve_bootstrap(root_opt, host=host, start=start)
    except (OSError, ValueError) as exc:  # pragma: no cover - defensive boundary
        _emit(
            {
                "ok": False,
                "code": host_bootstrap.UNAVAILABLE,
                "boundary": host_bootstrap.BOUNDARY_PROJECT,
                "detail": f"{type(exc).__name__}: {exc}",
                "remediation": "re-run from the managed project or pass --project-root",
            },
            as_json,
        )
        return 2
    _emit(payload, as_json)
    return 0 if payload.get("ok") else 2


#: T-1327 TARGET D: the exact fields the OpenCode guard requires of EVERY Fleet
#: result before it will read one. A branch that emitted a bare
#: `{ok, code, detail}` -- a grammar refusal, or an unhandled exception that
#: printed nothing at all -- was indistinguishable from a broken runtime, and
#: the guard could only collapse it into FLEET_OUTPUT_INVALID. Every exit from
#: `_fleet_command` now leaves through `_fleet_emit`, so the schema is a
#: property of the command, not of whichever branch happened to be taken.
_FLEET_GUARD_SCHEMA = ("classification", "code", "requires_reissue")


def _fleet_envelope(payload: dict) -> dict:
    """Complete one Fleet record to the guard-required schema without lying."""
    record = dict(payload)
    record.setdefault("ok", False)
    record.setdefault("code", "VALIDATION_FAILED")
    # A record that never classified a project is UNBOUND for the host: it
    # carries no verdict about the project, which is exactly fail-closed.
    record.setdefault("classification", "UNBOUND")
    record.setdefault("requires_reissue", False)
    record.setdefault("recovered", False)
    record.setdefault("recovery_attempts", 0)
    record.setdefault("reason_code", record["code"])
    record.setdefault("reason", record.get("detail") or record["code"])
    return record


def _fleet_emit(payload: dict, as_json: bool) -> None:
    _emit(_fleet_envelope(payload), as_json)


def _fleet_command(
    args: list[str], project_root_opt: str | None, as_json: bool, dry_run: bool
) -> int:
    """Closed Fleet CLI grammar; dispatch before ordinary root resolution.

    Wrapped so that NO failure mode of the engine below can reach the host as
    empty stdout: an unexpected exception is a bounded, schema-complete
    `FLEET_INTERNAL_ERROR` record, which the guard can refuse deliberately
    instead of misreading as an invalid contract.
    """
    try:
        return _fleet_command_inner(args, project_root_opt, as_json, dry_run)
    except Exception as exc:  # the boundary IS the contract: never empty stdout
        _fleet_emit(
            {
                "ok": False,
                "code": "FLEET_INTERNAL_ERROR",
                "detail": f"{type(exc).__name__}: {exc}"[:512],
            },
            as_json,
        )
        return 1


def _fleet_command_inner(
    args: list[str], project_root_opt: str | None, as_json: bool, dry_run: bool
) -> int:
    from saipen_engine.fleet import preflight, prepare, scan

    if len(args) < 2 or args[1] not in ("preflight", "scan", "prepare"):
        _fleet_emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "use fleet preflight|scan|prepare",
            },
            as_json,
        )
        return 2
    verb = args[1]
    options: dict[str, str] = {}
    roots: list[str] = []
    require_binding = False
    index = 2
    while index < len(args):
        key = args[index]
        if key == "--require-binding":
            if require_binding:
                _fleet_emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "duplicate fleet option: --require-binding",
                    },
                    as_json,
                )
                return 2
            require_binding = True
            index += 1
            continue
        if key not in (
            "--root",
            "--cwd",
            "--host-root",
            "--host-lineage",
            "--attempted-condition",
        ) or index + 1 >= len(args):
            _fleet_emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "unknown or incomplete fleet option: " + key,
                },
                as_json,
            )
            return 2
        value = args[index + 1]
        if value.startswith("--") or not value.strip():
            _fleet_emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "fleet option has no value: " + key,
                },
                as_json,
            )
            return 2
        if key == "--root":
            roots.append(value)
        elif key in options:
            _fleet_emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "duplicate fleet option: " + key,
                },
                as_json,
            )
            return 2
        else:
            options[key] = value
        index += 2
    if verb == "scan":
        if (
            project_root_opt
            or dry_run
            or require_binding
            or any(key != "--root" for key in options)
        ):
            _fleet_emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "fleet scan accepts only repeated --root absolute paths",
                },
                as_json,
            )
            return 2
        result = scan(roots)
        _fleet_emit(result, as_json)
        return 0 if result.get("ok") else 2
    if roots or (verb == "prepare" and dry_run):
        _fleet_emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "fleet preflight/prepare do not accept --root; prepare is not a dry-run",
            },
            as_json,
        )
        return 2
    if verb == "preflight" and "--attempted-condition" in options:
        _fleet_emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "attempted condition applies only to fleet prepare",
            },
            as_json,
        )
        return 2
    kwargs = {
        "explicit_root": project_root_opt,
        "host_root": options.get("--host-root"),
        "host_lineage": options.get("--host-lineage"),
        "require_binding": require_binding,
    }
    start = options.get("--cwd") or Path.cwd()
    result = (
        preflight(start, **kwargs)
        if verb == "preflight"
        else prepare(start, **kwargs, attempted_condition=options.get("--attempted-condition"))
    )
    if verb == "preflight":
        result = {**result, "ok": True, "code": result["classification"], "read_only": True}
    _fleet_emit(result, as_json)
    return 0 if result.get("ok") else 1


def main(argv: list[str] | None = None) -> int:
    global _ROUTE_ECHO  # noqa: PLW0603
    # ``main`` is normally one process/one invocation, but tests and embedded
    # callers may invoke it repeatedly. Route evidence belongs to THIS raw
    # command only; never let a previous shortcut label a later direct verb.
    _ROUTE_ECHO = None
    raw_args = list(argv if argv is not None else sys.argv[1:])
    if "--" in raw_args:
        dd_idx = raw_args.index("--")
        before_dashdash = raw_args[:dd_idx]
        after_dashdash = raw_args[dd_idx + 1 :]
    else:
        before_dashdash = raw_args
        after_dashdash = []

    as_json = "--json" in before_dashdash
    if as_json and hasattr(sys.stdout, "reconfigure"):
        # Windows shells frequently inherit an ANSI code page. JSON is UTF-8;
        # a read-only focus result containing a Unicode filename must not die
        # while printing after all reasoning already succeeded.
        with suppress(OSError, ValueError):
            sys.stdout.reconfigure(encoding="utf-8")

    # CORE-004: an invalid live capability declaration is refused HERE, before
    # any command runs, so the refusal cannot depend on a particular command
    # remembering to ask. An ABSENT declaration is still the documented default
    # writable session; a PRESENT one outside the closed set is a broken host
    # integration, and the typos that reach this branch -- `readonly`,
    # `read only`, `no_publish` -- are all attempts to RESTRICT the session.
    # Failing open on them granted publish authority no one asked for.
    _capability_problem = _invalid_capability_refusal()
    if _capability_problem is not None:
        _emit(_capability_problem, as_json)
        return 2
    dry_run = "--dry-run" in before_dashdash
    project_root_opt: str | None = None
    runtime_info_opt: str | None = None
    option_error: str | None = None

    clean_before: list[str] = []
    i = 0
    agent_opt: str | None = None
    while i < len(before_dashdash):
        arg = before_dashdash[i]
        if arg in ("--json", "--dry-run"):
            i += 1
        elif arg == "--agent" and i + 1 < len(before_dashdash):
            agent_opt = before_dashdash[i + 1]
            i += 2
        elif arg.startswith("--agent="):
            agent_opt = arg.split("=", 1)[1]
            i += 1
        elif arg == "--project-root" and i + 1 < len(before_dashdash):
            project_root_opt = before_dashdash[i + 1]
            i += 2
        elif arg.startswith("--project-root="):
            project_root_opt = arg.split("=", 1)[1]
            i += 1
        elif arg == "--runtime-info":
            if i + 1 >= len(before_dashdash) or before_dashdash[i + 1].startswith("--"):
                option_error = "--runtime-info requires a JSON file path"
                i += 1
            elif runtime_info_opt is not None:
                option_error = "--runtime-info may be supplied only once"
                i += 2
            else:
                runtime_info_opt = before_dashdash[i + 1]
                i += 2
        elif arg.startswith("--runtime-info="):
            if runtime_info_opt is not None:
                option_error = "--runtime-info may be supplied only once"
            else:
                runtime_info_opt = arg.split("=", 1)[1]
                if not runtime_info_opt.strip():
                    option_error = "--runtime-info requires a JSON file path"
            i += 1
        else:
            clean_before.append(arg)
            i += 1

    args = clean_before + (["--", *after_dashdash] if "--" in raw_args else [])

    # T-1006: an explicit `--agent <id>` names the ACTING ACTOR for this
    # invocation (CORE-001, SRC-026:R001): it does not by itself transfer the
    # active seat -- an out-of-band actor's mutations keep STATE.agent bound to
    # the live BOARD claim and record the actor in the journal. Ownership
    # transfers only through the explicit authorized paths: `saipen claim
    # <T-###>` adoption or `operations.handover_agent(..., explicit=True)`.
    global _AGENT_OVERRIDE, _RUNTIME_INFO_OVERRIDE  # noqa: PLW0603
    _AGENT_OVERRIDE = agent_opt.strip() if agent_opt and agent_opt.strip() else None
    _RUNTIME_INFO_OVERRIDE = runtime_info_opt

    if option_error:
        _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": option_error}, as_json)
        return 2

    # CORE-004: bare `saipen` (only global options, no command) is the
    # canonical resume family -- equivalent to `continue`/`cc` (CORE § 1.10).
    # Explicit help does NOT resume. T-1363: help is a DIAGNOSTIC that answers
    # and writes nothing wherever it appears before `--` -- `saipen goal --help`
    # once became a goal named "--help" (T-1321) and `saipen user-request
    # --help` a refusal. It exits 0: a usage probe that "fails" teaches a weak
    # model the tool is broken.
    if (args and args[0] == "help") or any(
        token in ("-h", "--help") for token in clean_before
    ):
        usage_msg = (
            "usage: saipen (start '<task in one line>' [--file PATH] [--hex HEX] "
            "[--receipt SRC-###]|"
            "continue|status|next|runtime [--prelaunch [--adapter ID] "
            "[--no-resync]|--bootstrap|--check-freshness]|search [--hex HEX]|"
            "validate|recover|fleet preflight|scan|prepare|claim <T-###> [--explicit]|"
            "transition <PHASE> [T-###] [text]|checkpoint <TAXONOMY> "
            "[T-###] [text]|goal <text>|user-request <text> [--priority P#] "
            "[--verify <text>] [--needs T-X,T-Y]|ticket add <PRIORITY> <text> --verify <proof> "
            "[--needs T-X,T-Y]|ticket "
            "done <T-###> [--closure-mode own_patch|inherited_verified|cohort] "
            "[--closure-cohort C-###] [--implementation-source "
            "<release:<id>|T-###|SRC-###>] [--paths <p1,p2>]|"
            "ticket supersede <T-OLD> --by <T-NEW> --evidence <E-###> "
            "--authority <SRC-###>|ticket resolve-external <T-###> --authority "
            "<lineage-32hex> --implementation <T-###@commit> --reason <CLASS> "
            "--run <command>...|ticket repair-metadata <T-###> --field "
            "source_receipts (--to SRC-### | --legacy-unbound "
            "[--authority SRC-###|lineage-<32hex>])|ticket reasoning <T-###> --recurrence <text> "
            "--weak-model <text>|ticket compact <T-###>|ticket block <T-###> "
            "<reason> [--scope ticket|goal]|ticket "
            "block-for <parent T-###> <blocker T-###> <reason> "
            "[--scope ticket|goal]|ticket "
            "unblock <T-###> <decision>|work reverify <T-###> "
            "[--verification <cmd>:PASS]... [--run <command>]... "
            "[--timeout SECONDS]|source retire <SRC-###> --reason <CLASS> "
            "[--successor SRC-###]|source quarantine <SRC-###> [--reason CODE]|"
            "source recover|cohort status <C-###>|cohort ship "
            "<C-###>|improve|improve hold <T-###> [reason]|improve unhold|improve "
            "status|improve sweep <cycle> <RUN-N/IMP-NNN> <DISPOSITION> "
            "|improve sweep-queue <cycle>|improve submit <cycle> <seat> "
            "<project> <findings.json>|improve complete <cycle> <seat> "
            "<project>|improve verify <cycle>|improve cycle-complete "
            "<cycle>|improve reconcile <cycle>|improve abort <cycle>|improve clean <cycle>|"
            "ship|push|scope <T-###> <path>...|first-publish-confirm "
            "<name> <public|private>|userperson show "
            "[--project|--global|--effective]|userperson add|remove <text> "
            "[--category NAME] [--project|--global]|userperson reset "
            "[--project|--global] --confirm|authority capture [--file PATH|--hex HEX]|"
            "sub reconcile <role> --authority <SRC-###>|sub|rebind-home "
            "<candidate-home>|context cold|hot|audit|orient [--handoff JSON]|"
            "acceptance <T-###>|attempt open|attempt close <RESULT> "
            "<STOP>|brief|focus [text]|build <directive>|knowledge "
            "status|index|retrieve <objective>|launch opencode [-- HOST-ARGS]|cut <target>|"
            "cut confirm <CUT-ID>|undo|undo confirm <CP-ID> --reason <text>) "
            "[--dry-run] "
            "[--json] [--project-root PATH] [--agent ID] [--runtime-info JSON-FILE]"
        )
        if as_json:
            _emit({"ok": True, "code": "USAGE", "usage": usage_msg}, as_json)
        else:
            print(usage_msg)
        return 0

    # Global USERPERSON belongs to user configuration, not project memory.
    # Dispatch it before project-root resolution so it works from an ordinary
    # directory and never invents/loads STATE, BOARD, LOG, or a project lock.
    if args and args[0] == "userperson" and len(args) >= 2:
        _scope, _clean, _scope_error = _userperson_scope(args[2:])
        if _scope == "global" or _scope_error:
            return _userperson(None, args[1:], as_json, dry_run)

    # The structured guard event (SRC-030 Part 6) binds from the SESSION cwd
    # carried in the event, which may be a detached staging directory the
    # ordinary project-root gate would refuse before the guard could speak.
    if args and args[0] == "guard" and any(a.startswith("--event-json") for a in args[1:]):
        return _guard_event(project_root_opt, args[1:], as_json)

    if args and args[0] == "fleet":
        return _fleet_command(args, project_root_opt, as_json, dry_run)

    # T-1424: the host-bootstrap diagnostic answers "can THIS host reach a
    # canonical SAIPEN runtime for THIS project, and if not, which leg of the
    # chain broke". It is read-only and install-scoped like `runtime`: an
    # isolated host that cannot resolve the `saipen` executable or the Python
    # engine is exactly the condition in which no ordinary project operation is
    # reachable, so it must dispatch before project-root resolution and must
    # never require the runtime it is diagnosing. `activation` is the narrower
    # question: is the canonical activation contract loadable for this project.
    if args and args[0] == "host" and len(args) >= 2 and args[1] in (
        "bootstrap",
        "activation",
    ):
        return _host_command(args[1:], project_root_opt, as_json)

    # T-1327 TARGET C: the runtime INSTALL surface is not project state. A
    # stale installed generation is exactly the condition under which no
    # project can be resolved yet (and the launcher runs from the canonical
    # clone, which is not a project at all), so these flags dispatch here --
    # before project-root resolution -- or the freshness operation is
    # unreachable in the only situation that needs it.
    if args and args[0] == "runtime" and _runtime_install_flags(args[1:]):
        return _runtime_install_command(args[1:], as_json)

    # T-1434 M6: the command's own effect class decides the authority mode of
    # the explicit-root binding. A DIAGNOSTIC run observes deliberately and
    # may bind a foreign target under an ambient session that names another
    # project; every mutating run keeps the strict lineage agreement.
    from saipen_engine.command_effects import DIAGNOSTIC as _DIAGNOSTIC, classify_invocation

    _authority = (
        "observe"
        if args and classify_invocation(args[0], args[1:]) == _DIAGNOSTIC
        else "mutation"
    )
    project_root_res = resolve_project_root(
        Path.cwd().resolve(), explicit=project_root_opt, authority=_authority
    )
    project_root = project_root_res.root
    root_reason = project_root_res.source
    if project_root is None:
        fail_code = getattr(project_root_res, "code", None) or "NOT_SAIPEN_PROJECT"
        _emit({"ok": False, "code": fail_code, "detail": root_reason}, as_json)
        return 3

    # CORE-004: a genuinely bare invocation (no command after global option
    # parsing) resumes through the same `_continue` path as `continue`/`cc`.
    if not args:
        if _RUNTIME_INFO_OVERRIDE is not None:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "--runtime-info requires the read-only runtime command in Wave 1",
                },
                as_json,
            )
            return 2
        return _continue(
            project_root,
            [],
            as_json,
            dry_run,
            shortcut=False,
        )

    command = args[0]

    if _RUNTIME_INFO_OVERRIDE is not None and command != "runtime":
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "Wave-1 --runtime-info is valid only with the read-only runtime command",
            },
            as_json,
        )
        return 2

    if command == "launch":
        # This optional explicit-envelope command pins one actor before host
        # startup. Routine generic host launches do not use this command; Core
        # applies canonical continuation semantics to their guard events.
        if _AGENT_OVERRIDE is None:
            _emit(
                {
                    "ok": False,
                    "code": "ACTOR_UNBOUND",
                    "detail": (
                        "optional explicit host launch requires a SAIPEN seat: "
                        "saipen --agent <seat> launch opencode -- [host args]"
                    ),
                },
                as_json,
            )
            return 1
        rest = args[1:]
        if not rest:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "Use: saipen --agent <seat> launch opencode -- [host args]",
                },
                as_json,
            )
            return 2
        host = rest[0]
        if len(rest) > 1 and rest[1] != "--":
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "host arguments must follow the -- separator",
                },
                as_json,
            )
            return 2
        host_args = rest[2:] if len(rest) > 1 else []
        from saipen_engine.host_launch import HostLaunchRefusal, launch_host

        try:
            return launch_host(host, project_root, _AGENT_OVERRIDE, host_args)
        except HostLaunchRefusal as exc:
            _emit({"ok": False, "code": "HOST_LAUNCH_REFUSED", "detail": str(exc)}, as_json)
            return 1

    # CORE § 1.10 (Cyrillic-twin incident): whole-message shortcut resolution
    # is MECHANICAL and happens FIRST -- before any dispatch branch, before
    # any conversational interpretation. The raw token is normalized through
    # the ONE shared engine resolver: Unicode-CODEPOINT substitution, never
    # keyboard-position substitution. Cyrillic double-es normalizes to Latin
    # "cc" (CONTINUE); it can never become Latin "st" (STOP), because "s" is
    # not a fold target and no Cyrillic character maps to it, which is also
    # why the st/sss rows have no Cyrillic twins at all. Dispatch then
    # proceeds exactly as if the Latin row had been typed, and this file
    # deliberately holds no Cyrillic literal, no confusable map and no twin
    # dictionary for the resolver to drift from. A resolver that cannot load
    # CORE.md returns None for everything: every token then fails closed at
    # its own branch or at the unknown-command refusal -- a failed lookup is
    # NEVER guessed into a command.
    _canonical_shortcut = resolve_shortcut(command, table=load_shortcut_table(PROTOCOL_DIR))
    if _canonical_shortcut is not None:
        args = [_canonical_shortcut, *args[1:]]
        command = _canonical_shortcut
        _ROUTE_ECHO = _canonical_shortcut

    # T-1006/T-1014: an explicit --agent override names the acting actor
    # (CORE-001, SRC-026:R001); it is NOT an automatic seat transfer. The
    # no-op `_ensure_handover` calls are retained purely for call-site
    # stability; an admissible mutation journals the acting actor as
    # provenance, and ownership moves only through `saipen claim` or
    # `operations.handover_agent(..., explicit=True)`. Read-only projections
    # route under the resolved actor without touching disk.

    if command in ("status", "cc", "continue"):
        # T-1378: these are the two questions a session asks when it does not
        # know what to do. Their answer must agree with BOOT's entry table.
        global _ENTRY_HINT_ROOT  # noqa: PLW0603
        _ENTRY_HINT_ROOT = project_root
    if command in ("status", "sss", "cc", "ccc", "continue"):
        # T-1497: every turn-entry question, shortcut or long form, carries the
        # same telegram counts -- `sss` is `status` (test_command_routing).
        global _TELEGRAM_ROOT  # noqa: PLW0603
        _TELEGRAM_ROOT = project_root

    if command == "status":
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"status accepts no arguments; surplus: {' '.join(args[1:])}",
                    "canonical_next_command": "saipen status",
                },
                as_json,
            )
            return 2
        return _status(project_root, as_json)
    if command == "search":
        return _search(project_root, args, as_json)
    if command == "validate":
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"validate accepts no arguments; surplus: {' '.join(args[1:])}",
                    "canonical_next_command": "saipen validate",
                },
                as_json,
            )
            return 2
        return _validate(project_root, as_json)
    if command == "runtime":
        task_class = None
        helper_reason = None
        control_plane = False
        bootstrap = False
        check_freshness = False
        runtime_error = None
        runtime_args = args[1:]
        i = 0
        while i < len(runtime_args):
            token = runtime_args[i]
            if token == "--task-class" and i + 1 < len(runtime_args):
                task_class = runtime_args[i + 1]
                i += 2
            elif token.startswith("--task-class="):
                task_class = token.split("=", 1)[1]
                i += 1
            elif token == "--helper-reason" and i + 1 < len(runtime_args):
                helper_reason = runtime_args[i + 1]
                i += 2
            elif token.startswith("--helper-reason="):
                helper_reason = token.split("=", 1)[1]
                i += 1
            elif token == "--control-plane":
                control_plane = True
                i += 1
            elif token == "--bootstrap":
                bootstrap = True
                i += 1
            elif token in ("--check-freshness", "--check"):
                check_freshness = True
                i += 1
            elif token == "--prelaunch":
                bootstrap = True
                i += 1
            elif token == "--no-resync":
                i += 1
            elif token == "--adapter" and i + 1 < len(runtime_args):
                i += 2
            elif token.startswith("--adapter="):
                i += 1
            else:
                runtime_error = (
                    "runtime accepts only --task-class NAME, --helper-reason NAME, "
                    "--control-plane, --bootstrap and --check-freshness; surplus: " + token
                )
                break
        if runtime_error:
            _emit(
                {"ok": False, "code": "VALIDATION_FAILED", "detail": runtime_error},
                as_json,
            )
            return 2
        if bootstrap or check_freshness:
            # Reached only when a project WAS resolvable; the install-scoped
            # dispatch above owns the stale/unbound case. One implementation.
            return _runtime_install_command(args[1:], as_json)
        return _runtime(project_root, as_json, task_class, helper_reason, control_plane)
    if command == "guard":
        return _guard(project_root, args[1:], as_json)
    if command == "permissions":
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "permissions accepts no arguments; surplus: " + " ".join(args[1:]),
                },
                as_json,
            )
            return 2
        return _permissions(project_root, as_json)
    if command == "explain-next":
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "explain-next accepts no arguments; surplus: " + " ".join(args[1:]),
                },
                as_json,
            )
            return 2
        return _explain_next(project_root, as_json)
    if command == "sss":
        # CORE § 1.10: `sss` routes to read-only status -- the exact same
        # surface as `status`, reached through the shared normalization above
        # for its Cyrillic twin. Never a write, never a phase change.
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"sss accepts no arguments; surplus: {' '.join(args[1:])}",
                    "canonical_next_command": "saipen sss",
                },
                as_json,
            )
            return 2
        return _status(project_root, as_json)
    if command == "next":
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"next accepts no arguments; surplus: {' '.join(args[1:])}",
                    "canonical_next_command": "saipen next",
                },
                as_json,
            )
            return 2
        return _next_action(project_root, as_json)
    if command in ("focus", "ff"):
        from saipen_engine.controls import focus_projection

        result = focus_projection(project_root, " ".join(args[1:]))
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command in ("build", "vv"):
        if len(args) < 2 or not " ".join(args[1:]).strip():
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "Use: vv <build directive>",
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        from saipen_engine.controls import directive_entry

        result = directive_entry(
            project_root,
            _agent_for(project_root),
            " ".join(args[1:]),
            kind="build",
            dry_run=dry_run,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command in ("cut", "xx"):
        from saipen_engine.controls import confirm_cut, cut_preview, decode_agent_plan

        rest = args[1:]
        if not rest:
            _emit(
                {"ok": False, "code": "VALIDATION_FAILED", "detail": "Use: xx <cut target>"},
                as_json,
            )
            return 2
        if rest[0] != "confirm":
            result = cut_preview(project_root, " ".join(rest))
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if len(rest) < 2 or not rest[1].startswith("CUT-"):
            _emit(
                {
                    "ok": False,
                    "code": "DESTRUCTIVE_CONFIRMATION_REQUIRED",
                    "detail": "Use: xx confirm <CUT-ID>",
                },
                as_json,
            )
            return 2
        # The user-facing form stays `xx confirm CUT-ID`.  Fuzzy impact
        # analysis belongs to the agent, which transports its exact resolved
        # plan after `--`; preview itself wrote nothing and held no lock.
        if "--" not in rest:
            _emit(
                {
                    "ok": False,
                    "code": "DESTRUCTIVE_CONFIRMATION_REQUIRED",
                    "detail": (
                        "CUT-ID recognized; agent-resolved impact plan is not "
                        "present in this session"
                    ),
                    "cut_id": rest[1],
                },
                as_json,
            )
            return 1
        marker = rest.index("--")
        if marker != 2 or len(rest) != 4 or len(after_dashdash) != 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "mechanical cut confirmation needs one encoded plan after --",
                },
                as_json,
            )
            return 2
        try:
            plan = decode_agent_plan(rest[3])
        except ValueError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        result = confirm_cut(
            project_root,
            _agent_for(project_root),
            rest[1],
            plan,
            dry_run=dry_run,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command in ("undo", "zz"):
        from saipen_engine.controls import undo_confirm, undo_preview

        rest = args[1:]
        if not rest:
            result = undo_preview(project_root)
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if rest[0] != "confirm" or len(rest) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "DESTRUCTIVE_CONFIRMATION_REQUIRED",
                    "detail": "Use: zz confirm <CP-ID> --reason <one sentence>",
                },
                as_json,
            )
            return 2
        if "--reason" not in rest[2:]:
            _emit(
                {
                    "ok": False,
                    "code": "DESTRUCTIVE_CONFIRMATION_REQUIRED",
                    "detail": "undo confirmation requires --reason <one sentence>",
                },
                as_json,
            )
            return 2
        reason_at = rest.index("--reason")
        reason = " ".join(rest[reason_at + 1 :]).strip()
        if reason_at != 2 or not reason:
            _emit(
                {
                    "ok": False,
                    "code": "DESTRUCTIVE_CONFIRMATION_REQUIRED",
                    "detail": "undo confirmation requires one bounded reason after --reason",
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        result = undo_confirm(
            project_root,
            _agent_for(project_root),
            rest[1],
            reason,
            dry_run=dry_run,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command == "recover":
        return _recover(project_root, args[1:], as_json, dry_run)
    if command == "claim":
        # `--explicit` is the operator-reachable form of the override CORE.md
        # PICK-01 already sanctions. Before T-1275 the NOT_TOP_WORKABLE refusal
        # named a flag no CLI surface set, so the only way to claim a finished
        # ticket that was not topmost was to edit BOARD.md by hand -- the exact
        # manual structural edit OPS.md 4a calls FALLBACK ONLY.
        claim_rest = [a for a in args[1:] if a != "--explicit"]
        claim_explicit = len(claim_rest) != len(args) - 1
        if not claim_rest:
            _emit(
                {"ok": False, "code": "VALIDATION_FAILED", "detail": "claim needs <T-###>"}, as_json
            )
            return 2
        if len(claim_rest) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "claim takes <T-###> [--explicit]; surplus: "
                    + " ".join(claim_rest[1:]),
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = (
            plan_claim(
                project_root, claim_rest[0], _agent_for(project_root), explicit=claim_explicit
            )
            if dry_run
            else apply_claim(
                project_root, claim_rest[0], _agent_for(project_root), explicit=claim_explicit
            )
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command == "transition":
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "ILLEGAL_TRANSITION",
                    "detail": "transition needs <PHASE> [T-###] [text]",
                },
                as_json,
            )
            return 2
        ticket = args[2] if len(args) > 2 and args[2].upper().startswith("T-") else None
        text = " ".join(args[3:] if ticket else args[2:])
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = transition_phase(
            project_root, args[1], _agent_for(project_root), ticket, text, dry_run=dry_run
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command == "checkpoint":
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "checkpoint needs <TAXONOMY> [T-###] [text]",
                },
                as_json,
            )
            return 2
        ticket = args[2] if len(args) > 2 and args[2].upper().startswith("T-") else None
        text = " ".join(args[3:] if ticket else args[2:])
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = checkpoint(
            project_root, _agent_for(project_root), args[1], ticket, text, dry_run=dry_run
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command == "ticket":
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                "detail": "ticket needs an action: "
                "add|compact|verify|reasoning|done|supersede|retire|resolve-external|"
                "repair-metadata|block|block-for|unblock",
                },
                as_json,
            )
            return 2
        action = args[1]
        rest = args[2:]
        if action == "compact":
            if len(rest) != 1 or not re.fullmatch(r"T-\d+", rest[0], re.IGNORECASE):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket compact needs exactly <T-###>",
                    },
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = compact_board(
                project_root, rest[0].upper(), _agent_for(project_root), dry_run=dry_run
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if action == "verify":
            if len(rest) < 2 or not re.fullmatch(r"T-\d+", rest[0], re.IGNORECASE):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket verify needs <T-###> <text>",
                    },
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = ticket_verify(
                project_root,
                rest[0].upper(),
                _agent_for(project_root),
                " ".join(rest[1:]),
                dry_run=dry_run,
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if action == "reasoning":
            # T-1434 M4: the canonical writer for the strict-sweep reasoning
            # gates (`recurrence:` + `weak_model:`). The linkage is proven by
            # the ONE Core-sweep grammar; no raw BOARD field edit.
            if len(rest) < 1 or not re.fullmatch(r"T-\d+", rest[0], re.IGNORECASE):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket reasoning needs <T-###> "
                        "--recurrence <text> --weak-model <text>",
                    },
                    as_json,
                )
                return 2
            recurrence = ""
            weak_model = ""
            tail = rest[1:]
            while tail:
                if tail[0] == "--recurrence" and len(tail) > 1 and not recurrence:
                    recurrence, tail = tail[1], tail[2:]
                elif tail[0] == "--weak-model" and len(tail) > 1 and not weak_model:
                    weak_model, tail = tail[1], tail[2:]
                else:
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "unsupported, duplicate or dangling ticket "
                            f"reasoning option {tail[0]!r}; use "
                            "--recurrence <text> --weak-model <text>",
                        },
                        as_json,
                    )
                    return 2
            if not recurrence or not weak_model:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket reasoning needs both --recurrence <text> "
                        "and --weak-model <text>",
                    },
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = ticket_reasoning(
                project_root,
                rest[0].upper(),
                _agent_for(project_root),
                recurrence,
                weak_model,
                dry_run=dry_run,
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if action == "add":
            if len(rest) < 2:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket add <PRIORITY> <description> "
                        "--verify <proof> [--needs T-X,T-Y]",
                        "canonical_next_command": _ticket_add_route(
                            rest[0] if rest else "", " ".join(rest[1:])
                        ),
                    },
                    as_json,
                )
                return 2
            verify_arg = ""
            needs_arg = []
            has_verify = False
            has_needs = False

            if "--" in rest:
                dd_idx = rest.index("--")
                pre_dd = rest[:dd_idx]
                post_dd = rest[dd_idx + 1 :]
            else:
                pre_dd = rest
                post_dd = []

            clean_rest = []
            idx = 0
            while idx < len(pre_dd):
                if pre_dd[idx] == "--verify":
                    if has_verify:
                        _emit(
                            {
                                "ok": False,
                                "code": "VALIDATION_FAILED",
                                "detail": "duplicate --verify option",
                            },
                            as_json,
                        )
                        return 2
                    if idx + 1 >= len(pre_dd):
                        _emit(
                            {
                                "ok": False,
                                "code": "VALIDATION_FAILED",
                                "detail": "dangling --verify option",
                            },
                            as_json,
                        )
                        return 2
                    verify_arg = pre_dd[idx + 1]
                    has_verify = True
                    idx += 2
                elif pre_dd[idx] == "--needs":
                    if has_needs:
                        _emit(
                            {
                                "ok": False,
                                "code": "VALIDATION_FAILED",
                                "detail": "duplicate --needs option",
                            },
                            as_json,
                        )
                        return 2
                    if idx + 1 >= len(pre_dd):
                        _emit(
                            {
                                "ok": False,
                                "code": "VALIDATION_FAILED",
                                "detail": "dangling --needs option",
                            },
                            as_json,
                        )
                        return 2
                    needs_arg = [n.strip() for n in pre_dd[idx + 1].split(",") if n.strip()]
                    has_needs = True
                    idx += 2
                elif pre_dd[idx].startswith("--"):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": f"unknown option {pre_dd[idx]}",
                        },
                        as_json,
                    )
                    return 2
                else:
                    clean_rest.append(pre_dd[idx])
                    idx += 1

            clean_rest.extend(post_dd)

            if len(clean_rest) < 2:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket add needs <PRIORITY> <description> --verify <proof>",
                        "canonical_next_command": _ticket_add_route(
                            clean_rest[0] if clean_rest else "", ""
                        ),
                    },
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = ticket_add(
                project_root,
                _agent_for(project_root),
                clean_rest[0],
                " ".join(clean_rest[1:]),
                needs_arg,
                verify_arg,
                dry_run=dry_run,
            )
            _emit(result.to_dict(), as_json)
            if result.ok:
                _gpu_echo_advisory(
                    project_root, " ".join(clean_rest), str(result.data.get("ticket") or "")
                )
            return 0 if result.ok else 1
        if action == "supersede":
            _opts, _pos, _opt_err = _parse_value_options(
                rest[1:], _TICKET_SUPERSEDE_OPTIONS
            )
            if not rest or not re.fullmatch(r"T-\d+", rest[0], re.IGNORECASE):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket supersede needs <T-OLD> --by <T-NEW> "
                        "--evidence <E-###> --authority <SRC-###>",
                    },
                    as_json,
                )
                return 2
            if _opt_err:
                _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _opt_err}, as_json)
                return 2
            if _pos:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"ticket supersede takes <T-OLD>; surplus: {' '.join(_pos)}",
                    },
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = supersede_ticket(
                project_root,
                rest[0].upper(),
                str(_opts.get("successor") or "").upper(),
                _agent_for(project_root),
                evidence=str(_opts.get("evidence") or "").upper(),
                authority=str(_opts.get("authority") or "").upper(),
                dry_run=dry_run,
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if action == "resolve-external":
            # SRC-088 M2: a locally reported defect that was implemented in an
            # EXTERNAL authority and is observable in the installed dependency
            # closes truthfully -- no fake local commit, no own_patch, no DONE
            # successor, no rewritten report. The local verification contract
            # is EXECUTED; the append-only EX receipt binds the installed
            # engine generation, so a dependency rollback turns the closure
            # non-green instead of silently green.
            _usage = (
                "ticket resolve-external <T-###> --authority lineage-<32hex> "
                "--implementation T-###@<commit> --reason "
                "PROTOCOL_HOME_FIX_VERIFIED|DEPENDENCY_UPGRADE_VERIFIED|"
                "UPSTREAM_FIX_VERIFIED --run <command> [--run <command>]... "
                "[--verification <command>:PASS]... [--contract sha256:...] "
                "[--timeout SECONDS]"
            )
            if not rest or not re.fullmatch(r"T-\d+", rest[0], re.IGNORECASE):
                _emit(
                    {"ok": False, "code": "VALIDATION_FAILED", "detail": _usage},
                    as_json,
                )
                return 2
            _work_id = rest[0].upper()
            _authority = ""
            _implementation = ""
            _reason = ""
            _contract = ""
            _timeout = 300
            _runs: list[str] = []
            _verification: list[dict] = []
            _err = ""
            _i = 1
            while _i < len(rest):
                _tok = rest[_i]
                _value_options = (
                    "--authority",
                    "--implementation",
                    "--reason",
                    "--contract",
                    "--timeout",
                    "--run",
                    "--verification",
                )
                if _tok in _value_options:
                    if _i + 1 >= len(rest):
                        _err = f"option {_tok} needs a value"
                        break
                    _value = rest[_i + 1]
                    _i += 2
                    if _tok == "--authority":
                        _authority = _value
                    elif _tok == "--implementation":
                        _implementation = _value
                    elif _tok == "--reason":
                        _reason = _value
                    elif _tok == "--contract":
                        _contract = _value
                    elif _tok == "--timeout":
                        try:
                            _timeout = int(_value)
                        except ValueError:
                            _err = f"--timeout needs whole seconds, got {_value!r}"
                            break
                        if _timeout <= 0:
                            _err = "--timeout must be positive"
                            break
                    elif _tok == "--run":
                        _runs.append(_value)
                    else:
                        _cmd, _, _verdict = _value.rpartition(":")
                        _verification.append(
                            {"command": _cmd or _value, "result": _verdict or _value}
                        )
                    continue
                _err = f"unknown ticket resolve-external argument: {_tok}"
                break
            if _err:
                _emit(
                    {"ok": False, "code": "VALIDATION_FAILED", "detail": _err},
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = resolve_external_ticket(
                project_root,
                _work_id,
                _agent_for(project_root),
                authority=_authority,
                implementation=_implementation,
                resolution_reason=_reason,
                runs=_runs or None,
                verification=_verification or None,
                contract=_contract or None,
                timeout=_timeout,
                dry_run=dry_run,
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if action == "repair-metadata":
            # T-1435 M3: the ONE canonical migration for malformed machine
            # metadata on a historical DONE row. The implementation is the
            # existing operation/journal/receipt machinery; this branch only
            # parses the closed grammar.
            _usage = (
                "ticket repair-metadata <T-###> --field source_receipts "
                "(--to SRC-### | --legacy-unbound [--authority "
                "SRC-###|lineage-<32hex>])"
            )
            if not rest or not re.fullmatch(r"T-\d+", rest[0], re.IGNORECASE):
                _emit(
                    {"ok": False, "code": "VALIDATION_FAILED", "detail": _usage},
                    as_json,
                )
                return 2
            _work_id = rest[0].upper()
            _field = ""
            _to_target = ""
            _legacy_unbound = False
            _authority = ""
            _err = ""
            _i = 1
            while _i < len(rest):
                _tok = rest[_i]
                if _tok == "--legacy-unbound":
                    if _legacy_unbound:
                        _err = "duplicate option --legacy-unbound"
                        break
                    _legacy_unbound = True
                    _i += 1
                    continue
                if _tok in ("--field", "--to", "--authority"):
                    if _i + 1 >= len(rest):
                        _err = f"option {_tok} needs a value"
                        break
                    _value = rest[_i + 1]
                    _i += 2
                    if _tok == "--field":
                        if _field:
                            _err = "duplicate option --field"
                            break
                        _field = _value
                    elif _tok == "--to":
                        if _to_target:
                            _err = "duplicate option --to"
                            break
                        _to_target = _value
                    else:
                        if _authority:
                            _err = "duplicate option --authority"
                            break
                        _authority = _value
                    continue
                _err = f"unknown ticket repair-metadata argument: {_tok}"
                break
            if _err:
                _emit(
                    {"ok": False, "code": "VALIDATION_FAILED", "detail": _err},
                    as_json,
                )
                return 2
            if not _field or bool(_to_target) == bool(_legacy_unbound):
                _emit(
                    {"ok": False, "code": "VALIDATION_FAILED", "detail": _usage},
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = repair_metadata(
                project_root,
                _work_id,
                _agent_for(project_root),
                field=_field,
                to_target=_to_target or None,
                legacy_unbound=_legacy_unbound,
                authority=_authority,
                dry_run=dry_run,
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if action == "retire":
            # CORE: retirement is NOT completion. It is the canonical verdict
            # for Work that was minted into the WRONG PROJECT, and it refuses
            # without a registered reason, resolvable evidence and an operator
            # authority receipt whose own bytes carry a capsule granting this
            # ticket.
            _opts, _pos, _opt_err = _parse_value_options(rest[1:], _TICKET_RETIRE_OPTIONS)
            if not rest or not re.fullmatch(r"T-\d+", rest[0], re.IGNORECASE):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket retire needs <T-###> --reason <CODE> "
                        "--evidence <E-###|.saipen/evidence/PATH> --authority SRC-### "
                        "[--discovery-event E-###] [--note TEXT]",
                    },
                    as_json,
                )
                return 2
            if _opt_err:
                _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _opt_err}, as_json)
                return 2
            if _pos:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"ticket retire takes <T-###>; surplus: {' '.join(_pos)}",
                    },
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            from saipen_engine.operations import retire_ticket as _retire_ticket

            result = _retire_ticket(
                project_root,
                rest[0].upper(),
                _agent_for(project_root),
                reason=str(_opts.get("reason") or "").strip().upper(),
                evidence=str(_opts.get("evidence") or ""),
                authority=str(_opts.get("authority") or ""),
                discovery_event=(_opts.get("discovery_event") or None),
                note=_opts.get("note"),
                dry_run=dry_run,
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if action == "done":
            if not rest:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "ticket done needs <T-###>",
                    },
                    as_json,
                )
                return 2
            # CORE-003: closure provenance is part of the PUBLIC grammar.
            # An engine-only closure mode is unusable -- the FastPrompter
            # failure happened to an agent running `saipen ...`, not to a
            # Python caller.
            _opts, _pos, _opt_err = _parse_value_options(rest[1:], _TICKET_DONE_OPTIONS)
            if _opt_err:
                _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _opt_err}, as_json)
                return 2
            if _pos:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"ticket done takes <T-###>; surplus: {' '.join(_pos)}",
                    },
                    as_json,
                )
                return 2
            _paths = [
                part.strip()
                for part in str(_opts.get("closure_paths", "")).replace(",", " ").split()
                if part.strip()
            ]
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = finish_ticket(
                project_root,
                rest[0],
                _agent_for(project_root),
                dry_run=dry_run,
                closure_mode=_opts.get("closure_mode"),
                closure_cohort=_opts.get("closure_cohort"),
                implementation_source=_opts.get("implementation_source"),
                closure_paths=_paths,
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        if action in ("block", "block-for", "unblock"):
            if not rest or (action == "block-for" and len(rest) < 2):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": (
                            "ticket block-for needs <parent T-###> <blocker T-###> <reason>"
                            if action == "block-for"
                            else f"ticket {action} needs <T-###> [reason/decision]"
                        ),
                    },
                    as_json,
                )
                return 2
            # `--scope ticket|goal` (CORE-003) may appear anywhere after the
            # ticket id; everything else stays the free-text reason/decision.
            option_input = rest[2:] if action == "block-for" else rest[1:]
            _opts, _pos, _opt_err = _parse_value_options(option_input, _TICKET_BLOCK_OPTIONS)
            if _opt_err:
                _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _opt_err}, as_json)
                return 2
            if action == "unblock" and (_opts.get("scope") or _opts.get("retry_not_before")):
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": (
                            "--scope and --retry_not_before describe a BLOCK; "
                            "unblock takes neither"
                        ),
                    },
                    as_json,
                )
                return 2
            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = ticket_move(
                project_root,
                action,
                rest[0],
                _agent_for(project_root),
                " ".join(_pos),
                dry_run=dry_run,
                scope=_opts.get("scope"),
                blocked_on=rest[1] if action == "block-for" else None,
                retry_not_before=_opts.get("retry_not_before"),
            )
            _emit(result.to_dict(), as_json)
            return 0 if result.ok else 1
        _emit(
            {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": f"unknown ticket action {action!r}",
            },
            as_json,
        )
        return 2
    if command == "work":
        # T-1434 M1: first-class DONE-Work re-verification. The engine logic
        # existed (debt.reverify_work) but no canonical CLI route reached it,
        # so the validator's own remediation named a move this surface could
        # not execute. `saipen work reverify <T-###>` IS that move: it records
        # ONE immutable RV-NNNNNN receipt against the CURRENT tree, derived
        # from the project's own strict gate unless explicit checks are given.
        # DONE stays DONE; no lifecycle edge, no history rewrite.
        sub = args[1] if len(args) > 1 else ""
        if sub != "reverify":
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "work needs an action: reverify <T-###> "
                    '[--verification "command:PASS"] [--run "command"] [--timeout SECONDS]',
                },
                as_json,
            )
            return 2
        rest = args[2:]
        work_id = ""
        verification: list[dict] = []
        runs: list[str] = []
        timeout = 300
        i = 0
        while i < len(rest):
            tok = rest[i]
            if tok == "--verification":
                if i + 1 >= len(rest):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "dangling --verification option",
                        },
                        as_json,
                    )
                    return 2
                i += 1
                spec = rest[i]
                cmd, _, verdict = spec.rpartition(":")
                # T-1434 M5.3: an attested entry is TYPED from the moment it
                # enters the engine. It is recorded evidence ("the caller says
                # this check passes"), never executable proof, and closure
                # consumption distinguishes the two classes mechanically.
                verification.append(
                    {
                        "command": cmd or spec,
                        "result": verdict or spec,
                        "executed": False,
                        "kind": "attested",
                    }
                )
            elif tok == "--run":
                if i + 1 >= len(rest):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "dangling --run option",
                        },
                        as_json,
                    )
                    return 2
                i += 1
                runs.append(rest[i])
            elif tok == "--timeout":
                if i + 1 >= len(rest):
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "dangling --timeout option",
                        },
                        as_json,
                    )
                    return 2
                i += 1
                try:
                    timeout = int(rest[i])
                except ValueError:
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": f"--timeout needs whole seconds, got {rest[i]!r}",
                        },
                        as_json,
                    )
                    return 2
                if timeout <= 0:
                    _emit(
                        {
                            "ok": False,
                            "code": "VALIDATION_FAILED",
                            "detail": "--timeout must be positive",
                        },
                        as_json,
                    )
                    return 2
            elif tok.startswith("T-") and not work_id:
                work_id = tok
            else:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": f"unknown work reverify argument: {tok}",
                    },
                    as_json,
                )
                return 2
            i += 1
        if not work_id:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "work reverify needs a T-### Work id",
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        from saipen_engine import debt as _debt_mod

        try:
            result = _debt_mod.reverify_work(
                project_root,
                work_id,
                _agent_for(project_root),
                verification=verification or None,
                runs=runs or None,
                timeout=timeout,
                derive_default=not verification and not runs,
                dry_run=dry_run,
            )
        except _debt_mod.DebtRefusal as exc:
            _emit(
                {"ok": False, "code": exc.code, "detail": exc.detail, "work": work_id},
                as_json,
            )
            return 1
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    if command == "start":
        # T-1363: the one entry command for a new actionable task.
        return _start(project_root, args[1:], as_json, dry_run)
    if command == "user-request":
        # CORE-003: the USER_INTERRUPT ingress. The complete request becomes
        # durable Source authority BEFORE the concise BOARD projection, so a
        # crash can never leave a ticket whose request body was lost.
        _supersede_ingress = "--supersede-ingress" in args[1:]
        _opts, _pos, _opt_err = _parse_value_options(
            [token for token in args[1:] if token != "--supersede-ingress"],
            {"--priority": "priority", "--verify": "verify", "--needs": "needs"},
        )
        if _opt_err:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": _opt_err}, as_json)
            return 2
        if not _pos:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "Use: saipen user-request <request text> "
                    "[--priority P#] [--verify <text>] [--needs T-X,T-Y]",
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        # T-1425: the USER_INTERRUPT ingress converges a dead home first, so a
        # new explicit request never dies on a stale foreign-host pointer when
        # a replacement runtime is already proven.
        _converged = _converge_home_binding(project_root, as_json, dry_run)
        if _converged is not None:
            return _converged
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        from saipen_engine.operations import user_request as _user_request

        _needs = [
            part.strip()
            for part in str(_opts.get("needs", "")).replace(",", " ").split()
            if part.strip()
        ]
        result = _user_request(
            project_root,
            _agent_for(project_root),
            " ".join(_pos),
            priority=_opts.get("priority") or "P1",
            verify=_opts.get("verify"),
            needs=_needs,
            dry_run=dry_run,
            supersede_ingress=_supersede_ingress,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command == "cohort":
        return _cohort(project_root, args[1:], as_json, dry_run)
    if command in ("goal", "gg"):
        if len(args) < 2 or not args[1].strip():
            # CORE-005: bare `goal`/`gg` is zero-write and emits exactly
            # `Use: gg <objective text>` (CORE § 1.10).
            if as_json:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "Use: gg <objective text>",
                    },
                    as_json,
                )
            else:
                print("Use: gg <objective text>")
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        from saipen_engine.operations import goal_entry

        result = goal_entry(
            project_root, _agent_for(project_root), " ".join(args[1:]), dry_run=dry_run
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command == "userperson":
        return _userperson(project_root, args[1:], as_json, dry_run)
    if command == "sub":
        return _sub(project_root, args[1:], as_json, dry_run)
    if command == "rebind-home":
        # T-1425: `--auto` is the canonical automatic convergence path. It
        # adopts only a runtime host bootstrap already PROVED (executing
        # engine or a verified carrier), never a guessed path, and refuses
        # HOME_REQUIRED with the explicit form when nothing is proven.
        if len(args) == 2 and args[1] == "--auto":
            from saipen_engine.operations import rebind_home_auto

            if not dry_run and _negotiate_capability(project_root) == "read-only":
                return _capability_refusal(as_json)
            _ho = _ensure_handover(project_root, as_json, dry_run)
            if _ho is not None:
                return _ho
            result = rebind_home_auto(
                project_root, _agent_for(project_root), dry_run=dry_run
            )
            payload = result.to_dict()
            payload["route"] = "rebind-home --auto"
            _emit(payload, as_json)
            return 0 if result.ok else 1
        if len(args) < 2:
            _emit(
                {
                    "ok": False,
                    "code": "HOME_REQUIRED",
                    "detail": (
                        "rebind-home needs <candidate-home-path>, or --auto to "
                        "converge onto an already-proven canonical runtime"
                    ),
                },
                as_json,
            )
            return 2
        if len(args) > 2:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"rebind-home takes <candidate-home-path>; surplus: {' '.join(args[2:])}",  # noqa: E501
                },
                as_json,
            )
            return 2
        from saipen_engine.operations import rebind_saipen_home

        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = rebind_saipen_home(
            project_root, _agent_for(project_root), args[1], dry_run=dry_run
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command == "crew":
        return _crew(project_root, args[1:], as_json, dry_run)
    if command == "context":
        return _context(project_root, args[1:], as_json, dry_run)
    if command == "knowledge":
        return _knowledge(project_root, args[1:], as_json, dry_run)
    if command == "attempt":
        return _attempt(project_root, args[1:], as_json, dry_run)
    if command == "audit":
        try:
            return _audit(project_root, args[1:], as_json, dry_run)
        except (OSError, PermissionError, ValueError) as exc:
            _emit(
                {"ok": False, "code": "VALIDATION_FAILED", "detail": f"audit inbox: {exc}"},
                as_json,
            )
            return 1
    if command == "source":
        try:
            return _source(project_root, args[1:], as_json, dry_run)
        except (OSError, PermissionError, ValueError) as exc:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"source receipt validation: {exc}",
                },
                as_json,
            )
            return 1
    if command == "authority":
        # T-1414: persist ONE operator-authority Source and project NOTHING.
        # The capsule grammar is retirement's own closed parser; this verb is
        # only the byte-exact transport (--file / --hex, never a joined argv).
        from saipen_engine.operations import authority_capture

        rest = args[1:]
        if not rest or rest[0] != "capture":
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "authority needs an action: capture --file <UTF8_FILE> | "
                    "capture --hex <UTF8_HEX>",
                    "canonical_next_command": "saipen authority capture --file <UTF8_FILE>",
                },
                as_json,
            )
            return 2
        file_path = None
        hex_payload = None
        opts = rest[1:]
        index = 0
        while index < len(opts):
            token = opts[index]
            if token not in ("--file", "--hex") or index + 1 >= len(opts):
                detail = (
                    f"{token} needs a value"
                    if token in ("--file", "--hex")
                    else f"unknown argument {token!r}"
                )
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": detail,
                        "canonical_next_command": "saipen authority capture --file <UTF8_FILE>",
                    },
                    as_json,
                )
                return 2
            value = opts[index + 1]
            if file_path is not None or hex_payload is not None:
                _emit(
                    {
                        "ok": False,
                        "code": "VALIDATION_FAILED",
                        "detail": "authority capture takes exactly one carrier: "
                        "--file or --hex, not both",
                    },
                    as_json,
                )
                return 2
            if token == "--file":
                file_path = value
            else:
                hex_payload = value
            index += 2
        if file_path is None and hex_payload is None:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "authority capture needs --file <UTF8_FILE> or --hex <UTF8_HEX>",
                    "canonical_next_command": "saipen authority capture --file <UTF8_FILE>",
                },
                as_json,
            )
            return 2
        try:
            if file_path is not None:
                text = Path(file_path).read_bytes().decode("utf-8")
            else:
                text = bytes.fromhex(hex_payload).decode("utf-8")
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"authority capture needs exact UTF-8 bytes: {exc}",
                },
                as_json,
            )
            return 1
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        result = authority_capture(project_root, _agent_for(project_root), text, dry_run=dry_run)
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command == "gpu":
        return _gpu(project_root, args[1:], as_json)
    if command == "autonomy":
        # T-1446: the read-only autonomy picture a supervisor or a cold worker
        # reads before deciding anything. Writes nothing; `decide` is included
        # because the verdict and the observation that produced it must be one
        # answer, not two reads a caller could take at different moments.
        if args[1:2] == ["recall"]:
            return _autonomy_recall(project_root, args[2:], as_json)
        surplus = [a for a in args[1:] if a not in ("--json", "status")]
        if surplus:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"autonomy accepts no arguments; surplus: {' '.join(surplus)}",
                    "canonical_next_command": "saipen autonomy --json",
                },
                as_json,
            )
            return 2
        from saipen_engine import supervisor as _supervisor

        _verdict = _supervisor.decide(project_root)
        _emit(
            {
                "ok": True,
                "code": "AUTONOMY_STATUS",
                "verdict": _verdict["verdict"],
                "reason": _verdict["reason"],
                "may_mutate": _verdict["may_mutate"],
                "requires_human": _verdict["requires_human"],
                "stop_reason": _verdict["stop_reason"],
                "canonical_next_command": _verdict["next_command"],
                "observation": _verdict["observation"],
            },
            as_json,
        )
        return 0
    if command == "acceptance":
        return _acceptance(project_root, args[1:], as_json)
    if command == "brief":
        surplus = [a for a in args[1:] if a != "--json"]
        if surplus:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"brief accepts no arguments; surplus: {' '.join(surplus)}",
                    "canonical_next_command": "saipen brief",
                },
                as_json,
            )
            return 2
        return _brief(project_root, as_json)
    if command == "hush":
        # EXEC-HUSH-01: the mechanical projection of one activation. It
        # resolves the policy and hands back the task VERBATIM; it deliberately
        # does not execute the task, because the whole contract is that the
        # normal resolver -- not this modifier -- decides the route.
        from saipen_engine import hush as hush_runtime

        # The dispatcher already consumed the modifier token, so rebuild the
        # message the runtime parses. One parser, one place, no second reading
        # of what `hush` means.
        activation = hush_runtime.activate(" ".join([hush_runtime.MODIFIER, *args[1:]]))
        payload = {k: v for k, v in activation.items() if k != "policy"}
        if not payload["ok"]:
            payload["detail"] = "hush needs a task to modify"
        _emit(payload, as_json)
        return 0 if payload["ok"] else 2
    if command == "improve":
        return _public_improve(project_root, args[1:], as_json, dry_run)
    if command == "scope":
        if len(args) < 3:
            _emit(
                {
                    "ok": False,
                    "code": "SOURCE_SCOPE_MISSING",
                    "detail": "scope needs <T-###> <path> [path ...]",
                },
                as_json,
            )
            return 2
        from saipen_engine.operations import record_scope

        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = record_scope(
            project_root, args[1], _agent_for(project_root), args[2:], dry_run=dry_run
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command in ("first-publish-confirm", "fpc"):
        if len(args) != 3:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "first-publish-confirm needs <name> <public|private>",
                },
                as_json,
            )
            return 2
        from saipen_engine.operations import confirm_first_publish

        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = confirm_first_publish(
            project_root, _agent_for(project_root), args[1], args[2], dry_run=dry_run
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1
    if command in ("ship", "push"):
        surplus = [a for a in args[1:] if not a.startswith("--")]
        unknown_flags = [a for a in args[1:] if a.startswith("--")]
        if surplus or unknown_flags:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": (
                        f"{command} accepts no arguments; surplus: "
                        f"{' '.join(surplus + unknown_flags)}"
                    ),
                },
                as_json,
            )
            return 2
        from saipen_engine.release import ReleaseRefusal, execute_release, plan_release

        try:
            # P0#4: inject the freshly negotiated current-session capability so
            # a read-only session cannot PLAN a release. Second-wave P0: the
            # acting identity is the SESSION agent, never persisted STATE.agent.
            plan = plan_release(
                project_root,
                command,
                dry_run=dry_run,
                current_capability=_negotiate_capability(project_root),
                current_agent=_agent_for(project_root),
            )
        except ReleaseRefusal as exc:
            _emit(
                {
                    "ok": False,
                    "code": exc.code,
                    "detail": exc.detail,
                    "canonical_next_command": getattr(exc, "next_command", None),
                },
                as_json,
            )
            return 1
        except ValueError as exc:
            _emit({"ok": False, "code": "VALIDATION_FAILED", "detail": str(exc)}, as_json)
            return 1
        result = execute_release(project_root, plan)
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    # ── Autonomous command closure (SAIPEN intent handlers) ────────
    # qq/ee/qqq/eee are protocol semantic operations, not CLI aliases.

    # AUTO-003: CORE section 1.10 phase-trigger verbs. These MUST be
    # recognized as canonical commands, never rejected as "unknown command"
    # which would cause a weak model to improvise a destructive substitute
    # (e.g. `saipen clean` -> `sub clean saihunt`). Each verb routes to the
    # canonical phase trigger (transition_phase / dedicated semantic).
    _PHASE_VERBS = frozenset({"clean", "hunt", "markhunt", "translate", "validate"})
    # CORE § 1.10 repeated-letter rows routing to phase triggers. They are
    # the SAME transitions as the spelled-out verbs -- identical gates,
    # identical writes -- reached through the shared shortcut normalization.
    _SHORTCUT_PHASE_TRIGGERS = {"hh": "HUNT", "aa": "MARKHUNT"}
    if command in _PHASE_VERBS or command in _SHORTCUT_PHASE_TRIGGERS:
        phase = _SHORTCUT_PHASE_TRIGGERS.get(command) or command.upper()
        surplus = args[1:]
        if surplus:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"{command} accepts no arguments; surplus: {' '.join(surplus)}",
                },
                as_json,
            )
            return 2
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        result = transition_phase(
            project_root,
            phase,
            _agent_for(project_root),
            ticket_id=None,
            event_text="",
            dry_run=dry_run,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1

    if command in ("plan", "dd"):
        # CORE section 1.10: explicit PLAN trigger; `dd` is the closed shortcut alias.
        # `dd` accepts optional free text exactly like `plan`; destination validates.
        if not dry_run and _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        _ho = _ensure_handover(project_root, as_json, dry_run)
        if _ho is not None:
            return _ho
        text = " ".join(args[1:]) if len(args) > 1 else ""
        result = transition_phase(
            project_root,
            "PLAN",
            _agent_for(project_root),
            ticket_id=None,
            event_text=text,
            dry_run=dry_run,
        )
        _emit(result.to_dict(), as_json)
        return 0 if result.ok else 1

    if command == "qq":
        refused = _exact_no_args(command, args[1:], as_json)
        if refused is not None:
            return refused
        from saipen_engine.intent import ensure_producer_ready

        result = ensure_producer_ready(
            project_root,
            "saiwiki",
            dry_run=dry_run,
            current_capability=_negotiate_capability(project_root),
            current_agent=_agent_for(project_root),
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    if command == "prepare":
        invalid_producer = len(args) == 2 and (not args[1].strip() or args[1].startswith("-"))
        if len(args) > 2 or invalid_producer:
            surplus = args[2:] if len(args) > 2 else args[1:]
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": "prepare accepts at most one producer name; invalid/surplus: "
                    + " ".join(surplus),
                },
                as_json,
            )
            return 2
        from saipen_engine.intent import ensure_producer_ready

        result = ensure_producer_ready(
            project_root,
            args[1] if len(args) == 2 else "saiwiki",
            dry_run=dry_run,
            current_capability=_negotiate_capability(project_root),
            current_agent=_agent_for(project_root),
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    if command in ("ee", "prepare-translate"):
        refused = _exact_no_args(command, args[1:], as_json)
        if refused is not None:
            return refused
        from saipen_engine.intent import ensure_producer_ready

        result = ensure_producer_ready(
            project_root,
            "saitranslate",
            dry_run=dry_run,
            current_capability=_negotiate_capability(project_root),
            current_agent=_agent_for(project_root),
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    if command in ("qqq", "ship-wiki"):
        refused = _exact_no_args(command, args[1:], as_json)
        if refused is not None:
            return refused
        from saipen_engine.intent import collect_and_ship_producer

        result = collect_and_ship_producer(
            project_root,
            "saiwiki",
            dry_run=dry_run,
            current_capability=_negotiate_capability(project_root),
            current_agent=_agent_for(project_root),
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    if command in ("eee", "ship-translate"):
        refused = _exact_no_args(command, args[1:], as_json)
        if refused is not None:
            return refused
        from saipen_engine.intent import collect_and_ship_producer

        result = collect_and_ship_producer(
            project_root,
            "saitranslate",
            dry_run=dry_run,
            current_capability=_negotiate_capability(project_root),
            current_agent=_agent_for(project_root),
        )
        _emit(result, as_json)
        return 0 if result.get("ok") else 1
    if command == "pp":
        # CORE § 1.10: `pp` routes to exactly `saipen sub spawn saipython`.
        # No extra arguments -- the row is a closed route, not a family.
        refused = _exact_no_args(command, args[1:], as_json)
        if refused is not None:
            return refused
        return _sub(project_root, ["spawn", "saipython"], as_json, dry_run)
    if command in ("sc", "autonomous-crew"):
        return _crew(project_root, args[1:], as_json, dry_run)
    if command in ("cc", "continue"):
        return _continue(
            project_root,
            args[1:],
            as_json,
            dry_run,
            shortcut=command == "cc",
        )
    if command == "ss":
        # SRC-024 (audit/11.md): `ss` is RETIRED. It once routed to STOP and
        # its visual/semantic overlap with `sss` (STATUS) made one accidental
        # repeated letter flip control flow between observation and mutation.
        # The tombstone is fail-closed: it reaches NEITHER the stop nor the
        # status implementation, writes zero bytes, and names the two live
        # tokens so a stale agent gets deterministic migration guidance
        # instead of unpredictable model behavior.
        _emit(
            {
                "ok": False,
                "code": "SHORTCUT_RETIRED",
                "route": "ss",
                "detail": (
                    "shortcut `ss` was retired: `st` is `saipen stop` "
                    "(checkpoint and stop), `sss` is read-only `saipen status`"
                ),
                "use_instead": {"stop": "st", "status": "sss"},
            },
            as_json,
        )
        return 1
    if command in ("stop", "st"):
        # CORE § 1.10: `st` routes to `saipen stop` -- checkpoint, digest,
        # halt. Exact one nonterminal STOP carrier; read-only sessions emit
        # chat lines.
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"stop accepts no arguments; surplus: {' '.join(args[1:])}",
                    "canonical_next_command": "saipen stop",
                },
                as_json,
            )
            return 2
        from saipen_engine.operations import stop_checkpoint

        capability = _negotiate_capability(project_root)
        projection_only = dry_run or capability == "read-only"
        result = stop_checkpoint(
            project_root,
            _agent_for(project_root),
            dry_run=projection_only,
        )
        payload = result.to_dict()
        payload["dry_run"] = dry_run
        payload["route"] = command
        if capability == "read-only":
            payload["mode"] = "read-only"
        if result.ok:
            payload["operation_code"] = payload.get("code")
            payload["code"] = "STOP"
            payload["detail"] = (
                "read-only stop projection"
                if capability == "read-only"
                else ("dry-run stop projection" if dry_run else "stop checkpoint committed")
            )
        _emit(payload, as_json)
        return 0 if result.ok else 1
    if command in ("test", "tt"):
        # CORE § 1.10: `tt` routes to `saipen test` -- read-only suite report.
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"test accepts no arguments; surplus: {' '.join(args[1:])}",
                    "canonical_next_command": "saipen test",
                },
                as_json,
            )
            return 2
        from saipen_engine.test_runner import canonical_test_plan, run_canonical_suite

        if dry_run:
            _emit(
                {
                    "ok": True,
                    "code": "TEST_PLAN",
                    "detail": "canonical test families planned; zero suites executed",
                    "families": canonical_test_plan(project_root),
                    "dry_run": True,
                    "route": command,
                },
                as_json,
            )
            return 0
        try:
            report = run_canonical_suite(project_root)
            ok = report["ok"]
            _emit(
                {
                    "ok": ok,
                    "code": "TEST_REPORT",
                    "detail": "canonical test families executed in an isolated copy",
                    "families": report["families"],
                    "route": command,
                },
                as_json,
            )
            return 0 if ok else 1
        except Exception as exc:
            _emit(
                {"ok": False, "code": "TEST_REPORT", "detail": f"test harness error: {exc}"},
                as_json,
            )
            return 1
    if command == "ccc":
        # CORE § 1.10: `ccc` is `saipen continue` with converge_target: ship,
        # then SHIP, then stages J-M. Minimal deterministic entry per Wave 1:
        # validate, checkpoint active work, set converge ship, clear goal counters,
        # write pre-SHIP source marker, return nonterminal carrier.
        if len(args) > 1:
            _emit(
                {
                    "ok": False,
                    "code": "VALIDATION_FAILED",
                    "detail": f"ccc accepts no arguments; surplus: {' '.join(args[1:])}",
                    "canonical_next_command": "saipen ccc",
                },
                as_json,
            )
            return 2
        if _negotiate_capability(project_root) == "read-only":
            return _capability_refusal(as_json)
        from saipen_engine.operations import enter_ship_convergence

        result = enter_ship_convergence(
            project_root,
            _agent_for(project_root),
            dry_run=dry_run,
        )
        payload = result.to_dict()
        payload["dry_run"] = dry_run
        if result.ok:
            payload.update(
                {
                    "execution_intent": "converge",
                    "converge_target": "ship",
                    "route": command,
                }
            )
        _emit(payload, as_json)
        return 0 if result.ok else 1
    # CORE § 1.10 fail-closed floor: a token that IS a declared shortcut but
    # has no deterministic executor in this adapter is REFUSED with its exact
    # canonical route named -- never "unknown command" (which invites a weak
    # model to improvise a substitute, the AUTO-003 defect), and never a
    # guessed partial execution. Cyrillic twins are already folded above, so
    # this refusal is identical for a row and its twin by construction.
    _shortcut_table = load_shortcut_table(PROTOCOL_DIR)
    if command in _shortcut_table:
        _emit(
            {
                "ok": False,
                "code": "SHORTCUT_NOT_EXECUTABLE",
                "detail": f"{command} resolves to `{_shortcut_table[command]}` "
                "(CORE § 1.10); this deterministic adapter implements no "
                "executor for that row -- execute the exact row's semantics "
                "at the agent layer, never a guessed substitute",
            },
            as_json,
        )
        return 1
    # T-1159: an unknown command in a project whose `saipen_home` names a
    # DIFFERENT SAIPEN install than the one executing is runtime drift (the
    # observed stale-installed-skill incident), never a bare project error.
    drift = _runtime_drift_payload(project_root, command)
    if drift is not None:
        _emit(drift, as_json)
        if not as_json:
            print("SAIPEN RUNTIME DRIFT")
            print(
                f"Project protocol: {drift['project_protocol']['home']} "
                f"(v{drift['project_protocol']['version']})"
            )
            print(f"Runtime protocol: {drift['runtime']['home']} (v{drift['runtime']['version']})")
            print(f"Command required by project: {command}")
            print("Runtime cannot execute it safely.")
            print(f"Action: {drift['action']}")
        return 2
    if as_json:
        _emit(
            {"ok": False, "code": "VALIDATION_FAILED", "detail": f"unknown command: {command}"},
            as_json,
        )
    else:
        print(f"unknown command: {command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
