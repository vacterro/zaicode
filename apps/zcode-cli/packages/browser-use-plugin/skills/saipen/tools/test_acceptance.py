"""Acceptance reconciliation: absence, disagreement and prose must stay visible.

The failure this guards against is not a wrong answer, it is a confident one. A
completion claim becomes trustworthy only if the projection behind it refuses to
round UNVERIFIED up to SATISFIED, refuses to let a producer sentence count, and
refuses to pick a winner when two records disagree.

Every test here would pass just as well if the projection were generous, except
the ones that check what it declines to say -- so those are most of the file.
"""

import unittest

from saipen_engine.acceptance import (
    CONTESTED,
    FAILED,
    SATISFIED,
    UNVERIFIED,
    classify,
    collect_evidence,
    parse_criteria,
    parse_evidence_payload,
    reconcile,
    render,
)

from test_hermetic_env import isolate_host_session


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


T = "T-900"


def ev(event, text, ticket=T, taxonomy="RUN"):
    return {"event": event, "ticket": ticket, "taxonomy": taxonomy, "text": text}


def evidence(event, body, ticket=T):
    return ev(event, "AC-EVIDENCE " + body, ticket=ticket)


class CriterionParsingTests(unittest.TestCase):
    def test_criteria_are_read_in_declaration_order(self):
        parsed = parse_criteria("AC-01 first thing; AC-02 second thing; AC-03 third")
        self.assertEqual(list(parsed), ["AC-01", "AC-02", "AC-03"])
        self.assertEqual(parsed["AC-02"], "second thing")

    def test_a_legacy_clause_declares_nothing_and_is_not_an_error(self):
        legacy = "the repository-declared verification harness passes; unittest PASS"
        self.assertEqual(parse_criteria(legacy), {})

    def test_an_empty_clause_declares_nothing(self):
        self.assertEqual(parse_criteria(""), {})

    def test_a_duplicate_id_keeps_the_first_declaration(self):
        """An id that changes meaning mid-clause is worse than a stable one."""
        parsed = parse_criteria("AC-01 the promise; AC-01 something else entirely")
        self.assertEqual(parsed["AC-01"], "the promise")

    def test_prose_mentioning_an_ac_id_mid_sentence_is_not_a_criterion(self):
        self.assertEqual(parse_criteria("this behaves like AC-01 does; and more prose"), {})


class EvidenceGrammarTests(unittest.TestCase):
    def test_a_well_formed_record_parses(self):
        parsed = parse_evidence_payload("AC-01 PASS behavioral -- test:test_restart")
        self.assertEqual(parsed["ac"], "AC-01")
        self.assertEqual(parsed["result"], "PASS")
        self.assertEqual(parsed["kind"], "behavioral")
        self.assertEqual(parsed["detail"], "test:test_restart")

    def test_an_unknown_evidence_class_is_malformed(self):
        """An open vocabulary is how `verified-by-agent` walks back in."""
        self.assertIsNone(parse_evidence_payload("AC-01 PASS vibes -- it looked right"))

    def test_a_producer_claim_has_no_representable_form(self):
        for claim in (
            "AC-01 PASS claim -- I implemented it",
            "AC-01 DONE behavioral -- finished",
            "AC-01 looks correct",
        ):
            self.assertIsNone(parse_evidence_payload(claim), claim)

    def test_detail_is_optional(self):
        self.assertEqual(parse_evidence_payload("AC-02 FAIL static")["detail"], "")


class ProseCannotBecomeEvidenceTests(unittest.TestCase):
    """Requirement 1 and 2: neither producer nor auditor prose is authority."""

    def test_a_checkpoint_asserting_completion_moves_nothing(self):
        events = [
            ev(10, "transition to BUILD"),
            ev(11, "PASS conf: high -- implemented AC-01 and AC-02, both verified, done"),
        ]
        result = reconcile(T, "AC-01 a thing; AC-02 another", events)
        self.assertEqual({r["state"] for r in result["criteria"]}, {UNVERIFIED})

    def test_auditor_prose_quoting_the_marker_is_not_evidence(self):
        events = [
            ev(10, "transition to BUILD"),
            ev(12, "AUDIT -- the record would read AC-EVIDENCE AC-01 PASS behavioral -- x"),
        ]
        self.assertEqual(collect_evidence(T, events), [])

    def test_this_module_docstring_activates_nothing(self):
        events = [ev(10, "transition to BUILD"), ev(11, __doc__)]
        self.assertEqual(collect_evidence(T, events), [])


class BindingTests(unittest.TestCase):
    """Requirements 3 and 4: evidence binds to one criterion and only that one."""

    def test_structured_evidence_binds_to_its_criterion(self):
        events = [ev(10, "transition to BUILD"), evidence(11, "AC-01 PASS behavioral -- t")]
        result = reconcile(T, "AC-01 first; AC-02 second", events)
        states = {r["ac"]: r["state"] for r in result["criteria"]}
        self.assertEqual(states["AC-01"], SATISFIED)

    def test_evidence_for_one_criterion_never_satisfies_another(self):
        events = [ev(10, "transition to BUILD"), evidence(11, "AC-01 PASS behavioral -- t")]
        result = reconcile(T, "AC-01 first; AC-02 second", events)
        states = {r["ac"]: r["state"] for r in result["criteria"]}
        self.assertEqual(states["AC-02"], UNVERIFIED)

    def test_another_ticket_s_evidence_does_not_count(self):
        events = [
            ev(10, "transition to BUILD"),
            evidence(11, "AC-01 PASS behavioral -- t", ticket="T-901"),
        ]
        self.assertEqual(collect_evidence(T, events), [])

    def test_evidence_naming_an_undeclared_criterion_is_reported(self):
        events = [ev(10, "transition to BUILD"), evidence(11, "AC-07 PASS static -- t")]
        result = reconcile(T, "AC-01 only one promise", events)
        self.assertEqual(result["undeclared_evidence"], ["AC-07"])


class HonestStateTests(unittest.TestCase):
    """Requirements 5 and 6: absence and disagreement each get their own answer."""

    def test_missing_evidence_is_unverified(self):
        self.assertEqual(classify([]), UNVERIFIED)

    def test_conflicting_current_evidence_is_contested(self):
        events = [
            ev(10, "transition to BUILD"),
            evidence(11, "AC-01 PASS behavioral -- one run"),
            evidence(12, "AC-01 FAIL behavioral -- another run"),
        ]
        result = reconcile(T, "AC-01 a thing", events)
        self.assertEqual(result["criteria"][0]["state"], CONTESTED)

    def test_a_positive_violation_is_failed_not_unverified(self):
        events = [ev(10, "transition to BUILD"), evidence(11, "AC-01 FAIL behavioral -- broke")]
        self.assertEqual(reconcile(T, "AC-01 a thing", events)["criteria"][0]["state"], FAILED)

    def test_unknown_result_does_not_become_pass(self):
        events = [ev(10, "transition to BUILD"), evidence(11, "AC-01 UNKNOWN manual -- unclear")]
        self.assertEqual(
            reconcile(T, "AC-01 a thing", events)["criteria"][0]["state"], UNVERIFIED
        )

    def test_stale_evidence_alone_is_contested_not_satisfied(self):
        """It proved something -- about a tree that has since moved."""
        events = [
            evidence(9, "AC-01 PASS behavioral -- proven before the rebuild"),
            ev(10, "transition to BUILD"),
        ]
        result = reconcile(T, "AC-01 a thing", events)
        self.assertEqual(result["criteria"][0]["state"], CONTESTED)
        self.assertTrue(result["criteria"][0]["evidence"][0]["stale"])

    def test_fresh_evidence_after_a_rebuild_is_current(self):
        events = [
            evidence(9, "AC-01 PASS behavioral -- old"),
            ev(10, "transition to BUILD"),
            evidence(11, "AC-01 PASS behavioral -- re-proven"),
        ]
        self.assertEqual(
            reconcile(T, "AC-01 a thing", events)["criteria"][0]["state"], SATISFIED
        )


class ReadOnlyTests(unittest.TestCase):
    """Requirement 10: the projection writes nothing and repeats itself."""

    def test_reconciling_the_live_ticket_changes_no_canonical_byte(self):
        import subprocess
        import sys
        from pathlib import Path

        root = Path(__file__).resolve().parent.parent
        canonical = [
            root / ".saipen" / "BOARD.md",
            root / ".saipen" / "LOG.md",
            root / ".saipen" / "STATE.md",
        ]
        before = {p: p.read_bytes() for p in canonical if p.is_file()}
        if not before:
            self.skipTest("no canonical state in this clone")
        run = subprocess.run(
            [sys.executable, str(root / "tools" / "saipen.py"), "acceptance", "T-1267"],
            capture_output=True,
            text=True,
            cwd=str(root),
        )
        after = {p: p.read_bytes() for p in before}
        self.assertEqual(before, after, "acceptance mutated canonical state")
        self.assertIn(run.returncode, (0, 2))

    def test_the_projection_is_reproducible_from_the_same_inputs(self):
        events = [ev(10, "transition to BUILD"), evidence(11, "AC-01 PASS static -- t")]
        first = reconcile(T, "AC-01 a thing", events)
        second = reconcile(T, "AC-01 a thing", events)
        self.assertEqual(first, second)

    def test_render_distinguishes_a_legacy_ticket_from_a_proven_one(self):
        legacy = render(reconcile(T, "the harness passes", []))
        self.assertIn("no acceptance criteria declared", legacy)
        self.assertNotIn(SATISFIED, legacy)


if __name__ == "__main__":
    unittest.main()
