"""T-1317 Target A acceptance controls: unknown-tool fail-closed contract.

Every control here was designed against the verified pre-fix defect:

    healthy project + host:kiro + tool control_bash_process
    tool_input {"processId":"123","input":"rm -rf src"} + bound actor

returned exit 0 / ADMITTED / action unknown / effect mutating / targets []
/ targets_unresolved false. The documented admission contract says unknown
actions are potentially mutating and fail closed; these tests pin the
repaired behavior end to end through the public `saipen guard` CLI.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_guard_hostile_matrix import (  # noqa: E402
    GuardEventHarness,
    corrupt_state_project,
    fresh_project,
    recovery_debt_project,
)

SAIPEN = TOOLS / "saipen.py"


def cli_guard(event: dict) -> tuple[int, dict]:
    payload = json.dumps(event)
    proc = subprocess.run(
        [sys.executable, str(SAIPEN), "guard", "--event-json", "-", "--json"],
        input=payload,
        capture_output=True,
        text=True,
        cwd=str(event["cwd"]),
        timeout=60,
    )
    return proc.returncode, json.loads(proc.stdout)


def kiro_process_event(root: Path) -> dict:
    """The exact public-boundary defect event (T-1317 Target A acceptance)."""
    return {
        "event": "before_tool",
        "host": "kiro",
        "cwd": str(root),
        "tool_name": "control_bash_process",
        "tool_input": {"processId": "123", "input": "rm -rf src"},
        "actor": "test-agent",
    }


class UnknownToolFailClosedAcceptance(unittest.TestCase):
    """Requirements A-H of the T-1317 Target A repair contract."""

    def test_A_healthy_project_unknown_targetless_tool_is_refused(self):
        root = fresh_project()
        code, data = cli_guard(GuardEventHarness.tool_event(root, "mystery_tool", {}))
        self.assertEqual(code, 1, data)
        self.assertEqual(data["code"], "TARGET_UNRESOLVED", data)
        self.assertFalse(data["admitted"])
        self.assertEqual(data["event"]["action"], "unknown")
        self.assertEqual(data["effect"], "mutating")

    def test_B_healthy_project_namespaced_unknown_targetless_tool_is_refused(self):
        root = fresh_project()
        for tool in ("mcp__server__invoke", "plugin.run", "vendor__tool"):
            with self.subTest(tool=tool):
                code, data = cli_guard(GuardEventHarness.tool_event(root, tool, {}))
                self.assertEqual(code, 1, data)
                self.assertEqual(data["code"], "TARGET_UNRESOLVED", data)
                self.assertEqual(data["event"]["action"], "unknown", data)

    def test_C_kiro_control_bash_process_is_never_an_admitted_targetless_unknown(self):
        # The exact reproduction from the audit brief, on a healthy project.
        root = fresh_project()
        code, data = cli_guard(kiro_process_event(root))
        self.assertEqual(code, 1, data)
        self.assertEqual(data["code"], "TARGET_UNRESOLVED", data)
        self.assertFalse(data["admitted"])
        self.assertEqual(data["event"]["tool_name"], "control_bash_process")
        self.assertEqual(data["event"]["action"], "unknown")
        # Via the real Kiro transport the translated identity refuses too.
        import os

        from install_host_guard import install  # noqa: F401  (parity with native tests)

        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "host_guard.py"),
                "--host",
                "kiro",
                "--saipen-root",
                str(TOOLS.parent),
            ],
            input=json.dumps(
                {"cwd": str(root), "tool_name": "control_bash_process",
                 "tool_input": {"processId": "123", "input": "rm -rf src"}}
            ),
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, "SAIPEN_AGENT": "test-agent"},
        )
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("TARGET_UNRESOLVED", proc.stderr)

    def test_D_unknown_tool_with_an_ordinary_path_gains_no_read_trust(self):
        root = fresh_project()
        for tool, tool_input, expected in (
            ("mystery_tool", {"path": "src/app.py"}, "TARGET_UNRESOLVED"),
            ("mcp__server__read", {"file_path": ".saipen/STATE.md"},
             "PROTECTED_CANONICAL_NAMESPACE"),
            ("mcp__server__read", {"file_path": "src/app.py"}, "TARGET_UNRESOLVED"),
        ):
            with self.subTest(tool=tool, tool_input=tool_input):
                code, data = cli_guard(
                    GuardEventHarness.tool_event(root, tool, tool_input)
                )
                self.assertEqual(code, 1, data)
                self.assertEqual(data["code"], expected, data)

    def test_E_unknown_tool_cannot_touch_protected_canonical_state(self):
        root = fresh_project()
        code, data = cli_guard(
            GuardEventHarness.tool_event(root, "mystery_tool", {"path": ".saipen/STATE.md"})
        )
        self.assertEqual(code, 1, data)
        self.assertEqual(data["code"], "PROTECTED_CANONICAL_NAMESPACE", data)
        # And under recovery debt an ordinary-path unknown still cannot run:
        # the unclassified-effect refusal fires before the state check, so
        # the refusal code differs but the tool never executes.
        debt = recovery_debt_project()
        code, data = cli_guard(
            GuardEventHarness.tool_event(debt, "mystery_tool", {"path": "src/app.py"})
        )
        self.assertEqual(code, 1, data)
        self.assertFalse(data["admitted"], data)

    def test_F_non_saipen_project_remains_non_interfering(self):
        bare = Path(tempfile.mkdtemp())
        code, data = cli_guard(GuardEventHarness.tool_event(bare, "mystery_tool", {}))
        self.assertEqual(code, 0, data)
        self.assertEqual(data["code"], "NOT_SAIPEN_PROJECT", data)
        self.assertTrue(data["admitted"])
        self.assertFalse(data["applicable"])

    def test_G_exact_canonical_recovery_stays_usable_under_debt(self):
        root = recovery_debt_project()
        for command in ("saipen recover", "saipen recover --json", "saipen status"):
            code, data = GuardEventHarness.run(
                GuardEventHarness.tool_event(root, "bash", {"command": command})
            )
            self.assertEqual(code, 0, (command, data))
            self.assertEqual(data["event"]["action"], "saipen_op", command)
            self.assertTrue(data["admitted"], command)

    def test_H_diagnostic_reads_survive_broken_state(self):
        root = corrupt_state_project()
        for tool, tool_input in (
            ("read", {"file_path": ".saipen/STATE.md"}),
            ("read", {"file_path": "src/app.py"}),
        ):
            with self.subTest(tool=tool, tool_input=tool_input):
                code, data = GuardEventHarness.run(
                    GuardEventHarness.tool_event(root, tool, tool_input)
                )
                self.assertEqual(code, 0, data)
                self.assertTrue(data["admitted"], data)


if __name__ == "__main__":
    unittest.main()
