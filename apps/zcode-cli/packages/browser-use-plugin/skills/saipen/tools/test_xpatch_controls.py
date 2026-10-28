"""Red controls for the XPATCH hostile suite (T-1256).

A passing test proves nothing until it is shown to FAIL when the guard it
watches is removed. This module mutates one guard at a time and asserts the
matching case in `test_xpatch.py` goes red. A control that stays green under
its own mutation is not evidence, it is decoration -- exactly the failure
mode that killed the CHANGELOG-order control twice (T-1245).
"""

from __future__ import annotations

import io
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_xpatch
from saipen_engine import xpatch


def _run(case_class, method: str) -> unittest.TestResult:
    suite = unittest.TestSuite([case_class(method)])
    with io.StringIO() as sink:
        return unittest.TextTestRunner(stream=sink, verbosity=0).run(suite)


class ControlsAreRed(unittest.TestCase):
    def assert_red(self, case_class, method: str) -> None:
        result = _run(case_class, method)
        self.assertFalse(
            result.wasSuccessful(),
            f"{case_class.__name__}.{method} stayed green with its guard removed -- "
            "it is not a control",
        )

    def assert_green(self, case_class, method: str) -> None:
        result = _run(case_class, method)
        self.assertTrue(result.wasSuccessful(), f"{case_class.__name__}.{method} is red unmutated")

    def test_namespace_boundary_control_is_red(self) -> None:
        self.assert_green(
            test_xpatch.NamespaceBoundary, "test_target_protocol_state_is_never_writable"
        )
        with mock.patch.object(xpatch, "canonical_target_path", lambda root, rel: rel):
            self.assert_red(
                test_xpatch.NamespaceBoundary, "test_target_protocol_state_is_never_writable"
            )

    def test_lineage_binding_control_is_red(self) -> None:
        method = "test_foreign_target_lineage_does_not_bind"
        self.assert_green(test_xpatch.ForgedAndForeignReceipts, method)
        from saipen_engine import paths

        with mock.patch.object(
            paths, "project_lineage_identity", lambda root: test_xpatch.FOREIGN_LINEAGE
        ):
            self.assert_red(test_xpatch.ForgedAndForeignReceipts, method)

    def test_before_hash_cas_control_is_red(self) -> None:
        method = "test_target_moved_before_apply_yields_zero_writes"
        self.assert_green(test_xpatch.DriftAndCas, method)
        real = xpatch._file_sha256

        def blind(path):
            # A CAS that answers "whatever you expected" is no CAS at all.
            return real(path) if ".saipen" in str(path) else None

        with mock.patch.object(xpatch, "_file_sha256", blind):
            self.assert_red(test_xpatch.DriftAndCas, method)

    def test_payload_hash_control_is_red(self) -> None:
        method = "test_forged_after_hash_is_caught_at_apply"
        self.assert_green(test_xpatch.ForgedAndForeignReceipts, method)
        with mock.patch.object(xpatch, "sha256_hex", lambda raw: "f" * 64):
            self.assert_red(test_xpatch.ForgedAndForeignReceipts, method)

    def test_revert_clobber_control_is_red(self) -> None:
        method = "test_revert_refuses_once_the_bytes_moved_on"
        self.assert_green(test_xpatch.DriftAndCas, method)
        real = xpatch.load_receipt

        def blind_receipt(root, patch_id):
            receipt = real(root, patch_id)
            # Pretend every declared after-state still holds: the exact lie a
            # blind reverse-patch tells itself before eating later work.
            for spec in receipt.paths.values():
                spec["after_sha256"] = xpatch._file_sha256(Path(root) / next(iter(receipt.paths)))
            return receipt

        with mock.patch.object(xpatch, "load_receipt", blind_receipt):
            self.assert_red(test_xpatch.DriftAndCas, method)


if __name__ == "__main__":
    unittest.main()
