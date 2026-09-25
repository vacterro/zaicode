"""Shared audit enqueue producer API (T-1230, SOURCE-AUDIT-ENQUEUE-01).

The acceptance bar of the Wave 6 roadmap doc
(`.saipen/KNOWLEDGE/roadmaps/next-2026-08-31/08_WAVE_6_SHARED_PRODUCER_API.md`): monotonic ids
that survive deletion, no collision between concurrent producers, an
idempotent retry, no overwrite and no path escape, a manual high-numbered drop
that advances the allocator instead of being clobbered, and a layer the native
inbox consumes with no special case.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import shutil
import sys
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import audit_enqueue, audit_inbox  # noqa: E402

SCENARIO = ROOT / "tests" / "scenarios" / "userperson-valid" / ".saipen"

BODY = b"# producer audit\n\nA finding.\n"


class EnqueueFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-audit-enqueue-")
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

    def enqueue(self, op: str, body: bytes = BODY, producer: str = "audapack", **kw) -> dict:
        return audit_enqueue.enqueue(
            self.root,
            producer=producer,
            body=body,
            producer_operation_id=op,
            **kw,
        )

    def allocator(self) -> dict:
        return json.loads(
            (self.root / ".saipen" / "intake" / "audit_allocator.json").read_text("utf-8")
        )

    def consume(self, rel: str, sha256: str, state: str | None = None) -> None:
        """Record the downstream capture the journaled cleanup would leave, then
        delete the bytes -- what a legitimately consumed layer looks like."""
        layer = int(Path(rel).stem)
        audit_inbox.bind_layer(
            self.root,
            rel,
            layer=layer,
            generation=1,
            file_sha256=sha256,
            size_bytes=len(BODY),
            receipt_id=f"SRC-{layer:03d}",
            receipt_sha256="a" * 64,
            binding="exact",
            linked_work=None,
            state=state or audit_inbox.DELETED,
        )
        (self.root / rel).unlink(missing_ok=True)


class Allocation(EnqueueFixture):
    def test_first_enqueue_is_layer_one_and_places_exact_bytes(self) -> None:
        result = self.enqueue("op-1")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["layer"], 1)
        self.assertEqual(result["rel"], "audit/1.md")
        target = self.root / "audit" / "1.md"
        self.assertEqual(target.read_bytes(), BODY)
        self.assertEqual(result["sha256"], hashlib.sha256(BODY).hexdigest())

    def test_ids_are_monotonic_and_never_reuse_a_deleted_number(self) -> None:
        self.assertEqual(self.enqueue("op-1")["layer"], 1)
        self.assertEqual(self.enqueue("op-2")["layer"], 2)
        # A consumed layer is gone from the directory. The next allocation
        # must NOT fall back into the hole -- provenance keys on the number.
        (self.root / "audit" / "1.md").unlink()
        self.assertEqual(self.enqueue("op-3")["layer"], 3)

    def test_a_number_consumed_before_this_allocator_existed_is_never_reissued(self) -> None:
        """The binding outlives the file, and the allocator has to read it.

        A project that consumed `audit/1..3` through the journaled cleanup has
        an EMPTY directory and no allocator operations. A floor derived from
        the disk alone would hand `1` back out, and every provenance record
        keyed on `audit/1.md` would then name two different audits.
        """
        for layer in (1, 2, 3):
            audit_inbox.bind_layer(
                self.root,
                f"audit/{layer}.md",
                layer=layer,
                generation=1,
                file_sha256="a" * 64,
                size_bytes=1,
                receipt_id=f"SRC-{layer:03d}",
                receipt_sha256="a" * 64,
                binding="exact",
                linked_work=None,
                state=audit_inbox.DELETED,
            )
        self.assertEqual(list((self.root / "audit").glob("*.md")), [])
        self.assertEqual(self.enqueue("op-1")["layer"], 4)

    def test_manual_high_drop_advances_the_allocator_and_is_not_overwritten(self) -> None:
        manual = self.root / "audit" / "99.md"
        manual.parent.mkdir(parents=True, exist_ok=True)
        manual.write_bytes(b"# hand-dropped\n")
        result = self.enqueue("op-1")
        self.assertEqual(result["layer"], 100)
        self.assertEqual(manual.read_bytes(), b"# hand-dropped\n")

    def test_no_temp_file_survives_a_successful_enqueue(self) -> None:
        self.enqueue("op-1")
        leftovers = [p.name for p in (self.root / "audit").iterdir() if p.name.startswith(".")]
        self.assertEqual(leftovers, [])


class Idempotency(EnqueueFixture):
    def test_retry_with_same_operation_id_returns_the_original_allocation(self) -> None:
        first = self.enqueue("op-1")
        again = self.enqueue("op-1")
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["layer"], first["layer"])
        self.assertTrue(again["idempotent"])
        self.assertEqual(self.allocator()["next_id"], 2)
        self.assertEqual(len(list((self.root / "audit").glob("*.md"))), 1)

    def test_crash_after_rename_before_commit_promotes_the_same_layer(self) -> None:
        self.enqueue("op-1")
        doc = self.allocator()
        key = next(iter(doc["operations"]))
        doc["operations"][key]["state"] = audit_enqueue.RESERVED
        audit_enqueue.write_allocator(self.root, doc)
        again = self.enqueue("op-1")
        self.assertEqual(again["layer"], 1)
        self.assertEqual(self.allocator()["operations"][key]["state"], audit_enqueue.COMMITTED)
        self.assertEqual(len(list((self.root / "audit").glob("*.md"))), 1)

    def test_crash_after_reservation_before_placement_finishes_the_same_layer(self) -> None:
        # The durable state a process death between reserve and place leaves:
        # the allocation is recorded, the file is not there yet.
        doc = audit_enqueue.read_allocator(self.root)
        doc["operations"][audit_enqueue._op_key("audapack", "op-1")] = {
            "layer": 1,
            "producer": "audapack",
            "producer_operation_id": "op-1",
            "producer_item_id": None,
            "created_at": "2026-08-31T00:00:00Z",
            "sha256": hashlib.sha256(BODY).hexdigest(),
            "state": audit_enqueue.RESERVED,
        }
        doc["next_id"] = 2
        audit_enqueue.write_allocator(self.root, doc)

        again = self.enqueue("op-1")
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["layer"], 1)
        self.assertEqual((self.root / "audit" / "1.md").read_bytes(), BODY)
        self.assertEqual(audit_enqueue.read_allocator(self.root)["next_id"], 2)

    def test_a_refused_placement_frees_the_operation_but_never_the_id(self) -> None:
        with patch.object(
            audit_enqueue, "_place", return_value={"ok": False, "code": "CONFLICT", "detail": "x"}
        ):
            refused = self.enqueue("op-1")
        self.assertFalse(refused["ok"])
        doc = audit_enqueue.read_allocator(self.root)
        self.assertEqual(doc["operations"], {})
        self.assertEqual(doc["next_id"], 2)
        # The retry is a fresh allocation, never a reuse of the spent id.
        self.assertEqual(self.enqueue("op-1")["layer"], 2)

    def test_consumed_layer_does_not_get_re_placed_by_a_late_retry(self) -> None:
        first = self.enqueue("op-1")
        self.consume("audit/1.md", first["sha256"])
        again = self.enqueue("op-1")
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["layer"], 1)
        self.assertFalse(again["present"])
        self.assertEqual(again["binding_state"], audit_inbox.DELETED)
        self.assertFalse((self.root / "audit" / "1.md").exists())

    def test_a_layer_that_vanished_before_any_capture_is_not_called_delivered(self) -> None:
        """SRC-019:R5 -- absent bytes plus no binding is a LOSS, not a delivery.

        The retry branch read COMMITTED plus an absent layer as "the journaled
        cleanup took it" with nothing proving that, so a payload deleted before
        any capture was acknowledged as delivered and the finding was gone.
        """
        self.enqueue("op-1")
        (self.root / "audit" / "1.md").unlink()

        again = self.enqueue("op-1")
        self.assertFalse(again["ok"], again)
        self.assertEqual(again["code"], "NEEDS_REPAIR")
        self.assertIn("audit/1.md", again["detail"])
        self.assertFalse((self.root / "audit" / "1.md").exists())

    def test_a_binding_for_other_bytes_is_not_proof_of_this_delivery(self) -> None:
        self.enqueue("op-1")
        self.consume("audit/1.md", hashlib.sha256(b"# some other audit\n").hexdigest())
        again = self.enqueue("op-1")
        self.assertFalse(again["ok"], again)
        self.assertEqual(again["code"], "NEEDS_REPAIR")

    def test_retry_with_different_bytes_is_refused_not_silently_reallocated(self) -> None:
        self.enqueue("op-1")
        clash = self.enqueue("op-1", body=b"# different\n")
        self.assertFalse(clash["ok"])
        self.assertEqual(clash["code"], "CONFLICT")
        self.assertEqual(len(list((self.root / "audit").glob("*.md"))), 1)

    def test_two_producers_may_share_an_operation_id_without_colliding(self) -> None:
        first = self.enqueue("run-7", producer="audapack")
        second = self.enqueue("run-7", producer="saipal")
        self.assertNotEqual(first["layer"], second["layer"])


class AllocatorLoss(EnqueueFixture):
    """SRC-019:R4 -- the allocator is the only home of `op -> layer`.

    When it goes missing, `_reconcile` rebuilds the numeric floor and cannot
    rebuild the operation map, so a retry used to look exactly like a first
    attempt: a SECOND layer for the same audit, reported `idempotent: false`.
    The bytes outlive the allocator, so they carry the answer.
    """

    def allocator_path(self) -> Path:
        return self.root / ".saipen" / "intake" / "audit_allocator.json"

    def test_retry_after_the_allocator_is_lost_does_not_duplicate_the_layer(self) -> None:
        first = self.enqueue("op-1")
        self.allocator_path().unlink()

        again = self.enqueue("op-1")
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["layer"], first["layer"])
        self.assertTrue(again["idempotent"])
        self.assertEqual(again["recovered_from"], "audit/1.md")
        self.assertEqual(len(list((self.root / "audit").glob("*.md"))), 1)
        self.assertEqual(self.allocator()["next_id"], 2)

    def test_recovery_reads_the_binding_when_the_layer_is_already_consumed(self) -> None:
        first = self.enqueue("op-1")
        audit_inbox.bind_layer(
            self.root,
            "audit/1.md",
            layer=1,
            generation=1,
            file_sha256=first["sha256"],
            size_bytes=len(BODY),
            receipt_id="SRC-001",
            receipt_sha256="a" * 64,
            binding="exact",
            linked_work=None,
            state=audit_inbox.DELETED,
        )
        (self.root / "audit" / "1.md").unlink()
        self.allocator_path().unlink()

        again = self.enqueue("op-1")
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["layer"], 1)
        self.assertTrue(again["idempotent"])
        self.assertFalse(again["present"])
        self.assertEqual(list((self.root / "audit").glob("*.md")), [])

    def test_a_different_audit_still_gets_its_own_layer(self) -> None:
        self.enqueue("op-1")
        self.allocator_path().unlink()

        other = self.enqueue("op-2", body=b"# a different finding\n")
        self.assertTrue(other["ok"], other)
        self.assertEqual(other["layer"], 2)
        self.assertFalse(other["idempotent"])
        self.assertNotIn("recovered_from", other)


class Concurrency(EnqueueFixture):
    def test_concurrent_enqueues_allocate_distinct_layers_with_no_overwrite(self) -> None:
        results: list[dict] = []
        guard = threading.Lock()
        start = threading.Barrier(4)

        def worker(index: int) -> None:
            start.wait()
            outcome = self.enqueue(f"op-{index}", body=f"# audit {index}\n".encode())
            with guard:
                results.append(outcome)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertTrue(all(r["ok"] for r in results), results)
        layers = sorted(r["layer"] for r in results)
        self.assertEqual(layers, [1, 2, 3, 4])
        for outcome in results:
            body = (self.root / "audit" / f"{outcome['layer']}.md").read_bytes()
            self.assertEqual(hashlib.sha256(body).hexdigest(), outcome["sha256"])

    def test_a_scanner_never_observes_a_partially_written_layer(self) -> None:
        """The bytes become a LAYER at the install, never before it.

        The staging file lives in `audit/` (same directory, so the install
        cannot cross a mount) but its name cannot match the canonical regex,
        which is what makes a concurrent `scan_layers` safe without any reader
        lock.

        W2-001: the install call moved from `os.replace` to `os.link`, so the
        spy moved with it. The PROPERTY under test is unchanged and is the
        reason the change was safe to make -- link publishes the canonical name
        in one step exactly as replace did, and additionally cannot clobber a
        destination that appeared after the existence test. A spy left on
        `os.replace` would have gone permanently, silently green here, which is
        the disarmed control this repository keeps meeting.
        """
        observed: list[list[str]] = []
        real_link = os.link

        def spy(src, dst):
            # The allocator commit also writes through a temp file; only the
            # layer placement is the moment under test.
            if str(dst).endswith(".md"):
                observed.append([item["rel"] for item in audit_inbox.scan_layers(self.root)])
            return real_link(src, dst)

        with patch.object(audit_enqueue.os, "link", spy):
            self.enqueue("op-1")
        self.assertEqual(observed, [[]])


class Containment(EnqueueFixture):
    def test_producer_name_must_be_a_stable_token(self) -> None:
        for bad in ("../escape", "AUDAPACK", "", "a/b", "x" * 40):
            outcome = self.enqueue("op-1", producer=bad)
            self.assertFalse(outcome["ok"], bad)
            self.assertEqual(outcome["code"], "VALIDATION_FAILED", bad)

    def test_operation_id_must_be_path_safe(self) -> None:
        for bad in ("../op", "op/1", "op\\1", ".."):
            outcome = self.enqueue(bad)
            self.assertFalse(outcome["ok"], bad)
            self.assertEqual(outcome["code"], "INVALID_ID", bad)

    def test_empty_body_is_refused(self) -> None:
        outcome = self.enqueue("op-1", body=b"   \n")
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["code"], "VALIDATION_FAILED")

    def test_enqueue_never_touches_board_state_or_log(self) -> None:
        watched = {}
        for name in ("BOARD.md", "STATE.md", "LOG.md"):
            path = self.root / ".saipen" / name
            watched[name] = (
                hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
            )
        self.enqueue("op-1")
        for name, before in watched.items():
            path = self.root / ".saipen" / name
            after = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
            self.assertEqual(after, before, name)

    def test_existing_layer_is_never_overwritten(self) -> None:
        doc = audit_enqueue.read_allocator(self.root)
        doc["next_id"] = 5
        audit_enqueue.write_allocator(self.root, doc)
        squatter = self.root / "audit" / "5.md"
        squatter.parent.mkdir(parents=True, exist_ok=True)
        squatter.write_bytes(b"# already here\n")
        # _reconcile normally steps over it; force the collision to prove the
        # placement itself refuses rather than trusting the allocator.
        with patch.object(audit_enqueue, "_reconcile", side_effect=lambda _root, d: d):
            outcome = self.enqueue("op-1")
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["code"], "CONFLICT")
        self.assertEqual(squatter.read_bytes(), b"# already here\n")


class NativeConsumption(EnqueueFixture):
    def test_native_inbox_discovers_an_api_created_layer_normally(self) -> None:
        result = self.enqueue("op-1")
        layers = audit_inbox.scan_layers(self.root)
        self.assertEqual([item["rel"] for item in layers], ["audit/1.md"])
        classified = audit_inbox.classify(self.root)["layers"]
        self.assertEqual(len(classified), 1)
        self.assertEqual(classified[0]["state"], audit_inbox.NEW)
        self.assertEqual(classified[0]["sha256"], result["sha256"])

    def test_allocator_status_is_read_only_and_carries_no_body_text(self) -> None:
        self.enqueue("op-1")
        projection = audit_enqueue.status(self.root)
        self.assertEqual(projection["last_allocated_id"], 1)
        self.assertEqual(projection["reserved"], 0)
        self.assertNotIn("producer audit", json.dumps(projection))


class BoundedAllocatorWait(EnqueueFixture):
    """T-1244: a held allocator refuses in time; it never parks the caller.

    The guard used to be taken before an OS lock acquired with
    `blocking=True`, so a foreign process holding
    `.saipen/locks/audit-allocator.lock` parked the holding thread inside the
    OS wait while it owned the process guard -- every other same-process
    producer then queued behind it with no diagnostic and no bound.
    """

    HOLD_SECONDS = 30
    TIMEOUT = "0.3"

    def setUp(self) -> None:
        super().setUp()
        self.holders: list[subprocess.Popen] = []

    def tearDown(self) -> None:
        # Holders must die BEFORE the fixture directory is removed: unittest
        # runs addCleanup after tearDown, and a live holder keeps an open
        # handle on the lock file that Windows refuses to unlink.
        for holder in self.holders:
            self._stop(holder)
        super().tearDown()

    def hold_lock_in_another_process(self):
        """A real second process holding the real OS lock."""
        code = (
            "import sys,time; from pathlib import Path; "
            "sys.path.insert(0, sys.argv[2]); "
            "from saipen_engine.lock import FileWriterLock; "
            "root=Path(sys.argv[1]); "
            "lock=FileWriterLock("
            "root/'.saipen/locks/audit-allocator.lock',root,blocking=True); "
            "lock.acquire(); print('held',flush=True); "
            f"time.sleep({self.HOLD_SECONDS})"
        )
        holder = subprocess.Popen(
            [sys.executable, "-c", code, str(self.root), str(ROOT / "tools")],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
        self.holders.append(holder)
        # NOT `holder.stderr.read()` as the failure message: that reads to EOF,
        # so it blocks for the entire hold and the "concurrent" holder is gone
        # by the time the assertion under test runs.
        self.assertEqual(holder.stdout.readline().strip(), "held")
        return holder

    @staticmethod
    def _stop(holder) -> None:
        holder.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            holder.communicate(timeout=30)

    def test_a_foreign_holder_yields_writer_busy_within_the_bound(self) -> None:
        self.hold_lock_in_another_process()
        with patch.dict(os.environ, {audit_enqueue.LOCK_TIMEOUT_ENV: self.TIMEOUT}):
            started = time.monotonic()
            outcome = self.enqueue("op-1")
            waited = time.monotonic() - started
        self.assertFalse(outcome["ok"], outcome)
        self.assertEqual(outcome["code"], "WRITER_BUSY")
        self.assertIn("audit-allocator.lock", outcome["detail"])
        self.assertLess(waited, self.HOLD_SECONDS)

    def test_the_process_guard_is_not_held_across_the_wait(self) -> None:
        """Every same-process caller must get its own bounded refusal.

        With the guard held across an unbounded OS wait, the second thread
        below never returned at all. It now refuses with the same named code.
        """
        self.hold_lock_in_another_process()
        outcomes: dict[int, dict] = {}

        def worker(index: int) -> None:
            outcomes[index] = self.enqueue(f"op-{index}")

        with patch.dict(os.environ, {audit_enqueue.LOCK_TIMEOUT_ENV: self.TIMEOUT}):
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
            started = time.monotonic()
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=self.HOLD_SECONDS)
            waited = time.monotonic() - started

        self.assertFalse(any(thread.is_alive() for thread in threads), "a caller was parked")
        self.assertLess(waited, self.HOLD_SECONDS)
        self.assertEqual(len(outcomes), 3, outcomes)
        for index, outcome in outcomes.items():
            self.assertFalse(outcome["ok"], (index, outcome))
            self.assertEqual(outcome["code"], "WRITER_BUSY", (index, outcome))

    def test_normal_contention_still_waits_and_allocates_distinct_ids(self) -> None:
        """The bound is a deadline, not a refusal: ordinary queueing still works."""
        results: dict[int, dict] = {}

        def worker(index: int) -> None:
            results[index] = self.enqueue(f"op-{index}", body=f"# audit {index}".encode())

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        self.assertEqual(len(results), 6, results)
        self.assertTrue(all(item["ok"] for item in results.values()), results)
        layers = sorted(item["layer"] for item in results.values())
        self.assertEqual(layers, [1, 2, 3, 4, 5, 6], layers)

    def test_a_broken_timeout_override_falls_back_to_the_default_never_forever(self) -> None:
        for raw in ("nonsense", "0", "-5", ""):
            with self.subTest(value=raw), patch.dict(
                os.environ, {audit_enqueue.LOCK_TIMEOUT_ENV: raw}
            ):
                self.assertEqual(
                    audit_enqueue.lock_timeout(), audit_enqueue.DEFAULT_LOCK_TIMEOUT
                )


class CliDryRunParityTests(EnqueueFixture):
    """T-1322: `saipen audit enqueue --dry-run` must plan against the SAME
    allocator authority the real call uses. It used to call a non-existent
    `read_operation_record`/`OPERATION_RECORD_CORRUPT` and raised AttributeError,
    so no plan was produced at all."""

    def _plan(self, operation_id: str = "op-dry") -> dict:
        import saipen  # the CLI module (tools/saipen.py)

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc = saipen._audit_enqueue(
                self.root,
                [
                    "--producer",
                    "tester",
                    "--operation-id",
                    operation_id,
                    "--text",
                    "dry audit",
                ],
                True,
                True,
            )
        self.assertEqual(rc, 0, buffer.getvalue())
        return json.loads(buffer.getvalue())

    def test_dry_run_plans_purely_and_matches_the_real_allocator(self) -> None:
        plan = self._plan()
        self.assertEqual(plan["code"], "PLAN")
        self.assertFalse(plan["idempotent"])
        self.assertEqual(plan["writes"], [])
        self.assertEqual(plan["rel"], f"audit/{plan['layer']}.md")
        # the plan did NOT record the operation (pure read)
        doc, allocator_state = audit_enqueue.read_allocator_state(self.root)
        self.assertNotEqual(allocator_state, audit_enqueue.ALLOCATOR_CORRUPT)
        self.assertNotIn(
            audit_enqueue._op_key("tester", "op-dry"), doc["operations"]
        )

        real = self.enqueue("op-dry", body=b"dry audit\n", producer="tester")
        self.assertTrue(real["ok"], real)
        self.assertEqual(real["layer"], plan["layer"])
        self.assertEqual(real["sha256"], plan["sha256"])

        again = self._plan()
        self.assertTrue(again["idempotent"])
        self.assertEqual(again["layer"], plan["layer"])


if __name__ == "__main__":
    unittest.main()
