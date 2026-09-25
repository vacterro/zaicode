"""T-1352: a refusal that names no exit is a dead end, not a guard.

`_candidate_home_errors` refuses a rebind whose candidate home declares a
different protocol major than `STATE.saipen_version`. For the carrier-loss case
it was written for (T-1003 -- the project lost its home, you name a
replacement) that is exactly right: do not rebind onto another generation.

It is a dead end for the other shape. A project whose declared major has fallen
behind every home that exists can never rebind, because every candidate fails
the same comparison, and nothing in the engine moves the field. The only escape
left is editing a protected canonical file by hand, which the guard forbids.
Measured on this repository: VERSION 8.0.1, STATE.saipen_version 7, the
validator warning about it on every run since v8.0.0 shipped, naming no remedy
-- and the whole-project delivery path unable to package this repository at
all, because its Gate H rebinds the extracted copy first.

So the repair is the missing exit, not a weaker comparison: ONE journaled
operation that moves the declared major to the bound home's PROVEN major,
recording both generations, and refusing when the home cannot be proved or
when there is nothing to move.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import saipen_engine.operations as operations  # noqa: E402
from saipen_engine.codec import read_doc  # noqa: E402
from saipen_engine.operations import _candidate_home_errors  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from saipen_engine.state import parse_state  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


def migrate_saipen_generation(*args, **kwargs):
    """Resolved at call time, not at import.

    The oracle has to stay IMPORTABLE against the pre-fix subject, or the
    whole suite collapses into one import error and says nothing about the
    behaviour. Against a subject that has no exit at all, the CLI and
    stranding cases still report what is actually missing.
    """
    operation = getattr(operations, "migrate_saipen_generation", None)
    if operation is None:
        raise AssertionError(
            "saipen_engine.operations has no migrate_saipen_generation: a stale "
            "STATE.saipen_version has a detector, no repair and no owner"
        )
    return operation(*args, **kwargs)


STATE_TEMPLATE = """---
phase: DONE
task: none
next_action: "saipen continue"
blocker: ""
transition_from: SHIP
saipen_version: {version}
schema_version: 3
last_event: 100
style_contract: ded-4ae736e4
saipen_home: "{home}"
mode: full
updated: 2026-09-12T00:00:00Z
agent: test-agent
---
"""

BOARD = "## DOING\n## TODO\n## DONE\n## BLOCKED\n"
LOG = "- 12.09.26 00:00 [E-100] [agent: test-agent] RUN: generation fixture\n"


def home(base: Path, version: str = "8.0.1", *, complete: bool = True) -> Path:
    root = base / "home"
    (root / "saipen").mkdir(parents=True)
    (root / "saipen" / "BOOT.md").write_text("# BOOT\n", encoding="utf-8")
    if complete:
        (root / "extensions" / "subs").mkdir(parents=True)
        (root / "extensions" / "subs" / "PROTOCOL.md").write_text("# subs\n", encoding="utf-8")
        (root / "VERSION").write_text(f"{version}\n", encoding="utf-8")
    return root


def project(base: Path, home_path: Path, declared: int) -> Path:
    root = base / "project"
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    saipen.joinpath("STATE.md").write_text(
        STATE_TEMPLATE.format(version=declared, home=home_path.as_posix()), encoding="utf-8"
    )
    saipen.joinpath("BOARD.md").write_text(BOARD, encoding="utf-8")
    saipen.joinpath("LOG.md").write_text(LOG, encoding="utf-8")
    saipen.joinpath("IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    return root


def declared_version(root: Path) -> object:
    return parse_state(read_doc(root / ".saipen" / "STATE.md")).get("saipen_version")


class MigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1352-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def test_the_declared_major_moves_to_the_proven_home_major(self) -> None:
        installed = home(self.base)
        root = project(self.base, installed, declared=7)
        self.assertEqual(declared_version(root), 7)

        result = migrate_saipen_generation(root, "test-agent")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(declared_version(root), 8)

        log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertIn("7", log)
        self.assertIn("8", log)
        self.assertIn("DEC:", log, "a generation move must be journaled as a decision")

    def test_nothing_to_move_refuses_and_writes_nothing(self) -> None:
        installed = home(self.base)
        root = project(self.base, installed, declared=8)
        before = (root / ".saipen").rglob("*")
        snapshot = {p: p.read_bytes() for p in before if p.is_file()}

        result = migrate_saipen_generation(root, "test-agent")
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "VALIDATION_FAILED")
        for path, content in snapshot.items():
            self.assertEqual(path.read_bytes(), content, f"{path.name} was written")

    def test_an_unproven_home_refuses_and_writes_nothing(self) -> None:
        installed = home(self.base, complete=False)
        root = project(self.base, installed, declared=7)
        snapshot = {p: p.read_bytes() for p in (root / ".saipen").rglob("*") if p.is_file()}

        result = migrate_saipen_generation(root, "test-agent")
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "HOME_REQUIRED")
        for path, content in snapshot.items():
            self.assertEqual(path.read_bytes(), content, f"{path.name} was written")

    def test_a_dry_run_renders_the_plan_and_writes_nothing(self) -> None:
        installed = home(self.base)
        root = project(self.base, installed, declared=7)
        snapshot = {p: p.read_bytes() for p in (root / ".saipen").rglob("*") if p.is_file()}

        result = migrate_saipen_generation(root, "test-agent", dry_run=True)
        self.assertTrue(result.ok, result.to_dict())
        for path, content in snapshot.items():
            self.assertEqual(path.read_bytes(), content, f"{path.name} was written")
        self.assertEqual(declared_version(root), 7)


class StrandingTests(unittest.TestCase):
    """The dead end itself: before the exit exists, there is no way out."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1352-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def test_a_stale_major_can_rebind_again_after_migrating(self) -> None:
        installed = home(self.base)
        root = project(self.base, installed, declared=7)
        state = parse_state(read_doc(root / ".saipen" / "STATE.md"))
        self.assertTrue(
            _candidate_home_errors(root, state, str(installed)),
            "the precondition that strands the project stopped firing",
        )

        migrate_saipen_generation(root, "test-agent")
        migrated = parse_state(read_doc(root / ".saipen" / "STATE.md"))
        self.assertEqual(
            _candidate_home_errors(root, migrated, str(installed)),
            [],
            "after recording the generation the project can rebind again",
        )

    def test_the_refusal_names_the_remedy(self) -> None:
        """A guard whose refusal names no exit is how this sat for generations."""
        installed = home(self.base)
        root = project(self.base, installed, declared=7)
        state = parse_state(read_doc(root / ".saipen" / "STATE.md"))
        errors = " ".join(_candidate_home_errors(root, state, str(installed)))
        self.assertIn("recover --migrate-generation", errors, errors)


class CliSurfaceTests(unittest.TestCase):
    def test_the_flag_reaches_the_engine_and_dry_run_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="t1352-cli-") as tmp:
            base = Path(tmp)
            installed = home(base)
            root = project(base, installed, declared=7)
            completed = subprocess.run(
                [
                    sys.executable,
                    str(TOOLS / "saipen.py"),
                    "--project-root",
                    str(root),
                    "recover",
                    "--migrate-generation",
                    "--dry-run",
                    "--json",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=hermetic_env(),
                timeout=300,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            payload = json.loads(completed.stdout)
            self.assertTrue(payload.get("ok"), payload)
            self.assertEqual(declared_version(root), 7, "a dry run moved the field")

    def test_an_unknown_recover_flag_is_still_refused(self) -> None:
        """The closed grammar must stay closed after gaining a flag."""
        with tempfile.TemporaryDirectory(prefix="t1352-cli-") as tmp:
            base = Path(tmp)
            root = project(base, home(base), declared=7)
            completed = subprocess.run(
                [
                    sys.executable,
                    str(TOOLS / "saipen.py"),
                    "--project-root",
                    str(root),
                    "recover",
                    "--migrate-generation-please",
                    "--json",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=hermetic_env(),
                timeout=300,
            )
            self.assertNotEqual(completed.returncode, 0, completed.stdout)
            self.assertIn("unknown recover argument", completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
