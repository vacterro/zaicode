"""T-1403: the router must not emit an action its own closure gate refuses.

Measured residual (T-1394 TRIAGE, SAI-DEFECT-20260918-routeless-finish):
`saipen continue` returned a `PHASE finish` action for a DOING ticket whose
linked receipt carried non-terminal actionable clauses, and obeying it made
`saipen ticket done` refuse `SOURCE_UNRESOLVED` with NO canonical route. One
action was handed out that the gate beside it could already prove would refuse,
and the refusal named no way forward. T-1379/T-1377 closed the request-clause
and missing-evidence shapes; this is the generic residual.

The repair is ONE closure-readiness decision
(`saipen_engine.closure_readiness`) read by BOTH the router (before it emits a
finish route) and the finish operation (before it refuses), so a route one
surface refuses can never be handed out by the other.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import intake  # noqa: E402
from saipen_engine.closure_readiness import closure_readiness  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_request_clause_closure import drive  # noqa: E402
from test_t1363_zero_manual_entry import cli, healthy, receipts_of  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


def _with_unresolved_derived_clause(case: unittest.TestCase, root: Path) -> str:
    """Drive to SHIP, then add a derived actionable clause that is not terminal.

    This is the exact T-1403 shape: the Work is otherwise closeable but its
    linked receipt carries a clause only a `source disp` can settle.
    """
    drive(case, root)
    receipt = receipts_of(root)[0]
    intake.ensure_request_clause(root, receipt)
    added = intake.add_requirement(
        root,
        receipt,
        rid="R002",
        text="and never touch the packaging metadata while doing it",
        clause_class="requirement",
    )
    case.assertTrue(added.get("ok"), added)
    return receipt


class RouterDoesNotEmitARefusedFinishTests(unittest.TestCase):
    def test_continue_names_the_remediation_instead_of_a_doomed_finish(self):
        root = healthy(self)
        receipt = _with_unresolved_derived_clause(self, root)

        _code, routed, _text = cli(root, "continue", "--json")
        # The route is refused (ok False) and carries the finite remediation --
        # never the `PHASE SHIP` action the closure gate would refuse.
        self.assertNotEqual(routed.get("code"), "ROUTED", routed)
        action = routed.get("action", "")
        self.assertFalse(
            str(action).startswith("PHASE SHIP"),
            f"router emitted a finish the gate refuses: {routed}",
        )
        self.assertTrue(
            routed.get("canonical_next_command"),
            f"a refusal with no route is a dead end: {routed}",
        )
        self.assertEqual(
            routed.get("canonical_next_command"),
            f"saipen source disp {receipt} {receipt}:R002 <STATUS> --evidence <REF>",
            routed,
        )

    def test_the_finish_refusal_itself_names_the_same_route(self):
        root = healthy(self)
        receipt = _with_unresolved_derived_clause(self, root)

        code, payload, text = cli(
            root, "ticket", "done", "T-1", "--closure-mode", "own_patch", "--json"
        )
        self.assertNotEqual(code, 0, text)
        self.assertEqual(payload.get("code"), "SOURCE_UNRESOLVED", payload)
        self.assertEqual(
            payload.get("canonical_next_command"),
            f"saipen source disp {receipt} {receipt}:R002 <STATUS> --evidence <REF>",
            payload,
        )

    def test_the_named_route_is_reachable_and_settles_the_work(self):
        root = healthy(self)
        receipt = _with_unresolved_derived_clause(self, root)

        # Dispense the derived clause through the EXACT command the refusal
        # named, substituting the real STATUS/REF the operator decides.
        code, payload, text = cli(
            root,
            "source",
            "disp",
            receipt,
            f"{receipt}:R002",
            "NOT_APPLICABLE",
            "--evidence",
            "operator reviewed: packaging metadata untouched",
            "--json",
        )
        self.assertEqual(code, 0, text)

        # Now the closure gate is ready and the finish succeeds.
        code, payload, text = cli(
            root, "ticket", "done", "T-1", "--closure-mode", "own_patch", "--json"
        )
        self.assertEqual(code, 0, text)
        self.assertEqual(payload.get("code"), "FINISHED", text)


class ClosureReadinessDecisionTests(unittest.TestCase):
    """The decision owner itself, independent of routing or finish."""

    def test_a_ready_work_reports_no_remediation(self):
        root = healthy(self)
        drive(self, root)
        decision = closure_readiness(root, "T-1")
        self.assertTrue(decision["ready"], decision)
        self.assertIsNone(decision["canonical_next_command"])

    def test_a_request_only_gap_routes_to_the_evidence_checkpoint(self):
        """An empty/request-only contract is settled by the Work's own proof."""
        root = healthy(self)
        drive(self, root, verified=False)
        decision = closure_readiness(root, "T-1")
        self.assertFalse(decision["ready"], decision)
        # Before the PASS there is no boundary; the route is the phase edge or
        # the evidence checkpoint -- never prose, never empty.
        self.assertTrue(decision["canonical_next_command"])

    def test_a_derived_gap_routes_to_the_exact_dispense_command(self):
        root = healthy(self)
        receipt = _with_unresolved_derived_clause(self, root)
        decision = closure_readiness(root, "T-1")
        self.assertFalse(decision["ready"], decision)
        self.assertEqual(decision["code"], "SOURCE_UNRESOLVED")
        self.assertIn(
            f"saipen source disp {receipt} {receipt}:R002",
            decision["canonical_next_command"],
        )


if __name__ == "__main__":
    unittest.main()
