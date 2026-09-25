"""T-1336: the allocation-identity stop must be reachable from every section.

`tools/validate.py` arms the CORE-003 / SRC-026:R003 allocation-identity check
over EVERY BOARD record in EVERY section: a ticket with no `[T-###]` event in
the complete history is a detached hand-injected record wherever it sits.

The canonical repair -- `_board_adoption_repairs`, reached as
`saipen recover --adopt-legacy` -- used to scan only `## TODO` and `## DOING`.
A record in any other section therefore produced a RED validator with no
operation able to see it:

    validate.py            -> 9 problem(s)
    saipen recover         -> CLEAN
    recover --adopt-legacy -> cannot name them
    pre-commit gate        -> refuses every commit

`needs_local_mutation` true while every local repair operation refuses is the
exact combination T-1324 closed as forbidden. This repository reproduced it
with nine `## BLOCKED` records, and the consequence was not cosmetic: the
source could never go clean, so the distribution guard stayed at DIRTY_SOURCE
and all six installed agent homes stayed stale.

The property this suite pins is PARITY, not a wider section list: the repair
scans exactly the record set the validator judges.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.board import detached_ticket_id_known_ids, parse_board  # noqa: E402
from saipen_engine.log import read_history_snapshot  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from saipen_engine.reconcile import (  # noqa: E402
    _board_adoption_repairs,
    reconcile_protocol_state,
)

_TEMPS: list[tempfile.TemporaryDirectory] = []

STATE = """---
phase: BUILD
task: T-500
next_action: "PHASE BUILD T-500"
blocker: ""
transition_from: PLAN
saipen_version: 7
schema_version: 3
last_event: 3
style_contract: ded-4ae736e4
mode: full
updated: 2026-09-15T00:00:00Z
agent: test-agent
---
"""

# T-500 is allocated by a real structured event. T-501..T-504 are detached
# hand-injected records, one in each remaining section, so the fixture covers
# every section the validator judges.
DONE_RECORD = (
    "- [x] T-503 detached done | verify: adopted or refused | owner: test-agent "
    "| claim_time: 2026-09-15T00:00:00Z | closure_mode: own_patch"
)

BOARD = f"""## DOING
- [/] T-500 attested active | verify: resume | owner: test-agent | claim_time: 2026-09-15T00:00:00Z
## TODO
- [ ] T-501 detached todo | verify: adopted or refused
## DONE
{DONE_RECORD}
## BLOCKED
- [ ] T-504 detached blocked | verify: adopted or refused | blocker: external
"""

# The floor allows exactly one ## DOING opener, so the detached-DOING case gets
# its own fixture rather than a second opener in the one above.
DOING_RECORD = (
    "- [/] T-502 detached doing | verify: adopted or refused | owner: test-agent "
    "| claim_time: 2026-09-15T00:00:00Z"
)

DOING_BOARD = f"""## DOING
{DOING_RECORD}
## TODO
## DONE
## BLOCKED
"""

DOING_STATE = STATE.replace("T-500", "T-502")

LOG = (
    "- 15.09.26 00:00 [E-001] [T-500] [agent: test-agent] "
    "[op: ticket-00000000000000000000000000000000] DEC: ticket added via SAIOPS\n"
    "- 15.09.26 00:00 [E-002] [parent: E-001] [T-500] [agent: test-agent] "
    "[op: claim-00000000000000000000000000000001] DEC: claimed via SAIOPS -- owner test-agent\n"
    "- 15.09.26 00:00 [E-003] [parent: E-002] [agent: test-agent] "
    "[op: transition-00000000000000000000000000000002] RUN: transition to BUILD\n"
)

DETACHED = ("T-501", "T-503", "T-504")
SECTION_OF = {
    "T-501": "## TODO",
    "T-502": "## DOING",
    "T-503": "## DONE",
    "T-504": "## BLOCKED",
}


def detached_project(board: str = BOARD, state: str = STATE) -> Path:
    tmp = tempfile.TemporaryDirectory(prefix="saipen-adoption-parity-")
    _TEMPS.append(tmp)
    root = Path(tmp.name)
    memory = root / ".saipen"
    memory.mkdir(parents=True)
    (memory / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (memory / "STATE.md").write_text(state, encoding="utf-8")
    (memory / "BOARD.md").write_text(board, encoding="utf-8")
    (memory / "LOG.md").write_text(LOG, encoding="utf-8")
    return root


def _surfaces(root: Path):
    memory = root / ".saipen"
    board = parse_board((memory / "BOARD.md").read_text(encoding="utf-8"))
    history = read_history_snapshot(root)
    return board, history


def repairs_for(root: Path, adopt=()) -> list[dict]:
    board, history = _surfaces(root)
    return _board_adoption_repairs(board, history, adopt)


def log_of(root: Path) -> str:
    return (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")


class AdoptionSectionParityTests(unittest.TestCase):
    def test_the_repair_scans_exactly_the_set_the_validator_judges(self):
        """The parity property itself, computed from both sides."""
        root = detached_project()
        board, history = _surfaces(root)
        known = detached_ticket_id_known_ids(history)
        # The validator's own predicate: every ticket, any section.
        validator_judged = {tid for tid in board["tickets"] if tid not in known}
        repair_named = {r["ticket"] for r in repairs_for(root)}
        self.assertEqual(validator_judged, set(DETACHED))
        self.assertEqual(repair_named, validator_judged)

    def test_every_section_reaches_an_operator_decision(self):
        root = detached_project()
        found = {r["ticket"]: r for r in repairs_for(root)}
        for tid in DETACHED:
            with self.subTest(section=SECTION_OF[tid]):
                repair = found[tid]
                self.assertTrue(repair["refuse"])
                self.assertTrue(repair["operator_decision_available"])
                self.assertEqual(
                    repair["canonical_next_command"],
                    f"saipen recover --adopt-legacy {tid}",
                )
                self.assertIn(SECTION_OF[tid], repair["reason"])

    def test_an_attested_record_is_still_skipped(self):
        root = detached_project()
        self.assertNotIn("T-500", {r["ticket"] for r in repairs_for(root)})

    def test_recover_surfaces_the_refusal_instead_of_certifying_clean(self):
        root = detached_project()
        result = reconcile_protocol_state(root, "test-agent", dry_run=True)
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "RECONCILE_REAUTH_REQUIRED")
        self.assertTrue(result.get("operator_decision_available"), result)
        self.assertIn("--adopt-legacy", result.get("canonical_next_command", ""))

    def test_a_detached_doing_record_is_still_covered(self):
        """The two sections the old filter DID scan must not regress."""
        root = detached_project(DOING_BOARD, DOING_STATE)
        found = {r["ticket"]: r for r in repairs_for(root)}
        self.assertEqual(set(found), {"T-502"})
        self.assertTrue(found["T-502"]["refuse"])
        self.assertIn("## DOING", found["T-502"]["reason"])

    def test_naming_only_some_records_adopts_none(self):
        """Approval is per record: an unnamed one refuses the whole pass.

        This is what keeps an unknown suspicious record from being laundered
        into authority by riding along with a legitimate adoption.
        """
        root = detached_project()
        before = log_of(root)
        result = reconcile_protocol_state(root, "test-agent", adopt_legacy=["T-504"])
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "RECONCILE_REAUTH_REQUIRED")
        self.assertEqual(
            sorted(r["ticket"] for r in result["refused"]), ["T-501", "T-503"]
        )
        self.assertEqual(log_of(root), before, "a refused pass wrote to the LOG")

    def test_the_whole_detached_set_adopts_in_one_bounded_operation(self):
        root = detached_project()
        before = log_of(root)
        board_before = (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        result = reconcile_protocol_state(root, "test-agent", adopt_legacy=list(DETACHED))
        self.assertTrue(result["ok"], result)
        after = log_of(root)
        # Append-only: no historical line is rewritten, no allocation is faked.
        self.assertTrue(after.startswith(before.rstrip("\n")), after)
        for tid in DETACHED:
            self.assertIn(f"LEGACY_ADOPTED {tid}", after)
        self.assertIn("no historical allocation or actor fabricated", after)
        self.assertEqual(after.count("LEGACY_ADOPTED"), len(DETACHED))
        # Adoption is a LOG decision: the records keep their own bytes,
        # including a terminal record's closure_mode, which nothing fabricates
        # and nothing strips.
        self.assertIn(DONE_RECORD, board_before)
        self.assertIn(DONE_RECORD, (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8"))
        # Nothing is left refusing, and the surface is CLEAN on the next pass.
        self.assertEqual(repairs_for(root), [])
        again = reconcile_protocol_state(root, "test-agent", dry_run=True)
        self.assertTrue(again["ok"], again)
        self.assertEqual(again["code"], "CLEAN")


def tearDownModule() -> None:
    for tmp in _TEMPS:
        tmp.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
