"""T-1317 host actor-resolution lifecycle regressions.

The observed live failures this suite pins:

- GUARD_UNREACHABLE while invoking the read/bootstrap `skill` tool;
- ACTOR_UNBOUND during a valid bare canonical continuation.

Contract under test (no weakening of fail-closed mutation):

1. bootstrap `skill` access never depends on mutation admission;
2. an explicit actor survives sequential guarded tool calls in one session;
3. actor identity does not leak across independent sessions/projects;
4. an absent explicit actor inherits canonical ``STATE.agent`` and still runs
   every ownership/protocol safety check;
5. a healthy bare session path (read -> inspect -> admitted write) runs
   without GUARD_UNREACHABLE or ACTOR_UNBOUND.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_guard_hostile_matrix import (  # noqa: E402
    GuardEventHarness,
    active_project,
    fresh_project,
    project_with_doing_owner,
    recovery_debt_project,
)

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


SAIPEN = TOOLS / "saipen.py"
HOST_GUARD = TOOLS / "host_guard.py"


def guard_cli(event: dict) -> tuple[int, dict]:
    return GuardEventHarness.run(event)


def native(
    host: str, root: Path, name: str, args: dict, actor: str | None
) -> subprocess.CompletedProcess:
    env = {**os.environ}
    if actor is None:
        env.pop("SAIPEN_AGENT", None)
    else:
        env["SAIPEN_AGENT"] = actor
    return subprocess.run(
        [sys.executable, str(HOST_GUARD), "--host", host, "--saipen-root", str(TOOLS.parent)],
        input=json.dumps({"cwd": str(root), "tool_name": name, "tool_input": args}),
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
    )


class BootstrapSkillAccess(unittest.TestCase):
    """Bootstrap/read `skill` never depends on mutation admission."""

    def test_skill_is_bounded_read_in_the_guard(self):
        from saipen_engine import guard_events

        mapped = guard_events.map_event(
            GuardEventHarness.tool_event(fresh_project(), "skill", {"name": "saipen"})
        )
        self.assertEqual(mapped["action"], "read")

    def test_skill_tool_runs_even_when_guard_is_unreachable(self):
        # `skill` must be usable because the transport never consults the
        # guard for verified read identities.
        root = fresh_project()
        proc = native("kiro", root, "skill", {"name": "saipen"}, "test-agent")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(
            native("gemini", root, "skill", {"name": "saipen"}, None).returncode, 0
        )

    def test_reads_stay_available_with_no_actor_at_all(self):
        # Ordinary repository inspection: reads and bootstrap access carry no
        # actor-resolution path and never produce ACTOR_UNBOUND.
        root = fresh_project()
        for name, args in (
            ("read", {"file_path": "src/app.py"}),
            ("fs_read", {"path": ".saipen/STATE.md"}),
            ("skill", {"name": "saipen"}),
        ):
            with self.subTest(tool=name):
                proc = native("kiro", root, name, args, None)
                self.assertEqual(proc.returncode, 0, proc.stderr)


class ActorBindingLifecycle(unittest.TestCase):
    """Stable binding across a session; no cross-session leakage."""

    def test_bound_actor_survives_sequential_guarded_calls(self):
        root = active_project()
        for i in range(3):
            code, data = guard_cli(
                GuardEventHarness.tool_event(root, "write", {"file_path": f"src/seq{i}.py"})
            )
            self.assertEqual(code, 0, data)
            self.assertEqual(data["event"]["actor"], "test-agent", data)

    def test_actor_does_not_leak_across_independent_projects(self):
        # Two independent fixtures: a binding carrying actor A must not
        # authorize (or appear in) the other project's events.
        first = project_with_doing_owner("actor-one", agent="actor-one")
        second = project_with_doing_owner("astra2", agent="astra2")
        event_a = GuardEventHarness.tool_event(first, "write", {"file_path": "src/a.py"})
        event_a["actor"] = "actor-one"
        code_a, data_a = guard_cli(event_a)
        self.assertEqual(code_a, 0, data_a)
        self.assertEqual(data_a["event"]["actor"], "actor-one")

        event_b = GuardEventHarness.tool_event(second, "write", {"file_path": "src/b.py"})
        event_b["actor"] = "actor-one"  # foreign actor in the OTHER project
        code_b, data_b = guard_cli(event_b)
        self.assertEqual(code_b, 1)
        self.assertEqual(data_b["code"], "OWNERSHIP_CONFLICT", data_b)
        self.assertEqual(data_b["event"]["actor"], "actor-one")

    def test_valid_bare_continuation_inherits_canonical_actor(self):
        root = project_with_doing_owner("codex", agent="codex")
        event = GuardEventHarness.tool_event(root, "write", {"file_path": "src/app.py"})
        event.pop("actor")
        code, data = guard_cli(event)
        self.assertEqual(code, 0, data)
        self.assertEqual(data["code"], "ADMITTED", data)
        self.assertIsNone(data["event"]["actor"], data)

    def test_explicit_correct_and_foreign_actors_remain_ownership_checked(self):
        root = project_with_doing_owner("codex", agent="codex")
        correct = GuardEventHarness.tool_event(root, "write", {"file_path": "src/app.py"})
        correct["actor"] = "codex"
        code, data = guard_cli(correct)
        self.assertEqual(code, 0, data)
        self.assertEqual(data["code"], "ADMITTED", data)

        foreign = dict(correct, actor="astra")
        code, data = guard_cli(foreign)
        self.assertEqual(code, 1, data)
        self.assertEqual(data["code"], "OWNERSHIP_CONFLICT", data)

    def test_contradictory_canonical_ownership_fails_without_explicit_actor(self):
        root = project_with_doing_owner("astra", agent="other-agent")
        event = GuardEventHarness.tool_event(root, "write", {"file_path": "src/app.py"})
        event.pop("actor")
        code, data = guard_cli(event)
        self.assertEqual(code, 1, data)
        self.assertEqual(data["code"], "OWNERSHIP_CONFLICT", data)

    def test_bare_unknown_protected_recovery_and_non_saipen_cases_stay_closed(self):
        healthy = project_with_doing_owner("codex", agent="codex")
        cases = (
            (healthy, "mystery_tool", {}, "TARGET_UNRESOLVED"),
            (
                healthy,
                "write",
                {"file_path": ".saipen/STATE.md"},
                "PROTECTED_CANONICAL_NAMESPACE",
            ),
            (
                recovery_debt_project(),
                "write",
                {"file_path": "src/app.py"},
                "RECOVERY_REQUIRED",
            ),
        )
        for root, tool, args, expected in cases:
            with self.subTest(code=expected):
                event = GuardEventHarness.tool_event(root, tool, args)
                event.pop("actor")
                code, data = guard_cli(event)
                self.assertEqual(code, 1, data)
                self.assertEqual(data["code"], expected, data)

        with tempfile.TemporaryDirectory() as tmp:
            event = {
                "event": "before_tool",
                "host": "opencode",
                "cwd": tmp,
                "tool_name": "write",
                "tool_input": {"file_path": "app.py"},
            }
            code, data = guard_cli(event)
            self.assertEqual(code, 0, data)
            self.assertEqual(data["code"], "NOT_SAIPEN_PROJECT", data)
            self.assertFalse(data["applicable"], data)

    def test_missing_canonical_actor_fails_as_invalid_protocol_state(self):
        root = fresh_project(agent="")
        event = GuardEventHarness.tool_event(root, "write", {"file_path": "src/app.py"})
        event.pop("actor")
        code, data = guard_cli(event)
        self.assertEqual(code, 1, data)
        self.assertEqual(data["code"], "PROTOCOL_STATE_INVALID", data)

    def test_clean_session_path_without_guard_failures(self):
        """Read -> inspect -> admitted write, no UNREACHABLE/UNBOUND anywhere."""
        root = active_project()
        steps = [
            ("skill", {"name": "saipen"}, 0, None),
            ("read", {"file_path": ".saipen/STATE.md"}, 0, "ADMITTED_READ_ONLY"),
            ("write", {"file_path": "src/implementation.py"}, 0, "ADMITTED"),
        ]
        for name, args, expected_rc, expected_code in steps:
            with self.subTest(step=name):
                event = GuardEventHarness.tool_event(root, name, args)
                event.pop("actor")
                code, data = guard_cli(event)
                self.assertEqual(code, expected_rc, data)
                if expected_code:
                    self.assertEqual(data["code"], expected_code, data)


if __name__ == "__main__":
    unittest.main()
