"""Real OpenCode smoke through the production SAIPEN launch binding.

The deterministic local model scripts only model output. OpenCode itself,
global plugin discovery, plugin factory/hook execution, guard subprocesses,
native tool executors, and resulting filesystem effects remain real. Bare
launches explicitly remove ``SAIPEN_AGENT``; canonical project state supplies
the continuation actor inside Core. The optional explicit launcher is covered
separately.
"""

from __future__ import annotations

import json
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from test_adapter_parity import BASH  # noqa: E402
from test_guard_hostile_matrix import project_with_doing_owner  # noqa: E402
from test_opencode_adapter import run_cases  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


OPENCODE = shutil.which("opencode")
PYTHON = shutil.which("python") or shutil.which("python3")
INSTALL_RELATIVE = Path(".config") / "opencode" / "plugins" / "saipen-guard.js"


class _ScriptedProvider:
    def __init__(self, actions: list[tuple[str, dict]],
                 child_actions: list[tuple[str, dict]] | None = None) -> None:
        self.actions = actions
        self.child_actions = child_actions or []
        self.requests: list[dict] = []

        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                return

            def do_POST(self):
                length = int(self.headers["Content-Length"])
                request = json.loads(self.rfile.read(length))
                prior = [m for m in request.get("messages", []) if m.get("role") == "tool"]
                tools = request.get("tools", [])
                child = any(
                    item.get("role") == "user"
                    and "CHILD_GUARD_PROBE" in json.dumps(item.get("content"))
                    for item in request.get("messages", [])
                )
                actions = owner.child_actions if child else owner.actions
                owner.requests.append(
                    {
                        "tools": [t.get("function", {}).get("name") for t in tools],
                        "prior": prior,
                        "child": child,
                    }
                )
                index = len(prior)
                message: dict = {"role": "assistant", "content": "Smoke complete."}
                finish = "stop"
                if tools and index < len(actions):
                    name, arguments = actions[index]
                    message = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": f"call_bound_{index}",
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": json.dumps(arguments),
                                },
                            }
                        ],
                    }
                    finish = "tool_calls"

                base = {
                    "id": "chatcmpl-bound-smoke",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "smoke",
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
                self.send_response(200)
                if request.get("stream"):
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    first = {
                        **base,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": message, "finish_reason": None}],
                    }
                    last = {
                        **base,
                        "object": "chat.completion.chunk",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
                    }
                    for item in (first, last):
                        self.wfile.write(("data: " + json.dumps(item) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    return
                payload = json.dumps(
                    {**base, "choices": [{"index": 0, "message": message, "finish_reason": finish}]}
                ).encode()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def config(self) -> dict:
        return {
            "provider": {
                "saipen-smoke": {
                    "npm": "@ai-sdk/openai-compatible",
                    "name": "Local deterministic enforcement test",
                    "options": {
                        "baseURL": f"http://127.0.0.1:{self.server.server_port}/v1",
                        "apiKey": "local-fixture",
                    },
                    "models": {"smoke": {"name": "smoke"}},
                }
            },
            "permission": "allow",
            "mcp": {"codebase-memory-mcp": {"enabled": False}},
        }


#: T-1495: the bound on one real opencode child. 120 s followed host load: in
#: a 6-shard family on a host shared with other agents one launch ran past it
#: while the same tree passed alone (4 tests in 104 s). This is the bound the
#: sibling host smokes already use for the same kind of child; a hang still
#: fails, only a slow host no longer does.
CHILD_TIMEOUT_S = 600


@unittest.skipUnless(OPENCODE, "opencode runtime unavailable")
@unittest.skipUnless(BASH, "working bash runtime unavailable")
@unittest.skipUnless(PYTHON, "python runtime unavailable")
class BoundOpenCodeNativeSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._temp = tempfile.TemporaryDirectory(prefix="saipen-bound-opencode-")
        cls.temp_root = Path(cls._temp.name)
        cls.home = cls.temp_root / "home"
        cls.home.mkdir()
        (cls.home / ".config" / "opencode").mkdir(parents=True)
        install = subprocess.run(
            [BASH, str(REPO / "bootstrap" / "inject.sh")],
            capture_output=True,
            text=True,
            env={**os.environ, "HOME": str(cls.home)},
            timeout=600,
        )
        if install.returncode != 0:
            raise AssertionError(install.stdout + install.stderr)
        cls.installed = cls.home / INSTALL_RELATIVE
        cls.installed_launcher = (
            cls.home / ".config" / "opencode" / "skills" / "saipen" / "tools" / "saipen.py"
        )
        if not cls.installed_launcher.is_file():
            raise AssertionError(f"installed launcher missing: {cls.installed_launcher}")

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    def _launch(
        self,
        root: Path,
        seat: str | None,
        actions: list[tuple[str, dict]],
        *,
        home: Path | None = None,
        child_actions: list[tuple[str, dict]] | None = None,
    ):
        probe = root / "startup-probe.txt"
        active_home = home or self.home
        env = {
            **os.environ,
            "HOME": str(active_home),
            "USERPROFILE": str(active_home),
            "SAIPEN_GUARD_STARTUP_PROBE": str(probe),
        }
        # T-1343. This module is the ONE fixture that means to start a real
        # OpenCode: a disposable HOME, a scripted provider, bounded host args
        # and a timeout. Every other fixture keeps the interlock armed, so an
        # accidental spawn -- the T-1327 shape, where a monkeypatch missed --
        # is refused before the process exists instead of hanging the suite.
        env.pop("SAIPEN_FORBID_HOST_SPAWN", None)
        # Measured host fact: OpenCode takes the session directory from the
        # shell's PWD when it is set, NOT from the child's working directory.
        # An inherited PWD would run the session against the AUDITOR's cwd and
        # the fixture-relative writes would land outside the fixture.
        env.pop("PWD", None)
        env.pop("OLDPWD", None)
        # The caller never injects actor identity into OpenCode directly.
        # A non-None seat exercises the optional explicit launcher; None is
        # the user's ordinary generic OpenCode path.
        env.pop("SAIPEN_AGENT", None)
        with _ScriptedProvider(actions, child_actions) as provider:
            env["OPENCODE_CONFIG_CONTENT"] = json.dumps(provider.config)
            host_args = [
                "run",
                "--agent",
                "build",
                "--model",
                "saipen-smoke/smoke",
                "--format",
                "json",
                "Run the deterministic native binding smoke.",
            ]
            command = [OPENCODE, *host_args]
            if seat is not None:
                command = [
                    sys.executable,
                    str(self.installed_launcher),
                    "--project-root",
                    str(root),
                    "--agent",
                    seat,
                    "launch",
                    "opencode",
                    "--",
                    *host_args,
                ]
            proc = subprocess.run(
                command,
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
                timeout=CHILD_TIMEOUT_S,
            )
            return proc, probe, provider.requests

    def test_bare_generic_launch_bootstraps_reads_and_inherits_one_canonical_actor(self):
        root = project_with_doing_owner("codex", agent="codex")
        before = (root / ".saipen" / "STATE.md").read_bytes()
        actions = [
            ("skill", {"name": "saipen"}),
            ("read", {"filePath": "src/app.py"}),
            ("bash", {"command": "python --version"}),
            ("write", {"filePath": "src/allowed-one.py", "content": "one\n"}),
            ("bash", {
                "command": (
                    "python -c \"from pathlib import Path; "
                    "Path('.saipen/STATE.md').write_text('boom')\""
                )
            }),
            ("write", {"filePath": ".saipen/STATE.md", "content": "blocked\n"}),
            ("mystery_tool", {}),
            ("write", {"filePath": "src/allowed-two.py", "content": "two\n"}),
        ]
        proc, probe, requests = self._launch(root, None, actions)
        combined = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, combined)
        self.assertTrue(probe.is_file(), combined)
        self.assertIsNone(json.loads(probe.read_text(encoding="utf-8").splitlines()[0])["actor"])
        self.assertTrue((root / "src" / "allowed-one.py").is_file(), combined)
        self.assertTrue((root / "src" / "allowed-two.py").is_file(), combined)
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)
        self.assertNotIn("boom", (root / ".saipen" / "STATE.md").read_text(encoding="utf-8"))
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", combined)
        self.assertIn("TARGET_UNRESOLVED", combined)
        self.assertNotIn("GUARD_UNREACHABLE", combined)
        self.assertNotIn("ACTOR_UNBOUND", combined)
        main_tools = next(item["tools"] for item in requests if item["tools"])
        self.assertIn("skill", main_tools)
        self.assertIn("read", main_tools)
        self.assertIn("bash", main_tools)

    def test_native_task_child_mutations_receive_the_same_guard(self):
        root = project_with_doing_owner("codex", agent="codex")
        before = (root / ".saipen" / "STATE.md").read_bytes()
        board_before = (root / ".saipen" / "BOARD.md").read_bytes()
        parent_actions = [("task", {
            "description": "Child guard proof",
            "prompt": "CHILD_GUARD_PROBE: run the requested source and protected writes.",
            "subagent_type": "general",
        })]
        child_actions = [
            ("write", {"filePath": "src/child-admitted.py", "content": "ok\n"}),
            ("write", {"filePath": ".saipen/STATE.md", "content": "child-bypass\n"}),
            ("bash", {"command": (
                "python -c \"open('.saipen/BOARD.md', 'w').write('child-bypass')\""
            )}),
        ]
        proc, probe, requests = self._launch(
            root, None, parent_actions, child_actions=child_actions
        )
        combined = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, combined)
        self.assertTrue(probe.is_file(), combined)
        self.assertTrue(any(item["child"] for item in requests), requests)
        self.assertTrue(
            any(item["child"] and len(item["prior"]) >= 2 for item in requests),
            requests,
        )
        self.assertTrue((root / "src" / "child-admitted.py").is_file(), combined)
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)
        self.assertEqual((root / ".saipen" / "BOARD.md").read_bytes(), board_before)
        child_results = json.dumps([item["prior"] for item in requests if item["child"]])
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", child_results)
        self.assertNotIn("child-bypass", (root / ".saipen" / "STATE.md").read_text())

    def test_real_installed_global_plugin_accepts_bare_canonical_continuation(self):
        real_home = Path(os.environ["USERPROFILE"])
        installed = real_home / INSTALL_RELATIVE
        self.assertTrue(installed.is_file(), installed)
        root = project_with_doing_owner("codex", agent="codex")
        before = (root / ".saipen" / "STATE.md").read_bytes()
        actions = [
            ("skill", {"name": "saipen"}),
            ("read", {"filePath": "src/app.py"}),
            ("bash", {"command": "python --version"}),
            ("write", {"filePath": "src/global-installed-write.py", "content": "ok\n"}),
            ("write", {"filePath": ".saipen/STATE.md", "content": "blocked\n"}),
            ("mystery_tool", {}),
        ]
        proc, probe, _requests = self._launch(root, None, actions, home=real_home)
        combined = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, combined)
        diagnostic = json.loads(probe.read_text(encoding="utf-8").splitlines()[0])
        self.assertIsNone(diagnostic["actor"])
        self.assertEqual(
            diagnostic["module_sha256"], hashlib.sha256(installed.read_bytes()).hexdigest()
        )
        self.assertEqual(Path(diagnostic["module_path"]).resolve(), installed.resolve())
        self.assertTrue((root / "src" / "global-installed-write.py").is_file(), combined)
        self.assertEqual((root / ".saipen" / "STATE.md").read_bytes(), before)
        self.assertIn("PROTECTED_CANONICAL_NAMESPACE", combined)
        self.assertIn("TARGET_UNRESOLVED", combined)
        self.assertNotIn("ACTOR_UNBOUND", combined)
        self.assertNotIn("GUARD_UNREACHABLE", combined)

    def test_optional_explicit_launch_is_checked_and_does_not_leak(self):
        foreign = project_with_doing_owner("other-seat")
        actions = [("write", {"filePath": "src/foreign.py", "content": "no\n"})]
        proc, probe, _requests = self._launch(foreign, "launch-seat", actions)
        combined = proc.stdout + proc.stderr
        self.assertEqual(proc.returncode, 0, combined)
        self.assertEqual(json.loads(probe.read_text(encoding="utf-8").splitlines()[0])["actor"],
                         "launch-seat")
        self.assertIn("OWNERSHIP_CONFLICT", combined)
        self.assertFalse((foreign / "src" / "foreign.py").exists())

        # Separate bare control: generic launch has no explicit actor. This
        # fixture is canonically contradictory, so ownership—not missing host
        # metadata—must refuse it.
        bare = run_cases(
            self.installed,
            [
                {
                    "id": "bare-contradictory-owner",
                    "project": str(foreign),
                    "env": {"SAIPEN_AGENT": None, "SAIPEN_PYTHON": PYTHON},
                    "input": {"tool": "write", "sessionID": "ses_unbound"},
                    "output": {"args": {"filePath": "src/unbound.py", "content": "no\n"}},
                }
            ],
            self.temp_root / "unbound-control",
            extra_env={"HOME": str(self.home), "USERPROFILE": str(self.home)},
        )[0]
        self.assertEqual(bare["outcome"], "blocked", bare)
        self.assertIn("OWNERSHIP_CONFLICT", bare["message"])
        self.assertFalse((foreign / "src" / "unbound.py").exists())


if __name__ == "__main__":
    unittest.main()
