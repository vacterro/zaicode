"""Real HUSH runtime (T-1236, EXEC-HUSH-01).

The audit's bar: an actual parser/runtime modifier, task-local policy state,
narration suppression that is tested, mandatory interaction that survives it,
`hush cc` parity with `cc`, and no leak into the next task. REGISTRY may only
flip off `planned` once these hold.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import commands, hush  # noqa: E402
from saipen_engine.registry import load_registry  # noqa: E402

PROTOCOL = ROOT / "saipen"


class Parsing(unittest.TestCase):
    def test_a_leading_modifier_activates_and_hands_over_the_bare_task(self) -> None:
        policy, task = hush.strip_modifier("hush cc")
        self.assertTrue(policy.hushed)
        self.assertEqual(task, "cc")

    def test_the_task_text_is_handed_over_unchanged(self) -> None:
        policy, task = hush.strip_modifier("hush saipen ticket add P2 fix the thing")
        self.assertTrue(policy.hushed)
        self.assertEqual(task, "saipen ticket add P2 fix the thing")

    def test_hush_inside_a_task_is_ordinary_text(self) -> None:
        policy, task = hush.strip_modifier("ship the hush docs")
        self.assertFalse(policy.hushed)
        self.assertEqual(task, "ship the hush docs")

    def test_a_bare_modifier_is_not_an_activation(self) -> None:
        policy, task = hush.strip_modifier("hush")
        self.assertFalse(policy.hushed)
        self.assertEqual(task, "")
        self.assertFalse(hush.activate("hush")["ok"])

    def test_empty_and_non_string_input_never_activate(self) -> None:
        for value in ("", "   ", None, 7, []):
            policy, task = hush.strip_modifier(value)
            self.assertFalse(policy.hushed)
            self.assertEqual(task, "")


class Suppression(unittest.TestCase):
    def test_discretionary_narration_is_suppressed_under_hush(self) -> None:
        for kind in hush.DISCRETIONARY:
            self.assertTrue(hush.HUSHED.suppresses(kind), kind)

    def test_mandatory_output_is_never_suppressed(self) -> None:
        for kind in hush.MANDATORY:
            self.assertFalse(hush.HUSHED.suppresses(kind), kind)

    def test_an_unknown_output_kind_prints_rather_than_disappearing(self) -> None:
        self.assertFalse(hush.HUSHED.suppresses("something-new"))

    def test_the_default_policy_suppresses_nothing(self) -> None:
        for kind in hush.DISCRETIONARY | hush.MANDATORY:
            self.assertFalse(hush.DEFAULT.suppresses(kind), kind)

    def test_the_two_output_sets_cannot_overlap(self) -> None:
        self.assertEqual(hush.DISCRETIONARY & hush.MANDATORY, frozenset())

    def test_evidence_and_the_final_report_are_mandatory(self) -> None:
        self.assertIn("evidence", hush.MANDATORY)
        self.assertIn("final_report", hush.MANDATORY)
        self.assertIn("destructive_confirmation", hush.MANDATORY)
        self.assertIn("safety_refusal", hush.MANDATORY)


class Parity(unittest.TestCase):
    """`hush <task>` must route EXACTLY where `<task>` routes."""

    def _resolve(self, message: str) -> list[dict]:
        _policy, task = hush.strip_modifier(message)
        return commands.resolve_compound_command(task, protocol_dir=PROTOCOL)

    def test_hush_cc_resolves_to_the_same_command_as_cc(self) -> None:
        self.assertEqual(
            [seg["command"] for seg in self._resolve("hush cc")],
            [seg["command"] for seg in self._resolve("cc")],
        )

    def test_parity_holds_across_the_whole_shortcut_table(self) -> None:
        table = commands.load_shortcut_table(PROTOCOL)
        for token in table:
            self.assertEqual(
                [seg["command"] for seg in self._resolve(f"hush {token}")],
                [seg["command"] for seg in self._resolve(token)],
                token,
            )

    def test_parity_holds_for_a_compound_task(self) -> None:
        self.assertEqual(
            [seg["command"] for seg in self._resolve("hush saipen status + cc")],
            [seg["command"] for seg in self._resolve("saipen status + cc")],
        )

    def test_the_modifier_decides_nothing_about_routing(self) -> None:
        # The resolver never sees the modifier at all; that is what makes the
        # parity above structural rather than a coincidence of one table.
        self.assertEqual(hush.strip_modifier("hush cc")[1], "cc")


class Lifecycle(unittest.TestCase):
    def test_the_policy_is_task_local_and_never_persisted(self) -> None:
        first = hush.activate("hush cc")
        self.assertTrue(first["policy"].hushed)
        second = hush.activate("cc")
        self.assertFalse(second["policy"].hushed)

    def test_the_policy_is_immutable(self) -> None:
        with self.assertRaises(Exception):
            hush.HUSHED.hushed = False  # type: ignore[misc]

    def test_activation_reports_the_bounded_final_report(self) -> None:
        self.assertEqual(hush.activate("hush cc")["final_report_max_lines"], 20)
        self.assertIsNone(hush.activate("cc")["final_report_max_lines"])


class RegistryTruth(unittest.TestCase):
    def test_registry_status_matches_the_shipped_runtime(self) -> None:
        facts = load_registry(PROTOCOL)["hush_precedence"]
        self.assertEqual(facts["status"], "active")
        self.assertEqual(facts["owner"], "saipen/EXECUTION.md")
        self.assertEqual(facts["runtime"], "tools/saipen_engine/hush.py")
        self.assertEqual(facts["test"], "tools/test_hush_runtime.py")

    def test_the_output_sets_have_one_owner(self) -> None:
        facts = load_registry(PROTOCOL)["hush_precedence"]
        self.assertEqual(set(facts["suppressible"]), set(hush.DISCRETIONARY))
        self.assertEqual(set(facts["mandatory"]), set(hush.MANDATORY))
        self.assertEqual(facts["modifier"], hush.MODIFIER)
        self.assertEqual(facts["final_report_max_lines"], hush.FINAL_REPORT_MAX_LINES)

    def test_precedence_still_puts_user_and_safety_above_policy(self) -> None:
        order = load_registry(PROTOCOL)["hush_precedence"]["order"]
        self.assertLess(order.index("user"), order.index("execution_policy"))
        self.assertLess(order.index("safety"), order.index("execution_policy"))
        self.assertLess(order.index("core"), order.index("execution_policy"))
        self.assertLess(order.index("execution_policy"), order.index("style"))


if __name__ == "__main__":
    unittest.main()
