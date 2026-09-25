"""Hostile coverage for XPATCH -- Cross-Repo Patch Receipt (T-1256).

Every case here is a RED CONTROL: it names one way the receipt mechanism
could quietly become a permission slip instead of provenance, and proves the
mechanism refuses. The happy path is two tests; the other seventeen are the
reason the happy path is allowed to exist.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from saipen_engine import convergence, xpatch
from saipen_engine.errors import EngineError

LINEAGE = "lineage-" + "a" * 32
FOREIGN_LINEAGE = "lineage-" + "b" * 32
T0 = "2026-09-01T10:00:00Z"
T1 = "2026-09-01T11:00:00Z"
T2 = "2026-09-01T12:00:00Z"

SOURCE = {
    "project_lineage": FOREIGN_LINEAGE,
    "work_id": "T-342",
    "attempt_id": "A-4",
    "agent": "saicont",
}


def _project(root: Path, lineage: str = LINEAGE) -> Path:
    (root / ".saipen").mkdir(parents=True, exist_ok=True)
    (root / ".saipen" / "IDENTITY.md").write_text(
        f"---\nproject_lineage: {lineage}\n---\n", encoding="utf-8"
    )
    (root / "src").mkdir(exist_ok=True)
    (root / "src" / "session.py").write_bytes(b"old\n")
    return root


class XPatchCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = _project(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def record(self, contents=None, **kwargs) -> str:
        contents = contents or {"src/session.py": b"new\n"}
        result = xpatch.write_intent(
            self.root,
            source=SOURCE,
            reason="stable session discovery",
            contents=contents,
            now=kwargs.pop("now", T0),
            **kwargs,
        )
        self.assertEqual(result["outcome"], xpatch.OUTCOME_RECORDED)
        self.assertEqual(result["writes"], 0)
        return result["patch_id"]

    def intent_path(self, patch_id: str) -> Path:
        return xpatch.receipt_dir(self.root, patch_id) / xpatch.INTENT_NAME

    def poke_intent(self, target_id: str, **fields) -> None:
        path = self.intent_path(target_id)
        record = json.loads(path.read_text(encoding="utf-8"))
        record.update(fields)
        path.write_text(json.dumps(record, indent=2), encoding="utf-8")


class RecordingLeavesTargetSourceUntouched(XPatchCase):
    def test_intent_writes_zero_target_source_bytes(self) -> None:
        patch_id = self.record()
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"old\n")
        receipt = xpatch.load_receipt(self.root, patch_id)
        self.assertEqual(receipt.state, xpatch.STATE_PENDING)
        self.assertEqual(receipt.mode, "proposal")
        self.assertEqual(receipt.work_id, "T-342")
        self.assertEqual(receipt.agent, "saicont")

    def test_pending_proposal_claims_nothing_live(self) -> None:
        self.record()
        summary = xpatch.summary(self.root)
        self.assertEqual(summary["conflicting"], 0)
        self.assertEqual(summary["unreviewed"], 1)


class HappyPath(XPatchCase):
    def test_apply_then_verify(self) -> None:
        patch_id = self.record()
        applied = xpatch.apply_proposal(self.root, patch_id, now=T1)
        self.assertEqual(applied["outcome"], xpatch.OUTCOME_APPLIED)
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"new\n")

        records, problems = xpatch.claim_records(self.root)
        self.assertEqual(problems, [])
        self.assertEqual(len(records), 1)
        expected = xpatch.claim_hash(xpatch.sha256_hex(b"new\n"))
        self.assertEqual(records[0]["paths"], {"src/session.py": expected})
        self.assertEqual(records[0]["source_kind"], "xpatch_applied")

        xpatch.record_disposition(self.root, patch_id, "VERIFIED", now=T2)
        summary = xpatch.summary(self.root)
        self.assertEqual(
            (summary["unreviewed"], summary["verified"], summary["conflicting"]), (0, 1, 0)
        )
        self.assertIn("FOREIGN PATCHES: 0 unreviewed, 1 verified, 0 conflicting", summary["line"])

    def test_repair_supersedes_the_foreign_after_state(self) -> None:
        patch_id = self.record()
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        # The target decides the patch was wrong and fixes it with its own hands.
        (self.root / "src" / "session.py").write_bytes(b"repaired\n")
        xpatch.record_disposition(self.root, patch_id, "REPAIRED", now=T2, note="bad port probe")
        records, problems = xpatch.claim_records(self.root)
        self.assertEqual(problems, [])
        self.assertEqual(
            records[0]["paths"],
            {"src/session.py": xpatch.claim_hash(xpatch.sha256_hex(b"repaired\n"))},
        )
        self.assertEqual(records[0]["source_kind"], "xpatch_disposition")
        # A repaired patch is closed target Work, not unreviewed foreign news.
        summary = xpatch.summary(self.root)
        self.assertEqual(
            (summary["unreviewed"], summary["verified"], summary["conflicting"]), (0, 0, 0)
        )


class NamespaceBoundary(XPatchCase):
    def test_target_protocol_state_is_never_writable(self) -> None:
        for rel in (".saipen/STATE.md", ".saipen/BOARD.md", ".saipen/LOG.md", ".saipen/kitchen/x"):
            with self.assertRaises(EngineError) as caught:
                self.record(contents={rel: b"x\n"})
            self.assertEqual(caught.exception.code, "PATH_ESCAPE")

    def test_path_escape_and_absolute_paths_refuse(self) -> None:
        for rel in ("../outside.py", "src/../../etc/passwd", "/etc/passwd", "C:/win.ini"):
            with self.assertRaises(EngineError):
                self.record(contents={rel: b"x\n"})

    def test_backslash_paths_refuse(self) -> None:
        with self.assertRaises(EngineError):
            self.record(contents={"src\\session.py": b"x\n"})


class ForgedAndForeignReceipts(XPatchCase):
    def test_foreign_target_lineage_does_not_bind(self) -> None:
        patch_id = self.record()
        self.poke_intent(patch_id, target={"project_lineage": FOREIGN_LINEAGE, "base_head": ""})
        with self.assertRaises(EngineError):
            xpatch.load_receipt(self.root, patch_id)
        _, problems = xpatch.claim_records(self.root)
        self.assertEqual(len(problems), 1)
        self.assertIn("foreign project lineage", problems[0])

    def test_receipt_id_must_match_its_directory(self) -> None:
        patch_id = self.record()
        self.poke_intent(patch_id, patch_id="XP-999999")
        _, problems = xpatch.claim_records(self.root)
        self.assertIn("different patch id", problems[0])

    def test_unreadable_lineage_refuses_to_bind(self) -> None:
        patch_id = self.record()
        (self.root / ".saipen" / "IDENTITY.md").write_text("garbage\n", encoding="utf-8")
        with self.assertRaises(EngineError):
            xpatch.load_receipt(self.root, patch_id)

    def test_forged_after_hash_is_caught_at_apply(self) -> None:
        patch_id = self.record()
        record = json.loads(self.intent_path(patch_id).read_text(encoding="utf-8"))
        record["paths"]["src/session.py"]["after_sha256"] = "f" * 64
        self.intent_path(patch_id).write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaises(EngineError) as caught:
            xpatch.apply_proposal(self.root, patch_id, now=T1)
        self.assertIn("does not hash to the declared after-state", caught.exception.message)
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"old\n")

    def test_stranger_directory_in_the_namespace_is_a_problem_not_a_claim(self) -> None:
        (xpatch.exchange_dir(self.root) / "not-a-receipt").mkdir(parents=True)
        records, problems = xpatch.claim_records(self.root)
        self.assertEqual(records, [])
        self.assertEqual(len(problems), 1)

    def test_verification_result_vocabulary_is_closed(self) -> None:
        with self.assertRaises(EngineError):
            self.record(verification=[{"command": "pytest", "result": "PASSING"}])
        self.record(verification=[{"command": "pytest", "result": "UNKNOWN"}])


class DriftAndCas(XPatchCase):
    def test_target_moved_before_apply_yields_zero_writes(self) -> None:
        patch_id = self.record()
        (self.root / "src" / "session.py").write_bytes(b"someone else\n")
        result = xpatch.apply_proposal(self.root, patch_id, now=T1)
        self.assertEqual(result["outcome"], xpatch.OUTCOME_TARGET_DRIFT)
        self.assertEqual(result["writes"], 0)
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"someone else\n")

    def test_partial_payload_writes_nothing(self) -> None:
        patch_id = self.record(contents={"src/session.py": b"new\n", "src/other.py": b"also\n"})
        payload_path = xpatch.receipt_dir(self.root, patch_id) / xpatch.PAYLOAD_NAME
        payload = json.loads(payload_path.read_text(encoding="utf-8"))
        payload["contents"]["src/other.py"] = "!!!not base64!!!"
        payload_path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaises(EngineError):
            xpatch.apply_proposal(self.root, patch_id, now=T1)
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"old\n")
        self.assertFalse((self.root / "src" / "other.py").exists())

    def test_double_apply_refuses(self) -> None:
        patch_id = self.record()
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        with self.assertRaises(EngineError):
            xpatch.apply_proposal(self.root, patch_id, now=T2)

    def test_target_modification_after_apply_reads_as_conflicting(self) -> None:
        patch_id = self.record()
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        (self.root / "src" / "session.py").write_bytes(b"later work\n")
        summary = xpatch.summary(self.root)
        self.assertEqual(summary["conflicting"], 1)

    def test_revert_refuses_once_the_bytes_moved_on(self) -> None:
        patch_id = self.record()
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        (self.root / "src" / "session.py").write_bytes(b"later work\n")
        result = xpatch.revert(self.root, patch_id, now=T2)
        self.assertEqual(result["outcome"], xpatch.OUTCOME_TARGET_DRIFT)
        self.assertEqual(result["writes"], 0)
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"later work\n")

    def test_revert_restores_only_its_own_bytes(self) -> None:
        patch_id = self.record()
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        result = xpatch.revert(self.root, patch_id, now=T2)
        self.assertEqual(result["outcome"], "REVERTED")
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"old\n")


class CrashWindows(XPatchCase):
    def test_pending_proposal_claims_nothing(self) -> None:
        """Nobody wrote those bytes yet, so a proposal must not claim them --
        claiming an unapplied after-state reports every waiting proposal as a
        stale claim over bytes that never moved."""
        self.record()
        records, problems = xpatch.claim_records(self.root)
        self.assertEqual(problems, [])
        self.assertEqual(records, [])

    def test_direct_intent_without_applied_still_explains_the_declared_bytes(self) -> None:
        """The real crash window: a direct receipt is durable BEFORE the bytes
        move, so bytes already at the declared after-state with no applied.json
        are still accounted for by the intent alone."""
        self.record(mode="direct")
        (self.root / "src" / "session.py").write_bytes(b"new" + bytes([10]))
        records, problems = xpatch.claim_records(self.root)
        self.assertEqual(problems, [])
        self.assertEqual(
            records[0]["paths"],
            {"src/session.py": xpatch.claim_hash(xpatch.sha256_hex(b"new\n"))},
        )
        self.assertEqual(records[0]["source_kind"], "xpatch_intent")

    def test_payload_without_intent_is_ignored_not_claimed(self) -> None:
        directory = xpatch.exchange_dir(self.root) / "XP-000001"
        directory.mkdir(parents=True)
        (directory / xpatch.PAYLOAD_NAME).write_text("{}", encoding="utf-8")
        records, problems = xpatch.claim_records(self.root)
        self.assertEqual(records, [])
        self.assertIn("has no intent.json", problems[0])

    def test_applied_record_cannot_contradict_its_intent(self) -> None:
        patch_id = self.record()
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        applied_path = xpatch.receipt_dir(self.root, patch_id) / xpatch.APPLIED_NAME
        record = json.loads(applied_path.read_text(encoding="utf-8"))
        record["paths"]["src/session.py"]["after_sha256"] = "c" * 64
        applied_path.write_text(json.dumps(record), encoding="utf-8")
        _, problems = xpatch.claim_records(self.root)
        self.assertIn("contradicts the intent", problems[0])

    def test_partial_disposition_refuses(self) -> None:
        patch_id = self.record(
            contents={"src/session.py": b"new" + bytes([10]), "src/other.py": b"also" + bytes([10])}
        )
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        xpatch.record_disposition(self.root, patch_id, "VERIFIED", now=T2)
        path = xpatch.receipt_dir(self.root, patch_id) / xpatch.DISPOSITION_NAME
        record = json.loads(path.read_text(encoding="utf-8"))
        record["paths"].pop("src/other.py")
        path.write_text(json.dumps(record), encoding="utf-8")
        _, problems = xpatch.claim_records(self.root)
        self.assertIn("not the whole receipt scope", problems[0])

    def test_disposition_without_apply_refuses(self) -> None:
        patch_id = self.record()
        with self.assertRaises(EngineError):
            xpatch.record_disposition(self.root, patch_id, "VERIFIED", now=T1)


class DirectModeStaysGated(XPatchCase):
    def test_direct_apply_refuses_and_names_the_gate(self) -> None:
        patch_id = self.record(mode="direct")
        result = xpatch.apply_direct(self.root, patch_id)
        self.assertEqual(result["outcome"], xpatch.OUTCOME_DIRECT_MODE_UNAVAILABLE)
        self.assertEqual(result["writes"], 0)
        self.assertIn("T-473", result["detail"])
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"old\n")

    def test_target_may_finish_a_stranded_direct_receipt(self) -> None:
        """Mode says who was SUPPOSED to write, not who MAY. A direct receipt
        whose source died before touching a byte must not strand the target
        with a patch nobody is allowed to finish."""
        patch_id = self.record(mode="direct")
        self.assertEqual(
            xpatch.apply_proposal(self.root, patch_id, now=T1)["outcome"],
            xpatch.OUTCOME_APPLIED,
        )
        self.assertEqual((self.root / "src" / "session.py").read_bytes(), b"new" + bytes([10]))


class IdAllocation(XPatchCase):
    def test_ids_are_unique_and_sequential(self) -> None:
        first = xpatch.allocate_patch_id(self.root)
        second = xpatch.allocate_patch_id(self.root)
        self.assertEqual((first, second), ("XP-000001", "XP-000002"))

    def test_taken_id_is_never_reused(self) -> None:
        taken = xpatch.allocate_patch_id(self.root)
        self.assertNotEqual(xpatch.allocate_patch_id(self.root), taken)


class CreationAndDeletion(XPatchCase):
    def test_creation_and_deletion_round_trip(self) -> None:
        created = self.record(contents={"src/new_file.py": b"hello\n"})
        xpatch.apply_proposal(self.root, created, now=T1)
        self.assertEqual((self.root / "src" / "new_file.py").read_bytes(), b"hello\n")

        removed = self.record(contents={"src/new_file.py": None}, now=T1)
        xpatch.apply_proposal(self.root, removed, now=T2)
        self.assertFalse((self.root / "src" / "new_file.py").exists())

    def test_creation_into_a_new_directory_works(self) -> None:
        patch_id = self.record(contents={"a/b/c/new.py": b"hi" + bytes([10])})
        self.assertEqual(xpatch.apply_proposal(self.root, patch_id, now=T1)["writes"], 1)
        self.assertEqual((self.root / "a" / "b" / "c" / "new.py").read_bytes(), b"hi" + bytes([10]))

    def test_deleting_a_missing_file_refuses(self) -> None:
        with self.assertRaises(EngineError):
            self.record(contents={"src/absent.py": None})

    def test_no_op_mutation_refuses(self) -> None:
        with self.assertRaises(EngineError):
            self.record(contents={"src/session.py": b"old\n"})


class UnrelatedDirtStaysUnattributed(XPatchCase):
    def test_a_receipt_never_claims_a_path_it_did_not_declare(self) -> None:
        patch_id = self.record()
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        (self.root / "src" / "unrelated.py").write_bytes(b"user data\n")
        records, _ = xpatch.claim_records(self.root)
        self.assertEqual(list(records[0]["paths"]), ["src/session.py"])


class ConvergenceAttribution(unittest.TestCase):
    """The wiring claim, not the module claim: a delta an XPATCH receipt
    explains must stop being an `unattributed main-source delta`, and a
    receipt that does not bind must become a VISIBLE problem rather than
    silence. Without this the module could be perfect and the protocol
    would still stop on a fully explained change."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = _project(Path(self._tmp.name))
        run = lambda *args: subprocess.run(  # noqa: E731
            ["git", "-C", str(self.root), *args], capture_output=True, check=True
        )
        run("init", "-q")
        run("config", "user.email", "t@example.invalid")
        run("config", "user.name", "test")
        run("add", "-A")
        run("commit", "-qm", "base")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _problems(self):
        return convergence.attribution_problems(self.root)

    def test_unexplained_delta_is_unattributed(self) -> None:
        (self.root / "src" / "session.py").write_bytes(b"mystery\n")
        problems = self._problems()
        self.assertTrue(any("unattributed main-source delta" in p for p in problems), problems)

    def test_receipt_explained_delta_is_attributed(self) -> None:
        patch_id = xpatch.write_intent(
            self.root,
            source=SOURCE,
            reason="stable session discovery",
            contents={"src/session.py": b"new\n"},
            now=T0,
        )["patch_id"]
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        self.assertEqual(self._problems(), [])

    def test_forged_receipt_leaves_the_delta_unattributed_and_visible(self) -> None:
        patch_id = xpatch.write_intent(
            self.root,
            source=SOURCE,
            reason="stable session discovery",
            contents={"src/session.py": b"new\n"},
            now=T0,
        )["patch_id"]
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        intent = xpatch.receipt_dir(self.root, patch_id) / xpatch.INTENT_NAME
        record = json.loads(intent.read_text(encoding="utf-8"))
        record["target"]["project_lineage"] = FOREIGN_LINEAGE
        intent.write_text(json.dumps(record), encoding="utf-8")
        problems = self._problems()
        self.assertTrue(any("foreign project lineage" in p for p in problems), problems)
        self.assertTrue(any("unattributed main-source delta" in p for p in problems), problems)

    def test_target_repair_after_the_patch_stays_attributed(self) -> None:
        patch_id = xpatch.write_intent(
            self.root,
            source=SOURCE,
            reason="stable session discovery",
            contents={"src/session.py": b"new\n"},
            now=T0,
        )["patch_id"]
        xpatch.apply_proposal(self.root, patch_id, now=T1)
        (self.root / "src" / "session.py").write_bytes(b"repaired\n")
        self.assertTrue(any("changed after its reviewed" in p for p in self._problems()))
        xpatch.record_disposition(self.root, patch_id, "REPAIRED", now=T2)
        self.assertEqual(self._problems(), [])


if __name__ == "__main__":
    unittest.main()
