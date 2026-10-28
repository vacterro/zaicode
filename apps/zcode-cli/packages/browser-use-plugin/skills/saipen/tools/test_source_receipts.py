from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import intake  # noqa: E402
from saipen_engine.context import context_audit, context_cold  # noqa: E402


CLI = ROOT / "tools" / "saipen.py"
SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"


class SourceReceiptTests(unittest.TestCase):
    def test_environment_present_cannot_be_labeled_unavailable(self) -> None:
        receipt = self.capture("conditional host check")["receipt"]
        self.assertTrue(
            intake.add_requirement(
                self.root,
                receipt,
                rid="R001",
                text="validate Kiro when its runtime is available",
                when_environment="kiro",
            )["ok"]
        )
        with patch.object(
            intake,
            "_probe_environment_absence",
            return_value={"ok": False, "code": "ENVIRONMENT_PRESENT", "detail": "kiro exists"},
        ):
            result = intake.set_disposition(
                self.root, receipt, "R001", "UNAVAILABLE_ENVIRONMENT", environment="kiro"
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "ENVIRONMENT_PRESENT")

    def test_mechanically_absent_conditional_environment_is_terminal(self) -> None:
        receipt = self.capture("conditional host check")["receipt"]
        self.assertTrue(
            intake.add_requirement(
                self.root,
                receipt,
                rid="R001",
                text="validate Kiro when its runtime is available",
                when_environment="kiro",
            )["ok"]
        )
        proof = {
            "schema_version": 1,
            "kind": "environment_absence",
            "environment": "kiro",
            "commands": [{"name": "kiro", "path": None}],
            "homes": [{"path": "~/.kiro", "exists": False}],
            "unavailable": True,
            "observed_at": "2026-09-13T00:00:00Z",
        }
        with patch.object(
            intake,
            "_probe_environment_absence",
            return_value={"ok": True, "code": "ENVIRONMENT_ABSENT", "proof": proof},
        ):
            result = intake.set_disposition(
                self.root, receipt, "R001", "UNAVAILABLE_ENVIRONMENT", environment="kiro"
            )
        self.assertTrue(result["ok"], result)
        self.assertEqual(intake.coverage_summary(self.root, receipt)["unresolved"], [])

    def test_unfinished_requirement_cannot_self_waive_as_environment_unavailable(self) -> None:
        receipt = self.capture("unconditional work")["receipt"]
        self.normalized(receipt)
        result = intake.set_disposition(
            self.root, receipt, "R001", "UNAVAILABLE_ENVIRONMENT", environment="kiro"
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "ENVIRONMENT_WAIVER_REFUSED")

    def test_source_recovery_commands_refuse_structurally_when_unavailable(self) -> None:
        for arguments in (("reconcile", "SRC-001"), ("normalize",)):
            with self.subTest(arguments=arguments):
                result = subprocess.run(
                    [sys.executable, str(CLI), "source", *arguments,
                     "--project-root", str(self.root), "--dry-run", "--json"],
                    capture_output=True, text=True, timeout=60,
                )
                self.assertNotIn("Traceback", result.stderr)
                payload = json.loads(result.stdout)
                self.assertIsInstance(payload.get("ok"), bool)

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-source-receipts-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        self.config = Path(self.tmp.name) / "user-config"
        self.env = patch.dict(os.environ, {"SAIPEN_USER_CONFIG_HOME": str(self.config)})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()

    def capture(self, body: str = "authoritative\r\nsource\nΩ") -> dict:
        return intake.capture(self.root, body, source_kind="user_audit")

    def normalized(self, receipt: str, count: int = 1) -> None:
        for number in range(1, count + 1):
            result = intake.add_requirement(
                self.root,
                receipt,
                rid=f"R{number:03d}",
                text=f"Requirement {number}",
            )
            self.assertTrue(result["ok"], result)

    def resolve(self, receipt: str, count: int = 1) -> None:
        for number in range(1, count + 1):
            result = intake.set_disposition(
                self.root,
                receipt,
                f"R{number:03d}",
                "VERIFIED",
                evidence=f"E-{number}",
                verification=f"test-{number}:PASS",
            )
            self.assertTrue(result["ok"], result)

    def test_src01_capture_is_verbatim_and_digest_covers_body_only(self) -> None:
        body = "```py\r\nprint('saipen ship')\r\n```\nРусский 日本語 — !"  # noqa: RUF001
        result = self.capture(body)
        stored = (self.root / ".saipen/intake/active/SRC-001.md").read_bytes()
        self.assertEqual(stored, body.encode("utf-8"))
        self.assertEqual(result["source_sha256"], hashlib.sha256(stored).hexdigest())

    def test_src02_crash_body_before_linkage_is_recoverable(self) -> None:
        body = b"orphan source"
        active = self.root / ".saipen/intake/active"
        active.mkdir(parents=True)
        (active / "SRC-001.md").write_bytes(body)
        found = intake.recover_orphans(self.root)
        self.assertEqual(found["orphans"][0]["receipt"], "SRC-001")
        recovered = intake.capture(self.root, body.decode(), source_kind="user_audit")
        self.assertEqual(recovered["code"], "ORPHAN_RECEIPT_RECOVERED")
        self.assertEqual(recovered["receipt"], "SRC-001")

    def test_src03_work_never_needed_for_source_durability(self) -> None:
        result = self.capture()
        self.assertTrue(result["ok"])
        self.assertTrue((self.root / ".saipen/intake/active/SRC-001.md").is_file())
        self.assertIsNone(result["linked_work"])

    def test_src04_exact_duplicate_reuses_identity(self) -> None:
        first = self.capture("same")
        second = intake.capture(
            self.root, "same", source_kind="user_audit", work="T-001"
        )
        self.assertEqual(first["receipt"], second["receipt"])
        self.assertEqual(second["code"], "SOURCE_DUPLICATE")
        self.assertEqual(second["linked_work"], "T-001")
        self.assertIn(
            "source_receipts: SRC-001",
            (self.root / ".saipen/BOARD.md").read_text(encoding="utf-8"),
        )
        conflict = intake.capture(
            self.root, "same", source_kind="user_audit", work="T-002"
        )
        self.assertEqual(conflict["code"], "SOURCE_WORK_CONFLICT")

    def test_src05_closed_duplicate_reports_history_without_reopen(self) -> None:
        receipt = self.capture("same closed")["receipt"]
        self.normalized(receipt)
        self.resolve(receipt)
        self.assertTrue(intake.close_receipt(self.root, receipt)["ok"])
        duplicate = self.capture("same closed")
        self.assertEqual(duplicate["code"], "SOURCE_DUPLICATE_CLOSED")
        self.assertFalse((self.root / f".saipen/intake/active/{receipt}.md").exists())

    def test_src06_one_character_change_is_new_source(self) -> None:
        self.assertNotEqual(self.capture("abc")["receipt"], self.capture("abd")["receipt"])

    def test_src07_amendment_is_new_immutable_receipt(self) -> None:
        original = self.capture("original")["receipt"]
        amended = intake.capture(
            self.root, "changed requirement 7", source_kind="corrective_followup", amends=original
        )
        self.assertNotEqual(original, amended["receipt"])
        self.assertEqual(intake.status(self.root, amended["receipt"])["amends"], original)
        self.assertEqual(intake.read_body(self.root, original)["body"], "original")

    def test_src08_dropped_contract_clause_is_detected(self) -> None:
        receipt = self.capture()["receipt"]
        self.normalized(receipt, 20)
        contract = self.root / f".saipen/intake/contracts/{receipt}.json"
        value = json.loads(contract.read_text(encoding="utf-8"))
        value["clauses"].pop(f"{receipt}:R020")
        contract.write_text(json.dumps(value), encoding="utf-8")
        problems = intake.validate_project(self.root)
        self.assertTrue(any("contract" in problem.lower() for problem in problems), problems)

    def test_src09_board_summary_cannot_replace_linked_source(self) -> None:
        receipt = intake.capture(
            self.root, "full detailed mission", source_kind="implementation_mission", work="T-001"
        )["receipt"]
        self.assertEqual(intake.active_receipts(self.root)[0]["linked_work"], "T-001")
        self.assertIn(
            f"source_receipts: {receipt}",
            (self.root / ".saipen/BOARD.md").read_text(encoding="utf-8"),
        )
        self.assertEqual(intake.read_body(self.root, receipt)["body"], "full detailed mission")
        shutil.rmtree(self.root / ".saipen/intake")
        self.assertEqual(
            intake.work_closure_gate(self.root, "T-001")["code"],
            "SOURCE_RECEIPT_MISSING",
        )
        self.assertEqual(
            intake.boundary_gate(self.root, "T-001", "REVIEW")["code"],
            "SOURCE_RECEIPT_MISSING",
        )
        self.assertEqual(intake.release_gate(self.root)["code"], "SOURCE_RECEIPT_MISSING")
        self.assertTrue(
            any(
                "missing source receipt" in problem
                for problem in intake.validate_project(self.root)
            )
        )

    def test_src10_cold_context_exposes_identity_not_body(self) -> None:
        body = "SECRET-MARKER " + "x" * 100_000
        receipt = self.capture(body)["receipt"]
        result = context_cold(self.root)
        self.assertTrue(result.ok, result.to_dict())
        surface = result.get("surface")
        self.assertIn(receipt, surface)
        self.assertIn("saipen source show", surface)
        self.assertNotIn("SECRET-MARKER", surface)

    def test_src11_done_gate_rejects_one_unresolved_clause(self) -> None:
        receipt = intake.capture(
            self.root, "linked source", source_kind="user_audit", work="T-001"
        )["receipt"]
        self.normalized(receipt, 2)
        self.resolve(receipt, 1)
        self.assertEqual(intake.work_closure_gate(self.root, "T-001")["code"], "SOURCE_UNRESOLVED")

    def test_src12_umbrella_done_requires_all_17_dispositions(self) -> None:
        receipt = self.capture()["receipt"]
        self.normalized(receipt, 17)
        self.resolve(receipt, 16)
        summary = intake.coverage_summary(self.root, receipt)
        self.assertEqual(summary["terminal"], 16)
        self.assertFalse(intake.coverage_complete(self.root, receipt))

    def test_src13_modified_body_fails_closed(self) -> None:
        receipt = self.capture("immutable")["receipt"]
        (self.root / f".saipen/intake/active/{receipt}.md").write_text("mutated", encoding="utf-8")
        self.assertEqual(intake.verify_integrity(self.root, receipt)["code"], "SOURCE_CORRUPTION")
        self.assertEqual(self.capture("immutable")["code"], "SOURCE_CORRUPTION")

    def test_src14_deleted_active_body_is_validation_failure(self) -> None:
        receipt = self.capture()["receipt"]
        (self.root / f".saipen/intake/active/{receipt}.md").unlink()
        self.assertTrue(any(receipt in problem for problem in intake.validate_project(self.root)))

    def test_src15_close_archives_and_removes_hot_body(self) -> None:
        receipt = self.capture()["receipt"]
        self.normalized(receipt)
        self.resolve(receipt)
        result = intake.close_receipt(self.root, receipt, closure_event="E-9")
        self.assertTrue(result["ok"], result)
        self.assertFalse((self.root / f".saipen/intake/active/{receipt}.md").exists())
        self.assertTrue((self.root / f".saipen/archive/source/{receipt}.md").is_file())
        self.assertTrue((self.root / f".saipen/intake/tombstones/{receipt}.json").is_file())

    def test_src16_archived_body_is_forensic_only(self) -> None:
        receipt = self.capture("forensic payload")["receipt"]
        self.normalized(receipt)
        self.resolve(receipt)
        intake.close_receipt(self.root, receipt)
        self.assertEqual(intake.active_receipts(self.root), [])
        self.assertEqual(intake.read_body(self.root, receipt)["body"], "forensic payload")
        self.assertNotIn("source receipt", json.dumps(context_audit(self.root).to_dict()))

    def test_src17_purge_keeps_honest_tombstone(self) -> None:
        receipt = self.capture()["receipt"]
        self.normalized(receipt)
        self.resolve(receipt)
        intake.close_receipt(self.root, receipt)
        self.assertTrue(intake.purge_receipt(self.root, receipt)["ok"])
        self.assertEqual(intake.read_body(self.root, receipt)["code"], "SOURCE_PURGED")
        self.assertEqual(intake.status(self.root, receipt)["location"], "purged")

    def test_src18_no_receipts_means_no_files_or_context_noise(self) -> None:
        shutil.rmtree(self.root / ".saipen/intake", ignore_errors=True)
        before = set(self.root.rglob("*"))
        self.assertEqual(intake.active_receipts(self.root), [])
        surface = context_cold(self.root).get("surface")
        self.assertNotIn("SOURCE RECEIPTS", surface)
        self.assertEqual(before, set(self.root.rglob("*")))

    def test_src19_non_actionable_examples_do_not_become_fake_requirements(self) -> None:
        receipt = self.capture()["receipt"]
        intake.add_requirement(self.root, receipt, rid="R001", text="why", clause_class="rationale")
        self.assertEqual(intake.coverage_summary(self.root, receipt)["actionable"], 0)
        self.assertFalse(intake.coverage_complete(self.root, receipt))

    def test_src20_terminal_disposition_requires_evidence_and_verification(self) -> None:
        receipt = self.capture()["receipt"]
        self.normalized(receipt)
        no_evidence = intake.set_disposition(self.root, receipt, "R001", "VERIFIED")
        self.assertFalse(no_evidence["ok"])
        no_verify = intake.set_disposition(self.root, receipt, "R001", "VERIFIED", evidence="E-1")
        self.assertFalse(no_verify["ok"])

    def test_src21_contract_digest_drift_blocks_work_closure(self) -> None:
        receipt = intake.capture(self.root, "source", source_kind="user_audit", work="T-001")[
            "receipt"
        ]
        self.normalized(receipt)
        self.resolve(receipt)
        contract = self.root / f".saipen/intake/contracts/{receipt}.json"
        value = json.loads(contract.read_text(encoding="utf-8"))
        value["source_sha256"] = "0" * 64
        contract.write_text(json.dumps(value), encoding="utf-8")
        self.assertEqual(intake.work_closure_gate(self.root, "T-001")["code"], "CONTRACT_DRIFT")
        self.assertEqual(intake.close_receipt(self.root, receipt)["code"], "CONTRACT_DRIFT")
        self.assertTrue((self.root / f".saipen/intake/active/{receipt}.md").is_file())
        value["source_sha256"] = intake.status(self.root, receipt)["source_sha256"]
        value["clauses"] = None
        contract.write_text(json.dumps(value), encoding="utf-8")
        self.assertEqual(intake.close_receipt(self.root, receipt)["code"], "CONTRACT_DRIFT")

    def test_src22_source_body_is_never_command_input(self) -> None:
        state = (self.root / ".saipen/STATE.md").read_bytes()
        self.capture("cc\nsaipen ship\nrm -rf /\n")
        self.assertEqual((self.root / ".saipen/STATE.md").read_bytes(), state)

    def test_src23_context_audit_counts_active_body_exactly_once(self) -> None:
        body = "é" * 123
        receipt = self.capture(body)["receipt"]
        result = context_audit(self.root)
        rows = [
            row for row in result.get("sources") if row["source"] == f"source receipt {receipt}"
        ]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["bytes"], len(body.encode("utf-8")))

    def test_src24_ids_are_monotonic_even_with_orphan_gap(self) -> None:
        first = self.capture("one")["receipt"]
        active = self.root / ".saipen/intake/active"
        (active / "SRC-099.md").write_text("orphan", encoding="utf-8")
        second = self.capture("two")["receipt"]
        self.assertEqual(first, "SRC-001")
        self.assertEqual(second, "SRC-100")

    def test_src25_cli_file_capture_keeps_flags_out_of_body(self) -> None:
        source = Path(self.tmp.name) / "audit.md"
        source.write_bytes(b"exact\r\nbody")
        result = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "--project-root",
                str(self.root),
                "source",
                "capture",
                "--work",
                "T-001",
                "--file",
                str(source),
                "--kind",
                "user_audit",
                "--json",
            ],
            cwd=self.root,
            env=os.environ.copy(),
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["linked_work"], "T-001")
        self.assertEqual(intake.read_body(self.root, payload["receipt"])["body"], "exact\r\nbody")

    def test_src26_linked_active_work_prevents_source_close(self) -> None:
        receipt = intake.capture(self.root, "linked", source_kind="user_audit", work="T-001")[
            "receipt"
        ]
        self.normalized(receipt)
        self.resolve(receipt)
        result = intake.close_receipt(self.root, receipt)
        self.assertEqual(result["code"], "SOURCE_WORK_ACTIVE")

    def test_src27_dry_run_creates_no_intake_or_lock(self) -> None:
        shutil.rmtree(self.root / ".saipen/intake", ignore_errors=True)
        lock = self.root / ".saipen/locks/core.lock"
        if lock.exists():
            lock.unlink()
        result = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "--project-root",
                str(self.root),
                "--dry-run",
                "source",
                "capture",
                "mission",
                "--json",
            ],
            cwd=self.root,
            env=os.environ.copy(),
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / ".saipen/intake").exists())
        self.assertFalse(lock.exists())

    def test_src28_malformed_ledger_fails_without_rewrite(self) -> None:
        receipt = self.capture()["receipt"]
        ledger = self.root / f".saipen/intake/coverage/{receipt}.json"
        ledger.write_text("{broken", encoding="utf-8")
        before = ledger.read_bytes()
        result = intake.add_requirement(self.root, receipt, rid="R001", text="x")
        self.assertFalse(result["ok"])
        self.assertEqual(ledger.read_bytes(), before)

    def test_src29_purge_cli_requires_confirmation(self) -> None:
        receipt = self.capture()["receipt"]
        self.normalized(receipt)
        self.resolve(receipt)
        intake.close_receipt(self.root, receipt)
        result = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "--project-root",
                str(self.root),
                "source",
                "purge",
                receipt,
                "--json",
            ],
            cwd=self.root,
            env=os.environ.copy(),
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["code"], "CONFIRMATION_REQUIRED")
        self.assertTrue((self.root / f".saipen/archive/source/{receipt}.md").is_file())

    def test_src30_integrated_30_clause_resume_and_closure(self) -> None:
        body = "\n".join(f"Requirement {number}" for number in range(1, 31))
        receipt = self.capture(body)["receipt"]
        self.normalized(receipt, 30)
        self.resolve(receipt, 18)
        self.assertEqual(intake.coverage_summary(self.root, receipt)["terminal"], 18)
        self.resolve(receipt, 29)
        self.assertFalse(intake.coverage_complete(self.root, receipt))
        intake.set_disposition(
            self.root,
            receipt,
            "R030",
            "VERIFIED",
            evidence="E-30",
            verification="final:PASS",
        )
        self.assertTrue(intake.coverage_complete(self.root, receipt))
        self.assertTrue(intake.close_receipt(self.root, receipt)["ok"])
        self.assertEqual(self.capture(body)["code"], "SOURCE_DUPLICATE_CLOSED")

    def test_src31_capture_criteria_are_bounded_not_length_only(self) -> None:
        ordinary = intake.capture_worthy("x" * 200_000)
        mission = intake.capture_worthy(
            "# Implementation mission\n1. Must preserve bytes\n"
            "2. Must verify digest\n3. Do not lose Work linkage"
        )
        self.assertFalse(ordinary["capture_required"])
        self.assertTrue(mission["capture_required"])
        self.assertTrue(intake.capture_worthy("short", explicit=True)["capture_required"])

    def test_src32_receipt_id_cannot_traverse_project_paths(self) -> None:
        outside = Path(self.tmp.name) / "outside.md"
        outside.write_text("do not read", encoding="utf-8")
        for operation in (
            intake.read_body,
            intake.status,
            intake.verify_integrity,
            intake.close_receipt,
            intake.archive_receipt,
            intake.purge_receipt,
        ):
            result = operation(self.root, "../../outside")
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "INVALID_ID")
        self.assertEqual(outside.read_text(encoding="utf-8"), "do not read")

        board = self.root / ".saipen/BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "T-001 DOING task",
                "T-001 DOING task | source_receipts: ../../outside",
                1,
            ),
            encoding="utf-8",
        )
        boundary = intake.boundary_gate(self.root, "T-001", "BUILD")
        self.assertEqual(boundary["code"], "INVALID_ID")

        cli = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "--project-root",
                str(self.root),
                "source",
                "req",
                "../../outside",
                "R001",
                "requirement",
                "must not escape",
                "--json",
            ],
            cwd=self.root,
            env=os.environ.copy(),
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(cli.returncode, 0, cli.stdout + cli.stderr)
        self.assertEqual(json.loads(cli.stdout)["code"], "INVALID_ID")

    def test_inc_lossy_work_summary_001_cold_agent_recovers_full_intent(self) -> None:
        receipt = self.capture(
            "FF session-local\nXX preview\nVV existing architecture\nZZ stable IDs"
        )["receipt"]
        self.normalized(receipt, 4)
        cold = context_cold(self.root).get("surface")
        self.assertIn(receipt, cold)
        self.assertIn("FF session-local", intake.read_body(self.root, receipt)["body"])

    def test_inc_repeated_audit_uncertainty_001(self) -> None:
        first = self.capture("the audit")
        self.normalized(first["receipt"], 4)
        self.resolve(first["receipt"], 3)
        again = self.capture("the audit")
        self.assertEqual(again["receipt"], first["receipt"])
        self.assertEqual(again["coverage"]["unresolved"], ["SRC-001:R004"])

    def test_inc_archive_context_pollution_001(self) -> None:
        for number in range(50):
            receipt = self.capture(f"historical audit {number}")["receipt"]
            self.normalized(receipt)
            self.resolve(receipt)
            intake.close_receipt(self.root, receipt)
        self.assertEqual(intake.active_receipts(self.root), [])
        cold = context_cold(self.root).get("surface")
        self.assertNotIn("historical audit", cold)

    # ------------------------------------------------------------------
    # T-1399: release closure is scoped to release-relevant Work, while
    # repository authority/integrity stays global.
    # ------------------------------------------------------------------

    def _release_board(self) -> None:
        (self.root / ".saipen/BOARD.md").write_text(
            "# Board\n"
            "## DOING\n"
            "- [/] T-001 DOING task\n"
            "## TODO\n"
            "## DONE\n"
            "- [x] T-002 finished independent task | verify: independent\n"
            "## BLOCKED\n"
            "- [ ] T-003 parked unrelated task | verify: parked | "
            "blocker: external owner | blocker_scope: ticket\n",
            encoding="utf-8",
        )

    def _record_scope(self, ticket: str, paths: list[str]) -> None:
        from freshness import compute_source_identity
        from saipen_engine.operations import release_scope_hash
        from saipen_engine.paths import project_identity, project_lineage_identity

        identity = compute_source_identity(self.root)
        hashes = {
            path: release_scope_hash((self.root / path).read_bytes())
            for path in paths
        }

        record = {
            "schema_version": 2,
            "ticket": ticket,
            "project_identity": project_identity(self.root),
            "project_lineage": project_lineage_identity(self.root),
            "source_head": identity.source_head,
            "source_tree_fingerprint": identity.source_tree_fingerprint,
            "paths": hashes,
            "recorded_at": "2026-09-19T00:00:00Z",
            "op_id": "scope-fixture",
        }
        scope_dir = self.root / ".saipen/kitchen/release_scope"
        scope_dir.mkdir(parents=True, exist_ok=True)
        (scope_dir / f"{ticket}.json").write_text(
            json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

    def _scope_file(self, path: str, body: str = "reviewed bytes\n") -> None:
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(self.root), *args],
            capture_output=True,
            text=True,
            check=False,
        )

    def _init_git(self) -> bool:
        if self._git("init", "-q").returncode != 0:
            return False
        self._git("config", "user.email", "probe@example.invalid")
        self._git("config", "user.name", "probe")
        return True

    def _commit_all(self, message: str) -> bool:
        return (
            self._git("add", "-A").returncode == 0
            and self._git("commit", "-q", "-m", message).returncode == 0
        )

    def _complete_work(self, body: str, work: str) -> str:
        receipt = intake.capture(
            self.root, body, source_kind="user_instruction", work=work
        )["receipt"]
        self.assertTrue(
            intake.add_requirement(self.root, receipt, rid="R001", text="deliver")["ok"]
        )
        self.resolve(receipt)
        return receipt

    def _incomplete_work(self, body: str, work: str) -> str:
        receipt = intake.capture(
            self.root, body, source_kind="user_instruction", work=work
        )["receipt"]
        self.assertTrue(
            intake.add_requirement(self.root, receipt, rid="R001", text="never done")["ok"]
        )
        return receipt

    def test_t1399_primary_independent_work_releases_over_unrelated_parked_work(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        parked = self._incomplete_work("unrelated parked source", "T-003")
        self._scope_file("release.py")
        self._scope_file("parked.py")
        self._record_scope("T-002", ["release.py"])
        self._record_scope("T-003", ["parked.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertTrue(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_RELEASE_COVERAGE_COMPLETE", gate)
        # The parked Work stays BLOCKED/unresolved and is never mutated.
        self.assertEqual(
            intake.coverage_summary(self.root, parked)["unresolved"], [f"{parked}:R001"]
        )
        self.assertIn("T-003", (self.root / ".saipen/BOARD.md").read_text(encoding="utf-8"))

    def test_t1399_current_work_incomplete_still_blocks(self) -> None:
        self._release_board()
        self._incomplete_work("unfinished current source", "T-002")
        self._scope_file("release.py")
        self._record_scope("T-002", ["release.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_UNRESOLVED", gate)

    def test_t1399_relevant_overlapping_work_still_blocks(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("parked but relevant source", "T-003")
        self._scope_file("shared.py")
        self._record_scope("T-002", ["shared.py"])
        self._record_scope("T-003", ["shared.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_UNRESOLVED", gate)

    def test_t1399_unprojected_authoritative_receipt_still_blocks(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        orphan = self._incomplete_work("unprojected parked source", "T-003")
        meta_path = self.root / f".saipen/intake/active/{orphan}.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["linked_work"] = None
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        index = intake._read_index(self.root)
        index["active"][orphan]["linked_work"] = None
        intake._write_index(self.root, index)
        board = (self.root / ".saipen/BOARD.md").read_text(encoding="utf-8").replace(
            f" | source_receipts: {orphan}", ""
        )
        (self.root / ".saipen/BOARD.md").write_text(board, encoding="utf-8")
        self._scope_file("release.py")
        self._record_scope("T-002", ["release.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_UNRESOLVED", gate)

    def test_t1399_corrupt_unrelated_receipt_still_blocks_globally(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        parked = self._incomplete_work("unrelated parked source", "T-003")
        self._scope_file("release.py")
        self._scope_file("parked.py")
        self._record_scope("T-002", ["release.py"])
        self._record_scope("T-003", ["parked.py"])
        (self.root / f".saipen/intake/active/{parked}.md").write_text(
            "tampered", encoding="utf-8"
        )

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_CORRUPTION", gate)

    def test_t1399_sensitive_unrelated_receipt_still_blocks_globally(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("api_key = sk-live-secret-value", "T-003")
        self._scope_file("release.py")
        self._scope_file("parked.py")
        self._record_scope("T-002", ["release.py"])
        self._record_scope("T-003", ["parked.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_CREDENTIALS_UNSAFE", gate)

    def test_t1399_scope_follows_repository_wide_when_no_target_is_named(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("unrelated parked source", "T-003")

        gate = intake.release_gate(self.root)

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_UNRESOLVED", gate)

    def test_t1405_missing_other_work_scope_fails_closed(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("unresolved source with unknown scope", "T-003")
        self._scope_file("release.py")
        self._record_scope("T-002", ["release.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_SCOPE_MISSING", gate)
        self.assertEqual(gate["work"], "T-003", gate)
        self.assertEqual(gate["scope_status"], "NO_SCOPE", gate)

    def test_t1405_stale_other_work_scope_fails_closed(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("unresolved source with stale scope", "T-003")
        self._scope_file("release.py")
        self._scope_file("parked.py")
        self._scope_file("generation.txt", "before\n")
        self._record_scope("T-003", ["parked.py"])
        self._scope_file("generation.txt", "after\n")
        self._record_scope("T-002", ["release.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "STALE_PLAN", gate)
        self.assertEqual(gate["work"], "T-003", gate)
        self.assertEqual(gate["scope_status"], "STALE_SCOPE", gate)

    def test_t1405_continuation_scope_stays_trusted_when_reviewed_head_is_an_ancestor(
        self,
    ) -> None:
        """A scope reviewed before the release's own commits stays trusted.

        RED on the pre-fix gate: it loaded the scope with continuation=False,
        so ANY later HEAD movement -- the release content/closure commits, the
        post-release retry, the fresh-clone continuation -- reported
        STALE_SCOPE while the reviewed bytes were untouched. The gate now
        accepts the writer's continuation contract (reviewed HEAD is an
        ancestor of live HEAD + exact reviewed path hashes); the stale
        fingerprint and tampered hash controls above still refuse, and the
        tampered byte check below proves the continuation path is not a bypass.
        """
        if not self._init_git():
            self.skipTest("git unavailable")
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("unresolved source with reviewed scope", "T-003")
        self._scope_file("release.py")
        self._scope_file("parked.py")
        self.assertTrue(self._commit_all("baseline"), "fixture baseline commit failed")
        self._record_scope("T-003", ["parked.py"])
        self._scope_file("later_metadata.txt", "not part of the reviewed scope\n")
        self.assertTrue(self._commit_all("release content"), "fixture release commit failed")
        self._record_scope("T-002", ["release.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertTrue(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_RELEASE_COVERAGE_COMPLETE", gate)

        # Negative control: the continuation binding still refuses when the
        # reviewed bytes themselves moved after review. T-002's binding is
        # refreshed first so the assert can only be answered by T-003's
        # continuation load, never by T-002's fingerprint mismatch.
        self._scope_file("parked.py", "tampered after review\n")
        self._record_scope("T-002", ["release.py"])
        stale = intake.release_gate(self.root, "T-002")
        self.assertFalse(stale["ok"], stale)
        self.assertEqual(stale["code"], "STALE_PLAN", stale)
        self.assertEqual(stale["work"], "T-003", stale)
        self.assertEqual(stale["scope_status"], "STALE_SCOPE", stale)

    def test_t1405_tampered_other_work_path_hash_fails_closed(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("unresolved source with tampered scope", "T-003")
        self._scope_file("release.py")
        scoped = ".saipen/kitchen/t1405-tampered.py"
        self._scope_file(scoped, "reviewed\n")
        self._record_scope("T-003", [scoped])
        self._scope_file(scoped, "tampered\n")
        self._record_scope("T-002", ["release.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "STALE_PLAN", gate)
        self.assertEqual(gate["work"], "T-003", gate)
        self.assertEqual(gate["scope_status"], "STALE_SCOPE", gate)

    def test_t1405_foreign_other_work_scope_fails_closed(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("unresolved source with foreign scope", "T-003")
        self._scope_file("release.py")
        self._scope_file("parked.py")
        self._record_scope("T-002", ["release.py"])
        self._record_scope("T-003", ["parked.py"])
        path = self.root / ".saipen/kitchen/release_scope/T-003.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        record["project_lineage"] = "lineage-foreign"
        path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "PATH_ESCAPE", gate)
        self.assertEqual(gate["work"], "T-003", gate)
        self.assertEqual(gate["scope_status"], "FOREIGN_SCOPE", gate)

    def test_t1405_invalid_other_work_scope_fails_closed(self) -> None:
        self._release_board()
        self._complete_work("independent verified source", "T-002")
        self._incomplete_work("unresolved source with invalid scope", "T-003")
        self._scope_file("release.py")
        self._scope_file("parked.py")
        self._record_scope("T-002", ["release.py"])
        self._record_scope("T-003", ["parked.py"])
        path = self.root / ".saipen/kitchen/release_scope/T-003.json"
        path.write_text("{not-json\n", encoding="utf-8")

        gate = intake.release_gate(self.root, "T-002")

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "RECOVERY_CONFLICT", gate)
        self.assertEqual(gate["work"], "T-003", gate)
        self.assertEqual(gate["scope_status"], "INVALID_SCOPE", gate)

    def test_t1400_filename_credential_can_be_quarantined_without_body_mutation(self) -> None:
        body = "attachment: customer-prod-credential-fragment-001.txt\n"
        captured = self.capture(body)
        receipt = captured["receipt"]
        digest = captured["source_sha256"]
        self.assertFalse(intake._looks_sensitive(body))
        self.assertEqual(
            intake._legacy_sensitive_source_gate(self.root)["code"],
            "SOURCE_CREDENTIALS_SAFE",
        )

        result = intake.quarantine_receipt(
            self.root, receipt, reason="CREDENTIAL_FILENAME"
        )

        self.assertTrue(result["ok"], result)
        protected = self.root / f".saipen/quarantine/source/{receipt}.md"
        self.assertEqual(protected.read_bytes(), body.encode("utf-8"))
        self.assertEqual(hashlib.sha256(protected.read_bytes()).hexdigest(), digest)
        self.assertFalse((self.root / f".saipen/intake/active/{receipt}.md").exists())
        self.assertEqual(intake.read_body(self.root, receipt)["body"], body)
        self.assertEqual(intake.verify_integrity(self.root, receipt)["code"], "SOURCE_INTEGRITY_OK")

    def test_t1400_release_surface_exports_record_never_quarantined_body(self) -> None:
        from saipen_engine.release_contract import source_authority_paths

        body = "attachment: operator-marked-private-name-001.txt\n"
        receipt = self.capture(body)["receipt"]
        before = {path.as_posix() for path in source_authority_paths(self.root)}
        self.assertIn(f".saipen/intake/active/{receipt}.md", before)

        intake.quarantine_receipt(self.root, receipt, reason="OPERATOR_MARKED")
        first = source_authority_paths(self.root)
        second = source_authority_paths(self.root)
        selected = {path.as_posix() for path in first}

        self.assertEqual(first, second, "export retry must recompute the same live policy")
        self.assertNotIn(f".saipen/intake/active/{receipt}.md", selected)
        self.assertNotIn(f".saipen/quarantine/source/{receipt}.md", selected)
        record_rel = f".saipen/intake/distribution/{receipt}.json"
        self.assertIn(record_rel, selected)
        record = json.loads((self.root / record_rel).read_text(encoding="utf-8"))
        self.assertEqual(record["receipt_id"], receipt)
        self.assertEqual(record["source_sha256"], hashlib.sha256(body.encode()).hexdigest())
        self.assertEqual(record["state"], "QUARANTINED")
        exported = b"\n".join(
            (self.root / path).read_bytes() for path in first if (self.root / path).is_file()
        )
        self.assertNotIn(body.encode(), exported)

    def test_t1400_normal_distributable_receipt_export_is_unchanged(self) -> None:
        from saipen_engine.release_contract import source_authority_paths

        receipt = self.capture("ordinary distributable source\n")["receipt"]
        selected = {path.as_posix() for path in source_authority_paths(self.root)}

        self.assertIn(f".saipen/intake/active/{receipt}.md", selected)
        self.assertEqual(
            intake.distribution_status(self.root, receipt)["state"], "DISTRIBUTABLE"
        )

    def test_t1400_quarantined_active_receipt_keeps_execution_and_coverage(self) -> None:
        body = "operator-private attachment path\n"
        captured = intake.capture(
            self.root, body, source_kind="user_audit", work="T-001"
        )
        receipt = captured["receipt"]
        self.assertTrue(intake.quarantine_receipt(self.root, receipt)["ok"])

        self.normalized(receipt)
        self.resolve(receipt)

        self.assertEqual(intake.read_body(self.root, receipt)["body"], body)
        self.assertEqual(intake.status(self.root, receipt)["linked_work"], "T-001")
        self.assertTrue(intake.coverage_complete(self.root, receipt))
        self.assertEqual(intake.validate_project(self.root), [])

    def test_t1400_quarantined_archived_receipt_retains_exact_local_authority(self) -> None:
        body = "archive-private operator source\n"
        captured = self.capture(body)
        receipt = captured["receipt"]
        self.normalized(receipt)
        self.resolve(receipt)
        self.assertTrue(intake.quarantine_receipt(self.root, receipt)["ok"])

        closed = intake.close_receipt(self.root, receipt, closure_event="E-TEST")

        self.assertTrue(closed["ok"], closed)
        self.assertEqual(
            closed["archive_ref"], f".saipen/quarantine/source/{receipt}.md"
        )
        shown = intake.read_body(self.root, receipt)
        self.assertTrue(shown["ok"], shown)
        self.assertEqual(shown["body"], body)
        self.assertEqual(shown["distribution"]["state"], "QUARANTINED")
        self.assertEqual(intake.validate_project(self.root), [])

    def test_t1400_quarantine_survives_dedupe_and_amendment(self) -> None:
        body = "private dedupe source\n"
        receipt = self.capture(body)["receipt"]
        self.assertTrue(intake.quarantine_receipt(self.root, receipt)["ok"])

        duplicate = self.capture(body)
        amendment = intake.capture(
            self.root,
            "safe replacement source\n",
            source_kind="user_audit",
            amends=receipt,
        )

        self.assertEqual(duplicate["receipt"], receipt)
        self.assertEqual(duplicate["distribution"]["state"], "QUARANTINED")
        self.assertNotEqual(amendment["receipt"], receipt)
        self.assertEqual(amendment["distribution"]["state"], "DISTRIBUTABLE")
        self.assertEqual(intake.distribution_status(self.root, receipt)["state"], "QUARANTINED")

    def test_t1400_matching_credential_is_publishable_only_after_quarantine(self) -> None:
        receipt = self.capture("api_key = test-secret-material\n")["receipt"]
        before = intake._legacy_sensitive_source_gate(self.root)
        self.assertFalse(before["ok"], before)
        self.assertEqual(before["code"], "SOURCE_CREDENTIALS_UNSAFE")

        self.assertTrue(
            intake.quarantine_receipt(self.root, receipt, reason="CREDENTIAL_PATTERN")["ok"]
        )
        after = intake._legacy_sensitive_source_gate(self.root)

        self.assertTrue(after["ok"], after)
        self.assertIn(receipt, after["quarantined"])

    def test_t1400_release_gate_accepts_verified_quarantined_current_work(self) -> None:
        self._release_board()
        receipt = self._complete_work("api_key = test-secret-material\n", "T-002")
        self.assertTrue(
            intake.quarantine_receipt(
                self.root, receipt, reason="CREDENTIAL_PATTERN"
            )["ok"]
        )
        self._scope_file("release.py")
        self._record_scope("T-002", ["release.py"])

        gate = intake.release_gate(self.root, "T-002")

        self.assertTrue(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_RELEASE_COVERAGE_COMPLETE")

    def test_t1400_metadata_cannot_unset_canonical_quarantine(self) -> None:
        receipt = self.capture("arbitrary operator-private source\n")["receipt"]
        self.assertTrue(intake.quarantine_receipt(self.root, receipt)["ok"])
        meta_path = self.root / f".saipen/intake/active/{receipt}.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["distribution"] = {"state": "DISTRIBUTABLE"}
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        status = intake.distribution_status(self.root, receipt)

        self.assertTrue(status["ok"], status)
        self.assertEqual(status["state"], "QUARANTINED")
        self.assertEqual(
            intake.read_body(self.root, receipt)["distribution"]["state"],
            "QUARANTINED",
        )

    def test_t1400_tampered_distribution_digest_fails_closed(self) -> None:
        receipt = self.capture("private source\n")["receipt"]
        self.assertTrue(intake.quarantine_receipt(self.root, receipt)["ok"])
        record_path = self.root / f".saipen/intake/distribution/{receipt}.json"
        record = json.loads(record_path.read_text(encoding="utf-8"))
        record["source_sha256"] = "0" * 64
        record_path.write_text(
            json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )

        self.assertEqual(
            intake.distribution_status(self.root, receipt)["code"], "SOURCE_CORRUPTION"
        )
        self.assertEqual(intake.verify_integrity(self.root, receipt)["code"], "SOURCE_CORRUPTION")

    def test_t1400_handoff_filter_excludes_only_protected_authority(self) -> None:
        from build_handoff_archive import _is_delivery_source

        self.assertFalse(
            _is_delivery_source(
                self.root, ".saipen/quarantine/source/SRC-001.md"
            )
        )
        self.assertTrue(
            _is_delivery_source(
                self.root, ".saipen/intake/distribution/SRC-001.json"
            )
        )

    def test_t1400_cli_quarantine_is_explicit_and_dry_run_is_pure(self) -> None:
        receipt = self.capture("cli-private source\n")["receipt"]
        active = self.root / f".saipen/intake/active/{receipt}.md"
        original = active.read_bytes()
        command = [
            sys.executable,
            str(CLI),
            "source",
            "quarantine",
            receipt,
            "--reason",
            "OPERATOR_POLICY",
            "--project-root",
            str(self.root),
            "--json",
        ]

        preview = subprocess.run(
            [*command, "--dry-run"], capture_output=True, text=True, timeout=60
        )
        self.assertEqual(preview.returncode, 0, preview.stderr or preview.stdout)
        self.assertEqual(json.loads(preview.stdout)["code"], "DRY_RUN_PLAN")
        self.assertEqual(active.read_bytes(), original)

        applied = subprocess.run(command, capture_output=True, text=True, timeout=60)
        self.assertEqual(applied.returncode, 0, applied.stderr or applied.stdout)
        self.assertEqual(json.loads(applied.stdout)["code"], "SOURCE_QUARANTINED")
        self.assertFalse(active.exists())


if __name__ == "__main__":
    unittest.main()
