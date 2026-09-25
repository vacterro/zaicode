"""SRC-104 / T-1461: operational appends become mission state at any phase.

The failure: an operator hands the running mission one more requirement file
and the agent answers with a summary. Nothing reaches BOARD, coverage or
routing, so the requirement lives only in a transcript the next model never
sees. The repair is one owner (`saipen_engine.source_append`) that makes the
bytes durable against the controlling mission source, projects them into
traceable clauses bound to the mission's Work, supersedes what they replace,
rewinds only as far as the delta requires, and makes `continue` route -- and
execute -- the projection before any phase continuation.

The twenty numbered controls below are the SRC-104 test matrix, in order.
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_dependency_resume_liveness import AGENT, ResumeFixture  # noqa: E402

from saipen_engine import intake, source_append  # noqa: E402
from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    checkpoint,
    finish_ticket,
    ticket_move,
    transition_phase,
)
from saipen_engine.router import pending_append_projection, route_next  # noqa: E402

SAIPEN = TOOLS / "saipen.py"

MISSION = (
    "# User request\n\n"
    "priority: P1\n"
    "verify: the launcher mission is implemented\n\n"
    "## Request\n\n"
    "Make the launcher mission robust.\n"
)
BRICKS = [
    "The launcher must classify MANAGED_AVAILABLE before launch.",
    "The launcher must classify MANAGED_UNAVAILABLE_BUT_DIRECT_SAFE.",
    "Do not use fragile error-code allowlists.",
    "Direct launch must establish project root and executable first.",
    "Never launch when process safety cannot be established.",
    "Status must show which launch class was chosen.",
    "The fallback must be recorded in LOG.",
    "Do not block a recoverable binding failure.",
    "A regression test must cover every launch class.",
    "The launcher must refuse DIRECT_LAUNCH_UNSAFE_OR_IMPOSSIBLE.",
]


class AppendFixture(ResumeFixture):
    def mission(self, project: Path, phase: str = "BUILD") -> tuple[str, str]:
        """Claimed mission Work T-x linked to its source, advanced to `phase`."""
        work = self.add(project, "launcher mission")
        captured = intake.capture(project, MISSION, source_kind="user_instruction", work=work)
        self.assertTrue(captured.get("ok"), captured)
        self.assertTrue(apply_claim(project, work, AGENT, explicit=True).ok)
        order = ["SCOUT", "BUILD", "VERIFY", "REVIEW", "SHIP"]
        for step in order[1 : order.index(phase) + 1]:
            if step == "REVIEW":
                self.assertTrue(
                    checkpoint(project, AGENT, "RUN", work,
                               f"verify -> PASS [target: {work}] conf: high -- fixture").ok
                )
            moved = transition_phase(project, step, AGENT, work, f"{step}: fixture")
            self.assertTrue(moved.ok, moved.to_dict())
        return work, captured["receipt"]

    def append(self, project: Path, body: str, **kwargs) -> dict:
        result = source_append.append(project, body, actor=AGENT, **kwargs)
        self.assertTrue(result.get("ok"), result)
        return result

    def project_it(self, project: Path, receipt: str) -> dict:
        result = source_append.apply_append(project, receipt, actor=AGENT)
        self.assertTrue(result.get("ok"), result)
        return result

    def phase(self, project: Path) -> str:
        return self.state(project).get("phase", "")

    def clause_texts(self, project: Path, receipt: str) -> set[str]:
        contract = intake._read_contract(project, receipt) or {}
        return {clause["text"] for clause in (contract.get("clauses") or {}).values()}

    def cli(self, project: Path, *args: str) -> dict:
        done = subprocess.run(
            [sys.executable, str(SAIPEN), *args, "--json"],
            cwd=str(project), capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=300,
        )
        return json.loads(done.stdout or "{}")


class PhaseMatrixTests(AppendFixture):
    def test_01_append_while_build_stays_in_build(self):
        project = self.make_project()
        work, source = self.mission(project, "BUILD")
        received = self.append(project, BRICKS[0])
        projected = self.project_it(project, received["receipt"])
        self.assertEqual(self.phase(project), "BUILD")
        self.assertEqual(projected["work"], work)
        self.assertIsNone(projected["rewind"])
        self.assertIn(BRICKS[0], self.clause_texts(project, received["receipt"]))
        meta = intake._read_meta(project, received["receipt"]) or {}
        self.assertEqual(meta.get("amends"), source)
        self.assertIn(work, intake.linked_works(meta))

    def test_02_implementation_append_in_verify_rewinds_to_build(self):
        project = self.make_project()
        work, _source = self.mission(project, "VERIFY")
        received = self.append(project, BRICKS[1], delta="implementation")
        projected = self.project_it(project, received["receipt"])
        self.assertEqual(projected["rewind"], {"from": "VERIFY", "to": "BUILD", "work": work})
        self.assertEqual(self.phase(project), "BUILD")

    def test_03_append_to_a_done_mission_projects_new_work(self):
        project = self.make_project()
        work, source = self.mission(project, "SHIP")
        self.assertTrue(
            checkpoint(project, AGENT, "RUN", work, "mission acceptance -> PASS").ok
        )
        finished = finish_ticket(project, work, AGENT)
        self.assertTrue(finished.ok, finished.to_dict())
        received = self.append(project, BRICKS[2], to=source)
        projected = self.project_it(project, received["receipt"])
        created = projected["created_work"]
        self.assertTrue(created and created != work, projected)
        self.assertEqual(self.tickets(project)[created]["section"], "## TODO")
        routed = self.cli(project, "next")
        self.assertIn(created, str(routed.get("action")), routed)

    def test_04_external_blocker_is_preserved_while_the_append_projects(self):
        project = self.make_project()
        work, _source = self.mission(project, "BUILD")
        parked = self.add(project, "external gate", priority="P2")
        blocked = ticket_move(project, "block", parked, AGENT,
                              "BLOCKED_EXTERNAL -- waiting on a vendor")
        self.assertTrue(blocked.ok, blocked.to_dict())
        received = self.append(project, BRICKS[3])
        self.project_it(project, received["receipt"])
        self.assertEqual(self.tickets(project)[parked]["section"], "## BLOCKED")
        self.assertEqual(self.phase(project), "BUILD")
        self.assertEqual(self.state(project).get("task"), work)


class IdentityTests(AppendFixture):
    def test_05_identical_append_twice_is_one_append(self):
        project = self.make_project()
        self.mission(project, "BUILD")
        first = self.append(project, BRICKS[4])
        second = self.append(project, BRICKS[4])
        self.assertEqual(second["code"], "ALREADY_APPENDED")
        self.assertEqual(second["receipt"], first["receipt"])
        ledger = source_append.read_ledger(project, first["source"])
        self.assertEqual(len(ledger["appends"]), 1)

    def test_06_a_changed_version_is_a_distinct_append(self):
        project = self.make_project()
        self.mission(project, "BUILD")
        first = self.append(project, BRICKS[5])
        second = self.append(project, BRICKS[5] + " It must also name the reason.")
        self.assertNotEqual(first["receipt"], second["receipt"])
        self.assertEqual(second["seq"], 2)

    def test_07_newer_requirement_supersedes_the_older_one(self):
        project = self.make_project()
        self.mission(project, "BUILD")
        old = self.append(project, "Invalid SAIPEN binding must block launch.")
        self.project_it(project, old["receipt"])
        old_rid = f"{old['receipt']}:R001"
        new = self.append(
            project,
            "Recoverable invalid SAIPEN binding must fall back to direct launch.",
            klass=source_append.CONFLICT,
            supersedes=[old_rid],
        )
        self.project_it(project, new["receipt"])
        coverage = intake._read_coverage(project, old["receipt"])
        self.assertEqual(coverage["requirements"][old_rid]["disposition"], "SUPERSEDED")
        self.assertIn(new["receipt"], coverage["requirements"][old_rid]["evidence"])
        fresh = intake._read_coverage(project, new["receipt"])
        self.assertEqual(
            {row["disposition"] for row in fresh["requirements"].values()}, {"UNKNOWN"}
        )

    def test_08_ten_bricks_equal_one_consolidated_handoff(self):
        bricks_project = self.make_project()
        self.mission(bricks_project, "BUILD")
        brick_clauses: set[str] = set()
        for brick in BRICKS:
            received = self.append(bricks_project, brick)
            self.project_it(bricks_project, received["receipt"])
            brick_clauses |= self.clause_texts(bricks_project, received["receipt"])
        mega_project = self.make_project()
        self.mission(mega_project, "BUILD")
        mega = self.append(mega_project, "\n\n".join(BRICKS))
        self.project_it(mega_project, mega["receipt"])
        self.assertEqual(self.clause_texts(mega_project, mega["receipt"]), brick_clauses)
        self.assertEqual(len(brick_clauses), len(BRICKS))

    def test_09_a_mega_handoff_projects_in_one_operation_without_ticket_explosion(self):
        project = self.make_project()
        self.mission(project, "BUILD")
        before = len(self.tickets(project))
        milestones = "\n\n".join(
            f"{n}. MILESTONE {n}\n\nThe runner must complete milestone {n} before {n + 1}.\n"
            f"Do not skip milestone {n}."
            for n in range(1, 21)
        )
        received = self.append(project, milestones)
        projected = self.project_it(project, received["receipt"])
        self.assertEqual(len(projected["derived_clauses"]), 40)
        self.assertEqual(
            len(self.tickets(project)), before, "a mega handoff is not a ticket per line"
        )
        ledger = source_append.read_ledger(project, received["source"])
        self.assertEqual(len(ledger["appends"]), 1)


class ContinuityTests(AppendFixture):
    def test_10_a_cold_session_resumes_the_append_from_disk(self):
        project = self.make_project()
        work, _source = self.mission(project, "BUILD")
        received = self.append(project, BRICKS[6])
        # A new session: no memory, only the repository. `cc` projects the
        # durable append and lands back on the mission's phase action.
        continued = self.cli(project, "continue")
        trace = continued.get("continue_trace") or []
        self.assertTrue(any(step.get("operation") == "apply_append" for step in trace), continued)
        ledger = source_append.read_ledger(project, received["source"])
        self.assertEqual(ledger["appends"][0]["state"], source_append.PROJECTED)
        self.assertIn(work, str(continued.get("canonical_next_action") or continued.get("action")))

    def test_11_an_operational_file_is_executed_not_summarized(self):
        project = self.make_project()
        work, _source = self.mission(project, "BUILD")
        handoff = project.parent / "GENERALIZED RECOVERABLE SAIPEN.md"
        handoff.write_text(
            "Recoverable SAIPEN binding failures must fall back to direct OpenCode launch.\n\n"
            "Classify MANAGED_AVAILABLE, MANAGED_UNAVAILABLE_BUT_DIRECT_SAFE and\n"
            "DIRECT_LAUNCH_UNSAFE_OR_IMPOSSIBLE from safety preconditions; do not use\n"
            "fragile error-code allowlists.\n",
            encoding="utf-8",
        )
        received = self.cli(project, "source", "append", "--file", str(handoff))
        self.assertEqual(received.get("code"), "APPEND_RECEIVED", received)
        routed = self.cli(project, "next")
        self.assertEqual(routed.get("reason"), "unprojected-source-append", routed)
        continued = self.cli(project, "continue")
        self.assertNotEqual(continued.get("reason"), "maintain", continued)
        self.assertEqual(self.phase(project), "BUILD")
        self.assertIn(received["receipt"], str(self.tickets(project)[work]["fields"]))

    def test_12_an_already_implemented_clause_is_not_duplicated(self):
        project = self.make_project()
        self.mission(project, "VERIFY")
        received = self.append(project, BRICKS[7], delta="evidence")
        added = intake.add_requirement(project, received["receipt"], rid="R001", text=BRICKS[7])
        self.assertTrue(added.get("ok"), added)
        projected = self.project_it(project, received["receipt"])
        self.assertEqual(projected["derived_clauses"], [f"{received['receipt']}:R001"])
        self.assertIsNone(projected["rewind"], "evidence-only delta never rewinds")
        self.assertEqual(self.phase(project), "VERIFY")

    def test_13_repository_truth_outranks_stale_handoff_planning(self):
        project = self.make_project()
        work, _source = self.mission(project, "VERIFY")
        stale = (
            f"Planning: {work} is still in SCOUT, restart it there.\n\n"
            "The launcher must record which class it chose."
        )
        received = self.append(project, stale)
        projected = self.project_it(project, received["receipt"])
        self.assertEqual(projected["rewind"]["from"], "VERIFY")
        self.assertEqual(self.phase(project), "BUILD", "the handoff's SCOUT claim is ignored")

    def test_14_the_source_stays_immutable_and_append_provenance_is_durable(self):
        project = self.make_project()
        _work, source = self.mission(project, "BUILD")
        body_path = project / ".saipen" / "intake" / "active" / f"{source}.md"
        before = body_path.read_bytes()
        received = self.append(project, BRICKS[8], label="regression brick")
        self.project_it(project, received["receipt"])
        self.assertEqual(body_path.read_bytes(), before)
        self.assertTrue(intake.verify_integrity(project, source)["ok"])
        entry = source_append.read_ledger(project, source)["appends"][0]
        for field in ("receipt", "seq", "class", "delta", "received_at", "source_sha256",
                      "derived_clauses", "work", "projected_at"):
            with self.subTest(field=field):
                self.assertIn(field, entry)
        self.assertEqual(entry["label"], "regression brick")

    def test_15_continue_routes_an_unprojected_append_first(self):
        project = self.make_project()
        work, _source = self.mission(project, "BUILD")
        received = self.append(project, BRICKS[9])
        projection = pending_append_projection(project)
        routed = route_next(
            (project / ".saipen" / "STATE.md").read_text(encoding="utf-8"),
            (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"),
            current_agent=AGENT,
            pending_append=projection,
        )
        self.assertEqual(routed["reason"], "unprojected-source-append")
        self.assertEqual(routed["action"], f"saipen source apply-append {received['receipt']}")
        self.assertEqual(routed["ticket"], work)
        self.assertEqual(routed["source_receipt"], received["source"])

    def test_16_a_crash_mid_projection_is_completed_not_duplicated(self):
        # T-1462: the clauses are ONE transaction now, so "mid-projection" is
        # either inside it (nothing of it lands) or right after it commits
        # (every clause landed, the step was never marked). Both resume to the
        # same four clauses, never eight.
        real_mark = source_append._mark_step

        def crash_after_derive(root, source, receipt, step):
            if step == "derived":
                raise OSError("simulated crash after the clause transaction")
            return real_mark(root, source, receipt, step)

        crashes = {
            "inside": mock.patch.object(
                intake, "add_requirements", side_effect=OSError("simulated crash in it")
            ),
            "after": mock.patch.object(source_append, "_mark_step", crash_after_derive),
        }
        for where, crash in crashes.items():
            with self.subTest(crash=where):
                project = self.make_project()
                self.mission(project, "BUILD")
                received = self.append(project, "\n\n".join(BRICKS[:4]))
                with crash, self.assertRaises(OSError):
                    source_append.apply_append(project, received["receipt"], actor=AGENT)
                entry = source_append.read_ledger(project, received["source"])["appends"][0]
                self.assertEqual(
                    entry["state"], source_append.RECEIVED, "a crash never claims PROJECTED"
                )
                self.project_it(project, received["receipt"])
                self.assertEqual(self.clause_texts(project, received["receipt"]), set(BRICKS[:4]))
                again = source_append.apply_append(project, received["receipt"], actor=AGENT)
                self.assertEqual(again["code"], "ALREADY_PROJECTED")

    def test_16b_every_clause_lands_in_one_transaction(self):
        """T-1462: N derived clauses are one contract revision, not N."""
        project = self.make_project()
        self.mission(project, "BUILD")
        received = self.append(project, "\n\n".join(BRICKS[:4]))
        real = intake.add_requirements
        calls = []

        def counting(root, receipt, clauses):
            calls.append(len(clauses))
            return real(root, receipt, clauses)

        with mock.patch.object(intake, "add_requirements", counting), \
                mock.patch.object(intake, "add_requirement", side_effect=AssertionError(
                    "the per-clause transaction is not the projection path")):
            self.project_it(project, received["receipt"])
        self.assertEqual(calls, [4])
        contract = intake._read_contract(project, received["receipt"])
        self.assertEqual(contract["interpretation_revision"], 1)
        self.assertEqual(self.clause_texts(project, received["receipt"]), set(BRICKS[:4]))

    def test_17_repeated_content_never_produces_duplicate_work(self):
        project = self.make_project()
        work, source = self.mission(project, "SHIP")
        self.assertTrue(checkpoint(project, AGENT, "RUN", work, "acceptance -> PASS").ok)
        self.assertTrue(finish_ticket(project, work, AGENT).ok)
        first = self.append(project, BRICKS[0], to=source)
        created = self.project_it(project, first["receipt"])["created_work"]
        repeat = self.append(project, BRICKS[0], to=source)
        self.assertEqual(repeat["code"], "ALREADY_APPENDED")
        again = source_append.apply_append(project, repeat["receipt"], actor=AGENT)
        self.assertEqual(again["code"], "ALREADY_PROJECTED")
        titles = [
            t for t in self.tickets(project).values()
            if first["receipt"] in str(t.get("description") or "")
        ]
        self.assertEqual([t["id"] for t in titles], [created])


class RewindAndTerminalityTests(AppendFixture):
    def test_18_minimum_truthful_rewind_table(self):
        table = {
            ("SCOUT", "implementation"): None,
            ("BUILD", "implementation"): None,
            ("VERIFY", "implementation"): "BUILD",
            ("REVIEW", "implementation"): "BUILD",
            ("SHIP", "implementation"): "BUILD",
            ("VERIFY", "evidence"): None,
            ("REVIEW", "evidence"): None,
            ("REVIEW", "review"): None,
            ("SHIP", "packaging"): None,
            ("BUILD", "context"): None,
        }
        for (phase, delta), expected in table.items():
            with self.subTest(phase=phase, delta=delta):
                self.assertEqual(source_append.minimum_rewind(phase, delta), expected)

    def test_19_completed_unaffected_work_stays_terminal(self):
        project = self.make_project()
        self.mission(project, "BUILD")
        earlier = self.append(project, "\n\n".join(BRICKS[:2]))
        self.project_it(project, earlier["receipt"])
        done_rid = f"{earlier['receipt']}:R001"
        open_rid = f"{earlier['receipt']}:R002"
        marked = intake.set_disposition(
            project, earlier["receipt"], done_rid, "IMPLEMENTED",
            evidence="E-001", verification="fixture -> PASS",
        )
        self.assertTrue(marked.get("ok"), marked)
        replacement = self.append(
            project, "The launcher must classify every binding failure semantically.",
            klass=source_append.SUPERSEDE,
        )
        self.project_it(project, replacement["receipt"])
        coverage = intake._read_coverage(project, earlier["receipt"])["requirements"]
        self.assertEqual(coverage[done_rid]["disposition"], "IMPLEMENTED")
        self.assertEqual(coverage[open_rid]["disposition"], "SUPERSEDED")

    def test_20_acceptance_only_append_in_review_does_not_return_to_build(self):
        project = self.make_project()
        self.mission(project, "REVIEW")
        received = self.append(
            project, "A regression test must cover the fallback path.", delta="evidence"
        )
        projected = self.project_it(project, received["receipt"])
        self.assertIsNone(projected["rewind"])
        self.assertEqual(self.phase(project), "REVIEW")


class ClassificationTests(AppendFixture):
    def test_a_new_mission_is_refused_as_an_append(self):
        project = self.make_project()
        self.mission(project, "BUILD")
        refused = source_append.append(
            project, "Build an unrelated billing export.", klass=source_append.NEW_MISSION
        )
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["code"], "APPEND_NEW_MISSION")
        self.assertIn("saipen start --file", refused["canonical_next_command"])

    def test_a_clarification_adds_no_actionable_burden(self):
        project = self.make_project()
        self.mission(project, "BUILD")
        received = self.append(
            project, "By 'direct launch' the handoff means the launcher must call opencode.",
            klass=source_append.CLARIFICATION, delta="context",
        )
        self.project_it(project, received["receipt"])
        summary = intake.coverage_summary(project, received["receipt"])
        self.assertEqual(summary["actionable"], 0)

    def test_a_conflict_must_name_what_it_supersedes(self):
        project = self.make_project()
        self.mission(project, "BUILD")
        refused = source_append.append(
            project, "Launch must never fall back.", klass=source_append.CONFLICT
        )
        self.assertEqual(refused["code"], "APPEND_CONFLICT_UNNAMED")

    def test_status_shows_the_append_state(self):
        project = self.make_project()
        work, _source = self.mission(project, "BUILD")
        received = self.append(project, BRICKS[0])
        status = self.cli(project, "status")
        mission = (status.get("appends") or [{}])[0]
        self.assertEqual(mission.get("unprojected"), [received["receipt"]])
        self.assertEqual(mission.get("next_action"),
                         f"saipen source apply-append {received['receipt']}")
        self.project_it(project, received["receipt"])
        status = self.cli(project, "status")
        mission = (status.get("appends") or [{}])[0]
        self.assertEqual(mission.get("unprojected"), [])
        self.assertEqual(mission.get("affected_work"), [work])
        self.assertGreaterEqual(mission.get("active_requirements", 0), 1)


_ = parse_board  # imported for fixture introspection in ad-hoc debugging

if __name__ == "__main__":
    unittest.main()
