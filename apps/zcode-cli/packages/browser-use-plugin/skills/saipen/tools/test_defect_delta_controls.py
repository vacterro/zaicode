"""T-1382: hostile controls for `defect_delta` and the declared residue.

`defect_delta` decides whether a repair may commit: inherited damage may
survive a partial repair, NEWLY introduced damage may not. It is the brake on
every recovery verb, so it is the right place to attack. Its one liberty is
that it drops a defect's LINE NUMBER -- repair proposals move lines, and
comparing raw strings read every inherited defect at a new line as a new one.

That liberty is exactly where a launderer would aim: anything that makes a
genuinely new defect look like an old one turns the brake into a rubber stamp.
These controls pin the boundary:

  A  the same defect at a new line number is inherited;
  B  the same wording about another FILE is a different defect;
  C  multiplicity is counted, not just membership (two before, one after);
  D  one before, two after -> exactly one NEW defect;
  E  the same prose about ANOTHER RECORD is a new defect -- ticket ids are
     never normalized away, because a defect that moved from one record to
     another is a defect that moved;
  F  a repair that removes its own defect keeps unrelated ones inherited;
  G  the signature drops position and nothing else.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.fast_check import defect_delta, defect_signature  # noqa: E402


class DefectDeltaHostileControls(unittest.TestCase):
    def test_A_a_defect_that_moves_line_number_is_inherited(self):
        before = ["BOARD.md:5 duplicate ticket ID T-176"]
        after = ["BOARD.md:41 duplicate ticket ID T-176"]
        self.assertEqual(defect_delta(before, after), ([], after))

    def test_B_the_same_wording_in_another_file_is_a_distinct_defect(self):
        before = ["BOARD.md:5 duplicate ticket ID T-176"]
        after = ["LOG.md:5 duplicate ticket ID T-176"]
        self.assertEqual(defect_delta(before, after), (after, []))

    def test_C_two_identical_defects_before_one_after_is_not_a_new_defect(self):
        before = ["LOG.md:2 not a legal event line", "LOG.md:3 not a legal event line"]
        after = ["LOG.md:2 not a legal event line"]
        introduced, inherited = defect_delta(before, after)
        self.assertEqual(introduced, [])
        self.assertEqual(len(inherited), 1)
        # Multiplicity, not membership: the same pair read the other way is ONE
        # new defect, because the second occurrence had nothing to inherit from.
        introduced, inherited = defect_delta(after, before)
        self.assertEqual(len(introduced), 1)
        self.assertEqual(len(inherited), 1)

    def test_D_one_identical_defect_before_two_after_detects_the_new_one(self):
        before = ["LOG.md:2 not a legal event line"]
        after = ["LOG.md:2 not a legal event line", "LOG.md:9 not a legal event line"]
        introduced, inherited = defect_delta(before, after)
        self.assertEqual(introduced, ["LOG.md:9 not a legal event line"])
        self.assertEqual(len(inherited), 1)

    def test_E_the_same_prose_about_another_record_is_a_new_defect(self):
        """Semantic identity is load-bearing, so ids are NOT normalized.

        `defect_delta` is used by a repair whose subject IS a ticket identity
        (`reconcile.resolve_duplicate_id` renames a record). Normalizing ticket
        ids inside the signature would have made that repair's own delta quiet
        -- and would equally have hidden a stale blocker that MOVED from one
        record to another, which is damage, not inheritance.
        """
        before = ["BOARD proposed T-16 carries | blocker: outside ## BLOCKED (## DONE)"]
        after = ["BOARD proposed T-17 carries | blocker: outside ## BLOCKED (## DONE)"]
        self.assertEqual(defect_delta(before, after), (after, []))

    def test_F_removing_its_own_defect_keeps_unrelated_ones_inherited(self):
        before = [
            "LOG.md:2 not a legal event line",
            "STATE.md:4 unknown STATE field 'parked_work'",
            "BOARD.md:5 duplicate ticket ID T-176",
        ]
        after = [  # the duplicate is repaired; the other two defects moved up
            "LOG.md:1 not a legal event line",
            "STATE.md:3 unknown STATE field 'parked_work'",
        ]
        introduced, inherited = defect_delta(before, after)
        self.assertEqual(introduced, [])
        self.assertEqual(len(inherited), 2)

    def test_G_the_signature_drops_position_and_keeps_the_surface(self):
        self.assertEqual(
            defect_signature("BOARD.md:12 duplicate ticket ID T-1"),
            defect_signature("BOARD.md:999 duplicate ticket ID T-1"),
        )
        self.assertNotEqual(
            defect_signature("BOARD.md:12 duplicate ticket ID T-1"),
            defect_signature("LOG.md:12 duplicate ticket ID T-1"),
        )
        # A finding that does not begin with a `<file>.md:<line>` prefix keeps
        # every byte: no accidental stripping of a ticket id or of a subject.
        self.assertEqual(
            defect_signature("T-1299 not a legal event line"),
            "T-1299 not a legal event line",
        )
        self.assertEqual(
            defect_signature("STATE.blocker is set outside phase BLOCKED"),
            "STATE.blocker is set outside phase BLOCKED",
        )

    def test_H_the_brake_still_fires_on_a_completely_different_defect(self):
        before = ["LOG.md:2 not a legal event line"]
        after = ["BOARD.md:2 duplicate ticket ID T-176"]
        self.assertEqual(defect_delta(before, after), (after, []))


class DeclaredResidueSubtractionTests(unittest.TestCase):
    """The post-write verifier exempts DECLARED residue, and nothing else.

    T-1354's mechanism: a repair walks in on damage, so it must declare what it
    inherited. The declaration is per-operation and journaled -- which makes it
    the second place a launderer would aim: over-declare and the brake is gone.
    """

    def setUp(self) -> None:
        from saipen_engine.journal import ensure_project_lineage

        self.root = Path(tempfile.mkdtemp(prefix="saipen-residue-")) / "RESIDUE"
        (self.root / ".saipen").mkdir(parents=True)
        (self.root / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: SCOUT\n"
            "task: none\n"
            'next_action: "saipen start a task"\n'
            'blocker: ""\n'
            "transition_from: none\n"
            "saipen_version: 8\n"
            "schema_version: 3\n"
            "last_event: 2\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(TOOLS.parent).replace(chr(92), chr(92) * 2)}"\n'
            "agent: buffy\n"
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            'updated: "2026-09-18T00:00:00Z"\n'
            "---\n",
            encoding="utf-8",
        )
        (self.root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        # TWO illegal LOG lines, so one declaration can exempt one of them and
        # the other must still fail the write.
        (self.root / ".saipen" / "LOG.md").write_text(
            "- 18.09.26 00:00 [E-001] [agent: buffy] DEC: created via SAIOPS\n"
            "18.09.26 00:01 [E-002] [parent: E-001] [agent: buffy] RUN: lost its bullet\n"
            "free text, no canonical event tag at all\n",
            encoding="utf-8",
        )
        ensure_project_lineage(self.root)

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.root.parent, ignore_errors=True)

    def findings(self) -> list[str]:
        from saipen_engine.fast_check import validate_project

        return list(validate_project(self.root) or [])

    def test_the_fixture_is_actually_damaged(self):
        findings = self.findings()
        self.assertTrue(any("not a legal" in f for f in findings), findings)

    def test_an_undeclared_finding_still_fails_the_write(self):
        from saipen_engine.journal import _verifier_for

        errors = _verifier_for("core_fast")(self.root, [], None)
        self.assertTrue(errors, "the verifier passed a project it should refuse")

    def test_a_declaration_exempts_only_what_it_names(self):
        from saipen_engine.journal import _verifier_for

        findings = self.findings()
        # Declare ONE of them. The others must still be reported: a declaration
        # is an exemption, never a blanket amnesty.
        verifier = _verifier_for("core_fast")
        remaining = verifier(self.root, [], {"inherited_findings": [findings[0]]})
        self.assertTrue(remaining, "one declaration exempted the whole surface")
        self.assertEqual(
            [defect_signature(str(item)) for item in remaining],
            [
                defect_signature(str(item))
                for item in findings
                if defect_signature(str(item)) != defect_signature(findings[0])
            ],
        )

    def test_a_full_declaration_is_position_independent(self):
        """A repair that moves lines keeps its exemption; it does not widen it."""
        from saipen_engine.journal import _verifier_for

        findings = self.findings()
        moved = [f.replace(":2", ":99").replace(":3", ":98").replace(":4", ":97") for f in findings]
        self.assertEqual(
            _verifier_for("core_fast")(self.root, [], {"inherited_findings": moved}), []
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
