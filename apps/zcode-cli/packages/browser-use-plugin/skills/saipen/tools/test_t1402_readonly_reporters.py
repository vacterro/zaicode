"""T-1402: harmless reporters are reads, setters are not, and the rest are told why.

Measured 2026-09-19: whoami, hostname, Get-Location and Get-Date fell to
action=shell and NO_ACTIVE_WORK in an idle DONE project while echo and
git rev-parse were admitted. Those four were later admitted -- `hostname` with
ANY argument, so `hostname NAME` (sets the host name) read as a probe. Measured
2026-09-23: `date` and `uname -a` were still refused with "consequential
mutation requires exactly one active DOING Work", a sentence about a mutation
the command never makes.

Controls: common reporters are admitted with no Work; a reporter's SETTING
form is not a read; a line outside the closed set gets a refusal that names
the rule that classified it and what runs without Work.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import healthy  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


def verdict(root: Path, command: str) -> dict:
    return guard_events.evaluate_event(
        {
            "event": "PreToolUse",
            "host": "opencode",
            "tool_name": "bash",
            "tool_input": {"command": command},
            "cwd": str(root),
            "actor": "test-agent",
        },
        project_root=str(root),
    )


class ReportersAreReadsTests(unittest.TestCase):
    def test_common_reporters_run_in_an_idle_project(self):
        root = healthy(self)
        for command in (
            "whoami",
            "hostname",
            "hostname -f",
            "Get-Location",
            "Get-Date",
            "date",
            "date -u",
            "uname -a",
            "id",
            "ps aux",
            "tasklist",
            "Get-Process",
            "ver",
        ):
            with self.subTest(command=command):
                self.assertTrue(verdict(root, command)["admitted"], command)


class SettersAreNotReadsTests(unittest.TestCase):
    def test_the_setting_form_of_a_reporter_is_not_a_probe(self):
        for command in (
            "hostname evil-name",
            "hostname -F /etc/hostname.new",
            "date -s 2020-01-01",
            "date --set=2020-01-01",
            "date 010100002020",
        ):
            with self.subTest(command=command):
                self.assertFalse(guard_events.provably_read_only_shell(command), command)

    def test_a_setter_in_an_idle_project_is_refused(self):
        root = healthy(self)
        answer = verdict(root, "hostname evil-name")
        self.assertFalse(answer["admitted"], answer)
        self.assertEqual(answer["code"], "NO_ACTIVE_WORK")


class TheRefusalSaysWhyTests(unittest.TestCase):
    def test_an_unclassified_line_is_told_which_rule_classified_it(self):
        root = healthy(self)
        answer = verdict(root, "systeminfo")
        self.assertFalse(answer["admitted"], answer)
        self.assertEqual(answer["code"], "NO_ACTIVE_WORK")
        self.assertIn("outside the closed read-only probe set", answer["detail"])
        self.assertIn("Read-only probes run without Work", answer["detail"])
        self.assertEqual(answer["canonical_next_command"], "saipen start '<the task, one line>'")


if __name__ == "__main__":
    unittest.main()
