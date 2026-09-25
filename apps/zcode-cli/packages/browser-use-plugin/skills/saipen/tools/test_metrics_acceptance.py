"""Acceptance metrics and the escaped-defect taxonomy (T-1269).

The acceptance section exists to break one specific tie: "6 of 9 criteria
satisfied" reads identically whether a test re-runs the proof or a sentence
asserts it. These tests hold that split, hold the taxonomy closed, and hold the
tool observational -- a measuring instrument that gates something has stopped
measuring and started deciding.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import saipen_metrics  # noqa: E402

BOARD_HEADER = "# Board\n## DOING\n## TODO\n"
BOARD_FOOTER = "## DONE\n## BLOCKED\n"


def board(*ticket_lines: str) -> str:
    return BOARD_HEADER + "".join(line + "\n" for line in ticket_lines) + BOARD_FOOTER


def log(*bodies: str) -> str:
    """One LOG line per body, chained so the parser accepts them."""
    lines = ["# Log", ""]
    for index, body in enumerate(bodies, start=1):
        parent = f" [parent: E-{index - 1}]" if index > 1 else ""
        lines.append(
            f"- 03.09.26 10:0{index % 10} [E-{index}]{parent} [T-1] "
            f"[agent: probe] [op: checkpoint-{index:032d}] {body}"
        )
    return "\n".join(lines) + "\n"


def _engine_modules() -> dict:
    """Every loaded saipen_engine module, by name."""
    return {name: mod for name, mod in sys.modules.items() if name.startswith("saipen_engine")}


class AcceptanceSectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-metrics-acc-")
        self.saipen = Path(self.tmp.name) / ".saipen"
        self.saipen.mkdir(parents=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def write(self, board_text: str, log_text: str = "# Log\n") -> dict:
        (self.saipen / "BOARD.md").write_text(board_text, encoding="utf-8")
        (self.saipen / "LOG.md").write_text(log_text, encoding="utf-8")
        return saipen_metrics.acceptance_signals(self.saipen)

    # -- counting ---------------------------------------------------------

    def test_a_board_with_no_declared_criteria_counts_nothing(self) -> None:
        out = self.write(board("- [ ] T-1 [P2] work | verify: it looks right"))
        self.assertIsNone(out["unavailable"])
        self.assertEqual(out["criteria_total"], 0)
        self.assertEqual(out["tickets_with_criteria"], 0)

    def test_declared_criteria_without_evidence_are_unverified_not_satisfied(self) -> None:
        out = self.write(board("- [ ] T-1 [P2] work | verify: AC-01 a thing; AC-02 another"))
        self.assertEqual(out["criteria_total"], 2)
        self.assertEqual(out["tickets_with_criteria"], 1)
        self.assertEqual(out["unverified"], 2)
        self.assertEqual(out["satisfied"], 0)
        self.assertEqual(out["criteria_with_current_evidence"], 0)

    def test_a_behavioral_pass_counts_as_machine_re_runnable(self) -> None:
        out = self.write(
            board("- [ ] T-1 [P2] work | verify: AC-01 a thing"),
            log("RUN: AC-EVIDENCE AC-01 PASS behavioral -- test:x.py proves it"),
        )
        self.assertEqual(out["satisfied"], 1)
        self.assertEqual(out["deterministically_verified"], 1)
        self.assertEqual(out["manual_or_inspection_only"], 0)

    def test_an_inspection_pass_counts_as_a_human_assertion(self) -> None:
        out = self.write(
            board("- [ ] T-1 [P2] work | verify: AC-01 a thing"),
            log("RUN: AC-EVIDENCE AC-01 PASS inspection -- I read the file"),
        )
        self.assertEqual(out["satisfied"], 1)
        self.assertEqual(out["deterministically_verified"], 0)
        self.assertEqual(out["manual_or_inspection_only"], 1)

    def test_the_split_is_the_point_and_both_halves_sum_to_satisfied(self) -> None:
        out = self.write(
            board("- [ ] T-1 [P2] work | verify: AC-01 one; AC-02 two; AC-03 three"),
            log(
                "RUN: AC-EVIDENCE AC-01 PASS behavioral -- test:a",
                "RUN: AC-EVIDENCE AC-02 PASS static -- lint:b",
                "RUN: AC-EVIDENCE AC-03 PASS manual -- somebody looked",
            ),
        )
        self.assertEqual(out["satisfied"], 3)
        self.assertEqual(
            out["deterministically_verified"] + out["manual_or_inspection_only"],
            out["satisfied"],
        )
        self.assertEqual(out["deterministically_verified"], 2)

    def test_an_unknown_result_is_evidence_but_never_satisfies(self) -> None:
        """UNKNOWN records the reasoning without claiming the criterion is met."""
        out = self.write(
            board("- [ ] T-1 [P2] work | verify: AC-01 a thing"),
            log("RUN: AC-EVIDENCE AC-01 UNKNOWN inspection -- not applicable here"),
        )
        self.assertEqual(out["criteria_with_current_evidence"], 1)
        self.assertEqual(out["satisfied"], 0)
        self.assertEqual(out["unverified"], 1)

    def test_a_failed_criterion_is_reported_as_failed(self) -> None:
        out = self.write(
            board("- [ ] T-1 [P2] work | verify: AC-01 a thing"),
            log("RUN: AC-EVIDENCE AC-01 FAIL behavioral -- test:x.py red"),
        )
        self.assertEqual(out["failed"], 1)
        self.assertEqual(out["satisfied"], 0)

    def test_conflicting_records_are_contested_not_quietly_satisfied(self) -> None:
        out = self.write(
            board("- [ ] T-1 [P2] work | verify: AC-01 a thing"),
            log(
                "RUN: AC-EVIDENCE AC-01 PASS behavioral -- test:x.py",
                "RUN: AC-EVIDENCE AC-01 FAIL behavioral -- test:x.py again",
            ),
        )
        self.assertEqual(out["contested"], 1)
        self.assertEqual(out["satisfied"], 0)

    def test_evidence_naming_an_undeclared_criterion_is_surfaced(self) -> None:
        out = self.write(
            board("- [ ] T-1 [P2] work | verify: AC-01 a thing"),
            log("RUN: AC-EVIDENCE AC-07 PASS behavioral -- a promise nobody wrote down"),
        )
        self.assertEqual(out["undeclared_evidence_records"], 1)

    def test_sealed_segments_are_read_so_old_proof_still_counts(self) -> None:
        (self.saipen / "logs").mkdir()
        (self.saipen / "logs" / "LOG-001.md").write_text(
            log("RUN: AC-EVIDENCE AC-01 PASS behavioral -- proven months ago"),
            encoding="utf-8",
        )
        out = self.write(board("- [ ] T-1 [P2] work | verify: AC-01 a thing"))
        self.assertEqual(
            out["satisfied"], 1, "a criterion proven in a sealed segment is still proven"
        )

    # -- one parser, not two ----------------------------------------------

    def test_the_criterion_parser_is_the_engine_s_and_not_a_second_one(self) -> None:
        """A second parser would drift; the report would stop matching the CLI."""
        from saipen_engine import acceptance

        source = (ROOT / "tools" / "saipen_metrics.py").read_text(encoding="utf-8")
        self.assertIn("from saipen_engine.acceptance import", source)
        self.assertNotIn("AC-EVIDENCE ", source.replace("AC-EVIDENCE marker", ""))
        self.assertEqual(
            acceptance.EVIDENCE_CLASSES, ("inspection", "static", "behavioral", "manual")
        )

    def test_the_import_is_one_way(self) -> None:
        engine = ROOT / "tools" / "saipen_engine"
        for path in engine.glob("*.py"):
            self.assertNotIn(
                "saipen_metrics",
                path.read_text(encoding="utf-8"),
                f"{path.name} imports the reporter; the dependency must stay one-way",
            )


class EscapedDefectTaxonomyTests(unittest.TestCase):
    def signals(self, *raw_lines: str) -> dict:
        tickets = {
            f"T-{i}": {"raw": line} for i, line in enumerate(raw_lines, start=1)
        }
        return saipen_metrics.escaped_defect_signals(tickets)

    def test_the_vocabulary_is_a_closed_set(self) -> None:
        self.assertIsInstance(saipen_metrics.ESCAPED_CLASSES, tuple)
        self.assertEqual(
            len(set(saipen_metrics.ESCAPED_CLASSES)),
            len(saipen_metrics.ESCAPED_CLASSES),
            "a duplicated class would double-count the same escape",
        )
        for name in saipen_metrics.ESCAPED_CLASSES:
            self.assertRegex(name, r"^[A-Z][A-Z_]*$")

    def test_no_marker_declares_nothing(self) -> None:
        out = self.signals("- [ ] T-1 [P2] ordinary work | verify: AC-01 a thing")
        self.assertEqual(out["declared_total"], 0)
        self.assertEqual(out["by_class"], {})
        self.assertEqual(out["unknown_class"], [])

    def test_a_known_class_is_counted_by_class(self) -> None:
        out = self.signals(
            "- [ ] T-1 [P2] follow-up escaped: SCOPE_NARROWER_THAN_CLAIM | verify: AC-01 x",
            "- [ ] T-2 [P2] follow-up escaped: SCOPE_NARROWER_THAN_CLAIM | verify: AC-01 y",
            "- [ ] T-3 [P2] follow-up escaped: RULE_WITHOUT_DETECTOR | verify: AC-01 z",
        )
        self.assertEqual(out["declared_total"], 3)
        self.assertEqual(
            out["by_class"],
            {"SCOPE_NARROWER_THAN_CLAIM": 2, "RULE_WITHOUT_DETECTOR": 1},
        )
        self.assertEqual(out["unknown_class"], [])

    def test_an_unknown_class_is_named_and_never_silently_accepted(self) -> None:
        out = self.signals("- [ ] T-1 [P2] follow-up escaped: SOMETHING_NEW | verify: AC-01 x")
        self.assertEqual(out["declared_total"], 0, "an unknown class is not counted as a class")
        self.assertEqual(out["by_class"], {})
        self.assertEqual(out["unknown_class"], ["T-1:SOMETHING_NEW"])

    def test_an_unknown_class_does_not_suppress_the_known_ones(self) -> None:
        out = self.signals(
            "- [ ] T-1 [P2] escaped: TYPOED_CLASS | verify: AC-01 x",
            "- [ ] T-2 [P2] escaped: CONTROL_DISARMED | verify: AC-01 y",
        )
        self.assertEqual(out["by_class"], {"CONTROL_DISARMED": 1})
        self.assertEqual(out["unknown_class"], ["T-1:TYPOED_CLASS"])

    def test_the_class_is_case_insensitive_on_the_way_in(self) -> None:
        out = self.signals("- [ ] T-1 [P2] escaped: evidence_stale | verify: AC-01 x")
        self.assertEqual(out["by_class"], {"EVIDENCE_STALE": 1})

    def test_the_reported_vocabulary_is_the_constant(self) -> None:
        out = self.signals("- [ ] T-1 [P2] nothing | verify: AC-01 x")
        self.assertEqual(out["vocabulary"], list(saipen_metrics.ESCAPED_CLASSES))


class ObservationalTests(unittest.TestCase):
    """AC-04: it measures. It does not decide, and it does not write."""

    def test_a_full_run_writes_nothing_under_saipen(self) -> None:
        before = {
            path: path.read_bytes()
            for path in sorted((ROOT / ".saipen").rglob("*"))
            if path.is_file()
        }
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "saipen_metrics.py"), "--json"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        after = {
            path: path.read_bytes()
            for path in sorted((ROOT / ".saipen").rglob("*"))
            if path.is_file()
        }
        self.assertEqual(before, after, "the reporter mutated project state")

    def test_the_section_is_in_the_json_record(self) -> None:
        result = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "saipen_metrics.py"), "--json"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        data = json.loads(result.stdout)
        self.assertIn("acceptance", data)
        self.assertIsNone(data["acceptance"]["unavailable"])
        self.assertIn("escaped_defects", data["acceptance"])

    def test_the_exit_code_never_depends_on_the_numbers(self) -> None:
        """A gate fails a build. This must not, whatever it counts."""
        source = (ROOT / "tools" / "saipen_metrics.py").read_text(encoding="utf-8")
        main_body = source[source.index("def main("):]
        self.assertNotIn("return 1", main_body)
        self.assertNotIn("sys.exit(1)", main_body)

    def test_a_missing_board_degrades_into_a_stated_condition(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = saipen_metrics.acceptance_signals(Path(tmp))
            self.assertEqual(out["unavailable"], "BOARD.md missing")

    def test_an_unreadable_engine_degrades_rather_than_raising(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            saipen = Path(tmp) / ".saipen"
            saipen.mkdir()
            (saipen / "BOARD.md").write_text(board(), encoding="utf-8")
            (saipen / "LOG.md").write_text("# Log\n", encoding="utf-8")
            broken = Path(tmp) / "broken"
            broken.mkdir()
            (broken / "saipen_engine").mkdir()
            (broken / "saipen_engine" / "__init__.py").write_text("", encoding="utf-8")
            (broken / "saipen_engine" / "acceptance.py").write_text(
                "raise RuntimeError('engine is broken')", encoding="utf-8"
            )
            original = sys.path[:]
            # T-1490: the engine modules are put BACK, the same objects, not
            # merely deleted. Deleted, every later import built fresh ones
            # while modules imported at discovery kept the old ones, so a
            # later module's patch.object hit an object the engine no longer
            # used (test_source_quarantine_route went red in one process).
            saved = _engine_modules()
            for name in saved:
                del sys.modules[name]
            sys.path.insert(0, str(broken))
            try:
                out = saipen_metrics.acceptance_signals(saipen)
            finally:
                sys.path[:] = original
                for name in _engine_modules():
                    del sys.modules[name]
                sys.modules.update(saved)
            self.assertIn("RuntimeError", out["unavailable"])
            self.assertEqual(_engine_modules(), saved)
            for name, module in saved.items():
                self.assertIs(sys.modules[name], module, name)


class LiveProjectTests(unittest.TestCase):
    """The section must survive this repository's own board, not just fixtures."""

    def test_the_live_board_reports_without_error(self) -> None:
        out = saipen_metrics.acceptance_signals(ROOT / ".saipen")
        self.assertIsNone(out["unavailable"])
        self.assertGreater(out["criteria_total"], 0)
        self.assertEqual(
            out["satisfied"],
            out["deterministically_verified"] + out["manual_or_inspection_only"],
        )

    def test_the_rendered_section_names_both_halves_of_satisfied(self) -> None:
        text = saipen_metrics.render_acceptance(
            saipen_metrics.acceptance_signals(ROOT / ".saipen")
        )
        self.assertIn("machine re-runnable", text)
        self.assertIn("a human assertion only", text)
        self.assertIn("escaped defects declared", text)


if __name__ == "__main__":
    unittest.main()
