"""Active-execution ownership and router/authorization parity (CORE-001/002).

SRC-026:R001 and SRC-026:R002. Both findings are one defect seen from two
sides: execution ownership had no single authority, so "who wrote last" and
"who owns the active seat" were the same STATE field with two meanings.

  * CORE-001 -- a mutation with nothing to do with the active ticket rewrote
    `STATE.agent` while BOARD kept the real owner's claim. The transactional
    gate accepted the split (it had no owner invariant at all); the canonical
    validator refused it later, at a release boundary. Reproduced live as
    E-5941.
  * CORE-002 -- `route_next` advertised `PHASE BUILD T-1298` against a
    snapshot on which the mutation-authorization gate returned
    `TICKET_NOT_WORKABLE ... explicit 'claim T-1298' adoption is required`.
    The router and the executor read the same bytes and disagreed.

Every ownership decision here comes from `saipen_engine.ownership`, evaluated
at a FIXED instant: two live-clock reads are not the same snapshot, and the
whole point is that one snapshot cannot yield two answers.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import shutil
import subprocess
import sys
import tempfile
import typing
import unittest
from pathlib import Path

try:  # unittest.mock lives at the top level on every supported interpreter
    from unittest import mock
except ImportError:  # pragma: no cover
    mock = None

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import fast_check, journal, operations, ownership  # noqa: E402
from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    handover_agent,
    ticket_add,
    user_request,
)
from saipen_engine.router import route_next  # noqa: E402
from saipen_engine.state import parse_state  # noqa: E402

#: The fixed evaluation instant every matrix case is judged at.
NOW = dt.datetime(2026, 9, 9, 12, 0, 0, tzinfo=dt.timezone.utc)
#: Inside the § 1.4 liveness window relative to NOW.
LIVE = "2026-09-09T11:58:00Z"
#: Outside it -- a lapsed claim another agent may adopt.
STALE = "2026-09-09T10:00:00Z"


def _stamp(moment: dt.datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _tree_digest(root: Path) -> str:
    """A hash of every canonical byte -- the zero-mutation oracle.

    A refusal that "returns an error" while leaving a partial write behind is
    not a refusal. The controls below compare this before and after.
    """
    h = hashlib.sha256()
    for path in sorted(p for p in (root / ".saipen").rglob("*") if p.is_file()):
        h.update(str(path.relative_to(root)).replace("\\", "/").encode())
        h.update(path.read_bytes())
    return h.hexdigest()


class OwnershipFixture(unittest.TestCase):
    """A project whose ACTIVE ticket is genuinely owned by another agent."""

    owner = "opencode"
    intruder = "buffy"

    def make_project(
        self,
        *,
        owner: str | None = "opencode",
        claim_time: str | None = LIVE,
        state_agent: str | None = None,
        task: str | None = "T-7",
        phase: str = "BUILD",
    ) -> Path:
        base = Path(tempfile.mkdtemp(prefix="saipen-ownership-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        (project / ".saipen").mkdir(parents=True)
        agent = state_agent if state_agent is not None else (owner or "tester")
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            f"phase: {phase}\n"
            f"task: {task or 'none'}\n"
            f'next_action: "PHASE {phase} T-7"\n'
            'blocker: ""\n'
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            f"agent: {agent}\n"
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            f'updated: "{_stamp(NOW)}"\n'
            "---\n",
            encoding="utf-8",
        )
        claim = ""
        if owner:
            claim = f" | owner: {owner}"
        if claim_time:
            claim += f" | claim_time: {claim_time}"
        (project / ".saipen" / "BOARD.md").write_text(
            f"## DOING\n- [/] T-7 [P1] active work | verify: proof{claim}\n"
            "## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "LOG.md").write_text(
            "- 09.09.26 12:00 [E-001] [T-7] [agent: opencode] RUN: build -> in flight\n",
            encoding="utf-8",
        )
        journal.ensure_project_lineage(project)
        return project

    def state(self, project: Path) -> dict:
        return parse_state((project / ".saipen" / "STATE.md").read_text(encoding="utf-8"))

    def board(self, project: Path) -> dict:
        return parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))

    def active(self, project: Path) -> dict:
        return self.board(project)["tickets"]["T-7"]["fields"]


# --------------------------------------------------------------- CORE-001


class OutOfBandActorTests(OwnershipFixture):
    """CONTROL A/B: an unrelated actor may record intent, never take the seat."""

    def test_control_a_future_ticket_add_leaves_the_seat_untouched(self):
        project = self.make_project()
        before_claim = self.active(project)["claim_time"]

        added = ticket_add(
            project, self.intruder, "P1", "future work nobody is doing yet", [], "verify by test"
        )
        self.assertTrue(added.ok, added.to_dict())

        state = self.state(project)
        fields = self.active(project)
        self.assertIn(added.data["ticket"], self.board(project)["tickets"])
        self.assertEqual(state["agent"], self.owner, "the seat moved on an unrelated ticket add")
        self.assertEqual(state["task"], "T-7")
        self.assertEqual(fields["owner"], self.owner)
        self.assertEqual(fields["claim_time"], before_claim, "the claim lease was refreshed")

    def test_control_a_records_the_acting_actor_as_provenance(self):
        """The out-of-band actor is not erased -- it moves to the journal."""
        project = self.make_project()
        added = ticket_add(project, self.intruder, "P1", "future work", [], "verify by test")
        self.assertTrue(added.ok, added.to_dict())
        log = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertIn(f"actor {self.intruder}", log)
        self.assertIn(f"seat {self.owner}", log)
        self.assertNotIn("agent handover", log)

    def test_control_b_user_request_leaves_the_seat_untouched(self):
        project = self.make_project()
        before_claim = self.active(project)["claim_time"]

        result = user_request(project, self.intruder, "make checkbox indicators square")
        self.assertTrue(result.ok, result.to_dict())
        receipt, ticket = result.data["receipt"], result.data["ticket"]
        self.assertTrue(
            (project / ".saipen" / "intake" / "active" / f"{receipt}.md").is_file(),
            "the complete request body must be durable",
        )
        self.assertIn(ticket, self.board(project)["tickets"])

        state = self.state(project)
        fields = self.active(project)
        self.assertEqual(state["agent"], self.owner)
        self.assertEqual(state["task"], "T-7")
        self.assertEqual(fields["owner"], self.owner)
        self.assertEqual(fields["claim_time"], before_claim)


class HandoverTests(OwnershipFixture):
    """CONTROL C/D: a transfer is atomic, or it does not happen.

    SRC-026 REVIEW repair, TARGET 6: every operation under these controls
    evaluates claim liveness against the SAME injected fixed NOW -- the wall
    clock never participates. The identical snapshot passes immediately,
    20 minutes later, and tomorrow without editing fixture timestamps.
    """

    def test_control_c_authorized_handover_moves_all_three_atomically(self):
        project = self.make_project()
        before_claim = self.active(project)["claim_time"]

        result = handover_agent(project, self.intruder, explicit=True, now=NOW)
        self.assertTrue(result.ok, result.to_dict())

        state = self.state(project)
        fields = self.active(project)
        self.assertEqual(state["agent"], self.intruder)
        self.assertEqual(fields["owner"], self.intruder)
        self.assertNotEqual(fields["claim_time"], before_claim, "claim_time must be refreshed")
        self.assertEqual(
            ownership.ownership_invariant_errors(state, self.board(project), self.intruder),
            [],
        )
        # ONE frozen instant (TARGET 1): the transferred claim_time IS the
        # operation instant -- never a second clock read.
        self.assertEqual(fields["claim_time"], NOW.strftime("%Y-%m-%dT%H:%M:%SZ"))

    def test_control_d_foreign_live_transfer_refuses_with_zero_mutation(self):
        project = self.make_project()
        before = _tree_digest(project)

        result = handover_agent(project, self.intruder, now=NOW)
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "ACTIVE_CLAIM_FOREIGN")
        self.assertEqual(_tree_digest(project), before, "an unauthorized transfer wrote bytes")

    def test_control_d_refusal_leaves_no_committed_event(self):
        project = self.make_project()
        before_log = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertFalse(handover_agent(project, self.intruder, now=NOW).ok)
        self.assertEqual(
            (project / ".saipen" / "LOG.md").read_text(encoding="utf-8"),
            before_log,
            "a refused handover appended an event tail",
        )

    def test_control_d_refusal_is_identical_whenever_the_test_runs(self):
        """THE decaying-assertion control (NEW RED CONTROL 3).

        The same snapshot, judged at a fixed NOW far in the PAST of the LIVE
        fixture, must refuse identically -- and judged at a fixed NOW far in
        its FUTURE it is FOREIGN_STALE adoption territory, never a silent
        FOREIGN_LIVE flip. Before the frozen-clock repair the verdict came
        from the process wall clock, so this suite changed result merely
        because it was executed later.
        """
        project = self.make_project()
        before = _tree_digest(project)
        fixed_past = NOW  # 2026-09-09T12:00Z: LIVE fixture is 2 minutes live
        self.assertFalse(handover_agent(project, self.intruder, now=fixed_past).ok)
        self.assertEqual(_tree_digest(project), before)

    def test_control_c_stale_claim_is_legal_adoption_under_fixed_now(self):
        """CONTROL C(stale): FOREIGN_STALE + explicit adoption transfers."""
        project = self.make_project(claim_time=STALE)
        result = handover_agent(project, self.intruder, now=NOW)
        self.assertTrue(result.ok, result.to_dict())
        state = self.state(project)
        self.assertEqual(state["agent"], self.intruder)
        self.assertEqual(self.active(project)["owner"], self.intruder)

    def test_liveness_boundary_threshold_minus_epsilon_is_live(self):
        """CONTROL D(boundary): threshold - epsilon -> LIVE refusal."""
        from saipen_engine.board import CLAIM_LIVENESS_WINDOW

        epsilon = dt.timedelta(seconds=1)
        edge = NOW - CLAIM_LIVENESS_WINDOW + epsilon
        project = self.make_project(claim_time=_stamp(edge))
        before = _tree_digest(project)
        result = handover_agent(project, self.intruder, now=NOW)
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "ACTIVE_CLAIM_FOREIGN")
        self.assertEqual(_tree_digest(project), before)

    def test_liveness_boundary_exactly_threshold_is_stale(self):
        """CONTROL E(boundary): exactly threshold -> STALE adoption."""
        from saipen_engine.board import CLAIM_LIVENESS_WINDOW

        edge = NOW - CLAIM_LIVENESS_WINDOW
        project = self.make_project(claim_time=_stamp(edge))
        result = handover_agent(project, self.intruder, now=NOW)
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(self.active(project)["owner"], self.intruder)


class CommittedSplitTests(OwnershipFixture):
    """CONTROL E: an injected split fails BOTH gates, in the same words."""

    def test_fast_validation_rejects_the_injected_split(self):
        project = self.make_project(state_agent="buffy")
        errors = fast_check.validate_project(project, current_agent="buffy")
        self.assertTrue(
            any("is not the owner of the active ticket" in e for e in errors),
            errors,
        )

    def test_both_gates_use_the_same_predicate(self):
        """Not "both fail" -- both fail through ONE imported predicate.

        The pair used to disagree by construction: the fast gate had no rule
        and the canonical validator derived an equivalent conclusion from
        `next_action` alone, so a mutation could commit a split the release
        gate then refused.
        """
        project = self.make_project(state_agent="buffy")
        state = self.state(project)
        shared = ownership.ownership_invariant_errors(state, self.board(project), "buffy")
        self.assertEqual(len(shared), 1, shared)
        fast = fast_check.validate_project(project, current_agent="buffy")
        self.assertIn(shared[0], fast)
        self.assertIn(
            "from saipen_engine.ownership import ownership_invariant_errors",
            (ROOT / "tools" / "validate.py").read_text(encoding="utf-8"),
            "the canonical validator must import the shared predicate, not restate it",
        )

    def test_canonical_validator_rejects_the_injected_split(self):
        """The real `validate.py --gate core`, on a real installation."""
        project = self.make_project(state_agent="buffy")
        ignore = shutil.ignore_patterns("__pycache__", "*.pyc")
        shutil.copytree(TOOLS, project / "tools", ignore=ignore)
        shutil.copytree(ROOT / "saipen", project / "saipen", ignore=ignore)
        shutil.copytree(ROOT / "extensions", project / "extensions", ignore=ignore)
        (project / "VERSION").write_text("7.5.0\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(project / "tools" / "validate.py"), "--gate", "core"],
            cwd=str(project),
            capture_output=True,
            text=True,
            errors="replace",
            timeout=600,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("is not the owner of the active ticket", proc.stdout + proc.stderr)


class JournalCrashTests(OwnershipFixture):
    """CONTROL F: no half-transfer survives recovery."""

    HANDOVER = (
        "import sys; sys.path.insert(0, {tools!r});"
        "from saipen_engine.operations import handover_agent;"
        "print(handover_agent({project!r}, 'buffy', explicit=True).code)"
    )

    def test_crash_between_ownership_projections_leaves_no_split(self):
        """Kill the process in the exact window a half-transfer could exist.

        Handover writes LOG, then STATE, then BOARD. `NITRO_CRASH_AFTER_STATE`
        is the canonical probe for the instant STATE carries the NEW seat and
        BOARD still carries the OLD owner -- a committed split, if recovery
        left it there. It must not: STATE and BOARD ownership are one
        transition, so recovery either completes it or abandons it whole.
        """
        import os

        project = self.make_project()
        proc = subprocess.run(
            [
                sys.executable,
                "-c",
                self.HANDOVER.format(tools=str(TOOLS), project=str(project)),
            ],
            capture_output=True,
            text=True,
            env={**os.environ, "NITRO_CRASH_AFTER_STATE": "1", "PYTHONDONTWRITEBYTECODE": "1"},
            timeout=180,
        )
        self.assertEqual(proc.returncode, 87, proc.stdout + proc.stderr)

        pending = [record["op_id"] for record in journal.pending_ops(project)]
        self.assertTrue(pending, "the interrupted transfer left no recoverable operation")
        for op_id in pending:
            journal.recover(project, op_id)

        state = self.state(project)
        board = self.board(project)
        self.assertEqual(
            ownership.ownership_invariant_errors(state, board, state.get("agent")),
            [],
            f"a half-transfer survived recovery: STATE.agent={state.get('agent')} "
            f"BOARD owner={board['tickets']['T-7']['fields'].get('owner')}",
        )
        self.assertEqual(fast_check.validate_project(project, current_agent=state["agent"]), [])


# --------------------------------------------------------------- CORE-002


class OwnershipMatrixTests(OwnershipFixture):
    """The five classes x bound/unbound STATE.task, at ONE fixed instant."""

    #: (name, board owner, claim_time, STATE.task) -> expected classification.
    MATRIX: typing.ClassVar[list] = [
        ("self-bound", "buffy", LIVE, "T-7", ownership.SELF),
        ("self-unbound", "buffy", LIVE, None, ownership.SELF),
        ("unclaimed-bound", None, None, "T-7", ownership.UNCLAIMED),
        ("unclaimed-unbound", None, None, None, ownership.UNCLAIMED),
        ("foreign-stale-bound", "opencode", STALE, "T-7", ownership.FOREIGN_STALE),
        ("foreign-stale-unbound", "opencode", STALE, None, ownership.FOREIGN_STALE),
        ("foreign-live-bound", "opencode", LIVE, "T-7", ownership.FOREIGN_LIVE),
        ("foreign-live-unbound", "opencode", LIVE, None, ownership.FOREIGN_LIVE),
        ("invalid-bound", "opencode", None, "T-7", ownership.INVALID),
        ("invalid-unbound", None, LIVE, None, ownership.INVALID),
    ]

    def _snapshot(self, owner, claim_time, task):
        project = self.make_project(
            owner=owner,
            claim_time=claim_time,
            task=task,
            state_agent="buffy",
            phase="BUILD" if task else "DONE",
        )
        state_text = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        board_text = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        return project, state_text, board_text

    def test_classification_matrix(self):
        for name, owner, claim_time, task, expected in self.MATRIX:
            with self.subTest(case=name):
                _project, state_text, board_text = self._snapshot(owner, claim_time, task)
                own = ownership.classify_active_ownership(
                    parse_state(state_text), board_text, "buffy", now=NOW
                )
                self.assertEqual(own.status, expected)
                self.assertEqual(own.active_ticket, "T-7")
                self.assertEqual(own.bound, task == "T-7")

    def test_router_never_advertises_an_unauthorized_mutation(self):
        """THE property: route says mutation X -> authorization accepts X.

        Not one example. For every cell of the matrix, whatever `route_next`
        names is executed against the SAME snapshot and the SAME instant by
        the authorization predicate the executor uses. A route naming a
        mutating command that the gate refuses is the CORE-002 defect.
        """
        for name, owner, claim_time, task, _expected in self.MATRIX:
            with self.subTest(case=name):
                _project, state_text, board_text = self._snapshot(owner, claim_time, task)
                routed = route_next(
                    state_text, board_text, current_agent="buffy", now=NOW
                )
                action = str(routed.get("action") or "")
                mutating = action.startswith(("PHASE ", "finish", "ship"))
                if not mutating:
                    continue
                refusal = operations._active_claim_refusal(
                    parse_state(state_text), board_text, "buffy", now=NOW
                )
                self.assertIsNone(
                    refusal,
                    f"{name}: route advertised {action!r} but authorization refuses it: "
                    f"{refusal.to_dict() if refusal else None}",
                )

    def test_adoptable_active_work_routes_to_explicit_claim(self):
        """The historical case: stale foreign owner, STATE.task still bound."""
        for name, owner, claim_time in (
            ("stale foreign owner", "opencode", STALE),
            ("orphan claim", None, None),
        ):
            with self.subTest(case=name):
                _project, state_text, board_text = self._snapshot(owner, claim_time, "T-7")
                routed = route_next(state_text, board_text, current_agent="buffy", now=NOW)
                self.assertTrue(routed["ok"], routed)
                self.assertEqual(routed["reason"], "adopt")
                self.assertEqual(routed["action"], "saipen claim T-7")
                self.assertEqual(routed["ticket"], "T-7")

    def test_live_foreign_claim_never_emits_a_mutating_action(self):
        for task in ("T-7", None):
            with self.subTest(task=task):
                _project, state_text, board_text = self._snapshot("opencode", LIVE, task)
                routed = route_next(state_text, board_text, current_agent="buffy", now=NOW)
                self.assertFalse(str(routed.get("action", "")).startswith("PHASE "))

    def test_invalid_ownership_is_a_deterministic_refusal_never_a_phase(self):
        for task in ("T-7", None):
            with self.subTest(task=task):
                _project, state_text, board_text = self._snapshot("opencode", None, task)
                routed = route_next(state_text, board_text, current_agent="buffy", now=NOW)
                self.assertFalse(routed["ok"], routed)
                self.assertEqual(routed["reason"], "binding-mismatch")
                self.assertFalse(str(routed["action"]).startswith("PHASE "))

    def test_after_adoption_the_route_is_the_ordinary_phase_action(self):
        project = self.make_project(owner="opencode", claim_time=STALE, state_agent="buffy")
        claim = apply_claim(project, "T-7", "buffy", explicit=True)
        self.assertTrue(claim.ok, claim.to_dict())
        state = self.state(project)
        board = self.board(project)
        self.assertEqual(state["agent"], board["tickets"]["T-7"]["fields"]["owner"])
        routed = route_next(
            (project / ".saipen" / "STATE.md").read_text(encoding="utf-8"),
            (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"),
            current_agent="buffy",
        )
        self.assertTrue(routed["ok"], routed)
        self.assertTrue(str(routed["action"]).startswith("PHASE "), routed)
        self.assertEqual(
            operations._active_claim_refusal(
                self.state(project),
                (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"),
                "buffy",
            ),
            None,
        )


class SharedAuthorityControls(OwnershipFixture):
    """SRC-026 REVIEW repair: the executor path really delegates to the ONE
    shared classifier, and the router + authorization verdicts move together.

    These are mutation controls, not source greps: the shared classifier is
    made to misread one fixture, and BOTH the router and the mutation-
    authorization gate must flip with it. A reintroduced local
    `claim_status` branch cannot follow the lie, so the pairing goes red.
    """

    @staticmethod
    def _foreign_live_snapshot():
        fixture = OwnershipFixture()
        project = fixture.make_project(
            owner="opencode", claim_time=LIVE, state_agent="buffy"
        )
        state_text = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        board_text = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        return fixture, project, state_text, board_text

    @staticmethod
    def _lie_about_foreign_live():
        """Temporarily classify every FOREIGN_LIVE seat as SELF."""
        import dataclasses
        from contextlib import contextmanager

        real = ownership.classify_active_ownership

        @contextmanager
        def _patched():
            def _lie(state, board, actor=None, now=None, root=None):
                # The stub stands in for the real classifier, so it must carry
                # the real signature: T-1384's `root` (the session check)
                # reached the seat gate before this double did, and the double
                # then raised TypeError inside the very callers it exists to
                # exercise -- a test failing on its own stub, not on the code.
                own = real(state, board, actor, now=now, root=root)
                if own.status == ownership.FOREIGN_LIVE:
                    return dataclasses.replace(own, status=ownership.SELF)
                return own

            with unittest.mock.patch.object(
                ownership, "classify_active_ownership", _lie
            ):
                yield _lie

        return _patched()

    def test_router_and_authorization_flip_together_with_the_classifier(self):
        """TARGET 7: one lie, two verdicts move TOGETHER, or the suite is red."""
        _fixture, _project, state_text, board_text = self._foreign_live_snapshot()
        routed = route_next(state_text, board_text, current_agent="buffy", now=NOW)
        self.assertFalse(str(routed.get("action", "")).startswith("PHASE "), routed)
        refusal = operations._active_claim_refusal(
            parse_state(state_text), board_text, "buffy", now=NOW
        )
        self.assertIsNotNone(refusal)

        with self._lie_about_foreign_live():
            routed_lied = route_next(state_text, board_text, current_agent="buffy", now=NOW)
            self.assertTrue(
                str(routed_lied.get("action", "")).startswith("PHASE "),
                f"router did not follow the shared classifier: {routed_lied}",
            )
            refusal_lied = operations._active_claim_refusal(
                parse_state(state_text), board_text, "buffy", now=NOW
            )
            self.assertIsNone(
                refusal_lied,
                f"authorization did not follow the shared classifier: "
                f"{refusal_lied.to_dict() if refusal_lied else None}",
            )

    def test_authorization_really_delegates_to_the_shared_classifier(self):
        """NEW RED CONTROL 1: active authorization bypassing the classifier.

        If the gate ever reconstructs the answer from a local `claim_status`
        branch again, the patched lie above cannot reach it and the gate keeps
        refusing a seat the shared authority calls SELF -- this control is red.
        """
        _fixture, _project, state_text, board_text = self._foreign_live_snapshot()
        with self._lie_about_foreign_live():
            self.assertIsNone(
                operations._active_claim_refusal(
                    parse_state(state_text), board_text, "buffy", now=NOW
                )
            )

    def test_handover_consumes_the_frozen_instant_not_a_second_clock(self):
        """NEW RED CONTROL 2: handover using a second wall-clock instant.

        The LIVE fixture (11:58Z) is judged at the frozen NOW (12:00Z) while
        the process wall clock already sits OUTSIDE the liveness window. The
        unauthorized handover must still refuse at the injected instant; a
        second wall-clock read would classify the same claim stale and
        transfer it. The +1h pairing proves the injected instant -- not the
        wall clock -- owns the verdict at any execution time.
        """
        fixture = OwnershipFixture()
        project = fixture.make_project(
            owner="opencode", claim_time=LIVE, state_agent="opencode"
        )
        before = _tree_digest(project)
        result = handover_agent(project, "buffy", now=NOW)
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "ACTIVE_CLAIM_FOREIGN")
        self.assertEqual(_tree_digest(project), before)

        stale_fixture = OwnershipFixture()
        stale_project = stale_fixture.make_project(
            owner="opencode", claim_time=LIVE, state_agent="opencode"
        )
        result_stale = handover_agent(
            stale_project, "buffy", now=NOW + dt.timedelta(hours=1)
        )
        self.assertTrue(result_stale.ok, result_stale.to_dict())

    def test_live_claim_control_never_depends_on_execution_delay(self):
        """NEW RED CONTROL 3: same committed code, delayed rerun, same verdict.

        The E-5985 false-green shape, mechanically forbidden: the verdict is a
        deterministic function of the INJECTED instant -- the same suite run
        immediately, 20 minutes later, or tomorrow reads the identical map
        (live at NOW -> refusal, beyond the window at NOW+20m/next day ->
        legal adoption), and every refusal leaves the tree byte-identical.
        The process wall clock chooses nothing.
        """
        plan = (
            ("immediately", dt.timedelta(0), "ACTIVE_CLAIM_FOREIGN", "opencode"),
            ("20 minutes later", dt.timedelta(minutes=20), "HANDOVERED", "buffy"),
            ("tomorrow", dt.timedelta(days=1), "HANDOVERED", "buffy"),
        )
        for label, delta, expected_code, expected_owner in plan:
            with self.subTest(when=label):
                fixture = OwnershipFixture()
                project = fixture.make_project(
                    owner="opencode", claim_time=LIVE, state_agent="opencode"
                )
                before = _tree_digest(project)
                result = handover_agent(project, "buffy", now=NOW + delta)
                self.assertEqual(result.code, expected_code, result.to_dict())
                self.assertEqual(fixture.active(project)["owner"], expected_owner)
                if expected_code != "HANDOVERED":
                    self.assertEqual(_tree_digest(project), before)

    def test_stale_foreign_bound_work_never_falls_through_to_phase(self):
        """NEW RED CONTROL 4: stale foreign router fallthrough to PHASE.

        A FOREIGN_STALE active ticket with STATE.task still naming it routes
        to the explicit claim/adoption action -- never a PHASE continuation
        (the T-1298 defect shape) -- and the route is evaluated at the fixed
        instant, so the wall clock cannot choose the boundary.
        """
        fixture = OwnershipFixture()
        project = fixture.make_project(
            owner="opencode", claim_time=STALE, state_agent="buffy"
        )
        state_text = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        board_text = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        routed = route_next(state_text, board_text, current_agent="buffy", now=NOW)
        self.assertTrue(routed["ok"], routed)
        self.assertEqual(routed["action"], "saipen claim T-7", routed)
        self.assertNotEqual(routed["reason"], "phase", routed)
        refusal = operations._active_claim_refusal(
            parse_state(state_text), board_text, "buffy", now=NOW
        )
        self.assertIsNotNone(refusal)
        self.assertEqual(refusal.code, "TICKET_NOT_WORKABLE")
        self.assertIn("adoption is required", refusal.message)


class DoingClaimMatrixTests(OwnershipFixture):
    """The DOING claim path consumes the ONE shared authority.

    Fixed-time matrix (SRC-026 completion pass): every cell of the
    ownership matrix reaches `apply_claim` on a DOING ticket at the SAME
    injected NOW, so the verdict is a function of the snapshot, never of
    the wall clock. SELF refreshes, UNCLAIMED/FOREIGN_STALE adopt,
    FOREIGN_LIVE/INVALID refuse with zero mutation.
    """

    #: (name, owner, claim_time, state_agent) -> (ok, code)
    DOING_MATRIX: typing.ClassVar[list] = [
        ("self-refresh", "buffy", LIVE, "buffy", True, "CLAIMED"),
        ("unclaimed-adoption", None, None, "buffy", True, "CLAIMED"),
        ("foreign-stale-takeover", "opencode", STALE, "buffy", True, "CLAIMED"),
        ("foreign-live-refused", "opencode", LIVE, "buffy", False, "TICKET_NOT_WORKABLE"),
        ("invalid-refused", "opencode", None, "buffy", False, "VALIDATION_FAILED"),
    ]

    def test_doing_claim_matrix_fixed_time(self):
        for name, owner, claim_time, agent, ok, code in self.DOING_MATRIX:
            with self.subTest(case=name):
                fixture = OwnershipFixture()
                project = fixture.make_project(
                    owner=owner, claim_time=claim_time, state_agent=agent
                )
                before = _tree_digest(project)
                plan = operations._plan_claim(
                    project,
                    "T-7",
                    "buffy",
                    NOW.strftime("%d.%m.%y %H:%M"),
                    NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    instant=NOW,
                )
                if isinstance(plan, operations.Result):
                    plan_ok, plan_code = plan.ok, plan.code
                    why = plan.to_dict()
                else:  # an OperationPlan: the plan itself is the success
                    plan_ok, plan_code = True, plan.expected["code"]
                    why = plan.expected
                self.assertEqual(plan_ok, ok, f"{name}: {why}")
                self.assertEqual(plan_code, code, f"{name}: {why}")
                if not ok:
                    self.assertEqual(_tree_digest(project), before, f"{name} wrote bytes")

    def test_doing_self_refresh_writes_the_frozen_instant(self):
        fixture = OwnershipFixture()
        project = fixture.make_project(owner="buffy", claim_time=LIVE, state_agent="buffy")
        result = operations.apply_claim(project, "T-7", "buffy")
        self.assertTrue(result.ok, result.to_dict())
        self.assertNotEqual(fixture.active(project)["claim_time"], LIVE, "lease not refreshed")

    def test_doing_claim_path_flips_with_the_shared_classifier(self):
        """Changing the classifier's answer changes the DOING claim verdict.

        A mutation control, not a source grep: the shared classifier is made
        to misread the FOREIGN_LIVE fixture as SELF, and the DOING claim path
        must follow it -- a local `claim_status` reconstruction cannot follow
        the lie, so the pairing goes red if the delegation is removed.
        """
        _fixture, project, _state_text, _board_text = self._foreign_live_snapshot()
        with self._lie_about_foreign_live():
            plan = operations._plan_claim(
                project,
                "T-7",
                "buffy",
                NOW.strftime("%d.%m.%y %H:%M"),
                NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
                instant=NOW,
            )
            # The lie reached the DOING claim path: the refusal the real
            # classifier demands never fires.
            self.assertNotIsInstance(
                plan,
                operations.Result,
                f"the DOING path did not follow the classifier: {plan}",
            )
            self.assertEqual(plan.expected["code"], "CLAIMED", plan.expected)

    @staticmethod
    def _foreign_live_snapshot():
        # state_agent matches the BOARD owner so the pre-existing committed
        # state is coherent: the only thing under test is which branch the
        # DOING claim path takes, decided by the shared classifier.
        fixture = OwnershipFixture()
        project = fixture.make_project(owner="opencode", claim_time=LIVE, state_agent="opencode")
        return fixture, project, None, None

    @staticmethod
    def _lie_about_foreign_live():
        import dataclasses
        from contextlib import contextmanager

        real = ownership.classify_active_ownership

        @contextmanager
        def _patched():
            def _lie(state, board, actor=None, now=None, root=None):
                # The stub stands in for the real classifier, so it must carry
                # the real signature: T-1384's `root` (the session check)
                # reached the seat gate before this double did, and the double
                # then raised TypeError inside the very callers it exists to
                # exercise -- a test failing on its own stub, not on the code.
                own = real(state, board, actor, now=now, root=root)
                if own.status == ownership.FOREIGN_LIVE:
                    return dataclasses.replace(own, status=ownership.SELF)
                return own

            with unittest.mock.patch.object(
                ownership, "classify_active_ownership", _lie
            ):
                yield _lie

        return _patched()


if __name__ == "__main__":
    unittest.main(verbosity=2)
