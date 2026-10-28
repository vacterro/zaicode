"""ONE shared expansion of saipen/MANIFEST.json (runtime surface).

The validator (tools/validate.py) and the injector (tools/autoinject.py) must
agree on what the runtime manifest ships: the injector copies the surface,
the validator proves every clone has it. Two divergent expansions are how a
declared tree gets skipped in validation while still being copied -- or
validated against a root that is not the repository at all (v7.224.4 bug
class: `_tools_parent.parent / tree["src"]` resolved one level above the
home, so every copy_trees directory silently failed its `is_dir()` guard).

This module is the ONE expansion. Missing or unsafe entries raise RuntimeError
with a stable message; they are never silently skipped.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path, PurePosixPath

#: Windows FILE_ATTRIBUTE_REPARSE_POINT. A junction is not a symlink to
#: `Path.is_symlink()` on every supported Python, yet a walk or a copy follows
#: it out of the declared tree exactly like one.
REPARSE_POINT = 0x400


def is_link(path: Path) -> bool:
    """True for a symlink OR a Windows junction/reparse point.

    An absent path is not a link (existence is the caller's own check); an
    entry whose metadata cannot be read raises, because "could not tell" must
    never read as "plain file".
    """
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise RuntimeError(f"runtime manifest entry unreadable: {path}: {exc}") from exc
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(getattr(info, "st_file_attributes", 0) & REPARSE_POINT)


# T-1254: the ONE cache-prune rule. It lived as a local inside
# `copy_tree_members` while `autoinject._digest` carried its own shorter
# version, so a clone that had run pytest hashed four `.pytest_cache` files
# the copier would never ship and the freshness digest could not match the
# snapshot it was compared against. Two filters over the same surface are
# one filter and a latent disagreement.
CACHE_DIRS = frozenset({"__pycache__", ".pytest_cache"})
GENERATED_SUFFIXES = frozenset({".pyc", ".pyo"})


def manifest_source(root: Path, raw: object) -> Path:
    """Resolve one manifest `src` against `root`; reject unsafe spellings.

    Non-string sources, backslash escapes, absolute sources and `..`
    traversal are refused even when the resolved path would stay inside the
    root: a manifest that names an outside path is broken by construction.
    """
    if not isinstance(raw, str) or not raw or "\\" in raw:
        raise RuntimeError(f"unsafe runtime manifest source: {raw!r}")
    relative = PurePosixPath(raw)
    if relative.is_absolute() or ".." in relative.parts:
        raise RuntimeError(f"unsafe runtime manifest source: {raw!r}")
    source = (root / Path(*relative.parts)).resolve()
    try:
        source.relative_to(root.resolve())
    except ValueError as exc:
        raise RuntimeError(f"runtime manifest source escapes repository root: {raw!r}") from exc
    return source


def copy_tree_members(root: Path, raw: object) -> tuple[Path, list[Path]]:
    """Expand one `copy_trees` entry into (source_dir, member files).

    Members are enumerated exactly the way the injectors copy them:
    build/test caches (__pycache__, .pytest_cache) are pruned, .pyc/.pyo files
    are skipped, and any symlink or junction/reparse point anywhere in the
    surface is refused (a copy would follow it; `bootstrap/inject.ps1` refuses
    reparse points for the same reason). A missing or symlinked tree root is
    refused too: a declared tree that is absent is a broken manifest, never a
    silent skip. An unreadable directory inside the tree raises instead of
    being skipped: `os.walk` ignores listing errors unless told otherwise, and
    a silently shorter member list is a partial surface that still looks whole.
    """
    source = manifest_source(root, raw)
    if not source.is_dir() or source.is_symlink():
        raise RuntimeError(f"runtime manifest tree missing or symlinked: {raw}")

    def _unreadable(exc: OSError) -> None:
        raise RuntimeError(f"runtime manifest tree unreadable: {raw}: {exc}") from exc

    # Regenerable build/test caches that sit inside a copy_trees source (e.g.
    # tools/) but are NEVER part of the shipped runtime surface. Sweeping them
    # into the manifest makes an untracked machine-local cache file fail the
    # "every clone has this file" check, and committing a cache would ship
    # local state (CORE-009).
    _CACHE_DIRS = CACHE_DIRS
    members: list[Path] = []
    for _walk_root, _dirs, _files in os.walk(source, onerror=_unreadable):
        for _d in list(_dirs):
            _d_path = Path(_walk_root) / _d
            if is_link(_d_path):
                raise RuntimeError(
                    "runtime manifest tree contains symlink: "
                    f"{_d_path.relative_to(root.resolve()).as_posix()}"
                )
            if _d in _CACHE_DIRS:
                _dirs.remove(_d)
        for _file in _files:
            if _file.endswith((".pyc", ".pyo")):
                continue
            _f_path = Path(_walk_root) / _file
            if is_link(_f_path):
                raise RuntimeError(
                    "runtime manifest tree contains symlink: "
                    f"{_f_path.relative_to(root.resolve()).as_posix()}"
                )
            members.append(_f_path)
    return source, sorted(members)
