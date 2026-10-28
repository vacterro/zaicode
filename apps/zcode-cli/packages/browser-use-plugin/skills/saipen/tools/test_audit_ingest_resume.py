"""W2-004 regression tests: audit ingestion is resumable, not a crash wedge.

Ingestion is three durable writes -- BOARD Work, the Source link, the inbox
binding -- with no shared transaction marker. A process death between the first
two left real Work the receipt could not reach, and the selection at the top of
`_audit` only ever looked for a NEW layer. So the retry returned status-only
success while `projection()` kept prescribing `saipen audit ingest`: the router
told the agent to run a command whose implementation refused to consume the
state it was being prescribed for.

That is worse than an ordinary bug because `SOURCE-AUDIT-INBOX-01` REQUIRES an
agent to follow that route. The prescribed action never advanced the state, so
a conforming agent loops forever.

Proven here:
- the ACTIVE/no-Work state is selected and consumed, not skipped;
- the retry ADOPTS the already-committed ticket through a machine-owned
  `source_receipt=` field and never manufactures a second one;
- after the retry the receipt is linked and the projection routes onward;
- repeating the command is idempotent;
- a clean first ingest is unchanged.

Run standalone:
    python tools/test_audit_ingest_resume.py
"""

from __future__ import annotations

import contextlib
import io
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import saipen as CLI  # noqa: E402
from saipen_engine import audit_inbox as AI  # noqa: E402
from saipen_engine import operations as OPS  # noqa: E402
from saipen_engine import state as S  # noqa: E402

REPO = TOOLS.parent
FIXTURE = REPO / "tests/scenarios/done-wait-deadlock-goal-mode/.saipen"


class IngestResumeTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "proj"
        shutil.copytree(FIXTURE, self.root / ".saipen")
        (self.root / "audit").mkdir(parents=True)
        (self.root / "audit" / "1.md").write_text("# AUDIT\n\nfindings\n", encoding="utf-8")
        state_path = self.root / ".saipen" / "STATE.md"
        state_path.write_text(
            S.patch_state(
                state_path.read_text(encoding="utf-8"), {"saipen_home": str(REPO)}
            ),
            encoding="utf-8",
        )

    # helpers -------------------------------------------------------------

    def ingest(self) -> int:
        with contextlib.redirect_stdout(io.StringIO()):
            return CLI.main(
                ["audit", "ingest", "--project-root", str(self.root), "--json"]
            )

    def crash_after_ticket_commit(self) -> None:
        """Let `ticket_add` commit, then die before the Source link."""
        real = OPS.ticket_add

        def boom(*args, **kwargs):
            real(*args, **kwargs)
            raise RuntimeError("SIMULATED_CRASH_AFTER_TICKET_ADD")

        OPS.ticket_add = boom
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                CLI.main(["audit", "ingest", "--project-root", str(self.root), "--json"])
        except RuntimeError:
            pass
        finally:
            OPS.ticket_add = real

    def tickets(self) -> list[str]:
        """The ticket IDs created for an audit layer.

        IDs, not raw lines: the retry legitimately APPENDS the canonical
        `source_receipts:` field to the same ticket, and comparing lines would
        read that append as a new ticket.
        """
        board = (self.root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        return re.findall(r"^- \[.\] (T-\d+).*audit inbox layer", board, re.MULTILINE)

    def layer(self) -> dict:
        layers = AI.classify(self.root)["layers"]
        self.assertEqual(len(layers), 1, layers)
        return layers[0]

    def action(self):
        return (AI.projection(self.root) or {}).get("action")

    # the wedge -----------------------------------------------------------

    def test_the_crash_leaves_the_state_the_defect_describes(self):
        """Precondition control: without it the rest proves nothing."""
        self.crash_after_ticket_commit()
        self.assertEqual(len(self.tickets()), 1)
        self.assertEqual(self.layer()["state"], AI.ACTIVE)
        self.assertIsNone(self.layer().get("linked_work"))
        self.assertEqual(self.action(), "saipen audit ingest")

    def test_the_retry_consumes_the_state_the_router_prescribes_it_for(self):
        self.crash_after_ticket_commit()
        self.ingest()
        self.assertIsNotNone(self.layer().get("linked_work"))
        self.assertNotEqual(
            self.action(),
            "saipen audit ingest",
            "the router still prescribes an action that changes nothing",
        )
        self.assertTrue(str(self.action()).startswith("PHASE SCOUT "))

    def test_the_retry_adopts_the_committed_ticket_and_makes_no_second_one(self):
        self.crash_after_ticket_commit()
        created = self.tickets()
        self.ingest()
        self.assertEqual(self.tickets(), created, "a second ticket was manufactured")

    def test_the_adopted_ticket_is_the_one_carrying_the_receipt_field(self):
        """Machine-owned linkage, not a title-text guess."""
        self.crash_after_ticket_commit()
        receipt = self.layer()["receipt_id"]
        self.ingest()
        work = self.layer()["linked_work"]
        board = (self.root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        line = next(line for line in board.splitlines() if f" {work} " in line)
        self.assertIn(f"source_receipt={receipt}", line)
        self.assertIn("source_receipts:", line, "the canonical field is written too")

    def test_a_ticket_that_only_mentions_the_receipt_in_prose_is_not_adopted(self):
        """The lookup is a field/token match; prose must never acquire linkage.

        Both scanned surfaces carry prose here -- the description AND the
        verify clause -- and the receipt id appears in each of them as ordinary
        words. Only `source_receipt=<id>` or the canonical `source_receipts:`
        field may adopt, so this board must yield nothing.
        """
        from saipen import _work_for_source_receipt

        board_path = self.root / ".saipen" / "BOARD.md"
        board_path.write_text(
            board_path.read_text(encoding="utf-8").replace(
                "## TODO",
                "## TODO\n"
                "- [ ] T-900 [P2] mentions SRC-001 in passing "
                "| verify: something about SRC-001 that is not a linkage",
                1,
            ),
            encoding="utf-8",
        )
        self.assertIsNone(_work_for_source_receipt(self.root, "SRC-001"))

    def test_the_structured_token_in_the_description_alone_adopts(self):
        """The pre-linkage marker has to work on its own.

        It is the ONLY record that commits atomically with the ticket, so if
        the description half of the lookup were dead the resume path would
        silently fall back to creating a second ticket.
        """
        from saipen import _work_for_source_receipt

        board_path = self.root / ".saipen" / "BOARD.md"
        board_path.write_text(
            board_path.read_text(encoding="utf-8").replace(
                "## TODO",
                "## TODO\n"
                "- [ ] T-901 [P2] Execute external audit inbox layer audit/9.md "
                "(SRC-009); source_receipt=SRC-009 | verify: nothing",
                1,
            ),
            encoding="utf-8",
        )
        self.assertEqual(_work_for_source_receipt(self.root, "SRC-009"), "T-901")

    def test_repeating_the_command_is_idempotent(self):
        self.crash_after_ticket_commit()
        self.ingest()
        first = (self.tickets(), self.layer()["linked_work"], self.action())
        self.ingest()
        self.assertEqual(
            (self.tickets(), self.layer()["linked_work"], self.action()), first
        )

    def test_a_clean_first_ingest_is_unchanged(self):
        """Positive control: the resume path did not disturb the normal one."""
        self.ingest()
        self.assertEqual(len(self.tickets()), 1)
        self.assertIsNotNone(self.layer().get("linked_work"))
        self.assertTrue(str(self.action()).startswith("PHASE SCOUT "))
        before = (self.tickets(), self.layer()["linked_work"])
        self.ingest()
        self.assertEqual((self.tickets(), self.layer()["linked_work"]), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
