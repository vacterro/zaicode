"""A FAIL-family field owns the number after it, never the one before (T-1445).

Measured live in SAITULS T-164/T-165 reconciliation (2026-09-21): a green
verify line carrying `CLIPBOARD_PLUS_CONTROL passed=52 failed=0` was vetoed,
because the machine-shape scan read `52 failed` as a nonzero failure count --
the 52 belongs to `passed=`. The session had to reword it as `checks 52 of 52,
zero failures` to close.

Measuring the fix exposed the same misreading at the opposite polarity, which
is worse: `passed=0 failed=3` read `0 failed` as a zero-failure phrase and
exempted the only FAIL token, so a real failure was talked past; and
`failed: 3` in a line's detail was no machine shape at all.

The contract: a token followed by `=`/`:` and a number is a field key; the
field is read as a field (nonzero claims from anywhere, zero exempts), and the
number in front of the key is never counted for it.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.log import _claims_failure, verification_evidence  # noqa: E402

#: The measured SAITULS lines (E-1352, E-1355), byte for byte.
SAITULS_E1352 = (
    "verify -> PASS [target: T-164] conf: high -- python tests/test_clipboard_plus_control.py "
    "-> 6 tests OK, CLIPBOARD_PLUS_CONTROL passed=52 failed=0; python "
    "tests/test_clipboard_safe_share.py -> 6 tests OK; python tests/test_saituls_tools_ux.py "
    "-> 18 tests OK, SAITULS_TOOLS_UX passed=30 failed=0; Clipboard+ contract validated on "
    "the live surface, no implementation change needed"
)
SAITULS_E1355 = (
    "verify -> PASS [target: T-164] conf: high -- python tests/test_clipboard_plus_control.py "
    "-> 6 tests OK, CLIPBOARD_PLUS_CONTROL passed=52 failed=0; python "
    "tests/test_clipboard_safe_share.py -> 6 tests OK; python tests/test_saituls_tools_ux.py "
    "-> 18 tests OK, SAITULS_TOOLS_UX passed=30 failed=0; no product change needed"
)


def cycle(text: str) -> list[dict]:
    return [
        {"taxonomy": "RUN", "ticket": "T-164", "text": "transition to VERIFY -- build done"},
        {"taxonomy": "RUN", "ticket": "T-164", "text": text},
    ]


class GreenFieldLinesTests(unittest.TestCase):
    def test_the_measured_saituls_lines_close_without_rewording(self):
        for text in (SAITULS_E1352, SAITULS_E1355):
            with self.subTest(text=text[:60]):
                self.assertFalse(_claims_failure(text))
                ok, reason = verification_evidence("T-164", cycle(text))
                self.assertTrue(ok, reason)

    def test_zero_failure_fields_are_not_claims(self):
        for text in (
            "passed=52 failed=0",
            "PASS -- passed=52 failed=0",
            "ok: 52 failed: 0",
            "OK failures=0",
            "Ran 12 tests OK: 0 failures",
            "52 passed, 0 failed",
        ):
            with self.subTest(text=text):
                self.assertFalse(_claims_failure(text))


class RealFailuresStillVetoTests(unittest.TestCase):
    def test_a_nonzero_failure_field_claims_even_after_a_zero_field(self):
        for text in (
            "passed=0 failed=3",
            "PASS -- passed=0 failed=3",
            "PASS -- tests: 52 passed, failed: 3",
            "failed=3",
            "failures=2",
            "FAILED (failures=2, errors=1)",
        ):
            with self.subTest(text=text):
                self.assertTrue(_claims_failure(text))
                ok, _reason = verification_evidence("T-164", cycle(text))
                self.assertFalse(ok, text)

    def test_counted_failures_still_claim(self):
        for text in ("3 failed", "2 FAIL: see below", "0 FAIL on core, 3 FAIL on ship"):
            with self.subTest(text=text):
                self.assertTrue(_claims_failure(text))

    def test_the_green_saituls_shape_with_one_red_field_is_a_failure(self):
        red = SAITULS_E1352.replace("SAITULS_TOOLS_UX passed=30 failed=0", "SAITULS_TOOLS_UX "
                                    "passed=27 failed=3")
        self.assertTrue(_claims_failure(red))


if __name__ == "__main__":
    unittest.main()
