"""Legacy lifecycle compatibility boundary.

The recovery engine judges records by the closure contract (`closure_mode`, the
VERIFY-boundary + `conf: high` evidence grammar) and by the claim-lease contract
(`owner` + `claim_time`, both-or-neither). Both contracts are YOUNGER than the
canonical records they are now asked to judge.

Applied without a compatibility boundary they read "this field did not exist
yet" as "this completion was fabricated" and "this attribution predates the
lease schema" as "this claim is malformed", and the approved repair plan then
proposes to rewrite valid history. The production reproducer is the AUDAPACK
Fleet plan, which proposed 15 ``## DONE -> ## TODO`` reopenings of real
completions and 66 destructive ``claim-clear`` atoms against terminal records
whose only defect was being older than the schema.

This suite is the RED-first proof of the boundary:

  * Target C -- a legacy DONE is never judged by a future closure schema;
  * Target D -- a legacy terminal ``owner`` is attribution, not a live lease;
  * a real AUDAPACK-shaped fixture (T-113..T-128) produces ZERO atoms;
  * the current generation still repairs fail-closed, unchanged.

Nothing here touches a live project: every fixture is built in a temp dir.
"""

from __future__ import annotations

import contextlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen import main as saipen_main  # noqa: E402
from saipen_engine.board import parse_board  # noqa: E402
from saipen_engine.log import (  # noqa: E402
    bulk_legacy_completion_evidence,
    read_history_snapshot,
)
from saipen_engine.ownership import classify_active_ownership  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from saipen_engine.reconcile import (  # noqa: E402
    _board_lifecycle_repairs,
    _closure_contract_frontier,
    _is_legacy_generation,
    reconcile_protocol_state,
)

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


_TEMPS: list[tempfile.TemporaryDirectory] = []

STATE_TEMPLATE = """---
phase: BUILD
task: {task}
next_action: "PHASE BUILD {task}"
blocker: ""
transition_from: PLAN
saipen_version: 7
schema_version: 3
last_event: {last_event}
style_contract: ded-4ae736e4
mode: full
updated: 2026-09-15T00:00:00Z
agent: test-agent
---
"""


@contextlib.contextmanager
def _unbound_host():
    """A bound host session must not contaminate the fixture's identity."""
    keys = ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT")
    saved = {key: os.environ.pop(key, None) for key in keys}
    try:
        yield
    finally:
        for key, value in saved.items():
            if value is not None:
                os.environ[key] = value


def project(board: str, log: str, *, task: str = "T-900", last_event: int) -> Path:
    tmp = tempfile.TemporaryDirectory(prefix="saipen-legacycompat-")
    _TEMPS.append(tmp)
    root = Path(tmp.name)
    memory = root / ".saipen"
    memory.mkdir(parents=True)
    (memory / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (memory / "STATE.md").write_text(
        STATE_TEMPLATE.format(task=task, last_event=last_event), encoding="utf-8"
    )
    (memory / "BOARD.md").write_text(board, encoding="utf-8")
    (memory / "LOG.md").write_text(log, encoding="utf-8")
    return root


def repairs_for(root: Path) -> list[dict]:
    """The bounded lifecycle repair set exactly as recovery computes it."""
    memory = root / ".saipen"
    board = parse_board((memory / "BOARD.md").read_text(encoding="utf-8"))
    history = read_history_snapshot(root)
    state = {"task": _state_task(root)}
    return _board_lifecycle_repairs(board, list(history.events), state, history)


def _state_task(root: Path) -> str:
    for line in (root / ".saipen" / "STATE.md").read_text(encoding="utf-8").splitlines():
        if line.startswith("task:"):
            return line.split(":", 1)[1].strip()
    return ""


def atoms(root: Path, ticket: str) -> list[dict]:
    return [r for r in repairs_for(root) if r.get("ticket") == ticket]


def kinds(root: Path, ticket: str) -> set[str]:
    return {r.get("kind") for r in atoms(root, ticket)}


def board_of(root: Path) -> str:
    return (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")


def section_of(root: Path, ticket: str) -> str:
    return parse_board(board_of(root))["tickets"][ticket]["section"]


def event(n: int, ticket: str | None, text: str, *, op: str | None = None) -> str:
    """One LOG line. `op=None` is the pre-operation-layer event grammar."""
    head = f"- 02.09.26 01:0{n % 10} [E-{n:03d}]"
    if n > 1:
        head += f" [parent: E-{n - 1:03d}]"
    if ticket:
        head += f" [{ticket}]"
    head += " [agent: claude]"
    if op:
        head += f" [op: {op}]"
    return f"{head} {text}"


# ---------------------------------------------------------------------------
# The AUDAPACK production shape, reduced to its defect-bearing essentials:
#
#   * T-190 is the project's FIRST record carrying `closure_mode`, so the
#     closure contract became observable at T-190;
#   * T-113/T-114 are pre-contract DONE records with real historical BUILD and
#     SHIP evidence and no closure_mode/owner/claim_time;
#   * T-118 is a pre-contract DONE record with NO execution evidence at all;
#   * T-060 is a pre-contract DONE record carrying `owner` and no `claim_time`;
#   * T-195 is a POST-contract DONE record with no closure evidence.
# ---------------------------------------------------------------------------

#: The project's FIRST record carrying `closure_mode` -- the immutable marker
#: the compatibility frontier is derived from. Assembled rather than written
#: inline only because a BOARD record is one physical line.
T190_RECORD = (
    "- [x] T-190 modern closure | verify: closed by the canonical finish "
    "| owner: claude | claim_time: 2026-09-02T02:00:00Z | closure_mode: own_patch"
)

AUDAPACK_BOARD = f"""## DOING
- [/] T-900 active work | verify: resume | owner: test-agent | claim_time: 2026-09-15T00:00:00Z
## TODO
## DONE
- [x] T-195 modern phantom | verify: never completed by a canonical operation
{T190_RECORD}
- [x] T-118 ambiguous legacy | verify: hand-authored with no execution trace
- [x] T-114 legacy ship | verify: one reload per required build, then one warning
- [x] T-113 legacy build | verify: dsp-0c85d487cb3d4519 requeued itself
- [x] T-060 legacy attribution | verify: historical owner, pre-claim_time | owner: claude
## BLOCKED
"""

AUDAPACK_LOG = "\n".join(
    [
        event(1, "T-060", "DEC: ticket added"),
        event(2, "T-113", "DEC: ticket added"),
        event(3, "T-114", "DEC: ticket added"),
        event(4, "T-118", "DEC: ticket added"),
        event(5, "T-190", "DEC: ticket added", op="ticket-" + "a" * 32),
        event(6, "T-195", "DEC: ticket added", op="ticket-" + "b" * 32),
        event(7, "T-900", "DEC: ticket added", op="ticket-" + "c" * 32),
        event(
            8,
            "T-113",
            "RUN: BUILD -- three bare returns ran after the atomic claim; after "
            "the fix the job requeued itself and produced a real 65KB artifact",
        ),
        event(
            9,
            "T-114",
            "RUN: SHIP -- one reload per required build, then one warning; no "
            "2-minute churn",
        ),
        event(
            10,
            "T-060",
            "RUN: BUILD -- historical implementation recorded before the claim "
            "lease schema existed",
        ),
        event(11, None, "RUN: transition to BUILD", op="transition-" + "d" * 32),
    ]
)


def audapack_project(*, modern_phantom: bool = True) -> Path:
    """The production shape.

    `modern_phantom=False` drops T-195, so the plan carries no approval-gated
    mutation and the LEGACY refusal is what the run actually reaches -- the
    isolation the operator-decision path needs to be provable at all.
    """
    board = AUDAPACK_BOARD
    if not modern_phantom:
        board = (
            "\n".join(
                line
                for line in board.splitlines()
                if not line.startswith("- [x] T-195")
            )
            + "\n"
        )
    return project(board, AUDAPACK_LOG + "\n", last_event=11)


class CompatibilityFrontierTests(unittest.TestCase):
    """The boundary itself: derived from durable record evidence, never time."""

    def test_frontier_is_the_lowest_id_observing_closure_mode(self):
        board = parse_board(AUDAPACK_BOARD)
        self.assertEqual(_closure_contract_frontier(board), 190)

    def test_no_closure_mode_anywhere_leaves_the_frontier_unestablished(self):
        board = parse_board(AUDAPACK_BOARD.replace(" | closure_mode: own_patch", ""))
        self.assertIsNone(_closure_contract_frontier(board))

    def test_generation_split_uses_allocation_order_not_wall_clock(self):
        self.assertTrue(_is_legacy_generation("T-113", 190, set()))
        self.assertFalse(_is_legacy_generation("T-195", 190, set()))
        self.assertTrue(_is_legacy_generation("T-190", 191, set()))

    def test_unestablished_frontier_falls_back_to_historical_event_grammar(self):
        # No project-level closure observation: a record the canonical
        # operation layer never touched predates it; one it did is current.
        self.assertTrue(_is_legacy_generation("T-113", None, {"T-195"}))
        self.assertFalse(_is_legacy_generation("T-195", None, {"T-195"}))

    def test_an_undecidable_id_resolves_to_legacy(self):
        # Fail toward preservation: the destructive answer is never the guess.
        self.assertTrue(_is_legacy_generation("T-abc", 190, set()))


class TargetCLegacyDoneTests(unittest.TestCase):
    """Legacy DONE must not be judged by a future closure schema."""

    def test_1_pre_closure_mode_done_with_build_evidence_remains_done(self):
        root = audapack_project()
        self.assertEqual(atoms(root, "T-113"), [])
        self.assertEqual(section_of(root, "T-113"), "## DONE")

    def test_2_pre_closure_mode_done_with_ship_evidence_remains_legacy_valid(self):
        root = audapack_project()
        self.assertEqual(atoms(root, "T-114"), [])
        proven, reason = bulk_legacy_completion_evidence(
            list(read_history_snapshot(root).events), ["T-114"]
        )["T-114"]
        self.assertTrue(proven, reason)
        self.assertNotIn("closure_mode", board_of(root).split("T-114", 1)[1].split("\n")[0])

    def test_3_modern_done_after_the_frontier_may_be_phantom(self):
        root = audapack_project()
        found = atoms(root, "T-195")
        self.assertEqual([r["kind"] for r in found], ["section-move"])
        self.assertEqual(found[0]["to_section"], "## TODO")
        self.assertTrue(found[0]["requires_approval"])
        self.assertEqual(found[0]["generation"], "current")

    def test_4_ambiguous_legacy_done_is_an_operator_decision(self):
        root = audapack_project()
        found = atoms(root, "T-118")
        self.assertEqual([r["kind"] for r in found], ["legacy-done-review"])
        self.assertTrue(found[0]["refuse"])
        self.assertTrue(found[0]["operator_decision_available"])
        self.assertEqual(found[0]["generation"], "legacy")
        self.assertEqual(
            found[0]["canonical_next_command"],
            "saipen recover --attest-legacy-done T-118",
        )
        # Explicitly NOT a deterministic reopen.
        self.assertNotIn("section-move", kinds(root, "T-118"))

    def test_5_a_historical_ticket_never_becomes_todo_for_a_missing_future_field(self):
        root = audapack_project()
        plan = reconcile_protocol_state(root, "test-agent", dry_run=True)
        moved_to_todo = {
            r["ticket"]
            for r in plan.get("changed", {}).get("lifecycle", [])
            if r.get("kind") == "section-move" and r.get("to_section") == "## TODO"
        }
        self.assertEqual(moved_to_todo, {"T-195"}, plan)
        for legacy in ("T-113", "T-114", "T-118", "T-060"):
            self.assertNotIn(legacy, moved_to_todo)

    def test_an_ambiguous_legacy_done_refusal_never_mutates_the_board(self):
        root = audapack_project()
        before = board_of(root)
        result = reconcile_protocol_state(root, "test-agent", dry_run=True)
        self.assertFalse(result["ok"], result)
        self.assertEqual(board_of(root), before)

    def test_a_failure_claim_is_still_negative_legacy_evidence(self):
        log = AUDAPACK_LOG + "\n" + event(
            12, "T-113", "RUN: BUILD FAILED -- the fix did not hold"
        )
        root = project(AUDAPACK_BOARD, log + "\n", last_event=12)
        found = atoms(root, "T-113")
        self.assertEqual([r["kind"] for r in found], ["legacy-done-review"])


class TargetDLegacyAttributionTests(unittest.TestCase):
    """Legacy owner without claim_time preserves attribution."""

    def test_1_legacy_done_with_owner_only_gets_no_destructive_claim_clear(self):
        root = audapack_project()
        self.assertNotIn("claim-clear", kinds(root, "T-060"))
        self.assertEqual(atoms(root, "T-060"), [])

    def test_2_modern_doing_with_owner_only_is_an_invalid_live_claim(self):
        board = AUDAPACK_BOARD.replace(
            "- [/] T-900 active work | verify: resume | owner: test-agent "
            "| claim_time: 2026-09-15T00:00:00Z",
            "- [/] T-900 active work | verify: resume | owner: test-agent",
        )
        root = project(board, AUDAPACK_LOG + "\n", last_event=11)
        found = atoms(root, "T-900")
        self.assertIn("claim-clear", {r["kind"] for r in found})
        clear = next(r for r in found if r["kind"] == "claim-clear")
        self.assertEqual(clear["fields"], ["owner", "claim_time"])
        self.assertIn("claimable Work", clear["reason"])

    def test_3_modern_todo_with_half_claim_keeps_current_repair_semantics(self):
        board = AUDAPACK_BOARD.replace(
            "## TODO\n",
            "## TODO\n- [ ] T-901 half claimed todo | verify: repaired "
            "| claim_time: 2026-09-15T00:00:00Z\n",
        )
        log = AUDAPACK_LOG + "\n" + event(
            12, "T-901", "DEC: ticket added", op="ticket-" + "e" * 32
        )
        root = project(board, log + "\n", last_event=12)
        found = atoms(root, "T-901")
        self.assertEqual([r["kind"] for r in found], ["claim-clear"])
        self.assertEqual(found[0]["section"], "## TODO")

    def test_4_legacy_attribution_survives_a_full_reconciliation(self):
        root = audapack_project()
        # Clear the one genuinely ambiguous record so the plan is applicable,
        # then apply the whole approved plan and read the committed bytes.
        plan = reconcile_protocol_state(
            root, "test-agent", dry_run=True, attest_legacy_done=["T-118"]
        )
        applied = reconcile_protocol_state(
            root,
            "test-agent",
            attest_legacy_done=["T-118"],
            approved_repair_id=plan["repair_id"],
        )
        self.assertTrue(applied["ok"], applied)
        board = board_of(root)
        legacy_line = next(
            line for line in board.splitlines() if line.startswith("- [x] T-060")
        )
        self.assertIn("owner: claude", legacy_line)
        self.assertNotIn("claim_time:", legacy_line)
        self.assertEqual(section_of(root, "T-060"), "## DONE")

    def test_5_a_legacy_done_owner_is_never_read_as_an_active_lease(self):
        root = audapack_project()
        board = parse_board(board_of(root))
        state = {"task": "T-900", "agent": "test-agent"}
        own = classify_active_ownership(state, board, "test-agent")
        # The seat is the DOING record, never the terminal legacy attribution.
        self.assertEqual(own.active_ticket, "T-900")
        self.assertEqual(own.board_owner, "test-agent")

    def test_a_terminal_claim_time_without_owner_is_still_repaired(self):
        # Nothing to preserve: an orphan lease stamp on terminal Work is not
        # attribution, so the both-or-neither repair still owns it.
        board = AUDAPACK_BOARD.replace(
            "- [x] T-060 legacy attribution | verify: historical owner, "
            "pre-claim_time | owner: claude",
            "- [x] T-060 legacy attribution | verify: historical owner, "
            "pre-claim_time | claim_time: 2026-09-02T01:00:00Z",
        )
        root = project(board, AUDAPACK_LOG + "\n", last_event=11)
        self.assertIn("claim-clear", kinds(root, "T-060"))


class AttestLegacyDoneTests(unittest.TestCase):
    """The exact operator decision the refusal names must actually exist."""

    def test_the_refusal_names_a_reachable_canonical_command(self):
        root = audapack_project()
        result = reconcile_protocol_state(root, "test-agent", dry_run=True)
        self.assertEqual(result["code"], "RECONCILE_REAUTH_REQUIRED")
        refused = [
            r for r in result.get("refused", []) if r.get("kind") == "legacy-done-review"
        ]
        self.assertTrue(refused, result)

    def test_attestation_clears_the_ambiguity_without_rewriting_history(self):
        root = audapack_project(modern_phantom=False)
        log_before = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        applied = reconcile_protocol_state(
            root, "test-agent", attest_legacy_done=["T-118"]
        )
        self.assertTrue(applied["ok"], applied)
        log_after = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        # Append-only: every historical line is byte-identical.
        self.assertTrue(log_after.startswith(log_before.rstrip("\n")), log_after)
        self.assertIn("legacy completion attested for T-118", log_after)
        self.assertEqual(section_of(root, "T-118"), "## DONE")
        record = next(
            row for row in board_of(root).splitlines() if row.startswith("- [x] T-118")
        )
        self.assertNotIn("closure_mode", record)
        # The record is no longer ambiguous on the next pass.
        self.assertEqual(atoms(root, "T-118"), [])

    def test_cli_attest_round_trip_and_id_grammar(self):
        root = audapack_project(modern_phantom=False)
        with _unbound_host():
            code = saipen_main(
                [
                    "recover",
                    "--attest-legacy-done",
                    "T-118",
                    "--project-root",
                    str(root),
                    "--agent",
                    "test-agent",
                    "--json",
                ]
            )
        self.assertEqual(code, 0)
        self.assertIn(
            "legacy completion attested for T-118",
            (root / ".saipen" / "LOG.md").read_text(encoding="utf-8"),
        )

    def test_cli_refuses_a_malformed_attest_id(self):
        root = audapack_project()
        with _unbound_host():
            code = saipen_main(
                [
                    "recover",
                    "--attest-legacy-done",
                    "not-a-ticket",
                    "--project-root",
                    str(root),
                    "--agent",
                    "test-agent",
                    "--json",
                ]
            )
        self.assertEqual(code, 2)


class PlanIdentityTests(unittest.TestCase):
    """Approval stays content-bound with the boundary in place."""

    def test_the_repair_id_binds_the_refusals_too(self):
        # Identical mutation set, different REFUSAL set -> a different plan id.
        # An approval the operator gave while an ambiguous legacy record was in
        # the report cannot be replayed after that record's evidence changed.
        ambiguous = audapack_project()
        resolved = project(
            AUDAPACK_BOARD,
            AUDAPACK_LOG
            + "\n"
            + event(12, "T-118", "RUN: BUILD -- historical implementation")
            + "\n",
            last_event=12,
        )
        first = reconcile_protocol_state(ambiguous, "test-agent", dry_run=True)
        second = reconcile_protocol_state(resolved, "test-agent", dry_run=True)
        self.assertNotEqual(first["repair_id"], second["repair_id"])

    def test_an_approval_from_a_different_surface_is_still_stale(self):
        root = audapack_project()
        stale = reconcile_protocol_state(root, "test-agent", approved_repair_id="0" * 64)
        self.assertFalse(stale["ok"], stale)
        self.assertEqual(stale["code"], "STALE_APPROVED_REPAIR")

    def test_attestation_plus_approval_commits_both_in_one_pass(self):
        root = audapack_project()
        plan = reconcile_protocol_state(
            root, "test-agent", dry_run=True, attest_legacy_done=["T-118"]
        )
        applied = reconcile_protocol_state(
            root,
            "test-agent",
            attest_legacy_done=["T-118"],
            approved_repair_id=plan["repair_id"],
        )
        self.assertTrue(applied["ok"], applied)
        self.assertEqual(section_of(root, "T-118"), "## DONE")
        self.assertEqual(section_of(root, "T-195"), "## TODO")


class NoFrontierAttestationTests(unittest.TestCase):
    """The remedy a `legacy-done-review` refusal names must clear that refusal.

    Measured (T-1346) on a project that never observed the closure contract
    (`_closure_contract_frontier` is None): the attestation DEC is itself a
    mechanized `[op: ...]` event, so the very next pass re-classified the
    record as `current` and answered with a phantom-DONE reopen approval. The
    operator's classification of a record as legacy must not be read as
    closure-generation evidence.
    """

    @staticmethod
    def _frontier_none_project(*, op: str | None = None) -> Path:
        board = (
            "## DOING\n"
            "## TODO\n"
            "## DONE\n"
            "- [x] T-001 legacy completion | verify: PASS -- fixture\n"
            "## BLOCKED\n"
        )
        root = project(
            board, event(1, "T-001", "DEC: ticket added", op=op), task="none", last_event=1
        )
        # A terminal project, not a BUILD-in-progress one: the legacy
        # next_action refusal is a different operator decision and must not
        # stand in for the one under test.
        state = (
            STATE_TEMPLATE.format(task="none", last_event=1)
            .replace("phase: BUILD", "phase: DONE")
            .replace('next_action: "PHASE BUILD none"', 'next_action: "saipen continue"')
            .replace("transition_from: PLAN", "transition_from: SHIP")
        )
        (root / ".saipen" / "STATE.md").write_text(state, encoding="utf-8")
        return root

    def test_the_named_remedy_clears_the_refusal(self):
        root = self._frontier_none_project()
        plan = reconcile_protocol_state(root, "test-agent", dry_run=True)
        legacy_refusals = [
            r
            for r in plan.get("refused", [])
            if r.get("ticket") == "T-001" and r.get("kind") == "legacy-done-review"
        ]
        self.assertEqual(len(legacy_refusals), 1, plan)
        self.assertEqual(
            legacy_refusals[0]["canonical_next_command"],
            "saipen recover --attest-legacy-done T-001",
        )

        with _unbound_host():
            code = saipen_main(
                [
                    "recover",
                    "--attest-legacy-done",
                    "T-001",
                    "--project-root",
                    str(root),
                    "--agent",
                    "test-agent",
                    "--json",
                ]
            )
        self.assertEqual(code, 0)

        # The refusal is gone: no atom remains and the router is not refused.
        self.assertEqual(atoms(root, "T-001"), [])
        self.assertNotEqual(
            reconcile_protocol_state(root, "test-agent", dry_run=True).get("code"),
            "RECONCILE_REAUTH_REQUIRED",
        )
        with _unbound_host():
            code = saipen_main(
                [
                    "continue",
                    "--dry-run",
                    "--project-root",
                    str(root),
                    "--agent",
                    "test-agent",
                    "--json",
                ]
            )
        self.assertEqual(code, 0)

    def test_a_genuinely_mechanized_record_is_still_current(self):
        # The exception is narrow: a record touched by a real canonical
        # operation in the same frontier-None project stays `current`, so its
        # missing closure evidence still needs the operator's reopen approval.
        root = self._frontier_none_project(op="ticket-" + "d" * 32)
        self.assertIn("section-move", kinds(root, "T-001"))
        self.assertNotIn("legacy-done-review", kinds(root, "T-001"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
