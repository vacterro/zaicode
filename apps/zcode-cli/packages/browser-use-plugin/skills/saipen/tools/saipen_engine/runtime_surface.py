"""ONE shipped-runtime generation identity for every SAIPEN freshness surface.

PATH is variable; the EXECUTED generation is not. A freshness check may point
at any real SAIPEN home -- the source clone, the scheduled-source published
snapshot, an installed skill copy -- and two of them are CURRENT for each other
only when they prove the SAME accepted generation of the shipped runtime.

What "generation" means here (T-1342): the manifest-declared shipped surface --
every `copy_trees` member and every required `files` entry of
`saipen/MANIFEST.json` -- digested with the SAME content policy the injector
ships with:

* text is LF-normalised, so the clone's LF and the snapshot's CRLF are one
  content (T-1253);
* content holding a NUL byte, or that is not valid UTF-8, is binary and
  byte-exact -- git's own text heuristic -- so normalisation can never
  reinterpret a binary payload that happens to decode;
* regenerable caches (`CACHE_DIRS`, `.pyc`/`.pyo`) are pruned by the manifest
  owner, never by a second filter list;
* SOURCE (`root/saipen/x`) and FLATTENED (`root/x`) layouts resolve to one
  logical declared name, so a source clone and its installed snapshot at
  identical shipped bytes share one identity;
* every logical declared name appears exactly once, and two distinct declared
  names that would land on one installed path (case-insensitively) are a
  broken manifest, never a silent collapse;
* `.git`, repository-only files and machine-local state are not part of the
  manifest surface and therefore never part of the identity.

Before T-1342 the freshness surfaces hashed a bounded protocol-DOCUMENT tuple,
so a root could carry byte-identical docs and a DIFFERENT `tools/saipen.py` and
still classify CURRENT -- while the guard hook executes exactly that engine.

Fail closed. This module never guesses: a missing declared runtime file, an
unreadable file or directory, a symlink/junction/reparse point anywhere between
the root and a shipped file, a copy tree whose declared destination disagrees
with its installed landing path, an empty copy tree, a missing required phase
document, an absent, ambiguous or malformed manifest, or an empty expansion
returns `None` (UNKNOWN) from the None-safe entry point and raises from
`require_...`. A caller must treat None as STALE/UNKNOWN, never as a match. A
self-declared stamp or marker digest may accelerate diagnosis; it can never
override a content mismatch.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Iterator

from .manifest import REPARSE_POINT, copy_tree_members, manifest_source

#: The runtime manifest name, in either supported layout.
MANIFEST_NAME = "MANIFEST.json"

#: The protocol directory of a SOURCE layout, stripped on install.
_PROTOCOL_DIR = "saipen"

#: Prefix stripped when a declared source path lands in an installed home.
_SOURCE_PREFIX = _PROTOCOL_DIR + "/"

#: Every identity string carries its scheme, so a digest from another scheme
#: (the retired 16-hex stamp, the retired provenance fingerprint) can never
#: compare equal by accident.
IDENTITY_SCHEME = "gen-sha256:"

#: Identity memo for ONE bounded read-only projection (see `identity_session`).
_SESSION: dict[str, str | None] | None = None


class RuntimeSurfaceError(RuntimeError):
    """The declared shipped surface cannot be proven; the caller fails closed."""


def normalize_content(raw: bytes) -> bytes:
    """The shipped CONTENT of one file's bytes: LF text, byte-exact binary.

    The one normalisation the injector always used (T-1253), shared by the
    guard, the instruction check, the distribution report and the runtime
    prelaunch instead of each surface re-implementing it. The two sides of a
    comparison arrive through different transports -- the clone holds LF, the
    snapshot git produces holds CRLF -- so hashing raw text bytes would make a
    home refreshed seconds ago report STALE forever.

    Binary stays byte-exact: content that is not valid UTF-8 has no line
    endings to normalise, and content carrying a NUL byte is binary even when it
    happens to decode (the same test git applies before it converts line
    endings), so two binaries differing only in a CR byte never collapse.
    """
    if b"\0" in raw:
        return raw
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw
    return raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")


def content_bytes(path: Path) -> bytes:
    """The shipped CONTENT of a file: LF-normalised text, byte-exact binary."""
    return normalize_content(path.read_bytes())


def installed_relpath(relative: str) -> str:
    """Where a declared source path lands inside an installed home.

    The injectors strip exactly one leading `saipen/` component and keep
    everything else: `saipen/BOOT.md` installs as `BOOT.md`, `saipen/phases/`
    as `phases/`, while `tools/`, `bootstrap/` and `extensions/` keep theirs.
    """
    if relative.startswith(_SOURCE_PREFIX):
        return relative[len(_SOURCE_PREFIX) :]
    return relative


def _lstat(path: Path, what: str):
    try:
        return os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RuntimeSurfaceError(f"{what} unreadable: {path}: {exc}") from exc


def _is_link_info(info) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & REPARSE_POINT
    )


def _require_plain_chain(base: Path, relative: str) -> None:
    """Refuse a link anywhere between `base` and `base/relative`.

    `manifest_source` RESOLVES a declared path, and resolution silently follows
    a symlink or junction that stays inside the root -- after which the resolved
    path is no longer a link and passes every later check. The injector refuses
    reparse points, so the identity refuses them on the UNRESOLVED spelling.
    The root itself may be reached through a link: PATH is variable.
    """
    current = base
    for part in PurePosixPath(relative).parts:
        current = current / part
        info = _lstat(current, "runtime surface path")
        if info is None:
            return  # absence is reported by the caller's own existence check
        if _is_link_info(info):
            raise RuntimeSurfaceError(f"runtime surface path is a link or reparse point: {current}")


def _require_regular_file(path: Path, declared: str) -> None:
    info = _lstat(path, "declared runtime file")
    if info is None:
        raise RuntimeSurfaceError(f"declared runtime file missing: {declared}")
    if _is_link_info(info):
        raise RuntimeSurfaceError(f"declared runtime file is a link or reparse point: {declared}")
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeSurfaceError(f"declared runtime file is not a regular file: {declared}")


def _layout(root: Path) -> tuple[Path, bool]:
    """(manifest_path, source_layout) for `root`, or raise.

    A root carrying BOTH spellings is ambiguous: which manifest governs it is
    exactly the question that must never be guessed.
    """
    source = root / _PROTOCOL_DIR / MANIFEST_NAME
    flat = root / MANIFEST_NAME
    has_source, has_flat = source.is_file(), flat.is_file()
    if has_source and has_flat:
        raise RuntimeSurfaceError(
            f"ambiguous runtime layout under {root}: both {_SOURCE_PREFIX}{MANIFEST_NAME} "
            f"and {MANIFEST_NAME} exist"
        )
    if has_source:
        return source, True
    if has_flat:
        return flat, False
    raise RuntimeSurfaceError(f"no runtime manifest under {root}")


def runtime_surface_items(root: Path | str) -> list[tuple[str, Path]]:
    """Every shipped runtime file as (declared source path, resolved path).

    The declared key is the manifest's own spelling (`saipen/BOOT.md`,
    `tools/saipen_engine/fleet.py`) and is the SAME in both layouts: framing by
    declared name is what makes a source clone and its flattened install one
    identity. The resolved path follows the layout under test.

    Raises `RuntimeSurfaceError` on any unprovable surface: a partial surface is
    never silently forgotten.
    """
    base = Path(root)
    if not base.is_dir():
        raise RuntimeSurfaceError(f"runtime root is not a directory: {base}")
    manifest_path, source_layout = _layout(base)
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeSurfaceError(f"runtime manifest unreadable: {manifest_path}: {exc}") from exc
    if not isinstance(manifest, dict):
        raise RuntimeSurfaceError(f"runtime manifest is not an object: {manifest_path}")
    trees = manifest.get("copy_trees")
    entries = manifest.get("files")
    if not isinstance(trees, list) or not isinstance(entries, list):
        raise RuntimeSurfaceError("runtime manifest shape invalid: copy_trees/files")
    if not trees and not entries:
        raise RuntimeSurfaceError("runtime manifest declares an empty surface")

    surface: dict[str, Path] = {}
    landings: dict[str, str] = {}

    def admit(declared: str, path: Path) -> None:
        known = surface.get(declared)
        if known is not None:
            # The real manifest declares some files both as a tree member and
            # as a required entry. One name, one file: counted once. One name
            # resolving to two files is a broken manifest.
            if known != path:
                raise RuntimeSurfaceError(f"declared runtime name resolves twice: {declared}")
            return
        landing = installed_relpath(declared).casefold()
        other = landings.get(landing)
        if other is not None:
            raise RuntimeSurfaceError(
                f"declared runtime names {other} and {declared} land on one installed path"
            )
        landings[landing] = declared
        surface[declared] = path

    def locate(raw: object, kind: str) -> tuple[str, str, Path]:
        if not isinstance(raw, str) or not raw:
            raise RuntimeSurfaceError(f"runtime manifest {kind} entry invalid: {raw!r}")
        mapped = raw if source_layout else installed_relpath(raw)
        try:
            resolved = manifest_source(base, mapped)
        except RuntimeError as exc:
            raise RuntimeSurfaceError(str(exc)) from exc
        _require_plain_chain(base, mapped)
        return raw, mapped, resolved

    for entry in trees:
        if not isinstance(entry, dict):
            raise RuntimeSurfaceError(f"runtime manifest tree entry invalid: {entry!r}")
        raw, mapped, _resolved = locate(entry.get("src"), "tree")
        dst = entry.get("dst")
        prefix = raw.rstrip("/")
        if not isinstance(dst, str) or dst.rstrip("/") != installed_relpath(prefix):
            # The injector copies a tree to `dst`; the identity maps it to
            # `installed_relpath(src)`. Two answers to "where does it land" is
            # a manifest the identity cannot prove.
            raise RuntimeSurfaceError(
                f"runtime manifest tree {raw} declares destination {dst!r}, "
                f"but its installed landing is {installed_relpath(prefix)!r}"
            )
        try:
            source_dir, members = copy_tree_members(base, mapped)
        except RuntimeError as exc:
            raise RuntimeSurfaceError(str(exc)) from exc
        if not members:
            raise RuntimeSurfaceError(f"runtime manifest tree is empty: {raw}")
        for member in members:
            declared = f"{prefix}/{member.relative_to(source_dir).as_posix()}"
            _require_regular_file(member, declared)
            admit(declared, member)

    for entry in entries:
        if not isinstance(entry, dict):
            raise RuntimeSurfaceError(f"runtime manifest file entry invalid: {entry!r}")
        if entry.get("required") is not True:
            continue
        raw, _mapped, resolved = locate(entry.get("src"), "file")
        _require_regular_file(resolved, raw)
        admit(raw, resolved)

    phase_docs = manifest.get("phase_docs")
    if phase_docs is not None:
        if (
            not isinstance(phase_docs, dict)
            or not isinstance(phase_docs.get("src_dir"), str)
            or not isinstance(phase_docs.get("files"), list)
        ):
            raise RuntimeSurfaceError("runtime manifest phase_docs shape invalid")
        if phase_docs.get("required") is True:
            src_dir = phase_docs["src_dir"].rstrip("/")
            for name in phase_docs["files"]:
                if not isinstance(name, str) or not name or "/" in name or "\\" in name:
                    raise RuntimeSurfaceError(f"runtime manifest phase document invalid: {name!r}")
                if f"{src_dir}/{name}" not in surface:
                    raise RuntimeSurfaceError(
                        "required phase document missing from the shipped surface: "
                        f"{src_dir}/{name}"
                    )

    if not surface:
        raise RuntimeSurfaceError("runtime manifest expands to an empty surface")
    return sorted(surface.items(), key=lambda item: item[0])


def _digest_items(items: list[tuple[str, Path]]) -> str:
    digest = hashlib.sha256()
    for declared, path in items:
        try:
            payload = content_bytes(path)
        except OSError as exc:
            raise RuntimeSurfaceError(
                f"shipped runtime file unreadable: {declared}: {exc}"
            ) from exc
        digest.update(declared.encode("utf-8") + b"\0")
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return IDENTITY_SCHEME + digest.hexdigest()


def require_runtime_generation_identity(root: Path | str | None) -> str:
    """The content identity of the shipped runtime at `root`, or raise."""
    if root is None:
        raise RuntimeSurfaceError("no root to prove")
    return _digest_items(runtime_surface_items(root))


def _session_key(root: Path | str) -> str:
    return os.path.normcase(os.path.abspath(str(root)))


@contextmanager
def identity_session() -> Iterator[None]:
    """Memoise identities for ONE bounded read-only projection.

    A report that compares many surfaces against one expected generation would
    otherwise re-hash the same roots several times (the distribution report,
    the guard-hook check it performs, the instruction homes it resolves). The
    memo exists only inside this block, so a later check always re-reads bytes;
    nested sessions share the outermost memo.
    """
    global _SESSION  # noqa: PLW0603
    outer = _SESSION
    if outer is None:
        _SESSION = {}
    try:
        yield
    finally:
        if outer is None:
            _SESSION = None


def runtime_generation_identity(root: Path | str | None) -> str | None:
    """The content identity of the shipped runtime at `root`, or None (UNKNOWN).

    None means the root cannot prove a generation -- not that it matched.
    Callers must treat it as STALE/UNKNOWN.
    """
    if root is None:
        return None
    key = _session_key(root) if _SESSION is not None else None
    if key is not None and key in _SESSION:
        return _SESSION[key]
    try:
        identity: str | None = require_runtime_generation_identity(root)
    except (OSError, RuntimeError, ValueError):
        identity = None
    if key is not None and _SESSION is not None:
        _SESSION[key] = identity
    return identity


def same_runtime_generation(left: Path | str | None, right: Path | str | None) -> bool:
    """True only when BOTH roots prove the SAME non-empty runtime generation."""
    left_id = runtime_generation_identity(left)
    if left_id is None:
        return False
    return left_id == runtime_generation_identity(right)


def protocol_home_runtime_root(home: Path | str) -> Path:
    """The runtime root behind a protocol home an instruction block names.

    The activation block sends every agent to `{{SAIPEN_HOME}}/BOOT.md`, so the
    home it names is a PROTOCOL directory: the flattened install root itself,
    or `<root>/saipen` in a source clone or published snapshot. A generation is
    a property of the whole runtime root. A home that proves a generation on its
    own is its own root; a `saipen` directory that carries the manifest but
    cannot prove one by itself is a SOURCE protocol directory and resolves to
    its parent, which must then prove the generation in source layout. This is
    for protocol homes only: a guard hook `--saipen-root` executes
    `<root>/tools/saipen.py` and is proven as given, never re-rooted.
    """
    base = Path(home)
    if runtime_generation_identity(base) is not None:
        return base
    if base.name.casefold() == _PROTOCOL_DIR and (base / MANIFEST_NAME).is_file():
        return base.parent
    return base


def surface_delta(
    expected_root: Path | str, candidate_root: Path | str, limit: int | None = None
) -> list[tuple[str, Path | None, Path | None]]:
    """Declared names whose shipped content differs, as (name, expected, candidate).

    Diagnostic companion to `same_runtime_generation`: the VERDICT is the
    identity comparison, this names WHAT differs so an operator is never handed
    a bare digest. Both inventories come from this owner, so a name present on
    one side only is reported too -- an extra module in an installed engine is
    a difference, not noise. A path is None where that side lacks the name.

    Raises `RuntimeSurfaceError` when the EXPECTED side cannot prove its
    surface. When the candidate cannot, the first row is
    `("candidate-runtime-surface-unproven: <reason>", None, None)` and the
    expected inventory is mapped onto the candidate by its INSTALLED landing
    path (the contract every install target is held to), so a truncated or
    mis-laid install still names the files it lacks.
    """
    expected = dict(runtime_surface_items(expected_root))
    rows: list[tuple[str, Path | None, Path | None]] = []
    candidate_base = Path(candidate_root)
    try:
        candidate: dict[str, Path] = dict(runtime_surface_items(candidate_base))
    except (OSError, RuntimeError) as exc:
        rows.append((f"candidate-runtime-surface-unproven: {exc}", None, None))
        candidate = {}
        for name in expected:
            landed = candidate_base / installed_relpath(name)
            if landed.is_file():
                candidate[name] = landed

    def reached() -> bool:
        return limit is not None and len(rows) >= limit

    for name in sorted(set(expected) | set(candidate)):
        if reached():
            break
        left, right = expected.get(name), candidate.get(name)
        if left is None or right is None:
            rows.append((name, left, right))
            continue
        try:
            same = content_bytes(left) == content_bytes(right)
        except OSError:
            same = False
        if not same:
            rows.append((name, left, right))
    return rows
