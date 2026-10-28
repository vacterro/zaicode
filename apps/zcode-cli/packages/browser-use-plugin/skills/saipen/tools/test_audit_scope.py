"""Scoped audit_checks regressions (T-1273).

The full sweep runs the validator once per control -- 229 runs, ~26 minutes --
which a release earns and a two-file change does not. Every CASE already
declares the file it mutates, so a changed-path set selects the controls that
can possibly be affected.

The feature is easy and the risk is the whole job: an accelerator that becomes
the release gate is precisely the defect class this repository keeps closing.
So the bar is not "the subset runs". It is that the subset cannot be reached
by CI or by `saipen ship`, cannot emit the sentence a checkpoint would quote,
and says out loud what it did not look at.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import audit_checks as A  # noqa: E402

WORKFLOW = ROOT / ".github" / "workflows" / "validate.yml"
RELEASE = ROOT / "tools" / "saipen_engine" / "release.py"


def declared(case) -> set[str]:
    _, rel, mutation, _, _ = A.case_parts(case)
    return A.case_declared_paths(rel, mutation)


# ---------------------------------------------------------------------------
# AC-01 -- selection is by declared target, and selects ONLY those
# ---------------------------------------------------------------------------


class SelectionTests(unittest.TestCase):
    def test_no_flag_means_the_full_sweep(self) -> None:
        self.assertIsNone(A.scoped_paths([]))
        self.assertIsNone(A.scoped_paths(["--json", "-v"]))

    def test_an_empty_changed_set_is_scoped_not_upgraded_to_full(self) -> None:
        # Silently promoting a mistyped invocation to the full sweep would let
        # it report a total the caller never asked for.
        self.assertEqual(A.scoped_paths(["--changed", ""]), frozenset())
        self.assertEqual(A.select_cases(A.CASES, frozenset()), [])

    def test_every_selected_case_declares_a_changed_path(self) -> None:
        changed = A.scoped_paths(["--changed", "saipen/CORE.md,CHANGELOG.md"])
        for case in A.select_cases(A.CASES, changed):
            self.assertTrue(declared(case) & changed, case[0])

    def test_no_unselected_case_declares_a_changed_path(self) -> None:
        # The "only" half. Without this, selecting everything would pass.
        changed = A.scoped_paths(["--changed", "saipen/CORE.md,CHANGELOG.md"])
        selected = {case[0] for case in A.select_cases(A.CASES, changed)}
        for case in A.CASES:
            if case[0] in selected:
                continue
            self.assertFalse(declared(case) & changed, case[0])

    def test_selection_is_a_strict_subset_of_the_suite(self) -> None:
        changed = A.scoped_paths(["--changed", "saipen/CORE.md"])
        selected = A.select_cases(A.CASES, changed)
        self.assertGreater(len(selected), 0)
        self.assertLess(len(selected), A.FULL_CASE_COUNT)

    def test_an_unrelated_path_selects_nothing(self) -> None:
        changed = A.scoped_paths(["--changed", "no/such/file.md"])
        self.assertEqual(A.select_cases(A.CASES, changed), [])

    def test_paths_are_additive(self) -> None:
        one = len(A.select_cases(A.CASES, A.scoped_paths(["--changed", "saipen/CORE.md"])))
        two = len(A.select_cases(A.CASES, A.scoped_paths(["--changed", "CHANGELOG.md"])))
        both = len(
            A.select_cases(A.CASES, A.scoped_paths(["--changed", "saipen/CORE.md,CHANGELOG.md"]))
        )
        self.assertEqual(both, one + two)

    def test_windows_separators_and_dot_slash_normalize(self) -> None:
        plain = A.select_cases(A.CASES, A.scoped_paths(["--changed", "saipen/CORE.md"]))
        for spelling in (r"saipen\CORE.md", "./saipen/CORE.md", r".\saipen\CORE.md"):
            other = A.select_cases(A.CASES, A.scoped_paths(["--changed", spelling]))
            self.assertEqual([c[0] for c in other], [c[0] for c in plain], spelling)

    def test_the_equals_form_is_accepted(self) -> None:
        self.assertEqual(
            A.scoped_paths(["--changed=saipen/CORE.md"]),
            A.scoped_paths(["--changed", "saipen/CORE.md"]),
        )

    def test_a_multi_mutation_is_selected_by_any_file_it_declares(self) -> None:
        multi = [
            case
            for case in A.CASES
            if isinstance(case[2], tuple) and case[2] and case[2][0] == "MULTI"
        ]
        self.assertTrue(multi, "no MULTI case left to prove the multi-path rule against")
        for case in multi:
            paths = declared(case)
            self.assertGreater(len(paths), 1, case[0])
            for path in paths:
                chosen = {c[0] for c in A.select_cases(A.CASES, frozenset({path}))}
                self.assertIn(case[0], chosen, f"{case[0]} not selected by {path}")

    def test_declared_paths_never_touch_the_disk(self) -> None:
        # Selection has to be decidable before any tree is built, so it reads
        # the declaration only. A path that does not exist still selects.
        chosen = A.select_cases(A.CASES, frozenset({"saipen/CORE.md"}))
        self.assertTrue(chosen)


# ---------------------------------------------------------------------------
# AC-02 -- a scoped run cannot be mistaken for the full sweep
# ---------------------------------------------------------------------------


class NoTotalTests(unittest.TestCase):
    SCOPED = frozenset({"saipen/CORE.md"})

    def test_the_full_sweep_still_owns_its_sentence(self) -> None:
        # If this fails the phrase moved, and every absence assertion below
        # became vacuous.
        line = A.sweep_report(None, 229, 229, 0, 0)[0]
        self.assertTrue(line.startswith("PASS: 229 of 229 "))
        self.assertIn(A.FULL_SWEEP_PHRASE, line)

    def test_a_scoped_success_never_emits_the_full_sweep_sentence(self) -> None:
        for line in A.sweep_report(self.SCOPED, 3, 3, 0, 0):
            self.assertNotIn(A.FULL_SWEEP_PHRASE, line)

    def test_a_scoped_failure_never_emits_the_full_sweep_sentence(self) -> None:
        for line in A.sweep_report(self.SCOPED, 3, 2, 0, 1):
            self.assertNotIn(A.FULL_SWEEP_PHRASE, line)

    def test_no_scoped_line_starts_with_pass(self) -> None:
        lines = A.sweep_report(self.SCOPED, 3, 3, 0, 0)
        lines += A.sweep_report(self.SCOPED, 3, 2, 0, 1)
        lines += A.scoped_banner(3, self.SCOPED)
        for line in lines:
            self.assertFalse(line.lstrip().startswith("PASS:"), line)

    def test_every_scoped_line_is_marked_scoped(self) -> None:
        lines = A.sweep_report(self.SCOPED, 3, 3, 0, 0)
        lines += A.sweep_report(self.SCOPED, 3, 2, 0, 1)
        lines += A.scoped_banner(3, self.SCOPED)
        for line in lines:
            self.assertTrue(line.lstrip().startswith("SCOPED:"), line)

    def test_a_scoped_line_never_reads_as_n_of_the_whole_suite(self) -> None:
        # "3 of 229" pasted into a checkpoint is the exact confusion this
        # forbids, whatever words surround it.
        pattern = re.compile(r"\bof {}\b".format(A.FULL_CASE_COUNT))
        lines = A.sweep_report(self.SCOPED, 3, 3, 0, 0) + A.sweep_report(self.SCOPED, 3, 2, 0, 1)
        for line in lines:
            self.assertIsNone(pattern.search(line), line)

    def test_a_scoped_run_always_names_what_it_did_not_run(self) -> None:
        for report in (
            A.sweep_report(self.SCOPED, 3, 3, 0, 0),
            A.sweep_report(self.SCOPED, 3, 2, 0, 1),
        ):
            self.assertIn(str(A.FULL_CASE_COUNT - 3), " ".join(report))


# ---------------------------------------------------------------------------
# AC-03 -- neither CI nor `saipen ship` can reach the subset
# ---------------------------------------------------------------------------


class GateBindingTests(unittest.TestCase):
    def test_ci_invokes_the_bare_full_sweep(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        runs = [
            line.strip()
            for line in text.splitlines()
            if re.match(r"^\s*run:\s*python tools/audit_checks\.py", line)
        ]
        self.assertEqual(runs, ["run: python tools/audit_checks.py"])

    def test_no_workflow_passes_the_scoping_flag(self) -> None:
        for workflow in (ROOT / ".github" / "workflows").glob("*.yml"):
            self.assertNotIn("--changed", workflow.read_text(encoding="utf-8"), workflow.name)

    def test_ship_never_invokes_this_harness_at_all(self) -> None:
        text = RELEASE.read_text(encoding="utf-8")
        self.assertNotIn("audit_checks", text)
        self.assertNotIn("--changed", text)

    def test_the_subset_needs_an_explicit_flag(self) -> None:
        # The binding property behind both assertions above: an argument-free
        # invocation is the full sweep, so a gate that forgets about this
        # feature entirely is still correct.
        self.assertIsNone(A.scoped_paths([]))


# ---------------------------------------------------------------------------
# AC-04 -- the blind spot is named, not silently trusted
# ---------------------------------------------------------------------------


class NamedLimitationsTests(unittest.TestCase):
    def test_the_banner_names_the_cross_reference_blind_spot(self) -> None:
        text = " ".join(A.scoped_banner(3, frozenset({"saipen/CORE.md"}))).lower()
        self.assertIn("known limitation", text)
        self.assertIn("declared target", text)
        self.assertIn("indirectly", text)
        self.assertIn("not proven by this run", text)

    def test_the_banner_says_it_is_not_the_full_sweep(self) -> None:
        text = " ".join(A.scoped_banner(3, frozenset({"saipen/CORE.md"})))
        self.assertIn("NOT the full sweep", text)

    def test_every_declared_limitation_reaches_the_banner(self) -> None:
        text = " ".join(A.scoped_banner(3, frozenset({"saipen/CORE.md"})))
        self.assertTrue(A.SCOPED_LIMITATIONS)
        for limitation in A.SCOPED_LIMITATIONS:
            self.assertIn(limitation, text)

    def test_the_always_on_probes_are_declared_as_still_running(self) -> None:
        # They are a handful of validator runs against 229, so narrowing them
        # would buy nothing and lose the checks that caught a disarmed control.
        text = " ".join(A.SCOPED_LIMITATIONS)
        self.assertIn("always-on probes still run", text)


if __name__ == "__main__":
    unittest.main()
