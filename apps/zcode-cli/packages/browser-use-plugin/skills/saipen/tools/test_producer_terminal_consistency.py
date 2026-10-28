"""T-1435 M4/M5: producer terminal consistency + owned reconciliation (SRC-090).

The measured incident: producer-owned roles (saitranslate, saiwiki) reported
`phase: DONE` while their own STATE still carried a live task or their own
BOARD still held open work. Core can detect the contradiction, but it must not
patch another producer's canonical files -- and the ship gate could only
refuse forever.

These regressions cover:

  M4  ONE side-effect-free terminal predicate (`subs.terminal_consistency`)
      with the closed truth table A-G, consumed by the validator's DONE branch
      so the classification and the FAIL text cannot drift.
  M5  the producer-owned reconciliation route `saipen sub reconcile <role>
      --authority SRC-###`: OUTCOME A clears stale residue on a terminal
      BOARD, OUTCOME B restores a truthful nonterminal projection and NEVER
      touches real open work; malformed surfaces, a foreign producer owner and
      a missing authority refuse with zero writes; a second run is a no-op.

Run standalone:
    python tools/test_producer_terminal_consistency.py
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.paths import unbound_environment  # noqa: E402
from saipen_engine import remediation  # noqa: E402
from saipen_engine.subs import (  # noqa: E402
    parse_sub_board,
    terminal_consistency,
    validate_sub_lifecycle,
)
from test_hermetic_env import isolate_host_session  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"
VALIDATE_PY = TOOLS / "validate.py"
SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"
SUBS_REL = ".saipen/extensions/subs"

STATE = f"""---
phase: DONE
task: none
next_action: "PHASE DONE"
blocker: none
transition_from: DONE
saipen_version: 8
schema_version: 3
last_event: 2
style_contract: ded-4ae736e4
saipen_home: "{ROOT}"
agent: tester
mode: full
updated: "2026-09-21T00:00:00Z"
---
"""

LOG = (
    "- 21.09.26 00:00 [E-001] [T-900] RUN: historical build finished\n"
    "- 21.09.26 00:01 [E-002] [T-900] DEC: historical completion\n"
)

BOARD = (
    "# Board\n"
    "## DOING\n"
    "## TODO\n"
    "## DONE\n"
    "- [x] T-900 [P1] historical row | verify: proof | owner: tester | "
    "claim_time: 2026-09-08T06:45:00Z\n"
    "## BLOCKED\n"
)


def setUpModule() -> None:
    isolate_host_session()


def _sub_state(
    *,
    phase: str = "DONE",
    task: str = "none",
    agent: str = "saiwiki",
    blocker: str = "",
    next_action: str = "PHASE DONE",
    transition_from: str = "DONE",
    role_revision: str = "",
) -> str:
    return (
        "---\n"
        f"phase: {phase}\n"
        f'task: "{task}"\n'
        f'next_action: "{next_action}"\n'
        f'blocker: "{blocker}"\n'
        f"agent: {agent}\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        "style_contract: ded-4ae736e4\n"
        f'saipen_home: "{ROOT}"\n'
        "mode: read-only\n"
        f"transition_from: {transition_from}\n"
        f'role_revision: "{role_revision}"\n'
        "updated: 2026-09-21T00:00:00Z\n"
        "---\n"
    )


def _sub_board(doing: str = "", todo: str = "", blocked: str = "") -> str:
    lines = ["# Board", "## DOING"]
    if doing:
        lines.append(doing)
    lines.append("## TODO")
    if todo:
        lines.append(todo)
    lines.append("## DONE")
    lines.append("## BLOCKED")
    if blocked:
        lines.append(blocked)
    return "\n".join(lines) + "\n"


def _parsed(board_text: str) -> dict:
    parsed = parse_sub_board(board_text, expected_role="saiwiki")
    assert not parsed["errors"], parsed["errors"]
    return parsed


def _state(**kwargs) -> dict:
    from saipen_engine.state import parse_state

    return parse_state(_sub_state(**kwargs))


class TerminalPredicateTests(unittest.TestCase):
    """M4: the closed truth table A-G, side-effect-free."""

    def test_a_stale_state_on_terminal_board(self):
        verdict = terminal_consistency(_state(task="W-001 legacy task"), _parsed(_sub_board()))
        self.assertEqual(verdict["verdict"], "STALE_STATE")
        self.assertTrue(verdict["task_residue"])
        self.assertEqual(verdict["state_residue"], ["task 'W-001 legacy task'"])

    def test_b_done_claim_false_with_todo(self):
        verdict = terminal_consistency(
            _state(task="W-001 legacy task"), _parsed(_sub_board(todo="- [ ] W-002 pending work"))
        )
        self.assertEqual(verdict["verdict"], "DONE_CLAIM_FALSE")
        self.assertEqual(verdict["todo"], ["W-002"])

    def test_c_must_resume_with_doing(self):
        verdict = terminal_consistency(
            _state(task="W-001"), _parsed(_sub_board(doing="- [/] W-001 active work"))
        )
        self.assertEqual(verdict["verdict"], "MUST_RESUME")
        self.assertEqual(verdict["doing"], ["W-001"])

    def test_d_must_block_with_active_blocked(self):
        verdict = terminal_consistency(
            _state(task="W-001"), _parsed(_sub_board(blocked="- [ ] W-003 awaits external input"))
        )
        self.assertEqual(verdict["verdict"], "MUST_BLOCK")
        self.assertEqual(verdict["blocked"], ["W-003"])

    def test_e_clean_terminal(self):
        verdict = terminal_consistency(_state(), _parsed(_sub_board()))
        self.assertEqual(verdict["verdict"], "CLEAN")
        self.assertFalse(verdict["state_residue"])

    def test_f_malformed_state_refused(self):
        board = _parsed(_sub_board())
        self.assertEqual(terminal_consistency(None, board)["verdict"], "MALFORMED_STATE")
        self.assertEqual(
            terminal_consistency("not-a-state", board)["verdict"], "MALFORMED_STATE"
        )

    def test_g_malformed_board_refused(self):
        self.assertEqual(terminal_consistency(_state(), None)["verdict"], "MALFORMED_BOARD")
        self.assertEqual(
            terminal_consistency(_state(), "not-a-board")["verdict"], "MALFORMED_BOARD"
        )

    def test_nonterminal_phase_is_not_reconciliation_input(self):
        verdict = terminal_consistency(_state(phase="BUILD"), _parsed(_sub_board()))
        self.assertEqual(verdict["verdict"], "NONTERMINAL")

    def test_validator_done_branch_agrees_with_the_predicate(self):
        cases = (
            (_state(task="W-001 legacy task"), _sub_board(), "STALE_STATE"),
            (
                _state(task="W-001"),
                _sub_board(todo="- [ ] W-002 pending work"),
                "DONE_CLAIM_FALSE",
            ),
            (_state(task="W-001"), _sub_board(doing="- [/] W-001 active work"), "MUST_RESUME"),
            (_state(task="W-001"), _sub_board(blocked="- [ ] W-003 external"), "MUST_BLOCK"),
            (_state(), _sub_board(), "CLEAN"),
        )
        for state, board_text, expected in cases:
            with self.subTest(expected=expected):
                board = _parsed(board_text)
                verdict = terminal_consistency(state, board)
                self.assertEqual(verdict["verdict"], expected)
                errors = validate_sub_lifecycle(state, board, "saiwiki")
                self.assertEqual(bool(errors), expected != "CLEAN")
                if expected == "STALE_STATE":
                    self.assertTrue(any("task is" in error for error in errors), errors)


class ProducerReconcileTests(unittest.TestCase):
    """M5: the producer-owned reconciliation route, end to end."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-sub-reconcile-")
        self.root = Path(self.tmp.name) / "project"
        self.root.parent.mkdir(parents=True, exist_ok=True)
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        (self.root / ".saipen" / "BOARD.md").write_text(BOARD, encoding="utf-8")
        (self.root / ".saipen" / "STATE.md").write_text(STATE, encoding="utf-8")
        (self.root / ".saipen" / "LOG.md").write_text(LOG, encoding="utf-8")
        rc, payload, out = _run_cli(self.root, "sub", "spawn", "saiwiki")
        self.assertEqual(rc, 0, out)
        rc, payload, out = _run_cli(self.root, "source", "capture", "reconcile authority")
        self.assertEqual(rc, 0, out)
        self.authority = str(payload.get("receipt") or payload.get("receipt_id"))
        self.assertTrue(self.authority.startswith("SRC-"), payload)
        self.sub = self.root / SUBS_REL / "saiwiki"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_sub(self, *, state: str, board: str) -> None:
        current = (self.sub / "STATE.md").read_text(encoding="utf-8-sig")
        match = re.search(r'(?m)^role_revision:\s*"([^"]+)"', current)
        if match:
            state = state.replace('role_revision: ""', f'role_revision: "{match.group(1)}"')
        (self.sub / "STATE.md").write_text(state, encoding="utf-8")
        (self.sub / "BOARD.md").write_text(board, encoding="utf-8")

    def _state(self) -> dict:
        from saipen_engine.state import parse_state

        return parse_state((self.sub / "STATE.md").read_text(encoding="utf-8-sig"))

    def _reconcile(self, *extra: str, authority: str | None = None):
        return _run_cli(
            self.root,
            "sub",
            "reconcile",
            "saiwiki",
            "--authority",
            authority if authority is not None else self.authority,
            *extra,
        )

    def test_outcome_a_clears_stale_task_and_stays_done(self):
        self._write_sub(state=_sub_state(task="W-001 legacy residue"), board=_sub_board())
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILED", payload)
        self.assertEqual(payload.get("outcome"), "OUTCOME_A_STALE_STATE_CLEARED")
        state = self._state()
        self.assertEqual(state["phase"], "DONE")
        self.assertIn(state["task"], (None, "", "none"))
        self.assertEqual(state["blocker"], "")
        log = (self.sub / "LOG.md").read_text(encoding="utf-8")
        self.assertIn("terminal reconciliation", log)
        self.assertIn(self.authority, log)

    def test_outcome_a_rebounds_a_malformed_wait(self):
        long_wait = (
            "WAIT: manual-verify -- TRANSLATE-018 draft is closed. "
            "Core must decide coverage_pct next."
        )
        self._write_sub(
            state=_sub_state(task="W-001 residue", next_action=long_wait),
            board=_sub_board(),
        )
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILED", payload)
        self.assertTrue(payload.get("normalized_wait"), payload)
        state = self._state()
        self.assertEqual(state["phase"], "DONE")
        self.assertIn(state["task"], (None, "", "none"))
        from saipen_engine.state import wait_grammar_error

        self.assertIsNone(wait_grammar_error(state["next_action"]), state["next_action"])
        self.assertIn("TRANSLATE-018 draft is closed", state["next_action"])

    def test_outcome_b_doing_resumes_and_keeps_open_work(self):
        self._write_sub(
            state=_sub_state(task="W-001"),
            board=_sub_board(doing="- [/] W-001 active work | verify: proof"),
        )
        before_board = (self.sub / "BOARD.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("outcome"), "OUTCOME_B_RESUMED_NONTERMINAL", payload)
        state = self._state()
        self.assertEqual(state["phase"], "PLAN")
        self.assertEqual(state["task"], "W-001")
        self.assertEqual((self.sub / "BOARD.md").read_text(encoding="utf-8"), before_board)

    def test_outcome_b_todo_returns_to_plan_and_keeps_open_work(self):
        self._write_sub(
            state=_sub_state(task="W-001"),
            board=_sub_board(todo="- [ ] W-002 pending work"),
        )
        before_board = (self.sub / "BOARD.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("outcome"), "OUTCOME_B_RESUMED_NONTERMINAL", payload)
        state = self._state()
        self.assertEqual(state["phase"], "PLAN")
        self.assertIn(state["task"], (None, "", "none"))
        self.assertEqual((self.sub / "BOARD.md").read_text(encoding="utf-8"), before_board)

    def test_outcome_b_blocked_is_truthful(self):
        self._write_sub(
            state=_sub_state(task="W-001"),
            board=_sub_board(
                blocked="- [ ] W-003 awaits external input | blocker: needs vendor reply"
            ),
        )
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("outcome"), "OUTCOME_B_BLOCKED_NONTERMINAL", payload)
        state = self._state()
        self.assertEqual(state["phase"], "BLOCKED")
        self.assertEqual(state["blocker"], "W-003: awaits external input")

    def test_clean_and_idempotent_second_run(self):
        self._write_sub(state=_sub_state(), board=_sub_board())
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILE_CLEAN", payload)
        self._write_sub(state=_sub_state(task="W-001 residue"), board=_sub_board())
        rc, payload, out = self._reconcile()
        self.assertEqual(payload.get("code"), "SUB_RECONCILED", payload)
        state_after = (self.sub / "STATE.md").read_text(encoding="utf-8")
        log_after = (self.sub / "LOG.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILE_CLEAN", payload)
        self.assertEqual((self.sub / "STATE.md").read_text(encoding="utf-8"), state_after)
        self.assertEqual((self.sub / "LOG.md").read_text(encoding="utf-8"), log_after)

    def test_malformed_state_and_board_refuse_zero_writes(self):
        self._write_sub(state="---\nphase: [broken\n---\n", board=_sub_board())
        before = (self.sub / "STATE.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED", payload)
        self.assertEqual((self.sub / "STATE.md").read_text(encoding="utf-8"), before)
        self._write_sub(state=_sub_state(task="W-001"), board="# Board\n## BROKEN\n")
        before = (self.sub / "BOARD.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED", payload)
        self.assertEqual((self.sub / "BOARD.md").read_text(encoding="utf-8"), before)

    def test_foreign_producer_owner_refuses(self):
        self._write_sub(
            state=_sub_state(task="W-001", agent="some-other-seat"), board=_sub_board()
        )
        before = (self.sub / "STATE.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILE_OWNERSHIP_CONFLICT", payload)
        self.assertEqual((self.sub / "STATE.md").read_text(encoding="utf-8"), before)

    def test_authority_is_mandatory_and_must_exist(self):
        self._write_sub(state=_sub_state(task="W-001"), board=_sub_board())
        before = (self.sub / "STATE.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile(authority="")
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILE_AUTHORITY_REQUIRED", payload)
        rc, payload, out = self._reconcile(authority="SRC-999")
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILE_AUTHORITY_INVALID", payload)
        self.assertEqual((self.sub / "STATE.md").read_text(encoding="utf-8"), before)

    def test_nonterminal_producer_is_not_reconcile_input(self):
        self._write_sub(
            state=_sub_state(
                phase="BUILD",
                task="W-001",
                next_action="PHASE BUILD W-001",
                transition_from="SCOUT",
            ),
            board=_sub_board(doing="- [/] W-001 active work | verify: proof"),
        )
        before = (self.sub / "STATE.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile()
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILE_NOT_TERMINAL", payload)
        self.assertEqual((self.sub / "STATE.md").read_text(encoding="utf-8"), before)

    def test_dry_run_plans_without_writing(self):
        self._write_sub(state=_sub_state(task="W-001 residue"), board=_sub_board())
        before_state = (self.sub / "STATE.md").read_text(encoding="utf-8")
        before_log = (self.sub / "LOG.md").read_text(encoding="utf-8")
        rc, payload, out = self._reconcile("--dry-run")
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "SUB_RECONCILE_PLAN", payload)
        self.assertEqual(payload.get("verdict"), "STALE_STATE")
        self.assertEqual((self.sub / "STATE.md").read_text(encoding="utf-8"), before_state)
        self.assertEqual((self.sub / "LOG.md").read_text(encoding="utf-8"), before_log)

    def test_validator_finding_disappears_after_owned_reconcile(self):
        self._write_sub(state=_sub_state(task="W-001 legacy residue"), board=_sub_board())
        rc_before, before = _run_validator(self.root)
        self.assertNotEqual(rc_before, 0)
        self.assertIn("phase DONE but task is", before)
        self.assertIn("saipen sub reconcile saiwiki --authority SRC-###", before)
        verdict = remediation.resolve_command("saipen sub reconcile saiwiki --authority SRC-001")
        self.assertTrue(verdict.get("ok"), verdict)
        self.assertEqual(verdict.get("route_kind"), "PRODUCER_OWNED_COMMAND")
        rc, _payload, out = self._reconcile()
        self.assertEqual(rc, 0, out)
        _rc_after, after = _run_validator(self.root)
        self.assertNotIn("phase DONE but task is", after)


def _run_cli(project: Path, *args: str) -> tuple[int, dict, str]:
    proc = subprocess.run(
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
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=unbound_environment(),
        timeout=600,
    )
    try:
        payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except ValueError:
        payload = {"_unparseable_stdout": proc.stdout}
    diagnostic = proc.stdout
    if proc.stderr.strip():
        diagnostic += "\nSTDERR:\n" + proc.stderr
    return proc.returncode, payload, diagnostic


def _run_validator(project: Path) -> tuple[int, str]:
    proc = subprocess.run(
        [
            sys.executable,
            str(VALIDATE_PY),
            "--project-root",
            str(project),
            "--gate",
            "core",
            "--no-receipt",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=unbound_environment(),
        timeout=600,
    )
    return proc.returncode, proc.stdout


if __name__ == "__main__":
    unittest.main(verbosity=2)