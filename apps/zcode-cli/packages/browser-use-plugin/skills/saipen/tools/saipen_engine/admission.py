"""Single Protocol Admission Authority & Guard Engine (SRC-028 / T-1317).

Central authority for evaluating whether an agent tool call, file modification,
or command invocation is admitted under the SAIPEN protocol.

Layers (SRC-030 Parts 2-5):

1. Project binding -- `paths.resolve_project_root` (explicit > host carrier >
   worktree > common > ancestor). A project with no `.saipen/` and no claimed
   binding is OUT of jurisdiction: the guard reports non-interference instead
   of refusing. A binding that was ASSERTED and does not verify (lineage
   mismatch, invalid explicit root) fails closed.

2. Protected canonical namespace -- `.saipen/STATE.md`, `.saipen/BOARD.md`,
   `.saipen/LOG.md`, `.saipen/IDENTITY.md`, `.saipen/logs/**`,
   `.saipen/intake/**`, `.saipen/recovery/**`. The proposed target is
   CANONICALLY resolved against the project root before classification, so
   `src/../.saipen/STATE.md`, `nested/a/../../.saipen/BOARD.md`, absolute
   spellings and symlink/reparse aliases all land on the same decision.
   Deleting `..` substrings is never done; `Path.resolve` semantics decide.

3. Action/effect model -- the guard distinguishes READ from mutation. Reading
   canonical state is what BOOT, diagnostics and recovery do; refusing reads
   made the protocol undiagnosable. Direct mutation of canonical files stays
   refused. Unknown actions are potentially mutating and fail closed.

4. Target SET -- one proposed effect may carry ZERO, ONE or MANY targets (a
   multi-file patch, both endpoints of a move/rename). Admission evaluates
   EVERY target and refuses when ANY is refused. Consequential mutation whose
   target set is untrustworthy, and UNCLASSIFIED consequential host tools with
   no reviewed translation, are refused as ``TARGET_UNRESOLVED`` rather than
   admitted as ordinary healthy mutations (T-1317 P0-5/P0-6, Target A).

5. Protocol admission -- before a consequential ordinary project mutation the
   canonical machine state must be sound: STATE parses, BOARD parses, the
   STATE/LOG checkpoint binding holds, no unresolved recovery debt, no
   binding WAIT/BLOCKED, no read-only capability restriction, and the actor
   does not collide with a live foreign Work owner. Ownership is decided ONLY
   through the engine's own board authority (`board.parse_board` +
   `board.claim_status`); a host-supplied actor string is input evidence,
   never a second ownership parser.

6. Actor resolution -- an explicit host actor, when supplied, is checked as
   the acting actor. With none, the canonical snapshot inherits `STATE.agent`
   and applies the same ownership, recovery, and protocol-state checks. A host
   session id never enters actor resolution.

7. Session binding (T-1384) -- inheriting `STATE.agent` makes the ownership
   test ask whether the incumbent is the incumbent, so it can only say yes,
   and an unseated second window mutated product bytes under a live foreign
   owner. A claim may therefore carry `claim_session`, a lineage-salted
   DIGEST of the host session that made it. Where one is present, a
   consequential mutation must present the same session or be refused
   `UNSEATED_MUTATION`; absent proof is never read as the owner. This is not
   actor resolution -- the seat is still the name in `owner` -- it is the
   separate question of whether THIS PROCESS holds it. A claim written
   without a binding is judged exactly as before, so upgrading a project
   never freezes it.

The guard itself is read-only. It never repairs, recovers, or checkpoints.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import time
from pathlib import Path, PurePosixPath, PureWindowsPath

from .command_effects import SHELL_CANONICAL_VERBS
from .phases import ENTRY_COMMAND
from .paths import project_lineage_identity, resolve_project_root

PROTECTED_CANONICAL_NAMESPACES = (
    ".saipen/STATE.md",
    ".saipen/BOARD.md",
    ".saipen/LOG.md",
    ".saipen/IDENTITY.md",
    ".saipen/logs",
    ".saipen/intake",
    ".saipen/recovery",
)

ENFORCEMENT_STRENGTH_BLOCKING = "BLOCKING"
ENFORCEMENT_STRENGTH_ADVISORY = "ADVISORY"
ENFORCEMENT_STRENGTH_GAP = "ENFORCEMENT_GAP"

#: Bounded reads for the read-only protocol snapshot. STATE/BOARD are small by
#: construction; a LOG past these bounds has a bigger problem than admission.
_STATE_READ_LIMIT = 256 * 1024
_BOARD_READ_LIMIT = 2 * 1024 * 1024
_LOG_TAIL_BYTES = 64 * 1024

_REGISTRY_PATH = Path(__file__).resolve().parent.parent.parent / (
    "extensions/adapters/registry.json"
)


def _load_registry() -> dict[str, dict]:
    """Load the one declarative host adapter authority (SRC-028:R008).

    The registry is shipped data (`extensions/adapters/registry.json`); the
    Python runtime, both injectors, autoinject and the tests all read the same
    file. A missing or malformed registry is a bootstrap failure, never a
    silent empty inventory.
    """
    try:
        raw = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"host adapter registry unreadable: {_REGISTRY_PATH}: {exc}") from None
    adapters = raw.get("adapters") if isinstance(raw, dict) else None
    if not isinstance(adapters, list) or not adapters:
        raise RuntimeError(f"host adapter registry has no adapters: {_REGISTRY_PATH}")
    registry: dict[str, dict] = {}
    for entry in adapters:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise RuntimeError(f"host adapter registry entry without id: {_REGISTRY_PATH}")
        normalized = dict(entry)
        normalized["strength"] = entry.get("declared_strength")
        normalized["doc"] = f"extensions/adapters/{entry['id']}.md"
        registry[entry["id"].lower()] = normalized
    return registry


ADAPTER_REGISTRY: dict[str, dict] = _load_registry()

#: The closed action vocabulary (SRC-030 Part 3). ``saipen_op`` is the effect
#: class for a recognized canonical saipen CLI operation: the CLI owns its own
#: authority, so the guard admits it even under recovery debt.
ACTIONS = (
    "read",
    "write",
    "create",
    "edit",
    "delete",
    "rename",
    "move",
    "shell",
    "delegate",
    "saipen_op",
    "unknown",
)

#: READ is the only non-mutating effect. Everything else -- including UNKNOWN
#: -- is potentially mutating and fails closed on protocol problems.
ACTION_EFFECT = {action: ("read" if action == "read" else "mutating") for action in ACTIONS}
ACTION_EFFECT["saipen_op"] = "canonical"

#: Canonical saipen CLI verbs recognized in shell commands. Exact token
#: equality on a closed set -- never pattern inference over free text. The set
#: is read from `REGISTRY.json.command_effects` (T-1363), the one owner that
#: also classifies what each verb does, so the guard can no longer recognize a
#: verb the classifier has never heard of.
SAIPEN_CLI_VERBS = SHELL_CANONICAL_VERBS - frozenset({"help"})


#: Refusal codes introduced by the target-set and actor-binding contracts.
CODE_TARGET_UNRESOLVED = "TARGET_UNRESOLVED"
CODE_ACTOR_UNBOUND = "ACTOR_UNBOUND"


def normalize_action(action: str | None) -> str:
    """Map any caller action string onto the closed vocabulary.

    Unrecognized actions become ``unknown``: potentially mutating, fails
    closed on blocking-capable adapters and on protocol problems alike.
    """
    if not action:
        return "unknown"
    candidate = str(action).strip().lower()
    return candidate if candidate in ACTIONS else "unknown"


def is_protected_canonical_path(rel_path: str | Path) -> bool:
    """Check if an already-canonical RELATIVE path is protected canonical state.

    Callers must canonicalize first (`canonicalize_target`); this predicate
    does pure lexical namespace membership on a clean relative POSIX path.
    """
    normalized = str(rel_path).replace("\\", "/").strip().lstrip("/")
    for protected in PROTECTED_CANONICAL_NAMESPACES:
        if normalized.lower() == protected.lower():
            return True
        if normalized.lower().startswith(protected.lower() + "/"):
            return True
    return False


def contains_protected_canonical_path(rel_path: str | Path) -> bool:
    """True when an already-canonical RELATIVE target IS or CONTAINS protected state.

    `is_protected_canonical_path` answers membership, and a DIRECTORY effect
    needs containment: deleting or moving `.saipen` -- or the project root
    itself -- destroys every protected document below it while naming none of
    them, so a predicate that only asked "is this path inside the namespace"
    admitted the one effect that removes the whole namespace at once.
    """
    normalized = str(rel_path).replace("\\", "/").strip().strip("/")
    if normalized in ("", "."):
        return True
    if is_protected_canonical_path(normalized):
        return True
    prefix = normalized.lower() + "/"
    return any(
        protected.lower().startswith(prefix) for protected in PROTECTED_CANONICAL_NAMESPACES
    )


def _ordinary_namespace_targets(root: Path, paths: "list[str] | None") -> bool:
    """T-1387: every `.saipen` path a shell line names is an ordinary project
    file -- canonicalized exactly as a file-tool target (`canonicalize_target`),
    inside the root, outside the protected canonical namespace, and not a
    directory that contains it. No paths means the mention was not a path the
    guard could judge, and the whole-namespace refusal stands."""
    if not paths:
        return False
    for path in paths:
        classification, rel, _detail = canonicalize_target(root, path)
        if classification != "inside" or contains_protected_canonical_path(rel):
            return False
    return True


#: Directory-capable effects: the only ones whose single target can remove or
#: relocate a whole subtree, and so the only ones that need containment checks
#: outside the root.
_SUBTREE_ACTIONS = frozenset({"delete", "move", "rename"})

#: File-effect actions whose target is judged for namespace containment inside
#: the root. Shell/delegate/canonical operations carry no subtree target here.
_CONTAINMENT_ACTIONS = frozenset({"write", "create", "edit"}) | _SUBTREE_ACTIONS

#: Directories visited while proving an OUTSIDE subtree holds no SAIPEN project.
#: A subtree larger than this cannot be proven clean and is refused, never
#: assumed empty.
_CONTAINMENT_SCAN_DIRS = 2000


def _outside_subtree_namespace(root: Path, canonical_absolute: str | Path) -> str | None:
    """Why deleting or moving an OUTSIDE directory would take a SAIPEN namespace with it.

    T-1354 admits ordinary paths outside the root whoever asks, on the premise
    that a directory belonging to no project has no lifecycle to protect. A
    directory that CONTAINS a project -- this session's own root, or another
    project's -- does. Ancestry of this root is decided exactly; the target's
    own subtree is searched breadth-first without following links, bounded by
    `_CONTAINMENT_SCAN_DIRS`. Returns a reason, or None when the subtree is
    proven to hold no `.saipen` directory (or the target is not a directory).
    """
    target = Path(canonical_absolute)
    try:
        Path(root).relative_to(target)
    except ValueError:
        pass
    else:
        return "the target contains this project's root and its protected canonical state"
    queue: list[Path] = [target]
    visited = 0
    while queue:
        current = queue.pop(0)
        try:
            if (current / ".saipen").is_dir():
                return f"the target contains the SAIPEN project at '{current.as_posix()}'"
            with os.scandir(current) as entries:
                children = [
                    Path(entry.path)
                    for entry in entries
                    if entry.is_dir(follow_symlinks=False)
                    and not _is_reparse_point(Path(entry.path))
                ]
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError:
            return "the target subtree cannot be read to prove it holds no SAIPEN project"
        visited += len(children)
        if visited > _CONTAINMENT_SCAN_DIRS:
            return (
                f"the target subtree exceeds {_CONTAINMENT_SCAN_DIRS} directories and cannot "
                "be proven to hold no SAIPEN project"
            )
        queue.extend(children)
    return None


def _is_reparse_point(path: Path) -> bool:
    """A symlink or junction: a subtree scan never follows one out of the target.

    Deleting a link removes the link, not what it points at, so a project
    reachable only through one is not inside the target's subtree.
    """
    try:
        info = os.lstat(path)
    except OSError:
        return True
    if stat.S_ISLNK(info.st_mode):
        return True
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(getattr(info, "st_file_attributes", 0) & reparse)


def foreign_protected_canonical(canonical_absolute: str | Path) -> str | None:
    """The protected canonical path an OUTSIDE target names in ANOTHER project.

    T-1351. Jurisdiction-by-root is right for ordinary files outside the root:
    a session working in one repository may legitimately edit a sibling, and
    the protocol has nothing to say about it. It is not right for another
    SAIPEN project's canonical state, which is that project's LIFECYCLE and
    belongs to that project's own admission -- never to this session's
    jurisdiction, whoever asked.

    Without this the same question had two answers. A shell command naming
    anything under `.saipen` was refused by PATH SHAPE regardless of root,
    while a file tool handed the identical absolute path was admitted by ROOT
    JURISDICTION, so an agent reaching for `edit` succeeded where an agent
    reaching for `bash` failed. Measured against two real foreign projects.

    Returns the project-relative protected path, or None when the target is an
    ordinary file (or lives in no SAIPEN project at all).
    """
    path = Path(canonical_absolute)
    for ancestor in path.parents:
        try:
            if not (ancestor / ".saipen").is_dir():
                continue
        except OSError:
            # An unreadable ancestor is not evidence of innocence, but it is
            # also not this predicate's call: the caller's escape/refusal
            # paths own unresolvable input.
            return None
        try:
            relative = path.relative_to(ancestor).as_posix()
        except ValueError:  # pragma: no cover - parents() guarantees this holds
            return None
        # The NEAREST enclosing project decides. Climbing past it would judge
        # the path against an outer project whose namespace it is not in.
        # Containment, not membership: that project's `.saipen` directory is
        # every protected document at once (T-1354).
        return relative if contains_protected_canonical_path(relative) else None
    return None


def get_adapter(name: str) -> dict | None:
    """Retrieve adapter metadata from the central registry."""
    entry = ADAPTER_REGISTRY.get(str(name).lower())
    return dict(entry) if entry else None


def list_adapters() -> list[dict]:
    """List all registered host adapters."""
    return [dict(v) for v in ADAPTER_REGISTRY.values()]


#: Host names that address THIS machine in a UNC path. `\\\\localhost\\C$` is
#: the root of drive C here, by Windows' own definition of the admin share.
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})


def _names_this_machine(host: str) -> bool:
    name = host.strip("[]").lower()
    if name in _LOOPBACK_HOSTS:
        return True
    own = {os.environ.get("COMPUTERNAME", ""), socket.gethostname()}
    return name in {entry.lower() for entry in own if entry} | {
        entry.split(".", 1)[0].lower() for entry in own if entry
    }


def _win32_spelling(target: str) -> str:
    """The ordinary spelling of the file Windows opens for `target` (T-1354).

    `Path.resolve` keeps these Win32 shapes verbatim, so the root-relative test
    judged the spelling instead of the file:

    - the extended and device prefixes, `\\\\?\\X:\\...` and `\\\\.\\X:\\...`, and
      `\\\\?\\UNC\\host\\share` / `\\\\.\\UNC\\host\\share` for `\\\\host\\share` --
      an in-root file spelled this way classified OUTSIDE and skipped every
      block an in-root path answers to, recovery debt on that very file
      included;
    - an administrative share of this machine -- `localhost`, a loopback
      address or the machine's own name, `\\\\host\\X$\\...` -- which is drive X;
    - NTFS stream syntax, `name:stream[:type]`, which writes the file `name`
      (`::$DATA` is its main stream): `.saipen/IDENTITY.md::$DATA` created a
      protected document while classifying as an ordinary in-root file.

    Mapping only ever moves a spelling onto the file Windows itself opens. What
    no lexical rule can map -- a custom share, a volume-GUID or device path --
    is decided by file identity instead (`_alias_identity`), and fails closed
    when identity cannot be proven.
    """
    if os.name != "nt":
        return target
    text = target.replace("/", "\\")
    if text[:8].upper() in ("\\\\?\\UNC\\", "\\\\.\\UNC\\"):
        text = "\\\\" + text[8:]
    elif text[:4] in ("\\\\?\\", "\\\\.\\") and len(text) > 5 and text[5] == ":":
        text = text[4:]
    if text.startswith("\\\\") and text[2:3] not in ("?", "."):
        host, _sep, rest = text[2:].partition("\\")
        share, _sep, tail = rest.partition("\\")
        if (
            len(share) == 2
            and share[0].isalpha()
            and share[1] == "$"
            and _names_this_machine(host)
        ):
            text = f"{share[0]}:\\{tail}"
    path = PureWindowsPath(text)
    parts = list(path.parts)
    first = 1 if path.anchor else 0
    named = [part.split(":", 1)[0] for part in parts[first:]]
    return str(PureWindowsPath(*parts[:first], *[part for part in named if part]))


def _alias_identity(root: Path, canonical: Path) -> tuple[str, str] | None:
    """Containment by FILE IDENTITY, for a spelling no lexical rule maps.

    T-1354. `Path.resolve` turns every ordinary drive path into its one final
    spelling, so a drive path that is not under the root really is outside. A
    UNC, volume-GUID or device path is different: it can name this project's
    files through a share or a volume name, and nothing about its text says so
    -- `\\\\?\\Volume{...}\\...\\src\\app.py` was ADMITTED_EXTERNAL while recovery
    debt refused `src/app.py` itself.

    Returns `("inside", relative)` when some component is the project root by
    (device, inode); `("unresolved", reason)` when that cannot be decided --
    the path cannot be reached, or its filesystem reports no identity -- which
    admission refuses for any consequential effect; None when the path was
    reached, compared, and is not this project.
    """
    if os.name != "nt":
        return None
    drive = PureWindowsPath(str(canonical)).drive
    if len(drive) == 2 and drive[1] == ":":
        return None
    try:
        anchor = os.stat(root)
        os.stat(canonical.anchor or canonical)
    except OSError as exc:
        return (
            "unresolved",
            f"'{canonical}' cannot be reached ({exc.strerror or exc}), so it cannot be "
            "proven not to be this project",
        )
    for node in (canonical, *canonical.parents):
        try:
            info = os.stat(node)
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError as exc:
            return (
                "unresolved",
                f"'{node}' cannot be read ({exc.strerror or exc}), so '{canonical}' cannot "
                "be proven not to be this project",
            )
        if not info.st_ino:
            return (
                "unresolved",
                f"the filesystem at '{node}' reports no file identity, so '{canonical}' "
                "cannot be proven not to be this project",
            )
        if (info.st_dev, info.st_ino) == (anchor.st_dev, anchor.st_ino):
            return "inside", canonical.relative_to(node).as_posix()
    return None


#: Effects that rewrite an existing file's CONTENT in place -- the ones a hard
#: link turns into a write to every other name of that file.
_CONTENT_ACTIONS = frozenset({"write", "create", "edit", "unknown"})

#: The protected documents a hard link most plausibly aliases, checked by
#: identity when a content target has more than one name.
_PROTECTED_DOCUMENTS = ("STATE.md", "BOARD.md", "LOG.md", "IDENTITY.md")


def _hard_link_alias(root: Path, absolute: Path) -> tuple[str, str] | None:
    """A content effect on a file with more than one name (T-1354).

    Writing any name of a hard-linked file writes all of them, and no path
    spelling reveals the others. Returns ("protected", detail) when the file
    IS one of this project's protected documents, ("unresolved", detail) when
    it has other names that cannot be enumerated, None for an ordinary file
    with one name or no file at all.
    """
    try:
        info = os.stat(absolute)
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink <= 1:
        return None
    for name in _PROTECTED_DOCUMENTS:
        try:
            document = os.stat(root / ".saipen" / name)
        except OSError:
            continue
        if (document.st_dev, document.st_ino) == (info.st_dev, info.st_ino):
            return (
                "protected",
                f"'{absolute}' is a hard link to the protected canonical document "
                f".saipen/{name}",
            )
    return (
        "unresolved",
        f"'{absolute}' has {info.st_nlink} hard links; a content write reaches every one "
        "of them, and they cannot be proven to exclude protected canonical state",
    )


def canonicalize_target(root: Path, target_path: str | Path) -> tuple[str, str, str]:
    """Resolve a proposed target against the project root before classification.

    Returns ``(classification, canonical_relative_or_abs, detail)`` where
    classification is one of:

    - ``inside``      -- canonical path is inside the root; second element is
      the root-relative POSIX path.
    - ``protected``   -- inside AND within the protected canonical namespace.
    - ``outside``     -- canonical path is genuinely outside the root.
    - ``escape``      -- the RELATIVE spelling carries a ``..`` that leaves the
      root: a traversal shape, never read as an ordinary project-relative
      target.
    - ``unresolved``  -- a spelling whose identity with this project can be
      neither proven nor excluded (`_alias_identity`); consequential effects
      on it are refused.

    Symlinks and Windows reparse points are resolved, so an alias that lands
    inside the protected namespace is classified protected regardless of how
    it was spelled; Win32 namespace prefixes, this machine's admin shares and
    stream suffixes are reduced to the file they open first
    (`_win32_spelling`), and any other non-drive spelling is decided by file
    identity. ``..`` substrings are never deleted; `Path.resolve` semantics
    decide.
    """
    raw = Path(_win32_spelling(str(target_path)))
    absolute = raw if raw.is_absolute() else Path(root) / raw
    try:
        canonical = absolute.resolve(strict=False)
    except OSError:
        # An unresolvable alias (link loop, permission wall) is hostile input:
        # fail closed to the escape class rather than guess.
        return "escape", str(target_path), "target path cannot be safely resolved"
    try:
        rel = canonical.relative_to(Path(root))
    except ValueError:
        if not raw.is_absolute() and ".." in raw.parts:
            return (
                "escape",
                canonical.as_posix(),
                "relative traversal spelling leaves the project root",
            )
        identity = _alias_identity(Path(root), canonical)
        if identity is None:
            return "outside", canonical.as_posix(), "target path is outside project root"
        if identity[0] == "unresolved":
            return "unresolved", canonical.as_posix(), identity[1]
        rel = PurePosixPath(identity[1])
    rel_posix = rel.as_posix()
    if is_protected_canonical_path(rel_posix):
        return "protected", rel_posix, "target resolves into the protected canonical namespace"
    return "inside", rel_posix, ""


def _target_list(
    target_path: Path | str | None, target_paths: "list[str] | tuple[str, ...] | None"
) -> list[str]:
    """The proposed effect's target set as one ordered, de-duplicated list."""
    ordered: list[str] = []
    candidates: list[object] = []
    if target_path is not None:
        candidates.append(target_path)
    if target_paths:
        candidates.extend(list(target_paths))
    for candidate in candidates:
        if candidate is None:
            continue
        text = str(candidate).strip()
        if text and text not in ordered:
            ordered.append(text)
    return ordered


def _read_text_bounded(path: Path, limit: int) -> str | None:
    try:
        with path.open("rb") as handle:
            raw = handle.read(limit + 1)
    except OSError:
        return None
    if len(raw) > limit:
        return None
    return raw.decode("utf-8", errors="replace")


def _log_tail_event(root: Path) -> int | None:
    """The newest event id in the ACTIVE LOG, read from a bounded tail.

    Returns None when the active LOG has no parseable event in its tail (fresh
    segment, missing file): binding is then unverifiable, not violated.
    """
    from .log import parse_log_line

    log_path = root / ".saipen" / "LOG.md"
    try:
        size = log_path.stat().st_size
        with log_path.open("rb") as handle:
            if size > _LOG_TAIL_BYTES:
                handle.seek(size - _LOG_TAIL_BYTES)
            raw = handle.read(_LOG_TAIL_BYTES)
    except OSError:
        return None
    text = raw.decode("utf-8", errors="replace")
    for line in reversed(text.splitlines()):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parsed = parse_log_line(line)
        if parsed is not None:
            return int(parsed["event"])
    return None


def _comparable_target(path: str) -> str:
    """One spelling for one file, on both sides of the overlap test.

    Case-folded because the hosts this runs on are case-insensitive, and
    applied to CANONICAL paths only -- it is the last step after
    `canonicalize_target`, never a substitute for it.
    """
    return path.strip().lower()


def _targets_overlap(proposed: set[str], blocked: set[str]) -> bool:
    """True when a proposed target IS, CONTAINS, or LIES INSIDE a blocked target.

    Equality alone is the wrong question for a filesystem. Deleting or moving
    `src` removes `src/app.py` exactly as surely as writing it, a replay that
    owns a directory owns every file below it, and the project root (`.`)
    contains everything. Both sides are canonical and comparable already.
    """
    for want in proposed:
        want_dir = "" if want in ("", ".") else want.rstrip("/") + "/"
        for owned in blocked:
            owned_dir = "" if owned in ("", ".") else owned.rstrip("/") + "/"
            if (
                want == owned
                or not want_dir
                or not owned_dir
                or owned.startswith(want_dir)
                or want.startswith(owned_dir)
            ):
                return True
    return False


def _pending_operation_targets(root: Path, ops) -> set[str] | None:
    """The canonical paths an unfinished operation is going to write.

    T-1354. Returns None when any record cannot be read: an unreadable
    operation is unknown scope, and unknown scope refuses everything, exactly
    as before this function existed.

    Both sides of the overlap test go through `canonicalize_target`, because
    two spellings of one file must not read as two files. A target recorded
    absolutely, with a `./` prefix, or with a `..` segment compared unequal to
    the same file spelled plainly, and the mismatch ADMITTED a write to a path
    the replay is going to write -- fail-open, out of a record that parsed
    perfectly well. Reusing the proposal's own normalizer is what makes the
    two sides answer the same question.
    """
    paths: set[str] = set()
    for op in ops or ():
        op_id = str(op.get("op_id", "") or "")
        if not op_id:
            return None
        record_path = root / ".saipen" / "recovery" / "ops" / op_id / "operation.json"
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        entries = record.get("targets")
        if not isinstance(entries, list):
            return None
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
                return None
            classification, canonical, _detail = canonicalize_target(root, entry["path"])
            if classification in ("escape", "outside", "unresolved"):
                # A recorded target that resolves outside this root, or that
                # cannot be resolved at all, is scope this function cannot
                # describe. Unknown scope refuses everything.
                return None
            paths.add(_comparable_target(canonical))
    return paths


#: The one command that lifts each hard stop `state.binding_brake` reports.
#: A refusal that names the brake but not its exit is the loop T-1377 measured.
_BRAKE_ROUTES = {
    "blocker": "saipen recover resolve-blocker <decision>",
    "blocked": "saipen ticket unblock <T-###> <decision>",
    # A printed command has to BE a command: the reachability control refuses a
    # route its own guard would not classify, and a trailing comment made this
    # one unreachable from the state that prints it. The persisted WAIT text
    # comes back in `continue`'s own payload, so the bare command carries it.
    "wait": "saipen continue --json",
}


#: T-1385. What a session refused PROTECTED_CANONICAL_NAMESPACE runs instead.
#:
#: The refusal knows one thing -- direct canonical mutation is forbidden -- and
#: not which canonical operation the session meant, so any route that names an
#: operation invents authority the guard does not have. The first route this
#: ticket printed was `saipen checkpoint RUN T-### '<what happened>'`; typed
#: verbatim, it appended a LOG event whose evidence was the placeholder. The
#: router's own read has no such gap: it writes nothing, carries nothing to
#: fill in, classifies as a canonical DIAGNOSTIC that needs no Fleet
#: preparation, and answers from the state it runs in -- including the one
#: where STATE.md cannot be parsed, which it diagnoses instead of writing over.
CANONICAL_NAMESPACE_ROUTE = "saipen next --json"


def protocol_snapshot(
    root: Path,
    actor: str | None = None,
    proposed_targets: "list[str] | None" = None,
    session_id: str | None = None,
) -> dict:
    """Read-only canonical machine-state snapshot used by admission (Part 4).

    Never repairs anything. Returns a dict with a ``block`` code (None when
    the protocol state is sound), plus the parsed facts the decision used.

    `proposed_targets` are the caller's already-canonicalized targets. They
    scope the RECOVERY_REQUIRED refusal to the operations that can actually
    collide with an unfinished write (T-1354); with none supplied the refusal
    keeps its old, unscoped meaning.
    """
    from .board import claim_session_digest, claim_status, parse_board
    from .journal import scan_pending
    from .state import binding_brake, parse_state_or_error, persisted_home_error

    snapshot: dict = {"block": None, "detail": ""}

    def refuse(code: str, detail: str) -> dict:
        snapshot["block"] = code
        snapshot["detail"] = detail
        return snapshot

    state_text = _read_text_bounded(root / ".saipen" / "STATE.md", _STATE_READ_LIMIT)
    if state_text is None:
        return refuse("PROTOCOL_STATE_INVALID", "STATE.md missing or beyond read bound")
    state, state_error = parse_state_or_error(state_text)
    if state is None:
        return refuse("PROTOCOL_STATE_INVALID", f"malformed STATE: {state_error}")
    snapshot["state"] = state

    # T-1424: the canonical runtime BINDING is protocol state. A persisted
    # `STATE.saipen_home` that is absolute but does not resolve to a usable
    # SAIPEN install on this host (a dead pointer, a foreign OS, a removed
    # clone) means the bootloader cannot load the protocol this checkpoint was
    # written against. Consequential mutation is refused so a host that lost
    # the canonical runtime can never silently degrade into an ordinary
    # writable session; canonical operations remain the repair path.
    #
    # T-1425: the route is the AUTOMATIC convergence command, not a placeholder
    # demanding a path. `rebind-home --auto` adopts the runtime host bootstrap
    # already proved and refuses with the manual route when nothing is proven,
    # so a refusal never asks the operator to retype what SAIPEN already knows.
    home_problem = persisted_home_error(state.get("saipen_home"))
    if home_problem is not None:
        snapshot["route"] = "saipen rebind-home --auto"
        return refuse("HOME_REQUIRED", home_problem)

    board_text = _read_text_bounded(root / ".saipen" / "BOARD.md", _BOARD_READ_LIMIT)
    if board_text is None:
        return refuse("PROTOCOL_STATE_INVALID", "BOARD.md missing or beyond read bound")
    board = parse_board(board_text)
    if board["errors"]:
        return refuse("PROTOCOL_STATE_INVALID", f"malformed BOARD: {board['errors'][0]}")
    snapshot["board"] = board

    last_event = state.get("last_event")
    if isinstance(last_event, int):
        tail_event = _log_tail_event(root)
        if tail_event is not None and tail_event != last_event:
            return refuse(
                "PROTOCOL_STATE_INVALID",
                f"LOG/STATE checkpoint binding desync: LOG tail E-{tail_event}, "
                f"STATE last_event {last_event}",
            )

    pending, conflicts = scan_pending(root)
    if pending or conflicts:
        names = ", ".join(str(op.get("op_id", "?")) for op in (conflicts or pending)[:5])
        snapshot["recovery_pending"] = [str(op.get("op_id", "?")) for op in pending]
        # T-1354: an unfinished canonical write is real debt, and it is debt
        # against the FILES it is going to write. Refusing every consequential
        # tool for it left an agent unable to edit a source file that no
        # replay will ever touch -- measured in the field, where one
        # interrupted BOARD compaction made an entire repository read-only.
        #
        # The recorded targets are exact, so the collision test is exact.
        # Unknown scope still refuses everything: an unreadable operation
        # record is not evidence of safety.
        blocked_paths = _pending_operation_targets(root, (conflicts or []) + (pending or []))
        proposed = {_comparable_target(str(item)) for item in (proposed_targets or [])}
        if blocked_paths is None or not proposed or _targets_overlap(proposed, blocked_paths):
            return refuse("RECOVERY_REQUIRED", f"unresolved recovery operation(s): {names}")

    if str(state.get("mode", "")).strip().lower() == "read-only":
        return refuse("PROTOCOL_MODE_READONLY", "STATE mode is read-only")

    phase = str(state.get("phase", "") or "")
    # T-1322: ONE authoritative brake, shared with `router.route_next`. The
    # guard and the router must never judge runnability two ways -- the router
    # used to ignore a non-empty STATE.blocker that this guard refuses, so
    # `continue` advertised work the guard then blocked. `binding_brake` also
    # carries the contextual DONE+empty-TODO UNBLOCK exception, so the guard
    # stops distinguishing a binding WAIT from a stale one by itself.
    empty_todo = not any(
        ticket.get("section") == "## TODO" for ticket in board["tickets"].values()
    )
    brake = binding_brake(state, empty_todo=empty_todo)
    if brake is not None:
        # T-1377: measured live -- a session was refused WAIT_BLOCKED twice with
        # "the saipen guard refused tool 'bash'; the host tool did not execute"
        # and nothing else: no reason, no route, so it retried. The brake
        # already knows WHICH hard stop binds, and each kind has exactly one
        # command that lifts it.
        snapshot["route"] = _BRAKE_ROUTES.get(brake[0])
        return refuse("WAIT_BLOCKED", brake[1])

    canonical_actor = (str(state.get("agent", "")) or "").strip() or None
    explicit_actor = (actor or "").strip() or None
    effective_actor = explicit_actor or canonical_actor
    doing = [
        ticket for ticket in board["tickets"].values() if ticket.get("section") == "## DOING"
    ]
    if len(doing) != 1:
        # T-1377: "found 0" is a fact, not a move. With no active Work the entry
        # command is the whole answer; with several, the board is the problem.
        snapshot["route"] = ENTRY_COMMAND if not doing else "saipen status --json"
        return refuse(
            "NO_ACTIVE_WORK" if not doing else "PROTOCOL_STATE_INVALID",
            "consequential mutation requires exactly one active DOING Work; "
            f"found {len(doing)}",
        )
    active = doing[0]
    if state.get("task") != active["id"] or phase not in {
        "SCOUT",
        "BUILD",
        "VERIFY",
        "REVIEW",
        "SHIP",
    }:
        return refuse(
            "PROTOCOL_STATE_INVALID",
            f"active Work binding mismatch: STATE phase/task={phase}/{state.get('task')} "
            f"but BOARD.DOING={active['id']}",
        )

    for ticket in doing:
        if ticket.get("section") != "## DOING":
            continue
        canonical_status = claim_status(ticket, canonical_actor)
        if canonical_status in ("FOREIGN_LIVE", "INVALID"):
            owner = ticket.get("fields", {}).get("owner", "?")
            detail = (
                f"canonical ownership contradiction: STATE.agent "
                f"{canonical_actor!r} differs from live Work {ticket['id']} "
                f"owner {owner!r}"
                if canonical_status == "FOREIGN_LIVE"
                else f"Work {ticket['id']} carries an INVALID claim pair; fail closed"
            )
            return refuse("OWNERSHIP_CONFLICT", detail)

        status = claim_status(ticket, explicit_actor) if explicit_actor else canonical_status
        if status in ("FOREIGN_LIVE", "INVALID"):
            owner = ticket.get("fields", {}).get("owner", "?")
            detail = (
                f"live Work {ticket['id']} owned by {owner!r} (claim {status}); "
                "actor does not own the active Work"
                if status == "FOREIGN_LIVE"
                else f"Work {ticket['id']} carries an INVALID claim pair; fail closed"
            )
            return refuse("OWNERSHIP_CONFLICT", detail)

        # T-1384. Everything above adjudicates ownership against `owner`, a
        # NAME -- and the name is read out of the same ledger the arriving
        # process just read. An agent that declares nothing inherits
        # STATE.agent, so `claim_status` is asked whether the incumbent is
        # the incumbent and can only answer yes. That tautology is how a
        # second window mutated product bytes while the canonical ledger
        # stayed byte-identical (measured in the T-1367 final matrix).
        #
        # A session binding is the half a name cannot carry. It is checked
        # ONLY against a claim that actually recorded one: a claim written
        # before this existed proves nothing either way, and inventing a
        # verdict from its silence would freeze every project mid-upgrade.
        bound = str(ticket.get("fields", {}).get("claim_session") or "").strip()
        # Liveness is asked WITHOUT an actor on purpose. With one, a name that
        # matches short-circuits to SELF before the clock is ever read, so an
        # arrival inheriting `STATE.agent` would look live forever and a dead
        # owner's binding would freeze the project permanently. Nameless, the
        # answer is pure time: FOREIGN_STALE means the claim lapsed, and a
        # lapsed claim belongs to the existing takeover path, not to this one.
        if bound and claim_status(ticket) == "FOREIGN_LIVE":
            presented = claim_session_digest(project_lineage_identity(root), session_id)
            if presented != bound:
                owner = ticket.get("fields", {}).get("owner", "?")
                # MISSING SESSION PROOF != CURRENT OWNER. Absent and wrong are
                # reported apart because they are different mistakes: one is a
                # window that never established an identity, the other is a
                # window that established a different one.
                why = (
                    "this host session presented no identity"
                    if presented is None
                    else "this host session is not the one that claimed it"
                )
                snapshot["route"] = ENTRY_COMMAND
                return refuse(
                    "UNSEATED_MUTATION",
                    f"live Work {ticket['id']} is claimed by {owner!r} in another "
                    f"host session; {why}, so this mutation is not authorized. "
                    "Read-only inspection stays available.",
                )
    snapshot["actor"] = effective_actor
    return snapshot


def effective_strength(
    host: str,
    *,
    installed_digest: str | None = None,
    guard_callable: bool | None = None,
    probe_ok: bool | None = None,
    hook_path: Path | str | None = None,
) -> dict:
    """Separate capability from installed state (SRC-030 Part 11).

    Effective BLOCKING requires ALL of: the host supports verified blocking,
    the hook artifact is installed AND current (digest matches the shipped
    artifact when ``installed_digest`` is supplied), the guard is callable,
    and -- when a probe result is supplied -- the probe passed. Anything less
    degrades truthfully: ADVISORY while instruction-level surfaces are
    installed, ENFORCEMENT_GAP otherwise. Never aspirational.
    """
    entry = get_adapter(host)
    if entry is None:
        return {
            "host": host,
            "effective": ENFORCEMENT_STRENGTH_GAP,
            "reason": "unknown host adapter",
        }
    capability = bool(entry.get("blocking_capability"))
    declared = entry.get("declared_strength") or ENFORCEMENT_STRENGTH_GAP
    if not capability:
        reason = entry.get("gap_reason") or "host has no verified before-tool blocking surface"
        return {"host": host, "effective": declared, "reason": reason}
    hook_installed = False
    hook_current = False
    if entry.get("hook_install_surface"):
        candidate = (
            Path(hook_path) if hook_path else Path(entry["hook_install_surface"]).expanduser()
        )
        hook_installed = candidate.is_file()
        if hook_installed:
            try:
                import hashlib

                if installed_digest is None:
                    artifact = _REGISTRY_PATH.parents[2] / entry["hook_artifact"]
                    installed_digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
                raw = candidate.read_bytes()
                hook_current = hashlib.sha256(raw).hexdigest() == installed_digest
                if hook_current and entry.get("hook_installer"):
                    from install_host_guard import install

                    observed = install(
                        host, candidate.parents[2], _REGISTRY_PATH.parents[2], check=True
                    )
                    hook_current = observed["current"]
            except (OSError, KeyError, TypeError, ValueError):
                return {
                    "host": host, "capability": capability, "installed": True,
                    "current": None, "health": None, "effective": "UNKNOWN",
                    "reason": "installed hook or shipped artifact is unobservable",
                }
    else:
        # Capability is real (e.g. Claude PreToolUse) but this adapter ships no
        # hook artifact; declared instruction-level strength is the ceiling.
        return {
            "host": host,
            "effective": declared,
            "reason": "host supports blocking hooks but no SAIPEN hook artifact ships for it",
        }
    if not hook_installed:
        return {
            "host": host,
            "effective": ENFORCEMENT_STRENGTH_GAP,
            "reason": "blocking-capable host but the SAIPEN hook is not installed",
        }
    if not hook_current:
        return {
            "host": host,
            "effective": ENFORCEMENT_STRENGTH_GAP,
            "reason": "installed hook digest does not match the shipped adapter artifact",
        }
    if guard_callable is False:
        return {
            "host": host,
            "effective": ENFORCEMENT_STRENGTH_GAP,
            "reason": "installed hook cannot reach the saipen guard",
        }
    if probe_ok is False:
        return {
            "host": host,
            "effective": ENFORCEMENT_STRENGTH_GAP,
            "reason": "integration health probe failed",
        }
    if guard_callable is not True or probe_ok is not True:
        return {
            "host": host, "capability": capability, "installed": True,
            "current": True, "health": None, "effective": "UNKNOWN",
            "reason": "current hook exists but guard reachability or host health is unobserved",
        }
    return {
        "host": host,
        "capability": capability,
        "installed": True,
        "current": True,
        "health": True,
        "effective": ENFORCEMENT_STRENGTH_BLOCKING,
        "reason": "capability + installed + current + guard callable + successful host probe",
    }


#: Per-process memo of project-root resolutions. `resolve_project_root` may
#: consult git subprocesses; a guard loop evaluating many calls in one process
#: must not pay that twice for the same start. Keyed by (start, explicit).
_RESOLVE_CACHE: dict[tuple[str, str], object] = {}


def _resolve_cached(project_root_or_start, explicit_root):
    start_key = str(Path(project_root_or_start).resolve()) if project_root_or_start else ""
    explicit_key = str(explicit_root) if explicit_root is not None else ""
    key = (start_key, explicit_key)
    if key not in _RESOLVE_CACHE:
        _RESOLVE_CACHE[key] = resolve_project_root(project_root_or_start, explicit_root)
    return _RESOLVE_CACHE[key]


def evaluate_admission(
    project_root_or_start: Path | str | None = None,
    target_path: Path | str | None = None,
    action: str = "write",
    agent: str | None = None,
    explicit_root: Path | str | None = None,
    target_paths: "list[str] | tuple[str, ...] | None" = None,
    targets_unresolved: bool = False,
    shell_protected_namespace: bool = False,
    shell_namespace_targets: "list[str] | None" = None,
    shell_effects: "list[dict] | None" = None,
    shell_effects_unresolved: str | None = None,
    session_id: str | None = None,
) -> dict:
    """Evaluate admission for a proposed tool call or file modification.

    ``target_paths`` carries the FULL target set of one proposed effect (a
    multi-file patch, both endpoints of a move). ``targets_unresolved`` marks
    a consequential mutation whose target set could not be trusted.
    ``shell_effects`` are the destructive filesystem effects a shell command
    was resolved to (`guard_events.destructive_shell_effects`): each is judged
    exactly as the file-tool effect it is, so one effect gets one answer
    whichever surface proposed it. ``shell_effects_unresolved`` names a
    destructive shell effect whose operands could not be resolved.
    Performance budget: evaluates in < 5ms on a warm project.
    Returns a structured admission decision. The guard is read-only.
    """
    t0 = time.perf_counter()

    def result(**fields: object) -> dict:
        if fields.get("code") == "PROTECTED_CANONICAL_NAMESPACE":
            # T-1385: attached where the verdict is built, not at each site.
            # Hand-placed per site, the hard-link refusal was missed and
            # stayed routeless while its five siblings were routed.
            fields.setdefault("canonical_next_command", CANONICAL_NAMESPACE_ROUTE)
        fields["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 3)
        return fields

    action_name = normalize_action(action)
    effect = ACTION_EFFECT[action_name]
    targets = _target_list(target_path, target_paths)

    root_res = _resolve_cached(project_root_or_start, explicit_root)
    if not root_res.ok:
        code = getattr(root_res, "code", "NOT_SAIPEN_PROJECT") or "NOT_SAIPEN_PROJECT"
        if code == "NOT_SAIPEN_PROJECT":
            # No .saipen/ and no claimed binding: no protocol jurisdiction,
            # the guard must not interfere (SRC-030 Part 4, matrix #13).
            return result(
                ok=True,
                code="NOT_SAIPEN_PROJECT",
                admitted=True,
                applicable=False,
                project_root=None,
                target=targets[0] if targets else None,
                targets=targets,
                action=action_name,
                effect=effect,
                detail=f"not a SAIPEN project; guard non-interfering: {root_res.reason}",
            )
        # A binding was asserted (explicit root or host carrier) and failed to
        # verify: fail closed.
        return result(
            ok=False,
            code=code,
            admitted=False,
            target=targets[0] if targets else None,
            targets=targets,
            action=action_name,
            effect=effect,
            detail=root_res.reason,
        )

    root = Path(root_res.root).resolve()

    if (
        action_name == "shell"
        and shell_protected_namespace
        and not _ordinary_namespace_targets(root, shell_namespace_targets)
    ):
        return result(
            ok=False,
            code="PROTECTED_CANONICAL_NAMESPACE",
            admitted=False,
            project_root=str(root),
            target=".saipen",
            targets=targets,
            action=action_name,
            effect=effect,
            protected=True,
            provenance=root_res.provenance,
            detail=(
                "ordinary shell command explicitly references the .saipen namespace; "
                "preflight refuses the whole command before host execution"
            ),
        )

    if action_name == "shell" and shell_effects_unresolved:
        # T-1354: a destructive command whose operands cannot be resolved is
        # not proven safe by the absence of the literal text `.saipen`.
        return result(
            ok=False,
            code=CODE_TARGET_UNRESOLVED,
            admitted=False,
            project_root=str(root),
            target=None,
            targets=targets,
            action=action_name,
            effect=effect,
            surface="shell",
            provenance=root_res.provenance,
            detail=(
                f"destructive shell effect cannot be resolved ({shell_effects_unresolved}); "
                "refused before host execution"
            ),
        )
    for shell_effect in shell_effects or ():
        # The SAME decision the file tools get for the same effect: a shell
        # `rm -rf .` and a native delete of `.` answer one question.
        verdict = evaluate_admission(
            project_root_or_start,
            target_paths=list(shell_effect.get("targets") or []),
            action=str(shell_effect.get("action") or "unknown"),
            agent=agent,
            explicit_root=explicit_root,
        )
        if not verdict.get("admitted"):
            refused = {key: value for key, value in verdict.items() if key != "duration_ms"}
            refused.update(
                action=action_name,
                effect=effect,
                surface="shell",
                shell_effect={
                    "action": shell_effect.get("action"),
                    "verb": shell_effect.get("verb"),
                    "targets": list(shell_effect.get("targets") or []),
                },
            )
            return result(**refused)

    if targets_unresolved and effect == "mutating":
        # A consequential mutation that cannot name its targets is not an
        # ordinary healthy mutation (T-1317 P0-6): fail closed.
        return result(
            ok=False,
            code=CODE_TARGET_UNRESOLVED,
            admitted=False,
            project_root=str(root),
            target=None,
            targets=[],
            action=action_name,
            effect=effect,
            provenance=root_res.provenance,
            detail=(
                "consequential mutation declares no trustworthy target set; "
                "refused, never treated as an ordinary healthy mutation"
            ),
        )

    # EVERY target is canonicalized and classified; a refusal on any one of
    # them refuses the whole host tool before execution.
    resolved: list[tuple[str, str]] = []
    for candidate in targets:
        classification, canonical, _detail = canonicalize_target(root, candidate)
        resolved.append((classification, canonical))
        if classification == "protected":
            if effect == "read":
                continue
            return result(
                ok=False,
                code="PROTECTED_CANONICAL_NAMESPACE",
                admitted=False,
                project_root=str(root),
                target=canonical,
                targets=[canon for _cls, canon in resolved],
                action=action_name,
                effect=effect,
                protected=True,
                provenance=root_res.provenance,
                detail=(
                    f"direct mutation of protected canonical path '{canonical}' is "
                    "forbidden; mutations must go through canonical saipen commands"
                ),
            )
        if (
            classification == "inside"
            and action_name in _CONTAINMENT_ACTIONS
            and contains_protected_canonical_path(canonical)
        ):
            # T-1354: containment, not membership. The project root and the
            # `.saipen` directory name no protected document, yet deleting or
            # moving either removes all of them at once -- admitted as an
            # ordinary in-root mutation until this check existed.
            return result(
                ok=False,
                code="PROTECTED_CANONICAL_NAMESPACE",
                admitted=False,
                project_root=str(root),
                target=canonical,
                targets=[canon for _cls, canon in resolved],
                action=action_name,
                effect=effect,
                protected=True,
                provenance=root_res.provenance,
                detail=(
                    f"'{canonical}' contains the protected canonical namespace; a "
                    f"{action_name} of it would mutate protected state without naming it"
                ),
            )
        if classification == "outside" and action_name in _SUBTREE_ACTIONS:
            containment = _outside_subtree_namespace(root, canonical)
            if containment:
                return result(
                    ok=False,
                    code="PROTECTED_CANONICAL_NAMESPACE",
                    admitted=False,
                    project_root=str(root),
                    target=canonical,
                    targets=[canon for _cls, canon in resolved],
                    action=action_name,
                    effect=effect,
                    protected=True,
                    outside_root=True,
                    provenance=root_res.provenance,
                    detail=(
                        f"{action_name} of '{canonical}' refused: {containment}; a directory "
                        "that holds a SAIPEN project is that project's lifecycle"
                    ),
                )
        if classification == "outside" and effect != "read":
            # T-1351: namespace before jurisdiction, and PER TARGET.
            #
            # Jurisdiction-by-root is right for ordinary files outside the
            # root -- a session working in one repository may legitimately
            # edit a sibling. It is not right for another SAIPEN project's
            # canonical state, which is that project's LIFECYCLE and is
            # admitted by its own root, never by this session's jurisdiction.
            # The shell surface already refused those paths by shape, so a
            # file tool admitting them meant one question had two answers and
            # the agent picked the surface.
            #
            # The check lives in this loop rather than in the all-outside
            # branch below because a multi-file effect refuses on ANY target:
            # batching the foreign canonical path beside an ordinary in-root
            # file would otherwise skip that branch entirely and be admitted.
            foreign_relative = foreign_protected_canonical(canonical)
            if foreign_relative:
                return result(
                    ok=False,
                    code="PROTECTED_CANONICAL_NAMESPACE",
                    admitted=False,
                    project_root=str(root),
                    target=canonical,
                    targets=[canon for _cls, canon in resolved],
                    action=action_name,
                    effect=effect,
                    protected=True,
                    outside_root=True,
                    foreign_project=True,
                    foreign_target=foreign_relative,
                    provenance=root_res.provenance,
                    detail=(
                        "target is another SAIPEN project's protected canonical state "
                        f"('{foreign_relative}'); that project's lifecycle is admitted "
                        "by its own root, never by this session's jurisdiction"
                    ),
                )
        if classification == "escape":
            if effect == "read":
                continue
            # A traversal-shaped MUTATION that leaves the root is the bypass
            # shape itself: never admit it as ordinary.
            return result(
                ok=False,
                code="PATH_ESCAPES_PROJECT",
                admitted=False,
                project_root=str(root),
                target=canonical,
                targets=[canon for _cls, canon in resolved],
                action=action_name,
                effect=effect,
                outside_root=True,
                provenance=root_res.provenance,
                detail=(
                    f"mutating traversal '{candidate}' escapes the project root; "
                    "refused, never interpreted as an ordinary project-relative target"
                ),
            )
        if classification == "unresolved":
            if effect == "read":
                continue
            # T-1354: a spelling that may be this project and cannot be proven
            # either way is not "outside". Admitting it as external mutation
            # was the bypass; refusing it is the only answer that cannot be
            # wrong about protected state.
            return result(
                ok=False,
                code=CODE_TARGET_UNRESOLVED,
                admitted=False,
                project_root=str(root),
                target=canonical,
                targets=[canon for _cls, canon in resolved],
                action=action_name,
                effect=effect,
                provenance=root_res.provenance,
                detail=f"{_detail}; a consequential effect on it is refused",
            )
        if action_name in _CONTENT_ACTIONS and classification in ("inside", "outside"):
            linked = _hard_link_alias(
                root, root / canonical if classification == "inside" else Path(canonical)
            )
            if linked:
                return result(
                    ok=False,
                    code=(
                        "PROTECTED_CANONICAL_NAMESPACE"
                        if linked[0] == "protected"
                        else CODE_TARGET_UNRESOLVED
                    ),
                    admitted=False,
                    project_root=str(root),
                    target=canonical,
                    targets=[canon for _cls, canon in resolved],
                    action=action_name,
                    effect=effect,
                    protected=linked[0] == "protected",
                    provenance=root_res.provenance,
                    detail=linked[1],
                )

    canonical_targets = [canonical for _cls, canonical in resolved]

    if effect == "read":
        if any(cls == "protected" for cls, _c in resolved):
            return result(
                ok=True,
                code="ADMITTED_READ_ONLY",
                admitted=True,
                applicable=True,
                project_root=str(root),
                target=canonical_targets[0],
                targets=canonical_targets,
                action=action_name,
                effect=effect,
                protected=True,
                provenance=root_res.provenance,
                project_lineage=root_res.lineage,
                detail="read of protected canonical state is diagnostic access, permitted",
            )
        if targets and all(cls in ("outside", "escape", "unresolved") for cls, _c in resolved):
            return result(
                ok=True,
                code="ADMITTED_EXTERNAL",
                admitted=True,
                applicable=True,
                project_root=str(root),
                target=canonical_targets[0],
                targets=canonical_targets,
                action=action_name,
                effect=effect,
                outside_root=True,
                provenance=root_res.provenance,
                project_lineage=root_res.lineage,
                detail="read outside the project root; protocol non-interfering",
            )
        return result(
            ok=True,
            code="ADMITTED",
            admitted=True,
            applicable=True,
            project_root=str(root),
            target=canonical_targets[0] if canonical_targets else None,
            targets=canonical_targets,
            action=action_name,
            effect=effect,
            provenance=root_res.provenance,
            project_lineage=root_res.lineage,
            detail="read-only diagnostic access",
        )

    if targets and all(cls == "outside" for cls, _c in resolved):
        # T-1351 handled the foreign-canonical case per target in the
        # classification loop above, so everything reaching here is an ordinary
        # file that belongs to NO SAIPEN project.
        #
        # T-1354: it is admitted whoever is asking. The invariant this branch
        # once carried -- "a bound project identity cannot authorize mutation
        # outside its root" -- is about ANOTHER PROJECT'S lifecycle, and that
        # is now refused on every surface and under every provenance, which is
        # strictly stronger than the provenance test that used to stand here.
        # What was left behind was friction, not protection: a bound OpenCode
        # session could not write its own scratch file under V:/_TEMP_ while a
        # shell command wrote the identical path freely -- one question, two
        # answers, measured on the installed runtime. Refuse the minimum unsafe
        # operation: a directory that is no project has no lifecycle to protect.
        return result(
            ok=True,
            code="ADMITTED_EXTERNAL",
            admitted=True,
            applicable=True,
            project_root=str(root),
            target=canonical_targets[0],
            targets=canonical_targets,
            action=action_name,
            effect=effect,
            outside_root=True,
            provenance=root_res.provenance,
            project_lineage=root_res.lineage,
            detail="mutation outside the project root; protocol jurisdiction ends at the root",
        )

    # T-1317 Target A: an UNCLASSIFIED consequential effect (action `unknown`)
    # never reaches ADMITTED merely because the protocol state is healthy. A
    # reviewed host translation must classify the effect first; without one
    # the guard cannot establish that the mutation target/effect is safe, so
    # it fails closed with the existing closed Result vocabulary
    # (TARGET_UNRESOLVED). Non-interference (NOT_SAIPEN_PROJECT), canonical
    # standalone saipen recovery operations, diagnostic reads and effects
    # wholly outside the project root are decided before this line.
    #
    # An empty target set fails closed here too: an unknown tool that names no
    # target at all has exactly no trustworthy target evidence.
    if action_name == "unknown" and (
        not targets or all(cls != "outside" for cls, _c in resolved)
    ):
        return result(
            ok=False,
            code=CODE_TARGET_UNRESOLVED,
            admitted=False,
            project_root=str(root),
            target=targets[0] if targets else None,
            targets=canonical_targets,
            action=action_name,
            effect=effect,
            provenance=root_res.provenance,
            detail=(
                "unclassified consequential host tool: no reviewed translation "
                "establishes its effect; refused rather than admitted because the "
                "protocol state is healthy"
            ),
        )

    # The canonical protocol state must be sound first. Canonical saipen
    # operations are the repair path and stay admissible under debt.
    snapshot = protocol_snapshot(
        root, actor=agent, proposed_targets=canonical_targets, session_id=session_id
    )
    if snapshot["block"] is not None and action_name != "saipen_op":
        detail = snapshot["detail"]
        if action_name == "shell" and snapshot["block"] == "NO_ACTIVE_WORK":
            # T-1402: `date` was told "consequential mutation requires ... DOING
            # Work" -- true of the classification, false as a description of
            # the command. Say which rule classified it and what runs anyway.
            detail = (
                "this shell line is outside the closed read-only probe set, so it "
                f"is judged a consequential mutation, and {detail}. Read-only "
                "probes run without Work: git status/log/diff/show, ls, cat, "
                "grep, whoami, hostname, date, uname, id, ps, Get-Date, "
                "Get-Location, Get-Process, and <tool> --version"
            )
        return result(
            ok=False,
            code=snapshot["block"],
            admitted=False,
            project_root=str(root),
            target=targets[0] if targets else None,
            targets=canonical_targets,
            action=action_name,
            effect=effect,
            detail=detail,
            canonical_next_command=snapshot.get("route"),
        )

    return result(
        ok=True,
        code="ADMITTED",
        admitted=True,
        applicable=True,
        project_root=str(root),
        target=canonical_targets[0] if canonical_targets else None,
        targets=canonical_targets,
        action=action_name,
        effect=effect,
        provenance=root_res.provenance,
        detail=(
            "canonical operation admitted"
            if action_name == "saipen_op"
            else "protocol state sound"
        ),
    )
