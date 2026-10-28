"""Regressions for the 2026-08-28 CORE/W2/performance audit handoff."""

from __future__ import annotations

import datetime as dt
import io
import hashlib
import json
import os
import subprocess
import shutil
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_control_primitives import ControlFixture  # noqa: E402

from saipen_engine import (  # noqa: E402
    conformance,
    intake,
    liveness,
    log as log_engine,
    operations,
    producer,
    test_runner,
)
import saipen_engine.journal as journal  # noqa: E402
from saipen_engine.controls import (  # noqa: E402
    _project_tree_fingerprint,
    _read_text_lossy,
    _undo_op_id,
    create_milestone,
    undo_confirm,
)
from saipen_engine.paths import project_lineage_identity  # noqa: E402
from saipen_engine.journal import (  # noqa: E402
    SETTLED_DIR,
    SETTLED_INDEX_REL,
    hash_bytes,
    run_mutation,
    semantic_receipt_snapshot,
)
from saipen_engine import release as release_engine  # noqa: E402
from saipen_engine.release import _stage_release_content  # noqa: E402
from saipen_engine.release_contract import release_metadata_paths  # noqa: E402
from saipen_engine.snapshot import canonical_identity  # noqa: E402


def _file_snapshot(paths: list[Path]) -> dict[str, bytes | None]:
    return {str(path): path.read_bytes() if path.is_file() else None for path in paths}


def _git(root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        text=True,
        check=False,
    )


class IntakeAuditTests(ControlFixture):
    def _resolved_receipt(self, body: str = "closed audit evidence\n") -> tuple[Path, str]:
        root = self.make_project()
        captured = intake.capture(root, body, source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        self.assertTrue(
            intake.add_requirement(
                root,
                rid,
                rid="R001",
                text="Close only after verified coverage",
            )["ok"]
        )
        self.assertTrue(
            intake.set_disposition(
                root,
                rid,
                "R001",
                "VERIFIED",
                evidence="E-1",
                verification="focused:PASS",
            )["ok"]
        )
        return root, rid

    @staticmethod
    def _interrupt_after_archive(root: Path, rid: str) -> None:
        meta_path = root / f".saipen/intake/active/{rid}.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta.update(
            {
                "status": intake.CLOSED_STATUS,
                "closed_at": "2026-08-28T00:00:00Z",
                "reread_at": "2026-08-28T00:00:00Z",
                "closure_event": "E-1",
            }
        )
        intake._archive_closed_locked(root, rid, meta)

    def test_release_surface_preserves_source_authority_in_fresh_clone(self) -> None:
        root = self.make_project(active=True)
        (root / ".gitattributes").write_text(
            "* text=auto\n.saipen/intake/** -text\n.saipen/archive/source/** -text\n",
            encoding="utf-8",
        )
        self.assertEqual(_git(root, "init", "-q").returncode, 0)
        self.assertEqual(_git(root, "config", "user.name", "fixture").returncode, 0)
        self.assertEqual(
            _git(root, "config", "user.email", "fixture@example.invalid").returncode,
            0,
        )
        self.assertEqual(_git(root, "add", "-A").returncode, 0)
        self.assertEqual(_git(root, "commit", "-qm", "baseline").returncode, 0)

        captured = intake.capture(
            root,
            "authoritative audit body\n",
            source_kind="external_audit",
            work="T-7",
        )
        self.assertTrue(captured["ok"], captured)
        source_paths = tuple(
            path.as_posix()
            for path in release_metadata_paths(root)
            if path.as_posix().startswith(".saipen/intake/")
            or path.as_posix().startswith(".saipen/archive/source/")
        )
        self.assertTrue(source_paths)
        self.assertEqual(_git(root, "ls-files", ".saipen/intake").stdout.strip(), "")

        plan = SimpleNamespace(
            release_paths=(*source_paths, ".saipen/BOARD.md"),
        )
        staged = _stage_release_content(root, plan)
        self.assertTrue(staged["ok"], staged)
        self.assertEqual(_git(root, "commit", "-qm", "source authority").returncode, 0)

        clone = root.parent / "fresh-clone"
        self.assertEqual(_git(root.parent, "clone", "-q", str(root), str(clone)).returncode, 0)
        self.assertEqual(intake.validate_project(clone), [])
        self.assertTrue((clone / ".saipen/intake/active/SRC-001.md").is_file())

    def _partial_archive(self) -> tuple[Path, str, list[Path]]:
        root = self.make_project()
        captured = intake.capture(root, "recovery evidence\n", source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        active = root / ".saipen" / "intake"
        archive = root / ".saipen" / "archive" / "source"
        archive.mkdir(parents=True)
        body = active / "active" / f"{rid}.md"
        archive_body = archive / f"{rid}.md"
        os.replace(body, archive_body)
        meta = json.loads(
            (active / "active" / f"{rid}.meta.json").read_text(encoding="utf-8")
        )
        meta.update(
            {
                "status": intake.CLOSED_STATUS,
                "closed_at": "2026-08-28T00:00:00Z",
                "storage_status": intake.ARCHIVED_STATUS,
                "archive_ref": f".saipen/archive/source/{rid}.md",
            }
        )
        (archive / f"{rid}.meta.json").write_text(
            json.dumps(meta, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        carriers = [
            active / "active" / f"{rid}.meta.json",
            active / "coverage" / f"{rid}.json",
            active / "contracts" / f"{rid}.json",
        ]
        return root, rid, carriers

    def test_corrupt_partial_archive_refusal_is_zero_write(self) -> None:
        root, rid, carriers = self._partial_archive()
        archive_meta = root / ".saipen" / "archive" / "source" / f"{rid}.meta.json"
        meta = json.loads(archive_meta.read_text(encoding="utf-8"))
        meta["source_sha256"] = "0" * 64
        archive_meta.write_text(
            json.dumps(meta, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        before = _file_snapshot([*carriers, archive_meta])

        first = intake.close_receipt(root, rid)
        second = intake.close_receipt(root, rid)

        self.assertEqual(first["code"], "SOURCE_CORRUPTION", first)
        self.assertEqual(second["code"], "SOURCE_CORRUPTION", second)
        self.assertEqual(_file_snapshot([*carriers, archive_meta]), before)

    def test_source_body_limits_apply_before_write_and_during_recovery(self) -> None:
        root = self.make_project()
        with mock.patch.object(intake, "_BODY_MAX", 16):
            refused = intake.capture(root, "x" * 17, source_kind="external_audit")
        self.assertFalse(refused["ok"], refused)
        self.assertEqual(list((root / ".saipen/intake/active").glob("SRC-*.md")), [])

        rid = "SRC-900"
        active = root / ".saipen" / "intake" / "active"
        archive = root / ".saipen" / "archive" / "source"
        active.mkdir(parents=True, exist_ok=True)
        archive.mkdir(parents=True, exist_ok=True)
        (active / f"{rid}.meta.json").write_text("{}\n", encoding="utf-8")
        (archive / f"{rid}.meta.json").write_text("{}\n", encoding="utf-8")
        (archive / f"{rid}.md").write_bytes(b"x" * (intake._META_MAX + 1))
        index = {"active": {rid: {"source_sha256": "0" * 64}}}
        self.assertTrue(intake._is_archive_commit_pending(root, rid, index))

    def test_archive_recovery_proves_bundle_before_settlement(self) -> None:
        root, rid = self._resolved_receipt()
        self._interrupt_after_archive(root, rid)

        recovered = intake.close_receipt(root, rid)

        self.assertTrue(recovered["ok"], recovered)
        self.assertTrue(recovered.get("recovered"), recovered)
        self.assertEqual(intake.validate_project(root), [])

        bad_root, bad_rid = self._resolved_receipt("drifted archive\n")
        self._interrupt_after_archive(bad_root, bad_rid)
        coverage_path = bad_root / f".saipen/archive/source/{bad_rid}.coverage.json"
        coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
        coverage["requirements"][f"{bad_rid}:R001"].update(
            {"disposition": "UNKNOWN", "evidence": None, "verification": None}
        )
        coverage_path.write_text(json.dumps(coverage, sort_keys=True), encoding="utf-8")
        watched = [coverage_path, bad_root / ".saipen/intake/index.json"]
        before = _file_snapshot(watched)

        first = intake.close_receipt(bad_root, bad_rid)
        second = intake.close_receipt(bad_root, bad_rid)

        self.assertEqual(first["code"], "SOURCE_CORRUPTION", first)
        self.assertEqual(second["code"], "SOURCE_CORRUPTION", second)
        self.assertEqual(_file_snapshot(watched), before)

    def test_archived_status_refuses_corrupt_coverage(self) -> None:
        root, rid = self._resolved_receipt()
        self.assertTrue(intake.close_receipt(root, rid)["ok"])
        coverage_path = root / f".saipen/archive/source/{rid}.coverage.json"
        coverage_path.write_bytes(b"{not-json")

        status = intake.status(root, rid)

        self.assertFalse(status["ok"], status)
        self.assertEqual(status["code"], "SOURCE_CORRUPTION", status)
        self.assertTrue(any(rid in problem for problem in intake.validate_project(root)))

    def test_release_gate_refuses_indexed_receipt_without_metadata(self) -> None:
        root = self.make_project()
        captured = intake.capture(root, "indexed source\n", source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        (root / f".saipen/intake/active/{rid}.meta.json").unlink()

        gate = intake.release_gate(root)

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_CORRUPTION", gate)
        self.assertIn(rid, gate.get("detail", ""))


class JournalAuditTests(ControlFixture):
    def test_same_op_corrupt_journal_retry_preserves_evidence(self) -> None:
        root = self.make_project()
        op_dir = root / ".saipen/recovery/ops/same-op"
        op_dir.mkdir(parents=True)
        staged = op_dir / "0_old.staged"
        staged.write_bytes(b"OLD-EVIDENCE")
        before = _file_snapshot([staged])

        result = run_mutation(
            root,
            "same-op",
            "test",
            "tester",
            canonical_identity(root),
            "payload",
            [{"path": "x.txt", "role": "generic", "content": b"new"}],
            preconditions={"x.txt": ""},
            _ensure_lineage=False,
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "CORRUPT_JOURNAL", result)
        self.assertEqual(_file_snapshot([staged]), before)
        self.assertFalse((op_dir / "operation.json").exists())

    def test_retry_semantics_include_causal_preconditions(self) -> None:
        root = self.make_project()
        first = run_mutation(
            root,
            "causal-op",
            "test",
            "tester",
            canonical_identity(root),
            "payload",
            [{"path": "x.txt", "role": "generic", "content": b"new"}],
            preconditions={"x.txt": ""},
            read_preconditions={"y.txt": ""},
            _ensure_lineage=False,
        )
        self.assertTrue(first["ok"], first)
        (root / "y.txt").write_bytes(b"new dependency")
        second = run_mutation(
            root,
            "causal-op",
            "test",
            "tester",
            canonical_identity(root),
            "payload",
            [{"path": "x.txt", "role": "generic", "content": b"new"}],
            preconditions={"x.txt": ""},
            read_preconditions={"y.txt": hash_bytes(b"new dependency")},
            _ensure_lineage=False,
        )
        self.assertFalse(second["ok"], second)
        self.assertIn("collision", second.get("detail", ""))


class UndoAuditTests(ControlFixture):
    def _two_milestones(self) -> tuple[Path, Path]:
        root = self.make_project()
        path = root / "value.txt"
        path.write_bytes(b"one")
        self.assertTrue(create_milestone(root, "tester", "one", [path.name]).ok)
        path.write_bytes(b"two")
        self.assertTrue(create_milestone(root, "tester", "two", [path.name]).ok)
        return root, path

    def test_unrelated_committed_receipt_never_satisfies_undo(self) -> None:
        root, _path = self._two_milestones()
        reason = "same reason"
        op_id = _undo_op_id(root, "CP-001", reason)
        op_dir = root / ".saipen/recovery/ops" / op_id
        op_dir.mkdir(parents=True)
        record = {
            "op_id": op_id,
            "operation": "milestone_restore",
            "created_at": "2026-08-28T00:00:00Z",
            "agent": "tester",
            "project_identity": canonical_identity(root),
            "project_lineage": None,
            "semantic_payload_hash": "unrelated",
            "preconditions": {},
            "read_preconditions": {},
            "verification_policy": "none",
            "status": "COMMITTED",
            "progress_index": 0,
            "targets": [],
        }
        (op_dir / "operation.json").write_text(json.dumps(record), encoding="utf-8")

        result = undo_confirm(root, "tester", "CP-001", reason)

        self.assertFalse(result.ok, result.to_dict())
        self.assertNotEqual(result.code, "ALREADY_APPLIED")

    def test_historical_undo_does_not_mask_later_current_restore(self) -> None:
        root, path = self._two_milestones()
        reason = "same current decision"
        first = undo_confirm(root, "tester", "CP-001", reason)
        self.assertTrue(first.ok, first.to_dict())
        path.write_bytes(b"three")
        self.assertTrue(create_milestone(root, "tester", "three", [path.name]).ok)

        second = undo_confirm(root, "tester", "CP-001", reason)

        self.assertTrue(second.ok, second.to_dict())
        self.assertNotEqual(second.code, "ALREADY_APPLIED")
        self.assertEqual(path.read_bytes(), b"one")


class PerformanceAuditTests(ControlFixture):
    def test_conformance_history_tamper_blocks_append_and_lookup(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="saipen-conformance-tamper-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        receipt_dir = root / conformance.RECEIPT_DIRNAME
        receipt_dir.mkdir(parents=True)
        first_path = receipt_dir / "r1.json"
        first_path.write_text(
            json.dumps(self._receipt("r1", "2026-01-01T00:00:00Z")),
            encoding="utf-8",
        )
        conformance._update_receipt_index(
            root,
            "core",
            "r1",
            "2026-01-01T00:00:00Z",
            receipt_path=first_path.relative_to(root).as_posix(),
        )
        previous = conformance._lookup_receipt_index(root, "core")
        original = first_path.read_bytes()
        witnessed = first_path.stat()
        mutated = original.replace(b'"conformance_receipt"', b'"conformance_receipx"')
        self.assertEqual(len(mutated), len(original))
        first_path.write_bytes(mutated)
        os.utime(first_path, ns=(witnessed.st_atime_ns, witnessed.st_mtime_ns))

        second_path = receipt_dir / "r2.json"
        second_path.write_text(
            json.dumps(self._receipt("r2", "2026-01-01T00:00:01Z")),
            encoding="utf-8",
        )
        conformance._update_receipt_index(
            root,
            "core",
            "r2",
            "2026-01-01T00:00:01Z",
            receipt_path=second_path.relative_to(root).as_posix(),
        )

        self.assertEqual(conformance._lookup_receipt_index(root, "core"), previous)
        with self.assertRaises(conformance.ReceiptDiscoveryError):
            conformance.latest_receipt(root, "core")

    def test_settled_index_is_warm_and_content_authenticated(self) -> None:
        root = self.make_project()
        index_path = root / SETTLED_INDEX_REL
        if index_path.is_file():
            index_path.unlink()
        ops_dir = root / ".saipen/recovery/ops"
        for child in ops_dir.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        result = run_mutation(
            root,
            "index-op",
            "test",
            "tester",
            canonical_identity(root),
            "payload",
            [{"path": "index.txt", "role": "generic", "content": b"indexed"}],
            preconditions={"index.txt": ""},
            _ensure_lineage=False,
        )
        self.assertTrue(result["ok"], result)
        journal._bootstrap_settled_index(root)
        self.assertTrue(index_path.is_file(), "settled index was not bootstrapped")
        first = semantic_receipt_snapshot(root)
        self.assertEqual(len(first.errors), 0, first.errors)
        self.assertTrue(any(record.get("op_id") == "index-op" for record in first.records))
        self.assertIsNotNone(
            journal._read_settled_index(root, live_lineage=project_lineage_identity(root))
        )
        with mock.patch.object(
            journal,
            "decode_operation_record",
            side_effect=AssertionError("warm path decoded settled receipt"),
        ):
            warm = semantic_receipt_snapshot(root)
        self.assertTrue(any(record.get("op_id") == "index-op" for record in warm.records))
        settled = root / SETTLED_DIR / "index-op" / "operation.json"
        original = settled.read_bytes()
        original_stat = settled.stat()
        mutated = original.replace(b'"COMMITTED"', b'"RESOLVED "', 1)
        self.assertEqual(len(mutated), len(original))
        try:
            settled.write_bytes(mutated)
            os.utime(settled, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
            corrupted = semantic_receipt_snapshot(root)
            self.assertTrue(corrupted.errors, corrupted)
        finally:
            settled.write_bytes(original)
            os.utime(settled, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        restored = semantic_receipt_snapshot(root)
        self.assertEqual(restored.errors, ())

    def test_runner_returns_bounded_utf8_replaced_tails(self) -> None:
        code = (
            "import sys; "
            "sys.stdout.buffer.write(b'A'*2000000+b'\\xff'); "
            "sys.stderr.buffer.write(b'B'*2000000+b'\\xfe')"
        )
        result = test_runner._run_family(
            Path(__file__).resolve().parents[1],
            test_runner.TestFamily("bounded", (sys.executable, "-c", code), 30),
        )
        self.assertEqual(result["status"], "PASS", result)
        self.assertLessEqual(len(result["stdout"]), 8000)
        self.assertLessEqual(len(result["stderr"]), 8000)
        self.assertTrue(result["stdout"].endswith("�"), result)
        self.assertTrue(result["stderr"].endswith("�"), result)

    def test_runner_timeout_reaps_descendant_and_returns_json_text(self) -> None:
        root = self.make_project()
        pid_path = root / "descendant.pid"
        code = (
            "import pathlib,subprocess,sys,time; "
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
            "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); "
            "sys.stdout.buffer.write(b'out\\xff'); sys.stdout.flush(); "
            "sys.stderr.buffer.write(b'err\\xfe'); sys.stderr.flush(); time.sleep(60)"
        )
        result = test_runner._run_family(
            root,
            test_runner.TestFamily(
                "timeout-tree",
                (sys.executable, "-c", code, str(pid_path)),
                1,
            ),
        )
        self.assertEqual(result["status"], "TIMEOUT", result)
        self.assertIsInstance(result["stdout"], str)
        self.assertIsInstance(result["stderr"], str)
        json.dumps(result)
        self.assertTrue(pid_path.is_file(), result)
        descendant = int(pid_path.read_text(encoding="utf-8"))

        def process_exists(pid: int) -> bool:
            if os.name == "nt":
                probe = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                return f'"{pid}"' in probe.stdout
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return False
            return True

        deadline = time.monotonic() + 3
        while process_exists(descendant) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(process_exists(descendant), f"descendant {descendant} survived timeout")

    def test_windows_reserved_device_entries_do_not_break_test_sandbox(self) -> None:
        with mock.patch.object(test_runner.os, "name", "nt"):
            ignored = test_runner._ignore_copy(
                "unused",
                ["nul", "NUL.txt", "com1.log", "normal.txt"],
            )
        self.assertEqual(ignored, {"nul", "NUL.txt", "com1.log"})

    def _subprocess_cost(self, env: dict[str, str], code: str) -> float:
        """Cheapest of three runs of `code`, as this host's per-subprocess cost.

        T-1258: latency controls in this suite measure against this rather than
        against a constant, so a concurrently running gate cannot redden a
        behavioral assertion. Cheapest, not mean: the floor is the closest
        estimate of the cost with no contention in it.
        """
        costs = []
        for _ in range(3):
            started = time.monotonic()
            subprocess.run(
                [sys.executable, "-c", code], capture_output=True, text=True, env=env, timeout=60
            )
            costs.append(time.monotonic() - started)
        return min(costs)

    def test_liveness_cache_lock_contention_is_non_blocking(self) -> None:
        root = self.make_project()
        first = liveness.record_actionable(root, "f" * 32)
        self.assertEqual(first, {"stalled": False, "stall_repeats": 1})
        env = {
            **os.environ,
            "PYTHONPATH": str(TOOLS),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
        }
        holder_code = (
            "import sys,time; from pathlib import Path; "
            "from saipen_engine.lock import FileWriterLock; "
            "root=Path(sys.argv[1]); "
            "lock=FileWriterLock("
            "root/'.saipen/locks/continuation-liveness.lock',root,blocking=True); "
            "lock.acquire(); print('ready',flush=True); time.sleep(5)"
        )
        holder = subprocess.Popen(
            [sys.executable, "-c", holder_code, str(root)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        try:
            self.assertEqual(holder.stdout.readline().strip(), "ready")
            # T-1258: the claim is "does not block on the held lock", not "runs
            # in under 1.5 seconds". An absolute budget makes the verdict a
            # property of the host and of whatever else is running beside the
            # suite -- a concurrent gate turns a behavioral control into a
            # timing race, and the resulting red says nothing about locking.
            # Price one equivalent subprocess that touches no lock, then allow a
            # wide multiple of that. A call that really waited would take the
            # holder's full 5s sleep, which no sane multiple of interpreter
            # startup reaches.
            baseline = self._subprocess_cost(env, "from saipen_engine import liveness")
            budget = max(1.5, baseline * 6 + 0.5)
            if budget >= 4.0:
                self.skipTest(
                    f"host subprocess cost {baseline:.2f}s leaves no margin below the "
                    "holder's 5s hold; this control cannot separate blocking from load here"
                )
            calls = (
                "from saipen_engine import liveness; "
                f"print(liveness.record_actionable({str(root)!r},'g'*32))",
                "from saipen_engine import liveness; "
                f"liveness.clear({str(root)!r}); print('cleared')",
            )
            started = time.monotonic()
            for code in calls:
                proc = subprocess.run(
                    [sys.executable, "-c", code],
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=budget,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
            elapsed = time.monotonic() - started
            self.assertLess(
                elapsed,
                budget * 2,
                f"lock-free liveness writes took {elapsed:.2f}s against a "
                f"{budget * 2:.2f}s budget derived from a {baseline:.2f}s baseline",
            )
        finally:
            holder.terminate()
            holder.communicate(timeout=10)
        after_progress = liveness.record_actionable(root, "f" * 32)
        self.assertEqual(after_progress, {"stalled": False, "stall_repeats": 1})

    def test_cross_process_writer_contention_has_stable_busy_codes(self) -> None:
        root = self.make_project()
        env = {**os.environ, "PYTHONPATH": str(TOOLS), "PYTHONUTF8": "1"}
        cases = (
            (
                "WriterLock",
                "from saipen_engine.lock import WriterLock as L; lock=L(root)",
                "WRITER_BUSY",
            ),
            (
                "ProducerLock",
                "from saipen_engine.lock import ProducerLock as L; "
                "lock=L(root,'saitranslate')",
                "PRODUCER_BUSY: saitranslate is already writing",
            ),
        )
        for label, construct, expected in cases:
            with self.subTest(lock=label):
                holder_code = (
                    "import sys,time; from pathlib import Path; root=Path(sys.argv[1]); "
                    f"{construct}; lock.acquire(); print('ready',flush=True); time.sleep(5)"
                )
                holder = subprocess.Popen(
                    [sys.executable, "-c", holder_code, str(root)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    env=env,
                )
                try:
                    self.assertEqual(holder.stdout.readline().strip(), "ready")
                    contender_code = (
                        "import sys; from pathlib import Path; root=Path(sys.argv[1]); "
                        f"{construct}; "
                        "\ntry: lock.acquire()\n"
                        "except PermissionError as exc: print(str(exc)); raise SystemExit(0)\n"
                        "raise SystemExit(2)"
                    )
                    # T-1258: this asserts the refusal CODE, not latency. The
                    # timeout is only a hang guard, so it is generous: a tight
                    # one turns a stable-code control into a timing race with
                    # whatever else runs beside the suite.
                    contender = subprocess.run(
                        [sys.executable, "-c", contender_code, str(root)],
                        capture_output=True,
                        text=True,
                        env=env,
                        timeout=60,
                    )
                    self.assertEqual(contender.returncode, 0, contender.stderr)
                    self.assertEqual(contender.stdout.strip(), expected)
                    self.assertNotIn("Traceback", contender.stderr)
                finally:
                    holder.terminate()
                    holder.communicate(timeout=10)

    def test_nonretained_log_snapshot_preserves_semantics_and_digest(self) -> None:
        root = self.make_project()
        log_path = root / ".saipen/LOG.md"
        log_path.write_text(
            log_path.read_text(encoding="utf-8") + "# " + ("x" * 2_000_000) + "\n",
            encoding="utf-8",
        )

        full, full_digest = log_engine.read_history_snapshot_and_logs_digest(
            root, retain_text=True
        )
        lean, lean_digest = log_engine.read_history_snapshot_and_logs_digest(
            root, retain_text=False
        )

        self.assertTrue(full.text)
        self.assertEqual(lean.text, "")
        self.assertEqual(lean_digest, full_digest)
        self.assertEqual(lean.hash, full.hash)
        self.assertEqual(lean.events, full.events)
        self.assertEqual(lean.event_lines, full.event_lines)
        self.assertEqual(lean.illegal_lines, full.illegal_lines)
        self.assertEqual(lean.tail, full.tail)
        self.assertEqual(lean.max_ticket_id, full.max_ticket_id)

    def test_lean_project_snapshot_preserves_routing_fields_and_drops_renderings(self) -> None:
        from saipen_engine.snapshot import ProjectSnapshot

        root = self.make_project()
        full = ProjectSnapshot.capture(root, lean=False)
        lean = ProjectSnapshot.capture(root, lean=True)

        self.assertEqual(full.state_hash, lean.state_hash)
        self.assertEqual(full.board_hash, lean.board_hash)
        self.assertEqual(full.log_hash, lean.log_hash)
        self.assertEqual(full.log_tail, lean.log_tail)
        self.assertEqual(full.state_text, lean.state_text)
        self.assertEqual(full.board_text, lean.board_text)
        self.assertEqual(full.history_events, lean.history_events)
        self.assertEqual(full.history.events, lean.history.events)
        self.assertEqual(full.history.illegal_lines, lean.history.illegal_lines)
        self.assertEqual(full.history.max_ticket_id, lean.history.max_ticket_id)
        self.assertEqual(full.history.text != "", True)
        self.assertEqual(lean.history.text, "")
        self.assertTrue(full.history.event_lines)
        self.assertEqual(lean.history.event_lines, ())

    def test_lean_and_full_project_snapshot_read_each_history_segment_once(self) -> None:
        from saipen_engine.snapshot import ProjectSnapshot

        root = self.make_project()
        logs = root / ".saipen" / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        (logs / "LOG-001.md").write_text(
            "# Seal\n- 24.08.26 00:01 [E-002] [agent: tester] RUN: sealed\n",
            encoding="utf-8",
        )
        paths = [logs / "LOG-001.md", root / ".saipen" / "LOG.md"]
        original_read_bytes = Path.read_bytes
        for lean in (False, True):
            calls: dict[str, int] = {}

            def counted(path: Path) -> bytes:
                calls[str(path)] = calls.get(str(path), 0) + 1
                return original_read_bytes(path)

            with mock.patch.object(Path, "read_bytes", autospec=True, side_effect=counted):
                ProjectSnapshot.capture(root, lean=lean)
            for path in paths:
                self.assertEqual(calls.get(str(path), 0), 1, (lean, path, calls))

    def _routing_output_with_capture_mode(self, root: Path, command: str, lean: bool) -> str:
        import saipen as cli
        from saipen_engine.snapshot import ProjectSnapshot

        original_capture = ProjectSnapshot.capture
        output = io.StringIO()
        with mock.patch.object(ProjectSnapshot, "capture") as capture:
            capture.side_effect = lambda path, *args, **kwargs: original_capture(
                path, lean=lean
            )
            with redirect_stdout(output):
                rc = cli.main(["--project-root", str(root), "--json", command])
        self.assertEqual(rc, 0, (command, lean, output.getvalue()))
        return output.getvalue()

    def test_status_next_explain_are_identical_with_full_and_lean_capture(self) -> None:
        root = self.make_project()
        for command in ("status", "next", "explain-next"):
            with self.subTest(command=command):
                full = self._routing_output_with_capture_mode(root, command, False)
                lean = self._routing_output_with_capture_mode(root, command, True)
                self.assertEqual(full, lean)

    def test_context_renderers_keep_full_history_capture(self) -> None:
        from saipen_engine.context import context_audit, context_cold, context_hot

        root = self.make_project()
        cold = context_cold(root)
        hot = context_hot(root)
        audit = context_audit(root)
        self.assertTrue(cold.ok, cold)
        self.assertTrue(hot.ok, hot)
        self.assertTrue(audit.ok, audit)
        self.assertIn("E-001", cold.data["surface"])
        self.assertIn("E-001", hot.data["surface"])
        self.assertTrue(
            any(
                item["source"] == "LOG history (sealed + active)"
                for item in audit.data["sources"]
            )
        )

    def test_snapshot_history_ownership_refuses_symlink_and_directory(self) -> None:
        from saipen_engine.log import HistoryOwnershipError, read_history_snapshot

        root = self.make_project()
        logs = root / ".saipen" / "logs"
        logs.mkdir(parents=True, exist_ok=True)
        symlink = logs / "LOG-001.md"
        try:
            symlink.symlink_to(root / ".saipen" / "STATE.md")
        except (OSError, NotImplementedError):
            self.skipTest("symlink not permitted on this host")
        with self.assertRaises(HistoryOwnershipError):
            read_history_snapshot(root)
        symlink.unlink()
        (logs / "LOG-001.md").mkdir()
        with self.assertRaises(HistoryOwnershipError):
            read_history_snapshot(root)

    def test_focus_reads_are_prebounded_and_fingerprint_streams_stably(self) -> None:
        root = self.make_project()
        normal = root / "normal.txt"
        normal.write_bytes(b"normal\n")
        large = root / "large.bin"
        large.write_bytes(b"x" * 4096)

        digest = hashlib.sha256()
        for path in sorted((normal, large), key=lambda item: item.name):
            rel = path.relative_to(root).as_posix().encode("utf-8")
            raw = path.read_bytes()
            digest.update(len(rel).to_bytes(8, "big"))
            digest.update(rel)
            digest.update(len(raw).to_bytes(8, "big"))
            digest.update(raw)
        expected = "tree-sha256:" + digest.hexdigest()

        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("whole read")):
            self.assertEqual(_read_text_lossy(large, limit=16), "")
            actual = _project_tree_fingerprint(root)
        self.assertEqual(actual, expected)

    def _producer_package(self, epoch: int):
        return producer.build_package(
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

    def test_corrupt_ready_is_preserved_instead_of_replaced(self) -> None:
        corruptions = (b"{not-json", b'{"schema_version": 999}\n')
        for corrupt in corruptions:
            with self.subTest(corrupt=corrupt[:20]):
                root = self.make_project()
                namespace = root / ".saipen" / "saitranslate"
                epoch = producer.ProducerEpoch.claim(namespace)
                generation = producer.StagingGeneration(namespace, "saitranslate").begin()
                generation.add_payload("out.txt", b"new")
                package = self._producer_package(epoch)
                generation.set_package(package)
                ready = namespace / producer.READY_DIRNAME
                ready.mkdir(parents=True, exist_ok=True)
                target = ready / producer._ready_filename(package.package_identity)
                target.write_bytes(corrupt)

                refused = generation.publish()

                self.assertFalse(refused["ok"], refused)
                self.assertEqual(refused["code"], "READY_CORRUPT", refused)
                self.assertEqual(target.read_bytes(), corrupt)
                self.assertTrue(generation.staging_dir.is_dir())

    def test_ready_publisher_and_reader_share_one_size_contract(self) -> None:
        root = self.make_project()
        namespace = root / ".saipen" / "saitranslate"
        epoch = producer.ProducerEpoch.claim(namespace)
        with mock.patch.object(producer, "READY_MAX_BYTES", 4096):
            oversized = producer.StagingGeneration(namespace, "saitranslate").begin()
            oversized.add_payload("out.txt", b"x" * 5000)
            oversized.set_package(self._producer_package(epoch))
            refused = oversized.publish()
            self.assertFalse(refused["ok"], refused)
            self.assertEqual(refused["code"], "READY_TOO_LARGE", refused)
            self.assertFalse(any((namespace / producer.READY_DIRNAME).glob("*.json")))

            small = producer.StagingGeneration(namespace, "saitranslate").begin()
            small.add_payload("out.txt", b"small")
            small.set_package(self._producer_package(epoch))
            published = small.publish()
            self.assertTrue(published["ok"], published)
            reopened = producer.StagingGeneration.ready_package(
                namespace, published["package_identity"]
            )
            self.assertIsNotNone(reopened)

    @staticmethod
    def _receipt(rid: str, timestamp: str) -> dict:
        return {
            "schema_version": 2,
            "kind": "conformance_receipt",
            "receipt_id": rid,
            "validator_protocol_version": conformance.CONFORMANCE_PROTOCOL_VERSION,
            "gate": "core",
            "exit_code": 0,
            "verdict": "PASS",
            "timestamp_utc": timestamp,
        }

    def test_conformance_index_bootstraps_once_then_appends_incrementally(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="saipen-conformance-index-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        receipt_dir = root / conformance.RECEIPT_DIRNAME
        receipt_dir.mkdir(parents=True)
        calls = 0
        real_iter = conformance._iter_receipts

        def counted(project_root: Path):
            nonlocal calls
            calls += 1
            return real_iter(project_root)

        with mock.patch.object(conformance, "_iter_receipts", side_effect=counted):
            for index in range(40):
                rid = f"r{index:04d}"
                timestamp = (dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(
                    microseconds=index
                )).isoformat().replace("+00:00", "Z")
                path = receipt_dir / f"{rid}.json"
                path.write_text(
                    json.dumps(self._receipt(rid, timestamp)), encoding="utf-8"
                )
                conformance._update_receipt_index(
                    root,
                    "core",
                    rid,
                    timestamp,
                    receipt_path=path.relative_to(root).as_posix(),
                )
        self.assertLessEqual(calls, 1)

        previous = conformance._lookup_receipt_index(root, "core")
        (receipt_dir / "out-of-band.json").write_text("{not json", encoding="utf-8")
        path = receipt_dir / "r9999.json"
        timestamp = "2026-01-02T00:00:00Z"
        path.write_text(json.dumps(self._receipt("r9999", timestamp)), encoding="utf-8")
        conformance._update_receipt_index(
            root,
            "core",
            "r9999",
            timestamp,
            receipt_path=path.relative_to(root).as_posix(),
        )
        self.assertEqual(conformance._lookup_receipt_index(root, "core"), previous)

    def test_stage_g_reuses_one_predecessor_lookup(self) -> None:
        root = self.make_project()
        predecessor = {
            "op_id": "conv-f",
            "receipt_metadata": {
                "source_head": "no-git",
                "source_tree_fingerprint": "no-git-tree-v1:fixture",
            },
        }
        with mock.patch.object(
            operations,
            "_latest_convergence_stage",
            return_value=predecessor,
        ) as latest, mock.patch.object(
            conformance,
            "clean_exit_allowed",
            return_value=(True, ""),
        ):
            operations._plan_convergence_stage(
                root,
                "tester",
                stage="G",
                verdict="COMPLETED",
                now="28.08.26 00:00",
                utc="2026-08-28T00:00:00Z",
            )
        latest.assert_called_once_with(root, "F")


class CoreSensitiveAuditTests(ControlFixture):
    def test_capture_persists_exact_bytes_and_never_collapses_distinct_sources(self) -> None:
        """CORE-001: two bodies differing by one token must be two receipts.

        The pre-repair capture redacted before hashing, so `token = A` and
        `token = B` both hashed to `token = <redacted>` and the second capture
        was reported as a duplicate of the first while neither original
        survived.
        """
        root = self.make_project()
        first = "token = FIRST_VALUE\n"
        second = "token = SECOND_VALUE\n"
        first_capture = intake.capture(root, first, source_kind="external_audit")
        second_capture = intake.capture(root, second, source_kind="external_audit")
        self.assertTrue(first_capture["ok"], first_capture)
        self.assertTrue(second_capture["ok"], second_capture)
        self.assertNotEqual(second_capture["code"], "SOURCE_DUPLICATE", second_capture)
        self.assertNotEqual(first_capture["receipt"], second_capture["receipt"])
        self.assertNotEqual(first_capture["source_sha256"], second_capture["source_sha256"])
        self.assertEqual(
            first_capture["source_sha256"], hashlib.sha256(first.encode("utf-8")).hexdigest()
        )
        self.assertEqual(
            second_capture["source_sha256"], hashlib.sha256(second.encode("utf-8")).hexdigest()
        )
        for body, captured in ((first, first_capture), (second, second_capture)):
            rid = captured["receipt"]
            stored = (root / f".saipen/intake/active/{rid}.md").read_bytes()
            self.assertEqual(stored, body.encode("utf-8"), rid)
            self.assertNotIn(b"<redacted>", stored, rid)
            round_trip = intake.read_body(root, rid)
            self.assertTrue(round_trip["ok"], round_trip)
            self.assertEqual(round_trip["body"].encode("utf-8"), body.encode("utf-8"), rid)
            self.assertEqual(round_trip["source_authority"]["mode"], "exact", rid)
            self.assertTrue(round_trip["source_authority"]["original_available"], rid)

    def test_duplicate_capture_requires_byte_identical_input(self) -> None:
        """CORE-001: dedupe is exact-bytes only; a one-byte change is new."""
        root = self.make_project()
        body = "token = STABLE_VALUE\n"
        first = intake.capture(root, body, source_kind="external_audit")
        self.assertTrue(first["ok"], first)
        again = intake.capture(root, body, source_kind="external_audit")
        self.assertEqual(again["code"], "SOURCE_DUPLICATE", again)
        self.assertEqual(again["receipt"], first["receipt"])
        changed = intake.capture(root, body + "extra\n", source_kind="external_audit")
        self.assertNotEqual(changed["code"], "SOURCE_DUPLICATE", changed)
        self.assertNotEqual(changed["receipt"], first["receipt"])

    def test_sensitive_capture_flags_without_mutating_canonical_bytes(self) -> None:
        """CORE-001: detection is metadata; the receipt keeps the exact body."""
        root = self.make_project()
        body = "api_key = sk-live-secret-value\n"
        captured = intake.capture(root, body, source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        self.assertTrue(captured["sensitive"], captured)
        self.assertFalse(captured["redaction"]["applied"], captured)
        self.assertEqual(captured["source_authority"]["mode"], "exact", captured)
        rid = captured["receipt"]
        self.assertEqual(
            (root / f".saipen/intake/active/{rid}.md").read_bytes(), body.encode("utf-8")
        )
        meta = json.loads(
            (root / f".saipen/intake/active/{rid}.meta.json").read_text(encoding="utf-8")
        )
        self.assertTrue(meta["sensitive"], meta)
        self.assertFalse(meta["redaction"]["applied"], meta)
        self.assertEqual(meta["source_authority"]["mode"], "exact", meta)
        # Publication is still refused -- without touching the receipt.
        gate = intake.release_gate(root)
        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_CREDENTIALS_UNSAFE", gate)
        self.assertEqual(
            (root / f".saipen/intake/active/{rid}.md").read_bytes(), body.encode("utf-8")
        )

    def test_legacy_redacted_receipt_admits_lost_original_without_inventing_bytes(self) -> None:
        """CORE-001: a pre-repair redacted receipt states the original is gone.

        Recorded truth: `original_sha256` describes bytes that were discarded
        and cannot be reconstructed. The projection must say so rather than let
        a caller believe the stored derivative is the original.
        """
        root = self.make_project()
        original = "token = ORIGINAL_SECRET\n"
        captured = intake.capture(root, original, source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        meta_path = root / f".saipen/intake/active/{rid}.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        derivative, record = intake._redacted_derivative(original)
        self.assertNotEqual(derivative, original)
        meta["redaction"] = {
            "applied": True,
            "authoritative": False,
            "original_sha256": record["original_sha256"],
            "sanitized_sha256": record["sanitized_sha256"],
        }
        meta["source_sha256"] = record["sanitized_sha256"]
        meta_path.write_bytes(
            (json.dumps(meta, indent=2, sort_keys=True) + "\n").encode("utf-8")
        )
        (root / f".saipen/intake/active/{rid}.md").write_bytes(derivative.encode("utf-8"))
        index = intake._read_index(root)
        index["active"][rid]["source_sha256"] = record["sanitized_sha256"]
        intake._write_index(root, index)

        authority = intake._source_authority(intake._read_meta(root, rid))
        self.assertEqual(authority["mode"], "redacted-derivative", authority)
        self.assertFalse(authority["original_available"], authority)
        self.assertEqual(authority["original_sha256"], record["original_sha256"], authority)
        self.assertNotEqual(authority["body_sha256"], authority["original_sha256"], authority)
        # No original bytes are reconstructed anywhere: the stored body is
        # still the derivative, and release refuses rather than fabricate.
        stored = (root / f".saipen/intake/active/{rid}.md").read_bytes()
        self.assertEqual(stored, derivative.encode("utf-8"))
        self.assertNotIn(b"ORIGINAL_SECRET", stored)
        gate = intake.release_gate(root)
        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_ORIGINAL_LOST", gate)

    def test_release_gate_refuses_legacy_sensitive_unsanitized_active_receipt(
        self,
    ) -> None:
        root = self.make_project()
        body = "api_key = sk-live-secret-value"
        captured = intake.capture(root, body, source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        meta_path = root / f".saipen/intake/active/{rid}.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["sensitive"] = True
        meta["redaction"] = {"applied": False, "sanitized_sha256": meta["source_sha256"]}
        # Simulate pre-CORE-001 metadata: no `source_authority` record exists.
        meta.pop("source_authority", None)
        meta_path.write_bytes(
            (json.dumps(meta, indent=2, sort_keys=True) + "\n").encode("utf-8")
        )
        body_path = root / f".saipen/intake/active/{rid}.md"
        body_path.write_bytes(body.encode("utf-8"))
        self.assertIn("sk-live-secret-value", body_path.read_text(encoding="utf-8"))

        gate = intake.release_gate(root)
        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "SOURCE_CORRUPTION", gate)
        self.assertIn("legacy sensitive unsanitized", gate.get("detail", ""))
        self.assertTrue(any("credential gate" in line for line in intake.validate_project(root)))

    def test_release_gate_and_validate_refuse_archived_legacy_credential(
        self,
    ) -> None:
        root = self.make_project()
        body = "api_key = sk-live-secret-value"
        captured = intake.capture(root, body, source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        self.assertTrue(
            intake.add_requirement(
                root,
                rid,
                rid="R001",
                text="Sanitize credential",
            )["ok"]
        )
        self.assertTrue(
            intake.set_disposition(
                root,
                rid,
                "R001",
                "IMPLEMENTED",
                evidence="E-1",
                verification="focused:PASS",
            )["ok"]
        )
        closed = intake.close_receipt(root, rid, closure_event="E-1")
        self.assertTrue(closed["ok"], closed)
        archive_meta = root / f".saipen/archive/source/{rid}.meta.json"
        meta = json.loads(archive_meta.read_text(encoding="utf-8"))
        meta["sensitive"] = True
        meta["redaction"] = {
            "applied": False,
            "sanitized_sha256": meta["source_sha256"],
        }
        # Simulate pre-CORE-001 metadata: no `source_authority` record exists.
        meta.pop("source_authority", None)
        archive_meta.write_bytes(
            (json.dumps(meta, indent=2, sort_keys=True) + "\n").encode("utf-8")
        )
        (root / f".saipen/archive/source/{rid}.md").write_bytes(body.encode("utf-8"))

        gate = intake.release_gate(root)
        self.assertFalse(gate["ok"], gate)
        self.assertIn("archive source", gate.get("detail", ""))
        self.assertTrue(any("credential gate" in line for line in intake.validate_project(root)))


class CorePlanBindingAuditTests(ControlFixture):
    def _git_project(self) -> Path:
        project = self.make_project(intent="goal", active=True)
        subprocess.run(["git", "init", "-q"], cwd=project, check=True)
        subprocess.run(
            ["git", "config", "user.email", "audit-core@example.invalid"],
            cwd=project,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Audit Core"],
            cwd=project,
            check=True,
        )
        (project / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=project, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=project, check=True)
        return project

    def test_release_plan_binds_source_authority_manifest_in_canonical(self) -> None:
        from saipen_engine.release import plan_release, _source_authority_manifest

        root = self._git_project()
        captured = intake.capture(
            root,
            "authoritative audit body\n",
            source_kind="external_audit",
            work="T-7",
        )
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        authority_rel = f".saipen/intake/active/{rid}.md"
        self.assertTrue((root / authority_rel).is_file())

        fake_git = SimpleNamespace(stdout="", ok=True, stderr="", rc=0)
        patchers = [
            mock.patch.object(release_engine, "_push_endpoint", return_value=""),
            mock.patch.object(release_engine, "_branch_exists", return_value=True),
            mock.patch.object(release_engine, "_branch", return_value="main"),
            mock.patch.object(
                release_engine,
                "_read_state",
                return_value=("", {"phase": "SHIP", "task": "T-7", "agent": "tester"}),
            ),
            mock.patch.object(release_engine, "_read_board", return_value=("", {})),
            mock.patch.object(release_engine, "_log_hash", return_value="0" * 16),
            mock.patch.object(release_engine, "_find_ticket", return_value={"id": "T-7"}),
            mock.patch.object(release_engine, "_scope_paths", return_value=[]),
            mock.patch.object(release_engine, "_scope_for", return_value={}),
            mock.patch.object(release_engine, "_check_parity", return_value=None),
            mock.patch.object(release_engine, "_head_relation", return_value="local"),
            mock.patch.object(release_engine, "_installed_version", return_value="7.231.9"),
            mock.patch.object(
                release_engine,
                "RemoteSnapshot",
                return_value=SimpleNamespace(
                    classification=lambda: (release_engine.REMOTE_ABSENT, ""),
                    branch_tip=lambda branch: (True, ""),
                    tag_commit=lambda tag: (False, ""),
                    refs={},
                ),
            ),
            mock.patch.object(release_engine, "_release_evidence", return_value=([], ())),
            mock.patch.object(
                release_engine,
                "_classify_continuation",
                return_value={
                    "start_stage": release_engine.START_PREPARED,
                    "content_already_committed": False,
                    "already_applied": False,
                    "first_publish_wait": True,
                },
            ),
            mock.patch.object(release_engine, "_git", return_value=fake_git),
            mock.patch.object(release_engine, "_local_tag_commit", return_value=(False, "")),
            mock.patch.object(
                release_engine,
                "_capture_index_state",
                return_value=SimpleNamespace(paths=(), entries=(), content_hash="0" * 16),
            ),
            mock.patch.object(release_engine, "_read_confirmation", return_value=""),
        ]
        for patcher in patchers:
            patcher.start()
        try:
            plan = plan_release(
                root,
                "ship",
                current_capability="full",
                current_agent="tester",
            )
        finally:
            for patcher in reversed(patchers):
                patcher.stop()
        manifest = dict(plan.source_manifest)
        self.assertIn(authority_rel, manifest)
        expected_digest = hashlib.sha256(
            (root / authority_rel).read_bytes()
        ).hexdigest()
        self.assertEqual(manifest[authority_rel], expected_digest)
        canonical = plan.canonical()
        self.assertIn(plan.source_manifest, canonical)
        self.assertEqual(
            _source_authority_manifest(root),
            tuple(sorted(plan.source_manifest)),
        )

    def _plan_ship_release(self, root: Path):
        from saipen_engine.release import plan_release

        fake_git = SimpleNamespace(stdout="", ok=True, stderr="", rc=0)
        patchers = [
            mock.patch.object(release_engine, "_push_endpoint", return_value=""),
            mock.patch.object(release_engine, "_branch_exists", return_value=True),
            mock.patch.object(release_engine, "_branch", return_value="main"),
            mock.patch.object(
                release_engine,
                "_read_state",
                return_value=("", {"phase": "SHIP", "task": "T-7", "agent": "tester"}),
            ),
            mock.patch.object(release_engine, "_read_board", return_value=("", {})),
            mock.patch.object(release_engine, "_log_hash", return_value="0" * 16),
            mock.patch.object(release_engine, "_find_ticket", return_value={"id": "T-7"}),
            mock.patch.object(release_engine, "_scope_paths", return_value=[]),
            mock.patch.object(release_engine, "_scope_for", return_value={}),
            mock.patch.object(release_engine, "_check_parity", return_value=None),
            mock.patch.object(release_engine, "_head_relation", return_value="local"),
            mock.patch.object(release_engine, "_installed_version", return_value="7.231.9"),
            mock.patch.object(
                release_engine,
                "RemoteSnapshot",
                return_value=SimpleNamespace(
                    classification=lambda: (release_engine.REMOTE_ABSENT, ""),
                    branch_tip=lambda branch: (True, ""),
                    tag_commit=lambda tag: (False, ""),
                    refs={},
                ),
            ),
            mock.patch.object(release_engine, "_release_evidence", return_value=([], ())),
            mock.patch.object(
                release_engine,
                "_classify_continuation",
                return_value={
                    "start_stage": release_engine.START_PREPARED,
                    "content_already_committed": False,
                    "already_applied": False,
                    "first_publish_wait": True,
                },
            ),
            mock.patch.object(release_engine, "_git", return_value=fake_git),
            mock.patch.object(release_engine, "_local_tag_commit", return_value=(False, "")),
            mock.patch.object(
                release_engine,
                "_capture_index_state",
                return_value=SimpleNamespace(paths=(), entries=(), content_hash="0" * 16),
            ),
            mock.patch.object(release_engine, "_read_confirmation", return_value=""),
        ]
        for patcher in patchers:
            patcher.start()
        try:
            return plan_release(
                root,
                "ship",
                current_capability="full",
                current_agent="tester",
            )
        finally:
            for patcher in reversed(patchers):
                patcher.stop()

    @staticmethod
    def _index_snapshot(root: Path) -> str:
        staged = _git(root, "diff", "--cached", "--name-only").stdout
        working = _git(root, "status", "--porcelain").stdout
        return staged + "\n--\n" + working

    def test_source_authority_manifest_drift_refuses_preflight_before_writes(
        self,
    ) -> None:
        from saipen_engine.release import (
            _check_source_authority_manifest,
            _source_authority_manifest,
        )

        root = self._git_project()
        captured = intake.capture(
            root,
            "authoritative audit body\n",
            source_kind="external_audit",
            work="T-7",
        )
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        authority_rel = f".saipen/intake/active/{rid}.md"
        original_bytes = (root / authority_rel).read_bytes()

        plan = SimpleNamespace(source_manifest=_source_authority_manifest(root))
        planned_path = {path for path, _ in plan.source_manifest}
        self.assertIn(authority_rel, planned_path)
        self.assertIsNone(_check_source_authority_manifest(root, plan))

        (root / authority_rel).write_text("drifted after plan\n", encoding="utf-8")
        error = _check_source_authority_manifest(root, plan)
        self.assertIn("source authority manifest changed", error or "")
        self.assertNotEqual(
            _source_authority_manifest(root),
            tuple(sorted(plan.source_manifest)),
        )

        (root / authority_rel).write_bytes(original_bytes)
        self.assertIsNone(_check_source_authority_manifest(root, plan))


class CoreArchiveStrictBundleTests(ControlFixture):
    def _resolved(self, body: str) -> tuple[Path, str]:
        root = self.make_project()
        captured = intake.capture(root, body, source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        self.assertTrue(
            intake.add_requirement(
                root,
                rid,
                rid="R001",
                text="Close only after verified coverage",
            )["ok"]
        )
        self.assertTrue(
            intake.set_disposition(
                root,
                rid,
                "R001",
                "VERIFIED",
                evidence="E-1",
                verification="focused:PASS",
            )["ok"]
        )
        return root, rid

    def _interrupt(self, root: Path, rid: str) -> None:
        meta_path = root / f".saipen/intake/active/{rid}.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta.update(
            {
                "status": intake.CLOSED_STATUS,
                "closed_at": "2026-08-28T00:00:00Z",
                "reread_at": "2026-08-28T00:00:00Z",
                "closure_event": "E-1",
            }
        )
        intake._archive_closed_locked(root, rid, meta)

    def test_archived_metadata_must_carry_received_at_utc(self) -> None:
        root, rid = self._resolved("audit body\n")
        self._interrupt(root, rid)
        archive_meta = root / f".saipen/archive/source/{rid}.meta.json"
        meta = json.loads(archive_meta.read_text(encoding="utf-8"))
        del meta["received_at"]
        archive_meta.write_text(
            json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        watched = [archive_meta, root / ".saipen/intake/index.json"]
        before = _file_snapshot(watched)
        first = intake.close_receipt(root, rid)
        second = intake.close_receipt(root, rid)
        self.assertEqual(first["code"], "SOURCE_CORRUPTION", first)
        self.assertEqual(second["code"], "SOURCE_CORRUPTION", second)
        self.assertEqual(_file_snapshot(watched), before)

    def test_archived_redaction_digest_must_equal_archived_body(self) -> None:
        root, rid = self._resolved("audit body\n")
        self._interrupt(root, rid)
        archive_meta = root / f".saipen/archive/source/{rid}.meta.json"
        meta = json.loads(archive_meta.read_text(encoding="utf-8"))
        meta["redaction"] = {
            "applied": True,
            "sanitized_sha256": "0" * 64,
            "original_sha256": None,
        }
        archive_meta.write_text(
            json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        watched = [archive_meta, root / ".saipen/intake/index.json"]
        before = _file_snapshot(watched)
        first = intake.close_receipt(root, rid)
        second = intake.close_receipt(root, rid)
        self.assertEqual(first["code"], "SOURCE_CORRUPTION", first)
        self.assertEqual(second["code"], "SOURCE_CORRUPTION", second)
        self.assertEqual(_file_snapshot(watched), before)

    def test_archived_coverage_and_contract_must_agree_when_both_carriers_exist(
        self,
    ) -> None:
        root, rid = self._resolved("audit body\n")
        self._interrupt(root, rid)
        coverage = (
            root / f".saipen/intake/coverage/{rid}.json"
        )
        coverage.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "requirements": {
                        f"{rid}:R001": {
                            "class": "requirement",
                            "text": "Close only after verified coverage",
                            "actionable": True,
                            "disposition": "VERIFIED",
                            "work": None,
                            "evidence": "E-1",
                            "verification": "focused:PASS",
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        watched = [
            root / f".saipen/archive/source/{rid}.coverage.json",
            root / f".saipen/intake/coverage/{rid}.json",
            root / ".saipen/intake/index.json",
        ]
        before = _file_snapshot(watched)
        first = intake.close_receipt(root, rid)
        second = intake.close_receipt(root, rid)
        self.assertEqual(first["code"], "SOURCE_CORRUPTION", first)
        self.assertEqual(second["code"], "SOURCE_CORRUPTION", second)
        self.assertEqual(_file_snapshot(watched), before)


class CoreConformanceAppendRaceTests(ControlFixture):
    """CORE-002 VERIFY: the append proof must be a membership proof, not an
    mtime observation. Neither a malformed NOR a valid out-of-band sibling may
    be absorbed into the writer's advance."""

    @staticmethod
    def _receipt(rid: str, timestamp: str) -> dict:
        return {
            "schema_version": 2,
            "kind": "conformance_receipt",
            "receipt_id": rid,
            "validator_protocol_version": conformance.CONFORMANCE_PROTOCOL_VERSION,
            "gate": "core",
            "exit_code": 0,
            "verdict": "PASS",
            "timestamp_utc": timestamp,
        }

    def _seed(self, count: int) -> tuple[Path, Path]:
        root = Path(tempfile.mkdtemp(prefix="saipen-conformance-race-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        receipt_dir = root / conformance.RECEIPT_DIRNAME
        receipt_dir.mkdir(parents=True)
        for index in range(count):
            rid = f"r{index:04d}"
            timestamp = (
                dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
                + dt.timedelta(seconds=index)
            ).isoformat().replace("+00:00", "Z")
            path = receipt_dir / f"{rid}.json"
            path.write_text(json.dumps(self._receipt(rid, timestamp)), encoding="utf-8")
            conformance._update_receipt_index(
                root,
                "core",
                rid,
                timestamp,
                receipt_path=path.relative_to(root).as_posix(),
            )
        return root, receipt_dir

    def test_valid_out_of_band_sibling_does_not_advance_append_proof(self) -> None:
        root, receipt_dir = self._seed(3)
        previous_locator = conformance._lookup_receipt_index(root, "core")
        previous_proof = conformance._load_lineage_index(root)

        # A foreign writer publishes a perfectly valid canonical receipt into
        # the owned directory between the writer's observation and its write.
        sibling = receipt_dir / "out-of-band.json"
        sibling_timestamp = "2026-01-01T00:00:59Z"
        sibling.write_text(
            json.dumps(self._receipt("out-of-band", sibling_timestamp)),
            encoding="utf-8",
        )

        path = receipt_dir / "r0003.json"
        timestamp = "2026-01-01T00:00:04Z"
        path.write_text(json.dumps(self._receipt("r0003", timestamp)), encoding="utf-8")
        conformance._update_receipt_index(
            root,
            "core",
            "r0003",
            timestamp,
            receipt_path=path.relative_to(root).as_posix(),
        )

        self.assertEqual(
            conformance._lookup_receipt_index(root, "core"),
            previous_locator,
            "the incremental proof advanced across an out-of-band append",
        )
        self.assertEqual(
            conformance._load_lineage_index(root),
            previous_proof,
            "lineage membership advanced as if exactly one receipt appeared",
        )

    def test_valid_out_of_band_sibling_never_becomes_the_indexed_latest(self) -> None:
        """With foreign history present, the O(1) locator must not launder the
        writer's receipt as latest: the read degrades to the strict scan and
        reports the true newest receipt, which is the out-of-band one."""
        root, receipt_dir = self._seed(3)
        sibling = receipt_dir / "out-of-band.json"
        sibling_timestamp = "2026-01-01T00:00:59Z"
        sibling.write_text(
            json.dumps(self._receipt("out-of-band", sibling_timestamp)),
            encoding="utf-8",
        )
        path = receipt_dir / "r0003.json"
        timestamp = "2026-01-01T00:00:04Z"
        path.write_text(json.dumps(self._receipt("r0003", timestamp)), encoding="utf-8")
        conformance._update_receipt_index(
            root,
            "core",
            "r0003",
            timestamp,
            receipt_path=path.relative_to(root).as_posix(),
        )

        latest = conformance.latest_receipt(root, "core")
        self.assertIsNotNone(latest)
        self.assertEqual(latest["receipt_id"], "out-of-band")
        # The writer's own receipt is still discoverable; it just is not latest.
        self.assertIn("r0003", {rec["receipt_id"] for rec in conformance._iter_receipts(root)})

    def test_malformed_out_of_band_sibling_fails_closed(self) -> None:
        root, receipt_dir = self._seed(3)
        previous_locator = conformance._lookup_receipt_index(root, "core")
        (receipt_dir / "corrupt-race.json").write_text("{not json", encoding="utf-8")
        path = receipt_dir / "r0003.json"
        timestamp = "2026-01-01T00:00:04Z"
        path.write_text(json.dumps(self._receipt("r0003", timestamp)), encoding="utf-8")
        conformance._update_receipt_index(
            root,
            "core",
            "r0003",
            timestamp,
            receipt_path=path.relative_to(root).as_posix(),
        )

        self.assertEqual(conformance._lookup_receipt_index(root, "core"), previous_locator)
        with self.assertRaises(conformance.ReceiptDiscoveryError):
            conformance.latest_receipt(root, "core")
        status = conformance.conformance_status(root, "core")
        self.assertNotIn(status.get("status"), {"CURRENT_PASS"}, status)


class CorePlanAuthorityDriftTests(ControlFixture):
    """CORE-003 VERIFY: ReleasePlan binds source-authority membership AND
    content. Every PLAN -> APPLY mutation of that surface must fail PREFLIGHT
    before staging."""

    def _project(self) -> Path:
        project = self.make_project(intent="goal", active=True)
        self.assertEqual(_git(project, "init", "-q").returncode, 0)
        self.assertEqual(
            _git(project, "config", "user.email", "audit-core@example.invalid").returncode, 0
        )
        self.assertEqual(_git(project, "config", "user.name", "Audit Core").returncode, 0)
        (project / "tracked.txt").write_text("tracked\n", encoding="utf-8")
        (project / ".gitattributes").write_text(
            "* text=auto\n.saipen/intake/** -text\n.saipen/archive/source/** -text\n",
            encoding="utf-8",
        )
        self.assertEqual(_git(project, "add", "-A").returncode, 0)
        self.assertEqual(_git(project, "commit", "-qm", "fixture").returncode, 0)
        return project

    def _planned_manifest(self, root: Path):
        from saipen_engine.release import _source_authority_manifest

        captured = intake.capture(
            root,
            "authoritative audit body\n",
            source_kind="external_audit",
            work="T-7",
        )
        self.assertTrue(captured["ok"], captured)
        return captured["receipt"], _source_authority_manifest(root)

    @staticmethod
    def _drift_error(root: Path, manifest) -> str | None:
        from saipen_engine.release import _check_source_authority_manifest

        return _check_source_authority_manifest(root, SimpleNamespace(source_manifest=manifest))

    def test_planned_authority_is_clean_before_any_drift(self) -> None:
        root = self._project()
        _rid, manifest = self._planned_manifest(root)
        self.assertIsNone(self._drift_error(root, manifest))

    def test_added_covered_unlinked_receipt_drifts_planned_authority(self) -> None:
        root = self._project()
        _rid, manifest = self._planned_manifest(root)
        captured = intake.capture(
            root, "late unlinked audit body\n", source_kind="external_audit"
        )
        self.assertTrue(captured["ok"], captured)
        late = captured["receipt"]
        self.assertTrue(intake.add_requirement(root, late, rid="R001", text="Late demand")["ok"])
        self.assertTrue(
            intake.set_disposition(
                root, late, "R001", "VERIFIED", evidence="E-9", verification="focused:PASS"
            )["ok"]
        )
        error = self._drift_error(root, manifest)
        self.assertIsNotNone(error, "a late fully covered receipt must invalidate the plan")
        self.assertIn("source authority manifest changed", error)

    def test_archived_receipt_drifts_planned_authority(self) -> None:
        root = self._project()
        # Unlinked, so closing is not gated on a live Work ticket.
        captured = intake.capture(root, "archive drift body\n", source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        from saipen_engine.release import _source_authority_manifest

        manifest = _source_authority_manifest(root)
        self.assertTrue(
            intake.add_requirement(root, rid, rid="R001", text="Close after coverage")["ok"]
        )
        self.assertTrue(
            intake.set_disposition(
                root, rid, "R001", "VERIFIED", evidence="E-1", verification="focused:PASS"
            )["ok"]
        )
        self.assertTrue(intake.close_receipt(root, rid)["ok"], rid)
        error = self._drift_error(root, manifest)
        self.assertIsNotNone(error, "closing a receipt moves authority out of the active set")
        self.assertIn("source authority manifest changed", error)

    def test_mutated_authority_carrier_drifts_planned_authority(self) -> None:
        root = self._project()
        rid, manifest = self._planned_manifest(root)
        body = root / f".saipen/intake/active/{rid}.md"
        original = body.read_bytes()
        body.write_text("drifted after plan\n", encoding="utf-8")
        self.assertIsNotNone(self._drift_error(root, manifest))
        body.write_bytes(original)
        self.assertIsNone(self._drift_error(root, manifest))

    def test_removed_authority_carrier_drifts_planned_authority(self) -> None:
        root = self._project()
        _rid, manifest = self._planned_manifest(root)
        from saipen_engine.release_contract import source_authority_paths

        victim = next(
            (
                path
                for path in source_authority_paths(root)
                if "/coverage/" in path.as_posix() or "/contracts/" in path.as_posix()
            ),
            None,
        )
        self.assertIsNotNone(victim, "fixture exposes no removable coverage/contract carrier")
        (root / victim).unlink()
        error = self._drift_error(root, manifest)
        self.assertIsNotNone(error, "removing a planned carrier must invalidate the plan")
        self.assertIn("source authority manifest changed", error)

    def test_preflight_refuses_authority_drift_before_any_staging(self) -> None:
        import dataclasses

        from saipen_engine.release import _log_hash, _quick_hash

        root = self._project()
        rid, _manifest = self._planned_manifest(root)
        plan = CorePlanBindingAuditTests._plan_ship_release(self, root)
        # `plan_release` was driven with stubbed canonical readers; rebind the
        # three canonical hashes to the live files so the ONLY difference
        # between plan and world is the source-authority surface under test.
        plan = dataclasses.replace(
            plan,
            state_hash=_quick_hash((root / ".saipen/STATE.md").read_text(encoding="utf-8")),
            board_hash=_quick_hash((root / ".saipen/BOARD.md").read_text(encoding="utf-8")),
            log_hash=_log_hash(root),
        )
        self.assertEqual(
            release_engine._check_source_authority_manifest(root, plan),
            None,
            "rebound plan must be clean before drift",
        )
        baseline = CorePlanBindingAuditTests._index_snapshot(root)

        (root / f".saipen/intake/active/{rid}.md").write_text(
            "drifted after plan\n", encoding="utf-8"
        )
        result = release_engine._preflight_plan(root, plan)

        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("stage"), "PREFLIGHT", result)
        self.assertIn("source authority manifest changed", str(result))
        self.assertEqual(
            CorePlanBindingAuditTests._index_snapshot(root),
            baseline,
            "preflight staged or committed before refusing",
        )


class CoreArchiveSettlementTamperTests(ControlFixture):
    """CORE-004 VERIFY: an interrupted close must re-prove the SAME Contract /
    coverage closure gate the original archive required. No tampered carrier
    may settle into a CLOSED tombstone, and every refusal is zero-write and
    byte-identical on retry."""

    def _resolved(self) -> tuple[Path, str]:
        root = self.make_project()
        captured = intake.capture(root, "settlement evidence\n", source_kind="external_audit")
        self.assertTrue(captured["ok"], captured)
        rid = captured["receipt"]
        self.assertTrue(
            intake.add_requirement(
                root, rid, rid="R001", text="Close only after verified coverage"
            )["ok"]
        )
        self.assertTrue(
            intake.set_disposition(
                root, rid, "R001", "VERIFIED", evidence="E-1", verification="focused:PASS"
            )["ok"]
        )
        return root, rid

    def _interrupt(self, root: Path, rid: str) -> None:
        meta_path = root / f".saipen/intake/active/{rid}.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta.update(
            {
                "status": intake.CLOSED_STATUS,
                "closed_at": "2026-08-28T00:00:00Z",
                "reread_at": "2026-08-28T00:00:00Z",
                "closure_event": "E-1",
            }
        )
        intake._archive_closed_locked(root, rid, meta)

    def _tamper_and_refuse(self, mutate) -> None:
        root, rid = self._resolved()
        self._interrupt(root, rid)
        coverage_path = root / f".saipen/archive/source/{rid}.coverage.json"
        coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
        mutate(coverage, rid)
        coverage_path.write_text(json.dumps(coverage, sort_keys=True), encoding="utf-8")

        watched = [
            coverage_path,
            root / f".saipen/archive/source/{rid}.contract.json",
            root / f".saipen/archive/source/{rid}.meta.json",
            root / ".saipen/intake/index.json",
        ]
        before = _file_snapshot(watched)

        first = intake.close_receipt(root, rid)
        second = intake.close_receipt(root, rid)

        self.assertEqual(first["code"], "SOURCE_CORRUPTION", first)
        self.assertEqual(second["code"], "SOURCE_CORRUPTION", second)
        self.assertEqual(_file_snapshot(watched), before)

    def test_archived_coverage_dropping_contract_requirement_refuses(self) -> None:
        def mutate(coverage: dict, _rid: str) -> None:
            coverage["requirements"] = {}

        self._tamper_and_refuse(mutate)

    def test_archived_coverage_adding_unknown_requirement_refuses(self) -> None:
        def mutate(coverage: dict, rid: str) -> None:
            coverage["requirements"][f"{rid}:R999"] = {
                "class": "requirement",
                "text": "unknown to the contract",
                "actionable": True,
                "disposition": "VERIFIED",
                "work": None,
                "evidence": "E-x",
                "verification": "focused:PASS",
            }

        self._tamper_and_refuse(mutate)

    def test_archived_coverage_downgrading_terminal_disposition_refuses(self) -> None:
        def mutate(coverage: dict, rid: str) -> None:
            coverage["requirements"][f"{rid}:R001"]["disposition"] = "OPEN"

        self._tamper_and_refuse(mutate)

    def test_archived_coverage_removing_evidence_refuses(self) -> None:
        def mutate(coverage: dict, rid: str) -> None:
            coverage["requirements"][f"{rid}:R001"]["evidence"] = None

        self._tamper_and_refuse(mutate)

    def test_archived_coverage_removing_verification_refuses(self) -> None:
        def mutate(coverage: dict, rid: str) -> None:
            coverage["requirements"][f"{rid}:R001"]["verification"] = None

        self._tamper_and_refuse(mutate)

    def test_archived_coverage_changing_class_actionable_and_text_refuses(self) -> None:
        def mutate(coverage: dict, rid: str) -> None:
            coverage["requirements"][f"{rid}:R001"].update(
                {
                    "class": "note",
                    "actionable": False,
                    "text": "rewritten after the archive move",
                }
            )

        self._tamper_and_refuse(mutate)

    def test_untampered_interrupted_close_settles_idempotently(self) -> None:
        root, rid = self._resolved()
        self._interrupt(root, rid)
        first = intake.close_receipt(root, rid)
        self.assertTrue(first["ok"], first)
        self.assertTrue(first.get("recovered"), first)
        self.assertEqual(intake.validate_project(root), [])
        tombstone_after_first = json.loads(
            (root / ".saipen/intake/index.json").read_text(encoding="utf-8")
        ).get("tombstones", {})
        second = intake.close_receipt(root, rid)
        # Retry after a settled close is a stable no-op (T-1323): the receipt
        # is ALREADY a tombstone, so closure is a done fact and the retry
        # re-proves the archived body instead of resurrecting or re-settling
        # anything. The tombstone set below is the proof it did not move.
        self.assertEqual(second.get("code"), "SOURCE_CLOSED", second)
        self.assertTrue(second.get("ok"), second)
        self.assertFalse(second.get("residue_removed"), second)
        self.assertEqual(
            json.loads((root / ".saipen/intake/index.json").read_text(encoding="utf-8")).get(
                "tombstones", {}
            ),
            tombstone_after_first,
        )
        tombstone = (
            json.loads((root / ".saipen/intake/index.json").read_text(encoding="utf-8"))
            .get("tombstones", {})
            .get(rid, {})
        )
        self.assertEqual(tombstone.get("requirements"), 1)
        self.assertEqual(tombstone.get("actionable"), 1)
        self.assertEqual(tombstone.get("unresolved"), 0)

    def test_a_settled_retry_is_not_a_rubber_stamp(self) -> None:
        # Red control for the idempotent retry above: the retry re-proves the
        # archived body against the tombstone digest, so a corrupted archive
        # refuses SOURCE_CORRUPTION instead of reporting a clean closed fact.
        root, rid = self._resolved()
        self._interrupt(root, rid)
        self.assertTrue(intake.close_receipt(root, rid)["ok"])
        archived = root / f".saipen/archive/source/{rid}.md"
        archived.write_bytes(b"tampered after settlement\n")
        retry = intake.close_receipt(root, rid)
        self.assertFalse(retry.get("ok"), retry)
        self.assertEqual(retry.get("code"), "SOURCE_CORRUPTION", retry)


class CrewPlanSourceAuthorityOnceTests(unittest.TestCase):
    """PERF-006 (crew branch): the crew terminal plan MUST derive its
    ``metadata_paths`` and ``source_manifest`` from the SAME call-scoped
    source-authority inventory that the parent ``plan_release`` captures
    once. A separate fresh inventory inside ``_plan_crew_release`` is the
    exact duplicated-Git-inventory pattern the T-1193 fix removed from the
    ordinary branch.
    """

    def _root(self) -> Path:
        root = Path(tempfile.mkdtemp(prefix="saipen-perf006-crew-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)
        return root

    def test_plan_crew_release_reuses_passed_inventory(self) -> None:
        from saipen_engine.release import _plan_crew_release
        from saipen_engine import release_contract

        root = self._root()
        (root / ".saipen/IDENTITY.md").write_text(
            "---\n"
            "project_lineage: lineage-b512942bac884a8691f6c98afcd6ddb9\n"
            "---\n",
            encoding="utf-8",
        )
        (root / "a.txt").write_bytes(b"crew scope content")
        # Materialize one active source receipt so the inventory is non-empty.
        captured_evidence = intake.capture(
            root, "PERF-006 crew inventory regression\n", source_kind="external_audit"
        )
        self.assertTrue(captured_evidence["ok"], captured_evidence)
        captured = release_contract.source_authority_paths(root)
        self.assertGreater(len(captured), 0, "fixture must expose a non-empty inventory")
        carrier = {
            "crew_epoch": "converge_intent-0123456789abcdef0123456789abcdef",
            "ticket_id": "T-9001",
            "scope": {"a.txt": "768545ea733c4e17"},
        }

        from saipen_engine import release as release_module

        fake_git = SimpleNamespace(stdout="", ok=True, stderr="", rc=0)
        with mock.patch.object(
            release_module, "_push_endpoint", return_value=""
        ), mock.patch.object(
            release_module, "_branch_exists", return_value=True
        ), mock.patch.object(
            release_module, "_branch", return_value="main"
        ), mock.patch.object(
            release_module, "_log_hash", return_value="0" * 16
        ), mock.patch.object(
            release_module, "_check_parity", return_value=None
        ), mock.patch.object(
            release_module, "_git", return_value=fake_git
        ), mock.patch.object(
            release_module,
            "RemoteSnapshot",
            return_value=SimpleNamespace(
                classification=lambda: (release_module.REMOTE_ABSENT, ""),
                branch_tip=lambda branch: (True, ""),
                tag_commit=lambda tag: (False, ""),
                refs={},
            ),
        ), mock.patch.object(
            release_module, "_capture_index_state",
            return_value=SimpleNamespace(paths=(), entries=(), content_hash="0" * 16),
        ), mock.patch.object(
            release_module, "_read_confirmation", return_value=""
        ), mock.patch.object(
            release_module, "_read_state",
            return_value=("", {"phase": "DONE", "task": "none", "agent": "tester"}),
        ), mock.patch.object(
            release_module, "_read_board", return_value=("", {})
        ):
            plan = _plan_crew_release(
                root,
                "ship",
                "7.231.9",
                "",
                {"phase": "DONE", "task": "none", "agent": "tester"},
                "",
                {},
                "0" * 16,
                "project-identity",
                "deadbeef" * 5,
                "fingerprint",
                "git-delta-v1",
                "v7.231.9",
                carrier,
                False,
                source_paths=captured,
                current_capability="full",
                current_agent="tester",
            )
        expected_metadata = tuple(
            release_module._metadata_paths(root, source_paths=captured)
        )
        self.assertEqual(
            plan.metadata_paths, expected_metadata,
            "metadata_paths must derive from the inventory the caller captured",
        )
        self.assertGreaterEqual(len(plan.source_manifest), len(captured))

    def test_crew_release_counting_does_not_re_inventory(self) -> None:
        """The post-T-1193 invariant: one call-scoped inventory. The crew
        branch must use the inventory it is given, not run
        ``source_authority_paths`` again to build ``_metadata_paths`` or
        ``_source_authority_manifest``.
        """
        from saipen_engine import release as release_module
        from saipen_engine import release_contract

        root = self._root()
        (root / ".saipen/IDENTITY.md").write_text(
            "---\n"
            "project_lineage: lineage-b512942bac884a8691f6c98afcd6ddb9\n"
            "---\n",
            encoding="utf-8",
        )
        (root / "a.txt").write_bytes(b"crew scope content")
        captured_evidence = intake.capture(
            root, "PERF-006 crew count regression\n", source_kind="external_audit"
        )
        self.assertTrue(captured_evidence["ok"], captured_evidence)
        captured = release_contract.source_authority_paths(root)
        carrier = {
            "crew_epoch": "converge_intent-0123456789abcdef0123456789abcdef",
            "ticket_id": "T-9001",
            "scope": {"a.txt": "768545ea733c4e17"},
        }
        real_inv = release_contract.source_authority_paths
        calls: list[int] = []

        def counting_inv(*args, **kwargs):
            calls.append(1)
            return real_inv(*args, **kwargs)

        with mock.patch.object(
            release_contract, "source_authority_paths", side_effect=counting_inv
        ), mock.patch.object(release_module, "_push_endpoint", return_value=""), \
                 mock.patch.object(release_module, "_branch_exists", return_value=True), \
                 mock.patch.object(release_module, "_branch", return_value="main"), \
                 mock.patch.object(release_module, "_log_hash", return_value="0" * 16), \
                 mock.patch.object(release_module, "_check_parity", return_value=None), \
                 mock.patch.object(release_module, "_git",
                                   return_value=SimpleNamespace(
                                       stdout="", ok=True, stderr="", rc=0)), \
                 mock.patch.object(release_module, "RemoteSnapshot",
                                   return_value=SimpleNamespace(
                                       classification=lambda: (release_module.REMOTE_ABSENT, ""),
                                       branch_tip=lambda branch: (True, ""),
                                       tag_commit=lambda tag: (False, ""),
                                       refs={},
                                   )), \
                 mock.patch.object(release_module, "_capture_index_state",
                                   return_value=SimpleNamespace(
                                       paths=(), entries=(), content_hash="0" * 16)), \
                 mock.patch.object(release_module, "_read_confirmation", return_value=""), \
                 mock.patch.object(release_module, "_read_state",
                                   return_value=(
                                       "", {"phase": "DONE", "task": "none", "agent": "tester"}
                                   )), \
                 mock.patch.object(release_module, "_read_board", return_value=("", {})):
            release_module._plan_crew_release(
                root,
                "ship",
                "7.231.9",
                "",
                {"phase": "DONE", "task": "none", "agent": "tester"},
                "",
                {},
                "0" * 16,
                "project-identity",
                "deadbeef" * 5,
                "fingerprint",
                "git-delta-v1",
                "v7.231.9",
                carrier,
                False,
                source_paths=captured,
                current_capability="full",
                current_agent="tester",
            )
        self.assertEqual(
            sum(calls), 0,
            f"crew terminal plan must NOT re-invoke source_authority_paths; calls={calls}",
        )


class NoPublishPlanSourceAuthorityOnceTests(unittest.TestCase):
    """PERF-006 (no-publish branch): the no-publish plan MUST derive
    ``metadata_paths`` and ``source_manifest`` from the same call-scoped
    inventory the parent ``plan_release`` captures once, identical invariant
    to the ordinary and crew branches."""

    def _root(self) -> Path:
        root = Path(tempfile.mkdtemp(prefix="saipen-perf006-nopub-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)
        (root / ".saipen/IDENTITY.md").write_text(
            "---\n"
            "project_lineage: lineage-b512942bac884a8691f6c98afcd6ddb9\n"
            "---\n",
            encoding="utf-8",
        )
        (root / "VERSION").write_text("7.231.9\n", encoding="utf-8")
        return root

    def test_no_publish_plan_reuses_passed_inventory(self) -> None:
        from saipen_engine import release as release_module
        from saipen_engine import release_contract

        root = self._root()
        captured_evidence = intake.capture(
            root, "PERF-006 no-publish inventory regression\n", source_kind="external_audit"
        )
        self.assertTrue(captured_evidence["ok"], captured_evidence)
        captured = release_contract.source_authority_paths(root)
        self.assertGreater(len(captured), 0, "fixture must expose a non-empty inventory")
        expected_metadata = tuple(
            release_module._metadata_paths(root, source_paths=captured)
        )

        fake_git = SimpleNamespace(stdout="", ok=True, stderr="", rc=0)
        ticket = {"id": "T-NP-1"}
        # Wrap the module-level `source_authority_paths` to count real invocations
        # from inside plan_release, then patch the inventory call to feed the
        # already-captured list to the planner (this is the "call-scoped
        # inventory" the audit demands).
        from saipen_engine import release_contract as release_contract_for_inv

        def one_shot_inv(*args, **kwargs):
            return captured

        with mock.patch.object(
            release_contract_for_inv, "source_authority_paths", side_effect=one_shot_inv
        ), mock.patch.object(release_module, "_find_ticket", return_value=ticket), \
                 mock.patch.object(release_module, "_scope_paths", return_value=[]), \
                 mock.patch.object(release_module, "_scope_for", return_value={}), \
                 mock.patch.object(release_module, "_check_parity", return_value=None), \
                 mock.patch.object(release_module, "_read_mode", return_value="no-publish"), \
                 mock.patch.object(
                     release_module,
                     "_read_state",
                     return_value=("", {"phase": "SHIP", "task": "T-NP-1", "agent": "tester"}),
                 ), \
                 mock.patch.object(release_module, "_read_board", return_value=("", {})), \
                 mock.patch.object(release_module, "_log_hash", return_value="0" * 16), \
                 mock.patch.object(release_module, "_git", return_value=fake_git), \
                 mock.patch.object(release_module, "_read_confirmation", return_value=""), \
                 mock.patch.object(
                     release_module,
                     "_capture_index_state",
                     return_value=SimpleNamespace(paths=(), entries=(), content_hash="0" * 16),
                 ):
            plan = release_module.plan_release(
                root,
                "ship",
                current_capability="full",
                current_agent="tester",
            )
        # The inventory was fed once; metadata_paths and source_manifest
        # derived from it.
        self.assertEqual(
            plan.metadata_paths, expected_metadata,
            "no-publish metadata_paths must derive from the inventory the caller captured",
        )
        self.assertGreaterEqual(len(plan.source_manifest), len(captured))
        # The plan carries the captured list, not a fresh re-walk.
        self.assertEqual(
            plan.metadata_paths,
            tuple(release_module._metadata_paths(root, source_paths=captured)),
        )

    def test_no_publish_release_counting_does_not_re_inventory(self) -> None:
        from saipen_engine import release as release_module
        from saipen_engine import release_contract

        root = self._root()
        captured_evidence = intake.capture(
            root, "PERF-006 no-publish count regression\n", source_kind="external_audit"
        )
        self.assertTrue(captured_evidence["ok"], captured_evidence)
        real_inv = release_contract.source_authority_paths
        calls: list[int] = []

        def counting_inv(*args, **kwargs):
            calls.append(1)
            return real_inv(*args, **kwargs)

        ticket = {"id": "T-NP-1"}
        fake_git = SimpleNamespace(stdout="", ok=True, stderr="", rc=0)
        with mock.patch.object(
            release_contract, "source_authority_paths", side_effect=counting_inv
        ), mock.patch.object(release_module, "_find_ticket", return_value=ticket), \
                 mock.patch.object(release_module, "_scope_paths", return_value=[]), \
                 mock.patch.object(release_module, "_scope_for", return_value={}), \
                 mock.patch.object(release_module, "_check_parity", return_value=None), \
                 mock.patch.object(release_module, "_read_mode", return_value="no-publish"), \
                 mock.patch.object(
                     release_module,
                     "_read_state",
                     return_value=("", {"phase": "SHIP", "task": "T-NP-1", "agent": "tester"}),
                 ), \
                 mock.patch.object(release_module, "_read_board", return_value=("", {})), \
                 mock.patch.object(release_module, "_log_hash", return_value="0" * 16), \
                 mock.patch.object(release_module, "_git", return_value=fake_git), \
                 mock.patch.object(release_module, "_read_confirmation", return_value=""), \
                 mock.patch.object(
                     release_module,
                     "_capture_index_state",
                     return_value=SimpleNamespace(paths=(), entries=(), content_hash="0" * 16),
                 ):
            release_module.plan_release(
                root,
                "ship",
                current_capability="full",
                current_agent="tester",
            )
        # PERF-006: one inventory per PLAN. The no-publish branch invokes
        # source_authority_paths exactly once (the top-level import in
        # plan_release) and passes the result to both _metadata_paths and
        # _source_authority_manifest.
        self.assertEqual(
            sum(calls), 1,
            f"no-publish plan must invoke source_authority_paths exactly once; calls={calls}",
        )


class OrdinaryPlanSourceAuthorityOnceTests(unittest.TestCase):
    """PERF-006 (ordinary branch): the FULL-mode release plan MUST invoke
    ``source_authority_paths`` exactly once and feed both ``metadata_paths``
    and ``source_manifest`` from the captured list."""

    def _root(self) -> Path:
        root = Path(tempfile.mkdtemp(prefix="saipen-perf006-ord-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)
        (root / ".saipen/IDENTITY.md").write_text(
            "---\n"
            "project_lineage: lineage-b512942bac884a8691f6c98afcd6ddb9\n"
            "---\n",
            encoding="utf-8",
        )
        (root / "VERSION").write_text("7.231.9\n", encoding="utf-8")
        # No-publish path is skipped when the git fixture is absent and the
        # plan can read state; we DO want full mode here. We patch every
        # external dependency.
        return root

    def test_ordinary_release_counting_does_not_re_inventory(self) -> None:
        from saipen_engine import release as release_module
        from saipen_engine import release_contract

        root = self._root()
        captured_evidence = intake.capture(
            root, "PERF-006 ordinary count regression\n", source_kind="external_audit"
        )
        self.assertTrue(captured_evidence["ok"], captured_evidence)
        real_inv = release_contract.source_authority_paths
        calls: list[int] = []

        def counting_inv(*args, **kwargs):
            calls.append(1)
            return real_inv(*args, **kwargs)

        fake_git = SimpleNamespace(stdout="", ok=True, stderr="", rc=0)
        ticket = {"id": "T-ORD-1"}
        patchers = [
            mock.patch.object(
                release_contract, "source_authority_paths", side_effect=counting_inv
            ),
            mock.patch.object(release_module, "_push_endpoint", return_value=""),
            mock.patch.object(release_module, "_branch_exists", return_value=True),
            mock.patch.object(release_module, "_branch", return_value="main"),
            mock.patch.object(release_module, "_log_hash", return_value="0" * 16),
            mock.patch.object(release_module, "_check_parity", return_value=None),
            mock.patch.object(release_module, "_read_mode", return_value="full"),
            mock.patch.object(
                release_module,
                "_read_state",
                return_value=(
                    "",
                    {"phase": "SHIP", "task": "T-ORD-1", "agent": "tester"},
                ),
            ),
            mock.patch.object(release_module, "_read_board", return_value=("", {})),
            mock.patch.object(release_module, "_find_ticket", return_value=ticket),
            mock.patch.object(release_module, "_scope_paths", return_value=[]),
            mock.patch.object(release_module, "_scope_for", return_value={}),
            mock.patch.object(release_module, "_read_confirmation", return_value=""),
            mock.patch.object(
                release_module, "_local_tag_commit", return_value=(False, ""),
            ),
            mock.patch.object(
                release_module,
                "RemoteSnapshot",
                return_value=SimpleNamespace(
                    classification=lambda: (release_module.REMOTE_ABSENT, ""),
                    branch_tip=lambda branch: (True, ""),
                    tag_commit=lambda tag: (False, ""),
                    refs={},
                ),
            ),
            mock.patch.object(release_module, "_release_evidence", return_value=([], ())),
            mock.patch.object(
                release_module,
                "_classify_continuation",
                return_value={
                    "start_stage": release_module.START_PREPARED,
                    "content_already_committed": False,
                    "already_applied": False,
                    "first_publish_wait": True,
                },
            ),
            mock.patch.object(release_module, "_head_relation", return_value="local"),
            mock.patch.object(
                release_module, "_installed_version", return_value="7.231.9",
            ),
            mock.patch.object(release_module, "_git", return_value=fake_git),
            mock.patch.object(
                release_module,
                "_capture_index_state",
                return_value=SimpleNamespace(paths=(), entries=(), content_hash="0" * 16),
            ),
        ]
        from contextlib import ExitStack

        with ExitStack() as stack:
            for patcher in patchers:
                stack.enter_context(patcher)
            release_module.plan_release(
                root,
                "ship",
                current_capability="full",
                current_agent="tester",
            )
        self.assertEqual(
            sum(calls), 1,
            f"ordinary PLAN must invoke source_authority_paths exactly once; calls={calls}",
        )


if __name__ == "__main__":
    unittest.main()
