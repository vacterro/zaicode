"""T-1442: a test family is evidence about the tree, not about its launcher.

Measured 2026-09-21: with SAIPEN_HOST_SESSION set -- any run launched from a
live OpenCode seat -- test_continue_chain and test_conformance_repair_boundary
failed and passed outside one: a fixture's resumed parent read as claimed by the
operator's session. The harness list `isolate_host_session` strips lacked the
carrier, and test_continue_chain kept its own remembered list. Both now follow
the engine's one list (`paths.PROJECT_BINDING_ENV`), and the family runner no
longer hands any family the operator's binding, host session or seat.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.paths import PROJECT_BINDING_ENV  # noqa: E402
from saipen_engine.test_runner import TestFamily, _run_family  # noqa: E402

OPERATOR = {
    "SAIPEN_HOST_SESSION": "ses_operator_live",
    "SAIPEN_PROJECT_ROOT": str(Path(tempfile.gettempdir()) / "saipen-live-project"),
    "SAIPEN_PROJECT_LINEAGE": "lineage-" + "e" * 32,
    "SAIPEN_AGENT": "astra",
    "PWD": str(Path(tempfile.gettempdir()) / "saipen-live-project"),
}
PROBE = (
    "import json, os; print(json.dumps({k: os.environ.get(k) for k in "
    + repr(sorted({*OPERATOR, *PROJECT_BINDING_ENV}))
    + "}))"
)


class FamilyEnvironmentTests(unittest.TestCase):
    def test_a_family_child_inherits_no_operator_binding_session_or_seat(self):
        with tempfile.TemporaryDirectory(prefix="saipen-t1442-") as tmp:
            root = Path(tmp)
            spool = root / "spool"
            spool.mkdir()
            with mock.patch.dict(os.environ, OPERATOR):
                report = _run_family(
                    root, TestFamily("probe", (sys.executable, "-c", PROBE), 60), spool=spool
                )
            self.assertEqual(report["status"], "PASS", report)
            seen = json.loads((spool / "stdout").read_text(encoding="utf-8"))
        self.assertEqual({key: value for key, value in seen.items() if value}, {})


if __name__ == "__main__":
    unittest.main()
