"""Regressions for the 2026-08-29 implementation of SAIPEN__00_AUDIT_ALL_3.

Each test class pins one audit ticket's acceptance criterion against the live
implementation, ordered by the handoff's own dependency notes.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_control_primitives import ControlFixture  # noqa: E402

from saipen_engine import fast_check, journal  # noqa: E402
from saipen_engine.reconcile import reconcile_protocol_state  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


def _tree_bytes(root: Path) -> dict[str, bytes]:
    """Every byte under the project's `.saipen` surface, for zero-write proofs."""
    out: dict[str, bytes] = {}
    base = root / ".saipen"
    for path in sorted(base.rglob("*")):
        if path.is_file():
            out[str(path.relative_to(root)).replace("\\", "/")] = path.read_bytes()
    return out


class Core002ReconciliationTests(ControlFixture):
    def _patch_state(self, root: Path, field: str, value: str) -> None:
        text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        lines = text.split("\n")
        for idx, line in enumerate(lines):
            if line.startswith(f"{field}: "):
                lines[idx] = f"{field}: {value}"
                break
        else:
            raise AssertionError(f"field {field} not present in fixture STATE")
        (root / ".saipen" / "STATE.md").write_text("\n".join(lines), encoding="utf-8")

    def _state_field(self, root: Path, field: str) -> str:
        for line in (root / ".saipen" / "STATE.md").read_text(encoding="utf-8").splitlines():
            if line.startswith(f"{field}: "):
                return line[len(field) + 2 :].strip()
        raise AssertionError(f"field {field} missing after repair")

    def _append_events(self, root: Path, texts: list[str]) -> int:
        """Append well-formed `DEC:` events, returning the new LOG tail."""
        log = root / ".saipen" / "LOG.md"
        lines = [ln for ln in log.read_text(encoding="utf-8").splitlines() if ln.strip()]
        tail = 0
        for line in lines:
            found = re.search(r"\[E-(\d+)\]", line)
            if found:
                tail = max(tail, int(found.group(1)))
        parent = f"E-{tail:03d}"
        for text in texts:
            tail += 1
            lines.append(
                f"- 24.08.26 00:{tail:02d} [E-{tail:03d}] [parent: {parent}] "
                f"[T-none] DEC: {text}"
            )
            parent = f"E-{tail:03d}"
        log.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return tail

    def test_corrupt_last_event_is_repaired_from_the_log_tail(self) -> None:
        root = self.make_project()
        self._patch_state(root, "last_event", "2")
        preview = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(preview["code"], "REPAIR_REQUIRED", preview)
        self.assertIn("last_event 2->1", preview["detail"], preview)
        self.assertEqual(preview["targets"][0], ".saipen/LOG.md", preview)
        self.assertIn(".saipen/STATE.md", preview["targets"], preview)

        applied = reconcile_protocol_state(root, "tester")
        self.assertTrue(applied["ok"], applied)
        self.assertEqual(applied["code"], "REPAIRED", applied)
        # The repair appends its own DEC trace, so the tail advances by one.
        self.assertEqual(self._state_field(root, "last_event"), "2")
        self.assertEqual(fast_check.validate_project(root), [])

    def test_clean_surface_reports_clean_and_writes_nothing(self) -> None:
        root = self.make_project()
        manifest = root / ".saipen" / "MANIFEST.json"

        # A dry-run is the zero-write projection, even with no manifest yet.
        before = _tree_bytes(root)
        preview = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(preview["code"], "CLEAN", preview)
        self.assertEqual(_tree_bytes(root), before)
        self.assertFalse(manifest.exists())

        # ABSENT manifest: the mutating lifecycle path enrolls it, and that
        # mutation must be OBSERVABLE -- never reported as CLEAN.
        first = reconcile_protocol_state(root, "tester")
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["code"], "AUDIT_MANIFEST_WRITTEN", first)
        self.assertTrue(first["audit_manifest"]["changed"], first)
        self.assertTrue(manifest.is_file())
        settled = _tree_bytes(root)

        # Only the NEXT steady-state call is CLEAN, and it writes nothing.
        self.assertEqual(reconcile_protocol_state(root, "tester")["code"], "CLEAN")
        self.assertEqual(_tree_bytes(root), settled)

        # STALE manifest: rewritten, and again the upgrade is observable.
        manifest.write_text(
            '{"kind": "saipen_audit_manifest", "contract_version": 0}\n',
            encoding="utf-8",
        )
        stale = reconcile_protocol_state(root, "tester")
        self.assertTrue(stale["ok"], stale)
        self.assertEqual(stale["code"], "AUDIT_MANIFEST_UPGRADED", stale)
        self.assertTrue(stale["audit_manifest"]["changed"], stale)
        upgraded = _tree_bytes(root)
        self.assertEqual(reconcile_protocol_state(root, "tester")["code"], "CLEAN")
        self.assertEqual(_tree_bytes(root), upgraded)

    def test_dry_run_writes_zero_bytes_while_reporting_the_real_plan(self) -> None:
        root = self.make_project()
        self._patch_state(root, "last_event", "9")
        board = root / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## DONE\n", "## DONE\n- [ ] T-8 [P1] drifted | verify: fixture\n", 1
            ),
            encoding="utf-8",
        )
        before = _tree_bytes(root)
        preview = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(preview["code"], "REPAIR_REQUIRED", preview)
        self.assertEqual(_tree_bytes(root), before)
        surfaces = {entry["field"] for entry in preview["changed"]["state"]}
        self.assertEqual(surfaces, {"last_event"}, preview)
        self.assertEqual(len(preview["changed"]["board"]), 1, preview)

    def test_board_repair_and_state_repair_commit_together(self) -> None:
        root = self.make_project()
        self._patch_state(root, "last_event", "9")
        board = root / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## DONE\n", "## DONE\n- [ ] T-8 [P1] drifted | verify: fixture\n", 1
            ),
            encoding="utf-8",
        )
        applied = reconcile_protocol_state(root, "tester")
        self.assertTrue(applied["ok"], applied)
        self.assertEqual(applied["code"], "REPAIRED", applied)
        self.assertIn(".saipen/BOARD.md", applied["targets"], applied)
        self.assertIn("- [x] T-8", (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        self.assertEqual(fast_check.validate_project(root), [])
        # One journaled transaction, fully settled: nothing left pending.
        self.assertEqual(journal.pending_ops(root), [], )

    def test_goal_counters_behind_the_log_are_repaired_upward(self) -> None:
        """A bump that reached the LOG and never reached STATE is the crash
        signature section 1.5's write order guarantees -- repair it upward.

        The rebuilt count is the number of INCREMENTS SINCE THE NEWEST MARKER,
        not the `to` value of the last bump line: 1 wave and 3 tickets after
        the pivot, whatever the intermediate `N->M` values were.
        """
        root = self.make_project(intent="goal")
        tail = self._append_events(
            root,
            [
                "goal pivot -- fixture run",
                "goal_waves 0->1",
                "goal_tickets 0->1",
                "goal_tickets 1->2",
                "goal_tickets 2->3",
            ],
        )
        self._patch_state(root, "last_event", str(tail))
        self._patch_state(root, "goal_waves", "0")
        self._patch_state(root, "goal_tickets", "1")
        preview = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(preview["code"], "REPAIR_REQUIRED", preview)
        fields = {entry["field"]: entry["to"] for entry in preview["changed"]["state"]}
        self.assertEqual(fields.get("goal_waves"), 1, preview)
        self.assertEqual(fields.get("goal_tickets"), 3, preview)
        applied = reconcile_protocol_state(root, "tester")
        self.assertTrue(applied["ok"], applied)
        self.assertEqual(self._state_field(root, "goal_waves"), "1")
        self.assertEqual(self._state_field(root, "goal_tickets"), "3")
        self.assertEqual(fast_check.validate_project(root), [])

    def test_tripped_valve_counter_is_never_tidied_down(self) -> None:
        """Section 2.4 + CORE-001 (audit-all3): an at/over-cap counter while
        canonical history is lower is the tripped safety valve.

        Reconciliation MUST NOT silently CLEAN it, and MUST NOT auto-repair
        it downward. The disposition is an explicit
        ``RECONCILE_REAUTH_REQUIRED`` that the human reauthorization path
        clears.
        """
        root = self.make_project(intent="goal")
        tail = self._append_events(
            root,
            [
                "goal pivot -- fixture run",
                "goal_waves 0->1",
                "goal_tickets 0->1",
                "goal_tickets 1->2",
                "goal_tickets 2->3",
                "goal_tickets 3->4",
            ],
        )
        self._patch_state(root, "last_event", str(tail))
        self._patch_state(root, "goal_waves", "3")
        self._patch_state(root, "goal_tickets", "4")
        before = _tree_bytes(root)
        result = reconcile_protocol_state(root, "tester", dry_run=True)
        # CORE-001: never CLEAN while the valve is still tripped without
        # reauthorization; never auto-repair downward to hide the trip.
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "RECONCILE_REAUTH_REQUIRED", result)
        self.assertTrue(result.get("refused"), result)
        # No bytes written and no auto-repair applied.
        self.assertEqual(_tree_bytes(root), before)
        self.assertEqual(self._state_field(root, "goal_waves"), "3")
        self.assertEqual(self._state_field(root, "goal_tickets"), "4")

    def test_ahead_under_cap_counter_reconciles_downward(self) -> None:
        """CORE-001 (audit-all3): an ahead counter UNDER the cap is reconciled
        downward to canonical evidence (no silent laundering)."""
        root = self.make_project(intent="goal")
        tail = self._append_events(
            root,
            [
                "goal pivot -- fixture run",
                "goal_waves 0->1",
                "goal_tickets 0->1",
            ],
        )
        self._patch_state(root, "last_event", str(tail))
        self._patch_state(root, "goal_waves", "1")
        self._patch_state(root, "goal_tickets", "1")
        # Force STATE ahead of derived (derived=1/1, state=2/2)
        self._patch_state(root, "goal_waves", "2")
        self._patch_state(root, "goal_tickets", "2")
        preview = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(preview["code"], "REPAIR_REQUIRED", preview)
        fields = {entry["field"]: entry["to"] for entry in preview["changed"]["state"]}
        self.assertEqual(fields.get("goal_waves"), 1, preview)
        self.assertEqual(fields.get("goal_tickets"), 1, preview)
        applied = reconcile_protocol_state(root, "tester")
        self.assertTrue(applied["ok"], applied)
        self.assertEqual(self._state_field(root, "goal_waves"), "1")
        self.assertEqual(self._state_field(root, "goal_tickets"), "1")
        self.assertEqual(fast_check.validate_project(root), [])

    def test_reauthorization_clears_the_rebuild_window(self) -> None:
        """A `DEC: goal reauthorized` marker resets the count (CORE 1.5).

        Counting from the pivot alone would rebuild every bump the re-
        authorization already cancelled and hand the run back a tripped valve
        the human cleared.
        """
        root = self.make_project(intent="goal")
        tail = self._append_events(
            root,
            [
                "goal pivot -- fixture run",
                "goal_waves 0->1",
                "goal_tickets 0->1",
                "goal_tickets 1->2",
                "goal_tickets 2->3",
                "goal_tickets 3->4",
                "goal reauthorized -- goal_waves 3->0, goal_tickets 4->0",
            ],
        )
        self._patch_state(root, "last_event", str(tail))
        self._patch_state(root, "goal_waves", "0")
        self._patch_state(root, "goal_tickets", "0")
        # Settle the one-time audit-manifest enrollment first: this test owns
        # the reauthorization rebuild window, not the lifecycle migration.
        reconcile_protocol_state(root, "tester")
        before = _tree_bytes(root)
        result = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(result["code"], "CLEAN", result)
        self.assertEqual(reconcile_protocol_state(root, "tester")["code"], "CLEAN")
        self.assertEqual(_tree_bytes(root), before)

    def test_a_lost_bump_survives_a_sealed_marker(self) -> None:
        """The pivot may be sealed away; the count must still rebuild (1.5)."""
        root = self.make_project(intent="goal")
        tail = self._append_events(
            root, ["goal pivot -- fixture run", "goal_tickets 0->1", "goal_tickets 1->2"]
        )
        self._patch_state(root, "last_event", str(tail))
        self._patch_state(root, "goal_waves", "0")
        self._patch_state(root, "goal_tickets", "0")
        preview = reconcile_protocol_state(root, "tester", dry_run=True)
        fields = {entry["field"]: entry["to"] for entry in preview["changed"]["state"]}
        self.assertEqual(fields.get("goal_tickets"), 2, preview)
        self.assertNotIn("goal_waves", fields, preview)

    def test_absent_counters_under_goal_intent_are_repaired_to_zero(self) -> None:
        root = self.make_project(intent="goal")
        text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        text = text.replace("goal_waves: 1\n", "").replace("goal_tickets: 0\n", "")
        (root / ".saipen" / "STATE.md").write_text(text, encoding="utf-8")
        applied = reconcile_protocol_state(root, "tester")
        self.assertTrue(applied["ok"], applied)
        self.assertEqual(self._state_field(root, "goal_waves"), "0")
        self.assertEqual(self._state_field(root, "goal_tickets"), "0")

    def test_no_board_only_path_certifies_clean_while_state_is_red(self) -> None:
        """The defect: a STATE-only drift must never be reported CLEAN."""
        root = self.make_project()
        self._patch_state(root, "last_event", "2")
        preview = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertNotEqual(preview["code"], "CLEAN", preview)
        self.assertTrue(preview["changed"]["state"], preview)
        # A board-only drift is repaired without claiming the STATE is fine
        # when it is not: both surfaces appear in one plan.
        board = root / ".saipen" / "BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## DONE\n", "## DONE\n- [ ] T-8 [P1] drifted | verify: fixture\n", 1
            ),
            encoding="utf-8",
        )
        combined = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertTrue(combined["changed"]["state"], combined)
        self.assertTrue(combined["changed"]["board"], combined)

    def test_damage_outside_the_owned_surface_is_refused_not_certified(self) -> None:
        """Damage reconciliation does NOT own must never be laundered as CLEAN.

        The tolerant read exists so a STATE this operation CAN repair is
        reachable at all. It must not become a general amnesty: a STATE that
        is unparseable for an unrelated reason has no repair set here, and the
        one thing that must never happen is reporting CLEAN over it.
        """
        root = self.make_project()
        self._patch_state(root, "phase", "BANANA")
        before = _tree_bytes(root)
        result = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "VALIDATION_FAILED", result)
        self.assertIn("phase", result["detail"], result)
        self.assertTrue(result["strict_state_error"], result)
        # Refusal is read-only: not one byte written, dry-run or not.
        self.assertEqual(_tree_bytes(root), before)
        self.assertFalse(reconcile_protocol_state(root, "tester")["ok"])

    def test_interrupted_reconciliation_is_settled_by_ordinary_recovery(self) -> None:
        root = self.make_project()
        self._patch_state(root, "last_event", "9")
        script = (
            "import sys; sys.path.insert(0, r'{tools}');"
            "from saipen_engine.reconcile import reconcile_protocol_state;"
            "print(reconcile_protocol_state(r'{root}', 'tester').get('code'))"
        ).format(tools=TOOLS, root=root)
        env = dict(os.environ, NITRO_CRASH_AFTER_LOG="1")
        proc = subprocess.run(
            [sys.executable, "-B", "-c", script],
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertTrue(journal.pending_ops(root), "crash must leave a resumable op")

        recovered = journal.auto_recover_pending(root)
        self.assertTrue(recovered.get("ok"), recovered)
        self.assertEqual(journal.pending_ops(root), [])
        self.assertEqual(fast_check.validate_project(root), [])
        # The repair landed as one unit: STATE carries the post-trace tail.
        self.assertEqual(self._state_field(root, "last_event"), "2")


if __name__ == "__main__":
    unittest.main()
