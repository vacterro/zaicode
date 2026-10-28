"""T-1322: immutable-ledger corruption is a PRECISE blocked class, not a dead end.

The SAITULS live surface (13.09.26) presented a LOG history that fails the
immutable-ledger contract (duplicate/out-of-order E-IDs, an illegal SAIPATCH
line, a dangling parent edge). That is a DISTINCT historical-corruption class:
automatic byte repair would fabricate history, so canonical recovery MUST NOT
reconstruct it.

Required behaviour, proved here:
  * `reconcile_protocol_state` -- the operation behind `saipen recover` and the
    exact preview Fleet classifies -- refuses with the precise, registered code
    `HISTORY_LEDGER_CORRUPT`, never the opaque generic `VALIDATION_FAILED`;
  * the exact underlying diagnostics survive in `detail` (it names the
    immutable-ledger contract, not "something went wrong");
  * ZERO canonical writes: STATE/BOARD/LOG are byte-identical before and after,
    on the dry-run PLAN and on the real APPLY attempt;
  * the code is one of the registered `error_codes`, so it survives the Result
    closure and reaches the outer Fleet/continue surface as a machine-readable
    blocked classification (`BOUND_RECOVERY_REQUIRED_BLOCKED` +
    `reason_code: HISTORY_LEDGER_CORRUPT`);
  * the deferred ledger repair is NOT implemented here -- no reconstruction, no
    deletion, no synthesized operation identity.
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


def _state_text(saipen_home: Path) -> str:
    # `saipen_home` MUST resolve to THIS running install for the history gate to
    # apply: that is the only ledger the running install is the authority for
    # (a foreign/sub project carries its own history).
    return (
        "---\n"
        "phase: SHIP\n"
        "task: T-001\n"
        'next_action: "PHASE SHIP T-001"\n'
        "blocker: none\n"
        "transition_from: REVIEW\n"
        "saipen_version: 7\n"
        "schema_version: 3\n"
        "last_event: 2\n"
        "style_contract: ded-4ae736e4\n"
        "agent: tester\n"
        "requires:\n  - filesystem\n  - python\n"
        "mode: full\n"
        "updated: 2026-08-30T00:00:00Z\n"
        f"saipen_home: {saipen_home.as_posix()}\n"
        "---\n"
    )


class ImmutableLedgerBlockedTests(unittest.TestCase):
    def _make_corrupt_ledger_project(self) -> Path:
        home = _live("saipen_engine.state").running_home()
        root = Path(tempfile.mkdtemp(prefix="t1322-ledger-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)
        (root / ".saipen" / "STATE.md").write_text(
            _state_text(home), encoding="utf-8"
        )
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-001 [P1] fix | verify: test\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        # A DUPLICATE E-ID is an immutable-ledger violation: the same event
        # identity appears twice, so the ledger is void. No byte-level repair is
        # legal (which of the two is the real record?).
        (root / ".saipen" / "LOG.md").write_text(
            "# Log\n"
            "- 30.08.26 00:00 [E-0001] [agent: tester] DEC: seed\n"
            "- 30.08.26 00:01 [E-0001] [agent: tester] DEC: duplicated identity\n",
            encoding="utf-8",
        )
        return root

    def _canonical_bytes(self, root: Path) -> dict[str, bytes]:
        return {
            name: (root / ".saipen" / name).read_bytes()
            for name in ("STATE.md", "BOARD.md", "LOG.md")
        }

    def test_dry_run_is_a_precise_blocked_class_with_zero_writes(self) -> None:
        root = self._make_corrupt_ledger_project()
        before = self._canonical_bytes(root)

        result = _live("saipen_engine.reconcile").reconcile_protocol_state(
            root, "tester", dry_run=True
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "HISTORY_LEDGER_CORRUPT", result)
        self.assertNotEqual(result["code"], "VALIDATION_FAILED", result)
        self.assertIn("immutable-ledger", result["detail"], result)
        self.assertEqual(
            result["terminal_disposition"], "FORENSICALLY_UNRECOVERABLE", result
        )
        self.assertFalse(result["needs_local_mutation"], result)
        self.assertFalse(result["operator_decision_available"], result)
        self.assertIsNone(result["canonical_next_command"], result)
        self.assertEqual(result["blocking_surface"], "log", result)
        self.assertIsNone(result["blocking_field"], result)
        self.assertEqual(result["evidence_reference"], ".saipen/LOG.md", result)
        # The exact offending identity survives the refusal.
        self.assertIn("E-1", result["detail"], result)
        self.assertEqual(self._canonical_bytes(root), before, "dry-run wrote bytes")

    def test_apply_attempt_refuses_and_writes_nothing(self) -> None:
        root = self._make_corrupt_ledger_project()
        before = self._canonical_bytes(root)

        result = _live("saipen_engine.reconcile").reconcile_protocol_state(
            root, "tester", dry_run=False
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "HISTORY_LEDGER_CORRUPT", result)
        self.assertEqual(
            result["terminal_disposition"], "FORENSICALLY_UNRECOVERABLE", result
        )
        self.assertEqual(self._canonical_bytes(root), before, "apply wrote bytes")

    def test_code_is_registered_so_fleet_can_report_it(self) -> None:
        # A code absent from the closed set would be rejected at the Result
        # boundary, collapsing the precise class back into a crash/dead end.
        self.assertIn("HISTORY_LEDGER_CORRUPT", _live("saipen_engine.errors").CODES)
        self.assertEqual(
            _live("saipen_engine.fleet").CLASS_BLOCKED,
            "BOUND_RECOVERY_REQUIRED_BLOCKED",
        )
        # The precise code survives a Result construction (the closure that would
        # reject an unregistered refusal code).
        result = _live("saipen_engine.result").Result(
            ok=False, code="HISTORY_LEDGER_CORRUPT", message="ledger corrupt"
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "HISTORY_LEDGER_CORRUPT")

    def test_fleet_reports_terminal_forensic_block_instead_of_recover_loop(self) -> None:
        root = self._make_corrupt_ledger_project()
        paths = _live("saipen_engine.paths")
        lineage = paths.new_project_lineage()
        (root / ".saipen" / "IDENTITY.md").write_text(
            paths.identity_file_content(lineage), encoding="utf-8"
        )

        result = _live("saipen_engine.fleet").preflight(
            root, host_root=root, host_lineage=lineage
        )

        self.assertEqual(result["reason_code"], "HISTORY_LEDGER_CORRUPT", result)
        self.assertEqual(
            result["terminal_disposition"], "FORENSICALLY_UNRECOVERABLE", result
        )
        self.assertFalse(result["needs_local_mutation"], result)
        self.assertFalse(result["operator_decision_available"], result)
        self.assertIsNone(result["canonical_next_command"], result)


if __name__ == "__main__":
    unittest.main()
