"""Focused hostile/race regressions for the 2026-08-27 second audit wave."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import liveness, producer as producer_module  # noqa: E402
from saipen_engine.journal import Journal, hash_bytes, staged_name  # noqa: E402
from saipen_engine.lock import (  # noqa: E402
    FileWriterLock,
    ProducerLock,
    WriterLock,
)


def _symlink_or_skip(case: unittest.TestCase, target: Path, link: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=target.is_dir())
    except (OSError, NotImplementedError) as exc:
        case.skipTest(f"symlink unavailable: {exc}")


class ProjectCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "project"
        (self.root / ".saipen" / "recovery" / "ops").mkdir(parents=True)
        self.outside = Path(self.temp.name) / "outside"
        self.outside.mkdir()

    def tearDown(self) -> None:
        self.temp.cleanup()


class JournalIntermediateOwnershipTests(ProjectCase):
    def _target(self, content: bytes = b"planned") -> dict:
        return {
            "path": "x.txt",
            "role": "generic",
            "action": "write",
            "before_hash": hash_bytes(b""),
            "after_hash": hash_bytes(content),
            "content": content,
        }

    def test_start_refuses_preexisting_staged_symlink(self) -> None:
        journal = Journal(self.root, "op-migrate-lineage")
        journal.dir.mkdir(parents=True)
        sentinel = self.outside / "sentinel"
        sentinel.write_bytes(b"DO-NOT-TOUCH")
        name = staged_name(0, "x.txt")
        _symlink_or_skip(self, sentinel, journal.dir / name)

        with self.assertRaises((OSError, ValueError)):
            journal.start("test", "codex", "runtime", "payload", [self._target()])

        self.assertEqual(sentinel.read_bytes(), b"DO-NOT-TOUCH")

    def test_old_deterministic_temp_links_are_never_used(self) -> None:
        journal = Journal(self.root, "op-safe-temp")
        journal.dir.mkdir(parents=True)
        sentinel = self.outside / "sentinel"
        sentinel.write_bytes(b"DO-NOT-TOUCH")
        _symlink_or_skip(self, sentinel, journal.dir / "operation.tmp")
        _symlink_or_skip(self, sentinel, journal.dir / "progress.tmp")

        # A pre-manifest same-op directory is now preserved as corrupt
        # evidence.  Even obsolete deterministic temp names cannot authorize
        # reuse or cleanup of the directory by a new invocation.
        with self.assertRaises((OSError, ValueError)):
            journal.start("test", "codex", "runtime", "payload", [self._target()])

        self.assertEqual(sentinel.read_bytes(), b"DO-NOT-TOUCH")
        self.assertFalse(journal.manifest.exists())


class LockOwnershipTests(ProjectCase):
    def _assert_final_symlink_refused(self, factory, relative: Path) -> None:
        lock_path = self.root / relative
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        sentinel = self.outside / (relative.name + ".outside")
        sentinel.write_bytes(b"DO-NOT-TOUCH")
        _symlink_or_skip(self, sentinel, lock_path)

        with self.assertRaises(PermissionError):
            factory().acquire()

        self.assertEqual(sentinel.read_bytes(), b"DO-NOT-TOUCH")

    def test_core_lock_final_symlink_refused(self) -> None:
        self._assert_final_symlink_refused(
            lambda: WriterLock(self.root), Path(".saipen/locks/core.lock")
        )

    def test_producer_lock_final_symlink_refused(self) -> None:
        self._assert_final_symlink_refused(
            lambda: ProducerLock(self.root, "saiwiki"),
            Path(".saipen/locks/producer-saiwiki.lock"),
        )

    def test_generic_lock_final_symlink_refused(self) -> None:
        path = Path(".saipen/locks/generic.lock")
        self._assert_final_symlink_refused(
            lambda: FileWriterLock(self.root / path, self.root), path
        )

    def test_open_failure_unwinds_every_reservation(self) -> None:
        factories = (
            lambda: WriterLock(self.root),
            lambda: ProducerLock(self.root, "saitranslate"),
            lambda: FileWriterLock(self.root / ".saipen" / "locks" / "generic.lock", self.root),
        )
        for factory in factories:
            first = factory()
            injected = mock.patch("saipen_engine.lock.os.open", side_effect=OSError("injected"))
            with injected, self.assertRaises(OSError):
                first.acquire()
            retry = factory()
            retry.acquire()
            retry.release()

    def test_post_open_failure_unwinds_every_reservation(self) -> None:
        factories = (
            lambda: WriterLock(self.root),
            lambda: ProducerLock(self.root, "saiwiki"),
            lambda: FileWriterLock(self.root / ".saipen" / "locks" / "post-open.lock", self.root),
        )
        for factory in factories:
            first = factory()
            injected = mock.patch("saipen_engine.lock._os_lock", side_effect=OSError("injected"))
            with injected, self.assertRaises(OSError):
                first.acquire()
            retry = factory()
            retry.acquire()
            retry.release()


class LivenessRaceTests(ProjectCase):
    def test_two_parallel_identical_observations_preserve_sequence(self) -> None:
        fingerprint = "f" * 32
        gate = threading.Barrier(3)

        def observe() -> dict:
            gate.wait()
            return liveness.record_actionable(self.root, fingerprint)

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(observe) for _ in range(2)]
            gate.wait()
            results = [future.result(timeout=10) for future in futures]

        self.assertEqual(sorted(item["stall_repeats"] for item in results), [1, 2])
        self.assertEqual(sum(bool(item["stalled"]) for item in results), 1)
        cache = json.loads((self.root / liveness.CACHE_REL).read_text(encoding="utf-8"))
        self.assertEqual(cache["repeats"], 2)


class ProducerDescendantOwnershipTests(ProjectCase):
    def _namespace(self) -> Path:
        return self.root / ".saipen" / "saitranslate"

    def _package(self, epoch: int):
        return producer_module.build_package(
            producer="saitranslate",
            role_revision="sha256:role",
            base_source_head="no-git",
            base_source_tree_fingerprint="tree:base",
            base_discovery_model="no-git-tree-v1",
            scope="audit",
            read_set={},
            write_set={"out.txt": "sha256:absent"},
            epoch=epoch,
            status="staging",
        )

    def test_external_epoch_symlink_never_becomes_authority(self) -> None:
        namespace = self._namespace()
        namespace.mkdir(parents=True)
        sentinel = self.outside / "producer_epoch.json"
        sentinel.write_text(
            '{"epoch": 77, "owner": "foreign", "claimed_at": "now"}\n',
            encoding="utf-8",
        )
        _symlink_or_skip(self, sentinel, namespace / producer_module.EPOCH_FILENAME)

        with self.assertRaises(producer_module.ProducerError):
            producer_module.ProducerEpoch.current(namespace)

        self.assertIn('"epoch": 77', sentinel.read_text(encoding="utf-8"))

    def test_staging_root_symlink_blocks_begin_and_recovery(self) -> None:
        namespace = self._namespace()
        epoch = producer_module.ProducerEpoch.claim(namespace)
        outside_staging = self.outside / "staging"
        outside_staging.mkdir()
        sentinel = outside_staging / "sentinel"
        sentinel.write_bytes(b"DO-NOT-TOUCH")
        _symlink_or_skip(
            self,
            outside_staging,
            namespace / producer_module.STAGING_DIRNAME,
        )

        with self.assertRaises(producer_module.ProducerError):
            producer_module.StagingGeneration(namespace, "saitranslate").begin()
        recovered = producer_module.StagingGeneration.recover(namespace, self.root, "saitranslate")

        self.assertTrue(recovered["busy"])
        self.assertEqual(sentinel.read_bytes(), b"DO-NOT-TOUCH")
        self.assertEqual(epoch, 1)

    def test_nested_payload_parent_symlink_blocks_write(self) -> None:
        namespace = self._namespace()
        producer_module.ProducerEpoch.claim(namespace)
        generation = producer_module.StagingGeneration(namespace, "saitranslate").begin()
        outside_payload = self.outside / "payload"
        outside_payload.mkdir()
        sentinel = outside_payload / "sentinel"
        sentinel.write_bytes(b"DO-NOT-TOUCH")
        _symlink_or_skip(self, outside_payload, generation.payload_dir / "nested")

        with self.assertRaises(producer_module.ProducerError):
            generation.add_payload("nested/out.txt", b"hostile")

        self.assertEqual(sentinel.read_bytes(), b"DO-NOT-TOUCH")
        self.assertFalse((outside_payload / "out.txt").exists())

    def test_ready_symlink_blocks_publication(self) -> None:
        namespace = self._namespace()
        epoch = producer_module.ProducerEpoch.claim(namespace)
        generation = producer_module.StagingGeneration(namespace, "saitranslate").begin()
        generation.add_payload("out.txt", b"payload")
        generation.set_package(self._package(epoch))
        outside_ready = self.outside / "ready"
        outside_ready.mkdir()
        sentinel = outside_ready / "sentinel"
        sentinel.write_bytes(b"DO-NOT-TOUCH")
        _symlink_or_skip(self, outside_ready, namespace / producer_module.READY_DIRNAME)

        result = generation.publish()

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "OWNERSHIP_REFUSED")
        self.assertEqual(sentinel.read_bytes(), b"DO-NOT-TOUCH")
        self.assertEqual(list(outside_ready.iterdir()), [sentinel])

    def test_generation_authority_cannot_be_relabelled(self) -> None:
        namespace = self._namespace()
        epoch = producer_module.ProducerEpoch.claim(namespace)
        generation = producer_module.StagingGeneration(namespace, "saitranslate").begin()
        generation.add_payload("out.txt", b"payload")
        with self.assertRaises(producer_module.ProducerError):
            generation.set_package(self._package(epoch + 1))
        with self.assertRaises(producer_module.ProducerError):
            generation.set_package(
                producer_module.build_package(
                    producer="saiwiki",
                    role_revision="sha256:role",
                    base_source_head="no-git",
                    base_source_tree_fingerprint="tree:base",
                    base_discovery_model="no-git-tree-v1",
                    scope="audit",
                    read_set={},
                    write_set={"out.txt": "sha256:absent"},
                    epoch=epoch,
                    status="staging",
                )
            )
        generation.set_package(self._package(epoch))
        generation.manifest_path.write_text(
            json.dumps(
                {"generation_id": generation.generation_id, "producer": "saitranslate",
                 "epoch": epoch + 1}
            ),
            encoding="utf-8",
        )
        result = generation.publish()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "STAGING_CORRUPT")
        self.assertFalse((namespace / producer_module.READY_DIRNAME).exists())
        self.assertTrue(generation.staging_dir.is_dir())

    def test_ready_reuse_rejects_partial_existing_authority(self) -> None:
        namespace = self._namespace()
        epoch = producer_module.ProducerEpoch.claim(namespace)
        package = self._package(epoch)
        ready = namespace / producer_module.READY_DIRNAME
        ready.mkdir(parents=True)
        ready_file = ready / producer_module._ready_filename(package.package_identity)
        ready_file.write_text(json.dumps(package.to_dict()), encoding="utf-8")
        generation = producer_module.StagingGeneration(namespace, "saitranslate").begin()
        generation.add_payload("out.txt", b"payload")
        generation.set_package(package)
        result = generation.publish()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "READY_CORRUPT")
        self.assertTrue(generation.staging_dir.is_dir())

    def test_source_bound_packages_and_retirement_are_non_aliasing(self) -> None:
        namespace = self._namespace()
        epoch = producer_module.ProducerEpoch.claim(namespace)
        def make(source, content):
            package = producer_module.build_package(
                producer="saitranslate",
                role_revision="sha256:role",
                base_source_head=source,
                base_source_tree_fingerprint="tree:" + source,
                base_discovery_model="no-git-tree-v1",
                scope="audit",
                read_set={},
                write_set={"out.txt": "sha256:absent"},
                epoch=epoch,
                status="staging",
            )
            generation = producer_module.StagingGeneration(namespace, "saitranslate").begin()
            generation.add_payload("out.txt", content)
            generation.set_package(package)
            self.assertTrue(generation.publish()["ok"])
            return package
        first = make("A", b"old")
        first = producer_module.StagingGeneration.scan_ready(namespace)[0][0]
        second = make("B", b"new")
        self.assertNotEqual(first.package_identity, second.package_identity)
        producer_module._retire_ready_package(first)
        self.assertTrue(
            producer_module.StagingGeneration.is_ready(namespace, second.package_identity)
        )


if __name__ == "__main__":
    unittest.main()
