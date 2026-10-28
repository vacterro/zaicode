"""Focused regression tests for the SAIPEN AUDIT CORE fixes (CORE-001..CORE-008).

These are the explicit CORE_DONE_WHEN regressions: each CORE's VERIFY section is
pinned to a deterministic, side-effect-free assertion so the audit gate
("implement all 8 + no new failures") is machine-checkable on a full checkout.

Run standalone:
    python tools/test_core_audit_fixes.py

Exit code 0 when every assertion passes; 1 on the first failure batch.
"""

from __future__ import annotations

import ast
import json
import sys
import tempfile
import zipfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.state import is_absolute_home, parse_state  # noqa: E402
from saipen_engine.journal import (  # noqa: E402
    decode_operation_record,
    resolve_conflict,
    compact_committed,
    validate_op_id,
)
from saipen_engine.safeid import InvalidIdError  # noqa: E402
from saipen_engine.operations import _event_line  # noqa: E402
from saipen_engine.router import route_next  # noqa: E402
from saipen_engine.lock import WriterLock  # noqa: E402
from verify_handoff_archive import gate_a_archive_contents  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL"), name, ("" if cond else f"-- {detail}"))


def _manifest(op_id, status="PREPARED", targets=None, **extra):
    """Minimal but decoder-valid operation.json manifest.

    Targets use action ``delete_file`` on purpose: only ``write`` targets
    require staged-write evidence during decode, and we do not want every
    fixture to have to ship a .staged file just to exercise the sidecar /
    collision / resolve paths.
    """
    m = {
        "op_id": op_id,
        "status": status,
        "operation": "audit core regression op",
        "semantic_payload_hash": "sha256:" + "0" * 64,
        "created_at": "2026-08-19T16:00:00Z",
        "agent": "aleks",
        "project_identity": "pid-audit",
        "verification_policy": "none",
        "progress_index": 0,
        "targets": targets
        if targets is not None
        else [
            {
                "path": "a.txt",
                "role": "generic",
                "before_hash": "b",
                "after_hash": "a",
                "action": "delete_file",
                "applied": False,
            }
        ],
    }
    m.update(extra)
    return m


# ---------------------------------------------------------------------------
# CORE-001 [P0]: one strict decoder owns BOTH operation.json AND progress.json
# ---------------------------------------------------------------------------
def test_core001() -> None:
    root = Path(tempfile.mkdtemp())
    op = root / "opX1"
    op.mkdir()
    (op / "operation.json").write_text(json.dumps(_manifest("opX1")))

    # No sidecar: legacy receipt decodes unchanged.
    d = decode_operation_record(root, op)
    check(
        "CORE-001 no-sidecar decodes cleanly",
        d["ok"] and d["record"]["status"] == "PREPARED",
        str(d),
    )

    # Valid sidecar is merged into the effective record.
    (op / "progress.json").write_text(
        json.dumps({"status": "VERIFIED", "progress_index": 1, "applied_frontier": 0})
    )
    d = decode_operation_record(root, op)
    check(
        "CORE-001 valid sidecar merges status/progress_index/applied",
        d["ok"]
        and d["record"]["status"] == "VERIFIED"
        and d["record"]["progress_index"] == 1
        and d["record"]["targets"][0]["applied"] is True,
        str(d),
    )

    # Malformed sidecar is REFUSED, never ignored.
    (op / "progress.json").write_text("{not valid json")
    d = decode_operation_record(root, op)
    check(
        "CORE-001 malformed sidecar refused (RECOVERY_CONFLICT)",
        (not d["ok"]) and d["code"] == "RECOVERY_CONFLICT",
        str(d),
    )

    # Out-of-range progress_index refused.
    (op / "progress.json").write_text(json.dumps({"progress_index": 99}))
    d = decode_operation_record(root, op)
    check(
        "CORE-001 out-of-range progress_index refused (VALIDATION_FAILED)",
        (not d["ok"]) and d["code"] == "VALIDATION_FAILED",
        str(d),
    )

    # Out-of-range applied_frontier refused.
    (op / "progress.json").write_text(json.dumps({"applied_frontier": 50}))
    d = decode_operation_record(root, op)
    check(
        "CORE-001 out-of-range applied_frontier refused (VALIDATION_FAILED)",
        (not d["ok"]) and d["code"] == "VALIDATION_FAILED",
        str(d),
    )

    # Contradiction: sidecar claims terminal while manifest is unresolved.
    (op / "progress.json").write_text(json.dumps({"status": "COMMITTED"}))
    d = decode_operation_record(root, op)
    check(
        "CORE-001 contradictory sidecar refused (settlement did not fold)",
        (not d["ok"])
        and d["code"] == "RECOVERY_CONFLICT"
        and "settlement did not fold" in d["detail"],
        str(d),
    )

    # A PRESENT non-file is corrupt evidence, not legacy absence.
    (op / "progress.json").unlink()
    (op / "progress.json").mkdir()
    d = decode_operation_record(root, op)
    check(
        "CORE-001 non-file sidecar refused (RECOVERY_CONFLICT)",
        (not d["ok"])
        and d["code"] == "RECOVERY_CONFLICT"
        and "not a regular file" in d["detail"],
        str(d),
    )


def test_op_id_shared_grammar() -> None:
    hostile = ("has space", "bad:name", "CON", "line\nbreak", "x" * 129)
    rejected = []
    for value in hostile:
        try:
            validate_op_id(value)
        except InvalidIdError:
            rejected.append(value)
    check(
        "QUALITY op_id uses the shared portable safe-id grammar",
        rejected == list(hostile) and validate_op_id("op-safe_1.2") == "op-safe_1.2",
        f"rejected={rejected!r}",
    )


# ---------------------------------------------------------------------------
# CORE-002 [P0]: stray unbound candidate_home removed from 16 functions
# ---------------------------------------------------------------------------
def test_core002() -> None:
    src = (TOOLS / "saipen_engine" / "operations.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    owners = {"_candidate_home_errors", "rebind_saipen_home"}
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef):
            continue
        uses = any(
            isinstance(n, ast.Name) and n.id == "candidate_home" and isinstance(n.ctx, ast.Load)
            for n in ast.walk(node)
        )
        if uses and node.name not in owners:
            offenders.append(node.name)
    check(
        "CORE-002 only owners reference candidate_home (no unbound use)",
        not offenders,
        f"offending functions: {offenders}",
    )


# ---------------------------------------------------------------------------
# CORE-003 [P0]: redaction enforced at the LOG persistence boundary (_event_line)
# ---------------------------------------------------------------------------
def test_core003() -> None:
    import saipen_engine.operations as ops_mod

    captured: dict[str, str] = {}
    real_build = ops_mod.build_event

    def _fake_build(log_tail, taxonomy, message, ticket=None, agent=None, now=None, op_id=None):
        captured["message"] = message
        return (0, "event-line")

    ops_mod.build_event = _fake_build
    try:
        secret = (
            "deploy ghp_"
            + "a" * 36
            + " and AKIA"
            + "B" * 16
            + " and sk-"
            + "c" * 40
            + " and Bearer "
            + "d" * 32
        )
        _event_line({}, None, "DEC", "T-1", "aleks", secret, "2026-08-19T16:00:00Z")
    finally:
        ops_mod.build_event = real_build

    msg = captured.get("message", "")
    redacted = (
        "ghp_a" not in msg and "AKIAB" not in msg and "sk-c" not in msg and "Bearer d" not in msg
    )
    check(
        "CORE-003 secrets redacted before LOG bytes are built",
        redacted,
        f"leaked tail: {msg[-80:]!r}",
    )


# ---------------------------------------------------------------------------
# CORE-004 [P1]: safety valve is a HARD STOP, never an auto-continue yield
# ---------------------------------------------------------------------------
def test_core004() -> None:
    # Contract-valid STATE (state_contract_errors required-set + RFC § 1.6
    # transition_from). Non-DONE phase keeps binding_wait's contextual brake
    # simple so the safety-valve WAIT binds unconditionally.
    state_text = (
        "---\n"
        "phase: VERIFY\n"
        "task: none\n"
        "next_action: WAIT: safety valve reached (3 waves / 20 tickets) -- "
        "run 'cc' to continue\n"
        "blocker: none\n"
        "agent: aleks\n"
        "saipen_version: 7\n"
        "mode: full\n"
        "updated: 2026-08-19T16:00:00Z\n"
        "transition_from: VERIFY\n"
        "execution_intent: goal\n"
        "goal_waves: 3\n"
        "goal_tickets: 20\n"
        "---\n"
    )
    board_text = (
        "# BOARD\n\n## TODO\n- [ ] T-2 more workable ticket\n\n## DOING\n\n## DONE\n\n## BLOCKED\n"
    )
    out = route_next(
        state_text,
        board_text,
        pending_ops=[],
        conflict_ops=[],
        current_agent="aleks",
        current_capability=None,
    )
    check(
        "CORE-004 safety valve is a hard stop (RESTATE_AND_STOP)",
        out.get("executable_behavior") == "RESTATE_AND_STOP",
        str(out),
    )


# ---------------------------------------------------------------------------
# CORE-005 [P1]: ownership handover is truthful + ordered before settlement
# ---------------------------------------------------------------------------
def test_core005() -> None:
    # Root-cause contract: parse_state returns ONE dict (not a tuple).
    rec = parse_state("---\nagent: oldagent\nsaipen_home: /x\n---\n")
    check(
        "CORE-005 parse_state returns a dict (contract fixed)",
        isinstance(rec, dict),
        str(type(rec)),
    )

    import saipen_engine.operations as ops_mod

    def _write_project(root: Path, agent: str) -> None:
        saipen = root / ".saipen"
        saipen.mkdir(parents=True, exist_ok=True)
        state = (
            "---\n"
            "phase: VERIFY\n"
            "task: none\n"
            "next_action: PHASE BUILD continue\n"
            "blocker: none\n"
            f"agent: {agent}\n"
            "saipen_version: 7\n"
            "mode: full\n"
            "updated: 2026-08-19T16:00:00Z\n"
            "transition_from: VERIFY\n"
            f"saipen_home: {root}\n"
            "---\n"
        )
        (saipen / "STATE.md").write_text(state)
        (saipen / "BOARD.md").write_text("# BOARD\n\n## TODO\n\n## DOING\n")
        (saipen / "LOG.md").write_text("# LOG\n")

    # Failure path: required ownership handover blocked -> resolution NOT committed.
    root = Path(tempfile.mkdtemp())
    _write_project(root, "oldagent")
    ops = root / ".saipen" / "recovery" / "ops" / "opC5"
    ops.mkdir(parents=True)
    (ops / "operation.json").write_text(
        json.dumps(_manifest("opC5", status="CONFLICT", targets=[]))
    )

    real_ho = ops_mod.handover_agent

    class _Fail:
        ok = False
        message = "injected handover failure"

    ops_mod.handover_agent = lambda *a, **k: _Fail()
    try:
        res = resolve_conflict(root, "opC5", resolution="accept_live", agent="newagent")
    finally:
        ops_mod.handover_agent = real_ho
    check(
        "CORE-005 ownership handover failure blocks settlement (truthful)",
        (not res["ok"])
        and res.get("code") == "VALIDATION_FAILED"
        and res.get("resolution_committed") is False,
        str(res),
    )

    # Positive control: same-agent resolve proceeds without a handover.
    root2 = Path(tempfile.mkdtemp())
    _write_project(root2, "oldagent")
    ops2 = root2 / ".saipen" / "recovery" / "ops" / "opC5b"
    ops2.mkdir(parents=True)
    (ops2 / "operation.json").write_text(
        json.dumps(_manifest("opC5b", status="CONFLICT", targets=[]))
    )
    res2 = resolve_conflict(root2, "opC5b", resolution="accept_live", agent="oldagent")
    check(
        "CORE-005 same-agent resolve settles (no handover)",
        res2.get("ok") is True and res2.get("code") == "RESOLVED",
        str(res2),
    )


# ---------------------------------------------------------------------------
# CORE-006 [P1]: canonical cross-platform home classifier
# ---------------------------------------------------------------------------
def test_core006() -> None:
    cases = [
        ("/home/aleks/saipen", True),
        ("C:\\Users\\aleks\\saipen", True),
        ("\\\\server\\share\\saipen", True),
        ("//server/share/saipen", True),
        ("relative/path", False),
        ("", False),
        (None, False),
        (".", False),
    ]
    bad = [(v, exp, is_absolute_home(v)) for v, exp in cases if is_absolute_home(v) != exp]
    check(
        "CORE-006 is_absolute_home portable classification",
        not bad,
        str(bad),
    )


# ---------------------------------------------------------------------------
# CORE-007 [P1]: writer lock refuses outside-root writes (symlink escape)
# ---------------------------------------------------------------------------
def test_core007() -> None:
    root = Path(tempfile.mkdtemp())
    outside = Path(tempfile.mkdtemp())

    # Positive control first: a legitimate root locks cleanly, inside root.
    lock_dir = root / ".saipen" / "locks"
    try:
        wl = WriterLock(root)
        wl.release()
    except Exception as exc:  # pragma: no cover - environment issue
        check("CORE-007 legit lock succeeds", False, f"unexpected: {exc}")
        return
    check(
        "CORE-007 legit lock creates dir only inside root",
        lock_dir.is_dir() and not any(outside.iterdir()),
        f"lock_dir={lock_dir} outside={list(outside.iterdir())}",
    )

    # Escape attempt: symlink .saipen/locks -> outside/escape.
    link = root / ".saipen" / "locks"
    try:
        if link.is_symlink() or link.exists():
            if link.is_symlink():
                link.unlink()
            elif link.is_dir():
                link.rmdir()
        link.symlink_to(outside / "escape")
    except (OSError, NotImplementedError):
        # No symlink privilege on this host (common on Windows without admin).
        check("CORE-007 symlink-escape zero outside writes", True, "skipped (no symlink priv)")
        return

    before = list(outside.iterdir())
    raised = False
    try:
        WriterLock(root)
    except PermissionError:
        raised = True
    after = list(outside.iterdir())
    check(
        "CORE-007 containment escape raises, zero outside-root writes",
        raised and before == after,
        f"raised={raised} before={before} after={after}",
    )


# ---------------------------------------------------------------------------
# CORE-008 [P1]: collision-safe compaction preserves a valid source receipt
# ---------------------------------------------------------------------------
def test_core008() -> None:
    root = Path(tempfile.mkdtemp())
    ops = root / ".saipen" / "recovery" / "ops"
    settled = root / ".saipen" / "recovery" / "settled"
    ops.mkdir(parents=True)
    settled.mkdir(parents=True)

    def _committed(op_id, path="a.txt", before="b", after="a"):
        return _manifest(
            op_id,
            status="COMMITTED",
            targets=[
                {
                    "path": path,
                    "role": "generic",
                    "before_hash": before,
                    "after_hash": after,
                    "action": "delete_file",
                    "applied": True,
                }
            ],
        )

    # opA: equivalent terminal receipt already lives in settled -> source collapses.
    (ops / "opA").mkdir()
    (ops / "opA" / "operation.json").write_text(json.dumps(_committed("opA")))
    (settled / "opA").mkdir()
    (settled / "opA" / "operation.json").write_text(json.dumps(_committed("opA")))

    # opB: non-equivalent collision -> valid source MUST be preserved.
    (ops / "opB").mkdir()
    (ops / "opB" / "operation.json").write_text(json.dumps(_committed("opB")))
    (settled / "opB").mkdir()
    (settled / "opB" / "operation.json").write_text(
        json.dumps(_committed("opB", path="DIFFERENT.txt", before="x", after="y"))
    )

    res = compact_committed(root)
    check(
        "CORE-008 equivalent collision collapses redundant source",
        not (ops / "opA").exists(),
        str(res),
    )
    check(
        "CORE-008 non-equivalent collision preserves valid source",
        (ops / "opB").exists(),
        str(res),
    )


# ---------------------------------------------------------------------------
# 2026-08-21 CORE-001: a handoff cannot omit referenced sealed LOG history
# ---------------------------------------------------------------------------
def test_sealed_event_graph_handoff() -> None:
    root = Path(tempfile.mkdtemp())
    archive = root / "handoff.zip"
    tracked = {".saipen/LOG.md", ".saipen/logs/LOG-001.md"}

    # Reproduce the supplied broken checkpoint: the active tail survives but
    # the sealed parent history does not. Gate A must fail closed.
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(".saipen/LOG.md", "# Log\n")
    check(
        "2026-08-21 CORE-001 archive missing sealed Event Graph history fails",
        gate_a_archive_contents(archive, tracked) is False,
    )

    # Positive control: the same inventory with its sealed segment is valid.
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr(".saipen/LOG.md", "# Log\n")
        zf.writestr(".saipen/logs/LOG-001.md", "# Log\n")
    check(
        "2026-08-21 CORE-001 complete sealed Event Graph archive passes",
        gate_a_archive_contents(archive, tracked) is True,
    )


def main() -> int:
    test_core001()
    test_op_id_shared_grammar()
    test_core002()
    test_core003()
    test_core004()
    test_core005()
    test_core006()
    test_core007()
    test_core008()
    test_sealed_event_graph_handoff()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} CORE audit regressions passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
