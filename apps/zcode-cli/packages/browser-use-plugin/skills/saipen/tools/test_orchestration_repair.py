"""Orchestration repair regressions (T-1302): workable scheduling, evidence-based
closure, USER_INTERRUPT persistence, ticket vs goal block, GOAL_BLOCKED stop.

The FastPrompter-class failure: a REVIEW/SHIP ticket with no new code blocked on
exact patch isolation, the scheduler then selected an unworkable release whose
gates were blocked, and the loop stopped while a fresh explicit user request sat
unpersisted. Every test here drives canonical operations only -- no hand-editing
of the project files to force a result.
"""

from __future__ import annotations

import datetime as dt
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.board import is_user_explicit, parse_board, ticket_is_workable  # noqa: E402
from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    checkpoint,
    finish_ticket,
    ticket_add,
    ticket_move,
    transition_phase,
    user_request,
)
from saipen_engine.router import route_next  # noqa: E402
from saipen_engine.state import parse_state  # noqa: E402


class OrchestrationFixture(unittest.TestCase):
    def make_project(self, *, active: bool = False, phase: str | None = None) -> Path:
        base = Path(tempfile.mkdtemp(prefix="saipen-orchestration-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        (project / ".saipen").mkdir(parents=True)
        now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        phase = phase or ("BUILD" if active else "DONE")
        task = "T-7" if active else "none"
        next_action = "PHASE BUILD T-7" if active else "saipen continue"
        transition_from = "SCOUT" if active else "DONE"
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            f"phase: {phase}\n"
            f"task: {task}\n"
            f'next_action: "{next_action}"\n'
            'blocker: ""\n'
            f"transition_from: {transition_from}\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            "agent: tester\n"
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            f'updated: "{now}"\n'
            "---\n",
            encoding="utf-8",
        )
        doing = (
            f"- [/] T-7 [P1] Existing Work | verify: existing proof | "
            f"owner: tester | claim_time: {now}\n"
            if active
            else ""
        )
        (project / ".saipen" / "BOARD.md").write_text(
            f"## DOING\n{doing}## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        ticket = " [T-7]" if active else ""
        (project / ".saipen" / "LOG.md").write_text(
            f"- 24.08.26 00:00 [E-001]{ticket} [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        ensure_project_lineage(project)
        return project

    def state(self, project: Path) -> dict:
        return parse_state((project / ".saipen" / "STATE.md").read_text(encoding="utf-8"))

    def board(self, project: Path) -> dict:
        return parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))

    def route(self, project: Path) -> dict:
        return route_next(
            (project / ".saipen" / "STATE.md").read_text(encoding="utf-8"),
            (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"),
            current_agent="tester",
        )

    def add(
        self,
        project: Path,
        description: str,
        *,
        priority: str = "P1",
        needs: list[str] | None = None,
        verify: str = "verify with a passing test",
    ) -> str:
        result = ticket_add(
            project,
            "tester",
            priority,
            description,
            needs or [],
            verify,
        )
        self.assertTrue(result.ok, result.to_dict())
        return result.data["ticket"]

    def to_ship(self, project: Path, ticket: str) -> None:
        """Drive an active ticket through the canonical BUILD -> VERIFY ->
        REVIEW -> SHIP gates so finish has the closure edge it requires (the
        FastPrompter ticket sat at REVIEW/SHIP when it blocked). A freshly
        claimed ticket starts at SCOUT, so BUILD is only attempted then."""
        steps = [
            ("BUILD", "BUILD: implementation already present, no new diff"),
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
            result = transition_phase(project, destination, "tester", ticket, evidence)
            self.assertTrue(result.ok, result.to_dict())


class BlockedReleaseSchedulingTests(OrchestrationFixture):
    def test_blocked_release_is_never_picked_while_independent_work_exists(self):
        """Spec 17: T-RELEASE depends on blocked gates; independent T-C wins."""
        project = self.make_project()
        gate_a = self.add(project, "release visual gate")
        gate_b = self.add(project, "release sound gate")
        independent = self.add(project, "checkbox indicators square")
        release = self.add(project, "release the wave", needs=[gate_a, gate_b])

        self.assertTrue(ticket_move(project, "block", gate_a, "tester", "gate red").ok)
        self.assertTrue(ticket_move(project, "block", gate_b, "tester", "gate red").ok)

        routed = self.route(project)
        self.assertTrue(routed["ok"], routed)
        self.assertEqual(routed["action"], f"PHASE SCOUT {independent}")
        self.assertEqual(routed["ticket"], independent)
        self.assertNotEqual(routed["ticket"], release)

    def test_no_workable_remainder_reports_goal_blocked(self):
        """Spec 19: only blocked tickets remain -> GOAL_BLOCKED, clean stop."""
        project = self.make_project()
        gate = self.add(project, "release visual gate")
        result = ticket_move(project, "block", gate, "tester", "needs operator HW", scope="goal")
        self.assertTrue(result.ok, result.to_dict())

        routed = self.route(project)
        self.assertTrue(routed["ok"], routed)
        self.assertEqual(routed.get("stop_reason"), "GOAL_BLOCKED")
        self.assertEqual(routed["reason"], "goal-blocked")
        self.assertIn(gate, routed.get("blocked", []))
        self.assertIn(gate, routed.get("goal_blocked", []))


class BlockScopeTests(OrchestrationFixture):
    def test_ticket_scope_block_reroutes_and_does_not_stop(self):
        """Spec 18: blocking the active ticket must continue independent work."""
        project = self.make_project(active=True)
        next_ticket = self.add(project, "independent planned work")

        result = ticket_move(project, "block", "T-7", "tester", "exact patch isolation unavailable")
        self.assertTrue(result.ok, result.to_dict())

        state = self.state(project)
        self.assertNotIn("stop_reason", state)
        self.assertTrue(state["next_action"].endswith(next_ticket), state["next_action"])
        # Restart consistency: recomputing from disk converges to the same pick.
        routed = self.route(project)
        self.assertEqual(routed["action"], state["next_action"])

    def test_goal_scope_block_persists_stop_reason(self):
        """Spec 19: goal-scope block with nothing workable sets GOAL_BLOCKED."""
        project = self.make_project(active=True)
        result = ticket_move(
            project, "block", "T-7", "tester", "operator approval required", scope="goal"
        )
        self.assertTrue(result.ok, result.to_dict())
        state = self.state(project)
        self.assertEqual(state.get("stop_reason"), "GOAL_BLOCKED")

    def test_unblock_clears_stale_stop_reason_and_repicks(self):
        project = self.make_project(active=True)
        self.assertTrue(
            ticket_move(project, "block", "T-7", "tester", "approval required", scope="goal").ok
        )
        self.assertEqual(self.state(project).get("stop_reason"), "GOAL_BLOCKED")

        self.assertTrue(ticket_move(project, "unblock", "T-7", "tester", "approved").ok)
        state = self.state(project)
        self.assertNotIn("stop_reason", state)
        self.assertEqual(state["next_action"], "PHASE SCOUT T-7")


class DependencyContinuationTests(OrchestrationFixture):
    """Active parent -> blocker -> atomic parent continuation contract."""

    def test_parent_parks_blocker_claims_and_child_finish_resumes_parent(self):
        project = self.make_project(active=True)
        child = self.add(project, "required recovery child", priority="P0")
        unrelated = self.add(project, "unrelated queue item")

        parked = ticket_move(
            project,
            "block-for",
            "T-7",
            "tester",
            "child is required before parent closure",
            blocked_on=child,
        )
        self.assertTrue(parked.ok, parked.to_dict())
        board = self.board(project)
        parent = board["tickets"]["T-7"]
        self.assertEqual(parent["section"], "## BLOCKED")
        self.assertEqual(parent["fields"]["blocked_on"], child)
        self.assertIn(child, parent["needs"])
        self.assertEqual(self.route(project)["ticket"], child)

        stolen = apply_claim(project, unrelated, "tester", explicit=True)
        self.assertFalse(stolen.ok)
        self.assertEqual(stolen.code, "CONTINUATION_RESERVED")

        claimed = apply_claim(project, child, "tester")
        self.assertTrue(claimed.ok, claimed.to_dict())
        self.to_ship(project, child)
        self.assertTrue(
            checkpoint(project, "tester", "RUN", child, "dependency acceptance -> PASS").ok
        )
        finished = finish_ticket(project, child, "tester")
        self.assertTrue(finished.ok, finished.to_dict())

        board = self.board(project)
        self.assertEqual(board["tickets"][child]["section"], "## DONE")
        self.assertEqual(board["tickets"]["T-7"]["section"], "## DOING")
        self.assertNotIn("blocked_on", board["tickets"]["T-7"]["fields"])
        state = self.state(project)
        self.assertEqual((state["phase"], state["task"]), ("BUILD", "T-7"))

    def test_child_block_keeps_parent_blocked_without_false_done(self):
        project = self.make_project(active=True)
        child = self.add(project, "required recovery child", priority="P0")
        self.assertTrue(
            ticket_move(
                project,
                "block-for",
                "T-7",
                "tester",
                "child required",
                blocked_on=child,
            ).ok
        )
        self.assertTrue(apply_claim(project, child, "tester").ok)
        self.assertTrue(ticket_move(project, "block", child, "tester", "child failed").ok)
        board = self.board(project)
        self.assertEqual(board["tickets"]["T-7"]["section"], "## BLOCKED")
        self.assertEqual(board["tickets"][child]["section"], "## BLOCKED")
        self.assertNotEqual(board["tickets"]["T-7"]["section"], "## DONE")

    def test_crash_during_handoff_recovers_one_consistent_owner(self):
        project = self.make_project(active=True)
        child = self.add(project, "required recovery child", priority="P0")
        command = [
            sys.executable,
            str(ROOT / "tools" / "saipen.py"),
            "ticket",
            "block-for",
            "T-7",
            child,
            "crash convergence child",
            "--project-root",
            str(project),
            "--json",
        ]
        env = dict(os.environ)
        env["NITRO_CRASH_AFTER_BOARD"] = "1"
        crashed = subprocess.run(command, capture_output=True, text=True, env=env, timeout=60)
        self.assertNotEqual(crashed.returncode, 0)
        recovered = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "saipen.py"),
                "recover",
                "--project-root",
                str(project),
                "--json",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(recovered.returncode, 0, recovered.stderr or recovered.stdout)
        board = self.board(project)
        doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
        self.assertEqual(doing, [])
        self.assertEqual(board["tickets"]["T-7"]["fields"]["blocked_on"], child)
        self.assertEqual(self.route(project)["ticket"], child)


class UserInterruptTests(OrchestrationFixture):
    def test_user_request_persists_before_active_completion(self):
        """Spec 16: receipt + BOARD projection exist immediately; active work untouched."""
        project = self.make_project(active=True)
        result = user_request(project, "tester", "make checkbox indicators square")
        self.assertTrue(result.ok, result.to_dict())
        receipt = result.data.get("receipt")
        ticket = result.data.get("ticket")
        self.assertTrue(receipt, result.data)
        self.assertTrue(ticket, result.data)

        receipt_path = project / ".saipen" / "intake" / "active" / f"{receipt}.md"
        self.assertTrue(receipt_path.is_file(), f"no durable receipt at {receipt_path}")

        board = self.board(project)
        self.assertIn(ticket, board["tickets"])
        self.assertTrue(is_user_explicit(board["tickets"][ticket]))
        fields = board["tickets"][ticket]["fields"]
        self.assertEqual(fields.get("source_receipts"), receipt)
        # Active ticket still claimed and untouched.
        self.assertEqual(board["tickets"]["T-7"]["section"], "## DOING")

    def test_user_request_survives_active_ticket_block(self):
        """The FastPrompter regression core: block of the active ticket must not
        lose the new request, and the scheduler must route to it."""
        project = self.make_project(active=True)
        request = user_request(project, "tester", "make checkbox indicators square")
        self.assertTrue(request.ok, request.to_dict())
        new_ticket = request.data["ticket"]
        # Planned work filed AFTER the request, above it in TODO order.
        planned = self.add(project, "speculative improvement")

        self.assertTrue(
            ticket_move(project, "block", "T-7", "tester", "exact patch isolation unavailable").ok
        )
        state = self.state(project)
        self.assertTrue(state["next_action"].endswith(new_ticket), state["next_action"])
        routed = self.route(project)
        self.assertEqual(routed["reason"], "start-user-explicit")
        self.assertEqual(routed["ticket"], new_ticket)
        self.assertNotEqual(routed["ticket"], planned)
        # New ticket survived the block.
        board = self.board(project)
        self.assertEqual(board["tickets"][new_ticket]["section"], "## TODO")


class ClosureProvenanceTests(OrchestrationFixture):
    def _with_published_release(self, project: Path) -> str:
        """Durable publication evidence: the implementation the verification-only
        ticket inherits was already released. This is scenario setup (the
        authority FINDING 3 resolves against), not a closure shortcut."""
        import json

        (project / ".saipen" / "kitchen").mkdir(parents=True, exist_ok=True)
        (project / ".saipen" / "kitchen" / "release_receipt.json").write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "op_id": "release-abc123",
                    "version": "0.4.2",
                    "tag": "v0.4.2",
                    "commit": "c0ffee",
                }
            ),
            encoding="utf-8",
        )
        return "release:v0.4.2"

    def test_inherited_verified_closure_without_patch(self):
        """Spec 10/15/32 + FINDING 3: verification-only closeout records durable
        implementation provenance and never needs an isolated patch or a Git
        commit."""
        project = self.make_project(active=True)
        source = self._with_published_release(project)
        self.to_ship(project, "T-7")
        result = finish_ticket(
            project,
            "T-7",
            "tester",
            closure_mode="inherited_verified",
            implementation_source=source,
        )
        self.assertTrue(result.ok, result.to_dict())

        board = self.board(project)
        done = board["tickets"]["T-7"]
        self.assertEqual(done["section"], "## DONE")
        fields = done["fields"]
        self.assertEqual(fields.get("closure_mode"), "inherited_verified")
        self.assertEqual(fields.get("implementation_delta"), "none")
        self.assertEqual(fields.get("implementation_source"), source)
        self.assertTrue(str(fields.get("verify", "")).strip())
        # No commit exists; the closure is state evidence, not publication.
        self.assertFalse((project / ".git").exists())
        # State converged: no active ticket, board has no workable remainder.
        state = self.state(project)
        self.assertEqual(state["next_action"], "saipen continue")

    def test_inherited_verified_refuses_without_source(self):
        """FINDING 3: an unsupported "implementation already existed" assertion
        must not close -- the durable authority is mandatory."""
        project = self.make_project(active=True)
        self.to_ship(project, "T-7")
        result = finish_ticket(project, "T-7", "tester", closure_mode="inherited_verified")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertIn("--implementation-source", result.message)
        board = self.board(project)
        self.assertEqual(board["tickets"]["T-7"]["section"], "## DOING")

    def test_inherited_verified_refuses_unresolvable_source(self):
        """FINDING 3: the named authority must resolve to durable evidence."""
        project = self.make_project(active=True)
        self.to_ship(project, "T-7")
        result = finish_ticket(
            project,
            "T-7",
            "tester",
            closure_mode="inherited_verified",
            implementation_source="release:v9.9.9",
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertIn("cannot be resolved", result.message)

    def test_own_patch_is_default_and_explicit(self):
        project = self.make_project(active=True)
        self.to_ship(project, "T-7")
        result = finish_ticket(project, "T-7", "tester")
        self.assertTrue(result.ok, result.to_dict())
        fields = self.board(project)["tickets"]["T-7"]["fields"]
        self.assertEqual(fields.get("closure_mode"), "own_patch")
        self.assertNotIn("implementation_delta", fields)

    def test_cohort_closure_records_membership(self):
        project = self.make_project(active=True)
        import json

        # The shared accumulated bytes both members attribute (FastPrompter's
        # main.py). The cohort binds the LIVE hash -- no per-ticket split.
        (project / "main.py").write_text("shared = True\n", encoding="utf-8")
        second = self.add(project, "overlapping work")
        # Close the active ticket into the cohort first (one open claim), then
        # claim and close the second member the same way.
        self.to_ship(project, "T-7")
        r1 = finish_ticket(
            project,
            "T-7",
            "tester",
            closure_mode="cohort",
            closure_cohort="C-001",
            closure_paths=("main.py",),
        )
        claim = apply_claim(project, second, "tester", explicit=True)
        self.assertTrue(claim.ok, claim.to_dict())
        self.to_ship(project, second)
        r2 = finish_ticket(
            project,
            second,
            "tester",
            closure_mode="cohort",
            closure_cohort="C-001",
            closure_paths=("main.py",),
        )
        self.assertTrue(r1.ok, r1.to_dict())
        self.assertTrue(r2.ok, r2.to_dict())
        board = self.board(project)
        for tid in ("T-7", second):
            fields = board["tickets"][tid]["fields"]
            self.assertEqual(fields.get("closure_mode"), "cohort")
            self.assertEqual(fields.get("closure_cohort"), "C-001")
        # FINDING 4: durable cohort authority, not BOARD prose -- membership
        # binds each ticket to the exact shared-bytes identity.
        registry = json.loads(
            (project / ".saipen" / "kitchen" / "cohort_registry.json").read_text(
                encoding="utf-8"
            )
        )
        cohort = registry["cohorts"]["C-001"]
        self.assertEqual(cohort["publication_status"], "pending")
        self.assertEqual(
            set(cohort["members"]), {"T-7", second}, cohort["members"]
        )
        for member, record in cohort["members"].items():
            # Hash of the LIVE bytes on disk (write_text may newline-translate).
            from saipen_engine.operations import hash_bytes

            self.assertEqual(
                record["paths"]["main.py"],
                hash_bytes((project / "main.py").read_bytes()),
            )

    def test_cohort_closure_requires_cohort_id(self):
        project = self.make_project(active=True)
        self.to_ship(project, "T-7")
        result = finish_ticket(project, "T-7", "tester", closure_mode="cohort")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "VALIDATION_FAILED")
        board = self.board(project)
        self.assertEqual(board["tickets"]["T-7"]["section"], "## DOING")


class WorkabilityPropertyTests(OrchestrationFixture):
    def test_workable_requires_done_dependencies(self):
        project = self.make_project()
        gate = self.add(project, "gate")
        child = self.add(project, "child", needs=[gate])
        board = self.board(project)
        tickets = board["tickets"]
        self.assertFalse(ticket_is_workable(tickets[child], tickets, agent="tester"))
        # A blocked dependency is not DONE, so it is not workable either.
        self.assertTrue(ticket_move(project, "block", gate, "tester", "red").ok)
        board = self.board(project)
        tickets = board["tickets"]
        self.assertFalse(ticket_is_workable(tickets[child], tickets, agent="tester"))
        self.assertFalse(ticket_is_workable(tickets[gate], tickets, agent="tester"))

    def test_blocking_one_ticket_never_deletes_another(self):
        """Spec 35-E: blocking one ticket cannot delete another ticket/receipt."""
        project = self.make_project(active=True)
        request = user_request(project, "tester", "make checkbox indicators square")
        new_ticket = request.data["ticket"]
        before = self.board(project)
        self.assertIn(new_ticket, before["tickets"])
        self.assertTrue(ticket_move(project, "block", "T-7", "tester", "blocked").ok)
        after = self.board(project)
        self.assertIn(new_ticket, after["tickets"])
        self.assertIn("T-7", after["tickets"])
        receipt = request.data["receipt"]
        self.assertTrue((project / ".saipen" / "intake" / "active" / f"{receipt}.md").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
