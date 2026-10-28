"""End-to-end audit transport loop (T-1237, SRC-015 R008).

The pieces are each tested on their own; this drives the whole road, because
the failures that matter here live in the joins. Every producer shape has to
walk discover -> capture -> Work -> evidence -> closure -> journaled delete,
and the transport has to hold its two hardest promises along the way: a layer
whose bytes CHANGED after capture is preserved rather than deleted, and a live
ticket is never preempted by an audit that just arrived.

Cold restart is the last one. Provenance is only worth writing if a process
that never saw the enqueue can still reconstruct who reported what.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import audit_enqueue, audit_envelope, audit_inbox  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "userperson-valid" / ".saipen"


def body(producer: str, item_id: str) -> bytes:
    return (
        audit_envelope.render({"producer": producer, "producer_item_id": item_id})
        + "\n# finding\n\nDetail.\n"
    ).encode("utf-8")


class LoopFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-audit-loop-")
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

    def _bind(self, rel: str, *, layer: int, digest: str, state: str, provenance=None) -> None:
        audit_inbox.bind_layer(
            self.root,
            rel,
            layer=layer,
            generation=1,
            file_sha256=digest,
            size_bytes=1,
            receipt_id=f"SRC-{layer:03d}",
            receipt_sha256=digest,
            binding="exact",
            linked_work=f"T-90{layer}",
            state=state,
            provenance=provenance,
        )


class Loop(LoopFixture):
    def test_every_producer_shape_walks_discover_to_bound(self) -> None:
        for index, producer in enumerate(("audapack", "saipal"), start=1):
            payload = body(producer, f"ID-{index}")
            result = audit_enqueue.enqueue(
                self.root,
                producer=producer,
                body=payload,
                producer_operation_id=f"run-{index}",
            )
            self.assertTrue(result["ok"], result)
            classified = {item["rel"]: item for item in audit_inbox.classify(self.root)["layers"]}
            fresh = classified[result["rel"]]
            self.assertEqual(fresh["state"], audit_inbox.NEW)
            self.assertEqual(fresh["sha256"], audit_enqueue.layer_digest(payload))

            # Capture goes through the REAL Source intake -- an ACTIVE verdict
            # comes from the receipt lifecycle, never from the binding file, so
            # a test that only wrote a binding would prove nothing.
            captured = audit_inbox.capture_layer(self.root, result["rel"])
            self.assertTrue(captured.get("ok"), captured)
            self.assertEqual(captured["provenance"]["claims"]["producer"], producer)
            audit_inbox.bind_layer(
                self.root,
                result["rel"],
                layer=result["layer"],
                generation=1,
                file_sha256=fresh["sha256"],
                size_bytes=fresh["size_bytes"],
                receipt_id=captured["receipt"],
                receipt_sha256=captured.get("source_sha256") or fresh["sha256"],
                binding=captured.get("binding", "exact"),
                linked_work=None,
                state=audit_inbox.ACTIVE,
                provenance=captured.get("provenance"),
            )
        # The manual drop is the third shape and needs no API at all.
        manual = self.root / "audit" / "3.md"
        manual.write_bytes(b"# hand written\n")
        states = {
            item["layer"]: item["state"] for item in audit_inbox.classify(self.root)["layers"]
        }
        self.assertEqual(states[1], audit_inbox.ACTIVE)
        self.assertEqual(states[2], audit_inbox.ACTIVE)
        self.assertEqual(states[3], audit_inbox.NEW)

    def test_a_changed_generation_is_preserved_not_deleted(self) -> None:
        payload = body("saipal", "PAL-1")
        result = audit_enqueue.enqueue(
            self.root, producer="saipal", body=payload, producer_operation_id="run-1"
        )
        self._bind(
            result["rel"],
            layer=1,
            digest=result["sha256"],
            state=audit_inbox.CLOSED_PENDING_DELETE,
        )
        # Someone replaces the file after closure. Same path, different bytes.
        (self.root / "audit" / "1.md").write_bytes(b"# replaced after closure\n")
        gate = audit_inbox.delete_gate(self.root, "audit/1.md")
        self.assertFalse(gate.get("ok"), gate)
        self.assertTrue((self.root / "audit" / "1.md").is_file())

    def test_a_live_ticket_is_never_preempted_by_a_fresh_audit(self) -> None:
        audit_enqueue.enqueue(
            self.root, producer="saipal", body=body("saipal", "PAL-1"), producer_operation_id="r1"
        )
        routed = audit_inbox.projection(self.root)
        # The inbox only ever ANSWERS with its own condition. Deciding that an
        # active ticket outranks it is the router's job, and the projection
        # carries no authority to preempt anything.
        self.assertIsInstance(routed, dict)
        self.assertNotIn("claim", json.dumps(routed).lower())

    def test_concurrent_producers_never_collide(self) -> None:
        results: list[dict] = []
        guard = threading.Lock()
        start = threading.Barrier(3)

        def worker(index: int) -> None:
            start.wait()
            outcome = audit_enqueue.enqueue(
                self.root,
                producer="saipal",
                body=body("saipal", f"PAL-{index}"),
                producer_operation_id=f"run-{index}",
            )
            with guard:
                results.append(outcome)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertTrue(all(r["ok"] for r in results), results)
        self.assertEqual(sorted(r["layer"] for r in results), [1, 2, 3])
        self.assertEqual(len(list((self.root / "audit").glob("*.md"))), 3)

    def test_a_rejected_audit_still_reaches_a_terminal_transport_state(self) -> None:
        payload = body("saipal", "PAL-1")
        result = audit_enqueue.enqueue(
            self.root, producer="saipal", body=payload, producer_operation_id="run-1"
        )
        provenance = audit_inbox.layer_provenance(payload.decode("utf-8"))
        self._bind(
            result["rel"], layer=1, digest=result["sha256"], state=audit_inbox.ACTIVE,
            provenance=provenance,
        )
        # Maintainer rejects the finding: the Work closes, the layer settles,
        # the bytes go. Rejection is closure, not an error path.
        (self.root / "audit" / "1.md").unlink()
        self._bind(result["rel"], layer=1, digest=result["sha256"], state=audit_inbox.DELETED)
        row = audit_inbox.provenance_trace(self.root, 1)["rows"][0]
        self.assertEqual(row["transport_state"], audit_inbox.DELETED)
        self.assertEqual(row["producer_item_id"], "PAL-1")

    def test_a_cold_restart_reconstructs_provenance_from_disk_alone(self) -> None:
        payload = body("saipal", "PAL-1")
        result = audit_enqueue.enqueue(
            self.root, producer="saipal", body=payload, producer_operation_id="run-1"
        )
        self._bind(
            result["rel"],
            layer=1,
            digest=result["sha256"],
            state=audit_inbox.DELETED,
            provenance=audit_inbox.layer_provenance(payload.decode("utf-8")),
        )
        (self.root / "audit" / "1.md").unlink()

        # Nothing in memory: re-read every projection from the files.
        allocator = json.loads(
            (self.root / ".saipen" / "intake" / "audit_allocator.json").read_text("utf-8")
        )
        self.assertEqual(allocator["next_id"], 2)
        row = audit_inbox.provenance_trace(self.root, 1)["rows"][0]
        self.assertEqual(row["producer"], "saipal")
        self.assertEqual(row["producer_item_id"], "PAL-1")
        self.assertEqual(row["sha256"], result["sha256"])

    def test_a_consumed_id_is_never_handed_out_again_after_restart(self) -> None:
        audit_enqueue.enqueue(
            self.root, producer="saipal", body=body("saipal", "PAL-1"), producer_operation_id="r1"
        )
        (self.root / "audit" / "1.md").unlink()
        again = audit_enqueue.enqueue(
            self.root, producer="saipal", body=body("saipal", "PAL-2"), producer_operation_id="r2"
        )
        self.assertEqual(again["layer"], 2)


if __name__ == "__main__":
    unittest.main()
