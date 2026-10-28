"""Audit-route detector regressions (T-1270, SOURCE-AUDIT-INBOX-01).

The route was deterministic in law and in code and nothing verified an agent
had followed it. Witnessed on another project running this protocol: an agent
found a 17-ticket audit campaign, then stopped and offered the human a
three-option scope menu. `wait_categories` is a closed set of seven and scope
selection is not among them, so that pause had no legal form -- and no
detector. A rule with a route and no detector is a preference.

The detector's two hard edges are the quiet ones. It must NOT fire on a
diagnostic verdict, because an unreadable layer or an uncaptured leftover must
never outrank real Work; and it must NOT fire on a live phase-owned
continuation, because a fresh file never preempts a running transaction.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine.audit_route import (  # noqa: E402
    audit_route_owns,
    live_continuation,
    route_applies,
    route_violation,
)

WAIT_CATEGORIES = tuple(
    json.loads((ROOT / "saipen" / "REGISTRY.json").read_text(encoding="utf-8-sig"))[
        "wait_categories"
    ]
)

ROUTED = {
    "action": "saipen audit ingest",
    "layer": 1,
    "path": "audit/1.md",
    "rule_id": "SOURCE-AUDIT-INBOX-01",
}
PHASE_ROUTED = {"action": "PHASE SCOUT T-900", "layer": 2, "path": "audit/2.md", "work": "T-900"}


# ---------------------------------------------------------------------------
# AC-01 -- an unfollowed route goes red, and names the action
# ---------------------------------------------------------------------------


class UnfollowedRouteTests(unittest.TestCase):
    def test_an_unrelated_next_action_goes_red(self) -> None:
        why = route_violation(ROUTED, "saipen improve", [], WAIT_CATEGORIES)
        self.assertIsNotNone(why)

    def test_the_diagnostic_names_the_routed_action(self) -> None:
        why = route_violation(ROUTED, "saipen improve", [], WAIT_CATEGORIES)
        self.assertIn("saipen audit ingest", why)
        self.assertIn("audit/1.md", why)
        self.assertIn("saipen improve", why)

    def test_an_empty_next_action_goes_red_and_says_so(self) -> None:
        why = route_violation(ROUTED, "", [], WAIT_CATEGORIES)
        self.assertIsNotNone(why)
        self.assertIn("(empty)", why)

    def test_a_phase_route_is_matched_exactly(self) -> None:
        self.assertIsNone(route_violation(PHASE_ROUTED, "PHASE SCOUT T-900", [], WAIT_CATEGORIES))
        self.assertIsNotNone(
            route_violation(PHASE_ROUTED, "PHASE BUILD T-900", [], WAIT_CATEGORIES)
        )

    def test_following_the_route_is_quiet(self) -> None:
        self.assertIsNone(route_violation(ROUTED, "saipen audit ingest", [], WAIT_CATEGORIES))

    def test_surrounding_whitespace_is_not_a_violation(self) -> None:
        self.assertIsNone(route_violation(ROUTED, "  saipen audit ingest  ", [], WAIT_CATEGORIES))


# ---------------------------------------------------------------------------
# AC-02 -- a diagnostic must never outrank real Work
# ---------------------------------------------------------------------------


class DiagnosticsDoNotTripTests(unittest.TestCase):
    def test_an_invalid_only_inbox_never_trips_the_check(self) -> None:
        projection = {"action": "saipen audit status", "invalid_only": True}
        self.assertFalse(route_applies(projection))
        self.assertIsNone(route_violation(projection, "saipen improve", [], WAIT_CATEGORIES))

    def test_a_residue_only_inbox_never_trips_the_check(self) -> None:
        projection = {"action": "saipen audit status", "residue_only": True}
        self.assertFalse(route_applies(projection))
        self.assertIsNone(route_violation(projection, "saipen improve", [], WAIT_CATEGORIES))

    def test_an_absent_inbox_never_trips_the_check(self) -> None:
        for projection in (None, {}, {"action": ""}, "not a projection"):
            self.assertFalse(route_applies(projection))
            self.assertIsNone(route_violation(projection, "saipen improve", [], WAIT_CATEGORIES))

    def test_a_workable_layer_does_apply(self) -> None:
        # The positive control for the three above: if this ever went False the
        # check would be permanently quiet and every assertion here vacuous.
        self.assertTrue(route_applies(ROUTED))


# ---------------------------------------------------------------------------
# AC-03 -- a live claimed ticket keeps continuation
# ---------------------------------------------------------------------------


class LiveTicketKeepsContinuationTests(unittest.TestCase):
    def test_a_live_phase_continuation_stays_quiet(self) -> None:
        self.assertIsNone(route_violation(ROUTED, "PHASE BUILD T-400", ["T-400"], WAIT_CATEGORIES))

    def test_every_phase_name_counts_as_a_continuation(self) -> None:
        for phase in ("SCOUT", "BUILD", "VERIFY", "REVIEW", "SHIP"):
            self.assertIsNone(
                route_violation(ROUTED, f"PHASE {phase} T-400", ["T-400"], WAIT_CATEGORIES),
                phase,
            )

    def test_a_doing_ticket_alone_does_not_silence_the_check(self) -> None:
        # A next_action that wandered off its own claimed ticket is exactly the
        # drift being looked for, so the continuation has to name the ticket.
        why = route_violation(ROUTED, "saipen improve", ["T-400"], WAIT_CATEGORIES)
        self.assertIsNotNone(why)

    def test_a_continuation_naming_an_unclaimed_ticket_does_not_silence_it(self) -> None:
        why = route_violation(ROUTED, "PHASE BUILD T-999", ["T-400"], WAIT_CATEGORIES)
        self.assertIsNotNone(why)

    def test_live_continuation_returns_the_ticket_it_matched(self) -> None:
        self.assertEqual(live_continuation("PHASE BUILD T-400", ["T-400"]), "T-400")
        self.assertIsNone(live_continuation("PHASE BUILD T-400", []))
        self.assertIsNone(live_continuation("saipen continue", ["T-400"]))


# ---------------------------------------------------------------------------
# AC-04 -- the closed WAIT set is why a scope question has no legal form
# ---------------------------------------------------------------------------


class WaitHasNoScopeCategoryTests(unittest.TestCase):
    SCOPE_MENU = 'WAIT: which of these findings should I fix -- all, P1 only, or the first three?'

    def test_the_registry_wait_set_is_closed_and_has_no_scope_category(self) -> None:
        self.assertEqual(len(WAIT_CATEGORIES), 7)
        joined = " ".join(WAIT_CATEGORIES).lower()
        self.assertNotIn("scope", joined)

    def test_a_scope_wait_goes_red(self) -> None:
        self.assertIsNotNone(route_violation(ROUTED, self.SCOPE_MENU, [], WAIT_CATEGORIES))

    def test_the_diagnostic_cites_the_closed_set_as_the_reason(self) -> None:
        why = route_violation(ROUTED, self.SCOPE_MENU, [], WAIT_CATEGORIES)
        self.assertIn("closed set of 7 categories", why)
        self.assertIn("no legal form", why)
        for category in WAIT_CATEGORIES:
            self.assertIn(category, why)

    def test_a_non_wait_violation_does_not_lecture_about_wait(self) -> None:
        why = route_violation(ROUTED, "saipen improve", [], WAIT_CATEGORIES)
        self.assertNotIn("closed set", why)

    def test_the_citation_is_skipped_when_no_category_set_is_supplied(self) -> None:
        why = route_violation(ROUTED, self.SCOPE_MENU, [], ())
        self.assertIsNotNone(why)
        self.assertNotIn("closed set", why)


# ---------------------------------------------------------------------------
# AC-05 -- audit route workability authority (T-1317 audit route split fix)
# ---------------------------------------------------------------------------


class AuditRouteWorkabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workable_ticket = {
            "id": "T-900",
            "section": "## TODO",
            "checkbox": " ",
            "fields": {},
        }
        self.blocked_ticket = {
            "id": "T-900",
            "section": "## BLOCKED",
            "checkbox": " ",
            "fields": {"blocker": "waiting on upstream"},
        }
        self.phase_projection = {
            "action": "PHASE SCOUT T-900",
            "layer": 2,
            "path": "audit/2.md",
            "work": "T-900",
        }

    def test_workable_ticket_owns_continuation(self) -> None:
        tickets = {"T-900": self.workable_ticket}
        self.assertTrue(audit_route_owns(self.phase_projection, tickets=tickets))

    def test_blocked_ticket_does_not_own_continuation(self) -> None:
        tickets = {"T-900": self.blocked_ticket}
        self.assertFalse(audit_route_owns(self.phase_projection, tickets=tickets))

    def test_missing_ticket_does_not_own_continuation(self) -> None:
        tickets = {}
        self.assertFalse(audit_route_owns(self.phase_projection, tickets=tickets))

    def test_blocked_audit_work_does_not_trip_route_violation(self) -> None:
        tickets = {
            "T-900": self.blocked_ticket,
            "T-901": {"id": "T-901", "section": "## TODO", "checkbox": " ", "fields": {}},
        }
        # Router fell through to T-901; validator must agree and produce no violation.
        why = route_violation(
            self.phase_projection,
            "PHASE SCOUT T-901",
            [],
            WAIT_CATEGORIES,
            tickets=tickets,
        )
        self.assertIsNone(why)

    def test_workable_audit_work_trips_route_violation_when_wandering(self) -> None:
        tickets = {
            "T-900": self.workable_ticket,
            "T-901": {"id": "T-901", "section": "## TODO", "checkbox": " ", "fields": {}},
        }
        why = route_violation(
            self.phase_projection,
            "PHASE SCOUT T-901",
            [],
            WAIT_CATEGORIES,
            tickets=tickets,
        )
        self.assertIsNotNone(why)
        self.assertIn("PHASE SCOUT T-900", why)


# ---------------------------------------------------------------------------
# AC-06 -- the red control exists in the mutation suite
# ---------------------------------------------------------------------------


class RedControlIsDeclaredTests(unittest.TestCase):
    def test_the_mutation_suite_carries_an_audit_route_control(self) -> None:
        sys.path.insert(0, str(ROOT / "tools"))
        import audit_checks as A

        labels = [case[0] for case in A.CASES]
        matching = [label for label in labels if "audit route" in label.lower()]
        self.assertTrue(matching, "no audit-route case in the mutation suite")

    def test_that_control_declares_both_files_its_condition_needs(self) -> None:
        import audit_checks as A

        case = next(case for case in A.CASES if "audit route" in case[0].lower())
        _, rel, mutation, _, _ = A.case_parts(case)
        paths = A.case_declared_paths(rel, mutation)
        self.assertIn("audit/1.md", paths)
        self.assertIn(".saipen/STATE.md", paths)


if __name__ == "__main__":
    unittest.main()
