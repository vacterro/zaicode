"""T-1446 autonomy acceptance: cold recovery package, semantic progress
invariant, duplicate goal-ingress idempotence and the cc-all recovery
regressions (T-1449/T-1450 incident as live fixture evidence).

The incident BOARD fixture lines are intentionally long: they carry the real
blocker prose verbatim, which IS the evidence under test.

Families:
  A. ColdRecoveryPackageTests  -- the derived carrier on the REAL incident
     fixture shape (STATE DONE + blocked T-1449/T-1450 + eligible T-1446).
  B. ProgressInvariantTests    -- SRC-100 cases A-G, five semantic cycles.
  C. GoalIngressIdempotenceTests -- GOAL_ALREADY_CAPTURED red/green.
  D. RouterOrderingTests       -- stale unlinked queue never outranks a
     workable user_explicit Work (the live cc-all-hijack regression).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

from saipen_engine.cold_recovery import (  # noqa: E402
    NO_PROGRESS_THRESHOLD,
    Observation,
    SemanticProgressTracker,
    build_recovery_package,
    classify_blocker,
    goal_ingress_identity,
)

SAIPEN = TOOLS / "saipen.py"

# The REAL incident fixture, distilled verbatim from the live surfaces at
# E-7925 (STATE DONE after the cc-all pivots; T-1446 eligible; T-1449
# bounded-timeout blocked; T-1450 duplicate blocked; T-1428 parked on T-1446).
INCIDENT_STATE = """---
phase: DONE
task: none
next_action: "PHASE SCOUT T-1446"
blocker: ""
transition_from: BUILD
saipen_version: 8
schema_version: 3
last_event: 7925
style_contract: ded-4ae736e4
agent: astra
mode: full
updated: "2026-09-21T21:43:02Z"
execution_intent: goal
goal_waves: 1
goal_tickets: 0
---
"""

# ruff: noqa: E501 (real incident blocker prose is the evidence under test)
INCIDENT_BOARD = """## DOING
## TODO
- [ ] T-1446 [P1] Autonomy mission umbrella | verify: slices verified | user_explicit: true | needs: T-1447,T-1448
- [ ] T-1445 [P2] Unrelated ordinary work | verify: done
## DONE
- [x] T-1447 [P2] hermetic child env | verify: green
- [x] T-1448 [P1] watchdog | verify: green
## BLOCKED
- [ ] T-1450 [P1] cc all | verify: complete | blocker: duplicate goal ingress of T-1449: cc all already has an explicit bounded timeout and no new semantic scope; preserve prior evidence, do not rerun unchanged full family | blocker_scope: ticket
- [ ] T-1449 [P1] cc all | verify: complete | blocker: declared unittest family exceeded bounded 600-second window without verdict; no PASS claimed; ticket-scope block only
- [ ] T-1428 [P1] paused corridor | verify: done | blocker: ACTIVE_DEPENDENCY:T-1446 -- PAUSED by user request SRC-100: explicit new task T-1446 takes the seat | blocked_on: T-1446
"""

INCIDENT_LOG_TAIL = """- 21.09.26 21:29 [E-7918] [T-1449] [op: transition-05760d32] RUN: transition to VERIFY
- 21.09.26 21:40 [E-7919] [T-1449] [op: checkpoint-1f764938] RUN: verify -> INCOMPLETE [target: T-1449] -- declared family python -m unittest discover -s tools -p 'test_*.py' did not produce a verdict within 600 seconds; no PASS claimed
- 21.09.26 21:40 [E-7920] [T-1449] [op: ticket-52ec1a8c] DEC: ticket block via SAIOPS (active)
- 21.09.26 21:42 [E-7921] [op: goal-entry-3c0f7dd7] DEC: goal pivot -- cc all
- 21.09.26 21:43 [E-7925] [T-1450] [op: ticket-c38e5b8c] DEC: ticket block via SAIOPS (active) -- duplicate goal ingress
"""


class ColdRecoveryPackageTests(unittest.TestCase):
    def setUp(self):
        self.pkg = build_recovery_package(
            INCIDENT_STATE, INCIDENT_BOARD, INCIDENT_LOG_TAIL, tree_identity="git:abc"
        )

    def test_real_incident_derives_primary_mission_not_global_stop(self):
        # The critical L3 acceptance: a cold agent seeing STATE DONE + blocked
        # duplicates must derive T-1446 as the primary resumable mission.
        self.assertEqual(self.pkg["ACTIVE_WORK"], "T-1446")
        self.assertEqual(self.pkg["PHASE"], "DONE")
        self.assertEqual(self.pkg["LAST_EVENT"], "E-7925")
        self.assertEqual(self.pkg["NEXT_ACTION"], "PHASE SCOUT T-1446")
        self.assertEqual(self.pkg["BLOCKER"], {"id": "T-1446", "unmet_needs": []})

    def test_blocked_duplicates_are_known_reds_not_unrelated(self):
        self.assertIn("T-1449", self.pkg["KNOWN_REDS"])
        self.assertIn("T-1450", self.pkg["KNOWN_REDS"])
        self.assertNotIn("T-1449", self.pkg["UNRELATED_REDS"])
        self.assertNotIn("T-1450", self.pkg["UNRELATED_REDS"])
        self.assertNotIn("T-1428", self.pkg["UNRELATED_REDS"])

    def test_do_not_repeat_carries_the_bounded_family_verdict(self):
        joined = " | ".join(self.pkg["DO_NOT_REPEAT"])
        self.assertIn("declared family", joined)
        self.assertIn("600 seconds", joined)
        self.assertIn("INCOMPLETE", joined)

    def test_operator_gates_classified_as_deferred(self):
        deferred_ids = {d["id"] for d in self.pkg["DEFERRED"]}
        self.assertIn("T-1428", deferred_ids)

    def test_carrier_is_bounded_and_declared_derived(self):
        surface = json.dumps(self.pkg)
        self.assertLess(len(surface.encode("utf-8")), 20_000, "carrier must stay bounded")
        self.assertEqual(self.pkg["carrier"], "derived-recovery-package")
        self.assertIn("regenerable", self.pkg["authority"])

    def test_blocker_policy_owner(self):
        self.assertTrue(classify_blocker("duplicate goal ingress of X")["duplicate"])
        self.assertTrue(classify_blocker("accidental duplicate ingress of T-1407")["duplicate"])
        self.assertTrue(classify_blocker("declared unittest family exceeded bounded 600-second window")["bounded_timeout"])
        self.assertTrue(classify_blocker("ACTIVE_DEPENDENCY:T-1 -- paused")["is_parked_hold"])
        self.assertTrue(classify_blocker("HELD -- unmet dependency")["is_parked_hold"])
        self.assertFalse(classify_blocker("some other prose")["is_parked_hold"])
        self.assertFalse(classify_blocker("some other prose")["is_operator_gate"])

    def test_parked_is_not_operator_owned(self):
        # T-1429 red control. One flag used to answer both questions, so a cold
        # worker read a dependency pause as "a human must act" and stopped.
        for blocker in (
            "ACTIVE_DEPENDENCY:T-1446 -- paused by user request",
            "HELD -- unmet dependency T-473",
            "FUTURE_GATE -- v8 concurrent mode",
            "PERMANENT_WARNING_OWNER -- immutable history",
            "WAIT_ROLE:saitest -- crew owns this",
        ):
            with self.subTest(blocker=blocker):
                verdict = classify_blocker(blocker)
                self.assertTrue(verdict["is_parked_hold"], "still parked, still not a red")
                self.assertFalse(
                    verdict["is_operator_gate"],
                    "no human was ever asked for anything here",
                )
        for blocker in (
            "WAIT_USER_CONFIRMATION -- operator must confirm",
            "WAIT_USER_DECISION -- operator must decide",
            "BLOCKED_EXTERNAL -- FreeBuff desktop acceptance",
        ):
            with self.subTest(blocker=blocker):
                verdict = classify_blocker(blocker)
                self.assertTrue(verdict["is_operator_gate"])
                self.assertTrue(verdict["is_parked_hold"])

    def test_due_needs_a_real_due_instant_that_has_passed(self):
        # The package used to publish every parked ticket as DUE, so an
        # autonomous run ended on an operator action that did not exist.
        board = (
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n"
            "- [ ] T-10 [P1] parked | verify: x | blocker: ACTIVE_DEPENDENCY:T-11 -- paused | "
            "retry_not_before: 2000-01-01T00:00:00Z\n"
            "- [ ] T-12 [P1] undated gate | verify: x | "
            "blocker: BLOCKED_EXTERNAL -- operator gate\n"
            "- [ ] T-13 [P1] future gate | verify: x | "
            "blocker: WAIT_USER_DECISION -- decide later | "
            "retry_not_before: 2999-01-01T00:00:00Z\n"
            "- [ ] T-14 [P1] passed gate | verify: x | "
            "blocker: BLOCKED_EXTERNAL -- operator gate | "
            "retry_not_before: 2000-01-01T00:00:00Z\n"
        )
        pkg = build_recovery_package("phase: BUILD\ntask: none\n", board, "")
        self.assertEqual(pkg["DUE"], ["T-14"])
        states = {row["id"]: row["state"] for row in pkg["OPERATOR_GATES"]}
        self.assertNotIn("T-10", states, "a parked hold is not an operator gate at all")
        self.assertEqual(states["T-12"], "OPERATOR_GATE_UNDATED")
        self.assertEqual(states["T-13"], "DEFERRED_OPERATOR")
        self.assertEqual(states["T-14"], "DUE_OPERATOR_ACTION")
        self.assertIn("T-10", [d["id"] for d in pkg["DEFERRED"]])

    def test_next_command_leads_to_canonical_continuation(self):
        # SRC-100 §7: the carrier must lead to an executable continuation, not
        # to a raw BOARD repair or a "project complete" verdict.
        self.assertEqual(self.pkg["NEXT_COMMAND"], "saipen continue --json")
        self.assertEqual(self.pkg["NEXT_ACTION"], "PHASE SCOUT T-1446")

    def test_state_task_names_the_seat_over_pending_todo(self):
        # Live regression: a claimed DOING seat must stay the ACTIVE_WORK even
        # when an earlier TODO is dependency-eligible (brief briefly projected
        # T-1445 while STATE.task was T-1446).
        state = INCIDENT_STATE.replace("task: none", "task: T-9001")
        board = (
            "## DOING\n"
            "- [/] T-9001 [P1] Claimed seat | verify: done | owner: astra | claim_time: 2026-09-22T00:00:00Z\n"
            "## TODO\n"
            "- [ ] T-9002 [P2] Eligible neighbor | verify: done\n"
            "## DONE\n## BLOCKED\n"
        )
        pkg = build_recovery_package(state, board, "")
        self.assertEqual(pkg["ACTIVE_WORK"], "T-9001")
        self.assertEqual(pkg["NEXT_ACTION"], "PHASE SCOUT T-9001")
        self.assertEqual(pkg["TODO_ELIGIBLE"][0]["id"], "T-9002")

    def test_blocked_seat_keeps_state_next_action(self):
        # A paused corridor named by STATE.task is the seat, but its next move
        # comes from STATE, never an invented SCOUT.
        state = INCIDENT_STATE.replace("task: none", "task: T-1428")
        blocked_state = state.replace('next_action: "PHASE SCOUT T-1446"', 'next_action: "RESUME T-1428"')
        pkg = build_recovery_package(blocked_state, INCIDENT_BOARD, "")
        self.assertEqual(pkg["ACTIVE_WORK"], "T-1428")
        self.assertEqual(pkg["NEXT_ACTION"], "RESUME T-1428")

    def test_runtime_state_surfaces_owner_lease_and_scope_without_inventing(self):
        # Absent runtime observations must stay empty, never inferred.
        self.assertEqual(self.pkg["OWNER"], "")
        self.assertEqual(self.pkg["CLAIM_LIVENESS"], "")
        self.assertEqual(self.pkg["MUTATION_LEASE"], {})

        enriched = build_recovery_package(
            INCIDENT_STATE,
            INCIDENT_BOARD,
            INCIDENT_LOG_TAIL,
            runtime_state={
                "canonical_root": "X:/proj",
                "project_identity": "proj-1",
                "project_lineage": "lineage-1",
                "claim_liveness": "FOREIGN_LIVE",
                "watchdog": {"state": "SUSPECT", "lease_generation": 4},
            },
        )
        self.assertEqual(enriched["CANONICAL_ROOT"], "X:/proj")
        self.assertEqual(enriched["PROJECT_IDENTITY"], "proj-1")
        self.assertEqual(enriched["CLAIM_LIVENESS"], "FOREIGN_LIVE")
        self.assertEqual(enriched["MUTATION_LEASE"]["lease_generation"], 4)
        # The incident BLOCKED rows carry their real blocker_scope verbatim.
        self.assertEqual(enriched["BLOCKER_SCOPE"], "ticket")
        self.assertIn("goal-entry-3c0f7dd7", enriched["EVIDENCE"])


class BriefCarriesRecoveryPackageTests(unittest.TestCase):
    """SRC-100 §7: one read-only surface answers a zero-context worker.

    The real incident shape again -- STATE DONE, T-1446 eligible, T-1449/T-1450
    blocked side branches -- must project the primary mission and an executable
    continuation, never "project complete".
    """

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="t1446-brief-")
        self.project = _new_project(Path(self._tmp))
        saipen_dir = self.project / ".saipen"
        (saipen_dir / "STATE.md").write_text(INCIDENT_STATE, encoding="utf-8")
        (saipen_dir / "BOARD.md").write_text(INCIDENT_BOARD, encoding="utf-8")
        (saipen_dir / "LOG.md").write_text(INCIDENT_LOG_TAIL, encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_brief_json_exposes_the_incident_recovery_verdict(self):
        out = _run(self.project, "brief", "--json")
        # brief --json emits the projection payload itself (no ok/data wrapper).
        recovery = out.get("recovery", {})
        self.assertEqual(recovery.get("ACTIVE_WORK"), "T-1446", out)
        self.assertEqual(recovery.get("NEXT_COMMAND"), "saipen continue --json")
        self.assertIn("T-1449", recovery.get("KNOWN_REDS", []))
        self.assertIn("T-1428", [d["id"] for d in recovery.get("DEFERRED", [])])
        self.assertEqual(out.get("next_action"), "PHASE SCOUT T-1446")

    def test_brief_surface_carries_the_recovery_block(self):
        out = _run(self.project, "brief")
        surface = out.get("raw", "")
        self.assertIn("RECOVERY (derived):", surface)
        self.assertIn("ACTIVE_WORK: T-1446", surface)
        self.assertIn("NEXT_COMMAND: saipen continue --json", surface)


class ProgressInvariantTests(unittest.TestCase):
    """SRC-100 acceptance A-G over SemanticProgressTracker."""

    def _obs(self, **over):
        base = dict(
            work_id="T-A",
            phase="VERIFY",
            blocker="bounded timeout, no verdict",
            next_action="run declared family",
            evidence_identities=("EV-1",),
            source_identity="git:head-a",
            authority_state="ACTIVE",
        )
        base.update(over)
        return Observation(**base)

    def test_a_five_identical_cycles_trip_no_progress_loop(self):
        tracker = SemanticProgressTracker()
        outcomes = [
            tracker.record(self._obs(timestamp="changes-every-time"))
            for _ in range(NO_PROGRESS_THRESHOLD)
        ]
        # Cycles 1..4 accepted, cycle 5 refused -> NO_PROGRESS_LOOP.
        self.assertEqual(outcomes, [True, True, True, True, False])
        self.assertEqual(tracker.verdict(), "NO_PROGRESS_LOOP")

    def test_b_changed_source_identity_is_legitimate_progress(self):
        tracker = SemanticProgressTracker()
        for _ in range(4):
            self.assertTrue(tracker.record(self._obs()))
        # Same command, source bytes changed -> a NEW attempt, not a loop.
        self.assertTrue(tracker.record(self._obs(source_identity="git:head-b")))
        self.assertEqual(tracker.verdict(), "PROGRESS")

    def test_c_changed_authority_is_legitimate_progress(self):
        tracker = SemanticProgressTracker()
        for _ in range(4):
            self.assertTrue(tracker.record(self._obs(authority_state="WAIT_USER")))
        self.assertTrue(tracker.record(self._obs(authority_state="ACTIVE")))
        self.assertEqual(tracker.verdict(), "PROGRESS")

    def test_d_timestamps_only_are_never_progress(self):
        tracker = SemanticProgressTracker()
        stamps = (f"2026-09-21T21:{m:02d}:00Z" for m in range(NO_PROGRESS_THRESHOLD))
        outcomes = [tracker.record(self._obs(timestamp=stamp)) for stamp in stamps]
        self.assertEqual(outcomes, [True, True, True, True, False])
        self.assertEqual(tracker.verdict(), "NO_PROGRESS_LOOP")

    def test_e_heartbeat_without_completion_is_running_not_looped(self):
        tracker = SemanticProgressTracker()
        outcomes = [
            tracker.record(
                self._obs(timestamp="2026-09-21T21:00:00Z", heartbeat=True)
            )
            for _ in range(NO_PROGRESS_THRESHOLD + 3)
        ]
        self.assertTrue(all(outcomes), outcomes)
        self.assertEqual(tracker.verdict(), "RUNNING")

    def test_f_completed_bounded_attempt_is_legitimate_new_attempt(self):
        tracker = SemanticProgressTracker()
        for _ in range(4):
            self.assertTrue(tracker.record(self._obs()))
        self.assertTrue(tracker.record(self._obs(completed_attempt=True)))
        self.assertEqual(tracker.verdict(), "PROGRESS")

    def test_oscillating_distinct_work_is_not_a_no_progress_loop(self):
        tracker = SemanticProgressTracker()
        for index in range(NO_PROGRESS_THRESHOLD):
            self.assertTrue(
                tracker.record(self._obs(work_id=f"T-{index}", next_action=f"step {index}"))
            )
        # Distinct semantic observations each move the fingerprint: this is
        # ordinary alternating progress (or at worst oscillation, which the
        # legacy detector owns), never a five-cycle NO_PROGRESS_LOOP.
        self.assertIn(tracker.verdict(), ("RUNNING", "PROGRESS"))
        self.assertNotEqual(tracker.verdict(), "NO_PROGRESS_LOOP")


def _new_project(tmp: Path) -> Path:
    project = tmp / "proj"
    (project / ".saipen").mkdir(parents=True)
    (project / ".saipen" / "LOG.md").write_text("# Log\n", encoding="utf-8")
    (project / ".saipen" / "BOARD.md").write_text(
        "## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
    )
    (project / ".saipen" / "STATE.md").write_text(
        "---\nphase: DONE\ntask: none\nnext_action: \"saipen continue\"\nblocker: \"\"\n"
        "transition_from: DONE\nsaipen_version: 8\nschema_version: 3\nlast_event: 1\n"
        "agent: test\nmode: full\nupdated: \"2026-09-22T00:00:00Z\"\n---\n",
        encoding="utf-8",
    )
    return project


def _run(project: Path, *args: str, env_extra: dict | None = None) -> dict:
    import os

    env = os.environ.copy()
    for carrier in (
        "SAIPEN_PROJECT_ROOT",
        "SAIPEN_PROJECT_LINEAGE",
        "SAIPEN_HOST_SESSION",
    ):
        env.pop(carrier, None)
    if env_extra:
        env.update(env_extra)
    done = subprocess.run(
        [sys.executable, str(SAIPEN), *args],
        cwd=str(project),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        env=env,
    )
    try:
        return json.loads(done.stdout or "{}")
    except json.JSONDecodeError:
        return {"ok": False, "raw": done.stdout, "err": done.stderr}


class GoalIngressIdempotenceTests(unittest.TestCase):
    """Duplicate semantic ingress resolves at the ingress layer."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="t1446-ingress-")
        self.project = _new_project(Path(self._tmp))

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_identity_is_deterministic_across_normalization(self):
        first = goal_ingress_identity("cc all", "proj-x")
        self.assertEqual(first, goal_ingress_identity("CC  ALL", "proj-x"))
        self.assertNotEqual(first, goal_ingress_identity("cc all", "proj-y"))
        self.assertNotEqual(first, goal_ingress_identity("cc everything", "proj-x"))

    def test_red_control_repeated_goal_mints_one_goal(self):
        first = _run(self.project, "goal", "ship the recovery wave", "--json")
        self.assertTrue(first.get("ok"), first)
        self.assertEqual(first.get("code"), "GOAL_SET")
        before = (self.project / ".saipen" / "BOARD.md").read_bytes()

        second = _run(self.project, "goal", "ship the recovery wave", "--json")
        self.assertTrue(second.get("ok"), second)
        self.assertEqual(second.get("code"), "GOAL_ALREADY_CAPTURED", second)
        # ZERO semantic mutation: same plan tickets, no wave bump, no rows.
        self.assertEqual(
            second.get("data", {}).get("goal_waves"),
            first.get("data", {}).get("goal_waves"),
        )
        self.assertEqual(
            second.get("data", {}).get("plan_tickets") or [],
            first.get("data", {}).get("plan_tickets") or [],
        )
        after = (self.project / ".saipen" / "BOARD.md").read_bytes()
        self.assertEqual(before, after, "duplicate ingress must not touch BOARD")

    def test_materially_changed_scope_is_a_new_goal(self):
        first = _run(self.project, "goal", "ship the recovery wave", "--json")
        self.assertEqual(first.get("code"), "GOAL_SET")
        second = _run(self.project, "goal", "ship the documentation wave", "--json")
        self.assertEqual(second.get("code"), "GOAL_SET", second)


class RouterOrderingTests(unittest.TestCase):
    """The live cc-all-hijack regression: a stale unlinked queue brief must
    never take the START seat from a workable user_explicit mission."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="t1446-router-")
        self.project = _new_project(Path(self._tmp))
        # Workable user_explicit mission present on the BOARD.
        board = self.project / ".saipen" / "BOARD.md"
        board.write_text(
            "## DOING\n## TODO\n"
            "- [ ] T-9001 [P1] Live mission | verify: done | user_explicit: true\n"
            "## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_red_control_workable_user_explicit_outranks_stale_queue(self):
        from saipen_engine.router import route_next

        state_text = (self.project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        board_text = (self.project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        routed = route_next(
            state_text,
            board_text,
            current_agent="tester",
            queued_source={
                "action": "saipen start --receipt SRC-039",
                "receipt": "SRC-039",
                "detail": "stale unlinked wave brief from days ago",
            },
        )
        self.assertTrue(routed.get("ok"), routed)
        self.assertEqual(routed.get("ticket"), "T-9001", routed)
        self.assertNotEqual(routed.get("reason"), "queued-source")


class WorkabilityTests(unittest.TestCase):
    """T-1302 on the live incident: one blocked ticket is not a blocked
    project; the workable mission is the scheduler's answer, never a global
    stop, never a rerun of the bounded-timeout family."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="t1446-work-")
        self.project = _new_project(Path(self._tmp))

    def tearDown(self):
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_blocked_duplicates_plus_eligible_mission_route_to_mission(self):
        board = self.project / ".saipen" / "BOARD.md"
        board.write_text(
            "## DOING\n## TODO\n"
            "- [ ] T-9001 [P1] Mission | verify: done | user_explicit: true\n"
            "## DONE\n## BLOCKED\n"
            "- [ ] T-9002 [P1] cc all | verify: complete | blocker: declared unittest family exceeded bounded 600-second window without verdict\n"
            "- [ ] T-9003 [P1] cc all | verify: complete | blocker: duplicate goal ingress of T-9002: no new semantic scope\n",
            encoding="utf-8",
        )
        from saipen_engine.router import route_next

        routed = route_next(
            (self.project / ".saipen" / "STATE.md").read_text(encoding="utf-8"),
            board.read_text(encoding="utf-8"),
            current_agent="tester",
        )
        self.assertEqual(routed.get("ticket"), "T-9001", routed)
        self.assertIn(routed.get("reason"), ("start-user-explicit", "start"))

    def test_recovery_package_on_incident_selects_mission_not_rerun(self):
        pkg = build_recovery_package(
            INCIDENT_STATE, INCIDENT_BOARD, INCIDENT_LOG_TAIL
        )
        # The next action is the mission, never the DO_NOT_REPEAT family.
        self.assertEqual(pkg["NEXT_ACTION"], "PHASE SCOUT T-1446")
        self.assertNotIn(
            "python -m unittest discover -s tools", pkg["NEXT_ACTION"]
        )
        for entry in pkg["DO_NOT_REPEAT"]:
            self.assertIn("declared family", entry)


class ColdWorkerRecoveryTests(unittest.TestCase):
    """Worker B with zero history recovers from repository + carrier only."""

    def test_cold_worker_becomes_actionable_from_carrier(self):
        started = time.perf_counter()
        pkg = build_recovery_package(
            INCIDENT_STATE, INCIDENT_BOARD, INCIDENT_LOG_TAIL
        )
        elapsed = time.perf_counter() - started

        # Worker B: no conversation, no memory -- only these facts.
        self.assertEqual(pkg["ACTIVE_WORK"], "T-1446")
        self.assertEqual(pkg["PHASE"], "DONE")
        active = next(
            e for e in pkg["TODO_ELIGIBLE"] if e["id"] == pkg["ACTIVE_WORK"]
        )
        # The DONE slices are recognized as satisfied dependencies, so the
        # completed work is NOT repeated: the unmet set stays empty.
        self.assertEqual(pkg["BLOCKER"]["unmet_needs"], [])
        self.assertEqual(
            sorted(n for n in active["needs"] if n in {"T-1447", "T-1448"}),
            ["T-1447", "T-1448"],
            "needs are DONE on BOARD; the carrier must reflect that via unmet_needs",
        )
        self.assertTrue(pkg["NEXT_ACTION"].startswith("PHASE SCOUT T-1446"))
        # Bounded, fast, regenerable.
        self.assertLess(elapsed, 5.0, "carrier build must be far under 5 minutes")
        self.assertLess(len(json.dumps(pkg)), 20_000)


if __name__ == "__main__":
    unittest.main()
