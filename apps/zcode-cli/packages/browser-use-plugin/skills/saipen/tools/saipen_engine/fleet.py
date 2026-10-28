"""Bounded Fleet preflight and one-attempt delegation to canonical recovery.

This module owns classification and orchestration only. Root resolution belongs
to paths.py; repair planning, evidence and writes belong to reconcile.py and
the public `saipen recover` command.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path
from typing import Callable

from .admission import _read_text_bounded, protocol_snapshot
from .board import MAX_LIVE_RECORD_CHARS, parse_board
from .board_compaction import compacted_ticket_ids, detail_integrity_error, oversized_ticket_ids
from .journal import scan_pending
from .paths import (
    ENV_AGENT,
    ENV_PROJECT_LINEAGE,
    ENV_PROJECT_ROOT,
    project_identity,
    resolve_project_root,
)
from .reconcile import reconcile_protocol_state
from .state import parse_frontmatter

CLASS_NON_SAIPEN = "NON_SAIPEN"
CLASS_UNBOUND = "UNBOUND"
CLASS_VALID = "BOUND_VALID"
CLASS_SAFE = "BOUND_RECOVERY_REQUIRED_SAFE"
CLASS_BLOCKED = "BOUND_RECOVERY_REQUIRED_BLOCKED"
CLASS_CONFLICT = "BINDING_CONFLICT"
MAX_SCAN_ROOTS = 32
MAX_FACT_CHARS = 240
MAX_STATE_BYTES = 256 * 1024
MAX_CONDITION_BYTES = 16 * 1024 * 1024

# T-1324 Target G: codes that name an explicit operator adjudication rather than
# an automatic repair. Closed set -- an unrecognised blocked code still carries a
# canonical route (below), so the invariant never depends on this list.
_OPERATOR_DECISION_CODES = frozenset(
    {
        "RECONCILE_REAUTH_REQUIRED",
        "CORRUPT_JOURNAL",
        "RECOVERY_CONFLICT",
        "RECOVERY_EVIDENCE_UNBOUND",
        "WAIT_BLOCKED",
        "NO_ACTIVE_WORK",
        "PROTOCOL_MODE_READONLY",
        "PROTOCOL_STATE_INVALID",
    }
)
_AUTO_RECOVERY_CODES = frozenset({"REPAIR_REQUIRED", "RECOVERY_REQUIRED"})
_RECOVER_COMMAND = "saipen recover"
_BOARD_COMPACTION_COMMAND = "saipen ticket compact"
# T-1324 Target C/G: a gated STATE.blocker has an OPERATOR DECISION verb, not a
# generic unblock. The exact command is the reachable one; the operator supplies
# the decision text (there is no defaulted authority).
#: T-1357: printed UNQUOTED. A quote character disqualifies the whole line
#: from the guard's canonical grammar, so a quoted form is a command the
#: engine advertises and its own guard can never admit.
_BLOCKER_DECISION_COMMAND = 'saipen recover resolve-blocker <decision>'

#: T-1327 TARGET A: the CLOSED set of canonical repairs Fleet may execute by
#: itself. A `canonical_next_command` is never run as a shell string and never
#: interpolated: it is PARSED into an exact structured argv here, or it is not
#: automatable at all. Adding a row is an authored decision -- the repair must
#: be locally sufficient, idempotent-or-refusing, and safe to run against the
#: SAME root/lineage/generation that preflight just classified.
_TICKET_ID_RE = re.compile(r"T-\d+")
_AUTOMATABLE_REPAIRS = ("recover", "ticket-compact")
# T-1324 Target G: which canonical document owns each blocked code, so a host
# does not have to reverse-engineer operations.py to find the surface.
_BLOCKING_SURFACE = {
    "WAIT_BLOCKED": "state",
    "RECONCILE_REAUTH_REQUIRED": "state",
    "REPAIR_REQUIRED": "state",
    "PROTOCOL_STATE_INVALID": "state",
    "PROTOCOL_MODE_READONLY": "state",
    "NO_ACTIVE_WORK": "board",
    "CORRUPT_JOURNAL": "journal",
    "RECOVERY_CONFLICT": "journal",
    "RECOVERY_REQUIRED": "journal",
    "RECOVERY_EVIDENCE_UNBOUND": "binding",
    "HISTORY_LEDGER_CORRUPT": "log",
    "BOARD_RECORD_OVERSIZE": "board",
    "BOARD_DETAIL_UNRESOLVABLE": "board",
    "PROJECT_BINDING_INVALID": "binding",
    "PROJECT_BINDING_AMBIGUOUS": "binding",
}
_SURFACE_EVIDENCE = {
    "state": ".saipen/STATE.md",
    "board": ".saipen/BOARD.md",
    "log": ".saipen/LOG.md",
    "journal": ".saipen/recovery",
}


def _bounded(value: object, limit: int = MAX_FACT_CHARS) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:limit] if value else None


def _condition_id(root: Path, lineage: str) -> str | None:
    """Hash the exact canonical generation for the per-session retry barrier."""
    digest = hashlib.sha256(lineage.encode("utf-8"))
    remaining = MAX_CONDITION_BYTES
    for name in ("IDENTITY.md", "STATE.md", "BOARD.md", "LOG.md"):
        path = root / ".saipen" / name
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size > remaining:
                return None
            remaining -= info.st_size
            digest.update(name.encode("ascii"))
            digest.update(info.st_size.to_bytes(8, "big"))
            with path.open("rb") as stream:
                while chunk := stream.read(65536):
                    digest.update(chunk)
        except (OSError, OverflowError):
            return None
    return digest.hexdigest()


def _continuation(root: Path, lineage: str, snapshot: dict) -> dict:
    """Regenerate a small work envelope from current files, never model prose."""
    state = snapshot.get("state") if isinstance(snapshot.get("state"), dict) else {}
    board = snapshot.get("board") if isinstance(snapshot.get("board"), dict) else {}
    ticket = state.get("task")
    tickets = board.get("tickets") if isinstance(board.get("tickets"), dict) else {}
    active = tickets.get(ticket) if isinstance(ticket, str) else None
    fields = active.get("fields", {}) if isinstance(active, dict) else {}
    return {
        "project_identity": project_identity(root),
        "project_lineage": lineage,
        "bound_root": str(root),
        "active_work": _bounded(ticket, 32),
        "phase": _bounded(state.get("phase"), 32),
        "acceptance_target": _bounded(fields.get("verify")),
        "relevant_paths": _bounded(fields.get("paths")),
        "bounded_todo": _bounded(active.get("description")) if isinstance(active, dict) else None,
        "known_blocking_finding": _bounded(state.get("blocker")),
        "canonical_next_action": _bounded(state.get("next_action")),
        "last_event": state.get("last_event") if isinstance(state.get("last_event"), int) else None,
    }


def _remediation(
    classification: str,
    reason_code: str,
    snapshot: dict | None = None,
    reconciliation: dict | None = None,
) -> dict:
    """T-1324 Target G: name the legal next move for every classification.

    A blocked result that carried only `classification` + `reason_code` was the
    machine-readable half of the recovery deadlock: a host could see that work
    was refused but not what it was allowed to do about it. These facts make the
    route explicit and testable, and the invariant is closed -- `CLASS_BLOCKED`
    ALWAYS offers an automatic repair or an operator decision, plus a canonical
    command, so no braked surface is a silent dead end.
    """
    code = str(reason_code or "")
    state = (snapshot or {}).get("state") if isinstance(snapshot, dict) else None
    state = state if isinstance(state, dict) else {}
    surface = _BLOCKING_SURFACE.get(code)
    field = None
    # Reconcile owns the detailed refusal. If it already emitted the shared
    # T-1324 remediation fields, preserve them instead of replacing a truthful
    # terminal diagnosis with the generic ``saipen recover`` loop.
    if classification == CLASS_BLOCKED and isinstance(reconciliation, dict) and all(
        key in reconciliation
        for key in (
            "needs_local_mutation",
            "safe_auto_repair_available",
            "operator_decision_available",
            "canonical_next_command",
            "read_only",
        )
    ):
        repairs = [
            item
            for key in ("refused", "blocked")
            for item in (reconciliation.get(key) or [])
            if isinstance(item, dict)
        ]
        repair_fields = {str(item.get("field")) for item in repairs if item.get("field")}
        repair_surfaces = {
            str(item.get("surface")) for item in repairs if item.get("surface")
        }
        field = next(iter(repair_fields)) if len(repair_fields) == 1 else None
        if len(repair_surfaces) == 1:
            surface = next(iter(repair_surfaces))
        result = {
            key: reconciliation.get(key)
            for key in (
                "needs_local_mutation",
                "safe_auto_repair_available",
                "operator_decision_available",
                "canonical_next_command",
                "read_only",
            )
        }
        result.update(
            {
                "blocking_surface": surface,
                "blocking_field": field,
                "evidence_reference": reconciliation.get("evidence_reference")
                or _SURFACE_EVIDENCE.get(surface or ""),
            }
        )
        if reconciliation.get("terminal_disposition"):
            result["terminal_disposition"] = reconciliation["terminal_disposition"]
        return result
    if surface == "state":
        blocker = state.get("blocker")
        phase = state.get("phase")
        if isinstance(blocker, str) and blocker.strip() and blocker.strip().lower() != "none":
            field = "blocker"
        elif not isinstance(phase, str) or not phase.strip():
            field = "phase"
        else:
            field = "task"
    blocked = classification in (CLASS_BLOCKED, CLASS_CONFLICT, CLASS_UNBOUND, CLASS_NON_SAIPEN)
    if classification == CLASS_SAFE:
        command = _RECOVER_COMMAND
        if reason_code == "BOARD_RECORD_OVERSIZE":
            tickets = ((snapshot or {}).get("board") or {}).get("tickets") or {}
            ticket_id = next(
                (
                    tid
                    for tid, ticket in tickets.items()
                    if len(str((ticket or {}).get("raw") or "")) > MAX_LIVE_RECORD_CHARS
                ),
                None,
            )
            command = f"{_BOARD_COMPACTION_COMMAND} {ticket_id or '<T-###>'}"
        return {
            "needs_local_mutation": True,
            "safe_auto_repair_available": True,
            "operator_decision_available": False,
            "canonical_next_command": command,
            "read_only": False,
            "blocking_surface": surface,
            "blocking_field": field,
            "evidence_reference": _SURFACE_EVIDENCE.get(surface or ""),
        }
    if classification == CLASS_BLOCKED:
        auto = code in _AUTO_RECOVERY_CODES
        command = _RECOVER_COMMAND
        if code == "RECONCILE_REAUTH_REQUIRED" and field == "blocker":
            # The blocker is a real gate: the only reachable verb is the
            # operator decision that records authority and clears the field it
            # owns, not a generic unblock.
            command = _BLOCKER_DECISION_COMMAND
        return {
            "needs_local_mutation": auto,
            "safe_auto_repair_available": auto,
            "operator_decision_available": (code in _OPERATOR_DECISION_CODES) or not auto,
            "canonical_next_command": command,
            "read_only": True,
            "blocking_surface": surface,
            "blocking_field": field,
            "evidence_reference": _SURFACE_EVIDENCE.get(surface or ""),
        }
    if classification == CLASS_VALID:
        return {
            "needs_local_mutation": False,
            "safe_auto_repair_available": False,
            "operator_decision_available": False,
            "canonical_next_command": "saipen continue",
            "read_only": False,
            "blocking_surface": None,
            "blocking_field": None,
            "evidence_reference": None,
        }
    return {
        "needs_local_mutation": False,
        "safe_auto_repair_available": False,
        "operator_decision_available": False,
        "canonical_next_command": None,
        "read_only": blocked,
        "blocking_surface": surface,
        "blocking_field": field,
        "evidence_reference": _SURFACE_EVIDENCE.get(surface or ""),
    }


def _diagnosis(remediation: dict, classification: str) -> dict:
    """Target I: no mutating probes from a braked state.

    When an ordinary consequential action is refused and no automatic repair
    exists, the ONLY sanctioned behavior is read-only diagnosis plus, at most,
    the one specific canonical/operator-decision command -- never speculative
    `stop`/`transition`/`goal`/`ticket`/Bash/Edit/Write probes to discover what
    happens to be admitted. The machine-readable token is fixed so a host can
    branch on it without prose parsing.
    """
    read_only = bool(remediation.get("read_only"))
    if classification in (CLASS_NON_SAIPEN, CLASS_VALID):
        return {"diagnosis": "NONE", "forbidden_probes": []}
    if remediation.get("safe_auto_repair_available"):
        command = remediation.get("canonical_next_command")
        return {
            "diagnosis": "RUN_CANONICAL_REPAIR",
            "forbidden_probes": [],
            "instruction": f"run `{command}`" if command else "run the canonical repair",
        }
    if not read_only:
        return {"diagnosis": "NONE", "forbidden_probes": []}
    command = remediation.get("canonical_next_command")
    instruction = "READ_ONLY_DIAGNOSIS_ONLY -- do not probe mutating verbs"
    if command:
        instruction += (
            f"; the only sanctioned mutation is the operator decision `{command}`"
        )
    elif remediation.get("terminal_disposition"):
        instruction += (
            f"; {remediation['terminal_disposition']} -- no local mutation can "
            "reconstruct the missing truth"
        )
    return {
        "diagnosis": "READ_ONLY_DIAGNOSIS_ONLY",
        "read_only_diagnosis_only": True,
        "instruction": instruction,
        "forbidden_probes": [
            "saipen stop",
            "saipen transition",
            "saipen goal",
            "saipen ticket",
            "Bash",
            "Edit",
            "Write",
        ],
    }


def _result(
    classification: str,
    *,
    root: Path | None = None,
    lineage: str | None = None,
    reason_code: str,
    reason: str,
    snapshot: dict | None = None,
    provenance: str | None = None,
    reconciliation: dict | None = None,
) -> dict:
    state = (snapshot or {}).get("state")
    state = state if isinstance(state, dict) else {}
    remediation = _remediation(classification, reason_code, snapshot, reconciliation)
    result = {
        "classification": classification,
        "root": str(root) if root is not None else None,
        "project_identity": project_identity(root) if root is not None else None,
        "project_lineage": lineage,
        "provenance": provenance,
        "phase": _bounded(state.get("phase"), 32),
        "task": _bounded(state.get("task"), 32),
        "canonical_actor": _bounded(state.get("agent"), 80),
        "recovery_eligible": classification == CLASS_SAFE,
        "mutation_required": classification == CLASS_SAFE,
        "reason_code": reason_code,
        "reason": _bounded(reason, 512) or reason_code,
        **remediation,
        **_diagnosis(remediation, classification),
    }
    if classification == CLASS_VALID and root is not None and lineage is not None:
        result["continuation"] = _continuation(root, lineage, snapshot or {})
    if classification == CLASS_SAFE:
        # T-1327 TARGET D: `condition_id` is part of the SAFE contract, not an
        # optional extra that one branch remembered to attach. `prepare` reads
        # it unconditionally for the one-attempt barrier, so a SAFE result
        # without it raised `KeyError` inside the CLI -- an empty stdout and a
        # traceback, which the OpenCode guard can only classify as
        # FLEET_OUTPUT_INVALID. Compute it HERE so every SAFE classification,
        # present and future, carries the generation it was diagnosed from.
        result["condition_id"] = (
            _condition_id(root, lineage) if root is not None and lineage is not None else None
        )
    return result


def preflight(
    start: Path | str | None = None,
    *,
    explicit_root: Path | str | None = None,
    host_root: Path | str | None = None,
    host_lineage: str | None = None,
    require_binding: bool = False,
    honor_environment: bool = True,
) -> dict:
    """Classify exactly one bounded context with zero writes."""
    start_path = Path(start).resolve() if start is not None else Path.cwd().resolve()
    if explicit_root is not None and host_root is not None:
        if Path(explicit_root).resolve() != Path(host_root).resolve():
            return _result(
                CLASS_CONFLICT,
                reason_code="PROJECT_BINDING_INVALID",
                reason="explicit root conflicts with asserted host root",
            )
    resolved = resolve_project_root(
        start_path,
        explicit=explicit_root,
        host_root=host_root,
        host_lineage=host_lineage,
        honor_environment=honor_environment,
    )
    if not resolved.ok:
        code = resolved.code or "NOT_SAIPEN_PROJECT"
        if code == "NOT_SAIPEN_PROJECT":
            classification = CLASS_UNBOUND if require_binding else CLASS_NON_SAIPEN
        else:
            classification = CLASS_CONFLICT
        return _result(classification, reason_code=code, reason=resolved.reason)

    root = Path(resolved.root).resolve()
    lineage = resolved.lineage
    if not lineage:
        return _result(
            CLASS_CONFLICT,
            root=root,
            reason_code="PROJECT_BINDING_INVALID",
            reason="bound project has no valid lineage",
            provenance=resolved.provenance,
        )
    snapshot = protocol_snapshot(root)
    if not isinstance(snapshot.get("state"), dict):
        # The strict parser refuses an out-of-enum phase. Its bounded
        # frontmatter still carries the actor whose work recovery must keep.
        raw_state = _read_text_bounded(root / ".saipen" / "STATE.md", MAX_STATE_BYTES)
        if raw_state is not None:
            lenient, error = parse_frontmatter(raw_state)
            if not error and isinstance(lenient, dict):
                snapshot["state"] = lenient
    pending, conflicts = scan_pending(root)
    if pending:
        corrupt = next((op for op in pending if op.get("corrupt")), None)
        code = (
            "CORRUPT_JOURNAL"
            if corrupt
            else "RECOVERY_CONFLICT"
            if conflicts
            else "RECOVERY_REQUIRED"
        )
        evidence = corrupt or (conflicts[0] if conflicts else pending[0])
        reason = evidence.get("detail", "pending journal")
        return _result(
            CLASS_BLOCKED,
            root=root,
            lineage=lineage,
            reason_code=code,
            reason=str(reason),
            snapshot=snapshot,
            provenance=resolved.provenance,
        )

    # T-1326: historical oversized rows remain readable but ordinary canonical
    # updates would otherwise re-render and deadlock on the new-record cap.
    # Expose the actual compact operation, not a generic recovery incantation.
    try:
        board_text = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        legacy_oversized = oversized_ticket_ids(board_text)
    except (OSError, UnicodeError, ValueError):
        legacy_oversized = []
    agent = _bounded((snapshot.get("state") or {}).get("agent"), 80) or "codex"
    if legacy_oversized:
        # T-1326 P1: a SAFE repair may only be advertised when Fleet ALREADY
        # knows its preconditions hold. An oversized row can also carry a
        # `detail_ref` whose authority (metadata, original bytes, predecessor
        # chain) is missing or corrupt; `saipen ticket compact` then refuses, and
        # because Fleet can execute exact named SAFE repairs automatically, the
        # advertised command became an impossible auto-repair. Broken detail
        # authority outranks the oversize routing: it is reported as a hard stop
        # with NO automatic compaction command.
        candidate_ids = list(
            dict.fromkeys(
                [
                    *oversized_ticket_ids(board_text),
                    *(
                        tid
                        for tid, ticket in (parse_board(board_text).get("tickets") or {}).items()
                        if str(((ticket or {}).get("fields") or {}).get("detail_ref") or "").strip()
                    ),
                ]
            )
        )
        try:
            broken_candidate = detail_integrity_error(root, board_text, candidate_ids)
        except (OSError, UnicodeError, ValueError) as exc:
            broken_candidate = str(exc)
        if broken_candidate:
            snapshot["board"] = parse_board(board_text)
            return _result(
                CLASS_BLOCKED,
                root=root,
                lineage=lineage,
                reason_code="BOARD_DETAIL_UNRESOLVABLE",
                reason=(
                    "oversized BOARD record has no reachable detail authority, so "
                    "canonical compaction cannot execute -- " + broken_candidate
                ),
                snapshot=snapshot,
                provenance=resolved.provenance,
            )
        # T-1327: ORDER MATTERS when a project carries two SAFE debts at once.
        # `saipen ticket compact` is an ORDINARY canonical mutation: it
        # revalidates STATE and refuses on a malformed one. Naming it while a
        # STATE repair is still outstanding recreates the exact deadlock this
        # work removes -- preflight names a repair, the repair refuses, and the
        # operator is back in the shell. `saipen recover` has no such
        # precondition (repairing STATE is its job), so it is named FIRST and
        # the compaction becomes the next generation's repair.
        prerequisite = reconcile_protocol_state(root, agent, dry_run=True)
        if prerequisite.get("ok") and prerequisite.get("code") == "REPAIR_REQUIRED":
            staged = _result(
                CLASS_SAFE,
                root=root,
                lineage=lineage,
                reason_code="REPAIR_REQUIRED",
                reason=(
                    "canonical STATE repair must precede BOARD compaction: "
                    + str(prerequisite.get("detail", "canonical repair plan"))
                ),
                snapshot=snapshot,
                provenance=resolved.provenance,
            )
            if staged.get("condition_id") is not None:
                return staged
        # A board that carries a REFUSED FIELD on the oversized row is exactly
        # the case `protocol_snapshot` refuses, so it never populated `board`;
        # hand the parsed rows to remediation so the named command carries the
        # REAL ticket id instead of the `<T-###>` placeholder -- otherwise the
        # canonical repair exists but no operator can name it (deadlock).
        snapshot["board"] = parse_board(board_text)
        oversize = _result(
            CLASS_SAFE,
            root=root,
            lineage=lineage,
            reason_code="BOARD_RECORD_OVERSIZE",
            reason=(
                "legacy oversized BOARD record(s) require lossless canonical compaction: "
                + ", ".join(legacy_oversized[:8])
            ),
            snapshot=snapshot,
            provenance=resolved.provenance,
        )
        if oversize.get("condition_id") is None:
            return _result(
                CLASS_BLOCKED,
                root=root,
                lineage=lineage,
                reason_code="RECOVERY_EVIDENCE_UNBOUND",
                reason="canonical generation cannot be bounded for automatic recovery",
                snapshot=snapshot,
                provenance=resolved.provenance,
            )
        return oversize

    # T-1326 TARGET C: a compacted row whose externalized original record or
    # metadata is missing/tampered is an ORPHAN authority edge. The operator
    # must see the exact integrity fault here, in read-only diagnosis, instead
    # of discovering it only by guessing `saipen ticket compact`. No local
    # mutation can reconstruct the missing historical bytes.
    try:
        broken_detail = detail_integrity_error(
            root, board_text, compacted_ticket_ids(board_text)
        )
    except (OSError, UnicodeError, ValueError) as exc:
        broken_detail = str(exc)
    if broken_detail:
        return _result(
            CLASS_BLOCKED,
            root=root,
            lineage=lineage,
            reason_code="BOARD_DETAIL_UNRESOLVABLE",
            reason="compacted BOARD record has no reachable detail authority -- " + broken_detail,
            snapshot=snapshot,
            provenance=resolved.provenance,
        )

    preview = reconcile_protocol_state(root, agent, dry_run=True)
    if preview.get("ok") and preview.get("code") == "REPAIR_REQUIRED":
        safe = _result(
            CLASS_SAFE,
            root=root,
            lineage=lineage,
            reason_code="REPAIR_REQUIRED",
            reason=str(preview.get("detail", "canonical repair plan")),
            snapshot=snapshot,
            provenance=resolved.provenance,
        )
        if safe.get("condition_id") is None:
            return _result(
                CLASS_BLOCKED,
                root=root,
                lineage=lineage,
                reason_code="RECOVERY_EVIDENCE_UNBOUND",
                reason="canonical generation cannot be bounded for automatic recovery",
                snapshot=snapshot,
                provenance=resolved.provenance,
            )
        return safe
    if preview.get("ok") and preview.get("code") in ("CLEAN", "WARN"):
        block = snapshot.get("block")
        if block in (None, "NO_ACTIVE_WORK", "WAIT_BLOCKED", "PROTOCOL_MODE_READONLY"):
            return _result(
                CLASS_VALID,
                root=root,
                lineage=lineage,
                reason_code="CLEAN",
                reason="canonical protocol state is valid",
                snapshot=snapshot,
                provenance=resolved.provenance,
            )
    # T-1326 TARGET C: a MALFORMED board must never be reported as `CLEAN`.
    # The reconcile preview can carry a VALID code (`CLEAN`/`WARN`) while the
    # structural snapshot is blocked (for example `PROTOCOL_STATE_INVALID` from
    # an ambiguous duplicate field), so a blocked result must take its code from
    # the structural snapshot, never from a validity verdict the snapshot has
    # already refused. Reporting `reason_code=CLEAN` for a malformed board was
    # the exact false-truth this target removes. The detailed reconcile plan is
    # still forwarded so its exact canonical command (for example
    # `saipen recover --adopt-legacy T-777`) is the one the operator sees.
    final_code = str(preview.get("code") or "")
    if final_code in ("", "CLEAN", "WARN"):
        final_code = str(snapshot.get("block") or "VALIDATION_FAILED")
    return _result(
        CLASS_BLOCKED,
        root=root,
        lineage=lineage,
        reason_code=final_code,
        reason=str(
            preview.get("detail")
            or snapshot.get("detail")
            or "canonical recovery cannot prove a safe repair"
        ),
        snapshot=snapshot,
        provenance=resolved.provenance,
        reconciliation=preview,
    )


def scan(roots: list[Path | str]) -> dict:
    """Inspect only the operator-supplied root set. Never enumerate children."""
    if not roots or len(roots) > MAX_SCAN_ROOTS:
        return {
            "ok": False,
            "code": "VALIDATION_FAILED",
            "detail": f"supply 1..{MAX_SCAN_ROOTS} explicit roots",
        }
    projects = []
    for supplied in roots:
        candidate = Path(supplied).expanduser()
        if not candidate.is_absolute():
            return {
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "fleet scan roots must be absolute",
            }
        checkpoint = candidate / ".saipen"
        asserted = checkpoint.exists() or checkpoint.is_symlink()
        item = preflight(
            candidate,
            explicit_root=candidate if asserted else None,
            honor_environment=False,
        )
        if item["root"] is not None and Path(item["root"]).resolve() != candidate.resolve():
            item = _result(
                CLASS_CONFLICT,
                reason_code="PROJECT_BINDING_INVALID",
                reason="supplied fleet root resolves to a different owning project root",
            )
        item["inspected_root"] = str(candidate)
        projects.append(item)
    return {"ok": True, "code": "FLEET_SCAN", "read_only": True, "projects": projects}


def plan_repair(canonical_next_command: object) -> dict | None:
    """Parse ONE allowlisted canonical repair into an exact structured argv.

    T-1327 TARGET A. Preflight names the exact safe repair; Fleet must be able
    to RUN it, or the protocol has only moved the operator's shell work one
    sentence later. The hard constraint is that the named string is DATA: it is
    tokenised and matched against a closed grammar, never interpolated into a
    shell command and never forwarded as "whatever canonical_next_command
    says". An unrecognised command has no plan, and no plan means no execution.
    """
    tokens = str(canonical_next_command or "").split()
    if len(tokens) < 2 or tokens[0] != "saipen":
        return None
    verb, rest = tokens[1], tokens[2:]
    if verb == "recover" and not rest:
        return {"operation": "recover", "argv": ["recover"], "ticket": None}
    if (
        verb == "ticket"
        and len(rest) == 2
        and rest[0] == "compact"
        and _TICKET_ID_RE.fullmatch(rest[1])
    ):
        # Exact verb, exact subcommand, exactly one canonical ticket id. The
        # `<T-###>` placeholder preflight emits when it cannot name a real row
        # fails this match on purpose: an unnameable repair is not automatable.
        return {
            "operation": "ticket-compact",
            "argv": ["ticket", "compact", rest[1]],
            "ticket": rest[1],
        }
    return None


def _invoke_canonical_repair(
    root: Path, lineage: str, actor: str | None, plan: dict | None = None
) -> dict:
    """Run ONE public canonical operation; never write reconciliation bytes here."""
    argv = list((plan or {}).get("argv") or ["recover"])
    # Defence in depth: the ONLY argv this process will ever hand the canonical
    # CLI is one the closed grammar can re-derive from its own rendering. A
    # caller-built plan cannot smuggle a third operation past `plan_repair`.
    if plan is not None and plan_repair("saipen " + " ".join(argv)) != plan:
        return {
            "ok": False,
            "code": "RECOVERY_NOT_AUTOMATABLE",
            "detail": "repair plan is outside the closed canonical grammar",
        }
    cli = Path(__file__).resolve().parent.parent / "saipen.py"
    env = os.environ.copy()
    env[ENV_PROJECT_ROOT] = str(root)
    env[ENV_PROJECT_LINEAGE] = lineage
    env.pop(ENV_AGENT, None)
    command = [sys.executable, str(cli), *argv, "--project-root", str(root), "--json"]
    if actor:
        command.extend(["--agent", actor])
    try:
        process = subprocess.run(
            command,
            cwd=str(root),
            env=env,
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        payload = json.loads(process.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        return {"ok": False, "code": "RECOVERY_FAILED", "detail": str(exc)}
    if not isinstance(payload, dict):
        return {
            "ok": False,
            "code": "RECOVERY_FAILED",
            "detail": "canonical recovery output is not a record",
        }
    return payload


#: Retained name for callers that still import the recovery-only entry point.
_invoke_canonical_recovery = _invoke_canonical_repair


def prepare(
    start: Path | str | None = None,
    *,
    explicit_root: Path | str | None = None,
    host_root: Path | str | None = None,
    host_lineage: str | None = None,
    require_binding: bool = False,
    honor_environment: bool = True,
    recover: Callable[..., dict] | None = None,
    attempted_condition: str | None = None,
) -> dict:
    """One preflight, at most one exact canonical repair, then fresh preflight.

    T-1327 TARGET A/B. The repair executed is the EXACT one preflight named --
    `saipen recover` or `saipen ticket compact T-###` -- dispatched structurally
    through `plan_repair`, never as a shell string and never as a generic "run
    whatever is canonical". Anything outside that closed grammar fails closed.

    A repaired result *never* authorizes replay of the caller's old payload.
    The host must refuse that invocation and require a newly issued action.
    One prepare call performs at most ONE repair: if the project converges to
    another SAFE generation the result is a bounded reissue carrying the FRESH
    canonical state, so the next tool action can repair the next brick without
    this call ever looping.
    """
    kwargs = dict(
        explicit_root=explicit_root,
        host_root=host_root,
        host_lineage=host_lineage,
        require_binding=require_binding,
        honor_environment=honor_environment,
    )
    before = preflight(start, **kwargs)
    classification = before["classification"]
    if classification != CLASS_SAFE:
        return {
            **before,
            "ok": classification in (CLASS_VALID, CLASS_NON_SAIPEN),
            "code": classification,
            "recovered": False,
            "recovery_attempts": 0,
            "requires_reissue": False,
        }
    if attempted_condition is not None and attempted_condition == before.get("condition_id"):
        # T-1354. The automatic route is EXHAUSTED, not pending. This
        # generation already had its one attempt and did not move, so asking
        # for a reissue "against current bytes" points at the same bytes and
        # the next action lands here again -- the very cycle this branch exists
        # to stop, expressed as an instruction to repeat it. Measured live: a
        # user project answered RECOVERY_FAILED with requires_reissue true on
        # every call once the host started carrying the attempted condition,
        # so every consequential tool in that session was refused forever.
        #
        # `requires_reissue` means THE BYTES MOVED. They did not. The condition
        # and its canonical next command still travel, so the gate can decide
        # what is still safe and a human can see the route.
        return {
            **before,
            "ok": False,
            "code": "RECOVERY_EXHAUSTED",
            "recovered": False,
            "recovery_attempts": 0,
            "requires_reissue": False,
            "reason": (
                "unchanged canonical generation already received one automatic "
                "recovery attempt; the automatic route is exhausted and the "
                "named canonical command is the remaining route"
            ),
        }
    plan = plan_repair(before.get("canonical_next_command"))
    if plan is None or not before.get("safe_auto_repair_available"):
        # TARGET A closed-set invariant: an unrecognised canonical command is
        # never executed, never approximated by `saipen recover`, and never
        # allowed to authorize the caller's payload. `requires_reissue` stays
        # false because nothing was repaired -- this is a blocked SAFE state,
        # and the host refuses the tool on the ordinary fail-closed branch.
        return {
            **before,
            "ok": False,
            "code": "RECOVERY_NOT_AUTOMATABLE",
            "recovered": False,
            "recovery_attempts": 0,
            "requires_reissue": False,
            "automatable_operations": list(_AUTOMATABLE_REPAIRS),
            "reason": (
                "canonical_next_command is outside the closed automatic repair set: "
                + str(before.get("canonical_next_command"))
            ),
        }
    root = Path(before["root"])
    lineage = str(before["project_lineage"])
    # Recheck the asserted binding immediately before dispatch. The canonical
    # subprocess also revalidates the lineage under its own root resolver, and
    # the named repair must still be the SAME operation against the SAME
    # generation -- a board that changed between diagnosis and dispatch makes
    # the planned ticket id stale evidence, not a target.
    checked = preflight(start, **kwargs)
    if (
        checked["classification"] != CLASS_SAFE
        or checked["root"] != str(root)
        or checked["project_lineage"] != lineage
        or checked.get("condition_id") != before.get("condition_id")
        or plan_repair(checked.get("canonical_next_command")) != plan
    ):
        return {
            **checked,
            "ok": False,
            "code": "RECOVERY_FAILED",
            "recovered": False,
            "recovery_attempts": 0,
            "requires_reissue": True,
            "attempted_condition": before.get("condition_id"),
            "reason": "binding or recovery evidence changed before canonical recovery",
        }
    operation = (recover or _invoke_canonical_repair)(
        root, lineage, before.get("canonical_actor"), plan
    )
    after = preflight(start, **kwargs)
    repair_evidence = {
        "operation": plan["operation"],
        "ticket": plan["ticket"],
        "code": operation.get("code"),
        "event": operation.get("event"),
    }
    if not operation.get("ok"):
        # T-1354: `requires_reissue` means THE BYTES MOVED, so the payload you
        # were holding is stale. A repair that refused and changed nothing has
        # moved nothing, and telling the model to "reissue against current
        # bytes" sends it back to the SAME bytes -- the next action hits the
        # identical wall, forever. The unbounded loop this file already refuses
        # to run INSIDE one call (below) simply moved across calls, and it was
        # measured on three separate real projects at once: a BOARD record is
        # oversized, the canonical repair is `saipen ticket compact T-###`, and
        # it refuses because OTHER records on the same board predate the
        # allocation contract. The route is named, reachable and impossible.
        #
        # The honest answer is that the AUTOMATIC route is exhausted. The
        # condition and its canonical next command still travel, so a human --
        # or the gate deciding what is still safe -- has everything it needs.
        # T-1354: exhaustion is keyed on the REPAIR, not on a condition hash.
        #
        # `attempted_condition` was meant to stop the loop, but a failed repair
        # perturbs the generation it is keyed on -- recovery evidence, journal
        # churn -- so the key never matches twice and the cycle
        # `prepare -> SAFE repair -> validation refusal -> prepare -> same
        # repair` runs forever. Measured live on two user projects: every
        # consequential tool refused, on every call, with "reissue against
        # current bytes".
        #
        # If the SAME named repair is still what the state asks for, the
        # automatic route has been tried and did not work. Reissuing cannot
        # change that, so the loop ends here and the named command travels on
        # for the operator.
        after_plan = plan_repair(after.get("canonical_next_command"))
        same_repair = (
            after_plan is not None
            and after_plan.get("operation") == plan.get("operation")
            and after_plan.get("ticket") == plan.get("ticket")
        )
        return {
            **after,
            "ok": False,
            "code": "RECOVERY_EXHAUSTED" if same_repair else "RECOVERY_FAILED",
            "recovered": False,
            "recovery_attempts": 1,
            # A FAILED repair never earns a reissue, whatever it perturbed on
            # the way down. `requires_reissue` promises the caller that
            # rereading and reissuing will meet a changed, better state; a
            # repair that refused promises nothing of the sort. Keying this on
            # a delta let boards with several oversized records loop forever:
            # each call picked a DIFFERENT record, failed the same way, and
            # moved both the condition and the named command, so no key ever
            # matched twice. Measured on two user projects.
            "requires_reissue": False,
            "attempted_condition": before.get("condition_id"),
            "recovery_result": {**repair_evidence, "detail": operation.get("detail")},
            "reason": (
                "the named canonical repair failed and the state still asks for the "
                "same repair: the automatic route is exhausted"
                if same_repair
                else "canonical repair failed"
            ),
        }
    if after["classification"] == CLASS_SAFE:
        if after.get("condition_id") == before.get("condition_id"):
            # The operation reported success but the generation did not move.
            # Running it again inside this call is exactly the unbounded loop
            # TARGET B forbids.
            return {
                **after,
                "ok": False,
                # T-1354: one vocabulary for "the automatic route ran and the
                # state still asks for the same thing". Nothing moved, so
                # nothing can be reissued against.
                "code": "RECOVERY_EXHAUSTED",
                "recovered": False,
                "recovery_attempts": 1,
                "requires_reissue": False,
                "attempted_condition": before.get("condition_id"),
                "recovery_result": repair_evidence,
                "reason": (
                    "canonical repair reported success but the canonical generation "
                    "did not change; the automatic route is exhausted"
                ),
            }
        # Converged one brick. The FRESH canonical state travels with the
        # reissue so the next newly issued action repairs the next generation,
        # one attempt at a time, with no operator shell in between.
        return {
            **after,
            "ok": True,
            "code": "RECOVERED_REISSUE_REQUIRED",
            "recovered": True,
            "recovery_attempts": 1,
            "requires_reissue": True,
            "attempted_condition": before.get("condition_id"),
            "recovery_result": repair_evidence,
            "remaining_safe_condition": after.get("condition_id"),
        }
    if after["classification"] != CLASS_VALID:
        return {
            **after,
            "ok": False,
            "code": "RECOVERY_FAILED",
            "recovered": False,
            "recovery_attempts": 1,
            # T-1354: only stale when the generation actually moved.
            "requires_reissue": after.get("condition_id") != before.get("condition_id"),
            "attempted_condition": before.get("condition_id"),
            "recovery_result": repair_evidence,
            "reason": "current state did not become BOUND_VALID after the canonical repair",
        }
    return {
        **after,
        "ok": True,
        "code": "RECOVERED_REISSUE_REQUIRED",
        "recovered": True,
        "recovery_attempts": 1,
        "requires_reissue": True,
        "attempted_condition": before.get("condition_id"),
        "recovery_result": repair_evidence,
    }
