"""The `tools` package -- one place that makes `saipen_engine` importable.

T-1339. Every module in this directory imports `saipen_engine` at top level and
used to rely on this directory reaching `sys.path` by accident. That is true
when a file is run AS A SCRIPT, because Python puts the script's own directory
on the path:

    python tools/saipen.py status          # works

and false for the module form, which puts the REPOSITORY ROOT there instead:

    python -m tools.saipen status          # ModuleNotFoundError: saipen_engine
    python -m unittest tools.test_cold_agent_truth

Both spellings look supported, nothing documents that one is not, and the
failure is the project's own CLI reporting `No module named 'saipen_engine'`.
An agent reaching for the module form reads that traceback as a broken protocol
install rather than as a wrong invocation -- and the repository disagreed with
itself about which form worked, since the test modules that DO insert the path
by hand ran fine under `python -m unittest` while fourteen others did not.

Importing `tools.anything` runs this file first, so the fix belongs here and
nowhere else: one owner, no per-file path munging to keep in sync, and nothing
changes for the script form, which already had the path it needed.

T-1343. The engine has ONE canonical module name: `saipen_engine`. Everything
that ships spells it that way -- every `tools/*.py` module, every relative
import inside the engine, the flattened installed runtime -- and the script
form resolves exactly that. The single reason `tools.saipen_engine` ever
existed as a live module was T-1341's alias, which EXECUTED the package under
the dotted name and then registered that object under the flat one:

    from . import saipen_engine as _saipen_engine     # runs as tools.saipen_engine
    sys.modules["saipen_engine"] = _saipen_engine     # __name__ stays dotted

The root was then one object under two names, but its CHILDREN were not. CPython
resolves a missing from-list child against the parent module's OWN name
(`Lib/importlib/_bootstrap.py`, `_handle_fromlist`), while a dotted import uses
the name the caller wrote, so under the module form

    import saipen_engine.runtime_bootstrap    -> saipen_engine.runtime_bootstrap
    from saipen_engine import runtime_bootstrap -> tools.saipen_engine.runtime_bootstrap

executed the same FILE twice as two live module objects. Two objects means two
sets of globals, two exception classes, two caches, and a monkeypatch that one
half of the engine cannot see: the T-1327 launch fixture patched `prelaunch` on
one copy, `host_launch` reached the other through its relative import, and the
operator's REAL OpenCode host started.

So this file no longer aliases a dotted package into the flat name. It LOADS
the engine under its canonical name from the repository's own directory, and
maps the dotted spelling onto those same objects:

  * `_load_canonical_engine()` executes `tools/saipen_engine/__init__.py` as
    `saipen_engine`, from an explicit file location. Registering it in
    `sys.modules` before any path entry is consulted is also what keeps a
    foreign same-named package on `PYTHONPATH` or in site-packages from
    shadowing the repository's engine (T-1341's actual requirement), without a
    broad `sys.path` precedence mutation.
  * `_CanonicalEngineFinder` resolves `tools.saipen_engine` and every
    `tools.saipen_engine.X` to the module object already loaded as
    `saipen_engine.X`, importing the canonical name and handing back THAT
    object rather than executing the file again. It is a prefix rewrite, so it
    covers submodules that do not exist yet: nothing here has to be kept in
    sync with the engine's file list.

`tools.saipen_engine` therefore never becomes an independent package, and
`sys.modules["saipen_engine.X"] is sys.modules["tools.saipen_engine.X"]` holds
for every X. The matrix that pins it is `tools/test_engine_module_identity.py`.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from importlib.machinery import ModuleSpec
from pathlib import Path
from types import ModuleType

_TOOLS = Path(__file__).resolve().parent
_TOOLS_PATH = str(_TOOLS)
if _TOOLS_PATH not in sys.path:
    # Appended, never prepended: the repository root stays ahead of this
    # directory, so a module form still resolves `tools.x` as `tools.x` and
    # this only ADDS the flat `saipen_engine` spelling the modules use. The
    # engine's own identity no longer depends on this entry -- see below -- but
    # the other flat spellings in this directory still do.
    sys.path.append(_TOOLS_PATH)

#: The engine's one canonical module name. Not configurable: it is the name the
#: shipped code, the relative imports and the installed flattened runtime use.
CANONICAL_ENGINE = "saipen_engine"

#: The spelling this package would otherwise materialize as a second package.
ALIAS_ENGINE = f"{__name__}.{CANONICAL_ENGINE}"

_ENGINE_DIR = _TOOLS / CANONICAL_ENGINE


def _is_repository_engine(module: ModuleType) -> bool:
    """Is this module object the engine that lives in THIS repository?

    Both sides are resolved. Comparing a resolved `__file__` against an
    unresolved directory would answer "no" for a checkout reached through a
    symlink or a junction -- and answering "no" here means loading a SECOND
    copy of the engine we already have, which is the defect this file exists
    to remove.
    """
    origin = getattr(module, "__file__", None)
    if not origin:
        return False
    try:
        return Path(origin).resolve().parent == _ENGINE_DIR.resolve()
    except OSError:
        return False


def _load_canonical_engine() -> ModuleType:
    """Execute `tools/saipen_engine/__init__.py` as `saipen_engine`, once.

    An engine already loaded from this repository is reused untouched -- the
    script form has usually loaded it before anything imports this package.
    Anything else under that name came from outside the repository and does not
    get to answer for the engine.
    """
    loaded = sys.modules.get(CANONICAL_ENGINE)
    if loaded is not None and _is_repository_engine(loaded):
        return loaded
    if loaded is not None:
        # Taking the NAME back is not enough. A foreign package that got there
        # first may already have children registered as `saipen_engine.X`, and
        # leaving those behind would hand a caller foreign code under a name
        # whose root is now ours -- the mixed graph this file exists to make
        # impossible, rebuilt out of someone else's modules.
        for name in [
            key
            for key in sys.modules
            if key == CANONICAL_ENGINE or key.startswith(f"{CANONICAL_ENGINE}.")
        ]:
            del sys.modules[name]

    spec = importlib.util.spec_from_file_location(
        CANONICAL_ENGINE,
        _ENGINE_DIR / "__init__.py",
        submodule_search_locations=[str(_ENGINE_DIR)],
    )
    if spec is None or spec.loader is None:  # pragma: no cover - a broken checkout
        raise ImportError(f"the repository engine is unreadable at {_ENGINE_DIR}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[CANONICAL_ENGINE] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(CANONICAL_ENGINE, None)
        raise
    return module


class _CanonicalEngineLoader:
    """Hand back the canonically named module instead of executing a copy.

    `importlib` initialises whatever `create_module` returns with the spec it
    was found under, and `__spec__` is the one attribute it overwrites
    unconditionally (`_init_module_attrs`); `__name__`, `__package__`,
    `__path__` and `__file__` are left alone once set. Restoring `__spec__` in
    `exec_module` -- which runs immediately afterwards -- keeps the canonical
    module describing itself canonically, so a later `importlib.reload` or any
    reader of `__spec__.name` still sees `saipen_engine.X`.
    """

    _NOT_CAPTURED = object()

    def __init__(self, canonical: str) -> None:
        self._canonical = canonical
        self._own_spec: object = self._NOT_CAPTURED

    def create_module(self, spec: ModuleSpec) -> ModuleType:
        module = importlib.import_module(self._canonical)
        self._own_spec = getattr(module, "__spec__", None)
        return module

    def exec_module(self, module: ModuleType) -> None:
        # A sentinel, not a None check: a module whose `__spec__` really is
        # None must be handed back with None, not left wearing the alias spec.
        if self._own_spec is not self._NOT_CAPTURED:
            module.__spec__ = self._own_spec


class _CanonicalEngineFinder:
    """Rewrite `tools.saipen_engine[.X]` to `saipen_engine[.X]`, by prefix.

    A prefix rewrite rather than a table: an engine module added tomorrow is
    covered the day it is written, and nothing in this file has to remember it.
    """

    def find_spec(
        self,
        fullname: str,
        path: object = None,
        target: ModuleType | None = None,
    ) -> ModuleSpec | None:
        if fullname != ALIAS_ENGINE and not fullname.startswith(f"{ALIAS_ENGINE}."):
            return None
        canonical = CANONICAL_ENGINE + fullname[len(ALIAS_ENGINE) :]
        try:
            module = importlib.import_module(canonical)
        except ModuleNotFoundError as exc:
            if exc.name != canonical:
                # The engine module EXISTS and its own import failed. Reporting
                # that is the useful answer; declining here would send the
                # machinery down the path finder and execute the file a second
                # time under the dotted name, which is the defect this class
                # exists to remove.
                raise
            # Not an engine module at all: let the normal machinery produce the
            # normal ModuleNotFoundError for the name the caller actually wrote.
            return None
        spec = ModuleSpec(fullname, _CanonicalEngineLoader(canonical))
        submodule_search_locations = getattr(module, "__path__", None)
        if submodule_search_locations is not None:
            spec.submodule_search_locations = list(submodule_search_locations)
        return spec


def _install_canonical_engine_finder() -> None:
    if any(isinstance(finder, _CanonicalEngineFinder) for finder in sys.meta_path):
        return
    sys.meta_path.insert(0, _CanonicalEngineFinder())


saipen_engine = _load_canonical_engine()
_install_canonical_engine_finder()
sys.modules[ALIAS_ENGINE] = saipen_engine
