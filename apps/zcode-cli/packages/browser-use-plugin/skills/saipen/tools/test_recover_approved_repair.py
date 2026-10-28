"""SRC-043 / SAIPENDEFECT: autonomous canonical recovery.

The operator must never be required to hand-edit raw canonical Markdown as part
of normal recovery. This suite builds ONE legacy project carrying all four
observed defect classes at once, alongside the legal active Work that must be
resumed:

  * a malformed phase transition pair (``DONE -> BUILD``);
  * an incomplete ownership pair (``owner`` without ``claim_time``);
  * a ``## DOING`` record that was never started (no claim pair);
  * a phantom ``## DONE`` record with no verification evidence.

It then proves that a single ``recover`` collects the COMPLETE bounded repair
set, exposes ONE content-addressed plan id, and that approving that plan applies
every deterministic repair atomically -- no per-field operator round trip, no
manual edit of STATE.md/BOARD.md/LOG.md.
"""

from __future__ import annotations

import contextlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen import main as saipen_main  # noqa: E402
from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from saipen_engine.reconcile import reconcile_protocol_state  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


_TEMPS: list[tempfile.TemporaryDirectory] = []

STATE = """---
phase: BUILD
task: T-9000
next_action: "PHASE BUILD T-9000"
blocker: ""
transition_from: DONE
saipen_version: 7
schema_version: 3
last_event: 100
style_contract: ded-4ae736e4
mode: full
updated: 2026-09-15T00:00:00Z
agent: test-agent
---
"""

BOARD = """## DOING
- [/] T-9000 w | verify: resume | owner: test-agent | claim_time: 2026-09-15T00:00:00Z
- [/] T-9001 half claim | verify: half claim repaired | owner: test-agent
- [/] T-9002 unstarted doing | verify: returned to TODO
## TODO
## DONE
- [x] T-9003 phantom done | verify: reopened without evidence
## BLOCKED
"""

LOG = (
    "- 15.09.26 00:00 [E-096] [T-9000] [agent: test-agent] "
    "[op: ticket-00000000000000000000000000000000] DEC: ticket added via SAIOPS\n"
    "- 15.09.26 00:00 [E-097] [T-9001] [agent: test-agent] "
    "[op: ticket-00000000000000000000000000000001] DEC: ticket added via SAIOPS\n"
    "- 15.09.26 00:00 [E-098] [T-9002] [agent: test-agent] "
    "[op: ticket-00000000000000000000000000000002] DEC: ticket added via SAIOPS\n"
    "- 15.09.26 00:00 [E-099] [T-9003] [agent: test-agent] "
    "[op: ticket-00000000000000000000000000000003] DEC: ticket added via SAIOPS\n"
    "- 15.09.26 00:00 [E-100] [agent: test-agent] "
    "[op: transition-00000000000000000000000000000004] RUN: transition to SCOUT\n"
)


def legacy_project() -> Path:
    tmp = tempfile.TemporaryDirectory(prefix="saipen-sdefect-")
    _TEMPS.append(tmp)
    root = Path(tmp.name)
    memory = root / ".saipen"
    memory.mkdir(parents=True)
    (memory / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (memory / "STATE.md").write_text(STATE, encoding="utf-8")
    (memory / "BOARD.md").write_text(BOARD, encoding="utf-8")
    (memory / "LOG.md").write_text(LOG, encoding="utf-8")
    return root


def _board_text(root: Path) -> str:
    return (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")


def _state_text(root: Path) -> str:
    return (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")


def _section_of(board: str, ticket: str) -> str:
    return parse_board(board)["tickets"][ticket]["section"]


@contextlib.contextmanager
def _unbound_host():
    """A bound host session must not contaminate the fixture's identity."""
    keys = ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT")
    saved = {key: os.environ.pop(key, None) for key in keys}
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value


class PlanCollectionTests(unittest.TestCase):
    def test_one_dry_run_collects_the_complete_bounded_repair_set(self):
        root = legacy_project()
        plan = reconcile_protocol_state(root, "test-agent", dry_run=True)
        self.assertFalse(plan["ok"], plan)
        self.assertEqual(plan["code"], "RECONCILE_REAUTH_REQUIRED")
        self.assertRegex(plan.get("repair_id", ""), r"^[0-9a-f]{64}$")
        lifecycle = {(r["ticket"], r["kind"]) for r in plan["changed"].get("lifecycle", [])}
        self.assertIn(("T-9001", "claim-clear"), lifecycle)
        self.assertIn(("T-9001", "section-move"), lifecycle)
        self.assertIn(("T-9002", "section-move"), lifecycle)
        self.assertIn(("T-9003", "section-move"), lifecycle)
        self.assertNotIn(("T-9000", "section-move"), lifecycle)
        phase_fields = {r["field"]: (r.get("from"), r.get("to")) for r in plan["changed"]["state"]}
        self.assertEqual(phase_fields.get("phase"), ("BUILD", "SCOUT"))
        # Bare recover wrote nothing.
        self.assertEqual(_board_text(root), BOARD)
        self.assertIn("phase: BUILD", _state_text(root))

    def test_bare_recover_does_not_reopen_a_phantom_done(self):
        root = legacy_project()
        result = reconcile_protocol_state(root, "test-agent")
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "RECONCILE_REAUTH_REQUIRED")
        self.assertEqual(_board_text(root), BOARD, "bare recover mutated the board")
        self.assertIn("phase: BUILD", _state_text(root))

    def test_a_wrong_or_stale_repair_id_is_refused(self):
        root = legacy_project()
        plan = reconcile_protocol_state(root, "test-agent", dry_run=True)
        stale = "0" * 64
        self.assertNotEqual(plan["repair_id"], stale)
        result = reconcile_protocol_state(root, "test-agent", approved_repair_id=stale)
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "STALE_APPROVED_REPAIR")
        self.assertEqual(_board_text(root), BOARD)
        self.assertIn("phase: BUILD", _state_text(root))

    def test_approved_plan_applies_every_repair_atomically(self):
        root = legacy_project()
        plan = reconcile_protocol_state(root, "test-agent", dry_run=True)
        applied = reconcile_protocol_state(
            root, "test-agent", approved_repair_id=plan["repair_id"]
        )
        self.assertTrue(applied["ok"], applied)
        self.assertEqual(applied["code"], "REPAIRED")
        board = _board_text(root)
        state = _state_text(root)
        self.assertIn("phase: SCOUT", state)
        self.assertIn("transition_from: DONE", state)
        self.assertIn("task: T-9000", state)
        # The original active Work is resumed, untouched.
        self.assertEqual(_section_of(board, "T-9000"), "## DOING")
        self.assertIn("owner: test-agent", board)
        # Every malformed record normalized into a clean TODO.
        for tid in ("T-9001", "T-9002", "T-9003"):
            self.assertEqual(_section_of(board, tid), "## TODO", board)
        self.assertNotIn("claim_time:", board.split("T-9001", 1)[1])
        self.assertEqual(board.count("owner:"), 1, board)
        # One canonical recovery event, and the surface is CLEAN afterwards.
        log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertIn("reconcile protocol state", log)
        again = reconcile_protocol_state(root, "test-agent")
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["code"], "CLEAN")

    def test_cli_approved_repair_round_trip(self):
        root = legacy_project()
        plan = reconcile_protocol_state(root, "test-agent", dry_run=True)
        with _unbound_host():
            code = saipen_main(
                [
                    "recover",
                    "--apply-approved-repair",
                    plan["repair_id"],
                    "--project-root",
                    str(root),
                    "--agent",
                    "test-agent",
                    "--json",
                ]
            )
        self.assertEqual(code, 0)
        self.assertIn("phase: SCOUT", _state_text(root))
        self.assertEqual(_section_of(_board_text(root), "T-9001"), "## TODO")


def tearDownModule() -> None:
    for tmp in _TEMPS:
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
