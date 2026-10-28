"""T-1434 M8: the required cross-shape regression INDEX.

Every shape SRC-088 recovered has ONE executable owner (an existing suite and
test method) or a LIVE acceptance evidence file. This gate does not duplicate
the logic: it proves the owners still exist, so a future rename or deletion of
a shape's control fails here instead of silently shrinking the regression
surface. The M8.1 family run executes the suites themselves.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent

#: (shape, suite file, class, method) -- None method means the whole suite.
SHAPES = (
    (
        "normal single-repo project",
        "test_work_reverify_cli.py",
        "WorkReverifyCliTests",
        "test_successful_reverify_clears_only_the_current_tree_defect",
    ),
    (
        "ticket satisfied by dependency upgrade",
        "test_external_resolution.py",
        "ExternalResolutionTests",
        "test_dependency_rollback_turns_a_closure_non_green",
    ),
    (
        "external protocol-home implementation verified locally",
        "test_external_resolution.py",
        "ExternalResolutionTests",
        "test_local_defect_fixed_upstream_and_verified_locally",
    ),
    (
        "stale source with zero actionable requirements",
        "test_source_retirement.py",
        "SourceRetirementTests",
        "test_empty_stale_source_retires_with_preserved_bytes",
    ),
    (
        "source with actionable unresolved requirement",
        "test_source_retirement.py",
        "SourceRetirementTests",
        "test_unknown_and_blocked_requirements_refuse_and_name_the_route",
    ),
    (
        "strict Improve stale COMPLETE seat",
        "test_improve_reconcile.py",
        "ReconcileTests",
        "test_03_stale_complete_supersedes_onto_fresh_replacement",
    ),
    (
        "strict Improve externally blocked terminal seat",
        "test_improve_reconcile.py",
        "ReconcileTests",
        "test_08_blocked_external_seat_terminalizes_cycle",
    ),
    (
        "current-tree work reverify",
        "test_work_reverify_cli.py",
        "WorkReverifyCliTests",
        "test_attested_only_pass_never_cures_closure_evidence",
    ),
    (
        "stale current-tree verification after tree changes",
        "test_reverify.py",
        "LatestPassTests",
        "test_stale_checkpoint_receipt_is_not_current_tree_evidence",
    ),
    (
        "immutable historical evidence",
        "test_work_reverify_cli.py",
        "WorkReverifyCliTests",
        "test_reverify_preserves_done_and_historical_bytes",
    ),
    (
        "explicit foreign read-only project observation",
        "test_foreign_observation_authority.py",
        "ForeignObservationCliTests",
        "test_status_observes_foreign_project_with_ambient_a_carriers",
    ),
    (
        "wrong-project mutation refusal",
        "test_foreign_observation_authority.py",
        "ForeignObservationCliTests",
        "test_mutation_against_foreign_project_is_refused",
    ),
)

#: Shapes whose owner is LIVE project evidence rather than a synthetic fixture.
LIVE_SHAPES = (
    (
        "project using shared SAIPEN engine",
        ".saipen/evidence/T-1434-limisaw-problem-20260920/M7-REPORT.md",
    ),
    ("validator remediation self-consistency", "tools/test_remediation_self_consistency.py"),
)


def _class_methods(source: str) -> dict:
    tree = ast.parse(source)
    found: dict = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            found[node.name] = {
                item.name
                for item in node.body
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
    return found


class CrossShapeIndexTests(unittest.TestCase):
    def test_every_shape_has_a_living_owner(self):
        for shape, suite, klass, method in SHAPES:
            with self.subTest(shape=shape):
                path = TOOLS / suite
                self.assertTrue(path.is_file(), f"{shape}: suite {suite} is missing")
                methods = _class_methods(path.read_text(encoding="utf-8"))
                self.assertIn(
                    klass,
                    methods,
                    f"{shape}: class {klass} is missing from {suite}",
                )
                self.assertIn(
                    method,
                    methods[klass],
                    f"{shape}: {klass}.{method} is missing from {suite}",
                )

    def test_live_shapes_keep_their_evidence(self):
        for shape, relative in LIVE_SHAPES:
            with self.subTest(shape=shape):
                self.assertTrue(
                    (ROOT / relative).is_file(),
                    f"{shape}: evidence {relative} is missing",
                )


if __name__ == "__main__":
    unittest.main()
