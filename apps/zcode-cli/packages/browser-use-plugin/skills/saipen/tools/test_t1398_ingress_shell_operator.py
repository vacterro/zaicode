"""T-1398: shell control operators are transport syntax, not request content.

The measured incident (SAI-DEFECT-20260918-ingress-shell-operator-as-request,
reproduced end-to-end during T-1394 triage on 2026-09-19): a line like
``saipen start 2>&1`` handed the guard's ingress extraction everything after
the verb, so the redirect itself became the request text. The refusal then
named ``saipen start --hex 323e2631`` -- the utf-8 of ``2>&1`` -- and running
that transport minted a real ticket titled ``2>&1`` with ``user_explicit: true``
and a matching intake receipt. Shell punctuation bought operator authority.

A shell never passes those bytes to the program: it consumes them as transport
syntax and executes a bare ``saipen start``. The protocol must agree with the
shell: an operator-only payload is not a request, never names a transport, and
can never be captured as request bytes through any ingress door -- plain text,
``--hex``, ``--file`` or ``user-request``.
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
from test_t1363_zero_manual_entry import cli, healthy, receipts_of  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


#: The exact lines the incident measured. Each is a bare ingress verb followed
#: by nothing but shell control syntax.
OPERATOR_ONLY_LINES = [
    "saipen start 2>&1",
    "saipen start > out.txt",
    "saipen start 2> err.txt",
    "saipen start 2>/dev/null",
    "saipen start | cat",
    "saipen user-request 2>&1",
]

HEX_OF_OPERATOR = "323e2631"  # utf-8 hex of "2>&1"
REAL_TASK = "fix the login fastpath so a fresh session resumes cleanly"
HEX_OF_REAL_TASK = REAL_TASK.encode("utf-8").hex()


class PureShellControlClassifierTests(unittest.TestCase):
    """The predicate itself: operator-only text, and what must stay a request."""

    def test_operator_only_shapes_are_control(self) -> None:
        for payload in [
            "2>&1",
            "1>&2",
            ">&2",
            "> out.txt",
            ">> out.txt",
            "2> err.txt",
            "2>> err.txt",
            "2>/dev/null",
            ">/dev/null",
            "| cat",
            "| cat > x",
            "&",
            ";",
            "|",
        ]:
            self.assertTrue(
                guard_events.shell_control_expression(payload), repr(payload)
            )

    def test_real_requests_are_not_control(self) -> None:
        for payload in [
            REAL_TASK,
            "2",
            "status",
            "add > symbol to the docs page",
            "fix login | cat",  # mixed content: operator bytes ride INSIDE a real request
            "sort the 2>&1 examples out of the README",
            "",
            "   ",
        ]:
            self.assertFalse(
                guard_events.shell_control_expression(payload), repr(payload)
            )


class GuardExtractionTests(unittest.TestCase):
    """(1) The extraction layer: an operator-only line has NO request and
    therefore no transport to name."""

    def test_required_lines_never_name_a_transport(self) -> None:
        for line in OPERATOR_ONLY_LINES:
            self.assertIsNone(guard_events.ingress_payload(line), repr(line))
            self.assertIsNone(guard_events.ingress_rewrite(line), repr(line))

    def test_quoted_operator_only_payload_is_not_admitted(self) -> None:
        self.assertIsNone(guard_events._saipen_cli_tokens("saipen start '2>&1'"))

    def test_quoted_real_payload_still_travels(self) -> None:
        tokens = guard_events._saipen_cli_tokens("saipen start 'fix the login bug'")
        self.assertEqual(
            tokens, ["saipen", "start", "fix the login bug"]
        )

    def test_plain_extraction_is_unchanged_for_real_requests(self) -> None:
        self.assertEqual(
            guard_events.ingress_payload("saipen start " + REAL_TASK), REAL_TASK
        )
        self.assertEqual(
            guard_events.ingress_rewrite("saipen start " + REAL_TASK),
            "saipen start --hex " + HEX_OF_REAL_TASK,
        )


class GuardVerdictTests(unittest.TestCase):
    """(2) The whole-line verdict: the shell line classifies as an ordinary
    shell effect, not as an ingress with a transport obligation."""

    def _event(self, command: str, root: Path) -> dict:
        return {
            "event": "PreToolUse",
            "host": "opencode",
            "tool_name": "bash",
            "tool_input": {"command": command},
            "cwd": str(root),
            "actor": "test-agent",
        }

    def test_operator_line_is_an_ordinary_shell_effect(self) -> None:
        root = healthy(self)
        verdict = guard_events.evaluate_event(
            self._event("saipen start 2>&1", root), project_root=str(root)
        )
        self.assertFalse(verdict.get("admitted"))
        self.assertNotEqual(verdict.get("code"), "INGRESS_TRANSPORT_UNSAFE")
        # The route may be the ordinary entry command (T-1377 names it for
        # every no-active-work refusal); it must NOT be a transport computed
        # over the operator bytes.
        self.assertNotIn("--hex", str(verdict.get("canonical_next_command")))


class IngressMintRefusedTests(unittest.TestCase):
    """(3) The engine doors: operator-only bytes can never be captured as a
    request, whatever transport carries them in."""

    def test_start_hex_of_operator_bytes_is_refused_and_mints_nothing(self) -> None:
        root = healthy(self)
        _rc, out, _raw = cli(root, "start", "--hex", HEX_OF_OPERATOR, "--json")
        self.assertEqual(out.get("code"), "INGRESS_SHELL_CONTROL", out)
        self.assertFalse(out.get("ok"))
        self.assertEqual(receipts_of(root), [])
        board = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertNotIn("2>&1", board)

    def test_start_plain_operator_text_is_refused(self) -> None:
        root = healthy(self)
        _rc, out, _raw = cli(root, "start", "2>&1", "--json")
        self.assertEqual(out.get("code"), "INGRESS_SHELL_CONTROL", out)
        self.assertEqual(receipts_of(root), [])

    def test_start_file_carried_operator_text_is_refused(self) -> None:
        root = healthy(self)
        task_file = root / "operator-task.txt"
        task_file.write_text("2>&1", encoding="utf-8")
        _rc, out, _raw = cli(root, "start", "--file", str(task_file), "--json")
        self.assertEqual(out.get("code"), "INGRESS_SHELL_CONTROL", out)
        self.assertEqual(receipts_of(root), [])

    def test_user_request_operator_text_is_refused(self) -> None:
        root = healthy(self)
        _rc, out, _raw = cli(root, "user-request", "2>&1", "--json")
        self.assertEqual(out.get("code"), "INGRESS_SHELL_CONTROL", out)
        self.assertEqual(receipts_of(root), [])


class LegitimateTransportsPreservedTests(unittest.TestCase):
    """(4) Everything the incident did not complain about keeps working."""

    def test_plain_real_task_still_starts(self) -> None:
        root = healthy(self)
        _rc, out, _raw = cli(root, "start", REAL_TASK, "--json")
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(len(receipts_of(root)), 1)

    def test_hex_real_task_still_starts(self) -> None:
        root = healthy(self)
        _rc, out, _raw = cli(root, "start", "--hex", HEX_OF_REAL_TASK, "--json")
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(len(receipts_of(root)), 1)

    def test_file_real_task_still_starts(self) -> None:
        root = healthy(self)
        task_file = root / "real-task.txt"
        task_file.write_text(REAL_TASK, encoding="utf-8")
        _rc, out, _raw = cli(root, "start", "--file", str(task_file), "--json")
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(len(receipts_of(root)), 1)


if __name__ == "__main__":
    unittest.main()
