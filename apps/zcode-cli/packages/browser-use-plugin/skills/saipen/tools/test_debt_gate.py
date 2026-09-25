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
from saipen_engine import intake  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"


def _canned(entries: list[tuple[str, str, str]]) -> list[dict]:
    """Build structured findings from (severity, message, category) triples."""
    return [
        findings_mod.classify(severity, message, category=category)
        for severity, message, category in entries
    ]


class FindingsIdentityTests(unittest.TestCase):
    """Phase D: stable structured identity, ordering/line stability, secrets."""

    def test_identity_is_deterministic_and_order_free(self) -> None:
        message = (
            "ticket T-102 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)"
        )
        first = findings_mod.classify("problem", message)
        second = findings_mod.classify("problem", message)
        self.assertEqual(first, second)
        other_first = findings_mod.classify(
            "problem",
            "ticket T-31 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)",
        )
        self.assertNotEqual(first["finding_key"], other_first["finding_key"])
        # same broken semantic condition, different subject: the detail
        # fingerprint is identical by design; the KEY is what separates them
        self.assertEqual(first["detail_hash"], other_first["detail_hash"])
        self.assertEqual(first["subject_id"], "T-102")
        self.assertEqual(other_first["subject_id"], "T-31")

    def test_subject_extraction_prefers_semantic_ids_over_line_numbers(self) -> None:
        one = findings_mod.classify(
            "problem",
            "mechanical provenance [saio] -- structural SAIOPS-owned events after the "
            "first provenanced event (E-4) lack `[op: ...]`, so a manual structural "
            "edit cannot be distinguished from a mechanized one: .saipen/LOG.md:410 E-605 (T-584)",
        )
        moved = findings_mod.classify(
            "problem",
            "mechanical provenance [saio] -- structural SAIOPS-owned events after the "
            "first provenanced event (E-4) lack `[op: ...]`, so a manual structural "
            "edit cannot be distinguished from a mechanized one: .saipen/LOG.md:999 E-605 (T-584)",
        )
        self.assertEqual(one["subject_id"], "E-605")
        self.assertEqual(one["finding_key"], moved["finding_key"])
        self.assertNotEqual(one.get("subject_ref"), moved.get("subject_ref"))

    def test_semantic_change_changes_detail_but_not_key_shape(self) -> None:
        before = findings_mod.classify(
            "problem",
            "ticket T-102 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)",
        )
        after = findings_mod.classify(
            "problem",
            "ticket T-102 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: unproven/failed)",
        )
        self.assertEqual(before["finding_key"], after["finding_key"])
        self.assertNotEqual(before["detail_hash"], after["detail_hash"])
        self.assertEqual(findings_mod.compare_finding(before, after), "CHANGED")
        self.assertEqual(findings_mod.compare_finding(before, dict(before)), "CARRIED")

    def test_unknown_message_is_global_and_never_carried(self) -> None:
        finding = findings_mod.classify("problem", "completely novel failure shape")
        self.assertEqual(finding["rule_id"], "unclassified")
        self.assertEqual(finding["subject_kind"], "global")
        self.assertIsNone(finding["subject_id"])

    def test_credential_finding_never_carries_message_content(self) -> None:
        secret = "sk-live-DO-NOT-LEAK-9f8e7d6c5b4a"
        message = (
            "source credential gate: SOURCE_CREDENTIALS_UNSAFE credential pattern "
            f"{secret} in exact archive source SRC-033; supply a user-authorized "
            "replacement or amendment before release"
        )
        finding = findings_mod.classify("problem", message)
        self.assertTrue(finding["credential"])
        self.assertIsNone(finding["detail"])
        self.assertEqual(finding["subject_id"], "SRC-033")
        serialized = json.dumps(finding)
        self.assertNotIn(secret, serialized)
        self.assertNotIn("sk-live", serialized)

    def test_ruleset_fingerprint_covers_the_rule_table(self) -> None:
        fingerprint = findings_mod.ruleset_fingerprint()
        self.assertEqual(fingerprint, findings_mod.ruleset_fingerprint())
        self.assertTrue(len(findings_mod.RULE_TABLE) >= 10)


class DebtGateFixtureTests(unittest.TestCase):
    """Real-engine plumbing: snapshots, delta, fail-closed refusals."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-debt-gate-")
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

    # -- snapshot lifecycle ------------------------------------------------

    def test_snapshot_is_immutable_project_bound_and_reused(self) -> None:
        first = debt_mod.create_snapshot(self.root, "probe", "baseline capture")
        self.assertTrue(first["ok"], first)
        snapshot_id = first["snapshot_id"]
        record = debt_mod.load_snapshot(self.root, snapshot_id)
        self.assertEqual(record["snapshot_id"], snapshot_id)
        self.assertEqual(record["project_lineage"], debt_mod.project_lineage_identity(self.root))
        self.assertTrue(record["ruleset_fingerprint"])
        self.assertIn("journal_op_id", record)
        again = debt_mod.create_snapshot(self.root, "probe", "baseline capture")
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["code"], "DEBT_SNAPSHOT_REUSED")
        self.assertEqual(again["snapshot_id"], snapshot_id)
        # immutability: a new checkpoint (tree changed) creates a NEW snapshot
        intake.capture(self.root, "mutation", source_kind="user_audit")
        second = debt_mod.create_snapshot(self.root, "probe", "after mutation")
        self.assertTrue(second["ok"], second)
        self.assertNotEqual(second["snapshot_id"], snapshot_id)

    def test_corrupted_snapshot_fails_closed(self) -> None:
        created = debt_mod.create_snapshot(self.root, "probe", "capture")
        self.assertTrue(created["ok"], created)
        intake.capture(
            self.root, "seed finding material", source_kind="user_audit", work="T-001"
        )
        seeded = debt_mod.create_snapshot(self.root, "probe", "non-empty capture")
        self.assertTrue(seeded["ok"], seeded)
        self.assertTrue(seeded["problem_count"] >= 1, seeded)
        path = self.root / debt_mod.DEBT_DIR / f"{seeded['snapshot_id']}.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        record["problems"] = []
        path.write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaises(debt_mod.DebtRefusal) as caught:
            debt_mod.load_snapshot(self.root, seeded["snapshot_id"])
        self.assertEqual(caught.exception.code, "DEBT_SNAPSHOT_CORRUPT")

    def test_snapshot_from_another_project_refuses(self) -> None:
        created = debt_mod.create_snapshot(self.root, "probe", "capture")
        self.assertTrue(created["ok"], created)
        other = Path(self.tmp.name) / "other"
        shutil.copytree(self.root, other)
        with self.assertRaises(debt_mod.DebtRefusal) as caught:
            debt_mod.load_snapshot(other, created["snapshot_id"])
        self.assertIn(
            caught.exception.code,
            ("DEBT_SNAPSHOT_FOREIGN_PROJECT", "DEBT_SNAPSHOT_FOREIGN_LINEAGE"),
        )

    def test_ruleset_change_refuses_comparison(self) -> None:
        created = debt_mod.create_snapshot(self.root, "probe", "capture")
        self.assertTrue(created["ok"], created)
        with patch.object(findings_mod, "RULESET_VERSION", 99), patch.object(
            findings_mod, "ruleset_fingerprint", lambda: "stale-fingerprint"
        ), self.assertRaises(debt_mod.DebtRefusal) as caught:
            debt_mod.load_snapshot(self.root, created["snapshot_id"])
        self.assertEqual(caught.exception.code, "BASELINE_RULESET_CHANGED")

    def test_deleted_snapshot_cannot_create_pass(self) -> None:
        created = debt_mod.create_snapshot(self.root, "probe", "capture")
        self.assertTrue(created["ok"], created)
        (self.root / debt_mod.DEBT_DIR / f"{created['snapshot_id']}.json").unlink()
        with self.assertRaises(debt_mod.DebtRefusal) as caught:
            debt_mod.load_snapshot(self.root, created["snapshot_id"])
        self.assertEqual(caught.exception.code, "DEBT_SNAPSHOT_MISSING")

    # -- Work delta (real capture) ------------------------------------------

    def test_delta_resolves_and_reports_release_blocked(self) -> None:
        baseline = debt_mod.create_snapshot(self.root, "probe", "pre-work")
        self.assertTrue(baseline["ok"], baseline)
        base = debt_mod.load_snapshot(self.root, baseline["snapshot_id"])
        # the scenario base itself carries one live Core warning (root-file
        # gate / cross-doc drift); the fixture controls assertions by
        # checking the T-001 family only, never the absolute count.
        base_unresolved = [
            f for f in base["problems"]
            if f["rule_id"] == "source_receipt_unresolved_work" and f["subject_id"] == "T-001"
        ]
        self.assertEqual(len(base_unresolved), 0, base["problems"])
        # the Work's implementation introduces one real validator problem
        result = intake.capture(
            self.root, "audit body for T-001", source_kind="user_audit", work="T-001"
        )
        self.assertTrue(result["ok"], result)
        delta = debt_mod.work_delta(
            self.root,
            "T-001",
            agent="probe",
            baseline_ref=baseline["snapshot_id"],
            verification=[{"command": "unittest probe", "result": "PASS"}],
        )
        self.assertTrue(delta["ok"], delta)
        self.assertEqual(delta["code"], "WORK_DELTA_BLOCKED")
        assert any(f["subject_id"] == "T-001" for f in delta["new"]), delta["new"]
        assert delta["strict_core"]["problems"] >= 1
        self.assertFalse(delta["release_ready"])
        # the mid-work snapshot carries the problem the Work introduced
        mid_snapshot = debt_mod.create_snapshot(self.root, "probe", "mid-work")
        self.assertTrue(mid_snapshot["ok"], mid_snapshot)
        assert any(
            f["rule_id"] == "source_receipt_unresolved_work" and f["subject_id"] == "T-001"
            for f in mid_snapshot.get("problems", [])
        ), mid_snapshot
        # repaired: coverage terminal -> problem RESOLVED, delta PASSes,
        # strict Core returns to its baseline and release stays truthful
        self.assertTrue(
            intake.add_requirement(self.root, "SRC-001", rid="R001", text="the clause")["ok"]
        )
        self.assertTrue(
            intake.set_disposition(
                self.root,
                "SRC-001",
                "R001",
                "VERIFIED",
                evidence="E-1",
                verification="unittest:PASS",
            )["ok"]
        )
        resolved_delta = debt_mod.work_delta(
            self.root,
            "T-001",
            agent="probe",
            baseline_ref=mid_snapshot["snapshot_id"],
            verification=[{"command": "unittest probe", "result": "PASS"}],
        )
        self.assertTrue(resolved_delta["ok"], resolved_delta)
        self.assertEqual(resolved_delta["code"], "WORK_DELTA_PASS")
        self.assertEqual(resolved_delta["work_delta"], "PASS")
        assert any(
            f["rule_id"] == "source_receipt_unresolved_work" and f["subject_id"] == "T-001"
            for f in resolved_delta.get("resolved", [])
        ), resolved_delta
        assert resolved_delta["work_delta"] == "PASS"
        second = debt_mod.work_delta(
            self.root,
            "T-001",
            agent="probe",
            baseline_ref=mid_snapshot["snapshot_id"],
            verification=[{"command": "unittest probe", "result": "PASS"}],
        )
        self.assertEqual(second, resolved_delta)

    def test_delta_requires_verification_evidence(self) -> None:
        baseline = debt_mod.create_snapshot(self.root, "probe", "pre-work")
        self.assertTrue(baseline["ok"], baseline)
        delta = debt_mod.work_delta(
            self.root, "T-001", agent="probe", baseline_ref=baseline["snapshot_id"]
        )
        self.assertTrue(delta["ok"], delta)
        self.assertEqual(delta["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any("verification" in entry["reason"] for entry in delta["blocking"]),
            delta["blocking"],
        )

    def test_delta_without_any_baseline_refuses(self) -> None:
        result = debt_mod.work_delta(
            self.root,
            "T-001",
            agent="probe",
            verification=[{"command": "probe", "result": "PASS"}],
        )
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "DEBT_BASELINE_MISSING")


class WorkDeltaClassificationTests(unittest.TestCase):
    """Phase G delta classes against canned finding sets (precise control)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-debt-classify-")
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

    def _delta(
        self,
        baseline_findings: list[dict],
        current_findings: list[dict],
        *,
        work: str = "T-090",
        verification: list[dict] | None = None,
    ) -> dict:
        with patch.object(
            debt_mod,
            "capture_findings",
            return_value={
                "ok": True,
                "exit_code": 1,
                "gate": "core",
                "problems": baseline_findings,
                "warnings": [],
            },
        ):
            baseline = debt_mod.create_snapshot(self.root, "probe", "baseline")
            self.assertTrue(baseline["ok"], baseline)
        with patch.object(
            debt_mod,
            "capture_findings",
            return_value={
                "ok": True,
                "exit_code": 1,
                "gate": "core",
                "problems": current_findings,
                "warnings": [],
            },
        ):
            return debt_mod.work_delta(
                self.root,
                work,
                agent="probe",
                baseline_ref=baseline["snapshot_id"],
                verification=verification
                or [{"command": "probe tests", "result": "PASS"}],
            )

    def _finding(self, message: str, severity: str = "problem") -> dict:
        return findings_mod.classify(severity, message)

    def test_carried_unrelated_problem_passes_but_keeps_release_blocked(self) -> None:
        message = (
            "ticket T-050 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)"
        )
        baseline = [self._finding(message)]
        report = self._delta(baseline, [self._finding(message)])
        self.assertEqual(report["code"], "WORK_DELTA_PASS")
        self.assertEqual(report["carried_problems"], 1)
        self.assertEqual(report["carried"][0]["subject_id"], "T-050")
        self.assertFalse(report["release_ready"])
        self.assertFalse(report["strict_core"]["ok"])

    def test_new_problem_blocks(self) -> None:
        carried = (
            "ticket T-050 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)"
        )
        fresh = (
            "ticket T-051 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)"
        )
        report = self._delta(
            [self._finding(carried)], [self._finding(carried), self._finding(fresh)]
        )
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertEqual(len(report["new"]), 1)
        self.assertEqual(report["new"][0]["subject_id"], "T-051")

    def test_worsened_problem_blocks(self) -> None:
        warning = findings_mod.classify(
            "warning",
            "ticket T-060 has no ticket-bearing closure event; legacy evidence is not "
            "recorded and is not fabricated",
            category="legacy-closure-evidence",
        )
        problem = findings_mod.classify(
            "problem",
            "ticket T-060 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: unproven/failed)",
        )
        # same rule+subject identity escalated from warning to problem
        problem["finding_key"] = warning["finding_key"]
        report = self._delta([problem], [problem])
        self.assertEqual(report["code"], "WORK_DELTA_PASS")  # same problem set as baseline
        escalated = self._delta([], [problem])
        self.assertEqual(escalated["code"], "WORK_DELTA_BLOCKED")
        self.assertEqual(len(escalated["new"]), 1)

    def test_changed_unsafe_problem_blocks(self) -> None:
        before = findings_mod.classify(
            "problem",
            "ticket T-070 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)",
        )
        after = findings_mod.classify(
            "problem",
            "ticket T-070 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: unproven/failed)",
        )
        report = self._delta([before], [after])
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertEqual(len(report["changed_unsafe"]), 1)

    def test_resolved_problem_is_reported(self) -> None:
        message = (
            "ticket T-080 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)"
        )
        report = self._delta([self._finding(message)], [])
        self.assertEqual(report["code"], "WORK_DELTA_PASS")
        self.assertEqual(len(report["resolved"]), 1)
        self.assertEqual(report["resolved"][0]["subject_id"], "T-080")

    def test_work_attribution_blocks(self) -> None:
        message = (
            "ticket T-090 is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)"
        )
        baseline = [self._finding(message)]
        report = self._delta(baseline, [self._finding(message)], work="T-090")
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any("attributed to Work T-090" in entry["reason"] for entry in report["blocking"]),
            report["blocking"],
        )

    def test_unattributed_global_problem_blocks_even_when_carried(self) -> None:
        message = "completely novel global failure shape"
        baseline = [self._finding(message)]
        report = self._delta(baseline, [self._finding(message)])
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any("unattributed" in entry["reason"] for entry in report["blocking"]),
            report["blocking"],
        )


class LegacyBootstrapTests(unittest.TestCase):
    """Phase J: provenance-aware retroactive adjudication, fail-closed."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-debt-legacy-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        log_path = self.root / ".saipen/LOG.md"
        # Claim boundary E-816; pre-claim work T-050; post-claim work T-200.
        lines = [
            "- 05.09.26 00:19 [E-815] [parent: E-814] [T-050] [agent: probe] [op: op-a] "
            "DEC: pre-claim work created",
            "- 05.09.26 00:20 [E-816] [parent: E-815] [T-158] [agent: probe] [op: op-b] "
            "DEC: claimed via SAIOPS -- owner probe",
            "- 05.09.26 00:21 [E-817] [parent: E-816] [T-200] [agent: probe] [op: op-c] "
            "DEC: post-claim work created",
        ]
        log_path.write_text(
            log_path.read_text(encoding="utf-8") + "\n".join(lines) + "\n", encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _legacy(self, findings_list: list[dict], *, target_source: str | None = None) -> dict:
        with patch.object(
            debt_mod,
            "capture_findings",
            return_value={
                "ok": True,
                "exit_code": 1,
                "gate": "core",
                "problems": findings_list,
                "warnings": [],
            },
        ):
            return debt_mod.work_delta(
                self.root,
                "T-158",
                agent="probe",
                claim_boundary="E-816",
                target_source=target_source,
                verification=[{"command": "regression_t158.py", "result": "PASS"}],
            )

    def _closure_finding(self, ticket: str) -> dict:
        return findings_mod.classify(
            "problem",
            f"ticket {ticket} is ## DONE but carries no current-cycle verification "
            "evidence (classifier: no current-cycle VERIFY boundary)",
        )

    def test_pre_claim_unrelated_subject_is_carried(self) -> None:
        report = self._legacy([self._closure_finding("T-050")])
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["mode"], "legacy")
        self.assertEqual(report["carried_problems"], 1)
        self.assertEqual(report["code"], "WORK_DELTA_PASS")

    def test_target_work_subject_refuses(self) -> None:
        report = self._legacy([self._closure_finding("T-158")])
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any("subject is the target Work" in entry["reason"] for entry in report["blocking"]),
            report["blocking"],
        )

    def test_post_claim_subject_refuses(self) -> None:
        report = self._legacy([self._closure_finding("T-200")])
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any("after claim boundary" in entry["reason"] for entry in report["blocking"]),
            report["blocking"],
        )

    def test_target_source_receipt_refuses(self) -> None:
        finding = findings_mod.classify(
            "problem",
            "active receipt SRC-036 contract/coverage invalid: broken",
        )
        report = self._legacy([finding], target_source="SRC-036")
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any(
                "target Work's source receipt" in entry["reason"]
                for entry in report["blocking"]
            ),
            report["blocking"],
        )

    def test_global_problem_refuses(self) -> None:
        finding = findings_mod.classify("problem", "completely novel global failure")
        report = self._legacy([finding])
        self.assertEqual(report["code"], "WORK_DELTA_BLOCKED")
        self.assertTrue(
            any("unattributed" in entry["reason"] for entry in report["blocking"]),
            report["blocking"],
        )

    def test_claim_boundary_must_exist(self) -> None:
        with patch.object(
            debt_mod,
            "capture_findings",
            return_value={
                "ok": True, "exit_code": 1, "gate": "core", "problems": [], "warnings": [],
            },
        ):
            result = debt_mod.work_delta(
                self.root,
                "T-158",
                agent="probe",
                claim_boundary="E-999999",
                verification=[{"command": "probe", "result": "PASS"}],
            )
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "VALIDATION_FAILED")


class StrictGateInvariantTests(unittest.TestCase):
    """Phase E/H: strict validation semantics are untouched by the feature."""

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

    def test_strict_core_stays_red_with_carried_debt(self) -> None:
        intake.capture(self.root, "audit body", source_kind="user_audit", work="T-001")
        capture = debt_mod.capture_findings(self.root)
        self.assertTrue(capture["ok"], capture)
        self.assertNotEqual(capture["exit_code"], 0)
        unresolved = [
            f for f in capture["problems"]
            if f["rule_id"] == "source_receipt_unresolved_work" and f["subject_id"] == "T-001"
        ]
        self.assertEqual(len(unresolved), 1, capture["problems"])

    def test_debt_feature_adds_no_ignore_path(self) -> None:
        source = (ROOT / "tools" / "saipen_engine" / "debt.py").read_text(encoding="utf-8")
        self.assertNotIn("--ignore-errors", source)
        self.assertNotIn("--force-pass", source)
        validate_source = (ROOT / "tools" / "validate.py").read_text(encoding="utf-8")
        self.assertNotIn("--ignore-errors", validate_source)
        self.assertNotIn("--force-pass", validate_source)

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


if __name__ == "__main__":
    unittest.main()
