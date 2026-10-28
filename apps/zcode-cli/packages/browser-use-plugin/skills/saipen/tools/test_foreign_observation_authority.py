"""T-1434 M6: foreign observation authority and wrong-root mutation refusal.

The defect this suite anchors: an explicit `--project-root B` from a session
whose ambient carriers name project A was refused PROJECT_LINEAGE_MISMATCH for
EVERY command -- including read-only diagnostics -- so observing a foreign
project required clearing SAIPEN_* by hand. The repair distinguishes the
caller's declared authority:

  * `observe` (DIAGNOSTIC effects): an explicit target may be bound
    deliberately; observing B from an A-bound session is legitimate and
    inherits no mutation authority;
  * `mutation` (everything else): the explicit target must agree with every
    ambient carrier lineage, or the binding refuses -- pointing mutation at a
    foreign project merely because the flag was supplied stays impossible.

Run standalone:
    python tools/test_foreign_observation_authority.py
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

from saipen_engine.paths import (  # noqa: E402
    identity_file_content,
    new_project_lineage,
    project_lineage_identity,
    resolve_project_root,
    unbound_environment,
)
from test_hermetic_env import isolate_host_session  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"
SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"


def setUpModule() -> None:
    isolate_host_session()


def _make_project(parent: Path, name: str, *, relineage: bool) -> Path:
    root = parent / name
    root.mkdir(parents=True)
    shutil.copytree(SCENARIO, root / ".saipen")
    if relineage:
        (root / ".saipen" / "IDENTITY.md").write_text(
            identity_file_content(new_project_lineage()), encoding="utf-8"
        )
    return root


def _run(project: Path, env: dict, *args: str) -> tuple[int, dict, str]:
    proc = subprocess.run(
        [sys.executable, str(SAIPEN_PY), "--project-root", str(project), "--json", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=600,
    )
    try:
        payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except ValueError:
        payload = {"_unparseable_stdout": proc.stdout}
    return proc.returncode, payload, proc.stdout


class ResolveAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="t1434-m6-")
        parent = Path(self.tmp.name)
        self.a = _make_project(parent, "project-a", relineage=True)
        self.b = _make_project(parent, "project-b", relineage=True)
        self.lineage_a = project_lineage_identity(self.a)
        self.lineage_b = project_lineage_identity(self.b)
        self.assertNotEqual(self.lineage_a, self.lineage_b)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_observation_may_bind_foreign_explicit_root(self):
        resolved = resolve_project_root(
            self.a,
            explicit=self.b,
            host_lineage=self.lineage_a,
            authority="observe",
        )
        self.assertEqual(resolved.root, self.b.resolve())
        self.assertEqual(resolved.lineage, self.lineage_b)

    def test_mutation_refuses_foreign_explicit_root(self):
        resolved = resolve_project_root(
            self.a,
            explicit=self.b,
            host_lineage=self.lineage_a,
            authority="mutation",
        )
        self.assertIsNone(resolved.root)
        self.assertEqual(resolved.code, "PROJECT_LINEAGE_MISMATCH")

    def test_mutation_allows_coherent_explicit_root(self):
        resolved = resolve_project_root(
            self.a,
            explicit=self.b,
            host_lineage=self.lineage_b,
            authority="mutation",
        )
        self.assertEqual(resolved.root, self.b.resolve())

    def test_unknown_authority_is_refused(self):
        with self.assertRaises(ValueError):
            resolve_project_root(self.a, explicit=self.b, authority="whatever")


class ForeignObservationCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="t1434-m6-cli-")
        parent = Path(self.tmp.name)
        self.a = _make_project(parent, "project-a", relineage=True)
        self.b = _make_project(parent, "project-b", relineage=True)
        self.lineage_a = project_lineage_identity(self.a)
        self.lineage_b = project_lineage_identity(self.b)
        self.assertNotEqual(self.lineage_a, self.lineage_b)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _env(self, *, root: str | None, lineage: str | None) -> dict:
        return unbound_environment(
            SAIPEN_PROJECT_ROOT=root,
            SAIPEN_PROJECT_LINEAGE=lineage,
        )

    def test_status_observes_foreign_project_with_ambient_a_carriers(self):
        env = self._env(root=str(self.a), lineage=self.lineage_a)
        rc, payload, out = _run(self.b, env, "status")
        self.assertEqual(rc, 0, out[:400])
        self.assertNotEqual(payload.get("code"), "PROJECT_LINEAGE_MISMATCH")
        self.assertIn("project-b", str(payload.get("project_identity", "")).lower())

    def test_validate_observes_foreign_project_with_ambient_a_carriers(self):
        env = self._env(root=str(self.a), lineage=self.lineage_a)
        _rc, payload, out = _run(self.b, env, "validate")
        self.assertNotEqual(payload.get("code"), "PROJECT_LINEAGE_MISMATCH", out[:400])

    def test_mutation_against_foreign_project_is_refused(self):
        env = self._env(root=str(self.a), lineage=self.lineage_a)
        rc, payload, out = _run(self.b, env, "ticket", "add", "P2", "m6 wrong-root probe")
        self.assertNotEqual(rc, 0, out[:400])
        self.assertEqual(payload.get("code"), "PROJECT_LINEAGE_MISMATCH")
        # zero mutation in B: the probe ticket never reached its board
        board = (self.b / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertNotIn("m6 wrong-root probe", board)

    def test_mutation_succeeds_with_coherent_carriers(self):
        env = self._env(root=str(self.b), lineage=self.lineage_b)
        rc, payload, out = _run(
            self.b,
            env,
            "ticket",
            "add",
            "P2",
            "m6 coherent probe",
            "--verify",
            "probe proof",
        )
        self.assertEqual(rc, 0, out[:400])
        self.assertIn(payload.get("code"), ("TICKET_ADDED", None))
        board = (self.b / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertIn("m6 coherent probe", board)
        # the foreign project A is untouched by the B mutation
        board_a = (self.a / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertNotIn("m6 coherent probe", board_a)

    def test_mutation_succeeds_with_no_carriers(self):
        env = self._env(root=None, lineage=None)
        rc, _payload, out = _run(
            self.b,
            env,
            "ticket",
            "add",
            "P2",
            "m6 bare probe",
            "--verify",
            "probe proof",
        )
        self.assertEqual(rc, 0, out[:400])
        board = (self.b / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertIn("m6 bare probe", board)


class ProvenanceModelTests(unittest.TestCase):
    """M6.2: the five semantic provenance classes resolve to real mechanisms.

    The audit's finding: `fix == local patch` is no longer an assumption --
    every class below has a durable, machine-checked representation, and no
    class admits an arbitrary URL as authority.
    """

    def test_local_implementation(self):
        from saipen_engine import board

        self.assertIn("own_patch", board.CLOSURE_MODES)

    def test_external_implementation_and_reason_families(self):
        from saipen_engine import board, external

        self.assertIn("external_implementation", board.CLOSURE_MODES)
        self.assertEqual(
            set(external.RESOLUTION_REASONS),
            {
                "PROTOCOL_HOME_FIX_VERIFIED",
                "DEPENDENCY_UPGRADE_VERIFIED",
                "UPSTREAM_FIX_VERIFIED",
            },
        )

    def test_external_authority_is_stable_identity_not_a_url(self):
        from saipen_engine import external

        self.assertIsNotNone(external._AUTHORITY_RE.fullmatch("lineage-" + "0" * 32))
        for candidate in (
            "https://example.invalid/fix",
            "T-1411",
            "lineage-ABC",
            "lineage-" + "0" * 31,
        ):
            self.assertIsNone(
                external._AUTHORITY_RE.fullmatch(candidate),
                f"{candidate!r} must never be accepted as external authority",
            )

    def test_superseded_local_ticket(self):
        from saipen_engine import board

        self.assertIn("superseded_verified", board.CLOSURE_MODES)


if __name__ == "__main__":
    unittest.main()
