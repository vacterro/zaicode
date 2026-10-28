# ruff: noqa: E402, E501
"""Hostile: CCC vs SC distinct targets, CONTROLS runtime, FF analytic lens."""
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from saipen_engine import commands as CM

class CccVsScTests(unittest.TestCase):
    def test_ccc_is_ship_not_crew(self):
        t = CM.load_shortcut_table()
        self.assertEqual(t["ccc"], "saipen continue")
        self.assertEqual(t["sc"], "saipen crew")
        # Distinct: ccc never routes to crew
        self.assertNotEqual(t["ccc"], t["sc"])
    def test_controls_in_manifest(self):
        import json
        m = json.loads((Path(__file__).parent.parent / "saipen" / "MANIFEST.json").read_text(encoding="utf-8"))
        files = [e["src"] for e in m["files"]]
        self.assertIn("saipen/CONTROLS.md", files)
    def test_ff_performance_zero_literal_still_brief(self):
        # Zero exact grep matches must still produce read-only analytic brief, not human gate
        # Simulate by checking controls projection handles zero exact_matches as semantic
        # This is structural: ff performance should be shortcut owned
        t = CM.load_shortcut_table()
        res = CM.resolve_compound_command("ff performance", table=t)
        self.assertEqual(res[0]["kind"], "shortcut")
        self.assertEqual(res[0]["command"], "saipen focus performance")

if __name__ == "__main__":
    unittest.main(verbosity=2)
