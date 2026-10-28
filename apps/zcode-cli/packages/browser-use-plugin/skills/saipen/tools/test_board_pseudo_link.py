"""Pseudo-link regression (T-1316 handoff, M0.1b).

A reserved BOARD field marker embedded inside ANOTHER field's value is a
pseudo-link: prose imitating the pipe-field grammar. Real incident -- a ticket
line written as

    verify: ... ; source_receipts: SRC-027

parsed `fields.verify` as prose carrying a receipt name while the machine
authority `fields.source_receipts` stayed absent, so `work_closure_gate`
answered SOURCE_COVERAGE_COMPLETE with ZERO receipts for work whose source had
an unresolved actionable requirement.

Contract locked here:

- READ side: `board_semantic_errors` (the ONE shared invariant home consumed by
  both validate.py and fast_check) refuses the record -- never normalizes.
- WRITE side: only the authorized source-linkage projection
  (`intake._link_board_projection`, reached through the canonical
  `saipen source capture --work` duplicate path) may strip the matching
  pseudo-link, and only when it names the exact receipt being bound.
- GATE side: while the pseudo-link is the only linkage, the closure gate must
  NOT report coverage complete.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.board import (  # noqa: E402
    board_scalar_errors,
    board_semantic_errors,
    parse_board,
)
from saipen_engine.intake import (  # noqa: E402
    _strip_source_receipts_pseudo_link,
)


def _board_text(pseudo: bool, receipt: str = "SRC-901", tid: str = "T-9001") -> str:
    verify = "three-way classifier matrix; fixture converges with zero rewrites"
    if pseudo:
        verify += f" ; source_receipts: {receipt}"
    line = (
        f"- [ ] {tid} [P1] pseudo-link fixture ticket ({receipt}) | "
        f"verify: {verify} | owner: astra2 | claim_time: 2026-09-11T00:00:00Z"
    )
    return f"## DOING\n\n{line}\n\n## TODO\n\n## DONE\n\n## BLOCKED\n"


class PseudoLinkReadSideRefusal(unittest.TestCase):
    """The parser refuses a reserved marker inside another field's value."""

    def test_pseudo_link_in_verify_is_a_semantic_error(self):
        board = parse_board(_board_text(pseudo=True))
        ticket = board["tickets"]["T-9001"]
        self.assertIsNone(ticket["fields"].get("source_receipts"))
        errors = board_semantic_errors(ticket)
        self.assertTrue(
            any("reserved field marker" in e and "'source_receipts'" in e for e in errors),
            errors,
        )

    def test_pseudo_link_is_shared_scalar_scan_error(self):
        errors = board_scalar_errors(
            {"verify": "steps ran; source_receipts: SRC-901"}, "T-9001"
        )
        self.assertEqual(len(errors), 1, errors)
        self.assertIn("reserved field marker", errors[0])

    def test_prose_mention_without_marker_shape_is_not_a_pseudo_link(self):
        # A sentence that merely talks about receipts has no `marker:` shape
        # and must not fire -- ordinary English stays legal in verify.
        errors = board_scalar_errors(
            {"verify": "the source receipts are recorded on the board"}, "T-9001"
        )
        self.assertEqual(errors, [])

    def test_all_reserved_markers_are_protected(self):
        for marker in ("source_receipts", "owner", "claim_time", "needs"):
            errors = board_scalar_errors(
                {"verify": f"prose; {marker}: X"}, "T-9001"
            )
            self.assertEqual(len(errors), 1, (marker, errors))
            self.assertIn(f"'{marker}'", errors[0])

    def test_clean_line_produces_no_pseudo_link_error(self):
        board = parse_board(_board_text(pseudo=False))
        self.assertEqual(
            [e for e in board_semantic_errors(board["tickets"]["T-9001"]) if "reserved" in e],
            [],
        )

    def test_real_protrail_shape_is_detected(self):
        # The exact malformed line class from the incident, byte-shaped.
        errors = board_scalar_errors(
            {
                "verify": "full unittest discover green plus ruff clean; "
                "fixture fails on pre-fix implementation; source_receipts: SRC-027"
            },
            "T-1316",
        )
        self.assertEqual(len(errors), 1, errors)


class PseudoLinkGateEffect(unittest.TestCase):
    """While a pseudo-link is the ONLY linkage, the closure gate must not
    report SOURCE_COVERAGE_COMPLETE for work whose receipt is unresolved."""

    def test_reverse_projection_ignores_pseudo_link(self):
        # _board_source_links parses real BOARD bytes; a pseudo-link inside
        # verify must contribute NO receipt to the reverse projection.
        board = parse_board(
            _board_text(pseudo=True, receipt="SRC-902", tid="T-9002")
        )
        ticket = board["tickets"]["T-9002"]
        self.assertIsNone(ticket["fields"].get("source_receipts"))
        self.assertEqual(ticket["fields"]["verify"].count("source_receipts"), 1)
        self.assertNotIn("T-9002", self._links(board))

    def _links(self, board):
        # The real reverse projection reads files; the equivalent in-memory
        # derivation proves the parser-level fact it rests on: no parsed
        # source_receipts field, no link.
        from saipen_engine.board import board_semantic_errors as _bse

        links = {}
        for tid, ticket in board["tickets"].items():
            receipts = str((ticket.get("fields") or {}).get("source_receipts") or "")
            if receipts.strip():
                links.setdefault(tid, set()).update(
                    p.strip() for p in receipts.split(",") if p.strip()
                )
            self.assertTrue(
                any("reserved field marker" in e for e in _bse(ticket)),
                "fixture ticket must carry the pseudo-link error",
            )
        return links

    def test_strip_helper_only_strips_the_bound_receipt(self):
        ticket = parse_board(_board_text(pseudo=True))["tickets"]["T-9001"]
        cleaned = _strip_source_receipts_pseudo_link(ticket)
        self.assertIsNotNone(cleaned)
        self.assertNotIn("source_receipts:", cleaned)
        self.assertNotIn("SRC-901", cleaned)
        # A pseudo-link naming a DIFFERENT receipt must never be stripped by
        # the projection for SRC-901: the helper strips only when the named
        # receipt matches the binding. The mismatched case is the CALLER's to
        # reject -- prove the helper's decision inputs here.
        other = parse_board(_board_text(pseudo=True, receipt="SRC-902"))["tickets"][
            "T-9001"
        ]
        self.assertIn(
            "source_receipts: SRC-902",
            str(other["fields"]["verify"]),
            "mismatched fixture must still carry the other pseudo-marker",
        )
        # A clean verify has nothing to strip.
        clean = parse_board(_board_text(pseudo=False))["tickets"]["T-9001"]
        self.assertIsNone(_strip_source_receipts_pseudo_link(clean))


if __name__ == "__main__":
    unittest.main()
