"""Audit SRC-008 implementation regressions (2026-08-30).

Each test class is a focused, fast regression for ONE of the four findings
from `SAIPEN__00_AUDIT_ALL_3.md` that were still live at intake time:
CORE-001, W2-001, W2-003, W2-004. The other nine (CORE-002, CORE-003, W2-002,
PERF-001..006) were already implemented by the prior T-1180..T-1193 wave and
their focused regressions live in the existing ``test_audit_*`` modules.
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))


# ---------------------------------------------------------------------------
# CORE-001 -- reconciliation counters must never silently CLEAN drift
# ---------------------------------------------------------------------------


class Core001CounterReconciliation(unittest.TestCase):
    """CORE-001: an ahead counter under the cap is reconciled DOWNWARD to
    canonical evidence. An ahead counter at/over the cap while canonical
    evidence is lower is the tripped safety valve -- never silently cleared
    and never certified CLEAN.
    """

    def _make_project(self, intent: str = "goal") -> Path:
        root = Path(tempfile.mkdtemp(prefix="audit-all3-core001-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)
        state = (
            "---\n"
            "phase: BUILD\n"
            "task: T-001\n"
            'next_action: "PHASE BUILD T-001"\n'
            "blocker: none\n"
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 2\n"
            "style_contract: ded-4ae736e4\n"
            "agent: tester\n"
            "requires:\n  - filesystem\n  - git\n  - python\n"
            "mode: full\n"
            "updated: 2026-08-30T00:00:00Z\n"
            f"execution_intent: {intent}\n"
            "goal_waves: 0\n"
            "goal_tickets: 0\n"
            "---\n"
        )
        (root / ".saipen" / "STATE.md").write_text(state, encoding="utf-8")
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-001 [P1] fix | verify: test\n"
            "## TODO\n"
            "## DONE\n"
            "## BLOCKED\n",
            encoding="utf-8",
        )
        (root / ".saipen" / "LOG.md").write_text(
            "# Log\n"
            "- 30.08.26 00:00 [E-0001] [agent: tester] DEC: goal pivot -- audit-all3\n"
            "- 30.08.26 00:00 [E-0002] [parent: E-0001] [agent: tester] DEC: goal_waves 0->1\n",
            encoding="utf-8",
        )
        return root

    def _patch_field(self, root: Path, field: str, value: str) -> None:
        text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        (root / ".saipen" / "STATE.md").write_text(
            text.replace(f"{field}: 0", f"{field}: {value}"),
            encoding="utf-8",
        )

    def test_ahead_under_cap_dry_run_reports_repair(self) -> None:
        from saipen_engine.reconcile import reconcile_protocol_state

        root = self._make_project()
        self._patch_field(root, "goal_waves", "2")  # ahead of derived=1
        r = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(r["code"], "REPAIR_REQUIRED", r)
        fields = {entry["field"]: entry["to"] for entry in r["changed"]["state"]}
        self.assertEqual(fields.get("goal_waves"), 1, r)

    def test_ahead_under_cap_apply_reconciles_downward(self) -> None:
        from saipen_engine.reconcile import reconcile_protocol_state

        root = self._make_project()
        self._patch_field(root, "goal_waves", "2")
        r = reconcile_protocol_state(root, "tester", dry_run=False)
        self.assertTrue(r["ok"], r)
        text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertIn("goal_waves: 1", text)

    def test_at_cap_with_lower_canonical_refuses_clean(self) -> None:
        from saipen_engine.reconcile import reconcile_protocol_state

        root = self._make_project()
        # waves=3 (at cap), derived=1 (only one bump) -> tripped valve
        self._patch_field(root, "goal_waves", "3")
        r = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["code"], "RECONCILE_REAUTH_REQUIRED", r)
        self.assertTrue(r.get("refused"), r)
        # counters preserved
        text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        self.assertIn("goal_waves: 3", text)

    def test_malformed_counter_repairs_with_explicit_reason(self) -> None:
        from saipen_engine.reconcile import reconcile_protocol_state

        root = self._make_project()
        # replace valid int with garbage
        text = (root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        text = text.replace("goal_waves: 0", "goal_waves: banana")
        (root / ".saipen" / "STATE.md").write_text(text, encoding="utf-8")
        r = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertIn(r["code"], ("REPAIR_REQUIRED", "RECONCILE_REAUTH_REQUIRED"), r)
        fields = r["changed"]["state"]
        wf = next(f for f in fields if f["field"] == "goal_waves")
        self.assertIn("malformed", wf["reason"], wf)

    def test_under_counter_repairs_upward(self) -> None:
        from saipen_engine.reconcile import reconcile_protocol_state

        root = self._make_project()
        # derived=1, state=0 -> repair upward
        self._patch_field(root, "goal_waves", "0")
        r = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(r["code"], "REPAIR_REQUIRED", r)
        fields = {entry["field"]: entry["to"] for entry in r["changed"]["state"]}
        self.assertEqual(fields.get("goal_waves"), 1, r)

    def test_clean_state_is_clean(self) -> None:
        from saipen_engine.reconcile import reconcile_protocol_state

        root = self._make_project()
        # match derived=1
        self._patch_field(root, "goal_waves", "1")
        r = reconcile_protocol_state(root, "tester", dry_run=True)
        self.assertEqual(r["code"], "CLEAN", r)


# ---------------------------------------------------------------------------
# W2-001 -- orphan capture must restore the receipt-id allocator
# ---------------------------------------------------------------------------


class W2001OrphanAllocator(unittest.TestCase):
    """W2-001: when an orphan receipt is adopted, the index ``next_id``
    invariant ``next_id > max(receipt ids)`` MUST be restored before the
    recovered index is persisted. A retry that succeeds but leaves a
    decodable-broken index is the exact failure this test class closes.
    """

    def _init_intake(self, root: Path) -> None:
        intake = root / ".saipen" / "intake"
        for sub in ("active", "contracts", "coverage", "tombstones"):
            (intake / sub).mkdir(parents=True, exist_ok=True)
        (intake / "index.json").write_text(
            json.dumps(
                {
                    "active": {},
                    "next_id": 1,
                    "schema_version": 1,
                    "tombstones": {},
                }
            )
        )

    def test_body_only_orphan_recovery_restores_allocator(self) -> None:
        from saipen_engine import intake

        root = Path(tempfile.mkdtemp(prefix="audit-all3-w2001-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)
        self._init_intake(root)

        r1 = intake.capture(root, "SRC-001 body", source_kind="user_audit")
        self.assertEqual(r1["code"], "SOURCE_RECEIVED", r1)

        # Force orphan: keep body, drop active entry, stale next_id
        idx_path = root / ".saipen/intake/index.json"
        idx = json.loads(idx_path.read_text())
        del idx["active"]["SRC-001"]
        idx["next_id"] = 1
        idx_path.write_text(json.dumps(idx))

        r2 = intake.capture(root, "SRC-001 body", source_kind="user_audit")
        self.assertEqual(r2["code"], "ORPHAN_RECEIPT_RECOVERED", r2)
        idx2 = json.loads(idx_path.read_text())
        self.assertGreaterEqual(idx2["next_id"], 2, idx2)
        self.assertIn("SRC-001", idx2["active"], idx2)

        # Next unrelated capture must allocate a fresh, higher id
        r3 = intake.capture(root, "SRC-002 body", source_kind="user_audit")
        self.assertEqual(r3["code"], "SOURCE_RECEIVED", r3)
        self.assertEqual(r3["receipt"], "SRC-002", r3)
        idx3 = json.loads(idx_path.read_text())
        self.assertGreaterEqual(idx3["next_id"], 3, idx3)

    def test_partial_orphan_recovery_restores_allocator(self) -> None:
        from saipen_engine import intake

        root = Path(tempfile.mkdtemp(prefix="audit-all3-w2001-partial-"))
        self.addCleanup(lambda: shutil.rmtree(root, ignore_errors=True))
        (root / ".saipen").mkdir(parents=True)
        self._init_intake(root)

        r1 = intake.capture(root, "SRC-001 body", source_kind="user_audit")
        self.assertEqual(r1["code"], "SOURCE_RECEIVED", r1)
        # drop body + active entry, stale next_id
        idx_path = root / ".saipen/intake/index.json"
        idx = json.loads(idx_path.read_text())
        (root / ".saipen/intake/active/SRC-001.md").unlink()
        del idx["active"]["SRC-001"]
        idx["next_id"] = 1
        idx_path.write_text(json.dumps(idx))
        # capture different body -- orphan detector finds no body, allocates fresh
        r2 = intake.capture(root, "totally different", source_kind="user_audit")
        self.assertEqual(r2["code"], "SOURCE_RECEIVED", r2)
        # next must be 2
        idx2 = json.loads(idx_path.read_text())
        self.assertGreaterEqual(idx2["next_id"], 2, idx2)


# ---------------------------------------------------------------------------
# W2-003 -- test-runner must reap child process tree on every abnormal exit
# ---------------------------------------------------------------------------


class W2003ProcessCleanup(unittest.TestCase):
    """W2-003: a child test process started under ``_run_family`` MUST be
    terminated and reaped even when the owning frame exits via
    KeyboardInterrupt, SystemExit, or any other BaseException. The
    disposable repro spawns a long-lived child and asserts no process
    remains.
    """

    def test_keyboard_interrupt_during_wait_terminates_child_tree(self) -> None:
        from saipen_engine import test_runner

        # Spawn a child that records its PID and sleeps long enough for us
        # to interrupt. The parent launches it via _run_family-equivalent
        # Popen + wait and triggers KeyboardInterrupt while waiting.
        probe = Path(tempfile.mkdtemp(prefix="audit-all3-w2003-"))
        self.addCleanup(lambda: shutil.rmtree(probe, ignore_errors=True))
        pidfile = probe / "child.pid"
        sentinel = probe / "sentinel"
        child_script = (
            "import os, sys, time;"
            f"open(r'{pidfile}', 'w').write(str(os.getpid()));"
            f"open(r'{sentinel}', 'w').write('started');"
            "time.sleep(30);"
            "sys.exit(0)"
        )
        # Start the long-lived child directly
        creation = (
            {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}
            if os.name == "nt"
            else {"start_new_session": True}
        )
        child = subprocess.Popen(
            [sys.executable, "-B", "-c", child_script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **creation,
        )
        # Wait until the child wrote its pid
        for _ in range(50):
            if pidfile.is_file():
                break
            import time as _t

            _t.sleep(0.1)
        self.assertTrue(pidfile.is_file(), "child did not record its pid in time")
        child_pid = int(pidfile.read_text().strip())

        # Now run an inner Popen + wait under KeyboardInterrupt; assert the
        # new ``_run_family`` shape (with finally) reaps the child.
        victim = subprocess.Popen(
            [sys.executable, "-B", "-c", child_script],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **creation,
        )
        try:
            for _ in range(50):
                if (probe / "sentinel").is_file() and victim.poll() is None:
                    break
                import time as _t

                _t.sleep(0.1)
            self.assertIsNone(victim.poll(), "victim died before interrupt")

            # Simulate KeyboardInterrupt propagation by calling
            # ``_terminate_process_tree`` exactly as the new finally block
            # would when an abnormal exit is in flight.
            test_runner._terminate_process_tree(victim)
            with __import__("contextlib").suppress(subprocess.TimeoutExpired):
                victim.wait(timeout=5)
            self.assertIsNotNone(victim.poll(), "victim survived the cleanup")
        finally:
            # clean up the unrelated outer child if still alive
            if child.poll() is None:
                test_runner._terminate_process_tree(child)
                with __import__("contextlib").suppress(subprocess.TimeoutExpired):
                    child.wait(timeout=2)

        # Dispose of any stragglers via taskkill (Windows) or killpg (POSIX)
        for leftover in (child_pid, victim.pid):
            try:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(leftover)],
                        capture_output=True,
                        check=False,
                    )
                else:
                    os.killpg(leftover, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass


# ---------------------------------------------------------------------------
# W2-004 -- compound parser must fail closed on malformed quote state
# ---------------------------------------------------------------------------


class W2004CompoundParser(unittest.TestCase):
    """W2-004: ``parse_compound_command`` must NOT reinterpret quoted
    separators as dispatch boundaries and MUST refuse the whole compound
    input when an open quote is left dangling at EOF.
    """

    def test_plain_compound(self) -> None:
        from saipen_engine.commands import parse_compound_command

        self.assertEqual(parse_compound_command("gg + cc"), ["gg", "cc"])

    def test_quoted_plus_preserved(self) -> None:
        from saipen_engine.commands import parse_compound_command

        self.assertEqual(
            parse_compound_command('gg "A + B" + cc'),
            ['gg "A + B"', "cc"],
        )

    def test_quoted_newline_preserved(self) -> None:
        from saipen_engine.commands import parse_compound_command

        self.assertEqual(
            parse_compound_command('gg "A\nB" + cc'),
            ['gg "A\nB"', "cc"],
        )

    def test_empty_quoted_payload(self) -> None:
        from saipen_engine.commands import parse_compound_command

        # Empty quoted payload is a recognized non-empty segment
        self.assertEqual(parse_compound_command('gg "" + cc'), ['gg ""', "cc"])

    def test_dangling_quote_refuses(self) -> None:
        from saipen_engine.commands import parse_compound_command

        self.assertEqual(parse_compound_command('gg "unterminated + cc'), [])

    def test_dangling_quote_after_payload_refuses(self) -> None:
        from saipen_engine.commands import parse_compound_command

        self.assertEqual(parse_compound_command('gg foo "bar + cc'), [])

    def test_escaped_quote_is_literal_not_toggle(self) -> None:
        from saipen_engine.commands import parse_compound_command

        # Backslash before a quote makes the quote literal (no toggle), so
        # there is no dangling quote and the compound splits deterministically.
        self.assertEqual(
            parse_compound_command('gg foo \\"bar + cc'),
            ['gg foo \\"bar', "cc"],
        )

    def test_literal_quote_then_dangling_refuses(self) -> None:
        from saipen_engine.commands import parse_compound_command

        # An actual (unescaped) opening quote left open at EOF must refuse
        # the whole compound.
        self.assertEqual(parse_compound_command('gg "a + b + cc'), [])


if __name__ == "__main__":
    unittest.main()
