"""T-1355: a target that changes nothing must not decide the verdict.

Measured live at E-6571. `saipen stop` failed before its first effective write.
Its BOARD target was unchanged -- `before_hash == after_hash == live` -- so
`classify_target` read it as ALREADY_APPLIED, which is correct: it IS in its
planned state and always was. Recovery then used that as EVIDENCE about
ordering, decided the pending LOG target behind it had been materialized out of
order, and refused `RECOVERY_CONFLICT`. Every surface named `saipen recover`,
and `saipen recover` produced the same refusal again; only a manual
`recover resolve <op> --resolution replan` escaped.

The tell was that the verdict moved with the no-op's POSITION in the plan:
first meant roll forward, middle or last meant conflict, for the identical
operation over identical bytes. A no-op writes nothing, so it says nothing
about ordering. It is transparent to the materialization frontier, and this
module measures that at every position.

Nothing else relaxes: a genuine out-of-order materialization and a genuine
third state still refuse, and they still name the right target.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.journal import (  # noqa: E402
    Journal,
    hash_bytes,
    is_noop_target,
    recover,
)
from saipen_engine.paths import runtime_lock_identity  # noqa: E402
from test_hermetic_env import hermetic_env, isolate_host_session  # noqa: E402
from test_journal_nested_targets import project  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


class NoopTargetRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="t1355-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()
        self._made = 0

    def fixture(self, targets: list[dict], *, label: str = "") -> tuple[Path, str]:
        """A project plus ONE prepared journal over `targets`."""
        self._made += 1
        root = project(self.base / f"{label or 'op'}{self._made}")
        (root / "a.txt").write_bytes(b"A")
        (root / "b.txt").write_bytes(b"B")
        (root / "noop.txt").write_bytes(b"SAME")
        op_id = f"op-{label or 'noop'}-{self._made}"
        Journal(root, op_id).start(
            "op", "probe", runtime_lock_identity(root), "hash", targets
        )
        return root, op_id

    @staticmethod
    def noop() -> dict:
        same = hash_bytes(b"SAME")
        return {
            "path": "noop.txt",
            "role": "generic",
            "content": b"SAME",
            "before_hash": same,
            "after_hash": same,
        }

    @staticmethod
    def pending(name: str, before: bytes, after: bytes) -> dict:
        return {
            "path": name,
            "role": "generic",
            "content": after,
            "before_hash": hash_bytes(before),
            "after_hash": hash_bytes(after),
        }

    def plan(self, noop_at: int | None) -> list[dict]:
        targets = [self.pending("a.txt", b"A", b"A2"), self.pending("b.txt", b"B", b"B2")]
        if noop_at is not None:
            targets.insert(noop_at, self.noop())
        return targets

    def test_the_predicate_names_only_a_no_op(self) -> None:
        """Guard the fixture: an ordinary target is not transparent."""
        self.assertTrue(is_noop_target(self.noop()))
        self.assertFalse(is_noop_target(self.pending("a.txt", b"A", b"A2")))

    def test_the_verdict_does_not_move_with_the_no_ops_position(self) -> None:
        """The whole defect in one assertion."""
        verdicts = {}
        for position in (0, 1, 2):
            root, op_id = self.fixture(self.plan(position), label=f"pos{position}")
            record = recover(root, op_id)
            verdicts[position] = (record.get("ok"), record.get("code"))
            self.assertTrue(
                record.get("ok"),
                f"a target that writes nothing refused recovery from position "
                f"{position}: {record}",
            )
        self.assertEqual(
            len(set(verdicts.values())),
            1,
            f"the same operation over the same bytes got different verdicts "
            f"depending on where the no-op sat: {verdicts}",
        )

    def test_a_no_op_changes_neither_verdict_nor_writes(self) -> None:
        """Inserting one anywhere is invisible to the outcome."""
        root, op_id = self.fixture(self.plan(None), label="without")
        baseline = recover(root, op_id)
        for position in (0, 1, 2):
            with self.subTest(position=position):
                root, op_id = self.fixture(self.plan(position), label=f"with{position}")
                record = recover(root, op_id)
                self.assertEqual(
                    (record.get("ok"), record.get("code")),
                    (baseline.get("ok"), baseline.get("code")),
                    f"inserting a no-op at {position} changed the verdict: {record}",
                )
                self.assertEqual((root / "noop.txt").read_bytes(), b"SAME")

    def test_a_real_out_of_order_materialization_still_refuses(self) -> None:
        """Deferral is not amnesty: a LATER effective write still refuses."""
        targets = self.plan(None)
        root, op_id = self.fixture(targets, label="ooo")
        # b.txt is at its planned AFTER state while a.txt, before it, is not.
        (root / "b.txt").write_bytes(b"B2")
        record = recover(root, op_id)
        self.assertFalse(record.get("ok"), record)
        self.assertEqual(record.get("code"), "RECOVERY_CONFLICT", record)
        self.assertEqual(record.get("target_path"), "b.txt", record)

    def test_a_third_state_still_refuses_and_names_its_target(self) -> None:
        root, op_id = self.fixture(self.plan(1), label="third")
        (root / "a.txt").write_bytes(b"NEITHER")
        record = recover(root, op_id)
        self.assertFalse(record.get("ok"), record)
        self.assertEqual(record.get("code"), "RECOVERY_CONFLICT", record)
        self.assertEqual(record.get("target_path"), "a.txt", record)

    def test_a_no_op_beside_a_third_state_does_not_shield_it(self) -> None:
        """The transparency must not swallow the refusal next to it."""
        root, op_id = self.fixture(self.plan(0), label="shield")
        (root / "b.txt").write_bytes(b"NEITHER")
        record = recover(root, op_id)
        self.assertFalse(record.get("ok"), record)
        self.assertEqual(record.get("target_path"), "b.txt", record)

    def test_a_plan_of_nothing_but_no_ops_settles(self) -> None:
        root, op_id = self.fixture([self.noop()], label="allnoop")
        record = recover(root, op_id)
        self.assertTrue(record.get("ok"), record)
        self.assertEqual((root / "noop.txt").read_bytes(), b"SAME")

    def test_a_genuine_conflict_names_the_command_that_settles_it(self) -> None:
        """TERMINATION ORACLE: never advertise a command that reproduces this.

        Every surface used to say `resolve it explicitly (saipen recover)`, and
        bare `saipen recover` on an unresolved conflict returns the identical
        refusal -- the loop the field report was stuck in. The route named must
        be one whose execution CHANGES the state.
        """
        from saipen_engine.journal import recovery_preflight

        targets = self.plan(None)
        root, op_id = self.fixture(targets, label="oracle")
        (root / "b.txt").write_bytes(b"B2")
        conflict = recover(root, op_id)
        self.assertEqual(conflict.get("code"), "RECOVERY_CONFLICT", conflict)
        named = conflict.get("canonical_next_command")
        self.assertEqual(
            named,
            f"saipen recover resolve {op_id} --resolution <accept_live|replan>",
            conflict,
        )
        preflight = recovery_preflight(root)
        self.assertEqual(preflight.get("canonical_next_command"), named, preflight)
        self.assertNotIn("(saipen recover)", str(preflight.get("detail")), preflight)
        # Through the CLI, because that is the route the message names and
        # the one an operator actually has.
        completed = subprocess.run(
            [sys.executable, str(TOOLS / "saipen.py"), "--project-root", str(root),
             "recover", "resolve", op_id, "--resolution", "replan", "--json"],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            env=hermetic_env(), timeout=600,
        )
        settled = json.loads(completed.stdout)
        self.assertTrue(settled.get("ok"), settled)
        self.assertNotEqual(
            recovery_preflight(root).get("code"),
            "RECOVERY_CONFLICT",
            "the named command ran and the state did not move",
        )

    def test_an_empty_frontier_is_not_reported_as_index_minus_one(self) -> None:
        """A message a reader cannot act on is not a message."""
        root, op_id = self.fixture(self.plan(None), label="frontier")
        (root / "b.txt").write_bytes(b"B2")
        detail = str(recover(root, op_id).get("detail"))
        self.assertNotIn("index -1", detail, detail)
        self.assertIn("nothing before it has materialized", detail, detail)

    def test_a_second_recovery_is_stable_and_names_a_route(self) -> None:
        """Settled is settled, and the gate that follows is not a dead end.

        An operation that wrote nothing aborts, and an aborted operation then
        asks for an explicit resolution before further mutation. That is a gate
        with a command behind it, not the no-route refusal T-1358 removed.
        """
        root, op_id = self.fixture(self.plan(1), label="twice")
        first = recover(root, op_id)
        self.assertTrue(first.get("ok"), first)
        self.assertEqual(first.get("code"), "ABORTED", first)
        second = recover(root, op_id)
        self.assertEqual(second.get("code"), "ABORTED", second)
        self.assertIn("resolve", str(second.get("detail")), second)


if __name__ == "__main__":
    unittest.main(verbosity=2)
