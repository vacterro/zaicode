"""T-1379: the ticket the canonical entry command creates can be finished.

Measured live on 2026-09-17, installed generation f3d2104a, two independent
matrix sessions (`safety_valve` SRC-001/T-1 and `already_done` SRC-002/T-8301).
Both drove the whole protocol chain, edited the target file, and then looped
here:

    source coverage gate for T-1: {'ok': False, 'code': 'SOURCE_UNRESOLVED',
    'receipt': 'SRC-001', 'coverage': {'requirements': 0, 'actionable': 0,
    'terminal': 0, 'dispositions': {}, 'unresolved': []}}

`saipen start` captures its receipt with an empty contract, `coverage_complete`
requires `actionable > 0`, so that gate could never pass -- and the two
functions that could have changed it, `intake.add_requirement` and
`intake.set_disposition`, are Python-only, so no command the CLI offers led
anywhere. A request is not zero requirements: it is exactly one, the text the
operator wrote, and the Work's own verification evidence is what discharges it.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import intake  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import cli, healthy, receipts_of  # noqa: E402

TASK = "add a one-line docstring to the top of src/app.py"


def setUpModule() -> None:
    isolate_host_session()


def drive(case: unittest.TestCase, root: Path, *, verified: bool = True) -> list[tuple]:
    """The canonical chain a field session runs, through the CLI only."""
    steps = [
        ("start", TASK, "--json"),
        ("transition", "BUILD", "T-1", "scout done", "--json"),
        ("checkpoint", "RUN", "T-1", "build -> added the docstring", "--json"),
        ("transition", "VERIFY", "T-1", "build done", "--json"),
    ]
    if verified:
        steps.append(
            (
                "checkpoint",
                "RUN",
                "T-1",
                "verify -> PASS [target: T-1] conf: high -- python -m compileall src/app.py",
                "--json",
            )
        )
        steps += [
            ("transition", "REVIEW", "T-1", "verify green", "--json"),
            ("transition", "SHIP", "T-1", "review passed", "--json"),
        ]
    out = []
    for args in steps:
        code, payload, text = cli(root, *args)
        case.assertEqual(code, 0, f"{args} -> {text}")
        out.append((args, payload))
    return out


class TheEntryCommandsTicketClosesTests(unittest.TestCase):
    """The measured deadlock, end to end, through the CLI alone."""

    def test_start_work_verify_and_finish(self):
        root = healthy(self)
        drive(self, root)
        code, payload, text = cli(root, "ticket", "done", "T-1", "--closure-mode", "own_patch",
                                  "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(payload["code"], "FINISHED", text)

        receipts = receipts_of(root)
        self.assertEqual(len(receipts), 1, receipts)
        summary = intake.coverage_summary(root, receipts[0])
        self.assertEqual(summary["actionable"], 1, summary)
        self.assertEqual(summary["unresolved"], [], summary)
        ledger = json.loads(
            (root / ".saipen" / "intake" / "coverage" / f"{receipts[0]}.json").read_text(
                encoding="utf-8"
            )
        )
        clause = ledger["requirements"][f"{receipts[0]}:R001"]
        self.assertEqual(clause["disposition"], "VERIFIED")
        self.assertIn("T-1", clause["evidence"])
        self.assertTrue(clause["verification"].strip())

    def test_the_seeded_clause_is_the_operator_text_not_a_summary(self):
        root = healthy(self)
        drive(self, root)
        cli(root, "ticket", "done", "T-1", "--closure-mode", "own_patch", "--json")
        receipt = receipts_of(root)[0]
        contract = json.loads(
            (root / ".saipen" / "intake" / "contracts" / f"{receipt}.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(contract["clauses"][f"{receipt}:R001"]["text"], TASK)
        self.assertTrue(intake.is_request_clause(root, receipt, f"{receipt}:R001"))


class NothingIsSettledWithoutTheWorksOwnProofTests(unittest.TestCase):
    """The discharge is the Work's verification evidence, not a formality."""

    def test_a_ticket_without_verification_evidence_still_refuses(self):
        root = healthy(self)
        drive(self, root, verified=False)
        # Straight from VERIFY to the close, with no PASS recorded.
        code, _payload, text = cli(root, "ticket", "done", "T-1", "--closure-mode", "own_patch",
                                   "--json")
        self.assertNotEqual(code, 0, text)
        receipt = receipts_of(root)[0]
        ledger_path = root / ".saipen" / "intake" / "coverage" / f"{receipt}.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        for clause in ledger["requirements"].values():
            self.assertNotEqual(clause["disposition"], "VERIFIED", clause)

    def test_a_derived_clause_is_never_settled_from_here(self):
        """An agent's own clause is an agent's own claim."""
        root = healthy(self)
        drive(self, root)
        receipt = receipts_of(root)[0]
        intake.ensure_request_clause(root, receipt)
        added = intake.add_requirement(
            root,
            receipt,
            rid="R002",
            text="and never touch the packaging metadata while doing it",
            clause_class="requirement",
        )
        self.assertTrue(added.get("ok"), added)

        code, payload, text = cli(root, "ticket", "done", "T-1", "--closure-mode", "own_patch",
                                  "--json")
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload["code"], "SOURCE_UNRESOLVED")
        summary = intake.coverage_summary(root, receipt)
        self.assertEqual(summary["unresolved"], [f"{receipt}:R002"], summary)
        self.assertFalse(intake.is_request_clause(root, receipt, f"{receipt}:R002"))


class RequestClauseIdentityTests(unittest.TestCase):
    """What counts as 'the request's own clause' is read from the bytes."""

    def test_request_clause_text_reads_the_request_section(self):
        body = "# User request\n\npriority: P1\nverify: x\n\n## Request\n\nfix the login bug\n"
        self.assertEqual(intake.request_clause_text(body), "fix the login bug")

    def test_a_body_without_a_request_section_yields_nothing(self):
        self.assertEqual(intake.request_clause_text("# Audit\n\nsome findings\n"), "")

    def test_ensure_is_idempotent_and_refuses_a_foreign_receipt(self):
        root = healthy(self)
        drive(self, root)
        receipt = receipts_of(root)[0]
        first = intake.ensure_request_clause(root, receipt)
        self.assertTrue(first.get("ok"), first)
        again = intake.ensure_request_clause(root, receipt)
        self.assertEqual(again.get("code"), "ALREADY_DERIVED", again)
        self.assertEqual(intake.coverage_summary(root, receipt)["actionable"], 1)

        missing = intake.ensure_request_clause(root, "SRC-999")
        self.assertFalse(missing.get("ok"), missing)


if __name__ == "__main__":
    unittest.main()
