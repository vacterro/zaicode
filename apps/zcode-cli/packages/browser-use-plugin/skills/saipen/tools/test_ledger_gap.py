"""Ledger-gap detection and its bounded amnesty (T-1285).

A gap in an append-only ledger means events were lost or removed, and the fast
path exists to notice that cheaply -- before a mutation is journaled, rather
than at the next release gate. The rule arrived in this working tree loosened
to `event <= prev`, which reports a BACKWARDS id and nothing else: a log holding
E-001 followed by E-005 returned no error at all, and a forged line inserted
into a gap rode straight through.

Restoring strict consecutiveness alone is not the answer either. It was measured
to WEDGE a real project on this install -- one carrying two documented T-222-era
holes in its chain -- so every SAIOPS mutation there was refused and the agent
resorted to hand-writing events. Both requirements are real: a gap must be
detectable, and a project with legitimate historical gaps must not be
permanently blocked.

The shape that satisfies both is already in this codebase:
`log.structural_marker_events`. A gap is a defect by default; a NAMED gap can be
exempted by a recorded decision, and the exemption carries the same three
conditions that keep prose from acquiring authority -- taxonomy, anchoring and
bounding. Each condition gets its own case here, because dropping any one of
them reopens Narrative Authority Leakage, and a happy-path test would stay green
through all three.

Scope, stated rather than implied: `_analyze_log` reads the ACTIVE LOG text, so
these cases are about gaps inside it. A gap spanning a sealed-segment boundary is
the canonical ledger's business (`log.snapshot_contract_errors`), which proves
strictly-increasing ids across segments rather than consecutiveness.
"""

from __future__ import annotations

import unittest

from saipen_engine.fast_check import _analyze_log, _ledger_gap_amnesties

from test_hermetic_env import isolate_host_session


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


MARKER = "LEDGER-GAP AMNESTY "


def event(eid: int, taxonomy: str = "RUN", text: str = "work", parent: int | None = None) -> str:
    parent_field = f" [parent: E-{parent}]" if parent is not None else ""
    return f"- 04.09.26 10:00 [E-{eid}]{parent_field} [agent: a] [op: t] {taxonomy}: {text}"


def log(*lines: str) -> str:
    return "# Log\n" + "\n".join(lines) + "\n"


class GapDetection(unittest.TestCase):
    def test_a_consecutive_chain_is_clean(self) -> None:
        analysis = _analyze_log(log(event(1), event(2, parent=1), event(3, parent=2)))
        self.assertEqual(analysis.errors, [])
        self.assertEqual(analysis.amnestied, ())
        self.assertEqual(analysis.tail, 3)

    def test_a_gap_is_reported(self) -> None:
        """The measured regression: E-001 then E-005 returned no error at all."""
        analysis = _analyze_log(log(event(1), event(5, parent=1)))
        self.assertEqual(len(analysis.errors), 1)
        self.assertIn("E-5 is not consecutive after E-1", analysis.errors[0])
        self.assertEqual(analysis.amnestied, ())

    def test_the_diagnostic_says_consecutive_not_monotonic(self) -> None:
        """The old string claimed a contract the canonical validator owns.

        `validate.py` requires ids to INCREASE monotonically across segments;
        this check is stricter on purpose, and a message naming the weaker
        contract is how the loosening looked defensible in the first place.
        """
        analysis = _analyze_log(log(event(1), event(5, parent=1)))
        self.assertNotIn("monotonicity", analysis.errors[0])
        self.assertIn("lost or removed", analysis.errors[0])
        self.assertIn(MARKER, analysis.errors[0])

    def test_a_backwards_id_is_still_reported(self) -> None:
        analysis = _analyze_log(log(event(5), event(2)))
        self.assertEqual(len(analysis.errors), 1)
        self.assertIn("E-2 is not consecutive after E-5", analysis.errors[0])

    def test_a_duplicate_is_still_reported(self) -> None:
        analysis = _analyze_log(log(event(1), event(1)))
        self.assertTrue(any("duplicate event E-1" in e for e in analysis.errors))


class AmnestyGrant(unittest.TestCase):
    def test_a_named_gap_is_exempted_and_still_visible(self) -> None:
        """Unwedging is the point, and silence is not how it is done."""
        analysis = _analyze_log(
            log(
                event(1),
                event(5, parent=1),
                event(
                    6,
                    taxonomy="DEC",
                    text=f"{MARKER}E-1 -> E-5 -- two T-222-era holes",
                    parent=5,
                ),
            )
        )
        self.assertEqual(analysis.errors, [])
        self.assertEqual(len(analysis.amnestied), 1)
        self.assertIn("E-5 follows E-1 through an amnestied ledger gap", analysis.amnestied[0])

    def test_an_exempted_project_can_still_be_mutated(self) -> None:
        """The wedge: with no escape, every SAIOPS mutation on that tree refused."""
        history = log(
            event(1),
            event(5, parent=1),
            event(6, taxonomy="DEC", text=f"{MARKER}E-1 -> E-5 -- documented", parent=5),
        )
        appended = history + event(7, parent=6) + "\n"
        self.assertEqual(_analyze_log(appended).errors, [])

    def test_one_amnesty_does_not_cover_a_second_gap(self) -> None:
        analysis = _analyze_log(
            log(
                event(1),
                event(5, parent=1),
                event(6, taxonomy="DEC", text=f"{MARKER}E-1 -> E-5 -- documented", parent=5),
                event(9, parent=6),
            )
        )
        self.assertEqual(len(analysis.amnestied), 1)
        self.assertEqual(len(analysis.errors), 1)
        self.assertIn("E-9 is not consecutive after E-6", analysis.errors[0])


class AmnestyConditions(unittest.TestCase):
    """Taxonomy, anchoring, bounding -- `log.structural_marker_events`' three."""

    def test_a_run_reporting_an_amnesty_does_not_grant_one(self) -> None:
        analysis = _analyze_log(
            log(
                event(1),
                event(5, parent=1),
                event(6, taxonomy="RUN", text=f"{MARKER}E-1 -> E-5 -- reported", parent=5),
            )
        )
        self.assertEqual(analysis.amnestied, ())
        self.assertEqual(len(analysis.errors), 1)

    def test_a_dec_merely_discussing_one_does_not_grant_it(self) -> None:
        """Anchoring: a sentence containing the marker is describing it."""
        analysis = _analyze_log(
            log(
                event(1),
                event(5, parent=1),
                event(
                    6,
                    taxonomy="DEC",
                    text=f"we could write {MARKER}E-1 -> E-5 once someone adjudicates it",
                    parent=5,
                ),
            )
        )
        self.assertEqual(analysis.amnestied, ())
        self.assertEqual(len(analysis.errors), 1)

    def test_an_amnesty_for_another_pair_covers_nothing(self) -> None:
        analysis = _analyze_log(
            log(
                event(1),
                event(5, parent=1),
                event(6, taxonomy="DEC", text=f"{MARKER}E-40 -> E-44 -- elsewhere", parent=5),
            )
        )
        self.assertEqual(analysis.amnestied, ())
        self.assertEqual(len(analysis.errors), 1)

    def test_an_amnesty_granted_before_the_gap_covers_nothing(self) -> None:
        """Bounding: a decision cannot exempt a hole that did not exist yet.

        This is the property that let three July DECs disarm the
        timestamp-inversion check for five weeks. A pre-dated grant here would
        be a standing licence to open gaps for the rest of the project's life.
        """
        analysis = _analyze_log(
            log(
                event(1, taxonomy="DEC", text=f"{MARKER}E-3 -> E-8 -- pre-authorized"),
                event(2, parent=1),
                event(3, parent=2),
                event(8, parent=3),
            )
        )
        self.assertEqual(analysis.amnestied, ())
        self.assertEqual(len(analysis.errors), 1)
        self.assertIn("E-8 is not consecutive after E-3", analysis.errors[0])

    def test_the_grant_map_carries_the_deciding_event_id(self) -> None:
        """A boolean cannot be bounded; that is how the class starts."""
        grants = _ledger_gap_amnesties(
            log(
                event(1),
                event(5, parent=1),
                event(6, taxonomy="DEC", text=f"{MARKER}E-1 -> E-5 -- documented", parent=5),
            )
        )
        self.assertEqual(grants, {(1, 5): 6})


class RedControl(unittest.TestCase):
    def test_no_constant_answer_satisfies_this_class(self) -> None:
        """Neither verdict can be hardcoded.

        A checker stuck on "clean" passes every exemption case; one stuck on
        "gap" passes every detection case. Both must hold in one assertion.
        """
        gapped = _analyze_log(log(event(1), event(5, parent=1)))
        exempted = _analyze_log(
            log(
                event(1),
                event(5, parent=1),
                event(6, taxonomy="DEC", text=f"{MARKER}E-1 -> E-5 -- documented", parent=5),
            )
        )
        self.assertEqual(len(gapped.errors), 1)
        self.assertEqual(exempted.errors, [])
        self.assertNotEqual(bool(gapped.errors), bool(exempted.errors))
        self.assertNotEqual(bool(gapped.amnestied), bool(exempted.amnestied))


if __name__ == "__main__":
    unittest.main()
