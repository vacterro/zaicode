"""T-1476: a Work must never be stranded by retiring its own source.

Measured in the T-1446 24H field gate (.saipen/evidence/T-1446-field-24h-20260922,
report.json): the soak worker ran `saipen source retire SRC-012 --reason
SUPERSEDED_SOURCE --successor SRC-001` while SRC-012 was the only source of live
Work T-25 in SHIP. Retirement checked live linkage only for ORPHANED_RECEIPT, and
a live user request carries no clause until closure, so the retire passed. The
closure gate then answered SOURCE_RECEIPT_MISSING and routed it to `saipen source
recover`, a read-only diagnostic that reported `orphans: []` and changed nothing.
Every worker generation re-ran the same route until the supervisor stopped the
run with NO_PROGRESS_LOOP at 15661 s of 86400.

Two halves, two regressions:

* retirement refuses, for every reason, while a non-DONE Work names the receipt;
* a Work already stranded that way (a pre-fix engine, a hand edit) is routed to a
  command that changes state, and following it ends the loop in bounded steps.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import intake, retirement  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_request_clause_closure import TASK, drive  # noqa: E402
from test_t1363_zero_manual_entry import cli, healthy, receipts_of  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


def _successor(root: Path) -> str:
    captured = intake.capture(root, "an unrelated later request", source_kind="user_audit")
    assert captured.get("ok"), captured
    return captured["receipt"]


class RetirementRefusesTheSourceOfLiveWorkTests(unittest.TestCase):
    def test_every_reason_refuses_while_the_work_is_live(self):
        root = healthy(self)
        code, payload, text = cli(root, "start", TASK, "--json")
        self.assertEqual(code, 0, text)
        receipt = receipts_of(root)[0]
        successor = _successor(root)
        cases = (
            ("SUPERSEDED_SOURCE", "--successor", successor),
            ("EMPTY_STALE_SOURCE",),
        )
        for reason, *extra in cases:
            with self.subTest(reason=reason):
                code, payload, text = cli(
                    root, "source", "retire", receipt, "--reason", reason, *extra, "--json"
                )
                self.assertNotEqual(code, 0, text)
                self.assertEqual(payload.get("code"), "SOURCE_RETIREMENT_NOT_ELIGIBLE", text)
                self.assertIn("live Work T-1", payload.get("detail") or payload.get("message"))
                self.assertIn(receipt, intake._read_index(root).get("active", {}))

    def test_a_done_work_does_not_hold_its_source(self):
        root = healthy(self)
        drive(self, root)
        code, _payload, text = cli(
            root, "ticket", "done", "T-1", "--closure-mode", "own_patch", "--json"
        )
        self.assertEqual(code, 0, text)
        problems = retirement.source_retirement_errors(
            root, _successor(root), reason="EMPTY_STALE_SOURCE", successor=None, note=None
        )
        self.assertFalse([item for item in problems if "live Work" in item], problems)


class AStrandedWorkIsRoutedOutTests(unittest.TestCase):
    def _stranded(self) -> tuple[Path, str]:
        """T-1 in SHIP whose only source was retired by a pre-fix engine.

        The pre-fix engine runs in a FRESH interpreter. Patching the check in
        this process worked alone and failed inside the declared family
        (E-8355): an earlier suite can leave a different module object behind
        the name `operations` imports at call time, so the patch missed.
        """
        root = healthy(self)
        drive(self, root)
        receipt = receipts_of(root)[0]
        successor = _successor(root)
        script = (
            "import sys\n"
            f"sys.path.insert(0, {str(TOOLS)!r})\n"
            "from unittest import mock\n"
            "from saipen_engine import operations, retirement\n"
            "with mock.patch.object(retirement, 'source_retirement_errors', return_value=[]):\n"
            f"    result = operations.retire_source({str(root)!r}, {receipt!r}, 'test-agent',"
            f" reason='SUPERSEDED_SOURCE', successor={successor!r})\n"
            "print(result.to_dict())\n"
            "sys.exit(0 if result.ok else 1)\n"
        )
        env = {
            key: value
            for key, value in os.environ.items()
            if key not in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT")
        }
        proc = subprocess.run(
            [sys.executable, "-B", "-c", script],
            capture_output=True,
            text=True,
            timeout=300,
            env=env,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return root, receipt

    def test_the_route_is_never_a_diagnostic_that_cannot_see_the_receipt(self):
        root, receipt = self._stranded()
        _code, recovered, text = cli(root, "source", "recover", "--json")
        self.assertNotIn(receipt, [item.get("receipt") for item in recovered["orphans"]], text)
        _code, routed, text = cli(root, "continue", "--json")
        self.assertNotEqual(routed.get("action"), "saipen source recover", text)
        self.assertTrue(str(routed.get("action")).startswith("saipen ticket block T-1 "), text)

    def test_following_the_route_ends_the_loop(self):
        """Obey every route the way a worker does; one route must never repeat."""
        root, _receipt = self._stranded()
        seen = []
        for _step in range(4):
            _code, routed, text = cli(root, "continue", "--json")
            action = str(routed.get("action") or "")
            self.assertNotIn(action, seen, f"the same route came back: {text}")
            seen.append(action)
            if action == "saipen source recover":
                code, _payload, text = cli(root, "source", "recover", "--json")
            elif action.startswith("saipen ticket block T-1 "):
                reason = action.split("T-1 ", 1)[1].strip('"')
                code, _payload, text = cli(root, "ticket", "block", "T-1", reason, "--json")
            else:
                break
            self.assertEqual(code, 0, text)
        board = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertIn("T-1 ", board.split("## BLOCKED", 1)[1])


if __name__ == "__main__":
    unittest.main()
