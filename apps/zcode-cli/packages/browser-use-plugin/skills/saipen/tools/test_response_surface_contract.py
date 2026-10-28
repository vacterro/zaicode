"""Focused owner test for EXEC-RESPONSE-01 (T-1419).

Proves both the mechanically-checked shape (registry rule, owner, BOOT/placement,
cold profile, HUSH parity, validator surface) and at least one BEHAVIOURAL
projection (the surface contract and the autonomy continuation), so this is not
a string-presence test.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
for _entry in (str(TOOLS), str(ROOT)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

from saipen_engine import response_surface as RS  # noqa: E402
from saipen_engine.hush import HUSHED, MANDATORY as HUSH_MANDATORY  # noqa: E402

PROTOCOL = ROOT / "saipen"
REGISTRY = json.loads((PROTOCOL / "REGISTRY.json").read_text(encoding="utf-8-sig"))


class RegistrationTests(unittest.TestCase):
    def test_rule_is_registered_with_the_execution_owner(self):
        facts = REGISTRY["semantic_baseline"]["facts"]
        self.assertIn("EXEC-RESPONSE-01", facts)
        self.assertEqual(facts["EXEC-RESPONSE-01"]["owner"], "saipen/EXECUTION.md")
        self.assertEqual(
            REGISTRY["rule_owners"]["EXEC-RESPONSE-01"], "saipen/EXECUTION.md"
        )

    def test_exact_owner_file_is_execution_not_style(self):
        # It is NOT a STYLE rule: the owner is EXECUTION.md.
        self.assertEqual(RS.RULE_ID, "EXEC-RESPONSE-01")
        text = (PROTOCOL / "EXECUTION.md").read_text(encoding="utf-8-sig")
        self.assertIn("RULE-OWNER: EXEC-RESPONSE-01", text)
        style = (PROTOCOL / "STYLE.md").read_text(encoding="utf-8-sig")
        self.assertNotIn("RULE-OWNER: EXEC-RESPONSE-01", style)


class PlacementTests(unittest.TestCase):
    def test_boot_loads_style_and_execution_before_first_output(self):
        boot = (PROTOCOL / "BOOT.md").read_text(encoding="utf-8-sig")
        self.assertIn("STYLE.md", boot)
        self.assertIn("EXECUTION.md", boot)
        self.assertIn("before any", boot)
        # The reference to the canonical rule, not a duplicate schema.
        self.assertIn("EXEC-RESPONSE-01", boot)

    def test_activation_block_references_execution_without_duplicating_schema(self):
        block = (PROTOCOL / "ACTIVATION_BLOCK.md").read_text(encoding="utf-8-sig")
        self.assertIn("EXECUTION.md", block)
        self.assertIn("EXEC-RESPONSE-01", block)
        # No duplicate schema: the field list lives only in its owner.
        for field in RS.MANDATORY_FIELDS:
            self.assertNotIn(field, block, field)

    def test_execution_is_in_the_cold_first_response_profile(self):
        cold = REGISTRY["load_profiles"]["profiles"]["cold"]["routes"][0]
        self.assertIn("EXECUTION.md", cold["must"])


class FieldOrderTests(unittest.TestCase):
    def test_mandatory_order_is_fixed(self):
        doc = (PROTOCOL / "EXECUTION.md").read_text(encoding="utf-8-sig")
        positions = [doc.index(field) for field in RS.MANDATORY_FIELDS]
        self.assertEqual(positions, sorted(positions), "owner field order drifted")
        self.assertEqual(
            RS.MANDATORY_FIELDS,
            (
                "STATUS",
                "RESULT",
                "BLOCKER",
                "OPERATOR ACTION",
                "NEXT EXACT ACTION",
                "VALIDATION",
            ),
        )

    def test_details_is_optional_and_last(self):
        self.assertNotIn("DETAILS", RS.MANDATORY_FIELDS)
        self.assertEqual(RS.FIELD_ORDER[-1], "DETAILS")

    def test_a_wellformed_block_has_no_errors(self):
        block = {field: "x" for field in RS.MANDATORY_FIELDS}
        self.assertEqual(RS.surface_errors(block, status="DONE"), [])


class SurfaceBehaviourTests(unittest.TestCase):
    def test_missing_mandatory_field_refuses(self):
        block = {field: "x" for field in RS.MANDATORY_FIELDS if field != "BLOCKER"}
        errors = RS.surface_errors(block)
        self.assertTrue(any("BLOCKER" in error for error in errors), errors)

    def test_out_of_order_fields_refuse(self):
        block = {field: "x" for field in reversed(RS.MANDATORY_FIELDS)}
        self.assertTrue(
            any("canonical order" in error for error in RS.surface_errors(block))
        )

    def test_details_before_a_mandatory_field_refuses(self):
        block = {field: "x" for field in RS.MANDATORY_FIELDS}
        block["DETAILS"] = "x"
        # Reinsert DETAILS in the middle: dicts preserve insertion order.
        block = {
            k: block[k]
            for k in (*RS.MANDATORY_FIELDS[:3], "DETAILS", *RS.MANDATORY_FIELDS[3:])
        }
        self.assertTrue(
            any("DETAILS must render last" in error for error in RS.surface_errors(block))
        )

    def test_wait_without_operator_action_refuses(self):
        block = {field: "x" for field in RS.MANDATORY_FIELDS}
        block["OPERATOR ACTION"] = "NONE"
        errors = RS.surface_errors(block, status="WAIT -- manual-verify")
        self.assertTrue(any("OPERATOR ACTION" in error for error in errors), errors)


class AutonomyTests(unittest.TestCase):
    def test_deterministic_continuation_does_not_return_to_the_user(self):
        self.assertTrue(
            RS.should_continue(
                operator_action="NONE",
                executable_action_remains=True,
                response_boundary=False,
            )
        )

    def test_required_human_action_returns_the_surface(self):
        self.assertFalse(
            RS.should_continue(
                operator_action="Run the manual test and reply PASS/FAIL",
                executable_action_remains=True,
                response_boundary=False,
            )
        )

    def test_a_true_boundary_returns_the_surface(self):
        self.assertFalse(
            RS.should_continue(
                operator_action="NONE",
                executable_action_remains=True,
                response_boundary=True,
            )
        )

    def test_exhausted_route_returns_the_surface(self):
        self.assertFalse(
            RS.should_continue(
                operator_action="NONE",
                executable_action_remains=False,
                response_boundary=False,
            )
        )


class HushParityTests(unittest.TestCase):
    def test_hush_preserves_every_mandatory_field(self):
        # No mandatory control-surface field may be suppressed by HUSH.
        surface = set(RS.MANDATORY_FIELDS)
        suppressed = {kind for kind in HUSH_MANDATORY}
        self.assertEqual(surface & suppressed, set())
        for field in RS.MANDATORY_FIELDS:
            self.assertFalse(HUSHED.suppresses(field.lower()), field)

    def test_hush_may_suppress_details_only(self):
        self.assertTrue(HUSHED.suppresses("details"))
        # And every one of the six mandatory fields stays printed.
        for field in RS.MANDATORY_FIELDS:
            self.assertFalse(HUSHED.suppresses(field), field)

    def test_mandatory_kinds_are_never_discretionary(self):
        discretionary = set(HUSHED.describe()["suppressed"])
        mandatory = set(HUSHED.describe()["mandatory"])
        self.assertEqual(discretionary & mandatory, set())


class BudgetTests(unittest.TestCase):
    def test_context_budget_remains_green_with_execution_in_cold(self):
        import protocol_budget

        errors = protocol_budget.check(PROTOCOL)
        self.assertEqual(errors, [], errors)


if __name__ == "__main__":
    unittest.main()
