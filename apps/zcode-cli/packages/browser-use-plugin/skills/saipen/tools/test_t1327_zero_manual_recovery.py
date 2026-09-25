"""T-1327: zero-manual convergence of SAFE protocol debt and runtime skew.

The AUDAPACK incident proved two escapes that unit coverage did not:

1. Fleet preflight named the EXACT safe repair (`saipen ticket compact T-158`)
   and Fleet prepare still delegated to the generic `saipen recover`, so the
   only way to reach the named repair was an operator shell. Worse, the SAFE
   result for that reason code carried no ``condition_id`` while ``prepare``
   read one unconditionally: the CLI raised ``KeyError``, printed a traceback
   on stderr and NOTHING on stdout, which the OpenCode guard can only classify
   as ``FLEET_OUTPUT_INVALID``. One missing key produced both the "recovery is
   unreachable" and the "clean project cannot edit" symptoms.

2. A stale installed OpenCode runtime stayed active until the operator ran
   ``bootstrap/inject.ps1`` by hand and compared hashes by eye.

Every test here is a production-shaped regression, not an API exercise.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import runtime_bootstrap as rb  # noqa: E402
from saipen_engine.board import MAX_LIVE_RECORD_CHARS  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from saipen_engine.fleet import (  # noqa: E402
    CLASS_BLOCKED,
    CLASS_CONFLICT,
    CLASS_SAFE,
    CLASS_VALID,
    plan_repair,
    preflight,
    prepare,
)
from test_guard_hostile_matrix import fresh_project  # noqa: E402
from test_opencode_adapter import run_cases  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


CLI = REPO / "tools" / "saipen.py"
PLUGIN = REPO / "extensions" / "adapters" / "opencode" / "saipen-guard.js"
_GUARD_ENV = {
    "SAIPEN_SKILL_ROOT": str(REPO),
    "SAIPEN_PYTHON": shutil.which("python") or shutil.which("python3") or sys.executable,
}


def _oversized_line(ticket: str, filler: str = "legacy evidence ") -> str:
    line = (
        f"- [/] {ticket} [P1] "
        + (filler * 140)
        + " | verify: "
        + ("proof " * 180)
        + " | owner: test-agent | claim_time: 2026-09-14T08:00:00Z\n"
    )
    assert len(line.rstrip()) > MAX_LIVE_RECORD_CHARS
    return line


def _legacy_project(*tickets: str) -> Path:
    """An AUDAPACK-shaped project: DOING work whose BOARD row is oversized."""
    active = tickets[0]
    root = fresh_project(
        phase="BUILD", task=active, next_action=f"PHASE BUILD {active}", agent="test-agent"
    )
    board = "## DOING\n" + _oversized_line(active) + "## TODO\n"
    for extra in tickets[1:]:
        board += _oversized_line(extra).replace("- [/]", "- [ ]")
    board += "## DONE\n## BLOCKED\n"
    (root / ".saipen" / "BOARD.md").write_text(board, encoding="utf-8")
    return root


#: A project carrying TWO independent SAFE generations at once: an oversized
#: legacy BOARD row (repaired by `saipen ticket compact`) AND an out-of-enum
#: `phase` whose replacement the LOG can prove (repaired by `saipen recover`).
#: Preflight diagnoses the board first, so convergence genuinely needs two
#: separate repairs -- which is the only honest way to test that one prepare
#: call repairs exactly one of them.
_TWO_GENERATION_LOG = (
    "# Log\n"
    "- 13.09.26 00:00 [E-0001] [agent: test-agent] "
    "[op: transition-" + "a" * 32 + "] RUN: transition to SCOUT\n"
    "- 13.09.26 00:01 [E-0002] [parent: E-0001] [T-158] [agent: test-agent] "
    "[op: transition-" + "b" * 32 + "] RUN: transition to BUILD\n"
)
_TWO_GENERATION_STATE = (
    "---\n"
    "phase: IMPL\n"
    "task: T-158\n"
    'next_action: "PHASE BUILD T-158"\n'
    "blocker: none\n"
    "transition_from: DONE\n"
    "saipen_version: 7\n"
    "schema_version: 3\n"
    "last_event: 2\n"
    "style_contract: ded-4ae736e4\n"
    "agent: test-agent\n"
    "mode: full\n"
    "updated: 2026-09-13T00:00:00Z\n"
    "execution_intent: normal\n"
    "---\n"
)


def _two_generation_project() -> Path:
    root = _legacy_project("T-158")
    (root / ".saipen" / "LOG.md").write_text(_TWO_GENERATION_LOG, encoding="utf-8")
    (root / ".saipen" / "STATE.md").write_text(_TWO_GENERATION_STATE, encoding="utf-8")
    return root


def _kwargs(root: Path) -> dict:
    return {"explicit_root": root, "honor_environment": False}


def _board(root: Path) -> str:
    return (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")


class TargetAExactSafeRepairTests(unittest.TestCase):
    """Fleet prepare executes the repair preflight named -- structurally."""

    def test_preflight_names_the_real_ticket_compaction(self) -> None:
        root = _legacy_project("T-158")
        report = preflight(root, **_kwargs(root))
        self.assertEqual(report["classification"], CLASS_SAFE)
        self.assertEqual(report["reason_code"], "BOARD_RECORD_OVERSIZE")
        self.assertEqual(report["canonical_next_command"], "saipen ticket compact T-158")
        self.assertTrue(report["safe_auto_repair_available"])

    def test_every_safe_classification_carries_its_generation(self) -> None:
        # The exact KeyError source: a SAFE result without `condition_id`.
        root = _legacy_project("T-158")
        report = preflight(root, **_kwargs(root))
        self.assertIsInstance(report.get("condition_id"), str)
        self.assertEqual(len(report["condition_id"]), 64)

    def test_prepare_runs_that_exact_compaction_without_an_operator(self) -> None:
        root = _legacy_project("T-158")
        before = _board(root)
        result = prepare(root, **_kwargs(root))
        self.assertEqual(result["code"], "RECOVERED_REISSUE_REQUIRED", result)
        self.assertEqual(result["classification"], CLASS_VALID)
        self.assertTrue(result["recovered"])
        self.assertTrue(result["requires_reissue"])
        self.assertEqual(result["recovery_result"]["operation"], "ticket-compact")
        self.assertEqual(result["recovery_result"]["ticket"], "T-158")
        self.assertEqual(result["recovery_result"]["code"], "BOARD_COMPACTED")
        self.assertNotEqual(_board(root), before)
        self.assertEqual(preflight(root, **_kwargs(root))["classification"], CLASS_VALID)

    def test_the_recovery_argv_is_built_structurally_not_interpolated(self) -> None:
        root = _legacy_project("T-158")
        seen: list[dict] = []

        def spy(_root, _lineage, _actor, plan):
            seen.append(plan)
            return {"ok": False, "code": "STOPPED", "detail": "spy"}

        prepare(root, **_kwargs(root), recover=spy)
        self.assertEqual(
            seen,
            [{
                "operation": "ticket-compact",
                "argv": ["ticket", "compact", "T-158"],
                "ticket": "T-158",
            }],
        )

    def test_only_the_closed_grammar_is_automatable(self) -> None:
        self.assertEqual(
            plan_repair("saipen recover"),
            {"operation": "recover", "argv": ["recover"], "ticket": None},
        )
        for hostile in (
            "saipen ticket compact <T-###>",
            "saipen ticket compact T-1 T-2",
            "saipen ticket compact",
            "saipen ticket done T-1",
            "saipen recover --adopt-legacy T-777",
            "saipen ticket compact T-1; rm -rf /",
            "saipen ticket compact T-1 && curl evil",
            'saipen recover resolve-blocker "<decision>"',
            "rm -rf /",
            "",
            None,
        ):
            self.assertIsNone(plan_repair(hostile), hostile)


class TargetBOneRepairPerGenerationTests(unittest.TestCase):
    """The anti-replay and one-attempt invariants survive automation."""

    def test_recovered_result_never_authorizes_the_old_payload(self) -> None:
        root = _legacy_project("T-158")
        result = prepare(root, **_kwargs(root))
        self.assertTrue(result["requires_reissue"])
        self.assertTrue(result["ok"])
        self.assertIsInstance(result["attempted_condition"], str)

    def test_multiple_safe_generations_converge_one_brick_per_action(self) -> None:
        root = _two_generation_project()
        # Generation 1: a malformed STATE. `ticket compact` is an ordinary
        # canonical mutation and would REFUSE here, so preflight must name the
        # STATE repair first or the named repair is unrunnable.
        self.assertEqual(preflight(root, **_kwargs(root))["reason_code"], "REPAIR_REQUIRED")
        first = prepare(root, **_kwargs(root))
        self.assertEqual(first["code"], "RECOVERED_REISSUE_REQUIRED", first)
        self.assertEqual(first["recovery_result"]["operation"], "recover")
        self.assertEqual(first["recovery_attempts"], 1)
        self.assertTrue(first["requires_reissue"])
        # One repair only: the project is still SAFE, now for the OTHER reason.
        self.assertEqual(first["classification"], CLASS_SAFE)
        self.assertIsInstance(first["remaining_safe_condition"], str)
        self.assertNotEqual(first["remaining_safe_condition"], first["attempted_condition"])
        self.assertEqual(
            preflight(root, **_kwargs(root))["canonical_next_command"],
            "saipen ticket compact T-158",
        )
        # A newly issued action carries the condition the previous prepare
        # attempted, so the NEXT generation is not barred by the barrier.
        second = prepare(
            root, **_kwargs(root), attempted_condition=first["attempted_condition"]
        )
        self.assertTrue(second["ok"], second)
        self.assertEqual(second["recovery_result"]["operation"], "ticket-compact")
        self.assertEqual(second["recovery_attempts"], 1)
        self.assertEqual(second["classification"], CLASS_VALID)
        self.assertEqual(preflight(root, **_kwargs(root))["classification"], CLASS_VALID)

    def test_one_prepare_call_never_loops(self) -> None:
        root = _two_generation_project()
        calls: list[dict] = []

        def counting(root_, lineage, actor, plan):
            from saipen_engine.fleet import _invoke_canonical_repair

            calls.append(plan)
            return _invoke_canonical_repair(root_, lineage, actor, plan)

        result = prepare(root, **_kwargs(root), recover=counting)
        # Two SAFE generations remain repairable, and exactly ONE repair ran.
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["classification"], CLASS_SAFE)
        self.assertTrue(result["requires_reissue"])

    def test_unchanged_generation_gets_exactly_one_attempt(self) -> None:
        root = _legacy_project("T-158")
        result = prepare(
            root, **_kwargs(root), recover=lambda *_a: {"ok": True, "code": "NOOP"}
        )
        # T-1354: the repair ran, changed nothing, and the state still asks
        # for the same command -- the automatic route is exhausted, and an
        # exhausted route earns no reissue. Promising one here is what sent a
        # caller back into the same wall forever against bytes that never
        # moved, so the old `RECOVERY_FAILED` + `requires_reissue` pair is the
        # defect, not the contract.
        self.assertEqual(result["code"], "RECOVERY_EXHAUSTED")
        self.assertFalse(result["requires_reissue"])
        again = prepare(
            root,
            **_kwargs(root),
            attempted_condition=result["attempted_condition"],
            recover=lambda *_a: self.fail("second attempt on an unchanged generation"),
        )
        self.assertEqual(again["recovery_attempts"], 0)

    def test_already_applied_compaction_is_deterministic(self) -> None:
        root = _legacy_project("T-158")
        prepare(root, **_kwargs(root))
        board = _board(root)
        # Re-running the same canonical repair by hand is idempotent and does
        # not corrupt the compacted projection.
        proc = subprocess.run(
            [sys.executable, str(CLI), "ticket", "compact", "T-158",
             "--project-root", str(root), "--json"],
            capture_output=True, text=True, cwd=str(root), timeout=120, check=False,
        )
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["code"], "ALREADY_APPLIED", proc.stdout + proc.stderr)
        self.assertEqual(_board(root), board)
        self.assertEqual(preflight(root, **_kwargs(root))["classification"], CLASS_VALID)

    def test_a_named_repair_that_cannot_run_is_never_the_named_repair(self) -> None:
        # The escape this ordering rule closes: a malformed STATE makes the
        # BOARD compaction refuse (VALIDATION_FAILED: state-malformed), so
        # naming it would hand the operator a repair that cannot execute.
        root = _two_generation_project()
        report = preflight(root, **_kwargs(root))
        self.assertEqual(report["canonical_next_command"], "saipen recover")
        proc = subprocess.run(
            [sys.executable, str(CLI), "ticket", "compact", "T-158",
             "--project-root", str(root), "--json"],
            capture_output=True, text=True, cwd=str(root), timeout=120, check=False,
        )
        refusal = json.loads(proc.stdout)
        self.assertFalse(refusal["ok"], refusal)
        self.assertIn("state-malformed", str(refusal.get("detail", "")))

    def test_lineage_change_before_dispatch_refuses_without_repairing(self) -> None:
        # Same shape as the generation drift above, but the identity itself
        # moves: the repair must not run against a project that is no longer
        # the one preflight classified.
        root = _legacy_project("T-158")
        identity = root / ".saipen" / "IDENTITY.md"
        calls: list[int] = []
        import saipen_engine.fleet as fleet_module

        real_preflight = fleet_module.preflight
        seen = {"n": 0}

        def relineage_preflight(*args, **kwargs):
            result = real_preflight(*args, **kwargs)
            seen["n"] += 1
            if seen["n"] == 1:
                identity.write_text(
                    identity_file_content(new_project_lineage()), encoding="utf-8"
                )
            return result

        fleet_module.preflight = relineage_preflight
        try:
            result = fleet_module.prepare(
                root, **_kwargs(root), recover=lambda *_a: calls.append(1) or {"ok": True}
            )
        finally:
            fleet_module.preflight = real_preflight
        self.assertEqual(calls, [])
        self.assertEqual(result["code"], "RECOVERY_FAILED")
        self.assertTrue(result["requires_reissue"])
        self.assertEqual(result["recovery_attempts"], 0)

    def test_generation_change_before_dispatch_refuses_without_repairing(self) -> None:
        root = _legacy_project("T-158")
        state = root / ".saipen" / "STATE.md"

        calls: list[int] = []
        original_preflight_count = {"n": 0}
        import saipen_engine.fleet as fleet_module

        real_preflight = fleet_module.preflight

        def mutating_preflight(*args, **kwargs):
            result = real_preflight(*args, **kwargs)
            original_preflight_count["n"] += 1
            if original_preflight_count["n"] == 1:
                # Between diagnosis and the immediate re-check the canonical
                # generation moves. The planned repair is now stale evidence.
                state.write_text(
                    state.read_text(encoding="utf-8") + "\n<!-- drift -->\n", encoding="utf-8"
                )
            return result

        fleet_module.preflight = mutating_preflight
        try:
            result = fleet_module.prepare(
                root, **_kwargs(root), recover=lambda *_a: calls.append(1) or {"ok": True}
            )
        finally:
            fleet_module.preflight = real_preflight
        self.assertEqual(calls, [])
        self.assertEqual(result["code"], "RECOVERY_FAILED")
        self.assertEqual(result["recovery_attempts"], 0)


class TargetBFailClosedTests(unittest.TestCase):
    def test_binding_conflict_stays_fail_closed(self) -> None:
        root = _legacy_project("T-158")
        other = fresh_project(agent="test-agent")
        result = prepare(root, explicit_root=root, host_root=other, honor_environment=False)
        self.assertEqual(result["classification"], CLASS_CONFLICT)
        self.assertFalse(result["ok"])
        self.assertFalse(result["recovered"])
        self.assertEqual(result["recovery_attempts"], 0)

    def test_operator_decision_state_never_auto_executes(self) -> None:
        root = fresh_project(
            phase="BUILD", task="T-9001", next_action="PHASE BUILD T-9001", agent="test-agent"
        )
        state = root / ".saipen" / "STATE.md"
        state.write_text(
            state.read_text(encoding="utf-8").replace(
                'blocker: ""', 'blocker: "WAIT_USER_DECISION -- operator decision required"'
            ),
            encoding="utf-8",
        )
        # The token has to be a RECOGNISED gate class, or this control proves
        # nothing about operator decisions. It read "AUTH", which `blocker_class`
        # does not know, so the blocker was an ordinary stale one -- and the
        # BLOCKED verdict the assertion below checks came from an unrelated
        # floor failure in the same fixture, not from the gate. Pinning the
        # recogniser here is what makes the rest of the test mean what it says.
        from saipen_engine.board import blocker_class

        self.assertEqual(
            blocker_class("WAIT_USER_DECISION -- operator decision required"),
            "WAIT_USER_DECISION",
        )
        report = preflight(root, **_kwargs(root))
        self.assertEqual(report["classification"], CLASS_BLOCKED)
        self.assertTrue(report["read_only"])
        self.assertTrue(report["operator_decision_available"])
        self.assertEqual(report["diagnosis"], "READ_ONLY_DIAGNOSIS_ONLY")
        result = prepare(root, **_kwargs(root))
        self.assertEqual(result["code"], CLASS_BLOCKED)
        self.assertFalse(result["ok"])
        self.assertFalse(result["recovered"])
        self.assertFalse(result["requires_reissue"])
        self.assertEqual(result["recovery_attempts"], 0)

    def test_unallowlisted_canonical_command_is_never_executed(self) -> None:
        root = _legacy_project("T-158")
        import saipen_engine.fleet as fleet_module

        real_preflight = fleet_module.preflight

        def hostile_preflight(*args, **kwargs):
            result = real_preflight(*args, **kwargs)
            if result.get("classification") == CLASS_SAFE:
                result = {
                    **result,
                    "canonical_next_command": "saipen ticket compact T-158 && rm -rf /",
                }
            return result

        fleet_module.preflight = hostile_preflight
        try:
            result = fleet_module.prepare(
                root, **_kwargs(root), recover=lambda *_a: self.fail("executed a hostile command")
            )
        finally:
            fleet_module.preflight = real_preflight
        self.assertEqual(result["code"], "RECOVERY_NOT_AUTOMATABLE")
        self.assertFalse(result["ok"])
        self.assertFalse(result["requires_reissue"])
        self.assertEqual(result["automatable_operations"], ["recover", "ticket-compact"])


class TargetDFleetOutputSchemaTests(unittest.TestCase):
    """Every Fleet CLI exit is readable by the guard's contract."""

    GUARD_REQUIRED = ("classification", "code", "requires_reissue")

    def _run(self, *args: str, cwd: Path | None = None) -> tuple[int, dict]:
        proc = subprocess.run(
            [sys.executable, str(CLI), "fleet", *args, "--json"],
            capture_output=True, text=True, cwd=str(cwd or REPO), timeout=180, check=False,
        )
        self.assertTrue(proc.stdout.strip(), f"empty stdout; stderr={proc.stderr[-800:]}")
        payload = json.loads(proc.stdout)
        for key in self.GUARD_REQUIRED:
            self.assertIn(key, payload, payload)
        self.assertIsInstance(payload["classification"], str)
        self.assertIsInstance(payload["code"], str)
        self.assertIsInstance(payload["requires_reissue"], bool)
        return proc.returncode, payload

    def test_clean_bound_project_prepares_without_fleet_output_invalid(self) -> None:
        root = fresh_project(
            phase="BUILD", task="T-9001", next_action="PHASE BUILD T-9001", agent="test-agent"
        )
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-9001 live work | verify: x | owner: test-agent | "
            "claim_time: 2026-09-14T08:00:00Z\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        before = (root / ".saipen" / "BOARD.md").read_bytes()
        rc, payload = self._run("prepare", "--cwd", str(root), cwd=root)
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["classification"], "BOUND_VALID")
        self.assertFalse(payload["requires_reissue"])
        self.assertTrue(payload["ok"])
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), before)

    def test_oversized_board_prepares_to_a_readable_reissue(self) -> None:
        root = _legacy_project("T-158")
        rc, payload = self._run("prepare", "--cwd", str(root), cwd=root)
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["code"], "RECOVERED_REISSUE_REQUIRED")
        self.assertTrue(payload["requires_reissue"])

    def test_grammar_refusals_keep_the_guard_schema(self) -> None:
        for args in (("bogus",), ("prepare", "--root", str(REPO)), ("preflight", "--cwd")):
            with self.subTest(args=args):
                rc, payload = self._run(*args)
                self.assertEqual(rc, 2)
                self.assertFalse(payload["requires_reissue"])

    def test_non_saipen_directory_is_readable_and_non_interfering(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rc, payload = self._run("prepare", "--cwd", tmp, cwd=Path(tmp))
            self.assertEqual(rc, 0)
            self.assertEqual(payload["classification"], "NON_SAIPEN")
            self.assertFalse(Path(tmp, ".saipen").exists())

    def test_an_unexpected_engine_fault_is_a_bounded_record_not_empty_stdout(self) -> None:
        # The production failure mode: an exception inside the engine printed a
        # traceback on stderr and nothing on stdout. Prove the boundary holds
        # for ANY fault, not just the one `condition_id` bug.
        env = dict(os.environ)
        env["SAIPEN_T1327_FORCE_FLEET_FAULT"] = "1"
        script = (
            "import sys, runpy\n"
            f"sys.path.insert(0, {str(TOOLS)!r})\n"
            "import saipen_engine.fleet as f\n"
            "def boom(*a, **k):\n"
            "    raise RuntimeError('injected engine fault')\n"
            "f.preflight = boom\n"
            "f.prepare = boom\n"
            f"sys.argv = ['saipen', 'fleet', 'prepare', '--cwd', {str(REPO)!r}, '--json']\n"
            f"runpy.run_path({str(CLI)!r}, run_name='__main__')\n"
        )
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True, text=True, cwd=str(REPO), timeout=180, check=False, env=env,
        )
        self.assertTrue(proc.stdout.strip(), proc.stderr[-800:])
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["code"], "FLEET_INTERNAL_ERROR")
        for key in self.GUARD_REQUIRED:
            self.assertIn(key, payload)
        self.assertFalse(payload["requires_reissue"])


class TargetCRuntimeFreshnessTests(unittest.TestCase):
    """Installed-runtime skew is detected and repaired without an operator."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.home = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def _install_surface(self, *, complete: bool = True) -> Path:
        """A minimal installed skill home mirroring the flattened layout."""
        skill = self.home / "skills" / "saipen"
        (skill / "tools" / "saipen_engine").mkdir(parents=True)
        (skill / "bin").mkdir(parents=True)
        for rel, _src in rb._surface_paths(REPO):
            dst = skill / rb._installed_relpath(rel)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes((REPO / rel).read_bytes())
        if complete:
            cli = skill / "tools" / "saipen.py"
            (skill / "bin" / "saipen").write_text(
                f'#!/bin/sh\nexec "python" "{cli.resolve()}" "$@"\n', encoding="utf-8"
            )
            (skill / "bin" / "saipen.cmd").write_text(
                f'@echo off\r\n"python" "{cli.resolve()}" %*\r\n', encoding="utf-8"
            )
        return skill

    def test_installed_fingerprint_mismatch_is_deterministic(self) -> None:
        skill = self._install_surface()
        # T-1342: the installed side is proven over its OWN declared inventory.
        self.assertEqual(rb.surface_fingerprint(skill), rb.surface_fingerprint(REPO))
        target = skill / "tools" / "saipen_engine" / "fleet.py"
        target.write_bytes(target.read_bytes() + b"\n# stale\n")
        self.assertNotEqual(rb.surface_fingerprint(skill), rb.surface_fingerprint(REPO))
        self.assertIn("tools/saipen_engine/fleet.py", rb.surface_diff(REPO, skill))

    def test_launcher_surface_is_verified_not_assumed(self) -> None:
        skill = self._install_surface()
        self.assertEqual(rb.launcher_problems(skill), [])
        (skill / "bin" / "saipen.cmd").write_text(
            '@echo off\r\n"python" "V:\\clone\\tools\\saipen.py" %*\r\n', encoding="utf-8"
        )
        self.assertEqual(rb.launcher_problems(skill), ["wrong-target:bin/saipen.cmd"])
        (skill / "bin" / "saipen").unlink()
        self.assertIn("missing:bin/saipen", rb.launcher_problems(skill))

    def test_guard_plugin_fingerprint_is_part_of_freshness(self) -> None:
        registry = rb._registry(REPO)
        adapter = dict(rb.adapter_entry(registry, "opencode"))
        hook = self.home / "plugins" / "saipen-guard.js"
        hook.parent.mkdir(parents=True, exist_ok=True)
        adapter["install"] = {**adapter["install"], "hook": str(hook)}
        adapter["legacy_hook_surfaces"] = []
        self.assertEqual(rb.hook_problems(adapter, REPO), ["hook-not-installed"])
        shipped = REPO / str(adapter["hook_artifact"])
        hook.write_bytes(shipped.read_bytes() + b"\n// stale\n")
        self.assertEqual(rb.hook_problems(adapter, REPO), ["hook-stale"])
        hook.write_bytes(shipped.read_bytes())
        self.assertEqual(rb.hook_problems(adapter, REPO), [])

    def test_authority_comes_from_provenance_or_an_architecture_proof(self) -> None:
        # The canonical clone proves itself; PATH and cwd are never authority.
        source, host = rb.resolve_authority("opencode", skill_root=REPO)
        self.assertEqual(source.resolve(), REPO.resolve())
        self.assertEqual(host, "opencode")
        skill = self._install_surface()
        with self.assertRaises(rb.CanonicalSourceUnproven):
            rb.resolve_authority("opencode", skill_root=skill)
        (skill / rb.PROVENANCE_FILENAME).write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "adapter_id": "opencode",
                    "canonical_source_root": str(REPO),
                    "runtime_fingerprint": rb.surface_fingerprint(REPO),
                    "installer_generation": rb.GENERATION,
                }
            ),
            encoding="utf-8",
        )
        source, host = rb.resolve_authority(None, skill_root=skill)
        self.assertEqual(source.resolve(), REPO.resolve())
        self.assertEqual(host, "opencode")

    def test_prelaunch_on_a_current_runtime_performs_no_install_churn(self) -> None:
        skill = self._install_surface()
        marker = skill / rb.PROVENANCE_FILENAME
        marker.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "adapter_id": "t1327",
                    "canonical_source_root": str(REPO),
                    "runtime_fingerprint": rb.surface_fingerprint(REPO),
                    "installer_generation": rb.GENERATION,
                }
            ),
            encoding="utf-8",
        )
        registry = {
            "adapters": [
                {"id": "t1327", "install": {"skill": str(skill)}, "hook_artifact": None}
            ]
        }
        installer_calls: list[tuple] = []
        original_registry, original_installer = rb._registry, rb._invoke_installer
        rb._registry = lambda _source: registry
        rb._invoke_installer = lambda *a: installer_calls.append(a)
        try:
            report = rb.prelaunch("t1327", skill_root=skill)
        finally:
            rb._registry, rb._invoke_installer = original_registry, original_installer
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["code"], rb.PRELAUNCH_CURRENT)
        self.assertFalse(report["stale_before"])
        self.assertTrue(report["fingerprint_match"])
        self.assertEqual(installer_calls, [])

    def test_prelaunch_reports_stale_without_resync_when_asked(self) -> None:
        skill = self._install_surface()
        target = skill / "tools" / "saipen_engine" / "fleet.py"
        target.write_bytes(b"# stale\n")
        registry = {
            "adapters": [
                {"id": "t1327", "install": {"skill": str(skill)}, "hook_artifact": None}
            ]
        }
        original_registry = rb._registry
        rb._registry = lambda _source: registry
        try:
            report = rb.prelaunch("t1327", skill_root=REPO, resync=False)
        finally:
            rb._registry = original_registry
        self.assertFalse(report["ok"])
        self.assertEqual(report["code"], rb.PRELAUNCH_STALE)
        self.assertTrue(report["stale_before"])
        self.assertFalse(report["fingerprint_match"])
        self.assertIn("tools/saipen_engine/fleet.py", report["engine_diff"])

    def test_a_failed_resync_leaves_the_known_good_runtime_intact(self) -> None:
        skill = self._install_surface()
        target = skill / "tools" / "saipen_engine" / "fleet.py"
        good = target.read_bytes()
        target.write_bytes(b"# stale\n")
        stale_state = {
            path: (skill / path).read_bytes()
            for path in ("tools/saipen.py", "bin/saipen", "bin/saipen.cmd")
        }
        registry = {
            "adapters": [
                {"id": "t1327", "install": {"skill": str(skill)}, "hook_artifact": None}
            ]
        }
        original_registry, original_installer = rb._registry, rb._invoke_installer
        rb._registry = lambda _source: registry
        rb._invoke_installer = lambda *_a: subprocess.CompletedProcess([], 1, "install failed", "")
        try:
            report = rb.prelaunch("t1327", skill_root=REPO)
        finally:
            rb._registry, rb._invoke_installer = original_registry, original_installer
        self.assertFalse(report["ok"])
        self.assertEqual(report["code"], rb.PRELAUNCH_FAILED)
        self.assertEqual(report["installer_rc"], 1)
        for path, payload in stale_state.items():
            self.assertEqual((skill / path).read_bytes(), payload)
        self.assertNotEqual(target.read_bytes(), good)

    def test_prelaunch_refuses_an_unnamed_host_instead_of_guessing(self) -> None:
        report = rb.prelaunch(None, skill_root=REPO)
        self.assertFalse(report["ok"])
        self.assertEqual(report["code"], rb.PRELAUNCH_HOST_UNIDENTIFIED)

    def test_supported_launch_refuses_to_start_a_host_on_unproven_bytes(self) -> None:
        import importlib
        import unittest.mock

        from saipen_engine import host_launch

        # Patch the EXACT module `prelaunch_runtime` imports. Since T-1343 that
        # is `rb` -- the engine has one module identity per file, so a patch
        # through any spelling is the patch host_launch's relative import sees.
        # Reaching it through host_launch's own package keeps the assertion
        # about the LAUNCH PATH rather than about an import spelling, which is
        # what this test is for; the identity itself is pinned by
        # tools/test_engine_module_identity.py.
        #
        # Before that repair the two were different objects for the same file:
        # patching `rb` missed, the REAL prelaunch resynced the operator's
        # installed runtime, the REAL host started with no timeout, and the
        # suite hung until the process tree was killed by hand. The interlock in
        # tools/test_host_launch_net.py now refuses that spawn outright.
        bootstrap = importlib.import_module(".runtime_bootstrap", host_launch.__package__)
        refused = {
            "ok": False,
            "code": bootstrap.PRELAUNCH_FAILED,
            "detail": "injected",
            "engine_diff": ["tools/saipen.py"],
            "hook_problems": [],
            "launcher_problems": [],
            "provenance_problems": [],
        }

        def never(what: str):
            def _fail(*_a, **_k):
                raise AssertionError(f"a disposable launch test reached the real {what}")

            return _fail

        project = fresh_project(agent="test-agent")
        with unittest.mock.patch.object(bootstrap, "prelaunch", return_value=refused), \
                unittest.mock.patch.object(
                    bootstrap, "_invoke_installer", side_effect=never("installer")
                ), \
                unittest.mock.patch.object(
                    host_launch.subprocess, "run", side_effect=never("host process")
                ), \
                self.assertRaises(host_launch.HostLaunchRefusal) as caught:
            host_launch.launch_host("opencode", project, "tester")
        self.assertIn("not the canonical generation", str(caught.exception))

    def test_the_prelaunch_cli_is_reachable_outside_any_project(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run(
                [sys.executable, str(CLI), "runtime", "--prelaunch",
                 "--adapter", "opencode", "--no-resync", "--json"],
                capture_output=True, text=True, cwd=tmp, timeout=300, check=False,
            )
            self.assertTrue(proc.stdout.strip(), proc.stderr[-800:])
            payload = json.loads(proc.stdout)
            self.assertNotEqual(payload.get("code"), "NOT_SAIPEN_PROJECT")
            self.assertIn(
                payload["code"],
                (rb.PRELAUNCH_CURRENT, rb.PRELAUNCH_STALE, rb.PRELAUNCH_HOST_UNIDENTIFIED),
                payload,
            )
            self.assertIn("canonical_fingerprint", payload)


@unittest.skipUnless(shutil.which("node"), "node runtime unavailable")
@unittest.skipUnless(
    shutil.which("python") or shutil.which("python3"), "no python for the guard round trip"
)
class NativeGuardEndToEndTests(unittest.TestCase):
    """The AUDAPACK flow through the REAL shipped plugin in a real node process.

    Unit coverage of `fleet.prepare` cannot see the boundary that actually
    failed in production: guard -> `saipen fleet prepare --json` -> stdout
    parser -> guard verdict. These cases drive the shipped artifact the OpenCode
    runtime loads, with the real spawned guard, and assert the USER-VISIBLE
    outcome: no operator shell, no FLEET_OUTPUT_INVALID, guard still blocking.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory(
            prefix="saipen-t1327-native-", ignore_cleanup_errors=True
        )
        cls.workdir = Path(cls.tmp.name)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def _drive(self, cases: list[dict], label: str) -> list[dict]:
        return run_cases(PLUGIN, cases, self.workdir / label, extra_env=_GUARD_ENV)

    def _case(self, cid: str, root: Path, product: Path, content: str) -> dict:
        return {
            "id": cid,
            "project": str(root),
            "env": dict(_GUARD_ENV, SAIPEN_AGENT="test-agent"),
            "input": {"tool": "write", "sessionID": "ses_t1327"},
            "output": {"args": {"filePath": str(product), "content": content}},
            "simulate_effect": {"path": str(product), "contents": content},
        }

    def test_clean_bound_project_edits_without_fleet_output_invalid(self) -> None:
        root = fresh_project(
            phase="BUILD", task="T-9001", next_action="PHASE BUILD T-9001", agent="test-agent"
        )
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-9001 live work | verify: x | owner: test-agent | "
            "claim_time: 2026-09-14T08:00:00Z\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        product = root / "src" / "app.py"
        records = self._drive([self._case("clean", root, product, "EDITED")], "clean")
        self.assertEqual(records[0]["outcome"], "allowed", records)
        self.assertNotIn("FLEET_OUTPUT_INVALID", records[0]["message"])
        self.assertEqual(product.read_text(encoding="utf-8"), "EDITED")

    def test_oversized_board_repairs_itself_and_refuses_the_stale_payload(self) -> None:
        root = _legacy_project("T-158")
        product = root / "src" / "app.py"
        original = product.read_text(encoding="utf-8")
        records = self._drive(
            [
                self._case("stale", root, product, "STALE PAYLOAD"),
                self._case("fresh", root, product, "FRESH PAYLOAD"),
            ],
            "audapack",
        )
        stale, fresh = records
        # 1. the original consequential payload is refused, NOT replayed
        self.assertEqual(stale["outcome"], "blocked", records)
        self.assertIn("RECOVERED_REISSUE_REQUIRED", stale["message"])
        self.assertNotIn("FLEET_OUTPUT_INVALID", stale["message"])
        self.assertNotIn("GUARD_UNREACHABLE", stale["message"])
        self.assertNotIn("ACTOR_UNBOUND", stale["message"])
        # 2. the exact canonical compaction ran with no operator shell
        board = _board(root)
        self.assertIn("detail_ref:", board)
        self.assertTrue(
            all(len(line.rstrip()) <= MAX_LIVE_RECORD_CHARS
                for line in board.splitlines() if line.startswith("- [")),
            board,
        )
        self.assertEqual(preflight(root, **_kwargs(root))["classification"], CLASS_VALID)
        # 3. a NEWLY issued action against current bytes proceeds
        self.assertEqual(fresh["outcome"], "allowed", records)
        self.assertEqual(product.read_text(encoding="utf-8"), "FRESH PAYLOAD")
        self.assertNotEqual(product.read_text(encoding="utf-8"), original)
        # 4. the guard is still installed and still blocking
        protectd = self._drive(
            [{
                "id": "protected",
                "project": str(root),
                "env": dict(_GUARD_ENV, SAIPEN_AGENT="test-agent"),
                "input": {"tool": "write", "sessionID": "ses_t1327"},
                "output": {"args": {
                    "filePath": str(root / ".saipen" / "STATE.md"), "content": "tampered"
                }},
            }],
            "protected",
        )
        self.assertEqual(protectd[0]["outcome"], "blocked", protectd)
        self.assertIn("SAIPEN", protectd[0]["message"])

    def test_two_generation_debt_converges_across_fresh_actions_only(self) -> None:
        root = _two_generation_project()
        product = root / "src" / "app.py"
        records = self._drive(
            [
                self._case("a", root, product, "P1"),
                self._case("b", root, product, "P2"),
                self._case("c", root, product, "P3"),
            ],
            "two-gen",
        )
        outcomes = [item["outcome"] for item in records]
        self.assertEqual(outcomes[:2], ["blocked", "blocked"], records)
        for item in records:
            self.assertNotIn("FLEET_OUTPUT_INVALID", item["message"])
        self.assertEqual(records[2]["outcome"], "allowed", records)
        self.assertEqual(preflight(root, **_kwargs(root))["classification"], CLASS_VALID)
        self.assertEqual(product.read_text(encoding="utf-8"), "P3")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
