"""T-1478: a fixture reads the clock when it is BUILT, never at import.

Seven baseline ids (test_foreign_owner_terminal_route x4, test_guard_hostile_
matrix ActorBinding.test_27 / OpenCodeDelegation.test_task_keeps_actor_
ownership_and_host_identity_checks / OwnershipControls.test_06) were FAIL in one
family run and PASS in the next with no code change. The ticket suspected the
live `.saipen` the sandbox copies. Measured 2026-09-23, the cause is time: both
fixture modules stamped their "live" claims from a module-level
`datetime.now()`, read at DISCOVERY, and the sequential family reaches those
modules tens of minutes later -- past `board.CLAIM_LIVENESS_WINDOW` (15 min), so
the claim was already stale and the verdict followed the machine's speed.
Aging the import clock by 16 minutes turned all seven red; at 0 all seven were
green; with fixtures stamped at build time there is nothing left to age.

This tripwire keeps the class out: no test module binds a wall-clock reading
to a module-level name.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

#: A module-level (column 0) name bound to a wall-clock reading.
_IMPORT_CLOCK = re.compile(
    r"^[A-Za-z_]\w*\s*(?::[^=\n]+)?=\s*[^\n#]*\b(?:datetime\.now|datetime\.utcnow|"
    r"datetime\.datetime\.now|datetime\.datetime\.utcnow)\(",
    re.MULTILINE,
)


class ImportClockTests(unittest.TestCase):
    def test_the_pattern_sees_the_measured_shapes(self):
        """Guard: a pattern that matches nothing would pass this file silently."""
        for line in (
            "CLAIM_NOW = datetime.now(timezone.utc)",
            "_NOW = datetime.now(timezone.utc)",
            "NOW: datetime = datetime.datetime.now(datetime.timezone.utc)",
        ):
            with self.subTest(line=line):
                self.assertRegex(line, _IMPORT_CLOCK)
        for line in (
            "    now = datetime.now(timezone.utc)",
            "def _stamp():\n    return datetime.now(timezone.utc)",
        ):
            with self.subTest(line=line):
                self.assertNotRegex(line, _IMPORT_CLOCK)

    def test_no_test_module_reads_the_clock_at_import(self):
        found = []
        for path in sorted(TOOLS.glob("test_*.py")):
            text = path.read_text(encoding="utf-8")
            for match in _IMPORT_CLOCK.finditer(text):
                line = text.count("\n", 0, match.start()) + 1
                found.append(f"{path.name}:{line}: {match.group(0).strip()}")
        self.assertEqual(
            found,
            [],
            "a module-level clock is discovery time; a fixture stamped from it "
            "ages while the family runs (T-1478)",
        )

    def test_the_fixtures_stamp_a_live_claim_now(self):
        from saipen_engine import codec
        from saipen_engine.board import claim_status, parse_board
        from test_guard_hostile_matrix import project_with_doing_owner

        root = project_with_doing_owner("astra2")
        board = parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))
        self.assertEqual(claim_status(board["tickets"]["T-9001"], "test-agent"), "FOREIGN_LIVE")


if __name__ == "__main__":
    unittest.main()
