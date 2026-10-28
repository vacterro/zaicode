"""Closure provenance, cohort authority, routing projection (CORE-003).

SRC-026:R003. Three separate promises the runtime did not keep:

  * a closure that adds no implementation must name a DURABLE publication
    authority, and that authority must actually resolve -- `DONE` alone is a
    claim about evidence, never proof that anything was published;
  * a cohort is durable publication authority, not a word on a BOARD line;
  * projecting Work must recompute the persisted route. Reproduced live at
    E-5975: `audit/16.md` was ingested, `SRC-026` captured and `T-1304`
    projected at the head of `## TODO`, while the persisted `next_action`
    still named `T-1303` -- `status` disagreed with its own
    `computed_next_action`, and a cold agent following the file would have
    executed the wrong ticket.

The resolver tests are deliberately negative-heavy: the failure mode being
closed is a closure that SUCCEEDS on evidence that does not exist.
"""

from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import closure, intake  # noqa: E402
from saipen_engine.board import (  # noqa: E402
    goal_blocked_tickets,
    is_user_explicit,
    pick_next_work,
)
from saipen_engine.operations import (  # noqa: E402
    finish_ticket,
    ticket_add,
    ticket_move,
    user_request,
)
from test_orchestration_repair import OrchestrationFixture  # noqa: E402


def _tree_digest(root: Path) -> str:
    """Every canonical byte -- the dry-run and refusal oracle."""
    h = hashlib.sha256()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        h.update(str(path.relative_to(root)).replace("\\", "/").encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def _publish(project: Path, *, version: str = "0.4.2", ticket: str | None = None) -> str:
    """Durable publication evidence: a committed release closure artifact."""
    (project / ".saipen" / "kitchen").mkdir(parents=True, exist_ok=True)
    record = {
        "schema_version": 2,
        "operation": "release_receipt",
        "op_id": "release-" + version.replace(".", ""),
        "version": version,
        "tag": f"v{version}",
        "commit": "c0ffee",
    }
    if ticket:
        record["ticket_id"] = ticket
    (project / ".saipen" / "kitchen" / "release_receipt.json").write_text(
        json.dumps(record), encoding="utf-8"
    )
    return f"release:v{version}"


class ProvenanceFixture(OrchestrationFixture):
    def close_inherited(self, project: Path, ticket: str, source: str):
        self.to_ship(project, ticket)
        return finish_ticket(
            project,
            ticket,
            "tester",
            closure_mode="inherited_verified",
            implementation_source=source,
        )


class ImplementationSourceResolverTests(ProvenanceFixture):
    """CONTROL 2-6: what may and may not stand in for publication."""

    def test_control_4_durably_published_work_resolves(self):
        """A DONE ticket that a committed release receipt actually names."""
        project = self.make_project(active=True)
        board = project / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## DONE\n", "## DONE\n- [x] T-90 [P1] already shipped work | verify: proof\n"
            ),
            encoding="utf-8",
        )
        _publish(project, ticket="T-90")
        verdict = closure.resolve_implementation_source(project, "T-90")
        self.assertTrue(verdict.ok, verdict.to_dict())
        self.assertEqual(verdict.kind, "work")
        self.assertIn("owns committed release evidence", verdict.detail)

    def test_control_2_todo_work_is_not_publication_authority(self):
        project = self.make_project(active=True)
        todo = self.add(project, "unstarted work")
        verdict = closure.resolve_implementation_source(project, todo)
        self.assertFalse(verdict.ok)
        self.assertIn("unfinished Work cannot be publication authority", verdict.detail)

        result = self.close_inherited(project, "T-7", todo)
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertEqual(self.board(project)["tickets"]["T-7"]["section"], "## DOING")

    def test_done_alone_is_never_publication(self):
        """A DONE ticket with no release evidence proves nothing shipped."""
        project = self.make_project(active=True)
        board = project / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## DONE\n", "## DONE\n- [x] T-90 [P1] closed long ago | verify: proof\n"
            ),
            encoding="utf-8",
        )
        verdict = closure.resolve_implementation_source(project, "T-90")
        self.assertFalse(verdict.ok)
        self.assertIn("no committed release evidence names it", verdict.detail)

    def test_control_3_active_source_is_not_publication_authority(self):
        project = self.make_project(active=True)
        captured = intake.capture(
            project, "# Audit\n\nsome durable instruction body\n", source_kind="external_audit"
        )
        self.assertTrue(captured.get("ok"), captured)
        verdict = closure.resolve_implementation_source(project, captured["receipt"])
        self.assertFalse(verdict.ok)
        self.assertIn("a Source is provenance, not publication", verdict.detail)

        result = self.close_inherited(project, "T-7", captured["receipt"])
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(self.board(project)["tickets"]["T-7"]["section"], "## DOING")

    def test_control_6_inheritance_cycle_fails_closed(self):
        """T-A -> T-B -> T-A refuses deterministically, with no overflow."""
        project = self.make_project(active=True)
        board = project / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## DONE\n",
                "## DONE\n"
                "- [x] T-90 [P1] a | verify: proof | closure_mode: inherited_verified | "
                "implementation_delta: none | implementation_source: T-91\n"
                "- [x] T-91 [P1] b | verify: proof | closure_mode: inherited_verified | "
                "implementation_delta: none | implementation_source: T-90\n",
            ),
            encoding="utf-8",
        )
        verdict = closure.resolve_implementation_source(project, "T-90")
        self.assertFalse(verdict.ok)
        self.assertIn("cyclic", verdict.detail)
        self.assertIn("T-90", verdict.chain)
        self.assertIn("T-91", verdict.chain)

    def test_unknown_grammar_is_invalid_not_unknown(self):
        project = self.make_project(active=True)
        verdict = closure.resolve_implementation_source(project, "trust me, it shipped")
        self.assertFalse(verdict.ok)
        self.assertIn("outside the closed grammar", verdict.detail)

    def test_a_pending_kitchen_receipt_is_not_publication(self):
        """An in-flight release names no commit and publishes nothing."""
        project = self.make_project(active=True)
        (project / ".saipen" / "kitchen").mkdir(parents=True, exist_ok=True)
        (project / ".saipen" / "kitchen" / "release_receipt.json").write_text(
            json.dumps({"schema_version": 2, "version": "0.4.2", "tag": "v0.4.2", "mode": "full"}),
            encoding="utf-8",
        )
        verdict = closure.resolve_implementation_source(project, "release:v0.4.2")
        self.assertFalse(verdict.ok)
        self.assertIn("cannot be resolved", verdict.detail)


class CohortAuthorityTests(ProvenanceFixture):
    """CONTROL 5: a cohort publishes, or its members inherit nothing."""

    def _cohort_member(self, project: Path, ticket: str) -> None:
        self.to_ship(project, ticket)
        result = finish_ticket(
            project,
            ticket,
            "tester",
            closure_mode="cohort",
            closure_cohort="C-001",
            closure_paths=("main.py",),
        )
        self.assertTrue(result.ok, result.to_dict())

    def test_unshipped_cohort_cannot_be_inherited(self):
        project = self.make_project(active=True)
        (project / "main.py").write_text("shared = True\n", encoding="utf-8")
        self._cohort_member(project, "T-7")
        verdict = closure.resolve_implementation_source(project, "T-7")
        self.assertFalse(verdict.ok)
        self.assertIn("unshipped cohort has published nothing", verdict.detail)

    def test_control_5_shipped_cohort_resolves_with_exact_release_identity(self):
        project = self.make_project(active=True)
        (project / "main.py").write_text("shared = True\n", encoding="utf-8")
        self._cohort_member(project, "T-7")
        registry_path = project / ".saipen" / "kitchen" / "cohort_registry.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        registry["cohorts"]["C-001"].update(
            {
                "publication_status": "shipped",
                "release_op_id": "release-abc123",
                "version": "0.5.0",
                "tag": "v0.5.0",
            }
        )
        registry_path.write_text(closure.render_registry(registry), encoding="utf-8")
        verdict = closure.resolve_implementation_source(project, "T-7")
        self.assertTrue(verdict.ok, verdict.to_dict())
        self.assertIn("published through cohort C-001", verdict.detail)

    def test_a_cohort_shipped_without_release_identity_is_refused(self):
        project = self.make_project(active=True)
        (project / "main.py").write_text("shared = True\n", encoding="utf-8")
        self._cohort_member(project, "T-7")
        registry_path = project / ".saipen" / "kitchen" / "cohort_registry.json"
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
        registry["cohorts"]["C-001"]["publication_status"] = "shipped"
        registry_path.write_text(closure.render_registry(registry), encoding="utf-8")
        verdict = closure.resolve_implementation_source(project, "T-7")
        self.assertFalse(verdict.ok)
        self.assertIn("without an exact release identity", verdict.detail)

    def test_membership_is_the_registry_not_the_board_line(self):
        project = self.make_project(active=True)
        (project / "main.py").write_text("shared = True\n", encoding="utf-8")
        self._cohort_member(project, "T-7")
        (project / ".saipen" / "kitchen" / "cohort_registry.json").unlink()
        verdict = closure.resolve_implementation_source(project, "T-7")
        self.assertFalse(verdict.ok)
        self.assertIn("BOARD prose is not cohort authority", verdict.detail)

    def test_a_shared_path_appears_once_in_the_batch_scope(self):
        project = self.make_project(active=True)
        (project / "main.py").write_text("shared = True\n", encoding="utf-8")
        second = self.add(project, "overlapping work")
        self._cohort_member(project, "T-7")
        from saipen_engine.operations import apply_claim

        self.assertTrue(apply_claim(project, second, "tester", explicit=True).ok)
        self._cohort_member(project, second)
        registry = closure.read_registry(project)
        cohort = registry["cohorts"]["C-001"]
        self.assertEqual(set(cohort["members"]), {"T-7", second})
        self.assertEqual(sorted(closure.cohort_scope(cohort)), ["main.py"])


class ClosureGrammarTests(ProvenanceFixture):
    """Engine-side grammar refusals are zero-write, before any project read."""

    def test_illegal_option_combinations_refuse_without_touching_the_project(self):
        project = self.make_project(active=True)
        self.to_ship(project, "T-7")
        before = _tree_digest(project)
        for kwargs, expected in (
            ({"closure_mode": "wishful"}, "outside own_patch|inherited_verified|cohort"),
            ({"closure_mode": "inherited_verified"}, "--implementation-source"),
            ({"closure_mode": "cohort"}, "--closure-cohort"),
            (
                {"closure_mode": "cohort", "closure_cohort": "C-001"},
                "--paths",
            ),
            (
                {"closure_mode": "own_patch", "closure_cohort": "C-001"},
                "only valid with closure_mode cohort",
            ),
            (
                {"closure_mode": "own_patch", "implementation_source": "release:v1"},
                "only valid with closure_mode inherited_verified",
            ),
            (
                {"closure_mode": "cohort", "closure_cohort": "C1", "closure_paths": ("a.py",)},
                "not a C-### identity",
            ),
        ):
            with self.subTest(kwargs=kwargs):
                result = finish_ticket(project, "T-7", "tester", **kwargs)
                self.assertFalse(result.ok, result.to_dict())
                self.assertEqual(result.code, "VALIDATION_FAILED")
                self.assertIn(expected, result.message)
        self.assertEqual(_tree_digest(project), before, "a refused closure wrote bytes")


class DryRunPurityTests(ProvenanceFixture):
    """New commands PLAN with zero writes -- no receipt, no registry, no state."""

    def test_user_request_dry_run_writes_nothing(self):
        project = self.make_project(active=True)
        before = _tree_digest(project)
        result = user_request(project, "tester", "make checkbox indicators square", dry_run=True)
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "PLAN")
        self.assertEqual(_tree_digest(project), before)
        self.assertFalse((project / ".saipen" / "intake").exists())

    def test_ticket_block_scope_dry_run_writes_nothing(self):
        project = self.make_project(active=True)
        before = _tree_digest(project)
        result = ticket_move(
            project, "block", "T-7", "tester", "operator gate", scope="goal", dry_run=True
        )
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(_tree_digest(project), before)

    def test_ticket_done_cohort_dry_run_writes_nothing(self):
        project = self.make_project(active=True)
        (project / "main.py").write_text("shared = True\n", encoding="utf-8")
        self.to_ship(project, "T-7")
        before = _tree_digest(project)
        result = finish_ticket(
            project,
            "T-7",
            "tester",
            dry_run=True,
            closure_mode="cohort",
            closure_cohort="C-001",
            closure_paths=("main.py",),
        )
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(_tree_digest(project), before)
        self.assertFalse((project / ".saipen" / "kitchen" / "cohort_registry.json").exists())

    def test_cohort_ship_dry_run_writes_nothing(self):
        from saipen_engine.operations import apply_claim, cohort_ship

        project = self.make_project(active=True)
        (project / "main.py").write_text("shared = True\n", encoding="utf-8")
        second = self.add(project, "overlapping work")
        self.to_ship(project, "T-7")
        self.assertTrue(
            finish_ticket(
                project,
                "T-7",
                "tester",
                closure_mode="cohort",
                closure_cohort="C-001",
                closure_paths=("main.py",),
            ).ok
        )
        self.assertTrue(apply_claim(project, second, "tester", explicit=True).ok)
        self.to_ship(project, second)
        self.assertTrue(
            finish_ticket(
                project,
                second,
                "tester",
                closure_mode="cohort",
                closure_cohort="C-001",
                closure_paths=("main.py",),
            ).ok
        )
        (project / "VERSION").write_text("7.5.0\n", encoding="utf-8")
        before = _tree_digest(project)
        result = cohort_ship(
            project, "C-001", "tester", dry_run=True, current_capability="no-publish"
        )
        self.assertEqual(_tree_digest(project), before, "a previewed publication wrote bytes")
        # Whether the plan is buildable in this fixture is beside the point;
        # the invariant under test is that PLANNING wrote nothing either way.
        if result.ok:
            self.assertEqual(result.code, "PLAN")


class IdempotencyTests(ProvenanceFixture):
    """A retry is not a second authority."""

    def test_repeating_a_user_request_creates_no_second_source_or_work(self):
        project = self.make_project(active=True)
        first = user_request(project, "tester", "make checkbox indicators square")
        self.assertTrue(first.ok, first.to_dict())
        second = user_request(project, "tester", "make checkbox indicators square")
        self.assertTrue(second.ok, second.to_dict())
        self.assertEqual(second.code, "USER_REQUEST_DUPLICATE")
        self.assertEqual(first.data["receipt"], second.data["receipt"])
        self.assertEqual(first.data["ticket"], second.data["ticket"])
        receipts = sorted((project / ".saipen" / "intake" / "active").glob("SRC-*.md"))
        self.assertEqual(len(receipts), 1, receipts)
        user_tickets = [
            tid
            for tid, ticket in self.board(project)["tickets"].items()
            if is_user_explicit(ticket)
        ]
        self.assertEqual(user_tickets, [first.data["ticket"]])

    def test_a_different_request_is_a_different_authority(self):
        project = self.make_project(active=True)
        first = user_request(project, "tester", "make checkbox indicators square")
        other = user_request(project, "tester", "make the toolbar sticky")
        self.assertNotEqual(first.data["receipt"], other.data["receipt"])
        self.assertNotEqual(first.data["ticket"], other.data["ticket"])


class RoutingProjectionTests(ProvenanceFixture):
    """CONTROL 10/13/14: projecting Work recomputes the persisted route."""

    def test_control_14_audit_source_work_updates_the_persisted_route(self):
        """The exact E-5975 shape, without hardcoding a ticket id.

        A free START slot, an ordinary backlog ticket already filed, then
        audit/source-bound Work projected at the head of `## TODO`. The
        persisted `next_action` must be recomputed through the canonical Pick
        Rule and agree with a fresh route -- the live snapshot had them
        disagreeing, which is how `status` reported one ticket while
        `computed_next_action` named another.
        """
        project = self.make_project()
        backlog = self.add(project, "ordinary queued work")
        added = ticket_add(
            project,
            "tester",
            "P1",
            "Execute external audit inbox layer audit/16.md (SRC-026); source_receipt=SRC-026",
            [],
            "every actionable clause of SRC-026 is terminal with evidence",
        )
        self.assertTrue(added.ok, added.to_dict())
        audit_work = added.data["ticket"]

        state = self.state(project)
        routed = self.route(project)
        self.assertEqual(state["next_action"], routed["action"])
        self.assertEqual(routed["ticket"], audit_work)
        self.assertNotEqual(routed["ticket"], backlog)
        # Semantic, not positional: the shared Pick Rule made this choice.
        self.assertEqual(
            pick_next_work(self.board(project)["tickets"], agent="tester")[0], audit_work
        )

    def test_control_10_free_slot_user_request_becomes_the_persisted_route(self):
        project = self.make_project()
        self.add(project, "ordinary queued work")
        result = user_request(project, "tester", "make checkbox indicators square")
        self.assertTrue(result.ok, result.to_dict())
        state = self.state(project)
        self.assertEqual(state["next_action"], f"PHASE SCOUT {result.data['ticket']}")
        self.assertEqual(state["next_action"], self.route(project)["action"])

    def test_control_13_goal_blocked_clears_when_workable_work_appears(self):
        project = self.make_project()
        gate = self.add(project, "operator gate")
        self.assertTrue(
            ticket_move(project, "block", gate, "tester", "needs hardware", scope="goal").ok
        )
        self.assertEqual(self.state(project).get("stop_reason"), "GOAL_BLOCKED")
        self.assertEqual(goal_blocked_tickets(self.board(project)["tickets"]), [gate])

        fresh = self.add(project, "independent workable work")
        state = self.state(project)
        self.assertNotIn("stop_reason", state)
        self.assertEqual(state["next_action"], f"PHASE SCOUT {fresh}")
        routed = self.route(project)
        self.assertEqual(routed["action"], state["next_action"])

    def test_goal_blocked_is_never_claimed_while_work_remains(self):
        project = self.make_project()
        gate = self.add(project, "operator gate")
        self.add(project, "independent workable work")
        self.assertTrue(
            ticket_move(project, "block", gate, "tester", "needs hardware", scope="goal").ok
        )
        self.assertNotIn("stop_reason", self.state(project))
        self.assertNotEqual(self.route(project).get("reason"), "goal-blocked")

    def test_a_ticket_scope_block_never_stops_the_loop(self):
        project = self.make_project()
        gate = self.add(project, "operator gate")
        other = self.add(project, "independent work")
        self.assertTrue(ticket_move(project, "block", gate, "tester", "stuck here").ok)
        self.assertNotIn("stop_reason", self.state(project))
        routed = self.route(project)
        self.assertEqual(routed["ticket"], other)


class StatusProjectionTests(ProvenanceFixture):
    """The persisted route and a fresh route agree, or the file is a trap."""

    def test_router_and_persisted_route_agree_after_every_projection(self):
        project = self.make_project()
        for description in ("first", "second", "third"):
            self.add(project, f"{description} queued work")
            self.assertEqual(
                self.state(project)["next_action"],
                self.route(project)["action"],
                "persisted route drifted from the router after a ticket projection",
            )


class UnknownFieldTests(ProvenanceFixture):
    """The new Board fields did not open the parser to arbitrary metadata."""

    def test_an_unknown_field_is_still_a_parse_error(self):
        project = self.make_project()
        board = project / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## TODO\n", "## TODO\n- [ ] T-90 [P1] x | verify: p | frobnicate: yes\n"
            ),
            encoding="utf-8",
        )
        self.assertTrue(
            any("unrecognized field" in e for e in self.board(project)["errors"]),
            self.board(project)["errors"],
        )

    def test_a_duplicated_closure_field_is_still_a_parse_error(self):
        project = self.make_project()
        board = project / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## DONE\n",
                "## DONE\n- [x] T-90 [P1] x | verify: p | closure_mode: own_patch | "
                "closure_mode: cohort\n",
            ),
            encoding="utf-8",
        )
        self.assertTrue(
            any("duplicates the known field" in e for e in self.board(project)["errors"]),
            self.board(project)["errors"],
        )

    def test_closure_metadata_outside_done_is_refused(self):
        from saipen_engine.board import closure_metadata_errors

        problems = closure_metadata_errors(
            {"id": "T-1", "section": "## TODO", "fields": {"closure_mode": "own_patch"}}
        )
        self.assertTrue(any("under ## TODO" in p for p in problems), problems)


if __name__ == "__main__":
    unittest.main(verbosity=2)
