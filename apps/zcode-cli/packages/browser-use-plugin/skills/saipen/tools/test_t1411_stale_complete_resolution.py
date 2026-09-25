"""T-1411: stale COMPLETE Improve evidence must have a finite, lossless exit.

The anchored RED is deliberately first.  It proves the incident's four-way
dead end before checking for the canonical resolution owner.  The remaining
tests are dormant on the pre-fix subject and exercise the same verifier after
that owner exists.
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


_RESOLVE = getattr(improve, "resolve_stale_complete_seat", None)
_HAS_RESOLUTION = _RESOLVE is not None
_SKIP = "pre-T-1411 subject has no stale-COMPLETE resolution owner"


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


class StaleCompleteResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1411-")
        self.addCleanup(self._tmp.cleanup)

    def _project(self) -> Path:
        root = Path(self._tmp.name).resolve() / "project"
        saipen = root / ".saipen"
        saipen.mkdir(parents=True)
        (saipen / "LOG.md").write_text(
            "- 19.09.26 00:00 [E-900] [T-none] DEC: base\n", encoding="utf-8"
        )
        (saipen / "BOARD.md").write_text(
            "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )
        (saipen / "STATE.md").write_text(
            '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
            'blocker: ""\ntransition_from: SHIP\n'
            "saipen_version: 8\nschema_version: 3\n"
            "last_event: 900\nstyle_contract: ded-4ae736e4\n"
            'saipen_home: "."\nagent: probe\nmode: full\n'
            "updated: 2026-09-19T00:00:00Z\n---\n",
            encoding="utf-8",
        )
        (saipen / "IDENTITY.md").write_text(
            identity_file_content(new_project_lineage()), encoding="utf-8"
        )
        (root / ".gitignore").write_text(".saipen/\n", encoding="utf-8")
        (root / "src.txt").write_text("source-v1\n", encoding="utf-8")
        _git(root, "init", "-q")
        _git(root, "config", "user.email", "probe@example.invalid")
        _git(root, "config", "user.name", "T-1411 Probe")
        _git(root, "add", ".gitignore", "src.txt")
        _git(root, "add", "-f", ".saipen/IDENTITY.md")
        _git(root, "commit", "-qm", "baseline")
        return root

    @staticmethod
    def _run_text(findings: int) -> str:
        if findings == 0:
            return "NO_FINDINGS\n"
        chunks = []
        for number in range(1, findings + 1):
            chunks.append(
                f"IMP-{number:03d} [P2] [LOGIC_ERROR] [observed] [note]\n"
                f"expected: finding {number} remains accounted\n"
                f"actual: finding {number} needs a disposition\n"
                f"evidence: T-1411 fixture finding {number}\n"
            )
        return "\n".join(chunks)

    def _add_complete_seat(
        self,
        root: Path,
        cycle: Path,
        seat: str,
        *,
        findings: int,
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
        improve.append_run(report, self._run_text(findings))
        improve.complete_report(report)
        return report

    def _dispose(self, cycle: Path, seat: str, finding: int) -> None:
        improve.write_sweep_entry(
            cycle,
            {
                "run": "RUN-1",
                "imp_id": f"IMP-{finding:03d}",
                "disposition": "NOT_REPRODUCED",
                "ticket": "-",
                "report": f"{seat}/saipen_improve_PROBE.md",
                "reproduced": "n",
            },
        )

    def _stale_cycle(
        self,
        *,
        findings: int = 1,
        disposed: tuple[int, ...] = (1,),
        replacement: bool = True,
        replacement_findings: int = 0,
    ) -> tuple[Path, Path, Path, Path | None]:
        root = self._project()
        cycle = improve.create_cycle(
            root,
            "imp-t1411-20260919-01",
            created_at="2026-09-19T00:00:00Z",
            project_identity="probe-project",
        )
        old = self._add_complete_seat(root, cycle, "seat-old", findings=findings)
        for finding in disposed:
            self._dispose(cycle, "seat-old", finding)
        (root / "src.txt").write_text("source-v2\n", encoding="utf-8")
        _git(root, "add", "src.txt")
        _git(root, "commit", "-qm", "move source identity")
        new = None
        if replacement:
            new = self._add_complete_seat(
                root, cycle, "seat-new", findings=replacement_findings
            )
        return root, cycle, old, new

    @staticmethod
    def _add_ticket(root: Path, ticket: str = "T-900") -> None:
        board = root / ".saipen" / "BOARD.md"
        text = board.read_text(encoding="utf-8")
        if ticket in text:
            return
        board.write_text(
            text.replace("## TODO\n", f"## TODO\n- [ ] {ticket} [P1] probe | verify: probe\n"),
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

    def test_00_anchored_dead_end_requires_resolution_owner(self) -> None:
        _root, cycle, old, _new = self._stale_cycle()
        report_before = old.read_bytes()
        sweep_before = (cycle / "SWEEP.md").read_bytes()

        with self.assertRaisesRegex(improve.ImproveError, "source_head|source_tree"):
            improve.complete_cycle(cycle)
        with self.assertRaisesRegex(improve.ImproveError, "sweep.*dispositions"):
            improve.abort_cycle(cycle)
        with self.assertRaisesRegex(improve.ImproveError, "report is complete"):
            improve.retire_seat(cycle, "seat-old", "STALE_COMPLETE")
        with self.assertRaisesRegex(improve.ImproveError, "complete and immutable"):
            improve.append_run(old, "NO_FINDINGS")

        self.assertIn("cycle_status: active", (cycle / "MANIFEST.md").read_text("utf-8"))
        self.assertEqual(old.read_bytes(), report_before)
        self.assertEqual((cycle / "SWEEP.md").read_bytes(), sweep_before)
        self.assertTrue(
            _HAS_RESOLUTION,
            "STALE_COMPLETE_DEAD_END: cycle-complete, abort, retire, and append all refuse; "
            "no canonical stale-COMPLETE resolution owner exists",
        )

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_resolution_preserves_reports_sweep_and_archives(self) -> None:
        _root, cycle, old, new = self._stale_cycle()
        assert new is not None and _RESOLVE is not None
        old_before = old.read_bytes()
        new_before = new.read_bytes()
        sweep_before = (cycle / "SWEEP.md").read_bytes()

        result = _RESOLVE(cycle, "seat-old", "seat-new")

        self.assertEqual(result["code"], "SEAT_SUPERSEDED")
        self.assertEqual(old.read_bytes(), old_before)
        self.assertEqual(new.read_bytes(), new_before)
        self.assertEqual((cycle / "SWEEP.md").read_bytes(), sweep_before)
        manifest = (cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
        self.assertIn("availability: superseded", manifest)
        self.assertIn("resolution: stale-complete", manifest)
        self.assertIn("replacement_seat: seat-new", manifest)
        self.assertIn("preserved_report_sha256:", manifest)
        self.assertEqual(improve.verify_cycle(cycle), [])
        improve.complete_cycle(cycle)
        improve.archive_cycle(cycle)
        self.assertIn(
            "cycle_status: archived", (cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
        )
        self.assertEqual(old.read_bytes(), old_before)
        self.assertEqual((cycle / "SWEEP.md").read_bytes(), sweep_before)

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_zero_findings_can_be_superseded_without_inventing_sweep(self) -> None:
        _root, cycle, old, _new = self._stale_cycle(findings=0, disposed=())
        assert _RESOLVE is not None
        old_before = old.read_bytes()
        self.assertFalse((cycle / "SWEEP.md").exists())
        self.assertEqual(_RESOLVE(cycle, "seat-old", "seat-new")["code"], "SEAT_SUPERSEDED")
        self.assertEqual(old.read_bytes(), old_before)
        self.assertFalse((cycle / "SWEEP.md").exists())
        self.assertEqual(improve.verify_cycle(cycle), [])

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_unswept_and_partially_swept_findings_refuse_without_writes(self) -> None:
        for findings, disposed in ((1, ()), (2, (1,))):
            with self.subTest(findings=findings, disposed=disposed):
                self.tearDown()
                self.setUp()
                _root, cycle, old, _new = self._stale_cycle(
                    findings=findings, disposed=disposed
                )
                assert _RESOLVE is not None
                manifest_before = (cycle / "MANIFEST.md").read_bytes()
                old_before = old.read_bytes()
                sweep_before = (
                    (cycle / "SWEEP.md").read_bytes() if (cycle / "SWEEP.md").exists() else None
                )
                with self.assertRaisesRegex(improve.ImproveError, "sweep-queue|unswept"):
                    _RESOLVE(cycle, "seat-old", "seat-new")
                self.assertEqual((cycle / "MANIFEST.md").read_bytes(), manifest_before)
                self.assertEqual(old.read_bytes(), old_before)
                self.assertEqual(
                    (cycle / "SWEEP.md").read_bytes()
                    if (cycle / "SWEEP.md").exists()
                    else None,
                    sweep_before,
                )

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_repeat_is_explicit_and_old_report_tamper_fails_closed(self) -> None:
        _root, cycle, old, _new = self._stale_cycle()
        assert _RESOLVE is not None
        _RESOLVE(cycle, "seat-old", "seat-new")
        manifest_before = (cycle / "MANIFEST.md").read_bytes()
        repeated = _RESOLVE(cycle, "seat-old", "seat-new")
        self.assertEqual(repeated["code"], "ALREADY_APPLIED")
        self.assertEqual((cycle / "MANIFEST.md").read_bytes(), manifest_before)

        old.write_bytes(old.read_bytes() + b"\nTAMPERED\n")
        errors = improve.verify_cycle(cycle)
        self.assertTrue(any("sha256" in error or "tamper" in error for error in errors), errors)

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_fresh_complete_and_mismatched_replacement_refuse(self) -> None:
        root = self._project()
        cycle = improve.create_cycle(
            root,
            "imp-t1411-20260919-01",
            created_at="2026-09-19T00:00:00Z",
            project_identity="probe-project",
        )
        self._add_complete_seat(root, cycle, "seat-old", findings=0)
        self._add_complete_seat(
            root, cycle, "seat-new", findings=0, scope="different audit scope"
        )
        assert _RESOLVE is not None
        with self.assertRaisesRegex(improve.ImproveError, "fresh|not stale"):
            _RESOLVE(cycle, "seat-old", "seat-new")

        (root / "src.txt").write_text("source-v2\n", encoding="utf-8")
        _git(root, "add", "src.txt")
        _git(root, "commit", "-qm", "move source identity")
        with self.assertRaisesRegex(improve.ImproveError, "context_scope|scope"):
            _RESOLVE(cycle, "seat-old", "seat-new")

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_role_mismatched_replacement_refuses(self) -> None:
        root = self._project()
        cycle = improve.create_cycle(
            root,
            "imp-t1411-20260919-01",
            created_at="2026-09-19T00:00:00Z",
            project_identity="probe-project",
        )
        self._add_complete_seat(root, cycle, "seat-old", findings=0)
        (root / "src.txt").write_text("source-v2\n", encoding="utf-8")
        _git(root, "add", "src.txt")
        _git(root, "commit", "-qm", "move source identity")
        self._add_complete_seat(root, cycle, "seat-new", findings=0, role="critic")
        assert _RESOLVE is not None
        with self.assertRaisesRegex(improve.ImproveError, "role"):
            _RESOLVE(cycle, "seat-old", "seat-new")

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_source_moves_again_and_supersession_chain_recovers(self) -> None:
        root, cycle, _old, _new = self._stale_cycle()
        assert _RESOLVE is not None
        _RESOLVE(cycle, "seat-old", "seat-new")
        (root / "src.txt").write_text("source-v3\n", encoding="utf-8")
        _git(root, "add", "src.txt")
        _git(root, "commit", "-qm", "move source identity again")
        errors = improve.verify_cycle(cycle)
        self.assertTrue(any("seat-new" in error and "source_" in error for error in errors), errors)
        self.assertTrue(
            any("stale COMPLETE recovery route" in error for error in errors), errors
        )

        repeated = _RESOLVE(cycle, "seat-old", "seat-new")
        self.assertEqual(repeated["code"], "ALREADY_APPLIED")
        self.assertEqual(improve.verify_cycle(cycle), errors)

        self._add_complete_seat(root, cycle, "seat-current", findings=0)
        _RESOLVE(cycle, "seat-new", "seat-current")
        self.assertEqual(improve.verify_cycle(cycle), [])

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_public_retire_route_is_executable(self) -> None:
        root, cycle, old, _new = self._stale_cycle()
        old_before = old.read_bytes()
        command = [
            sys.executable,
            str(TOOLS / "saipen.py"),
            "--project-root",
            str(root),
            "--json",
            "improve",
            "retire",
            cycle.name,
            "seat-old",
            "--reason",
            "STALE_COMPLETE",
            "--replacement",
            "seat-new",
        ]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
        payload = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0, result.stderr or payload)
        self.assertEqual(payload["code"], "SEAT_SUPERSEDED")
        self.assertEqual(old.read_bytes(), old_before)
        self.assertEqual(improve.verify_cycle(cycle), [])

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_prepare_refuses_superseded_seat_and_names_replacement(self) -> None:
        root, cycle, _old, _new = self._stale_cycle()
        assert _RESOLVE is not None
        _RESOLVE(cycle, "seat-old", "seat-new")
        result = improve.prepare_audit_seat(
            root,
            agent_family="seat",
            role="core",
            session_id="seat-old",
            project_name="PROBE",
            model_or_runtime="probe",
            context_scope="same bounded audit scope",
        )
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "SEAT_SUPERSEDED")
        self.assertEqual(result.get("replacement_seat"), "seat-new")

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_unswept_reproduced_finding_has_finite_executable_exit(self) -> None:
        root, cycle, old, new = self._stale_cycle(
            findings=1, disposed=(), replacement_findings=1
        )
        assert new is not None and _RESOLVE is not None
        self._add_ticket(root, "T-900")
        old_before = old.read_bytes()
        new_before = new.read_bytes()

        rc, payload, _stderr = self._cli(
            root,
            "improve",
            "retire",
            cycle.name,
            "seat-old",
            "--reason",
            "STALE_COMPLETE",
            "--replacement",
            "seat-new",
        )
        self.assertNotEqual(rc, 0, payload)
        detail = payload.get("detail", "")
        self.assertIn("SUPERSEDED", detail, detail)
        self.assertIn("NOT_REPRODUCED", detail, detail)
        self.assertIn("--verification", detail, detail)
        self.assertIn(f"saipen improve sweep {cycle.name}", detail, detail)
        self.assertIn("saipen improve retire", detail, detail)

        rc, payload, _stderr = self._cli(
            root,
            "improve",
            "sweep",
            cycle.name,
            "RUN-1/IMP-001",
            "CONFIRMED",
            "--ticket",
            "T-900",
            "--report",
            "seat-old/saipen_improve_PROBE.md",
            "--reproduced",
            "y",
        )
        self.assertNotEqual(rc, 0, payload)
        self.assertIn("stale", payload.get("detail", "").lower())

        rc, payload, stderr = self._cli(
            root,
            "improve",
            "sweep",
            cycle.name,
            "RUN-1/IMP-001",
            "CONFIRMED",
            "--ticket",
            "T-900",
            "--report",
            "seat-new/saipen_improve_PROBE.md",
            "--reproduced",
            "y",
        )
        self.assertEqual(rc, 0, payload or stderr)

        verification = f"{cycle.name}/seat-new/saipen_improve_PROBE.md#RUN-1/IMP-001"
        rc, payload, stderr = self._cli(
            root,
            "improve",
            "sweep",
            cycle.name,
            "RUN-1/IMP-001",
            "SUPERSEDED",
            "--report",
            "seat-old/saipen_improve_PROBE.md",
            "--reproduced",
            "y",
            "--verification",
            verification,
        )
        self.assertEqual(rc, 0, payload or stderr)

        rc, payload, stderr = self._cli(
            root,
            "improve",
            "retire",
            cycle.name,
            "seat-old",
            "--reason",
            "STALE_COMPLETE",
            "--replacement",
            "seat-new",
        )
        self.assertEqual(rc, 0, payload or stderr)
        self.assertEqual(payload.get("code"), "SEAT_SUPERSEDED")
        self.assertEqual(
            payload.get("preserved_report_sha256"), hashlib.sha256(old_before).hexdigest()
        )

        for action in ("verify", "cycle-complete", "clean"):
            rc, payload, stderr = self._cli(root, "improve", action, cycle.name)
            self.assertEqual(rc, 0, payload or stderr)

        self.assertEqual(old.read_bytes(), old_before)
        self.assertEqual(new.read_bytes(), new_before)
        sweep = (cycle / "SWEEP.md").read_text(encoding="utf-8")
        self.assertIn("SUPERSEDED", sweep)
        self.assertIn(f"verification={verification}", sweep)
        self.assertIn(
            "cycle_status: archived", (cycle / "MANIFEST.md").read_text(encoding="utf-8-sig")
        )

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_unswept_no_longer_reproduced_finding_has_finite_exit(self) -> None:
        root, cycle, old, new = self._stale_cycle(
            findings=1, disposed=(), replacement_findings=0
        )
        assert new is not None and _RESOLVE is not None
        old_before = old.read_bytes()
        new_before = new.read_bytes()
        verification = f"{cycle.name}/seat-new/saipen_improve_PROBE.md#RUN-1/IMP-001"
        rc, payload, stderr = self._cli(
            root,
            "improve",
            "sweep",
            cycle.name,
            "RUN-1/IMP-001",
            "NOT_REPRODUCED",
            "--report",
            "seat-old/saipen_improve_PROBE.md",
            "--reproduced",
            "n",
            "--verification",
            verification,
        )
        self.assertEqual(rc, 0, payload or stderr)

        rc, payload, stderr = self._cli(
            root,
            "improve",
            "retire",
            cycle.name,
            "seat-old",
            "--reason",
            "STALE_COMPLETE",
            "--replacement",
            "seat-new",
        )
        self.assertEqual(rc, 0, payload or stderr)
        self.assertEqual(payload.get("code"), "SEAT_SUPERSEDED")

        for action in ("verify", "cycle-complete", "clean"):
            rc, payload, stderr = self._cli(root, "improve", action, cycle.name)
            self.assertEqual(rc, 0, payload or stderr)

        self.assertEqual(old.read_bytes(), old_before)
        self.assertEqual(new.read_bytes(), new_before)
        sweep = (cycle / "SWEEP.md").read_text(encoding="utf-8")
        self.assertIn("[NOT_REPRODUCED] -", sweep)
        self.assertIn(f"verification={verification}", sweep)

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_partial_sweep_finite_exit_preserves_existing_disposition(self) -> None:
        root, cycle, old, new = self._stale_cycle(
            findings=2, disposed=(1,), replacement_findings=1
        )
        assert new is not None and _RESOLVE is not None
        self._add_ticket(root, "T-900")
        old_before = old.read_bytes()
        new_before = new.read_bytes()
        sweep_before = (cycle / "SWEEP.md").read_bytes()

        rc, payload, stderr = self._cli(
            root,
            "improve",
            "sweep",
            cycle.name,
            "RUN-1/IMP-001",
            "CONFIRMED",
            "--ticket",
            "T-900",
            "--report",
            "seat-new/saipen_improve_PROBE.md",
            "--reproduced",
            "y",
        )
        self.assertEqual(rc, 0, payload or stderr)

        verification = f"{cycle.name}/seat-new/saipen_improve_PROBE.md#RUN-1/IMP-001"
        rc, payload, stderr = self._cli(
            root,
            "improve",
            "sweep",
            cycle.name,
            "RUN-1/IMP-002",
            "SUPERSEDED",
            "--report",
            "seat-old/saipen_improve_PROBE.md",
            "--reproduced",
            "y",
            "--verification",
            verification,
        )
        self.assertEqual(rc, 0, payload or stderr)

        rc, payload, stderr = self._cli(
            root,
            "improve",
            "retire",
            cycle.name,
            "seat-old",
            "--reason",
            "STALE_COMPLETE",
            "--replacement",
            "seat-new",
        )
        self.assertEqual(rc, 0, payload or stderr)

        for action in ("verify", "cycle-complete", "clean"):
            rc, payload, stderr = self._cli(root, "improve", action, cycle.name)
            self.assertEqual(rc, 0, payload or stderr)

        sweep_after = (cycle / "SWEEP.md").read_bytes()
        self.assertTrue(sweep_after.startswith(sweep_before), sweep_after)
        appended = sweep_after[len(sweep_before):].decode("utf-8")
        self.assertIn("RUN-1/IMP-001 [CONFIRMED] T-900", appended)
        self.assertIn("RUN-1/IMP-002 [SUPERSEDED]", appended)
        self.assertEqual(
            len(sweep_after.splitlines()) - len(sweep_before.splitlines()), 2
        )
        self.assertEqual(old.read_bytes(), old_before)
        self.assertEqual(new.read_bytes(), new_before)

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_malformed_supersession_rejected_by_every_consumer(self) -> None:
        root, cycle, old, _new = self._stale_cycle()
        assert _RESOLVE is not None
        _RESOLVE(cycle, "seat-old", "seat-new")
        self.assertEqual(improve.verify_cycle(cycle), [])
        _pristine_rc, pristine_out = self._validator(root)
        self.assertNotIn("tampered", pristine_out, pristine_out)

        old.write_bytes(old.read_bytes() + b"\nTAMPERED\n")

        errors = improve.verify_cycle(cycle)
        self.assertTrue(
            any("tamper" in error or "sha256" in error for error in errors), errors
        )
        rc, payload, _stderr = self._cli(root, "improve", "verify", cycle.name)
        self.assertNotEqual(rc, 0, payload)
        self.assertRegex(payload.get("detail", ""), "tamper|sha256")
        rc, payload, _stderr = self._cli(root, "improve", "cycle-complete", cycle.name)
        self.assertNotEqual(rc, 0, payload)
        self.assertRegex(payload.get("detail", ""), "tamper|sha256")
        _tampered_rc, tampered_out = self._validator(root)
        self.assertNotEqual(_tampered_rc, 0, tampered_out)
        self.assertRegex(tampered_out, "tamper|sha256")

    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_dangling_replacement_rejected_by_every_consumer(self) -> None:
        root, cycle, _old, _new = self._stale_cycle()
        assert _RESOLVE is not None
        _RESOLVE(cycle, "seat-old", "seat-new")
        manifest = cycle / "MANIFEST.md"
        manifest.write_text(
            manifest.read_text(encoding="utf-8-sig").replace(
                "replacement_seat: seat-new", "replacement_seat: seat-ghost"
            ),
            encoding="utf-8",
        )
        errors = improve.verify_cycle(cycle)
        self.assertTrue(any("seat-ghost" in error for error in errors), errors)
        rc, payload, _stderr = self._cli(root, "improve", "verify", cycle.name)
        self.assertNotEqual(rc, 0, payload)
        self.assertIn("seat-ghost", payload.get("detail", ""))
        rc, payload, _stderr = self._cli(root, "improve", "cycle-complete", cycle.name)
        self.assertNotEqual(rc, 0, payload)
        self.assertIn("seat-ghost", payload.get("detail", ""))
        validator_rc, validator_out = self._validator(root)
        self.assertNotEqual(validator_rc, 0, validator_out)
        self.assertIn("seat-ghost", validator_out)


    @unittest.skipUnless(_HAS_RESOLUTION, _SKIP)
    def test_ticket_provenance_resolves_only_confirmed_dispositions(self) -> None:
        root, cycle, _old, new = self._stale_cycle(
            findings=1, disposed=(), replacement_findings=1
        )
        assert new is not None and _RESOLVE is not None
        self._add_ticket(root, "T-900")
        rc, payload, stderr = self._cli(
            root,
            "improve",
            "sweep",
            cycle.name,
            "RUN-1/IMP-001",
            "CONFIRMED",
            "--ticket",
            "T-900",
            "--report",
            "seat-new/saipen_improve_PROBE.md",
            "--reproduced",
            "y",
        )
        self.assertEqual(rc, 0, payload or stderr)
        verification = f"{cycle.name}/seat-new/saipen_improve_PROBE.md#RUN-1/IMP-001"
        rc, payload, stderr = self._cli(
            root,
            "improve",
            "sweep",
            cycle.name,
            "RUN-1/IMP-001",
            "SUPERSEDED",
            "--report",
            "seat-old/saipen_improve_PROBE.md",
            "--reproduced",
            "y",
            "--verification",
            verification,
        )
        self.assertEqual(rc, 0, payload or stderr)
        rc, payload, stderr = self._cli(
            root,
            "improve",
            "retire",
            cycle.name,
            "seat-old",
            "--reason",
            "STALE_COMPLETE",
            "--replacement",
            "seat-new",
        )
        self.assertEqual(rc, 0, payload or stderr)

        board = root / ".saipen" / "BOARD.md"
        pristine = board.read_text(encoding="utf-8")
        historical = f"{cycle.name}/seat-old/saipen_improve_PROBE.md#RUN-1/IMP-001"
        board.write_text(
            pristine.replace(
                "| verify: probe",
                f"| verify: probe | source_reports: {historical}",
                1,
            ),
            encoding="utf-8",
        )
        _rc, historical_out = self._validator(root)
        self.assertIn("CONFIRMED", historical_out, historical_out)

        board.write_text(
            pristine.replace(
                "| verify: probe",
                f"| verify: probe | source_reports: {verification}",
                1,
            ),
            encoding="utf-8",
        )
        rc, confirmed_out = self._validator(root)
        self.assertEqual(rc, 0, confirmed_out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
