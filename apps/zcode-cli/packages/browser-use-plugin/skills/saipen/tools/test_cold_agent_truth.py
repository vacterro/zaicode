"""Cold-agent truth, context-economy and effect-path regressions (T-1325)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from saipen_engine.acceptance import (
    CONTESTED,
    EVIDENCE_SCOPE_TOO_WEAK,
    SATISFIED,
    reconcile,
)
from saipen_engine.board import MAX_LIVE_RECORD_CHARS, assert_live_record, set_ticket_field
from saipen_engine.cold_truth import (
    ORIENTATION_READ_BUDGET,
    generated_handoff_provenance,
    orientation_projection,
)
from saipen_engine.log import MAX_NEW_EVENT_BYTES, build_event

from test_hermetic_env import isolate_host_session


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


LINEAGE = "lineage-0123456789abcdef0123456789abcdef"
ROOT = Path(__file__).resolve().parents[1]


def event(number: int, text: str, *, parent: int | None = None) -> str:
    parent_part = f" [parent: E-{parent}]" if parent else ""
    return (
        f"- 14.09.26 10:00 [E-{number}]{parent_part} [T-9] [agent: cold] "
        f"[op: checkpoint-{number:032d}] RUN: {text}"
    )


def evidence(number: int, body: str) -> dict:
    return {"event": number, "ticket": "T-9", "taxonomy": "RUN", "text": "AC-EVIDENCE " + body}


class ColdProject(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-cold-truth-")
        self.root = Path(self.tmp.name)
        sai = self.root / ".saipen"
        sai.mkdir()
        (sai / "IDENTITY.md").write_text(
            f"---\nproject_lineage: {LINEAGE}\n---\n", encoding="utf-8"
        )
        (sai / "STATE.md").write_text(
            """---
phase: VERIFY
task: T-9
next_action: "PHASE VERIFY T-9"
blocker: ""
transition_from: BUILD
saipen_version: 7
schema_version: 3
last_event: 205
style_contract: ded-test
agent: cold
mode: full
updated: "2026-09-14T10:00:00Z"
---
""",
            encoding="utf-8",
        )
        current = (
            "- [/] T-9 [P1] current cold truth | verify: AC-01 [EFFECT_PATH] "
            "real sink observes transformed value | owner: cold | claim_time: "
            "2026-09-14T10:00:00Z"
        )
        board = "# Board\n## DOING\n" + current + "\n## TODO\n## DONE\n"
        board += "".join(
            f"- [x] T-{n} [P3] historical {('x' * 380)} | verify: old proof\n"
            for n in range(10, 180)
        )
        board += "## BLOCKED\n"
        (sai / "BOARD.md").write_text(board, encoding="utf-8")
        lines = ["# Log", event(200, "old detail " + "z" * 40_000)]
        for number in range(201, 206):
            lines.append(event(number, f"compact lifecycle {number}", parent=number - 1))
        (sai / "LOG.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def handoff(self, **changes) -> dict:
        base = generated_handoff_provenance(
            self.root,
            {
                "last_event": 205,
            },
        )
        base.update(changes)
        return base

    def test_current_handoff_and_current_state(self) -> None:
        out = orientation_projection(self.root, handoff=self.handoff())
        self.assertTrue(out["ok"])
        self.assertEqual(out["handoff_status"], "CURRENT")
        self.assertEqual((out["phase"], out["task"], out["last_event"]), ("VERIFY", "T-9", 205))

    def test_stale_handoff_cannot_override_current_next_action(self) -> None:
        stale = self.handoff(based_on_event=204, next_action="PHASE BUILD T-OLD")
        out = orientation_projection(self.root, handoff=stale)
        self.assertEqual(out["handoff_status"], "STALE")
        self.assertEqual(out["next_action"], "PHASE VERIFY T-9")
        self.assertNotIn("T-OLD", json.dumps(out))

    def test_foreign_lineage_handoff_never_executes(self) -> None:
        foreign = self.handoff(project_lineage="lineage-ffffffffffffffffffffffffffffffff")
        out = orientation_projection(self.root, handoff=foreign)
        self.assertEqual(out["handoff_status"], "FOREIGN")
        self.assertIn("do not execute handoff.next_action", out["forbidden_probes"])

    def test_foreign_runtime_identity_is_conflict(self) -> None:
        out = orientation_projection(self.root, handoff=self.handoff(project_identity="foreign"))
        self.assertEqual(out["handoff_status"], "CONFLICT")

    def test_orientation_ignores_mtimes(self) -> None:
        handoff = self.handoff(based_on_event=204)
        first = orientation_projection(self.root, handoff=handoff)
        for name in ("STATE.md", "BOARD.md", "LOG.md"):
            os.utime(self.root / ".saipen" / name, (1, 1))
        second = orientation_projection(self.root, handoff=handoff)
        for key in ("phase", "task", "last_event", "next_action", "handoff_status"):
            self.assertEqual(first[key], second[key])
        self.assertEqual(second["read_budget"]["mtime_reads_as_authority"], 0)

    def test_zero_context_orientation_stays_under_measured_budget(self) -> None:
        out = orientation_projection(self.root, handoff=self.handoff(based_on_event=204))
        total_protocol = sum(
            (self.root / ".saipen" / name).stat().st_size
            for name in ("STATE.md", "BOARD.md", "LOG.md")
        )
        self.assertLessEqual(out["read_budget"]["actual_bytes"], ORIENTATION_READ_BUDGET)
        self.assertLess(out["read_budget"]["actual_bytes"], total_protocol)
        self.assertTrue(out["read_budget"]["board_prefix_truncated"])
        self.assertTrue(out["read_budget"]["log_tail_truncated"])
        self.assertEqual(out["read_budget"]["repository_searches"], 0)
        self.assertEqual(out["recent_lifecycle"][-1]["event"], 205)
        self.assertEqual(out["current_ticket"]["id"], "T-9")
        self.assertEqual(
            out["current_ticket"]["acceptance_requirements"],
            [{"criterion": "AC-01", "minimum_witness": "EFFECT_PATH"}],
        )

    def test_oversized_handoff_is_data_conflict_not_required_input(self) -> None:
        path = self.root / "giant-handoff.json"
        path.write_text(json.dumps({"prose": "x" * 20_000}), encoding="utf-8")
        out = orientation_projection(self.root, handoff_path=path)
        self.assertTrue(out["ok"])
        self.assertEqual(out["handoff_status"], "CONFLICT")
        self.assertEqual(out["next_action"], "PHASE VERIFY T-9")

    def test_generated_handoff_has_complete_provenance(self) -> None:
        row = self.handoff()
        self.assertEqual(
            set(row),
            {
                "project_identity",
                "project_lineage",
                "based_on_event",
                "generated_at",
                "runtime_generation",
                "implementation_checkpoint",
            },
        )

    def test_workspace_bytes_compare_checkpoint_without_mtime_guess(self) -> None:
        handoff = self.handoff()
        handoff["implementation_checkpoint"] = {
            "status": "PROVEN",
            "source_head": "a",
            "source_tree_fingerprint": "git-delta-v1:a",
        }
        current = {
            "status": "PROVEN",
            "source_head": "a",
            "source_tree_fingerprint": "git-delta-v1:b",
            "discovery_model": "git-delta-v1",
        }
        with patch("saipen_engine.cold_truth.implementation_checkpoint", return_value=current):
            out = orientation_projection(self.root, handoff=handoff)
        self.assertEqual(out["workspace_bytes"]["status"], "DIFFERENT")

    def test_fresh_process_cold_boot_report_uses_protocol_bytes_only(self) -> None:
        handoff_path = self.root / "stale.json"
        handoff_path.write_text(
            json.dumps(self.handoff(based_on_event=204, next_action="RUN: stale")),
            encoding="utf-8",
        )
        run = subprocess.run(
            [
                sys.executable,
                str(ROOT / "tools" / "saipen.py"),
                "context",
                "orient",
                "--handoff",
                str(handoff_path),
                "--project-root",
                str(self.root),
                "--json",
            ],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(run.returncode, 0, run.stderr + run.stdout)
        report = json.loads(run.stdout)
        self.assertEqual(report["handoff_status"], "STALE")
        self.assertEqual(report["next_action"], "PHASE VERIFY T-9")
        self.assertEqual(
            report["current_ticket"]["acceptance_requirements"][0]["minimum_witness"],
            "EFFECT_PATH",
        )
        self.assertTrue(report["read_budget"]["within_budget"])


class CompactWriterTests(unittest.TestCase):
    def test_oversized_new_log_event_refuses_without_truncation(self) -> None:
        with self.assertRaisesRegex(ValueError, "LOG_EVENT_OVERSIZE.*detail_ref"):
            build_event(9, "RUN", "x" * (MAX_NEW_EVENT_BYTES * 2))

    def test_bounded_new_log_event_keeps_parent_and_identity(self) -> None:
        number, line = build_event(9, "RUN", "compact", ticket="T-9")
        self.assertEqual(number, 10)
        self.assertIn("[E-10] [parent: E-9] [T-9]", line)
        self.assertLessEqual(len(line.encode("utf-8")), MAX_NEW_EVENT_BYTES)

    def test_oversized_new_board_record_refuses_with_externalization_route(self) -> None:
        with self.assertRaisesRegex(ValueError, "BOARD_RECORD_OVERSIZE.*detail"):
            assert_live_record("- [ ] T-1 [P1] " + "x" * MAX_LIVE_RECORD_CHARS)

    def test_oversized_updated_board_record_also_refuses(self) -> None:
        raw = "- [ ] T-1 [P1] " + "x" * MAX_LIVE_RECORD_CHARS
        with self.assertRaisesRegex(ValueError, "BOARD_RECORD_OVERSIZE"):
            set_ticket_field(raw, "owner", "cold")


class EffectPathEvidenceTests(unittest.TestCase):
    @staticmethod
    def fade(value: float) -> float:
        return value * value

    @staticmethod
    def bypassing_sink(value: float) -> float:
        return value

    @staticmethod
    def integrated_sink(value: float) -> float:
        return EffectPathEvidenceTests.fade(value)

    def test_unit_witness_cannot_satisfy_real_effect_path(self) -> None:
        self.assertEqual(self.fade(0.5), 0.25)
        self.assertNotEqual(self.bypassing_sink(0.5), self.fade(0.5))
        rows = [
            evidence(
                11,
                "AC-01 PASS behavioral witness=UNIT surface=fade_helper -- helper unit green",
            )
        ]
        out = reconcile("T-9", "AC-01 [EFFECT_PATH] emitter applies fade at real sink", rows)
        self.assertEqual(out["criteria"][0]["state"], EVIDENCE_SCOPE_TOO_WEAK)
        self.assertFalse(out["criteria"][0]["evidence"][0]["scope_sufficient"])

    def test_effect_path_witness_satisfies_broader_criterion(self) -> None:
        self.assertEqual(self.integrated_sink(0.5), self.fade(0.5))
        rows = [
            evidence(
                12,
                "AC-01 PASS behavioral witness=EFFECT_PATH surface=real_sink -- sink observed",
            )
        ]
        out = reconcile("T-9", "AC-01 [EFFECT_PATH] emitter applies fade at real sink", rows)
        self.assertEqual(out["criteria"][0]["state"], SATISFIED)

    def test_historical_pass_plus_later_escape_is_temporally_truthful(self) -> None:
        rows = [
            evidence(
                20,
                "AC-01 PASS manual witness=MANUAL surface=user_output -- accepted then",
            ),
            {
                "event": 21,
                "ticket": "T-9",
                "taxonomy": "RUN",
                "text": (
                    "AC-ESCAPED AC-01 E-20 SCOPE_NARROWER_THAN_CLAIM -- "
                    "real emitter bypassed helper"
                ),
            },
        ]
        out = reconcile("T-9", "AC-01 [EFFECT_PATH] user output is transformed", rows)
        row = out["criteria"][0]
        self.assertEqual(row["state"], CONTESTED)
        self.assertTrue(row["previously_accepted"])
        self.assertEqual(row["evidence"][0]["result"], "PASS")
        self.assertEqual(row["escaped_defects"][0]["previous_event"], 20)


if __name__ == "__main__":
    unittest.main()
