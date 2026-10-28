"""T-1304 independent-REVIEW P0 repair regressions (SRC-026:R001/R003).

Two reproducible defects found by the audit/17-era independent REVIEW on the
E-5999 runtime, both reopened here:

  * CORE-003 / SRC-026:R003 -- a BOARD scalar carrying a physical record
    separator could synthesize a canonical ticket. `verify` containing
    `"\\n- [ ] T-999 [P0] injected | verify: injected proof"` passed
    `user_request` and `ticket_add` and produced a BOARD that parses clean
    with `T-999` on it and `next_action = PHASE SCOUT T-999` persisted. The
    injected identity was never allocated by `next_ticket_id`.
  * CORE-002 / SRC-026:R001 -- non-transferring operations still moved the
    execution seat. `_seat_agent` chose between the actor and the BOARD
    owner, so (a) an actor filing future Work with no active ticket took the
    seat, (b) the same happened beside an UNCLAIMED active ticket, and
    (c) a PRE-EXISTING owner/STATE split was silently "healed" to the BOARD
    owner by an unrelated mutation instead of being exposed/refused.

Every case here was red on the pre-repair implementation by construction
(the matrix spans every separator `str.splitlines()` recognizes, including
the trailing-separator shapes that fool `len(value.splitlines()) > 1`).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import fast_check, operations  # noqa: E402
from saipen_engine.board import (  # noqa: E402
    RECORD_SEPARATOR_NAMES,
    RECORD_SEPARATORS,
    assert_single_record,
    escape_ticket_description,
    parse_board,
    record_separator_in,
    set_ticket_field,
)
from saipen_engine.intake import find_by_body  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    OwnershipSplitError,
    ticket_add,
    user_request,
)
from saipen_engine.state import parse_state  # noqa: E402

#: Every separator that can terminate a physical BOARD record. The two
#: mandatory exact controls from the REVIEW are members of this set.
T999_CRLF = "proof\n- [ ] T-999 [P0] injected | verify: injected proof"
T999_U2028 = "proof\u2028- [ ] T-999 [P0] injected | verify: injected proof"

NOW = dt.datetime(2026, 9, 9, 12, 0, 0, tzinfo=dt.timezone.utc)


def _tree_digest(root: Path) -> str:
    """Hash of every canonical byte -- the zero-mutation oracle."""
    h = hashlib.sha256()
    for path in sorted(p for p in (root / ".saipen").rglob("*") if p.is_file()):
        h.update(str(path.relative_to(root)).replace("\\", "/").encode())
        h.update(path.read_bytes())
    return h.hexdigest()


class RepairFixture(unittest.TestCase):
    """A project with no active ticket and a seated agent, T-1 seeded."""

    def make_project(self, *, agent: str = "tester") -> Path:
        base = Path(tempfile.mkdtemp(prefix="saipen-t1304-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        (project / ".saipen").mkdir(parents=True)
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: CLEAN\n"
            "task: none\n"
            'next_action: "WAIT: user brake -- nothing workable yet"\n'
            'blocker: ""\n'
            "transition_from: REVIEW\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            f"agent: {agent}\n"
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            f'updated: "{NOW.strftime("%Y-%m-%dT%H:%M:%SZ")}"\n'
            "---\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n"
            "## TODO\n"
            "- [ ] T-1 [P2] seeded work | verify: proof it works\n"
            "## DONE\n"
            "## BLOCKED\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "LOG.md").write_text(
            "- 09.09.26 12:00 [E-001] [T-1] [agent: tester] DEC: seed ticket\n",
            encoding="utf-8",
        )
        from saipen_engine import journal

        journal.ensure_project_lineage(project)
        return project

    def state(self, project: Path) -> dict:
        return parse_state((project / ".saipen" / "STATE.md").read_text(encoding="utf-8"))

    def board(self, project: Path) -> dict:
        return parse_board((project / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))

    def log_text(self, project: Path) -> str:
        return (project / ".saipen" / "LOG.md").read_text(encoding="utf-8")


# ============================================ DEFECT A: scalar authority

class RecordSeparatorPredicateTests(unittest.TestCase):
    """ONE canonical predicate, not len(splitlines()) > 1."""

    def test_the_canonical_set_matches_splitlines_boundaries(self):
        self.assertEqual(len(RECORD_SEPARATORS), len(RECORD_SEPARATOR_NAMES))
        for sep in RECORD_SEPARATORS:
            self.assertEqual(len(("a" + sep + "b").splitlines()), 2)
            self.assertEqual(record_separator_in("a" + sep + "b"), sep)

    def test_trailing_separator_is_caught_though_splitlines_len_is_one(self):
        # `len(value.splitlines()) > 1` is FALSE for exactly this input while
        # the value still terminates a physical record -- the exact shape the
        # REVIEW told us not to rely on splitlines for.
        trailing = "x\n"
        self.assertEqual(len(trailing.splitlines()), 1)
        self.assertEqual(record_separator_in(trailing), "\n")

    def test_clean_scalars_pass_and_are_returned(self):
        self.assertEqual(assert_single_record("clean value", "verify"), "clean value")
        self.assertIsNone(record_separator_in("plain | text \\ with pipes"))

    def test_escape_still_works_and_refuses_separators_first(self):
        self.assertEqual(escape_ticket_description("a\\b"), "a\\\\b")
        self.assertEqual(escape_ticket_description("a|b"), "a\\|b")
        for sep in RECORD_SEPARATORS:
            with self.assertRaises(ValueError):
                escape_ticket_description("a" + sep + "b")

    def test_set_ticket_field_refuses_every_separator(self):
        line = "- [ ] T-1 [P2] work | verify: proof"
        for sep in RECORD_SEPARATORS:
            with self.assertRaises(ValueError):
                set_ticket_field(line, "verify", "x" + sep + "- [ ] T-999 phantom")


class BoardScalarInjectionMatrixTests(RepairFixture):
    """Parameterize every supported writer with every record separator.

    ticket_add description, ticket_add verify, user_request verify, and
    set_ticket_field (generic mutation primitive). For each: operation
    REFUSES, no injected ticket, no BOARD mutation, no STATE routing
    mutation, no LOG mutation; for user_request additionally NO intake
    receipt.
    """

    SEPARATOR_PAYLOADS: tuple[str, ...] = tuple(  # type: ignore[var-annotated]
        ("proof" + sep + "- [ ] T-999 [P0] injected | verify: injected proof")
        for sep in RECORD_SEPARATORS
    )

    def _assert_clean_refusal(self, project, before, result):
        self.assertFalse(result.ok, f"writer accepted an injected scalar: {result.to_dict()}")
        self.assertEqual(result.code, "VALIDATION_FAILED", result.to_dict())
        self.assertEqual(_tree_digest(project), before, "a refused scalar wrote bytes")
        tickets = self.board(project)["tickets"]
        self.assertNotIn("T-999", tickets)
        self.assertEqual(tickets["T-1"]["section"], "## TODO")
        self.assertEqual(
            self.state(project).get("next_action"),
            "WAIT: user brake -- nothing workable yet",
        )
        self.assertNotIn("T-999", self.log_text(project))

    def test_ticket_add_description_matrix(self):
        for payload in self.SEPARATOR_PAYLOADS:
            with self.subTest(payload=repr(payload)):
                project = self.make_project()
                before = _tree_digest(project)
                self._assert_clean_refusal(
                    project,
                    before,
                    ticket_add(project, "tester", "P1", payload, [], "verify by test"),
                )

    def test_ticket_add_verify_matrix(self):
        for payload in self.SEPARATOR_PAYLOADS:
            with self.subTest(payload=repr(payload)):
                project = self.make_project()
                before = _tree_digest(project)
                self._assert_clean_refusal(
                    project,
                    before,
                    ticket_add(project, "tester", "P1", "future work", [], payload),
                )

    def test_user_request_verify_matrix(self):
        for payload in self.SEPARATOR_PAYLOADS:
            with self.subTest(payload=repr(payload)):
                project = self.make_project()
                before = _tree_digest(project)
                body_markers = [
                    p.name for p in (project / ".saipen" / "intake").rglob("*") if p.is_file()
                ]
                result = user_request(project, "tester", "make it so", verify=payload)
                self._assert_clean_refusal(project, before, result)
                after_markers = [
                    p.name for p in (project / ".saipen" / "intake").rglob("*") if p.is_file()
                ]
                self.assertEqual(
                    body_markers,
                    after_markers,
                    "an invalid pre-projection verify created a Source receipt",
                )

    def test_exact_t999_crlf_reproduction_refuses(self):
        project = self.make_project()
        before = _tree_digest(project)
        self._assert_clean_refusal(
            project, before, user_request(project, "tester", "make it so", verify=T999_CRLF)
        )
        project = self.make_project()
        before = _tree_digest(project)
        self._assert_clean_refusal(
            project, before, ticket_add(project, "tester", "P1", "future work", [], T999_CRLF)
        )

    def test_exact_t999_u2028_reproduction_refuses(self):
        project = self.make_project()
        before = _tree_digest(project)
        self._assert_clean_refusal(
            project, before, user_request(project, "tester", "make it so", verify=T999_U2028)
        )
        project = self.make_project()
        before = _tree_digest(project)
        self._assert_clean_refusal(
            project, before, ticket_add(project, "tester", "P1", "future work", [], T999_U2028)
        )

    def test_multiline_request_body_is_still_legal(self):
        """The durable Source BODY stays multiline; only scalars are bound."""
        project = self.make_project()
        result = user_request(project, "tester", "line one\nline two\nline three")
        self.assertTrue(result.ok, result.to_dict())
        ticket = self.board(project)["tickets"][result.data["ticket"]]
        self.assertNotIn("\n", ticket["raw"])
        receipt = result.data["receipt"]
        marker = find_by_body(project, "anything")  # None: different body
        self.assertIsNone(marker)
        self.assertTrue(
            any(receipt in p.name for p in (project / ".saipen" / "intake").rglob("*")),
            "the durable request body receipt is missing",
        )


class ParserDefenseTests(RepairFixture):
    """A hand-injected detached record cannot become canonical authority."""

    #: The five physical separators the REVIEW mandates for the parser
    #: continuation matrix (writer tests cover the complete set).
    PARSER_CONTINUATION_SEPARATORS: tuple[str, ...] = (  # type: ignore[var-annotated]
        "\n",
        "\r",
        "\x85",
        "\u2028",
        "\u2029",
    )

    def test_out_of_band_separator_bytes_fail_validation(self):
        """Injected physical separator -> detached continuation -> refuse.

        The REAL parser invariant (CORE-003 / SRC-026:R003): a record
        separator inside a legitimate allocated ticket's field splits the
        physical bytes, and by the time parse_board sees the text the
        separator no longer exists in any parsed field -- so the only
        truthful defense is the physical grammar. The detached continuation
        is an unexpected physical BOARD record, and BOTH parse_board and fast
        validation refuse the board. The pre-repair parser returned [] here:
        the field was silently truncated to 'proof' and validation accepted
        the loss, so this fixture is red against pre-fix code by construction
        (no second ticket id is created, so the allocation authority never
        masks the grammar defect).
        """
        for sep in self.PARSER_CONTINUATION_SEPARATORS:
            with self.subTest(sep=repr(sep)):
                project = self.make_project()
                board_text = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
                (project / ".saipen" / "BOARD.md").write_text(
                    board_text.replace(
                        "| verify: proof it works",
                        "| verify: proof" + sep + "detached tail",
                    ),
                    encoding="utf-8",
                )
                parsed = parse_board(
                    (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
                )
                # No second ticket id: exactly the allocated T-1 remains.
                self.assertEqual(list(parsed["tickets"]), ["T-1"])
                # The separator is GONE from the parsed field (you literally
                # cannot require the impossible), which is exactly why the
                # physical-grammar error is the only honest catch.
                self.assertEqual(parsed["tickets"]["T-1"]["fields"]["verify"], "proof")
                self.assertTrue(
                    parsed["errors"], "parse_board accepted a detached continuation"
                )
                self.assertTrue(
                    any("unexpected physical BOARD record" in e for e in parsed["errors"]),
                    parsed["errors"],
                )
                errors = fast_check.validate_project(project, current_agent="tester")
                self.assertTrue(
                    errors, "fast validation accepted silently lost field bytes"
                )
                self.assertTrue(
                    any("unexpected physical BOARD record" in e for e in errors),
                    errors,
                )

    def test_detached_ticket_without_allocation_event_fails_validation(self):
        """T-999 rendered onto the BOARD by ANY out-of-band path is refused.

        The bytes carry a separator-legal line: this is the post-injection
        world the scalar gate prevents, and the parse/validator defense must
        refuse it independently -- a phantom with no [T-###] allocation
        event in the complete history never becomes authority.
        """
        project = self.make_project()
        board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        (project / ".saipen" / "BOARD.md").write_text(
            board.replace(
                "- [ ] T-1 [P2] seeded work | verify: proof it works\n",
                "- [ ] T-1 [P2] seeded work | verify: proof it works\n"
                "- [ ] T-999 [P0] injected phantom | verify: injected proof\n",
            ),
            encoding="utf-8",
        )
        errors = fast_check.validate_project(project, current_agent="tester")
        self.assertTrue(
            any("T-999" in e and "allocation event" in e for e in errors),
            errors,
        )

    def test_allocated_tickets_still_validate_clean(self):
        project = self.make_project()
        self.assertEqual(fast_check.validate_project(project, current_agent="tester"), [])


# ======================================= DEFECT B: execution-seat authority

class SeatPreservationMatrixTests(RepairFixture):
    """The P1 regression matrix: A idle, B idle user_request, C unclaimed
    active, D live claimed, E pre-existing split, F explicit claim,
    G explicit handover."""

    def _idle_project(self, agent: str = "tester") -> Path:
        return self.make_project(agent=agent)

    def _unclaimed_active_project(self, agent: str = "tester") -> Path:
        project = self.make_project(agent=agent)
        board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        (project / ".saipen" / "BOARD.md").write_text(
            board.replace(
                "## DOING\n## TODO\n- [ ] T-1 [P2] seeded work | verify: proof it works",
                "## DOING\n- [/] T-1 [P2] active unclaimed | verify: proof it works\n## TODO",
            ),
            encoding="utf-8",
        )
        state = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        (project / ".saipen" / "STATE.md").write_text(
            state.replace("phase: CLEAN", "phase: BUILD").replace("task: none", "task: T-1"),
            encoding="utf-8",
        )
        return project

    def _split_project(self) -> Path:
        """STATE.agent=tester, active BOARD owner=opencode -- corrupt BEFORE."""
        project = self._unclaimed_active_project(agent="tester")
        board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        (project / ".saipen" / "BOARD.md").write_text(
            board.replace(
                "- [/] T-1 [P2] active unclaimed",
                "- [/] T-1 [P2] active claimed | owner: opencode | claim_time: "
                + NOW.strftime("%Y-%m-%dT%H:%M:%SZ"),
            ),
            encoding="utf-8",
        )
        return project

    def test_a_idle_foreign_ticket_add_preserves_the_seat(self):
        project = self._idle_project(agent="tester")
        result = ticket_add(project, "buffy", "P2", "future work", [], "verify by test")
        self.assertTrue(result.ok, result.to_dict())
        state = self.state(project)
        self.assertEqual(state["agent"], "tester", "an idle foreign ticket_add took the seat")
        self.assertIn("actor buffy", self.log_text(project), "provenance lost the actor")

    def test_b_idle_foreign_user_request_preserves_the_seat(self):
        project = self._idle_project(agent="tester")
        result = user_request(project, "buffy", "make it so")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(self.state(project)["agent"], "tester")

    def test_c_unclaimed_active_foreign_mutation_preserves_seat_and_claim(self):
        project = self._unclaimed_active_project(agent="tester")
        result = ticket_add(project, "buffy", "P2", "future work", [], "verify by test")
        self.assertTrue(result.ok, result.to_dict())
        state = self.state(project)
        fields = self.board(project)["tickets"]["T-1"]["fields"]
        self.assertEqual(state["agent"], "tester")
        self.assertNotIn("owner", fields, "the unrelated mutation implicitly claimed the ticket")

    def test_d_live_claimed_foreign_mutation_preserves_everything(self):
        project = self._split_project()
        state = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        (project / ".saipen" / "STATE.md").write_text(
            state.replace("agent: tester", "agent: opencode"),
            encoding="utf-8",
        )
        before_fields = dict(self.board(project)["tickets"]["T-1"]["fields"])
        result = ticket_add(project, "buffy", "P2", "future work", [], "verify by test")
        self.assertTrue(result.ok, result.to_dict())
        fields = self.board(project)["tickets"]["T-1"]["fields"]
        self.assertEqual(self.state(project)["agent"], "opencode")
        self.assertEqual(fields["owner"], before_fields["owner"])
        self.assertEqual(fields["claim_time"], before_fields["claim_time"])

    def test_e_pre_existing_split_is_refused_not_healed(self):
        project = self._split_project()
        before = _tree_digest(project)
        result = ticket_add(project, "astra2", "P2", "future work", [], "verify by test")
        self.assertFalse(result.ok, result.to_dict())
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertIn("split", (result.message or "") + str(result.to_dict()))
        self.assertEqual(_tree_digest(project), before, "the refusal healed or wrote bytes")
        self.assertEqual(self.state(project)["agent"], "tester")
        self.assertEqual(
            self.board(project)["tickets"]["T-1"]["fields"]["owner"], "opencode"
        )

    def test_e_split_refusal_raises_through_the_shared_choke_point(self):
        project = self._split_project()
        state = self.state(project)
        board_text = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        with self.assertRaises(OwnershipSplitError):
            operations._seat_agent(state, board_text, "astra2")

    def test_f_explicit_claim_still_moves_board_and_state_atomically(self):
        from saipen_engine.operations import apply_claim

        project = self._unclaimed_active_project(agent="tester")
        result = apply_claim(project, "T-1", "buffy")
        self.assertTrue(result.ok, result.to_dict())
        fields = self.board(project)["tickets"]["T-1"]["fields"]
        self.assertEqual(fields["owner"], "buffy")
        self.assertIn("claim_time", fields)
        self.assertEqual(self.state(project)["agent"], "buffy")
        self.assertEqual(self.state(project)["task"], "T-1")

    def test_g_explicit_handover_still_moves_board_and_state_atomically(self):
        from saipen_engine.operations import handover_agent

        project = self._split_project()
        state = (project / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        (project / ".saipen" / "STATE.md").write_text(
            state.replace("agent: tester", "agent: opencode"), encoding="utf-8"
        )
        result = handover_agent(project, "buffy", explicit=True, now=NOW)
        self.assertTrue(result.ok, result.to_dict())
        fields = self.board(project)["tickets"]["T-1"]["fields"]
        self.assertEqual(fields["owner"], "buffy")
        self.assertEqual(self.state(project)["agent"], "buffy")

    def test_generic_state_mutation_preserves_the_seat(self):
        """audit/source metadata mutation is out-of-band too."""
        from saipen_engine import intake

        project = self._idle_project(agent="tester")
        captured = intake.capture(
            project,
            "# Source report\n\n## Report\n\nbody\n",
            source_kind="user_audit",
        )
        self.assertTrue(captured["ok"], captured)
        self.assertEqual(self.state(project)["agent"], "tester")


class SeatRuleUnitTests(unittest.TestCase):
    """_seat_agent's answer is PRESERVATION, never actor fallback."""

    def test_preserves_before_state_agent(self):
        own = operations._seat_agent({"agent": "tester"}, "## DOING\n## TODO\n", "buffy")
        self.assertEqual(own, "tester")

    def test_initialization_narrow_case_returns_actor(self):
        own = operations._seat_agent({}, "## DOING\n## TODO\n", "tester")
        self.assertEqual(own, "tester")


if __name__ == "__main__":
    unittest.main()
