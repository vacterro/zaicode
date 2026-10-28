"""T-1386: a canonical command's own grammar decides where its payload begins.

Field defect measured on b374ef1f (windows_path_task, SRC-057 section 2): a
canonical checkpoint whose evidence prose mentioned `.saipen` was judged an
ordinary shell line, `_PROTECTED_SHELL_SEGMENT` matched the prose, and the
session reworded the SAME operation twice and was refused each time
(VERDICT.md: SEQUENTIAL_REWORDED_RETRY x2). The same line without the
namespace was admitted as an ordinary shell effect -- one question, two
answers, and no answer that said the prose itself was the trigger.

These controls pin the structural rule: CANONICAL COMMAND STRUCTURE DEFINES
EFFECT; quoted literal payload bytes are DATA. Shell syntax OUTSIDE the
payload still disqualifies the whole line, the closed stderr redirect set
transports nothing, and the T-1398 ingress contract is untouched.

The three exact field attempts below are the ones recorded in
`pcn-causality.json`; the second and third rewordings are what the session
needed when nothing told it the prose was the trigger.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events  # noqa: E402
from saipen_engine.board import HOST_SESSION_ENV  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402

SAIPEN = TOOLS / "saipen.py"
SESSION = "ses_t1386_probe"

#: The exact lines from the field's windows_path_task session, byte for byte.
FIELD_LINES = (
    "saipen checkpoint RUN T-1 'review -> independent re-run PASS conf: high -- "
    "ast docstring == launch ledger 5b0e334229a3; diff limited to src/app.py + "
    ".saipen memory; no P0/P1. DEC: SHIP' --project-root "
    '"V:\\_TEMP_\\t1363-q_02iu_z" 2>&1',
    "saipen checkpoint RUN T-1 'review -> independent re-run PASS conf: high -- "
    "ast docstring == launch ledger 5b0e334229a3; diff limited to src/app.py and "
    ".saipen memory; no P0/P1 findings' --project-root "
    '"V:\\_TEMP_\\t1363-q_02iu_z" 2>&1',
    "saipen checkpoint RUN T-1 'review -> independent re-run passed conf: high -- "
    "ast.get_docstring(app.py) equals MODULE_PURPOSE value; diff confined to "
    "src/app.py and .saipen memory; no P0/P1 findings' --project-root "
    '"V:\\_TEMP_\\t1363-q_02iu_z"',
)


def setUpModule() -> None:
    isolate_host_session()


def _event(command: str, cwd: Path | None = None) -> dict:
    return {
        "event": "before_tool",
        "host": "opencode",
        "cwd": str(cwd or Path.cwd()),
        "tool_name": "bash",
        "tool_input": {"command": command},
        "session_id": SESSION,
    }


def _mapped(command: str) -> dict:
    return guard_events.map_event(guard_events.load_event(json.dumps(_event(command))))


def _verdict(project: Path, command: str) -> dict:
    event = _event(command, cwd=project)
    return guard_events.evaluate_event(guard_events.load_event(json.dumps(event)), None)


def _started(case: unittest.TestCase, phase: str | None = None) -> Path:
    """A temp project with the field session's active claimed Work (T-1)."""
    import test_t1363_zero_manual_entry as fixtures

    project = Path(fixtures.healthy(case))
    env = {**os.environ, HOST_SESSION_ENV: SESSION}
    started = subprocess.run(
        [
            sys.executable,
            str(SAIPEN),
            "start",
            "add a docstring to src/app.py",
            "--json",
            "--project-root",
            str(project),
            "--agent",
            "test-agent",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=300,
    )
    case.assertEqual(json.loads(started.stdout or "{}").get("code"), "STARTED", started.stdout)
    if phase:
        code, _payload, text = fixtures.cli(
            project, "transition", phase, "T-1", "scout done", "--json"
        )
        case.assertEqual(code, 0, text)
    return project


class CanonicalQuotedPayloadClassificationTests(unittest.TestCase):
    """The RED control and its controls, at the classification boundary."""

    def test_the_field_checkpoint_with_the_namespace_is_a_canonical_operation(self):
        mapped = _mapped("saipen checkpoint RUN T-1 'evidence in .saipen/STATE.md'")
        self.assertEqual(mapped["action"], "saipen_op")
        self.assertEqual(mapped["saipen_verb"], "checkpoint")
        self.assertFalse(mapped["shell_protected_namespace"])

    def test_the_control_line_without_the_namespace_is_the_same_class(self):
        mapped = _mapped("saipen checkpoint RUN T-1 'evidence in the state file'")
        self.assertEqual(mapped["action"], "saipen_op")
        self.assertEqual(mapped["saipen_verb"], "checkpoint")

    def test_windows_path_and_punctuation_payloads_classify_canonical(self):
        for command in (
            r"saipen checkpoint RUN T-1 'C:\Users\vac\My Documents\notes.txt'",
            "saipen checkpoint RUN T-1 'test: a, b; c!'",
            "saipen checkpoint RUN T-1 '.saipen/evidence/foo'",
            'saipen checkpoint RUN T-1 "V:\\path with spaces\\file.txt"',
        ):
            with self.subTest(command=command):
                mapped = _mapped(command)
                self.assertEqual(mapped["action"], "saipen_op", command)

    def test_the_actual_field_rewordings_classify_canonical(self):
        for command in FIELD_LINES:
            with self.subTest(command=command[:70]):
                mapped = _mapped(command)
                self.assertEqual(mapped["action"], "saipen_op")
                self.assertEqual(mapped["saipen_verb"], "checkpoint")

    def test_payload_bytes_survive_classification_exactly(self):
        command = "saipen checkpoint RUN T-1 'evidence in .saipen/STATE.md'"
        self.assertEqual(
            guard_events._saipen_cli_tokens(command),
            ["saipen", "checkpoint", "RUN", "T-1", "evidence in .saipen/STATE.md"],
        )

    def test_operator_shaped_evidence_is_data_for_a_checkpoint(self):
        """T-1398 governs the REQUEST grammar; evidence prose is not a request."""
        for payload in ("2>&1", "observed 2>&1 in evidence", "cmd | cat failed"):
            with self.subTest(payload=payload):
                mapped = _mapped(f"saipen checkpoint RUN T-1 '{payload}'")
                self.assertEqual(mapped["action"], "saipen_op", payload)

    def test_other_shell_canonical_verbs_admit_their_payload(self):
        for command, verb in (
            ("saipen goal 'fix the login bug'", "goal"),
            ("saipen knowledge retrieve 'guard classification owner'", "knowledge"),
            ("saipen checkpoint RUN T-1 'first region' 'second region'", "checkpoint"),
        ):
            with self.subTest(command=command):
                mapped = _mapped(command)
                self.assertEqual(mapped["action"], "saipen_op", command)
                self.assertEqual(mapped["saipen_verb"], verb, command)

    def test_safe_stderr_redirects_transport_nothing(self):
        for command in (
            "saipen checkpoint RUN T-1 'evidence' 2>&1",
            "saipen checkpoint RUN T-1 'evidence' 2>/dev/null",
            "saipen checkpoint RUN T-1 'evidence' 2>$null",
        ):
            with self.subTest(command=command):
                self.assertEqual(_mapped(command)["action"], "saipen_op", command)


class HostileShellSyntaxOutsideThePayloadTests(unittest.TestCase):
    """The exemption must not swallow a real shell effect."""

    def test_tails_stay_shell_effects(self):
        for command in (
            "saipen checkpoint RUN T-1 'safe' ; rm -rf x",
            "saipen checkpoint RUN T-1 'safe' && rm x",
            "saipen checkpoint RUN T-1 'safe' | tee x",
            "saipen checkpoint RUN T-1 'safe' > out.txt",
            "saipen checkpoint RUN T-1 'safe' < in.txt",
            "saipen checkpoint RUN T-1 'safe' 2>&1 > file",
            "saipen checkpoint RUN T-1 'safe' 2>&1 && rm x",
            "saipen checkpoint RUN T-1 'a' ; 'b'",
            "saipen checkpoint RUN T-1 'safe'\nrm -rf x",
        ):
            with self.subTest(command=command):
                mapped = _mapped(command)
                self.assertNotEqual(mapped["action"], "saipen_op", command)
                self.assertEqual(mapped["action"], "shell", command)

    def test_unclosed_or_glued_quotes_stay_shell(self):
        for command in (
            "saipen checkpoint RUN T-1 'unterminated",
            "saipen checkpoint RUN T-1 'a'b",
            'saipen checkpoint RUN T-1 "a""b"',
        ):
            with self.subTest(command=command):
                self.assertNotEqual(_mapped(command)["action"], "saipen_op", command)

    def test_quoted_expansion_bytes_are_never_opaque(self):
        # Double quotes: `$` and backtick expand in bash and PowerShell.
        for command in (
            'saipen checkpoint RUN T-1 "in .saipen via $(touch x)"',
            "saipen checkpoint RUN T-1 \"in .saipen via `touch x`\"",
            'saipen checkpoint RUN T-1 "a \\" b"',
            "saipen checkpoint RUN T-1 'quote \" inside'",
            "saipen checkpoint RUN T-1 'trailing backslash\\'",
        ):
            with self.subTest(command=command):
                self.assertNotEqual(_mapped(command)["action"], "saipen_op", command)

    def test_a_wrapper_around_a_canonical_string_is_not_canonical(self):
        for command in (
            "bash -lc \"saipen checkpoint RUN T-1 'x'\"",
            "eval saipen checkpoint RUN T-1 'x'",
            "./saipen checkpoint RUN T-1 'x'",
            "SAIPEN_AGENT=x saipen checkpoint RUN T-1 'x'",
        ):
            with self.subTest(command=command):
                self.assertNotEqual(_mapped(command)["action"], "saipen_op", command)

    def test_a_real_namespace_mutation_is_still_protected(self):
        mapped = _mapped("rm -rf .saipen/STATE.md")
        self.assertEqual(mapped["action"], "shell")
        self.assertTrue(mapped["shell_protected_namespace"])


class IngressContractPreservedTests(unittest.TestCase):
    """T-1398: an operator-only ingress payload is transport, never a request."""

    def test_operator_only_ingress_payload_stays_transport(self):
        self.assertIsNone(guard_events._saipen_cli_tokens("saipen start '2>&1'"))
        self.assertNotEqual(_mapped("saipen start '2>&1'")["action"], "saipen_op")
        # Operator-only text names no transport at all (T-1398).
        self.assertIsNone(guard_events.ingress_rewrite("saipen start '2>&1'"))
        self.assertIsNone(guard_events.ingress_rewrite("saipen start 2>&1"))

    def test_an_ingress_request_still_classifies(self):
        self.assertEqual(
            guard_events._saipen_cli_tokens("saipen start 'fix the login bug'"),
            ["saipen", "start", "fix the login bug"],
        )
        self.assertEqual(
            guard_events._saipen_cli_tokens("saipen user-request 'fix the login bug'"),
            ["saipen", "user-request", "fix the login bug"],
        )
        self.assertEqual(_mapped("saipen start 'fix the login bug'")["action"], "saipen_op")

    def test_an_ingress_line_never_gets_a_second_region(self):
        for command in ("saipen start 'a' 'b'", "saipen start 'a''b'"):
            with self.subTest(command=command):
                self.assertNotEqual(_mapped(command)["action"], "saipen_op", command)


class FieldShapedRegressionTests(unittest.TestCase):
    """The T-1385 class: one canonical command, no reworded retry.

    The guard verdict is taken for each of the three field attempts in a
    session-shaped project (active claimed Work, bound host session). Before
    the repair each of them was `attempted` verbatim and refused
    PROTECTED_CANONICAL_NAMESPACE; the polygon therefore recorded
    SEQUENTIAL_REWORDED_RETRY x2. After the repair every attempt is admitted
    in one classification, so the class has no repeated refusal.
    """

    def test_the_field_class_is_admitted_without_a_reword(self):
        project = _started(self, "BUILD")
        for command in FIELD_LINES:
            with self.subTest(command=command[:70]):
                verdict = _verdict(project, command)
                self.assertTrue(verdict.get("admitted"), verdict)
                self.assertNotEqual(verdict.get("code"), "PROTECTED_CANONICAL_NAMESPACE")
                self.assertEqual(_mapped(command)["action"], "saipen_op")


if __name__ == "__main__":
    unittest.main()
