"""A tripped safety valve must never be certified CLEAN (T-1181, CORE-002).

`_state_counter_repairs` notices a valve only while the counter DISAGREES with
canonical history: at/over the cap AND ahead of the rebuild. The ordinary way a
valve trips is by honest counting -- the LOG really does hold twenty increments
and STATE really does say twenty -- and that path hits the equality `continue`,
emits no repair, and lets the whole reconciliation report CLEAN over a run
`MAINTENANCE` section 2.4 says must be paused.

Witnessed rather than imagined: `validate.py` reported the tripped valve while
`saipen continue`'s reconciliation returned CLEAN on the same STATE in the same
minute. The existing counter tests all use a disagreeing counter, which is
exactly why none of them caught it -- so the agreeing case is what is built
here.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from saipen_engine import phases
from saipen_engine.reconcile import (
    _state_phase_repairs,
    _tripped_valve_repairs,
    reconcile_protocol_state,
)

from test_hermetic_env import isolate_host_session


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


_TRANSITION_OP = "transition-" + "1" * 32

WAIT_FORM = "WAIT: safety valve reached (0 waves / 20 tickets) -- run 'cc' to continue"


class TrippedValveInvariantTests(unittest.TestCase):
    """The pure rule, independent of any project on disk."""

    def state(self, **over):
        base = {
            "execution_intent": "goal",
            "goal_waves": 0,
            "goal_tickets": 0,
            "next_action": "PHASE BUILD T-001",
        }
        base.update(over)
        return base

    def test_under_the_caps_is_not_a_trip(self):
        self.assertEqual(_tripped_valve_repairs(self.state(goal_tickets=19, goal_waves=2)), [])

    def test_tickets_at_the_cap_refuses_even_when_counters_agree(self):
        repairs = _tripped_valve_repairs(self.state(goal_tickets=20))
        self.assertEqual(len(repairs), 1)
        self.assertEqual(repairs[0]["field"], "next_action")
        self.assertTrue(repairs[0]["refuse"])
        self.assertEqual(repairs[0]["to"], WAIT_FORM)

    def test_waves_at_the_cap_trips_independently(self):
        repairs = _tripped_valve_repairs(self.state(goal_waves=3))
        self.assertEqual(len(repairs), 1)
        self.assertIn("goal_waves=3", repairs[0]["reason"])

    def test_a_state_already_stating_the_pause_needs_no_repair(self):
        self.assertEqual(
            _tripped_valve_repairs(self.state(goal_tickets=20, next_action=WAIT_FORM)), []
        )

    def test_the_counters_are_never_tidied_by_this_rule(self):
        """They ARE the tripped condition; only `cc` clears them."""
        repairs = _tripped_valve_repairs(self.state(goal_tickets=20))
        self.assertEqual({r["field"] for r in repairs}, {"next_action"})

    def test_a_non_goal_run_owns_no_valve(self):
        self.assertEqual(
            _tripped_valve_repairs(self.state(execution_intent="normal", goal_tickets=99)), []
        )

    def test_a_malformed_counter_is_not_read_as_tripped(self):
        """A bool or a string is the counter-repair path's business, not this one."""
        self.assertEqual(_tripped_valve_repairs(self.state(goal_tickets=True)), [])
        self.assertEqual(_tripped_valve_repairs(self.state(goal_tickets="20")), [])


class ReconcileEndToEndTests(unittest.TestCase):
    """The witnessed shape, through the real entry point, on a real tree."""

    def _make_project(self, tickets: int, next_action: str) -> Path:
        root = Path(tempfile.mkdtemp(prefix="t1181-valve-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)

        # A LOG that honestly earned every increment: derived == stored, which
        # is the case the counter-repair path deliberately skips.
        lines = ["# Log", "- 30.08.26 00:00 [E-0001] [agent: tester] DEC: goal pivot -- valve"]
        for index in range(tickets):
            lines.append(
                f"- 30.08.26 00:00 [E-{index + 2:04d}] [parent: E-{index + 1:04d}] "
                f"[agent: tester] DEC: goal_tickets {index}->{index + 1}"
            )
        (root / ".saipen" / "LOG.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

        (root / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: SHIP\n"
            "task: T-001\n"
            f'next_action: "{next_action}"\n'
            "blocker: none\n"
            "transition_from: REVIEW\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            f"last_event: {tickets + 1}\n"
            "style_contract: ded-4ae736e4\n"
            "agent: tester\n"
            "requires:\n  - filesystem\n  - git\n  - python\n"
            "mode: full\n"
            "updated: 2026-08-30T00:00:00Z\n"
            "execution_intent: goal\n"
            "goal_waves: 0\n"
            f"goal_tickets: {tickets}\n"
            "---\n",
            encoding="utf-8",
        )
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-001 [P1] fix | verify: test\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        return root

    def test_agreeing_counters_at_the_cap_are_not_clean(self):
        root = self._make_project(20, "PHASE SHIP T-001")
        result = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertNotEqual(result["code"], "CLEAN", result)
        self.assertEqual(result["code"], "RECONCILE_REAUTH_REQUIRED", result)
        self.assertIn("next_action", result["detail"])

    def test_the_refusal_writes_nothing(self):
        root = self._make_project(20, "PHASE SHIP T-001")
        before = (root / ".saipen" / "STATE.md").read_bytes()
        reconcile_protocol_state(root, "tester", dry_run=False)
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)

    def test_a_state_already_paused_at_the_cap_is_clean(self):
        root = self._make_project(20, WAIT_FORM)
        result = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(result["code"], "CLEAN", result)

    def test_a_run_below_the_cap_is_clean(self):
        root = self._make_project(19, "PHASE SHIP T-001")
        result = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(result["code"], "CLEAN", result)


def _event(number: int, op_id: str, text: str) -> dict:
    return {"event": number, "op_id": op_id, "text": text, "taxonomy": "RUN"}


class InvalidPhaseRepairTests(unittest.TestCase):
    """T-1318: an out-of-enum phase has an owner and is repaired from PROOF.

    The deadlock this closes: `phase: IMPL` had no owner anywhere. Every strict
    reader refused the checkpoint, the guard refused generic shell with
    PROTOCOL_STATE_INVALID, and the canonical namespace -- the only surface
    allowed to write STATE.md -- refused the operation that could repair it. A
    KNOWN ROOT with invalid protocol state therefore had no legal action at all.
    """

    def test_a_legal_phase_owns_no_repair(self):
        self.assertEqual(
            _state_phase_repairs({"phase": "BUILD", "transition_from": "SCOUT"}, []), []
        )

    def test_the_proven_pair_replaces_the_illegal_one(self):
        events = [
            _event(1, "transition-" + "a" * 32, "transition to SCOUT"),
            _event(2, _TRANSITION_OP, "transition to BUILD"),
        ]
        repairs = _state_phase_repairs(
            {"phase": "IMPL", "transition_from": "DONE", "last_event": 2}, events
        )
        self.assertEqual([r["field"] for r in repairs], ["phase", "transition_from"], repairs)
        self.assertFalse(any(r.get("blocked") for r in repairs))
        self.assertEqual((repairs[0]["from"], repairs[0]["to"]), ("IMPL", "BUILD"))
        self.assertEqual((repairs[1]["from"], repairs[1]["to"]), ("DONE", "SCOUT"))

    def test_the_newest_provable_event_wins_and_last_event_bounds_it(self):
        events = [
            _event(1, "transition-" + "a" * 32, "transition to SCOUT"),
            _event(2, "transition-" + "b" * 32, "transition to BUILD"),
        ]
        state = {"phase": "IMPL", "transition_from": "DONE", "last_event": 2}
        self.assertEqual(_state_phase_repairs(state, events)[0]["to"], "BUILD")
        state["last_event"] = 1
        self.assertEqual(_state_phase_repairs(state, events)[0]["to"], "SCOUT")

    def test_a_lone_transition_event_cannot_prove_the_source(self):
        """The LOG records destinations; a source needs the PREVIOUS destination.

        `transition from DONE to BUILD` is outside the DFA, so a single event
        with that pair must refuse rather than assert a source nobody recorded.
        """
        events = [_event(1, _TRANSITION_OP, "transition to BUILD")]
        repairs = _state_phase_repairs(
            {"phase": "IMPL", "transition_from": "DONE", "last_event": 1}, events
        )
        self.assertTrue(repairs[0]["blocked"], repairs)

    def test_no_proof_blocks_instead_of_inventing_a_phase(self):
        repairs = _state_phase_repairs({"phase": "IMPL", "transition_from": "DONE"}, [])
        self.assertTrue(repairs[0]["blocked"])
        self.assertIsNone(repairs[0]["to"])
        self.assertIn("no legal", repairs[0]["reason"])

    def test_an_illegal_destination_event_proves_nothing(self):
        events = [_event(1, _TRANSITION_OP, "transition to IMPL")]
        repairs = _state_phase_repairs({"phase": "IMPL", "transition_from": "DONE"}, events)
        self.assertTrue(repairs[0]["blocked"])

    def test_non_transition_events_are_not_phase_evidence(self):
        events = [_event(1, "claim-" + "c" * 32, "claim via SAIOPS -- owner tester")]
        repairs = _state_phase_repairs({"phase": "IMPL", "transition_from": "DONE"}, events)
        self.assertTrue(repairs[0]["blocked"])

    def test_an_illegal_transition_from_blocks(self):
        events = [_event(1, _TRANSITION_OP, "transition to BUILD")]
        repairs = _state_phase_repairs({"phase": "BUILD", "transition_from": "WAT"}, events)
        self.assertEqual(len(repairs), 1)
        self.assertTrue(repairs[0]["blocked"], repairs)
        self.assertIn("WAT", repairs[0]["reason"])

    def test_an_unreachable_pair_blocks(self):
        # Derived, not hard-coded: pick a destination the DFA refuses from SCOUT
        # and that is not enterable from any phase. A hand-copied row would go
        # stale the moment the table changes.
        target = next(
            name
            for name in sorted(phases.ALL_PHASES)
            if name not in phases.ANY_FROM and not phases.transition_legal("SCOUT", name)
        )
        events = [_event(1, _TRANSITION_OP, f"transition to {target}")]
        repairs = _state_phase_repairs(
            {"phase": "IMPL", "transition_from": "SCOUT"}, events
        )
        self.assertTrue(repairs[0]["blocked"], repairs)


_T1318_LOG = (
    "# Log\n"
    "- 13.09.26 00:00 [E-0001] [agent: tester] "
    f"[op: transition-{'a' * 32}] RUN: transition to SCOUT\n"
    "- 13.09.26 00:01 [E-0002] [parent: E-0001] [T-001] [agent: tester] "
    f"[op: {_TRANSITION_OP}] RUN: transition to BUILD\n"
)

SAIPEN_CLI = Path(__file__).resolve().parent / "saipen.py"


def _t1318_project(phase: str = "IMPL", transition_from: str = "DONE") -> Path:
    """The FastPrompter shape on a real tree: recoverable out-of-enum phase."""
    root = Path(tempfile.mkdtemp(prefix="t1318-phase-"))
    (root / ".saipen").mkdir(parents=True)
    (root / ".saipen" / "LOG.md").write_text(_T1318_LOG, encoding="utf-8")
    (root / ".saipen" / "STATE.md").write_text(
        "---\n"
        f"phase: {phase}\n"
        "task: T-001\n"
        'next_action: "PHASE BUILD T-001"\n'
        "blocker: none\n"
        f"transition_from: {transition_from}\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        "last_event: 2\n"
        "style_contract: ded-4ae736e4\n"
        "agent: tester\n"
        "mode: full\n"
        "updated: 2026-09-13T00:00:00Z\n"
        "execution_intent: normal\n"
        "---\n",
        encoding="utf-8",
    )
    (root / ".saipen" / "BOARD.md").write_text(
        "## DOING\n- [/] T-001 [P1] fix | verify: test\n## TODO\n## DONE\n## BLOCKED\n",
        encoding="utf-8",
    )
    return root


class InvalidPhaseEndToEndTests(unittest.TestCase):
    """The FastPrompter shape through the real entry point, on a real tree."""

    def _make_project(
        self, phase: str = "IMPL", transition_from: str = "DONE"
    ) -> Path:
        root = _t1318_project(phase, transition_from)
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        return root

    def test_a_legal_pair_is_left_alone(self):
        root = self._make_project(phase="BUILD", transition_from="SCOUT")
        before = (root / ".saipen" / "STATE.md").read_bytes()
        result = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(result["code"], "CLEAN", result)
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)

    def test_the_repair_restores_a_valid_phase_and_journals_the_drift(self):
        root = self._make_project()
        result = reconcile_protocol_state(root, "tester", dry_run=False)
        self.assertTrue(result["ok"], result)
        state = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertIn("phase: BUILD", state)
        self.assertNotIn("IMPL", state)
        log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        # The DEC names BOTH the original and the replacement (T-1318 AC-02).
        self.assertIn("phase 'IMPL'->'BUILD'", log)

    def test_the_repaired_project_is_readable_afterwards(self):
        root = self._make_project()
        self.assertTrue(reconcile_protocol_state(root, "tester")["ok"])
        from saipen_engine.state import parse_state_or_error

        state, error = parse_state_or_error(
            (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        )
        self.assertEqual(error, None)
        self.assertEqual(state["phase"], "BUILD")

    def test_an_unprovable_phase_refuses_with_zero_writes(self):
        root = self._make_project()
        (root / ".saipen" / "LOG.md").write_text(
            "# Log\n- 13.09.26 00:00 [E-0001] [agent: tester] RUN: checkpoint SCOUT\n",
            encoding="utf-8",
        )
        (root / ".saipen" / "STATE.md").write_text(
            (root / ".saipen" / "STATE.md").read_text(encoding="utf-8").replace(
                "last_event: 2", "last_event: 1"
            ),
            encoding="utf-8",
        )
        before = {
            name: (root / ".saipen" / name).read_bytes()
            for name in ("STATE.md", "BOARD.md", "LOG.md")
        }
        result = reconcile_protocol_state(root, "tester", dry_run=False)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "VALIDATION_FAILED")
        for name, raw in before.items():
            self.assertEqual((root / ".saipen" / name).read_bytes(), raw, name)

    def test_an_unknown_illegal_token_is_not_special_cased(self):
        """`IMPL` is the observed example, never the rule."""
        for token in ("IMPL", "WAT", "BUILDING"):
            with self.subTest(token=token):
                root = self._make_project(phase=token)
                self.assertTrue(reconcile_protocol_state(root, "tester")["ok"])
                state = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
                self.assertIn("phase: BUILD\n", state)

    def test_the_original_bytes_are_preserved_byte_for_byte(self):
        root = self._make_project()
        original = (root / ".saipen" / "STATE.md").read_bytes()
        result = reconcile_protocol_state(root, "tester")
        self.assertTrue(result["ok"], result)
        artifacts = sorted((root / ".saipen" / "recovery").rglob("*.STATE.md"))
        self.assertEqual(len(artifacts), 1, artifacts)
        self.assertEqual(artifacts[0].read_bytes(), original)
        self.assertIn("phase: IMPL", original.decode("utf-8"))
        # The DEC names BOTH sides and the evidence path is reported.
        log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertIn("phase 'IMPL'->'BUILD'", log)
        self.assertEqual(
            result["targets"][:2], [".saipen/LOG.md", ".saipen/STATE.md"], result["targets"]
        )
        evidence = result["targets"][2]
        self.assertTrue(evidence.startswith(".saipen/recovery/state-phase/"), evidence)
        self.assertTrue(evidence.endswith(".STATE.md"), evidence)
        self.assertNotIn(".saipen/BOARD.md", result["targets"])

    def test_a_second_recovery_is_a_noop_with_no_second_artifact(self):
        root = self._make_project()
        self.assertTrue(reconcile_protocol_state(root, "tester")["ok"])
        state_after = (root / ".saipen" / "STATE.md").read_bytes()
        again = reconcile_protocol_state(root, "tester")
        self.assertEqual(again["code"], "CLEAN", again)
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), state_after)
        self.assertEqual(
            len(sorted((root / ".saipen" / "recovery").rglob("*.STATE.md"))), 1
        )

    def test_the_preserved_copy_is_never_edited_afterwards(self):
        root = self._make_project()
        self.assertTrue(reconcile_protocol_state(root, "tester")["ok"])
        artifact = next((root / ".saipen" / "recovery").rglob("*.STATE.md"))
        preserved = artifact.read_bytes()
        # A LATER, unrelated reconciliation must not touch the forensic copy.
        state_path = root / ".saipen" / "STATE.md"
        state_path.write_text(
            state_path.read_text(encoding="utf-8").replace("last_event: 3", "last_event: 1"),
            encoding="utf-8",
        )
        reconcile_protocol_state(root, "tester")
        self.assertEqual(artifact.read_bytes(), preserved)

    def test_a_contradictory_board_does_not_hold_the_phase_repair_hostage(self):
        """T-1382: a repair is judged on its DELTA, not on what it walked into.

        This control used to assert the opposite -- that a dangling `needs:`
        edge refuses the whole reconciliation with zero writes. That rule is
        what made a set of repairs mutually unreachable: the phase repair is
        derived from the LOG's own transition chain and has nothing to do with
        the BOARD graph, while the BOARD defect's own owner needs a readable
        STATE. Each refused over the other's damage and neither ever ran.

        What must still hold, and is asserted below: the inherited defect is
        not laundered. The surface this repair does not own is untouched, the
        defect stays reported, and the project does NOT reach CLEAN.
        """
        root = self._make_project()
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-001 [P1] fix | verify: test | needs: T-999\n"
            "## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        board_before = (root / ".saipen" / "BOARD.md").read_bytes()

        result = reconcile_protocol_state(root, "tester", dry_run=False)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "REPAIRED", result)
        self.assertEqual(
            [repair["field"] for repair in result["changed"]["state"]],
            ["phase", "transition_from"],
            result,
        )
        # The surface it does not own is not touched.
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), board_before)

        # And the damage it inherited is not laundered: still reported, and the
        # project does NOT reach CLEAN on the strength of a partial repair.
        after = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertNotEqual(after.get("code"), "CLEAN", after)
        self.assertTrue(
            any("T-999" in str(item) for item in after.get("residual_defects") or []),
            after,
        )


class InvalidPhaseCrashConvergenceTests(unittest.TestCase):
    """T-1318 Phase H: a REAL crash either side of APPLY must converge.

    The mutation is interrupted for real -- the canonical CLI runs in a child
    process that dies with `NITRO_CRASH_AFTER_<stage>` set by the journal
    engine itself -- so these are genuine partial mutations, never simulated
    ones. Convergence must be deterministic, must never duplicate the phase
    repair, and must never rewrite the forensic copy.
    """

    def _project(self) -> Path:
        root = _t1318_project()
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        return root

    def _state(self, root: Path) -> str:
        return (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")

    def _artifacts(self, root: Path) -> list[Path]:
        return sorted((root / ".saipen" / "recovery").rglob("*.STATE.md"))

    def _recover(self, root: Path, **env_overrides) -> subprocess.CompletedProcess:
        env = {**os.environ, **env_overrides}
        env.pop("PWD", None)
        env.pop("OLDPWD", None)
        return subprocess.run(
            [sys.executable, str(SAIPEN_CLI), "recover"],
            cwd=str(root), capture_output=True, text=True, env=env, timeout=600,
        )

    def test_a_crash_before_apply_keeps_the_original_state_and_converges(self):
        root = self._project()
        original = (root / ".saipen" / "STATE.md").read_bytes()
        crashed = self._recover(root, NITRO_CRASH_AFTER_PREPARE="1")
        self.assertNotEqual(crashed.returncode, 0, crashed.stdout + crashed.stderr)
        # Nothing was applied: the invalid phase is still the authoritative
        # state, and no half-written artifact became accepted truth.
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), original)
        self.assertIn("phase: IMPL", self._state(root))
        # Canonical recovery reaches the same repair from the partial journal:
        # the replay of the PREPARED operation settles it (`RECOVERED`), and if
        # it only aborts, the ordinary reconciliation still repairs (`REPAIRED`).
        healed = self._recover(root)
        self.assertIn(
            (healed.stdout + healed.stderr).strip().splitlines()[0],
            {"code: RECOVERED", "code: REPAIRED"},
            healed.stdout + healed.stderr,
        )
        self.assertIn("phase: BUILD", self._state(root))
        self.assertEqual(len(self._artifacts(root)), 1, self._artifacts(root))

    def test_a_legal_state_is_a_clean_zero_write_noop_at_the_cli(self):
        """Phase I: `CLEAN` is the documented idempotent no-op contract.

        A legal checkpoint must be provably distinguishable from `REPAIRED`
        and from a refusal: no canonical byte changes, no forensic artifact,
        no new recovery DEC.
        """
        root = Path(tempfile.mkdtemp(prefix="t1318-legal-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        legal = _t1318_project(phase="BUILD", transition_from="SCOUT")
        shutil.move(str(legal / ".saipen"), str(root / ".saipen"))
        shutil.rmtree(legal, ignore_errors=True)

        # Settle the one-time audit-manifest enrollment first: it writes only
        # `.saipen/MANIFEST.json`, so the canonical STATE/BOARD/LOG bytes below
        # are untouched, and only THEN may CLEAN mean a zero-write no-op
        # (T-1340: a mutating enrollment is never reported as CLEAN).
        enrolled = self._recover(root)
        self.assertEqual(enrolled.returncode, 0, enrolled.stdout + enrolled.stderr)
        before = {
            name: (root / ".saipen" / name).read_bytes()
            for name in ("STATE.md", "BOARD.md", "LOG.md")
        }
        result = self._recover(root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        first = (result.stdout + result.stderr).strip().splitlines()[0]
        self.assertEqual(first, "code: CLEAN", result.stdout + result.stderr)
        for name, raw in before.items():
            self.assertEqual((root / ".saipen" / name).read_bytes(), raw, name)
        self.assertEqual(self._artifacts(root), [])
        self.assertNotIn(
            "phase 'IMPL'->'BUILD'",
            (root / ".saipen" / "LOG.md").read_text(encoding="utf-8"),
        )

    def test_a_crash_after_apply_converges_without_duplicating_the_repair(self):
        root = self._project()
        original = (root / ".saipen" / "STATE.md").read_bytes()
        crashed = self._recover(root, NITRO_CRASH_AFTER_STATE="1")
        self.assertNotEqual(crashed.returncode, 0, crashed.stdout + crashed.stderr)
        # The phase write already happened; the journal was never settled.
        self.assertIn("phase: BUILD", self._state(root))
        healed = self._recover(root)
        self.assertEqual(healed.returncode, 0, healed.stdout + healed.stderr)
        self.assertIn("phase: BUILD", self._state(root))
        # Exactly ONE repair is recorded and at most one forensic copy exists;
        # if it exists it still holds the exact pre-repair bytes.
        log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertEqual(log.count("phase 'IMPL'->'BUILD'"), 1, log)
        artifacts = self._artifacts(root)
        self.assertLessEqual(len(artifacts), 1, artifacts)
        if artifacts:
            self.assertEqual(artifacts[0].read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
