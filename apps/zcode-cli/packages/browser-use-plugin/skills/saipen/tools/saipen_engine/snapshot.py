"""Project snapshot -- the stale-operation guard (NITRO M1).

Before any mutating operation the snapshot records the canonical files and
their hashes; immediately before committing, the operation re-reads the
affected files and REFUSES if a precondition hash changed. This is optimistic
concurrency and the sequential precursor of v8 stale-plan refusal.
"""

from __future__ import annotations

import hashlib
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .log import HistorySnapshot


def _sha256(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except OSError:
        return ""


def canonical_identity(project_root: Path) -> str:
    """Canonical project identity, not raw path spelling.

    Two aliases to the same project must yield the same identity (used by the
    lock and the cycle id). ONE implementation owns this: paths.project_identity
    (normcase + realpath). Keep it here as the single public name the lock and
    snapshot consume.
    """
    from .paths import project_identity

    return project_identity(project_root)


def git_head(project_root: Path) -> str:
    from .paths import is_git_project_root

    if not is_git_project_root(project_root):
        return ""
    try:
        result = subprocess.run(
            ["git", "-C", str(project_root), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


@dataclass(frozen=True)
class ProjectSnapshot:
    project_root: Path
    project_identity: str
    state_hash: str = ""
    board_hash: str = ""
    log_hash: str = ""
    log_tail: int | None = None
    head: str = ""
    # W2-005: the exact STATE/BOARD bytes that produced state_hash/board_hash.
    # Context and other projections must render/route from these bytes, not from
    # a second independent read that may race a commit.
    state_text: str = ""
    board_text: str = ""
    # T-1014: the parsed events from the SAME one-pass snapshot that fed
    # log_hash/log_tail -- a command that captures the snapshot once can
    # derive the ledger verdict, the hash, the tail AND the events from that
    # single read instead of reopening the complete LOG history per consumer.
    history_events: tuple = ()
    history: HistorySnapshot | None = None

    @staticmethod
    def capture(project_root: Path | str, *, lean: bool = False) -> "ProjectSnapshot":
        root = Path(project_root)
        from .codec import read_checkpoint_doc, CheckpointLoadError
        from .log import read_history_snapshot

        # PERF-008: ONE read per canonical file. read_checkpoint_doc reads
        # STATE/BOARD bytes once and yields both raw_hash and decoded text;
        # read_history_snapshot captures LOG bytes+hash+tail+events in one
        # read. The previous code preflighted STATE/BOARD/LOG, then reopened
        # STATE/BOARD through _sha256 and LOG through a second history read,
        # so each canonical file was opened twice per capture.
        try:
            state_doc = read_checkpoint_doc(root, "STATE.md")
            board_doc = read_checkpoint_doc(root, "BOARD.md")
        except CheckpointLoadError:
            # Preserve the exact error surface of checkpoint_preflight.
            from .codec import checkpoint_preflight

            problem = checkpoint_preflight(root)
            if problem is not None:
                raise CheckpointLoadError(problem)
            raise
        # checkpoint_preflight also required LOG.md to exist; keep that error
        # surface when the active LOG is absent (read_history_snapshot tolerates
        # a missing active segment by design).
        if not (root / ".saipen" / "LOG.md").is_file():
            raise CheckpointLoadError(
                "LOG.md is missing -- a SAIPEN checkpoint requires "
                "STATE.md, BOARD.md and LOG.md to all be present"
            )
        history = read_history_snapshot(root, lean=lean)
        # PERF-005: in lean mode the HistorySnapshot carries hash, tail,
        # parsed events and diagnostics, but the O(history-text) renderings
        # (text, event_lines) are dropped at the source. status/next/explain
        # consume state_text/board_text/history_events/history.hash/  history.tail
        # and do not need history.text or history.event_lines; lean=True
        # makes that contract explicit. Full capture (default) preserves
        # verbatim text and event_lines for context/audit renderers.
        return ProjectSnapshot(
            project_root=root,
            project_identity=canonical_identity(root),
            state_hash=state_doc.raw_hash,
            board_hash=board_doc.raw_hash,
            log_hash=history.hash,
            log_tail=history.tail,
            head=git_head(root),
            state_text=state_doc.text_norm,
            board_text=board_doc.text_norm,
            history_events=history.events,
            history=history,
        )

    def stale(self, project_root: Path | str) -> bool:
        """True if any canonical precondition hash differs from the snapshot."""
        fresh = ProjectSnapshot.capture(project_root)
        return (
            fresh.state_hash != self.state_hash
            or fresh.board_hash != self.board_hash
            or fresh.log_hash != self.log_hash
        )
