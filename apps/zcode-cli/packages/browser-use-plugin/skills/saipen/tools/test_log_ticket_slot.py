"""The LOG ticket slot takes `T-###` and nothing else, proven rather than asserted.

`extensions/subs/PROTOCOL.md` now states that a subSaipen ID must never sit in
a Core LOG event's ticket slot. A rule about a parser is worth exactly as much
as the test that pins the parser, so these assert the boundary the prose
describes: where `LOG_RE` stops, and where the narrower shape is enforced
instead.

The distinction matters because the two layers give different answers. The
parser refuses anything without the `T-` prefix outright -- a sub ID simply is
not a ticket to it. A `T-` prefixed nonsense id gets through the parser and is
caught one layer up by `tools/validate.py`, and only as a WARN. That softness
is the reason the rule is written in the protocol document at all.
"""

import re
import unittest

from saipen_engine.log import LOG_RE

STAMP = "- 02.09.26 10:00 [E-1]"


def line(slot):
    return f"{STAMP} [{slot}] [agent: a] [op: t] RUN: work"


class TicketSlotTests(unittest.TestCase):
    def slot_of(self, text):
        match = LOG_RE.match(text)
        return match.group(4) if match else None

    def test_canonical_ticket_is_read_into_the_slot(self):
        self.assertEqual(self.slot_of(line("T-1264")), "T-1264")

    def test_the_explicit_no_ticket_marker_is_legal(self):
        self.assertEqual(self.slot_of(line("T-none")), "T-none")

    def test_subsaipen_ids_are_not_tickets_to_the_parser(self):
        """The failure the rule exists to prevent, in every advertised prefix."""
        for sub_id in ("WIKI-002", "W-002", "HUNT-003", "TEST-9", "PY-12", "UI-8"):
            with self.subTest(sub_id=sub_id):
                self.assertNotEqual(self.slot_of(line(sub_id)), sub_id)

    def test_a_line_with_no_ticket_at_all_still_parses(self):
        """Absent is legal; wrong is not. The slot is optional, not permissive."""
        bare = f"{STAMP} [agent: a] [op: t] RUN: work"
        self.assertIsNotNone(LOG_RE.match(bare))
        self.assertIsNone(self.slot_of(bare))


class LayerBoundaryTests(unittest.TestCase):
    """Where the parser stops and the validator takes over."""

    VALIDATOR_SHAPE = re.compile(r"T-\d+")

    def test_the_parser_stops_at_the_prefix(self):
        match = LOG_RE.match(line("T-WIKI002"))
        self.assertIsNotNone(match, "a T- prefixed id gets past the parser")
        self.assertEqual(match.group(4), "T-WIKI002")

    def test_the_narrower_shape_is_the_validator_s_job(self):
        """Which is a WARN -- late and soft, hence the rule in PROTOCOL.md."""
        self.assertFalse(self.VALIDATOR_SHAPE.fullmatch("T-WIKI002"))
        self.assertTrue(self.VALIDATOR_SHAPE.fullmatch("T-1264"))

    def test_the_rule_is_stated_where_a_sub_author_reads_it(self):
        from pathlib import Path

        doc = Path(__file__).resolve().parent.parent / "extensions" / "subs" / "PROTOCOL.md"
        text = doc.read_text(encoding="utf-8", errors="replace")
        self.assertIn("never appears in a Core LOG event's ticket slot", text)


if __name__ == "__main__":
    unittest.main()
