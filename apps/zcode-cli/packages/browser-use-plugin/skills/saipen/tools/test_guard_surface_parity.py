"""T-1351: one question, one answer -- whichever surface asks it.

The conformance requirement the guard exists to satisfy is that provider and
model intelligence are IRRELEVANT: a stronger model must not be able to mutate
protected canonical state through a surface a weaker one cannot. That is a
claim about SAMENESS, not about strictness, and it was false.

Measured against the real foreign roots (decisions only, nothing written): in a
session whose root is only cwd-inferred,

    edit  <other project>/.saipen/STATE.md   -> admitted, ADMITTED_EXTERNAL
    echo x >> <other project>/.saipen/LOG.md -> refused,  PROTECTED_CANONICAL_NAMESPACE

because two different rules answered one question. The path-tool surface
decided by ROOT JURISDICTION ("protocol jurisdiction ends at the root") and the
shell surface decided by PATH SHAPE. An agent that reached for a file tool with
an absolute path succeeded where an agent that reached for a shell failed --
the model picking the surface is exactly the thing the guard must make
impossible.

Jurisdiction-by-root is still right for ORDINARY files outside the root: a
session working in one repository may legitimately edit a sibling. What it is
not right for is another SAIPEN project's protected canonical state, which is
that project's lifecycle and belongs to its own admission, not to this
session's jurisdiction. Both halves are pinned here.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.admission import evaluate_admission  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


STATE = """---
phase: BUILD
task: T-1
next_action: "PHASE BUILD T-1"
blocker: ""
transition_from: SCOUT
saipen_version: 7
schema_version: 3
last_event: 100
style_contract: ded-4ae736e4
mode: full
updated: 2026-09-12T00:00:00Z
agent: test-agent
---
"""

BOARD = (
    "## DOING\n"
    "- [/] T-1 [P1] surface parity fixture | verify: the matrix runs "
    "| owner: test-agent | claim_time: 2026-09-12T00:00:00Z\n"
    "## TODO\n## DONE\n## BLOCKED\n"
)

LOG = "- 12.09.26 00:00 [E-100] [agent: test-agent] RUN: surface parity fixture\n"

#: Every canonical file the namespace protects, so the claim is about the
#: NAMESPACE rather than about STATE.md in particular.
CANONICAL = ("STATE.md", "BOARD.md", "LOG.md", "IDENTITY.md")


def project(base: Path, name: str) -> Path:
    root = base / name
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "STATE.md").write_text(STATE, encoding="utf-8")
    (saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")
    (saipen / "LOG.md").write_text(LOG, encoding="utf-8")
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
    return root


class ForeignCanonicalStateTests(unittest.TestCase):
    """Another project's canonical state is never this session's to write."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1351-")
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.own = project(base, "own")
        self.foreign = project(base, "foreign")

    def test_a_cwd_inferred_session_cannot_write_foreign_canonical_state(self) -> None:
        for name in CANONICAL:
            target = str(self.foreign / ".saipen" / name)
            with self.subTest(file=name):
                result = evaluate_admission(self.own, target_path=target, action="write")
                self.assertFalse(
                    result["admitted"],
                    f"{name} in another project was admitted as {result['code']}: "
                    "jurisdiction-by-root must not hand out another project's "
                    "lifecycle",
                )

    def test_a_bound_session_cannot_write_foreign_canonical_state(self) -> None:
        for name in CANONICAL:
            target = str(self.foreign / ".saipen" / name)
            with self.subTest(file=name):
                result = evaluate_admission(
                    self.own,
                    target_path=target,
                    action="write",
                    explicit_root=self.own,
                )
                self.assertFalse(result["admitted"], result)

    def test_a_foreign_canonical_target_cannot_hide_in_a_batch(self) -> None:
        """The oldest bypass shape: put the real target next to an innocent one.

        A multi-file effect is refused if ANY of its targets is refused, so a
        foreign canonical path batched with an ordinary in-root file must not
        reach a branch that only looks at sets where EVERY target is outside.
        """
        result = evaluate_admission(
            self.own,
            target_paths=["src/app.py", str(self.foreign / ".saipen" / "STATE.md")],
            action="write",
        )
        self.assertFalse(
            result["admitted"],
            f"a foreign canonical target rode in beside an in-root file: {result}",
        )

    def test_reading_foreign_canonical_state_stays_allowed(self) -> None:
        """Reads are diagnostic access; packaging and acceptance depend on them."""
        target = str(self.foreign / ".saipen" / "STATE.md")
        result = evaluate_admission(self.own, target_path=target, action="read")
        self.assertTrue(result["admitted"], result)

    def test_an_ordinary_file_outside_the_root_is_still_admitted(self) -> None:
        """Jurisdiction-by-root survives for everything that is not lifecycle."""
        target = str(self.foreign / "src" / "app.py")
        result = evaluate_admission(self.own, target_path=target, action="write")
        self.assertTrue(
            result["admitted"],
            "a sibling project's ordinary source file is not this guard's "
            f"business: {result}",
        )
        self.assertEqual(result["code"], "ADMITTED_EXTERNAL")

    def test_a_directory_that_is_not_a_saipen_project_is_still_admitted(self) -> None:
        with tempfile.TemporaryDirectory(prefix="t1351-plain-") as plain:
            target = Path(plain) / "notes.md"
            target.write_text("x\n", encoding="utf-8")
            result = evaluate_admission(self.own, target_path=str(target), action="write")
            self.assertTrue(result["admitted"], result)


class SurfaceParityTests(unittest.TestCase):
    """The same target, asked two ways, in the same session."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1351-")
        self.addCleanup(self._tmp.cleanup)
        base = Path(self._tmp.name)
        self.own = project(base, "own")
        self.foreign = project(base, "foreign")

    def _verdicts(self, target: str, *, bound: bool) -> dict[str, bool]:
        """The two surfaces, as the guard event layer actually presents them.

        A shell command naming anything in the `.saipen` namespace arrives as
        `action="shell"` with `shell_protected_namespace=True` and NO file
        target (guard_events.py:376-380 deliberately carries the finding rather
        than inventing one); a file tool arrives as a write with a target. Same
        intent, same bytes on disk, two shapes.
        """
        kwargs = {"explicit_root": self.own} if bound else {}
        path_tool = evaluate_admission(self.own, target_path=target, action="write", **kwargs)
        shell = evaluate_admission(
            self.own,
            action="shell",
            shell_protected_namespace=True,
            **kwargs,
        )
        return {"path_tool": bool(path_tool["admitted"]), "shell": bool(shell["admitted"])}

    def test_both_surfaces_agree_on_foreign_canonical_state(self) -> None:
        target = str(self.foreign / ".saipen" / "STATE.md")
        for bound in (False, True):
            with self.subTest(session="bound" if bound else "cwd-inferred"):
                seen = self._verdicts(target, bound=bound)
                self.assertEqual(
                    seen["path_tool"],
                    seen["shell"],
                    "one question answered two ways lets the model pick the "
                    f"surface: {seen}",
                )
                self.assertFalse(seen["path_tool"], seen)

    def test_both_surfaces_agree_on_own_canonical_state(self) -> None:
        target = str(self.own / ".saipen" / "STATE.md")
        for bound in (False, True):
            with self.subTest(session="bound" if bound else "cwd-inferred"):
                seen = self._verdicts(target, bound=bound)
                self.assertEqual(seen["path_tool"], seen["shell"], seen)
                self.assertFalse(seen["path_tool"], seen)


if __name__ == "__main__":
    unittest.main(verbosity=2)
