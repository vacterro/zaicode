"""Executable adapter transport controls; these are NOT real host smoke proof."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
from install_host_guard import install  # noqa: E402
from test_guard_hostile_matrix import active_project, recovery_debt_project  # noqa: E402

from test_hermetic_env import isolate_host_session  # noqa: E402


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


class NativeHookTests(unittest.TestCase):
    def invoke(self, host, root, name, args, skill=None):
        return subprocess.run(
            [
                sys.executable,
                str(TOOLS / "host_guard.py"),
                "--host",
                host,
                "--saipen-root",
                str(skill or TOOLS.parent),
            ],
            input=json.dumps({"cwd": str(root), "tool_name": name, "tool_input": args}),
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "SAIPEN_AGENT": "test-agent"},
        )

    def test_native_write_refused_and_diagnostics_available(self):
        for host, write, read in (
            ("kiro", "fs_write", "fs_read"),
            ("gemini", "write_file", "read_file"),
        ):
            root = recovery_debt_project()
            with self.subTest(host=host):
                refused = self.invoke(host, root, write, {"path": ".saipen/STATE.md"})
                self.assertEqual(refused.returncode, 2, refused.stderr)
                self.assertIn("PROTECTED_CANONICAL_NAMESPACE", refused.stderr)
                self.assertEqual(self.invoke(host, root, read, {}, skill=root).returncode, 0)
                unavailable = self.invoke(host, root, write, {"path": "src/app.py"}, skill=root)
                self.assertEqual(unavailable.returncode, 2)

    def test_admitted_write_and_exact_recovery(self):
        for host, write, shell in (
            ("kiro", "fs_write", "execute_bash"),
            ("gemini", "write_file", "run_shell_command"),
        ):
            with self.subTest(host=host):
                self.assertEqual(
                    self.invoke(host, active_project(), write, {"path": "src/app.py"}).returncode, 0
                )
                root = recovery_debt_project()
                self.assertEqual(
                    self.invoke(host, root, shell, {"command": "saipen recover"}).returncode, 0
                )
                self.assertEqual(
                    self.invoke(
                        host, root, shell, {"command": "saipen recover && echo bad"}
                    ).returncode,
                    2,
                )
                self.assertEqual(
                    self.invoke(
                        host, root, "mcp__x__read", {"path": ".saipen/STATE.md"}
                    ).returncode,
                    2,
                )

    def test_install_preserves_unrelated_hooks_and_is_idempotent(self):
        for host in ("kiro", "gemini"):
            with tempfile.TemporaryDirectory() as tmp, self.subTest(host=host):
                home = Path(tmp)
                if host == "gemini":
                    config = home / ".gemini/settings.json"
                    config.parent.mkdir()
                    config.write_text(
                        json.dumps(
                            {
                                "theme": "mine",
                                "hooks": {
                                    "BeforeTool": [
                                        {
                                            "matcher": "read.*",
                                            "hooks": [{"name": "mine", "command": "echo mine"}],
                                        }
                                    ]
                                },
                            }
                        ),
                        encoding="utf-8",
                    )
                else:
                    config = home / ".kiro/hooks/mine.json"
                    config.parent.mkdir(parents=True)
                    config.write_text("mine unrelated", encoding="utf-8")
                result = install(host, home)
                self.assertEqual(result["effective"], "UNKNOWN")
                before = {str(p): p.read_bytes() for p in home.rglob("*") if p.is_file()}
                install(host, home)
                after = {str(p): p.read_bytes() for p in home.rglob("*") if p.is_file()}
                self.assertEqual(before, after)
                self.assertTrue(install(host, home, check=True)["current"])
                self.assertIn("mine", config.read_text())
                Path(result["artifact"]).write_text("stale", encoding="utf-8")
                self.assertEqual(install(host, home, check=True)["effective"], "ENFORCEMENT_GAP")


if __name__ == "__main__":
    unittest.main()
