"""Regression controls for the causal OpenCode continuation oracle."""

from __future__ import annotations

import json
import unittest

from tools.opencode_live_evaluator import evaluate_duplicate_continuations


ROOT = r"V:\fixture"


def _event(index, tool, output="", *, command=None, file_path=None, status="completed"):
    inputs = {"workdir": ROOT}
    if command is not None:
        inputs["command"] = command
    if file_path is not None:
        inputs["filePath"] = file_path
    return {
        "event_index": index,
        "tool": tool,
        "status": status,
        "input": inputs,
        "output": output,
    }


def _state(phase, task, last_event):
    return f"phase: {phase}\ntask: {task}\nlast_event: {last_event}\n"


def _json(**values):
    return json.dumps(values)


class ContinuationGenerationOracleTests(unittest.TestCase):
    def test_red_unchanged_unresolved_route_is_duplicate(self):
        events = [
            _event(
                1, "read", _state("VERIFY", "T-1319", 100), file_path=ROOT + r"\.saipen\STATE.md"
            ),
            _event(
                2,
                "bash",
                _json(ok=True, action="PHASE VERIFY T-1319", phase="VERIFY", ticket="T-1319"),
                command="saipen continue --json",
            ),
            _event(
                3,
                "bash",
                _json(ok=True, action="PHASE VERIFY T-1319", phase="VERIFY", ticket="T-1319"),
                command="saipen continue --json",
            ),
        ]

        verdict = evaluate_duplicate_continuations(events)

        self.assertFalse(verdict["no_duplicate_continue"])
        self.assertEqual(verdict["duplicate_events"][0]["event_index"], 3)

    def test_green_terminal_generation_change_is_not_duplicate(self):
        events = [
            _event(
                1, "read", _state("VERIFY", "T-1319", 100), file_path=ROOT + r"\.saipen\STATE.md"
            ),
            _event(
                2,
                "bash",
                _json(ok=True, action="PHASE VERIFY T-1319", phase="VERIFY", ticket="T-1319"),
                command="saipen continue --json",
            ),
            _event(
                3,
                "bash",
                _json(ok=True, code="FINISHED", phase="DONE", task="none", event_id="E-107"),
                command="saipen ticket done T-1319 --json",
            ),
            _event(4, "read", _state("DONE", "none", 107), file_path=ROOT + r"\.saipen\STATE.md"),
            _event(
                5,
                "bash",
                _json(ok=False, code="NO_ACTIVE_WORK", phase="DONE", task="none"),
                command="saipen continue --json 2>&1",
                status="error",
            ),
        ]

        verdict = evaluate_duplicate_continuations(events)

        self.assertTrue(verdict["no_duplicate_continue"])
        self.assertEqual(
            [route["before"]["phase"] for route in verdict["routes"]], ["VERIFY", "DONE"]
        )

    def test_green_post_done_improve_assignment_is_new_route(self):
        events = [
            _event(
                1, "read", _state("VERIFY", "T-1319", 100), file_path=ROOT + r"\.saipen\STATE.md"
            ),
            _event(
                2,
                "bash",
                _json(ok=True, action="PHASE VERIFY T-1319", phase="VERIFY", ticket="T-1319"),
                command="saipen continue --json",
            ),
            _event(
                3,
                "bash",
                _json(ok=True, code="FINISHED", phase="DONE", task="none", event_id="E-107"),
                command="saipen ticket done T-1319 --json",
            ),
            _event(
                4,
                "bash",
                _json(
                    ok=True,
                    code="IMPROVE_AUDIT_ASSIGNMENT",
                    scope={"phase": "DONE", "task": "none"},
                ),
                command="saipen continue --json",
            ),
        ]

        verdict = evaluate_duplicate_continuations(events)

        self.assertTrue(verdict["no_duplicate_continue"])
        self.assertEqual(verdict["routes"][1]["returned_action"], "IMPROVE_AUDIT_ASSIGNMENT")


if __name__ == "__main__":
    unittest.main()
