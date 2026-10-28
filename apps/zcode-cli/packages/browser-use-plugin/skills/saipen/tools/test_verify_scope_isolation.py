"""VERIFY verdicts are scoped to the active ticket's own acceptance surface (T-1444, SRC-099).

Measured live on SAIMAIL T-99: the verify checkpoints honestly reported the
SAIPEN core gate's INHERITED failures ("SAIPEN core 4 FAIL / 22 WARN
(inherited)") next to the ticket's own green suite; `_claims_failure` counted
the foreign 4 as T-99's own claim, VERIFY -> REVIEW refused, and the session
misread the echoed text as a requirement to reproduce the previous
experiment's evidence vocabulary (dry controls A-L, REVIEWER_BAD_JSON,
NO_ADVICE). No protocol code ever required that vocabulary; the leak was the
unscoped failure count.

The contract these controls hold:

  1. ticket A's experiment vocabulary and its own evidence close A;
  2. unrelated ticket B supplies its OWN evidence and may report A's or the
     core gate's inherited counts when it explicitly attributes them; VERIFY B
     must not require A's vocabulary and must not fail on A's counts;
  3. an unattributed nonzero count still claims -- negative evidence wins and
     no acceptance is weakened;
  4. the zero-count exemption arithmetic is unchanged.

Run standalone:
    python tools/test_verify_scope_isolation.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.log import (  # noqa: E402
    _claims_failure,
    bulk_verification_evidence,
    verification_evidence,
)

TICKET_A = "T-1"
TICKET_B = "T-2"

A_VOCABULARY = (
    "verify -> PASS [target: T-1] conf: high -- dry controls A-L PASS; "
    "live terminal REVIEWER_BAD_JSON plus NO_ADVICE; 2307 tests passed, "
    "0 failed, 0 errors, 0 skipped"
)
B_OWN_EVIDENCE = (
    "verify -> PASS [target: T-2] conf: high -- repo consistency green; "
    "2358 passed, 0 failed, 0 errors, 0 skipped; SAIPEN core 4 FAIL / 22 WARN "
    "(inherited); ruff clean"
)


def history(ticket: str, *texts: str) -> list[dict]:
    """A VERIFY boundary followed by the given RUN events, oldest first."""
    out = [{"taxonomy": "RUN", "ticket": ticket, "text": "transition to VERIFY -- work done"}]
    for text in texts:
        out.append({"taxonomy": "RUN", "ticket": ticket, "text": text})
    return out


class ForeignScopeTests(unittest.TestCase):
    def test_an_unrelated_ticket_never_requires_the_previous_vocabulary(self) -> None:
        ok_a, reason_a = verification_evidence(TICKET_A, history(TICKET_A, A_VOCABULARY))
        self.assertTrue(ok_a, reason_a)
        ok_b, reason_b = verification_evidence(TICKET_B, history(TICKET_B, B_OWN_EVIDENCE))
        self.assertTrue(ok_b, reason_b)
        # B's own evidence does not contain A's vocabulary; A's tokens are
        # neither present nor required.
        self.assertNotIn("REVIEWER_BAD_JSON", B_OWN_EVIDENCE)
        self.assertNotIn("dry controls", B_OWN_EVIDENCE)

    def test_foreign_attributed_counts_are_not_the_active_claim(self) -> None:
        for text in (
            "PASS conf: high -- python -m pytest -q: 2358 passed, 0 failed, "
            "0 errors, 0 skipped; SAIPEN core 4 FAIL / 22 WARN (inherited); ruff clean",
            "PASS conf: high -- SAIPEN core 4 FAIL 22 WARN inherited; "
            "suite 2358 passed, 0 failed",
            "PASS conf: high -- inherited 4 FAIL from the core gate; "
            "suite 2358 passed, 0 failed",
            "PASS conf: high -- 3 pre-existing failures carried; suite green",
        ):
            with self.subTest(text=text):
                self.assertFalse(_claims_failure(text), text)
                ok, reason = verification_evidence(TICKET_B, history(TICKET_B, text))
                self.assertTrue(ok, reason)

    def test_an_unattributed_count_still_claims(self) -> None:
        for text in (
            "PASS conf: high -- but 2 FAIL remain",
            "PASS conf: high -- SAIPEN core 4 FAIL / 22 WARN",
            "core 0 FAIL, ship 3 FAIL",
        ):
            with self.subTest(text=text):
                self.assertTrue(_claims_failure(text), text)
        ok, _ = verification_evidence(
            TICKET_B, history(TICKET_B, "PASS conf: high -- but 2 FAIL remain")
        )
        self.assertFalse(ok)

    def test_the_attribution_marker_is_what_flips_the_verdict(self) -> None:
        """Instrument control: the SAME count, only the attribution moves."""
        base = (
            "PASS conf: high -- core gate 4 FAIL / 22 WARN; "
            "suite 2358 passed, 0 failed"
        )
        attributed = (
            "PASS conf: high -- core gate 4 FAIL / 22 WARN (inherited); "
            "suite 2358 passed, 0 failed"
        )
        self.assertTrue(_claims_failure(base))
        self.assertFalse(_claims_failure(attributed))
        self.assertNotEqual(_claims_failure(base), _claims_failure(attributed))

    def test_the_zero_exemption_arithmetic_is_unchanged(self) -> None:
        for text in ("0 FAIL", "no failures", "zero FAILURES", "0 failed"):
            with self.subTest(text=text):
                self.assertFalse(_claims_failure(text), text)

    def test_bulk_and_single_verdicts_agree(self) -> None:
        combined = history(TICKET_A, A_VOCABULARY) + history(TICKET_B, B_OWN_EVIDENCE)
        single_a = verification_evidence(TICKET_A, combined)
        single_b = verification_evidence(TICKET_B, combined)
        bulk = bulk_verification_evidence(combined, [TICKET_A, TICKET_B])
        self.assertEqual(bulk[TICKET_A], single_a)
        self.assertEqual(bulk[TICKET_B], single_b)
        self.assertTrue(single_b[0], single_b[1])


if __name__ == "__main__":
    unittest.main(verbosity=2)
