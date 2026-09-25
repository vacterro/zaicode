"""T-1435 M2/M3: canonical legacy BOARD metadata migration (SRC-090).

The measured incident: FastPrompter T-1226 is historical DONE and carries a
human handoff token in the machine-interpreted `source_receipts` field. The
validator correctly refuses it, and before this operation NO legal canonical
move owned the repair -- manual BOARD editing is forbidden and the Work is
history. These regressions drive the REAL public adapter as a subprocess
against a throwaway project, plus the planner for the optimistic-conflict case
a subprocess cannot stage.

Hostile matrix (SRC-090 section 7 A-H, 10-case handoff matrix):

  A  DONE + malformed token + exact proven SRC        -> EXACT_CANONICAL_MIGRATION
  B  DONE + malformed token + no exact SRC            -> LEGACY_UNBOUND_REFERENCE
  C  active TODO/DOING Work                           -> refused, zero writes
  D  requested SRC does not exist                     -> refused, zero writes
  E  SRC exists but belongs to incompatible Work      -> refused, zero writes
  F  BOARD row changed after planning                 -> STALE_STATE, zero writes
  G  identical second repair                          -> idempotent, no second write
  H  conflicting second repair                        -> explicit refusal
  I  malformed repair authority                       -> refused, zero writes
  J  historical DONE stays DONE                       -> asserted after every repair

Run standalone:
    python tools/test_metadata_repair.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import metadata_repair as mr_mod  # noqa: E402
from saipen_engine import remediation  # noqa: E402
from saipen_engine.paths import unbound_environment  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"
VALIDATE_PY = TOOLS / "validate.py"
SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"

LEGACY_TOKEN = "FASTPROMPTER - SMART_20260908_0645"

STATE = """---
phase: DONE
task: none
next_action: "PHASE DONE"
blocker: none
transition_from: DONE
saipen_version: 8
schema_version: 3
last_event: 2
style_contract: ded-4ae736e4
agent: tester
mode: full
updated: "2026-09-21T00:00:00Z"
---
"""

LOG = (
    "- 21.09.26 00:00 [E-001] [T-900] RUN: historical build finished\n"
    "- 21.09.26 00:01 [E-002] [T-900] DEC: historical completion\n"
)


def setUpModule() -> None:
    isolate_host_session()


def _board(*, legacy: bool = True, doing: bool = False) -> str:
    lines = ["# Board", "## DOING", "## TODO"]
    if doing:
        lines.append("- [ ] T-899 [P1] active work | verify: proof")
    lines.append("## DONE")
    receipts = f" | source_receipts: {LEGACY_TOKEN}" if legacy else ""
    lines.append(
        "- [x] T-900 [P1] historical legacy row | verify: proof | owner: tester | "
        "claim_time: 2026-09-08T06:45:00Z" + receipts
    )
    lines.append(
        "- [x] T-901 [P1] clean historical row | verify: proof | owner: tester | "
        "claim_time: 2026-09-08T06:00:00Z"
    )
    lines.append("## BLOCKED")
    return "\n".join(lines) + "\n"


def _make_project(tmp: Path, *, board: str | None = None) -> Path:
    root = tmp / "project"
    root.parent.mkdir(parents=True, exist_ok=True)
    root.mkdir()
    shutil.copytree(SCENARIO, root / ".saipen")
    (root / ".saipen" / "BOARD.md").write_text(board or _board(), encoding="utf-8")
    (root / ".saipen" / "STATE.md").write_text(STATE, encoding="utf-8")
    (root / ".saipen" / "LOG.md").write_text(LOG, encoding="utf-8")
    return root


def _run_cli(project: Path, *args: str) -> tuple[int, dict, str]:
    proc = subprocess.run(
        [
            sys.executable,
            str(SAIPEN_PY),
            "--project-root",
            str(project),
            "--agent",
            "tester",
            "--json",
            *args,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=unbound_environment(),
        timeout=600,
    )
    try:
        payload = json.loads(proc.stdout) if proc.stdout.strip() else {}
    except ValueError:
        payload = {"_unparseable_stdout": proc.stdout}
    diagnostic = proc.stdout
    if proc.stderr.strip():
        diagnostic += "\nSTDERR:\n" + proc.stderr
    return proc.returncode, payload, diagnostic


def _run_validator(project: Path) -> tuple[int, str]:
    proc = subprocess.run(
        [
            sys.executable,
            str(VALIDATE_PY),
            "--project-root",
            str(project),
            "--gate",
            "core",
            "--no-receipt",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=unbound_environment(),
        timeout=600,
    )
    return proc.returncode, proc.stdout


def _lineage() -> str:
    value = mr_mod.protocol_home_lineage()
    assert value.startswith("lineage-"), value
    return value


class MetadataRepairTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-metadata-repair-")
        self.root = _make_project(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # -- helpers ------------------------------------------------------------

    def _board_text(self, root: Path | None = None) -> str:
        return ((root or self.root) / ".saipen/BOARD.md").read_text(encoding="utf-8")

    def _receipts(self, root: Path | None = None) -> list[Path]:
        return mr_mod.existing_receipts(root or self.root)

    def _field(self, work: str = "T-900", root: Path | None = None) -> str:
        from saipen_engine.board import parse_board

        board = parse_board(self._board_text(root))
        return str((board["tickets"][work].get("fields") or {}).get("source_receipts") or "")

    def _repo(self, args: tuple[str, ...], work: str = "T-900") -> tuple[str, ...]:
        return ("ticket", "repair-metadata", work, *args)

    def _capture(self, text: str = "operator request body", *extra: str) -> tuple[int, dict, str]:
        return _run_cli(self.root, "source", "capture", text, *extra)

    def _prove_exact(self, work: str = "T-901") -> str:
        """Create ONE real receipt linked to `work`; return its id."""
        rc, payload, out = self._capture(f"exact source for {work}", "--work", work)
        self.assertEqual(rc, 0, out)
        receipt = payload.get("receipt") or payload.get("receipt_id")
        self.assertTrue(str(receipt).startswith("SRC-"), payload)
        return str(receipt)

    # -- A: exact canonical migration ---------------------------------------

    def test_a_done_malformed_exact_proven_src_migrates(self):
        receipt = self._prove_exact("T-900")
        before_log = (self.root / ".saipen/LOG.md").read_text(encoding="utf-8")
        rc, payload, out = _run_cli(
            self.root,
            *self._repo(("--field", "source_receipts", "--to", receipt)),
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIRED", payload)
        self.assertEqual(payload.get("classification"), "EXACT_CANONICAL_MIGRATION")
        repair_id = payload.get("receipt_id")
        self.assertTrue(str(repair_id).startswith("MR-"))
        # J: historical DONE stays DONE; the field is the proven identity
        board = self._board_text()
        self.assertIn("- [x] T-900", board)
        self.assertEqual(self._field(), receipt)
        self.assertNotIn(LEGACY_TOKEN, board)
        # immutable receipt binds original bytes and engine generation
        record = mr_mod.load_receipt(self.root, repair_id)
        self.assertEqual(record["classification"], "EXACT_CANONICAL_MIGRATION")
        self.assertIn(LEGACY_TOKEN, record["original_value"])
        self.assertEqual(record["repaired_value"], receipt)
        self.assertIn(LEGACY_TOKEN, record["original_board_record"])
        self.assertEqual(
            record["original_board_record_sha256"],
            "sha256:"
            + __import__("hashlib").sha256(
                record["original_board_record"].encode("utf-8")
            ).hexdigest(),
        )
        self.assertTrue(record["engine_generation"].get("engine_digest"))
        self.assertEqual(record["evidence"][0], f"target-receipt:{receipt}")
        # history is append-only; the repair is a DEC event
        after_log = (self.root / ".saipen/LOG.md").read_text(encoding="utf-8")
        self.assertTrue(after_log.startswith(before_log))
        self.assertIn("REPAIR-METADATA T-900", after_log)

    # -- B: legacy-unbound migration ----------------------------------------

    def test_b_done_malformed_no_exact_src_removes_and_preserves(self):
        self.assertEqual(self._field(), LEGACY_TOKEN)
        rc, payload, out = _run_cli(
            self.root,
            *self._repo(
                (
                    "--field",
                    "source_receipts",
                    "--legacy-unbound",
                    "--authority",
                    _lineage(),
                )
            ),
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIRED", payload)
        self.assertEqual(payload.get("classification"), "LEGACY_UNBOUND_REFERENCE")
        board = self._board_text()
        self.assertIn("- [x] T-900", board)
        self.assertEqual(self._field(), "")
        self.assertNotIn(LEGACY_TOKEN, board)
        record = mr_mod.load_receipt(self.root, payload["receipt_id"])
        self.assertIsNone(record["repaired_value"])
        self.assertTrue(record["removed"])
        self.assertEqual(record["original_value"], LEGACY_TOKEN)
        self.assertIn(LEGACY_TOKEN, record["original_board_record"])
        self.assertEqual(record["authority_kind"], "PROTOCOL_HOME_LINEAGE")
        # zero invention: no SRC receipt was minted by the migration
        index_path = self.root / ".saipen/intake/index.json"
        if index_path.is_file():
            index = json.loads(index_path.read_text(encoding="utf-8"))
            self.assertEqual(index.get("active") or {}, {})

    # -- C: active work is refused ------------------------------------------

    def test_c_active_work_refused_zero_writes(self):
        root = _make_project(Path(self.tmp.name) / "active", board=_board(doing=True, legacy=True))
        before = (root / ".saipen/BOARD.md").read_bytes()
        rc, payload, out = _run_cli(
            root,
            "ticket",
            "repair-metadata",
            "T-899",
            "--field",
            "source_receipts",
            "--legacy-unbound",
            "--authority",
            _lineage(),
        )
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIR_REQUIRES_DONE", payload)
        self.assertEqual((root / ".saipen/BOARD.md").read_bytes(), before)
        self.assertEqual(mr_mod.existing_receipts(root), [])

    # -- D: requested replacement SRC does not exist ------------------------

    def test_d_missing_target_refused_zero_writes(self):
        before = self._board_text()
        rc, payload, out = _run_cli(
            self.root,
            *self._repo(("--field", "source_receipts", "--to", "SRC-999")),
        )
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIR_TARGET_MISSING", payload)
        self.assertEqual(self._board_text(), before)
        self.assertEqual(self._receipts(), [])

    # -- E: SRC exists but belongs to incompatible Work ---------------------

    def test_e_foreign_work_target_refused_zero_writes(self):
        receipt = self._prove_exact("T-901")
        before = self._board_text()
        rc, payload, out = _run_cli(
            self.root,
            *self._repo(("--field", "source_receipts", "--to", receipt)),
        )
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIR_TARGET_MISMATCH", payload)
        self.assertEqual(self._board_text(), before)
        self.assertEqual(self._receipts(), [])

    # -- F: BOARD row changes after planning --------------------------------

    def test_f_optimistic_conflict_refuses_zero_writes(self):
        from saipen_engine import operations as ops_mod
        from saipen_engine.plan import apply_plan

        plan = ops_mod._plan_repair_metadata(
            self.root,
            "T-900",
            "tester",
            field="source_receipts",
            to_target="",
            legacy_unbound=True,
            authority=_lineage(),
            now=ops_mod._now(),
            utc=ops_mod._utc_iso(),
        )
        self.assertNotIsInstance(plan, ops_mod.Result)
        # another actor changes the row between PLAN and APPLY
        board_path = self.root / ".saipen/BOARD.md"
        board_path.write_text(
            self._board_text().replace(
                "historical legacy row | verify: proof",
                "historical legacy row | verify: proof | review_passes: 2",
            ),
            encoding="utf-8",
        )
        changed = board_path.read_text(encoding="utf-8")
        applied = apply_plan(self.root, plan)
        self.assertFalse(applied.ok)
        self.assertEqual(applied.code, "STALE_STATE", applied.to_dict())
        self.assertEqual(board_path.read_text(encoding="utf-8"), changed)
        self.assertEqual(self._receipts(), [])

    # -- G: identical second repair is idempotent ---------------------------

    def test_g_second_identical_repair_is_idempotent(self):
        args = ("--field", "source_receipts", "--legacy-unbound", "--authority", _lineage())
        rc, first, out = _run_cli(self.root, *self._repo(args))
        self.assertEqual(rc, 0, out)
        self.assertEqual(first.get("code"), "METADATA_REPAIRED", first)
        board_after_first = self._board_text()
        receipts_after_first = [path.name for path in self._receipts()]
        rc, second, out = _run_cli(self.root, *self._repo(args))
        self.assertEqual(rc, 0, out)
        self.assertEqual(second.get("code"), "ALREADY_APPLIED", second)
        self.assertEqual(second.get("receipt_id"), first.get("receipt_id"))
        self.assertEqual(self._board_text(), board_after_first)
        self.assertEqual([path.name for path in self._receipts()], receipts_after_first)

    # -- H: conflicting second repair ---------------------------------------

    def test_h_conflicting_second_repair_refused(self):
        receipt = self._prove_exact("T-900")
        rc, first, out = _run_cli(
            self.root, *self._repo(("--field", "source_receipts", "--to", receipt))
        )
        self.assertEqual(rc, 0, out)
        self.assertEqual(first.get("classification"), "EXACT_CANONICAL_MIGRATION")
        board_after_first = self._board_text()
        rc, second, out = _run_cli(
            self.root,
            *self._repo(
                (
                    "--field",
                    "source_receipts",
                    "--legacy-unbound",
                    "--authority",
                    _lineage(),
                )
            ),
        )
        self.assertEqual(rc, 1, out)
        self.assertEqual(second.get("code"), "METADATA_REPAIR_CONFLICT", second)
        self.assertEqual(self._board_text(), board_after_first)
        self.assertEqual(len(self._receipts()), 1)

    # -- I: malformed repair authority --------------------------------------

    def test_i_malformed_authority_refused(self):
        before = self._board_text()
        for authority in ("banana", "SRC-999"):
            with self.subTest(authority=authority):
                rc, payload, out = _run_cli(
                    self.root,
                    *self._repo(
                        (
                            "--field",
                            "source_receipts",
                            "--legacy-unbound",
                            "--authority",
                            authority,
                        )
                    ),
                )
                self.assertEqual(rc, 1, out)
                self.assertEqual(
                    payload.get("code"), "METADATA_REPAIR_AUTHORITY_INVALID", payload
                )
        self.assertEqual(self._board_text(), before)

    def test_i2_missing_authority_refused(self):
        rc, payload, out = _run_cli(
            self.root, *self._repo(("--field", "source_receipts", "--legacy-unbound"))
        )
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIR_AUTHORITY_REQUIRED", payload)

    def test_i3_grammar_refusals_zero_writes(self):
        before = self._board_text()
        # parser-level refusals: exit 2
        for args in (
            ("--field", "source_receipts"),
            ("--field", "source_receipts", "--to", "SRC-001", "--legacy-unbound"),
            ("--field", "source_receipts", "--to"),
        ):
            with self.subTest(args=args):
                rc, payload, out = _run_cli(self.root, *self._repo(args))
                self.assertEqual(rc, 2, out)
                self.assertEqual(payload.get("code"), "VALIDATION_FAILED", payload)
        # engine-level refusal: unsupported field, exit 1
        rc, payload, out = _run_cli(
            self.root,
            *self._repo(("--field", "owner", "--legacy-unbound", "--authority", _lineage())),
        )
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIR_FIELD_UNSUPPORTED", payload)
        self.assertEqual(self._board_text(), before)

    # -- live canonical value is never rewritten -----------------------------

    def test_live_canonical_receipts_refuse_removal(self):
        receipt = self._prove_exact("T-900")
        # migrate to the exact proven value first
        rc, payload, out = _run_cli(
            self.root, *self._repo(("--field", "source_receipts", "--to", receipt))
        )
        self.assertEqual(rc, 0, out)
        board_after = self._board_text()
        rc, payload, out = _run_cli(
            self.root,
            *self._repo(
                (
                    "--field",
                    "source_receipts",
                    "--legacy-unbound",
                    "--authority",
                    _lineage(),
                )
            ),
        )
        self.assertEqual(rc, 1, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIR_CONFLICT", payload)
        self.assertEqual(self._board_text(), board_after)

    # -- dry run -------------------------------------------------------------

    def test_dry_run_plans_without_writing(self):
        before = self._board_text()
        rc, payload, out = _run_cli(
            self.root,
            *self._repo(
                ("--field", "source_receipts", "--legacy-unbound", "--authority", _lineage()),
                ),
            "--dry-run",
        )
        self.assertEqual(rc, 0, out)
        self.assertTrue(payload.get("dry_run"), payload)
        expected_receipt = f"{mr_mod.METADATA_REPAIR_DIR}/MR-000001.json"
        self.assertIn(expected_receipt, payload.get("changed_files") or [])
        self.assertEqual(self._board_text(), before)
        self.assertEqual(self._receipts(), [])

    # -- validator round trip -------------------------------------------------

    def test_validator_emits_executable_migration_and_finding_disappears(self):
        rc_before, before = _run_validator(self.root)
        self.assertNotEqual(rc_before, 0)
        self.assertIn("references missing source receipt", before)
        found = [
            command
            for command in remediation.extract_commands(before.splitlines())
            if "ticket repair-metadata" in command
        ]
        self.assertTrue(found, before)
        command = found[0]
        verdict = remediation.resolve_command(command)
        self.assertTrue(verdict.get("ok"), (command, verdict))
        self.assertEqual(verdict.get("verb"), "ticket")
        self.assertEqual(verdict.get("action"), "repair-metadata")
        rc, payload, out = _run_cli(self.root, *command.split()[1:])
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "METADATA_REPAIRED", payload)
        _rc_after, after = _run_validator(self.root)
        self.assertNotIn("references missing source receipt", after)
        self.assertNotIn(LEGACY_TOKEN, after)

    def test_exact_case_validator_emits_to_form(self):
        receipt = self._prove_exact("T-900")
        rc, before = _run_validator(self.root)
        self.assertNotEqual(rc, 0)
        found = [
            command
            for command in remediation.extract_commands(before.splitlines())
            if "ticket repair-metadata" in command
        ]
        self.assertTrue(found, before)
        self.assertIn("--to", found[0])
        self.assertIn(receipt, found[0])
        verdict = remediation.resolve_command(found[0])
        self.assertTrue(verdict.get("ok"), (found[0], verdict))


if __name__ == "__main__":
    unittest.main(verbosity=2)