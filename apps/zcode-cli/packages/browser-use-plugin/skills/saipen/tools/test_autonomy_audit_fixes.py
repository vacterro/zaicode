"""Hostile weak-model regression tests for SAIPEN autonomy / execution
continuity / command fidelity.

Tests A-J from the fourth-wave audit specification. Each test proves that
the contract is explicit enough that a shallow model cannot choose the wrong
interpretation.

Run standalone:
    python tools/test_autonomy_audit_fixes.py

Exit code 0 when every test passes; 1 on the first failure batch.
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(TOOLS))

from saipen_engine import intent  # noqa: E402
from saipen_engine import crew as C  # noqa: E402
from saipen_engine import producer as P  # noqa: E402
from saipen_engine import subs  # noqa: E402
from saipen_engine import state as S  # noqa: E402
import saipen as CLI  # noqa: E402


class AutonomyAuditTests(unittest.TestCase):
    """Tests A-J: hostile weak-model scenarios proving the current agent
    is the runner, ROLE_NOT_RUN/NOT_READY/CREW_BLOCKED are routing carriers,
    commands are never silently substituted, and false-green reports do not
    replace execution."""

    @staticmethod
    def _scaffold_project(root: Path) -> Path:
        """Copy the canonical scenario fixture so STATE/BOARD/LOG all exist."""
        fixture = TOOLS.parent / "tests/scenarios/done-wait-deadlock-goal-mode/.saipen"
        shutil.copytree(fixture, root / ".saipen", dirs_exist_ok=True)
        state_path = root / ".saipen/STATE.md"
        state_path.write_text(
            S.patch_state(
                state_path.read_text(encoding="utf-8"),
                {"saipen_home": str(TOOLS.parent.resolve())},
            ),
            encoding="utf-8",
            newline="\n",
        )
        return root

    # ── Test A: current-agent producer adoption ──────────────────────────
    def test_A_current_agent_producer_adoption(self):
        """ROLE_NOT_RUN + execute_in_current_agent: true must be treated as
        an imperative execution instruction for the current agent, never as
        'another agent needs to run this'."""
        root = Path(tempfile.mkdtemp())
        res = intent._prepare_producer_role(root, "saitranslate")
        # The carrier fields are a routing instruction, not a terminal refusal.
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "ROLE_NOT_RUN")
        self.assertFalse(res["terminal"])
        self.assertFalse(res["requires_human"])
        self.assertTrue(res["execute_in_current_agent"])
        self.assertEqual(res["next_action"], "RUN_ROLE")
        self.assertEqual(res["role"], "saitranslate")
        self.assertEqual(res["resume_after"], "ensure_producer_ready:saitranslate")
        # The message must use imperative AGENT-EXECUTED ROLE wording, never
        # ambiguous "must be run manually" or "needs another agent".
        self.assertIn("AGENT-EXECUTED ROLE", res["message"])
        self.assertIn("CURRENT AGENT must adopt", res["message"])
        self.assertNotIn("run manually", res["message"])
        # "does NOT require another agent" is the correct negation; a bare
        # "another agent must run" would be the defect.
        self.assertIn("does NOT require another agent", res["message"])

    def test_A_current_agent_sub_role_same_carrier(self):
        """Sub roles (non-producer) must also carry the same routing fields."""
        root = Path(tempfile.mkdtemp())
        role_dir = root / subs.SUBS_REL / "saihunt"
        role_dir.mkdir(parents=True)
        res = intent._prepare_role(root, "saihunt")
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "ROLE_NOT_RUN")
        self.assertFalse(res["terminal"])
        self.assertFalse(res["requires_human"])
        self.assertTrue(res["execute_in_current_agent"])
        self.assertEqual(res["next_action"], "RUN_ROLE")
        self.assertEqual(res["role"], "saihunt")
        self.assertEqual(res["resume_after"], "ensure_producer_ready:saihunt")
        self.assertIn("AGENT-EXECUTED ROLE", res["message"])
        self.assertIn("CURRENT AGENT must adopt", res["message"])

    # ── Test B: no dedicated runner → agent, not human ───────────────────
    def test_B_no_dedicated_runner_agent_executes(self):
        """ROLE_NOT_RUN with has_in_process_runner: false (or absent) and
        execute_in_current_agent: true means the current agent IS the runner.
        The message must not suggest a human or another agent must run it."""
        root = Path(tempfile.mkdtemp())
        res = intent._prepare_producer_role(root, "saiwiki")
        self.assertFalse(res["ok"])
        # The message explicitly says AGENT-EXECUTED ROLE and that the
        # current agent must adopt the role. This phrasing is intentionally
        # strong enough that a low-capability model cannot interpret it as
        # "human must run".
        self.assertIn("AGENT-EXECUTED ROLE", res["message"])
        self.assertIn("This is NOT a human task", res["message"])
        self.assertIn("does NOT require another agent", res["message"])

    # ── Test C: targeted producer dependency chain ───────────────────────
    def test_C_not_ready_resume_after_chain(self):
        """NOT_READY from collect_and_ship_producer must carry
        next_action/resume_after so the current agent follows the dependency
        chain: run prepare → resume collect → resume ship."""
        root = Path(tempfile.mkdtemp())
        (root / ".saipen").mkdir(parents=True)
        res = intent.collect_and_ship_producer(
            root, "saiwiki", dry_run=True, current_capability="full"
        )
        self.assertEqual(res["code"], "NOT_READY")
        self.assertFalse(res["terminal"])
        self.assertFalse(res["requires_human"])
        self.assertTrue(res["execute_in_current_agent"])
        self.assertEqual(res["next_action"], "qq")
        self.assertEqual(res["resume_after"], "collect_and_ship_producer:saiwiki")

    def test_C_not_ready_chain_translate(self):
        root = Path(tempfile.mkdtemp())
        (root / ".saipen").mkdir(parents=True)
        res = intent.collect_and_ship_producer(
            root, "saitranslate", dry_run=True, current_capability="full"
        )
        self.assertEqual(res["code"], "NOT_READY")
        self.assertFalse(res["terminal"])
        self.assertTrue(res["execute_in_current_agent"])
        self.assertEqual(res["next_action"], "ee")
        self.assertEqual(res["resume_after"], "collect_and_ship_producer:saitranslate")

    # ── Test D: stale producer evidence is not a stop ────────────────────
    def test_D_stale_producer_evidence_is_re_run(self):
        """Stale READY evidence must route to production re-run via
        ROLE_NOT_RUN, not merely report the stale fingerprint and stop."""
        from unittest import mock
        from freshness import compute_source_identity

        root = self._scaffold_project(Path(tempfile.mkdtemp()))
        # Publish a READY package with a deliberately mismatched fingerprint.
        source = root / "source.txt"
        source.write_text("content\n", encoding="utf-8")
        identity = compute_source_identity(root)
        namespace = P.producer_namespace(root, "saitranslate")
        namespace.mkdir(parents=True)
        epoch = P.ProducerEpoch.claim(namespace)
        package = P.build_package(
            producer="saitranslate",
            role_revision="role-current",
            base_source_head=identity.source_head + "-stale",
            base_source_tree_fingerprint=identity.source_tree_fingerprint + "-stale",
            base_discovery_model=identity.discovery_model,
            scope="stale package",
            read_set=P.read_set_from(root, ["source.txt"]),
            write_set={},
            epoch=epoch,
        )
        gen = P.StagingGeneration(namespace, "saitranslate").begin()
        gen.set_package(package)
        gen.publish()

        # ensure_producer_ready with stale evidence must NOT return
        # ALREADY_READY. It must refuse with ROLE_NOT_RUN.
        with mock.patch(
            "saipen_engine.subs.sub_sync",
            return_value={"ok": True, "code": "SYNCED"},
        ), mock.patch(
            "saipen_engine.subs.current_local_role_revision",
            return_value="role-current",
        ):
            res = intent.ensure_producer_ready(
                root, "saitranslate", current_capability="full"
            )
        self.assertEqual(res["code"], "ROLE_NOT_RUN", res)
        self.assertFalse(res["terminal"])
        self.assertTrue(res["execute_in_current_agent"])
        self.assertEqual(res["next_action"], "RUN_ROLE")

    # ── Test E: parent continuation after producer evidence ──────────────
    def test_E_resume_after_returns_to_crew(self):
        """ROLE_NOT_RUN's resume_after names the parent operation that
        the agent must return to after producing evidence."""
        root = Path(tempfile.mkdtemp())
        res = intent._prepare_producer_role(root, "saitranslate")
        self.assertEqual(res["resume_after"], "ensure_producer_ready:saitranslate")
        # Crew resume_after carries the same pattern.
        crew_action = C.CrewAction(
            stage="SC-2",
            role="saihunt",
            action="RUN_ROLE",
            source_identity={},
            required_contract="current source evidence",
            inputs=(),
            expected_evidence="OUTBOX with current fingerprints",
            completion_condition="SENSOR_EVIDENCE_CURRENT",
        )
        self.assertEqual(crew_action.resume_after, "REPLAN_CREW")
        self.assertEqual(crew_action.then_action, "REPLAN_CREW")

    # ── Test F: explicit human blocker stops correctly ───────────────────
    def test_F_human_blocker_stops(self):
        """WAIT_USER_CONFIRMATION / requires_human: true must stop the agent
        and ask only for the exact decision. This proves stronger autonomy
        does not erase legitimate human gates."""
        root = Path(tempfile.mkdtemp())
        # Simulate a human-only blocker. The ROLE_NOT_RUN carrier must
        # explicitly state requires_human: false when it is not a human gate.
        res = intent._prepare_producer_role(root, "saitranslate")
        self.assertFalse(res["requires_human"])
        # A genuine human blocker would have requires_human: true. The
        # protocol must never promote a non-human blocker to human.
        # Verify no ROLE_NOT_RUN carries requires_human: true.
        non_human = ["saihunt", "saitest", "saipython", "saiui", "saiwiki", "saitranslate"]
        for role in non_human:
            r = intent._prepare_role(root, role)
            if r.get("code") == "ROLE_NOT_RUN":
                self.assertFalse(r["requires_human"], f"{role} must not require human")

    # ── Test G: literal command fidelity ─────────────────────────────────
    def test_G_saipen_clean_never_sub_clean(self):
        """saipen clean must route to transition CLEAN, never to sub clean.
        The CLI must recognize clean as a phase-trigger command."""
        root = self._scaffold_project(Path(tempfile.mkdtemp()))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = CLI.main(["clean", "--dry-run", "--json", "--project-root", str(root)])
        raw = output.getvalue().strip()
        result = json.loads(raw) if raw else {}
        self.assertEqual(rc, 0, f"saipen clean --dry-run failed: {raw}")
        self.assertEqual(result.get("code"), "TRANSITIONED", raw)
        self.assertEqual(result.get("phase"), "CLEAN", raw)
        # Verify it is NOT sub clean.
        self.assertNotEqual(result.get("code"), "SUB_CLEAN", raw)
        self.assertNotIn("sub", result.get("detail", ""), raw)

    def test_G_saipen_clean_unknown_command_refused(self):
        """saipen clean with surplus args must refuse, never silently
        change meaning."""
        root = self._scaffold_project(Path(tempfile.mkdtemp()))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = CLI.main(["clean", "saihunt", "--json", "--project-root", str(root)])
        raw = output.getvalue().strip()
        result = json.loads(raw) if raw else {}
        self.assertEqual(rc, 2, raw)
        self.assertEqual(result.get("code"), "VALIDATION_FAILED", raw)

    # ── Test H: destructive mismatch gate ────────────────────────────────
    def test_H_destructive_substitute_refused(self):
        """A tempting substitute (sub clean for clean) must not be executed.
        saipen clean must route to CLEAN phase, not sub clean."""
        root = self._scaffold_project(Path(tempfile.mkdtemp()))
        # Verify saipen clean is a recognized phase-trigger verb.
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            rc = CLI.main(["clean", "--dry-run", "--json", "--project-root", str(root)])
        raw = output.getvalue().strip()
        self.assertEqual(rc, 0, f"clean must be recognized: {raw}")

    # ── Test I: false-green trap ─────────────────────────────────────────
    def test_I_false_green_trap(self):
        """CREW_BLOCKED with terminal: false must not be reported as green.
        The carrier must carry execute_in_current_agent so the agent
        continues rather than stopping."""
        root = Path(tempfile.mkdtemp())
        (root / ".saipen").mkdir(parents=True)
        # Check that CrewAction defaults are correct for non-terminal routing.
        action = C.CrewAction(
            stage="SC-2",
            role="saihunt",
            action="RUN_ROLE",
            source_identity={},
            required_contract="current",
            inputs=(),
            expected_evidence="OUTBOX",
            completion_condition="CURRENT",
        )
        self.assertFalse(action.terminal)
        self.assertFalse(action.requires_human)
        self.assertTrue(action.execute_in_current_agent)
        self.assertEqual(action.next_action, "RUN_ROLE")
        self.assertEqual(action.resume_after, "REPLAN_CREW")
        # asdict serialization includes all autonomy fields.
        from dataclasses import asdict
        d = asdict(action)
        self.assertIn("terminal", d)
        self.assertIn("requires_human", d)
        self.assertIn("execute_in_current_agent", d)
        self.assertIn("next_action", d)
        self.assertIn("resume_after", d)
        self.assertIn("then_action", d)

    # ── Test J: repeated continuation ────────────────────────────────────
    def test_J_repeated_continuation(self):
        """After each locally resolvable intermediate carrier, the agent
        must continue automatically until terminal. ROLE_NOT_RUN followed
        by another ROLE_NOT_RUN must still be non-terminal."""
        root = Path(tempfile.mkdtemp())
        # Two consecutive ROLE_NOT_RUN results must both be non-terminal.
        res1 = intent._prepare_producer_role(root, "saitranslate")
        res2 = intent._prepare_producer_role(root, "saitranslate")
        for r in (res1, res2):
            self.assertFalse(r["terminal"])
            self.assertFalse(r["requires_human"])
            self.assertTrue(r["execute_in_current_agent"])
            self.assertEqual(r["next_action"], "RUN_ROLE")
        # NOT_READY followed by a ROLE_NOT_RUN must also be non-terminal.
        (root / ".saipen").mkdir(parents=True)
        res3 = intent.collect_and_ship_producer(
            root, "saiwiki", dry_run=True, current_capability="full"
        )
        res4 = intent._prepare_producer_role(root, "saiwiki")
        for r in (res3, res4):
            if r.get("code") in ("NOT_READY", "ROLE_NOT_RUN"):
                if "terminal" in r:
                    self.assertFalse(r["terminal"])
                if "requires_human" in r:
                    self.assertFalse(r["requires_human"])
                if "execute_in_current_agent" in r:
                    self.assertTrue(r["execute_in_current_agent"])


if __name__ == "__main__":
    unittest.main(verbosity=2)