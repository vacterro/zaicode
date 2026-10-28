"""SAIPEN Core DONE-Work reverify receipts (T-158 Stage 2 / AUDAPACK T-177).

A re-verification receipt is a first-class machine-owned record saying:
"this already-DONE Work was checked again against this current tree."
DONE stays DONE; no synthetic VERIFY transition; strict Core, release and
historical debt visibility unchanged.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import debt as debt_mod  # noqa: E402
from saipen_engine import findings as findings_mod  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"

V = [{"command": "unittest probe", "result": "PASS"}]


class ReverifyFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-reverify-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        board = self.root / ".saipen/BOARD.md"
        text = board.read_text(encoding="utf-8")
        text = text.replace("## DOING\n- [/] T-001 DOING task", "## DOING")
        text = text.replace("## DONE\n", "## DONE\n- [x] T-001 DOING task | verify: proof exists\n")
        board.write_text(text, encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _canned(self, problems):
        return {
            "ok": True,
            "exit_code": 0 if not problems else 1,
            "gate": "core",
            "problems": problems,
            "warnings": [],
        }

    def _own_problem(self, ticket: str = "T-001") -> dict:
        return findings_mod.classify(
            "problem",
            f"ticket {ticket} is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)",
        )

    def _receipt_dir(self) -> Path:
        return self.root / debt_mod.REVERIFY_DIR


class ReverifyTests(ReverifyFixture):
    def test_done_work_receives_pass_reverify_receipt(self) -> None:
        with patch.object(debt_mod, "capture_findings", return_value=self._canned([])):
            result = debt_mod.reverify_work(self.root, "T-001", "probe", verification=V)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "WORK_REVERIFIED")
        self.assertIn(result["verdict"], ("PASS", "PASS_WITH_CARRIED_DEBT"))
        record = json.loads(
            (self._receipt_dir() / f"{result['receipt_id']}.json").read_text(encoding="utf-8")
        )
        self.assertEqual(record["work"], "T-001")
        self.assertTrue(record["journal_op_id"])
        for field in (
            "receipt_id",
            "work",
            "project_identity",
            "project_lineage",
            "ruleset_version",
            "ruleset_fingerprint",
            "source_head",
            "source_tree_fingerprint",
            "created_at",
            "agent",
            "verification",
            "verdict",
            "gate",
            "integrity_digest",
        ):
            self.assertIn(field, record, f"receipt missing {field}")

    def test_done_state_remains_done_and_no_synthetic_verify(self) -> None:
        before_board = (self.root / ".saipen/BOARD.md").read_text(encoding="utf-8")
        before_log = (self.root / ".saipen/LOG.md").read_bytes()
        with patch.object(debt_mod, "capture_findings", return_value=self._canned([])):
            debt_mod.reverify_work(self.root, "T-001", "probe", verification=V)
        self.assertEqual(
            (self.root / ".saipen/BOARD.md").read_text(encoding="utf-8"), before_board
        )
        self.assertEqual((self.root / ".saipen/LOG.md").read_bytes(), before_log)
        after = (self.root / ".saipen/BOARD.md").read_text(encoding="utf-8")
        self.assertIn("- [x] T-001", after)

    def test_non_done_states_refuse(self) -> None:
        board = self.root / ".saipen/BOARD.md"
        text = board.read_text(encoding="utf-8")
        text = text.replace("## DONE\n", "## TODO\n", 1)
        board.write_text(text, encoding="utf-8")
        result = debt_mod.reverify_work(self.root, "T-001", "probe", verification=V)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "REVERIFY_REFUSED")

    def test_missing_work_refuses(self) -> None:
        result = debt_mod.reverify_work(self.root, "T-999", "probe", verification=V)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "TICKET_NOT_FOUND")

    def test_fail_verdict_recorded_when_own_problems(self) -> None:
        # An OWN problem other than the receipt-cured closure-evidence gap
        # (e.g. an unresolved source receipt linked to the Work) FAILs.
        own = findings_mod.classify(
            "problem", "DONE Work T-001 has unresolved source receipt SRC-001"
        )
        with patch.object(debt_mod, "capture_findings", return_value=self._canned([own])):
            result = debt_mod.reverify_work(self.root, "T-001", "probe", verification=V)
        self.assertTrue(result["ok"])
        self.assertEqual(result["verdict"], "FAIL")

    def test_closure_evidence_gap_cured_by_receipt(self) -> None:
        # The receipt is the cure for the Work's own closure-evidence gap:
        # that problem alone never forces a FAIL. Any OTHER own problem does.
        canned = self._canned([self._own_problem()])
        with patch.object(debt_mod, "capture_findings", return_value=canned):
            result = debt_mod.reverify_work(self.root, "T-001", "probe", verification=V)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["verdict"], "PASS_WITH_CARRIED_DEBT")

    def test_non_pass_verification_refuses(self) -> None:
        result = debt_mod.reverify_work(
            self.root,
            "T-001",
            "probe",
            verification=[{"command": "unittest probe", "result": "FAIL"}],
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "REVERIFY_REFUSED")

    def test_no_verification_refuses(self) -> None:
        result = debt_mod.reverify_work(self.root, "T-001", "probe", verification=None)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "REVERIFY_REFUSED")

    def test_idempotent_reuse(self) -> None:
        canned = self._canned([])
        with patch.object(debt_mod, "capture_findings", return_value=canned):
            first = debt_mod.reverify_work(self.root, "T-001", "probe", verification=V)
            second = debt_mod.reverify_work(self.root, "T-001", "probe", verification=V)
        self.assertEqual(first["code"], "WORK_REVERIFIED")
        self.assertEqual(second["code"], "REVERIFY_REUSED")
        self.assertEqual(first["receipt_id"], second["receipt_id"])

    def test_receipt_is_secret_free(self) -> None:
        secret = "sk-live-DO-NOT-LEAK-9f8e7d6c5b4a"
        with patch.object(
            debt_mod,
            "capture_findings",
            return_value=self._canned([]),
        ):
            result = debt_mod.reverify_work(self.root, "T-001", "probe", verification=V)
        raw = (self._receipt_dir() / f"{result['receipt_id']}.json").read_text(encoding="utf-8")
        self.assertNotIn(secret, raw)


class LatestPassTests(ReverifyFixture):
    def _write_receipt(self, receipt_id: str, verdict: str, **overrides) -> None:
        record = {
            "schema_version": 1,
            "receipt_id": receipt_id,
            "work": "T-001",
            "project_identity": debt_mod._project_identity(self.root),
            "project_lineage": debt_mod.project_lineage_identity(self.root),
            "ruleset_version": findings_mod.RULESET_VERSION,
            "ruleset_fingerprint": findings_mod.ruleset_fingerprint(),
            "source_head": None,
            "source_tree_fingerprint": "git-delta-v1:abc",
            "created_at": "2026-09-08T00:00:00Z",
            "agent": "probe",
            # T-1434 M5.3: these fixtures probe IDENTITY semantics, so they
            # carry executable evidence; the attested-only downgrade has its
            # own RED control in test_work_reverify_cli.py.
            "verification": [
                {**V[0], "executed": True, "kind": "executed"}
            ],
            "evidence_class": "executed",
            "problem_count": 0,
            "warning_count": 0,
            "findings_digest": "digest",
            "own_problem_keys": [],
            "verdict": verdict,
            "gate": "core",
        }
        record.update(overrides)
        path = self._receipt_dir() / f"{receipt_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, indent=2), encoding="utf-8")

    def test_latest_fail_hides_no_stale_pass(self) -> None:
        self._write_receipt("RV-000001", "PASS")
        self._write_receipt("RV-000002", "FAIL")
        self.assertIsNone(debt_mod.latest_pass_reverify(self.root, "T-001"))

    def test_pass_receipt_found(self) -> None:
        self._write_receipt("RV-000001", "PASS")
        found = debt_mod.latest_pass_reverify(self.root, "T-001")
        self.assertIsNotNone(found)
        self.assertEqual(found["receipt_id"], "RV-000001")

    def test_wrong_project_reverify_is_not_evidence(self) -> None:
        self._write_receipt("RV-000001", "PASS", project_identity="other-project")
        self.assertIsNone(debt_mod.latest_pass_reverify(self.root, "T-001"))

    def test_wrong_lineage_reverify_is_not_evidence(self) -> None:
        self._write_receipt("RV-000001", "PASS", project_lineage="other-lineage")
        self.assertIsNone(debt_mod.latest_pass_reverify(self.root, "T-001"))

    def test_wrong_ruleset_reverify_is_not_evidence(self) -> None:
        self._write_receipt("RV-000001", "PASS", ruleset_fingerprint="stale-ruleset")
        self.assertIsNone(debt_mod.latest_pass_reverify(self.root, "T-001"))

    def test_stale_checkpoint_receipt_is_not_current_tree_evidence(self) -> None:
        # current_tree_reverify: a PASS bound to a DIFFERENT tree checkpoint
        # is stale, never closure evidence.
        self._write_receipt("RV-000001", "PASS")
        with patch.object(
            debt_mod,
            "_source_identity",
            return_value={"source_head": "other-head", "source_tree_fingerprint": "other-tree"},
        ):
            self.assertIsNone(debt_mod.current_tree_reverify(self.root, "T-001"))
        with patch.object(
            debt_mod,
            "_source_identity",
            return_value={"source_head": None, "source_tree_fingerprint": "git-delta-v1:abc"},
        ):
            found = debt_mod.current_tree_reverify(self.root, "T-001")
            self.assertIsNotNone(found)
            self.assertEqual(found["receipt_id"], "RV-000001")


class WorkDeltaConsumesReverifyTests(ReverifyFixture):
    def test_work_delta_pass_with_reverify_evidence(self) -> None:
        """The Work-delta gate consumes a valid current-tree PASS reverify
        receipt as closure evidence for a DONE blocker."""
        with patch.object(debt_mod, "capture_findings", return_value=self._canned([])):
            rv = debt_mod.reverify_work(self.root, "T-001", "probe", runs=["exit 0"])
        self.assertTrue(rv["ok"])
        # work_closure_evidence view: current_tree_reverify must surface it
        found = debt_mod.current_tree_reverify(self.root, "T-001")
        self.assertIsNotNone(found)
        self.assertIn(found["verdict"], ("PASS", "PASS_WITH_CARRIED_DEBT"))


if __name__ == "__main__":
    unittest.main()
