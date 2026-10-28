"""T-1435 M6: machine-local runtime namespace release hygiene (SRC-090 §16-19).

Measured incident: ~255 per-operation recovery directories, OS writer locks, a
liveness cache and snapshot generations in a consumer project were eligible to
enter a public release cohort until that project added its own local
exclusions. The guarantee belongs to the protocol.

Covered here:
  * ONE classification owner (`runtime_namespace`) that never blankets
    `.saipen/**`: durable evidence stays release input, mechanics do not;
  * a NEW project establishes the canonical ignore policy at its first
    durable capture (adoption), idempotently;
  * the ship gate detects runtime artifacts Git ALREADY tracks -- `.gitignore`
    does not untrack them -- and emits the exact
    OPERATOR_AUTHORIZED_COMMAND (`git rm -r --cached ...`) instead of an
    instruction that fails forever;
  * the remediation converges: after it runs, the finding is gone and the
    live runtime state still exists on disk.

Run standalone:
    python tools/test_runtime_namespace.py
"""

from __future__ import annotations

import json
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

from saipen_engine import runtime_namespace as rn_mod  # noqa: E402
from saipen_engine.paths import unbound_environment  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"
VALIDATE_PY = TOOLS / "validate.py"
SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"

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

LOG = "- 21.09.26 00:00 [E-001] [T-900] RUN: historical build finished\n"
BOARD = "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n"


def setUpModule() -> None:
    isolate_host_session()


def _git(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=unbound_environment(),
        timeout=120,
    )


class PolicyTests(unittest.TestCase):
    """The classification itself: one owner, no blanket exclusion."""

    def test_runtime_classes_are_closed(self):
        for path, expected in (
            (".saipen/locks/project.lock", "os-writer-lock"),
            (".saipen/cache/liveness.json", "liveness-cache"),
            (".saipen/recovery/ops/op-1/operation.json", "operation-journal-scratch"),
            (".saipen/snapshots/gen-7.json", "rebuildable-snapshot"),
        ):
            with self.subTest(path=path):
                self.assertEqual(rn_mod.runtime_class(path), expected)

    def test_durable_history_is_never_runtime_debris(self):
        for path in (
            ".saipen/evidence/T-1/report.md",
            ".saipen/archive/source/SRC-001.md",
            ".saipen/intake/active/SRC-001.md",
            ".saipen/recovery/log-detail/E-001-x.json",
            ".saipen/recovery/board-compaction/T-1/x.json",
            ".saipen/recovery/conformance/receipt.json",
            ".saipen/recovery/settled/op/operation.json",
            ".saipen/extensions/subs/saiwiki/STATE.md",
        ):
            with self.subTest(path=path):
                self.assertIsNone(rn_mod.runtime_class(path))
                self.assertTrue(rn_mod.is_durable_protected(path))

    def test_the_policy_is_not_a_blanket_saipen_exclusion(self):
        self.assertFalse(rn_mod.is_durable_protected(".saipen/locks/x"))
        self.assertNotIn(".saipen/**", rn_mod.ignore_block())
        self.assertNotIn(".saipen/", [prefix for prefix, _c in rn_mod.NON_RELEASE_PATTERNS])


class TrackedDetectionTests(unittest.TestCase):
    """Existing project: tracked runtime artifacts are detected and removable."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-runtime-ns-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir(parents=True)
        _git(self.root, "init")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _track(self, rel: str, text: str = "runtime\n") -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        self.assertEqual(_git(self.root, "add", "-f", rel).returncode, 0)
        return path

    def test_clean_fixture_reports_clean(self):
        self.assertEqual(rn_mod.release_problems(self.root)["code"], "RUNTIME_NAMESPACE_CLEAN")

    def test_each_tracked_runtime_class_is_detected(self):
        lock = self._track(".saipen/locks/project.lock")
        cache = self._track(".saipen/cache/liveness.json")
        ops = self._track(".saipen/recovery/ops/op-1/operation.json")
        snap = self._track(".saipen/snapshots/gen-7.json")
        verdict = rn_mod.release_problems(self.root)
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "RUNTIME_NAMESPACE_TRACKED")
        self.assertEqual(
            verdict["paths"],
            [
                ".saipen/cache/liveness.json",
                ".saipen/locks/project.lock",
                ".saipen/recovery/ops/op-1/operation.json",
                ".saipen/snapshots/gen-7.json",
            ],
        )
        self.assertEqual(verdict["classes"][".saipen/locks/project.lock"], "os-writer-lock")
        self.assertEqual(verdict["remediation_kind"], "OPERATOR_AUTHORIZED_COMMAND")
        self.assertTrue(verdict["remediation_command"].startswith("git rm -r --cached -- "))
        for path in (lock, cache, ops, snap):
            self.assertTrue(path.is_file(), "detection never touches disk")

    def test_ignore_present_but_tracked_still_fails(self):
        self._track(".saipen/locks/project.lock")
        self.assertEqual(rn_mod.ignore_policy_state(self.root), "ABSENT")
        rn_mod.ensure_gitignore_policy(self.root)
        self.assertEqual(rn_mod.ignore_policy_state(self.root), "CURRENT")
        verdict = rn_mod.release_problems(self.root)
        self.assertFalse(verdict["ok"], "Git tracking beats ignore status")

    def test_durable_evidence_stays_release_input(self):
        self._track(".saipen/evidence/T-900/report.md")
        self._track(".saipen/intake/active/SRC-001.md")
        self.assertEqual(rn_mod.release_problems(self.root)["code"], "RUNTIME_NAMESPACE_CLEAN")

    def test_remediation_converges_and_keeps_live_state(self):
        lock = self._track(".saipen/locks/project.lock")
        command = rn_mod.release_problems(self.root)["remediation_command"]
        completed = subprocess.run(
            command.split(),
            cwd=str(self.root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=unbound_environment(),
            timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(lock.is_file(), "untracking must not delete the live lock")
        self.assertEqual(rn_mod.release_problems(self.root)["code"], "RUNTIME_NAMESPACE_CLEAN")

    def test_ignore_policy_application_is_idempotent_and_preserves_bytes(self):
        gitignore = self.root / ".gitignore"
        gitignore.write_text("*.bak\n", encoding="utf-8")
        first = rn_mod.ensure_gitignore_policy(self.root)
        self.assertEqual(first["code"], "IGNORE_POLICY_ADDED")
        once = gitignore.read_text(encoding="utf-8")
        self.assertIn("*.bak", once)
        self.assertIn(rn_mod.IGNORE_MARKER, once)
        second = rn_mod.ensure_gitignore_policy(self.root)
        self.assertEqual(second["code"], "IGNORE_POLICY_CURRENT")
        self.assertEqual(gitignore.read_text(encoding="utf-8"), once)


class AdoptionTests(unittest.TestCase):
    """New project: the FIRST durable capture establishes the policy."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-runtime-adopt-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir(parents=True)
        shutil.copytree(SCENARIO, self.root / ".saipen")
        (self.root / ".saipen" / "BOARD.md").write_text(BOARD, encoding="utf-8")
        (self.root / ".saipen" / "STATE.md").write_text(STATE, encoding="utf-8")
        (self.root / ".saipen" / "LOG.md").write_text(LOG, encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_first_capture_establishes_the_block_once(self):
        gitignore = self.root / ".gitignore"
        self.assertFalse(gitignore.exists())
        rc, _payload, out = _run_cli(self.root, "source", "capture", "first request")
        self.assertEqual(rc, 0, out)
        self.assertTrue(gitignore.is_file())
        once = gitignore.read_text(encoding="utf-8")
        self.assertIn(rn_mod.IGNORE_MARKER, once)
        rc, _payload, out = _run_cli(self.root, "source", "capture", "second request")
        self.assertEqual(rc, 0, out)
        self.assertEqual(gitignore.read_text(encoding="utf-8"), once)


class ShipGateTests(unittest.TestCase):
    """Release validation: the ship gate refuses tracked runtime artifacts."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-runtime-gate-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir(parents=True)
        _git(self.root, "init")
        shutil.copytree(SCENARIO, self.root / ".saipen")
        (self.root / ".saipen" / "BOARD.md").write_text(BOARD, encoding="utf-8")
        (self.root / ".saipen" / "STATE.md").write_text(STATE, encoding="utf-8")
        (self.root / ".saipen" / "LOG.md").write_text(LOG, encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_ship_gate_fails_with_the_authorized_command(self):
        lock = self.root / ".saipen" / "locks" / "project.lock"
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text("lock", encoding="utf-8")
        self.assertEqual(_git(self.root, "add", "-f", ".saipen/locks/project.lock").returncode, 0)
        rc, out = _run_validator(self.root)
        self.assertNotEqual(rc, 0)
        self.assertIn("runtime namespace --", out)
        self.assertIn(".saipen/locks/project.lock", out)
        self.assertIn("[classification: OPERATOR_AUTHORIZED_COMMAND]", out)
        self.assertIn("git rm -r --cached", out)

    def test_detection_does_not_depend_on_a_run_receipt(self):
        _clean_rc, clean_out = _run_validator(self.root)
        self.assertNotIn("runtime namespace --", clean_out)


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
            "ship",
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