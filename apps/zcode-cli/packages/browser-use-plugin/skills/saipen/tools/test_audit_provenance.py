"""Maintainer disposition loop and operator surface (T-1232, T-1234).

The bar the audit set: a producer's identity has to survive the file. Once
`audit/N.md` is journaled away, "who reported this, under which finding id,
which receipt carried it, which Work closed it and how" must still be
answerable -- and answerable READ-ONLY, without opening an audit body and
without exporting anything else about the project.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import audit_enqueue, audit_envelope, audit_inbox  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "userperson-valid" / ".saipen"

ENVELOPED = (
    "<!-- saipen-audit-envelope\n"
    "producer: saipal\n"
    "producer_item_id: PAL-0042\n"
    "severity: critical\n"
    "confidence: high\n"
    "-->\n"
    "\n# finding\n\nA claim, not a verdict.\n"
)


class ProvenanceFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-audit-provenance-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        (self.root / ".saipen" / "USERPERSON.md").unlink(missing_ok=True)
        self.config = Path(self.tmp.name) / "user-config"
        self.env = patch.dict(os.environ, {"SAIPEN_USER_CONFIG_HOME": str(self.config)})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()

    def _bind(self, *, state: str, provenance: dict | None) -> None:
        audit_inbox.bind_layer(
            self.root,
            "audit/1.md",
            layer=1,
            generation=1,
            file_sha256="a" * 64,
            size_bytes=42,
            receipt_id="SRC-001",
            receipt_sha256="a" * 64,
            binding="exact",
            linked_work="T-900",
            state=state,
            provenance=provenance,
        )


class Provenance(ProvenanceFixture):
    def test_producer_claims_are_captured_from_the_envelope(self) -> None:
        record = audit_inbox.layer_provenance(ENVELOPED)
        self.assertEqual(record["envelope"], "valid")
        self.assertEqual(record["claims"]["producer"], "saipal")
        self.assertEqual(record["claims"]["producer_item_id"], "PAL-0042")
        self.assertEqual(record["maintainer_verdict"], audit_envelope.PENDING)

    def test_a_plain_layer_carries_no_provenance_rather_than_an_empty_one(self) -> None:
        self.assertIsNone(audit_inbox.layer_provenance("# finding\n"))

    def test_a_malformed_envelope_is_recorded_as_malformed_not_dropped(self) -> None:
        record = audit_inbox.layer_provenance("<!-- saipen-audit-envelope\nproducer: x\n# body\n")
        self.assertEqual(record["envelope"], "malformed")
        self.assertEqual(record["claims"], {})
        self.assertTrue(record["reason"])

    def test_provenance_survives_the_consumed_file(self) -> None:
        self._bind(state=audit_inbox.ACTIVE, provenance=audit_inbox.layer_provenance(ENVELOPED))
        self._bind(state=audit_inbox.DELETED, provenance=None)
        rows = audit_inbox.provenance_trace(self.root)["rows"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["transport_state"], audit_inbox.DELETED)
        self.assertEqual(row["producer"], "saipal")
        self.assertEqual(row["producer_item_id"], "PAL-0042")
        self.assertEqual(row["receipt"], "SRC-001")
        self.assertEqual(row["work"], "T-900")

    def test_a_later_binding_cannot_rewrite_recorded_claims(self) -> None:
        self._bind(state=audit_inbox.ACTIVE, provenance=audit_inbox.layer_provenance(ENVELOPED))
        forged = {"envelope": "valid", "claims": {"producer": "someone-else"}, "x": 1}
        self._bind(state=audit_inbox.CLOSED_PENDING_DELETE, provenance=forged)
        self.assertEqual(audit_inbox.provenance_trace(self.root)["rows"][0]["producer"], "saipal")

    def test_the_trace_never_trusts_a_producer_verdict(self) -> None:
        self._bind(state=audit_inbox.ACTIVE, provenance=audit_inbox.layer_provenance(ENVELOPED))
        row = audit_inbox.provenance_trace(self.root)["rows"][0]
        self.assertFalse(row["producer_claims_trusted"])
        self.assertEqual(row["maintainer_verdict"], audit_envelope.PENDING)

    def test_the_trace_carries_no_audit_body_text(self) -> None:
        self._bind(state=audit_inbox.ACTIVE, provenance=audit_inbox.layer_provenance(ENVELOPED))
        rendered = json.dumps(audit_inbox.provenance_trace(self.root))
        self.assertNotIn("A claim, not a verdict", rendered)
        self.assertNotIn("# finding", rendered)

    def test_the_trace_can_be_narrowed_to_one_layer(self) -> None:
        self._bind(state=audit_inbox.ACTIVE, provenance=None)
        self.assertEqual(len(audit_inbox.provenance_trace(self.root, 1)["rows"]), 1)
        self.assertEqual(audit_inbox.provenance_trace(self.root, 7)["rows"], [])

    def test_the_trace_writes_nothing(self) -> None:
        self._bind(state=audit_inbox.ACTIVE, provenance=None)
        binding = self.root / ".saipen" / "intake" / "audit_inbox.json"
        before = binding.read_bytes()
        audit_inbox.provenance_trace(self.root)
        self.assertEqual(binding.read_bytes(), before)


class OperatorSurface(ProvenanceFixture):
    def test_last_allocated_id_tracks_the_shared_allocator(self) -> None:
        self.assertIsNone(audit_inbox.status(self.root)["last_allocated_id"])
        audit_enqueue.enqueue(
            self.root, producer="audapack", body=b"# a\n", producer_operation_id="op-1"
        )
        self.assertEqual(audit_inbox.status(self.root)["last_allocated_id"], 1)

    def test_status_counts_do_not_carry_audit_body_text(self) -> None:
        audit_enqueue.enqueue(
            self.root,
            producer="audapack",
            body=b"# secret finding body\n",
            producer_operation_id="op-1",
        )
        rendered = json.dumps(audit_inbox.status(self.root))
        self.assertNotIn("secret finding body", rendered)

    def test_an_absent_audit_directory_renders_no_noise(self) -> None:
        state = audit_inbox.status(self.root)
        self.assertEqual(state["pending"], [])
        self.assertEqual(state["invalid"], [])
        self.assertIsNone(state["last_allocated_id"])


if __name__ == "__main__":
    unittest.main()
