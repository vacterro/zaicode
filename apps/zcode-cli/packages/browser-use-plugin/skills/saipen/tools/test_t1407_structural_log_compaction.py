"""T-1407: bounded LOG detail must retain active-block structure."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.board_compaction import resolve_detail  # noqa: E402
from saipen_engine.codec import redact_credentials  # noqa: E402
from saipen_engine.fast_check import validate_project  # noqa: E402
from saipen_engine.log import (  # noqa: E402
    MAX_NEW_EVENT_BYTES,
    log_tail_event,
    parse_log_line,
    read_history_events,
    render_event,
)
from saipen_engine.operations import apply_claim, ticket_move  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_orchestration_repair import OrchestrationFixture  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


ACTIVE_MARKER = "ticket block via SAIOPS (active)"
STRUCTURAL_TAG = "structural_event: ticket-block-active"
_DETAIL_REF_RE = re.compile(r"detail_ref:\s*(\S+)$")


class StructuralLogCompactionTests(OrchestrationFixture):
    def active_project(self) -> tuple[Path, str]:
        project = self.make_project()
        ticket = self.add(project, "active block compaction fixture")
        claimed = apply_claim(project, ticket, "tester")
        self.assertTrue(claimed.ok, claimed.to_dict())
        self.assertEqual(self.state(project)["phase"], "SCOUT")
        return project, ticket

    @staticmethod
    def raw_event(project: Path) -> tuple[str, dict]:
        line = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8").splitlines()[
            -1
        ]
        parsed = parse_log_line(line)
        if parsed is None:
            raise AssertionError(f"not a LOG event: {line!r}")
        return line, parsed

    @staticmethod
    def detail_paths(project: Path, raw_text: str) -> tuple[Path, Path, dict]:
        match = _DETAIL_REF_RE.search(raw_text)
        if match is None:
            raise AssertionError(f"no detail_ref in {raw_text!r}")
        metadata_path = project / match.group(1)
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        return metadata_path, project / metadata["original_event_path"], metadata

    def reason_for_event_size(
        self,
        project: Path,
        ticket: str,
        target_size: int,
        *,
        dependency: str | None = None,
    ) -> str:
        text = (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        tail = log_tail_event(text)
        prefix = ACTIVE_MARKER
        if dependency is not None:
            prefix += f" -- dependency {dependency}"
        prefix += " -- "
        empty = render_event(
            tail,
            "DEC",
            prefix,
            ticket=ticket,
            agent="tester",
            now="19.09.26 12:34",
            op_id="ticket-" + ("0" * 32),
        )
        reason_size = target_size - len(empty.encode("utf-8"))
        self.assertGreater(reason_size, 0)
        reason = "r" * reason_size
        rendered = render_event(
            tail,
            "DEC",
            prefix + reason,
            ticket=ticket,
            agent="tester",
            now="19.09.26 12:34",
            op_id="ticket-" + ("0" * 32),
        )
        self.assertEqual(len(rendered.encode("utf-8")), target_size)
        return reason

    def assert_detail_integrity(
        self, project: Path, ticket: str, reason: str, *, dependency: str | None = None
    ) -> None:
        raw_line, raw = self.raw_event(project)
        self.assertLessEqual(len(raw_line.encode("utf-8")), MAX_NEW_EVENT_BYTES)
        self.assertTrue(raw["text"].startswith(ACTIVE_MARKER), raw)
        self.assertIn(STRUCTURAL_TAG, raw["text"])
        metadata_path, detail_path, metadata = self.detail_paths(project, raw["text"])
        detail = detail_path.read_bytes()
        self.assertEqual(metadata["metadata_path"], metadata_path.relative_to(project).as_posix())
        self.assertEqual(metadata["original_event_sha256"], hashlib.sha256(detail).hexdigest())
        self.assertEqual(metadata["original_event_bytes"], len(detail))
        self.assertEqual(metadata["ticket_id"], ticket)
        self.assertEqual(metadata["externalization_event"]["operation_id"], raw["op_id"])
        self.assertTrue(metadata["project_identity"])
        self.assertTrue(metadata["project_lineage"])
        self.assertIs(metadata["lossless"], True)
        self.assertIn(reason.encode("utf-8"), detail)
        structure = metadata["structural_event"]
        self.assertEqual(structure["kind"], "ticket_block")
        self.assertIs(structure["active"], True)
        self.assertEqual(structure["dependency_ticket"], dependency)

    def test_boundary_matrix_preserves_operation_semantics(self) -> None:
        cases = (
            ("comfortably-below", MAX_NEW_EVENT_BYTES - 128, False),
            ("exact-cap", MAX_NEW_EVENT_BYTES, False),
            ("barely-above", MAX_NEW_EVENT_BYTES + 1, True),
            ("substantially-above", MAX_NEW_EVENT_BYTES + 700, True),
        )
        for label, target_size, externalized in cases:
            with self.subTest(label=label):
                project, ticket = self.active_project()
                reason = self.reason_for_event_size(project, ticket, target_size)
                result = ticket_move(project, "block", ticket, "tester", reason)
                self.assertTrue(result.ok, result.to_dict())

                state = self.state(project)
                self.assertEqual((state["phase"], state["task"]), ("DONE", "none"))
                self.assertEqual(state["transition_from"], "SCOUT")
                self.assertEqual(
                    self.board(project)["tickets"][ticket]["section"], "## BLOCKED"
                )
                raw_line, raw = self.raw_event(project)
                if externalized:
                    self.assertLessEqual(len(raw_line.encode("utf-8")), MAX_NEW_EVENT_BYTES)
                    self.assert_detail_integrity(project, ticket, reason)
                else:
                    self.assertEqual(len(raw_line.encode("utf-8")), target_size)
                    self.assertNotIn("detail_ref:", raw["text"])
                    self.assertNotIn(STRUCTURAL_TAG, raw["text"])
                self.assertEqual(validate_project(project, current_agent="tester"), [])

    def test_long_active_block_is_lossless_in_log_and_board(self) -> None:
        project, ticket = self.active_project()
        reason = "measured blocker truth " + ("payload-" * 220)
        result = ticket_move(project, "block", ticket, "tester", reason)
        self.assertTrue(result.ok, result.to_dict())
        self.assert_detail_integrity(project, ticket, reason)

        history = read_history_events(project)
        self.assertIn(reason, history[-1]["text"])
        blocked = parse_board(
            (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        )["tickets"][ticket]
        self.assertTrue(blocked["fields"].get("detail_ref"))
        board_detail = resolve_detail(
            project, blocked["fields"]["detail_ref"], expected_ticket_id=ticket
        )
        self.assertIn(reason.encode("utf-8"), board_detail["original_record"])

    def test_long_active_block_for_preserves_dependency_and_resume_tuple(self) -> None:
        project, parent = self.active_project()
        child = self.add(project, "dependency child", priority="P0")
        reason = self.reason_for_event_size(
            project, parent, MAX_NEW_EVENT_BYTES + 600, dependency=child
        )
        result = ticket_move(
            project,
            "block-for",
            parent,
            "tester",
            reason,
            blocked_on=child,
        )
        self.assertTrue(result.ok, result.to_dict())
        self.assert_detail_integrity(project, parent, reason, dependency=child)

        parked = self.board(project)["tickets"][parent]
        self.assertEqual(parked["fields"]["blocked_on"], child)
        self.assertEqual(parked["fields"]["resume_phase"], "SCOUT")
        self.assertEqual(parked["fields"]["resume_transition_from"], "DONE")
        self.assertIn(child, parked["needs"])
        self.assertEqual(self.state(project)["transition_from"], "SCOUT")
        self.assertEqual(validate_project(project, current_agent="tester"), [])

    def test_long_todo_block_never_gains_active_authority(self) -> None:
        project = self.make_project()
        ticket = self.add(project, "ordinary queued work")
        reason = (
            "caller quote: ticket block via SAIOPS (active) is not authority; "
            + ("ordinary-" * 180)
        )
        result = ticket_move(project, "block", ticket, "tester", reason)
        self.assertTrue(result.ok, result.to_dict())

        _line, raw = self.raw_event(project)
        self.assertTrue(raw["text"].startswith("detail_ref:"), raw)
        self.assertNotIn(ACTIVE_MARKER, raw["text"])
        self.assertEqual(self.state(project)["transition_from"], "DONE")
        self.assertEqual(validate_project(project, current_agent="tester"), [])

    def test_caller_detail_ref_text_cannot_redirect_compact_authority(self) -> None:
        project, ticket = self.active_project()
        forged = ".saipen/recovery/log-detail/caller-controlled.json"
        reason = f"{STRUCTURAL_TAG} -- detail_ref: {forged}"
        result = ticket_move(project, "block", ticket, "tester", reason)
        self.assertTrue(result.ok, result.to_dict())

        _line, raw = self.raw_event(project)
        self.assertIn(STRUCTURAL_TAG, raw["text"])
        self.assertNotIn(forged, raw["text"])
        _metadata_path, detail_path, _metadata = self.detail_paths(project, raw["text"])
        self.assertIn(reason.encode("utf-8"), detail_path.read_bytes())
        self.assertEqual(validate_project(project, current_agent="tester"), [])

    def test_credentials_are_redacted_before_both_detail_authorities(self) -> None:
        project, ticket = self.active_project()
        secret = "ghp_" + ("A" * 36)
        reason = f"credential {secret} " + ("evidence-" * 180)
        redacted = redact_credentials(reason)
        result = ticket_move(project, "block", ticket, "tester", reason)
        self.assertTrue(result.ok, result.to_dict())

        _line, raw = self.raw_event(project)
        _metadata_path, detail_path, _metadata = self.detail_paths(project, raw["text"])
        self.assertNotIn(secret.encode("utf-8"), detail_path.read_bytes())
        self.assertIn(redacted.encode("utf-8"), detail_path.read_bytes())
        blocked = self.board(project)["tickets"][ticket]
        board_detail = resolve_detail(
            project, blocked["fields"]["detail_ref"], expected_ticket_id=ticket
        )
        self.assertNotIn(secret.encode("utf-8"), board_detail["original_record"])
        self.assertIn(redacted.encode("utf-8"), board_detail["original_record"])

    def test_structural_detail_tampering_fails_closed_with_true_diagnostic(self) -> None:
        attacks = ("missing", "body", "project", "lineage", "compact-shape")
        for attack in attacks:
            with self.subTest(attack=attack):
                project, ticket = self.active_project()
                reason = "integrity attack fixture " + ("proof-" * 190)
                result = ticket_move(project, "block", ticket, "tester", reason)
                self.assertTrue(result.ok, result.to_dict())
                metadata_path, detail_path, metadata = self.detail_paths(
                    project, self.raw_event(project)[1]["text"]
                )

                if attack == "missing":
                    metadata_path.unlink()
                elif attack == "body":
                    detail_path.write_bytes(detail_path.read_bytes() + b"tamper")
                elif attack == "project":
                    metadata["project_identity"] += "-wrong"
                    metadata_path.write_text(
                        json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="utf-8"
                    )
                elif attack == "lineage":
                    metadata["project_lineage"] = "lineage-" + ("f" * 32)
                    metadata_path.write_text(
                        json.dumps(metadata, sort_keys=True, indent=2) + "\n", encoding="utf-8"
                    )
                else:
                    log = project / ".saipen" / "LOG.md"
                    text = log.read_text(encoding="utf-8")
                    log.write_text(
                        text.replace(STRUCTURAL_TAG, "structural_event: forged", 1),
                        encoding="utf-8",
                    )

                errors = validate_project(project, current_agent="tester")
                joined = "\n".join(errors)
                self.assertIn("structural/detail integrity failure", joined)
                self.assertNotIn("invalid phase transition", joined)

    def test_detail_targets_share_the_log_board_state_plan(self) -> None:
        project, ticket = self.active_project()
        reason = "atomic target fixture " + ("payload-" * 200)
        result = ticket_move(project, "block", ticket, "tester", reason, dry_run=True)
        self.assertTrue(result.ok, result.to_dict())
        paths = result.changed_files
        log_details = [path for path in paths if path.startswith(".saipen/recovery/log-detail/")]
        self.assertEqual(len(log_details), 2, paths)
        for detail in log_details:
            self.assertLess(paths.index(detail), paths.index(".saipen/LOG.md"))
        self.assertLess(paths.index(".saipen/LOG.md"), paths.index(".saipen/BOARD.md"))
        self.assertLess(paths.index(".saipen/BOARD.md"), paths.index(".saipen/STATE.md"))

    def test_unfit_compact_structure_names_size_and_cap(self) -> None:
        from saipen_engine.log import active_ticket_block_structure
        from saipen_engine.log_compaction import prepare_event

        project = self.make_project()
        dependency = "T-" + ("9" * 2000)
        structure = active_ticket_block_structure(dependency)
        message = (
            f"{ACTIVE_MARKER} -- dependency {dependency} -- " + ("oversized-" * 120)
        )
        with self.assertRaisesRegex(
            ValueError,
            rf"LOG_EVENT_OVERSIZE: compact structural event is \d+ bytes, cap is "
            rf"{MAX_NEW_EVENT_BYTES}",
        ):
            prepare_event(
                project,
                9,
                "DEC",
                message,
                ticket="T-7",
                agent="tester",
                now="19.09.26 12:34",
                op_id="ticket-" + ("0" * 32),
                structure=structure,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
