"""Operator-authority capture: one Source, zero Work (T-1414).

THE INCIDENT THIS ORACLE IS BUILT FROM
--------------------------------------
A valid operator retirement decision existed in the current user ingress, and
the retirement contract correctly demanded a separately persisted authority
Source (`saipen ticket retire --authority SRC-###`). Every existing way to
persist those bytes also projected Work: `start` and `user-request` minted a
second ticket for the decision itself, and `source capture` accepted any body
without validating the capsule grammar. The protocol therefore answered a
legal decision with ghost Work or an unvalidated receipt.

This oracle pins the new owner:

* `authority_capture` persists the EXACT capsule bytes as one allowed
  operator-kind Source with `projection_policy: authority_only`, and creates
  zero Work/ticket/goal/Improve rows;
* the captured receipt authorizes a real retirement end to end;
* self-authority, unrelated grants and guessed receipts still refuse;
* malformed, fenced and quoted capsules store nothing;
* repeated capture is one receipt;
* an authority-only receipt never re-projects into Work;
* the public CLI carries exact bytes through `--file` and `--hex`, and the
  guard admits the line as one canonical SAIPEN invocation.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events, intake  # noqa: E402
from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.entry import start_work  # noqa: E402
from saipen_engine.operations import retire_ticket, ticket_add  # noqa: E402

try:  # the pre-fix subject carries no capability; THIS oracle must go red there
    from saipen_engine.operations import authority_capture
except ImportError:  # pragma: no cover - exercised by the anchored red control
    authority_capture = None
from test_ticket_retirement import (  # noqa: E402
    AGENT,
    EVIDENCE_REL,
    REASON,
    RetirementFixture,
    authority_text,
    capsule,
)

SAIPEN_PY = TOOLS / "saipen.py"


def _capture(project: Path, text: str, *, dry_run: bool = False):
    assert authority_capture is not None, (
        "authority_capture is missing on this subject -- the ROOT A capability "
        "does not exist, which is exactly the pre-fix red"
    )
    return authority_capture(project, AGENT, text, dry_run=dry_run)


def _cli(project: Path, *args: str) -> dict:
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT")
    }
    run = subprocess.run(
        [
            sys.executable,
            str(SAIPEN_PY),
            "--project-root",
            str(project),
            "--agent",
            AGENT,
            "--json",
            *args,
        ],
        cwd=str(project),
        capture_output=True,
        text=True,
        errors="replace",
        timeout=300,
        env=env,
    )
    blob = (run.stdout or "") + (run.stderr or "")
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return {"ok": False, "code": "CLI_CRASH", "detail": blob[-800:]}


def _active_receipts(project: Path) -> list[str]:
    active = project / ".saipen" / "intake" / "active"
    if not active.is_dir():
        return []
    return sorted(path.name for path in active.glob("SRC-*.md"))


def _tickets(project: Path) -> dict:
    board = parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
    return board["tickets"]


class AuthorityCaptureTests(RetirementFixture):
    def test_capture_persists_exact_authority_source_and_zero_work(self) -> None:
        project = self.make_project()
        _parent, child, child_receipt = self.contaminated_chain(project)
        before = _tickets(project)
        text = authority_text(child, child_receipt)

        result = _capture(project, text)

        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "AUTHORITY_CAPTURED")
        payload = result.data
        receipt = payload["receipt"]
        self.assertNotEqual(receipt, child_receipt)
        self.assertEqual(payload["source_sha256"], hashlib.sha256(text.encode("utf-8")).hexdigest())
        self.assertEqual(payload["projection_policy"], "authority_only")
        self.assertIsNone(payload["linked_work"])
        self.assertTrue(str(payload["operation_id"]).startswith("authority-capture-"))
        meta = json.loads(
            (project / ".saipen" / "intake" / "active" / f"{receipt}.meta.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(meta["projection_policy"], "authority_only")
        self.assertEqual(meta["source_kind"], "user_instruction")
        self.assertEqual(meta["source_sha256"], payload["source_sha256"])
        self.assertIsNone(meta["linked_work"])
        body = (project / ".saipen" / "intake" / "active" / f"{receipt}.md").read_text(
            encoding="utf-8"
        )
        self.assertEqual(body, text)
        self.assertEqual(_tickets(project), before, "authority capture projected Work")

    def test_captured_authority_retires_the_work_end_to_end(self) -> None:
        project = self.make_project()
        _parent, child, child_receipt = self.contaminated_chain(project)
        captured = _capture(project, authority_text(child, child_receipt))
        self.assertTrue(captured.ok, captured.to_dict())

        retired = retire_ticket(
            project,
            child,
            AGENT,
            reason=REASON,
            evidence=EVIDENCE_REL,
            authority=captured.data["receipt"],
        )

        self.assertTrue(retired.ok, retired.to_dict())
        self.assertEqual(retired.code, "RETIRED")
        record = json.loads(
            (
                project
                / ".saipen"
                / "archive"
                / "retired"
                / f"{child}.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(record["authority_receipt"], captured.data["receipt"])
        self.assertEqual(record["reason"], REASON)

    def test_self_receipt_cannot_authorize(self) -> None:
        project = self.make_project()
        _parent, child, child_receipt = self.contaminated_chain(project)
        refused = retire_ticket(
            project,
            child,
            AGENT,
            reason=REASON,
            evidence=EVIDENCE_REL,
            authority=child_receipt,
        )
        self.assertFalse(refused.ok)
        self.assertEqual(refused.code, "RETIREMENT_AUTHORITY_REQUIRED")

    def test_unrelated_grant_cannot_authorize(self) -> None:
        project = self.make_project()
        _parent, child, _child_receipt = self.contaminated_chain(project)
        added = ticket_add(
            project,
            AGENT,
            "P2",
            "unrelated queued work the grant must not cover",
            [],
            "unrelated acceptance runs",
        )
        self.assertTrue(added.ok, added.to_dict())
        other = added.data["ticket"]
        capsule_text = authority_text(other, None)
        captured = _capture(project, capsule_text)
        self.assertTrue(captured.ok, captured.to_dict())
        refused = retire_ticket(
            project,
            child,
            AGENT,
            reason=REASON,
            evidence=EVIDENCE_REL,
            authority=captured.data["receipt"],
        )
        self.assertFalse(refused.ok)
        self.assertEqual(refused.code, "RETIREMENT_AUTHORITY_REQUIRED")

    def test_guessed_receipt_cannot_authorize(self) -> None:
        project = self.make_project()
        _parent, child, _child_receipt = self.contaminated_chain(project)
        refused = retire_ticket(
            project,
            child,
            AGENT,
            reason=REASON,
            evidence=EVIDENCE_REL,
            authority="SRC-999",
        )
        self.assertFalse(refused.ok)
        self.assertEqual(refused.code, "RETIREMENT_AUTHORITY_REQUIRED")

    def test_malformed_capsule_creates_no_receipt(self) -> None:
        project = self.make_project()
        before = _active_receipts(project)
        result = _capture(project, "operator notes with no capsule at all\n")
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "INVALID_AUTHORITY_CAPTURE")
        self.assertIn("capsule", result.message)
        self.assertEqual(_active_receipts(project), before)

    def test_fenced_and_quoted_capsules_refuse(self) -> None:
        project = self.make_project()
        before = _active_receipts(project)
        grant = "T-7 / SRC-001"
        fenced = "```\n" + capsule(grant) + "```\n"
        quoted = '"' + capsule(grant).strip().replace("\n", " ") + '"\n'
        for text in (fenced, quoted):
            result = _capture(project, text)
            self.assertFalse(result.ok, result.to_dict())
            self.assertEqual(result.code, "INVALID_AUTHORITY_CAPTURE")
        self.assertEqual(_active_receipts(project), before)

    def test_duplicate_capture_returns_the_same_receipt(self) -> None:
        project = self.make_project()
        _parent, child, child_receipt = self.contaminated_chain(project)
        text = authority_text(child, child_receipt)
        first = _capture(project, text)
        self.assertTrue(first.ok, first.to_dict())
        second = _capture(project, text)
        self.assertTrue(second.ok, second.to_dict())
        self.assertEqual(second.code, "AUTHORITY_ALREADY_CAPTURED")
        self.assertEqual(second.data["receipt"], first.data["receipt"])
        self.assertEqual(second.data["source_sha256"], first.data["source_sha256"])
        self.assertEqual(_active_receipts(project).count(f"{first.data['receipt']}.md"), 1)

    def test_authority_receipt_never_projects_work(self) -> None:
        project = self.make_project()
        _parent, child, child_receipt = self.contaminated_chain(project)
        captured = _capture(project, authority_text(child, child_receipt))
        self.assertTrue(captured.ok, captured.to_dict())
        receipt = captured.data["receipt"]
        before = _tickets(project)

        started = start_work(
            project,
            AGENT,
            actor_source="test",
            receipt=receipt,
        )

        self.assertFalse(started.get("ok"))
        self.assertIn("authority_only", str(started.get("detail") or ""))
        self.assertEqual(_tickets(project), before)

    def test_capture_rejects_unknown_projection_policy(self) -> None:
        project = self.make_project()
        refused = intake.capture(
            project,
            "anything\n",
            source_kind="user_instruction",
            projection_policy="authority_only_ish",
        )
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["code"], "VALIDATION_FAILED")

    def test_dry_run_writes_nothing(self) -> None:
        project = self.make_project()
        _parent, child, child_receipt = self.contaminated_chain(project)
        before_receipts = _active_receipts(project)
        before_tickets = _tickets(project)
        planned = _capture(project, authority_text(child, child_receipt), dry_run=True)
        self.assertTrue(planned.ok, planned.to_dict())
        self.assertEqual(planned.code, "PLAN")
        self.assertEqual(_active_receipts(project), before_receipts)
        self.assertEqual(_tickets(project), before_tickets)

    def test_cli_file_and_hex_transport(self) -> None:
        project = self.make_project()
        _parent, child, child_receipt = self.contaminated_chain(project)
        text = authority_text(child, child_receipt)
        carrier = project / "capsule.txt"
        carrier.write_bytes(text.encode("utf-8"))

        from_file = _cli(project, "authority", "capture", "--file", str(carrier))
        self.assertTrue(from_file.get("ok"), from_file)
        self.assertEqual(from_file.get("code"), "AUTHORITY_CAPTURED")
        from_hex = _cli(project, "authority", "capture", "--hex", text.encode("utf-8").hex())
        self.assertTrue(from_hex.get("ok"), from_hex)
        self.assertEqual(from_hex.get("code"), "AUTHORITY_ALREADY_CAPTURED")
        self.assertEqual(from_hex.get("receipt"), from_file.get("receipt"))
        self.assertEqual(from_hex.get("source_sha256"), from_file.get("source_sha256"))

    def test_cli_carrier_and_byte_errors(self) -> None:
        project = self.make_project()
        both = _cli(
            project,
            "authority",
            "capture",
            "--file",
            "x.txt",
            "--hex",
            "41",
        )
        self.assertFalse(both.get("ok"))
        self.assertEqual(both.get("code"), "VALIDATION_FAILED")
        bad_hex = _cli(project, "authority", "capture", "--hex", "zz")
        self.assertFalse(bad_hex.get("ok"))
        self.assertEqual(bad_hex.get("code"), "VALIDATION_FAILED")
        missing_action = _cli(project, "authority")
        self.assertFalse(missing_action.get("ok"))
        self.assertEqual(missing_action.get("code"), "VALIDATION_FAILED")

    def test_guard_admits_authority_capture_as_canonical(self) -> None:
        tokens = guard_events._saipen_cli_tokens("saipen authority capture --hex 414243 --json")
        self.assertIsNotNone(tokens)
        self.assertEqual(tokens[1], "authority")
        from saipen_engine import command_effects

        self.assertEqual(
            command_effects.classify_invocation("authority", ["capture", "--file", "x"]),
            command_effects.INGRESS,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
