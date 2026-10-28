"""T-1439: current failures retain diagnostics and never remediate to validate."""

from __future__ import annotations

import json
import io
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from contextlib import redirect_stdout

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import conformance as C, findings, router  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402
import test_t1412_conformance_truth as fixtures  # noqa: E402
import test_continue_chain as chain_fixtures  # noqa: E402
from test_validator_layout_parity import _build_home  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


def diagnostics(*messages: str) -> dict:
    problems = [findings.classify("problem", message) for message in messages]
    return {
        "status": "complete",
        "ruleset_version": findings.RULESET_VERSION,
        "ruleset_fingerprint": findings.ruleset_fingerprint(),
        "problem_count": len(problems),
        "warning_count": 90,
        "problems": problems,
    }


class RepairBoundaryTests(fixtures.T1412Base):
    def test_failure_after_completed_chain_keeps_its_refusal_and_diagnostic(self):
        import saipen as CLI

        fixture = chain_fixtures.ContinueChainTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        root = fixture._chain_project()
        refusal = {
            "ok": False, "code": "CONFORMANCE_UNHEALTHY", "action": None,
            "reason": "conformance-remediation", "canonical_next_command": None,
            "terminal": True, "repair_status": "ENGINEERING_REQUIRED",
            "diagnostic": {"kind": "ENGINEERING_REQUIRED", "detail": "bounded fixture"},
        }

        def idle_gate(_root, routed):
            return refusal if routed.get("reason") == "maintain" else None

        output = io.StringIO()
        gate = patch.object(router, "conformance_idle_gate", side_effect=idle_gate)
        with gate, redirect_stdout(output):
            rc = CLI.main(["cc", "--project-root", str(root), "--json"])
        result = json.loads(output.getvalue())
        self.assertEqual([step["operation"] for step in result["continue_trace"]],
                         ["ticket_done", "claim", "ticket_done"])
        self.assertEqual(rc, 1)
        for key in ("ok", "code", "action", "canonical_next_command", "diagnostic", "terminal"):
            self.assertEqual(result[key], refusal[key])
        self.assertEqual(result["stop_reason"], "refusal")

    def test_current_fail_without_registered_repair_has_terminal_diagnosis(self):
        root = self.make_project("legacy-fail")
        fixtures.write_receipt(root, "FAIL")
        decision = C.conformance_decision(root)
        self.assertFalse(decision["healthy"])
        self.assertIsNone(decision["remediation_command"])
        self.assertEqual(decision["repair_status"], "ENGINEERING_REQUIRED")
        self.assertTrue(decision["diagnostic"]["detail"])
        for route in (
            {"ok": True, "action": "saipen continue", "reason": "maintain"},
            {"ok": True, "action": "saipen crew", "reason": "crew-converge"},
            {"ok": True, "action": "saipen validate", "reason": "maintain"},
        ):
            with self.subTest(route=route):
                result = router.gate_route(root, route)
                self.assertFalse(result["ok"])
                self.assertIsNone(result["canonical_next_command"])
                self.assertIsNone(result["action"])
                self.assertEqual(result["diagnostic"], decision["diagnostic"])

    def test_every_blocking_record_survives_duplicate_family_keys(self):
        root = self.make_project("records")
        problems = diagnostics("unknown failure alpha", "unknown failure beta")
        self.assertEqual(problems["problems"][0]["finding_key"],
                         problems["problems"][1]["finding_key"])
        receipt = C.generate_conformance_receipt(
            root, gate="core", exit_code=1, blocking_findings=problems,
        )
        current = C.conformance_decision(root)
        self.assertEqual(current["status"], "CURRENT_FAIL")
        self.assertEqual(current["status_block"]["receipt"]["blocking_findings"], problems)
        self.assertEqual(receipt["blocking_findings"]["problem_count"], 2)
        self.assertEqual(current["diagnostic"]["receipt_id"], receipt["receipt_id"])

    def test_stale_fail_refreshes_instead_of_executing_its_old_repair(self):
        root = self.make_project("stale")
        C.generate_conformance_receipt(
            root, gate="core", exit_code=1,
            remediation_commands=["saipen work reverify T-123"],
        )
        (root / "tracked.txt").write_text("changed input\n", encoding="utf-8")
        decision = C.conformance_decision(root)
        self.assertEqual(decision["status"], "STALE_FAIL")
        self.assertEqual(decision["remediation_command"], "saipen validate")
        self.assertEqual(decision["remediation_commands"], [])

    def test_registered_repair_remains_executable_but_validate_is_not_a_repair(self):
        for commands, expected in (
            (["saipen source quarantine SRC-033 --reason CREDENTIAL_PATTERN"],
             "saipen source quarantine SRC-033 --reason CREDENTIAL_PATTERN"),
            (["saipen validate"], None),
            (["saipen invented-repair"], None),
        ):
            with self.subTest(commands=commands):
                root = self.make_project("command-" + str(len(list(self.base.iterdir()))))
                C.generate_conformance_receipt(root, gate="core", exit_code=1,
                                               remediation_commands=commands)
                self.assertEqual(C.conformance_decision(root)["remediation_command"], expected)

    def test_tampered_blocking_findings_cannot_be_current_evidence(self):
        root = self.make_project("tampered")
        C.generate_conformance_receipt(root, gate="core", exit_code=1,
                                       blocking_findings=diagnostics("real failure"))
        path = next((root / C.RECEIPT_DIRNAME).glob("*.json"))
        body = json.loads(path.read_text(encoding="utf-8"))
        body["blocking_findings"]["problems"] = []
        path.write_text(json.dumps(body), encoding="utf-8")
        decision = C.conformance_decision(root)
        self.assertEqual(decision["status"], "INVALID_RECEIPT")
        self.assertFalse(decision["healthy"])

    def test_classified_credentials_are_redacted_in_receipt(self):
        root = self.make_project("redaction")
        record = diagnostics("SOURCE_CREDENTIALS_UNSAFE SRC-033 sentinel-do-not-echo")
        receipt = C.generate_conformance_receipt(root, gate="core", exit_code=1,
                                                blocking_findings=record)
        self.assertNotIn("sentinel-do-not-echo", json.dumps(receipt))
        self.assertIsNone(receipt["blocking_findings"]["problems"][0]["detail"])


class RealValidatorBoundaryTests(fixtures.T1412Base):
    def installed_fixture(self, flatten: bool):
        home = self.base / ("flat-home" if flatten else "source-home")
        _build_home(home, flatten=flatten)
        root = self.make_project("flat-project" if flatten else "source-project",
                                 commit_identity=False, state=fixtures._ROUTER_STATE)
        state = root / ".saipen/STATE.md"
        text = state.read_text(encoding="utf-8")
        lines = [f'saipen_home: "{home.as_posix()}"' if line.startswith("saipen_home:")
                 else line for line in text.splitlines()]
        state.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.assert_fast_gate_clean(root)
        return root, home

    def test_real_source_and_flat_cli_preserve_findings_and_stop_the_loop(self):
        for flatten in (False, True):
            with self.subTest(flatten=flatten):
                root, home = self.installed_fixture(flatten)
                before = {name: (root / ".saipen" / name).read_bytes()
                          for name in ("STATE.md", "BOARD.md", "LOG.md")}
                with patch.object(fixtures, "SAIPEN_CLI", home / "tools/saipen.py"):
                    rc, payload, text = self.run_cli(root, "validate")
                    self.assertNotEqual(rc, 0, text)
                    self.assertEqual(payload["conformance_status"]["status"], "CURRENT_FAIL")
                    receipt = payload["conformance_status"]["receipt"]
                    blocking = receipt["blocking_findings"]
                    self.assertEqual(blocking["status"], "complete")
                    self.assertGreater(blocking["problem_count"], 0)
                    self.assertEqual(blocking["problem_count"], len(blocking["problems"]))
                    self.assertIsNone(payload["canonical_next_command"])
                    self.assertEqual(payload["diagnostic"]["kind"], "ENGINEERING_REQUIRED")
                    receipt_paths = set((root / C.RECEIPT_DIRNAME).glob("*.json"))
                    for command in ("next", "continue", "status", "explain-next"):
                        _, current, output = self.run_cli(root, command)
                        self.assertNotIn("Traceback", output)
                        if command == "status":
                            self.assertEqual(current["automation"]["disposition"], "BLOCKED")
                            self.assertIsNone(current["automation"]["remediation_command"])
                        elif command == "explain-next":
                            self.assertNotEqual(current["disposition"], "EXECUTE_SELF")
                            self.assertFalse(current["human_required"])
                        else:
                            self.assertIsNone(current.get("canonical_next_command"))
                            self.assertIsNone(current["action"])
                    self.assertEqual(set((root / C.RECEIPT_DIRNAME).glob("*.json")), receipt_paths)
                self.assertEqual(before, {name: (root / ".saipen" / name).read_bytes()
                                          for name in before})

    def test_classifier_failure_is_unavailable_not_an_empty_complete_set(self):
        root, home = self.installed_fixture(True)
        script = (
            "import runpy,sys; from unittest.mock import patch; "
            "sys.path.insert(0,sys.argv[1]); from saipen_engine import findings; "
            "validator=sys.argv[2]; sys.argv=sys.argv[2:]; "
            "p=patch.object(findings,'classify',side_effect=RuntimeError('unavailable')); "
            "p.start(); runpy.run_path(validator,run_name='__main__')"
        )
        result = subprocess.run(
            [sys.executable, "-B", "-c", script, str(home / "tools"),
             str(home / "tools/validate.py"), "--project-root", str(root), "--gate", "core"],
            capture_output=True, text=True, encoding="utf-8", env=hermetic_env(), timeout=120,
        )
        self.assertNotEqual(result.returncode, 0)
        decision = C.conformance_decision(root)
        self.assertFalse(decision["healthy"])
        self.assertEqual(decision["status_block"]["receipt"]["blocking_findings"]["status"],
                         "unavailable")
        self.assertIsNone(decision["remediation_command"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
