"""T-1446 M12-M14: the execution owner under deterministic chaos.

`supervisor.decide` was a decider with no owner: nothing launched a worker,
heartbeated it, noticed it died or froze, or told a provider failure from a
crash. `worker.supervise` is that owner. These controls drive it against REAL
agent processes -- a scripted stand-in for an agent host that performs one
planned behaviour per launch: make progress, crash hard, freeze, fail with a
provider/model/auth error, or do nothing.

Required zeros (SRC-105 section 24): stolen leases, simultaneous generations,
lost Work, fabricated progress, manual continuation, false global stop.

The fence regression lives here too: before this Work a fenced lease read
HEALTHY until its heartbeat aged out, the fenced generation still passed
`mutation_allowed`, and one heartbeat from it un-fenced the lease.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
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
    "- [/] T-1 [P1] the unattended mission | verify: a passing test | owner: tester | "
    "claim_time: 2026-09-22T12:00:00Z\n"
    "## TODO\n"
    "## DONE\n"
    "## BLOCKED\n"
)

#: The scripted agent host. One planned behaviour per launch; every launch is
#: traced with its pid, lease generation and model so the test can prove the
#: generations never overlapped and the model changed only by fallback.
AGENT = r'''
import json, os, sys, time
from pathlib import Path

root = Path.cwd()
assert os.environ.get("PWD") == str(root), "PWD must name the project"
assert "SAIPEN_PROJECT_ROOT" not in os.environ, "no inherited binding carrier"
control = Path(os.environ["FAKE_AGENT_CONTROL"])
plan = json.loads((control / "plan.json").read_text(encoding="utf-8"))
counter = control / "counter.txt"
index = int(counter.read_text()) if counter.exists() else 0
counter.write_text(str(index + 1))
mode = plan[index] if index < len(plan) else "noop"
model = sys.argv[1] if len(sys.argv) > 1 else ""
trace = {"index": index, "mode": mode, "pid": os.getpid(), "model": model,
         "generation": os.environ.get("SAIPEN_LEASE_GENERATION"),
         "worker": os.environ.get("SAIPEN_AUTONOMY_WORKER"), "start": time.time()}

def bump(extra_phase=None, finish=False):
    state = root / ".saipen" / "STATE.md"
    text = state.read_text(encoding="utf-8")
    event = int(text.split("last_event: ", 1)[1].split("\n", 1)[0]) + 1
    text = text.replace(f"last_event: {event - 1}\n", f"last_event: {event}\n")
    if finish:
        text = (text.replace("task: T-1\n", "task: none\n")
                    .replace("phase: BUILD\n", "phase: DONE\n")
                    .replace('next_action: "PHASE BUILD T-1"', 'next_action: "saipen continue"'))
        board = root / ".saipen" / "BOARD.md"
        rows = board.read_text(encoding="utf-8").split("\n")
        mission = [row for row in rows if row.startswith("- [/] T-1")][0]
        rows = [row for row in rows if row != mission]
        rows.insert(rows.index("## DONE") + 1,
                    mission.replace("- [/]", "- [x]").split(" | owner:")[0])
        board.write_text("\n".join(rows), encoding="utf-8")
    state.write_text(text, encoding="utf-8")
    with (root / ".saipen" / "LOG.md").open("a", encoding="utf-8") as log:
        log.write(f"- 22.09.26 12:00 [E-{event:03d}] [T-1] [agent: tester] RUN: {mode}\n")

def done(code=0, text=""):
    trace["end"] = time.time()
    with (control / "trace.jsonl").open("a", encoding="utf-8") as out:
        out.write(json.dumps(trace) + "\n")
    if text:
        print(text, flush=True)
    sys.stdout.flush()
    os._exit(code)

if mode == "work":
    bump(); done()
if mode == "finish":
    bump(finish=True); done()
if mode == "crash":
    done(9)
if mode == "crash_after_work":
    bump(); done(9)
if mode == "hang":
    trace["end"] = None
    with (control / "trace.jsonl").open("a", encoding="utf-8") as out:
        out.write(json.dumps(trace) + "\n")
    time.sleep(60)
if mode == "ratelimit":
    done(1, "Error: 429 Too Many Requests -- rate limit reached")
if mode == "quota":
    done(1, "insufficient_quota: You exceeded your current quota")
if mode == "model_missing":
    if model == "bad-model":
        done(1, f"Error: model {model} not found")
    bump(); done()
if mode == "auth":
    done(1, "401 Unauthorized: invalid api key")
if mode == "weird":
    done(3, "something odd happened")
if mode == "hang_tree":
    import subprocess
    beat = control / "grandchild.beat"
    subprocess.Popen([sys.executable, "-c",
        "import sys, time, pathlib\n"
        "p = pathlib.Path(sys.argv[1])\n"
        "n = 0\n"
        "while True:\n"
        "    n += 1\n"
        "    p.write_text(str(n))\n"
        "    time.sleep(0.1)\n", str(beat)])
    trace["end"] = None
    with (control / "trace.jsonl").open("a", encoding="utf-8") as out:
        out.write(json.dumps(trace) + "\n")
    time.sleep(60)
if mode == "slow_work":
    for _ in range(6):
        bump()
        time.sleep(0.5)
    done()
if mode == "slow_forever":
    trace["end"] = None
    with (control / "trace.jsonl").open("a", encoding="utf-8") as out:
        out.write(json.dumps(trace) + "\n")
    while True:
        bump()
        time.sleep(0.4)
if mode == "no_tools":
    if model != "tool-model":
        done(1, "Error: this model does not support tools")
    bump(); done()
if mode in ("big_transcript", "big_transcript_killed", "big_transcript_then_error"):
    # The agent reads a long protocol document that quotes provider words.
    # The event is larger than the classifier's tail, so the tail's cut lands
    # inside it -- the 24H gate shape of 2026-09-23 (T-1485).
    words = " 403 Forbidden; 429 Too Many Requests; 401 Unauthorized; billing "
    print(json.dumps({"type": "tool_use", "part": {"state": {
        "output": "x" * 70000 + words + "y" * 2000}}}), flush=True)
    if mode == "big_transcript_killed":
        sys.stdout.write('{"type": "tool_use", "part": {"state": {"output": "401 Unauthorized')
        done(1)
    if mode == "big_transcript_then_error":
        done(1, "Error: 401 Unauthorized: invalid api key")
    done(0, json.dumps({"type": "step_finish"}))
done(0)
'''


class SuperviseFixture(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="saipen-supervise-"))
        self.addCleanup(shutil.rmtree, self.base, ignore_errors=True)
        self.project = self.base / "project"
        (self.project / ".saipen").mkdir(parents=True)
        (self.project / ".saipen" / "STATE.md").write_text(STATE, encoding="utf-8")
        (self.project / ".saipen" / "BOARD.md").write_text(BOARD, encoding="utf-8")
        (self.project / ".saipen" / "LOG.md").write_text(
            "- 22.09.26 12:00 [E-007] [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        self.control = self.base / "control"
        self.control.mkdir()
        self.agent = self.base / "agent.py"
        self.agent.write_text(AGENT, encoding="utf-8")

    def run_plan(self, plan: list[str], *, model=None, fallback=(), **kwargs) -> dict:
        (self.control / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
        argv = [sys.executable, str(self.agent)]
        if model is not None:
            argv.append(worker.MODEL_PLACEHOLDER)
        options = {
            "max_cycles": 20,
            "slice_timeout": 3.0,
            "heartbeat_every": 0.2,
            "backoff": (0.0,),
            "env": {"FAKE_AGENT_CONTROL": str(self.control)},
            "sleep": lambda _seconds: None,
        }
        options.update(kwargs)
        return worker.supervise(
            self.project, argv, model=model, fallback_models=fallback, **options
        )

    def trace(self) -> list[dict]:
        path = self.control / "trace.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]

    def assert_generations_never_overlap(self, trace: list[dict]) -> None:
        generations = [int(item["generation"]) for item in trace]
        self.assertEqual(generations, sorted(generations), trace)
        self.assertEqual(len(set(generations)), len(generations), trace)
        for earlier, later in zip(trace, trace[1:]):
            if earlier.get("end") is not None:
                self.assertLessEqual(earlier["end"], later["start"] + 0.001, (earlier, later))

    def state_text(self) -> str:
        return (self.project / ".saipen" / "STATE.md").read_text(encoding="utf-8")


class ChaosTests(SuperviseFixture):
    def test_death_freeze_and_provider_failure_never_lose_the_mission(self):
        result = self.run_plan(
            ["work", "crash", "work", "hang", "ratelimit", "crash_after_work", "work", "finish"]
        )
        counters = result["counters"]
        self.assertEqual(result["stop"], supervisor.IDLE, result)
        self.assertTrue(result["ok"], result)
        self.assertEqual(counters["worker_generation_count"], 8, result)
        # crash, hang and crash_after_work each cost one generation, never the mission.
        self.assertEqual(counters["crash_recovery_count"], 3, result)
        self.assertEqual(counters["backoff_count"], 1, result)
        self.assertEqual(counters["progress_slices"], 5, result)
        self.assertEqual(result["counters"]["failures"].get("HOST_RUNTIME_FAILURE"), 1)
        self.assertEqual(result["counters"]["failures"].get("WORKER_CRASH"), 2)
        self.assertEqual(result["counters"]["failures"].get("RATE_LIMITED"), 1)
        for zero in ("stolen_lease_count", "manual_continue_count",
                     "unknown_terminal_failure_count"):
            self.assertEqual(counters[zero], 0, (zero, result))
        self.assertLess(result["maximum_recovery_latency_seconds"], 300.0)
        self.assert_generations_never_overlap(self.trace())
        # The mission reached DONE through the agent's own canonical writes.
        self.assertIn("task: none", self.state_text())
        self.assertIn("- [x] T-1", (self.project / ".saipen" / "BOARD.md").read_text("utf-8"))
        # The last generation is fenced: nothing it might still do can mutate.
        lease = watchdog.observe(self.project)
        self.assertEqual(lease.state, watchdog.EXPIRED, lease)

    def test_supervisor_restart_with_zero_memory_continues(self):
        first = self.run_plan(["work", "crash", "work", "finish"], max_cycles=2)
        self.assertEqual(first["stop"], "MAX_CYCLES", first)
        second = worker.supervise(
            self.project,
            [sys.executable, str(self.agent)],
            max_cycles=10,
            slice_timeout=3.0,
            heartbeat_every=0.2,
            backoff=(0.0,),
            env={"FAKE_AGENT_CONTROL": str(self.control)},
            sleep=lambda _s: None,
        )
        self.assertIn(second["stop"], (supervisor.IDLE,), second)
        self.assertNotEqual(first["run_id"], second["run_id"])
        trace = self.trace()
        self.assert_generations_never_overlap(trace)
        self.assertEqual([item["mode"] for item in trace], ["work", "crash", "work", "finish"])
        self.assertGreater(worker.read_checkpoint(self.project)["slices_total"], 3)

    def test_repeated_no_progress_stops_instead_of_burning_budget(self):
        result = self.run_plan(["noop"] * 12)
        self.assertEqual(result["stop"], supervisor.NO_PROGRESS_LOOP, result)
        self.assertLessEqual(result["counters"]["worker_generation_count"], 6, result)
        self.assertIn("task: T-1", self.state_text(), "Work is preserved, not dropped")

    def test_unknown_failure_stops_after_the_repeat_bound(self):
        result = self.run_plan(["weird", "weird", "work"])
        self.assertEqual(result["stop"], supervisor.UNKNOWN_FAILURE, result)
        self.assertEqual(result["counters"]["unknown_terminal_failure_count"], 1, result)
        self.assertIn("task: T-1", self.state_text())


class QualityOverTimeTests(SuperviseFixture):
    """QUALITY-TIME-01: elapsed time is never failure; missing progress is."""

    def test_a_slow_generation_that_keeps_progressing_is_not_killed(self):
        # Runs ~3 s against a 1 s idle bound: every bump restarts the bound.
        result = self.run_plan(["slow_work", "finish"], slice_timeout=1.0, max_slice_seconds=20.0)
        self.assertEqual(result["stop"], supervisor.IDLE, result)
        self.assertEqual(result["counters"]["failures"], {}, result)
        self.assertEqual(result["counters"]["crash_recovery_count"], 0, result)

    def test_the_host_bound_ends_a_progressing_slice_without_failure(self):
        result = self.run_plan(
            ["slow_forever", "finish"], slice_timeout=1.0, max_slice_seconds=2.5
        )
        self.assertEqual(result["stop"], supervisor.IDLE, result)
        self.assertEqual(result["counters"]["slow_progress_slices"], 1, result)
        self.assertEqual(result["counters"]["failures"], {}, result)
        self.assertEqual(result["counters"]["worker_generation_count"], 2, result)

    def test_an_idle_generation_is_still_bounded(self):
        result = self.run_plan(["hang", "finish"], slice_timeout=1.0, max_slice_seconds=30.0)
        self.assertEqual(result["counters"]["failures"].get("HOST_RUNTIME_FAILURE"), 1, result)
        self.assertEqual(result["stop"], supervisor.IDLE, result)

    def test_model_identity_never_enters_canonical_truth(self):
        self.run_plan(
            ["model_missing", "model_missing", "finish"],
            model="bad-model",
            fallback=("good-model",),
        )
        for name in ("STATE.md", "BOARD.md", "LOG.md"):
            text = (self.project / ".saipen" / name).read_text(encoding="utf-8")
            self.assertNotIn("bad-model", text, name)
            self.assertNotIn("good-model", text, name)


class FailureChannelTests(unittest.TestCase):
    """Field soak 2026-09-22: a killed generation was stopped as AUTH_FAILED
    because an auth word sat in the agent's own transcript."""

    TRANSCRIPT = "\n".join(
        [
            json.dumps({"type": "tool_use", "part": {"state": {"output":
                        "HTTP 401 Unauthorized is handled in auth.py; 429 rate limit docs"}}}),
            json.dumps({"type": "text", "part": {"text": "the model is not found in cache"}}),
        ]
    )

    def test_transcript_content_never_names_the_failure(self):
        text = worker.failure_text(self.TRANSCRIPT, "")
        self.assertEqual(text, "")
        # A forced kill exits 1 with a silent error channel: a crash, not auth.
        self.assertEqual(supervisor.classify_failure(1, text), supervisor.WORKER_CRASH)
        self.assertEqual(supervisor.classify_failure(9, text), supervisor.WORKER_CRASH)

    def test_error_events_and_stderr_still_classify(self):
        event = json.dumps({"type": "error", "error": {"message": "429 Too Many Requests"}})
        text = worker.failure_text(self.TRANSCRIPT + "\n" + event, "")
        self.assertEqual(supervisor.classify_failure(1, text), supervisor.RATE_LIMITED)
        text = worker.failure_text(self.TRANSCRIPT, "Error: 401 Unauthorized")
        self.assertEqual(supervisor.classify_failure(1, text), supervisor.AUTH_FAILED)
        plain = worker.failure_text("Error: model x not found", "")
        self.assertEqual(supervisor.classify_failure(1, plain), supervisor.MODEL_UNAVAILABLE)

    def test_a_torn_event_is_transcript_not_error_text(self):
        torn = self.TRANSCRIPT + '\n{"type": "tool_use", "part": {"output": "401 Unauthorized'
        text = worker.failure_text(torn, "")
        self.assertEqual(text, "")
        self.assertEqual(supervisor.classify_failure(9, text), supervisor.WORKER_CRASH)


class TailTests(unittest.TestCase):
    """T-1485: the classifier's tail never starts inside a line."""

    def tail_of(self, payload: bytes) -> str:
        with tempfile.TemporaryFile() as handle:
            handle.write(payload)
            return worker._tail(handle)

    def test_a_cut_inside_a_line_drops_the_fragment(self):
        size = worker.OUTPUT_TAIL_BYTES
        last = b'{"type": "step_finish"}\n'
        payload = b'{"output": "' + b"x" * size + b' 403 Forbidden"}\n' + last
        self.assertEqual(self.tail_of(payload), last.decode())

    def test_a_cut_on_a_line_boundary_keeps_the_whole_line(self):
        size = worker.OUTPUT_TAIL_BYTES
        kept = b"k" * (size - 1) + b"\n"
        self.assertEqual(self.tail_of(b"dropped\n" + kept), kept.decode())

    def test_a_short_output_is_whole(self):
        self.assertEqual(self.tail_of(b"Error: 401 Unauthorized\n"), "Error: 401 Unauthorized\n")

    def test_one_line_longer_than_the_tail_leaves_nothing(self):
        self.assertEqual(self.tail_of(b"y" * (worker.OUTPUT_TAIL_BYTES * 2)), "")


class TruncatedTranscriptTests(SuperviseFixture):
    """24H gate 2026-09-23 (T-1485): the run stopped as AUTH_FAILED at 11005 s
    because the tail began inside the agent's reading of saipen/OPS.md."""

    def test_a_long_read_never_stops_the_run_on_a_clean_exit(self):
        result = self.run_plan(["big_transcript", "finish"])
        self.assertEqual(result["stop"], supervisor.IDLE, result)
        self.assertIsNone(result["history"][0]["failure"], result["history"][0])
        self.assertEqual(result["counters"]["failures"], {}, result)

    def test_a_killed_generation_after_a_long_read_is_a_crash(self):
        result = self.run_plan(["big_transcript_killed", "finish"])
        self.assertEqual(result["stop"], supervisor.IDLE, result)
        self.assertEqual(result["history"][0]["failure"], supervisor.WORKER_CRASH)

    def test_a_genuine_error_line_after_a_long_read_still_classifies(self):
        result = self.run_plan(["big_transcript_then_error"])
        self.assertEqual(result["stop"], supervisor.AUTH_FAILED, result)


class ProcessTreeTests(SuperviseFixture):
    def test_a_frozen_generation_dies_with_every_process_it_started(self):
        import time

        result = self.run_plan(["hang_tree", "finish"], slice_timeout=1.0)
        self.assertEqual(result["stop"], supervisor.IDLE, result)
        beat = self.control / "grandchild.beat"
        self.assertTrue(beat.exists(), "the grandchild never started")
        time.sleep(0.6)
        first = beat.read_text()
        time.sleep(0.6)
        self.assertEqual(beat.read_text(), first, "a grandchild outlived its generation")


class CapabilityTests(SuperviseFixture):
    """A missing capability is its own class, never a reasoning verdict."""

    def test_a_runtime_without_tools_moves_only_to_an_authorized_runtime(self):
        result = self.run_plan(
            ["no_tools", "no_tools", "finish"], model="chat-only", fallback=("tool-model",)
        )
        self.assertEqual(result["stop"], supervisor.IDLE, result)
        self.assertEqual(result["counters"]["failures"], {"CAPABILITY_UNAVAILABLE": 1}, result)
        self.assertEqual(result["counters"]["model_replacement_recovery_count"], 1)

    def test_without_an_authorized_runtime_the_blocker_is_truthful(self):
        result = self.run_plan(["no_tools"], model="chat-only")
        self.assertEqual(result["stop"], supervisor.CAPABILITY_UNAVAILABLE, result)
        self.assertIn("task: T-1", self.state_text())

    def test_an_absent_host_executable_is_a_capability_absence(self):
        (self.control / "plan.json").write_text(json.dumps(["work"]), encoding="utf-8")
        result = worker.supervise(
            self.project,
            [str(self.base / "no-such-host.exe")],
            max_cycles=5,
            slice_timeout=2.0,
            heartbeat_every=0.2,
            backoff=(0.0,),
            sleep=lambda _s: None,
        )
        self.assertEqual(result["stop"], supervisor.CAPABILITY_UNAVAILABLE, result)
        self.assertIn("task: T-1", self.state_text())


class ProviderFailureTests(SuperviseFixture):
    def test_quota_without_authorized_fallback_is_an_operator_stop(self):
        before = self.state_text()
        result = self.run_plan(["quota"], model="primary")
        self.assertEqual(result["stop"], supervisor.QUOTA_EXHAUSTED, result)
        self.assertFalse(result["ok"])
        self.assertIn("authorize a fallback model", result["operator_action"])
        self.assertEqual(self.state_text(), before, "Work, phase and epoch untouched")

    def test_missing_model_falls_back_only_to_an_authorized_model(self):
        result = self.run_plan(
            ["model_missing", "model_missing", "finish"],
            model="bad-model",
            fallback=("good-model",),
        )
        self.assertEqual(result["stop"], supervisor.IDLE, result)
        self.assertEqual(result["counters"]["model_replacement_recovery_count"], 1, result)
        models = [item["model"] for item in self.trace()]
        self.assertEqual(models, ["bad-model", "good-model", "good-model"], models)

    def test_auth_failure_never_falls_back(self):
        result = self.run_plan(["auth"], model="primary", fallback=("other",))
        self.assertEqual(result["stop"], supervisor.AUTH_FAILED, result)
        self.assertEqual(result["counters"]["model_replacement_recovery_count"], 0)

    def test_the_failure_vocabulary_is_closed_and_ordered(self):
        cases = [
            ((1, "429 insufficient_quota"), supervisor.QUOTA_EXHAUSTED),
            ((1, "HTTP 429 Too Many Requests"), supervisor.RATE_LIMITED),
            ((1, "401 Unauthorized"), supervisor.AUTH_FAILED),
            ((1, "model gpt-x not found"), supervisor.MODEL_UNAVAILABLE),
            ((1, "503 Service Unavailable"), supervisor.PROVIDER_UNAVAILABLE),
            ((1, "connect ECONNREFUSED 127.0.0.1:20128"), supervisor.NETWORK_UNAVAILABLE),
            ((9, ""), supervisor.WORKER_CRASH),
            ((1, "Traceback (most recent call last):\n  boom"), supervisor.HOST_RUNTIME_FAILURE),
            ((3, "something odd"), supervisor.UNKNOWN_FAILURE),
            ((0, "all good"), None),
        ]
        for (code, text), expected in cases:
            with self.subTest(text=text):
                self.assertEqual(supervisor.classify_failure(code, text), expected)
        self.assertEqual(
            supervisor.classify_failure(0, "429 rate limit", progressed=False),
            supervisor.RATE_LIMITED,
        )
        self.assertEqual(
            supervisor.classify_failure(None, "", timed_out=True), supervisor.HOST_RUNTIME_FAILURE
        )
        self.assertEqual(set(supervisor.FAILURE_POLICY), set(supervisor.FAILURE_CLASSES))


class AuthorityTests(SuperviseFixture):
    def test_a_healthy_foreign_worker_is_awaited_never_stolen(self):
        lease = watchdog.acquire_lease(self.project, "other-supervisor")
        result = self.run_plan(["work"], max_awaits=2)
        self.assertEqual(result["stop"], supervisor.AWAIT_WORKER, result)
        after = watchdog.observe(self.project)
        self.assertEqual(after.worker_id, "other-supervisor")
        self.assertEqual(after.lease_generation, lease["lease_generation"])
        self.assertEqual(self.trace(), [], "no generation may start beside a live one")
        self.assertEqual(result["counters"]["stolen_lease_count"], 0)

    def test_corrupt_lease_state_fails_closed(self):
        path = self.project / watchdog.CACHE_REL
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        result = self.run_plan(["work"])
        self.assertEqual(result["stop"], supervisor.AMBIGUOUS_AUTHORITY, result)
        self.assertEqual(self.trace(), [])


class FenceTests(unittest.TestCase):
    """A fence takes effect when written; a fenced generation cannot revive."""

    def test_a_fenced_generation_is_dead_immediately(self):
        root = Path(tempfile.mkdtemp(prefix="saipen-fence-"))
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        (root / ".saipen").mkdir()
        lease = watchdog.acquire_lease(root, "a")
        generation = lease["lease_generation"]
        watchdog.fence(root, "a", generation)
        self.assertEqual(watchdog.observe(root).state, watchdog.EXPIRED)
        self.assertFalse(watchdog.mutation_allowed(root, "a", generation))
        with self.assertRaises(RuntimeError):
            watchdog.heartbeat(root, "a", generation)
        replacement = watchdog.acquire_lease(root, "b")
        self.assertEqual(replacement["lease_generation"], generation + 1)
        self.assertFalse(watchdog.mutation_allowed(root, "a", generation))
        self.assertTrue(watchdog.mutation_allowed(root, "b", generation + 1))


if __name__ == "__main__":
    unittest.main()
