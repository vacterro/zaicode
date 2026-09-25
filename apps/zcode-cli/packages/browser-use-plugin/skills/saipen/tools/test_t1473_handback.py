"""Handback: Work parked on the ACTIVE ticket gets the seat back (T-1473).

Measured on 2026-09-22 (E-8289..E-8291): `saipen start` parked T-1344 at
VERIFY behind the new request T-1471. T-1471's SCOUT found that its first
bounded Work IS T-1344, and no operation could return the seat: `unblock`
failed validation (continuation reservation under TODO), `block-for` refused
a blocker that is not workable TODO, and `claim --explicit` refused a ticket
that carries a blocker. A request to continue Work deadlocked that Work.

These controls hold the contract of `ticket unblock` on parked Work:

  RED 1  the holder is this seat's active ticket -> ONE transaction restores
         the parked Work to DOING at its saved phase tuple and returns the
         holder to the top of TODO unclaimed;
  RED 2  the holder is not the active ticket -> refusal, zero writes;
  RED 3  the reservation belongs to another seat -> refusal, zero writes;
  RED 4  the parked Work still has an unmet dependency -> refusal, zero writes.

Run standalone:
    python tools/test_t1473_handback.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_dependency_resume_liveness import AGENT, OTHER, ResumeFixture  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from saipen_engine.fast_check import validate_texts  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    checkpoint,
    ticket_move,
    transition_phase,
)


def setUpModule() -> None:
    # An outer host session must never bind these disposable fixtures.
    isolate_host_session()


class HandbackFixture(ResumeFixture):
    def files(self, project: Path) -> dict[str, bytes]:
        return {
            name: (project / ".saipen" / name).read_bytes()
            for name in ("STATE.md", "BOARD.md", "LOG.md")
        }

    def paused(self, project: Path, owner: str = AGENT) -> tuple[str, str]:
        """Parked Work at VERIFY behind a new request, as `saipen start` leaves it."""
        parked = self.add(project, "the gate the new request asks to continue")
        request = self.add(project, "a new request whose first Work is the parked one")
        self.assertTrue(apply_claim(project, parked, owner, explicit=True).ok)
        for destination in ("BUILD", "VERIFY"):
            moved = transition_phase(project, destination, owner, parked, destination)
            self.assertTrue(moved.ok, moved.to_dict())
        paused = ticket_move(
            project,
            "block-for",
            parked,
            owner,
            f"PAUSED by user request: explicit new task {request} takes the seat",
            blocked_on=request,
        )
        self.assertTrue(paused.ok, paused.to_dict())
        return parked, request


class HandbackTests(HandbackFixture):
    def test_red1_handback_restores_parked_work_and_demotes_the_holder(self) -> None:
        project = self.make_project()
        parked, request = self.paused(project)
        self.assertTrue(apply_claim(project, request, AGENT).ok)

        result = ticket_move(
            project, "unblock", parked, AGENT, f"{request} SCOUT: its first Work is {parked}"
        )
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "HANDBACK")
        self.assertEqual(result.data["holder"], request)

        tickets = self.tickets(project)
        restored = tickets[parked]
        self.assertEqual(restored["section"], "## DOING")
        self.assertEqual(restored["fields"].get("owner"), AGENT)
        for field in ("blocker", "blocker_scope", "blocked_on", "resume_phase",
                      "resume_transition_from"):
            self.assertNotIn(field, restored["fields"], restored["fields"])
        self.assertNotIn(request, restored.get("needs", []))

        holder = tickets[request]
        self.assertEqual(holder["section"], "## TODO")
        for field in ("owner", "claim_time", "claim_session"):
            self.assertNotIn(field, holder["fields"], holder["fields"])
        todo = [tid for tid, t in tickets.items() if t["section"] == "## TODO"]
        board_text = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        first_todo = board_text.split("## TODO", 1)[1].strip().splitlines()[0]
        self.assertIn(request, todo)
        self.assertTrue(first_todo.startswith(f"- [ ] {request} "), first_todo)

        state = self.state(project)
        self.assertEqual(state["phase"], "VERIFY")
        self.assertEqual(state["task"], parked)
        self.assertEqual(state["transition_from"], "BUILD")
        self.assertEqual(state["next_action"], f"PHASE VERIFY {parked}")

        log = self.log_text(project).splitlines()
        self.assertIn(f"[{request}]", log[-2])
        self.assertIn("handback", log[-2])
        self.assertIn(f"[{parked}]", log[-1])
        self.assertIn(f"ticket unblock via SAIOPS (handback from {request})", log[-1])

        files = self.files(project)
        errors = validate_texts(
            files["STATE.md"].decode("utf-8"),
            files["BOARD.md"].decode("utf-8"),
            files["LOG.md"].decode("utf-8"),
            current_agent=AGENT,
        )
        self.assertEqual(errors, [])

        # The restored Work continues its own VERIFY cycle on the ordinary
        # lifecycle: evidence written now counts, and REVIEW opens.
        evidence = checkpoint(
            project,
            AGENT,
            "RUN",
            parked,
            f"verify -> PASS [target: {parked}] conf: high -- focused suite green",
        )
        self.assertTrue(evidence.ok, evidence.to_dict())
        moved = transition_phase(project, "REVIEW", AGENT, parked, "REVIEW")
        self.assertTrue(moved.ok, moved.to_dict())

    def test_red2_holder_that_is_not_the_active_ticket_refuses_zero_writes(self) -> None:
        project = self.make_project()
        parked, _request = self.paused(project)
        before = self.files(project)

        result = ticket_move(project, "unblock", parked, AGENT, "hand it back")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "CONTINUATION_RESERVED", result.to_dict())
        self.assertEqual(self.files(project), before)

    def test_red3_foreign_reservation_refuses_zero_writes(self) -> None:
        project = self.make_project()
        parked, request = self.paused(project, owner=OTHER)
        self.assertTrue(apply_claim(project, request, AGENT).ok)
        before = self.files(project)

        result = ticket_move(project, "unblock", parked, AGENT, "hand it back")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "TICKET_NOT_WORKABLE", result.to_dict())
        self.assertIn(f"reserved for seat {OTHER}", result.message)
        self.assertEqual(self.files(project), before)

    def test_red4_unmet_dependency_of_the_parked_work_refuses_zero_writes(self) -> None:
        project = self.make_project()
        parked, request = self.paused(project)
        other = self.add(project, "a dependency the parked Work still needs")
        self.assertTrue(apply_claim(project, request, AGENT).ok)
        board_path = project / ".saipen" / "BOARD.md"
        board = board_path.read_text(encoding="utf-8")
        board_path.write_text(
            board.replace(f"needs: {request}", f"needs: {request},{other}", 1),
            encoding="utf-8",
        )
        self.assertIn(other, self.tickets(project)[parked]["needs"])
        before = self.files(project)

        result = ticket_move(project, "unblock", parked, AGENT, "hand it back")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "TICKET_NOT_WORKABLE", result.to_dict())
        self.assertIn(other, result.message)
        self.assertEqual(self.files(project), before)


if __name__ == "__main__":
    unittest.main()
