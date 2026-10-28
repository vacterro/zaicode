"""T-1446 / SRC-100: the supervisor's decision contract and its fencing rules.

The primitives (T-1447 watchdog, T-1448 lease fencing, the T-1446 semantic
progress tracker) were already green in isolation. Nothing joined them, so the
failure this suite exists for is the one nobody can see from a unit test of a
primitive: a supervisor that decides to take over at the wrong moment.

Every control here is a stop the autonomy loop must not get wrong -- an
ambiguous lease read as free, a live worker read as dead, a parked ticket read
as a human deadline, or an identical retry read as progress.
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

from saipen_engine import supervisor, watchdog  # noqa: E402
from saipen_engine.cold_recovery import Observation, SemanticProgressTracker  # noqa: E402

T0 = dt.datetime(2026, 9, 22, 12, 0, 0, tzinfo=dt.timezone.utc)


def _at(seconds: float) -> dt.datetime:
    return T0 + dt.timedelta(seconds=seconds)


STATE = (
    "---\n"
    "phase: BUILD\n"
    "task: {task}\n"
    'next_action: "PHASE BUILD {task}"\n'
    'blocker: ""\n'
    "transition_from: SCOUT\n"
    "saipen_version: 7\n"
    "schema_version: 3\n"
    "last_event: 42\n"
    "style_contract: ded-4ae736e4\n"
    "agent: tester\n"
    "mode: full\n"
    "---\n"
)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-sup-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.project = self.base / "project"
        (self.project / ".saipen").mkdir(parents=True)
        self.write_board()
        self.write_state("none")
        (self.project / ".saipen" / "LOG.md").write_text(
            "- 22.09.26 12:00 [E-042] [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )

    def write_state(self, task: str):
        (self.project / ".saipen" / "STATE.md").write_text(
            STATE.format(task=task), encoding="utf-8"
        )

    def write_board(self, todo=("T-1 [P1] real work | verify: a passing test",), blocked=()):
        lines = ["## DOING", "## TODO"]
        lines += [f"- [ ] {row}" for row in todo]
        lines += ["## DONE", "## BLOCKED"]
        lines += [f"- [ ] {row}" for row in blocked]
        (self.project / ".saipen" / "BOARD.md").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )

    # -- authority ---------------------------------------------------------

    def test_no_lease_and_work_available_runs_the_work(self):
        verdict = supervisor.decide(self.project, now=T0)
        self.assertEqual(verdict["verdict"], supervisor.RUN_WORK)
        self.assertEqual(verdict["work"], "T-1")
        self.assertTrue(verdict["may_mutate"])

    def test_unknown_lease_with_a_present_record_never_permits_takeover(self):
        # The invariant, stated as a test: ambiguous authority fails CLOSED.
        path = self.project.resolve() / watchdog.CACHE_REL
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ this is not json", encoding="utf-8")
        verdict = supervisor.decide(self.project, now=T0)
        self.assertEqual(verdict["verdict"], supervisor.AMBIGUOUS_AUTHORITY)
        self.assertFalse(verdict["may_mutate"])

    def test_a_healthy_lease_is_never_stolen(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        verdict = supervisor.decide(self.project, now=_at(5), worker_id="worker-b")
        self.assertEqual(verdict["verdict"], supervisor.AWAIT_WORKER)
        self.assertFalse(verdict["may_mutate"])

    def test_the_holding_worker_adopts_its_own_generation(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        verdict = supervisor.decide(self.project, now=_at(5), worker_id="worker-a")
        self.assertEqual(verdict["verdict"], supervisor.ADOPT_WORKER)
        self.assertEqual(verdict["adopt_generation"], 1)

    def test_a_suspect_lease_is_still_not_replaceable(self):
        # Late is not dead. Replacing here is how two workers end up live.
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        verdict = supervisor.decide(self.project, now=_at(45), worker_id="worker-b")
        self.assertEqual(verdict["observation"]["lease_state"], watchdog.SUSPECT)
        self.assertEqual(verdict["verdict"], supervisor.AWAIT_WORKER)

    # -- expiry boundary ---------------------------------------------------

    def test_boundary_just_before_at_and_after_expiry(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        for offset, expected in ((119.0, supervisor.AWAIT_WORKER),
                                 (120.0, supervisor.REPLACE_WORKER),
                                 (121.0, supervisor.REPLACE_WORKER)):
            with self.subTest(offset=offset):
                verdict = supervisor.decide(self.project, now=_at(offset), worker_id="worker-b")
                self.assertEqual(verdict["verdict"], expected)

    def test_a_future_heartbeat_reads_healthy_not_expired(self):
        # A backward wall-clock jump on the supervisor's host must never make
        # a live worker look dead. Fail-safe, not fail-fast.
        watchdog.acquire_lease(self.project, "worker-a", now=_at(600))
        verdict = supervisor.decide(self.project, now=T0, worker_id="worker-b")
        self.assertEqual(verdict["observation"]["lease_state"], watchdog.HEALTHY)
        self.assertEqual(verdict["verdict"], supervisor.AWAIT_WORKER)

    def test_a_host_in_another_timezone_computes_the_same_age(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        tokyo = _at(130).astimezone(dt.timezone(dt.timedelta(hours=9)))
        verdict = supervisor.decide(self.project, now=tokyo, worker_id="worker-b")
        self.assertEqual(verdict["verdict"], supervisor.REPLACE_WORKER)
        self.assertAlmostEqual(verdict["observation"]["heartbeat_age_seconds"], 130.0, places=3)

    def test_a_naive_timestamp_is_read_as_utc(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        verdict = supervisor.decide(
            self.project, now=_at(130).replace(tzinfo=None), worker_id="worker-b"
        )
        self.assertEqual(verdict["verdict"], supervisor.REPLACE_WORKER)

    # -- turnover ----------------------------------------------------------

    def test_replacement_fences_the_old_generation_and_advances(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        result = supervisor.replace_worker(self.project, "worker-b", now=_at(200))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["fenced_generation"], 1)
        self.assertEqual(result["lease"]["lease_generation"], 2)
        self.assertEqual(result["lease"]["worker_id"], "worker-b")

    def test_a_returning_old_worker_cannot_mutate(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        supervisor.replace_worker(self.project, "worker-b", now=_at(200))
        self.assertFalse(watchdog.mutation_allowed(self.project, "worker-a", 1, now=_at(201)))
        self.assertTrue(watchdog.mutation_allowed(self.project, "worker-b", 2, now=_at(201)))

    def test_replacement_refuses_a_live_lease(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        result = supervisor.replace_worker(self.project, "worker-b", now=_at(10))
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "LIVE_LEASE_PRESENT")

    def test_replacement_refuses_ambiguous_authority(self):
        path = self.project.resolve() / watchdog.CACHE_REL
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ broken", encoding="utf-8")
        result = supervisor.replace_worker(self.project, "worker-b", now=T0)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "AMBIGUOUS_AUTHORITY")

    def test_three_generations_of_cold_turnover(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        first = supervisor.replace_worker(self.project, "worker-b", now=_at(200))
        second = supervisor.replace_worker(self.project, "worker-c", now=_at(400))
        self.assertEqual(first["lease"]["lease_generation"], 2)
        self.assertEqual(second["lease"]["lease_generation"], 3)
        for worker, generation in (("worker-a", 1), ("worker-b", 2)):
            with self.subTest(worker=worker):
                self.assertFalse(
                    watchdog.mutation_allowed(self.project, worker, generation, now=_at(401))
                )
        self.assertTrue(watchdog.mutation_allowed(self.project, "worker-c", 3, now=_at(401)))

    # -- operator gates ----------------------------------------------------

    def test_a_due_operator_gate_with_no_work_stops_for_the_human(self):
        self.write_board(
            todo=(),
            blocked=(
                "T-2 [P1] gated | verify: x | blocker: BLOCKED_EXTERNAL -- operator gate "
                "| blocker_scope: ticket | retry_not_before: 2026-09-20T21:00:00Z",
            ),
        )
        verdict = supervisor.decide(self.project, now=T0)
        self.assertEqual(verdict["verdict"], supervisor.OPERATOR_ACTION_DUE)
        self.assertTrue(verdict["requires_human"])
        self.assertEqual(verdict["operator_work"], ["T-2"])

    def test_executable_work_outranks_a_due_operator_gate(self):
        self.write_board(
            todo=("T-1 [P1] real work | verify: a passing test",),
            blocked=(
                "T-2 [P1] gated | verify: x | blocker: BLOCKED_EXTERNAL -- operator gate "
                "| blocker_scope: ticket | retry_not_before: 2026-09-20T21:00:00Z",
            ),
        )
        verdict = supervisor.decide(self.project, now=T0)
        self.assertEqual(verdict["verdict"], supervisor.RUN_WORK)
        self.assertEqual(verdict["observation"]["due_operator_actions"], ["T-2"])

    def test_a_deferred_gate_is_not_a_human_stop(self):
        self.write_board(
            todo=(),
            blocked=(
                "T-2 [P1] gated | verify: x | blocker: WAIT_USER_DECISION -- later "
                "| blocker_scope: ticket | retry_not_before: 2999-01-01T00:00:00Z",
            ),
        )
        verdict = supervisor.decide(self.project, now=T0)
        self.assertNotEqual(verdict["verdict"], supervisor.OPERATOR_ACTION_DUE)
        self.assertEqual(verdict["observation"]["deferred_operator_gates"], ["T-2"])

    def test_a_parked_hold_with_a_due_field_is_never_a_human_stop(self):
        # T-1429's red control, carried into the loop that would have acted on
        # it: a HELD ticket is not a person with a clock.
        self.write_board(
            todo=(),
            blocked=(
                "T-2 [P1] held | verify: x | blocker: HELD -- unmet dependency "
                "| blocker_scope: ticket | retry_not_before: 2026-09-20T21:00:00Z",
            ),
        )
        verdict = supervisor.decide(self.project, now=T0)
        self.assertEqual(verdict["observation"]["due_operator_actions"], [])
        self.assertEqual(verdict["verdict"], supervisor.IDLE)

    def test_a_role_owned_wait_is_never_a_human_stop(self):
        self.write_board(
            todo=(),
            blocked=(
                "T-2 [P1] crew | verify: x | blocker: WAIT_ROLE:saitest -- crew owns it "
                "| blocker_scope: ticket | retry_not_before: 2026-09-20T21:00:00Z",
            ),
        )
        verdict = supervisor.decide(self.project, now=T0)
        self.assertEqual(verdict["observation"]["due_operator_actions"], [])

    # -- no-progress -------------------------------------------------------

    def _stalled_tracker(self):
        tracker = SemanticProgressTracker(threshold=3)
        for _ in range(4):
            tracker.record(
                Observation(
                    work_id="T-1",
                    phase="BUILD",
                    blocker="",
                    next_action="PHASE BUILD T-1",
                    timestamp="moves every cycle",
                )
            )
        return tracker

    def test_repeated_identical_cycles_stop_the_loop(self):
        tracker = self._stalled_tracker()
        self.assertEqual(tracker.verdict(), "NO_PROGRESS_LOOP")
        verdict = supervisor.decide(self.project, now=T0, tracker=tracker)
        self.assertEqual(verdict["verdict"], supervisor.NO_PROGRESS_LOOP)
        self.assertFalse(verdict["may_mutate"])

    def test_a_due_human_stop_outranks_the_loop_stop(self):
        # Order matters: a loop that stops without naming the human who can
        # unblock it is the silent stall, not the safe one.
        self.write_board(
            todo=(),
            blocked=(
                "T-2 [P1] gated | verify: x | blocker: BLOCKED_EXTERNAL -- operator gate "
                "| blocker_scope: ticket | retry_not_before: 2026-09-20T21:00:00Z",
            ),
        )
        verdict = supervisor.decide(self.project, now=T0, tracker=self._stalled_tracker())
        self.assertEqual(verdict["verdict"], supervisor.OPERATOR_ACTION_DUE)

    # -- observability -----------------------------------------------------

    def test_the_read_only_picture_names_what_a_restart_needs(self):
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        self.write_state("T-1")
        picture = supervisor.observe(self.project, now=_at(10), run_id="run-7")
        for field in (
            "autonomy_run_id",
            "phase",
            "active_work",
            "worker_generation",
            "lease_generation",
            "lease_state",
            "heartbeat_age_seconds",
            "executable_work",
            "operator_gates",
            "due_operator_actions",
            "deferred_operator_gates",
            "no_progress_count",
            "progress_verdict",
            "next_action",
        ):
            with self.subTest(field=field):
                self.assertIn(field, picture)
        self.assertEqual(picture["autonomy_run_id"], "run-7")
        self.assertEqual(picture["active_work"], "T-1")
        self.assertEqual(picture["lease_generation"], 1)

    def test_observe_writes_nothing(self):
        before = sorted(p.name for p in (self.project / ".saipen").rglob("*"))
        supervisor.observe(self.project, now=T0)
        after = sorted(p.name for p in (self.project / ".saipen").rglob("*"))
        self.assertEqual(before, after)

    def test_the_cli_projection_answers_verdict_and_observation_together(self):
        import json
        import os
        import subprocess

        env = {**os.environ}
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT"):
            env.pop(key, None)
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "autonomy",
                "--json",
                "--project-root",
                str(self.project),
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
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["code"], "AUTONOMY_STATUS")
        self.assertIn(payload["verdict"], supervisor.VERDICTS)
        # One answer, not two reads: the verdict and the picture that produced
        # it travel together or a caller can act on a moment that has passed.
        self.assertIn("observation", payload)
        self.assertEqual(
            payload["may_mutate"], payload["verdict"] in supervisor.MUTATING_VERDICTS
        )

    def test_the_cli_projection_writes_nothing(self):
        import os
        import subprocess

        before = sorted(
            (p.relative_to(self.project).as_posix(), p.stat().st_size)
            for p in (self.project / ".saipen").rglob("*")
            if p.is_file()
        )
        env = {**os.environ}
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT"):
            env.pop(key, None)
        subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "autonomy",
                "--json",
                "--project-root",
                str(self.project),
                "--agent",
                "tester",
            ],
            capture_output=True,
            text=True,
            timeout=300,
            env=env,
        )
        after = sorted(
            (p.relative_to(self.project).as_posix(), p.stat().st_size)
            for p in (self.project / ".saipen").rglob("*")
            if p.is_file()
        )
        self.assertEqual(before, after)

    def test_the_verb_is_registered_where_the_surface_is_declared(self):
        import json

        registry = json.loads((ROOT / "saipen" / "REGISTRY.json").read_text(encoding="utf-8"))
        effects = json.loads(
            (ROOT / "saipen" / "COMMAND_EFFECTS.json").read_text(encoding="utf-8")
        )
        self.assertIn("autonomy", registry["commands"]["saipen"])
        self.assertEqual(effects["verbs"]["autonomy"], "DIAGNOSTIC")

    def test_every_verdict_names_a_canonical_command(self):
        # Total by construction: a verdict added without a command would make
        # `decide` raise instead of quietly answering "continue as appropriate".
        self.assertEqual(set(supervisor.NEXT_COMMAND), set(supervisor.VERDICTS))
        for verdict, command in supervisor.NEXT_COMMAND.items():
            with self.subTest(verdict=verdict):
                self.assertTrue(command.startswith("saipen "), command)

    def test_a_stop_names_its_reason_and_a_run_does_not(self):
        verdict = supervisor.decide(self.project, now=T0)
        self.assertEqual(verdict["verdict"], supervisor.RUN_WORK)
        self.assertEqual(verdict["stop_reason"], "")
        watchdog.acquire_lease(self.project, "worker-a", now=T0)
        waiting = supervisor.decide(self.project, now=_at(5), worker_id="worker-b")
        self.assertTrue(waiting["stop_reason"])
        self.assertEqual(waiting["stop_reason"], waiting["reason"])

    def test_the_picture_carries_the_last_durable_checkpoint(self):
        from saipen_engine import worker

        self.assertIsNone(supervisor.observe(self.project, now=T0)["durable_checkpoint"])
        authority = worker.take_authority(self.project, "worker-a", now=T0)
        worker.run_slice(
            self.project, "worker-a", authority["generation"], index=1, work="T-1", now=T0
        )
        checkpoint = supervisor.observe(self.project, now=_at(1))["durable_checkpoint"]
        self.assertEqual(checkpoint["worker_id"], "worker-a")
        self.assertEqual(checkpoint["work"], "T-1")

    def test_elapsed_progress_comes_from_the_history_not_the_readers_clock(self):
        tracker = SemanticProgressTracker(threshold=3)
        tracker.record(
            Observation(work_id="T-1", phase="BUILD", timestamp="2026-09-22T11:00:00Z")
        )
        picture = supervisor.observe(self.project, now=_at(9999), tracker=tracker)
        self.assertEqual(picture["last_progress_at"], "2026-09-22T11:00:00Z")

    def test_every_verdict_declares_whether_it_may_mutate(self):
        self.assertTrue(supervisor.MUTATING_VERDICTS.issubset(supervisor.VERDICTS))
        for stop in (
            supervisor.OPERATOR_ACTION_DUE,
            supervisor.NO_PROGRESS_LOOP,
            supervisor.AMBIGUOUS_AUTHORITY,
            supervisor.AWAIT_WORKER,
            supervisor.IDLE,
        ):
            with self.subTest(verdict=stop):
                self.assertNotIn(stop, supervisor.MUTATING_VERDICTS)


if __name__ == "__main__":
    unittest.main()
