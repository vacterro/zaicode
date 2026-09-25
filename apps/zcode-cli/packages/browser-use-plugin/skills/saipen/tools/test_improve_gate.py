"""The parked operator gate holds automatic Improve discovery (T-1415).

THE INCIDENT THIS ORACLE IS BUILT FROM
--------------------------------------
Deterministic work reached DONE while a parked operator-only gate owned the
next real decision. The operator said once, in prose, "do not enter another
improve cycle before this gate" -- and prose is not routing. `continue`
answered idle-maintain, the Improve fallthrough prepared a cycle, and the
operator had to abort Improve cycles by hand while the real gate sat parked.

This oracle pins the typed replacement:

* `saipen improve hold <T-###>` persists `STATE.improve_gate` through the
  canonical operation layer, and `unhold` clears it;
* while the named gate is unresolved, `continue` routes to the gate / WAIT
  (`reason: improve-gate`) and never prepares an Improve cycle;
* executable Work still outranks the hold;
* a resolved or vanished gate clears deterministically;
* a parked ticket alone -- lower priority or externally blocked -- never
  suppresses Improve (no immortal residue).

Run standalone:
    python tools/test_improve_gate.py
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import reconcile  # noqa: E402
from saipen_engine.router import route_next  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"
GATE = "T-090"
GATE_BLOCKED_ROW = (
    f"- [ ] {GATE} [P1] operator gate parked for a decision | "
    "verify: the operator decides and the gate resolves | "
    "user_explicit: true | blocker: needs an operator decision before work resumes | "
    "blocker_scope: ticket\n"
)
LOW_PRIORITY_ROW = (
    "- [ ] T-091 [P3] unrelated low-priority parked work | "
    "verify: unrelated acceptance runs | blocker: waiting on a nice-to-have | "
    "blocker_scope: ticket\n"
)
EXTERNAL_ROW = (
    "- [ ] T-092 [P1] blocked on an external system not next for this mission | "
    "verify: external system answers | blocker: external dependency is silent | "
    "blocker_scope: ticket\n"
)


def _cli(project: Path, *args: str) -> tuple[int, dict]:
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT")
    }
    run = subprocess.run(
        [
            sys.executable,
            str(SAIPEN_PY),
            "--project-root",
            str(project),
            "--agent",
            "tester",
            "--json",
            *args,
        ],
        cwd=str(project),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=300,
        env=env,
    )
    blob = (run.stdout or "") + (run.stderr or "")
    try:
        return run.returncode, json.loads(blob)
    except json.JSONDecodeError:
        return run.returncode, {"ok": False, "code": "CLI_CRASH", "detail": blob[-800:]}


def _state_text(*, phase: str = "DONE", improve_gate: str | None = None) -> str:
    lines = [
        "---",
        f"phase: {phase}",
        "task: none",
        "next_action: saipen continue",
        'blocker: ""',
        "transition_from: SHIP",
        "saipen_version: 8",
        "schema_version: 3",
        "last_event: 1",
        "style_contract: ded-4ae736e4",
        "agent: tester",
        "requires:\n  - filesystem\n  - python",
        "mode: full",
        'updated: "2026-09-19T00:00:00Z"',
        "execution_intent: normal",
    ]
    if improve_gate:
        lines.append(f"improve_gate: {improve_gate}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def _board(*, doing: str = "", todo: str = "", blocked: str = "", done: str = "") -> str:
    return (
        "## DOING\n"
        f"{doing}"
        "## TODO\n"
        f"{todo}"
        "## DONE\n"
        f"{done}"
        "## BLOCKED\n"
        f"{blocked}"
    )


def _route(state_text: str, board_text: str) -> dict:
    return route_next(state_text, board_text, [], [])


class ImproveGateTests(unittest.TestCase):
    def setUp(self) -> None:
        config = tempfile.TemporaryDirectory(prefix="saipen-improve-gate-config-")
        self.addCleanup(config.cleanup)
        self._config_env = config

    def _make(
        self,
        *,
        board: str,
        improve_gate: str | None = None,
    ) -> Path:
        base = tempfile.mkdtemp(prefix="saipen-improve-gate-")
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = Path(base) / "project"
        (project / ".saipen").mkdir(parents=True)
        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        (project / ".saipen" / "STATE.md").write_text(
            _state_text(improve_gate=improve_gate).replace(
                "2026-09-19T00:00:00Z", now
            ),
            encoding="utf-8",
        )
        (project / ".saipen" / "BOARD.md").write_text(board, encoding="utf-8")
        (project / ".saipen" / "LOG.md").write_text(
            "# Log\n- 01.01.20 00:00 [E-001] [agent: tester] DEC: fixture\n",
            encoding="utf-8",
        )
        (project / "VERSION").write_text("8.0.1\n", encoding="utf-8")
        return project

    # ---- router priority (pure, cases A-F) --------------------------------
    def test_a_no_gate_no_work_is_ordinary_maintenance(self) -> None:
        routed = _route(_state_text(), _board())
        self.assertEqual(routed["reason"], "maintain", routed)

    def test_b_named_parked_gate_holds_improve(self) -> None:
        routed = _route(_state_text(improve_gate=GATE), _board(blocked=GATE_BLOCKED_ROW))
        self.assertEqual(routed["reason"], "improve-gate", routed)
        self.assertEqual(routed["executable_behavior"], "RESTATE_AND_STOP")
        self.assertEqual(routed["ticket"], GATE)

    def test_c_hold_stands_while_the_gate_is_unresolved(self) -> None:
        routed = _route(
            _state_text(improve_gate=GATE),
            _board(blocked=GATE_BLOCKED_ROW + LOW_PRIORITY_ROW),
        )
        self.assertEqual(routed["reason"], "improve-gate", routed)

    def test_d_resolved_gate_is_inert_even_before_the_clear_lands(self) -> None:
        done_gate = f"- [x] {GATE} [P1] gate resolved | verify: done | closure_mode: own_patch\n"
        routed = _route(_state_text(improve_gate=GATE), _board(done=done_gate))
        self.assertEqual(routed["reason"], "maintain", routed)

    def test_e_lower_priority_parked_ticket_alone_never_suppresses(self) -> None:
        routed = _route(_state_text(), _board(blocked=LOW_PRIORITY_ROW))
        self.assertEqual(routed["reason"], "maintain", routed)

    def test_f_external_blocked_ticket_alone_never_hijacks(self) -> None:
        routed = _route(_state_text(), _board(blocked=EXTERNAL_ROW))
        self.assertEqual(routed["reason"], "maintain", routed)

    def test_executable_work_outranks_the_hold(self) -> None:
        routed = _route(
            _state_text(improve_gate=GATE),
            _board(todo="- [ ] T-001 [P1] queued | verify: test\n", blocked=GATE_BLOCKED_ROW),
        )
        self.assertEqual(routed["action"], "PHASE SCOUT T-001", routed)

    # ---- deterministic clear (pure repair owner) ---------------------------
    def test_stale_gate_repairs_only_when_resolved(self) -> None:
        board_blocked = {"tickets": {GATE: {"section": "## BLOCKED"}}}
        board_done = {"tickets": {GATE: {"section": "## DONE"}}}
        board_gone = {"tickets": {}}
        state = {"improve_gate": GATE}
        self.assertEqual(reconcile._stale_improve_gate_repairs(state, board_blocked), [])
        for board in (board_done, board_gone):
            repairs = reconcile._stale_improve_gate_repairs(state, board)
            self.assertEqual(len(repairs), 1, repairs)
            self.assertEqual(repairs[0]["field"], "improve_gate")
            self.assertTrue(repairs[0]["remove"])
        self.assertEqual(reconcile._stale_improve_gate_repairs({}, board_done), [])

    # ---- public operations and CLI ----------------------------------------
    def test_hold_persists_typed_state_and_unhold_clears_it(self) -> None:
        project = self._make(board=_board(blocked=GATE_BLOCKED_ROW))
        rc, result = _cli(project, "improve", "hold", GATE, "operator", "policy")
        self.assertEqual(rc, 0, result)
        self.assertEqual(result["code"], "IMPROVE_GATE_SET", result)
        state = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertIn(f"improve_gate: {GATE}", state)
        log = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertIn(f"improve discovery held until {GATE} resolves", log)
        rc, cleared = _cli(project, "improve", "unhold")
        self.assertEqual(rc, 0, cleared)
        self.assertEqual(cleared["code"], "IMPROVE_GATE_CLEARED", cleared)
        state = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertNotIn("improve_gate", state)

    def test_hold_refuses_unknown_done_and_bad_gates(self) -> None:
        project = self._make(board=_board(blocked=GATE_BLOCKED_ROW))
        rc, unknown = _cli(project, "improve", "hold", "T-999")
        self.assertEqual(rc, 1, unknown)
        self.assertEqual(unknown["code"], "TICKET_NOT_FOUND", unknown)
        rc, bad = _cli(project, "improve", "hold", "not-a-ticket")
        self.assertEqual(rc, 1, bad)
        self.assertEqual(bad["code"], "VALIDATION_FAILED", bad)
        finished = self._make(
            board=_board(
                done="- [x] T-095 [P1] finished gate | verify: x | closure_mode: own_patch\n"
            )
        )
        rc, done = _cli(finished, "improve", "hold", "T-095")
        self.assertEqual(rc, 1, done)
        self.assertEqual(done["code"], "TICKET_ALREADY_DONE", done)

    def test_dry_run_hold_writes_nothing(self) -> None:
        project = self._make(board=_board(blocked=GATE_BLOCKED_ROW))
        before = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        rc, planned = _cli(project, "improve", "hold", GATE, "--dry-run")
        self.assertEqual(rc, 0, planned)
        self.assertEqual(planned["code"], "PLAN", planned)
        after = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertEqual(before, after)

    # ---- end-to-end: one cc never prepares Improve behind the gate ---------
    def test_continue_routes_to_gate_and_prepares_no_improve_cycle(self) -> None:
        project = self._make(board=_board(blocked=GATE_BLOCKED_ROW))
        rc, held = _cli(project, "improve", "hold", GATE)
        self.assertEqual(rc, 0, held)
        improver = project / ".saipen" / "improve"
        before = sorted(improver.iterdir()) if improver.is_dir() else []
        rc, routed = _cli(project, "cc")
        self.assertEqual(rc, 0, routed)
        self.assertEqual(routed.get("reason"), "improve-gate", routed)
        self.assertEqual(routed.get("ticket"), GATE, routed)
        self.assertNotEqual(routed.get("code"), "IMPROVE_AUDIT_ASSIGNMENT", routed)
        after = sorted(improver.iterdir()) if improver.is_dir() else []
        self.assertEqual(before, after, "a held gate must not prepare an Improve cycle")

    def test_unhold_restores_idle_improve_discovery(self) -> None:
        project = self._make(board=_board(blocked=GATE_BLOCKED_ROW))
        _cli(project, "improve", "hold", GATE)
        _cli(project, "improve", "unhold")
        rc, result = _cli(project, "cc")
        self.assertEqual(rc, 0, result)
        self.assertEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
