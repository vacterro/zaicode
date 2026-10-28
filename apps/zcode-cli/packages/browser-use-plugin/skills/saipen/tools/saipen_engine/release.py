"""Release executor (T-994: release trust repair).

One immutable ReleasePlan and one execution function own the whole release
flow: exact reviewed-source scope, source identity, STATE/BOARD/LOG binding,
version parity, ship gate, content commit (A), branch push, canonical closure
(ticket DONE + digest), closure commit (B), closure push, tag creation/push,
remote verification, and durable recovery.

Key invariants (T-994):
- PLAN is read-only: zero writes (no write-tree, no index mutation, no git
  objects, no recovery journal).
- The release is ONE recovery-visible SAIOPS operation under
  `.saipen/recovery/ops/release-<hex>/`; every external side effect is
  classified expected-BEFORE / expected-AFTER / CONFLICT, and recovery never
  blindly repeats a side effect.
- Release scope = the exact reviewed ticket scope (recorded at REVIEW -> SHIP
  via `saipen scope`) + the mechanically required release metadata. It is
  never inferred from dirty files and never `git add .`.
- Source identity is the canonical freshness primitive
  (`compute_source_identity`), which includes untracked non-ignored files.
- ReleasePlan is deeply immutable and carries project identity + every
  decision binding; `canonical()` covers every field that changes execution
  semantics.
- ALREADY_APPLIED requires full remote + canonical evidence, never local tag
  presence alone.
- No-publish mode: zero staging, zero commit, zero tag, zero push; local
  validation, truthful skipped-publish LOG event, digest, SHIP -> DONE.
- First publish is a journaled canonical WAIT, never chat memory.
- Every public refusal returns a code from errors.CODES; internal stage
  failures collapse to RELEASE_FAILED with the stage/error in `detail`.
"""

from __future__ import annotations

import base64
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from . import codec
from .board import strict_iso_utc, iso_utc_sort_key
from .errors import CODES, EngineError
from .journal import _drop_settled_staged
from .operations import RELEASE_SCOPE_DIR, _plan_finish_ticket, release_scope_matches
from .state import parse_state

# ---------------------------------------------------------------------------
# Git result model
# ---------------------------------------------------------------------------


@dataclass
class GitResult:
    """Structured git subprocess result preserving stderr."""

    rc: int
    stdout: str
    stderr: str = ""

    @property
    def ok(self) -> bool:
        return self.rc == 0


class ReleaseRefusal(Exception):
    """A public release refusal with a stable code from errors.CODES."""

    def __init__(self, code: str, detail: str, next_command: str | None = None) -> None:
        if code not in CODES:
            raise ValueError(f"release refusal {code!r} is not in OPS.md's closed set")
        super().__init__(f"REFUSE [{code}] {detail}")
        self.code = code
        self.detail = detail
        # T-1380: measured live -- a session ran `saipen ship` twice in a project
        # that has no VERSION. The sentence named the right command; the machine
        # field did not carry it, so nothing a host reads could act on it.
        self.next_command = next_command


# ---------------------------------------------------------------------------
# Release operation stages (T-994 / § 3): one recovery-visible operation.
# ---------------------------------------------------------------------------

RELEASE_OP_STAGES = (
    "PREPARED",
    "CONTENT_COMMIT_CREATED",
    "CONTENT_PUBLISHED",
    "CLOSURE_PREPARED",
    "CLOSURE_COMMIT_CREATED",
    "CLOSURE_PUBLISHED",
    "TAG_CREATED",
    "TAG_PUBLISHED",
    "REMOTE_VERIFIED",
    "COMMITTED",
)

# Remote classification closed states (T-994 / § 12).
REMOTE_ABSENT = "ABSENT"  # no origin, or endpoint says nothing exists
REMOTE_EMPTY = "EMPTY"  # endpoint queryable, zero heads AND tags
REMOTE_ESTABLISHED = "ESTABLISHED"  # endpoint has heads or tags
REMOTE_UNAVAILABLE = "UNAVAILABLE"  # network/auth failure, cannot answer
REMOTE_AMBIGUOUS = "AMBIGUOUS"  # multiple push destinations

# Where a continuation plan resumes (T-994 / § 18).
START_PREPARED = "PREPARED"  # nothing external happened yet
START_CLOSURE = "CLOSURE"  # content commit A committed + pushed
START_TAG = "TAG"  # closure commit B committed + pushed, tag missing

CLOSURE_FILES = (
    ".saipen/STATE.md",
    ".saipen/BOARD.md",
    ".saipen/LOG.md",
    ".saipen/kitchen/digest.md",
    ".saipen/kitchen/crew_release_evidence.json",
    ".saipen/kitchen/release_receipt.json",
)


def _closure_stage_paths(root: Path) -> list[str]:
    """The exact closure staging set: the four canonical files PLUS every
    sealed LOG segment that exists. A segment sealed between releases
    (`clean.md` step 4) is canonical history -- if the closure did not stage
    it, a fresh clone would lack the E-### events Recovery depends on and the
    released tag would be broken (the v7.223.16 sealed-segment omission).
    The crew finalize evidence record is staged only when it exists -- it is
    written by the crew finalizer (SC-13) AFTER the terminal crew release, so
    the terminal release itself cannot and must not require it (SC-13
    finalization is local/runtime; the evidence reaches a later closure if
    one happens)."""
    paths = list(CLOSURE_FILES)
    for conditional in (
        ".saipen/kitchen/crew_release_evidence.json",
        ".saipen/kitchen/release_receipt.json",
    ):
        if not (root / conditional).is_file():
            paths = [p for p in paths if p != conditional]
    # Sealed segments come from the ONE canonical numeric history reader
    # (never a local lexicographic sort: LOG-1000 must follow LOG-999). The
    # active LOG.md is already in CLOSURE_FILES by name.
    from .log import history_paths

    paths += [p.relative_to(root).as_posix() for p in history_paths(root) if p.name != "LOG.md"]
    return paths


# ---------------------------------------------------------------------------
# Index snapshot: exact, deletion-preserving rollback (T-994 / § 19).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IndexSnapshot:
    """Exact pre-release index state for rollback.

    Two layers. (a) The `paths`/`entries`/`content_hash` layer enumerates the
    STAGED-CHANGE surface (M/A/T/D status, mode + blob) -- used for foreign
    staging detection and plan identity. (b) The EXACT layer stores the raw
    index file bytes (`index_sha256` + `index_bytes_b64`) resolved through
    `git rev-parse --git-path index`. Restoration writes those exact bytes
    back, which preserves what a staged-diff reconstruction cannot:
    intent-to-add entries, unmerged stages 1/2/3, index extensions, staged
    rename/delete/mode/newline states (T-1003 exact index snapshot).
    """

    paths: tuple[str, ...]
    entries: tuple[tuple[str, str, str], ...]  # (path, mode_or_D, blob_or_)
    content_hash: str
    index_sha256: str = ""
    index_bytes_b64: str = ""
    tree_sha: str = ""

    def to_dict(self) -> dict:
        return {
            "paths": list(self.paths),
            "entries": {p: {"mode": m, "blob": b} for p, m, b in self.entries},
            "content_hash": self.content_hash,
            "index_sha256": self.index_sha256,
            "index_bytes_b64": self.index_bytes_b64,
            "tree_sha": self.tree_sha,
        }


def _capture_index_state(root: Path) -> IndexSnapshot:
    """Capture the exact pre-operation index for rollback.

    Uses `-z` machine lists (a path with a newline must not split staging
    scope) and `--name-status` with status-specific NUL arity (R/C consume 2
    paths, M/A/D/T consume 1 path). Staged deletions are recorded with status D
    so `_restore_index` can recreate them exactly.
    """
    result = _git(root, "diff", "--cached", "--name-status", "-z")
    raw = result.stdout
    fields = raw.split("\0")
    paths: list[str] = []
    changes: list[tuple[str, str, str | None]] = []
    index = 0
    while index < len(fields):
        if not fields[index]:
            index += 1
            continue
        header = fields[index].strip()
        index += 1
        if not header:
            continue
        status_char = header[0].upper()
        if status_char in ("R", "C"):
            if index + 1 >= len(fields):
                raise ValueError(f"truncated git diff output for status {header!r}: {raw!r}")
            old_path = fields[index]
            new_path = fields[index + 1]
            index += 2
            if not old_path or not new_path:
                raise ValueError(
                    f"empty path in git diff {header!r}: old={old_path!r}, new={new_path!r}"
                )
            paths.append(old_path)
            paths.append(new_path)
            changes.append((status_char, old_path, new_path))
        elif status_char in ("M", "A", "D", "T", "U"):
            if index >= len(fields):
                raise ValueError(f"truncated git diff output for status {header!r}: {raw!r}")
            path = fields[index]
            index += 1
            if not path:
                raise ValueError(f"empty path in git diff {header!r}")
            paths.append(path)
            changes.append((status_char, path, None))
        else:
            raise ValueError(f"unknown git diff status {header!r} in {raw!r}")

    # One bounded index query for every non-deleted destination.  Parse stage
    # explicitly: an unmerged path has multiple stage entries and is refused,
    # never silently reduced to whichever per-path subprocess answered first.
    query_paths = sorted(
        {
            new_path if status in ("R", "C") else old_path
            for status, old_path, new_path in changes
            if status != "D"
        }
    )
    index_entries: dict[str, tuple[str, str]] = {}
    if query_paths:
        ls = _git(root, "ls-files", "-s", "-z", "--", *query_paths, literal=True)
        if not ls.ok:
            raise ValueError(f"cannot batch-read index entries: {ls.stderr or ls.stdout}")
        for piece in ls.stdout.split("\0"):
            if not piece or "\t" not in piece:
                continue
            meta_text, path = piece.split("\t", 1)
            meta = meta_text.split()
            if len(meta) < 3:
                raise ValueError(f"malformed git ls-files -s entry: {piece!r}")
            mode, blob, stage = meta[:3]
            if stage != "0" or path in index_entries:
                raise ValueError(f"unmerged/multi-stage index entry for {path!r}")
            index_entries[path] = (mode, blob)

    entries: list[tuple[str, str, str]] = []
    for status, old_path, new_path in changes:
        if status == "R":
            entries.append((old_path, "D", ""))
        target = new_path if status in ("R", "C") else old_path
        if status == "D":
            entries.append((target, "D", ""))
        else:
            mode_blob = index_entries.get(target)
            entries.append(
                (target, mode_blob[0], mode_blob[1]) if mode_blob is not None else (target, "D", "")
            )

    ordered = sorted(set(paths))
    unique_entries = sorted(set(entries))
    content_hash = hashlib.sha256(
        "|".join(f"{p}:{m}:{b}" for p, m, b in unique_entries).encode("utf-8")
    ).hexdigest()[:16]
    # ---- EXACT layer: the raw index file bytes -----------------------------
    # The staged-diff reconstruction above cannot preserve intent-to-add,
    # unmerged stages or index extensions; the index FILE is the only exact
    # state. A git-less no-publish project has no index at all (empty
    # snapshot, nothing to restore); where git IS present but the index
    # cannot be captured, this RAISES -- plan must refuse before any
    # mutation rather than carry a rollback it cannot prove exact (T-1003).
    tree = _git(root, "write-tree")
    tree_sha = tree.stdout.strip() if tree.ok else ""

    # The raw bytes are read AFTER every other git call: porcelain diff and
    # write-tree can stat-refresh the index FILE (rewriting its bytes with
    # identical logical content), so an earlier read would capture a state
    # the very next git command invalidates and the ownership guard would
    # refuse a no-op restore as foreign (hostile-regression false positive).
    index_sha256, index_b64 = _exact_index_bytes(root) if _git_available(root) else ("", "")

    return IndexSnapshot(
        tuple(ordered), tuple(unique_entries), content_hash, index_sha256, index_b64, tree_sha
    )


def _exact_index_bytes(root: Path) -> tuple[str, str]:
    """(sha256, base64) of the exact current index FILE bytes, resolved via
    `git rev-parse --git-path index` (worktree-aware). Raises ValueError when
    the index cannot be located or read -- the caller must refuse before any
    mutation (a rollback that cannot be proven exact is not a rollback)."""
    loc = _git(root, "rev-parse", "--git-path", "index")
    if not loc.ok or not loc.stdout:
        raise ValueError(
            "cannot locate the git index file (git rev-parse --git-path "
            "index failed); exact index snapshot unavailable -- refuse"
        )
    index_path = Path(loc.stdout)
    if not index_path.is_absolute():
        index_path = root / index_path
    index_path = index_path.resolve()
    try:
        raw = index_path.read_bytes()
    except OSError as exc:
        raise ValueError(
            f"cannot read the git index file {index_path}: {exc} -- exact "
            "index snapshot unavailable -- refuse"
        ) from exc
    return hashlib.sha256(raw).hexdigest(), base64.b64encode(raw).decode("ascii")


def _restore_index_bytes(
    root: Path,
    index_bytes_b64: str,
    *,
    expected_live_sha: str | None = None,
) -> None:
    """Write the exact index bytes back to the git index file.

    The bytes ARE the complete index state (entries, stages, flags,
    extensions), so this restores intent-to-add entries, unmerged stages and
    staged deletions/renames byte-exactly. The working tree is never touched.
    A foreign index.lock is a hard refusal (never a silent return the caller
    could mistake for a successful rollback). Raises ValueError when the
    bytes cannot be placed (proving exact restoration impossible is a
    refusal, not a partial rollback)."""
    if not index_bytes_b64:
        return
    if not _git_available(root):
        return
    loc = _git(root, "rev-parse", "--git-path", "index")
    if not loc.ok or not loc.stdout:
        raise ValueError("cannot locate the git index file for exact restoration")
    index_path = Path(loc.stdout)
    if not index_path.is_absolute():
        index_path = root / index_path
    index_path = index_path.resolve()
    lock_path = index_path.with_name(index_path.name + ".lock")
    from .paths import prove_owned_regular, safe_create_bytes_exclusive

    owned_lock = None
    try:
        raw = base64.b64decode(index_bytes_b64.encode("ascii"), validate=True)
        # Git's actual mutex is the exclusive existence of index.lock. Publish
        # the exact replacement bytes into that owned node, then revalidate
        # the live index while the mutex is held before the atomic rename.
        safe_create_bytes_exclusive(
            lock_path,
            raw,
            kind="Git index lock",
            ownership_root=index_path.parent,
        )
        owned_lock = prove_owned_regular(lock_path, kind="Git index lock")
        live = index_path.read_bytes()
        live_sha = hashlib.sha256(live).hexdigest()
        if expected_live_sha is not None and live_sha != expected_live_sha:
            raise ValueError(
                "live index changed before Git index mutex acquisition; "
                "foreign staged changes are preserved (WRITER_BUSY)"
            )
        current_lock = prove_owned_regular(lock_path, kind="Git index lock")
        if (owned_lock.st_dev, owned_lock.st_ino) != (
            current_lock.st_dev,
            current_lock.st_ino,
        ):
            raise ValueError("Git index lock changed before atomic restoration")
        os.replace(lock_path, index_path)
        owned_lock = None
    except (OSError, ValueError) as exc:
        if owned_lock is not None:
            try:
                current = prove_owned_regular(lock_path, kind="Git index lock")
                if (owned_lock.st_dev, owned_lock.st_ino) == (
                    current.st_dev,
                    current.st_ino,
                ):
                    os.unlink(lock_path)
            except (FileNotFoundError, OSError, ValueError):
                pass
        raise ValueError(f"exact index restoration failed for {index_path}: {exc}")


def _restore_index(
    root: Path, pre_state: IndexSnapshot, owned_post_stage_sha: str | None = None
) -> None:
    """Restore the index to the exact pre-release state, OWNER-SAFE.

    The live index is restored to the captured pre-index state ONLY when it
    is provably this release's own staging (hostile-regression):
      - live SHA == pre_state.index_sha256 -> already exactly pre-release;
        nothing to restore;
      - `owned_post_stage_sha` given and live SHA == owned_post_stage_sha
        -> this release's staging: restore. The captured exact index bytes
        are the PRIMARY restoration (intent-to-add entries, unmerged stages,
        staged deletions/renames and index extensions survive byte-exactly);
        `git read-tree` is NEVER used when exact bytes exist, because it
        silently drops every index-only state it does not model;
      - anything else -> ValueError: the live index holds FOREIGN staged
        changes that a rollback would destroy -- preserve it and refuse with
        CONFLICT/RECOVERY_REQUIRED.

    A foreign index.lock is a hard refusal (WRITER_BUSY), never a silent
    return. The working tree is never touched. Raises ValueError on every
    refusal path; the caller converts it into RELEASE_FAILED/CONFLICT.
    """
    loc = _git(root, "rev-parse", "--git-path", "index")
    if not loc.ok or not loc.stdout:
        raise ValueError("cannot locate the git index file; index restoration refused")
    index_path = Path(loc.stdout)
    if not index_path.is_absolute():
        index_path = root / index_path
    index_path = index_path.resolve()

    try:
        live_sha, _ = _exact_index_bytes(root)
    except ValueError as exc:
        raise ValueError(f"cannot prove the live index identity: {exc}")
    if live_sha == pre_state.index_sha256:
        return
    if owned_post_stage_sha is None or live_sha != owned_post_stage_sha:
        raise ValueError(
            "live index does not match the owned post-stage index (and is "
            "not the pre-release index); foreign staged changes would be "
            "destroyed by rollback -- preserve the live index and resolve "
            "explicitly (CONFLICT/RECOVERY_REQUIRED)"
        )

    if pre_state.index_bytes_b64:
        _restore_index_bytes(
            root,
            pre_state.index_bytes_b64,
            expected_live_sha=owned_post_stage_sha,
        )
        return
    # Legacy snapshot without exact bytes: per-entry reconstruction is only
    # reached AFTER the ownership proof above.
    _git(root, "reset", "-q")
    for path, mode, blob in pre_state.entries:
        if mode == "D":
            _git(root, "rm", "--cached", "--quiet", "--", path, literal=True)
        else:
            _git(root, "update-index", "--add", "--cacheinfo", mode, blob, path, literal=True)


def _journal_owned_index_sha(journal) -> str | None:
    """The owned post-stage index SHA durably journaled before the
    CONTENT_STAGED crash point, or None when it was never captured (the live
    caller then refuses to roll back a foreign index)."""
    try:
        record = journal.read()
    except Exception:
        return None
    value = record.get("owned_post_stage_index_sha256")
    return value if isinstance(value, str) and value else None


# ---------------------------------------------------------------------------
# ReleasePlan: the deeply immutable, project-bound decision (T-994 / § 5, § 6).
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ReleasePlan:
    """The immutable release decision, bound to the world it decided against.

    Every precondition the release depends on is captured here: project
    identity, source HEAD + tree fingerprint, index identity, STATE/BOARD/LOG
    hashes, remote classification/tip/refs, push endpoint, mode, and the
    reviewed scope. All decision-bearing fields are immutable tuples/records
    and ALL of them participate in `canonical()`, so an immutable object is
    an immutable DECISION -- no caller can mutate a dict inside it afterwards.
    """

    invocation: str
    op_id: str
    version: str
    branch: str
    tag: str
    ticket_id: str
    commit_message: str
    scope_paths: tuple[str, ...]
    metadata_paths: tuple[str, ...]
    # identity + bindings
    project_identity: str
    project_lineage: str
    source_head: str
    source_tree_fingerprint: str
    source_discovery_model: str
    state_phase: str
    state_task: str | None
    state_hash: str
    board_hash: str
    log_hash: str
    mode: str
    dry_run: bool
    # remote facts (closed classification, T-994 / § 12)
    remote_classification: str
    remote_branch_tip: str
    remote_refs: tuple[tuple[str, str], ...]
    remote_push_url: str
    head_relation: str
    # continuation / policy
    start_stage: str
    content_already_committed: bool
    already_applied: bool
    first_publish_wait: bool
    confirmation: str
    pre_plan_index: IndexSnapshot
    # The ONE live raw push endpoint captured at plan time (git URL form, as
    # `git push origin` will use it). Publication and every post-push
    # verification query THIS endpoint -- with a split fetch=A / pushurl=B
    # setup, the fetch URL is a different repository and proves nothing about
    # what was published (T-1003 publication-remote split).
    remote_push_endpoint: str = ""
    # crew terminal carrier (T-1003 sweep): a terminal crew release is built
    # from the DERIVED deferred crew scope, not one ordinary ticket, and
    # closes through the crew closure path with no ## DOING ticket.
    crew_epoch: str = ""
    crew_closure: bool = False
    crew_scope: tuple[str, str] = ()  # (path, expected_hash) pairs
    # CORE-003: a COHORT batch publication reuses this exact carrier shape.
    # A cohort and a crew closure are the same publication problem -- several
    # units of Work sharing one unpublishable-per-unit scope -- so they share
    # one planner and one executor rather than growing a second publisher.
    cohort_id: str = ""
    # A targeted producer shortcut owns one reviewed Core ticket. Persisted
    # crew intent must not replace that route between PLAN and APPLY.
    targeted_ticket: bool = False
    targeted_integration_op: str = ""
    # CURRENT-SESSION actor (second-wave P0): every LOG/closure/WAIT event
    # this release writes names THIS identity, never persisted STATE.agent
    # (historical last-writer evidence). Captured at plan time so the plan is
    # an immutable decision bound to the actor that decided it. NOT part of
    # `canonical()`: the actor is event provenance, not release identity.
    current_agent: str = ""
    # PERF-002: non-persistent private execution metadata. When set, it is the
    # SourceIdentity captured during planning; execute_release revalidates it
    # (bounded, cheaper) instead of recomputing a full source identity. It is
    # deliberately NOT in `canonical()`: it is execution metadata, not release
    # decision identity, and a serialized/reconstructed plan without it must
    # take the full-capture fallback.
    _source_identity: object = None
    # Exact source-authority membership and bytes captured before APPLY.
    source_manifest: tuple[tuple[str, str], ...] = ()

    @property
    def source_revalidation_token(self):
        """The SourceIdentity captured at plan time, or None."""
        return self._source_identity

    def canonical(self) -> tuple:
        """The plan's identity, INVOCATION-NAME NORMALIZED -- `ship` and
        `push` plans for the same release are identical (T-635), and every
        field capable of changing execution semantics is covered."""
        return (
            self.version,
            self.branch,
            self.tag,
            self.ticket_id,
            self.commit_message,
            self.scope_paths,
            self.metadata_paths,
            self.project_identity,
            self.project_lineage,
            self.source_head,
            self.source_tree_fingerprint,
            self.source_discovery_model,
            self.state_phase,
            self.state_task,
            self.state_hash,
            self.board_hash,
            self.log_hash,
            self.mode,
            self.remote_classification,
            self.remote_branch_tip,
            self.remote_refs,
            self.remote_push_url,
            self.remote_push_endpoint,
            self.head_relation,
            self.start_stage,
            self.content_already_committed,
            self.first_publish_wait,
            self.confirmation,
            self.pre_plan_index.content_hash,
            self.pre_plan_index.paths,
            self.source_manifest,
            self.crew_epoch,
            self.crew_closure,
            self.crew_scope,
            self.cohort_id,
            self.targeted_ticket,
            self.targeted_integration_op,
        )

    @property
    def release_paths(self) -> tuple[str, ...]:
        """Exact staged surface: reviewed scope + release metadata + the
        scope record itself (the reviewed-ownership evidence must reach git,
        or a fresh clone could never continue the release)."""
        return (
            self.scope_paths + self.metadata_paths + (f"{RELEASE_SCOPE_DIR}/{self.ticket_id}.json",)
        )


def _release_failure(stage: str, detail: str, **extra) -> dict:
    out = {"ok": False, "code": "RELEASE_FAILED", "stage": stage, "detail": detail}
    out.update(extra)
    return out


# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------


_TARGETED_PRODUCER_INVOCATIONS = {
    "ship-saiwiki": "saiwiki",
    "ship-saitranslate": "saitranslate",
}


def _targeted_integration_op(root: Path, invocation: str, ticket_id: str) -> str:
    """Committed producer intake binding for one targeted release ticket."""
    from .journal import SemanticReceiptCorruptionError, semantic_receipts_for_operation

    role = _TARGETED_PRODUCER_INVOCATIONS.get(invocation)
    if role is None:
        return ""
    matches = []
    try:
        receipts = semantic_receipts_for_operation(root, "producer_integration")
    except SemanticReceiptCorruptionError as exc:
        raise ReleaseRefusal(
            "CORRUPT_JOURNAL",
            f"semantic receipt snapshot is corrupt: "
            f"{'; '.join(exc.errors[:2])} -- resolve explicitly",
        )
    for receipt in receipts:
        metadata = receipt.get("receipt_metadata") or {}
        if receipt.get("status") != "COMMITTED":
            continue
        if metadata.get("producer") != role or metadata.get("ticket_id") != ticket_id:
            continue
        matches.append((receipt.get("created_at", ""), receipt.get("op_id", "")))
    if not matches:
        return ""
    # W2-005: canonical UTC ordering. Raw-string comparison misorders
    # `...00Z` versus `...00.900000Z` (the plain Z sorts above the fractional
    # form), so a chronologically older receipt could win. iso_utc_sort_key
    # parses both spellings; op_id is the deterministic tie-break.
    _earliest = iso_utc_sort_key("0000-01-01T00:00:00Z")
    return max(matches, key=lambda m: (iso_utc_sort_key(m[0]) or _earliest, m[1]))[1]


def plan_release(
    root: Path,
    invocation: str,
    *,
    dry_run: bool = False,
    crew_carrier: dict | None = None,
    cohort_carrier: dict | None = None,
    targeted_ticket: bool = False,
    current_capability: str | None = None,
    current_agent: str | None = None,
) -> "ReleasePlan":
    """Build the immutable release decision.  WRITES NOTHING."""
    root = Path(root).resolve()
    # P0#4: the CURRENT-SESSION capability is the ONLY authority for whether a
    # release may be PLANNED. A persisted STATE.mode is the LAST handshake
    # outcome and MUST NOT prove current write authority (a stale read-only
    # must not suppress a newly writable session, nor a stale full publish into
    # a newly read-only one). The public command boundary negotiates it fresh
    # and injects it here; a read-only session cannot plan a release.
    if current_capability == "read-only":
        raise ReleaseRefusal(
            "VALIDATION_FAILED",
            "current session capability is read-only; no release may be "
            "planned in a read-only session (capability injected at the "
            "command boundary)",
        )
    _recovery_preflight(root)

    version = _installed_version(root)
    state_text, state = _read_state(root)
    targeted_integration_op = ""
    if targeted_ticket:
        if invocation not in _TARGETED_PRODUCER_INVOCATIONS:
            raise ReleaseRefusal(
                "VALIDATION_FAILED",
                f"targeted ticket route is not valid for invocation {invocation!r}",
            )
        if state.get("phase") != "SHIP" or not str(state.get("task", "")).startswith("T-"):
            raise ReleaseRefusal(
                "ILLEGAL_PHASE",
                "targeted producer release requires its active Core ticket in SHIP",
            )
        targeted_integration_op = _targeted_integration_op(root, invocation, str(state["task"]))
        if not targeted_integration_op:
            raise ReleaseRefusal(
                "SOURCE_SCOPE_MISSING",
                "targeted producer release has no committed integration receipt "
                f"bound to {state['task']}",
            )
    # T-1006: the acting identity is the ONE canonical seat -- the CLI
    # threads `_agent_for(project_root)` (inherited STATE.agent, or an
    # explicit --agent handover) as `current_agent`. The persisted
    # STATE.agent fallback here serves only direct API callers that predate
    # the field; the release executor is always called with the resolved
    # actor.
    release_actor = current_agent or state.get("agent") or "saipen-cli"
    board_text, board = _read_board(root)
    log_hash = _log_hash(root)
    # P0#4: the negotiated current-session capability -- not the persisted
    # STATE.mode -- decides whether this release may publish.
    mode = _read_mode(state, current_capability)

    from .paths import project_identity as _project_identity, project_lineage_identity

    project_identity = _project_identity(root)
    # A new release REQUIRES a valid live portable lineage (T-1003
    # carrier-loss wave): the receipt binds to it, recovery validates it, and
    # the carrier is part of the release surface. A missing/malformed carrier
    # refuses before any plan/decision work -- a release without a lineage
    # could never be recovered after a move or clone.
    project_lineage = project_lineage_identity(root)
    if not project_lineage:
        raise ReleaseRefusal(
            "VALIDATION_FAILED",
            "no valid portable project lineage (.saipen/IDENTITY.md is "
            "missing or malformed); every new release requires the canonical "
            "tracked carrier so its receipt stays recoverable across clone "
            "and move",
        )

    try:
        from freshness import compute_source_identity

        ident = compute_source_identity(root)
    except Exception as exc:
        raise ReleaseRefusal("RELEASE_FAILED", f"cannot compute canonical source identity: {exc}")

    source_head = ident.source_head
    fingerprint = ident.source_tree_fingerprint
    source_model = ident.discovery_model
    head = _git(root, "rev-parse", "HEAD").stdout if mode == "full" else source_head

    # PERF-006: capture source_authority_paths(root) ONCE; derive
    # _metadata_paths and _source_authority_manifest from the same list
    # instead of re-running the git ls-files + rglob three times.
    from .release_contract import source_authority_paths
    _source_paths = source_authority_paths(root)

    tag = f"v{version}"

    # ---- crew terminal carrier (T-1003 sweep) ------------------------------
    # An active crew epoch publishes exactly once, through the EXISTING
    # release executor, with the scope DERIVED from committed crew-defer
    # receipts (never a manual list). The carrier is the mechanically-owned
    # decision surface; the executor still owns commit/publish/closure/tag/
    # verification/recovery.
    if crew_carrier is None and not targeted_ticket:
        if state.get("execution_intent") == "converge" and state.get("converge_target") == "crew":
            from .crew import crew_release_context

            ctx = crew_release_context(root)
            if not ctx.get("ok"):
                raise ReleaseRefusal(
                    "CREW_NOT_READY",
                    ctx.get("detail", "") or "crew is not ready for terminal publication",
                )
            # CORE-002: the crew conformance PASS receipt is produced AFTER
            # the terminal state is established (post-finalization), not before.
            # Pre-ship validates convergence evidence + SC-0..SC-10. The
            # full crew gate runs post-ship as terminal certification.
            crew_carrier = {
                "crew_epoch": ctx["crew_epoch"],
                "scope": ctx.get("crew_defer_scope") or {},
                "ticket_id": ctx.get("ticket_id") or "",
            }
            if not crew_carrier["scope"] or not crew_carrier["ticket_id"]:
                raise ReleaseRefusal(
                    "CREW_NOT_READY",
                    "crew is terminal but no deferred crew scope is "
                    "derivable -- DEFER_FOR_CREW ran for zero tickets?",
                )
    # CORE-003: a cohort carrier is the SAME batch-publication shape as a crew
    # carrier -- an owned scope of shared paths, closed at local DONE / task
    # none. It routes to the same planner (and therefore the same executor,
    # the same index/foreign-staging protections and the same recovery) with a
    # cohort identity instead of a crew epoch.
    _batch_carrier = crew_carrier if crew_carrier is not None else cohort_carrier
    if _batch_carrier is not None:
        return _plan_crew_release(
            root,
            invocation,
            version,
            state_text,
            state,
            board_text,
            board,
            log_hash,
            project_identity,
            source_head,
            fingerprint,
            source_model,
            tag,
            _batch_carrier,
            dry_run,
            source_paths=_source_paths,
            current_capability=current_capability,
            current_agent=release_actor,
            cohort_id=str((cohort_carrier or {}).get("cohort_id") or ""),
        )

    # ---- no-publish needs NO git facts at all (T-994 / § 10) --------------
    if mode == "no-publish":
        phase = state.get("phase")
        if phase != "SHIP":
            raise ReleaseRefusal(
                "ILLEGAL_PHASE",
                f"release requires phase SHIP; actual phase {phase}. "
                "Run the ticket through REVIEW then SHIP first.",
            )
        task = state.get("task")
        ticket = _find_ticket(board, task)
        if ticket is None:
            raise ReleaseRefusal(
                "SOURCE_SCOPE_MISSING",
                f"STATE.task={task!r} but no matching DOING ticket on BOARD.",
            )
        _scope_for(root, ticket["id"], head, fingerprint, continuation=False)
        _check_parity(root, version)
        index = IndexSnapshot((), (), hashlib.sha256(b"no-publish-no-git").hexdigest()[:16])
        return ReleasePlan(
            invocation=invocation,
            op_id="release-" + _hex8(),
            version=version,
            branch="",
            tag=tag,
            ticket_id=ticket["id"],
            commit_message=f"ship v{version}",
            scope_paths=tuple(_scope_paths(root, ticket["id"])),
            metadata_paths=tuple(_metadata_paths(root, _source_paths)),
            project_identity=project_identity,
            project_lineage=project_lineage,
            source_head=source_head,
            source_tree_fingerprint=fingerprint,
            source_discovery_model=source_model,
            state_phase=phase,
            state_task=task,
            state_hash=_quick_hash(state_text),
            board_hash=_quick_hash(board_text),
            log_hash=log_hash,
            mode=mode,
            dry_run=dry_run,
            remote_classification="never",
            remote_branch_tip="",
            remote_refs=(),
            remote_push_url="",
            head_relation="local",
            start_stage=START_PREPARED,
            content_already_committed=False,
            already_applied=False,
            first_publish_wait=False,
            confirmation="",
            pre_plan_index=index,
            source_manifest=_source_authority_manifest(root, _source_paths),
            targeted_ticket=targeted_ticket,
            targeted_integration_op=targeted_integration_op,
            current_agent=release_actor,
        )

    # ---- mode full: remote + continuation classification ------------------
    if not _branch_exists(root, _branch(root)):
        raise ReleaseRefusal("STALE_PLAN", f"current branch {_branch(root)!r} does not exist")

    # ONE live raw push endpoint: publication and every plan-time
    # classification/verification query the SAME destination `git push
    # origin` writes -- never the unrelated fetch URL (T-1003
    # publication-remote split).
    remote_push_endpoint = _push_endpoint(root)
    if not remote_push_endpoint:
        cls, cls_err = REMOTE_ABSENT, "no push endpoint configured"
        remote_snapshot = RemoteSnapshot(False, "no push endpoint", {})
    else:
        # ONE canonical ls-remote: classification, branch tip, peeled tag and
        # the full ref set all derive from this single query (T-1004 remote).
        remote_snapshot = _remote_snapshot(root, remote_push_endpoint)
        cls, cls_err = remote_snapshot.classification()
    if cls == REMOTE_UNAVAILABLE:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            f"remote origin is UNAVAILABLE -- cannot classify before any "
            f"external write: {cls_err or 'query failed'}",
        )
    if cls == REMOTE_AMBIGUOUS:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "origin has multiple push destinations; refuse multi-destination publication",
        )

    push_urls = _push_urls(root)
    if len(push_urls) > 1:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "multiple push destinations configured for origin: "
            + ", ".join(push_urls)
            + " -- refuse multi-destination publication",
        )
    if cls not in (REMOTE_ABSENT, REMOTE_EMPTY) and not push_urls:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "no push URL configured for origin -- configure the push destination before releasing",
        )
    remote_push_url = _sanitize_push_url(push_urls[0]) if push_urls else ""

    branch = _branch(root)
    remote_ok, remote_tip = remote_snapshot.branch_tip(branch)
    if not remote_ok:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "remote branch tip query failed at plan time; remote "
            "classification is not re-checkable -- refuse",
        )
    tag_local, tag_local_c = _local_tag_commit(root, tag)
    _tag_remote_ok, tag_remote_c = remote_snapshot.tag_commit(tag)
    tag_remote_exists = bool(tag_remote_c)
    remote_refs = tuple(sorted(remote_snapshot.refs.items()))
    head_relation = _head_relation(root, remote_tip)

    phase = state.get("phase")
    task = state.get("task")

    # ---- tag collisions are always refusals before any decision ----------
    if tag_local and tag_local_c != head:
        raise ReleaseRefusal(
            "TAG_CONFLICT",
            f"local tag {tag} exists at {tag_local_c[:12]}, not HEAD "
            f"{head[:12]}; resolve before releasing",
        )
    if tag_remote_exists and tag_remote_c != head:
        raise ReleaseRefusal(
            "TAG_CONFLICT",
            f"remote tag {tag} exists at {tag_remote_c[:12]}, not HEAD "
            f"{head[:12]}; resolve before releasing",
        )

    # ---- phase gate -------------------------------------------------------
    if phase not in ("SHIP", "DONE"):
        raise ReleaseRefusal(
            "ILLEGAL_PHASE",
            f"release requires phase SHIP (or a proven in-flight release "
            f"with phase DONE); actual phase {phase}",
        )

    # ---- ticket identity ---------------------------------------------------
    # T-1014: ONE call-scoped release evidence capture for this PLAN. The same
    # immutable receipts + parsed history feed both ticket discovery and the
    # continuation classification below, instead of re-scanning/re-parsing the
    # same evidence twice. APPLY-time freshness rechecks (execute_release) do
    # NOT reuse this capture and stay fresh.
    _release_receipts, _release_events = _release_evidence(root)
    if phase == "DONE":
        ticket_id = _find_release_ticket(
            root, version, receipts=_release_receipts, events=_release_events
        )
        if ticket_id is None:
            raise ReleaseRefusal(
                "RELEASE_FAILED",
                "phase DONE but no committed release RUN event names this "
                "version; cannot continue an unproven release",
            )
    else:
        ticket = _find_ticket(board, task)
        if ticket is None:
            raise ReleaseRefusal(
                "SOURCE_SCOPE_MISSING",
                f"STATE.task={task!r} but no matching DOING ticket on BOARD.",
            )
        ticket_id = ticket["id"]

    # ---- exact reviewed scope ----------------------------------------------
    _scope_for(
        root,
        ticket_id,
        head,
        fingerprint,
        continuation=(phase == "DONE" or tag_remote_exists or (remote_tip and remote_tip == head)),
    )
    scope_paths = _scope_paths(root, ticket_id)
    scope_record_rel = f"{RELEASE_SCOPE_DIR}/{ticket_id}.json"

    _check_parity(root, version)
    index = _capture_index_state(root)

    # ---- foreign pre-existing staging must refuse (T-994 / § 2) ------------
    # A path this release does not own (not reviewed scope, not mechanically
    # required metadata, not the scope record) must never enter the commit.
    allowed = set(scope_paths) | set(_metadata_paths(root, _source_paths)) | {scope_record_rel}
    foreign = sorted(set(index.paths) - allowed)
    if foreign:
        raise ReleaseRefusal(
            "VALIDATION_FAILED",
            "foreign pre-existing staged path(s) would enter this release: "
            + ", ".join(foreign)
            + " -- stage the release scope explicitly or leave it untouched",
        )

    # ---- continuation / completion classification --------------------------
    classification = _classify_continuation(
        root,
        state,
        phase,
        ticket_id,
        version,
        tag,
        branch,
        head,
        cls,
        remote_tip,
        tag_local,
        tag_local_c,
        tag_remote_exists,
        tag_remote_c,
        [*scope_paths, scope_record_rel],
        receipts=_release_receipts,
        events=_release_events,
    )

    confirmation = _read_confirmation(state)

    return ReleasePlan(
        invocation=invocation,
        op_id="release-" + _hex8(),
        version=version,
        branch=branch,
        tag=tag,
        ticket_id=ticket_id,
        commit_message=f"ship v{version}",
            scope_paths=tuple(scope_paths),
            metadata_paths=tuple(_metadata_paths(root, _source_paths)),
            project_identity=project_identity,
            project_lineage=project_lineage,
            source_head=source_head,
            source_tree_fingerprint=fingerprint,
            source_discovery_model=source_model,
            state_phase=phase,
            state_task=task,
            state_hash=_quick_hash(state_text),
            board_hash=_quick_hash(board_text),
            log_hash=log_hash,
            mode=mode,
            dry_run=dry_run,
            remote_classification=cls,
            remote_branch_tip=remote_tip,
            remote_refs=remote_refs,
            remote_push_url=remote_push_url,
            remote_push_endpoint=remote_push_endpoint,
            head_relation=head_relation,
            start_stage=classification["start_stage"],
            content_already_committed=classification["content_already_committed"],
            already_applied=classification["already_applied"],
            first_publish_wait=classification["first_publish_wait"],
            confirmation=confirmation,
            pre_plan_index=index,
            source_manifest=_source_authority_manifest(root, _source_paths),
            targeted_ticket=targeted_ticket,

        targeted_integration_op=targeted_integration_op,
        current_agent=release_actor,
        # PERF-002: carry the planning SourceIdentity for bounded revalidation
        # in execute_release instead of a second full capture.
        _source_identity=ident,
    )


def _plan_crew_release(
    root: Path,
    invocation: str,
    version: str,
    state_text: str,
    state: dict,
    board_text: str,
    board: dict,
    log_hash: str,
    project_identity: str,
    source_head: str,
    fingerprint: str,
    source_model: str,
    tag: str,
    crew_carrier: dict,
    dry_run: bool,
    source_paths: list[Path] | None = None,
    current_capability: str | None = None,
    current_agent: str | None = None,
    cohort_id: str = "",
) -> "ReleasePlan":
    """Plan the terminal crew release from a derived crew carrier.

    The carrier owns the exact deferred scope (path -> deferred hash) and the
    crew epoch identity; THIS function binds it into an immutable ReleasePlan
    and refuses on any drift. Core must be at local DONE / task none (all
    ordinary tickets were crew-deferred). Full mode still requires the same
    remote facts as an ordinary release; no-publish mode still needs none.
    """
    from .paths import project_lineage_identity

    project_lineage = project_lineage_identity(root)
    if not project_lineage:
        raise ReleaseRefusal(
            "VALIDATION_FAILED",
            "no valid portable project lineage (.saipen/IDENTITY.md is "
            "missing or malformed); every new release requires the canonical "
            "tracked carrier",
        )
    # P0#4: same authority as an ordinary release -- the negotiated
    # current-session capability, never the persisted STATE.mode.
    mode = _read_mode(state, current_capability)
    crew_epoch = crew_carrier.get("crew_epoch") or ""
    scope = crew_carrier.get("scope") or {}
    ticket_id = crew_carrier.get("ticket_id") or ""
    # Exactly one batch identity must be present: a crew epoch or a cohort id.
    # An anonymous batch could not be recovered or re-verified afterwards.
    if not (crew_epoch or cohort_id) or not ticket_id or not scope:
        raise ReleaseRefusal(
            "VALIDATION_FAILED",
            "terminal batch carrier is missing crew_epoch/cohort_id, ticket_id or scope",
        )
    # Deferred ownership is an edge: the CURRENT bytes MUST equal the bytes
    # the latest owning review approved (item 5 -- later unreviewed mutation
    # is stale/refuse; a deleted path stays an exact deletion identity).
    for rel, expected in sorted(scope.items()):
        fp = root / rel
        if expected is None:
            if fp.exists():
                raise ReleaseRefusal(
                    "STALE_PLAN",
                    f"crew scope path {rel} is a reviewed deletion but exists in the worktree",
                )
            continue
        if not fp.is_file():
            raise ReleaseRefusal(
                "SOURCE_SCOPE_MISSING", f"crew scope path {rel} is missing from the worktree"
            )
        live = _quick_hash(fp.read_bytes())
        if live != expected:
            raise ReleaseRefusal(
                "STALE_PLAN",
                f"crew scope path {rel} changed since the owning defer "
                f"(live {live!r}, deferred {expected!r})",
            )
    phase = state.get("phase")
    task = state.get("task")
    if phase != "DONE" or task not in (None, "", "none"):
        raise ReleaseRefusal(
            "ILLEGAL_PHASE",
            f"crew terminal release requires local Core phase DONE / task "
            f"none; live {phase}/{task}",
        )
    _check_parity(root, version)

    # Second-wave P0: the acting identity is the CURRENT-SESSION agent, never
    # persisted STATE.agent (historical last-writer evidence).
    release_actor = current_agent or state.get("agent") or "saipen-cli"

    if mode == "no-publish":
        index = IndexSnapshot((), (), hashlib.sha256(b"no-publish-no-git").hexdigest()[:16])
        return ReleasePlan(
            invocation=invocation,
            op_id="release-" + _hex8(),
            version=version,
            branch="",
            tag=tag,
            ticket_id=ticket_id,
            commit_message=f"ship v{version}",
            scope_paths=tuple(sorted(scope)),
            metadata_paths=tuple(_metadata_paths(root, source_paths)),
            project_identity=project_identity,
            project_lineage=project_lineage,
            source_head=source_head,
            source_tree_fingerprint=fingerprint,
            source_discovery_model=source_model,
            state_phase=phase,
            state_task=task,
            state_hash=_quick_hash(state_text),
            board_hash=_quick_hash(board_text),
            log_hash=log_hash,
            mode=mode,
            dry_run=dry_run,
            remote_classification="never",
            remote_branch_tip="",
            remote_refs=(),
            remote_push_url="",
            head_relation="local",
            start_stage=START_PREPARED,
            content_already_committed=False,
            already_applied=False,
            first_publish_wait=False,
            confirmation="",
            pre_plan_index=index,
            crew_epoch=crew_epoch,
            crew_closure=True,
            crew_scope=tuple(sorted(scope.items())),
            cohort_id=cohort_id,
            source_manifest=_source_authority_manifest(root, source_paths),
            current_agent=release_actor,
        )

    if not _branch_exists(root, _branch(root)):
        raise ReleaseRefusal("STALE_PLAN", f"current branch {_branch(root)!r} does not exist")
    remote_push_endpoint = _push_endpoint(root)
    if not remote_push_endpoint:
        cls, cls_err = REMOTE_ABSENT, "no push endpoint configured"
        remote_snapshot = RemoteSnapshot(False, "no push endpoint", {})
    else:
        remote_snapshot = _remote_snapshot(root, remote_push_endpoint)
        cls, cls_err = remote_snapshot.classification()
    if cls == REMOTE_UNAVAILABLE:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            f"remote origin is UNAVAILABLE -- cannot classify before any "
            f"external write: {cls_err or 'query failed'}",
        )
    if cls == REMOTE_AMBIGUOUS:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "origin has multiple push destinations; refuse multi-destination publication",
        )
    push_urls = _push_urls(root)
    if len(push_urls) > 1:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "multiple push destinations configured for origin: "
            + ", ".join(push_urls)
            + " -- refuse multi-destination publication",
        )
    if cls not in (REMOTE_ABSENT, REMOTE_EMPTY) and not push_urls:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "no push URL configured for origin -- configure the push destination before releasing",
        )
    remote_push_url = _sanitize_push_url(push_urls[0]) if push_urls else ""

    branch = _branch(root)
    remote_ok, remote_tip = remote_snapshot.branch_tip(branch)
    if not remote_ok:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "remote branch tip query failed at plan time; remote "
            "classification is not re-checkable -- refuse",
        )
    tag_local, tag_local_c = _local_tag_commit(root, tag)
    _tag_remote_ok, tag_remote_c = remote_snapshot.tag_commit(tag)
    tag_remote_exists = bool(tag_remote_c)
    remote_refs = tuple(sorted(remote_snapshot.refs.items()))
    head_relation = _head_relation(root, remote_tip)
    head = _git(root, "rev-parse", "HEAD").stdout

    if tag_local and tag_local_c != head:
        raise ReleaseRefusal(
            "TAG_CONFLICT",
            f"local tag {tag} exists at {tag_local_c[:12]}, not HEAD "
            f"{head[:12]}; resolve before releasing",
        )
    if tag_remote_exists and tag_remote_c != head:
        raise ReleaseRefusal(
            "TAG_CONFLICT",
            f"remote tag {tag} exists at {tag_remote_c[:12]}, not HEAD "
            f"{head[:12]}; resolve before releasing",
        )

    index = _capture_index_state(root)
    allowed = set(scope) | set(_metadata_paths(root, source_paths))
    foreign = sorted(set(index.paths) - allowed)
    if foreign:
        raise ReleaseRefusal(
            "VALIDATION_FAILED",
            "foreign pre-existing staged path(s) would enter this release: "
            + ", ".join(foreign)
            + " -- stage the release scope explicitly or leave it untouched",
        )

    return ReleasePlan(
        invocation=invocation,
        op_id="release-" + _hex8(),
        version=version,
        branch=branch,
        tag=tag,
        ticket_id=ticket_id,
        commit_message=f"ship v{version}",
        scope_paths=tuple(sorted(scope)),
        metadata_paths=tuple(_metadata_paths(root, source_paths)),
        project_identity=project_identity,
        project_lineage=project_lineage,
        source_head=source_head,
        source_tree_fingerprint=fingerprint,
        source_discovery_model=source_model,
        state_phase=phase,
        state_task=task,
        state_hash=_quick_hash(state_text),
        board_hash=_quick_hash(board_text),
        log_hash=log_hash,
        mode=mode,
        dry_run=dry_run,
        remote_classification=cls,
        remote_branch_tip=remote_tip,
        remote_refs=remote_refs,
        remote_push_url=remote_push_url,
        remote_push_endpoint=remote_push_endpoint,
        head_relation=head_relation,
        start_stage=START_PREPARED,
        content_already_committed=False,
        already_applied=False,
        first_publish_wait=cls in (REMOTE_ABSENT, REMOTE_EMPTY),
        confirmation=_read_confirmation(state),
        pre_plan_index=index,
        source_manifest=_source_authority_manifest(root, source_paths),
        crew_epoch=crew_epoch,
        crew_closure=True,
        crew_scope=tuple(sorted(scope.items())),
        cohort_id=cohort_id,
        current_agent=release_actor,
    )


def execute_release(root: Path, plan: ReleasePlan) -> dict:
    """Execute the plan.  The ONE execution function."""
    root = Path(root).resolve()
    if plan.already_applied:
        preflight = _preflight_plan(root, plan)
        if not preflight["ok"]:
            return preflight
        return {
            "ok": True,
            "code": "RELEASED",
            "already_applied": True,
            "stage": "COMMITTED",
            "stages_reached": list(RELEASE_OP_STAGES),
            "tag": plan.tag,
            "branch": plan.branch,
            "detail": "full remote + canonical evidence proves this release "
            "already completed; no commit/tag/push performed",
        }
    if plan.dry_run:
        return _apply_dry_run(root, plan)
    if plan.first_publish_wait:
        if plan.confirmation:
            # Confirmation present + matching: publication authorized, but the
            # plan bindings must still be re-verified before any write.
            preflight = _preflight_plan(root, plan)
            if not preflight["ok"]:
                return preflight
            return _apply_release(root, plan)
        return _apply_first_publish_wait(root, plan)
    if plan.mode == "no-publish":
        preflight = _preflight_plan(root, plan)
        if not preflight["ok"]:
            return preflight
        return _apply_no_publish(root, plan)
    preflight = _preflight_plan(root, plan)
    if not preflight["ok"]:
        return preflight
    return _apply_release(root, plan)


# ---------------------------------------------------------------------------
# Recovery preflight
# ---------------------------------------------------------------------------


def _recovery_preflight(root: Path) -> None:
    """Read-only journal scan: unresolved operations block a new release."""
    from .journal import scan_pending

    pending, conflicts = scan_pending(root)
    if not pending:
        return
    corrupt = [op for op in pending if op.get("corrupt")]
    if corrupt:
        raise ReleaseRefusal(
            "CORRUPT_JOURNAL",
            "corrupt recovery evidence: "
            + ", ".join(f"{op.get('op_id', '?')} ({op.get('detail', '')})" for op in corrupt)
            + " -- resolve explicitly before releasing",
        )
    if conflicts:
        raise ReleaseRefusal(
            "RECOVERY_CONFLICT",
            "unresolved recovery conflict(s): "
            + ", ".join(str(op.get("op_id", "?")) for op in conflicts)
            + " -- recover before releasing",
        )
    raise ReleaseRefusal(
        "RECOVERY_REQUIRED",
        "pending recovery operation(s): "
        + ", ".join(str(op.get("op_id", "?")) for op in pending[:5])
        + " -- recover before releasing",
    )


# ---------------------------------------------------------------------------
# Continuation / completion classification (T-994 / § 13, § 18)
# ---------------------------------------------------------------------------


def _surface_dirty(root: Path, paths: list[str]) -> list[str]:
    """Paths with a staged, unstaged OR untracked non-ignored delta against
    HEAD (literal paths).

    `git diff` alone MISSES untracked files, so a scope consisting of a brand
    new (untracked) file would read as a clean surface and the continuation
    classification would skip its content commit -- the v7.223.15 false-success
    defect. Untracked non-ignored files are part of the canonical source
    identity (freshness.py `git-delta-v1`), and the continuation decision
    uses the SAME surface.
    """
    dirty = set()
    cached = _git(root, "diff", "--cached", "--name-only", "-z", "--", *paths, literal=True)
    for p in cached.stdout.split("\0"):
        if p:
            dirty.add(p)
    work = _git(root, "diff", "--name-only", "-z", "--", *paths, literal=True)
    for p in work.stdout.split("\0"):
        if p:
            dirty.add(p)
    untracked = _git(
        root, "ls-files", "--others", "--exclude-standard", "-z", "--", *paths, literal=True
    )
    for p in untracked.stdout.split("\0"):
        if p:
            dirty.add(p)
    return sorted(dirty)


def _classify_continuation(
    root: Path,
    state: dict,
    phase: str,
    ticket_id: str,
    version: str,
    tag: str,
    branch: str,
    head: str,
    cls: str,
    remote_tip: str,
    tag_local: bool,
    tag_local_c: str,
    tag_remote_exists: bool,
    tag_remote_c: str,
    scope_paths: list[str],
    receipts: list[dict] | None = None,
    events: tuple[dict, ...] | None = None,
) -> dict:
    """Classify the release as FRESH / NEEDS_CLOSURE / NEEDS_TAG /
    ALREADY_APPLIED / FIRST_PUBLISH. Never rounds a partial state up."""
    if (
        phase == "DONE"
        and tag_local
        and tag_local_c == head
        and tag_remote_exists
        and tag_remote_c == head
        and remote_tip == head
        and _ticket_done(root, ticket_id)
        and _log_has_ship(root, version, ticket_id, receipts=receipts, events=events)
    ):
        return {
            "start_stage": START_TAG,
            "content_already_committed": True,
            "already_applied": True,
            "first_publish_wait": False,
        }
    if (
        phase == "DONE"
        and remote_tip == head
        and not tag_remote_exists
        and _ticket_done(root, ticket_id)
        and _log_has_ship(root, version, ticket_id, receipts=receipts, events=events)
    ):
        return {
            "start_stage": START_TAG,
            "content_already_committed": True,
            "already_applied": False,
            "first_publish_wait": False,
        }
    if (
        phase == "SHIP"
        and not tag_local
        and not tag_remote_exists
        and remote_tip == head
        and not _surface_dirty(root, scope_paths)
    ):
        return {
            "start_stage": START_CLOSURE,
            "content_already_committed": True,
            "already_applied": False,
            "first_publish_wait": False,
        }
    if phase == "SHIP" and not tag_local and not tag_remote_exists:
        if cls in (REMOTE_ABSENT, REMOTE_EMPTY):
            return {
                "start_stage": START_PREPARED,
                "content_already_committed": False,
                "already_applied": False,
                "first_publish_wait": True,
            }
        return {
            "start_stage": START_PREPARED,
            "content_already_committed": False,
            "already_applied": False,
            "first_publish_wait": False,
        }
    if phase == "DONE":
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            "phase DONE but the release cannot be proven complete (remote "
            "branch/tag or committed evidence missing); UNKNOWN != RELEASED",
        )
    raise ReleaseRefusal(
        "RELEASE_FAILED",
        f"ambiguous release continuation state (phase {phase}, remote tip "
        f"{remote_tip[:12] if remote_tip else '(none)'}, local tag "
        f"{tag_local}, remote tag {tag_remote_exists})",
    )


def _ticket_done(root: Path, ticket_id: str) -> bool:
    from .board import parse_board

    text = codec.read_doc(root / ".saipen" / "BOARD.md")
    board = parse_board(text)
    ticket = board["tickets"].get(ticket_id)
    return bool(ticket and ticket["section"] == "## DONE" and ticket["checkbox"] == "x")


def _committed_release_receipts(root: Path, receipt_snapshot=None) -> list[dict]:
    """Every COMMITTED release receipt across BOTH the recovery/ops journal AND
    the recovery/settled ledger (W2-002): terminal release receipts are moved to
    settled by _settle_journal, so reading ops alone made a settled release
    invisible to crew finalize. Also includes the published
    `.saipen/kitchen/release_receipt.json` closure artifact (T-1003 findings
    20/26) -- the recovery/ops tree is NOT cloned, so the structured published
    receipt is what a fresh clone sees and release continuation identity must
    never depend on LOG prose."""
    out = []
    from .journal import semantic_receipt_snapshot

    snapshot = receipt_snapshot or semantic_receipt_snapshot(root)
    if snapshot.errors:
        return []
    for record in snapshot.records:
        if (
            record.get("operation") == "release"
            and record.get("status") == "COMMITTED"
            and record.get("release_stage") == "COMMITTED"
        ):
            out.append(record)
    published = root / ".saipen" / "kitchen" / "release_receipt.json"
    if published.is_file():
        try:
            record = json.loads(published.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            record = None
        if record and record.get("operation") == "release_receipt":
            out.append(record)
    return out


def _release_evidence(
    root: Path, receipts: list[dict] | None = None, events: tuple[dict, ...] | None = None
):
    """ONE call-scoped capture of the immutable release evidence (T-1014).

    Committed release receipts and the complete parsed LOG history are read
    once per PLAN and threaded into discovery / ship-proof / continuation
    classification so the same immutable-on-this-PLAN evidence is never
    re-scanned or re-parsed. Callers that do not pass a capture (e.g. the
    APPLY-time freshness recheck at line ~1492) still read FRESH evidence --
    this capture never crosses the PLAN/APPLY correctness boundary."""
    if receipts is None:
        receipts = _committed_release_receipts(root)
    if events is None:
        from .log import read_history_snapshot

        events = read_history_snapshot(root).events
    return receipts, events


def _log_has_ship(
    root: Path,
    version: str,
    ticket_id: str,
    receipts: list[dict] | None = None,
    events: tuple[dict, ...] | None = None,
) -> bool:
    """Committed STRUCTURED release evidence: a COMMITTED release receipt
    naming this version + ticket, or a committed release RUN line in the
    complete LOG history. Accepts a call-scoped evidence capture (T-1014);
    without one it reads fresh."""
    receipts, events = _release_evidence(root, receipts, events)
    if any(
        record.get("version") == version and record.get("ticket_id") == ticket_id
        for record in receipts
    ):
        return True
    for ev in events:
        if ev.get("ticket") == ticket_id:
            txt = ev.get("text", "")
            tax = ev.get("taxonomy", "")
            if (
                tax in ("RUN", "OPS", "DEC")
                and (version in txt or f"v{version}" in txt)
                and ("ship" in txt.lower() or "release" in txt.lower())
            ):
                return True
    return False


def _find_release_ticket(
    root: Path,
    version: str,
    receipts: list[dict] | None = None,
    events: tuple[dict, ...] | None = None,
) -> str | None:
    """The ticket that shipped this version, from COMMITTED release receipts
    or complete LOG history. Accepts a call-scoped evidence capture (T-1014);
    without one it reads fresh."""
    receipts, events = _release_evidence(root, receipts, events)
    for record in receipts:
        ticket = record.get("ticket_id") or ""
        if record.get("version") == version and ticket.startswith("T-"):
            return ticket
    for ev in reversed(events):
        ticket = ev.get("ticket") or ""
        if ticket.startswith("T-"):
            txt = ev.get("text", "")
            tax = ev.get("taxonomy", "")
            if (
                tax in ("RUN", "OPS", "DEC")
                and (version in txt or f"v{version}" in txt)
                and ("ship" in txt.lower() or "release" in txt.lower())
            ):
                return ticket
    return None


def _read_confirmation(state: dict) -> str:
    return str(state.get("first_publish_confirmation") or "")


# ---------------------------------------------------------------------------
# Reviewed scope (T-994 / § 2)
# ---------------------------------------------------------------------------


def _scope_path(root: Path, ticket_id: str) -> Path:
    return root / RELEASE_SCOPE_DIR / f"{ticket_id}.json"


def _scope_paths(root: Path, ticket_id: str) -> list[str]:
    return sorted(_load_scope(root, ticket_id, None, None, continuation=True)["paths"])


def _load_scope(
    root: Path, ticket_id: str, head: str | None, fingerprint: str | None, continuation: bool
) -> dict:
    """Read + validate the recorded reviewed scope for a ticket.

    Binds the ticket to exact file identities and the source identity at
    review time. For a fresh release the current HEAD must BE the reviewed
    HEAD; for a continuation the reviewed HEAD must be an ancestor (the
    release commits landed on top). Per-path hashes must match the live
    bytes in both cases.
    """
    from .paths import project_identity as _project_identity, project_lineage_identity

    path = _scope_path(root, ticket_id)
    if not path.is_file():
        raise ReleaseRefusal(
            "SOURCE_SCOPE_MISSING",
            f"no release scope recorded for {ticket_id} -- record the exact "
            f"reviewed files (`saipen scope {ticket_id} <path...>`) before "
            "shipping",
        )
    try:
        data = json.loads(codec.read_doc(path))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseRefusal("RECOVERY_CONFLICT", f"release scope record {path} is corrupt: {exc}")
    if data.get("schema_version") not in (1, 2):
        raise ReleaseRefusal(
            "RECOVERY_CONFLICT",
            f"release scope record {path} has unknown schema_version "
            f"{data.get('schema_version')!r}",
        )
    if data.get("ticket") != ticket_id:
        raise ReleaseRefusal(
            "RECOVERY_CONFLICT",
            f"release scope record {path} names ticket {data.get('ticket')!r}, not {ticket_id}",
        )
    # A scope record is bound to the project that recorded it. For a FRESH
    # release that binding is a hard boundary (cross-project scope is
    # refused). For a CONTINUATION the record is committed release evidence:
    # a fresh clone of the release branch legitimately carries it, so the
    # ancestry check below -- not the absolute path -- is the binding.
    #
    # Binding is by PORTABLE lineage (survives moving the project); moving a
    # project must not invalidate reviewed evidence. Machine path is NOT
    # durable semantic evidence (T-1003 carrier-loss wave). Legacy records
    # created before lineage keep the old runtime-path boundary as an explicit
    # compatibility rule.
    if not continuation:
        record_lineage = data.get("project_lineage")
        if record_lineage:
            live_lineage = project_lineage_identity(root)
            if not live_lineage or live_lineage != record_lineage:
                raise ReleaseRefusal(
                    "PATH_ESCAPE",
                    "release scope record belongs to a different project "
                    "lineage; refuse cross-project scope",
                )
        elif data.get("project_identity") != _project_identity(root):
            raise ReleaseRefusal(
                "PATH_ESCAPE",
                "release scope record was created for a different project; "
                "refuse cross-project scope",
            )
    reviewed_head = data.get("source_head") or ""
    if head is not None:
        if continuation:
            if not _is_ancestor(root, reviewed_head, head):
                raise ReleaseRefusal(
                    "STALE_PLAN",
                    f"reviewed source_head {reviewed_head[:12]} is not an "
                    f"ancestor of current HEAD {head[:12]}; the release "
                    "continuation is not bound to this tree",
                )
        elif reviewed_head != head:
            raise ReleaseRefusal(
                "STALE_PLAN",
                f"reviewed source_head {reviewed_head[:12]} != current HEAD "
                f"{head[:12]}; the reviewed scope is stale, re-record it",
            )
    paths = data.get("paths") or {}
    if not paths:
        raise ReleaseRefusal(
            "SOURCE_SCOPE_MISSING", f"release scope record {path} carries no paths"
        )
    if not isinstance(paths, dict):
        raise ReleaseRefusal(
            "RECOVERY_CONFLICT", f"release scope record {path} has non-object paths"
        )
    # W2-004: the persisted read side must re-establish the writer-side path
    # ownership invariant. Every recorded path must be a canonical project-
    # relative path with no absolute/drive/parent traversal, and every live
    # path must be proven inside the project BEFORE stat/read/hash. The
    # canonical writer would never emit such a path, so bytes that carry one
    # are corrupt/transplanted/manual and must refuse -- never an outside read.
    root_resolved = root.resolve()
    for rel in paths:
        if not isinstance(rel, str) or not rel:
            raise ReleaseRefusal(
                "RECOVERY_CONFLICT", f"release scope record {path} has an invalid path key"
            )
        if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
            raise ReleaseRefusal(
                "RECOVERY_CONFLICT",
                f"release scope record {path} carries an absolute path {rel!r}",
            )
        parts = rel.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise ReleaseRefusal(
                "RECOVERY_CONFLICT",
                f"release scope record {path} carries a non-canonical path {rel!r}",
            )
    for rel, expected in paths.items():
        try:
            candidate = (root / rel).resolve()
            candidate.relative_to(root_resolved)
        except ValueError:
            raise ReleaseRefusal(
                "RECOVERY_CONFLICT",
                f"release scope path {rel!r} escapes the project root",
            )
        fp = root / rel
        if expected is None:
            # Deletion scope entry: the reviewed file must STILL be absent at
            # APPLY (a file that reappeared is a stale scope, not a ship).
            if fp.exists():
                raise ReleaseRefusal(
                    "STALE_PLAN",
                    f"scope path {rel} is recorded as a reviewed deletion but "
                    "exists in the worktree; re-record the scope or restore "
                    "the deletion",
                )
            continue
        if not isinstance(expected, str) or not re.fullmatch(
            r"(?:[0-9a-f]{16}|[0-9a-f]{64})", expected
        ):
            raise ReleaseRefusal(
                "RECOVERY_CONFLICT",
                f"release scope path {rel!r} carries a malformed hash",
            )
        if not fp.is_file():
            raise ReleaseRefusal(
                "SOURCE_SCOPE_MISSING", f"scope path {rel} is missing from the worktree"
            )
        raw = fp.read_bytes()
        if not release_scope_matches(raw, expected):
            live = _quick_hash(raw)
            raise ReleaseRefusal(
                "STALE_PLAN",
                f"scope path {rel} changed since review (live {live!r}, "
                f"reviewed {expected!r}); re-record the scope or revert the "
                "edit",
            )
    return data


def _is_ancestor(root: Path, ancestor: str, descendant: str) -> bool:
    if ancestor == descendant:
        return True
    result = _git(root, "merge-base", "--is-ancestor", ancestor, descendant)
    return result.ok


# ---------------------------------------------------------------------------
# Preflight: validate plan against live state (T-994 / § 8)
# ---------------------------------------------------------------------------


def _preflight_plan(root: Path, plan: ReleasePlan) -> dict:
    """Verify every plan binding against the live world before ANY write."""
    from .paths import project_identity as _project_identity, project_lineage_identity

    if _project_identity(root) != plan.project_identity:
        return _release_failure(
            "PREFLIGHT", "plan was built for a different project; refusing cross-project execution"
        )
    # The portable lineage must still be live and identical at execute time:
    # a release whose carrier disappeared between plan and apply cannot bind
    # its receipt to anything (T-1003 carrier-loss wave).
    live_lineage = project_lineage_identity(root)
    if not live_lineage or live_lineage != plan.project_lineage:
        return _release_failure(
            "PREFLIGHT",
            f"live project lineage {live_lineage!r} does not match the "
            f"plan's {plan.project_lineage!r}; the identity carrier is "
            "missing/malformed or changed -- refuse the release",
        )

    # Re-read + validate canonical state.
    try:
        state_text, state = _read_state(root)
        board_text, board = _read_board(root)
        log_hash = _log_hash(root)
    except Exception as exc:
        return _release_failure("PREFLIGHT", f"canonical state unreadable: {exc}")
    if _quick_hash(state_text) != plan.state_hash:
        return _release_failure(
            "PREFLIGHT", "STATE.md changed since the plan was built; rebuild the plan"
        )
    if _quick_hash(board_text) != plan.board_hash:
        return _release_failure(
            "PREFLIGHT", "BOARD.md changed since the plan was built; rebuild the plan"
        )
    if log_hash != plan.log_hash:
        return _release_failure(
            "PREFLIGHT", "LOG.md changed since the plan was built; rebuild the plan"
        )
    source_manifest_error = _check_source_authority_manifest(root, plan)
    if source_manifest_error:
        return _release_failure("PREFLIGHT", source_manifest_error)

    # T-1162: release cannot outrun authoritative source coverage. This is a
    # targeted metadata/contract/coverage check plus digest reread of active
    # bodies; cold archives are deliberately excluded from ordinary ship.
    from .intake import release_gate

    source_gate = release_gate(root, plan.ticket_id)
    if not source_gate.get("ok"):
        route = source_gate.get("canonical_next_command")
        return _release_failure(
            "SOURCE_COVERAGE",
            f"source receipt blocks ship: {source_gate}",
            source_gate=source_gate,
            **({"canonical_next_command": route} if route else {}),
        )

    if plan.targeted_ticket:
        live_op = _targeted_integration_op(root, plan.invocation, plan.ticket_id)
        if not live_op or live_op != plan.targeted_integration_op:
            return _release_failure(
                "PREFLIGHT",
                "targeted producer integration receipt changed or disappeared "
                "since the plan was built",
            )

    # First-publish confirmation must name THIS endpoint (T-994 / § 11).
    if plan.first_publish_wait and plan.confirmation:
        confirm_remote = plan.confirmation.split()[0] if plan.confirmation.split() else ""
        if (
            confirm_remote
            and plan.remote_push_url
            and _sanitize_push_url(confirm_remote) != plan.remote_push_url
        ):
            return _release_failure(
                "FIRST_PUBLISH_WAIT",
                f"recorded first-publish confirmation names a different "
                f"remote ({plan.confirmation!r}); refuse",
            )

    if plan.mode == "no-publish" and plan.crew_closure:
        # Crew no-publish terminal closure: ZERO git operations, but the
        # deferred crew scope must still be byte-exact and Core must be at
        # local DONE / task none.
        if state.get("phase") != "DONE" or state.get("task") not in (None, "", "none"):
            return _release_failure(
                "PREFLIGHT",
                "crew no-publish closure requires phase DONE / "
                f"task none; live {state.get('phase')}/{state.get('task')}",
            )
        for rel, expected in plan.crew_scope:
            fp = root / rel
            if expected is None:
                if fp.exists():
                    return _release_failure("PREFLIGHT", f"crew scope path {rel} reappeared")
                continue
            if not fp.is_file():
                return _release_failure("PREFLIGHT", f"crew scope path {rel} missing")
            if _quick_hash(fp.read_bytes()) != expected:
                return _release_failure("PREFLIGHT", f"crew scope path {rel} changed since defer")
        return {"ok": True}

    if plan.mode == "no-publish":
        # No-publish APPLY performs ZERO git operations: re-verify only the
        # canonical + scope bindings (T-994 / § 10).
        if state.get("phase") != "SHIP" or state.get("task") != plan.ticket_id:
            return _release_failure(
                "PREFLIGHT",
                f"no-publish requires phase SHIP / task == "
                f"{plan.ticket_id}; live {state.get('phase')}/"
                f"{state.get('task')}",
            )
        doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
        if len(doing) != 1 or doing[0]["id"] != plan.ticket_id:
            return _release_failure(
                "PREFLIGHT", f"no-publish requires exactly one ## DOING ticket == {plan.ticket_id}"
            )
        try:
            _scope_for(
                root,
                plan.ticket_id,
                plan.source_head,
                plan.source_tree_fingerprint,
                continuation=False,
            )
        except ReleaseRefusal as exc:
            return _release_failure("PREFLIGHT", str(exc))
        return {"ok": True}

    if plan.start_stage == START_TAG:
        if state.get("phase") != "DONE" or state.get("task") not in (None, "none"):
            return _release_failure(
                "PREFLIGHT",
                "continuation needs phase DONE / task none; live "
                f"{state.get('phase')}/{state.get('task')}",
            )
        if not _ticket_done(root, plan.ticket_id):
            return _release_failure(
                "PREFLIGHT", f"continuation requires {plan.ticket_id} DONE on BOARD"
            )
        if not _log_has_ship(root, plan.version, plan.ticket_id):
            return _release_failure(
                "PREFLIGHT", "no committed release RUN event binds this continuation to the ticket"
            )
    elif plan.crew_closure:
        # Crew closure is planned at phase DONE / task none (all ordinary
        # tickets were crew-deferred), so the full-mode preflight must accept
        # that same surface instead of demanding phase SHIP + an active DOING
        # ticket. The deferred crew scope check below is the real authority
        # (T-1003 item 6): an active DOING ticket cannot exist after
        # DEFER_FOR_CREW, so requiring one here made every terminal crew
        # release impossible (reproduced twice: E-3836, this run).
        if state.get("phase") != "DONE" or state.get("task") not in (None, "none"):
            return _release_failure(
                "PREFLIGHT",
                "crew closure needs phase DONE / task none; live "
                f"{state.get('phase')}/{state.get('task')}",
            )
    else:
        if state.get("phase") != "SHIP":
            return _release_failure(
                "PREFLIGHT", f"release requires phase SHIP; live {state.get('phase')}"
            )
        if state.get("task") != plan.ticket_id:
            return _release_failure(
                "PREFLIGHT", f"STATE.task={state.get('task')} != planned {plan.ticket_id}"
            )
        doing = [t for t in board["tickets"].values() if t["section"] == "## DOING"]
        if len(doing) != 1 or doing[0]["id"] != plan.ticket_id:
            return _release_failure(
                "PREFLIGHT", f"BOARD must hold exactly one ## DOING ticket == {plan.ticket_id}"
            )

    # Source identity must still match the plan.
    # PERF-002: reuse the planning SourceIdentity via bounded revalidation when
    # it is present and bound to this root/model. This turns the second full
    # capture into a cheaper revalidation. Absent/invalid/stale tokens fall
    # back to the full capture.
    plan_token = plan.source_revalidation_token
    live = None
    if plan_token is not None:
        try:
            from freshness import revalidate_source_identity

            ok, _err = revalidate_source_identity(root, plan_token)
            if ok:
                live = plan_token
        except Exception:
            live = None
    if live is None:
        try:
            from freshness import compute_source_identity

            live = compute_source_identity(root)
        except Exception as exc:
            return _release_failure("PREFLIGHT", f"cannot recompute source identity: {exc}")
    if live.source_head != plan.source_head:
        return _release_failure(
            "PREFLIGHT",
            f"source HEAD changed: planned "
            f"{plan.source_head[:12]}, live "
            f"{live.source_head[:12]}; rebuild the plan",
        )
    if live.source_tree_fingerprint != plan.source_tree_fingerprint:
        return _release_failure(
            "PREFLIGHT",
            "source tree fingerprint changed since the plan was built; rebuild the plan",
        )

    # Exact index identity.
    index = _capture_index_state(root)
    if index.content_hash != plan.pre_plan_index.content_hash:
        return _release_failure(
            "PREFLIGHT", "index content changed since the plan was built; rebuild the plan"
        )

    # Reviewed scope bytes must still match the plan (they are inside the
    # source fingerprint, but name them explicitly for a clear refusal). A
    # crew terminal plan binds the derived deferred scope instead.
    if plan.crew_closure:
        for rel, expected in plan.crew_scope:
            fp = root / rel
            if expected is None:
                if fp.exists():
                    return _release_failure("PREFLIGHT", f"crew scope path {rel} reappeared")
                continue
            if not fp.is_file():
                return _release_failure("PREFLIGHT", f"crew scope path {rel} missing")
            if _quick_hash(fp.read_bytes()) != expected:
                return _release_failure("PREFLIGHT", f"crew scope path {rel} changed since defer")
    else:
        try:
            _scope_for(
                root,
                plan.ticket_id,
                plan.source_head,
                plan.source_tree_fingerprint,
                continuation=(plan.start_stage != START_PREPARED),
            )
        except ReleaseRefusal as exc:
            return _release_failure("PREFLIGHT", str(exc))

    # Remote re-classification: closed, fail-closed (T-994 / § 12). ONE fresh
    # snapshot at APPLY serves classification + branch tip + tag so the
    # pre-publication read is a single coherent observation (T-1004 remote).
    if not plan.remote_push_endpoint:
        cls, cls_err = REMOTE_ABSENT, "no push endpoint configured"
        remote_snapshot = RemoteSnapshot(False, "no push endpoint", {})
    else:
        remote_snapshot = _remote_snapshot(root, plan.remote_push_endpoint)
        cls, cls_err = remote_snapshot.classification()
    if cls == REMOTE_UNAVAILABLE:
        return _release_failure(
            "PREFLIGHT",
            f"remote was queryable at PLAN but is UNAVAILABLE "
            f"at APPLY -- refuse before publication: "
            f"{cls_err or 'query failed'}",
        )
    if cls == REMOTE_AMBIGUOUS:
        return _release_failure("PREFLIGHT", "remote classification became AMBIGUOUS at APPLY")
    if cls != plan.remote_classification and not (
        plan.remote_classification in (REMOTE_ABSENT, REMOTE_EMPTY)
        and cls in (REMOTE_ABSENT, REMOTE_EMPTY)
    ):
        return _release_failure(
            "PREFLIGHT",
            f"remote classification changed: planned {plan.remote_classification}, live {cls}",
        )

    remote_ok, remote_tip = remote_snapshot.branch_tip(plan.branch)
    if not remote_ok:
        return _release_failure(
            "PREFLIGHT", "remote branch tip query failed at APPLY; refuse before publication"
        )
    if remote_tip != plan.remote_branch_tip:
        return _release_failure(
            "PREFLIGHT",
            f"remote branch moved: planned "
            f"{plan.remote_branch_tip[:12] or '(none)'}, live "
            f"{remote_tip[:12] or '(none)'}. Rebuild the plan.",
        )

    push_urls = _push_urls(root)
    if [_sanitize_push_url(u) for u in push_urls] != [plan.remote_push_url] and not (
        plan.remote_push_url == "" and not push_urls
    ):
        return _release_failure(
            "PREFLIGHT",
            f"push destination changed: planned {plan.remote_push_url!r}, live {push_urls!r}",
        )

    # Local + remote tag absence is a hard precondition for a fresh/closure
    # plan (a present tag would collide with this release's tag). The remote
    # query targets the captured PUSH endpoint, never the fetch URL.
    tag_local, tag_local_c = _local_tag_commit(root, plan.tag)
    _tag_remote_ok, tag_remote_c = remote_snapshot.tag_commit(plan.tag)
    tag_remote_exists = bool(tag_remote_c)
    if plan.start_stage in (START_PREPARED, START_CLOSURE):
        if tag_local:
            return _release_failure(
                "TAG_CONFLICT",
                f"local tag {plan.tag} exists at "
                f"{tag_local_c[:12] or '?'}; resolve before releasing",
            )
        if tag_remote_exists:
            return _release_failure(
                "TAG_CONFLICT",
                f"remote tag {plan.tag} exists at "
                f"{tag_remote_c[:12] or '?'}; resolve before releasing",
            )
    elif plan.start_stage == START_TAG:
        # Resumable tag: the tag must be missing or already point at HEAD.
        if tag_local and tag_local_c != plan.source_head:
            return _release_failure(
                "TAG_CONFLICT",
                f"local tag {plan.tag} points at {tag_local_c[:12]}, not the "
                "release HEAD; refuse to rewrite",
            )
        if tag_remote_exists and tag_remote_c != plan.source_head:
            return _release_failure(
                "TAG_CONFLICT",
                f"remote tag {plan.tag} points at {tag_remote_c[:12]}, not "
                "the release HEAD; refuse to rewrite",
            )
        if tag_remote_exists and tag_remote_c == plan.source_head:
            # Tag already published: the only missing piece is the local
            # mark; this is effectively complete.
            pass

    return {"ok": True}


def _scope_for(
    root: Path, ticket_id: str, head: str | None, fingerprint: str | None, continuation: bool
) -> dict:
    return _load_scope(root, ticket_id, head, fingerprint, continuation)


# ---------------------------------------------------------------------------
# Dry-run (zero writes)
# ---------------------------------------------------------------------------


def _apply_dry_run(root: Path, plan: ReleasePlan) -> dict:
    """Dry-run: ZERO writes.  Verify by snapshot comparison."""
    if plan.first_publish_wait:
        return {
            "ok": True,
            "code": "FIRST_PUBLISH_WAIT",
            "writes": "none",
            "would_wait": True,
            "next_action": _wait_message(plan.remote_push_url),
            "detail": "would persist a journaled first-publish WAIT (no commit/tag/push)",
        }
    if plan.mode == "no-publish":
        return {
            "ok": True,
            "code": "RELEASE_PLAN",
            "writes": "none",
            "plan": plan.canonical(),
            "commit_message": plan.commit_message,
            "tag": plan.tag,
            "branch": plan.branch,
            "release_paths": list(plan.release_paths),
            "mode": "no-publish",
        }

    pre_worktree = _snapshot_worktree(root, plan.release_paths)
    pre_refs = _snapshot_all_refs(root)
    pre_index = _capture_index_state(root)
    pre_tags = _git(root, "tag", "--list").stdout
    pre_branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout
    pre_head = _git(root, "rev-parse", "HEAD").stdout
    pre_obj_count = _git_object_count(root)

    errors = _verify_zero_writes(
        root, plan, pre_worktree, pre_refs, pre_index, pre_tags, pre_branch, pre_head, pre_obj_count
    )

    if errors:
        return _release_failure("DRY_RUN", "; ".join(errors))

    return {
        "ok": True,
        "code": "RELEASE_PLAN",
        "writes": "none",
        "plan": plan.canonical(),
        "commit_message": plan.commit_message,
        "tag": plan.tag,
        "branch": plan.branch,
        "release_paths": list(plan.release_paths),
    }


def _verify_zero_writes(
    root: Path,
    plan: ReleasePlan,
    pre_worktree: dict,
    pre_refs: dict,
    pre_index: IndexSnapshot,
    pre_tags: str,
    pre_branch: str,
    pre_head: str,
    pre_obj_count: int,
) -> list[str]:
    """Compare pre/post snapshots; return list of violations."""
    violations: list[str] = []
    post_worktree = _snapshot_worktree(root, plan.release_paths)
    for path, h in pre_worktree.items():
        if post_worktree.get(path) != h:
            violations.append(f"worktree changed: {path}")
    post_refs = _snapshot_all_refs(root)
    for ref, h in pre_refs.items():
        if post_refs.get(ref) != h:
            violations.append(f"ref changed: {ref}")
    for ref in post_refs:
        if ref not in pre_refs:
            violations.append(f"new ref: {ref}")
    post_index = _capture_index_state(root)
    if post_index.content_hash != pre_index.content_hash:
        violations.append("index content changed")
    post_tags = _git(root, "tag", "--list").stdout
    if post_tags != pre_tags:
        violations.append("tags changed")
    post_head = _git(root, "rev-parse", "HEAD").stdout
    if post_head != pre_head:
        violations.append("HEAD changed")
    post_obj = _git_object_count(root)
    if post_obj != pre_obj_count:
        violations.append(f"git object count changed: {pre_obj_count} -> {post_obj}")
    return violations


# ---------------------------------------------------------------------------
# First-publish WAIT (T-994 / § 11)
# ---------------------------------------------------------------------------


def _wait_message(remote_push_url: str) -> str:
    name = _remote_name(remote_push_url)
    return f"WAIT: first-publish -- confirm repo name '{name}' and public/private before I push"


def _remote_name(push_url: str) -> str:
    if not push_url:
        return "<origin>"
    return push_url


def _apply_first_publish_wait(root: Path, plan: ReleasePlan) -> dict:
    """Persist the canonical first-publish WAIT. ZERO commit/tag/push.

    The confirmation-present path is dispatched by `execute_release` (it runs
    the full preflight + apply); this function ONLY writes the WAIT.
    """
    from .operations import record_first_publish_wait

    # record_first_publish_wait is itself a journaled SAIOPS op and acquires
    # the writer lock; never nest a lock around it (WRITER_BUSY).
    result = record_first_publish_wait(
        root, plan.current_agent or "saipen-cli", _remote_name(plan.remote_push_url)
    )
    if not result.ok:
        return _release_failure(
            "FIRST_PUBLISH_WAIT",
            f"could not persist canonical first-publish WAIT: {result.message}",
        )
    return {
        "ok": False,
        "code": "FIRST_PUBLISH_WAIT",
        "stage": "FIRST_PUBLISH_WAIT",
        "stages_reached": ["FIRST_PUBLISH_WAIT"],
        "next_action": _wait_message(plan.remote_push_url),
        "event_id": result.data.get("event_id"),
        "op_id": result.op_id,
        "detail": "first publish requires confirmation; canonical WAIT "
        "persisted, zero commit/tag/push performed",
    }


def _agent(root: Path) -> str:
    """DEPRECATED (T-1006): reading the acting identity from persisted
    STATE.agent directly bypasses the ONE canonical resolver (`_agent_for` in
    tools/saipen.py, which INHERITS STATE.agent and journals an explicit
    handover). Every release event now names `plan.current_agent`, captured
    at plan time from that resolved actor. Kept only as a fail-safe default
    for callers that predate the field; the release executor never uses it."""
    try:
        _, state = _read_state(root)
        return state.get("agent") or "saipen-cli"
    except (OSError, ValueError):
        return "saipen-cli"


# ---------------------------------------------------------------------------
# No-publish mode (T-994 / § 10: matches ship.md exactly)
# ---------------------------------------------------------------------------


def _apply_no_publish(root: Path, plan: ReleasePlan) -> dict:
    """no-publish: zero staging, zero commit, zero tag, zero push.

    Runs the local validator, writes the truthful skipped-publish LOG event
    through canonical machinery, closes the ticket with the digest, and goes
    SHIP -> DONE. Works even when Git is genuinely unavailable.
    """
    from .lock import project_writer_lock
    from .operations import RELEASE_SCOPE_DIR  # noqa: F401

    try:
        with project_writer_lock(root):
            return _apply_no_publish_locked(root, plan)
    except PermissionError:
        return _release_failure("WRITER_BUSY", "another live writer holds the project lock")


def _git_available(root: Path) -> bool:
    from .paths import is_git_project_root

    return is_git_project_root(root)


def _apply_no_publish_locked(root: Path, plan: ReleasePlan) -> dict:
    from .journal import Journal, _drop_settled_staged
    from .operations import record_scope  # noqa: F401

    journal = Journal(root, plan.op_id)
    if journal.exists():
        return _release_failure(
            "RECOVERY_REQUIRED", f"release op {plan.op_id} already exists; recover first"
        )
    # Crew authorization must be proven BEFORE this op becomes pending --
    # crew_release_context evaluates SC-0..SC-10 and would refuse its own
    # pending sibling.
    crew_context = None
    if plan.crew_epoch:
        try:
            from .crew import crew_release_context

            crew_context = crew_release_context(root)
        except OSError as exc:
            return _release_failure("CREW_NOT_READY", f"cannot read crew release context: {exc}")
        if crew_context is None or not crew_context.get("ok"):
            return _release_failure(
                "CREW_NOT_READY",
                (crew_context or {}).get("detail", "")
                or "crew is not ready for terminal no-publish closure",
            )
    _try_journal(
        journal,
        "start",
        "release",
        plan.current_agent or "saipen-cli",
        plan.project_identity,
        hashlib.sha256(str(plan.canonical()).encode()).hexdigest()[:16],
        [],
        {},
        project_lineage=plan.project_lineage,
    )
    _try_journal(
        journal,
        "update",
        version=plan.version,
        branch="",
        tag=plan.tag,
        ticket_id=plan.ticket_id,
        mode="no-publish",
        scope_paths=list(plan.scope_paths),
        metadata_paths=list(plan.metadata_paths),
        source_head=plan.source_head,
        source_tree_fingerprint=plan.source_tree_fingerprint,
        remote_push_url="",
        remote_old_tip="",
        content_commit="",
        closure_commit="",
        remote_tag_sha="",
        start_stage="PREPARED",
        plan_canonical=list(plan.canonical()),
    )
    # Crash immediately after Journal.start: the op exists in PREPARED with
    # ZERO closure targets -- recovery must ABORT, never COMMITTED
    # (T-1003 no-publish crash-before-body).
    _maybe_crash("NO_PUBLISH_STARTED")
    if crew_context is not None:
        _try_journal(
            journal,
            "update",
            crew_epoch=crew_context["crew_epoch"],
            crew_pre_ship_source=crew_context["crew_pre_ship_source"],
            crew_pre_ship_evidence=crew_context["crew_pre_ship_evidence"],
            crew_pre_ship_applicability=crew_context.get("crew_pre_ship_applicability") or {},
            crew_closure=True,
        )
    try:
        _no_publish_body(root, plan, journal)
    except ReleaseRefusal as exc:
        return _release_failure("NO_PUBLISH", exc.detail)
    _try_journal(journal, "mark", "COMMITTED")
    _try_journal(journal, "update", release_stage="COMMITTED")
    cleanup_pending = _drop_settled_staged(journal)
    result = {
        "ok": True,
        "code": "NO_PUBLISH_MODE",
        "stage": "COMMITTED",
        "stages_reached": ["NO_PUBLISH_MODE"],
        "op_id": plan.op_id,
        "tag": plan.tag,
        "detail": "no-publish: local validation passed, skipped-publish event "
        "recorded, ticket closed; zero git writes",
    }
    if cleanup_pending:
        result["cleanup_pending"] = cleanup_pending
    return result


def _no_publish_body(root: Path, plan: ReleasePlan, journal) -> None:
    """Local validation + canonical closure for no-publish (zero git)."""
    gate = _run_gate(root, "core")
    if not gate["ok"]:
        raise ReleaseRefusal(
            "VALIDATION_FAILED", f"no-publish local validation failed: {gate['detail']}"
        )
    # Crash after the gate but BEFORE any closure target is appended: the op
    # is still PREPARED with ZERO targets -> recovery ABORTS with zero
    # canonical mutation (T-1003 no-publish crash-before-body).
    _maybe_crash("NO_PUBLISH_GATE")
    git_ok = _git_available(root)
    reason = "policy" if git_ok else "no git"
    run_msg = f"ship v{plan.version} -> skipped publish (no-publish: {reason})"
    top = _top_todo(root)
    digest = (
        f"done: ship v{plan.version} -> skipped publish "
        f"(no-publish: {reason})\n"
        f"remaining: {top}\n"
        f"awaiting: {'git needed to publish' if not git_ok else 'nothing'}\n"
    )
    _apply_finish_targets(root, journal, plan, digest, run_msg)
    _try_journal(journal, "update", release_stage="CLOSURE_COMMIT_CREATED")


# ---------------------------------------------------------------------------
# Full release apply
# ---------------------------------------------------------------------------


def _apply_release(root: Path, plan: ReleasePlan) -> dict:
    from .lock import project_writer_lock

    try:
        with project_writer_lock(root):
            return _apply_release_locked(root, plan)
    except PermissionError:
        return _release_failure("WRITER_BUSY", "another live writer holds the project lock")


def _apply_release_locked(root: Path, plan: ReleasePlan) -> dict:
    from .journal import Journal, _drop_settled_staged

    journal = Journal(root, plan.op_id)
    if journal.exists():
        return _release_failure(
            "RECOVERY_REQUIRED", f"release op {plan.op_id} already exists; recover first"
        )
    stages = []
    cleanup_pending: list[str] = []
    try:
        crew_context = None
        try:
            from .state import parse_state

            active_state = parse_state(codec.read_doc(root / ".saipen" / "STATE.md"))
            if (
                not plan.targeted_ticket
                and active_state.get("execution_intent") == "converge"
                and active_state.get("converge_target") == "crew"
            ):
                from .crew import crew_release_context

                crew_context = crew_release_context(root)
                if not crew_context.get("ok"):
                    return _release_failure("CREW_NOT_READY", crew_context.get("detail", ""))
        except OSError as exc:
            return _release_failure("CREW_NOT_READY", f"cannot read crew release context: {exc}")
        _try_journal(
            journal,
            "start",
            "release",
            plan.current_agent or "saipen-cli",
            plan.project_identity,
            hashlib.sha256(str(plan.canonical()).encode()).hexdigest()[:16],
            [],
            {},
            project_lineage=plan.project_lineage,
        )
        _try_journal(
            journal,
            "update",
            version=plan.version,
            branch=plan.branch,
            tag=plan.tag,
            ticket_id=plan.ticket_id,
            mode="full",
            scope_paths=list(plan.scope_paths),
            metadata_paths=list(plan.metadata_paths),
            source_head=plan.source_head,
            source_tree_fingerprint=plan.source_tree_fingerprint,
            remote_push_url=plan.remote_push_url,
            remote_push_endpoint=plan.remote_push_endpoint,
            remote_old_tip=plan.remote_branch_tip,
            remote_classification=plan.remote_classification,
            pre_index_sha256=plan.pre_plan_index.index_sha256,
            pre_index_b64=plan.pre_plan_index.index_bytes_b64,
            content_commit="",
            closure_commit="",
            remote_tag_sha="",
            intended_content_tree="",
            intended_closure_tree="",
            start_stage=plan.start_stage,
            plan_canonical=list(plan.canonical()),
            confirmation=plan.confirmation,
        )
        if crew_context:
            _try_journal(
                journal,
                "update",
                crew_epoch=crew_context["crew_epoch"],
                crew_pre_ship_source=crew_context["crew_pre_ship_source"],
                crew_pre_ship_evidence=crew_context["crew_pre_ship_evidence"],
                crew_pre_ship_applicability=crew_context.get("crew_pre_ship_applicability") or {},
            )
        elif plan.crew_epoch:
            _try_journal(
                journal,
                "update",
                crew_epoch=plan.crew_epoch,
                crew_closure=True,
                crew_pre_ship_evidence=plan.crew_scope,
            )

        if plan.start_stage == START_TAG:
            # ---- continuation: only the tag is missing (T-994 / § 18 B/C) --
            closure_commit = plan.source_head
            content_commit = _git(root, "rev-parse", "HEAD^").stdout or ""
            _try_journal(
                journal, "update", content_commit=content_commit, closure_commit=closure_commit
            )
            _mark_stage(journal, "CONTENT_COMMIT_CREATED")
            _mark_stage(journal, "CONTENT_PUBLISHED")
            _mark_stage(journal, "CLOSURE_PREPARED")
            _mark_stage(journal, "CLOSURE_COMMIT_CREATED")
            _mark_stage(journal, "CLOSURE_PUBLISHED")
            stages += [
                "CONTENT_COMMIT_CREATED",
                "CONTENT_PUBLISHED",
                "CLOSURE_PREPARED",
                "CLOSURE_COMMIT_CREATED",
                "CLOSURE_PUBLISHED",
            ]
            tag_local, tag_local_c = _local_tag_commit(root, plan.tag)
            if not (tag_local and tag_local_c == closure_commit):
                _create_tag(root, plan, closure_commit)
            _mark_stage(journal, "TAG_CREATED")
            stages.append("TAG_CREATED")
            post_tag_snapshot = _push_tag(root, plan, closure_commit)
            _mark_stage(journal, "TAG_PUBLISHED")
            stages.append("TAG_PUBLISHED")
        else:
            if plan.start_stage == START_PREPARED:
                # ---- content commit A --------------------------------------
                commit_result = _stage_and_commit(root, plan, journal)
                if not commit_result["ok"]:
                    try:
                        _restore_index(
                            root,
                            plan.pre_plan_index,
                            owned_post_stage_sha=_journal_owned_index_sha(journal),
                        )
                    except ValueError as exc:
                        # T-1007: an aborted `git commit` (e.g. a rejected
                        # pre-commit hook) rewrites the index file -- git
                        # stat-refreshes during the aborted attempt -- so the
                        # byte-exact ownership proof cannot match and the
                        # rollback refuses. The REAL reason the release
                        # stopped is the commit failure (the hook's stderr),
                        # which must stay visible in the refusal, never be
                        # masked by the index note.
                        detail = str(exc)
                        if commit_result.get("detail"):
                            detail = f"{commit_result['detail']} -- " + detail
                        return _release_failure("INDEX_RESTORE", detail)
                    return _release_failure(
                        commit_result.get("stage", "CONTENT_COMMIT"),
                        commit_result.get("detail", ""),
                    )
                content_commit = commit_result["commit"]
                _try_journal(journal, "update", content_commit=content_commit)
                _mark_stage(journal, "CONTENT_COMMIT_CREATED")
                stages.append("CONTENT_COMMIT_CREATED")
                _maybe_crash("CONTENT_COMMIT_CREATED")
                # ---- publish content ------------------------------------------
                _publish_branch(root, plan, content_commit, journal, "CONTENT_PUBLISHED")
                stages.append("CONTENT_PUBLISHED")
                _maybe_crash("CONTENT_PUBLISHED")
            else:  # START_CLOSURE: content A committed + pushed already
                content_commit = plan.source_head
                _try_journal(journal, "update", content_commit=content_commit)
                _mark_stage(journal, "CONTENT_COMMIT_CREATED")
                _mark_stage(journal, "CONTENT_PUBLISHED")
                stages += ["CONTENT_COMMIT_CREATED", "CONTENT_PUBLISHED"]

            # ---- canonical closure ---------------------------------------------
            _mark_stage(journal, "CLOSURE_PREPARED")
            stages.append("CLOSURE_PREPARED")
            _maybe_crash("CLOSURE_PREPARED")
            run_msg = f"ship v{plan.version} -> content commit {content_commit[:12]} pushed"
            digest = _release_digest(root, plan)
            _apply_finish_targets(root, journal, plan, digest, run_msg)
            _try_journal(journal, "update", release_stage="CLOSURE_PREPARED_DONE")
            # closure commit B
            closure_commit, _closure_tree = _commit_closure(root, plan, journal)
            _try_journal(journal, "update", closure_commit=closure_commit)
            _mark_stage(journal, "CLOSURE_COMMIT_CREATED")
            stages.append("CLOSURE_COMMIT_CREATED")
            _maybe_crash("CLOSURE_COMMIT_CREATED")

            # ---- publish closure -----------------------------------------------
            _publish_branch(root, plan, closure_commit, journal, "CLOSURE_PUBLISHED")
            stages.append("CLOSURE_PUBLISHED")
            _maybe_crash("CLOSURE_PUBLISHED")

            # ---- tag -------------------------------------------------------------
            _create_tag(root, plan, closure_commit)
            _mark_stage(journal, "TAG_CREATED")
            stages.append("TAG_CREATED")
            _maybe_crash("TAG_CREATED")
            post_tag_snapshot = _push_tag(root, plan, closure_commit)
            _mark_stage(journal, "TAG_PUBLISHED")
            stages.append("TAG_PUBLISHED")
            _maybe_crash("TAG_PUBLISHED")

        # ---- final verification -----------------------------------------------------
        # The post-tag snapshot is strictly after the final external write,
        # so it certifies the final branch+tag state with zero extra queries
        # (T-1004 remote: never reuse a PRE-push snapshot post-push).
        verified = _verify_release(root, plan, closure_commit, post_tag_snapshot)
        if not verified["ok"]:
            return _release_failure("REMOTE_VERIFIED", verified["detail"])
        _mark_stage(journal, "REMOTE_VERIFIED")
        stages.append("REMOTE_VERIFIED")
        _try_journal(journal, "mark", "VERIFIED")
        _try_journal(journal, "mark", "COMMITTED")
        _try_journal(journal, "update", release_stage="COMMITTED")
        cleanup_pending = _drop_settled_staged(journal)
    except ReleaseRefusal as exc:
        return _release_failure(
            _last_stage(stages), exc.detail, op_id=plan.op_id, stages_reached=stages
        )

    return {
        "ok": True,
        "code": "RELEASED",
        "stage": "COMMITTED",
        "stages_reached": stages,
        "op_id": plan.op_id,
        "commit": content_commit,
        "closure_commit": closure_commit,
        "tag": plan.tag,
        "branch": plan.branch,
        "detail": f"released v{plan.version}: content {content_commit[:12]} "
        f"-> closure {closure_commit[:12]} -> tag {plan.tag}",
        "cleanup_pending": cleanup_pending,
    }


def _last_stage(stages: list[str]) -> str:
    return stages[-1] if stages else "PREPARED"


_RELEASE_CRASH_MAP = {
    "CONTENT_COMMIT_CREATED": "SAIPEN_CRASH_AFTER_CONTENT_COMMIT",
    "CONTENT_STAGED": "SAIPEN_CRASH_AFTER_CONTENT_STAGED",
    "CONTENT_TREE_RECORDED": "SAIPEN_CRASH_AFTER_CONTENT_TREE",
    "CONTENT_PUBLISHED": "SAIPEN_CRASH_AFTER_CONTENT_PUBLISH",
    "CLOSURE_PREPARED": "SAIPEN_CRASH_AFTER_CLOSURE_PREPARE",
    "CLOSURE_COMMIT_CREATED": "SAIPEN_CRASH_AFTER_CLOSURE_COMMIT",
    "CLOSURE_TREE_RECORDED": "SAIPEN_CRASH_AFTER_CLOSURE_TREE",
    "CLOSURE_PUBLISHED": "SAIPEN_CRASH_AFTER_CLOSURE_PUBLISH",
    "TAG_CREATED": "SAIPEN_CRASH_AFTER_TAG_CREATE",
    "TAG_PUBLISHED": "SAIPEN_CRASH_AFTER_TAG_PUSH",
    "NO_PUBLISH_STARTED": "SAIPEN_CRASH_AFTER_NO_PUBLISH_START",
    "NO_PUBLISH_GATE": "SAIPEN_CRASH_AFTER_NO_PUBLISH_GATE",
}


def _maybe_crash(stage: str) -> None:
    """Process-death injection between release edges (T-994 / § 17).

    Mirrors the journal's NITRO_CRASH_* knobs: the test harness sets
    SAIPEN_CRASH_AFTER_<STAGE> and the process dies at exactly that edge so
    recovery has a real partial state to classify.
    """
    env_key = _RELEASE_CRASH_MAP.get(stage)
    if env_key and env_key in os.environ:
        sys.exit(86)


def _try_journal(journal, method: str, *args, **kwargs):
    """Journal writes are the recovery evidence: a failure is a hard stop."""
    try:
        getattr(journal, method)(*args, **kwargs)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise ReleaseRefusal(
            "RELEASE_FAILED", f"release journal write failed ({journal.manifest}): {exc}"
        )


def _mark_stage(journal, stage: str) -> None:
    _try_journal(
        journal,
        "update",
        release_stage=stage,
        stages=[*getattr(journal, "read")().get("stages", []), stage],
    )


# ---------------------------------------------------------------------------
# Stage helpers
# ---------------------------------------------------------------------------


def _stage_release_content(root: Path, plan: ReleasePlan) -> dict:
    """Stage ONLY the exact owned scope + release metadata paths.

    A reviewed DELETION scope entry (JSON null in the scope record) is staged
    with `git add -u` so the removal reaches the commit; every present path is
    staged exactly by name. Nothing else is ever staged.
    """
    present = [p for p in sorted(plan.release_paths) if (root / p).exists()]
    deleted = [p for p in sorted(plan.release_paths) if not (root / p).exists()]
    if present:
        result = _git(root, "add", "--", *present, literal=True)
        if not result.ok:
            return {"ok": False, "stage": "STAGING", "detail": result.stderr or result.stdout}
    if deleted:
        # `git add -u` stages a tracked path's deletion without touching
        # anything else; an untracked missing path is a scope mistake and the
        # command's failure is the refusal.
        result = _git(root, "add", "-u", "--", *deleted, literal=True)
        if not result.ok:
            return {"ok": False, "stage": "STAGING", "detail": result.stderr or result.stdout}
    return {"ok": True}


def _run_gate(root: Path, gate: str) -> dict:
    result = subprocess.run(
        [sys.executable, str(root / "tools" / "validate.py"), "--gate", gate],
        cwd=str(root),
        capture_output=True,
        text=True,
        errors="replace",
    )
    if result.returncode != 0:
        return {"ok": False, "detail": _format_gate_failure(result.stdout, result.stderr)}
    return {"ok": True}


def _verify_index_after_gate(root: Path, plan: ReleasePlan) -> dict:
    """The index must hold EXACTLY the pre-plan index plus the release scope:
    the gate must not have pulled in any path this release does not own."""
    index = _capture_index_state(root)

    pre_plan = set(plan.pre_plan_index.paths)
    release = set(plan.release_paths)
    release_paths = sorted(release)
    if release_paths:
        unstaged_result = _git(
            root, "diff", "--name-only", "-z", "--", *release_paths, literal=True
        )
        staged_result = _git(
            root,
            "diff",
            "--cached",
            "--name-only",
            "-z",
            "--",
            *release_paths,
            literal=True,
        )
        tracked_result = _git(root, "ls-files", "-z", "--", *release_paths, literal=True)
        if not (unstaged_result.ok and staged_result.ok and tracked_result.ok):
            return {
                "ok": False,
                "stage": "INDEX_DRIFT",
                "detail": "cannot batch-verify release index scope",
            }
        unstaged = {p for p in unstaged_result.stdout.split("\0") if p}
        staged = {p for p in staged_result.stdout.split("\0") if p}
        tracked = {p for p in tracked_result.stdout.split("\0") if p}
    else:
        unstaged, staged, tracked = set(), set(), set()

    def _clean_tracked(path: str) -> bool:
        return path not in unstaged and path not in staged and path in tracked

    # Foreign pre-plan staged paths must survive untouched; release-owned
    # paths must be in the index -- as staged changes, or already committed
    # clean. A release path that was staged at PLAN time and got normalized
    # by the release's own `git add` (an untracked carrier re-tracked with
    # identical bytes) is owned work, not drift: it never needs to stay in
    # the staged diff (T-1003).
    expected = (pre_plan - release) | {p for p in release if not _clean_tracked(p)}
    actual = set(index.paths)
    if actual != expected:
        extra = sorted(actual - expected)
        missing = sorted(expected - actual)
        return {
            "ok": False,
            "stage": "INDEX_DRIFT",
            "detail": (
                "index paths changed after ship gate"
                + (f" -- unexpected: {', '.join(extra)}" if extra else "")
                + (f" -- missing: {', '.join(missing)}" if missing else "")
            ),
        }
    return {"ok": True}


def _stage_and_commit(root: Path, plan: ReleasePlan, journal) -> dict:
    """Stage, gate, verify, commit -- the local content commit A.

    The intended tree is captured with `git write-tree` and PERSISTED to the
    release journal BEFORE `git commit` runs: arbitrary process death after
    the commit succeeds but before the commit-SHA receipt lands must still
    let recovery identify the just-created intended commit from the
    pre-recorded tree (an empty `content_commit` plus an unrecorded intended
    tree is indistinguishable from an unrelated HEAD). After the commit,
    HEAD^{tree} MUST equal the recorded intended tree. A hook or a concurrent
    git process that changes the selected tree is a refusal with zero
    publication, never "the reviewed release".
    """
    stage_result = _stage_release_content(root, plan)
    if not stage_result["ok"]:
        return stage_result
    # Capture the EXACT OWNED post-stage index SHA and journal it BEFORE the
    # CONTENT_STAGED crash point (hostile-regression): rollback can then
    # prove the live index is exactly the index THIS release staged -- and
    # refuse when it is not, so foreign staged changes always survive. The
    # journal write is atomic and durable before any crash can fire.
    try:
        owned_post_stage_sha, _ = _exact_index_bytes(root)
    except ValueError as exc:
        return {"ok": False, "stage": "INDEX_SNAPSHOT", "detail": str(exc)}
    _try_journal(journal, "update", owned_post_stage_index_sha256=owned_post_stage_sha)
    # Kill right after the release's own `git add` but before the content
    # commit: recovery must restore the EXACT pre-plan index snapshot from
    # journal evidence, never leave release staging behind (T-1003 exact
    # index rollback).
    _maybe_crash("CONTENT_STAGED")
    gate_result = _run_gate(root, "ship")
    if not gate_result["ok"]:
        return {"ok": False, "stage": "SHIP_GATE", "detail": gate_result["detail"]}
    idx_result = _verify_index_after_gate(root, plan)
    if not idx_result["ok"]:
        return idx_result
    diff = _git(root, "diff", "--cached", "--check")
    if not diff.ok:
        return {"ok": False, "stage": "DIFF_CHECK", "detail": diff.stdout or diff.stderr}
    intended_tree = _git(root, "write-tree")
    if not intended_tree.ok:
        return {
            "ok": False,
            "stage": "COMMIT",
            "detail": f"write-tree failed: {intended_tree.stderr}",
        }
    # Persist the intended tree BEFORE the commit so a kill right after the
    # commit can never leave recovery unable to name what was just created.
    _try_journal(journal, "update", intended_content_tree=intended_tree.stdout)
    commit = _git(root, "commit", "-m", plan.commit_message)
    if not commit.ok:
        return {"ok": False, "stage": "COMMIT", "detail": commit.stderr or commit.stdout}
    committed_tree = _git(root, "rev-parse", "HEAD^{tree}")
    if not committed_tree.ok or committed_tree.stdout != intended_tree.stdout:
        return {
            "ok": False,
            "stage": "TREE_MISMATCH",
            "detail": (
                f"committed tree "
                f"{committed_tree.stdout[:12] if committed_tree.ok else '?'} "
                f"!= intended tree {intended_tree.stdout[:12]} -- a hook "
                "or concurrent git changed the selected tree; NO push "
                "follows"
            ),
        }
    # Kill-after-commit window: the commit exists, the intended tree is
    # recorded, but the commit SHA has NOT been written to the journal yet.
    # Recovery must identify this commit from the pre-recorded tree and
    # continue idempotently (no duplicate commit).
    _maybe_crash("CONTENT_TREE_RECORDED")
    return {
        "ok": True,
        "commit": _git(root, "rev-parse", "HEAD").stdout,
        "tree": intended_tree.stdout,
    }


def _publish_branch(
    root: Path, plan: ReleasePlan, commit: str, journal, stage: str
) -> RemoteSnapshot:
    """Push the branch and REQUIRE the exact expected AFTER (query must
    succeed; an empty/missing query result is a refusal, never a pass).

    Verification uses a FRESH snapshot captured strictly after the push -- a
    pre-push snapshot can never certify a post-push state (T-1004 remote).
    The returned snapshot is the post-branch-push observation."""
    # W2-001: publish to the captured raw push endpoint, not the symbolic
    # `origin` alias which may have drifted after planning.
    result = _git(root, "push", plan.remote_push_endpoint or "origin", plan.branch)
    if not result.ok:
        raise ReleaseRefusal(
            "RELEASE_FAILED", f"branch push failed: {result.stderr or result.stdout}"
        )
    # Verification observes the PUSH endpoint the push just wrote, never the
    # unrelated fetch URL (T-1003 publication-remote split).
    post_snapshot = _remote_snapshot(root, plan.remote_push_endpoint or "origin")
    remote_ok, tip = post_snapshot.branch_tip(plan.branch)
    if not remote_ok:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            f"{stage}: remote verification query FAILED -- no evidence, never PASS",
        )
    if tip != commit:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            f"{stage}: remote tip {tip[:12] or '(none)'} != expected "
            f"{commit[:12]}; remote verification FAILED",
        )
    _try_journal(journal, "update", remote_old_tip=tip)
    _mark_stage(journal, stage)
    return post_snapshot


def _finish_targets(
    root: Path, plan: ReleasePlan, digest: str, run_msg: str, crew: bool = False
) -> list[dict]:
    """Build the ONE atomic closure plan: RUN event + finish event + BOARD +
    STATE + digest, all through the canonical SAIOPS planner. The journal
    carries a SINGLE LOG target whose after-bytes recovery can verify. A
    terminal CREW release (no ## DOING ticket) closes through
    _plan_crew_closure instead of the ordinary ticket closure."""
    import datetime

    now = datetime.datetime.now(datetime.timezone.utc).strftime("%d.%m.%y %H:%M")
    utc = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    from .operations import _plan_crew_closure

    if crew:
        finish = _plan_crew_closure(
            root,
            plan.current_agent or "saipen-cli",
            now,
            utc,
            digest_text=digest,
            prefix_run=run_msg,
        )
    else:
        finish = _plan_finish_ticket(
            root,
            plan.ticket_id,
            plan.current_agent or "saipen-cli",
            now,
            utc,
            digest_text=digest,
            prefix_run=run_msg,
        )
    if not hasattr(finish, "targets"):
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            f"closure finish could not be planned: {getattr(finish, 'message', '')}",
        )
    return [
        {
            "path": t.path,
            "role": t.role,
            "content": t.content,
            "before_hash": t.before_hash,
            "after_hash": t.after_hash,
        }
        for t in finish.targets
    ]


def _apply_finish_targets(
    root: Path, journal, plan: ReleasePlan, digest: str, run_msg: str
) -> None:
    targets = _finish_targets(root, plan, digest, run_msg, crew=plan.crew_closure)
    # W2-005: the release receipt is MANDATORY, not optional. Any failure
    # to construct it raises ReleaseRefusal before closure targets are applied.
    receipt_target = _release_receipt_target(root, plan)
    targets.append(receipt_target)
    # CORE-003: the cohort registry flips to `shipped` in the SAME journaled
    # closure that writes the release receipt. A separate write afterwards
    # would leave a crash window in which the batch is published but still
    # records itself as owing publication -- and the retry would publish twice.
    if plan.cohort_id:
        targets.append(_cohort_registry_target(root, plan))
    _apply_closure_targets(root, journal, targets)


def _cohort_registry_target(root: Path, plan: ReleasePlan) -> dict:
    """The durable cohort record, flipped to its exact release identity."""
    from . import closure as _closure

    try:
        registry = _closure.read_registry(root)
    except (OSError, ValueError) as exc:
        raise ReleaseRefusal(
            "RECEIPT_IO_FAILURE", f"cohort registry is unreadable: {exc}"
        ) from exc
    cohort = (registry.get("cohorts") or {}).get(plan.cohort_id)
    if cohort is None:
        raise ReleaseRefusal(
            "VALIDATION_FAILED",
            f"cohort {plan.cohort_id} vanished from the registry mid-publication",
        )
    commit = ""
    if plan.mode != "no-publish":
        head = _git(root, "rev-parse", "HEAD")
        commit = head.stdout if head.ok else ""
    cohort["publication_status"] = "shipped"
    cohort["release_op_id"] = plan.op_id
    cohort["version"] = plan.version
    cohort["tag"] = plan.tag
    cohort["commit"] = commit
    cohort["scope"] = sorted(dict(plan.crew_scope))
    content = _closure.render_registry(registry)
    path = root / ".saipen" / "kitchen" / "cohort_registry.json"
    doc = codec.read_document(path)
    return {
        "path": ".saipen/kitchen/cohort_registry.json",
        "role": "report",
        "content": doc.encode(content),
        "before_hash": doc.raw_hash if path.is_file() else "",
        "after_hash": _quick_hash(doc.encode(content)),
    }


def _release_receipt_target(root: Path, plan: ReleasePlan) -> dict:
    """The PUBLISHED structured release receipt target (items 20/26): a
    clone-visible closure artifact naming version, tag, ticket, source and
    mode so release continuation identity survives a fresh clone without ever
    reading LOG prose.

    W2-005: fail closed. Any inability to read/decode/preserve the receipt
    must raise a release refusal before closure targets are applied. Genuine
    file absence is the normal empty-document case; only actual I/O/error
    conditions block.
    """
    import datetime

    try:
        doc = codec.read_document(root / ".saipen" / "kitchen" / "release_receipt.json")
    except FileNotFoundError:
        # Genuine absence: codec.read_document already returns an empty
        # Document for a missing file, but guard anyway.
        from .codec import Document

        doc = Document(
            text="", encoding="utf-8", bom=b"", newline="\n", final_newline=False, raw_hash=""
        )
    except OSError as exc:
        raise ReleaseRefusal(
            "RECEIPT_IO_FAILURE",
            f"cannot read release_receipt.json: {type(exc).__name__}: {exc}",
        ) from exc
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    from .paths import project_lineage_identity

    content = (
        json.dumps(
            {
                "schema_version": 1,
                "operation": "release_receipt",
                "op_id": plan.op_id,
                "version": plan.version,
                "tag": plan.tag,
                "ticket_id": plan.ticket_id,
                "source_head": plan.source_head,
                "source_tree_fingerprint": plan.source_tree_fingerprint,
                "mode": plan.mode,
                "crew_epoch": plan.crew_epoch,
                "cohort_id": plan.cohort_id,
                "project_lineage": project_lineage_identity(root),
                "recorded_at": now,
            },
            indent=2,
        )
        + "\n"
    )
    path = root / ".saipen" / "kitchen" / "release_receipt.json"
    return {
        "path": ".saipen/kitchen/release_receipt.json",
        "role": "report",
        "content": doc.encode(content),
        "before_hash": doc.raw_hash if path.is_file() else "",
        "after_hash": _quick_hash(doc.encode(content)),
    }


def _apply_closure_targets(root: Path, journal, targets: list[dict]) -> None:
    """Append + apply closure targets THROUGH the release op journal.

    The three-way live-bytes decision routes through the ONE canonical
    classifier (T-1316, SRC-027 R001); no second inline copy of the rule.
    ReleaseRefusal codes and messages are unchanged."""
    from .journal import (
        TARGET_ALREADY_APPLIED,
        TARGET_CONFLICT,
        _atomic_write,
        classify_target,
        owned_target_path,
    )
    from .safeid import InvalidIdError

    try:
        for target in targets:
            owned_target_path(root, target["path"])
    except InvalidIdError as exc:
        raise ReleaseRefusal("VALIDATION_FAILED", f"closure target path escapes the project: {exc}")
    _try_journal(journal, "append_targets", targets)
    record = journal.read()
    start_index = len(record.get("targets", [])) - len(targets)
    for offset, target in enumerate(targets):
        index = start_index + offset
        live = _hash_file(root / target["path"])
        classification = classify_target(live, target["before_hash"], target["after_hash"])
        if classification == TARGET_ALREADY_APPLIED:
            _mark_target(journal, index)
            continue
        if classification == TARGET_CONFLICT:
            raise ReleaseRefusal(
                "RECOVERY_CONFLICT",
                f"closure target {target['path']} has unexpected live bytes "
                f"(live {live!r}); refuse to overwrite",
            )
        _atomic_write(root / target["path"], target["content"], ownership_root=root)
        if _hash_file(root / target["path"]) != target["after_hash"]:
            raise ReleaseRefusal(
                "RECOVERY_CONFLICT",
                f"closure target {target['path']} failed post-write verification",
            )
        _mark_target(journal, index)
    # Cross-file validation of the exact closure bytes.
    from .fast_check import validate_project

    errors = validate_project(root)
    if errors:
        raise ReleaseRefusal(
            "RECOVERY_CONFLICT", "closure bytes fail canonical validation: " + "; ".join(errors[:5])
        )


def _mark_target(journal, index: int) -> None:
    _try_journal(journal, "mark", "APPLYING", target_index=index)


def _commit_closure(root: Path, plan: ReleasePlan, journal) -> tuple[str, str]:
    """Stage ONLY the canonical closure files (+ sealed LOG segments),
    write-tree, commit B.

    The intended closure tree is persisted to the journal BEFORE the commit
    (kill-after-commit must let recovery identify commit B from the
    pre-recorded tree), and after the commit HEAD^{tree} MUST equal it."""
    add = _git(root, "add", "--", *_closure_stage_paths(root), literal=True)
    if not add.ok:
        raise ReleaseRefusal(
            "RELEASE_FAILED", f"closure staging failed: {add.stderr or add.stdout}"
        )
    tree = _git(root, "write-tree")
    if not tree.ok:
        raise ReleaseRefusal("RELEASE_FAILED", f"closure write-tree failed: {tree.stderr}")
    _try_journal(journal, "update", intended_closure_tree=tree.stdout)
    commit = _git(root, "commit", "-m", f"closure v{plan.version}: ticket {plan.ticket_id} DONE")
    if not commit.ok:
        raise ReleaseRefusal(
            "RELEASE_FAILED", f"closure commit failed: {commit.stderr or commit.stdout}"
        )
    committed_tree = _git(root, "rev-parse", "HEAD^{tree}")
    if not committed_tree.ok or committed_tree.stdout != tree.stdout:
        raise ReleaseRefusal(
            "TREE_MISMATCH", "closure committed tree != intended tree; NO push follows"
        )
    # Kill-after-commit window for closure B: same pre-recorded-tree contract
    # as content A -- recovery continues from the recorded intended tree.
    _maybe_crash("CLOSURE_TREE_RECORDED")
    return _git(root, "rev-parse", "HEAD").stdout, tree.stdout


def _create_tag(root: Path, plan: ReleasePlan, target: str) -> None:
    result = _git(root, "tag", "-a", plan.tag, "-m", plan.commit_message, target)
    if not result.ok:
        raise ReleaseRefusal(
            "RELEASE_FAILED", f"tag creation failed: {result.stderr or result.stdout}"
        )
    local_target = _git(root, "rev-parse", f"{plan.tag}^{{commit}}").stdout
    if local_target != target:
        raise ReleaseRefusal(
            "TAG_CONFLICT", f"tag {plan.tag} points at {local_target[:12]}, expected {target[:12]}"
        )


def _push_tag(root: Path, plan: ReleasePlan, target: str) -> RemoteSnapshot:
    """Push the tag and verify from a fresh post-push snapshot."""
    result = _git(
        root,
        "push",
        plan.remote_push_endpoint or "origin",
        f"refs/tags/{plan.tag}:refs/tags/{plan.tag}",
    )
    if not result.ok:
        raise ReleaseRefusal("RELEASE_FAILED", f"tag push failed: {result.stderr or result.stdout}")
    post_snapshot = _remote_snapshot(root, plan.remote_push_endpoint or "origin")
    _query_ok, remote_sha = post_snapshot.tag_commit(plan.tag)
    if not _query_ok:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            f"remote tag {plan.tag} query FAILED after push -- no evidence, never PASS",
        )
    if not remote_sha:
        raise ReleaseRefusal(
            "RELEASE_FAILED", f"remote tag {plan.tag} missing after push -- no evidence, never PASS"
        )
    if remote_sha != target:
        raise ReleaseRefusal(
            "RELEASE_FAILED",
            f"remote tag {plan.tag} points at {remote_sha[:12]}, expected {target[:12]}",
        )
    return post_snapshot


def _verify_release(
    root: Path, plan: ReleasePlan, closure_commit: str, post_snapshot: RemoteSnapshot | None = None
) -> dict:
    """Every VERIFIED stage requires the query to succeed AND exact equality
    with a non-empty witness. All queries target the captured PUSH endpoint
    (the destination publication actually writes), never the fetch URL.

    ``post_snapshot`` is the fresh snapshot captured AFTER the final external
    write (the tag push); when supplied it certifies both branch and tag in
    one already-strictly-after-the-write observation. Without it (standalone
    callers / recovery) a fresh snapshot is captured here."""
    endpoint = plan.remote_push_endpoint or "origin"
    snapshot = post_snapshot or _remote_snapshot(root, endpoint)
    remote_ok, tip = snapshot.branch_tip(plan.branch)
    if not remote_ok or not tip:
        return {
            "ok": False,
            "detail": "remote branch tip query failed or empty at final verification",
        }
    if tip != closure_commit:
        return {
            "ok": False,
            "detail": f"remote branch tip {tip[:12]} != closure {closure_commit[:12]}",
        }
    tag_ok, tag_sha = snapshot.tag_commit(plan.tag)
    if not tag_ok or not tag_sha:
        return {"ok": False, "detail": "remote tag query failed or empty at final verification"}
    if tag_sha != closure_commit:
        return {
            "ok": False,
            "detail": f"remote tag {tag_sha[:12]} != closure {closure_commit[:12]}",
        }
    return {"ok": True}


# ---------------------------------------------------------------------------
# Remote helpers (closed classification, T-994 / § 12)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RemoteSnapshot:
    """ONE canonical ls-remote capture of the publication endpoint.

    PLAN performs exactly one ls-remote and derives classification, branch
    tip, peeled tag and the full ref set from this single query; after EACH
    external push a FRESH snapshot is captured and used to verify that push.
    A snapshot is never reused across pushes: the post-push snapshot must be
    strictly newer than the external write it certifies (T-1004 remote).
    """

    query_ok: bool
    stderr: str
    refs: dict[str, str]  # refname -> sha, including ^{} peeled tag entries

    def classification(self) -> tuple[str, str]:
        """Closed classification over this capture (ABSENT/EMPTY/ESTABLISHED/
        UNAVAILABLE/AMBIGUOUS). UNAVAILABLE != EMPTY and UNKNOWN !=
        FIRST_PUBLISH; the same endpoint publication writes is the endpoint
        this capture observed."""
        if not self.query_ok:
            err = self.stderr.lower()
            if (
                "unable to access" in err
                or "authentication" in err
                or "permission denied" in err
                or "network is unreachable" in err
                or "couldn't resolve" in err
                or "could not resolve" in err
                or "connection" in err
                or "timed out" in err
                or "ssl" in err
                or "couldn't connect" in err
            ):
                return REMOTE_UNAVAILABLE, self.stderr
            if (
                "does not appear" in err
                or "could not read from remote" in err
                or "repository not found" in err
                or "not found" in err
            ):
                return REMOTE_ABSENT, self.stderr
            return REMOTE_UNAVAILABLE, self.stderr
        if not self.refs:
            return REMOTE_EMPTY, ""
        return REMOTE_ESTABLISHED, ""

    def branch_tip(self, branch: str) -> tuple[bool, str]:
        """(query_ok, tip_or_empty). Empty tip = query ok but branch absent."""
        if not self.query_ok:
            return False, ""
        return True, self.refs.get(f"refs/heads/{branch}", "")

    def tag_commit(self, tag: str) -> tuple[bool, str]:
        """(query_ok, tag_commit_or_empty). Empty = query ok but tag absent.
        Prefers the peeled ^{} entry (annotated tags), falling back to the
        raw tag ref for lightweight tags."""
        if not self.query_ok:
            return False, ""
        peeled = self.refs.get(f"refs/tags/{tag}^{{}}")
        if peeled:
            return True, peeled
        return True, self.refs.get(f"refs/tags/{tag}", "")


# PERF-003: bounded timeout for remote Git queries. A hung/blocking remote
# degrades to an unavailable verdict instead of hanging the verifier.
REMOTE_GIT_TIMEOUT = 30.0


def _remote_snapshot(root: Path, endpoint: str) -> RemoteSnapshot:
    """ONE ls-remote against the publication endpoint."""
    result = _git(root, "ls-remote", endpoint, timeout=REMOTE_GIT_TIMEOUT)
    refs: dict[str, str] = {}
    if result.ok:
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                refs[parts[1]] = parts[0]
    return RemoteSnapshot(result.ok, result.stderr, refs)


def _push_endpoint(root: Path) -> str:
    """The ONE live raw push endpoint publication actually uses.

    `git remote get-url --push origin` returns the configured pushurl, or the
    fetch URL when no pushurl is set -- exactly the destination `git push
    origin` will hit. Publication must query THIS endpoint for every remote
    fact (branch tip, tag, verification), never the fetch URL: with a split
    fetch=A / pushurl=B setup, reading A while writing B both fails the
    post-push proof and, worse, can verify a DIFFERENT repository as if it
    were the published one (T-1003 publication-remote split)."""
    result = _git(root, "remote", "get-url", "--push", "origin")
    if not result.ok or not result.stdout:
        return ""
    return result.stdout.splitlines()[0]


def _classify_remote(root: Path) -> tuple[str, str]:
    """Classify the PUBLICATION endpoint (push destination) into the closed
    set ABSENT/EMPTY/ESTABLISHED/UNAVAILABLE/AMBIGUOUS. UNAVAILABLE != EMPTY
    and UNKNOWN != FIRST_PUBLISH. Classification and every later verification
    must observe the same endpoint publication actually writes (T-1003
    publication-remote split: a fetch URL is not evidence about the push
    destination).

    Kept as a thin ONE-snapshot wrapper for callers that only need the
    classification; plan/apply/recovery capture a RemoteSnapshot once and
    derive classification + branch tip + tag + refs from that single query.
    """
    origin = _git(root, "remote", "get-url", "--push", "origin")
    if not origin.ok or not origin.stdout:
        return REMOTE_ABSENT, "no push endpoint configured"
    return _remote_snapshot(root, origin.stdout.splitlines()[0]).classification()


def _remote_branch_tip(root: Path, remote: str, branch: str) -> tuple[bool, str]:
    """(query_ok, tip_or_empty). tip empty means query ok but branch absent.
    `remote` is the publication endpoint (a push URL or remote name) -- every
    caller passes the captured push endpoint so verification observes the
    same destination publication writes. Thin wrapper over one ls-remote
    capture for the few standalone callers; hot paths pass a RemoteSnapshot.
    """
    return _remote_snapshot(root, remote).branch_tip(branch)


def _remote_tag_commit(root: Path, remote: str, tag: str) -> tuple[bool, str]:
    """(query_ok, tag_commit_or_empty). Empty means query ok but tag absent.
    `remote` is the publication endpoint (push URL or remote name) -- the tag
    must be classified against the same destination the push writes. Thin
    wrapper over one ls-remote capture; hot paths pass a RemoteSnapshot."""
    return _remote_snapshot(root, remote).tag_commit(tag)


def _local_tag_commit(root: Path, tag: str) -> tuple[bool, str]:
    rc = _git(root, "rev-parse", "--verify", "--quiet", tag).rc
    if rc != 0:
        return False, ""
    return True, _git(root, "rev-parse", f"{tag}^{{commit}}").stdout


def _snapshot_remote_refs(root: Path, remote: str) -> dict:
    return _remote_snapshot(root, remote).refs


def _push_urls(root: Path) -> list[str]:
    result = _git(root, "remote", "get-url", "--push", "--all", "origin")
    if not result.ok or not result.stdout:
        return []
    return [_sanitize_push_url(u) for u in result.stdout.splitlines() if u.strip()]


def _sanitize_push_url(url: str) -> str:
    url = url.strip()
    if "://" in url:
        scheme, rest = url.split("://", 1)
        rest = rest.split("@", 1)[-1]
        return f"{scheme}://{rest.replace(chr(92), '/')}"
    if "@" in url:
        return url.split("@", 1)[-1].replace(chr(92), "/")
    return url.replace(chr(92), "/")


def _head_relation(root: Path, remote_tip: str) -> str:
    if not remote_tip:
        return "no-remote-tip"
    head = _git(root, "rev-parse", "HEAD").stdout
    if head == remote_tip:
        return "equal"
    anc = _git(root, "merge-base", "--is-ancestor", head, remote_tip)
    if anc.ok:
        return "behind"
    anc2 = _git(root, "merge-base", "--is-ancestor", remote_tip, head)
    if anc2.ok:
        return "ahead"
    return "diverged"


# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------


def _git(root: Path, *args: str, literal: bool = False, timeout: float | None = None) -> GitResult:
    env = None
    if literal:
        env = {**os.environ, "GIT_LITERAL_PATHSPECS": "1"}
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        # PERF-003: a hung/blocking remote Git must degrade to an unavailable
        # verdict, never hang the verifier or fabricate a PASS. Callers map
        # query_ok=False -> unknown.
        return GitResult(
            124,
            "",
            f"git {' '.join(args)} timed out after {timeout}s",
        )
    return GitResult(result.returncode, result.stdout.strip(), result.stderr.strip())


def _git_object_count(root: Path) -> int:
    """Stable machine-output object count for zero-write verification.

    `git count-objects` human text varies ("790 objects, 5276 kilobytes");
    `count-objects -v` emits stable `count:` / `in-pack:` keys covering both
    loose objects and packed objects.
    """
    result = _git(root, "count-objects", "-v")
    count = 0
    import contextlib

    for line in result.stdout.splitlines():
        key, _, value = line.partition(":")
        if key.strip() in ("count", "in-pack"):
            with contextlib.suppress(ValueError):
                count += int(value.strip())
    return count


def _active_work(root: Path) -> str | None:
    """The ticket the project is working on: STATE.task, held in ## DOING."""
    try:
        _text, state = _read_state(root)
        _text, board = _read_board(root)
    except (OSError, ValueError, EngineError, ReleaseRefusal):
        return None
    task = str(state.get("task") or "").strip()
    ticket = board.get("tickets", {}).get(task)
    return task if ticket and ticket.get("section") == "## DOING" else None


def _installed_version(root: Path) -> str:
    version = root / "VERSION"
    if not version.is_file():
        # T-1377: measured in three field sessions -- a model finishing ordinary
        # work reached for `saipen ship`, was told a file is missing, and asked
        # again. `ship` publishes a versioned release of a repository that HAS a
        # VERSION; an ordinary project closes its Work instead, and the refusal
        # says which command that is.
        # T-1380: the machine route names the ACTIVE ticket. `<T-###>` typed into
        # PowerShell is a redirection error, and with no active Work there is
        # nothing to close, so no route is printed at all.
        ticket = _active_work(root)
        raise ReleaseRefusal(
            "VALIDATION_FAILED",
            "VERSION is missing from the repository root: `saipen ship` publishes a "
            "versioned release and does not apply to a project without one. To close "
            "finished Work run: saipen ticket done <T-###> --closure-mode own_patch",
            next_command=(
                f"saipen ticket done {ticket} --closure-mode own_patch" if ticket else None
            ),
        )
    return version.read_text(encoding="utf-8-sig").strip().split("\n")[0]


def _branch(root: Path) -> str:
    result = _git(root, "branch", "--show-current")
    if not result.ok or not result.stdout:
        raise ReleaseRefusal("STALE_PLAN", "cannot determine the current branch")
    return result.stdout


def _branch_exists(root: Path, branch: str) -> bool:
    rc = _git(root, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}").rc
    return rc == 0


def _snapshot_worktree(root: Path, paths: tuple[str, ...]) -> dict:
    hashes: dict[str, str] = {}
    for p in paths:
        fp = root / p
        if fp.is_file():
            hashes[p] = _quick_hash(fp.read_bytes())
        else:
            hashes[p] = ""
    return hashes


def _snapshot_all_refs(root: Path) -> dict:
    result = _git(root, "show-ref")
    refs: dict[str, str] = {}
    if result.ok:
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                refs[parts[1]] = parts[0]
    return refs


def _quick_hash(text: str) -> str:
    if isinstance(text, bytes):
        return hashlib.sha256(text).hexdigest()[:16]
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _hash_file(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]
    except OSError:
        return ""


def _hex8() -> str:
    import uuid

    return uuid.uuid4().hex


def _format_gate_failure(stdout: str, stderr: str) -> str:
    lines = (stdout + "\n" + stderr).splitlines()
    fail_lines = [ln for ln in lines if ln.startswith("FAIL")]
    if fail_lines:
        return " | ".join(fail_lines[:3])
    tail = (stdout + stderr)[-500:].strip()
    return tail or "gate failed (no detail)"


# ---------------------------------------------------------------------------
# Version parity / metadata
# ---------------------------------------------------------------------------


def _metadata_paths(
    root: Path, source_paths: list[Path] | None = None
) -> list[str]:
    from .release_contract import release_metadata_paths

    if source_paths is None:
        return [p.as_posix() for p in release_metadata_paths(root)]
    # PERF-006: caller already captured source_authority_paths(root) once;
    # splice the captured list in instead of re-querying Git + rglob.
    return [
        p.as_posix()
        for p in (*release_metadata_paths(root, source_paths=source_paths),)
    ]


def _source_authority_manifest(
    root: Path, source_paths: list[Path] | None = None
) -> tuple[tuple[str, str], ...]:
    """Canonical path/content snapshot for active and archived source authority."""
    from .release_contract import source_authority_paths

    if source_paths is None:
        source_paths = source_authority_paths(root)
    manifest = []
    for path in source_paths:
        rel = path.as_posix()
        target = root / path
        digest = (
            hashlib.sha256(target.read_bytes()).hexdigest()
            if target.is_file()
            else "<missing>"
        )
        manifest.append((rel, digest))
    return tuple(manifest)


def _check_source_authority_manifest(root: Path, plan: ReleasePlan) -> str | None:
    expected = tuple(sorted(plan.source_manifest))
    actual = _source_authority_manifest(root)
    if actual != expected:
        return (
            "source authority manifest changed since plan: "
            f"planned {len(expected)} entries, live {len(actual)}"
        )
    return None


def _check_parity(root: Path, version: str) -> None:

    from .release_contract import version_badges as _version_badges
    from .release_contract import version_metadata_paths

    problems: list[str] = []
    if _installed_version(root) != version:
        problems.append("VERSION does not read the release version")
    for rel in (path.as_posix() for path in version_metadata_paths(root)):
        if Path(rel).name == "VERSION":
            continue
        fp = root / rel
        if not fp.is_file():
            problems.append(f"{rel} is missing")
            continue
        if rel == ".saipen/IDENTITY.md":
            # The portable identity carrier is part of the release surface
            # (it must be tracked + clone-stable) but carries no version
            # badge; its syntax is validated separately.
            continue
        if Path(rel).name == "CHANGELOG.md":
            text = fp.read_text(encoding="utf-8-sig")
            heads = re.findall(r"(?m)^## (\d+\.\d+\.\d+)", text)
            if heads[:1] != [version]:
                problems.append(f"{rel} head entry must be ## {version}")
            continue
        badges = _version_badges(fp)
        if len(badges) != 1 or badges[0] != f"**v{version}**":
            problems.append(f"{rel} must carry **v{version}** exactly once")
    if problems:
        raise ReleaseRefusal(
            "VALIDATION_FAILED", "release version parity unmet:\n- " + "\n- ".join(problems[:8])
        )


# ---------------------------------------------------------------------------
# Mode reader (fails closed, T-994 / § 9)
# ---------------------------------------------------------------------------


def _read_mode(state: dict, current_capability: str | None = None) -> str:
    """The PUBLISH policy of this release.

    P0#4: when the command boundary negotiated a CURRENT-SESSION capability it
    is the ONLY authority -- a persisted `STATE.mode` is the last handshake
    outcome and must never grant current publish authority (a stale `full` may
    not publish from a newly `no-publish` session, and a stale `no-publish` may
    not suppress a session that really is `full`). Only an internal/legacy call
    with no negotiated capability falls back to the persisted policy, and that
    fallback still fails closed on anything outside full/no-publish.
    """
    mode = state.get("mode") if current_capability is None else current_capability
    if mode == "full":
        return "full"
    if mode == "no-publish":
        return "no-publish"
    source = "persisted STATE.mode" if current_capability is None else "current session capability"
    raise ReleaseRefusal(
        "VALIDATION_FAILED",
        f"unknown release mode {mode!r} from {source} -- an invalid policy "
        "must never become permission to publish; a release needs full or "
        "no-publish",
    )


# ---------------------------------------------------------------------------
# STATE / BOARD / LOG readers
# ---------------------------------------------------------------------------


def _read_state(root: Path) -> tuple[str, dict]:
    state_path = root / ".saipen" / "STATE.md"
    if not state_path.is_file():
        raise ReleaseRefusal("VALIDATION_FAILED", "STATE.md is missing")
    text = codec.read_doc(state_path)
    state = parse_state(text)
    if not state:
        raise ReleaseRefusal("VALIDATION_FAILED", "STATE.md has no parseable frontmatter")
    return text, state


def _read_board(root: Path) -> tuple[str, dict]:
    from .board import parse_board

    board_path = root / ".saipen" / "BOARD.md"
    if not board_path.is_file():
        raise ReleaseRefusal("VALIDATION_FAILED", "BOARD.md is missing")
    text = codec.read_doc(board_path)
    board = parse_board(text)
    return text, board


def _log_hash(root: Path) -> str:
    from .log import history_hash

    return history_hash(root)


def _find_ticket(board: dict, task: str | None) -> dict | None:
    if not task or task == "none":
        return None
    tickets = board.get("tickets", {})
    for t in tickets.values():
        if t["id"] == task and t["section"] == "## DOING":
            return t
    return None


def _top_todo(root: Path) -> str:
    import contextlib

    with contextlib.suppress(OSError, ValueError):
        from .board import parse_board

        board = parse_board(codec.read_doc(root / ".saipen" / "BOARD.md"))
        for t in board["tickets"].values():
            if t["section"] == "## TODO":
                return t["id"]
    return "nothing"


def _release_digest(root: Path, plan: ReleasePlan) -> str:
    top = _top_todo(root)
    return (
        f"done: ship v{plan.version} (content -> closure, tag {plan.tag})\n"
        f"remaining: {top}\n"
        f"awaiting: nothing\n"
    )


# ---------------------------------------------------------------------------
# Recovery (T-994 / § 3, § 11, § 17, § 18): classifies every external fact.
# ---------------------------------------------------------------------------


def recover_release_op(project_root: Path | str, op_id: str) -> dict:
    """Recover a release operation under the canonical project writer lock.

    Release recovery is a mutating writer (it replays closure targets and can
    create commits/pushes/tags), so the public entry acquires the lock; the
    locked body is `_recover_release_op_locked`, which journal recovery (also
    lock-held) calls directly without re-acquiring (T-1003 recovery
    serialization). Never blindly redoes an external side effect: each git
    fact is classified expected-BEFORE / expected-AFTER / THIRD STATE
    (CONFLICT) against the journal's recorded expectations.

    Unresolvable remote state is UNKNOWN and stops recovery as CONFLICT --
    UNKNOWN is never treated as PASS.
    """
    root = Path(project_root)
    from .lock import project_writer_lock as _recover_lock

    try:
        with _recover_lock(root):
            return _recover_release_op_locked(root, op_id)
    except PermissionError:
        return {
            "ok": False,
            "code": "WRITER_BUSY",
            "op_id": op_id,
            "detail": "another live writer holds the project lock; retry after it releases",
        }


def _recover_release_op_locked(root: Path, op_id: str) -> dict:
    """The lock-held body of release recovery. Called only under the project
    writer lock (public `recover_release_op` or journal recovery dispatch)."""
    from .journal import Journal, _hash_file as _jh  # noqa: F401

    journal = Journal(root, op_id)
    if not journal.exists():
        return {"ok": False, "code": "TICKET_NOT_FOUND", "op_id": op_id}
    record = journal.read()
    status = record.get("status")
    release_stage = record.get("release_stage")
    if status == "COMMITTED" and release_stage == "COMMITTED":
        # W2-003: ONE coherent durable transition. ALREADY_APPLIED is only
        # admissible when BOTH the generic terminal status AND the release-
        # specific stage are COMMITTED. A split truth (generic COMMITTED but
        # the release stage never reached COMMITTED) is a partial/contradictory
        # state that must be finished or resolved explicitly -- never silently
        # treated as fully applied.
        return {"ok": True, "code": "ALREADY_APPLIED", "op_id": op_id}
    if status == "COMMITTED":
        # Split terminal truth: generic COMMITTED without release_stage
        # COMMITTED is NOT admissible as ALREADY_APPLIED.
        return {
            "ok": False,
            "code": "RELEASE_STAGE_INCOMPLETE",
            "op_id": op_id,
            "recovery_required": True,
            "detail": f"release op status is COMMITTED but release_stage is "
            f"{release_stage!r}; finish the release or resolve it explicitly "
            "before retrying recovery",
        }
    if status in ("CONFLICT", "ABORTED", "RESOLVED"):
        return {
            "ok": False,
            "code": status,
            "op_id": op_id,
            "recovery_required": True,
            "detail": f"release op is {status}; resolve explicitly before further mutation",
        }

    if not _validate_record(record):
        _try_recovery_journal(journal, "mark", "CONFLICT")
        return {
            "ok": False,
            "code": "CONFLICT",
            "op_id": op_id,
            "recovery_required": True,
            "detail": "release op record is corrupt or incomplete; "
            "preserve evidence and resolve explicitly",
        }

    mode = record.get("mode")
    if mode == "no-publish":
        return _recover_no_publish(root, journal, record)

    try:
        return _recover_release_git(root, journal, record)
    except ReleaseRefusal as exc:
        _try_recovery_journal(journal, "mark", "CONFLICT")
        return {
            "ok": False,
            "code": "CONFLICT",
            "op_id": op_id,
            "recovery_required": True,
            "detail": exc.detail,
        }


def _validate_record(record: dict) -> bool:
    required = (
        "version",
        "branch",
        "tag",
        "ticket_id",
        "source_head",
        "remote_push_url",
        "scope_paths",
        "metadata_paths",
    )
    return all(key in record for key in required)


def _try_recovery_journal(journal, method: str, *args, **kwargs) -> None:
    import contextlib

    with contextlib.suppress(OSError):
        # the conflict evidence is already being preserved
        getattr(journal, method)(*args, **kwargs)


def _restore_index_from_record(root: Path, record: dict) -> None:
    """Restore the exact pre-plan index from release journal evidence,
    OWNER-SAFE (hostile-regression).

    The journal carries the base64 index bytes captured at plan time (before
    any index mutation) and -- since the CONTENT_STAGED fix -- the owned
    post-stage index SHA captured right after the release's own staging. The
    live index is restored ONLY when it is provably the release's own
    staging: already exactly pre-plan (no-op) or matching the journaled
    owned post-stage SHA. Anything else (foreign staged changes) is a
    ValueError refusal that preserves the live index. A foreign index.lock is
    a hard refusal (WRITER_BUSY). Zero bytes (git-less no-publish) is a
    no-op."""
    b64 = record.get("pre_index_b64") or ""
    if not b64:
        return
    try:
        pre_sha = hashlib.sha256(base64.b64decode(b64.encode("ascii"))).hexdigest()
    except (ValueError, TypeError) as exc:
        raise ValueError(f"journal pre-index bytes are not valid base64: {exc}")
    loc = _git(root, "rev-parse", "--git-path", "index")
    if not loc.ok or not loc.stdout:
        raise ValueError("cannot locate the git index file; index restoration refused")
    index_path = Path(loc.stdout)
    if not index_path.is_absolute():
        index_path = root / index_path
    index_path = index_path.resolve()
    try:
        live_sha, _ = _exact_index_bytes(root)
    except ValueError as exc:
        raise ValueError(f"cannot prove the live index identity: {exc}")
    if live_sha == pre_sha:
        return
    owned = record.get("owned_post_stage_index_sha256") or ""
    if isinstance(owned, str) and owned and live_sha == owned:
        _restore_index_bytes(root, b64, expected_live_sha=owned)
        return
    raise ValueError(
        "live index is neither the pre-plan index nor the journaled owned "
        "post-stage index; foreign staged changes would be destroyed -- "
        "preserve the live index and resolve explicitly "
        "(CONFLICT/RECOVERY_REQUIRED)"
    )


def _recover_no_publish(root: Path, journal, record: dict) -> dict:
    """no-publish recovery: replay any unapplied closure targets, verify,
    COMMITTED. No git facts exist to classify.

    A PREPARED no-publish op with NO applied closure target never began: the
    journal was created (Journal.start) and possibly the local gate ran, but
    no canonical byte changed. Marking it COMMITTED would fabricate a
    successful release completion out of a crash-before-body -- the journal's
    own rule for a PREPARED op with nothing applied is ABORTED, and the
    no-publish path must mirror it (T-1003 release recovery)."""
    targets = record.get("targets", [])
    if not any(t.get("applied") for t in targets):
        _try_recovery_journal(journal, "mark", "ABORTED")
        _try_recovery_journal(journal, "update", release_stage="ABORTED")
        return {
            "ok": True,
            "code": "ABORTED",
            "op_id": record["op_id"],
            "detail": "no-publish release never began (no closure target applied); aborted",
        }
    replay_error = _replay_targets(root, journal, record)
    if replay_error:
        _try_recovery_journal(journal, "mark", "CONFLICT")
        return {
            "ok": False,
            "code": "CONFLICT",
            "op_id": record["op_id"],
            "recovery_required": True,
            "detail": replay_error,
        }
    _try_recovery_journal(journal, "mark", "VERIFIED")
    _try_recovery_journal(journal, "mark", "COMMITTED")
    _try_recovery_journal(journal, "update", release_stage="COMMITTED")
    cleanup_pending = _drop_settled_staged(journal)
    result = {
        "ok": True,
        "code": "COMMITTED",
        "op_id": record["op_id"],
        "changed_files": [t["path"] for t in record.get("targets", [])],
        "recovery_required": True,
    }
    if cleanup_pending:
        result["cleanup_pending"] = cleanup_pending
    return result


def _replay_targets(root: Path, journal, record: dict) -> str | None:
    """Replay unapplied journal targets through the ONE canonical three-way
    classifier (T-1316). Returns the first conflict detail or None when every
    target is settled."""
    from .journal import (
        _atomic_write,
        TARGET_ALREADY_APPLIED,
        TARGET_CONFLICT,
        classify_target,
        owned_target_path,
    )
    from .safeid import InvalidIdError

    targets = record.get("targets", [])
    try:
        for target in targets:
            owned_target_path(root, target["path"])
    except InvalidIdError as exc:
        return f"journal target path escapes the project: {exc}"
    classifications = [
        classify_target(
            _hash_file(root / target["path"]), target["before_hash"], target["after_hash"]
        )
        for target in targets
    ]
    prefix_len = len(targets)
    for index, classification in enumerate(classifications):
        if classification != TARGET_ALREADY_APPLIED:
            prefix_len = index
            break
    for index, classification in enumerate(classifications):
        target = targets[index]
        if classification == TARGET_CONFLICT:
            return (
                f"unfinished target {target['path']} has unexpected bytes "
                f"(live {_hash_file(root / target['path'])!r}; before "
                f"{target['before_hash']!r}, after "
                f"{target['after_hash']!r}); refuse to guess"
            )
        if index >= prefix_len and classification == TARGET_ALREADY_APPLIED:
            return (
                f"target {target['path']} materialized out of order "
                f"(before-hash target at index {prefix_len - 1} precedes it); "
                "non-prefix materialization is not a legal crash shape for "
                "ordered mutation plans; refuse to guess"
            )
    if prefix_len and any(not targets[i].get("applied") for i in range(prefix_len)):
        # Repair stale journal markers for the materialized prefix through the
        # canonical journal writer (T-1316 Phase 3): idempotent on re-entry.
        _mark_target(journal, prefix_len - 1)
    for index in range(prefix_len, len(targets)):
        target = targets[index]
        # classifications[index] is TARGET_PENDING here: live bytes equal
        # before_hash, so the planned replay is exactly the original plan and
        # the materialized prefix is never rewritten (T-1316 Phase 5).
        staged = journal.staged_content(index, record)
        if hashlib.sha256(staged).hexdigest()[:16] != target["after_hash"]:
            return (
                f"staged bytes for {target['path']} do not match the "
                "planned after hash; journal evidence is corrupt"
            )
        _atomic_write(root / target["path"], staged, ownership_root=root)
        _mark_target(journal, index)
    return None


def _recover_release_git(root: Path, journal, record: dict) -> dict:
    """Classify every external fact and resume from the first missing one.
    Each git fact is expected-BEFORE / expected-AFTER / THIRD STATE (CONFLICT);
    a missing stage is resumed, never blindly repeated."""
    op_id = record["op_id"]
    version = record["version"]
    branch = record["branch"]
    tag = record["tag"]
    ticket_id = record["ticket_id"]
    source_head = record["source_head"]
    old_tip = record.get("remote_old_tip") or ""
    recorded_a = record.get("content_commit") or ""
    recorded_b = record.get("closure_commit") or ""

    head = _git(root, "rev-parse", "HEAD").stdout

    # ---- 0. read-only recovery preflight: re-bind branch + push endpoint --
    # Before ANY local git mutation (commit/stage/tag), the live world must
    # still be the world the crash-left record decided against. (a) When a
    # commit could still be created, the current branch MUST equal the
    # recorded branch -- recovery creating the closure on a different branch
    # leaves the recorded branch unpublished and silently mints commits on
    # the wrong ref. (b) The live single push endpoint identity MUST equal
    # the recorded destination -- changing origin.pushurl after a crash must
    # not redirect resumed publication into a different repository. Both are
    # read-only checks; a mismatch is CONFLICT with zero index/commit/tag/
    # push mutation (T-1003 recovery re-bind).
    if not recorded_a or not recorded_b:
        live_branch = _branch(root)
        if live_branch != branch:
            return _conflict(
                journal,
                op_id,
                f"current branch {live_branch!r} != recorded branch "
                f"{branch!r}; refuse to create commits on the wrong branch -- "
                "checkout the recorded branch and retry",
            )
    live_endpoint = _push_endpoint(root)
    recorded_push_url = record.get("remote_push_url") or ""
    if (
        recorded_push_url
        and live_endpoint
        and _sanitize_push_url(live_endpoint) != recorded_push_url
    ):
        return _conflict(
            journal,
            op_id,
            f"live push endpoint "
            f"{_sanitize_push_url(live_endpoint)!r} != recorded "
            f"{recorded_push_url!r}; resumed publication would reach a "
            "different repository -- restore the recorded push destination "
            "and retry",
        )

    # ---- 1. content commit A ----------------------------------------------
    if recorded_a:
        if not _is_ancestor(root, recorded_a, head):
            return _conflict(
                journal,
                op_id,
                f"recorded content commit {recorded_a[:12]} is "
                "not an ancestor of HEAD; refuse to guess",
            )
        content_commit = recorded_a
    else:
        if head == source_head:
            if not any(t.get("applied") for t in record.get("targets", [])):
                # Pre-commit abort: the crash may have left the release's
                # own `git add` staging in the index (crash after staging
                # but before the content commit). Restore the EXACT pre-plan
                # index snapshot from the journal evidence so the abort
                # leaves zero release staging behind (T-1003 exact index
                # snapshot). Owner-safe: foreign staged changes or a foreign
                # index.lock refuse instead of being destroyed (T-1006).
                try:
                    _restore_index_from_record(root, record)
                except ValueError as exc:
                    return _conflict(journal, op_id, str(exc))
                _try_recovery_journal(journal, "mark", "ABORTED")
                _try_recovery_journal(journal, "update", release_stage="ABORTED")
                return {
                    "ok": True,
                    "code": "ABORTED",
                    "op_id": op_id,
                    "detail": "release never began; aborted",
                }
            return _conflict(
                journal,
                op_id,
                "release has applied closure targets but no content commit; refuse to guess",
            )
        intended = record.get("intended_content_tree") or ""
        if intended and _git(root, "rev-parse", "HEAD^{tree}").stdout == intended:
            content_commit = head
            _try_recovery_journal(journal, "update", content_commit=head)
        else:
            return _conflict(
                journal,
                op_id,
                f"HEAD moved from {source_head[:12]} but no recorded content "
                "commit matches; refuse to guess",
            )
    _try_recovery_journal(journal, "update", release_stage="CONTENT_COMMIT_CREATED")

    # ---- 2. closure targets (canonical bytes) ------------------------------
    replay_error = _replay_targets(root, journal, record)
    if replay_error:
        return _conflict(journal, op_id, replay_error)
    from .fast_check import validate_project

    v_errors = validate_project(root)
    if v_errors:
        return _conflict(
            journal,
            op_id,
            "recovered closure bytes fail canonical validation: " + "; ".join(v_errors[:5]),
        )

    # ---- 3. closure commit B ------------------------------------------------
    _state_text, state = _read_state(root)
    canonical_closed = (
        state.get("phase") == "DONE"
        and state.get("task") in (None, "none")
        and _ticket_done(root, ticket_id)
    )
    if recorded_b:
        if not _is_ancestor(root, recorded_b, head):
            return _conflict(
                journal,
                op_id,
                f"recorded closure commit {recorded_b[:12]} is not an ancestor of HEAD",
            )
        closure_commit = recorded_b
    elif canonical_closed and head != source_head:
        intended_b = record.get("intended_closure_tree") or ""
        if intended_b and _git(root, "rev-parse", "HEAD^{tree}").stdout == intended_b:
            closure_commit = head
            _try_recovery_journal(journal, "update", closure_commit=head)
        else:
            return _conflict(
                journal,
                op_id,
                "canonical state is DONE but HEAD tree does not match the "
                "recorded closure tree; refuse to guess",
            )
    else:
        if head not in (source_head, content_commit):
            return _conflict(
                journal, op_id, "HEAD is an unexpected intermediate commit; refuse to guess"
            )
        add = _git(root, "add", "--", *_closure_stage_paths(root), literal=True)
        if not add.ok:
            return _conflict(journal, op_id, f"closure staging failed: {add.stderr or add.stdout}")
        tree = _git(root, "write-tree")
        if not tree.ok:
            return _conflict(journal, op_id, f"closure write-tree failed: {tree.stderr}")
        intended_b = record.get("intended_closure_tree") or ""
        if intended_b and tree.stdout != intended_b:
            return _conflict(
                journal, op_id, "live closure tree differs from the recorded intended closure tree"
            )
        commit = _git(root, "commit", "-m", f"closure v{version}: ticket {ticket_id} DONE")
        if not commit.ok:
            return _conflict(
                journal, op_id, f"closure commit failed: {commit.stderr or commit.stdout}"
            )
        closure_commit = _git(root, "rev-parse", "HEAD").stdout
        _try_recovery_journal(
            journal, "update", closure_commit=closure_commit, intended_closure_tree=tree.stdout
        )
    _try_recovery_journal(journal, "update", release_stage="CLOSURE_COMMIT_CREATED")

    # ---- 4. publish the branch (content and/or closure) -----------------------
    # Publication and verification observe the SAME endpoint the recorded
    # push destination names -- with a split fetch/pushurl, the recorded push
    # endpoint is the only truth about what a crash-left release wrote.
    endpoint = record.get("remote_push_endpoint") or "origin"
    remote_ok, tip = _remote_branch_tip(root, endpoint, branch)
    if not remote_ok:
        return _unavailable(journal, op_id, "remote branch tip query failed during recovery")
    if tip == closure_commit:
        pass  # already published
    elif tip in (content_commit, old_tip, ""):
        push = _git(root, "push", endpoint, branch)
        if not push.ok:
            return _conflict(
                journal, op_id, f"branch push failed during recovery: {push.stderr or push.stdout}"
            )
        remote_ok, tip = _remote_branch_tip(root, endpoint, branch)
        if not remote_ok or tip != closure_commit:
            return _unavailable(
                journal,
                op_id,
                "post-push verification could not prove the branch tip == closure commit",
            )
        _try_recovery_journal(journal, "update", remote_old_tip=tip)
    else:
        return _conflict(
            journal,
            op_id,
            f"remote branch tip {tip[:12] or '(none)'} is "
            "neither the old/content/closure tip; refuse to "
            "guess",
        )
    _try_recovery_journal(journal, "update", release_stage="CLOSURE_PUBLISHED")

    # ---- 5. tag created -------------------------------------------------------
    tag_local, tag_local_c = _local_tag_commit(root, tag)
    if tag_local:
        if tag_local_c != closure_commit:
            return _conflict(
                journal,
                op_id,
                f"local tag {tag} points at {tag_local_c[:12]}, not closure {closure_commit[:12]}",
            )
    else:
        _create_tag(root, _PlanShim(version, tag, remote_push_endpoint=endpoint), closure_commit)
    _try_recovery_journal(journal, "update", release_stage="TAG_CREATED")

    # ---- 6. tag published -------------------------------------------------------
    # UNKNOWN remote-tag state is NOT absence: a failed query must stop
    # recovery with ZERO tag push -- an external side effect is never blindly
    # repeated on a question the remote could not answer (T-1003).
    _tag_remote_ok, tag_remote_c = _remote_tag_commit(root, endpoint, tag)
    if not _tag_remote_ok:
        return _unavailable(journal, op_id, "remote tag query failed during recovery")
    post_tag_snapshot = None
    if tag_remote_c:
        if tag_remote_c != closure_commit:
            return _conflict(
                journal,
                op_id,
                f"remote tag {tag} points at "
                f"{tag_remote_c[:12]}, not closure "
                f"{closure_commit[:12]}",
            )
    else:
        # A push happened: verify the tag from a FRESH post-push snapshot and
        # hand that same observation to final verification (it is strictly
        # after the final external write -- T-1004 remote).
        post_tag_snapshot = _push_tag(
            root, _PlanShim(version, tag, remote_push_endpoint=endpoint), closure_commit
        )
    _try_recovery_journal(journal, "update", release_stage="TAG_PUBLISHED")

    # ---- 7. final verification ---------------------------------------------------
    verified = _verify_release(
        root,
        _PlanShim(version, tag, branch, remote_push_endpoint=endpoint),
        closure_commit,
        post_tag_snapshot,
    )
    if not verified["ok"]:
        return _conflict(journal, op_id, verified["detail"])
    _try_recovery_journal(journal, "update", release_stage="REMOTE_VERIFIED")
    _try_recovery_journal(journal, "mark", "VERIFIED")
    _try_recovery_journal(journal, "mark", "COMMITTED")
    _try_recovery_journal(journal, "update", release_stage="COMMITTED")
    cleanup_pending = _drop_settled_staged(journal)
    result = {
        "ok": True,
        "code": "COMMITTED",
        "op_id": op_id,
        "changed_files": [t["path"] for t in record.get("targets", [])],
        "content_commit": content_commit,
        "closure_commit": closure_commit,
        "recovery_required": True,
    }
    if cleanup_pending:
        result["cleanup_pending"] = cleanup_pending
    return result


class _PlanShim:
    """Minimal plan-shaped carrier for stage helpers during recovery."""

    def __init__(
        self, version: str, tag: str, branch: str = "", remote_push_endpoint: str = ""
    ) -> None:
        self.version = version
        self.tag = tag
        self.branch = branch
        self.remote_push_endpoint = remote_push_endpoint
        self.commit_message = f"ship v{version}"


def _conflict(journal, op_id: str, detail: str) -> dict:
    _try_recovery_journal(journal, "mark", "CONFLICT")
    return {
        "ok": False,
        "code": "CONFLICT",
        "op_id": op_id,
        "recovery_required": True,
        "detail": f"{detail} -- evidence preserved, resolve explicitly",
    }


def _unavailable(journal, op_id: str, detail: str) -> dict:
    _try_recovery_journal(journal, "update", recovery_note=detail)
    return {
        "ok": False,
        "code": "CONFLICT",
        "op_id": op_id,
        "recovery_required": True,
        "detail": f"{detail} -- remote state UNKNOWN, never treated as "
        "PASS; resolve explicitly when the remote answers",
    }


def _strict_iso_utc(value: object) -> str:
    """Strict ISO-8601 UTC timestamp (Z or +00:00, utcoffset() == 0) or ''
    (T-1003 finding 15). Delegated to the ONE shared strict-UTC parser (P1#5):
    a non-zero offset stamp is NOT UTC and must refuse, never accept -- otherwise
    ``10:00+03:00`` (07:00Z) would order after ``08:00Z`` and reverse chronology."""
    return strict_iso_utc(value)


def _is_admissible_terminal_receipt(record: dict) -> bool:
    """Strict schema admission of a terminal release receipt (item 15).

    A candidate is admissible ONLY when every identity-bearing field is
    present and structurally sound: operation, COMMITTED status/stage, a
    strict-ISO created_at, and a mode-appropriate closure identity. Anything
    else is a malformed sibling that MAY conflict with a selected result and
    therefore cannot silently disappear."""
    if not isinstance(record, dict):
        return False
    if record.get("operation") != "release":
        return False
    if not _strict_iso_utc(record.get("created_at")):
        return False
    if record.get("status") != "COMMITTED":
        return False
    if record.get("release_stage") != "COMMITTED":
        return False
    if not record.get("op_id") or not record.get("ticket_id") or not record.get("source_head"):
        return False
    mode = record.get("mode") or "full"
    if mode == "no-publish":
        return True
    if mode != "full":
        return False
    if not record.get("closure_commit"):
        return False
    return "REMOTE_VERIFIED" in tuple(record.get("stages") or ())


class _ReceiptSelectionError(Exception):
    def __init__(self, status: str, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


def _select_terminal_receipt(candidates: list[dict]) -> dict:
    """Fail-closed receipt selection (item 15).

    Two valid COMPETING terminal receipts (differing closure/tag/mode) are
    AMBIGUOUS -- never max(created_at). Identical-identity duplicates are one
    identity regardless of op_id. Timestamps order history; they never decide
    between competing successors."""
    identities = {(c.get("closure_commit"), c.get("tag"), c.get("mode")) for c in candidates}
    if len(identities) > 1:
        raise _ReceiptSelectionError(
            "ambiguous",
            "competing terminal release receipts for the same crew epoch "
            "differ on closure/tag/mode",
        )
    # Order by the REAL UTC instant (never the spelling); op_id is the
    # equal-instant tiebreak. Admissible same-instant receipts tie by op_id; a
    # sub-second spelling difference never reverses chronology (P1#3).
    _earliest = datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)
    return max(
        candidates,
        key=lambda c: (iso_utc_sort_key(c.get("created_at", "")) or _earliest, c.get("op_id", "")),
    )


def _receipt_evidence(record: dict) -> dict:
    return {
        "op_id": record.get("op_id", ""),
        "ticket_id": record.get("ticket_id", ""),
        "tag": record.get("tag", ""),
        "version": record.get("version", ""),
        "source_head": record.get("source_head", ""),
        "source_tree_fingerprint": record.get("source_tree_fingerprint", ""),
        "closure_commit": record.get("closure_commit", ""),
        "created_at": record.get("created_at", ""),
        "stages": tuple(record.get("stages") or ()),
        "pre_ship_evidence": dict(record.get("crew_pre_ship_evidence") or {}),
        "pre_ship_applicability": dict(record.get("crew_pre_ship_applicability") or {}),
        "mode": record.get("mode") or "full",
    }


def _verify_receipt(root: Path, record: dict) -> dict:
    """ONE real read-only release verifier (T-1003 findings 14/16).

    A receipt CLAIMING REMOTE_VERIFIED is not remote verification: the
    verifier independently queries the configured push destination and proves
    the branch tip, the peeled tag, the version/tag relation and the closure
    against it. Remote unavailability is UNKNOWN. No-publish receipts are
    verified for LOCAL closure truth with zero Git requirements.
    """
    # W2-006: read and validate runtime project identity and portable
    # project lineage INDEPENDENTLY. Failure of one source must not suppress
    # the other. Any missing/unreadable required local authority is unknown.
    from .paths import project_identity as _project_identity, project_lineage_identity

    try:
        live_proj = _project_identity(root)
    except Exception:
        live_proj = ""
    try:
        live_lineage = project_lineage_identity(root)
    except Exception:
        live_lineage = ""
    record_lineage = record.get("project_lineage")
    if record_lineage:
        # W2-006: require a SUCCESSFUL live-lineage read and exact equality.
        # Failure to obtain lineage is unknown, not absence of contradiction.
        if not live_lineage:
            return {
                "status": "unknown",
                "reason": "could not establish live project lineage for receipt verification",
            }
        if live_lineage != record_lineage:
            return {
                "status": "unknown",
                "reason": "release receipt belongs to a different project lineage",
            }
    elif record.get("project_identity"):
        # Legacy receipt: require successful live project-identity read.
        if not live_proj:
            return {
                "status": "unknown",
                "reason": "could not establish live project identity for receipt verification",
            }
        if record.get("project_identity") != live_proj:
            return {"status": "unknown", "reason": "release receipt names a different project"}
    mode = record.get("mode") or "full"
    if mode == "no-publish":
        return _verify_no_publish_receipt(root, record)
    closure = record.get("closure_commit") or ""
    if not closure:
        return {"status": "unknown", "reason": "full-mode release receipt has no closure commit"}
    # W2-006: require git rev-parse HEAD itself to SUCCEED and yield a
    # valid non-empty commit. A failed/empty result is unknown, not a
    # non-contradiction that lets remote evidence finish the verdict.
    try:
        gr = _git(root, "rev-parse", "HEAD")
        head = gr.stdout.strip() if gr.ok else ""
    except Exception:
        head = ""
    if not head:
        return {
            "status": "unknown",
            "reason": "could not establish local HEAD for receipt verification",
        }
    if head != closure:
        return {
            "status": "unknown",
            "reason": f"release closure {closure[:12]} != current HEAD {head[:12]}",
        }
    branch = record.get("branch") or ""
    if not branch:
        return {"status": "unknown", "reason": "release receipt carries no branch identity"}
    endpoint = record.get("remote_push_endpoint") or _push_endpoint(root) or "origin"
    # PERF-003: ONE fresh RemoteSnapshot for this verification event. The prior
    # code fired two independent ls-remote calls (branch tip + tag), doubling
    # remote load and risking branch/tag inconsistency across two queries. A
    # single capture keeps both facts consistent against one remote state.
    snapshot = _remote_snapshot(root, endpoint)
    remote_ok, tip = snapshot.branch_tip(branch)
    if not remote_ok:
        return {
            "status": "unknown",
            "reason": "remote branch tip query failed -- receipt claims "
            "REMOTE_VERIFIED but the verifier cannot confirm it",
        }
    if tip != closure:
        return {
            "status": "unknown",
            "reason": f"remote branch tip {tip[:12] or '(none)'} != closure {closure[:12]}",
        }
    tag = record.get("tag") or ""
    if not tag:
        return {"status": "unknown", "reason": "release receipt carries no tag identity"}
    tag_ok, tag_sha = snapshot.tag_commit(tag)
    if not tag_ok or not tag_sha:
        return {
            "status": "unknown",
            "reason": f"remote tag {tag} query failed or empty -- "
            "receipt claims REMOTE_VERIFIED but the verifier "
            "cannot confirm it",
        }
    if tag_sha != closure:
        return {
            "status": "unknown",
            "reason": f"remote tag {tag} peels to {tag_sha[:12]} != closure {closure[:12]}",
        }
    version = record.get("version") or ""
    if version and tag != f"v{version}":
        return {
            "status": "unknown",
            "reason": f"release tag {tag!r} does not name version {version!r}",
        }
    return {"status": "ok", "evidence": _receipt_evidence(record)}


def _verify_no_publish_receipt(root: Path, record: dict) -> dict:
    """No-publish LOCAL closure truth (item 16): zero Git requirements, but
    the receipt must actually describe a closure that happened -- Core at
    DONE/task none, the receipt's ticket DONE on BOARD, and the source
    identity unchanged since the closure was recorded."""
    try:
        _state_text, state = _read_state(root)
        _board_text, board = _read_board(root)
    except ReleaseRefusal as exc:
        return {"status": "unknown", "reason": f"canonical state unreadable: {exc.detail}"}
    if state.get("phase") != "DONE" or state.get("task") not in (None, "", "none"):
        return {
            "status": "unknown",
            "reason": "local closure truth absent: Core not at DONE / task none",
        }
    ticket_id = record.get("ticket_id") or ""
    if ticket_id:
        ticket = board.get("tickets", {}).get(ticket_id)
        if ticket is None or ticket["section"] != "## DONE":
            return {
                "status": "unknown",
                "reason": f"local closure truth absent: {ticket_id} is not DONE on BOARD",
            }
    try:
        from freshness import compute_source_identity

        live = compute_source_identity(root)
    except Exception as exc:
        return {"status": "unknown", "reason": f"source identity unreadable: {exc}"}
    recorded_head = record.get("source_head") or ""
    recorded_fp = record.get("source_tree_fingerprint") or ""
    # W2-002: no-publish receipt must bind the complete source identity.
    # Legacy receipts lacking a fingerprint cannot prove unchanged source and
    # must yield UNKNOWN rather than a positive ok.
    if not recorded_fp:
        return {
            "status": "unknown",
            "reason": (
                "no-publish receipt lacks source_tree_fingerprint -- cannot prove unchanged source"
            ),
        }
    if recorded_head and live.source_head != recorded_head:
        return {
            "status": "unknown",
            "reason": "source moved after the no-publish closure receipt was recorded",
        }
    if live.source_tree_fingerprint != recorded_fp:
        return {
            "status": "unknown",
            "reason": "source tree changed after the no-publish closure receipt was recorded",
        }
    return {"status": "ok", "evidence": _receipt_evidence(record)}


def release_verdict(root: Path | str, crew_epoch: str | None = None, receipt_snapshot=None) -> dict:
    """Read-only canonical release receipt verdict (T-1003 sweep).

    Crew consumes THIS verdict, never a self-attesting JSON scan. Returns:
      {"status": "ok", "evidence": {...}}      -- ONE canonical committed
                                                  release for this epoch,
                                                  independently verified
      {"status": "unknown", "reason": ...}      -- none, malformed lineage,
                                                  closure != HEAD, or remote
                                                  unavailable/unprovable
      {"status": "ambiguous", "reason": ...}    -- competing terminal receipts
    UNKNOWN is never PASS and AMBIGUOUS never max(created_at). A receipt that
    claims REMOTE_VERIFIED is not remote verification: the verdict queries the
    actual configured destination and proves branch tip + peeled tag + version
    relation independently.
    """
    root = Path(root)
    from .journal import semantic_receipt_snapshot

    raw_records = []
    # W2-002: scan BOTH recovery/ops and recovery/settled through the ONE
    # canonical semantic snapshot, not ops alone -- a settled release receipt
    # (release_stage == COMMITTED) moved by _settle_journal must remain visible
    # to crew finalize. The strict decode already excluded corrupt/unparseable
    # receipts, so no synthetic {"corrupt": ...} stubs are needed.
    snapshot = receipt_snapshot or semantic_receipt_snapshot(root)
    if snapshot.errors:
        return {
            "status": "unknown",
            "reason": "operation receipt corruption: " + "; ".join(snapshot.errors[:3]),
        }
    for record in snapshot.records:
        if record.get("operation") != "release":
            continue
        raw_records.append(record)
    if crew_epoch is not None:
        raw_records = [item for item in raw_records if item.get("crew_epoch") == crew_epoch]
    valid = []
    invalid = []
    for item in raw_records:
        if _is_admissible_terminal_receipt(item):
            valid.append(item)
        else:
            invalid.append(item)
    if not valid:
        return {
            "status": "unknown",
            "reason": "no canonical terminal release receipt for this crew epoch",
        }
    if invalid:
        # A malformed/partial sibling of the same epoch MAY conflict with the
        # selected result; it cannot silently disappear (item 15).
        return {
            "status": "unknown",
            "reason": "release receipt lineage is not clean: "
            + "; ".join(str(i.get("op_id") or i.get("path") or "?") for i in invalid[:3])
            + " -- resolve or remove the conflicting evidence",
        }
    try:
        record = _select_terminal_receipt(valid)
    except _ReceiptSelectionError as exc:
        return {"status": exc.status, "reason": exc.reason}
    return _verify_receipt(root, record)
