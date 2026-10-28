"""T-1360: a target whose before-state its own plan produces.

`sub_clean` plans correctly. It deletes the instance's files, then removes the
emptied directories bottom-up, so every `delete_dir` records the digest of an
EMPTY directory as its before-hash -- true only once the earlier targets of the
same plan have run.

Recovery classified EVERY target up front, from live bytes, against its
plan-time before/after, and raised `RECOVERY_CONFLICT` at any index. A
directory the frontier had not reached still held the files that earlier
targets were going to delete, so it matched neither its empty-tree before nor
its absent after, and a crashed cleanup could never recover: the operation
stayed pending forever, `recovery_required` never cleared, and admission then
refused every consequential tool in the project.

Deferring that classification gives up nothing. `delete_dir` applies through
`rmdir`, which refuses a directory that is not empty, and `_verify_target_bytes`
reruns over every target after roll-forward -- so real tampering still fails
closed, at the point where the plan actually reaches it.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
HOME = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import journal as J  # noqa: E402
from saipen_engine.paths import identity_file_content, new_project_lineage  # noqa: E402
from saipen_engine.subs import MANIFEST_REL, SUBS_REL, sub_clean, sub_spawn  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402


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
updated: 2026-09-16T00:00:00Z
agent: test-agent
---
"""
BOARD = (
    "## DOING\n- [/] T-1 [P1] nested-target fixture | verify: the plan replays "
    "| owner: test-agent | claim_time: 2026-09-16T00:00:00Z\n"
    "## TODO\n## DONE\n## BLOCKED\n"
)
LOG = (
    "- 16.09.26 00:00 [E-99] [T-1] [agent: test-agent] [op: ticket-fixture] "
    "DEC: ticket added via SAIOPS\n"
    "- 16.09.26 00:00 [E-100] [agent: test-agent] RUN: nested-target fixture\n"
)


def project(base: Path) -> Path:
    root = base / "project"
    saipen = root / ".saipen"
    saipen.mkdir(parents=True)
    (saipen / "STATE.md").write_text(STATE, encoding="utf-8")
    (saipen / "BOARD.md").write_text(BOARD, encoding="utf-8")
    (saipen / "LOG.md").write_text(LOG, encoding="utf-8")
    (saipen / "IDENTITY.md").write_text(
        identity_file_content(new_project_lineage()), encoding="utf-8"
    )
    return root


class NestedDeleteTargetRecoveryTests(unittest.TestCase):
    """The shape `sub_clean` produces: files, then their emptied directories."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1360-")
        self.addCleanup(self._tmp.cleanup)
        self.root = project(Path(self._tmp.name).resolve())
        self.tree = self.root / "workspace" / "nested"
        (self.tree / "empty").mkdir(parents=True)
        (self.tree / "payload.bin").write_bytes(b"\x00payload\xff")

    def plan(self) -> list[dict]:
        """Delete the file, then the two directories that held it."""
        # The digest of an EMPTY directory -- what every `delete_dir` in a
        # real cleanup plan records, because the files below it are earlier
        # targets of the same plan. `self.tree / "empty"` is one.
        empty_tree = J._hash_delete_tree(self.tree / "empty")
        payload = J._hash_file(self.tree / "payload.bin")
        return [
            {
                "path": "workspace/nested/payload.bin",
                "action": "delete_file",
                "before_hash": payload,
                "after_hash": "",
            },
            {
                "path": "workspace/nested/empty",
                "action": "delete_dir",
                "before_hash": empty_tree,
                "after_hash": "",
            },
            {
                "path": "workspace/nested",
                "action": "delete_dir",
                "before_hash": empty_tree,
                "after_hash": "",
            },
            {
                "path": "workspace",
                "action": "delete_dir",
                "before_hash": empty_tree,
                "after_hash": "",
            },
        ]

    def test_the_empty_tree_digest_is_what_the_plan_records(self) -> None:
        """Guard the fixture: a directory's before-hash is its EMPTY digest.

        If this stops holding the test below would pass for the wrong reason.
        """
        planned = self.plan()[2]["before_hash"]
        self.assertTrue(planned.startswith("delete-tree-sha256:"), planned)
        self.assertNotEqual(
            planned,
            J._hash_delete_tree(self.tree),
            "the directory still holds the file an earlier target deletes, so "
            "its live digest must differ from the empty one the plan records",
        )

    def test_a_directory_waiting_on_its_own_plan_is_not_a_conflict(self) -> None:
        targets = self.plan()
        classifications = [
            J.classify_target(
                J._target_live_hash(self.root, target),
                target["before_hash"],
                target["after_hash"],
            )
            for target in targets
        ]
        deferred = J.defer_unreached_targets(targets, classifications)
        self.assertNotIn(
            J.TARGET_CONFLICT,
            deferred,
            "a directory the frontier has not reached was read as tampering, so "
            f"a crashed cleanup could never recover: {list(zip(deferred, targets))}",
        )
        self.assertEqual(deferred[0], J.TARGET_PENDING, deferred)

    def test_an_already_deleted_prefix_still_defers_the_directories(self) -> None:
        """Mid-crash: the file is gone, the directories are not."""
        (self.tree / "payload.bin").unlink()
        targets = self.plan()
        classifications = [
            J.classify_target(
                J._target_live_hash(self.root, target),
                target["before_hash"],
                target["after_hash"],
            )
            for target in targets
        ]
        self.assertEqual(classifications[0], J.TARGET_ALREADY_APPLIED, classifications)
        self.assertEqual(classifications[1], J.TARGET_PENDING, classifications)
        deferred = J.defer_unreached_targets(targets, classifications)
        self.assertNotIn(J.TARGET_CONFLICT, deferred, deferred)

    def test_a_foreign_file_is_still_a_conflict(self) -> None:
        """Deferral is not amnesty: bytes no target explains still refuse.

        Every target inside `workspace/nested` has been applied, so nothing
        pending accounts for what is left there.
        """
        targets = self.plan()
        (self.tree / "payload.bin").unlink()
        (self.tree / "empty").rmdir()
        (self.tree / "foreign.txt").write_text("foreign\n", encoding="utf-8")
        classifications = [
            J.classify_target(
                J._target_live_hash(self.root, target),
                target["before_hash"],
                target["after_hash"],
            )
            for target in targets
        ]
        deferred = J.defer_unreached_targets(targets, classifications)
        self.assertEqual(
            deferred[2],
            J.TARGET_CONFLICT,
            "'workspace/nested' holds bytes no pending target of this plan "
            f"explains, so it must refuse rather than defer: {deferred}",
        )

    def test_a_directory_listed_before_its_children_is_never_deferred(self) -> None:
        """Only an EARLIER target can excuse a later one.

        A plan that removes the directory first and its files afterwards is
        not the ordered shape this rule describes, and reading it as one would
        turn the deferral into amnesty for any directory at all.
        """
        ordered = self.plan()
        reversed_plan = [ordered[2], ordered[0], ordered[1]]
        classifications = [
            J.classify_target(
                J._target_live_hash(self.root, target),
                target["before_hash"],
                target["after_hash"],
            )
            for target in reversed_plan
        ]
        deferred = J.defer_unreached_targets(reversed_plan, classifications)
        self.assertEqual(
            deferred[0],
            J.TARGET_CONFLICT,
            f"a directory listed before its own children was excused: {deferred}",
        )

    def test_a_deferred_target_is_only_excused_by_an_unapplied_descendant(self) -> None:
        """Once the inner targets are done, the outer is judged for real."""
        targets = self.plan()
        (self.tree / "payload.bin").unlink()
        (self.tree / "empty").rmdir()
        classifications = [
            J.classify_target(
                J._target_live_hash(self.root, target),
                target["before_hash"],
                target["after_hash"],
            )
            for target in targets
        ]
        deferred = J.defer_unreached_targets(targets, classifications)
        self.assertEqual(deferred[2], J.TARGET_PENDING, deferred)
        self.assertEqual(
            J._target_live_hash(self.root, targets[2]),
            targets[2]["before_hash"],
            "with every inner target applied the directory must be at its "
            "recorded before-state, judged by the ordinary classifier",
        )

    def test_an_unrelated_target_is_never_deferred(self) -> None:
        """Containment decides, not order: a sibling explains nothing."""
        sibling = self.root / "other"
        sibling.mkdir()
        (sibling / "keep.txt").write_text("keep\n", encoding="utf-8")
        targets = [
            *self.plan(),
            {
                "path": "other",
                "action": "delete_dir",
                "before_hash": J._hash_delete_tree(self.tree / "empty"),
                "after_hash": "",
            },
        ]
        classifications = [
            J.classify_target(
                J._target_live_hash(self.root, target),
                target["before_hash"],
                target["after_hash"],
            )
            for target in targets
        ]
        deferred = J.defer_unreached_targets(targets, classifications)
        self.assertEqual(
            deferred[-1],
            J.TARGET_CONFLICT,
            f"'other' holds a file no target in this plan deletes: {deferred}",
        )


class CleanCrashRecoveryTests(unittest.TestCase):
    """The whole route the field hit: crash a real cleanup, then recover it.

    The classifier cases above prove the rule. This proves the rule is the one
    a crashed `sub_clean` actually meets -- the operation that produced the
    unrecoverable pending journal in the first place.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1360-clean-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()

    def fixture(self, label: str) -> tuple[Path, Path]:
        """A project with one spawned instance that holds a nested subtree."""
        root = project(self.base / label)
        instance = root / SUBS_REL / "saihunt"
        spawned = sub_spawn(root, "saihunt", HOME.as_posix())
        self.assertTrue(spawned.ok, getattr(spawned, "message", spawned))
        state = instance / "STATE.md"
        state.write_text(
            state.read_text(encoding="utf-8").replace("phase: PLAN", "phase: DONE"),
            encoding="utf-8",
        )
        (instance / "kitchen" / "OUTBOX.md").write_text("# OUTBOX\n", encoding="utf-8")
        (instance / "nested" / "empty").mkdir(parents=True)
        (instance / "nested" / "payload.bin").write_bytes(b"\x00payload\xff")
        return root, instance

    def crash(self, root: Path, key: str) -> None:
        """Run a real `sub_clean` and crash it immediately after `key`."""
        fired = {"count": 0}

        def injected(seen: str) -> None:
            if seen == key and not fired["count"]:
                fired["count"] += 1
                raise RuntimeError(f"crash after {key}")

        patched = mock.patch.object(J, "_crash_after", side_effect=injected)
        with patched, self.assertRaises(RuntimeError):
            sub_clean(root, "saihunt")

    def test_an_uninterrupted_clean_removes_the_instance(self) -> None:
        """The control: what a crashed run has to converge to."""
        root, instance = self.fixture("plain")
        result = sub_clean(root, "saihunt")
        self.assertTrue(result.ok, getattr(result, "message", result))
        self.assertFalse(instance.exists())
        self.assertEqual(J.pending_ops(root), [])

    def test_a_crash_at_any_frontier_recovers_to_the_same_state(self) -> None:
        for key in ("manifest", "delete_file", "delete_dir"):
            with self.subTest(crash_after=key):
                root, instance = self.fixture(f"crash-{key}")
                self.crash(root, key)
                pending = J.pending_ops(root)
                self.assertEqual(len(pending), 1, pending)
                recovered = J.recover(root, pending[0]["op_id"])
                self.assertTrue(
                    recovered.get("ok"),
                    "a crashed cleanup could not recover, so the project stays "
                    f"pending forever and every consequential tool is refused: {recovered}",
                )
                self.assertFalse(instance.exists(), "the instance survived a recovered cleanup")
                self.assertNotIn(
                    "- saihunt --",
                    (root / MANIFEST_REL).read_text(encoding="utf-8"),
                    "the manifest still advertises the removed instance",
                )
                self.assertEqual(J.pending_ops(root), [], "recovery left the journal pending")

    def test_recovery_is_idempotent(self) -> None:
        root, _instance = self.fixture("twice")
        self.crash(root, "delete_file")
        op_id = J.pending_ops(root)[0]["op_id"]
        first = J.recover(root, op_id)
        second = J.recover(root, op_id)
        self.assertTrue(first.get("ok"), first)
        self.assertTrue(second.get("ok"), second)

    def test_foreign_bytes_under_the_instance_still_refuse(self) -> None:
        """Deferral is not amnesty on the real route either."""
        root, instance = self.fixture("tampered")
        self.crash(root, "delete_file")
        (instance / "nested" / "foreign.bin").write_bytes(b"foreign\n")
        recovered = J.recover(root, J.pending_ops(root)[0]["op_id"])
        self.assertFalse(
            recovered.get("ok"),
            f"bytes no target of this plan wrote were deleted anyway: {recovered}",
        )
        self.assertTrue(instance.exists(), "the tampered instance was removed regardless")


if __name__ == "__main__":
    unittest.main(verbosity=2)
