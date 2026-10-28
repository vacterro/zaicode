"""T-1361: the scenario suite may not lose its own tail.

`tools/run_scenarios.py` reported 751 PASS / 3 FAIL and stopped. It was not
finished: one probe group RAISED, and since only `run_saicrew_probes` was
wrapped, the exception ended `_main_impl` and deleted every group after it from
the record -- green or red, seen or unseen. Repairing that crash exposed
roughly 153 checks nobody had ever looked at.

A suite that can lose its tail reports less than it measured, and from outside
the two look identical: a shorter run and a smaller number. So before any of
those checks is triaged, the runner itself is proven:

- every declared group is attempted;
- an exception inside one is a bounded recorded failure;
- it cannot abort the groups after it;
- the totals are the totals of what was attempted, so a crashed group appears
  as a zero with a reason rather than as an absence;
- the same holds one level down, for the per-fixture walk;
- and the structural guard: `_main_impl` may not call a probe group directly
  any more, because that is exactly how the unwrapped forty-four got there.

Run standalone:
    python tools/test_scenario_runner_isolation.py
"""

from __future__ import annotations

import ast
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import run_scenarios as R  # noqa: E402

#: Driven through the table, never called directly from `_main_impl`.
PROBE_GROUP_CALL = re.compile(r"^run_.*_(probes|probe|inventory)$")

#: The two the driver is allowed to call itself: the fixture walk runs before
#: the table exists, and the table runner is the thing being called.
DRIVER_OWNED = frozenset({"run_scenario_fixture_probes", "run_probe_groups"})


def groups(*specs):
    """Build a probe-group table from (name, result-or-exception) pairs."""

    def body(outcome):
        def run():
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        return run

    return tuple((name, body(outcome), f"{name} behavior(s) executed") for name, outcome in specs)


class GroupIsolationTests(unittest.TestCase):
    """An exception in one group is a result, not the end of the run."""

    def test_every_declared_group_is_attempted(self) -> None:
        table = groups(("a", ([], 3)), ("b", ([], 4)), ("c", ([], 5)))
        results = R.run_probe_groups(table)
        self.assertEqual([result.name for result in results], ["a", "b", "c"])
        self.assertEqual([result.checked for result in results], [3, 4, 5])

    def test_a_middle_group_that_raises_does_not_end_the_run(self) -> None:
        # The red control B1 asks for: throw inside a middle group, and the
        # LAST group must still execute.
        table = groups(
            ("first", ([], 2)),
            ("middle", RuntimeError("probe assumption bug")),
            ("last", ([], 7)),
        )
        results = R.run_probe_groups(table)
        self.assertEqual(len(results), 3)
        self.assertIsNone(results[0].crashed)
        self.assertEqual(results[1].crashed, "RuntimeError: probe assumption bug")
        self.assertIsNone(results[2].crashed, "the tail after a crash did not run")
        self.assertEqual(results[2].checked, 7)

    def test_the_crash_is_recorded_as_a_failure(self) -> None:
        results = R.run_probe_groups(groups(("middle", ValueError("boom"))))
        self.assertEqual(len(results[0].failures), 1)
        self.assertIn("middle harness crashed", results[0].failures[0])
        self.assertIn("ValueError: boom", results[0].failures[0])

    def test_a_crashed_group_is_a_zero_with_a_reason_not_an_absence(self) -> None:
        results = R.run_probe_groups(groups(("middle", ValueError("boom"))))
        line = results[0].summary_line()
        self.assertTrue(line.startswith("0 middle behavior(s) executed"))
        self.assertIn("HARNESS CRASHED", line)

    def test_the_totals_are_the_totals_of_what_was_attempted(self) -> None:
        table = groups(("a", ([], 3)), ("b", RuntimeError("x")), ("c", ([], 5)))
        results = R.run_probe_groups(table)
        self.assertEqual(len(results), len(table))
        self.assertEqual(sum(result.checked for result in results), 8)
        self.assertEqual(sum(1 for result in results if result.crashed), 1)

    def test_failures_survive_verbatim(self) -> None:
        # The cluster map reads these strings; a runner that reworded them
        # would quietly break every classification built on top.
        results = R.run_probe_groups(groups(("a", (["exactly this text"], 1))))
        self.assertEqual(results[0].failures, ["exactly this text"])

    def test_an_operator_stop_is_not_a_probe_failure(self) -> None:
        for stop in (KeyboardInterrupt(), SystemExit(2)):
            with self.subTest(type(stop).__name__), self.assertRaises(type(stop)):
                R.run_probe_groups(groups(("a", stop), ("b", ([], 1))))

    def test_a_group_returning_the_wrong_shape_is_a_failure_not_a_guess(self) -> None:
        results = R.run_probe_groups(groups(("a", None), ("b", ([], 1))))
        self.assertIsNotNone(results[0].crashed)
        self.assertIn("TypeError", results[0].crashed)
        self.assertIsNone(results[1].crashed)

    def test_the_skip_count_is_carried(self) -> None:
        results = R.run_probe_groups(groups(("a", ([], 4, 2))))
        self.assertEqual((results[0].checked, results[0].skipped), (4, 2))
        self.assertIn("2 skipped", results[0].summary_line())


class FixtureIsolationTests(unittest.TestCase):
    """The same rule one level down: one fixture cannot end the walk."""

    def scenarios(self, names) -> Path:
        root = Path(self.tmp.name) / "scenarios"
        for name in names:
            fixture = root / name
            fixture.mkdir(parents=True)
            # No `expect:` line and no `.saipen/`: a behavioral fixture, which
            # the walk skips. Nothing here is under test except the walk.
            (fixture / "README.md").write_text(f"# {name}\n", encoding="utf-8")
        return root

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-fixture-walk-")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_a_fixture_that_explodes_does_not_end_the_walk(self) -> None:
        root = self.scenarios(["alpha", "beta", "gamma"])
        exploding = mock.Mock()
        exploding.search.side_effect = RuntimeError("fixture reader bug")
        with mock.patch.object(R, "SCENARIOS", root), mock.patch.object(R, "EXPECT_RE", exploding):
            failures, checked, _skipped = R.run_scenario_fixture_probes()
        self.assertEqual(checked, 3, "the walk stopped before the last fixture")
        self.assertEqual(len(failures), 3)
        for name, failure in zip(["alpha", "beta", "gamma"], sorted(failures)):
            self.assertIn(f"{name}: fixture harness crashed", failure)
            self.assertIn("RuntimeError: fixture reader bug", failure)

    def test_the_walk_is_green_again_once_the_fixture_reader_works(self) -> None:
        root = self.scenarios(["alpha", "beta", "gamma"])
        with mock.patch.object(R, "SCENARIOS", root):
            failures, checked, skipped = R.run_scenario_fixture_probes()
        # No `.saipen/` in these fixtures, so each is behavioral and skipped --
        # the point is that the SAME walk reports cleanly once nothing raises.
        self.assertEqual(failures, [])
        self.assertEqual((checked, skipped), (0, 3))


class DriverStructureTests(unittest.TestCase):
    """The guard that keeps the forty-four inside the table."""

    def setUp(self) -> None:
        source = (ROOT / "tools" / "run_scenarios.py").read_text(encoding="utf-8-sig")
        self.impl = next(
            node
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.FunctionDef) and node.name == "_main_impl"
        )

    def test_no_probe_group_is_called_directly_by_the_driver(self) -> None:
        # A direct call is an unwrapped group, and an unwrapped group is the
        # defect. The targeted PROBES_ONLY dispatch has its own exit path and
        # its own table; this asserts the FULL-suite driver body.
        direct = sorted(
            {
                node.func.id
                for node in ast.walk(self.impl)
                if isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and PROBE_GROUP_CALL.match(node.func.id)
                and node.func.id not in DRIVER_OWNED
                and not self._inside_selector_dispatch(node)
            }
        )
        self.assertEqual(direct, [], f"probe group(s) called outside the table: {direct}")

    def _inside_selector_dispatch(self, call: ast.Call) -> bool:
        """Is this call part of the `--probes-only` group dispatch?"""
        for node in ast.walk(self.impl):
            if not isinstance(node, ast.For):
                continue
            if any(child is call for child in ast.walk(node)) and isinstance(
                node.iter, ast.Subscript
            ):
                return True
        return False

    def test_the_table_is_not_empty_and_has_no_duplicate_names(self) -> None:
        table = next(
            node
            for node in ast.walk(self.impl)
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "probe_groups"
                for target in node.targets
            )
        )
        names = [
            element.elts[0].value
            for element in table.value.elts
            if isinstance(element, ast.Tuple) and isinstance(element.elts[0], ast.Constant)
        ]
        self.assertGreaterEqual(len(names), 40)
        self.assertEqual(len(names), len(set(names)), "two groups share a name")


if __name__ == "__main__":
    unittest.main()
