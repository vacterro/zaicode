"""T-1484: a soak run's evidence never dies with its project.

Measured 2026-09-23 (.saipen/evidence/T-1446-field-24h-20260923, incident
note): the relaunched 24H gate's fixture project vanished whole at a
generation boundary, `supervise` stopped, and `tools/t1446_field_soak.py`
died in `assess()` on FileNotFoundError for BOARD.md -- so report.json, with
the supervise counters, the history and the GPU lane summary, was never
written. 35 minutes of field evidence reduced to one interim line.

The regression drives the REAL driver `main()`; only the agent host and the
supervisor are replaced, and the fake supervisor removes the project exactly
as the incident did.
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import t1446_field_soak as soak  # noqa: E402


class VanishedProjectReportTests(unittest.TestCase):
    def setUp(self) -> None:
        base = Path(tempfile.mkdtemp(prefix="saipen-t1484-"))
        self.addCleanup(shutil.rmtree, base, ignore_errors=True)
        self.project = base / "project"
        (self.project / ".saipen").mkdir(parents=True)
        (self.project / ".saipen" / "BOARD.md").write_text(
            "## DOING\n## TODO\n## DONE\n", encoding="utf-8"
        )
        self.out = base / "out"

    def drive(self, supervise) -> dict:
        argv = ["t1446_field_soak.py", "--model", "m", "--wall-seconds", "5"]
        argv += ["--interim-every", "3600", "--out", str(self.out)]
        for patcher in (
            mock.patch.object(sys, "argv", argv),
            mock.patch.object(soak, "OPENCODE", "opencode"),
            mock.patch.object(soak, "build_project", return_value=self.project),
            mock.patch.object(soak.worker, "supervise", supervise),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.assertEqual(soak.main(), 0)
        return json.loads((self.out / "report.json").read_text(encoding="utf-8"))

    def test_a_project_that_vanished_mid_run_still_gets_its_report(self):
        def vanishing_supervise(root, *_args, **_kwargs):
            shutil.rmtree(root)
            return {
                "ok": False,
                "code": "SUPERVISE_STOPPED",
                "stop": "AMBIGUOUS_AUTHORITY",
                "counters": {"cycles": 4, "worker_generation_count": 4},
                "gpu_lane": {"runs": 3, "embedded": 6},
                "history": [{"cycle": 1, "generation": 1, "progressed": True}],
            }

        report = self.drive(vanishing_supervise)
        self.assertEqual(report["quality"]["verdict"], "PROJECT_VANISHED")
        self.assertEqual(report["supervise"]["counters"]["cycles"], 4)
        self.assertEqual(report["supervise"]["gpu_lane"]["runs"], 3)
        self.assertEqual(report["efficiency"]["generations"], 1)

    def test_an_assessment_that_breaks_is_named_not_fatal(self):
        def quiet_supervise(*_args, **_kwargs):
            return {"ok": True, "code": "SUPERVISE_STOPPED", "stop": "IDLE", "history": []}

        with mock.patch.object(soak, "assess", side_effect=OSError("validator gone")):
            report = self.drive(quiet_supervise)
        self.assertEqual(report["quality"]["verdict"], "ASSESS_FAILED")
        self.assertIn("validator gone", report["quality"]["error"])


if __name__ == "__main__":
    unittest.main()
