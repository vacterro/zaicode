"""T-1339: both invocation forms of the tools package must resolve the engine.

Python puts the SCRIPT'S OWN directory on `sys.path` for `python tools/x.py`
and the REPOSITORY ROOT for `python -m tools.x`. Every module here imports
`saipen_engine` at top level, so the module form raised

    ModuleNotFoundError: No module named 'saipen_engine'

from the project's own CLI. Both spellings look supported and nothing says one
is not, so the traceback reads as a broken protocol install rather than as a
wrong invocation. The repository also disagreed with itself: test modules that
inserted the path by hand ran under `python -m unittest` while fourteen others
died on import.

`tools/__init__.py` owns the fix, and this suite pins the CONTRACT rather than
the files that happened to be noticed today:

  * importing the package makes the flat `saipen_engine` spelling RESOLVABLE,
    which is what every module in it needs;
  * the repository root stays ahead of it, so `tools.x` still resolves as
    `tools.x`;
  * the CLI answers identically under both forms;
  * test modules that used to die on import now run under `python -m unittest`.

Resolvability is checked with `find_spec`, never by importing each module:
several shipped modules are SCRIPTS that do their work at import time
(`validate.py` runs a whole gate), so importing them to prove a path contract
would execute the repository's gates as a side effect of a unit test.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_hermetic_env import isolate_host_session


def setUpModule() -> None:
    # An outer host session (SAIPEN_PROJECT_ROOT/LINEAGE, SAIPEN_AGENT, ...)
    # must never bind this module's disposable fixtures (test_hermetic_env).
    isolate_host_session()


TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent


def _modules_importing_the_engine() -> list[str]:
    """Shipped `tools/*.py` files whose top level imports `saipen_engine`.

    Parsed, never imported -- see the module docstring.
    """
    names: list[str] = []
    for path in sorted(TOOLS.glob("*.py")):
        if path.name == "__init__.py":
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and (node.module or "").startswith(
                "saipen_engine"
            ):
                names.append(path.name)
                break
            if isinstance(node, ast.Import) and any(
                alias.name.startswith("saipen_engine") for alias in node.names
            ):
                names.append(path.name)
                break
    return names


class PackagePathContractTests(unittest.TestCase):
    def test_importing_the_package_resolves_the_engine_spelling(self):
        import tools  # noqa: F401 -- importing the package IS the contract

        self.assertIn(str(TOOLS), sys.path)
        self.assertIsNotNone(
            importlib.util.find_spec("saipen_engine"),
            "tools/__init__.py did not make `saipen_engine` resolvable",
        )

    def test_the_package_appends_its_directory_and_never_prepends_it(self):
        """Appended, never prepended: `tools.x` must still resolve as `tools.x`.

        T-1343: this pins what `tools/__init__.py` DOES, not what the resulting
        `sys.path` looks like. The old assertion compared the live positions of
        the repository root and this directory, which the package does not own:
        `python -m unittest discover -s tools` -- the repository's OWN canonical
        core-unit family (`saipen_engine/test_runner.py`) -- puts the start
        directory at `sys.path[0]` before any of this runs, so the assertion was
        false in the harness that runs it and had been red there since T-1339
        added it. A contract that is only true under some invocations is not the
        owner's contract; the owner's contract is the append.
        """
        import tools  # noqa: F401

        self.assertIn(str(TOOLS), sys.path)
        source = (TOOLS / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("sys.path.append(_TOOLS_PATH)", source)
        self.assertNotIn("sys.path.insert", source)

    def test_a_fresh_interpreter_keeps_the_repository_root_ahead(self):
        """In the invocation the package DOES own, the order still holds.

        `python -m tools.x` from the repository root is the form the append was
        written for: the root is `sys.path[0]` and this directory must land
        behind it, so `tools.x` keeps resolving as `tools.x`.
        """
        probe = (
            "import sys, json, os;"
            "import tools;"
            # `python -c` writes the cwd into sys.path[0] as the empty string.
            "print(json.dumps([os.path.normcase(os.path.abspath(p or os.getcwd()))"
            " for p in sys.path]))"
        )
        completed = subprocess.run(
            [sys.executable, "-c", probe],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=600,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-1000:])
        path = json.loads(completed.stdout.splitlines()[-1])
        root = os.path.normcase(str(REPO))
        tools_dir = os.path.normcase(str(TOOLS))
        self.assertIn(root, path)
        self.assertIn(tools_dir, path)
        self.assertLess(path.index(root), path.index(tools_dir))

    def test_the_contract_covers_every_module_that_needs_it(self):
        """The fix is one owner, so the set it serves is measured, not listed."""
        needing = _modules_importing_the_engine()
        self.assertGreater(len(needing), 10, needing)
        self.assertIn("saipen.py", needing)
        self.assertIn("validate.py", needing)
        import tools  # noqa: F401

        self.assertIsNotNone(importlib.util.find_spec("saipen_engine"))


class CliInvocationParityTests(unittest.TestCase):
    def _status(self, argv: list[str]) -> dict:
        completed = subprocess.run(
            [sys.executable, *argv, "status", "--json"],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=600,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"{argv} exited {completed.returncode}\n{completed.stderr[-1500:]}",
        )
        return json.loads(completed.stdout)

    def test_the_module_form_and_the_script_form_agree(self):
        script = self._status(["tools/saipen.py"])
        module = self._status(["-m", "tools.saipen"])
        for field in ("ok", "protocol_version", "phase", "task", "head"):
            self.assertEqual(script.get(field), module.get(field), field)

    def test_the_module_form_does_not_report_a_missing_engine(self):
        completed = subprocess.run(
            [sys.executable, "-m", "tools.saipen", "status", "--json"],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=600,
        )
        self.assertNotIn("No module named", completed.stderr)
        self.assertNotIn("ModuleNotFoundError", completed.stderr)


class TestModuleFormTests(unittest.TestCase):
    """The exact modules that used to die on `python -m unittest`."""

    def _unittest(self, dotted: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "unittest", dotted],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=900,
        )

    def test_previously_unimportable_suites_now_run(self):
        for dotted in (
            "tools.test_cold_agent_truth",
            "tools.test_ledger_gap",
            "tools.test_acceptance",
        ):
            with self.subTest(module=dotted):
                completed = self._unittest(dotted)
                self.assertNotIn("ModuleNotFoundError", completed.stderr)
                self.assertNotIn("Failed to import test module", completed.stderr)
                self.assertEqual(completed.returncode, 0, completed.stderr[-1200:])


class HostileForeignEngineTests(unittest.TestCase):
    """T-1341: a foreign same-named package must never shadow the local engine.

    Resolvability is not identity. Placing a hostile `saipen_engine` earlier on
    `PYTHONPATH` used to capture the module form only, so the two supported
    entry forms could execute DIFFERENT engines. The bounded package alias in
    `tools/__init__.py` must make both forms load the repository's own engine:
    the foreign package is never imported (its sentinel file stays absent) and
    both forms report the same status.
    """

    def _hostile_path(self, base: Path) -> tuple[str, Path]:
        foreign = base / "saipen_engine"
        foreign.mkdir(parents=True)
        sentinel = base / "foreign-executed.txt"
        (foreign / "__init__.py").write_text(
            "from pathlib import Path\n"
            f"Path(r'{sentinel}').write_text('executed')\n"
            "raise RuntimeError('foreign saipen_engine executed')\n",
            encoding="utf-8",
        )
        return str(base), sentinel

    def _status(self, argv: list[str], env: dict) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, *argv, "status", "--json"],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
        )

    def test_both_forms_ignore_a_foreign_package(self):
        with tempfile.TemporaryDirectory(prefix="saipen-shadow-") as tmp:
            shadow, sentinel = self._hostile_path(Path(tmp))
            env = dict(os.environ)
            existing = env.get("PYTHONPATH", "")
            env["PYTHONPATH"] = shadow + (os.pathsep + existing if existing else "")
            script = self._status(["tools/saipen.py"], env)
            module = self._status(["-m", "tools.saipen"], env)
            self.assertEqual(script.returncode, 0, script.stderr[-1500:])
            self.assertEqual(module.returncode, 0, module.stderr[-1500:])
            self.assertFalse(
                sentinel.exists(),
                "a foreign saipen_engine on PYTHONPATH was executed",
            )
            script_data = json.loads(script.stdout)
            module_data = json.loads(module.stdout)
            for field in ("ok", "protocol_version", "phase", "task", "head"):
                self.assertEqual(script_data.get(field), module_data.get(field), field)


if __name__ == "__main__":
    unittest.main(verbosity=2)
