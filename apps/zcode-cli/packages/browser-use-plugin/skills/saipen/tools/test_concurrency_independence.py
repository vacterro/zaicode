"""T-1258: no gate may be reddened by another gate running beside it.

Two separate failures share one class.

STATE. `tools/perf_wave_regressions.py`'s T-1022 control hashed every file
under the live `.saipen/` and reported only "live .saipen tree changed". Any
concurrent writer -- including `tools/audit_parity.py`'s own
`.saipen/cache/*.json`, which `.gitignore` line 14 keeps out of the tree by
design -- turned a hermeticity control into an unattributable red. It now
snapshots per path, skips that runtime cache, and names exactly what moved.

TIMING. A behavioral assertion measured against an absolute wall-clock budget
is a race with whatever else is running. `test_liveness_cache_lock_contention_
is_non_blocking` asked whether a liveness write blocks on a held lock and
answered it with `timeout=1.5`; on a loaded two-core runner that budget is a
coin flip, and the red it produces says nothing about locking. Latency controls
now price one equivalent subprocess on the host and allow a wide multiple.

These tests keep both properties from silently coming back.
"""

import ast
import re
import subprocess
import sys
import unittest
from pathlib import Path

HOME = Path(__file__).resolve().parent.parent
TOOLS = HOME / "tools"

# Below this, a numeric subprocess timeout in the suite is a latency race
# rather than a hang guard: interpreter startup plus imports alone is a
# meaningful fraction of it on a small CI runner.
TIMEOUT_FLOOR_SECONDS = 10


def suppressed_line_ranges(tree: ast.AST) -> list[tuple[int, int]]:
    """Line spans of `with (contextlib.)suppress(...)` blocks.

    A timeout inside one cannot redden the suite -- expiry is caught and the
    test carries on -- so those are hang guards by construction.
    """
    spans = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.With):
            continue
        for item in node.items:
            call = item.context_expr
            if not isinstance(call, ast.Call):
                continue
            name = call.func.attr if isinstance(call.func, ast.Attribute) else None
            name = name or (call.func.id if isinstance(call.func, ast.Name) else None)
            if name == "suppress":
                spans.append((node.lineno, node.end_lineno or node.lineno))
    return spans


def subprocess_timeout_calls(tree: ast.AST) -> set[ast.Call]:
    """Resolve subprocess calls and syntactically bound Popen receivers."""
    modules = set()
    functions = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name == "subprocess"
            )
        elif isinstance(node, ast.ImportFrom) and node.module == "subprocess":
            functions.update(
                (alias.asname or alias.name, alias.name) for alias in node.names
            )

    def function_name(node):
        if isinstance(node, ast.Name):
            return functions.get(node.id)
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id in modules
        ):
            return node.attr
        return None

    def is_popen(node):
        return isinstance(node, ast.Call) and function_name(node.func) == "Popen"

    receivers = set()
    for node in ast.walk(tree):
        targets = []
        if isinstance(node, ast.Assign) and is_popen(node.value):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign) and is_popen(node.value):
            targets = [node.target]
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            targets = [
                item.optional_vars
                for item in node.items
                if is_popen(item.context_expr) and item.optional_vars is not None
            ]
        receivers.update(ast.unparse(target) for target in targets)

    calls = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if function_name(node.func) in {
            "run",
            "Popen",
            "check_output",
            "check_call",
            "call",
        }:
            calls.add(node)
        elif isinstance(node.func, ast.Attribute) and node.func.attr == "communicate":
            receiver = node.func.value
            if (
                is_popen(receiver)
                or function_name(receiver) == "Popen"
                or ast.unparse(receiver) in receivers
            ):
                calls.add(node)
    return calls


def tight_numeric_timeouts(path: Path) -> list[tuple[int, float]]:
    """Subprocess `timeout=<number>` under the floor, outside suppress blocks."""
    tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
    spans = suppressed_line_ranges(tree)
    subprocess_calls = subprocess_timeout_calls(tree)
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or node not in subprocess_calls:
            continue
        for kw in node.keywords:
            if kw.arg != "timeout" or not isinstance(kw.value, ast.Constant):
                continue
            value = kw.value.value
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                continue
            if value >= TIMEOUT_FLOOR_SECONDS:
                continue
            if any(lo <= kw.value.lineno <= hi for lo, hi in spans):
                continue
            found.append((kw.value.lineno, float(value)))
    return found


class NoAbsoluteLatencyBudgets(unittest.TestCase):
    def test_no_test_module_races_a_concurrent_gate_on_a_constant_timeout(self):
        offenders = {}
        for path in sorted(TOOLS.glob("test_*.py")):
            hits = tight_numeric_timeouts(path)
            if hits:
                offenders[path.name] = hits
        self.assertEqual(
            offenders,
            {},
            "a numeric subprocess timeout under "
            f"{TIMEOUT_FLOOR_SECONDS}s outside a suppress block makes the "
            "verdict depend on host load: derive the budget from a measured "
            "per-subprocess cost (see PerformanceAuditTests._subprocess_cost) "
            "or raise it to a hang guard",
        )

    def test_the_detector_fires_on_a_tight_timeout_and_spares_a_hang_guard(self):
        """The guard is only evidence if it goes red on its own condition."""
        import tempfile

        cases = {
            "tight": "import subprocess\nsubprocess.run(['x'], timeout=1.5)\n",
            "guard": (
                "import subprocess\nfrom contextlib import suppress\n"
                "with suppress(subprocess.TimeoutExpired):\n"
                "    subprocess.run(['x'], timeout=1.5)\n"
            ),
            "generous": "import subprocess\nsubprocess.run(['x'], timeout=900)\n",
            "thread_join": "import threading\nthreading.Thread().join(timeout=5)\n",
            "other_run": "worker.run(timeout=1)\n",
            "other_communicate": "client.communicate(timeout=1)\n",
        }
        with tempfile.TemporaryDirectory() as tmp:
            for label, text in cases.items():
                path = Path(tmp) / f"test_{label}.py"
                path.write_text(text, encoding="utf-8")
                hits = tight_numeric_timeouts(path)
                if label == "tight":
                    self.assertEqual([value for _, value in hits], [1.5], label)
                else:
                    self.assertEqual(hits, [], label)

    def test_subprocess_aliases_and_communicate_still_have_a_timeout_guard(self):
        import tempfile

        cases = {
            "module_alias": "import subprocess as sp\nsp.run(['x'], timeout=1)\n",
            "function_alias": "from subprocess import run as launch\nlaunch(['x'], timeout=1)\n",
            "check_output": "import subprocess\nsubprocess.check_output(['x'], timeout=1)\n",
            "check_call": "import subprocess\nsubprocess.check_call(['x'], timeout=1)\n",
            "call": "import subprocess\nsubprocess.call(['x'], timeout=1)\n",
            "communicate": (
                "import subprocess\nproc = subprocess.Popen(['x'])\n"
                "proc.communicate(timeout=1)\n"
            ),
            "context": (
                "from subprocess import Popen as Process\n"
                "with Process(['x']) as child:\n    child.communicate(timeout=1)\n"
            ),
            "direct": "import subprocess\nsubprocess.Popen(['x']).communicate(timeout=1)\n",
            "attribute": (
                "import subprocess\nself.proc = subprocess.Popen(['x'])\n"
                "self.proc.communicate(timeout=1)\n"
            ),
        }
        with tempfile.TemporaryDirectory() as tmp:
            for label, text in cases.items():
                with self.subTest(label=label):
                    path = Path(tmp) / f"test_{label}.py"
                    path.write_text(text, encoding="utf-8")
                    self.assertEqual(tight_numeric_timeouts(path)[0][1], 1.0)

    def test_the_liveness_latency_control_prices_the_host_first(self):
        source = (TOOLS / "test_audit_2026_08_28_all3.py").read_text(encoding="utf-8-sig")
        self.assertIn("def _subprocess_cost(", source)
        self.assertIn("baseline = self._subprocess_cost(", source)
        self.assertIn("timeout=budget", source)

    def test_the_cost_helper_returns_a_positive_floor(self):
        from tools.test_audit_2026_08_28_all3 import PerformanceAuditTests

        case = PerformanceAuditTests("test_liveness_cache_lock_contention_is_non_blocking")
        cost = case._subprocess_cost({**__import__("os").environ}, "pass")
        self.assertGreater(cost, 0.0)
        self.assertLess(cost, 60.0)


class LiveTreeControlNamesWhatMoved(unittest.TestCase):
    """The T-1022 control must classify, not just compare."""

    def setUp(self):
        self.source = (TOOLS / "perf_wave_regressions.py").read_text(encoding="utf-8-sig")

    def test_control_snapshots_per_path_instead_of_one_opaque_hash(self):
        self.assertIn("def tree_snapshot(", self.source)
        self.assertIn("def snapshot_delta(", self.source)
        self.assertNotIn("def tree_hash(", self.source)

    def test_control_skips_the_process_local_runtime_cache(self):
        self.assertIn('transient = ("cache/",)', self.source)
        gitignore = (HOME / ".gitignore").read_text(encoding="utf-8-sig")
        self.assertIn(".saipen/cache/", gitignore)

    def test_delta_names_added_removed_and_changed_paths(self):
        namespace: dict[str, object] = {}
        # The helper is a pure function lifted verbatim from the gate, so the
        # test exercises the shipped text rather than a copy that can drift.
        exec(
            "def snapshot_delta(before, after):\n"
            + _indented_body(self.source, "def snapshot_delta("),
            namespace,
        )
        delta = namespace["snapshot_delta"]
        message = delta(
            {"BOARD.md": "a", "LOG.md": "b"},
            {"BOARD.md": "a", "LOG.md": "c", "STATE.md": "d"},
        )
        self.assertIn("STATE.md", message)
        self.assertIn("LOG.md", message)
        self.assertIn("added", message)
        self.assertIn("changed", message)


def _indented_body(source: str, header: str) -> str:
    """The body of the `header` function, verbatim, for standalone exec."""
    lines = source.splitlines(keepends=True)
    start = next(i for i, ln in enumerate(lines) if ln.lstrip().startswith(header))
    indent = len(lines[start]) - len(lines[start].lstrip())
    body = []
    for line in lines[start + 1 :]:
        if line.strip() and (len(line) - len(line.lstrip())) <= indent:
            break
        body.append(line[indent:] if line.strip() else line)
    return "".join(body)


class ConcurrentGateWritesAreBounded(unittest.TestCase):
    def test_audit_parity_writes_nothing_in_the_live_tree_but_the_cache(self):
        """The state half of the reproduction, asserted from the source.

        `audit_parity` copies the live HOME into `tempfile.mkdtemp`; the only
        paths it writes back under HOME are the two gitignored cache files. If
        that ever changes, a suite reading the live tree can be reddened by it
        again.
        """
        source = (TOOLS / "audit_parity.py").read_text(encoding="utf-8-sig")
        expressions = re.findall(r'HOME\s*/\s*"\.saipen"((?:\s*/\s*"[^"]+")+)', source)
        self.assertTrue(expressions, "no live-tree path expressions found to check")
        targets = {re.findall(r'"([^"]+)"', tail)[-1] for tail in expressions}
        self.assertEqual(
            targets, {"audit_parity_cache.json", "audit_checks_cache.json"}, targets
        )
        # And they really are the runtime cache the tree excludes by design.
        self.assertTrue(all('"cache"' in tail for tail in expressions), expressions)


class ConcurrentDiscoveryIsGreen(unittest.TestCase):
    """The end-to-end leg, kept opt-in.

    Running the whole suite twice inside itself would be recursive and slow, so
    this leg runs only when `SAIPEN_CONCURRENCY_SOAK=1` asks for it. The
    checkpointed evidence for T-1258 is three cache-cold discovery runs beside
    a live `audit_parity`.
    """

    def test_discovery_is_green_beside_a_running_gate(self):
        import os

        if os.environ.get("SAIPEN_CONCURRENCY_SOAK") != "1":
            self.skipTest("set SAIPEN_CONCURRENCY_SOAK=1 to run the soak leg")
        gate = subprocess.Popen(
            [sys.executable, "tools/audit_parity.py"],
            cwd=HOME,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            result = subprocess.run(
                [sys.executable, "-m", "unittest", "discover", "-s", "tools"],
                cwd=HOME,
                capture_output=True,
                text=True,
                timeout=1800,
            )
        finally:
            gate.terminate()
            gate.communicate(timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])


if __name__ == "__main__":
    unittest.main()
