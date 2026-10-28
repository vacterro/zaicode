"""Mechanical support for SAIPEN focus/build/cut/undo controls.

Semantic interpretation stays at the agent layer.  This module owns only the
deterministic boundary: read-only projections, foreground Work intake,
content-bound cut proposals, sparse restore milestones, integrity checks and
journaled exact-byte restoration.

Core Checkpoints (LOG/BOARD/STATE) and Restore Milestones are deliberately
different concepts.  Nothing here introduces a phase or changes the Core DFA.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from .board import escape_ticket_description, parse_board
from . import attempt as attempt_mod
from .codec import redact_credentials
from .fast_check import validate_project, validate_texts
from .journal import (
    MISSING_FILE_DEPENDENCY,
    Journal,
    _target_live_hash,
    decode_operation_record,
    hash_bytes,
    owned_target_path,
    pending_ops,
    run_mutation,
)
from .lock import project_writer_lock
from .log import read_history_events
from .operations import (
    _claim_move,
    _docs_preconditions,
    _event_line,
    _actor_provenance,
    _identity,
    _insert_todo,
    _log_targets,
    _now,
    _read,
    _render_plan,
    _target,
    _utc_iso,
    next_ticket_id,
    release_scope_matches,
)
from .plan import OperationPlan, TargetPlan, apply_plan, build_plan, semantic_payload_hash
from .paths import (
    project_lineage_identity,
    prove_owned_regular,
    read_bound_regular_bytes,
    update_digest_regular_bytes,
)
from .result import Result
from .snapshot import ProjectSnapshot, canonical_identity
from .state import parse_state, patch_state

MILESTONE_DIR = ".saipen/milestones"
BLOB_ATTRIBUTES = b"* binary\n"
MANIFEST_SCHEMA = 2
POINTER_SCHEMA = 1
MAX_DIRECTIVE = 2000
MAX_REASON = 240
_CP_RE = re.compile(r"^CP-(\d+)$")
_TICKET_RE = re.compile(r"^T-[1-9]\d*$")
_ATTEMPT_RE = re.compile(r"^A-\d{3,}$")
_PUBLISHED_RELEASE_RE = re.compile(
    r"^ship v\S+ -> content commit [0-9a-f]{12,64} pushed$"
)


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _short_hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()[:16]


def _refuse(code: str, message: str, **data: Any) -> Result:
    return Result(ok=False, code=code, message=message, data=data)


def _safe_text(value: str, *, label: str, limit: int = MAX_DIRECTIVE) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be text")
    safe = redact_credentials(value).strip()
    if not safe:
        raise ValueError(f"{label} is required")
    if "\x00" in safe:
        raise ValueError(f"{label} contains NUL")
    if len(safe) > limit:
        raise ValueError(f"{label} exceeds {limit} characters")
    return safe


def _attempt_handover_error(docs: dict[str, Any], state: dict[str, Any], agent: str) -> str | None:
    pointer = state.get("attempt")
    if not pointer:
        return None
    records, errors = attempt_mod.build_attempts(docs["_history"].events)
    if errors:
        return "Attempt history is malformed: " + "; ".join(errors[:3])
    record = records.get(pointer)
    if not record or record.get("close_event") is not None:
        return f"STATE attempt {pointer} is not one open Attempt"
    owner = record.get("agent")
    if owner != agent:
        return f"attempt {pointer} belongs to {owner}; close/recover it before control handover"
    return None


def _git_revision(root: Path) -> str:
    try:
        proc = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout.strip() if proc.returncode == 0 else ""


def _is_link_or_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return True
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _source_binding(root: Path) -> dict[str, str]:
    snap = ProjectSnapshot.capture(root)
    return {
        "project_identity": snap.project_identity,
        "state_hash": snap.state_hash,
        "board_hash": snap.board_hash,
        "log_hash": snap.log_hash,
        "source_revision": _git_revision(root),
        "source_fingerprint": _project_tree_fingerprint(root),
    }


def _project_tree_fingerprint(root: Path) -> str:
    """Portable non-Git fallback and exact dirty-tree cut binding.

    Cut preview is uncommon and safety-sensitive, so one bounded source walk
    is justified. Canonical `.saipen` memory and Git internals are bound by
    their own fields/excluded; generated dependency forests are skipped.
    """
    digest = hashlib.sha256()
    excluded = {".git", ".saipen", "__pycache__", ".venv", "node_modules"}
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(
            d for d in dirs if d not in excluded and not _is_link_or_reparse(Path(base) / d)
        )
        for name in sorted(files):
            path = Path(base) / name
            if _is_link_or_reparse(path):
                rel = path.relative_to(root).as_posix().encode("utf-8")
                digest.update(b"LINK\0" + len(rel).to_bytes(8, "big") + rel)
                continue
            try:
                rel = path.relative_to(root).as_posix().encode("utf-8")
                witnessed = prove_owned_regular(path, kind="focus source file")
            except (OSError, ValueError):
                digest.update(b"UNREADABLE\0" + str(path).encode("utf-8", "surrogatepass"))
                continue
            digest.update(len(rel).to_bytes(8, "big"))
            digest.update(rel)
            digest.update(witnessed.st_size.to_bytes(8, "big"))
            try:
                update_digest_regular_bytes(path, witnessed, digest)
            except (OSError, ValueError):
                # A mid-read pivot is fail-closed and remains visibly distinct
                # from any stable source-tree fingerprint.
                digest.update(b"\0UNSTABLE\0")
    return "tree-sha256:" + digest.hexdigest()


def _binding_digest(kind: str, expression: str, binding: dict[str, str]) -> str:
    payload = {"kind": kind, "expression": expression, "binding": binding}
    return hashlib.sha256(_json_bytes(payload)).hexdigest()[:12].upper()


def _read_text_lossy(path: Path, limit: int = 256_000) -> str:
    try:
        witnessed = prove_owned_regular(path, kind="focus text")
        raw = read_bound_regular_bytes(path, witnessed, max_bytes=limit)
    except (OSError, ValueError):
        return ""
    if b"\x00" in raw:
        return ""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return ""


def focus_projection(project_root: Path | str, expression: str = "") -> Result:
    """Return bounded evidence for an agent-authored Focus Brief.

    This function is intentionally read-only and intentionally does not decide
    what a fuzzy noun means.  Exact signals are evidence; semantic resolution
    and inference remain the agent's job per OPS.md.
    """
    root = Path(project_root).resolve()
    snap = ProjectSnapshot.capture(root)
    state = parse_state(snap.state_text)
    board = parse_board(snap.board_text)
    query = (expression or "").strip()
    if not query:
        query = str(state.get("task") or "")
        if query in ("", "none"):
            doing = [t["id"] for t in board["tickets"].values() if t["section"] == "## DOING"]
            query = doing[0] if doing else str(state.get("next_action") or "project frontier")

    needles = [
        part.casefold() for part in re.findall(r"[\w.-]+", query, re.UNICODE) if len(part) > 1
    ]
    matches: list[dict[str, Any]] = []
    excluded = {".git", ".saipen", "__pycache__", ".venv", "node_modules"}
    scanned = 0
    for base, dirs, files in os.walk(root):
        dirs[:] = [
            d for d in dirs if d not in excluded and not _is_link_or_reparse(Path(base) / d)
        ]
        for name in files:
            if scanned >= 1200 or len(matches) >= 40:
                break
            scanned += 1
            path = Path(base) / name
            if _is_link_or_reparse(path):
                continue
            rel = path.relative_to(root).as_posix()
            name_hit = any(n in rel.casefold() for n in needles)
            text = "" if name_hit else _read_text_lossy(path)
            line_hits = []
            if text and needles:
                for number, line in enumerate(text.splitlines(), 1):
                    if any(n in line.casefold() for n in needles):
                        line_hits.append({"line": number, "text": line.strip()[:240]})
                        if len(line_hits) == 3:
                            break
            if name_hit or line_hits:
                matches.append({"path": rel, "name_match": name_hit, "lines": line_hits})
        if scanned >= 1200 or len(matches) >= 40:
            break

    tickets = []
    for ticket in board["tickets"].values():
        raw = ticket.get("raw", "")
        if not needles or any(n in raw.casefold() for n in needles):
            tickets.append({"id": ticket["id"], "section": ticket["section"], "text": raw[:500]})
            if len(tickets) == 12:
                break
    return Result(
        ok=True,
        code="FOCUS_CONTEXT",
        data={
            "read_only": True,
            "expression": expression,
            "resolved_seed": query,
            "phase": state.get("phase"),
            "task": state.get("task"),
            "next_action": state.get("next_action"),
            "exact_matches": matches,
            "board_matches": tickets,
            "search_bounded": scanned >= 1200 or len(matches) >= 40,
            "agent_contract": {
                "semantic_resolution": "required",
                "evidence_inference_separation": "required",
                "canonical_writes": 0,
                "brief_owner": "saipen/CONTROLS.md",
            },
        },
    )


def _plan_directive(
    root: Path,
    agent: str,
    directive: str,
    *,
    kind: str,
    evidence_id: str | None = None,
) -> OperationPlan | Result:
    try:
        safe = _safe_text(directive, label=f"{kind} directive")
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    docs, state, board, log_tail = _read(root)
    if attempt_error := _attempt_handover_error(docs, state, agent):
        return _refuse("VALIDATION_FAILED", attempt_error)
    if board["errors"]:
        return _refuse("VALIDATION_FAILED", "; ".join(board["errors"][:3]))
    active = next((t for t in board["tickets"].values() if t["section"] == "## DOING"), None)
    if active and state.get("task") not in (active["id"], None, "none"):
        return _refuse(
            "ACTIVE_TICKET_MISMATCH",
            f"STATE.task={state.get('task')} but BOARD.DOING={active['id']}",
        )

    board_text = docs["board"].text_norm
    # The Core DFA has no BUILD/VERIFY/REVIEW -> SCOUT edge.  Preserve it:
    # an in-flight Work remains the one DOING item and the explicit directive
    # becomes the top foreground TODO.  It is claimed immediately at the next
    # legal DONE -> SCOUT boundary.  Manufacturing a fake BLOCKED/DONE hop to
    # make "preemption" look immediate would corrupt Work truth.
    queued_behind = active["id"] if active else None

    tid_num = next_ticket_id(
        board_text,
        docs["_history"].text,
        history_max_ticket_id=getattr(docs["_history"], "max_ticket_id", None),
    )
    ticket = f"T-{tid_num}"
    description = escape_ticket_description(
        f"{kind.upper()} user directive: {safe}" + (f" [{evidence_id}]" if evidence_id else "")
    )
    verify = escape_ticket_description(
        "agent FIT/impact pass recorded; normal SCOUT, BUILD, VERIFY, REVIEW "
        "and SHIP/DONE gates pass"
    )
    line = f"- [ ] {ticket} [P0] {description} | verify: {verify}"
    board_text = _insert_todo(board_text, line)
    if active is None:
        board_text = _claim_move(board_text, ticket, agent, _utc_iso())

    op_id = (
        f"{kind}-intake-"
        + hashlib.sha256(
            (safe + "\0" + docs["state"].raw_hash + "\0" + docs["board"].raw_hash).encode("utf-8")
        ).hexdigest()[:16]
    )
    message = f"{kind} directive accepted -- {safe}"
    if queued_behind:
        message += f"; queued at next legal boundary behind active {queued_behind}"
    event, event_line = _event_line(
        docs,
        log_tail,
        "DEC",
        ticket,
        agent,
        _actor_provenance(state, agent, message),
        _now(),
        op_id,
    )
    log_text = docs["log"].text_norm.rstrip("\n") + "\n" + event_line + "\n"
    owned = {"last_event": event, "updated": _utc_iso(), "agent": agent}
    attempt_id = None
    if active is None:
        records, attempt_errors = attempt_mod.build_attempts(docs["_history"].events)
        if attempt_errors:
            return _refuse(
                "VALIDATION_FAILED",
                "LOG carries malformed Attempt history: " + "; ".join(attempt_errors[:3]),
            )
        open_attempts = attempt_mod.active_attempts(records)
        if open_attempts:
            return _refuse(
                "VALIDATION_FAILED",
                f"attempt {open_attempts[0]} is still open; recover or close it "
                "before directive intake",
            )
        attempt_id = attempt_mod.next_attempt_id(docs["_history"].events)
        attempt_event, attempt_line = _event_line(
            docs,
            event,
            "DEC",
            ticket,
            agent,
            f"attempt {attempt_id} open",
            _now(),
            op_id,
        )
        log_text += attempt_line + "\n"
        owned.update(
            {
                "phase": "SCOUT",
                "task": ticket,
                "attempt": attempt_id,
                "next_action": f"PHASE SCOUT {ticket}",
                "transition_from": state.get("phase") or "DONE",
                "last_event": attempt_event,
            }
        )
    state_text = patch_state(docs["state"].text_norm, owned)
    errors = validate_texts(
        state_text, board_text, log_text, current_agent=agent, sealed_events=docs["_history"]
    )
    if errors:
        return _refuse("VALIDATION_FAILED", "; ".join(errors[:5]))
    targets = [
        *_log_targets(docs, log_text),
        _target(docs["board"], ".saipen/BOARD.md", "board", board_text),
        _target(docs["state"], ".saipen/STATE.md", "state", state_text),
    ]
    return build_plan(
        f"{kind}_intake",
        agent,
        _identity(root),
        {"operation": f"{kind}_intake", "directive": safe, "evidence_id": evidence_id},
        _docs_preconditions(docs, "state", "board", "log"),
        targets,
        {
            "ok": True,
            "code": (
                "BUILD_WORK_QUEUED"
                if kind == "build" and active
                else "CUT_WORK_QUEUED"
                if kind != "build" and active
                else "BUILD_WORK_STARTED"
                if kind == "build"
                else "CUT_WORK_STARTED"
            ),
            "ticket": ticket,
            "queued_behind": queued_behind,
            "directive": safe,
            "execution_intent": state.get("execution_intent", "normal"),
            "phase": state.get("phase") if active else "SCOUT",
            "event_id": f"E-{event}",
            "attempt": attempt_id,
        },
        op_id=op_id,
    )


def directive_entry(
    project_root: Path | str,
    agent: str,
    directive: str,
    *,
    kind: str = "build",
    evidence_id: str | None = None,
    dry_run: bool = False,
) -> Result:
    """Create bounded foreground Work while preserving the broader intent."""
    if kind not in {"build", "cut", "undo"}:
        return _refuse("VALIDATION_FAILED", f"unknown directive kind {kind!r}")
    root = Path(project_root)
    try:
        parse_state(ProjectSnapshot.capture(root).state_text)
    except Exception as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    plan = _plan_directive(root, agent, directive, kind=kind, evidence_id=evidence_id)
    if isinstance(plan, Result):
        return plan
    return _render_plan(plan) if dry_run else apply_plan(root, plan)


def _normalized_cut_plan(root: Path, target: str, plan: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(plan, dict):
        raise ValueError("cut impact plan must be an object")
    safe_target = _safe_text(target, label="cut target")
    if not isinstance(plan.get("resolved_target"), str):
        raise ValueError("resolved cut target must be text")
    resolved = _safe_text(plan["resolved_target"], label="resolved cut target")
    affected = plan.get("affected_paths")
    if not isinstance(affected, list):
        raise ValueError("cut impact plan needs affected_paths")
    scope = _canonical_scope(root, affected)
    normalized = {
        key: value for key, value in plan.items() if key not in {"binding", "plan_hash"}
    }
    normalized["target_expression"] = safe_target
    normalized["resolved_target"] = resolved
    normalized["affected_paths"] = scope
    for field in ("remove", "preserve"):
        values = normalized.get(field)
        if not isinstance(values, list) or not values or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            raise ValueError(f"cut impact plan needs non-empty {field} list")
    if not isinstance(normalized.get("risk"), str):
        raise ValueError("cut risk must be text")
    normalized["risk"] = _safe_text(normalized["risk"], label="cut risk", limit=1000)
    try:
        encoded = _json_bytes(normalized)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"cut impact plan is not canonical JSON: {exc}") from exc
    if len(encoded) > 48_000:
        raise ValueError("cut impact plan exceeds 48000 bytes")
    return normalized


def cut_preview(
    project_root: Path | str,
    target: str,
    resolved_plan: dict[str, Any] | None = None,
) -> Result:
    """Bind a zero-write resolved cut proposal to the current project snapshot."""
    try:
        safe = _safe_text(target, label="cut target")
    except ValueError as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    root = Path(project_root).resolve()
    binding = _source_binding(root)
    if resolved_plan is None:
        return Result(
            ok=True,
            code="CUT_ANALYSIS_REQUIRED",
            data={
                "read_only": True,
                "target_expression": safe,
                "binding": binding,
                "agent_analysis_required": [
                    "resolved_target",
                    "affected_paths",
                    "entry_points",
                    "callers",
                    "dependencies_and_dependents",
                    "state_schema_ui_fallback",
                    "tests_docs_translations_dead_code",
                    "migration_performance_risk",
                    "preserve",
                ],
                "canonical_writes": 0,
            },
        )
    try:
        normalized = _normalized_cut_plan(root, safe, resolved_plan)
    except (ValueError, OSError) as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    plan_hash = _sha256(_json_bytes(normalized))
    authenticated = {**binding, "plan_hash": plan_hash}
    cut_id = "CUT-" + _binding_digest("cut", safe, authenticated)
    return Result(
        ok=True,
        code="CUT_PREVIEW",
        data={
            "read_only": True,
            "cut_id": cut_id,
            "target_expression": safe,
            "binding": binding,
            "plan_hash": plan_hash,
            "resolved_plan": normalized,
            "created_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "confirmation": f"xx confirm {cut_id}",
            "canonical_writes": 0,
        },
    )


def encode_agent_plan(plan: dict[str, Any]) -> str:
    """Transport an agent-resolved plan through the mechanical CLI boundary."""
    return base64.urlsafe_b64encode(_json_bytes(plan)).decode("ascii").rstrip("=")


def decode_agent_plan(token: str) -> dict[str, Any]:
    if not token or len(token) > 64_000:
        raise ValueError("agent plan token missing or too large")
    pad = "=" * (-len(token) % 4)
    try:
        value = json.loads(base64.urlsafe_b64decode(token + pad).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"agent plan token is invalid: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError("agent plan must decode to an object")
    return value


def _manifest_dir(root: Path) -> Path:
    return root / MILESTONE_DIR


def _manifest_path(root: Path, checkpoint: str) -> Path:
    return _manifest_dir(root) / checkpoint / "manifest.json"


def _pointer_path(root: Path) -> Path:
    return _manifest_dir(root) / "current.json"


def _blob_path(root: Path, digest: str) -> Path:
    return _manifest_dir(root) / "blobs" / digest


def _load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} is not a JSON object")
    return value


def _manifest_integrity(manifest: dict[str, Any]) -> str:
    body = {k: v for k, v in manifest.items() if k != "integrity_hash"}
    return _sha256(_json_bytes(body))


def _canonical_scope(root: Path, paths: list[str]) -> list[str]:
    if not isinstance(paths, list) or not paths:
        raise ValueError("milestone scope needs at least one explicit path")
    result: list[str] = []
    seen: set[str] = set()
    for raw in paths:
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError("milestone paths must be non-empty strings")
        candidate = owned_target_path(root, raw.strip(), kind="milestone scope")
        rel = candidate.relative_to(root.resolve()).as_posix()
        if rel == ".git" or rel.startswith(".git/"):
            raise ValueError("milestones never own Git internals")
        if rel.startswith(MILESTONE_DIR + "/") or rel == MILESTONE_DIR:
            raise ValueError("a milestone cannot snapshot its own storage")
        if rel in {".saipen/LOG.md", ".saipen/BOARD.md", ".saipen/STATE.md"}:
            raise ValueError("Core Checkpoint files are not Restore Milestone payload")
        key = os.path.normcase(str(candidate))
        if key in seen:
            raise ValueError(f"duplicate/path-alias milestone scope: {raw}")
        seen.add(key)
        if candidate.exists() and not candidate.is_file():
            raise ValueError(f"milestone scope must name files or absent files: {rel}")
        result.append(rel)
    return sorted(result, key=os.path.normcase)


def _all_manifests(root: Path) -> dict[str, dict[str, Any]]:
    base = _manifest_dir(root)
    result: dict[str, dict[str, Any]] = {}
    if not base.is_dir():
        return result
    if _is_link_or_reparse(base):
        return {"<unsafe-storage>": {"_corrupt": True}}
    for path in sorted(base.glob("CP-*/manifest.json")):
        checkpoint = path.parent.name
        if _is_link_or_reparse(path.parent) or _is_link_or_reparse(path):
            result[checkpoint] = {"id": checkpoint, "_corrupt": True}
            continue
        try:
            result[checkpoint] = _load_json(path)
        except (OSError, ValueError, json.JSONDecodeError):
            result[checkpoint] = {"id": checkpoint, "_corrupt": True}
    return result


def _current_id(root: Path) -> str | None:
    path = _pointer_path(root)
    if not path.is_file():
        return None
    try:
        value = _load_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return "<corrupt>"
    return value.get("current") if isinstance(value.get("current"), str) else "<corrupt>"


def _logged_milestone_ids(root: Path) -> list[str]:
    """Completed milestone IDs recorded by the append-only Core ledger."""
    paths = [root / ".saipen" / "LOG.md"]
    archive = root / ".saipen" / "logs"
    if archive.is_dir():
        paths.extend(sorted(archive.glob("LOG-*.md")))
    ids: list[str] = []
    for path in paths:
        text = _read_text_lossy(path, limit=8_000_000)
        ids.extend(re.findall(r"restore milestone (CP-\d+) created", text))
    return ids


def validate_milestones(project_root: Path | str, *, verify_payload: bool = True) -> list[str]:
    """Validate optional milestone storage.  Legacy projects remain valid."""
    root = Path(project_root).resolve()
    storage = _manifest_dir(root)
    if os.path.lexists(storage) and not storage.is_dir():
        return ["milestone storage exists but is not a directory"]
    manifests = _all_manifests(root)
    if not manifests and not _pointer_path(root).exists():
        return []
    errors: list[str] = []
    attributes = storage / "blobs" / ".gitattributes"
    if _is_link_or_reparse(attributes):
        errors.append("milestone blob attributes is a symlink/reparse point")
    elif not attributes.is_file():
        errors.append("milestone blob attributes is missing")
    elif attributes.read_bytes() != BLOB_ATTRIBUTES:
        errors.append("milestone blob attributes does not mark restore payloads as binary")
    sequences: set[int] = set()
    case_paths: dict[str, str] = {}
    for checkpoint, manifest in manifests.items():
        match = _CP_RE.fullmatch(checkpoint)
        if not match:
            errors.append(f"milestone directory {checkpoint!r} is not CP-N")
            continue
        sequence = int(match.group(1))
        if sequence <= 0:
            errors.append(f"{checkpoint} sequence must be positive")
        if sequence in sequences:
            errors.append(f"duplicate milestone sequence {sequence}")
        sequences.add(sequence)
        if manifest.get("_corrupt"):
            errors.append(f"{checkpoint} manifest is unreadable/corrupt")
            continue
        required = {
            "schema_version",
            "id",
            "sequence",
            "parent",
            "created_at",
            "label",
            "project_lineage",
            "source_revision",
            "work_ids",
            "attempt_ids",
            "kind",
            "published",
            "external_effects",
            "files",
            "integrity_hash",
        }
        missing = sorted(required - set(manifest))
        if missing:
            errors.append(f"{checkpoint} missing {', '.join(missing)}")
            continue
        if manifest.get("schema_version") != MANIFEST_SCHEMA:
            errors.append(f"{checkpoint} schema_version is not {MANIFEST_SCHEMA}")
        if manifest.get("id") != checkpoint or manifest.get("sequence") != sequence:
            errors.append(f"{checkpoint} id/sequence mismatch")
        if manifest.get("project_lineage") != project_lineage_identity(root):
            errors.append(f"{checkpoint} project lineage mismatch")
        created_at = manifest.get("created_at")
        if not isinstance(created_at, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", created_at
        ):
            errors.append(f"{checkpoint} created_at is not strict UTC")
        if not isinstance(manifest.get("label"), str) or not manifest.get("label", "").strip():
            errors.append(f"{checkpoint} label is empty or invalid")
        if not isinstance(manifest.get("source_revision"), (str, type(None))):
            errors.append(f"{checkpoint} source_revision is invalid")
        if not isinstance(manifest.get("kind"), str) or not manifest.get("kind", "").strip():
            errors.append(f"{checkpoint} kind is empty or invalid")
        if not isinstance(manifest.get("published"), bool):
            errors.append(f"{checkpoint} published is not boolean")
        external = manifest.get("external_effects")
        if not isinstance(external, list) or any(
            not isinstance(value, str) or not value.strip() for value in external
        ):
            errors.append(f"{checkpoint} external_effects is invalid")
        if manifest.get("integrity_hash") != _manifest_integrity(manifest):
            errors.append(f"{checkpoint} integrity hash mismatch")
        parent = manifest.get("parent")
        if parent is not None and (not isinstance(parent, str) or not _CP_RE.fullmatch(parent)):
            errors.append(f"{checkpoint} parent is invalid")
        for field, regex in (("work_ids", _TICKET_RE), ("attempt_ids", _ATTEMPT_RE)):
            values = manifest.get(field)
            if not isinstance(values, list) or any(
                not isinstance(value, str) or not regex.fullmatch(value) for value in values
            ):
                errors.append(f"{checkpoint} {field} is invalid")
        files = manifest.get("files")
        if not isinstance(files, list) or not files:
            errors.append(f"{checkpoint} files must be a non-empty list")
            continue
        local_seen: set[str] = set()
        for entry in files:
            if not isinstance(entry, dict):
                errors.append(f"{checkpoint} file entry is not an object")
                continue
            rel = entry.get("path")
            try:
                candidate = owned_target_path(root, rel, kind="milestone manifest")
                canonical = candidate.relative_to(root).as_posix()
            except Exception as exc:
                errors.append(f"{checkpoint} path {rel!r} escapes root: {exc}")
                continue
            key = os.path.normcase(str(candidate))
            if key in local_seen:
                errors.append(f"{checkpoint} duplicate/path-alias file {canonical}")
            local_seen.add(key)
            previous = case_paths.setdefault(key, canonical)
            if previous != canonical:
                errors.append(f"milestone path case alias: {previous} vs {canonical}")
            state = entry.get("state")
            if state == "absent":
                if entry.get("sha256") is not None or entry.get("blob") is not None:
                    errors.append(f"{checkpoint}:{canonical} absent marker carries payload")
            elif state == "file":
                digest = entry.get("sha256")
                if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                    errors.append(f"{checkpoint}:{canonical} has invalid sha256")
                    continue
                if entry.get("blob") != f"blobs/{digest}":
                    errors.append(f"{checkpoint}:{canonical} blob reference mismatch")
                blob = _blob_path(root, digest)
                unsafe_parent = blob.parent.exists() and _is_link_or_reparse(blob.parent)
                unsafe_blob = blob.exists() and _is_link_or_reparse(blob)
                if unsafe_parent or unsafe_blob:
                    errors.append(f"{checkpoint}:{canonical} payload is a symlink")
                elif not blob.is_file():
                    errors.append(f"{checkpoint}:{canonical} payload missing")
                elif verify_payload and _sha256(blob.read_bytes()) != digest:
                    errors.append(f"{checkpoint}:{canonical} payload hash mismatch")
            else:
                errors.append(f"{checkpoint}:{canonical} state is not file|absent")

    for checkpoint, manifest in manifests.items():
        if manifest.get("_corrupt"):
            continue
        parent = manifest.get("parent")
        if parent is not None and parent not in manifests:
            errors.append(f"{checkpoint} parent {parent} does not exist")
        elif parent is not None and not manifest.get("_corrupt"):
            parent_sequence = manifests[parent].get("sequence")
            current_sequence = manifest.get("sequence")
            if (
                isinstance(parent_sequence, int)
                and isinstance(current_sequence, int)
                and parent_sequence >= current_sequence
            ):
                errors.append(f"{checkpoint} parent sequence is not earlier")
    for checkpoint in manifests:
        seen: set[str] = set()
        cursor: str | None = checkpoint
        while cursor is not None and cursor in manifests:
            if cursor in seen:
                errors.append(f"milestone parent cycle includes {cursor}")
                break
            seen.add(cursor)
            cursor = manifests[cursor].get("parent")
    current = _current_id(root)
    if current == "<corrupt>":
        errors.append("milestone current pointer is corrupt")
    elif current is not None and current not in manifests:
        errors.append(f"milestone current pointer names missing {current}")
    pointer_path = _pointer_path(root)
    if os.path.lexists(pointer_path) and not pointer_path.is_file():
        errors.append("milestone current pointer exists but is not a regular file")
    if pointer_path.is_file():
        if _is_link_or_reparse(pointer_path):
            errors.append("milestone current pointer is a symlink/reparse point")
        try:
            pointer = _load_json(pointer_path)
        except (OSError, ValueError, json.JSONDecodeError):
            pointer = {}
        if pointer.get("schema_version") != POINTER_SCHEMA:
            errors.append("milestone current pointer schema is invalid")
        if not isinstance(pointer.get("updated_at"), str):
            errors.append("milestone current pointer updated_at is invalid")
    logged = _logged_milestone_ids(root)
    for checkpoint in sorted(set(logged) - set(manifests)):
        errors.append(f"LOG names completed milestone {checkpoint} but its manifest is missing")
    for checkpoint in sorted({value for value in logged if logged.count(value) > 1}):
        errors.append(f"LOG records milestone {checkpoint} more than once")
    return sorted(set(errors))


def milestone_status(project_root: Path | str) -> dict[str, Any]:
    """Bounded metadata-only status projection; payload bytes are not hashed."""
    root = Path(project_root).resolve()
    storage = _manifest_dir(root)
    if os.path.lexists(storage) and (
        not storage.is_dir() or _is_link_or_reparse(storage)
    ):
        return {
            "current": None,
            "label": None,
            "parent": None,
            "undo_available": False,
            "valid": False,
        }
    pending = _pending_operation_ids(root)
    if pending:
        return {
            "current": None,
            "label": None,
            "parent": None,
            "undo_available": False,
            "valid": False,
            "recovery_pending": pending,
        }
    current = _current_id(root)
    manifests = _all_manifests(root)
    manifest = manifests.get(current or "")
    if not manifest or manifest.get("_corrupt"):
        return {
            "current": None if current is None else current,
            "label": None,
            "parent": None,
            "undo_available": False,
            "valid": current is None,
        }
    return {
        "current": current,
        "label": manifest.get("label"),
        "parent": manifest.get("parent"),
        "parent_label": (
            manifests.get(manifest.get("parent") or "", {}).get("label")
            if manifest.get("parent")
            else None
        ),
        "undo_available": manifest.get("parent") is not None,
        "published": bool(manifest.get("published")),
        "valid": True,
    }


def _snapshot_entries(
    root: Path, paths: list[str]
) -> tuple[list[dict[str, Any]], dict[str, bytes], dict[str, str]]:
    entries: list[dict[str, Any]] = []
    blobs: dict[str, bytes] = {}
    read_preconditions: dict[str, str] = {}
    for rel in paths:
        path = owned_target_path(root, rel, kind="milestone capture")
        if not path.exists():
            entries.append({"path": rel, "state": "absent", "sha256": None, "blob": None})
            read_preconditions[rel] = MISSING_FILE_DEPENDENCY
            continue
        if not path.is_file():
            raise ValueError(f"milestone capture target is not a regular file: {rel}")
        raw = path.read_bytes()
        digest = _sha256(raw)
        entries.append({"path": rel, "state": "file", "sha256": digest, "blob": f"blobs/{digest}"})
        blobs[digest] = raw
        read_preconditions[rel] = hash_bytes(raw)
    return entries, blobs, read_preconditions


def _git_snapshot_entries(
    root: Path,
    paths: list[str],
    revision: str,
) -> tuple[list[dict[str, Any]], dict[str, bytes]]:
    """Read a sparse historical baseline through Git plumbing only.

    No index, ref or worktree state is changed. The timestamp remains the
    actual milestone creation time; `source_revision` truthfully identifies
    where the historical bytes came from.
    """
    if not re.fullmatch(r"[0-9a-fA-F]{40}", revision or ""):
        raise ValueError("baseline source revision must be a full commit hash")
    commit = subprocess.run(
        ["git", "-C", str(root), "cat-file", "-e", f"{revision}^{{commit}}"],
        capture_output=True,
        timeout=10,
        check=False,
    )
    if commit.returncode != 0:
        raise ValueError(f"baseline source revision {revision} is not a local commit")
    entries: list[dict[str, Any]] = []
    blobs: dict[str, bytes] = {}
    for rel in paths:
        tree = subprocess.run(
            ["git", "-C", str(root), "ls-tree", "-z", revision, "--", rel],
            capture_output=True,
            timeout=10,
            check=False,
        )
        if tree.returncode != 0:
            raise ValueError(f"cannot inspect {rel} at baseline revision {revision}")
        if not tree.stdout:
            entries.append({"path": rel, "state": "absent", "sha256": None, "blob": None})
            continue
        header, _separator, recorded_path = tree.stdout.partition(b"\t")
        fields = header.decode("ascii", errors="strict").split()
        if len(fields) != 3 or fields[1] != "blob" or fields[0] == "120000":
            raise ValueError(f"baseline path is not a regular Git blob: {rel}")
        if recorded_path.rstrip(b"\0").decode("utf-8", errors="surrogateescape") != rel:
            raise ValueError(f"baseline path lookup was not exact: {rel}")
        shown = subprocess.run(
            ["git", "-C", str(root), "show", f"{revision}:{rel}"],
            capture_output=True,
            timeout=30,
            check=False,
        )
        if shown.returncode != 0:
            raise ValueError(f"cannot read baseline bytes for {rel}")
        raw = shown.stdout
        digest = _sha256(raw)
        entries.append({"path": rel, "state": "file", "sha256": digest, "blob": f"blobs/{digest}"})
        blobs[digest] = raw
    return entries, blobs


def _target_bytes(root: Path, rel: str, role: str, content: bytes) -> TargetPlan:
    path = owned_target_path(root, rel, kind="milestone target")
    before = hash_bytes(path.read_bytes()) if path.is_file() else ""
    return TargetPlan(rel, role, content, before, hash_bytes(content))


def _label(title: str, when: dt.datetime) -> str:
    words = re.sub(r"[^\w ._-]+", " ", title, flags=re.UNICODE).split()
    short = " ".join(words[:5]) or "Milestone"
    weekday = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[when.weekday()]
    return f"{when.strftime('%Y-%m-%d')} {weekday}  {short}"[:96]


def plan_milestone(
    project_root: Path | str,
    agent: str,
    title: str,
    paths: list[str],
    *,
    work_ids: list[str] | None = None,
    attempt_ids: list[str] | None = None,
    kind: str = "semantic",
    published: bool = False,
    external_effects: list[str] | None = None,
    capture_revision: str | None = None,
) -> OperationPlan | Result:
    root = Path(project_root).resolve()
    try:
        safe_title = _safe_text(title, label="milestone title", limit=120)
        scope = _canonical_scope(root, paths)
    except (ValueError, OSError) as exc:
        return _refuse("INVALID_MANIFEST", str(exc))
    work_ids = work_ids or []
    attempt_ids = attempt_ids or []
    if any(not _TICKET_RE.fullmatch(value) for value in work_ids):
        return _refuse("INVALID_MANIFEST", "work_ids contain an invalid Work ID")
    if any(not _ATTEMPT_RE.fullmatch(value) for value in attempt_ids):
        return _refuse("INVALID_MANIFEST", "attempt_ids contain an invalid Attempt ID")
    existing = _all_manifests(root)
    if any(manifest.get("_corrupt") for manifest in existing.values()):
        return _refuse("INVALID_MANIFEST", "existing milestone manifest is corrupt")
    historical_ids = set(existing) | set(_logged_milestone_ids(root))
    sequence = (
        max(
            (int(match.group(1)) for cp in historical_ids if (match := _CP_RE.fullmatch(cp))),
            default=0,
        )
        + 1
    )
    checkpoint = f"CP-{sequence:03d}"
    parent = _current_id(root)
    if parent == "<corrupt>" or (parent is not None and parent not in existing):
        return _refuse("INVALID_MANIFEST", "current milestone pointer is invalid")
    try:
        if capture_revision is None:
            entries, blobs, scope_preconditions = _snapshot_entries(root, scope)
        else:
            if historical_ids:
                return _refuse(
                    "INVALID_MANIFEST",
                    "historical Git capture is allowed only for the first baseline",
                )
            entries, blobs = _git_snapshot_entries(root, scope, capture_revision)
            scope_preconditions = {}
    except (ValueError, OSError) as exc:
        return _refuse("INVALID_MANIFEST", str(exc))
    now = dt.datetime.now(dt.timezone.utc)
    lineage = project_lineage_identity(root)
    if lineage is None:
        return _refuse(
            "INVALID_MANIFEST",
            "project has no valid durable lineage identity",
        )
    manifest: dict[str, Any] = {
        "schema_version": MANIFEST_SCHEMA,
        "id": checkpoint,
        "sequence": sequence,
        "parent": parent,
        "created_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "label": _label(safe_title, now),
        "project_lineage": lineage,
        "source_revision": capture_revision or _git_revision(root),
        "work_ids": work_ids,
        "attempt_ids": attempt_ids,
        "kind": kind,
        "published": bool(published),
        "external_effects": list(external_effects or []),
        "files": entries,
    }
    manifest["integrity_hash"] = _manifest_integrity(manifest)
    pointer = {
        "schema_version": POINTER_SCHEMA,
        "current": checkpoint,
        "updated_at": manifest["created_at"],
    }

    docs, state, _board, log_tail = _read(root)
    if attempt_error := _attempt_handover_error(docs, state, agent):
        return _refuse("VALIDATION_FAILED", attempt_error)
    op_id = (
        "milestone-"
        + hashlib.sha256((checkpoint + manifest["integrity_hash"]).encode("ascii")).hexdigest()[:16]
    )
    event, event_line = _event_line(
        docs,
        log_tail,
        "DEC",
        work_ids[0] if work_ids else None,
        agent,
        _actor_provenance(
            state, agent, f"restore milestone {checkpoint} created -- {manifest['label']}"
        ),
        _now(),
        op_id,
    )
    log_text = docs["log"].text_norm.rstrip("\n") + "\n" + event_line + "\n"
    state_text = patch_state(
        docs["state"].text_norm,
        {"last_event": event, "updated": _utc_iso(), "agent": agent},
    )
    errors = validate_texts(
        state_text,
        docs["board"].text_norm,
        log_text,
        current_agent=agent,
        sealed_events=docs["_history"],
    )
    if errors:
        return _refuse("VALIDATION_FAILED", "; ".join(errors[:5]))

    targets: list[TargetPlan] = []
    attributes_rel = f"{MILESTONE_DIR}/blobs/.gitattributes"
    attributes_path = root / attributes_rel
    if os.path.lexists(attributes_path):
        if (
            not attributes_path.is_file()
            or _is_link_or_reparse(attributes_path)
            or attributes_path.read_bytes() != BLOB_ATTRIBUTES
        ):
            return _refuse(
                "INVALID_MANIFEST",
                f"milestone blob attributes is unsafe or invalid at {attributes_rel}",
            )
    else:
        targets.append(_target_bytes(root, attributes_rel, "generic", BLOB_ATTRIBUTES))
    for digest, raw in sorted(blobs.items()):
        rel = f"{MILESTONE_DIR}/blobs/{digest}"
        path = root / rel
        if path.is_file():
            if _sha256(path.read_bytes()) != digest:
                return _refuse("INVALID_MANIFEST", f"blob collision/corruption at {rel}")
            continue
        targets.append(_target_bytes(root, rel, "generic", raw))
    # Payload first, completed manifest last; pointer and Core evidence follow.
    targets.append(
        _target_bytes(
            root, f"{MILESTONE_DIR}/{checkpoint}/manifest.json", "manifest", _json_bytes(manifest)
        )
    )
    targets.append(
        _target_bytes(root, f"{MILESTONE_DIR}/current.json", "manifest", _json_bytes(pointer))
    )
    targets.extend(
        [
            *_log_targets(docs, log_text),
            _target(docs["state"], ".saipen/STATE.md", "state", state_text),
        ]
    )
    preconditions = _docs_preconditions(docs, "state", "board", "log")
    for target in targets:
        preconditions.setdefault(target.path, target.before_hash)
    preconditions.update(scope_preconditions)
    return build_plan(
        "milestone_create",
        agent,
        canonical_identity(root),
        {"operation": "milestone_create", "id": checkpoint, "manifest": manifest["integrity_hash"]},
        preconditions,
        targets,
        {
            "ok": True,
            "code": "MILESTONE_CREATED",
            "milestone": checkpoint,
            "label": manifest["label"],
            "parent": parent,
            "event_id": f"E-{event}",
            "capture_revision": capture_revision,
        },
        op_id=op_id,
    )


def create_milestone(
    project_root: Path | str,
    agent: str,
    title: str,
    paths: list[str],
    *,
    work_ids: list[str] | None = None,
    attempt_ids: list[str] | None = None,
    kind: str = "semantic",
    published: bool = False,
    external_effects: list[str] | None = None,
    capture_revision: str | None = None,
    dry_run: bool = False,
) -> Result:
    plan = plan_milestone(
        project_root,
        agent,
        title,
        paths,
        work_ids=work_ids,
        attempt_ids=attempt_ids,
        kind=kind,
        published=published,
        external_effects=external_effects,
        capture_revision=capture_revision,
    )
    if isinstance(plan, Result):
        return plan
    return _render_plan(plan) if dry_run else apply_plan(project_root, plan)


def confirm_cut(
    project_root: Path | str,
    agent: str,
    cut_id: str,
    plan: dict[str, Any],
    *,
    dry_run: bool = False,
) -> Result:
    """Confirm an agent-resolved cut; create rollback anchor then normal Work."""
    if not isinstance(plan, dict):
        return _refuse("VALIDATION_FAILED", "cut confirmation needs an agent-resolved plan")
    target = plan.get("target_expression")
    if not isinstance(target, str):
        return _refuse("VALIDATION_FAILED", "cut plan needs target_expression")
    root = Path(project_root).resolve()
    try:
        normalized = _normalized_cut_plan(root, target.strip(), plan)
    except (ValueError, OSError) as exc:
        return _refuse("VALIDATION_FAILED", str(exc))
    affected = normalized["affected_paths"]
    resolved = normalized["resolved_target"]
    binding = plan.get("binding")
    plan_hash = _sha256(_json_bytes(normalized))
    authenticated = {**binding, "plan_hash": plan_hash} if isinstance(binding, dict) else {}
    if (
        not isinstance(binding, dict)
        or plan.get("plan_hash") != plan_hash
        or cut_id != "CUT-" + _binding_digest("cut", target.strip(), authenticated)
    ):
        return _refuse(
            "STALE_PLAN",
            f"{cut_id} does not authenticate this exact impact plan and original snapshot",
        )
    if dry_run:
        return Result(
            ok=True,
            code="CUT_CONFIRM_PLAN",
            data={
                "dry_run": True,
                "cut_id": cut_id,
                "rollback_anchor_paths": affected,
                "phase_after": "SCOUT",
            },
        )
    anchor_kind = f"pre-cut:{cut_id}"
    anchors = [
        manifest
        for manifest in _all_manifests(root).values()
        if not manifest.get("_corrupt") and manifest.get("kind") == anchor_kind
    ]
    if len(anchors) > 1:
        return _refuse("INVALID_MANIFEST", f"multiple rollback anchors claim {cut_id}")
    board = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig"))
    admitted = [
        ticket
        for ticket in board.get("tickets", {}).values()
        if f"[{cut_id}]" in ticket.get("raw", "")
    ]
    if admitted:
        if not anchors:
            return _refuse(
                "INVALID_MANIFEST",
                f"cut Work {admitted[0]['id']} names {cut_id} but its rollback anchor is missing",
            )
        anchor_id = anchors[0]["id"]
        return Result(
            ok=True,
            code="ALREADY_APPLIED",
            data={
                "cut_id": cut_id,
                "rollback_anchor": anchor_id,
                "ticket": admitted[0]["id"],
            },
        )
    if anchors:
        anchor_manifest = anchors[0]
        live = _source_binding(root)
        source_keys = {"project_identity", "source_revision", "source_fingerprint"}
        if _current_id(root) != anchor_manifest["id"] or any(
            live.get(key) != binding.get(key) for key in source_keys
        ):
            return _refuse(
                "STALE_PLAN",
                "pre-cut anchor exists but source/current lineage changed before Work intake",
            )
        anchor_id = anchor_manifest["id"]
    else:
        preview = cut_preview(root, target, normalized)
        if not preview.ok:
            return preview
        if (
            cut_id != preview.data["cut_id"]
            or binding != preview.data["binding"]
            or plan_hash != preview.data["plan_hash"]
        ):
            return _refuse(
                "STALE_PLAN",
                "cut plan binding no longer matches current source/state",
            )
        anchor = create_milestone(
            root,
            agent,
            f"Pre-cut {resolved}",
            affected,
            kind=anchor_kind,
            published=False,
        )
        if not anchor.ok:
            return anchor
        anchor_id = anchor.data.get("milestone")
        live = _source_binding(root)
        source_keys = {"project_identity", "source_revision", "source_fingerprint"}
        if any(live.get(key) != binding.get(key) for key in source_keys):
            return _refuse(
                "STALE_PLAN",
                "source changed while the pre-cut rollback anchor was created",
            )
    directive = f"Remove {resolved}; preserve: {plan.get('preserve')}; approved plan {cut_id}"
    result = directive_entry(root, agent, directive, kind="cut", evidence_id=cut_id, dry_run=False)
    if result.ok:
        result.data["rollback_anchor"] = anchor_id
        result.data["cut_id"] = cut_id
    return result


def _entry_map(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {entry["path"]: entry for entry in manifest.get("files", [])}


def _live_entry(root: Path, entry: dict[str, Any]) -> tuple[str, str | None]:
    path = owned_target_path(root, entry["path"], kind="undo preview")
    if not path.exists():
        return "absent", None
    if not path.is_file():
        return "foreign", None
    return "file", _sha256(path.read_bytes())


def _pending_operation_ids(root: Path) -> list[str]:
    """Read-only recovery priority witness for milestone projections."""
    try:
        return [str(record.get("op_id", "<corrupt>")) for record in pending_ops(root)]
    except (OSError, ValueError):
        return ["<unreadable>"]


def _reviewed_dirty_ownership(
    root: Path,
    current: dict[str, Any],
    dirty: list[str],
) -> tuple[bool, list[str]]:
    """Prove dirty milestone paths are SAIPEN-owned through release scopes.

    A Work's reviewed release-scope record is the existing exact-path/hash
    ownership authority.  It is accepted only when it belongs to this project,
    was recorded no earlier than the milestone, names a real Work, and its
    recorded bytes still equal the live path.  Anything weaker remains foreign.
    """
    if not dirty:
        return False, []
    scope_dir = root / ".saipen" / "kitchen" / "release_scope"
    if not scope_dir.is_dir():
        return False, []
    try:
        board = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return False, []
    tickets = board.get("tickets", {})
    live_lineage = project_lineage_identity(root)
    live_bytes: dict[str, bytes | None] = {}
    for rel in dirty:
        path = owned_target_path(root, rel, kind="undo ownership")
        live_bytes[rel] = path.read_bytes() if path.is_file() else None
    proven: set[str] = set()
    evidence: set[str] = set()
    for scope_path in sorted(scope_dir.glob("T-*.json")):
        try:
            record = json.loads(scope_path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        ticket = record.get("ticket")
        paths = record.get("paths")
        if "project_lineage" in record:
            project_matches = (
                isinstance(record.get("project_lineage"), str)
                and bool(live_lineage)
                and record.get("project_lineage") == live_lineage
            )
        else:
            # Explicit compatibility boundary for old scope records: before
            # the durable lineage carrier existed, runtime path identity was
            # the only project binding available.  Never let a malformed new
            # lineage-bearing record fall back to that weaker rule.
            project_matches = record.get("project_identity") == canonical_identity(root)
        if (
            record.get("schema_version") not in (1, 2)
            or not project_matches
            or not isinstance(ticket, str)
            or ticket not in tickets
            or not isinstance(paths, dict)
            or str(record.get("recorded_at", "")) < str(current.get("created_at", ""))
        ):
            continue
        matched = {
            rel
            for rel in dirty
            if rel in paths
            and live_bytes.get(rel) is not None
            and release_scope_matches(live_bytes[rel], paths.get(rel))
        }
        if matched:
            proven.update(matched)
            evidence.add(ticket)
    return proven == set(dirty), sorted(evidence)


def _work_release_is_published(root: Path, work_ids: list[str]) -> bool:
    """Prove every Work owning a post-milestone delta was pushed.

    The release engine appends this machine-owned RUN evidence only after the
    content commit is successfully published.  Unlike local remote-tracking
    refs, the append-only LOG evidence survives a fresh clone and does not
    require a network query during undo preview.
    """
    wanted = set(work_ids)
    if not wanted:
        return False
    try:
        events = read_history_events(root)
    except (OSError, UnicodeError, ValueError):
        return False
    published = {
        str(event.get("ticket"))
        for event in events
        if event.get("taxonomy") == "RUN"
        and event.get("ticket") in wanted
        and _PUBLISHED_RELEASE_RE.fullmatch(str(event.get("text", "")))
    }
    return published == wanted


def undo_preview(project_root: Path | str) -> Result:
    """Select exactly one lineage step and prove the restore scope read-only."""
    root = Path(project_root).resolve()
    pending = _pending_operation_ids(root)
    if pending:
        return _refuse(
            "RECOVERY_REQUIRED",
            "pending operation must recover before a milestone can be selected",
            pending_op_ids=pending,
        )
    errors = validate_milestones(root, verify_payload=True)
    if errors:
        return _refuse("INVALID_MANIFEST", "; ".join(errors[:5]))
    manifests = _all_manifests(root)
    current_id = _current_id(root)
    if current_id is None:
        return _refuse(
            "INVALID_MANIFEST", "no Restore Milestones exist; create a real baseline first"
        )
    current = manifests[current_id]
    current_map = _entry_map(current)
    foreign: list[str] = []
    for rel, cur in current_map.items():
        live_state, live_hash = _live_entry(root, cur)
        if live_state != cur["state"] or (live_state == "file" and live_hash != cur["sha256"]):
            foreign.append(rel)
    dirty_owned, ownership_work = _reviewed_dirty_ownership(root, current, foreign)
    dirty_since = bool(foreign and dirty_owned)
    if foreign and not dirty_owned:
        return _refuse(
            "CONFLICT",
            "foreign/unattributed changes overlap restore scope",
            foreign_paths=foreign,
            current=current_id,
            target=current.get("parent"),
        )
    target_id = current_id if dirty_since else current.get("parent")
    if target_id is None:
        return Result(
            ok=True,
            code="NO_UNDO_AVAILABLE",
            data={"read_only": True, "current": current_id, "target": None, "canonical_writes": 0},
        )
    target = manifests[target_id]
    target_map = _entry_map(target)
    missing_history = sorted(set(current_map) - set(target_map))
    if missing_history:
        return _refuse(
            "INVALID_MANIFEST",
            "target milestone lacks exact pre-state for: " + ", ".join(missing_history[:8]),
        )
    changes: list[dict[str, Any]] = []
    for rel, cur in current_map.items():
        live_state, live_hash = _live_entry(root, cur)
        old = target_map[rel]
        before = (live_state, live_hash) if dirty_since else (cur["state"], cur.get("sha256"))
        if (cur["state"], cur.get("sha256")) != (old["state"], old.get("sha256")):
            before = (cur["state"], cur.get("sha256"))
        if before != (old["state"], old.get("sha256")):
            changes.append(
                {
                    "path": rel,
                    "current": before[0],
                    "target": old["state"],
                    "current_hash": before[1],
                    "target_hash": old.get("sha256"),
                }
            )
    binding = _source_binding(root)
    restore_plan_hash = hashlib.sha256(
        _json_bytes(
            {
                "current": current_id,
                "target": target_id,
                "target_manifest": target["integrity_hash"],
                "changes": changes,
                "binding": binding,
            }
        )
    ).hexdigest()[:16]
    return Result(
        ok=True,
        code="UNDO_PREVIEW",
        data={
            "read_only": True,
            "current": {"id": current_id, "label": current["label"]},
            "target": {"id": target_id, "label": target["label"]},
            "will_revert": changes,
            "will_preserve": "paths outside the exact milestone scope",
            "foreign_changes": [],
            "external_effects": current.get("external_effects", []),
            "published": (
                _work_release_is_published(root, ownership_work)
                if dirty_since
                else bool(current.get("published"))
            ),
            "dirty_since": dirty_since,
            "ownership_work": ownership_work,
            "restore_plan_hash": restore_plan_hash,
            "binding": binding,
            "confirmation": f'zz confirm {target_id} --reason "<one sentence>"',
            "canonical_writes": 0,
        },
    )


def _undo_op_id(root: Path, target: str, reason: str, generation: str = "") -> str:
    identity = canonical_identity(root) + "\0" + target + "\0" + reason
    if generation:
        identity += "\0" + generation
    return (
        "undo-"
        + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    )


def _undo_record_is_live(root: Path, record: dict) -> bool:
    """True only when a committed restore receipt still describes live state."""
    if record.get("operation") != "milestone_restore":
        return False
    if record.get("project_identity") != canonical_identity(root):
        return False
    expected_lineage = record.get("project_lineage")
    if expected_lineage and project_lineage_identity(root) != expected_lineage:
        return False
    targets = record.get("targets")
    if not isinstance(targets, list) or not targets:
        return False
    try:
        return all(
            _target_live_hash(root, target) == target.get("after_hash", "")
            for target in targets
        )
    except (OSError, ValueError, TypeError, KeyError):
        return False


def _matching_live_undo_receipt(
    root: Path, target_id: str, reason: str, *, exclude_op_id: str
) -> str | None:
    """Find a later generation receipt that still proves exact idempotence."""
    for base in (
        root / ".saipen/recovery/ops",
        root / ".saipen/recovery/settled",
    ):
        if not base.is_dir():
            continue
        for manifest in sorted(base.glob("undo-*/operation.json")):
            op_id = manifest.parent.name
            if op_id == exclude_op_id:
                continue
            decoded = decode_operation_record(root, manifest.parent)
            if not decoded.get("ok"):
                continue
            record = decoded["record"]
            metadata = record.get("receipt_metadata")
            if (
                record.get("status") == "COMMITTED"
                and isinstance(metadata, dict)
                and metadata.get("undo_target") == target_id
                and metadata.get("undo_reason") == reason
                and _undo_record_is_live(root, record)
            ):
                return op_id
    return None


def undo_confirm(
    project_root: Path | str,
    agent: str,
    target_id: str,
    reason: str,
    *,
    dry_run: bool = False,
) -> Result:
    """Confirm one safe lineage step; never rewrite Git or truncate LOG."""
    root = Path(project_root).resolve()
    try:
        safe_reason = _safe_text(reason, label="undo reason", limit=MAX_REASON)
    except ValueError as exc:
        return _refuse("DESTRUCTIVE_CONFIRMATION_REQUIRED", str(exc))
    if "\n" in safe_reason or "\r" in safe_reason:
        return _refuse(
            "DESTRUCTIVE_CONFIRMATION_REQUIRED",
            "undo reason must be one bounded line, never command text",
        )
    if not _CP_RE.fullmatch(target_id or ""):
        return _refuse("INVALID_ID", "undo target must be CP-N")
    base_op_id = _undo_op_id(root, target_id, safe_reason)
    op_id = base_op_id
    historical_receipt = False
    journal = Journal(root, base_op_id)
    if journal.exists():
        decoded = decode_operation_record(root, journal.dir)
        if not decoded.get("ok"):
            return _refuse(
                decoded.get("code", "CORRUPT_JOURNAL"),
                decoded.get("detail", "invalid undo receipt"),
                recovery_required=True,
            )
        record = decoded["record"]
        if record.get("operation") != "milestone_restore":
            return _refuse(
                "VALIDATION_FAILED",
                "undo op_id collision: committed receipt belongs to another operation",
            )
        if record.get("project_identity") != canonical_identity(root) or (
            record.get("project_lineage")
            and record.get("project_lineage") != project_lineage_identity(root)
        ):
            return _refuse(
                "PROJECT_MISMATCH",
                "undo receipt is not bound to the current project",
                recovery_required=True,
            )
        metadata = record.get("receipt_metadata")
        if not isinstance(metadata, dict) or (
            metadata.get("undo_target") != target_id
            or metadata.get("undo_reason") != safe_reason
        ):
            return _refuse(
                "VALIDATION_FAILED",
                "undo op_id collision: receipt semantics do not match target and reason",
            )
        if record.get("status") == "COMMITTED":
            if _undo_record_is_live(root, record):
                return Result(
                    ok=True,
                    code="ALREADY_APPLIED",
                    op_id=base_op_id,
                    data={"target": target_id, "reason": safe_reason},
                )
            historical_receipt = True
        else:
            return _refuse(
                "RECOVERY_REQUIRED",
                f"undo operation {base_op_id} is {record.get('status')}",
                recovery_required=True,
            )

    replay_op_id = _matching_live_undo_receipt(
        root, target_id, safe_reason, exclude_op_id=base_op_id
    )
    if replay_op_id is not None:
        return Result(
            ok=True,
            code="ALREADY_APPLIED",
            op_id=replay_op_id,
            data={"target": target_id, "reason": safe_reason},
        )

    preview = undo_preview(root)
    if not preview.ok:
        return preview
    if preview.code != "UNDO_PREVIEW" or preview.data["target"]["id"] != target_id:
        return _refuse(
            "STALE_PLAN",
            f"{target_id} is not the current one-step undo target; run zz again",
        )
    if preview.data.get("external_effects"):
        return _refuse(
            "DESTRUCTIVE_CONFIRMATION_REQUIRED",
            "milestone records external effects; no supported compensation "
            "path proves them reversible",
            external_effects=preview.data["external_effects"],
        )
    if preview.data.get("published"):
        if dry_run:
            return Result(
                ok=True,
                code="FORWARD_REVERT_PLAN",
                data={"dry_run": True, "target": target_id, "reason": safe_reason},
            )
        directive = (
            f"Forward-revert published work to milestone {target_id}; reason: {safe_reason}. "
            "Do not rewrite commits, tags, or remote history"
        )
        result = directive_entry(
            root, agent, directive, kind="undo", evidence_id=target_id, dry_run=False
        )
        if result.ok:
            result.code = "FORWARD_REVERT_WORK_STARTED"
            result.data["target"] = target_id
            result.data["reason"] = safe_reason
        return result

    if historical_receipt:
        # The same user decision against a later milestone generation is a new
        # restore, bound to this exact plan rather than masked by old history.
        op_id = _undo_op_id(
            root,
            target_id,
            safe_reason,
            generation=preview.data["restore_plan_hash"],
        )

    manifests = _all_manifests(root)
    current_id = preview.data["current"]["id"]
    current = manifests[current_id]
    target = manifests[target_id]
    current_map = _entry_map(current)
    target_map = _entry_map(target)
    dirty_since = bool(preview.data.get("dirty_since"))
    preview_changes = {change["path"]: change for change in preview.data["will_revert"]}
    docs, state, _board, log_tail = _read(root)
    if attempt_error := _attempt_handover_error(docs, state, agent):
        return _refuse("VALIDATION_FAILED", attempt_error)
    targets: list[dict[str, Any]] = []
    preconditions: dict[str, str] = {}
    for rel in sorted(current_map, key=os.path.normcase):
        cur = current_map[rel]
        old = target_map[rel]
        path = owned_target_path(root, rel, kind="undo restore")
        before_hash = hash_bytes(path.read_bytes()) if path.is_file() else ""
        if dirty_since and rel in preview_changes:
            live_state, live_hash = _live_entry(root, cur)
            expected = preview_changes[rel]
            still_fresh = live_state == expected["current"] and (
                live_state != "file" or live_hash == expected["current_hash"]
            )
        else:
            expected_before = (
                hash_bytes(_blob_path(root, cur["sha256"]).read_bytes())
                if cur["state"] == "file"
                else ""
            )
            still_fresh = before_hash == expected_before
        if not still_fresh:
            return _refuse("CONFLICT", f"foreign change appeared after preview: {rel}")
        preconditions[rel] = before_hash
        if old["state"] == "absent":
            targets.append(
                {
                    "path": rel,
                    "role": "generic",
                    "action": "delete_file",
                    "before_hash": before_hash,
                    "after_hash": "",
                }
            )
        else:
            raw = _blob_path(root, old["sha256"]).read_bytes()
            targets.append(
                {
                    "path": rel,
                    "role": "generic",
                    "action": "write",
                    "content": raw,
                    "before_hash": before_hash,
                    "after_hash": hash_bytes(raw),
                }
            )
    pointer_rel = f"{MILESTONE_DIR}/current.json"
    pointer_path = root / pointer_rel
    pointer_raw = _json_bytes(
        {
            "schema_version": POINTER_SCHEMA,
            "current": target_id,
            "updated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    )
    pointer_before = hash_bytes(pointer_path.read_bytes()) if pointer_path.is_file() else ""
    preconditions[pointer_rel] = pointer_before
    targets.append(
        {
            "path": pointer_rel,
            "role": "manifest",
            "action": "write",
            "content": pointer_raw,
            "before_hash": pointer_before,
            "after_hash": hash_bytes(pointer_raw),
        }
    )
    event, event_line = _event_line(
        docs,
        log_tail,
        "DEC",
        None,
        agent,
        _actor_provenance(state, agent, f"undo {current_id}->{target_id} -- reason: {safe_reason}"),
        _now(),
        op_id,
    )
    log_text = docs["log"].text_norm.rstrip("\n") + "\n" + event_line + "\n"
    state_text = patch_state(
        docs["state"].text_norm,
        {"last_event": event, "updated": _utc_iso(), "agent": agent},
    )
    for planned in (
        *_log_targets(docs, log_text),
        _target(docs["state"], ".saipen/STATE.md", "state", state_text),
    ):
        preconditions[planned.path] = planned.before_hash
        targets.append(
            {
                "path": planned.path,
                "role": planned.role,
                "action": "write",
                "content": planned.content,
                "before_hash": planned.before_hash,
                "after_hash": planned.after_hash,
            }
        )
    request = {
        "operation": "milestone_restore",
        "current": current_id,
        "target": target_id,
        "target_manifest": target["integrity_hash"],
        "reason": safe_reason,
        "restore_plan_hash": preview.data["restore_plan_hash"],
    }
    if dry_run:
        return Result(
            ok=True,
            code="UNDO_CONFIRM_PLAN",
            op_id=op_id,
            data={
                "dry_run": True,
                "target": target_id,
                "changed_files": [target["path"] for target in targets],
                "reason": safe_reason,
            },
        )
    try:
        with project_writer_lock(root):
            if _source_binding(root) != preview.data["binding"]:
                return _refuse(
                    "STALE_STATE",
                    "project snapshot changed after undo preview; run zz again",
                )
            commit = run_mutation(
                root,
                op_id,
                "milestone_restore",
                agent,
                canonical_identity(root),
                semantic_payload_hash(request),
                targets,
                preconditions=preconditions,
                verification_policy="core_fast",
                verify=validate_project,
                receipt_metadata={
                    "undo_target": target_id,
                    "undo_reason": safe_reason,
                    "undo_current": current_id,
                    "undo_restore_plan_hash": preview.data["restore_plan_hash"],
                },
            )
    except PermissionError as exc:
        return _refuse("WRITER_BUSY", str(exc))
    if not commit.get("ok"):
        code = commit.get("code", "VALIDATION_FAILED")
        return _refuse(
            code,
            commit.get("detail", "restore failed"),
            recovery_required=bool(commit.get("recovery_required")),
        )
    return Result(
        ok=True,
        code="RESTORED" if commit.get("code") != "ALREADY_APPLIED" else "ALREADY_APPLIED",
        op_id=op_id,
        changed_files=[target["path"] for target in targets],
        data={
            "from": current_id,
            "target": target_id,
            "reason": safe_reason,
            "event_id": f"E-{event}",
            "log_append_only": True,
            "git_history_rewritten": False,
        },
    )
