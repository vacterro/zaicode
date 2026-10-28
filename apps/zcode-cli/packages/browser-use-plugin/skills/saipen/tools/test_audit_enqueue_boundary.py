"""W2-001 / W2-002 regression tests: the audit producer's filesystem boundary.

Reported by an external audit against the v7.249.0 snapshot and reproduced here
before repair, on Windows, both vectors.

W2-001 was a real escape. `_place` wrote to the predictable temporary name
`audit/.enqueue-<layer>.tmp` with `O_CREAT | O_TRUNC` -- no `O_EXCL`, no
`O_NOFOLLOW`, no identity witness -- then `os.replace`d it onto the target.
Planting that node as a symlink or a hardlink to a file OUTSIDE the project
turned the one constrained audit writer into an arbitrary same-permission
truncate-and-write primitive: `_place` returned success, the outside file
became the payload, and the canonical layer was left pointing at it. The escape
completed before canonical-layer validation could reject the result.

W2-002 was the other half. `_place` called `os.write` once and ignored the
returned count, and the retry path promoted a reservation to COMMITTED on
`Path.is_file()` -- which follows symlinks and says nothing about content. So a
short write promoted partial bytes as a complete layer, carrying the digest it
had been HANDED rather than the one on disk.

Proven here:
- a planted temp symlink/hardlink cannot touch the outside file, and the
  enqueue still succeeds because the plantable node is no longer used at all;
- a canonical target that is itself a link is refused, not followed;
- the happy path leaves the exact bytes and no temporary residue;
- "never overwrites a layer" holds against a destination that appears late;
- a retry over bytes that do not match the reservation does not promote them;
- a COMMITTED record whose disk bytes moved is a CONFLICT, never a silent
  overwrite.

Run standalone:
    python tools/test_audit_enqueue_boundary.py
"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import audit_enqueue as AE  # noqa: E402

SENTINEL = b"ORIGINAL-OUTSIDE-BYTES"


def _can_symlink(tmp: Path) -> bool:
    probe = tmp / "_symlink_probe"
    target = tmp / "_symlink_target"
    target.write_bytes(b"x")
    try:
        os.symlink(target, probe)
    except (OSError, NotImplementedError, AttributeError):
        return False
    probe.unlink()
    return True


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.root = self.tmp / "proj"
        (self.root / "audit").mkdir(parents=True)
        self.outside = self.tmp / "outside.txt"
        self.outside.write_bytes(SENTINEL)

    @property
    def temp_node(self) -> Path:
        """The name the pre-repair implementation used, and an attacker knows."""
        return self.root / "audit" / ".enqueue-1.tmp"

    def layer(self, n: int = 1) -> Path:
        return self.root / "audit" / f"{n}.md"


class PlantedTempNodeTests(_Fixture):
    """The escape vector: a node planted where the writer used to write."""

    def test_a_planted_temp_symlink_cannot_reach_the_outside_file(self):
        if not _can_symlink(self.tmp):
            self.skipTest("symlinks unavailable on this host")
        os.symlink(self.outside, self.temp_node)
        AE._place(self.root, 1, b"PAYLOAD")
        self.assertEqual(self.outside.read_bytes(), SENTINEL)

    def test_a_planted_temp_hardlink_cannot_reach_the_outside_file(self):
        try:
            os.link(self.outside, self.temp_node)
        except (OSError, NotImplementedError, AttributeError):
            self.skipTest("hardlinks unavailable on this host")
        AE._place(self.root, 1, b"PAYLOAD-HARDLINK")
        self.assertEqual(self.outside.read_bytes(), SENTINEL)

    def test_the_enqueue_still_succeeds_over_a_planted_node(self):
        """The plant is not a denial of service either: the node is unused.

        Left on disk deliberately. It is not a canonical layer name, the
        consumer reports it as residue, and deleting an attacker-controlled
        node would be a second hazard rather than a cleanup.
        """
        if not _can_symlink(self.tmp):
            self.skipTest("symlinks unavailable on this host")
        os.symlink(self.outside, self.temp_node)
        self.assertIsNone(AE._place(self.root, 1, b"PAYLOAD"))
        self.assertEqual(self.layer().read_bytes(), b"PAYLOAD")
        self.assertFalse(self.layer().is_symlink())


class CanonicalTargetTopologyTests(_Fixture):
    """The final node is witnessed, not assumed."""

    def test_a_canonical_target_that_is_a_link_is_refused_not_followed(self):
        if not _can_symlink(self.tmp):
            self.skipTest("symlinks unavailable on this host")
        os.symlink(self.outside, self.layer())
        result = AE._place(self.root, 1, b"PAYLOAD")
        self.assertIsNotNone(result)
        self.assertEqual(result["code"], "PATH_ESCAPE")
        self.assertEqual(self.outside.read_bytes(), SENTINEL)

    def test_an_existing_layer_is_never_overwritten(self):
        self.layer().write_bytes(b"FIRST")
        result = AE._place(self.root, 1, b"SECOND")
        self.assertIsNotNone(result)
        self.assertEqual(result["code"], "CONFLICT")
        self.assertEqual(self.layer().read_bytes(), b"FIRST")

    def test_the_happy_path_writes_exact_bytes_and_leaves_no_residue(self):
        body = b"# audit\n\nbody bytes\n"
        self.assertIsNone(AE._place(self.root, 1, body))
        self.assertEqual(self.layer().read_bytes(), body)
        leftovers = [p.name for p in (self.root / "audit").iterdir() if p.name != "1.md"]
        self.assertEqual(leftovers, [])

    def test_a_large_body_is_written_whole(self):
        """A complete write, not one `os.write` whose count was ignored."""
        body = (b"0123456789" * 4096) + b"TAIL"
        self.assertIsNone(AE._place(self.root, 1, body))
        self.assertEqual(self.layer().read_bytes(), body)


class RetryPromotionTests(_Fixture):
    """A reservation is promoted by a digest comparison, never by existence."""

    def _reserved(self, layer: int, digest: str) -> dict:
        return {
            "layer": layer,
            "producer": "probe",
            "producer_operation_id": "op-1",
            "producer_item_id": "item-1",
            "created_at": "2026-09-03T00:00:00Z",
            "sha256": digest,
            "state": AE.RESERVED,
        }

    def test_matching_bytes_report_the_digest_on_disk(self):
        body = b"COMPLETE"
        self.layer().write_bytes(body)
        self.assertEqual(
            AE._placed_digest(self.root, 1), hashlib.sha256(body).hexdigest()
        )

    def test_partial_bytes_do_not_match_the_reserved_digest(self):
        """The exact W2-002 shape: 8 of 16 bytes landed."""
        full = b"0123456789abcdef"
        self.layer().write_bytes(full[:8])
        self.assertNotEqual(
            AE._placed_digest(self.root, 1), hashlib.sha256(full).hexdigest()
        )

    def test_an_absent_layer_reports_no_digest(self):
        self.assertIsNone(AE._placed_digest(self.root, 1))

    def test_a_linked_layer_is_not_read_as_a_placement(self):
        """`is_file()` followed the link; the witness does not."""
        if not _can_symlink(self.tmp):
            self.skipTest("symlinks unavailable on this host")
        self.outside.write_bytes(b"COMPLETE")
        os.symlink(self.outside, self.layer())
        self.assertIsNone(AE._placed_digest(self.root, 1))

    def test_a_retry_over_partial_bytes_ends_with_the_reserved_body(self):
        body = b"0123456789abcdef"
        digest = hashlib.sha256(body).hexdigest()
        self.layer().write_bytes(body[:8])
        AE.write_allocator(
            self.root,
            {
                "schema_version": AE.SCHEMA_VERSION,
                "next_id": 2,
                "operations": {AE._op_key("probe", "op-1"): self._reserved(1, digest)},
            },
        )
        result = AE.enqueue(
            self.root,
            producer="probe",
            producer_operation_id="op-1",
            producer_item_id="item-1",
            body=body,
        )
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(self.layer().read_bytes(), body)
        self.assertEqual(AE._placed_digest(self.root, 1), digest)

    def test_a_committed_record_whose_disk_bytes_moved_is_a_conflict(self):
        body = b"COMMITTED-BODY"
        digest = hashlib.sha256(body).hexdigest()
        record = self._reserved(1, digest)
        record["state"] = AE.COMMITTED
        self.layer().write_bytes(b"SOMETHING-ELSE")
        AE.write_allocator(
            self.root,
            {
                "schema_version": AE.SCHEMA_VERSION,
                "next_id": 2,
                "operations": {AE._op_key("probe", "op-1"): record},
            },
        )
        result = AE.enqueue(
            self.root,
            producer="probe",
            producer_operation_id="op-1",
            producer_item_id="item-1",
            body=body,
        )
        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result["code"], "CONFLICT")
        self.assertEqual(self.layer().read_bytes(), b"SOMETHING-ELSE")


class AllocatorCorruptionTests(_Fixture):
    """W2-003: reconstructing `next_id` is not reconstructing idempotence.

    `_reconcile` rebuilds the numeric floor from the directory, this
    allocator's own records and the inbox binding. It cannot rebuild
    ``producer + producer_operation_id -> layer``, which is the sole
    idempotence authority the retry path consults -- so a crash after placement
    plus a damaged allocator used to turn an idempotent retry into duplicate
    dispatch, reported as success.
    """

    def setUp(self) -> None:
        super().setUp()
        (self.root / ".saipen" / "intake").mkdir(parents=True)
        (self.root / ".saipen" / "locks").mkdir(parents=True)

    def _reserve(self, body: bytes) -> str:
        digest = AE.layer_digest(body)
        AE.write_allocator(
            self.root,
            {
                "schema_version": AE.SCHEMA_VERSION,
                "next_id": 2,
                "operations": {
                    AE._op_key("audapack", "op-1"): {
                        "layer": 1,
                        "producer": "audapack",
                        "producer_operation_id": "op-1",
                        "producer_item_id": "item-1",
                        "created_at": "2026-09-03T00:00:00Z",
                        "sha256": digest,
                        "state": AE.RESERVED,
                    }
                },
            },
        )
        return digest

    def _corrupt(self) -> None:
        (self.root / ".saipen" / "intake" / "audit_allocator.json").write_text(
            "{broken", encoding="utf-8"
        )

    def _enqueue(self, op: str, body: bytes) -> dict:
        return AE.enqueue(
            self.root,
            producer="audapack",
            producer_operation_id=op,
            producer_item_id="item-1",
            body=body,
        )

    def test_absent_and_corrupt_are_different_answers(self):
        _doc, state = AE.read_allocator_state(self.root)
        self.assertEqual(state, AE.ALLOCATOR_ABSENT)
        self._corrupt()
        _doc, state = AE.read_allocator_state(self.root)
        self.assertEqual(state, AE.ALLOCATOR_CORRUPT)

    def test_a_fresh_project_still_follows_the_initialization_path(self):
        result = self._enqueue("op-fresh", b"NEW\n")
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["layer"], 1)

    def test_a_corrupt_allocator_refuses_and_writes_no_new_layer(self):
        body = b"AUDIT ONE\n"
        self._reserve(body)
        self.assertIsNone(AE._place(self.root, 1, body))
        self._corrupt()
        result = self._enqueue("op-1", body)
        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result["code"], "ALLOCATOR_CORRUPT")
        self.assertEqual(
            sorted(p.name for p in (self.root / "audit").iterdir()), ["1.md"]
        )

    def test_the_exact_duplicate_dispatch_reproduction_is_closed(self):
        """Crash after placement + corruption + same-op retry => ONE layer."""
        body = b"AUDIT ONE\n"
        self._reserve(body)
        self.assertIsNone(AE._place(self.root, 1, body))
        self._corrupt()
        self._enqueue("op-1", body)
        layers = sorted(p.name for p in (self.root / "audit").iterdir())
        self.assertEqual(layers, ["1.md"], "a second identical layer was dispatched")

    def test_after_an_explicit_repair_a_new_operation_allocates_above_every_layer(self):
        body = b"AUDIT ONE\n"
        self._reserve(body)
        self.assertIsNone(AE._place(self.root, 1, body))
        self._corrupt()
        # The explicit repair an operator performs after confirming the state.
        AE.write_allocator(
            self.root,
            {"schema_version": AE.SCHEMA_VERSION, "next_id": 1, "operations": {}},
        )
        result = self._enqueue("op-2", b"TWO\n")
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result["layer"], 2, "a consumed number must never come back")

    def test_status_surfaces_corruption_instead_of_a_synthetic_empty_allocator(self):
        """`operations: 0` while the file is unreadable reads as an idle queue."""
        self._corrupt()
        report = AE.status(self.root)
        self.assertFalse(report["ok"], report)
        self.assertEqual(report["code"], "AUDIT_ALLOCATOR_CORRUPT")
        self.assertEqual(report["allocator_state"], AE.ALLOCATOR_CORRUPT)

    def test_status_on_a_healthy_allocator_is_unchanged(self):
        self._enqueue("op-fresh", b"NEW\n")
        report = AE.status(self.root)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["code"], "AUDIT_ALLOCATOR_STATUS")
        self.assertEqual(report["allocator_state"], AE.ALLOCATOR_OK)


if __name__ == "__main__":
    unittest.main(verbosity=2)
