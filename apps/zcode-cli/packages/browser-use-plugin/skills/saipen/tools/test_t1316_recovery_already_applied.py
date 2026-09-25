"""T-1316 (SRC-027): recovery already-applied journal reconciliation.

Regression suite for the ProTrail incident class: an interrupted multi-target
mutation whose live targets already sit exactly at after_hash must converge to
the ordinary COMMITTED terminal state through canonical recovery -- never stay
stranded behind stale CONFLICT/PREPARED bookkeeping, never replay semantic
writes, and never normalize a real third-state conflict.

Every fixture constructs the UNREPAIRED incident journal state (stale markers,
interrupted sidecar, live bytes), then drives the public recovery entry point
from disk, exactly as a restart would.
"""

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from saipen_engine import journal as journal_mod
from saipen_engine import router as router_mod
from saipen_engine.journal import ensure_project_lineage
from saipen_engine.lock import project_writer_lock
from saipen_engine.paths import runtime_lock_identity

TOOLS = Path(__file__).resolve().parent


def _before(role: str) -> bytes:
    return f"before {role}\n".encode("utf-8")


def _after(role: str) -> bytes:
    return f"after {role}\n".encode("utf-8")


def _third(role: str) -> bytes:
    return f"third {role}\n".encode("utf-8")


def _tree_digest(root: Path) -> str:
    """Content digest of the whole disposable project (byte-exact witness)."""
    payload = bytearray()
    for path in sorted(root.rglob("*")):
        if path.is_file() and "__pycache__" not in str(path):
            payload.extend(str(path).encode())
            payload.extend(hashlib.sha256(path.read_bytes()).digest())
    return hashlib.sha256(payload).hexdigest()


class RecoveryFixture(unittest.TestCase):
    """One disposable project per test; three-target generic operation."""

    ROLES = ("alpha", "beta", "gamma")

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="t1316-"))
        (self.root / ".saipen").mkdir()
        with project_writer_lock(self.root):
            self.lineage = ensure_project_lineage(self.root)
        self.identity = runtime_lock_identity(self.root)
        self.op_id = "op-t1316-fixture"
        self.write_before_bytes()

    def tearDown(self) -> None:
        import shutil

        shutil.rmtree(self.root, ignore_errors=True)

    # -- fixture helpers ---------------------------------------------------

    def write_before_bytes(self) -> None:
        for role in self.ROLES:
            (self.root / f"{role}.txt").write_bytes(_before(role))

    def targets(self) -> list[dict]:
        return [
            {
                "path": f"{role}.txt",
                "role": "generic",
                "action": "write",
                "content": _after(role).decode("utf-8"),
            }
            for role in self.ROLES
        ]

    def preconditions(self) -> dict:
        prec = {}
        for role in self.ROLES:
            prec[f"{role}.txt"] = journal_mod.hash_file_dependency(self.root / f"{role}.txt")
        return prec

    def run_apply(self, crash_role: str | None = None) -> dict:
        """run_mutation for the three targets; crash after crash_role's bytes
        are durable but before any journal progress records them."""
        real_write = journal_mod._atomic_write
        self.plan_preconditions = self.preconditions()

        def maybe_crash(path, content, *, ownership_root):
            real_write(path, content, ownership_root=ownership_root)
            if crash_role is not None and path.name == f"{crash_role}.txt":
                raise OSError(f"NITRO: {path.name} bytes durable, progress lost")

        with project_writer_lock(self.root), mock.patch.object(
            journal_mod, "_atomic_write", side_effect=maybe_crash
        ):
            return journal_mod.run_mutation(
                self.root,
                self.op_id,
                "generic",
                "tester",
                self.identity,
                "t1316-payload",
                self.targets(),
                preconditions=self.plan_preconditions,
                verification_policy="none",
                _ensure_lineage=False,
            )

    def retry_apply(self) -> dict:
        """Exact retry of the same plan (plan-time preconditions)."""
        with project_writer_lock(self.root):
            return journal_mod.run_mutation(
                self.root,
                self.op_id,
                "generic",
                "tester",
                self.identity,
                "t1316-payload",
                self.targets(),
                preconditions=self.plan_preconditions,
                verification_policy="none",
                _ensure_lineage=False,
            )

    def live_bytes(self) -> dict:
        return {role: (self.root / f"{role}.txt").read_bytes() for role in self.ROLES}

    def active_manifest_path(self) -> Path:
        return self.root / journal_mod.OPS_DIR / self.op_id / "operation.json"

    def settled_manifest_path(self) -> Path:
        return self.root / journal_mod.SETTLED_DIR / self.op_id / "operation.json"

    def manifest(self) -> dict:
        """Canonical operation authority, wherever settlement put it.

        Journal resolves exactly this precedence: the active receipt under
        recovery/ops wins while it exists (a corrupt active receipt must stay
        visible), otherwise the settled receipt under recovery/settled. A
        terminal assertion must therefore never assume recovery/ops -- a
        successful settle MOVES the receipt. (T-1316 defect #1: the harness
        used to read recovery/ops only and reported FileNotFoundError after a
        correct settlement.)
        """
        return json.loads(
            journal_mod.Journal(self.root, self.op_id).manifest.read_text(encoding="utf-8")
        )

    def sidecar(self) -> dict | None:
        path = journal_mod.Journal(self.root, self.op_id).dir / "progress.json"
        if not path.is_file():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def settled_receipts(self) -> set[str]:
        settled = self.root / journal_mod.SETTLED_DIR
        if not settled.is_dir():
            return set()
        return {
            entry.name
            for entry in settled.iterdir()
            if entry.is_dir() and not entry.name.startswith(".")
        }

    def rebuild_stale_prepared_manifest(self, restore_before: str | None = None) -> None:
        """Force the legacy no-sidecar stale shape: manifest PREPARED,
        progress_index 0, every applied marker false, sidecar removed."""
        settled_dir = journal_mod.Journal(self.root, self.op_id).dir
        journal_dir = journal_mod.safe_op_dir(self.root, self.op_id)
        if settled_dir != journal_dir and settled_dir.is_dir():
            journal_dir.parent.mkdir(parents=True, exist_ok=True)
            settled_dir.rename(journal_dir)
        sidecar = journal_dir / "progress.json"
        if sidecar.is_file():
            sidecar.unlink()
        record = self.manifest()
        record["status"] = "PREPARED"
        record["progress_index"] = 0
        for target in record["targets"]:
            target["applied"] = False
        (journal_dir / "operation.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        if restore_before is not None:
            (self.root / f"{restore_before}.txt").write_bytes(_before(restore_before))

    def recover(self) -> dict:
        return journal_mod.recover(self.root, self.op_id)

    def instrument_target_writes(self):
        """Count canonical target writes that happen while active."""
        real_write = journal_mod._atomic_write
        writes: list[str] = []

        def counting(path, content, *, ownership_root):
            writes.append(Path(path).name)
            return real_write(path, content, ownership_root=ownership_root)

        self._writes = writes  # type: ignore[attr-defined]
        return mock.patch.object(journal_mod, "_atomic_write", side_effect=counting)

    def assert_committed_terminal(self, result: dict) -> None:
        """R007 representation convergence: ONE canonical terminal authority.

        Asserts the full convergence contract, not just the result code:
        the settled receipt exists, its status is COMMITTED, progress was
        folded out of the sidecar, the applied frontier covers every target,
        no PREPARED active receipt survives as competing authority, and the
        op is no longer unresolved work.
        """
        self.assertTrue(result.get("ok"), result)
        self.assertEqual(result.get("code"), "COMMITTED", result)
        self.assertEqual(journal_mod.pending_ops(self.root), [])
        self.assertIsNone(self.sidecar(), "settled receipt must fold its sidecar")
        self.assertIn(
            self.op_id,
            self.settled_receipts(),
            "canonical settled receipt must exist once settlement succeeds",
        )
        self.assertTrue(
            self.settled_manifest_path().is_file(),
            "settled operation.json is the terminal authority",
        )
        record = self.manifest()
        self.assertEqual(record["status"], "COMMITTED", record)
        self.assertEqual(
            record["progress_index"],
            len(record["targets"]),
            "terminal progress must cover every target",
        )
        self.assertTrue(
            all(target["applied"] for target in record["targets"]),
            f"every target must be marked applied at terminal state: {record}",
        )
        self.assertFalse(
            self.active_manifest_path().exists(),
            "settled operation must not leave a competing active receipt",
        )


class ClassifierUnitTests(unittest.TestCase):
    """Phase 1: the ONE canonical three-way classifier."""

    def test_three_outcomes(self):
        self.assertEqual(journal_mod.classify_target("A", "B", "A"), "ALREADY_APPLIED")
        self.assertEqual(journal_mod.classify_target("B", "B", "A"), "PENDING")
        self.assertEqual(journal_mod.classify_target("C", "B", "A"), "CONFLICT")

    def test_noop_target_is_deterministically_satisfied(self):
        self.assertEqual(journal_mod.classify_target("X", "X", "X"), "ALREADY_APPLIED")

    def test_missing_file_sentinels_classify_through_same_model(self):
        # delete_file: absent file hashes "" (the after state); recreated
        # content hashes back to its before hash; anything else is a conflict.
        self.assertEqual(journal_mod.classify_target("", "deadbeef", ""), "ALREADY_APPLIED")
        self.assertEqual(journal_mod.classify_target("deadbeef", "deadbeef", ""), "PENDING")
        self.assertEqual(journal_mod.classify_target("cafebabe", "deadbeef", ""), "CONFLICT")


class ProTrailIncidentTests(RecoveryFixture):
    """Phase 10 / R010: the exact production incident shape."""

    def test_incident_construction_matches_reported_shape(self):
        # All three writes durable; only alpha's progress was journaled; the
        # failure handler left a CONFLICT sidecar over a PREPARED manifest.
        result = self.run_apply(crash_role="gamma")
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "CONFLICT", result)
        self.assertEqual(
            self.live_bytes(),
            {role: _after(role) for role in self.ROLES},
            "fixture must reproduce fully materialized live targets",
        )
        record = self.manifest()
        self.assertEqual(record["status"], "PREPARED", record)
        self.assertEqual(record["progress_index"], 0, record)
        sidecar = self.sidecar()
        self.assertIsNotNone(sidecar)
        self.assertEqual(sidecar["status"], "CONFLICT", sidecar)

    def test_fully_materialized_conflict_op_converges_without_rewrites(self):
        self.run_apply(crash_role="gamma")
        before_recovery = self.live_bytes()
        with self.instrument_target_writes():
            result = self.recover()
        self.assertEqual(self._writes, [], "recovery rewrote materialized targets")
        self.assert_committed_terminal(result)
        self.assertEqual(self.live_bytes(), before_recovery)

    def test_convergence_is_idempotent_and_exact_retry_is_idempotent(self):
        self.run_apply(crash_role="gamma")
        first = self.recover()
        self.assert_committed_terminal(first)
        second = self.recover()
        self.assertTrue(second["ok"], second)
        self.assertEqual(second["code"], "ALREADY_APPLIED", second)
        digest_before = self._tree_digest()
        third = self.recover()
        self.assertEqual(third["code"], "ALREADY_APPLIED", third)
        self.assertEqual(self._tree_digest(), digest_before, "third recovery wrote")

    def _tree_digest(self) -> str:
        payload = bytearray()
        for path in sorted(self.root.rglob("*")):
            if path.is_file() and "__pycache__" not in str(path):
                payload.extend(str(path).encode())
                payload.extend(hashlib.sha256(path.read_bytes()).digest())
        return hashlib.sha256(payload).hexdigest()

    def test_exact_apply_retry_reports_existing_success(self):
        self.run_apply(crash_role="gamma")
        self.recover()
        retry = self.retry_apply()
        self.assertTrue(retry["ok"], retry)
        self.assertEqual(retry["code"], "ALREADY_APPLIED", retry)

    def test_recovery_preflight_clean_after_convergence(self):
        self.run_apply(crash_role="gamma")
        self.recover()
        preflight = journal_mod.recovery_preflight(self.root)
        self.assertTrue(preflight.get("ok"), preflight)
        self.assertEqual(preflight.get("recovered"), [], preflight)


class PartialPrefixTests(RecoveryFixture):
    """Phase 5 / Phase 11 / R005: resume without replaying completed targets."""

    def test_prefix_resume_applies_only_pending_suffix(self):
        # beta's bytes durable, no journal progress for beta: recovery must
        # repair the frontier, then apply exactly gamma.
        result = self.run_apply(crash_role="beta")
        self.assertFalse(result["ok"], result)
        alpha_and_beta = {role: self.live_bytes()[role] for role in ("alpha", "beta")}
        with self.instrument_target_writes():
            recovered = self.recover()
        self.assertEqual(self._writes, ["gamma.txt"], self._writes)
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["code"], "COMMITTED", recovered)
        self.assertEqual(self.live_bytes()["alpha"], alpha_and_beta["alpha"], "alpha was rewritten")
        self.assertEqual(self.live_bytes()["beta"], alpha_and_beta["beta"], "beta was rewritten")
        self.assertEqual(self.live_bytes()["gamma"], _after("gamma"))
        self.assert_committed_terminal(recovered)

    def test_stale_full_after_without_sidecar_converges(self):
        # Legacy no-sidecar receipt: manifest PREPARED, applied markers all
        # false, but every live target already sits at after_hash.
        self.run_apply(crash_role="gamma")
        self.rebuild_stale_prepared_manifest()
        with self.instrument_target_writes():
            result = self.recover()
        self.assertEqual(self._writes, [], "legacy stale receipt triggered rewrites")
        self.assert_committed_terminal(result)


class HostileThirdStateTests(RecoveryFixture):
    """Phase 6 / Phase 12 / R006: real conflicts stay conflicts, fail closed."""

    def test_third_state_refuses_with_report_and_preserves_bytes(self):
        result = self.run_apply(crash_role="beta")
        self.assertFalse(result["ok"], result)
        (self.root / "beta.txt").write_bytes(_third("beta"))
        frozen = self.live_bytes()
        with self.instrument_target_writes():
            recovered = self.recover()
        self.assertFalse(recovered["ok"], recovered)
        self.assertEqual(recovered["code"], "RECOVERY_CONFLICT", recovered)
        self.assertEqual(recovered["target_path"], "beta.txt", recovered)
        self.assertEqual(recovered["target_index"], 1, recovered)
        self.assertEqual(recovered["actual_hash"], journal_mod.hash_bytes(_third("beta")))
        self.assertEqual(recovered["expected_after_hash"], journal_mod.hash_bytes(_after("beta")))
        self.assertEqual(recovered["expected_before_hash"], journal_mod.hash_bytes(_before("beta")))
        self.assertEqual(recovered["applied_frontier"], 0, recovered)
        self.assertEqual(self.live_bytes(), frozen, "conflict recovery mutated bytes")
        self.assertEqual(self._writes, [], self._writes)
        pending_ids = {op["op_id"] for op in journal_mod.pending_ops(self.root)}
        self.assertIn(self.op_id, pending_ids, "conflict must stay unresolved debt")

    def test_repeated_third_state_recovery_is_stable(self):
        self.run_apply(crash_role="beta")
        (self.root / "beta.txt").write_bytes(_third("beta"))
        first = self.recover()
        second = self.recover()
        self.assertEqual(first["code"], "RECOVERY_CONFLICT", first)
        self.assertEqual(second["code"], "RECOVERY_CONFLICT", second)
        self.assertEqual(second["target_index"], first.get("target_index"), second)

    def test_non_prefix_materialization_fails_closed(self):
        # BEFORE AFTER BEFORE: beta materialized ahead of alpha -- no legal
        # crash shape for an ordered plan, never normalized.
        self.run_apply(crash_role="beta")
        (self.root / "alpha.txt").write_bytes(_before("alpha"))
        self.rebuild_stale_prepared_manifest()
        frozen = self.live_bytes()
        with self.instrument_target_writes():
            recovered = self.recover()
        self.assertFalse(recovered["ok"], recovered)
        self.assertEqual(recovered["code"], "RECOVERY_CONFLICT", recovered)
        self.assertIn("out of order", recovered["detail"], recovered)
        self.assertEqual(self.live_bytes(), frozen)
        self.assertEqual(self._writes, [], self._writes)


class StaleMarkerAbortTests(RecoveryFixture):
    """Phase 2/4: the PREPARED abort decision comes from bytes, not markers."""

    def test_prepared_with_zero_materialized_targets_still_aborts(self):
        # Crash before any durable progress: all bytes BEFORE. The stale
        # incident sidecar is removed to prove the abort decision is byte
        # driven, not marker driven.
        result = self.run_apply(crash_role="alpha")
        self.assertFalse(result["ok"], result)
        self.rebuild_stale_prepared_manifest(restore_before="alpha")
        recovered = self.recover()
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["code"], "ABORTED", recovered)
        self.assertEqual(self.live_bytes(), {role: _before(role) for role in self.ROLES})

    def test_prepared_full_after_is_never_aborted(self):
        # The pre-fix defect: stale PREPARED markers over materialized bytes
        # were blindly ABORTED, stranding applied work as "never happened".
        self.run_apply(crash_role="gamma")
        self.rebuild_stale_prepared_manifest()
        recovered = self.recover()
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["code"], "COMMITTED", recovered)
        self.assert_committed_terminal(recovered)


class TerminalSettlementTests(RecoveryFixture):
    """Phase 14 / R012: committed authority survives settlement failure."""

    def test_committed_manifest_with_failed_settle_move_still_idempotent(self):
        self.plan_preconditions = self.preconditions()
        ops_dir = journal_mod.safe_op_dir(self.root, self.op_id)
        real_rename = journal_mod.os.rename

        def failing_settle_move(source, destination):
            if Path(source) == ops_dir:
                raise OSError("NITRO: settle move interrupted")
            return real_rename(source, destination)

        with project_writer_lock(self.root), mock.patch.object(
            journal_mod.os, "rename", side_effect=failing_settle_move
        ):
            result = journal_mod.run_mutation(
                self.root,
                self.op_id,
                "generic",
                "tester",
                self.identity,
                "t1316-payload",
                self.targets(),
                preconditions=self.plan_preconditions,
                verification_policy="none",
                _ensure_lineage=False,
            )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "COMMITTED", result)
        self.assertTrue((ops_dir / "operation.json").is_file())
        record = self.manifest()
        self.assertEqual(record["status"], "COMMITTED", record)
        self.assertEqual(record["progress_index"], len(record["targets"]), record)
        self.assertTrue(all(target["applied"] for target in record["targets"]), record)
        self.assertEqual(journal_mod.pending_ops(self.root), [])
        self.assertIsNone(self.sidecar())

        # A later successful settlement moves the same durable terminal
        # authority; it does not create a second semantic result.
        journal_mod._settle_journal(journal_mod.Journal(self.root, self.op_id))
        self.assertTrue(
            (self.root / journal_mod.SETTLED_DIR / self.op_id / "operation.json").is_file()
        )
        retry = self.recover()
        self.assertTrue(retry["ok"], retry)
        self.assertEqual(retry["code"], "ALREADY_APPLIED", retry)


class CrashWindowMatrixTests(RecoveryFixture):
    """Phase 9 / R009: restart-from-disk recovery at every crash window."""

    def _recover_and_assert(self, crash_role: str) -> dict:
        result = self.run_apply(crash_role=crash_role)
        self.assertFalse(result["ok"], result)
        with self.instrument_target_writes():
            recovered = self.recover()
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["code"], "COMMITTED", recovered)
        self.assertEqual(
            self.live_bytes(),
            {role: _after(role) for role in self.ROLES},
            "target regression after recovery",
        )
        # No duplicate semantic mutation: only genuinely pending targets may
        # have been written during recovery.
        written = set(self._writes)
        self.assertTrue(written <= {f"{r}.txt" for r in self.ROLES}, written)
        self.assert_committed_terminal(recovered)
        again = self.recover()
        self.assertEqual(again["code"], "ALREADY_APPLIED", again)
        return recovered

    def test_crash_before_prepared_is_durable_leaves_nothing_pending(self):
        real_json = journal_mod._atomic_json

        def crash_manifest(path, record, *, ownership_root):
            if Path(path).name == "operation.json":
                raise OSError("NITRO: PREPARED never became durable")
            return real_json(path, record, ownership_root=ownership_root)

        with project_writer_lock(self.root), mock.patch.object(
            journal_mod, "_atomic_json", side_effect=crash_manifest
        ):
            result = journal_mod.run_mutation(
                self.root,
                self.op_id,
                "generic",
                "tester",
                self.identity,
                "t1316-payload",
                self.targets(),
                preconditions=self.preconditions(),
                verification_policy="none",
                _ensure_lineage=False,
            )
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "CORRUPT_JOURNAL", result)
        self.assertTrue(result["recovery_required"], result)
        self.assertEqual(journal_mod.pending_ops(self.root), [])
        self.assertEqual(self.live_bytes(), {role: _before(role) for role in self.ROLES})

    def test_crash_after_prepared_before_first_write(self):
        # PREPARED durable, APPLYING mark durable, zero target bytes: recovery
        # applies all three in order.
        def crash_first_write(path, content, *, ownership_root):
            raise OSError("NITRO: crash after PREPARED, before first write")

        with project_writer_lock(self.root), mock.patch.object(
            journal_mod, "_atomic_write", side_effect=crash_first_write
        ):
            result = journal_mod.run_mutation(
                self.root,
                self.op_id,
                "generic",
                "tester",
                self.identity,
                "t1316-payload",
                self.targets(),
                preconditions=self.preconditions(),
                verification_policy="none",
                _ensure_lineage=False,
            )
        self.assertFalse(result["ok"], result)
        recovered = self.recover()
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["code"], "COMMITTED", recovered)
        self.assertEqual(self.live_bytes(), {role: _after(role) for role in self.ROLES})
        self.assertEqual(journal_mod.pending_ops(self.root), [])

    def test_crash_windows_alpha_beta_gamma(self):
        for role in self.ROLES:
            with self.subTest(crash_role=role):
                self.setUp()
                try:
                    self._recover_and_assert(role)
                finally:
                    self.tearDown()

    def test_crash_after_progress_durable_before_next_write(self):
        """Window D: alpha's bytes AND alpha's journal progress are durable,
        the next target was never attempted. Recovery must repair the
        frontier and apply exactly beta and gamma -- never alpha."""
        real_mark = journal_mod.Journal.mark

        def crash_after_first_progress(self, status, progress_index=None, target_index=None):
            real_mark(self, status, progress_index=progress_index, target_index=target_index)
            if status == "APPLYING" and target_index == 0:
                raise OSError("NITRO: alpha progress durable, beta never started")

        # A durable-progress crash is a process death, not a handled
        # exception: nothing in memory survives, and recovery must start
        # from DISK. The injected fault therefore ends the caller exactly
        # as a NITRO kill would.
        result = None
        with self.assertRaises(OSError), project_writer_lock(self.root), mock.patch.object(
            journal_mod.Journal, "mark", crash_after_first_progress
        ):
            result = journal_mod.run_mutation(
                self.root,
                self.op_id,
                "generic",
                "tester",
                self.identity,
                "t1316-payload",
                self.targets(),
                preconditions=self.preconditions(),
                verification_policy="none",
                _ensure_lineage=False,
            )
        self.assertIsNone(result, "no in-memory result survives a hard crash")
        self.assertEqual(self.live_bytes()["alpha"], _after("alpha"))
        self.assertEqual(self.live_bytes()["beta"], _before("beta"))
        self.assertEqual(self.live_bytes()["gamma"], _before("gamma"))
        with self.instrument_target_writes():
            recovered = self.recover()
        self.assertEqual(self._writes, ["beta.txt", "gamma.txt"], self._writes)
        self.assertEqual(recovered["code"], "COMMITTED", recovered)
        self.assertEqual(self.live_bytes(), {role: _after(role) for role in self.ROLES})
        self.assert_committed_terminal(recovered)
        self.assertEqual(self.recover()["code"], "ALREADY_APPLIED")

    def test_crash_after_all_represented_applied_before_verify(self):
        """R009 window F: every target's progress is durable (the receipt
        represents all three applied) and semantic VERIFY has NOT run yet.

        Distinct from window E (bytes durable, frontier NOT represented) and
        from window G (VERIFY durably recorded). The crash is injected after
        the real progress publication of the LAST target, so nothing is
        hand-edited and the state is genuinely pre-VERIFY.
        """
        real_mark = journal_mod.Journal.mark
        last = len(self.ROLES) - 1

        def crash_after_last_progress(self, status, progress_index=None, target_index=None):
            real_mark(self, status, progress_index=progress_index, target_index=target_index)
            if status == "APPLYING" and target_index == last:
                raise OSError("NITRO: all targets represented applied, VERIFY not run")

        with self.assertRaises(OSError), project_writer_lock(self.root), mock.patch.object(
            journal_mod.Journal, "mark", crash_after_last_progress
        ):
            journal_mod.run_mutation(
                self.root,
                self.op_id,
                "generic",
                "tester",
                self.identity,
                "t1316-payload",
                self.targets(),
                preconditions=self.preconditions(),
                verification_policy="none",
                _ensure_lineage=False,
            )
        # All three target bytes are durable before the crash.
        self.assertEqual(self.live_bytes(), {role: _after(role) for role in self.ROLES})
        with self.instrument_target_writes():
            recovered = self.recover()
        self.assertEqual(self._writes, [], "already applied targets were rewritten")
        self.assertEqual(recovered["code"], "COMMITTED", recovered)
        self.assert_committed_terminal(recovered)
        self.assertEqual(self.recover()["code"], "ALREADY_APPLIED")

    def test_crash_after_verify_durable_before_terminal_committed(self):
        # R009 window G: semantic VERIFY is durably recorded, terminal
        # COMMITTED is not. Recovery must converge with zero target writes and
        # rerun the verifier before the terminal transition. NOTE: the VERIFIED
        # sidecar here is SYNTHETIC -- this fixture proves window G only and is
        # never counted as window F (see
        # test_crash_after_all_represented_applied_before_verify for the real
        # pre-VERIFY window).
        result = self.run_apply(crash_role="gamma")
        self.assertFalse(result["ok"], result)
        journal_dir = journal_mod.safe_op_dir(self.root, self.op_id)
        sidecar = journal_dir / "progress.json"
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        data["status"] = "VERIFIED"
        data["progress_index"] = 3
        sidecar.write_text(json.dumps(data), encoding="utf-8")
        with self.instrument_target_writes():
            recovered = self.recover()
        self.assertEqual(self._writes, [], self._writes)
        self.assert_committed_terminal(recovered)
        self.assertEqual(self.recover()["code"], "ALREADY_APPLIED")


class BookkeepingRepairCrashTests(RecoveryFixture):
    """R003: a crash inside the canonical bookkeeping repair is safely
    repeatable. The repair is not optional and not hand-editable -- recovery
    must be able to re-derive the SAME frontier from live bytes after the
    publication itself died mid-flight."""

    def test_crash_at_reconciliation_publication_is_repeatable(self):
        # Stale metadata over fully materialized bytes: recovery's first job is
        # the bookkeeping repair through Journal.reconcile_progress.
        self.run_apply(crash_role="gamma")
        self.rebuild_stale_prepared_manifest()
        frozen = self.live_bytes()
        real_json = journal_mod._atomic_json
        real_reconcile = journal_mod.Journal.reconcile_progress
        flag = {"in_reconcile": False}

        def tracking_reconcile(self, status, progress_index, applied_frontier):
            flag["in_reconcile"] = True
            try:
                return real_reconcile(self, status, progress_index, applied_frontier)
            finally:
                flag["in_reconcile"] = False

        def crash_at_progress_publication(path, record, *, ownership_root):
            if flag["in_reconcile"] and Path(path).name == "progress.json":
                raise OSError("NITRO: reconciliation publication interrupted")
            return real_json(path, record, ownership_root=ownership_root)

        with mock.patch.object(
            journal_mod.Journal, "reconcile_progress", tracking_reconcile
        ), mock.patch.object(
            journal_mod,
            "_atomic_json",
            side_effect=crash_at_progress_publication,
        ), self.assertRaises(OSError):
            self.recover()

        # A bookkeeping crash must never touch semantic target bytes.
        self.assertEqual(self.live_bytes(), frozen, "bookkeeping crash mutated target bytes")
        pending_ids = {op["op_id"] for op in journal_mod.pending_ops(self.root)}
        self.assertIn(self.op_id, pending_ids, "an unrepaired bookkeeping op must stay visible")

        # Restart from DISK: the same frontier is re-derived from live bytes.
        with self.instrument_target_writes():
            recovered = self.recover()
        self.assertEqual(self._writes, [], "materialized prefix was rewritten")
        self.assertEqual(recovered["code"], "COMMITTED", recovered)
        self.assert_committed_terminal(recovered)
        self.assertEqual(self.recover()["code"], "ALREADY_APPLIED")


class PublicRecoveryEntryPointTests(RecoveryFixture):
    """R008/R013: the canonical public recovery surfaces, not just
    journal.recover() directly -- and the conformance check itself is an
    observer, never a hidden auto-healer."""

    def test_preflight_refuses_then_explicit_recovery_cleans_it(self):
        self.run_apply(crash_role="gamma")
        frozen = _tree_digest(self.root)

        # The stale PREPARED/CONFLICT + AFTER/AFTER/AFTER incident is
        # unresolved BEFORE recovery: the existing preflight refuses and
        # names the op instead of normalizing it.
        preflight = journal_mod.recovery_preflight(self.root)
        self.assertFalse(preflight.get("ok"), preflight)
        self.assertEqual(preflight.get("code"), "RECOVERY_CONFLICT", preflight)
        self.assertIn(self.op_id, preflight.get("op_ids", []), preflight)
        self.assertTrue(preflight.get("recovery_required"), preflight)
        self.assertEqual(
            _tree_digest(self.root),
            frozen,
            "an observing preflight must not mutate the incident it reports",
        )

        # Canonical recovery (the exact public entry point `saipen recover`
        # drives for one op) converges the SAME bytes through the SAME
        # classifier. No parallel recovery subsystem, no new command.
        recovered = journal_mod.recover(self.root, self.op_id)
        self.assert_committed_terminal(recovered)

        clean = journal_mod.recovery_preflight(self.root)
        self.assertTrue(clean.get("ok"), clean)
        self.assertEqual(clean.get("recovered"), [], clean)
        self.assertEqual(
            journal_mod.pending_ops(self.root), [], "terminal op must not stay pending"
        )

    def test_conformance_reports_debt_before_recovery_and_passes_after(self):
        """R008: the real conformance/observation surface reports debt on an
        unresolved incident, performs ZERO repair writes, and reads green only
        after the canonical recovery converges the same incident.

        `journal.recovery_preflight` IS the canonical zero-write conformance
        observer for recovery debt (improve/mutations consult it read-only);
        the validator surface that would auto-heal is refused by contract.
        """
        self.run_apply(crash_role="gamma")

        # BEFORE: conformance is non-green -- the unresolved incident is
        # recovery debt, truthfully refused, with the op named.
        from saipen_engine.release import ReleaseRefusal, _recovery_preflight

        with self.assertRaises(ReleaseRefusal) as refusal_ctx:
            _recovery_preflight(self.root)
        self.assertIn(
            refusal_ctx.exception.code,
            {"RECOVERY_REQUIRED", "RECOVERY_CONFLICT"},
            str(refusal_ctx.exception),
        )

        before = journal_mod.recovery_preflight(self.root)
        self.assertFalse(before.get("ok"), before)
        self.assertTrue(before.get("recovery_required"), before)
        self.assertIn(self.op_id, before.get("op_ids", []), before)
        frozen = _tree_digest(self.root)

        # Conformance is observational: zero repair writes while refusing.
        # (A second observation run over unchanged bytes proves it again.)
        with self.assertRaises(ReleaseRefusal):
            _recovery_preflight(self.root)
        again = journal_mod.recovery_preflight(self.root)
        self.assertFalse(again.get("ok"), again)
        self.assertEqual(
            _tree_digest(self.root),
            frozen,
            "the conformance observer performed repair writes",
        )

        # Canonical recovery converges the incident.
        with self.instrument_target_writes():
            recovered = journal_mod.recover(self.root, self.op_id)
        self.assertEqual(self._writes, [], "recovery rewrote materialized targets")
        self.assert_committed_terminal(recovered)

        # AFTER: the SAME conformance surface is green over the converged
        # state. No alternative recovery engine ran, no state was normalized
        # by the observer -- the bytes changed only through the canonical
        # recovery writer.
        _recovery_preflight(self.root)
        after = journal_mod.recovery_preflight(self.root)
        self.assertTrue(after.get("ok"), after)
        self.assertEqual(after.get("recovered"), [], after)
        self.assertFalse(after.get("recovery_required", False), after)

    def test_router_recover_action_converges_through_the_same_semantics(self):
        """R013: the router's RECOVER action is an active canonical recovery
        entry point. It must name the same recovery and stop naming it once
        the same canonical recovery has run."""
        from saipen_engine import router as router_mod

        self.run_apply(crash_role="gamma")
        state = (
            '---\nphase: BUILD\ntask: T-1316\nnext_action: "PHASE BUILD T-1316"\n'
            'transition_from: SCOUT\nblocker: ""\nagent: probe\n'
            "saipen_version: 7\nmode: full\n"
            "updated: 2026-09-11T00:00:00Z\n---\n"
        )
        board = (
            "# Board\n## DOING\n"
            "- [/] T-1316 [P0] recovery | verify: probe\n"
            "## TODO\n## DONE\n## BLOCKED\n"
        )
        pending_ops, conflict_ops = journal_mod.scan_pending(self.root)
        routed = router_mod.route_next(
            state,
            board,
            pending_ops=[op["op_id"] for op in pending_ops],
            conflict_ops=[op["op_id"] for op in conflict_ops],
        )
        self.assertEqual(routed.get("action"), "saipen recover", routed)
        self.assertIn(
            routed.get("reason"),
            {"recovery-pending", "recovery-conflict"},
            routed,
        )

        self.assert_committed_terminal(self.recover())

        pending_ops, conflict_ops = journal_mod.scan_pending(self.root)
        after = router_mod.route_next(
            state,
            board,
            pending_ops=[op["op_id"] for op in pending_ops],
            conflict_ops=[op["op_id"] for op in conflict_ops],
        )
        self.assertNotIn(
            after.get("reason"),
            {"recovery-pending", "recovery-conflict"},
            f"router still demands recovery after canonical convergence: {after}",
        )

    def test_auto_recover_entry_point_produces_no_second_terminal_state(self):
        """R013 #2: auto_recover_pending() ITSELF converges a FRESH unresolved
        incident (not a pre-recovered project that only needs to sweep CLEAN)."""
        self.run_apply(crash_role="gamma")
        # The incident is live and unresolved before the sweep runs.
        self.assertFalse(
            journal_mod.recovery_preflight(self.root).get("ok"),
            "fixture must be unresolved before the sweep",
        )
        with self.instrument_target_writes():
            swept = journal_mod.auto_recover_pending(self.root)
        self.assertTrue(swept.get("ok"), swept)
        self.assertEqual(swept.get("code"), "RECOVERED", swept)
        self.assertEqual(swept.get("recovered"), [self.op_id], swept)
        self.assertEqual(self._writes, [], "sweep rewrote materialized targets")
        self.assert_committed_terminal({"ok": True, "code": "COMMITTED"})
        record = self.manifest()
        self.assertEqual(record["status"], "COMMITTED", record)
        self.assertIn(self.op_id, self.settled_receipts())
        # A second sweep over the converged project is CLEAN, never a second
        # terminal state.
        again = journal_mod.auto_recover_pending(self.root)
        self.assertEqual(again.get("code"), "CLEAN", again)

    def test_public_cli_bare_recover_converges_an_unresolved_incident(self):
        """R013 #3: the real public CLI `saipen recover` (bare) converges a
        fresh unresolved incident. This is the command the router names; the
        router test below proves the naming, this proves the execution."""
        self.run_apply(crash_role="gamma")
        self.assertFalse(
            journal_mod.recovery_preflight(self.root).get("ok"),
            "fixture must be unresolved before the public command runs",
        )
        import subprocess

        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "recover",
                "--json",
                "--project-root",
                str(self.root),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(TOOLS),
            env={**os.environ, "SAIPEN_CAPABILITY": "full", "AGENT": "t1316-cli"},
        )
        payload = json.loads(proc.stdout or "{}")
        self.assertEqual(proc.returncode, 0, (proc.returncode, proc.stdout, proc.stderr))
        self.assertTrue(payload.get("ok"), payload)
        self.assertEqual(payload.get("code"), "RECOVERED", payload)
        self.assertEqual(payload.get("recovered"), [self.op_id], payload)
        record = self.manifest()
        self.assertEqual(record["status"], "COMMITTED", record)
        self.assertTrue(
            journal_mod.recovery_preflight(self.root).get("ok"),
            "public recover must leave the project convergent",
        )

    def test_router_action_is_executable_through_the_public_command(self):
        """R013 #4: a router-produced RECOVER action, executed through the
        same public command, converges the same incident."""
        from saipen_engine import router as router_mod

        self.run_apply(crash_role="gamma")
        state = (
            '---\nphase: BUILD\ntask: T-1316\nnext_action: "PHASE BUILD T-1316"\n'
            'transition_from: SCOUT\nblocker: ""\nagent: probe\n'
            "saipen_version: 7\nmode: full\n"
            "updated: 2026-09-11T00:00:00Z\n---\n"
        )
        board = (
            "# Board\n## DOING\n"
            "- [/] T-1316 [P0] recovery | verify: probe\n"
            "## TODO\n## DONE\n## BLOCKED\n"
        )
        pending_ops, conflict_ops = journal_mod.scan_pending(self.root)
        routed = router_mod.route_next(
            state,
            board,
            pending_ops=[op["op_id"] for op in pending_ops],
            conflict_ops=[op["op_id"] for op in conflict_ops],
        )
        self.assertEqual(routed.get("action"), "saipen recover", routed)
        # The routed action names the PUBLIC command; executing that exact
        # command string's verb through the CLI converges the incident.
        import subprocess

        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "recover",
                "--json",
                "--project-root",
                str(self.root),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(TOOLS),
            env={**os.environ, "SAIPEN_CAPABILITY": "full", "AGENT": "t1316-cli"},
        )
        payload = json.loads(proc.stdout or "{}")
        self.assertEqual(proc.returncode, 0, (proc.returncode, proc.stdout, proc.stderr))
        self.assertTrue(payload.get("ok"), payload)
        self.assertEqual(payload.get("code"), "RECOVERED", payload)
        # #5: the same semantic terminal representation the direct path
        # reaches -- one settled COMMITTED receipt, no pending residue.
        record = self.manifest()
        self.assertEqual(record["status"], "COMMITTED", record)
        self.assertEqual(journal_mod.pending_ops(self.root), [])
        # The router stops demanding recovery once the SAME public command
        # converged the incident.
        pending_ops, conflict_ops = journal_mod.scan_pending(self.root)
        after = router_mod.route_next(
            state,
            board,
            pending_ops=[op["op_id"] for op in pending_ops],
            conflict_ops=[op["op_id"] for op in conflict_ops],
        )
        self.assertNotIn(
            after.get("reason"),
            {"recovery-pending", "recovery-conflict"},
            f"router still demands recovery after canonical convergence: {after}",
        )

    def test_each_entry_point_reaches_the_same_terminal_representation(self):
        """R013 #5: four fresh incidents, four different entry points --
        journal.recover(op_id), auto_recover_pending(), public CLI, and router-routed recovery --
        all converge to the SAME semantic terminal representation."""
        drivers = (
            ("direct", journal_mod.recover),
            ("auto", lambda root, _op_id: journal_mod.auto_recover_pending(root)),
            ("cli", self._public_cli_recover),
            ("router", self._router_cli_recover),
        )
        finals = []
        for index, (name, driver) in enumerate(drivers):
            if index > 0:
                self.tearDown()
                self.setUp()
            fresh = f"op-{name}"
            self.op_id = fresh
            self.run_apply(crash_role="gamma")
            result = driver(self.root, fresh)
            self.assertTrue(result.get("ok"), (name, result))
            self.assertIn(result.get("code"), {"COMMITTED", "RECOVERED"}, (name, result))
            record = self.manifest()
            finals.append(
                (
                    record["status"],
                    record["progress_index"],
                    tuple(t["applied"] for t in record["targets"]),
                    self.op_id in self.settled_receipts(),
                    not journal_mod.pending_ops(self.root),
                    journal_mod.recovery_preflight(self.root).get("ok"),
                )
            )
        self.assertEqual(len(finals), 4, finals)
        self.assertEqual(finals[0], finals[1], finals)
        self.assertEqual(finals[1], finals[2], finals)
        self.assertEqual(finals[2], finals[3], finals)

    def _public_cli_recover(self, root, op_id):
        import subprocess

        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "recover",
                "--json",
                "--project-root",
                str(root),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(TOOLS),
            env={**os.environ, "SAIPEN_CAPABILITY": "full", "AGENT": "t1316-cli"},
        )
        return json.loads(proc.stdout or "{}")

    def _router_cli_recover(self, root, op_id):
        pending_ops, conflict_ops = journal_mod.scan_pending(root)
        state_file = root / ".saipen" / "STATE.md"
        board_file = root / ".saipen" / "BOARD.md"
        if not state_file.is_file():
            state_file.write_text(
                '---\nphase: BUILD\ntask: T-1316\nnext_action: "PHASE BUILD T-1316"\n'
                'transition_from: SCOUT\nblocker: ""\nagent: t1316-cli\n'
                "saipen_version: 7\nmode: full\n"
                "updated: 2026-09-11T00:00:00Z\n---\n",
                encoding="utf-8",
            )
        if not board_file.is_file():
            board_file.write_text(
                "# Board\n## DOING\n"
                "- [/] T-1316 [P0] recovery | verify: probe\n"
                "## TODO\n## DONE\n## BLOCKED\n",
                encoding="utf-8",
            )
        routed = router_mod.route_next(
            state_file.read_text(encoding="utf-8-sig"),
            board_file.read_text(encoding="utf-8-sig"),
            pending_ops=[op["op_id"] for op in pending_ops],
            conflict_ops=[op["op_id"] for op in conflict_ops],
        )
        self.assertEqual(routed.get("action"), "saipen recover")
        return self._public_cli_recover(root, op_id)

    def test_hostile_third_state_through_each_entry_point(self):
        """R013 #6: a hostile third-state incident produces the SAME recovery
        conflict family through every entry point -- no entry point invents a
        gentler vocabulary or a second recovery implementation (#7)."""
        drivers = (
            ("direct", journal_mod.recover),
            ("auto", lambda root, _op_id: journal_mod.auto_recover_pending(root)),
            ("cli", self._public_cli_recover),
            ("router", self._router_cli_recover),
        )
        codes = set()
        for index, (name, driver) in enumerate(drivers):
            if index > 0:
                self.tearDown()
                self.setUp()
            self.op_id = f"op-{name}"
            self.run_apply(crash_role="beta")
            (self.root / "beta.txt").write_bytes(_third("beta"))
            frozen = self.live_bytes()
            result = driver(self.root, self.op_id)
            codes.add(str(result.get("code")))
            self.assertEqual(self.live_bytes(), frozen, name)
            self.assertTrue(
                any(op.get("op_id") == self.op_id for op in journal_mod.pending_ops(self.root)),
                name,
            )
        self.assertEqual(codes, {"RECOVERY_CONFLICT"}, codes)


if __name__ == "__main__":
    unittest.main()
