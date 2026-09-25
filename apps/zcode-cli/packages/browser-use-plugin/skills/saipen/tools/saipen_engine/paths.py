"""Project resolution and the canonical paths under `.saipen/`.

Precedence is explicit `--project-root`, then verified host/session project carrier
(`SAIPEN_PROJECT_ROOT` / `SAIPEN_PROJECT_LINEAGE`), then the ACTIVE Git worktree,
then the main worktree via `--git-common-dir`, then the nearest ancestor carrying
`.saipen/`. The worktree-before-common order is not a detail — asking git-common
first once made the validator read a different tree than the agent was editing
and report green for the wrong repository.

THREE distinct identities, never conflated (T-1003 carrier-loss / T-1318):

1. `protocol_installation` (`saipen_home` / loaded skill anchor / `protocol_dir`)
   The canonical SAIPEN installation owning the engine (`tools/saipen.py`),
   normative protocol documentation (`BOOT.md`, `STYLE.md`, `CORE.md`), and
   execution machinery. The installed skill path (e.g.
   `~/.config/opencode/skills/saipen` or `~/.gemini/...`) does NOT identify the
   target project's `.saipen` directory.

2. `portable_project_identity` (`project_lineage` from `.saipen/IDENTITY.md`)
   A durable PORTABLE lineage stored canonically in `.saipen/IDENTITY.md`.
   Survives directory moves, machine replacement, Git clone and `saipen export`,
   and differs between unrelated initialized projects (a random lineage id).
   Cold handoffs, receipts, and host session bindings bind to THIS identity.

3. `local_working_tree_location` (`project_root`)
   The machine-local path on disk containing the project working tree and
   `.saipen/`. A detached handoff staging directory (e.g. `%TEMP%/...`) is
   transport state, NOT the project working tree.
   Locking and single-writer guarantees use `runtime_lock_identity`
   (`os.path.realpath` + `normcase` of this root) to collapse path aliases.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import uuid
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from .runtime_surface import (  # noqa: F401  (re-exported: one owner, see below)
    runtime_generation_identity as generation_identity,
    same_runtime_generation as same_generation,
)

SAIPEN_DIR = ".saipen"
STATE_NAME = "STATE.md"
BOARD_NAME = "BOARD.md"
LOG_NAME = "LOG.md"
LOGS_DIR = "logs"
LOCKS_DIR = "locks"
RECOVERY_OPS_DIR = "recovery/ops"
IDENTITY_NAME = "IDENTITY.md"
LINEAGE_FIELD = "project_lineage"
LINEAGE_RE = re.compile(r"^lineage-[0-9a-f]{32}$")


def resolve_tool_root(loaded_skill_root: Path | str | None = None) -> Path:
    """Return the canonical SAIPEN installation that owns the engine.

    The loaded skill/install anchor wins.  Otherwise the directory containing
    this engine is used.  Deliberately no ``project_root / tools`` fallback is
    present: a project may carry `.saipen/` without vendoring SAIPEN's
    executable, and probing that nonexistent path creates noisy, misleading
    bootstrap failures (especially on Windows).
    """
    if loaded_skill_root is not None:
        candidate = Path(loaded_skill_root).expanduser().resolve()
        if (candidate / "tools" / "saipen.py").is_file():
            return candidate
        if (candidate / "saipen.py").is_file():
            return candidate.parent
        raise ValueError(f"loaded SAIPEN skill has no canonical tools/saipen.py: {candidate}")
    # tools/saipen_engine/paths.py -> installation root
    return Path(__file__).resolve().parent.parent.parent


def resolve_tool_path(name: str = "saipen.py", loaded_skill_root: Path | str | None = None) -> Path:
    """Resolve one engine tool from the loaded installation, safely."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.py", name):
        raise ValueError(f"invalid SAIPEN tool name: {name!r}")
    path = resolve_tool_root(loaded_skill_root) / "tools" / name
    if not path.is_file():
        raise FileNotFoundError(f"canonical SAIPEN tool is missing: {path}")
    return path


def resolve_protocol_dir(saipen_home: Path | str) -> Path:
    """Resolve normative docs for either source-tree or flattened skill layout."""
    home = Path(saipen_home).expanduser().resolve()
    nested = home / "saipen"
    if (nested / "BOOT.md").is_file():
        return nested
    if (home / "BOOT.md").is_file():
        return home
    raise ValueError(f"SAIPEN installation has no BOOT.md: {home}")


def read_bound_regular_bytes(path: Path, expected: os.stat_result, *, max_bytes: int) -> bytes:
    """Read the exact regular node witnessed by an earlier ``lstat``.

    The descriptor, not the pathname, owns the read. Comparing ``fstat``
    before and after the bounded read with the caller's no-follow ``lstat``
    closes the lstat/open race even on hosts without ``O_NOFOLLOW``: a path
    pivot may open another node, but that descriptor cannot impersonate the
    node the caller inspected.

    Raises ``OSError`` for an unreadable path and ``ValueError`` when the path
    pivoted, the descriptor is not stable/regular, or the authority exceeds
    its explicit size bound.
    """

    def identity(info: os.stat_result) -> tuple[int, int, int, int]:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened_before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened_before.st_mode)
            or identity(opened_before) != identity(expected)
            or opened_before.st_size > max_bytes
        ):
            raise ValueError(f"authority node changed before open: {path}")
        remaining = max_bytes + 1
        chunks: list[bytes] = []
        while remaining:
            chunk = os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        opened_after = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened_after.st_mode)
            or identity(opened_before) != identity(opened_after)
            or len(raw) != opened_before.st_size
            or len(raw) > max_bytes
        ):
            raise ValueError(f"authority node changed while reading: {path}")
        return raw
    finally:
        os.close(descriptor)


def update_digest_regular_bytes(
    path: Path,
    expected: os.stat_result,
    digest: object,
    *,
    chunk_size: int = 64 * 1024,
) -> int:
    """Stream one witnessed regular file into a hashlib-compatible digest.

    The descriptor stability checks mirror ``read_bound_regular_bytes`` but
    never materialize the whole file.  Returns the exact streamed byte count.
    """

    def identity(info: os.stat_result) -> tuple[int, int, int, int]:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened_before = os.fstat(descriptor)
        if not stat.S_ISREG(opened_before.st_mode) or identity(opened_before) != identity(expected):
            raise ValueError(f"authority node changed before open: {path}")
        total = 0
        while True:
            chunk = os.read(descriptor, chunk_size)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
        opened_after = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened_after.st_mode)
            or identity(opened_before) != identity(opened_after)
            or total != opened_before.st_size
        ):
            raise ValueError(f"authority node changed while reading: {path}")
        return total
    finally:
        os.close(descriptor)


_REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def prove_owned_regular(path: Path, *, kind: str = "path") -> os.stat_result:
    """Prove `path` is an owned regular non-link/non-reparse final node.

    Uses no-follow ``lstat`` semantics: a final symlink/junction/reparse or
    non-regular node is refused regardless of where it points. Raises
    ``FileNotFoundError`` when absent and ``ValueError`` on any unsafe/other
    topology. Returns the witnessed ``lstat`` result for a bounded read.
    """
    try:
        st = path.lstat()
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise ValueError(f"{kind} {path} is unreadable: {exc}") from None
    if os.path.islink(path) or bool(getattr(st, "st_file_attributes", 0) & _REPARSE):
        raise ValueError(f"{kind} {path} is a link/reparse node")
    if not stat.S_ISREG(st.st_mode):
        raise ValueError(f"{kind} {path} is not a regular file")
    return st


def prove_owned_dir_chain(
    dir_path: Path,
    *,
    kind: str = "dir",
    ownership_root: Path | None = None,
) -> None:
    """Prove every existing ancestor component (and the final directory) of
    ``dir_path`` is an owned non-link/non-reparse directory.

    Raises ``ValueError`` on any symlink/junction/reparse/non-directory
    ancestor. Absent leaf components are permitted (they are created later by
    the caller under proven ancestors).
    """
    absolute = Path(os.path.abspath(dir_path))
    if ownership_root is not None:
        owner = Path(os.path.abspath(ownership_root))
        if absolute != owner and not absolute.is_relative_to(owner):
            raise ValueError(f"{kind} {absolute} escapes ownership root {owner}")
    chain = list(reversed((absolute, *absolute.parents)))
    for node in chain:
        try:
            st = node.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ValueError(f"{kind} ancestor {node} unreadable: {exc}") from None
        if os.path.islink(node) or bool(getattr(st, "st_file_attributes", 0) & _REPARSE):
            raise ValueError(f"{kind} ancestor {node} is a link/reparse node")
        if not stat.S_ISDIR(st.st_mode):
            raise ValueError(f"{kind} ancestor {node} is not a directory")


def _same_stat(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino, left.st_mode) == (
        right.st_dev,
        right.st_ino,
        right.st_mode,
    )


def _open_exclusive_regular(path: Path, *, kind: str) -> tuple[int, os.stat_result]:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOINHERIT", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except FileExistsError:
        raise ValueError(f"{kind} {path} already exists") from None
    try:
        witnessed = os.fstat(descriptor)
        if not stat.S_ISREG(witnessed.st_mode):
            raise ValueError(f"{kind} {path} is not a regular file")
        current = path.lstat()
        if not _same_stat(witnessed, current):
            raise ValueError(f"{kind} {path} changed during exclusive creation")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor, witnessed


def _write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("short write to owned file descriptor")
        view = view[written:]
    os.fsync(descriptor)


def safe_create_bytes_exclusive(
    path: Path,
    data: bytes,
    *,
    kind: str = "path",
    ownership_root: Path | None = None,
) -> None:
    """Create one owned regular file exactly once and write through its fd."""
    path = Path(path)
    prove_owned_dir_chain(
        path.parent,
        kind=kind,
        ownership_root=ownership_root,
    )
    descriptor, witnessed = _open_exclusive_regular(path, kind=kind)
    try:
        _write_all(descriptor, data)
        current = path.lstat()
        if not _same_stat(witnessed, current):
            raise ValueError(f"{kind} {path} changed while being written")
    except BaseException:
        with suppress(OSError):
            current = path.lstat()
            if _same_stat(witnessed, current):
                os.unlink(path)
        raise
    finally:
        os.close(descriptor)


def safe_atomic_write_bytes(
    path: Path,
    data: bytes,
    *,
    kind: str = "path",
    ownership_root: Path | None = None,
) -> None:
    """Owned same-directory atomic replacement for a project file.

    Proves the ancestor chain is owned directories, refuses a linked/reparse or
    non-regular existing final node, writes to a uniquely-named temporary in the
    SAME directory (so ``replace`` cannot cross a mount), and atomically
    replaces the target. Raises ``ValueError`` on any unsafe topology.
    """
    path = Path(path)
    parent = path.parent
    prove_owned_dir_chain(parent, kind=kind, ownership_root=ownership_root)
    parent.mkdir(parents=True, exist_ok=True)
    prove_owned_dir_chain(parent, kind=kind, ownership_root=ownership_root)
    before = None
    with suppress(FileNotFoundError):
        before = prove_owned_regular(path, kind=kind)
    tmp_path = parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    descriptor, tmp_stat = _open_exclusive_regular(tmp_path, kind=f"{kind} temporary")
    try:
        _write_all(descriptor, data)
        os.close(descriptor)
        descriptor = -1
        prove_owned_dir_chain(parent, kind=kind, ownership_root=ownership_root)
        try:
            current = prove_owned_regular(path, kind=kind)
        except FileNotFoundError:
            current = None
        if (before is None) != (current is None) or (
            before is not None and current is not None and not _same_stat(before, current)
        ):
            raise ValueError(f"{kind} {path} changed before atomic replacement")
        tmp_current = prove_owned_regular(tmp_path, kind=f"{kind} temporary")
        if not _same_stat(tmp_stat, tmp_current):
            raise ValueError(f"{kind} temporary {tmp_path} changed before replacement")
        os.replace(tmp_path, path)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        with suppress(OSError, ValueError):
            current = prove_owned_regular(tmp_path, kind=f"{kind} temporary")
            if _same_stat(tmp_stat, current):
                os.unlink(tmp_path)
        raise


def safe_unlink_owned(
    path: Path,
    *,
    kind: str = "path",
    ownership_root: Path | None = None,
) -> bool:
    """Unlink an owned regular file, no-follow. Returns False (no-op) when the
    file does not exist; raises ValueError on a linked/reparse/non-regular
    final node or unsafe ancestor chain so an unsafe carrier is never silently
    deleted."""
    path = Path(path)
    prove_owned_dir_chain(
        path.parent,
        kind=kind,
        ownership_root=ownership_root,
    )
    try:
        prove_owned_regular(path, kind=kind)
    except FileNotFoundError:
        return False
    os.unlink(path)
    return True


def _git_from(cwd: str | Path, *args: str) -> tuple[int, str]:
    """Run git in `cwd`. Never raises: this runs from pre-commit hooks and in
    directories that are not repositories at all."""
    try:
        result = subprocess.run(
            ["git", *args], cwd=str(cwd), capture_output=True, text=True, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return result.returncode, result.stdout.strip()


def is_git_project_root(root: Path) -> bool:
    """True if this project root is its own independent Git repository.
    A child project nested inside an unrelated parent repository is NOT a Git
    project of its own."""
    root = root.resolve()
    rc, top_text = _git_from(root, "rev-parse", "--show-toplevel")
    if rc == 0 and top_text:
        try:
            return Path(top_text).resolve() == root
        except OSError:
            return False
    return False


def _valid_saipen_dir(root: Path) -> bool:
    saipen = root / SAIPEN_DIR
    if not saipen.is_dir():
        return False
    try:
        if saipen.is_symlink():
            return False
        # Reparse point check (Windows junctions)
        st = saipen.lstat()
        if getattr(st, "st_file_attributes", 0) & 0x400:
            return False
    except OSError:
        return False
    return True


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(str(left)) == os.path.normcase(str(right))


def unbound_environment(base: dict | None = None, **overrides) -> dict:
    """A child-process environment carrying NO inherited project binding.

    Every name in `PROJECT_BINDING_ENV` is removed, so the child resolves the
    project from what the caller actually gave it -- its `cwd`, or an explicit
    `--project-root`. `overrides` are applied afterwards and win, which is how
    a test that WANTS a carrier (a red control, a host-binding contract) states
    that intent in one visible place instead of inheriting it by accident; an
    override of `None` removes the name.

    This is the one owner of the question. A caller that writes
    `dict(os.environ)` and pops the names it remembers has re-opened the
    16.09.26 and 17.09.26 incidents by hand.
    """
    env = dict(os.environ if base is None else base)
    for name in PROJECT_BINDING_ENV:
        env.pop(name, None)
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = str(value)
    return env


def _nearest_checkpoint_root(start: Path) -> Path | None:
    for candidate in (start, *start.parents):
        if _valid_saipen_dir(candidate):
            return candidate
    return None


ENV_PROJECT_ROOT = "SAIPEN_PROJECT_ROOT"
ENV_PROJECT_LINEAGE = "SAIPEN_PROJECT_LINEAGE"
#: Optional explicit actor/provenance carrier. It is a process environment
#: value, not authentication. When absent, admission's canonical protocol
#: snapshot inherits STATE.agent and still enforces ownership and protocol
#: state. A host session id or other host metadata is never an actor.
ENV_AGENT = "SAIPEN_AGENT"
#: The protocol installation carrier and the seat carrier. They are named here,
#: beside the project carriers, because `PROJECT_BINDING_ENV` below is the one
#: place that answers "what does a process inherit that decides WHICH project,
#: WHICH install and WHICH seat it is" -- and an answer scattered over sixteen
#: test files is the defect this constant exists to close.
ENV_SKILL_ROOT = "SAIPEN_SKILL_ROOT"
ENV_HOST_SESSION = "SAIPEN_HOST_SESSION"

#: Every environment carrier that BINDS a process to one project, one protocol
#: installation or one seat -- including the two POSIX shell carriers, because
#: `PWD` is the one that caused the 16.09.26 incident (SRC-047/T-1368,
#: SRC-048/T-1369) and `SAIPEN_PROJECT_ROOT` is the one that caused its
#: 17.09.26 twin (SRC-059/T-1390, SRC-060/T-1391).
#:
#: A child process that must resolve its OWN project -- a test fixture, a
#: launched host, an agent in another tree -- inherits NONE of them. Use
#: `unbound_environment()` to build that child's environment; do not hand-roll
#: a `dict(os.environ)` and pop the two names you happen to remember, which is
#: exactly how both incidents were written.
PROJECT_BINDING_ENV = (
    ENV_PROJECT_ROOT,
    ENV_PROJECT_LINEAGE,
    ENV_SKILL_ROOT,
    ENV_HOST_SESSION,
    "PWD",
    "OLDPWD",
    "INIT_CWD",
)
PROVENANCE_EXPLICIT = "explicit"
PROVENANCE_HOST_SESSION = "host-session"
PROVENANCE_GIT_WORKTREE = "git-worktree"
PROVENANCE_GIT_COMMON = "git-common"
PROVENANCE_ANCESTOR = "ancestor"


class ResolvedProjectRoot(tuple):
    """Result of project root resolution, preserving the 2-tuple (root, source) contract.

    Unpacks as `(root, source)` for full backward compatibility, while exposing
    structured fields: `root`, `source`, `provenance`, `code`, `detail`, `lineage`,
    and `diagnostics()`.
    """

    def __new__(
        cls,
        root: Path | None,
        source: str,
        *,
        code: str | None = None,
        lineage: str | None = None,
        context_kind: str | None = None,
    ) -> ResolvedProjectRoot:
        inst = super().__new__(cls, (root, source))
        inst._code = code
        inst._lineage = lineage
        inst._context_kind = context_kind
        return inst

    @property
    def ok(self) -> bool:
        return self[0] is not None

    @property
    def root(self) -> Path | None:
        return self[0]

    @property
    def source(self) -> str:
        return self[1]

    @property
    def provenance(self) -> str:
        return self[1]

    @property
    def detail(self) -> str:
        return self[1]

    @property
    def reason(self) -> str:
        return self[1]

    @property
    def code(self) -> str | None:
        return getattr(self, "_code", None)

    @property
    def lineage(self) -> str | None:
        return getattr(self, "_lineage", None)

    @property
    def context_kind(self) -> str | None:
        return getattr(self, "_context_kind", None)

    def diagnostics(self) -> dict[str, str | None]:
        return {
            "project_root": str(self.root) if self.root is not None else None,
            "project_root_source": self.source,
            "project_lineage": self.lineage,
        }


def format_binding_diagnostics(
    resolved: ResolvedProjectRoot | tuple[Path | None, str],
) -> str:
    """Concise read-only diagnostic for operator/debug visibility."""
    if isinstance(resolved, ResolvedProjectRoot):
        root = resolved.root
        source = resolved.source
        lineage = resolved.lineage
    else:
        root, source = resolved
        lineage = project_lineage_identity(root) if root is not None else None
    lines = [
        f"project_root: {root if root is not None else 'none'}",
        f"project_root_source: {source}",
        f"project_lineage: {lineage or 'none'}",
    ]
    return "\n".join(lines)


def resolve_project_root(
    start: Path | None = None,
    explicit: str | Path | None = None,
    *,
    host_root: str | Path | None = None,
    host_lineage: str | None = None,
    honor_environment: bool = True,
    authority: str = "mutation",
) -> ResolvedProjectRoot:
    """Resolve the one root whose checkpoint files this run may touch.

    Returns `ResolvedProjectRoot(root, provenance)` on success and
    `ResolvedProjectRoot(None, reason, code=...)` on refusal.

    Resolution precedence (T-1318 / Milestone 3):
    1. Explicit --project-root
    2. Verified host/session project-root carrier (SAIPEN_PROJECT_ROOT / SAIPEN_PROJECT_LINEAGE)
    3. Git worktree
    4. Git common/main worktree
    5. Nearest ancestor .saipen
    6. Refusal (fails closed)

    Never scans arbitrary drives. Never infers a project by basename alone.
    On host carrier error/mismatch, fails closed immediately without falling
    back to ambient CWD or foreign repositories.

    T-1434 M6: `authority` is the caller's declared USE of the resolved root,
    a closed value:

      * ``mutation`` (default) -- the run writes canonical state. An explicit
        ``--project-root`` must agree with every ambient carrier lineage or the
        binding REFUSES (PROJECT_LINEAGE_MISMATCH): silently mutating a foreign
        project merely because the flag was supplied is exactly the incident
        this protects.
      * ``observe`` -- the run is an observational diagnostic (its effect class
        is DIAGNOSTIC). An explicit target may be bound DELIBERATELY even when
        the ambient session claims another project: observing project B from a
        session bound to A is legitimate and does not inherit A's mutation
        authority. Observation never grants write authority anywhere; every
        mutating operation still resolves with ``mutation``.

    The ambient carrier root/lineage still judge every non-explicit resolution
    exactly as before, under both authorities.
    """
    if authority not in ("mutation", "observe"):
        raise ValueError(f"authority {authority!r} outside mutation|observe")
    start = Path(start).resolve() if start is not None else Path.cwd().resolve()
    expected_lineage = host_lineage
    if expected_lineage is None and honor_environment:
        expected_lineage = os.environ.get(ENV_PROJECT_LINEAGE, "").strip() or None

    # 1. explicit --project-root
    if explicit is not None:
        root = Path(explicit).expanduser()
        if not root.is_absolute():
            root = start / root
        root = root.resolve()
        if not root.is_dir():
            return ResolvedProjectRoot(
                None,
                f"explicit --project-root is not a directory: {root}",
                code="PROJECT_BINDING_INVALID",
            )
        if not _valid_saipen_dir(root):
            return ResolvedProjectRoot(
                None,
                f"explicit --project-root has no .saipen/ directory: {root}",
                code="PROJECT_BINDING_INVALID",
            )
        lineage = project_lineage_identity(root)
        if (
            authority == "mutation"
            and expected_lineage is not None
            and lineage != expected_lineage
        ):
            return ResolvedProjectRoot(
                None,
                f"explicit project lineage {lineage!r} does not match "
                f"expected {expected_lineage!r}: {root}",
                code="PROJECT_LINEAGE_MISMATCH",
                lineage=lineage,
            )
        return ResolvedProjectRoot(root, PROVENANCE_EXPLICIT, lineage=lineage)

    # 2. verified host/session project-root carrier
    carrier_root = host_root
    #: An explicit `host_root` is the caller's own verified binding -- the fleet
    #: and the preflight pass it on purpose, from a project they already
    #: classified, and they are entitled to bind a root that is not the working
    #: directory. An AMBIENT one is a leftover: nobody in this process chose it,
    #: it simply survived a `dict(os.environ)` into a child. The two are not the
    #: same authority and only the second one is checked against `cwd` below.
    carrier_is_ambient = False
    if carrier_root is None and honor_environment:
        carrier_root = os.environ.get(ENV_PROJECT_ROOT, "").strip() or None
        carrier_is_ambient = carrier_root is not None
    if carrier_root is not None:
        candidate = Path(carrier_root).expanduser()
        if not candidate.is_absolute():
            candidate = start / candidate
        candidate = candidate.resolve()
        if not candidate.is_dir():
            return ResolvedProjectRoot(
                None,
                f"{ENV_PROJECT_ROOT} is not an existing directory: {candidate}",
                code="PROJECT_BINDING_INVALID",
            )
        if not _valid_saipen_dir(candidate):
            return ResolvedProjectRoot(
                None,
                f"{ENV_PROJECT_ROOT} has no valid owned .saipen/ directory: {candidate}",
                code="PROJECT_BINDING_INVALID",
            )
        lineage = project_lineage_identity(candidate)
        if not lineage:
            return ResolvedProjectRoot(
                None,
                f"{ENV_PROJECT_ROOT} has missing or invalid .saipen/IDENTITY.md: {candidate}",
                code="PROJECT_BINDING_INVALID",
            )
        if expected_lineage is not None and lineage != expected_lineage:
            return ResolvedProjectRoot(
                None,
                f"{ENV_PROJECT_ROOT} lineage {lineage!r} does not match "
                f"expected {expected_lineage!r}: {candidate}",
                code="PROJECT_LINEAGE_MISMATCH",
                lineage=lineage,
            )
        # An AMBIENT carrier out-ranks the working directory so a host can bind
        # a session launched from a staging directory that owns no project at
        # all -- the detached `_TEMP_/fastprompter_drag` case. It must NOT
        # out-rank a working directory that IS a different project: nobody in
        # this process chose that value, and silently preferring it is how a
        # fixture run mints its receipts, its tickets and its canonical events
        # into the repository the harness happened to be launched from.
        # Measured twice: `PWD` on 16.09.26 and `SAIPEN_PROJECT_ROOT` on
        # 17.09.26. Same lineage is the same project seen through another
        # worktree and stays legal; an explicit `host_root` is the caller's own
        # verified binding and is never second-guessed here.
        cwd_root = _nearest_checkpoint_root(start) if carrier_is_ambient else None
        if cwd_root is not None and not _same_path(cwd_root, candidate):
            cwd_lineage = project_lineage_identity(cwd_root)
            if cwd_lineage and cwd_lineage != lineage:
                return ResolvedProjectRoot(
                    None,
                    f"{ENV_PROJECT_ROOT} names {candidate} (lineage {lineage!r}) "
                    f"but the working directory belongs to {cwd_root} "
                    f"(lineage {cwd_lineage!r}); two different projects claim this "
                    f"run. Pass --project-root with the one you mean, or clear "
                    f"{ENV_PROJECT_ROOT}",
                    code="PROJECT_BINDING_AMBIGUOUS",
                    lineage=lineage,
                )
        return ResolvedProjectRoot(candidate, PROVENANCE_HOST_SESSION, lineage=lineage)

    # 3. Git worktree & 4. Git common/main worktree
    has_git = any((p / ".git").exists() for p in (start, *start.parents))
    if has_git:
        rc, top_text = _git_from(start, "rev-parse", "--show-toplevel")
    else:
        rc, top_text = 1, ""
    if rc == 0 and top_text:
        worktree_root = Path(top_text).resolve()
        common_rc, common_text = _git_from(start, "rev-parse", "--git-common-dir")
        candidates: list[tuple[Path, str]] = [(worktree_root, PROVENANCE_GIT_WORKTREE)]
        if common_rc == 0 and common_text:
            common_dir = Path(common_text)
            if not common_dir.is_absolute():
                common_dir = start / common_dir
            common_dir = common_dir.resolve()
            if common_dir.name.lower() == ".git":
                candidates.append((common_dir.parent, PROVENANCE_GIT_COMMON))
        seen: set[str] = set()
        for root, source in candidates:
            key = os.path.normcase(str(root))
            if key in seen:
                continue
            seen.add(key)
            if _valid_saipen_dir(root):
                lineage = project_lineage_identity(root)
                if expected_lineage is not None and lineage != expected_lineage:
                    return ResolvedProjectRoot(
                        None,
                        f"resolved {source} root lineage {lineage!r} does not match "
                        f"expected {expected_lineage!r}: {root}",
                        code="PROJECT_LINEAGE_MISMATCH",
                        lineage=lineage,
                    )
                return ResolvedProjectRoot(root, source, lineage=lineage)
        return ResolvedProjectRoot(
            None,
            f"cwd belongs to Git worktree {worktree_root} but its "
            f"owning repository has no .saipen/; refusing to guess "
            f"or create a second .saipen/. Run from the intended "
            f"project or pass --project-root PATH",
            code="NOT_SAIPEN_PROJECT",
            context_kind="git-non-saipen",
        )

    # 5. Nearest ancestor .saipen
    root = _nearest_checkpoint_root(start)
    if root is not None:
        lineage = project_lineage_identity(root)
        if expected_lineage is not None and lineage != expected_lineage:
            return ResolvedProjectRoot(
                None,
                f"resolved ancestor root lineage {lineage!r} does not match "
                f"expected {expected_lineage!r}: {root}",
                code="PROJECT_LINEAGE_MISMATCH",
                lineage=lineage,
            )
        return ResolvedProjectRoot(root, PROVENANCE_ANCESTOR, lineage=lineage)

    # 6. Refusal
    return ResolvedProjectRoot(
        None,
        "cwd has no owning .saipen/; refusing to guess or create "
        "one. Run from the intended project or pass "
        "--project-root PATH",
        code="NOT_SAIPEN_PROJECT",
        context_kind="detached",
    )


def project_identity(root: Path) -> str:
    """One stable RUNTIME identity per project, whatever path spelled it.

    `os.path.realpath` collapses symlinks and junctions; `normcase` collapses
    the case and separator differences Windows treats as the same file. Without
    both, `V:\\proj` and `v:/proj/` are two writers holding two locks over one
    set of files.

    This is the machine-local lock/journal-runtime identity. It must never be
    treated as durable portable evidence: moving the project changes it. Durable
    portable binding uses `project_lineage_identity` instead.
    """
    return os.path.normcase(os.path.realpath(str(root)))


def runtime_lock_identity(root: Path | str) -> str:
    """Machine-local lock identity: aliases of one project share it.

    Never persisted as durable evidence. Two path spellings of one project
    (symlink, junction, case difference) must collapse to one value so two
    spellings cannot take two writer locks.
    """
    return project_identity(Path(root))


def new_project_lineage() -> str:
    """A fresh portable project lineage id (random: unrelated projects differ
    even when they share a remote, a folder name, or both)."""
    return "lineage-" + uuid.uuid4().hex


def identity_file_content(lineage: str) -> str:
    """Canonical tracked content of `.saipen/IDENTITY.md`."""
    return f"---\n{LINEAGE_FIELD}: {lineage}\n---\n"


def parse_identity_content(text: str) -> tuple[str | None, str | None]:
    """STRICT canonical parse of `.saipen/IDENTITY.md` content (T-1003
    carrier-loss wave).

    The canonical form is exactly one frontmatter fence holding exactly one
    `project_lineage:` field naming a lineage-id:

        ---
        project_lineage: lineage-<hex32>
        ---

    Duplicate fields, a missing/broken fence, a second lineage field, or any
    other body content ("body garbage") are all INVALID -- a carrier is the
    project's only durable portable identity, so leniency here is how one
    project silently becomes another. Returns (lineage, None) on success and
    (None, error) on any malformation.
    """
    if not text or not text.strip():
        return None, "identity file is empty"
    lines = text.splitlines()
    if lines[0].strip() != "---":
        return None, "missing opening --- frontmatter fence"
    if len(lines) < 3 or lines[-1].strip() != "---":
        return None, "missing closing --- frontmatter fence"
    body = lines[1:-1]
    body_lines = [line for line in body if line.strip()]
    if len(body_lines) != 1:
        return None, (
            "canonical IDENTITY.md holds exactly one lineage field "
            "inside the fence; found "
            f"{len(body_lines)} non-empty line(s)"
        )
    line = body_lines[0]
    match = re.fullmatch(rf"{re.escape(LINEAGE_FIELD)}:\s*(\S+)\s*", line)
    if not match:
        return None, f"unexpected identity body line {line!r}"
    value = match.group(1)
    if not LINEAGE_RE.match(value):
        return None, f"lineage value {value!r} fails the lineage-id grammar"
    return value, None


def project_lineage_identity(root: Path | str) -> str | None:
    """The durable portable lineage of this project, or None.

    Reads the tracked `.saipen/IDENTITY.md` and validates the canonical
    carrier grammar (one fenced lineage field, no body garbage). None means:
    project not yet migrated, or the identity file is missing/malformed. A
    missing/malformed lineage is fail-closed material for NEW strict receipts
    -- it must never silently become "same project".
    """
    root = Path(root)
    saipen = root / SAIPEN_DIR
    path = saipen / IDENTITY_NAME
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)

    def identity(info) -> tuple[int, int, int, int]:
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)

    try:
        saipen_before = saipen.lstat()
        path_before = path.lstat()
    except (FileNotFoundError, OSError):
        return None
    if (
        os.path.islink(saipen)
        or bool(getattr(saipen_before, "st_file_attributes", 0) & reparse_flag)
        or not stat.S_ISDIR(saipen_before.st_mode)
        or os.path.islink(path)
        or bool(getattr(path_before, "st_file_attributes", 0) & reparse_flag)
        or not stat.S_ISREG(path_before.st_mode)
        or path_before.st_size > 4096
    ):
        return None
    try:
        raw = read_bound_regular_bytes(path, path_before, max_bytes=4096)
        path_after = path.lstat()
        saipen_after = saipen.lstat()
    except (OSError, ValueError):
        return None
    if (
        os.path.islink(saipen)
        or bool(getattr(saipen_after, "st_file_attributes", 0) & reparse_flag)
        or not stat.S_ISDIR(saipen_after.st_mode)
        or os.path.islink(path)
        or bool(getattr(path_after, "st_file_attributes", 0) & reparse_flag)
        or not stat.S_ISREG(path_after.st_mode)
        or identity(saipen_before) != identity(saipen_after)
        or identity(path_before) != identity(path_after)
        or raw.startswith(b"\xef\xbb\xbf")
    ):
        return None
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return None
    lineage, _error = parse_identity_content(text)
    return lineage


# T-1342: there is exactly ONE shipped-runtime generation identity definition,
# in `saipen_engine.runtime_surface`. `generation_identity`/`same_generation`
# remain importable here as aliases of that owner so existing callers and
# protocol imports keep working; they are never a second implementation.
# (The document-only fingerprint that used to live here hashed protocol
# DOCUMENTS, so a stale executable engine could pass as CURRENT -- itself the
# defect T-1342 removes.)


@dataclass(frozen=True)
class ProjectPaths:
    """Every canonical path an operation may touch, derived once."""

    root: Path

    @property
    def saipen(self) -> Path:
        return self.root / SAIPEN_DIR

    @property
    def state(self) -> Path:
        return self.saipen / STATE_NAME

    @property
    def board(self) -> Path:
        return self.saipen / BOARD_NAME

    @property
    def log(self) -> Path:
        return self.saipen / LOG_NAME

    @property
    def sealed_logs(self) -> list[Path]:
        from .log import history_paths

        return [p for p in history_paths(self.root) if p.name != "LOG.md"]

    @property
    def lock(self) -> Path:
        return self.saipen / LOCKS_DIR / "core.lock"

    @property
    def recovery_ops(self) -> Path:
        return self.saipen / RECOVERY_OPS_DIR


if __name__ == "__main__":
    import sys

    _resolved = resolve_project_root()
    print(format_binding_diagnostics(_resolved))
    sys.exit(0 if _resolved.root is not None else 1)
