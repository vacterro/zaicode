"""T-1326: lossless repair of historical oversized BOARD records."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import intake  # noqa: E402
from saipen_engine.board import MAX_LIVE_RECORD_CHARS, parse_board  # noqa: E402
from saipen_engine.board_compaction import (  # noqa: E402
    _entries_digest,
    oversized_ticket_ids,
    prepare_existing,
    resolve_detail,
)
from saipen_engine.fleet import CLASS_BLOCKED, CLASS_SAFE, preflight  # noqa: E402
from saipen_engine.journal import auto_recover_pending, scan_pending  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    compact_board,
    finish_ticket,
    ticket_add,
    ticket_move,
    ticket_verify,
    transition_phase,
)
from saipen_engine.codec import redact_credentials  # noqa: E402
from saipen_engine.log import build_event  # noqa: E402
from saipen_engine.paths import project_lineage_identity  # noqa: E402
from saipen_engine.reconcile import reconcile_protocol_state  # noqa: E402
from test_guard_hostile_matrix import fresh_project  # noqa: E402
from test_orchestration_repair import OrchestrationFixture  # noqa: E402
from test_recovery_reachability import (  # noqa: E402
    _legacy_project as _recovery_legacy_project,
    _project as _recovery_project,
)

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


def _legacy_project() -> tuple[Path, bytes]:
    root = fresh_project(
        phase="BUILD", task="T-1315", next_action="PHASE BUILD T-1315", agent="test-agent"
    )
    line = (
        "- [/] T-1315 [P1] "
        + ("legacy evidence " * 140)
        + " | verify: "
        + ("proof " * 180)
        + " | owner: test-agent | claim_time: 2026-09-14T08:00:00Z\n"
    )
    board = "## DOING\n" + line + "## TODO\n## DONE\n## BLOCKED\n"
    (root / ".saipen" / "BOARD.md").write_text(board, encoding="utf-8")
    return root, line.encode("utf-8")


def _live_ops():
    """Resolve the LIVE operations module at call time.

    ISOLATION NOTE: some suites in a full discovery run purge ``sys.modules``
    of every ``saipen_engine`` entry (test_metrics_acceptance). A module object
    captured at import time becomes a stale copy after that purge, so patching
    ``saipen_engine.operations.validate_texts`` by name would decorate a module
    the engine under test no longer uses -- and the injected failure silently
    did nothing. Resolve the binding and the entry point together, here.
    """
    importlib.import_module("saipen_engine.operations")
    return sys.modules["saipen_engine.operations"]


def _ticket(root: Path) -> dict:
    return parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))["tickets"][
        "T-1315"
    ]


class LegacyBoardCompactionTests(unittest.TestCase):
    def test_readable_owner_verify_blocker_and_lossless_projection(self):
        root, original = _legacy_project()
        self.assertGreater(len(original.decode().rstrip()), MAX_LIVE_RECORD_CHARS)
        self.assertEqual(_ticket(root)["id"], "T-1315")

        owner = apply_claim(root, "T-1315", "other-agent", explicit=True)
        self.assertTrue(owner.ok, owner.to_dict())
        self.assertEqual(_ticket(root)["fields"].get("owner"), "other-agent")
        self.assertTrue(ticket_verify(root, "T-1315", "other-agent", "focused verify PASS").ok)
        blocked = ticket_move(root, "block", "T-1315", "other-agent", "fixture blocker")
        self.assertTrue(blocked.ok, blocked.to_dict())

        ticket = _ticket(root)
        self.assertEqual(ticket["id"], "T-1315")
        self.assertEqual(ticket["section"], "## BLOCKED")
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertEqual(detail["original_record"], original)
        self.assertEqual(detail["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(detail["metadata"]["ticket_id"], "T-1315")
        self.assertTrue(detail["metadata"]["lossless"])

    def test_explicit_compaction_is_idempotent(self):
        root, _ = _legacy_project()
        first = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(first.ok, first.to_dict())
        second = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(second.ok, second.to_dict())
        self.assertEqual(second.code, "ALREADY_APPLIED")
        self.assertTrue(second.get("idempotent"))

    def test_new_oversized_record_externalizes_before_board_write(self):
        root = fresh_project()
        result = ticket_add(
            root, "test-agent", "P1", "new " + ("large detail " * 400), [], "verify by test"
        )
        self.assertTrue(result.ok, result.to_dict())
        parsed = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        ticket = parsed["tickets"][result.data["ticket"]]
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        self.assertTrue(ticket["fields"].get("detail_ref"))
        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertEqual(detail["metadata"]["ticket_id"], result.data["ticket"])

    def test_malformed_oversized_input_refuses_without_repair(self):
        root, _ = _legacy_project()
        board_path = root / ".saipen" / "BOARD.md"
        original = board_path.read_text(encoding="utf-8")
        # Duplicate owner is a malformed canonical record, even though it is
        # also oversized. The repair must not choose a lossy interpretation.
        malformed = original.replace(" | owner: test-agent |", " | owner: one | owner: two |", 1)
        board_path.write_text(malformed, encoding="utf-8")
        result = compact_board(root, "T-1315", "test-agent")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertEqual(board_path.read_text(encoding="utf-8"), malformed)


class CompactionAtomicityTests(unittest.TestCase):
    def test_journal_faults_leave_pending_recoverable_operation(self):
        for env_name in (
            "NITRO_CRASH_AFTER_PREPARE",
            "NITRO_CRASH_AFTER_GENERIC",
            "NITRO_CRASH_AFTER_LOG",
            "NITRO_CRASH_AFTER_BOARD",
            "NITRO_CRASH_AFTER_STATE",
            "NITRO_CRASH_AFTER_VERIFIED",
        ):
            with self.subTest(env_name=env_name):
                root, _ = _legacy_project()
                with patch.dict(os.environ, {env_name: "1"}, clear=False), self.assertRaises(
                    SystemExit
                ) as raised:
                    compact_board(root, "T-1315", "test-agent")
                self.assertEqual(raised.exception.code, 87)
                pending, _ = scan_pending(root)
                self.assertTrue(pending, env_name)
                recovered = auto_recover_pending(root)
                self.assertTrue(recovered["ok"], (env_name, recovered))
                # A crash before the first target has materialized is safely
                # aborted by the journal; the canonical retry must then
                # converge to the same compaction.
                if len(_ticket(root)["raw"]) > MAX_LIVE_RECORD_CHARS:
                    retried = compact_board(root, "T-1315", "test-agent")
                    self.assertTrue(retried.ok, (env_name, retried.to_dict()))
                self.assertLessEqual(len(_ticket(root)["raw"]), MAX_LIVE_RECORD_CHARS)
                detail = resolve_detail(root, _ticket(root)["fields"]["detail_ref"])
                self.assertTrue(detail["metadata"]["lossless"])

    def test_final_validation_failure_writes_nothing(self):
        root, _ = _legacy_project()
        before = (root / ".saipen" / "BOARD.md").read_bytes()
        ops = _live_ops()
        # T-1354: the failure has to be one the PROPOSAL introduces. Compaction
        # now judges the repair rather than the repository's history -- an
        # error that was already there, unchanged, is pre-existing residue and
        # no longer this repair's veto -- so a stub that fails every call would
        # be indistinguishable from a legacy board and would prove nothing
        # about atomicity. First call is the BEFORE picture, second is the
        # proposal.
        calls = {"n": 0}

        def failing_proposal(*_args, **_kwargs):
            calls["n"] += 1
            return [] if calls["n"] == 1 else ["injected final validation failure"]

        with patch.object(ops, "validate_texts", side_effect=failing_proposal):
            result = ops.compact_board(root, "T-1315", "test-agent")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), before)
        self.assertFalse((root / ".saipen" / "recovery" / "board-compaction").exists())


class ReachabilityTests(unittest.TestCase):
    def test_legacy_oversize_exposes_real_canonical_repair(self):
        root, _ = _legacy_project()
        result = preflight(
            root,
            explicit_root=root,
            host_root=root,
            host_lineage=project_lineage_identity(root),
        )
        self.assertEqual(result["classification"], CLASS_SAFE, result)
        self.assertEqual(result["reason_code"], "BOARD_RECORD_OVERSIZE")
        self.assertTrue(result["needs_local_mutation"])
        self.assertTrue(result["safe_auto_repair_available"])
        self.assertEqual(result["canonical_next_command"], "saipen ticket compact T-1315")
        self.assertFalse(result["operator_decision_available"])

    def test_log_cap_has_lossless_canonical_externalization(self):
        root = fresh_project(
            phase="BUILD", task="T-9001", next_action="PHASE BUILD T-9001", agent="test-agent"
        )
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n"
            "- [/] T-9001 live work | verify: focused proof | owner: test-agent | "
            "claim_time: 2026-09-14T08:00:00Z\n"
            "## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        result = transition_phase(root, "VERIFY", "test-agent", "T-9001", "x" * 2000)
        self.assertTrue(result.ok, result.to_dict())
        line = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8").splitlines()[-1]
        self.assertLessEqual(len(line.encode("utf-8")), 1024)
        self.assertIn("detail_ref:", line)
        refs = list((root / ".saipen" / "recovery" / "log-detail").glob("*.json"))
        self.assertEqual(len(refs), 1)
        metadata = refs[0].read_text(encoding="utf-8")
        self.assertIn('"lossless": true', metadata)
        detail = refs[0].with_suffix(".LOG.md")
        original = detail.read_bytes()
        declared = metadata.split('"original_event_sha256": "')[1].split('"', 1)[0]
        self.assertEqual(hashlib.sha256(original).hexdigest(), declared)


# --------------------------------------------------------------------------
# T-1326 re-verification regressions (TARGET A-D).
# --------------------------------------------------------------------------

def _legacy_line(*, verify: str, extra: str = "") -> str:
    return (
        "- [/] T-1315 [P1] "
        + ("legacy evidence " * 140)
        + " | verify: "
        + verify
        + extra
        + " | owner: test-agent | claim_time: 2026-09-14T08:00:00Z\n"
    )


_CHILD_DONE = (
    "- [x] T-1300 [P2] dependency child | verify: child proof"
    " | closure_mode: own_patch | implementation_delta: patch" + "\n"
)


def _legacy_project_line(
    line: str,
    *,
    section: str = "## DOING",
    done: str = "",
    **state,
) -> tuple[Path, bytes]:
    fields = {
        "phase": "BUILD",
        "task": "T-1315",
        "next_action": "PHASE BUILD T-1315",
        "agent": "test-agent",
    }
    fields.update(state)
    root = fresh_project(**fields)
    body = {"## DOING": "", "## TODO": "", "## DONE": done, "## BLOCKED": ""}
    body[section] = line + body[section]
    board = "".join(
        f"{name}\n{body[name]}" for name in ("## DOING", "## TODO", "## DONE", "## BLOCKED")
    )
    (root / ".saipen" / "BOARD.md").write_text(board, encoding="utf-8")
    return root, line.encode("utf-8")


def _compacted_project() -> tuple[Path, dict]:
    root, _ = _legacy_project()
    result = compact_board(root, "T-1315", "test-agent")
    assert result.ok, result.to_dict()
    return root, _ticket(root)


def _metadata_path(root: Path) -> Path:
    return root / _ticket(root)["fields"]["detail_ref"]


class TargetALegacyEscapedVerifyTests(unittest.TestCase):
    """TARGET A: a canonically escaped literal pipe must survive compaction."""

    def test_escaped_pipe_verify_compacts_losslessly(self):
        semantic_fragment = "proof | branch"
        line = _legacy_line(verify=("proof \\| branch " * 100))
        root, original = _legacy_project_line(line)

        # 1/2: the historical row parses cleanly and carries a semantic pipe.
        parsed = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        self.assertEqual(parsed["errors"], [])
        self.assertIn(semantic_fragment, parsed["tickets"]["T-1315"]["fields"]["verify"])
        self.assertGreater(len(parsed["tickets"]["T-1315"]["raw"]), MAX_LIVE_RECORD_CHARS)

        # 3/4: canonical compaction succeeds.
        result = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "BOARD_COMPACTED")

        # 5/6: the compact row parses and keeps the intended literal pipe.
        after = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        self.assertEqual(after["errors"], [])
        ticket = after["tickets"]["T-1315"]
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        self.assertIn(semantic_fragment, ticket["fields"]["verify"])

        # 7: the original bytes stay hash-identical in the detail artifact.
        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertEqual(detail["original_record"], original)
        self.assertEqual(detail["sha256"], hashlib.sha256(original).hexdigest())


class TargetBLifecycleFieldTests(unittest.TestCase):
    """TARGET B: compaction is a projection, not a lifecycle amnesty."""

    def _compact_with(self, extra: str, **kwargs) -> dict:
        checkbox = "/" if kwargs.get("section", "## DOING") == "## DOING" else " "
        line = _legacy_line(verify=("proof " * 180), extra=extra).replace(
            "- [/]", f"- [{checkbox}]", 1
        )
        root, _ = _legacy_project_line(line, **kwargs)
        result = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(result.ok, result.to_dict())
        parsed = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        self.assertEqual(parsed["errors"], [])
        return parsed["tickets"]["T-1315"]["fields"]

    def test_verify_attempts_survives_compaction(self):
        self.assertEqual(self._compact_with(" | verify_attempts: 2").get("verify_attempts"), "2")

    def test_review_passes_survives_compaction(self):
        self.assertEqual(self._compact_with(" | review_passes: 2").get("review_passes"), "2")

    def test_execution_and_provenance_fields_survive_compaction(self):
        fields = self._compact_with(
            " | source_receipts: SRC-042"
            " | source_reports: SRC-042:R001"
            " | recurrence: none"
            " | weak_model: false"
            " | regression: required"
            " | user_explicit: true"
            " | verify_attempts: 2"
            " | review_passes: 2"
        )
        for name, value in (
            ("owner", "test-agent"),
            ("claim_time", "2026-09-14T08:00:00Z"),
            ("source_receipts", "SRC-042"),
            ("source_reports", "SRC-042:R001"),
            ("recurrence", "none"),
            ("weak_model", "false"),
            ("regression", "required"),
            ("user_explicit", "true"),
            ("verify_attempts", "2"),
            ("review_passes", "2"),
        ):
            self.assertEqual(fields.get(name), value, name)

    def test_blocker_and_active_parent_resume_fields_survive_compaction(self):
        fields = self._compact_with(
            " | needs: T-1300"
            " | blocker: fixture blocker"
            " | blocker_scope: ticket"
            " | blocked_on: T-1300"
            " | resume_phase: BUILD"
            " | resume_transition_from: SCOUT"
            " | verify_attempts: 2"
            " | review_passes: 2",
            section="## BLOCKED",
            done=_CHILD_DONE,
            phase="DONE",
            task="none",
            next_action="saipen continue",
        )
        for name, value in (
            ("owner", "test-agent"),
            ("claim_time", "2026-09-14T08:00:00Z"),
            ("blocker", "fixture blocker"),
            ("blocker_scope", "ticket"),
            ("blocked_on", "T-1300"),
            ("resume_phase", "BUILD"),
            ("resume_transition_from", "SCOUT"),
            ("verify_attempts", "2"),
            ("review_passes", "2"),
        ):
            self.assertEqual(fields.get(name), value, name)

    def test_every_known_field_has_an_explicit_compaction_disposition(self):
        """A future KNOWN_FIELDS addition must not silently fall through."""
        from saipen_engine.board import KNOWN_FIELDS
        from saipen_engine.board_compaction import (
            COMPACTION_DISPOSITION,
            COMPACTION_MODES,
            _compact_value,
            validate_compaction_disposition,
        )

        # The authored policy covers exactly the parser's closed field set.
        self.assertEqual(set(COMPACTION_DISPOSITION), set(KNOWN_FIELDS))
        self.assertLessEqual(set(COMPACTION_DISPOSITION.values()), set(COMPACTION_MODES))

        # The decisive fields carry a decision that is NOT the inline default.
        self.assertEqual(COMPACTION_DISPOSITION["verify"], "compact")
        self.assertEqual(COMPACTION_DISPOSITION["detail_ref"], "replaced")
        self.assertEqual(COMPACTION_DISPOSITION["blocker"], "head")
        for name in ("needs", "source_reports", "source_receipts", "closure_paths"):
            self.assertEqual(COMPACTION_DISPOSITION[name], "tokenized", name)

        # The validator is a real gate, not a docstring promise.
        validate_compaction_disposition()
        with self.assertRaises(ValueError):
            validate_compaction_disposition({**COMPACTION_DISPOSITION, "brand_new": "inline"})
        with self.assertRaises(ValueError):
            without = {k: v for k, v in COMPACTION_DISPOSITION.items() if k != "needs"}
            validate_compaction_disposition(without)
        with self.assertRaises(ValueError):
            validate_compaction_disposition({**COMPACTION_DISPOSITION, "needs": "nonsense"})

        # And an unpreviewed field refuses at projection time rather than
        # defaulting to a lossy `inline`.
        with self.assertRaises(ValueError):
            _compact_value("brand_new", "x", ".saipen/recovery/board-compaction/T-1/x.json")


class TargetCDetailIntegrityTests(unittest.TestCase):
    """TARGET C: a compact row's detail edge is authority, not decoration."""

    def _mutation(self, root: Path):
        return ticket_verify(root, "T-1315", "test-agent", "post-compaction verify")

    def test_healthy_compacted_row_still_accepts_canonical_mutation(self):
        root, _ = _compacted_project()
        result = self._mutation(root)
        self.assertTrue(result.ok, result.to_dict())

    def _assert_fails_closed(self, root: Path, needle: str):
        before = (root / ".saipen" / "BOARD.md").read_bytes()
        result = self._mutation(root)
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "VALIDATION_FAILED")
        blob = (result.message + " " + str(result.to_dict())).lower()
        self.assertIn("detail", blob)
        self.assertIn(needle, blob)
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), before)

    def test_missing_metadata_fails_closed(self):
        root, _ = _compacted_project()
        _metadata_path(root).unlink()
        self._assert_fails_closed(root, "missing")

    def test_missing_original_record_fails_closed(self):
        root, _ = _compacted_project()
        meta = json.loads(_metadata_path(root).read_text(encoding="utf-8"))
        (root / meta["original_record_path"]).unlink()
        self._assert_fails_closed(root, "original record")

    def test_original_hash_mismatch_fails_closed(self):
        root, _ = _compacted_project()
        meta = json.loads(_metadata_path(root).read_text(encoding="utf-8"))
        record = root / meta["original_record_path"]
        record.write_bytes(record.read_bytes().replace(b"legacy evidence", b"tampered  bytes", 1))
        self._assert_fails_closed(root, "hash mismatch")

    def test_original_byte_count_mismatch_fails_closed(self):
        root, _ = _compacted_project()
        meta_path = _metadata_path(root)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        record = root / meta["original_record_path"]
        original = record.read_bytes()
        record.write_bytes(original + b"\n")
        meta["original_record_sha256"] = hashlib.sha256(original + b"\n").hexdigest()
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._assert_fails_closed(root, "byte count mismatch")

    def test_wrong_project_identity_fails_closed(self):
        root, _ = _compacted_project()
        meta_path = _metadata_path(root)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["project_identity"] = "not-this-project"
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._assert_fails_closed(root, "project identity mismatch")

    def test_wrong_lineage_fails_closed(self):
        root, _ = _compacted_project()
        meta_path = _metadata_path(root)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["project_lineage"] = "0" * 64
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._assert_fails_closed(root, "lineage mismatch")

    def test_metadata_for_another_ticket_fails_closed(self):
        root, _ = _compacted_project()
        meta_path = _metadata_path(root)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["ticket_id"] = "T-1300"
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._assert_fails_closed(root, "another ticket")

    def test_malformed_metadata_fails_closed(self):
        root, _ = _compacted_project()
        _metadata_path(root).write_text("{ not json", encoding="utf-8")
        self._assert_fails_closed(root, "malformed")

    def test_unsupported_schema_fails_closed(self):
        root, _ = _compacted_project()
        meta_path = _metadata_path(root)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["schema_version"] = 99
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._assert_fails_closed(root, "schema")

    def test_unsupported_operation_fails_closed(self):
        root, _ = _compacted_project()
        meta_path = _metadata_path(root)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["operation"] = "log_event_externalization"
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._assert_fails_closed(root, "operation")

    def test_unsupported_status_fails_closed(self):
        root, _ = _compacted_project()
        meta_path = _metadata_path(root)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["status"] = "PENDING"
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._assert_fails_closed(root, "status")

    def test_lossless_false_fails_closed(self):
        root, _ = _compacted_project()
        meta_path = _metadata_path(root)
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["lossless"] = False
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        self._assert_fails_closed(root, "lossless")

    def test_broken_detail_edge_is_surfaced_by_read_only_diagnosis(self):
        """The operator must not have to guess `ticket compact` to see this."""
        root, _ = _compacted_project()
        _metadata_path(root).unlink()
        result = preflight(
            root,
            explicit_root=root,
            host_root=root,
            host_lineage=project_lineage_identity(root),
        )
        self.assertEqual(result["reason_code"], "BOARD_DETAIL_UNRESOLVABLE", result)
        self.assertEqual(result["classification"], CLASS_BLOCKED, result)
        self.assertTrue(result["read_only"])
        self.assertIn("T-1315", result["reason"])

    def test_no_bytes_are_fabricated_from_the_compact_projection(self):
        root, _ = _compacted_project()
        meta = json.loads(_metadata_path(root).read_text(encoding="utf-8"))
        record = root / meta["original_record_path"]
        record.unlink()
        self._mutation(root)
        self.assertFalse(record.exists())


class TargetDNewOversizedRoundTripTests(unittest.TestCase):
    """TARGET D: each semantic scalar is serialized exactly once."""

    def test_new_oversized_ticket_semantic_round_trip_is_exact(self):
        root = fresh_project()
        description = "pipe | and backslash \\ payload " + ("detail chunk " * 200).strip()
        verify = "verify pipe | and backslash \\ proof"
        result = ticket_add(root, "test-agent", "P1", description, [], verify)
        self.assertTrue(result.ok, result.to_dict())
        ticket_id = result.data["ticket"]

        parsed = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        self.assertEqual(parsed["errors"], [])
        ticket = parsed["tickets"][ticket_id]
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)

        semantic_description = redact_credentials(description)
        semantic_verify = redact_credentials(verify)
        # The compact projection truncates; the retained prefix must be the
        # semantic value byte-for-byte, never a re-escaped copy of it.
        retained = ticket["description"].split("] ", 1)[1]
        self.assertTrue(retained.endswith("..."), retained[-40:])
        self.assertTrue(
            semantic_description.startswith(retained[:-3]),
            (retained[:120], semantic_description[:120]),
        )
        self.assertNotIn("\\\\", ticket["description"])
        self.assertNotIn("\\|", ticket["description"])
        self.assertIn("pipe | and backslash \\ payload", ticket["description"])

        compact_verify = ticket["fields"]["verify"].split(" [detail_ref: ", 1)[0]
        self.assertEqual(compact_verify, semantic_verify)

        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertEqual(detail["metadata"]["ticket_id"], ticket_id)
        self.assertTrue(detail["metadata"]["lossless"])
        original = detail["original_record"].decode("utf-8")
        reparsed = parse_board("## DOING\n## TODO\n" + original + "## DONE\n## BLOCKED\n")
        self.assertEqual(reparsed["errors"], [])
        full = reparsed["tickets"][ticket_id]
        self.assertEqual(full["description"].split("] ", 1)[1], semantic_description)
        self.assertEqual(full["fields"]["verify"], semantic_verify)


class TargetAOversizedLifecycleFieldsTests(unittest.TestCase):
    """TARGET A: every oversized lifecycle field is projected, never refused.

    The escaped-VERIFY finding: a historical row can be oversized because of a
    field other than `verify`, and the repair must still bound it while keeping
    the machine identifiers its consumers read.
    """

    def test_oversized_source_reports_and_closure_paths_keep_their_tokens(self):
        generated = ", ".join(f"src/gen/file_{i:03d}.py" for i in range(200))
        line = _legacy_line(
            verify=("proof " * 40),
            extra=(
                " | source_receipts: SRC-042"
                " | source_reports: " + ("SRC-042:R001 " * 300)
                + " | closure_mode: cohort | closure_cohort: C-7"
                " | closure_paths: src/module/deep/entry.py, " + generated
            ),
        ).replace("- [/]", "- [x]", 1)
        root, original = _legacy_project_line(
            line,
            section="## DONE",
            phase="DONE",
            task="none",
            next_action="saipen continue",
        )

        result = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "BOARD_COMPACTED")

        ticket = _ticket(root)
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        # Tokenized fields keep every machine identifier, deduplicated.
        self.assertEqual(ticket["fields"]["source_reports"], "SRC-042:R001")
        self.assertEqual(ticket["fields"]["source_receipts"], "SRC-042")
        # The bounded closure_paths prefix survives byte-for-byte.
        self.assertTrue(ticket["fields"]["closure_paths"].startswith("src/module/deep/entry.py"))

        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertEqual(detail["original_record"], original)
        self.assertTrue(detail["metadata"]["lossless"])
        self.assertIn("src/gen/file_199.py", detail["original_record"].decode("utf-8"))

    def test_oversized_blocker_keeps_its_class_prefix(self):
        blockage = "HELD -- " + ("deep transitive dependency " * 200)
        line = _legacy_line(verify=("proof " * 40), extra=" | blocker: " + blockage).replace(
            "- [/]", "- [ ]", 1
        )
        root, original = _legacy_project_line(
            line,
            section="## BLOCKED",
            phase="DONE",
            task="none",
            next_action="saipen continue",
        )

        result = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(result.ok, result.to_dict())

        ticket = _ticket(root)
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        # `blocker_class` reads everything before the first ` -- `.
        self.assertTrue(
            ticket["fields"]["blocker"].startswith("HELD --"), ticket["fields"]["blocker"]
        )

        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertEqual(detail["original_record"], original)
        self.assertIn(blockage, detail["original_record"].decode("utf-8"))

    def test_oversized_implementation_delta_is_projected_within_the_cap(self):
        # `implementation_delta` closure semantics admit only `none|patch`, so it
        # cannot be laundered through `compact_board`; the projection owner is
        # `prepare_existing`, and the PROPOSED bytes are what must stay bounded.
        from saipen_engine.board_compaction import prepare_existing

        line = _legacy_line(
            verify=("proof " * 40),
            extra=(
                " | closure_mode: own_patch | implementation_delta: "
                + ("patch detail " * 400)
            ),
        )
        root, _ = _legacy_project_line(
            line,
            section="## DONE",
            phase="DONE",
            task="none",
            next_action="saipen continue",
        )
        board_text = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")

        result = prepare_existing(
            root,
            board_text,
            ["T-1315"],
            op_id="compact-test",
            event_id=None,
            reason="oversized implementation_delta red test",
        )
        self.assertIn("T-1315", result.compacted_tickets)
        row = next(ln for ln in result.board_text.splitlines() if "T-1315" in ln)
        self.assertLessEqual(len(row), MAX_LIVE_RECORD_CHARS)
        self.assertIn("closure_mode: own_patch", row)
        # The complete clause is preserved in the journaled authority target.
        record = next(t for t in result.targets if t.path.endswith(".BOARD.md"))
        self.assertIn("patch detail", record.content.decode("utf-8"))


class TargetBNoDeadEndTests(unittest.TestCase):
    """TARGET B: a row that crosses the cap BECAUSE of a mutation is repaired.

    The dead end being closed: the pre-change writer asserted the live cap on
    the PROPOSED row, so a normal mutation on an already-oversized row (or a
    mutation that makes it cross) refused instead of externalizing.
    """

    def test_normal_verify_mutation_externalizes_an_oversized_row(self):
        line = _legacy_line(verify=("proof " * 200))
        root, _ = _legacy_project_line(line)

        result = ticket_verify(root, "T-1315", "test-agent", "short new verify")
        self.assertTrue(result.ok, result.to_dict())

        ticket = _ticket(root)
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        self.assertEqual(
            ticket["fields"]["verify"].split(" [detail_ref: ", 1)[0].strip(), "short new verify"
        )
        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertTrue(detail["metadata"]["lossless"])

    def test_claiming_a_row_that_crosses_the_cap_externalizes_instead_of_refusing(self):
        """The frozen-seat dead end: the CLAIM payload is what crosses the cap.

        A TODO row can be legal before the claim and oversized only AFTER the
        claim appends `owner`/`claim_time`, so asserting the cap on the proposed
        row made the ticket unclaimable AND unreachable by `ticket compact`
        (under the cap before the claim, `compact_board` reports it already
        within). The claim path must route through the same externalizing
        projector every other lifecycle writer uses.
        """
        pad = "z" * 1120
        line = f"- [ ] T-1315 [P1] {pad} | verify: proof\n"
        root, _ = _legacy_project_line(
            line, section="## TODO", phase="DONE", task="none", next_action="saipen continue"
        )
        before = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        self.assertLessEqual(len(before["tickets"]["T-1315"]["raw"]), MAX_LIVE_RECORD_CHARS)

        # RED CONTROL: the canonical repair cannot reach this row -- it is not
        # oversized YET, so `ticket compact` refuses it. Without the fix the
        # claim refuses too, and the seat is frozen with no way forward.
        unreachable = compact_board(root, "T-1315", "test-agent")
        self.assertFalse(unreachable.ok)
        self.assertIn("already within", unreachable.message)

        result = apply_claim(root, "T-1315", "test-agent")
        self.assertTrue(result.ok, result.to_dict())

        ticket = _ticket(root)
        self.assertEqual(ticket["section"], "## DOING")
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        self.assertEqual(ticket["fields"]["owner"], "test-agent")
        self.assertTrue(ticket["fields"].get("detail_ref"))
        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertTrue(detail["metadata"]["lossless"])
        self.assertIn(pad, detail["original_record"].decode("utf-8"))

    def test_blocking_an_oversized_todo_row_externalizes_instead_of_refusing(self):
        line = _legacy_line(verify=("proof " * 200)).replace("- [/]", "- [ ]", 1)
        root, _ = _legacy_project_line(
            line,
            section="## TODO",
            phase="DONE",
            task="none",
            next_action="saipen continue",
        )

        result = ticket_move(
            root, "block", "T-1315", "test-agent", "external " + ("reason detail " * 200)
        )
        self.assertTrue(result.ok, result.to_dict())

        ticket = _ticket(root)
        self.assertEqual(ticket["section"], "## BLOCKED")
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        self.assertTrue(ticket["fields"]["blocker"].startswith("external"))
        self.assertTrue(ticket["fields"].get("detail_ref"))
        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertTrue(detail["metadata"]["lossless"])


class TargetCClosureGrowthTests(OrchestrationFixture):
    """TARGET C: closure growth is externalized, never a dead end."""

    def test_finish_with_a_large_cohort_externalizes_the_grown_row(self):
        project = self.make_project(active=True)
        self.to_ship(project, "T-7")

        paths = []
        for i in range(40):
            rel = f"src/cohort/module_{i:03d}/implementation_payload_{i:03d}.py"
            fp = project / rel
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(f"# payload {i}\n", encoding="utf-8")
            paths.append(rel)

        result = finish_ticket(
            project,
            "T-7",
            "tester",
            closure_mode="cohort",
            closure_cohort="C-1",
            closure_paths=paths,
        )
        self.assertTrue(result.ok, result.to_dict())

        ticket = self.board(project)["tickets"]["T-7"]
        self.assertEqual(ticket["section"], "## DONE")
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        self.assertTrue(ticket["fields"].get("detail_ref"))
        self.assertEqual(ticket["fields"]["closure_mode"], "cohort")
        self.assertEqual(ticket["fields"]["closure_cohort"], "C-1")

        detail = resolve_detail(project, ticket["fields"]["detail_ref"])
        self.assertTrue(detail["metadata"]["lossless"])
        self.assertIn(paths[39], detail["original_record"].decode("utf-8"))


class RefusedFieldOversizeReachabilityTests(unittest.TestCase):
    """SAIPENP0: a refused field on the oversized row must not deadlock repair.

    Generation skew writes a field the reader's closed grammar rejects. The
    first reader returned NO oversized ids when any error was present, so Fleet
    named no BOARD compaction while still declaring the board unrepairable --
    the row could never be reached by the canonical command that exists for it.
    Tolerating ONLY the unknown-field class (whose bytes survive verbatim in the
    detail authority) restores the named repair without laundering an AMBIGUOUS
    record: a duplicate field still refuses.
    """

    def test_named_repair_targets_the_real_ticket_and_repairs_losslessly(self):
        root, _ = _legacy_project()
        board_path = root / ".saipen" / "BOARD.md"
        mutated = board_path.read_text(encoding="utf-8").replace(
            " | owner: test-agent", " | zz_legacy_field: skew | owner: test-agent", 1
        )
        board_path.write_text(mutated, encoding="utf-8")

        parsed = parse_board(mutated)
        self.assertTrue(parsed["errors"], "fixture must carry a refused field")
        self.assertEqual(oversized_ticket_ids(mutated), ["T-1315"])

        result = preflight(
            root,
            explicit_root=root,
            host_root=root,
            host_lineage=project_lineage_identity(root),
        )
        self.assertEqual(result["classification"], CLASS_SAFE, result)
        self.assertEqual(result["reason_code"], "BOARD_RECORD_OVERSIZE", result)
        self.assertEqual(result["canonical_next_command"], "saipen ticket compact T-1315")

        repaired = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(repaired.ok, repaired.to_dict())
        after = parse_board(board_path.read_text(encoding="utf-8"))
        self.assertEqual(after["errors"], [])
        ticket = after["tickets"]["T-1315"]
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        detail = resolve_detail(root, ticket["fields"]["detail_ref"])
        self.assertIn("zz_legacy_field", detail["original_record"].decode("utf-8"))
        self.assertTrue(detail["metadata"]["lossless"])

    def test_a_refused_field_on_a_foreign_row_is_never_named_or_repaired(self):
        root, _ = _legacy_project()
        board_path = root / ".saipen" / "BOARD.md"
        foreign = "- [ ] T-0001 small | zz_foreign_field: skew\n"
        mutated = board_path.read_text(encoding="utf-8").replace(
            "## TODO\n", "## TODO\n" + foreign, 1
        )
        board_path.write_text(mutated, encoding="utf-8")

        self.assertEqual(oversized_ticket_ids(mutated), [])

        refused = compact_board(root, "T-1315", "test-agent")
        self.assertFalse(refused.ok)
        self.assertEqual(refused.code, "VALIDATION_FAILED")
        self.assertEqual(board_path.read_text(encoding="utf-8"), mutated)


class TokenBoundaryCompactionTests(unittest.TestCase):
    """T-1326 escape TARGET A: tokenized machine identifiers survive exactly.

    Independent REDs: a 30-dependency row compacted to a partial `T-202...`,
    and a 60-receipt row silently dropped most of its durable `SRC-` links
    while still reporting BOARD_COMPACTED.
    """

    def _compact_row(self, tid: str, *, needs=(), receipts=()) -> dict:
        root = fresh_project(
            phase="BUILD", task=tid, next_action=f"PHASE BUILD {tid}", agent="test-agent"
        )
        fields = []
        if needs:
            fields.append("needs: " + ", ".join(needs))
        if receipts:
            fields.append("source_receipts: " + ", ".join(receipts))
        fields.append("verify: " + ("proof " * 200))
        line = (
            f"- [/] {tid} [P1] "
            + ("legacy evidence " * 140)
            + " | "
            + " | ".join(fields)
            + " | owner: test-agent | claim_time: 2026-09-14T08:00:00Z\n"
        )
        board = f"## DOING\n{line}## TODO\n## DONE\n## BLOCKED\n"
        result = prepare_existing(
            root, board, [tid], op_id="op-token-boundary", event_id=None, reason="unit"
        )
        return parse_board(result.board_text)["tickets"][tid]

    def test_thirty_dependencies_survive_without_a_partial_token(self):
        deps = [f"T-{2001 + i}" for i in range(30)]
        ticket = self._compact_row("T-1315", needs=deps)
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        needs = ticket["fields"]["needs"]
        self.assertNotIn("...", needs)
        kept = [part.strip() for part in needs.split(",") if part.strip()]
        self.assertEqual(kept, deps)
        for token in kept:
            self.assertRegex(token, r"^T-\d+$")

    def test_sixty_source_receipts_survive_without_a_partial_token(self):
        receipts = [f"SRC-{3001 + i}" for i in range(60)]
        ticket = self._compact_row("T-1315", receipts=receipts)
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        got = ticket["fields"]["source_receipts"]
        self.assertNotIn("...", got)
        kept = [part.strip() for part in got.split(",") if part.strip()]
        self.assertEqual(kept, receipts)
        for token in kept:
            self.assertRegex(token, r"^SRC-\d+$")

    def test_prose_is_reduced_before_any_machine_token(self):
        deps = [f"T-{4001 + i}" for i in range(30)]
        receipts = [f"SRC-{5001 + i}" for i in range(60)]
        ticket = self._compact_row("T-1315", needs=deps, receipts=receipts)
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        self.assertEqual(
            [p.strip() for p in ticket["fields"]["needs"].split(",") if p.strip()], deps
        )
        self.assertEqual(
            [p.strip() for p in ticket["fields"]["source_receipts"].split(",") if p.strip()],
            receipts,
        )


class SupersessionChainIntegrityTests(unittest.TestCase):
    """T-1326 escape TARGET B: the supersession chain is authority, fail-closed."""

    def _chain(self) -> tuple[Path, str, str]:
        line = _legacy_line(verify=("proof " * 200))
        root, _ = _legacy_project_line(line)
        first = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(first.ok, first.to_dict())
        ref1 = _ticket(root)["fields"]["detail_ref"]
        second = ticket_verify(root, "T-1315", "test-agent", "successor " + ("semantic " * 300))
        self.assertTrue(second.ok, second.to_dict())
        ref2 = _ticket(root)["fields"]["detail_ref"]
        self.assertNotEqual(ref1, ref2)
        return root, ref1, ref2

    def test_successor_names_predecessor_and_full_chain_resolves(self):
        root, ref1, ref2 = self._chain()
        successor = resolve_detail(root, ref2)["metadata"]
        self.assertEqual(successor["supersedes_detail_ref"], ref1)
        predecessor = resolve_detail(root, ref1)
        self.assertEqual(predecessor["metadata"]["ticket_id"], "T-1315")
        self.assertTrue(successor["lossless"])

    def test_missing_predecessor_metadata_fails_closed(self):
        root, ref1, ref2 = self._chain()
        (root / ref1).unlink()
        with self.assertRaises(ValueError):
            resolve_detail(root, ref2)
        before = (root / ".saipen" / "BOARD.md").read_bytes()
        refused = ticket_verify(root, "T-1315", "test-agent", "third mutation")
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), before)

    def test_missing_predecessor_original_record_fails_closed(self):
        root, ref1, ref2 = self._chain()
        meta1 = resolve_detail(root, ref1)["metadata"]
        (root / meta1["original_record_path"]).unlink()
        with self.assertRaises(ValueError):
            resolve_detail(root, ref2)

    def test_predecessor_hash_mismatch_fails_closed(self):
        root, ref1, ref2 = self._chain()
        meta1 = resolve_detail(root, ref1)["metadata"]
        record = root / meta1["original_record_path"]
        record.write_bytes(record.read_bytes() + b"tampered\n")
        with self.assertRaises(ValueError):
            resolve_detail(root, ref2)

    def test_predecessor_byte_count_mismatch_fails_closed(self):
        root, ref1, ref2 = self._chain()
        meta_path = root / ref1
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        original = (root / meta["original_record_path"]).read_bytes()
        meta["original_record_bytes"] = len(original) + 1
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            resolve_detail(root, ref2)

    def test_supersession_cycle_fails_closed(self):
        root, _ref1, ref2 = self._chain()
        meta_path = root / ref2
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["supersedes_detail_ref"] = ref2
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            resolve_detail(root, ref2)

    def test_broken_predecessor_surfaces_in_read_only_diagnosis(self):
        root, ref1, _ref2 = self._chain()
        (root / ref1).unlink()
        result = preflight(
            root,
            explicit_root=root,
            host_root=root,
            host_lineage=project_lineage_identity(root),
        )
        self.assertEqual(result["reason_code"], "BOARD_DETAIL_UNRESOLVABLE", result)
        self.assertEqual(result["classification"], CLASS_BLOCKED, result)


class MultiRowRefusedFieldRecoveryTests(unittest.TestCase):
    """T-1326 escape TARGET C: N repairable refused-field rows are reachable."""

    def _oversized_refused_row(self, tid: str) -> str:
        # A historical, detached oversized record with a refused field --
        # exactly the independently reproduced shape. The canonical multi-row
        # compaction journals each row's own [T-###] event, which is what makes
        # it canonical without a pre-existing allocation event.
        return (
            f"- [ ] {tid} [P1] "
            + ("legacy evidence " * 140)
            + " | zz_legacy_field: skew | verify: "
            + ("proof " * 180)
            + "\n"
        )

    def _two_refused_rows(self) -> tuple[Path, str]:
        root, _ = _legacy_project()
        board_path = root / ".saipen" / "BOARD.md"
        text = board_path.read_text(encoding="utf-8").replace(
            " | owner: test-agent", " | zz_legacy_field: skew | owner: test-agent", 1
        )
        text = text.replace(
            "## TODO\n", "## TODO\n" + self._oversized_refused_row("T-1316"), 1
        )
        board_path.write_text(text, encoding="utf-8")
        return root, text

    def test_all_repairable_rows_are_named_and_repaired_in_one_operation(self):
        root, text = self._two_refused_rows()
        self.assertEqual(sorted(oversized_ticket_ids(text)), ["T-1315", "T-1316"])

        fleet = preflight(
            root,
            explicit_root=root,
            host_root=root,
            host_lineage=project_lineage_identity(root),
        )
        self.assertEqual(fleet["classification"], CLASS_SAFE, fleet)
        self.assertEqual(fleet["reason_code"], "BOARD_RECORD_OVERSIZE", fleet)
        self.assertNotEqual(fleet["reason_code"], "CLEAN")
        self.assertIn("saipen ticket compact T-", fleet["canonical_next_command"])

        repaired = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(repaired.ok, repaired.to_dict())

        after = parse_board((root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        self.assertEqual(after["errors"], [])
        for tid in ("T-1315", "T-1316"):
            ticket = after["tickets"][tid]
            self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
            self.assertTrue(ticket["fields"].get("detail_ref"))
            detail = resolve_detail(root, ticket["fields"]["detail_ref"])
            self.assertIn("zz_legacy_field", detail["original_record"].decode("utf-8"))
            self.assertTrue(detail["metadata"]["lossless"])

    def test_every_artifact_names_its_own_ticket_event(self):
        """T-1326 P2: a 3-row repair must not cite one row's DEC on all three.

        The reproduction: multi-row compaction emitted one DEC per ticket but
        supplied the FIRST event id to every detail metadata artifact, so two
        artifacts named another ticket's decision.
        """
        root, text = self._two_refused_rows()
        board_path = root / ".saipen" / "BOARD.md"
        text = text.replace(
            "## TODO\n", "## TODO\n" + self._oversized_refused_row("T-1317"), 1
        )
        board_path.write_text(text, encoding="utf-8")
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)

        after = parse_board(board_path.read_text(encoding="utf-8"))
        events: dict[str, str] = {}
        operations = set()
        for tid in ("T-1315", "T-1316", "T-1317"):
            ref = after["tickets"][tid]["fields"]["detail_ref"]
            metadata = json.loads((root / ref).read_text(encoding="utf-8"))
            self.assertEqual(metadata["ticket_id"], tid)
            events[tid] = metadata["externalization_event"]["event_id"]
            operations.add(metadata["externalization_event"]["operation_id"])
        # One event per ticket, all distinct, all naming that ticket in the LOG.
        self.assertEqual(len(set(events.values())), 3, events)
        log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        for tid, event in events.items():
            self.assertIsNotNone(event, (tid, events))
            line = next(
                (
                    candidate
                    for candidate in log.splitlines()
                    if f"[{event}]" in candidate
                ),
                None,
            )
            self.assertIsNotNone(line, (tid, event))
            self.assertIn(f"[{tid}]", line)
        # ... and the whole repair is ONE operation.
        self.assertEqual(len(operations), 1, operations)

    def test_three_repairable_rows_converge(self):
        root, text = self._two_refused_rows()
        board_path = root / ".saipen" / "BOARD.md"
        text = text.replace(
            "## TODO\n", "## TODO\n" + self._oversized_refused_row("T-1317"), 1
        )
        board_path.write_text(text, encoding="utf-8")
        self.assertEqual(
            sorted(oversized_ticket_ids(text)), ["T-1315", "T-1316", "T-1317"]
        )
        repaired = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(repaired.ok, repaired.to_dict())
        after = parse_board(board_path.read_text(encoding="utf-8"))
        self.assertEqual(after["errors"], [])
        for tid in ("T-1315", "T-1316", "T-1317"):
            self.assertTrue(after["tickets"][tid]["fields"].get("detail_ref"))

    def test_ambiguous_row_keeps_recovery_fail_closed(self):
        root, text = self._two_refused_rows()
        duplicate = "- [ ] T-1317 [P1] ambiguous | owner: a | owner: b\n"
        text = text.replace("## TODO\n", "## TODO\n" + duplicate, 1)
        (root / ".saipen" / "BOARD.md").write_text(text, encoding="utf-8")
        self.assertEqual(oversized_ticket_ids(text), [])
        refused = compact_board(root, "T-1315", "test-agent")
        self.assertFalse(refused.ok)
        self.assertEqual(refused.code, "VALIDATION_FAILED")

        # Fleet must never call malformed protocol state CLEAN, and must never
        # advertise a command it cannot deliver.
        fleet = preflight(
            root,
            explicit_root=root,
            host_root=root,
            host_lineage=project_lineage_identity(root),
        )
        self.assertNotEqual(fleet["reason_code"], "CLEAN", fleet)
        self.assertNotEqual(fleet["classification"], CLASS_SAFE, fleet)


_BRAKE = "BLOCKED_EXTERNAL"
_DECISION = "vendor renewed; legal and security re-approved"


def _braked_project() -> Path:
    """A SCOUT project whose STATE.blocker is a ~3 KB recognised gate.

    The blocker is deliberately large: it is the exact shape that made the ONLY
    sanctioned recovery verb (`saipen recover resolve-blocker`) construct a DEC
    above the 1024-byte LOG cap and raise `LOG_EVENT_OVERSIZE` -- a recovery verb
    deadlocking on its own brake.
    """
    root = _recovery_project(
        blocker=f"{_BRAKE} -- " + ("vendor certification evidence pending " * 90)
    )
    return root


def _legacy_fleet(root: Path, extra: int) -> tuple[str, ...]:
    """`root` plus `extra` more unattested workable legacy rows on the BOARD."""
    board = root / ".saipen" / "BOARD.md"
    rows = "".join(
        f"- [ ] T-{778 + index} [P1] legacy ticket before allocation identity"
        " existed | verify: test\n"
        for index in range(extra)
    )
    text = board.read_text(encoding="utf-8").replace("## DONE\n", rows + "## DONE\n", 1)
    board.write_text(text, encoding="utf-8")
    return tuple(f"T-{777 + index}" for index in range(extra + 1))


def _detail_artifacts(root: Path) -> list[Path]:
    return sorted((root / ".saipen" / "recovery" / "log-detail").glob("*.json"))


def _verify_detail(root: Path, metadata_path: Path) -> dict:
    """Prove one externalized LOG detail artifact against its own metadata."""
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    event_path = root / metadata["original_event_path"]
    raw = event_path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == metadata["original_event_sha256"]
    assert len(raw) == metadata["original_event_bytes"]
    assert metadata["lossless"] is True
    assert metadata["status"] == "COMMITTED"
    return metadata


INT_SCENARIO = (
    Path(__file__).resolve().parents[1]
    / "tests"
    / "scenarios"
    / "stale-state-reconciliation"
    / ".saipen"
)


class SourceLinkTransactionTests(unittest.TestCase):
    """T-1326 P1: source receipt linkage must be ONE transaction.

    Independently reproduced near the 1200-character BOARD cap: `capture`
    returned VALIDATION_FAILED / BOARD_RECORD_OVERSIZE, yet durable state
    already held the source body, the metadata `linked_work=T-###`, and the
    intake index link while the BOARD carried no receipt -- a partial canonical
    commit in which three authorities disagreed.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="t1326-source-link-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(INT_SCENARIO, self.root / ".saipen")
        self.config = Path(self.tmp.name) / "user-config"
        self.env = patch.dict(os.environ, {"SAIPEN_USER_CONFIG_HOME": str(self.config)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def _board_path(self) -> Path:
        return self.root / ".saipen" / "BOARD.md"

    def _write_row(self, row: str) -> None:
        self._board_path().write_text(
            "## DOING\n" + row + "## TODO\n## DONE\n## BLOCKED\n", encoding="utf-8"
        )

    def _near_cap_row(self, target: int = 1195) -> str:
        head = "- [/] T-001 [P1] "
        tail = " | verify: proof | owner: test-agent | claim_time: 2026-09-14T08:00:00Z"
        return head + "x" * (target - len(head) - len(tail)) + tail + "\n"

    def _impossible_row(self) -> str:
        # `needs` is INLINE machine truth the dependency graph/scheduler consume
        # exactly, so it may never be reduced or dropped. 200 identifiers alone
        # exceed the cap, so no compact representation of this row exists and
        # the exact receipt token cannot be added without truncating it.
        needs = ",".join(f"T-{2001 + index}" for index in range(200))
        return f"- [/] T-001 [P1] task | needs: {needs} | verify: proof\n"

    def _capture(self, body: str = "audit body", **kwargs) -> dict:
        return intake.capture(self.root, body, source_kind="user_audit", **kwargs)

    def _authorities(self, receipt: str) -> dict:
        board = self._board_path().read_text(encoding="utf-8")
        index = json.loads(
            (self.root / ".saipen" / "intake" / "index.json").read_text(encoding="utf-8")
        )
        meta = intake._read_meta(self.root, receipt)
        return {
            "board": board,
            "meta": meta,
            "index": index["active"].get(receipt, {}),
            "linked_ok": (
                f"source_receipts: {receipt}" in board
                and meta.get("linked_work") == "T-001"
                and index["active"].get(receipt, {}).get("linked_work") == "T-001"
            ),
        }

    def test_a_near_cap_row_compacts_and_the_receipt_lands(self):
        self._write_row(self._near_cap_row())
        result = self._capture(work="T-001")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "SOURCE_RECEIVED", result)
        self.assertEqual(result["linked_work"], "T-001", result)

        receipt = result["receipt"]
        ticket = parse_board(self._board_path().read_text(encoding="utf-8"))["tickets"]["T-001"]
        self.assertLessEqual(len(ticket["raw"]), MAX_LIVE_RECORD_CHARS)
        self.assertIn(receipt, ticket["fields"]["source_receipts"])
        # The near-cap row's full pre-link bytes were externalized losslessly.
        detail_ref = ticket["fields"].get("detail_ref")
        self.assertTrue(detail_ref, ticket)
        detail = resolve_detail(self.root, detail_ref, expected_ticket_id="T-001")
        self.assertIn(b"verify: proof", detail["original_record"])
        authorities = self._authorities(receipt)
        self.assertTrue(authorities["linked_ok"], authorities)

    def test_a_failure_before_the_link_commit_leaves_everything_unlinked(self):
        self._write_row(self._near_cap_row())
        before = self._board_path().read_bytes()
        broken = {"ok": False, "detail": "injected"}
        with patch.object(intake, "_relink_authorities", return_value=broken):
            result = self._capture(work="T-001")
        self.assertFalse(result["ok"], result)
        self.assertIsNone(result["linked_work"], result)
        self.assertEqual(self._board_path().read_bytes(), before)
        authorities = self._authorities(result["receipt"])
        self.assertNotEqual(authorities["meta"].get("linked_work"), "T-001", authorities)
        self.assertNotEqual(authorities["index"].get("linked_work"), "T-001", authorities)
        self.assertNotIn("source_receipts:", authorities["board"])
        # The source body itself stays durable and recoverable, unlinked.
        self.assertTrue(
            (self.root / ".saipen" / "intake" / "active" / f"{result['receipt']}.md").is_file()
        )

    def test_an_injected_link_failure_retries_idempotently(self):
        self._write_row(self._near_cap_row())
        broken = {"ok": False, "detail": "injected"}
        with patch.object(intake, "_relink_authorities", return_value=broken):
            first = self._capture(work="T-001")
        self.assertFalse(first["ok"], first)

        second = self._capture(work="T-001")
        self.assertTrue(second["ok"], second)
        self.assertEqual(second["receipt"], first["receipt"])
        self.assertEqual(second["linked_work"], "T-001", second)
        third = self._capture(work="T-001")
        self.assertTrue(third["ok"], third)
        self.assertEqual(third["linked_work"], "T-001", third)
        authorities = self._authorities(first["receipt"])
        self.assertTrue(authorities["linked_ok"], authorities)
        self.assertEqual(
            authorities["board"].count(f"source_receipts: {first['receipt']}"), 1, authorities
        )

    def test_exact_receipt_truth_that_cannot_fit_is_refused(self):
        self._write_row(self._impossible_row())
        before = self._board_path().read_bytes()
        result = self._capture(work="T-001")
        self.assertFalse(result["ok"], result)
        self.assertIn(result["code"], ("BOARD_RECORD_OVERSIZE", "VALIDATION_FAILED"), result)
        self.assertIsNone(result["linked_work"], result)
        # Nothing was truncated and nothing was linked.
        self.assertEqual(self._board_path().read_bytes(), before)
        authorities = self._authorities(result["receipt"])
        self.assertNotEqual(authorities["meta"].get("linked_work"), "T-001", authorities)
        self.assertNotEqual(authorities["index"].get("linked_work"), "T-001", authorities)
        self.assertNotIn("source_receipts:", authorities["board"])


class FleetOversizeDetailAuthorityTests(unittest.TestCase):
    """T-1326 P1: Fleet must never advertise a repair it knows cannot run.

    Independently reproduced: an oversized historical row carried BOTH a
    tolerated unknown legacy field AND a `detail_ref` whose authority was
    missing/corrupt. Fleet advertised CLASS_SAFE / BOARD_RECORD_OVERSIZE and
    `saipen ticket compact T-###`, but executing that exact command refused
    because the detail authority was unresolvable -- an impossible auto-repair,
    which is worse now that Fleet can execute exact named SAFE repairs itself.

    Invariant: if Fleet advertises a canonical SAFE repair, that exact command
    satisfies the preconditions Fleet already knew at advertisement time.
    """

    def _project(self) -> Path:
        root = fresh_project(
            phase="BUILD", task="T-1315", next_action="PHASE BUILD T-1315", agent="test-agent"
        )
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        return root

    def _write_board(self, root: Path, rows: str) -> str:
        text = "## DOING\n" + rows + "## TODO\n## DONE\n## BLOCKED\n"
        (root / ".saipen" / "BOARD.md").write_text(text, encoding="utf-8")
        return text

    def _oversized_row(
        self,
        ticket: str = "T-1315",
        *,
        detail_ref: str = "",
        checkbox: str = "[/]",
    ) -> str:
        bits = [
            "verify: " + ("proof " * 180),
            "legacy_note: tolerated unknown field",
            "owner: test-agent",
            "claim_time: 2026-09-14T08:00:00Z",
        ]
        if detail_ref:
            bits.insert(0, f"detail_ref: {detail_ref}")
        return (
            f"- {checkbox} {ticket} [P1] "
            + ("legacy evidence " * 140)
            + " | "
            + " | ".join(bits)
            + "\n"
        )

    def _fleet(self, root: Path) -> dict:
        return preflight(
            root,
            explicit_root=root,
            host_root=root,
            host_lineage=project_lineage_identity(root),
        )

    def _assert_no_compact_advertised(self, fleet: dict) -> None:
        command = str(fleet.get("canonical_next_command") or "")
        self.assertNotIn("ticket compact", command, fleet)
        self.assertEqual(fleet["reason_code"], "BOARD_DETAIL_UNRESOLVABLE", fleet)
        self.assertEqual(fleet["classification"], CLASS_BLOCKED, fleet)
        self.assertFalse(fleet.get("safe_auto_repair_available"), fleet)

    def test_a_missing_detail_metadata_outranks_the_oversize_route(self):
        root = self._project()
        self._write_board(
            root,
            self._oversized_row(
                detail_ref=".saipen/recovery/board-compaction/T-1315/T-1315-missing.json"
            ),
        )
        self._assert_no_compact_advertised(self._fleet(root))
        # ... and the command Fleet USED to advertise genuinely cannot run here.
        self.assertFalse(compact_board(root, "T-1315", "test-agent").ok)

    def test_a_missing_original_record_outranks_the_oversize_route(self):
        root = self._project()
        line = _legacy_line(verify=("proof " * 200))
        self._write_board(root, line)
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)
        metadata_path = root / _ticket(root)["fields"]["detail_ref"]
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        (root / metadata["original_record_path"]).unlink()
        self._make_row_oversized_again(root)
        self._assert_no_compact_advertised(self._fleet(root))

    def test_a_hash_mismatch_outranks_the_oversize_route(self):
        root = self._project()
        line = _legacy_line(verify=("proof " * 200))
        self._write_board(root, line)
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)
        metadata_path = root / _ticket(root)["fields"]["detail_ref"]
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        record = root / metadata["original_record_path"]
        record.write_bytes(record.read_bytes() + b"tampered\n")
        self._make_row_oversized_again(root)
        self._assert_no_compact_advertised(self._fleet(root))

    def test_a_broken_predecessor_outranks_the_oversize_route(self):
        root = self._project()
        line = _legacy_line(verify=("proof " * 200))
        self._write_board(root, line)
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)
        ref1 = _ticket(root)["fields"]["detail_ref"]
        self.assertTrue(
            ticket_verify(root, "T-1315", "test-agent", "successor " + ("semantic " * 300)).ok
        )
        (root / ref1).unlink()
        self._make_row_oversized_again(root)
        self._assert_no_compact_advertised(self._fleet(root))

    def test_a_mixed_set_with_one_broken_chain_is_never_advertised(self):
        root = self._project()
        rows = self._oversized_row("T-1315")
        rows += self._oversized_row(
            "T-1316",
            detail_ref=".saipen/recovery/board-compaction/T-1316/T-1316-missing.json",
            checkbox="[ ]",
        )
        self._write_board(root, rows)
        fleet = self._fleet(root)
        self._assert_no_compact_advertised(fleet)
        self.assertIn("T-1316", str(fleet.get("reason")), fleet)

    def test_a_healthy_oversized_row_still_advertises_the_exact_command(self):
        root = self._project()
        self._write_board(root, self._oversized_row())
        fleet = self._fleet(root)
        self.assertEqual(fleet["reason_code"], "BOARD_RECORD_OVERSIZE", fleet)
        self.assertIn("T-1315", str(fleet.get("canonical_next_command")), fleet)
        self.assertTrue(fleet.get("safe_auto_repair_available"), fleet)
        # The invariant itself: the advertised command actually succeeds.
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)

    def test_a_healthy_oversized_row_with_intact_authority_is_advertised(self):
        root = self._project()
        line = _legacy_line(verify=("proof " * 200))
        self._write_board(root, line)
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)
        self._make_row_oversized_again(root)
        fleet = self._fleet(root)
        self.assertEqual(fleet["reason_code"], "BOARD_RECORD_OVERSIZE", fleet)
        self.assertNotEqual(fleet["classification"], CLASS_BLOCKED, fleet)

    def _make_row_oversized_again(self, root: Path) -> None:
        """Grow the (already compacted) live row back past the cap in place."""
        board_path = root / ".saipen" / "BOARD.md"
        text = board_path.read_text(encoding="utf-8")
        ticket = _ticket(root)
        grown = ticket["raw"].rstrip("\n") + " | legacy_note: " + ("tolerated " * 80)
        board_path.write_text(text.replace(ticket["raw"].rstrip("\n"), grown, 1), encoding="utf-8")
        self.assertIn("T-1315", oversized_ticket_ids(board_path.read_text(encoding="utf-8")))


class LongSupersessionHistoryTests(unittest.TestCase):
    """T-1326 P1: the writer must never commit what the reader rejects.

    Independently reproduced with the previous `_MAX_SUPERSESSION_DEPTH = 64`:
    successive oversized semantic mutations kept succeeding, the mutation that
    crossed the limit COMMITTED, the next resolve failed with a chain-depth
    error, and Fleet became BLOCKED with no lawful repair.

    The repair is a bounded LOSSELESS representation (a lineage checkpoint that
    flattens the ancestry and terminates traversal). After EVERY successful
    write the regression proves: the current detail resolves, Fleet stays valid,
    and another lawful mutation remains reachable.
    """

    MUTATIONS = 70

    def test_seventy_oversized_mutations_stay_readable_and_reachable(self):
        line = _legacy_line(verify=("proof " * 200))
        root, _ = _legacy_project_line(line)
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)

        for step in range(self.MUTATIONS):
            result = ticket_verify(
                root,
                "T-1315",
                "test-agent",
                f"generation {step} " + ("semantic " * 300),
            )
            self.assertTrue(result.ok, (step, result.to_dict()))

            detail_ref = _ticket(root)["fields"]["detail_ref"]
            # 1. the current detail resolves (this is the exact call that used
            #    to fail with `chain exceeds the bounded depth`).
            resolved = resolve_detail(root, detail_ref, expected_ticket_id="T-1315")
            self.assertTrue(resolved["metadata"]["lossless"])
            self.assertLessEqual(len(_ticket(root)["raw"]), MAX_LIVE_RECORD_CHARS)

            # 2. Fleet stays valid and never advertises an impossible repair.
            fleet = preflight(
                root,
                explicit_root=root,
                host_root=root,
                host_lineage=project_lineage_identity(root),
            )
            self.assertNotEqual(fleet["reason_code"], "BOARD_DETAIL_UNRESOLVABLE", (step, fleet))
            self.assertNotEqual(fleet["classification"], CLASS_BLOCKED, (step, fleet))

            # 3. read-only diagnosis agrees the authority is intact.
            from saipen_engine.board_compaction import (
                compacted_ticket_ids,
                detail_integrity_error,
            )

            live = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
            self.assertIsNone(
                detail_integrity_error(root, live, compacted_ticket_ids(live)), step
            )

    def test_the_boundary_generation_carries_a_bounded_checkpoint(self):
        line = _legacy_line(verify=("proof " * 200))
        root, _ = _legacy_project_line(line)
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)

        checkpointed = None
        for step in range(self.MUTATIONS):
            self.assertTrue(
                ticket_verify(
                    root, "T-1315", "test-agent", f"generation {step} " + ("semantic " * 300)
                ).ok
            )
            metadata = json.loads(
                (root / _ticket(root)["fields"]["detail_ref"]).read_text(encoding="utf-8")
            )
            if metadata.get("supersedes_checkpoint"):
                checkpointed = metadata
                break

        self.assertIsNotNone(checkpointed, "no generation ever bounded its ancestry")
        checkpoint_ref = checkpointed["supersedes_checkpoint"]
        checkpoint = json.loads((root / checkpoint_ref).read_text(encoding="utf-8"))
        self.assertEqual(checkpoint["operation"], "board_legacy_compaction_lineage")
        self.assertTrue(checkpoint["lossless"])
        self.assertLessEqual(len(checkpoint["entries"]), 64)
        self.assertEqual(checkpoint["entries_digest"], _entries_digest(checkpoint["entries"]))
        # Every historical original byte stays reachable and hash-verifiable.
        for entry in checkpoint["entries"]:
            raw = (root / entry["original_record_path"]).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), entry["original_record_sha256"])
            self.assertEqual(len(raw), entry["original_record_bytes"])
        # Ordered, contiguous ancestry: each entry supersedes the next.
        for entry, following in zip(checkpoint["entries"], checkpoint["entries"][1:]):
            self.assertEqual(entry["supersedes_detail_ref"], following["detail_ref"])

    def test_a_tampered_checkpoint_fails_closed(self):
        line = _legacy_line(verify=("proof " * 200))
        root, _ = _legacy_project_line(line)
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)
        for step in range(self.MUTATIONS):
            self.assertTrue(
                ticket_verify(
                    root, "T-1315", "test-agent", f"generation {step} " + ("semantic " * 300)
                ).ok
            )
            metadata_path = root / _ticket(root)["fields"]["detail_ref"]
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if metadata.get("supersedes_checkpoint"):
                break

        checkpoint_path = root / metadata["supersedes_checkpoint"]
        payload = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        # Drop the oldest ancestor: the entry digest and the recorded checkpoint
        # hash must both refuse it, never silently shorten the history.
        payload["entries"] = payload["entries"][:-1]
        payload["entry_count"] = len(payload["entries"])
        checkpoint_path.write_text(
            json.dumps(payload, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )
        metadata_path = root / metadata["metadata_path"]
        with self.assertRaisesRegex(ValueError, "lineage checkpoint"):
            resolve_detail(root, metadata["metadata_path"], expected_ticket_id="T-1315")
        # And the mutation that would extend it refuses with zero writes.
        before = (root / ".saipen" / "BOARD.md").read_bytes()
        refused = ticket_verify(root, "T-1315", "test-agent", "later")
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), before)
        self.assertTrue(metadata_path.is_file())


class SupersessionMetadataFalsificationTests(unittest.TestCase):
    """T-1326 P1: metadata must not be able to SEVER a successor's history.

    Independently reproduced: compact -> detail A; oversized mutation ->
    successor B declaring predecessor A; blank `B.supersedes_detail_ref` and
    delete A's metadata + original record; B still resolved and a later
    canonical mutation still succeeded. The successor's HISTORY was gone while
    the artifact kept claiming to be lossless.

    The externalized original row is the counter-witness: it is the exact
    physical line the artifact was made from, so the `detail_ref` IT carried is
    the edge the successor must declare. Any mismatch fails closed.
    """

    def _chain(self) -> tuple[Path, str, str]:
        line = _legacy_line(verify=("proof " * 200))
        root, _ = _legacy_project_line(line)
        first = compact_board(root, "T-1315", "test-agent")
        self.assertTrue(first.ok, first.to_dict())
        ref1 = _ticket(root)["fields"]["detail_ref"]
        second = ticket_verify(
            root, "T-1315", "test-agent", "successor " + ("semantic " * 300)
        )
        self.assertTrue(second.ok, second.to_dict())
        ref2 = _ticket(root)["fields"]["detail_ref"]
        self.assertNotEqual(ref1, ref2)
        return root, ref1, ref2

    def _rewrite_metadata(self, root: Path, ref: str, **changes) -> dict:
        path = root / ref
        meta = json.loads(path.read_text(encoding="utf-8"))
        meta.update(changes)
        path.write_text(json.dumps(meta, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        return meta

    def _drop_carried_edge(self, root: Path, ref: str) -> None:
        """Substitute the original row for one whose `detail_ref` is gone.

        Hashes and byte counts are UPDATED to match, so the only remaining
        fault is the severed edge itself -- exactly the falsification under
        test.
        """
        path = root / ref
        meta = json.loads(path.read_text(encoding="utf-8"))
        record_path = root / meta["original_record_path"]
        row = record_path.read_text(encoding="utf-8")
        kept = [
            part
            for part in row.rstrip("\n").split(" | ")
            if not part.strip().startswith("detail_ref:")
        ]
        rewritten = (" | ".join(kept) + "\n").encode("utf-8")
        record_path.write_bytes(rewritten)
        meta["original_record_sha256"] = hashlib.sha256(rewritten).hexdigest()
        meta["original_record_bytes"] = len(rewritten)
        path.write_text(json.dumps(meta, sort_keys=True, indent=2) + "\n", encoding="utf-8")

    def test_the_writer_always_declares_the_edge_its_original_row_carried(self):
        root, ref1, ref2 = self._chain()
        metadata = json.loads((root / ref2).read_text(encoding="utf-8"))
        self.assertEqual(metadata["supersedes_detail_ref"], ref1)
        detail = resolve_detail(root, ref2)
        self.assertEqual(detail["supersedes_detail_ref"], ref1)
        self.assertEqual(detail["metadata"]["supersedes_detail_ref"], ref1)

    def test_blanking_the_claim_and_deleting_the_predecessor_fails_closed(self):
        root, ref1, ref2 = self._chain()
        meta1 = json.loads((root / ref1).read_text(encoding="utf-8"))
        self._rewrite_metadata(root, ref2, supersedes_detail_ref="")
        (root / ref1).unlink()
        (root / meta1["original_record_path"]).unlink()

        with self.assertRaisesRegex(ValueError, "supersession edge disagrees"):
            resolve_detail(root, ref2)
        before = (root / ".saipen" / "BOARD.md").read_bytes()
        refused = ticket_verify(root, "T-1315", "test-agent", "later mutation")
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), before)

    def test_blanking_the_claim_alone_fails_closed(self):
        root, _ref1, ref2 = self._chain()
        self._rewrite_metadata(root, ref2, supersedes_detail_ref="")
        with self.assertRaisesRegex(ValueError, "supersession edge disagrees"):
            resolve_detail(root, ref2)

    def test_deleting_the_predecessor_after_repointing_fails_closed(self):
        root, ref1, ref2 = self._chain()
        self._rewrite_metadata(root, ref2, supersedes_detail_ref=ref2)
        (root / ref1).unlink()
        with self.assertRaises(ValueError):
            resolve_detail(root, ref2)

    def test_a_substituted_predecessor_artifact_fails_closed(self):
        root, ref1, ref2 = self._chain()
        self._rewrite_metadata(root, ref2, supersedes_detail_ref=ref1 + "-substituted")
        with self.assertRaisesRegex(ValueError, "supersession edge disagrees"):
            resolve_detail(root, ref2)

    def test_a_wrongly_typed_edge_fails_closed(self):
        for bogus in (None, 5, ["a"], True):
            with self.subTest(bogus=repr(bogus)):
                root, _ref1, ref2 = self._chain()
                self._rewrite_metadata(root, ref2, supersedes_detail_ref=bogus)
                with self.assertRaisesRegex(ValueError, "non-string supersession"):
                    resolve_detail(root, ref2)

    def test_a_successor_that_removed_its_carried_edge_fails_closed(self):
        root, ref1, ref2 = self._chain()
        self._rewrite_metadata(root, ref2, supersedes_detail_ref=ref1)
        self._drop_carried_edge(root, ref2)
        with self.assertRaisesRegex(ValueError, "supersession edge disagrees"):
            resolve_detail(root, ref2)

    def test_a_first_generation_without_a_predecessor_still_resolves(self):
        root, ref1, _ref2 = self._chain()
        metadata = json.loads((root / ref1).read_text(encoding="utf-8"))
        self.assertEqual(metadata["supersedes_detail_ref"], "")
        self.assertEqual(resolve_detail(root, ref1)["supersedes_detail_ref"], "")

    def test_a_first_generation_cannot_claim_an_edge_it_never_carried(self):
        root, ref1, ref2 = self._chain()
        self._rewrite_metadata(root, ref1, supersedes_detail_ref=ref2)
        with self.assertRaisesRegex(ValueError, "supersession edge disagrees"):
            resolve_detail(root, ref1)


class LegacySupersessionCompatibilityTests(unittest.TestCase):
    """T-1331: pre-supersession metadata (ABSENT key) must stay readable.

    Production reproduction: a real AUDAPACK project blocked with Fleet
    ``BOUND_RECOVERY_REQUIRED_BLOCKED`` / ``BOARD_DETAIL_UNRESOLVABLE`` because
    legacy pre-T-1326 board-compaction metadata carries no
    ``supersedes_detail_ref`` key at all. The hardened reader used
    ``metadata.get(...)`` and therefore treated the ABSENT legacy key and an
    explicit JSON ``null`` identically -- as a forged non-string edge -- and
    refused. The two shapes have different semantics:

    * key ABSENT -- a legacy artifact created before the supersession edge
      existed; the declared predecessor is the empty string, and the immutable
      externalized original row still cross-checks it.
    * key PRESENT with null / integer / list / object -- malformed or forged
      modern metadata, which stays fail-closed.
    """

    def _legacy_first_generation(self) -> tuple[Path, str]:
        root, _ = _legacy_project_line(_legacy_line(verify=("proof " * 200)))
        self.assertTrue(compact_board(root, "T-1315", "test-agent").ok)
        return root, _ticket(root)["fields"]["detail_ref"]

    def _metadata(self, root: Path, ref: str) -> dict:
        return json.loads((root / ref).read_text(encoding="utf-8"))

    def _write_metadata(self, root: Path, ref: str, meta: dict) -> None:
        (root / ref).write_text(
            json.dumps(meta, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )

    def _delete_edge_key(self, root: Path, ref: str) -> dict:
        meta = self._metadata(root, ref)
        self.assertIn("supersedes_detail_ref", meta)
        del meta["supersedes_detail_ref"]
        self._write_metadata(root, ref, meta)
        return meta

    def _successor_chain(self) -> tuple[Path, str, str]:
        root, ref1 = self._legacy_first_generation()
        self.assertTrue(
            ticket_verify(
                root, "T-1315", "test-agent", "successor " + ("semantic " * 300)
            ).ok
        )
        ref2 = _ticket(root)["fields"]["detail_ref"]
        self.assertNotEqual(ref1, ref2)
        return root, ref1, ref2

    def test_legacy_first_generation_with_an_absent_edge_key_resolves(self):
        root, ref1 = self._legacy_first_generation()
        self._delete_edge_key(root, ref1)
        self.assertNotIn(
            "supersedes_detail_ref",
            json.loads((root / ref1).read_text(encoding="utf-8")),
        )

        detail = resolve_detail(root, ref1, expected_ticket_id="T-1315")
        self.assertEqual(detail["supersedes_detail_ref"], "")
        self.assertTrue(detail["metadata"]["lossless"])
        self.assertEqual(
            detail["sha256"], hashlib.sha256(detail["original_record"]).hexdigest()
        )

    def test_absent_legacy_key_does_not_bypass_the_existing_checks(self):
        root, ref1 = self._legacy_first_generation()
        meta = self._delete_edge_key(root, ref1)

        # The original-record hash proof still runs with the key absent.
        record = root / meta["original_record_path"]
        record.write_bytes(record.read_bytes() + b"tampered\n")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            resolve_detail(root, ref1)

        # Project identity is still enforced when the legacy key is absent.
        root2, ref2 = self._legacy_first_generation()
        evil = self._delete_edge_key(root2, ref2)
        evil["project_identity"] = "not-this-project"
        self._write_metadata(root2, ref2, evil)
        with self.assertRaisesRegex(ValueError, "project identity mismatch"):
            resolve_detail(root2, ref2)

    def test_modern_first_generation_with_an_explicit_empty_edge_resolves(self):
        root, ref1 = self._legacy_first_generation()
        self.assertEqual(self._metadata(root, ref1)["supersedes_detail_ref"], "")
        self.assertEqual(resolve_detail(root, ref1)["supersedes_detail_ref"], "")

    def test_an_explicit_null_edge_still_fails_closed(self):
        root, ref1 = self._legacy_first_generation()
        meta = self._metadata(root, ref1)
        meta["supersedes_detail_ref"] = None
        self._write_metadata(root, ref1, meta)
        with self.assertRaisesRegex(ValueError, "non-string supersession"):
            resolve_detail(root, ref1)

    def test_wrongly_typed_edges_still_fail_closed(self):
        for bogus in (5, 5.5, ["a"], {"ref": "x"}, True):
            with self.subTest(bogus=repr(bogus)):
                root, ref1 = self._legacy_first_generation()
                meta = self._metadata(root, ref1)
                meta["supersedes_detail_ref"] = bogus
                self._write_metadata(root, ref1, meta)
                with self.assertRaisesRegex(ValueError, "non-string supersession"):
                    resolve_detail(root, ref1)

    def test_deleting_the_edge_key_from_a_true_successor_fails_closed(self):
        root, ref1, ref2 = self._successor_chain()
        self.assertEqual(self._metadata(root, ref2)["supersedes_detail_ref"], ref1)
        self._delete_edge_key(root, ref2)
        with self.assertRaisesRegex(ValueError, "supersession edge disagrees"):
            resolve_detail(root, ref2)

        # The immutable original row stays the topology counter-witness: the
        # lawful mutation is refused with zero writes.
        before = (root / ".saipen" / "BOARD.md").read_bytes()
        refused = ticket_verify(root, "T-1315", "test-agent", "later mutation")
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), before)

    def test_a_wrong_but_valid_predecessor_fails_closed(self):
        root, _ref1, ref2 = self._successor_chain()
        # A third generation C supersedes B; point B at the VALID artifact C.
        self.assertTrue(
            ticket_verify(root, "T-1315", "test-agent", "third " + ("semantic " * 300)).ok
        )
        ref3 = _ticket(root)["fields"]["detail_ref"]
        meta2 = self._metadata(root, ref2)
        meta2["supersedes_detail_ref"] = ref3
        self._write_metadata(root, ref2, meta2)
        with self.assertRaisesRegex(ValueError, "supersession edge disagrees"):
            resolve_detail(root, ref2)

    def test_a_missing_real_predecessor_fails_closed(self):
        root, ref1, ref2 = self._successor_chain()
        (root / ref1).unlink()
        with self.assertRaises(ValueError):
            resolve_detail(root, ref2)

    def test_a_missing_predecessor_original_record_fails_closed(self):
        root, ref1, ref2 = self._successor_chain()
        (root / self._metadata(root, ref1)["original_record_path"]).unlink()
        with self.assertRaises(ValueError):
            resolve_detail(root, ref2)


class LogEventOversizeRecoveryTests(unittest.TestCase):
    """T-1326 P0: a lawful recovery verb must not self-deadlock on the LOG cap.

    RED precondition (asserted explicitly): the RAW canonical builder refuses a
    DEC of this size with `LOG_EVENT_OVERSIZE`. GREEN: the same DEC commits
    through the one lossless path, and its complete bytes remain reachable and
    hash/byte-count verifiable.
    """

    def _read(self, root: Path, name: str) -> str:
        return (root / ".saipen" / name).read_text(encoding="utf-8")

    def test_the_raw_builder_still_refuses_the_unbounded_dec(self):
        blocker = f"{_BRAKE} -- " + ("vendor certification evidence pending " * 90)
        message = f"reconcile protocol state; operator-authorized STATE.blocker clear: {blocker}"
        with self.assertRaisesRegex(ValueError, "LOG_EVENT_OVERSIZE"):
            build_event(1, "DEC", message, now="14.09.26 00:00", op_id="red")

    def test_a_three_kb_blocker_clears_losslessly(self):
        root = _braked_project()
        decision = f"{_DECISION}; reviewed by operator {('  audit ' * 60).strip()}"

        planned = reconcile_protocol_state(root, "tester", dry_run=True, resolve_blocker=decision)
        self.assertTrue(planned["ok"], planned)
        self.assertEqual(planned["code"], "REPAIR_REQUIRED", planned)
        self.assertTrue(any("log-detail" in path for path in planned["targets"]), planned)

        applied = reconcile_protocol_state(root, "tester", resolve_blocker=decision)
        self.assertTrue(applied["ok"], applied)
        self.assertEqual(applied["code"], "REPAIRED", applied)

        # The brake is gone and the decision is durable in the canonical DEC.
        self.assertIn("\nblocker: none\n", self._read(root, "STATE.md"))
        log = self._read(root, "LOG.md")
        self.assertIn("detail_ref: .saipen/recovery/log-detail/", log)

        artifacts = _detail_artifacts(root)
        self.assertEqual(len(artifacts), 1, artifacts)
        metadata = _verify_detail(root, artifacts[0])
        detail = (root / metadata["original_event_path"]).read_text(encoding="utf-8")
        # NOTHING was truncated: the operator's decision and the original
        # blocker both survive byte-for-byte inside the externalized event.
        self.assertIn(_DECISION, detail)
        self.assertIn(decision, detail)
        self.assertIn("vendor certification evidence pending", detail)
        self.assertEqual(detail.count("audit"), decision.count("audit"))
        # The compact live line stays under the cap.
        live = [line for line in log.splitlines() if "detail_ref:" in line]
        self.assertEqual(len(live), 1)
        self.assertLessEqual(len(live[0].encode("utf-8")), 1024)

    def test_the_retry_is_deterministic_and_idempotent(self):
        root = _braked_project()
        self.assertTrue(
            reconcile_protocol_state(root, "tester", resolve_blocker=_DECISION)["ok"]
        )
        log_after_first = self._read(root, "LOG.md")
        artifacts = _detail_artifacts(root)

        again = reconcile_protocol_state(root, "tester", resolve_blocker=_DECISION)
        self.assertEqual(again["code"], "CLEAN", again)
        self.assertEqual(self._read(root, "LOG.md"), log_after_first)
        self.assertEqual(_detail_artifacts(root), artifacts)

    def test_the_original_state_bytes_survive_as_recovery_evidence(self):
        root = _braked_project()
        original = (root / ".saipen" / "STATE.md").read_bytes()
        self.assertTrue(
            reconcile_protocol_state(root, "tester", resolve_blocker=_DECISION)["ok"]
        )
        evidence = sorted((root / ".saipen" / "recovery").rglob("*.STATE.md"))
        self.assertEqual(len(evidence), 1, evidence)
        self.assertEqual(evidence[0].read_bytes(), original)
        # The original blocker is intact in that preserved authority, so the
        # lossless claim is not merely about the LOG line.
        self.assertIn(b"vendor certification evidence pending", evidence[0].read_bytes())

    def test_legacy_adoption_reconcile_externalizes_in_the_same_commit(self):
        root = _recovery_legacy_project()
        adopted = _legacy_fleet(root, 200)
        decision = f"{_DECISION}; operator note {('legacy adoption approved ' * 20).strip()}"

        applied = reconcile_protocol_state(
            root, "tester", adopt_legacy=adopted, resolve_blocker=decision
        )
        self.assertTrue(applied["ok"], applied.get("detail"))
        self.assertEqual(applied["code"], "REPAIRED", applied)
        self.assertEqual(adopted, tuple(applied["adopted"]))

        log = self._read(root, "LOG.md")
        artifacts = _detail_artifacts(root)
        self.assertTrue(artifacts, "the oversized reconcile DEC was not externalized")
        for artifact in artifacts:
            metadata = _verify_detail(root, artifact)
            # The compact live line cites the metadata path, and the metadata
            # resolves to the full event -- both from the SAME commit.
            self.assertIn(f"detail_ref: {metadata['metadata_path']}", log)
            self.assertTrue((root / metadata["original_event_path"]).is_file())
        detail = "".join(
            (root / _verify_detail(root, artifact)["original_event_path"]).read_text(
                encoding="utf-8"
            )
            for artifact in artifacts
        )
        for ticket in adopted:
            self.assertIn(ticket, detail)
        # The preserved authority is the COMPLETE oversized event, not a
        # bounded summary of it.
        self.assertGreater(len(detail.encode("utf-8")), 1024)

    def test_a_checkpoint_without_a_project_root_cannot_produce_a_raw_event(self):
        """Lossless construction is not an optional caller convention."""
        from saipen_engine.operations import _event_line

        with self.assertRaisesRegex(ValueError, "canonical project root"):
            _event_line({"log": None}, 1, "DEC", None, "tester", "text", "14.09.26 00:00")


class CanonicalLogProducerTests(unittest.TestCase):
    """T-1326 P0 audit: no canonical LOG producer may bypass the bounded builder.

    Every producer falls into exactly one class:

    * PROVABLY BOUNDED -- a literal or an integer interpolation. The shared
      bounded builder emits the identical single line and, because such a
      message cannot cross the cap, registers no detail artifacts at all.
    * VARIABLE-LENGTH -- a release note, a remote endpoint, caller-supplied
      trace/RUN/WAIT payload. These MUST externalize losslessly, because the
      capped builder raises LOG_EVENT_OVERSIZE and the verb that produced the
      event would crash on its own DEC.

    The engine now has exactly ONE producer entry: `log.prepare_bounded_event`
    (with `operations._event_line`/`_producer_event` delegating to it). This
    suite enforces that structurally instead of trusting review vigilance, so a
    new producer cannot silently reintroduce the self-deadlock.
    """

    #: The capped builder's definition, and its ONE legitimate caller (the
    #: lossless externalizer that replaces the raise with detail artifacts).
    ALLOWED: ClassVar[set[str]] = {"log.py", "log_compaction.py"}

    def test_no_engine_module_calls_the_capped_builder_directly(self):
        offenders = []
        for path in sorted((TOOLS / "saipen_engine").glob("*.py")):
            if path.name in self.ALLOWED:
                continue
            for number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), 1
            ):
                if "build_event" in line.split("#", 1)[0]:
                    offenders.append(f"{path.name}:{number}: {line.strip()}")
        self.assertEqual(
            offenders,
            [],
            "canonical LOG producers must use log.prepare_bounded_event:",
        )

    def _project(self) -> Path:
        root = fresh_project(
            phase="BUILD", task="T-1315", next_action="PHASE BUILD T-1315", agent="test-agent"
        )
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        return root

    def test_a_variable_length_producer_event_is_externalized_losslessly(self):
        """A release-note RUN event above the cap keeps every byte."""
        from saipen_engine.log import prepare_bounded_event

        root = self._project()
        message = "release note " + ("SC-11 detail " * 200)
        event, line, targets = prepare_bounded_event(
            root,
            7,
            "RUN",
            message,
            ticket="T-1315",
            agent="test-agent",
            now="14.09.26 08:00",
            op_id="op-release-run",
        )
        self.assertEqual(event, 8)
        self.assertLessEqual(len(line.encode("utf-8")), 1024)
        self.assertTrue(targets, "an oversized event must externalize its bytes")
        detail = [plan for plan in targets if plan.path.endswith(".LOG.md")]
        metadata = [plan for plan in targets if plan.path.endswith(".json")]
        self.assertEqual(len(detail), 1, [plan.path for plan in targets])
        self.assertEqual(len(metadata), 1, [plan.path for plan in targets])
        # The preserved authority is the COMPLETE event, with its own newline,
        # and its hash/byte-count are the metadata's own claim.
        full = detail[0].content
        self.assertIn(message.encode("utf-8"), full)
        self.assertGreater(len(full), 1024)
        record = json.loads(metadata[0].content.decode("utf-8"))
        self.assertEqual(record["original_event_bytes"], len(full))
        self.assertEqual(record["original_event_sha256"], hashlib.sha256(full).hexdigest())
        self.assertIs(record["lossless"], True)
        self.assertIn(f"detail_ref: {record['metadata_path']}", line)
        # A provably bounded message still produces the plain single line.
        _event, plain, plain_targets = prepare_bounded_event(
            root,
            8,
            "DEC",
            "goal_tickets 1->2",
            ticket=None,
            agent="test-agent",
            now="14.09.26 08:01",
            op_id="op-goal",
        )
        self.assertEqual(plain_targets, ())
        self.assertIn("DEC: goal_tickets 1->2", plain)

    def test_sub_trace_text_is_bounded_and_lossless(self):
        """A hostile/large subSaipen trace payload cannot refuse the verb."""
        from saipen_engine import subs

        root = self._project()
        message = "resumed " + ("x" * 2000)
        targets = subs._sub_trace_targets(root, "alpha", "resume", message, b"")
        live_path = f"{subs.SUBS_REL}/alpha/LOG.md"
        log_target = next(item for item in targets if item["path"] == live_path)
        detail_targets = [item for item in targets if item["path"] != live_path]
        self.assertTrue(detail_targets, targets)
        detail = b"".join(item["content"] for item in detail_targets)
        self.assertIn(message.encode("utf-8"), detail)
        live = log_target["content"].decode("utf-8")
        for line in live.splitlines():
            self.assertLessEqual(len(line.encode("utf-8")), 1024, line)
        self.assertIn("detail_ref:", live)
        self.assertNotIn("x" * 2000, live)


if __name__ == "__main__":
    unittest.main(verbosity=2)
