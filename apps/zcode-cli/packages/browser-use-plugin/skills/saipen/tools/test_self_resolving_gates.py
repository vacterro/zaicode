"""T-1161 regression: self-resolving gates / no-human-courier.

INC-MUSE-SHIP-INTERNAL-CHOICE-001: an agent mid-ship asked the user
"Should I fix WAIT states now, or run sub collect first?" -- outsourcing an
INTERNAL PROTOCOL SEQUENCING question to a human. Multiple possible actions
never equaled human authority.

Laws pinned here:
    IF THE PROTOCOL CAN DECIDE IT, THE HUMAN MUST NOT BE ASKED.
    MULTIPLE POSSIBLE INTERNAL ACTIONS DO NOT CREATE A HUMAN DECISION.
    PASSING VALIDATION WITH FALSE STATE IS WORSE THAN FAILING WITH TRUE STATE.
    STALE + REFRESHABLE IS ACTIONABLE, NEVER BLOCKED.

Run standalone:  python tools/test_self_resolving_gates.py
"""

from __future__ import annotations

import io
import contextlib
import json
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(TOOLS))

from saipen_engine import disposition as D  # noqa: E402
import saipen as CLI  # noqa: E402


class DispositionClassifierTests(unittest.TestCase):
    def test_incident_shape_two_internal_actions_still_execute_self(self):
        """INC-MUSE-SHIP-INTERNAL-CHOICE-001: collect-vs-repair is agent work."""
        carrier = {
            "ok": False,
            "code": "CREW_BLOCKED",
            "stage": "SC-2",
            "execute_in_current_agent": True,
            "requires_human": False,
            "terminal": False,
            "next_action": "RUN_ROLE",
        }
        verdict = D.classify_carrier(carrier)
        self.assertEqual(verdict["disposition"], D.EXECUTE_SELF)
        self.assertFalse(verdict["requires_human"])

    def test_complete_and_reconcile_and_invalid(self):
        self.assertEqual(
            D.classify_carrier({"crew_complete": True})["disposition"], D.COMPLETE
        )
        reconcile = D.classify_carrier({"code": "RECOVERY_REQUIRED"})
        self.assertEqual(reconcile["disposition"], D.RECONCILE_SELF)
        self.assertFalse(reconcile["requires_human"])
        invalid = D.classify_carrier({"code": "VALIDATION_FAILED"})
        self.assertEqual(invalid["disposition"], D.INVALID)

    def test_explicit_human_boundary_only_source_of_wait_user(self):
        verdict = D.classify_carrier({"code": "X", "requires_human": True})
        self.assertEqual(verdict["disposition"], D.WAIT_USER)
        wait = D.classify_carrier(
            {"next_action": "WAIT: destructive-op -- approve schema drop?"}
        )
        self.assertEqual(wait["disposition"], D.WAIT_USER)
        # `blocked`/`safety valve` WAIT categories are NOT user questions.
        not_user = D.classify_carrier(
            {"next_action": "WAIT: blocked -- no workable ticket"}
        )
        self.assertEqual(not_user["disposition"], D.BLOCKED)
        self.assertFalse(not_user["requires_human"])

    def test_unstructured_carrier_fails_closed_invalid(self):
        self.assertEqual(D.classify_carrier(None)["disposition"], D.INVALID)
        self.assertEqual(D.classify_carrier("prose")["disposition"], D.INVALID)

    def test_external_boundary_is_never_user_courier(self):
        verdict = D.classify_carrier({"code": "FIRST_PUBLISH_WAIT"})
        self.assertEqual(verdict["disposition"], D.WAIT_EXTERNAL)
        self.assertFalse(verdict["requires_human"])


class UserWaitProofTests(unittest.TestCase):
    """P0 proof obligation: vague waits are illegal; AUTO-07/08/16 legal."""

    def _proof(self, **overrides):
        base = {
            "missing_authority": "user owns release bundle composition policy",
            "evidence_insufficient": (
                "protocol and LOG carry no recorded preference; both options "
                "satisfy spec differently"
            ),
            "consequence": "shipping bundle A vs B changes the public artifact",
        }
        base.update(overrides)
        return D.user_wait_proof(**base)

    def test_genuine_product_choice_passes(self):
        self.assertTrue(self._proof()["valid"])  # AUTO-07 legitimate wait

    def test_vague_need_decision_fails(self):
        verdict = D.user_wait_proof(
            missing_authority="decision",  # placeholder: too short
            evidence_insufficient="",
            consequence=None,
        )
        self.assertFalse(verdict["valid"])
        for name in ("missing_authority", "evidence_insufficient", "consequence"):
            self.assertIn(name, verdict["gaps"])

    def test_operational_choice_cannot_be_laundered_into_wait(self):
        # AUTO-05/06: two internal repair orders. The classifier offers NO
        # path from an operational carrier to WAIT_USER -- only explicit
        # requires_human or a human-boundary WAIT category produce it. And a
        # lazily filled proof form (placeholder consequence) fails the gate.
        lazy = D.user_wait_proof(
            missing_authority="which of two internal orders to run first",
            evidence_insufficient="protocol does not spell out this exact pair",
            consequence="none",
        )
        self.assertFalse(lazy["valid"])
        self.assertIn("consequence", lazy["gaps"])


class TraceabilityTests(unittest.TestCase):
    """AUTO-12/13 + INC-TRACEABILITY-UMBRELLA-LAUNDERING-001."""

    def _findings(self, count: int) -> list[dict]:
        return [
            {
                "id": f"CORE-{i:02d}",
                "disposition": "fixed by T-900",
                "evidence": f"LOG E-{1000+i}",
                "verification": "verified",
            }
            for i in range(1, count + 1)
        ]

    def test_umbrella_without_mapping_is_laundering(self):
        result = D.reconstruct_traceability(
            self._findings(17),
            summary_ticket={"id": "T-1052", "title": "17 audit tickets done"},
        )
        self.assertFalse(result["ok"])
        self.assertTrue(any("does not durably reference" in p for p in result["problems"]))

    def test_umbrella_with_full_mapping_passes(self):
        findings = self._findings(3)
        result = D.reconstruct_traceability(
            findings,
            summary_ticket={"id": "T-1052", "finding_ids": [f["id"] for f in findings]},
        )
        self.assertTrue(result["ok"], result["problems"])

    def test_missing_disposition_or_evidence_fails_per_finding(self):
        bad = [{"id": "W2-01", "disposition": "", "evidence": "E-1", "verification": "verified"}]
        result = D.reconstruct_traceability(bad)
        self.assertFalse(result["ok"])
        self.assertIn("W2-01: missing disposition", result["problems"])

    def test_verification_must_be_explicit_not_inferred(self):
        lazy = [{"id": "P-1", "disposition": "fixed", "evidence": "E-2"}]
        result = D.reconstruct_traceability(lazy)
        self.assertFalse(result["ok"])
        self.assertTrue(any("verification" in p for p in result["problems"]))


class SemanticTruthTests(unittest.TestCase):
    """INC-VALIDATOR-SEMANTIC-LAUNDERING-001 / AUTO-04."""

    def test_actionable_stale_never_classifies_blocked_even_if_vocab_allows(self):
        stale_but_refreshable = {
            "code": "CREW_BLOCKED",
            "stage": "SC-2",
            "reason": "role/package evidence is stale",
            "execute_in_current_agent": True,
            "requires_human": False,
            "terminal": False,
            "next_action": "RUN_ROLE",
        }
        verdict = D.classify_carrier(stale_but_refreshable)
        self.assertNotEqual(verdict["disposition"], D.BLOCKED)
        self.assertEqual(verdict["disposition"], D.EXECUTE_SELF)

    def test_blocked_reserved_for_no_executable_path(self):
        hard = {"code": "CAPABILITY_UNAVAILABLE", "terminal": True, "reason": "no recovery"}
        self.assertEqual(D.classify_carrier(hard)["disposition"], D.BLOCKED)


class ExplainNextDiagnosticTests(unittest.TestCase):
    """P2 decision trace: read-only, ownership-explicit, machine-readable."""

    @staticmethod
    def _scaffold(tmp_root: Path) -> Path:
        import shutil

        repo = Path(TOOLS).parent
        fixture = repo / "tests/scenarios/done-wait-deadlock-goal-mode/.saipen"
        root = tmp_root / "proj"
        root.mkdir()
        shutil.copytree(fixture, root / ".saipen")
        state = root / ".saipen/STATE.md"
        text = state.read_text(encoding="utf-8")
        repaired = "\n".join(
            line
            for line in text.splitlines()
            if not line.startswith("saipen_home:")
        ) + "\n"
        state.write_text(repaired, encoding="utf-8")
        return root

    def test_explain_next_reports_owner_agent_for_internal_stage(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = self._scaffold(Path(tmp))
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                rc = CLI.main(["--json", "--project-root", str(root), "explain-next"])
            payload = json.loads(buffer.getvalue())
            self.assertEqual(rc, 0)
            self.assertEqual(payload["code"], "EXPLAIN_NEXT")
            self.assertIn(payload["disposition"], D.DISPOSITIONS)
            self.assertIn(payload["owner"], ("agent", "user"))
            self.assertIn("human-owned information or authority", payload["note"])

    def test_explain_next_accepts_no_arguments(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = self._scaffold(Path(tmp))
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                rc = CLI.main(["--json", "--project-root", str(root), "explain-next", "x"])
            payload = json.loads(buffer.getvalue())
            self.assertEqual(rc, 2)
            self.assertEqual(payload.get("code"), "VALIDATION_FAILED")


class LabelVsContentTests(unittest.TestCase):
    """AUTO-22: ticket names are not authority; content decides ownership."""

    def test_classifier_never_reads_titles(self):
        # The classifier API takes structured carrier fields only -- there is
        # no code path through which a ticket TITLE could influence it.
        carrier = {"code": "CREW_ACTION", "execute_in_current_agent": True}
        verdict = D.classify_carrier(carrier)
        self.assertEqual(verdict["disposition"], D.EXECUTE_SELF)
        blob = json.dumps(D.DISPOSITIONS)
        self.assertNotIn("user-ticket-title", blob)


if __name__ == "__main__":
    unittest.main(verbosity=2)
