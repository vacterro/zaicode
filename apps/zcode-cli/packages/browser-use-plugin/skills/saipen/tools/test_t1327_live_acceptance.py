"""T-1327 TARGET F: zero-manual acceptance against a REAL OpenCode process.

The production incident was not that SAIPEN lacked a repair -- it had one, and
named it exactly. The incident was that reaching it took an operator shell:
`saipen ticket compact T-158` by hand, then `bootstrap/inject.ps1` by hand,
then hash comparison by eye. This gate proves the whole sequence now happens
without any of that.

What the OPERATOR does here, and nothing more:

1. bootstrap the host runtime through the canonical SAIPEN operation
   (`saipen runtime --prelaunch --adapter opencode`) -- never inject.ps1;
2. start a real `opencode` session in an AUDAPACK-shaped project;
3. ask the agent for one ordinary consequential edit.

What must then happen by itself: the installed generation is proven/resynced,
the guard consults Fleet, Fleet runs the EXACT canonical compaction, the stale
payload is refused, a fresh action lands, and the project is BOUND_VALID.

Opt-in: it needs the real host binary, git, and an OpenCode provider
credential, and it spends free-tier model tokens.

    SAIPEN_LIVE_OPENCODE=1 python -m unittest tools.test_t1327_live_acceptance -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import ClassVar

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.board import MAX_LIVE_RECORD_CHARS  # noqa: E402
from saipen_engine.fleet import preflight  # noqa: E402
from test_opencode_live_session import (  # noqa: E402
    AUTH_SOURCE,
    GIT,
    MODEL_CANDIDATES,
    OPENCODE,
    _git_project,
    _tool_events,
)
from test_t1327_zero_manual_recovery import _oversized_line  # noqa: E402

LIVE_ENABLED = os.environ.get("SAIPEN_LIVE_OPENCODE") == "1"
PYTHON = sys.executable
CLI = REPO / "tools" / "saipen.py"
DURABLE = REPO / ".saipen" / "evidence" / "T-1327-zero-manual-acceptance"

#: Refusal codes that would mean this work did NOT close the incident class.
FORBIDDEN_CODES = (
    "FLEET_OUTPUT_INVALID",
    "GUARD_UNREACHABLE",
    "ACTOR_UNBOUND",
    "SAIPEN_GUARD_UNINSTALLED",
)


@unittest.skipUnless(LIVE_ENABLED, "set SAIPEN_LIVE_OPENCODE=1 for the live proof")
@unittest.skipUnless(OPENCODE, "opencode runtime unavailable")
@unittest.skipUnless(GIT, "git unavailable for a real worktree fixture")
class ZeroManualLiveAcceptance(unittest.TestCase):
    proof: ClassVar[dict] = {}

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory(
            prefix="saipen-t1327-live-", ignore_cleanup_errors=True
        )
        base = Path(cls.tmp.name)
        cls.home = base / "home"
        cls.cache = base / "cache"
        (cls.home / ".config" / "opencode").mkdir(parents=True)
        data = cls.home / ".local" / "share" / "opencode"
        data.mkdir(parents=True)
        cls.cache.mkdir(parents=True)
        if not AUTH_SOURCE.is_file():
            raise unittest.SkipTest(f"no OpenCode provider credential at {AUTH_SOURCE}")
        shutil.copy2(AUTH_SOURCE, data / "auth.json")
        cls.proof = {}

        # STEP 1 -- the ONLY bootstrap the operator performs. Not inject.ps1,
        # not a hash comparison: one canonical SAIPEN operation, into an
        # isolated home that starts with NO installed runtime at all.
        started = time.time()
        proc = subprocess.run(
            [PYTHON, str(CLI), "runtime", "--prelaunch", "--adapter", "opencode", "--json"],
            capture_output=True, text=True, env=cls._host_env(), timeout=900, check=False,
            cwd=str(base),
        )
        cls.prelaunch_rc = proc.returncode
        cls.prelaunch_stdout = proc.stdout
        cls.prelaunch_stderr = proc.stderr
        try:
            cls.prelaunch = json.loads(proc.stdout)
        except json.JSONDecodeError:
            cls.prelaunch = {}
        cls.prelaunch_ms = int((time.time() - started) * 1000)

        # STEP 2 -- an AUDAPACK-shaped project: DOING work whose BOARD record
        # is a legacy oversized row, exactly the state that deadlocked.
        cls.project = _git_project(
            phase="BUILD", task="T-158", next_action="PHASE BUILD T-158", agent="test-agent"
        )
        board = "## DOING\n" + _oversized_line("T-158") + "## TODO\n## DONE\n## BLOCKED\n"
        (cls.project / ".saipen" / "BOARD.md").write_text(board, encoding="utf-8")
        subprocess.run(
            [GIT, "-C", str(cls.project), "add", "-A"], capture_output=True, check=False
        )
        cls.board_before = board
        cls.state_before = preflight(
            cls.project, explicit_root=cls.project, honor_environment=False
        )
        cls.target = cls.project / "src" / "agent_note.txt"

        # STEP 3 -- one real session, one ordinary consequential edit. The
        # prompt never mentions compaction, recovery or injection: a user
        # asking for ordinary work is the whole point.
        cls.session = cls._session(
            "SAIPEN ordinary work probe. "
            f"Step 1: write the file {cls.target} with the exact content ok. "
            "Step 2: if that write was refused, report the exact refusal code, then "
            "write the same file again with the exact content ok. "
            "Do not run any shell command. Do not ask the user any question. "
            "End with the line PROBE_DONE"
        )
        cls.state_after = preflight(
            cls.project, explicit_root=cls.project, honor_environment=False
        )

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            DURABLE.mkdir(parents=True, exist_ok=True)
            (DURABLE / "acceptance.json").write_text(
                json.dumps(
                    {
                        "prelaunch": cls.prelaunch,
                        "prelaunch_rc": cls.prelaunch_rc,
                        "prelaunch_ms": cls.prelaunch_ms,
                        "classification_before": cls.state_before.get("classification"),
                        "reason_before": cls.state_before.get("reason_code"),
                        "named_repair": cls.state_before.get("canonical_next_command"),
                        "classification_after": cls.state_after.get("classification"),
                        "session": cls.session,
                        "proof": cls.proof,
                    },
                    indent=2,
                )[:400000],
                encoding="utf-8",
            )
        except OSError:
            pass
        cls.tmp.cleanup()

    @classmethod
    def _host_env(cls, **overrides) -> dict:
        env = {
            **os.environ,
            "HOME": str(cls.home),
            "USERPROFILE": str(cls.home),
            "XDG_CACHE_HOME": str(cls.cache),
            "XDG_DATA_HOME": str(cls.home / ".local" / "share"),
            "npm_config_cache": str(cls.cache / "npm"),
            "BUN_INSTALL_CACHE_DIR": str(cls.cache / "bun"),
            "SAIPEN_PYTHON": PYTHON,
        }
        for key in ("SAIPEN_PROJECT_ROOT", "SAIPEN_PROJECT_LINEAGE", "SAIPEN_AGENT",
                    "SAIPEN_SKILL_ROOT", "SAIPEN_GUARD_STARTUP_PROBE", "PWD", "OLDPWD"):
            env.pop(key, None)
        env.update(overrides)
        return env

    @classmethod
    def _session(cls, prompt: str) -> dict:
        attempts = []
        for model in MODEL_CANDIDATES:
            proc = subprocess.run(
                [OPENCODE, "run", prompt, "--format", "json", "--auto", "--model", model],
                cwd=str(cls.project), env=cls._host_env(),
                capture_output=True, text=True, timeout=1800,
            )
            events = []
            for raw in proc.stdout.splitlines():
                line = raw.strip()
                if not line.startswith("{"):
                    continue
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            tools = _tool_events(events)
            attempt = {
                "model": model,
                "returncode": proc.returncode,
                "tool_events": tools,
                "stderr_tail": proc.stderr[-2000:],
            }
            attempts.append(attempt)
            if tools:
                return {"model": model, "attempts": attempts, "tool_events": tools}
        return {"model": None, "attempts": attempts, "tool_events": []}

    # --- the acceptance sequence -------------------------------------------

    def test_1_the_runtime_is_bootstrapped_without_operator_powershell(self) -> None:
        self.assertEqual(self.prelaunch_rc, 0, self.prelaunch_stdout + self.prelaunch_stderr)
        self.assertTrue(self.prelaunch.get("ok"), self.prelaunch)
        self.assertIn(self.prelaunch.get("code"), ("RUNTIME_CURRENT", "RUNTIME_RESYNCED"))
        self.assertTrue(self.prelaunch.get("fingerprint_match"), self.prelaunch)
        self.assertEqual(self.prelaunch.get("engine_diff"), [])
        self.assertEqual(self.prelaunch.get("hook_problems"), [])
        self.assertEqual(self.prelaunch.get("launcher_problems"), [])
        self.assertEqual(self.prelaunch.get("provenance_problems"), [])
        hook = self.home / ".config" / "opencode" / "plugins" / "saipen-guard.js"
        shipped = REPO / "extensions" / "adapters" / "opencode" / "saipen-guard.js"
        self.assertTrue(hook.is_file(), "the canonical operation installed no guard")
        self.assertEqual(hook.read_bytes(), shipped.read_bytes())
        type(self).proof["prelaunch_code"] = self.prelaunch.get("code")

    def test_2_the_project_started_in_the_incident_state(self) -> None:
        self.assertEqual(
            self.state_before["classification"], "BOUND_RECOVERY_REQUIRED_SAFE", self.state_before
        )
        self.assertEqual(self.state_before["reason_code"], "BOARD_RECORD_OVERSIZE")
        self.assertEqual(self.state_before["canonical_next_command"], "saipen ticket compact T-158")

    def test_3_the_session_produced_real_tool_events(self) -> None:
        self.assertTrue(self.session["tool_events"], self.session["attempts"])

    def test_4_no_forbidden_refusal_reached_the_model(self) -> None:
        blob = json.dumps(self.session["tool_events"])
        for code in FORBIDDEN_CODES:
            self.assertNotIn(code, blob, f"{code} observed in a live session")

    def test_5_the_board_compacted_itself_with_no_operator_command(self) -> None:
        board = (self.project / ".saipen" / "BOARD.md").read_text(encoding="utf-8")
        self.assertNotEqual(board, self.board_before, "no canonical repair ran")
        self.assertIn("detail_ref:", board)
        for line in board.splitlines():
            if line.startswith("- ["):
                self.assertLessEqual(len(line.rstrip()), MAX_LIVE_RECORD_CHARS, line)
        # No shell tool ran at all: the repair came from Fleet, not the model.
        shells = [item for item in self.session["tool_events"] if item["tool"] == "bash"]
        self.assertEqual(shells, [], "the model reached a shell; the repair must be automatic")

    def test_6_the_stale_payload_was_refused_and_a_fresh_one_landed(self) -> None:
        writes = [
            item for item in self.session["tool_events"]
            if item["tool"] in ("write", "edit", "patch")
        ]
        self.assertTrue(writes, self.session["tool_events"])
        self.assertIn(
            "RECOVERED_REISSUE_REQUIRED",
            json.dumps(writes),
            "the first consequential payload was not refused as a reissue",
        )
        self.assertTrue(self.target.is_file(), "no fresh action landed after the repair")
        self.assertEqual(self.target.read_text(encoding="utf-8").strip(), "ok")

    def test_7_the_project_is_bound_valid_with_root_lineage_and_actor_intact(self) -> None:
        self.assertEqual(self.state_after["classification"], "BOUND_VALID", self.state_after)
        self.assertEqual(self.state_after["reason_code"], "CLEAN")
        self.assertEqual(Path(self.state_after["root"]).resolve(), self.project.resolve())
        self.assertEqual(
            self.state_after["project_lineage"], self.state_before["project_lineage"]
        )
        self.assertEqual(self.state_after["task"], "T-158")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
