"""A credential refusal must lead to the existing, lossless quarantine verb."""

from __future__ import annotations

import hashlib
import json
import shlex
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import intake, release, remediation  # noqa: E402
from saipen_engine.paths import project_identity, project_lineage_identity  # noqa: E402
from saipen_engine.release_contract import release_metadata_paths  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402
from test_orchestration_repair import OrchestrationFixture  # noqa: E402
from test_validator_layout_parity import _build_home  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


class QuarantineRouteTests(OrchestrationFixture):
    def source(self, root: Path, *, archived: bool) -> tuple[str, bytes]:
        body = b"api_key = test-secret-material\n"
        result = intake.capture(root, body.decode(), source_kind="user_audit")
        self.assertTrue(result["ok"], result)
        receipt = result["receipt"]
        self.assertTrue(intake.add_requirement(root, receipt, rid="R001", text="proof")["ok"])
        self.assertTrue(intake.set_disposition(
            root, receipt, "R001", "VERIFIED", evidence="E-1", verification="fixture:PASS"
        )["ok"])
        if archived:
            self.assertTrue(intake.close_receipt(root, receipt, closure_event="E-1")["ok"])
        return receipt, body

    @staticmethod
    def plan(root: Path) -> SimpleNamespace:
        return SimpleNamespace(
            project_identity=project_identity(root),
            project_lineage=project_lineage_identity(root),
            state_hash=release._quick_hash((root / ".saipen/STATE.md").read_text(encoding="utf-8")),
            board_hash=release._quick_hash((root / ".saipen/BOARD.md").read_text(encoding="utf-8")),
            log_hash=release._log_hash(root),
            source_manifest=release._source_authority_manifest(root),
            ticket_id="T-7",
        )

    def test_active_and_archived_refusals_emit_executable_lossless_repair(self):
        for archived in (False, True):
            with self.subTest(archived=archived):
                root = self.make_project()
                receipt, body = self.source(root, archived=archived)
                before_status = intake.status(root, receipt)
                authority = {
                    p: p.read_bytes()
                    for p in (root / ".saipen").rglob("*.json")
                }
                canonical = {
                    name: (root / ".saipen" / name).read_bytes()
                    for name in ("STATE.md", "BOARD.md", "LOG.md")
                }
                gate = intake.release_gate(root)
                command = f"saipen source quarantine {receipt} --reason CREDENTIAL_PATTERN"
                self.assertEqual(gate["code"], "SOURCE_CREDENTIALS_UNSAFE", gate)
                self.assertEqual(gate.get("canonical_next_command"), command, gate)
                self.assertEqual(gate.get("receipt"), receipt)
                self.assertIn(command, remediation.extract_commands(intake.validate_project(root)))
                self.assertTrue(remediation.resolve_command(command)["ok"])

                argv = [
                    sys.executable, "-B", str(TOOLS / "saipen.py"),
                    *shlex.split(command)[1:], "--project-root", str(root), "--json",
                ]
                preview = subprocess.run(
                    [*argv, "--dry-run"], capture_output=True, text=True,
                    encoding="utf-8", env=hermetic_env(), timeout=60,
                )
                self.assertEqual(preview.returncode, 0, preview.stdout + preview.stderr)
                self.assertEqual(json.loads(preview.stdout)["code"], "DRY_RUN_PLAN")
                self.assertFalse(intake.release_gate(root)["ok"], "preview must not clear the gate")
                applied = subprocess.run(
                    argv, capture_output=True, text=True, encoding="utf-8",
                    env=hermetic_env(), timeout=60,
                )
                self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)
                self.assertEqual(json.loads(applied.stdout)["code"], "SOURCE_QUARANTINED")
                self.assertTrue(intake.release_gate(root)["ok"])
                self.assertEqual(intake.validate_project(root), [])
                shown = intake.read_body(root, receipt)
                self.assertEqual(shown["body"].encode(), body)
                protected = f".saipen/quarantine/source/{receipt}.md"
                self.assertEqual((root / protected).read_bytes(), body)
                after_status = intake.status(root, receipt)
                self.assertEqual(after_status["status"], before_status["status"])
                self.assertEqual(after_status["source_sha256"], hashlib.sha256(body).hexdigest())
                exported = {path.as_posix() for path in release_metadata_paths(root)}
                self.assertNotIn(protected, exported)
                self.assertIn(f".saipen/intake/distribution/{receipt}.json", exported)
                for name, original in canonical.items():
                    self.assertEqual((root / ".saipen" / name).read_bytes(), original)
                for path, original in authority.items():
                    self.assertEqual(path.read_bytes(), original, str(path))
                if archived:
                    retry = intake.archive_receipt(root, receipt)
                    self.assertTrue(retry["ok"], retry)
                    self.assertEqual(retry["archive_ref"], protected)

    def test_quarantine_overlay_never_accepts_arbitrary_archive_reference(self):
        root = self.make_project()
        receipt, _ = self.source(root, archived=True)
        self.assertTrue(intake.quarantine_receipt(root, receipt)["ok"])
        path = root / f".saipen/archive/source/{receipt}.meta.json"
        meta = json.loads(path.read_text(encoding="utf-8"))
        meta["archive_ref"] = ".saipen/archive/source/SRC-999.md"
        path.write_text(json.dumps(meta), encoding="utf-8")
        self.assertTrue(
            any("identity/status drift" in error for error in intake.validate_project(root))
        )

    def test_missing_distribution_record_never_accepts_historical_reference(self):
        root = self.make_project()
        receipt, _ = self.source(root, archived=True)
        self.assertTrue(intake.quarantine_receipt(root, receipt)["ok"])
        (root / f".saipen/intake/distribution/{receipt}.json").unlink()
        self.assertFalse(intake.release_gate(root)["ok"])
        self.assertTrue(intake.validate_project(root))

    def test_release_preflight_preserves_source_refusal_route_and_identity(self):
        root = self.make_project()
        receipt, _ = self.source(root, archived=True)
        original = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
        result = release._preflight_plan(root, self.plan(root))
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["stage"], "SOURCE_COVERAGE")
        self.assertEqual(result.get("source_gate", {}).get("code"), "SOURCE_CREDENTIALS_UNSAFE")
        self.assertEqual(
            result.get("canonical_next_command"),
            f"saipen source quarantine {receipt} --reason CREDENTIAL_PATTERN",
        )
        self.assertEqual({p: p.read_bytes() for p in root.rglob("*") if p.is_file()}, original)

    def test_real_validator_receipt_carries_repair_and_turns_green_after_execution(self):
        root = self.make_project()
        receipt, _ = self.source(root, archived=True)
        # The validator also inspects its own HOME. Materialize the declared
        # runtime so unrelated incoming reports in a dirty checkout cannot
        # become this fixture's findings (same oracle as layout parity).
        validator_home = root.parent / "validator-home"
        _build_home(validator_home, flatten=False)
        argv = [
            sys.executable, "-B", str(validator_home / "tools/validate.py"),
            "--project-root", str(root), "--gate", "core",
        ]
        before = subprocess.run(
            argv, capture_output=True, text=True, encoding="utf-8",
            env=hermetic_env(), timeout=60,
        )
        self.assertEqual(before.returncode, 1, before.stdout + before.stderr)
        receipts = list((root / ".saipen/recovery/conformance").glob("*_core_FAIL.json"))
        self.assertEqual(len(receipts), 1, before.stdout + before.stderr)
        record = json.loads(receipts[0].read_text(encoding="utf-8"))
        command = f"saipen source quarantine {receipt} --reason CREDENTIAL_PATTERN"
        self.assertIn(command, record["remediation_commands"])
        self.assertEqual(record["canonical_next_command"], command)
        self.assertTrue(intake.quarantine_receipt(root, receipt)["ok"])
        after = subprocess.run(
            argv, capture_output=True, text=True, encoding="utf-8",
            env=hermetic_env(), timeout=60,
        )
        self.assertEqual(after.returncode, 0, after.stdout + after.stderr)

    def test_other_source_refusals_are_preserved_without_guessing_quarantine(self):
        root = self.make_project()
        cases = (
            {"ok": False, "code": "SOURCE_UNRESOLVED", "receipt": "SRC-001"},
            {"ok": False, "code": "SOURCE_CORRUPTION", "detail": "digest mismatch"},
            {
                "ok": False, "code": "SOURCE_UNRESOLVED",
                "canonical_next_command": "saipen source recover",
            },
        )
        for gate in cases:
            with self.subTest(gate=gate), patch.object(intake, "release_gate", return_value=gate):
                result = release._preflight_plan(root, self.plan(root))
                self.assertEqual(result.get("source_gate"), gate)
                self.assertEqual(
                    result.get("canonical_next_command"), gate.get("canonical_next_command")
                )

    def test_quarantine_does_not_clear_unfinished_coverage(self):
        root = self.make_project()
        receipt = intake.capture(
            root, "api_key = test-secret-material\n", source_kind="user_audit"
        )["receipt"]
        gate = intake.release_gate(root)
        self.assertEqual(gate["code"], "SOURCE_CREDENTIALS_UNSAFE")
        self.assertTrue(intake.quarantine_receipt(root, receipt, reason="CREDENTIAL_PATTERN")["ok"])
        self.assertEqual(intake.release_gate(root)["code"], "SOURCE_UNRESOLVED")

    def test_tampered_body_is_not_offered_quarantine_as_integrity_repair(self):
        root = self.make_project()
        receipt, _ = self.source(root, archived=True)
        (root / f".saipen/archive/source/{receipt}.md").write_text("changed", encoding="utf-8")
        gate = intake.release_gate(root)
        self.assertEqual(gate["code"], "SOURCE_CORRUPTION")
        self.assertNotIn("canonical_next_command", gate)


if __name__ == "__main__":
    unittest.main()
