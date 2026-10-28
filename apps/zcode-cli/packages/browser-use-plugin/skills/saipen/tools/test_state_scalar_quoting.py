"""T-1354: a project was blocked forever by two apostrophes.

`_SMART_VAC_CLEANER` carried `blocker: ''` in its canonical STATE -- YAML's
single-quoted empty string. `coerce` decodes double-quoted scalars only, so the
value came back as the two-character string `''`, which is truthy, and the
shared binding brake refused every consequential tool with

    SAIPEN_GUARD_REFUSAL: WAIT_BLOCKED: ... blocker="''"

Measured live through the real plugin: the agent could read the project and do
nothing else, with no blocker a human had ever set and no route out, because
nothing in the protocol can clear a blocker that is not really there.

SAIPEN's own writer emits double quotes, so its files round-trip. That is
exactly why this went unseen: the defect only appears in a STATE written by
anything else -- a hand edit, another tool, an older generation -- and those
are the files a guard is most likely to meet in the field.

Single-quoted YAML has one escape: `''` inside the body is one apostrophe.
Nothing else is special, which is what makes the style worth supporting
verbatim rather than approximating.
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
from saipen_engine.state import coerce, parse_frontmatter  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


class SingleQuotedScalarTests(unittest.TestCase):
    def test_an_empty_single_quoted_scalar_is_empty(self) -> None:
        self.assertEqual(coerce("''"), "")

    def test_a_single_quoted_scalar_decodes_without_its_quotes(self) -> None:
        self.assertEqual(coerce("'BUILD'"), "BUILD")
        self.assertEqual(coerce("'WAIT: user brake -- text'"), "WAIT: user brake -- text")

    def test_the_only_escape_is_a_doubled_apostrophe(self) -> None:
        self.assertEqual(coerce("'it''s here'"), "it's here")
        self.assertEqual(coerce("'''"), "'''")  # unbalanced: not a quoted scalar

    def test_double_quoted_scalars_are_unchanged(self) -> None:
        self.assertEqual(coerce('""'), "")
        self.assertEqual(coerce('"007"'), "007")
        self.assertEqual(coerce('"a\\"b"'), 'a"b')

    def test_unquoted_scalars_keep_their_natural_type(self) -> None:
        self.assertEqual(coerce("7"), 7)
        self.assertIs(coerce("true"), True)
        self.assertEqual(coerce("bare text"), "bare text")

    def test_an_apostrophe_inside_an_unquoted_scalar_is_not_a_quote(self) -> None:
        """Only a scalar that OPENS and CLOSES with one is quoted."""
        self.assertEqual(coerce("it's fine"), "it's fine")
        self.assertEqual(coerce("don't"), "don't")

    def test_frontmatter_reads_a_single_quoted_empty_blocker_as_empty(self) -> None:
        fields, error = parse_frontmatter(
            "---\nphase: BUILD\ntask: T-1\nblocker: ''\n---\n"
        )
        self.assertIsNone(error, error)
        self.assertEqual(fields["blocker"], "")


class NoPhantomBrakeTests(unittest.TestCase):
    """The consequence, end to end: no phantom blocker stops an agent."""

    def _project(self, base: Path, blocker: str) -> Path:
        root = base / "proj"
        saipen = root / ".saipen"
        saipen.mkdir(parents=True)
        (saipen / "STATE.md").write_text(
            "---\n"
            "phase: BUILD\n"
            "task: T-1\n"
            'next_action: "PHASE BUILD T-1"\n'
            f"blocker: {blocker}\n"
            "transition_from: SCOUT\n"
            "saipen_version: 8\n"
            "schema_version: 3\n"
            "last_event: 100\n"
            "style_contract: ded-4ae736e4\n"
            "mode: full\n"
            "updated: 2026-09-12T00:00:00Z\n"
            "agent: test-agent\n"
            "---\n",
            encoding="utf-8",
        )
        (saipen / "BOARD.md").write_text(
            "## DOING\n"
            "- [/] T-1 [P1] fixture work | verify: fixture | owner: test-agent "
            "| claim_time: 2026-09-12T00:00:00Z\n"
            "## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (saipen / "LOG.md").write_text(
            "- 12.09.26 00:00 [E-100] [agent: test-agent] RUN: fixture\n", encoding="utf-8"
        )
        (saipen / "IDENTITY.md").write_text(
            identity_file_content(new_project_lineage()), encoding="utf-8"
        )
        (root / "src").mkdir()
        (root / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
        return root

    def test_a_single_quoted_empty_blocker_does_not_brake_the_agent(self) -> None:
        # A BARE `blocker:` is deliberately not in this set: in this dialect an
        # empty value opens a list block, and STATE rejects a non-string
        # blocker on its own terms. Both QUOTED spellings of "no blocker" must
        # mean the same thing.
        for spelling in ("''", '""'):
            with tempfile.TemporaryDirectory(prefix="t1354-quote-") as tmp, self.subTest(
                blocker=spelling
            ):
                root = self._project(Path(tmp), spelling)
                result = evaluate_admission(root, target_path="src/app.py", action="edit")
                self.assertTrue(
                    result["admitted"],
                    f"blocker written as {spelling!r} braked the whole project: "
                    f"{result.get('code')} {result.get('detail')}",
                )

    def test_a_real_blocker_still_brakes(self) -> None:
        """The control: relaxing the spelling must not relax the brake."""
        with tempfile.TemporaryDirectory(prefix="t1354-quote-") as tmp:
            root = self._project(Path(tmp), "'WAIT_USER_CONFIRMATION -- a real gate'")
            result = evaluate_admission(root, target_path="src/app.py", action="edit")
            self.assertFalse(result["admitted"], result)
            self.assertEqual(result["code"], "WAIT_BLOCKED")


if __name__ == "__main__":
    unittest.main(verbosity=2)
