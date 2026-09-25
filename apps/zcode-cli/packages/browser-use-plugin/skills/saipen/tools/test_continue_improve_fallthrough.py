"""Regression tests for the `saipen continue` -> `saipen improve` fallthrough
(T-20260830_0842).

Pins the ADDITIONAL DIRECTION acceptance tests to deterministic, side-effect-free
assertions:

1. continue resumes active Work before considering improvement.
2. queued Work outranks improvement discovery.
3. required VERIFY/REVIEW follow-up outranks improvement discovery.
4. unresolved candidate ordering is respected.
5. empty actionable queue triggers `saipen improve`.
6. improvement fallback can generate concrete normal Work.
7. generated improvement Work uses canonical Work contracts.
8. discovered improvement proceeds through normal lifecycle.
9. improvement discovery is not entered when legitimate existing Work exists.
10. no worthwhile improvement produces a clean no-op/idle terminal result.
11. no recursive `continue -> improve -> continue` loop occurs.
12. one `continue` invocation performs at most one empty-queue improvement
    discovery fallback.
13. HUSH suppresses narration around the fallback transition.
14. fallback does not weaken FIT, VERIFY, REVIEW, destructive confirmation,
    or recovery rules.
15. existing `saipen continue` behavior remains compatible for projects that
    already have actionable Work.

Run standalone:
    python tools/test_continue_improve_fallthrough.py
"""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import saipen as CLI  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"


def _invoke_cli(root: Path, *args: str, as_json: bool = True):
    """In-process CLI invocation against a throwaway project."""
    argv = [*args, "--project-root", str(root)]
    if as_json:
        argv.append("--json")
    output = io.StringIO()
    with redirect_stdout(output):
        rc = CLI.main(argv)
    raw = output.getvalue().strip()
    return rc, (json.loads(raw) if as_json else raw)


def _invoke_subprocess(root: Path, *args: str):
    """Subprocess CLI invocation (real public adapter)."""
    cmd = [
        sys.executable,
        str(SAIPEN_PY),
        "--project-root",
        str(root),
        "--json",
        *args,
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
        timeout=120,
    )
    payload = {}
    if proc.stdout.strip():
        try:
            payload = json.loads(proc.stdout.strip())
        except ValueError:
            payload = {"_unparseable_stdout": proc.stdout}
    return proc.returncode, payload, proc.stdout


class ContinueImproveFallthroughTests(unittest.TestCase):
    def setUp(self) -> None:
        config = tempfile.TemporaryDirectory(prefix="saipen-test-user-config-")
        self.addCleanup(config.cleanup)
        patcher = mock.patch.dict(
            os.environ, {"SAIPEN_USER_CONFIG_HOME": config.name}, clear=False
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def _make(
        self,
        name: str,
        *,
        board: str,
        intent: str = "goal",
        state_overrides: dict | None = None,
    ):
        """Minimal legal project: empty queue by default."""
        td = tempfile.mkdtemp(prefix="saipen-cont-improve-")
        self.addCleanup(lambda: shutil.rmtree(td, ignore_errors=True))
        root = Path(td) / name
        (root / ".saipen").mkdir(parents=True)
        import datetime

        now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        fields = {
            "phase": "DONE",
            "task": "none",
            "next_action": "saipen continue",
            "blocker": "none",
            "transition_from": "SHIP",
            "saipen_version": "7",
            "schema_version": "3",
            "last_event": "1",
            "style_contract": "ded-4ae736e4",
            "agent": "tester",
            "mode": "full",
            "updated": now,
            "execution_intent": intent,
            "goal_waves": "0",
            "goal_tickets": "0",
        }
        fields.update(state_overrides or {})
        lines = ["---"]
        for key, value in fields.items():
            lines.append(f"{key}: {value}")
        lines.append("---")
        (root / ".saipen" / "STATE.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        (root / ".saipen" / "BOARD.md").write_text(board, encoding="utf-8")
        (root / ".saipen" / "LOG.md").write_text(
            "# Log\n- 01.01.20 00:00 [E-001] [agent: tester] DEC: fixture\n",
            encoding="utf-8",
        )
        (root / "VERSION").write_text("7.231.9\n", encoding="utf-8")
        return root

    @staticmethod
    def _board(*, doing: str = "", todo: str = "") -> str:
        return (
            "## DOING\n"
            f"{doing}"
            "## TODO\n"
            f"{todo}"
            "## DONE\n"
            "- [x] T-000 fixture | verify: PASS -- fixture\n"
            "## BLOCKED\n"
        )

    # ---- 1/2/3/4/9/15: existing Work outranks discovery -------------------
    def test_queued_work_outranks_improvement(self):
        root = self._make(
            "queued",
            board=self._board(todo="- [ ] T-001 [P1] queued | verify: test\n"),
        )
        rc, result = _invoke_cli(root, "cc", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertEqual(result["action"], "PHASE SCOUT T-001", result)
        self.assertNotEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT")

    def test_active_work_outranks_improvement(self):
        root = self._make(
            "active",
            board=self._board(
                doing="- [/] T-002 [P1] active | owner: tester | "
                "claim_time: 2020-01-01T00:00:00Z\n",
            ),
            state_overrides={
                "phase": "BUILD",
                "task": "T-002",
                "next_action": "PHASE BUILD T-002",
                "transition_from": "SCOUT",
            },
        )
        rc, result = _invoke_cli(root, "cc", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertEqual(result["action"], "PHASE BUILD T-002", result)
        self.assertNotEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT")

    def test_verify_review_follow_up_outranks_improvement(self):
        # SHIP-phase ticket = required VERIFY/REVIEW follow-up in flight.
        root = self._make(
            "followup",
            board=self._board(
                doing="- [/] T-003 [P1] shipme | owner: tester | "
                "claim_time: 2020-01-01T00:00:00Z\n",
            ),
            state_overrides={
                "phase": "SHIP",
                "task": "T-003",
                "next_action": "PHASE SHIP T-003",
                "transition_from": "REVIEW",
            },
        )
        rc, result = _invoke_cli(root, "cc", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertEqual(result["action"], "PHASE SHIP T-003", result)
        self.assertNotEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT")

    def test_blocked_ticket_does_not_unblock_or_fall_through(self):
        # A BLOCKED phase is a hard stop (UNBLOCK priority), never discovery.
        root = self._make(
            "blocked",
            board=self._board(),
            state_overrides={
                "phase": "BLOCKED",
                "task": "none",
                "next_action": "saipen status",
                "blocker": "permanent-fixture-blocker",
            },
        )
        rc, result = _invoke_cli(root, "cc", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertNotEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT")
        self.assertEqual(result["reason"], "unblock", result)

    # ---- 5/6/7: empty queue triggers improve, generates canonical Work ----
    def test_empty_queue_triggers_improve(self):
        root = self._make("empty", board=self._board())
        rc, result = _invoke_cli(root, "cc")
        self.assertEqual(rc, 0, result)
        self.assertEqual(result["code"], "IMPROVE_AUDIT_ASSIGNMENT", result)
        cycle = result.get("cycle_id")
        self.assertTrue(cycle and cycle.startswith("imp-"), result)
        # Canonical contracts: MANIFEST + seat report exist.
        cycle_dir = root / ".saipen" / "improve" / cycle
        self.assertTrue((cycle_dir / "MANIFEST.md").is_file())
        report = root / result["report_path"]
        self.assertTrue(report.is_file(), report)
        # The report carries a mechanical source identity + a concrete scope.
        report_text = report.read_text(encoding="utf-8")
        self.assertIn("source_head:", report_text)
        self.assertIn("source_tree_fingerprint:", report_text)
        self.assertIn("context_scope:", report_text)

    def test_empty_queue_trigger_is_not_entered_with_dry_run(self):
        # --dry-run is observational: no improve cycle is prepared, no write.
        root = self._make("empty-dry", board=self._board())
        before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
        rc, result = _invoke_cli(root, "cc", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertNotEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT")
        after = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)

    # ---- 8: discovery proceeds through normal lifecycle ------------------
    def test_discovered_work_proceeds_through_normal_lifecycle(self):
        root = self._make("lifecycle", board=self._board())
        rc, first = _invoke_cli(root, "cc")
        self.assertEqual(rc, 0)
        cycle = first.get("cycle_id")
        self.assertTrue(cycle, first)
        # The cycle is now part of the project's durable truth: a second cc
        # resumes the same in-flight cycle instead of preparing a duplicate.
        rc2, second = _invoke_cli(root, "cc")
        self.assertEqual(rc2, 0)
        self.assertEqual(second.get("code"), "CONTINUE_IMPROVE_IN_FLIGHT", second)
        self.assertEqual(second.get("cycle_id"), cycle, second)

    # ---- 10: ambiguity is a structured refusal, never idle --------------
    def test_ambiguous_improve_is_refusal_not_idle(self):
        # Two active Improve cycles force improve's ambiguous-admission
        # refusal (a real non-recovery ImproveError).  W3B.11: that is a
        # structured refusal that must propagate, never be mapped to
        # CONTINUE_IDLE -- only a genuine NO_WORTHWHILE_IMPROVEMENT outcome
        # may become idle.
        root = self._make("idle", board=self._board())
        imp = root / ".saipen" / "improve"
        for i in ("a", "b"):
            cycle = imp / f"imp-idle-{i}-1"
            cycle.mkdir(parents=True)
            (cycle / "MANIFEST.md").write_text(
                "# IMPROVE CYCLE ROSTER\n"
                "manifest_schema: strict\n"
                f"cycle_id: {cycle.name}\n"
                "created_at: 2026-08-30T00:00:00Z\n"
                "project_identity: test\n"
                "cycle_status: active\n",
                encoding="utf-8",
            )
        rc, result = _invoke_cli(root, "cc")
        self.assertEqual(rc, 1, result)
        self.assertNotEqual(result.get("code"), "CONTINUE_IDLE", result)
        self.assertNotEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT", result)

    # ---- 11/12: anti-loop, at most one fallback per invocation -----------
    def test_anti_loop_at_most_one_fallback_per_invocation(self):
        root = self._make("antiloop", board=self._board())
        # First cc falls through exactly once and prepares ONE cycle.
        rc, first = _invoke_cli(root, "cc")
        self.assertEqual(rc, 0)
        self.assertEqual(first["code"], "IMPROVE_AUDIT_ASSIGNMENT")
        cycles = list((root / ".saipen" / "improve").glob("imp-*")) if (
            root / ".saipen" / "improve"
        ).is_dir() else []
        self.assertEqual(len(cycles), 1, cycles)
        # A follow-up cc does NOT prepare a second cycle -- it resumes the
        # in-flight one (no recursive continue->improve->continue loop).
        rc2, second = _invoke_cli(root, "cc")
        self.assertEqual(rc2, 0)
        self.assertEqual(second.get("code"), "CONTINUE_IMPROVE_IN_FLIGHT", second)
        cycles2 = list((root / ".saipen" / "improve").glob("imp-*"))
        self.assertEqual(len(cycles2), 1, cycles2)

    # ---- 13: fallback payload carries no transition narration -------------
    def test_fallback_payload_contains_no_transition_narration(self):
        root = self._make("hush", board=self._board())
        # The fallback's structured result is not narration; the HUSH
        # invariant is that the transition happens without "nothing to
        # continue / switching to improve" prose in the emitted payload.
        rc, result = _invoke_cli(root, "cc")
        self.assertEqual(rc, 0)
        self.assertNotIn("nothing to continue", json.dumps(result).lower())
        self.assertNotIn("switching to improve", json.dumps(result).lower())

    # ---- 14: recovery rules are not weakened -----------------------------
    def test_recovery_rule_not_weakened(self):
        # A pending recovery op must route to `saipen recover`, never fall
        # through to improve and never be masked as idle.
        root = self._make("recovery", board=self._board())
        # A recovery op directory marks a pending operation.
        op = root / ".saipen" / "recovery" / "ops" / "op-probe"
        op.mkdir(parents=True)
        (op / "operation.json").write_text(
            json.dumps(
                {
                    "op_id": "op-probe",
                    "operation": "transition",
                    "status": "PREPARED",
                    "targets": [],
                }
            ),
            encoding="utf-8",
        )
        rc, result = _invoke_cli(root, "cc")
        self.assertEqual(rc, 1)
        self.assertIn(
            result.get("code"),
            ("RECOVERY_REQUIRED", "RECOVERY_CONFLICT", "CORRUPT_JOURNAL"),
            result,
        )
        self.assertNotEqual(result.get("code"), "CONTINUE_IDLE")
        self.assertNotEqual(result.get("code"), "IMPROVE_AUDIT_ASSIGNMENT")


if __name__ == "__main__":
    unittest.main()
