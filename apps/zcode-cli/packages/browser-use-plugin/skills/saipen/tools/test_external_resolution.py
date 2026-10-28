"""T-1434 M2: canonical external-implementation resolution (SRC-088).

A locally reported defect can be implemented UPSTREAM and verified locally
against the installed implementation. Before this operation the only closure
provenance was local patch ownership, so such Work stayed BLOCKED_EXTERNAL
forever or had to lie with `own_patch`. These regressions drive the REAL public
adapter as a subprocess against a throwaway project, plus the shared resolver
for the rollback simulation that a subprocess cannot stage.

Run standalone:
    python tools/test_external_resolution.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import external as external_mod  # noqa: E402
from saipen_engine.paths import unbound_environment  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"
VALIDATE_PY = TOOLS / "validate.py"
SCENARIO = ROOT / "tests" / "scenarios" / "stale-state-reconciliation" / ".saipen"

AUTH = "lineage-b512942bac884a8691f6c98afcd6ddb9"
IMPL = "T-1411@cc86601f"
RUN_OK = "echo oracle-ok"
RUN_FAIL = f'{sys.executable} -c "import sys; sys.exit(3)"'
VERIFY = "the installed implementation satisfies the original defect contract"

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
updated: "2026-09-20T00:00:00Z"
---
"""

LOG = (
    "- 20.09.26 00:00 [E-001] [T-030] RUN: transition to VERIFY\n"
    "- 20.09.26 00:01 [E-002] [T-030] DEC: externally blocked, upstream fix pending\n"
)


def _board(*, blocked=True, todo=False, done=False) -> str:
    lines = ["# Board", "## DOING", "## TODO"]
    if todo:
        lines.append(f"- [ ] T-030 [P1] defect implemented upstream | verify: {VERIFY}")
    lines.append("## DONE")
    if done:
        lines.append(
            "- [x] T-031 [P1] local thing | verify: proof | owner: tester | "
            "claim_time: 2026-09-20T00:00:00Z | closure_mode: own_patch"
        )
    lines.append("## BLOCKED")
    if blocked:
        lines.append(
            f"- [ ] T-030 [P1] defect implemented upstream | verify: {VERIFY} | "
            "blocker: BLOCKED_EXTERNAL: implemented by upstream T-1411; no local "
            "patch owns it | blocker_scope: ticket"
        )
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


def _resolve_args(*extra: str, work: str = "T-030") -> tuple[str, ...]:
    return (
        "ticket",
        "resolve-external",
        work,
        "--authority",
        AUTH,
        "--implementation",
        IMPL,
        "--reason",
        "UPSTREAM_FIX_VERIFIED",
        *extra,
    )


class ExternalResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-external-")
        self.root = _make_project(Path(self.tmp.name))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _board_text(self, root: Path | None = None) -> str:
        return ((root or self.root) / ".saipen/BOARD.md").read_text(encoding="utf-8")

    def _receipts(self, root: Path | None = None) -> list[Path]:
        return external_mod.existing_receipts(root or self.root)

    # -- 1/7: local defect fixed upstream and verified locally ----------------

    def test_local_defect_fixed_upstream_and_verified_locally(self):
        before_log = (self.root / ".saipen/LOG.md").read_text(encoding="utf-8")
        rc, payload, out = _run_cli(self.root, *_resolve_args("--run", RUN_OK))
        self.assertEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "EXTERNAL_RESOLVED")
        receipt_id = payload.get("receipt_id")
        self.assertTrue(receipt_id.startswith("EX-"))
        board = self._board_text()
        self.assertIn("- [x] T-030", board)
        self.assertIn("closure_mode: external_implementation", board)
        self.assertIn("implementation_delta: none", board)
        self.assertIn(f"external_authority: {AUTH}", board)
        self.assertIn(f"external_implementation: {IMPL}", board)
        self.assertIn(f"external_evidence: {receipt_id}", board)
        self.assertIn("resolution_reason: UPSTREAM_FIX_VERIFIED", board)
        self.assertNotIn("blocker:", board)
        # the ORIGINAL report survives byte-for-byte in the description/verify
        self.assertIn(VERIFY, board)
        after_log = (self.root / ".saipen/LOG.md").read_text(encoding="utf-8")
        self.assertTrue(after_log.startswith(before_log))
        self.assertIn("RESOLVE-EXTERNAL T-030", after_log)
        receipt = json.loads((self.root / external_mod.EXTERNAL_DIR / f"{receipt_id}.json")
                             .read_text(encoding="utf-8"))
        self.assertEqual(receipt["verdict"], "PASS")
        self.assertEqual(receipt["external_authority"], AUTH)
        self.assertEqual(receipt["external_implementation"], IMPL)
        self.assertEqual(receipt["defect_contract_text"], VERIFY)
        self.assertTrue(receipt["prior_blocker_sha256"])
        self.assertEqual(receipt["installed_identity"]["kind"], "saipen-engine")
        self.assertTrue(receipt["verification"][0]["executed"])

    # -- 3: claimed upstream fix but local verification fails -----------------

    def test_failed_local_verification_never_terminalizes(self):
        before = self._board_text()
        rc, payload, out = _run_cli(self.root, *_resolve_args("--run", RUN_FAIL))
        self.assertNotEqual(rc, 0, out)
        self.assertEqual(payload.get("code"), "EXTERNAL_VERIFICATION_FAILED")
        self.assertEqual(self._board_text(), before)
        receipts = self._receipts()
        self.assertEqual(len(receipts), 1)
        record = json.loads(receipts[0].read_text(encoding="utf-8"))
        self.assertEqual(record["verdict"], "FAIL")

    # -- 4: missing upstream identity ----------------------------------------

    def test_missing_upstream_identity_refused(self):
        before = self._board_text()
        _, payload, _ = _run_cli(
            self.root,
            "ticket",
            "resolve-external",
            "T-030",
            "--authority",
            AUTH,
            "--reason",
            "UPSTREAM_FIX_VERIFIED",
            "--run",
            RUN_OK,
        )
        self.assertEqual(payload.get("code"), "EXTERNAL_IMPLEMENTATION_REQUIRED")
        _, payload, _ = _run_cli(
            self.root,
            "ticket",
            "resolve-external",
            "T-030",
            "--implementation",
            IMPL,
            "--reason",
            "UPSTREAM_FIX_VERIFIED",
            "--run",
            RUN_OK,
        )
        self.assertEqual(payload.get("code"), "EXTERNAL_AUTHORITY_REQUIRED")
        _, payload, _ = _run_cli(
            self.root,
            "ticket",
            "resolve-external",
            "T-030",
            "--authority",
            "https://github.com/someone/saipen",
            "--implementation",
            "fixed upstream",
            "--reason",
            "UPSTREAM_FIX_VERIFIED",
            "--run",
            RUN_OK,
        )
        self.assertEqual(payload.get("code"), "EXTERNAL_AUTHORITY_REQUIRED")
        self.assertEqual(self._board_text(), before)
        self.assertEqual(self._receipts(), [])

    # -- 5: mismatching defect contract --------------------------------------

    def test_mismatching_defect_contract_refused(self):
        _, payload, _ = _run_cli(
            self.root,
            *_resolve_args("--contract", "sha256:" + "0" * 64, "--run", RUN_OK),
        )
        self.assertEqual(payload.get("code"), "EXTERNAL_CONTRACT_MISMATCH")
        self.assertEqual(self._receipts(), [])

    # -- 6: dependency rollback is not silently green (shared resolver) ------

    def test_dependency_rollback_turns_a_closure_non_green(self):
        rc, _, out = _run_cli(self.root, *_resolve_args("--run", RUN_OK))
        self.assertEqual(rc, 0, out)
        from saipen_engine import closure as closure_mod

        verdict = closure_mod.resolve_implementation_source(self.root, "T-030")
        self.assertTrue(verdict.ok, verdict.detail)
        moved = dict(external_mod.engine_identity())
        moved["engine_digest"] = "sha256:" + "f" * 64
        with patch.object(external_mod, "engine_identity", return_value=moved):
            stale = closure_mod.resolve_implementation_source(self.root, "T-030")
        self.assertFalse(stale.ok)
        self.assertIn("dependency moved", stale.detail)

    # -- 7: duplicate external resolution is idempotent -----------------------

    def test_duplicate_external_resolution_is_idempotent(self):
        rc, _, out = _run_cli(self.root, *_resolve_args("--run", RUN_OK))
        self.assertEqual(rc, 0, out)
        board_after_first = self._board_text()
        log_after_first = (self.root / ".saipen/LOG.md").read_text(encoding="utf-8")
        receipt_hash = external_mod.existing_receipts(self.root)[0].read_bytes()
        rc, second, out = _run_cli(self.root, *_resolve_args("--run", RUN_OK))
        self.assertEqual(rc, 0, out)
        self.assertEqual(second.get("code"), "ALREADY_APPLIED")
        self.assertEqual(self._board_text(), board_after_first)
        self.assertEqual(
            (self.root / ".saipen/LOG.md").read_text(encoding="utf-8"), log_after_first
        )
        self.assertEqual(external_mod.existing_receipts(self.root)[0].read_bytes(), receipt_hash)

    # -- 8: own_patch claims for external work are rejected -------------------

    def test_own_patch_claim_for_external_work_is_rejected(self):
        before = self._board_text()
        _, payload, _ = _run_cli(
            self.root,
            "ticket",
            "done",
            "T-030",
            "--closure-mode",
            "external_implementation",
        )
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED")
        self.assertIn("resolve-external", payload.get("detail", ""))
        self.assertEqual(self._board_text(), before)

        done_root = _make_project(
            Path(self.tmp.name) / "done",
            board=_board(blocked=False, done=True),
        )
        _, payload, _ = _run_cli(done_root, *_resolve_args("--run", RUN_OK, work="T-031"))
        self.assertEqual(payload.get("code"), "TICKET_ALREADY_DONE")

    # -- 9: only blocked Work is resolved externally --------------------------

    def test_resolution_requires_blocked_work(self):
        todo_root = _make_project(
            Path(self.tmp.name) / "todo", board=_board(blocked=False, todo=True)
        )
        _, payload, _ = _run_cli(todo_root, *_resolve_args("--run", RUN_OK))
        self.assertEqual(payload.get("code"), "EXTERNAL_RESOLUTION_REQUIRES_BLOCKED")

    # -- 11: the validator shares the ONE predicate ---------------------------

    def test_validator_accepts_current_resolution_and_flags_tampering(self):
        rc, _, out = _run_cli(self.root, *_resolve_args("--run", RUN_OK))
        self.assertEqual(rc, 0, out)
        rc, report = _run_validator(self.root)
        self.assertNotIn("closure provenance does not resolve", report)
        self.assertNotIn("closure-evidence -- ticket T-030", report)
        receipt_path = external_mod.existing_receipts(self.root)[0]
        record = json.loads(receipt_path.read_text(encoding="utf-8"))
        record["verdict"] = "PASS"
        record["external_implementation"] = "T-9999@deadbeef"
        receipt_path.write_text(json.dumps(record, indent=2, sort_keys=True), encoding="utf-8")
        rc, report = _run_validator(self.root)
        self.assertIn("closure provenance does not resolve", report)
        self.assertIn("integrity digest mismatch", report)

    # -- re-resolution after the installed generation moved -------------------

    def test_re_resolution_after_generation_move(self):
        from saipen_engine import operations as ops_mod

        rc, _, out = _run_cli(self.root, *_resolve_args("--run", RUN_OK))
        self.assertEqual(rc, 0, out)
        first_receipt = external_mod.existing_receipts(self.root)[0].name
        moved = dict(external_mod.engine_identity())
        moved["engine_digest"] = "sha256:" + "a" * 64
        with patch.object(external_mod, "engine_identity", return_value=moved):
            result = ops_mod.resolve_external_ticket(
                self.root,
                "T-030",
                "tester",
                authority=AUTH,
                implementation=IMPL,
                resolution_reason="UPSTREAM_FIX_VERIFIED",
                runs=[RUN_OK],
            )
        self.assertTrue(result.ok, result.message)
        self.assertEqual(result.code, "EXTERNAL_RESOLVED")
        self.assertEqual(len(external_mod.existing_receipts(self.root)), 2)
        board = self._board_text()
        self.assertIn("- [x] T-030", board)
        self.assertNotIn(first_receipt.removesuffix(".json"), board)
        self.assertIn("RE-RESOLVED", (self.root / ".saipen/LOG.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
