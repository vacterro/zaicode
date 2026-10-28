"""T-1412: ONE authoritative conformance truth across status, validate, router.

Measured incident (`.saipen/evidence/RAPORT-SAIPEN-CONFORMANCE-TRUTH-20260919/
REPORT.md`, packet SAI-DEFECT-20260919-conformance-truth-not-rendered-not-gated):
on one tree at one instant, `saipen status --json` reported `conformance_status
= STALE_FAIL`, the human `saipen status` line printed `Conformance: PASS` from
the legacy LOG projection, and `saipen validate` answered `VALID` from only the
fast gate -- the three surfaces certified three different trees.

These controls pin the repaired contract:

* `saipen status` JSON and human render read the receipt-derived decision owner,
  and the legacy LOG projection is labelled historical;
* `saipen validate` runs the canonical validator of the SAME running runtime
  through an internal argv path, re-reads the decision AFTERWARD, and returns
  VALID only on CURRENT_PASS -- a validator exit 0 with no durable receipt is
  not conformance;
* the router admits crew convergence only on CURRENT_PASS (NOT_RUN is not an
  exemption) and names `saipen validate` as the executable remediation.

Every fixture is a real git repository whose canonical STATE/BOARD/LOG pass the
fast structural gate. Receipts are crafted raw (mirroring
`generate_conformance_receipt`'s schema) so a stale/invalid receipt can be
tested without clock or Git drift.

Run standalone:
    python -m unittest tools.test_t1412_conformance_truth
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
for _entry in (str(TOOLS), str(ROOT)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

SAIPEN_CLI = TOOLS / "saipen.py"

from saipen_engine import conformance as C  # noqa: E402
from saipen_engine import fast_check  # noqa: E402
from saipen_engine import router as router_mod  # noqa: E402

PROTOCOL_VERSION = C.CONFORMANCE_PROTOCOL_VERSION

_STATE = (
    "---\n"
    "phase: DONE\n"
    "task: none\n"
    'next_action: "saipen continue"\n'
    'blocker: ""\n'
    "transition_from: SHIP\n"
    "saipen_version: 8\n"
    "schema_version: 3\n"
    "last_event: 2\n"
    "style_contract: ded-4ae736e4\n"
    'saipen_home: "V:\\\\___VAC\\\\__K\\\\__CODE\\\\_AI_STUFF_AGENTIC\\\\_SAIPEN"\n'
    "agent: tester\n"
    "mode: full\n"
    'updated: "2026-09-19T21:00:00Z"\n'
    "requires:\n  - filesystem\n  - git\n  - python\n"
    "---\n"
)
_BOARD = "## DOING\n## TODO\n## DONE\n## BLOCKED\n"
_IDENTITY = "---\nproject_lineage: lineage-0123456789abcdef0123456789abcdef\n---\n"
#: A legal RUN record whose terminal token projects a legacy PASS. It is the
#: historical hint the incident showed printed under the `Conformance:` label.
_LEGACY_PASS_RUN = (
    "- 19.09.26 21:01 [E-002] RUN: validate.py -> PASS conf: high -- 0 FAIL 21 WARN\n"
)

#: Router state: converge/crew intent, non-ticket-bearing phase, no DOING.
_ROUTER_STATE = _STATE.replace(
    "agent: tester", "execution_intent: converge\nconverge_target: crew\nagent: tester"
)


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _git(root: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=str(root),
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _source_pair(root: Path) -> tuple[str, str]:
    from freshness import compute_source_identity

    ident = compute_source_identity(root)
    return ident.source_head or "", ident.source_tree_fingerprint or ""


def _quick_hash(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def write_receipt(
    root: Path,
    verdict: str,
    *,
    ts: str | None = None,
    source_head: str = "",
    source_fp: str = "",
    validator_version: str = PROTOCOL_VERSION,
    tamper: bool = False,
) -> None:
    """Raw receipt mirroring `generate_conformance_receipt`'s written schema."""
    ts = ts or _utc_now()
    if not source_head or not source_fp:
        head, fp = _source_pair(root)
        source_head = source_head or head
        source_fp = source_fp or fp
    receipt = {
        "schema_version": 1,
        "kind": "conformance_receipt",
        "validator_protocol_version": validator_version,
        "gate": "core",
        "exit_code": 0 if verdict == "PASS" else 1,
        "verdict": verdict,
        "timestamp_utc": ts,
        "project_identity": "",
        "source_head": source_head,
        "source_tree_fingerprint": source_fp,
        "state_hash": C._hash_file(root / ".saipen" / "STATE.md"),
        "board_hash": C._hash_file(root / ".saipen" / "BOARD.md"),
        "log_hash": C._log_hash(root),
        "content_hash": "",
    }
    body_for_hash = {k: v for k, v in receipt.items() if k != "content_hash"}
    receipt["content_hash"] = _quick_hash(json.dumps(body_for_hash, indent=2, sort_keys=True))
    if tamper:
        receipt["content_hash"] = "0" * 16
    out_dir = root / C.RECEIPT_DIRNAME
    out_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{ts.replace(':', '')}_{'core'}_{verdict}.json"
    (out_dir / fname).write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


class T1412Base(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1412-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()

    def make_project(
        self,
        name: str,
        *,
        legacy_pass_run: bool = False,
        commit_identity: bool = True,
        board: str = _BOARD,
        state: str | None = None,
    ) -> Path:
        root = self.base / name
        (root / ".saipen").mkdir(parents=True)
        (root / ".saipen" / "STATE.md").write_text(state or _STATE, encoding="utf-8")
        (root / ".saipen" / "BOARD.md").write_text(board, encoding="utf-8")
        log = "# LOG\n\n- 19.09.26 21:00 [E-001] DEC: fixture init\n"
        if legacy_pass_run:
            log += _LEGACY_PASS_RUN
        else:
            log += "- 19.09.26 21:01 [E-002] DEC: fixture checkpoint\n"
        (root / ".saipen" / "LOG.md").write_text(log, encoding="utf-8")
        (root / ".saipen" / "IDENTITY.md").write_text(_IDENTITY, encoding="utf-8")
        (root / "tracked.txt").write_text("fixture\n", encoding="utf-8")
        _git(root, "init", "-q")
        if commit_identity:
            _git(root, "add", "-A")
        else:
            _git(root, "add", "tracked.txt")
        _git(
            root,
            "-c",
            "user.email=t@saipen.local",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "-m",
            "init",
        )
        return root

    def assert_fast_gate_clean(self, root: Path) -> None:
        """Premise guard: the fixture really is what the incident measured."""
        from saipen_engine import codec

        errors = fast_check.validate_texts(
            codec.read_doc(root / ".saipen" / "STATE.md"),
            codec.read_doc(root / ".saipen" / "BOARD.md"),
            codec.read_doc(root / ".saipen" / "LOG.md"),
        )
        self.assertEqual(errors, [], errors)

    def run_cli(
        self, root: Path, *args: str, json_output: bool = True, timeout: int = 600
    ) -> tuple[int, dict, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith("SAIPEN_")}
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        command = [sys.executable, str(SAIPEN_CLI), "--project-root", str(root), *args]
        if json_output:
            command.append("--json")
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=timeout,
        )
        payload = {}
        if json_output and proc.stdout.strip():
            try:
                payload = json.loads(proc.stdout)
            except ValueError:
                payload = {"_unparseable_stdout": proc.stdout}
        return proc.returncode, payload, proc.stdout + proc.stderr


# ---------------------------------------------------------------------------
# Status: authoritative JSON and human render
# ---------------------------------------------------------------------------


class StatusSurfaceTests(T1412Base):
    def test_human_status_prints_receipt_truth_not_the_legacy_pass(self) -> None:
        root = self.make_project("stale-fail", legacy_pass_run=True)
        self.assert_fast_gate_clean(root)
        write_receipt(root, "FAIL", source_head="OLD_HEAD", source_fp="OLD_FP")

        rc, payload, text = self.run_cli(root, "status", json_output=False)
        self.assertEqual(rc, 0, text)
        conf_lines = [ln for ln in text.splitlines() if ln.startswith("Conformance:")]
        self.assertEqual(conf_lines, ["Conformance: STALE_FAIL"], text)
        self.assertIn("Reason:", text)
        self.assertIn("Validator history hint:", text)
        self.assertIn("historical; not current authority", text)

        rc, payload, _ = self.run_cli(root, "status")
        self.assertEqual(payload["conformance_status"]["status"], "STALE_FAIL")
        # The legacy projection survives as JSON history -- and is NOT the
        # authoritative field.
        self.assertIn("PASS", str(payload.get("conformance", "")))

    def test_status_matrix_json_and_human_agree_with_authority(self) -> None:
        rows = (
            ("CURRENT_PASS", lambda root: write_receipt(root, "PASS")),
            ("CURRENT_FAIL", lambda root: write_receipt(root, "FAIL")),
            (
                "STALE_PASS",
                lambda root: write_receipt(
                    root, "PASS", source_head="OLD_HEAD", source_fp="OLD_FP"
                ),
            ),
            (
                "STALE_FAIL",
                lambda root: write_receipt(
                    root, "FAIL", source_head="OLD_HEAD", source_fp="OLD_FP"
                ),
            ),
            ("NOT_RUN", lambda root: None),
            (
                "VALIDATOR_VERSION_MISMATCH",
                lambda root: write_receipt(root, "PASS", validator_version="0"),
            ),
            (
                "INVALID_RECEIPT",
                lambda root: write_receipt(root, "PASS", tamper=True),
            ),
        )
        for expected, seed in rows:
            with self.subTest(status=expected):
                root = self.make_project(f"matrix-{expected.lower()}")
                self.assert_fast_gate_clean(root)
                seed(root)

                rc, payload, _ = self.run_cli(root, "status")
                self.assertEqual(
                    payload["conformance_status"]["status"], expected, payload
                )
                decision = C.conformance_decision(root, gate="core")
                self.assertEqual(decision["status"], expected)
                self.assertEqual(decision["healthy"], expected == "CURRENT_PASS")
                if expected in ("CURRENT_PASS", "CURRENT_FAIL"):
                    self.assertIsNone(decision["remediation_command"])
                else:
                    self.assertEqual(
                        decision["remediation_command"], C.CONFORMANCE_REMEDIATION_COMMAND
                    )

                rc, _payload, text = self.run_cli(root, "status", json_output=False)
                self.assertEqual(rc, 0, text)
                conf_lines = [
                    ln for ln in text.splitlines() if ln.startswith("Conformance:")
                ]
                self.assertEqual(conf_lines, [f"Conformance: {expected}"], text)
                if expected != "CURRENT_PASS":
                    self.assertNotIn("Conformance: PASS", text)
                    self.assertNotIn("Conformance: CURRENT_PASS", text)


# ---------------------------------------------------------------------------
# Validate: the canonical front door refreshes and only CURRENT_PASS is VALID
# ---------------------------------------------------------------------------


class ValidateSurfaceTests(T1412Base):
    def test_validate_refreshes_stale_fail_to_current_pass(self) -> None:
        root = self.make_project("refresh", legacy_pass_run=True)
        self.assert_fast_gate_clean(root)
        write_receipt(root, "FAIL", source_head="OLD_HEAD", source_fp="OLD_FP")
        self.assertEqual(
            C.conformance_decision(root)["status"], C.STATUS_STALE_FAIL
        )

        rc, payload, text = self.run_cli(root, "validate")
        self.assertEqual(rc, 0, text)
        self.assertTrue(payload.get("ok"), payload)
        self.assertEqual(payload.get("code"), "VALID")
        self.assertTrue(payload["validator"]["launched"], payload)
        self.assertEqual(payload["validator"]["exit_code"], 0, payload)
        self.assertEqual(
            payload["conformance_status"]["status"], "CURRENT_PASS", payload
        )

        rc, _payload, text = self.run_cli(root, "status", json_output=False)
        self.assertIn("Conformance: CURRENT_PASS", text)

    def test_validate_current_fail_is_non_green(self) -> None:
        # Fast gate clean; the canonical validator has a real failing
        # invariant: the portable lineage carrier is untracked by git.
        root = self.make_project("current-fail", commit_identity=False)
        self.assert_fast_gate_clean(root)

        rc, payload, text = self.run_cli(root, "validate")
        self.assertNotEqual(rc, 0, text)
        self.assertFalse(payload.get("ok"), payload)
        self.assertNotEqual(payload.get("code"), "VALID")
        self.assertEqual(payload["validator"]["launched"], True, payload)
        self.assertEqual(payload["validator"]["exit_code"], 1, payload)
        self.assertEqual(payload["conformance_status"]["status"], "CURRENT_FAIL")
        self.assertIn("reason", payload)

        rc, _payload, text = self.run_cli(root, "status", json_output=False)
        self.assertIn("Conformance: CURRENT_FAIL", text)
        self.assertNotIn("Conformance: PASS", text)

    def test_receipt_write_failure_cannot_return_valid(self) -> None:
        root = self.make_project("write-failure")
        self.assert_fast_gate_clean(root)
        conformance_dir = root / ".saipen" / "recovery" / "conformance"
        conformance_dir.parent.mkdir(parents=True, exist_ok=True)
        conformance_dir.write_text("not a directory\n", encoding="utf-8")

        rc, payload, text = self.run_cli(root, "validate")
        self.assertNotEqual(rc, 0, text)
        self.assertFalse(payload.get("ok"), payload)
        self.assertNotEqual(payload.get("code"), "VALID")
        # Semantic validation PASSED (the validator exited 0) -- and that is
        # exactly the point: process success is not durable conformance proof.
        self.assertEqual(payload["validator"]["exit_code"], 0, payload)
        self.assertNotEqual(
            payload["conformance_status"]["status"], "CURRENT_PASS", payload
        )

    def test_structural_failure_refuses_before_the_validator_runs(self) -> None:
        root = self.make_project(
            "structural", board="## DOING\n## TODO\n## DONE\n"
        )
        rc, payload, text = self.run_cli(root, "validate")
        self.assertNotEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED")
        self.assertNotIn("validator", payload, payload)
        self.assertFalse(
            (root / ".saipen" / "recovery" / "conformance").exists(),
            "a structurally corrupt project must not manufacture a receipt",
        )

    def test_moved_source_pass_never_certifies_the_new_source(self) -> None:
        root = self.make_project("race")
        write_receipt(root, "PASS")
        self.assertEqual(C.conformance_decision(root)["status"], C.STATUS_CURRENT_PASS)
        (root / "moved.txt").write_text("new source\n", encoding="utf-8")
        _git(root, "add", "-A")
        _git(
            root,
            "-c",
            "user.email=t@saipen.local",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "-m",
            "move",
        )
        decision = C.conformance_decision(root)
        self.assertEqual(decision["status"], C.STATUS_STALE_PASS)
        self.assertFalse(decision["healthy"])


# ---------------------------------------------------------------------------
# Router: CURRENT_PASS only, and the remediation it names is executable
# ---------------------------------------------------------------------------


class RouterConformanceGateTests(T1412Base):
    def route(self, root: Path):
        return router_mod.route_next_result(
            root, _ROUTER_STATE, _BOARD, pending_ops_list=[], conflict_ops_list=[]
        )

    def test_router_admits_only_current_pass(self) -> None:
        rows = (
            ("CURRENT_PASS", lambda root: write_receipt(root, "PASS"), True),
            ("CURRENT_FAIL", lambda root: write_receipt(root, "FAIL"), False),
            (
                "STALE_PASS",
                lambda root: write_receipt(
                    root, "PASS", source_head="OLD_HEAD", source_fp="OLD_FP"
                ),
                False,
            ),
            (
                "STALE_FAIL",
                lambda root: write_receipt(
                    root, "FAIL", source_head="OLD_HEAD", source_fp="OLD_FP"
                ),
                False,
            ),
            ("NOT_RUN", lambda root: None, False),
            (
                "VALIDATOR_VERSION_MISMATCH",
                lambda root: write_receipt(root, "PASS", validator_version="0"),
                False,
            ),
            ("INVALID_RECEIPT", lambda root: write_receipt(root, "PASS", tamper=True), False),
        )
        for expected, seed, admitted in rows:
            with self.subTest(status=expected):
                root = self.make_project(f"router-{expected.lower()}")
                seed(root)
                result = self.route(root)
                if admitted:
                    self.assertTrue(result.ok, result)
                    self.assertEqual(result.data.get("action"), "saipen crew")
                    continue
                self.assertFalse(result.ok, result)
                self.assertEqual(result.code, "CONFORMANCE_UNHEALTHY", result)
                command = None if expected == "CURRENT_FAIL" else C.CONFORMANCE_REMEDIATION_COMMAND
                self.assertEqual(result.data.get("action"), command)
                self.assertEqual(
                    result.data.get("canonical_next_command"),
                    command,
                )
                self.assertEqual(result.data.get("conformance_status"), expected)

    def test_named_remediation_is_executable_and_clears_the_refusal(self) -> None:
        root = self.make_project("router-not-run")
        self.assert_fast_gate_clean(root)
        refused = self.route(root)
        self.assertFalse(refused.ok, refused)
        self.assertEqual(refused.data.get("conformance_status"), "NOT_RUN")
        command = refused.data.get("canonical_next_command")
        self.assertEqual(command, "saipen validate")

        # Execute EXACTLY the returned command through the public CLI.
        rc, payload, text = self.run_cli(root, "validate")
        self.assertEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "VALID", payload)
        self.assertEqual(
            payload["conformance_status"]["status"], "CURRENT_PASS", payload
        )

        allowed = self.route(root)
        self.assertTrue(allowed.ok, allowed)
        self.assertEqual(allowed.data.get("action"), "saipen crew")

    def test_continue_crew_route_is_refused_and_the_named_remediation_clears_it(self) -> None:
        """The PRODUCTION continuation path, not just the Result wrapper.

        Measured in the T-1412 installed field acceptance: `saipen continue`
        emitted the crew route while conformance was NOT_RUN, because the only
        conformance gate lived in `route_next_result`, which no production
        caller reached. The gate now sits in ONE function both surfaces call.
        """
        root = self.make_project("router-continue", state=_ROUTER_STATE)
        self.assert_fast_gate_clean(root)

        rc, payload, text = self.run_cli(root, "continue")
        self.assertNotEqual(rc, 0, text)
        self.assertFalse(payload.get("ok"), payload)
        self.assertEqual(payload.get("code"), "CONFORMANCE_UNHEALTHY", payload)
        self.assertEqual(
            payload.get("action"), C.CONFORMANCE_REMEDIATION_COMMAND, payload
        )
        self.assertEqual(
            payload.get("canonical_next_command"), C.CONFORMANCE_REMEDIATION_COMMAND
        )
        self.assertEqual(payload.get("conformance_status"), "NOT_RUN", payload)

        rc, payload, text = self.run_cli(root, "validate")
        self.assertEqual(rc, 0, text)
        self.assertEqual(payload.get("code"), "VALID", payload)

        rc, payload, text = self.run_cli(root, "continue")
        self.assertEqual(rc, 0, text)
        self.assertTrue(payload.get("ok"), payload)
        self.assertEqual(payload.get("action"), "saipen crew", payload)


if __name__ == "__main__":
    unittest.main()
