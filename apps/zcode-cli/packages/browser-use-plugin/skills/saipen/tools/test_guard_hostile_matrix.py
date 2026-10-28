"""Hostile forgetful-agent matrix for the admission guard (SRC-028:R015).

Twenty deterministic controls, one per row of the SRC-030 Part 13 matrix:
protocol-state refusals, traversal/alias bypass attempts, binding failures,
host-event fail-closed behavior, real adapter blocking evidence, and the
truthful enforcement-strength ladder. Every control is a RED control: it
holds the guard to a refusal an adversary can name.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from datetime import datetime, timezone
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events  # noqa: E402
from saipen_engine.admission import (  # noqa: E402
    ENFORCEMENT_STRENGTH_GAP,
    effective_strength,
    evaluate_admission,
    get_adapter,
)
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402

from test_hermetic_env import isolate_host_session, retained_fixtures  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


#: TemporaryDirectory handles are retained so the OS reclaims them at exit
#: instead of the suite rmtree-ing fixtures other assertions may still read.
#:
#: T-1353: the list is PROCESS-GLOBAL, not module-global. `python -m unittest
#: tools.test_a tools.test_b` loads named modules under the dotted spelling
#: while they flat-import their siblings, so this file can be two live module
#: objects at once -- measured -- and a module-global list would then be two
#: lists. Whichever copy went out of scope first would take its handles'
#: directories with it while the other copy's assertions were still reading
#: them, which is the exact failure this list exists to prevent.
_TEMP: list = retained_fixtures()

STATE_TEMPLATE = """---
phase: {phase}
task: {task}
next_action: "{next_action}"
blocker: "{blocker}"
transition_from: SHIP
saipen_version: 7
schema_version: 3
last_event: 100
style_contract: ded-4ae736e4
mode: {mode}
updated: 2026-09-12T00:00:00Z
agent: {agent}
---
"""

BOARD_TEMPLATE = """## DOING
## TODO
## DONE
## BLOCKED
"""


def legal_log_line(event: int = 100, agent: str = "test-agent") -> str:
    return f"- 12.09.26 00:00 [E-{event}] [agent: {agent}] RUN: hostile matrix fixture\n"


def fresh_project(**state_overrides) -> Path:
    tmp = tempfile.TemporaryDirectory()
    _TEMP.append(tmp)
    root = Path(tmp.name)
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    fields = {
        "phase": "DONE",
        "task": "none",
        "next_action": "saipen continue",
        "blocker": "",
        "mode": "full",
        "agent": "test-agent",
    }
    fields.update(state_overrides)
    (saipen / "STATE.md").write_text(STATE_TEMPLATE.format(**fields), encoding="utf-8")
    (saipen / "BOARD.md").write_text(BOARD_TEMPLATE, encoding="utf-8")
    (saipen / "LOG.md").write_text(legal_log_line(), encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("code", encoding="utf-8")
    return root


def project_with_doing_owner(owner: str, agent: str = "other-agent") -> Path:
    root = fresh_project(
        agent=agent, phase="BUILD", task="T-9001", next_action="PHASE BUILD T-9001"
    )
    # T-1478: stamped when the fixture is BUILT. An import-time stamp is
    # discovery time, and the declared family reaches this module past the
    # 15-minute claim liveness window, so "live" read as stale.
    claimed = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    board = (
        "## DOING\n"
        f"- [/] T-9001 live work | verify: x | owner: {owner} | "
        f"claim_time: {claimed}\n"
        "## TODO\n## DONE\n## BLOCKED\n"
    )
    (root / ".saipen" / "BOARD.md").write_text(board, encoding="utf-8")
    return root


def active_project() -> Path:
    """A source-write fixture must carry the active Work required by Core."""
    return project_with_doing_owner("test-agent", agent="test-agent")


def corrupt_state_project() -> Path:
    root = fresh_project()
    (root / ".saipen" / "STATE.md").write_text(
        "---\nphase: DONE\nphase: BUILD\nbroken\n---\n", encoding="utf-8"
    )
    return root


def corrupt_board_project() -> Path:
    root = fresh_project()
    (root / ".saipen" / "BOARD.md").write_text(
        "## DOING\nnot a ticket record at all\n", encoding="utf-8"
    )
    return root


def recovery_debt_project() -> Path:
    root = fresh_project()
    ops = root / ".saipen" / "recovery" / "ops"
    ops.mkdir(parents=True)
    op_dir = ops / "op-hostile-fixture"
    op_dir.mkdir()
    (op_dir / "operation.json").write_bytes(b"this is not json")
    return root


class GuardEventHarness:
    """Drive the real guard CLI the way the OpenCode plugin does."""

    @staticmethod
    def run(event: dict) -> tuple[int, dict]:
        payload = json.dumps(event)
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "guard",
                "--event-json",
                "-",
                "--json",
            ],
            input=payload,
            capture_output=True,
            text=True,
            cwd=str(event["cwd"]),
            timeout=60,
        )
        try:
            data = json.loads(proc.stdout)
        except json.JSONDecodeError:
            data = {"raw": proc.stdout, "stderr": proc.stderr}
        return proc.returncode, data

    @staticmethod
    def tool_event(root: Path, tool: str, tool_input: dict) -> dict:
        return {
            "event": "before_tool",
            "host": "opencode",
            "cwd": str(root),
            "tool_name": tool,
            "tool_input": tool_input,
            "actor": "test-agent",
        }


class ProtocolStateRefusals(unittest.TestCase):
    """Rows 1-5: broken canonical state blocks consequential mutation."""

    def test_01_malformed_state_blocks_mutation(self):
        root = corrupt_state_project()
        res = evaluate_admission(root, target_path="src/app.py", action="write", agent="test-agent")
        self.assertFalse(res["admitted"])
        self.assertEqual(res["code"], "PROTOCOL_STATE_INVALID")

    def test_02_malformed_board_blocks_mutation(self):
        root = corrupt_board_project()
        res = evaluate_admission(root, target_path="src/app.py", action="edit", agent="test-agent")
        self.assertFalse(res["admitted"])
        self.assertEqual(res["code"], "PROTOCOL_STATE_INVALID")

    def test_03_recovery_debt_blocks_ordinary_mutation(self):
        root = recovery_debt_project()
        res = evaluate_admission(root, target_path="src/app.py", action="write", agent="test-agent")
        self.assertFalse(res["admitted"])
        self.assertEqual(res["code"], "RECOVERY_REQUIRED")

    def test_04_recovery_debt_permits_the_recovery_command(self):
        root = recovery_debt_project()
        # The canonical operation class is admitted under debt...
        res = evaluate_admission(root, action="saipen_op", agent="test-agent")
        self.assertTrue(res["admitted"], res)
        # ...and the host event for `saipen recover` maps onto that class.
        code, data = GuardEventHarness.run(
            GuardEventHarness.tool_event(root, "bash", {"command": "saipen recover"})
        )
        self.assertEqual(code, 0, data)
        self.assertEqual(data["event"]["action"], "saipen_op")
        self.assertTrue(data["admitted"])

    def test_05_wait_blocked_state_prevents_unrelated_mutation(self):
        root = fresh_project(
            next_action="WAIT: safety valve reached (3 waves / 20 tickets) -- run 'cc' to continue"
        )
        res = evaluate_admission(root, target_path="src/app.py", action="write", agent="test-agent")
        self.assertFalse(res["admitted"])
        self.assertEqual(res["code"], "WAIT_BLOCKED")
        # A BLOCKED phase refuses too.
        root2 = fresh_project(phase="BLOCKED", blocker="none")
        res2 = evaluate_admission(
            root2, target_path="src/app.py", action="write", agent="test-agent"
        )
        self.assertEqual(res2["code"], "WAIT_BLOCKED")

    def test_05b_router_and_guard_share_one_hard_stop_truth(self):
        """T-1322: a non-empty STATE.blocker must be the SAME hard stop for the
        mutation guard AND the router. AUDAPACK regressed because the guard
        honoured the blocker while the router only looked at phase==BLOCKED and
        persisted WAIT, so `continue` advertised runnable work the guard
        refused. Both now route through `state.binding_brake`."""
        from saipen_engine.router import route_next

        root = fresh_project(
            phase="BUILD",
            task="none",
            next_action="PHASE BUILD T-1",
            blocker="EXTERNAL: antigravity agent carrying a SAITULS task",
        )
        res = evaluate_admission(
            root, target_path="src/app.py", action="write", agent="test-agent"
        )
        self.assertFalse(res["admitted"])
        self.assertEqual(res["code"], "WAIT_BLOCKED")

        state_text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        board_text = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        routed = route_next(state_text, board_text, audit_inbox=None)
        self.assertEqual(routed["reason"], "unblock")
        self.assertEqual(routed["executable_behavior"], "RESTATE_AND_STOP")


class OwnershipControls(unittest.TestCase):
    """Row 6: the engine's own board authority decides ownership."""

    def test_06_foreign_live_owner_blocks_the_other_agent(self):
        root = project_with_doing_owner(owner="astra2", agent="astra2")
        res = evaluate_admission(root, target_path="src/app.py", action="write", agent="test-agent")
        self.assertFalse(res["admitted"])
        self.assertEqual(res["code"], "OWNERSHIP_CONFLICT")
        # The owner itself passes, and a read is never an ownership conflict.
        owner_res = evaluate_admission(
            root, target_path="src/app.py", action="write", agent="astra2"
        )
        self.assertTrue(owner_res["admitted"])
        read_res = evaluate_admission(
            root, target_path="src/app.py", action="read", agent="test-agent"
        )
        self.assertTrue(read_res["admitted"])


class DiagnosticAccess(unittest.TestCase):
    """Row 7: reads stay possible under broken state."""

    def test_07_read_diagnostics_survive_broken_state(self):
        root = corrupt_state_project()
        res = evaluate_admission(
            root, target_path=".saipen/STATE.md", action="read", agent="test-agent"
        )
        self.assertTrue(res["admitted"])
        self.assertEqual(res["code"], "ADMITTED_READ_ONLY")
        ordinary = evaluate_admission(
            root, target_path="src/app.py", action="read", agent="test-agent"
        )
        self.assertTrue(ordinary["admitted"])


class ProtectedNamespaceBypassControls(unittest.TestCase):
    """Rows 8-10: direct, traversal and alias writes all refused."""

    def test_08_canonical_direct_write_blocked(self):
        root = fresh_project()
        res = evaluate_admission(
            root, target_path=".saipen/STATE.md", action="write", agent="test-agent"
        )
        self.assertEqual(res["code"], "PROTECTED_CANONICAL_NAMESPACE")

    def test_09_traversal_write_blocked(self):
        root = fresh_project()
        for target in (
            "src/../.saipen/STATE.md",
            "./.saipen/STATE.md",
            "nested/a/../../.saipen/BOARD.md",
            "src/./sub/../../.saipen/LOG.md",
        ):
            res = evaluate_admission(
                root, target_path=target, action="write", agent="test-agent"
            )
            self.assertEqual(res["code"], "PROTECTED_CANONICAL_NAMESPACE", target)
        # A relative traversal that ESCAPES the root is named, never ordinary.
        escape = evaluate_admission(
            root, target_path="src/../../outside.md", action="write", agent="test-agent"
        )
        self.assertEqual(escape["code"], "PATH_ESCAPES_PROJECT")
        self.assertFalse(escape["admitted"])
        # An absolute spelling of a protected file is the same refusal.
        absolute = evaluate_admission(
            root,
            target_path=str(root / ".saipen" / "LOG.md"),
            action="write",
            agent="test-agent",
        )
        self.assertEqual(absolute["code"], "PROTECTED_CANONICAL_NAMESPACE")

    @unittest.skipUnless(os.name == "nt", "Windows junction requires native Windows cmd.exe")
    def test_10_reparse_alias_into_protected_namespace_blocked(self):
        root = fresh_project()
        junction = root / "alias"
        created = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(junction), str(root / "src")],
            capture_output=True,
            text=True,
        )
        if junction.exists():
            try:
                res = evaluate_admission(
                    root,
                    target_path="alias/../.saipen/STATE.md",
                    action="write",
                    agent="test-agent",
                )
                self.assertEqual(res["code"], "PROTECTED_CANONICAL_NAMESPACE")
            finally:
                subprocess.run(["cmd", "/c", "rmdir", str(junction)], capture_output=True)
        else:
            self.skipTest(f"junction creation unavailable: {created.stderr.strip()}")

    def test_10b_symlink_alias_into_protected_namespace_blocked(self):
        root = fresh_project()
        link = root / "link"
        try:
            os.symlink(root / ".saipen", link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation unavailable on this host")
        res = evaluate_admission(
            root, target_path="link/STATE.md", action="write", agent="test-agent"
        )
        self.assertEqual(res["code"], "PROTECTED_CANONICAL_NAMESPACE")


class BindingControls(unittest.TestCase):
    """Rows 11-13: detached cwd binding, wrong lineage, non-SAIPEN."""

    def setUp(self):
        from saipen_engine.paths import project_lineage_identity

        self.project = fresh_project()
        self.lineage = project_lineage_identity(self.project)
        self.staging = Path(tempfile.mkdtemp())

    def _env(self, **extra) -> dict:
        env = dict(os.environ)
        env.pop("SAIPEN_PROJECT_ROOT", None)
        env.pop("SAIPEN_PROJECT_LINEAGE", None)
        env.update(extra)
        return env

    def test_11_detached_cwd_with_valid_binding_protects_the_project(self):
        _code, data = GuardEventHarness.run(
            {
                **GuardEventHarness.tool_event(
                    self.project, "write", {"file_path": ".saipen/STATE.md"}
                ),
                "cwd": str(self.staging),
            }
        )
        # The detached staging cwd has no .saipen and no carrier: the guard
        # must NOT protect the intended project from there -- non-interference
        # -- because jurisdiction never followed the session.
        self.assertEqual(data.get("code"), "NOT_SAIPEN_PROJECT", data)
        self.assertTrue(data["admitted"])
        # With the verified carrier the same refusal binds the real project.
        env = self._env(
            SAIPEN_PROJECT_ROOT=str(self.project),
            SAIPEN_PROJECT_LINEAGE=self.lineage,
        )
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "guard",
                "--event-json",
                json.dumps(
                    GuardEventHarness.tool_event(
                        self.project, "write", {"file_path": ".saipen/STATE.md"}
                    )
                ).replace("\n", ""),
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(self.staging),
            env=env,
            timeout=60,
        )
        data = json.loads(proc.stdout)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(data["code"], "PROTECTED_CANONICAL_NAMESPACE")

    def test_12_detached_cwd_with_wrong_lineage_fails_closed(self):
        from saipen_engine.admission import evaluate_admission as ev

        # The host carrier asserts a lineage that does not match the project's
        # IDENTITY.md: fail closed, never fall back to ambient resolution.
        with unittest.mock.patch.dict(
            os.environ,
            {
                "SAIPEN_PROJECT_ROOT": str(self.project),
                "SAIPEN_PROJECT_LINEAGE": "lineage-" + "0" * 32,
            },
        ):
            res = ev(
                self.staging,
                target_path="src/app.py",
                action="write",
                agent="test-agent",
            )
        self.assertFalse(res["admitted"])
        self.assertEqual(res["code"], "PROJECT_LINEAGE_MISMATCH")

    def test_13_non_saipen_project_remains_non_interfering(self):
        bare = Path(tempfile.mkdtemp())
        res = evaluate_admission(
            bare, target_path="README.md", action="write", agent="anyone"
        )
        self.assertTrue(res["admitted"])
        self.assertFalse(res["applicable"])
        self.assertEqual(res["code"], "NOT_SAIPEN_PROJECT")


class HostEventFailClosed(unittest.TestCase):
    """Row 14: unknown mutating host events fail closed on debt.

    T-1317 Target A: the row now ALSO holds on a HEALTHY protocol fixture.
    test_14 is deliberately (recovery-debt, ordinary path) -- there the debt
    refusal must still fire -- and test_14c is the healthy-fixture control
    the pre-fix implementation failed with a green ADMITTED.
    """

    def test_14_unknown_mutating_event_fails_closed_on_broken_state(self):
        root = recovery_debt_project()
        mapped = guard_events.map_event(
            GuardEventHarness.tool_event(root, "mystery_tool", {"path": "src/app.py"})
        )
        self.assertEqual(mapped["action"], "unknown")
        res = evaluate_admission(
            root, target_path=mapped["target_path"], action=mapped["action"], agent="test-agent"
        )
        self.assertFalse(res["admitted"])
        # Since T-1317 Target A the unclassified-effect refusal can fire
        # before the state check; either way the tool never executes.
        self.assertIn(res["code"], ("RECOVERY_REQUIRED", "TARGET_UNRESOLVED"))
        # And the real CLI exits nonzero for the same event.
        code, data = GuardEventHarness.run(
            GuardEventHarness.tool_event(root, "mystery_tool", {"path": "src/app.py"})
        )
        self.assertEqual(code, 1)
        self.assertFalse(data["admitted"], data)

    def test_14c_unknown_tool_fails_closed_on_a_healthy_project(self):
        # T-1317 Target A: an unclassified consequential host tool is refused
        # even when the protocol state is fully sound. The pre-fix guard
        # returned ADMITTED here (healthy state, mutating unknown, empty
        # targets) -- this control proves that fail-open is gone.
        root = fresh_project()
        for tool, tool_input in (
            ("mystery_tool", {}),
            ("mcp__server__invoke", {}),
            ("mystery_tool", {"path": "src/app.py"}),
            ("process_control", {}),
        ):
            with self.subTest(tool=tool, tool_input=tool_input):
                code, data = GuardEventHarness.run(
                    GuardEventHarness.tool_event(root, tool, tool_input)
                )
                self.assertEqual(code, 1, data)
                self.assertEqual(data["code"], "TARGET_UNRESOLVED", data)
                self.assertEqual(data["event"]["action"], "unknown", data)

    def test_14b_malformed_event_is_fail_closed(self):
        root = fresh_project()
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "guard",
                "--event-json",
                "{broken",
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(root),
            timeout=60,
        )
        self.assertEqual(proc.returncode, 1)
        data = json.loads(proc.stdout)
        self.assertEqual(data["code"], "GUARD_EVENT_INVALID")


class RealAdapterEvidence(unittest.TestCase):
    """Rows 15-19: genuine blocking evidence and the truthful ladder."""

    PLUGIN = TOOLS.parent / "extensions" / "adapters" / "opencode" / "saipen-guard.js"

    def _node_decision(self, status: int | None, stdout: str) -> dict:
        # Private decision-core probe only. Production exports must contain
        # solely the factory because OpenCode invokes every export.
        tmp = tempfile.TemporaryDirectory()
        _TEMP.append(tmp)
        probe = Path(tmp.name) / "guard.mjs"
        probe.write_text(self.PLUGIN.read_text(encoding="utf-8") + "\nexport { decide };\n",
                         encoding="utf-8")
        module_url = probe.resolve().as_uri()
        script = (
            "import { decide } from %r;"
            "const r = %s === null ? { error: new Error('x') } : { status: %d, stdout: %r };"
            "console.log(JSON.stringify(decide(r)));"
        ) % (module_url, "null" if status is None else status, status or 0, stdout)
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_15_opencode_hook_genuinely_blocks_a_refused_tool(self):
        root = recovery_debt_project()
        # The full plugin path: guard refuses -> nonzero exit -> the plugin
        # decision core blocks, exercising the real spawned guard process.
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "guard",
                "--event-json",
                json.dumps(
                    GuardEventHarness.tool_event(root, "write", {"file_path": "src/app.py"})
                ),
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(root),
            timeout=60,
        )
        self.assertEqual(proc.returncode, 1)
        verdict = self._node_decision(1, proc.stdout)
        self.assertTrue(verdict["block"])
        self.assertEqual(verdict["code"], "RECOVERY_REQUIRED")
        # Allowed action -> the same decision core lets the tool proceed.
        healthy = active_project()
        allowed = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "guard",
                "--event-json",
                json.dumps(
                    GuardEventHarness.tool_event(healthy, "write", {"file_path": "src/app.py"})
                ),
                "--json",
            ],
            capture_output=True,
            text=True,
            cwd=str(healthy),
            timeout=60,
        )
        self.assertEqual(allowed.returncode, 0)
        self.assertFalse(self._node_decision(0, allowed.stdout)["block"])
        # Unreachable guard (no result object) blocks too.
        self.assertTrue(self._node_decision(None, "")["block"])

    def test_15b_plugin_wires_tool_execute_before_and_throws_on_block(self):
        source = self.PLUGIN.read_text(encoding="utf-8")
        self.assertIn("tool.execute.before", source)
        self.assertIn("SAIPEN_GUARD_REFUSAL", source)
        self.assertIn("throw new Error", source)
        self.assertIn("saipen.py", source)
        self.assertIn("--event-json", source)

    def test_zero_exit_without_valid_admission_fails_closed(self):
        for output in ("", "not-json", "{}", "[]", '{"admitted":true}',
                       '{"admitted":false,"code":"REFUSED"}',
                       '{"admitted":"true","code":"ADMITTED"}'):
            with self.subTest(output=output):
                self.assertTrue(self._node_decision(0, output)["block"])

    def test_current_artifact_without_host_health_is_unknown(self):
        verdict = effective_strength("opencode", hook_path=self.PLUGIN)
        self.assertEqual(verdict["effective"], "UNKNOWN")
        self.assertTrue(verdict["current"])
        verified = effective_strength(
            "opencode", hook_path=self.PLUGIN, guard_callable=True, probe_ok=True
        )
        self.assertEqual(verified["effective"], "BLOCKING")

    def test_16_kiro_capability_is_true_and_enforcement_is_a_gap(self):
        adapter = get_adapter("kiro")
        # T-1317 P1-1: current Kiro documents blocking PreToolUse hooks, so the
        # host CAN block. No SAIPEN Kiro adapter is installed, current,
        # guard-connected or health-probed, so enforcement stays a GAP.
        self.assertTrue(adapter["blocking_capability"])
        self.assertEqual(adapter["declared_strength"], ENFORCEMENT_STRENGTH_GAP)
        self.assertTrue(adapter["hook_install_surface"])
        self.assertTrue((TOOLS.parent / adapter["hook_artifact"]).is_file())
        verdict = effective_strength("kiro", hook_path=Path(tempfile.gettempdir()) / "none-kiro.py")
        self.assertEqual(verdict["effective"], ENFORCEMENT_STRENGTH_GAP)
        self.assertNotEqual(verdict["effective"], "BLOCKING")

    def test_17_gemini_capability_is_true_and_enforcement_is_advisory(self):
        adapter = get_adapter("gemini")
        # T-1317 P1-2: Gemini CLI BeforeTool hooks can hard-block, so the
        # capability is true; SAIPEN ships no Gemini adapter, so effective
        # enforcement must not read BLOCKING.
        self.assertTrue(adapter["blocking_capability"])
        self.assertNotEqual(adapter["declared_strength"], "BLOCKING")
        self.assertTrue(adapter["hook_install_surface"])
        self.assertNotEqual(effective_strength("gemini")["effective"], "BLOCKING")

    def test_18_missing_adapter_cannot_report_effective_blocking(self):
        verdict = effective_strength("opencode", hook_path=Path(tempfile.gettempdir()) / "none.js")
        self.assertEqual(verdict["effective"], ENFORCEMENT_STRENGTH_GAP)
        self.assertIn("not installed", verdict["reason"])

    def test_19_stale_adapter_cannot_report_effective_blocking(self):
        import hashlib

        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as handle:
            handle.write("// stale artifact bytes")
            stale_path = Path(handle.name)
        self.addCleanup(stale_path.unlink)
        digest = hashlib.sha256(b"// current artifact bytes").hexdigest()
        verdict = effective_strength("opencode", installed_digest=digest, hook_path=stale_path)
        self.assertEqual(verdict["effective"], ENFORCEMENT_STRENGTH_GAP)
        self.assertIn("digest", verdict["reason"])


class CompoundShellEscape(unittest.TestCase):
    """Rows 21-22: canonical-operation exemption is all-or-nothing (P0-1)."""

    @staticmethod
    def _mapped(root: Path, command: str) -> dict:
        return guard_events.map_event(
            GuardEventHarness.tool_event(root, "bash", {"command": command})
        )

    def test_21_compound_shell_cannot_inherit_the_canonical_exemption(self):
        root = recovery_debt_project()
        commands = (
            "saipen recover && rm -f .saipen/STATE.md",
            "saipen status && echo hacked > x.txt",
            "saipen recover ; rm -f x",
            "saipen recover || rm -f x",
            "saipen recover | tee x",
            "saipen recover > x",
            "saipen recover >> x",
            "saipen recover < x",
            "saipen recover $(touch x)",
            "saipen recover `touch x`",
            "saipen recover & touch x",
            "saipen recover\necho hacked",
            "bash -lc 'saipen recover && rm -f .saipen/STATE.md'",
        )
        for command in commands:
            mapped = self._mapped(root, command)
            self.assertEqual(mapped["action"], "shell", command)
            self.assertIsNone(mapped["saipen_verb"], command)
            # The guard refuses the whole mutation while recovery debt is live.
            code, data = GuardEventHarness.run(
                GuardEventHarness.tool_event(root, "bash", {"command": command})
            )
            self.assertEqual(code, 1, command)
            self.assertFalse(data["admitted"], command)
            expected = (
                "PROTECTED_CANONICAL_NAMESPACE" if ".saipen" in command
                else "RECOVERY_REQUIRED"
            )
            self.assertEqual(data["code"], expected, command)

    def test_22_exact_canonical_recovery_still_runs_under_debt(self):
        root = recovery_debt_project()
        for command in ("saipen recover", "saipen recover --json", "saipen status"):
            mapped = self._mapped(root, command)
            self.assertEqual(mapped["action"], "saipen_op", command)
            self.assertIsNotNone(mapped["saipen_verb"], command)
            code, data = GuardEventHarness.run(
                GuardEventHarness.tool_event(root, "bash", {"command": command})
            )
            self.assertEqual(code, 0, command)
            self.assertTrue(data["admitted"], command)


class ProtectedShellNamespace(unittest.TestCase):
    """Explicit protected paths in ordinary shell commands are preflight refusals."""

    def test_normal_development_shell_remains_usable(self):
        root = active_project()
        # SRC-085 M1: `python --version` is now classified by the bounded
        # runtime-probe owner, so it maps to the READ class instead of an
        # ordinary shell effect. The property this control owns is that
        # ordinary development lines stay usable and admitted, whichever
        # read-only class they earn.
        for command, expected_action in (
            ("python --version", "read"),
            ("python -m compileall src", "shell"),
            ("rg TODO src/app.py", "shell"),
        ):
            code, data = GuardEventHarness.run(
                GuardEventHarness.tool_event(root, "bash", {"command": command})
            )
            self.assertEqual(
                (code, data["code"], data["action"]),
                (0, "ADMITTED", expected_action),
                command,
            )

    def test_explicit_protected_shell_paths_are_refused(self):
        root = fresh_project()
        commands = (
            "python -c \"from pathlib import Path; Path('.saipen/STATE.md').write_text('boom')\"",
            "rm -f .saipen/BOARD.md",
            r"del .saipen\STATE.md",
            "python -c \"open('src/../.saipen/STATE.md', 'w').write('boom')\"",
            r"del src\..\.saipen\BOARD.md",
            "rm -rf ./.saipen",
        )
        for command in commands:
            event = GuardEventHarness.tool_event(root, "bash", {"command": command})
            mapped = guard_events.map_event(event)
            self.assertEqual(mapped["action"], "shell", command)
            code, data = GuardEventHarness.run(event)
            self.assertEqual((code, data["code"], data["admitted"]),
                             (1, "PROTECTED_CANONICAL_NAMESPACE", False), command)

    def test_compound_recovery_with_protected_mutation_is_shell_and_refused(self):
        root = recovery_debt_project()
        command = "saipen recover && rm -f .saipen/STATE.md"
        event = GuardEventHarness.tool_event(root, "bash", {"command": command})
        self.assertEqual(guard_events.map_event(event)["action"], "shell")
        code, data = GuardEventHarness.run(event)
        self.assertEqual(code, 1)
        self.assertFalse(data["admitted"])

    def test_structured_write_and_non_saipen_shell_keep_their_contract(self):
        root = fresh_project()
        code, data = GuardEventHarness.run(
            GuardEventHarness.tool_event(root, "write", {"filePath": ".saipen/STATE.md"})
        )
        self.assertEqual((code, data["code"]), (1, "PROTECTED_CANONICAL_NAMESPACE"))
        plain = Path(tempfile.mkdtemp(prefix="non-saipen-shell-"))
        self.addCleanup(plain.rmdir)
        code, data = GuardEventHarness.run(
            GuardEventHarness.tool_event(plain, "bash", {"command": "python --version"})
        )
        self.assertEqual((code, data["code"]), (0, "NOT_SAIPEN_PROJECT"))


class OpenCodeDelegation(unittest.TestCase):
    """The exact host task tool is orchestration; child effects need native proof."""

    @staticmethod
    def task_event(root: Path, tool: str = "task") -> dict:
        return GuardEventHarness.tool_event(root, tool, {
            "description": "Implement Queue Viewer closure",
            "prompt": "Inspect source and run bounded tests.",
            "subagent_type": "general",
        })

    def test_exact_task_is_classified_and_usable_on_a_healthy_project(self):
        root = active_project()
        event = self.task_event(root)
        self.assertEqual(guard_events.map_event(event)["action"], "delegate")
        code, data = GuardEventHarness.run(event)
        self.assertEqual((code, data["code"], data["admitted"]), (0, "ADMITTED", True))

    def test_idle_project_does_not_authorize_consequential_work(self):
        code, data = GuardEventHarness.run(self.task_event(fresh_project()))
        self.assertEqual((code, data["code"], data["admitted"]), (1, "NO_ACTIVE_WORK", False))

    def test_task_respects_recovery_debt_and_unknown_lookalikes_stay_closed(self):
        debt = recovery_debt_project()
        code, data = GuardEventHarness.run(self.task_event(debt))
        self.assertEqual((code, data["code"]), (1, "RECOVERY_REQUIRED"))
        healthy = fresh_project()
        for tool in ("mcp__server__task", "plugin.task", "mystery_task"):
            event = self.task_event(healthy, tool)
            self.assertEqual(guard_events.map_event(event)["action"], "unknown")
            code, data = GuardEventHarness.run(event)
            self.assertEqual((code, data["code"]), (1, "TARGET_UNRESOLVED"))

    def test_task_keeps_actor_ownership_and_host_identity_checks(self):
        foreign = project_with_doing_owner("codex", agent="codex")
        code, data = GuardEventHarness.run(self.task_event(foreign))
        self.assertEqual((code, data["code"]), (1, "OWNERSHIP_CONFLICT"))
        event = self.task_event(fresh_project())
        event["host"] = "kiro"
        self.assertEqual(guard_events.map_event(event)["action"], "unknown")


class MultiTargetMutation(unittest.TestCase):
    """Rows 23-26: EVERY target of one effect is judged (P0-5/P0-6)."""

    def test_23_patch_touching_protected_state_is_blocked(self):
        root = fresh_project()
        patch = (
            "*** Begin Patch\n"
            "*** Update File: src/app.py\n"
            "@@\n-code\n+hacked\n"
            "*** Add File: .saipen/STATE.md\n"
            "+owned\n"
            "*** End Patch\n"
        )
        event = GuardEventHarness.tool_event(root, "apply_patch", {"patchText": patch})
        mapped = guard_events.map_event(event)
        self.assertEqual(mapped["target_paths"], ["src/app.py", ".saipen/STATE.md"])
        code, data = GuardEventHarness.run(event)
        self.assertEqual(code, 1)
        self.assertEqual(data["code"], "PROTECTED_CANONICAL_NAMESPACE")
        self.assertEqual(data["target"], ".saipen/STATE.md")
        # Nothing in the patch executed: the whole host tool was refused.
        self.assertNotIn("hacked", (root / "src" / "app.py").read_text(encoding="utf-8"))

    def test_24_patch_traversal_target_into_protected_state_is_blocked(self):
        root = fresh_project()
        for spelling in ("src/../.saipen/BOARD.md", "docs/nested/../../.saipen/BOARD.md"):
            patch = f"*** Update File: {spelling}\n@@\n-a\n+b\n"
            code, data = GuardEventHarness.run(
                GuardEventHarness.tool_event(root, "apply_patch", {"patchText": patch})
            )
            self.assertEqual(code, 1, spelling)
            self.assertEqual(data["code"], "PROTECTED_CANONICAL_NAMESPACE", spelling)
            self.assertEqual(data["target"], ".saipen/BOARD.md", spelling)

    def test_25_move_endpoints_are_both_judged(self):
        root = fresh_project()
        into_protected = GuardEventHarness.tool_event(
            root,
            "move",
            {"source_path": "src/app.py", "destination_path": ".saipen/STATE.md"},
        )
        code, data = GuardEventHarness.run(into_protected)
        self.assertEqual(code, 1)
        self.assertEqual(data["code"], "PROTECTED_CANONICAL_NAMESPACE")
        out_of_protected = GuardEventHarness.tool_event(
            root,
            "move",
            {"source_path": ".saipen/BOARD.md", "destination_path": "src/board.md"},
        )
        code, data = GuardEventHarness.run(out_of_protected)
        self.assertEqual(code, 1)
        self.assertEqual(data["code"], "PROTECTED_CANONICAL_NAMESPACE")

    def test_26_mutation_without_a_trustworthy_target_set_fails_closed(self):
        root = fresh_project()
        for tool, tool_input in (
            ("write", {}),
            ("apply_patch", {}),
            ("apply_patch", {"patchText": "no bounded target marker here\n"}),
            ("delete", {}),
            ("move", {"source_path": "src/app.py"}),
        ):
            code, data = GuardEventHarness.run(
                GuardEventHarness.tool_event(root, tool, tool_input)
            )
            self.assertEqual(code, 1, tool)
            self.assertEqual(data["code"], "TARGET_UNRESOLVED", tool)


class ActorBinding(unittest.TestCase):
    """Rows 27-28: canonical ownership and name-suffix trust (P0-7/P0-8)."""

    def test_27_contradictory_canonical_ownership_fails_closed(self):
        root = project_with_doing_owner("astra2")
        unbound = GuardEventHarness.tool_event(root, "write", {"file_path": "src/app.py"})
        unbound.pop("actor")
        code, data = GuardEventHarness.run(unbound)
        # STATE.agent and the live owner differ. Canonical inheritance exposes
        # that contradiction; it does not require an ACTOR_UNBOUND shortcut.
        self.assertEqual(code, 1)
        self.assertEqual(data["code"], "OWNERSHIP_CONFLICT")

        wrong = GuardEventHarness.tool_event(root, "write", {"file_path": "src/app.py"})
        wrong["actor"] = "test-agent"
        code, data = GuardEventHarness.run(wrong)
        self.assertEqual(code, 1)
        self.assertEqual(data["code"], "OWNERSHIP_CONFLICT")

        owner = GuardEventHarness.tool_event(root, "write", {"file_path": "src/app.py"})
        owner["actor"] = "astra2"
        code, data = GuardEventHarness.run(owner)
        self.assertEqual(code, 1, data)
        self.assertEqual(data["code"], "OWNERSHIP_CONFLICT")

        # Read-only diagnostics stay available with no binding at all.
        diagnostic = GuardEventHarness.tool_event(root, "read", {"file_path": ".saipen/STATE.md"})
        diagnostic.pop("actor")
        code, data = GuardEventHarness.run(diagnostic)
        self.assertEqual(code, 0, data)
        self.assertEqual(data["code"], "ADMITTED_READ_ONLY")

    def test_28_a_namespaced_read_name_grants_no_read_trust(self):
        root = recovery_debt_project()
        namespaced = GuardEventHarness.tool_event(
            root, "mcp__server__read", {"file_path": ".saipen/STATE.md"}
        )
        mapped = guard_events.map_event(namespaced)
        self.assertEqual(mapped["action"], "unknown")
        code, data = GuardEventHarness.run(namespaced)
        self.assertEqual(code, 1)
        self.assertEqual(data["code"], "PROTECTED_CANONICAL_NAMESPACE")
        # And it cannot launder a mutation through a friendly suffix either.
        passive = GuardEventHarness.tool_event(
            root, "mcp__server__read", {"file_path": "src/app.py"}
        )
        code, data = GuardEventHarness.run(passive)
        self.assertEqual(code, 1)
        # T-1317 Target A: the unclassified-effect refusal may fire before
        # the recovery-debt check; both codes are closed refusals.
        self.assertIn(data["code"], ("RECOVERY_REQUIRED", "TARGET_UNRESOLVED"))
        # The verified built-in read identity keeps diagnostic access.
        builtin = GuardEventHarness.tool_event(root, "read", {"file_path": "src/app.py"})
        code, data = GuardEventHarness.run(builtin)
        self.assertEqual(code, 0, data)


class SessionIdentityStability(unittest.TestCase):
    """Row 20: compaction or model switch cannot change a guard verdict."""

    def test_20_guard_result_is_independent_of_session_identity(self):
        root = fresh_project()
        results = [
            evaluate_admission(
                root,
                target_path=".saipen/STATE.md",
                action="write",
                agent=actor,
            )
            for actor in ("test-agent", "astra2", "session:abc123", None)
        ]
        codes = {res["code"] for res in results}
        decisions = {res["admitted"] for res in results}
        self.assertEqual(len(codes), 1)
        self.assertEqual(len(decisions), 1)
        self.assertEqual(codes.pop(), "PROTECTED_CANONICAL_NAMESPACE")


if __name__ == "__main__":
    unittest.main()
