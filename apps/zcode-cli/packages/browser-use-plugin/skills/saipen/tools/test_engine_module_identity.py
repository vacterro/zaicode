"""T-1343: the engine has ONE module identity, not one per import spelling.

`tools/__init__.py` made the flat `saipen_engine` spelling resolvable (T-1339)
and then aliased the repository's own subpackage under that name so a foreign
package could not shadow it (T-1341). The alias registered the ROOT package
only, and the root it registered had been EXECUTED as `tools.saipen_engine`:

    from . import saipen_engine as _saipen_engine
    sys.modules["saipen_engine"] = _saipen_engine     # __name__ stays dotted

CPython resolves a missing from-list child against the module's OWN name
(`Lib/importlib/_bootstrap.py`, `_handle_fromlist`:
`from_ = '{}.{}'.format(module.__name__, x)`), so under the module form

    from saipen_engine import runtime_bootstrap   -> tools.saipen_engine.runtime_bootstrap
    import saipen_engine.host_launch              -> saipen_engine.host_launch

loaded the same FILE twice as two different module objects, and a relative
import inside the engine followed whichever graph had loaded it. Measured at
HEAD ef654110: `saipen_engine.host_launch is not tools.saipen_engine.host_launch`.

File identity is not module identity. Two live objects for one file means two
sets of module globals, two exception classes, two caches -- and a monkeypatch
applied to one of them is invisible to the other. That is not a test
inconvenience: the T-1327 launch fixture patched `prelaunch` on one copy,
`host_launch` reached the other through its relative import, the REAL prelaunch
ran and the operator's REAL OpenCode host started and hung the suite.

This matrix pins MODULE OBJECT identity, which is the contract. Every case runs
in its own interpreter, because import identity is process-global state and a
suite that has already imported the engine cannot observe a cold import order.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from test_hermetic_env import hermetic_env, isolate_host_session


def setUpModule() -> None:
    isolate_host_session()


TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent
ENGINE = TOOLS / "saipen_engine"

#: Representative engine modules: the launch path and its relative import
#: (`host_launch` -> `runtime_bootstrap`), the T-1342 generation owner, the
#: path/env primitives every module reaches for, and two unrelated leaves.
REPRESENTATIVE = (
    "runtime_bootstrap",
    "host_launch",
    "runtime_surface",
    "paths",
    "admission",
    "reconcile",
)

_MARKER = "<<<PROBE>>>"
_EMIT = "\nprint(" + repr(_MARKER) + " + json.dumps(out))\n"


def _probe(
    body: str,
    *,
    cwd: Path = REPO,
    env: dict[str, str] | None = None,
    timeout: int = 180,
) -> dict:
    """Run one cold interpreter and return the JSON verdict it printed.

    `cwd=REPO` reproduces the MODULE form (repository root is `sys.path[0]`,
    `tools/__init__.py` runs). `cwd=TOOLS` reproduces the SCRIPT form's path
    setup (`tools/` is `sys.path[0]`, the `tools` package is never imported).
    """
    code = "import json, os, sys\nout = {}\n" + textwrap.dedent(body) + _EMIT
    completed = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(cwd),
        env=hermetic_env() if env is None else env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if completed.returncode != 0 or _MARKER not in completed.stdout:
        raise AssertionError(
            f"probe exited {completed.returncode}\n"
            f"--- stdout ---\n{completed.stdout[-2000:]}\n"
            f"--- stderr ---\n{completed.stderr[-2000:]}"
        )
    return json.loads(completed.stdout.split(_MARKER, 1)[1].splitlines()[0])


class RootPackageIdentityTests(unittest.TestCase):
    """Case 1: one root package object, under its canonical name."""

    def test_both_root_spellings_are_one_object(self) -> None:
        out = _probe(
            """
            import tools
            import saipen_engine
            import tools.saipen_engine as dotted
            out["same"] = saipen_engine is dotted
            out["name"] = saipen_engine.__name__
            out["file"] = saipen_engine.__file__
            """
        )
        self.assertTrue(out["same"], "saipen_engine and tools.saipen_engine differ")
        self.assertEqual(
            out["name"],
            "saipen_engine",
            "the engine package must live under ONE canonical name; a package "
            "executed as `tools.saipen_engine` makes every from-import resolve "
            "its children under the dotted name too",
        )
        self.assertEqual(
            os.path.normcase(os.path.abspath(out["file"])),
            os.path.normcase(str(ENGINE / "__init__.py")),
        )


class SubmoduleIdentityTests(unittest.TestCase):
    """Cases 2-5: submodules, both import orders, and the from-import form."""

    def _both_spellings(self, first: str) -> dict:
        return _probe(
            f"""
            import importlib
            import tools
            names = {REPRESENTATIVE!r}
            order = {first!r}
            same = {{}}
            for name in names:
                flat = "saipen_engine." + name
                dotted = "tools.saipen_engine." + name
                a, b = (flat, dotted) if order == "flat" else (dotted, flat)
                first_mod = importlib.import_module(a)
                second_mod = importlib.import_module(b)
                same[name] = first_mod is second_mod
            out["same"] = same
            out["keys"] = sorted(k for k in sys.modules if "saipen_engine" in k)
            """
        )

    def test_submodules_are_one_object_flat_first(self) -> None:
        out = self._both_spellings("flat")
        self.assertEqual(
            out["same"], {name: True for name in REPRESENTATIVE}, out["keys"]
        )

    def test_submodules_are_one_object_dotted_first(self) -> None:
        out = self._both_spellings("dotted")
        self.assertEqual(
            out["same"], {name: True for name in REPRESENTATIVE}, out["keys"]
        )

    def test_the_from_import_form_agrees_with_itself(self) -> None:
        out = _probe(
            """
            import tools
            from saipen_engine import runtime_bootstrap as flat
            from tools.saipen_engine import runtime_bootstrap as dotted
            out["same"] = flat is dotted
            out["flat_name"] = flat.__name__
            out["dotted_name"] = dotted.__name__
            """
        )
        self.assertTrue(out["same"], (out["flat_name"], out["dotted_name"]))
        self.assertEqual(out["flat_name"], "saipen_engine.runtime_bootstrap")
        self.assertEqual(out["dotted_name"], "saipen_engine.runtime_bootstrap")

    def test_a_relative_import_lands_in_the_same_graph(self) -> None:
        """`host_launch` reaches `runtime_bootstrap` relatively -- the T-1327 path.

        Both imports here are spelled `saipen_engine`, which is what makes the
        split so hard to see: the DOTTED form takes the name the caller wrote,
        the FROM form takes the name the package object carries.
        """
        out = _probe(
            """
            import importlib
            import tools
            import saipen_engine.runtime_bootstrap as patched_here
            from saipen_engine import host_launch
            reached = importlib.import_module(".runtime_bootstrap", host_launch.__package__)
            out["same"] = reached is patched_here
            out["package"] = host_launch.__package__
            out["reached"] = reached.__name__
            out["patched"] = patched_here.__name__
            """
        )
        self.assertTrue(
            out["same"],
            "the module host_launch reaches through its relative import is not "
            f"the one a from-import hands a test (package={out['package']})",
        )


class ExceptionAndStateIdentityTests(unittest.TestCase):
    """Cases 6-7: one exception class, one set of module globals."""

    def test_an_engine_exception_is_one_class(self) -> None:
        out = _probe(
            """
            import tools
            from saipen_engine.host_launch import HostLaunchRefusal as flat
            from tools.saipen_engine.host_launch import HostLaunchRefusal as dotted
            out["same"] = flat is dotted
            out["isinstance"] = isinstance(flat("x"), dotted)
            """
        )
        self.assertTrue(out["same"], "HostLaunchRefusal has two class objects")
        self.assertTrue(out["isinstance"])

    def test_module_globals_are_shared_between_spellings(self) -> None:
        out = _probe(
            """
            import tools
            import saipen_engine.paths as flat
            import tools.saipen_engine.paths as dotted
            flat._t1343_sentinel = "written-through-flat"
            out["read_back"] = getattr(dotted, "_t1343_sentinel", None)
            """
        )
        self.assertEqual(out["read_back"], "written-through-flat")


class CrossNamespaceMonkeypatchTests(unittest.TestCase):
    """Case 8: the exact T-1327 failure, without the real host.

    The patch is applied through ONE spelling and the launch path is reached
    through the OTHER. `prelaunch_runtime` is used rather than `launch_host`
    because it is the frame that performs the relative import; no process is
    started either way, and the unknown host id makes even an UNPATCHED real
    `prelaunch` a zero-mutation refusal (`HOST_UNIDENTIFIED`) instead of an
    install churn against the operator's homes.
    """

    def test_a_patch_through_one_spelling_is_seen_through_the_other(self) -> None:
        out = _probe(
            """
            import unittest.mock
            import tools
            import saipen_engine.runtime_bootstrap as rb
            from saipen_engine import host_launch

            sentinel = {
                "ok": True,
                "code": rb.PRELAUNCH_CURRENT,
                "detail": "PATCHED-THROUGH-SPELLING-A",
            }
            with unittest.mock.patch.object(rb, "prelaunch", return_value=sentinel):
                try:
                    report = host_launch.prelaunch_runtime("t1343-no-such-host")
                    out["detail"] = report.get("detail")
                    out["refused"] = None
                except host_launch.HostLaunchRefusal as exc:
                    out["detail"] = None
                    out["refused"] = str(exc)
            """
        )
        self.assertEqual(
            out["detail"],
            "PATCHED-THROUGH-SPELLING-A",
            "the REAL prelaunch ran: the patch was applied to a different "
            f"module object than the one host_launch imports ({out['refused']})",
        )


class SingleExecutionTests(unittest.TestCase):
    """Case 9: the file's top level runs ONCE, however it is spelled."""

    def test_an_engine_module_executes_once_under_both_spellings(self) -> None:
        out = _probe(
            """
            import importlib.machinery as machinery
            _original = machinery.SourceFileLoader.exec_module
            executed = []

            def counting(self, module):
                executed.append(getattr(module, "__file__", None))
                return _original(self, module)

            machinery.SourceFileLoader.exec_module = counting

            import tools
            import saipen_engine.host_launch
            import tools.saipen_engine.host_launch
            from saipen_engine import host_launch as a
            from tools.saipen_engine import host_launch as b

            def count(path):
                target = os.path.normcase(os.path.abspath(path))
                return sum(
                    1
                    for f in executed
                    if f and os.path.normcase(os.path.abspath(f)) == target
                )

            out["host_launch"] = count(a.__file__)
            out["package_init"] = count(
                os.path.join(os.path.dirname(a.__file__), "__init__.py")
            )
            out["same"] = a is b
            """
        )
        self.assertEqual(out["host_launch"], 1, "host_launch.py executed more than once")
        self.assertEqual(
            out["package_init"], 1, "the engine package executed more than once"
        )
        self.assertTrue(out["same"])


class HostileForeignPackageTests(unittest.TestCase):
    """Case 10: a hostile `saipen_engine` first on PYTHONPATH never wins.

    T-1341 proved both ENTRY FORMS ignore it. This adds the identity claim: the
    repository-owned engine is the one object both spellings resolve to even
    while a same-named package sits ahead of everything on the path.
    """

    def _hostile(self, base: Path) -> tuple[dict[str, str], Path]:
        foreign = base / "saipen_engine"
        foreign.mkdir(parents=True)
        sentinel = base / "foreign-executed.txt"
        (foreign / "__init__.py").write_text(
            "from pathlib import Path\n"
            f"Path(r'{sentinel}').write_text('executed')\n"
            "raise RuntimeError('foreign saipen_engine executed')\n",
            encoding="utf-8",
        )
        (foreign / "host_launch.py").write_text(
            "raise RuntimeError('foreign saipen_engine.host_launch executed')\n",
            encoding="utf-8",
        )
        env = hermetic_env()
        existing = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = str(base) + (os.pathsep + existing if existing else "")
        return env, sentinel

    def test_the_module_form_keeps_one_repository_owned_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="saipen-t1343-shadow-") as tmp:
            env, sentinel = self._hostile(Path(tmp))
            out = _probe(
                """
                import tools
                import saipen_engine
                import tools.saipen_engine as dotted
                import saipen_engine.host_launch as dotted_import_hl
                from saipen_engine import host_launch as from_import_hl
                from tools.saipen_engine import host_launch as prefixed_hl
                out["root_same"] = saipen_engine is dotted
                out["submodule_same"] = (
                    dotted_import_hl is from_import_hl is prefixed_hl
                )
                out["file"] = saipen_engine.__file__
                """,
                env=env,
            )
            self.assertFalse(sentinel.exists(), "the foreign package was executed")
            self.assertTrue(out["root_same"])
            self.assertTrue(out["submodule_same"])
            self.assertEqual(
                os.path.normcase(os.path.abspath(out["file"])),
                os.path.normcase(str(ENGINE / "__init__.py")),
            )

    def test_the_script_form_keeps_the_repository_engine(self) -> None:
        """`tools/` is `sys.path[0]` and the `tools` package never loads."""
        with tempfile.TemporaryDirectory(prefix="saipen-t1343-shadow-") as tmp:
            env, sentinel = self._hostile(Path(tmp))
            out = _probe(
                """
                import saipen_engine
                from saipen_engine import host_launch
                out["file"] = saipen_engine.__file__
                out["name"] = saipen_engine.__name__
                out["hl"] = host_launch.__name__
                """,
                cwd=TOOLS,
                env=env,
            )
            self.assertFalse(sentinel.exists(), "the foreign package was executed")
            self.assertEqual(
                os.path.normcase(os.path.abspath(out["file"])),
                os.path.normcase(str(ENGINE / "__init__.py")),
            )
            self.assertEqual(out["name"], "saipen_engine")
            self.assertEqual(out["hl"], "saipen_engine.host_launch")


class NestedSubpackageTests(unittest.TestCase):
    """A nested engine subpackage is one object too.

    A prefix rewrite is exactly where nesting breaks: `saipen_engine.runtime`
    is itself a package, so the alias has to carry its own `__path__` or the
    grandchild resolves through the real directory and forks the graph again.
    """

    def test_a_nested_package_and_its_child_are_one_object(self) -> None:
        out = _probe(
            """
            import importlib
            import tools
            flat_pkg = importlib.import_module("saipen_engine.runtime")
            dotted_pkg = importlib.import_module("tools.saipen_engine.runtime")
            flat_child = importlib.import_module("saipen_engine.runtime.base")
            dotted_child = importlib.import_module("tools.saipen_engine.runtime.base")
            from tools.saipen_engine.runtime import base as from_child
            out["package_same"] = flat_pkg is dotted_pkg
            out["child_same"] = flat_child is dotted_child is from_child
            out["child_name"] = flat_child.__name__
            """
        )
        self.assertTrue(out["package_same"], "saipen_engine.runtime has two objects")
        self.assertTrue(out["child_same"], "saipen_engine.runtime.base has two objects")
        self.assertEqual(out["child_name"], "saipen_engine.runtime.base")


class PreImportedForeignEngineTests(unittest.TestCase):
    """A foreign `saipen_engine` already in `sys.modules` does not get to stay.

    T-1341 covered a foreign package on the PATH. The residual case is one
    already IMPORTED under that name before anything touches this repository --
    a sitecustomize, a conftest, an embedding host. "Repository-local wins" has
    to hold for an occupied name too, because an occupied name is exactly where
    a second engine would survive unnoticed. The foreign object stays alive for
    whoever already holds a reference; it just stops answering for the name.
    """

    def test_the_repository_engine_takes_the_name_back(self) -> None:
        out = _probe(
            """
            import types
            foreign = types.ModuleType("saipen_engine")
            foreign.__file__ = os.path.join(os.getcwd(), "not-the-repository", "__init__.py")
            foreign.__path__ = [os.path.join(os.getcwd(), "not-the-repository")]
            foreign.SENTINEL = "foreign"
            sys.modules["saipen_engine"] = foreign

            import tools
            import saipen_engine
            from saipen_engine import host_launch

            out["replaced"] = saipen_engine is not foreign
            out["foreign_untouched"] = getattr(foreign, "SENTINEL", None)
            out["file"] = saipen_engine.__file__
            out["submodule"] = host_launch.__name__
            """
        )
        self.assertTrue(out["replaced"], "a foreign module kept the engine's name")
        self.assertEqual(out["foreign_untouched"], "foreign")
        self.assertEqual(
            os.path.normcase(os.path.abspath(out["file"])),
            os.path.normcase(str(ENGINE / "__init__.py")),
        )
        self.assertEqual(out["submodule"], "saipen_engine.host_launch")

    def test_foreign_children_do_not_survive_under_the_reclaimed_name(self) -> None:
        """Taking the root name back must not leave foreign `saipen_engine.X`.

        A stale child is worse than a stale root: the root is ours, so nothing
        looks wrong, and `saipen_engine.paths` quietly hands back someone
        else's module -- the mixed graph rebuilt out of another package.
        """
        out = _probe(
            """
            import types
            foreign = types.ModuleType("saipen_engine")
            foreign.__file__ = os.path.join(os.getcwd(), "not-the-repository", "__init__.py")
            foreign.__path__ = [os.path.join(os.getcwd(), "not-the-repository")]
            child = types.ModuleType("saipen_engine.paths")
            child.__file__ = os.path.join(os.getcwd(), "not-the-repository", "paths.py")
            child.SENTINEL = "foreign-child"
            sys.modules["saipen_engine"] = foreign
            sys.modules["saipen_engine.paths"] = child

            import tools
            import saipen_engine.paths as reached

            out["child_replaced"] = reached is not child
            out["child_sentinel"] = getattr(reached, "SENTINEL", None)
            out["child_file"] = reached.__file__
            """
        )
        self.assertTrue(out["child_replaced"], "a foreign submodule survived the reclaim")
        self.assertIsNone(out["child_sentinel"])
        self.assertEqual(
            os.path.normcase(os.path.abspath(out["child_file"])),
            os.path.normcase(str(ENGINE / "paths.py")),
        )

    def test_an_engine_already_loaded_from_this_repository_is_reused(self) -> None:
        """The script form loads it first; importing `tools` must not re-run it."""
        out = _probe(
            """
            import importlib.machinery as machinery
            _original = machinery.SourceFileLoader.exec_module
            executed = []

            def counting(self, module):
                executed.append(getattr(module, "__file__", None))
                return _original(self, module)

            machinery.SourceFileLoader.exec_module = counting

            sys.path.insert(0, os.path.join(os.getcwd(), "tools"))
            import saipen_engine as before
            import tools
            import saipen_engine as after

            out["same"] = before is after
            target = os.path.normcase(os.path.abspath(before.__file__))
            out["executions"] = sum(
                1
                for f in executed
                if f and os.path.normcase(os.path.abspath(f)) == target
            )
            """
        )
        self.assertTrue(out["same"], "importing tools replaced an engine it already had")
        self.assertEqual(out["executions"], 1, "the engine package executed twice")


class AliasRefusalTests(unittest.TestCase):
    """The rewrite declines cleanly; it never invents a module.

    Declining is where a prefix rewrite can quietly reintroduce the defect: a
    finder that answers "not mine" to a REAL engine module whose own import
    raised sends the machinery to the path finder, which executes the file a
    second time under the dotted name.
    """

    def test_a_name_that_is_not_an_engine_module_raises_normally(self) -> None:
        out = _probe(
            """
            import tools
            for spelling in ("saipen_engine.no_such_module",
                             "tools.saipen_engine.no_such_module"):
                try:
                    __import__(spelling)
                    out[spelling] = None
                except ModuleNotFoundError as exc:
                    out[spelling] = exc.name
            """
        )
        self.assertEqual(out["saipen_engine.no_such_module"], "saipen_engine.no_such_module")
        self.assertEqual(
            out["tools.saipen_engine.no_such_module"],
            "tools.saipen_engine.no_such_module",
        )

    def test_an_engine_import_error_is_reported_not_re_executed(self) -> None:
        """A module that raises on import must not be run again under the alias."""
        out = _probe(
            """
            import importlib.machinery as machinery
            import tools

            broken = os.path.join(
                os.path.dirname(sys.modules["saipen_engine"].__file__),
                "_t1343_broken_probe.py",
            )
            with open(broken, "w", encoding="utf-8") as handle:
                handle.write("raise ImportError('deliberate: the engine module itself failed')\\n")
            try:
                _original = machinery.SourceFileLoader.exec_module
                executed = []

                def counting(self, module):
                    executed.append(getattr(module, "__file__", None))
                    return _original(self, module)

                machinery.SourceFileLoader.exec_module = counting
                try:
                    __import__("tools.saipen_engine._t1343_broken_probe")
                    out["raised"] = None
                except ImportError as exc:
                    out["raised"] = str(exc)
                target = os.path.normcase(os.path.abspath(broken))
                out["executions"] = sum(
                    1
                    for f in executed
                    if f and os.path.normcase(os.path.abspath(f)) == target
                )
            finally:
                machinery.SourceFileLoader.exec_module = _original
                os.remove(broken)
            """
        )
        self.assertIn("deliberate", out["raised"] or "")
        self.assertEqual(out["executions"], 1, "the failing module was executed twice")


class NoStrayGraphTests(unittest.TestCase):
    """Whatever an entry form imports, `sys.modules` holds ONE object per file."""

    def test_the_cli_leaves_one_object_per_engine_file(self) -> None:
        out = _probe(
            """
            import tools
            import tools.saipen  # noqa: F401 -- the module-form CLI entry point
            import saipen_engine  # noqa: F401
            from saipen_engine import router, board, state  # noqa: F401
            from tools.saipen_engine import router as r2, board as b2, state as s2  # noqa: F401
            by_file = {}
            for name, module in list(sys.modules.items()):
                path = getattr(module, "__file__", None)
                if not path or "saipen_engine" not in name:
                    continue
                key = os.path.normcase(os.path.abspath(path))
                by_file.setdefault(key, set()).add(id(module))
            out["duplicated"] = sorted(
                path for path, ids in by_file.items() if len(ids) > 1
            )
            out["files"] = len(by_file)
            """
        )
        self.assertEqual(out["duplicated"], [], "one file, two live module objects")
        self.assertGreater(out["files"], 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
