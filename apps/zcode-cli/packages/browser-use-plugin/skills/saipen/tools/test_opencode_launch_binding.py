"""T-1317 Target A2: canonical OpenCode launch-envelope regressions."""

from __future__ import annotations

import os
import json
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine.host_launch import (  # noqa: E402
    HostLaunchRefusal,
    build_launch_environment,
)
from saipen_engine.paths import (  # noqa: E402
    ENV_AGENT,
    ENV_PROJECT_LINEAGE,
    ENV_PROJECT_ROOT,
    project_lineage_identity,
)
from test_guard_hostile_matrix import fresh_project  # noqa: E402


class CanonicalOpenCodeBinding(unittest.TestCase):
    @staticmethod
    def _clean_env() -> dict:
        """Ambient SAIPEN_* host leaks must not decide a launcher regression."""
        env = {**os.environ}
        for key in (ENV_AGENT, ENV_PROJECT_ROOT, ENV_PROJECT_LINEAGE):
            env.pop(key, None)
        return env

    def test_explicit_seat_creates_the_complete_launch_envelope(self):
        root = fresh_project()
        env = build_launch_environment(root, "launch-seat", base_env={"PATH": os.defpath})
        self.assertEqual(env[ENV_AGENT], "launch-seat")
        self.assertEqual(Path(env[ENV_PROJECT_ROOT]), root.resolve())
        self.assertEqual(env[ENV_PROJECT_LINEAGE], project_lineage_identity(root))

    def test_independent_envelopes_do_not_leak_actor_or_lineage(self):
        first = fresh_project()
        second = fresh_project()
        first_env = build_launch_environment(
            first,
            "seat-one",
            base_env={ENV_AGENT: "ambient", ENV_PROJECT_LINEAGE: "ambient-lineage"},
        )
        second_env = build_launch_environment(second, "seat-two", base_env=first_env)
        self.assertEqual(first_env[ENV_AGENT], "seat-one")
        self.assertEqual(second_env[ENV_AGENT], "seat-two")
        self.assertNotEqual(first_env[ENV_PROJECT_ROOT], second_env[ENV_PROJECT_ROOT])
        self.assertNotEqual(first_env[ENV_PROJECT_LINEAGE], second_env[ENV_PROJECT_LINEAGE])

    def test_missing_or_malformed_seat_is_refused_without_state_fallback(self):
        root = fresh_project()
        for seat in ("", " ", "session id", "mcp__x\nskill"):
            with self.subTest(seat=seat), self.assertRaises(HostLaunchRefusal):
                build_launch_environment(root, seat, base_env={ENV_AGENT: "ambient"})

    def test_a_host_identity_is_never_accepted_as_a_seat(self):
        # Executing-host identity stays separate from canonical work-seat
        # ownership: naming the host it is about to launch must not become an
        # injected `SAIPEN_AGENT` that contradicts canonical ownership.
        root = fresh_project()
        for seat in ("opencode", "OpenCode", " opencode ", "OPENCODE"):
            with self.subTest(seat=seat), self.assertRaises(HostLaunchRefusal):
                build_launch_environment(root, seat, base_env={ENV_AGENT: "ambient"})

    def test_public_launcher_refuses_the_host_name_as_seat(self):
        root = fresh_project()
        env = self._clean_env()
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "--project-root",
                str(root),
                "--agent",
                "opencode",
                "launch",
                "opencode",
                "--json",
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout)["code"], "HOST_LAUNCH_REFUSED")

    def test_public_launcher_refuses_missing_actor_instead_of_inheriting_state(self):
        root = fresh_project()
        env = self._clean_env()
        proc = subprocess.run(
            [
                sys.executable,
                str(TOOLS / "saipen.py"),
                "--project-root",
                str(root),
                "launch",
                "opencode",
                "--json",
            ],
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout)["code"], "ACTOR_UNBOUND")


if __name__ == "__main__":
    unittest.main()
