"""T-1361 CL-04: one owner decides what a LOG event may be.

`saipen_engine.log.VALID_TAXONOMIES` is the LOG grammar -- DEC, RUN, WAIT,
REVERT, NOTE, OPS. `saipen_engine.operations` kept a second, narrower copy of
that fact (`{"DEC", "RUN"}`) and the internal event WRITER consulted the copy.

`_plan_first_publish_wait` correctly asks for a `WAIT` event. The writer
refused a taxonomy the grammar has always accepted, and refused it by RAISING:
`ValueError` out of `_event_line`, uncaught, straight through the CLI. So
`saipen ship` on a first publish exited 1 having printed nothing at all -- not
a refusal, not JSON -- and ten release-executor checks reported
`code='PARSE_ERROR' detail=` because the probe only kept stdout, and there was
no stdout.

Two sources for one fact, and the narrower one silently killed a whole verb.
The writer now asks the grammar. The COMMAND surface stays narrow on purpose:
an operator typing `saipen checkpoint` writes a decision or a run, and the
other record types belong to the operations that produce them.

Run standalone:
    python tools/test_event_taxonomy_owner.py
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import operations as O  # noqa: E402
from saipen_engine.log import VALID_TAXONOMIES  # noqa: E402
from saipen_engine.plan import OperationPlan  # noqa: E402

#: The narrow set the writer used to consult. Kept here as the RED control's
#: input, so the defect is reproduced rather than described.
NARROW = frozenset({"DEC", "RUN"})


def make_project(tmp: Path) -> Path:
    """A fixture valid enough to plan a first-publish WAIT against."""
    root = tmp / "project"
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "LOG.md").write_text(
        "- 09.08.26 00:00 [E-899] [T-1] [agent: probe] DEC: ticket added via SAIOPS\n"
        "- 09.08.26 00:00 [E-900] [parent: E-899] [T-none] DEC: base\n",
        encoding="utf-8",
    )
    (saipen / "BOARD.md").write_text(
        "# Board\n## DOING\n## TODO\n"
        "- [ ] T-1 [P1] probe | verify: probe\n"
        "## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    (saipen / "STATE.md").write_text(
        '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
        'blocker: ""\ntransition_from: SHIP\nsaipen_version: 8\n'
        "schema_version: 3\nlast_event: 900\nstyle_contract: ded-4ae736e4\n"
        f'saipen_home: "{ROOT.as_posix()}"\nagent: probe\nrequires:\n  - filesystem\n'
        "  - git\n  - python\nmode: full\nupdated: 2026-08-09T00:00:00Z\n"
        "---\n",
        encoding="utf-8",
    )
    return root


class TaxonomyOwnerTests(unittest.TestCase):
    """AC-01 -- the writer asks the grammar, and only the grammar."""

    def test_the_writer_accepts_every_taxonomy_the_grammar_accepts(self) -> None:
        self.assertIn("WAIT", VALID_TAXONOMIES)
        for taxonomy in sorted(VALID_TAXONOMIES):
            with self.subTest(taxonomy):
                self.assertIn(taxonomy, O.VALID_TAXONOMIES)

    def test_the_writer_keeps_no_second_copy_of_the_grammar(self) -> None:
        # The defect was a DUPLICATE, so the test is about identity, not about
        # the current contents of a set that could drift apart again.
        self.assertIs(O.VALID_TAXONOMIES, VALID_TAXONOMIES)

    def test_a_taxonomy_outside_the_grammar_is_still_refused(self) -> None:
        with self.assertRaises(ValueError) as caught:
            O._event_line({}, 900, "NOT-A-TAXONOMY", None, "probe", "m", "09.08.26 00:00")
        self.assertIn("NOT-A-TAXONOMY", str(caught.exception))

    def test_the_command_surface_stays_narrower_on_purpose(self) -> None:
        self.assertEqual(O._CHECKPOINT_TAXONOMIES, set(NARROW))
        for taxonomy in sorted(VALID_TAXONOMIES - NARROW):
            with self.subTest(taxonomy):
                self.assertNotIn(taxonomy, O._CHECKPOINT_TAXONOMIES)


class FirstPublishWaitTests(unittest.TestCase):
    """AC-02 -- the red control, then the same verifier green."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-taxonomy-")
        self.root = make_project(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def plan(self):
        return O._plan_first_publish_wait(
            self.root, "probe", "origin", "09.08.26 00:00", "2026-08-09T00:00:00Z"
        )

    def test_the_narrow_set_kills_the_verb(self) -> None:
        # RED. With the writer consulting the command surface's set again, the
        # first-publish WAIT does not refuse -- it RAISES, which is what left
        # `saipen ship` exiting 1 with an empty stdout.
        raised = None
        with mock.patch.object(O, "VALID_TAXONOMIES", NARROW):
            try:
                self.plan()
            except ValueError as exc:
                raised = exc
        self.assertIsNotNone(raised, "the narrow set no longer kills the verb")
        self.assertIn("WAIT", str(raised))

    def test_the_same_call_plans_cleanly_against_the_grammar(self) -> None:
        # GREEN. Same fixture, same call, only the set the writer consults.
        planned = self.plan()
        self.assertIsInstance(planned, OperationPlan, getattr(planned, "message", planned))

    def test_the_planned_wait_parks_state_on_the_canonical_line(self) -> None:
        planned = self.plan()
        self.assertIsInstance(planned, OperationPlan, getattr(planned, "message", planned))
        self.assertEqual(planned.expected["code"], "FIRST_PUBLISH_WAIT")
        self.assertTrue(planned.expected["next_action"].startswith("WAIT: first-publish"))

    def test_the_planned_wait_writes_a_WAIT_event(self) -> None:
        planned = self.plan()
        self.assertIsInstance(planned, OperationPlan, getattr(planned, "message", planned))
        log = next(target for target in planned.targets if target.path.endswith("LOG.md"))
        body = log.content if isinstance(log.content, str) else log.content.decode("utf-8")
        self.assertIn("WAIT: first-publish", body)
        # The ticket slot is the thing that used to render as `[none]`.
        self.assertNotIn("[none]", body)

    def test_it_writes_nothing_while_planning(self) -> None:
        before = {
            path: path.read_bytes() for path in sorted((self.root / ".saipen").rglob("*"))
        }
        self.plan()
        after = {path: path.read_bytes() for path in sorted((self.root / ".saipen").rglob("*"))}
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
