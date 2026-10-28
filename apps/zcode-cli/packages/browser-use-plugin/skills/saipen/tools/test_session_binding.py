"""A live foreign owner must block an UNSEATED product mutation (T-1384).

The field measured a session that ran no saipen command, left the canonical
ledger byte-identical, and changed `src/app.py` anyway. No seat was stolen --
none had to be. `admission` resolves an absent actor to `STATE.agent`, so the
ownership test asks whether the incumbent is the incumbent and can only answer
yes. `owner` is a NAME, and a name is not a process.

These controls pin the half the name cannot carry: a claim records WHICH HOST
SESSION made it, as a lineage-salted digest, and a consequential mutation must
present the same session.

The cases are separate because they are separate promises, and a single
"foreign window is blocked" test would keep passing while any of the others
silently broke -- notably the two that say what must STILL work.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_t1363_zero_manual_entry as fixtures
from saipen_engine import guard_events
from saipen_engine.board import claim_session_digest
from saipen_engine.operations import HOST_SESSION_ENV
from saipen_engine.paths import unbound_environment
from test_hermetic_env import isolate_host_session


def setUpModule() -> None:
    # Every fixture here drives the CLI from a disposable project on purpose.
    # An enclosing host session's carriers would bind the OPERATOR's live
    # project instead (test_hermetic_env owns this repair); the suite sets the
    # one carrier it is actually testing explicitly in each case.
    isolate_host_session()

SAIPEN = Path(__file__).resolve().parent / "saipen.py"
OWNER = "ses_owner_window"
OTHER = "ses_second_window"
#: Every consequential surface the operator named. A binding that holds for
#: `edit` while `bash` walks past it is not ownership isolation, it is a
#: speed bump, and the field session reached the product through whichever
#: surface was open.
MUTATIONS = ("edit", "write", "bash")


def _verdict(project: Path, tool: str, session_id: str | None) -> dict:
    target = project / "src" / "app.py"
    tool_input = (
        {"command": f'printf "x" >> "{target}"'}
        if tool == "bash"
        else {"filePath": str(target), "oldString": "def main", "newString": "def main2"}
    )
    event = {
        "event": "before_tool",
        "host": "opencode",
        "cwd": str(project),
        "tool_name": tool,
        "tool_input": tool_input,
    }
    if session_id is not None:
        event["session_id"] = session_id
    return guard_events.evaluate_event(guard_events.load_event(json.dumps(event)), None)


class SessionDigestTests(unittest.TestCase):
    def test_the_digest_never_carries_the_session_id(self):
        digest = claim_session_digest("lineage-x", "ses_secret_value")
        self.assertNotIn("ses_secret_value", digest)
        self.assertRegex(digest, r"^[0-9a-f]{32}$")

    def test_the_same_session_in_another_project_is_another_digest(self):
        """Salted by lineage, so one window's binding cannot be replayed."""
        self.assertNotEqual(
            claim_session_digest("lineage-a", "ses_x"),
            claim_session_digest("lineage-b", "ses_x"),
        )

    def test_a_missing_session_stays_missing(self):
        """Absence must survive to the comparison.

        A digest of the empty string would be a VALUE, and a value is
        something a later check can mistake for proof.
        """
        self.assertIsNone(claim_session_digest("lineage-a", None))
        self.assertIsNone(claim_session_digest("lineage-a", "   "))


class UnseatedMutationTests(unittest.TestCase):
    """The zero-manual path, driven exactly as a host drives it."""

    def setUp(self):
        self.project = Path(fixtures.healthy(self))
        env = dict(os.environ)
        env[HOST_SESSION_ENV] = OWNER
        started = subprocess.run(
            [sys.executable, str(SAIPEN), "start", "add a docstring to src/app.py", "--json"],
            cwd=str(self.project),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
        )
        self.assertEqual(
            json.loads(started.stdout or "{}").get("code"),
            "STARTED",
            msg=started.stdout + started.stderr,
        )
        self.board = self.project / ".saipen" / "BOARD.md"

    def _doing(self) -> str:
        return next(
            line
            for line in self.board.read_text(encoding="utf-8").splitlines()
            if line.startswith("- [/] ")
        )

    def test_start_binds_the_session_with_no_user_negotiation(self):
        self.assertIn("claim_session:", self._doing())

    def test_the_board_never_holds_the_session_id_itself(self):
        """BOARD is copied into audit archives; a bearer value must not be."""
        self.assertNotIn(OWNER, self.board.read_text(encoding="utf-8"))

    def test_the_owner_session_mutates_its_own_work(self):
        for tool in MUTATIONS:
            with self.subTest(tool=tool):
                self.assertTrue(_verdict(self.project, tool, OWNER)["ok"])

    def test_a_second_window_mutates_nothing(self):
        for tool in MUTATIONS:
            with self.subTest(tool=tool):
                verdict = _verdict(self.project, tool, OTHER)
                self.assertFalse(verdict["ok"])
                self.assertEqual(verdict["code"], "UNSEATED_MUTATION")

    def test_missing_session_proof_is_not_the_current_owner(self):
        """The whole defect in one case: silence used to read as the owner."""
        for tool in MUTATIONS:
            with self.subTest(tool=tool):
                verdict = _verdict(self.project, tool, None)
                self.assertFalse(verdict["ok"])
                self.assertEqual(verdict["code"], "UNSEATED_MUTATION")

    def test_the_refusal_names_one_command_the_second_window_can_run(self):
        verdict = _verdict(self.project, "edit", OTHER)
        self.assertTrue(str(verdict.get("canonical_next_command") or "").startswith("saipen "))

    def test_read_only_diagnostics_stay_open_to_the_second_window(self):
        """A blocked window must still be able to SEE why it is blocked."""
        self.assertTrue(_verdict(self.project, "read", OTHER)["ok"])

    def test_the_foreign_window_changes_no_canonical_byte(self):
        before = self.board.read_bytes()
        state = (self.project / ".saipen" / "STATE.md").read_bytes()
        for tool in MUTATIONS:
            _verdict(self.project, tool, OTHER)
        self.assertEqual(self.board.read_bytes(), before)
        self.assertEqual((self.project / ".saipen" / "STATE.md").read_bytes(), state)


class TakeoverStillWorksTests(unittest.TestCase):
    """Point 10: a dead owner must not freeze the Work forever.

    Liveness is asked WITHOUT an actor on purpose -- with one, a matching name
    short-circuits to SELF before the clock is read, so a binding left by a
    process that died would lock the ticket permanently.
    """

    def _bound_foreign_project(self, claim_age_minutes: int) -> Path:
        """The shipped foreign-owner fixture, aged to a chosen claim_time.

        It already carries its own binding, so only the clock is moved -- a
        second `claim_session` field would be a duplicate the board parser
        rejects outright, and the test would fail for the wrong reason.
        """
        project = Path(fixtures.foreign_owner_project(self))
        board = project / ".saipen" / "BOARD.md"
        stamp = (datetime.now(timezone.utc) - timedelta(minutes=claim_age_minutes)).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )
        text = board.read_text(encoding="utf-8")
        self.assertIn(f"claim_session: {fixtures.FOREIGN_CLAIM_SESSION}", text)
        board.write_text(
            re.sub(r"claim_time: \S+", f"claim_time: {stamp}", text, count=1),
            encoding="utf-8",
            newline="",
        )
        return project

    def test_a_live_bound_claim_blocks_the_other_window(self):
        verdict = _verdict(self._bound_foreign_project(1), "edit", OTHER)
        self.assertEqual(verdict["code"], "UNSEATED_MUTATION")

    def test_a_lapsed_bound_claim_does_not_freeze_the_project(self):
        self.assertTrue(_verdict(self._bound_foreign_project(120), "edit", OTHER)["ok"])


class SeatGateTests(unittest.TestCase):
    """The mutation gate and the SEAT gate must reach the same answer.

    Measured live 2026-09-17: closing only the mutation door was not enough.
    A second window was refused UNSEATED_MUTATION once, then ran `saipen
    start`, inherited `STATE.agent`, parked the foreign owner's Work as if it
    were its own, rebound the claim to itself -- and every mutation after that
    was legal. The window stole nothing; it assumed the name, one layer up
    from where the first fix looked.
    """

    def _start(self, project: Path, session_id: str | None) -> dict:
        # The environment comes from the ONE owner of project binding. Written
        # by hand as `dict(os.environ)` with the session id popped, this call
        # inherited `SAIPEN_PROJECT_ROOT` from whatever launched the harness --
        # which out-ranks `cwd` -- and minted SRC-060/T-1391 into that project
        # instead of the fixture. The seat is this test's own subject, so the
        # session id stays an explicit override here.
        env = unbound_environment(SAIPEN_HOST_SESSION=session_id or None)
        done = subprocess.run(
            [sys.executable, str(SAIPEN), "start", "add a trailing comment", "--json"],
            cwd=str(project),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
        )
        return json.loads(done.stdout or "{}")

    def test_a_foreign_bound_claim_is_not_taken_over_by_start(self):
        for label, session_id in (("another window", OTHER), ("no identity", None)):
            with self.subTest(label):
                project = Path(fixtures.foreign_owner_project(self))
                self.assertEqual(self._start(project, session_id).get("code"), "WAIT_FOREIGN_OWNER")

    def test_the_refused_start_leaves_the_owner_exactly_where_it_was(self):
        project = Path(fixtures.foreign_owner_project(self))
        self._start(project, OTHER)
        doing = [
            line
            for line in (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8").splitlines()
            if line.startswith("- [/] ")
        ]
        self.assertEqual(len(doing), 1)
        self.assertIn("T-9200", doing[0])
        self.assertIn("owner: codex", doing[0])
        self.assertIn(f"claim_session: {fixtures.FOREIGN_CLAIM_SESSION}", doing[0])


class MigrationTests(unittest.TestCase):
    """A claim written before this existed proves nothing -- either way."""

    def test_an_unbound_claim_is_judged_exactly_as_before(self):
        project = Path(fixtures.healthy(self))
        env = dict(os.environ)
        env.pop(HOST_SESSION_ENV, None)
        subprocess.run(
            [sys.executable, str(SAIPEN), "start", "add a docstring to src/app.py", "--json"],
            cwd=str(project),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
        )
        board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        doing = next(line for line in board.splitlines() if line.startswith("- [/] "))
        self.assertNotIn("claim_session:", doing)
        # Unchanged behaviour: a project mid-upgrade keeps working rather than
        # freezing on a binding nobody could have written yet.
        self.assertTrue(_verdict(project, "edit", None)["ok"])

    def test_reclaiming_without_proof_cannot_clear_a_live_binding(self):
        """`saipen claim` must not be the way around the binding.

        An earlier draft of this ticket cleared the binding whenever a
        claiming process could not prove a session, so that a host which
        stopped supplying an id would not lock its own owner out. That was a
        bypass wearing a kindness: any window could run `claim` with no
        identity, drop the binding and own the Work. The seat gate refuses
        first, and the real owner is not locked out forever either -- the
        claim lapses on the ordinary liveness window and the existing
        takeover path applies (see TakeoverStillWorksTests).
        """
        project = Path(fixtures.healthy(self))
        bound = dict(os.environ)
        bound[HOST_SESSION_ENV] = OWNER
        subprocess.run(
            [sys.executable, str(SAIPEN), "start", "add a docstring to src/app.py", "--json"],
            cwd=str(project),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=bound,
            timeout=300,
        )
        board = project / ".saipen" / "BOARD.md"
        self.assertIn("claim_session:", board.read_text(encoding="utf-8"))

        before = board.read_bytes()
        unbound = dict(os.environ)
        unbound.pop(HOST_SESSION_ENV, None)
        reclaim = subprocess.run(
            [sys.executable, str(SAIPEN), "claim", "T-1", "--explicit", "--json"],
            cwd=str(project),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=unbound,
            timeout=300,
        )
        self.assertNotEqual(reclaim.returncode, 0, msg=reclaim.stdout)
        self.assertEqual(board.read_bytes(), before)
        doing = next(
            line
            for line in board.read_text(encoding="utf-8").splitlines()
            if line.startswith("- [/] ")
        )
        self.assertIn("claim_session:", doing)


if __name__ == "__main__":
    unittest.main()
