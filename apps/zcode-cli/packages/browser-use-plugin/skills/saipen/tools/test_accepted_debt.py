"""Accepted legacy debt regressions (Decision B, SRC-047).

Every case runs the REAL canonical validator as a subprocess against a
fixture project, so the contract is behavior, not wording (Guards rule):

  1. an exact registered sealed missing-set exits 0 with a VISIBLE
     ``accepted-legacy-debt`` warning naming the record and the events;
  2. a NEW unmarked structural event of the same rule still exits 1;
  3. an unrelated conformance failure still exits 1 while the debt is
     accepted;
  4. tampered line evidence, a foreign project identity and a corrupt
     record each fail closed to the ordinary exit-1 FAIL;
  5. registration itself refuses op-carrying events, unknown events,
     bad authorities and overlap with an existing record;
  6. no case ever changes a byte of the LOG (sealed-history integrity).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.accepted_debt import _integrity_digest  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "userperson-valid" / ".saipen"
VALIDATOR = TOOLS / "validate.py"
REGISTRAR = TOOLS / "accept_legacy_debt.py"

#: One pre-boundary event, one provenanced boundary event, then exactly two
#: post-boundary structural events without `[op: ...]` (goal-pivot and
#: transition markers).
LOG_SEED = (
    "- 08.08.26 00:00 [E-001] [T-none] DEC: fixture bootstrap\n"
    "- 08.08.26 00:01 [E-002] [agent: probe] "
    "[op: claim-0123456789abcdef0123456789abcdef] DEC: claimed via SAIOPS -- owner probe\n"
    "- 08.08.26 00:02 [E-003] DEC: goal pivot -- synthetic sealed missing provenance A\n"
    "- 08.08.26 00:03 [E-004] RUN: transition to BUILD -- synthetic sealed missing "
    "provenance B\n"
)

REASON = "sealed historical debt: retroactive marker would forge provenance (Decision B)"


def setUpModule() -> None:
    isolate_host_session()


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="saipen-accepted-debt-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        (self.root / ".saipen" / "LOG.md").write_text(LOG_SEED, encoding="utf-8")
        state_path = self.root / ".saipen" / "STATE.md"
        state = state_path.read_text(encoding="utf-8")
        state = state.replace("last_event: 1", "last_event: 4")
        state_path.write_text(state, encoding="utf-8")

    def run_validator(self) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                sys.executable,
                str(VALIDATOR),
                "--project-root",
                str(self.root),
                "--gate",
                "core",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=hermetic_env(),
            timeout=300,
        )

    def register(
        self,
        events: list[str],
        *,
        authority: str = "SRC-047",
        reason: str = REASON,
    ) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                sys.executable,
                str(REGISTRAR),
                "--project-root",
                str(self.root),
                "--events",
                ",".join(events),
                "--authority",
                authority,
                "--reason",
                reason,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=hermetic_env(),
            timeout=120,
        )

    def register_json(self, events: list[str], **kwargs) -> dict:
        done = self.register(events, **kwargs)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return json.loads(done.stdout)

    def record_path(self) -> Path:
        directory = self.root / ".saipen" / "recovery" / "conformance" / "accepted_debt"
        files = sorted(directory.glob("AD-*.json"))
        self.assertEqual(len(files), 1, files)
        return files[0]

    def rewrite_record(self, mutate) -> None:
        path = self.record_path()
        record = json.loads(path.read_text(encoding="utf-8"))
        body = {k: v for k, v in record.items() if k != "integrity_digest"}
        mutate(body)
        body["integrity_digest"] = _integrity_digest(body)
        path.write_text(json.dumps(body, indent=2, sort_keys=True), encoding="utf-8")

    def fail_lines(self, output: str) -> list[str]:
        return [ln for ln in output.splitlines() if ln.startswith("FAIL: ")]

    def provenance_fail_lines(self, output: str) -> list[str]:
        return [ln for ln in self.fail_lines(output) if "mechanical provenance" in ln]

    def log_bytes(self) -> bytes:
        return (self.root / ".saipen" / "LOG.md").read_bytes()


class BaselineWithoutRecordTests(Fixture):
    def test_unaccepted_missing_set_fails_with_the_original_finding(self) -> None:
        done = self.run_validator()
        self.assertNotEqual(done.returncode, 0, done.stdout)
        lines = self.provenance_fail_lines(done.stdout)
        self.assertEqual(len(lines), 1, done.stdout)
        # Canonical rendering is unpadded `E-{int}` (E-3, not E-003).
        self.assertIn("E-3", lines[0])
        self.assertIn("E-4", lines[0])
        self.assertNotIn("accepted-legacy-debt", done.stdout)


class RegisteredAcceptanceTests(Fixture):
    def test_exact_registered_set_exits_zero_as_a_visible_warning(self) -> None:
        result = self.register_json(["E-003", "E-004"])
        self.assertEqual(result["record_id"], "AD-000001")
        self.assertEqual(result["events"], ["E-3", "E-4"])
        done = self.run_validator()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("WARN [accepted-legacy-debt]:", done.stdout)
        self.assertIn("AD-000001", done.stdout)
        self.assertIn("E-3", done.stdout)
        self.assertIn("E-4", done.stdout)
        self.assertIn("NEW unmarked structural event still FAILs", done.stdout)
        self.assertEqual(self.provenance_fail_lines(done.stdout), [])

    def test_registration_and_validation_never_change_log_bytes(self) -> None:
        before = self.log_bytes()
        self.register_json(["E-003", "E-004"])
        self.run_validator()
        self.assertEqual(self.log_bytes(), before)


class RedControlNewEventTests(Fixture):
    def test_a_new_unmarked_structural_event_still_fails(self) -> None:
        self.register_json(["E-003", "E-004"])
        with (self.root / ".saipen" / "LOG.md").open("a", encoding="utf-8") as handle:
            handle.write(
                "- 08.08.26 00:04 [E-005] DEC: goal pivot -- NEW unmarked structural event\n"
            )
        state_path = self.root / ".saipen" / "STATE.md"
        state_path.write_text(
            state_path.read_text(encoding="utf-8").replace("last_event: 4", "last_event: 5"),
            encoding="utf-8",
        )
        done = self.run_validator()
        self.assertNotEqual(done.returncode, 0, done.stdout)
        lines = self.provenance_fail_lines(done.stdout)
        self.assertEqual(len(lines), 1, done.stdout)
        self.assertIn("E-5", lines[0])


class RedControlUnrelatedFailureTests(Fixture):
    def test_unrelated_failure_still_fails_while_debt_is_accepted(self) -> None:
        self.register_json(["E-003", "E-004"])
        state_path = self.root / ".saipen" / "STATE.md"
        state_path.write_text(
            state_path.read_text(encoding="utf-8").replace("mode: full", "mode: bogus"),
            encoding="utf-8",
        )
        done = self.run_validator()
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertTrue(
            any("mode" in line for line in self.fail_lines(done.stdout)),
            done.stdout,
        )
        self.assertIn("WARN [accepted-legacy-debt]:", done.stdout)


class FailClosedRecordTests(Fixture):
    def test_tampered_line_evidence_fails_closed_even_with_a_valid_digest(self) -> None:
        self.register_json(["E-003", "E-004"])

        def mutate(body: dict) -> None:
            body["evidence"][0]["line_sha256"] = "00" * 32

        self.rewrite_record(mutate)
        done = self.run_validator()
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertEqual(len(self.provenance_fail_lines(done.stdout)), 1, done.stdout)

    def test_foreign_project_identity_fails_closed(self) -> None:
        self.register_json(["E-003", "E-004"])

        def mutate(body: dict) -> None:
            body["project_identity"] = "some-other-project"

        self.rewrite_record(mutate)
        done = self.run_validator()
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertEqual(len(self.provenance_fail_lines(done.stdout)), 1, done.stdout)

    def test_corrupt_record_fails_closed(self) -> None:
        self.register_json(["E-003", "E-004"])
        path = self.record_path()
        path.write_text("{ not json", encoding="utf-8")
        done = self.run_validator()
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertEqual(len(self.provenance_fail_lines(done.stdout)), 1, done.stdout)


class RegistrationRefusalTests(Fixture):
    def test_refuses_an_event_that_already_carries_a_marker(self) -> None:
        done = self.register(["E-002"])
        self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("already carry", done.stdout)

    def test_refuses_an_unknown_event(self) -> None:
        done = self.register(["E-999"])
        self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("not found", done.stdout)

    def test_refuses_a_non_canonical_authority(self) -> None:
        done = self.register(["E-003", "E-004"], authority="because-i-said-so")
        self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("authority", done.stdout)

    def test_refuses_overlap_with_an_existing_record(self) -> None:
        self.register_json(["E-003", "E-004"])
        done = self.register(["E-004"])
        self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("ACCEPTED_DEBT_EXISTS", done.stdout)
        self.assertIn("E-4", done.stdout)

    def test_a_broader_registration_may_subsume_a_narrower_one(self) -> None:
        # Narrow first (an honest earlier registration), then the full live
        # set: the narrower record can never match again, the broader one
        # carries the acceptance.
        first = self.register_json(["E-003"])
        self.assertEqual(first["record_id"], "AD-000001")
        second = self.register_json(["E-003", "E-004"])
        self.assertEqual(second["record_id"], "AD-000002")
        done = self.run_validator()
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("WARN [accepted-legacy-debt]:", done.stdout)
        self.assertIn("AD-000002", done.stdout)
        self.assertEqual(self.provenance_fail_lines(done.stdout), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
