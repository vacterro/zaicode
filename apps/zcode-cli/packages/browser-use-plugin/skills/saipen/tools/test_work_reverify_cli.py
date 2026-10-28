"""T-1434 M1: canonical `saipen work reverify` (SRC-088).

The engine logic existed (debt.reverify_work); no CLI route reached it, so the
validator's own remediation named a move the surface could not execute. These
regressions drive the REAL public adapter as a subprocess against a throwaway
project: an already-DONE Work without current-cycle evidence, a real strict
validator run before and after, and the SRC-088 milestone-1 acceptance gates.

Run standalone:
    python tools/test_work_reverify_cli.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import debt as debt_mod  # noqa: E402
from saipen_engine import findings as findings_mod  # noqa: E402
from saipen_engine.paths import unbound_environment  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"
VALIDATE_PY = TOOLS / "validate.py"
SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"

V = [{"command": "unittest probe", "result": "PASS"}]


def _make_project(tmp: Path, *, done: bool = True) -> Path:
    root = tmp / "project"
    root.parent.mkdir(parents=True, exist_ok=True)
    root.mkdir()
    shutil.copytree(SCENARIO, root / ".saipen")
    board = root / ".saipen/BOARD.md"
    text = board.read_text(encoding="utf-8")
    text = text.replace("## DOING\n- [/] T-001 DOING task", "## DOING")
    if done:
        text = text.replace(
            "## DONE\n", "## DONE\n- [x] T-001 DOING task | verify: proof exists\n"
        )
    else:
        text = text.replace(
            "## TODO\n", "## TODO\n- [ ] T-001 DOING task | verify: proof exists\n"
        )
    board.write_text(text, encoding="utf-8")
    log = root / ".saipen/LOG.md"
    log.write_text(
        "- 26.07.17 00:00 [E-001] [T-001] RUN: transition to VERIFY\n"
        "- 26.07.17 00:01 [E-002] [T-001] DEC: closed without strict evidence\n",
        encoding="utf-8",
    )
    return root


def _unenbound_env() -> dict:
    return unbound_environment()


def _run_cli(project: Path, *args: str) -> tuple[int, dict, str]:
    proc = subprocess.run(
        [
            sys.executable,
            str(SAIPEN_PY),
            "--project-root",
            str(project),
            "--agent",
            "tester",
            "--json",
            *args,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_unenbound_env(),
        timeout=600,
    )
    try:
        payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except ValueError:
        payload = {"_unparseable_stdout": proc.stdout}
    return proc.returncode, payload, proc.stdout


def _run_validator(project: Path, *extra: str) -> tuple[int, str]:
    proc = subprocess.run(
        [
            sys.executable,
            str(VALIDATE_PY),
            "--project-root",
            str(project),
            "--gate",
            "core",
            "--no-receipt",
            *extra,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_unenbound_env(),
        timeout=600,
    )
    return proc.returncode, proc.stdout


class WorkReverifyCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-work-reverify-")
        self.root = _make_project(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _receipt_dir(self) -> Path:
        return self.root / debt_mod.REVERIFY_DIR

    # -- family 10: validator before and after successful reverify ----------

    def test_validator_names_the_implemented_command_before_reverify(self):
        rc, out = _run_validator(self.root)
        self.assertNotEqual(rc, 0)
        self.assertIn("closure-evidence", out)
        self.assertIn("saipen work reverify T-001", out)

    def test_successful_reverify_clears_only_the_current_tree_defect(self):
        rc_before, _ = _run_validator(self.root)
        self.assertNotEqual(rc_before, 0)
        rc, payload, out = _run_cli(self.root, "work", "reverify", "T-001")  # noqa: RUF059
        self.assertEqual(payload.get("code"), "WORK_REVERIFIED", out)
        self.assertIn(payload.get("verdict"), ("PASS", "PASS_WITH_CARRIED_DEBT"))
        rc_after, out_after = _run_validator(self.root)
        self.assertEqual(rc_after, 0, out_after)
        self.assertNotIn("closure-evidence -- ticket T-001", out_after)

    # -- families 1/2: history preserved, DONE stays DONE -------------------

    def test_reverify_preserves_done_and_historical_bytes(self):
        board = self.root / ".saipen/BOARD.md"
        log = self.root / ".saipen/LOG.md"
        before_board = board.read_bytes()
        before_log = log.read_bytes()
        rc, _payload, out = _run_cli(self.root, "work", "reverify", "T-001")
        self.assertEqual(rc, 0, out)
        self.assertEqual(board.read_bytes(), before_board)
        self.assertEqual(log.read_bytes(), before_log)

    def test_receipt_binds_contract_provenance_and_evidence(self):
        rc, payload, out = _run_cli(self.root, "work", "reverify", "T-001")
        self.assertEqual(rc, 0, out)
        receipt_id = payload["receipt_id"]
        record = json.loads(
            (self._receipt_dir() / f"{receipt_id}.json").read_text(encoding="utf-8")
        )
        for field in (
            "work",
            "verification_contract_digest",
            "verification_contract",
            "original_closure",
            "source_head",
            "source_tree_fingerprint",
            "verdict",
            "verifier",
            "integrity_digest",
        ):
            self.assertIn(field, record, f"receipt missing {field}")
        self.assertEqual(record["work"], "T-001")
        self.assertEqual(record["original_closure"]["last_ticket_event"], "E-002")
        self.assertTrue(
            any(entry.get("default_contract") for entry in record["verification"])
        )

    # -- family 4: repeated identical reverify ------------------------------

    def test_repeated_identical_reverify_reuses_the_receipt(self):
        rc, first, out = _run_cli(self.root, "work", "reverify", "T-001")
        self.assertEqual(rc, 0, out)
        rc, second, out = _run_cli(self.root, "work", "reverify", "T-001")
        self.assertEqual(second.get("code"), "REVERIFY_REUSED", out)
        self.assertEqual(first["receipt_id"], second["receipt_id"])
        receipts = sorted(self._receipt_dir().glob("RV-*.json"))
        self.assertEqual(len(receipts), 1)

    # -- families 3/9: executed verification fails honestly -----------------

    def test_failed_executed_check_writes_fail_and_never_false_green(self):
        _rc, payload, out = _run_cli(
            self.root, "work", "reverify", "T-001", "--run", "exit 7"
        )
        self.assertEqual(payload.get("code"), "WORK_REVERIFIED", out)
        self.assertEqual(payload.get("verdict"), "FAIL")
        rc_validator, out_validator = _run_validator(self.root)
        self.assertNotEqual(rc_validator, 0)
        self.assertIn("closure-evidence -- ticket T-001", out_validator)

    def test_missing_contract_refuses(self):
        with patch.object(
            debt_mod,
            "capture_findings",
            return_value={"ok": False, "code": "FINDINGS_CAPTURE_FAILED"},
        ):
            result = debt_mod.reverify_work(
                self.root, "T-001", "tester", derive_default=True
            )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "FINDINGS_CAPTURE_FAILED")

    # -- family 8: malformed work id ----------------------------------------

    def test_malformed_work_id_refuses(self):
        rc, payload, out = _run_cli(self.root, "work", "reverify", "T-abc")
        self.assertNotEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED")
        rc, payload, out = _run_cli(self.root, "work", "reverify", "nonsense")
        self.assertNotEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED")

    # -- attested verification + non-DONE refusal ---------------------------

    def test_attested_verification_grammar(self):
        rc, payload, out = _run_cli(
            self.root, "work", "reverify", "T-001", "--verification", "probe:FAIL"
        )
        self.assertNotEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "REVERIFY_REFUSED")
        rc, payload, out = _run_cli(
            self.root, "work", "reverify", "T-001", "--verification", "probe:PASS"
        )
        self.assertEqual(rc, 0, out)
        record = json.loads(
            (self._receipt_dir() / f"{payload['receipt_id']}.json").read_text(
                encoding="utf-8"
            )
        )
        # T-1434 M5.3: an attested check is TYPED in the receipt so no
        # consumer can mistake the caller's word for executable evidence.
        self.assertEqual(
            record["verification"][0],
            {"command": "probe", "result": "PASS", "executed": False, "kind": "attested"},
        )
        self.assertEqual(record["evidence_class"], "attested")
        self.assertEqual(payload.get("evidence_class"), "attested")

    # -- M5.3 RED control: typing PASS manufactures no closure authority -----

    def test_attested_only_pass_never_cures_closure_evidence(self):
        """RED control (SRC-088 M5.3).

        A caller submits PASS text with no executable proof. The receipt is
        honest recorded evidence, but the current-tree closure gate must
        still FAIL: the evidence class proves only that the caller said so.
        """
        rc, payload, out = _run_cli(
            self.root, "work", "reverify", "T-001", "--verification", "probe:PASS"
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("evidence_class"), "attested")
        self.assertIsNone(
            debt_mod.current_tree_reverify(self.root, "T-001"),
            "attested-only receipt must never count as current-tree closure evidence",
        )
        rc_validator, out_validator = _run_validator(self.root)
        self.assertNotEqual(rc_validator, 0)
        self.assertIn("closure-evidence -- ticket T-001", out_validator)
        self.assertIn("attested-only", out_validator)

        # Executable evidence is the lawful cure, end to end.
        rc, payload, out = _run_cli(
            self.root, "work", "reverify", "T-001", "--run", "exit 0"
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("evidence_class"), "executed")
        rc_validator, out_validator = _run_validator(self.root)
        self.assertEqual(rc_validator, 0, out_validator)
        self.assertNotIn("closure-evidence -- ticket T-001", out_validator)

    def test_non_done_work_refuses(self):
        todo_root = _make_project(Path(self.tmp.name) / "todo", done=False)
        rc, payload, out = _run_cli(todo_root, "work", "reverify", "T-001")
        self.assertNotEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "REVERIFY_REFUSED")


class WorkReverifyEngineTests(unittest.TestCase):
    """Engine-level semantics the CLI projects (runs/timeout/contract)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-work-engine-")
        self.root = _make_project(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _canned(self, problems=None):
        return {
            "ok": True,
            "exit_code": 0 if not problems else 1,
            "gate": "core",
            "problems": problems or [],
            "warnings": [],
        }

    def test_executed_run_entries_carry_exit_code_and_digest(self):
        with patch.object(debt_mod, "capture_findings", return_value=self._canned()):
            result = debt_mod.reverify_work(
                self.root, "T-001", "probe", runs=["exit 0"]
            )
        self.assertTrue(result["ok"], result)
        record = json.loads(
            (self.root / debt_mod.REVERIFY_DIR / f"{result['receipt_id']}.json").read_text(
                encoding="utf-8"
            )
        )
        executed = [e for e in record["verification"] if e.get("executed")]
        self.assertEqual(len(executed), 1)
        self.assertEqual(executed[0]["result"], "PASS")
        self.assertEqual(executed[0]["exit_code"], 0)
        self.assertIn("output_digest", executed[0])

    def test_timeout_is_an_honest_fail(self):
        with patch.object(  # noqa: SIM117
            debt_mod, "capture_findings", return_value=self._canned()
        ):
            with patch.object(
                debt_mod.subprocess,
                "run",
                side_effect=debt_mod.subprocess.TimeoutExpired("probe", 1),
            ):
                result = debt_mod.reverify_work(
                    self.root, "T-001", "probe", runs=["slow-probe"], timeout=1
                )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["verdict"], "FAIL")
        record = json.loads(
            (self.root / debt_mod.REVERIFY_DIR / f"{result['receipt_id']}.json").read_text(
                encoding="utf-8"
            )
        )
        executed = [e for e in record["verification"] if e.get("executed")]
        self.assertTrue(executed[0].get("timed_out"))

    def test_fail_then_pass_writes_a_new_receipt(self):
        with patch.object(  # noqa: SIM117
            debt_mod, "capture_findings", return_value=self._canned()
        ):
            with patch.object(
                debt_mod.subprocess,
                "run",
                side_effect=debt_mod.subprocess.TimeoutExpired("probe", 1),
            ):
                failed = debt_mod.reverify_work(
                    self.root, "T-001", "probe", runs=["probe"], timeout=1
                )
        with patch.object(debt_mod, "capture_findings", return_value=self._canned()):
            repaired = debt_mod.reverify_work(self.root, "T-001", "probe", runs=["exit 0"])
        self.assertEqual(failed["verdict"], "FAIL")
        self.assertEqual(repaired["code"], "WORK_REVERIFIED")
        self.assertNotEqual(failed["receipt_id"], repaired["receipt_id"])

    def test_verification_failure_is_not_hidden_by_an_older_pass(self):
        with patch.object(debt_mod, "capture_findings", return_value=self._canned()):
            passed = debt_mod.reverify_work(self.root, "T-001", "probe", runs=["exit 0"])
            again = debt_mod.reverify_work(self.root, "T-001", "probe", runs=["exit 0"])
        self.assertEqual(again["code"], "REVERIFY_REUSED")
        with patch.object(
            debt_mod,
            "capture_findings",
            return_value=self._canned([self._own_problem()]),
        ):
            failed = debt_mod.reverify_work(
                self.root, "T-001", "probe", derive_default=True
            )
        self.assertEqual(failed["verdict"], "FAIL")
        self.assertIsNone(debt_mod.latest_pass_reverify(self.root, "T-001"))
        self.assertEqual(passed["receipt_id"] != failed["receipt_id"], True)

    def _own_problem(self):
        return findings_mod.classify(
            "problem", "DONE Work T-001 has unresolved source receipt SRC-001"
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
