"""T-1358: a refusal that names no route is a dead end.

Measured live on `_PROBLIP` (lineage-1cdb1699, phase DONE, task none, agent
buffy). `reconcile._state_next_action_repairs` refuses a legacy `next_action`
whenever the phase is not ticket-bearing, and that refusal carried
`terminal_disposition: RECOVERY_BLOCKED`, which makes `_blocked_recovery_fields`
suppress the command line entirely. So `saipen recover` answered
`operator_decision_available: false` and `canonical_next_command: null`, every
phase command refused on the same field, `transition DONE -> BUILD` was
ILLEGAL, and no verb in the engine owned `next_action`. Reads worked. Nothing
else did, and nothing ever would.

Two defects, one shape:

* the refusal pre-empted the BOARD findings in the same run and reported them
  as an empty list, so the operator could not even see what else was wrong;
* the field had no operator gate at all, while `blocker` -- the field beside it
  -- has had one for exactly this reason.

`saipen recover resolve-next-action <next-action>` is that gate, built to the
same shape: the operator decides the VALUE, the engine still checks it against
the executable grammar, the original bytes are archived, and the DEC names the
field and the authority.
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

from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from saipen_engine.reconcile import reconcile_protocol_state  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402

HOME = TOOLS.parent


def setUpModule() -> None:
    isolate_host_session()


#: The measured field shape: phase DONE, task none, a free-text next_action.
LEGACY_NEXT_ACTION = "BOARD empty; producer packages SAIT-002 + W-002 ready - collect with eee"
STATE = """---
phase: DONE
task: none
next_action: "{next_action}"
blocker: ""
transition_from: SHIP
saipen_version: 8
schema_version: 3
last_event: 45
style_contract: ded-4ae736e4
saipen_home: "{home}"
agent: buffy
mode: full
updated: "2026-09-15T00:00:00Z"
---
"""
BOARD = "## DOING\n## TODO\n- [ ] T-9 [P1] real todo | verify: x\n## DONE\n## BLOCKED\n"
LOG = (
    "- 12.09.26 00:00 [E-44] [T-9] [agent: buffy] [op: ticket-fixture] "
    "DEC: ticket added via SAIOPS\n"
    "- 15.09.26 00:00 [E-45] [agent: buffy] RUN: ccc converge\n"
)


def project(base: Path, next_action: str = LEGACY_NEXT_ACTION) -> Path:
    root = base / "problip"
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "STATE.md").write_text(
        STATE.format(next_action=next_action, home=HOME.as_posix()), encoding="utf-8"
    )
    (saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")
    (saipen / "LOG.md").write_text(LOG, encoding="utf-8")
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    return root


class NextActionDeadlockTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1358-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()

    def cli(self, root: Path, *argv: str) -> dict:
        completed = subprocess.run(
            [sys.executable, str(TOOLS / "saipen.py"), "--project-root", str(root),
             *argv, "--json"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=hermetic_env(), timeout=600,
        )
        try:
            return json.loads(completed.stdout)
        except ValueError:  # pragma: no cover - a crash is its own failure
            raise AssertionError(
                f"{argv} produced no record (rc={completed.returncode})\n"
                f"{completed.stdout[-600:]}\n{completed.stderr[-600:]}"
            ) from None

    def next_action(self, root: Path) -> str:
        for line in (root / ".saipen" / "STATE.md").read_text(encoding="utf-8").splitlines():
            if line.startswith("next_action:"):
                return line
        raise AssertionError("STATE carries no next_action")

    def test_the_fixture_really_is_the_deadlock(self) -> None:
        """Guard: the router must genuinely be unable to project this."""
        root = project(self.base)
        record = reconcile_protocol_state(root, "buffy", dry_run=True)
        refused = [r for r in record.get("changed", {}).get("state", []) if r.get("refuse")]
        self.assertTrue(refused, record)
        self.assertEqual(refused[0]["field"], "next_action", refused)

    def test_the_refusal_names_a_route(self) -> None:
        root = project(self.base)
        record = self.cli(root, "recover")
        self.assertFalse(record.get("ok"), record)
        self.assertTrue(
            record.get("operator_decision_available"),
            f"a refusal with no exit is a dead end, not a gate: {record}",
        )
        self.assertEqual(
            record.get("canonical_next_command"),
            "saipen recover resolve-next-action <next-action>",
            record,
        )

    def test_the_named_route_runs_from_the_state_that_names_it(self) -> None:
        root = project(self.base)
        named = self.cli(root, "recover")["canonical_next_command"]
        self.assertTrue(named.startswith("saipen recover resolve-next-action"))
        repaired = self.cli(root, "recover", "resolve-next-action", "saipen", "continue")
        self.assertTrue(repaired.get("ok"), repaired)
        self.assertIn('next_action: "saipen continue"', self.next_action(root))
        self.assertTrue(self.cli(root, "validate").get("ok"))

    def test_the_operator_decides_the_value_not_the_grammar(self) -> None:
        root = project(self.base)
        refused = self.cli(root, "recover", "resolve-next-action", "just", "some", "prose")
        self.assertFalse(refused.get("ok"), refused)
        self.assertIn(
            LEGACY_NEXT_ACTION,
            self.next_action(root),
            "a refused decision must leave the original value standing",
        )

    def test_the_decision_is_recorded_against_its_own_field(self) -> None:
        """The DEC used to say `STATE.blocker clear` whatever was authorized."""
        root = project(self.base)
        self.cli(root, "recover", "resolve-next-action", "saipen", "continue")
        tail = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8").strip().splitlines()[-1]
        self.assertIn("operator-authorized STATE.next_action", tail)
        self.assertNotIn("STATE.blocker", tail)

    def test_a_wait_value_with_its_separator_is_suppliable(self) -> None:
        """`WAIT: <category> -- <text>` is the canonical WAIT grammar.

        The decision loop used to stop at any token starting with two dashes,
        so the separator ended the decision and the rest of the line fell
        through as unknown arguments -- the one shape a blocked project is most
        likely to need could not be supplied at all. A bare `--` belongs to the
        decision; only a real `--flag` ends it.

        Global flags go BEFORE the decision, because that bare separator also
        ends the CLI's own flag parsing.
        """
        root = project(self.base)
        completed = subprocess.run(
            [sys.executable, str(TOOLS / "saipen.py"), "--json", "--project-root", str(root),
             "recover", "resolve-next-action", "WAIT:", "blocked", "--", "waiting"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=hermetic_env(), timeout=600,
        )
        record = json.loads(completed.stdout)
        self.assertTrue(record.get("ok"), record)
        self.assertIn('next_action: "WAIT: blocked -- waiting"', self.next_action(root))

    def test_an_empty_decision_refuses(self) -> None:
        root = project(self.base)
        record = self.cli(root, "recover", "resolve-next-action")
        self.assertFalse(record.get("ok"), record)
        self.assertIn(LEGACY_NEXT_ACTION, self.next_action(root))

    def test_the_route_is_reachable_through_the_guard(self) -> None:
        """A printed command the guard refuses is not a route (T-1357)."""
        from saipen_engine.guard_events import _saipen_cli_verb

        self.assertEqual(
            _saipen_cli_verb("saipen recover resolve-next-action saipen continue"),
            "recover",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
