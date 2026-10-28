"""T-1458: the queued-Source stage must never route a start its executor refuses.

Measured live on this repository 2026-09-22 (E-7976, reproduced at E-7995):

    saipen ticket block-for T-1446 T-1457 ...   -> BLOCKED_FOR
    saipen continue --json                       -> saipen start --receipt SRC-065
                                                    reason queued-source
    saipen start --receipt SRC-065 --dry-run     -> VALIDATION_FAILED
        "SRC-065 is not a user request receipt; start it with its own text"

Two owners disagreed. The router queued every unlinked `user_instruction`
receipt, and operator authority capsules (SRC-065, SRC-075) are captured with
that kind; `start --receipt` admits only a `# User request` body. And the
queue branch let only `user_explicit` Work outrank it, so a dependency
reservation -- the parked mission's own continuation edge, which
CONTINUATION_RESERVED protects from every unrelated claim -- lost to it.

An unattended runner executing the routed action spins on that refusal after
every dependency park. These controls hold the repaired contract:

  1. a reserved dependency child outranks the queue;
  2. the queue names only receipts `start --receipt` accepts (one owner);
  3. an unreadable queued receipt is surfaced, never silently skipped.

The ordinary wake-up (no reservation, a real queued request) stays covered by
test_dependency_resume_liveness RED 5.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_dependency_resume_liveness import AGENT, ResumeFixture  # noqa: E402

from saipen_engine import intake  # noqa: E402
from saipen_engine.entry import (  # noqa: E402
    RECEIPT_NOT_A_REQUEST,
    RECEIPT_UNREADABLE,
    request_from_receipt,
)
from saipen_engine.operations import apply_claim, ticket_move  # noqa: E402
from saipen_engine.router import queued_source_projection, route_next  # noqa: E402

#: The shape of SRC-065 / SRC-075: an operator authority capsule, captured as
#: `user_instruction`, whose whole body is the grant.
CAPSULE = (
    "This message supplies operator authority for Work supersession:\n\n"
    "    T-1 - T-2\n\n"
    "only.\n"
)
REQUEST = (
    "# User request\n\n"
    "priority: P1\n"
    "verify: the queued request is executed\n\n"
    "## Request\n\n"
    "queued operator request while the seat was busy\n"
)
QUEUED = {
    "action": "saipen start --receipt SRC-005",
    "receipt": "SRC-005",
    "detail": "queued",
}


class ReservationOutranksQueueTests(ResumeFixture):
    def _parked(self, project: Path) -> tuple[str, str]:
        parent = self.add(project, "live mission parked on its child")
        child = self.add(project, "the child the mission waits for", priority="P2")
        self.add(project, "ordinary backlog item", priority="P0")
        self.assertTrue(apply_claim(project, parent, AGENT, explicit=True).ok)
        parked = ticket_move(
            project,
            "block-for",
            parent,
            AGENT,
            "the child is required before the parent can continue",
            blocked_on=child,
        )
        self.assertTrue(parked.ok, parked.to_dict())
        return parent, child

    def _route(self, project: Path, queued: dict | None) -> dict:
        return route_next(
            (project / ".saipen" / "STATE.md").read_text(encoding="utf-8"),
            (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"),
            current_agent=AGENT,
            queued_source=queued,
        )

    def test_a_reserved_child_outranks_a_queued_source(self):
        project = self.make_project()
        _parent, child = self._parked(project)
        routed = self._route(project, QUEUED)
        self.assertTrue(routed["ok"], routed)
        self.assertNotEqual(routed["reason"], "queued-source", routed)
        self.assertEqual(routed["reason"], "dependency-continuation", routed)
        self.assertEqual(routed.get("ticket"), child, routed)
        self.assertNotIn("--receipt", routed["action"])

    def test_the_reservation_route_equals_the_route_without_a_queue(self):
        # The queue must be invisible while the reservation stands: same
        # route with and without it, so nothing about the queue leaks in.
        project = self.make_project()
        self._parked(project)
        with_queue = self._route(project, QUEUED)
        without = self._route(project, None)
        for key in ("action", "reason", "ticket"):
            self.assertEqual(with_queue.get(key), without.get(key), (with_queue, without))


class QueueAdmissibilityTests(ResumeFixture):
    def _capture(self, project: Path, body: str) -> str:
        captured = intake.capture(project, body, source_kind="user_instruction")
        self.assertTrue(captured.get("ok"), captured)
        return captured["receipt"]

    def test_an_authority_capsule_is_never_queued(self):
        project = self.make_project()
        capsule = self._capture(project, CAPSULE)
        _request, problem, problem_class = request_from_receipt(project, capsule)
        self.assertIsNotNone(problem)
        self.assertEqual(problem_class, RECEIPT_NOT_A_REQUEST)
        self.assertIsNone(queued_source_projection(project))

    def test_the_queue_names_only_what_start_accepts(self):
        project = self.make_project()
        capsule = self._capture(project, CAPSULE)  # older: sorts first
        request = self._capture(project, REQUEST)
        self.assertLess(capsule, request)
        projection = queued_source_projection(project)
        self.assertIsNotNone(projection)
        self.assertEqual(projection["action"], f"saipen start --receipt {request}")
        # One owner: whatever the queue names, start --receipt accepts.
        accepted, problem, _class = request_from_receipt(project, projection["receipt"])
        self.assertIsNone(problem, problem)
        self.assertIsNotNone(accepted)

    def test_an_unreadable_queued_receipt_is_surfaced_not_skipped(self):
        project = self.make_project()
        request = self._capture(project, REQUEST)
        body = project / ".saipen" / "intake" / "active" / f"{request}.md"
        body.write_bytes(body.read_bytes() + b"tampered\n")
        _request, _problem, problem_class = request_from_receipt(project, request)
        self.assertEqual(problem_class, RECEIPT_UNREADABLE)
        projection = queued_source_projection(project)
        self.assertIsNotNone(projection, "an unreadable queue entry must not vanish")
        self.assertTrue(projection.get("invalid"), projection)
        self.assertIn(request, projection["detail"])


if __name__ == "__main__":
    unittest.main()
