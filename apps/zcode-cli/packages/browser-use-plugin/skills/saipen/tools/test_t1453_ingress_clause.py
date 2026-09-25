"""T-1453: every ingress can derive its request clause, not only `start`.

Measured live on 2026-09-22 in the protocol home. Three ordinary operator
handoffs arrived through `saipen source capture --file` -- the transport a
dropped .md file actually uses -- and every one of them answered::

    {"code": "SOURCE_RECEIVED", "receipt": "SRC-101", "requirements": 0}

`ensure_request_clause` only ever looked for the ``## Request`` header that
`entry.py` writes, so a header-less body derived nothing. `coverage_complete`
needs ``actionable > 0`` and `release_gate` fails closed SOURCE_UNRESOLVED for
an unprojected receipt, so three handoffs froze publication on arrival and no
command the operator could reach would have changed it.

The repair gives the derivation a fallback for header-less bodies, so the
closure gate that already calls `ensure_request_clause` can project ANY
captured request, not only one `start` wrote. The fallback clause names the
receipt and its digest instead of restating a truncated request as if it were
the contract -- the body stays the authority.
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import intake  # noqa: E402
from saipen_engine.journal import ensure_project_lineage  # noqa: E402

ROOT = TOOLS.parent

HEADERLESS = (
    "SAIPEN\n\nSAIHANDOFF -- repair the audit manifest classification\n\n"
    "Do not weaken source traceability.\n"
)
WITH_HEADER = f"# captured\n\n{intake.REQUEST_HEADER}\nfix the importer timeout\n"


class IngressClauseTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="saipen-t1453-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        self.base = tmp / "project"
        (self.base / ".saipen").mkdir(parents=True)
        (self.base / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: DONE\n"
            "task: none\n"
            'next_action: "saipen continue"\n'
            'blocker: ""\n'
            "transition_from: DONE\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            "agent: tester\n"
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            'updated: "2026-09-01T00:00:00Z"\n'
            "---\n",
            encoding="utf-8",
        )
        (self.base / ".saipen" / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (self.base / ".saipen" / "LOG.md").write_text(
            "- 01.09.26 00:00 [E-001] [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        ensure_project_lineage(self.base)

    def _capture(self, body, kind="user_instruction"):
        return intake.capture(self.base, body, source_kind=kind)

    def _clauses(self, receipt):
        contract = intake._read_contract(self.base, receipt) or {}
        return contract.get("clauses") or {}

    def test_headerless_body_becomes_projectable(self):
        result = self._capture(HEADERLESS)
        self.assertTrue(result.get("ok"), result)
        receipt = result["receipt"]
        self.assertEqual(self._clauses(receipt), {}, "capture itself stays verbatim-only")
        seeded = intake.ensure_request_clause(self.base, receipt)
        self.assertTrue(seeded.get("ok"), seeded)
        summary = intake.coverage_summary(self.base, receipt)
        self.assertGreater(summary["actionable"], 0, "a request is not zero requirements")

    def test_headerless_body_used_to_derive_nothing_at_all(self):
        # The exact pre-fix shape: the header-only derivation returned "" for
        # every body that did not come from `start`, so the receipt could
        # never be projected and its Work could never close.
        self.assertEqual(intake.request_clause_text(HEADERLESS), "")
        self.assertNotEqual(
            intake.canonical_request_clause_text("SRC-001", HEADERLESS, "deadbeefcafe"), ""
        )

    def test_fallback_clause_points_at_the_receipt_not_a_paraphrase(self):
        result = self._capture(HEADERLESS)
        receipt = result["receipt"]
        intake.ensure_request_clause(self.base, receipt)
        clause = self._clauses(receipt)[f"{receipt}:R001"]
        self.assertIn(receipt, clause["text"])
        self.assertIn(result["source_sha256"][:12], clause["text"])
        self.assertTrue(intake.is_request_clause(self.base, receipt, f"{receipt}:R001"))

    def test_header_body_clause_is_still_exactly_the_operator_words(self):
        result = self._capture(WITH_HEADER)
        receipt = result["receipt"]
        intake.ensure_request_clause(self.base, receipt)
        clause = self._clauses(receipt)[f"{receipt}:R001"]
        self.assertEqual(clause["text"], "fix the importer timeout")
        self.assertNotIn("sha256", clause["text"])

    def test_seeding_is_idempotent(self):
        result = self._capture(HEADERLESS)
        receipt = result["receipt"]
        self.assertTrue(intake.ensure_request_clause(self.base, receipt).get("ok"))
        first = dict(self._clauses(receipt))
        again = intake.ensure_request_clause(self.base, receipt)
        self.assertEqual(again.get("code"), "ALREADY_DERIVED", again)
        self.assertEqual(self._clauses(receipt), first)

    def test_an_interpreted_contract_is_never_overwritten(self):
        result = self._capture(HEADERLESS)
        receipt = result["receipt"]
        added = intake.add_requirement(
            self.base, receipt, rid="R002", text="derived by an agent", clause_class="requirement"
        )
        self.assertTrue(added.get("ok"), added)
        before = dict(self._clauses(receipt))
        intake.ensure_request_clause(self.base, receipt)
        self.assertEqual(self._clauses(receipt), before)

    def test_a_seeded_clause_is_not_complete_coverage(self):
        # Negative control for the tempting shortcut: "empty contract means
        # nothing was asked, so coverage is complete". Seeding gives the
        # receipt something to DISCHARGE; it must not discharge it.
        result = self._capture(HEADERLESS)
        receipt = result["receipt"]
        intake.ensure_request_clause(self.base, receipt)
        self.assertFalse(intake.coverage_complete(self.base, receipt))
        summary = intake.coverage_summary(self.base, receipt)
        self.assertTrue(summary["unresolved"])

    def test_an_audit_still_derives_nothing_automatically(self):
        # An audit's clauses ARE its individual findings. One catch-all clause
        # would let a forty-finding audit close on a single disposition, so
        # the seeding stops at the kinds whose body IS the request.
        result = self._capture(HEADERLESS, kind="external_audit")
        receipt = result["receipt"]
        refused = intake.ensure_request_clause(self.base, receipt)
        self.assertEqual(refused.get("code"), "NOT_A_USER_REQUEST", refused)
        self.assertEqual(self._clauses(receipt), {})

    def test_a_corrective_followup_is_a_request_too(self):
        # SRC-042 sat ACTIVE with a linked ticket and zero clauses because the
        # derivation was gated on one kind. A correction the operator wrote is
        # their request, and its Work could never close either.
        result = self._capture(HEADERLESS, kind="corrective_followup")
        receipt = result["receipt"]
        self.assertTrue(intake.ensure_request_clause(self.base, receipt).get("ok"))
        self.assertGreater(intake.coverage_summary(self.base, receipt)["actionable"], 0)

    def test_closure_settles_a_corrective_followup_like_any_request(self):
        # A second literal `!= "user_instruction"` lived in
        # `discharge_request_clauses`, so closure silently skipped every
        # corrective_followup: SRC-042 stayed unresolved after T-1326 was
        # already DONE, and no closure path would ever settle it again.
        from saipen_engine.operations import ticket_add

        for kind in ("user_instruction", "corrective_followup"):
            with self.subTest(kind=kind):
                added = ticket_add(
                    self.base, "tester", "P1", f"{kind} work", [], "verify with a test"
                )
                self.assertTrue(added.ok, added.to_dict())
                work = added.data["ticket"]
                captured = intake.capture(
                    self.base, f"{HEADERLESS}\n{kind}\n", source_kind=kind, work=work
                )
                self.assertTrue(captured.get("ok"), captured)
                settled = intake.discharge_request_clauses(
                    self.base,
                    work,
                    evidence=f"{work} closed with verification evidence in LOG",
                    verification=f"see the {work} VERIFY cycle",
                )
                self.assertEqual(settled, [f"{captured['receipt']}:R001"])
                self.assertTrue(intake.coverage_complete(self.base, captured["receipt"]))

    def test_closure_never_settles_an_audits_derived_clause(self):
        from saipen_engine.operations import ticket_add

        added = ticket_add(self.base, "tester", "P1", "audit work", [], "verify with a test")
        work = added.data["ticket"]
        captured = intake.capture(
            self.base, "audit body\n", source_kind="external_audit", work=work
        )
        added_clause = intake.add_requirement(
            self.base, captured["receipt"], rid="R001", text="finding one"
        )
        self.assertTrue(added_clause.get("ok"), added_clause)
        settled = intake.discharge_request_clauses(
            self.base, work, evidence="e", verification="v"
        )
        self.assertEqual(settled, [], "an audit finding is its own claim")

    def test_an_empty_body_derives_nothing(self):
        text = intake.canonical_request_clause_text("SRC-001", "   \n\n ", "abc123")
        self.assertEqual(text, "")


if __name__ == "__main__":
    unittest.main()
