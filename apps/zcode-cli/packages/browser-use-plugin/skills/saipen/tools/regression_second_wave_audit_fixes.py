"""Focused regression tests for the SAIPEN AUDIT SECOND WAVE fixes (W2-001..W2-004).

Each ticket's VERIFY section is pinned to a deterministic, side-effect-free
assertion so the audit gate ("implement W2-001..W2-004 + no new failures") is
machine-checkable on a full checkout.

Run standalone:
    python tools/test_second_wave_audit_fixes.py

Exit code 0 when every assertion passes; 1 on the first failure batch.
"""

from __future__ import annotations

import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import saipen as cli  # noqa: E402  (the CLI module under test)
from saipen_engine import operations as OPS  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    goal_entry,
    handover_agent,
    set_goal_intent,
)
from saipen_engine.fast_check import validate_texts  # noqa: E402
from saipen_engine.state import parse_state  # noqa: E402

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL"), name, ("" if cond else f"-- {detail}"))


def _sp(root: Path) -> Path:
    saipen = root / ".saipen"
    saipen.mkdir(parents=True, exist_ok=True)
    return saipen


def _write_project(
    root: Path,
    agent: str,
    todo_lines: tuple[str, ...] = (),
    doing_lines: tuple[str, ...] = (),
    phase: str = "DONE",
    task: str = "none",
) -> None:
    """Write a minimal but contract-valid SAIPEN checkpoint. saipen_home is the
    temp project dir itself (absolute + existing) so the home gate stays quiet
    without needing the running install root."""
    sp = _sp(root)
    board = "# BOARD\n\n"
    board += "## TODO\n" + "".join(todo_lines) + "\n"
    board += "\n## DOING\n" + "".join(doing_lines) + "\n"
    board += "\n## DONE\n\n## BLOCKED\n"
    state = (
        "---\n"
        f"phase: {phase}\n"
        f"task: {task}\n"
        "next_action: saipen continue\n"
        "blocker: none\n"
        f"agent: {agent}\n"
        "saipen_version: 7\n"
        "mode: full\n"
        f"updated: 2026-08-19T16:00:00Z\n"
        f"transition_from: {phase}\n"
        # A RELATIVE (non-absolute) saipen_home keeps the home gate quiet for an
        # isolated temp fixture: persisted_home_error only judges ABSOLUTE
        # pointers, and a relative value is legacy/unverifiable (returns None),
        # so no real install BOOT.md is required and no history-ownership gate
        # is exercised. It must still be a string (parse_state requires it).
        "saipen_home: fixture-home\n"
        "---\n"
    )
    (sp / "STATE.md").write_text(state)
    (sp / "BOARD.md").write_text(board)
    (sp / "LOG.md").write_text("# LOG\n")


def _state(root: Path) -> dict:
    return parse_state((root / ".saipen" / "STATE.md").read_text(encoding="utf-8"))


def _board_text(root: Path) -> str:
    return (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")


def _log_text(root: Path) -> str:
    return (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")


def _run_cli(root: Path, *args: str) -> int:
    """Invoke the CLI main with --project-root pinned to root; resets the
    module-global agent override afterwards so tests stay hermetic."""
    cli._AGENT_OVERRIDE = None
    try:
        return cli.main([*args, "--project-root", str(root)])
    finally:
        cli._AGENT_OVERRIDE = None


def _files_unchanged(root: Path, snap: dict) -> bool:
    return (
        (root / ".saipen" / "STATE.md").read_bytes() == snap["state"]
        and (root / ".saipen" / "BOARD.md").read_bytes() == snap["board"]
        and (root / ".saipen" / "LOG.md").read_bytes() == snap["log"]
    )


def _snap(root: Path) -> dict:
    return {
        "state": (root / ".saipen" / "STATE.md").read_bytes(),
        "board": (root / ".saipen" / "BOARD.md").read_bytes(),
        "log": (root / ".saipen" / "LOG.md").read_bytes(),
    }


# ---------------------------------------------------------------------------
# W2-001 [P1]: a semantically rejected different-agent command is ZERO-WRITE
# (no orphaned handover DEC, no STATE.agent churn); a valid one changes the
# seat exactly once with a single deterministic DEC.
# ---------------------------------------------------------------------------
def test_w2001() -> None:
    # --- (a) rejected different-agent claim -> zero write -----------------
    root = Path(tempfile.mkdtemp())
    _write_project(root, "oldagent", todo_lines=("- [ ] T-1 [P1] backlog work\n",))
    before = _snap(root)
    rc = _run_cli(root, "--agent", "boundary-new", "claim", "T-DOES-NOT-EXIST")
    check("W2-001 rejected different-agent claim returns failure", rc == 1, f"rc={rc}")
    check(
        "W2-001 rejected claim is zero-write (no handover/seat churn)",
        _files_unchanged(root, before) and _state(root).get("agent") == "oldagent",
        f"agent={_state(root).get('agent')} loglines={_log_text(root).count(chr(10))}",
    )

    # --- (b) valid different-agent claim -> seat changes exactly once ------
    root2 = Path(tempfile.mkdtemp())
    _write_project(root2, "oldagent", todo_lines=("- [ ] T-1 [P1] backlog work\n",))
    rc = _run_cli(root2, "--agent", "boundary-new", "claim", "T-1")
    st = _state(root2)
    check("W2-001 valid different-agent claim succeeds", rc == 0, f"rc={rc}")
    check(
        "W2-001 valid claim changes seat exactly once",
        st.get("agent") == "boundary-new",
        f"agent={st.get('agent')}",
    )
    # Exactly one new DEC was appended (the claim DEC), no separate handover DEC.
    new_dec = _log_text(root2).count("DEC")  # legacy-free count: each DEC line has 'DEC'
    check(
        "W2-001 valid claim appends exactly one DEC (folded handover)",
        new_dec == 1,
        f"DEC count={new_dec}",
    )
    check(
        "W2-001 valid claim binds the live active DOING to the new seat",
        "boundary-new" in _board_text(root2).split("## DOING")[1].split("## DONE")[0],
        _board_text(root2).split("## DOING")[1][:120],
    )

    # --- (c) repeat failed command after restart -> no accumulation --------
    root3 = Path(tempfile.mkdtemp())
    _write_project(root3, "oldagent", todo_lines=("- [ ] T-1 [P1] backlog work\n",))
    b1 = _snap(root3)
    _run_cli(root3, "--agent", "boundary-new", "claim", "T-NOPE")
    after_first = _log_text(root3)
    _run_cli(root3, "--agent", "boundary-new", "claim", "T-NOPE")  # restart, same bad cmd
    check(
        "W2-001 repeated failed command accumulates no handover events",
        _log_text(root3) == after_first and _files_unchanged(root3, b1),
        f"log1={after_first.count(chr(10))} log2={_log_text(root3).count(chr(10))}",
    )

    # --- (d) other rejected different-agent commands -> zero write --------
    root4 = Path(tempfile.mkdtemp())
    _write_project(root4, "oldagent", todo_lines=("- [ ] T-1 [P1] backlog work\n",))
    b4 = _snap(root4)
    rc_bad = _run_cli(root4, "--agent", "boundary-new", "transition", "NOTAPHASE")
    rc_ship = _run_cli(root4, "--agent", "boundary-new", "ship")
    check(
        "W2-001 illegal transition is rejected + zero-write",
        rc_bad == 1 and _files_unchanged(root4, b4),
        f"rc={rc_bad}",
    )
    check(
        "W2-001 ship with no active ticket is rejected + zero-write",
        rc_ship == 1 and _files_unchanged(root4, b4),
        f"rc={rc_ship}",
    )


# ---------------------------------------------------------------------------
# W2-002 [P1]: handover_agent is active-claim-aware -- transfer a live active
# DOING claim to the new seat atomically, or refuse (zero-write) a foreign/
# invalid active claim. STATE.agent must never diverge from the live claim.
# ---------------------------------------------------------------------------
def test_w2002() -> None:
    # --- (a) no active ticket -> STATE.agent change only -------------------
    root = Path(tempfile.mkdtemp())
    _write_project(root, "oldagent")
    res = handover_agent(root, "newseat")
    check("W2-002 no-active-ticket handover succeeds", res.ok, str(res))
    check(
        "W2-002 no-active-ticket: seat changed, board untouched",
        _state(root).get("agent") == "newseat" and _board_text(root).count("owner:") == 0,
        str(res),
    )

    # --- (b) active SELF claim -> atomically transferred -------------------
    root2 = Path(tempfile.mkdtemp())
    _write_project(
        root2,
        "oldagent",
        doing_lines=(
            "- [/] T-1 [P1] active work | owner: oldagent | claim_time: 2026-08-19T16:00:00Z\n",
        ),
        phase="SCOUT",
        task="T-1",
    )
    res = handover_agent(root2, "newseat")
    check("W2-002 active SELF claim handover succeeds", res.ok, str(res))
    bt = _board_text(root2)
    doing = bt.split("## DOING")[1].split("## DONE")[0]
    check(
        "W2-002 active SELF claim transferred to new seat", "owner: newseat" in doing, doing[:160]
    )
    check("W2-002 active SELF: seat + claim stay bound", _state(root2).get("agent") == "newseat")
    errs = validate_texts(
        _state(root2).get("phase") and _read_state_text(root2),
        bt,
        _log_text(root2),
        current_agent="newseat",
    )
    check("W2-002 active SELF: post-handover state validates clean", not errs, str(errs))

    # --- (c) active FOREIGN_LIVE -> refuse (zero write) --------------------
    # A LIVE foreign claim needs a claim_time INSIDE the 15-minute liveness
    # window; a stale one is FOREIGN_STALE (lapsed) and is adopted, not refused.
    root3 = Path(tempfile.mkdtemp())
    recent = (datetime.now(timezone.utc) - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    _write_project(
        root3,
        "oldagent",
        doing_lines=(f"- [/] T-1 [P1] active work | owner: other | claim_time: {recent}\n",),
        phase="SCOUT",
        task="T-1",
    )
    b3 = _snap(root3)
    res = handover_agent(root3, "newseat")
    check(
        "W2-002 active FOREIGN_LIVE refused",
        (not res.ok) and res.code == "ACTIVE_CLAIM_FOREIGN",
        str(res),
    )
    check("W2-002 active FOREIGN_LIVE is zero-write", _files_unchanged(root3, b3), str(res))

    # --- (d) active INVALID claim (half pair) -> refuse --------------------
    root4 = Path(tempfile.mkdtemp())
    _write_project(
        root4,
        "oldagent",
        doing_lines=("- [/] T-1 [P1] active work | owner: oldagent\n",),  # no claim_time
        phase="SCOUT",
        task="T-1",
    )
    b4 = _snap(root4)
    res = handover_agent(root4, "newseat")
    check(
        "W2-002 active INVALID claim refused",
        (not res.ok) and res.code == "VALIDATION_FAILED",
        str(res),
    )
    check("W2-002 active INVALID is zero-write", _files_unchanged(root4, b4), str(res))

    # --- (e) active FOREIGN_STALE -> transferred (lapsed claim) ------------
    root5 = Path(tempfile.mkdtemp())
    _write_project(
        root5,
        "oldagent",
        doing_lines=(
            "- [/] T-1 [P1] active work | owner: other | claim_time: 2020-01-01T00:00:00Z\n",
        ),
        phase="SCOUT",
        task="T-1",
    )
    res = handover_agent(root5, "newseat")
    check("W2-002 active FOREIGN_STALE handed over (claim adopted by new seat)", res.ok, str(res))
    doing5 = _board_text(root5).split("## DOING")[1].split("## DONE")[0]
    check(
        "W2-002 FOREIGN_STALE claim now owned by new seat", "owner: newseat" in doing5, doing5[:160]
    )


def _read_state_text(root: Path) -> str:
    return (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# W2-003 [P1]: goal_entry actually plans/prioritizes/persists the objective and
# records the Entry PLAN exactly once (goal_waves == 1).
# ---------------------------------------------------------------------------
def test_w2003() -> None:
    # --- (a) empty board -> objective planned, Entry PLAN wave 1 -----------
    root = Path(tempfile.mkdtemp())
    _write_project(root, "oldagent")
    res = goal_entry(root, "oldagent", "Ship the v8 release to production")
    check("W2-003 empty board goal entry succeeds", res.ok, str(res))
    st = _state(root)
    check(
        "W2-003 Entry PLAN recorded exactly once (goal_waves==1)",
        st.get("goal_waves") == 1,
        f"goal_waves={st.get('goal_waves')}",
    )
    check(
        "W2-003 goal_tickets counts VERIFY passes only",
        st.get("goal_tickets") == 0,
        f"goal_tickets={st.get('goal_tickets')}",
    )
    log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
    check(
        "W2-003 Entry PLAN wave bump is recoverable from LOG",
        "DEC: goal_waves 0->1" in log,
        log[-300:],
    )
    check(
        "W2-003 next_action targets the new objective",
        str(st.get("next_action", "")).startswith("PHASE SCOUT"),
        f"na={st.get('next_action')}",
    )

    # --- (b) old TODO backlog -> new plan tickets outrank old -------------
    root2 = Path(tempfile.mkdtemp())
    _write_project(root2, "oldagent", todo_lines=("- [ ] T-1 [P1] old backlog item\n",))
    res = goal_entry(root2, "oldagent", "Refactor the parser module")
    check("W2-003 goal entry over existing backlog succeeds", res.ok, str(res))
    bt = _board_text(root2)
    doing = bt.split("## DOING")[1].split("## DONE")[0]
    todo = bt.split("## TODO")[1].split("## DOING")[0]
    # W2-003: the FIRST plan ticket is promoted into DOING (SCOUT claim) and the
    # pre-existing backlog is preserved in TODO (no deletion, outranked by the
    # new objective's plan). With a single-step objective the only remaining
    # TODO line is the old backlog; the new plan ticket lives in DOING.
    check(
        "W2-003 first plan ticket promoted to DOING as SCOUT claim",
        "owner: oldagent" in doing,
        doing[:200],
    )
    check(
        "W2-003 generated goal ticket carries durable verify evidence",
        "| verify:" in doing,
        doing[:240],
    )
    check("W2-003 old backlog preserved in TODO (no deletion)", "T-1" in todo, todo[:200])
    check(
        "W2-003 goal_waves==1 with backlog",
        _state(root2).get("goal_waves") == 1,
        f"goal_waves={_state(root2).get('goal_waves')}",
    )

    # --- (c) active DOING + old TODO -> checkpointed, planned, bound -------
    root3 = Path(tempfile.mkdtemp())
    _write_project(
        root3,
        "oldagent",
        todo_lines=("- [ ] T-2 [P1] old backlog item\n",),
        doing_lines=(
            "- [/] T-1 [P1] in-progress | owner: oldagent | claim_time: 2026-08-19T16:00:00Z\n",
        ),
        phase="SCOUT",
        task="T-1",
    )
    res = goal_entry(root3, "oldagent", "Pivot to the new roadmap")
    check("W2-003 goal entry with active DOING succeeds", res.ok, str(res))
    bt3 = _board_text(root3)
    doing3 = bt3.split("## DOING")[1].split("## DONE")[0]
    todo3 = bt3.split("## TODO")[1].split("## DOING")[0]
    check(
        "W2-003 active DOING checkpointed (no longer in DOING)", "T-1" not in doing3, doing3[:160]
    )
    check(
        "W2-003 checkpointed ticket demoted without owner loss of claim fields",
        "T-1" in todo3 and "owner: oldagent" not in todo3,
        todo3[:200],
    )
    st3 = _state(root3)
    check(
        "W2-003 goal_waves==1 (active DOING case)",
        st3.get("goal_waves") == 1,
        f"goal_waves={st3.get('goal_waves')}",
    )
    # first plan ticket promoted to DOING, owned by the acting agent
    check(
        "W2-003 first plan ticket promoted to DOING bound to agent",
        "owner: oldagent" in doing3,
        doing3[:200],
    )

    # --- (d) crash/restart safety: re-run from the SAME checkpoint -> identical
    # (a crash BEFORE commit leaves the pre-goal files byte-identical, so a
    # restarted goal_entry must produce the SAME result with no accumulation).
    root4 = Path(tempfile.mkdtemp())
    _write_project(root4, "oldagent", todo_lines=("- [ ] T-1 [P1] old backlog\n",))
    snap_pre = _snap(root4)
    res1 = goal_entry(root4, "oldagent", "Stable objective for restart test")
    plan_count = _board_text(root4).count("- [ ] T-")  # plan ticket + old backlog
    waves = _state(root4).get("goal_waves")
    check("W2-003 restart: first goal entry succeeds", res1.ok, str(res1))
    # Simulate the crash: restore the pre-goal checkpoint, then re-run.
    (root4 / ".saipen" / "STATE.md").write_bytes(snap_pre["state"])
    (root4 / ".saipen" / "BOARD.md").write_bytes(snap_pre["board"])
    (root4 / ".saipen" / "LOG.md").write_bytes(snap_pre["log"])
    res2 = goal_entry(root4, "oldagent", "Stable objective for restart test")
    check("W2-003 restart: re-entry from same checkpoint succeeds", res2.ok, str(res2))
    check(
        "W2-003 restart: Entry PLAN wave stable (==1, not double-incremented)",
        _state(root4).get("goal_waves") == waves == 1,
        f"waves={_state(root4).get('goal_waves')}",
    )
    check(
        "W2-003 restart: plan ticket count identical (no accumulation)",
        _board_text(root4).count("- [ ] T-") == plan_count,
        f"count={_board_text(root4).count('- [ ] T-')}",
    )

    # --- (e) multi-clause plans reserve one unique monotonic ID block -----
    root5 = Path(tempfile.mkdtemp())
    _write_project(root5, "oldagent", todo_lines=("- [ ] T-7 [P1] old backlog\n",))
    before5 = _snap(root5)
    dry = goal_entry(root5, "oldagent", "First step; Second step; Third step", dry_run=True)
    check(
        "W2-003 multi-clause dry-run allocates distinct ordered ticket IDs",
        dry.ok and dry.get("plan_tickets") == ["T-8", "T-9", "T-10"],
        str(dry),
    )
    check(
        "W2-003 multi-clause dry-run is zero-write",
        _files_unchanged(root5, before5),
        str(dry),
    )
    applied = goal_entry(root5, "oldagent", "First step; Second step; Third step")
    board5 = _board_text(root5)
    check(
        "W2-003 multi-clause apply persists three unique ticket IDs",
        applied.ok
        and applied.get("plan_tickets") == ["T-8", "T-9", "T-10"]
        and all(board5.count(ticket_id) == 1 for ticket_id in ("T-8", "T-9", "T-10")),
        str(applied),
    )
    check(
        "W2-003 multi-clause apply preserves plan order and claims the first",
        board5.index("T-9") < board5.index("T-10")
        and _state(root5).get("task") == "T-8"
        and "T-8" in board5.split("## DOING", 1)[1].split("## DONE", 1)[0],
        board5[:500],
    )

    # --- (f) defensive duplicate allocator output refuses before writes ---
    root6 = Path(tempfile.mkdtemp())
    _write_project(root6, "oldagent", todo_lines=("- [ ] T-1 [P1] backlog\n",))
    before6 = _snap(root6)
    with mock.patch.object(OPS, "_goal_plan_ticket_ids", return_value=["T-2", "T-2"]):
        duplicate = goal_entry(root6, "oldagent", "First step; Second step")
    check(
        "W2-003 duplicate goal plan IDs are rejected",
        (not duplicate.ok) and duplicate.code == "VALIDATION_FAILED",
        str(duplicate),
    )
    check(
        "W2-003 duplicate goal plan rejection is zero-write",
        _files_unchanged(root6, before6),
        str(duplicate),
    )


# ---------------------------------------------------------------------------
# W2-004 [P2]: one shared objective validator -- blank/whitespace/normalized
# empty objectives are ZERO-WRITE; valid text is accepted. A different --agent
# with a blank goal proves W2-001 (no ownership side effect).
# ---------------------------------------------------------------------------
def test_w2004() -> None:
    cases = {
        "empty": "",
        "spaces": "   ",
        "tabs_newlines": "\t\n  ",
    }
    for label, obj in cases.items():
        root = Path(tempfile.mkdtemp())
        _write_project(root, "oldagent", todo_lines=("- [ ] T-1 [P1] backlog\n",))
        b = _snap(root)
        res = goal_entry(root, "oldagent", obj)
        check(
            f"W2-004 {label} objective refused",
            (not res.ok) and res.code == "INVALID_GOAL",
            str(res),
        )
        check(f"W2-004 {label} objective is zero-write", _files_unchanged(root, b), str(res))

    # set_goal_intent primitive also refuses blank.
    root_p = Path(tempfile.mkdtemp())
    _write_project(root_p, "oldagent")
    b_p = _snap(root_p)
    res_p = set_goal_intent(root_p, "oldagent", "   ")
    check(
        "W2-004 set_goal_intent blank refused",
        (not res_p.ok) and res_p.code == "INVALID_GOAL",
        str(res_p),
    )
    check("W2-004 set_goal_intent blank zero-write", _files_unchanged(root_p, b_p), str(res_p))

    # Different --agent + blank goal -> W2-001 fix prevents ownership side effect.
    root_a = Path(tempfile.mkdtemp())
    _write_project(root_a, "oldagent", todo_lines=("- [ ] T-1 [P1] backlog\n",))
    b_a = _snap(root_a)
    rc_a = _run_cli(root_a, "--agent", "boundary-new", "goal", "   ")
    check(
        "W2-004 different-agent blank goal is zero-write (no handover)",
        rc_a == 2 and _files_unchanged(root_a, b_a) and _state(root_a).get("agent") == "oldagent",
        f"rc={rc_a} agent={_state(root_a).get('agent')}",
    )

    # Valid ordinary + unicode objective is accepted and persisted.
    root_v = Path(tempfile.mkdtemp())
    _write_project(root_v, "oldagent")
    res_v = goal_entry(root_v, "oldagent", "Deploy v8 to prod \U0001f680")
    check(
        "W2-004 valid objective accepted + planned",
        res_v.ok and _state(root_v).get("goal_waves") == 1,
        str(res_v),
    )


def main() -> int:
    test_w2001()
    test_w2002()
    test_w2003()
    test_w2004()

    passed = sum(1 for _, ok, _ in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} SECOND-WAVE audit regressions passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
