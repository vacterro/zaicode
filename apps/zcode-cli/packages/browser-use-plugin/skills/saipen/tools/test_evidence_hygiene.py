"""T-1317 APPEND: evidence storage-hygiene regressions (storage model).

Pins the required storage model: evidence preserves PROOF, not the
execution environment. Covers the ten required controls plus the
native-smoke placement guarantee.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import evidence as ev  # noqa: E402
from saipen_engine.evidence import (  # noqa: E402
    EvidenceRefusal,
    EvidenceRun,
    check_thresholds,
    migrate_classify,
    prune,
)

_TEMP: list = []


def tempdir() -> Path:
    tmp = tempfile.TemporaryDirectory()
    _TEMP.append(tmp)
    return Path(tmp.name)


class NativeSmokePlacement(unittest.TestCase):
    """Controls 1-2: temp HOME / caches never live under durable evidence."""

    def test_1b_native_smokes_create_their_homes_in_os_temp(self):
        # Source-level pin: the OpenCode/Kiro/Gemini smokes build their
        # synthetic HOMEs with tempfile.mkdtemp (OS temp), never under
        # .saipen. If someone changes that, this control goes red.
        import re

        for test_file in (
            "test_opencode_host_smoke.py",
            "test_guard_hostile_matrix.py",
            "test_native_host_guard.py",
        ):
            source = (TOOLS / test_file).read_text(encoding="utf-8")
            if test_file == "test_opencode_host_smoke.py":
                self.assertIn("EvidenceRun(", source, test_file)
                self.assertIn("register_ephemeral(", source, test_file)
            else:
                self.assertIn("tempfile", source, test_file)
            self.assertIsNone(
                re.search(r"mkdtemp\([^)]*\.saipen", source), test_file
            )

    def test_1_run_temp_root_is_outside_saipen(self):
        run = EvidenceRun("smoke", "T-0001", durable_dir=tempdir() / "evidence")
        self.addCleanup(run.finalize)
        self.assertNotIn(".saipen", str(run.temp_root).lower().replace("\\", "/"))
        self.assertNotIn(str(Path(".saipen").resolve()).lower(), str(run.temp_root).lower())

    def test_2_ephemeral_names_are_classified_reproducible(self):
        root = tempdir() / "evidence"
        (root / "home").mkdir(parents=True)
        (root / "node_modules").mkdir()
        (root / "npm-cache").mkdir()
        report = migrate_classify(root)
        for name in ("home", "node_modules", "npm-cache"):
            self.assertIn("EPHEMERAL_REPRODUCIBLE", str(report), name)
            self.assertTrue(
                any(p.endswith(name) for p in report["EPHEMERAL_REPRODUCIBLE"]), name
            )


class RetentionLifecycle(unittest.TestCase):
    """Controls 3-6: prune on verdict, keep failure proof, protect active refs."""

    def test_3_terminal_verdict_prunes_registered_ephemera(self):
        durable = tempdir() / "evidence"
        run = EvidenceRun("smoke", "T-0002", durable_dir=durable)
        sandbox = run.register_ephemeral("home")[0]
        (sandbox / ".cache").mkdir(parents=True)
        (sandbox / ".cache" / "blob").write_text("x" * 1024, encoding="utf-8")
        artifact = run.temp_root / "transcript.log"
        artifact.write_text("PASS 1/1", encoding="utf-8")
        run.retain(artifact)
        manifest = run.finalize(verdict="VERIFIED")
        self.assertFalse(sandbox.exists())
        self.assertFalse(run.temp_root.exists())
        self.assertTrue((durable / "transcript.log").is_file())
        self.assertEqual(manifest["verdict"], "VERIFIED")
        self.assertIn("home", json.dumps(manifest["discarded_ephemeral"]))

    def test_4_failed_run_keeps_compact_failure_proof_only(self):
        durable = tempdir() / "evidence"
        run = EvidenceRun("smoke", "T-0003", durable_dir=durable)
        sandbox = run.register_ephemeral("home")[0]
        sandbox.mkdir(parents=True, exist_ok=True)
        (sandbox / "big").write_text("y" * (10 * 1024 * 1024), encoding="utf-8")
        failure = run.temp_root / "failure.log"
        failure.write_text("FAIL: reason", encoding="utf-8")
        run.retain(failure)
        run.finalize(verdict="FAILED")
        self.assertFalse(sandbox.exists(), "bulk sandbox must not survive a failed run")
        self.assertFalse(run.temp_root.exists(), "failed run must remove its owned root")
        self.assertTrue((durable / "failure.log").is_file())
        self.assertLess(sum(p.stat().st_size for p in durable.rglob("*") if p.is_file()),
                        ev.MAX_ARTIFACT_BYTES)

    def test_5_unresolved_evidence_referenced_by_a_source_is_not_deleted(self):
        root = tempdir() / "migration"
        bulk = root / "home"
        bulk.mkdir(parents=True)
        (bulk / "state").write_text("proof", encoding="utf-8")
        classified = {str(bulk): "EPHEMERAL_REPRODUCIBLE"}
        removed = prune(root, classified, referenced={str(bulk)})
        self.assertEqual(removed, [])
        self.assertTrue(bulk.exists())

    def test_6_superseded_duplicates_prune_safely(self):
        root = tempdir() / "migration"
        stale = root / "node_modules"
        stale.mkdir(parents=True)
        (stale / "pkg").write_text("old", encoding="utf-8")
        classified = {str(stale): "SUPERSEDED"}
        removed = prune(root, classified)
        self.assertEqual(removed, [str(stale)])
        self.assertFalse(stale.exists())
        # idempotent
        self.assertEqual(prune(root, classified), [])

    def test_prune_refuses_paths_outside_the_migration_root(self):
        outside = tempdir() / "outside"
        outside.mkdir()
        with self.assertRaises(EvidenceRefusal):
            prune(tempdir() / "root", {str(outside): "EPHEMERAL_REPRODUCIBLE"})
        self.assertTrue(outside.exists())


class CleanupSafety(unittest.TestCase):
    """Controls 7 + 10: ownership scoping and idempotence."""

    def test_7_cleanup_refuses_unregistered_and_external_paths(self):
        run = EvidenceRun("smoke", "T-0004", durable_dir=tempdir() / "evidence")
        with self.assertRaises(EvidenceRefusal):
            run.register_ephemeral(Path(tempdir()) / "not-the-run-root")
        with self.assertRaises(EvidenceRefusal):
            run._guard(Path.home() / "somewhere")
        with self.assertRaises(EvidenceRefusal):
            run._guard(Path(".saipen") / "STATE.md")
        with self.assertRaises(EvidenceRefusal):
            run._guard(run.temp_root.parent)  # parent of temp root: unregistered
        outside_proof = tempdir() / "outside.log"
        outside_proof.write_text("secret", encoding="utf-8")
        with self.assertRaises(EvidenceRefusal):
            run.retain(outside_proof)
        run.finalize()

    def test_10_cleanup_is_idempotent(self):
        run = EvidenceRun("smoke", "T-0005", durable_dir=tempdir() / "evidence")
        run.register_ephemeral("home", "cache")
        (run.temp_root / "home").mkdir()
        (run.temp_root / "cache").mkdir()
        first = run.cleanup()
        second = run.cleanup()
        third = run.cleanup()
        self.assertEqual(len(first), 2)
        self.assertEqual(second, [])
        self.assertEqual(third, [])
        run.cleanup()  # finalize-after-cleanup path also safe
        manifest = run.finalize()
        self.assertEqual(len(manifest["discarded_ephemeral"]), 3)
        self.assertFalse(run.temp_root.exists())

    def test_finalize_is_idempotent_and_never_deletes_the_real_home(self):
        run = EvidenceRun("smoke", "T-0006", durable_dir=tempdir() / "evidence")
        run.register_ephemeral("home")
        (run.temp_root / "home").mkdir(exist_ok=True)
        m1 = run.finalize(verdict="VERIFIED")
        m2 = run.finalize(verdict="VERIFIED")
        self.assertEqual(m1["verdict"], m2["verdict"])
        self.assertTrue(Path.home().exists())


class ManifestAdequacy(unittest.TestCase):
    """Control 8: manifest explains what ran and why the verdict holds."""

    def test_manifest_carries_producer_verdict_hashes_and_discards(self):
        durable = tempdir() / "evidence"
        run = EvidenceRun("gemini-smoke", "T-0007", durable_dir=durable)
        sandbox = run.register_ephemeral("home")[0]
        (sandbox / "profile").mkdir(parents=True)
        log = run.temp_root / "out.log"
        log.write_text("blocked: PROTECTED_CANONICAL_NAMESPACE", encoding="utf-8")
        run.retain(log)
        manifest = run.finalize(
            verdict="VERIFIED",
            extra={"command": "python test_opencode_host_smoke.py", "exit": 0},
        )
        self.assertEqual(manifest["producer"], "gemini-smoke")
        self.assertEqual(manifest["verdict"], "VERIFIED")
        self.assertTrue(manifest["retained"][0]["sha256"])
        self.assertEqual(manifest["retained"][0]["class"], "DURABLE_REQUIRED")
        self.assertEqual(manifest["command"], "python test_opencode_host_smoke.py")
        self.assertTrue(manifest["discarded_ephemeral"])
        self.assertTrue(
            all(
                item["class"] == "EPHEMERAL_REPRODUCIBLE"
                for item in manifest["discarded_ephemeral"]
            )
        )
        self.assertIsNotNone(manifest_path(durable))

    def test_historical_classification_is_conservative_and_complete(self):
        root = tempdir() / "historical"
        root.mkdir()
        proof = root / "verdict.json"
        proof.write_text("{}", encoding="utf-8")
        cache = root / "node_modules"
        cache.mkdir()
        unknown = root / "mystery-tree"
        unknown.mkdir()
        duplicate = root / "old-proof.log"
        duplicate.write_text("old", encoding="utf-8")
        report = migrate_classify(root, superseded=[duplicate])
        self.assertEqual(report["DURABLE_REQUIRED"], [str(proof)])
        self.assertEqual(report["EPHEMERAL_REPRODUCIBLE"], [str(cache)])
        self.assertEqual(report["SUPERSEDED"], [str(duplicate)])
        self.assertEqual(report["UNKNOWN"], [str(unknown)])

    def test_nested_reproducible_descendants_do_not_prune_unknown_ancestors(self):
        root = tempdir() / "historical"
        phase = root / "T-144" / "evidence" / "phaseA"
        for name in ("home", ".local", ".cache", "npm-cache", "node_modules"):
            child = phase / name
            child.mkdir(parents=True)
            (child / "blob").write_text(name, encoding="utf-8")
        keep = phase / "verdict.json"
        keep.write_text("{}", encoding="utf-8")
        report = migrate_classify(root)
        self.assertIn(str(root / "T-144"), report["UNKNOWN"])
        self.assertIn(str(phase), report["UNKNOWN"])
        self.assertEqual(
            set(report["EPHEMERAL_REPRODUCIBLE"]),
            {
                str(phase / name)
                for name in ("home", ".local", ".cache", "npm-cache", "node_modules")
            },
        )
        removable = {
            path: "EPHEMERAL_REPRODUCIBLE"
            for path in report["EPHEMERAL_REPRODUCIBLE"]
        }
        removed = prune(root, removable)
        self.assertEqual(set(removed), set(report["EPHEMERAL_REPRODUCIBLE"]))
        self.assertTrue((root / "T-144").is_dir())
        self.assertTrue(keep.is_file())


def manifest_path(durable: Path) -> Path | None:
    files = list(durable.glob("MANIFEST-*.json"))
    return files[0] if files else None


class Thresholds(unittest.TestCase):
    """Control 9: deterministic warning/hard behavior."""

    def test_thresholds_are_deterministic(self):
        root = tempdir() / "evidence"
        root.mkdir(parents=True)
        small = check_thresholds(root)
        self.assertFalse(small["warning"])
        self.assertFalse(small["hard_exceeded"])
        # Warning crossing names the largest paths.
        big = root / "big.bin"
        big.write_bytes(b"\0" * (ev.WARN_BYTES_PER_TICKET + 1))
        report = check_thresholds(root)
        self.assertTrue(report["warning"])
        self.assertTrue(report["largest"])
        self.assertEqual(report["largest"][0]["path"], str(big))

    def test_large_artifact_requires_explicit_reason(self):
        run = EvidenceRun("smoke", "T-0008", durable_dir=tempdir() / "evidence")
        huge = run.temp_root / "huge.bin"
        huge.write_bytes(b"\0" * (ev.MAX_ARTIFACT_BYTES + 1))
        with self.assertRaises(EvidenceRefusal):
            run.retain(huge)
        kept = run.retain(huge, name="huge.bin", large_evidence_required="only failing artifact")
        self.assertTrue(kept.is_file())
        run.finalize(verdict="VERIFIED")

    def test_cumulative_hard_limit_refuses_terminal_without_large_reason(self):
        durable = tempdir() / "evidence"
        run = EvidenceRun("matrix", "T-0010", durable_dir=durable)
        with patch.object(ev, "HARD_BYTES_PER_TICKET", 20_000):
            for index in range(4):
                source = run.temp_root / f"proof-{index}.bin"
                source.write_bytes(bytes([index]) * 5_800)
                run.retain(source)
            self.assertTrue(check_thresholds(durable)["hard_exceeded"])
            with self.assertRaises(EvidenceRefusal) as refusal:
                run.finalize(verdict="VERIFIED")
        self.assertGreater(run.last_threshold_report["total_bytes"], 23_200)
        self.assertIn(str(run.last_threshold_report["total_bytes"]), str(refusal.exception))
        self.assertIn("proof-0.bin", str(refusal.exception))
        self.assertFalse(run.finalized)
        self.assertTrue(run.temp_root.is_dir())
        self.assertEqual(len(list(durable.glob("proof-*.bin"))), 4)
        self.assertFalse(list(durable.glob("MANIFEST-*.json")))
        run.retain(
            run.temp_root / "proof-0.bin", name="proof-0.bin",
            large_evidence_required="needed for failing case",
        )
        with patch.object(ev, "HARD_BYTES_PER_TICKET", 20_000):
            manifest = run.finalize(verdict="VERIFIED")
        self.assertEqual(manifest["verdict"], "VERIFIED")
        self.assertFalse(run.temp_root.exists())

    def test_representative_hundreds_of_mib_matrix_leaves_bounded_proof(self):
        durable = tempdir() / "evidence"
        run = EvidenceRun("matrix", "T-0009", durable_dir=durable)
        home, cache = run.register_ephemeral("home", "npm-cache")
        home.mkdir()
        cache.mkdir()
        with (home / "provider.bin").open("wb") as handle:
            handle.truncate(180 * 1024 * 1024)
        with (cache / "packages.bin").open("wb") as handle:
            handle.truncate(160 * 1024 * 1024)
        proof = run.temp_root / "matrix-result.json"
        proof.write_text('{"verdict":"PASS","cases":10}', encoding="utf-8")
        run.retain(proof)
        manifest = run.finalize(verdict="VERIFIED")
        self.assertFalse(run.temp_root.exists())
        self.assertLess(manifest["retained_bytes"], 1024 * 1024)
        self.assertTrue((durable / "matrix-result.json").is_file())


if __name__ == "__main__":
    unittest.main()
