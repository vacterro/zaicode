"""User-wait seat release: AWAITING_USER_LIVE_ACCEPTANCE parks the active Work
truthfully (T-1437, SRC-093).

The T-168 shape: the active ticket waits for a LIVE human acceptance. The
canonical route is the existing DOING-to-BLOCKED operation, and the contract
these controls hold is:

  1. blocking the active user-wait FREES THE SEAT -- STATE goes DONE/task none,
     no ticket remains under ## DOING;
  2. the EXACT human action is retained on the blocked record and in its LOG
     event, so the next reader needs no reconstruction;
  3. RESUME OWNERSHIP stays truthful -- only the human decision lifts the
     block, the unblock writes NO new claim (the historical claim fields are
     byte-identical, never refreshed or rebound), and the resumed TODO can be
     claimed by the next session through the ordinary claim path.

Run standalone:
    python tools/test_user_wait_release.py
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import test_dependency_resume_liveness as liveness  # noqa: E402
from saipen_engine.board import ticket_is_workable  # noqa: E402
from saipen_engine.operations import apply_claim, ticket_move, transition_phase  # noqa: E402

AGENT = liveness.AGENT
OTHER = liveness.OTHER
WAIT_ACTION = (
    "AWAITING_USER_LIVE_ACCEPTANCE: operator runs the disposable-project "
    "check and reports cc GREEN or cc FAIL before this Work resumes"
)


class UserWaitReleaseTests(liveness.ResumeFixture):
    def active_waiting_ticket(self, project: Path) -> str:
        ticket = self.add(project, "waiting on a live human acceptance")
        claimed = apply_claim(project, ticket, AGENT, explicit=True)
        self.assertTrue(claimed.ok, claimed.to_dict())
        moved = transition_phase(project, "BUILD", AGENT, ticket, "BUILD: waiting shape")
        self.assertTrue(moved.ok, moved.to_dict())
        return ticket

    def block_for_user(self, project: Path, ticket: str):
        blocked = ticket_move(project, "block", ticket, AGENT, WAIT_ACTION)
        self.assertTrue(blocked.ok, blocked.to_dict())
        return blocked

    def test_active_user_wait_block_frees_the_seat_and_keeps_the_exact_action(self) -> None:
        project = self.make_project()
        ticket = self.active_waiting_ticket(project)
        before = dict(self.tickets(project)[ticket]["fields"])
        self.block_for_user(project, ticket)

        record = self.tickets(project)[ticket]
        self.assertEqual(record["section"], "## BLOCKED")
        self.assertEqual(record["fields"].get("blocker"), WAIT_ACTION)
        self.assertEqual(record["fields"].get("blocker_scope"), "ticket")
        self.assertNotIn("resume_phase", record["fields"], record["fields"])
        # The claim fields are historical, untouched by the block: no refresh,
        # no rebind, no synthesized resume ownership.
        for field in ("owner", "claim_time", "claim_session"):
            self.assertEqual(record["fields"].get(field), before.get(field), field)

        state = self.state(project)
        self.assertEqual(state.get("phase"), "DONE")
        self.assertEqual(state.get("task"), "none")
        self.assertEqual(state.get("transition_from"), "BUILD")
        doing = [
            item
            for item in self.tickets(project).values()
            if item.get("section") == "## DOING"
        ]
        self.assertEqual(doing, [])

        log = self.log_text(project)
        block_lines = [
            line
            for line in log.splitlines()
            if "ticket block" in line and f"[{ticket}]" in line
        ]
        self.assertTrue(block_lines, log)
        self.assertTrue(any("(active)" in line for line in block_lines), block_lines)
        self.assertTrue(any(WAIT_ACTION in line for line in block_lines), block_lines)

    def test_unblock_requires_the_decision_and_writes_no_new_claim(self) -> None:
        project = self.make_project()
        ticket = self.active_waiting_ticket(project)
        self.block_for_user(project, ticket)
        blocked_fields = dict(self.tickets(project)[ticket]["fields"])

        refused = ticket_move(project, "unblock", ticket, AGENT, "")
        self.assertFalse(refused.ok)
        self.assertEqual(refused.code, "VALIDATION_FAILED")

        lifted = ticket_move(project, "unblock", ticket, AGENT, "operator reported cc GREEN")
        self.assertTrue(lifted.ok, lifted.to_dict())
        record = self.tickets(project)[ticket]
        self.assertEqual(record["section"], "## TODO")
        self.assertNotIn("blocker", record["fields"])
        self.assertNotIn("blocker_scope", record["fields"])
        self.assertNotIn("resume_phase", record["fields"])
        for field in ("owner", "claim_time", "claim_session"):
            self.assertEqual(record["fields"].get(field), blocked_fields.get(field), field)

        tickets = self.tickets(project)
        self.assertTrue(ticket_is_workable(record, tickets, AGENT))
        adopted = apply_claim(project, ticket, OTHER, explicit=True)
        self.assertTrue(adopted.ok, adopted.to_dict())
        self.assertEqual(self.tickets(project)[ticket]["fields"]["owner"], OTHER)

    def test_control_the_unblock_decision_is_what_lifts_the_block(self) -> None:
        """The empty-payload refusal is input-driven, not vacuous: the SAME
        call with the human decision succeeds."""
        project = self.make_project()
        ticket = self.active_waiting_ticket(project)
        self.block_for_user(project, ticket)
        empty = ticket_move(project, "unblock", ticket, AGENT, "")
        decided = ticket_move(project, "unblock", ticket, AGENT, "operator reported cc GREEN")
        self.assertFalse(empty.ok)
        self.assertTrue(decided.ok, decided.to_dict())

    def test_control_a_resume_that_refreshed_the_claim_would_change_the_record(self) -> None:
        """The no-synthetic-claim assertion has teeth: a resume transaction
        that wrote a fresh claim pair (the pre-T-1436 shape) changes the record
        exactly where the test above demands equality."""
        project = self.make_project()
        ticket = self.active_waiting_ticket(project)
        self.block_for_user(project, ticket)
        lifted = ticket_move(project, "unblock", ticket, AGENT, "operator reported cc GREEN")
        self.assertTrue(lifted.ok, lifted.to_dict())
        historical = dict(self.tickets(project)[ticket]["fields"])

        distinct = "2000-01-01T00:00:00Z"
        board_path = project / ".saipen" / "BOARD.md"
        lines = board_path.read_text(encoding="utf-8").splitlines(keepends=True)
        for index, line in enumerate(lines):
            if line.startswith("- [ ] " + ticket + " "):
                refreshed = re.sub(r"claim_time: \S+", f"claim_time: {distinct}", line)
                lines[index] = refreshed
                break
        board_path.write_text("".join(lines), encoding="utf-8")
        mutated = dict(self.tickets(project)[ticket]["fields"])
        self.assertNotEqual(mutated.get("claim_time"), historical.get("claim_time"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
