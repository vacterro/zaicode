"""T-1474: a request `start` projects as NEW Work is a GOAL-01 Entry.

MAINTENANCE 2.4 makes any actionable request an Entry: `execution_intent:
goal`, `goal_waves: 0`, `goal_tickets: 0`. `start` reset the counters only for
a TRIPPED valve, so a new objective inherited the previous run's spend --
measured 2026-09-22 (E-8289..E-8299): SRC-107 (/goal) arrived at 1 wave / 18
tickets and would have tripped after two VERIFY passes, while the same request
at 20 got a full budget. E-8299 applied the Entry by hand.

Controls: new Work starts its run at 0 with a countable pivot line; an echo
bound to existing Work (T-1469) is not a new objective and touches nothing; a
tripped valve is still reauthorized. The previous run's spend is written into
the LOG as real increments, because reconciliation rebuilds the counters from
the LOG (CORE 1.5) and repairs a hand-set STATE value back to it.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import codec  # noqa: E402
from saipen_engine.state import parse_state  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import cli, project, valve_project  # noqa: E402

TASK = "add a one-line docstring to the top of src/app.py"


def setUpModule() -> None:
    isolate_host_session()


def spent_log(waves: int, tickets: int) -> str:
    """A LOG whose previous run really spent `waves`/`tickets` of its budget."""
    lines = [
        "# Log",
        "- 14.09.26 00:00 [E-0001] [agent: test-agent] "
        "[op: transition-" + "a" * 32 + "] RUN: transition to SCOUT",
    ]
    texts = ["goal pivot -- the previous objective"]
    texts += [f"goal_waves {n}->{n + 1}" for n in range(waves)]
    texts += [f"goal_tickets {n}->{n + 1}" for n in range(tickets)]
    for index, text in enumerate(texts, start=2):
        lines.append(
            f"- 14.09.26 00:{index:02d} [E-{index:04d}] [parent: E-{index - 1:04d}] "
            f"[agent: test-agent] [op: checkpoint-{index:032d}] DEC: {text}"
        )
    return "\n".join(lines) + "\n"


def spent_project(case: unittest.TestCase, intent: str, waves: int, tickets: int) -> Path:
    return project(
        case,
        log=spent_log(waves, tickets),
        execution_intent=intent,
        goal_waves=waves,
        goal_tickets=tickets,
    )


def state_of(root: Path) -> dict:
    return parse_state(codec.read_doc(root / ".saipen" / "STATE.md"))


def log_of(root: Path) -> str:
    return (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")


def counters(state: dict) -> tuple:
    return (
        state.get("execution_intent"),
        int(state.get("goal_waves") or 0),
        int(state.get("goal_tickets") or 0),
    )


class FixtureTests(unittest.TestCase):
    def test_the_spent_budget_survives_reconciliation(self):
        """Guard: without this the Entry tests would pass on a reset they never caused."""
        root = spent_project(self, "goal", 1, 18)
        code, _payload, text = cli(root, "status", "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(counters(state_of(root)), ("goal", 1, 18))


class NewWorkIsAnEntryTests(unittest.TestCase):
    def test_new_work_starts_its_run_at_zero_with_a_pivot_line(self):
        root = spent_project(self, "goal", 1, 18)
        code, payload, text = cli(root, "start", TASK, "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(payload["code"], "STARTED", text)
        self.assertEqual(counters(state_of(root)), ("goal", 0, 0))
        ticket = payload["ticket"]
        self.assertIn(f"DEC: goal pivot -- {ticket} ({payload['receipt']}): {TASK}", log_of(root))

    def test_a_project_with_no_intent_enters_goal(self):
        root = project(self)
        self.assertNotEqual(state_of(root).get("execution_intent"), "goal")
        code, payload, text = cli(root, "start", TASK, "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(counters(state_of(root)), ("goal", 0, 0))
        self.assertIn(f"DEC: goal pivot -- {payload['ticket']}", log_of(root))


class NotAnEntryTests(unittest.TestCase):
    def test_an_echo_of_existing_work_touches_no_counter(self):
        root = spent_project(self, "goal", 1, 5)
        code, first, text = cli(root, "start", TASK, "--json")
        self.assertEqual(code, 0, text)
        # The new run spends some of its own budget; reconciliation (inside the
        # next start) rebuilds STATE's counters from these LOG increments.
        for step in ("goal_waves 0->1", "goal_tickets 0->1", "goal_tickets 1->2"):
            code, _payload, text = cli(root, "checkpoint", "DEC", step, "--json")
            self.assertEqual(code, 0, text)
        pivots = log_of(root).count("DEC: goal pivot")
        code, again, text = cli(root, "start", TASK, "--json")
        self.assertEqual(code, 0, text)
        self.assertEqual(again["ticket"], first["ticket"], text)
        self.assertEqual(counters(state_of(root))[1:], (1, 2))
        self.assertEqual(log_of(root).count("DEC: goal pivot"), pivots)

    def test_a_tripped_valve_is_still_reauthorized(self):
        root = valve_project(self)
        code, payload, text = cli(root, "start", TASK, "--json")
        self.assertEqual(code, 0, text)
        self.assertTrue(payload["valve_reauthorized"], text)
        self.assertEqual(counters(state_of(root)), ("goal", 0, 0))


if __name__ == "__main__":
    unittest.main()
