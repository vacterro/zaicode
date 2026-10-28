"""T-1434 M4: strict Improve cycles have a finite, lossless canonical exit.

The anchored RED family first: the incident state -- an active strict cycle
with a stale COMPLETE seat, an un-started draft, and dispositions already in
the sweep ledger -- must have ONE canonical reconciliation owner that
classifies every seat, executes only lossless transitions, refuses while
genuine actionable work remains, and terminalizes with WHY. The suite also
owns the canonical writer for the strict-sweep reasoning-gate linkage
(`saipen ticket reasoning`) and the line-anchored red control 22.
"""

from __future__ import annotations

import json
import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import improve  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


class ReconcileTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1434m4-")
        self.addCleanup(self._tmp.cleanup)

    def _project(self) -> Path:
        root = Path(self._tmp.name).resolve() / "project"
        saipen = root / ".saipen"
        saipen.mkdir(parents=True)
        (saipen / "LOG.md").write_text(
            "- 20.09.26 00:00 [E-900] [T-none] DEC: base\n", encoding="utf-8"
        )
        (saipen / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (saipen / "STATE.md").write_text(
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
            'blocker: ""\ntransition_from: SHIP\n'
            "saipen_version: 8\nschema_version: 3\n"
            "last_event: 900\nstyle_contract: ded-4ae736e4\n"
            "agent: probe\nmode: full\n"
            "updated: 2026-09-20T00:00:00Z\n---\n",
            encoding="utf-8",
        )
        (saipen / "IDENTITY.md").write_text(
            identity_file_content(new_project_lineage()), encoding="utf-8"
        )
        (root / ".gitignore").write_text(".saipen/\n", encoding="utf-8")
        (root / "src.txt").write_text("source-v1\n", encoding="utf-8")
        _git(root, "init", "-q")
        _git(root, "config", "user.email", "probe@example.invalid")
        _git(root, "config", "user.name", "T-1434 M4 Probe")
        _git(root, "add", ".gitignore", "src.txt")
        _git(root, "add", "-f", ".saipen/IDENTITY.md")
        _git(root, "commit", "-qm", "baseline")
        return root

    def _cycle(self, root: Path, name: str = "imp-t1434-20260920-01") -> Path:
        return improve.create_cycle(
            root,
            name,
            created_at="2026-09-20T00:00:00Z",
            project_identity="probe-project",
        )

    @staticmethod
    def _run_text(findings: int, cls: str = "LOGIC_ERROR", action: str = "note") -> str:
        if findings == 0:
            return "NO_FINDINGS\n"
        chunks = []
        for number in range(1, findings + 1):
            chunks.append(
                f"IMP-{number:03d} [P2] [{cls}] [reproduced] [{action}]\n"
                f"expected: finding {number} remains accounted\n"
                f"actual: finding {number} needs a disposition\n"
                f"evidence: T-1434 M4 fixture finding {number}\n"
            )
        return "\n".join(chunks)

    def _add_seat(
        self,
        root: Path,
        cycle: Path,
        seat: str,
        *,
        findings: int = 0,
        cls: str = "LOGIC_ERROR",
        action: str = "note",
        complete: bool = True,
        scope: str = "same bounded audit scope",
        role: str = "core",
    ) -> Path:
        improve.register_seat(cycle, seat, role, "saipen_improve_PROBE.md")
        report = improve.create_report(
            root,
            cycle.name,
            seat,
            "PROBE",
            agent=seat,
            role=role,
            model_or_runtime="probe",
            context_scope=scope,
        )
        improve.append_run(report, self._run_text(findings, cls, action))
        if complete:
            improve.complete_report(report)
        return report

    def _add_idle_seat(self, root: Path, cycle: Path, seat: str) -> Path:
        """One truly un-started draft: registered and minted, ZERO RUNs."""
        improve.register_seat(cycle, seat, "core", "saipen_improve_PROBE.md")
        return improve.create_report(
            root,
            cycle.name,
            seat,
            "PROBE",
            agent=seat,
            role="core",
            model_or_runtime="probe",
            context_scope="same bounded audit scope",
        )

    def _dispose(
        self,
        cycle: Path,
        seat: str,
        finding: int,
        disposition: str = "NOT_REPRODUCED",
        ticket: str = "-",
        reproduced: str = "n",
    ) -> None:
        improve.write_sweep_entry(
            cycle,
            {
                "run": "RUN-1",
                "imp_id": f"IMP-{finding:03d}",
                "disposition": disposition,
                "ticket": ticket,
                "report": f"{seat}/saipen_improve_PROBE.md",
                "reproduced": reproduced,
            },
        )

    def _move_tree(self, root: Path) -> None:
        (root / "src.txt").write_text("source-v2\n", encoding="utf-8")
        _git(root, "add", "src.txt")
        _git(root, "commit", "-qm", "move source identity")

    @staticmethod
    def _add_ticket(root: Path, ticket: str = "T-900") -> None:
        """Fixture ticket WITH its canonical allocation event (CORE-003).

        A BOARD record that merely looks like a ticket is not one; the
        complete history must carry the `[T-###]` allocation, exactly as the
        engine journals it.
        """
        board = root / ".saipen" / "BOARD.md"
        text = board.read_text(encoding="utf-8")
        if ticket in text:
            return
        board.write_text(
            text.replace("## TODO\n", f"## TODO\n- [ ] {ticket} [P1] probe | verify: probe\n"),
            encoding="utf-8",
        )
        event = 900 + int(ticket.split("-")[1]) - 899
        log = root / ".saipen" / "LOG.md"
        log_text = log.read_text(encoding="utf-8").rstrip("\n")
        log.write_text(
            log_text + f"\n- 20.09.26 00:01 [E-{event}] [{ticket}] DEC: ticket added via probe\n",
            encoding="utf-8",
        )
        state = root / ".saipen" / "STATE.md"
        import re as _re

        state.write_text(
            _re.sub(
                r"(?m)^last_event: \d+",
                f"last_event: {event}",
                state.read_text(encoding="utf-8"),
            ),
            encoding="utf-8",
        )

    @staticmethod
    def _cli(root: Path, *argv: str) -> tuple[int, dict, str]:
        result = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "--project-root",
                str(root),
                "--json",
                *argv,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError:
            payload = {}
        return result.returncode, payload, result.stderr or ""

    @staticmethod
    def _validator(root: Path) -> tuple[int, str]:
        result = subprocess.run(
            [sys.executable, str(TOOLS / "validate.py"), "--project-root", str(root)],
            cwd=str(root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        return result.returncode, (result.stdout or "") + (result.stderr or "")

    # ------------------------------------------------------------------
    # 1. all strict seats current COMPLETE -> COMPLETE, idempotent
    # ------------------------------------------------------------------

    def test_01_all_current_complete_terminalizes_and_repeats_clean(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        self._add_seat(root, cycle, "seat-a")
        self._add_seat(root, cycle, "seat-b")
        manifest = cycle / "MANIFEST.md"

        result = improve.reconcile_cycle(cycle)
        self.assertEqual(result["code"], "CYCLE_RECONCILED")
        self.assertEqual(result["outcome"], "COMPLETE")
        self.assertIn("cycle_status: complete", manifest.read_text(encoding="utf-8-sig"))

        before = manifest.read_bytes()
        repeat = improve.reconcile_cycle(cycle)
        self.assertEqual(repeat["code"], "ALREADY_TERMINAL")
        self.assertEqual(repeat["outcome"], "COMPLETE")
        self.assertEqual(manifest.read_bytes(), before)

    # ------------------------------------------------------------------
    # 2 + 3. empty draft retired; cycle terminalized as SUPERSEDED
    # ------------------------------------------------------------------

    def test_02_empty_draft_is_retired_losslessly_and_cycle_superseded(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        self._add_seat(root, cycle, "seat-live")
        draft = self._add_idle_seat(root, cycle, "seat-idle")
        draft_before = draft.read_bytes()
        manifest = cycle / "MANIFEST.md"

        result = improve.reconcile_cycle(cycle)
        self.assertEqual(result["code"], "CYCLE_RECONCILED")
        self.assertEqual(result["outcome"], "SUPERSEDED")
        text = manifest.read_text(encoding="utf-8-sig")
        self.assertIn("cycle_status: superseded", text)
        self.assertIn("availability: unavailable", text)
        self.assertIn("retire_reason: EMPTY_DRAFT", text)
        self.assertEqual(draft.read_bytes(), draft_before)

        before = manifest.read_bytes()
        repeat = improve.reconcile_cycle(cycle)
        self.assertEqual(repeat["code"], "ALREADY_TERMINAL")
        self.assertEqual(repeat["outcome"], "SUPERSEDED")
        self.assertEqual(manifest.read_bytes(), before)

    # ------------------------------------------------------------------
    # 4. stale COMPLETE seat with a fresh replacement -> superseded
    # ------------------------------------------------------------------

    def test_03_stale_complete_supersedes_onto_fresh_replacement(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        stale = self._add_seat(root, cycle, "seat-old", findings=2)
        self._dispose(cycle, "seat-old", 1, "SUPERSEDED")
        self._dispose(cycle, "seat-old", 2, "SUPERSEDED")
        stale_before = stale.read_bytes()
        stale_hash = hashlib.sha256(stale_before).hexdigest()
        sweep_before = (cycle / "SWEEP.md").read_bytes()
        self._move_tree(root)
        fresh = self._add_seat(root, cycle, "seat-new")
        fresh_before = fresh.read_bytes()

        result = improve.reconcile_cycle(cycle)
        self.assertEqual(result["code"], "CYCLE_RECONCILED")
        self.assertEqual(result["outcome"], "COMPLETE")
        manifest = (cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
        self.assertIn("availability: superseded", manifest)
        self.assertIn("replacement_seat: seat-new", manifest)
        self.assertIn(f"preserved_report_sha256: {stale_hash}", manifest)
        self.assertEqual(stale.read_bytes(), stale_before)
        self.assertEqual(fresh.read_bytes(), fresh_before)
        self.assertEqual((cycle / "SWEEP.md").read_bytes(), sweep_before)

    # ------------------------------------------------------------------
    # 5. stale COMPLETE without a current replacement refuses, zero writes
    # ------------------------------------------------------------------

    def test_04_stale_complete_without_replacement_refuses_without_writes(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        stale = self._add_seat(root, cycle, "seat-old", findings=1)
        self._dispose(cycle, "seat-old", 1, "SUPERSEDED")
        self._move_tree(root)
        manifest_before = (cycle / "MANIFEST.md").read_bytes()
        stale_before = stale.read_bytes()
        with self.assertRaisesRegex(improve.ImproveError, "replacement"):
            improve.reconcile_cycle(cycle)
        self.assertEqual((cycle / "MANIFEST.md").read_bytes(), manifest_before)
        self.assertEqual(stale.read_bytes(), stale_before)

    # ------------------------------------------------------------------
    # 6. committed audit content still in flight -> refuse (STILL_ACTIONABLE)
    # ------------------------------------------------------------------

    def test_05_still_actionable_draft_prevents_terminalization(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        self._add_seat(root, cycle, "seat-live")
        draft = self._add_seat(root, cycle, "seat-running", findings=1, complete=False)
        draft_before = draft.read_bytes()
        manifest_before = (cycle / "MANIFEST.md").read_bytes()
        with self.assertRaisesRegex(improve.ImproveError, "actionable"):
            improve.reconcile_cycle(cycle)
        self.assertEqual((cycle / "MANIFEST.md").read_bytes(), manifest_before)
        self.assertEqual(draft.read_bytes(), draft_before)

    # ------------------------------------------------------------------
    # 7. legal early abort still works before any disposition
    # ------------------------------------------------------------------

    def test_06_early_abort_still_legal_before_dispositions(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        draft = self._add_seat(root, cycle, "seat-idle", findings=1, complete=False)
        draft_before = draft.read_bytes()
        result = improve.abort_cycle(cycle)
        self.assertTrue(result["ok"])
        self.assertEqual(draft.read_bytes(), draft_before)
        text = (cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
        self.assertIn("cycle_status: archived", text)
        self.assertIn("cycle_aborted: draft-preserved", text)

    # ------------------------------------------------------------------
    # 8. post-disposition: abort refuses, reconcile is the finite exit
    # ------------------------------------------------------------------

    def test_07_post_disposition_state_requires_reconciliation_not_abort(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        self._add_seat(root, cycle, "seat-live")
        draft = self._add_idle_seat(root, cycle, "seat-idle")
        (cycle / "SWEEP.md").write_text(
            "# SWEEP\n"
            "- RUN-1/IMP-001 [NOT_REPRODUCED] - "
            "report=seat-live/saipen_improve_PROBE.md reproduced=n\n",
            encoding="utf-8",
        )
        draft_before = draft.read_bytes()
        sweep_before = (cycle / "SWEEP.md").read_bytes()
        with self.assertRaisesRegex(improve.ImproveError, "dispositions"):
            improve.abort_cycle(cycle)
        result = improve.reconcile_cycle(cycle)
        self.assertEqual(result["code"], "CYCLE_RECONCILED")
        self.assertEqual(result["outcome"], "SUPERSEDED")
        self.assertEqual((cycle / "SWEEP.md").read_bytes(), sweep_before)
        self.assertEqual(draft.read_bytes(), draft_before)

    # ------------------------------------------------------------------
    # 9. explicit BLOCKED_EXTERNAL seat -> cycle terminal as blocked_external
    # ------------------------------------------------------------------

    def test_08_blocked_external_seat_terminalizes_cycle(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        self._add_seat(root, cycle, "seat-live")
        blocked = self._add_idle_seat(root, cycle, "seat-waiting")
        blocked_before = blocked.read_bytes()
        improve.retire_seat(cycle, "seat-waiting", "BLOCKED_EXTERNAL")

        result = improve.reconcile_cycle(cycle)
        self.assertEqual(result["code"], "CYCLE_RECONCILED")
        self.assertEqual(result["outcome"], "BLOCKED_EXTERNAL")
        text = (cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
        self.assertIn("cycle_status: blocked_external", text)
        self.assertIn("retire_reason: BLOCKED_EXTERNAL", text)
        self.assertEqual(blocked.read_bytes(), blocked_before)

    # ------------------------------------------------------------------
    # 10. legacy cycles stay sealed history
    # ------------------------------------------------------------------

    def test_09_legacy_cycle_is_refused_read_only(self) -> None:
        root = self._project()
        cycle = root / ".saipen" / "improve" / "imp-legacy-20260801-01"
        cycle.mkdir(parents=True)
        manifest = cycle / "MANIFEST.md"
        manifest.write_text(
            "# IMPROVE CYCLE ROSTER\n\ncycle_status: active\n"
            "seat_id: seat-old\nrole: core\nreport_path: saipen_improve_PROBE.md\n"
            "availability: expected\n",
            encoding="utf-8",
        )
        before = manifest.read_bytes()
        with self.assertRaisesRegex(improve.ImproveError, "legacy|STRICT"):
            improve.reconcile_cycle(cycle)
        self.assertEqual(manifest.read_bytes(), before)

    # ------------------------------------------------------------------
    # 11. ticket reasoning writer is lineage-proof and clears the validator
    # ------------------------------------------------------------------

    def test_10_ticket_reasoning_writer_requires_and_records_strict_linkage(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        self._add_ticket(root, "T-900")
        self._add_ticket(root, "T-901")
        self._add_seat(
            root, cycle, "seat-a", findings=1, cls="PROTOCOL_VIOLATION", action="ticket"
        )
        self._dispose(cycle, "seat-a", 1, "CONFIRMED", ticket="T-900", reproduced="y")

        _rc, output = self._validator(root)
        self.assertIn("sweep-ticket-link", output)
        self.assertIn("saipen ticket reasoning T-900", output)

        rc, payload, _stderr = self._cli(
            root,
            "ticket",
            "reasoning",
            "T-901",
            "--recurrence",
            "recurs across projects",
            "--weak-model",
            "a weak model repeats it",
        )
        self.assertNotEqual(rc, 0)
        self.assertEqual(payload.get("code"), "TICKET_REASONING_NOT_LINKED")

        rc, payload, _stderr = self._cli(
            root,
            "ticket",
            "reasoning",
            "T-900",
            "--recurrence",
            "recurs across projects (strict sweep linkage)",
            "--weak-model",
            "a weak compliant model cannot avoid the grammar check",
        )
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload.get("code"), "TICKET_REASONING_WRITTEN")

        rc, payload, _stderr = self._cli(
            root,
            "ticket",
            "reasoning",
            "T-900",
            "--recurrence",
            "recurs across projects (strict sweep linkage)",
            "--weak-model",
            "a weak compliant model cannot avoid the grammar check",
        )
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload.get("code"), "ALREADY_LINKED")

        rc, output = self._validator(root)
        self.assertNotIn("sweep-ticket-link", output)
        del rc

    # ------------------------------------------------------------------
    # 12. red control 22 anchors to real board heading lines
    # ------------------------------------------------------------------

    def test_11_red_control_22_ignores_backticked_prose_citation(self) -> None:
        root = self._project()
        cycle = self._cycle(root, "imp-t1434-20260920-22")
        improve.register_seat(cycle, "seat-a", "core", "saipen_improve_PROBE.md")
        report = improve.create_report(
            root,
            cycle.name,
            "seat-a",
            "PROBE",
            agent="seat-a",
            role="core",
            model_or_runtime="probe",
            context_scope="red control 22 fixture",
        )
        # A pasted BOARD section heading line is the mistreatment red control
        # 22 refuses; a backticked prose citation is evidence, not a board.
        report.write_text(
            report.read_text(encoding="utf-8") + "\n## DOING\n",
            encoding="utf-8",
        )
        rc, output = self._validator(root)
        self.assertNotEqual(rc, 0)
        self.assertIn("carries BOARD section heading", output)

        report.write_text(
            report.read_text(encoding="utf-8").replace("\n## DOING\n", "\n"),
            encoding="utf-8",
        )
        improve.append_run(
            report,
            "IMP-001 [P3] [LOGIC_ERROR] [observed] [note]\n"
            "expected: routed\nactual: routed while `## DOING` was empty\n"
            "evidence: prose citation of the state name\n",
        )
        _rc, output = self._validator(root)
        self.assertNotIn("carries BOARD section heading", output)


    # ------------------------------------------------------------------
    # 13. sealed cycles keep their historical identity when the install moves
    # ------------------------------------------------------------------

    def test_12_sealed_cycle_is_not_compared_to_a_moved_install(self) -> None:
        root = self._project()
        cycle = self._cycle(root)
        self._add_seat(root, cycle, "seat-a")
        improve.reconcile_cycle(cycle)

        installed = improve.installed_protocol_fingerprint(improve._protocol_root_for())
        moved = "sha256:" + "0" * 64
        from unittest.mock import patch

        with patch.object(improve, "installed_protocol_fingerprint", return_value=moved):
            active_errors = improve.validate_bound_report(
                cycle,
                "seat-a",
                (cycle / "seat-a" / "saipen_improve_PROBE.md").read_text(encoding="utf-8"),
                require_runs=True,
                require_fresh=False,
                cycle_active=True,
            )
            sealed_errors = improve.validate_bound_report(
                cycle,
                "seat-a",
                (cycle / "seat-a" / "saipen_improve_PROBE.md").read_text(encoding="utf-8"),
                require_runs=True,
                require_fresh=False,
                cycle_active=False,
            )
        del installed
        self.assertTrue(
            any("protocol_fingerprint" in error for error in active_errors),
            active_errors,
        )
        self.assertFalse(
            any("protocol_fingerprint" in error for error in sealed_errors),
            sealed_errors,
        )
        self.assertEqual(improve.verify_cycle(cycle), [])


if __name__ == "__main__":
    unittest.main()
