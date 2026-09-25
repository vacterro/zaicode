"""Unit tests for admission authority and guard CLI (SRC-028 / T-1317)."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen import main as saipen_main  # noqa: E402
from saipen_engine.admission import (  # noqa: E402
    ENFORCEMENT_STRENGTH_ADVISORY,
    ENFORCEMENT_STRENGTH_BLOCKING,
    ENFORCEMENT_STRENGTH_GAP,
    effective_strength,
    evaluate_admission,
    get_adapter,
    is_protected_canonical_path,
    list_adapters,
)
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


class TestAdmissionAuthority(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.saipen_dir = self.root / ".saipen"
        self.saipen_dir.mkdir(parents=True, exist_ok=True)
        self.lineage = new_project_lineage()
        (self.saipen_dir / "IDENTITY.md").write_text(
            identity_file_content(self.lineage), encoding="utf-8"
        )
        (self.saipen_dir / "STATE.md").write_text(
            "---\n"
            "phase: BUILD\n"
            "task: T-1\n"
            "next_action: PHASE BUILD T-1\n"
            "blocker: none\n"
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 100\n"
            "mode: full\n"
            "updated: 2026-09-12T00:01:00Z\n"
            "agent: test-agent\n"
            "---\n",
            encoding="utf-8",
        )
        (self.saipen_dir / "BOARD.md").write_text(
            "## DOING\n"
            "- [/] T-1 [P1] admission fixture | verify: fixture proof | "
            "owner: test-agent | claim_time: 2026-09-12T00:01:00Z\n"
            "## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (self.saipen_dir / "LOG.md").write_text("# LOG\n", encoding="utf-8")
        (self.saipen_dir / "intake").mkdir(parents=True, exist_ok=True)
        (self.saipen_dir / "recovery").mkdir(parents=True, exist_ok=True)
        (self.root / "src").mkdir(parents=True, exist_ok=True)
        (self.root / "src" / "app.py").write_text("print('ok')", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_protected_canonical_paths(self):
        protected = [
            ".saipen/STATE.md",
            ".saipen/BOARD.md",
            ".saipen/LOG.md",
            ".saipen/IDENTITY.md",
            ".saipen/intake/receipts/SRC-001.md",
            ".saipen/intake/coverage/SRC-028.json",
            ".saipen/recovery/conformance/active.json",
            ".saipen/logs/audit.log",
        ]
        for path in protected:
            self.assertTrue(
                is_protected_canonical_path(path),
                f"Expected {path} to be protected",
            )
            res = evaluate_admission(self.root, target_path=path)
            self.assertFalse(res["ok"])
            self.assertFalse(res["admitted"])
            self.assertEqual(res["code"], "PROTECTED_CANONICAL_NAMESPACE")

    def test_admitted_normal_paths(self):
        normal = [
            "src/app.py",
            "README.md",
            "tests/test_app.py",
            "docs/architecture.md",
        ]
        for path in normal:
            self.assertFalse(is_protected_canonical_path(path))
            res = evaluate_admission(self.root, target_path=path)
            self.assertTrue(res["ok"])
            self.assertTrue(res["admitted"])
            self.assertEqual(res["code"], "ADMITTED")

    def test_admitted_external_path(self):
        with tempfile.NamedTemporaryFile() as ext_file:
            res = evaluate_admission(self.root, target_path=ext_file.name)
            self.assertTrue(res["ok"])
            self.assertTrue(res["admitted"])
            self.assertEqual(res["code"], "ADMITTED_EXTERNAL")

    def test_blocked_work_allows_reads_but_not_consequential_mutation(self):
        (self.saipen_dir / "STATE.md").write_text(
            (self.saipen_dir / "STATE.md")
            .read_text(encoding="utf-8")
            .replace("phase: BUILD", "phase: DONE")
            .replace("task: T-1", "task: none")
            .replace("next_action: PHASE BUILD T-1", "next_action: saipen continue")
            .replace("transition_from: SCOUT", "transition_from: BUILD"),
            encoding="utf-8",
        )
        (self.saipen_dir / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n"
            "- [ ] T-1 [P1] admission fixture | verify: fixture proof | "
            "blocker: BLOCKED_EXTERNAL -- host absent | blocker_scope: ticket\n",
            encoding="utf-8",
        )
        read = evaluate_admission(self.root, target_path="src/app.py", action="read")
        self.assertTrue(read["admitted"], read)
        write = evaluate_admission(self.root, target_path="src/app.py", action="write")
        self.assertFalse(write["admitted"], write)
        self.assertEqual(write["code"], "NO_ACTIVE_WORK")

    def test_bound_project_cannot_authorize_foreign_root_mutation(self):
        """T-1354: the invariant is about ANOTHER PROJECT, so the fixture is one.

        This case used to hand the guard a bare `NamedTemporaryFile` -- an
        ordinary file belonging to no project at all -- and call refusing it
        proof that a bound identity cannot reach a foreign root. The two are
        not the same thing, and the difference was not academic: a bound
        OpenCode session could not write its own scratch file under
        `V:/_TEMP_` while a shell command wrote the identical path freely.
        The invariant is kept and now tested against what it names.
        """
        with tempfile.TemporaryDirectory(prefix="saipen-foreign-") as tmp:
            foreign = Path(tmp) / "other-project"
            (foreign / ".saipen").mkdir(parents=True)
            (foreign / ".saipen" / "STATE.md").write_text(
                (self.saipen_dir / "STATE.md").read_text(encoding="utf-8"), encoding="utf-8"
            )
            (foreign / ".saipen" / "IDENTITY.md").write_text(
                identity_file_content(new_project_lineage()), encoding="utf-8"
            )
            result = evaluate_admission(
                self.root,
                target_path=str(foreign / ".saipen" / "STATE.md"),
                explicit_root=self.root,
                action="write",
            )
        self.assertFalse(result["admitted"], result)
        self.assertEqual(result["code"], "PROTECTED_CANONICAL_NAMESPACE")

    def test_a_file_belonging_to_no_project_is_not_a_foreign_root(self):
        """The other half: refuse the minimum unsafe operation.

        A directory that is no SAIPEN project has no lifecycle to protect, and
        the shell surface already writes it, so refusing the file tool was
        friction rather than protection.
        """
        with tempfile.NamedTemporaryFile() as ext_file:
            result = evaluate_admission(
                self.root,
                target_path=ext_file.name,
                explicit_root=self.root,
                action="write",
            )
        self.assertTrue(result["admitted"], result)
        self.assertEqual(result["code"], "ADMITTED_EXTERNAL")

    def _fastest_of_twenty(self) -> list[float]:
        evaluate_admission(self.root, target_path="src/app.py")  # warmup
        return [
            evaluate_admission(self.root, target_path="src/app.py")["duration_ms"]
            for _ in range(20)
        ]

    def test_performance_budget(self):
        # T-1496: the budget is judged on the FASTEST of 20 evaluations. Every
        # call pays the code's own cost, so a real regression moves the
        # minimum; a busy host only adds spikes on top of it. The old bound
        # required all 20 calls under 5 ms and failed 6 of 60 runs on a loaded
        # host (5.456-10.817 ms) while the code did not change.
        durations = self._fastest_of_twenty()
        self.assertLess(min(durations), 5.0, durations)

    def test_performance_budget_still_sees_a_real_regression(self):
        """Red control: a gate that cannot fail is not a gate. A cost every
        evaluation pays (6 ms per call) must lift the minimum over the budget."""
        import time

        import saipen_engine.admission as admission

        real = admission.canonicalize_target

        def slow(*args, **kwargs):
            time.sleep(0.006)
            return real(*args, **kwargs)

        with patch.object(admission, "canonicalize_target", slow):
            durations = self._fastest_of_twenty()
        self.assertGreaterEqual(min(durations), 5.0, durations)

    def test_detached_staging_cwd_with_env(self):
        staging = tempfile.TemporaryDirectory()
        try:
            staging_path = Path(staging.name).resolve()
            env = {
                "SAIPEN_PROJECT_ROOT": str(self.root),
                "SAIPEN_PROJECT_LINEAGE": self.lineage,
            }
            with patch.dict(os.environ, env):
                # Normal target in project evaluated from detached cwd
                res = evaluate_admission(staging_path, target_path="src/app.py")
                self.assertTrue(res["ok"])
                self.assertTrue(res["admitted"])
                self.assertEqual(res["code"], "ADMITTED")

                # Protected target in project evaluated from detached cwd
                res = evaluate_admission(staging_path, target_path=".saipen/STATE.md")
                self.assertFalse(res["ok"])
                self.assertFalse(res["admitted"])
                self.assertEqual(res["code"], "PROTECTED_CANONICAL_NAMESPACE")
        finally:
            staging.cleanup()

    def test_lineage_mismatch_fails_closed(self):
        staging = tempfile.TemporaryDirectory()
        try:
            staging_path = Path(staging.name).resolve()
            env = {
                "SAIPEN_PROJECT_ROOT": str(self.root),
                "SAIPEN_PROJECT_LINEAGE": "lineage-" + "0" * 32,
            }
            with patch.dict(os.environ, env):
                res = evaluate_admission(staging_path, target_path="src/app.py")
                self.assertFalse(res["ok"])
                self.assertFalse(res["admitted"])
                self.assertEqual(res["code"], "PROJECT_LINEAGE_MISMATCH")
        finally:
            staging.cleanup()

    def test_adapter_registry_truth(self):
        # SRC-030 Part 11: declared capability is not installed enforcement.
        # Only a real installed+current+callable hook may read BLOCKING, so
        # the registry itself declares opencode as the one shipping blocking
        # adapter; kiro and gemini are truthfully downgraded.
        opencode = get_adapter("opencode")
        self.assertIsNotNone(opencode)
        self.assertTrue(opencode["blocking_capability"])
        self.assertEqual(opencode["declared_strength"], ENFORCEMENT_STRENGTH_BLOCKING)
        # T-1317 P1-1/P1-2: Kiro PreToolUse hooks and Gemini CLI BeforeTool
        # hooks CAN block a tool, so capability is recorded truthfully. No
        # SAIPEN adapter ships for either host yet, so neither may declare or
        # report effective BLOCKING -- capability is not enforcement.
        for name in ("kiro", "gemini"):
            adapter = get_adapter(name)
            self.assertIsNotNone(adapter)
            self.assertTrue(adapter["blocking_capability"], name)
            self.assertNotEqual(adapter["declared_strength"], ENFORCEMENT_STRENGTH_BLOCKING)
            self.assertTrue(adapter["hook_install_surface"], name)
            self.assertNotEqual(
                effective_strength(name)["effective"],
                ENFORCEMENT_STRENGTH_BLOCKING,
                name,
            )

        # Advisory instruction-level adapters.
        for name in ("claude", "codex", "freebuff", "aider"):
            adapter = get_adapter(name)
            self.assertIsNotNone(adapter)
            self.assertEqual(adapter["declared_strength"], ENFORCEMENT_STRENGTH_ADVISORY)

        # Gap adapters.
        for name in ("generic", "kiro"):
            self.assertEqual(
                get_adapter(name)["declared_strength"], ENFORCEMENT_STRENGTH_GAP
            )

        all_adapters = list_adapters()
        self.assertGreaterEqual(len(all_adapters), 10)
        for entry in all_adapters:
            for field in (
                "id",
                "instruction_surfaces",
                "skill_surfaces",
                "blocking_capability",
                "hook_install_surface",
                "hook_artifact",
                "freshness_surfaces",
                "declared_strength",
            ):
                self.assertIn(field, entry, f"registry entry missing {field}")


class TestGuardCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.saipen_dir = self.root / ".saipen"
        self.saipen_dir.mkdir(parents=True, exist_ok=True)
        self.lineage = new_project_lineage()
        (self.saipen_dir / "IDENTITY.md").write_text(
            identity_file_content(self.lineage), encoding="utf-8"
        )
        (self.saipen_dir / "STATE.md").write_text(
            "---\n"
            "phase: BUILD\n"
            "task: T-1\n"
            "next_action: PHASE BUILD T-1\n"
            "blocker: none\n"
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 100\n"
            "mode: full\n"
            "updated: 2026-09-12T00:01:00Z\n"
            "agent: test-agent\n"
            "---\n",
            encoding="utf-8",
        )
        (self.saipen_dir / "BOARD.md").write_text(
            "## DOING\n"
            "- [/] T-1 [P1] guard CLI fixture | verify: fixture proof | "
            "owner: test-agent | claim_time: 2026-09-12T00:01:00Z\n"
            "## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (self.saipen_dir / "LOG.md").write_text("# LOG\n", encoding="utf-8")
        (self.root / "src").mkdir(parents=True, exist_ok=True)
        (self.root / "src" / "app.py").write_text("code", encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def test_cli_guard_status(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = saipen_main(["guard", "--project-root", str(self.root)])
        self.assertEqual(code, 0)
        output = out.getvalue()
        self.assertIn("code: ADMITTED", output)

    def test_cli_guard_status_json(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = saipen_main(["guard", "--project-root", str(self.root), "--json"])
        self.assertEqual(code, 0)
        data = json.loads(out.getvalue())
        self.assertTrue(data["ok"])
        self.assertIn("adapters", data)
        # Truthful strength view: declared capability vs effective enforcement.
        self.assertEqual(data["adapters"]["opencode"]["declared"], "BLOCKING")
        self.assertNotEqual(
            data["adapters"]["opencode"]["effective"],
            "BLOCKING",
            "an uninstalled hook must never read effectively BLOCKING",
        )
        self.assertEqual(data["adapters"]["kiro"]["effective"], "ENFORCEMENT_GAP")

    def test_cli_guard_normal_file_admitted(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = saipen_main(["guard", "src/app.py", "--project-root", str(self.root), "--json"])
        self.assertEqual(code, 0)
        data = json.loads(out.getvalue())
        self.assertTrue(data["ok"])
        self.assertTrue(data["admitted"])
        self.assertEqual(data["code"], "ADMITTED")

    def test_cli_guard_protected_file_rejected(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = saipen_main(
                ["guard", ".saipen/BOARD.md", "--project-root", str(self.root), "--json"]
            )
        self.assertEqual(code, 1)
        data = json.loads(out.getvalue())
        self.assertFalse(data["ok"])
        self.assertFalse(data["admitted"])
        self.assertEqual(data["code"], "PROTECTED_CANONICAL_NAMESPACE")

    def test_cli_guard_protected_file_human_output(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = saipen_main(["guard", ".saipen/STATE.md", "--project-root", str(self.root)])
        self.assertEqual(code, 1)
        output = out.getvalue()
        self.assertIn("REFUSE", output)
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", output)


if __name__ == "__main__":
    unittest.main()
