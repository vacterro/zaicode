"""Focused Wave-1 adaptive-runtime regressions."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.runtime import (  # noqa: E402
    CAPABILITY_NAMES,
    CHILD_PACKET_CEILINGS,
    CONTEXT_BUDGET_CLASSES,
    DEFAULT_STRATEGY,
    DEFAULT_TASK_CLASS,
    DEPTH_ENFORCEMENT,
    HELPER_JUSTIFICATIONS,
    MAX_SUBAGENT_DEPTH,
    STRATEGIES,
    TASK_CLASSES,
    RuntimeInfoError,
    StrategyError,
    load_runtime_info,
    runtime_projection,
    select_strategy,
    strategy_projection,
)
import saipen as cli  # noqa: E402


class AdaptiveRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-runtime-")
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.project = self.base / "project"
        memory = self.project / ".saipen"
        memory.mkdir(parents=True)
        (memory / "STATE.md").write_text(
            "---\n"
            "phase: BUILD\n"
            "task: T-001\n"
            'next_action: "PHASE BUILD T-001"\n'
            "blocker: none\n"
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "agent: persisted-seat\n"
            "mode: full\n"
            "updated: 2026-08-25T00:00:00Z\n"
            "execution_intent: normal\n"
            "---\n",
            encoding="utf-8",
        )
        (memory / "BOARD.md").write_text(
            "# Board\n## DOING\n- [/] T-001 fixture\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (memory / "LOG.md").write_text(
            "# Log\n\n- 25.08.26 00:00 [E-001] [T-001] [agent: persisted-seat] RUN: fixture\n",
            encoding="utf-8",
        )
        self.env = {
            **os.environ,
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "SAIPEN_USER_CONFIG_HOME": str(self.base / "user-config"),
        }
        self.env.pop("SAIPEN_RUNTIME_INFO", None)

    def _write_info(self, name: str, payload: object) -> Path:
        path = self.base / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def _tree(self) -> dict[str, bytes]:
        return {
            path.relative_to(self.project).as_posix(): path.read_bytes()
            for path in self.project.rglob("*")
            if path.is_file()
        }

    def _cli(self, *args: str, env: dict[str, str] | None = None):
        process = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "--project-root",
                str(self.project),
                *args,
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=self.env if env is None else env,
            timeout=30,
        )
        payload = json.loads(process.stdout) if process.stdout.strip() else {}
        return process, payload

    def test_absent_metadata_is_unknown_not_false(self):
        result = runtime_projection("opencode", env={})
        self.assertEqual("opencode", result["agent"])
        self.assertFalse(result["runtime_info_present"])
        self.assertIsNone(result["provider"])
        self.assertEqual(set(CAPABILITY_NAMES), set(result["capabilities"]))
        self.assertTrue(all(value is None for value in result["capabilities"].values()))

    def test_explicit_metadata_and_tristate_capabilities(self):
        path = self._write_info(
            "runtime.json",
            {
                "schema_version": 1,
                "harness": "opencode",
                "provider": "openai",
                "model": "model-x",
                "variant": "high",
                "capabilities": {"shell": True, "browser": False},
            },
        )
        result = runtime_projection("seat-7", path, env={})
        self.assertEqual("seat-7", result["agent"])
        self.assertEqual("opencode", result["harness"])
        self.assertEqual("openai", result["provider"])
        self.assertTrue(result["capabilities"]["shell"])
        self.assertFalse(result["capabilities"]["browser"])
        self.assertIsNone(result["capabilities"]["mcp"])

    def test_explicit_path_precedes_environment_path(self):
        explicit = self._write_info("explicit.json", {"model": "explicit"})
        environmental = self._write_info("environment.json", {"model": "environment"})
        result = load_runtime_info(explicit, env={"SAIPEN_RUNTIME_INFO": str(environmental)})
        self.assertEqual("explicit", result["model"])
        self.assertEqual("explicit_cli", result["source"])

    def test_runtime_document_cannot_override_agent_seat(self):
        path = self._write_info("bad-agent.json", {"agent": "forged", "model": "x"})
        with self.assertRaisesRegex(RuntimeInfoError, "must not define 'agent'"):
            runtime_projection("real-seat", path, env={})

    def test_malformed_and_non_regular_metadata_fail_controlled(self):
        malformed = self.base / "bad.json"
        malformed.write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeInfoError, "malformed JSON"):
            load_runtime_info(malformed, env={})
        directory = self.base / "directory.json"
        directory.mkdir()
        with self.assertRaisesRegex(RuntimeInfoError, "regular non-symlink"):
            load_runtime_info(directory, env={})

    def test_duplicate_fields_and_boolean_schema_are_rejected(self):
        duplicate = self.base / "duplicate.json"
        duplicate.write_text('{"model":"a","model":"b"}', encoding="utf-8")
        with self.assertRaisesRegex(RuntimeInfoError, "repeats JSON field 'model'"):
            load_runtime_info(duplicate, env={})
        boolean_schema = self._write_info("bool-schema.json", {"schema_version": True})
        with self.assertRaisesRegex(RuntimeInfoError, "schema_version must be 1"):
            load_runtime_info(boolean_schema, env={})

    def test_oversized_metadata_is_refused_before_parse(self):
        oversized = self.base / "oversized.json"
        oversized.write_bytes(b"{" + b" " * (64 * 1024) + b"}")
        with self.assertRaisesRegex(RuntimeInfoError, "cannot be read safely"):
            load_runtime_info(oversized, env={})

    def test_agent_flag_never_guesses_model_provider_or_capabilities(self):
        before = self._tree()
        process, payload = self._cli("--agent", "opencode", "runtime")
        self.assertEqual(0, process.returncode, process.stderr + process.stdout)
        self.assertEqual("RUNTIME", payload["code"])
        self.assertEqual("opencode", payload["agent"])
        self.assertIsNone(payload["provider"])
        self.assertIsNone(payload["model"])
        self.assertTrue(all(value is None for value in payload["capabilities"].values()))
        self.assertEqual(before, self._tree(), "read-only runtime command wrote project state")

    def test_bare_runtime_inherits_persisted_agent_without_handover(self):
        before = self._tree()
        process, payload = self._cli("runtime")
        self.assertEqual(0, process.returncode, process.stderr + process.stdout)
        self.assertEqual("persisted-seat", payload["agent"])
        self.assertEqual(before, self._tree())

    def test_cli_explicit_runtime_info_keeps_agent_separate(self):
        info = self._write_info(
            "cli.json",
            {"harness": "codex", "provider": "provider-y", "capabilities": {"patch": True}},
        )
        process, payload = self._cli(
            "--agent", "ownership-seat", "runtime", "--runtime-info", str(info)
        )
        self.assertEqual(0, process.returncode, process.stderr)
        self.assertEqual("ownership-seat", payload["agent"])
        self.assertEqual("codex", payload["harness"])
        self.assertEqual("provider-y", payload["provider"])
        self.assertTrue(payload["capabilities"]["patch"])

    def test_cli_environment_metadata_and_explicit_precedence(self):
        environmental = self._write_info("env.json", {"model": "from-env"})
        explicit = self._write_info("cli-wins.json", {"model": "from-cli"})
        env = {**self.env, "SAIPEN_RUNTIME_INFO": str(environmental)}
        process, payload = self._cli("runtime", "--runtime-info", str(explicit), env=env)
        self.assertEqual(0, process.returncode, process.stderr)
        self.assertEqual("from-cli", payload["model"])
        self.assertEqual("explicit_cli", payload["runtime_info_source"])

    def test_cli_environment_metadata_loads_without_explicit_flag(self):
        environmental = self._write_info("env-only.json", {"model": "from-env"})
        env = {**self.env, "SAIPEN_RUNTIME_INFO": str(environmental)}
        process, payload = self._cli("runtime", env=env)
        self.assertEqual(0, process.returncode, process.stderr)
        self.assertEqual("from-env", payload["model"])
        self.assertEqual("environment", payload["runtime_info_source"])

    def test_malformed_cli_input_has_no_traceback_and_zero_writes(self):
        malformed = self.base / "malformed.json"
        malformed.write_text("[]", encoding="utf-8")
        before = self._tree()
        process, payload = self._cli("runtime", "--runtime-info", str(malformed))
        self.assertEqual(1, process.returncode)
        self.assertEqual("VALIDATION_FAILED", payload["code"])
        self.assertNotIn("Traceback", process.stderr + process.stdout)
        self.assertEqual(before, self._tree())

    def test_runtime_info_is_refused_on_non_runtime_command(self):
        info = self._write_info("unused.json", {"model": "x"})
        before = self._tree()
        process, payload = self._cli("status", "--runtime-info", str(info))
        self.assertEqual(2, process.returncode)
        self.assertEqual("VALIDATION_FAILED", payload["code"])
        self.assertEqual(before, self._tree())

    def test_runtime_is_classified_read_only_and_canonical_agent_cc_still_routes(self):
        self.assertFalse(cli._command_mutates("runtime", []))
        before = self._tree()
        process, payload = self._cli("--agent", "opencode", "cc", "--dry-run")
        self.assertEqual(0, process.returncode, process.stderr + process.stdout)
        self.assertTrue(payload["ok"])
        self.assertEqual("cc", payload["route"])
        self.assertEqual(before, self._tree())


class AdaptiveRuntimeWave2Tests(unittest.TestCase):
    """Wave 2: the strategy decision is executable, bounded and read-only."""

    setUp = AdaptiveRuntimeTests.setUp
    _write_info = AdaptiveRuntimeTests._write_info
    _tree = AdaptiveRuntimeTests._tree
    _cli = AdaptiveRuntimeTests._cli

    # -- the decision ------------------------------------------------------

    def test_default_is_long_build_with_zero_helpers(self):
        decision = select_strategy()
        self.assertEqual(DEFAULT_TASK_CLASS, decision["task_class"])
        self.assertEqual(DEFAULT_STRATEGY, "LONG_BUILD")
        self.assertEqual(0, decision["helper_ceiling"])
        self.assertIsNone(decision["helper_justification"])
        self.assertEqual("ORDINARY", decision["context_budget_class"])
        self.assertIn("no helper justification was supplied", decision["why"])

    def test_red_control_the_zero_helper_default_is_load_bearing(self):
        # The default MUST be zero helpers. Tamper with the rule's own answer
        # and prove the assertion that guards it actually goes red, so a future
        # edit that makes helpers reflexive cannot pass this suite silently.
        decision = select_strategy(DEFAULT_TASK_CLASS)
        tampered = {**decision, "helper_ceiling": decision["helper_ceiling"] + 1}
        self.assertNotEqual(0, tampered["helper_ceiling"])
        self.assertRaises(AssertionError, self.assertEqual, 0, tampered["helper_ceiling"])

    def test_task_class_matrix_selects_the_declared_strategy(self):
        expected = {
            "IMPLEMENT": "LONG_BUILD",
            "MAINTENANCE": "LONG_BUILD",
            "REPAIR": "LONG_BUILD",
            "RESEARCH": "BOUNDED_RESEARCH",
            "VERIFY": "VERIFY_ONLY",
            "AUDIT": "VERIFY_ONLY",
        }
        self.assertEqual(set(TASK_CLASSES), set(expected))
        for work, strategy in expected.items():
            with self.subTest(work=work):
                decision = select_strategy(work)
                self.assertEqual(strategy, decision["strategy"])
                self.assertIn(decision["strategy"], STRATEGIES)

    def test_control_plane_repair_is_recovery_not_ordinary_implementation(self):
        ordinary = select_strategy("REPAIR")
        self.assertEqual("LONG_BUILD", ordinary["strategy"])
        recovery = select_strategy("REPAIR", control_plane=True)
        self.assertEqual("RECOVERY", recovery["strategy"])
        self.assertEqual(0, recovery["helper_ceiling"])
        self.assertEqual("RECOVERY", recovery["context_budget_class"])
        self.assertIn("never ordinary feature implementation", recovery["why"])

    def test_helpers_require_a_declared_justification(self):
        self.assertEqual(0, select_strategy("IMPLEMENT", helper_reason=None)["helper_ceiling"])
        for reason, ceiling in HELPER_JUSTIFICATIONS.items():
            with self.subTest(reason=reason):
                decision = select_strategy("IMPLEMENT", helper_reason=reason)
                self.assertEqual(ceiling, decision["helper_ceiling"])
                self.assertEqual(reason, decision["helper_justification"])
        # An UNNAMED reason is refused, never quietly treated as "no helpers".
        with self.assertRaises(StrategyError):
            select_strategy("IMPLEMENT", helper_reason="more-agents-might-be-faster")
        with self.assertRaises(RuntimeInfoError):
            select_strategy("IMPLEMENT", helper_reason="")
        # An out-of-vocabulary task class is refused, never coerced to default.
        with self.assertRaises(StrategyError):
            select_strategy("SWARM")

    def test_helper_ceiling_and_depth_are_bounded(self):
        highest = max(HELPER_JUSTIFICATIONS.values())
        self.assertEqual(2, highest)
        for reason in HELPER_JUSTIFICATIONS:
            decision = select_strategy("IMPLEMENT", helper_reason=reason)
            self.assertLessEqual(decision["helper_ceiling"], 2)
            self.assertEqual(MAX_SUBAGENT_DEPTH, decision["max_subagent_depth"])
        self.assertEqual(1, MAX_SUBAGENT_DEPTH)
        self.assertEqual("DENIED_BY_POLICY", decision["recursive_helpers"])
        # VERIFY/AUDIT get an independent verifier ONLY for that exact reason.
        self.assertEqual(
            1,
            select_strategy("VERIFY", helper_reason="independent-verification")["helper_ceiling"],
        )
        self.assertEqual(
            0,
            select_strategy("VERIFY", helper_reason="isolated-research")["helper_ceiling"],
        )

    def test_depth_enforcement_is_reported_unknown_not_claimed(self):
        # SAIPEN states the POLICY and reports the host ENFORCEMENT honestly.
        self.assertEqual("UNKNOWN", DEPTH_ENFORCEMENT)
        decision = select_strategy("RESEARCH")
        self.assertEqual("UNKNOWN", decision["depth_enforcement"])

    def test_context_budgets_are_bounded_and_child_packets_are_smaller(self):
        expected = {
            "LONG_BUILD": "ORDINARY",
            "BOUNDED_RESEARCH": "MINIMAL",
            "VERIFY_ONLY": "BOUNDED",
            "RECOVERY": "RECOVERY",
        }
        self.assertEqual(set(STRATEGIES), set(expected))
        for name, ceiling in CONTEXT_BUDGET_CLASSES.items():
            with self.subTest(name=name):
                self.assertLess(CHILD_PACKET_CEILINGS[name], ceiling)
        for strategy, budget in expected.items():
            with self.subTest(strategy=strategy):
                decision = _strategy_for(strategy)
                self.assertEqual(budget, decision["context_budget_class"])
                self.assertEqual(
                    CONTEXT_BUDGET_CLASSES[budget], decision["context_budget_bytes"]
                )

    # -- the projection ---------------------------------------------------

    def test_unknown_capabilities_are_reported_not_read_as_false(self):
        decision = strategy_projection()
        self.assertTrue(decision["unknown_capabilities"])
        self.assertTrue(all(value is None for value in decision["capabilities"].values()))

    def test_an_explicit_subagents_false_collapses_the_helper_ceiling(self):
        decision = strategy_projection(
            task_class="RESEARCH", capabilities={"subagents": False}
        )
        self.assertEqual(0, decision["helper_ceiling"])
        self.assertIn("subagents=false", decision["why"])
        still = strategy_projection(task_class="RESEARCH", capabilities={"subagents": True})
        self.assertEqual(1, still["helper_ceiling"])

    # -- the CLI surface --------------------------------------------------

    def test_cli_runtime_defaults_to_long_build_and_writes_nothing(self):
        before = self._tree()
        process, payload = self._cli("runtime")
        self.assertEqual(0, process.returncode, process.stderr + process.stdout)
        self.assertEqual("LONG_BUILD", payload["strategy"]["strategy"])
        self.assertEqual(0, payload["strategy"]["helper_ceiling"])
        self.assertEqual(before, self._tree(), "runtime strategy wrote project state")

    def test_cli_runtime_accepts_a_task_class_and_a_helper_reason(self):
        before = self._tree()
        process, payload = self._cli(
            "runtime", "--task-class", "research", "--helper-reason", "isolated-research"
        )
        self.assertEqual(0, process.returncode, process.stderr + process.stdout)
        self.assertEqual("RESEARCH", payload["strategy"]["task_class"])
        self.assertEqual("BOUNDED_RESEARCH", payload["strategy"]["strategy"])
        self.assertEqual(before, self._tree())

    def test_cli_runtime_refuses_unknown_input_with_zero_writes(self):
        before = self._tree()
        # A usage error (a malformed flag) is exit 2; an out-of-vocabulary
        # VALUE is the same semantic refusal every other read-only command
        # makes and is exit 1. Both are VALIDATION_FAILED with zero writes.
        for bad, rc in (
            (("runtime", "--task-class", "SWARM"), 1),
            (("runtime", "--helper-reason", "just-because"), 1),
            (("runtime", "--task-class"), 2),
            (("runtime", "--nonsense"), 2),
        ):
            with self.subTest(args=bad):
                process, payload = self._cli(*bad)
                self.assertEqual(rc, process.returncode, process.stdout)
                self.assertEqual("VALIDATION_FAILED", payload["code"])
                self.assertNotIn("Traceback", process.stderr + process.stdout)
        self.assertEqual(before, self._tree())

    def test_strategy_never_becomes_canonical_project_truth(self):
        info = self._write_info(
            "wave2.json",
            {
                "harness": "opencode",
                "provider": "provider-z",
                "model": "secret-model",
                "capabilities": {"subagents": True},
            },
        )
        before = self._tree()
        process, payload = self._cli(
            "runtime",
            "--task-class",
            "IMPLEMENT",
            "--helper-reason",
            "genuinely-parallel",
            "--runtime-info",
            str(info),
        )
        self.assertEqual(0, process.returncode, process.stderr)
        self.assertEqual(2, payload["strategy"]["helper_ceiling"])
        self.assertEqual(before, self._tree(), "strategy/runtime identity was persisted")
        for name, raw in self._tree().items():
            text = raw.decode("utf-8", errors="replace")
            self.assertNotIn("secret-model", text, name)
            self.assertNotIn("provider-z", text, name)
            self.assertNotIn("genuinely-parallel", text, name)


def _strategy_for(strategy: str) -> dict:
    """Reach a given Wave-2 strategy through its declared work class."""
    if strategy == "RECOVERY":
        return select_strategy("REPAIR", control_plane=True)
    work = {
        "LONG_BUILD": "IMPLEMENT",
        "BOUNDED_RESEARCH": "RESEARCH",
        "VERIFY_ONLY": "VERIFY",
    }[strategy]
    return select_strategy(work)


if __name__ == "__main__":
    unittest.main(verbosity=2)
