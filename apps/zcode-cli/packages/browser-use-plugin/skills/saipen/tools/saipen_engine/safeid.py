"""One shared path-safe identifier primitive (NITRO dogfood II).

Every owned identifier that becomes a filesystem path component -- SubSaipen
name, Improve cycle_id, seat_id, report identifiers, future worker IDs -- MUST
pass through here. One concept, one implementation; no third sanitizer.

Rejects: empty, ".", "..", path traversal components, separators (/ \\),
absolute paths, drive qualification, control characters, newline, NUL, and
platform-reserved forms. After any path is built from a validated ID the
caller MUST additionally `prove_inside()` it against the expected owner root:
validation is necessary, canonicalization + containment proof is the
guarantee.
"""

from __future__ import annotations

import re
from pathlib import Path

# Allowed: one or more word chars plus internal dots/hyphens/underscores.
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")

# Control characters (C0 + DEL + C1), NUL, newline, tab.
_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

# Drive qualification: C: or C:/ on any platform.
_DRIVE_RE = re.compile(r"^[A-Za-z]:[/\\]?")

# The deterministic portable component budget (T-1013): every owned
# identifier that becomes a path component must fit on ANY host. POSIX
# NAME_MAX is 255 bytes and NTFS allows 255 UTF-16 units, but a component
# that large leaves no room for the wrappers callers add (prefixes,
# suffixes, owner-root prefixes) without blowing the full-path budget on a
# classic 260-char Windows MAX_PATH. 128 bytes is the SHARED contract
# limit; a caller that wraps an ID into a longer composed filename enforces
# its own smaller derived budget on top of this one.
MAX_ID_BYTES = 128


# Reserved device names on Windows (case-insensitive, optional extension).
_WIN_DEVICES = {
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
}


class InvalidIdError(ValueError):
    """An identifier cannot be used as a path component."""


def validate_safe_id(value: str, *, kind: str = "id") -> str:
    """Validate one owned identifier as a path-safe component.

    Returns the (trimmed) value on success; raises InvalidIdError otherwise.
    """
    if not isinstance(value, str):
        raise InvalidIdError(f"{kind} must be a string, got {type(value).__name__}")
    value = value.strip()
    if not value:
        raise InvalidIdError(f"{kind} is empty")
    if value in (".", ".."):
        raise InvalidIdError(f"{kind} {value!r} is a dot path")
    if _CONTROL_RE.search(value):
        raise InvalidIdError(f"{kind} contains a control character or newline")
    if "/" in value or "\\" in value:
        raise InvalidIdError(f"{kind} contains a path separator")
    if _DRIVE_RE.match(value):
        raise InvalidIdError(f"{kind} is drive-qualified")
    if Path(value).is_absolute():
        raise InvalidIdError(f"{kind} is an absolute path")
    if not _SAFE_ID_RE.match(value):
        raise InvalidIdError(f"{kind} is not path-safe ([A-Za-z0-9][A-Za-z0-9_.-]*)")
    _byte_len = len(value.encode("utf-8"))
    if _byte_len > MAX_ID_BYTES:
        raise InvalidIdError(
            f"{kind} is {_byte_len} bytes; the portable path-component budget is {MAX_ID_BYTES}"
        )
    # Reject traversal via dotted components inside the id: "a..b" is a plain
    # single component (safe as one path segment), but "a/.." is impossible
    # (separators rejected). A leading-dot form other than "."/".." like
    # ".hidden" is allowed -- it is a single normal component.
    if value.startswith("..") and not value.startswith("..."):
        # "..x" is a legal single component; only "." and ".." are dot paths.
        pass
    if _WIN_DEVICES.intersection({part.lower() for part in re.split(r"[.]", value)}):
        raise InvalidIdError(f"{kind} is a Windows-reserved device name")
    return value


def prove_inside(
    path: Path, owner_root: Path, *, kind: str = "path", owner_canonical: Path | None = None
) -> Path:
    """Canonicalize `path` and prove it stays under `owner_root`.

    Uses os.path.realpath to collapse symlinks/junctions and case-normalizes
    on Windows so an alternate spelling cannot escape. Raises InvalidIdError on
    escape; returns the resolved path on success.

    PERF-004: `owner_canonical` may carry an already-canonicalized owner root
    so callers that resolve the same owner across many candidate paths (a
    receipt decoder) do not re-run realpath on the identical owner every time.
    The candidate path is ALWAYS live-canonicalized; only the owner half of
    the comparison may be reused. Do not use this across commands or unrelated
    roots.
    """
    owner = _realpath(owner_root) if owner_canonical is None else owner_canonical
    resolved = _realpath(path)
    if resolved != owner and not resolved.is_relative_to(owner):
        raise InvalidIdError(f"{kind} {path} escapes the owner root {owner}")
    return resolved


def _realpath(path: Path) -> Path:
    import os

    text = os.path.realpath(str(path))
    return Path(text)
