#!/usr/bin/env python
"""Evidence-gated preflight for ``saipen sub clean <name>``.

This tool never deletes. It reports every condition that makes removal unsafe;
the protocol may remove an instance only after this preflight returns success.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import sys
from pathlib import Path


def _is_reparse_point(path: Path) -> bool:
    """True for a symlink or a Windows junction/reparse point.

    A junction is NOT a symlink: ``Path.is_symlink()`` is False for it, so
    junction detection must read the reparse-point attribute. On any other
    platform the attribute does not exist and the helper degrades to the
    symlink check (T-572).
    """
    if path.is_symlink():
        return True
    try:
        info = path.lstat()
    except OSError:
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    return bool(attributes & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT


def _file_digest(path: Path) -> str:
    """Digest of a regular file, without ever following a symlink.

    Evidence ownership is link-boundary-safe: a symlink's digest is its link
    identity (the target text), never the bytes its target points at, so an
    outside file can never hash like evidence the instance actually owns.
    """
    try:
        info = path.lstat()
    except OSError as exc:
        raise RuntimeError(f"cannot stat cleanup evidence {path}: {exc}") from exc
    if stat.S_ISLNK(info.st_mode):
        try:
            target = os.readlink(path)
        except OSError as exc:
            raise RuntimeError(f"cannot read cleanup evidence link {path}: {exc}") from exc
        return hashlib.sha256(b"link:" + os.fsencode(target)).hexdigest()
    if not stat.S_ISREG(info.st_mode):
        raise RuntimeError(f"unsupported cleanup evidence object at {path}")
    digest = hashlib.sha256()
    try:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags)
    except OSError as exc:
        raise RuntimeError(f"cannot open cleanup evidence {path}: {exc}") from exc
    try:
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    except OSError as exc:
        raise RuntimeError(f"cannot read cleanup evidence {path}: {exc}") from exc
    finally:
        os.close(fd)
    return digest.hexdigest()


def _open_board_items(board: Path) -> list[str]:
    if not board.is_file():
        return [f"missing lifecycle evidence: {board.name}"]
    if board.is_symlink() or _is_reparse_point(board):
        return [f"non-regular lifecycle evidence: {board.name} is a symlink or reparse point"]
    try:
        lines = board.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeError) as exc:
        raise RuntimeError(f"cannot read cleanup board {board}: {exc}") from exc
    headings = [line[3:].strip() for line in lines if line.startswith("## ")]
    required = ["DOING", "TODO", "DONE", "BLOCKED"]
    if headings != required:
        return [f"malformed BOARD sections: expected {required!r}, got {headings!r}"]
    malformed_headings = [
        line
        for line in lines
        if line.startswith("##") and line not in {f"## {name}" for name in required}
    ]
    if malformed_headings:
        return [f"malformed BOARD heading: {malformed_headings[0]}"]
    section = ""
    blockers = []
    checkbox_for = {"DOING": "/", "TODO": " ", "DONE": "x", "BLOCKED": " "}
    for line in lines:
        if line.startswith("## "):
            section = line[3:].strip()
            continue
        ticket = re.match(r"^- \[([^\]]*)\] (.+)$", line)
        if re.match(r"^\s*-\s*\[", line) and not line.startswith("- ["):
            blockers.append(f"malformed BOARD item indentation: {line}")
            continue
        if line.startswith("- [") and not ticket:
            blockers.append(f"malformed BOARD item: {line}")
            continue
        if ticket and (section not in checkbox_for or ticket.group(1) != checkbox_for[section]):
            blockers.append(f"malformed {section or 'unsectioned'} item state: {line}")
            continue
        if ticket and section == "TODO":
            blockers.append("TODO: " + line[6:].strip())
        elif ticket and section == "DOING":
            blockers.append("DOING: " + line[6:].strip())
    return blockers


def _visible_markdown(text: str) -> tuple[str, str | None]:
    without_comments = []
    cursor = 0
    while True:
        start = text.find("<!--", cursor)
        if start < 0:
            without_comments.append(text[cursor:])
            break
        without_comments.append(text[cursor:start])
        end = text.find("-->", start + 4)
        if end < 0:
            return "", "unclosed HTML comment"
        comment = text[start : end + 3]
        without_comments.append("\n" * comment.count("\n"))
        cursor = end + 3
    text = "".join(without_comments)
    visible = []
    fence_char = None
    fence_length = 0
    for line in text.splitlines(keepends=True):
        fence = re.match(r"^[ ]{0,3}(`{3,}|~{3,})(.*)$", line.rstrip("\r\n"))
        if fence_char is None and fence:
            fence_char = fence.group(1)[0]
            fence_length = len(fence.group(1))
            visible.append("\n" if line.endswith("\n") else "")
        elif fence_char is not None:
            closing = re.match(
                rf"^[ ]{{0,3}}{re.escape(fence_char)}{{{fence_length},}}[ \t]*$",
                line.rstrip("\r\n"),
            )
            if closing:
                fence_char = None
                fence_length = 0
            visible.append("\n" if line.endswith("\n") else "")
        else:
            visible.append(line)
    if fence_char is not None:
        return "", "unclosed fenced block"
    return "".join(visible), None


def _outbox_blockers(outbox: Path) -> list[str]:
    if not outbox.is_file():
        return [f"missing lifecycle evidence: kitchen/{outbox.name}"]
    if outbox.is_symlink() or _is_reparse_point(outbox):
        return [
            f"non-regular lifecycle evidence: kitchen/{outbox.name} is a symlink or reparse point"
        ]
    try:
        text = outbox.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as exc:
        raise RuntimeError(f"cannot read cleanup OUTBOX {outbox}: {exc}") from exc
    if text.strip() == "# OUTBOX":
        return []
    visible, structure_error = _visible_markdown(text)
    if structure_error:
        return [f"malformed OUTBOX: {structure_error}"]

    headings = list(re.finditer(r"^## [A-Z]+-\d+:\s*\S.*$", visible, flags=re.MULTILINE))
    entry_like = re.findall(r"^#{2,}\s*[A-Za-z][A-Za-z0-9_-]*-\S+.*$", visible, flags=re.MULTILINE)
    if len(headings) != len(entry_like):
        return ["malformed OUTBOX entry heading"]
    entries: list[str]
    if headings:
        if visible[: headings[0].start()].strip() != "# OUTBOX":
            return ["malformed OUTBOX preamble or entry heading"]
        entries = [
            visible[
                match.start() : headings[index + 1].start()
                if index + 1 < len(headings)
                else len(visible)
            ]
            for index, match in enumerate(headings)
        ]
    else:
        frontmatter = re.fullmatch(r"---\s*\n(.*?)\n---\s*", visible, flags=re.DOTALL)
        if not frontmatter:
            return ["nonempty OUTBOX has no valid package entry"]
        entries = [frontmatter.group(1)]

    blockers = []
    allowed = {"ready", "draft", "blocked", "reviewed", "stale"}
    for index, entry in enumerate(entries, 1):
        if headings:
            statuses = re.findall(
                r"^-[ \t]+\*\*status:\*\*[ \t]*([^\s]+)[ \t]*$", entry, flags=re.MULTILINE
            )
        else:
            statuses = re.findall(r"^status:[ \t]*([^\s]+)[ \t]*$", entry, flags=re.MULTILINE)
        if len(statuses) != 1:
            blockers.append(f"OUTBOX entry {index} has {len(statuses)} status fields; expected 1")
            continue
        status = statuses[0]
        if status not in allowed:
            blockers.append(f"OUTBOX entry {index} has unknown status {status!r}")
        elif status in {"ready", "draft", "blocked"}:
            blockers.append(f"OUTBOX status {status}")
    return blockers


def _walk_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    errors: list[OSError] = []
    files: list[Path] = []
    for current, directories, names in os.walk(root, onerror=errors.append):
        directories.sort()
        names.sort()
        current_path = Path(current)
        for directory in list(directories):
            path = current_path / directory
            try:
                if path.is_symlink() or _is_reparse_point(path):
                    files.append(path)
                    directories.remove(directory)
            except OSError as exc:
                errors.append(exc)
        for name in names:
            path = current_path / name
            try:
                path.lstat()
            except OSError as exc:
                errors.append(exc)
            else:
                files.append(path)
    if errors:
        raise RuntimeError(f"cannot scan cleanup evidence under {root}: {errors[0]}")
    return files


def _package_artifacts(kitchen: Path) -> list[str]:
    blockers = []
    outbox = kitchen / "OUTBOX.md"
    for path in _walk_files(kitchen):
        if path != outbox:
            blockers.append(f"unacknowledged artifact: {path.relative_to(kitchen).as_posix()}")
    return blockers


def _unpreserved_recovery(instance: Path, preserved_root: Path | None) -> list[str]:
    walked = _walk_files(instance)
    link_evidence = [
        path
        for path in walked
        if (path.is_symlink() or _is_reparse_point(path))
        and "recovery" in path.relative_to(instance).parts
    ]
    if link_evidence:
        return [
            "non-preserved recovery evidence: "
            + link_evidence[0].relative_to(instance).as_posix()
            + " (symlink or reparse point owns no content)"
        ]
    evidence = [path for path in walked if "recovery" in path.relative_to(instance).parts[:-1]]
    if not evidence:
        return []
    preserved = set()
    if preserved_root is not None and preserved_root.is_dir():
        preserved = {_file_digest(path) for path in _walk_files(preserved_root)}
    return [
        f"unpreserved recovery evidence: {path.relative_to(instance).as_posix()}"
        for path in evidence
        if _file_digest(path) not in preserved
    ]


def sub_clean_blockers(
    instance_root: Path | str, preserved_root: Path | str | None = None
) -> tuple[str, ...]:
    """Return deterministic reasons why an instance cannot be removed."""
    instance = Path(instance_root)
    if not instance.is_dir():
        return (f"instance does not exist: {instance}",)
    preserved = Path(preserved_root) if preserved_root is not None else None
    blockers = []
    blockers.extend(_open_board_items(instance / "BOARD.md"))
    blockers.extend(_outbox_blockers(instance / "kitchen" / "OUTBOX.md"))
    blockers.extend(_package_artifacts(instance / "kitchen"))
    blockers.extend(_unpreserved_recovery(instance, preserved))
    return tuple(blockers)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("instance")
    parser.add_argument("--preserved-root")
    args = parser.parse_args(argv)
    instance = Path(args.instance)
    if not instance.is_dir() and len(instance.parts) == 1:
        instance = Path(".saipen/extensions/subs") / instance
    try:
        blockers = sub_clean_blockers(instance, args.preserved_root)
    except RuntimeError as exc:
        print(f"BLOCKED: {exc}")
        return 1
    if blockers:
        for blocker in blockers:
            print(f"BLOCKED: {blocker}")
        return 1
    print("PASS: sub clean preflight found no outstanding evidence")
    return 0


if __name__ == "__main__":
    sys.exit(main())
