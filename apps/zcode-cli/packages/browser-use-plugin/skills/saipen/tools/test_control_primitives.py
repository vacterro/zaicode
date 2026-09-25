"""Hostile controls: FF/VV/XX/ZZ and sparse Restore Milestones."""

from __future__ import annotations

import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.controls import (  # noqa: E402
    confirm_cut,
    create_milestone,
    cut_preview,
    directive_entry,
    encode_agent_plan,
    focus_projection,
    milestone_status,
    plan_milestone,
    undo_confirm,
    undo_preview,
    validate_milestones,
)
from saipen_engine.journal import auto_recover_pending, ensure_project_lineage  # noqa: E402
from saipen_engine.plan import apply_plan  # noqa: E402
from saipen_engine.operations import (  # noqa: E402
    apply_claim,
    attempt_lifecycle,
    checkpoint,
    finish_ticket,
    record_scope,
    transition_phase,
)
from saipen_engine.state import parse_state  # noqa: E402

SAIPEN_PY = TOOLS / "saipen.py"


def _tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.as_posix()):
        rel = path.relative_to(root).as_posix().encode("utf-8")
        raw = path.read_bytes()
        digest.update(len(rel).to_bytes(8, "big"))
        digest.update(rel)
        digest.update(len(raw).to_bytes(8, "big"))
        digest.update(raw)
    return digest.hexdigest()


def _resolved_cut(
    project: Path,
    target: str,
    *,
    affected: list[str],
    resolved: str = "old queue mode flag",
) -> tuple[object, dict]:
    semantic = {
        "target_expression": target,
        "resolved_target": resolved,
        "affected_paths": affected,
        "remove": ["old flag"],
        "preserve": ["manual queue"],
        "risk": "low",
    }
    preview = cut_preview(project, target, semantic)
    plan = {
        **preview.data["resolved_plan"],
        "binding": preview.data["binding"],
        "plan_hash": preview.data["plan_hash"],
    }
    return preview, plan


class ControlFixture(unittest.TestCase):
    def make_project(self, *, intent: str = "normal", active: bool = False) -> Path:
        base = Path(tempfile.mkdtemp(prefix="saipen-controls-"))
        self.addCleanup(lambda: shutil.rmtree(base, ignore_errors=True))
        project = base / "project"
        (project / ".saipen").mkdir(parents=True)
        now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        phase = "BUILD" if active else "DONE"
        task = "T-7" if active else "none"
        next_action = "PHASE BUILD T-7" if active else "saipen continue"
        transition_from = "SCOUT" if active else "DONE"
        extra = "goal_waves: 1\ngoal_tickets: 0\n" if intent == "goal" else ""
        if intent == "converge":
            extra = "converge_target: done\n"
        (project / ".saipen" / "STATE.md").write_text(
            "---\n"
            f"phase: {phase}\n"
            f"task: {task}\n"
            f'next_action: "{next_action}"\n'
            'blocker: ""\n'
            f"transition_from: {transition_from}\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 1\n"
            "style_contract: ded-4ae736e4\n"
            f'saipen_home: "{str(ROOT).replace(chr(92), chr(92) * 2)}"\n'
            "agent: tester\n"
            "requires:\n  - filesystem\n  - python\n"
            "mode: full\n"
            f'updated: "{now}"\n'
            f"execution_intent: {intent}\n"
            f"{extra}"
            "---\n",
            encoding="utf-8",
        )
        doing = (
            f"- [/] T-7 [P1] Existing Work | verify: existing proof | "
            f"owner: tester | claim_time: {now}\n"
            if active
            else ""
        )
        (project / ".saipen" / "BOARD.md").write_text(
            f"## DOING\n{doing}## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        ticket = " [T-7]" if active else ""
        (project / ".saipen" / "LOG.md").write_text(
            f"- 24.08.26 00:00 [E-001]{ticket} [agent: tester] RUN: fixture -> PASS\n",
            encoding="utf-8",
        )
        ensure_project_lineage(project)
        return project

    def cli(self, project: Path, *args: str) -> tuple[int, dict]:
        proc = subprocess.run(
            [
                sys.executable,
                str(SAIPEN_PY),
                "--project-root",
                str(project),
                "--json",
                *args,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            timeout=60,
        )
        return proc.returncode, json.loads(proc.stdout)


class FocusTests(ControlFixture):
    def test_bare_active_and_expression_are_zero_write(self):
        project = self.make_project(active=True)
        (project / "queue.py").write_text("class QueueMode:\n    pass\n", encoding="utf-8")
        before = _tree_digest(project)
        bare = focus_projection(project)
        explicit = focus_projection(project, "queue mode/topbar/performance")
        self.assertEqual(before, _tree_digest(project))
        self.assertEqual(bare.data["resolved_seed"], "T-7")
        self.assertEqual(explicit.data["expression"], "queue mode/topbar/performance")
        self.assertTrue(any(m["path"] == "queue.py" for m in explicit.data["exact_matches"]))

    def test_absent_concept_and_git_unavailable_are_truthful(self):
        project = self.make_project()
        before = _tree_digest(project)
        result = focus_projection(project, "definitely absent concept")
        self.assertTrue(result.ok)
        self.assertEqual(result.data["exact_matches"], [])
        self.assertEqual(before, _tree_digest(project))

    def test_focus_does_not_follow_external_symlink(self):
        project = self.make_project()
        outside = project.parent / "outside-focus-secret.txt"
        outside.write_text("needle-from-outside\n", encoding="utf-8")
        link = project / "linked.txt"
        try:
            link.symlink_to(outside)
        except OSError as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        result = focus_projection(project, "needle-from-outside")
        self.assertTrue(result.ok)
        self.assertFalse(
            any(match["path"] == "linked.txt" for match in result.data["exact_matches"])
        )


class BuildAndCutTests(ControlFixture):
    def test_in_place_cold_adoption_preserves_active_phase(self):
        project = self.make_project(active=True)
        board_path = project / ".saipen/BOARD.md"
        board = board_path.read_text(encoding="utf-8")
        board = re.sub(r" \| owner: tester \| claim_time: [^\n]+", "", board)
        board_path.write_text(board, encoding="utf-8")
        result = apply_claim(project, "T-7", "successor", explicit=True)
        self.assertTrue(result.ok, result.to_dict())
        self.assertTrue(result.data["resumed_in_place"])
        state = parse_state((project / ".saipen/STATE.md").read_text(encoding="utf-8"))
        self.assertEqual((state["phase"], state["next_action"]), ("BUILD", "PHASE BUILD T-7"))

    def test_control_mutation_cannot_handover_foreign_open_attempt(self):
        project = self.make_project(active=True)
        opened = attempt_lifecycle(project, "tester", "open")
        self.assertTrue(opened.ok, opened.to_dict())
        before = _tree_digest(project)
        refused = create_milestone(project, "successor", "Unsafe", ["x.txt"])
        self.assertFalse(refused.ok)
        self.assertEqual(refused.code, "VALIDATION_FAILED")
        self.assertEqual(before, _tree_digest(project))

    def test_build_starts_at_scout_and_preserves_goal(self):
        project = self.make_project(intent="goal")
        result = directive_entry(project, "tester", "clean", kind="build")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "BUILD_WORK_STARTED")
        state = parse_state((project / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
        self.assertEqual(state["phase"], "SCOUT")
        self.assertEqual(state["execution_intent"], "goal")
        self.assertEqual((state["goal_waves"], state["goal_tickets"]), (1, 0))
        self.assertRegex(state["attempt"], r"^A-\d{3,}$")
        self.assertEqual(result.data["attempt"], state["attempt"])
        board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertIn("BUILD user directive: clean", board)
        self.assertNotIn("PHASE BUILD", result.to_json())

    def test_active_work_is_not_laundered_through_illegal_dfa_edge(self):
        project = self.make_project(intent="converge", active=True)
        result = directive_entry(project, "tester", "tray", kind="build")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "BUILD_WORK_QUEUED")
        state = parse_state((project / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
        self.assertEqual((state["phase"], state["task"]), ("BUILD", "T-7"))
        self.assertEqual(state["execution_intent"], "converge")
        board = (project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertEqual(board.count("- [/]"), 1)
        self.assertIn("VV" if False else "BUILD user directive: tray", board)

    def test_empty_build_and_preview_confirm_errors_write_nothing(self):
        project = self.make_project()
        before = _tree_digest(project)
        rc, payload = self.cli(project, "vv")
        self.assertEqual((rc, payload["code"]), (2, "VALIDATION_FAILED"))
        _rc2, payload2 = self.cli(project, "xx", "confirm", "CUT-ABC")
        self.assertEqual(payload2["code"], "DESTRUCTIVE_CONFIRMATION_REQUIRED")
        self.assertEqual(before, _tree_digest(project))

    def test_cut_preview_is_stable_zero_write_and_stales(self):
        project = self.make_project()
        (project / "feature.py").write_text("old = True\n", encoding="utf-8")
        before = _tree_digest(project)
        unresolved = cut_preview(project, "old queue mode")
        self.assertEqual(unresolved.code, "CUT_ANALYSIS_REQUIRED")
        self.assertNotIn("cut_id", unresolved.data)
        one, plan = _resolved_cut(project, "old queue mode", affected=["feature.py"])
        two, _plan_two = _resolved_cut(project, "old queue mode", affected=["feature.py"])
        self.assertEqual(one.data["cut_id"], two.data["cut_id"])
        self.assertEqual(before, _tree_digest(project))
        (project / "feature.py").write_text("old = False\n", encoding="utf-8")
        stale = confirm_cut(project, "tester", one.data["cut_id"], plan)
        self.assertFalse(stale.ok)
        self.assertEqual(stale.code, "STALE_PLAN")

    def test_cut_id_authenticates_exact_impact_plan(self):
        project = self.make_project()
        (project / "feature.py").write_text("old = True\n", encoding="utf-8")
        original, _plan = _resolved_cut(
            project,
            "old queue mode",
            affected=["feature.py"],
        )
        changed, changed_plan = _resolved_cut(
            project,
            "old queue mode",
            affected=["feature.py", "extra.py"],
        )
        self.assertNotEqual(original.data["cut_id"], changed.data["cut_id"])
        before = _tree_digest(project)
        refused = confirm_cut(project, "tester", original.data["cut_id"], changed_plan)
        self.assertFalse(refused.ok)
        self.assertEqual(refused.code, "STALE_PLAN")
        self.assertEqual(before, _tree_digest(project))

    def test_confirmed_cut_creates_anchor_before_normal_work(self):
        project = self.make_project()
        (project / "feature.py").write_text("old = True\n", encoding="utf-8")
        preview, plan = _resolved_cut(
            project,
            "old queue mode",
            affected=["feature.py", "future-absent.py"],
        )
        result = confirm_cut(project, "tester", preview.data["cut_id"], plan)
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "CUT_WORK_STARTED")
        self.assertEqual(result.data["rollback_anchor"], "CP-001")
        self.assertEqual(parse_state((project / ".saipen/STATE.md").read_text())["phase"], "SCOUT")

    def test_cut_retry_after_anchor_is_idempotent(self):
        project = self.make_project()
        (project / "feature.py").write_text("old = True\n", encoding="utf-8")
        preview, plan = _resolved_cut(project, "old queue mode", affected=["feature.py"])
        anchor = create_milestone(
            project,
            "tester",
            "Pre-cut old queue mode flag",
            ["feature.py"],
            kind=f"pre-cut:{preview.data['cut_id']}",
        )
        self.assertEqual(anchor.data["milestone"], "CP-001")
        resumed = confirm_cut(project, "tester", preview.data["cut_id"], plan)
        self.assertTrue(resumed.ok, resumed.to_dict())
        self.assertEqual(resumed.data["rollback_anchor"], "CP-001")
        replay = confirm_cut(project, "tester", preview.data["cut_id"], plan)
        self.assertEqual(replay.code, "ALREADY_APPLIED")
        self.assertEqual(len(list((project / ".saipen/milestones").glob("CP-*"))), 1)

    def test_cut_anchor_resume_refuses_changed_source(self):
        project = self.make_project()
        path = project / "feature.py"
        path.write_text("old = True\n", encoding="utf-8")
        preview, plan = _resolved_cut(project, "old queue mode", affected=["feature.py"])
        self.assertTrue(
            create_milestone(
                project,
                "tester",
                "Pre-cut old queue mode flag",
                ["feature.py"],
                kind=f"pre-cut:{preview.data['cut_id']}",
            ).ok
        )
        path.write_text("old = False\n", encoding="utf-8")
        result = confirm_cut(project, "tester", preview.data["cut_id"], plan)
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "STALE_PLAN")

    def test_public_cli_cut_confirmation_transports_exact_plan(self):
        project = self.make_project()
        (project / "feature.py").write_text("old = True\n", encoding="utf-8")
        preview, plan = _resolved_cut(project, "old queue mode", affected=["feature.py"])
        rc, payload = self.cli(
            project,
            "xx",
            "confirm",
            preview.data["cut_id"],
            "--",
            encode_agent_plan(plan),
        )
        self.assertEqual((rc, payload["code"]), (0, "CUT_WORK_STARTED"))
        self.assertEqual(payload["rollback_anchor"], "CP-001")


class MilestoneUndoTests(ControlFixture):
    def test_first_baseline_can_capture_sparse_git_parent_without_touching_index(self):
        project = self.make_project()
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        subprocess.run(["git", "-C", str(project), "config", "user.name", "fixture"], check=True)
        subprocess.run(
            ["git", "-C", str(project), "config", "user.email", "fixture@example.invalid"],
            check=True,
        )
        old = project / "old.bin"
        new = project / "new.bin"
        old.write_bytes(b"before\x00")
        subprocess.run(["git", "-C", str(project), "add", "--", "."], check=True)
        subprocess.run(["git", "-C", str(project), "commit", "-qm", "baseline"], check=True)
        revision = subprocess.run(
            ["git", "-C", str(project), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        old.write_bytes(b"after\x00")
        new.write_bytes(b"new")
        index_before = subprocess.run(
            ["git", "-C", str(project), "diff", "--cached", "--binary"],
            capture_output=True,
            check=True,
        ).stdout
        baseline = create_milestone(
            project,
            "tester",
            "Baseline created now",
            ["old.bin", "new.bin"],
            kind="baseline-import",
            capture_revision=revision,
        )
        self.assertTrue(baseline.ok, baseline.to_dict())
        self.assertTrue(
            create_milestone(project, "tester", "Feature", ["old.bin", "new.bin"]).ok
        )
        preview = undo_preview(project)
        self.assertEqual(preview.data["target"]["id"], "CP-001")
        restored = undo_confirm(project, "tester", "CP-001", "Feature interpretation rejected")
        self.assertTrue(restored.ok, restored.to_dict())
        self.assertEqual(old.read_bytes(), b"before\x00")
        self.assertFalse(new.exists())
        index_after = subprocess.run(
            ["git", "-C", str(project), "diff", "--cached", "--binary"],
            capture_output=True,
            check=True,
        ).stdout
        self.assertEqual(index_after, index_before)

    def test_milestone_identity_survives_project_move(self):
        project = self.make_project()
        payload = project / "portable.bin"
        payload.write_bytes(b"portable restore evidence\x00")
        created = create_milestone(project, "tester", "Portable", [payload.name])
        self.assertTrue(created.ok, created.to_dict())

        moved = project.parent / "moved-project"
        shutil.copytree(project, moved)
        self.assertEqual(validate_milestones(moved), [])
        manifest = json.loads(
            (moved / ".saipen/milestones/CP-001/manifest.json").read_text(encoding="utf-8")
        )
        self.assertIn("project_lineage", manifest)
        self.assertNotIn("project_identity", manifest)

    def test_crlf_payload_survives_git_clone_byte_exact(self):
        project = self.make_project()
        payload = project / "history.txt"
        payload.write_bytes(b"first  \r\nsecond\r\n\r\n")
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        subprocess.run(
            ["git", "-C", str(project), "config", "user.name", "fixture"], check=True
        )
        subprocess.run(
            ["git", "-C", str(project), "config", "user.email", "fixture@example.invalid"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(project), "config", "core.autocrlf", "true"], check=True
        )
        subprocess.run(["git", "-C", str(project), "add", "-A"], check=True)
        subprocess.run(
            ["git", "-C", str(project), "commit", "-qm", "source baseline"], check=True
        )

        created = create_milestone(project, "tester", "CRLF Baseline", [payload.name])
        self.assertTrue(created.ok, created.to_dict())
        subprocess.run(["git", "-C", str(project), "add", "-A"], check=True)
        whitespace_gate = subprocess.run(
            ["git", "-C", str(project), "diff", "--cached", "--check"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(whitespace_gate.returncode, 0, whitespace_gate.stdout)
        subprocess.run(
            ["git", "-C", str(project), "commit", "-qm", "portable milestone"], check=True
        )

        clone = project.parent / "crlf-clone"
        subprocess.run(
            ["git", "-c", "core.autocrlf=true", "clone", "-q", str(project), str(clone)],
            check=True,
        )
        self.assertEqual(validate_milestones(clone), [])

    def test_milestone_plan_refuses_scope_race(self):
        project = self.make_project()
        path = project / "racy.bin"
        path.write_bytes(b"before")
        plan = plan_milestone(project, "tester", "Race", ["racy.bin"])
        self.assertFalse(hasattr(plan, "ok"))
        path.write_bytes(b"after")
        result = apply_plan(project, plan)
        self.assertFalse(result.ok)
        self.assertEqual(result.code, "STALE_STATE")
        self.assertFalse((project / ".saipen/milestones/CP-001/manifest.json").exists())

    def test_reviewed_dirty_work_returns_to_current_milestone(self):
        project = self.make_project()
        path = project / "topbar.py"
        path.write_text("indicator = False\n", encoding="utf-8")
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["topbar.py"]).ok)

        started = directive_entry(project, "tester", "queue timer indicator", kind="build")
        self.assertTrue(started.ok, started.to_dict())
        ticket = started.data["ticket"]
        self.assertTrue(transition_phase(project, "BUILD", "tester", ticket, "native fit").ok)
        path.write_text("indicator = True\n", encoding="utf-8")
        self.assertTrue(
            attempt_lifecycle(
                project,
                "tester",
                "close",
                result="candidate",
                stop="completed_execution",
            ).ok
        )
        self.assertTrue(transition_phase(project, "VERIFY", "tester", ticket, "verify").ok)
        self.assertTrue(
            checkpoint(project, "tester", "RUN", ticket, "control suite -> PASS conf: high").ok
        )
        self.assertTrue(transition_phase(project, "REVIEW", "tester", ticket, "review").ok)
        self.assertTrue(record_scope(project, ticket, "tester", ["topbar.py"]).ok)
        self.assertTrue(transition_phase(project, "SHIP", "tester", ticket, "ship").ok)
        self.assertTrue(finish_ticket(project, ticket, "tester").ok)

        preview = undo_preview(project)
        self.assertTrue(preview.ok, preview.to_dict())
        self.assertTrue(preview.data["dirty_since"])
        self.assertEqual(preview.data["target"]["id"], "CP-001")
        self.assertEqual(preview.data["ownership_work"], [ticket])
        restored = undo_confirm(project, "tester", "CP-001", "Feature did not fit")
        self.assertTrue(restored.ok, restored.to_dict())
        self.assertEqual(path.read_text(encoding="utf-8"), "indicator = False\n")

    def test_published_dirty_work_creates_forward_revert(self):
        project = self.make_project()
        path = project / "topbar.py"
        path.write_text("indicator = False\n", encoding="utf-8")
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["topbar.py"]).ok)

        started = directive_entry(project, "tester", "queue timer indicator", kind="build")
        self.assertTrue(started.ok, started.to_dict())
        ticket = started.data["ticket"]
        self.assertTrue(transition_phase(project, "BUILD", "tester", ticket, "native fit").ok)
        path.write_text("indicator = True\n", encoding="utf-8")
        self.assertTrue(
            attempt_lifecycle(
                project,
                "tester",
                "close",
                result="candidate",
                stop="completed_execution",
            ).ok
        )
        self.assertTrue(transition_phase(project, "VERIFY", "tester", ticket, "verify").ok)
        self.assertTrue(
            checkpoint(project, "tester", "RUN", ticket, "controls -> PASS conf: high").ok
        )
        self.assertTrue(transition_phase(project, "REVIEW", "tester", ticket, "review").ok)
        self.assertTrue(record_scope(project, ticket, "tester", ["topbar.py"]).ok)
        self.assertTrue(transition_phase(project, "SHIP", "tester", ticket, "ship").ok)
        self.assertTrue(
            checkpoint(
                project,
                "tester",
                "RUN",
                ticket,
                "ship v7.227.0 -> content commit abcdef123456 pushed",
            ).ok
        )
        self.assertTrue(finish_ticket(project, ticket, "tester").ok)

        relocated = project.parent / "fresh-clone-like-relocation"
        shutil.copytree(project, relocated)
        relocated_path = relocated / "topbar.py"

        preview = undo_preview(relocated)
        self.assertTrue(preview.ok, preview.to_dict())
        self.assertTrue(preview.data["dirty_since"])
        self.assertTrue(preview.data["published"])
        self.assertEqual(preview.data["ownership_work"], [ticket])
        reverted = undo_confirm(relocated, "tester", "CP-001", "Published design rejected")
        self.assertTrue(reverted.ok, reverted.to_dict())
        self.assertEqual(reverted.code, "FORWARD_REVERT_WORK_STARTED")
        self.assertEqual(relocated_path.read_text(encoding="utf-8"), "indicator = True\n")

    def test_exact_binary_restore_append_only_and_branch_sequence(self):
        project = self.make_project()
        payload = project / "data with space.bin"
        before_bytes = b"\x00\xffbefore\r\n"
        after_bytes = b"\x00\xfeafter\n"
        payload.write_bytes(before_bytes)
        cp1 = create_milestone(project, "tester", "Baseline", [payload.name])
        self.assertTrue(cp1.ok, cp1.to_dict())
        payload.write_bytes(after_bytes)
        cp2 = create_milestone(
            project,
            "tester",
            "Queue Scheduler",
            [payload.name],
            work_ids=["T-7"],
        )
        self.assertTrue(cp2.ok, cp2.to_dict())
        log_before = (project / ".saipen/LOG.md").read_bytes()
        preview = undo_preview(project)
        self.assertTrue(preview.ok, preview.to_dict())
        self.assertEqual(preview.data["target"]["id"], "CP-001")
        restored = undo_confirm(project, "tester", "CP-001", "Wrong scheduler interpretation")
        self.assertTrue(restored.ok, restored.to_dict())
        self.assertEqual(payload.read_bytes(), before_bytes)
        log_after = (project / ".saipen/LOG.md").read_bytes()
        self.assertEqual(log_after[: len(log_before)], log_before, (log_before, log_after))
        self.assertIn(b"reason: Wrong scheduler interpretation", log_after)
        self.assertEqual(milestone_status(project)["current"], "CP-001")
        replay = undo_confirm(project, "tester", "CP-001", "Wrong scheduler interpretation")
        self.assertEqual(replay.code, "ALREADY_APPLIED")
        payload.write_bytes(b"branch")
        cp3 = create_milestone(project, "tester", "Manual Queue", [payload.name])
        self.assertTrue(cp3.ok, cp3.to_dict())
        self.assertEqual(cp3.data["milestone"], "CP-003")
        self.assertEqual(cp3.data["parent"], "CP-001")
        self.assertEqual(validate_milestones(project), [])

    def test_foreign_overlap_refuses_without_touching_bytes(self):
        project = self.make_project()
        path = project / "settings.py"
        path.write_text("mode = 'manual'\n", encoding="utf-8")
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["settings.py"]).ok)
        path.write_text("mode = 'auto'\n", encoding="utf-8")
        self.assertTrue(create_milestone(project, "tester", "Auto Mode", ["settings.py"]).ok)
        path.write_text("user_edit = True\n", encoding="utf-8")
        before = _tree_digest(project)
        preview = undo_preview(project)
        self.assertFalse(preview.ok)
        self.assertEqual(preview.code, "CONFLICT")
        self.assertIn("settings.py", preview.data["foreign_paths"])
        self.assertEqual(before, _tree_digest(project))

    def test_deleted_and_new_files_restore(self):
        project = self.make_project()
        old = project / "old.txt"
        new = project / "new.txt"
        old.write_bytes(b"old\r\n")
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["old.txt", "new.txt"]).ok)
        old.unlink()
        new.write_bytes(b"new\n")
        self.assertTrue(
            create_milestone(project, "tester", "Replacement", ["old.txt", "new.txt"]).ok
        )
        result = undo_confirm(project, "tester", "CP-001", "Replacement was wrong")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(old.read_bytes(), b"old\r\n")
        self.assertFalse(new.exists())

    def test_corrupt_payload_and_path_escape_refuse(self):
        project = self.make_project()
        path = project / "x.txt"
        path.write_text("x", encoding="utf-8")
        created = create_milestone(project, "tester", "Baseline", ["x.txt"])
        self.assertTrue(created.ok)
        manifest = json.loads(
            (project / ".saipen/milestones/CP-001/manifest.json").read_text(encoding="utf-8")
        )
        digest = manifest["files"][0]["sha256"]
        (project / ".saipen/milestones/blobs" / digest).write_bytes(b"corrupt")
        errors = validate_milestones(project)
        self.assertTrue(any("payload hash mismatch" in error for error in errors))
        escaped = create_milestone(project, "tester", "Bad", ["../escape.txt"])
        self.assertFalse(escaped.ok)
        self.assertEqual(escaped.code, "INVALID_MANIFEST")
        absolute = create_milestone(project, "tester", "Bad", [str(path.resolve())])
        self.assertEqual(absolute.code, "INVALID_MANIFEST")

    def test_unicode_bom_crlf_and_parent_cycle(self):
        project = self.make_project()
        path = project / "Ülevaade space.txt"
        before = b"\xef\xbb\xbfline one\r\n"
        path.write_bytes(before)
        self.assertTrue(create_milestone(project, "tester", "Baseline", [path.name]).ok)
        path.write_bytes(b"\xef\xbb\xbfline two\n")
        self.assertTrue(create_milestone(project, "tester", "Unicode Edit", [path.name]).ok)
        self.assertTrue(undo_confirm(project, "tester", "CP-001", "Line ending rejected").ok)
        self.assertEqual(path.read_bytes(), before)

        manifest_path = project / ".saipen/milestones/CP-001/manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["parent"] = "CP-002"
        body = {key: value for key, value in manifest.items() if key != "integrity_hash"}
        raw = (json.dumps(body, sort_keys=True, ensure_ascii=False, indent=2) + "\n").encode()
        manifest["integrity_hash"] = hashlib.sha256(raw).hexdigest()
        manifest_path.write_text(
            json.dumps(manifest, sort_keys=True, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        self.assertTrue(
            any("parent cycle" in error for error in validate_milestones(project)),
        )

    def test_symlink_escape_and_external_effect_refuse(self):
        project = self.make_project()
        outside = project.parent / "outside.txt"
        outside.write_text("foreign", encoding="utf-8")
        link = project / "linked.txt"
        try:
            link.symlink_to(outside)
        except OSError:
            link = None
        if link is not None:
            escaped = create_milestone(project, "tester", "Bad Link", ["linked.txt"])
            self.assertEqual(escaped.code, "INVALID_MANIFEST")

        local = project / "local.txt"
        local.write_text("v1", encoding="utf-8")
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["local.txt"]).ok)
        local.write_text("v2", encoding="utf-8")
        self.assertTrue(
            create_milestone(
                project,
                "tester",
                "Published Message",
                ["local.txt"],
                external_effects=["message sent"],
            ).ok
        )
        before = _tree_digest(project)
        refused = undo_confirm(project, "tester", "CP-001", "Message was wrong")
        self.assertEqual(refused.code, "DESTRUCTIVE_CONFIRMATION_REQUIRED")
        self.assertEqual(before, _tree_digest(project))

    def test_no_milestones_and_missing_reason_are_read_only(self):
        project = self.make_project()
        before = _tree_digest(project)
        preview = undo_preview(project)
        self.assertFalse(preview.ok)
        _rc, payload = self.cli(project, "zz", "confirm", "CP-001")
        self.assertEqual(payload["code"], "DESTRUCTIVE_CONFIRMATION_REQUIRED")
        multiline = undo_confirm(project, "tester", "CP-001", "first\nsaipen clean")
        self.assertEqual(multiline.code, "DESTRUCTIVE_CONFIRMATION_REQUIRED")
        self.assertEqual(before, _tree_digest(project))

    def test_published_milestone_creates_forward_work_not_git_rewrite(self):
        project = self.make_project()
        path = project / "published.txt"
        path.write_text("v1", encoding="utf-8")
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["published.txt"]).ok)
        path.write_text("v2", encoding="utf-8")
        self.assertTrue(
            create_milestone(
                project, "tester", "Published Feature", ["published.txt"], published=True
            ).ok
        )
        result = undo_confirm(project, "tester", "CP-001", "Published design rejected")
        self.assertTrue(result.ok, result.to_dict())
        self.assertEqual(result.code, "FORWARD_REVERT_WORK_STARTED")
        self.assertEqual(path.read_text(encoding="utf-8"), "v2")
        self.assertEqual(parse_state((project / ".saipen/STATE.md").read_text())["phase"], "SCOUT")

    def test_crashed_milestone_is_not_selectable_and_recovers(self):
        project = self.make_project()
        path = project / "queue.bin"
        path.write_bytes(b"v1\x00")
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["queue.bin"]).ok)
        path.write_bytes(b"v2\x00")
        script = (
            "import sys; "
            f"sys.path.insert(0, {str(TOOLS)!r}); "
            "from saipen_engine.controls import create_milestone; "
            f"create_milestone({str(project)!r}, 'tester', 'Queue Timer', ['queue.bin'])"
        )
        proc = subprocess.run(
            [sys.executable, "-c", script],
            env={**os.environ, "NITRO_CRASH_AFTER_LOG": "1"},
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 87, proc.stderr)
        preview = undo_preview(project)
        self.assertEqual(preview.code, "RECOVERY_REQUIRED")
        self.assertFalse(milestone_status(project)["valid"])
        recovered = auto_recover_pending(project)
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(validate_milestones(project), [])
        self.assertEqual(milestone_status(project)["current"], "CP-002")

    def test_crashed_restore_recovers_exact_delete_and_log(self):
        project = self.make_project()
        path = project / "new.bin"
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["new.bin"]).ok)
        path.write_bytes(b"created\x00")
        self.assertTrue(create_milestone(project, "tester", "New Binary", ["new.bin"]).ok)
        script = (
            "import sys; "
            f"sys.path.insert(0, {str(TOOLS)!r}); "
            "from saipen_engine.controls import undo_confirm; "
            f"undo_confirm({str(project)!r}, 'tester', 'CP-001', 'Binary was wrong')"
        )
        proc = subprocess.run(
            [sys.executable, "-c", script],
            env={**os.environ, "NITRO_CRASH_AFTER_DELETE_FILE": "1"},
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 87, proc.stderr)
        self.assertFalse(path.exists())
        self.assertEqual(undo_preview(project).code, "RECOVERY_REQUIRED")
        recovered = auto_recover_pending(project)
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(milestone_status(project)["current"], "CP-001")
        self.assertEqual(validate_milestones(project), [])
        self.assertIn("reason: Binary was wrong", (project / ".saipen/LOG.md").read_text())

    def test_blob_dedup_status_is_metadata_only_and_git_index_untouched(self):
        project = self.make_project()
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        subprocess.run(["git", "-C", str(project), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(project),
                "-c",
                "user.name=SAIPEN Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        payload = project / "large.bin"
        payload.write_bytes(b"same" * 262_144)
        index_before = subprocess.run(
            ["git", "-C", str(project), "diff", "--cached", "--binary"],
            capture_output=True,
            check=True,
        ).stdout
        self.assertTrue(create_milestone(project, "tester", "One", ["large.bin"]).ok)
        self.assertTrue(create_milestone(project, "tester", "Two", ["large.bin"]).ok)
        blobs = [
            path
            for path in (project / ".saipen/milestones/blobs").iterdir()
            if re.fullmatch(r"[0-9a-f]{64}", path.name)
        ]
        self.assertEqual(len(blobs), 1)

        original_read_bytes = Path.read_bytes

        def guarded_read_bytes(path: Path) -> bytes:
            if path.parent.name == "blobs":
                raise AssertionError("status hashed milestone payload")
            return original_read_bytes(path)

        with mock.patch.object(Path, "read_bytes", guarded_read_bytes):
            self.assertEqual(milestone_status(project)["current"], "CP-002")
        human = subprocess.run(
            [
                sys.executable,
                str(SAIPEN_PY),
                "--project-root",
                str(project),
                "status",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"},
            timeout=60,
        )
        self.assertEqual(human.returncode, 0, human.stdout + human.stderr)
        self.assertIn("CHECKPOINT: CP-002", human.stdout)
        self.assertIn("PARENT: CP-001", human.stdout)
        index_after = subprocess.run(
            ["git", "-C", str(project), "diff", "--cached", "--binary"],
            capture_output=True,
            check=True,
        ).stdout
        self.assertEqual(index_after, index_before)


class IntegratedAcceptanceTests(ControlFixture):
    def test_focus_build_focus_cut_cancel_then_cold_undo(self):
        project = self.make_project()
        topbar = project / "topbar.py"
        queue = project / "queue.py"
        topbar.write_text("timer_indicator = False\n", encoding="utf-8")
        queue.write_text("class QueueMode:\n    manual = True\n", encoding="utf-8")

        before_focus = _tree_digest(project)
        focused = focus_projection(project, "queue mode/topbar/performance")
        self.assertTrue(focused.ok)
        self.assertEqual(before_focus, _tree_digest(project))
        self.assertTrue(create_milestone(project, "tester", "Baseline", ["topbar.py"]).ok)

        started = directive_entry(
            project,
            "tester",
            "queue timer indicator in topbar",
            kind="build",
        )
        ticket = started.data["ticket"]
        self.assertTrue(transition_phase(project, "BUILD", "tester", ticket, "native fit").ok)
        topbar.write_text("timer_indicator = True\n", encoding="utf-8")
        self.assertTrue(
            attempt_lifecycle(
                project,
                "tester",
                "close",
                result="candidate",
                stop="completed_execution",
            ).ok
        )
        self.assertTrue(transition_phase(project, "VERIFY", "tester", ticket, "verify").ok)
        self.assertTrue(
            checkpoint(project, "tester", "RUN", ticket, "acceptance -> PASS conf: high").ok
        )
        self.assertTrue(transition_phase(project, "REVIEW", "tester", ticket, "review").ok)
        self.assertTrue(record_scope(project, ticket, "tester", ["topbar.py"]).ok)
        self.assertTrue(transition_phase(project, "SHIP", "tester", ticket, "ship").ok)
        self.assertTrue(finish_ticket(project, ticket, "tester").ok)
        feature_cp = create_milestone(
            project,
            "tester",
            "Queue Timer",
            ["topbar.py"],
            work_ids=[ticket],
        )
        self.assertEqual(feature_cp.data["milestone"], "CP-002")

        after_build = focus_projection(project, "topbar")
        self.assertTrue(
            any(match["path"] == "topbar.py" for match in after_build.data["exact_matches"])
        )
        before_cut = _tree_digest(project)
        cut, _cut_plan = _resolved_cut(
            project,
            "queue timer indicator",
            affected=["topbar.py"],
            resolved="queue timer indicator",
        )
        self.assertEqual(cut.code, "CUT_PREVIEW")
        self.assertEqual(before_cut, _tree_digest(project))

        rc_preview, cold_preview = self.cli(project, "zz")
        self.assertEqual((rc_preview, cold_preview["code"]), (0, "UNDO_PREVIEW"))
        self.assertEqual(cold_preview["target"]["id"], "CP-001")
        self.assertEqual(before_cut, _tree_digest(project))
        rc_restore, restored = self.cli(
            project,
            "zz",
            "confirm",
            "CP-001",
            "--reason",
            "Timer interpretation was wrong",
        )
        self.assertEqual((rc_restore, restored["code"]), (0, "RESTORED"))
        self.assertEqual(topbar.read_text(encoding="utf-8"), "timer_indicator = False\n")
        self.assertEqual(
            queue.read_text(encoding="utf-8"),
            "class QueueMode:\n    manual = True\n",
        )
        rc_status, cold_status = self.cli(project, "status")
        self.assertEqual(rc_status, 0)
        self.assertEqual(cold_status["milestone"]["current"], "CP-001")
        self.assertEqual(validate_milestones(project), [])
        self.assertEqual(parse_state((project / ".saipen/STATE.md").read_text())["phase"], "DONE")


class CliClassifierTests(ControlFixture):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("saipen_cli_controls", SAIPEN_PY)
        cls.cli_module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(cls.cli_module)

    def test_mutation_classifier(self):
        mutates = self.cli_module._command_mutates
        self.assertFalse(mutates("focus", ["sidebar"]))
        self.assertFalse(mutates("ff", []))
        self.assertFalse(mutates("cut", ["sidebar"]))
        self.assertTrue(mutates("xx", ["confirm", "CUT-X", "--", "encoded-plan"]))
        self.assertTrue(mutates("build", ["tray"]))
        self.assertTrue(mutates("vv", ["clean"]))
        self.assertFalse(mutates("undo", []))
        self.assertTrue(mutates("zz", ["confirm", "CP-1", "--reason", "x"]))
        self.assertFalse(mutates("xx", ["confirm"]))
        self.assertFalse(mutates("xx", ["confirm", "CUT-X"]))
        self.assertFalse(mutates("zz", ["confirm", "CP-1"]))
        self.assertFalse(mutates("vv", []))

    def test_aliases_route_and_payload_clean_is_opaque(self):
        project = self.make_project()
        rc, focus = self.cli(project, "ff", "sidebar")
        self.assertEqual((rc, focus["route"], focus["code"]), (0, "ff", "FOCUS_CONTEXT"))
        rc2, build = self.cli(project, "--dry-run", "vv", "clean")
        self.assertEqual((rc2, build["route"]), (0, "vv"))
        self.assertEqual(build["directive"], "clean")
        self.assertEqual(build["phase"], "SCOUT")
        rc3, twin = self.cli(project, "хх", "old feature")  # noqa: RUF001
        self.assertEqual(
            (rc3, twin["route"], twin["code"]),
            (0, "xx", "CUT_ANALYSIS_REQUIRED"),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
