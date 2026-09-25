"""Scenario-sandbox work-surface neutralization (T-1240).

`run_scenarios` rebuilds fixtures from the live project and cuts LOG history,
so it empties BOARD `## DONE` / `## DOING`. That edit used to stop at the
board: an ACTIVE source receipt linked to a ticket the probe had just deleted
made the copied project fail its own core gate with `references missing Work`.
The probe manufactured the defect and then reported it against the live
repository -- a red that no repair to the repository could clear.

The fix has to keep the check able to fail. Both halves are asserted here:
Work the probe removed is unlinked, Work that never existed stays dangling.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

sys.argv = [sys.argv[0]]
from run_scenarios import neutralize_sandbox_work_surface  # noqa: E402

BOARD = """# Board
## DOING
- [/] T-900 [P1] live work | owner: probe | claim_time: 2026-08-31T00:00:00Z
## TODO
- [ ] T-901 [P2] queued work
## DONE
- [x] T-800 [P1] closed work | source_receipts: SRC-001
## BLOCKED
"""


class WorkSurface(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-sandbox-surface-")
        self.saipen = Path(self.tmp.name) / ".saipen"
        (self.saipen / "intake" / "active").mkdir(parents=True)
        (self.saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _receipt(self, receipt_id: str, work: str | None) -> None:
        (self.saipen / "intake" / "active" / f"{receipt_id}.meta.json").write_text(
            json.dumps({"receipt_id": receipt_id, "linked_work": work, "status": "ACTIVE"}),
            encoding="utf-8",
        )
        index_path = self.saipen / "intake" / "index.json"
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except OSError:
            index = {"active": {}, "next_id": 1, "tombstones": {}}
        index["active"][receipt_id] = {"receipt_id": receipt_id, "linked_work": work}
        index_path.write_text(json.dumps(index), encoding="utf-8")

    def _meta(self, receipt_id: str) -> dict:
        return json.loads(
            (self.saipen / "intake" / "active" / f"{receipt_id}.meta.json").read_text("utf-8")
        )

    def _index(self) -> dict:
        return json.loads((self.saipen / "intake" / "index.json").read_text("utf-8"))

    def test_done_and_doing_are_emptied_and_todo_survives_verbatim(self) -> None:
        dropped = neutralize_sandbox_work_surface(self.saipen)
        board = (self.saipen / "BOARD.md").read_text(encoding="utf-8")
        self.assertEqual(dropped, {"T-900", "T-800"})
        self.assertNotIn("T-900", board)
        self.assertNotIn("T-800", board)
        self.assertIn("- [ ] T-901 [P2] queued work", board)
        for heading in ("## DOING", "## TODO", "## DONE", "## BLOCKED"):
            self.assertIn(heading, board)

    def test_a_receipt_linked_to_removed_work_is_unlinked(self) -> None:
        self._receipt("SRC-001", "T-800")
        neutralize_sandbox_work_surface(self.saipen)
        self.assertIsNone(self._meta("SRC-001")["linked_work"])
        self.assertIsNone(self._index()["active"]["SRC-001"]["linked_work"])

    def test_a_receipt_naming_work_that_never_existed_stays_dangling(self) -> None:
        self._receipt("SRC-002", "T-404")
        neutralize_sandbox_work_surface(self.saipen)
        self.assertEqual(self._meta("SRC-002")["linked_work"], "T-404")
        self.assertEqual(self._index()["active"]["SRC-002"]["linked_work"], "T-404")

    def test_a_receipt_linked_to_surviving_work_is_untouched(self) -> None:
        self._receipt("SRC-003", "T-901")
        neutralize_sandbox_work_surface(self.saipen)
        self.assertEqual(self._meta("SRC-003")["linked_work"], "T-901")

    def test_an_unlinked_receipt_is_left_alone(self) -> None:
        self._receipt("SRC-004", None)
        neutralize_sandbox_work_surface(self.saipen)
        self.assertIsNone(self._meta("SRC-004")["linked_work"])

    def test_a_board_with_nothing_to_drop_touches_no_intake(self) -> None:
        (self.saipen / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        self._receipt("SRC-005", "T-800")
        self.assertEqual(neutralize_sandbox_work_surface(self.saipen), set())
        self.assertEqual(self._meta("SRC-005")["linked_work"], "T-800")

    def test_a_corrupt_receipt_or_index_never_raises(self) -> None:
        self._receipt("SRC-006", "T-800")
        (self.saipen / "intake" / "active" / "SRC-007.meta.json").write_text(
            "{not json", encoding="utf-8"
        )
        (self.saipen / "intake" / "index.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(neutralize_sandbox_work_surface(self.saipen), {"T-900", "T-800"})
        self.assertIsNone(self._meta("SRC-006")["linked_work"])


if __name__ == "__main__":
    unittest.main()
