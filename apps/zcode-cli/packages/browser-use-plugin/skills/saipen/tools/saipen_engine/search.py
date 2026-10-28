"""Bounded, deterministic, shell-free search fallback (T-1320).

Why this exists
---------------

Operator evidence, several real projects at once: the host's native `Grep`
tool failed with ``ripgrep execution failed``, the worker then reached for the
deterministic shell fallback, and the guard correctly refused it
(``PROTOCOL_STATE_INVALID``) -- so search was dead exactly when a bound project
needed it. Reads still worked; only search died.

The failure is not SAIPEN's (OpenCode's ripgrep-backed search service owns it,
and it hides the real defect behind one catch-all string), and SAIPEN must not
pretend it can repair another program's internals. What SAIPEN MUST do is stop
making mandatory work depend on either of two single points of failure:

* an external ``rg`` executable, and
* generic shell admission.

This module is the second path. It is pure Python -- ``pathlib``/``re``/``os``
only, **no subprocess of any kind** -- strictly read-only, and bounded by
construction so it can never shovel a repository into model context.

Reachability: this is invoked through the canonical ``saipen`` launcher, which
the guard already admits as the canonical surface *even while protocol state is
invalid*. It therefore never needs generic shell admission, which is precisely
the property the PROBLIP deadlock lacked.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from fnmatch import fnmatch
from pathlib import Path

#: Engine identity reported in every result. `NATIVE` is reported by the host
#: tool path; this module only ever serves `FALLBACK`.
ENGINE_FALLBACK = "FALLBACK"

DEFAULT_MAX_FILES = 4000
DEFAULT_MAX_MATCHES = 200
DEFAULT_MAX_RESULT_BYTES = 65536
DEFAULT_MAX_FILE_BYTES = 1_000_000
DEFAULT_MAX_PER_FILE = 20
DEFAULT_EXCERPT_CHARS = 240

#: Directories never descended into. This is a *bound*, not an ignore system:
#: it keeps the walk cheap and deterministic on real repositories.
SKIP_DIRS = frozenset(
    {
        ".git",
        "__pycache__",
        "node_modules",
        ".venv",
        "venv",
        ".mypy_cache",
        ".ruff_cache",
        ".pytest_cache",
        ".idea",
        ".vscode",
    }
)

STATUS_OK = "OK"
STATUS_TRUNCATED = "TRUNCATED"
STATUS_INVALID_PATTERN = "INVALID_PATTERN"
STATUS_PATH_OUTSIDE_ROOT = "PATH_OUTSIDE_ROOT"
STATUS_PATH_NOT_FOUND = "PATH_NOT_FOUND"
STATUS_NOT_A_DIRECTORY = "NOT_A_DIRECTORY"
STATUS_UNAVAILABLE = "UNAVAILABLE"

#: Session-scoped degradation cache (T-1320 Phase Q). Deliberately kept OUT of
#: the project: vendor/runtime detail must never enter canonical STATE.
DEGRADED = "DEGRADED"
AVAILABLE = "AVAILABLE"
UNKNOWN = "UNKNOWN"


class SearchError(Exception):
    """A refused search. `code` is a stable, machine-readable diagnostic."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def compile_pattern(pattern: str, *, literal: bool = False) -> re.Pattern[str]:
    """Compile the caller's query, or refuse it as the caller's error.

    The empty query and an invalid regex are CALLER errors: they are reported
    as such and never silently reinterpreted.
    """
    if not isinstance(pattern, str) or pattern == "":
        raise SearchError(STATUS_INVALID_PATTERN, "empty search pattern")
    if literal:
        return re.compile(re.escape(pattern))
    try:
        return re.compile(pattern)
    except re.error as exc:
        raise SearchError(STATUS_INVALID_PATTERN, f"invalid regex: {exc}") from exc


def resolve_scope(root: Path | str, scope: str | None) -> tuple[Path, str]:
    """Resolve the search scope INSIDE the bound root, or refuse.

    Search authority derives from the bound project root, never from ambient
    cwd. A scope that escapes the root is refused outright -- there is no
    implicit read authority for a path outside the bound project.
    """
    root_path = Path(root).resolve()
    if not scope:
        return root_path, "."
    candidate = Path(scope)
    target = (candidate if candidate.is_absolute() else root_path / candidate).resolve()
    if target != root_path and root_path not in target.parents:
        raise SearchError(
            STATUS_PATH_OUTSIDE_ROOT,
            f"scope {scope!r} resolves outside the bound project root",
        )
    return target, str(target.relative_to(root_path)).replace(os.sep, "/") or "."


def _is_binary(blob: bytes) -> bool:
    return b"\x00" in blob[:4096]


def _excerpt(line: str, match: re.Match[str], width: int) -> str:
    start = max(0, match.start() - width // 3)
    end = min(len(line), match.end() + width // 3)
    text = line[start:end].rstrip("\r\n")
    if start > 0:
        text = "…" + text
    if end < len(line.rstrip("\r\n")):
        text = text + "…"
    return text


def search(
    root: Path | str,
    pattern: str,
    *,
    scope: str | None = None,
    literal: bool = False,
    include: str | None = None,
    max_files: int = DEFAULT_MAX_FILES,
    max_matches: int = DEFAULT_MAX_MATCHES,
    max_result_bytes: int = DEFAULT_MAX_RESULT_BYTES,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_per_file: int = DEFAULT_MAX_PER_FILE,
    excerpt_chars: int = DEFAULT_EXCERPT_CHARS,
) -> dict:
    """Search `scope` inside the bound `root`. Read-only, bounded, no shell.

    Never raises for an ordinary input problem: a refusal comes back as a
    structured result with a precise diagnostic code, so a caller can tell an
    empty answer from a broken transport.
    """
    limits = {
        "max_files": max_files,
        "max_matches": max_matches,
        "max_result_bytes": max_result_bytes,
        "max_file_bytes": max_file_bytes,
        "max_per_file": max_per_file,
    }
    base: dict = {
        "ok": True,
        "engine": ENGINE_FALLBACK,
        "query": pattern,
        "mode": "literal" if literal else "regex",
        "root": str(Path(root).resolve()),
        "scope": scope or ".",
        "files_considered": 0,
        "files_scanned": 0,
        "matches_returned": 0,
        "truncated": False,
        "truncation_reasons": [],
        "skipped": {"binary": 0, "oversize": 0, "unreadable": 0, "excluded": 0},
        "matches": [],
        "limits": limits,
    }

    try:
        regex = compile_pattern(pattern, literal=literal)
    except SearchError as exc:
        base.update({"ok": False, "status": STATUS_INVALID_PATTERN, "diagnostic": exc.code,
                     "detail": exc.detail})
        return base
    # A bound root that is gone is a TRANSPORT problem, not a query problem:
    # `UNAVAILABLE` is the honest terminal state (T-1320 T9), and it is distinct
    # from an empty result and from a path inside the root that does not exist.
    if not Path(root).is_dir():
        base.update({"ok": False, "status": STATUS_UNAVAILABLE, "diagnostic": STATUS_UNAVAILABLE,
                     "detail": f"bound search root is not a readable directory: {root}"})
        return base
    try:
        target, scope_rel = resolve_scope(root, scope)
    except SearchError as exc:
        base.update({"ok": False, "status": exc.code, "diagnostic": exc.code,
                     "detail": exc.detail})
        return base

    base["scope"] = scope_rel
    if not target.exists():
        base.update(
            {
                "ok": False,
                "status": STATUS_PATH_NOT_FOUND,
                "diagnostic": STATUS_PATH_NOT_FOUND,
                "detail": f"no such path inside the bound root: {scope_rel}",
            }
        )
        return base
    if not target.is_dir():
        base.update({"ok": False, "status": STATUS_NOT_A_DIRECTORY,
                     "diagnostic": STATUS_NOT_A_DIRECTORY,
                     "detail": f"search scope is not a directory: {scope_rel}"})
        return base

    result_bytes = 0
    reasons: list[str] = []
    considered = 0

    def consider(has_reason: bool) -> None:
        if not has_reason:
            return
        if "max_matches" not in reasons:
            reasons.append("max_matches")
        if "max_result_bytes" not in reasons:
            reasons.append("max_result_bytes")

    walk: list[tuple[str, list[str], list[str]]] = []
    for dirpath, dirnames, filenames in os.walk(target, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        walk.append((dirpath, dirnames, sorted(filenames)))

    stop = False
    for dirpath, _dirnames, filenames in walk:
        if stop:
            break
        for name in filenames:
            if considered >= max_files:
                reasons.append("max_files")
                stop = True
                break
            if include and not fnmatch(name, include):
                base["skipped"]["excluded"] += 1
                continue
            full = Path(dirpath) / name
            considered += 1
            try:
                stat = full.stat()
            except OSError:
                base["skipped"]["unreadable"] += 1
                continue
            if stat.st_size > max_file_bytes:
                base["skipped"]["oversize"] += 1
                continue
            try:
                blob = full.read_bytes()
            except OSError:
                base["skipped"]["unreadable"] += 1
                continue
            if _is_binary(blob):
                base["skipped"]["binary"] += 1
                continue
            text = blob.decode("utf-8", errors="replace")
            base["files_scanned"] += 1
            per_file = 0
            rel = str(full.relative_to(Path(root).resolve())).replace(os.sep, "/")
            for lineno, line in enumerate(text.splitlines(), start=1):
                match = regex.search(line)
                if match is None:
                    continue
                if per_file >= max_per_file:
                    reasons.append("max_per_file")
                    break
                entry = {
                    "path": rel,
                    "line": lineno,
                    "excerpt": _excerpt(line, match, excerpt_chars),
                }
                encoded = len(entry["excerpt"].encode("utf-8", errors="replace"))
                if result_bytes + encoded > max_result_bytes:
                    reasons.append("max_result_bytes")
                    stop = True
                    break
                if len(base["matches"]) >= max_matches:
                    reasons.append("max_matches")
                    stop = True
                    break
                base["matches"].append(entry)
                result_bytes += encoded
                per_file += 1
            if stop:
                break

    base["files_considered"] = considered
    base["matches_returned"] = len(base["matches"])
    # Deterministic order: path, then line.
    base["matches"].sort(key=lambda m: (m["path"], m["line"]))
    reasons = sorted(set(reasons))
    base["truncation_reasons"] = reasons
    if reasons:
        base["truncated"] = True
        base["status"] = STATUS_TRUNCATED
        base["diagnostic"] = "SEARCH_TRUNCATED"
    else:
        base["status"] = STATUS_OK
        base["diagnostic"] = "SEARCH_OK"
    return base


# --------------------------------------------------------------------------
# Session degradation cache (Phase Q)
# --------------------------------------------------------------------------


def _degradation_marker(root: Path | str) -> Path:
    digest = hashlib.sha256(str(Path(root).resolve()).encode("utf-8")).hexdigest()[:16]
    return Path(tempfile.gettempdir()) / f"saipen-search-degraded-{digest}.state"


def native_search_state(root: Path | str) -> str:
    """AVAILABLE / DEGRADED / UNKNOWN for the native host search transport.

    Session-scoped and advisory. It exists so a session that has already proved
    the native transport broken stops retrying it before every search -- one
    missing `rg.exe` must not become fifty identical failing tool calls.
    """
    try:
        raw = _degradation_marker(root).read_text(encoding="utf-8").strip()
    except OSError:
        return UNKNOWN
    return DEGRADED if raw == DEGRADED else UNKNOWN


def record_native_search(root: Path | str, state: str) -> str:
    """Record the native transport's health for this session. Returns the state."""
    marker = _degradation_marker(root)
    try:
        if state == DEGRADED:
            marker.write_text(DEGRADED, encoding="utf-8")
        else:
            marker.unlink(missing_ok=True)
    except OSError:
        return UNKNOWN
    return native_search_state(root)
