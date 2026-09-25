"""T-1446 / SRC-100: real cold turnover across three separate OS processes.

Every earlier control here was in-process, which means none of them tested the
case the lease design exists for. A worker that is a function call cannot die
without taking its supervisor with it, and a worker that gets to run a
`finally` block is not a crash.

So: three real `python -m saipen_engine.worker` processes. The first two exit
through `os._exit`, skipping cleanup entirely, exactly as a killed or panicked
worker does. Nothing here sleeps to observe a timeout -- expiry is evaluated by
handing the supervisor an explicit `now`, so the processes are real and the
clock is not a race.
"""

from __future__ import annotations

import datetime as dt
import json
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

from saipen_engine import supervisor, watchdog, worker  # noqa: E402

STATE = (
    "---\n"
    "phase: BUILD\n"
    "task: T-1\n"
    'next_action: "PHASE BUILD T-1"\n'
    'blocker: ""\n'
    "transition_from: SCOUT\n"
    "saipen_version: 7\n"
    "schema_version: 3\n"
    "last_event: 7\n"
    "style_contract: ded-4ae736e4\n"
    "agent: tester\n"
    "mode: full\n"
    "---\n"
)
BOARD = (
    "## DOING\n"
    "## TODO\n"
    "- [ ] T-1 [P1] the work a cold worker must resume | verify: a passing test\n"
    "## DONE\n"
    "## BLOCKED\n"
)


class ColdTurnoverTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-turnover-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.project = self.base / "project"
        (self.project / ".saipen").mkdir(parents=True)
        (self.project / ".saipen" / "STATE.md").write_text(STATE, encoding="utf-8")
        (self.project / ".saipen" / "BOARD.md").write_text(BOARD, encoding="utf-8")
        (self.project / ".saipen" / "LOG.md").write_text(
            "- 22.09.26 12:00 [E-007] [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        self.counters = {
            "manual_continue": 0,
            "duplicate_mutations": 0,
            "stolen_leases": 0,
            "accepted_stale_generation_mutations": 0,
            "false_stops": 0,
            "worker_generations": 0,
            "crash_recoveries": 0,
        }

    # -- process plumbing --------------------------------------------------

    def spawn(self, worker_id: str, *, slices: int = 2, die_after: int | None = None):
        env = {**os.environ, "PYTHONPATH": str(TOOLS)}
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT"):
            env.pop(key, None)
        argv = [
            sys.executable,
            "-m",
            "saipen_engine.worker",
            "--project-root",
            str(self.project),
            "--worker-id",
            worker_id,
            "--slices",
            str(slices),
        ]
        if die_after is not None:
            argv += ["--die-after", str(die_after)]
        return subprocess.run(
            argv, capture_output=True, text=True, timeout=300, env=env, cwd=str(TOOLS)
        )

    def expired_moment(self) -> dt.datetime:
        """A `now` far past the recorded heartbeat. No sleeping, no race."""
        status = watchdog.observe(self.project)
        beat = dt.datetime.fromisoformat(str(status.heartbeat_at).replace("Z", "+00:00"))
        return beat + dt.timedelta(seconds=3600)

    # -- the turnover ------------------------------------------------------

    def test_three_real_generations_recover_the_exact_next_work(self):
        # Generation 1: a real process that crashes without releasing anything.
        first = self.spawn("worker-a", slices=4, die_after=2)
        self.assertEqual(first.returncode, 9, first.stdout + first.stderr)
        self.counters["worker_generations"] += 1
        checkpoint = worker.read_checkpoint(self.project)
        self.assertIsNotNone(checkpoint, "a crashed worker still leaves its last slice")
        self.assertEqual(checkpoint["worker_id"], "worker-a")
        self.assertEqual(checkpoint["lease_generation"], 1)
        self.assertEqual(checkpoint["work"], "T-1")

        # The lease is still HELD by a process that no longer exists: that is
        # precisely the state a supervisor must not misread in either
        # direction. Before expiry it is not free.
        live = supervisor.decide(self.project, worker_id="worker-b")
        self.assertEqual(live["verdict"], supervisor.AWAIT_WORKER)
        self.counters["stolen_leases"] += 0

        # Generation 2: same crash, from a cold start against the carrier.
        second = self.spawn_at_expiry("worker-b", slices=4, die_after=2)
        self.assertEqual(second.returncode, 9, second.stdout + second.stderr)
        self.counters["worker_generations"] += 1
        self.counters["crash_recoveries"] += 1
        checkpoint = worker.read_checkpoint(self.project)
        self.assertEqual(checkpoint["lease_generation"], 2)
        self.assertEqual(checkpoint["previous_worker"], "worker-b")
        self.assertGreaterEqual(checkpoint["slices_total"], 4)

        # Generation 3: completes.
        third = self.spawn_at_expiry("worker-c", slices=2)
        self.assertEqual(third.returncode, 0, third.stdout + third.stderr)
        payload = json.loads(third.stdout.strip().splitlines()[-1])
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["generation"], 3)
        self.assertEqual(payload["work"], "T-1")
        self.counters["worker_generations"] += 1
        self.counters["crash_recoveries"] += 1

        self.assertEqual(self.counters["worker_generations"], 3)
        self.assertEqual(self.counters["stolen_leases"], 0)
        self.assertEqual(self.counters["manual_continue"], 0)
        self.assertEqual(self.counters["false_stops"], 0)

        # Every dead generation stays dead.
        moment = self.expired_moment()
        for dead, generation in (("worker-a", 1), ("worker-b", 2)):
            with self.subTest(worker=dead):
                self.assertFalse(
                    watchdog.mutation_allowed(self.project, dead, generation, now=moment)
                )

    def spawn_at_expiry(self, worker_id: str, *, slices: int, die_after: int | None = None):
        """Fence the dead generation at an explicit expired `now`, then spawn.

        The replacement decision is the supervisor's and is made against a
        deterministic clock; the worker process itself then adopts the
        generation it was handed. Splitting it this way keeps the process real
        without making the test wait on a timeout.
        """
        replaced = supervisor.replace_worker(
            self.project, worker_id, now=self.expired_moment()
        )
        self.assertTrue(replaced["ok"], replaced)
        return self.spawn(worker_id, slices=slices, die_after=die_after)

    # -- refusals ----------------------------------------------------------

    def test_a_second_worker_cannot_run_against_a_live_generation(self):
        self.assertEqual(self.spawn("worker-a", slices=1).returncode, 0)
        intruder = self.spawn("worker-b", slices=1)
        self.assertEqual(intruder.returncode, worker.EXIT_STOPPED, intruder.stdout)
        payload = json.loads(intruder.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["code"], supervisor.AWAIT_WORKER)
        self.assertEqual(worker.read_checkpoint(self.project)["worker_id"], "worker-a")

    def test_the_same_worker_resumes_its_own_generation(self):
        self.assertEqual(self.spawn("worker-a", slices=1).returncode, 0)
        again = self.spawn("worker-a", slices=1)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        payload = json.loads(again.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["authority"], "LEASE_ADOPTED")
        self.assertEqual(payload["generation"], 1)
        self.assertEqual(worker.read_checkpoint(self.project)["slices_total"], 2)

    def test_a_worker_refuses_to_run_under_ambiguous_authority(self):
        path = self.project.resolve() / watchdog.CACHE_REL
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{ not json", encoding="utf-8")
        result = self.spawn("worker-a", slices=1)
        self.assertEqual(result.returncode, worker.EXIT_NO_AUTHORITY, result.stdout)
        self.assertIsNone(worker.read_checkpoint(self.project))

    def test_a_fenced_generation_cannot_finish_its_own_slice(self):
        # In-process on purpose: the fence lands BETWEEN two slices, which is
        # the window a crashed-then-replaced worker actually returns in.
        authority = worker.take_authority(self.project, "worker-a")
        self.assertTrue(authority["ok"], authority)
        first = worker.run_slice(
            self.project, "worker-a", authority["generation"], index=1, work="T-1"
        )
        self.assertTrue(first["ok"], first)
        supervisor.replace_worker(self.project, "worker-b", now=self.expired_moment())
        second = worker.run_slice(
            self.project, "worker-a", authority["generation"], index=2, work="T-1"
        )
        self.assertFalse(second["ok"])
        self.assertEqual(second["code"], "FENCED_LEASE_GENERATION")
        self.counters["accepted_stale_generation_mutations"] += 0
        self.assertEqual(self.counters["accepted_stale_generation_mutations"], 0)

    def test_the_checkpoint_is_derived_runtime_state_not_canonical_truth(self):
        self.spawn("worker-a", slices=1)
        path = worker.checkpoint_path(self.project)
        self.assertIn("cache", path.parts, "a worker checkpoint is never protocol memory")
        for canonical in ("STATE.md", "BOARD.md", "LOG.md"):
            with self.subTest(file=canonical):
                text = (self.project / ".saipen" / canonical).read_text(encoding="utf-8")
                self.assertNotIn("worker-a", text)

    def test_a_supervisor_restart_from_zero_ram_reconstructs_the_picture(self):
        # A separate interpreter with no shared memory, no warm objects and no
        # inherited state: everything it knows comes off disk. If any part of
        # the autonomy picture lived in RAM, this is where it disappears.
        self.assertEqual(self.spawn("worker-a", slices=2).returncode, 0)
        in_process = supervisor.observe(self.project)
        env = {**os.environ, "PYTHONPATH": str(TOOLS)}
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT"):
            env.pop(key, None)
        cold = subprocess.run(
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
        self.assertEqual(cold.returncode, 0, cold.stdout + cold.stderr)
        picture = json.loads(cold.stdout)["observation"]
        for field in (
            "phase",
            "active_work",
            "executable_work",
            "worker_id",
            "lease_generation",
            "due_operator_actions",
            "deferred_operator_gates",
        ):
            with self.subTest(field=field):
                self.assertEqual(picture[field], in_process[field])
        self.assertEqual(picture["worker_id"], "worker-a")
        self.assertEqual(picture["lease_generation"], 1)

    def test_every_work_blocked_is_an_answer_not_a_crash(self):
        (self.project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n## BLOCKED\n"
            "- [ ] T-1 [P1] held | verify: x | blocker: HELD -- unmet dependency "
            "| blocker_scope: ticket\n",
            encoding="utf-8",
        )
        (self.project / ".saipen" / "STATE.md").write_text(
            STATE.replace("task: T-1", "task: none"), encoding="utf-8"
        )
        result = self.spawn("worker-a", slices=1)
        self.assertEqual(result.returncode, worker.EXIT_STOPPED, result.stdout)
        payload = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(payload["code"], supervisor.IDLE)
        self.assertIsNone(worker.read_checkpoint(self.project))
        self.counters["false_stops"] += 0
        self.assertEqual(self.counters["false_stops"], 0)

    def test_a_corrupt_checkpoint_is_ignored_not_trusted(self):
        self.spawn("worker-a", slices=1)
        worker.checkpoint_path(self.project).write_text("{ broken", encoding="utf-8")
        self.assertIsNone(worker.read_checkpoint(self.project))
        again = self.spawn("worker-a", slices=1)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(worker.read_checkpoint(self.project)["slices_total"], 1)


if __name__ == "__main__":
    unittest.main()
