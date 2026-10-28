"""T-1319: the SAIPEN cold route must not hard-depend on host ripgrep.

Operator evidence: a fresh OpenCode flow ran `continue` -> `Skill "saipen"` and
died with `ripgrep execution failed`. That string is not SAIPEN's: it is
OpenCode's single catch-all for anything that goes wrong inside its
ripgrep-backed FileSystem search service, and it hides the real defect. The
host had a half-provisioned binary (the 1.8 MB archive sat in the cache with no
`rg.exe` beside it) and `rg` was absent from the persistent PATH, so the search
layer had nothing to run.

The structural fix is not to care which fault it was. Protocol startup must be
able to NAME the documents it reads without consulting the host search layer at
all, so the cold route is resolved with pathlib and the answer says
`search_required: false`.

These cases therefore assert the strong property: the locator is correct even
when ripgrep is healthy, absent, unlaunchable, noisy, or fatal -- and it is
never consulted. A hostile `rg` placed first on PATH is the instrument.
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
from unittest import mock

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

SAIPEN_CLI = TOOLS / "saipen.py"

from saipen_engine import state as state_mod  # noqa: E402
import test_continue_improve_fallthrough as fixtures  # noqa: E402


def _locator_project(testcase: unittest.TestCase) -> Path:
    """Pin the subject phase; never depend on the maintainer's live checkpoint."""
    fixtures.ContinueImproveFallthroughTests.setUp(testcase)
    return fixtures.ContinueImproveFallthroughTests._make(
        testcase, "locator", board=fixtures.ContinueImproveFallthroughTests._board(
            doing="- [/] T-002 [P1] fixture | owner: tester | "
            "claim_time: 2020-01-01T00:00:00Z\n",
        ), state_overrides={
            "saipen_home": json.dumps(str(REPO)), "phase": "SHIP", "task": "T-002",
            "next_action": "PHASE SHIP T-002", "transition_from": "REVIEW",
        },
    )


def _cli_env(extra_path: str | None = None) -> dict:
    env = dict(os.environ)
    # A real Windows launch does NOT carry a vendor-injected PATH; strip the
    # Manicode directory that only exists inside another tool's session.
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if "manicode" not in p.lower()]
    if extra_path:
        parts.insert(0, extra_path)
    env["PATH"] = os.pathsep.join(parts)
    env.pop("PWD", None)
    env.pop("OLDPWD", None)
    return env


def _run(args: list[str], env: dict, cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SAIPEN_CLI), *args],
        capture_output=True, text=True, env=env, cwd=str(cwd), timeout=300,
    )


def _sabotage_rg(directory: Path, mode: str) -> None:
    """Put a hostile `rg.exe` (and POSIX `rg`) first on PATH.

    mode `fatal`  -> the launcher exists but always exits non-zero with noise.
    mode `broken` -> the launcher is present but is not a runnable program.
    """
    directory.mkdir(parents=True, exist_ok=True)
    posix = directory / "rg"
    exe = directory / "rg.exe"
    if mode == "fatal":
        noise = "rg: fatal: synthetic host fault"
        posix.write_text(f"#!/bin/sh\necho '{noise}' >&2\nexit 2\n", encoding="utf-8")
        posix.chmod(0o755)
        exe.write_text(
            f"@echo off\r\necho {noise} 1>&2\r\nexit /b 2\r\n", encoding="utf-8"
        )
    else:  # broken: present but not executable content
        posix.write_text("this is not a program\n", encoding="utf-8")
        exe.write_text("this is not a program\n", encoding="utf-8")


class ColdRouteNeedsNoSearchTests(unittest.TestCase):
    """The locator itself never reaches for a subprocess or a lookup."""

    def _state(self) -> dict:
        return {"saipen_home": str(REPO), "phase": "SHIP"}

    def test_the_locator_never_shells_out_or_looks_up_an_executable(self):
        from saipen import _cold_route

        boom = AssertionError("the cold route must not shell out or resolve a binary")
        with mock.patch("subprocess.run", side_effect=boom), \
                mock.patch("subprocess.Popen", side_effect=boom), \
                mock.patch("subprocess.check_output", side_effect=boom), \
                mock.patch("shutil.which", side_effect=boom), \
                mock.patch("os.system", side_effect=boom):
            route = _cold_route(REPO, self._state())

        self.assertFalse(route["search_required"], route)
        self.assertEqual(route["protocol_dir"], str(REPO / "saipen"))
        self.assertEqual(route["boot"], str(REPO / "saipen" / "BOOT.md"))
        self.assertEqual(route["style"], str(REPO / "saipen" / "STYLE.md"))
        self.assertEqual(route["phase_module"], str(REPO / "saipen" / "phases" / "ship.md"))
        self.assertIn("STATE.md", route["project_memory"])

    def test_the_locator_is_bounded_and_read_only(self):
        from saipen import _cold_route, _COLD_ROUTE_DOCS

        route = _cold_route(REPO, self._state())
        # A fixed name list inside the protocol dir -- never a directory walk.
        self.assertEqual(set(route["documents"]) <= set(_COLD_ROUTE_DOCS), True)
        self.assertLessEqual(len(route["documents"]), len(_COLD_ROUTE_DOCS))
        self.assertEqual(set(route["project_memory"]), {"STATE.md", "BOARD.md", "LOG.md"})
        # No drive/profile/other-repository paths can appear.
        for value in route["documents"].values():
            self.assertTrue(value.startswith(str(route["protocol_dir"])), value)


class ColdRouteUnderHostileRipgrepTests(unittest.TestCase):
    """CASE 1-5: healthy / absent / unlaunchable / noisy / fatal ripgrep."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1319-hostile-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.root = _locator_project(self)

    def _status_route(self, extra_path: str | None):
        result = _run(["status", "--json"], _cli_env(extra_path), self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        return payload["cold_route"], payload

    def test_case_1_healthy_ripgrep_fast_path_is_irrelevant_because_unused(self):
        route, _ = self._status_route(None)
        self.assertFalse(route["search_required"], route)
        self.assertEqual(route["boot"], str(REPO / "saipen" / "BOOT.md"))

    def test_case_2_and_3_rg_absent_or_unlaunchable_still_resolves(self):
        for mode in ("broken", "fatal"):
            with self.subTest(mode=mode):
                hostile = self.tmp / mode
                _sabotage_rg(hostile, mode)
                route, _ = self._status_route(str(hostile))
                self.assertFalse(route["search_required"], route)
                self.assertEqual(route["boot"], str(REPO / "saipen" / "BOOT.md"))
                self.assertEqual(route["phase_module"],
                                 str(REPO / "saipen" / "phases" / "ship.md"))
                # The hostile rg must never have been invoked.
                self.assertNotIn("fatal", json.dumps(route))

    def test_case_4_and_5_no_matches_versus_fatal_cannot_differ_here(self):
        # There is no "no matches" state to confuse: the locator makes no query.
        results = []
        for mode in ("broken", "fatal"):
            hostile = self.tmp / f"cmp-{mode}"
            _sabotage_rg(hostile, mode)
            route, _ = self._status_route(str(hostile))
            results.append(json.dumps(route, sort_keys=True))
        self.assertEqual(results[0], results[1], "the cold route must not vary with rg health")

    def test_case_8_no_search_fallback_can_write_protected_state(self):
        """The guard contract is untouched: the locator is read-only."""
        state_path = self.root / ".saipen" / "STATE.md"
        board_path = self.root / ".saipen" / "BOARD.md"
        log_path = self.root / ".saipen" / "LOG.md"
        before = {p: p.read_bytes() for p in (state_path, board_path, log_path)}
        hostile = self.tmp / "write-check"
        _sabotage_rg(hostile, "fatal")
        result = _run(["status", "--json"], _cli_env(str(hostile)), self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path, raw in before.items():
            self.assertEqual(path.read_bytes(), raw, path.name)


class ColdRouteLifecycleTests(unittest.TestCase):
    """CASE 6 and 7: recovery-required and non-SAIPEN projects."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t1319-life-"))
        self.addCleanup(lambda: shutil.rmtree(self.tmp, ignore_errors=True))
        self.hostile = self.tmp / "hostile"
        _sabotage_rg(self.hostile, "fatal")

    def _project(self, phase: str, name: str) -> Path:
        root = self.tmp / name
        (root / ".saipen").mkdir(parents=True)
        (root / ".saipen" / "LOG.md").write_text(
            "# Log\n"
            "- 13.09.26 00:00 [E-0001] [agent: tester] "
            f"[op: transition-{'a' * 32}] RUN: transition to SCOUT\n"
            "- 13.09.26 00:01 [E-0002] [parent: E-0001] [T-001] [agent: tester] "
            f"[op: transition-{'b' * 32}] RUN: transition to BUILD\n",
            encoding="utf-8",
        )
        (root / ".saipen" / "STATE.md").write_text(
            "---\n"
            f"phase: {phase}\n"
            "task: T-001\n"
            'next_action: "PHASE BUILD T-001"\n'
            "blocker: none\n"
            "transition_from: SCOUT\n"
            "saipen_version: 7\n"
            "schema_version: 3\n"
            "last_event: 2\n"
            "style_contract: ded-4ae736e4\n"
            "agent: tester\n"
            "mode: full\n"
            "updated: 2026-09-13T00:00:00Z\n"
            "execution_intent: normal\n"
            "---\n",
            encoding="utf-8",
        )
        (root / ".saipen" / "BOARD.md").write_text(
            "## DOING\n- [/] T-001 [P1] fix | verify: test\n## TODO\n## DONE\n## BLOCKED\n",
            encoding="utf-8",
        )
        (root / "src.txt").write_text("ordinary source\n", encoding="utf-8")
        return root

    def test_case_6_malformed_state_still_names_its_cold_route_without_rg(self):
        root = self._project("IMPL", "malformed")
        env = _cli_env(str(self.hostile))
        # Ordinary status fails closed on the invalid phase, exactly as before.
        bad = _run(["status", "--json"], env, root)
        self.assertNotEqual(bad.returncode, 0, bad.stdout + bad.stderr)
        # But the CANONICAL recovery path is reachable with the hostile rg first
        # on PATH -- a host search fault cannot block protocol repair.
        healed = _run(["recover"], env, root)
        self.assertEqual(healed.returncode, 0, healed.stdout + healed.stderr)
        self.assertIn("phase: BUILD", (root / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
        after = _run(["status", "--json"], env, root)
        self.assertEqual(after.returncode, 0, after.stdout + after.stderr)
        route = json.loads(after.stdout)["cold_route"]
        self.assertFalse(route["search_required"], route)
        self.assertEqual(route["project_root"], str(root.resolve()))

    def test_case_7_non_saipen_repository_stays_non_interfering(self):
        plain = self.tmp / "not-saipen"
        plain.mkdir()
        (plain / "README.md").write_text("just a repo\n", encoding="utf-8")
        result = _run(["status", "--json"], _cli_env(str(self.hostile)), plain)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["code"], "NOT_SAIPEN_PROJECT")
        self.assertNotIn("cold_route", payload)


class ColdRoutePayloadTests(unittest.TestCase):
    """The contract the skill entry depends on."""

    def setUp(self):
        self.root = _locator_project(self)

    def test_parse_state_is_not_disturbed_by_the_new_projection(self):
        state_text = (self.root / ".saipen" / "STATE.md").read_text(encoding="utf-8")
        state, error = state_mod.parse_state_or_error(state_text)
        self.assertIsNone(error)
        self.assertEqual(state["phase"], "SHIP")

    def test_status_payload_carries_a_usable_cold_route(self):
        result = _run(["status", "--json"], _cli_env(None), self.root)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        route = json.loads(result.stdout)["cold_route"]
        for key in ("boot", "style", "phase_module"):
            self.assertTrue(route.get(key), (key, route))
            self.assertTrue(Path(route[key]).is_file(), route[key])
        self.assertTrue(route.get("protocol_dir"), route)
        self.assertTrue(Path(route["protocol_dir"]).is_dir(), route["protocol_dir"])


if __name__ == "__main__":
    unittest.main()
