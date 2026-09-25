"""CORE-001 regression tests: the oracle rule reaches the authoritative gates.

`VERIFY-ORACLE-01` shipped in v7.250.0 as a norm, a pure module and 21 focused
tests -- and NO production caller. `operations.py` gated VERIFY -> REVIEW and
`finish` through `log.verification_evidence` alone, which decides from
free-form text carrying `PASS` and `conf: high` and never compares an oracle to
a subject. So a bug could stay untouched, its fixture be weakened, an ordinary
green be logged, and both canonical gates accepted it. That is exactly the
`CONTROL_DISARMED` escape the ticket was written to close, left open by the
ticket that closed it.

These tests drive the REAL `transition_phase` and `finish_ticket` APIs, because
proving `regression_pair_verdict` correct in isolation is what created the gap.

Proven here:
- a ticket declaring `regression: required` cannot leave VERIFY on a green run
  alone, and cannot finish either;
- an honest pair -- same verifier, moved subject -- is admitted;
- a weakened oracle is refused even though the suite is green;
- moving both sides at once is refused as unattributable;
- the legitimate-test-change escape path works end to end;
- a refusal writes nothing;
- the two evidence channels do not fight;
- a ticket that does NOT declare the field is completely unaffected.

Run standalone:
    python tools/test_regression_gate.py
"""

from __future__ import annotations

import datetime as dt
import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.log import (  # noqa: E402
    read_history_snapshot,
    regression_evidence,
    verification_evidence,
)
from saipen_engine.operations import (  # noqa: E402
    checkpoint,
    finish_ticket,
    transition_phase,
)

GREEN = "acceptance -> PASS conf: high"
V1, V2 = "1111aaaa", "9999dddd"
S1, S2 = "2222bbbb", "3333cccc"


def _evidence(result: str, verifier: str, subject: str) -> str:
    return f"REGRESSION-EVIDENCE {result} verifier:{verifier} subject:{subject} -- run"


def _state(phase: str, transition_from: str, last_event: int) -> str:
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    home = str(ROOT).replace(chr(92), chr(92) * 2)
    return (
        "---\n"
        f"phase: {phase}\n"
        "task: T-7\n"
        f'next_action: "PHASE {phase} T-7"\n'
        'blocker: ""\n'
        f"transition_from: {transition_from}\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        f"last_event: {last_event}\n"
        "style_contract: ded-4ae736e4\n"
        f'saipen_home: "{home}"\n'
        "agent: tester\n"
        "requires:\n  - filesystem\n  - python\n"
        "mode: full\n"
        f'updated: "{now}"\n'
        "execution_intent: normal\n"
        "---\n"
    )


def _board(regression: str) -> str:
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    field = f" | regression: {regression}" if regression else ""
    return (
        "## DOING\n"
        f"- [/] T-7 [P1] Fix the clamp | verify: the clamp holds{field} "
        f"| owner: tester | claim_time: {now}\n"
        "## TODO\n## DONE\n## BLOCKED\n"
    )


def _ship_project(case, *, pair: bool = False) -> Path:
    """A project sitting in SHIP on a ticket that owes a regression pair.

    Built from scratch, never by editing a LOG mid-run: forging history breaks
    the append-only ledger, and the refusal that produces proves nothing about
    this gate.
    """
    base = Path(tempfile.mkdtemp(prefix="saipen-regression-ship-"))
    case.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
    project = base / "project"
    (project / ".saipen").mkdir(parents=True)
    lines = [
        "- 24.08.26 00:00 [E-001] [T-7] [agent: tester] RUN: fixture -> PASS",
        "- 24.08.26 00:01 [E-002] [parent: E-001] [T-7] [agent: tester] "
        "RUN: transition to VERIFY -- verify",
        f"- 24.08.26 00:02 [E-003] [parent: E-002] [T-7] [agent: tester] RUN: {GREEN}",
    ]
    if pair:
        lines.append(
            "- 24.08.26 00:03 [E-004] [parent: E-003] [T-7] [agent: tester] "
            f"RUN: {_evidence('FAIL', V1, S1)}"
        )
        lines.append(
            "- 24.08.26 00:04 [E-005] [parent: E-004] [T-7] [agent: tester] "
            f"RUN: {_evidence('PASS', V1, S2)}"
        )
    (project / ".saipen" / "STATE.md").write_text(
        _state("SHIP", "REVIEW", 5 if pair else 3), encoding="utf-8"
    )
    (project / ".saipen" / "BOARD.md").write_text(_board("required"), encoding="utf-8")
    (project / ".saipen" / "LOG.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    ensure_project_lineage(project)
    return project


class RegressionGateFixture(unittest.TestCase):
    """A project sitting in VERIFY on one claimed ticket."""

    REGRESSION = "required"

    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="saipen-regression-gate-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        self.project = base / "project"
        (self.project / ".saipen").mkdir(parents=True)
        (self.project / ".saipen" / "STATE.md").write_text(
            _state("BUILD", "SCOUT", 1), encoding="utf-8"
        )
        (self.project / ".saipen" / "BOARD.md").write_text(
            _board(self.REGRESSION), encoding="utf-8"
        )
        (self.project / ".saipen" / "LOG.md").write_text(
            "- 24.08.26 00:00 [E-001] [T-7] [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        ensure_project_lineage(self.project)
        self.assertTrue(
            transition_phase(self.project, "VERIFY", "tester", "T-7", "verify").ok
        )
        self.assertTrue(checkpoint(self.project, "tester", "RUN", "T-7", GREEN).ok)

    def record(self, text: str) -> None:
        self.assertTrue(checkpoint(self.project, "tester", "RUN", "T-7", text).ok)

    def to_review(self):
        return transition_phase(self.project, "REVIEW", "tester", "T-7", "review")

    def canonical_digest(self) -> str:
        digest = hashlib.sha256()
        for name in ("STATE.md", "BOARD.md", "LOG.md"):
            digest.update((self.project / ".saipen" / name).read_bytes())
        return digest.hexdigest()


class GateRefusalTests(RegressionGateFixture):
    def test_a_green_run_alone_does_not_leave_verify(self):
        """The headline. `PASS conf: high` used to be the whole gate."""
        result = self.to_review()
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "INCOMPLETE_TICKET")
        self.assertIn("regression: required", result.message)

    def test_the_refusal_writes_nothing(self):
        before = self.canonical_digest()
        self.assertFalse(self.to_review().ok)
        self.assertEqual(self.canonical_digest(), before)

    def test_a_weakened_oracle_is_refused_although_the_suite_is_green(self):
        """Same subject, moved verifier: the classic greenwash."""
        self.record(_evidence("FAIL", V1, S1))
        self.record(_evidence("PASS", V2, S1))
        result = self.to_review()
        self.assertFalse(result.ok, result.to_dict())
        self.assertIn("ORACLE_CHANGED", result.message)

    def test_moving_both_sides_at_once_is_refused_as_unattributable(self):
        self.record(_evidence("FAIL", V1, S1))
        self.record(_evidence("PASS", V2, S2))
        result = self.to_review()
        self.assertFalse(result.ok, result.to_dict())
        self.assertIn("ORACLE_CHANGED", result.message)

    def test_a_pass_with_no_recorded_fail_is_refused(self):
        self.record(_evidence("PASS", V1, S2))
        result = self.to_review()
        self.assertFalse(result.ok, result.to_dict())
        self.assertIn("NO_REGRESSION_EVIDENCE", result.message)

    def test_prose_about_the_evidence_is_not_evidence(self):
        """Anchoring: a line DESCRIBING a record is not that record.

        The transition is refused either way here -- prose containing the word
        FAIL is a failure claim to the ORDINARY channel, which is T-1281's
        separate scope problem and not this gate. What this gate must prove is
        that no admissible pair was built out of prose.
        """
        self.record(f"we will record {_evidence('FAIL', V1, S1)} shortly")
        self.record(f"and then {_evidence('PASS', V1, S2)}")
        self.assertFalse(self.to_review().ok)
        events = read_history_snapshot(self.project).events
        ok, reason = regression_evidence("T-7", events)
        self.assertFalse(ok)
        self.assertIn("NO_REGRESSION_EVIDENCE", reason)


class GateAdmissionTests(RegressionGateFixture):
    def test_an_honest_pair_is_admitted(self):
        """Same verifier red against the pre-fix subject, green against the post."""
        self.record(_evidence("FAIL", V1, S1))
        self.record(_evidence("PASS", V1, S2))
        result = self.to_review()
        self.assertTrue(result.ok, result.to_dict())

    def test_re_establishing_the_fail_under_the_new_oracle_admits_it(self):
        """The legitimate-test-change escape path, end to end.

        The old pair is spent by the verifier change; recording a fresh FAIL
        under the NEW oracle and a PASS beside it is admissible again.
        """
        self.record(_evidence("FAIL", V1, S1))
        self.record(_evidence("PASS", V2, S1))
        self.assertFalse(self.to_review().ok)
        self.record(_evidence("FAIL", V2, S1))
        self.record(_evidence("PASS", V2, S2))
        self.assertTrue(self.to_review().ok)

    def test_the_recorded_pair_does_not_break_ordinary_verification(self):
        """The two channels must not fight.

        A `REGRESSION-EVIDENCE FAIL` record is the REQUIRED red half of a pair;
        an agent writing it is complying, not reporting a failed cycle. Before
        the channels were separated, recording it made the ordinary classifier
        veto the transition on the word FAIL.
        """
        self.record(_evidence("FAIL", V1, S1))
        self.record(_evidence("PASS", V1, S2))
        ok, _reason = verification_evidence(
            "T-7", read_history_snapshot(self.project).events
        )
        self.assertTrue(ok)


class FinishGateTests(unittest.TestCase):
    """`finish` reaches its own verdict; it does not inherit the transition's."""

    def test_the_finish_gate_refuses_a_missing_pair(self):
        project = _ship_project(self)
        result = finish_ticket(project, "T-7", "tester")
        self.assertFalse(result.ok, result.to_dict())
        self.assertIn("regression: required", result.message)

    def test_the_finish_gate_does_not_refuse_a_recorded_pair(self):
        """Positive control: it is this gate that changes, not the fixture."""
        project = _ship_project(self, pair=True)
        result = finish_ticket(project, "T-7", "tester")
        self.assertNotIn("regression: required", result.message or "")


class UndeclaredTicketTests(RegressionGateFixture):
    """Positive control: the gate is off for every ticket that does not ask."""

    REGRESSION = ""

    def test_an_ordinary_ticket_is_completely_unaffected(self):
        result = self.to_review()
        self.assertTrue(result.ok, result.to_dict())

    def test_an_unrecognised_value_does_not_arm_the_gate(self):
        """A typo must not silently arm the strictest check in the chain."""
        board = self.project / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "| owner: tester", "| recurrence: yes | owner: tester", 1
            ),
            encoding="utf-8",
        )
        self.assertTrue(self.to_review().ok)


if __name__ == "__main__":
    unittest.main(verbosity=2)
