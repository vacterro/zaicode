"""Cover the write-time stamp guard and the scope of the inversion amnesty.

Two things went wrong to produce T-1261, and each gets its own tests here.

`tools/_log_append.py` appended whatever line it was handed. LOG.md is
append-only, so a mistyped stamp is permanent: E-2068 (`26.08.05`) and E-5171
(`26.09.01`) are both the ISO order written into a day-first field, landing 21
and 25 years in the past. The guard has to refuse those before the write and
write nothing at all when it does.

`tools/validate.py` had a check that would have caught both and could not fire:
its amnesty was one boolean over the whole corpus, so three sealed DECs from
July 2026 covered every line written afterwards. The amnesty is now scoped to
the event ids a DEC can actually have known about, and only a DEC grants it --
a RUN line that merely quotes the phrase must not, which is exactly how the
SCOUT checkpoint for this ticket silenced the check while diagnosing it.
"""

import datetime
import unittest

import _log_append as guard

NOW = datetime.datetime(2026, 9, 2, 12, 0, tzinfo=datetime.timezone.utc)
EXISTING = "# Log\n- 02.09.26 11:00 [E-100] [agent: a] [op: t] RUN: previous\n"


class StampParsingTests(unittest.TestCase):
    def test_iso_order_is_not_a_valid_day_first_stamp(self):
        """`26.09.01` means day 26 of month 9; it is not 2026-09-01."""
        stamp, eid = guard.parse_stamp("- 26.09.01 13:20 [E-5171] RUN: x")
        self.assertEqual(eid, 5171)
        self.assertEqual(
            stamp,
            datetime.datetime(2001, 9, 26, 13, 20, tzinfo=datetime.timezone.utc),
        )

    def test_impossible_date_reports_invalid(self):
        stamp, _ = guard.parse_stamp("- 31.02.26 10:00 [E-9] RUN: x")
        self.assertEqual(stamp, "INVALID")

    def test_non_event_line_is_not_a_stamp(self):
        self.assertIsNone(guard.parse_stamp("# Log"))
        self.assertIsNone(guard.parse_stamp(""))


class GuardTests(unittest.TestCase):
    def test_good_line_passes(self):
        line = "- 02.09.26 11:30 [E-101] [agent: a] [op: t] RUN: fine"
        self.assertEqual(guard.check([line], EXISTING, NOW), [])

    def test_iso_order_stamp_is_refused_as_an_inversion(self):
        """The real E-5171 shape: parses, but lands decades before the tail."""
        line = "- 26.09.01 13:20 [E-101] [agent: a] [op: t] RUN: x"
        problems = guard.check([line], EXISTING, NOW)
        self.assertEqual(len(problems), 1)
        self.assertIn("BEHIND the last dated line", problems[0])

    def test_impossible_date_is_refused_with_the_field_order_hint(self):
        line = "- 31.02.26 13:20 [E-101] RUN: x"
        problems = guard.check([line], EXISTING, NOW)
        self.assertEqual(len(problems), 1)
        self.assertIn("does not name a real date", problems[0])
        self.assertIn("ISO order", problems[0])

    def test_future_stamp_is_refused(self):
        line = "- 02.09.26 23:00 [E-101] RUN: x"
        problems = guard.check([line], EXISTING, NOW)
        self.assertEqual(len(problems), 1)
        self.assertIn("ahead of real UTC", problems[0])

    def test_clock_slack_is_tolerated_in_both_directions(self):
        """Two machines may disagree by minutes; that is skew, not a bad stamp."""
        self.assertEqual(guard.check(["- 02.09.26 10:57 [E-101] RUN: x"], EXISTING, NOW), [])
        self.assertEqual(guard.check(["- 02.09.26 12:04 [E-101] RUN: x"], EXISTING, NOW), [])

    def test_non_event_lines_pass_through(self):
        self.assertEqual(guard.check(["", "# Log", "not an event"], EXISTING, NOW), [])

    def test_later_line_in_the_same_call_is_checked_against_the_earlier_one(self):
        lines = [
            "- 02.09.26 11:30 [E-101] RUN: first",
            "- 26.09.01 11:31 [E-102] RUN: second",
        ]
        problems = guard.check(lines, EXISTING, NOW)
        self.assertEqual(len(problems), 1)
        self.assertIn("line 2", problems[0])


class AmnestyScopeTests(unittest.TestCase):
    """The validator's rule, reproduced here as the property it must hold.

    `tools/validate.py` computes the newest DEC event id carrying the amnesty
    phrase and warns on any inversion above it. These assert the two cases the
    old boolean got wrong: a later inversion is not covered by an earlier DEC,
    and a RUN line quoting the phrase covers nothing at all.
    """

    PHRASE = "observed historical timestamp inversions"

    def _newest_documenting_dec(self, lines):
        import re

        ids = [
            int(match.group(1))
            for line in lines
            if self.PHRASE in line
            and "] DEC: " in line
            and (match := re.search(r"\[E-(\d+)\]", line))
        ]
        return max(ids, default=0)

    def test_dec_does_not_cover_an_inversion_written_after_it(self):
        lines = ["- 27.07.26 15:28 [E-813] [T-208] DEC: " + self.PHRASE + " (E-784/E-785)"]
        self.assertEqual(self._newest_documenting_dec(lines), 813)
        self.assertGreater(5171, self._newest_documenting_dec(lines))

    def test_run_line_quoting_the_phrase_grants_no_amnesty(self):
        lines = [
            "- 02.09.26 08:43 [E-5263] [T-1261] RUN: SCOUT -- " + self.PHRASE + " marker"
        ]
        self.assertEqual(self._newest_documenting_dec(lines), 0)

    def test_dec_at_or_after_the_inversion_covers_it(self):
        lines = ["- 02.09.26 09:00 [E-5266] [T-1261] DEC: " + self.PHRASE + " through E-5171"]
        self.assertGreaterEqual(self._newest_documenting_dec(lines), 5171)


if __name__ == "__main__":
    unittest.main()
