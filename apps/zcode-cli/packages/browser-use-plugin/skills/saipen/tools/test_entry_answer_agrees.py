"""T-1378: the runtime's own answer agrees with BOOT's entry table.

Measured 2026-09-17, nine-condition field matrix. Four of nine sessions opened
with `saipen status --json` or `saipen continue --json` rather than the entry
command, and the answers they got were:

    status   -> next_action: "saipen continue"
    continue -> IMPROVE_AUDIT_ASSIGNMENT

A session that had just been handed a user task was pointed at `continue`, and
`continue` routed it into an improvement audit. BOOT's entry table is right --
NEW ACTIONABLE USER INPUT goes to `saipen start` -- and the runtime's answer to
the question the model actually asked did not say so. That is a protocol defect,
not a model one: the session asked the project what to do and the project
answered something else.

The project can only know a task exists when something declares it
(REQUEST-PROVENANCE-01's carrier). When one does and no receipt here holds those
bytes, both diagnostics name the entry command.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import operator_task  # noqa: E402
from saipen_engine.pending_ingress import ingress_digest  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import PYTHON, healthy  # noqa: E402

TASK = "add a one-line docstring to the top of src/app.py"


def setUpModule() -> None:
    isolate_host_session()


def run(root: Path, *command: str, **carrier):
    env = {**os.environ}
    for key in (
        "SAIPEN_PROJECT_ROOT",
        "SAIPEN_PROJECT_LINEAGE",
        "SAIPEN_AGENT",
        operator_task.ENV_TASK_SHA256,
        operator_task.ENV_TASK_FILE,
    ):
        env.pop(key, None)
    env.update({k: v for k, v in carrier.items() if v is not None})
    proc = subprocess.run(
        [
            PYTHON,
            str(REPO / "tools" / "saipen.py"),
            *command,
            "--project-root",
            str(root),
            "--agent",
            "test-agent",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        env=env,
    )
    try:
        return json.loads(proc.stdout)
    except ValueError:
        return {"_raw": proc.stdout + proc.stderr}


class BothDiagnosticsNameTheEntryCommandTests(unittest.TestCase):
    """The two questions a session asks when it does not know what to do."""

    def setUp(self):
        self.root = healthy(self)
        self.carrier = {operator_task.ENV_TASK_SHA256: ingress_digest(TASK)}

    def test_status_names_the_entry_command(self):
        answer = run(self.root, "status", "--json", **self.carrier)
        self.assertEqual(
            answer["canonical_next_command"], "saipen start '<the task you were given, one line>'"
        )
        self.assertEqual(
            answer["unstarted_operator_task"]["declared_by"], operator_task.ENV_TASK_SHA256
        )
        self.assertIn("entry table", answer["entry_hint"])

    def test_continue_names_it_too_instead_of_an_improvement_audit(self):
        answer = run(self.root, "continue", "--json", **self.carrier)
        self.assertEqual(
            answer["canonical_next_command"], "saipen start '<the task you were given, one line>'"
        )

    def test_a_task_file_carrier_names_the_file_transport(self):
        task_file = self.root / "launched-task.txt"
        task_file.write_text(TASK, encoding="utf-8")
        answer = run(
            self.root, "status", "--json", **{operator_task.ENV_TASK_FILE: str(task_file)}
        )
        self.assertEqual(
            answer["canonical_next_command"], f'saipen start --file "{task_file}"'
        )


class TheHintGoesQuietWhenItShouldTests(unittest.TestCase):
    """A hint that never stops is noise, and noise is ignored."""

    def test_after_the_task_is_started_neither_diagnostic_hints(self):
        root = healthy(self)
        carrier = {operator_task.ENV_TASK_SHA256: ingress_digest(TASK)}
        started = run(root, "start", TASK, "--json", **carrier)
        self.assertEqual(started["code"], "STARTED", started)
        for command in ("status", "continue"):
            answer = run(root, command, "--json", **carrier)
            self.assertIsNone(answer.get("entry_hint"), answer)
            self.assertIsNone(answer.get("unstarted_operator_task"), answer)

    def test_a_session_with_no_declared_task_is_untouched(self):
        """Most sessions declare nothing, and they must read exactly as before."""
        root = healthy(self)
        for command in ("status", "continue"):
            answer = run(root, command, "--json")
            self.assertIsNone(answer.get("entry_hint"), answer)
            self.assertIsNone(answer.get("unstarted_operator_task"), answer)

    def test_a_refusal_is_not_decorated(self):
        root = healthy(self)
        answer = run(
            root,
            "status",
            "surplus",
            "--json",
            **{operator_task.ENV_TASK_SHA256: ingress_digest(TASK)},
        )
        self.assertFalse(answer["ok"])
        self.assertEqual(answer["canonical_next_command"], "saipen status")
        self.assertIsNone(answer.get("entry_hint"), answer)


class UnstartedReadsTheLedgerTests(unittest.TestCase):
    """What counts as "this project has taken the task" is read, not assumed."""

    def test_no_carrier_is_none(self):
        root = healthy(self)
        self.assertIsNone(operator_task.unstarted(root, {}))

    def test_a_broken_carrier_hints_nothing(self):
        """A carrier error is the ingress's business, not the diagnostic's."""
        root = healthy(self)
        self.assertIsNone(
            operator_task.unstarted(root, {operator_task.ENV_TASK_SHA256: "nonsense"})
        )

    def test_a_receipt_with_another_digest_does_not_silence_the_hint(self):
        root = healthy(self)
        run(root, "start", "a completely different request", "--json")
        found = operator_task.unstarted(
            root, {operator_task.ENV_TASK_SHA256: ingress_digest(TASK)}
        )
        self.assertIsNotNone(found)
        self.assertEqual(found["digest"], ingress_digest(TASK))


if __name__ == "__main__":
    unittest.main()
