"""Canonical retirement of misrouted Work (T-1370).

THE INCIDENT THIS ORACLE IS BUILT FROM
--------------------------------------
A field fixture ran with its working directory inside a sandbox worktree while
`PWD` still named the SAIPEN repository. The host trusted `PWD`, so a weak
model's `saipen start` minted real receipts and real Work **in the wrong
project**: SRC-047/T-1368 and SRC-048/T-1369, plus `src/app.py`.

The polygon is fixed. The ledger is not, and the protocol had no truthful way
to clear it:

    T-1367 (P0, real Work)  BLOCKED_ON  T-1368
    T-1368 (contamination)  BLOCKED_ON  T-1369
    T-1369 (contamination)  TODO, holding the single DOING seat

`RedSubjectTests` proves that chain is a genuine DEADLOCK on the pre-T-1370
surface: every canonical door refuses, and the only openings are
fabrications. `GreenPathTests` proves `ticket retire` opens it honestly.
`HostileControlTests` is the eight-control matrix that keeps it from becoming
a general-purpose ticket deleter.

THE REVIEW THAT HARDENED IT (SRC-050)
-------------------------------------
* `AuthorityCapsuleTests` -- a MENTION is not an AUTHORIZATION. The first
  gate accepted any body containing both identifiers, so "DO NOT retire
  T-1369 / SRC-048" authorized retiring T-1369. Authority is now a bounded
  capsule, and SRC-049 stays representable exactly as the operator wrote it.
* `EvidenceContractTests` -- "trust me this was wrong" is not evidence.
* `TamperControlTests` -- the forensic archive is evidence; every drift an
  attacker can make after a successful retirement turns the validator RED.
* `ParentOwnershipTests` -- being authorized to retire a child grants nothing
  over the parent: it goes back to its own reserved seat.
* `LegacyReaffirmationTests` -- the first slice's schema-1 records are not
  valid state and are not rewritten either; they are re-affirmed as a new
  event.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import fast_check, intake  # noqa: E402
from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.journal import ensure_project_lineage  # noqa: E402
from saipen_engine.log import read_history_snapshot  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    checkpoint,
    finish_ticket,
    retire_ticket,
    ticket_add,
    ticket_move,
    user_request,
)
from saipen_engine.retirement import (  # noqa: E402
    EVIDENCE_DIR,
    GRANT_HEADER,
    GRANT_TERMINATOR,
    RETIRED_DIR,
    RETIREMENT_REASONS,
    authority_grants,
    load_ticket_retirement,
    read_ticket_retirement,
    retired_ticket_ref,
    ticket_record_errors,
)
from saipen_engine.state import parse_state  # noqa: E402

AGENT = "tester"
REASON = "MISROUTED_PROJECT_BINDING"
EVIDENCE_REL = f"{EVIDENCE_DIR}/incident/README.md"
EVIDENCE_BYTES = (
    b"# PWD incident\n\nfixture cwd + repository PWD minted this Work in the wrong project.\n"
)


def capsule(*grants: str) -> str:
    """The operator-authority capsule, in the exact shape SRC-049 used."""
    items = "".join(f"    {grant}\n" for grant in grants)
    return f"{GRANT_HEADER}\n\n{items}\n{GRANT_TERMINATOR}\n"


def authority_text(ticket: str, receipt: str | None) -> str:
    grant = f"{ticket} / {receipt}" if receipt else ticket
    return (
        "OPERATOR DECISION\n\n"
        f"{ticket} is CONFIRMED FIELD-FIXTURE CONTAMINATION and is NOT legitimate "
        "Work for this project.\n"
        "Do not fabricate coverage. Do not mark it DONE.\n\n" + capsule(grant)
    )


class RetirementFixture(unittest.TestCase):
    """The exact incident chain, built through canonical operations only."""

    def make_project(self, agent: str = AGENT) -> Path:
        base = Path(tempfile.mkdtemp(prefix="saipen-retire-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        (project / ".saipen").mkdir(parents=True)
        now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: BUILD\n"
            "task: T-7\n"
            'next_action: "PHASE BUILD T-7"\n'
            'blocker: ""\n'
            "transition_from: SCOUT\n"
            "saipen_version: 8\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            f"agent: {agent}\n"
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            f'updated: "{now}"\n'
            "---\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n"
            f"- [/] T-7 [P0] Real project Work the incident parked | "
            f"verify: the real acceptance runs on the installed runtime | "
            f"owner: {agent} | claim_time: {now}\n"
            "## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "LOG.md").write_text(
            f"- 16.09.26 00:00 [E-001] [T-7] [agent: {agent}] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        evidence = project / EVIDENCE_REL
        evidence.parent.mkdir(parents=True)
        evidence.write_bytes(EVIDENCE_BYTES)
        ensure_project_lineage(project)
        return project

    def contaminated_chain(self, project: Path, agent: str = AGENT) -> tuple[str, str, str]:
        """(parent, bogus child, child receipt) -- the real dependency shape."""
        minted = user_request(project, agent, "add a one-line docstring to the top of src/app.py")
        self.assertTrue(minted.ok, minted.to_dict())
        child = minted.data["ticket"]
        receipt = minted.data["receipt"]
        blocked = ticket_move(
            project,
            "block-for",
            "T-7",
            agent,
            "PAUSED by user request: the explicit new task takes the seat",
            blocked_on=child,
        )
        self.assertTrue(blocked.ok, blocked.to_dict())
        return "T-7", child, receipt

    def capture(self, project: Path, text: str, kind: str = "user_instruction") -> str:
        captured = intake.capture(project, text, source_kind=kind)
        self.assertTrue(captured["ok"], captured)
        return captured["receipt"]

    def authority(self, project: Path, ticket: str, receipt: str | None, agent: str = AGENT) -> str:
        """Capture the operator decision the way the real one arrived."""
        decision = user_request(project, agent, authority_text(ticket, receipt))
        self.assertTrue(decision.ok, decision.to_dict())
        return decision.data["receipt"]

    def board(self, project: Path) -> dict:
        return parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))

    def state(self, project: Path) -> dict:
        return parse_state((project / ".saipen" / "STATE.md").read_text(encoding="utf-8"))

    def log(self, project: Path) -> str:
        return (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")

    def retire(self, project: Path, ticket: str, authority: str, agent: str = AGENT, **kw):
        return retire_ticket(
            project,
            ticket,
            agent,
            reason=kw.pop("reason", REASON),
            evidence=kw.pop("evidence", EVIDENCE_REL),
            authority=authority,
            **kw,
        )

    def retired(self, project: Path) -> tuple[str, str, str, str]:
        """(parent, child, receipt, authority) after one successful retirement."""
        parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        result = self.retire(project, child, authority)
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(intake.validate_project(project), [])
        return parent, child, receipt, authority

    # -- raw forensic file access for the tamper controls ---------------------

    def read_json(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def write_json(self, path: Path, doc: dict) -> None:
        path.write_bytes(intake._json_bytes(doc))

    def set_index_tombstone(self, project: Path, receipt: str, tomb: dict) -> None:
        index_path = project / ".saipen" / "intake" / "index.json"
        index = self.read_json(index_path)
        index["tombstones"][receipt] = tomb
        self.write_json(index_path, index)

    def assertRed(self, project: Path, fragment: str) -> list[str]:
        errors = intake.validate_project(project)
        self.assertTrue(errors, "validation stayed green after tampering")
        self.assertTrue(
            any(fragment in error for error in errors),
            f"expected an error containing {fragment!r}, got {errors}",
        )
        return errors


class RedSubjectTests(RetirementFixture):
    """The pre-T-1370 surface, and why it could not resolve this honestly."""

    def test_reserved_bogus_child_deadlocks_every_claim(self):
        project = self.make_project()
        parent, _child, _receipt = self.contaminated_chain(project)

        # The parent cannot take its own seat back: it is parked under
        # ## BLOCKED and only the child's completion may move it.
        stolen = apply_claim(project, parent, AGENT, explicit=True)
        self.assertFalse(stolen.ok)
        self.assertEqual(stolen.code, "TICKET_NOT_WORKABLE")

        # Neither can anything else, including a P0 explicit override -- which
        # is exactly why the ticket that REPAIRS this could not be claimed.
        other = ticket_add(
            project, AGENT, "P0", "the repair Work itself", [], "the repair is demonstrated"
        )
        self.assertTrue(other.ok, other.to_dict())
        blocked = apply_claim(project, other.data["ticket"], AGENT, explicit=True)
        self.assertFalse(blocked.ok)
        self.assertEqual(blocked.code, "CONTINUATION_RESERVED")

    def test_finishing_the_bogus_child_is_refused(self):
        """`ticket done` is not an escape: it demands source coverage."""
        project = self.make_project()
        _parent, child, _receipt = self.contaminated_chain(project)
        closed = finish_ticket(project, child, AGENT)
        self.assertFalse(closed.ok, closed.to_dict())
        # SOURCE_UNRESOLVED is the sharpest form of the RED: the only way
        # through `ticket done` is to invent a terminal disposition for a
        # request this project never implemented.
        self.assertIn(
            closed.code,
            {"SOURCE_UNRESOLVED", "INCOMPLETE_TICKET", "ILLEGAL_TICKET_LIFECYCLE"},
        )

    def test_closing_the_bogus_source_is_refused(self):
        """`source close` is not an escape either: coverage is unresolved."""
        project = self.make_project()
        _parent, _child, receipt = self.contaminated_chain(project)
        closed = intake.close_receipt(project, receipt)
        self.assertFalse(closed["ok"], closed)
        self.assertIn(closed["code"], {"SOURCE_UNRESOLVED", "SOURCE_WORK_ACTIVE"})

    def test_no_retirement_record_exists_before_the_operation_runs(self):
        project = self.make_project()
        _parent, child, _receipt = self.contaminated_chain(project)
        self.assertIsNone(read_ticket_retirement(project, child))
        self.assertFalse((project / RETIRED_DIR).exists())


class GreenPathTests(RetirementFixture):
    """Retirement resolves the chain without a single fabricated fact."""

    def test_retiring_the_child_restores_the_parent_to_its_saved_phase(self):
        project = self.make_project()
        parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)

        # The parent is parked at the phase it was working when it was
        # interrupted; that tuple is what must come back.
        parked = self.board(project)["tickets"][parent]
        self.assertEqual(parked["section"], "## BLOCKED")
        self.assertEqual(parked["fields"]["resume_phase"], "BUILD")

        result = self.retire(project, child, authority)
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "RETIRED")
        self.assertEqual(result.data["restored_parent"], parent)
        self.assertEqual(result.data["restored_parent_owner"], AGENT)

        board = self.board(project)
        self.assertNotIn(child, board["tickets"], "retired Work is still schedulable")
        restored = board["tickets"][parent]
        self.assertEqual(restored["section"], "## DOING")
        self.assertNotIn("blocker", restored["fields"])
        self.assertNotIn("blocked_on", restored["fields"])
        self.assertNotIn("resume_phase", restored["fields"])

        state = self.state(project)
        self.assertEqual(state["phase"], "BUILD")
        self.assertEqual(state["task"], parent)
        self.assertEqual(state["next_action"], f"PHASE BUILD {parent}")

    def test_nothing_is_marked_done_and_no_coverage_is_invented(self):
        project = self.make_project()
        _parent, _child, receipt, _authority = self.retired(project)

        board = self.board(project)
        self.assertEqual(
            [t["id"] for t in board["tickets"].values() if t["section"] == "## DONE"],
            [],
            "retirement must never produce a DONE row",
        )
        status = intake.status(project, receipt)
        self.assertTrue(status["ok"], status)
        self.assertEqual(status["status"], intake.INVALID_STATUS)
        self.assertEqual(status["location"], "retired")
        self.assertEqual(status["reason"], REASON)

        # The preserved coverage still says what was true: nothing was done.
        cold = json.loads(
            (project / RETIRED_DIR / f"{receipt}.coverage.json").read_text(encoding="utf-8")
        )
        dispositions = {req.get("disposition") for req in cold.get("requirements", {}).values()}
        self.assertNotIn("IMPLEMENTED", dispositions)
        self.assertNotIn("VERIFIED", dispositions)

    def test_the_source_bytes_survive_verbatim_and_stay_retrievable(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        original = (project / ".saipen" / "intake" / "active" / f"{receipt}.md").read_bytes()
        authority = self.authority(project, child, receipt)
        self.assertTrue(self.retire(project, child, authority).ok)

        self.assertFalse((project / ".saipen" / "intake" / "active" / f"{receipt}.md").exists())
        cold = project / RETIRED_DIR / f"{receipt}.md"
        self.assertEqual(cold.read_bytes(), original, "retirement rewrote the request")

        # And the canonical forensic reader finds them without knowing where
        # they went.
        body = intake.read_body(project, receipt)
        self.assertTrue(body["ok"], body)
        self.assertEqual(body["body"].encode("utf-8"), original)

    def test_the_ledger_can_still_answer_what_the_ticket_was(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        board_record = self.board(project)["tickets"][child]["raw"]
        result = self.retire(project, child, authority)
        self.assertTrue(result.ok, result.to_dict())

        record = read_ticket_retirement(project, child)
        self.assertIsNotNone(record)
        self.assertEqual(record["ticket"], child)
        self.assertEqual(record["board_record"], board_record)
        self.assertEqual(record["reason"], REASON)
        self.assertEqual(record["authority_receipt"], authority)
        self.assertEqual(record["authority_grant"], f"{child} / {receipt}")
        self.assertEqual(record["retired_by"], AGENT)
        self.assertEqual(record["source_receipts"], [receipt])
        self.assertEqual(
            record["evidence"],
            {
                "kind": "artifact",
                "ref": EVIDENCE_REL,
                "sha256": hashlib.sha256(EVIDENCE_BYTES).hexdigest(),
            },
        )
        self.assertIsNone(record["discovery_event"])
        self.assertEqual(record["evidence_bound_event"], record["retirement_event"])

        # LOG is the permanent half and it names all of it, inline.
        line = [ln for ln in self.log(project).splitlines() if "RETIRE" in ln]
        self.assertEqual(len(line), 1, self.log(project))
        self.assertIn(child, line[0])
        self.assertIn(REASON, line[0])
        self.assertIn(authority, line[0])
        self.assertIn(f"sha256:{record['evidence']['sha256']}", line[0])
        self.assertIn(f"[{record['retirement_event']}]", line[0])

    def test_project_validation_is_green_after_retirement(self):
        project = self.make_project()
        self.retired(project)

    def test_the_whole_chain_unwinds_in_causal_order(self):
        """Retire the grandchild, then the child; the P0 parent comes back."""
        project = self.make_project()
        parent, child, child_receipt = self.contaminated_chain(project)
        # child now holds the seat; give it a bogus child of its own, exactly
        # like T-1368 -> T-1369.
        self.assertTrue(apply_claim(project, child, AGENT).ok)
        minted = user_request(project, AGENT, "add a docstring explaining what src/app.py does")
        grandchild = minted.data["ticket"]
        grand_receipt = minted.data["receipt"]
        self.assertTrue(
            ticket_move(
                project, "block-for", child, AGENT, "second explicit task", blocked_on=grandchild
            ).ok
        )
        # ONE operator decision covering both, exactly like SRC-049.
        decision = user_request(
            project,
            AGENT,
            "OPERATOR DECISION\n\nBoth are contamination.\n\n"
            + capsule(f"{child} / {child_receipt}", f"{grandchild} / {grand_receipt}"),
        )
        self.assertTrue(decision.ok, decision.to_dict())
        authority = decision.data["receipt"]

        first = self.retire(project, grandchild, authority)
        self.assertTrue(first.ok, first.to_dict())
        self.assertEqual(self.board(project)["tickets"][child]["section"], "## DOING")
        self.assertEqual(self.state(project)["task"], child)

        second = self.retire(project, child, authority)
        self.assertTrue(second.ok, second.to_dict())
        board = self.board(project)
        self.assertNotIn(child, board["tickets"])
        self.assertNotIn(grandchild, board["tickets"])
        self.assertEqual(board["tickets"][parent]["section"], "## DOING")
        self.assertEqual(self.state(project)["phase"], "BUILD")
        self.assertEqual(self.state(project)["task"], parent)
        self.assertEqual(intake.validate_project(project), [])


class HostileControlTests(RetirementFixture):
    """The eight controls that keep this from becoming `rm -rf ticket`."""

    def test_control_1_ordinary_todo_without_authority_is_refused(self):
        project = self.make_project()
        added = ticket_add(
            project, AGENT, "P2", "an ordinary queued improvement", [], "the improvement ships"
        )
        ticket = added.data["ticket"]
        missing = self.retire(project, ticket, "")
        self.assertFalse(missing.ok)
        self.assertEqual(missing.code, "RETIREMENT_AUTHORITY_REQUIRED")

        # Even a REAL operator decision does not cover a ticket it never grants.
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        uncovered = self.retire(project, ticket, authority)
        self.assertFalse(uncovered.ok, uncovered.to_dict())
        self.assertEqual(uncovered.code, "RETIREMENT_AUTHORITY_REQUIRED")
        self.assertIn(ticket, uncovered.message)
        self.assertIn(ticket, self.board(project)["tickets"])

    def test_control_2_completed_work_cannot_be_rewritten_as_misrouted(self):
        project = self.make_project()
        done = ticket_add(project, AGENT, "P2", "finished Work", [], "proved by its own run")
        ticket = done.data["ticket"]
        board_path = project / ".saipen" / "BOARD.md"
        text = board_path.read_text(encoding="utf-8")
        row = next(ln for ln in text.splitlines() if ln.startswith(f"- [ ] {ticket} "))
        text = text.replace(row + "\n", "")
        text = text.replace("## DONE\n", "## DONE\n" + row.replace("- [ ] ", "- [x] ", 1) + "\n")
        board_path.write_text(text, encoding="utf-8")

        authority = self.capture(project, authority_text(ticket, None))
        refused = self.retire(project, ticket, authority)
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertEqual(refused.code, "TICKET_ALREADY_DONE")

    def test_control_3_a_foreign_live_owner_needs_explicit_coverage(self):
        """A ticket another seat is actively working is not quietly removable."""
        project = self.make_project()
        _parent, child, _receipt = self.contaminated_chain(project)
        # An operator decision about a DIFFERENT ticket must not reach it.
        elsewhere = self.capture(project, authority_text("T-4242", "SRC-999"))
        refused = self.retire(project, child, elsewhere)
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertEqual(refused.code, "RETIREMENT_AUTHORITY_REQUIRED")
        self.assertIn(child, self.board(project)["tickets"])

    def test_control_4_receipt_digest_mismatch_fails_closed(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        body = project / ".saipen" / "intake" / "active" / f"{receipt}.md"
        body.write_text(body.read_text(encoding="utf-8") + "\ntampered\n", encoding="utf-8")
        refused = self.retire(project, child, authority)
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertIn("SOURCE_CORRUPTION", refused.message)
        self.assertIn(child, self.board(project)["tickets"])
        self.assertFalse((project / RETIRED_DIR).exists())

    def test_control_5_crossed_ticket_receipt_linkage_fails_closed(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        meta_path = project / ".saipen" / "intake" / "active" / f"{receipt}.meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["linked_work"] = "T-4242"
        meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True), encoding="utf-8")
        refused = self.retire(project, child, authority)
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertIn("crossed ticket/receipt linkage", refused.message)
        self.assertIn(child, self.board(project)["tickets"])

    def test_control_6_unknown_reason_fails_closed(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        for bogus in ("", "MISROUTED", "misrouted_project_binding ", "ANY_REASON_I_LIKE"):
            refused = self.retire(project, child, authority, reason=bogus)
            self.assertFalse(refused.ok, bogus)
            self.assertEqual(refused.code, "RETIREMENT_REASON_UNKNOWN", bogus)
        self.assertIn(child, self.board(project)["tickets"])
        self.assertEqual(RETIREMENT_REASONS, (REASON, "TEST_FIXTURE_CONTAMINATION"))

    def test_control_7_repeating_a_retirement_is_deterministic(self):
        project = self.make_project()
        _parent, child, _receipt, authority = self.retired(project)
        board_before = (project / ".saipen" / "BOARD.md").read_bytes()
        log_before = (project / ".saipen" / "LOG.md").read_bytes()

        again = self.retire(project, child, authority)
        self.assertTrue(again.ok, again.to_dict())
        self.assertEqual(again.code, "ALREADY_RETIRED")
        self.assertEqual((project / ".saipen" / "BOARD.md").read_bytes(), board_before)
        self.assertEqual((project / ".saipen" / "LOG.md").read_bytes(), log_before)

    def test_control_8_a_crash_mid_transaction_converges(self):
        """Crash after the hot-surface delete; recovery reaches ONE result."""
        for stage in ("NITRO_CRASH_AFTER_LOG", "NITRO_CRASH_AFTER_DELETE_FILE"):
            with self.subTest(stage=stage):
                project = self.make_project()
                parent, child, receipt = self.contaminated_chain(project)
                authority = self.authority(project, child, receipt)
                command = [
                    sys.executable,
                    str(ROOT / "tools" / "saipen.py"),
                    "ticket",
                    "retire",
                    child,
                    "--reason",
                    REASON,
                    "--evidence",
                    EVIDENCE_REL,
                    "--authority",
                    authority,
                    "--project-root",
                    str(project),
                    "--json",
                ]
                env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
                env[stage] = "1"
                crashed = subprocess.run(
                    command, capture_output=True, text=True, env=env, timeout=120
                )
                self.assertNotEqual(crashed.returncode, 0, crashed.stdout)

                recovered = subprocess.run(
                    [
                        sys.executable,
                        str(ROOT / "tools" / "saipen.py"),
                        "recover",
                        "--project-root",
                        str(project),
                        "--json",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                self.assertEqual(recovered.returncode, 0, recovered.stderr or recovered.stdout)
                board = self.board(project)
                state = self.state(project)
                if child in board["tickets"]:
                    # Rolled BACK: the chain is exactly as it was, and no
                    # half-archived receipt is left behind.
                    self.assertEqual(board["tickets"][parent]["section"], "## BLOCKED")
                    self.assertTrue(
                        (project / ".saipen" / "intake" / "active" / f"{receipt}.md").is_file()
                    )
                else:
                    # Rolled FORWARD: the complete new set, never a fragment.
                    self.assertEqual(board["tickets"][parent]["section"], "## DOING")
                    self.assertEqual(state["task"], parent)
                    self.assertIsNotNone(read_ticket_retirement(project, child))
                    self.assertTrue((project / RETIRED_DIR / f"{receipt}.md").is_file())
                    self.assertFalse(
                        (project / ".saipen" / "intake" / "active" / f"{receipt}.md").is_file()
                    )
                self.assertEqual(intake.validate_project(project), [])


class AuthorityCapsuleTests(RetirementFixture):
    """A mention is not an authorization (SRC-050 A)."""

    def assertRefusedWith(self, project: Path, child: str, text: str, kind="user_instruction"):
        authority = self.capture(project, text, kind)
        refused = self.retire(project, child, authority)
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertEqual(refused.code, "RETIREMENT_AUTHORITY_REQUIRED", refused.message)
        self.assertIn(child, self.board(project)["tickets"])
        self.assertFalse((project / RETIRED_DIR).exists())
        return refused

    def test_red_a_negative_mention_naming_both_identities_is_refused(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        text = f"OPERATOR DECISION\n\nDO NOT retire {child} / {receipt}.\n"
        # The old gate's whole proof was token presence -- and this text has
        # both tokens. That is the RED this control keeps closed.
        self.assertIn(child, text)
        self.assertIn(receipt, text)
        refused = self.assertRefusedWith(project, child, text)
        self.assertIn("naming Work is not authorizing it", refused.message)

    def test_a_quoted_capsule_inside_a_code_fence_grants_nothing(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        text = (
            "Never write this unless you mean it:\n\n```\n"
            + capsule(f"{child} / {receipt}")
            + "```\n"
        )
        self.assertRefusedWith(project, child, text)

    def test_an_unterminated_capsule_grants_nothing(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        text = f"{GRANT_HEADER}\n\n    {child} / {receipt}\n"
        refused = self.assertRefusedWith(project, child, text)
        self.assertIn("never closed", refused.message)

    def test_a_capsule_with_prose_inside_grants_nothing(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        text = (
            f"{GRANT_HEADER}\n\n    {child} / {receipt}\n"
            f"    but DO NOT retire {child}\n\n{GRANT_TERMINATOR}\n"
        )
        self.assertRefusedWith(project, child, text)

    def test_a_grant_for_another_receipt_is_refused(self):
        project = self.make_project()
        _parent, child, _receipt = self.contaminated_chain(project)
        refused = self.assertRefusedWith(project, child, capsule(f"{child} / SRC-999"))
        self.assertIn("must name exactly the linkage", refused.message)

    def test_a_bare_grant_for_work_that_carries_a_receipt_is_refused(self):
        project = self.make_project()
        _parent, child, _receipt = self.contaminated_chain(project)
        self.assertRefusedWith(project, child, capsule(child))

    def test_conflicting_grants_grant_nothing(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        text = capsule(f"{child} / {receipt}") + "\n" + capsule(f"{child} / SRC-999")
        refused = self.assertRefusedWith(project, child, text)
        self.assertIn("conflicting receipt sets", refused.message)

    def test_an_imported_specification_cannot_carry_operator_authority(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        refused = self.assertRefusedWith(
            project, child, authority_text(child, receipt), kind="imported_spec"
        )
        self.assertIn("operator's own ingress", refused.message)

    def test_the_grammar_is_a_closed_line_grammar(self):
        self.assertEqual(authority_grants("DO NOT retire T-999 / SRC-999").grants, {})
        self.assertEqual(authority_grants("retire T-999 / SRC-999 now").grants, {})
        parsed = authority_grants(capsule("T-5 / SRC-2, SRC-1", "T-6"))
        self.assertEqual(parsed.grants, {"T-5": ("SRC-1", "SRC-2"), "T-6": ()})
        self.assertEqual(parsed.problems, ())
        # Leading indentation or a quote marker turns the header into prose.
        self.assertEqual(authority_grants("> " + capsule("T-5 / SRC-2")).grants, {})
        self.assertEqual(authority_grants("  " + capsule("T-5 / SRC-2")).grants, {})

    def test_src_049_stays_representable_exactly_as_the_operator_wrote_it(self):
        """The grammar is lifted from the real decision, byte for byte."""
        excerpt = (
            "Retirement requires strong proof + explicit operator authority.\n\n"
            "This message supplies operator authority for:\n\n"
            "    T-1368 / SRC-047\n"
            "    T-1369 / SRC-048\n\n"
            "only.\n"
        )
        parsed = authority_grants(excerpt)
        self.assertEqual(parsed.grants, {"T-1368": ("SRC-047",), "T-1369": ("SRC-048",)})
        self.assertEqual(parsed.lines["T-1369"], "T-1369 / SRC-048")

        body = intake.read_body(ROOT, "SRC-049")
        if not body.get("ok"):
            self.skipTest("the SAIPEN repository's SRC-049 body is not readable here")
        real = authority_grants(body["body"])
        self.assertEqual(real.grants, {"T-1368": ("SRC-047",), "T-1369": ("SRC-048",)})
        self.assertEqual(real.problems, ())


class EvidenceContractTests(RetirementFixture):
    """Free text is a claim; evidence resolves (SRC-050 E)."""

    def test_unresolvable_evidence_is_refused(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        (project / ".saipen" / "evidence" / "folder").mkdir()
        for bogus in (
            "",
            "   ",
            "n/a",
            "see above",
            "trust me this was wrong",
            f"{EVIDENCE_DIR}/missing.md",
            f"{EVIDENCE_DIR}/folder",
            f"{EVIDENCE_DIR}/../STATE.md",
            ".saipen/STATE.md",
            "E-999999",
            "E-0",
        ):
            with self.subTest(evidence=bogus):
                refused = self.retire(project, child, authority, evidence=bogus)
                self.assertFalse(refused.ok, bogus)
                self.assertEqual(refused.code, "VALIDATION_FAILED", refused.message)
        self.assertIn(child, self.board(project)["tickets"])

    def test_a_canonical_event_that_precedes_the_retirement_is_evidence(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        result = self.retire(project, child, authority, evidence="E-1")
        self.assertTrue(result.ok, result.to_dict())
        record = read_ticket_retirement(project, child)
        self.assertEqual(record["evidence"], {"kind": "event", "ref": "E-1"})
        self.assertEqual(intake.validate_project(project), [])

    def test_discovery_event_is_optional_and_must_be_real_history(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        for bogus in ("E-999999", "yesterday"):
            refused = self.retire(project, child, authority, discovery_event=bogus)
            self.assertFalse(refused.ok, bogus)
            self.assertEqual(refused.code, "VALIDATION_FAILED")
        result = self.retire(project, child, authority, discovery_event="E-1", note="seen in run 1")
        self.assertTrue(result.ok, result.to_dict())
        record = read_ticket_retirement(project, child)
        self.assertEqual(record["discovery_event"], "E-1")
        self.assertEqual(record["evidence_note"], "seen in run 1")
        self.assertEqual(intake.validate_project(project), [])

    def test_a_note_must_stay_one_bounded_line(self):
        project = self.make_project()
        _parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        for bogus in ("two\nlines", "x" * 241, "   "):
            refused = self.retire(project, child, authority, note=bogus)
            self.assertFalse(refused.ok, repr(bogus))
            self.assertEqual(refused.code, "VALIDATION_FAILED")

    def test_a_checkout_line_ending_policy_is_not_tampering(self):
        project = self.make_project()
        self.retired(project)
        (project / EVIDENCE_REL).write_bytes(EVIDENCE_BYTES.replace(b"\n", b"\r\n"))
        self.assertEqual(intake.validate_project(project), [])

    def test_git_keeps_digest_bound_forensic_bytes_byte_exact(self):
        """A text-normalizing checkout would rewrite every retired body.

        The retired namespace holds bodies bound by RAW sha256, exactly like
        `.saipen/intake/**` and `.saipen/archive/source/**`. Under `text=auto`
        a Windows clone checks an LF body out as CRLF and the validator would
        report every retirement in that clone as tampered.
        """
        if shutil.which("git") is None:
            self.skipTest("git unavailable")
        paths = [
            f"{RETIRED_DIR}/SRC-048.md",
            f"{RETIRED_DIR}/T-1369.json",
            f"{EVIDENCE_DIR}/T-1370-retirement-20260916/src-app.py.residue",
        ]
        probe = subprocess.run(
            ["git", "check-attr", "text", "--", *paths],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if probe.returncode != 0:
            self.skipTest(f"not a git checkout: {probe.stderr.strip()}")
        for line in probe.stdout.splitlines():
            self.assertTrue(line.endswith(": text: unset"), line)

    def test_the_bound_artifact_cannot_be_rewritten_afterwards(self):
        project = self.make_project()
        self.retired(project)
        (project / EVIDENCE_REL).write_bytes(EVIDENCE_BYTES + b"edited after the fact\n")
        self.assertRed(project, "no longer hashes")
        (project / EVIDENCE_REL).unlink()
        self.assertRed(project, "evidence artifact")


class TamperControlTests(RetirementFixture):
    """The forensic archive is evidence; drift turns validation RED (SRC-050 C)."""

    def test_1_mutated_ticket_record_identity(self):
        project = self.make_project()
        _parent, child, _receipt, _authority = self.retired(project)
        path = project / retired_ticket_ref(child)
        record = self.read_json(path)
        record["ticket"] = "T-4242"
        self.write_json(path, record)
        self.assertRed(project, "identity drift")

    def test_2_board_record_mutated_without_its_digest(self):
        project = self.make_project()
        _parent, child, _receipt, _authority = self.retired(project)
        path = project / retired_ticket_ref(child)
        record = self.read_json(path)
        record["board_record"] = record["board_record"].replace("docstring", "DOCSTRING")
        self.write_json(path, record)
        self.assertRed(project, "does not hash to board_record_sha256")

    def test_3_deleted_ticket_record_behind_a_live_tombstone(self):
        project = self.make_project()
        _parent, child, receipt, _authority = self.retired(project)
        (project / retired_ticket_ref(child)).unlink()
        self.assertRed(project, f"retired tombstone {receipt} points at")

    def test_4_reason_changed_in_the_ticket_record_only(self):
        project = self.make_project()
        _parent, child, _receipt, _authority = self.retired(project)
        path = project / retired_ticket_ref(child)
        record = self.read_json(path)
        record["reason"] = "MISROUTED"
        self.write_json(path, record)
        self.assertRed(project, "unregistered reason")

    def test_4b_actor_changed_in_the_ticket_record_only(self):
        project = self.make_project()
        _parent, child, receipt, _authority = self.retired(project)
        path = project / retired_ticket_ref(child)
        record = self.read_json(path)
        record["retired_by"] = "somebody-else"
        self.write_json(path, record)
        self.assertRed(project, f"retired tombstone {receipt} and ticket record {child} disagree")

    def test_5_retirement_event_changed_in_the_source_tombstone_only(self):
        project = self.make_project()
        _parent, _child, receipt, _authority = self.retired(project)
        tomb_path = project / ".saipen" / "intake" / "tombstones" / f"{receipt}.json"
        tomb = self.read_json(tomb_path)
        tomb["retirement_event"] = "E-1"
        tomb["evidence_bound_event"] = "E-1"
        self.write_json(tomb_path, tomb)
        self.assertRed(project, "differs from index projection")
        # And when the index projection is forged to agree, the link to the
        # ticket record still refuses it.
        self.set_index_tombstone(project, receipt, tomb)
        self.assertRed(project, "disagree on retirement_event")

    def test_6_replaced_archived_source_body(self):
        project = self.make_project()
        _parent, _child, receipt, _authority = self.retired(project)
        (project / RETIRED_DIR / f"{receipt}.md").write_text("a quieter lie\n", encoding="utf-8")
        self.assertRed(project, "archived body digest mismatch")

    def test_7_symlinked_ticket_record_fails_closed(self):
        project = self.make_project()
        _parent, child, _receipt, authority = self.retired(project)
        path = project / retired_ticket_ref(child)
        outside = project.parent / "outside-record.json"
        outside.write_bytes(path.read_bytes())
        path.unlink()
        try:
            os.symlink(outside, path)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"symlinks unsupported here: {exc}")
        self.assertRed(project, "unsafe")
        # The operation refuses to answer from a record it cannot trust.
        again = self.retire(project, child, authority)
        self.assertFalse(again.ok, again.to_dict())
        self.assertEqual(again.code, "VALIDATION_FAILED")

    def test_7b_reparse_point_forensic_directory_fails_closed(self):
        project = self.make_project()
        self.retired(project)
        directory = project / RETIRED_DIR
        moved = project.parent / "retired-elsewhere"
        shutil.move(str(directory), str(moved))
        try:
            if os.name == "nt":
                import _winapi

                _winapi.CreateJunction(str(moved), str(directory))
            else:
                os.symlink(moved, directory, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"directory links unsupported here: {exc}")
        self.assertRed(project, "link or reparse")

    def test_8_coordinated_forgery_is_caught_by_the_ledger(self):
        """Every retirement carrier forged to one consistent lie: LOG disagrees."""
        project = self.make_project()
        _parent, child, receipt, _authority = self.retired(project)
        record_path = project / retired_ticket_ref(child)
        tomb_path = project / ".saipen" / "intake" / "tombstones" / f"{receipt}.json"
        meta_path = project / RETIRED_DIR / f"{receipt}.meta.json"
        record = self.read_json(record_path)
        tomb = self.read_json(tomb_path)
        meta = self.read_json(meta_path)
        for doc in (record, tomb, meta["retirement"]):
            doc["retirement_event"] = "E-1"
            doc["evidence_bound_event"] = "E-1"
        self.write_json(record_path, record)
        self.write_json(tomb_path, tomb)
        self.write_json(meta_path, meta)
        self.set_index_tombstone(project, receipt, tomb)
        self.assertRed(project, "which is not this ticket's retirement event")

    def test_9_stray_artifact_in_the_forensic_namespace(self):
        project = self.make_project()
        self.retired(project)
        (project / RETIRED_DIR / "notes.txt").write_text("stray\n", encoding="utf-8")
        self.assertRed(project, "not a recognized forensic file")

    def test_10_retired_work_back_on_board(self):
        project = self.make_project()
        _parent, child, _receipt, _authority = self.retired(project)
        record = self.read_json(project / retired_ticket_ref(child))
        board_path = project / ".saipen" / "BOARD.md"
        text = board_path.read_text(encoding="utf-8")
        board_path.write_text(
            text.replace("## TODO\n", "## TODO\n" + record["board_record"] + "\n", 1),
            encoding="utf-8",
        )
        self.assertRed(project, "still on BOARD")

    def test_record_validator_names_every_structural_field(self):
        project = self.make_project()
        _parent, child, _receipt, _authority = self.retired(project)
        good = self.read_json(project / retired_ticket_ref(child))
        self.assertEqual(ticket_record_errors(child, good), [])
        mutations = {
            "schema_version": 9,
            "source_receipts": ["SRC-x"],
            "authority_receipt": "operator",
            "retirement_event": "6803",
            "retired_at": "2026-13-45T99:00:00Z",
            "section": "## DONE",
            "restored_parent": "parent",
            "evidence": "trust me this was wrong",
            "discovery_event": "E-999999999",
        }
        for field, value in mutations.items():
            with self.subTest(field=field):
                bad = dict(good)
                bad[field] = value
                self.assertTrue(ticket_record_errors(child, bad), field)
        self.assertTrue(ticket_record_errors("T-4242", good))
        _record, errors, exists = load_ticket_retirement(project, "T-4242")
        self.assertEqual((errors, exists), ([], False))


class ParentOwnershipTests(RetirementFixture):
    """Retiring a child never transfers the parent (SRC-050 D, contract A)."""

    SEAT = "seat-a"
    OPERATOR = "operator-b"

    def test_same_seat_retirement_refreshes_its_own_claim(self):
        project = self.make_project()
        parent, child, receipt = self.contaminated_chain(project)
        authority = self.authority(project, child, receipt)
        saved = self.board(project)["tickets"][parent]["fields"]["claim_time"]
        self.assertTrue(self.retire(project, child, authority).ok)
        restored = self.board(project)["tickets"][parent]["fields"]
        self.assertEqual(restored["owner"], AGENT)
        self.assertGreaterEqual(restored["claim_time"], saved)
        self.assertEqual(self.state(project)["agent"], AGENT)

    def test_cross_seat_retirement_restores_the_reserved_seat_verbatim(self):
        project = self.make_project(agent=self.SEAT)
        parent, child, receipt = self.contaminated_chain(project, agent=self.SEAT)
        authority = self.authority(project, child, receipt, agent=self.SEAT)
        saved = dict(self.board(project)["tickets"][parent]["fields"])
        self.assertEqual(saved["owner"], self.SEAT)

        result = self.retire(project, child, authority, agent=self.OPERATOR)
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.data["restored_parent_owner"], self.SEAT)

        restored = self.board(project)["tickets"][parent]
        self.assertEqual(restored["section"], "## DOING")
        self.assertEqual(restored["fields"]["owner"], self.SEAT)
        self.assertEqual(
            restored["fields"]["claim_time"],
            saved["claim_time"],
            "a foreign actor forged the owner's liveness",
        )
        state = self.state(project)
        self.assertEqual(state["agent"], self.SEAT, "the execution seat moved")
        self.assertEqual(state["task"], parent)

        record = read_ticket_retirement(project, child)
        self.assertEqual(record["retired_by"], self.OPERATOR)
        self.assertEqual(record["restored_parent_owner"], self.SEAT)
        line = next(ln for ln in self.log(project).splitlines() if "RETIRE" in ln)
        self.assertIn(f"actor {self.OPERATOR} (seat {self.SEAT})", line)
        self.assertIn(f"restores {parent} to seat {self.SEAT}", line)

        self.assertEqual(intake.validate_project(project), [])
        for actor in (self.SEAT, self.OPERATOR):
            with self.subTest(actor=actor):
                self.assertEqual(fast_check.validate_project(project, current_agent=actor), [])

        # The operator gained nothing: it cannot take the parent...
        taken = apply_claim(project, parent, self.OPERATOR, explicit=True)
        self.assertFalse(taken.ok, taken.to_dict())
        self.assertEqual(self.board(project)["tickets"][parent]["fields"]["owner"], self.SEAT)
        # ...and the legitimate seat simply carries on.
        carried = checkpoint(project, self.SEAT, "RUN", parent, "seat A resumes its own Work")
        self.assertTrue(carried.ok, carried.to_dict())


class LegacyReaffirmationTests(RetirementFixture):
    """Schema-1 records are re-affirmed as a NEW event, never rewritten in place."""

    def downgrade(self, project: Path, child: str, receipt: str) -> dict:
        """Put the artifacts back into the exact shape the first slice wrote."""
        record_path = project / retired_ticket_ref(child)
        record = self.read_json(record_path)
        legacy_evidence = (
            f"evidence {record['evidence']['ref']} sha256:{record['evidence']['sha256']}"
        )
        legacy = {
            "schema_version": 1,
            "ticket": record["ticket"],
            "board_record": record["board_record"],
            "board_record_sha256": record["board_record_sha256"],
            "section": record["section"],
            "source_receipts": record["source_receipts"],
            "reason": record["reason"],
            "evidence": legacy_evidence,
            "authority_receipt": record["authority_receipt"],
            "retired_at": record["retired_at"],
            "retired_by": record["retired_by"],
            "retirement_event": record["retirement_event"],
            "discovery_event": None,
            "restored_parent": record["restored_parent"],
        }
        self.write_json(record_path, legacy)
        tomb_path = project / ".saipen" / "intake" / "tombstones" / f"{receipt}.json"
        tomb = self.read_json(tomb_path)
        legacy_tomb = {
            "schema_version": 1,
            "receipt_id": tomb["receipt_id"],
            "source_sha256": tomb["source_sha256"],
            "linked_work": tomb["linked_work"],
            "status": tomb["status"],
            "reason": tomb["reason"],
            "evidence": legacy_evidence,
            "authority_receipt": tomb["authority_receipt"],
            "retired_at": tomb["retired_at"],
            "retired_by": tomb["retired_by"],
            "retirement_event": tomb["retirement_event"],
            "discovery_event": None,
            "archive_ref": tomb["archive_ref"],
            "ticket_ref": tomb["ticket_ref"],
        }
        self.write_json(tomb_path, legacy_tomb)
        self.set_index_tombstone(project, receipt, legacy_tomb)
        meta_path = project / RETIRED_DIR / f"{receipt}.meta.json"
        meta = self.read_json(meta_path)
        block = meta["retirement"]
        meta["retirement"] = {
            "schema_version": 1,
            "reason": block["reason"],
            "evidence": legacy_evidence,
            "authority_receipt": block["authority_receipt"],
            "retired_at": block["retired_at"],
            "retired_by": block["retired_by"],
            "retirement_event": block["retirement_event"],
            "discovery_event": None,
            "retired_work": block["retired_work"],
            "board_record": block["board_record"],
            "board_record_sha256": block["board_record_sha256"],
        }
        self.write_json(meta_path, meta)
        return legacy

    def legacy_project(self) -> tuple[Path, str, str, str, dict]:
        project = self.make_project()
        _parent, child, receipt, authority = self.retired(project)
        legacy = self.downgrade(project, child, receipt)
        return project, child, receipt, authority, legacy

    def test_a_legacy_record_is_red_until_reaffirmed(self):
        project, _child, _receipt, _authority, _legacy = self.legacy_project()
        self.assertRed(project, "legacy schema-1 retirement")

    def test_reaffirmation_binds_evidence_as_a_new_event_and_keeps_history(self):
        project, child, receipt, authority, legacy = self.legacy_project()
        board_before = (project / ".saipen" / "BOARD.md").read_bytes()
        body_before = (project / RETIRED_DIR / f"{receipt}.md").read_bytes()

        bound = self.retire(project, child, authority, discovery_event="E-1")
        self.assertTrue(bound.ok, bound.to_dict())
        self.assertEqual(bound.code, "RETIREMENT_EVIDENCE_BOUND")

        record = read_ticket_retirement(project, child)
        self.assertIsNotNone(record)
        for field in ("board_record", "retired_at", "retired_by", "retirement_event"):
            self.assertEqual(record[field], legacy[field], field)
        self.assertEqual(record["evidence_note"], legacy["evidence"])
        self.assertEqual(record["discovery_event"], "E-1")
        self.assertNotEqual(record["evidence_bound_event"], record["retirement_event"])
        self.assertEqual(record["restored_parent_owner"], AGENT)
        self.assertIn("RETIREMENT EVIDENCE BOUND", self.log(project))
        self.assertEqual((project / ".saipen" / "BOARD.md").read_bytes(), board_before)
        self.assertEqual((project / RETIRED_DIR / f"{receipt}.md").read_bytes(), body_before)
        self.assertEqual(intake.validate_project(project), [])

        log_before = self.log(project)
        again = self.retire(project, child, authority)
        self.assertEqual(again.code, "ALREADY_RETIRED")
        self.assertEqual(self.log(project), log_before)

    def test_reaffirmation_cannot_change_what_was_decided(self):
        project, child, _receipt, _authority, _legacy = self.legacy_project()
        other = self.authority(project, child, None)
        changed_authority = self.retire(project, child, other)
        self.assertFalse(changed_authority.ok)
        self.assertEqual(changed_authority.code, "RETIREMENT_AUTHORITY_REQUIRED")
        self.assertRed(project, "legacy schema-1 retirement")

    def test_reaffirmation_refuses_a_note_and_an_unbacked_record(self):
        project, child, _receipt, authority, legacy = self.legacy_project()
        noted = self.retire(project, child, authority, note="new words")
        self.assertFalse(noted.ok)
        self.assertEqual(noted.code, "VALIDATION_FAILED")

        forged = dict(legacy)
        forged["evidence"] = "words the ledger never recorded"
        self.write_json(project / retired_ticket_ref(child), forged)
        refused = self.retire(project, child, authority)
        self.assertFalse(refused.ok, refused.to_dict())
        self.assertIn("does not match", refused.message)


class HistoryReaderTests(unittest.TestCase):
    def test_history_snapshot_exposes_the_fields_the_ledger_check_reads(self):
        events = read_history_snapshot(ROOT, lean=True).events
        self.assertTrue(events)
        needed = {"event", "ticket", "agent", "op_id", "taxonomy", "text"}
        self.assertTrue(needed <= set(events[-1]))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
