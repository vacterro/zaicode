"""T-1279 regression tests: a capability with nothing to apply to.

The roster was static. `CrewRole.ensure_instance` was a bool, `crew.py`
iterated it, and no code path could express that a project has no UI -- so a
mandatory UI stage ran against a surface that does not exist, eleven times,
and each honest empty package became a Core review ticket.

Proven here:
- the applicability decision is a pure function of deterministic project facts;
- every undecidable input -- no facts, an unreadable tree, an unknown probe
  name -- resolves APPLICABLE, so the model fails toward doing the work;
- a NOT_APPLICABLE role satisfies its crew stage through a receipt that NAMES
  the deciding fact and carries no action;
- the probe is NOT vacuous: on a tree that does contain a visual file the same
  role is APPLICABLE again and its stage goes back to demanding evidence;
- the desktop-UI case is covered by import, not only by extension, so a Tk or
  Qt application is not invisible because its files end in `.py`.

Run standalone:
    python tools/test_crew_applicability.py

Exit code 0 when every test passes.
"""

from __future__ import annotations

import re
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import applicability as A  # noqa: E402
from saipen_engine import crew as C  # noqa: E402
from saipen_engine import subs as S  # noqa: E402

REPO = TOOLS.parent

STATE = (
    '---\nphase: DONE\ntask: none\nnext_action: "saipen continue"\n'
    'blocker: ""\ntransition_from: SHIP\nsaipen_version: 7\n'
    'schema_version: 3\nstyle_contract: ded-probe\nsaipen_home: "{home}"\n'
    'agent: probe\nmode: full\nupdated: "2026-09-03T00:00:00Z"\n---\n'
)
BOARD = "# Board\n\n## DOING\n\n## TODO\n\n## DONE\n\n## BLOCKED\n"


FULL_ROSTER = ("saihunt", "saitest", "saipython", "saiui", "saiwiki")


def _seed(root: Path, roles=FULL_ROSTER) -> None:
    """The same minimal crew-capable project the scenario harness seeds."""
    saipen = root / ".saipen"
    (saipen / "extensions").mkdir(parents=True, exist_ok=True)
    (saipen / "STATE.md").write_text(STATE.format(home=REPO.as_posix()), encoding="utf-8")
    (saipen / "LOG.md").write_text("# Log\n", encoding="utf-8")
    (saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")
    for name in roles:
        result = S.sub_spawn(root, name, REPO.as_posix())
        if not result.ok:
            raise AssertionError(f"fixture spawn {name} failed: {result.to_json()}")


def _stage(plan: dict, stage_id: str) -> dict:
    for stage in plan.get("stages", ()):
        if stage.get("stage") == stage_id:
            return stage
    present = [s.get("stage") for s in plan.get("stages", ())]
    raise AssertionError(f"{stage_id} absent from plan stages {present}")


# ---------------------------------------------------------------------------
# The pure decision. No filesystem below this point.
# ---------------------------------------------------------------------------


class VerdictTests(unittest.TestCase):
    def test_always_probe_is_applicable_and_says_why(self):
        state, reason = A.verdict(A.ALWAYS, A.ProjectFacts(scanned=10))
        self.assertEqual(state, A.APPLICABLE)
        self.assertTrue(reason)

    def test_empty_visual_surface_is_not_applicable_and_names_the_count(self):
        state, reason = A.verdict(A.VISUAL_SURFACE, A.ProjectFacts(scanned=4953))
        self.assertEqual(state, A.NOT_APPLICABLE)
        self.assertIn("4953", reason)
        self.assertIn("no visual implementation file", reason)

    def test_one_visual_file_flips_the_verdict_and_names_it(self):
        facts = A.ProjectFacts(visual_paths=("web/app.css",), scanned=4954)
        state, reason = A.verdict(A.VISUAL_SURFACE, facts)
        self.assertEqual(state, A.APPLICABLE)
        self.assertIn("web/app.css", reason)

    def test_a_desktop_toolkit_import_alone_is_a_visual_surface(self):
        facts = A.ProjectFacts(gui_module_paths=("app/window.py",), scanned=12)
        self.assertEqual(A.verdict(A.VISUAL_SURFACE, facts)[0], A.APPLICABLE)

    def test_every_reason_is_non_empty_for_every_probe_and_both_answers(self):
        for probe in (*A.PROBES, "a-probe-nobody-registered"):
            for facts in (A.ProjectFacts(scanned=1), A.ProjectFacts(visual_paths=("a.css",))):
                _state, reason = A.verdict(probe, facts)
                self.assertTrue(reason.strip(), f"empty reason for {probe}")

    def test_evidence_sample_is_bounded(self):
        facts = A.ProjectFacts(visual_paths=tuple(f"p{i}.css" for i in range(50)))
        self.assertEqual(len(facts.visual_evidence()), 3)


class FailClosedTests(unittest.TestCase):
    """Undecidable is APPLICABLE. A capability is never retired by silence."""

    def test_absent_facts_are_applicable(self):
        state, reason = A.verdict(A.VISUAL_SURFACE, None)
        self.assertEqual(state, A.APPLICABLE)
        self.assertIn("fails closed", reason)

    def test_unreadable_tree_is_applicable_and_carries_the_reason(self):
        facts = A.ProjectFacts(readable=False, unreadable_reason="tree walk failed: boom")
        state, reason = A.verdict(A.VISUAL_SURFACE, facts)
        self.assertEqual(state, A.APPLICABLE)
        self.assertIn("boom", reason)

    def test_unknown_probe_name_is_applicable_and_names_itself(self):
        state, reason = A.verdict("visual-surfaec", A.ProjectFacts(scanned=3))
        self.assertEqual(state, A.APPLICABLE)
        self.assertIn("visual-surfaec", reason)

    def test_no_constant_answer_satisfies_the_suite(self):
        """Red control: neither verdict can be hardcoded and still pass.

        A probe that always answered APPLICABLE would never skip anything and
        the empty-surface case fails; one that always answered NOT_APPLICABLE
        would retire a real capability and every fail-closed case fails.
        """
        empty = A.verdict(A.VISUAL_SURFACE, A.ProjectFacts(scanned=9))[0]
        present = A.verdict(A.VISUAL_SURFACE, A.ProjectFacts(visual_paths=("x.vue",)))[0]
        unknown = A.verdict(A.VISUAL_SURFACE, None)[0]
        self.assertEqual(empty, A.NOT_APPLICABLE)
        self.assertEqual(present, A.APPLICABLE)
        self.assertEqual(unknown, A.APPLICABLE)
        self.assertNotEqual(empty, present)


# ---------------------------------------------------------------------------
# Fact collection against a real tree.
# ---------------------------------------------------------------------------


class CollectFactsTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_a_tree_with_no_visual_file_reports_none(self):
        (self.root / "tool.py").write_text("import json\n", encoding="utf-8")
        facts = A.collect_facts(self.root)
        self.assertTrue(facts.readable)
        self.assertFalse(facts.visual_surface)

    def test_a_stylesheet_is_found_by_extension(self):
        (self.root / "site").mkdir()
        (self.root / "site" / "main.css").write_text("body{}\n", encoding="utf-8")
        self.assertTrue(A.collect_facts(self.root).visual_surface)

    def test_a_tk_application_is_found_by_import(self):
        (self.root / "gui.py").write_text("import tkinter as tk\n", encoding="utf-8")
        facts = A.collect_facts(self.root)
        self.assertTrue(facts.visual_surface)
        self.assertIn("gui.py", facts.gui_module_paths)

    def test_saipen_memory_never_counts_as_the_project_gaining_a_ui(self):
        """A producer's staged page under `.saipen/` is not a project surface.

        Same reason PROTOCOL.md section 6 excludes `.saipen/` from the source
        fingerprint: a worker's own kitchen is not the project.
        """
        staged = self.root / ".saipen" / "extensions" / "subs" / "saiwiki" / "kitchen"
        staged.mkdir(parents=True)
        (staged / "Home.html").write_text("<p>x</p>\n", encoding="utf-8")
        self.assertFalse(A.collect_facts(self.root).visual_surface)

    def test_this_repository_has_no_visual_surface(self):
        facts = A.collect_facts(REPO)
        self.assertTrue(facts.readable)
        self.assertGreater(facts.scanned, 100)
        self.assertFalse(
            facts.visual_surface,
            f"unexpected visual surface: {facts.visual_evidence()}",
        )


# ---------------------------------------------------------------------------
# The crew stage receipt.
# ---------------------------------------------------------------------------


class CrewStageTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "proj"
        self.root.mkdir()
        _seed(self.root)

    def test_a_non_applicable_role_is_dropped_from_the_applicable_set(self):
        snapshot = C.crew_snapshot(self.root)
        names = {role.name for role in C.applicable_roles(snapshot)}
        self.assertNotIn("saiui", names)
        for still_here in ("saihunt", "saitest", "saipython", "saiwiki", "saitranslate"):
            self.assertIn(still_here, names)

    def test_the_stage_is_satisfied_by_a_receipt_naming_the_deciding_fact(self):
        stage = _stage(C.crew_plan(self.root), "SC-5")
        self.assertTrue(stage["satisfied"], stage)
        self.assertIsNone(stage["action"], stage)
        self.assertTrue(stage["reason"].startswith("NOT_APPLICABLE -- "), stage["reason"])
        self.assertIn("no visual implementation file", stage["reason"])

    def test_a_visual_file_puts_the_stage_back_to_demanding_evidence(self):
        """Positive control: the skip cannot go vacuous.

        Without this, a probe that had silently broken into always answering
        NOT_APPLICABLE would pass every other test in this file. Note what is
        asserted: the stage stops carrying the receipt and saiui rejoins the
        applicable set. It is NOT asserted to be actionable here, because in
        this fixture SC-2 is still unsatisfied and an ordinary evidence-bearing
        stage behind a blocker correctly reports WAITING -- which is the very
        distinction the receipt exists to make.
        """
        (self.root / "app").mkdir()
        (self.root / "app" / "main.css").write_text("body{color:#000}\n", encoding="utf-8")
        snapshot = C.crew_snapshot(self.root)
        self.assertIn("saiui", {role.name for role in C.applicable_roles(snapshot)})
        stage = _stage(C.crew_plan(self.root), "SC-5")
        self.assertNotIn("NOT_APPLICABLE", stage["reason"] or "")
        self.assertFalse(stage["satisfied"], stage)

    def test_the_other_sensor_stages_are_untouched(self):
        plan = C.crew_plan(self.root)
        for stage_id in ("SC-2", "SC-3", "SC-4"):
            stage = _stage(plan, stage_id)
            self.assertNotIn("NOT_APPLICABLE", stage["reason"] or "")

    def test_a_role_with_no_applicability_declared_defaults_to_always(self):
        for role in S.CREW_ROLES:
            if role.name == "saiui":
                self.assertEqual(role.applicability, A.VISUAL_SURFACE)
            else:
                self.assertEqual(role.applicability, A.ALWAYS)

    def test_every_declared_probe_is_a_registered_one(self):
        for role in S.CREW_ROLES:
            self.assertIn(role.applicability, A.PROBES, role.name)


class HotPathCostTests(unittest.TestCase):
    """`crew_snapshot` is on the cc/sc/status path; the walk is not free.

    A Git subprocess plus a bounded read of every module, spent to answer a
    question no role asked, is the cost T-1019 counts. Skipping it changes
    timing and never a verdict: None resolves APPLICABLE for every probe,
    which is what an all-`always` roster would have answered anyway.
    """

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_an_all_always_roster_collects_nothing(self):
        plain = tuple(
            replace(role, applicability=A.ALWAYS) for role in S.CREW_ROLES
        )
        with mock.patch.object(C, "CREW_ROLES", plain):
            self.assertIsNone(C._project_facts(self.root))

    def test_one_conditional_role_is_enough_to_collect(self):
        self.assertTrue(
            any(role.applicability != A.ALWAYS for role in S.CREW_ROLES),
            "fixture assumption: the live registry has a conditional role",
        )
        facts = C._project_facts(self.root)
        self.assertIsNotNone(facts)
        self.assertTrue(facts.readable)

    def test_skipping_collection_does_not_change_any_verdict(self):
        """The optimisation is verdict-preserving, which is the whole licence."""
        plain = tuple(replace(role, applicability=A.ALWAYS) for role in S.CREW_ROLES)
        collected = A.collect_facts(self.root)
        for role in plain:
            self.assertEqual(
                A.verdict(role.applicability, None)[0],
                A.verdict(role.applicability, collected)[0],
                role.name,
            )


class RosterStageTests(unittest.TestCase):
    """SC-1: an instance is machinery for producing evidence.

    A role with nothing to produce evidence ABOUT does not need one spawned,
    registered in the manifest or re-adopted on every charter revision. Without
    this the applicability model would still save the model run and then demand
    the instance anyway, which is the ceremony half of the same cost.
    """

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "proj"
        self.root.mkdir()

    def test_a_missing_non_applicable_instance_is_not_demanded(self):
        _seed(self.root, roles=("saihunt", "saitest", "saipython", "saiwiki"))
        stage = _stage(C.crew_plan(self.root), "SC-1")
        self.assertNotIn("saiui", stage["reason"] or "")
        action = stage["action"] or {}
        self.assertNotEqual(action.get("role"), "saiui", stage)

    def test_the_same_missing_instance_IS_demanded_once_a_ui_exists(self):
        """Positive control for SC-1: the roster skip is conditional, not gone."""
        _seed(self.root, roles=("saihunt", "saitest", "saipython", "saiwiki"))
        (self.root / "ui").mkdir()
        (self.root / "ui" / "panel.svelte").write_text("<div/>\n", encoding="utf-8")
        stage = _stage(C.crew_plan(self.root), "SC-1")
        self.assertFalse(stage["satisfied"], stage)
        self.assertIn("saiui", stage["reason"] or "")
        self.assertEqual((stage["action"] or {}).get("role"), "saiui", stage)

    def test_a_missing_applicable_instance_is_still_demanded(self):
        _seed(self.root, roles=("saitest", "saipython", "saiui", "saiwiki"))
        stage = _stage(C.crew_plan(self.root), "SC-1")
        self.assertFalse(stage["satisfied"], stage)
        self.assertIn("saihunt", stage["reason"] or "")


class GrammarAwareImportTests(unittest.TestCase):
    """SRC-019:R3 -- "the probe found nothing" is not "the project has no UI".

    The first probe was a line regex anchored to the FIRST module token after
    `import`, so `import os, tkinter as tk` -- valid Python naming a toolkit the
    probe advertises -- answered exactly like a project with no interface, and a
    module the probe could not open or finish reading answered that way too. A
    false NOT_APPLICABLE retires a mandatory audit role, which is the one
    direction the applicability model promised never to fail in.

    Proven here: every valid import form for the declared toolkit set is found,
    a candidate that cannot be decided resolves APPLICABLE and says why, and a
    fully inspected plain project still reports NOT_APPLICABLE so the fix did
    not simply disable the skip.
    """

    #: Valid Python the pre-fix first-token regex could not see.
    COMMA_FORMS = (
        "import os, tkinter as tk\n",
        "import sys, PySide6.QtWidgets as QtWidgets\n",
    )

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def _verdict(self) -> tuple[str, str]:
        return A.verdict(A.VISUAL_SURFACE, A.collect_facts(self.root))

    def _write(self, name: str, source: str) -> None:
        (self.root / name).write_text(source, encoding="utf-8")

    def test_a_comma_separated_toolkit_import_is_a_visual_surface(self):
        for index, source in enumerate(self.COMMA_FORMS):
            with self.subTest(source=source):
                self._write(f"app{index}.py", source)
                facts = A.collect_facts(self.root)
                self.assertIn(f"app{index}.py", facts.gui_module_paths)
                self.assertEqual(A.verdict(A.VISUAL_SURFACE, facts)[0], A.APPLICABLE)
                (self.root / f"app{index}.py").unlink()

    def test_every_valid_import_form_for_the_declared_set_is_found(self):
        forms = {
            "from_submodule.py": "from PyQt6.QtWidgets import QWidget\n",
            "parenthesized.py": "from kivy.app import (App,)\n",
            "aliased_root.py": "import wx as wxpython\n",
            "inside_a_function.py": "import json\n\n\ndef run():\n    import textual\n",
            "conditional.py": "import os\nif os.name:\n    import tkinter\n",
            "dotted_from.py": "from gi.repository import Gtk\n",
        }
        for name, source in forms.items():
            with self.subTest(name=name):
                self._write(name, source)
                facts = A.collect_facts(self.root)
                self.assertIn(name, facts.gui_module_paths, facts)
                (self.root / name).unlink()

    def test_a_fully_inspected_plain_project_is_still_not_applicable(self):
        self._write("tool.py", "import json, os\nfrom pathlib import Path\n")
        self._write("notes.md", "# no ui here\n")
        state, reason = self._verdict()
        self.assertEqual(state, A.NOT_APPLICABLE)
        self.assertIn("no visual implementation file", reason)

    def test_a_relative_import_is_not_a_toolkit_import(self):
        self._write("pkg.py", "from . import gi\n")
        self.assertEqual(self._verdict()[0], A.NOT_APPLICABLE)

    def test_an_unparseable_candidate_is_uncertainty_not_a_negative(self):
        self._write("broken.py", "import tkinter\ndef (:\n")
        state, reason = self._verdict()
        self.assertEqual(state, A.APPLICABLE)
        self.assertIn("could not be proven free", reason)
        self.assertIn("broken.py", reason)

    def test_an_unreadable_candidate_is_uncertainty_not_a_negative(self):
        state, detail = A._probe_gui_imports(self.root / "gone.py")
        self.assertEqual(state, A._INDETERMINATE)
        self.assertIn("unreadable", detail)

    def test_exceeding_the_parse_window_is_uncertainty_not_a_negative(self):
        self._write("big.py", "import json\n" * 40)
        with mock.patch.object(A, "PARSE_LIMIT_BYTES", 16):
            state, reason = self._verdict()
        self.assertEqual(state, A.APPLICABLE)
        self.assertIn("parse window", reason)

    def test_a_visual_extension_positive_is_unaffected_by_uncertainty(self):
        self._write("broken.py", "import tkinter\ndef (:\n")
        (self.root / "page.css").write_text("body{}\n", encoding="utf-8")
        state, reason = self._verdict()
        self.assertEqual(state, A.APPLICABLE)
        self.assertIn("page.css", reason)

    def test_no_narrow_probe_satisfies_this_class(self):
        """Red control: the pre-fix first-token regex is red on these inputs.

        Pinned as the defect itself rather than as advice, so reverting to any
        probe that reads only the first imported name of a line fails here, and
        a probe that answered APPLICABLE unconditionally fails the plain-project
        case above.
        """
        narrow = re.compile(
            rb"^[ \t]*(?:from|import)[ \t]+"
            rb"(tkinter|PyQt[456]|PySide[26]|textual|wx|kivy|gi)\b",
            re.MULTILINE,
        )
        for source in self.COMMA_FORMS:
            with self.subTest(source=source):
                self.assertIsNone(
                    narrow.search(source.encode("utf-8")),
                    "fixture assumption: the pre-fix probe missed this form",
                )
                self._write("case.py", source)
                self.assertEqual(
                    A.collect_facts(self.root).gui_module_paths, ("case.py",)
                )
                (self.root / "case.py").unlink()


class SnapshotStabilityBarrierTests(unittest.TestCase):
    """SRC-019:R2 -- applicability facts must come from the observation the
    snapshot's source identity names.

    `crew_snapshot` used to close its stability decision and only then collect
    project facts, so the object could bind source identity and `stable=True`
    from tree state A while its applicability facts came from tree state B. The
    auditor reproduced it by creating an untracked `late.css` between the two
    reads: the snapshot reported `stable=True` with a visual surface that the
    stable source identity did not contain. Applicability decides whether a
    mandatory audit role runs at all, so the same race in the negative direction
    silently skips it.
    """

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "proj"
        self.root.mkdir()
        _seed(self.root, roles=("saihunt", "saitest", "saipython", "saiwiki"))

    def _racing_facts(self, mutate):
        """`_project_facts` that mutates the tree the moment it is called."""

        def collect(root):
            mutate(Path(root))
            return A.collect_facts(root)

        return collect

    def test_a_source_change_while_facts_are_collected_makes_the_snapshot_unstable(self):
        def mutate(root: Path) -> None:
            (root / "late.css").write_text("body{}\n", encoding="utf-8")

        with mock.patch.object(C, "_project_facts", self._racing_facts(mutate)):
            snapshot = C.crew_snapshot(self.root)
        self.assertTrue(snapshot.project_facts.visual_surface, "fixture: the race did happen")
        self.assertFalse(
            snapshot.stable,
            "a snapshot whose facts came from a later tree state claimed stability",
        )
        self.assertFalse(snapshot.facts_source_bound)

    def test_an_unbound_observation_cannot_retire_a_role(self):
        """The removal direction: losing the deciding file must not authorize a skip."""
        (self.root / "panel.svelte").write_text("<div/>\n", encoding="utf-8")

        def mutate(root: Path) -> None:
            (root / "panel.svelte").unlink()

        with mock.patch.object(C, "_project_facts", self._racing_facts(mutate)):
            snapshot = C.crew_snapshot(self.root)
        self.assertFalse(snapshot.project_facts.visual_surface, "fixture: the race did happen")
        self.assertFalse(snapshot.facts_source_bound)
        role = next(r for r in S.CREW_ROLES if r.applicability == A.VISUAL_SURFACE)
        state, reason = C._role_applicability(snapshot, role)
        self.assertEqual(state, A.APPLICABLE)
        self.assertIn("source changed", reason)
        self.assertIn(role.name, [r.name for r in C.applicable_roles(snapshot)])

    def test_a_python_gui_import_change_in_the_window_is_caught_too(self):
        """The import path reads file CONTENTS, not only names."""

        def mutate(root: Path) -> None:
            (root / "window.py").write_text("import tkinter\n", encoding="utf-8")

        with mock.patch.object(C, "_project_facts", self._racing_facts(mutate)):
            snapshot = C.crew_snapshot(self.root)
        self.assertFalse(snapshot.facts_source_bound)
        self.assertFalse(snapshot.stable)

    def test_a_quiet_tree_still_retires_the_role_and_stays_stable(self):
        """Positive control: the barrier did not simply disable the skip."""
        snapshot = C.crew_snapshot(self.root)
        self.assertTrue(snapshot.facts_source_bound, snapshot.source_error)
        role = next(r for r in S.CREW_ROLES if r.applicability == A.VISUAL_SURFACE)
        self.assertEqual(C._role_applicability(snapshot, role)[0], A.NOT_APPLICABLE)
        self.assertNotIn(role.name, [r.name for r in C.applicable_roles(snapshot)])


class FrozenApplicabilityManifestTests(unittest.TestCase):
    """SRC-019:R1 (CORE-001) -- post-ship certification is a HISTORICAL claim.

    The release receipt stored which roles produced evidence but never which
    roles were REQUIRED to. `_post_ship` recomputed applicability from today's
    tree, so the certified role set was a live read against an immutable
    receipt: delete the last UI file after the ship and the shipped release
    certifies without the visual audit; add one and a shipped release turns
    uncertifiable for a role that had nothing to audit at ship time.
    """

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name) / "proj"
        self.root.mkdir()
        _seed(self.root)
        self.snapshot = C.crew_snapshot(self.root)
        self.ui_role = next(r for r in S.CREW_ROLES if r.applicability == A.VISUAL_SURFACE)

    def _receipt(
        self,
        manifest,
        evidence=None,
        source_head="HEADSHA",
        source_tree_fingerprint="FPR",
    ):
        """A release receipt carrying exactly the claims under test."""
        if evidence is None:
            evidence = {
                role.name: [{"package_identity": "p"}]
                for role in S.CREW_ROLES
                if manifest.get(role.name, {}).get("verdict") != A.NOT_APPLICABLE
            }
        return C.ReleaseEvidence(
            op_id="OP-1",
            ticket="T-1",
            tag="v0.0.1",
            source_head=source_head,
            closure_commit="CLOSURE",
            created_at="2026-09-04T00:00:00Z",
            stages=("REMOTE_VERIFIED",),
            pre_ship_evidence=evidence,
            source_tree_fingerprint=source_tree_fingerprint,
            pre_ship_applicability=manifest,
        )

    def _manifest(self, source_head="HEADSHA", **verdicts):
        out = {}
        for role in S.CREW_ROLES:
            state = verdicts.get(role.name, A.APPLICABLE)
            out[role.name] = {
                "probe": getattr(role, "applicability", A.ALWAYS),
                "verdict": state,
                "reason": "fixture reason",
                "source_head": source_head,
                "source_tree_fingerprint": "FPR",
            }
        return out

    def test_the_captured_manifest_names_every_role_and_its_deciding_fact(self):
        manifest = C._pre_ship_applicability(self.snapshot)
        self.assertEqual(set(manifest), {role.name for role in S.CREW_ROLES})
        entry = manifest[self.ui_role.name]
        self.assertEqual(entry["verdict"], A.NOT_APPLICABLE)
        self.assertTrue(entry["reason"], "a retired role without a reason is not evidence")
        self.assertEqual(entry["source_head"], self.snapshot.source_id.source_head)

    def test_post_ship_certification_reads_the_frozen_verdict_not_todays_tree(self):
        """The whole bug: a UI file added AFTER the ship must not change history."""
        manifest = self._manifest(**{self.ui_role.name: A.NOT_APPLICABLE})
        receipt = self._receipt(manifest)
        (self.root / "late.svelte").write_text("<div/>\n", encoding="utf-8")
        live = C.crew_snapshot(self.root)
        self.assertTrue(live.project_facts.visual_surface, "fixture: the tree changed")
        self.assertIn(
            self.ui_role.name,
            [r.name for r in C.applicable_roles(live)],
            "fixture: the LIVE set now demands the role",
        )
        certified = [r.name for r in C._certified_roles(replace(live, release=receipt))]
        self.assertNotIn(self.ui_role.name, certified)
        self.assertEqual(C._missing_pre_ship_evidence(receipt), "")

    def test_a_role_the_manifest_calls_applicable_must_still_carry_evidence(self):
        manifest = self._manifest()
        evidence = {
            role.name: [{"package_identity": "p"}]
            for role in S.CREW_ROLES
            if role.name != self.ui_role.name
        }
        problem = C._missing_pre_ship_evidence(self._receipt(manifest, evidence))
        self.assertIn("lacks pre-ship crew evidence", problem)
        self.assertIn(self.ui_role.name, problem)

    def test_a_verdict_bound_to_another_source_cannot_certify_this_release(self):
        manifest = self._manifest(source_head="SOMEONE-ELSE")
        problem = C._missing_pre_ship_evidence(self._receipt(manifest))
        self.assertIn("different source", problem)

    def test_a_verdict_bound_to_another_tree_at_the_same_head_cannot_certify(self):
        manifest = self._manifest()
        problem = C._missing_pre_ship_evidence(
            self._receipt(manifest, source_tree_fingerprint="OTHER-FPR")
        )
        self.assertIn("different source tree", problem)

    def test_evidence_for_a_role_the_manifest_retired_is_a_contradiction(self):
        manifest = self._manifest(**{self.ui_role.name: A.NOT_APPLICABLE})
        evidence = {role.name: [{"package_identity": "p"}] for role in S.CREW_ROLES}
        problem = C._missing_pre_ship_evidence(self._receipt(manifest, evidence))
        self.assertIn("applicability manifest retired", problem)
        self.assertIn(self.ui_role.name, problem)

    def test_a_malformed_manifest_is_refused_rather_than_read_as_a_legacy_receipt(self):
        for damage in ("drop", "blank_verdict", "no_reason"):
            with self.subTest(damage=damage):
                manifest = self._manifest()
                if damage == "drop":
                    del manifest[self.ui_role.name]
                elif damage == "blank_verdict":
                    manifest[self.ui_role.name]["verdict"] = "MAYBE"
                else:
                    manifest[self.ui_role.name]["reason"] = ""
                problem = C._missing_pre_ship_evidence(self._receipt(manifest))
                self.assertIn("applicability manifest", problem)
                self.assertIn(self.ui_role.name, problem)

    def test_a_receipt_written_before_the_manifest_existed_needs_the_full_roster(self):
        """Backward compatibility, and no free pass: no manifest == every role."""
        required, problem = C._certified_role_names(self._receipt({}))
        self.assertEqual(problem, "")
        self.assertEqual(set(required), {role.name for role in S.CREW_ROLES})


if __name__ == "__main__":
    unittest.main(verbosity=2)
