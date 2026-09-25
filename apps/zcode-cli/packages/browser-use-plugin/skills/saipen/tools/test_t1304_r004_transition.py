"""SRC-026:R004 -- transition-level baseline-wiring regressions (T-1304).

The public SCOUT -> BUILD transition path is the production subject:

    transition_phase(root, "BUILD", agent) on an active SCOUT claim.

Coverage map (handoff required controls A-F):
  A. dry-run purity: the public dry-run transition performs ZERO project
     writes -- no debt snapshot, no conformance receipt, no settled receipt,
     no receipt index, no lineage file, no lock, no STATE/BOARD/LOG change.
  B. successful real transition: phase BUILD, exactly ONE valid baseline
     bound to the Work, captured from the pre-BUILD checkpoint.
  C. baseline failure: structured refusal, phase stays SCOUT, STATE/BOARD/
     LOG unchanged, no authoritative baseline, no transition event.
  D. transition failure after baseline preparation: journaled midpoint --
     baseline exists, BUILD authority does not, and a replay converges
     without duplicate authority.
  E. replay: deterministic result, no duplicate baseline, no duplicate
     transition event.
  F. structural wiring: the real production path calls the canonical
     baseline primitive (ensure_debt_baseline) -- an orphan helper plus
     green unit tests is failure.

ISOLATION NOTE: some suites in a full discovery run purge ``sys.modules``
of all ``saipen_engine`` entries (test_metrics_acceptance). Module objects
captured at import time become stale copies after that purge -- patching
one does not affect the engine another module loaded. Every production
binding in this file resolves through the LIVE ``sys.modules`` entry at
call time so the production path, its baseline primitive and the test
patches always share ONE engine instance.
"""

from __future__ import annotations

import importlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

HOME_ESCAPED = str(ROOT).replace("\\", "\\\\")


def _live(name: str):
    """Resolve a LIVE ``saipen_engine`` module object at call time.

    Import order is not guaranteed (a full discovery run may still be loading
    sibling suites when the first control executes), so import the entry if it
    is absent. A module object captured at import time would go stale after any
    ``sys.modules`` purge, so every production binding resolves here instead.
    """
    importlib.import_module(name)
    return sys.modules[name]


def _live_ops():
    return _live("saipen_engine.operations")


def _live_debt():
    return _live("saipen_engine.debt")


def _live_result():
    return _live("saipen_engine.result")


def _live_intake():
    return _live("saipen_engine.intake")


def _transition(root, destination, agent, ticket_id=None, event_text="", dry_run=False):
    return _live_ops().transition_phase(
        root, destination, agent, ticket_id, event_text, dry_run
    )


def _tree(root: Path) -> dict[str, bytes]:
    """Every file's exact bytes, keyed by repo-relative POSIX path."""
    return {
        str(p.relative_to(root)).replace("\\", "/"): p.read_bytes()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def _paths(root: Path) -> set[str]:
    return {
        str(p.relative_to(root)).replace("\\", "/")
        for p in root.rglob("*")
    }


class ScoutTransitionFixture(unittest.TestCase):
    """A realistic active SCOUT project: T-1 claimed, SCOUT, clean board."""

    def make_scout_project(self) -> Path:
        base = Path(tempfile.mkdtemp(prefix="saipen-r004-transition-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        (project / ".saipen").mkdir(parents=True)
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            "phase: SCOUT\n"
            "task: T-1\n"
            'next_action: "PHASE SCOUT T-1"\n'
            'blocker: ""\n'
            "transition_from: PLAN\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 2\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{HOME_ESCAPED}"\n'
            "agent: tester\n"
            "requires:\n"
            "  - filesystem\n"
            "  - python\n"
            "mode: full\n"
            'updated: "2026-09-10T00:00:00Z"\n'
            "---\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n"
            "- [/] T-1 [P2] active scout work | verify: proof it works"
            " | owner: tester | claim_time: 2026-09-10T00:00:00Z\n"
            "## TODO\n"
            "## DONE\n"
            "## BLOCKED\n",
            encoding="utf-8",
        )
        (project / ".saipen" / "LOG.md").write_text(
            "# Log\n"
            "- 09.09.26 12:00 [E-001] [T-1] [agent: tester] DEC: seed ticket\n"
            "- 09.09.26 12:01 [E-002] [parent: E-001] [T-1] [agent: tester]"
            " DEC: claimed via SAIOPS\n",
            encoding="utf-8",
        )
        return project


# ---------------------------------------------------------------- A


class DryRunTransitionPurityTests(ScoutTransitionFixture):
    """Control A: the public dry-run SCOUT -> BUILD writes zero bytes."""

    def test_dry_run_transition_is_byte_and_path_pure(self) -> None:
        project = self.make_scout_project()
        before_files = _tree(project)
        before_paths = _paths(project)
        result = _transition(project, "BUILD", "tester", dry_run=True)
        after_files = _tree(project)
        after_paths = _paths(project)

        self.assertTrue(result.ok, result.to_json())
        self.assertEqual(before_files, after_files, "dry-run wrote project bytes")
        self.assertEqual(before_paths, after_paths, "dry-run created/removed paths")
        # no authoritative project metadata of any kind
        self.assertFalse((project / ".saipen/IDENTITY.md").exists())
        self.assertFalse((project / ".saipen/recovery/conformance/debt").exists())
        self.assertFalse((project / ".saipen/recovery/settled").exists())
        self.assertFalse((project / ".saipen/recovery/ops").exists())
        self.assertFalse((project / ".saipen/locks/core.lock").exists())
        # the dry-run path never invoked the mutating baseline primitive
        with patch.object(
            _live_debt(),
            "ensure_debt_baseline",
            side_effect=AssertionError("dry-run called ensure_debt_baseline"),
        ):
            result2 = _transition(project, "BUILD", "tester", dry_run=True)
        self.assertTrue(result2.ok, result2.to_json())
        self.assertEqual(_tree(project), before_files, "second dry-run wrote bytes")


# ---------------------------------------------------------------- F


class ProductionWiringTests(ScoutTransitionFixture):
    """Control F: the real production path calls the canonical primitive."""

    def test_real_transition_calls_ensure_debt_baseline(self) -> None:
        project = self.make_scout_project()
        with patch.object(
            _live_debt(),
            "ensure_debt_baseline",
            wraps=_live_debt().ensure_debt_baseline,
        ) as spy:
            result = _transition(project, "BUILD", "tester")
        self.assertTrue(result.ok, result.to_json())
        self.assertEqual(spy.call_count, 1)
        args = spy.call_args
        self.assertEqual(args[0][1], "T-1", "baseline must bind the active Work")
        self.assertEqual(args[0][2], "tester", "baseline must bind the implementing seat")

    def test_non_scout_transitions_do_not_call_baseline(self) -> None:
        project = self.make_scout_project()
        # move to BUILD first (real, with baseline), then VERIFY -> the
        # BUILD -> VERIFY transition must NOT call the baseline primitive.
        first = _transition(project, "BUILD", "tester")
        self.assertTrue(first.ok, first.to_json())
        with patch.object(
            _live_debt(),
            "ensure_debt_baseline",
            side_effect=AssertionError("BUILD -> VERIFY called ensure_debt_baseline"),
        ):
            second = _transition(project, "VERIFY", "tester")
        self.assertTrue(second.ok, second.to_json())


# ---------------------------------------------------------------- B


class SuccessfulTransitionTests(ScoutTransitionFixture):
    """Control B: real SCOUT -> BUILD establishes the exact baseline."""

    def test_real_transition_creates_one_checkpoint_bound_baseline(self) -> None:
        project = self.make_scout_project()
        result = _transition(project, "BUILD", "tester")
        self.assertTrue(result.ok, result.to_json())
        self.assertEqual(result.data.get("phase"), "BUILD")

        # exactly one baseline for the Work
        debt_dir = project / _live_debt().DEBT_DIR
        snapshots = sorted(debt_dir.glob("DEBT-*.json"))
        self.assertEqual(len(snapshots), 1, [p.name for p in snapshots])
        record = _live_debt().load_snapshot(project, snapshots[0].stem)
        self.assertEqual(record["bound_work"], "T-1")
        self.assertEqual(record["bound_work_phase"], "SCOUT")
        self.assertTrue(record["journal_op_id"], "baseline must be journaled")
        self.assertEqual(record["problem_count"], 0)

        # the transition event was committed AFTER baseline authority
        log = (project / ".saipen/LOG.md").read_text(encoding="utf-8")
        self.assertIn("transition to BUILD", log)
        # the baseline's journal op is not the transition's op id
        transition_ops = [
            line for line in log.splitlines() if "[op: transition-" in line
        ]
        self.assertEqual(len(transition_ops), 1)
        baseline_op = record["journal_op_id"]
        self.assertNotIn(f"[op: {baseline_op}]", transition_ops[0])

    def test_replay_reuses_baseline_without_duplicates(self) -> None:
        """Control E: replaying the successful operation converges."""
        project = self.make_scout_project()
        first = _transition(project, "BUILD", "tester")
        self.assertTrue(first.ok, first.to_json())
        snapshots_after_first = sorted(
            (project / _live_debt().DEBT_DIR).glob("DEBT-*.json")
        )
        self.assertEqual(len(snapshots_after_first), 1)
        baseline_id = _live_debt().load_snapshot(
            project, snapshots_after_first[0].stem
        )["snapshot_id"]

        # replay the BASELINE establishment: the existing snapshot is
        # reused, never re-minted (no duplicate baseline authority)
        reuse = _live_debt().ensure_debt_baseline(
            project, "T-1", "tester", "2026-09-10T00:05:00Z"
        )
        self.assertTrue(reuse["ok"], reuse)
        self.assertEqual(reuse["code"], "DEBT_SNAPSHOT_REUSED")
        self.assertEqual(reuse["snapshot_id"], baseline_id)

        # a SCOUT -> BUILD replay while still SCOUT (the midpoint recovery
        # path): the baseline is reused and no second snapshot appears
        project2 = self.make_scout_project()

        def _failing_apply(root, plan):
            return _live_result().Result(
                ok=False, code="WRITER_BUSY", message="injected"
            )

        with patch.object(_live_ops(), "apply_plan", _failing_apply):
            failed = _transition(project2, "BUILD", "tester")
        self.assertFalse(failed.ok, failed.to_json())
        mid_snapshots = sorted((project2 / _live_debt().DEBT_DIR).glob("DEBT-*.json"))
        self.assertEqual(len(mid_snapshots), 1)
        replay = _transition(project2, "BUILD", "tester")
        self.assertTrue(replay.ok, replay.to_json())
        after_snapshots = sorted((project2 / _live_debt().DEBT_DIR).glob("DEBT-*.json"))
        self.assertEqual(
            [p.name for p in mid_snapshots],
            [p.name for p in after_snapshots],
            "replay minted a duplicate baseline",
        )


# ---------------------------------------------------------------- C


class BaselineFailureTests(ScoutTransitionFixture):
    """Control C: baseline failure refuses deterministically, zero mutation."""

    def test_baseline_refusal_leaves_phase_state_board_log_untouched(self) -> None:
        project = self.make_scout_project()
        before_files = _tree(project)
        with patch.object(
            _live_debt(),
            "ensure_debt_baseline",
            return_value={
                "ok": False,
                "code": "VALIDATION_FAILED",
                "detail": "FINDINGS_CAPTURE_FAILED: validator exploded",
            },
        ):
            result = _transition(project, "BUILD", "tester")
        self.assertFalse(result.ok, result.to_json())
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertIn("FINDINGS_CAPTURE_FAILED", result.message or "")
        # phase stays SCOUT; no STATE/BOARD/LOG mutation; no baseline
        state = (project / ".saipen/STATE.md").read_text(encoding="utf-8")
        self.assertIn("phase: SCOUT", state)
        self.assertEqual(before_files, _tree(project), "refusal wrote project bytes")
        self.assertFalse((project / _live_debt().DEBT_DIR).exists())

    def test_baseline_debt_refusal_is_structured(self) -> None:
        project = self.make_scout_project()
        before_files = _tree(project)
        with patch.object(
            _live_debt(),
            "ensure_debt_baseline",
            side_effect=_live_debt().DebtRefusal("VALIDATION_FAILED", "ruleset moved"),
        ):
            result = _transition(project, "BUILD", "tester")
        self.assertFalse(result.ok, result.to_json())
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertIn("ruleset moved", result.message or "")
        self.assertEqual(before_files, _tree(project))

    def test_internal_debt_code_is_normalized_not_a_crash(self) -> None:
        """T-1322 W2-003: the baseline primitive may return its OWN internal
        diagnostic code (`FINDINGS_CAPTURE_FAILED`) which is NOT in OPS.md's
        closed refusal set. The transition must refuse in structured form with
        a CLOSED code, preserve the internal code + detail VERBATIM, and never
        leak the internal code as Result.code or raise ValueError."""
        project = self.make_scout_project()
        before_files = _tree(project)
        with patch.object(
            _live_debt(),
            "ensure_debt_baseline",
            return_value={
                "ok": False,
                "code": "FINDINGS_CAPTURE_FAILED",
                "detail": "validator produced no findings artifact",
            },
        ):
            result = _transition(project, "BUILD", "tester")
        self.assertFalse(result.ok, result.to_json())
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertIn("FINDINGS_CAPTURE_FAILED", result.message or "")
        self.assertIn("validator produced no findings artifact", result.message or "")
        self.assertIn(
            "phase: SCOUT",
            (project / ".saipen/STATE.md").read_text(encoding="utf-8"),
        )
        self.assertEqual(before_files, _tree(project), "refusal wrote project bytes")

    def test_internal_debt_code_in_a_refusal_exception_is_normalized(self) -> None:
        project = self.make_scout_project()
        with patch.object(
            _live_debt(),
            "ensure_debt_baseline",
            side_effect=_live_debt().DebtRefusal(
                "FINDINGS_CAPTURE_FAILED", "capture failed upstream"
            ),
        ):
            result = _transition(project, "BUILD", "tester")
        self.assertFalse(result.ok, result.to_json())
        self.assertEqual(result.code, "VALIDATION_FAILED")
        self.assertIn("FINDINGS_CAPTURE_FAILED", result.message or "")


# ---------------------------------------------------------------- D


class MidpointRecoveryTests(ScoutTransitionFixture):
    """Control D: failure after baseline preparation recovers deterministically."""

    def test_apply_failure_after_baseline_leaves_recoverable_midpoint(self) -> None:
        project = self.make_scout_project()

        def _failing_apply(root, plan):
            # the baseline has already committed by the time apply_plan runs;
            # inject the failure exactly at the dangerous midpoint
            return _live_result().Result(
                ok=False, code="WRITER_BUSY", message="injected midpoint failure"
            )

        with patch.object(_live_ops(), "apply_plan", _failing_apply):
            result = _transition(project, "BUILD", "tester")
        self.assertFalse(result.ok, result.to_json())
        # the baseline WAS established (it commits before the transition)
        snapshots = sorted((project / _live_debt().DEBT_DIR).glob("DEBT-*.json"))
        self.assertEqual(len(snapshots), 1, "baseline missing after midpoint failure")
        record = _live_debt().load_snapshot(project, snapshots[0].stem)
        self.assertEqual(record["bound_work"], "T-1")
        # but BUILD authority was NOT committed
        state = (project / ".saipen/STATE.md").read_text(encoding="utf-8")
        self.assertIn("phase: SCOUT", state)
        log = (project / ".saipen/LOG.md").read_text(encoding="utf-8")
        self.assertNotIn("transition to BUILD", log)

        # replay converges: the existing baseline is reused, no duplicate,
        # and the transition commits exactly once
        replay = _transition(project, "BUILD", "tester")
        self.assertTrue(replay.ok, replay.to_json())
        snapshots_after = sorted((project / _live_debt().DEBT_DIR).glob("DEBT-*.json"))
        self.assertEqual(
            [p.name for p in snapshots],
            [p.name for p in snapshots_after],
            "replay minted a duplicate baseline",
        )
        log_after = (project / ".saipen/LOG.md").read_text(encoding="utf-8")
        self.assertEqual(log_after.count("transition to BUILD"), 1)


if __name__ == "__main__":
    unittest.main()
