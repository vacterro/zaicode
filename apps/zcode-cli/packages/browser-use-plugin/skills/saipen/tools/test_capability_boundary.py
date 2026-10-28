"""CORE-004 regression tests: an invalid capability declaration fails closed.

`negotiate_capability` mapped BOTH an absent declaration and any unrecognised
one to `full`, while `capability_error` two functions below declared that an
unknown capability must fail CLOSED. The closed-set validation could never fire,
because negotiation had already laundered the input.

The damning part is which strings reach that branch. `readonly`, `read only`
and `no_publish` are not random noise -- every one of them is somebody trying to
RESTRICT the session, and every one of them used to publish.

Proven here:
- an absent, empty or whitespace declaration keeps the documented default;
- each of the four valid capabilities negotiates to itself, case-insensitively;
- a present-but-invalid declaration is denied, cannot mutate and cannot publish;
- the public command boundary refuses it before any command runs;
- a mutating command under an invalid declaration leaves the canonical tree and
  the recovery directory byte-identical.

Run standalone:
    python tools/test_capability_boundary.py
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.capability import (  # noqa: E402
    CAPABILITIES,
    ENV_VAR,
    capability_error,
    may_mutate,
    may_publish,
    negotiate_capability,
)

REPO = TOOLS.parent

#: Not arbitrary. Every one of these is a plausible host mistake, and the first
#: four are attempts to grant LESS than full.
LIKELY_TYPOS = ("readonly", "read only", "read_only", "no_publish", "nonsense", "full-access")


class NegotiationTests(unittest.TestCase):
    def test_an_absent_declaration_keeps_the_documented_default(self):
        self.assertEqual(negotiate_capability({}), "full")

    def test_an_empty_or_whitespace_declaration_is_an_absent_one(self):
        """A shell exporting the variable unset is not a host asking for anything."""
        self.assertEqual(negotiate_capability({ENV_VAR: ""}), "full")
        self.assertEqual(negotiate_capability({ENV_VAR: "   "}), "full")

    def test_each_valid_capability_negotiates_to_itself(self):
        for capability in CAPABILITIES:
            self.assertEqual(negotiate_capability({ENV_VAR: capability}), capability)
            self.assertIsNone(capability_error(negotiate_capability({ENV_VAR: capability})))

    def test_case_and_surrounding_space_are_still_normalised(self):
        self.assertEqual(negotiate_capability({ENV_VAR: "  FULL  "}), "full")
        self.assertEqual(negotiate_capability({ENV_VAR: "Read-Only"}), "read-only")

    def test_an_invalid_declaration_is_never_laundered_into_full(self):
        for bad in LIKELY_TYPOS:
            with self.subTest(declared=bad):
                negotiated = negotiate_capability({ENV_VAR: bad})
                self.assertNotEqual(negotiated, "full")
                self.assertIsNotNone(capability_error(negotiated))
                self.assertFalse(may_mutate(negotiated))
                self.assertFalse(may_publish(negotiated))

    def test_the_refusal_names_the_value_and_the_closed_set(self):
        problem = capability_error(negotiate_capability({ENV_VAR: "readonly"}))
        self.assertIn("readonly", problem)
        for capability in CAPABILITIES:
            self.assertIn(capability, problem)


def _tree_digest(root: Path) -> str:
    """One digest over every byte under `root`, paths included."""
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


class CommandBoundaryTests(unittest.TestCase):
    """The refusal happens before a command runs, not inside each command."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "proj"
        shutil.copytree(
            REPO / "tests/scenarios/done-wait-deadlock-goal-mode/.saipen",
            self.root / ".saipen",
        )

    def _run(self, *args: str, capability: str | None) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ)
        env.pop(ENV_VAR, None)
        if capability is not None:
            env[ENV_VAR] = capability
        return subprocess.run(
            [sys.executable, str(REPO / "tools" / "saipen.py"), *args,
             "--project-root", str(self.root), "--json"],
            capture_output=True,
            text=True,
            env=env,
            timeout=180,
        )

    def test_an_invalid_declaration_refuses_before_the_command_runs(self):
        done = self._run("status", capability="readonly")
        self.assertIn("CAPABILITY_DENIED", done.stdout)
        self.assertIn("readonly", done.stdout)

    def test_a_mutating_command_under_an_invalid_declaration_writes_nothing(self):
        """The acceptance measure: canonical bytes unchanged, recovery unchanged."""
        before = _tree_digest(self.root)
        done = self._run(
            "checkpoint", "RUN", "probe text", capability="no_publish"
        )
        self.assertIn("CAPABILITY_DENIED", done.stdout)
        self.assertEqual(_tree_digest(self.root), before)

    def test_a_valid_declaration_still_reaches_the_command(self):
        """Positive control: the boundary refuses the invalid, not everything."""
        done = self._run("status", capability="read-only")
        self.assertNotIn("CAPABILITY_DENIED", done.stdout)

    def test_an_absent_declaration_still_reaches_the_command(self):
        done = self._run("status", capability=None)
        self.assertNotIn("CAPABILITY_DENIED", done.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
