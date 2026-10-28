"""T-1434 M3: receipt-only source retirement (SRC-088).

A stale, non-actionable Source must leave CURRENT gating without deleting
history: original bytes preserved in cold storage, an immutable tombstone, and
eligibility that refuses whenever an unresolved actionable requirement would
be discarded. These regressions drive the real public adapter as a subprocess
against a throwaway project, plus the in-process capture helpers.

Run standalone:
    python tools/test_source_retirement.py
"""

from __future__ import annotations

import json
import os
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

from saipen_engine import intake  # noqa: E402

CLI = TOOLS / "saipen.py"
SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"


class SourceRetirementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-source-retire-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        self.config = Path(self.tmp.name) / "user-config"
        self.env = patch.dict(
            os.environ,
            {
                "SAIPEN_USER_CONFIG_HOME": str(self.config),
                "SAIPEN_PROJECT_ROOT": "",
                "SAIPEN_PROJECT_LINEAGE": "",
                "SAIPEN_AGENT": "",
                "SAIPEN_HOST_SESSION": "",
            },
        )
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()

    # -- helpers -------------------------------------------------------------

    def capture(self, body: str = "authoritative source body") -> str:
        result = intake.capture(self.root, body, source_kind="user_audit")
        self.assertTrue(result.get("ok"), result)
        return result["receipt"]

    def add_requirement(self, receipt: str, rid: str = "R001") -> None:
        result = intake.add_requirement(
            self.root, receipt, rid=rid, text=f"Requirement {rid}"
        )
        self.assertTrue(result.get("ok"), result)

    def resolve_requirement(self, receipt: str, rid: str = "R001") -> None:
        result = intake.set_disposition(
            self.root,
            receipt,
            rid,
            "VERIFIED",
            evidence="E-1",
            verification="probe:PASS",
        )
        self.assertTrue(result.get("ok"), result)

    def retire(self, receipt: str, *extra: str) -> tuple[int, dict]:
        proc = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "source",
                "retire",
                receipt,
                *extra,
                "--project-root",
                str(self.root),
                "--agent",
                "tester",
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
        return proc.returncode, payload

    def tombstone(self, receipt: str) -> dict | None:
        return intake._read_index(self.root).get("tombstones", {}).get(receipt)

    def active_body(self, receipt: str) -> Path:
        return self.root / ".saipen/intake/active" / f"{receipt}.md"

    # -- 1 / 8: empty stale source + duplicate retirement --------------------

    def test_empty_stale_source_retires_with_preserved_bytes(self):
        receipt = self.capture("empty body bytes")
        before = self.active_body(receipt).read_bytes()
        rc, payload = self.retire(receipt, "--reason", "EMPTY_STALE_SOURCE")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload.get("code"), "RETIRED")
        self.assertFalse(self.active_body(receipt).exists())
        cold = self.root / payload["archive_ref"]
        self.assertEqual(cold.read_bytes(), before)
        tomb = self.tombstone(receipt)
        self.assertTrue(isinstance(tomb, dict) and tomb.get("retired_at"))
        self.assertEqual(tomb["retirement"]["reason"], "EMPTY_STALE_SOURCE")
        self.assertEqual(tomb["retirement"]["recorded_sha256"], tomb["source_sha256"])
        self.assertFalse(tomb["retirement"]["digest_mismatch"])
        # duplicate: idempotent, zero bytes rewritten
        index_before = (self.root / ".saipen/intake/index.json").read_bytes()
        rc, again = self.retire(receipt, "--reason", "EMPTY_STALE_SOURCE")
        self.assertEqual(rc, 0, again)
        self.assertEqual(again.get("code"), "ALREADY_RETIRED")
        self.assertEqual((self.root / ".saipen/intake/index.json").read_bytes(), index_before)

    # -- 2: VERIFIED-only source (terminal coverage) -------------------------

    def test_verified_only_source_retires_as_orphan(self):
        receipt = self.capture("verified-only source")
        self.add_requirement(receipt)
        self.resolve_requirement(receipt)
        rc, payload = self.retire(receipt, "--reason", "ORPHANED_RECEIPT")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload.get("code"), "RETIRED")
        cold = self.root / payload["archive_ref"]
        self.assertEqual(cold.read_text(encoding="utf-8"), "verified-only source")

    # -- 3 / 4: unresolved actionable requirements refuse --------------------

    def test_unknown_and_blocked_requirements_refuse_and_name_the_route(self):
        receipt = self.capture("actionable source")
        self.add_requirement(receipt)
        rc, payload = self.retire(receipt, "--reason", "EMPTY_STALE_SOURCE")
        self.assertNotEqual(rc, 0)
        self.assertEqual(payload.get("code"), "SOURCE_RETIREMENT_NOT_ELIGIBLE")
        self.assertIn("unresolved actionable", payload.get("message", ""))
        self.assertIn("saipen source disp", payload.get("canonical_next_command", ""))
        self.assertTrue(self.active_body(receipt).exists())
        self.assertIsNone(self.tombstone(receipt))
        # a BLOCKED disposition is equally non-terminal
        result = intake.set_disposition(self.root, receipt, "R001", "BLOCKED")
        self.assertTrue(result.get("ok"), result)
        rc, payload = self.retire(receipt, "--reason", "ORPHANED_RECEIPT")
        self.assertEqual(payload.get("code"), "SOURCE_RETIREMENT_NOT_ELIGIBLE")
        self.assertIn("R001", payload.get("message", ""))

    # -- 5: superseded source needs a real successor --------------------------

    def test_superseded_source_requires_an_existing_successor(self):
        old = self.capture("superseded source")
        rc, payload = self.retire(old, "--reason", "SUPERSEDED_SOURCE")
        self.assertEqual(payload.get("code"), "SOURCE_RETIREMENT_NOT_ELIGIBLE")
        self.assertIn("--successor", payload.get("message", ""))
        rc, payload = self.retire(
            old, "--reason", "SUPERSEDED_SOURCE", "--successor", "SRC-099"
        )
        self.assertEqual(payload.get("code"), "SOURCE_RETIREMENT_NOT_ELIGIBLE")
        self.assertIn("neither ACTIVE nor tombstones", payload.get("message", ""))
        successor = self.capture("the canonic successor body")
        rc, payload = self.retire(
            old, "--reason", "SUPERSEDED_SOURCE", "--successor", successor
        )
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload.get("successor"), successor)

    # -- 6: corrupt digest with the original bytes preserved ------------------

    def test_corrupt_digest_retires_only_as_stale_credential(self):
        receipt = self.capture("original immutable body")
        corrupted = "tampered bytes that no longer match the recorded digest"
        self.active_body(receipt).write_text(corrupted, encoding="utf-8")
        # EMPTY_STALE would hide the corruption; the eligibility gate refuses it
        rc, payload = self.retire(receipt, "--reason", "EMPTY_STALE_SOURCE")
        self.assertEqual(payload.get("code"), "SOURCE_RETIREMENT_NOT_ELIGIBLE")
        self.assertIn("body-digest", payload.get("message", ""))
        rc, payload = self.retire(receipt, "--reason", "STALE_CREDENTIAL")
        self.assertEqual(rc, 0, payload)
        cold = self.root / payload["archive_ref"]
        self.assertEqual(cold.read_text(encoding="utf-8"), corrupted)
        tomb = self.tombstone(receipt)
        self.assertTrue(tomb["retirement"]["digest_mismatch"])
        self.assertNotEqual(
            tomb["retirement"]["measured_sha256"], tomb["retirement"]["recorded_sha256"]
        )

    # -- 9: wrong project binding needs the explicit note ---------------------

    def test_misrouted_binding_requires_a_note(self):
        receipt = self.capture("minted into the wrong project")
        rc, payload = self.retire(receipt, "--reason", "MISROUTED_PROJECT_BINDING")
        self.assertEqual(payload.get("code"), "SOURCE_RETIREMENT_NOT_ELIGIBLE")
        self.assertIn("--note", payload.get("message", ""))
        rc, payload = self.retire(
            receipt,
            "--reason",
            "MISROUTED_PROJECT_BINDING",
            "--note",
            "belongs to the PROBLIP project",
        )
        self.assertEqual(rc, 0, payload)
        self.assertEqual(
            self.tombstone(receipt)["retirement"]["note"], "belongs to the PROBLIP project"
        )

    # -- unknown reason refused before any read -------------------------------

    def test_unknown_reason_is_refused(self):
        receipt = self.capture("body")
        _, payload = self.retire(receipt, "--reason", "BECAUSE_I_SAID_SO")
        self.assertEqual(payload.get("code"), "RETIREMENT_REASON_UNKNOWN")
        self.assertTrue(self.active_body(receipt).exists())

    # -- 7: orphan recovery stays read-only and clean after retirement --------

    def test_orphan_recovery_surface_stays_read_only_after_retirement(self):
        receipt = self.capture("retired body")
        rc, payload = self.retire(receipt, "--reason", "EMPTY_STALE_SOURCE")
        self.assertEqual(rc, 0, payload)
        proc = subprocess.run(
            [
                sys.executable,
                str(CLI),
                "source",
                "recover",
                "--project-root",
                str(self.root),
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )
        self.assertNotIn("Traceback", proc.stderr)
        recovered = json.loads(proc.stdout) if proc.stdout.strip() else {}
        self.assertIsInstance(recovered.get("ok"), bool)


if __name__ == "__main__":
    unittest.main()
