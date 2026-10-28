"""T-1387: one scratch file gets one answer on every surface.

Measured in the T-1385 smoke on a8290234: the write tool was ADMITTED to
create `.saipen/kitchen/review_check.py`, and the shell was then refused
PROTECTED_CANONICAL_NAMESPACE for running it and for deleting it -- the shell
preflight refused the literal text `.saipen`, while structured protection
covers only the canonical path list. The session relocated the script out of
the project and could not remove its own leftover.

A `.saipen` path a shell line names is now canonicalized exactly as a
file-tool target. The protected canonical namespace stays refused on the shell
surface, and so does anything the guard cannot judge as a path: the namespace
itself, a glob, a variable, a traversal back into protected state.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from saipen_engine import guard_events  # noqa: E402
from test_hermetic_env import isolate_host_session  # noqa: E402
from test_t1363_zero_manual_entry import cli, healthy  # noqa: E402


def setUpModule() -> None:
    isolate_host_session()


def verdict(root: Path, tool: str, tool_input: dict) -> dict:
    event = {
        "event": "before_tool",
        "host": "opencode",
        "cwd": str(root),
        "tool_name": tool,
        "tool_input": tool_input,
        "session_id": "ses_t1387",
    }
    return guard_events.evaluate_event(guard_events.load_event(json.dumps(event)), None)


class ScratchFileTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(healthy(self))
        code, payload, text = cli(self.root, "start", "add a docstring to src/app.py", "--json")
        self.assertEqual((code, payload["code"]), (0, "STARTED"), text)
        self.script = self.root / ".saipen" / "kitchen" / "review_check.py"

    def test_write_run_and_delete_of_one_kitchen_file_get_one_answer(self):
        answers = {
            "write": verdict(
                self.root, "write", {"filePath": str(self.script), "content": "print(1)\n"}
            ),
            "run absolute": verdict(self.root, "bash", {"command": f'python "{self.script}"'}),
            "run relative": verdict(
                self.root, "bash", {"command": "python .saipen/kitchen/review_check.py"}
            ),
            "delete powershell": verdict(
                self.root, "bash", {"command": f'Remove-Item -LiteralPath "{self.script}"'}
            ),
            "delete posix": verdict(
                self.root, "bash", {"command": "rm .saipen/kitchen/review_check.py"}
            ),
        }
        for surface, answer in answers.items():
            with self.subTest(surface=surface):
                self.assertTrue(answer["admitted"], answer)

    def test_protected_state_stays_refused_on_the_shell_surface(self):
        for command in (
            "echo x >> .saipen/LOG.md",
            "python .saipen/kitchen/review_check.py > .saipen/STATE.md",
            "python .saipen/kitchen/../STATE.md",
            "rm -rf .saipen",
            "cd .saipen && python kitchen/review_check.py",
            "rm .saipen/kitchen/*.py",
            "python $PWD/.saipen/kitchen/review_check.py",
            "python .saipen/intake/x.py",
            "rm .saipen/recovery",
        ):
            with self.subTest(command=command):
                answer = verdict(self.root, "bash", {"command": command})
                self.assertFalse(answer["admitted"], answer)

    def test_the_write_tool_and_the_shell_refuse_protected_state_alike(self):
        target = self.root / ".saipen" / "STATE.md"
        wrote = verdict(self.root, "write", {"filePath": str(target), "content": "x\n"})
        ran = verdict(self.root, "bash", {"command": f'python "{target}"'})
        self.assertFalse(wrote["admitted"], wrote)
        self.assertFalse(ran["admitted"], ran)
        self.assertEqual(ran["code"], "PROTECTED_CANONICAL_NAMESPACE", ran)


class IdleProjectTests(unittest.TestCase):
    def test_without_work_both_surfaces_give_the_same_refusal(self):
        root = Path(healthy(self))
        script = root / ".saipen" / "kitchen" / "review_check.py"
        wrote = verdict(root, "write", {"filePath": str(script), "content": "print(1)\n"})
        ran = verdict(root, "bash", {"command": f'python "{script}"'})
        self.assertFalse(wrote["admitted"], wrote)
        self.assertEqual((ran["admitted"], ran["code"]), (wrote["admitted"], wrote["code"]))


class PathExtractionTests(unittest.TestCase):
    def test_only_clean_path_operands_are_extracted(self):
        cwd = str(Path("V:/proj"))
        paths = guard_events.shell_namespace_paths
        self.assertEqual(
            paths("python .saipen/kitchen/a.py", cwd),
            [str(Path(cwd) / ".saipen/kitchen/a.py")],
        )
        self.assertEqual(
            paths("python a.py >.saipen/kitchen/out.txt", cwd),
            [str(Path(cwd) / ".saipen/kitchen/out.txt")],
        )
        for command in (
            "ls .saipen",
            "rm .saipen/kitchen/*.py",
            "python $X/.saipen/kitchen/a.py",
            "echo $(cat .saipen/kitchen/a)",
            "python --file=.saipen/kitchen/a.py",
            "python ~/.saipen/kitchen/a.py",
        ):
            with self.subTest(command=command):
                self.assertIsNone(paths(command, cwd))
        self.assertIsNone(paths("python a.py", cwd))


if __name__ == "__main__":
    unittest.main()
