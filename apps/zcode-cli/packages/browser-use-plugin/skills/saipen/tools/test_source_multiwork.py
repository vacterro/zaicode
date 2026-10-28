"""One source receipt may serve several Work items (T-1437, SAITULS SRC-015).

Measured on SAITULS: SRC-015 is a real multi-requirement mission whose BOARD
children (T-143/T-162/T-163/T-164/T-165) each declare `source_receipts:
SRC-015`, while the receipt metadata named only the primary T-143 -- so
`work_closure_gate` answered SOURCE_LINKAGE_DRIFT for every legitimate child
and no re-link CLI existed.

These controls hold the fixed model:

  single-work compatibility   old receipts keep their exact metadata shape
  multi-work membership       `linked_work` stays primary; `linked_works`
                              carries the rest; every member passes the gate
  no drift false positive     a declared child that is a canonical member is
                              never SOURCE_LINKAGE_DRIFT
  real drift still refused    a ticket that claims the receipt WITHOUT
                              canonical membership is SOURCE_LINKAGE_DRIFT
  idempotence                 a repeated link is ALREADY_LINKED, zero writes
  closure membership          close refuses while ANY live member is not DONE

Run standalone:
    python tools/test_source_multiwork.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import intake  # noqa: E402
from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.result import Result  # noqa: E402
from test_dependency_resume_liveness import ResumeFixture  # noqa: E402

BODY = (
    "# User request\n\n"
    "priority: P1\n"
    "verify: the multi-work membership is canonical\n\n"
    "## Request\n\n"
    "one mission with several independent work items\n"
)


class MultiWorkLinkageTests(ResumeFixture):
    def capture(self, project: Path, work: str) -> str:
        captured = intake.capture(
            project, BODY, source_kind="user_instruction", work=work
        )
        self.assertTrue(captured.get("ok"), captured)
        self.assertEqual(captured.get("linked_work"), work, captured)
        return captured["receipt"]

    def meta(self, project: Path, receipt: str) -> dict:
        return intake._read_meta(project, receipt) or {}

    def gate(self, project: Path, work: str) -> dict:
        return intake.work_closure_gate(project, work)

    def test_single_work_receipt_is_unchanged(self) -> None:
        project = self.make_project()
        a = self.add(project, "work A")
        receipt = self.capture(project, a)
        record = self.meta(project, receipt)
        self.assertEqual(record.get("linked_work"), a)
        self.assertNotIn("linked_works", record)
        self.assertEqual(intake.linked_works(record), {a})
        self.assertNotEqual(self.gate(project, a).get("code"), "SOURCE_LINKAGE_DRIFT")

    def test_multi_work_membership_preserves_primary_and_gate(self) -> None:
        project = self.make_project()
        a = self.add(project, "work A")
        b = self.add(project, "work B")
        c = self.add(project, "work C")
        receipt = self.capture(project, a)

        linked_b = intake.link_work_to(project, receipt, b)
        self.assertTrue(linked_b.get("ok"), linked_b)
        self.assertEqual(linked_b.get("code"), "SOURCE_LINKED")
        linked_c = intake.link_work_to(project, receipt, c)
        self.assertTrue(linked_c.get("ok"), linked_c)

        record = self.meta(project, receipt)
        self.assertEqual(record.get("linked_work"), a, "primary must not move")
        self.assertEqual(intake.linked_works(record), {a, b, c})
        for member in (a, b, c):
            self.assertNotEqual(
                self.gate(project, member).get("code"),
                "SOURCE_LINKAGE_DRIFT",
                member,
            )
        rows = parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        for member in (b, c):
            self.assertIn(receipt, rows["tickets"][member]["fields"]["source_receipts"])
        members = [item["receipt"] for item in intake.active_receipts(project, work=b)]
        self.assertIn(receipt, members)

    def test_repeated_link_is_idempotent(self) -> None:
        project = self.make_project()
        a = self.add(project, "work A")
        b = self.add(project, "work B")
        receipt = self.capture(project, a)
        self.assertTrue(intake.link_work_to(project, receipt, b).get("ok"))
        blob = (project / ".saipen" / "intake" / "active" / f"{receipt}.meta.json").read_bytes()
        repeat = intake.link_work_to(project, receipt, b)
        self.assertEqual(repeat.get("code"), "ALREADY_LINKED", repeat)
        self.assertEqual(
            blob,
            (project / ".saipen" / "intake" / "active" / f"{receipt}.meta.json").read_bytes(),
        )

    def test_declared_nonmember_still_drifts_structurally(self) -> None:
        project = self.make_project()
        a = self.add(project, "work A")
        fake = self.add(project, "unrelated work D")
        receipt = self.capture(project, a)
        board_path = project / ".saipen" / "BOARD.md"
        lines = board_path.read_text(encoding="utf-8").splitlines(keepends=True)
        for index, line in enumerate(lines):
            if line.startswith("- [ ] " + fake + " "):
                lines[index] = line.rstrip("\n") + f" | source_receipts: {receipt}\n"
                break
        board_path.write_text("".join(lines), encoding="utf-8")
        gate = self.gate(project, fake)
        self.assertEqual(gate.get("code"), "SOURCE_LINKAGE_DRIFT", gate)
        self.assertEqual(gate.get("receipt"), receipt)
        refusal = Result.refuse("SOURCE_LINKAGE_DRIFT", "drift")
        self.assertFalse(refusal.ok)
        self.assertEqual(refusal.code, "SOURCE_LINKAGE_DRIFT")

    def test_close_requires_every_live_member_done(self) -> None:
        project = self.make_project()
        a = self.add(project, "work A")
        b = self.add(project, "work B")
        receipt = self.capture(project, a)
        self.assertTrue(intake.link_work_to(project, receipt, b).get("ok"))
        added = intake.add_requirement(project, receipt, rid="R1", text="mission clause")
        self.assertTrue(added.get("ok"), added)
        disposed = intake.set_disposition(
            project,
            receipt,
            f"{receipt}:R1",
            "VERIFIED",
            work=b,
            evidence="E-001",
            verification="focused test",
        )
        self.assertTrue(disposed.get("ok"), disposed)
        self.assertTrue(intake.coverage_complete(project, receipt))
        closed = intake.close_receipt(project, receipt)
        self.assertFalse(closed.get("ok"), closed)
        self.assertEqual(closed.get("code"), "SOURCE_WORK_ACTIVE", closed)
        self.assertIn(b, str(closed.get("detail")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
