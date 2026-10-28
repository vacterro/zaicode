"""T-1460: consumed user ingress is never re-queued as fresh Work.

Measured live on this repository 2026-09-22 at HEAD 481081bd: SRC-082 (defer
the T-1426 FreeBuff gate) and SRC-089 (finish T-1434 M1-M8) were valid
`# User request` receipts whose intent existing Work had already executed,
yet their metadata named no Work at all. With no reservation holding the
seat, `queued_source_projection` routed

    saipen start --receipt SRC-082

and an unattended runner would have projected duplicate Work for a request
the operator gave once. The binding that marks such a receipt consumed is
canonical Work membership (`saipen source link`, T-1437), and the queue must
read that MEMBERSHIP, not only the historical primary `linked_work`.

These controls hold the contract:

  1. a request bound to the Work that executed it leaves the queue;
  2. a membership-only binding (empty primary, `linked_works` set) is consumed
     too -- the queue asks the same predicate every linkage check asks;
  3. a genuinely new request behind a consumed one still queues;
  4. an unbound request is still queued (the queue is not weakened).

Non-request, unreadable and reservation behaviour stay covered by
test_t1458_queue_reservation.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_dependency_resume_liveness import ResumeFixture  # noqa: E402

from saipen_engine import intake  # noqa: E402
from saipen_engine.entry import request_from_receipt  # noqa: E402
from saipen_engine.router import queued_source_projection  # noqa: E402


def _request(text: str) -> str:
    return (
        "# User request\n\n"
        "priority: P1\n"
        "verify: the requested change is present\n\n"
        "## Request\n\n"
        f"{text}\n"
    )


class ConsumedIngressTests(ResumeFixture):
    def _capture(self, project: Path, text: str) -> str:
        captured = intake.capture(project, _request(text), source_kind="user_instruction")
        self.assertTrue(captured.get("ok"), captured)
        return captured["receipt"]

    def test_a_request_bound_to_its_executing_work_leaves_the_queue(self):
        project = self.make_project()
        receipt = self._capture(project, "defer the live gate and continue")
        work = self.add(project, "the Work that already executed the request")
        # The live defect shape: a valid request, unbound, is queued.
        before = queued_source_projection(project)
        self.assertEqual(before and before.get("receipt"), receipt, before)

        linked = intake.link_work_to(project, receipt, work)
        self.assertTrue(linked.get("ok"), linked)
        self.assertIsNone(queued_source_projection(project))
        request, problem, _class = request_from_receipt(project, receipt)
        self.assertIsNone(problem, problem)
        self.assertEqual(request["linked_work"], work)
        # Idempotent: a second bind writes nothing and changes no answer.
        again = intake.link_work_to(project, receipt, work)
        self.assertEqual(again.get("code"), "ALREADY_LINKED", again)
        self.assertIsNone(queued_source_projection(project))

    def test_membership_without_a_primary_is_consumed(self):
        project = self.make_project()
        receipt = self._capture(project, "finish the milestones then resume")
        work = self.add(project, "the Work in the receipt membership")
        meta = intake._read_meta(project, receipt)
        meta["linked_works"] = [work]
        intake._write_meta(project, receipt, meta)
        self.assertIsNone(intake._read_meta(project, receipt).get("linked_work"))
        self.assertEqual(intake.linked_works(intake._read_meta(project, receipt)), {work})
        self.assertIsNone(queued_source_projection(project))

    def test_a_new_request_behind_a_consumed_one_still_queues(self):
        project = self.make_project()
        consumed = self._capture(project, "old request already executed")
        work = self.add(project, "the Work that executed the old request")
        self.assertTrue(intake.link_work_to(project, consumed, work).get("ok"))
        fresh = self._capture(project, "a genuinely new operator request")
        self.assertLess(consumed, fresh)
        projection = queued_source_projection(project)
        self.assertIsNotNone(projection)
        self.assertEqual(projection["action"], f"saipen start --receipt {fresh}")

    def test_an_unbound_request_is_still_queued(self):
        project = self.make_project()
        receipt = self._capture(project, "a request no Work has touched")
        self.add(project, "unrelated Work that must not absorb the request")
        projection = queued_source_projection(project)
        self.assertIsNotNone(projection)
        self.assertEqual(projection.get("receipt"), receipt)


if __name__ == "__main__":
    unittest.main()
