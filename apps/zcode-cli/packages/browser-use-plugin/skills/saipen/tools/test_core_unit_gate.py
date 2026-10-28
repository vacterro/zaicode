"""T-1344: the declared core-unit family is the SHIP evidence, not a narrower run.

`test_runner` declares one core-unit family (`python -m unittest discover -s
tools -p test_*.py`). Closures kept citing green from named modules run under
`python -m unittest tools.test_x`, which import dotted, never exercise the
discovery order, and never see the rest of the family -- so waves closed green
while the declared family carried dozens of red tests nobody saw.

These tests drive the REAL `transition_phase` into SHIP, because a gate proven
only in isolation is how the regression oracle once shipped with no caller.

Proven here:
- a project that declares the family cannot enter SHIP without a current-cycle
  record of it, and the refusal names the command that writes one;
- an honest run whose red set is inside the baseline is admitted;
- ONE new red test outside the baseline refuses the SHIP (the red control),
  both from a synthetic record and from a real unittest run parsed end to end;
- a record for a different tree, a tampered record, a stale baseline, a run
  that timed out, prose about a run, and a run from before the VERIFY boundary
  are each refused;
- only a PASS record of the exact tree and baseline is reused, and the evidence
  command cites it without rerunning (`--fresh` forces a run); the tree is
  everything the sandbox copies except `.saipen/` and `.git/`, so a change to
  tests/, extensions/ or a root file is a different subject;
- a record fingerprints the copy that ran, and a tree that drifted after the
  copy keeps the record but gets no citation;
- a refusal writes nothing, and a project that does not declare the family is
  untouched.

Run standalone:
    python tools/test_core_unit_gate.py
"""

from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import core_unit  # noqa: E402
from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.operations import checkpoint, transition_phase  # noqa: E402
from saipen_engine.test_runner import TestFamily  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session must never bind these disposable fixtures.
    isolate_host_session()


GREEN = "acceptance -> PASS conf: high"
INHERITED = ["test_old.OldTests.test_known_red"]


def _state(phase: str, transition_from: str, last_event: int) -> str:
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    home = str(ROOT).replace(chr(92), chr(92) * 2)
    return (
        "---\n"
        f"phase: {phase}\n"
        "task: T-7\n"
        f'next_action: "PHASE {phase} T-7"\n'
        'blocker: ""\n'
        f"transition_from: {transition_from}\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        f"last_event: {last_event}\n"
        "style_contract: ded-4ae736e4\n"
        f'saipen_home: "{home}"\n'
        "agent: tester\n"
        "requires:\n  - filesystem\n  - python\n"
        "mode: full\n"
        f'updated: "{now}"\n'
        "execution_intent: normal\n"
        "---\n"
    )


def _board() -> str:
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        "## DOING\n"
        f"- [/] T-7 [P1] Change the engine | verify: the engine holds "
        f"| owner: tester | claim_time: {now}\n"
        "## TODO\n## DONE\n## BLOCKED\n"
    )


def _run(red, *, ran: int = 10, status: str | None = None, exit_code: int | None = None):
    red = sorted(red)
    return {
        "status": status or ("FAIL" if red else "PASS"),
        "exit_code": exit_code if exit_code is not None else (1 if red else 0),
        "ran": ran,
        "red": red,
        "duration_s": 1.0,
        "timeout_s": 600,
        "command": ["python", "-B", "-m", "unittest", "discover", "-s", "tools"],
    }


class CoreUnitFixture(unittest.TestCase):
    """A project in BUILD on T-7; `declare` decides whether it owns the family."""

    DECLARE = True

    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="saipen-core-unit-gate-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        self.project = base / "project"
        (self.project / ".saipen").mkdir(parents=True)
        (self.project / ".saipen" / "STATE.md").write_text(
            _state("BUILD", "SCOUT", 1), encoding="utf-8"
        )
        (self.project / ".saipen" / "BOARD.md").write_text(_board(), encoding="utf-8")
        (self.project / ".saipen" / "LOG.md").write_text(
            "- 24.08.26 00:00 [E-001] [T-7] [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        ensure_project_lineage(self.project)
        (self.project / "saipen").mkdir()
        (self.project / "saipen" / "CORE.md").write_text("# core\n", encoding="utf-8")
        if self.DECLARE:
            declaration = self.project / core_unit.DECLARATION_REL
            declaration.parent.mkdir(parents=True)
            declaration.write_text("# declares the family\n", encoding="utf-8")
            self.write_baseline(INHERITED)

    def write_baseline(self, red) -> None:
        data = {"schema": core_unit.SCHEMA_VERSION, "family": core_unit.FAMILY_NAME, "red": red}
        (self.project / core_unit.BASELINE_REL).write_text(json.dumps(data), encoding="utf-8")

    def record(self, text: str) -> None:
        result = checkpoint(self.project, "tester", "RUN", "T-7", text)
        self.assertTrue(result.ok, result.to_dict())

    def cite(self, run: dict) -> dict:
        written = core_unit.write_record(
            self.project, run, core_unit.tree_fingerprint(self.project)
        )
        self.record(core_unit.evidence_line(written))
        return written

    def to(self, phase: str):
        return transition_phase(self.project, phase, "tester", "T-7", phase.lower())

    def reach_review(self) -> None:
        self.assertTrue(self.to("VERIFY").ok)
        self.record(GREEN)
        result = self.to("REVIEW")
        self.assertTrue(result.ok, result.to_dict())

    def canonical_digest(self) -> str:
        digest = hashlib.sha256()
        for name in ("STATE.md", "BOARD.md", "LOG.md"):
            digest.update((self.project / ".saipen" / name).read_bytes())
        return digest.hexdigest()


class RefusalTests(CoreUnitFixture):
    def assertRefused(self, fragment: str) -> None:
        result = self.to("SHIP")
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "INCOMPLETE_TICKET")
        self.assertIn(fragment, result.message)
        self.assertEqual(
            result.data.get("canonical_next_command"),
            "python tools/core_unit.py evidence T-7",
        )

    def test_no_run_of_the_declared_family_refuses_ship(self):
        """The headline: an ordinary green is no longer enough to ship."""
        self.reach_review()
        self.assertRefused("names no run of the declared core-unit family")

    def test_one_new_red_test_refuses_ship(self):
        """The red control: exactly one red outside the baseline."""
        self.reach_review()
        self.cite(_run([*INHERITED, "test_new.NewTests.test_broken"]))
        self.assertRefused("1 new red outside the baseline")

    def test_a_record_for_a_different_tree_is_refused(self):
        self.reach_review()
        self.cite(_run(INHERITED))
        (self.project / "saipen" / "CORE.md").write_text("# edited after\n", encoding="utf-8")
        self.assertRefused("tested a different tree")

    def test_a_tampered_record_is_refused(self):
        self.reach_review()
        written = self.cite(_run([*INHERITED, "test_new.NewTests.test_broken"]))
        path = self.project / written["path"]
        record = json.loads(path.read_text(encoding="utf-8"))
        record["red"] = INHERITED
        path.write_text(json.dumps(record), encoding="utf-8")
        self.assertRefused("does not match its sha256")

    def test_a_baseline_changed_after_the_run_is_refused(self):
        self.reach_review()
        self.cite(_run(INHERITED))
        self.write_baseline([*INHERITED, "test_other.T.test_y"])
        result = self.to("SHIP")
        self.assertFalse(result.ok, result.to_dict())
        # The baseline file lives in tools/, so the tree moved too; either
        # answer is a refusal of a stale citation.
        self.assertRegex(result.message, "different baseline|different tree")

    def test_a_run_that_timed_out_is_refused(self):
        self.reach_review()
        self.cite(_run([], ran=0, status="TIMEOUT", exit_code=None))
        self.assertRefused("did not finish")

    def test_prose_about_a_run_is_not_a_run(self):
        self.reach_review()
        written = core_unit.write_record(
            self.project, _run(INHERITED), core_unit.tree_fingerprint(self.project)
        )
        self.record(f"we ran it: {core_unit.evidence_line(written)}")
        self.assertRefused("names no run")

    def test_a_run_from_before_the_verify_boundary_does_not_count(self):
        self.cite(_run(INHERITED))
        self.reach_review()
        self.assertRefused("names no run")

    def test_a_missing_baseline_is_refused(self):
        self.reach_review()
        (self.project / core_unit.BASELINE_REL).unlink()
        self.assertRefused("no usable baseline")

    def test_the_refusal_writes_nothing(self):
        self.reach_review()
        before = self.canonical_digest()
        self.assertFalse(self.to("SHIP").ok)
        self.assertEqual(self.canonical_digest(), before)


class AdmissionTests(CoreUnitFixture):
    def test_an_honest_run_inside_the_baseline_ships(self):
        self.reach_review()
        self.cite(_run(INHERITED))
        result = self.to("SHIP")
        self.assertTrue(result.ok, result.to_dict())

    def test_a_run_that_fixed_an_inherited_red_ships(self):
        self.reach_review()
        written = self.cite(_run([]))
        self.assertEqual(written["record"]["fixed"], INHERITED)
        self.assertTrue(self.to("SHIP").ok)

    def test_the_latest_citation_decides(self):
        """A red run followed by a clean rerun of the same tree ships."""
        self.reach_review()
        self.cite(_run([*INHERITED, "test_new.NewTests.test_broken"]))
        self.cite(_run(INHERITED))
        self.assertTrue(self.to("SHIP").ok)


class ReuseTests(CoreUnitFixture):
    """A Work that changed none of the tested bytes cites the run that tested them."""

    def fingerprint(self) -> str:
        return core_unit.tree_fingerprint(self.project)

    def test_only_a_pass_of_this_exact_tree_is_reusable(self):
        core_unit.write_record(
            self.project, _run([*INHERITED, "test_new.N.test_x"]), self.fingerprint()
        )
        self.assertIsNone(core_unit.reusable_record(self.project, self.fingerprint()))
        passing = core_unit.write_record(self.project, _run(INHERITED), self.fingerprint())
        reused = core_unit.reusable_record(self.project, self.fingerprint())
        self.assertEqual(reused["path"], passing["path"])
        (self.project / "saipen" / "CORE.md").write_text("# moved\n", encoding="utf-8")
        self.assertIsNone(core_unit.reusable_record(self.project, self.fingerprint()))

    def test_a_change_outside_tools_and_saipen_is_a_different_subject(self):
        """The family reads tests/, bootstrap/, extensions/ and the root file set."""
        for relative in ("tests/scenarios/fixture.txt", "extensions/x/registry.json", "str"):
            with self.subTest(changed=relative):
                core_unit.write_record(self.project, _run(INHERITED), self.fingerprint())
                self.assertIsNotNone(core_unit.reusable_record(self.project, self.fingerprint()))
                path = self.project / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("changed\n", encoding="utf-8")
                self.assertIsNone(core_unit.reusable_record(self.project, self.fingerprint()))

    def test_canonical_state_and_caches_are_not_the_subject(self):
        before = self.fingerprint()
        self.record("verify -> a checkpoint rewrites .saipen")
        core_unit.write_record(self.project, _run(INHERITED), before)
        cache = self.project / "tools" / "__pycache__" / "x.cpython-311.pyc"
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(b"\0")
        self.assertEqual(self.fingerprint(), before)

    def test_a_lint_run_after_the_evidence_does_not_spend_it(self):
        """T-1483: `ruff check` rewrites .ruff_cache; REVIEW lints after VERIFY ran."""
        before = self.fingerprint()
        for relative in (".ruff_cache/0.16.0/123", ".mypy_cache/3.11/x.json"):
            with self.subTest(cache=relative):
                cache = self.project / relative
                cache.parent.mkdir(parents=True, exist_ok=True)
                cache.write_bytes(b"lint")
                self.assertEqual(self.fingerprint(), before)

    def test_a_tree_that_drifted_after_the_copy_keeps_the_record_but_cites_nothing(self):
        self.reach_review()
        copied = {**_run(INHERITED), "fingerprint": "0" * 64}
        out = io.StringIO()
        with mock.patch.object(core_unit, "run_family", return_value=copied), \
                contextlib.redirect_stdout(out):
            code = core_unit.main(["evidence", "T-7", "--project-root", str(self.project)])
        self.assertEqual(code, 1)
        payload = json.loads(out.getvalue())
        self.assertIn("changed after the family's copy was taken", payload["detail"])
        self.assertTrue((self.project / payload["record"]).is_file())
        self.assertFalse(self.to("SHIP").ok)

    def test_the_evidence_command_cites_a_reusable_run_without_rerunning(self):
        self.reach_review()
        core_unit.write_record(self.project, _run(INHERITED), self.fingerprint())
        with mock.patch.object(core_unit, "run_family") as run, contextlib.redirect_stdout(
            io.StringIO()
        ):
            code = core_unit.main(["evidence", "T-7", "--project-root", str(self.project)])
        run.assert_not_called()
        self.assertEqual(code, 0)
        self.assertTrue(self.to("SHIP").ok)

    def test_fresh_reruns_and_a_new_red_fails_the_command(self):
        self.reach_review()
        core_unit.write_record(self.project, _run(INHERITED), self.fingerprint())
        with mock.patch.object(
            core_unit, "run_family", return_value=_run([*INHERITED, "test_new.N.test_x"])
        ) as run, contextlib.redirect_stdout(io.StringIO()):
            code = core_unit.main(
                ["evidence", "T-7", "--project-root", str(self.project), "--fresh"]
            )
        run.assert_called_once()
        self.assertEqual(code, 1)
        self.assertFalse(self.to("SHIP").ok)


class UndeclaredProjectTests(CoreUnitFixture):
    DECLARE = False

    def test_a_project_without_the_family_is_untouched(self):
        self.reach_review()
        result = self.to("SHIP")
        self.assertTrue(result.ok, result.to_dict())


class OutputParsingTests(unittest.TestCase):
    HEADERS = (
        "FAIL: test_x (test_a.A.test_x)",
        "ERROR: setUpClass (test_b.B)",
        "ERROR: test_c (unittest.loader._FailedTest.test_c)",
        "UNEXPECTED SUCCESS: test_d (test_d.D.test_d)",
        "FAIL: test_x (test_a.A.test_x) (command='saipen recover \"quoted (x)\"')",
        "FAIL: test_x (test_a.A.test_x) (gate={'ok': False, 'code': 'X'})",
        "FAIL: test_e (test_e.E.test_e) [another window]",
    )
    SUMMARY = (
        "The grammar did not move. ... FAIL\n"
        "test_ok (test_a.A.test_ok) ... ok\n"
        # A test printing a header-shaped line is not a red test.
        "FAIL: runtime manifest names a file git does not track: tools/x.py\n"
        + "".join(
            f"\n{'=' * 70}\n{header}\nThe grammar did not move.\n{'-' * 70}\nTraceback\n"
            for header in HEADERS
        )
        + f"{'-' * 70}\n"
        "Ran 42 tests in 3.100s\n\n"
        "FAILED (failures=4, errors=2, skipped=3, unexpected successes=1)\n"
    )

    def test_ids_come_from_summary_headers_not_docstrings(self):
        """Subtests collapse to their test; `[msg]` and `(params)` never enter an id."""
        parsed = core_unit.parse_output(self.SUMMARY.replace("\n", "\r\n"))
        self.assertEqual(parsed["ran"], 42)
        self.assertEqual(
            parsed["red"],
            [
                "test_a.A.test_x",
                "test_b.B.setUpClass",
                "test_d.D.test_d",
                "test_e.E.test_e",
                "unittest.loader._FailedTest.test_c",
            ],
        )
        self.assertEqual((parsed["headers"], parsed["unparsed"], parsed["tallied"]), (7, 0, 7))

    def test_a_header_outside_the_id_grammar_fails_the_run(self):
        """A red the parser cannot name is a red the verdict would silently lose."""
        text = self.SUMMARY.replace(
            "FAIL: test_e (test_e.E.test_e) [another window]",
            "FAIL: test_e (weird id with spaces)",
        )
        parsed = core_unit.parse_output(text)
        self.assertEqual(parsed["unparsed"], 1)
        run = {**_run(parsed["red"], ran=parsed["ran"]), **parsed}
        verdict = core_unit.judge(run, parsed["red"])
        self.assertEqual(verdict["verdict"], "FAIL")
        self.assertIn("outside the id grammar", verdict["problems"][0])

    def test_a_tally_that_disagrees_with_the_headers_fails_the_run(self):
        parsed = core_unit.parse_output(self.SUMMARY.replace("failures=4", "failures=5"))
        run = {**_run(parsed["red"], ran=parsed["ran"]), **parsed}
        verdict = core_unit.judge(run, parsed["red"])
        self.assertEqual(verdict["verdict"], "FAIL")
        self.assertIn("tallied 8 red but 7 header(s)", verdict["problems"][0])

    def test_exit_code_without_a_parsed_red_is_not_a_pass(self):
        verdict = core_unit.judge(_run([], exit_code=1), [])
        self.assertEqual(verdict["verdict"], "FAIL")


class RealRunRedControlTests(unittest.TestCase):
    """The red control through a REAL unittest run, spool and parser included."""

    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="saipen-core-unit-run-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        self.project = base / "project"
        (self.project / "tools").mkdir(parents=True)
        (self.project / "tools" / "test_green.py").write_text(
            "import unittest\n\n\nclass G(unittest.TestCase):\n"
            "    def test_ok(self):\n        pass\n",
            encoding="utf-8",
        )
        small = TestFamily(
            core_unit.FAMILY_NAME,
            (sys.executable, "-B", "-m", "unittest", "discover", "-s", "tools", "-p", "test_*.py"),
            120,
        )
        patcher = mock.patch.object(core_unit, "family", return_value=small)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_one_added_red_test_turns_the_verdict(self):
        clean = core_unit.run_family(self.project)
        self.assertEqual((clean["ran"], clean["red"]), (1, []))
        # The record's subject is the copy that ran, and it is this tree.
        self.assertEqual(clean["fingerprint"], core_unit.tree_fingerprint(self.project))
        self.assertEqual(core_unit.judge(clean, [])["verdict"], "PASS")

        (self.project / "tools" / "test_red.py").write_text(
            "import unittest\n\n\nclass R(unittest.TestCase):\n"
            "    def test_red(self):\n        '''A docstring hides the id.'''\n"
            "        self.fail('deliberate')\n",
            encoding="utf-8",
        )
        red = core_unit.run_family(self.project)
        self.assertEqual(red["red"], ["test_red.R.test_red"])
        verdict = core_unit.judge(red, [])
        self.assertEqual(verdict["verdict"], "FAIL")
        self.assertEqual(verdict["new_red"], ["test_red.R.test_red"])
        # The same red, once inherited, stops blocking.
        self.assertEqual(core_unit.judge(red, ["test_red.R.test_red"])["verdict"], "PASS")


if __name__ == "__main__":
    unittest.main()
