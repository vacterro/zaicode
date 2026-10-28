"""T-1247: the warn-slug ownership probe must not vary BOARD size with ownership.

`tools/audit_checks.py`'s `warn_ownership_probe` proves that an aged WARN slug
fails unless a live BOARD ticket names it. It used to add its owning ticket
only in the GREEN leg and then assert that the WARN slug set was unchanged
between RED and GREEN. `tools/validate.py` warns `board-soft-cap` from
`BOARD.md`'s own byte size at 16 KB, so a fixture board sitting within one
ticket line of that threshold gained the slug in GREEN alone and the probe
reported a false ownership break.

Ownership is a substring test over live board lines, so slug PRESENCE and board
SIZE are independent. These tests pin them apart: the probe's owning line is
present in every leg and only its slug token changes.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import audit_checks

HOME = Path(__file__).resolve().parent.parent

# tools/validate.py: `board_kb = board_path.stat().st_size / 1024` warns above 16.
BOARD_SOFT_CAP_BYTES = 16 * 1024

BOARD_TEMPLATE = """# BOARD

## DOING

## TODO
{filler}
## DONE

## BLOCKED
- [ ] T-001 [P2] pre-existing blocked ticket | verify: nothing | blocker: held
"""


def board_of_size(target: int) -> str:
    """A syntactically ordinary BOARD whose byte length is exactly `target`."""
    line = "- [ ] T-{n:03d} [P3] filler ticket | verify: filler\n"
    filler = ""
    n = 100
    while len(BOARD_TEMPLATE.format(filler=filler)) < target:
        filler += line.format(n=n)
        n += 1
    # The loop stops at the first length >= target; pad the shortfall with a
    # comment line so the board stays parseable and lands on the exact count.
    pad = target - len(BOARD_TEMPLATE.format(filler=filler))
    if pad > 0:
        filler += "<!-- " + "x" * (pad - 9) + " -->\n"
    return BOARD_TEMPLATE.format(filler=filler)


class WarnProbeBoardSize(unittest.TestCase):
    def test_neutral_and_owner_tickets_are_the_same_length(self):
        neutral = audit_checks.warn_probe_ticket(audit_checks.WARN_PROBE_NEUTRAL_SLUG)
        owner = audit_checks.warn_probe_ticket(audit_checks.WARN_PROBE_OWNER_SLUG)
        self.assertEqual(len(neutral), len(owner))
        self.assertNotEqual(neutral, owner)

    def test_owner_slug_appears_only_in_the_owning_line(self):
        neutral = audit_checks.warn_probe_ticket(audit_checks.WARN_PROBE_NEUTRAL_SLUG)
        owner = audit_checks.warn_probe_ticket(audit_checks.WARN_PROBE_OWNER_SLUG)
        self.assertIn(audit_checks.WARN_PROBE_OWNER_SLUG, owner)
        self.assertNotIn(audit_checks.WARN_PROBE_OWNER_SLUG, neutral)

    def test_neutral_slug_is_not_a_tracked_warn_slug(self):
        """The neutral line must own nothing.

        The probe ages `WARN_PROBE_OWNER_SLUG` into the baseline itself, so the
        shipped file does not carry it. What matters is the other direction: no
        slug the validator tracks may be named by the ownership-neutral line,
        or CONTROL and RED would silently own something.
        """
        baseline = json.loads(
            (HOME / "tools" / "release_ledger_baseline.json").read_text(encoding="utf-8")
        )
        tracked = set(baseline.get("warn_slugs") or {})
        self.assertNotIn(audit_checks.WARN_PROBE_NEUTRAL_SLUG, tracked)
        neutral_line = audit_checks.warn_probe_ticket(audit_checks.WARN_PROBE_NEUTRAL_SLUG)
        self.assertEqual([s for s in tracked if s in neutral_line], [])

    def test_every_leg_measures_the_same_board_size_just_under_the_cap(self):
        """The failing case: a board one ticket line short of the soft cap.

        All three legs must land on the same side of the threshold, whatever
        that side is -- otherwise `board-soft-cap` enters the WARN slug set
        between legs and the probe blames ownership for its own board growth.
        """
        line = len(audit_checks.warn_probe_ticket(audit_checks.WARN_PROBE_OWNER_SLUG))
        base = board_of_size(BOARD_SOFT_CAP_BYTES - line // 2)

        # The fixture sits in the dangerous window, which is what makes this a
        # control rather than a restatement: under the OLD probe shape RED read
        # `base` (under the cap, no `board-soft-cap`) and GREEN read
        # `base + line` (over it, slug present), so the set-delta assertion
        # fired on the probe's own growth.
        self.assertLess(len(base), BOARD_SOFT_CAP_BYTES)
        self.assertGreater(len(base) + line, BOARD_SOFT_CAP_BYTES)

        neutral = audit_checks.warn_probe_board(base, audit_checks.WARN_PROBE_NEUTRAL_SLUG)
        self.assertIsNotNone(neutral)
        owned = neutral.replace(
            audit_checks.warn_probe_ticket(audit_checks.WARN_PROBE_NEUTRAL_SLUG),
            audit_checks.warn_probe_ticket(audit_checks.WARN_PROBE_OWNER_SLUG),
        )

        # CONTROL, RED and GREEN all read this board; only ownership differs.
        self.assertEqual(len(neutral), len(owned))
        self.assertEqual(
            len(neutral) > BOARD_SOFT_CAP_BYTES,
            len(owned) > BOARD_SOFT_CAP_BYTES,
        )
        self.assertNotIn(audit_checks.WARN_PROBE_OWNER_SLUG, neutral)
        self.assertIn(audit_checks.WARN_PROBE_OWNER_SLUG, owned)

    def test_owning_line_is_filed_at_the_end_of_blocked(self):
        base = BOARD_TEMPLATE.format(filler="")
        board = audit_checks.warn_probe_board(base, audit_checks.WARN_PROBE_OWNER_SLUG)
        lines = board.splitlines()
        blocked = lines.index("## BLOCKED")
        owning = next(i for i, ln in enumerate(lines) if "T-990" in ln)
        self.assertGreater(owning, blocked)
        following = [i for i in range(blocked + 1, len(lines)) if lines[i].startswith("## ")]
        self.assertTrue(all(owning < i for i in following))

    def test_board_without_blocked_section_is_reported_not_guessed(self):
        self.assertIsNone(
            audit_checks.warn_probe_board(
                "# BOARD\n\n## TODO\n", audit_checks.WARN_PROBE_OWNER_SLUG
            )
        )


if __name__ == "__main__":
    unittest.main()
