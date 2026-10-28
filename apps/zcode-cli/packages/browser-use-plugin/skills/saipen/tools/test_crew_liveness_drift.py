"""T-1159 regression tests: crew continuation liveness + runtime drift.

Incident shape: an actionable crew carrier (RUN_ROLE,
execute_in_current_agent=true, requires_human=false) was answered
identically forever while a weak agent re-polled `cc`/`sc` instead of
executing the role; separately, a stale installed runtime answered a project
command with a bare ``unknown command``.

Proven here:
- actionable carriers carry a deterministic action_fingerprint;
- the SAME fingerprint twice in a row is surfaced as CREW_STALLED;
- real progress (a fingerprintless engine result) clears the projection;
- --dry-run and read-only sessions never write the projection;
- an unknown command in a project whose saipen_home names a DIFFERENT install
  is diagnosed RUNTIME_DRIFT (both versions named), never bare unknown;
- `cc`/`continue` and `sc`/`crew` alias pairs share one canonical route.

Run standalone:
    python tools/test_crew_liveness_drift.py

Exit code 0 when every test passes.
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(TOOLS))

from saipen_engine import crew as C  # noqa: E402
from saipen_engine import liveness as L  # noqa: E402
from saipen_engine import state as S  # noqa: E402
from saipen_engine.result import Result  # noqa: E402
import saipen as CLI  # noqa: E402

REPO = TOOLS.parent


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "proj"
        self.root.mkdir()
        fixture = REPO / "tests/scenarios/done-wait-deadlock-goal-mode/.saipen"
        shutil.copytree(fixture, self.root / ".saipen")
        state_path = self.root / ".saipen/STATE.md"
        state_path.write_text(
            S.patch_state(
                state_path.read_text(encoding="utf-8"),
                {"saipen_home": str(REPO.resolve())},
            ),
            encoding="utf-8",
            newline="\n",
        )

    def cli(self, *args: str) -> tuple[int, dict]:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc = CLI.main(["--json", "--project-root", str(self.root), *args])
        try:
            payload = json.loads(buffer.getvalue())
        except ValueError:
            payload = {"_raw": buffer.getvalue()}
        return rc, payload


class FingerprintTests(_Fixture):
    def test_deterministic_and_sensitive(self):
        base = dict(
            stage="SC-2",
            role="saihunt",
            action=None,
            reason=[{"stage": "SC-2", "reason": "role/package evidence is stale"}],
            source="git-delta-v1:aaa",
        )
        first = C._carrier_fingerprint(
            {
                "first_unsatisfied": base["stage"],
                "stages": [
                    {"stage": "SC-0", "state": "SATISFIED", "reason": ""},
                    base["reason"][0] | {"state": "UNSATISFIED"},
                ],
                "source": {"source_tree_fingerprint": base["source"]},
            }
        )
        second = C._carrier_fingerprint(
            {
                "first_unsatisfied": base["stage"],
                "stages": [
                    {"stage": "SC-0", "state": "SATISFIED", "reason": ""},
                    base["reason"][0] | {"state": "UNSATISFIED"},
                ],
                "source": {"source_tree_fingerprint": base["source"]},
            }
        )
        self.assertEqual(first, second)
        self.assertNotEqual(first, "")
        # Fresh evidence changes the stage reason -> different fingerprint.
        changed_reason = C._carrier_fingerprint(
            {
                "first_unsatisfied": base["stage"],
                "stages": [
                    {"stage": "SC-0", "state": "SATISFIED", "reason": ""},
                    {
                        "stage": "SC-2",
                        "state": "UNSATISFIED",
                        "reason": "package rejected: coverage gap",
                    },
                ],
                "source": {"source_tree_fingerprint": base["source"]},
            }
        )
        self.assertNotEqual(first, changed_reason)
        # A source change alone also moves it.
        changed_source = C._carrier_fingerprint(
            {
                "first_unsatisfied": base["stage"],
                "stages": [
                    {"stage": "SC-0", "state": "SATISFIED", "reason": ""},
                    base["reason"][0] | {"state": "UNSATISFIED"},
                ],
                "source": {"source_tree_fingerprint": "git-delta-v1:bbb"},
            }
        )
        self.assertNotEqual(first, changed_source)


class LivenessTrackerTests(_Fixture):
    def test_second_identical_actionable_is_stall(self):
        fp = L.action_fingerprint(stage="SC-2", role="saihunt", reason="stale")
        first = L.record_actionable(self.root, fp)
        self.assertFalse(first["stalled"])
        self.assertEqual(first["stall_repeats"], 1)
        second = L.record_actionable(self.root, fp)
        self.assertTrue(second["stalled"])
        self.assertEqual(second["stall_repeats"], 2)

    def test_progress_resets_and_clear(self):
        fp = L.action_fingerprint(stage="SC-2", reason="stale")
        L.record_actionable(self.root, fp)
        L.record_actionable(self.root, fp)
        self.assertTrue(L.record_actionable(self.root, fp)["stalled"])
        # Replan produced different actionable content -> counting restarts.
        fresh = L.record_actionable(self.root, fp[:-1] + ("0" if fp[-1] != "0" else "1"))
        self.assertFalse(fresh["stalled"])
        self.assertEqual(fresh["stall_repeats"], 1)
        # Engine progress clears the projection entirely.
        L.clear(self.root)
        after = L.record_actionable(self.root, fp)
        self.assertFalse(after["stalled"])

    def test_corrupt_carrier_degrades_to_first_observation(self):
        cache = self.root / L.CACHE_REL
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text("not json at all", encoding="utf-8")
        verdict = L.record_actionable(
            self.root, L.action_fingerprint(stage="SC-9", reason="x")
        )
        self.assertFalse(verdict["stalled"])


class CrewCliLivenessTests(_Fixture):
    """End-to-end through CLI._crew with crew_apply stubbed at the seam."""

    def _stub_apply(self, fingerprint: str | None):
        data = {
            "plan": {"first_unsatisfied": "SC-2"},
            "execute_in_current_agent": True,
            "requires_human": False,
            "terminal": False,
        }
        if fingerprint:
            data["action_fingerprint"] = fingerprint
        return Result(ok=True, code="CREW_ACTION", data=data)

    def test_identical_actionable_twice_reports_stall_not_silence(self):
        fp = L.action_fingerprint(stage="SC-2", role="saihunt", reason="stale")
        with mock.patch.object(C, "crew_apply", return_value=self._stub_apply(fp)):
            _rc1, first = self.cli("crew")
            _rc2, second = self.cli("crew")
        self.assertNotIn("liveness", first)
        stall = second.get("liveness") or {}
        self.assertTrue(stall.get("stalled"))
        self.assertEqual(stall.get("verdict"), "CREW_STALLED")
        self.assertGreaterEqual(stall.get("stall_repeats", 0), 2)
        # The carrier itself stays truthful and non-terminal: still actionable,
        # still naming the current agent as runner -- a stall verdict ADDS
        # information, it never downgrades the action to user work.
        self.assertEqual(second.get("action_fingerprint"), fp)
        self.assertTrue(second.get("execute_in_current_agent"))
        self.assertFalse(second.get("requires_human"))

    def test_engine_progress_clears_stall_memory(self):
        fp = L.action_fingerprint(stage="SC-2", role="saihunt", reason="stale")
        with mock.patch.object(C, "crew_apply", return_value=self._stub_apply(fp)):
            self.cli("crew")
            self.cli("crew")
        progressed = Result(
            ok=True,
            code="SUB_SYNCED",
            data={"mechanical": True},  # no fingerprint == engine executed work
        )
        with mock.patch.object(C, "crew_apply", return_value=progressed):
            _rc, payload = self.cli("crew")
        self.assertNotIn("liveness", payload)
        self.assertFalse((self.root / L.CACHE_REL).exists())

    def test_dry_run_never_writes_projection(self):
        fp = L.action_fingerprint(stage="SC-2", role="saihunt", reason="stale")
        buffer = io.StringIO()
        stub = mock.patch.object(C, "crew_apply", return_value=self._stub_apply(fp))
        env = mock.patch.dict("os.environ", {"SAIPEN_CAPABILITY": "full"})
        with stub, contextlib.redirect_stdout(buffer), env:
            CLI.main(["--json", "--dry-run", "--project-root", str(self.root), "crew"])
        self.assertFalse((self.root / L.CACHE_REL).exists())

    def test_readonly_session_never_writes_projection(self):
        fp = L.action_fingerprint(stage="SC-2", role="saihunt", reason="stale")
        buffer = io.StringIO()
        stub = mock.patch.object(C, "crew_apply", return_value=self._stub_apply(fp))
        env = mock.patch.dict("os.environ", {"SAIPEN_CAPABILITY": "read-only"})
        with stub, contextlib.redirect_stdout(buffer), env:
            CLI.main(["--json", "--project-root", str(self.root), "crew"])
        self.assertFalse((self.root / L.CACHE_REL).exists())


class RuntimeDriftTests(_Fixture):
    def _point_home_at_fake_install(self) -> Path:
        fake = Path(self._tmp.name) / "old-install"
        (fake / "tools").mkdir(parents=True)
        (fake / "VERSION").write_text("9.9.9", encoding="utf-8")
        state_path = self.root / ".saipen/STATE.md"
        state_path.write_text(
            S.patch_state(
                state_path.read_text(encoding="utf-8"),
                {"saipen_home": str(fake)},
            ),
            encoding="utf-8",
            newline="\n",
        )
        return fake

    def test_unknown_command_with_foreign_home_is_runtime_drift(self):
        fake = self._point_home_at_fake_install()
        # A token this runtime genuinely does not implement.
        rc, payload = self.cli("frobnicate")
        self.assertEqual(rc, 2)
        self.assertEqual(payload.get("code"), "RUNTIME_DRIFT")
        self.assertEqual(payload["project_protocol"]["version"], "9.9.9")
        self.assertIn(str(fake).lower(), str(payload["project_protocol"]["home"]).lower())
        self.assertNotEqual(payload["runtime"]["home"], payload["project_protocol"]["home"])
        self.assertTrue(payload["action"])

    def test_known_command_with_foreign_home_executes_normally(self):
        # Drift diagnosis is scoped to UNKNOWN commands only: a command this
        # runtime implements must never be blocked by a foreign saipen_home.
        self._point_home_at_fake_install()
        _rc, payload = self.cli("status")
        self.assertNotEqual(payload.get("code"), "RUNTIME_DRIFT")

    def test_same_home_unknown_command_stays_plain(self):
        # saipen_home == executing runtime: an unknown token is the ordinary
        # adapter refusal, never a drift verdict.
        rc, payload = self.cli("frobnicate")
        self.assertEqual(rc, 2)
        self.assertEqual(payload.get("code"), "VALIDATION_FAILED")

    def test_no_state_no_drift_claim(self):
        empty = Path(self._tmp.name) / "bare"
        empty.mkdir()
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            CLI.main(["--json", "--project-root", str(empty), "frobnicate"])
        payload = json.loads(buffer.getvalue())
        self.assertNotEqual(payload.get("code"), "RUNTIME_DRIFT")


class AliasEquivalenceTests(_Fixture):
    """CC-11: cc/continue and sc/crew resolve to one canonical implementation."""

    def test_cc_and_continue_share_semantics(self):
        # T-20260830_0842: the canonical fallthrough may emit different
        # verifiable codes for the SAME project across two invocations --
        # the first prepares the improvement cycle, the second resumes it
        # (CONTINUE_IMPROVE_IN_FLIGHT). The alias-equivalence contract is
        # `rc` + the structural "ok" verdict, not byte-identical `code`,
        # because project state mutates between the two calls. We assert
        # both invocations on a FRESH copy of the project to keep the
        # canonical state identical at each entry.
        other = Path(self._tmp.name) / "proj-b"
        shutil.copytree(self.root, other)
        rc_a, payload_a = self.cli("cc")
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc_b = CLI.main(["--json", "--project-root", str(other), "continue"])
        payload_b = json.loads(buffer.getvalue())
        self.assertEqual(rc_a, rc_b)
        self.assertEqual(payload_a.get("ok"), payload_b.get("ok"))
        self.assertEqual(
            payload_a.get("code"),
            payload_b.get("code"),
            f"cc and continue must be the same route; "
            f"got {payload_a.get('code')} vs {payload_b.get('code')}",
        )

    def test_sc_and_crew_are_one_route(self):
        rc_a, payload_a = self.cli("crew", "--dry-run")
        other = Path(self._tmp.name) / "proj-c"
        shutil.copytree(self.root, other)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc_b = CLI.main(["--json", "--project-root", str(other), "sc", "--dry-run"])
        payload_b = json.loads(buffer.getvalue())
        self.assertEqual(rc_a, rc_b)
        self.assertEqual(payload_a.get("code"), payload_b.get("code"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
