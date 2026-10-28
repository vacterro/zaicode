"""T-1292: the KNOWLEDGE structured-surface check gets a permanent control.

`tools/validate.py`'s KNOWLEDGE card/index check landed in v7.254.0 proven by a
hand transcript: the gate was driven red twice and restored, and none of that
survived the session. `tools/audit_checks.py` CASES is hand-maintained and
nothing bound it to the validator, so the closing sweep line read the same
total before the check landed and after it landed -- the one sentence a
checkpoint quotes as proof the control ledger is intact did not move when a
check arrived uncovered.

Proven here:
- both failure classes of that check have a CASE, and the sweep total grew;
- each mutation drives the real `validate_knowledge` red on its own condition
  and the SAME verifier returns green once the mutation is restored;
- the check-inventory tripwire agrees with the live validator, sees an added
  fail site (its red control), and names what a count cannot prove.

Run standalone:
    python tools/test_check_inventory.py
"""

from __future__ import annotations

import ast
import json
import os
import shutil
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import audit_checks as A  # noqa: E402
import fail_site_inventory as I  # noqa: E402
from saipen_engine.knowledge import validate_knowledge, write_index  # noqa: E402

#: The nine fail sites E-6743 measured as uncovered, by IDENTITY. The event
#: recorded them as `tools/validate.py` line numbers, which were stale the
#: moment anything above them moved -- that is the defect this module closes,
#: so the record of it does not repeat the mistake.
E6743_UNCOVERED = (
    "47f4631bae337eff",  # activation template missing
    "9fe5817a2892b4fe",  # installed_relpath unavailable
    "8652bef78b223149",  # installed_relpath maps to the wrong name
    "8bebdf7a2b783dbd",  # activation template lost a marker
    "b4503430f7a17189",  # next_action disagrees with the shared Pick Rule
    "3bfe417dbc47866b",  # BOARD record with no allocation event
    "d0bcef4953fcb024",  # GOAL_BLOCKED beside workable Work
    "c299b922092d1c56",  # CONVERGE.md converge_targets differ from CORE.md
    "1e93fe466d2496cb",  # COMMANDS.md shortcut table differs from REGISTRY.json
)

KNOWLEDGE_CASES = (
    ("a KNOWLEDGE card declares a kind outside the closed set", "invalid kind"),
    ("a changed KNOWLEDGE card leaves the index projection stale", "INDEX.md is stale"),
)


def case_by_label(label: str):
    matches = [case for case in A.CASES if case[0] == label]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one CASE named {label!r}, found {len(matches)}")
    return A.case_parts(matches[0])


class CasePresenceTests(unittest.TestCase):
    """AC-01 -- the check has controls and the denominator grew to match."""

    def test_both_failure_classes_have_a_case(self) -> None:
        for label, expected in KNOWLEDGE_CASES:
            _, rel, _, declared_expected, gate = case_by_label(label)
            self.assertEqual(rel, A.KNOWLEDGE_CARD, label)
            self.assertEqual(declared_expected, expected, label)
            self.assertIsNone(gate, label)

    def test_the_two_cases_are_not_one_condition_twice(self) -> None:
        first = case_by_label(KNOWLEDGE_CASES[0][0])
        second = case_by_label(KNOWLEDGE_CASES[1][0])
        self.assertNotEqual(first[3], second[3])

    def test_the_sweep_total_counts_them(self) -> None:
        self.assertEqual(A.FULL_CASE_COUNT, len(A.CASES))
        labels = {case[0] for case in A.CASES}
        for label, _ in KNOWLEDGE_CASES:
            self.assertIn(label, labels)

    def test_the_card_target_selects_exactly_these_controls(self) -> None:
        changed = A.scoped_paths(["--changed", A.KNOWLEDGE_CARD])
        selected = {case[0] for case in A.select_cases(A.CASES, changed)}
        self.assertEqual(selected, {label for label, _ in KNOWLEDGE_CASES})

    def test_the_mutated_card_is_a_real_tracked_file(self) -> None:
        self.assertTrue((ROOT / A.KNOWLEDGE_CARD).is_file())
        self.assertTrue(A.case_available(ROOT, A.KNOWLEDGE_CARD, case_by_label(
            KNOWLEDGE_CASES[0][0]
        )[2]))


class MutationEfficacyTests(unittest.TestCase):
    """AC-02 -- red on its own condition, green again once restored.

    The verifier is held fixed across both halves: the same
    `validate_knowledge` call, over the same fixture, with only the card's
    bytes moving. Driving the whole CLI validator is what `audit_checks.py`
    does; repeating that here would buy a slower copy of the same proof.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-check-inventory-")
        self.root = Path(self.tmp.name) / "project"
        cards = self.root / ".saipen" / "KNOWLEDGE" / "cards"
        cards.mkdir(parents=True)
        self.card = cards / Path(A.KNOWLEDGE_CARD).name
        shutil.copyfile(ROOT / A.KNOWLEDGE_CARD, self.card)
        self.assertTrue(write_index(self.root)["ok"])
        self.original = self.card.read_bytes()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def errors(self) -> str:
        return " ".join(validate_knowledge(self.root)["errors"])

    def test_the_fixture_starts_green(self) -> None:
        result = validate_knowledge(self.root)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["index"], "fresh")

    def test_each_mutation_goes_red_then_green_again(self) -> None:
        for label, expected in KNOWLEDGE_CASES:
            _, _, mutation, _, _ = case_by_label(label)
            with self.subTest(label):
                text = self.card.read_text(encoding="utf-8")
                mutated = mutation(text)
                self.assertNotEqual(mutated, text, "mutation is a no-op")
                self.card.write_text(mutated, encoding="utf-8", newline="\n")
                self.assertIn(expected, self.errors(), label)

                self.card.write_bytes(self.original)
                self.assertEqual(validate_knowledge(self.root)["errors"], [], label)

    def test_neither_expected_string_is_printed_by_the_clean_fixture(self) -> None:
        # An expectation the unmutated subject already satisfies is not evidence.
        clean = self.errors()
        for _, expected in KNOWLEDGE_CASES:
            self.assertNotIn(expected, clean)

    def test_the_stale_mutation_does_not_rely_on_prose_wording(self) -> None:
        # An anchor inside the card's claim would silently no-op the day the
        # prose is rewritten; this mutation appends instead.
        _, _, mutation, _, _ = case_by_label(KNOWLEDGE_CASES[1][0])
        self.assertIsNone(getattr(mutation, "anchor", None))
        rewritten = "---\nkind: convention\n---\n\nEvery word of this card was rewritten.\n"
        self.assertNotEqual(mutation(rewritten), rewritten)


class FailSiteIdentityTests(unittest.TestCase):
    """T-1359 AC-01 -- a fail site is named by what it IS, not where it sits."""

    def setUp(self) -> None:
        self.source = (ROOT / I.VALIDATOR_REL).read_text(encoding="utf-8-sig")
        self.ids = {site.site_id for site in I.fail_sites(self.source)}

    def test_the_identity_is_deterministic(self) -> None:
        self.assertEqual({site.site_id for site in I.fail_sites(self.source)}, self.ids)

    def test_unrelated_line_insertion_renames_nothing(self) -> None:
        # The green control. Everything below the insertion moves by a line,
        # which is exactly what the previous session's line-numbered inventory
        # recorded -- and why it was stale before it was written down.
        padded = A.pad_above_fail_sites(self.source)
        self.assertNotEqual(padded, self.source)
        moved = {site.line for site in I.fail_sites(padded)}
        self.assertNotEqual(moved, {site.line for site in I.fail_sites(self.source)})
        self.assertEqual({site.site_id for site in I.fail_sites(padded)}, self.ids)

    def test_an_added_site_adds_exactly_one_identity(self) -> None:
        grown = {site.site_id for site in I.fail_sites(A.add_fail_site(self.source))}
        self.assertEqual(len(grown - self.ids), 1)
        self.assertEqual(grown & self.ids, self.ids)

    def test_a_removed_site_drops_exactly_one_identity(self) -> None:
        shrunk = {site.site_id for site in I.fail_sites(A.remove_fail_site(self.source))}
        self.assertEqual(len(self.ids - shrunk), 1)
        self.assertEqual(shrunk - self.ids, set())

    def test_a_same_count_swap_moves_the_identity_set(self) -> None:
        # THE control. This is the change the counting tripwire could not see:
        # `test_the_named_blind_spot_is_the_real_one` used to ASSERT that it
        # passed. One check leaves, another arrives, the total never moves.
        swapped = A.swap_fail_site(self.source)
        self.assertEqual(I.count_fail_sites(swapped), I.count_fail_sites(self.source))
        moved = {site.site_id for site in I.fail_sites(swapped)}
        self.assertNotEqual(moved, self.ids)
        self.assertEqual(len(moved - self.ids), 1, "the added site was not seen")
        self.assertEqual(len(self.ids - moved), 1, "the removed site was not seen")

    def test_the_line_number_is_report_metadata_only(self) -> None:
        site = I.fail_sites(self.source)[0]
        self.assertEqual(
            site.site_id, I.compute_site_id(site.qualname, site.signature, site.ordinal)
        )
        self.assertNotIn(str(site.line), site.signature)

    def test_identical_calls_in_one_function_stay_distinct(self) -> None:
        twice = (
            "def check():\n"
            "    fail('same words')\n"
            "    fail('same words')\n"
        )
        sites = I.fail_sites(twice)
        self.assertEqual(len(sites), 2)
        self.assertEqual(len({site.site_id for site in sites}), 2)
        self.assertEqual(sorted(site.ordinal for site in sites), [0, 1])

    def test_moving_a_check_between_functions_renames_it(self) -> None:
        here = I.fail_sites("def a():\n    fail('x')\n")[0]
        there = I.fail_sites("def b():\n    fail('x')\n")[0]
        self.assertNotEqual(here.site_id, there.site_id)

    def test_an_unparsable_validator_raises_rather_than_counting_zero(self) -> None:
        with self.assertRaises(SyntaxError):
            I.fail_sites("def broken(:\n")


class InventoryGateTests(unittest.TestCase):
    """T-1359 AC-02 -- the ledger is the authority, and it names names."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-fail-sites-")
        self.workdir = Path(self.tmp.name)
        self.source = (ROOT / I.VALIDATOR_REL).read_text(encoding="utf-8-sig")
        self.ledger = (ROOT / I.LEDGER_REL).read_text(encoding="utf-8-sig")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def fake_root(self, source: str, ledger: str | None = None) -> Path:
        root = self.workdir / f"fake-{len(list(self.workdir.iterdir()))}"
        (root / "tools").mkdir(parents=True, exist_ok=True)
        (root / I.VALIDATOR_REL).write_text(source, encoding="utf-8", newline="\n")
        (root / I.LEDGER_REL).write_text(
            self.ledger if ledger is None else ledger, encoding="utf-8", newline="\n"
        )
        return root

    def test_the_live_repository_agrees_with_its_ledger(self) -> None:
        self.assertEqual(I.inventory_errors(ROOT), [])

    def test_the_probe_passes_on_the_real_repository(self) -> None:
        self.assertIsNone(A.check_inventory_probe(ROOT, self.workdir))

    def test_an_added_fail_site_is_named(self) -> None:
        errors = I.inventory_errors(self.fake_root(A.add_fail_site(self.source)))
        self.assertTrue(any(error.startswith("ADDED") for error in errors), errors)
        self.assertTrue(any("synthetic red-control fail site" in e for e in errors), errors)

    def test_a_removed_fail_site_is_named_too(self) -> None:
        errors = I.inventory_errors(self.fake_root(A.remove_fail_site(self.source)))
        self.assertTrue(any(error.startswith("REMOVED") for error in errors), errors)

    def test_the_same_count_swap_names_BOTH_halves(self) -> None:
        # Mandatory (T-1359 A1.3): the count is identical, so anything that
        # reports only one half is a counter wearing an inventory's clothes.
        swapped = A.swap_fail_site(self.source)
        self.assertEqual(I.count_fail_sites(swapped), I.count_fail_sites(self.source))
        errors = I.inventory_errors(self.fake_root(swapped))
        self.assertTrue(any(error.startswith("ADDED") for error in errors), errors)
        self.assertTrue(any(error.startswith("REMOVED") for error in errors), errors)

    def test_unrelated_line_insertion_is_accepted(self) -> None:
        padded = self.fake_root(A.pad_above_fail_sites(self.source))
        self.assertEqual(I.inventory_errors(padded), [])

    def test_an_unparsable_validator_is_reported_not_counted(self) -> None:
        errors = I.inventory_errors(self.fake_root("def broken(:\n"))
        self.assertTrue(any("does not parse" in error for error in errors), errors)

    def test_a_missing_ledger_is_reported(self) -> None:
        root = self.workdir / "no-ledger"
        (root / "tools").mkdir(parents=True)
        (root / I.VALIDATOR_REL).write_text(self.source, encoding="utf-8", newline="\n")
        errors = I.inventory_errors(root)
        self.assertTrue(any("ledger" in error for error in errors), errors)

    def test_regeneration_never_mints_a_baseline(self) -> None:
        # What makes BASELINE shrink-only: the regenerator cannot write one, so
        # a check that arrives today cannot inherit yesterday's excuse.
        root = self.fake_root(A.add_fail_site(self.source))
        (root / I.LEDGER_REL).write_text(I.regenerate(root), encoding="utf-8", newline="\n")
        ledger = I.load_ledger(root)
        fresh = [r for r in ledger["sites"] if r["disposition"] == I.UNADJUDICATED]
        self.assertEqual(len(fresh), 1, "a new site was silently adjudicated")
        self.assertNotIn(I.UNADJUDICATED, I.DISPOSITIONS)

    def test_an_unadjudicated_record_keeps_the_gate_red(self) -> None:
        root = self.fake_root(A.add_fail_site(self.source))
        (root / I.LEDGER_REL).write_text(I.regenerate(root), encoding="utf-8", newline="\n")
        errors = I.inventory_errors(root)
        self.assertTrue(any(I.UNADJUDICATED in error for error in errors), errors)

    def test_regeneration_keeps_an_adjudicated_verdict(self) -> None:
        root = self.fake_root(self.source)
        (root / I.LEDGER_REL).write_text(I.regenerate(root), encoding="utf-8", newline="\n")
        self.assertEqual(I.inventory_errors(root), [])
        covered = [r for r in I.load_ledger(root)["sites"] if r["disposition"] == I.COVERED]
        self.assertTrue(covered)
        self.assertTrue(all(record.get("case") for record in covered))

    def test_a_covered_record_must_name_a_live_case(self) -> None:
        ledger = json.loads(self.ledger)
        for record in ledger["sites"]:
            if record["disposition"] == I.COVERED:
                record["case"] = "a control nobody ships"
                break
        error = A.check_inventory_probe(
            self.fake_root(self.source, json.dumps(ledger, indent=2) + "\n"), self.workdir
        )
        self.assertIsNotNone(error)
        self.assertIn("not a CASE", error)

    def test_every_covered_record_names_a_case_that_exists(self) -> None:
        labels = {case[0] for case in A.CASES}
        for record in I.load_ledger(ROOT)["sites"]:
            if record["disposition"] == I.COVERED:
                self.assertIn(record["case"], labels, record["site_id"])

    def test_every_disposition_is_in_the_closed_set(self) -> None:
        for record in I.load_ledger(ROOT)["sites"]:
            self.assertIn(record["disposition"], I.DISPOSITIONS, record["site_id"])

    def test_the_e6743_delta_is_adjudicated(self) -> None:
        # The nine sites E-6743 measured as uncovered. Recorded by identity
        # here, so this test does not rot the next time a line moves.
        recorded = I.ledger_index(I.load_ledger(ROOT))
        for site_id in E6743_UNCOVERED:
            self.assertIn(site_id, recorded, site_id)
            self.assertNotEqual(recorded[site_id]["disposition"], I.BASELINE, site_id)

    def test_the_bound_is_stated_rather_than_trusted(self) -> None:
        text = A.CHECK_INVENTORY_LIMITATION.lower()
        self.assertIn("identity", text)
        self.assertIn("baseline", text)
        self.assertIn("not detected", text)


class ProbeIsolationTests(unittest.TestCase):
    """T-1359 AC-03 -- one invocation, every independent probe judged.

    `main` was a chain of `if error: ... return 1`, so the FIRST failing probe
    hid every probe behind it. That is how the validator's fail surface drifted
    to 332 against a recorded 327 without anyone seeing it, and how five
    mutation controls and the WARN-ownership probe sat broken behind it.

    The registry's names and dependency edges are the real ones; only the probe
    BODIES are stubbed, because the point under test is the sequencing layer
    and building the real fixtures costs four minutes.
    """

    def stubbed(self, failing=(), raising=()):
        def body(name):
            def run(context):
                if name in raising:
                    raise RuntimeError(f"{name} exploded")
                return f"forced failure in {name}" if name in failing else None

            return run

        return tuple(
            replace(probe, run=body(probe.name)) for probe in A.always_on_probes()
        )

    def run_stubbed(self, **kwargs):
        lines: list[str] = []
        with tempfile.TemporaryDirectory(prefix="saipen-probe-") as tmp:
            verdicts = A.run_probes(
                self.stubbed(**kwargs),
                A.ProbeContext(Path(tmp), list(A.CASES), None),
                out=lines.append,
            )
        return verdicts, lines

    def test_the_independent_probes_declare_no_prerequisite(self) -> None:
        independent = [p.name for p in A.always_on_probes() if not p.requires]
        self.assertIn("root-nul-snapshot", independent)
        self.assertIn("audit-tags-batch", independent)
        self.assertGreaterEqual(len(independent), 4)

    def test_every_probe_is_judged_in_one_invocation(self) -> None:
        verdicts, _ = self.run_stubbed()
        self.assertEqual(len(verdicts), len(A.always_on_probes()))
        self.assertEqual(set(verdicts.values()), {"PASS"})

    def test_two_independent_failures_are_BOTH_reported(self) -> None:
        # The red control T-1359 A3 asks for: force an early always-on probe to
        # fail AND the validator inventory to fail, in the same invocation.
        verdicts, lines = self.run_stubbed(
            failing={"root-nul-snapshot", "validator-check-inventory"}
        )
        self.assertEqual(verdicts["root-nul-snapshot"], "FAIL")
        self.assertEqual(verdicts["validator-check-inventory"], "FAIL")
        self.assertTrue(any("root-nul-snapshot" in ln and ln.startswith("FAIL") for ln in lines))
        self.assertTrue(
            any("validator-check-inventory" in ln and ln.startswith("FAIL") for ln in lines)
        )
        # And the probes AFTER both of them still ran.
        self.assertEqual(verdicts["mutation-sweep"], "PASS")

    def test_restoring_both_returns_the_same_runner_to_green(self) -> None:
        verdicts, _ = self.run_stubbed()
        self.assertNotIn("FAIL", verdicts.values())
        self.assertNotIn("SKIP", verdicts.values())

    def test_a_dependent_probe_skips_out_loud_naming_its_prerequisite(self) -> None:
        verdicts, lines = self.run_stubbed(failing={"pristine-fixture"})
        self.assertEqual(verdicts["pristine-fixture"], "FAIL")
        self.assertEqual(verdicts["mutation-sweep"], "SKIP")
        skips = [ln for ln in lines if ln.startswith("SKIP:")]
        self.assertTrue(skips, lines)
        for line in skips:
            self.assertIn("because prerequisite pristine-fixture failed", line)
        # A prerequisite failure must not silence the INDEPENDENT probes.
        self.assertEqual(verdicts["root-nul-snapshot"], "PASS")
        self.assertEqual(verdicts["audit-tags-batch"], "PASS")

    def test_a_probe_that_raises_is_a_failed_probe_not_a_dead_run(self) -> None:
        verdicts, lines = self.run_stubbed(raising={"release-ledger"})
        self.assertEqual(verdicts["release-ledger"], "FAIL")
        self.assertTrue(any("RuntimeError" in ln for ln in lines), lines)
        self.assertEqual(verdicts["phase-rename"], "PASS")

    def test_each_probe_owns_its_sandbox_even_when_it_fails(self) -> None:
        seen: list[Path] = []

        def messy(context):
            seen.append(context.sandbox)
            (context.sandbox / "leftover").mkdir(parents=True, exist_ok=True)
            return "this probe failed after making a mess"

        probes = (
            A.Probe("messy", messy, "never printed"),
            A.Probe("after", lambda ctx: None, "the next probe still runs"),
        )
        with tempfile.TemporaryDirectory(prefix="saipen-probe-") as tmp:
            verdicts = A.run_probes(
                probes, A.ProbeContext(Path(tmp), list(A.CASES), None), out=lambda _line: None
            )
            self.assertEqual(verdicts, {"messy": "FAIL", "after": "PASS"})
            self.assertTrue(seen)
            self.assertFalse(seen[0].exists(), "a failing probe left its fixture behind")

    def test_main_carries_no_early_return(self) -> None:
        # Structural, and the whole point: a future `if error: return 1` in
        # `main` would restore the class of defect T-1359 exists to kill, so
        # the accounting has to stay in the report the runner builds.
        source = (ROOT / "tools" / "audit_checks.py").read_text(encoding="utf-8-sig")
        main = next(
            node
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.FunctionDef) and node.name == "main"
        )
        early = [
            node.lineno
            for node in ast.walk(main)
            if isinstance(node, ast.Return)
            and isinstance(node.value, ast.Constant)
            and node.value.value == 1
        ]
        self.assertEqual(early, [], f"main returns 1 early at line(s) {early}")


class HermeticProbeChildrenTests(unittest.TestCase):
    """T-1446 -- a probe child is addressed by its cwd, never by the operator session."""

    def test_the_child_env_strips_every_host_session_carrier(self) -> None:
        hostile = {
            "SAIPEN_PROJECT_ROOT": str(ROOT),
            "SAIPEN_PROJECT_LINEAGE": "lineage-" + "f" * 32,
            "SAIPEN_AGENT": "foreign-seat",
            "SAIPEN_HOST_SESSION": "ses_foreign",
        }
        with mock.patch.dict(os.environ, hostile, clear=False):
            env = A.hermetic_child_env(SAIPEN_VALIDATE_ALL_WARNINGS="1")
        for key in A.HOST_SESSION_VARIABLES:
            self.assertNotIn(key, env)
        self.assertEqual(env["SAIPEN_VALIDATE_ALL_WARNINGS"], "1")

    def test_every_python_child_is_launched_with_that_env(self) -> None:
        # Structural red control: a validator or corpus child launched WITHOUT
        # the hermetic env is the leak itself (measured: phase-rename judged the
        # live repository while its copy carried the rename), so no
        # `[sys.executable, ...]` call site may omit it.
        source = (ROOT / "tools" / "audit_checks.py").read_text(encoding="utf-8-sig")
        missing: list[int] = []
        for node in ast.walk(ast.parse(source)):
            if not (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "run"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "subprocess"
            ):
                continue
            argv = node.args[0] if node.args else None
            if not (
                isinstance(argv, ast.List)
                and argv.elts
                and isinstance(argv.elts[0], ast.Attribute)
                and argv.elts[0].attr == "executable"
            ):
                continue
            if "env" not in {kw.arg for kw in node.keywords}:
                missing.append(node.lineno)
        self.assertEqual(missing, [], f"python children without a hermetic env at {missing}")


if __name__ == "__main__":
    unittest.main()
