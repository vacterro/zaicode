"""A live foreign seat must not hand a session its own last command (T-1397).

The T-1367 field matrix (2026-09-19, sairoute/SAIFREN) measured a session do
exactly what the refusal told it -- run `saipen start --receipt SRC-001` --
and receive a byte-identical WAIT_FOREIGN_OWNER with the identical `then:`
line. Compliance was a fixed point: the only executable route re-issued
itself.

These controls pin both halves of the repair on a fixture with a live
foreign owner:

  - a plain-text ingress is STILL told to resume by receipt (that route is
    real progress: the request becomes durable and the form is exact);
  - a receipt-form ingress gets a TERMINAL refusal -- no `then:` line at
    all, and a detail that says the request is already queued and the
    caller stops -- so the sequence can never repeat with nothing changed.

Run standalone:
    python tools/test_foreign_owner_terminal_route.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_t1363_zero_manual_entry as fixtures
from saipen_engine.paths import unbound_environment

SAIPEN = Path(__file__).resolve().parent / "saipen.py"
OTHER = "ses_second_window"
TASK = "add a trailing comment"


def _start(project: Path, *extra: str) -> dict:
    done = subprocess.run(
        [sys.executable, str(SAIPEN), "start", *extra, "--json"],
        cwd=str(project),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=unbound_environment(SAIPEN_HOST_SESSION=OTHER),
        timeout=300,
    )
    return json.loads(done.stdout or "{}")


class ForeignOwnerTerminalRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(fixtures.foreign_owner_project(self))

    def test_plain_text_ingress_still_gets_the_receipt_route(self) -> None:
        first = _start(self.project, TASK)
        self.assertEqual(first.get("code"), "WAIT_FOREIGN_OWNER")
        receipt = first.get("receipt")
        self.assertTrue(str(receipt).startswith("SRC-"), first)
        self.assertEqual(first.get("resume_command"), f"saipen start --receipt {receipt}")

    def test_receipt_form_ingress_is_terminal_not_a_fixed_point(self) -> None:
        first = _start(self.project, TASK)
        receipt = first["receipt"]
        second = _start(self.project, "--receipt", receipt)
        self.assertEqual(second.get("code"), "WAIT_FOREIGN_OWNER")
        # The half the field measured: no re-handed command to a caller that
        # already ran it, and a detail that names the queue and the stop.
        self.assertIsNone(second.get("resume_command"), second)
        self.assertIn("already queued", str(second.get("detail")))
        self.assertIn("stop here", str(second.get("detail")))

    def test_the_two_answers_are_not_identical(self) -> None:
        first = _start(self.project, TASK)
        second = _start(self.project, "--receipt", first["receipt"])
        self.assertNotEqual(first.get("detail"), second.get("detail"))
        self.assertNotEqual(first.get("resume_command"), second.get("resume_command"))

    def test_the_owner_is_still_exactly_where_it_was(self) -> None:
        _start(self.project, TASK)
        doing = [
            line
            for line in (self.project / ".saipen" / "BOARD.md")
            .read_text(encoding="utf-8")
            .splitlines()
            if line.startswith("- [/] ")
        ]
        self.assertEqual(len(doing), 1)
        self.assertIn("T-9200", doing[0])
        self.assertIn("owner: codex", doing[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
