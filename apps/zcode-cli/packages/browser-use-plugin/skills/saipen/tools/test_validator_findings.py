"""Public validator findings export stays complete or unavailable."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from saipen_engine import intake  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"


class ValidatorFindingsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-debt-strict-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        board = self.root / ".saipen/BOARD.md"
        text = board.read_text(encoding="utf-8")
        text = text.replace("## DOING\n- [/] T-001 DOING task", "## DOING")
        text = text.replace(
            "## DONE\n", "## DONE\n- [x] T-001 DOING task | verify: proof exists\n"
        )
        board.write_text(text, encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_classifier_failure_never_publishes_partial_findings(self) -> None:
        import subprocess

        intake.capture(self.root, "audit body", source_kind="user_audit", work="T-001")
        out = self.root.parent / "partial-findings.json"
        validator = ROOT / "tools" / "validate.py"
        script = (
            "import runpy, sys; from unittest import mock; "
            "sys.path.insert(0, sys.argv[1]); "
            "from saipen_engine import findings; "
            "validator = sys.argv[2]; sys.argv = sys.argv[2:]; "
            "patcher = mock.patch.object(findings, 'classify', "
            "side_effect=RuntimeError('classifier unavailable')); "
            "patcher.start(); runpy.run_path(validator, run_name='__main__')"
        )
        result = subprocess.run(
            [sys.executable, "-c", script, str(ROOT / "tools"), str(validator),
             "--project-root", str(self.root), "--findings-json", str(out)],
            capture_output=True, text=True, timeout=600,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(out.exists(), "Incomplete findings must never become debt authority")

    def test_findings_json_side_artifact_matches_standard_counts(self) -> None:
        import subprocess

        intake.capture(self.root, "audit body", source_kind="user_audit", work="T-001")
        out = self.root.parent / "findings.json"
        subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "validate.py"),
                "--project-root",
                str(self.root),
                "--findings-json",
                str(out),
            ],
            capture_output=True,
            text=True,
            timeout=600,
        )
        doc = json.loads(out.read_text(encoding="utf-8"))
        unresolved = [
            f for f in doc["problems"]
            if f["rule_id"] == "source_receipt_unresolved_work" and f["subject_id"] == "T-001"
        ]
        self.assertEqual(len(unresolved), 1, doc["problems"])
        self.assertIn(unresolved[0]["finding_key"], [f["finding_key"] for f in doc["problems"]])

