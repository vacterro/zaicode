"""Dependency resume must not synthesize live ownership (T-1436, SRC-092).

Measured on E-7715/E-7716: the finish-child transaction that resumes a
dependency-blocked parent wrote ``owner`` + a fresh ``claim_time`` and no
``claim_session``, so a parent resumed by a mechanical dependency event looked
like a live 15-minute claim -- every other agent got WAIT_FOREIGN_OWNER for a
session that never reclaimed the seat.

These controls hold the fixed contract:

  RED 1  stale/foreign session resume -> parent is UNCLAIMED and adoptable at
         once (the pre-fix synthetic shape is proven able to block, below).
  RED 2  the SAME mechanically-proven live session closing the child retains
         the lease (owner + fresh claim_time + current binding).
  RED 3  a historical owner NAME alone is never FOREIGN_LIVE.
  RED 4  dependency completion is not a claim event (DEC line; no claim write).
  RED 5  a queued explicit user Source wakes through canonical routing when
         the seat frees -- no operator retyping.
  RED 6  repeated receipt-form `start` against a truly live foreign owner is a
         stable, zero-mutation refusal with no duplicate Source.

Run standalone:
    python tools/test_dependency_resume_liveness.py
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import test_t1363_zero_manual_entry as fixtures  # noqa: E402
from saipen_engine import intake  # noqa: E402
from saipen_engine.board import claim_session_digest, claim_status, parse_board  # noqa: E402
from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    checkpoint,
    finish_ticket,
    ticket_add,
    ticket_move,
    transition_phase,
)
from saipen_engine.paths import (  # noqa: E402
    project_lineage_identity,
    unbound_environment,
)
from saipen_engine.router import queued_source_projection, route_next  # noqa: E402
from saipen_engine.state import parse_state  # noqa: E402

SAIPEN = TOOLS / "saipen.py"
AGENT = "tester"
OTHER = "other_agent"
SESSION_A = "ses_resume_liveness_A"
SESSION_B = "ses_resume_liveness_B"


@contextlib.contextmanager
def session_env(session_id: str | None):
    """Patch SAIPEN_HOST_SESSION for in-process canonical operations."""
    if session_id is None:
        env = {key: value for key, value in os.environ.items() if key != "SAIPEN_HOST_SESSION"}
        with mock.patch.dict(os.environ, env, clear=True):
            yield
        return
    with mock.patch.dict(os.environ, {"SAIPEN_HOST_SESSION": session_id}, clear=False):
        yield


class ResumeFixture(unittest.TestCase):
    def make_project(self) -> Path:
        base = Path(tempfile.mkdtemp(prefix="saipen-resume-liveness-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        (project / ".saipen").mkdir(parents=True)
        now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: DONE\n"
            "task: none\n"
            'next_action: "saipen continue"\n'
            'blocker: ""\n'
            "transition_from: SHIP\n"
            "saipen_version: 8\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            f'agent: "{AGENT}"\n'
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            f'updated: "{now}"\n'
            "---\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (project / ".saipen" / "LOG.md").write_text(
            f"- 21.09.26 00:00 [E-001] [agent: {AGENT}] DEC: fixture\n",
            encoding="utf-8",
        )
        (project / "VERSION").write_text("8.0.1\n", encoding="utf-8")
        ensure_project_lineage(project)
        return project

    def add(self, project: Path, description: str, priority: str = "P1") -> str:
        result = ticket_add(
            project, AGENT, priority, description, [], "verified by the focused suite"
        )
        self.assertTrue(result.ok, result.to_dict())
        return result.data["ticket"]

    def state(self, project: Path) -> dict:
        return parse_state((project / ".saipen" / "STATE.md").read_text(encoding="utf-8"))

    def tickets(self, project: Path) -> dict:
        return parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))[
            "tickets"
        ]

    def log_text(self, project: Path) -> str:
        return (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")

    def to_ship(self, project: Path, ticket: str) -> None:
        steps = [
            ("BUILD", "BUILD: implementation already present"),
            ("VERIFY", "VERIFY: PASS all acceptance checks conf: high"),
            ("REVIEW", "REVIEW: PASS no objections"),
            ("SHIP", "SHIP: PASS release gates"),
        ]
        current = self.state(project).get("phase", "")
        if current == "SHIP":
            steps = steps[3:]
        elif current == "REVIEW":
            steps = steps[2:]
        elif current in ("VERIFY", "BUILD"):
            steps = steps[1:]
        for destination, evidence in steps:
            result = transition_phase(project, destination, AGENT, ticket, evidence)
            self.assertTrue(result.ok, result.to_dict())

    def parked_child(self, project: Path) -> tuple[str, str]:
        """Parent parked FOR the child; the child finishes in SHIP."""
        parent = self.add(project, "parent work resumed by dependency")
        child = self.add(project, "child the parent waits for", priority="P0")
        self.assertTrue(apply_claim(project, parent, AGENT, explicit=True).ok)
        parked = ticket_move(
            project,
            "block-for",
            parent,
            AGENT,
            "child is required before parent closure",
            blocked_on=child,
        )
        self.assertTrue(parked.ok, parked.to_dict())
        self.assertTrue(apply_claim(project, child, AGENT).ok)
        self.to_ship(project, child)
        self.assertTrue(
            checkpoint(project, AGENT, "RUN", child, "dependency acceptance -> PASS").ok
        )
        return parent, child

    def finish_child(self, project: Path, child: str) -> None:
        finished = finish_ticket(project, child, AGENT)
        self.assertTrue(finished.ok, finished.to_dict())


class StaleResumeTests(ResumeFixture):
    def test_red1_foreign_session_resume_is_unclaimed_and_adoptable(self) -> None:
        project = self.make_project()
        with session_env(SESSION_A):
            parent, child = self.parked_child(project)
        with session_env(SESSION_B):
            self.finish_child(project, child)

        record = self.tickets(project)[parent]
        self.assertEqual(record["section"], "## DOING")
        for field in ("owner", "claim_time", "claim_session"):
            self.assertNotIn(field, record["fields"], record["fields"])
        self.assertEqual(claim_status(record, OTHER), "UNCLAIMED")
        # RED 3: the historical owner NAME alone is never a live claim.
        self.assertNotEqual(claim_status(record, "astra"), "FOREIGN_LIVE")
        adopted = apply_claim(project, parent, OTHER, explicit=True)
        self.assertTrue(adopted.ok, adopted.to_dict())
        self.assertEqual(self.tickets(project)[parent]["fields"]["owner"], OTHER)

    def test_red1_control_the_synthetic_shape_still_blocks(self) -> None:
        """The property asserted above can fail: the pre-fix synthesized claim
        (owner + fresh claim_time, no binding) reads FOREIGN_LIVE to another
        agent and is not adoptable. Without the fix the red assertion above is
        exactly this state."""
        project = self.make_project()
        with session_env(SESSION_A):
            parent, child = self.parked_child(project)
        with session_env(SESSION_B):
            self.finish_child(project, child)
        now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        board_path = project / ".saipen" / "BOARD.md"
        board = board_path.read_text(encoding="utf-8")
        lines = board.splitlines(keepends=True)
        for index, line in enumerate(lines):
            if line.startswith("- [/] " + parent + " "):
                lines[index] = line.rstrip("\n") + f" | owner: {AGENT} | claim_time: {now}\n"
                break
        board_path.write_text("".join(lines), encoding="utf-8")
        record = self.tickets(project)[parent]
        self.assertEqual(claim_status(record, OTHER), "FOREIGN_LIVE")
        refused = apply_claim(project, parent, OTHER, explicit=True)
        self.assertFalse(refused.ok)
        self.assertIn(refused.code, ("TICKET_NOT_WORKABLE", "ALREADY_CLAIMED"), refused.to_dict())

    def test_red2_same_live_session_retains_the_lease(self) -> None:
        project = self.make_project()
        with session_env(SESSION_A):
            parent, child = self.parked_child(project)
            self.finish_child(project, child)
            record = self.tickets(project)[parent]
            expected = claim_session_digest(project_lineage_identity(project), SESSION_A)
            self.assertEqual(record["fields"].get("owner"), AGENT)
            self.assertEqual(record["fields"].get("claim_session"), expected)
            self.assertTrue(record["fields"].get("claim_time"))
            self.assertEqual(claim_status(record, OTHER), "FOREIGN_LIVE")
            self.assertEqual(claim_status(record, AGENT), "SELF")

    def test_red4_dependency_completion_is_not_a_claim_event(self) -> None:
        project = self.make_project()
        with session_env(SESSION_A):
            parent, child = self.parked_child(project)
        with session_env(SESSION_B):
            self.finish_child(project, child)
        log = self.log_text(project)
        resume_lines = [
            line
            for line in log.splitlines()
            if "blocked parent resumed after dependency" in line
        ]
        self.assertEqual(len(resume_lines), 1, resume_lines)
        self.assertIn("not a claim event", resume_lines[0])
        self.assertIn(f"previous owner {AGENT}", resume_lines[0])
        self.assertIn(f"[{parent}]", resume_lines[0])
        # RED 4: no claim write happened for the parent inside the finish op:
        # the only claim event it owns is the original one.
        claim_lines = [
            line
            for line in log.splitlines()
            if "claimed via SAIOPS" in line and f"[{parent}]" in line
        ]
        self.assertEqual(len(claim_lines), 1, claim_lines)


class QueuedSourceWakeTests(ResumeFixture):
    BOARD_EMPTY = "## DOING\n## TODO\n## DONE\n## BLOCKED\n"

    def test_red5_router_starts_the_queued_source_before_backlog(self) -> None:
        project = self.make_project()
        self.add(project, "ordinary backlog item")
        state_text = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        board_text = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        plain = route_next(state_text, board_text, current_agent=AGENT)
        self.assertEqual(plain["reason"], "start")
        queued = route_next(
            state_text,
            board_text,
            current_agent=AGENT,
            queued_source={
                "action": "saipen start --receipt SRC-005",
                "receipt": "SRC-005",
                "detail": "queued",
            },
        )
        self.assertTrue(queued["ok"], queued)
        self.assertEqual(queued["reason"], "queued-source")
        self.assertEqual(queued["action"], "saipen start --receipt SRC-005")

    def test_red5_captured_user_source_wakes_and_projects(self) -> None:
        project = self.make_project()
        body = (
            "# User request\n\n"
            "priority: P1\n"
            "verify: the queued request is executed\n\n"
            "## Request\n\n"
            "queued operator request while the seat was busy\n"
        )
        captured = intake.capture(project, body, source_kind="user_instruction")
        self.assertTrue(captured.get("ok"), captured)
        receipt = captured["receipt"]
        projection = queued_source_projection(project)
        self.assertIsNotNone(projection, projection)
        self.assertEqual(projection["action"], f"saipen start --receipt {receipt}")

        done = subprocess.run(
            [sys.executable, str(SAIPEN), "start", "--receipt", receipt, "--json"],
            cwd=str(project),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=unbound_environment(SAIPEN_HOST_SESSION=SESSION_A),
            timeout=300,
        )
        payload = json.loads(done.stdout or "{}")
        self.assertTrue(payload.get("ok"), payload)
        ticket = payload.get("ticket")
        self.assertTrue(ticket, payload)
        self.assertEqual(self.tickets(project)[ticket]["section"], "## DOING")
        meta = intake._read_meta(project, receipt) or {}
        self.assertEqual(meta.get("linked_work"), ticket)
        self.assertIsNone(queued_source_projection(project))


class LiveForeignSeatStabilityTests(ResumeFixture):
    def test_red6_repeated_receipt_start_is_stable_and_zero_mutation(self) -> None:
        project = Path(fixtures.foreign_owner_project(self))
        board_path = project / ".saipen" / "BOARD.md"
        before = board_path.read_bytes()
        command = [sys.executable, str(SAIPEN), "start", "--json"]
        env = unbound_environment(SAIPEN_HOST_SESSION=SESSION_B)
        first = subprocess.run(
            [*command, "add a queued request"],
            cwd=str(project),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
        )
        payload = json.loads(first.stdout or "{}")
        self.assertEqual(payload.get("code"), "WAIT_FOREIGN_OWNER")
        receipt = payload.get("receipt")
        self.assertTrue(str(receipt).startswith("SRC-"), payload)
        after_capture = board_path.read_bytes()
        self.assertEqual(before, after_capture)

        second = subprocess.run(
            [*command, "--receipt", receipt],
            cwd=str(project),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=300,
        )
        repeat = json.loads(second.stdout or "{}")
        self.assertEqual(repeat.get("code"), "WAIT_FOREIGN_OWNER")
        self.assertIsNone(repeat.get("resume_command"), repeat)
        self.assertIn("already queued", str(repeat.get("detail")))
        self.assertEqual(after_capture, board_path.read_bytes())
        active = intake.active_receipts(project)
        matching = [item for item in active if item.get("receipt") == receipt]
        self.assertEqual(len(matching), 1, active)


if __name__ == "__main__":
    unittest.main(verbosity=2)
