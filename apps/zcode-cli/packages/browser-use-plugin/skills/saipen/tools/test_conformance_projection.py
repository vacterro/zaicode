"""Cover the conformance projection `saipen status` reads off the journal.

The projection had a defect in each direction and only one of them was tested.
Against promotion it was armoured: `NOT PASS`, `BYPASS`, `PASSING` and mixed
failure prose must never become a conformance PASS, and that armour was an
end-of-line anchor on the result token. Against silence it had nothing, and the
anchor was the cause: every checkpoint an agent actually writes appends its
evidence after the token, so every real record read UNKNOWN and the gate could
only be made green by hand-writing a bare line (T-1243).

Both directions are asserted here, because fixing one by breaking the other is
the obvious way for this to regress.
"""

import unittest

import saipen as cli


class TerminalResultTests(unittest.TestCase):
    def result(self, text):
        return cli._validator_terminal_result(text)

    # --- the shape agents actually write ---------------------------------

    def test_evidence_after_the_token_still_passes(self):
        self.assertEqual(
            self.result("validate.py -> PASS conf: high -- 0 FAIL, 21 WARN, ruff clean"),
            "PASS",
        )

    def test_bare_token_still_passes(self):
        self.assertEqual(self.result("validate.py -> PASS"), "PASS")

    def test_zero_counts_in_the_evidence_are_not_a_failure_claim(self):
        """`0 FAIL` is a count, not a claim -- the distinction the gate lives on."""
        self.assertEqual(
            self.result("ran validate.py -> PASS conf: high -- 0 FAIL 21 WARN"), "PASS"
        )

    def test_portable_floor_record_passes(self):
        self.assertEqual(
            self.result("validate.sh -> PASS conf: high -- portable subset only"), "PASS"
        )

    def test_fail_token_reads_fail(self):
        self.assertEqual(self.result("validate.py -> FAIL -- 2 problems, 21 warnings"), "FAIL")

    # --- nothing is promoted on a substring ------------------------------

    def test_not_pass_is_unknown(self):
        self.assertEqual(self.result("validate.py -> NOT PASS"), "UNKNOWN")

    def test_bypass_is_unknown(self):
        self.assertEqual(self.result("validate.py -> BYPASS"), "UNKNOWN")

    def test_passing_is_unknown(self):
        self.assertEqual(self.result("validate.py -> PASSING"), "UNKNOWN")

    def test_mixed_failure_prose_is_unknown_not_pass(self):
        """A record that claims a pass and names a failure has not proven a pass."""
        self.assertEqual(
            self.result("validate.py -> PASS but the suite failed on linux"), "UNKNOWN"
        )

    def test_no_token_at_all_is_unknown(self):
        self.assertEqual(self.result("ran validate.py and it looked fine"), "UNKNOWN")

    def test_result_before_the_arrow_is_not_a_token(self):
        self.assertEqual(self.result("PASS -- validate.py was run"), "UNKNOWN")


def run(text, date="02.09.26"):
    return {"taxonomy": "RUN", "text": text, "date": date}


class SelectorTests(unittest.TestCase):
    """Naming the validator is not running it."""

    def test_newest_decidable_record_wins(self):
        events = [
            run("validate.py -> PASS conf: high -- 0 FAIL", "01.09.26"),
            run("validate.py -> FAIL -- 2 problems", "02.09.26"),
        ]
        self.assertEqual(cli._project_conformance(events), "FAIL (02.09.26)")

    def test_prose_about_the_validator_does_not_shadow_a_real_run(self):
        """The live defect: a checkpoint discussing validate.py:3871 hid the gate."""
        events = [
            run("validate.py -> PASS conf: high -- 0 FAIL", "01.09.26"),
            run("SCOUT -- root cause sits at validate.py:3871 behind one boolean", "02.09.26"),
        ]
        self.assertEqual(cli._project_conformance(events), "PASS (01.09.26)")

    def test_nothing_decidable_reports_unknown_dated_by_the_newest_mention(self):
        events = [run("ran validate.py, looked fine", "02.09.26")]
        self.assertEqual(cli._project_conformance(events), "UNKNOWN (02.09.26)")

    def test_no_validator_record_at_all_is_none(self):
        self.assertIsNone(cli._project_conformance([run("checkpoint about something else")]))

    def test_non_run_taxonomy_is_ignored(self):
        events = [{"taxonomy": "DEC", "text": "validate.py -> PASS", "date": "02.09.26"}]
        self.assertIsNone(cli._project_conformance(events))

    def test_a_failure_claim_never_becomes_the_reported_pass(self):
        events = [run("validate.py -> PASS but the suite failed on linux", "02.09.26")]
        self.assertEqual(cli._project_conformance(events), "UNKNOWN (02.09.26)")


class LiveProjectionTests(unittest.TestCase):
    def test_the_repository_journal_projects_without_a_hand_written_line(self):
        """The real LOG must yield a decidable gate, which is the whole point.

        Reading the live journal rather than a fixture is deliberate: the defect
        was that real records did not parse, and a fixture built from the fixed
        grammar could not have caught that.
        """
        import re
        from pathlib import Path

        log = Path(cli.__file__).resolve().parent.parent / ".saipen" / "LOG.md"
        records = [
            line
            for line in log.read_text(encoding="utf-8", errors="replace").splitlines()
            if re.search(r"\bvalidate\.(py|sh|ps1)\b", line)
        ]
        if not records:
            self.skipTest("live LOG carries no validator record in the active segment")
        self.assertTrue(
            any(cli._validator_terminal_result(line) in ("PASS", "FAIL") for line in records),
            "no validator record in the live LOG projects to a decidable gate",
        )


if __name__ == "__main__":
    unittest.main()
