"""T-1354: a blocked project must not mean a blocked agent.

Live report, reproduced: an OpenCode session entered AUDAPACK, was admitted at
the bootstrap binding, and from then on could read, glob and grep while EVERY
consequential tool was refused -- including a write to an unrelated
`V:\\_TEMP_` directory. The agent completed static analysis and returned
UPSTREAM_BLOCKED. It became an analyst because the infrastructure removed its
execution path, which is the failure mode SAIPEN exists to prevent.

The deciding measurement is that the two layers disagree. Asked about the same
blocked project through the same installed runtime, `evaluate_admission`
answers ADMITTED "protocol state sound" for an ordinary source edit, a new
file and a shell command, and refuses only the protected canonical path -- it
already refuses the minimum unsafe operation. The project-wide gate in
`saipen-guard.js` then overrides that with a total ban, because it admits only
`BOUND_VALID` and `NON_SAIPEN`.

Two distinct ways that becomes permanent:

  * an OPERATOR-ONLY condition (AUDAPACK's `RECONCILE_REAUTH_REQUIRED`, one
    2026-09-02 widget ticket) can never clear itself, so the ban is forever
    while a human is not looking;
  * an AUTOMATABLE condition whose repair cannot succeed keeps the ban too:
    `fleet prepare` answers `RECOVERY_FAILED` with `requires_reissue: true`
    after a repair that refused and moved nothing, so the model is told to
    reissue against "current bytes" that are the same bytes. Measured on three
    separate projects at once.

None of this is a stale verdict. `_RESOLVE_CACHE` memoises root resolution
only, `fleet.py` and `reconcile.py` cache nothing, and a blocked fixture goes
BLOCKED -> repaired -> BOUND_VALID inside one process. The refusal is honestly
recomputed every time; its SCOPE is the defect.

The invariant: REFUSE THE MINIMUM UNSAFE OPERATION. A condition blocks the work
that depends on it, and nothing else.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.admission import evaluate_admission  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402
from test_opencode_adapter import PLUGIN, run_cases  # noqa: E402

NODE = shutil.which("node")


def setUpModule() -> None:
    isolate_host_session()


STATE = """---
phase: BUILD
task: T-1
next_action: "PHASE BUILD T-1"
blocker: ""
transition_from: SCOUT
saipen_version: 8
schema_version: 3
last_event: 100
style_contract: ded-4ae736e4
mode: full
updated: 2026-09-12T00:00:00Z
agent: test-agent
---
"""

# The DOING ticket is properly ALLOCATED; the legacy records below are not.
# That is the field shape -- a history where the allocation contract is in
# force and older records that predate it. With no allocation event at all the
# checker never engages and the fixture stops reproducing anything.
LOG = (
    "- 12.09.26 00:00 [E-99] [T-1] [agent: test-agent] [op: ticket-fixture] "
    "DEC: ticket added via SAIOPS\n"
    "- 12.09.26 00:00 [E-100] [agent: test-agent] RUN: reachability fixture\n"
)


def _board(extra: str = "") -> str:
    return (
        "## DOING\n"
        "- [/] T-1 [P1] reachability fixture work | verify: the matrix runs "
        "| owner: test-agent | claim_time: 2026-09-12T00:00:00Z\n"
        "## TODO\n" + extra + "## DONE\n## BLOCKED\n"
    )


def project(base: Path, name: str, *, board_extra: str = "") -> Path:
    root = base / name
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "STATE.md").write_text(STATE, encoding="utf-8")
    (saipen / "BOARD.md").write_text(_board(board_extra), encoding="utf-8")
    (saipen / "LOG.md").write_text(LOG, encoding="utf-8")
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    (root / "src").mkdir()
    (root / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")
    return root


def legacy_board_project(base: Path, name: str) -> Path:
    """Legacy records plus ONE modern recoverable defect (the field shape).

    Measured on three separate user projects: a BOARD record is oversized, the
    canonical repair is `saipen ticket compact T-###`, and the whole-board
    validation refused it because OTHER records predate the allocation
    contract. The named route could not run from the state that asked for it,
    so Fleet reported a failed repair forever and every consequential tool in
    those sessions was refused.
    """
    oversize = "x" * 4000
    extra = (
        f"- [ ] T-2 [P1] legacy oversized record {oversize} | verify: {oversize}\n"
        "- [ ] T-3 [P1] a legacy record with no allocation event | verify: legacy\n"
    )
    return project(base, name, board_extra=extra)


def fleet_prepare(root: Path) -> dict:
    completed = subprocess.run(
        [sys.executable, str(TOOLS / "saipen.py"), "fleet", "prepare",
         "--cwd", str(root), "--json"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=hermetic_env(),
        timeout=600,
    )
    try:
        return json.loads(completed.stdout)
    except ValueError:
        raise AssertionError(
            f"fleet prepare produced no record (rc={completed.returncode})\n"
            f"{completed.stdout[-800:]}\n{completed.stderr[-800:]}"
        ) from None


class RecoveryLivenessTests(unittest.TestCase):
    """A named repair must be executable from the state that names it."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def test_the_named_repair_runs_on_a_legacy_board(self) -> None:
        """Point 1: unrelated legacy records are not this repair's veto."""
        root = legacy_board_project(self.base, "legacy")
        # preflight, not prepare: prepare would DISPATCH the repair, and this
        # case is about whether the named route can run at all.
        from saipen_engine.fleet import preflight

        first = preflight(str(root))
        self.assertEqual(
            first.get("reason_code"),
            "BOARD_RECORD_OVERSIZE",
            f"fixture no longer reproduces the field shape: {first.get('reason_code')}",
        )
        completed = subprocess.run(
            [sys.executable, str(TOOLS / "saipen.py"), "--project-root", str(root),
             "ticket", "compact", first["canonical_next_command"].split()[-1],
             "--dry-run", "--json"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=hermetic_env(), timeout=600,
        )
        record = json.loads(completed.stdout)
        self.assertTrue(
            record.get("ok"),
            "the canonical repair the protocol itself names cannot run from the "
            f"state that names it: {record.get('detail')}",
        )
        self.assertGreater(
            record.get("carried_finding_count", 0),
            0,
            "the legacy records were silently legitimized rather than carried",
        )

    def test_convergence_is_bounded(self) -> None:
        """Points 3 and 7: N sanctioned steps, then VALID or one terminal state.

        Never `prepare -> SAFE repair -> refusal -> prepare -> same repair`.
        """
        root = legacy_board_project(self.base, "converge")
        seen = []
        for _ in range(8):
            record = fleet_prepare(root)
            seen.append((record.get("classification"), record.get("code")))
            if record.get("classification") in ("BOUND_VALID", "NON_SAIPEN"):
                break
            if record.get("operator_decision_available"):
                # A named terminal state IS a legal end: the automatic route
                # handed over to a human instead of spinning.
                self.assertTrue(record.get("canonical_next_command"), record)
                break
            self.assertFalse(
                record.get("requires_reissue")
                and record.get("code", "").startswith("RECOVERY_FAILED"),
                f"a failed repair asked for a reissue against unchanged bytes: {record}",
            )
        else:
            terminal = seen[-1]
            self.assertIn(
                terminal[1],
                ("RECOVERY_EXHAUSTED", "RECOVERY_NOT_AUTOMATABLE",
                 "BOUND_RECOVERY_REQUIRED_BLOCKED"),
                f"eight sanctioned steps neither converged nor reached a named "
                f"terminal state: {seen}",
            )
        self.assertLessEqual(len(seen), 8, seen)

    def test_the_reissue_demand_stops(self) -> None:
        """`requires_reissue` promises MOVED bytes, so it cannot be forever.

        A repair that actually changed the generation may legitimately ask the
        caller to reread once -- that is the protocol working. What must not
        survive is the demand repeating against bytes that stopped moving,
        which is how a real session refused every consequential tool forever.
        """
        root = legacy_board_project(self.base, "stuck")
        demands = []
        for _ in range(5):
            record = fleet_prepare(root)
            demands.append(bool(record.get("requires_reissue")))
            if not record.get("requires_reissue"):
                break
        self.assertFalse(
            demands[-1],
            f"five sanctioned calls and the reissue demand never stopped: {demands}",
        )


class OrdinaryWorkOutsideTheBlockedSurfaceTests(unittest.TestCase):
    """The per-operation layer already answers correctly; prove it stays."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def test_admission_admits_ordinary_work_in_a_blocked_project(self) -> None:
        root = legacy_board_project(self.base, "stuck")
        for action, target in (("edit", "src/app.py"), ("write", "src/new.py")):
            with self.subTest(action=action):
                result = evaluate_admission(root, target_path=target, action=action)
                self.assertTrue(result["admitted"], result)

    def test_admission_still_refuses_the_canonical_surface(self) -> None:
        root = legacy_board_project(self.base, "stuck")
        result = evaluate_admission(root, target_path=".saipen/STATE.md", action="write")
        self.assertFalse(result["admitted"], result)
        self.assertEqual(result["code"], "PROTECTED_CANONICAL_NAMESPACE")

    def test_an_ordinary_file_outside_the_root_is_not_foreign_project_mutation(
        self,
    ) -> None:
        """T-1354: the `V:\\_TEMP_` refusal in the live report.

        A bound identity may not authorize mutation of ANOTHER SAIPEN
        PROJECT's canonical state -- T-1351 refuses that on every surface. An
        ordinary file in a directory that is no project at all is not that,
        and a shell command already writes it freely, so refusing the file
        tool is friction rather than protection.
        """
        root = project(self.base, "bound")
        scratch = self.base / "scratch-not-a-project"
        scratch.mkdir()
        target = scratch / "notes.txt"
        target.write_text("x\n", encoding="utf-8")
        result = evaluate_admission(
            root, target_path=str(target), action="write", explicit_root=root
        )
        self.assertTrue(
            result["admitted"],
            "a bound session was refused an unrelated file that belongs to no "
            f"project: {result}",
        )


class RecoveryDebtScopeTests(unittest.TestCase):
    """Point 4: unfinished work blocks the files it will write, not the agent.

    An interrupted canonical write is real debt. It is debt against the FILES
    the replay is going to touch, and those are recorded exactly in the
    operation. Refusing every consequential tool for it made one interrupted
    BOARD compaction turn a whole repository read-only, measured in the field.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-debt-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def _with_pending(
        self, paths: list[str], *, readable: bool = True, name: str = "debt",
        absolute: bool = False,
    ) -> Path:
        root = project(self.base, name)
        if absolute:
            paths = [str(root / path) for path in paths]
        op_dir = root / ".saipen" / "recovery" / "ops" / "op-fixture"
        op_dir.mkdir(parents=True)
        (op_dir / "operation.json").write_text(
            "not json at all"
            if not readable
            else json.dumps(
                {
                    "op_id": "op-fixture",
                    "created_at": "2026-09-12T00:00:00Z",
                    "status": "APPLIED",
                    "targets": [{"path": path} for path in paths],
                }
            ),
            encoding="utf-8",
        )
        return root

    def test_work_outside_the_unfinished_write_proceeds(self) -> None:
        root = self._with_pending([".saipen/BOARD.md", ".saipen/LOG.md"])
        result = evaluate_admission(root, target_path="src/app.py", action="edit")
        self.assertTrue(
            result["admitted"],
            "an interrupted BOARD write stopped an edit to a source file no "
            f"replay will ever touch: {result}",
        )

    def test_the_files_the_replay_will_write_stay_refused(self) -> None:
        root = self._with_pending(["src/app.py"])
        result = evaluate_admission(root, target_path="src/app.py", action="edit")
        self.assertFalse(result["admitted"], result)
        self.assertEqual(result["code"], "RECOVERY_REQUIRED")

    def test_an_unresolved_target_set_still_fails_closed(self) -> None:
        """A shell command's effect is unknown, and unknown scope refuses."""
        root = self._with_pending([".saipen/BOARD.md"])
        result = evaluate_admission(root, action="shell")
        self.assertFalse(result["admitted"], result)

    def test_an_unreadable_operation_record_refuses_everything(self) -> None:
        """Unknown scope is not evidence of safety."""
        root = self._with_pending([".saipen/BOARD.md"], readable=False)
        result = evaluate_admission(root, target_path="src/app.py", action="edit")
        self.assertFalse(result["admitted"], result)
        self.assertEqual(result["code"], "RECOVERY_REQUIRED")

    def test_one_file_spelled_two_ways_is_still_one_file(self) -> None:
        """The overlap test compares paths, so spelling must not decide it.

        A target recorded absolutely, with a `./` prefix, with a `..` segment
        or in another case compared unequal to the same file spelled plainly.
        The miss did not refuse -- it ADMITTED a write to the exact path the
        replay is going to write, out of a record that parsed perfectly well.
        Fail-open is a worse answer than the unscoped refusal it replaced.
        """
        spellings = [
            ("plain", "src/app.py", False),
            ("backslash", "src" + chr(92) + "app.py", False),
            ("dot-prefix", "./src/app.py", False),
            ("traversal", "src/../src/app.py", False),
            ("mixed-case", "SRC/APP.PY", False),
            ("absolute", "src/app.py", True),
        ]
        for label, spelling, absolute in spellings:
            with self.subTest(spelling=label):
                root = self._with_pending(
                    [spelling], name=f"debt-{label}", absolute=absolute
                )
                result = evaluate_admission(
                    root, target_path="src/app.py", action="edit"
                )
                self.assertFalse(
                    result["admitted"],
                    f"a recovery target recorded as {label} missed the file it "
                    f"names and admitted the write: {result}",
                )
                self.assertEqual(result["code"], "RECOVERY_REQUIRED")

    def test_a_recorded_target_outside_the_root_fails_closed(self) -> None:
        """A replay that writes out of the root is scope this cannot describe."""
        root = self._with_pending(["../outside.py"], name="debt-escape")
        result = evaluate_admission(root, target_path="src/app.py", action="edit")
        self.assertFalse(result["admitted"], result)
        self.assertEqual(result["code"], "RECOVERY_REQUIRED")

    def test_a_directory_effect_over_a_replay_target_is_an_overlap(self) -> None:
        """Containment, not equality: `src` holds the file the replay writes.

        Measured before the fix: delete of `src`, move of `src`, and a write
        into a directory the replay owns were all ADMITTED under the debt.
        """
        root = self._with_pending(["src/app.py"], name="debt-parent")
        for label, kwargs in (
            ("delete-parent", {"target_path": "src", "action": "delete"}),
            ("move-parent", {"target_paths": ["src", "lib"], "action": "move"}),
        ):
            with self.subTest(effect=label):
                result = evaluate_admission(root, **kwargs)
                self.assertFalse(result["admitted"], f"{label} admitted: {result}")
                self.assertEqual(result["code"], "RECOVERY_REQUIRED")
        owned_dir = self._with_pending(["src"], name="debt-owned-dir")
        result = evaluate_admission(owned_dir, target_path="src/app.py", action="write")
        self.assertFalse(result["admitted"], result)
        self.assertEqual(result["code"], "RECOVERY_REQUIRED")

    def test_a_sibling_of_the_replay_target_still_proceeds(self) -> None:
        """The containment test must not turn back into an unscoped refusal."""
        root = self._with_pending(["src/app.py"], name="debt-sibling")
        result = evaluate_admission(root, target_path="src/other.py", action="write")
        self.assertTrue(result["admitted"], result)


class NamespaceContainmentTests(unittest.TestCase):
    """A directory effect that CONTAINS protected canonical state is refused.

    Membership is the wrong question for a directory. The project root and
    `.saipen` name no protected document, so deleting or moving either -- or an
    ancestor of the root, or another SAIPEN project's root -- was ADMITTED on a
    perfectly healthy project while it removed the whole namespace at once.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-containment-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.root = project(self.base, "healthy")

    def _refused(self, **kwargs) -> None:
        result = evaluate_admission(self.root, **kwargs)
        self.assertFalse(result["admitted"], f"{kwargs} admitted: {result}")
        self.assertEqual(result["code"], "PROTECTED_CANONICAL_NAMESPACE", result)

    def test_the_root_and_the_memory_directory_are_refused(self) -> None:
        for label, kwargs in (
            ("delete-root", {"target_path": ".", "action": "delete"}),
            ("delete-root-absolute", {"target_path": str(self.root), "action": "delete"}),
            ("move-root", {"target_paths": [str(self.root), str(self.base / "away")],
                           "action": "move"}),
            ("delete-memory", {"target_path": ".saipen", "action": "delete"}),
            ("move-memory", {"target_paths": [".saipen", "old-memory"], "action": "move"}),
        ):
            with self.subTest(effect=label):
                self._refused(**kwargs)

    def test_an_ancestor_of_the_root_is_refused(self) -> None:
        self._refused(target_path=str(self.base), action="delete")

    def test_another_projects_root_and_memory_are_refused(self) -> None:
        foreign = project(self.base, "foreign")
        self._refused(target_path=str(foreign), action="delete")
        self._refused(target_path=str(foreign / ".saipen"), action="delete")
        nest = self.base / "outer" / "deeper"
        nest.mkdir(parents=True)
        project(nest, "nested")
        self._refused(target_path=str(self.base / "outer"), action="delete")

    def test_ordinary_directory_effects_still_proceed(self) -> None:
        unrelated = self.base / "unrelated"
        (unrelated / "a" / "b").mkdir(parents=True)
        for label, kwargs in (
            ("delete-source-dir", {"target_path": "src", "action": "delete"}),
            ("write-source", {"target_path": "src/new.py", "action": "write"}),
            ("delete-unrelated-dir", {"target_path": str(unrelated), "action": "delete"}),
            ("read-root", {"target_path": ".", "action": "read"}),
        ):
            with self.subTest(effect=label):
                result = evaluate_admission(self.root, **kwargs)
                self.assertTrue(result["admitted"], f"{label} refused: {result}")

    def test_a_subtree_too_large_to_prove_clean_is_refused(self) -> None:
        import saipen_engine.admission as admission

        wide = self.base / "wide"
        for index in range(12):
            (wide / f"d{index}").mkdir(parents=True)
        original = admission._CONTAINMENT_SCAN_DIRS
        admission._CONTAINMENT_SCAN_DIRS = 5
        try:
            self._refused(target_path=str(wide), action="delete")
        finally:
            admission._CONTAINMENT_SCAN_DIRS = original


@unittest.skipUnless(os.name == "nt", "Win32 path namespaces exist only on Windows")
class Win32SpellingTests(unittest.TestCase):
    """A path Windows opens as a project file is classified as that project file.

    `Path.resolve` keeps three Win32 shapes verbatim, so the root-relative test
    judged the spelling instead of the file. Measured on the REVIEW pass:

    - `\\\\?\\<root>\\src\\app.py` failed `relative_to(root)`, classified OUTSIDE,
      and was ADMITTED_EXTERNAL while recovery debt refused `src/app.py`
      itself -- every protocol block an inside path answers to was skipped;
    - `.saipen/IDENTITY.md::$DATA`, with the document absent, is the document's
      main stream and was ADMITTED as an ordinary in-root write, creating
      protected state; `.saipen/BOARD.md:x:$DATA` and `.saipen:alt` likewise.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-win32-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def _debt_root(self, name: str, recorded: str) -> Path:
        root = project(self.base, name)
        op_dir = root / ".saipen" / "recovery" / "ops" / "op-fixture"
        op_dir.mkdir(parents=True)
        (op_dir / "operation.json").write_text(
            json.dumps(
                {
                    "op_id": "op-fixture",
                    "created_at": "2026-09-12T00:00:00Z",
                    "status": "APPLIED",
                    "targets": [{"path": recorded}],
                }
            ),
            encoding="utf-8",
        )
        return root

    @staticmethod
    def _spellings(path: Path) -> list[tuple[str, str]]:
        text = str(path)
        drive, tail = text[0], text[2:]
        return [
            ("extended", "\\\\?\\" + text),
            ("device", "\\\\.\\" + text),
            ("admin-share", f"\\\\localhost\\{drive}${tail}"),
            ("admin-share-ip", f"\\\\127.0.0.1\\{drive}${tail}"),
            ("extended-unc", f"\\\\?\\UNC\\localhost\\{drive}${tail}"),
        ]

    def test_a_prefixed_spelling_of_a_replay_target_is_the_replay_target(self) -> None:
        root = self._debt_root("debt", "src/app.py")
        for label, spelling in self._spellings(root / "src" / "app.py"):
            with self.subTest(spelling=label):
                result = evaluate_admission(root, target_path=spelling, action="write")
                self.assertFalse(
                    result["admitted"],
                    f"{label} spelling of the file the replay writes was admitted: {result}",
                )
                self.assertEqual(result["code"], "RECOVERY_REQUIRED", result)

    def test_a_prefixed_recorded_target_is_scoped_not_merely_refused(self) -> None:
        """Understood, not fail-closed: the sibling proceeds, the target does not."""
        recorded = "\\\\?\\" + str(self.base / "debt-recorded" / "src" / "app.py")
        root = self._debt_root("debt-recorded", recorded)
        sibling = evaluate_admission(root, target_path="src/other.py", action="write")
        self.assertTrue(sibling["admitted"], sibling)
        target = evaluate_admission(root, target_path="src/app.py", action="write")
        self.assertEqual(target["code"], "RECOVERY_REQUIRED", target)

    def test_a_stream_of_protected_state_is_protected_state(self) -> None:
        root = project(self.base, "streams")
        (root / ".saipen" / "IDENTITY.md").unlink()
        for spelling in (
            ".saipen/IDENTITY.md::$DATA",
            ".saipen/BOARD.md:x:$DATA",
            ".saipen/STATE.md:alt",
            ".saipen:alt",
            "\\\\?\\" + str(root / ".saipen" / "LOG.md") + ":alt",
        ):
            with self.subTest(spelling=spelling):
                result = evaluate_admission(root, target_path=spelling, action="write")
                self.assertFalse(result["admitted"], f"{spelling} admitted: {result}")
                self.assertEqual(result["code"], "PROTECTED_CANONICAL_NAMESPACE", result)

    def test_ordinary_files_stay_ordinary_under_every_spelling(self) -> None:
        root = project(self.base, "healthy")
        scratch = self.base / "scratch.txt"
        for label, spelling, code in (
            ("extended-source", "\\\\?\\" + str(root / "src" / "new.py"), "ADMITTED"),
            ("stream-source", "src/app.py:alt", "ADMITTED"),
            ("extended-outside", "\\\\?\\" + str(scratch), "ADMITTED_EXTERNAL"),
            ("admin-share-outside", self._spellings(scratch)[2][1], "ADMITTED_EXTERNAL"),
        ):
            with self.subTest(spelling=label):
                result = evaluate_admission(root, target_path=spelling, action="write")
                self.assertTrue(result["admitted"], f"{label} refused: {result}")
                self.assertEqual(result["code"], code, result)


@unittest.skipUnless(NODE, "node runtime unavailable")
class PluginGateScopeTests(unittest.TestCase):
    """The gate as the host loads it, driving the real plugin through node."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-plugin-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)

    def _cases(self, root: Path) -> list[dict]:
        env = hermetic_env(SAIPEN_AGENT="test-agent")
        env = {k: v for k, v in env.items() if k.startswith("SAIPEN_")}
        # Exercise the engine UNDER TEST. Without this the plugin resolves the
        # INSTALLED skill root and the case silently measures whatever runtime
        # happens to be deployed on this machine instead of this working tree.
        env["SAIPEN_SKILL_ROOT"] = str(REPO)
        base = {"project": str(root), "env": env}
        return [
            # Issued TWICE on purpose. A first refusal can be honest: if the
            # canonical generation actually moved, the payload in hand is stale
            # and one reroute is the protocol working. What must not happen is
            # the SECOND action hitting the same wall -- that is a session that
            # can only read.
            {
                **base,
                "id": "ordinary-edit-first",
                "input": {"tool": "edit", "sessionID": "ses_reach_edit"},
                "output": {"args": {"filePath": str(root / "src" / "app.py"),
                                    "oldString": "x = 1"}},
            },
            {
                **base,
                "id": "ordinary-edit",
                "input": {"tool": "edit", "sessionID": "ses_reach_edit"},
                "output": {"args": {"filePath": str(root / "src" / "app.py"),
                                    "oldString": "x = 1"}},
            },
            {
                **base,
                "id": "protected-edit",
                "input": {"tool": "edit", "sessionID": "ses_reach_protected"},
                "output": {"args": {"filePath": str(root / ".saipen" / "STATE.md"),
                                    "oldString": "phase"}},
            },
        ]

    def test_ordinary_work_survives_an_legacy_board_project(self) -> None:
        root = legacy_board_project(self.base, "stuck")
        records = run_cases(PLUGIN, self._cases(root), self.base / "gate")
        by_id = {r["id"]: r for r in records}
        self.assertEqual(
            by_id["ordinary-edit"]["outcome"],
            "allowed",
            "a legacy board made an ordinary source edit impossible, so the "
            "agent can only read: "
            f"{by_id['ordinary-edit']['message']}",
        )
        self.assertEqual(
            by_id["protected-edit"]["outcome"],
            "blocked",
            "the canonical surface must stay refused whatever else is relaxed",
        )


def guard_event(command: str, cwd: Path, *, tool: str = "bash") -> dict:
    """The REAL installed path: event JSON -> map_event -> guard -> admission.

    Calling `destructive_shell_effects` directly proves the helper. It does not
    prove the host guard consumes it, and for the whole of this ticket's first
    build it did not: `rm -rf .` was ADMITTED through this exact entry point
    while the helper beside it already resolved the command to the root.
    """
    event = {
        "host": "opencode",
        "event": "tool.execute.before",
        "tool_name": tool,
        "cwd": str(cwd),
        "tool_input": {"command": command},
        "actor": "test-agent",
    }
    completed = subprocess.run(
        [sys.executable, str(TOOLS / "saipen.py"), "guard",
         "--event-json", json.dumps(event), "--json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        env=hermetic_env(), timeout=600,
    )
    try:
        return json.loads(completed.stdout)
    except ValueError:
        raise AssertionError(
            f"guard produced no record for {command!r} (rc={completed.returncode})\n"
            f"{completed.stdout[-800:]}\n{completed.stderr[-800:]}"
        ) from None


class ShellEffectAdmissionTests(unittest.TestCase):
    """One effect, one answer, whichever surface proposed it.

    Defect class: an ordinary shell command was admitted on the absence of the
    literal text `.saipen`, so the guard answered ADMITTED to `rm -rf .` on a
    healthy project while the native delete of the same directory was refused
    by containment. The agent only had to pick the other surface.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1354-shell-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()
        self.root = project(self.base, "healthy")
        self.external = self.base / "external-scratch"
        self.external.mkdir()
        (self.external / "notes.txt").write_text("x\n", encoding="utf-8")

    def assertRefused(self, command: str, *, cwd: Path | None = None) -> dict:
        record = guard_event(command, cwd or self.root)
        self.assertFalse(
            record.get("admitted"),
            f"the guard admitted {command!r} on a healthy project: {record}",
        )
        return record

    def test_the_project_root_cannot_be_deleted_from_the_shell(self) -> None:
        for command in (
            "rm -rf .",
            "rm -rf ./",
            "rm -rf ..",
            "Remove-Item -Recurse .",
            "Remove-Item -LiteralPath {root} -Recurse",
            "cmd /c rd /s /q .",
            "rm -rf {root}",
            "rm -rf {base}",
            "bash -c 'rm -rf .'",
        ):
            spelled = command.format(root=self.root, base=self.base)
            with self.subTest(command=spelled):
                record = self.assertRefused(spelled)
                self.assertEqual(
                    record.get("code"),
                    "PROTECTED_CANONICAL_NAMESPACE",
                    f"{spelled} was refused, but not as the protected effect it is: {record}",
                )
                self.assertEqual(record.get("surface"), "shell", record)

    def test_the_shell_and_the_native_tool_answer_alike(self) -> None:
        """Parity: the identical effect, proposed two ways, one code."""
        native = evaluate_admission(
            self.root, target_path=str(self.root), action="delete", explicit_root=self.root
        )
        shell = guard_event("rm -rf .", self.root)
        self.assertFalse(native["admitted"], native)
        self.assertEqual(native["code"], shell.get("code"), (native, shell))

    def test_an_unresolvable_destructive_operand_fails_closed(self) -> None:
        for command in (
            "rm -rf $TARGET",
            'rm -rf "$(cat list.txt)"',
            "cat list.txt | xargs rm -rf",
            "powershell -EncodedCommand cgBtACAALQByAGYAIAAuAA==",
            # REVIEW pass 3: escaped quoting mis-tokenized silently, so the
            # guard answered on a reading it never made and admitted both of
            # these on a healthy project.
            r'rm -rf \".\"',
            r"""bash -c 'bash -c "bash -c \"rm -rf .\""'""",
        ):
            with self.subTest(command=command):
                record = self.assertRefused(command)
                self.assertEqual(record.get("code"), "TARGET_UNRESOLVED", record)

    def test_ordinary_shell_work_stays_admitted(self) -> None:
        for command in ("echo hello", "git status", "ls -la", "python -V", "cat src/app.py"):
            with self.subTest(command=command):
                record = guard_event(command, self.root)
                self.assertTrue(
                    record.get("admitted"),
                    f"a non-destructive diagnostic command was refused: {record}",
                )

    def test_a_destructive_command_on_an_unrelated_directory_stays_admitted(self) -> None:
        """Provably external, holds no SAIPEN project: not this guard's call."""
        record = guard_event(f"rm -rf {self.external}", self.root)
        self.assertTrue(
            record.get("admitted"),
            "a delete of a directory that belongs to no project was refused; "
            f"that is friction, not protection: {record}",
        )

    def test_popd_returns_the_shell_to_the_project(self) -> None:
        """`pushd <external>; popd; rm -rf .` deletes the PROJECT."""
        record = self.assertRefused(f"pushd {self.external} ; popd ; rm -rf .")
        self.assertEqual(record.get("code"), "PROTECTED_CANONICAL_NAMESPACE", record)

    def test_navigation_that_stays_external_is_still_admitted(self) -> None:
        for command in ("pushd {external} ; rm -rf .", "cd {external} ; rm -rf ."):
            spelled = command.format(external=self.external)
            with self.subTest(command=spelled):
                record = guard_event(spelled, self.root)
                self.assertTrue(
                    record.get("admitted"),
                    f"the shell had left the project before the delete: {record}",
                )

    def test_unprovable_navigation_fails_closed(self) -> None:
        for command in (
            "cd {external} ; cd - ; rm -rf .",
            "pushd {external} ; popd ; popd ; rm -rf .",
        ):
            spelled = command.format(external=self.external)
            with self.subTest(command=spelled):
                record = self.assertRefused(spelled)
                self.assertEqual(record.get("code"), "TARGET_UNRESOLVED", record)

    def test_the_mapped_event_carries_the_effects_it_was_judged_on(self) -> None:
        """The record must show WHY, or the refusal cannot be acted on."""
        record = guard_event("rm -rf .", self.root)
        echoed = record.get("event", {})
        self.assertIn("shell_effects", echoed, record)
        self.assertEqual(
            [effect["action"] for effect in echoed["shell_effects"]], ["delete"], record
        )
        self.assertEqual(
            record.get("shell_effect", {}).get("verb"), "rm", record
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
