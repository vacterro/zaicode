"""Audit Inbox regressions (T-1227, SOURCE-AUDIT-INBOX-01).

The acceptance bar of `audit/3.md`: discovery is exact and hostile-safe,
routing sits AFTER active continuation and BEFORE the ordinary Pick Rule,
capture reuses the existing Source lifecycle, and deletion happens only when
closure is PROVEN and the bytes on disk are still the bytes that were closed.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine import audit_inbox, intake  # noqa: E402
from saipen_engine.router import route_next  # noqa: E402

CLI = ROOT / "tools" / "saipen.py"
SCENARIO = ROOT / "tests" / "scenarios" / "userperson-valid" / ".saipen"

STATE_DONE = SCENARIO.joinpath("STATE.md").read_text(encoding="utf-8")
BOARD_EMPTY = "# Board\n## DOING\n## TODO\n## DONE\n## BLOCKED\n"

def _live_claim_time() -> str:
    """A claim_time inside CORE section 1.4's liveness window, fixed at import."""
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# A LIVE active ticket, spelled the way section 1.4 spells one: an owner AND a
# fresh claim_time, owned by the identity these routing probes run as. The
# earlier fixture wrote a bare `- [/] T-400` and called it live. It was not: an
# unclaimed DOING ticket is an ADOPTABLE orphan, and routing it to a phase
# continuation advertises a mutation the authorization gate refuses until an
# explicit `claim` happens (CORE-002). These tests are about audit-inbox
# precedence, so their "live ticket" has to actually be one.
BOARD_LIVE = (
    "# Board\n## DOING\n"
    "- [/] T-400 [P1] live | verify: proof | owner: probe | "
    "claim_time: " + _live_claim_time() + "\n"
    "## TODO\n## DONE\n## BLOCKED\n"
)


def _state(
    phase: str = "DONE",
    task: str = "none",
    next_action: str = "saipen continue",
    transition_from: str = "SHIP",
) -> str:
    return (
        "---\n"
        f"phase: {phase}\n"
        f"task: {task}\n"
        f'next_action: "{next_action}"\n'
        "blocker: none\n"
        f"transition_from: {transition_from}\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        "last_event: 1\n"
        "style_contract: ded-4ae736e4\n"
        "agent: probe\n"
        "mode: full\n"
        "updated: 2026-08-31T00:00:00Z\n"
        "---\n"
    )


class AuditInboxFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-audit-inbox-")
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

    # helpers -------------------------------------------------------------

    def layer(self, number: int, body: bytes | str = b"# audit\n\nfindings\n") -> Path:
        path = self.root / "audit" / f"{number}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body.encode("utf-8") if isinstance(body, str) else body)
        return path

    def board_with(self, line: str) -> None:
        board = self.root / ".saipen" / "BOARD.md"
        text = board.read_text(encoding="utf-8")
        board.write_text(text.replace("## DONE\n", f"## DONE\n{line}\n"), encoding="utf-8")

    def close_source(self, receipt: str, work: str | None = None) -> None:
        """Drive one receipt to a PROVEN closure through the real contract."""
        self.assertTrue(
            intake.add_requirement(self.root, receipt, rid="R001", text="do the thing")["ok"]
        )
        self.assertTrue(
            intake.set_disposition(
                self.root,
                receipt,
                "R001",
                "VERIFIED",
                evidence="E-001",
                verification="unittest:PASS",
            )["ok"]
        )
        closed = intake.close_receipt(self.root, receipt)
        self.assertTrue(closed["ok"], closed)
        if work:
            self.assertEqual(intake.status(self.root, receipt)["linked_work"], work)

    def bind_closed(self, number: int, body: str) -> dict:
        self.layer(number, body)
        rel = f"audit/{number}.md"
        captured = audit_inbox.capture_layer(self.root, rel)
        self.close_source(captured["receipt"])
        audit_inbox.bind_layer(
            self.root,
            rel,
            layer=number,
            generation=1,
            file_sha256=captured["file_sha256"],
            size_bytes=len(body.encode("utf-8")),
            receipt_id=captured["receipt"],
            receipt_sha256=captured["file_sha256"],
            binding="exact",
            linked_work=None,
            state=audit_inbox.CLOSED_PENDING_DELETE,
        )
        return captured



# ---------------------------------------------------------------------------
# DISCOVERY
# ---------------------------------------------------------------------------


class DiscoveryTests(AuditInboxFixture):
    def test_absent_audit_directory_is_a_normal_no_op(self) -> None:
        self.assertEqual(audit_inbox.scan_layers(self.root), [])
        self.assertIsNone(audit_inbox.projection(self.root))

    def test_empty_audit_directory_is_a_normal_no_op(self) -> None:
        (self.root / "audit").mkdir()
        self.assertEqual(audit_inbox.scan_layers(self.root), [])
        self.assertIsNone(audit_inbox.projection(self.root))

    def test_single_layer_is_discovered(self) -> None:
        self.layer(1)
        self.assertEqual(
            [item["rel"] for item in audit_inbox.scan_layers(self.root)], ["audit/1.md"]
        )

    def test_layers_sort_numerically_not_lexically(self) -> None:
        for number in (10, 2, 1):
            self.layer(number)
        self.assertEqual(
            [item["layer"] for item in audit_inbox.scan_layers(self.root)], [1, 2, 10]
        )

    def test_gaps_are_normal(self) -> None:
        self.layer(1)
        self.layer(7)
        self.assertEqual([item["layer"] for item in audit_inbox.scan_layers(self.root)], [1, 7])

    def test_noncanonical_names_are_not_layers(self) -> None:
        for name in ("01.md", "notes.md", "a.md", "1.txt", "0.md", "README.md"):
            path = self.root / "audit" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("not a layer", encoding="utf-8")
        self.assertEqual(audit_inbox.scan_layers(self.root), [])

    def test_nested_files_are_never_scanned(self) -> None:
        nested = self.root / "audit" / "done" / "1.md"
        nested.parent.mkdir(parents=True)
        nested.write_text("nested", encoding="utf-8")
        self.assertEqual(audit_inbox.scan_layers(self.root), [])

    def test_traversal_cannot_escape_the_project(self) -> None:
        refused = audit_inbox.snapshot_layer(self.root, "audit/../../1.md")
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["code"], "AUDIT_LAYER_INVALID")

    def test_absolute_layer_path_is_refused(self) -> None:
        refused = audit_inbox.snapshot_layer(self.root, str(self.root / "audit" / "1.md"))
        self.assertFalse(refused["ok"])

    def test_symlinked_layer_is_refused_and_never_captured(self) -> None:
        target = self.root / "outside.md"
        target.write_text("# outside\n", encoding="utf-8")
        link = self.root / "audit" / "1.md"
        link.parent.mkdir(parents=True, exist_ok=True)
        try:
            link.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation not permitted on this host")
        snap = audit_inbox.snapshot_layer(self.root, "audit/1.md")
        self.assertFalse(snap["ok"])
        self.assertEqual(snap["reason"], "unsafe-node")
        self.assertTrue(link.exists())

    def test_invalid_utf8_is_never_captured_and_never_deleted(self) -> None:
        path = self.layer(1, b"\xff\xfe not utf-8")
        snap = audit_inbox.snapshot_layer(self.root, "audit/1.md")
        self.assertFalse(snap["ok"])
        self.assertEqual(snap["reason"], "not-utf8")
        classified = audit_inbox.classify(self.root)["layers"][0]
        self.assertEqual(classified["state"], audit_inbox.INVALID)
        gate = audit_inbox.delete_gate(self.root, "audit/1.md")
        self.assertFalse(gate["ok"])
        self.assertTrue(path.is_file())

    def test_oversized_layer_is_never_captured(self) -> None:
        self.layer(1, b"x" * 4096)
        with patch.object(audit_inbox, "MAX_LAYER_BYTES", 16):
            snap = audit_inbox.snapshot_layer(self.root, "audit/1.md")
        self.assertFalse(snap["ok"])
        self.assertEqual(snap["reason"], "oversize")

    def test_empty_layer_is_invalid_not_an_empty_capture(self) -> None:
        self.layer(1, b"")
        snap = audit_inbox.snapshot_layer(self.root, "audit/1.md")
        self.assertFalse(snap["ok"])
        self.assertEqual(snap["reason"], "empty")

    def test_generation_identity_is_content_not_mtime(self) -> None:
        path = self.layer(1, "same bytes\n")
        first = audit_inbox.snapshot_layer(self.root, "audit/1.md")["sha256"]
        os.utime(path, (0, 0))
        self.assertEqual(audit_inbox.snapshot_layer(self.root, "audit/1.md")["sha256"], first)
        path.write_text("different bytes\n", encoding="utf-8")
        self.assertNotEqual(audit_inbox.snapshot_layer(self.root, "audit/1.md")["sha256"], first)


# ---------------------------------------------------------------------------
# CONTINUE ROUTING
# ---------------------------------------------------------------------------


class RoutingTests(unittest.TestCase):
    INBOX: ClassVar[dict] = {
        "action": "saipen audit ingest",
        "layer": 2,
        "path": "audit/2.md",
        "detail": "audit/2.md is an unconsumed audit generation",
    }

    def test_recovery_outranks_the_audit_inbox(self) -> None:
        routed = route_next(
            _state(), BOARD_EMPTY, pending_ops=["op-x"], audit_inbox=self.INBOX
        )
        self.assertEqual(routed["reason"], "recovery-pending")

    def test_recovery_conflict_outranks_the_audit_inbox(self) -> None:
        routed = route_next(
            _state(), BOARD_EMPTY, conflict_ops=["op-c"], audit_inbox=self.INBOX
        )
        self.assertEqual(routed["reason"], "recovery-conflict")

    def test_active_build_work_is_never_preempted_by_a_new_audit(self) -> None:
        board = BOARD_LIVE
        routed = route_next(
            _state(
                phase="BUILD",
                task="T-400",
                next_action="PHASE BUILD T-400",
                transition_from="SCOUT",
            ),
            board,
            audit_inbox=self.INBOX,
        )
        self.assertEqual(routed["reason"], "finish")
        self.assertEqual(routed["ticket"], "T-400")

    def test_active_verify_continuation_is_never_preempted(self) -> None:
        board = BOARD_LIVE
        routed = route_next(
            _state(
                phase="VERIFY",
                task="T-400",
                next_action="PHASE VERIFY T-400",
                transition_from="BUILD",
            ),
            board,
            audit_inbox=self.INBOX,
        )
        self.assertEqual(routed["reason"], "finish")

    def test_a_workable_audit_outranks_ordinary_queued_todo(self) -> None:
        board = "# Board\n## DOING\n## TODO\n- [ ] T-500 [P1] stale backlog | verify: proof\n## DONE\n## BLOCKED\n"  # noqa: E501
        routed = route_next(_state(), board, audit_inbox=self.INBOX)
        self.assertEqual(routed["reason"], "audit-inbox")
        self.assertEqual(routed["action"], "saipen audit ingest")
        self.assertEqual(routed["audit_layer"], 2)

    def test_captured_audit_work_owns_continuation_by_ticket(self) -> None:
        board = "# Board\n## DOING\n## TODO\n- [ ] T-500 [P1] stale | verify: proof\n- [ ] T-900 [P1] audit work | verify: proof\n## DONE\n## BLOCKED\n"  # noqa: E501
        routed = route_next(
            _state(),
            board,
            audit_inbox={"action": "PHASE SCOUT T-900", "layer": 2, "path": "audit/2.md", "work": "T-900"},  # noqa: E501
        )
        self.assertEqual(routed["reason"], "audit-inbox")
        self.assertEqual(routed["ticket"], "T-900")
        self.assertEqual(routed["load"], "saipen/phases/scout.md")

    def test_an_audit_whose_work_is_blocked_falls_through_to_the_pick_rule(self) -> None:
        board = (
            "# Board\n## DOING\n## TODO\n- [ ] T-500 [P1] backlog | verify: proof\n"
            "## DONE\n## BLOCKED\n- [ ] T-900 [P1] audit work | verify: proof "
            "| blocker: SOURCE_UNRESOLVED\n"
        )
        routed = route_next(
            _state(),
            board,
            audit_inbox={
                "action": "PHASE SCOUT T-900",
                "layer": 2,
                "path": "audit/2.md",
                "work": "T-900",
            },
        )
        self.assertEqual(routed["reason"], "start")
        self.assertEqual(routed["ticket"], "T-500")

    def test_a_workable_audit_prevents_the_idle_maintain_verdict(self) -> None:
        routed = route_next(_state(), BOARD_EMPTY, audit_inbox=self.INBOX)
        self.assertNotEqual(routed["reason"], "maintain")
        self.assertNotEqual(routed["action"], "saipen continue")

    def test_no_audit_leaves_the_ordinary_pick_rule_unchanged(self) -> None:
        board = "# Board\n## DOING\n## TODO\n- [ ] T-500 [P1] backlog | verify: proof\n## DONE\n## BLOCKED\n"  # noqa: E501
        self.assertEqual(
            route_next(_state(), board, audit_inbox=None),
            route_next(_state(), board),
        )
        self.assertEqual(route_next(_state(), board)["reason"], "start")

    def test_no_audit_and_no_work_still_reaches_the_idle_maintain_route(self) -> None:
        routed = route_next(_state(), BOARD_EMPTY, audit_inbox=None)
        self.assertEqual(routed["reason"], "maintain")
        self.assertEqual(routed["action"], "saipen continue")

    def test_an_invalid_only_inbox_is_surfaced_instead_of_idle(self) -> None:
        routed = route_next(
            _state(),
            BOARD_EMPTY,
            audit_inbox={
                "action": "saipen audit status",
                "invalid_only": True,
                "detail": "audit inbox holds only invalid layer(s); it is not idle",
            },
        )
        self.assertEqual(routed["reason"], "audit-inbox-invalid")
        self.assertEqual(routed["executable_behavior"], "RESTATE_AND_STOP")

    def test_an_invalid_only_inbox_never_outranks_real_workable_board_work(self) -> None:
        board = "# Board\n## DOING\n## TODO\n- [ ] T-500 [P1] backlog | verify: proof\n## DONE\n## BLOCKED\n"  # noqa: E501
        routed = route_next(
            _state(), board, audit_inbox={"action": "saipen audit status", "invalid_only": True}
        )
        self.assertEqual(routed["reason"], "start")

    def test_a_residue_only_inbox_is_surfaced_instead_of_idle(self) -> None:
        routed = route_next(
            _state(),
            BOARD_EMPTY,
            audit_inbox={
                "action": "saipen audit status",
                "residue_only": True,
                "detail": "audit/ is settled but not clean: 1 non-layer entry",
            },
        )
        self.assertEqual(routed["reason"], "audit-inbox-residue")
        self.assertEqual(routed["executable_behavior"], "RESTATE_AND_STOP")
        self.assertTrue(routed["ok"], "residue is a diagnostic, never a failure")

    def test_a_residue_only_inbox_never_outranks_real_workable_board_work(self) -> None:
        board = "# Board\n## DOING\n## TODO\n- [ ] T-500 [P1] backlog | verify: proof\n## DONE\n## BLOCKED\n"  # noqa: E501
        routed = route_next(
            _state(), board, audit_inbox={"action": "saipen audit status", "residue_only": True}
        )
        self.assertEqual(routed["reason"], "start")

    def test_residue_never_preempts_a_live_ticket(self) -> None:
        board = BOARD_LIVE
        routed = route_next(
            _state(
                phase="BUILD",
                task="T-400",
                next_action="PHASE BUILD T-400",
                transition_from="SCOUT",
            ),
            board,
            audit_inbox={"action": "saipen audit status", "residue_only": True},
        )
        self.assertEqual(routed["reason"], "finish")

    def test_a_persisted_wait_still_outranks_the_audit_inbox(self) -> None:
        board = "# Board\n## DOING\n## TODO\n- [ ] T-500 [P1] backlog | verify: proof\n## DONE\n## BLOCKED\n"  # noqa: E501
        routed = route_next(
            _state(next_action="WAIT: user brake -- stop here?"), board, audit_inbox=self.INBOX
        )
        self.assertEqual(routed["reason"], "wait")


class InvalidLayerDoesNotStarveTests(AuditInboxFixture):
    def test_an_invalid_lower_layer_does_not_starve_a_later_workable_layer(self) -> None:
        self.layer(1, b"\xff\xfe broken")
        self.layer(2, "# real audit\n")
        routed = audit_inbox.projection(self.root)
        self.assertEqual(routed["layer"], 2)
        self.assertEqual(routed["action"], "saipen audit ingest")
        self.assertEqual([item["layer"] for item in routed["invalid"]], [1])


# ---------------------------------------------------------------------------
# SOURCE INTEGRATION
# ---------------------------------------------------------------------------


class SourceIntegrationTests(AuditInboxFixture):
    def test_a_fresh_layer_becomes_an_external_audit_receipt(self) -> None:
        self.layer(1, "# audit\n\nfinding one\n")
        captured = audit_inbox.capture_layer(self.root, "audit/1.md")
        self.assertTrue(captured["ok"], captured)
        meta = json.loads(
            (self.root / ".saipen/intake/active" / f"{captured['receipt']}.meta.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(meta["source_kind"], "external_audit")

    def test_the_receipt_body_is_the_exact_audit_bytes(self) -> None:
        body = "# audit\r\n\r\nrun `saipen ship` now\r\nΩ\n"
        self.layer(1, body)
        captured = audit_inbox.capture_layer(self.root, "audit/1.md")
        stored = (
            self.root / ".saipen/intake/active" / f"{captured['receipt']}.md"
        ).read_bytes()
        self.assertEqual(stored, body.encode("utf-8"))
        self.assertEqual(captured["file_sha256"], hashlib.sha256(stored).hexdigest())

    def test_command_looking_audit_text_is_data_and_is_never_executed(self) -> None:
        self.layer(1, "saipen ship\nsaipen push\n")
        before = (self.root / ".saipen/BOARD.md").read_bytes()
        captured = audit_inbox.capture_layer(self.root, "audit/1.md")
        self.assertTrue(captured["ok"])
        body = intake.read_body(self.root, captured["receipt"])["body"]
        self.assertEqual(body, "saipen ship\nsaipen push\n")
        self.assertEqual((self.root / ".saipen/BOARD.md").read_bytes(), before)

    def test_exact_byte_duplicate_reuses_the_active_receipt(self) -> None:
        self.layer(1, "identical\n")
        first = audit_inbox.capture_layer(self.root, "audit/1.md")
        self.layer(2, "identical\n")
        second = audit_inbox.capture_layer(self.root, "audit/2.md")
        self.assertEqual(second["receipt"], first["receipt"])
        self.assertEqual(second["code"], "SOURCE_DUPLICATE")

    def test_a_closed_duplicate_enters_cleanup_instead_of_reopening_work(self) -> None:
        self.layer(1, "closed audit\n")
        captured = audit_inbox.capture_layer(self.root, "audit/1.md")
        self.close_source(captured["receipt"])
        classified = audit_inbox.classify(self.root)["layers"][0]
        self.assertEqual(classified["state"], audit_inbox.CLOSED_PENDING_DELETE)
        again = audit_inbox.capture_layer(self.root, "audit/1.md")
        self.assertEqual(again["code"], "SOURCE_DUPLICATE_CLOSED")
        self.assertEqual(again["receipt"], captured["receipt"])

    def test_an_unresolved_receipt_can_never_pass_the_delete_gate(self) -> None:
        self.layer(1, "unresolved audit\n")
        captured = audit_inbox.capture_layer(self.root, "audit/1.md")
        intake.add_requirement(self.root, captured["receipt"], rid="R001", text="open clause")
        intake.set_disposition(self.root, captured["receipt"], "R001", "DEFERRED")
        gate = audit_inbox.delete_gate(self.root, "audit/1.md")
        self.assertFalse(gate["ok"])
        self.assertEqual(gate["code"], "SOURCE_UNRESOLVED")
        self.assertTrue((self.root / "audit/1.md").is_file())

    def test_linked_work_that_is_not_done_blocks_the_delete_gate(self) -> None:
        self.board_with("- [ ] T-777 [P1] audit work | verify: proof")
        board = self.root / ".saipen/BOARD.md"
        board.write_text(
            board.read_text(encoding="utf-8").replace(
                "## DONE\n- [ ] T-777 [P1] audit work | verify: proof\n",
                "## TODO\n- [ ] T-777 [P1] audit work | verify: proof\n## DONE\n",
            ),
            encoding="utf-8",
        )
        self.layer(1, "work-linked audit\n")
        captured = audit_inbox.capture_layer(self.root, "audit/1.md")
        audit_inbox.bind_layer(
            self.root,
            "audit/1.md",
            layer=1,
            generation=1,
            file_sha256=captured["file_sha256"],
            size_bytes=1,
            receipt_id=captured["receipt"],
            receipt_sha256=captured["file_sha256"],
            binding="exact",
            linked_work="T-777",
            state=audit_inbox.ACTIVE,
        )
        gate = audit_inbox.delete_gate(self.root, "audit/1.md")
        self.assertFalse(gate["ok"])
        self.assertEqual(gate["code"], "SOURCE_UNRESOLVED")


# ---------------------------------------------------------------------------
# MIGRATION: EOL-ONLY TRANSPORT EQUIVALENCE
# ---------------------------------------------------------------------------


class MigrationEquivalenceTests(AuditInboxFixture):
    def test_crlf_layer_binds_to_an_otherwise_identical_lf_receipt(self) -> None:
        lf = "# audit\nline one\nline two\n"
        existing = intake.capture(self.root, lf, source_kind="implementation_mission")
        self.layer(1, lf.replace("\n", "\r\n"))
        bound = audit_inbox.capture_layer(self.root, "audit/1.md")
        self.assertEqual(bound["code"], "SOURCE_LEGACY_TRANSPORT_EQUIVALENT")
        self.assertEqual(bound["receipt"], existing["receipt"])

    def test_both_digests_are_recorded_and_the_receipt_digest_is_never_rewritten(self) -> None:
        lf = "# audit\nline one\n"
        existing = intake.capture(self.root, lf, source_kind="implementation_mission")
        self.layer(1, lf.replace("\n", "\r\n"))
        bound = audit_inbox.capture_layer(self.root, "audit/1.md")
        self.assertNotEqual(bound["file_sha256"], bound["source_sha256"])
        self.assertEqual(bound["source_sha256"], existing["source_sha256"])
        record = audit_inbox.bind_layer(
            self.root,
            "audit/1.md",
            layer=1,
            generation=1,
            file_sha256=bound["file_sha256"],
            size_bytes=len(lf) + 1,
            receipt_id=bound["receipt"],
            receipt_sha256=bound["source_sha256"],
            binding=bound["binding"],
            linked_work=None,
            state=audit_inbox.ACTIVE,
        )
        self.assertEqual(record["binding"], "legacy_transport_equivalent")
        self.assertEqual(
            intake.status(self.root, existing["receipt"])["source_sha256"],
            existing["source_sha256"],
        )

    def test_any_difference_beyond_cr_lf_creates_a_new_source(self) -> None:
        intake.capture(self.root, "# audit\nline one\n", source_kind="implementation_mission")
        self.layer(1, "# audit\r\nline  one\r\n")  # two spaces: NOT an EOL difference
        captured = audit_inbox.capture_layer(self.root, "audit/1.md")
        self.assertEqual(captured["code"], "SOURCE_RECEIVED")

    def test_two_eol_equivalent_candidates_refuse_to_guess(self) -> None:
        intake.capture(self.root, "# audit\nline\n", source_kind="implementation_mission")
        intake.capture(self.root, "# audit\r\nline\r\n", source_kind="user_audit")
        self.layer(1, "# audit\rline\r")
        self.assertIsNone(audit_inbox.eol_equivalent_receipt(self.root, "# audit\rline\r"))

    def test_equivalence_never_generalizes_past_line_endings(self) -> None:
        self.assertFalse(audit_inbox._eol_only_difference("a b\n", "a  b\n"))
        self.assertFalse(audit_inbox._eol_only_difference("A\n", "a\n"))
        self.assertFalse(audit_inbox._eol_only_difference("x\n", "x \n"))
        self.assertTrue(audit_inbox._eol_only_difference("x\r\ny\r\n", "x\ny\n"))


# ---------------------------------------------------------------------------
# SAFE DELETE
# ---------------------------------------------------------------------------


class SafeDeleteTests(AuditInboxFixture):
    def test_a_closed_unchanged_layer_is_deleted_and_nothing_else_is(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        self.layer(1, "still open one\n")
        self.layer(5, "still open five\n")
        keep = self.root / "audit" / "notes.md"
        keep.write_text("foreign", encoding="utf-8")
        out = audit_inbox.consume_layer(self.root, "audit/2.md", "probe")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["code"], "AUDIT_CONSUMED")
        self.assertFalse((self.root / "audit/2.md").exists())
        self.assertTrue((self.root / "audit/1.md").is_file())
        self.assertTrue((self.root / "audit/5.md").is_file())
        self.assertTrue(keep.is_file())

    def test_remaining_layers_are_never_renumbered(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        self.layer(1, "one\n")
        self.layer(5, "five\n")
        audit_inbox.consume_layer(self.root, "audit/2.md", "probe")
        self.assertEqual(
            [item["layer"] for item in audit_inbox.scan_layers(self.root)], [1, 5]
        )

    def test_changed_bytes_are_never_deleted_as_cleanup_for_the_old_generation(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        (self.root / "audit/2.md").write_text("A COMPLETELY NEW AUDIT\n", encoding="utf-8")
        out = audit_inbox.consume_layer(self.root, "audit/2.md", "probe")
        self.assertFalse(out["ok"])
        self.assertEqual(out["code"], "AUDIT_GENERATION_CHANGED")
        self.assertTrue((self.root / "audit/2.md").is_file())

    def test_a_changed_same_path_file_becomes_a_new_workable_generation(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        (self.root / "audit/2.md").write_text("A COMPLETELY NEW AUDIT\n", encoding="utf-8")
        item = audit_inbox.classify(self.root)["layers"][0]
        self.assertEqual(item["state"], audit_inbox.NEW)
        self.assertEqual(item["generation"], 2)
        self.assertEqual(audit_inbox.projection(self.root)["action"], "saipen audit ingest")

    def test_a_layer_absent_before_cleanup_settles_idempotently(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        (self.root / "audit/2.md").unlink()
        out = audit_inbox.consume_layer(self.root, "audit/2.md", "probe")
        self.assertTrue(out["ok"], out)
        self.assertTrue(out["already_absent"])

    def test_repeated_cleanup_after_a_successful_delete_is_idempotent(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        first = audit_inbox.consume_layer(self.root, "audit/2.md", "probe")
        self.assertTrue(first["ok"])
        second = audit_inbox.consume_layer(self.root, "audit/2.md", "probe")
        self.assertTrue(second["ok"], second)
        self.assertIsNone(audit_inbox.projection(self.root))

    def test_the_delete_is_journaled_before_the_destructive_effect(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        plan = audit_inbox.consume_layer(self.root, "audit/2.md", "probe", dry_run=True)
        self.assertEqual(plan["code"], "AUDIT_CONSUME_PLAN")
        self.assertIn("audit/2.md", plan["targets"])
        self.assertTrue((self.root / "audit/2.md").is_file())
        out = audit_inbox.consume_layer(self.root, "audit/2.md", "probe")
        self.assertTrue(out["ok"], out)
        settled = list((self.root / ".saipen/recovery/settled").glob("audit-consume-*"))
        self.assertTrue(settled, "the consume operation left no journal evidence")
        record = json.loads((settled[0] / "operation.json").read_text(encoding="utf-8"))
        self.assertEqual(record["operation"], "audit_inbox.consume")
        self.assertEqual(record["status"], "COMMITTED")

    def test_closure_evidence_survives_the_deleted_transport_file(self) -> None:
        captured = self.bind_closed(2, "closed audit two\n")
        audit_inbox.consume_layer(self.root, "audit/2.md", "probe")
        tomb = intake.status(self.root, captured["receipt"])
        self.assertEqual(tomb["status"], "CLOSED")
        log = (self.root / ".saipen/LOG.md").read_text(encoding="utf-8")
        self.assertIn("AUDIT_INBOX_CLOSED audit/2.md", log)
        self.assertIn(captured["receipt"], log)

    def test_a_missing_transport_after_capture_never_loses_the_work(self) -> None:
        self.layer(2, "captured then vanished\n")
        captured = audit_inbox.capture_layer(self.root, "audit/2.md")
        audit_inbox.bind_layer(
            self.root,
            "audit/2.md",
            layer=2,
            generation=1,
            file_sha256=captured["file_sha256"],
            size_bytes=1,
            receipt_id=captured["receipt"],
            receipt_sha256=captured["file_sha256"],
            binding="exact",
            linked_work=None,
            state=audit_inbox.ACTIVE,
        )
        (self.root / "audit/2.md").unlink()
        state = audit_inbox.classify(self.root)
        self.assertEqual(state["layers"], [])
        self.assertEqual(state["orphans"][0]["state"], audit_inbox.MISSING_AFTER_CAPTURE)
        self.assertEqual(
            intake.status(self.root, captured["receipt"])["status"], "ACTIVE"
        )


# ---------------------------------------------------------------------------
# READ-ONLY SURFACES
# ---------------------------------------------------------------------------


class ReadOnlySurfaceTests(AuditInboxFixture):
    def project_digest(self) -> str:
        digest = hashlib.sha256()
        for path in sorted(self.root.rglob("*")):
            if path.is_file():
                digest.update(path.relative_to(self.root).as_posix().encode("utf-8"))
                digest.update(path.read_bytes())
        return digest.hexdigest()

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(CLI), *args, "--json"],
            cwd=self.root,
            capture_output=True,
            text=True,
        )

    def test_status_projection_writes_nothing(self) -> None:
        self.layer(1, "# audit\n")
        before = self.project_digest()
        out = audit_inbox.status(self.root)
        self.assertEqual(out["code"], "AUDIT_INBOX_STATUS")
        self.assertEqual(self.project_digest(), before)

    def test_status_never_dumps_the_audit_body(self) -> None:
        self.layer(1, "SECRET-AUDIT-PROSE-MARKER\n")
        self.assertNotIn("SECRET-AUDIT-PROSE-MARKER", json.dumps(audit_inbox.status(self.root)))

    def test_projection_writes_nothing(self) -> None:
        self.layer(1, "# audit\n")
        before = self.project_digest()
        self.assertIsNotNone(audit_inbox.projection(self.root))
        self.assertEqual(self.project_digest(), before)

    def test_cli_next_projects_the_audit_carrier_without_mutating(self) -> None:
        self.layer(1, "# audit\n")
        before = self.project_digest()
        proc = self.run_cli("next")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["reason"], "audit-inbox")
        self.assertEqual(payload["action"], "saipen audit ingest")
        self.assertEqual(self.project_digest(), before)

    def test_cli_audit_ingest_dry_run_writes_and_deletes_nothing(self) -> None:
        self.layer(1, "# audit\n")
        before = self.project_digest()
        proc = self.run_cli("audit", "ingest", "--dry-run")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["code"], "DRY_RUN_PLAN")
        self.assertEqual(payload["path"], "audit/1.md")
        self.assertEqual(self.project_digest(), before)
        self.assertTrue((self.root / "audit/1.md").is_file())


# ---------------------------------------------------------------------------
# CORRUPT BINDING (SRC-019:R6)
# ---------------------------------------------------------------------------


class CorruptBindingTests(AuditInboxFixture):
    """A binding that exists and cannot be decoded is not an empty inbox.

    Every read mapped FileNotFoundError, an unreadable file, invalid UTF-8,
    invalid JSON, a wrong root shape and a wrong record shape to the SAME
    synthetic empty document, so the next write laundered corrupt authority
    into a healthy-looking binding holding only the new record.
    """

    def binding(self) -> Path:
        path = self.root / ".saipen" / "intake" / "audit_inbox.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def corrupt(self, raw: bytes = b"{broken") -> bytes:
        path = self.binding()
        path.write_bytes(raw)
        return raw

    def test_an_undecodable_binding_is_reported_not_read_as_empty(self) -> None:
        self.layer(1, "# audit\n")
        self.corrupt()
        state = audit_inbox.classify(self.root)
        self.assertFalse(state["ok"], state)
        self.assertEqual(state["code"], "AUDIT_BINDING_CORRUPT")
        self.assertEqual(state["binding_state"], audit_inbox.BINDING_CORRUPT)
        self.assertEqual(state["layers"], [])

    def test_an_absent_binding_is_still_an_empty_inbox(self) -> None:
        self.binding().unlink(missing_ok=True)
        doc, state, detail = audit_inbox.read_binding_state(self.root)
        self.assertEqual(state, audit_inbox.BINDING_ABSENT)
        self.assertEqual(detail, "")
        self.assertEqual(doc["layers"], {})
        self.assertTrue(audit_inbox.classify(self.root)["ok"])

    def test_an_obstructed_binding_path_is_corrupt_not_absent(self) -> None:
        with patch.object(
            Path,
            "read_bytes",
            side_effect=NotADirectoryError("a path component is not a directory"),
        ):
            _doc, state, detail = audit_inbox.read_binding_state(self.root)
        self.assertEqual(state, audit_inbox.BINDING_CORRUPT)
        self.assertIn("cannot be read", detail)

    def test_a_write_never_launders_corrupt_bytes(self) -> None:
        raw = self.corrupt()
        with self.assertRaises(audit_inbox.BindingCorrupt):
            audit_inbox.bind_layer(
                self.root,
                "audit/2.md",
                layer=2,
                generation=1,
                file_sha256="b" * 64,
                size_bytes=1,
                receipt_id="SRC-002",
                receipt_sha256="b" * 64,
                binding="exact",
                linked_work=None,
                state=audit_inbox.ACTIVE,
            )
        self.assertEqual(self.binding().read_bytes(), raw)

    def test_status_and_routing_refuse_to_call_a_corrupt_inbox_idle(self) -> None:
        self.corrupt()
        out = audit_inbox.status(self.root)
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["code"], "AUDIT_BINDING_CORRUPT")
        self.assertFalse(out["clean"])
        routed = audit_inbox.projection(self.root)
        self.assertIsNotNone(routed)
        self.assertTrue(routed["binding_corrupt"])
        self.assertEqual(routed["action"], "saipen audit status")

    def test_a_persisted_unreadable_generation_refuses_instead_of_crashing(self) -> None:
        self.layer(1, "# audit\n")
        self.binding().write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "layers": {
                        "audit/1.md": {
                            "layer": 1,
                            "generation": "oops",
                            "file_sha256": "c" * 64,
                            "receipt_sha256": "c" * 64,
                            "binding": "exact",
                            "size_bytes": 1,
                            "receipt_id": "SRC-001",
                            "linked_work": None,
                            "state": audit_inbox.ACTIVE,
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        state = audit_inbox.classify(self.root)
        self.assertFalse(state["ok"], state)
        self.assertIn("generation", state["detail"])

    def test_the_delete_gate_and_the_trace_refuse_on_a_corrupt_binding(self) -> None:
        self.layer(1, "# audit\n")
        self.corrupt()
        gate = audit_inbox.delete_gate(self.root, "audit/1.md")
        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "AUDIT_BINDING_CORRUPT")
        consumed = audit_inbox.consume_layer(self.root, "audit/1.md", "probe")
        self.assertFalse(consumed["ok"], consumed)
        self.assertTrue((self.root / "audit" / "1.md").is_file())
        trace = audit_inbox.provenance_trace(self.root)
        self.assertFalse(trace["ok"], trace)
        self.assertEqual(trace["rows"], [])

    def test_the_producer_transport_fails_closed_on_a_corrupt_binding(self) -> None:
        from saipen_engine import audit_enqueue

        self.corrupt()
        result = audit_enqueue.enqueue(
            self.root, producer="audapack", body=b"# a finding\n", producer_operation_id="op-1"
        )
        self.assertFalse(result["ok"], result)
        self.assertEqual(list((self.root / "audit").glob("*.md")), [])


# ---------------------------------------------------------------------------
# RESIDUE / CLEAN VERDICT
# ---------------------------------------------------------------------------


class ResidueTests(AuditInboxFixture):
    """An inbox empty of everything SAIPEN captured is not yet a clean directory."""

    def residue(self, name: str, body: str = "leftover\n") -> Path:
        path = self.root / "audit" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        return path

    def test_an_absent_inbox_is_clean(self) -> None:
        self.assertEqual(audit_inbox.scan_residue(self.root), [])
        self.assertTrue(audit_inbox.status(self.root)["clean"])

    def test_an_empty_inbox_is_clean(self) -> None:
        (self.root / "audit").mkdir()
        self.assertTrue(audit_inbox.status(self.root)["clean"])
        self.assertIsNone(audit_inbox.projection(self.root))

    def test_noncanonical_names_are_residue(self) -> None:
        for name in ("notes.md", "01.md", "1.txt", "audit.md"):
            self.residue(name)
        (self.root / "audit" / "done").mkdir()
        found = {item["name"]: item["kind"] for item in audit_inbox.scan_residue(self.root)}
        self.assertEqual(sorted(found), ["01.md", "1.txt", "audit.md", "done", "notes.md"])
        self.assertEqual(found["done"], "directory")

    def test_a_canonical_layer_is_never_counted_as_residue(self) -> None:
        self.layer(1)
        self.assertEqual(audit_inbox.scan_residue(self.root), [])
        self.assertFalse(audit_inbox.status(self.root)["clean"])

    def test_an_invalid_layer_is_reported_once_as_a_layer_not_twice(self) -> None:
        self.layer(1, b"\xff\xfe not utf-8")
        self.assertEqual(audit_inbox.scan_residue(self.root), [])
        status = audit_inbox.status(self.root)
        self.assertEqual(len(status["invalid"]), 1)
        self.assertEqual(status["residue_count"], 0)

    def test_dot_prefixed_infrastructure_is_exempt(self) -> None:
        self.residue(".gitkeep", "")
        self.residue(".gitignore", "*\n")
        self.assertEqual(audit_inbox.scan_residue(self.root), [])
        self.assertTrue(audit_inbox.status(self.root)["clean"])
        self.assertIsNone(audit_inbox.projection(self.root))

    def test_the_nested_content_of_a_residue_directory_is_never_scanned(self) -> None:
        nested = self.root / "audit" / "done"
        nested.mkdir(parents=True)
        for number in range(1, 6):
            (nested / f"{number}.md").write_text("nested\n", encoding="utf-8")
        self.assertEqual([item["name"] for item in audit_inbox.scan_residue(self.root)], ["done"])

    def test_a_settled_inbox_with_residue_is_not_clean_and_not_idle(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        keep = self.residue("notes.md")
        self.assertTrue(audit_inbox.consume_layer(self.root, "audit/2.md", "probe")["ok"])
        status = audit_inbox.status(self.root)
        self.assertFalse(status["clean"])
        self.assertEqual(status["residue_count"], 1)
        routed = audit_inbox.projection(self.root)
        self.assertTrue(routed["residue_only"])
        self.assertIn("audit/notes.md", routed["detail"])
        self.assertTrue(keep.is_file(), "residue is reported, never deleted")

    def test_consuming_the_last_layer_of_a_clean_inbox_reports_clean(self) -> None:
        self.bind_closed(2, "closed audit two\n")
        self.assertTrue(audit_inbox.consume_layer(self.root, "audit/2.md", "probe")["ok"])
        self.assertTrue(audit_inbox.status(self.root)["clean"])
        self.assertIsNone(audit_inbox.projection(self.root))

    def test_residue_never_starves_a_workable_layer(self) -> None:
        self.residue("notes.md")
        self.layer(1)
        routed = audit_inbox.projection(self.root)
        self.assertEqual(routed["action"], "saipen audit ingest")
        self.assertNotIn("residue_only", routed)
        self.assertEqual(routed["residue"], ["audit/notes.md"])

    def test_an_invalid_layer_outranks_residue_in_the_verdict(self) -> None:
        self.layer(1, b"")
        self.residue("notes.md")
        routed = audit_inbox.projection(self.root)
        self.assertTrue(routed["invalid_only"])
        self.assertNotIn("residue_only", routed)

    def test_the_residue_report_is_capped(self) -> None:
        for number in range(audit_inbox.RESIDUE_REPORT_CAP + 5):
            self.residue(f"leftover-{number:03d}.txt")
        routed = audit_inbox.projection(self.root)
        self.assertEqual(len(routed["residue"]), audit_inbox.RESIDUE_REPORT_CAP)
        self.assertEqual(routed["residue_count"], audit_inbox.RESIDUE_REPORT_CAP + 5)

    def test_the_residue_projection_writes_nothing(self) -> None:
        self.residue("notes.md")

        def snap() -> dict:
            return {
                path: path.read_bytes()
                for path in sorted((self.root / ".saipen").rglob("*"))
                if path.is_file()
            }

        before = snap()
        audit_inbox.projection(self.root)
        audit_inbox.status(self.root)
        self.assertEqual(before, snap())


# ---------------------------------------------------------------------------
# REGISTRY / OWNERSHIP
# ---------------------------------------------------------------------------


class RegistryContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = json.loads(
            (ROOT / "saipen" / "REGISTRY.json").read_text(encoding="utf-8-sig")
        )

    def test_registry_owns_the_closed_audit_inbox_facts(self) -> None:
        facts = self.registry["audit_inbox"]
        self.assertEqual(facts["rule_id"], "SOURCE-AUDIT-INBOX-01")
        self.assertEqual(facts["directory"], audit_inbox.AUDIT_DIRNAME)
        self.assertEqual(facts["filename_regex"], audit_inbox.LAYER_RE.pattern)
        self.assertEqual(facts["source_kind"], audit_inbox.SOURCE_KIND)
        self.assertEqual(facts["binding"], audit_inbox.BINDING_REL)
        self.assertFalse(facts["recursive"])
        self.assertFalse(facts["renumber_after_delete"])
        self.assertEqual(facts["continue_position"], "AFTER_ACTIVE_BEFORE_BOARD_PICK")
        self.assertEqual(facts["residue_policy"], "REPORT_NEVER_DELETE")
        self.assertEqual(facts["residue_exempt_prefix"], audit_inbox.RESIDUE_EXEMPT_PREFIX)
        self.assertEqual(facts["clean_verdict"], "NO_LAYER_AND_NO_RESIDUE")

    def test_the_rule_has_exactly_one_human_owner(self) -> None:
        self.assertEqual(
            self.registry["rule_owners"]["SOURCE-AUDIT-INBOX-01"], "saipen/SOURCES.md"
        )
        sources = (ROOT / "saipen" / "SOURCES.md").read_text(encoding="utf-8-sig")
        self.assertIn("<!-- RULE-OWNER: SOURCE-AUDIT-INBOX-01 -->", sources)

    def test_audit_is_a_registered_command(self) -> None:
        self.assertIn("audit", self.registry["commands"]["saipen"])


if __name__ == "__main__":
    unittest.main()
