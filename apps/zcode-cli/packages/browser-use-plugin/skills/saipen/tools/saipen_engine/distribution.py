"""Source-receipt distribution boundary.

Canonical receipt bodies remain exact local authority.  A quarantined body
lives below ``.saipen/quarantine/``; that entire prefix is deliberately
outside every supported distribution surface.  The exported quarantine
record stays under intake and identifies the receipt and digest without
carrying the body.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath


DISTRIBUTABLE = "DISTRIBUTABLE"
QUARANTINED = "QUARANTINED"

QUARANTINE_PREFIX = ".saipen/quarantine/"
QUARANTINE_SOURCE_DIR = Path(".saipen/quarantine/source")
DISTRIBUTION_RECORD_DIR = Path(".saipen/intake/distribution")


def quarantine_body_rel(receipt_id: str) -> str:
    """Return the protected canonical body location for one receipt."""
    return (QUARANTINE_SOURCE_DIR / f"{receipt_id}.md").as_posix()


def distribution_record_rel(receipt_id: str) -> str:
    """Return the export-safe distribution record location."""
    return (DISTRIBUTION_RECORD_DIR / f"{receipt_id}.json").as_posix()


def is_non_exportable_path(path: str | Path) -> bool:
    """True only for the protected local-authority namespace.

    Paths are repository-relative.  Backslashes are normalized because Git,
    ZIP, PowerShell, and pathlib callers do not all use the same separator.
    """
    value = PurePosixPath(str(path).replace("\\", "/")).as_posix()
    while value.startswith("./"):
        value = value[2:]
    value = value.lstrip("/")
    return value == QUARANTINE_PREFIX.rstrip("/") or value.startswith(QUARANTINE_PREFIX)
