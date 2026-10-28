"""V7 Producer Parallelism Hardening -- conformance matrix (A..Q).

Run from the `tools/` directory:

    python test_v7_producer_parallelism.py

Covers every DONE/matrix case from the spec:
  A  ee + qq prepare concurrently from the same source
  B  ee + ee cannot corrupt one translation namespace
  C  qq + qq cannot corrupt one wiki namespace
  D  crash halfway through preparation exposes no READY package
  E  stale producer epoch cannot publish after takeover
  F  duplicate identical prepare is idempotent
  G  translate integrates first (irrelevant paths) -> wiki COMPATIBLE_DRIFT
  H  translate changes a wiki read dependency -> wiki STALE
  I  two packages target the same output -> second refused before any write
  J  Core changes an unrelated file -> package stays usable
  K  Core changes a declared producer input -> package STALE
  L  producer attempts Core mutation / ship -> CAPABILITY_DENIED, zero writes
  M  restart between staging and READY -> deterministic recovery, no false READY
  N  all integration serialized through the canonical Core writer lock
  O  persisted READY reopen is strict and payload-bound
  P  integration is journaled before READY leaves the hot set
  Q  completed producer history is settled/superseded outside hot READY
"""

from __future__ import annotations

import contextlib
import json
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from saipen_engine import producer as P
from saipen_engine.capability import (
    CAPABILITY_DENIED,
    assert_producer_capability,
    guard_core_mutation,
)
from saipen_engine.lock import ProducerLock, project_writer_lock


def wf(root: Path, rel: str, content: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def fake_identity(tree_fp: str):
    return type(
        "FakeIdentity",
        (),
        {
            "source_head": "no-git",
            "source_tree_fingerprint": tree_fp,
            "discovery_model": "no-git-tree-v1",
        },
    )()


def classify_now(pkg: P.ProducerPackage, root: Path, base_tree: str, cur_tree: str):
    base = fake_identity(base_tree)
    cur = fake_identity(cur_tree)
    keys = set(pkg.read_set) | set(pkg.write_set)
    cur_hashes = {k: P.file_sha256(Path(root) / k) for k in keys}
    return P.classify_integration(base, cur, pkg.read_set, pkg.write_set, cur_hashes)


class V7Test(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="v7_"))
        self.root = self.tmp / "project"
        self.root.mkdir()
        # canonical source surface used by the producer dependency sets
        wf(self.root, "src/core.py", "def core():\n    return 1\n")
        wf(self.root, "src/wiki.md", "# Wiki\n")
        wf(self.root, "shared/glossary.md", "glossary v1\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_pkg(self, producer, read_paths, write_paths, scope, epoch=0, status="ready"):
        read_set = P.read_set_from(self.root, read_paths)
        write_set = P.write_set_before(self.root, write_paths)
        return P.build_package(
            producer=producer,
            role_revision="sha256:role-" + producer,
            base_source_head="no-git",
            base_source_tree_fingerprint="tree:base",
            base_discovery_model="no-git-tree-v1",
            scope=scope,
            read_set=read_set,
            write_set=write_set,
            epoch=epoch,
            status=status,
        )

    # ------------------------------------------------------------------ A
    def test_A_concurrent_ee_qq_allowed(self):
        with ProducerLock(self.root, "saitranslate") as le, ProducerLock(
            self.root, "saiwiki"
        ) as lq:
            self.assertIsNotNone(le)
            self.assertIsNotNone(lq)
        # lock files are independent and never touch the canonical main tree
        self.assertTrue((self.root / ".saipen/locks/producer-saitranslate.lock").is_file())
        self.assertTrue((self.root / ".saipen/locks/producer-saiwiki.lock").is_file())

    # ------------------------------------------------------------------ B
    def test_B_ee_ee_serialized(self):
        with ProducerLock(self.root, "saitranslate") as held:
            self.assertIsNotNone(held)
            other = ProducerLock(self.root, "saitranslate")
            with self.assertRaises(PermissionError):
                other.acquire()

    # ------------------------------------------------------------------ C
    def test_C_qq_qq_serialized(self):
        with ProducerLock(self.root, "saiwiki") as held:
            self.assertIsNotNone(held)
            other = ProducerLock(self.root, "saiwiki")
            with self.assertRaises(PermissionError):
                other.acquire()

    # ------------------------------------------------------------------ D
    def test_D_crash_leaves_no_ready(self):
        ns = self.root / ".saipen/saitranslate"
        pkg = self._make_pkg("saitranslate", ["src/core.py"], ["translations/ru.md"], "ru")
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.add_payload("translations/ru.md", "partial-")  # incomplete payload
        gen.set_package(pkg)
        # crash: never call publish()
        self.assertFalse(P.StagingGeneration.is_ready(ns, pkg.package_identity))
        self.assertFalse((ns / P.READY_DIRNAME).exists())
        # incomplete staging evidence must remain, not a READY package
        self.assertTrue((ns / P.STAGING_DIRNAME).exists())

    # ------------------------------------------------------------------ E
    def test_E_stale_epoch_cannot_publish(self):
        ns = self.root / ".saipen/saitranslate"
        epoch1 = P.ProducerEpoch.claim(ns)
        pkg = self._make_pkg(
            "saitranslate", ["src/core.py"], ["translations/ru.md"], "ru", epoch=epoch1
        )
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.add_payload("translations/ru.md", "complete content")
        gen.set_package(pkg)
        # takeover: a newer epoch is claimed by someone else
        epoch2 = P.ProducerEpoch.claim(ns)
        self.assertNotEqual(epoch1, epoch2)
        res = gen.publish()
        self.assertFalse(res["ok"])
        self.assertEqual(res["code"], "STALE_WORKER")
        self.assertFalse(P.StagingGeneration.is_ready(ns, pkg.package_identity))

    # ------------------------------------------------------------------ F
    def test_F_idempotent_duplicate_prepare(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        pkg = self._make_pkg(
            "saitranslate", ["src/core.py"], ["translations/ru.md"], "ru", epoch=epoch
        )
        g1 = P.StagingGeneration(ns, "saitranslate").begin()
        g1.add_payload("translations/ru.md", "content")
        g1.set_package(pkg)
        r1 = g1.publish()
        self.assertEqual(r1["code"], "PUBLISHED")
        # identical work prepared again
        g2 = P.StagingGeneration(ns, "saitranslate").begin()
        g2.add_payload("translations/ru.md", "content")
        g2.set_package(pkg)
        r2 = g2.publish()
        self.assertEqual(r2["code"], "REUSED")
        ready_files = list((ns / P.READY_DIRNAME).glob("*.json"))
        self.assertEqual(len(ready_files), 1)  # no duplicate records

    # ------------------------------------------------------------------ G
    def test_G_translate_first_wiki_compatible_drift(self):
        translate = self._make_pkg("saitranslate", ["src/core.py"], ["translations/ru.md"], "ru")
        wiki = self._make_pkg(
            "saiwiki",
            ["src/core.py", "shared/glossary.md"],
            ["wiki/index.md"],
            "wiki",
        )
        # translate integrates first (only touches translations/ru.md)
        wf(self.root, "translations/ru.md", "ru translation\n")
        cls, _ = classify_now(wiki, self.root, "tree:base", "tree:after-ru")
        self.assertEqual(cls, P.IntegrationClass.COMPATIBLE_DRIFT)
        # plan confirms wiki needs no regeneration
        plan = P.plan_integration(
            [translate, wiki],
            fake_identity("tree:base"),
            current_identity_provider=lambda: fake_identity("tree:after-ru"),
            current_hashes_provider=lambda p: {
                k: P.file_sha256(self.root / k) for k in (set(p.read_set) | set(p.write_set))
            },
        )
        wiki_entry = next(e for e in plan["packages"] if e["producer"] == "saiwiki")
        self.assertEqual(wiki_entry["class"], "COMPATIBLE_DRIFT")
        self.assertFalse(wiki_entry["regenerate"])

    # ------------------------------------------------------------------ H
    def test_H_translate_changes_wiki_read_dep_stale(self):
        self._make_pkg(
            "saitranslate",
            ["shared/glossary.md"],
            ["translations/ru.md", "shared/glossary.md"],
            "ru",
        )
        wiki = self._make_pkg(
            "saiwiki",
            ["src/core.py", "shared/glossary.md"],
            ["wiki/index.md"],
            "wiki",
        )
        # translate integration rewrites the glossary that wiki reads
        wf(self.root, "translations/ru.md", "ru\n")
        wf(self.root, "shared/glossary.md", "glossary v2 CHANGED\n")
        cls, reason = classify_now(wiki, self.root, "tree:base", "tree:after")
        self.assertEqual(cls, P.IntegrationClass.STALE)
        self.assertIn("glossary", reason)

    # ------------------------------------------------------------------ I
    def test_I_same_output_second_refused(self):
        a = self._make_pkg("saitranslate", ["src/core.py"], ["out/x.md"], "a")
        b = self._make_pkg("saiwiki", ["src/core.py"], ["out/x.md"], "b")
        written = []

        def apply(pkg, root):
            written.append(pkg.package_identity)
            wf(root, "out/x.md", "from " + pkg.producer)

        res = P.integrate_packages_core([a, b], self.root, apply_write=apply)
        a_res = next(r for r in res["results"] if r["producer"] == "saitranslate")
        b_res = next(r for r in res["results"] if r["producer"] == "saiwiki")
        self.assertEqual(a_res["result"], "INTEGRATED")
        self.assertEqual(b_res["result"], "REFUSED")
        self.assertFalse(b_res["wrote"])
        self.assertEqual(written, [a.package_identity])  # b never wrote
        # explicit conflict model must flag the write/write collision
        conf = P.derive_conflicts(a, b)
        self.assertFalse(conf["compatible"])
        self.assertTrue(conf["write_write"])

    # ------------------------------------------------------------------ J
    def test_J_core_unrelated_change_usable(self):
        pkg = self._make_pkg("saitranslate", ["src/core.py"], ["translations/ru.md"], "ru")
        wf(self.root, "src/unrelated_impl.py", "totally new code\n")  # irrelevant to pkg
        cls, _ = classify_now(pkg, self.root, "tree:base", "tree:unrelated")
        self.assertNotEqual(cls, P.IntegrationClass.STALE)
        self.assertEqual(cls, P.IntegrationClass.COMPATIBLE_DRIFT)

    # ------------------------------------------------------------------ K
    def test_K_core_changes_declared_input_stale(self):
        pkg = self._make_pkg("saitranslate", ["src/core.py"], ["translations/ru.md"], "ru")
        wf(self.root, "src/core.py", "def core():\n    return 999  # changed\n")  # declared input
        cls, reason = classify_now(pkg, self.root, "tree:base", "tree:changed")
        self.assertEqual(cls, P.IntegrationClass.STALE)
        self.assertIn("src/core.py", reason)

    # ------------------------------------------------------------------ L
    def test_L_producer_core_mutation_denied(self):
        ok, code, _ = assert_producer_capability("ship", producer="saitranslate")
        self.assertFalse(ok)
        self.assertEqual(code, CAPABILITY_DENIED)

        ok, code, _ = assert_producer_capability("mutate_core_state", producer="saiwiki")
        self.assertFalse(ok)
        self.assertEqual(code, CAPABILITY_DENIED)

        ok, code, _ = assert_producer_capability("read_source", producer="saitranslate")
        self.assertTrue(ok)

        # guard refuses any producer write that would touch Core canonical truth
        blocked, _why = guard_core_mutation(self.root / ".saipen/STATE.md")
        self.assertTrue(blocked)
        # and a denied action performs ZERO canonical writes
        state_path = self.root / ".saipen/STATE.md"
        state_path.parent.mkdir(parents=True, exist_ok=True)
        state_path.write_text("ORIGINAL\n")
        blocked, _ = guard_core_mutation(state_path)
        self.assertTrue(blocked)
        self.assertEqual(state_path.read_text(), "ORIGINAL\n")  # unchanged

    # ------------------------------------------------------------------ M
    def test_M_restart_recovery_no_false_ready(self):
        ns = self.root / ".saipen/saiwiki"
        # a valid published package exists first
        epoch = P.ProducerEpoch.claim(ns)
        good = self._make_pkg("saiwiki", ["src/wiki.md"], ["wiki/index.md"], "good", epoch=epoch)
        gg = P.StagingGeneration(ns, "saiwiki").begin()
        gg.add_payload("wiki/index.md", "good content")
        gg.set_package(good)
        gg.publish()
        self.assertTrue(P.StagingGeneration.is_ready(ns, good.package_identity))
        # now a crashed staging generation appears (incomplete, never published)
        crashed = P.StagingGeneration(ns, "saiwiki").begin()
        crashed.add_payload("wiki/index.md", "partial")  # never published
        crashed.set_package(
            self._make_pkg("saiwiki", ["src/wiki.md"], ["wiki/index.md"], "crashed", epoch=epoch)
        )
        # A restart/takeover must advance ownership before cleanup. Merely
        # observing an in-flight marker at the current epoch cannot prove the
        # producer is dead; concurrent recovery must preserve it.
        preserved = P.StagingGeneration.recover(ns)
        self.assertEqual(preserved["removed_staging"], [])
        self.assertTrue(crashed.staging_dir.is_dir())
        P.ProducerEpoch.claim(ns)
        # takeover -> deterministic stale-generation recovery
        report = P.StagingGeneration.recover(ns)
        self.assertTrue(report["removed_staging"])
        self.assertFalse(report["false_ready"])
        # the valid READY package survives; the crashed staging generation is gone
        self.assertTrue(P.StagingGeneration.is_ready(ns, good.package_identity))
        self.assertFalse(list((ns / P.STAGING_DIRNAME).glob("*")))  # no orphan generations

    # ------------------------------------------------------------------ N
    def test_N_serialized_through_core_writer_lock(self):
        a = self._make_pkg("saitranslate", ["src/core.py"], ["translations/ru.md"], "a")
        b = self._make_pkg("saiwiki", ["src/wiki.md"], ["wiki/index.md"], "b")
        written = []

        def apply(pkg, root):
            written.append(pkg.package_identity)
            wf(root, next(iter(pkg.write_set)), "payload")

        res = P.integrate_packages_core([a, b], self.root, apply_write=apply)
        for r in res["results"]:
            self.assertEqual(r["result"], "INTEGRATED")
        # deterministic order: by (producer, package_identity) -- translate before
        # wiki, never by incidental hash ordering.
        self.assertEqual(res["results"][0]["producer"], "saitranslate")
        self.assertEqual(res["results"][1]["producer"], "saiwiki")

        # N (hard): integration must go through project_writer_lock.
        # Hold the canonical lock in the main thread; a concurrent integration
        # in another thread must be refused (WRITER_BUSY) -> proves serialization.
        exc = {}

        def try_integrate():
            try:
                P.integrate_packages_core([a], self.root, apply_write=apply)
            except PermissionError as e:  # WRITER_BUSY from project_writer_lock
                exc["raised"] = e

        with project_writer_lock(self.root):
            t = threading.Thread(target=try_integrate)
            t.start()
            t.join(timeout=10)
        self.assertIn("raised", exc)

    def test_O_ready_reopen_is_strict_and_payload_bound(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        pkg = self._make_pkg(
            "saitranslate", ["src/core.py"], ["translations/ru.md"], "strict", epoch
        )
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.set_package(pkg)
        gen.add_payload("translations/ru.md", "strict payload\n")
        published = gen.publish()
        self.assertTrue(published["ok"], published)
        reopened, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors, [])
        self.assertEqual(reopened[0].payloads["translations/ru.md"], b"strict payload\n")

        ready_file = next((ns / P.READY_DIRNAME).glob("*.json"))
        forged = json.loads(ready_file.read_text(encoding="utf-8"))
        forged["payload_hashes"]["translations/ru.md"] = "sha256:forged"
        ready_file.write_text(json.dumps(forged), encoding="utf-8")
        candidates, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(candidates, [])
        self.assertEqual(errors[0]["code"], "INVALID_READY")

    def test_P_integration_is_journaled_then_leaves_hot_ready(self):
        from saipen_engine.journal import semantic_receipts_for_operation

        ns = self.root / ".saipen/saiwiki"
        epoch = P.ProducerEpoch.claim(ns)
        pkg = self._make_pkg("saiwiki", ["src/wiki.md"], ["wiki/index.md"], "journaled", epoch)
        gen = P.StagingGeneration(ns, "saiwiki").begin()
        gen.set_package(pkg)
        gen.add_payload("wiki/index.md", "# Integrated\n")
        self.assertTrue(gen.publish()["ok"])
        ready, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors, [])
        result = P.integrate_packages_core(ready, self.root, agent="producer-test")
        self.assertEqual(result["results"][0]["result"], "INTEGRATED")
        self.assertEqual((self.root / "wiki/index.md").read_text(), "# Integrated\n")
        self.assertEqual(P.StagingGeneration.list_ready(ns), [])
        self.assertEqual(len(list((ns / P.SETTLED_DIRNAME).glob("*.json"))), 1)
        receipts = semantic_receipts_for_operation(self.root, "producer_integration")
        self.assertEqual(len(receipts), 1)
        meta = receipts[0]["receipt_metadata"]
        self.assertEqual(meta["package_identity"], pkg.package_identity)
        self.assertIn("resulting_source_fingerprint", meta)

    def test_Q_completed_history_does_not_grow_hot_ready_set(self):
        ns = self.root / ".saipen/saiwiki"
        packages = []
        for index in range(25):
            epoch = P.ProducerEpoch.claim(ns)
            rel = f"wiki/history-{index:03d}.md"
            pkg = self._make_pkg("saiwiki", ["src/wiki.md"], [rel], f"history-{index}", epoch)
            gen = P.StagingGeneration(ns, "saiwiki").begin()
            gen.set_package(pkg)
            gen.add_payload(rel, f"# Revision {index}\n")
            self.assertTrue(gen.publish()["ok"])
            packages.append(pkg)

        ready, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors, [])
        self.assertEqual(len(ready), 25)
        newest = max(ready, key=lambda package: package.epoch)
        result = P.integrate_packages_core([newest], self.root, agent="producer-test")
        self.assertEqual(result["results"][0]["result"], "INTEGRATED")
        self.assertEqual(P.StagingGeneration.list_ready(ns), [])
        self.assertEqual(len(list((ns / P.SETTLED_DIRNAME).glob("*.json"))), 1)
        self.assertEqual(len(list((ns / P.SUPERSEDED_DIRNAME).glob("*.json"))), 24)

    def _publish(self, ns, producer, read_paths, write_paths, scope, content, epoch):
        pkg = self._make_pkg(producer, read_paths, write_paths, scope, epoch=epoch)
        gen = P.StagingGeneration(ns, producer).begin()
        for rel in write_paths:
            gen.add_payload(rel, content)
        gen.set_package(pkg)
        return gen, pkg

    def test_w2_001_takeover_epoch_cannot_publish_old_generation(self):
        ns = self.root / ".saipen/saitranslate"
        epoch1 = P.ProducerEpoch.claim(ns)
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.add_payload("translations/ru.md", "old content")
        gen.set_package(
            self._make_pkg(
                "saitranslate",
                ["src/core.py"],
                ["translations/ru.md"],
                "ru",
                epoch=epoch1,
            )
        )
        epoch2 = P.ProducerEpoch.claim(ns)
        with self.assertRaises(P.ProducerError):
            gen.set_package(
                self._make_pkg(
                    "saitranslate",
                    ["src/core.py"],
                    ["translations/ru.md"],
                    "ru",
                    epoch=epoch2,
                )
            )
        result = gen.publish()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "STALE_WORKER")
        self.assertFalse(P.StagingGeneration.is_ready(ns, gen.package.package_identity))
        self.assertTrue(gen.staging_dir.is_dir())

    def test_w2_001_cross_role_package_refused(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.add_payload("translations/ru.md", "content")
        with self.assertRaises(P.ProducerError):
            gen.set_package(
                self._make_pkg(
                    "saiwiki",
                    ["src/core.py"],
                    ["translations/ru.md"],
                    "wiki",
                    epoch=epoch,
                )
            )
        result = gen.publish()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "NO_PACKAGE")
        self.assertFalse((ns / P.READY_DIRNAME).exists())

    def test_w2_001_tampered_manifest_refused(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.add_payload("translations/ru.md", "content")
        gen.set_package(
            self._make_pkg(
                "saitranslate",
                ["src/core.py"],
                ["translations/ru.md"],
                "ru",
                epoch=epoch,
            )
        )
        marker = json.loads((gen.staging_dir / ".in-flight").read_text(encoding="utf-8"))
        marker["epoch"] = epoch + 1
        gen.manifest_path.write_text(json.dumps(marker), encoding="utf-8")
        result = gen.publish()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "STAGING_CORRUPT")
        self.assertFalse((ns / P.READY_DIRNAME).exists())

    def test_w2_001_normal_generation_publishes(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        gen, pkg = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        result = gen.publish()
        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "PUBLISHED")
        self.assertTrue(P.StagingGeneration.is_ready(ns, pkg.package_identity))

    def test_w2_002_staging_shaped_ready_refused(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        pkg = self._make_pkg(
            "saitranslate", ["src/core.py"], ["translations/ru.md"], "ru", epoch=epoch
        )
        ready = ns / P.READY_DIRNAME
        ready.mkdir(parents=True, exist_ok=True)
        (ready / P._ready_filename(pkg.package_identity)).write_text(
            json.dumps(pkg.to_dict()), encoding="utf-8"
        )
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.add_payload("translations/ru.md", "content")
        gen.set_package(pkg)
        result = gen.publish()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "READY_CORRUPT")
        self.assertTrue(gen.staging_dir.is_dir())
        self.assertTrue((ready / P._ready_filename(pkg.package_identity)).is_file())

    def test_w2_002_valid_strict_ready_reused_once(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        gen, _pkg = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        self.assertTrue(gen.publish()["ok"])
        gen2, _ = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        result = gen2.publish()
        self.assertEqual(result["code"], "REUSED")
        self.assertEqual(len(list((ns / P.READY_DIRNAME).glob("*.json"))), 1)

    def test_w2_002_ready_with_wrong_producer_refused(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        gen, _ = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        self.assertTrue(gen.publish()["ok"])
        ready = ns / P.READY_DIRNAME
        ready_files = list(ready.glob("*.json"))
        self.assertEqual(len(ready_files), 1)
        ready_file = ready_files[0]
        data = json.loads(ready_file.read_text(encoding="utf-8"))
        data["producer"] = "saiwiki"
        ready_file.write_text(json.dumps(data), encoding="utf-8")
        gen2, _ = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        result = gen2.publish()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "READY_CORRUPT")
        self.assertTrue(gen2.staging_dir.is_dir())

    def test_w2_003_manifest_only_staging_preserved_after_takeover(self):
        ns = self.root / ".saipen/saiwiki"
        P.ProducerEpoch.claim(ns)
        gen = P.StagingGeneration(ns, "saiwiki").begin()
        manifest = gen.manifest_path.read_text(encoding="utf-8")
        (gen.staging_dir / ".in-flight").unlink()
        gen.manifest_path.write_text(manifest, encoding="utf-8")
        P.ProducerEpoch.claim(ns)
        report = P.StagingGeneration.recover(ns)
        self.assertEqual(report["removed_staging"], [])
        self.assertTrue(gen.staging_dir.is_dir())
        self.assertTrue(report["invalid_staging"])

    def test_w2_003_marker_only_staging_removed_only_after_takeover(self):
        ns = self.root / ".saipen/saiwiki"
        P.ProducerEpoch.claim(ns)
        gen = P.StagingGeneration(ns, "saiwiki").begin()
        gen.manifest_path.unlink()
        report = P.StagingGeneration.recover(ns)
        self.assertEqual(report["removed_staging"], [])
        self.assertTrue(gen.staging_dir.is_dir())
        P.ProducerEpoch.claim(ns)
        report = P.StagingGeneration.recover(ns)
        self.assertIn(gen.generation_id, report["removed_staging"])
        self.assertFalse(gen.staging_dir.exists())

    def test_w2_004_source_distinct_packages_do_not_alias(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)

        def publish(source, tree, content):
            pkg = P.build_package(
                producer="saitranslate",
                role_revision="sha256:role",
                base_source_head=source,
                base_source_tree_fingerprint=tree,
                base_discovery_model="no-git-tree-v1",
                scope="ru",
                read_set=P.read_set_from(self.root, ["src/core.py"]),
                write_set=P.write_set_before(self.root, ["translations/ru.md"]),
                epoch=epoch,
                status="staging",
            )
            gen = P.StagingGeneration(ns, "saitranslate").begin()
            gen.add_payload("translations/ru.md", content)
            gen.set_package(pkg)
            self.assertTrue(gen.publish()["ok"])
            return pkg

        a = publish("A", "tree:A", b"old")
        b = publish("B", "tree:B", b"new")
        self.assertNotEqual(a.package_identity, b.package_identity)
        stale = P.StagingGeneration.scan_ready(ns)[0][0]
        self.assertTrue(P.StagingGeneration.is_ready(ns, b.package_identity))
        if stale.package_identity == a.package_identity:
            P._retire_ready_package(stale)
            self.assertTrue(P.StagingGeneration.is_ready(ns, b.package_identity))
            self.assertFalse(P.StagingGeneration.is_ready(ns, a.package_identity))

    def test_w2_004_retirement_cas_blocks_foreign_artifact_at_path(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        first = self._make_pkg(
            "saitranslate", ["src/core.py"], ["translations/ru.md"], "ru", epoch=epoch
        )
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.add_payload("translations/ru.md", "old")
        gen.set_package(first)
        self.assertTrue(gen.publish()["ok"])
        second = P.build_package(
            producer="saitranslate",
            role_revision="sha256:role",
            base_source_head="B",
            base_source_tree_fingerprint="tree:B",
            base_discovery_model="no-git-tree-v1",
            scope="ru",
            read_set=first.read_set,
            write_set=first.write_set,
            epoch=epoch,
            status="staging",
        )
        gen2 = P.StagingGeneration(ns, "saitranslate").begin()
        gen2.add_payload("translations/ru.md", "new")
        gen2.set_package(second)
        self.assertTrue(gen2.publish()["ok"])
        forged = P.build_package(
            producer="saitranslate",
            role_revision="sha256:role",
            base_source_head="A",
            base_source_tree_fingerprint="tree:A",
            base_discovery_model="no-git-tree-v1",
            scope="ru",
            read_set=first.read_set,
            write_set=first.write_set,
            epoch=epoch,
            status="staging",
        )
        forged_ready_path = (
            ns / P.READY_DIRNAME / P._ready_filename(second.package_identity)
        )
        object.__setattr__(forged, "ready_path", forged_ready_path)
        with self.assertRaises((P.ConflictError, P.ProducerError)):
            P._retire_ready_package(forged)
        self.assertTrue(P.StagingGeneration.is_ready(ns, second.package_identity))

    # ------------------------------------------------------------------
    # W2-002 VERIFY: every malformed/partial pre-placed READY carrier is a
    # stable refusal, never a false REUSED success and never a staging loss.
    # ------------------------------------------------------------------
    def _publish_then_corrupt_ready(self, corrupt):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        gen, _ = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        self.assertTrue(gen.publish()["ok"], gen.publish())
        ready_files = list((ns / P.READY_DIRNAME).glob("*.json"))
        self.assertEqual(len(ready_files), 1)
        corrupt(ready_files[0])
        return ns, epoch

    def test_w2_002_ready_missing_payload_hashes_refused(self):
        def corrupt(ready_file: Path) -> None:
            data = json.loads(ready_file.read_text(encoding="utf-8"))
            data.pop("payload_hashes", None)
            ready_file.write_text(json.dumps(data), encoding="utf-8")

        ns, epoch = self._publish_then_corrupt_ready(corrupt)
        gen2, _ = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        result = gen2.publish()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "READY_CORRUPT", result)
        self.assertTrue(gen2.staging_dir.is_dir(), "valid staging must stay recoverable")
        self.assertEqual(len(list((ns / P.READY_DIRNAME).glob("*.json"))), 1)

    def test_w2_002_ready_missing_payload_bytes_refused(self):
        def corrupt(ready_file: Path) -> None:
            data = json.loads(ready_file.read_text(encoding="utf-8"))
            data.pop("payload_bytes", None)
            ready_file.write_text(json.dumps(data), encoding="utf-8")

        ns, epoch = self._publish_then_corrupt_ready(corrupt)
        gen2, _ = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        result = gen2.publish()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "READY_CORRUPT", result)
        self.assertTrue(gen2.staging_dir.is_dir())

    def test_w2_002_malformed_ready_json_refused(self):
        def corrupt(ready_file: Path) -> None:
            ready_file.write_text("{not json", encoding="utf-8")

        ns, epoch = self._publish_then_corrupt_ready(corrupt)
        gen2, _ = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        result = gen2.publish()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "READY_CORRUPT", result)
        self.assertTrue(gen2.staging_dir.is_dir())

    def test_w2_002_ready_filename_identity_mismatch_refused(self):
        """A strictly valid READY stored under another identity's filename is
        not that identity's authority. The strict decoder compares the declared
        identity against the expected one, so the mismatch refuses instead of
        being reused as if it were the prepared package."""
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        gen_a, _ = self._publish(
            ns,
            "saitranslate",
            ["src/core.py"],
            ["translations/ru.md"],
            "ru",
            b"content",
            epoch,
        )
        self.assertTrue(gen_a.publish()["ok"])
        ready_dir = ns / P.READY_DIRNAME
        source_file = next(iter(ready_dir.glob("*.json")))
        other = P.build_package(
            producer="saitranslate",
            role_revision="sha256:role-saitranslate",
            base_source_head="no-git",
            base_source_tree_fingerprint="tree:other",
            base_discovery_model="no-git-tree-v1",
            scope="ru",
            read_set=P.read_set_from(self.root, ["src/core.py"]),
            write_set=P.write_set_before(self.root, ["translations/ru.md"]),
            epoch=epoch,
            status="staging",
        )
        # Relabel the published artifact under the *other* identity's filename.
        (ready_dir / P._ready_filename(other.package_identity)).write_bytes(
            source_file.read_bytes()
        )
        gen_b = P.StagingGeneration(ns, "saitranslate").begin()
        gen_b.add_payload("translations/ru.md", "content")
        gen_b.set_package(other)
        result = gen_b.publish()
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "READY_CORRUPT", result)
        self.assertTrue(gen_b.staging_dir.is_dir())

    # ------------------------------------------------------------------
    # W2-003 VERIFY: split authority carriers that disagree, or that omit the
    # identity the first carrier must carry, are reported -- never silently
    # preserved forever and never deleted without abandonment proof.
    # ------------------------------------------------------------------
    def test_w2_003_marker_manifest_epoch_mismatch_is_invalid_not_deleted(self):
        ns = self.root / ".saipen/saiwiki"
        epoch1 = P.ProducerEpoch.claim(ns)
        gen = P.StagingGeneration(ns, "saiwiki").begin()
        marker = json.loads((gen.staging_dir / ".in-flight").read_text(encoding="utf-8"))
        self.assertEqual(marker["epoch"], epoch1)
        marker["epoch"] = epoch1 + 5
        (gen.staging_dir / ".in-flight").write_text(
            json.dumps(marker, sort_keys=True), encoding="utf-8"
        )
        P.ProducerEpoch.claim(ns)
        report = P.StagingGeneration.recover(ns)
        self.assertEqual(report["removed_staging"], [])
        self.assertTrue(gen.staging_dir.is_dir())
        self.assertTrue(report["invalid_staging"])
        self.assertEqual(
            {entry["code"] for entry in report["invalid_staging"]},
            {"INCOMPLETE_STAGING"},
        )

    def test_w2_003_marker_manifest_generation_id_mismatch_is_invalid_not_deleted(self):
        ns = self.root / ".saipen/saiwiki"
        P.ProducerEpoch.claim(ns)
        gen = P.StagingGeneration(ns, "saiwiki").begin()
        marker = json.loads((gen.staging_dir / ".in-flight").read_text(encoding="utf-8"))
        marker["generation_id"] = "foreign-generation-id"
        (gen.staging_dir / ".in-flight").write_text(
            json.dumps(marker, sort_keys=True), encoding="utf-8"
        )
        P.ProducerEpoch.claim(ns)
        report = P.StagingGeneration.recover(ns)
        self.assertEqual(report["removed_staging"], [])
        self.assertTrue(gen.staging_dir.is_dir())
        self.assertTrue(report["invalid_staging"])

    def test_w2_003_marker_identity_shape_violation_is_invalid_not_deleted(self):
        """W2-003 repair: the FIRST durable carrier must be sufficient by
        itself. A marker missing generation identity is unclassifiable, so it
        is reported as incomplete staging rather than left invisible forever."""
        ns = self.root / ".saipen/saiwiki"
        P.ProducerEpoch.claim(ns)
        gen = P.StagingGeneration(ns, "saiwiki").begin()
        (gen.staging_dir / ".in-flight").write_text(
            json.dumps({"epoch": 0}), encoding="utf-8"
        )
        P.ProducerEpoch.claim(ns)
        report = P.StagingGeneration.recover(ns)
        self.assertEqual(report["removed_staging"], [])
        self.assertTrue(gen.staging_dir.is_dir())
        self.assertTrue(report["invalid_staging"])

    def test_w2_003_every_begin_crash_cut_is_classifiable_after_takeover(self):
        """Fault-inject a crash after each `begin()` filesystem step. Every
        reachable partial state must converge deterministically: either it is
        removed under the exact abandonment proof (marker authority at a
        superseded epoch) or it is reported as incomplete -- never an
        unclassifiable orphan that recovery silently ignores."""
        ns = self.root / ".saipen/saiwiki"
        # Step 0: generation dir only. Step 1: + payload dir.
        # Step 2: + .in-flight (first authority carrier).
        # Step 3: + staging.manifest.json (complete).
        for cut in range(4):
            with self.subTest(crash_cut=cut):
                P.ProducerEpoch.claim(ns)
                gen = P.StagingGeneration(ns, "saiwiki").begin()
                if cut == 0:
                    (gen.staging_dir / ".in-flight").unlink()
                    gen.manifest_path.unlink()
                    (gen.staging_dir / "payload").rmdir()
                elif cut == 1:
                    (gen.staging_dir / ".in-flight").unlink()
                    gen.manifest_path.unlink()
                elif cut == 2:
                    gen.manifest_path.unlink()
                # Takeover: the generation's epoch is now superseded.
                P.ProducerEpoch.claim(ns)
                report = P.StagingGeneration.recover(ns)
                converged = bool(report["removed_staging"]) or bool(
                    report.get("invalid_staging")
                )
                self.assertTrue(
                    converged,
                    f"crash cut {cut} produced an unclassifiable orphan: {report}",
                )
                # A second recovery must be idempotent: the same verdict, no
                # new deletions of evidence that survived the first pass.
                second = P.StagingGeneration.recover(ns)
                self.assertEqual(second["removed_staging"], [])
                if cut >= 2:
                    # The `.in-flight` marker is the FIRST durable carrier and
                    # now carries generation_id/producer/epoch by itself, so a
                    # superseded marker-only or complete generation holds the
                    # mechanical abandonment proof and is removed exactly once.
                    self.assertIn(gen.generation_id, report["removed_staging"])
                    self.assertFalse(gen.staging_dir.exists())
                else:
                    # No authority carrier at all: unclassifiable, so it is
                    # reported for explicit recovery instead of deleted.
                    self.assertEqual(
                        report["removed_staging"],
                        [],
                        f"crash cut {cut} deleted evidence without a marker proof",
                    )
                    self.assertTrue(gen.staging_dir.is_dir())
                with contextlib.suppress(OSError):
                    shutil.rmtree(gen.staging_dir, ignore_errors=True)

    # ------------------------------------------------------------------
    # W2-004 VERIFY: stale handles and SETTLED collisions across source
    # generations.
    # ------------------------------------------------------------------
    def _publish_source_bound(self, ns, epoch, head, tree, content):
        pkg = P.build_package(
            producer="saitranslate",
            role_revision="sha256:role",
            base_source_head=head,
            base_source_tree_fingerprint=tree,
            base_discovery_model="no-git-tree-v1",
            scope="ru",
            read_set=P.read_set_from(self.root, ["src/core.py"]),
            write_set=P.write_set_before(self.root, ["translations/ru.md"]),
            epoch=epoch,
            status="staging",
        )
        gen = P.StagingGeneration(ns, "saitranslate").begin()
        gen.add_payload("translations/ru.md", content)
        gen.set_package(pkg)
        self.assertTrue(gen.publish()["ok"], gen.publish())
        return pkg

    def test_w2_004_scan_a_publish_b_then_retire_stale_a_leaves_b_ready(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        package_a = self._publish_source_bound(ns, epoch, "A", "tree:A", b"old")
        scanned, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors, [])
        stale_a = next(
            item for item in scanned if item.package_identity == package_a.package_identity
        )
        stale_ready_path = stale_a.ready_path
        self.assertIsNotNone(stale_ready_path)

        package_b = self._publish_source_bound(ns, epoch, "B", "tree:B", b"new")
        self.assertNotEqual(package_a.package_identity, package_b.package_identity)

        P._retire_ready_package(stale_a)

        self.assertTrue(
            P.StagingGeneration.is_ready(ns, package_b.package_identity),
            "stale retirement must not move or delete the newer source-bound artifact",
        )
        self.assertFalse(P.StagingGeneration.is_ready(ns, package_a.package_identity))
        self.assertFalse(stale_ready_path.exists())

    def test_w2_004_retire_a_then_publish_and_retire_b_keeps_both_generations(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        package_a = self._publish_source_bound(ns, epoch, "A", "tree:A", b"old")
        scanned, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors, [])
        handle_a = next(
            item for item in scanned if item.package_identity == package_a.package_identity
        )
        P._retire_ready_package(handle_a)

        package_b = self._publish_source_bound(ns, epoch, "B", "tree:B", b"new")
        scanned_b, errors_b = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors_b, [])
        handle_b = next(
            item for item in scanned_b if item.package_identity == package_b.package_identity
        )
        P._retire_ready_package(handle_b)

        settled = {path.name for path in (ns / P.SETTLED_DIRNAME).glob("*.json")}
        self.assertEqual(len(settled), 2, settled)
        self.assertIn(P._ready_filename(package_a.package_identity), settled)
        self.assertIn(P._ready_filename(package_b.package_identity), settled)
        self.assertEqual(list((ns / P.READY_DIRNAME).glob("*.json")), [])

    def test_w2_004_duplicate_retirement_is_idempotent_and_never_duplicates_settled(self):
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        self._publish_source_bound(ns, epoch, "A", "tree:A", b"old")
        scanned, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors, [])
        first = scanned[0]
        P._retire_ready_package(first)
        # A second retirement of the very same handle is a legal retry after a
        # crash between the move and the caller's own bookkeeping.
        P._retire_ready_package(first)
        settled = list((ns / P.SETTLED_DIRNAME).glob("*.json"))
        self.assertEqual(len(settled), 1, settled)
        self.assertEqual(P.StagingGeneration.list_ready(ns), [])

    def test_w2_004_settled_collision_with_different_content_refuses(self):
        """An existing SETTLED destination may be treated idempotently only
        when it is content-equivalent; otherwise the newer generation's
        terminal evidence must not be silently discarded."""
        ns = self.root / ".saipen/saitranslate"
        epoch = P.ProducerEpoch.claim(ns)
        package_a = self._publish_source_bound(ns, epoch, "A", "tree:A", b"old")
        scanned, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors, [])
        handle_a = next(
            item for item in scanned if item.package_identity == package_a.package_identity
        )
        P._retire_ready_package(handle_a)
        settled_path = ns / P.SETTLED_DIRNAME / P._ready_filename(package_a.package_identity)
        self.assertTrue(settled_path.is_file())
        settled_path.write_text(
            json.dumps({"producer": "saitranslate", "forged": True}), encoding="utf-8"
        )

        # Re-create the same identity in READY, then attempt retirement: the
        # destination is NOT content-equivalent, so the collision must refuse
        # rather than unlink the current READY artifact.
        package_a_again = self._publish_source_bound(ns, epoch, "A", "tree:A", b"old")
        self.assertEqual(package_a.package_identity, package_a_again.package_identity)
        scanned, errors = P.StagingGeneration.scan_ready(ns)
        self.assertEqual(errors, [])
        handle_again = next(
            item for item in scanned if item.package_identity == package_a_again.package_identity
        )
        with self.assertRaises((P.ConflictError, P.ProducerError)):
            P._retire_ready_package(handle_again)
        self.assertTrue(P.StagingGeneration.is_ready(ns, package_a_again.package_identity))


if __name__ == "__main__":
    unittest.main(verbosity=2)
