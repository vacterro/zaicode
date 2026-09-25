"""SRC-026:R004 -- dry-run PLAN/APPLY purity regressions (T-1304).

The hard protocol invariant under test:

    PLAN / DRY-RUN WRITES ZERO PROJECT BYTES.

A dry-run snapshot must not create, modify, delete, rename or lock any
project artifact -- including hidden recovery/conformance/identity/index/
journal surfaces -- and it must report the REAL structured finding set
through the explicit internal read-only validator capture (never a
fabricated empty set). A read-only capture failure must fail closed with a
structured refusal, never fall through into APPLY.

Coverage map (SRC-026:R004 VERIFY):
  A. bootstrap project, byte-identical tree, no IDENTITY/recovery artifacts
  B. mature project (identity/recovery/conformance present), exact byte
     equality, no index timestamp/content change
  C. validator FAIL preview: real problem counts, byte-pure, no FAIL receipt
  D. validator PASS preview: byte-pure, no PASS receipt
  E. hostile mutation-boundary spies: dry-run never calls run_mutation,
     ensure_project_lineage or the ordinary receipt-emitting capture
  F. real APPLY control: journaled immutable snapshot still created, dedup
     intact
  G. repeated dry-run: identical bytes, no accumulation, deterministic plan
  + fail-closed control: read-only capture failure is a structured refusal,
    never zero findings.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

from saipen_engine import debt as debt_mod  # noqa: E402
from saipen_engine import intake  # noqa: E402
from saipen_engine import journal as journal_mod  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"

CONFORMANCE_DIR = ".saipen/recovery/conformance"
RECEIPT_SUFFIXES = ("_core_PASS.json", "_core_FAIL.json")


def _tree_state(root: Path) -> tuple[dict[str, tuple[bytes, int]], list[str]]:
    """Exact project snapshot: every file's (bytes, mtime_ns) + directory set.

    Byte equality catches content/index changes; mtime_ns catches a touched
    file whose bytes happened to be rewritten identically; the directory set
    catches created/removed directories (e.g. a recovery dir with no files).
    """
    files: dict[str, tuple[bytes, int]] = {}
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = str(path.relative_to(root)).replace("\\", "/")
        files[rel] = (path.read_bytes(), path.stat().st_mtime_ns)
    directories = sorted(
        str(p.relative_to(root)).replace("\\", "/")
        for p in root.rglob("*")
        if p.is_dir()
    )
    return files, directories


def _all_files(root: Path) -> dict[str, bytes]:
    files, _ = _tree_state(root)
    return {rel: blob for rel, (blob, _mtime) in files.items()}


def _receipt_names(root: Path) -> set[str]:
    directory = root / CONFORMANCE_DIR
    if not directory.is_dir():
        return set()
    return {
        path.name
        for path in directory.glob("*")
        if path.is_file() and path.name.endswith(RECEIPT_SUFFIXES)
    }


class DryRunPurityFixture(unittest.TestCase):
    """Shared fixture builders: bootstrap project and mature project."""

    def make_bootstrap_project(self) -> Path:
        """A valid fixture WITHOUT IDENTITY.md and WITHOUT recovery state.

        Mirrors the canonical repair fixture (T-1304 review) but deliberately
        never calls ensure_project_lineage, so the project has no identity or
        recovery/conformance surface for the preview to corrupt.
        """
        base = Path(tempfile.mkdtemp(prefix="saipen-r004-bootstrap-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        (project / ".saipen").mkdir(parents=True)
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: CLEAN\n"
            "task: none\n"
            'next_action: "WAIT: user brake -- nothing workable yet"\n'
            'blocker: ""\n'
            "transition_from: REVIEW\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            "agent: tester\n"
            "requires:\n"
            "  - filesystem\n"
            "  - python\n"
            "mode: full\n"
            'updated: "2026-09-10T00:00:00Z"\n'
            "---\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n"
            "## TODO\n"
            "- [ ] T-1 [P2] seeded work | verify: proof it works\n"
            "## DONE\n"
            "## BLOCKED\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "LOG.md").write_text(
            "- 09.09.26 12:00 [E-001] [T-1] [agent: tester] DEC: seed ticket\n",
            encoding="utf-8",
        )
        self.assertFalse((project / ".saipen/IDENTITY.md").exists())
        self.assertFalse((project / ".saipen/recovery").exists())
        return project

    def make_mature_project(self) -> Path:
        """A project that already has identity/recovery/conformance state."""
        base = Path(tempfile.mkdtemp(prefix="saipen-r004-mature-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        project.mkdir()
        shutil.copytree(SCENARIO, project / ".saipen")
        return project

    def make_red_project(self) -> Path:
        """A project whose Core validation is red (unresolved source receipt)."""
        project = self.make_mature_project()
        board = project / ".saipen/BOARD.md"
        text = board.read_text(encoding="utf-8")
        text = text.replace("## DOING\n- [/] T-001 DOING task", "## DOING")
        text = text.replace(
            "## DONE\n", "## DONE\n- [x] T-001 DOING task | verify: proof exists\n"
        )
        board.write_text(text, encoding="utf-8")
        captured = intake.capture(
            project, "audit body for T-001", source_kind="user_audit", work="T-001"
        )
        self.assertTrue(captured["ok"], captured)
        return project


# ---------------------------------------------------------------- A + D


class BootstrapPreviewPurityTests(DryRunPurityFixture):
    """Case A: empty/bootstrap project -- dry-run creates nothing."""

    def test_bootstrap_dry_run_is_byte_pure_and_creates_no_artifacts(self) -> None:
        project = self.make_bootstrap_project()
        before = _tree_state(project)
        result = debt_mod.create_snapshot(project, "probe", "dry-run probe", dry_run=True)
        after = _tree_state(project)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "DEBT_SNAPSHOT_PLAN")
        self.assertTrue(result["preview"])
        self.assertEqual(before, after, "dry-run mutated the project tree")
        self.assertFalse((project / ".saipen/IDENTITY.md").exists())
        self.assertFalse((project / ".saipen/recovery").exists())
        self.assertEqual(_receipt_names(project), set())
        self.assertFalse((project / ".saipen/recovery/settled").exists())
        # the preview reports REAL structured findings, never a fake empty set
        self.assertIn("problems", result)
        self.assertIn("warnings", result)
        self.assertEqual(result["problem_count"], len(result["problems"]))
        self.assertEqual(result["warning_count"], len(result["warnings"]))


class MaturePreviewPurityTests(DryRunPurityFixture):
    """Cases B + D: mature project stays byte-identical, PASS emits no receipt."""

    def _assert_mature_dry_run_pure(self, project: Path) -> dict:
        before = _tree_state(project)
        result = debt_mod.create_snapshot(project, "probe", "dry-run probe", dry_run=True)
        after = _tree_state(project)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "DEBT_SNAPSHOT_PLAN")
        self.assertEqual(
            before, after, "dry-run changed existing index/content/timestamp bytes"
        )
        return result

    def test_mature_project_dry_run_exact_byte_equality(self) -> None:
        project = self.make_mature_project()
        self.assertTrue((project / ".saipen/recovery/conformance").is_dir())
        self._assert_mature_dry_run_pure(project)
        # No existing index timestamp/content may change: _tree_state compares
        # mtime_ns per file, so a touch would already fail; assert receipts too.
        self.assertFalse((project / ".saipen/recovery/settled").exists())

    def test_pass_preview_emits_no_receipt(self) -> None:
        project = self.make_mature_project()
        receipts_before = _receipt_names(project)
        self.assertTrue(receipts_before, "scenario should already carry receipts")
        result = self._assert_mature_dry_run_pure(project)
        # the scenario validator run is a PASS (0 problems) -- the preview must
        # report that truthfully and still not mint a PASS receipt
        self.assertEqual(result["problem_count"], 0)
        self.assertEqual(_receipt_names(project), receipts_before)


# ---------------------------------------------------------------- C


class RedPreviewPurityTests(DryRunPurityFixture):
    """Case C: validator FAIL preview reports real problems, byte-pure."""

    def test_fail_preview_reports_real_problems_without_receipt(self) -> None:
        project = self.make_red_project()
        receipts_before = _receipt_names(project)
        before = _tree_state(project)
        result = debt_mod.create_snapshot(project, "probe", "dry-run probe", dry_run=True)
        after = _tree_state(project)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "DEBT_SNAPSHOT_PLAN")
        self.assertGreaterEqual(
            result["problem_count"], 1, "preview must report the real red finding set"
        )
        self.assertEqual(
            result["problem_count"], len(result["problems"]), "envelope/count drift"
        )
        unresolved = [
            f
            for f in result["problems"]
            if f["rule_id"] == "source_receipt_unresolved_work"
            and f["subject_id"] == "T-001"
        ]
        self.assertEqual(len(unresolved), 1, result["problems"])
        self.assertEqual(before, after, "FAIL preview wrote project bytes")
        self.assertEqual(_receipt_names(project), receipts_before)


# ---------------------------------------------------------------- E


class MutationBoundaryHostileTests(DryRunPurityFixture):
    """Case E: the dry-run path never touches mutating primitives."""

    def test_dry_run_never_calls_mutating_primitives(self) -> None:
        project = self.make_mature_project()
        with patch.object(
            journal_mod,
            "ensure_project_lineage",
            side_effect=AssertionError("dry-run called ensure_project_lineage"),
        ), patch.object(
            debt_mod,
            "run_mutation",
            side_effect=AssertionError("dry-run called run_mutation"),
        ), patch.object(
            debt_mod,
            "capture_findings",
            side_effect=AssertionError(
                "dry-run called the ordinary receipt-emitting capture_findings"
            ),
        ), patch.object(
            debt_mod,
            "_capture_findings_read_only",
            wraps=debt_mod._capture_findings_read_only,
        ) as read_only_spy:
            result = debt_mod.create_snapshot(project, "probe", "probe", dry_run=True)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "DEBT_SNAPSHOT_PLAN")
        # the preview obtained its findings through the explicit READ-ONLY
        # mechanism exactly once -- never through the ordinary one
        self.assertEqual(read_only_spy.call_count, 1)

    def test_apply_still_calls_lineage_and_mutation(self) -> None:
        project = self.make_mature_project()
        with patch.object(
            journal_mod, "ensure_project_lineage", wraps=journal_mod.ensure_project_lineage
        ) as lineage_spy, patch.object(
            debt_mod, "run_mutation", wraps=debt_mod.run_mutation
        ) as mutation_spy:
            result = debt_mod.create_snapshot(project, "probe", "probe", dry_run=False)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "DEBT_SNAPSHOT_CREATED")
        # the APPLY path goes through the real lineage carrier and journal
        # (run_mutation itself re-enters ensure_project_lineage internally,
        # so >= 1 is the honest bound for lineage; the journal op is exact)
        self.assertGreaterEqual(lineage_spy.call_count, 1)
        self.assertEqual(mutation_spy.call_count, 1)


# ---------------------------------------------------------------- F


class RealApplyControlTests(DryRunPurityFixture):
    """Case F: the real APPLY path stays journaled and immutable."""

    def test_apply_creates_journaled_immutable_snapshot_and_dedups(self) -> None:
        project = self.make_mature_project()
        result = debt_mod.create_snapshot(project, "probe", "apply probe")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "DEBT_SNAPSHOT_CREATED")
        snapshot_id = result["snapshot_id"]
        record = debt_mod.load_snapshot(project, snapshot_id)
        self.assertEqual(record["snapshot_id"], snapshot_id)
        self.assertEqual(
            record["project_lineage"], debt_mod.project_lineage_identity(project)
        )
        self.assertTrue(record["journal_op_id"], "snapshot must be journaled")
        debt_file = project / debt_mod.DEBT_DIR / f"{snapshot_id}.json"
        self.assertTrue(debt_file.is_file(), "immutable snapshot file missing")
        # dedup remains intact for the same checkpoint
        again = debt_mod.create_snapshot(project, "probe", "apply probe")
        self.assertEqual(again["code"], "DEBT_SNAPSHOT_REUSED")
        self.assertEqual(again["snapshot_id"], snapshot_id)
        # a changed checkpoint creates a NEW snapshot (no dedup weakening)
        intake.capture(project, "mutation", source_kind="user_audit")
        second = debt_mod.create_snapshot(project, "probe", "after mutation")
        self.assertTrue(second["ok"], second)
        self.assertNotEqual(second["snapshot_id"], snapshot_id)

    def test_preview_after_apply_plans_reuse_without_bytes(self) -> None:
        project = self.make_mature_project()
        created = debt_mod.create_snapshot(project, "probe", "apply probe")
        self.assertTrue(created["ok"], created)
        before = _tree_state(project)
        preview = debt_mod.create_snapshot(project, "probe", "apply probe", dry_run=True)
        after = _tree_state(project)
        self.assertEqual(preview["code"], "DEBT_SNAPSHOT_REUSED")
        self.assertTrue(preview["preview"])
        self.assertEqual(preview["writes"], 0)
        self.assertEqual(before, after)


# ---------------------------------------------------------------- G


class RepeatedDryRunTests(DryRunPurityFixture):
    """Case G: repeated previews are byte-stable and deterministic."""

    def test_repeated_dry_run_is_stable_and_deterministic(self) -> None:
        project = self.make_mature_project()
        before = _tree_state(project)
        first = debt_mod.create_snapshot(project, "probe", "dry-run probe", dry_run=True)
        after_first = _tree_state(project)
        second = debt_mod.create_snapshot(project, "probe", "dry-run probe", dry_run=True)
        after_second = _tree_state(project)

        self.assertTrue(first["ok"], first)
        self.assertEqual(first["code"], "DEBT_SNAPSHOT_PLAN")
        self.assertEqual(before, after_first, "first dry-run wrote bytes")
        self.assertEqual(after_first, after_second, "second dry-run accumulated artifacts")
        # deterministic semantic plan: no volatile fields are injected
        self.assertEqual(first, second)


# ------------------------------------------------- fail-closed control


class FailClosedCaptureTests(DryRunPurityFixture):
    """Requirement 5: capture failure is a structured refusal, never zero."""

    def test_capture_failure_fails_closed_without_bytes(self) -> None:
        project = self.make_mature_project()
        before = _tree_state(project)
        with patch.object(
            debt_mod,
            "_capture_findings_read_only",
            return_value={
                "ok": False,
                "code": "FINDINGS_CAPTURE_FAILED",
                "exit_code": 1,
                "detail": "validator exploded",
            },
        ):
            result = debt_mod.create_snapshot(project, "probe", "probe", dry_run=True)
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "FINDINGS_CAPTURE_FAILED")
        self.assertEqual(before, _tree_state(project), "refusal wrote bytes")
        # never treated as zero findings, never fell through into APPLY
        self.assertNotIn("snapshot_id", result)
        self.assertFalse((project / debt_mod.DEBT_DIR).exists())


if __name__ == "__main__":
    unittest.main()