"""T-1455: a coverage refusal must name its own next action.

SRC-103 milestone 8. `work_closure_gate` and `release_gate` used to answer::

    {"ok": false, "code": "SOURCE_UNRESOLVED", "receipt": "SRC-007"}

which says a receipt is unresolved and nothing a caller can act on: not who
owns it, not whether a contract was ever derived, not which clauses are open,
not whether it is even inside the release being shipped. Two SAIPENVIEW field
sessions each invented the same two escapes instead -- declaring the project
MISROUTED_PROJECT_BINDING, and hand-authoring an operator-authority capsule.
Both falsify history; neither is a repair.

So the routing facts travel WITH the refusal, from one owner, and the refusal
says out loud that it is not a binding fault.
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
from saipen_engine.operations import ticket_add  # noqa: E402

ROOT = TOOLS.parent

#: Every routing fact a caller needs to act without archaeology.
ROUTING_FIELDS = (
    "work",
    "source_status",
    "linked_work",
    "linked_works",
    "contract_derived",
    "coverage",
    "canonical_next_command",
    "binding_fault",
)


class RoutableRefusalTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="saipen-t1455-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        self.project = tmp / "project"
        (self.project / ".saipen").mkdir(parents=True)
        (self.project / ".saipen" / "STATE.md").write_text(
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
        (self.project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (self.project / ".saipen" / "LOG.md").write_text(
            "- 01.09.26 00:00 [E-001] [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        ensure_project_lineage(self.project)

    def _work(self, text="carry the mission"):
        result = ticket_add(self.project, "tester", "P1", text, [], "verify with a test")
        self.assertTrue(result.ok, result.to_dict())
        return result.data["ticket"]

    def _unresolved_receipt(self):
        work = self._work()
        captured = intake.capture(
            self.project,
            "SAIPEN\n\nmission body with no request header\n",
            source_kind="user_instruction",
            work=work,
        )
        self.assertTrue(captured.get("ok"), captured)
        receipt = captured["receipt"]
        self.assertTrue(intake.ensure_request_clause(self.project, receipt).get("ok"))
        return work, receipt

    def test_unresolved_coverage_carries_every_routing_fact(self):
        work, receipt = self._unresolved_receipt()
        gate = intake.work_closure_gate(self.project, work)
        self.assertFalse(gate.get("ok"), gate)
        self.assertEqual(gate.get("code"), "SOURCE_UNRESOLVED")
        for field in ROUTING_FIELDS:
            with self.subTest(field=field):
                self.assertIn(field, gate)
        self.assertEqual(gate.get("receipt"), receipt)
        self.assertEqual(gate.get("work"), work)
        self.assertIn(work, gate.get("linked_works") or [])
        self.assertTrue(gate.get("contract_derived"))
        self.assertTrue(gate.get("unresolved_clauses"))

    def test_the_next_command_is_canonical_and_specific(self):
        work, _receipt = self._unresolved_receipt()
        gate = intake.work_closure_gate(self.project, work)
        command = gate.get("canonical_next_command") or ""
        self.assertTrue(command.startswith("saipen "), command)
        self.assertIn("source disp", command)
        self.assertNotIn("continue as appropriate", command)

    def test_the_next_command_names_what_the_refusal_already_knows(self):
        # A template that makes the caller look up the receipt, the Work and
        # the open clause is the archaeology the routing owner exists to end.
        work, receipt = self._unresolved_receipt()
        gate = intake.work_closure_gate(self.project, work)
        command = gate["canonical_next_command"]
        self.assertIn(f"source disp {receipt} R001 ", command)
        self.assertIn(f"--work {work}", command)
        for placeholder in ("<SRC-###>", "<T-###>", "<RID>"):
            with self.subTest(placeholder=placeholder):
                self.assertNotIn(placeholder, command)

    def test_outside_a_release_scope_membership_is_explicitly_unevaluated(self):
        # Absent reads like "not in scope" to a caller that defaults it.
        work, _receipt = self._unresolved_receipt()
        gate = intake.work_closure_gate(self.project, work)
        self.assertIn("in_release_scope", gate)
        self.assertIsNone(gate["in_release_scope"])

    def test_a_release_refusal_names_release_scope_membership(self):
        # Measured: release_gate passed a relevant Work's closure refusal on
        # unchanged, so the release answer carried no scope membership at all.
        work, receipt = self._unresolved_receipt()
        gate = intake.release_gate(self.project)
        self.assertFalse(gate.get("ok"), gate)
        self.assertEqual(gate.get("code"), "SOURCE_UNRESOLVED")
        self.assertEqual(gate.get("receipt"), receipt)
        self.assertEqual(gate.get("work"), work)
        self.assertIs(gate.get("in_release_scope"), True)
        self.assertIs(gate.get("binding_fault"), False)

    def test_a_contractless_receipt_is_sent_to_req_not_disp(self):
        # Zero clauses and unresolved clauses are different repairs. Naming
        # `source disp` for a receipt with no contract points the caller at a
        # clause id that does not exist -- exactly the dead end that made two
        # sessions invent an escape instead.
        work = self._work()
        captured = intake.capture(
            self.project,
            "an external audit body with findings to derive\n",
            source_kind="external_audit",
            work=work,
        )
        self.assertTrue(captured.get("ok"), captured)
        gate = intake.work_closure_gate(self.project, work)
        self.assertEqual(gate.get("code"), "SOURCE_UNRESOLVED", gate)
        self.assertFalse(gate.get("contract_derived"))
        self.assertIn("source req", gate.get("canonical_next_command", ""))

    def test_a_coverage_refusal_is_never_a_binding_fault(self):
        # The exact escape two field sessions invented. If the refusal ever
        # stops saying this, the next session invents it again.
        work, _receipt = self._unresolved_receipt()
        gate = intake.work_closure_gate(self.project, work)
        self.assertIs(gate.get("binding_fault"), False)
        self.assertNotIn("MISROUTED_PROJECT_BINDING", str(gate))

    def test_routing_never_turns_a_refusal_into_an_exception(self):
        # Best-effort by contract: an unreadable receipt must still answer.
        refusal = intake.route_source_refusal(
            self.project,
            {"ok": False, "code": "SOURCE_UNRESOLVED", "receipt": "SRC-999"},
            work="T-9999",
        )
        self.assertFalse(refusal["ok"])
        self.assertEqual(refusal["work"], "T-9999")
        self.assertIn("canonical_next_command", refusal)

    def test_a_passing_gate_is_left_exactly_as_it_was(self):
        untouched = {"ok": True, "code": "SOURCE_COVERAGE_COMPLETE", "work": "T-1"}
        self.assertEqual(intake.route_source_refusal(self.project, untouched), untouched)

    def test_every_refusal_code_has_a_named_next_command(self):
        for code in (
            "SOURCE_UNRESOLVED",
            "SOURCE_LINKAGE_MISSING",
            "SOURCE_LINKAGE_DRIFT",
            "SOURCE_RECEIPT_MISSING",
            "SOURCE_WORK_ACTIVE",
            "SOURCE_CORRUPTION",
        ):
            with self.subTest(code=code):
                self.assertIn(code, intake._COVERAGE_NEXT_COMMAND)
                self.assertTrue(intake._COVERAGE_NEXT_COMMAND[code].startswith("saipen "))


if __name__ == "__main__":
    unittest.main()
