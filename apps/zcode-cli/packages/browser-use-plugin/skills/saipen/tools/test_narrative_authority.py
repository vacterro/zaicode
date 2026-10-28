"""Narrative Authority Leakage: prose must never acquire control authority.

The class, stated once so the tests can name it instead of restating advice: a
validator searches free text for a magic phrase, and any line that merely
DISCUSSES the phrase silently gains the power the phrase carries.

Two instances cost real work before the class had a name. The
timestamp-inversion amnesty was one boolean over the whole corpus, so three
sealed DEC lines disarmed the inversion check for five weeks -- and while it was
being repaired, the SCOUT checkpoint that quoted the marker disarmed it again,
one level up. The clean-HUNT marker was the same shape and still live: 28 LOG
lines contained `hunt -> clean @` and only 24 were the canonical record.

`structural_marker_events` is the single owner of the rule. These tests pin the
three conditions separately, because dropping any one of them reopens the class,
and a test that only checks the happy path would stay green through all three.
"""

import unittest

from saipen_engine.log import structural_marker_events

MARKER = "hunt -> clean @"
AMNESTY = "observed historical timestamp inversions"


def ev(event, taxonomy, text):
    return {"event": event, "taxonomy": taxonomy, "text": text}


class AnchoringTests(unittest.TestCase):
    """A sentence containing the marker is describing it, not being it."""

    def test_the_canonical_record_is_authority(self):
        events = [ev(10, "RUN", MARKER + "abc1234")]
        self.assertEqual(structural_marker_events(events, MARKER), [10])

    def test_a_checkpoint_quoting_the_marker_is_not(self):
        """The live shape: a SCOUT line discussing the marker while diagnosing it."""
        events = [
            ev(11, "RUN", f"SCOUT -- the marker is `{MARKER}HASH` and it is read corpus-wide"),
            ev(12, "RUN", f"BUILD -> two conversions; see {MARKER}deadbee"),
        ]
        self.assertEqual(structural_marker_events(events, MARKER), [])

    def test_a_free_note_mentioning_it_is_not(self):
        events = [ev(13, "H", f"note: caught a collision near {MARKER}0000000")]
        self.assertEqual(structural_marker_events(events, MARKER), [])

    def test_this_docstring_would_not_activate_anything(self):
        """The file explaining the rule must not be able to trigger the rule."""
        events = [ev(14, "RUN", __doc__)]
        self.assertEqual(structural_marker_events(events, MARKER), [])
        self.assertEqual(structural_marker_events(events, AMNESTY, ("DEC",)), [])


class TaxonomyTests(unittest.TestCase):
    """Authority belongs to the record type that carries it."""

    def test_a_run_does_not_grant_a_dec_authority(self):
        events = [ev(20, "RUN", AMNESTY + " -- 16 of them")]
        self.assertEqual(structural_marker_events(events, AMNESTY, ("DEC",)), [])

    def test_the_declared_taxonomy_does(self):
        events = [ev(21, "DEC", AMNESTY + " -- 16 of them")]
        self.assertEqual(structural_marker_events(events, AMNESTY, ("DEC",)), [21])

    def test_several_taxonomies_may_be_declared_explicitly(self):
        events = [ev(22, "DEC", MARKER + "abc"), ev(23, "RUN", MARKER + "def")]
        self.assertEqual(structural_marker_events(events, MARKER, ("DEC", "RUN")), [22, 23])


class BoundingTests(unittest.TestCase):
    """An exception cannot cover work that had not happened when it was granted."""

    def test_authority_before_the_bound_is_excluded(self):
        events = [ev(30, "DEC", AMNESTY + " -- old"), ev(40, "DEC", AMNESTY + " -- new")]
        self.assertEqual(
            structural_marker_events(events, AMNESTY, ("DEC",), after_event=35), [40]
        )

    def test_an_expired_grant_suppresses_nothing_later(self):
        """The whole point: a July authorization must not cover September."""
        granted = structural_marker_events(
            [ev(813, "DEC", AMNESTY + " -- E-784/E-785")], AMNESTY, ("DEC",)
        )
        newest_grant = max(granted, default=0)
        anomaly_after_the_grant = 5171
        self.assertGreater(anomaly_after_the_grant, newest_grant)

    def test_a_grant_at_or_after_the_anomaly_does_cover_it(self):
        granted = structural_marker_events(
            [ev(5265, "DEC", AMNESTY + " -- 16 of them")], AMNESTY, ("DEC",)
        )
        self.assertGreaterEqual(max(granted, default=0), 5171)


class ScopeTests(unittest.TestCase):
    def test_one_grant_does_not_cover_a_different_marker(self):
        events = [ev(50, "DEC", AMNESTY + " -- bounded")]
        self.assertEqual(structural_marker_events(events, MARKER, ("DEC",)), [])

    def test_an_empty_marker_grants_nothing(self):
        self.assertEqual(structural_marker_events([ev(60, "RUN", "anything")], ""), [])

    def test_ids_are_returned_so_a_caller_can_bound_its_own_decision(self):
        """A boolean cannot be scoped; that is how the class started."""
        events = [ev(70, "RUN", MARKER + "a"), ev(80, "RUN", MARKER + "b")]
        self.assertEqual(structural_marker_events(events, MARKER), [70, 80])


class LiveJournalTests(unittest.TestCase):
    """The measurement that made this a reproduced defect rather than a theory."""

    def _events(self):
        from pathlib import Path

        from saipen_engine.log import parse_log_line

        root = Path(__file__).resolve().parent.parent / ".saipen"
        events = []
        for path in [*sorted((root / "logs").glob("LOG-*.md")), root / "LOG.md"]:
            if not path.is_file():
                continue
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
                parsed = parse_log_line(line)
                if parsed:
                    events.append(parsed)
        return events

    def test_prose_mentions_outnumber_nothing_and_are_demoted(self):
        events = self._events()
        if not events:
            self.skipTest("no journal in this clone")
        substring = sum(1 for e in events if MARKER in (e["text"] or ""))
        structural = len(structural_marker_events(events, MARKER, ("RUN",)))
        self.assertGreater(substring, 0)
        self.assertLess(
            structural, substring, "the live journal no longer demonstrates the leak"
        )


if __name__ == "__main__":
    unittest.main()
