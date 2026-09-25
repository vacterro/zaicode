"""Regressions for the 2026-08-27 audit CORE-001..CORE-004 repairs."""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path
from unittest import mock

from test_control_primitives import ControlFixture

from saipen_engine.operations import enter_ship_convergence, stop_checkpoint
from saipen_engine.state import parse_state
from saipen_engine import test_runner


def _hashes(root: Path) -> dict[str, str]:
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
    }


def _replace_state(path: Path, key: str, value: str) -> None:
    text = path.read_text(encoding="utf-8")
    text = re.sub(rf"(?m)^{re.escape(key)}:.*$", f"{key}: {value}", text)
    path.write_text(text, encoding="utf-8")


class StopAuditTests(ControlFixture):
    def test_cli_stop_uses_canonical_owned_transaction(self):
        project = self.make_project(active=True)
        kitchen = project / ".saipen" / "kitchen"
        kitchen.mkdir()
        outside = project.parent / "outside-stop.txt"
        outside.write_text("SENTINEL", encoding="utf-8")
        try:
            (kitchen / "digest.md").symlink_to(outside)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        canonical = [
            project / ".saipen" / name
            for name in ("STATE.md", "BOARD.md", "LOG.md")
        ]
        before = {path.name: path.read_bytes() for path in canonical}
        rc, payload = self.cli(project, "st")
        self.assertEqual(rc, 1, payload)
        self.assertEqual(outside.read_text(encoding="utf-8"), "SENTINEL")
        self.assertEqual(before, {path.name: path.read_bytes() for path in canonical})

    def test_normal_stop_checkpoints_log_board_state_and_digest(self):
        project = self.make_project(active=True)
        state_path = project / ".saipen" / "STATE.md"
        board_path = project / ".saipen" / "BOARD.md"
        log_path = project / ".saipen" / "LOG.md"
        before = {
            "state": state_path.read_bytes(),
            "board": board_path.read_bytes(),
            "log": log_path.read_bytes(),
        }
        board_path.write_text(
            re.sub(
                r"claim_time: [^\n]+",
                "claim_time: 2020-01-01T00:00:00Z",
                board_path.read_text(encoding="utf-8"),
            ),
            encoding="utf-8",
        )
        before["board"] = board_path.read_bytes()
        rc, payload = self.cli(project, "st")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["code"], "STOP")
        self.assertEqual(payload["operation_code"], "STOPPED")
        self.assertNotEqual(before["state"], state_path.read_bytes())
        self.assertNotEqual(before["board"], board_path.read_bytes())
        self.assertNotEqual(before["log"], log_path.read_bytes())
        digest = (project / ".saipen" / "kitchen" / "digest.md").read_text(
            encoding="utf-8"
        )
        self.assertEqual(
            [line.split(":", 1)[0] for line in digest.splitlines()],
            ["done", "remaining", "awaiting"],
        )

    def test_read_only_stop_emits_real_digest_projection_and_writes_nothing(self):
        project = self.make_project(active=True)
        _replace_state(project / ".saipen" / "STATE.md", "mode", "read-only")
        before = _hashes(project)
        with mock.patch.dict(os.environ, {"SAIPEN_CAPABILITY": "read-only"}):
            rc, payload = self.cli(project, "st")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["code"], "STOP")
        self.assertEqual(payload["mode"], "read-only")
        self.assertEqual(
            [line.split(":", 1)[0] for line in payload["digest_lines"]],
            ["done", "remaining", "awaiting"],
        )
        self.assertEqual(before, _hashes(project))

    def test_stop_refuses_foreign_live_claim_with_zero_writes(self):
        project = self.make_project(active=True)
        board = project / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace("owner: tester", "owner: foreign"),
            encoding="utf-8",
        )
        before = _hashes(project)
        result = stop_checkpoint(project, "tester", dry_run=True)
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(before, _hashes(project))

    def test_stop_goal_caps_emit_canonical_wait_without_reset(self):
        for key, value in (("goal_waves", "3"), ("goal_tickets", "20")):
            with self.subTest(key=key):
                project = self.make_project(intent="goal")
                _replace_state(project / ".saipen" / "STATE.md", key, value)
                result = stop_checkpoint(project, "tester", dry_run=True)
                self.assertTrue(result.ok, result.to_dict())
                self.assertRegex(
                    result.data["next_action"],
                    r"^WAIT: safety valve reached \(\d+ waves / \d+ tickets\) "
                    r"-- run 'cc' to continue$",
                )
                state = parse_state((project / ".saipen" / "STATE.md").read_text())
                self.assertEqual(str(state[key]), value)


class TestCommandAuditTests(ControlFixture):
    def test_tt_dry_run_is_a_zero_write_non_recursive_plan(self):
        project = self.make_project()
        before = _hashes(project)
        rc, payload = self.cli(project, "--dry-run", "tt")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["code"], "TEST_PLAN")
        names = {family["name"] for family in payload["families"]}
        self.assertTrue(
            {"unit", "consumer-unit", "validator", "audit-checks", "scenarios"}
            <= names
        )
        self.assertEqual(before, _hashes(project))

    def test_injected_failing_family_is_reported_as_overall_failure(self):
        project = self.make_project()
        failing = test_runner.TestFamily(
            "sentinel-failure",
            (sys.executable, "-B", "-c", "raise SystemExit(7)"),
            30,
        )
        with mock.patch.object(test_runner, "_families", return_value=(failing,)):
            report = test_runner.run_canonical_suite(project)
        self.assertFalse(report["ok"])
        self.assertEqual(report["families"][0]["status"], "FAIL")
        self.assertEqual(report["families"][0]["exit_code"], 7)

    def test_ci_fast_unit_uses_the_same_orchestrator(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/validate.yml")
        text = workflow.read_text(encoding="utf-8")
        self.assertIn("tools/test_runner.py --family unit", text)


class CccAuditTests(ControlFixture):
    def _git_project(self) -> Path:
        project = self.make_project(intent="goal", active=True)
        subprocess.run(["git", "init", "-q"], cwd=project, check=True)
        subprocess.run(
            ["git", "config", "user.email", "audit@example.invalid"],
            cwd=project,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Audit Fixture"],
            cwd=project,
            check=True,
        )
        (project / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=project, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=project, check=True)
        return project

    def test_ccc_atomically_records_head_refreshes_claim_and_clears_goal_counters(self):
        project = self._git_project()
        board_path = project / ".saipen" / "BOARD.md"
        board_path.write_text(
            re.sub(
                r"claim_time: [^\n]+",
                "claim_time: 2020-01-01T00:00:00Z",
                board_path.read_text(encoding="utf-8"),
            ),
            encoding="utf-8",
        )
        head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=project, text=True
        ).strip()
        result = enter_ship_convergence(project, "tester")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.data["source_head"], head)
        state = parse_state((project / ".saipen" / "STATE.md").read_text())
        self.assertEqual(state["execution_intent"], "converge")
        self.assertEqual(state["converge_target"], "ship")
        self.assertNotIn("goal_waves", state)
        self.assertNotIn("goal_tickets", state)
        log_text = (project / ".saipen/LOG.md").read_text()
        self.assertIn(f"DEC: ccc converge target -> ship @{head}", log_text)
        self.assertNotIn("claim_time: 2020-01-01T00:00:00Z", board_path.read_text())

    def test_ccc_refuses_foreign_live_claim_without_marker_or_state_change(self):
        project = self._git_project()
        board = project / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace("owner: tester", "owner: foreign"),
            encoding="utf-8",
        )
        before = _hashes(project)
        result = enter_ship_convergence(project, "tester")
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(before, _hashes(project))


if __name__ == "__main__":
    import unittest

    unittest.main()
