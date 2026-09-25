"""T-1322: explicit canonical migration of a proven OUTPUT-ONLY STATE field.

`parked_work` is computed and emitted by the status/next/context projections
(`tools/saipen.py::_parked_work`); it is defined by no STATE schema. A live
STATE that carried it (SAITULS, 13.09.26) pasted the engine's OWN output back
into the input document -- the W2-003 vocabulary-leak class. Because its
semantics are proven, the canonical recovery (`reconcile_protocol_state`, the
operation behind `saipen recover`) migrates it by EXACT-key removal:

  * closed allowlist (`state.STATE_OUTPUT_ONLY_FIELDS`) -- only proven fields;
  * original STATE bytes preserved before mutation;
  * the removal is journaled through the reconcile OperationPlan + DEC trace;
  * revalidated in the SAME proposal;
  * idempotent -- a second run has nothing to remove;
  * checkpoint/strict readers keep refusing: this is NOT a generic stripper;
  * any unknown field OUTSIDE the allowlist still refuses (RECOVERY_BLOCKED).
"""

from __future__ import annotations

import importlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))


def _live(name: str):
    importlib.import_module(name)
    return sys.modules[name]


def _state_fields(extra: str = "") -> str:
    return (
        "---\n"
        "phase: SHIP\n"
        "task: T-001\n"
        'next_action: "PHASE SHIP T-001"\n'
        "blocker: none\n"
        "transition_from: REVIEW\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        "last_event: 1\n"
        "style_contract: ded-4ae736e4\n"
        "agent: tester\n"
        "requires:\n  - filesystem\n  - python\n"
        "mode: full\n"
        "updated: 2026-08-30T00:00:00Z\n"
        f"{extra}"
        "---\n"
    )


class LegacyOutputFieldMigrationTests(unittest.TestCase):
    def _make_project(self, extra: str) -> Path:
        root = Path(tempfile.mkdtemp(prefix="t1322-legacy-field-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)
        (root / ".saipen" / "STATE.md").write_text(
            _state_fields(extra), encoding="utf-8"
        )
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-001 [P1] fix | verify: test\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (root / ".saipen" / "LOG.md").write_text(
            "# Log\n- 30.08.26 00:00 [E-0001] [agent: tester] DEC: seed\n",
            encoding="utf-8",
        )
        return root

    def test_dry_run_classifies_the_known_migration_as_repairable(self) -> None:
        root = self._make_project('parked_work: "T-999 blocked: legacy note"\n')
        before = (root / ".saipen" / "STATE.md").read_bytes()
        result = _live("saipen_engine.reconcile").reconcile_protocol_state(
            root, "tester", dry_run=True
        )
        self.assertEqual(result["code"], "REPAIR_REQUIRED", result)
        removed = [
            r for r in result["changed"]["state"] if r.get("field") == "parked_work"
        ]
        self.assertEqual(len(removed), 1, result)
        self.assertTrue(removed[0].get("remove"))
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)

    def test_real_migration_removes_only_the_field_and_preserves_bytes(self) -> None:
        extra = 'parked_work: "T-999 blocked: legacy note"\n'
        root = self._make_project(extra)
        before = (root / ".saipen" / "STATE.md").read_bytes()
        self.assertIn(b"parked_work", before)

        result = _live("saipen_engine.reconcile").reconcile_protocol_state(
            root, "tester", dry_run=False
        )
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "REPAIRED", result)

        after = (root / ".saipen" / "STATE.md").read_bytes()
        self.assertNotIn(b"parked_work", after)
        # only the exact key line was removed; every other field survives
        for field in (b"phase: SHIP", b"task: T-001", b"style_contract", b"agent: tester"):
            self.assertIn(field, after, field)

        # original bytes preserved verbatim before mutation
        preserved = sorted(
            (root / ".saipen" / "recovery" / "state-legacy-output").glob("*.STATE.md")
        )
        self.assertEqual(len(preserved), 1, preserved)
        self.assertEqual(preserved[0].read_bytes(), before)

        # the migration is journaled in the LOG DEC trace
        log = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8")
        self.assertIn("reconcile protocol state", log)
        self.assertIn("REMOVED", log)

    def test_migration_is_idempotent(self) -> None:
        root = self._make_project('parked_work: "T-999 blocked: legacy note"\n')
        first = _live("saipen_engine.reconcile").reconcile_protocol_state(
            root, "tester", dry_run=False
        )
        self.assertTrue(first["ok"], first)
        second = _live("saipen_engine.reconcile").reconcile_protocol_state(
            root, "tester", dry_run=False
        )
        self.assertTrue(second["ok"], second)
        self.assertNotEqual(second["code"], "REPAIRED", second)
        removals = [
            r
            for r in (second.get("changed") or {"state": []})["state"]
            if r.get("field") == "parked_work"
        ]
        self.assertEqual(removals, [])
        preserved = sorted(
            (root / ".saipen" / "recovery" / "state-legacy-output").glob("*.STATE.md")
        )
        self.assertEqual(len(preserved), 1, preserved)

    def test_unknown_non_allowlisted_field_still_refuses(self) -> None:
        root = self._make_project('bogus_field: "not a known output field"\n')
        before = (root / ".saipen" / "STATE.md").read_bytes()
        result = _live("saipen_engine.reconcile").reconcile_protocol_state(
            root, "tester", dry_run=False
        )
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "VALIDATION_FAILED", result)
        self.assertIn("bogus_field", result["detail"])
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)

    def test_strict_readers_keep_refusing_the_field(self) -> None:
        """checkpoint/write paths validate strictly; no silent auto-strip."""
        root = self._make_project('parked_work: "T-999 blocked: legacy note"\n')
        text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        _state, err = _live("saipen_engine.state").parse_state_or_error(text)
        self.assertIsNotNone(err)
        self.assertIn("parked_work", err)


if __name__ == "__main__":
    unittest.main()
