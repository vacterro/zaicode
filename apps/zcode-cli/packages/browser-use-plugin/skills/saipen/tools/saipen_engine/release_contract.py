"""One canonical release-contract inventory (T-994).

Both the release planner/executor and validate.py must agree on which files
are release metadata. This module owns that definition so the two consumers
can never drift apart.

This module is READ-ONLY, not side-effect-free: it performs no writes, no git
calls and no logging, but ``version_badges(path)`` reads a file to report its
badges. Callers own their reads; the module only promises never to mutate.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


def locale_readme_paths(kitchen_dir: Path) -> list[Path]:
    """Return every mechanically named locale README, including missing ones.

    Mirrors validate.py's original ``locale_readme_paths`` -- this is now the
    single source of truth.
    """
    kitchen_dir = Path(kitchen_dir)
    if not kitchen_dir.is_dir():
        return []
    return [
        directory / f"README_{directory.name.upper()}.md"
        for directory in sorted(kitchen_dir.iterdir())
        if directory.is_dir()
    ]


def version_metadata_paths(root: Path) -> list[Path]:
    """The release surface: VERSION, README.md, CHANGELOG.md, the three root
    README mirrors (README.ee.md, README.ded.md, README.ja.md), the portable
    project-identity carrier (`.saipen/IDENTITY.md`) and every mechanically
    mirrored locale README under the translation kitchen.

    The identity carrier is part of the release surface BY CONTRACT (T-1003
    carrier-loss wave): the portable lineage must be tracked and clone-stable,
    so a full release stages and commits it -- a fresh clone then exposes the
    same lineage. Both the release executor and the validator use this exact
    set. All returned paths are repository-relative, so callers can feed them
    directly to `git add --` and compare them against `git diff --cached`
    output.
    """
    root = Path(root)
    kitchen = root / ".saipen" / "saitranslate" / "kitchen"
    paths = [
        Path("VERSION"),
        Path("README.md"),
        Path("README.ee.md"),
        Path("README.ded.md"),
        Path("README.ja.md"),
        Path("CHANGELOG.md"),
        Path(".saipen/IDENTITY.md"),
    ]
    for readme in locale_readme_paths(kitchen):
        try:
            paths.append(readme.relative_to(root))
        except ValueError:
            # A kitchen outside the repository root is not a release surface.
            continue
    return paths


def source_authority_paths(root: Path) -> list[Path]:
    """Return the complete distributable source-authority transition surface.

    Source receipts are release authority, not runtime cache.  Enumerating the
    fixed owned trees here makes the release planner, stager and ship validator
    agree on the exact bytes that may survive a fresh clone. Quarantined exact
    bodies live outside both owned trees; their digest-bound distribution
    records remain below ``intake/`` and therefore stay on this surface.
    """
    root = Path(root)
    paths: set[Path] = set()
    # A close is a move: tracked active carriers disappear while archive
    # carriers appear.  Existing-file enumeration misses those deletions and
    # lets a release commit only half the authority transition.  Git's one
    # bounded inventory query supplies the missing historical members.
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--",
             ".saipen/intake", ".saipen/archive/source"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode == 0:
            for raw in result.stdout.split(b"\0"):
                if raw:
                    paths.add(Path(raw.decode("utf-8")))
    except (OSError, UnicodeDecodeError):
        # No-Git projects still get their current canonical surface.  A Git
        # release cannot silently claim deletion coverage without this query;
        # the ship gate's tracked-path check will refuse that case.
        pass
    for base_rel in (Path(".saipen/intake"), Path(".saipen/archive/source")):
        base = root / base_rel
        if not base.is_dir():
            continue
        for candidate in base.rglob("*"):
            if candidate.is_file() and not candidate.is_symlink():
                try:
                    paths.add(candidate.relative_to(root))
                except ValueError:
                    continue
    return sorted(paths, key=lambda path: path.as_posix())


def release_metadata_paths(
    root: Path, source_paths: list[Path] | None = None
) -> list[Path]:
    """Exact clone-stable release authority and version metadata surface."""
    return [
        *version_metadata_paths(root),
        Path(".gitattributes"),
        *(source_paths if source_paths is not None else source_authority_paths(root)),
    ]


_VERSION_BADGE_RE = re.compile(r"\*\*v\d+\.\d+\.\d+\*\*")


def version_badges(path: Path) -> list[str]:
    """Return all ``**vX.Y.Z**`` badges found in *path*."""
    text = Path(path).read_text(encoding="utf-8-sig")
    return _VERSION_BADGE_RE.findall(text)
