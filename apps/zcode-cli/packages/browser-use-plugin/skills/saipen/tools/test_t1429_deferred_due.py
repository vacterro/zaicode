"""T-1429 deferred-operator due-time regressions: one canonical machine field.

retry_not_before is the ONLY machine-readable due instant. Prose timestamps
never drive gates; naive/local/malformed stamps fail closed; DEFERRED before
due, DUE at/after; eligible Work still selected over any gate.
"""

from __future__ import annotations

import datetime as dt
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.board import (  # noqa: E402
    blocker_class,
    deferred_operator_class,
    deferred_state,
    operator_gates,
    parse_board,
    retry_not_before,
)
from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    ticket_add,
    ticket_move,
)
from saipen_engine.router import route_next  # noqa: E402


def _utc(year, month, day, hour=0, minute=0, second=0):
    return dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.timezone.utc)


BOARD_PREAMBLE = "## DOING\n## TODO\n## DONE\n## BLOCKED\n"


def _project(task="none", phase="DONE", blocker=""):
    base = Path(tempfile.mkdtemp(prefix="saipen-t1429-"))
    project = base / "project"
    (project / ".saipen").mkdir(parents=True)
    now = "2026-09-01T00:00:00Z"
    text = (
        "---\n"
        f"phase: {phase}\n"
        f"task: {task}\n"
        'next_action: "saipen continue"\n'
        f'blocker: "{blocker}"\n'
        "transition_from: DONE\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        "last_event: 1\n"
        "style_contract: ded-4ae736e4\n"
        f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
        "agent: tester\n"
        "requires:\n  - filesystem\n  - python\n"
        "mode: full\n"
        f'updated: "{now}"\n'
        "---\n"
    )
    (project / ".saipen" / "STATE.md").write_text(text, encoding="utf-8")
    (project / ".saipen" / "BOARD.md").write_text(BOARD_PREAMBLE, encoding="utf-8")
    (project / ".saipen" / "LOG.md").write_text(
        "- 01.09.26 00:00 [E-001] [agent: tester] RUN: fixture -> PASS\n",
        encoding="utf-8",
    )
    ensure_project_lineage(project)
    return base, project


def _add(project, description, verify="verify with a passing test"):
    result = ticket_add(project, "tester", "P1", description, [], verify)
    assert result.ok, result.to_dict()
    return result.data["ticket"]


def _block(project, ticket, blocker, retry=None):
    result = ticket_move(
        project, "block", ticket, "tester", blocker, retry_not_before=retry
    )
    assert result.ok, result.to_dict()


def _route(project, now):
    state = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
    board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
    return route_next(state, board, current_agent="tester", now=now)


class DeferredDueTests(unittest.TestCase):
    def setUp(self):
        self._tmp = []

    def tearDown(self):
        for base in self._tmp:
            shutil.rmtree(base, ignore_errors=True)

    def _proj(self):
        base, project = _project()
        self._tmp.append(base)
        return project

    def test_before_due_is_deferred_operator(self):
        base, project = _project()
        self._tmp.append(base)
        tid = _add(project, "deferred operator Work")
        _block(project, tid, "BLOCKED_EXTERNAL -- operator gate", "2026-09-20T21:00:00Z")
        parsed = parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        ticket = parsed["tickets"][tid]
        self.assertEqual(retry_not_before(ticket), "2026-09-20T21:00:00Z")
        self.assertEqual(deferred_state(ticket, _utc(2026, 9, 20, 20, 59)), "DEFERRED_OPERATOR")

    def test_exactly_at_due_is_due(self):
        base, project = _project()
        self._tmp.append(base)
        tid = _add(project, "due operator Work")
        _block(project, tid, "BLOCKED_EXTERNAL -- operator gate", "2026-09-20T21:00:00Z")
        parsed = parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        ticket = parsed["tickets"][tid]
        self.assertEqual(deferred_state(ticket, _utc(2026, 9, 20, 21, 0)), "DUE_OPERATOR_ACTION")

    def test_after_due_is_due(self):
        base, project = _project()
        self._tmp.append(base)
        tid = _add(project, "overdue operator Work")
        _block(project, tid, "BLOCKED_EXTERNAL -- operator gate", "2026-09-20T21:00:00Z")
        parsed = parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        ticket = parsed["tickets"][tid]
        self.assertEqual(deferred_state(ticket, _utc(2026, 9, 21)), "DUE_OPERATOR_ACTION")

    def test_prose_timestamp_never_activates_gate(self):
        parsed = parse_board(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n"
            "- [ ] T-9 [P1] prose Work | verify: x | "
            "blocker: BLOCKED_EXTERNAL -- retry not before 2026-09-20T21:00:00Z\n"
        )
        ticket = parsed["tickets"]["T-9"]
        self.assertIsNone(retry_not_before(ticket))
        self.assertIsNone(deferred_state(ticket, _utc(2026, 9, 21)))
        self.assertEqual(operator_gates(parsed["tickets"], _utc(2026, 9, 21)), [])

    def test_malformed_stamp_refused_at_writer(self):
        base, project = _project()
        self._tmp.append(base)
        tid = _add(project, "malformed stamp Work")
        result = ticket_move(
            project, "block", tid, "tester", "BLOCKED_EXTERNAL -- gate",
            retry_not_before="2026-09-21 00:00 Europe/Tallinn",
        )
        self.assertFalse(result.ok)

    def test_naive_stamp_refused_at_writer(self):
        base, project = _project()
        self._tmp.append(base)
        tid = _add(project, "naive stamp Work")
        result = ticket_move(
            project, "block", tid, "tester", "BLOCKED_EXTERNAL -- gate",
            retry_not_before="2026-09-20T21:00:00",
        )
        self.assertFalse(result.ok)

    def test_non_utc_offset_refused_at_writer(self):
        base, project = _project()
        self._tmp.append(base)
        tid = _add(project, "offset stamp Work")
        result = ticket_move(
            project, "block", tid, "tester", "BLOCKED_EXTERNAL -- gate",
            retry_not_before="2026-09-20T21:00:00+03:00",
        )
        self.assertFalse(result.ok)

    def test_retry_field_outside_blocked_fails_validation(self):
        parsed = parse_board(
            "## DOING\n## TODO\n"
            "- [ ] T-1 [P1] todo Work | verify: x | retry_not_before: 2026-09-20T21:00:00Z\n"
            "## DONE\n## BLOCKED\n"
        )
        from saipen_engine.board import board_semantic_errors

        errors = board_semantic_errors(parsed["tickets"]["T-1"])
        self.assertTrue(any("retry_not_before" in error for error in errors))

    def test_deferred_gate_still_selects_eligible_work(self):
        project = self._proj()
        blocked = _add(project, "deferred operator Work")
        _block(project, blocked, "BLOCKED_EXTERNAL -- operator gate", "2026-09-20T21:00:00Z")
        eligible = _add(project, "eligible agent Work")
        routed = _route(project, _utc(2026, 9, 20, 20, 0))
        self.assertTrue(routed.get("ok"))
        self.assertEqual(routed.get("ticket"), eligible)

    def test_due_gate_still_selects_eligible_work(self):
        project = self._proj()
        blocked = _add(project, "due operator Work")
        _block(project, blocked, "BLOCKED_EXTERNAL -- operator gate", "2026-09-20T21:00:00Z")
        eligible = _add(project, "eligible agent Work")
        routed = _route(project, _utc(2026, 9, 21))
        self.assertTrue(routed.get("ok"))
        self.assertEqual(routed.get("ticket"), eligible)

    def test_due_gate_with_no_work_is_operator_boundary(self):
        project = self._proj()
        blocked = _add(project, "due operator Work")
        _block(project, blocked, "BLOCKED_EXTERNAL -- operator gate", "2026-09-20T21:00:00Z")
        routed = _route(project, _utc(2026, 9, 21))
        self.assertTrue(routed.get("ok"))
        self.assertEqual(routed.get("reason"), "operator-gate-due")
        self.assertIn(blocked, routed.get("detail", ""))
        self.assertTrue(routed.get("requires_human"))
        self.assertFalse(routed.get("action", "").startswith("PHASE "))

    def test_unrelated_blocker_plus_due_field_is_no_gate(self):
        parsed = parse_board(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n"
            "- [ ] T-9 [P1] prose Work | verify: x | blocker: some other prose | "
            "retry_not_before: 2026-09-20T21:00:00Z\n"
        )
        ticket = parsed["tickets"]["T-9"]
        self.assertIsNone(deferred_state(ticket, _utc(2026, 9, 21)))

    def test_unblock_clears_due_field(self):
        base, project = _project()
        self._tmp.append(base)
        tid = _add(project, "clear due Work")
        _block(project, tid, "BLOCKED_EXTERNAL -- operator gate", "2026-09-20T21:00:00Z")
        result = ticket_move(project, "unblock", tid, "tester", "operator done")
        self.assertTrue(result.ok, result.to_dict())
        parsed = parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        ticket = parsed["tickets"][tid]
        self.assertNotIn("retry_not_before", ticket["fields"])
        self.assertIsNone(deferred_state(ticket, _utc(2026, 9, 21)))


#: Blocker classes a human operator genuinely owns: a due instant on one of
#: these means "a person must act at this moment".
OPERATOR_OWNED = (
    "WAIT_USER_CONFIRMATION",
    "WAIT_USER_DECISION",
    "BLOCKED_EXTERNAL",
)
#: Blockers the protocol RECOGNIZES but no operator owns. This tuple is the
#: point of the whole suite: `blocker_class` says yes to every one of them,
#: so any surface that asks `blocker_class` instead of the narrower question
#: reports a human deadline on protocol holds and crew-owned Work.
RECOGNIZED_BUT_NOT_OPERATOR_OWNED = (
    "ACTIVE",
    "HELD",
    "FUTURE_GATE",
    "PERMANENT_WARNING_OWNER",
    "WAIT_ROLE:saitest",
)


def _out_of_band_board(blocker, retry="2026-09-20T21:00:00Z"):
    """BOARD bytes the public writer would refuse -- historical/hand-edited."""
    return parse_board(
        "## DOING\n## TODO\n## DONE\n## BLOCKED\n"
        f"- [ ] T-9 [P1] out-of-band Work | verify: x | blocker: {blocker} | "
        f"blocker_scope: ticket | retry_not_before: {retry}\n"
    )["tickets"]["T-9"]


class DeferredOperatorEligibilityTests(unittest.TestCase):
    """The deferred-operator vocabulary is NARROWER than the blocker vocabulary.

    Red control for the defect where `deferred_state` asked
    `blocker_class(blocker) is not None` -- "is this a recognized blocker" --
    and therefore projected DUE_OPERATOR_ACTION for HELD, FUTURE_GATE,
    ACTIVE, PERMANENT_WARNING_OWNER and WAIT_ROLE:<role>.
    """

    def setUp(self):
        self._tmp = []

    def tearDown(self):
        for base in self._tmp:
            shutil.rmtree(base, ignore_errors=True)

    def _proj(self):
        base, project = _project()
        self._tmp.append(base)
        return project

    def test_the_two_vocabularies_are_not_the_same_set(self):
        # The semantic distinction itself, asserted once and directly: every
        # ineligible blocker below IS a recognized blocker. If a future change
        # makes the two questions identical, this fails before anything else.
        for blocker in RECOGNIZED_BUT_NOT_OPERATOR_OWNED:
            with self.subTest(blocker=blocker):
                self.assertIsNotNone(
                    blocker_class(blocker),
                    f"{blocker} must stay a recognized blocker",
                )
                self.assertIsNone(
                    deferred_operator_class(blocker),
                    f"{blocker} is a protocol/crew hold, not a human with a clock",
                )
        for blocker in OPERATOR_OWNED:
            with self.subTest(blocker=blocker):
                self.assertEqual(deferred_operator_class(blocker), blocker)

    def test_operator_owned_classes_project_deferred_then_due(self):
        for klass in OPERATOR_OWNED:
            with self.subTest(blocker=klass):
                project = self._proj()
                tid = _add(project, f"{klass} operator Work")
                _block(project, tid, f"{klass} -- operator gate", "2026-09-20T21:00:00Z")
                parsed = parse_board(
                    (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
                )
                ticket = parsed["tickets"][tid]
                self.assertEqual(
                    deferred_state(ticket, _utc(2026, 9, 20, 20, 59)),
                    "DEFERRED_OPERATOR",
                )
                self.assertEqual(
                    deferred_state(ticket, _utc(2026, 9, 20, 21, 0)),
                    "DUE_OPERATOR_ACTION",
                )

    def test_ineligible_classes_never_project_a_gate(self):
        for blocker in RECOGNIZED_BUT_NOT_OPERATOR_OWNED:
            with self.subTest(blocker=blocker):
                ticket = _out_of_band_board(blocker)
                self.assertIsNone(deferred_state(ticket, _utc(2026, 9, 21)))
                self.assertIsNone(deferred_state(ticket, _utc(2026, 9, 20, 20, 0)))
                self.assertEqual(operator_gates({"T-9": ticket}, _utc(2026, 9, 21)), [])

    def test_active_dependency_never_projects_a_gate(self):
        # T-1426's real shape while its dependency chain is unresolved: a due
        # instant here would be exactly the faked "live use" the handoff bans.
        ticket = _out_of_band_board("ACTIVE_DEPENDENCY:T-1428 -- paused")
        self.assertIsNone(deferred_state(ticket, _utc(2026, 9, 21)))

    def test_writer_refuses_a_due_instant_on_an_ineligible_blocker(self):
        for blocker in RECOGNIZED_BUT_NOT_OPERATOR_OWNED:
            with self.subTest(blocker=blocker):
                project = self._proj()
                tid = _add(project, f"{blocker} Work")
                result = ticket_move(
                    project,
                    "block",
                    tid,
                    "tester",
                    f"{blocker} -- hold",
                    retry_not_before="2026-09-20T21:00:00Z",
                )
                self.assertFalse(result.ok, result.to_dict())
                board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
                self.assertNotIn("retry_not_before", board)

    def test_writer_refuses_a_due_instant_on_block_for(self):
        project = self._proj()
        parent = _add(project, "parent Work")
        child = _add(project, "child Work")
        result = ticket_move(
            project,
            "block-for",
            parent,
            "tester",
            "waiting on the child",
            blocked_on=child,
            retry_not_before="2026-09-20T21:00:00Z",
        )
        self.assertFalse(result.ok, result.to_dict())

    def test_writer_still_accepts_every_operator_owned_class(self):
        for klass in OPERATOR_OWNED:
            with self.subTest(blocker=klass):
                project = self._proj()
                tid = _add(project, f"{klass} Work")
                result = ticket_move(
                    project,
                    "block",
                    tid,
                    "tester",
                    f"{klass} -- operator gate",
                    retry_not_before="2026-09-20T21:00:00Z",
                )
                self.assertTrue(result.ok, result.to_dict())

    def test_board_validation_reports_an_ineligible_due_instant(self):
        from saipen_engine.board import board_semantic_errors

        for blocker in RECOGNIZED_BUT_NOT_OPERATOR_OWNED:
            with self.subTest(blocker=blocker):
                ticket = _out_of_band_board(blocker)
                errors = board_semantic_errors(ticket)
                self.assertTrue(
                    any("retry_not_before" in error for error in errors),
                    f"{blocker} + due instant must be reported invalid metadata",
                )

    def test_board_validation_accepts_an_eligible_due_instant(self):
        from saipen_engine.board import board_semantic_errors

        for klass in OPERATOR_OWNED:
            with self.subTest(blocker=klass):
                ticket = _out_of_band_board(f"{klass} -- operator gate")
                errors = board_semantic_errors(ticket)
                self.assertFalse(
                    any("retry_not_before" in error for error in errors),
                    errors,
                )

    def test_status_waiting_on_you_names_every_operator_owned_class(self):
        # The third copy of the vocabulary lived in the status projection and
        # listed only the two WAIT_USER classes, so a real BLOCKED_EXTERNAL
        # operator gate never appeared under "Waiting on you" at all.
        import json
        import os
        import subprocess

        project = self._proj()
        expected = []
        for klass in OPERATOR_OWNED:
            tid = _add(project, f"{klass} Work")
            _block(project, tid, f"{klass} -- operator gate")
            expected.append(tid)
        for blocker in RECOGNIZED_BUT_NOT_OPERATOR_OWNED:
            tid = _add(project, f"{blocker} Work")
            _block(project, tid, f"{blocker} -- hold")
        env = {**os.environ}
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT"):
            env.pop(key, None)
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "status",
                "--json",
                "--project-root",
                str(project),
                "--agent",
                "tester",
            ],
            capture_output=True,
            text=True,
            timeout=300,
            env=env,
            encoding="utf-8",
            errors="replace",
        )
        payload = json.loads(proc.stdout)
        named = {line.split(":", 1)[0] for line in payload.get("waiting_on_you", [])}
        self.assertEqual(named, set(expected), payload.get("waiting_on_you"))

    def test_router_reports_no_operator_gate_for_an_ineligible_due_instant(self):
        project = self._proj()
        tid = _add(project, "held Work")
        _block(project, tid, "HELD -- protocol hold")
        board_path = project / ".saipen" / "BOARD.md"
        # Out-of-band injection: the writer refuses this, so reproduce the
        # historical bytes a hand edit or an older engine could have left.
        board = board_path.read_text(encoding="utf-8").replace(
            f"- [ ] {tid} ", f"- [ ] {tid} ", 1
        )
        board = board.replace(
            "blocker_scope: ticket",
            "blocker_scope: ticket | retry_not_before: 2026-09-20T21:00:00Z",
            1,
        )
        board_path.write_text(board, encoding="utf-8")
        routed = _route(project, _utc(2026, 9, 21))
        self.assertNotIn(
            routed.get("reason"), ("operator-gate-due", "operator-gate-deferred")
        )
        self.assertNotEqual(routed.get("code"), "OPERATOR_ACTION_DUE")


if __name__ == "__main__":
    unittest.main()
