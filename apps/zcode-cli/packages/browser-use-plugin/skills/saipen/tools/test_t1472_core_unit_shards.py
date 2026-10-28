"""T-1472: the declared core-unit family, run as shards of its one discovery.

Every SHIP here waited on one sequential `unittest discover` (3475 tests,
2254 s at af93fd56) while fifteen of the host's sixteen threads idled. The same
discovery now runs as concurrent shards, each in its own copy of the one
consistent snapshot. These controls hold the proof to what it was:

* a sharded run and the whole run of the same tree agree on ran and red --
  including a red test, a module that fails to import, class fixtures and a
  module in a subpackage no shard plan names;
* the partition is proven by arithmetic, and a shard that never reported, a
  shard that discovered a different family, or shards that together kept
  fewer tests than were discovered are problems that refuse the verdict;
* a shard whose own stream is inconsistent refuses the verdict even when the
  union looks consistent;
* a deliberate red in a sharded run still refuses SHIP.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import core_unit  # noqa: E402
from saipen_engine.test_runner import TestFamily  # noqa: E402

DECLARED_SHAPE = (
    sys.executable, "-B", "-m", "unittest", "discover", "-s", "tools", "-p", "test_*.py", "-v",
)

MODULES = {
    "test_alpha.py": (
        "import unittest\n\n\nclass A(unittest.TestCase):\n"
        "    def test_one(self):\n        pass\n\n"
        "    def test_two(self):\n        pass\n"
    ),
    "test_beta.py": (
        "import unittest\n\n\nclass B(unittest.TestCase):\n"
        "    def test_red(self):\n        '''A docstring hides the id.'''\n"
        "        self.fail('deliberate')\n\n"
        "    def test_green(self):\n        pass\n"
    ),
    "test_gamma.py": (
        "import unittest\n\nSEEN = []\n\n\nclass G(unittest.TestCase):\n"
        "    @classmethod\n    def setUpClass(cls):\n        SEEN.append('class')\n\n"
        "    def test_fixture_ran_once(self):\n        self.assertEqual(SEEN, ['class'])\n\n"
        "    def test_again(self):\n        self.assertEqual(SEEN, ['class'])\n"
    ),
    "test_broken.py": "import no_such_module_anywhere  # noqa: F401\n",
    "test_delta.py": (
        "import unittest\n\n\nclass D(unittest.TestCase):\n"
        "    def test_sub(self):\n"
        "        for n in range(3):\n"
        "            with self.subTest(n=n):\n                pass\n"
    ),
}


class PlanTests(unittest.TestCase):
    def test_every_module_lands_in_exactly_one_shard(self):
        modules = [f"test_{index}" for index in range(23)]
        plan = core_unit.plan_shards(modules, {"test_3": 90.0, "test_7": 40.0}, 4)
        flat = [name for shard in plan for name in shard]
        self.assertEqual(sorted(flat), sorted(modules))
        self.assertEqual(len(plan), 4)

    def test_longest_modules_are_spread_and_the_plan_is_deterministic(self):
        weights = {"test_a": 100.0, "test_b": 90.0, "test_c": 10.0, "test_d": 5.0}
        plan = core_unit.plan_shards(list(weights), weights, 2)
        self.assertEqual(plan, core_unit.plan_shards(list(reversed(weights)), weights, 2))
        self.assertNotEqual(
            [shard for shard in plan if "test_a" in shard],
            [shard for shard in plan if "test_b" in shard],
        )

    def test_only_the_declared_discovery_shape_is_sharded(self):
        self.assertEqual(core_unit.shardable(DECLARED_SHAPE), ("tools", "test_*.py"))
        self.assertIsNone(core_unit.shardable(DECLARED_SHAPE[:-1]))
        self.assertIsNone(core_unit.shardable((*DECLARED_SHAPE[:-1], "-f")))
        self.assertIsNone(core_unit.shardable((sys.executable, "tools/validate.py")))


def _shard(**overrides) -> dict:
    shard = {
        "status": "PASS",
        "exit_code": 0,
        "ran": 2,
        "red": [],
        "headers": 0,
        "unparsed": 0,
        "tallied": 0,
        "sections": {},
        "manifest": {"discovered": 4, "selected": 2, "modules": {"test_x": 1.5}},
        "duration_s": 2.0,
    }
    shard.update(overrides)
    return shard


class MergeTests(unittest.TestCase):
    def verdict(self, *shards) -> dict:
        run = {**core_unit.merge_shards(list(shards)), "timeout_s": 60}
        return core_unit.judge(run, [])

    def test_two_consistent_shards_are_one_pass(self):
        run = core_unit.merge_shards([_shard(), _shard()])
        self.assertEqual((run["ran"], run["discovered"], run["partition_error"]), (4, 4, None))
        self.assertEqual(core_unit.judge(run, [])["verdict"], "PASS")

    def test_a_shard_that_never_reported_refuses(self):
        verdict = self.verdict(_shard(), _shard(manifest=None))
        self.assertEqual(verdict["verdict"], "FAIL")
        self.assertIn("never reported", " ".join(verdict["problems"]))

    def test_shards_that_kept_fewer_tests_than_discovered_refuse(self):
        short = _shard(manifest={"discovered": 4, "selected": 1, "modules": {}})
        verdict = self.verdict(_shard(), short)
        self.assertIn("kept 3 of 4", " ".join(verdict["problems"]))

    def test_shards_that_discovered_different_families_refuse(self):
        other = _shard(manifest={"discovered": 5, "selected": 2, "modules": {}})
        verdict = self.verdict(_shard(), other)
        self.assertIn("different families", " ".join(verdict["problems"]))

    def test_one_inconsistent_shard_refuses_a_union_that_looks_consistent(self):
        # Shard 0 exited 1 with nothing parsed; shard 1 carries the only red.
        # The union (exit 1, one red) would pass the whole-run checks alone.
        red = _shard(status="FAIL", exit_code=1, red=["test_x.X.test"], headers=1, tallied=1)
        verdict = self.verdict(_shard(status="FAIL", exit_code=1), red)
        self.assertEqual(verdict["verdict"], "FAIL")
        self.assertIn("shard 0: exit code 1 with no parsed red test", verdict["problems"])

    def test_a_timed_out_shard_times_out_the_run(self):
        run = core_unit.merge_shards([_shard(), _shard(status="TIMEOUT", exit_code=None)])
        self.assertEqual((run["status"], run["exit_code"]), ("TIMEOUT", None))


class RealShardedRunTests(unittest.TestCase):
    """REAL unittest processes: the sharded run is the whole run, split."""

    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="saipen-t1472-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        self.project = base / "project"
        tools = self.project / "tools"
        tools.mkdir(parents=True)
        for name, body in MODULES.items():
            (tools / name).write_text(body, encoding="utf-8")
        # A module in a subpackage: no shard plan names it (plans are made
        # from top-level file names), so only the catch-all can run it.
        (tools / "pkg").mkdir()
        (tools / "pkg" / "__init__.py").write_text("", encoding="utf-8")
        (tools / "pkg" / "test_deep.py").write_text(
            "import unittest\n\n\nclass Deep(unittest.TestCase):\n"
            "    def test_deep(self):\n        pass\n",
            encoding="utf-8",
        )
        family = TestFamily(core_unit.FAMILY_NAME, DECLARED_SHAPE, 120)
        patcher = mock.patch.object(core_unit, "family", return_value=family)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_shards_and_the_whole_run_agree(self):
        whole = core_unit.run_family(self.project, jobs=1)
        sharded = core_unit.run_family(self.project, jobs=3)
        self.assertEqual(whole["jobs"], 1)
        self.assertEqual(sharded["jobs"], 3)
        self.assertEqual(sharded["ran"], whole["ran"])
        self.assertEqual(sharded["red"], whole["red"])
        self.assertEqual(
            sharded["red"], ["test_beta.B.test_red", "unittest.loader._FailedTest.test_broken"]
        )
        self.assertEqual(sharded["discovered"], whole["ran"])
        self.assertIsNone(sharded["partition_error"])
        self.assertEqual(sharded["fingerprint"], whole["fingerprint"])
        self.assertEqual(sorted(sharded["sections"]), sharded["red"])
        self.assertIn("test_deep", " ".join(sharded["module_durations_s"]))
        self.assertIn("pkg.test_deep", sharded["module_durations_s"])
        for run in (whole, sharded):
            verdict = core_unit.judge(run, whole["red"])
            self.assertEqual(verdict["verdict"], "PASS", verdict)

    def test_a_deliberate_red_in_a_sharded_run_is_a_new_red(self):
        inherited = ["unittest.loader._FailedTest.test_broken"]
        run = core_unit.run_family(self.project, jobs=4)
        verdict = core_unit.judge(run, inherited)
        self.assertEqual(verdict["verdict"], "FAIL")
        self.assertEqual(verdict["new_red"], ["test_beta.B.test_red"])

    def test_a_record_of_a_sharded_run_keeps_the_partition_proof(self):
        (self.project / "tools" / "core_unit_baseline.json").write_text(
            json.dumps({
                "schema": core_unit.SCHEMA_VERSION,
                "family": core_unit.FAMILY_NAME,
                "red": ["test_beta.B.test_red", "unittest.loader._FailedTest.test_broken"],
            }),
            encoding="utf-8",
        )
        run = core_unit.run_family(self.project, jobs=2)
        written = core_unit.write_record(self.project, run, run["fingerprint"])
        record = written["record"]
        self.assertEqual(record["verdict"], "PASS", record["problems"])
        self.assertEqual((record["jobs"], record["discovered"]), (2, run["ran"]))
        self.assertEqual(sum(shard["selected"] for shard in record["shards"]), run["ran"])
        # The gate re-judges the stored record; a torn partition stays a refusal.
        torn = {**record, "partition_error": "shards kept 7 of 8 discovered tests"}
        self.assertEqual(core_unit.judge(torn, record["red"])["verdict"], "FAIL")

    def test_measured_durations_balance_the_next_run(self):
        run = core_unit.run_family(self.project, jobs=2)
        core_unit.keep_durations(self.project, run["module_durations_s"])
        cached = core_unit.load_durations(self.project)
        self.assertEqual(set(cached), set(run["module_durations_s"]))
        again = core_unit.run_family(self.project, jobs=2)
        self.assertEqual((again["ran"], again["red"]), (run["ran"], run["red"]))


if __name__ == "__main__":
    unittest.main()
