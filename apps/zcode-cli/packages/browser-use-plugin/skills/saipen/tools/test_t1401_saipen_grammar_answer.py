"""T-1401: documented canonical lines are admitted, and a broken one is told why.

Measured 2026-09-19: the documented `saipen improve sweep ... --json` line was
13 tokens against a 12-token bound, and `permissions`/`explain-next` were
DIAGNOSTIC yet refused, so an idle DONE project answered NO_ACTIVE_WORK. Those
were later repaired (bound 24, both verbs canonical); these controls pin them.
Still open on 2026-09-23: a line that starts with `saipen` but is outside the
grammar -- a typo, shell syntax around it -- was judged an ordinary shell effect
and told "consequential mutation requires exactly one active DOING Work", a
rule about something it never tried. It now gets a grammar diagnostic and, for
a near-miss verb, the corrected command.
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


class DocumentedLinesTests(unittest.TestCase):
    def test_documented_lines_are_canonical_in_an_idle_project(self):
        root = healthy(self)
        for command in (
            "saipen improve sweep CYCLE-1 RUN-1/IMP-001 CONFIRMED --ticket T-1 --json",
            "saipen permissions --json",
            "saipen explain-next --json",
        ):
            with self.subTest(command=command):
                answer = verdict(root, command)
                self.assertTrue(answer["admitted"], answer)


class GrammarAnswerTests(unittest.TestCase):
    def test_a_near_miss_verb_gets_the_corrected_command(self):
        root = healthy(self)
        answer = verdict(root, "saipen statuz --json")
        self.assertFalse(answer["admitted"], answer)
        self.assertIn("'statuz' is not a verb", answer["detail"])
        self.assertEqual(answer["canonical_next_command"], "saipen status --json")

    def test_a_correction_never_carries_the_shell_tail(self):
        """REVIEW finding: the correction was built from the whole line, so a
        typo in front of shell syntax came back as a destructive route."""
        root = healthy(self)
        for command, tail in (
            ("saipen statuz && rm -rf src", "rm -rf"),
            ("saipen statuz | tee out.txt", "tee"),
        ):
            with self.subTest(command=command):
                answer = verdict(root, command)
                self.assertFalse(answer["admitted"], answer)
                self.assertIn("did you mean `saipen status`", answer["detail"])
                route = answer.get("canonical_next_command") or ""
                self.assertNotIn(tail, route, answer)
                self.assertFalse(route.startswith("saipen status"), answer)

    def test_an_unknown_verb_is_sent_to_the_grammar(self):
        root = healthy(self)
        answer = verdict(root, "saipen frobnicate")
        self.assertIn("'frobnicate' is not a verb", answer["detail"])
        self.assertEqual(answer["canonical_next_command"], "saipen --help")
        self.assertTrue(verdict(root, "saipen --help")["admitted"])

    def test_shell_syntax_around_a_saipen_command_says_so(self):
        root = healthy(self)
        answer = verdict(root, "saipen status && rm -rf src")
        self.assertFalse(answer["admitted"], answer)
        self.assertIn("not ONE canonical operation", answer["detail"])

    def test_an_ordinary_shell_line_gets_no_saipen_grammar_text(self):
        root = healthy(self)
        answer = verdict(root, "echo hi > note.txt")
        self.assertNotIn("canonical SAIPEN operation", answer["detail"])
        self.assertIsNone(guard_events.saipen_line_problem("echo hi"))
        self.assertIsNone(guard_events.saipen_line_problem("saipen status --json"))


if __name__ == "__main__":
    unittest.main()
