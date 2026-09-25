"""Terminal Work supersession without retirement or publication conflation."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import closure, intake, supersession  # noqa: E402
from saipen_engine.board import (  # noqa: E402
    closure_metadata_errors,
    parse_board,
    remove_ticket_field,
    set_ticket_field,
)
from saipen_engine.errors import CODES  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    checkpoint,
    finish_ticket,
    supersede_ticket,
    ticket_move,
    transition_phase,
)
from saipen_engine.retirement import RETIREMENT_REASONS  # noqa: E402
from test_orchestration_repair import OrchestrationFixture  # noqa: E402


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        digest.update(path.relative_to(root).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def _grant(old: str, new: str) -> str:
    return (
        f"{supersession.GRANT_HEADER}\n\n"
        f"    {old} - {new}\n\n"
        f"{supersession.GRANT_TERMINATOR}\n"
    )


class SupersessionFixture(OrchestrationFixture):
    def prepare(self, *, evidence_target: str = "T-7") -> tuple[Path, str, str, str]:
        project = self.make_project(active=True, phase="BUILD")
        blocked = ticket_move(
            project,
            "block",
            "T-7",
            "tester",
            "implemented and verified by successor Work",
        )
        self.assertTrue(blocked.ok, blocked.to_dict())
        successor = self.add(project, "successor implementation")
        claimed = apply_claim(project, successor, "tester", explicit=True)
        self.assertTrue(claimed.ok, claimed.to_dict())
        for phase, text in (
            ("BUILD", "implementation complete"),
            ("VERIFY", "machine checks ready"),
        ):
            moved = transition_phase(project, phase, "tester", successor, text)
            self.assertTrue(moved.ok, moved.to_dict())
        verified = checkpoint(
            project,
            "tester",
            "RUN",
            successor,
            f"verify -> PASS [target: {evidence_target}] conf: high -- exact objective",
        )
        self.assertTrue(verified.ok, verified.to_dict())
        evidence = verified.data["event_id"]
        for phase, text in (
            ("REVIEW", "review pass"),
            ("SHIP", "local closure pass"),
        ):
            moved = transition_phase(project, phase, "tester", successor, text)
            self.assertTrue(moved.ok, moved.to_dict())
        finished = finish_ticket(project, successor, "tester")
        self.assertTrue(finished.ok, finished.to_dict())
        captured = intake.capture(
            project,
            _grant("T-7", successor),
            source_kind="user_instruction",
        )
        self.assertTrue(captured["ok"], captured)
        return project, successor, evidence, captured["receipt"]

    def supersede(self, project: Path, successor: str, evidence: str, authority: str):
        return supersede_ticket(
            project,
            "T-7",
            successor,
            "tester",
            evidence=evidence,
            authority=authority,
        )


class GreenPathTests(SupersessionFixture):
    def test_terminal_relation_preserves_history_and_separates_publication(self):
        project, successor, evidence, authority = self.prepare()
        result = self.supersede(project, successor, evidence, authority)
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "SUPERSEDED")

        ticket = parse_board((project / ".saipen" / "BOARD.md").read_text())["tickets"]["T-7"]
        self.assertEqual(ticket["section"], "## DONE")
        self.assertEqual(ticket["fields"]["closure_mode"], "superseded_verified")
        self.assertEqual(ticket["fields"]["superseded_by"], successor)
        self.assertEqual(ticket["fields"]["supersession_evidence"], evidence)
        self.assertEqual(ticket["fields"]["supersession_authority"], authority)
        self.assertNotIn("blocker", ticket["fields"])
        self.assertFalse((project / ".saipen" / "archive" / "retired" / "T-7.json").exists())

        verdict = closure.resolve_implementation_source(project, "T-7")
        self.assertFalse(verdict.ok, verdict.to_dict())
        self.assertEqual(verdict.chain[:2], ("T-7", successor))
        self.assertIn("no committed release evidence", verdict.detail)

    def test_identical_repeat_is_idempotent(self):
        project, successor, evidence, authority = self.prepare()
        self.assertTrue(self.supersede(project, successor, evidence, authority).ok)
        before = _tree_digest(project)
        repeated = self.supersede(project, successor, evidence, authority)
        self.assertTrue(repeated.ok, repeated.to_dict())
        self.assertEqual(repeated.code, "ALREADY_APPLIED")
        self.assertEqual(_tree_digest(project), before)

    def test_validator_accepts_local_lifecycle_while_publication_stays_unproven(self):
        """One question, two intentionally different answers (T-1418).

        A superseded_verified ticket is lifecycle-terminal while NOT a
        publication claim, so the validator's closure contract holds AND the
        strict resolver is non-green on the very same bytes. The wording fix is
        behavior here, not cosmetic: a success sentence claiming every closure
        resolves to durable publication would be false for exactly this mode.
        """
        project, successor, evidence, authority = self.prepare()
        self.assertTrue(self.supersede(project, successor, evidence, authority).ok)

        proc = subprocess.run(
            [sys.executable, str(TOOLS / "validate.py"), "--project-root", str(project)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        output = proc.stdout + proc.stderr
        self.assertIn(
            "every DONE closure provenance satisfies its declared closure contract",
            output,
        )
        self.assertNotIn("closure provenance does not resolve", output)
        self.assertNotIn("closure provenance resolves to durable publication", output)

        verdict = closure.resolve_implementation_source(project, "T-7")
        self.assertFalse(verdict.ok, verdict.to_dict())
        self.assertEqual(verdict.chain[:2], ("T-7", successor))
        self.assertIn("no committed release evidence", verdict.detail)

    def test_closure_evidence_exemption_is_not_blindness(self):
        """The superseded_verified skip exempts a MODE, never a claim (T-1418).

        A superseded ticket never ran its own VERIFY cycle, so the generic
        current-cycle classifier cannot apply and the closure-evidence gate
        skips it. That skip must not swallow a bad closure: with the successor
        demoted out of DONE the closure-provenance gate still FAILs the very
        same ticket the evidence gate stepped over.
        """
        project, successor, evidence, authority = self.prepare()
        self.assertTrue(self.supersede(project, successor, evidence, authority).ok)
        board_path = project / ".saipen" / "BOARD.md"
        board = board_path.read_text(encoding="utf-8")
        raw = parse_board(board)["tickets"][successor]["raw"]
        board_path.write_text(
            board.replace(raw + "\n", "", 1).replace(
                "## TODO\n", "## TODO\n" + raw.replace("- [x] ", "- [ ] ") + "\n", 1
            ),
            encoding="utf-8",
        )
        proc = subprocess.run(
            [sys.executable, str(TOOLS / "validate.py"), "--project-root", str(project)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        output = proc.stdout + proc.stderr
        self.assertIn("supersession T-7 names non-DONE successor", output)

    def test_public_cli_is_the_canonical_operation(self):
        project, successor, evidence, authority = self.prepare()
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "ticket",
                "supersede",
                "T-7",
                "--by",
                successor,
                "--evidence",
                evidence,
                "--authority",
                authority,
                "--project-root",
                str(project),
                "--agent",
                "tester",
                "--json",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr or proc.stdout)
        self.assertEqual(json.loads(proc.stdout)["code"], "SUPERSEDED")


class HostileGateTests(SupersessionFixture):
    def assert_refused(self, result, code: str) -> None:
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, code)

    def test_successor_missing(self):
        project, _successor, evidence, authority = self.prepare()
        self.assert_refused(
            self.supersede(project, "T-999", evidence, authority),
            "SUPERSESSION_SUCCESSOR_NOT_FOUND",
        )

    def test_successor_todo_and_blocked(self):
        for blocked in (False, True):
            with self.subTest(blocked=blocked):
                project, successor, evidence, authority = self.prepare()
                board_path = project / ".saipen" / "BOARD.md"
                board = board_path.read_text()
                line = parse_board(board)["tickets"][successor]["raw"]
                board = board.replace(line + "\n", "")
                heading = "## BLOCKED\n" if blocked else "## TODO\n"
                replacement = line.replace("- [x] ", "- [ ] ")
                if blocked:
                    replacement = set_ticket_field(replacement, "blocker", "still blocked")
                    replacement = set_ticket_field(replacement, "blocker_scope", "ticket")
                board_path.write_text(board.replace(heading, heading + replacement + "\n"))
                self.assert_refused(
                    self.supersede(project, successor, evidence, authority),
                    "SUPERSESSION_SUCCESSOR_NOT_DONE",
                )

    def test_self_cycle(self):
        project, _successor, evidence, authority = self.prepare()
        self.assert_refused(
            self.supersede(project, "T-7", evidence, authority),
            "SUPERSESSION_SELF_CYCLE",
        )

    def test_longer_cycle(self):
        project, successor, evidence, authority = self.prepare()
        board_path = project / ".saipen" / "BOARD.md"
        board = board_path.read_text()
        ticket = parse_board(board)["tickets"][successor]
        changed = set_ticket_field(ticket["raw"], "closure_mode", "superseded_verified")
        changed = set_ticket_field(changed, "implementation_delta", "none")
        changed = set_ticket_field(changed, "superseded_by", "T-7")
        changed = set_ticket_field(changed, "supersession_evidence", evidence)
        changed = set_ticket_field(changed, "supersession_authority", authority)
        board_path.write_text(board.replace(ticket["raw"], changed))
        self.assert_refused(
            self.supersede(project, successor, evidence, authority),
            "SUPERSESSION_CYCLE",
        )

    def test_evidence_must_target_old_work(self):
        project, successor, evidence, authority = self.prepare(evidence_target="T-8")
        self.assert_refused(
            self.supersede(project, successor, evidence, authority),
            "SUPERSESSION_EVIDENCE_INVALID",
        )

    def test_arbitrary_prose_fenced_and_conflicting_authority_grant_nothing(self):
        project, successor, evidence, _authority = self.prepare()
        bodies = (
            f"please settle T-7 through {successor}\n",
            f"```\n{_grant('T-7', successor)}```\n",
            _grant("T-7", successor) + _grant("T-7", "T-999"),
        )
        for body in bodies:
            with self.subTest(body=body):
                captured = intake.capture(project, body, source_kind="user_instruction")
                self.assertTrue(captured["ok"], captured)
                self.assert_refused(
                    self.supersede(project, successor, evidence, captured["receipt"]),
                    "SUPERSESSION_AUTHORITY_REQUIRED",
                )

    def test_old_source_receipts_fail_closed(self):
        project, successor, evidence, authority = self.prepare()
        board_path = project / ".saipen" / "BOARD.md"
        board = board_path.read_text()
        ticket = parse_board(board)["tickets"]["T-7"]
        changed = set_ticket_field(ticket["raw"], "source_receipts", "SRC-999")
        board_path.write_text(board.replace(ticket["raw"], changed))
        self.assert_refused(
            self.supersede(project, successor, evidence, authority),
            "SUPERSESSION_SOURCE_MIGRATION_REQUIRED",
        )

    def test_tampered_evidence_fails_closed(self):
        project, successor, evidence, authority = self.prepare()
        log_path = project / ".saipen" / "LOG.md"
        log_path.write_text(log_path.read_text().replace("verify -> PASS", "verify -> FAIL", 1))
        self.assert_refused(
            self.supersede(project, successor, evidence, authority),
            "SUPERSESSION_EVIDENCE_INVALID",
        )


class BoardModelTests(unittest.TestCase):
    def ticket(self, fields: dict[str, str]) -> dict:
        return {"id": "T-1", "section": "## DONE", "fields": fields}

    def test_malformed_field_combinations_are_rejected(self):
        cases = (
            ({"closure_mode": "superseded_verified"}, "missing"),
            (
                {"closure_mode": "own_patch", "supersession_evidence": "E-1"},
                "outside closure_mode superseded_verified",
            ),
            (
                {
                    "closure_mode": "superseded_verified",
                    "superseded_by": "T-2",
                    "supersession_evidence": "E-1",
                    "supersession_authority": "SRC-1",
                    "closure_cohort": "C-1",
                    "implementation_delta": "none",
                },
                "only valid with closure_mode cohort",
            ),
            (
                {
                    "closure_mode": "superseded_verified",
                    "superseded_by": "T-1",
                    "supersession_evidence": "E-1",
                    "supersession_authority": "SRC-1",
                    "implementation_delta": "none",
                },
                "cannot supersede itself",
            ),
        )
        for fields, fragment in cases:
            with self.subTest(fields=fields):
                self.assertTrue(
                    any(fragment in error for error in closure_metadata_errors(self.ticket(fields)))
                )

    def test_retirement_vocabulary_is_unchanged(self):
        self.assertEqual(
            RETIREMENT_REASONS,
            ("MISROUTED_PROJECT_BINDING", "TEST_FIXTURE_CONTAMINATION"),
        )


class BoardWriterControlTests(SupersessionFixture):
    def _relocate_old(self, project: Path, section: str) -> None:
        board_path = project / ".saipen" / "BOARD.md"
        board = board_path.read_text()
        raw = parse_board(board)["tickets"]["T-7"]["raw"]
        cleaned = remove_ticket_field(remove_ticket_field(raw, "blocker"), "blocker_scope")
        board = board.replace(raw + "\n", "", 1)
        if section == "## BLOCKED":
            cleaned = set_ticket_field(cleaned, "blocker", "schedulable blocker")
            cleaned = set_ticket_field(cleaned, "blocker_scope", "ticket")
        heading = section + "\n"
        self.assertIn(heading, board)
        board_path.write_text(board.replace(heading, heading + cleaned + "\n", 1))

    def _old_row(self, project: Path) -> dict:
        return parse_board((project / ".saipen" / "BOARD.md").read_text())["tickets"]["T-7"]

    def test_supersession_closes_todo_and_blocked_with_x(self):
        for section in ("## TODO", "## BLOCKED"):
            with self.subTest(section=section):
                project, successor, evidence, authority = self.prepare()
                self._relocate_old(project, section)
                before = self._old_row(project)
                self.assertEqual(before["section"], section)
                self.assertTrue(before["raw"].startswith("- [ ] T-7 "), before["raw"])
                result = self.supersede(project, successor, evidence, authority)
                self.assertTrue(result.ok, result.to_dict())
                closed = self._old_row(project)
                self.assertEqual(closed["section"], "## DONE")
                self.assertTrue(closed["raw"].startswith("- [x] T-7 "), closed["raw"])

    def test_ordinary_finish_from_todo_stays_illegal(self):
        project, _successor, _evidence, _authority = self.prepare()
        self._relocate_old(project, "## TODO")
        result = finish_ticket(project, "T-7", "tester")
        self.assertFalse(result.ok, result.to_dict())
        self.assertNotEqual(result.code, "SUPERSEDED")
        row = self._old_row(project)
        self.assertEqual(row["section"], "## TODO")
        self.assertTrue(row["raw"].startswith("- [ ] T-7 "), row["raw"])


class RegistryParityTests(unittest.TestCase):
    def test_supersession_refusal_vocabulary_is_registry_owned(self):
        pattern = re.compile(r"SUPERSESSION_[A-Z_]+")
        found: set[str] = set()
        for module in ("operations.py", "supersession.py"):
            text = (TOOLS / "saipen_engine" / module).read_text(encoding="utf-8")
            found.update(pattern.findall(text))
        self.assertTrue(found, "expected supersession refusal vocabulary in the engine")
        self.assertEqual(
            sorted(found - set(CODES)),
            [],
            "supersession branch invented an unregistered refusal code",
        )

    def test_supersession_codes_are_the_canonical_registry_set(self):
        self.assertLessEqual(
            {
                "SUPERSESSION_SELF_CYCLE",
                "SUPERSESSION_EVIDENCE_REQUIRED",
                "SUPERSESSION_AUTHORITY_REQUIRED",
                "SUPERSESSION_OLD_NOT_SETTLEABLE",
                "SUPERSESSION_SUCCESSOR_NOT_FOUND",
                "SUPERSESSION_SUCCESSOR_NOT_DONE",
                "SUPERSESSION_CYCLE",
                "SUPERSESSION_SOURCE_MIGRATION_REQUIRED",
                "SUPERSESSION_EVIDENCE_INVALID",
            },
            set(CODES),
        )


if __name__ == "__main__":
    unittest.main()
