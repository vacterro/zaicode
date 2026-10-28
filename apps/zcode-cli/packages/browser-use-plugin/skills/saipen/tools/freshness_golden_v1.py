#!/usr/bin/env python
"""FROZEN GOLDEN REFERENCE -- pre-wave SourceIdentity implementation (T-1010).

DO NOT MODIFY. This file is a durable, independent oracle for the perf-wave
parity contract: it is the byte-exact pre-wave freshness.py (4 delta
listings / 3 content reads per path) that shipped before the T-1019 bounded
capture. tools/perf_wave_regressions.py compares the LIVE implementation
against this frozen reference on stable fixtures and times both, so:

- the oracle never comes from `git show HEAD:...` -- once the optimization
  is committed, HEAD IS the implementation under test and a HEAD-derived
  oracle degenerates into self-comparison;
- a deliberate fingerprint semantic drift in the live implementation still
  turns parity red.

The identity it computes (git-delta-v1 / no-git-tree-v1 framing, record
bytes, digest) is the semantic contract the live implementation must keep.
"""

from __future__ import annotations

import hashlib
import os
import stat
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


class FreshnessError(RuntimeError):
    """Freshness evidence could not be computed without omitting input."""


@dataclass(frozen=True)
class SourceIdentity:
    source_head: str
    source_tree_fingerprint: str
    discovery_model: str


@dataclass(frozen=True)
class _Record:
    kind: bytes
    path: bytes
    mode: int
    content: bytes


_ROLE_FIELD = b"role_revision:"
_SOURCE_MAGIC = b"saipen-source-fingerprint-v1\0"
_ROLE_MAGIC = b"saipen-role-revision-v1\0"
_GENERIC_ROLE_MAGIC = b"saipen-generic-role-revision-v1\0"
_NO_GIT_EXCLUDED_DIRS = frozenset(
    {
        ".git",
        ".freebuff",
        ".claude",
        ".pytest_cache",
        ".ruff_cache",
        "__pycache__",
        "node_modules",
    }
)
_NO_GIT_EXCLUDED_ROOT_FILES = frozenset({"nul"})


def _run_git(root: Path, *args: str) -> bytes:
    try:
        result = subprocess.run(
            ["git", "-C", os.fspath(root), *args],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise FreshnessError(f"Git discovery failed: {exc}") from exc
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        raise FreshnessError(
            f"git {' '.join(args)} failed with exit {result.returncode}"
            + (f": {detail}" if detail else "")
        )
    return result.stdout


def _is_saipen_path(path: bytes) -> bool:
    return path == b".saipen" or path.startswith(b".saipen/")


def _is_reparse_point(path: Path) -> bool:
    """True for a symlink or a Windows junction/reparse point.

    A junction is NOT a symlink: ``stat.S_ISLNK`` is False for it, so the
    no-Git walk would otherwise recurse through it and hash content outside
    the declared root. The reparse-point attribute exists only on Windows;
    elsewhere this degrades to the symlink check (T-572).
    """
    if path.is_symlink():
        return True
    try:
        info = path.lstat()
    except OSError:
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT


def _frame(record: _Record) -> bytes:
    if len(record.kind) != 1:
        raise FreshnessError("fingerprint record type must be exactly one byte")
    return b"".join(
        (
            record.kind,
            struct.pack(">Q", len(record.path)),
            record.path,
            struct.pack(">I", record.mode),
            struct.pack(">Q", len(record.content)),
            record.content,
        )
    )


def _digest(model: str, records: Iterable[_Record]) -> str:
    model_bytes = model.encode("ascii")
    h = hashlib.sha256()
    h.update(_SOURCE_MAGIC)
    h.update(struct.pack(">Q", len(model_bytes)))
    h.update(model_bytes)
    for record in sorted(records, key=lambda item: item.path):
        h.update(_frame(record))
    return f"{model}:{h.hexdigest()}"


def _path_from_git(root: Path, raw_path: bytes) -> Path:
    if not raw_path or raw_path.startswith(b"/") or b"\0" in raw_path:
        raise FreshnessError(f"Git returned an invalid path: {raw_path!r}")
    if any(part in (b"", b".", b"..") for part in raw_path.split(b"/")):
        raise FreshnessError(f"Git returned a non-canonical path: {raw_path!r}")
    rel = os.fsdecode(raw_path)
    candidate = root.joinpath(*rel.split("/"))
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise FreshnessError(f"Git path escapes project root: {rel!r}") from exc
    return candidate


def _read_regular(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        before = path.lstat()
        fd = os.open(path, flags)
    except OSError as exc:
        raise FreshnessError(f"cannot stat/read fingerprint input {path}: {exc}") from exc
    try:
        opened = os.fstat(fd)
        if not stat.S_ISREG(opened.st_mode):
            raise FreshnessError(f"fingerprint input changed type while opening: {path}")
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
            raise FreshnessError(f"fingerprint input raced while opening: {path}")
        chunks = []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(fd)
        if (opened.st_size, opened.st_mtime_ns, opened.st_mode) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_mode,
        ):
            raise FreshnessError(f"fingerprint input changed while reading: {path}")
        return b"".join(chunks)
    except OSError as exc:
        raise FreshnessError(f"cannot read fingerprint input {path}: {exc}") from exc
    finally:
        os.close(fd)


def _read_symlink(path: Path) -> bytes:
    try:
        before = path.lstat()
        target = os.readlink(path)
        repeated = os.readlink(path)
        after = path.lstat()
    except OSError as exc:
        raise FreshnessError(f"cannot read fingerprint symlink {path}: {exc}") from exc
    if target != repeated or (before.st_dev, before.st_ino, before.st_mode, before.st_mtime_ns) != (
        after.st_dev,
        after.st_ino,
        after.st_mode,
        after.st_mtime_ns,
    ):
        raise FreshnessError(f"fingerprint symlink changed while reading: {path}")
    return os.fsencode(target)


def _record_current(root: Path, raw_path: bytes, declared_mode: int | None) -> _Record:
    path = _path_from_git(root, raw_path)
    try:
        info = path.lstat()
    except OSError as exc:
        raise FreshnessError(f"cannot stat fingerprint input {path}: {exc}") from exc

    if stat.S_ISLNK(info.st_mode):
        mode = 0o120000
        kind = b"L"
        content = _read_symlink(path)
    elif stat.S_ISREG(info.st_mode):
        mode = 0o100755 if info.st_mode & 0o111 else 0o100644
        if declared_mode in (0o100644, 0o100755):
            mode = declared_mode
        kind = b"F"
        content = _read_regular(path)
    else:
        raise FreshnessError(
            f"unsupported fingerprint input type at {path}; only regular files "
            "and symlinks are supported"
        )

    if declared_mode is not None and declared_mode not in (mode, 0):
        raise FreshnessError(f"Git mode {declared_mode:o} disagrees with filesystem type at {path}")
    return _Record(kind, raw_path, mode, content)


def _git_delta_listing(root: Path) -> tuple[bytes, bytes]:
    raw = _run_git(
        root,
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--ignore-submodules=none",
        "HEAD",
        "--",
    )
    untracked = _run_git(root, "ls-files", "-z", "--others", "--exclude-standard", "--")
    return raw, untracked


def _parse_git_delta(root: Path, raw: bytes, untracked: bytes) -> list[_Record]:
    records: dict[bytes, _Record] = {}
    fields = raw.split(b"\0")
    index = 0
    while index < len(fields) and fields[index]:
        header = fields[index]
        index += 1
        if index >= len(fields) or not fields[index]:
            raise FreshnessError("Git returned a truncated --raw delta record")
        raw_path = fields[index]
        index += 1
        if _is_saipen_path(raw_path):
            continue
        parts = header.split()
        if len(parts) != 5 or not parts[0].startswith(b":"):
            raise FreshnessError(f"Git returned an unparseable --raw record: {header!r}")
        try:
            old_mode = int(parts[0][1:], 8)
            new_mode = int(parts[1], 8)
        except ValueError as exc:
            raise FreshnessError(f"Git returned an invalid mode: {header!r}") from exc
        status_code = parts[4][:1]
        if status_code == b"U":
            raise FreshnessError(
                "unmerged fingerprint input cannot become ready: " + os.fsdecode(raw_path)
            )
        if status_code not in (b"A", b"D", b"M", b"T"):
            raise FreshnessError(
                f"unsupported Git delta status {parts[4]!r}: {os.fsdecode(raw_path)}"
            )
        if status_code == b"D" or new_mode == 0:
            records[raw_path] = _Record(b"D", raw_path, old_mode, b"")
            continue
        if new_mode == 0o160000:
            raise FreshnessError(f"changed Git submodule is unsupported: {os.fsdecode(raw_path)}")
        records[raw_path] = _record_current(root, raw_path, new_mode)

    for raw_path in untracked.split(b"\0"):
        if not raw_path or _is_saipen_path(raw_path):
            continue
        records[raw_path] = _record_current(root, raw_path, None)
    return list(records.values())


def _git_identity(root: Path) -> SourceIdentity:
    head = _run_git(root, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
    before = _git_delta_listing(root)
    first_records = _parse_git_delta(root, *before)
    middle = _git_delta_listing(root)
    second_records = _parse_git_delta(root, *middle)
    after = _git_delta_listing(root)
    third_records = _parse_git_delta(root, *after)
    final = _git_delta_listing(root)
    final_head = _run_git(root, "rev-parse", "--verify", "HEAD").decode("ascii").strip()
    if (
        head != final_head
        or not (before == middle == after == final)
        or not (first_records == second_records == third_records)
    ):
        raise FreshnessError("source tree or HEAD changed while fingerprint inputs were being read")
    model = "git-delta-v1"
    return SourceIdentity(head, _digest(model, third_records), model)


def _walk_no_git(root: Path) -> list[_Record]:
    records: list[_Record] = []

    def visit(directory: Path, rel_parts: tuple[str, ...]) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: os.fsencode(entry.name))
        except OSError as exc:
            raise FreshnessError(
                f"cannot enumerate fingerprint directory {directory}: {exc}"
            ) from exc
        for entry in entries:
            next_parts = (*rel_parts, entry.name)
            raw_path = b"/".join(os.fsencode(part) for part in next_parts)
            path = Path(entry.path)
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise FreshnessError(f"cannot stat fingerprint input {path}: {exc}") from exc
            if stat.S_ISDIR(info.st_mode) and (
                (not rel_parts and entry.name == ".saipen") or entry.name in _NO_GIT_EXCLUDED_DIRS
            ):
                continue
            if not rel_parts and entry.name in _NO_GIT_EXCLUDED_ROOT_FILES:
                continue
            if stat.S_ISLNK(info.st_mode) or _is_reparse_point(path):
                records.append(_Record(b"L", raw_path, 0o120000, _read_symlink(path)))
            elif stat.S_ISDIR(info.st_mode):
                visit(path, next_parts)
            elif stat.S_ISREG(info.st_mode):
                mode = 0o100755 if info.st_mode & 0o111 else 0o100644
                records.append(_Record(b"F", raw_path, mode, _read_regular(path)))
            else:
                raise FreshnessError(
                    f"unsupported fingerprint input type at {path}; only regular "
                    "files, directories, and symlinks are supported"
                )

    visit(root, ())
    return records


def compute_source_identity(project_root: Path | str) -> SourceIdentity:
    root = Path(project_root).resolve()
    if not root.is_dir():
        raise FreshnessError(f"project root is not a directory: {root}")
    git_marker = root / ".git"
    try:
        probe = subprocess.run(
            ["git", "-C", os.fspath(root), "rev-parse", "--is-inside-work-tree"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        if git_marker.exists():
            raise FreshnessError(f"Git repository discovery failed: {exc}") from exc
        probe = None
    if probe is not None and probe.returncode == 0 and probe.stdout.strip() == b"true":
        try:
            top = _run_git(root, "rev-parse", "--show-toplevel")
            git_root = Path(os.fsdecode(top.strip())).resolve()
        except (FreshnessError, OSError) as exc:
            raise FreshnessError(f"Git repository root discovery failed: {exc}") from exc
        # A checkpoint root nested inside somebody else's repository is not a
        # Git project of its own. Applying the parent's root-relative paths to
        # the child silently hashes the wrong source surface (and can escape
        # the child entirely), so it uses the explicit no-Git model instead.
        if git_root == root:
            return _git_identity(root)
    elif git_marker.exists():
        detail = ""
        if probe is not None:
            detail = probe.stderr.decode("utf-8", "replace").strip()
        raise FreshnessError(
            "Git metadata exists but work-tree discovery failed" + (f": {detail}" if detail else "")
        )
    model = "no-git-tree-v1"
    first_records = _walk_no_git(root)
    second_records = _walk_no_git(root)
    if first_records != second_records:
        raise FreshnessError("no-Git source tree changed while fingerprint inputs were being read")
    return SourceIdentity("no-git", _digest(model, second_records), model)


def compute_role_revision(charter_path: Path | str) -> str:
    path = Path(charter_path)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise FreshnessError(f"cannot read role charter {path}: {exc}") from exc
    raw = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    lines = raw.splitlines(keepends=True)
    in_yaml = False
    removed = 0
    body: list[bytes] = []
    for line in lines:
        stripped = line.strip()
        if stripped == b"```yaml" and not in_yaml:
            in_yaml = True
            body.append(line)
            continue
        if stripped == b"```" and in_yaml:
            in_yaml = False
            body.append(line)
            continue
        if in_yaml and line.lstrip().startswith(_ROLE_FIELD):
            removed += 1
            continue
        body.append(line)
    if removed != 1:
        raise FreshnessError(
            f"role charter {path} must contain exactly one role_revision field; found {removed}"
        )
    canonical = b"".join(body)
    h = hashlib.sha256()
    h.update(_ROLE_MAGIC)
    h.update(struct.pack(">Q", len(canonical)))
    h.update(canonical)
    return "sha256:" + h.hexdigest()


def compute_generic_role_revision(protocol_path: Path | str) -> str:
    path = Path(protocol_path)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise FreshnessError(f"cannot read generic role protocol {path}: {exc}") from exc
    canonical = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    h = hashlib.sha256()
    h.update(_GENERIC_ROLE_MAGIC)
    h.update(struct.pack(">Q", len(canonical)))
    h.update(canonical)
    return "sha256:" + h.hexdigest()
