"""Cross-platform single-writer lock (NITRO M2).

Real OS file locking: msvcrt on Windows, fcntl on POSIX. The lock file carries
no canonical truth; process death releases the OS lock. Project path aliases
resolve to the same lock identity (canonical_identity), so two aliases to one
project cannot create two writers.
"""

from __future__ import annotations

import contextlib
import os
import stat
import threading
from pathlib import Path

_MSVCRT = None
_FCNTL = None
if os.name == "nt":
    import msvcrt as _MSVCRT  # type: ignore
else:
    import fcntl as _FCNTL  # type: ignore

from .snapshot import canonical_identity  # noqa: E402
from .paths import prove_owned_dir_chain, prove_owned_regular  # noqa: E402

LOCK_DIR = ".saipen/locks"

# In-process ownership registry for producer-local locks. OS file locks are
# reentrant across distinct handles within one process on some platforms
# (notably Windows msvcrt.locking), so we ALSO track the live holder here to
# make same-process conflict detection deterministic (CORE-005 / V7). The key
# is the resolved lock-file path; the value is the holding ProducerLock instance.
# In-process ownership registries for same-process single-writer defense.
# OS file locks are reentrant across distinct handles within one process
# on some platforms (notably Windows msvcrt.locking), so we ALSO track live
# holders here to make same-process conflict detection deterministic.
# W2-002: the registry is a RESERVATION layer -- the key is reserved BEFORE
# the OS lock attempt and cleared on failure, closing the check-then-publish
# TOCTOU race.
_WRITER_HOLDERS: dict[str, "WriterLock"] = {}
_PRODUCER_HOLDERS: dict[str, "ProducerLock"] = {}
_FILE_HOLDERS: dict[str, "FileWriterLock"] = {}
_HOLDERS_GUARD = threading.Lock()


def _same_node(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino, left.st_mode) == (
        right.st_dev,
        right.st_ino,
        right.st_mode,
    )


def _owned_lock_path(lock_path: Path | str, ownership_root: Path | str) -> tuple[Path, Path]:
    """Map one lexical owner-relative path onto the canonical owner.

    A whole-owner alias is legitimate; symlink/reparse descendants are not.
    Mapping before descendant resolution preserves that distinction.
    """
    root_input = Path(os.path.abspath(ownership_root))
    path_input = Path(os.path.abspath(lock_path))
    try:
        relative = path_input.relative_to(root_input)
    except ValueError as exc:
        raise PermissionError(f"lock path escapes or has invalid owner: {exc}") from exc
    try:
        root = Path(ownership_root).resolve(strict=True)
    except (OSError, ValueError):
        # ownership root not yet on disk (e.g. global USERPERSON config dir
        # created on first write); use abspath projection, skip chain
        # validation until after mkdir proves the chain exists.
        root = root_input
    path = root / relative
    try:
        prove_owned_dir_chain(path.parent, kind="lock", ownership_root=root)
        path.parent.mkdir(parents=True, exist_ok=True)
        prove_owned_dir_chain(path.parent, kind="lock", ownership_root=root)
    except (OSError, ValueError) as exc:
        raise PermissionError(f"unsafe lock directory: {exc}") from exc
    return path, root


def _open_owned_lock(path: Path, root: Path):
    """Open/create the final mutex without following or trusting its name."""
    before = None
    try:
        before = prove_owned_regular(path, kind="lock file")
    except FileNotFoundError:
        pass
    except ValueError as exc:
        raise PermissionError(f"unsafe lock file: {exc}") from exc

    flags = os.O_RDWR | os.O_CREAT
    flags |= getattr(os, "O_BINARY", 0)
    flags |= getattr(os, "O_NOINHERIT", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = -1
    try:
        descriptor = os.open(path, flags, 0o600)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise PermissionError(f"unsafe lock file: {path} is not regular")
        prove_owned_dir_chain(path.parent, kind="lock", ownership_root=root)
        current = prove_owned_regular(path, kind="lock file")
        if not _same_node(opened, current):
            raise PermissionError(f"unsafe lock file: {path} changed during open")
        if before is not None and not _same_node(before, opened):
            raise PermissionError(f"unsafe lock file: {path} was replaced during open")
        handle = os.fdopen(descriptor, "r+b", buffering=0)
        descriptor = -1
        inode_key = f"inode:{opened.st_dev}:{opened.st_ino}"
        return handle, inode_key
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        raise


def _reserve(
    registry: dict,
    key: str,
    owner: object,
    message: str,
    error_type: type[PermissionError] = PermissionError,
) -> None:
    with _HOLDERS_GUARD:
        holder = registry.get(key)
        if holder is not None and holder is not owner:
            raise error_type(message)
        registry[key] = owner


def _drop_reservation(registry: dict, key: str | None, owner: object) -> None:
    if key is None:
        return
    with _HOLDERS_GUARD:
        if registry.get(key) is owner:
            del registry[key]


def _promote_reservation(
    registry: dict,
    reservation_key: str,
    inode_key: str,
    owner: object,
    message: str,
    error_type: type[PermissionError] = PermissionError,
) -> None:
    with _HOLDERS_GUARD:
        if registry.get(reservation_key) is owner:
            del registry[reservation_key]
        holder = registry.get(inode_key)
        if holder is not None and holder is not owner:
            raise error_type(message)
        registry[inode_key] = owner


def _os_lock(handle, *, blocking: bool = False) -> None:
    handle.seek(0)
    if _MSVCRT is not None:
        mode = _MSVCRT.LK_LOCK if blocking else _MSVCRT.LK_NBLCK
        _MSVCRT.locking(handle.fileno(), mode, 1)
    else:
        mode = _FCNTL.LOCK_EX
        if not blocking:
            mode |= _FCNTL.LOCK_NB
        _FCNTL.flock(handle.fileno(), mode)


def _os_unlock(handle) -> None:
    handle.seek(0)
    if _MSVCRT is not None:
        _MSVCRT.locking(handle.fileno(), _MSVCRT.LK_UNLCK, 1)
    else:
        _FCNTL.flock(handle.fileno(), _FCNTL.LOCK_UN)


class FileLockBusy(PermissionError):
    """The non-project lock exists but another writer currently owns it."""


class FileWriterLock:
    """Exclusive lock for one non-project-owned file namespace.

    This is deliberately separate from :class:`WriterLock`: callers provide
    an exact lock path and an ownership root, so user configuration can use
    the same OS-lock discipline without fabricating a project or touching its
    ``.saipen`` journal/lock tree. Construction is mutating because it creates
    the lock directory; read-only callers must never instantiate it.
    """

    def __init__(
        self,
        lock_path: Path | str,
        ownership_root: Path | str,
        *,
        blocking: bool = False,
    ) -> None:
        self.path, self._root = _owned_lock_path(lock_path, ownership_root)
        self._handle = None
        self._acquired = False
        self._holder_key: str | None = None
        self._blocking = blocking

    def acquire(self) -> bool:
        if self._acquired:
            return True
        reservation = "path:" + os.path.normcase(str(self.path))
        _reserve(
            _FILE_HOLDERS,
            reservation,
            self,
            "WRITER_BUSY",
            error_type=FileLockBusy,
        )
        try:
            self._handle, inode_key = _open_owned_lock(self.path, self._root)
            _promote_reservation(
                _FILE_HOLDERS,
                reservation,
                inode_key,
                self,
                "WRITER_BUSY",
                error_type=FileLockBusy,
            )
            self._holder_key = inode_key
            try:
                _os_lock(self._handle, blocking=self._blocking)
            except OSError as exc:
                # On Windows msvcrt uses PermissionError for a held byte
                # range.  Once the file itself was proven owned, every such
                # error is lock contention, not an arbitrary filesystem
                # failure; normalize it for non-blocking callers.
                raise FileLockBusy("WRITER_BUSY") from exc
        except BaseException as exc:
            if self._handle is not None:
                self._handle.close()
            self._handle = None
            _drop_reservation(_FILE_HOLDERS, reservation, self)
            _drop_reservation(_FILE_HOLDERS, self._holder_key, self)
            self._holder_key = None
            if isinstance(exc, OSError) and not isinstance(exc, PermissionError):
                raise FileLockBusy("WRITER_BUSY") from exc
            raise
        self._acquired = True
        return True

    def release(self) -> None:
        if not self._acquired or self._handle is None:
            return
        try:
            _os_unlock(self._handle)
        finally:
            self._handle.close()
            self._handle = None
            self._acquired = False
            _drop_reservation(_FILE_HOLDERS, self._holder_key, self)
            self._holder_key = None

    def __enter__(self) -> "FileWriterLock":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()


@contextlib.contextmanager
def file_writer_lock(
    lock_path: Path | str,
    ownership_root: Path | str,
    *,
    blocking: bool = False,
):
    """Acquire a non-project writer lock with containment enforcement."""
    lock = FileWriterLock(lock_path, ownership_root, blocking=blocking)
    lock.acquire()
    try:
        yield lock
    finally:
        lock.release()


class WriterLock:
    """An exclusive OS lock on the project's canonical lock file."""

    def __init__(self, project_root: Path | str) -> None:
        root = Path(project_root)
        lock_dir = root / LOCK_DIR
        self.path, self._root = _owned_lock_path(lock_dir / "core.lock", root)
        self._handle = None
        self._acquired = False
        self._holder_key: str | None = None

    def acquire(self) -> bool:
        """Blocking exclusive lock. Returns True (or raises WRITER_BUSY).

        W2-002: uses an atomic process-local reservation BEFORE the OS lock
        so two same-process threads cannot both enter the critical section
        on Windows-like reentrant OS locking.
        """
        if self._acquired:
            return True
        reservation = "path:" + os.path.normcase(str(self.path))
        _reserve(_WRITER_HOLDERS, reservation, self, "WRITER_BUSY")
        try:
            self._handle, inode_key = _open_owned_lock(self.path, self._root)
            _promote_reservation(_WRITER_HOLDERS, reservation, inode_key, self, "WRITER_BUSY")
            self._holder_key = inode_key
            try:
                _os_lock(self._handle)
            except OSError as exc:
                # Once the owned lock file opened successfully, an OS-lock
                # collision is contention. Windows msvcrt reports it as the
                # same raw PermissionError used for unsafe filesystem paths;
                # normalize only this post-open boundary to WRITER_BUSY.
                raise PermissionError("WRITER_BUSY") from exc
        except BaseException as exc:
            if self._handle is not None:
                self._handle.close()
            self._handle = None
            _drop_reservation(_WRITER_HOLDERS, reservation, self)
            _drop_reservation(_WRITER_HOLDERS, self._holder_key, self)
            self._holder_key = None
            if isinstance(exc, OSError) and not isinstance(exc, PermissionError):
                raise PermissionError("WRITER_BUSY") from exc
            raise
        self._acquired = True
        return True

    def release(self) -> None:
        if not self._acquired or self._handle is None:
            return
        try:
            _os_unlock(self._handle)
        finally:
            self._handle.close()
            self._handle = None
            self._acquired = False
            _drop_reservation(_WRITER_HOLDERS, self._holder_key, self)
            self._holder_key = None

    def __enter__(self) -> "WriterLock":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()


@contextlib.contextmanager
def project_writer_lock(project_root: Path | str):
    """Acquire the canonical project writer lock or raise PermissionError
    (WRITER_BUSY) if another live writer holds it."""
    lock = WriterLock(project_root)
    lock.acquire()
    try:
        yield lock
    finally:
        lock.release()


def lock_identity(project_root: Path | str) -> str:
    """The canonical lock identity: aliases of one project share it."""
    return canonical_identity(project_root)


# ---------------------------------------------------------------------------
# V7 Producer Parallelism Hardening -- producer-LOCAL lock.
#
# This serializes TWO WRITERS racing the SAME producer namespace
# (saitranslate + saitranslate, or saiwiki + saiwiki). It deliberately grants
# NO authority over the canonical main tree: it only locks a
# `.saipen/locks/producer-<name>.lock` file. Cross-producer concurrency
# (saitranslate + saiwiki) is allowed because the lock files differ. Core
# canonical writes remain gated exclusively by `WriterLock` / `project_writer_lock`.
# ---------------------------------------------------------------------------


class ProducerLock:
    """Exclusive OS lock scoped to ONE producer namespace."""

    def __init__(self, project_root: Path | str, producer: str) -> None:
        if producer not in ("saitranslate", "saiwiki"):
            raise ValueError(f"unknown producer role: {producer!r}")
        root = Path(project_root)
        lock_dir = root / LOCK_DIR
        self.producer = producer
        self.path, self._root = _owned_lock_path(lock_dir / f"producer-{producer}.lock", root)
        self._handle = None
        self._acquired = False
        self._holder_key: str | None = None

    def acquire(self) -> bool:
        """Blocking-exclusive, non-blocking acquire. Raises WRITER_BUSY on conflict.

        W2-002: uses an atomic process-local reservation BEFORE the OS lock
        so two same-process threads cannot both enter the critical section
        on Windows-like reentrant OS locking.
        """
        if self._acquired:
            return True
        message = f"PRODUCER_BUSY: {self.producer} is already writing"
        reservation = "path:" + os.path.normcase(str(self.path))
        _reserve(_PRODUCER_HOLDERS, reservation, self, message)
        try:
            self._handle, inode_key = _open_owned_lock(self.path, self._root)
            _promote_reservation(_PRODUCER_HOLDERS, reservation, inode_key, self, message)
            self._holder_key = inode_key
            try:
                _os_lock(self._handle)
            except OSError as exc:
                # msvcrt reports another process holding the byte range as
                # raw PermissionError.  The open/provenance checks already
                # passed, so expose the producer-specific stable code.
                raise PermissionError(message) from exc
        except BaseException as exc:
            if self._handle is not None:
                self._handle.close()
            self._handle = None
            _drop_reservation(_PRODUCER_HOLDERS, reservation, self)
            _drop_reservation(_PRODUCER_HOLDERS, self._holder_key, self)
            self._holder_key = None
            if isinstance(exc, OSError) and not isinstance(exc, PermissionError):
                raise PermissionError(message) from exc
            raise
        self._acquired = True
        return True

    def release(self) -> None:
        if not self._acquired or self._handle is None:
            return
        try:
            _os_unlock(self._handle)
        finally:
            self._handle.close()
            self._handle = None
            self._acquired = False
            _drop_reservation(_PRODUCER_HOLDERS, self._holder_key, self)
            self._holder_key = None

    def __enter__(self) -> "ProducerLock":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()


@contextlib.contextmanager
def producer_writer_lock(project_root: Path | str, producer: str):
    """Acquire the producer-local writer lock for one role.

    Distinct producers (saitranslate vs saiwiki) may hold their locks at the
    same time. Two writers of the SAME producer serialize or the second raises
    PermissionError(PRODUCER_BUSY). This lock never gates canonical main-tree
    writes -- that is `project_writer_lock`'s job.
    """
    lock = ProducerLock(project_root, producer)
    lock.acquire()
    try:
        yield lock
    finally:
        lock.release()
