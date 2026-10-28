# ruff: noqa: E402, E501
"""Hostile: repeated cc remains command, same next_action not same state."""
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from saipen_engine import commands as CM

class RepeatedCcTests(unittest.TestCase):
    def test_repeated_cc_not_psychology(self):
        t = CM.load_shortcut_table()
        for _ in range(5):
            res = CM.resolve_compound_command("cc", table=t)
            self.assertEqual(res[0]["kind"], "shortcut")
            self.assertEqual(res[0]["command"], "saipen continue")
    def test_same_next_action_not_same_state(self):
        # SC-2 carrier same string but different fingerprint should not be stall
        from saipen_engine.liveness import action_fingerprint
        fp1 = action_fingerprint(stage="SC-2", role="saihunt", action="RUN_ROLE", reason=[{"stage":"SC-2","reason":"x"}], source="s1")
        fp2 = action_fingerprint(stage="SC-2", role="saihunt", action="RUN_ROLE", reason=[{"stage":"SC-2","reason":"y"}], source="s2")
        self.assertNotEqual(fp1, fp2)

if __name__ == "__main__":
    unittest.main(verbosity=2)
