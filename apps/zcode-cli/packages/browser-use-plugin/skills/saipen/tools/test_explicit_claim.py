"""Explicit claim override regressions (T-1275, PICK-01).

CORE.md has always sanctioned the override -- "Board order is priority;
explicit override cannot bypass eligibility or authorization" -- and
`operations.claim` has always carried `explicit`. What did not exist was any
way for an operator to reach it: the CLI refused `--explicit` as a surplus
argument while the refusal text told them to use "the explicit-claim flag".
The only remaining path to claim a finished ticket that was not topmost was to
edit `BOARD.md` by hand, which `OPS.md` 4a calls FALLBACK ONLY and the
validator's `[saio]` check exists to detect.

The bar here is therefore two-sided: the override must WORK and must be
honest -- it records which ticket it stepped over, it stays silent when the
flag was redundant, and it opens no door that authorization had closed.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from saipen_engine.operations import apply_claim, plan_claim, ticket_add  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402

CLI = ROOT / "tools" / "saipen.py"
SCENARIO = ROOT / "tests" / "scenarios" / "userperson-valid" / ".saipen"
AGENT = "probe"

#: The two allocated tickets' exact BOARD serialization, in pick order.
TWO_TODO = (
    "# Board\n"
    "## DOING\n"
    "## TODO\n"
    "- [ ] T-1 [P1] top probe | verify: probe\n"
    "- [ ] T-2 [P1] lower probe | verify: probe\n"
    "## DONE\n"
    "## BLOCKED\n"
)


def setUpModule() -> None:
    """An outer host session must never bind this module's fixtures."""
    isolate_host_session()


class ExplicitClaimFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-explicit-claim-")
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        shutil.copytree(SCENARIO, self.root / ".saipen")
        (self.root / ".saipen" / "USERPERSON.md").unlink(missing_ok=True)
        self.board = self.root / ".saipen" / "BOARD.md"
        # CORE-003 / SRC-026:R003: ticket identity comes from a canonical
        # allocation event, never from a record that merely looks like a
        # ticket. Build T-1 and T-2 through the allocator, then restore the
        # exact serialized pick order this module pins (ticket_add prepends,
        # so the allocator alone leaves T-2 topmost).
        for description in ("top probe", "lower probe"):
            added = ticket_add(self.root, AGENT, "P1", description, [], "probe")
            self.assertTrue(added.ok, added.to_dict())
        self.board.write_text(TWO_TODO, encoding="utf-8")
        self.config = Path(self.tmp.name) / "user-config"
        self.env = patch.dict(os.environ, {"SAIPEN_USER_CONFIG_HOME": str(self.config)})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.tmp.cleanup()

    def log_text(self) -> str:
        return (self.root / ".saipen" / "LOG.md").read_text(encoding="utf-8")

    def board_with(self, text: str) -> None:
        self.board.write_text(text, encoding="utf-8")


class RefusalNamesTheRemedyTests(ExplicitClaimFixture):
    def test_the_refusal_names_the_flag_an_operator_can_type(self) -> None:
        out = plan_claim(self.root, "T-2", "probe")
        self.assertFalse(out.get("ok"))
        self.assertEqual(out.get("code"), "NOT_TOP_WORKABLE")
        # The whole defect: the remedy has to be copyable, not described.
        self.assertIn("--explicit", out.get("message") or out.get("detail") or "")

    def test_the_refusal_still_names_the_ticket_that_wins(self) -> None:
        out = plan_claim(self.root, "T-2", "probe")
        self.assertEqual(out.get("top_workable"), "T-1")

    def test_without_the_flag_the_pick_rule_is_unchanged(self) -> None:
        self.assertFalse(plan_claim(self.root, "T-2", "probe").get("ok"))
        top = apply_claim(self.root, "T-1", "probe")
        self.assertTrue(top.get("ok"), top)
        self.assertEqual(top.get("code"), "CLAIMED")


class OverrideWorksTests(ExplicitClaimFixture):
    def test_explicit_claims_a_ticket_the_pick_rule_would_refuse(self) -> None:
        out = apply_claim(self.root, "T-2", "probe", explicit=True)
        self.assertTrue(out.get("ok"), out)
        self.assertEqual(out.get("code"), "CLAIMED")
        self.assertIn("- [/] T-2", self.board.read_text(encoding="utf-8"))

    def test_the_override_records_the_ticket_it_stepped_over(self) -> None:
        apply_claim(self.root, "T-2", "probe", explicit=True)
        line = [ln for ln in self.log_text().splitlines() if "[T-2]" in ln][-1]
        self.assertIn("EXPLICIT claim over PICK-01", line)
        self.assertIn("topmost workable was T-1", line)

    def test_a_redundant_flag_writes_no_stepped_over_claim(self) -> None:
        # T-1 IS topmost. Annotating it would put a false statement into
        # append-only history, which is worse than a missing annotation.
        out = apply_claim(self.root, "T-1", "probe", explicit=True)
        self.assertTrue(out.get("ok"), out)
        line = [ln for ln in self.log_text().splitlines() if "[T-1]" in ln][-1]
        self.assertNotIn("EXPLICIT", line)
        self.assertNotIn("stepped", line)

    def test_an_empty_board_never_manufactures_a_stepped_over_ticket(self) -> None:
        self.board_with(
            "# Board\n## DOING\n## TODO\n"
            "- [ ] T-9 [P1] only | verify: probe\n"
            "## DONE\n## BLOCKED\n"
        )
        apply_claim(self.root, "T-9", "probe", explicit=True)
        line = [ln for ln in self.log_text().splitlines() if "[T-9]" in ln][-1]
        self.assertNotIn("EXPLICIT", line)


class OverrideBypassesOnlyOrderingTests(ExplicitClaimFixture):
    """`explicit override cannot bypass eligibility or authorization` (CORE.md)."""

    def test_a_blocker_still_refuses_with_the_flag(self) -> None:
        self.board_with(
            "# Board\n## DOING\n## TODO\n"
            "- [ ] T-1 [P1] top probe | verify: probe\n"
            "- [ ] T-2 [P1] lower probe | blocker: WAIT_USER_CONFIRMATION | verify: probe\n"
            "## DONE\n## BLOCKED\n"
        )
        out = apply_claim(self.root, "T-2", "probe", explicit=True)
        self.assertFalse(out.get("ok"), out)

    def test_unmet_needs_still_refuse_with_the_flag(self) -> None:
        self.board_with(
            "# Board\n## DOING\n## TODO\n"
            "- [ ] T-1 [P1] top probe | verify: probe\n"
            "- [ ] T-2 [P1] lower probe | needs: T-1 | verify: probe\n"
            "## DONE\n## BLOCKED\n"
        )
        out = apply_claim(self.root, "T-2", "probe", explicit=True)
        self.assertFalse(out.get("ok"), out)
        self.assertEqual(out.get("code"), "TICKET_NOT_WORKABLE")

    def test_a_live_doing_ticket_still_refuses_with_the_flag(self) -> None:
        self.assertTrue(apply_claim(self.root, "T-1", "probe").get("ok"))
        out = apply_claim(self.root, "T-2", "probe", explicit=True)
        self.assertFalse(out.get("ok"), out)
        self.assertEqual(out.get("code"), "ALREADY_CLAIMED")

    def test_an_unknown_ticket_still_refuses_with_the_flag(self) -> None:
        out = apply_claim(self.root, "T-404", "probe", explicit=True)
        self.assertFalse(out.get("ok"), out)


class CliSurfaceTests(ExplicitClaimFixture):
    def run_cli(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(CLI), *argv, "--project-root", str(self.root), "--json"],
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_the_flag_reaches_the_engine_through_the_cli(self) -> None:
        done = self.run_cli("claim", "T-2", "--explicit")
        self.assertIn('"CLAIMED"', done.stdout, done.stdout + done.stderr)
        self.assertIn("- [/] T-2", self.board.read_text(encoding="utf-8"))

    def test_the_cli_still_refuses_a_real_surplus_argument(self) -> None:
        out = self.run_cli("claim", "T-2", "--explicit", "T-3")
        self.assertIn("VALIDATION_FAILED", out.stdout, out.stdout + out.stderr)

    def test_the_flag_alone_is_not_a_ticket_id(self) -> None:
        out = self.run_cli("claim", "--explicit")
        self.assertIn("VALIDATION_FAILED", out.stdout, out.stdout + out.stderr)


class AllocationIdentityControlTests(ExplicitClaimFixture):
    """RED control: canonical allocation is the only source of ticket identity.

    The fixture above builds T-1/T-2 through the allocator. A record that
    merely LOOKS like a ticket must still block canonical writes, or the
    rewrite would have replaced the protected invariant with a green
    assertion.
    """

    def test_a_phantom_record_blocks_an_unrelated_claim(self) -> None:
        self.board_with(
            "# Board\n## DOING\n## TODO\n"
            "- [ ] T-1 [P1] top probe | verify: probe\n"
            "- [ ] T-99 [P1] phantom | verify: probe\n"
            "## DONE\n## BLOCKED\n"
        )
        out = apply_claim(self.root, "T-1", "probe")
        self.assertFalse(out.get("ok"), out)
        self.assertEqual(out.get("code"), "VALIDATION_FAILED", out)
        self.assertIn("T-99", out.get("message") or "", out)
        self.assertIn("allocation event", out.get("message") or "", out)


if __name__ == "__main__":
    unittest.main()
